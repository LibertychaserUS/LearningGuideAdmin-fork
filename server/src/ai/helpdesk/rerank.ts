import type {
  HelpdeskQaCandidate,
  HelpdeskQaSource,
} from '../../contracts/helpdesk-qa';
import {
  HELPDESK_DEFAULTS,
  helpdeskSetting,
} from '../../contracts/helpdesk-defaults';
import {
  evalCacheKey,
  evalCacheScope,
  measureSpend,
  replayLatency,
  reportSpend,
} from '../../contracts/helpdesk-eval-cache';

/**
 * 精排（分级方案 L2，owner 2026-11-02：精排也走 OpenRouter，按价格选，参数量不限）。
 *
 * 缺省开（contracts/helpdesk-defaults.ts，owner 2026-11-03）；没有 OPENROUTER_API_KEY 就不精排，候选顺序不变。
 * 每次现读（不用重新部署），没设 = 缺省方案，off = 关掉：
 * - HELPDESK_RERANK_MODEL：OpenRouter /rerank 的模型（缺省 voyageai/rerank-2.5-lite）；off = 不精排。
 * - HELPDESK_RERANK_KEEP：精排后留给模型看的候选数（缺省 5）；off = 全留。
 * - HELPDESK_RERANK_DIRECT：「分数,领先差距」（缺省 0.84,0.05）：没有屏幕上的卡片、第一名是答案卡、
 *   分数与领先第二名的差距都够 → 直接给卡，不调用模型（阈值只在开发集上标定）。off 或写错 = 从不直接给。
 * 精排失败或超时（RERANK_LIMITS.timeoutMs）→ 原顺序，学员不会因为它拿不到候选；不重试。
 */
export const RERANK_LIMITS = {
  timeoutMs: 1_500,
  /** 每张卡给精排看的答案字数（问题全给）。 */
  answerChars: 600,
  queryChars: 600,
  /** 前文（search.context）至多这么多字。 */
  contextChars: 200,
  /** 召回池里向量那一路至多几张（S650 dev：字词 10 张 ∪ 向量 10 张，平均 16.5 张，正确卡在池里 99.5%）。 */
  vectorPool: 10,
} as const;

export type RerankConfig = {
  model: string;
  keep: number | null;
  direct: { score: number; margin: number } | null;
};

/** 精排模型：没设 = 缺省，off = null（不精排）。 */
export function rerankModel(env: NodeJS.ProcessEnv): string | null {
  return helpdeskSetting(
    env.HELPDESK_RERANK_MODEL,
    HELPDESK_DEFAULTS.rerankModel,
  );
}

export function rerankConfig(env: NodeJS.ProcessEnv): RerankConfig | null {
  const model = rerankModel(env);
  if (!model || !env.OPENROUTER_API_KEY?.trim()) return null;
  const keepSetting = env.HELPDESK_RERANK_KEEP?.trim() ?? '';
  const keepRaw = Number(keepSetting);
  const keep =
    keepSetting === ''
      ? HELPDESK_DEFAULTS.rerankKeep
      : Number.isInteger(keepRaw) && keepRaw > 0
        ? keepRaw
        : null;
  const directSetting = env.HELPDESK_RERANK_DIRECT?.trim() ?? '';
  const parts = directSetting.split(',').map((part) => Number(part.trim()));
  const direct =
    directSetting === ''
      ? { ...HELPDESK_DEFAULTS.rerankDirect }
      : parts.length === 2 &&
          parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
        ? { score: parts[0], margin: parts[1] }
        : null;
  return { model, keep, direct };
}

export type Reranker = (
  query: string,
  documents: string[],
) => Promise<number[] | null>;

/** OpenRouter POST /rerank：返回与 documents 同序的分数；失败、超时、条数不对 → null。 */
export function openRouterReranker(input: {
  model: string;
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Reranker {
  const doFetch = input.fetch ?? fetch;
  return async (query, documents) => {
    if (documents.length === 0) return [];
    try {
      const response = await doFetch(
        `${input.baseUrl.replace(/\/+$/, '')}/rerank`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: input.model,
            query: query.slice(0, RERANK_LIMITS.queryChars),
            documents,
          }),
          signal: AbortSignal.timeout(
            input.timeoutMs ?? RERANK_LIMITS.timeoutMs,
          ),
        },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as {
        results?: { index?: unknown; relevance_score?: unknown }[];
        usage?: { cost?: unknown };
      };
      // 精排也要钱（OpenRouter 回 usage.cost）：检查里记进这一问的花费，线上聊天不记
      reportSpend('rerank', body.usage?.cost);
      const scores: (number | null)[] = documents.map(() => null);
      for (const row of body.results ?? []) {
        if (
          typeof row.index === 'number' &&
          Number.isInteger(row.index) &&
          row.index >= 0 &&
          row.index < documents.length &&
          typeof row.relevance_score === 'number'
        )
          scores[row.index] = row.relevance_score;
      }
      return scores.every((s) => s !== null) ? scores : null;
    } catch {
      return null;
    }
  };
}

/**
 * 发布前检查用的精排缓存（契约 contracts/helpdesk-eval-cache.ts 的 rerank 层）：分数按（模型, 问句, 卡片文本）
 * 一对一对记（Voyage 这类交叉编码器每一对单独打分，和同批的其他卡无关），卡改了只重算那几对。
 * 全部命中：照记录的耗时等（不超过精排时限）再给分数；有没记的：只把没记的那几张拿去真精排。
 * 精排失败（null）不记。不在检查的一问里（线上聊天）→ 原样交给 inner。
 */
