import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  scoreTurn,
  type TurnExpectation,
} from '../../../../contracts/helpdesk-eval-scoring';
import type {
  ReleaseAnswerer,
  ReleaseEvalAnswer,
  ReleaseEvalLocale,
} from '../../../../contracts/helpdesk-release-eval';
import { diffSnapshots, type FaqReleaseSnapshot } from './faqRelease';
import {
  regressionLeakCheck,
  type FaqRegressionCase,
  type FaqReleaseEvalReport,
  type FaqReleaseGate,
  type FaqReleaseGateInput,
} from './faqReleaseGate';

/**
 * 发布前的真流程抽样检查（owner 2026-11-03 选「抽样跑测试集」）：免费的检索检查只看检索的前 8 名，
 * 不看用户真正看到什么；这里把一批问题按线上聊天的整条流程（关键词 + 向量召回、精排、小模型选卡作答，
 * 契约 helpdesk-release-eval.ts）在候选版本上问一遍，按标注的卡自动判分：
 *
 * 问题从哪来（每个问题只问一次，按原文去重）：
 * 1. 固定抽样：开发集 release-eval/eval-v6-dev.jsonl（2026-11-03，按 FAQ 库 v3.5 的 685 张卡重标）有两部分：
 *    - blind（盲出题，237+38 条）：出题的模型只看到用户情境和产品介绍、没见过卡片，用用户的口气写；
 *      两个模型各自独立标卡，分歧由第三个更强的模型裁定；看不出指哪张卡的（vague）不收；
 *    - s650（1,409 条）：按卡生成并复核过的单句问题（含不该出卡的），新卡补了题，答案改过的卡重核过。
 *    各自按 id 的 SHA-256 排序，取 blind 的前 sampleSize × blindShare 条（缺省 150），其余从 s650 补满 sampleSize（缺省 300）。
 *    每一版抽到的是同一批（标的卡这一版里没有的跳过），所以和上一版的错卡率可以直接比。测试集（test）不进来，只留给报告；
 *    以后用数据飞轮里真实用户的原话替换 blind；
 * 2. 这一版改了的卡：和上线版本比，新增或改过的卡在开发集里的全部问题（至多 changedMax 条）；
 * 3. 回归用例：员工从数据飞轮接受过的、脱敏过的用户原话（标着选定的卡，至多 regressionMax 条）；
 *    就是那张卡自己的问题或问法的不问（泄漏，regressionLeaked，faqReleaseGate.ts 的 regressionLeakCheck）。
 *
 * 判分（和评测脚本 conversations.ts 同一份规则：contracts/helpdesk-eval-scoring.ts）：
 * - 期望出卡：出了标注的卡、也算对的卡（acceptable），或通向它的入口卡 → 对（入口卡单独数 viaEntry）；
 *   出了别的卡 → 错卡；没出卡 → 没答上（不算错卡）；
 * - 期望不出卡（no_match）：没卡、或追问时说明没覆盖 → 对；出了任何卡 → 错卡；
 * - 期望寒暄：出了卡只记「多给卡片」，不算错卡（R3）；
 * - 没得到回答（没有 key、超时、出错）→ 单独数（error），不算错卡也不算对。
 *
 * 通过：错卡率 ≤ 2%（owner 的标准），比上一版的错卡率高不超过 1 个百分点，且没得到回答的不超过 5%
 *（否则是模型或余额出了问题，检查不算数）。花费超过 budgetUsd 就停下并判不通过。
 */

export const MODEL_GATE = {
  sampleSize: 300,
  /** 固定抽样里盲出题（blind）占的比例。 */
  blindShare: 0.5,
  changedMax: 200,
  regressionMax: 100,
  wrongRateMax: 0.02,
  wrongRiseMax: 0.01,
  errorRateMax: 0.05,
  /** 一次检查的花费上限（美元）。 */
  budgetUsd: 0.5,
  concurrency: 4,
  missesMax: 50,
  /** 每答完这么多个就报一次进度（也是心跳）。 */
  progressEvery: 10,
} as const;

