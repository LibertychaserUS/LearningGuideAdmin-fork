/**
 * Helpdesk 的缺省方案：分级小模型（owner 2026-11-03 00:27Z：「默认模型这里都要改」，「推到线上也是要用我们的
 * 最新方案」）。部署什么都不用配就是这一套；环境变量只在要临时换掉某一层时才设，设成 off 就关掉那一层。
 *
 * 链路（Agent 与 BackOffice 两边都读这里，所以放在 contracts）：
 * - L1 召回：字词检索 ∪ bge-m3 向量（HELPDESK_EMBED_MODEL），平铺，所有已发布的答案卡都参与（HELPDESK_SEARCH_SCOPE）；
 *   向量与精排还按「学员上一句 → 这一句」再查一次，取高分（HELPDESK_QUERY_CONTEXT）。
 * - L2 精排：Voyage rerank-2.5-lite（HELPDESK_RERANK_MODEL），留前 5 张给模型（HELPDESK_RERANK_KEEP）；
 *   第一名分数与领先差距都够 → 直接给卡，不调模型（HELPDESK_RERANK_DIRECT）。
 * - L3 小模型：gemma-4-31b 挑卡、解释、寒暄（HELPDESK_SUGGEST_MODEL），不开思考（HELPDESK_SUGGEST_THINKING）。
 *   BackOffice 的「AI 按指令改卡」与缺口挖掘也用同一个模型。
 *
 * 依据：v3.3 终测（2026-11-03，AI 盲评）错卡 S650 test 0.19% / 多轮 0.91% / 闲聊 1.20%，每答 ¥0.001–0.0023，
 * p95 3.6–5.6 秒；OpenRouter 按价格选最便宜的提供方。
 */
export const HELPDESK_DEFAULTS = {
  model: 'google/gemma-4-31b-it',
  thinking: 'off',
  embedModel: 'baai/bge-m3',
  rerankModel: 'voyageai/rerank-2.5-lite',
  rerankKeep: 5,
  /** 「分数,领先差距」（只在开发集上标定）。 */
  rerankDirect: { score: 0.816, margin: 0.05 },
  searchScope: 'all',
  queryContext: true,
  /**
   * 一句话问了几件事时拆开、各给一张卡（HELPDESK_MULTI_ASK；multi-ask.ts）。真模型评测与 owner 点头之前缺省关。
   */
  multiAsk: false,
} as const;

/** 关掉某一层用的值（大小写不论）。 */
export const HELPDESK_OFF = 'off';

/**
 * 读一个「模型名」类的变量：没设或空 → 缺省；off → null（这一层关掉）；其余原样（去首尾空格）。
 */
export function helpdeskSetting(
  value: string | undefined,
  fallback: string,
): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return fallback;
  return trimmed.toLowerCase() === HELPDESK_OFF ? null : trimmed;
}

/** 读一个开关：on / off；没设或不认识 → 缺省。 */
export function helpdeskSwitch(
  value: string | undefined,
  fallback: boolean,
): boolean {
  const v = value?.trim().toLowerCase();
  if (v === 'on') return true;
  if (v === HELPDESK_OFF) return false;
  return fallback;
}
