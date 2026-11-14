import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import type { HelpdeskFaq } from '../modules/helpdesk/faqs/faqContracts';
import {
  createPgFaqRepository,
  type SqlDb,
} from '../modules/helpdesk/faqs/faqRepository';
import {
  DEMO_CANDIDATES,
  DEMO_PREFIX,
  demoId,
  demoTurns,
  isLocalDatabase,
  removeDemoRows,
  reviewTime,
  seedDemoRows,
} from '../modules/helpdesk/demo/helpdeskDemo';
import { shouldAutoSeedDemo } from '../modules/helpdesk/demo/helpdeskDemoSeed';

/**
 * 演示数据：id 规则、只连本机库、审核时间在卡改动之后；PostgreSQL 实测灌两次不重复、一键删只删演示行、
 * 删完只追加触发器仍然生效、真实数据不动。需要 HELPDESK_TEST_DATABASE_URL，没有就跳过 PostgreSQL 部分。
 */
const NOW = new Date('2026-10-31T12:00:00Z');
const DAY = 86_400_000;

describe('helpdesk demo data (pure)', () => {
  it('makes stable, valid UUIDs with the demo prefix', () => {
    const id = demoId('turn', 'x');
    expect(id).toBe(demoId('turn', 'x'));
    expect(id).not.toBe(demoId('turn', 'y'));
    expect(id.startsWith(DEMO_PREFIX)).toBe(true);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('only treats local databases as local', () => {
    expect(isLocalDatabase('postgres://u:p@127.0.0.1:5432/db')).toBe(true);
    expect(isLocalDatabase('postgres://u:p@localhost/db')).toBe(true);
    expect(isLocalDatabase('postgres://u:p@[::1]:5432/db')).toBe(true);
    expect(
      isLocalDatabase('postgres://u:p@db.example.rds.amazonaws.com:5432/db'),
    ).toBe(false);
    expect(isLocalDatabase('not a url')).toBe(false);
  });

  it('puts a review after the card was last changed and never in the future', () => {
    const created = NOW.getTime() - 3_600_000;
    for (const r of [0, 0.5, 0.999]) {
      const at = reviewTime(created, NOW.getTime(), r).getTime();
      expect(at).toBeGreaterThan(created);
      expect(at).toBeLessThanOrEqual(NOW.getTime());
    }
    const old = NOW.getTime() - 30 * DAY;
    expect(reviewTime(old, NOW.getTime(), 0).getTime()).toBeGreaterThanOrEqual(
      NOW.getTime() - 6 * DAY,
    );
  });

  it('spans four weeks, every turn kind, and is the same on a re-run', () => {
    const keys = new Set(['create-account', 'invoice-receipt']);
    const turns = demoTurns(NOW, keys);
    expect(demoTurns(NOW, keys)).toEqual(turns);
    const days = new Set(
      turns.map((turn) => turn.createdAt.toISOString().slice(0, 10)),
    );
    expect(days.size).toBeGreaterThanOrEqual(28);
    expect(new Set(turns.map((turn) => turn.kind))).toEqual(
      new Set(['answer', 'clarify', 'no_match', 'smalltalk', 'handover']),
    );
    expect(turns.every((turn) => turn.id.startsWith(DEMO_PREFIX))).toBe(true);
    expect(
      turns.every((turn) => turn.faqKey === null || keys.has(turn.faqKey)),
    ).toBe(true);
  });

  it('has every suggestion kind and every decided state', () => {
    expect(new Set(DEMO_CANDIDATES.map((c) => c.suggestion))).toEqual(
      new Set([
        'new_faq',
        'add_phrasing',
        'follow_up',
        'update_faq',
        'retire_faq',
      ]),
    );
    expect(new Set(DEMO_CANDIDATES.map((c) => c.status ?? 'new'))).toEqual(
      new Set(['new', 'accepted', 'dismissed', 'merged']),
    );
  });
});

const url = process.env.HELPDESK_TEST_DATABASE_URL;
if (!url && process.env.CI === 'true')
  throw new Error('HELPDESK_TEST_DATABASE_URL is required when CI=true');
const describeDb = url ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '../../../prisma/migrations');
const EMP = '0192aaaa-0000-7000-8000-000000000001';
// 演示数据会用到的真卡：回答过的话题 + 候选指向的卡
const KEYS = [
  'create-account',
  'google-sign-in',
  'invoice-receipt',
  'cancel-study-group',
  'auto-renewal-off-meaning',
  'payment-failed-why',
  'stay-signed-in--how-long',
];

function card(index: number, key: string): HelpdeskFaq {
  return {
    id: `0192cccc-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
    key,
    type: 'answer',
    entry: true,
    category: 'account_technical',
    popular: false,
    popularRank: null,
    questionEn: `Question ${key}`,
    answerEn: 'Answer',
    questionZh: `问题 ${key}`,
    answerZh: '答案',
    keywords: [],
    signals: [],
    status: 'published',
    version: 1,
    createdBy: EMP,
    updatedBy: EMP,
    createdAt: '',
    updatedAt: '',
  };
}

describeDb('helpdesk demo data (PostgreSQL)', () => {
  // 卡是现在建的，演示行也按现在算（审核要在卡建好之后）
  let seededAt: Date;
  const schema = `hddemo_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let db: SqlDb;
  const count = async (table: string, where = 'true') =>
    (
      await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      )
    ).rows[0].n;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    await pool.query(
      readdirSync(MIGRATIONS)
        .filter((dir) => dir.includes('helpdesk'))
        .sort()
        .map((dir) =>
          readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'),
        )
        .join('\n'),
    );
    db = {
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
    const repo = createPgFaqRepository(db);
    for (const [index, key] of KEYS.entries())
      await repo.insert(
        card(index, key),
        EMP,
        `0192ffff-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
      );
    // 卡的 updated_at 由数据库 now() 写入。宿主机与 Docker Postgres 的时钟可能相差
    // 数毫秒到十几毫秒；用宿主 Date 当「现在」会让审核时间早于卡的更新时间。演示行
    // 的 now 必须取数据库时钟，保证 review.at >= faq.updated_at。
    seededAt = (
      await pool.query<{ seeded_at: Date }>('SELECT now() AS seeded_at')
    ).rows[0].seeded_at;
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('seeds every table once, then a re-run adds nothing', async () => {
    const first = await seedDemoRows(db, seededAt);
    expect(first.turns).toBeGreaterThan(1000);
    expect(first.candidates).toBe(DEMO_CANDIDATES.length);
    expect(first.skippedCandidates).toEqual([]);
    // today's nightly run starts at 02:00 UTC: before that only the 13 past days (the test failed every day 00:00-02:00 UTC)
    expect(first.runs).toBe(seededAt.getUTCHours() >= 2 ? 14 : 13);
    expect(first.reviews).toBeGreaterThan(0);
    expect(await seedDemoRows(db, seededAt)).toEqual({
      turns: 0,
      candidates: 0,
      skippedCandidates: [],
      runs: 0,
      reviews: 0,
    });
    // 「需要改」都带备注（这里卡少，不一定抽到「需要改」）
    expect(
      await count(
        'helpdesk_faq_reviews',
        `status = 'needs_change' AND note IS NULL`,
      ),
    ).toBe(0);
    // 审核都在卡建好之后
    expect(
      await count(
        'helpdesk_faq_reviews r JOIN helpdesk_faqs f ON f.id = r.faq_id',
        'r.at < f.updated_at',
      ),
    ).toBe(0);
  });

  it('removes only demo rows, including candidates mined from demo turns, and keeps the guards on', async () => {
    // 真实数据：一条真审核、一张真候选；还有一张拿演示记录建的候选（夜间挖掘会这样做）
    await pool.query(
      `INSERT INTO helpdesk_faq_reviews (id, faq_id, faq_version, status, employee_id) VALUES ($1, $2, 1, 'ok', NULL)`,
      ['0192dddd-0000-7000-8000-000000000001', card(0, KEYS[0]).id],
    );
    const realCandidate = '0192eeee-0000-7000-8000-000000000001';
    const minedCandidate = '0192eeee-0000-7000-8000-000000000002';
    for (const id of [realCandidate, minedCandidate])
      await pool.query(
        `INSERT INTO helpdesk_faq_candidates (id, suggestion, origin, topic, proposed_question, label_source, category, locale, first_seen_at, last_seen_at)
         VALUES ($1, 'new_faq', 'mining', 'topic', 'question?', 'model', 'other', 'zh-CN', now(), now())`,
        [id],
      );
    const turn = (
      await pool.query<{ id: string }>(
        // a demo turn no demo candidate holds yet (a turn belongs to at most one candidate)
        `SELECT t.id FROM helpdesk_insight_turns t
          WHERE t.id::text LIKE '${DEMO_PREFIX}%'
            AND NOT EXISTS (SELECT 1 FROM helpdesk_faq_candidate_turns c WHERE c.turn_id = t.id)
          ORDER BY t.id LIMIT 1`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO helpdesk_faq_candidate_turns (candidate_id, turn_id) VALUES ($1, $2)`,
      [minedCandidate, turn],
    );

    const removed = await removeDemoRows(db);
    expect(removed.turns).toBeGreaterThan(1000);
    expect(removed.candidates).toBe(DEMO_CANDIDATES.length + 1);
    expect(
      await count('helpdesk_insight_turns', `id::text LIKE '${DEMO_PREFIX}%'`),
    ).toBe(0);
    expect(
      await count('helpdesk_faq_candidates', `id::text LIKE '${DEMO_PREFIX}%'`),
    ).toBe(0);
    expect(
      await count('helpdesk_flywheel_runs', `id::text LIKE '${DEMO_PREFIX}%'`),
    ).toBe(0);
    expect(await count('helpdesk_faq_reviews')).toBe(1);
    expect(await count('helpdesk_faq_candidates')).toBe(1);
    expect(await count('helpdesk_faqs')).toBe(KEYS.length);
    await expect(
      pool.query('DELETE FROM helpdesk_faq_reviews'),
    ).rejects.toThrow();
  });
});

describe('helpdesk demo data: auto seed only on deployed DEV', () => {
  it('seeds on deployed DEV only', () => {
    expect(shouldAutoSeedDemo({ APP_ENV: 'DEV', NODE_ENV: 'production' })).toBe(
      true,
    );
    expect(
      shouldAutoSeedDemo({ APP_ENV: ' dev ', NODE_ENV: 'production' }),
    ).toBe(true);
  });

  it('never seeds SIT, UAT, PROD, a missing APP_ENV, local runs or when turned off', () => {
    for (const APP_ENV of ['SIT', 'UAT', 'PPE', 'PROD', '', undefined])
      expect(shouldAutoSeedDemo({ APP_ENV, NODE_ENV: 'production' })).toBe(
        false,
      );
    expect(
      shouldAutoSeedDemo({ APP_ENV: 'DEV', NODE_ENV: 'development' }),
    ).toBe(false);
    expect(shouldAutoSeedDemo({ APP_ENV: 'DEV', NODE_ENV: 'test' })).toBe(
      false,
    );
    expect(
      shouldAutoSeedDemo({
        APP_ENV: 'DEV',
        NODE_ENV: 'production',
        HELPDESK_DEMO_DATA: 'off',
      }),
    ).toBe(false);
  });
});
