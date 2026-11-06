import { uuidv7 } from '../../common/uuidv7';
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
import { createMemoryAgentEventLog } from './trace/agent-event.store';
import type { AgentStepRunner } from './workflow/engine';

/**
 * 发布前的真流程抽样检查用的答题器（契约 helpdesk-release-eval.ts）：每个候选版本一个
 * HelpdeskSuggestService，和线上聊天同一套组装（同一个工作流、检索、精排、模型、时限），只是：
 * - 候选来源钉在这个候选版本的快照上（qaFor，app.module.ts 组装），不读上线的版本；
 * - 不写 helpdesk_suggestions、链路事件只在内存里（读完就删，只拿计价）；
 * - 每个问题一个独立的 learnerId，不受每人每小时的限流影响，也不占真实用户的额度。
 * 问题按 Portal 聊天面板的第一句发（source chat，带 v5 context），不带屏幕上的卡。
 */
export type ReleaseAnswererDeps = {
  qaFor: (version: number, snapshot: unknown) => HelpdeskQaSource;
  runner: AgentStepRunner;
  env?: () => NodeJS.ProcessEnv;
};

const noLog: HelpdeskSuggestionLog = {
  record: () => Promise.resolve(),
  setOutcome: () =>
    Promise.resolve({ kind: 'recorded', outcome: 'helpful', changed: false }),
  purgeQueryText: () => Promise.resolve(0),
};

const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

type Reply = {
  suggestion: { faqId: string } | null;
  kind?: string;
  nodeId?: string | null;
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
      const events = createMemoryAgentEventLog();
      const service = new HelpdeskSuggestService({
        qa: deps.qaFor(version, snapshot),
        runner: deps.runner,
        rateLimit: new MemoryRateLimitStore(),
        log: noLog,
        events,
        env,
      });
      return {
        async ask({ message, locale, signal }): Promise<ReleaseEvalAnswer> {
          const runId = uuidv7();
          let reply: Reply | null = null;
          try {
            reply = await service.suggest(
              {
                learnerId: `release-eval-${runId}`,
                locale,
                source: 'chat',
                message,
                runId,
                parentRunId: null,
                shownFaqIds: [],
                context: { sessionId: uuidv7() },
              },
              { signal },
            );
          } catch {
            reply = null;
          }
          await service.flushTraces();
          const log = await events.read(runId);
          events.runs.delete(runId);
          const replies = log.filter((e) => e.type === 'assistant/message');
          const requests = log.filter(
            (e) => e.type === 'request/context',
          ).length;
          const priced = replies.filter(
            (e) => typeof e.data.costUsd === 'number',
          ).length;
          const costUsd = replies.reduce(
            (sum, e) => sum + num(e.data.costUsd),
            0,
          );
          const unpricedCalls = Math.max(0, requests - priced);
          const reason = log.find((e) => e.type === 'turn/end')?.data.reason;
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
            intent: reply?.intent ?? null,
            covered: kind === 'clarify' ? (reply?.covered ?? null) : null,
            costUsd,
            unpricedCalls,
          };
        },
      };
    },
  };
}
