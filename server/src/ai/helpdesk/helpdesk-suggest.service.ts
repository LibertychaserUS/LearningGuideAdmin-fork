import { Logger, type OnModuleDestroy } from '@nestjs/common';

import { problem } from '../../common/problem';
import { isUuid, uuidv7 } from '../../common/uuidv7';
import {
  faqCategoryFor,
  isHelpdeskLocale,
  parseSuggestContext,
  type ConfidenceLevel,
  type FaqCategory,
  type HelpdeskQaCandidate,
  type HelpdeskQaSource,
  type SuggestIntent,
  type SuggestRequestContext,
  type SuggestTurnFields,
} from '../../contracts/helpdesk-qa';
import type { TurnEndReason } from '../../contracts/helpdesk-trace';
import type { RateLimitStore } from '../rate-limit.service';
import {
  isSuggestionOutcome,
  SUGGESTION_SOURCES,
  type HelpdeskSuggestionLog,
  type SuggestionOutcome,
  type SuggestionSource,
} from './helpdesk-suggestion.store';
import type { AgentEventLog } from './trace/agent-event.store';
import { RunTrace } from './trace/run-trace';
import {
  childTraceparent,
  startTrace,
  type TraceContext,
} from './trace/traceparent';
import {
  runWorkflow,
  THINKING_LEVELS,
  type AgentStepRunner,
  type ModelTarget,
  type ThinkingSetting,
  type WorkflowDeps,
  type WorkflowTemplate,
} from './workflow/engine';
import {
  answerTurn,
  assistWorkflow,
  initialAssistState,
  NO_MATCH_TURN,
  uncoveredTurn,
  type AssistTurn,
} from './workflow/assist-workflow';
import {
  chipWorkflow,
  faqWorkflow,
  initialFaqState,
} from './workflow/faq-workflow';
import { learnerOf } from './workflow/guard';
import {
  openRouterReranker,
  rerankConfig,
  rerankedSource,
  type Reranker,
} from './rerank';
import {
  HELPDESK_DEFAULTS,
  helpdeskSwitch,
} from '../../contracts/helpdesk-defaults';
import {
  assessModelHealth,
  healthThreshold,
  MODEL_HEALTH,
} from './trace/model-health';

/**
 * Helpdesk 推荐答案（Figma addendum §C；Tickets v2 §2；helpdesk-agent-v2-pi-dsh，Agent 角色）。
 *
 * 来源 source：submit（提交工单弹窗）、chat（聊天面板提问）、chip（聊天面板点常见问题）。
 * - chip 带 faqId：chip 工作流直接返回该已发布 FAQ，不调模型、不要 API key，但照样记一行；
 * - chat / submit 走 FAQ 工作流（workflow/faq-workflow.ts，步骤由代码定）：
 * 1. 每学员每小时 submit 最多 10 次、chat + chip 合计最多 30 次（共用 ai_rate_limit_hits，
 *    两个独立的键），超出返回 null；
 * 2. retrieve：从已发布 FAQ 里取候选（全文 + 关键词 + 同类加权，前 8 个），没有候选不调模型；
 * 3. pick_faq：一个 pi Agent 步（pi-agent-core 原样），唯一的工具 pick_faq 的 faqId 只能是候选 id
 *    或 none；模型写在代码里（DEFAULT_MODEL），HELPDESK_SUGGEST_MODEL 只在要换模型时才设，
 *    key / 模型 / base URL 每次现读；3 秒 AbortSignal、不重试，且整次推荐不超过 3.5 秒
 *    （Portal 等 4 秒），过期的答案不返回、不记 faq_id；没有 API key、任何错误都返回 null
 *    （绝不阻塞学员提交工单）；v5 聊天缺省开思考（high），思考最多 6.3 秒，同时发一个不思考的后备，
 *    整次最多 8 秒（suggestLimits）；
 * 4. validate → answer：再核一遍是候选之一，返回库里的原答案，模型从不写给学员看的文字；
 * 5. 每次检索写一行 helpdesk_suggestions；query_text 90 天后清空（本实例每小时最多清一次）；
 * 6. 链路：每次推荐一个 run（id = Portal 给的 runId，否则新的 uuidv7；答中时也是 suggestion id），
 *    事件按 dsh SessionEvent 写进 helpdesk_agent_events；W3C traceparent 的 trace id 记在
 *    turn/start，发往 OpenRouter 的是它的子 span；学员反馈追加一条 feedback；
 * 7. 你可能想问（helpdesk-v3 §1，只用代码、不再问模型）：没有答案时回包带 alternatives（0–3 个
 *    { faqId, question }）：检索到的候选按检索顺序前 3 个，没有候选就取该语言的热门已发布 FAQ
 *    （工单的 FAQ 分类在前）；从不含刚给学员看过的 FAQ（chip 的 faqId 与 Portal 给的 shownFaqIds）；
 *    rate_limited 与 aborted 为 []，参数不合法照旧 400。turn/end 记下给出的 faqId。
 * 8. v5（契约 fixture v6；helpdesk-v5 Part B / D / H、graph design §4）：chat / chip 请求带 context
 *    （v5 的 Portal）时，chat 走 assist 工作流（workflow/assist-workflow.ts：寒暄、clarify 的 explain 步、
 *    choice 卡片、摘录块与开头结尾，模型写的短句全部过 workflow/guard.ts），chip 不问模型、开头结尾用模板；
 *    回包在 suggestion / alternatives 旁加 SuggestTurnFields（kind、intent、confidence、nodeId、blocks、
 *    opening、closing、reply、explanation、covered、guard、releaseVersion）。没有 context 的请求
 *    （旧的 Portal、提交工单）回包与 v5 逐字相同。kind / intent / confidence / guard / blocks 记进
 *    helpdesk_suggestions 与 turn/end；给学员看的短句只进 turn/end.output（学员原文字段，90 天清空、导出脱敏）。
 */

