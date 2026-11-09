import {
  FAQ_NODE_TYPES,
  FAQ_SIGNALS,
  type FaqCategory,
  type FaqNodeType,
  type FaqSignal,
} from '../../../../contracts/helpdesk-qa';
import { query, withTransaction } from '../../../lib/db';
import {
  FAQ_LIMITS,
  type FaqRevision,
  type FaqRevisionAction,
  type FaqStatus,
  type HelpdeskFaq,
} from './faqContracts';
import { chineseSearchForms, typoKeys } from './faqSearchText';
import { uuidv7 } from '../../../../common/uuidv7';

/**
 * Helpdesk FAQ 的 PostgreSQL 读写（Tickets v2 §1）。BackOffice 惯例：原生 SQL，与 Prisma 共用
 * DATABASE_URL。
 * - 每次修改：UPDATE … WHERE id AND version（不一致 → conflict，什么都不改）；
 * - 修订行（完整快照）与修改在同一事务里写入（失败一起回滚）；
 * - 新建可带 Idempotency-Key：同一个 key 只建一条；
 * - 候选检索（Agent 推荐与 Help Centre 搜索共用，§2）：英文全文（english 配置，GIN 索引，前缀匹配）+
 *   关键词（整句包含关键词，或词是关键词的前缀）+ 中文双字重叠（问题与答案），同类 ×1.25。
 */

type Row = Record<string, unknown>;

export type SqlClient = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Row[]; rowCount?: number | null }>;
};

export type SqlDb = {
  query: (sql: string, params?: readonly unknown[]) => Promise<Row[]>;
  withTransaction: <T>(fn: (client: SqlClient) => Promise<T>) => Promise<T>;
};

/** 进程共用的连接池（lib/db）。写入流水线用它开事务，仓库缺省也用它。 */
export const pgSqlDb: SqlDb = {
  query: (sql, params) => query<Row>(sql, params),
  withTransaction: (fn) => withTransaction((client) => fn(client)),
};

/** 员工端列表：只看已发布（归档 = 已删除，不显示）。 */
export type FaqFilter = {
  category?: FaqCategory;
  popular?: boolean;
  /** 两种语言的问题、答案与关键词里包含（不区分大小写）。 */
  q?: string;
  offset: number;
  limit: number;
};

/**
 * 读哪一份已发布内容（helpdesk-v5-faq-graph-design §2.2）：null / 不给 = 工作表里逐条发布的行
 * （第一版发布之前）；数字 = 那个发布版本的快照（helpdesk_faq_release_nodes）。
 */
export type FaqReadScope = { release?: number | null };

/**
 * 节点过滤（v5 问题树）：entryOnly 缺省 true（只要入口节点；false = 也要只能经边到达的追问），
 * types 缺省 ['answer']（choice 节点只在明确要时给）。旧数据全是 answer + entry，行为不变。
 */
export type FaqNodeFilter = {
  entryOnly?: boolean;
  types?: readonly FaqNodeType[];
};

export type PublishedFilter = FaqReadScope &
  FaqNodeFilter & {
    category?: FaqCategory;
    popular?: boolean;
    /** 这一类排在前面（热门之后、更新时间之前）；不给不分先后（v3 §1 你可能想问）。 */
    boost?: FaqCategory | null;
    /** 不要这些 id。 */
    excludeIds?: string[];
    limit: number;
  };

export type FaqSearch = FaqReadScope &
  FaqNodeFilter & {
    locale: string;
    /** 同类加权；null 不加权。 */
    boost: FaqCategory | null;
    text: string;
    limit: number;
    /** 只要这一类（Help Centre 的 ?category= 搜索）。 */
    category?: FaqCategory;
    popular?: boolean;
  };

export type ScoredFaq = HelpdeskFaq & { score: number };

/** 可修改的列（服务层决定改哪些）。 */
export type FaqPatch = Partial<
  Pick<
    HelpdeskFaq,
    | 'key'
    | 'type'
    | 'entry'
    | 'category'
    | 'popular'
    | 'popularRank'
    | 'questionEn'
    | 'answerEn'
    | 'questionZh'
    | 'answerZh'
    | 'keywords'
    | 'signals'
    | 'status'
  >