/** 可以按次改的限额（测试、以后的环境变量）。 */
export type ModelGateLimits = { [K in keyof typeof MODEL_GATE]: number };

export type ReleaseEvalItem = {
  id: string;
  /** blind = 盲出题；s650 = 按卡生成。没写当 s650。 */
  set?: 'blind' | 's650';
  locale: string;
  style?: string | null;
  message: string;
  expect: 'answer' | 'no_match' | 'smalltalk';
  faq?: string;
  acceptable?: string[];
};

export type ModelEvalCase = {
  id: string;
  source: 'sample' | 'changed' | 'regression';
  locale: ReleaseEvalLocale;
  message: string;
  expect: 'answer' | 'no_match' | 'smalltalk';
  /** 期望出卡：标注的卡（节点 id）。 */
  faqId: string | null;
  /** 也算对的卡（acceptable，节点 id）。 */
  acceptable: string[];
  /** 通向标注卡的入口卡（节点 id）：出它也算对，报告里单独数（viaEntry）。 */
  entryIds: string[];
};

export type ModelEvalMiss = {
  id: string;
  source: ModelEvalCase['source'];
  locale: ReleaseEvalLocale;
  text: string;
  expected: string;
  got: string;
};

const DEFAULT_SET = join(__dirname, 'release-eval', 'eval-v6-dev.jsonl');

/** 读开发集（一行一个 JSON）。 */
export function loadReleaseEvalItems(path = DEFAULT_SET): ReleaseEvalItem[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ReleaseEvalItem);
}

const serviceLocale = (locale: string): ReleaseEvalLocale =>
  locale === 'en-GB' ? 'en-GB' : 'zh-CN';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** 每个非入口节点沿边往上，每条路上第一个入口节点（与评测脚本 entryAncestorsOf 相同）。 */
export function entryAncestors(
  snapshot: FaqReleaseSnapshot,
): Map<string, string[]> {
  const entry = new Map(snapshot.nodes.map((n) => [n.id, n.entry]));
  const parents = new Map<string, string[]>();
  for (const e of snapshot.edges)
    parents.set(e.childId, [...(parents.get(e.childId) ?? []), e.parentId]);
  const out = new Map<string, string[]>();
  for (const node of snapshot.nodes) {
    if (node.entry) continue;
    const found = new Set<string>();
    const seen = new Set<string>([node.id]);
    let level = parents.get(node.id) ?? [];
    while (level.length > 0) {
      const up: string[] = [];
      for (const id of level) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (entry.get(id)) found.add(id);
        else up.push(...(parents.get(id) ?? []));
      }
      level = up;
    }
    out.set(node.id, [...found]);
  }
  return out;
}

/** 这一版相对上线版本新增或改过的卡（key）；没有上线版本 → 空（全是新的，固定抽样已经覆盖）。 */
export function changedKeys(
  previous: FaqReleaseSnapshot | null | undefined,
  snapshot: FaqReleaseSnapshot,
): Set<string> {
  if (!previous) return new Set();
  const diff = diffSnapshots(previous, snapshot);
  return new Set(
    [...diff.nodes.added, ...diff.nodes.changed].map((node) => node.key),
  );
}

/**
 * 选这一版要问的问题。返回 skipped = 标的卡这一版里没有、所以没问的开发集条数。
 */
