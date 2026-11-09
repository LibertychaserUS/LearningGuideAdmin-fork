import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import { createPgFaqGraphRepository } from '../modules/helpdesk/faqs/faqGraphRepository';
import { createFaqGraphService } from '../modules/helpdesk/faqs/faqGraphService';
import {
  parseFaqLibrary,
  seedFaqLibrary,
} from '../modules/helpdesk/faqs/faqLibrarySeed';
import {
  createRetrievalGate,
  type FaqReleaseEvalProgress,
  type FaqReleaseEvalReport,
  type FaqReleaseGate,
  type FaqReleaseGateInput,
} from '../modules/helpdesk/faqs/faqReleaseGate';
import {
  EVAL_STALE_MS,
  createFaqReleaseService,
  createPgFaqReleaseSource,
} from '../modules/helpdesk/faqs/faqReleaseService';
import {
  createPgFaqRepository,
  type SqlDb,
} from '../modules/helpdesk/faqs/faqRepository';
import { createFaqService } from '../modules/helpdesk/faqs/faqService';

/**
 * 发布前的检查是后台任务（owner 2026-11-03）：新建版本立刻返回 evaluating，检查在后台跑并写心跳与进度；
 * 正在跑的不能再开一次（409）；心跳停了 = 「检查中断」，重新检查用新的 run 接手，旧的 run 写不进结果。
 * DEV 上 v5 卡在 evaluating 的那种旧行（没有 run）也算中断。需要 HELPDESK_TEST_DATABASE_URL。
 */
const url = process.env.HELPDESK_TEST_DATABASE_URL;
if (!url && process.env.CI === 'true')
  throw new Error('HELPDESK_TEST_DATABASE_URL is required when CI=true');
const describeDb = url ? describe : describe.skip;

const ROOT = join(__dirname, '../../..');
const MIGRATIONS = join(ROOT, 'prisma/migrations');
const LIBRARY = join(ROOT, 'eval/helpdesk/faq-library.json');

type Pending = {
  input: FaqReleaseGateInput;
  finish: (passed: boolean) => void;
};

/** 一个由测试控制什么时候结束的评测门。 */
function controlledGate() {
  const pending: Pending[] = [];
  const gate: FaqReleaseGate = {
    evaluate: (input) =>
      new Promise<FaqReleaseEvalReport>((resolve) => {
        pending.push({
          input,
          finish: (passed) =>
            resolve({
              kind: 'model',
              passed,
              summary: passed ? 'ok' : 'no',
              ranAt: new Date(0).toISOString(),
              metrics: { wrongRate: 0 },
              misses: [],
            }),
        });
      }),
  };
  return { gate, pending };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
/**
 * Waits until a background write has landed (polls, at most 10 s). A fixed 50 ms pause was too short on
 * slow CI runners: the check finished but the release row was still being written.
 */
async function eventually(
  ready: () => Promise<boolean> | boolean,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await ready())) {
    if (Date.now() > deadline) return;
    await settle();
  }
}