>;

export type WriteResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'not_found' }
  | { kind: 'conflict'; currentVersion: number }
  /** 归档时还有已发布的父节点在用它（在同一事务里、锁住这一行之后查的）。 */
  | { kind: 'has_parents' };

export type FaqRepository = {
  list: (filter: FaqFilter) => Promise<{ faqs: HelpdeskFaq[]; total: number }>;
  get: (id: string) => Promise<HelpdeskFaq | null>;
  /** created=false：同一个 Idempotency-Key 已建过，返回那一条（不再写修订）。 */
  insert: (
    faq: HelpdeskFaq,
    employeeId: string | null,
    idempotencyKey: string | null,
  ) => Promise<{ faq: HelpdeskFaq; created: boolean }>;
  update: (
    id: string,
    expectedVersion: number,
    patch: FaqPatch,
    action: FaqRevisionAction,
    employeeId: string | null,
  ) => Promise<WriteResult<HelpdeskFaq>>;
  revisions: (id: string) => Promise<FaqRevision[]>;
  /** Portal 列表（无搜索词）：热门在前（给了 boost 再同类在前），再按更新时间倒序。 */
  listPublished: (filter: PublishedFilter) => Promise<HelpdeskFaq[]>;
  /** 候选检索（推荐与 Help Centre 搜索共用）：按相关度排序。 */
  searchPublished: (search: FaqSearch) => Promise<ScoredFaq[]>;
  /** 按 key 取一条（含已归档；种子脚本按 key 幂等）。 */
  getByKey: (key: string) => Promise<HelpdeskFaq | null>;
  /** 已发布的一条（scope 同上；任何节点类型，不管 entry）；没有 / 已归档 → null。 */
  getPublished: (
    id: string,
    scope?: FaqReadScope,
  ) => Promise<HelpdeskFaq | null>;
};

const COLUMNS = `id, key, node_type, entry, category, popular, popular_rank, question_en, answer_en,
  question_zh, answer_zh, keywords, signals, status, version, created_by, updated_by,
  created_at, updated_at`;
/** 员工端读卡的列（FAQ 审核队列 faqReview.ts 复用，和 toFaq 配套）。 */
export const FAQ_COLUMNS = COLUMNS;

const PATCH_COLUMNS: Record<keyof FaqPatch, string> = {
  key: 'key',
  type: 'node_type',
  entry: 'entry',
  category: 'category',
  popular: 'popular',
  popularRank: 'popular_rank',
  questionEn: 'question_en',
  answerEn: 'answer_en',
  questionZh: 'question_zh',
  answerZh: 'answer_zh',
  keywords: 'keywords',
  signals: 'signals',
  status: 'status',
};

/** 节点类型过滤的缺省：只要 answer（choice 节点只在明确要时给，旧的 Portal 不认）。 */
const DEFAULT_TYPES: readonly FaqNodeType[] = ['answer'];

/** text[] 列（参数要显式转型）。 */
const ARRAY_COLUMNS: readonly (keyof FaqPatch)[] = ['keywords', 'signals'];

/** 读出的信号：只留认识的，按 chip 优先级排（与写入时一致）。 */
function signalsOf(value: unknown): FaqSignal[] {
  if (!Array.isArray(value)) return [];
  const stored = new Set(value.map(String));
  return FAQ_SIGNALS.filter((signal) => stored.has(signal));
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : '';
}

function nodeTypeOf(value: unknown): FaqNodeType {
  return (FAQ_NODE_TYPES as readonly unknown[]).includes(value)
    ? (value as FaqNodeType)
    : 'answer';
}

function rankOf(value: unknown): number | null {
  const rank = Number(value);
  return value === null || value === undefined || !Number.isInteger(rank)
    ? null
    : rank;
}