export function cachedReranker(inner: Reranker, model: string): Reranker {
  return async (query, documents) => {
    const scope = evalCacheScope();
    if (!scope || documents.length === 0) return inner(query, documents);
    const asked = query.slice(0, RERANK_LIMITS.queryChars);
    const keys = documents.map((document) =>
      evalCacheKey('rerank', { model, query: asked, document }),
    );
    const stats = scope.stats.rerank;
    const known =
      scope.mode === 'use'
        ? await scope.store.get('rerank', keys)
        : new Map<string, never>();
    const scores = keys.map((key) => {
      const value = known.get(key)?.value;
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    });
    const missing = scores.flatMap((score, index) =>
      score === null ? [index] : [],
    );
    if (missing.length === 0) {
      const entries = keys.map((key) => known.get(key)!);
      const latency = Math.max(...entries.map((e) => e.latencyMs));
      await replayLatency(Math.min(latency, RERANK_LIMITS.timeoutMs));
      stats.hits += 1;
      stats.savedUsd += entries.reduce((sum, e) => sum + e.costUsd, 0);
      return scores as number[];
    }
    stats.misses += 1;
    // 记下的那几对没再花钱
    stats.savedUsd += [...known.values()].reduce(
      (sum, e) => sum + e.costUsd,
      0,
    );
    const started = performance.now();
    const { value: fresh, spent } = await measureSpend(() =>
      inner(
        asked,
        missing.map((index) => documents[index]),
      ),
    );
    if (!fresh) return null;
    const latencyMs = Math.round(performance.now() - started);
    missing.forEach((index, at) => (scores[index] = fresh[at]));
    await scope.store
      .put(
        'rerank',
        missing.map((index, at) => ({
          key: keys[index],
          entry: {
            value: fresh[at],
            latencyMs,
            // 一次请求的钱按卡数摊到每一对
            costUsd: spent.rerank / missing.length,
          },
        })),
      )
      .catch(() => undefined);
    return scores as number[];
  };
}

/** withContext：追问卡片前面带上父卡片的问题（「父问题 → 追问」），单独看也是完整的问题。 */
const rerankDocument = (c: HelpdeskQaCandidate, withContext: boolean) =>
  `${withContext && c.under ? `${c.under} → ` : ''}${c.question}\n${c.answer.slice(0, RERANK_LIMITS.answerChars)}`;

/**
 * 候选按精排分数从高到低重排（同分保持原顺序），每张带上 rerankScore，至多留 keep 张。
 * 只改 findCandidates；精排失败就原样返回。
 */
export function rerankedSource(
  qa: HelpdeskQaSource,
  reranker: Reranker,
  keep: number | null,
  options: { withContext?: boolean } = {},
): HelpdeskQaSource {
  return {
    ...qa,
    findCandidates: async (search) => {
      // 召回池 = 原来的候选（字词检索 + 树上近亲）∪ 向量最像的 RERANK_LIMITS.vectorPool 个（来源支持时）
      // 有前文（search.context）时向量与精排各按「前文 → 本句」再查一次：短追问单看找不到卡，
      // 换了话题时本句自己的分数又够高，所以每张卡取两次里更高的分
      const withPrevious = search.context?.trim()
        ? `${search.context.trim().slice(0, RERANK_LIMITS.contextChars)} → ${search.text}`
        : null;
      const vectorOf = (text: string) =>
        qa.findVectorCandidates
          ? qa
              .findVectorCandidates({
                locale: search.locale,
                text,
                limit: RERANK_LIMITS.vectorPool,
              })
              .catch(() => [])
          : Promise.resolve([]);
      const [retrieved, vector, vectorWithPrevious] = await Promise.all([
        qa.findCandidates(search),
        vectorOf(search.text),
        withPrevious ? vectorOf(withPrevious) : Promise.resolve([]),
      ]);
      const seen = new Set(retrieved.map((c) => c.id));
      const found = [
        ...retrieved,
        ...[...vector, ...vectorWithPrevious].filter(
          (c) => !seen.has(c.id) && seen.add(c.id),
        ),
      ];
      if (found.length === 0) return found;
      const documents = found.map((c) =>
        rerankDocument(c, options.withContext ?? false),
      );
      const [own, previous] = await Promise.all([
        reranker(search.text, documents),
        withPrevious ? reranker(withPrevious, documents) : null,
      ]);
      const scores =
        own && previous
          ? own.map((score, index) => Math.max(score, previous[index]))
          : (own ?? previous);
      if (!scores) return retrieved;
      const ranked = found
        .map((c, index) => ({ c, index, score: scores[index] }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map(({ c, score }) => ({ ...c, rerankScore: score }));
      return keep ? ranked.slice(0, keep) : ranked;
    },
  };
}

/**
 * 精排有把握时直接给第一名（不调用大模型）：第一名有 rerankScore、是答案卡（不是 choice），
 * 分数 ≥ direct.score，且比第二名高出 ≥ direct.margin（只有一张时差距按它自己的分数算）。
 */
export function directPick(
  candidates: HelpdeskQaCandidate[],
  direct: RerankConfig['direct'],
): HelpdeskQaCandidate | null {
  if (!direct) return null;
  const [top, second] = candidates;
  if (!top || top.rerankScore === undefined) return null;
  if ((top.type ?? 'answer') !== 'answer') return null;
  const margin = top.rerankScore - (second?.rerankScore ?? 0);
  return top.rerankScore >= direct.score && margin >= direct.margin
    ? top
    : null;
}