export function selectModelEvalCases(input: {
  items: ReleaseEvalItem[];
  snapshot: FaqReleaseSnapshot;
  changed: Set<string>;
  regression: FaqRegressionCase[];
  limits?: Partial<
    Pick<
      ModelGateLimits,
      'sampleSize' | 'blindShare' | 'changedMax' | 'regressionMax'
    >
  >;
}): { cases: ModelEvalCase[]; skipped: number; leaked: number } {
  const limits: ModelGateLimits = { ...MODEL_GATE, ...input.limits };
  const leaks = regressionLeakCheck(input.snapshot);
  const idOfKey = new Map(input.snapshot.nodes.map((n) => [n.key, n.id]));
  const nodeIds = new Set(input.snapshot.nodes.map((n) => n.id));
  const ancestors = entryAncestors(input.snapshot);
  const entriesFor = (ids: string[]) =>
    [...new Set(ids.flatMap((id) => ancestors.get(id) ?? []))].filter(
      (id) => !ids.includes(id),
    );
  let skipped = 0;
  const usable: (ReleaseEvalItem & { gold: string[] })[] = [];
  for (const item of input.items) {
    if (item.expect !== 'answer') {
      usable.push({ ...item, gold: [] });
      continue;
    }
    const gold = [item.faq, ...(item.acceptable ?? [])]
      .map((key) => (key ? idOfKey.get(key) : undefined))
      .filter((id): id is string => id !== undefined);
    const main = item.faq ? idOfKey.get(item.faq) : undefined;
    if (!main) {
      skipped += 1;
      continue;
    }
    usable.push({ ...item, gold: [main, ...gold.filter((id) => id !== main)] });
  }
  const toCase = (
    item: ReleaseEvalItem & { gold: string[] },
    source: ModelEvalCase['source'],
  ): ModelEvalCase => ({
    id: item.id,
    source,
    locale: serviceLocale(item.locale),
    message: item.message,
    expect: item.expect,
    faqId: item.gold[0] ?? null,
    acceptable: item.gold.slice(1),
    entryIds: entriesFor(item.gold),
  });
  const seen = new Set<string>();
  const cases: ModelEvalCase[] = [];
  const add = (one: ModelEvalCase) => {
    const text = one.message.trim();
    if (text === '' || seen.has(text)) return;
    seen.add(text);
    cases.push(one);
  };
  const ordered = [...usable].sort((a, b) =>
    sha(a.id) < sha(b.id) ? -1 : sha(a.id) > sha(b.id) ? 1 : 0,
  );
  const blind = ordered.filter((item) => item.set === 'blind');
  const generated = ordered.filter((item) => item.set !== 'blind');
  const blindTake = Math.min(
    blind.length,
    Math.round(limits.sampleSize * limits.blindShare),
  );
  for (const item of [
    ...blind.slice(0, blindTake),
    ...generated.slice(0, limits.sampleSize - blindTake),
  ])
    add(toCase(item, 'sample'));
  const changedIds = new Set(
    [...input.changed]
      .map((key) => idOfKey.get(key))
      .filter((id): id is string => id !== undefined),
  );
  ordered
    .filter((item) => item.gold.some((id) => changedIds.has(id)))
    .slice(0, limits.changedMax)
    .forEach((item) => add(toCase(item, 'changed')));
  // 就是卡自己的问题或问法的回归题（泄漏）不问：拿原句考它自己必然命中，单独数
  const present = input.regression.filter((one) => nodeIds.has(one.faqId));
  const fair = present.filter((one) => !leaks(one));
  const leaked = present.length - fair.length;
  fair.slice(0, limits.regressionMax).forEach((one, index) =>
    add({
      id: `regression-${index + 1}`,
      source: 'regression',
      locale: serviceLocale(one.locale),
      message: one.text,
      expect: 'answer',
      faqId: one.faqId,
      acceptable: [],
      entryIds: entriesFor([one.faqId]),
    }),
  );
  return { cases, skipped, leaked };
}

export type ModelEvalScore = {
  right: boolean;
  wrongCard: boolean;
  /** 出的是通向标注卡的入口卡（算对，单独数）。 */
  viaEntry: boolean;
  extraCard: boolean;
  error: boolean;
};

/** 开发集的一条 → 评测脚本的期望（判分规则只有一份：contracts/helpdesk-eval-scoring.ts）。 */
export function caseExpectation(one: ModelEvalCase): TurnExpectation {
  switch (one.expect) {
    case 'answer':
      return {
        kind: 'answer',
        faqId: one.faqId ?? '',
        acceptableFaqIds: one.acceptable,
        entryIds: one.entryIds,
      };
    case 'no_match':
      return { kind: 'no_match' };
    case 'smalltalk':
      return { kind: 'smalltalk' };
  }
}

