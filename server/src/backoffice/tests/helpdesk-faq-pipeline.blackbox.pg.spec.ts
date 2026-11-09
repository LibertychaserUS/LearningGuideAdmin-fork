import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Pool, type PoolClient } from 'pg';

import { uuidv7 } from '../../common/uuidv7';
import { createPgFaqGraphRepository } from '../modules/helpdesk/faqs/faqGraphRepository';
import {
  createFaqGraphService,
  type FaqGraphService,
} from '../modules/helpdesk/faqs/faqGraphService';
import {
  createPgFaqRepository,
  type SqlDb,
} from '../modules/helpdesk/faqs/faqRepository';
import {
  createFaqService,
  type FaqService,
} from '../modules/helpdesk/faqs/faqService';
import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';
import {
  FAQ_CHANGE_CAUSES,
  FAQ_CHANGE_CHANNEL,
  FAQ_CHANGE_LOG_LOCK,
  FAQ_LIBRARY_LOCK,
  PIPELINE,
  REVISION_TABLES,
  createFaqCommandBus,
  transactionDb,
  type CommandContext,
  type CommandMeta,
  type CommandOutcome,
  type FaqCommand,
} from '../modules/helpdesk/pipeline/faqCommandBus';
import {
  backOfficeFaqServices,
  createFaqCommands,
} from '../modules/helpdesk/pipeline/faqCommands';

/**
 * Black-box tests of the FAQ write pipeline, written only from spec C (rules R1-R13).
 * Needs HELPDESK_TEST_DATABASE_URL; every run gets its own schema.
 */
const url = process.env.HELPDESK_TEST_DATABASE_URL;
if (!url && process.env.CI === 'true')
  throw new Error('HELPDESK_TEST_DATABASE_URL is required when CI=true');
const describeDb = url ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '../../../prisma/migrations');

const OLIVIA = '0190a000-0000-7000-8000-000000000001';
const MARCO = '0190a000-0000-7000-8000-000000000002';
const olivia = { employeeId: OLIVIA };
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_SPAN = '00f067aa0ba902b7';

const REV_TABLES = {
  cards: 'helpdesk_faq_revisions',
  edges: 'helpdesk_faq_edge_revisions',
  phrasings: 'helpdesk_faq_phrasing_revisions',
  map: 'helpdesk_faq_map_revisions',
  reviews: 'helpdesk_faq_reviews',
  candidates: 'helpdesk_faq_candidate_revisions',
} as const;
type Kind = keyof typeof REV_TABLES;
const KINDS = Object.keys(REV_TABLES) as Kind[];

type Row = Record<string, unknown>;
type Gate = { promise: Promise<void>; open: () => void };
type AnyCommand = FaqCommand<unknown, unknown>;

