import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  ASSIST_CANDIDATES,
  HelpdeskSuggestService,
} from '../../src/ai/helpdesk/helpdesk-suggest.service';
import type { HelpdeskSuggestionLog } from '../../src/ai/helpdesk/helpdesk-suggestion.store';
import { createMemoryAgentEventLog } from '../../src/ai/helpdesk/trace/agent-event.store';
import { ASSIST_SEARCH } from '../../src/ai/helpdesk/workflow/assist-workflow';
import type { AgentStepRunner } from '../../src/ai/helpdesk/workflow/engine';
import {
  SMALLTALK_INTENTS,
  UNSOLVED_HANDOVER_STREAK,
  sameSmalltalk,
  scoreTurn,
  type TurnExpectation,
  type TurnScore,
} from '../../src/contracts/helpdesk-eval-scoring';
import {
  guardExplanation,
  guardShortText,
  learnerOf,
  ungroundedToken,
} from '../../src/ai/helpdesk/workflow/guard';
import { MemoryRateLimitStore } from '../../src/ai/rate-limit.service';
import { uuidv7 } from '../../src/common/uuidv7';
import {
  SUGGEST_CONTEXT_LIMITS,
  type GuardedField,
  type HelpdeskQaSource,
  type SuggestGuard,
  type SuggestIntent,
  type SuggestKind,
} from '../../src/contracts/helpdesk-qa';
import {
  deadlineDeps,
  EVAL_LOCALES,
  percentile,
  serviceLocale,
  thinkingLabel,
  type EvalLocale,
  type EvalModel,
  type RetrievalResult,
} from './harness';
import {
  fromGeneratorFormat,
  isGeneratorFormat,
  type ReleasedLibrary,
} from './v5-sets';

/**
 * v5 对话评测（helpdesk-v5-context-chips-and-smalltalk Part F）：每条用例是一段对话（3–8 轮），每一轮标着
 * 期望的结果——answer（faqId，可另给 acceptableFaqIds；choice 卡片也是 answer）、clarify（faqId + covered）、
 * smalltalk（intent）、no_match、handover。评测像 Portal 一样跑：同一个会话 id；屏幕上的卡片（context.nodeId）
 * = 最近一次出的卡片或点的追问 / 选项；recentTurns = 之前最多 3 句学员原文；点追问 / 选项（click）只换卡片，
 * 不调 Admin（graph design §4：点击只由代码处理）；学员明说要人工（v4 的关键词，Portal 代码判）也不调 Admin。
 *
 * 文件格式（JSONL，一行一段对话；--conversations 给一个文件或一个目录，目录里的 *.jsonl 全读）：
 *   {"id":"mt-0001","set":"multi_turn"|"casual"|"single","locale":"zh-CN"|"zh-TW"|"en-GB","language":"mixed"?,
 *    "persona":"user","flow":"clarify_clause"?,"note":"…"?,
 *    "turns":[{"message":"…","expect":{"kind":"answer","faqId":"<uuid>"}},
 *             {"message":"没看懂","expect":{"kind":"clarify","faqId":"<uuid>","covered":true}},
 *             {"click":"<uuid>"},
 *             {"message":"谢谢","expect":{"kind":"smalltalk","intent":"farewell"}},
 *             {"message":"转人工","expect":{"kind":"handover"}}]}
 * 一轮可以不标 expect（只推进对话，例如第 8 问的回访卡由 Portal 判）。
 *
 * 报告：逐轮准确率（按期望的 kind 拆）、答错 FAQ 的比例、寒暄意图准确率、clarify 接地率、守卫逃逸
 * （展示出去的短句没过守卫——应当永远是 0）、守卫回退率，按 set / locale / 语言 / persona / flow 切片。
 * 闸门（Part F，真模型）：0 逃逸、clarify 接地 100%、答错 ≤ 2%、寒暄意图 ≥ 95%。语气与摘录覆盖由另一个
 * LLM 评审单独打分（不在这里）。假模型（没有 key）的数字只说明评测能跑。
 */

/** single：S650 单句集（每张卡 4 条首句 + 反例，2026-10-30）。 */
export const CONVERSATION_SETS = ['multi_turn', 'casual', 'single'] as const;
export type ConversationSet = (typeof CONVERSATION_SETS)[number];

export const EXPECTED_KINDS = [
  'answer',
  'clarify',
  'smalltalk',
  'no_match',
  'handover',
] as const;
export type ExpectedKind = (typeof EXPECTED_KINDS)[number];