export const SUGGEST_TIMEOUT_MS = 3_000;
/**
 * 整次推荐（限流 + 检索 + 模型）的总期限，低于 Portal 的 ADMIN_SUGGEST_TIMEOUT_MS（4 秒）：
 * 过了期限 Portal 已放弃、直接建单，学员没看到答案，所以不再记 qa_id（不计入 shown）。
 */
export const SUGGEST_DEADLINE_MS = 3_500;
/**
 * 聊天开思考时，思考那一路最多等多久（用户 2026-10-30：截在 6.3 秒，指标不能降）。同时发一个不思考的
 * 请求做后备：思考那一路到点没走完或出错，就用后备的回答。录下的 256 次思考按此模拟：long 错卡 0.72%、
 * 答对 92.8%（不截断 0.45% / 93.0%）。
 */
export const SUGGEST_THINKING_CUTOFF_MS = 6_300;
/**
 * 聊天开思考时的总期限：后备那一路（不思考，一般 1–2 秒）最晚到这里。Portal 聊天要等得比这更久
 * （Portal 显示「思考中」）；提交工单不思考，仍是 3.5 秒。
 */
export const SUGGEST_THINKING_DEADLINE_MS = 8_000;
/**
 * 聊天的缺省思考档位：分级方案的小模型不开思考（HELPDESK_DEFAULTS；2026-10-30 DeepSeek 时是 high）。
 */
export const DEFAULT_CHAT_THINKING: ThinkingSetting =
  HELPDESK_DEFAULTS.thinking;
export const SUGGEST_CANDIDATES = 8;
/**
 * v5 assist 一次给模型看的候选数（多出的 2 个给树上近亲与深层答案，见 ASSIST_SEARCH）；HELPDESK_LOCATOR=hybrid
 * 时结构排序的前 3 张另加在最前面（faqQaSource.ts）。
 */
export const ASSIST_CANDIDATES = 10;
export const SUGGEST_RATE_LIMIT = { limit: 10, windowMs: 3_600_000 } as const;
export const QUERY_TEXT_RETENTION_DAYS = 90;
/** 你可能想问：最多几个。 */
export const SUGGEST_ALTERNATIVES = 3;
/**
 * 查热门 FAQ 的期限：期限（3.5 秒）之后才查也还在 Portal 的 4 秒之内；查不到就给 []。
 */
export const ALTERNATIVES_TIMEOUT_MS = 300;
/** 聊天面板（chat + chip）每学员每小时的额度，与 submit 分开计。 */
export const ASSIST_RATE_LIMIT = { limit: 30, windowMs: 3_600_000 } as const;
const PURGE_EVERY_MS = 3_600_000;
// 分级方案的 L3 小模型（owner 2026-11-03：缺省就是最新方案，见 contracts/helpdesk-defaults.ts）；评委仍是 Claude
const DEFAULT_MODEL = HELPDESK_DEFAULTS.model;
// OPENROUTER_BASE_URL 是 AI Tutor 已有的变量，这里同样每次现读
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

const LIMITS = {
  learnerIdMax: 128,
  subjectMax: 120,
  messageMax: 5000,
  shownFaqIdsMax: 20,
} as const;

export type Suggestion = {
  id: string;
  faqId: string;
  question: string;
  answer: string;
};

/** 你可能想问的一项（学员点了就按 chip 带 faqId 再问一次）。 */
export type Alternative = { faqId: string; question: string };

export type SuggestResult = {
  suggestion: Suggestion | null;
  /** 只在 suggestion 为 null 时可能非空（v3 §1）；旧的 Portal 不读它。 */
  alternatives: Alternative[];
} & Partial<SuggestTurnFields>;

type SuggestInput = {
  learnerId: string;
  locale: string;
  source: SuggestionSource;
  /** 原样记日志的类型（工单类型或 FAQ 分类）；没有为 null。 */
  category: string | null;
  /** 同类加权用的 FAQ 分类。 */
  faqCategory: FaqCategory | null;
  subject: string;
  message: string;
  /** 仅 chip：学员点的 FAQ（小写 uuid）。 */
  faqId: string | null;
  /** Portal 预先生成的 run id（= 它的 assist 行 id）；没给则新生成。 */
  runId: string | null;
  /** 同一段对话的第一个 run（Portal 给）。 */
  parentRunId: string | null;
  /** 这段对话里刚给学员看过的 FAQ（Portal 给，小写 uuid）：不再出现在 alternatives 里。 */
  shownFaqIds: string[];
  /**
   * v5（契约 fixture v6）：屏幕上的卡、会话 id 与最近几轮学员原文；null = 旧的 Portal（回包与 v5 逐字相同）。
   * 有 context 时回包加 SuggestTurnFields（helpdesk-qa.ts），由 v5 的工作流填。
   */
  context: SuggestRequestContext | null;
};

/**
 * 发给 Portal「思考中」面板的步骤名（只有名字，没有模型的文字）；pick_faq 对外叫 pick，
 * 不在表里的步骤（chip 的 lookup、提交表单的 validate / answer）不发。
 */
