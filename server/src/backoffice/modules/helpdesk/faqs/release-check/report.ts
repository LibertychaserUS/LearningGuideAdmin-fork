import { createHash } from 'node:crypto';

import { EVAL_CACHE } from '../../../../../contracts/helpdesk-eval-cache';
import type { ReleaseEvalAnswer } from '../../../../../contracts/helpdesk-release-eval';
import { confirmedWorse, type Judgement } from './policy';
import type { EvalQuestion } from './questions';
import type { QuestionResult, RunResult } from './runner';

/**
 * 发布前检查的报告（release check v2）：界面读的 metrics 键不变（cases、wrongRate、costUsd），
 * 另加套件与切片（suites）、收据（receipt：这次用了什么）与按轻重排好的问题清单（misses）：
 * 新出的错（复问后仍错）→ 其余错卡 → 超时 → 检查出错。
 */
export type ModelEvalMiss = {
  id: string;
  set: EvalQuestion['set'];
  locale: EvalQuestion['locale'];
  text: string;
  expected: string;
  got: string;
  /** 上线版本这题给的（没有上线版本 = 不写）。 */
  live?: string;
  why: 'newly_wrong' | 'wrong_card' | 'timeout' | 'error';
};

const label = (q: EvalQuestion, keyOf: Map<string, string>) =>
  q.expect === 'answer'
    ? (keyOf.get(q.faqId ?? '') ?? q.faqId ?? '?')
    : q.expect;

const gotLabel = (got: ReleaseEvalAnswer, keyOf: Map<string, string>) =>
  got.kind === 'answer' || got.kind === 'clarify'
    ? `${got.kind}:${keyOf.get(got.nodeId ?? '') ?? got.nodeId ?? 'none'}`
    : got.kind === 'error'
      ? `error:${got.failure ?? 'unknown'}`
      : got.kind;

const money = (usd: number) => Number(usd.toFixed(4));

export function missesOf(
  results: readonly QuestionResult[],
  keyOf: Map<string, string>,
  confirm: number,
  max: number,
): ModelEvalMiss[] {
  const why = (r: QuestionResult): ModelEvalMiss['why'] | null =>
    confirmedWorse(r, confirm)
      ? 'newly_wrong'
      : r.candidate.score.wrongCard
        ? 'wrong_card'
        : r.candidate.score.timeout
          ? 'timeout'
          : r.candidate.score.error
            ? 'error'
            : null;
  const order: ModelEvalMiss['why'][] = [
    'newly_wrong',
    'wrong_card',
    'timeout',
    'error',
  ];
  return results
    .map((r) => ({ r, why: why(r) }))
    .filter(
      (x): x is { r: QuestionResult; why: ModelEvalMiss['why'] } =>
        x.why !== null,
    )
    .sort((a, b) => order.indexOf(a.why) - order.indexOf(b.why))
    .slice(0, max)
    .map(({ r, why }) => ({
      id: r.q.id,
      set: r.q.set,
      locale: r.q.locale,
      text: r.q.message,
      expected: label(r.q, keyOf),
      got: gotLabel(r.candidate.got, keyOf),
      ...(r.live ? { live: gotLabel(r.live.got, keyOf) } : {}),
      why,
    }));
}

/** 题集的指纹：题号与原文变了，两次检查就不能直接比。 */
export function questionsHash(questions: readonly EvalQuestion[]): string {
  const hash = createHash('sha256');
  for (const q of questions)
    hash.update(`${q.id}\n${q.message}\n${q.faqId ?? q.expect}\n`);
  return hash.digest('hex').slice(0, 16);
}

export function releaseCheckMetrics(input: {
  run: RunResult;
  judgement: Judgement;
  skipped: number;
  leaked: number;
  previousWrongRate: number | null;
}): Record<string, number> {
  const { run, judgement } = input;
  const c = judgement.combined;
  const saved =
    run.cache.embed.savedUsd +
    run.cache.rerank.savedUsd +
    run.cache.step.savedUsd;
  return {
    cases: c.n,
    planned: run.planned,
    skippedCases: input.skipped,
    regressionLeaked: input.leaked,
    blindCases: run.results.filter((r) => r.q.set === 'blind').length,
    s650Cases: run.results.filter((r) => r.q.set === 's650').length,
    regressionCases: run.results.filter((r) => r.q.set === 'regression').length,
    changedCases: run.results.filter((r) => r.q.changed).length,
    wrongCards: c.wrong,
    wrongRate: c.wrongRate,
    wrongRateHigh: c.wrongHigh,
    rightRate: c.rightRate,
    viaEntry: c.viaEntry,
    cardWhenNone: c.cardWhenNone,
    cardWhenNoneRate: c.cardWhenNoneRate,
    extraCards: c.extraCards,
    timeouts: c.timeouts,
    errors: c.errors,
    newlyWrong: c.newlyWrong,
    confirmedWorse: c.confirmedWorse,
    fixed: c.fixed,
    ...(c.liveWrongRate === null ? {} : { liveWrongRate: c.liveWrongRate }),
    ...(input.previousWrongRate === null
      ? {}
      : { previousWrongRate: input.previousWrongRate }),
    regressionWrong: run.results.filter(
      (r) => r.q.set === 'regression' && r.candidate.score.wrongCard,
    ).length,
    costUsd: money(run.spend.total),
    costModelUsd: money(run.spend.model),
    costRerankUsd: money(run.spend.rerank),
    costEmbedUsd: money(run.spend.embed),
    costCandidateUsd: money(run.spend.candidate),
    costLiveUsd: money(run.spend.live),
    costChecksUsd: money(run.spend.checks),
    savedUsd: money(saved),
    unpricedCalls: run.unpricedCalls,
    cacheStepHits: run.cache.step.hits,
    cacheStepMisses: run.cache.step.misses,
    cacheRerankHits: run.cache.rerank.hits,
    cacheRerankMisses: run.cache.rerank.misses,
    cacheEmbedHits: run.cache.embed.hits,
    cacheEmbedMisses: run.cache.embed.misses,
    driftChecked: run.drift.checked,
    driftChanged: run.drift.changed,
  };
}

export function releaseCheckReceipt(input: {
  model: string;
  questions: readonly EvalQuestion[];
  liveVersion: number | null;
}): Record<string, string | number> {
  return {
    model: input.model,
    questions: input.questions.length,
    questionsHash: questionsHash(input.questions),
    devSet: 'eval-v6-dev',
    cacheVersion: EVAL_CACHE.version,
    cacheTtlDays: EVAL_CACHE.ttlDays,
    ...(input.liveVersion === null ? {} : { liveVersion: input.liveVersion }),
  };
}

export function releaseCheckSummary(input: {
  passed: boolean;
  model: string;
  judgement: Judgement;
  run: RunResult;
}): string {
  const c = input.judgement.combined;
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  if (!input.passed)
    return `Live-pipeline check failed (${input.model}): ${input.judgement.reasons.join('; ')}`;
  return `Live-pipeline check passed (${input.model}): wrong card ${pct(c.wrongRate)} (95% upper ${pct(c.wrongHigh)}) over ${c.scored} questions, ${c.confirmedWorse} newly wrong, $${input.run.spend.total.toFixed(3)}`;
}
