import type { FaqEvalSuiteResult } from '../faqReleaseGate';
import type { QuestionResult, RunResult } from './runner';
import { rate, wilson } from './stats';

/**
 * 发布前检查的判定（release check v2，owner 2026-11-05 选 A、2026-11-06 批准）。题按「套件」分，每个套件
 * 是 gate（不过就不能发布）或 track（只看不拦，但仍受「不比线上差」约束）：
 * - combined（全部题）与 s650：错卡率 95% 置信区间上界 ≤ wrongRateMax（2%）——标准只升不降：以前是
 *   300 道抽样的点估计 ≤ 2%，现在是全部题、按区间上界；
 * - blind：track；盲出题错卡率还没到 2%，到了就改成 gate（owner 2026-11-05）；
 * - regression：员工接受过的真实用户原话；
 * - 每个语言 / 写法切片：题数 ≥ sliceMin 的按点估计 ≤ wrongRateMax 拦；
 * - 库里没卡却给卡（期望不出卡的题出了卡）≤ cardWhenNoneMax（3%；目标 0.3%，见 doc）；
 * - 不比线上差（所有套件）：和上线版本逐题比，候选版本新出的错、复问后仍错（reaskConfirm 次）→ 不通过；
 * - 检查不算数：没得到回答（不含超时）超过 errorRateMax，或漂移抽查变了超过 driftMax 道。
 * 超时 = 学员没拿到答案：不算错卡，但算没答上（答对率的分母里有它）。
 */
export type PolicyLimits = {
  wrongRateMax: number;
  cardWhenNoneMax: number;
  errorRateMax: number;
  sliceMin: number;
  driftMax: number;
  reaskConfirm: number;
};

type Slice = {
  id: string;
  label: string;
  status: 'gate' | 'track';
  rule: 'interval' | 'point' | 'paired';
  pick: (r: QuestionResult) => boolean;
};

export type Judgement = {
  passed: boolean;
  /** 检查本身不算数（没得到回答太多、缓存漂移）。 */
  invalid: boolean;
  reasons: string[];
  suites: FaqEvalSuiteResult[];
  combined: SuiteNumbers;
  /** 确认变差的题（复问后仍错）。 */
  regressed: QuestionResult[];
};

export type SuiteNumbers = {
  n: number;
  scored: number;
  wrong: number;
  wrongRate: number;
  wrongHigh: number;
  answerable: number;
  right: number;
  rightRate: number;
  viaEntry: number;
  noneExpected: number;
  cardWhenNone: number;
  cardWhenNoneRate: number;
  extraCards: number;
  timeouts: number;
  errors: number;
  newlyWrong: number;
  confirmedWorse: number;
  fixed: number;
  liveWrongRate: number | null;
};

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

export function confirmedWorse(r: QuestionResult, confirm: number): boolean {
  return r.reasked !== null && r.reasked.wrong >= confirm;
}

export function suiteNumbers(
  rows: readonly QuestionResult[],
  confirm: number,
): SuiteNumbers {
  const scored = rows.filter(
    (r) => !r.candidate.score.error && !r.candidate.score.timeout,
  );
  const wrong = scored.filter((r) => r.candidate.score.wrongCard).length;
  // 答对率：期望出卡的题里出了对的卡；超时算没答上，检查出错的不计
  const answerable = rows.filter(
    (r) => r.q.expect === 'answer' && !r.candidate.score.error,
  );
  const right = answerable.filter((r) => r.candidate.score.right).length;
  const none = scored.filter((r) => r.q.expect === 'no_match');
  const cardWhenNone = none.filter(
    (r) => r.candidate.score.cardWhenNone,
  ).length;
  const paired = rows.filter(
    (r) => r.live !== null && !r.live.score.error && !r.live.score.timeout,
  );
  const liveWrong = paired.filter((r) => r.live!.score.wrongCard).length;
  return {
    n: rows.length,
    scored: scored.length,
    wrong,
    wrongRate: rate(wrong, scored.length),
    wrongHigh: Number(wilson(wrong, scored.length).high.toFixed(4)),
    answerable: answerable.length,
    right,
    rightRate: rate(right, answerable.length),
    viaEntry: scored.filter((r) => r.candidate.score.viaEntry).length,
    noneExpected: none.length,
    cardWhenNone,
    cardWhenNoneRate: rate(cardWhenNone, none.length),
    extraCards: scored.filter((r) => r.candidate.score.extraCard).length,
    timeouts: rows.filter((r) => r.candidate.score.timeout).length,
    errors: rows.filter((r) => r.candidate.score.error).length,
    newlyWrong: rows.filter((r) => r.reasked !== null).length,
    confirmedWorse: rows.filter((r) => confirmedWorse(r, confirm)).length,
    fixed: paired.filter(
      (r) => r.live!.score.wrongCard && !r.candidate.score.wrongCard,
    ).length,
    liveWrongRate: paired.length > 0 ? rate(liveWrong, paired.length) : null,
  };
}

