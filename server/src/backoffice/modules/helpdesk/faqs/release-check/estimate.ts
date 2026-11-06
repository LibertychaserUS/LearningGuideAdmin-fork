import type { EvalQuestion } from './questions';

/**
 * 开始检查之前的估计（release check v2，界面「发布新版本」按钮旁边显示）：这一版要问几道题、估计几道要真付钱、
 * 大约多少钱。不调模型，只读上线版本那次检查留下的两样东西（report.ts）：
 * - candidatePool：每张卡进过几道题的候选（模型看到的、精排之后）。改了一张卡，候选里有它的题输入就变了，
 *   缓存不中，要真问；2026-11-05 实测一张卡中位数在 37 道题的候选里（p90 65）。
 * - paidQuestionUsd：上次真问的题平均每道花多少（模型 + 精排 + 问句向量）。
 * 估计 = 候选里有改动卡的题（按卡相加，可能重复数，所以封顶为单问题数）+ 标的卡改了的题 + 追问（只问动过的父卡，
 * 都要真问）+ 漂移抽查。上线版本的答案在缓存里，不算。上次没有记录（v2 之前的检查、第一次检查）→ 只给题数和上限。
 */
export type FaqCheckEstimate = {
  questions: number;
  single: number;
  followups: number;
  /** 这一版相对上线版本动过的卡（字段、问法，或删了）。 */
  touchedCards: number;
  /** 估计要真问的题数。 */
  paid: number;
  /** 估计花费（美元）；没有上次的记录 = null。 */
  usd: number | null;
  budgetUsd: number;
  /** last_check = 按上线版本那次检查估；no_history = 没有可依据的记录。 */
  basis: 'last_check' | 'no_history';
};

type ModelPart = {
  metrics?: Record<string, unknown>;
  candidatePool?: Record<string, unknown>;
};

/** 报告（combined / model / rollback 的 sourceReport）里的真流程那一份。 */
export function modelPartOf(report: unknown): ModelPart | null {
  if (typeof report !== 'object' || report === null) return null;
  const r = report as {
    kind?: unknown;
    parts?: unknown;
    sourceReport?: unknown;
  };
  if (r.kind === 'model') return r as ModelPart;
  if (Array.isArray(r.parts)) {
    const found = r.parts.find(
      (part) =>
        typeof part === 'object' &&
        part !== null &&
        (part as { kind?: unknown }).kind === 'model',
    ) as ModelPart | undefined;
    if (found) return found;
  }
  return r.kind === 'rollback' ? modelPartOf(r.sourceReport) : null;
}

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

export function estimateCheck(input: {
  questions: readonly EvalQuestion[];
  touched: ReadonlySet<string>;
  liveReport: unknown;
  driftSample: number;
  budgetUsd: number;
}): FaqCheckEstimate {
  const single = input.questions.filter((q) => q.set !== 'followup');
  const followups = input.questions.length - single.length;
  const part = modelPartOf(input.liveReport);
  const pool = part?.candidatePool;
  const perQuestion = count(part?.metrics?.paidQuestionUsd);
  const base = {
    questions: input.questions.length,
    single: single.length,
    followups,
    touchedCards: input.touched.size,
    budgetUsd: input.budgetUsd,
  };
  if (!pool || perQuestion === 0)
    return {
      ...base,
      paid: input.questions.length,
      usd: null,
      basis: 'no_history',
    };
  let inPool = 0;
  for (const id of input.touched) inPool += count(pool[id]);
  const changed = single.filter((q) => q.changed).length;
  const paidSingle = Math.min(single.length, inPool + changed);
  // 漂移抽查每次都不读缓存重问 driftSample 道（什么都没改也问）
  const paid = Math.min(
    input.questions.length,
    paidSingle + followups + input.driftSample,
  );
  return {
    ...base,
    paid,
    usd: Number(Math.min(input.budgetUsd, paid * perQuestion).toFixed(4)),
    basis: 'last_check',
  };
}