export const STREAM_STEPS = {
  retrieve: 'retrieve',
  pick_faq: 'pick',
  explain: 'explain',
  route: 'route',
  smalltalk: 'smalltalk',
  ground: 'ground',
  // 一句多问（multi-ask.ts）：对外仍是「挑卡」「组回复」，Portal 不用认新名字
  pick_asks: 'pick',
  compose: 'route',
} as const;
export type StreamStep = (typeof STREAM_STEPS)[keyof typeof STREAM_STEPS];

export type SuggestContext = {
  /** 收到的 W3C traceparent 头。 */
  traceparent?: string;
  /** 调用方放弃（Portal 断开）时中止。 */
  signal?: AbortSignal;
  /** 每开一步（见 STREAM_STEPS）就调一次。 */
  onStep?: (step: StreamStep) => void;
};

export type HelpdeskSuggestDeps = {
  qa: HelpdeskQaSource;
  /** agent 步的运行时（PiStepRunner）。 */
  runner: AgentStepRunner;
  rateLimit: RateLimitStore;
  log: HelpdeskSuggestionLog;
  /** dsh 事件日志（helpdesk_agent_events）。 */
  events: AgentEventLog;
  /** 每次调用现读（默认 process.env），便于轮换 key / 切模型。 */
  env?: () => NodeJS.ProcessEnv;
  /** 模型那一步的时限（默认见 suggestLimits）；单测缩短，评测放宽。 */
  timeoutMs?: number;
  /** 整次推荐的总期限（默认见 suggestLimits）；只有评测放宽（思考档位要看不截时限的质量与延迟）。 */
  deadlineMs?: number;
  /** 思考那一路的截断（默认见 suggestLimits）；只有评测改。 */
  cutoffMs?: number;
  /** 包一层精排（发布前检查的缓存，eval-cache；线上不给）。 */
  wrapReranker?: (inner: Reranker, model: string) => Reranker;
  now?: () => number;
};

/**
 * 模型由代码定（DEFAULT_MODEL，评测选出的那个），部署不用配；HELPDESK_SUGGEST_MODEL 只用来临时换模型。
 * 不看 AI_AVAILABLE_MODELS：那是 AI Tutor 的列表，排第一的模型不一定适合推荐。
 */
export function suggestModel(env: NodeJS.ProcessEnv): string {
  return env.HELPDESK_SUGGEST_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * 聊天的思考档位（HELPDESK_SUGGEST_THINKING：off / low / medium / high，每次现读）；没设或不认识 →
 * DEFAULT_CHAT_THINKING。基准对比见 eval/helpdesk。
 */
export function suggestThinking(env: NodeJS.ProcessEnv): ThinkingSetting {
  const value = env.HELPDESK_SUGGEST_THINKING?.trim().toLowerCase();
  return (
    THINKING_LEVELS.find((level) => level === value) ?? DEFAULT_CHAT_THINKING
  );
}

/**
 * 这一次的思考档位、总期限、模型那一步的时限，以及思考那一路的截断（有它就同时发不思考的后备）。
 * 只有 v5 聊天思考：提交工单（Portal 最多等 5 秒、绝不挡提交）与没有 context 的旧聊天不思考
 * （不带 thinking，runner 发 effort none）。
 */
export function suggestLimits(
  v5: boolean,
  env: NodeJS.ProcessEnv,
): {
  thinking?: ThinkingSetting;
  deadlineMs: number;
  stepMs: number;
  cutoffMs?: number;
} {
  const quick = { deadlineMs: SUGGEST_DEADLINE_MS, stepMs: SUGGEST_TIMEOUT_MS };
  if (!v5) return quick;
  const thinking = suggestThinking(env);
  return thinking === 'off'
    ? { thinking, ...quick }
    : {
        thinking,
        deadlineMs: SUGGEST_THINKING_DEADLINE_MS,
        stepMs: SUGGEST_THINKING_DEADLINE_MS,
        cutoffMs: SUGGEST_THINKING_CUTOFF_MS,
      };
}

/** 同一次推荐的两路（思考、后备）查的是同样的东西：每样只查一次。 */
function sharedLookups(qa: HelpdeskQaSource): HelpdeskQaSource {
  const seen = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!seen.has(key)) seen.set(key, load());
    return seen.get(key) as Promise<T>;
  };
  return {
    findCandidates: (search) =>
      once(`candidates:${JSON.stringify(search)}`, () =>
        qa.findCandidates(search),
      ),
    findPublished: (id, locale) =>
      once(`published:${id}:${locale}`, () => qa.findPublished(id, locale)),
    findPopular: (search) => qa.findPopular(search),
  };
}

/** 思考那一路正常走完（答了或确定没有）才用它；超时、出错、放弃都换后备。 */
const SETTLED: readonly TurnEndReason[] = ['answered', 'no_match'];

function invalid(detail: string) {
  return problem(400, 'invalid_request', detail);
}

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** 控制字符（保留 \t \n \r）：query_text 是 PostgreSQL TEXT，不收 U+0000。 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function optionalUuid(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (!isUuid(value)) throw invalid(`${key} must be a UUID`);
  return value.toLowerCase();
}