/** Portal v4：连续两轮没解决 → 给转人工卡。寒暄不计（Part B §3）。 */
export { UNSOLVED_HANDOVER_STREAK };
export type { TurnExpectation };

export type ConversationTurn =
  { message: string; expect?: TurnExpectation } | { click: string };

export type EvalConversation = {
  id: string;
  set: ConversationSet;
  locale: EvalLocale;
  /** 中英混写的对话。 */
  language?: 'mixed';
  persona: string;
  /** 对话的走法（clarify_clause、not_covered、topic_switch、thanks_end …），只用于切片。 */
  flow?: string;
  note?: string;
  turns: ConversationTurn[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const filled = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

function validExpectation(raw: unknown): raw is TurnExpectation {
  if (typeof raw !== 'object' || raw === null) return false;
  const e = raw as Record<string, unknown>;
  switch (e.kind) {
    case 'answer':
      return (
        typeof e.faqId === 'string' &&
        UUID.test(e.faqId) &&
        [e.acceptableFaqIds, e.entryIds].every(
          (ids) =>
            ids === undefined ||
            (Array.isArray(ids) &&
              ids.every((id) => typeof id === 'string' && UUID.test(id))),
        )
      );
    case 'clarify':
      return (
        typeof e.faqId === 'string' &&
        UUID.test(e.faqId) &&
        typeof e.covered === 'boolean'
      );
    case 'smalltalk':
      return (
        e.intent === undefined ||
        (SMALLTALK_INTENTS as readonly unknown[]).includes(e.intent)
      );
    case 'no_match':
    case 'handover':
      return true;
    default:
      return false;
  }
}

function validTurn(raw: unknown): raw is ConversationTurn {
  if (typeof raw !== 'object' || raw === null) return false;
  const t = raw as Record<string, unknown>;
  if ('click' in t)
    return (
      typeof t.click === 'string' && UUID.test(t.click) && !('message' in t)
    );
  return (
    filled(t.message) && (t.expect === undefined || validExpectation(t.expect))
  );
}

function parseConversations(
  path: string,
  library?: ReleasedLibrary,
): EvalConversation[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line, index) => ({ line: line.trim(), at: index + 1 }))
    .filter(({ line }) => line !== '')
    .map(({ line, at }) => {
      let value: EvalConversation;
      try {
        value = JSON.parse(line) as EvalConversation;
      } catch {
        throw new Error(`${path}:${at}: not JSON`);
      }
      if (isGeneratorFormat(value)) {
        if (!library)
          throw new Error(
            `${path}:${at}: FAQ keys need a released library (--pg <url> --release)`,
          );
        try {
          value = fromGeneratorFormat(value, library);
        } catch (error) {
          throw new Error(
            `${path}:${at}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const ok =
        filled(value.id) &&
        CONVERSATION_SETS.includes(value.set) &&
        EVAL_LOCALES.includes(value.locale) &&
        (value.language === undefined || value.language === 'mixed') &&
        filled(value.persona) &&
        (value.flow === undefined || filled(value.flow)) &&
        Array.isArray(value.turns) &&
        value.turns.length >= 1 &&
        value.turns.every(validTurn) &&
        // 第一轮总是学员打字（点追问之前屏幕上得先有卡片）
        'message' in value.turns[0];
      if (!ok) throw new Error(`${path}:${at}: malformed conversation`);
      return value;
    });
}

/**
 * 读一个 .jsonl 文件，或一个目录里所有的 .jsonl（按文件名）；id 必须唯一。生成器格式（按 FAQ key 标注，
 * v5-sets.ts）要给 key → id 的对照。
 */
export function loadConversations(
  path: string,
  library?: ReleasedLibrary,
): EvalConversation[] {
  const files = statSync(path).isDirectory()
    ? readdirSync(path)
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
        .map((name) => join(path, name))
    : [path];
  const all = files.flatMap((file) => parseConversations(file, library));
  if (all.length === 0) throw new Error(`${path}: no conversations`);
  const seen = new Set<string>();
  for (const c of all) {
    if (seen.has(c.id))
      throw new Error(`${path}: duplicate conversation ${c.id}`);
    seen.add(c.id);
  }
  return all;
}

/**
 * 学员明说要人工（helpdesk-v4 Part B §1）：Portal 用代码按这张词表判，不调 Admin、不问模型。
 * 这里是评测用的副本（真正的表在 Portal 的 v4 配置里）；大小写不敏感，含繁体。
 */
export const PORTAL_HANDOVER_KEYWORDS: readonly string[] = [
  '人工',
  '真人',
  '客服',
  '转人工',
  '轉人工',
  '投诉',
  '投訴',
  'human',
  'agent',
  'real person',
  'complaint',
  'speak to someone',
];

export function isHandoverRequest(message: string): boolean {
  const text = message.toLowerCase();
  return PORTAL_HANDOVER_KEYWORDS.some((word) => text.includes(word));
}

export type GotTurn = {
  /**
   * Admin 的 kind；handover = 只给转人工卡（关键词那一轮 Admin 没给答案卡）；click = 点追问 / 选项。
   */
  kind: SuggestKind | 'handover' | 'click';
  /**
   * Portal（bc0aa9d 起）：消息含转人工关键词时照样问 Admin，答案卡在前、转人工卡接在回复末尾；
   * 没有答案卡（无卡 / 寒暄 / 追问 / 选项 / 出错）就只给转人工卡（kind = handover）。
   */
  handover?: boolean;
  intent: SuggestIntent | null;
  nodeId: string | null;
  /** 一句多问时第一张以外的卡（HELPDESK_MULTI_ASK）。 */
  more?: string[];
  covered: boolean | null;
  guard: SuggestGuard | null;
  blocks: string[];
  /** 这一轮的结束原因（agent 事件 turn/end：answered、no_match、timeout、error …）；没问 Admin 为 null。 */
  reason?: string | null;
  /** 复核用（agent 事件里取）：检索给模型的候选 id（按顺序）与 pick_faq 的 confidence。 */
  candidateIds?: string[];
  confidence?: string | null;
  /** 开思考时回答出自哪一路（thinking 或不思考的后备 quick）；没有后备为 null。 */
  branch?: 'thinking' | 'quick' | null;
  /** 复核用：学员看到的模型短句（诚恳度复核要读原话）；没有的字段不写。 */
  said?: Partial<
    Record<'opening' | 'closing' | 'reply' | 'explanation', string>
  >;
};

export type TurnResult = {
  conversationId: string;
  set: ConversationSet;
  locale: EvalLocale;
  language: EvalLocale | 'mixed';
  persona: string;
  flow: string | null;
  /** 第几轮（从 1 起）。 */
  turn: number;
  message: string | null;
  expect: TurnExpectation | null;
  got: GotTurn;
  /** null：这一轮不打分（没有 expect，或是点击）。 */
  right: boolean | null;
  /** 出了一张不该出的 FAQ / choice 卡片（答错）。 */
  wrongFaq: boolean;
  /** 期望的是追问，出的是通向它的入口卡片（算对，单独数）。 */
  viaEntry: boolean;
  /** R3（用户 2026-10-30）：期望寒暄或转人工却出了卡片：不算答错卡，单独数「多给卡片」（也不算答对）。 */
  extraCard: boolean;
  /** 出了解释（covered）时它是否接地；没有解释为 null。 */
  grounded: boolean | null;
  /** 展示出去却没过守卫的字段（应当永远为空）。 */
  escapes: GuardedField[];
  unsolvedStreak: number;
  latencyMs: number;
  costUsd: number;
  /** 发出了却没有带价格回复的请求。 */
  unpricedCalls: number;
  calledAdmin: boolean;
};

export type ConversationRunOptions = {
  conversations: EvalConversation[];
  qa: HelpdeskQaSource;
  runner: AgentStepRunner;
  env: NodeJS.ProcessEnv;
  budgetUsd: number;
  paid?: boolean;
  callCeilingUsd?: number | null;
  /** 同时跑几段对话（缺省 1）。 */
  concurrency?: number;
  onConversation?: (results: TurnResult[], index: number) => void;
};

export type ConversationOutcome = {
  results: TurnResult[];
  conversationsRun: number;
  spentUsd: number;
  stopped: null | 'budget' | 'unknown_cost';
};

const noopLog: HelpdeskSuggestionLog = {
  record: () => Promise.resolve(),
  setOutcome: () =>
    Promise.resolve({ kind: 'recorded', outcome: 'helpful', changed: false }),
  purgeQueryText: () => Promise.resolve(0),
};

const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

type V5Reply = {
  suggestion: { faqId: string } | null;
  kind?: SuggestKind;
  intent?: SuggestIntent | null;
  nodeId?: string | null;
  more?: { faqId: string }[];
  covered?: boolean | null;
  guard?: SuggestGuard | null;
  blocks?: string[];
  opening?: string | null;
  closing?: string | null;
  reply?: string | null;
  explanation?: string | null;
};

/** 判分规则只有一份（发布前的检查也用它）：src/contracts/helpdesk-eval-scoring.ts。 */
export function score(
  expect: TurnExpectation,
  got: GotTurn,
  streak: number,
): TurnScore {
  return scoreTurn(expect, got, streak);
}

/** 展示出去的短句再过一遍守卫（同一套规则）：不过的就是逃逸。 */
function escapesOf(
  reply: V5Reply,
  message: string,
  locale: string,
  shownAnswer: string | null,
): GuardedField[] {
  const learner = learnerOf(message, locale);
  const out: GuardedField[] = [];
  for (const field of ['opening', 'closing', 'reply'] as const) {
    const text = reply[field];
    if (typeof text === 'string' && !guardShortText(field, text, learner).ok)
      out.push(field);
  }
  if (typeof reply.explanation === 'string') {
    const ok =
      shownAnswer !== null &&
      ungroundedToken(reply.explanation, shownAnswer) === null &&
      guardExplanation(reply.explanation, shownAnswer, learner).ok;
    if (!ok) out.push('explanation');
  }
  return out;
}

/**
 * 从这一轮的 agent 事件里取检索候选与 pick_faq 的 confidence（只用于复核），只看给出回答的那一路
 * （turn/end.branch；后备那一路的步骤带 branch quick）。
 */
export function stepDetails(
  log: { type: string; data: Record<string, unknown> }[],
): {
  candidateIds: string[];
  confidence: string | null;
  branch: 'thinking' | 'quick' | null;
} {
  const used = log.find((e) => e.type === 'turn/end')?.data.branch;
  const branch = used === 'thinking' || used === 'quick' ? used : null;
  const ends = log.filter(
    (e) =>
      e.type === 'step/end' &&
      (e.data.branch === 'quick') === (branch === 'quick'),
  );
  const retrieve = ends.find((e) => e.data.name === 'retrieve')?.data.output as
    { candidates?: { id?: unknown }[] } | undefined;
  const pick = ends.find((e) => e.data.name === 'pick_faq')?.data.args as
    { confidence?: unknown } | undefined;
  return {
    candidateIds: (retrieve?.candidates ?? [])
      .map((c) => c.id)
      .filter((id): id is string => typeof id === 'string'),
    confidence: typeof pick?.confidence === 'string' ? pick.confidence : null,
    branch,
  };
}

export async function runConversations(
  options: ConversationRunOptions,
): Promise<ConversationOutcome> {
  const events = createMemoryAgentEventLog();
  const service = new HelpdeskSuggestService({
    qa: options.qa,
    runner: options.runner,
    rateLimit: new MemoryRateLimitStore(),
    log: noopLog,
    events,
    env: () => options.env,
    ...deadlineDeps(options.env),
  });
  const results: TurnResult[] = [];
  let spentUsd = 0;
  let stopped: ConversationOutcome['stopped'] = null;
  let conversationsRun = 0;
  const done: TurnResult[][] = [];
  let next = 0;
  const runOne = async (
    index: number,
    conversation: EvalConversation,
  ): Promise<void> => {
    const locale = serviceLocale(conversation.locale);
    const sessionId = uuidv7();
    const said: string[] = [];
    const shownIds: string[] = [];
    let shown: string | null = null;
    let streak = 0;
    let rootRunId: string | null = null;
    const turns: TurnResult[] = [];
    for (const [i, turn] of conversation.turns.entries()) {
      const base = {
        conversationId: conversation.id,
        set: conversation.set,
        locale: conversation.locale,
        language: conversation.language ?? conversation.locale,
        persona: conversation.persona,
        flow: conversation.flow ?? null,
        turn: i + 1,
      };
      const none: GotTurn = {
        kind: 'click',
        intent: null,
        nodeId: null,
        covered: null,
        guard: null,
        blocks: [],
      };
      if ('click' in turn) {
        shown = turn.click;
        shownIds.push(turn.click);
        streak = 0;
        turns.push({
          ...base,
          message: null,
          expect: null,
          got: { ...none, nodeId: turn.click },
          right: null,
          wrongFaq: false,
          viaEntry: false,
          extraCard: false,
          grounded: null,
          escapes: [],
          unsolvedStreak: streak,
          latencyMs: 0,
          costUsd: 0,
          unpricedCalls: 0,
          calledAdmin: false,
        });
        continue;
      }
      const expect = turn.expect ?? null;
      const runId = uuidv7();
      rootRunId ??= runId;
      const started = performance.now();
      const reply = (await service.suggest({
        learnerId: `eval-${conversation.id}`,
        locale,
        source: 'chat',
        message: turn.message,
        runId,
        parentRunId: rootRunId === runId ? null : rootRunId,
        shownFaqIds: shownIds.slice(-20),
        context: {
          ...(shown ? { nodeId: shown } : {}),
          sessionId,
          recentTurns: said
            .slice(-SUGGEST_CONTEXT_LIMITS.recentTurnsMax)
            .map((text) =>
              [...text].slice(0, SUGGEST_CONTEXT_LIMITS.recentTurnMax).join(''),
            ),
        },
      })) as V5Reply;
      const latencyMs = performance.now() - started;
      await service.flushTraces();
      const log = await events.read(runId);
      const replies = log.filter((e) => e.type === 'assistant/message');
      const requests = log.filter((e) => e.type === 'request/context').length;
      const priced = replies.filter(
        (e) => typeof e.data.costUsd === 'number',
      ).length;
      const costUsd = replies.reduce((sum, e) => sum + num(e.data.costUsd), 0);
      const unpricedCalls = Math.max(0, requests - priced);
      const asked: GotTurn = {
        kind: reply.kind ?? (reply.suggestion ? 'answer' : 'no_match'),
        intent: reply.intent ?? null,
        nodeId: reply.nodeId ?? reply.suggestion?.faqId ?? null,
        ...(reply.more?.length
          ? { more: reply.more.map((card) => card.faqId) }
          : {}),
        covered: reply.covered ?? null,
        guard: reply.guard ?? null,
        blocks: reply.blocks ?? [],
        reason: ((): string | null => {
          const end = log.find((e) => e.type === 'turn/end')?.data.reason;
          return typeof end === 'string' ? end : null;
        })(),
        ...stepDetails(log),
        said: Object.fromEntries(
          (['opening', 'closing', 'reply', 'explanation'] as const).flatMap(
            (field) =>
              typeof reply[field] === 'string' ? [[field, reply[field]]] : [],
          ),
        ),
      };
      const got: GotTurn = !isHandoverRequest(turn.message)
        ? asked
        : asked.kind === 'answer'
          ? { ...asked, handover: true }
          : { ...asked, kind: 'handover', nodeId: null, handover: true };
      const unsolved =
        got.kind === 'no_match' ||
        (got.kind === 'clarify' && got.covered === false);
      if (unsolved) streak += 1;
      else if (got.kind !== 'smalltalk') streak = 0;
      // Admin 真正解释的那张卡（handover 的话会把 got 改成 handover，卡片 id 要从 asked 取）
      const shownAnswer =
        asked.kind === 'clarify' && asked.nodeId
          ? ((await options.qa.findPublished(asked.nodeId, locale))?.answer ??
            null)
          : null;
      const grounded =
        typeof reply.explanation === 'string'
          ? shownAnswer !== null &&
            ungroundedToken(reply.explanation, shownAnswer) === null
          : null;
      const scored = expect ? score(expect, got, streak) : null;
      turns.push({
        ...base,
        message: turn.message,
        expect,
        got,
        right: scored ? scored.right : null,
        wrongFaq: scored ? scored.wrongFaq : false,
        viaEntry: scored?.viaEntry ?? false,
        extraCard: scored?.extraCard ?? false,
        grounded,
        escapes: escapesOf(reply, turn.message, locale, shownAnswer),
        unsolvedStreak: streak,
        latencyMs,
        costUsd,
        unpricedCalls,
        calledAdmin: true,
      });
      if (got.kind === 'answer' && got.nodeId) {
        shown = got.nodeId;
        shownIds.push(got.nodeId);
      }
      said.push(turn.message);
      const ceiling = options.callCeilingUsd ?? null;
      spentUsd += costUsd + unpricedCalls * (ceiling ?? 0);
      if ((options.paid ?? true) && unpricedCalls > 0 && ceiling === null)
        stopped = 'unknown_cost';
    }
    done[index] = turns;
    conversationsRun += 1;
    options.onConversation?.(turns, index);
  };
  // 对话之间互不相干：--concurrency 条同时跑；每个 worker 开跑下一条前查预算
  const worker = async (): Promise<void> => {
    while (stopped === null && next < options.conversations.length) {
      if (spentUsd >= options.budgetUsd) {
        stopped = 'budget';
        return;
      }
      const index = next++;
      await runOne(index, options.conversations[index]);
    }
  };
  const width = Math.max(1, Math.floor(options.concurrency ?? 1));
  await Promise.all(Array.from({ length: width }, () => worker()));
  for (const turns of done) if (turns) results.push(...turns);
  return { results, conversationsRun, spentUsd, stopped };
}

/**
 * 只跑检索（--conversations --retrieval-only --release）：每个期望出卡片（answer）的轮次发一次和
 * assist 工作流 retrieve 步相同的检索；屏幕上的卡片按理想走法取这段对话里上一张期望的卡片（answer 或
 * clarify 的那张；点击就是点的那张）。不问模型。
 */
export async function conversationRetrieval(options: {
  conversations: EvalConversation[];
  qa: HelpdeskQaSource;
}): Promise<RetrievalResult[]> {
  const results: RetrievalResult[] = [];
  for (const conversation of options.conversations) {
    const locale = serviceLocale(conversation.locale);
    let shown: string | null = null;
    for (const [i, turn] of conversation.turns.entries()) {
      if ('click' in turn) {
        shown = turn.click;
        continue;
      }
      const expect = turn.expect;
      if (expect?.kind === 'answer') {
        const started = performance.now();
        const found = await options.qa.findCandidates({
          locale,
          category: null,
          text: turn.message,
          limit: ASSIST_CANDIDATES,
          ...(shown ? { nodeId: shown } : {}),
          ...ASSIST_SEARCH,
        });
        results.push({
          id: `${conversation.id}#${i + 1}`,
          locale: conversation.locale,
          persona: conversation.persona as RetrievalResult['persona'],
          role: conversation.set,
          conversationId: conversation.id,
          turn: i + 1,
          message: turn.message,
          expectedFaqId: expect.faqId,
          acceptableFaqIds: [
            ...(expect.acceptableFaqIds ?? []),
            ...(expect.entryIds ?? []),
          ],
          candidateIds: found
            .filter((c) => c.id !== shown)
            .slice(0, ASSIST_CANDIDATES)
            .map((c) => c.id),
          latencyMs: performance.now() - started,
        });
      }
      if (expect?.kind === 'answer' || expect?.kind === 'clarify')
        shown = expect.faqId;
    }
  }
  return results;
}

