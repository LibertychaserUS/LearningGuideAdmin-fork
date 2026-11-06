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
  /**
   * 一句话问了几件事（owner 2026-11-06「一句多问」）：每件事标的卡（key；库里没有 = null）与也算对的卡，
   * 按问的顺序。AI 标注（Sonnet 标、有分歧的由 Opus 复核），只有开发集的多问题有。
   */
  asks?: { faq: string | null; acceptable?: string[] }[];
};

/** 一句多问里的一件事（节点 id）：标的卡（这一版没有 = null）、也算对的卡与通向它们的入口卡。 */
export type EvalAsk = {
  faqId: string | null;
  acceptable: string[];
  entryIds: string[];
};

/** followup = B5 追问：屏幕上开着父卡时问子卡的题（开发集的原句，见 planFollowups）。 */
export const EVAL_SETS = ['blind', 's650', 'regression', 'followup'] as const;
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
  /** 标的卡这一版相对上线版本新增或改过（追问：子卡、父卡或它们之间的边改过）。 */
  changed: boolean;
  /** 追问：屏幕上开着的父卡（节点 id 与 key）与之前的学员原文；单问 = null。 */
  screen: { nodeId: string; key: string; recentTurns: string[] } | null;
  /** 一句问了几件事（两件以上才有，按问的顺序）；其余 = null。 */
  asks: EvalAsk[] | null;
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
    // 一句多问：每件事的卡换成这一版的节点 id；这一版没有那张卡 = 库里没卡（该说没找到）
    const asks =
      item.asks && item.asks.length >= 2
        ? item.asks.map((ask): EvalAsk => {
            const main = ask.faq ? (idOfKey.get(ask.faq) ?? null) : null;
            const also = main
              ? [
                  ...new Set(
                    (ask.acceptable ?? [])
                      .map((key) => idOfKey.get(key))
                      .filter(
                        (id): id is string => id !== undefined && id !== main,
                      ),
                  ),
                ]
              : [];
            const ids = main ? [main, ...also] : [];
            return {
              faqId: main,
              acceptable: also,
              entryIds: entriesFor(ids),
            };
          })
        : null;
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
      screen: null,
      asks,
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
      screen: null,
      asks: null,
    });
  }
  const max = input.questionsMax ?? Infinity;
  return {
    questions: questions.slice(0, max),
    skipped: skipped + Math.max(0, questions.length - max),
    leaked,
  };
}

/**
 * 这一版相对上线版本动过的卡（节点 id）：新增、字段改过、问法增删过，或删了（删了的卡也会让候选里有它的题变）。
 * 发布前的估计（estimate.ts）和追问选父卡都用它。
 */
export function touchedNodes(
  previous: FaqReleaseSnapshot,
  snapshot: FaqReleaseSnapshot,
): Set<string> {
  const diff = diffSnapshots(previous, snapshot);
  const touched = new Set(
    [...diff.nodes.added, ...diff.nodes.changed, ...diff.nodes.removed].map(
      (node) => node.id,
    ),
  );
  const phrasingsOf = (s: FaqReleaseSnapshot) => {
    const out = new Map<string, string[]>();
    for (const p of s.phrasings)
      out.set(p.faqId, [...(out.get(p.faqId) ?? []), `${p.locale}\n${p.text}`]);
    return new Map(
      [...out].map(([id, texts]) => [id, JSON.stringify(texts.sort())]),
    );
  };
  const before = phrasingsOf(previous);
  for (const [id, texts] of phrasingsOf(snapshot))
    if (before.get(id) !== texts) touched.add(id);
  for (const id of before.keys())
    if (!snapshot.phrasings.some((p) => p.faqId === id)) touched.add(id);
  return touched;
}

/**
 * 追问要重问的父卡（B5，doc「改了边或父卡时，只跑受影响的边」）：父卡自己、它的任何一个子卡新增或改过
 *（字段或问法），或它下面的边加了、删了、改了。没有上线版本可比 → null（全部父卡都问）。
 * 父卡下的子卡全部排在候选最前（HelpdeskQaSearch.nodeId），所以兄弟卡的变化也会影响追问选卡。
 */
export function followupParents(
  previous: FaqReleaseSnapshot | null | undefined,
  snapshot: FaqReleaseSnapshot,
): Set<string> | null {
  if (!previous) return null;
  const diff = diffSnapshots(previous, snapshot);
  const touched = touchedNodes(previous, snapshot);
  const parents = new Set<string>();
  for (const edge of snapshot.edges)
    if (touched.has(edge.parentId) || touched.has(edge.childId))
      parents.add(edge.parentId);
  for (const edge of [...diff.edges.added, ...diff.edges.removed])
    parents.add(edge.parentId);
  for (const change of diff.edges.changed) parents.add(change.after.parentId);
  return parents;
}

