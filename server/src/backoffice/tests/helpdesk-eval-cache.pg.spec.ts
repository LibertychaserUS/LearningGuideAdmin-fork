import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import { EVAL_CACHE, evalCacheKey } from '../../contracts/helpdesk-eval-cache';
import type { SqlDb } from '../modules/helpdesk/faqs/faqRepository';
import { createPgEvalCacheStore } from '../modules/helpdesk/faqs/release-check/evalCacheStore';

/**
 * 发布前检查的分层结果缓存在 PostgreSQL 上（迁移 20261106000000_helpdesk_eval_stage_cache）：
 * 往返、同键覆盖、过期不读、prune、约束（层名、键的形状、耗时与花费不为负）。
 * 需要 HELPDESK_TEST_DATABASE_URL（本地临时库）；CI 里必须有。在独立 schema 里只跑这一个迁移。
 */
const url = process.env.HELPDESK_TEST_DATABASE_URL;
if (!url && process.env.CI === 'true')
  throw new Error('HELPDESK_TEST_DATABASE_URL is required when CI=true');
const describeDb = url ? describe : describe.skip;

const MIGRATION = join(
  __dirname,
  '../../../prisma/migrations/20261106000000_helpdesk_eval_stage_cache/migration.sql',
);

describeDb('Helpdesk release-check stage cache (PostgreSQL)', () => {
  const schema = `hdcache_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let db: SqlDb;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    await pool.query(readFileSync(MIGRATION, 'utf8'));
    db = {
      query: async (sql, params = []) =>
        (await pool.query<Record<string, unknown>>(sql, params as unknown[]))
          .rows,
      withTransaction: () => Promise.reject(new Error('not used')),
    };
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(() => pool.query('TRUNCATE helpdesk_eval_stage_cache'));

  const a = evalCacheKey('step', { q: 'a' });
  const b = evalCacheKey('step', { q: 'b' });

  it('round-trips entries, replaces on the same key, and keeps layers apart', async () => {
    const store = createPgEvalCacheStore(db);
    await store.put('step', [
      {
        key: a,
        entry: {
          value: { kind: 'no_call' },
          latencyMs: 812.4,
          costUsd: 0.0002,
        },
      },
      { key: b, entry: { value: 0.5, latencyMs: 3, costUsd: 0 } },
      // the same key twice in one batch: the last one wins
      { key: b, entry: { value: 0.75, latencyMs: 4, costUsd: 0 } },
    ]);
    const got = await store.get('step', [a, b, evalCacheKey('step', 'none')]);
    expect(got.get(a)).toEqual({
      value: { kind: 'no_call' },
      latencyMs: 812,
      costUsd: 0.0002,
    });
    expect(got.get(b)?.value).toBe(0.75);
    expect(got.size).toBe(2);
    expect((await store.get('rerank', [a])).size).toBe(0);
    await store.put('step', [
      {
        key: a,
        entry: {
          value: { kind: 'called', args: {} },
          latencyMs: 9,
          costUsd: 0.001,
        },
      },
    ]);
    expect((await store.get('step', [a])).get(a)?.value).toEqual({
      kind: 'called',
      args: {},
    });
    // big batches go in several statements
    const many = Array.from({ length: 1_201 }, (_, i) => ({
      key: evalCacheKey('rerank', { i }),
      entry: { value: i / 10_000, latencyMs: 1, costUsd: 0 },
    }));
    await store.put('rerank', many);
    expect(
      (
        await store.get(
          'rerank',
          many.map((row) => row.key),
        )
      ).size,
    ).toBe(1_201);
  });

  it('does not read entries older than ttlDays, and prune removes them', async () => {
    const store = createPgEvalCacheStore(db);
    await store.put('embed', [
      { key: a, entry: { value: 'AAAAAA==', latencyMs: 1, costUsd: 0 } },
      { key: b, entry: { value: 'AAAAAA==', latencyMs: 1, costUsd: 0 } },
    ]);
    await pool.query(
      `UPDATE helpdesk_eval_stage_cache SET created_at = now() - make_interval(days => $1)
        WHERE key = $2`,
      [EVAL_CACHE.ttlDays, a],
    );
    expect([...(await store.get('embed', [a, b])).keys()]).toEqual([b]);
    await expect(store.prune?.()).resolves.toBe(1);
    const left = await pool.query('SELECT key FROM helpdesk_eval_stage_cache');
    expect(left.rows.map((row: { key: string }) => row.key)).toEqual([b]);
  });

  it.each([
    ['an unknown layer', `'other', '${'a'.repeat(64)}', '1', 1, 0`],
    ['a key that is not a SHA-256', `'step', 'raw user text', '1', 1, 0`],
    ['a negative latency', `'step', '${'a'.repeat(64)}', '1', -1, 0`],
    ['a negative cost', `'step', '${'a'.repeat(64)}', '1', 1, -0.1`],
  ])('the table refuses %s', async (_, values) => {
    await expect(
      pool.query(
        `INSERT INTO helpdesk_eval_stage_cache (layer, key, value, latency_ms, cost_usd)
         VALUES (${values})`,
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