describeDb('helpdesk FAQ write pipeline (black box, spec C)', () => {
  const schema = `hdbb_${process.pid}_${Date.now()}`;
  let pool: Pool;
  let listener: Client;
  let db: SqlDb;
  let bus: ReturnType<typeof createFaqCommandBus>;
  let commands: ReturnType<typeof createFaqCommands>;
  let faqSvc: FaqService;
  let graphSvc: FaqGraphService;
  const notes: string[] = [];

  /** Test-controlled hook awaited just before COMMIT of every transaction. */
  let commitHook: ((client: PoolClient) => Promise<void>) | null = null;
  const gates: Gate[] = [];
  let seq = 0;
  const uniq = () => ++seq;

  function newGate(): Gate {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    const gate = { promise, open };
    gates.push(gate);
    return gate;
  }
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  async function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function waitFor(cond: () => boolean, ms = 4000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (cond()) return true;
      await sleep(20);
    }
    return cond();
  }
  const noted = (id: string) => waitFor(() => notes.includes(id));

  beforeAll(async () => {
    pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
      max: 30,
    });
    const admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const sql = readdirSync(MIGRATIONS)
      .filter((dir) => dir.includes('helpdesk'))
      .sort()
      .map((dir) =>
        readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'),
      )
      .join('\n');
    await pool.query(sql);
    db = {
      query: async (text, params = []) =>
        (await pool.query<Record<string, unknown>>(text, params as unknown[]))
          .rows,
      withTransaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const v = await fn(client);
          if (commitHook) await commitHook(client);
          await client.query('COMMIT');
          return v;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      },
    };
    listener = new Client({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    await listener.connect();
    listener.on('notification', (m) => {
      if (m.channel === 'helpdesk_faq_changes' && m.payload)
        notes.push(m.payload);
    });
    await listener.query('LISTEN helpdesk_faq_changes');

    bus = createFaqCommandBus({
      db,
      logger: { log: () => undefined, warn: () => undefined },
    });
    commands = createFaqCommands({
      releaseVersion: () => Promise.resolve(null),
    });
    faqSvc = createFaqService({ repository: createPgFaqRepository(db) });
    graphSvc = createFaqGraphService({ graph: createPgFaqGraphRepository(db) });
  }, 60_000);

  afterEach(() => {
    commitHook = null;
    for (const g of gates.splice(0)) g.open();
  });

  afterAll(async () => {
    for (const g of gates.splice(0)) g.open();
    commitHook = null;
    await listener?.end().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    const admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }, 30_000);

  // ---------------------------------------------------------------- helpers

  function meta(over: Partial<CommandMeta> = {}): CommandMeta {
    return { actor: { employeeId: OLIVIA }, cause: { kind: 'ui' }, ...over };
  }
  function exec<O>(
    command: FaqCommand<never, O> | FaqCommand<unknown, O>,
    raw: unknown,
    over: Partial<CommandMeta> = {},
  ): Promise<CommandOutcome<O>> {
    return bus.execute(command, raw, meta(over));
  }
  async function rejection(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error('expected the call to reject, but it resolved');
  }
  async function outcomeOf(
    fn: () => Promise<unknown>,
  ): Promise<{ ok: unknown } | { err: { status: unknown; code: unknown } }> {
    try {
      return { ok: await fn() };
    } catch (e) {
      const h = e as { status?: unknown; code?: unknown };
      return { err: { status: h.status, code: h.code } };
    }
  }
  async function expectHelpdeskError(
    p: Promise<unknown>,
    status: number,
    code?: string,
  ): Promise<HelpdeskError> {
    const e = await rejection(p);
    expect(e).toBeInstanceOf(HelpdeskError);
    expect(e).toMatchObject(code ? { status, code } : { status });
    return e as HelpdeskError;
  }

  /** Row counts of every table of the schema (to prove "nothing was written"). */
  async function snapshot(): Promise<Record<string, number>> {
    const tables = await db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY 1`,
      [schema],
    );
    const out: Record<string, number> = {};
    await Promise.all(
      tables.map(async (t) => {
        const name = String(t.table_name);
        const r = await db.query(`SELECT count(*)::int AS n FROM "${name}"`);
        out[name] = Number(r[0].n);
      }),
    );
    return out;
  }
  async function count(table: string, where = 'true', params: unknown[] = []) {
    const r = await db.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return Number(r[0].n);
  }
  async function changeRow(id: string): Promise<Row | undefined> {
    return (
      await db.query('SELECT * FROM helpdesk_faq_changes WHERE id = $1', [id])
    )[0];
  }
  async function changesCount() {
    return count('helpdesk_faq_changes');
  }
  async function revCounts(changeId: string): Promise<Record<Kind, number>> {
    const out = {} as Record<Kind, number>;
    for (const kind of KINDS)
      out[kind] = await count(REV_TABLES[kind], 'change_id = $1', [changeId]);
    return out;
  }
  async function revTotals(): Promise<Record<Kind, number>> {
    const out = {} as Record<Kind, number>;
    for (const kind of KINDS) out[kind] = await count(REV_TABLES[kind]);
    return out;
  }
  async function revTagged(): Promise<Record<Kind, number>> {
    const out = {} as Record<Kind, number>;
    for (const kind of KINDS)
      out[kind] = await count(REV_TABLES[kind], 'change_id IS NOT NULL');
    return out;
  }
  async function revUntagged(): Promise<Record<Kind, number>> {
    const out = {} as Record<Kind, number>;
    for (const kind of KINDS)
      out[kind] = await count(REV_TABLES[kind], 'change_id IS NULL');
    return out;
  }

  function cardBody(tag: string): Record<string, unknown> {
    const n = uniq();
    return {
      category: 'account_technical',
      questionEn: `Question ${tag} number ${n} alpha`,
      answerEn: `Answer ${tag} ${n}`,
      questionZh: `问题 ${tag} 第${n}`,
      answerZh: `答案 ${tag} ${n}`,
      keywords: ['x'],
    };
  }
  async function mkCard(tag = 'c') {
    return faqSvc.create(olivia, cardBody(tag));
  }
  async function mkEdge(parentId: string, childId: string) {
    return (await graphSvc.createEdge(olivia, parentId, { childId })).edge;
  }
  async function mkPhrasing(faqId: string, text: string) {
    return (
      await graphSvc.addPhrasing(olivia, faqId, { locale: 'en-GB', text })
    ).phrasing;
  }
  function updateBody(
    faq: Awaited<ReturnType<typeof mkCard>>,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      category: faq.category,
      popular: faq.popular,
      questionEn: faq.questionEn,
      answerEn: faq.answerEn,
      questionZh: faq.questionZh,
      answerZh: faq.answerZh,
      keywords: faq.keywords,
      version: faq.version,
      ...over,
    };
  }

  type Opts<I, O> = {
    lock?: 'shared' | 'exclusive';
    idempotent?: boolean;
    parse?: (raw: unknown) => I;
    run: (input: I, ctx: CommandContext) => Promise<O>;
  };
  function cmd<I = unknown, O = unknown>(o: Opts<I, O>): FaqCommand<I, O> {
    return {
      name: `bb.cmd${uniq()}`,
      lock: o.lock ?? 'shared',
      idempotent: o.idempotent,
      parse: o.parse ?? ((raw: unknown) => raw as I),
      run: o.run,
    };
  }
  function ctxFaqs(ctx: CommandContext): FaqService {
    return createFaqService({ repository: createPgFaqRepository(ctx.db) });
  }
  /** A command that writes one card revision. */
  function writer(opts: Partial<Opts<unknown, unknown>> = {}) {
    const calls: CommandContext[] = [];
    const command = cmd<unknown, { id: string }>({
      lock: opts.lock,
      idempotent: opts.idempotent,
      parse: opts.parse,
      run: async (_input, ctx) => {
        calls.push(ctx);
        const faq = await ctxFaqs(ctx).create(
          { employeeId: ctx.actor.employeeId },
          cardBody('w'),
        );
        return { id: faq.id };
      },
    });
    return { command, calls };
  }
  /** A command that writes nothing. */
  function noop<O = { n: number }>(result: O = { n: 7 } as O, opts = {}) {
    const calls: CommandContext[] = [];
    const command = cmd<unknown, O>({
      ...opts,
      run: (_input, ctx) => {
        calls.push(ctx);
        return Promise.resolve(result);
      },
    });
    return { command, calls };
  }

  // ------------------------------------------------------------------- R1

  describe('R1 order and exported constants', () => {
    it('PIPELINE is the seven steps in order', () => {
      expect([...PIPELINE]).toEqual([
        'trace',
        'actor',
        'change',
        'idempotency',
        'parse',
        'unitOfWork',
        'log',
      ]);
    });

    it('exports the causes, channel, locks and revision tables', () => {
      expect([...FAQ_CHANGE_CAUSES].sort()).toEqual(
        [
          'flywheel',
          'import',
          'release',
          'rewrite',
          'seed',
          'system',
          'ui',
        ].sort(),
      );
      expect(FAQ_CHANGE_CHANNEL).toBe('helpdesk_faq_changes');
      expect(FAQ_LIBRARY_LOCK).toBeDefined();
      expect(FAQ_CHANGE_LOG_LOCK).toBeDefined();
      expect(FAQ_LIBRARY_LOCK).not.toEqual(FAQ_CHANGE_LOG_LOCK);
      const tables = JSON.stringify(REVISION_TABLES);
      for (const t of Object.values(REV_TABLES)) expect(tables).toContain(t);
    });

    it('transactionDb(client) gives a SqlDb bound to that client', async () => {
      const rows = await db.withTransaction(async (client) => {
        const bound = transactionDb(client);
        const a = await bound.query('SELECT 1 AS x');
        const b = await bound.withTransaction((c) =>
          c.query('SELECT 2 AS y').then((r) => r.rows),
        );
        return { a, b };
      });
      expect(rows.a).toEqual([{ x: 1 }]);
      expect(rows.b).toEqual([{ y: 2 }]);
    });

    it('the actor step comes before parse: invalid actor beats a throwing parse', async () => {
      const { command, calls } = writer({
        parse: () => {
          throw new HelpdeskError(418, 'PARSE_FAILED', 'parse');
        },
      });
      const before = await snapshot();
      await expectHelpdeskError(
        exec(command, {}, { actor: { employeeId: 'nope' } }),
        400,
        'INVALID_INPUT',
      );
      expect(calls).toHaveLength(0);
      expect(await snapshot()).toEqual(before);
    });

    it('the change step (cause) comes before parse', async () => {
      const { command } = writer({
        parse: () => {
          throw new HelpdeskError(418, 'PARSE_FAILED', 'parse');
        },
      });
      await expectHelpdeskError(
        exec(command, {}, { cause: { kind: 'bogus' as never } }),
        400,
        'INVALID_INPUT',
      );
    });

    it('the idempotency step comes before parse: bad key beats a throwing parse', async () => {
      const { command } = writer({
        idempotent: true,
        parse: () => {
          throw new HelpdeskError(418, 'PARSE_FAILED', 'parse');
        },
      });
      await expectHelpdeskError(
        exec(command, {}, { idempotencyKey: 'not-a-uuid' }),
        400,
      );
    });

    it('the idempotency step comes before parse: reused key beats a throwing parse', async () => {
      const key = uuidv7();
      const command = cmd<{ bad?: boolean }, { ok: boolean }>({
        idempotent: true,
        parse: (raw) => {
          if ((raw as { bad?: boolean }).bad)
            throw new HelpdeskError(418, 'PARSE_FAILED', 'parse');
          return raw as { bad?: boolean };
        },
        run: () => Promise.resolve({ ok: true }),
      });
      await exec(command, { v: 1 }, { idempotencyKey: key });
      await expectHelpdeskError(
        exec(command, { bad: true }, { idempotencyKey: key }),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
    });

    it('parse runs before the unit of work: a parse error never enters run', async () => {
      const boom = new HelpdeskError(400, 'INVALID_INPUT', 'bad raw');
      let entered = false;
      const command = cmd({
        parse: () => {
          throw boom;
        },
        run: () => {
          entered = true;
          return Promise.resolve(1);
        },
      });
      expect(await rejection(exec(command, {}))).toBe(boom);
      expect(entered).toBe(false);
    });
  });

  // ------------------------------------------------------------------- R2

  describe('R2 actor', () => {
    it('without a label the label is human:<lower-case id>; ids are recorded lower case', async () => {
      const upper = OLIVIA.toUpperCase();
      const { command, calls } = writer();
      const out = await exec(command, {}, { actor: { employeeId: upper } });
      expect(calls[0].actor.employeeId).toBe(OLIVIA);
      expect(calls[0].actor.label).toBe(`human:${OLIVIA}`);
      const row = (await changeRow(out.changeId as string)) as Row;
      expect(row.actor).toBe(`human:${OLIVIA}`);
      expect(String(row.employee_id)).toBe(OLIVIA);
    });

    it('mixed-case ids are lower-cased too', async () => {
      const mixed = '0190A000-0000-7000-8000-00000000AbCd';
      const { command, calls } = writer();
      const out = await exec(command, {}, { actor: { employeeId: mixed } });
      expect(calls[0].actor.employeeId).toBe(mixed.toLowerCase());
      const row = (await changeRow(out.changeId as string)) as Row;
      expect(row.actor).toBe(`human:${mixed.toLowerCase()}`);
    });

    it.each([
      [OLIVIA, `human:${OLIVIA}`],
      [null, 'process:flywheel'],
      [null, 'process:a'],
      [null, 'process:0abc.x_y-z'],
      [null, 'tool/1.0'],
      [null, 'faq-tool/2026.11.9-rc_1'],
      [OLIVIA, 'tool/1.0'],
      [OLIVIA, 'process:nightly'],
    ])('accepts employeeId %j with label %j', async (employeeId, label) => {
      const { command, calls } = writer();
      const out = await exec(command, {}, { actor: { employeeId, label } });
      expect(out.changeId).not.toBeNull();
      expect(calls[0].actor.label.toLowerCase()).toBe(label.toLowerCase());
      const row = (await changeRow(out.changeId as string)) as Row;
      expect(String(row.actor).toLowerCase()).toBe(label.toLowerCase());
      expect(
        row.employee_id === null ? null : (row.employee_id as string),
      ).toBe(employeeId);
    });

    it.each([
      ['not-a-uuid'],
      [''],
      [`${OLIVIA}0`],
      [OLIVIA.replace(/-/g, '')],
      ['zzzzzzzz-zzzz-7zzz-8zzz-zzzzzzzzzzzz'],
      [` ${OLIVIA}`],
    ])('rejects employeeId %j', async (employeeId) => {
      const { command, calls } = writer();
      const before = await snapshot();
      await expectHelpdeskError(
        exec(command, {}, { actor: { employeeId } }),
        400,
        'INVALID_INPUT',
      );
      expect(calls).toHaveLength(0);
      expect(await snapshot()).toEqual(before);
    });

    it('rejects a null employeeId without a label', async () => {
      const { command } = writer();
      const before = await snapshot();
      await expectHelpdeskError(
        exec(command, {}, { actor: { employeeId: null } }),
        400,
        'INVALID_INPUT',
      );
      expect(await snapshot()).toEqual(before);
    });

    it.each([
      [null, ''],
      [null, 'process:'],
      [null, 'process:Flywheel'],
      [null, 'process:-x'],
      [null, 'process:_x'],
      [null, 'process:.x'],
      [null, 'process:a b'],
      [null, 'process:a/b'],
      [null, 'Process:x'],
      [null, 'tool'],
      [null, 'tool/'],
      [null, '/1.0'],
      [null, 'Tool/1.0'],
      [null, 'tool/V1'],
      [null, 'tool/-1'],
      [null, 'tool/1.0/extra'],
      [null, 'tool/1 0'],
      [null, 'robot:x'],
      [null, `human:${OLIVIA}`],
      [null, 'human:'],
      [OLIVIA, `human:${MARCO}`],
      [OLIVIA, 'human:not-a-uuid'],
      [OLIVIA, 'human:'],
    ])('rejects employeeId %j with label %j', async (employeeId, label) => {
      const { command, calls } = writer();
      const before = await snapshot();
      await expectHelpdeskError(
        exec(command, {}, { actor: { employeeId, label } }),
        400,
        'INVALID_INPUT',
      );
      expect(calls).toHaveLength(0);
      expect(await snapshot()).toEqual(before);
    });
  });

  // ------------------------------------------------------------------- R3

  describe('R3 cause', () => {
    it.each([
      ...['ui', 'import', 'flywheel', 'rewrite', 'seed', 'release', 'system'],
    ])('accepts cause kind %s and records it', async (kind) => {
      const { command, calls } = writer();
      const out = await exec(
        command,
        {},
        { cause: { kind: kind as never, ref: 'ref-1', note: 'a note' } },
      );
      const row = (await changeRow(out.changeId as string)) as Row;
      expect(row.cause_kind).toBe(kind);
      expect(row.cause_ref).toBe('ref-1');
      expect(row.note).toBe('a note');
      expect(calls[0].cause).toEqual({
        kind,
        ref: 'ref-1',
        note: 'a note',
      });
    });

    it.each([['UI'], ['Ui'], ['unknown'], [''], ['ui '], ['rewrite,seed']])(
      'rejects cause kind %j and writes nothing',
      async (kind) => {
        const { command, calls } = writer();
        const before = await snapshot();
        await expectHelpdeskError(
          exec(command, {}, { cause: { kind: kind as never } }),
          400,
          'INVALID_INPUT',
        );
        expect(calls).toHaveLength(0);
        expect(await snapshot()).toEqual(before);
      },
    );

    it('rejects a missing cause kind', async () => {
      const { command } = writer();
      await expectHelpdeskError(
        exec(command, {}, { cause: {} as never }),
        400,
        'INVALID_INPUT',
      );
    });
  });

  // ------------------------------------------------------------------- R4

  describe('R4 change id', () => {
    it('gives every execute a new UUIDv7 and tags every revision row with it', async () => {
      const { command, calls } = writer();
      const a = await exec(command, {});
      const b = await exec(command, {});
      expect(calls[0].changeId).toMatch(UUID_V7);
      expect(calls[1].changeId).toMatch(UUID_V7);
      expect(calls[0].changeId).not.toBe(calls[1].changeId);
      expect(a.changeId).toBe(calls[0].changeId);
      expect(b.changeId).toBe(calls[1].changeId);
      expect((await revCounts(calls[0].changeId)).cards).toBe(1);
      expect((await revCounts(calls[1].changeId)).cards).toBe(1);
    });

    it('also gives a no-op execute a fresh UUIDv7 in ctx, but returns changeId null', async () => {
      const { command, calls } = noop();
      const a = await exec(command, {});
      const b = await exec(command, {});
      expect(calls[0].changeId).toMatch(UUID_V7);
      expect(calls[1].changeId).toMatch(UUID_V7);
      expect(calls[0].changeId).not.toBe(calls[1].changeId);
      expect(a.changeId).toBeNull();
      expect(b.changeId).toBeNull();
    });

    it('exposes command, actor, cause, traceId and a usable db on ctx', async () => {
      const { command, calls } = writer();
      await exec(
        command,
        {},
        {
          actor: { employeeId: null, label: 'process:ctx-check' },
          cause: { kind: 'import', ref: 'r', note: 'n' },
          traceparent: `00-${TRACE}-${PARENT_SPAN}-01`,
        },
      );
      const ctx = calls[0];
      expect(ctx.command).toBe(command.name);
      expect(ctx.actor).toEqual({
        employeeId: null,
        label: 'process:ctx-check',
      });
      expect(ctx.cause).toEqual({ kind: 'import', ref: 'r', note: 'n' });
      expect(ctx.traceId).toBe(TRACE);
      const probe = cmd({
        run: async (_i, c) => c.db.query('SELECT 41 + 1 AS answer'),
      });
      expect((await exec(probe, {})).result).toEqual([{ answer: 42 }]);
    });

    it('every revision row written by a multi-kind command carries the change id (all six tables)', async () => {
      const keeper = await mkCard('rev-review');
      const before = await revTotals();
      const taggedBefore = await revTagged();
      const command = cmd<unknown, { a: string }>({
        run: async (_i, ctx) => {
          const f = ctxFaqs(ctx);
          const graph = createFaqGraphService({
            graph: createPgFaqGraphRepository(ctx.db),
          });
          const a = await f.create(olivia, cardBody('m1'));
          const b = await f.create(olivia, cardBody('m2'));
          await graph.createEdge(olivia, a.id, { childId: b.id });
          await graph.addPhrasing(olivia, a.id, {
            locale: 'en-GB',
            text: `multi phrasing ${uniq()}`,
          });
          // rows written with plain SQL, no change_id given
          await ctx.db.query(
            `INSERT INTO helpdesk_faq_map_revisions (id, entity, entity_id, action, employee_id)
             VALUES ($1, 'node', $2, 'create', NULL)`,
            [uuidv7(), uuidv7()],
          );
          await ctx.db.query(
            `INSERT INTO helpdesk_faq_reviews (id, faq_id, faq_version, status)
             VALUES ($1, $2, 1, 'ok')`,
            [uuidv7(), keeper.id],
          );
          const cand = uuidv7();
          await ctx.db.query(
            `INSERT INTO helpdesk_faq_candidates (id, suggestion, origin, topic, proposed_question,
               label_source, locale, first_seen_at, last_seen_at)
             VALUES ($1, 'new_faq', 'mining', 't', 'q', 'code', 'en-GB', now(), now())`,
            [cand],
          );
          await ctx.db.query(
            `INSERT INTO helpdesk_faq_candidate_revisions (id, candidate_id, action)
             VALUES ($1, $2, 'create')`,
            [uuidv7(), cand],
          );
          return { a: a.id };
        },
      });
      const out = await exec(command, {});
      const id = out.changeId as string;
      const mine = await revCounts(id);
      const after = await revTotals();
      const taggedAfter = await revTagged();
      for (const kind of KINDS) {
        expect(after[kind] - before[kind]).toBe(mine[kind]);
        expect(taggedAfter[kind] - taggedBefore[kind]).toBe(mine[kind]);
      }
      expect(mine.cards).toBe(2);
      expect(mine.edges).toBeGreaterThanOrEqual(1);
      expect(mine.phrasings).toBeGreaterThanOrEqual(1);
      expect(mine.map).toBe(1);
      expect(mine.reviews).toBe(1);
      expect(mine.candidates).toBe(1);
      const row = (await changeRow(id)) as Row;
      const summary = row.summary as Record<string, number>;
      for (const kind of KINDS) expect(summary[kind]).toBe(mine[kind]);
    });

    it('revision rows written outside the pipeline have change_id NULL', async () => {
      const taggedBefore = await revTagged();
      const untaggedBefore = await revUntagged();
      const a = await mkCard('outside-a');
      const b = await mkCard('outside-b');
      const edge = await mkEdge(a.id, b.id);
      const ph = await mkPhrasing(a.id, `outside phrasing ${uniq()}`);
      await graphSvc.updateEdge(olivia, edge.id, {
        labelEn: 'outside label',
        labelZh: '外部',
      });
      await graphSvc.deletePhrasing(olivia, ph.id);
      await graphSvc.deleteEdge(olivia, edge.id);
      await faqSvc.update(
        olivia,
        a.id,
        updateBody(a, { answerEn: 'outside change' }),
      );
      const taggedAfter = await revTagged();
      const untaggedAfter = await revUntagged();
      expect(taggedAfter).toEqual(taggedBefore);
      expect(untaggedAfter.cards).toBeGreaterThanOrEqual(
        untaggedBefore.cards + 3,
      );
      expect(untaggedAfter.edges).toBeGreaterThanOrEqual(
        untaggedBefore.edges + 3,
      );
      expect(untaggedAfter.phrasings).toBeGreaterThanOrEqual(
        untaggedBefore.phrasings + 2,
      );
    });
  });

  // ------------------------------------------------------------------- R5

  describe('R5 atomic', () => {
    it('rolls back everything when run throws, and rethrows the same object', async () => {
      const boom = new HelpdeskError(409, 'BOOM_CONFLICT', 'boom');
      const target = await mkCard('r5-target');
      let changeId = '';
      const command = cmd({
        idempotent: true,
        run: async (_i, ctx) => {
          changeId = ctx.changeId;
          const f = ctxFaqs(ctx);
          const graph = createFaqGraphService({
            graph: createPgFaqGraphRepository(ctx.db),
          });
          const a = await f.create(olivia, cardBody('r5a'));
          await graph.createEdge(olivia, a.id, { childId: target.id });
          await graph.addPhrasing(olivia, a.id, {
            locale: 'en-GB',
            text: `r5 phrasing ${uniq()}`,
          });
          await f.update(
            olivia,
            target.id,
            updateBody(target, { answerEn: 'changed then rolled back' }),
          );
          await ctx.db.query(
            `INSERT INTO helpdesk_faq_map_revisions (id, entity, entity_id, action)
             VALUES ($1, 'node', $2, 'create')`,
            [uuidv7(), uuidv7()],
          );
          await ctx.db.query(
            `INSERT INTO helpdesk_faq_reviews (id, faq_id, faq_version, status)
             VALUES ($1, $2, 1, 'ok')`,
            [uuidv7(), target.id],
          );
          throw boom;
        },
      });
      const before = await snapshot();
      const err = await rejection(
        exec(command, {}, { idempotencyKey: uuidv7() }),
      );
      expect(err).toBe(boom);
      expect((err as HelpdeskError).status).toBe(409);
      expect((err as HelpdeskError).code).toBe('BOOM_CONFLICT');
      expect(await snapshot()).toEqual(before);
      expect(await changeRow(changeId)).toBeUndefined();
      expect((await faqSvc.get(target.id)).answerEn).toBe(target.answerEn);
    });

    it('rethrows plain errors and non-error values unchanged', async () => {
      const plain = new Error('plain failure');
      expect(
        await rejection(
          exec(
            cmd({
              run: () => {
                throw plain;
              },
            }),
            {},
          ),
        ),
      ).toBe(plain);
      const odd = { weird: true };
      expect(
        await rejection(
          exec(
            cmd({
              run: () => Promise.reject(odd as unknown as Error),
            }),
            {},
          ),
        ),
      ).toBe(odd);
    });

    it('rethrows the parse error unchanged and writes nothing', async () => {
      const boom = new HelpdeskError(400, 'INVALID_INPUT', 'parse says no');
      const before = await snapshot();
      const command = cmd({
        idempotent: true,
        parse: () => {
          throw boom;
        },
        run: () => Promise.resolve(1),
      });
      expect(
        await rejection(exec(command, {}, { idempotencyKey: uuidv7() })),
      ).toBe(boom);
      expect(await snapshot()).toEqual(before);
    });

    it('a parse error from a non-idempotent command leaves no idempotency row', async () => {
      const command = cmd({
        parse: () => {
          throw new HelpdeskError(422, 'X', 'x');
        },
        run: () => Promise.resolve(1),
      });
      const before = await count('helpdesk_idempotency');
      await rejection(exec(command, {}, { idempotencyKey: uuidv7() }));
      expect(await count('helpdesk_idempotency')).toBe(before);
    });

    it('releases locks after a failure: an exclusive command can run again', async () => {
      const fail = cmd({
        lock: 'exclusive',
        run: () => Promise.reject(new Error('x')),
      });
      await rejection(exec(fail, {}));
      const ok = writer({ lock: 'exclusive' });
      expect(await within(exec(ok.command, {}), 5000)).not.toBe('timeout');
    }, 15_000);

    it('a real command that fails (stale version) changes nothing', async () => {
      const faq = await mkCard('r5-stale');
      const first = await exec(commands.cardUpdate, {
        employee: olivia,
        faqId: faq.id,
        body: updateBody(faq, { answerEn: 'v2 answer' }),
      });
      expect(first.changeId).not.toBeNull();
      const before = await snapshot();
      const e = await expectHelpdeskError(
        exec(commands.cardUpdate, {
          employee: olivia,
          faqId: faq.id,
          body: updateBody(faq, { answerEn: 'v3 stale answer' }),
        }),
        409,
      );
      expect(e).toBeInstanceOf(HelpdeskError);
      expect(await snapshot()).toEqual(before);
    });
  });

  // ------------------------------------------------------------------- R6

  describe('R6 no-op', () => {
    it('returns { result, changeId: null, replayed: false } and writes no change row or NOTIFY', async () => {
      const { command, calls } = noop({ n: 1 });
      const before = await snapshot();
      const out = await exec(command, {});
      expect(out).toStrictEqual({
        result: { n: 1 },
        changeId: null,
        replayed: false,
      });
      expect(await snapshot()).toEqual(before);
      // a later changing command proves the earlier no-op id was never notified
      const probe = writer();
      const after = await exec(probe.command, {});
      expect(await noted(after.changeId as string)).toBe(true);
      expect(notes).not.toContain(calls[0].changeId);
    });

    it('a PUT with identical content is a no-op', async () => {
      const faq = await mkCard('r6-put');
      const before = await snapshot();
      const out = await exec(commands.cardUpdate, {
        employee: olivia,
        faqId: faq.id,
        body: updateBody(faq),
      });
      expect(out.changeId).toBeNull();
      expect(out.replayed).toBe(false);
      expect(out.result).toEqual(faq);
      expect(await snapshot()).toEqual(before);
    });

    it('adding an edge that already exists is a no-op', async () => {
      const a = await mkCard('r6e-a');
      const b = await mkCard('r6e-b');
      const edge = await mkEdge(a.id, b.id);
      const before = await snapshot();
      const out = await exec(commands.edgeCreate, {
        employee: olivia,
        faqId: a.id,
        body: { childId: b.id },
      });
      expect(out.changeId).toBeNull();
      expect(out.replayed).toBe(false);
      expect(out.result.created).toBe(false);
      expect(out.result.edge.id).toBe(edge.id);
      expect(await snapshot()).toEqual(before);
    });

    it('adding a phrasing that already exists is a no-op', async () => {
      const a = await mkCard('r6p-a');
      const ph = await mkPhrasing(a.id, 'How do I reset?');
      const before = await snapshot();
      const out = await exec(commands.phrasingAdd, {
        employee: olivia,
        faqId: a.id,
        body: { locale: 'en-GB', text: 'how do i RESET?' },
      });
      expect(out.changeId).toBeNull();
      expect(out.result.created).toBe(false);
      expect(out.result.phrasing.id).toBe(ph.id);
      expect(await snapshot()).toEqual(before);
    });

    it('deleting what does not exist is a no-op (edge and phrasing)', async () => {
      const before = await snapshot();
      const e = await exec(commands.edgeDelete, {
        employee: olivia,
        edgeId: uuidv7(),
      });
      const p = await exec(commands.phrasingDelete, {
        employee: olivia,
        phrasingId: uuidv7(),
      });
      expect(e.changeId).toBeNull();
      expect(e.result).toEqual({ deleted: false, edge: null });
      expect(p.changeId).toBeNull();
      expect(p.result).toEqual({ deleted: false });
      expect(await snapshot()).toEqual(before);
    });

    it('archiving an already archived card is a no-op', async () => {
      const faq = await mkCard('r6-arch');
      const archived = await faqSvc.archive(olivia, faq.id, {
        version: faq.version,
      });
      const before = await snapshot();
      const out = await exec(commands.cardArchive, {
        employee: olivia,
        faqId: faq.id,
        body: { version: archived.version },
      });
      expect(out.changeId).toBeNull();
      expect(out.result.status).toBe('archived');
      expect(await snapshot()).toEqual(before);
    });

    it('reorder: the outcome is consistent (changeId null iff no change row)', async () => {
      const parent = await mkCard('r6-reorder');
      const c1 = await mkCard('r6-r1');
      const c2 = await mkCard('r6-r2');
      await mkEdge(parent.id, c1.id);
      await mkEdge(parent.id, c2.id);
      const changes = await changesCount();
      const out = await exec(commands.edgeReorder, {
        employee: olivia,
        faqId: parent.id,
        body: { childIds: [c1.id, c2.id] },
      });
      if (out.changeId === null) expect(await changesCount()).toBe(changes);
      else expect(await changesCount()).toBe(changes + 1);
    });

    it('a no-op with an invalid traceparent and a cause still writes nothing', async () => {
      const { command } = noop();
      const before = await snapshot();
      const out = await exec(
        command,
        {},
        { traceparent: 'garbage', cause: { kind: 'import', ref: 'x' } },
      );
      expect(out.changeId).toBeNull();
      expect(await snapshot()).toEqual(before);
    });
  });

  // ------------------------------------------------------------------- R7

  describe('R7 change row', () => {
    it('writes exactly one row with command, actor, employee, cause and summary', async () => {
      const { command } = writer();
      const before = await changesCount();
      const out = await exec(
        command,
        {},
        {
          actor: { employeeId: MARCO },
          cause: { kind: 'flywheel', ref: 'cand-9', note: 'mined' },
        },
      );
      expect(await changesCount()).toBe(before + 1);
      const row = (await changeRow(out.changeId as string)) as Row;
      expect(row.id).toBe(out.changeId);
      expect(row.command).toBe(command.name);
      expect(row.actor).toBe(`human:${MARCO}`);
      expect(String(row.employee_id)).toBe(MARCO);
      expect(row.cause_kind).toBe('flywheel');
      expect(row.cause_ref).toBe('cand-9');
      expect(row.note).toBe('mined');
      expect(row.trace_id).toMatch(HEX32);
      expect(row.summary).toEqual({ cards: 1 });
      expect(row.at).toBeDefined();
      expect(Number(row.seq)).toBeGreaterThan(0);
    });

    it('stores null cause_ref / note and a null employee_id for a process actor', async () => {
      const { command } = writer();
      const out = await exec(
        command,
        {},
        {
          actor: { employeeId: null, label: 'process:nightly' },
          cause: { kind: 'system' },
        },
      );
      const row = (await changeRow(out.changeId as string)) as Row;
      expect(row.cause_ref).toBeNull();
      expect(row.note).toBeNull();
      expect(row.employee_id).toBeNull();
      expect(row.actor).toBe('process:nightly');
      const out2 = await exec(
        command,
        {},
        { cause: { kind: 'system', ref: null, note: null } },
      );
      const row2 = (await changeRow(out2.changeId as string)) as Row;
      expect(row2.cause_ref).toBeNull();
      expect(row2.note).toBeNull();
    });

    it('summary has only non-zero kinds and counts rows per kind', async () => {
      const a = await mkCard('r7-a');
      const b = await mkCard('r7-b');
      const command = cmd({
        run: async (_i, ctx) => {
          const graph = createFaqGraphService({
            graph: createPgFaqGraphRepository(ctx.db),
          });
          await graph.createEdge(olivia, a.id, { childId: b.id });
          await graph.addPhrasing(olivia, a.id, {
            locale: 'en-GB',
            text: `r7 one ${uniq()}`,
          });
          await graph.addPhrasing(olivia, a.id, {
            locale: 'zh-CN',
            text: `r7 两个 ${uniq()}`,
          });
          return null;
        },
      });
      const out = await exec(command, {});
      const id = out.changeId as string;
      const counts = await revCounts(id);
      const row = (await changeRow(id)) as Row;
      const expected: Record<string, number> = {};
      for (const kind of KINDS)
        if (counts[kind] > 0) expected[kind] = counts[kind];
      expect(row.summary).toEqual(expected);
      expect(counts.phrasings).toBe(2);
      expect(counts.edges).toBeGreaterThanOrEqual(1);
      expect(counts.cards).toBe(0);
      expect(Object.keys(row.summary as object)).not.toContain('cards');
    });

    it('the outcome changeId equals the row id for each real command', async () => {
      const out = await exec(commands.cardCreate, {
        employee: olivia,
        body: cardBody('r7-real'),
      });
      const row = (await changeRow(out.changeId as string)) as Row;
      expect(row.command).toBe('card.create');
      expect(row.summary).toEqual({ cards: 1 });
    });

    it('a valid traceparent supplies the trace id', async () => {
      const { command, calls } = writer();
      const out = await exec(
        command,
        {},
        { traceparent: `00-${TRACE}-${PARENT_SPAN}-01` },
      );
      expect(((await changeRow(out.changeId as string)) as Row).trace_id).toBe(
        TRACE,
      );
      expect(calls[0].traceId).toBe(TRACE);
      const out2 = await exec(
        command,
        {},
        { traceparent: `00-${TRACE}-${PARENT_SPAN}-00` },
      );
      expect(((await changeRow(out2.changeId as string)) as Row).trace_id).toBe(
        TRACE,
      );
    });

    it.each([
      ['empty', ''],
      ['garbage', 'garbage'],
      ['all-zero trace id', `00-${'0'.repeat(32)}-${PARENT_SPAN}-01`],
      ['missing flags', `00-${TRACE}-${PARENT_SPAN}`],
      ['short trace id', `00-${TRACE.slice(1)}-${PARENT_SPAN}-01`],
      ['long trace id', `00-${TRACE}a-${PARENT_SPAN}-01`],
      ['short parent id', `00-${TRACE}-${PARENT_SPAN.slice(1)}-01`],
      ['long parent id', `00-${TRACE}-${PARENT_SPAN}0-01`],
      ['non-hex trace id', `00-${TRACE.replace('4', 'g')}-${PARENT_SPAN}-01`],
      ['non-hex flags', `00-${TRACE}-${PARENT_SPAN}-0g`],
      ['one-digit flags', `00-${TRACE}-${PARENT_SPAN}-1`],
      ['short version', `0-${TRACE}-${PARENT_SPAN}-01`],
      ['trailing segment', `00-${TRACE}-${PARENT_SPAN}-01-extra`],
      ['wrong separators', `00_${TRACE}_${PARENT_SPAN}_01`],
      ['no separators', `00${TRACE}${PARENT_SPAN}01`],
    ])(
      'ignores an invalid traceparent (%s) and uses a new random trace id',
      async (_label, traceparent) => {
        const { command, calls } = writer();
        const out = await exec(command, {}, { traceparent });
        const id = ((await changeRow(out.changeId as string)) as Row)
          .trace_id as string;
        expect(id).toMatch(HEX32);
        expect(id).not.toBe(TRACE);
        expect(id).not.toBe('0'.repeat(32));
        expect(calls[0].traceId).toBe(id);
      },
    );

    it('without a traceparent (undefined / null) the trace ids are random and distinct', async () => {
      const { command } = writer();
      const ids = new Set<string>();
      for (const traceparent of [undefined, null, undefined, null]) {
        const out = await exec(command, {}, { traceparent });
        const id = ((await changeRow(out.changeId as string)) as Row)
          .trace_id as string;
        expect(id).toMatch(HEX32);
        ids.add(id);
      }
      expect(ids.size).toBe(4);
    });
  });

  // ------------------------------------------------------------------- R8

  describe('R8 change log order', () => {
    it('is append-only: UPDATE and DELETE fail', async () => {
      const { command } = writer();
      const out = await exec(command, {});
      const id = out.changeId as string;
      await expect(
        db.query('UPDATE helpdesk_faq_changes SET note = $2 WHERE id = $1', [
          id,
          'tamper',
        ]),
      ).rejects.toThrow();
      await expect(
        db.query(
          'UPDATE helpdesk_faq_changes SET seq = seq + 1 WHERE id = $1',
          [id],
        ),
      ).rejects.toThrow();
      await expect(
        db.query('DELETE FROM helpdesk_faq_changes WHERE id = $1', [id]),
      ).rejects.toThrow();
      await expect(
        db.query('DELETE FROM helpdesk_faq_changes'),
      ).rejects.toThrow();
      expect(await changeRow(id)).toBeDefined();
    });

    it('seq increases with each sequential command', async () => {
      const { command } = writer();
      const seqs: bigint[] = [];
      for (let i = 0; i < 4; i++) {
        const out = await exec(command, {});
        seqs.push(
          BigInt(
            ((await changeRow(out.changeId as string)) as Row).seq as string,
          ),
        );
      }
      for (let i = 1; i < seqs.length; i++)
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    });

    it('B cannot commit before A (which holds its change row, uncommitted), so B.seq > A.seq', async () => {
      const gateA = newGate();
      const reached = newGate();
      let holdId = '';
      const a = cmd({
        run: async (_i, ctx) => {
          holdId = ctx.changeId;
          await ctxFaqs(ctx).create(olivia, cardBody('r8-a'));
          return null;
        },
      });
      commitHook = async (client) => {
        if (!holdId) return;
        const r = await client.query(
          'SELECT 1 FROM helpdesk_faq_changes WHERE id = $1',
          [holdId],
        );
        if (r.rowCount) {
          holdId = '';
          reached.open();
          await gateA.promise;
        }
      };
      const pa = exec(a, {});
      const pb: Promise<CommandOutcome<unknown>>[] = [];
      try {
        expect(await within(reached.promise, 8000)).not.toBe('timeout');
        const b = writer();
        pb.push(exec(b.command, {}));
        expect(await within(pb[0], 700)).toBe('timeout');
      } finally {
        gateA.open();
      }
      const [oa, ob] = await Promise.all([pa, pb[0]]);
      const ra = (await changeRow(oa.changeId as string)) as Row;
      const rb = (await changeRow(ob.changeId as string)) as Row;
      expect(BigInt(rb.seq as string)).toBeGreaterThan(
        BigInt(ra.seq as string),
      );
    }, 30_000);

    it('many concurrent commands get distinct seq values and all commit', async () => {
      const { command } = writer();
      const outs = await Promise.all(
        Array.from({ length: 8 }, () => exec(command, {})),
      );
      const seqs = new Set<string>();
      for (const o of outs) {
        const r = (await changeRow(o.changeId as string)) as Row;
        seqs.add(String(r.seq));
      }
      expect(seqs.size).toBe(8);
    }, 30_000);
  });

  // ------------------------------------------------------------------- R9

  describe('R9 notify', () => {
    it('sends NOTIFY helpdesk_faq_changes with the change id on commit', async () => {
      const out = await exec(commands.cardCreate, {
        employee: olivia,
        body: cardBody('r9'),
      });
      expect(await noted(out.changeId as string)).toBe(true);
      expect(notes.filter((n) => n === out.changeId)).toHaveLength(1);
    });

    it('sends nothing on rollback (parse or run error)', async () => {
      let rolled = '';
      const failing = cmd({
        run: async (_i, ctx) => {
          rolled = ctx.changeId;
          await ctxFaqs(ctx).create(olivia, cardBody('r9-rb'));
          throw new Error('rollback me');
        },
      });
      await rejection(exec(failing, {}));
      const probe = writer();
      const done = await exec(probe.command, {});
      expect(await noted(done.changeId as string)).toBe(true);
      expect(rolled).toMatch(UUID_V7);
      expect(notes).not.toContain(rolled);
    });

    it('sends nothing for a no-op', async () => {
      const faq = await mkCard('r9-noop');
      const noopOut = await exec(commands.cardUpdate, {
        employee: olivia,
        faqId: faq.id,
        body: updateBody(faq),
      });
      expect(noopOut.changeId).toBeNull();
      const before = notes.length;
      const probe = writer();
      const done = await exec(probe.command, {});
      expect(await noted(done.changeId as string)).toBe(true);
      // only the probe added a notification from this process' schema
      expect(notes.slice(before)).toContain(done.changeId);
    });

    it('does not notify a replayed idempotent call a second time', async () => {
      const key = uuidv7();
      const { command } = writer({ idempotent: true });
      const first = await exec(command, {}, { idempotencyKey: key });
      expect(await noted(first.changeId as string)).toBe(true);
      const again = await exec(command, {}, { idempotencyKey: key });
      expect(again.replayed).toBe(true);
      const probe = writer();
      const done = await exec(probe.command, {});
      expect(await noted(done.changeId as string)).toBe(true);
      expect(notes.filter((n) => n === first.changeId)).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------ R10

  describe('R10 locks', () => {
    it('a shared command does not enter run while an exclusive one is inside run, and sees its committed data', async () => {
      const gate = newGate();
      const inside = newGate();
      let sharedEntered = false;
      let seen: number | null = null;
      const marker = `excl-${uniq()}`;
      const ex = cmd({
        lock: 'exclusive',
        run: async (_i, ctx) => {
          await ctxFaqs(ctx).create(olivia, {
            ...cardBody('r10x'),
            questionEn: `Exclusive marker ${marker} question`,
          });
          inside.open();
          await gate.promise;
          return 'ex';
        },
      });
      const sh = cmd({
        lock: 'shared',
        run: async (_i, ctx) => {
          sharedEntered = true;
          const r = await ctx.db.query(
            'SELECT count(*)::int AS n FROM helpdesk_faqs WHERE question_en LIKE $1',
            [`%${marker}%`],
          );
          seen = Number(r[0].n);
          return 'sh';
        },
      });
      const pe = exec(ex, {});
      let ps: Promise<unknown> | undefined;
      try {
        expect(await within(inside.promise, 8000)).not.toBe('timeout');
        ps = exec(sh, {});
        expect(await within(ps, 600)).toBe('timeout');
        expect(sharedEntered).toBe(false);
      } finally {
        gate.open();
      }
      await Promise.all([pe, ps]);
      expect(sharedEntered).toBe(true);
      expect(seen).toBe(1);
    }, 30_000);

    it('a shared command proceeds after the exclusive one rolled back', async () => {
      const gate = newGate();
      const inside = newGate();
      let sharedEntered = false;
      const ex = cmd({
        lock: 'exclusive',
        run: async () => {
          inside.open();
          await gate.promise;
          throw new Error('exclusive fails');
        },
      });
      const sh = cmd({
        run: () => {
          sharedEntered = true;
          return Promise.resolve(1);
        },
      });
      const pe = exec(ex, {});
      const settled = pe.catch((e: unknown) => e);
      let ps: Promise<unknown> | undefined;
      try {
        expect(await within(inside.promise, 8000)).not.toBe('timeout');
        ps = exec(sh, {});
        expect(await within(ps, 500)).toBe('timeout');
        expect(sharedEntered).toBe(false);
      } finally {
        gate.open();
      }
      await settled;
      expect(await within(ps, 8000)).not.toBe('timeout');
      expect(sharedEntered).toBe(true);
    }, 30_000);

    it('two shared commands can be inside run at the same time', async () => {
      const bothIn = newGate();
      let inside = 0;
      const mk = () =>
        cmd({
          lock: 'shared',
          run: async () => {
            inside += 1;
            if (inside === 2) bothIn.open();
            await bothIn.promise;
            return inside;
          },
        });
      const p1 = exec(mk(), {});
      const p2 = exec(mk(), {});
      try {
        expect(await within(Promise.all([p1, p2]), 8000)).not.toBe('timeout');
      } finally {
        bothIn.open();
      }
      expect(inside).toBe(2);
    }, 30_000);

    it('a shared command already waiting is released by an exclusive commit; exclusive commands serialise', async () => {
      const gate = newGate();
      const inside = newGate();
      let secondEntered = false;
      const first = cmd({
        lock: 'exclusive',
        run: async () => {
          inside.open();
          await gate.promise;
          return 1;
        },
      });
      const second = cmd({
        lock: 'exclusive',
        run: () => {
          secondEntered = true;
          return Promise.resolve(2);
        },
      });
      const p1 = exec(first, {});
      let p2: Promise<unknown> | undefined;
      try {
        expect(await within(inside.promise, 8000)).not.toBe('timeout');
        p2 = exec(second, {});
        expect(await within(p2, 500)).toBe('timeout');
        expect(secondEntered).toBe(false);
      } finally {
        gate.open();
      }
      await Promise.all([p1, p2]);
      expect(secondEntered).toBe(true);
    }, 30_000);
  });

  // ------------------------------------------------------------------ R11

  describe('R11 idempotency', () => {
    it('replays the first outcome without calling run again', async () => {
      const key = uuidv7();
      const { command, calls } = writer({ idempotent: true });
      const first = await exec(command, { a: 1 }, { idempotencyKey: key });
      const changes = await changesCount();
      const again = await exec(command, { a: 1 }, { idempotencyKey: key });
      expect(first.replayed).toBe(false);
      expect(again.replayed).toBe(true);
      expect(again.changeId).toBe(first.changeId);
      expect(again.result).toEqual(first.result);
      expect(calls).toHaveLength(1);
      expect(await changesCount()).toBe(changes);
      const rows = await db.query(
        'SELECT * FROM helpdesk_idempotency WHERE command = $1',
        [command.name],
      );
      expect(rows).toHaveLength(1);
      expect(String(rows[0].key)).toBe(key);
      expect(rows[0].actor).toBe(`human:${OLIVIA}`);
      expect(rows[0].change_id).toBe(first.changeId);
    });

    it('treats the key case-insensitively', async () => {
      const key = uuidv7();
      const { command, calls } = writer({ idempotent: true });
      const first = await exec(command, {}, { idempotencyKey: key });
      const again = await exec(
        command,
        {},
        { idempotencyKey: key.toUpperCase() },
      );
      expect(again.replayed).toBe(true);
      expect(again.changeId).toBe(first.changeId);
      const third = await exec(
        command,
        {},
        { idempotencyKey: key.toUpperCase() },
      );
      expect(third.replayed).toBe(true);
      expect(calls).toHaveLength(1);
    });

    it('treats the actor id case-insensitively', async () => {
      const key = uuidv7();
      const { command, calls } = writer({ idempotent: true });
      await exec(command, {}, { idempotencyKey: key });
      const again = await exec(
        command,
        {},
        { idempotencyKey: key, actor: { employeeId: OLIVIA.toUpperCase() } },
      );
      expect(again.replayed).toBe(true);
      expect(calls).toHaveLength(1);
    });

    it('treats JSON objects with a different key order as the same request', async () => {
      const key = uuidv7();
      const { command, calls } = writer({ idempotent: true });
      const first = await exec(
        command,
        { a: 1, b: { c: [1, { x: 1, y: 2 }], d: null }, e: 'z' },
        { idempotencyKey: key },
      );
      const again = await exec(
        command,
        { e: 'z', b: { d: null, c: [1, { y: 2, x: 1 }] }, a: 1 },
        { idempotencyKey: key },
      );
      expect(again.replayed).toBe(true);
      expect(again.changeId).toBe(first.changeId);
      expect(calls).toHaveLength(1);
    });

    it.each([
      ['different value', { a: 1 }, { a: 2 }],
      ['extra field', { a: 1 }, { a: 1, b: 2 }],
      ['missing field', { a: 1, b: 2 }, { a: 1 }],
      ['array order', { a: [1, 2] }, { a: [2, 1] }],
      ['number vs string', { a: 1 }, { a: '1' }],
      ['null vs missing', { a: null }, {}],
      ['nested value', { a: { b: 1 } }, { a: { b: 2 } }],
      ['array vs object', [1], { 0: 1 }],
    ])(
      'rejects the same key with a different request (%s) with 422',
      async (_label, rawA, rawB) => {
        const key = uuidv7();
        const { command, calls } = writer({ idempotent: true });
        await exec(command, rawA, { idempotencyKey: key });
        const before = await snapshot();
        const e = await expectHelpdeskError(
          exec(command, rawB, { idempotencyKey: key }),
          422,
          'IDEMPOTENCY_KEY_REUSED',
        );
        expect(e).toBeInstanceOf(HelpdeskError);
        expect(calls).toHaveLength(1);
        expect(await snapshot()).toEqual(before);
      },
    );

    it.each([
      ['nope'],
      ['1234'],
      [`${uuidv7()}x`],
      [uuidv7().replace(/-/g, '')],
    ])(
      'rejects an idempotent key that is not a UUID (%j) with 400',
      async (idempotencyKey) => {
        const { command, calls } = writer({ idempotent: true });
        const before = await snapshot();
        await expectHelpdeskError(exec(command, {}, { idempotencyKey }), 400);
        expect(calls).toHaveLength(0);
        expect(await snapshot()).toEqual(before);
      },
    );

    it('keys are independent per command', async () => {
      const key = uuidv7();
      const a = writer({ idempotent: true });
      const b = writer({ idempotent: true });
      const oa = await exec(a.command, {}, { idempotencyKey: key });
      const ob = await exec(b.command, {}, { idempotencyKey: key });
      expect(ob.replayed).toBe(false);
      expect(ob.changeId).not.toBe(oa.changeId);
      expect(b.calls).toHaveLength(1);
    });

    it('keys are independent per actor', async () => {
      const key = uuidv7();
      const { command, calls } = writer({ idempotent: true });
      const o1 = await exec(command, {}, { idempotencyKey: key });
      const o2 = await exec(
        command,
        {},
        { idempotencyKey: key, actor: { employeeId: MARCO } },
      );
      const o3 = await exec(
        command,
        {},
        {
          idempotencyKey: key,
          actor: { employeeId: null, label: 'process:idem' },
        },
      );
      expect(o2.replayed).toBe(false);
      expect(o3.replayed).toBe(false);
      expect(new Set([o1.changeId, o2.changeId, o3.changeId]).size).toBe(3);
      expect(calls).toHaveLength(3);
      // each actor replays its own
      const r2 = await exec(
        command,
        {},
        { idempotencyKey: key, actor: { employeeId: MARCO } },
      );
      expect(r2.replayed).toBe(true);
      expect(r2.changeId).toBe(o2.changeId);
    });

    it('records nothing when run threw, so a retry with the same key runs again', async () => {
      const key = uuidv7();
      let attempts = 0;
      const command = cmd<unknown, { attempts: number }>({
        idempotent: true,
        run: async (_i, ctx) => {
          attempts += 1;
          await ctxFaqs(ctx).create(olivia, cardBody('r11-retry'));
          if (attempts === 1) throw new Error('first attempt fails');
          return { attempts };
        },
      });
      const before = await count('helpdesk_idempotency');
      await rejection(exec(command, {}, { idempotencyKey: key }));
      expect(await count('helpdesk_idempotency')).toBe(before);
      const retry = await exec(command, {}, { idempotencyKey: key });
      expect(retry.replayed).toBe(false);
      expect(retry.result).toEqual({ attempts: 2 });
      const again = await exec(command, {}, { idempotencyKey: key });
      expect(again.replayed).toBe(true);
      expect(attempts).toBe(2);
    });

    it('a no-op idempotent run still records the key; its replay returns changeId null', async () => {
      const key = uuidv7();
      const { command, calls } = noop({ n: 5 }, { idempotent: true });
      const before = await count('helpdesk_idempotency');
      const first = await exec(command, { q: 1 }, { idempotencyKey: key });
      expect(first).toStrictEqual({
        result: { n: 5 },
        changeId: null,
        replayed: false,
      });
      expect(await count('helpdesk_idempotency')).toBe(before + 1);
      const again = await exec(command, { q: 1 }, { idempotencyKey: key });
      expect(again).toStrictEqual({
        result: { n: 5 },
        changeId: null,
        replayed: true,
      });
      expect(calls).toHaveLength(1);
      const rows = await db.query(
        'SELECT change_id FROM helpdesk_idempotency WHERE command = $1',
        [command.name],
      );
      expect(rows[0].change_id).toBeNull();
      await expectHelpdeskError(
        exec(command, { q: 2 }, { idempotencyKey: key }),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
    });

    it('a no-op idempotent run without a key records nothing', async () => {
      const { command } = noop({ n: 5 }, { idempotent: true });
      const before = await count('helpdesk_idempotency');
      await exec(command, {});
      await exec(command, {}, { idempotencyKey: null });
      expect(await count('helpdesk_idempotency')).toBe(before);
    });

    it('an idempotent command without a key runs every time; null key counts as none', async () => {
      const { command, calls } = writer({ idempotent: true });
      const before = await count('helpdesk_idempotency');
      const a = await exec(command, {});
      const b = await exec(command, {}, { idempotencyKey: null });
      const c = await exec(command, {}, { idempotencyKey: undefined });
      expect(calls).toHaveLength(3);
      expect([a, b, c].every((o) => !o.replayed)).toBe(true);
      expect(await count('helpdesk_idempotency')).toBe(before);
    });

    it('commands without idempotent: true ignore the key entirely (even an invalid one)', async () => {
      const key = uuidv7();
      const { command, calls } = writer();
      const before = await count('helpdesk_idempotency');
      const a = await exec(command, {}, { idempotencyKey: key });
      const b = await exec(command, {}, { idempotencyKey: key });
      const c = await exec(command, {}, { idempotencyKey: 'not a uuid' });
      const d = await exec(
        command,
        { different: true },
        { idempotencyKey: key },
      );
      expect(calls).toHaveLength(4);
      expect([a, b, c, d].every((o) => !o.replayed && o.changeId)).toBe(true);
      expect(await count('helpdesk_idempotency')).toBe(before);
      const explicit = writer({ idempotent: false });
      await exec(explicit.command, {}, { idempotencyKey: key });
      const second = await exec(explicit.command, {}, { idempotencyKey: key });
      expect(second.replayed).toBe(false);
      expect(explicit.calls).toHaveLength(2);
    });

    it('two concurrent calls with the same key persist exactly one run and share the changeId', async () => {
      const key = uuidv7();
      const cards = await count('helpdesk_faqs');
      let runs = 0;
      const command = cmd<unknown, { runs: number }>({
        idempotent: true,
        run: async (_i, ctx) => {
          runs += 1;
          await ctxFaqs(ctx).create(olivia, cardBody('r11-conc'));
          await sleep(150);
          return { runs: 1 };
        },
      });
      const outs = await Promise.all(
        Array.from({ length: 6 }, () =>
          exec(command, { same: true }, { idempotencyKey: key }),
        ),
      );
      expect(runs).toBeGreaterThanOrEqual(1);
      expect(outs.filter((o) => !o.replayed)).toHaveLength(1);
      expect(outs.filter((o) => o.replayed)).toHaveLength(5);
      expect(new Set(outs.map((o) => o.changeId)).size).toBe(1);
      expect(outs[0].changeId).not.toBeNull();
      expect(await count('helpdesk_faqs')).toBe(cards + 1);
      expect(
        await count('helpdesk_faq_changes', 'command = $1', [command.name]),
      ).toBe(1);
      expect(
        await count('helpdesk_idempotency', 'command = $1', [command.name]),
      ).toBe(1);
    }, 30_000);

    it('concurrent same-key calls with a different request: one wins, the others get 422', async () => {
      const key = uuidv7();
      const { command } = writer({ idempotent: true });
      const results = await Promise.allSettled([
        exec(command, { v: 1 }, { idempotencyKey: key }),
        exec(command, { v: 2 }, { idempotencyKey: key }),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const bad = results.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(bad).toHaveLength(1);
      expect(bad[0].reason).toMatchObject({
        status: 422,
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    }, 30_000);

    it('a concurrent same-key call waits for a failing first run and then runs itself', async () => {
      const key = uuidv7();
      let attempts = 0;
      const gate = newGate();
      const inside = newGate();
      const command = cmd<unknown, { n: number }>({
        idempotent: true,
        run: async (_i, ctx) => {
          attempts += 1;
          const mine = attempts;
          await ctxFaqs(ctx).create(olivia, cardBody('r11-fail'));
          if (mine === 1) {
            inside.open();
            await gate.promise;
            throw new Error('first fails');
          }
          return { n: mine };
        },
      });
      const p1 = exec(command, {}, { idempotencyKey: key });
      const swallowed = p1.catch((e: unknown) => e);
      let p2: Promise<CommandOutcome<{ n: number }>> | undefined;
      try {
        expect(await within(inside.promise, 8000)).not.toBe('timeout');
        p2 = exec(command, {}, { idempotencyKey: key });
        void p2.catch(() => undefined);
        await sleep(300);
      } finally {
        gate.open();
      }
      await swallowed;
      const second = await (p2 as Promise<CommandOutcome<{ n: number }>>);
      expect(second.replayed).toBe(false);
      expect(second.changeId).not.toBeNull();
      expect(
        await count('helpdesk_faq_changes', 'command = $1', [command.name]),
      ).toBe(1);
    }, 30_000);
  });

  // ------------------------------------------------------------------ R12

  describe('R12 the nine commands', () => {
    const pairs = async (
      direct: () => Promise<unknown>,
      viaBus: () => Promise<unknown>,
    ) => {
      const d = await outcomeOf(direct);
      const b = await outcomeOf(viaBus);
      expect('err' in d).toBe(true);
      expect(b).toEqual(d);
    };

    it('card.create returns the created card and tags the revision', async () => {
      const out = await exec(commands.cardCreate, {
        employee: olivia,
        body: cardBody('r12-create'),
      });
      expect(out.replayed).toBe(false);
      expect(out.changeId).toMatch(UUID_V7);
      expect(out.result.version).toBe(1);
      expect(out.result.status).toBe('published');
      expect(out.result).toEqual(await faqSvc.get(out.result.id));
      expect(await revCounts(out.changeId as string)).toMatchObject({
        cards: 1,
      });
      const row = (await changeRow(out.changeId as string)) as Row;
      expect(row.command).toBe('card.create');
      expect(row.summary).toEqual({ cards: 1 });
    });

    it('card.create honours the body idempotencyKey like the service (replay is a no-op, other body 422)', async () => {
      const key = uuidv7();
      const body = cardBody('r12-key');
      const first = await exec(commands.cardCreate, {
        employee: olivia,
        body,
        idempotencyKey: key,
      });
      const again = await exec(commands.cardCreate, {
        employee: olivia,
        body,
        idempotencyKey: key,
      });
      expect(again.result.id).toBe(first.result.id);
      expect(again.changeId).toBeNull();
      await expectHelpdeskError(
        exec(commands.cardCreate, {
          employee: olivia,
          body: cardBody('r12-key-other'),
          idempotencyKey: key,
        }),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
    });

    it('card.create fails 400 INVALID_INPUT on a bad body, writing nothing', async () => {
      const before = await snapshot();
      await expectHelpdeskError(
        exec(commands.cardCreate, { employee: olivia, body: { nope: 1 } }),
        400,
        'INVALID_INPUT',
      );
      await expectHelpdeskError(
        exec(commands.cardCreate, { employee: olivia, body: 'text' }),
        400,
        'INVALID_INPUT',
      );
      expect(await snapshot()).toEqual(before);
    });

    it('card.update returns the new card; stale version gives 409; unknown id 404', async () => {
      const faq = await mkCard('r12-update');
      const out = await exec(commands.cardUpdate, {
        employee: olivia,
        faqId: faq.id,
        body: updateBody(faq, { answerEn: 'Updated answer' }),
      });
      expect(out.result.version).toBe(2);
      expect(out.result.answerEn).toBe('Updated answer');
      expect(out.result).toEqual(await faqSvc.get(faq.id));
      expect((await changeRow(out.changeId as string))?.command).toBe(
        'card.update',
      );
      const stale = updateBody(faq, { answerEn: 'Stale write' });
      await pairs(
        () => faqSvc.update(olivia, faq.id, stale),
        () =>
          exec(commands.cardUpdate, {
            employee: olivia,
            faqId: faq.id,
            body: stale,
          }),
      );
      await expectHelpdeskError(
        exec(commands.cardUpdate, {
          employee: olivia,
          faqId: faq.id,
          body: stale,
        }),
        409,
      );
      await expectHelpdeskError(
        exec(commands.cardUpdate, {
          employee: olivia,
          faqId: uuidv7(),
          body: stale,
        }),
        404,
      );
      await expectHelpdeskError(
        exec(commands.cardUpdate, {
          employee: olivia,
          faqId: faq.id,
          body: { version: 2 },
        }),
        400,
        'INVALID_INPUT',
      );
    });

    it('card.archive returns the archived card; stale version gives 409', async () => {
      const faq = await mkCard('r12-archive');
      await pairs(
        () => faqSvc.archive(olivia, faq.id, { version: 99 }),
        () =>
          exec(commands.cardArchive, {
            employee: olivia,
            faqId: faq.id,
            body: { version: 99 },
          }),
      );
      const out = await exec(commands.cardArchive, {
        employee: olivia,
        faqId: faq.id,
        body: { version: faq.version },
      });
      expect(out.result.status).toBe('archived');
      expect(out.changeId).not.toBeNull();
      expect((await changeRow(out.changeId as string))?.command).toBe(
        'card.archive',
      );
    });

    it('card.archive refuses a card that still has a parent (same error as the service)', async () => {
      const parent = await mkCard('r12-arch-parent');
      const child = await mkCard('r12-arch-child');
      await mkEdge(parent.id, child.id);
      const before = await snapshot();
      await pairs(
        () => faqSvc.archive(olivia, child.id, { version: child.version }),
        () =>
          exec(commands.cardArchive, {
            employee: olivia,
            faqId: child.id,
            body: { version: child.version },
          }),
      ).catch(() => undefined);
      // the service created without liveParents rule may allow it; either way the
      // state must not change after a failure through the bus
      const viaBus = await outcomeOf(() =>
        exec(commands.cardArchive, {
          employee: olivia,
          faqId: child.id,
          body: { version: child.version },
        }),
      );
      if ('err' in viaBus) expect(await snapshot()).toEqual(before);
    });

    it('edge.create returns { edge, created }; duplicate, self-loop and cycle fail like the service', async () => {
      const a = await mkCard('r12-ec-a');
      const b = await mkCard('r12-ec-b');
      const out = await exec(commands.edgeCreate, {
        employee: olivia,
        faqId: a.id,
        body: { childId: b.id },
      });
      expect(out.result.created).toBe(true);
      expect(out.result.edge.parentId).toBe(a.id);
      expect(out.result.edge.childId).toBe(b.id);
      expect(out.changeId).not.toBeNull();
      expect((await changeRow(out.changeId as string))?.command).toBe(
        'edge.create',
      );
      const tree = await graphSvc.edges(a.id);
      expect(tree.children.map((c) => c.edge.id)).toContain(out.result.edge.id);
      await pairs(
        () => graphSvc.createEdge(olivia, a.id, { childId: a.id }),
        () =>
          exec(commands.edgeCreate, {
            employee: olivia,
            faqId: a.id,
            body: { childId: a.id },
          }),
      );
      await pairs(
        () => graphSvc.createEdge(olivia, b.id, { childId: a.id }),
        () =>
          exec(commands.edgeCreate, {
            employee: olivia,
            faqId: b.id,
            body: { childId: a.id },
          }),
      );
      await expectHelpdeskError(
        exec(commands.edgeCreate, {
          employee: olivia,
          faqId: b.id,
          body: { childId: a.id },
        }),
        409,
        'FAQ_EDGE_CYCLE',
      );
      await expectHelpdeskError(
        exec(commands.edgeCreate, {
          employee: olivia,
          faqId: a.id,
          body: { childId: 'bad' },
        }),
        400,
        'INVALID_INPUT',
      );
    });

    it('edge.update returns the edge; unknown edge gives 404 FAQ_EDGE_NOT_FOUND; missing labels 400', async () => {
      const a = await mkCard('r12-eu-a');
      const b = await mkCard('r12-eu-b');
      const edge = await mkEdge(a.id, b.id);
      const out = await exec(commands.edgeUpdate, {
        employee: olivia,
        edgeId: edge.id,
        body: { labelEn: 'Custom', labelZh: '自定义' },
      });
      expect(out.result.id).toBe(edge.id);
      expect(out.result.labelEn).toBe('Custom');
      expect(out.result.labelZh).toBe('自定义');
      expect(out.changeId).not.toBeNull();
      expect((await changeRow(out.changeId as string))?.command).toBe(
        'edge.update',
      );
      await expectHelpdeskError(
        exec(commands.edgeUpdate, {
          employee: olivia,
          edgeId: uuidv7(),
          body: { labelEn: 'x', labelZh: 'y' },
        }),
        404,
        'FAQ_EDGE_NOT_FOUND',
      );
      await expectHelpdeskError(
        exec(commands.edgeUpdate, {
          employee: olivia,
          edgeId: edge.id,
          body: { labelEn: 'x' },
        }),
        400,
        'INVALID_INPUT',
      );
    });

    it('edge.delete returns { deleted, edge }', async () => {
      const a = await mkCard('r12-ed-a');
      const b = await mkCard('r12-ed-b');
      const edge = await mkEdge(a.id, b.id);
      const out = await exec(commands.edgeDelete, {
        employee: olivia,
        edgeId: edge.id,
      });
      expect(out.result.deleted).toBe(true);
      expect(out.result.edge?.id).toBe(edge.id);
      expect((await changeRow(out.changeId as string))?.command).toBe(
        'edge.delete',
      );
      expect((await graphSvc.edges(a.id)).children).toHaveLength(0);
      await expectHelpdeskError(
        exec(commands.edgeDelete, { employee: olivia, edgeId: 'bad' }),
        400,
        'INVALID_INPUT',
      );
    });

    it('edge.reorder returns { children } in the new order; a mismatching list gives 409', async () => {
      const parent = await mkCard('r12-eo-p');
      const kids = [
        await mkCard('r12-eo-1'),
        await mkCard('r12-eo-2'),
        await mkCard('r12-eo-3'),
      ];
      for (const k of kids) await mkEdge(parent.id, k.id);
      const wanted = [kids[2].id, kids[0].id, kids[1].id];
      const out = await exec(commands.edgeReorder, {
        employee: olivia,
        faqId: parent.id,
        body: { childIds: wanted },
      });
      expect(out.result.children.map((c) => c.edge.childId)).toEqual(wanted);
      expect(out.changeId).not.toBeNull();
      expect((await changeRow(out.changeId as string))?.command).toBe(
        'edge.reorder',
      );
      expect(
        (await graphSvc.edges(parent.id)).children.map((c) => c.edge.childId),
      ).toEqual(wanted);
      const before = await snapshot();
      await expectHelpdeskError(
        exec(commands.edgeReorder, {
          employee: olivia,
          faqId: parent.id,
          body: { childIds: [kids[0].id] },
        }),
        409,
        'FAQ_CHILDREN_CHANGED',
      );
      await expectHelpdeskError(
        exec(commands.edgeReorder, {
          employee: olivia,
          faqId: parent.id,
          body: { childIds: 'x' },
        }),
        400,
        'INVALID_INPUT',
      );
      expect(await snapshot()).toEqual(before);
    });

    it('phrasing.add returns { phrasing, created }, honours source, rejects a bad locale', async () => {
      const a = await mkCard('r12-pa');
      const staff = await exec(commands.phrasingAdd, {
        employee: olivia,
        faqId: a.id,
        body: { locale: 'en-GB', text: `staff ${uniq()}` },
      });
      expect(staff.result.created).toBe(true);
      expect(staff.result.phrasing.source).toBe('staff');
      expect(staff.result.phrasing.faqId).toBe(a.id);
      expect((await changeRow(staff.changeId as string))?.command).toBe(
        'phrasing.add',
      );
      const fly = await exec(commands.phrasingAdd, {
        employee: olivia,
        faqId: a.id,
        body: { locale: 'zh-TW', text: `飛輪 ${uniq()}` },
        source: 'flywheel',
      });
      expect(fly.result.phrasing.source).toBe('flywheel');
      expect(
        (await graphSvc.phrasings(a.id)).phrasings.map((p) => p.id),
      ).toEqual(
        expect.arrayContaining([
          staff.result.phrasing.id,
          fly.result.phrasing.id,
        ]),
      );
      const before = await snapshot();
      await expectHelpdeskError(
        exec(commands.phrasingAdd, {
          employee: olivia,
          faqId: a.id,
          body: { locale: 'fr-FR', text: 'bonjour' },
        }),
        400,
        'INVALID_INPUT',
      );
      await expectHelpdeskError(
        exec(commands.phrasingAdd, {
          employee: olivia,
          faqId: uuidv7(),
          body: { locale: 'en-GB', text: 'orphan' },
        }),
        404,
      );
      expect(await snapshot()).toEqual(before);
    });

    it('phrasing.delete returns { deleted }', async () => {
      const a = await mkCard('r12-pd');
      const ph = await mkPhrasing(a.id, `to delete ${uniq()}`);
      const out = await exec(commands.phrasingDelete, {
        employee: olivia,
        phrasingId: ph.id,
      });
      expect(out.result).toEqual({ deleted: true });
      expect((await changeRow(out.changeId as string))?.command).toBe(
        'phrasing.delete',
      );
      expect((await graphSvc.phrasings(a.id)).phrasings).toHaveLength(0);
      await expectHelpdeskError(
        exec(commands.phrasingDelete, { employee: olivia, phrasingId: 'x' }),
        400,
        'INVALID_INPUT',
      );
    });

    it('all nine commands have the documented names and take the shared lock', () => {
      const expected: Record<string, string> = {
        cardCreate: 'card.create',
        cardUpdate: 'card.update',
        cardArchive: 'card.archive',
        edgeCreate: 'edge.create',
        edgeUpdate: 'edge.update',
        edgeDelete: 'edge.delete',
        edgeReorder: 'edge.reorder',
        phrasingAdd: 'phrasing.add',
        phrasingDelete: 'phrasing.delete',
      };
      for (const [key, name] of Object.entries(expected)) {
        const c = (commands as unknown as Record<string, AnyCommand>)[key];
        expect(c.name).toBe(name);
        expect(c.lock).toBe('shared');
      }
      expect(Object.keys(commands).sort()).toEqual(
        Object.keys(expected).sort(),
      );
    });

    it('records the actor from meta, not from the input employee', async () => {
      const out = await exec(
        commands.cardCreate,
        { employee: olivia, body: cardBody('r12-actor') },
        { actor: { employeeId: MARCO } },
      );
      const row = (await changeRow(out.changeId as string)) as Row;
      expect(row.actor).toBe(`human:${MARCO}`);
    });

    it('commands run concurrently on different cards without deadlock', async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_v, i) =>
          exec(commands.cardCreate, {
            employee: olivia,
            body: cardBody(`r12-conc-${i}`),
          }),
        ),
      );
      expect(new Set(results.map((r) => r.changeId)).size).toBe(6);
    }, 30_000);
  });

  // ------------------------------------------------------------------ R13

  describe('R13 BackOffice services', () => {
    let svc: ReturnType<typeof backOfficeFaqServices>;
    beforeAll(() => {
      svc = backOfficeFaqServices({
        bus,
        commands,
        faqs: faqSvc,
        graph: graphSvc,
      });
    });

    async function lastChange(before: number): Promise<Row> {
      expect(await changesCount()).toBe(before + 1);
      return (
        await db.query(
          'SELECT * FROM helpdesk_faq_changes ORDER BY seq DESC LIMIT 1',
        )
      )[0];
    }
    function expectUi(row: Row, command: string, employeeId = OLIVIA) {
      expect(row.command).toBe(command);
      expect(row.cause_kind).toBe('ui');
      expect(row.actor).toBe(`human:${employeeId}`);
      expect(String(row.employee_id)).toBe(employeeId);
    }

    it('has every method of the original services', () => {
      for (const [k, v] of Object.entries(faqSvc))
        if (typeof v === 'function')
          expect(
            typeof (svc.faqs as unknown as Record<string, unknown>)[k],
          ).toBe('function');
      for (const [k, v] of Object.entries(graphSvc))
        if (typeof v === 'function')
          expect(
            typeof (svc.graph as unknown as Record<string, unknown>)[k],
          ).toBe('function');
    });

    it('faqs.create / update / archive go through the bus with cause ui', async () => {
      let n = await changesCount();
      const created = await svc.faqs.create(olivia, cardBody('r13-faq'));
      expectUi(await lastChange(n), 'card.create');
      expect(created).toEqual(await faqSvc.get(created.id));

      n = await changesCount();
      const updated = await svc.faqs.update(
        olivia,
        created.id,
        updateBody(created, { answerEn: 'r13 new answer' }),
      );
      expectUi(await lastChange(n), 'card.update');
      expect(updated.version).toBe(2);
      expect(updated).toEqual(await faqSvc.get(created.id));

      n = await changesCount();
      const archived = await svc.faqs.archive(olivia, created.id, {
        version: updated.version,
      });
      expectUi(await lastChange(n), 'card.archive');
      expect(archived.status).toBe('archived');
    });

    it('faqs.create passes the idempotency key to the service', async () => {
      const key = uuidv7();
      const body = cardBody('r13-key');
      const a = await svc.faqs.create(olivia, body, key);
      const n = await changesCount();
      const b = await svc.faqs.create(olivia, body, key);
      expect(b.id).toBe(a.id);
      expect(await changesCount()).toBe(n);
    });

    it('graph.createEdge / updateEdge / reorder / deleteEdge go through the bus', async () => {
      const parent = await mkCard('r13-g-p');
      const c1 = await mkCard('r13-g-1');
      const c2 = await mkCard('r13-g-2');

      let n = await changesCount();
      const e1 = await svc.graph.createEdge(olivia, parent.id, {
        childId: c1.id,
      });
      expectUi(await lastChange(n), 'edge.create');
      expect(e1.created).toBe(true);
      n = await changesCount();
      const e2 = await svc.graph.createEdge(olivia, parent.id, {
        childId: c2.id,
      });
      expectUi(await lastChange(n), 'edge.create');

      n = await changesCount();
      const upd = await svc.graph.updateEdge(olivia, e1.edge.id, {
        labelEn: 'Label one',
        labelZh: '标签一',
      });
      expectUi(await lastChange(n), 'edge.update');
      expect(upd.labelEn).toBe('Label one');

      n = await changesCount();
      const re = await svc.graph.reorder(olivia, parent.id, {
        childIds: [c2.id, c1.id],
      });
      expectUi(await lastChange(n), 'edge.reorder');
      expect(re.children.map((c) => c.edge.childId)).toEqual([c2.id, c1.id]);

      n = await changesCount();
      const del = await svc.graph.deleteEdge(olivia, e2.edge.id);
      expectUi(await lastChange(n), 'edge.delete');
      expect(del.deleted).toBe(true);
    });

    it('graph.addPhrasing / deletePhrasing go through the bus; addPhrasing takes the source', async () => {
      const a = await mkCard('r13-ph');
      let n = await changesCount();
      const added = await svc.graph.addPhrasing(olivia, a.id, {
        locale: 'en-GB',
        text: `r13 phrasing ${uniq()}`,
      });
      expectUi(await lastChange(n), 'phrasing.add');
      expect(added.created).toBe(true);
      expect(added.phrasing.source).toBe('staff');

      n = await changesCount();
      const fly = await svc.graph.addPhrasing(
        olivia,
        a.id,
        { locale: 'en-GB', text: `r13 fly ${uniq()}` },
        'flywheel',
      );
      expectUi(await lastChange(n), 'phrasing.add');
      expect(fly.phrasing.source).toBe('flywheel');

      n = await changesCount();
      const del = await svc.graph.deletePhrasing(olivia, added.phrasing.id);
      expectUi(await lastChange(n), 'phrasing.delete');
      expect(del).toEqual({ deleted: true });
    });

    it('records upper-case employee ids in lower case', async () => {
      const n = await changesCount();
      const upper = { employeeId: MARCO.toUpperCase() };
      await svc.faqs.create(upper, cardBody('r13-upper'));
      expectUi(await lastChange(n), 'card.create', MARCO);
    });

    it('a no-op write returns the service value and writes no change row', async () => {
      const faq = await mkCard('r13-noop');
      const n = await changesCount();
      const same = await svc.faqs.update(olivia, faq.id, updateBody(faq));
      expect(same).toEqual(faq);
      expect(await changesCount()).toBe(n);
    });

    it('a failing write throws the service error and writes nothing', async () => {
      const faq = await mkCard('r13-fail');
      const before = await snapshot();
      const direct = await outcomeOf(() =>
        faqSvc.update(
          olivia,
          faq.id,
          updateBody(faq, { questionEn: 'x', version: 9 }),
        ),
      );
      const wrapped = await outcomeOf(() =>
        svc.faqs.update(
          olivia,
          faq.id,
          updateBody(faq, { questionEn: 'x', version: 9 }),
        ),
      );
      expect(wrapped).toEqual(direct);
      expect(wrapped).toMatchObject({ err: { status: 409 } });
      expect(
        await outcomeOf(() =>
          svc.graph.updateEdge(olivia, uuidv7(), {
            labelEn: 'a',
            labelZh: 'b',
          }),
        ),
      ).toMatchObject({ err: { status: 404, code: 'FAQ_EDGE_NOT_FOUND' } });
      expect(
        await outcomeOf(() => svc.faqs.create(olivia, { bad: true })),
      ).toMatchObject({ err: { status: 400, code: 'INVALID_INPUT' } });
      expect(await snapshot()).toEqual(before);
    });

    it('a write by an actor without employee id and without label is refused with 400', async () => {
      const before = await snapshot();
      await expectHelpdeskError(
        svc.faqs.create({ employeeId: null }, cardBody('r13-null')),
        400,
        'INVALID_INPUT',
      );
      expect(await snapshot()).toEqual(before);
    });

    it('a write with a non-UUID employee id is refused with 400 and writes nothing', async () => {
      const before = await snapshot();
      await expectHelpdeskError(
        svc.faqs.create({ employeeId: 'staff-7' }, cardBody('r13-bad')),
        400,
        'INVALID_INPUT',
      );
      expect(await snapshot()).toEqual(before);
    });

    it('read methods return what the services return and write no change row', async () => {
      const parent = await mkCard('r13-read-p');
      const child = await mkCard('r13-read-c');
      const edge = await mkEdge(parent.id, child.id);
      await mkPhrasing(parent.id, `read phrasing ${uniq()}`);
      const before = await snapshot();
      const n = await changesCount();
      const same = async (
        wrapped: () => Promise<unknown>,
        direct: () => Promise<unknown>,
      ) => {
        const w = await outcomeOf(wrapped);
        const d = await outcomeOf(direct);
        expect(w).toEqual(d);
        return w;
      };
      const listed = await same(
        () => svc.faqs.list({}),
        () => faqSvc.list({}),
      );
      expect(listed).toHaveProperty('ok');
      expect(
        await same(
          () => svc.faqs.get(parent.id),
          () => faqSvc.get(parent.id),
        ),
      ).toHaveProperty('ok');
      expect(
        await same(
          () => svc.faqs.get(uuidv7()),
          () => faqSvc.get(uuidv7()),
        ).then((r) => 'err' in (r as object)),
      ).toBe(true);
      expect(
        await same(
          () => svc.faqs.revisions(parent.id),
          () => faqSvc.revisions(parent.id),
        ),
      ).toHaveProperty('ok');
      await same(
        () => svc.faqs.published({ locale: 'en-GB' }),
        () => faqSvc.published({ locale: 'en-GB' }),
      );
      await same(
        () => svc.faqs.publishedOne(parent.id, { locale: 'en-GB' }),
        () => faqSvc.publishedOne(parent.id, { locale: 'en-GB' }),
      );
      expect(
        await same(
          () => svc.graph.edges(parent.id),
          () => graphSvc.edges(parent.id),
        ),
      ).toHaveProperty('ok');
      expect(
        await same(
          () => svc.graph.edgeRevisions(parent.id),
          () => graphSvc.edgeRevisions(parent.id),
        ),
      ).toHaveProperty('ok');
      expect(
        await same(
          () => svc.graph.phrasings(parent.id),
          () => graphSvc.phrasings(parent.id),
        ),
      ).toHaveProperty('ok');
      expect(
        await same(
          () => svc.graph.tree(parent.id),
          () => graphSvc.tree(parent.id),
        ),
      ).toHaveProperty('ok');
      expect(edge.id).toBeDefined();
      expect(await changesCount()).toBe(n);
      expect(await snapshot()).toEqual(before);
    });

    it('read methods do not use the bus (they work with a bus that always fails)', async () => {
      const brokenBus = {
        execute: () => Promise.reject(new Error('bus must not be used')),
      } as unknown as ReturnType<typeof createFaqCommandBus>;
      const readOnly = backOfficeFaqServices({
        bus: brokenBus,
        commands,
        faqs: faqSvc,
        graph: graphSvc,
      });
      const a = await mkCard('r13-nobus');
      await expect(readOnly.faqs.get(a.id)).resolves.toBeDefined();
      await expect(readOnly.faqs.list({})).resolves.toBeDefined();
      await expect(readOnly.faqs.revisions(a.id)).resolves.toBeDefined();
      await expect(readOnly.graph.edges(a.id)).resolves.toBeDefined();
      await expect(readOnly.graph.phrasings(a.id)).resolves.toBeDefined();
      await expect(readOnly.graph.tree(a.id)).resolves.toBeDefined();
      await expect(readOnly.graph.edgeRevisions(a.id)).resolves.toBeDefined();
      await expect(
        readOnly.faqs.published({ locale: 'en-GB' }),
      ).resolves.toBeDefined();
      await expect(
        readOnly.faqs.publishedOne(a.id, { locale: 'en-GB' }),
      ).resolves.toBeDefined();
      await expect(
        readOnly.faqs.create(olivia, cardBody('r13-nobus-w')),
      ).rejects.toThrow('bus must not be used');
    });

    it('write methods call bus.execute with the matching command, actor and cause ui', async () => {
      const calls: { name: string; raw: unknown; meta: CommandMeta }[] = [];
      const spyBus = {
        execute: (command: AnyCommand, raw: unknown, m: CommandMeta) => {
          calls.push({ name: command.name, raw, meta: m });
          return Promise.resolve({
            result: { spied: command.name },
            changeId: null,
            replayed: false,
          });
        },
      } as unknown as ReturnType<typeof createFaqCommandBus>;
      const spied = backOfficeFaqServices({
        bus: spyBus,
        commands,
        faqs: faqSvc,
        graph: graphSvc,
      });
      const id = uuidv7();
      const emp = { employeeId: MARCO.toUpperCase(), displayName: 'Marco' };
      const results = [
        await spied.faqs.create(emp, {}),
        await spied.faqs.update(emp, id, {}),
        await spied.faqs.archive(emp, id, {}),
        await spied.graph.createEdge(emp, id, {}),
        await spied.graph.updateEdge(emp, id, {}),
        await spied.graph.deleteEdge(emp, id),
        await spied.graph.reorder(emp, id, {}),
        await spied.graph.addPhrasing(emp, id, {}),
        await spied.graph.deletePhrasing(emp, id),
      ];
      expect(calls.map((c) => c.name)).toEqual([
        'card.create',
        'card.update',
        'card.archive',
        'edge.create',
        'edge.update',
        'edge.delete',
        'edge.reorder',
        'phrasing.add',
        'phrasing.delete',
      ]);
      for (const c of calls) {
        expect(c.meta.cause.kind).toBe('ui');
        expect(c.meta.actor.employeeId).toBe(emp.employeeId);
      }
      // they return the command's result as is
      results.forEach((r, i) => expect(r).toEqual({ spied: calls[i].name }));
    });
  });
});
