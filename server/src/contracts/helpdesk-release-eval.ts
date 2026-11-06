/**
 * 发布前的真流程检查（release check v2；v1 是 owner 2026-11-03 选的「抽样跑测试集」）的交接契约：BackOffice 的发布门
 * 只经这里的 ReleaseAnswerer 问 Agent；实现在 src/ai/helpdesk/release-answerer.ts（和线上聊天同一个
 * HelpdeskSuggestService：关键词 + 向量召回、精排、小模型选卡作答），由 app.module.ts 组装。
 * 没有组装（测试、只有 ks 角色）= 不问模型。
 *
 * 测试集的问题是生成的（不含用户数据）；回归用例是员工接受过的、脱敏过的用户原话。
 */
import type { EvalAskStats, EvalCacheMode } from './helpdesk-eval-cache';
import type { SuggestIntent } from './helpdesk-qa';

export const HELPDESK_RELEASE_ANSWERER = Symbol('HELPDESK_RELEASE_ANSWERER');

export type ReleaseEvalLocale = 'en-GB' | 'zh-CN';

/** 一个问题在候选版本上得到的结果（和 Portal 看到的一样：出了哪张卡、还是追问 / 寒暄 / 没有卡）。 */
export type ReleaseEvalAnswer = {
  /** error：没有回复（没有 key、超时、模型出错、被限流）。 */
  kind: 'answer' | 'clarify' | 'smalltalk' | 'no_match' | 'error';
  /** answer：出的卡；clarify：追问的那张卡；其余 null。 */
  nodeId: string | null;
  /** answer 且一句多问：第一张以外的卡（节点 id，按出现顺序）；只有一张时不写。 */
  more?: string[];
  /** 模型给的 intent（判分看寒暄是哪一种）；没调模型、或答题器不报 = null / 不写。 */
  intent?: SuggestIntent | null;
  /** clarify：答案里有没有写到（判分要它）；其余 null / 不写。 */
  covered?: boolean | null;
  /**
   * error 的原因（turn/end：timeout、rate_limited、error、aborted、no_key；没有回复 = no_reply）。
   * 超时也是学员没拿到答案：报告里照实算「没答上」，不当作「没跑」。
   */
  failure?: string;
  /** 这个问题花的钱（美元）：模型 + 精排 + 问句向量（服务商回的计价；没有计价 = 0）。 */
  costUsd: number;
  /** costUsd 按层分开（答题器报了才有）。 */
  spend?: { model: number; rerank: number; embed: number };
  /** 分层缓存这一问命中了几次、省了多少（contracts/helpdesk-eval-cache.ts；没开缓存不写）。 */
  cache?: EvalAskStats;
  /** 发出了却没有带价格回复的请求数。 */
  unpricedCalls: number;
  /**
   * 模型这一问看到的候选卡（节点 id，精排之后）：报告里按卡数「这张卡进过几道题的候选」，
   * 下次检查前据此估计改一张卡要重问几道（答题器报了才有）。
   */
  candidates?: string[];
};

/** 绑定在一个候选版本上的答题器（快照由发布门给；这一版的向量要先算好）。 */
export type ReleaseEvalSession = {
  ask(input: {
    message: string;
    locale: ReleaseEvalLocale;
    signal?: AbortSignal;
    /** 缓存怎么用（缺省 use）：refresh = 漂移抽查，bypass = 复问新出的错。 */
    cache?: EvalCacheMode;
    /**
     * 追问（B5）：学员屏幕上正开着的卡（节点 id）与之前的学员原文（旧的在前，至多 3 条），
     * 和 Portal 发的 context.nodeId / recentTurns 一样；不给 = 聊天面板的第一句。
     */
    screen?: { nodeId: string; recentTurns: readonly string[] };
  }): Promise<ReleaseEvalAnswer>;
};

export type ReleaseAnswerer = {
  /** 没有 OPENROUTER_API_KEY → false（发布门照实报告「没跑」，不悄悄算过）。 */
  available(): boolean;
  /** 线上用的答题模型（报告里写明）。 */
  model(): string;
  forRelease(input: { version: number; snapshot: unknown }): ReleaseEvalSession;
};

export const noReleaseAnswerer: ReleaseAnswerer = {
  available: () => false,
  model: () => 'none',
  forRelease: () => ({
    ask: () =>
      Promise.resolve({
        kind: 'error',
        nodeId: null,
        costUsd: 0,
        unpricedCalls: 0,
      }),
  }),
};
