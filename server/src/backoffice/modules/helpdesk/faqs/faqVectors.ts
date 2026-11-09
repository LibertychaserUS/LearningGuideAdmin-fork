import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';

import {
  HELPDESK_SETTINGS,
  readHelpdeskSetting,
} from '../../../../contracts/helpdesk-settings';
import {
  evalCacheKey,
  evalCacheScope,
  measureSpend,
  replayLatency,
  reportSpend,
} from '../../../../contracts/helpdesk-eval-cache';
import type { FaqNodeType } from '../../../../contracts/helpdesk-qa';
import { query, withTransaction } from '../../../lib/db';
import { FAQ_LIMITS, type HelpdeskFaq } from './faqContracts';
import type { FaqRepository, FaqSearch, SqlDb } from './faqRepository';

/**
 * FAQ 检索的向量层（RAG 基建，owner 2026-10-30 22:07Z：先把基建打好，人工过一遍卡片后再决定上不上）。
 *
 * HELPDESK_RETRIEVAL 缺省 / 不认识 = lexical（候选检索只用字词；向量走精排的召回池，见 ai/helpdesk/rerank.ts）。
 * 向量模型缺省 bge-m3（contracts/helpdesk-defaults.ts，owner 2026-11-03）；HELPDESK_EMBED_MODEL=off 或没有
 * OPENROUTER_API_KEY 就没有向量模型，发布时不算向量、检索时不调模型。两个都是每次现读（不用重新部署）。
 * - 发布版本的每个节点：英文问题、中文问题、每条学员问法（原文）各算一个向量；向量按 (模型, 文本哈希) 存一份，
 *   文本没变就不再算，所以以后新增或改了卡片，发布时只算改动的那几条（helpdesk_faq_embeddings）；
 *   某一版用到哪些文本记在 helpdesk_faq_release_vectors（迁移 20261031110000）。
 * - 不用 pgvector（CI 的 postgres:16 没有这个扩展）：向量存 REAL[]，按 (版本, 模型) 整批读进内存，单位化后点积；
 *   几千条文本，一次查询毫秒级。卡片多到上万再换 pgvector + HNSW，接口不变。
 * - 内存：至多留 loadedReleasesMax 版；向量按文本哈希放在共用池里，各版之间没改的文本共用一份，
 *   新一版只从库里读改过的文本。
 * - 检索：vector = 只按向量排；hybrid = 字词与向量两路各自排好，再用 RRF（Reciprocal Rank Fusion）合并。
 *   向量这一路失败、超时或这一版还没算好 → 退回字词检索，学员不会因为它拿不到候选。
 * - 节点的向量分数 = 它所有文本里和问题最像的那一条（问法多的卡不会因为多而吃亏或占便宜）。
 */

export type { RetrievalMode } from '../../../../contracts/helpdesk-settings';
import type { RetrievalMode } from '../../../../contracts/helpdesk-settings';

export const FAQ_VECTOR_LIMITS = {
  /** 每次请求至多这么多条文本（OpenRouter 的 embeddings 接口一次收一个数组）。 */
  batchMax: 64,
  /** 一个节点至多用这么多条问法（库里每条 FAQ 至多 30 条问法，FAQ_LIMITS.phrasingsMax）。 */
  phrasingsPerNode: FAQ_LIMITS.phrasingsMax,
  /** 学员的问题至多取这么多字算向量（和 v5 推荐给模型看的长度同一量级）。 */
  queryCharsMax: 600,
  /** 检索时等向量这一路至多这么久，过了就只用字词检索。 */
  queryTimeoutMs: 1_200,
  /**
   * 算问题向量的请求这么久还没回 → 再发一次，谁先回用谁（对冲请求）。慢的是对方的服务：2026-10-31
   * 实测 bge-m3 单次中位数 0.37–0.54 秒，忙的时候 95 分位 2.1 秒、17% 超过 queryTimeoutMs；
   * OpenRouter 上这个模型有两家提供方，第二次请求常落到另一家。
   */
  hedgeAfterMs: 500,
  /** 发布后算一整版向量的期限（650 张卡约 6,000 条文本，100 次请求）。 */
  indexTimeoutMs: 120_000,
  /** 学员问题的向量缓存条数（同一句话再问不再调模型）。 */
  queryCacheMax: 500,
  /**
   * 进程里至多同时留几版的向量（线上、候选、上一版）；更早的释放，再用到时从库里读。
   * 不设上限时每发一版、每检查一个候选版都多留一整版（685 张卡约 29 MB），直到重启。
   */
  loadedReleasesMax: 3,
  /** 某一版还没有向量时，隔这么久再去库里看一次。 */
  emptyRecheckMs: 60_000,
  /** RRF 的常数 k（文献里的常用值）。 */
  rrfK: 60,
} as const;

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

