import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

/**
 * 发布前检查的分层结果缓存（release check v2，owner 2026-11-06 批准）：同一个输入只付一次钱。
 *
 * 三层，各按自己的输入寻址（内容寻址，像 Bazel 的动作缓存）：
 * - embed：学员问句的向量，键 = (向量模型, 文本)；
 * - rerank：一对（问句, 卡片文本）的精排分数，键 = (精排模型, 问句, 卡片文本)；卡改了只有那一对重算；
 * - step：一次模型步的整个请求（system、prompt、工具、模型、思考档位），键里没有 key；
 *   候选卡片写在 prompt 里，所以检索结果变了这一步就自然重问。
 * 命中时照记录的耗时等一遍（可以被取消），超时、对冲与总期限的行为和真问一样；只省钱，不改结果。
 * 只缓存完整的结果：出错、超时、被取消的不记。条目 ttlDays 天后不再用（服务商的模型会悄悄变）。
 *
 * 只在检查的一问里生效（runInEvalAsk 包住的调用）：线上聊天没有这个 scope，包装器原样直通，从不读写缓存。
 */
export const EVAL_CACHE = {
  /** 缓存条目多少天后不再用。 */
  ttlDays: 14,
  /** 改了 runner 里不在请求体中的东西（温度、服务商排序……）就加一，旧条目全部作废。 */
  version: 1,
} as const;

export const EVAL_CACHE_LAYERS = ['embed', 'rerank', 'step'] as const;
export type EvalCacheLayer = (typeof EVAL_CACHE_LAYERS)[number];

/** use = 先读后写；refresh = 不读、写新的（漂移抽查）；bypass = 不读不写（复问新出的错）。 */
export const EVAL_CACHE_MODES = ['use', 'refresh', 'bypass'] as const;
export type EvalCacheMode = (typeof EVAL_CACHE_MODES)[number];

export type EvalCacheEntry = {
  /** JSON：embed = base64 的 float32；rerank = 分数；step = runner 的结果。 */
  value: unknown;
  /** 真问时这一次花的时间（命中时照等）。 */
  latencyMs: number;
  /** 真问时这一次的花费（美元；命中 = 省下的）。 */
  costUsd: number;
};

export type EvalCacheStore = {
  /** 没过期的条目；没有的键不在结果里。 */
  get(
    layer: EvalCacheLayer,
    keys: readonly string[],
  ): Promise<Map<string, EvalCacheEntry>>;
  /** 写入（同键覆盖：refresh 用新的替换旧的）。 */
  put(
    layer: EvalCacheLayer,
    rows: readonly { key: string; entry: EvalCacheEntry }[],
  ): Promise<void>;
  /** 删掉过期的条目，返回删了几条。 */
  prune?(): Promise<number>;
};

export type EvalLayerStats = {
  hits: number;
  misses: number;
  /** 命中省下的钱（真问时记的花费）。 */
  savedUsd: number;
};
export type EvalAskStats = Record<EvalCacheLayer, EvalLayerStats>;

export function emptyAskStats(): EvalAskStats {
  return {
    embed: { hits: 0, misses: 0, savedUsd: 0 },
    rerank: { hits: 0, misses: 0, savedUsd: 0 },
    step: { hits: 0, misses: 0, savedUsd: 0 },
  };
}

export function addAskStats(into: EvalAskStats, more: EvalAskStats): void {
  for (const layer of EVAL_CACHE_LAYERS) {
    into[layer].hits += more[layer].hits;
    into[layer].misses += more[layer].misses;
    into[layer].savedUsd += more[layer].savedUsd;
  }
}

/** 检查里的一问：用哪份缓存、怎么用、记到哪。store null = 不缓存（只计花费）。 */
export type EvalAskScope = {
  store: EvalCacheStore | null;
  mode: EvalCacheMode;
  stats: EvalAskStats;
};

const askScope = new AsyncLocalStorage<EvalAskScope>();

export function runInEvalAsk<T>(
  scope: EvalAskScope,
  fn: () => Promise<T>,
): Promise<T> {
  return askScope.run(scope, fn);
}

/** 现在这一问的缓存；不在检查里（线上聊天）、没有缓存、或 bypass → null。 */
export function evalCacheScope():
  (EvalAskScope & { store: EvalCacheStore }) | null {
  const scope = askScope.getStore();
  if (!scope?.store || scope.mode === 'bypass') return null;
  return scope as EvalAskScope & { store: EvalCacheStore };
}

/** 稳定的 JSON（对象键排序），同样的输入一定得到同样的键。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** 缓存键：层名 + 版本 + 输入的 SHA-256（十六进制）。 */
export function evalCacheKey(layer: EvalCacheLayer, input: unknown): string {
  return createHash('sha256')
    .update(canonical({ layer, version: EVAL_CACHE.version, input }))
    .digest('hex');
}

/** 照记录的耗时等；等完 → true，中途被取消 → false。 */
export function replayLatency(
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 花费计量：基础客户端（精排、向量）把服务商回的 usage.cost 报到这里；不在 measureSpend 里 = 不记。
 * 大模型那一步的花费走链路事件（assistant/message 的 costUsd），不经这里。
 */
type SpendSink = { add(layer: 'embed' | 'rerank', usd: number): void };
const spendScope = new AsyncLocalStorage<SpendSink>();

export function reportSpend(layer: 'embed' | 'rerank', usd: unknown): void {
  if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0)
    spendScope.getStore()?.add(layer, usd);
}

/** 跑 fn，量出它里面报的花费（同时照样报给外层）。 */
export async function measureSpend<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; spent: { embed: number; rerank: number } }> {
  const parent = spendScope.getStore();
  const spent = { embed: 0, rerank: 0 };
  const value = await spendScope.run(
    {
      add(layer, usd) {
        spent[layer] += usd;
        parent?.add(layer, usd);
      },
    },
    fn,
  );
  return { value, spent };
}

/** 内存里的缓存（单测、评测脚本）；now 可换。 */
export function createMemoryEvalCacheStore(
  now: () => number = () => Date.now(),
): EvalCacheStore & {
  rows: Map<string, EvalCacheEntry & { at: number }>;
} {
  const rows = new Map<string, EvalCacheEntry & { at: number }>();
  const fresh = (at: number) => now() - at < EVAL_CACHE.ttlDays * 86_400_000;
  return {
    rows,
    get(layer, keys) {
      const found = new Map<string, EvalCacheEntry>();
      for (const key of keys) {
        const row = rows.get(`${layer}\n${key}`);
        if (row && fresh(row.at))
          found.set(key, {
            value: row.value,
            latencyMs: row.latencyMs,
            costUsd: row.costUsd,
          });
      }
      return Promise.resolve(found);
    },
    put(layer, entries) {
      for (const { key, entry } of entries)
        rows.set(`${layer}\n${key}`, { ...entry, at: now() });
      return Promise.resolve();
    },
    prune() {
      let removed = 0;
      for (const [key, row] of rows)
        if (!fresh(row.at)) {
          rows.delete(key);
          removed += 1;
        }
      return Promise.resolve(removed);
    },
  };
}