/**
 * B5 追问题：开发集里标的卡（或也算对的卡）是某张卡的子卡的题，屏幕上开着那张父卡再问一遍——和 Portal
 * 一样带 context.nodeId 与之前的学员原文（父卡在学员那种语言的问题）。期望出标的卡；父卡已在屏幕上、
 * 不算入口（entryIds 空），再出别的卡就是错卡。一张子卡有几张父卡时，它的题按 id 轮流分给各父卡，
 * 每条边都考到。只问 parents 里的父卡（followupParents；null = 全部）。题的原句是开发集的独立写法，
 * 不是卡自己的问法；测试集从不进来。
 */
export function planFollowups(input: {
  items: readonly ReleaseEvalItem[];
  snapshot: FaqReleaseSnapshot;
  parents: ReadonlySet<string> | null;
  changed: ReadonlySet<string>;
}): EvalQuestion[] {
  const byId = new Map(input.snapshot.nodes.map((n) => [n.id, n]));
  const idOfKey = new Map(input.snapshot.nodes.map((n) => [n.key, n.id]));
  const changedIds = new Set(
    [...input.changed]
      .map((key) => idOfKey.get(key))
      .filter((id): id is string => id !== undefined),
  );
  const parentsOf = new Map<string, string[]>();
  for (const e of input.snapshot.edges)
    parentsOf.set(e.childId, [...(parentsOf.get(e.childId) ?? []), e.parentId]);
  for (const list of parentsOf.values()) list.sort();
  const turns = new Map<string, number>();
  const seen = new Set<string>();
  const out: EvalQuestion[] = [];
  for (const item of [...input.items].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    if (item.expect !== 'answer' || !item.faq) continue;
    const main = idOfKey.get(item.faq);
    if (!main) continue;
    const parents = parentsOf.get(main) ?? [];
    if (parents.length === 0) continue;
    const turn = turns.get(main) ?? 0;
    turns.set(main, turn + 1);
    const parentId = parents[turn % parents.length];
    const parent = byId.get(parentId);
    if (!parent) continue;
    if (input.parents && !input.parents.has(parentId)) continue;
    const text = item.message.trim();
    const dedupe = `${parentId}\n${text}`;
    if (text === '' || seen.has(dedupe)) continue;
    seen.add(dedupe);
    const also = (item.acceptable ?? [])
      .map((key) => idOfKey.get(key))
      .filter((id): id is string => id !== undefined && id !== main);
    const locale = serviceLocale(item.locale);
    const said = locale === 'en-GB' ? parent.questionEn : parent.questionZh;
    out.push({
      id: `followup:${item.id}`,
      set: 'followup',
      language: item.locale,
      style: item.style ?? null,
      locale,
      message: item.message,
      expect: 'answer',
      faqId: main,
      acceptable: [...new Set(also)].filter((id) => id !== parentId),
      entryIds: [],
      changed:
        changedIds.has(main) ||
        changedIds.has(parentId) ||
        (input.parents?.has(parentId) ?? false),
      screen: {
        nodeId: parentId,
        key: parent.key,
        recentTurns: said.trim() === '' ? [] : [said],
      },
      asks: null,
    });
  }
  return out;
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
    ...(got.more ? { more: got.more } : {}),
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

/** 一句多问一题的逐件判分（候选版本出的卡：第一张加 more，按出现顺序）。 */
export type AskScore = {
  /** 库里有卡的事。 */
  asks: number;
  /** 其中出了它的卡（标的卡、也算对的卡或通向它的入口卡）的。 */
  covered: number;
  /** 库里没卡的事。 */
  noCard: number;
  /** 回复说了「还有几件没现成答案」的件数（不超过没出卡的件数）。 */
  missedSaid: number;
  /** 出了的卡里哪件事都不对应的张数（多给的错卡）。 */
  stray: number;
  /** 出了卡的事是不是按问的顺序出（出了卡的事不到两件 = null）。 */
  inOrder: boolean | null;
};

export function scoreAsks(
  one: EvalQuestion,
  got: ReleaseEvalAnswer,
): AskScore | null {
  if (!one.asks) return null;
  const shown =
    got.kind === 'answer' && got.nodeId
      ? [got.nodeId, ...(got.more ?? [])]
      : [];
  const allowed = one.asks.map((ask) =>
    ask.faqId ? [ask.faqId, ...ask.acceptable, ...ask.entryIds] : [],
  );
  const at = allowed.map((ids) => shown.findIndex((c) => ids.includes(c)));
  const whole = [one.faqId, ...one.acceptable, ...one.entryIds];
  const hits = at.filter((position) => position >= 0);
  const covered = hits.length;
  return {
    asks: one.asks.filter((ask) => ask.faqId !== null).length,
    covered,
    noCard: one.asks.filter((ask) => ask.faqId === null).length,
    missedSaid: Math.min(got.missed ?? 0, one.asks.length - covered),
    stray: shown.filter(
      (c) => !whole.includes(c) && !allowed.some((ids) => ids.includes(c)),
    ).length,
    // 同一张卡答了两件事（位置相同）也算按顺序
    inOrder:
      hits.length >= 2
        ? hits.every((position, i) => i === 0 || position >= hits[i - 1])
        : null,
  };
}
