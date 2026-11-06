import { uuidv7 } from '../../common/uuidv7';
import {
  emptyAskStats,
  measureSpend,
  runInEvalAsk,
  type EvalCacheStore,
} from '../../contracts/helpdesk-eval-cache';
import type {
  HelpdeskQaSource,
  SuggestIntent,
} from '../../contracts/helpdesk-qa';
import type {
  ReleaseAnswerer,
  ReleaseEvalAnswer,
} from '../../contracts/helpdesk-release-eval';
import { MemoryRateLimitStore } from '../rate-limit.service';
import {
  HelpdeskSuggestService,
  suggestModel,
} from './helpdesk-suggest.service';
import type { HelpdeskSuggestionLog } from './helpdesk-suggestion.store';
import { cachedReranker } from './rerank';
import { createMemoryAgentEventLog } from './trace/agent-event.store';
import { cachedStepRunner } from './workflow/cached-step-runner';
import type { AgentStepRunner } from './workflow/engine';

/**
 * 发布前的真流程检查用的答题器（契约 helpdesk-release-eval.ts）：每个候选版本一个
 * HelpdeskSuggestService，和线上聊天同一套组装（同一个工作流、检索、精排、模型、时限），只是：
 * - 候选来源钉在这个候选版本的快照上（qaFor，app.module.ts 组装），不读上线的版本；
 * - 不写 helpdesk_suggestions、链路事件只在内存里（读完就删，只拿计价）；
 * - 每个问题一个独立的 learnerId，不受每人每小时的限流影响，也不占真实用户的额度。
 * 问题按 Portal 聊天面板发（source chat，带 v5 context）：缺省是第一句、屏幕上没有卡；追问（screen）
 * 和 Portal 一样带屏幕上的卡（context.nodeId，也算刚给学员看过的）与之前的学员原文（recentTurns）。
 *
 * 分层缓存（cache 给了时，contracts/helpdesk-eval-cache.ts）：模型步、精排、问句向量各按输入寻址，
 * 同样的输入不再付钱，命中照原耗时等，结果和真问一样。qaFor 的向量检索要自己包问句向量（cachedFaqEmbedder）。
 * 花费 = 模型（链路事件的计价）+ 精排 + 问句向量（服务商回的 usage.cost）。
 */
export type ReleaseAnswererDeps = {
  qaFor: (version: number, snapshot: unknown) => HelpdeskQaSource;
  runner: AgentStepRunner;
  env?: () => NodeJS.ProcessEnv;
  /** 分层结果缓存；不给 = 每问都真问。 */
  cache?: EvalCacheStore;
};

/** 不写 helpdesk_suggestions；只记下每一问模型看到的候选卡（读完就删）。 */
function candidateLog(): HelpdeskSuggestionLog & {
  take(runId: string): string[] | undefined;
} {
  const seen = new Map<string, string[]>();
  return {
    record: (entry) => {
      seen.set(entry.id, entry.candidateIds);
      return Promise.resolve();
    },
    setOutcome: () =>
      Promise.resolve({ kind: 'recorded', outcome: 'helpful', changed: false }),
    purgeQueryText: () => Promise.resolve(0),
    take(runId) {
      const ids = seen.get(runId);
      seen.delete(runId);
      return ids;
    },
  };
}

const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

type Reply = {
  suggestion: { faqId: string } | null;
  kind?: string;
  nodeId?: string | null;
  more?: { faqId: string }[];
  intent?: SuggestIntent | null;
  covered?: boolean | null;
};

const KINDS = ['answer', 'clarify', 'smalltalk', 'no_match'] as const;
/** turn/end 的这些原因：这一问没得到回答（不是「没有合适的卡」）。 */
const FAILED_REASONS: readonly string[] = [
  'rate_limited',
  'timeout',
  'error',
  'aborted',
  'no_key',
];

