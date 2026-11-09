import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Pool } from 'pg';

import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';
import type { SqlDb } from '../modules/helpdesk/faqs/faqRepository';
import { createPgFaqRepository } from '../modules/helpdesk/faqs/faqRepository';
import { createFaqService } from '../modules/helpdesk/faqs/faqService';
import type { HelpdeskFaq } from '../modules/helpdesk/faqs/faqContracts';
import { createPgFaqGraphRepository } from '../modules/helpdesk/faqs/faqGraphRepository';
import { createFaqGraphService } from '../modules/helpdesk/faqs/faqGraphService';
import {
  FAQ_CHANGE_CHANNEL,
  PIPELINE,
  REVISION_TABLES,
  createFaqCommandBus,
  type CommandMeta,
  type FaqCommand,
  type FaqCommandBus,
} from '../modules/helpdesk/pipeline/faqCommandBus';
import {
  backOfficeFaqServices,
  createFaqCommands,
} from '../modules/helpdesk/pipeline/faqCommands';

/**
 * 写入流水线（设计文档「后端架构：接口、编排与中间件」）：在真的 PostgreSQL 上证明
 * 原子（中途抛错一行不留）、change_id 落到每张修订表、幂等重放、库级锁的先后、NOTIFY 只随提交发出。
 * 需要 HELPDESK_TEST_DATABASE_URL。
 */
const url = process.env.HELPDESK_TEST_DATABASE_URL;
if (!url && process.env.CI === 'true')
  throw new Error('HELPDESK_TEST_DATABASE_URL is required when CI=true');
const describeDb = url ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '../../../prisma/migrations');
const EMPLOYEE = '0190a000-0000-7000-8000-000000000001';
const staff = { employeeId: EMPLOYEE };
const asStaff: CommandMeta = {
  actor: { employeeId: EMPLOYEE },
  cause: { kind: 'ui' },
};