const defaultDb: SqlDb = {
  query: (sql, params) => query(sql, params),
  withTransaction: (fn) => withTransaction((client) => fn(client)),
};

const logger = new Logger('HelpdeskFaqVectors');

/** HELPDESK_RETRIEVAL：lexical（缺省）/ vector / hybrid；写错 = 缺省并告警。 */
export function retrievalMode(env: NodeJS.ProcessEnv): RetrievalMode {
  return readHelpdeskSetting(HELPDESK_SETTINGS.retrieval, env);
}

/* ---------------------------------- 文本 ---------------------------------- */

export type FaqVectorSource = 'question_en' | 'question_zh' | 'phrasing';
export type FaqVectorText = { source: FaqVectorSource; text: string };

/** 空白合成一个空格、去掉首尾；比较重复时再忽略大小写。 */
function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 一个节点要算向量的文本：英文问题、中文问题、问法（按给的顺序，至多 phrasingsPerNode 条）；去重、去空。 */
export function faqVectorTexts(node: {
  questionEn: string;
  questionZh: string;
  phrasings: readonly string[];
}): FaqVectorText[] {
  const out: FaqVectorText[] = [];
  const seen = new Set<string>();
  const add = (source: FaqVectorSource, raw: string) => {
    const text = clean(raw);
    const same = text.toLowerCase();
    if (text === '' || seen.has(same)) return;
    seen.add(same);
    out.push({ source, text });
  };
  add('question_en', node.questionEn);
  add('question_zh', node.questionZh);
  node.phrasings
    .slice(0, FAQ_VECTOR_LIMITS.phrasingsPerNode)
    .forEach((text) => add('phrasing', text));
  return out;
}

/** 文本的 sha256（十六进制）；同一模型下同一文本只存一个向量。 */
export function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/* ---------------------------------- 模型 ---------------------------------- */

export type FaqEmbedder = {
  readonly model: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
};

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * OpenRouter 的 embeddings 接口（OpenAI 兼容：POST {base}/embeddings，{ model, input }）。
 * HELPDESK_EMBED_MODEL=off 或没有 OPENROUTER_API_KEY → null（不算向量，也不检索向量）；没设 = 缺省模型。
 */
export function openRouterFaqEmbedder(
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike = fetch,
): FaqEmbedder | null {
  const model = readHelpdeskSetting(HELPDESK_SETTINGS.embedModel, env);
  const apiKey = env.OPENROUTER_API_KEY?.trim() ?? '';
  if (model === null || apiKey === '') return null;
  const baseUrl = (env.OPENROUTER_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  );
  return {
    model,
    async embed(texts, signal) {
      if (texts.length === 0) return [];
      const response = await fetchImpl(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, input: texts }),
        signal,
      });
      if (!response.ok) throw new Error(`embeddings: HTTP ${response.status}`);
      const body = (await response.json()) as {
        data?: { index?: number; embedding?: unknown }[];
        usage?: { cost?: unknown };
      };
      // 发布前检查里记进这一问的花费（学员问句的向量）；线上与建索引不在检查的一问里，不记
      reportSpend('embed', body.usage?.cost);
      const rows = [...(body.data ?? [])].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0),
      );
      if (rows.length !== texts.length)
        throw new Error(
          `embeddings: asked for ${texts.length}, got ${rows.length}`,
        );
      const vectors = rows.map((row) => row.embedding);
      const dims = Array.isArray(vectors[0]) ? vectors[0].length : 0;
      for (const vector of vectors)
        if (
          !Array.isArray(vector) ||
          vector.length === 0 ||
          vector.length !== dims ||
          !vector.every((x) => typeof x === 'number' && Number.isFinite(x))
        )
          throw new Error('embeddings: malformed vector');
      return vectors as number[][];
    },
  };
}

/**
 * 发布前检查用的问句向量缓存（契约 contracts/helpdesk-eval-cache.ts 的 embed 层）：键 = (模型, 文本)，
 * 值 = float32 的 base64。同一句话的向量每次问服务商都有 1e-4 级的抖动（2026-11-05 实测，换服务商也一样），
 * 记下来之后两次检查用的是同一个向量，比较才只反映卡片的改动。返回的向量一律是 float32 精度（命中与没命中一样）。
 * 不在检查的一问里（线上聊天、建索引）→ 原样交给 inner。
 */