function optionalText(body: Record<string, unknown>, key: string, max: number) {
  const value = body[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw invalid(`${key} must be text`);
  if (CONTROL.test(value)) throw invalid(`${key} has invalid characters`);
  const trimmed = value.trim();
  if (trimmed.length > max)
    throw invalid(`${key} must be at most ${max} characters`);
  return trimmed;
}

function optionalUuids(
  body: Record<string, unknown>,
  key: string,
  max: number,
): string[] {
  const value = body[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max)
    throw invalid(`${key} must be a list of at most ${max} UUIDs`);
  if (!value.every(isUuid)) throw invalid(`${key} must be a list of UUIDs`);
  return [...new Set(value.map((id) => id.toLowerCase()))];
}

function parseInput(raw: unknown): SuggestInput {
  const body = record(raw);
  const learnerId =
    typeof body.learnerId === 'string' ? body.learnerId.trim() : '';
  if (learnerId === '' || learnerId.length > LIMITS.learnerIdMax)
    throw invalid('learnerId is required');
  if (!isHelpdeskLocale(body.locale))
    throw invalid('locale must be en-GB or zh-CN');
  // v1 的 Portal 不带 source：按 submit
  const source = body.source ?? 'submit';
  if (!(SUGGESTION_SOURCES as readonly unknown[]).includes(source))
    throw invalid('source must be submit, chat or chip');
  let category: string | null = null;
  let faqCategory: FaqCategory | null = null;
  if (body.category !== undefined && body.category !== null) {
    faqCategory = faqCategoryFor(body.category);
    if (!faqCategory) throw invalid('Unknown category');
    category = body.category as string;
  }
  const subject = optionalText(body, 'subject', LIMITS.subjectMax);
  const message = optionalText(body, 'message', LIMITS.messageMax);
  let faqId: string | null = null;
  if (source === 'chip') {
    if (!isUuid(body.faqId)) throw invalid('faqId is required for a chip');
    faqId = body.faqId.toLowerCase();
  } else if (source === 'chat') {
    if (message === '') throw invalid('message is required');
  } else if (subject === '' && message === '') {
    throw invalid('subject or message is required');
  }
  return {
    learnerId,
    locale: body.locale,
    source: source as SuggestionSource,
    category,
    faqCategory,
    subject,
    message,
    faqId,
    runId: optionalUuid(body, 'runId'),
    parentRunId: optionalUuid(body, 'parentRunId'),
    shownFaqIds: optionalUuids(body, 'shownFaqIds', LIMITS.shownFaqIdsMax),
    context: suggestContext(body.context),
  };
}

function suggestContext(raw: unknown): SuggestRequestContext | null {
  try {
    return parseSuggestContext(raw);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : 'invalid context');
  }
}

/** 跑过的检索候选（decide 中途出错时也留得住，给 alternatives 用）。 */
type Retrieved = {
  candidates: HelpdeskQaCandidate[];
  /** v5：运行时读的发布版本（与检索并行地查；记进 helpdesk_suggestions 与回包）。 */
  release: Promise<number | null>;
};

/** v5 的一轮（只在请求带 context 的 chat / chip 里有）。 */
type Assisted = {
  turn: AssistTurn;
  intent: SuggestIntent | null;
  confidence: ConfidenceLevel | null;
  /** 一句多问时拆出了几件事（只有一件事时不写）。 */
  asks?: number;
};

type Decided = {
  chosen: HelpdeskQaCandidate | null;
  reason: TurnEndReason;
  model: string | null;
  assisted?: Assisted;
  /** 开思考的聊天用了哪一路（thinking 或不思考的后备 quick）；没有后备时不给。 */
  branch?: 'thinking' | 'quick';
};

/** v5 回包：context 只对聊天面板（chat / chip）有意义；提交工单的回包不变。 */
function isV5(input: SuggestInput): boolean {
  return input.context !== null && input.source !== 'submit';
}

export class HelpdeskSuggestService implements OnModuleDestroy {
  private readonly logger = new Logger('HelpdeskSuggest');
  private lastPurge = Number.NEGATIVE_INFINITY;
  private lastHealthCheck = Number.NEGATIVE_INFINITY;
  private readonly writing = new Set<Promise<void>>();

  constructor(private readonly deps: HelpdeskSuggestDeps) {}