function card(n: number) {
  return {
    category: 'account_technical',
    questionEn: `Pipeline test question ${n}?`,
    answerEn: `Pipeline test answer ${n}.`,
    questionZh: `流水线测试问题 ${n}？`,
    answerZh: `流水线测试答案 ${n}。`,
    keywords: ['pipeline'],
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb('FAQ command bus (PostgreSQL)', () => {
  /** 测试用：让下一个事务在 COMMIT 之前停在这里（证明改动记录按提交先后编号）。 */
  let holdCommit: (() => Promise<void>) | null = null;
  const schema = `hdbus_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let db: SqlDb;
  let cards: HelpdeskFaq[] = [];

  const count = async (table: string, where = 'TRUE', params: unknown[] = []) =>
    Number(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
          params,
        )
      )[0].n,
    );

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
          const hold = holdCommit;
          holdCommit = null;
          if (hold) await hold();
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
    // 不经流水线（旧代码路径）建三张卡：它们的修订 change_id 是 NULL
    const faqs = createFaqService({ repository: createPgFaqRepository(db) });
    cards = [];
    for (const n of [1, 2, 3]) cards.push(await faqs.create(staff, card(n)));
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const bus = () =>
    createFaqCommandBus({ db, logger: { log: () => {}, warn: () => {} } });
  const commands = createFaqCommands({
    releaseVersion: () => Promise.resolve(null),
  });
  /** 一个真的写入：给一张卡（缺省第三张）加一句问法。 */
  const addPhrasing = (text: string, onCard = 2): FaqCommand<null, string> => ({
    name: 'test.add_phrasing',
    lock: 'shared',
    parse: () => null,
    run: async (_input, ctx) => {
      await createFaqGraphService({
        graph: createPgFaqGraphRepository(ctx.db),
      }).addPhrasing(staff, cards[onCard].id, { locale: 'en-GB', text });
      return ctx.changeId;
    },
  });

  it('declares the middleware order once', () => {
    expect(PIPELINE).toEqual([
      'trace',
      'actor',
      'change',
      'idempotency',
      'parse',
      'unitOfWork',
      'log',
    ]);
  });

  it('writes outside the pipeline keep change_id NULL (old code still works)', async () => {
    expect(await count('helpdesk_faq_revisions', 'change_id IS NULL')).toBe(3);
  });

  it('a card update carries one change_id into the revision and the change log', async () => {
    const before = cards[0];
    const { result, changeId, replayed } = await bus().execute(
      commands.cardUpdate,
      {
        employee: staff,
        faqId: before.id,
        body: {
          ...card(1),
          version: before.version,
          answerEn: 'Updated answer.',
        },
      },
      asStaff,
    );
    expect(replayed).toBe(false);
    expect(result.version).toBe(before.version + 1);
    cards[0] = result;
    const [revision] = await db.query(
      'SELECT change_id FROM helpdesk_faq_revisions WHERE faq_id = $1 AND version = $2',
      [before.id, result.version],
    );
    expect(revision.change_id).toBe(changeId);
    const [change] = await db.query(
      'SELECT * FROM helpdesk_faq_changes WHERE id = $1',
      [changeId],
    );
    expect(change).toMatchObject({
      command: 'card.update',
      actor: `human:${EMPLOYEE}`,
      employee_id: EMPLOYEE,
      cause_kind: 'ui',
      summary: { cards: 1 },
    });
    expect(String(change.trace_id)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is atomic across services: a failure after an edge, a phrasing and a card edit leaves no row behind', async () => {
    const counts = async () => ({
      edges: await count('helpdesk_faq_edges'),
      edgeRevisions: await count('helpdesk_faq_edge_revisions'),
      phrasings: await count('helpdesk_faq_phrasings'),
      revisions: await count('helpdesk_faq_revisions'),
      changes: await count('helpdesk_faq_changes'),
    });
    const before = await counts();
    const failing: FaqCommand<null, never> = {
      name: 'test.fail_half_way',
      lock: 'shared',
      parse: () => null,
      run: async (_input, ctx) => {
        const graph = createFaqGraphService({
          graph: createPgFaqGraphRepository(ctx.db),
        });
        await graph.createEdge(staff, cards[1].id, { childId: cards[2].id });
        await graph.addPhrasing(staff, cards[1].id, {
          locale: 'en-GB',
          text: 'half way phrasing',
        });
        await createFaqService({
          repository: createPgFaqRepository(ctx.db),
        }).update(staff, cards[1].id, {
          ...card(2),
          version: cards[1].version,
          answerEn: 'never saved',
        });
        throw new HelpdeskError(500, 'TEST_CRASH', 'crash after three writes');
      },
    };
    await expect(bus().execute(failing, null, asStaff)).rejects.toMatchObject({
      code: 'TEST_CRASH',
    });
    expect(await counts()).toEqual(before);
    expect((await createPgFaqRepository(db).get(cards[1].id))?.answerEn).toBe(
      'Pipeline test answer 2.',
    );
  });

  it('several services in one command share one change_id', async () => {
    const both: FaqCommand<null, string> = {
      name: 'test.edge_and_phrasing',
      lock: 'shared',
      parse: () => null,
      run: async (_input, ctx) => {
        const graph = createFaqGraphService({
          graph: createPgFaqGraphRepository(ctx.db),
        });
        await graph.createEdge(staff, cards[1].id, { childId: cards[2].id });
        await graph.addPhrasing(staff, cards[1].id, {
          locale: 'en-GB',
          text: 'shared change id',
        });
        return ctx.changeId;
      },
    };
    const { changeId } = await bus().execute(both, null, asStaff);
    expect(
      await count('helpdesk_faq_edge_revisions', 'change_id = $1', [changeId]),
    ).toBe(1);
    expect(
      await count('helpdesk_faq_phrasing_revisions', 'change_id = $1', [
        changeId,
      ]),
    ).toBe(1);
  });

  it('a 409 from the service rolls back and records nothing', async () => {
    const changes = await count('helpdesk_faq_changes');
    await expect(
      bus().execute(
        commands.cardUpdate,
        {
          employee: staff,
          faqId: cards[0].id,
          body: { ...card(1), version: 1, answerEn: 'stale' },
        },
        asStaff,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count('helpdesk_faq_changes')).toBe(changes);
  });

  describe('idempotency', () => {
    let runs = 0;
    const note: FaqCommand<{ text: string }, { text: string; n: number }> = {
      name: 'test.idempotent_phrasing',
      lock: 'shared',
      idempotent: true,
      parse: (raw) => raw as { text: string },
      run: async (input, ctx) => {
        runs += 1;
        await createFaqGraphService({
          graph: createPgFaqGraphRepository(ctx.db),
        }).addPhrasing(staff, cards[2].id, {
          locale: 'en-GB',
          text: input.text,
        });
        return { text: input.text, n: runs };
      },
    };
    const key = '0190a000-0000-7000-8000-0000000000aa';

    it('same key and request: replays the first result without writing again', async () => {
      const first = await bus().execute(
        note,
        { text: 'idempotent one' },
        { ...asStaff, idempotencyKey: key },
      );
      const again = await bus().execute(
        note,
        { text: 'idempotent one' },
        { ...asStaff, idempotencyKey: key },
      );
      expect(again).toEqual({ ...first, replayed: true });
      expect(runs).toBe(1);
      expect(
        await count('helpdesk_faq_changes', 'id = $1', [first.changeId]),
      ).toBe(1);
    });

    it('same key, different request: 422', async () => {
      await expect(
        bus().execute(
          note,
          { text: 'something else' },
          { ...asStaff, idempotencyKey: key },
        ),
      ).rejects.toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
    });

    it('two requests with one key at the same time: one write, one replay', async () => {
      const k = '0190a000-0000-7000-8000-0000000000bb';
      const before = runs;
      const [a, b] = await Promise.all([
        bus().execute(
          note,
          { text: 'race' },
          { ...asStaff, idempotencyKey: k },
        ),
        bus().execute(
          note,
          { text: 'race' },
          { ...asStaff, idempotencyKey: k },
        ),
      ]);
      expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
      expect(a.changeId).toBe(b.changeId);
      expect(await count('helpdesk_faq_phrasings', "text = 'race'")).toBe(1);
      expect(runs - before).toBeLessThanOrEqual(2);
    });
  });

  it('an exclusive (whole-library) command makes ordinary writes wait until it is done', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const importLike: FaqCommand<null, null> = {
      name: 'test.exclusive',
      lock: 'exclusive',
      parse: () => null,
      run: async () => {
        entered();
        await gate;
        order.push('exclusive done');
        return null;
      },
    };
    const exclusive = bus().execute(importLike, null, {
      actor: { employeeId: null, label: 'process:okf-import' },
      cause: { kind: 'import', ref: 'sha256:test' },
    });
    await inside;
    const ordinary = bus()
      .execute(
        commands.cardUpdate,
        {
          employee: staff,
          faqId: cards[2].id,
          body: {
            ...card(3),
            version: cards[2].version,
            answerEn: 'after import',
          },
        },
        asStaff,
      )
      .then(() => order.push('ordinary done'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(order).toEqual([]);
    release();
    await Promise.all([exclusive, ordinary]);
    expect(order).toEqual(['exclusive done', 'ordinary done']);
  });

  it('NOTIFY goes out on commit only, carrying the change_id', async () => {
    const listener = new Client({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    await listener.connect();
    const heard: string[] = [];
    listener.on('notification', (msg) => heard.push(String(msg.payload)));
    await listener.query(`LISTEN ${FAQ_CHANGE_CHANNEL}`);
    try {
      // 通知是整库的：别的测试文件同时在写，这里只看这两个命令自己的改动号
      let badId = '';
      const bad: FaqCommand<null, null> = {
        name: 'test.bad',
        lock: 'shared',
        parse: () => null,
        run: async (_input, ctx) => {
          badId = ctx.changeId;
          await createFaqGraphService({
            graph: createPgFaqGraphRepository(ctx.db),
          }).addPhrasing(staff, cards[2].id, {
            locale: 'en-GB',
            text: 'rolled back before notify',
          });
          throw new HelpdeskError(500, 'TEST', 'no');
        },
      };
      await bus()
        .execute(bad, null, asStaff)
        .catch(() => undefined);
      // 先回滚的那个若发了通知，会排在后提交的这个前面
      const { changeId } = await bus().execute(
        addPhrasing('notify on commit'),
        null,
        asStaff,
      );
      if (!changeId || !badId) throw new Error('expected both change ids');
      const deadline = Date.now() + 2_000;
      while (!heard.includes(changeId) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(heard.filter((id) => id === changeId || id === badId)).toEqual([
        changeId,
      ]);
    } finally {
      await listener.end();
    }
  });

  it('checks the actor: a human label must be the signed-in employee; programs name themselves', async () => {
    const noop: FaqCommand<null, null> = {
      name: 'test.noop',
      lock: 'shared',
      parse: () => null,
      run: () => Promise.resolve(null),
    };
    await expect(
      bus().execute(noop, null, {
        actor: {
          employeeId: EMPLOYEE,
          label: 'human:0190a000-0000-7000-8000-000000000999',
        },
        cause: { kind: 'ui' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      bus().execute(noop, null, {
        actor: { employeeId: null },
        cause: { kind: 'seed' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    // UUID 不分大小写：大写写的 human 标签和小写的员工 id 是同一个人，按小写记
    const human = await bus().execute(
      addPhrasing('upper-case human label'),
      null,
      {
        actor: {
          employeeId: EMPLOYEE,
          label: `human:${EMPLOYEE.toUpperCase()}`,
        },
        cause: { kind: 'ui' },
      },
    );
    const [byHuman] = await db.query(
      'SELECT actor FROM helpdesk_faq_changes WHERE id = $1',
      [human.changeId],
    );
    expect(byHuman).toEqual({ actor: `human:${EMPLOYEE}` });
    const { changeId } = await bus().execute(
      addPhrasing('written by a tool'),
      null,
      {
        actor: { employeeId: null, label: 'claude-agent/ground-check' },
        cause: { kind: 'system' },
      },
    );
    const [row] = await db.query(
      'SELECT actor, employee_id FROM helpdesk_faq_changes WHERE id = $1',
      [changeId],
    );
    expect(row).toEqual({
      actor: 'claude-agent/ground-check',
      employee_id: null,
    });
  });

  it('the change log is append-only', async () => {
    await expect(
      db.query('DELETE FROM helpdesk_faq_changes'),
    ).rejects.toThrow();
  });

  it('a write that changes nothing records nothing and notifies nobody', async () => {
    const changes = await count('helpdesk_faq_changes');
    const current = cards[0];
    // PUT 同样的内容：服务原样返回，不升版本、不写修订
    const same = await bus().execute(
      commands.cardUpdate,
      {
        employee: staff,
        faqId: current.id,
        body: {
          ...card(1),
          answerEn: current.answerEn,
          version: current.version,
        },
      },
      asStaff,
    );
    expect(same).toEqual({ result: current, changeId: null, replayed: false });
    expect(await count('helpdesk_faq_changes')).toBe(changes);
  });

  it('the summary is counted from the revisions, not reported by the handler', async () => {
    const mixed: FaqCommand<null, null> = {
      name: 'test.mixed',
      lock: 'shared',
      parse: () => null,
      run: async (_input, ctx) => {
        const graph = createFaqGraphService({
          graph: createPgFaqGraphRepository(ctx.db),
        });
        await graph.addPhrasing(staff, cards[0].id, {
          locale: 'en-GB',
          text: 'summary one',
        });
        await graph.addPhrasing(staff, cards[0].id, {
          locale: 'zh-CN',
          text: '摘要二',
        });
        const current = await createFaqService({
          repository: createPgFaqRepository(ctx.db),
        }).get(cards[1].id);
        await createFaqService({
          repository: createPgFaqRepository(ctx.db),
        }).update(staff, current.id, {
          ...card(2),
          answerEn: 'Counted from the revisions.',
          version: current.version,
        });
        return null;
      },
    };
    const { changeId } = await bus().execute(mixed, null, asStaff);
    const [row] = await db.query(
      'SELECT summary FROM helpdesk_faq_changes WHERE id = $1',
      [changeId],
    );
    expect(row.summary).toEqual({ cards: 1, phrasings: 2 });
  });

  it('every table with a change_id column is counted (a new revision table cannot be missed)', async () => {
    const rows = await db.query(
      `SELECT table_name FROM information_schema.columns
        WHERE column_name = 'change_id' AND table_schema = current_schema()
          AND table_name NOT IN ('helpdesk_idempotency')
        ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(
      Object.values(REVISION_TABLES).sort(),
    );
  });

  it('change log numbers follow commit order (a reader going by seq never skips a row)', async () => {
    let atCommit!: () => void;
    const firstAtCommit = new Promise<void>((resolve) => (atCommit = resolve));
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => (letGo = resolve));
    holdCommit = async () => {
      atCommit();
      await held;
    };
    // 两张不同的卡：彼此没有行锁，能挡住第二个的只有改动记录的尾锁
    const first = bus().execute(
      addPhrasing('commit order one', 0),
      null,
      asStaff,
    );
    await firstAtCommit;
    let secondDone = false;
    const second = bus()
      .execute(addPhrasing('commit order two', 1), null, asStaff)
      .then((outcome) => {
        secondDone = true;
        return outcome;
      });
    try {
      await sleep(200);
      // 第一个已经拿到编号但还没提交：第二个必须等它，不能先提交一个更大的编号
      expect(secondDone).toBe(false);
    } finally {
      letGo();
    }
    const [a, b] = await Promise.all([first, second]);
    const seq = async (id: string | null) =>
      Number(
        (
          await db.query('SELECT seq FROM helpdesk_faq_changes WHERE id = $1', [
            id,
          ])
        )[0].seq,
      );
    expect(await seq(a.changeId)).toBeLessThan(await seq(b.changeId));
  });

  it('BackOffice services: writes go through the pipeline as the signed-in employee, reads do not', async () => {
    const services = backOfficeFaqServices({
      bus: bus(),
      commands,
      faqs: createFaqService({ repository: createPgFaqRepository(db) }),
      graph: createFaqGraphService({ graph: createPgFaqGraphRepository(db) }),
    });
    const before = await count('helpdesk_faq_changes');
    const upper = { employeeId: EMPLOYEE.toUpperCase(), displayName: 'Staff' };
    const current = await services.faqs.get(cards[2].id);
    const updated = await services.faqs.update(upper, current.id, {
      ...card(3),
      answerEn: 'Through the BackOffice services.',
      version: current.version,
    });
    expect(updated.version).toBe(current.version + 1);
    const [change] = await db.query(
      'SELECT command, actor, employee_id, cause_kind FROM helpdesk_faq_changes ORDER BY seq DESC LIMIT 1',
    );
    expect(change).toEqual({
      command: 'card.update',
      actor: `human:${EMPLOYEE}`,
      employee_id: EMPLOYEE,
      cause_kind: 'ui',
    });
    // 已有同样的问法：200 { created: false }，什么都没改，不记改动
    const again = await services.graph.addPhrasing(staff, cards[2].id, {
      locale: 'en-GB',
      text: 'notify on commit',
    });
    expect(again.created).toBe(false);
    await services.faqs.list({});
    await services.graph.tree(cards[0].id);
    expect(await count('helpdesk_faq_changes')).toBe(before + 1);
  });
});