export function cachedFaqEmbedder(inner: FaqEmbedder): FaqEmbedder {
  const encode = (vector: readonly number[]) =>
    Buffer.from(Float32Array.from(vector).buffer).toString('base64');
  const decode = (value: unknown): number[] | null => {
    if (typeof value !== 'string' || value === '') return null;
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length === 0 || bytes.length % 4 !== 0) return null;
    const floats = new Float32Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    );
    return floats.every((x) => Number.isFinite(x)) ? Array.from(floats) : null;
  };
  return {
    model: inner.model,
    async embed(texts, signal) {
      const scope = evalCacheScope();
      if (!scope || texts.length === 0) return inner.embed(texts, signal);
      const keys = texts.map((text) =>
        evalCacheKey('embed', { model: inner.model, text }),
      );
      const stats = scope.stats.embed;
      const known =
        scope.mode === 'use'
          ? await scope.store.get('embed', keys)
          : new Map<string, never>();
      const vectors = keys.map((key) => decode(known.get(key)?.value));
      const missing = vectors.flatMap((v, i) => (v === null ? [i] : []));
      if (missing.length === 0) {
        const entries = keys.map((key) => known.get(key)!);
        if (
          !(await replayLatency(
            Math.max(...entries.map((e) => e.latencyMs)),
            signal,
          ))
        )
          throw new Error('embeddings: aborted');
        stats.hits += 1;
        stats.savedUsd += entries.reduce((sum, e) => sum + e.costUsd, 0);
        return vectors as number[][];
      }
      stats.misses += 1;
      const started = performance.now();
      const { value: fresh, spent } = await measureSpend(() =>
        inner.embed(
          missing.map((i) => texts[i]),
          signal,
        ),
      );
      const latencyMs = Math.round(performance.now() - started);
      const rows = missing.map((i, at) => {
        const encoded = encode(fresh[at]);
        vectors[i] = decode(encoded);
        return {
          key: keys[i],
          entry: {
            value: encoded,
            latencyMs,
            costUsd: spent.embed / missing.length,
          },
        };
      });
      await scope.store.put('embed', rows).catch(() => undefined);
      return vectors as number[][];
    },
  };
}

/* ---------------------------------- 存储 ---------------------------------- */

export type FaqVectorNode = {
  id: string;
  questionEn: string;
  questionZh: string;
  phrasings: string[];
};

/** 节点在发布版本里的过滤字段（向量命中后先在内存里按检索条件过滤，不逐条查库）。 */
export type FaqVectorNodeMeta = {
  type: FaqNodeType;
  entry: boolean;
  category: string;
  popular: boolean;
};

export type FaqVectorStore = {
  /** 某一版的全部节点与它们的问法（问法取快照里的原文）。 */
  releaseNodes(release: number): Promise<FaqVectorNode[]>;
  /** 这些哈希里，这个模型还没有向量的。 */
  missing(model: string, hashes: readonly string[]): Promise<string[]>;
  save(
    model: string,
    rows: readonly { hash: string; text: string; vector: readonly number[] }[],
  ): Promise<void>;
  link(
    release: number,
    model: string,
    rows: readonly { nodeId: string; hash: string; source: FaqVectorSource }[],
  ): Promise<void>;
  /**
   * 某一版、某个模型的全部向量（每行一条文本，带文本哈希和节点的过滤字段）；还没算 → 空数组。
   * known = 调用方内存里已经有的文本哈希：这些行可以不带向量（空数组），调用方按哈希从内存取，
   * 新一版只从库里读改过的文本（各版之间没改的文本共用一份）。
   */
  load(
    release: number,
    model: string,
    known?: ReadonlySet<string>,
  ): Promise<
    ({ nodeId: string; hash?: string; vector: number[] } & FaqVectorNodeMeta)[]
  >;
};

