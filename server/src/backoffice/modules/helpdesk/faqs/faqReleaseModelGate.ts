import type { ReleaseAnswerer } from '../../../../contracts/helpdesk-release-eval';
import type {
  FaqRegressionCase,
  FaqReleaseEvalReport,
  FaqReleaseGate,
  FaqReleaseGateInput,
} from './faqReleaseGate';
import type { FaqVectorTextRow } from './faqVectors';
import {
  newTextCollisions,
  type CollisionReport,
} from './release-check/collisions';
import { judgeRelease } from './release-check/policy';
import { estimateCheck } from './release-check/estimate';
import {
  changedKeys,
  followupParents,
  loadReleaseEvalItems,
  planFollowups,
  planQuestions,
  touchedNodes,
  type ReleaseEvalItem,
} from './release-check/questions';
import {
  candidatePool,
  missesOf,
  releaseCheckMetrics,
  releaseCheckReceipt,
  releaseCheckSummary,
  type ModelEvalMiss,
} from './release-check/report';
import { runReleaseQuestions } from './release-check/runner';

/**
 * 发布前的真流程检查（release check v2，owner 2026-11-06 批准；v1 是 2026-11-03 的 300 道抽样）：
 * 免费的检索检查只看检索的前 8 名，不看用户真正看到什么；这里把开发集的全部题与回归题按线上聊天的整条流程
 *（关键词 + 向量召回、精排、小模型选卡作答，契约 helpdesk-release-eval.ts）在候选版本与上线版本上各问一遍；
 * 另加追问题（B5）：屏幕上开着父卡时问子卡的题，只问这一版动过的父卡（父卡、子卡或边改了）；
 * 再顺手查一遍重复问法（collisions.ts：新加的文字和别的卡几乎一样，免费，只提醒）。
 * 四块各管一件事（release-check/）：
 * - questions.ts：问哪些题、每题怎么判（判分规则只有一份：contracts/helpdesk-eval-scoring.ts）；
 * - runner.ts：并发问两个版本、新出的错复问确认、漂移抽查、花费与预算；
 * - policy.ts：按套件与切片判定（错卡率 95% 区间上界 ≤ 2%、逐题不比线上差、库里没卡别给卡……）；
 * - report.ts：界面与对账读的报告。
 * 不改就不花钱：分层缓存（contracts/helpdesk-eval-cache.ts）记住每层的结果，只有输入变了的题才真问。
 */
export const MODEL_GATE = {
  wrongRateMax: 0.02,
  cardWhenNoneMax: 0.03,
  errorRateMax: 0.05,
  /** 语言 / 写法切片至少这么多道才拦。 */
  sliceMin: 200,
  /** 新出的错：不用缓存再问几次，几次（含第一次）都错才算真的变差；至多复问几道。 */
  reaskTimes: 2,
  reaskConfirm: 2,
  reaskMax: 60,
  /** 漂移抽查：每次不读缓存重问几道，变了超过几道就不算数。 */
  driftSample: 40,
  driftMax: 2,
  /** 一次检查的花费上限（美元；缓存是空的那一次最贵，之后只付改过的题）。 */
  budgetUsd: 3,
  concurrency: 8,
  missesMax: 50,
  /** 每答完这么多个就报一次进度（也是心跳）。 */
  progressEvery: 10,
  /** 题的安全上限。 */
  questionsMax: 5000,
  /** 重复问法：新加的文字和别的卡上的文字余弦至少这么高就列出来（只提醒）；至多列几对。 */
  collisionMin: 0.95,
  collisionsMax: 30,
} as const;

/** 可以按次改的限额（测试、以后的环境变量）。 */
export type ModelGateLimits = { [K in keyof typeof MODEL_GATE]: number };

export type ModelReleaseGateDeps = {
  answerer: ReleaseAnswerer;
  items?: () => ReleaseEvalItem[];
  regressionCases?: () => Promise<FaqRegressionCase[]>;
  /** 先把这一版的向量算好（线上检索的向量那一路要用；幂等）。上线版本也会调一次。 */
  prepare?: (version: number) => Promise<unknown>;
  /** 这一版每条文字的向量（重复问法检查用，release-check/collisions.ts）；不给或 null = 不查。 */
  vectors?: (version: number) => Promise<FaqVectorTextRow[] | null>;
  now?: () => Date;
  limits?: Partial<ModelGateLimits>;
};

