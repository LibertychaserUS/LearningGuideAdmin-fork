import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import type {
  GapLabelInput,
  GapLabelResult,
  GapLabeller,
} from '../../contracts/helpdesk-flywheel';
import type {
  InsightTurn,
  InsightsPage,
  TicketDetail,
} from '../modules/helpdesk/contracts';
import type { HelpdeskFaq } from '../modules/helpdesk/faqs/faqContracts';
import { createPgFaqGraphRepository } from '../modules/helpdesk/faqs/faqGraphRepository';
import { createFaqGraphService } from '../modules/helpdesk/faqs/faqGraphService';
import {
  createPgFaqMapRepository,
  type MapNodeInput,
} from '../modules/helpdesk/faqs/faqMapRepository';
import {
  createPgFaqRepository,
  type SqlDb,
} from '../modules/helpdesk/faqs/faqRepository';
import { createRetrievalGate } from '../modules/helpdesk/faqs/faqReleaseGate';
import { createFaqReleaseService } from '../modules/helpdesk/faqs/faqReleaseService';
import { createFaqService } from '../modules/helpdesk/faqs/faqService';
import { createPgCandidateRepository } from '../modules/helpdesk/flywheel/candidateRepository';
import {
  DRAFT_LABEL,
  createFaqCandidateService,
} from '../modules/helpdesk/flywheel/faqCandidateService';
import {
  createJobRunner,
  createPgJobLock,
  createPgJobRunRepository,
  type JobRun,
} from '../modules/helpdesk/flywheel/flywheelJobs';
import { miningTurn } from '../modules/helpdesk/flywheel/flywheelMining';
import { createFlywheelMetrics } from '../modules/helpdesk/flywheel/flywheelMetrics';
import {
  FlywheelRunError,
  PULL_LIMITS,
  createFlywheelService,
  workingNodeTexts,
} from '../modules/helpdesk/flywheel/flywheelService';
import { createPgInsightRepository } from '../modules/helpdesk/flywheel/insightRepository';
import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';