export function createPgFaqVectorStore(db: SqlDb = defaultDb): FaqVectorStore {
  return {
    async releaseNodes(release) {
      const nodes = await db.query(
        `SELECT id, question_en, question_zh FROM helpdesk_faq_release_nodes
          WHERE release_version = $1 ORDER BY id`,
        [release],
      );
      const phrasings = await db.query(
        `SELECT p->>'faqId' AS faq_id, p->>'text' AS text
           FROM helpdesk_faq_releases r,
                jsonb_array_elements(COALESCE(r.snapshot->'phrasings', '[]'::jsonb)) WITH ORDINALITY AS t(p, n)
          WHERE r.version = $1
          ORDER BY t.n`,
        [release],
      );
      const byNode = new Map<string, string[]>();
      for (const row of phrasings) {
        const id = String(row.faq_id).toLowerCase();
        const list = byNode.get(id) ?? [];
        list.push(typeof row.text === 'string' ? row.text : '');
        byNode.set(id, list);
      }
      return nodes.map((row) => {
        const id = String(row.id);
        return {
          id,
          questionEn: String(row.question_en),
          questionZh: String(row.question_zh),
          phrasings: byNode.get(id) ?? [],
        };
      });
    },

    async missing(model, hashes) {
      if (hashes.length === 0) return [];
      const rows = await db.query(
        `SELECT h FROM unnest($2::text[]) AS h
          WHERE NOT EXISTS (SELECT 1 FROM helpdesk_faq_embeddings e
                             WHERE e.model = $1 AND e.text_hash = h)`,
        [model, [...hashes]],
      );
      return rows.map((row) => String(row.h));
    },

    async save(model, rows) {
      if (rows.length === 0) return;
      await db.query(
        `INSERT INTO helpdesk_faq_embeddings (model, text_hash, text, dims, embedding)
         SELECT $1, r.hash, r.text, cardinality(r.vector), r.vector
           FROM jsonb_to_recordset($2::jsonb) AS r(hash text, text text, vector real[])
         ON CONFLICT (model, text_hash) DO NOTHING`,
        [
          model,
          JSON.stringify(
            rows.map((row) => ({
              hash: row.hash,
              text: row.text,
              vector: `{${row.vector.join(',')}}`,
            })),
          ),
        ],
      );
    },

    async link(release, model, rows) {
      if (rows.length === 0) return;
      await db.query(
        `INSERT INTO helpdesk_faq_release_vectors (release_version, node_id, model, text_hash, source)
         SELECT $1, r.node_id::uuid, $2, r.hash, r.source
           FROM jsonb_to_recordset($3::jsonb) AS r(node_id text, hash text, source text)
         ON CONFLICT DO NOTHING`,
        [
          release,
          model,
          JSON.stringify(
            rows.map((row) => ({
              node_id: row.nodeId,
              hash: row.hash,
              source: row.source,
            })),
          ),
        ],
      );
    },

    async load(release, model, known) {
      // to_json：驱动按 JSON.parse 解析，比解析 REAL[] 的文本快约 4 倍（6,700 条向量 3.5 秒 → 0.8 秒）。
      // 内存里已有的哈希不再传向量（改一张卡的新一版只读几十条）。
      const rows = await db.query(
        `SELECT v.node_id, v.text_hash,
                CASE WHEN v.text_hash = ANY($3::text[]) THEN NULL ELSE to_json(e.embedding) END AS embedding,
                n.node_type, n.entry, n.category, n.popular
           FROM helpdesk_faq_release_vectors v
           JOIN helpdesk_faq_embeddings e
             ON e.model = v.model AND e.text_hash = v.text_hash
           JOIN helpdesk_faq_release_nodes n
             ON n.release_version = v.release_version AND n.id = v.node_id
          WHERE v.release_version = $1 AND v.model = $2`,
        [release, model, [...(known ?? [])]],
      );
      return rows.map((row) => ({
        nodeId: String(row.node_id),
        hash: String(row.text_hash),
        vector: Array.isArray(row.embedding)
          ? (row.embedding as unknown[]).map(Number)
          : [],
        type: row.node_type as FaqNodeType,
        entry: Boolean(row.entry),
        category: String(row.category),
        popular: Boolean(row.popular),
      }));
    },
  };
}

/* ---------------------------------- 建索引 ---------------------------------- */

export type FaqVectorIndexReport = {
  release: number;
  model: string;
  nodes: number;
  texts: number;
  /** 这次新算的文本条数（其余用库里已有的向量）。 */
  embedded: number;
};

/**
 * 给一个发布版本算向量（幂等）：只算库里还没有的文本，再把这一版的节点和文本连起来。
 * 连接在最后一次写完，读的一方要么看到完整的一版，要么一条也看不到（退回字词检索）。
 */
export async function indexFaqRelease(input: {
  store: FaqVectorStore;
  embedder: FaqEmbedder;
  release: number;
  signal?: AbortSignal;
}): Promise<FaqVectorIndexReport> {
  const { store, embedder, release } = input;
  const nodes = await store.releaseNodes(release);
  const links: { nodeId: string; hash: string; source: FaqVectorSource }[] = [];
  const textOf = new Map<string, string>();
  for (const node of nodes)
    for (const item of faqVectorTexts(node)) {
      const hash = textHash(item.text);
      textOf.set(hash, item.text);
      links.push({ nodeId: node.id, hash, source: item.source });
    }
  const missing = await store.missing(embedder.model, [...textOf.keys()]);
  for (let i = 0; i < missing.length; i += FAQ_VECTOR_LIMITS.batchMax) {
    input.signal?.throwIfAborted();
    const hashes = missing.slice(i, i + FAQ_VECTOR_LIMITS.batchMax);
    const texts = hashes.map((hash) => textOf.get(hash) as string);
    const vectors = await embedder.embed(texts, input.signal);
    await store.save(
      embedder.model,
      hashes.map((hash, j) => ({ hash, text: texts[j], vector: vectors[j] })),
    );
  }
  await store.link(release, embedder.model, links);
  return {
    release,
    model: embedder.model,
    nodes: nodes.length,
    texts: textOf.size,
    embedded: missing.length,
  };
}