/* ---------------------------------- 报告 ---------------------------------- */

/** Part F 的闸门（真模型）。 */
export const CONVERSATION_GATE = {
  guardEscapesMax: 0,
  clarifyGroundedMin: 1,
  wrongFaqRateMax: 0.02,
  smalltalkIntentMin: 0.95,
} as const;

export type ConversationSlice = {
  turns: number;
  accuracy: number | null;
  wrongFaqRate: number | null;
};

export type ConversationReport = {
  generatedAt: string;
  model: EvalModel & { note: string | null };
  retrieval: 'memory' | 'postgresql';
  budget: {
    capUsd: number;
    spentUsd: number;
    stopped: ConversationOutcome['stopped'];
  };
  conversations: { total: number; run: number; allRight: number };
  metrics: {
    turns: number;
    scoredTurns: number;
    accuracy: number | null;
    byKind: Record<ExpectedKind, { turns: number; right: number }>;
    wrongFaqRate: number | null;
    smalltalkIntentAccuracy: number | null;
    clarifyGrounded: number | null;
    clarifyExplanations: number;
    guardEscapes: number;
    /** 期望追问、出的是通向它的入口卡片的轮次（算对）。 */
    answeredViaEntry: number;
    /** R3：期望寒暄或转人工却出了卡片的轮次（不计入 wrongFaqRate）与占问 Admin 的打分轮次之比。 */
    extraCards: number;
    extraCardRate: number | null;
    guardFallbackRate: number | null;
    latencyMs: { p50: number; p95: number };
    costUsd: number;
  };
  slices: Record<
    'set' | 'locale' | 'language' | 'persona' | 'flow',
    Record<string, ConversationSlice>
  >;
  failures: {
    conversationId: string;
    turn: number;
    message: string | null;
    expect: TurnExpectation | null;
    got: GotTurn;
    escapes: GuardedField[];
  }[];
  gate: { pass: boolean; reasons: string[] };
};