export function toFaq(row: Row): HelpdeskFaq {
  return {
    id: String(row.id),
    key: typeof row.key === 'string' ? row.key : '',
    type: nodeTypeOf(row.node_type),
    entry: row.entry !== false,
    category: row.category as FaqCategory,
    popular: row.popular === true,
    popularRank: rankOf(row.popular_rank),
    questionEn: String(row.question_en),
    answerEn: String(row.answer_en),
    questionZh: String(row.question_zh),
    answerZh: String(row.answer_zh),
    keywords: Array.isArray(row.keywords) ? row.keywords.map(String) : [],
    signals: signalsOf(row.signals),
    status: row.status as FaqStatus,
    version: Number(row.version),
    createdBy: (row.created_by as string | null) ?? null,
    updatedBy: (row.updated_by as string | null) ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toRevision(row: Row): FaqRevision {
  return {
    id: String(row.id),
    faqId: String(row.faq_id),
    version: Number(row.version),
    action: row.action as FaqRevisionAction,
    employeeId: (row.employee_id as string | null) ?? null,
    at: iso(row.at),
    snapshot: (row.snapshot as Record<string, unknown>) ?? {},
  };
}

async function writeRevision(
  client: SqlClient,
  faq: HelpdeskFaq,
  action: FaqRevisionAction,
  employeeId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO helpdesk_faq_revisions
       (id, faq_id, version, snapshot, action, employee_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [uuidv7(), faq.id, faq.version, JSON.stringify(faq), action, employeeId],
  );
}

/** LIKE 通配符转义（\ % _）。 */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const HAN = /\p{Script=Han}/u;

/**
 * 学员原文 / 搜索词 → 英文全文检索词（只含字母数字，前缀匹配，OR 连接）、关键词前缀用的词
 * （≥3 字）、中文双字片段（取自简体与普通话改写，见 faqSearchText.ts）与关键词包含用的
 * 小写全文（原文 + 简体 + 普通话改写，繁体关键词和简体关键词都认），以及英文拼写容错的
 * 查询键（typoKeys：键与它来自第几个词）。只含字母数字，所以永远不会构成 tsquery 语法。
 */
export function searchTerms(text: string): {
  tsquery: string;
  words: string[];
  bigrams: string[];
  body: string;
  typo: { keys: string[]; word: number[] };
} {
  const lower = text.normalize('NFKC').toLowerCase();
  const words = [
    ...new Set(
      (lower.match(/[\p{L}\p{N}]+/gu) ?? []).filter(
        (word) => word.length >= 2 && !HAN.test(word),
      ),
    ),
  ].slice(0, 32);
  const forms = chineseSearchForms(lower);
  const bigrams = new Set<string>();
  for (const form of forms) {
    for (const run of form.match(/\p{Script=Han}+/gu) ?? []) {
      const chars = [...run];
      for (let i = 0; i + 1 < chars.length; i++) {
        bigrams.add(chars[i] + chars[i + 1]);
      }
    }
  }
  return {
    tsquery: words.map((word) => `${word}:*`).join(' | '),
    words: words.filter((word) => word.length >= 3),
    bigrams: [...bigrams].slice(0, 40),
    body: [...new Set([lower, ...forms])].join('\n'),
    typo: typoKeys(words),
  };
}

/**
 * 候选检索。to_tsvector('english', question_en || ' ' || answer_en) 必须与迁移里的
 * helpdesk_faqs_search_en_idx 表达式一字不差（helpdesk-faqs-search-index.spec.ts 锁定）。
 * 先按五路取命中的行再打分：
 * - 英文全文：WHERE 就是索引表达式 @@ to_tsquery($3)（直接写在 WHERE 里，规划器按实参估算才会选
 *   GIN 索引；helpdesk-faqs-repository.pg.spec.ts 对本条 SQL 做 EXPLAIN 锁定）；不看界面语言
 *   （中文句子里的英文词也算）。只有这一路命中的行才算 ts_rank：问题（标题）权重 1.0、答案 0.05，
 *   再乘 2（用户 2026-11-03「应该匹配标题」；S650 英文第 1 名命中 41% → 49%，中文不变）；
 * - 拼写容错：生成列 typo_keys 与查询键有交集（GIN 索引，迁移 20261029150000）；
 * - 关键词：整句包含关键词，或词是关键词的前缀（扫已发布的行）；
 * - 中文双字：问题、答案或学员问法里出现（扫已发布的行，一遍同时得到每个双字的文档频率与每行的命中）。
 *   双字按 IDF 加权：w = ln((N + 1) / df) / ln(N + 1)，只在 1 篇里出现 = 1，篇篇都有 → 接近 0；
 *   只靠 w < 0.1 的双字（「怎么」「可以」这种几乎篇篇都有的）不算命中，所以 FAQ 多了以后
 *   不会把整个库都拉进来打分；
 * - 学员问法（v5 问题树，helpdesk_faq_phrasings）：英文全文（生成列 phrasing_tsv）与中文双字，
 *   加问法以后不用改答案就能改善匹配。
 * 参数：$1 locale、$2 加权分类（'' = 不加权）、$3 tsquery、$4 小写原文（含简体 / 普通话改写）、
 * $5 双字、$6 条数、$7 只要此分类（NULL = 不限）、$8 只要热门 / 非热门（NULL = 不限）、
 * $9 关键词前缀用的词、$10 拼写容错键、$11 每个键来自第几个词、$12 只要入口节点、$13 节点类型；
 * 发布版本（candidatesSql('release')）再加 $14 版本号：同一条 SQL，只是读那一版的检索行。
 */
export function candidatesSql(source: 'live' | 'release'): string {
  const table =
    source === 'live' ? 'helpdesk_faqs' : 'helpdesk_faq_release_nodes';
  const scope =
    source === 'live'
      ? `f.status = 'published'`
      : `f.status = 'published' AND f.release_version = $14::int`;
  return `
WITH input AS (
  SELECT CASE WHEN $3 = '' THEN NULL ELSE to_tsquery('english', $3) END AS tsq,
         $4::text AS body,
         -- 词是关键词里某个词的前缀：一个正则（每条查询只编译一次），词只含字母数字
         CASE WHEN cardinality($9::text[]) > 0
              THEN '(^|[[:space:]])(' || array_to_string($9::text[], '|') || ')' END AS word_prefix
), published AS (
  SELECT count(*)::float8 AS total FROM ${table} f WHERE ${scope}
), bigram_hits AS (
  SELECT f.id, b.bigram,
         position(b.bigram IN f.question_zh) > 0 AS in_question,
         position(b.bigram IN f.answer_zh) > 0 AS in_answer,
         position(b.bigram IN f.phrasing_text) > 0 AS in_phrasing
    FROM unnest($5::text[]) AS b(bigram)
    JOIN ${table} f
      ON ${scope}
     AND (position(b.bigram IN f.question_zh) > 0 OR position(b.bigram IN f.answer_zh) > 0
          OR position(b.bigram IN f.phrasing_text) > 0)
), bigram_weights AS (
  SELECT h.bigram, ln((p.total + 1) / count(*)) / ln(p.total + 1) AS idf
    FROM bigram_hits h CROSS JOIN published p
   GROUP BY h.bigram, p.total
), bigram_scores AS (
  SELECT h.id,
         COALESCE(sum(w.idf) FILTER (WHERE h.in_question), 0) AS question_bigrams,
         COALESCE(sum(w.idf) FILTER (WHERE h.in_answer), 0) AS answer_bigrams,
         COALESCE(sum(w.idf) FILTER (WHERE h.in_phrasing), 0) AS phrasing_bigrams,
         max(w.idf) AS best_idf
    FROM bigram_hits h JOIN bigram_weights w ON w.bigram = h.bigram
   GROUP BY h.id
), text_matched AS (
  SELECT f.id
    FROM ${table} f
   WHERE ${scope} AND $3 <> ''
     AND to_tsvector('english', f.question_en || ' ' || f.answer_en) @@ to_tsquery('english', $3)
), phrasing_matched AS (
  SELECT f.id
    FROM ${table} f CROSS JOIN input i
   WHERE ${scope} AND i.tsq IS NOT NULL AND f.phrasing_tsv @@ i.tsq
), matched AS (
  SELECT id FROM text_matched
  UNION
  SELECT id FROM phrasing_matched
  UNION
  SELECT f.id
    FROM ${table} f
   WHERE ${scope} AND f.typo_keys && $10::text[]
  UNION
  SELECT f.id
    FROM ${table} f CROSS JOIN input i
   WHERE ${scope}
     AND EXISTS (SELECT 1 FROM unnest(f.keywords) AS k
                  WHERE k <> ''
                    AND (position(lower(k) IN i.body) > 0 OR lower(k) ~ i.word_prefix))
  UNION
  SELECT id FROM bigram_scores WHERE best_idf >= 0.1
), scored AS (
  SELECT f.*,
         CASE WHEN t.id IS NULL THEN 0
              ELSE 2 * ts_rank('{0.05,0.1,0.4,1.0}'::float4[],
                               setweight(to_tsvector('english', f.question_en), 'A')
                               || setweight(to_tsvector('english', f.answer_en), 'D'), i.tsq) END AS text_rank,
         CASE WHEN pm.id IS NULL THEN 0 ELSE ts_rank(f.phrasing_tsv, i.tsq) END AS phrasing_rank,
         (SELECT count(*) FROM unnest(f.keywords) AS k
           WHERE k <> '' AND position(lower(k) IN i.body) > 0) AS keyword_hits,
         (SELECT count(*) FROM unnest(f.keywords) AS k
           WHERE k <> '' AND lower(k) ~ i.word_prefix) AS keyword_prefix_hits,
         COALESCE(s.question_bigrams, 0) AS question_bigrams,
         COALESCE(s.answer_bigrams, 0) AS answer_bigrams,
         COALESCE(s.phrasing_bigrams, 0) AS phrasing_bigrams,
         (SELECT count(DISTINCT q.word) FROM unnest($10::text[], $11::int[]) AS q(key, word)
           WHERE q.key = ANY (f.typo_keys)) AS typo_hits
    FROM ${table} f
    JOIN matched m ON m.id = f.id
    CROSS JOIN input i
    LEFT JOIN text_matched t ON t.id = f.id
    LEFT JOIN phrasing_matched pm ON pm.id = f.id
    LEFT JOIN bigram_scores s ON s.id = f.id
   WHERE ${scope}
     AND ($7::text IS NULL OR f.category = $7::text)
     AND ($8::boolean IS NULL OR f.popular = $8::boolean)
     AND ($12::boolean IS NOT TRUE OR f.entry)
     AND f.node_type = ANY ($13::text[])
)
SELECT id, key, node_type, entry, category, popular, question_en, answer_en, question_zh,
       answer_zh, keywords, signals, status, version, created_by, updated_by, created_at,
       updated_at,
       CASE WHEN $1 = 'zh-CN' THEN question_zh ELSE question_en END AS question,
       ((text_rank + phrasing_rank + 0.3 * keyword_hits + 0.15 * keyword_prefix_hits
         + 0.25 * question_bigrams + 0.08 * answer_bigrams + 0.25 * phrasing_bigrams
         + 0.2 * typo_hits)
         * CASE WHEN category = $2 THEN 1.25 ELSE 1 END)::float8 AS score
  FROM scored
 ORDER BY score DESC, popular DESC, updated_at DESC, id ASC
 LIMIT $6`;
}

/** 工作表上的候选检索（第一版发布之前；EXPLAIN 锁定它走 GIN 索引）。 */
export const FAQ_CANDIDATES_SQL = candidatesSql('live');

/** 发布版本的候选检索（多一个参数 $14 = 版本号）。 */
export const FAQ_RELEASE_CANDIDATES_SQL = candidatesSql('release');

export function createPgFaqRepository(db: SqlDb = pgSqlDb): FaqRepository {
  async function currentVersion(
    client: SqlClient,
    id: string,
  ): Promise<number | null> {
    const { rows } = await client.query(
      'SELECT version FROM helpdesk_faqs WHERE id = $1',
      [id],
    );
    return rows.length > 0 ? Number(rows[0].version) : null;
  }

  return {
    async list(filter) {
      const params: unknown[] = [];
      const where = [`status = 'published'`];
      if (filter.category) {
        params.push(filter.category);
        where.push(`category = $${params.length}`);
      }
      if (filter.popular !== undefined) {
        params.push(filter.popular);
        where.push(`popular = $${params.length}`);
      }
      if (filter.q) {
        params.push(likePattern(filter.q));
        const n = params.length;
        where.push(`(question_en ILIKE $${n} OR answer_en ILIKE $${n}
          OR question_zh ILIKE $${n} OR answer_zh ILIKE $${n}
          OR EXISTS (SELECT 1 FROM unnest(keywords) AS k WHERE k ILIKE $${n}))`);
      }
      const whereSql = where.join(' AND ');
      const [counted, rows] = await Promise.all([
        db.query(
          `SELECT count(*)::int AS n FROM helpdesk_faqs WHERE ${whereSql}`,
          params,
        ),
        db.query(
          `SELECT ${COLUMNS} FROM helpdesk_faqs
            WHERE ${whereSql}
            ORDER BY updated_at DESC, id DESC
            OFFSET $${params.length + 1} LIMIT $${params.length + 2}`,
          [...params, filter.offset, filter.limit],
        ),
      ]);
      return { faqs: rows.map(toFaq), total: Number(counted[0]?.n ?? 0) };
    },

    async get(id) {
      const rows = await db.query(
        `SELECT ${COLUMNS} FROM helpdesk_faqs WHERE id = $1`,
        [id],
      );
      return rows.length > 0 ? toFaq(rows[0]) : null;
    },

    insert(faq, employeeId, idempotencyKey) {
      return db.withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO helpdesk_faqs
             (id, category, popular, question_en, answer_en, question_zh, answer_zh,
              keywords, status, version, idempotency_key, created_by, updated_by, signals,
              key, node_type, entry, popular_rank)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, 1, $10, $11, $11, $12::text[],
                   $13, $14, $15, $16)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING ${COLUMNS}`,
          [
            faq.id,
            faq.category,
            faq.popular,
            faq.questionEn,
            faq.answerEn,
            faq.questionZh,
            faq.answerZh,
            faq.keywords,
            faq.status,
            idempotencyKey,
            employeeId,
            faq.signals,
            // 空 key：触发器按英文问题取第一个空闲的 slug（迁移 20261030150000）
            faq.key === '' ? null : faq.key,
            faq.type,
            faq.entry,
            faq.popularRank,
          ],
        );
        if (rows.length === 0) {
          // 同一个 Idempotency-Key 已建过（NULL 永远不冲突）
          const existing = await client.query(
            `SELECT ${COLUMNS} FROM helpdesk_faqs WHERE idempotency_key = $1`,
            [idempotencyKey],
          );
          return { faq: toFaq(existing.rows[0]), created: false };
        }
        const created = toFaq(rows[0]);
        await writeRevision(client, created, 'create', employeeId);
        return { faq: created, created: true };
      });
    },

    update(id, expectedVersion, patch, action, employeeId) {
      return db.withTransaction(async (client) => {
        if (patch.status === 'archived') {
          // 先锁住这一行（建边的事务对它 FOR SHARE，要等它提交），再用新的快照查父节点：
          // 归档与同时建的边不会都成功（不会留下已归档、却还挂在已发布父节点下的子节点）
          await client.query(
            'SELECT id FROM helpdesk_faqs WHERE id = $1 FOR UPDATE',
            [id],
          );
          const parents = await client.query(
            `SELECT 1 FROM helpdesk_faq_edges e
               JOIN helpdesk_faqs p ON p.id = e.parent_id AND p.status = 'published'
              WHERE e.child_id = $1 LIMIT 1`,
            [id],
          );
          if (parents.rows.length > 0) return { kind: 'has_parents' as const };
        }
        const params: unknown[] = [id, expectedVersion, employeeId];
        const sets = [
          'version = version + 1',
          'updated_by = $3',
          'updated_at = now()',
        ];
        for (const [key, column] of Object.entries(PATCH_COLUMNS) as [
          keyof FaqPatch,
          string,
        ][]) {
          if (patch[key] === undefined) continue;
          params.push(patch[key]);
          sets.push(
            `${column} = $${params.length}${ARRAY_COLUMNS.includes(key) ? '::text[]' : ''}`,
          );
        }
        const { rows } = await client.query(
          `UPDATE helpdesk_faqs SET ${sets.join(', ')}
            WHERE id = $1 AND version = $2
            RETURNING ${COLUMNS}`,
          params,
        );
        if (rows.length === 0) {
          const version = await currentVersion(client, id);
          return version === null
            ? { kind: 'not_found' as const }
            : { kind: 'conflict' as const, currentVersion: version };
        }
        const updated = toFaq(rows[0]);
        await writeRevision(client, updated, action, employeeId);
        return { kind: 'ok' as const, value: updated };
      });
    },

    async revisions(id) {
      const rows = await db.query(
        `SELECT id, faq_id, version, snapshot, action, employee_id, at
           FROM helpdesk_faq_revisions
          WHERE faq_id = $1
          ORDER BY version DESC`,
        [id],
      );
      return rows.map(toRevision);
    },

    async listPublished(filter) {
      const release = filter.release ?? null;
      const params: unknown[] = [
        filter.category ?? null,
        filter.popular ?? null,
        filter.limit,
        filter.boost ?? null,
        (filter.excludeIds ?? []).map((id) => id.toLowerCase()),
        filter.entryOnly ?? true,
        [...(filter.types ?? DEFAULT_TYPES)],
      ];
      if (release !== null) params.push(release);
      const rows = await db.query(
        `SELECT ${COLUMNS} FROM ${release === null ? 'helpdesk_faqs' : 'helpdesk_faq_release_nodes'}
          WHERE status = 'published'
            ${release === null ? '' : 'AND release_version = $8::int'}
            AND ($1::text IS NULL OR category = $1::text)
            AND ($2::boolean IS NULL OR popular = $2::boolean)
            AND NOT (id::text = ANY ($5::text[]))
            AND ($6::boolean IS NOT TRUE OR entry)
            AND node_type = ANY ($7::text[])
          ORDER BY popular DESC,
                   CASE WHEN popular THEN popular_rank END ASC NULLS LAST,
                   (category = $4::text) IS TRUE DESC,
                   updated_at DESC, id DESC
          LIMIT $3`,
        params,
      );
      return rows.map(toFaq);
    },

    async searchPublished(search) {
      const text = search.text.trim();
      if (text === '') return [];
      const { tsquery, words, bigrams, body, typo } = searchTerms(text);
      const limit = Math.min(
        Math.max(1, Math.floor(search.limit)),
        FAQ_LIMITS.publicLimitMax,
      );
      const release = search.release ?? null;
      const params: unknown[] = [
        search.locale,
        search.boost ?? '',
        tsquery,
        body,
        bigrams,
        limit,
        search.category ?? null,
        search.popular ?? null,
        words,
        typo.keys,
        typo.word,
        search.entryOnly ?? true,
        [...(search.types ?? DEFAULT_TYPES)],
      ];
      if (release !== null) params.push(release);
      const rows = await db.query(
        release === null ? FAQ_CANDIDATES_SQL : FAQ_RELEASE_CANDIDATES_SQL,
        params,
      );
      return rows.map((row) => ({ ...toFaq(row), score: Number(row.score) }));
    },

    async getByKey(key) {
      const rows = await db.query(
        `SELECT ${COLUMNS} FROM helpdesk_faqs WHERE key = $1`,
        [key],
      );
      return rows.length > 0 ? toFaq(rows[0]) : null;
    },

    async getPublished(id, scope = {}) {
      const release = scope.release ?? null;
      const rows =
        release === null
          ? await db.query(
              `SELECT ${COLUMNS} FROM helpdesk_faqs WHERE id = $1 AND status = 'published'`,
              [id],
            )
          : await db.query(
              `SELECT ${COLUMNS} FROM helpdesk_faq_release_nodes
                WHERE release_version = $2 AND id = $1`,
              [id, release],
            );
      return rows.length > 0 ? toFaq(rows[0]) : null;
    },
  };
}
