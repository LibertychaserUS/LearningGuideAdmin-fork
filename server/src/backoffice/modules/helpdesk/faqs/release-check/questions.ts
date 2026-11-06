import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  scoreTurn,
  type TurnExpectation,
} from '../../../../../contracts/helpdesk-eval-scoring';
import type {
  ReleaseEvalAnswer,
  ReleaseEvalLocale,
} from '../../../../../contracts/helpdesk-release-eval';
import { diffSnapshots, type FaqReleaseSnapshot } from '../faqRelease';
import { regressionLeakCheck, type FaqRegressionCase } from '../faqReleaseGate';

/**
 * 发布前检查问哪些题、每题怎么判（release check v2，owner 2026-11-06 批准）。
 *
 * 每一版都问全部的题（不再抽样）：开发集 eval-v6-dev.jsonl 的 blind（盲出题）与 s650（按卡生成），
 * 加上员工从数据飞轮接受过的回归题。标的卡这一版里没有的跳过（skipped）；回归题就是它那张卡自己的
 * 问题或问法的不问（泄漏，leaked）。同一句话只问一次。测试集（test）从不进来，只留给最终报告。
 * 花钱的部分由分层缓存兜住（contracts/helpdesk-eval-cache.ts）：输入没变的题不再付钱。
 *
 * 判分只有一份规则（contracts/helpdesk-eval-scoring.ts）；没得到回答的单独数：超时 = 学员没拿到答案
 *（算没答上），其余（没有 key、限流、出错）= 检查本身出了问题。
 */
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

export const EVAL_SETS = ['blind', 's650', 'regression'] as const;
export type EvalSet = (typeof EVAL_SETS)[number];

export type EvalQuestion = {
  id: string;
  set: EvalSet;
  /** 题目原本的语言（zh-CN、zh-TW、en-GB、mixed；切片按它分）。 */
  language: string;
  /** s650 第 4 句的写法（mixed / short / typo / colloquial_long）；没有 = null。 */
  style: string | null;
  /** 问 Agent 用的语言（zh-TW、mixed 和 Portal 一样按 zh-CN 发）。 */
  locale: ReleaseEvalLocale;
  message: string;
  expect: 'answer' | 'no_match' | 'smalltalk';
  /** 期望出卡：标注的卡（节点 id）。 */
  faqId: string | null;
  /** 也算对的卡（acceptable，节点 id）。 */
  acceptable: string[];
  /** 通向标注卡的入口卡（节点 id）：出它也算对，单独数（viaEntry）。 */
  entryIds: string[];
  /** 标的卡这一版相对上线版本新增或改过。 */
  changed: boolean;
};

const DEFAULT_SET = join(__dirname, '..', 'release-eval', 'eval-v6-dev.jsonl');

/** 读开发集（一行一个 JSON）。 */
export function loadReleaseEvalItems(path = DEFAULT_SET): ReleaseEvalItem[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ReleaseEvalItem);
}

export const serviceLocale = (locale: string): ReleaseEvalLocale =>
  locale === 'en-GB' ? 'en-GB' : 'zh-CN';

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

/** 这一版相对上线版本新增或改过的卡（key）；没有上线版本 → 空。 */
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

/** 这一版要问的全部题（按 id 排好，方便对照）。 */
export function planQuestions(input: {
  items: readonly ReleaseEvalItem[];
  snapshot: FaqReleaseSnapshot;
  changed: ReadonlySet<string>;
  regression: readonly FaqRegressionCase[];
  /** 安全上限：题再多也只问这么多（缺省不限）。 */
  questionsMax?: number;
}): { questions: EvalQuestion[]; skipped: number; leaked: number } {
  const idOfKey = new Map(input.snapshot.nodes.map((n) => [n.key, n.id]));
  const nodeIds = new Set(input.snapshot.nodes.map((n) => n.id));
  const changedIds = new Set(
    [...input.changed]
      .map((key) => idOfKey.get(key))
      .filter((id): id is string => id !== undefined),
  );
  const ancestors = entryAncestors(input.snapshot);
  const entriesFor = (ids: string[]) =>
    [...new Set(ids.flatMap((id) => ancestors.get(id) ?? []))].filter(
      (id) => !ids.includes(id),
    );
  const leaks = regressionLeakCheck(input.snapshot);
  const seen = new Set<string>();
  const questions: EvalQuestion[] = [];
  let skipped = 0;
  let leaked = 0;
  const add = (one: EvalQuestion) => {
    const text = one.message.trim();
    if (text === '' || seen.has(text)) return;
    seen.add(text);
    questions.push(one);
  };
  for (const item of [...input.items].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    let gold: string[] = [];
    if (item.expect === 'answer') {
      const main = item.faq ? idOfKey.get(item.faq) : undefined;
      if (!main) {
        skipped += 1;
        continue;
      }
      const also = (item.acceptable ?? [])
        .map((key) => idOfKey.get(key))
        .filter((id): id is string => id !== undefined && id !== main);
      gold = [main, ...new Set(also)];
    }
    add({
      id: item.id,
      set: item.set === 'blind' ? 'blind' : 's650',
      language: item.locale,
      style: item.style ?? null,
      locale: serviceLocale(item.locale),
      message: item.message,
      expect: item.expect,
      faqId: gold[0] ?? null,
      acceptable: gold.slice(1),
      entryIds: entriesFor(gold),
      changed: gold.some((id) => changedIds.has(id)),
    });
  }
  let index = 0;
  for (const one of input.regression) {
    if (!nodeIds.has(one.faqId)) {
      skipped += 1;
      continue;
    }
    // 就是卡自己的问题或问法（泄漏）：拿原句考它自己必然命中，不问，单独数
    if (leaks(one)) {
      leaked += 1;
      continue;
    }
    index += 1;
    add({
      id: `regression-${index}`,
      set: 'regression',
      language: one.locale,
      style: null,
      locale: serviceLocale(one.locale),
      message: one.text,
      expect: 'answer',
      faqId: one.faqId,
      acceptable: [],
      entryIds: entriesFor([one.faqId]),
      changed: changedIds.has(one.faqId),
    });
  }
  const max = input.questionsMax ?? Infinity;
  return {
    questions: questions.slice(0, max),
    skipped: skipped + Math.max(0, questions.length - max),
    leaked,
  };
}

/** 一题的期望（评测脚本的 TurnExpectation）。 */
export function caseExpectation(one: EvalQuestion): TurnExpectation {
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

export type ModelEvalScore = {
  right: boolean;
  wrongCard: boolean;
  /** 出的是通向标注卡的入口卡（算对，单独数）。 */
  viaEntry: boolean;
  extraCard: boolean;
  /** 期望不出卡却出了卡（错卡的一种，单独数：库里没卡时乱给卡）。 */
  cardWhenNone: boolean;
  /** 超时：学员没拿到答案（算没答上，不算错卡）。 */
  timeout: boolean;
  /** 检查本身出了问题（没有 key、限流、出错）：不计分。 */
  error: boolean;
};

/** 一题的判分（规则见文件头）。 */
export function scoreModelAnswer(
  one: EvalQuestion,
  got: ReleaseEvalAnswer,
): ModelEvalScore {
  const none = {
    right: false,
    wrongCard: false,
    viaEntry: false,
    extraCard: false,
    cardWhenNone: false,
  };
  if (got.kind === 'error')
    return got.failure === 'timeout'
      ? { ...none, timeout: true, error: false }
      : { ...none, timeout: false, error: true };
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
    cardWhenNone: one.expect === 'no_match' && scored.wrongFaq,
    timeout: false,
    error: false,
  };
}