const round = (value: number, digits = 4) =>
  Math.round(value * 10 ** digits) / 10 ** digits;
const share = (part: number, whole: number) =>
  whole === 0 ? null : round(part / whole);

function sliceOf(results: TurnResult[]): ConversationSlice {
  const scored = results.filter((r) => r.right !== null);
  return {
    turns: results.length,
    accuracy: share(scored.filter((r) => r.right).length, scored.length),
    wrongFaqRate: share(
      results.filter((r) => r.wrongFaq).length,
      results.filter((r) => r.calledAdmin && r.right !== null).length,
    ),
  };
}

function slicesBy(
  results: TurnResult[],
  key: (r: TurnResult) => string,
): Record<string, ConversationSlice> {
  const groups = new Map<string, TurnResult[]>();
  for (const r of results) {
    const name = key(r);
    groups.set(name, [...(groups.get(name) ?? []), r]);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, group]) => [name, sliceOf(group)]),
  );
}

export function summarizeConversations(input: {
  outcome: ConversationOutcome;
  totalConversations: number;
  model: EvalModel;
  retrieval: 'memory' | 'postgresql';
  budgetUsd: number;
  now?: Date;
}): ConversationReport {
  const { results } = input.outcome;
  const scored = results.filter((r) => r.right !== null);
  const byKind = Object.fromEntries(
    EXPECTED_KINDS.map((kind) => {
      const of = scored.filter((r) => r.expect?.kind === kind);
      return [
        kind,
        { turns: of.length, right: of.filter((r) => r.right).length },
      ];
    }),
  ) as Record<ExpectedKind, { turns: number; right: number }>;
  const adminScored = scored.filter((r) => r.calledAdmin);
  const smalltalk = scored.filter(
    (r) => r.expect?.kind === 'smalltalk' && r.expect.intent !== undefined,
  );
  const explanations = results.filter((r) => r.grounded !== null);
  const guarded = results.filter((r) => r.got.guard !== null);
  const latencies = results
    .filter((r) => r.calledAdmin)
    .map((r) => r.latencyMs);
  const metrics: ConversationReport['metrics'] = {
    turns: results.length,
    scoredTurns: scored.length,
    accuracy: share(scored.filter((r) => r.right).length, scored.length),
    byKind,
    wrongFaqRate: share(
      adminScored.filter((r) => r.wrongFaq).length,
      adminScored.length,
    ),
    smalltalkIntentAccuracy: share(
      smalltalk.filter(
        (r) =>
          r.got.kind === 'smalltalk' &&
          r.expect?.kind === 'smalltalk' &&
          sameSmalltalk(r.got.intent, r.expect.intent),
      ).length,
      smalltalk.length,
    ),
    clarifyGrounded: share(
      explanations.filter((r) => r.grounded).length,
      explanations.length,
    ),
    clarifyExplanations: explanations.length,
    guardEscapes: results.reduce((sum, r) => sum + r.escapes.length, 0),
    answeredViaEntry: results.filter((r) => r.right && r.viaEntry).length,
    extraCards: adminScored.filter((r) => r.extraCard).length,
    extraCardRate: share(
      adminScored.filter((r) => r.extraCard).length,
      adminScored.length,
    ),
    guardFallbackRate: share(
      guarded.filter((r) => r.got.guard?.result === 'fallback').length,
      guarded.length,
    ),
    latencyMs: {
      p50: Math.round(percentile(latencies, 0.5)),
      p95: Math.round(percentile(latencies, 0.95)),
    },
    costUsd: round(input.outcome.spentUsd, 6),
  };
  const byConversation = new Map<string, TurnResult[]>();
  for (const r of results)
    byConversation.set(r.conversationId, [
      ...(byConversation.get(r.conversationId) ?? []),
      r,
    ]);
  const allRight = [...byConversation.values()].filter((turns) =>
    turns.every((t) => t.right !== false),
  ).length;

  const reasons: string[] = [];
  if (input.model.kind !== 'real')
    reasons.push('fake model: these numbers only show the eval runs');
  if (input.outcome.stopped)
    reasons.push(`stopped early (${input.outcome.stopped})`);
  if (input.outcome.conversationsRun < input.totalConversations)
    reasons.push(
      `ran ${input.outcome.conversationsRun} of ${input.totalConversations} conversations`,
    );
  if (metrics.guardEscapes > CONVERSATION_GATE.guardEscapesMax)
    reasons.push(`${metrics.guardEscapes} guard escapes`);
  if (
    metrics.clarifyGrounded !== null &&
    metrics.clarifyGrounded < CONVERSATION_GATE.clarifyGroundedMin
  )
    reasons.push(`clarify grounded ${metrics.clarifyGrounded} < 100%`);
  if (
    metrics.wrongFaqRate !== null &&
    metrics.wrongFaqRate > CONVERSATION_GATE.wrongFaqRateMax
  )
    reasons.push(`wrong FAQ ${metrics.wrongFaqRate} > 2%`);
  if (
    metrics.smalltalkIntentAccuracy !== null &&
    metrics.smalltalkIntentAccuracy < CONVERSATION_GATE.smalltalkIntentMin
  )
    reasons.push(`small-talk intent ${metrics.smalltalkIntentAccuracy} < 95%`);

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    model: {
      ...input.model,
      note:
        input.model.kind === 'fake'
          ? 'Fake model (no API key): it always picks the first candidate and never explains. Not a model score.'
          : null,
    },
    retrieval: input.retrieval,
    budget: {
      capUsd: input.budgetUsd,
      spentUsd: round(input.outcome.spentUsd, 6),
      stopped: input.outcome.stopped,
    },
    conversations: {
      total: input.totalConversations,
      run: input.outcome.conversationsRun,
      allRight,
    },
    metrics,
    slices: {
      set: slicesBy(results, (r) => r.set),
      locale: slicesBy(results, (r) => r.locale),
      language: slicesBy(results, (r) => r.language),
      persona: slicesBy(results, (r) => r.persona),
      flow: slicesBy(results, (r) => r.flow ?? 'none'),
    },
    failures: results
      .filter((r) => r.right === false || r.escapes.length > 0)
      .slice(0, 200)
      .map((r) => ({
        conversationId: r.conversationId,
        turn: r.turn,
        message: r.message,
        expect: r.expect,
        got: r.got,
        escapes: r.escapes,
      })),
    gate: { pass: reasons.length === 0, reasons },
  };
}