/**
 * 数据飞轮在 PostgreSQL 上（v5 Part G3–G6，迁移 20261031090000）：事实表的幂等 upsert 与指标视图、
 * 夜间的拉取 + 挖掘（端到端、重跑不重复）、员工的接受 / 驳回 / 合并 / 从工单转候选（幂等、版本、审计）、
 * 运行行（每天一次、失败重试至多 3 次、停住的接手、advisory lock 跨连接互斥、立即运行的幂等）。
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

const EMP = '0192aaaa-0000-7000-8000-000000000001';
const OTHER_EMP = '0192aaaa-0000-7000-8000-000000000002';
const staff = { employeeId: EMP };
const KEY = (n: number) =>
  `0192bbbb-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-11-02T20:00:00.000Z');
const HOUR = 3_600_000;

let seq = 0;
function turn(overrides: Partial<InsightTurn> = {}): InsightTurn {
  seq += 1;
  return {
    id: `01a18100-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    createdAt: new Date(NOW.getTime() - 48 * HOUR + seq * 1000).toISOString(),
    source: 'chat',
    locale: 'zh-CN',
    text: '付款成功了但是课程没有开通',
    sessionId: null,
    turnIndex: 1,
    lastTurn: false,
    sessionEndReason: null,
    kind: 'no_match',
    intent: 'question',
    guard: 'passed',
    via: 'typed',
    faqId: null,
    nodeId: null,
    parentNodeId: null,
    releaseVersion: null,
    answered: false,
    vote: null,
    rating: null,
    covered: null,
    expanded: null,
    handover: false,
    ticketAfterChat: false,
    ticket: null,
    signals: [],
    ...overrides,
  };
}

async function rejects(
  work: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HelpdeskError);
  expect(error).toMatchObject({ status, code });
}

const PAID = [
  '付款成功了但是课程没有开通',
  '已经付款了课程还是没开通',
  '付款成功课程没开通',
  '我付款成功了，课程没有开通 <phone>',
  '付款成功了课程一直没开通',
];
const OTHER = [
  '为什么扣了两次钱',
  '证书在哪里下载',
  'how do I join a study group',
  'the video keeps buffering',
];

describeDb('Helpdesk data flywheel (PostgreSQL)', () => {
  const schema = `hdflywheel_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let db: SqlDb;

  const insights = () => createPgInsightRepository(db);
  const candidates = () => createPgCandidateRepository(db);
  const graph = () => createPgFaqGraphRepository(db);

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    await pool.query(migrationSql());
    db = sqlDb(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE helpdesk_flywheel_runs, helpdesk_faq_eval_cases, helpdesk_faq_candidate_revisions,
                helpdesk_faq_candidate_turns, helpdesk_faq_candidates, helpdesk_insight_turns,
                helpdesk_faq_release_vectors, helpdesk_faq_embeddings,
                helpdesk_faq_release_nodes, helpdesk_faq_releases, helpdesk_faq_edge_revisions,
                helpdesk_faq_edges, helpdesk_faq_phrasings, helpdesk_faq_revisions,
                helpdesk_faq_map_revisions, helpdesk_faq_placements, helpdesk_faq_map_nodes,
                helpdesk_faqs CASCADE`,
    );
  });

  let faqCounter = 0;
  async function faq(
    fields: Record<string, unknown> = {},
  ): Promise<HelpdeskFaq> {
    faqCounter += 1;
    const repo = createPgFaqRepository(db);
    return createFaqService({
      repository: repo,
      liveParents: (id) => graph().liveParents(id),
    }).create(staff, {
      category: 'payments_subscriptions',
      popular: false,
      questionEn: `Question number ${faqCounter}?`,
      answerEn: 'Answer.',
      questionZh: `第${faqCounter}个问题？`,
      answerZh: '答案。',
      keywords: [],
      ...fields,
    });
  }

  // ------------------------------------------------------------ 事实表与指标

  describe('the fact table and its metrics view (G6)', () => {
    it('upserts by turn id: a re-pull of the same turns changes nothing; a later vote updates the row', async () => {
      const repo = insights();
      const a = turn();
      const b = turn({ kind: 'answer', answered: true, faqId: null });
      expect(await repo.upsertTurns([a, b])).toEqual({
        inserted: 2,
        updated: 0,
      });
      const [before] = (
        await pool.query<{ updated_at: Date }>(
          'SELECT updated_at FROM helpdesk_insight_turns WHERE id = $1',
          [a.id],
        )
      ).rows;
      expect(await repo.upsertTurns([a, b])).toEqual({
        inserted: 0,
        updated: 0,
      });
      expect(
        await repo.upsertTurns([{ ...b, vote: 'not_helpful', rating: 2 }]),
      ).toEqual({ inserted: 0, updated: 1 });
      const rows = (
        await pool.query<{ id: string; vote: string; updated_at: Date }>(
          'SELECT id, vote, updated_at FROM helpdesk_insight_turns ORDER BY id',
        )
      ).rows;
      expect(rows.map((r) => r.vote)).toEqual([null, 'not_helpful']);
      expect(rows[0].updated_at.getTime()).toBe(before.updated_at.getTime());
      expect(await repo.latestTurnAt()).toBe(b.createdAt);
    });

    it('derives AI-solved (no ticket within 24 h of a settled answer), gaps and the guard fallback in SQL', async () => {
      const old = new Date(Date.now() - 48 * HOUR).toISOString();
      const fresh = new Date(Date.now() - HOUR).toISOString();
      const rows = [
        turn({ id: KEY(1), kind: 'answer', answered: true, createdAt: old }),
        turn({
          id: KEY(2),
          kind: 'answer',
          answered: true,
          createdAt: old,
          ticketAfterChat: true,
        }),
        turn({ id: KEY(3), kind: 'answer', answered: true, createdAt: fresh }),
        turn({ id: KEY(4), kind: 'clarify', covered: false, createdAt: old }),
        turn({ id: KEY(5), kind: 'clarify', covered: true, createdAt: old }),
        turn({
          id: KEY(6),
          kind: 'answer',
          rating: 2,
          guard: 'ungrounded',
          createdAt: old,
        }),
        turn({ id: KEY(7), kind: 'smalltalk', guard: null, createdAt: old }),
      ];
      await insights().upsertTurns(rows);
      const facts = (
        await pool.query<Record<string, unknown>>(
          `SELECT id, answer_settled, ai_solved, unsolved, gap_clarify_not_covered, gap_low_rating,
                  clarify_covered, guarded, guard_fallback
             FROM helpdesk_insight_turn_facts ORDER BY id`,
        )
      ).rows;
      const by = (id: string) => facts.find((f) => f.id === id)!;
      expect(by(KEY(1))).toMatchObject({ ai_solved: true, unsolved: false });
      expect(by(KEY(2))).toMatchObject({ ai_solved: false, unsolved: true });
      expect(by(KEY(3))).toMatchObject({
        answer_settled: false,
        ai_solved: false,
      });
      expect(by(KEY(4))).toMatchObject({
        gap_clarify_not_covered: true,
        unsolved: true,
      });
      expect(by(KEY(5))).toMatchObject({
        clarify_covered: true,
        unsolved: false,
      });
      expect(by(KEY(6))).toMatchObject({
        gap_low_rating: true,
        guard_fallback: true,
      });
      expect(by(KEY(7))).toMatchObject({ guarded: false, unsolved: false });
    });

    it('counts an answer as settled only after a pull at least 24 h later saw no ticket (a late or failed pull never overstates AI-solved)', async () => {
      const answer = turn({
        id: KEY(11),
        kind: 'answer',
        answered: true,
        createdAt: new Date(Date.now() - 30 * HOUR).toISOString(),
      });
      await insights().upsertTurns([answer]);
      // 上一次拉取在答案之后 9 小时：那时还看不出 24 小时内有没有工单
      await pool.query(
        `UPDATE helpdesk_insight_turns SET checked_at = created_at + interval '9 hours' WHERE id = $1`,
        [answer.id],
      );
      const facts = async () =>
        (
          await pool.query<Record<string, unknown>>(
            'SELECT answer_settled, ai_solved FROM helpdesk_insight_turn_facts WHERE id = $1',
            [answer.id],
          )
        ).rows[0];
      expect(await facts()).toEqual({
        answer_settled: false,
        ai_solved: false,
      });
      // 下一次拉取（这一行没变）证明 24 小时内没有工单
      expect(await insights().upsertTurns([answer])).toEqual({
        inserted: 0,
        updated: 0,
      });
      expect(await facts()).toEqual({ answer_settled: true, ai_solved: true });
      expect(
        Date.parse((await insights().lastIngestedAt()) ?? ''),
      ).toBeGreaterThan(Date.now() - 60_000);
    });

    it('serves daily and weekly rates split by locale, entry and signal; empty denominators are null', async () => {
      const day = (offsetDays: number) =>
        new Date(
          Date.UTC(2026, 9, 20 + offsetDays, 10, 0, 0) /* 2026-10-20 */,
        ).toISOString();
      const node = await faq({ questionEn: 'How do I get a refund?' });
      await insights().upsertTurns([
        turn({
          kind: 'answer',
          answered: true,
          faqId: node.id,
          vote: 'helpful',
          rating: 5,
          createdAt: day(0),
          source: 'chip',
          signals: ['payment_failed'],
        }),
        turn({
          kind: 'answer',
          answered: true,
          faqId: node.id,
          vote: 'not_helpful',
          rating: 1,
          ticketAfterChat: true,
          createdAt: day(0),
          locale: 'en-GB',
        }),
        turn({ kind: 'no_match', createdAt: day(1), handover: true }),
        turn({ kind: 'clarify', covered: true, createdAt: day(8) }),
      ]);
      const metrics = createFlywheelMetrics({
        insights: insights(),
        graph: graph(),
        now: () => new Date('2026-11-01T00:00:00Z'),
      });
      const all = await metrics.metrics({
        from: '2026-10-20',
        to: '2026-10-31',
      });
      expect(all.source).toBe('portal_insights');
      expect(all.totals).toHaveLength(1);
      expect(all.totals[0]).toMatchObject({
        turns: 4,
        answersSettled: 2,
        aiSolvedRate: 0.5,
        noMatchRate: 0.25,
        helpfulRate: 0.5,
        avgRating: 3,
        handoverRate: 0.25,
        clarifyCoveredRate: 1,
        guardFallbackRate: 0,
      });
      expect(all.series.map((r) => r.bucket)).toEqual([
        '2026-10-20',
        '2026-10-21',
        '2026-10-28',
      ]);
      expect(all.series[2]).toMatchObject({
        helpfulRate: null,
        aiSolvedRate: null,
        avgRating: null,
      });
      const weekly = await metrics.metrics({
        granularity: 'week',
        split: 'entry',
        from: '2026-10-19',
        to: '2026-10-31',
      });
      expect(weekly.series.map((r) => [r.bucket, r.segment, r.turns])).toEqual([
        ['2026-10-19', 'chat', 2],
        ['2026-10-19', 'chip', 1],
        ['2026-10-26', 'chat', 1],
      ]);
      // 日与周都按 UTC 切，周从周一开始；不完整的周（这段时间只盖住了一部分）标出来
      expect(weekly).toMatchObject({ timezone: 'UTC', weekStartsOn: 'monday' });
      expect(weekly.series.map((r) => [r.bucket, r.partial])).toEqual([
        ['2026-10-19', false],
        ['2026-10-19', false],
        ['2026-10-26', true],
      ]);
      expect(all.timezone).toBe('UTC');
      expect(all.series.every((r) => r.partial === false)).toBe(true);
      const locales = await metrics.metrics({
        split: 'locale',
        from: '2026-10-20',
        to: '2026-10-20',
      });
      expect(locales.totals.map((r) => [r.segment, r.turns])).toEqual([
        ['en-GB', 1],
        ['zh-CN', 1],
      ]);
      const signals = await metrics.metrics({
        split: 'signal',
        from: '2026-10-20',
        to: '2026-10-20',
      });
      expect(signals.totals.map((r) => [r.segment, r.turns])).toEqual([
        ['none', 1],
        ['payment_failed', 1],
      ]);
      expect(all.ticketFaqs).toEqual([
        expect.objectContaining({
          faqId: node.id,
          answers: 2,
          ticketsAfter: 1,
          ticketRate: 0.5,
          questionEn: 'How do I get a refund?',
        }),
      ]);
      await rejects(
        metrics.metrics({ granularity: 'month' }),
        400,
        'INVALID_INPUT',
      );
      await rejects(
        metrics.metrics({ from: '2026-01-01', to: '2026-10-31' }),
        400,
        'INVALID_INPUT',
      );
      await rejects(
        metrics.metrics({ split: 'student' }),
        400,
        'INVALID_INPUT',
      );
      await rejects(
        metrics.metrics({ from: '2026-02-30' }),
        400,
        'INVALID_INPUT',
      );
    });
  });

  // ------------------------------------------------------------- 夜间挖掘

  describe('the nightly pull and gap mining (G3)', () => {
    function fakePortal(pages: InsightTurn[][]) {
      const calls: Record<string, unknown>[] = [];
      return {
        calls,
        insights: jest.fn((q: Record<string, unknown>) => {
          calls.push(q);
          const index = q.cursor ? Number(q.cursor) : 0;
          const page: InsightsPage = {
            turns: pages[index] ?? [],
            nextCursor: index + 1 < pages.length ? String(index + 1) : null,
            until: NOW.toISOString(),
          };
          return Promise.resolve(page);
        }),
      };
    }

    function labeller(results: GapLabelResult[]): GapLabeller & {
      inputs: GapLabelInput[];
    } {
      const inputs: GapLabelInput[] = [];
      return {
        inputs,
        label: (input) => {
          inputs.push(input);
          return Promise.resolve(
            results.shift() ?? { ok: false, reason: 'error', costUsd: null },
          );
        },
      };
    }

    function service(
      portal: ReturnType<typeof fakePortal> | { insights: jest.Mock },
      gap?: GapLabeller,
    ) {
      return createFlywheelService({
        portal,
        insights: insights(),
        candidates: candidates(),
        nodes: () => workingNodeTexts(graph()),
        labeller: gap,
        now: () => NOW,
      });
    }

    it('pulls every page into the fact table, groups the unsolved turns and labels each new group once; a re-run adds nothing', async () => {
      const paid = PAID.map((text) => turn({ text }));
      const other = OTHER.map((text) =>
        turn({ text, locale: /[a-z]/.test(text) ? 'en-GB' : 'zh-CN' }),
      );
      const solved = turn({
        text: '怎么修改密码',
        kind: 'answer',
        answered: true,
        vote: 'helpful',
      });
      const portal = fakePortal([
        [...paid.slice(0, 3), solved],
        [...paid.slice(3), ...other],
      ]);
      const gap = labeller([
        {
          ok: true,
          label: {
            topic: '付款后课程未开通',
            question: '付款成功了课程为什么还没开通？',
            category: 'payments_subscriptions',
          },
          costUsd: 0.001,
        },
      ]);
      const first = await service(portal, gap).nightly();
      expect(portal.calls[0]).toEqual({
        since: new Date(NOW.getTime() - PULL_LIMITS.firstPullMs).toISOString(),
        limit: PULL_LIMITS.pageSize,
      });
      expect(portal.calls[1]).toMatchObject({ cursor: '1' });
      expect(first.stats.pull).toMatchObject({
        status: 'pulled',
        pages: 2,
        received: 10,
        inserted: 10,
      });
      expect(first.stats.mine).toMatchObject({
        considered: 9,
        mineable: 9,
        created: 1,
        turnsAdded: 5,
        singles: 4,
        modelCalls: 1,
        modelLabels: 1,
        costUsd: 0.001,
      });
      // 模型只看到脱敏过的例句（至多 5 句）
      expect(gap.inputs).toHaveLength(1);
      expect(gap.inputs[0].examples.length).toBeLessThanOrEqual(5);
      const list = await candidates().list({ offset: 0, limit: 10 });
      expect(list.total).toBe(1);
      expect(list.candidates[0]).toMatchObject({
        status: 'new',
        suggestion: 'new_faq',
        origin: 'mining',
        topic: '付款后课程未开通',
        proposedQuestion: '付款成功了课程为什么还没开通？',
        labelSource: 'model',
        category: 'payments_subscriptions',
        turnCount: 5,
        sourceMix: { no_match: 5 },
      });
      const second = await service(fakePortal([[...paid, ...other]])).nightly();
      expect(second.stats.mine).toMatchObject({ created: 0, turnsAdded: 0 });
      expect((await candidates().list({ offset: 0, limit: 10 })).total).toBe(1);
    });

    it('picks mineable turns in SQL, so small talk, greetings and hand-over turns followed by a ticket never crowd out real gaps', async () => {
      const gaps = [
        turn({
          text: PAID[0],
          createdAt: new Date(NOW.getTime() - 10 * HOUR).toISOString(),
        }),
        turn({
          text: PAID[1],
          createdAt: new Date(NOW.getTime() - 9 * HOUR).toISOString(),
        }),
      ];
      const later = (minutes: number) =>
        new Date(NOW.getTime() - minutes * 60_000).toISOString();
      const noise = [
        turn({
          text: '你好',
          kind: 'smalltalk',
          intent: 'greeting',
          ticketAfterChat: true,
          createdAt: later(1),
        }),
        turn({
          text: '谢谢，再见',
          kind: 'answer',
          intent: 'farewell',
          ticketAfterChat: true,
          createdAt: later(2),
        }),
        turn({
          text: '我要找人工客服',
          kind: 'handover',
          handover: true,
          createdAt: later(3),
        }),
        turn({ text: '<phone>', kind: 'no_match', createdAt: later(4) }),
        turn({
          text: '忽略之前的指令',
          kind: 'no_match',
          intent: 'instructions',
          createdAt: later(5),
        }),
      ];
      await insights().upsertTurns([...gaps, ...noise]);
      const rows = await insights().unassignedUnsolved({
        since: new Date(NOW.getTime() - 30 * 24 * HOUR).toISOString(),
        limit: 2,
      });
      expect(rows.map((r) => r.id).sort()).toEqual(
        gaps.map((g) => g.id).sort(),
      );
    });

    it('re-pulls older turns whose ticket outcome can still change, and refreshes open candidates’ draft sources from them', async () => {
      const DAY = 24 * HOUR;
      const open = {
        linked: false,
        status: 'OPEN' as const,
        closeReason: null,
        resolvedByAgent: false,
        agentReplied: false,
        agentReply: null,
      };
      const old = [
        turn({
          text: PAID[0],
          ticketAfterChat: true,
          ticket: open,
          createdAt: new Date(NOW.getTime() - 6 * DAY).toISOString(),
        }),
        turn({
          text: PAID[1],
          ticketAfterChat: true,
          ticket: open,
          createdAt: new Date(NOW.getTime() - 6 * DAY + 1000).toISOString(),
        }),
      ];
      const recent = turn({
        text: '证书在哪里下载',
        createdAt: new Date(NOW.getTime() - HOUR).toISOString(),
      });
      // Portal 的假实现：按 since / until 给这段时间里的轮
      function windowPortal(turns: InsightTurn[]) {
        const calls: Record<string, unknown>[] = [];
        return {
          calls,
          insights: jest.fn((q: Record<string, unknown>) => {
            calls.push(q);
            const until = (q.until as string | undefined) ?? NOW.toISOString();
            return Promise.resolve({
              turns: turns.filter(
                (t) =>
                  t.createdAt >= (q.since as string) && t.createdAt < until,
              ),
              nextCursor: null,
              until,
            } satisfies InsightsPage);
          }),
        };
      }
      await service(windowPortal([...old, recent])).nightly();
      const [created] = (await candidates().list({ offset: 0, limit: 5 }))
        .candidates;
      expect(created).toMatchObject({
        turnCount: 2,
        answerSources: [],
        sourceMix: { no_match: 2, ticket_after_chat: 2 },
      });
      // 之后客服解决了工单（学员确认）：比往回 72 小时更早，平常的拉取够不着
      const reply = '请退出后重新登录，课程会自动开通。';
      const resolved = old.map((t) => ({
        ...t,
        ticket: {
          ...open,
          status: 'CLOSED' as const,
          closeReason: 'user_confirmed' as const,
          resolvedByAgent: true,
          agentReplied: true,
          agentReply: reply,
        },
      }));
      const portal = windowPortal([...resolved, recent]);
      const second = await service(portal).nightly();
      const forwardSince = new Date(
        Date.parse(recent.createdAt) - PULL_LIMITS.lookbackMs,
      ).toISOString();
      expect(portal.calls).toEqual([
        { since: forwardSince, limit: PULL_LIMITS.pageSize },
        {
          since: old[0].createdAt,
          until: forwardSince,
          limit: PULL_LIMITS.pageSize,
        },
      ]);
      expect(second.stats.pull).toMatchObject({
        refresh: { since: old[0].createdAt, pages: 1, received: 2, updated: 2 },
      });
      const statuses = (
        await pool.query<{ ticket_status: string }>(
          'SELECT ticket_status FROM helpdesk_insight_turns WHERE id = ANY($1::uuid[])',
          [old.map((t) => t.id)],
        )
      ).rows.map((r) => r.ticket_status);
      expect(statuses).toEqual(['CLOSED', 'CLOSED']);
      const refreshed = await candidates().get(created.id);
      expect(refreshed?.answerSources).toEqual([reply]);
      expect(second.stats.mine).toMatchObject({ refreshed: 1 });
      // 都落定了：下一晚只拉往回 72 小时
      const third = windowPortal([...resolved, recent]);
      await service(third).nightly();
      expect(third.calls).toEqual([
        { since: forwardSince, limit: PULL_LIMITS.pageSize },
      ]);
    });

    it('grows an open candidate with later paraphrases and falls back to a code label when the model is off', async () => {
      await service(
        fakePortal([PAID.slice(0, 3).map((text) => turn({ text }))]),
      ).nightly();
      const [created] = (await candidates().list({ offset: 0, limit: 5 }))
        .candidates;
      expect(created.labelSource).toBe('code');
      expect(created.topic.length).toBeLessThanOrEqual(24);
      const later = PAID.slice(3).map((text) =>
        turn({
          text,
          kind: 'answer',
          vote: 'not_helpful',
          createdAt: new Date(NOW.getTime() - HOUR).toISOString(),
        }),
      );
      const night = await service(fakePortal([later])).nightly();
      expect(night.stats.mine).toMatchObject({
        grown: 1,
        created: 0,
        turnsAdded: 2,
      });
      const grown = await candidates().get(created.id);
      expect(grown).toMatchObject({
        turnCount: 5,
        sourceMix: { no_match: 3, not_helpful: 2 },
      });
      expect(
        (await candidates().revisions(created.id)).map((r) => r.action),
      ).toEqual(['create', 'grow']);
    });

    it('suggests a phrasing for a published FAQ the group is close to', async () => {
      const node = await faq({
        questionEn: 'I paid but my plan is not active',
        questionZh: '付款后会员没有生效怎么办？',
      });
      await service(
        fakePortal([
          [
            '付款后会员没有生效',
            '付款后会员一直没生效',
            '付了款会员没有生效',
          ].map((text) => turn({ text })),
        ]),
      ).nightly();
      const [candidate] = (await candidates().list({ offset: 0, limit: 5 }))
        .candidates;
      expect(candidate).toMatchObject({
        suggestion: 'add_phrasing',
        relatedNodeId: node.id,
      });
    });

    it('still mines when Portal is not connected; a Portal failure fails the run with its counts', async () => {
      await insights().upsertTurns(
        PAID.slice(0, 2).map((text) => turn({ text })),
      );
      const notConnected = {
        insights: jest.fn(() =>
          Promise.reject(
            new HelpdeskError(503, 'HELPDESK_NOT_CONNECTED', 'not connected'),
          ),
        ),
      };
      const ok = await service(notConnected).nightly();
      expect(ok.stats.pull).toMatchObject({ status: 'not_connected' });
      expect(ok.stats.mine).toMatchObject({ created: 1 });
      const down = {
        insights: jest.fn(() =>
          Promise.reject(new HelpdeskError(502, 'HELPDESK_UNAVAILABLE', 'x')),
        ),
      };
      const error = await service(down)
        .nightly()
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(FlywheelRunError);
      expect(error).toMatchObject({
        code: 'HELPDESK_UNAVAILABLE',
        stats: { pull: { status: 'failed' }, mine: { created: 0 } },
      });
    });

    it('a turn belongs to at most one candidate even when two nights race', async () => {
      const members = PAID.slice(0, 3).map((text) => turn({ text }));
      await insights().upsertTurns(members);
      const run = () =>
        createFlywheelService({
          portal: { insights: jest.fn() },
          insights: insights(),
          candidates: candidates(),
          nodes: () => Promise.resolve([]),
          now: () => NOW,
        }).mine();
      const [a, b] = await Promise.all([run(), run()]);
      expect(a.created + b.created).toBe(1);
      const { rows } = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM helpdesk_faq_candidate_turns',
      );
      expect(rows[0].n).toBe(3);
      expect((await candidates().list({ offset: 0, limit: 5 })).total).toBe(1);
    });
  });

  // ---------------------------------------------------------- 员工的动作

  describe('staff actions on candidates (G4) and the regression cases they add (G5)', () => {
    const tickets = new Map<string, TicketDetail>();
    const portal = {
      getTicket: jest.fn((id: string) => {
        const ticket = tickets.get(id);
        return ticket
          ? Promise.resolve(ticket)
          : Promise.reject(new HelpdeskError(404, 'TICKET_NOT_FOUND', 'x'));
      }),
    };

    const faqService = () =>
      createFaqService({
        repository: createPgFaqRepository(db),
        liveParents: (id) => graph().liveParents(id),
      });

    function candidateService(gap?: GapLabeller) {
      return createFaqCandidateService({
        candidates: candidates(),
        graph: graph(),
        graphService: createFaqGraphService({ graph: graph() }),
        portal,
        nodes: () => workingNodeTexts(graph()),
        map: createPgFaqMapRepository(db),
        faqs: faqService(),
        shownCards: (ids) => insights().shownCards(ids),
        labeller: gap,
        now: () => NOW,
      });
    }

    const mapNode = (
      key: string,
      kind: MapNodeInput['kind'],
      parentKey: string | null,
      extra: Partial<MapNodeInput> = {},
    ): MapNodeInput => ({
      key,
      kind,
      parentKey,
      stageKey: null,
      attribute: null,
      position: 0,
      labelEn: `${key} (en)`,
      labelZh: `${key}（中）`,
      ...extra,
    });

    /** 一个阶段两步一个岔子，一个对象一格。 */
    async function seedMap() {
      const map = createPgFaqMapRepository(db);
      for (const input of [
        mapNode('purchase', 'stage', null),
        mapNode('purchase.pay', 'step', 'purchase'),
        mapNode('purchase.activate', 'step', 'purchase'),
        mapNode('purchase.activate.delayed', 'deviation', 'purchase.activate'),
        mapNode('rules.plan', 'object', null, { stageKey: 'purchase' }),
        mapNode('rules.plan.price', 'cell', 'rules.plan', {
          attribute: 'price',
        }),
      ])
        await map.upsertNode(input, staff);
      const nodes = await map.nodes();
      const id = (key: string) => nodes.find((n) => n.key === key)!.id;
      return { map, id };
    }

    async function mined(
      texts: string[] = PAID,
      extra: Partial<InsightTurn> = {},
    ) {
      const turns = texts.map((text) => turn({ text, ...extra }));
      await insights().upsertTurns(turns);
      const created = await candidates().insertCandidate(
        {
          suggestion: 'new_faq',
          origin: 'mining',
          topic: '付款后课程未开通',
          proposedQuestion: '付款成功了课程为什么还没开通？',
          labelSource: 'code',
          category: 'payments_subscriptions',
          locale: 'zh-CN',
          examples: turns.slice(0, 5).map((t) => ({
            turnId: t.id,
            text: t.text,
            locale: 'zh-CN',
            reasons: ['no_match'],
          })),
          sourceMix: { no_match: texts.length },
          answerSources: ['Hi <name>, we re-synced your payment.'],
          relatedNodeId: null,
          relatedScore: null,
          parentNodeId: null,
          shownNodeId: null,
          ticketId: null,
          firstSeenAt: NOW.toISOString(),
          lastSeenAt: NOW.toISOString(),
          createdBy: null,
        },
        turns.map(miningTurn),
      );
      return created!;
    }

    it('accepts as phrasings: placeholder-free examples become flywheel phrasings or regression cases, never both', async () => {
      const node = await faq({ questionZh: '付款后课程没有开通怎么办？' });
      const candidate = await mined();
      const service = candidateService();
      const result = await service.accept(
        staff,
        candidate.id,
        { as: 'add_phrasing', faqId: node.id, version: candidate.version },
        KEY(1),
      );
      // 4 句不带占位符的例句：第 1、3 句加成问法，第 2、4 句只当回归题（splitForEval）
      expect(result).toMatchObject({
        replayed: false,
        phrasingsAdded: 2,
        evalCasesAdded: 2,
        heldOut: 2,
        candidate: {
          status: 'accepted',
          acceptedAs: 'add_phrasing',
          acceptedFaqId: node.id,
          decidedBy: EMP,
          version: candidate.version + 1,
        },
      });
      const phrasings = await graph().phrasingsOf(node.id);
      expect(phrasings.map((p) => p.source)).toEqual(Array(2).fill('flywheel'));
      expect(phrasings.some((p) => p.text.includes('<'))).toBe(false);
      const cases = await candidates().evalCases();
      expect(cases).toHaveLength(2);
      // 同一句话不会既是问法又是回归题（检查不拿卡里的原句考它自己）
      const own = new Set(phrasings.map((p) => p.text));
      expect(cases.some((c) => own.has(c.text))).toBe(false);
      expect(
        cases.every((c) => c.faqId === node.id && c.faqKey === node.key),
      ).toBe(true);
      // 带占位符的例句不当问法，也不当回归用例
      expect(cases.some((c) => c.text.includes('<'))).toBe(false);
      // 同一个 key 重试 → 原样返回；同一个 key 换决定 → 422；旧版本 → 409
      const again = await service.accept(
        staff,
        candidate.id,
        { as: 'add_phrasing', faqId: node.id, version: candidate.version },
        KEY(1),
      );
      expect(again.replayed).toBe(true);
      expect(again.candidate.version).toBe(candidate.version + 1);
      await rejects(
        service.dismiss(
          staff,
          candidate.id,
          { reason: 'spam', version: candidate.version },
          KEY(1),
        ),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
      await rejects(
        service.dismiss(staff, candidate.id, {
          reason: 'spam',
          version: candidate.version,
        }),
        409,
        'CANDIDATE_CHANGED',
      );
      await rejects(
        service.accept(
          { employeeId: OTHER_EMP },
          candidate.id,
          { as: 'add_phrasing', faqId: node.id, version: candidate.version },
          KEY(1),
        ),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
      expect(
        (await candidates().revisions(candidate.id)).map((r) => [
          r.action,
          r.employeeId,
        ]),
      ).toEqual([
        ['create', null],
        ['accept', EMP],
      ]);
      expect(await service.evalCasesJsonl()).toContain(
        `"faqKey":"${node.key}"`,
      );
    });

    it('only the examples staff ticked become phrasings or regression cases (an unticked one may be about something else or still hold a detail)', async () => {
      const node = await faq({ questionZh: '付款后课程没有开通怎么办？' });
      const candidate = await mined();
      const result = await candidateService().accept(
        staff,
        candidate.id,
        {
          as: 'add_phrasing',
          faqId: node.id,
          version: candidate.version,
          phrasings: [0, 2],
        },
        KEY(3),
      );
      expect(result).toMatchObject({
        phrasingsAdded: 1,
        evalCasesAdded: 1,
        heldOut: 1,
      });
      expect((await candidates().evalCases()).map((c) => c.text)).toEqual([
        PAID[2],
      ]);
      expect((await graph().phrasingsOf(node.id)).map((p) => p.text)).toEqual([
        PAID[0],
      ]);
      const none = await mined(['课程开通以后打不开视频', '视频一直打不开']);
      const nothing = await candidateService().accept(staff, none.id, {
        as: 'add_phrasing',
        faqId: node.id,
        version: none.version,
        phrasings: [],
      });
      expect(nothing).toMatchObject({
        phrasingsAdded: 0,
        evalCasesAdded: 0,
        heldOut: 0,
      });
      expect(await candidates().evalCases()).toHaveLength(1);
    });

    it('two staff accepting the same candidate at once: one wins, the other gets 409 and leaves nothing behind', async () => {
      const x = await faq({ questionZh: '付款后课程没有开通怎么办？' });
      const y = await faq({ questionZh: '付款后多久能开通课程？' });
      const parent = await faq({ questionZh: '付款问题' });
      const candidate = await mined();
      const service = candidateService();
      const results = await Promise.allSettled([
        service.accept(
          staff,
          candidate.id,
          { as: 'add_phrasing', faqId: x.id, version: candidate.version },
          KEY(4),
        ),
        service.accept(
          { employeeId: OTHER_EMP },
          candidate.id,
          {
            as: 'follow_up',
            faqId: y.id,
            parentId: parent.id,
            version: candidate.version,
          },
          KEY(5),
        ),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      expect([won.length, lost.length]).toEqual([1, 1]);
      expect(lost[0].reason).toMatchObject({
        status: 409,
        code: 'CANDIDATE_CHANGED',
      });
      const winner = (await candidates().get(candidate.id))!;
      const loserNode = winner.acceptedFaqId === x.id ? y : x;
      expect(await graph().phrasingsOf(loserNode.id)).toEqual([]);
      expect(
        (await candidates().evalCases()).every(
          (c) => c.faqId === winner.acceptedFaqId,
        ),
      ).toBe(true);
      const edges = await pool.query(
        'SELECT 1 FROM helpdesk_faq_edges WHERE child_id = $1',
        [y.id],
      );
      expect(edges.rowCount).toBe(winner.acceptedFaqId === y.id ? 1 : 0);
    });

    it('dismissing as personal data removes the text from the candidate and its turns in the fact table, and a later pull does not bring it back', async () => {
      const candidate = await mined();
      const turnIds = candidate.examples.map((e) => e.turnId!);
      const result = await candidateService().dismiss(
        { employeeId: EMP, displayName: 'Mei Staff' },
        candidate.id,
        { reason: 'personal_data', version: candidate.version },
        KEY(6),
      );
      expect(result.candidate).toMatchObject({
        status: 'dismissed',
        reason: 'personal_data',
        examples: [],
        answerSources: [],
        topic: '<redacted>',
        proposedQuestion: '<redacted>',
      });
      const turnsNow = async () =>
        (
          await pool.query<{
            text: string;
            agent_reply: string | null;
            redacted: boolean;
          }>(
            'SELECT text, agent_reply, redacted_at IS NOT NULL AS redacted FROM helpdesk_insight_turns WHERE id = ANY($1::uuid[])',
            [turnIds],
          )
        ).rows;
      expect(await turnsNow()).toEqual(
        turnIds.map(() => ({ text: '', agent_reply: null, redacted: true })),
      );
      const stored = JSON.stringify(
        (
          await pool.query(
            'SELECT before, after FROM helpdesk_faq_candidate_revisions WHERE candidate_id = $1',
            [candidate.id],
          )
        ).rows,
      );
      for (const text of [
        ...PAID,
        '付款后课程未开通',
        '付款成功了课程为什么还没开通？',
      ])
        expect(stored).not.toContain(text);
      // 再拉到同样的轮：文字不回来
      await insights().upsertTurns(
        turnIds.map((id, i) =>
          turn({
            id,
            text: PAID[i],
            ticket: {
              linked: true,
              status: 'CLOSED',
              closeReason: 'user_confirmed',
              resolvedByAgent: true,
              agentReplied: true,
              agentReply: 'reply',
            },
          }),
        ),
      );
      expect(await turnsNow()).toEqual(
        turnIds.map(() => ({ text: '', agent_reply: null, redacted: true })),
      );
      // 一般的驳回不动文字
      const other = await mined(['课程开通以后打不开视频', '视频一直打不开']);
      await candidateService().dismiss(staff, other.id, {
        reason: 'not_a_gap',
        version: other.version,
      });
      expect((await candidates().get(other.id))?.examples).toHaveLength(2);
    });

    it('the history names the staff member who acted', async () => {
      const node = await faq({ questionZh: '付款后课程没有开通怎么办？' });
      const candidate = await mined();
      await candidateService().accept(
        { employeeId: EMP, displayName: 'Mei Staff' },
        candidate.id,
        { as: 'add_phrasing', faqId: node.id, version: candidate.version },
      );
      expect(
        (await candidateService().get(candidate.id)).revisions.map((r) => [
          r.action,
          r.employeeId,
          r.employeeName,
        ]),
      ).toEqual([
        ['create', null, null],
        ['accept', EMP, 'Mei Staff'],
      ]);
    });

    it('the release gate evaluates the accepted examples against the node they were labelled with', async () => {
      const node = await faq({
        questionEn: 'I paid but the course is not open',
        questionZh: '付款成功了课程没有开通怎么办？',
      });
      await faq({
        questionEn: 'Where is my certificate?',
        questionZh: '证书在哪里下载？',
      });
      const candidate = await mined();
      await candidateService().accept(staff, candidate.id, {
        as: 'add_phrasing',
        faqId: node.id,
        version: candidate.version,
        phrasings: [0, 1, 2, 4],
      });
      const { release } = await createFaqReleaseService({
        graph: graph(),
        gate: createRetrievalGate(createPgFaqRepository(db), () => NOW, {
          regressionCases: () => candidates().evalCases(),
        }),
      }).create(staff);
      expect(release.evalReport).toMatchObject({
        kind: 'retrieval',
        passed: true,
        metrics: {
          // 2 道题的中英文 + 2 个问法 + 2 条留出来的回归用例（勾了 4 句，一半一半）
          cases: 8,
          regressionCases: 2,
          regressionSkipped: 0,
          regressionLeaked: 0,
          recallAt8: 1,
        },
      });
    });

    it('accepts as a new FAQ from the prefilled draft (answer left for staff; a resolved human reply is only a draft to verify)', async () => {
      const candidate = await mined();
      const service = candidateService();
      const draft = await service.draft(candidate.id);
      expect(draft.faq).toMatchObject({
        questionZh: '付款成功了课程为什么还没开通？',
        answerEn: '',
        answerZh: '',
        category: 'payments_subscriptions',
        entry: true,
      });
      expect(draft.answerDraft).toEqual({
        label: DRAFT_LABEL,
        sources: ['Hi <name>, we re-synced your payment.'],
      });
      expect(draft.phrasings.every((p) => !p.text.includes('<'))).toBe(true);
      // 员工写好答案、经 FAQ 的新建接口建节点，再带 faqId 接受
      const node = await faq({
        questionZh: draft.faq.questionZh,
        questionEn: 'I paid but the course is not open',
      });
      const result = await service.accept(
        staff,
        candidate.id,
        {
          as: 'new_faq',
          faqId: node.id,
          version: candidate.version,
          phrasings: [0, 1],
        },
        KEY(2),
      );
      expect(result).toMatchObject({
        phrasingsAdded: 1,
        evalCasesAdded: 1,
        heldOut: 1,
        candidate: { acceptedAs: 'new_faq', acceptedFaqId: node.id },
      });
      await rejects(
        candidateService().accept(
          staff,
          (await mined(['可以开发票吗', '怎么开发票'])).id,
          {
            as: 'new_faq',
            faqId: node.id,
            version: 1,
            phrasings: [9],
          },
        ),
        400,
        'INVALID_INPUT',
      );
    });

    it('accepts as a follow-up: links the new node under the parent where learners got stuck', async () => {
      const parent = await faq({
        questionEn: 'I paid but my plan is not active',
      });
      const child = await faq({
        questionEn: 'How long does activation take?',
        entry: false,
      });
      const candidate = await mined(
        ['那要等多久才能开通', '要等多久才能开通'],
        {
          kind: 'clarify',
          covered: false,
        },
      );
      await pool.query(
        'UPDATE helpdesk_faq_candidates SET suggestion = $2, parent_node_id = $3 WHERE id = $1',
        [candidate.id, 'follow_up', parent.id],
      );
      const result = await candidateService().accept(
        staff,
        candidate.id,
        { as: 'follow_up', faqId: child.id, version: candidate.version },
        KEY(3),
      );
      expect(result.edgeId).toEqual(expect.any(String));
      const { children } = await graph().edgesOf(parent.id);
      expect(children.map((e) => [e.childId, e.kind])).toEqual([
        [child.id, 'follow_up'],
      ]);
      expect(result.candidate).toMatchObject({
        acceptedAs: 'follow_up',
        parentNodeId: parent.id,
      });
    });

    it('a new card needs a place once the map has nodes; the chosen step becomes its primary place and the decision keeps it', async () => {
      const { map, id } = await seedMap();
      const card = await faq({ questionZh: '付款后多久能开通课程？' });
      const candidate = await mined();
      const service = candidateService();
      await rejects(
        service.accept(staff, candidate.id, {
          as: 'new_faq',
          faqId: card.id,
          version: candidate.version,
        }),
        400,
        'PLACE_REQUIRED',
      );
      await rejects(
        service.accept(staff, candidate.id, {
          as: 'new_faq',
          faqId: card.id,
          version: candidate.version,
          placementNodeId: id('purchase'),
        }),
        400,
        'INVALID_PLACE',
      );
      const result = await service.accept(
        staff,
        candidate.id,
        {
          as: 'new_faq',
          faqId: card.id,
          version: candidate.version,
          placementNodeId: id('purchase.activate'),
        },
        KEY(7),
      );
      expect(result).toMatchObject({
        placed: true,
        candidate: {
          status: 'accepted',
          acceptedPlaceId: id('purchase.activate'),
        },
      });
      expect(
        (await map.placements(card.id)).map((p) => [p.nodeId, p.primary]),
      ).toEqual([[id('purchase.activate'), true]]);
      // 写位置也留了结构的修订（谁、什么时候）
      const placement = (await map.placements(card.id))[0];
      expect(
        (await map.revisions(placement.id)).map((r) => [
          r.action,
          r.employeeId,
        ]),
      ).toEqual([['create', EMP]]);
    });

    it('accepts an update only after the card was edited; a new place replaces the old primary and keeps the other places', async () => {
      const { map, id } = await seedMap();
      const card = await faq({ questionZh: '付款后课程没有开通怎么办？' });
      await map.setPlacements(
        card.id,
        [
          { nodeKey: 'purchase.pay', primary: true },
          { nodeKey: 'rules.plan.price', primary: false },
        ],
        staff,
      );
      const candidate = await mined(PAID, {
        kind: 'answer',
        vote: 'not_helpful',
        nodeId: card.id,
      });
      await pool.query(
        'UPDATE helpdesk_faq_candidates SET suggestion = $2, related_node_id = $3 WHERE id = $1',
        [candidate.id, 'update_faq', card.id],
      );
      const service = candidateService();
      const body = {
        as: 'update_faq',
        faqId: card.id,
        version: candidate.version,
        placementNodeId: id('purchase.activate'),
      };
      await rejects(
        service.accept(staff, candidate.id, body),
        409,
        'FAQ_NOT_UPDATED',
      );
      await faqService().update(staff, card.id, {
        version: card.version,
        category: card.category,
        popular: card.popular,
        questionEn: card.questionEn,
        answerEn: card.answerEn,
        questionZh: card.questionZh,
        answerZh: '付款后 5 分钟内开通；超过 30 分钟请点「重新同步」。',
        keywords: card.keywords,
      });
      const result = await service.accept(staff, candidate.id, body, KEY(8));
      expect(result).toMatchObject({
        placed: true,
        phrasingsAdded: 2,
        evalCasesAdded: 2,
        heldOut: 2,
        candidate: { acceptedAs: 'update_faq', acceptedFaqId: card.id },
      });
      expect(
        (await map.placements(card.id))
          .map((p) => [p.nodeId, p.primary])
          .sort(),
      ).toEqual(
        [
          [id('purchase.activate'), true],
          [id('rules.plan.price'), false],
        ].sort(),
      );
    });

    it('retiring archives the card and moves its questions and phrasings to the kept card; a retry does nothing twice', async () => {
      const kept = await faq({ questionZh: '如何退出登录？' });
      const retired = await faq({
        questionEn: 'Where is the sign-out button?',
        questionZh: '退出登录的按钮在哪里？',
      });
      await createFaqGraphService({ graph: graph() }).addPhrasing(
        staff,
        retired.id,
        { locale: 'zh-CN', text: '找不到登出按钮' },
      );
      const candidate = await mined(['退出登录在哪', '怎么登出']);
      await pool.query(
        'UPDATE helpdesk_faq_candidates SET suggestion = $2, related_node_id = $3 WHERE id = $1',
        [candidate.id, 'retire_faq', retired.id],
      );
      const service = candidateService();
      await rejects(
        service.accept(staff, candidate.id, {
          as: 'retire_faq',
          faqId: kept.id,
          version: candidate.version,
        }),
        400,
        'INVALID_INPUT',
      );
      const result = await service.accept(
        staff,
        candidate.id,
        {
          as: 'retire_faq',
          faqId: retired.id,
          version: candidate.version,
          moveTo: kept.id,
        },
        KEY(9),
      );
      expect(result).toMatchObject({
        archived: true,
        phrasingsMoved: 3,
        phrasingsAdded: 0,
        evalCasesAdded: 0,
        candidate: { acceptedAs: 'retire_faq', acceptedFaqId: retired.id },
      });
      expect((await createPgFaqRepository(db).get(retired.id))!.status).toBe(
        'archived',
      );
      expect(
        (await graph().phrasingsOf(kept.id)).map((p) => p.text).sort(),
      ).toEqual(
        [
          'Where is the sign-out button?',
          '找不到登出按钮',
          '退出登录的按钮在哪里？',
        ].sort(),
      );
      const again = await service.accept(
        staff,
        candidate.id,
        {
          as: 'retire_faq',
          faqId: retired.id,
          version: candidate.version,
          moveTo: kept.id,
        },
        KEY(9),
      );
      expect(again.replayed).toBe(true);
      expect(await graph().phrasingsOf(kept.id)).toHaveLength(3);
    });

    it('review: similar cards same place first, places by vote, and how the AI handled each example', async () => {
      const { map, id } = await seedMap();
      const shown = await faq({
        questionEn: 'My payment went through but the course is not open',
        questionZh: '付款成功了课程为什么还没开通？',
      });
      const near = await faq({
        questionEn: 'How long until my course opens after paying?',
        questionZh: '付款后多久课程会开通？',
      });
      const far = await faq({
        questionEn: 'How do I change my password?',
        questionZh: '怎么修改密码？',
      });
      await map.setPlacements(
        shown.id,
        [{ nodeKey: 'purchase.activate', primary: true }],
        staff,
      );
      await map.setPlacements(
        near.id,
        [{ nodeKey: 'purchase.activate.delayed', primary: true }],
        staff,
      );
      await map.setPlacements(
        far.id,
        [{ nodeKey: 'rules.plan.price', primary: true }],
        staff,
      );
      const candidate = await mined(PAID, {
        kind: 'answer',
        vote: 'not_helpful',
        nodeId: shown.id,
      });
      await pool.query(
        'UPDATE helpdesk_faq_candidates SET suggestion = $2, related_node_id = $3, related_score = 0.8 WHERE id = $1',
        [candidate.id, 'update_faq', shown.id],
      );
      const review = await candidateService().review(candidate.id);
      expect(review).toMatchObject({
        candidateId: candidate.id,
        similaritySource: 'text',
        recommendation: {
          action: 'update_faq',
          faqId: shown.id,
          confidence: null,
        },
        userStates: null,
        netValue: null,
      });
      expect(review.recommendation.rationaleZh).toContain(
        '当时给用户看的就是这张卡',
      );
      expect(review.recommendation.rationale).toBe(
        review.recommendation.rationaleZh,
      );
      expect(review.handling.map((h) => [h.shownFaqId, h.outcome])).toEqual(
        candidate.examples.map(() => [shown.id, 'no_match']),
      );
      expect(review.similar[0]).toMatchObject({
        faqId: shown.id,
        samePlace: true,
        closeMatch: false,
        placePath: [
          {
            key: 'purchase',
            labelZh: 'purchase（中）',
            labelEn: 'purchase (en)',
          },
          {
            key: 'purchase.activate',
            labelZh: 'purchase.activate（中）',
            labelEn: 'purchase.activate (en)',
          },
        ],
      });
      expect(review.similar.map((s) => s.faqId)).toContain(near.id);
      expect(review.places[0]).toMatchObject({
        nodeId: id('purchase.activate'),
        kind: 'step',
      });
      expect(review.regions[0]).toMatchObject({
        key: 'purchase',
        kind: 'stage',
      });
      // 结构树：卡数只算主位置、没归档的
      const tree = await candidateService().faqMap();
      expect(
        tree.nodes
          .filter((n) => n.cards > 0)
          .map((n) => [n.key, n.cards])
          .sort(),
      ).toEqual(
        [
          ['purchase.activate', 1],
          ['purchase.activate.delayed', 1],
          ['rules.plan.price', 1],
        ].sort(),
      );
      // 修订号只增不减；挂在阶段下的对象带上阶段的 key
      expect(tree.version).toBeGreaterThan(0);
      const keyOf = new Map(tree.nodes.map((n) => [n.id, n.key]));
      for (const n of tree.nodes)
        expect(n.stageKey).toBe(n.stageId ? keyOf.get(n.stageId) : null);
    });

    it('dismisses with a reason (other needs a note, the note is scrubbed); later similar turns join the dismissed candidate, not the queue', async () => {
      const candidate = await mined(PAID.slice(0, 3));
      const service = candidateService();
      await rejects(
        service.dismiss(staff, candidate.id, {
          reason: 'other',
          version: candidate.version,
        }),
        400,
        'INVALID_INPUT',
      );
      await rejects(
        service.dismiss(staff, candidate.id, { reason: 'because', version: 1 }),
        400,
        'INVALID_INPUT',
      );
      const { candidate: dismissed } = await service.dismiss(
        staff,
        candidate.id,
        {
          reason: 'other',
          note: 'learner a.b@example.com asked twice',
          version: candidate.version,
        },
        KEY(4),
      );
      expect(dismissed).toMatchObject({ status: 'dismissed', reason: 'other' });
      expect(dismissed.reasonNote).toBe('learner <email> asked twice');
      await insights().upsertTurns(PAID.slice(3).map((text) => turn({ text })));
      const night = await createFlywheelService({
        portal: { insights: jest.fn() },
        insights: insights(),
        candidates: candidates(),
        nodes: () => Promise.resolve([]),
        now: () => NOW,
      }).mine();
      expect(night).toMatchObject({ created: 0, grown: 1 });
      expect(await candidates().get(candidate.id)).toMatchObject({
        status: 'dismissed',
        turnCount: 5,
      });
    });

    it('merges a duplicate into an open candidate (turns, counts and examples move)', async () => {
      const target = await mined(PAID.slice(0, 2));
      const source = await createPgCandidateRepository(db).insertCandidate(
        {
          ...target,
          examples: [
            {
              turnId: null,
              text: '付款成功课程没开通',
              locale: 'zh-CN',
              reasons: ['ticket'],
            },
          ],
          sourceMix: { ticket: 1 },
          answerSources: [],
          ticketId: KEY(900),
          origin: 'ticket',
          turnCount: 1,
        },
        [],
      );
      const service = candidateService();
      const merged = await service.merge(
        staff,
        source!.id,
        { targetId: target.id, version: source!.version },
        KEY(5),
      );
      expect(merged.source).toMatchObject({
        status: 'merged',
        mergedInto: target.id,
      });
      expect(merged.target).toMatchObject({
        turnCount: 3,
        sourceMix: { no_match: 2, ticket: 1 },
      });
      expect(
        (
          await service.merge(
            staff,
            source!.id,
            { targetId: target.id, version: source!.version },
            KEY(5),
          )
        ).replayed,
      ).toBe(true);
      await rejects(
        service.merge(staff, target.id, {
          targetId: source!.id,
          version: target.version,
        }),
        409,
        'CANDIDATE_CLOSED',
      );
    });

    it('turns a resolved ticket into a candidate once: scrubbed with the learner’s own name and email, the human reply kept as a draft source', async () => {
      const id = '01a18100-0000-7000-8000-00000000f001';
      const base = {
        id,
        number: 'HD-1',
        subject: 'Payment',
        category: 'payments_subscriptions',
        status: 'CLOSED',
        locale: 'zh-CN',
        learner: { id: 'L1', email: 'mei.chen@example.com', name: 'Mei Chen' },
        contactEmail: 'mei.alt@example.org',
        preview: '',
        unreadByAgent: false,
        tags: [],
        needsReply: null,
        assignee: null,
        sequence: 3,
        createdAt: '2026-10-30T08:00:00.000Z',
        updatedAt: '2026-10-31T08:00:00.000Z',
        lastMessageAt: null,
        lastMessageBy: null,
        confirmDueAt: null,
        closedAt: '2026-10-31T08:00:00.000Z',
        closeReason: 'user_confirmed',
        rating: 5,
        flagged: false,
        orderId: null,
        student: {
          id: 'L1',
          name: 'Mei Chen',
          accountEmail: 'mei.chen@example.com',
          contactEmail: 'mei.alt@example.org',
          joinedAt: null,
          totalEnquiries: null,
          currentCourse: null,
        },
        subscription: null,
        order: null,
        events: [],
        aiAssist: [],
        messages: [
          {
            id: 'm1',
            authorKind: 'learner',
            authorName: 'Mei Chen',
            body: '我是Mei Chen，付款成功了课程没有开通，邮箱 mei.alt@example.org 电话 13812345678',
            internal: false,
            attachments: [],
            createdAt: '2026-10-30T08:00:00.000Z',
          },
          {
            id: 'm2',
            authorKind: 'agent',
            authorName: 'Staff',
            body: 'internal note',
            internal: true,
            attachments: [],
            createdAt: '2026-10-30T09:00:00.000Z',
          },
          {
            id: 'm3',
            authorKind: 'agent',
            authorName: 'Staff',
            body: 'Mei Chen 你好，我们已重新同步付款，请重新登录。',
            internal: false,
            attachments: [],
            createdAt: '2026-10-30T10:00:00.000Z',
          },
        ],
      } as unknown as TicketDetail;
      tickets.set(id, base);
      const gap: GapLabeller = {
        label: () =>
          Promise.resolve({ ok: false, reason: 'disabled', costUsd: null }),
      };
      const service = candidateService(gap);
      const { candidate, created } = await service.fromTicket(staff, id);
      expect(created).toBe(true);
      expect(candidate).toMatchObject({
        origin: 'ticket',
        ticketId: id,
        turnCount: 1,
        sourceMix: { ticket: 1 },
        category: 'payments_subscriptions',
        createdBy: EMP,
      });
      const stored = JSON.stringify(
        (
          await pool.query(
            'SELECT * FROM helpdesk_faq_candidates WHERE id = $1',
            [candidate.id],
          )
        ).rows[0],
      );
      for (const secret of [
        'Mei Chen',
        'mei.alt@example.org',
        '13812345678',
        'internal note',
      ])
        expect(stored).not.toContain(secret);
      expect(candidate.examples[0].text).toContain('<name>');
      expect(candidate.answerSources).toEqual([
        '<name> 你好，我们已重新同步付款，请重新登录。',
      ]);
      const again = await service.fromTicket(staff, id);
      expect(again).toMatchObject({
        created: false,
        candidate: { id: candidate.id },
      });
      expect(portal.getTicket).toHaveBeenCalledTimes(1);
      tickets.set(KEY(901), {
        ...base,
        id: KEY(901),
        status: 'WAITING_USER',
      });
      await rejects(
        service.fromTicket(staff, KEY(901)),
        409,
        'TICKET_NOT_RESOLVED',
      );
      tickets.set(KEY(902), {
        ...base,
        id: KEY(902),
        closeReason: 'cancelled',
      });
      await rejects(
        service.fromTicket(staff, KEY(902)),
        409,
        'TICKET_NOT_RESOLVED',
      );
      // 学员自己关掉的工单（不是确认解决）：客服最后一句可能只是在追问，不当草稿来源
      tickets.set(KEY(903), {
        ...base,
        id: KEY(903),
        closeReason: 'user_closed',
      });
      const closed = await service.fromTicket(staff, KEY(903));
      expect(closed.created).toBe(true);
      expect(closed.candidate.answerSources).toEqual([]);
      tickets.set(KEY(904), {
        ...base,
        id: KEY(904),
        closeReason: 'auto_confirmed',
      });
      expect(
        (await service.fromTicket(staff, KEY(904))).candidate.answerSources,
      ).toHaveLength(1);
    });

    it('lists with filters and per-status counts', async () => {
      const a = await mined(PAID.slice(0, 2));
      await mined(['可以开发票吗', '怎么开发票']);
      await candidateService().dismiss(staff, a.id, {
        reason: 'duplicate',
        version: a.version,
      });
      const service = candidateService();
      const open = await service.list({ status: 'new' });
      expect(open.total).toBe(1);
      expect(open.counts).toMatchObject({ new: 1, dismissed: 1, accepted: 0 });
      expect((await service.list({ q: '发票' })).total).toBe(1);
      expect((await service.list({ q: '100%_' })).total).toBe(0);
      await rejects(service.list({ status: 'open' }), 400, 'INVALID_INPUT');
      await rejects(service.list({ pageSize: 500 }), 400, 'INVALID_INPUT');
    });
  });

  // --------------------------------------------------------------- 运行行

  describe('job runs: once a day, retried, taken over, locked across instances, run now (G3)', () => {
    const runs = () => createPgJobRunRepository(db);
    const day = '2026-11-02';

    it('claims the day once; a failure is retried up to 3 attempts; a stalled run is taken over', async () => {
      const repo = runs();
      const at = new Date('2026-11-02T18:30:00Z');
      const first = await repo.claimScheduled({
        job: 'gap_mining',
        day,
        instance: 'a',
        now: at,
      });
      expect(first.kind).toBe('claimed');
      const running = await repo.claimScheduled({
        job: 'gap_mining',
        day,
        instance: 'b',
        now: at,
      });
      expect(running.kind).toBe('running');
      // 心跳停了 30 分钟以上 → 接手
      const later = new Date(at.getTime() + 31 * 60_000);
      const takeover = await repo.claimScheduled({
        job: 'gap_mining',
        day,
        instance: 'b',
        now: later,
      });
      expect(takeover).toMatchObject({
        kind: 'claimed',
        takeover: true,
        run: { attempts: 2, instance: 'b' },
      });
      const run = (takeover as { run: JobRun }).run;
      await repo.finish({
        id: run.id,
        status: 'failed',
        now: later,
        stats: {},
        moreDue: false,
        errorCode: 'x',
      });
      const third = await repo.claimScheduled({
        job: 'gap_mining',
        day,
        instance: 'c',
        now: later,
      });
      expect(third).toMatchObject({ kind: 'claimed', run: { attempts: 3 } });
      await repo.finish({
        id: (third as { run: JobRun }).run.id,
        status: 'failed',
        now: later,
        stats: {},
        moreDue: false,
        errorCode: 'x',
      });
      expect(
        (
          await repo.claimScheduled({
            job: 'gap_mining',
            day,
            instance: 'c',
            now: later,
          })
        ).kind,
      ).toBe('gave_up');
      const next = await repo.claimScheduled({
        job: 'gap_mining',
        day: '2026-11-03',
        instance: 'c',
        now: later,
      });
      expect(next.kind).toBe('claimed');
      await repo.finish({
        id: (next as { run: JobRun }).run.id,
        status: 'succeeded',
        now: later,
        stats: { n: 1 },
        moreDue: false,
        errorCode: null,
      });
      expect(
        (
          await repo.claimScheduled({
            job: 'gap_mining',
            day: '2026-11-03',
            instance: 'd',
            now: later,
          })
        ).kind,
      ).toBe('done');
    });

    it('the advisory lock lets only one connection run at a time', async () => {
      const lockA = createPgJobLock(() => pool);
      const lockB = createPgJobLock(() => pool);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const a = lockA.withLock(() => held.then(() => 'a'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await lockB.withLock(() => Promise.resolve('b'))).toEqual({
        acquired: false,
      });
      release();
      expect(await a).toEqual({ acquired: true, value: 'a' });
      expect(await lockB.withLock(() => Promise.resolve('b'))).toEqual({
        acquired: true,
        value: 'b',
      });
    });

    it('a manual run left running by an instance that died is closed as failed (stale) by the next holder of the lock', async () => {
      const repo = runs();
      const stuck = await repo.startManual({
        job: 'gap_mining',
        day: '2026-11-02',
        instance: 'dead',
        now: new Date('2026-11-02T10:00:00Z'),
        idempotencyKey: KEY(20),
        employee: { id: EMP, name: 'Staff' },
      });
      expect(stuck.kind).toBe('claimed');
      const runner = createJobRunner({
        runs: repo,
        lock: createPgJobLock(() => pool),
        work: {
          gap_mining: () => Promise.resolve({ stats: {}, moreDue: false }),
        },
        instance: 'alive',
        now: () => new Date('2026-11-02T10:05:00Z'),
        logger: { log: () => undefined, warn: () => undefined },
      });
      const started = await runner.runNow(
        'gap_mining',
        { id: EMP, name: 'Staff' },
        KEY(21),
      );
      expect(started.outcome).toBe('started');
      await (started as { done: Promise<JobRun> }).done;
      const old = await repo.byKey('gap_mining', KEY(20));
      expect(old).toMatchObject({ status: 'failed', errorCode: 'stale' });
      // 同一个 key 再来：回那一次（已标失败），不会永远卡在 running
      expect(
        await runner.runNow('gap_mining', { id: EMP, name: 'Staff' }, KEY(20)),
      ).toMatchObject({ outcome: 'existing', run: { status: 'failed' } });
    });

    it('runs on schedule after 18:00 UTC with a run row and a structured log; run now is idempotent per key and refused while running', async () => {
      const logs: string[] = [];
      const logger = {
        log: (m: string) => logs.push(m),
        warn: (m: string) => logs.push(m),
      };
      let gate: () => void = () => undefined;
      const work = jest.fn(
        () =>
          new Promise<{ stats: Record<string, unknown>; moreDue: boolean }>(
            (resolve) => {
              gate = () => resolve({ stats: { created: 2 }, moreDue: false });
            },
          ),
      );
      let clock = new Date('2026-11-02T17:00:00Z');
      const runner = createJobRunner({
        runs: runs(),
        lock: createPgJobLock(() => pool),
        work: { gap_mining: work },
        instance: 'test-1',
        now: () => clock,
        logger,
      });
      expect(await runner.runScheduled('gap_mining')).toEqual({
        outcome: 'skipped',
        reason: 'too_early',
      });
      clock = new Date('2026-11-02T18:05:00Z');
      const scheduled = runner.runScheduled('gap_mining');
      await new Promise((resolve) => setTimeout(resolve, 50));
      // 定时的那次持有锁：立即运行 → already_running（不留运行行）
      expect(
        await runner.runNow('gap_mining', { id: EMP, name: 'Staff' }, KEY(10)),
      ).toEqual({ outcome: 'already_running' });
      gate();
      const done = await scheduled;
      expect(done).toMatchObject({
        outcome: 'ran',
        run: {
          status: 'succeeded',
          stats: { created: 2 },
          trigger: 'schedule',
        },
      });
      expect(await runner.runScheduled('gap_mining')).toEqual({
        outcome: 'skipped',
        reason: 'done',
      });
      const line = JSON.parse(
        logs.find((l) => l.includes('flywheel_job_run'))!,
      ) as Record<string, unknown>;
      expect(line).toMatchObject({
        type: 'helpdesk',
        event: 'flywheel_job_run',
        status: 'succeeded',
        instance: 'test-1',
      });
      const started = await runner.runNow(
        'gap_mining',
        { id: EMP, name: 'Staff' },
        KEY(11),
      );
      expect(started.outcome).toBe('started');
      gate();
      const finished = await (started as { done: Promise<JobRun> }).done;
      expect(finished).toMatchObject({
        trigger: 'manual',
        status: 'succeeded',
        requestedBy: { id: EMP, name: 'Staff' },
      });
      expect(
        await runner.runNow('gap_mining', { id: EMP, name: 'Staff' }, KEY(11)),
      ).toMatchObject({
        outcome: 'existing',
        run: { id: finished.id },
      });
      expect(
        await runner.runNow(
          'gap_mining',
          { id: OTHER_EMP, name: 'X' },
          KEY(11),
        ),
      ).toEqual({ outcome: 'conflict' });
      const { rows } = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM helpdesk_flywheel_runs',
      );
      expect(rows[0].n).toBe(2);
    });

    it('records a failed run with its error code and counts, never the error text', async () => {
      const runner = createJobRunner({
        runs: runs(),
        lock: createPgJobLock(() => pool),
        work: {
          gap_mining: () =>
            Promise.reject(
              new FlywheelRunError('HELPDESK_UNAVAILABLE', {
                pull: { pages: 1 },
              }),
            ),
        },
        instance: 'test-2',
        now: () => new Date('2026-11-02T19:00:00Z'),
        logger: { log: () => undefined, warn: () => undefined },
      });
      const result = await runner.runScheduled('gap_mining');
      expect(result).toMatchObject({
        outcome: 'ran',
        run: {
          status: 'failed',
          errorCode: 'HELPDESK_UNAVAILABLE',
          stats: { pull: { pages: 1 } },
        },
      });
    });
  });
});