const previousModelWrongRate = (report: unknown): number | null => {
  if (typeof report !== 'object' || report === null) return null;
  const parts = (report as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  const model = parts.find(
    (part) =>
      typeof part === 'object' &&
      part !== null &&
      (part as { kind?: unknown }).kind === 'model',
  ) as { metrics?: Record<string, unknown> } | undefined;
  const value = model?.metrics?.wrongRate;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

export function createModelReleaseGate(
  deps: ModelReleaseGateDeps,
): FaqReleaseGate {
  const now = deps.now ?? (() => new Date());
  const limits: ModelGateLimits = { ...MODEL_GATE, ...deps.limits };
  let items: ReleaseEvalItem[] | null = null;
  const loadItems = () =>
    (items ??= (deps.items ?? (() => loadReleaseEvalItems()))());
  /** 这一版要问的全部题：单问（开发集 + 回归）与追问（只问动过的父卡）。 */
  async function plan(
    input: Pick<FaqReleaseGateInput, 'snapshot' | 'previous'>,
  ) {
    const regression = deps.regressionCases
      ? await deps.regressionCases().catch(() => [])
      : [];
    const changed = changedKeys(input.previous?.snapshot, input.snapshot);
    const single = planQuestions({
      items: loadItems(),
      snapshot: input.snapshot,
      changed,
      regression,
      questionsMax: limits.questionsMax,
    });
    const followups = planFollowups({
      items: loadItems(),
      snapshot: input.snapshot,
      parents: followupParents(input.previous?.snapshot, input.snapshot),
      changed,
    }).slice(0, Math.max(0, limits.questionsMax - single.questions.length));
    return {
      questions: [...single.questions, ...followups],
      skipped: single.skipped,
      leaked: single.leaked,
    };
  }
  return {
    async estimate(input) {
      if (!deps.answerer.available()) return null;
      const { questions } = await plan(input);
      return estimateCheck({
        questions,
        touched: input.previous?.snapshot
          ? touchedNodes(input.previous.snapshot, input.snapshot)
          : new Set(),
        liveReport: input.previous?.evalReport ?? null,
        driftSample: limits.driftSample,
        budgetUsd: limits.budgetUsd,
      });
    },
    async evaluate(input: FaqReleaseGateInput): Promise<FaqReleaseEvalReport> {
      const report = (
        passed: boolean,
        summary: string,
        metrics: Record<string, number> = {},
        misses: ModelEvalMiss[] = [],
        extra: Pick<
          FaqReleaseEvalReport,
          'suites' | 'receipt' | 'collisions' | 'candidatePool'
        > = {},
      ): FaqReleaseEvalReport => ({
        kind: 'model',
        passed,
        summary,
        ranAt: now().toISOString(),
        metrics,
        // 报告里的 misses 与检索的同一个字段：这里是问题原文、期望与实际
        misses: misses as unknown as FaqReleaseEvalReport['misses'],
        ...extra,
      });
      if (!deps.answerer.available())
        return report(
          false,
          'The live-pipeline check could not run: no model API key (OPENROUTER_API_KEY) on this server',
        );
      const { questions, skipped, leaked } = await plan(input);
      if (questions.length === 0)
        return report(
          false,
          'The live-pipeline check has no questions for this library (no labelled card is in this release)',
          { cases: 0, skippedCases: skipped, regressionLeaked: leaked },
        );
      // 上线版本：逐题对比（没有上线版本、或旧版本行没有快照 = 不比）
      const live =
        input.previous?.snapshot && input.previous.version !== input.version
          ? input.previous
          : null;
      if (deps.prepare) {
        if (
          (await input.progress?.({ stage: 'vectors', done: 0, total: 1 })) ===
          false
        )
          return report(false, 'The check was replaced by a newer one');
        await deps.prepare(input.version);
        if (live) await deps.prepare(live.version);
      }
      // 重复问法（免费，只提醒）：查不了（没有向量、没有上线版本）就不写
      const liveSnapshot = live?.snapshot ?? null;
      const collisions: CollisionReport | null =
        deps.vectors && liveSnapshot
          ? await deps
              .vectors(input.version)
              .then((rows) =>
                rows
                  ? newTextCollisions({
                      rows,
                      snapshot: input.snapshot,
                      live: liveSnapshot,
                      min: limits.collisionMin,
                      max: limits.collisionsMax,
                    })
                  : null,
              )
              .catch(() => null)
          : null;
      const run = await runReleaseQuestions({
        questions,
        candidate: deps.answerer.forRelease({
          version: input.version,
          snapshot: input.snapshot,
        }),
        live: live
          ? deps.answerer.forRelease({
              version: live.version,
              snapshot: live.snapshot,
            })
          : null,
        version: input.version,
        limits,
        signal: input.signal,
        progress: (done, total) =>
          input.progress?.({ stage: 'model', done, total }) ??
          Promise.resolve(true),
      });
      const judgement = judgeRelease(run, limits);
      const keyOf = new Map(input.snapshot.nodes.map((n) => [n.id, n.key]));
      const metrics = {
        ...releaseCheckMetrics({
          run,
          judgement,
          skipped,
          leaked,
          previousWrongRate: previousModelWrongRate(input.previous?.evalReport),
        }),
        ...(collisions
          ? {
              collisionTextsChecked: collisions.fresh,
              collisionsNew: collisions.total,
              collisionCardPairs: collisions.cardPairs,
            }
          : {}),
      };
      const misses = missesOf(
        run.results,
        keyOf,
        limits.reaskConfirm,
        limits.missesMax,
      );
      const model = deps.answerer.model();
      const extra = {
        suites: judgement.suites,
        receipt: releaseCheckReceipt({
          model,
          questions,
          liveVersion: live?.version ?? null,
          limits,
        }),
        ...(collisions ? { collisions: collisions.pairs } : {}),
        candidatePool: candidatePool(run.results),
      };
      if (run.stopped === 'replaced')
        return report(
          false,
          'The check was replaced by a newer one',
          metrics,
          misses,
          extra,
        );
      if (run.stopped === 'budget')
        return report(
          false,
          `Live-pipeline check stopped at the budget ($${limits.budgetUsd}) after ${run.results.length} of ${questions.length} questions`,
          metrics,
          misses,
          extra,
        );
      return report(
        judgement.passed,
        releaseCheckSummary({
          passed: judgement.passed,
          model,
          judgement,
          run,
          collisions: collisions?.total ?? 0,
        }),
        metrics,
        misses,
        extra,
      );
    },
  };
}

// 旧的导出名（评测脚本与测试在用）
export {
  caseExpectation,
  changedKeys,
  entryAncestors,
  loadReleaseEvalItems,
  planQuestions,
  scoreModelAnswer,
  type EvalQuestion,
  type EvalQuestion as ModelEvalCase,
  type ModelEvalScore,
  type ReleaseEvalItem,
} from './release-check/questions';
export type { ModelEvalMiss } from './release-check/report';
export type { FaqTextCollision } from './release-check/collisions';