describeDb('FAQ release checks run in the background (PostgreSQL)', () => {
  const schema = `hdreleaseruns_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let db: SqlDb;
  let clock = Date.parse('2026-11-03T10:00:00.000Z');
  const now = () => new Date(clock);
  const actor = { employeeId: null };

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
    const repository = createPgFaqRepository(db);
    const graph = createPgFaqGraphRepository(db);
    const source = createPgFaqReleaseSource(graph);
    await seedFaqLibrary(
      {
        faqs: createFaqService({
          repository,
          releaseVersion: () => source.publishedVersion(),
          liveParents: (id) => graph.liveParents(id),
        }),
        repository,
        graph: createFaqGraphService({ graph }),
        releases: createFaqReleaseService({ graph }),
      },
      parseFaqLibrary(JSON.parse(readFileSync(LIBRARY, 'utf8'))),
      { actor, release: false },
    );
    // 跑全部 helpdesk 迁移再导入整个 FAQ 库：CI 上偶尔超过缺省的 5 秒（2026-11-06 一次）
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('returns evaluating at once, shows progress, refuses a second check while it runs, then lands the result', async () => {
    const graph = createPgFaqGraphRepository(db);
    const { gate, pending } = controlledGate();
    const errors: unknown[] = [];
    const service = createFaqReleaseService({
      graph,
      gate,
      now,
      background: true,
      onBackgroundError: (error) => errors.push(error),
    });
    // 长连接（faqReleaseStream.ts）靠这个立刻推：开始、进度、结果各通知一次
    let changes = 0;
    const unsubscribe = service.onChange(() => {
      changes += 1;
    });
    const { release, created } = await service.create(actor);
    expect(changes).toBe(1);
    expect(created).toBe(true);
    expect(release).toMatchObject({
      status: 'evaluating',
      publishable: false,
      evaluation: { state: 'running', progress: null },
    });
    await eventually(() => pending.length === 1);
    expect(pending).toHaveLength(1);
    const progress: FaqReleaseEvalProgress = {
      stage: 'model',
      done: 120,
      total: 300,
    };
    await expect(pending[0].input.progress?.(progress)).resolves.toBe(true);
    expect(changes).toBe(2);
    expect((await service.get(release.version)).evaluation).toMatchObject({
      state: 'running',
      progress,
    });
    await expect(service.check(release.version)).rejects.toMatchObject({
      status: 409,
      code: 'FAQ_RELEASE_EVALUATING',
    });
    pending[0].finish(true);
    await eventually(
      async () => (await service.get(release.version)).status === 'draft',
    );
    const done = await service.get(release.version);
    expect(done).toMatchObject({
      status: 'draft',
      publishable: true,
      evaluation: null,
      evalReport: { kind: 'model', passed: true, baselineVersion: null },
    });
    expect(changes).toBe(3);
    unsubscribe();
    expect(errors).toEqual([]);
  });

  it('shows a check whose heartbeat stopped as interrupted; a re-check takes over and the old run cannot write', async () => {
    const graph = createPgFaqGraphRepository(db);
    const { gate, pending } = controlledGate();
    const service = createFaqReleaseService({
      graph,
      gate,
      now,
      background: true,
      heartbeatMs: 60 * 60_000,
    });
    const [latest] = await graph.releases();
    // a fresh check of the draft from the previous test
    const started = await service.check(latest.version);
    expect(started.evaluation?.state).toBe('running');
    await eventually(() => pending.length === 1);
    expect(pending).toHaveLength(1);
    clock += EVAL_STALE_MS + 1_000;
    expect((await service.get(latest.version)).evaluation?.state).toBe(
      'interrupted',
    );
    const again = await service.check(latest.version);
    expect(again).toMatchObject({
      status: 'evaluating',
      evaluation: { state: 'running' },
    });
    expect(again.evalRun?.id).not.toBe(started.evalRun?.id);
    await eventually(() => pending.length === 2);
    expect(pending).toHaveLength(2);
    // the old run wakes up: its progress is refused and its result is dropped
    await expect(
      pending[0].input.progress?.({ stage: 'model', done: 1, total: 2 }),
    ).resolves.toBe(false);
    expect(pending[0].input.signal?.aborted).toBe(true);
    pending[0].finish(false);
    await settle();
    expect((await service.get(latest.version)).status).toBe('evaluating');
    pending[1].finish(true);
    await eventually(
      async () => (await service.get(latest.version)).status === 'draft',
    );
    expect((await service.get(latest.version)).status).toBe('draft');
  });

  it('treats an evaluating row from before background checks (no run) as interrupted and re-checks it', async () => {
    const graph = createPgFaqGraphRepository(db);
    const [latest] = await graph.releases();
    await db.query(
      `UPDATE helpdesk_faq_releases
          SET status = 'evaluating', eval_run_id = NULL, eval_started_at = NULL,
              eval_heartbeat_at = NULL, eval_progress = NULL
        WHERE version = $1`,
      [latest.version],
    );
    const service = createFaqReleaseService({
      graph,
      now,
      gate: createRetrievalGate(createPgFaqRepository(db), now),
    });
    expect((await service.get(latest.version)).evaluation).toEqual({
      state: 'interrupted',
      startedAt: null,
      progress: null,
    });
    // synchronous (the default): waits for the retrieval eval of the real library
    const checked = await service.check(latest.version);
    expect(checked.status).toBe('draft');
    expect(checked.evaluation).toBeNull();
  }, 60_000);
});