describe('BackOffice FAQ services: every write method goes through the bus', () => {
  it('routes the nine writes to their commands and leaves reads alone', async () => {
    const commands = createFaqCommands({
      releaseVersion: () => Promise.resolve(null),
    });
    const sent: string[] = [];
    const bus = {
      execute: (
        command: FaqCommand<unknown, unknown>,
        _raw: unknown,
        meta: CommandMeta,
      ) => {
        sent.push(
          `${command.name} ${meta.actor.employeeId} ${meta.cause.kind}`,
        );
        return Promise.resolve({
          result: { ok: true },
          changeId: null,
          replayed: false,
        });
      },
    } as unknown as FaqCommandBus;
    const read = () => Promise.reject(new Error('read went to the service'));
    const reads = new Proxy({}, { get: () => read });
    const services = backOfficeFaqServices({
      bus,
      commands,
      faqs: reads as never,
      graph: reads as never,
    });
    const e = staff;
    await services.faqs.create(e, {});
    await services.faqs.update(e, 'f', {});
    await services.faqs.archive(e, 'f', {});
    await services.graph.createEdge(e, 'f', {});
    await services.graph.updateEdge(e, 'x', {});
    await services.graph.deleteEdge(e, 'x');
    await services.graph.reorder(e, 'f', {});
    await services.graph.addPhrasing(e, 'f', {});
    await services.graph.deletePhrasing(e, 'p');
    expect(sent).toEqual(
      [
        'card.create',
        'card.update',
        'card.archive',
        'edge.create',
        'edge.update',
        'edge.delete',
        'edge.reorder',
        'phrasing.add',
        'phrasing.delete',
      ].map((name) => `${name} ${EMPLOYEE} ui`),
    );
    await expect(services.faqs.get('f')).rejects.toThrow(
      'read went to the service',
    );
    await expect(services.graph.tree('f')).rejects.toThrow(
      'read went to the service',
    );
  });
});