/* ---------------------------------- 检索 ---------------------------------- */

/** 单位化（模长 1）；全零向量原样返回（和谁的点积都是 0）。 */
function unit(vector: readonly number[]): Float32Array {
  const out = Float32Array.from(vector);
  let norm = 0;
  for (const x of out) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export type FaqVectorHit = {
  id: string;
  similarity: number;
} & FaqVectorNodeMeta;

export type FaqVectorSearch = {
  /** 这一版全部节点按和问题的相似度从高到低；没有模型、这一版还没算好、调用失败 → null。 */
  rank(
    release: number,
    text: string,
    signal?: AbortSignal,
  ): Promise<FaqVectorHit[] | null>;
  /** 先把这一版的向量读进内存（启动时调；不算问题向量）。没有模型 → 什么都不做。 */
  warm?(release: number): Promise<void>;
  /** 内存占用：留着几版、共几条不同的向量、约多少字节（报告和监控用）。 */
  memory?(): FaqVectorMemory;
  /**
   * 同一份内存索引，只是问句向量经 wrap 包过的模型算（发布前检查的缓存，cachedFaqEmbedder）：
   * 不另读一份卡片向量，也不和线上共用问句向量的内存表。
   */
  withEmbedder?(wrap: (embedder: FaqEmbedder) => FaqEmbedder): FaqVectorSearch;
  /**
   * 这一版每条文本的向量（单位化；就是内存索引里那一份，不复制）：发布前的重复问法检查用。
   * 没有模型、这一版还没算好 → null。
   */
  texts?(release: number): Promise<FaqVectorTextRow[] | null>;
};

export type FaqVectorTextRow = {
  nodeId: string;
  hash: string;
  vector: Float32Array;
};

export type FaqVectorMemory = {
  releases: number;
  vectors: number;
  bytes: number;
};

/**
 * 对冲请求：先发一次；afterMs 内没回、或者先失败了，再发第二次（至多两次）。谁先成功用谁，
 * 另一个取消；两次都失败 → 第二次的错误；外面取消 → 两个都取消。
 */
export function hedgedCall<T>(
  run: (signal: AbortSignal) => Promise<T>,
  afterMs: number,
  outer?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controllers: AbortController[] = [];
    let settled = false;
    let failures = 0;
    const stop = () => {
      settled = true;
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
      for (const controller of controllers) controller.abort();
    };
    function onAbort() {
      if (settled) return;
      stop();
      reject(outer?.reason as Error);
    }
    function start() {
      if (settled || controllers.length === 2) return;
      const controller = new AbortController();
      controllers.push(controller);
      run(controller.signal).then(
        (value) => {
          if (settled) return;
          stop();
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          failures += 1;
          if (failures === 2) {
            stop();
            reject(error instanceof Error ? error : new Error(String(error)));
          } else start();
        },
      );
    }
    if (outer?.aborted) {
      reject(outer.reason as Error);
      return;
    }
    outer?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(start, afterMs);
    timer.unref?.();
    start();
  });
}