function slices(results: readonly QuestionResult[]): Slice[] {
  const fixed: Slice[] = [
    {
      id: 'combined',
      label: 'All questions',
      status: 'gate',
      rule: 'interval',
      pick: () => true,
    },
    {
      id: 's650',
      label: 'S650 (written per card)',
      status: 'gate',
      rule: 'interval',
      pick: (r) => r.q.set === 's650',
    },
    {
      id: 'blind',
      label: 'Blind (written without seeing cards)',
      status: 'track',
      rule: 'paired',
      pick: (r) => r.q.set === 'blind',
    },
    {
      id: 'regression',
      label: 'Regression (accepted user wording)',
      status: 'gate',
      rule: 'paired',
      pick: (r) => r.q.set === 'regression',
    },
    {
      id: 'changed',
      label: 'Questions on changed cards',
      status: 'track',
      rule: 'paired',
      pick: (r) => r.q.changed,
    },
  ];
  const languages = [...new Set(results.map((r) => r.q.language))].sort();
  const styles = [
    ...new Set(results.map((r) => r.q.style).filter((s) => s !== null)),
  ].sort();
  return [
    ...fixed,
    ...languages.map((language): Slice => ({
      id: `language:${language}`,
      label: `Language ${language}`,
      status: 'gate',
      rule: 'point',
      pick: (r) => r.q.language === language,
    })),
    ...styles.map((style): Slice => ({
      id: `style:${style}`,
      label: `Style ${style}`,
      status: 'gate',
      rule: 'point',
      pick: (r) => r.q.style === style,
    })),
  ];
}

export function judgeRelease(
  run: Pick<RunResult, 'results' | 'drift'>,
  limits: PolicyLimits,
): Judgement {
  const { results } = run;
  const reasons: string[] = [];
  const combined = suiteNumbers(results, limits.reaskConfirm);
  const suites: FaqEvalSuiteResult[] = [];
  for (const slice of slices(results)) {
    const rows = results.filter(slice.pick);
    if (rows.length === 0) continue;
    const numbers = suiteNumbers(rows, limits.reaskConfirm);
    const own: string[] = [];
    // 太小的切片只看不拦（点估计在几十道题上没有意义）
    const small = slice.rule === 'point' && numbers.scored < limits.sliceMin;
    if (slice.rule === 'interval' && numbers.wrongHigh > limits.wrongRateMax)
      own.push(
        `wrong card ${pct(numbers.wrongRate)} (95% upper ${pct(numbers.wrongHigh)}) > ${pct(limits.wrongRateMax)}`,
      );
    if (
      slice.rule === 'point' &&
      !small &&
      numbers.wrongRate > limits.wrongRateMax
    )
      own.push(
        `wrong card ${pct(numbers.wrongRate)} > ${pct(limits.wrongRateMax)} over ${numbers.scored}`,
      );
    if (numbers.confirmedWorse > 0)
      own.push(
        `${numbers.confirmedWorse} question(s) newly wrong against the live version`,
      );
    const status = small ? 'track' : slice.status;
    suites.push({
      id: slice.id,
      label: slice.label,
      status,
      passed: own.length === 0,
      n: numbers.n,
      metrics: {
        scored: numbers.scored,
        wrongCards: numbers.wrong,
        wrongRate: numbers.wrongRate,
        wrongRateHigh: numbers.wrongHigh,
        rightRate: numbers.rightRate,
        viaEntry: numbers.viaEntry,
        cardWhenNone: numbers.cardWhenNone,
        cardWhenNoneRate: numbers.cardWhenNoneRate,
        extraCards: numbers.extraCards,
        timeouts: numbers.timeouts,
        errors: numbers.errors,
        newlyWrong: numbers.newlyWrong,
        confirmedWorse: numbers.confirmedWorse,
        fixed: numbers.fixed,
        ...(numbers.liveWrongRate === null
          ? {}
          : { liveWrongRate: numbers.liveWrongRate }),
      },
      reasons: own,
    });
    // 「不比线上差」对 track 套件也拦（owner 选 A：盲测只要求不比线上差）；其余只有 gate 拦
    if (status === 'gate' && own.length > 0)
      reasons.push(`${slice.label}: ${own.join('; ')}`);
  }
  // 新出的错在任何套件都拦；全部题那一项已经列了，不重复
  if (
    combined.confirmedWorse > 0 &&
    !reasons.some((r) => r.startsWith('All questions'))
  )
    reasons.push(
      `${combined.confirmedWorse} question(s) newly wrong against the live version`,
    );
  if (combined.cardWhenNoneRate > limits.cardWhenNoneMax)
    reasons.push(
      `a card was shown for ${pct(combined.cardWhenNoneRate)} of questions the library has no card for > ${pct(limits.cardWhenNoneMax)}`,
    );
  const invalid: string[] = [];
  const errorRate = rate(combined.errors, combined.n);
  if (errorRate > limits.errorRateMax)
    invalid.push(
      `${combined.errors} of ${combined.n} questions got no answer (model or balance problem), so the check does not count`,
    );
  if (run.drift.changed > limits.driftMax)
    invalid.push(
      `${run.drift.changed} of ${run.drift.checked} cached answers changed when asked again (the cache may be stale), so the check does not count`,
    );
  return {
    passed: reasons.length === 0 && invalid.length === 0,
    invalid: invalid.length > 0,
    reasons: [...invalid, ...reasons],
    suites,
    combined,
    regressed: results.filter((r) => confirmedWorse(r, limits.reaskConfirm)),
  };
}