/** 一个问题的判分（规则见文件头）；没得到回答单独数（error），不算错卡也不算对。 */
export function scoreModelAnswer(
  one: ModelEvalCase,
  got: ReleaseEvalAnswer,
): ModelEvalScore {
  if (got.kind === 'error')
    return {
      right: false,
      wrongCard: false,
      viaEntry: false,
      extraCard: false,
      error: true,
    };
  const scored = scoreTurn(caseExpectation(one), {
    kind: got.kind,
    intent: got.intent ?? null,
    nodeId: got.nodeId,
    covered: got.covered ?? null,
  });
  return {
    right: scored.right,
    wrongCard: scored.wrongFaq,
    viaEntry: scored.viaEntry === true,
    extraCard: scored.extraCard === true,
    error: false,
  };
}

const previousModelWrongRate = (report: unknown): number | null => {
  if (typeof report !== 'object' || report === null) return null;
  const parts = (report as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  const model = parts.find(
    (part) =>
      typeof part === 'object' &&
      part !== null &&
      (part as { kind?: unknown }).kind === 'model',
  ) as { metrics?: Record<string, unknown>; passed?: unknown } | undefined;
  const value = model?.metrics?.wrongRate;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

export type ModelReleaseGateDeps = {
  answerer: ReleaseAnswerer;
  items?: () => ReleaseEvalItem[];
  regressionCases?: () => Promise<FaqRegressionCase[]>;
  /** 先把这一版的向量算好（线上检索的向量那一路要用；幂等）。 */
  prepare?: (version: number) => Promise<unknown>;
  now?: () => Date;
  limits?: Partial<ModelGateLimits>;
};

const label = (one: ModelEvalCase, keyOf: Map<string, string>) =>
  one.expect === 'answer'
    ? (keyOf.get(one.faqId ?? '') ?? one.faqId ?? '?')
    : one.expect;

const gotLabel = (got: ReleaseEvalAnswer, keyOf: Map<string, string>) =>
  got.kind === 'answer' || got.kind === 'clarify'
    ? `${got.kind}:${keyOf.get(got.nodeId ?? '') ?? got.nodeId ?? 'none'}`
    : got.kind;

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
      ): FaqReleaseEvalReport => ({
        kind: 'model',
        passed,
        summary,
        ranAt: now().toISOString(),
        metrics,
        // 报告里的 misses 与检索的同一个字段：这里是问题原文、期望与实际
        misses: misses as unknown as FaqReleaseEvalReport['misses'],
      });
      if (!deps.answerer.available())
        return report(
          false,
          'The live-pipeline sample could not run: no model API key (OPENROUTER_API_KEY) on this server',
        );
      items ??= (deps.items ?? (() => loadReleaseEvalItems()))();
      const regression = deps.regressionCases
        ? await deps.regressionCases().catch(() => [])
        : [];
      const { cases, skipped, leaked } = selectModelEvalCases({
        items,
        snapshot: input.snapshot,
        changed: changedKeys(input.previous?.snapshot, input.snapshot),
        regression,
        limits,
      });
      if (cases.length === 0)
        return report(
          false,
          'The live-pipeline sample has no questions for this library (no labelled card is in this release)',
          { cases: 0, skippedCases: skipped },
        );
      if (deps.prepare) {
        if (
          (await input.progress?.({ stage: 'vectors', done: 0, total: 1 })) ===
          false
        )
          return report(false, 'The check was replaced by a newer one');
        await deps.prepare(input.version);
      }
      const session = deps.answerer.forRelease({
        version: input.version,
        snapshot: input.snapshot,
      });
      const keyOf = new Map(input.snapshot.nodes.map((n) => [n.id, n.key]));
      const results: {
        one: ModelEvalCase;
        got: ReleaseEvalAnswer;
        score: ModelEvalScore;
      }[] = [];
      let spent = 0;
      let stopped: null | 'budget' | 'replaced' = null;
      let next = 0;
      let done = 0;
      const worker = async () => {
        while (stopped === null && next < cases.length) {
          if (input.signal?.aborted) {
            stopped = 'replaced';
            return;
          }
          if (spent >= limits.budgetUsd) {
            stopped = 'budget';
            return;
          }
          const one = cases[next++];
          const got = await session.ask({
            message: one.message,
            locale: one.locale,
            signal: input.signal,
          });
          spent += got.costUsd;
          results.push({ one, got, score: scoreModelAnswer(one, got) });
          done += 1;
          if (done % limits.progressEvery === 0 || done === cases.length) {
            const alive = await input.progress?.({
              stage: 'model',
              done,
              total: cases.length,
            });
            if (alive === false) stopped = 'replaced';
          }
        }
      };
      await input.progress?.({ stage: 'model', done: 0, total: cases.length });
      await Promise.all(
        Array.from({ length: Math.max(1, limits.concurrency) }, () => worker()),
      );
      const count = (
        pick: (s: ModelEvalScore) => boolean,
        source?: ModelEvalCase['source'],
      ) =>
        results.filter(
          (r) => (!source || r.one.source === source) && pick(r.score),
        ).length;
      const answered = results.filter((r) => !r.score.error);
      const wrong = count((s) => s.wrongCard);
      const errors = count((s) => s.error);
      const positives = answered.filter((r) => r.one.expect === 'answer');
      const wrongRate = answered.length > 0 ? wrong / answered.length : 0;
      const errorRate = results.length > 0 ? errors / results.length : 0;
      const metrics: Record<string, number> = {
        cases: results.length,
        planned: cases.length,
        sampleCases: results.filter((r) => r.one.source === 'sample').length,
        changedCases: results.filter((r) => r.one.source === 'changed').length,
        regressionCases: results.filter((r) => r.one.source === 'regression')
          .length,
        skippedCases: skipped,
        regressionLeaked: leaked,
        wrongCards: wrong,
        wrongRate: Number(wrongRate.toFixed(4)),
        rightRate: Number(
          (positives.length > 0
            ? positives.filter((r) => r.score.right).length / positives.length
            : 0
          ).toFixed(4),
        ),
        viaEntry: count((s) => s.viaEntry),
        extraCards: count((s) => s.extraCard),
        errors,
        costUsd: Number(spent.toFixed(4)),
        unpricedCalls: results.reduce((sum, r) => sum + r.got.unpricedCalls, 0),
        regressionWrong: count((s) => s.wrongCard, 'regression'),
      };
      const before = previousModelWrongRate(input.previous?.evalReport);
      if (before !== null) metrics.previousWrongRate = before;
      const misses: ModelEvalMiss[] = results
        .filter((r) => r.score.wrongCard || r.score.error)
        .slice(0, limits.missesMax)
        .map((r) => ({
          id: r.one.id,
          source: r.one.source,
          locale: r.one.locale,
          text: r.one.message,
          expected: label(r.one, keyOf),
          got: gotLabel(r.got, keyOf),
        }));
      const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
      const model = deps.answerer.model();
      if (stopped === 'replaced')
        return report(
          false,
          'The check was replaced by a newer one',
          metrics,
          misses,
        );
      if (stopped === 'budget')
        return report(
          false,
          `Live-pipeline sample stopped at the budget ($${limits.budgetUsd}) after ${results.length} of ${cases.length} questions`,
          metrics,
          misses,
        );
      const reasons: string[] = [];
      if (errorRate > limits.errorRateMax)
        reasons.push(
          `${errors} of ${results.length} questions got no answer (model or balance problem), so the check does not count`,
        );
      if (wrongRate > limits.wrongRateMax)
        reasons.push(
          `wrong card ${pct(wrongRate)} > ${pct(limits.wrongRateMax)}`,
        );
      if (before !== null && wrongRate > before + limits.wrongRiseMax)
        reasons.push(
          `wrong card ${pct(wrongRate)} is more than ${pct(limits.wrongRiseMax)} above the live version (${pct(before)})`,
        );
      return report(
        reasons.length === 0,
        reasons.length === 0
          ? `Live-pipeline sample passed (${model}): wrong card ${pct(wrongRate)} over ${answered.length} questions, $${spent.toFixed(3)}`
          : `Live-pipeline sample failed (${model}): ${reasons.join('; ')}`,
        metrics,
        misses,
      );
    },
  };
}