  private env(): NodeJS.ProcessEnv {
    return this.deps.env ? this.deps.env() : process.env;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private warn(what: string, error: unknown): void {
    this.logger.warn(
      `${what}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  /** 事件日志在后台写，不拖慢推荐；失败只记日志。 */
  private background(what: string, work: Promise<unknown>): void {
    const done = work.then(
      () => undefined,
      (error: unknown) => this.warn(what, error),
    );
    this.writing.add(done);
    void done.finally(() => this.writing.delete(done));
  }

  /** 等后台的事件写完（测试、评测与停机用）。 */
  async flushTraces(): Promise<void> {
    while (this.writing.size > 0) await Promise.all([...this.writing]);
  }

  /** 停机（main.ts 开了 enableShutdownHooks，SIGTERM 时 Nest 调这里）：先写完缓冲的事件。 */
  onModuleDestroy(): Promise<void> {
    return this.flushTraces();
  }

  /** 输入不合法抛 400；其余任何问题都返回 { suggestion: null, alternatives }。 */
  async suggest(
    raw: unknown,
    context: SuggestContext = {},
  ): Promise<SuggestResult> {
    const input = parseInput(raw);
    const started = this.now();
    const runId = input.runId ?? uuidv7(started);
    const trace = startTrace(context.traceparent);
    const run = new RunTrace(runId, this.deps.events, () => this.now());
    run.emit('turn/start', {
      turn: run.turn,
      workflow: input.source === 'chip' ? 'chip' : 'faq',
      source: input.source,
      locale: input.locale,
      category: input.category,
      ...(input.faqId ? { faqId: input.faqId } : {}),
      parentRunId: input.parentRunId,
      traceId: trace.traceId,
      spanId: trace.spanId,
      parentSpanId: trace.parentId,
      // 学员原文只在 input 里（90 天清空、导出脱敏）；context 的 id 不是原文
      input: {
        subject: input.subject,
        message: input.message,
        ...(input.context?.recentTurns
          ? { recentTurns: input.context.recentTurns }
          : {}),
      },
      ...(input.context
        ? {
            context: {
              nodeId: input.context.nodeId ?? null,
              sessionId: input.context.sessionId ?? null,
              recentTurns: input.context.recentTurns?.length ?? 0,
            },
          }
        : {}),
    });
    const v5 = isV5(input);
    const release = v5 ? this.releaseVersion() : Promise.resolve(null);
    let decided: Decided = { chosen: null, reason: 'error', model: null };
    let suggestion: Suggestion | null = null;
    const retrieved: Retrieved = { candidates: [], release };
    try {
      decided = await this.decide(
        input,
        runId,
        run,
        trace,
        context.signal,
        retrieved,
        context.onStep,
      );
      suggestion = decided.chosen
        ? {
            id: runId,
            faqId: decided.chosen.id,
            question: decided.chosen.question,
            answer: decided.chosen.answer,
          }
        : null;
    } catch (error) {
      decided = { chosen: null, reason: 'error', model: decided.model };
      this.warn('Suggestion skipped', error);
    }
    const turn: AssistTurn = v5
      ? (decided.assisted?.turn ?? NO_MATCH_TURN)
      : NO_MATCH_TURN;
    // 寒暄与 clarify 不给「你可能想问」（契约 suggestTurnProblems）
    const alternatives =
      suggestion || turn.kind === 'smalltalk' || turn.kind === 'clarify'
        ? []
        : await this.alternatives(
            input,
            decided.reason,
            retrieved.candidates,
            context.signal,
          );
    const fields: SuggestTurnFields | null = v5
      ? {
          kind: turn.kind,
          intent: decided.assisted?.intent ?? null,
          // 寒暄不涉及选卡片：没有 confidence（契约 fixture 的 smalltalk 例子）
          confidence:
            turn.kind === 'smalltalk'
              ? null
              : (decided.assisted?.confidence ?? null),
          nodeId: turn.nodeId,
          blocks: turn.blocks,
          opening: turn.opening,
          closing: turn.closing,
          reply: turn.reply,
          explanation: turn.explanation,
          covered: turn.covered,
          guard: turn.guard,
          releaseVersion: await release,
          ...(turn.kind === 'answer' && turn.more?.length
            ? { more: turn.more }
            : {}),
          ...(turn.kind === 'answer' && turn.missed
            ? { missed: turn.missed }
            : {}),
        }
      : null;
    run.emit('turn/end', {
      turn: run.turn,
      reason: decided.reason,
      faqId: suggestion?.faqId ?? null,
      model: decided.model,
      latencyMs: this.now() - started,
      alternatives: alternatives.map((a) => a.faqId),
      ...(decided.branch ? { branch: decided.branch } : {}),
      ...(fields
        ? {
            kind: fields.kind,
            intent: fields.intent,
            confidence: fields.confidence,
            nodeId: fields.nodeId,
            blocks: fields.blocks,
            covered: fields.covered,
            guard: fields.guard,
            releaseVersion: fields.releaseVersion,
            // 一句多问：拆出几件事、其余的卡、没找到卡的事数（卡的 id 不是原文）
            ...(decided.assisted?.asks
              ? {
                  asks: decided.assisted.asks,
                  more: (fields.more ?? []).map((card) => card.faqId),
                  missed: fields.missed ?? 0,
                }
              : {}),
            // 给学员看的短句（模型写的过了守卫，或模板）：按学员原文对待（LEARNER_TEXT_FIELDS）
            output: {
              opening: fields.opening,
              closing: fields.closing,
              reply: fields.reply,
              explanation: fields.explanation,
            },
          }
        : {}),
    });
    this.background('Agent event log write failed', run.flush());
    return fields
      ? { suggestion, alternatives, ...fields }
      : { suggestion, alternatives };
  }

  /** 运行时读的发布版本（第一版发布之前、旧的来源、出错都是 null）。 */
  private async releaseVersion(): Promise<number | null> {
    try {
      return (await this.deps.qa.releaseVersion?.()) ?? null;
    } catch (error) {
      this.warn('Release version unavailable', error);
      return null;
    }
  }

  /**
   * 你可能想问（v3 §1）：检索候选前 3 个（按检索顺序），没有可用的候选就取热门已发布 FAQ；
   * 不含刚看过的。只用代码，不问模型；查不到（出错、超时）就给 []，从不影响建单。
   */
  private async alternatives(
    input: SuggestInput,
    reason: TurnEndReason,
    candidates: HelpdeskQaCandidate[],
    callerSignal: AbortSignal | undefined,
  ): Promise<Alternative[]> {
    // 限流时不再查库；调用方已断开时没人看
    if (
      reason === 'rate_limited' ||
      reason === 'aborted' ||
      callerSignal?.aborted
    )
      return [];
    const excluded = new Set(input.shownFaqIds);
    if (input.faqId) excluded.add(input.faqId);
    if (input.context?.nodeId) excluded.add(input.context.nodeId);
    const usable = (list: HelpdeskQaCandidate[]): Alternative[] => {
      const seen = new Set(excluded);
      const picked: Alternative[] = [];
      for (const c of list) {
        if (picked.length === SUGGEST_ALTERNATIVES) break;
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        picked.push({ faqId: c.id, question: c.question });
      }
      return picked;
    };
    const ranked = usable(candidates);
    if (ranked.length > 0) return ranked;
    let timer: NodeJS.Timeout | undefined;
    try {
      const popular = await Promise.race([
        this.deps.qa.findPopular({
          locale: input.locale,
          category: input.faqCategory,
          excludeIds: [...excluded],
          limit: SUGGEST_ALTERNATIVES,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('timed out')),
            ALTERNATIVES_TIMEOUT_MS,
          );
        }),
      ]);
      return usable(popular);
    } catch (error) {
      this.warn('Alternatives skipped', error);
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /** 限流 → 工作流 → 期限 → 记一行；返回结束原因。 */
  private async decide(
    input: SuggestInput,
    runId: string,
    run: RunTrace,
    trace: TraceContext,
    callerSignal: AbortSignal | undefined,
    retrieved: Retrieved,
    onStep?: SuggestContext['onStep'],
  ): Promise<Decided> {
    const env = this.env();
    const apiKey = env.OPENROUTER_API_KEY?.trim() ?? '';
    // chip 不调模型，不需要 key
    if (apiKey === '' && input.source !== 'chip')
      return { chosen: null, reason: 'no_key', model: null };
    const limits = suggestLimits(isV5(input), env);
    let deadline = this.now() + (this.deps.deadlineMs ?? limits.deadlineMs);
    const left = () => deadline - this.now();
    // 一句多问（multi-ask.ts）：真拆出了几件事，这一轮的期限多给一次（Portal 聊天最多等 16 秒）
    const baseDeadline = deadline;
    const extendDeadline = (ms: number) => {
      deadline = Math.max(deadline, baseDeadline + ms);
    };
    const cutoffMs = limits.cutoffMs && (this.deps.cutoffMs ?? limits.cutoffMs);
    // 没有截断时只看总期限（一句多问会把它往后挪）
    const cutoff = cutoffMs ? this.now() + cutoffMs : Number.POSITIVE_INFINITY;
    // 思考那一路：到截断或总期限，先到哪个算哪个
    const thinkLeft = () => Math.min(cutoff, deadline) - this.now();
    const limit =
      input.source === 'submit' ? SUGGEST_RATE_LIMIT : ASSIST_RATE_LIMIT;
    const allowed = await this.deps.rateLimit.tryHit(
      `${input.source === 'submit' ? 'helpdesk-suggest' : 'helpdesk-assist'}:${input.learnerId}`,
      limit.limit,
      limit.windowMs,
    );
    if (!allowed) return { chosen: null, reason: 'rate_limited', model: null };
    if (left() <= 0) return { chosen: null, reason: 'timeout', model: null };

    const started = this.now();
    const steps = {
      trace: run,
      signal: callerSignal,
      stepTimeoutMs: () =>
        Math.min(this.deps.timeoutMs ?? limits.stepMs, left()),
      traceparent: () => childTraceparent(trace),
      onStep: (name: string) => {
        if (onStep && Object.hasOwn(STREAM_STEPS, name))
          onStep(STREAM_STEPS[name as keyof typeof STREAM_STEPS]);
      },
    };

    if (input.source === 'chip') {
      const faqId = input.faqId as string;
      const { state, reason } = await runWorkflow(
        chipWorkflow({ qa: this.deps.qa }),
        { faqId, locale: input.locale, chosen: null },
        steps,
      );
      // v5：点 chip 不问模型，开头结尾用固定模板（choice 卡片没有）
      const assisted: Assisted | undefined = isV5(input)
        ? {
            turn: state.chosen
              ? // chip 的文字就是界面语言的 FAQ 问题：按界面语言（与学员写的字）选模板
                answerTurn(state.chosen, learnerOf(input.message, input.locale))
              : NO_MATCH_TURN,
            intent: null,
            confidence: null,
          }
        : undefined;
      return this.logAndDecide(input, runId, {
        queryText: input.message || state.chosen?.question || '',
        candidateIds: [faqId],
        chosen: state.chosen,
        reason,
        model: null,
        started,
        left,
        assisted,
        release: retrieved.release,
      });
    }

    const model = suggestModel(env);
    const { thinking } = limits;
    const modelTarget = {
      provider: 'openrouter' as const,
      model,
      apiKey,
      baseUrl: env.OPENROUTER_BASE_URL?.trim() || DEFAULT_BASE_URL,
      ...(thinking ? { thinking } : {}),
    };
    if (isV5(input)) {
      // 开思考：同时发一个不思考的后备（不报步骤给「思考中」面板，步骤记 branch quick）
      const hedged = cutoffMs !== undefined && cutoffMs > 0;
      // 分级 L2 精排（HELPDESK_RERANK_MODEL，缺省开，off 关）：在共享查询之前，两路只精排一次
      const rerank = rerankConfig(env);
      // 追问卡片带上父卡片的问题（HELPDESK_CARD_CONTEXT=on，缺省关）：精排与挑卡都看「父问题 → 追问」
      const cardContext =
        env.HELPDESK_CARD_CONTEXT?.trim().toLowerCase() === 'on';
      // 只在精排开着时有用（字词检索不看前文）；缺省开，off 关
      const queryContext =
        rerank !== null &&
        helpdeskSwitch(
          env.HELPDESK_QUERY_CONTEXT,
          HELPDESK_DEFAULTS.queryContext,
        );
      // 一句话问了几件事时拆开、各给一张卡（multi-ask.ts；HELPDESK_MULTI_ASK，缺省见 HELPDESK_DEFAULTS）
      const multiAsk = helpdeskSwitch(
        env.HELPDESK_MULTI_ASK,
        HELPDESK_DEFAULTS.multiAsk,
      );
      const reranker =
        rerank &&
        openRouterReranker({
          model: rerank.model,
          apiKey,
          baseUrl: env.OPENROUTER_BASE_URL?.trim() || DEFAULT_BASE_URL,
        });
      const ranked =
        rerank && reranker
          ? rerankedSource(
              this.deps.qa,
              this.deps.wrapReranker
                ? this.deps.wrapReranker(reranker, rerank.model)
                : reranker,
              rerank.keep,
              { withContext: cardContext },
            )
          : this.deps.qa;
      const qa = hedged ? sharedLookups(ranked) : ranked;
      const assist = (
        target: ModelTarget,
        until: () => number,
        extra: Partial<WorkflowDeps> = {},
      ) =>
        runWorkflow(
          assistWorkflow({
            qa,
            limit: ASSIST_CANDIDATES,
            left: until,
            direct: rerank?.direct ?? null,
            cardContext,
            queryContext,
            multiAsk,
            extendDeadline,
          }),
          initialAssistState({
            locale: input.locale,
            category: input.faqCategory,
            message: input.message,
            context: input.context as SuggestRequestContext,
          }),
          {
            ...steps,
            stepTimeoutMs: () =>
              Math.min(this.deps.timeoutMs ?? limits.stepMs, until()),
            runner: this.deps.runner,
            model: target,
            ...extra,
          },
        );
      const stopBackup = new AbortController();
      const backup = hedged
        ? assist({ ...modelTarget, thinking: 'off' }, left, {
            signal: callerSignal
              ? AbortSignal.any([callerSignal, stopBackup.signal])
              : stopBackup.signal,
            onStep: undefined,
            branch: 'quick',
          })
        : null;
      let { state, reason, trail } = await assist(modelTarget, thinkLeft);
      let branch: Decided['branch'];
      if (backup) {
        branch = 'thinking';
        if (SETTLED.includes(reason) && thinkLeft() > 0) stopBackup.abort();
        else {
          ({ state, reason, trail } = await backup);
          branch = 'quick';
        }
      }
      // 没给卡片时模型（不确定地）选中的那张排在「你可能想问」第一个
      const picked = state.turn
        ? null
        : state.candidates.find((c) => c.id === state.picked);
      retrieved.candidates = picked
        ? [picked, ...state.candidates.filter((c) => c !== picked)]
        : state.candidates;
      // explain 步没走完（超时、出错）：clarify 照样回，covered:false（Portal 给转人工卡）
      const turn =
        state.turn ??
        (state.clarifying && state.shown
          ? uncoveredTurn(
              state.shown.id,
              reason === 'timeout' || reason === 'aborted'
                ? 'timeout'
                : 'error',
            )
          : NO_MATCH_TURN);
      return this.logAndDecide(input, runId, {
        queryText: state.queryText,
        // 一句多问：每件事自己的候选也算看过（发布检查按它估计改一张卡要重问几道）
        candidateIds: [
          ...new Set([
            ...state.candidates.map((c) => c.id),
            ...state.askCandidates.flat().map((c) => c.id),
          ]),
        ],
        chosen: turn.kind === 'answer' ? state.chosen : null,
        reason,
        model:
          trail.includes('pick_faq') || trail.includes('pick_asks')
            ? model
            : null,
        started,
        left,
        assisted: {
          turn,
          intent: state.intent,
          confidence: state.confidence,
          ...(state.asks.length ? { asks: state.asks.length } : {}),
        },
        release: retrieved.release,
        branch,
      });
    }

    const template: WorkflowTemplate<ReturnType<typeof initialFaqState>> =
      faqWorkflow({ qa: this.deps.qa, limit: SUGGEST_CANDIDATES, left });
    const { state, reason, trail } = await runWorkflow(
      template,
      initialFaqState({
        locale: input.locale,
        category: input.faqCategory,
        subject: input.subject,
        message: input.message,
      }),
      { ...steps, runner: this.deps.runner, model: modelTarget },
    );
    // 不确定没出卡：模型选中的那张排在「你可能想问」第一个
    const unsure =
      state.confidence === 'unsure'
        ? state.candidates.find((c) => c.id === state.picked)
        : undefined;
    retrieved.candidates = unsure
      ? [unsure, ...state.candidates.filter((c) => c !== unsure)]
      : state.candidates;
    // 走到了 pick_faq 才算问过模型
    const asked = trail.includes('pick_faq');
    return this.logAndDecide(input, runId, {
      queryText: state.queryText,
      candidateIds: state.candidates.map((c) => c.id),
      chosen: state.chosen,
      reason,
      model: asked ? model : null,
      started,
      left,
    });
  }

  private async logAndDecide(
    input: SuggestInput,
    runId: string,
    result: {
      queryText: string;
      candidateIds: string[];
      chosen: HelpdeskQaCandidate | null;
      reason: TurnEndReason;
      model: string | null;
      started: number;
      left: () => number;
      assisted?: Assisted;
      release?: Promise<number | null>;
      branch?: Decided['branch'];
    },
  ): Promise<Decided> {
    let { chosen, reason, assisted } = result;
    // 过了期限才定下来的答案学员看不到：记一行检索，但不记 faq_id（v5 的寒暄、解释同样作废）
    if (
      (chosen || (assisted && assisted.turn.kind !== 'no_match')) &&
      result.left() <= 0
    ) {
      chosen = null;
      reason = 'timeout';
      if (assisted) assisted = { ...assisted, turn: NO_MATCH_TURN };
    }
    const turn = assisted?.turn;
    await this.deps.log.record({
      id: runId,
      learnerId: input.learnerId,
      locale: input.locale,
      source: input.source,
      category: input.category,
      queryText: result.queryText,
      candidateIds: result.candidateIds,
      faqId: chosen?.id ?? null,
      model: result.model,
      latencyMs: this.now() - result.started,
      ...(assisted && turn
        ? {
            turn: {
              kind: turn.kind,
              intent: assisted.intent,
              confidence:
                turn.kind === 'smalltalk' ? null : assisted.confidence,
              nodeId: turn.nodeId,
              blocks: turn.blocks,
              guard: turn.guard,
              covered: turn.covered,
              sessionId: input.context?.sessionId ?? null,
              releaseVersion: (await result.release) ?? null,
            },
          }
        : {}),
    });
    this.purgeLater();
    this.checkHealthLater();
    return {
      chosen,
      reason,
      model: result.model,
      assisted,
      ...(result.branch ? { branch: result.branch } : {}),
    };
  }

  /** 没有定时任务：每个实例每小时最多顺手清一次 90 天前的学员原文（失败不影响推荐）。 */
  private purgeLater(): void {
    const now = this.now();
    if (now - this.lastPurge < PURGE_EVERY_MS) return;
    this.lastPurge = now;
    const cutOff = new Date(now - QUERY_TEXT_RETENTION_DAYS * 24 * 3_600_000);
    this.deps.log.purgeQueryText(cutOff).catch((error: unknown) => {
      this.warn('Query text purge failed', error);
    });
    this.deps.events.purgeLearnerText(cutOff).catch((error: unknown) => {
      this.warn('Agent event learner text purge failed', error);
    });
  }

  /**
   * 模型输出健康（trace/model-health.ts）：每个实例每 MODEL_HEALTH.checkEveryMs 最多顺手查一次最近
   * windowMinutes 分钟；某一步校验没过、守卫拦下或出错超时的比例超过阈值 → 一行结构化 WARN 日志
   * （type helpdesk，event model_output_degraded），运维按它报警。失败不影响推荐。
   */
  private checkHealthLater(): void {
    const now = this.now();
    if (now - this.lastHealthCheck < MODEL_HEALTH.checkEveryMs) return;
    this.lastHealthCheck = now;
    const env = this.env();
    const threshold = healthThreshold(env);
    const since = new Date(now - MODEL_HEALTH.windowMinutes * 60_000);
    this.deps.events
      .stepHealth(since)
      .then((rows) => {
        for (const step of assessModelHealth(rows, {
          threshold,
          minSample: MODEL_HEALTH.minSample,
        })) {
          if (!step.alert) continue;
          this.logger.warn(
            JSON.stringify({
              type: 'helpdesk',
              event: 'model_output_degraded',
              step: step.step,
              kind: step.kind,
              model: env.HELPDESK_SUGGEST_MODEL?.trim() || null,
              windowMinutes: MODEL_HEALTH.windowMinutes,
              total: step.total,
              invalidRate: step.invalidRate,
              guardFallbackRate: step.guardFallbackRate,
              failureRate: step.failureRate,
              threshold,
            }),
          );
        }
      })
      .catch((error: unknown) => {
        this.warn('Model output health check failed', error);
      });
  }

  /**
   * 学员反馈：首个为准，同值重复 OK，不同值不覆盖（changed=false）。
   * submit 收 solved / declined / edited，chat / chip 收 helpful / not_helpful，别的 400。
   * 记下的那一个同时追加到 run 的事件日志（feedback）；只接在已有的 run 后面，从不单独起一个 run。
   */
  async recordOutcome(
    rawId: string,
    raw: unknown,
  ): Promise<{ id: string; outcome: SuggestionOutcome; changed: boolean }> {
    if (!isUuid(rawId)) throw invalid('Invalid suggestion id');
    const outcome = record(raw).outcome;
    if (!isSuggestionOutcome(outcome))
      throw invalid(
        'outcome must be solved, declined, edited, helpful or not_helpful',
      );
    const id = rawId.toLowerCase();
    const result = await this.deps.log.setOutcome(id, outcome);
    if (result.kind === 'not_found')
      throw problem(404, 'not_found', 'No such suggestion');
    if (result.kind === 'wrong_source')
      throw invalid(
        `outcome ${outcome} does not apply to a ${result.source} answer`,
      );
    if (result.changed)
      this.background(
        'Agent event log write failed',
        this.deps.events.append(
          id,
          [{ type: 'feedback', time: new Date(this.now()), data: { outcome } }],
          { existing: true },
        ),
      );
    return { id, outcome: result.outcome, changed: result.changed };
  }
}
