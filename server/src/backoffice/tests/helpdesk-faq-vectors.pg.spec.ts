import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import type { HelpdeskFaq } from '../modules/helpdesk/faqs/faqContracts';
import { createHelpdeskQaSource } from '../modules/helpdesk/faqs/faqQaSource';
import { createPgFaqGraphRepository } from '../modules/helpdesk/faqs/faqGraphRepository';
import {
  createFaqGraphService,
  type FaqGraphService,
} from '../modules/helpdesk/faqs/faqGraphService';
import type { FaqReleaseGate } from '../modules/helpdesk/faqs/faqReleaseGate';
import {
  createFaqReleaseService,
  createPgFaqReleaseSource,
} from '../modules/helpdesk/faqs/faqReleaseService';
import {
  createPgFaqRepository,
  type FaqRepository,
  type SqlDb,
} from '../modules/helpdesk/faqs/faqRepository';
import {
  createFaqService,
  type FaqService,
} from '../modules/helpdesk/faqs/faqService';
import {
  createFaqVectorSearch,
  createPgFaqVectorStore,
  indexFaqRelease,
  textHash,
  withFaqVectorSearch,
  type FaqEmbedder,
  type FaqVectorStore,
} from '../modules/helpdesk/faqs/faqVectors';

/**
 * FAQ 向量在 PostgreSQL 上（迁移 20261031110000_helpdesk_faq_vectors，faqVectors.ts）：表的约束与只追加、
 * 一个真的发布版本的增量建索引（问法取快照原文）、REAL[] 往返、向量检索找到字词检索找不到的卡、
 * 发布服务在建版本和发布后触发建索引。
 * 需要 HELPDESK_TEST_DATABASE_URL（本地临时库）；CI 里必须有。每次在独立 schema 里跑迁移。
 */
const url = process.env.HELPDESK_TEST_DATABASE_URL;
if (!url && process.env.CI === 'true')
  throw new Error('HELPDESK_TEST_DATABASE_URL is required when CI=true');
const describeDb = url ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '../../../prisma/migrations');

function migrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((dir) => dir.includes('helpdesk'))
    .sort()
    .map((dir) => readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'))
    .join('\n');
}

