import type { ReleaseAnswerer } from '../../../../contracts/helpdesk-release-eval';
import type {
  FaqRegressionCase,
  FaqReleaseEvalReport,
  FaqReleaseGate,
  FaqReleaseGateInput,
} from './faqReleaseGate';
import { judgeRelease } from './release-check/policy';
import {
  changedKeys,
  loadReleaseEvalItems,
  planQuestions,
  type ReleaseEvalItem,
} from './release-check/questions';
import {
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
 *（关键词 + 向量召回、精排、小模型选卡作答，契约 helpdesk-release-eval.ts）在候选版本与上线版本上各问一遍。
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
} as const;

/** 可以按次改的限额（测试、以后的环境变量）。 */
export type ModelGateLimits = { [K in keyof typeof MODEL_GATE]: number };

export type ModelReleaseGateDeps = {
  answerer: ReleaseAnswerer;
  items?: () => ReleaseEvalItem[];
  regressionCases?: () => Promise<FaqRegressionCase[]>;
  /** 先把这一版的向量算好（线上检索的向量那一路要用；幂等）。上线版本也会调一次。 */
  prepare?: (version: number) => Promise<unknown>;
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
  return {
    async evaluate(input: FaqReleaseGateInput): Promise<FaqReleaseEvalReport> {
      const report = (
        passed: boolean,
        summary: string,
        metrics: Record<string, number> = {},
        misses: ModelEvalMiss[] = [],
        extra: Pick<FaqReleaseEvalReport, 'suites' | 'receipt'> = {},
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
      items ??= (deps.items ?? (() => loadReleaseEvalItems()))();
      const regression = deps.regressionCases
        ? await deps.regressionCases().catch(() => [])
        : [];
      const { questions, skipped, leaked } = planQuestions({
        items,
        snapshot: input.snapshot,
        changed: changedKeys(input.previous?.snapshot, input.snapshot),
        regression,
        questionsMax: limits.questionsMax,
      });
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
      const metrics = releaseCheckMetrics({
        run,
        judgement,
        skipped,
        leaked,
        previousWrongRate: previousModelWrongRate(input.previous?.evalReport),
      });
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
        }),
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
