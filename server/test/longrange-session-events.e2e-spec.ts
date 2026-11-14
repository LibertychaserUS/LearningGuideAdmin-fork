import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';

/**
 * 长程真实测试 T7 —— 学习会话事件（计划 §2 T7 / 设计 §14 C3 C8、§12 事件契约、C5 P7）。
 *
 * 黑盒边界：观察只经真实 HTTP（Portal 的公开 Route Handler
 * `POST /api/learning/events` 由一个测试夹具服务器原样挂载）+ 真实 PostgreSQL
 * `learning_events` 账本。测试不 import 任何 Portal/Admin 内部实现，也不断言私有字段；
 * PostgreSQL 只用于 arrange（建表/种子计划投影/清理）与旁证计数。
 *
 * 被测实现位于 Portal（事件域），Admin 侧本文件是长程测试的执行壳：启动夹具服务器时
 * 使用 Portal 自己的 `tsx` + `tsconfig-paths` 工具链，因此 `@/` 别名与真实 `pg` store
 * 均按生产路径运行。
 *
 * 覆盖：
 *  - eventId 幂等（重复提交不产生双份；他人复用 eventId 409 且不泄漏）；
 *  - completed 前必须有同 session+contentVersion+stageId 的 started；
 *  - 服务端 receivedAt 权威（客户端 occurredAt 原样保留，客户端时钟字段被拒）；
 *  - 离线补报超窗拒绝 / 未来时钟超 skew 拒绝（7 天 backlog、5 分钟 skew）；
 *  - 事件按 contentVersion + stageId 关联（未知版本/阶段 404，跨版本不串）；
 *  - 无计划投影部署的 v1 降级：按 contentVersionId 记录且 stageValidated=false。
 *
 * 运行：
 *   export DATABASE_URL=postgresql://admin:admin@localhost:5432/learning_guide_e2e
 *   cd LearningGuideAdmin/server && npm run test:e2e -- --runInBand longrange-session-events
 */

jest.setTimeout(240_000);

const DATABASE_URL =
  process.env.DATABASE_URL?.trim() ||
  'postgresql://admin:admin@localhost:5432/learning_guide_e2e';
const PORTAL_ROOT =
  process.env.LG_PORTAL_ROOT?.trim() ||
  path.resolve(__dirname, '../../../LearningGuidePortal');
const SERVER_SCRIPT = path.join(
  __dirname,
  'fixtures',
  'longrange',
  'scripts',
  'portal-events-server.ts',
);
const TSCONFIG_PATHS = path.join(
  PORTAL_ROOT,
  'scripts',
  'register-tsconfig-paths.cjs',
);

type Harness = {
  port: number;
  aliceToken: string;
  bobToken: string;
  aliceUserId: string;
  bobUserId: string;
  projection: boolean;
  child: ChildProcessWithoutNullStreams;
  dataDir: string;
  stop: () => Promise<void>;
};

let pg: Client;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startHarness(args: string[] = []): Promise<Harness> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'lg-longrange-t7-'));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--require', TSCONFIG_PATHS, SERVER_SCRIPT, ...args],
    {
      cwd: PORTAL_ROOT,
      env: {
        ...process.env,
        LG_PORTAL_ROOT: PORTAL_ROOT,
        LONGRANGE_DATA_DIR: dataDir,
        DATABASE_URL,
        // Local PostgreSQL has no TLS; the Portal pool honours this flag.
        DATABASE_SSL: '0',
        STORAGE_BACKEND: 'local',
        APP_ENV: 'DEV',
        PAYMENT_MODE: 'demo',
      },
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const deadline = Date.now() + 120_000;
  let ready: Omit<Harness, 'child' | 'dataDir' | 'stop'> | null = null;
  while (Date.now() < deadline) {
    const line = stdout
      .split('\n')
      .find((entry) => entry.startsWith('LONGRANGE_EVENTS_READY '));
    if (line) {
      ready = JSON.parse(line.slice('LONGRANGE_EVENTS_READY '.length)) as Omit<
        Harness,
        'child' | 'dataDir' | 'stop'
      >;
      break;
    }
    if (child.exitCode !== null) break;
    await sleep(150);
  }
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(
      `fixture server did not start (exit=${child.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  const harness: Harness = {
    ...ready,
    child,
    dataDir,
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        const stopDeadline = Date.now() + 10_000;
        while (child.exitCode === null && Date.now() < stopDeadline)
          await sleep(100);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return harness;
}

type ApiResult = {
  status: number;
  body: Record<string, unknown>;
  text: string;
};

async function postEvent(
  harness: Harness,
  body: unknown,
  token?: string,
): Promise<ApiResult> {
  const response = await fetch(
    `http://127.0.0.1:${harness.port}/api/learning/events`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { cookie: `learning_guide_session=${token}` } : {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  );
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* keep text */
  }
  return { status: response.status, body: parsed, text };
}