function sqlDb(pool: Pool): SqlDb {
  return {
    query: async (sql, params = []) =>
      (await pool.query<Record<string, unknown>>(sql, params as unknown[]))
        .rows,
    withTransaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await fn(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

const staff = { employeeId: '0192aaaa-0000-7000-8000-000000000001' };
const MODEL = 'test/embed';

const passingGate: FaqReleaseGate = {
  evaluate: () =>
    Promise.resolve({
      kind: 'retrieval',
      passed: true,
      summary: 'ok',
      ranAt: '2026-10-31T00:00:00.000Z',
      metrics: {},
      misses: [],
    }),
};

/** 假模型：退款类的文字落在第一个轴，密码类落在第二个轴，其余落在第三个轴。 */
function fakeEmbedder(): FaqEmbedder & { texts: string[] } {
  const texts: string[] = [];
  return {
    model: MODEL,
    texts,
    embed(batch) {
      texts.push(...batch);
      return Promise.resolve(
        batch.map((text) =>
          /refund|退款|扣了两次|钱没退/i.test(text)
            ? [1, 0.1, 0.05]
            : /password|密码/i.test(text)
              ? [0.05, 1, 0.1]
              : [0.1, 0.05, 1],
        ),
      );
    },
  };
}

describeDb('Helpdesk FAQ vectors (PostgreSQL)', () => {
  const schema = `hdvec_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let db: SqlDb;
  let repo: FaqRepository;
  let faqs: FaqService;
  let graphService: FaqGraphService;
  let store: FaqVectorStore;
  let graph: ReturnType<typeof createPgFaqGraphRepository>;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    await pool.query(migrationSql());
    db = sqlDb(pool);
    repo = createPgFaqRepository(db);
    store = createPgFaqVectorStore(db);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE helpdesk_faq_map_revisions, helpdesk_faq_placements, helpdesk_faq_map_nodes,
                helpdesk_faq_release_vectors, helpdesk_faq_embeddings,
                helpdesk_faq_release_nodes, helpdesk_faq_releases, helpdesk_faq_edge_revisions,
                helpdesk_faq_edges, helpdesk_faq_phrasings, helpdesk_faq_reviews, helpdesk_faq_revisions, helpdesk_faqs`,
    );
    graph = createPgFaqGraphRepository(db);
    const source = createPgFaqReleaseSource(graph);
    faqs = createFaqService({
      repository: repo,
      releaseVersion: () => source.publishedVersion(),
      liveParents: (id) => graph.liveParents(id),
    });
    graphService = createFaqGraphService({ graph });
  });

  function create(
    fields: Partial<Record<string, unknown>>,
  ): Promise<HelpdeskFaq> {
    return faqs.create(staff, {
      category: 'payments_subscriptions',
      popular: false,
      answerEn: 'Answer.',
      answerZh: '答案。',
      keywords: [],
      ...fields,
    });
  }

  /** 两张卡（退款带两条问法）建成发布版本并发布；返回版本号和两张卡。 */
  async function publishedRelease(indexed: number[] = []) {
    const refund = await create({
      questionEn: 'How do I get a refund?',
      questionZh: '如何申请退款？',
    });
    const password = await create({
      questionEn: 'How do I reset my password?',
      questionZh: '如何重置密码？',
      category: 'account_technical',
    });
    await graphService.addPhrasing(staff, refund.id, {
      locale: 'zh-CN',
      text: '钱扣了两次',
    });
    await graphService.addPhrasing(staff, refund.id, {
      locale: 'en-GB',
      text: 'money not back yet',
    });
    const releases = createFaqReleaseService({
      graph,
      gate: passingGate,
      vectors: {
        index(version) {
          indexed.push(version);
          return Promise.resolve(null);
        },
      },
    });
    const { release } = await releases.create(staff);
    await releases.publish(staff, release.version);
    return { version: release.version, refund, password };
  }

  it('indexes a release once per text, with the phrasings from its snapshot, and links every node', async () => {
    const { version, refund, password } = await publishedRelease();
    const embedder = fakeEmbedder();
    const report = await indexFaqRelease({ store, embedder, release: version });
    expect(report).toEqual({
      release: version,
      model: MODEL,
      nodes: 2,
      texts: 6,
      embedded: 6,
    });
    expect(embedder.texts).toEqual(
      expect.arrayContaining([
        'How do I get a refund?',
        '如何申请退款？',
        '钱扣了两次',
        'money not back yet',
      ]),
    );
    const { rows } = await pool.query<{
      node_id: string;
      source: string;
      n: string;
    }>(
      `SELECT node_id, source, count(*) AS n FROM helpdesk_faq_release_vectors
        WHERE release_version = $1 AND model = $2 GROUP BY node_id, source ORDER BY node_id, source`,
      [version, MODEL],
    );
    expect(
      rows
        .map((r) => [
          r.node_id === refund.id
            ? 'refund'
            : r.node_id === password.id
              ? 'password'
              : r.node_id,
          r.source,
          Number(r.n),
        ])
        .sort(),
    ).toEqual(
      [
        ['password', 'question_en', 1],
        ['password', 'question_zh', 1],
        ['refund', 'phrasing', 2],
        ['refund', 'question_en', 1],
        ['refund', 'question_zh', 1],
      ].sort(),
    );

    const again = await indexFaqRelease({ store, embedder, release: version });
    expect(again.embedded).toBe(0);
    expect(embedder.texts).toHaveLength(6);
  });

  it('stores REAL[] vectors that load back with their node fields', async () => {
    const { version, refund } = await publishedRelease();
    await indexFaqRelease({
      store,
      embedder: fakeEmbedder(),
      release: version,
    });
    const loaded = await store.load(version, MODEL);
    expect(loaded).toHaveLength(6);
    const row = loaded.find((r) => r.nodeId === refund.id);
    expect(row).toMatchObject({
      type: 'answer',
      entry: true,
      category: 'payments_subscriptions',
      popular: false,
    });
    expect(row?.vector).toHaveLength(3);
    expect(row?.vector[0]).toBeCloseTo(1, 6);
    expect(await store.load(version, 'other/model')).toEqual([]);
  });

  it('leaves out the vectors the caller already holds, by text hash', async () => {
    const { version } = await publishedRelease();
    await indexFaqRelease({
      store,
      embedder: fakeEmbedder(),
      release: version,
    });
    const full = await store.load(version, MODEL);
    const held = new Set(full.slice(0, 2).map((row) => row.hash as string));
    const partial = await store.load(version, MODEL, held);
    expect(partial).toHaveLength(full.length);
    for (const row of partial) {
      expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.vector.length === 0).toBe(held.has(row.hash as string));
    }
  });

  it('finds the card by meaning where the lexical search finds nothing', async () => {
    const { version, refund, password } = await publishedRelease();
    const embedder = fakeEmbedder();
    await indexFaqRelease({ store, embedder, release: version });
    // no word or Chinese bigram in common with the refund card
    const query = {
      locale: 'zh-CN',
      boost: null,
      text: '钱没退',
      limit: 5,
      release: version,
    };
    expect(await repo.searchPublished(query)).toEqual([]);
    const vectors = createFaqVectorSearch({ store, embedder: () => embedder });
    const hybrid = withFaqVectorSearch(repo, { vectors, mode: () => 'hybrid' });
    const found = await hybrid.searchPublished(query);
    expect(found[0]).toMatchObject({
      id: refund.id,
      key: refund.key,
      questionEn: 'How do I get a refund?',
    });
    // the category filter holds for vector hits too
    const filtered = await hybrid.searchPublished({
      ...query,
      category: 'account_technical',
    });
    expect(filtered.map((f) => f.id)).toEqual([password.id]);
  });

  it('gives the rerank pool its vector side: the nearest answer cards of the live release, with their similarity', async () => {
    const { version, refund } = await publishedRelease();
    const embedder = fakeEmbedder();
    await indexFaqRelease({ store, embedder, release: version });
    const vectors = createFaqVectorSearch({ store, embedder: () => embedder });
    const qa = createHelpdeskQaSource({
      repository: repo,
      releases: createPgFaqReleaseSource(graph),
      liveEdges: () => graph.allEdges(),
      vectors,
    });
    const found = await qa.findVectorCandidates?.({
      locale: 'zh-CN',
      text: '钱没退',
      limit: 1,
    });
    expect(found).toHaveLength(1);
    expect(found?.[0]).toMatchObject({
      id: refund.id,
      question: '如何申请退款？',
      relation: 'search',
    });
    expect(found?.[0].score).toBeGreaterThan(0.9);
    // no vectors -> nothing, never an error
    const plain = createHelpdeskQaSource({
      repository: repo,
      releases: createPgFaqReleaseSource(graph),
      liveEdges: () => graph.allEdges(),
    });
    await expect(
      plain.findVectorCandidates?.({
        locale: 'zh-CN',
        text: '钱没退',
        limit: 3,
      }),
    ).resolves.toEqual([]);
  });

  it('keeps the tables append-only and checked', async () => {
    const { version, refund } = await publishedRelease();
    await indexFaqRelease({
      store,
      embedder: fakeEmbedder(),
      release: version,
    });
    await expect(
      pool.query('UPDATE helpdesk_faq_embeddings SET text = $1', ['x']),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query('DELETE FROM helpdesk_faq_release_vectors'),
    ).rejects.toThrow(/append-only/);
    const hash = textHash('new text');
    await expect(
      pool.query(
        `INSERT INTO helpdesk_faq_embeddings (model, text_hash, text, dims, embedding) VALUES ($1, $2, 'new text', 3, '{1,2}')`,
        [MODEL, hash],
      ),
    ).rejects.toThrow(/dims_check/);
    await expect(
      pool.query(
        `INSERT INTO helpdesk_faq_embeddings (model, text_hash, text, dims, embedding) VALUES ($1, 'NOT-A-HASH', 'x', 1, '{1}')`,
        [MODEL],
      ),
    ).rejects.toThrow(/hash_check/);
    // a link needs a node of that release and a stored vector
    await expect(
      store.link(version + 1, MODEL, [
        {
          nodeId: refund.id,
          hash: textHash('How do I get a refund?'),
          source: 'question_en',
        },
      ]),
    ).rejects.toThrow(/node_fkey/);
    await expect(
      store.link(version, MODEL, [
        { nodeId: refund.id, hash: hash, source: 'phrasing' },
      ]),
    ).rejects.toThrow(/embedding_fkey/);
  });

  it('asks the indexer for vectors when a release is created and when it is published', async () => {
    const indexed: number[] = [];
    const { version } = await publishedRelease(indexed);
    expect(indexed).toEqual([version, version]);
  });
});