export function createFaqVectorSearch(deps: {
  store: FaqVectorStore;
  embedder: () => FaqEmbedder | null;
  now?: () => number;
  hedgeAfterMs?: number;
}): FaqVectorSearch {
  const now = deps.now ?? (() => Date.now());
  const hedgeAfterMs = deps.hedgeAfterMs ?? FAQ_VECTOR_LIMITS.hedgeAfterMs;
  type Loaded = {
    nodes: ({
      id: string;
      vectors: Float32Array[];
      /** 和 vectors 一一对应的文本哈希（行没带哈希 = null）。 */
      hashes: (string | null)[];
    } & FaqVectorNodeMeta)[];
    at: number;
    /** 这一版在共用池里占着的向量（释放这一版时归还）。 */
    pooled: string[];
    /** 不带哈希的行（不进池）占的字节。 */
    loose: number;
  };
  /**
   * 留在内存里的版本，按最近使用排（Map 的插入顺序，用到就挪到最后）；至多 loadedReleasesMax 版。
   * 读完之前就占位，同一版并发的检索只读一次库。
   */
  const indexes = new Map<string, Promise<Loaded>>();
  /** 已经读完的版本，用来在调模型之前同步判断「这一版还没有向量」。 */
  const ready = new Map<string, Loaded>();
  const queries = new Map<string, Float32Array>();
  /**
   * 共用的向量池：键 = 模型 + 文本哈希（和库里一样按内容寻址）。各版之间没改的文本指向同一个数组，
   * 留 3 版也只比 1 版多改过的那几条。refs = 有几版在用；归零就删（正在算的检索手里的引用不受影响）。
   */
  const pool = new Map<string, { vector: Float32Array; refs: number }>();

  function poolKey(model: string, hash: string): string {
    return `${model}\n${hash}`;
  }

  function releasePooled(loaded: Loaded): void {
    for (const key of loaded.pooled) {
      const entry = pool.get(key);
      if (!entry) continue;
      entry.refs -= 1;
      if (entry.refs <= 0) pool.delete(key);
    }
    loaded.pooled = [];
  }

  /** 从内存里去掉一版（读完的马上归还向量；还在读的读完时自己归还）。 */
  function forget(key: string): void {
    indexes.delete(key);
    const loaded = ready.get(key);
    ready.delete(key);
    if (loaded) releasePooled(loaded);
  }

  function touch(key: string): void {
    const value = indexes.get(key);
    if (value === undefined) return;
    indexes.delete(key);
    indexes.set(key, value);
  }

  function evict(): void {
    while (indexes.size > FAQ_VECTOR_LIMITS.loadedReleasesMax) {
      const oldest = indexes.keys().next().value as string;
      forget(oldest);
    }
  }

  /** 把一版的行变成节点；某行没带向量、池里也没有（读的时候被别的版释放了）→ null，整版重读。 */
  function build(
    model: string,
    rows: Awaited<ReturnType<FaqVectorStore['load']>>,
  ): Loaded | null {
    const byNode = new Map<string, Loaded['nodes'][number]>();
    const pooled: string[] = [];
    let loose = 0;
    for (const row of rows) {
      let vector: Float32Array;
      if (row.hash === undefined) {
        vector = unit(row.vector);
        loose += vector.byteLength;
      } else {
        const key = poolKey(model, row.hash);
        let entry = pool.get(key);
        if (!entry) {
          if (row.vector.length === 0) {
            releasePooled({ nodes: [], at: 0, pooled, loose: 0 });
            return null;
          }
          entry = { vector: unit(row.vector), refs: 0 };
          pool.set(key, entry);
        }
        entry.refs += 1;
        pooled.push(key);
        vector = entry.vector;
      }
      const node = byNode.get(row.nodeId) ?? {
        id: row.nodeId,
        vectors: [],
        hashes: [],
        type: row.type,
        entry: row.entry,
        category: row.category,
        popular: row.popular,
      };
      node.vectors.push(vector);
      node.hashes.push(row.hash ?? null);
      byNode.set(row.nodeId, node);
    }
    return { nodes: [...byNode.values()], at: now(), pooled, loose };
  }

  async function read(release: number, model: string): Promise<Loaded> {
    const prefix = poolKey(model, '');
    const known = new Set<string>();
    for (const key of pool.keys())
      if (key.startsWith(prefix)) known.add(key.slice(prefix.length));
    const first = build(model, await deps.store.load(release, model, known));
    if (first) return first;
    return build(model, await deps.store.load(release, model)) as Loaded;
  }

  /** 这一版刚读过、确实没有向量（还没到再看的时候）。 */
  function knownEmpty(release: number, model: string): boolean {
    const loaded = ready.get(`${release}\n${model}`);
    return (
      loaded !== undefined &&
      loaded.nodes.length === 0 &&
      now() - loaded.at < FAQ_VECTOR_LIMITS.emptyRecheckMs
    );
  }

  async function index(release: number, model: string): Promise<Loaded> {
    const key = `${release}\n${model}`;
    const cached = indexes.get(key);
    if (cached) {
      touch(key);
      const loaded = await cached;
      // 空的（这一版还没算好）隔一会儿再看；算好了的一直用（发布版本不会再变）
      if (
        loaded.nodes.length > 0 ||
        now() - loaded.at < FAQ_VECTOR_LIMITS.emptyRecheckMs
      )
        return loaded;
      if (indexes.get(key) === cached) forget(key);
    }
    const loading = read(release, model);
    indexes.set(key, loading);
    evict();
    loading.then(
      (loaded) => {
        // 读的时候已经被挤出去（或被重读替换）→ 不留，马上归还
        if (indexes.get(key) === loading) ready.set(key, loaded);
        else releasePooled(loaded);
      },
      () => {
        if (indexes.get(key) === loading) indexes.delete(key);
      },
    );
    return loading;
  }

  async function queryVector(
    embedder: FaqEmbedder,
    text: string,
    signal: AbortSignal | undefined,
    remember: boolean,
  ): Promise<Float32Array> {
    const key = `${embedder.model}\n${text}`;
    const cached = remember ? queries.get(key) : undefined;
    if (cached) return cached;
    const [vector] = await hedgedCall(
      (attempt) => embedder.embed([text], attempt),
      hedgeAfterMs,
      signal,
    );
    const value = unit(vector);
    if (!remember) return value;
    if (queries.size >= FAQ_VECTOR_LIMITS.queryCacheMax)
      queries.delete(queries.keys().next().value as string);
    queries.set(key, value);
    return value;
  }

  /** wrap 给了 = 问句向量换一个来源（发布前检查的缓存）；不用、也不写进线上的问句向量表。 */
  async function rank(
    release: number,
    raw: string,
    signal: AbortSignal | undefined,
    wrap?: (embedder: FaqEmbedder) => FaqEmbedder,
  ): Promise<FaqVectorHit[] | null> {
    const base = deps.embedder();
    const text = clean(raw).slice(0, FAQ_VECTOR_LIMITS.queryCharsMax);
    if (!base || text === '' || knownEmpty(release, base.model)) return null;
    // 读这一版的向量与算问题向量同时做（刚启动或刚发布时，读一版约 1 秒）
    const loading = index(release, base.model);
    const embedding = queryVector(
      wrap ? wrap(base) : base,
      text,
      signal,
      !wrap,
    );
    embedding.catch(() => undefined); // 这一版没有向量就先返回了，别留下没处理的失败
    const loaded = await loading;
    if (loaded.nodes.length === 0) return null;
    const query = await embedding;
    return loaded.nodes
      .map((node) => ({
        id: node.id,
        type: node.type,
        entry: node.entry,
        category: node.category,
        popular: node.popular,
        similarity: Math.max(...node.vectors.map((v) => dot(query, v))),
      }))
      .sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : 1));
  }

  async function texts(release: number): Promise<FaqVectorTextRow[] | null> {
    const base = deps.embedder();
    if (!base) return null;
    const loaded = await index(release, base.model);
    if (loaded.nodes.length === 0) return null;
    const out: FaqVectorTextRow[] = [];
    for (const node of loaded.nodes)
      node.vectors.forEach((vector, i) => {
        const hash = node.hashes[i];
        if (hash) out.push({ nodeId: node.id, hash, vector });
      });
    return out;
  }

  return {
    rank: (release, raw, signal) => rank(release, raw, signal),
    withEmbedder: (wrap) => ({
      rank: (release, raw, signal) => rank(release, raw, signal, wrap),
      texts,
    }),
    texts,
    async warm(release) {
      const embedder = deps.embedder();
      if (!embedder) return;
      // 线上版本发布时还没开向量（或换了向量模型）：启动时把缺的补算上（按文本哈希，算过的不再算；
      // 写入都是 ON CONFLICT DO NOTHING，几台同时启动也没事），部署不用手动跑 helpdesk:faq-vectors
      await indexFaqRelease({
        store: deps.store,
        embedder,
        release,
        signal: AbortSignal.timeout(FAQ_VECTOR_LIMITS.indexTimeoutMs),
      });
      forget(`${release}\n${embedder.model}`);
      await index(release, embedder.model);
    },
    memory() {
      let bytes = 0;
      for (const { vector } of pool.values()) bytes += vector.byteLength;
      for (const loaded of ready.values()) bytes += loaded.loose;
      return { releases: ready.size, vectors: pool.size, bytes };
    },
  };
}