const pct = (value: number | null) =>
  value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;

export function markdownConversationReport(report: ConversationReport): string {
  const m = report.metrics;
  const lines = [
    '# Helpdesk v5 conversation eval',
    '',
    `Generated ${report.generatedAt}. Model: ${report.model.kind} ${report.model.model}${thinkingLabel(report.model)}. Retrieval: ${report.retrieval}.`,
    ...(report.model.note ? ['', `> ${report.model.note}`] : []),
    '',
    `Conversations: ${report.conversations.run} of ${report.conversations.total} run, ${report.conversations.allRight} fully right.`,
    `Budget: $${report.budget.spentUsd} of $${report.budget.capUsd}${report.budget.stopped ? ` (stopped: ${report.budget.stopped})` : ''}.`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Turn accuracy | ${pct(m.accuracy)} (${m.scoredTurns} scored of ${m.turns}) |`,
    `| Wrong FAQ | ${pct(m.wrongFaqRate)} |`,
    `| Small-talk intent | ${pct(m.smalltalkIntentAccuracy)} |`,
    `| Clarify grounded | ${pct(m.clarifyGrounded)} (${m.clarifyExplanations} explanations) |`,
    `| Guard escapes | ${m.guardEscapes} |`,
    `| Follow-up expected, its entry card shown (counted right) | ${m.answeredViaEntry} |`,
    `| Small talk or handover expected, a card shown (R3: not a wrong FAQ) | ${m.extraCards} (${pct(m.extraCardRate)}) |`,
    `| Guard fallback rate | ${pct(m.guardFallbackRate)} |`,
    `| Latency p50 / p95 | ${m.latencyMs.p50} / ${m.latencyMs.p95} ms |`,
    `| Cost | $${m.costUsd} |`,
    '',
    '## By expected kind',
    '',
    '| Kind | Turns | Right |',
    '| --- | --- | --- |',
    ...EXPECTED_KINDS.map(
      (k) => `| ${k} | ${m.byKind[k].turns} | ${m.byKind[k].right} |`,
    ),
  ];
  for (const [key, slices] of Object.entries(report.slices)) {
    lines.push(
      '',
      `## By ${key}`,
      '',
      '| Slice | Turns | Accuracy | Wrong FAQ |',
      '| --- | --- | --- | --- |',
    );
    for (const [name, s] of Object.entries(slices))
      lines.push(
        `| ${name} | ${s.turns} | ${pct(s.accuracy)} | ${pct(s.wrongFaqRate)} |`,
      );
  }
  lines.push('', `## Failures (${report.failures.length})`, '');
  for (const f of report.failures)
    lines.push(
      `- ${f.conversationId} #${f.turn}: expected ${f.expect ? JSON.stringify(f.expect) : '—'}, got ${f.got.kind}${f.got.nodeId ? ` ${f.got.nodeId}` : ''}${f.got.intent ? ` (${f.got.intent})` : ''}${f.escapes.length ? `, escapes ${f.escapes.join(', ')}` : ''}`,
    );
  lines.push(
    '',
    `Gate: ${report.gate.pass ? 'PASS' : 'FAIL'}${report.gate.reasons.length ? ` — ${report.gate.reasons.join('; ')}` : ''}`,
    '',
  );
  return lines.join('\n');
}

/** .md 写 Markdown，其余写 JSON。 */
export function writeConversationReport(
  path: string,
  report: ConversationReport,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    path.endsWith('.md')
      ? markdownConversationReport(report)
      : `${JSON.stringify(report, null, 2)}\n`,
  );
}