function eventBody(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: `sess-${Math.random().toString(36).slice(2, 10)}`,
    type: 'started',
    occurredAt: new Date().toISOString(),
    contentVersionId: 'cv-longrange-A',
    stageKey: 'step-A1',
    ...overrides,
  };
}

async function countByEventId(eventId: string) {
  const result = await pg.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM learning_events WHERE event_id = $1',
    [eventId],
  );
  return Number(result.rows[0]?.count || '0');
}

beforeAll(async () => {
  pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  // The Portal schema bootstrap (migration 029) owns these two tables; drop them
  // so this suite starts from a known empty ledger and re-creates them via the
  // real bootstrap when the fixture server starts.
  await pg.query('DROP TABLE IF EXISTS learning_events');
  await pg.query('DROP TABLE IF EXISTS learning_plan_entries');
});

afterAll(async () => {
  if (pg) {
    await pg.query('DROP TABLE IF EXISTS learning_events');
    await pg.query('DROP TABLE IF EXISTS learning_plan_entries');
    await pg.end();
  }
});

describe('T7 learning session events (real HTTP + real PostgreSQL)', () => {
  let strict: Harness;

  beforeAll(async () => {
    strict = await startHarness();
  });

  afterAll(async () => {
    if (strict) await strict.stop();
  });

  it('T7-auth: anonymous is 401 and no ledger row is written', async () => {
    const event = eventBody({ eventId: 'evt-t7-anonymous' });
    const result = await postEvent(strict, event);
    expect(result.status).toBe(401);
    expect(await countByEventId(String(event.eventId))).toBe(0);
  });

  it('T7-idempotency: a repeated eventId is a replay, never a second row', async () => {
    const event = eventBody({ eventId: 'evt-t7-idem', sessionId: 'sess-idem' });
    const first = await postEvent(strict, event, strict.aliceToken);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBe(false);
    expect((first.body.event as Record<string, unknown>).receivedAt).toEqual(
      expect.any(String),
    );
    expect(await countByEventId('evt-t7-idem')).toBe(1);

    // A replay with different client fields still returns the stored event.
    const replay = await postEvent(
      strict,
      { ...event, type: 'paused', occurredAt: '2020-01-01T00:00:00.000Z' },
      strict.aliceToken,
    );
    expect(replay.status).toBe(200);
    expect(replay.body.duplicate).toBe(true);
    expect((replay.body.event as Record<string, unknown>).type).toBe('started');
    expect(await countByEventId('evt-t7-idem')).toBe(1);

    // Another user reusing the id is refused without leaking the stored row.
    const conflict = await postEvent(
      strict,
      { ...event, sessionId: 'sess-bob' },
      strict.bobToken,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.text).toContain('EVENT_ID_CONFLICT');
    expect(conflict.text).not.toContain(strict.aliceUserId);
    expect(await countByEventId('evt-t7-idem')).toBe(1);
  });

  it('T7-ordering: completed requires a started in the same session, content version and stage', async () => {
    const sessionId = 'sess-order-1';
    const completedFirst = await postEvent(
      strict,
      eventBody({
        eventId: 'evt-t7-complete-first',
        sessionId,
        type: 'completed',
      }),
      strict.aliceToken,
    );
    expect(completedFirst.status).toBe(409);
    expect(completedFirst.text).toContain('COMPLETED_WITHOUT_STARTED');
    expect(await countByEventId('evt-t7-complete-first')).toBe(0);

    const started = await postEvent(
      strict,
      eventBody({ eventId: 'evt-t7-start-1', sessionId }),
      strict.aliceToken,
    );
    expect(started.status).toBe(200);
    expect((started.body.event as Record<string, unknown>).stageValidated).toBe(
      true,
    );

    // Same session but another content version must not satisfy the started check.
    const otherVersion = await postEvent(
      strict,
      eventBody({
        eventId: 'evt-t7-complete-other-version',
        sessionId,
        type: 'completed',
        contentVersionId: 'cv-longrange-B',
        stageKey: 'step-B1',
      }),
      strict.aliceToken,
    );
    expect(otherVersion.status).toBe(409);
    expect(otherVersion.text).toContain('COMPLETED_WITHOUT_STARTED');

    // Same version but another stage must not satisfy it either.
    const otherStage = await postEvent(
      strict,
      eventBody({
        eventId: 'evt-t7-complete-other-stage',
        sessionId,
        type: 'completed',
        stageKey: 'step-A2',
      }),
      strict.aliceToken,
    );
    expect(otherStage.status).toBe(409);
    expect(otherStage.text).toContain('COMPLETED_WITHOUT_STARTED');

    const completed = await postEvent(
      strict,
      eventBody({
        eventId: 'evt-t7-complete-ok',
        sessionId,
        type: 'completed',
      }),
      strict.aliceToken,
    );
    expect(completed.status).toBe(200);
    expect(completed.body.duplicate).toBe(false);
  });

  it('T7-clock: receivedAt is the server clock; client-owned fields are rejected', async () => {
    const clientOccurredAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const before = Date.now();
    const result = await postEvent(
      strict,
      eventBody({ eventId: 'evt-t7-clock', occurredAt: clientOccurredAt }),
      strict.aliceToken,
    );
    const after = Date.now();
    expect(result.status).toBe(200);
    const stored = result.body.event as Record<string, unknown>;
    expect(stored.occurredAt).toBe(clientOccurredAt);
    const receivedAt = Date.parse(String(stored.receivedAt));
    expect(Number.isNaN(receivedAt)).toBe(false);
    expect(receivedAt).toBeGreaterThanOrEqual(before - 2_000);
    expect(receivedAt).toBeLessThanOrEqual(after + 2_000);
    expect(stored.receivedAt).not.toBe(clientOccurredAt);

    const row = await pg.query<{ received_at: Date; occurred_at: Date }>(
      'SELECT received_at, occurred_at FROM learning_events WHERE event_id = $1',
      ['evt-t7-clock'],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].received_at.toISOString()).toBe(
      String(stored.receivedAt),
    );
    expect(row.rows[0].occurred_at.toISOString()).toBe(clientOccurredAt);

    for (const forbidden of [
      { userId: 'victim' },
      { receivedAt: new Date().toISOString() },
      { elapsedSeconds: 12 },
    ]) {
      const rejected = await postEvent(
        strict,
        {
          ...eventBody({
            eventId: `evt-t7-forbidden-${Object.keys(forbidden)[0]}`,
          }),
          ...forbidden,
        },
        strict.aliceToken,
      );
      expect(rejected.status).toBe(400);
      expect(rejected.text).toContain('INVALID_LEARNING_EVENT');
    }
  });

  it('T7-window: offline backlog beyond seven days and future skew beyond five minutes are refused', async () => {
    const now = Date.now();
    const at = (ms: number) => new Date(ms).toISOString();

    const backlogOver = await postEvent(
      strict,
      eventBody({
        eventId: 'evt-t7-backlog-over',
        occurredAt: at(now - 7 * 24 * 60 * 60_000 - 60_000),
      }),
      strict.aliceToken,
    );
    expect(backlogOver.status).toBe(400);
    expect(backlogOver.text).toContain('OCCURRED_AT_OUT_OF_WINDOW');

    const skewOver = await postEvent(
      strict,
      eventBody({
        eventId: 'evt-t7-skew-over',
        occurredAt: at(now + 5 * 60_000 + 60_000),
      }),
      strict.aliceToken,
    );
    expect(skewOver.status).toBe(400);
    expect(skewOver.text).toContain('OCCURRED_AT_OUT_OF_WINDOW');

    // Inside the window (offline replay just under seven days) is accepted.
    const backlogOk = await postEvent(
      strict,
      eventBody({
        eventId: 'evt-t7-backlog-ok',
        occurredAt: at(now - 7 * 24 * 60 * 60_000 + 60_000),
      }),
      strict.aliceToken,
    );
    expect(backlogOk.status).toBe(200);

    expect(await countByEventId('evt-t7-backlog-over')).toBe(0);
    expect(await countByEventId('evt-t7-skew-over')).toBe(0);
    expect(await countByEventId('evt-t7-backlog-ok')).toBe(1);
  });

  it('T7-association: event scope is contentVersion + stageId (unknown version/stage is 404, nothing written)', async () => {
    const unknownStage = await postEvent(
      strict,
      eventBody({
        eventId: 'evt-t7-unknown-stage',
        contentVersionId: 'cv-longrange-A',
        stageKey: 'step-A99',
      }),
      strict.aliceToken,
    );
    expect(unknownStage.status).toBe(404);
    expect(unknownStage.text).toContain('STAGE_NOT_FOUND');

    const unknownVersion = await postEvent(
      strict,
      eventBody({
        eventId: 'evt-t7-unknown-version',
        contentVersionId: 'cv-longrange-Z',
        stageKey: 'step-A1',
      }),
      strict.aliceToken,
    );
    expect(unknownVersion.status).toBe(404);
    expect(unknownVersion.text).toContain('CONTENT_VERSION_NOT_FOUND');

    // A stage that exists only in the other version is not accepted here.
    const crossVersionStage = await postEvent(
      strict,
      eventBody({
        eventId: 'evt-t7-cross-version-stage',
        contentVersionId: 'cv-longrange-A',
        stageKey: 'step-B1',
      }),
      strict.aliceToken,
    );
    expect(crossVersionStage.status).toBe(404);
    expect(crossVersionStage.text).toContain('STAGE_NOT_FOUND');

    expect(await countByEventId('evt-t7-unknown-stage')).toBe(0);
    expect(await countByEventId('evt-t7-unknown-version')).toBe(0);
    expect(await countByEventId('evt-t7-cross-version-stage')).toBe(0);
  });

  it('T7-v1-scope: without a plan projection, events are recorded by contentVersion with stageValidated=false', async () => {
    // Stop the strict server, clear the projection, start a deployment without one.
    await strict.stop();
    await pg.query('TRUNCATE learning_plan_entries');
    await pg.query('TRUNCATE learning_events');
    const degraded = await startHarness(['--no-projection']);
    try {
      const event = eventBody({
        eventId: 'evt-t7-no-projection',
        contentVersionId: 'cv-no-projection',
        stageKey: 'step-any',
      });
      const created = await postEvent(degraded, event, degraded.aliceToken);
      expect(created.status).toBe(200);
      expect(
        (created.body.event as Record<string, unknown>).stageValidated,
      ).toBe(false);
      expect(
        (created.body.event as Record<string, unknown>).contentVersionId,
      ).toBe('cv-no-projection');
      expect((created.body.event as Record<string, unknown>).stageKey).toBe(
        'step-any',
      );

      const completedFirst = await postEvent(
        degraded,
        eventBody({
          eventId: 'evt-t7-no-projection-complete',
          contentVersionId: 'cv-no-projection',
          stageKey: 'step-any',
          type: 'completed',
        }),
        degraded.aliceToken,
      );
      expect(completedFirst.status).toBe(409);
      expect(completedFirst.text).toContain('COMPLETED_WITHOUT_STARTED');
    } finally {
      await degraded.stop();
      // Restore the strict harness handle so afterAll can be a no-op on it.
      strict = { ...degraded, stop: () => Promise.resolve() };
    }
  });
});