/** RRF：每一路里排第 r 名（从 1 起）得 1 / (k + r)，各路相加。 */
export function reciprocalRankFusion(
  rankings: readonly (readonly string[])[],
  k: number = FAQ_VECTOR_LIMITS.rrfK,
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const ranking of rankings)
    ranking.forEach((id, index) =>
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + index + 1)),
    );
  return fused;
}

/**
 * 包一层检索仓库：searchPublished 按模式走字词 / 向量 / 混合，其余方法原样。
 * 只对发布版本生效（向量按版本算）；第一版发布之前、lexical、没有模型、向量失败或超时 → 原来的字词检索。
 * 向量命中、字词没命中的节点按 id 读出来，过滤条件和字词检索一样（入口、节点类型、分类、热门）。
 * 分数：hybrid / vector 时是 RRF 分（只用来排序；放大 1000 倍免得全是很小的小数）。
 */
export function withFaqVectorSearch(
  base: FaqRepository,
  deps: {
    vectors: FaqVectorSearch;
    mode: () => RetrievalMode;
    timeoutMs?: number;
    onError?: (error: unknown) => void;
  },
): FaqRepository {
  const timeoutMs = deps.timeoutMs ?? FAQ_VECTOR_LIMITS.queryTimeoutMs;

  async function vectorRanking(
    search: FaqSearch,
  ): Promise<FaqVectorHit[] | null> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<null>((resolve) => {
      // 先定下结果（null）再取消，取消时才回来的结果不会被用上
      timer = setTimeout(() => {
        resolve(null);
        controller.abort();
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        deps.vectors.rank(
          search.release as number,
          search.text,
          controller.signal,
        ),
        timedOut,
      ]);
    } catch (error) {
      deps.onError?.(error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 和字词检索同样的过滤：入口、节点类型、分类、热门（发布版本里的节点都是 published）。 */
  function keeps(hit: FaqVectorNodeMeta, search: FaqSearch): boolean {
    if ((search.entryOnly ?? true) && !hit.entry) return false;
    if (!(search.types ?? ['answer']).includes(hit.type)) return false;
    if (search.category !== undefined && hit.category !== search.category)
      return false;
    if (search.popular !== undefined && hit.popular !== search.popular)
      return false;
    return true;
  }

  return {
    ...base,
    async searchPublished(search) {
      const mode = deps.mode();
      const release = search.release ?? null;
      if (mode === 'lexical' || release === null || search.text.trim() === '')
        return base.searchPublished(search);
      const limit = Math.min(
        Math.max(1, Math.floor(search.limit)),
        FAQ_LIMITS.publicLimitMax,
      );
      const [lexical, ranked] = await Promise.all([
        base.searchPublished(search),
        vectorRanking(search),
      ]);
      if (!ranked) return lexical;
      const byId = new Map<string, HelpdeskFaq>(
        lexical.map((faq) => [faq.id, faq]),
      );
      // 向量这一路：按相似度取前 limit 个符合过滤条件的节点
      const vectorIds = ranked
        .filter((hit) => keeps(hit, search))
        .slice(0, limit)
        .map((hit) => hit.id);
      const fused = [
        ...reciprocalRankFusion(
          mode === 'vector'
            ? [vectorIds]
            : [lexical.map((faq) => faq.id), vectorIds],
        ),
      ]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, limit);
      // 只有向量命中、字词没命中的节点才按 id 读一次（并行）
      await Promise.all(
        fused
          .filter(([id]) => !byId.has(id))
          .map(async ([id]) => {
            const row = await base.getPublished(id, { release });
            if (row) byId.set(id, row);
          }),
      );
      return fused.flatMap(([id, score]) => {
        const faq = byId.get(id);
        return faq
          ? [{ ...faq, score: Math.round(score * 1000 * 1e4) / 1e4 }]
          : [];
      });
    },
  };
}

/** 错误只记一行（不带学员文字；模型返回的错误截到 200 字）。 */
export function vectorErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'error';
}

/** 检索时向量这一路失败：记一行警告，这一次退回字词检索。 */
export function logFaqVectorSearchError(error: unknown): void {
  logger.warn(
    `helpdesk faq vectors: search fell back to lexical: ${vectorErrorMessage(error)}`,
  );
}

/** 启动时把上线版本的向量读进内存；失败只记一行（之后第一次检索会再读）。 */
export async function warmFaqVectors(
  vectors: FaqVectorSearch,
  release: () => Promise<number | null>,
): Promise<void> {
  try {
    const version = await release();
    if (version !== null) await vectors.warm?.(version);
  } catch (error) {
    logger.warn(
      `helpdesk faq vectors: warm-up failed: ${vectorErrorMessage(error)}`,
    );
  }
}

/** 生产组装：每次现读环境变量的向量检索（没有模型 = 不检索向量）。 */
export function createEnvFaqVectorSearch(
  db: SqlDb = defaultDb,
  env: () => NodeJS.ProcessEnv = () => process.env,
): FaqVectorSearch {
  return createFaqVectorSearch({
    store: createPgFaqVectorStore(db),
    embedder: () => openRouterFaqEmbedder(env()),
  });
}

let shared: FaqVectorSearch | null = null;

/**
 * 进程里共用的一份（默认库、现读环境变量）：线上检索与后台审核页读同一份内存索引，
 * 一版向量约 6,700 条 × 1,024 维，不要各读一份。
 */
export function sharedFaqVectorSearch(): FaqVectorSearch {
  shared ??= createEnvFaqVectorSearch();
  return shared;
}

/**
 * 发布后给新版本算向量（不等它、不影响发布结果）。没有模型 = 什么都不做；失败只记日志，
 * 下一次发布或手动跑 npm run helpdesk:faq-vectors 会补上（幂等）。
 */
export type FaqVectorIndexer = {
  index(release: number): Promise<FaqVectorIndexReport | null>;
};

export function createEnvFaqVectorIndexer(
  db: SqlDb = defaultDb,
  env: () => NodeJS.ProcessEnv = () => process.env,
  log: (message: string) => void = (message) => logger.warn(message),
): FaqVectorIndexer {
  const store = createPgFaqVectorStore(db);
  return {
    async index(release) {
      const embedder = openRouterFaqEmbedder(env());
      if (!embedder) return null;
      try {
        return await indexFaqRelease({
          store,
          embedder,
          release,
          signal: AbortSignal.timeout(FAQ_VECTOR_LIMITS.indexTimeoutMs),
        });
      } catch (error) {
        log(
          `helpdesk faq vectors: release ${release} not indexed: ${vectorErrorMessage(error)}`,
        );
        return null;
      }
    },
  };
}