export function createReleaseAnswerer(
  deps: ReleaseAnswererDeps,
): ReleaseAnswerer {
  const env = deps.env ?? (() => process.env);
  return {
    available: () => (env().OPENROUTER_API_KEY?.trim() ?? '') !== '',
    model: () => suggestModel(env()),
    forRelease({ version, snapshot }) {
      // 每次检查开始时顺手删掉过期的缓存条目（读的时候本来就不用，这里只是腾地方）；失败不影响检查
      void deps.cache?.prune?.().catch(() => undefined);
      const events = createMemoryAgentEventLog();
      const log = candidateLog();
      const service = new HelpdeskSuggestService({
        qa: deps.qaFor(version, snapshot),
        runner: cachedStepRunner(deps.runner),
        rateLimit: new MemoryRateLimitStore(),
        log,
        events,
        env,
        wrapReranker: cachedReranker,
      });
      return {
        async ask({
          message,
          locale,
          signal,
          cache = 'use',
          screen,
        }): Promise<ReleaseEvalAnswer> {
          const runId = uuidv7();
          const stats = emptyAskStats();
          let reply: Reply | null = null;
          let spent = { embed: 0, rerank: 0 };
          try {
            const measured = await runInEvalAsk(
              { store: deps.cache ?? null, mode: cache, stats },
              () =>
                measureSpend(() =>
                  service.suggest(
                    {
                      learnerId: `release-eval-${runId}`,
                      locale,
                      source: 'chat',
                      message,
                      runId,
                      parentRunId: null,
                      shownFaqIds: screen ? [screen.nodeId] : [],
                      context: {
                        sessionId: uuidv7(),
                        ...(screen
                          ? {
                              nodeId: screen.nodeId,
                              recentTurns: [...screen.recentTurns],
                            }
                          : {}),
                      },
                    },
                    { signal },
                  ),
                ),
            );
            reply = measured.value;
            spent = measured.spent;
          } catch {
            reply = null;
          }
          await service.flushTraces();
          const trail = await events.read(runId);
          events.runs.delete(runId);
          const seen = log.take(runId);
          const replies = trail.filter((e) => e.type === 'assistant/message');
          const requests = trail.filter(
            (e) => e.type === 'request/context',
          ).length;
          const priced = replies.filter(
            (e) => typeof e.data.costUsd === 'number',
          ).length;
          const modelUsd = replies.reduce(
            (sum, e) => sum + num(e.data.costUsd),
            0,
          );
          const costUsd = modelUsd + spent.rerank + spent.embed;
          const extra = {
            spend: { model: modelUsd, ...spent },
            ...(deps.cache ? { cache: stats } : {}),
            ...(seen ? { candidates: seen } : {}),
          };
          const unpricedCalls = Math.max(0, requests - priced);
          const reason = trail.find((e) => e.type === 'turn/end')?.data.reason;
          // 没有回复、或这一轮以出错 / 超时结束（answer 以外不出卡）：算「没答上」，不算答错
          const failed =
            reply === null ||
            (typeof reason === 'string' && FAILED_REASONS.includes(reason));
          if (failed && !reply?.suggestion)
            return {
              kind: 'error',
              nodeId: null,
              costUsd,
              unpricedCalls,
              failure: typeof reason === 'string' ? reason : 'no_reply',
              ...extra,
            };
          const raw =
            reply?.kind ?? (reply?.suggestion ? 'answer' : 'no_match');
          const kind = (KINDS as readonly string[]).includes(raw)
            ? (raw as ReleaseEvalAnswer['kind'])
            : 'no_match';
          const nodeId =
            kind === 'answer' || kind === 'clarify'
              ? (reply?.nodeId ?? reply?.suggestion?.faqId ?? null)
              : null;
          return {
            kind,
            nodeId,
            ...(kind === 'answer' && reply?.more?.length
              ? { more: reply.more.map((card) => card.faqId) }
              : {}),
            intent: reply?.intent ?? null,
            covered: kind === 'clarify' ? (reply?.covered ?? null) : null,
            costUsd,
            unpricedCalls,
            ...extra,
          };
        },
      };
    },
  };
}
