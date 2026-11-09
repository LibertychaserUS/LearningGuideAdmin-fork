import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';

import type { AgentStepRunner } from '../../src/ai/helpdesk/workflow/engine';
import { HELPDESK_CATEGORIES } from '../../src/contracts/helpdesk-qa';
import { runCli } from './cli';
import {
  budgetFrom,
  CALL_PROMPT_TOKENS_MAX,
  callCeilingUsd,
  caseLanguage,
  chooseModel,
  DEFAULT_BUDGET_USD,
  deadlineDeps,
  evalCutoff,
  evalDeadline,
  EVAL_LANGUAGES,
  EVAL_LOCALES,
  EVAL_PERSONAS,
  FAKE_MODEL_ID,
  helpdeskMigrationSql,
  loadCases,
  loadFaqs,
  markdownReport,
  markdownRetrievalReport,
  memoryQaSource,
  percentile,
  pgQaSource,
  retrievalQuery,
  runCases,
  runnerFor,
  runRetrieval,
  summarize,
  summarizeRetrieval,
  thinkingLabel,
  turnKind,
  writeReport,
  type CaseResult,
  type EvalCase,
  type EvalModel,
  type EvalReport,
  type RetrievalReport,
  type RetrievalResult,
} from './harness';
import { PICK_FAQ_MAX_TOKENS } from '../../src/ai/helpdesk/workflow/faq-workflow';

/**
 * Helpdesk 推荐评测（helpdesk-agent-v2-pi-dsh §5）在 CI 里跑：数据集合法且覆盖到位、
 * 报告的每个数字按定义算、预算到了就停、整套用假模型（pi faux provider）真跑一遍并写出报告。
 * 真模型的成绩只在有 OPENROUTER_API_KEY 时由 `npm run eval:helpdesk` 给出，这里不碰网络。
 */

const DIR = __dirname;
const faqs = loadFaqs(join(DIR, 'faqs.json'));
const cases = loadCases(join(DIR, 'cases.jsonl'));
const FAQ = (n: number) =>
  `0192f0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hd-eval-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('eval dataset', () => {
  it('has at least 150 cases with unique ids', () => {
    expect(cases.length).toBeGreaterThanOrEqual(150);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('only expects FAQs that exist in the seed library, and asks about every one of them', () => {
    const ids = new Set(faqs.map((f) => f.id));
    expect(ids.size).toBe(faqs.length);
    for (const item of cases) {
      if (item.expectedFaqId) expect(ids).toContain(item.expectedFaqId);
      for (const other of item.acceptableFaqIds ?? []) {
        expect(ids).toContain(other);
        expect(other).not.toBe(item.expectedFaqId);
      }
    }
    const asked = new Set(cases.map((c) => c.expectedFaqId));
    for (const faq of faqs) expect(asked).toContain(faq.id);
  });

  it('covers every locale and persona, with enough none cases to measure none precision and recall', () => {
    const count = (pick: (c: (typeof cases)[number]) => boolean) =>
      cases.filter(pick).length;
    for (const locale of EVAL_LOCALES)
      expect(count((c) => c.locale === locale)).toBeGreaterThanOrEqual(10);
    for (const persona of EVAL_PERSONAS)
      expect(count((c) => c.persona === persona)).toBeGreaterThanOrEqual(4);
    expect(count((c) => c.expectedFaqId === null)).toBeGreaterThanOrEqual(25);
    // 不可回答的问题都应该是 none
    expect(
      count((c) => c.persona === 'unanswerable' && c.expectedFaqId !== null),
    ).toBe(0);
    // 用户 2026-10-29：「帮我退款」这类代办请求做不了，推荐讲自助办法的 FAQ
    expect(cases.find((c) => c.id === 'over-01')?.expectedFaqId).toBe(FAQ(13));
    expect(cases.find((c) => c.id === 'over-07')?.expectedFaqId).toBe(FAQ(13));
    expect(
      count((c) => c.expectedFaqId === null && !!c.acceptableFaqIds?.length),
    ).toBe(0);
  });

  it('fills the locale x persona grid (at least 2 cases in every cell)', () => {
    for (const locale of EVAL_LOCALES)
      for (const persona of EVAL_PERSONAS)
        expect([
          locale,
          persona,
          cases.filter((c) => c.locale === locale && c.persona === persona)
            .length >= 2,
        ]).toEqual([locale, persona, true]);
  });

  it('has submit cases with a subject and an Enquiry Type, and inputs longer than the 2000-char prompt cut', () => {
    const submit = cases.filter((c) => c.source === 'submit');
    expect(submit.length).toBeGreaterThanOrEqual(4);
    for (const c of submit) {
      expect(c.subject?.trim()).toBeTruthy();
      expect(HELPDESK_CATEGORIES).toContain(c.category);
    }
    expect(
      cases.filter((c) => c.persona === 'long' && c.message.length > 2000)
        .length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('documents the Traditional-script cases that retrieval used to miss', () => {
    const noted = cases.filter((c) => c.note);
    expect(noted.map((c) => c.id)).toEqual([
      'tw-01',
      'tw-03',
      'tw-05',
      'tw-07',
      'tw-09',
    ]);
    for (const c of noted) expect(c.note).toMatch(/Traditional script/);
  });

  it('every seed FAQ has both languages and keywords', () => {
    for (const faq of faqs) {
      for (const text of [
        faq.questionEn,
        faq.answerEn,
        faq.questionZh,
        faq.answerZh,
      ])
        expect(text.trim()).not.toBe('');
      expect(faq.keywords.length).toBeGreaterThan(0);
    }
  });

  it('rejects a malformed case line with its line number', () => {
    const path = join(tmp, 'bad.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify(cases[0])}\n\n${JSON.stringify({ ...cases[0], locale: 'fr-FR' })}\n`,
    );
    expect(() => loadCases(path)).toThrow(`${path}:3: malformed case`);
  });

  it.each([
    [
      'a submit case with neither subject nor message',
      { source: 'submit', subject: '', message: '' },
    ],
    ['a chat case without a message', { message: ' ' }],
    ['an unknown source', { source: 'chip' }],
    [
      'an unknown Enquiry Type',
      { source: 'submit', subject: 's', category: 'billing' },
    ],
    ['a bad acceptable id', { acceptableFaqIds: ['x'] }],
  ])('rejects %s', (_name, patch) => {
    const path = join(tmp, 'bad2.jsonl');
    writeFileSync(path, `${JSON.stringify({ ...cases[0], ...patch })}\n`);
    expect(() => loadCases(path)).toThrow(`${path}:1: malformed case`);
  });

  it('accepts a submit case with only a subject', () => {
    const path = join(tmp, 'subject.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify({ ...cases[0], source: 'submit', subject: 'Invoice', category: 'payments_subscriptions', message: '' })}\n`,
    );
    expect(loadCases(path)[0]).toMatchObject({ source: 'submit', message: '' });
  });

  it('says so when the cases file is empty', () => {
    const path = join(tmp, 'empty.jsonl');
    writeFileSync(path, '\n');
    expect(() => loadCases(path)).toThrow(`${path}: no cases`);
  });

  it('accepts the optional role, conversation and turn fields', () => {
    const path = join(tmp, 'roles.jsonl');
    writeFileSync(
      path,
      [
        { ...cases[0], role: 'pays_for_another_account' },
        { ...cases[0], id: 't1', conversationId: 'conv-1', turn: 1 },
        { ...cases[0], id: 't2', conversationId: 'conv-1', turn: 2 },
        { ...cases[0], id: 'o1', origin: 'batch-01.jsonl#b1-001' },
      ]
        .map((c) => JSON.stringify(c))
        .join('\n'),
    );
    expect(
      loadCases(path).map((c) => [c.role, c.conversationId, c.turn]),
    ).toEqual([
      ['pays_for_another_account', undefined, undefined],
      [undefined, 'conv-1', 1],
      [undefined, 'conv-1', 2],
      [undefined, undefined, undefined],
    ]);
  });

  it.each([
    ['an empty role', { role: ' ' }],
    ['a role that is not text', { role: 7 }],
    ['a turn without a conversation', { turn: 1 }],
    ['a conversation without a turn', { conversationId: 'conv-1' }],
    ['a zero turn', { conversationId: 'conv-1', turn: 0 }],
    ['a fractional turn', { conversationId: 'conv-1', turn: 1.5 }],
    ['a turn that is text', { conversationId: 'conv-1', turn: '2' }],
    ['an empty conversation id', { conversationId: '', turn: 1 }],
  ])('rejects %s', (_name, patch) => {
    const path = join(tmp, 'bad3.jsonl');
    writeFileSync(path, `${JSON.stringify({ ...cases[0], ...patch })}\n`);
    expect(() => loadCases(path)).toThrow(`${path}:1: malformed case`);
  });
});

describe('qa10k dataset (dev.jsonl, test.jsonl, faqs.json)', () => {
  const QA10K = join(DIR, 'qa10k');
  const library = loadFaqs(join(QA10K, 'faqs.json'));
  const dev = loadCases(join(QA10K, 'dev.jsonl'));
  const test = loadCases(join(QA10K, 'test.jsonl'));
  const all = [...dev, ...test];

  it('has 5,000 dev and 5,000 test cases with unique ids', () => {
    expect([dev.length, test.length]).toEqual([5_000, 5_000]);
    expect(new Set(all.map((c) => c.id)).size).toBe(10_000);
  });

  it('extends the seed library: the 14 seed FAQs first, unchanged', () => {
    expect(library).toHaveLength(35);
    expect(library.slice(0, faqs.length)).toEqual(faqs);
    expect(new Set(library.map((f) => f.id)).size).toBe(library.length);
  });

  it('only labels FAQs in its own library, never repeats the expected id as acceptable, and asks about every FAQ in both splits', () => {
    const ids = new Set(library.map((f) => f.id));
    for (const item of all) {
      if (item.expectedFaqId) expect(ids).toContain(item.expectedFaqId);
      for (const other of item.acceptableFaqIds ?? []) {
        expect(ids).toContain(other);
        expect(other).not.toBe(item.expectedFaqId);
      }
    }
    for (const split of [dev, test]) {
      const asked = new Set(split.map((c) => c.expectedFaqId));
      for (const faq of library) expect(asked).toContain(faq.id);
    }
  });

  it('gives every case a role, keeps each conversation in one split with turns 1..n, and covers every language and case type', () => {
    for (const item of all) expect(item.role?.trim()).toBeTruthy();
    const where = new Map<string, Set<string>>();
    const turns = new Map<string, number[]>();
    for (const [name, split] of [
      ['dev', dev],
      ['test', test],
    ] as const)
      for (const item of split)
        if (item.conversationId) {
          where.set(
            item.conversationId,
            new Set([...(where.get(item.conversationId) ?? []), name]),
          );
          turns.set(item.conversationId, [
            ...(turns.get(item.conversationId) ?? []),
            item.turn as number,
          ]);
        }
    expect(where.size).toBeGreaterThan(300);
    for (const splits of where.values()) expect(splits.size).toBe(1);
    for (const list of turns.values())
      expect([...list].sort((a, b) => a - b)).toEqual(
        list.map((_, i) => i + 1),
      );
    for (const split of [dev, test]) {
      for (const language of EVAL_LANGUAGES)
        expect(
          split.filter((c) => caseLanguage(c) === language).length,
        ).toBeGreaterThanOrEqual(300);
      for (const persona of EVAL_PERSONAS)
        expect(
          split.filter((c) => c.persona === persona).length,
        ).toBeGreaterThanOrEqual(50);
    }
  });

  it("expects the self-service FAQ for action demands on the learner's own account, and unanswerable cases almost always null", () => {
    // 用户 2026-10-29：代办请求（退款、取消、删号、查订单）做不了，就推荐讲自助办法的那条 FAQ
    const unanswerable = all.filter((c) => c.persona === 'unanswerable');
    expect(
      unanswerable.filter((c) => c.expectedFaqId !== null).length /
        unanswerable.length,
    ).toBeLessThan(0.01);
    const expected = (id: string) =>
      all.find((c) => c.id === id)?.expectedFaqId;
    expect(expected('qa-02900')).toBe(FAQ(12));
    expect(expected('qa-05856')).toBe(FAQ(13));
    expect(expected('qa-03029')).toBe(FAQ(13));
    expect(expected('qa-03996')).toBe(FAQ(3));
    // none 只留给没有任何 FAQ 能帮上的情况，「none 或某条 FAQ 都算对」不再存在
    expect(
      all.filter((c) => c.expectedFaqId === null && c.acceptableFaqIds?.length),
    ).toEqual([]);
    expect(expected('qa-01381')).toBe(FAQ(13));
    expect(expected('qa-01379')).toBe(FAQ(3));
    expect(expected('qa-00419')).toBe(FAQ(9));
    // 没有 FAQ 讲得通的代办（批准被拒的退款、多退钱）仍是 none
    for (const id of ['qa-00427', 'qa-03779', 'qa-08407'])
      expect(expected(id)).toBeNull();
  });
});

function result(
  over: Partial<CaseResult> & Pick<CaseResult, 'expectedFaqId' | 'gotFaqId'>,
): CaseResult {
  return {
    id: 'x',
    locale: 'en-GB',
    persona: 'paraphrase',
    role: null,
    conversationId: null,
    turn: null,
    message: 'm',
    acceptableFaqIds: [],
    reason: over.gotFaqId ? 'answered' : 'no_match',
    latencyMs: 100,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    // 缺省：期望的 FAQ 在候选里、问过模型、一次合法调用
    candidateIds: over.expectedFaqId ? [over.expectedFaqId] : [FAQ(9)],
    asked: true,
    validCall: true,
    unpricedCalls: 0,
    alternativeIds: [],
    ...over,
  };
}

describe('report', () => {
  const A = FAQ(1);
  const B = FAQ(2);
  // 10 条：6 条答对（4 条有答案、2 条 none），2 条答错，2 条漏答
  const results: CaseResult[] = [
    result({ id: 'r1', expectedFaqId: A, gotFaqId: A, latencyMs: 10 }),
    result({ id: 'r2', expectedFaqId: A, gotFaqId: A, latencyMs: 20 }),
    result({
      id: 'r3',
      expectedFaqId: B,
      gotFaqId: B,
      latencyMs: 30,
      locale: 'zh-CN',
    }),
    result({
      id: 'r4',
      expectedFaqId: B,
      gotFaqId: B,
      latencyMs: 40,
      locale: 'zh-TW',
      persona: 'terse',
    }),
    result({
      id: 'r5',
      expectedFaqId: null,
      gotFaqId: null,
      latencyMs: 50,
      persona: 'unanswerable',
    }),
    result({
      id: 'r6',
      expectedFaqId: null,
      gotFaqId: null,
      latencyMs: 60,
      persona: 'unanswerable',
    }),
    result({
      id: 'r7',
      expectedFaqId: A,
      gotFaqId: B,
      latencyMs: 70,
      persona: 'typo',
    }),
    result({
      id: 'r8',
      expectedFaqId: null,
      gotFaqId: A,
      latencyMs: 80,
      persona: 'injection',
    }),
    result({
      id: 'r9',
      expectedFaqId: A,
      gotFaqId: null,
      latencyMs: 90,
      reason: 'timeout',
    }),
    result({
      id: 'r10',
      expectedFaqId: B,
      gotFaqId: null,
      latencyMs: 3_500,
      locale: 'zh-CN',
      // 没答上，但「你可能想问」里有它
      alternativeIds: [FAQ(9), B],
    }),
  ].map((r) => ({ ...r, costUsd: 0.001, inputTokens: 100, outputTokens: 5 }));
  const real = { kind: 'real', model: 'openai/gpt-4o-mini' } as const;
  const now = new Date('2026-10-29T10:00:00.000Z');

  it('computes accuracy, wrong-answer rate, none precision / recall, latency percentiles, cost and tokens', () => {
    const report = summarize({
      outcome: { results, spentUsd: 0.01, stopped: null },
      totalCases: 10,
      model: real,
      retrieval: 'memory',
      budgetUsd: 5,
      now,
    });
    expect(report.generatedAt).toBe('2026-10-29T10:00:00.000Z');
    expect(report.metrics).toEqual({
      accuracy: 0.6,
      wrongAnswerRate: 0.2,
      // 预测 none 4 条（r5 r6 r9 r10），其中 2 条该是 none；该是 none 的 3 条（r5 r6 r8）里找回 2 条
      none: { precision: 0.5, recall: 0.6667 },
      latencyMs: { p50: 50, p95: 3_500 },
      costUsd: 0.01,
      tokens: { input: 1_000, output: 50 },
      modelAsked: 10,
      // 7 条该有答案的里期望的 FAQ 都在候选中；模型答对其中 4 条
      retrievalRecall: 1,
      modelRecall: 0.5714,
      // 该有答案却没答的 2 条（r9 r10）里，r10 的 FAQ 在 alternatives 中
      alternativesRecall: 0.5,
      alternativesOffered: 1,
      unansweredAnswerable: 2,
      noneWithoutModel: 0,
      invalidCalls: 0,
      failedRuns: 1,
    });
    expect(report.cases).toEqual({ total: 10, run: 10 });
    expect(report.budget).toEqual({ capUsd: 5, spentUsd: 0.01, stopped: null });
    expect(report.model).toEqual({ ...real, note: null });
  });

  it('reports alternatives recall: answerable cases with no answer whose FAQ (or an acceptable one) was offered (v3 §1)', () => {
    const rs = [
      result({
        id: 'a1',
        expectedFaqId: A,
        gotFaqId: null,
        alternativeIds: [B, A],
      }),
      result({
        id: 'a2',
        expectedFaqId: A,
        acceptableFaqIds: [B],
        gotFaqId: null,
        alternativeIds: [B],
      }),
      result({
        id: 'a3',
        expectedFaqId: A,
        gotFaqId: null,
        alternativeIds: [],
      }),
      result({
        id: 'a4',
        expectedFaqId: B,
        gotFaqId: null,
        alternativeIds: [A],
      }),
      // answered or not answerable: not counted
      result({ id: 'a5', expectedFaqId: A, gotFaqId: A }),
      result({ id: 'a6', expectedFaqId: A, gotFaqId: B }),
      result({
        id: 'a7',
        expectedFaqId: null,
        gotFaqId: null,
        alternativeIds: [A],
      }),
    ];
    const report = summarize({
      outcome: { results: rs, spentUsd: 0, stopped: null },
      totalCases: rs.length,
      model: real,
      retrieval: 'postgresql',
      budgetUsd: 5,
    });
    expect(report.metrics.alternativesRecall).toBe(0.5);
    expect(report.metrics.alternativesOffered).toBe(2);
    expect(report.metrics.unansweredAnswerable).toBe(4);
    expect(markdownReport(report)).toContain(
      '| Alternatives recall (answerable, no answer) | 50.0% (2 of 4) |',
    );
    const none = summarize({
      outcome: { results: rs.slice(4), spentUsd: 0, stopped: null },
      totalCases: 3,
      model: real,
      retrieval: 'postgresql',
      budgetUsd: 5,
    });
    expect(none.metrics.alternativesRecall).toBeNull();
    expect(markdownReport(none)).toContain(
      '| Alternatives recall (answerable, no answer) | n/a (0 of 0) |',
    );
  });

  it('breaks results down by persona and by locale', () => {
    const report = summarize({
      outcome: { results, spentUsd: 0, stopped: null },
      totalCases: 10,
      model: real,
      retrieval: 'memory',
      budgetUsd: 5,
    });
    expect(report.byLocale).toEqual({
      'en-GB': { cases: 7, accuracy: 0.5714, wrongAnswerRate: 0.2857 },
      'zh-CN': { cases: 2, accuracy: 0.5, wrongAnswerRate: 0 },
      'zh-TW': { cases: 1, accuracy: 1, wrongAnswerRate: 0 },
    });
    expect(report.byPersona).toEqual({
      injection: { cases: 1, accuracy: 0, wrongAnswerRate: 1 },
      paraphrase: { cases: 5, accuracy: 0.6, wrongAnswerRate: 0 },
      terse: { cases: 1, accuracy: 1, wrongAnswerRate: 0 },
      typo: { cases: 1, accuracy: 0, wrongAnswerRate: 1 },
      unanswerable: { cases: 2, accuracy: 1, wrongAnswerRate: 0 },
    });
  });

  it('breaks results down by role, by language (mixed-language cases on their own) and by turn', () => {
    const rs = [
      result({
        id: 'p1',
        expectedFaqId: A,
        gotFaqId: A,
        role: 'pays_for_another_account',
      }),
      result({
        id: 'p2',
        expectedFaqId: A,
        gotFaqId: B,
        role: 'pays_for_another_account',
      }),
      result({
        id: 'm1',
        expectedFaqId: A,
        gotFaqId: A,
        locale: 'zh-CN',
        persona: 'mixed_language',
        conversationId: 'c1',
        turn: 1,
      }),
      result({
        id: 'm2',
        expectedFaqId: B,
        gotFaqId: null,
        locale: 'zh-TW',
        conversationId: 'c1',
        turn: 2,
      }),
    ];
    const report = summarize({
      outcome: { results: rs, spentUsd: 0, stopped: null },
      totalCases: rs.length,
      model: real,
      retrieval: 'postgresql',
      budgetUsd: 5,
    });
    expect(report.byRole).toEqual({
      '(none)': { cases: 2, accuracy: 0.5, wrongAnswerRate: 0 },
      pays_for_another_account: {
        cases: 2,
        accuracy: 0.5,
        wrongAnswerRate: 0.5,
      },
    });
    expect(report.byLanguage).toEqual({
      'en-GB': { cases: 2, accuracy: 0.5, wrongAnswerRate: 0.5 },
      mixed: { cases: 1, accuracy: 1, wrongAnswerRate: 0 },
      'zh-TW': { cases: 1, accuracy: 0, wrongAnswerRate: 0 },
    });
    expect(report.byTurn).toEqual({
      first: { cases: 1, accuracy: 1, wrongAnswerRate: 0 },
      follow_up: { cases: 1, accuracy: 0, wrongAnswerRate: 0 },
      single: { cases: 2, accuracy: 0.5, wrongAnswerRate: 0.5 },
    });
    const md = markdownReport(report);
    expect(md).toContain('## By role');
    expect(md).toContain('| pays_for_another_account | 2 | 50.0% | 50.0% |');
    expect(md).toContain('## By language');
    expect(md).toContain('| mixed | 1 | 100.0% | 0.0% |');
    expect(md).toContain('## By turn');
    expect(md).toContain('| follow_up | 1 | 0.0% | 0.0% |');
  });

  it('names the language of a case by its locale, or mixed for a mixed-language case, and the turn kind', () => {
    expect(caseLanguage({ locale: 'zh-TW', persona: 'typo' })).toBe('zh-TW');
    expect(caseLanguage({ locale: 'en-GB', persona: 'mixed_language' })).toBe(
      'mixed',
    );
    expect(turnKind({})).toBe('single');
    expect(turnKind({ conversationId: 'c', turn: 1 })).toBe('first');
    expect(turnKind({ conversationId: 'c', turn: 3 })).toBe('follow_up');
  });

  it('lists every failure as a wrong answer or a miss, without cost columns', () => {
    const report = summarize({
      outcome: { results, spentUsd: 0, stopped: null },
      totalCases: 10,
      model: real,
      retrieval: 'memory',
      budgetUsd: 5,
    });
    expect(
      report.failures.map((f) => [f.id, f.kind, f.stage, f.reason]),
    ).toEqual([
      ['r7', 'wrong_answer', 'model', 'answered'],
      ['r8', 'wrong_answer', 'model', 'answered'],
      ['r9', 'missed', 'error', 'timeout'],
      ['r10', 'missed', 'model', 'no_match'],
    ]);
    expect(report.failures[0]).not.toHaveProperty('costUsd');
  });

  const gate = (
    rs: CaseResult[],
    model: EvalModel = real,
    retrieval: EvalReport['retrieval'] = 'postgresql',
    totalCases = rs.length,
  ) =>
    summarize({
      outcome: { results: rs, spentUsd: 0, stopped: null },
      totalCases,
      model,
      retrieval,
      budgetUsd: 5,
    }).gate;
  // 50 条里 1 条答错（2%）、p95 正好 3 秒
  const fifty = () =>
    Array.from({ length: 50 }, (_, i) =>
      result({
        id: `ok${i}`,
        expectedFaqId: A,
        gotFaqId: i === 0 ? B : A,
        latencyMs: i < 47 ? 1_000 : 3_000,
      }),
    );

  it('gates on wrong-answer rate ≤ 2% and p95 ≤ 3 s', () => {
    expect(gate(results, real, 'memory')).toEqual({
      wrongAnswerRateMax: 0.02,
      p95MaxMs: 3_000,
      failedRateMax: 0.02,
      modelRecallMin: 0.8,
      pass: false,
      reasons: [
        'wrong-answer rate 20.00% > 2%',
        'p95 3500 ms > 3000 ms',
        '1 of 10 cases ended in error, timeout, aborted, rate_limited or no_key (10.00%) > 2%',
        'model recall 57.1% < 80% (answerable cases whose FAQ was retrieved)',
        'in-memory retrieval only approximates production: rerun with --pg',
      ],
    });
    const ok = fifty();
    expect(gate(ok)).toMatchObject({ pass: true, reasons: [] });
    // 再多 1 条答错就不过
    ok[1] = { ...ok[1], gotFaqId: B };
    expect(gate(ok).reasons).toEqual(['wrong-answer rate 4.00% > 2%']);
    // 假模型永远不过
    expect(
      gate(fifty(), { kind: 'fake', model: FAKE_MODEL_ID }).reasons,
    ).toEqual(['fake model: not a real-model result']);
  });

  it('does not pass when every model call fails or the model always says none', () => {
    const dead = fifty().map((r) => ({
      ...r,
      gotFaqId: null,
      reason: 'error',
      validCall: false,
    }));
    expect(gate(dead)).toMatchObject({
      pass: false,
      reasons: [
        '50 of 50 cases ended in error, timeout, aborted, rate_limited or no_key (100.00%) > 2%',
        'model recall 0.0% < 80% (answerable cases whose FAQ was retrieved)',
      ],
    });
    const silent = fifty().map((r) => ({ ...r, gotFaqId: null }));
    expect(gate(silent).reasons).toEqual([
      'model recall 0.0% < 80% (answerable cases whose FAQ was retrieved)',
    ]);
    // 1 of 50 timing out is within 2%
    const one = fifty();
    one[2] = { ...one[2], gotFaqId: null, reason: 'timeout' };
    expect(gate(one).pass).toBe(true);
  });

  it('does not pass a partial run (--limit) or in-memory retrieval', () => {
    expect(gate(fifty(), real, 'postgresql', 120).reasons).toEqual([
      'partial run: 50 of 120 cases (--limit)',
    ]);
    expect(gate(fifty(), real, 'memory').reasons).toEqual([
      'in-memory retrieval only approximates production: rerun with --pg',
    ]);
  });

  it('separates retrieval misses from model misses, and counts none cases the model never saw', () => {
    const rs = [
      // expected FAQ not among the candidates: a retrieval miss
      result({ id: 'a', expectedFaqId: A, gotFaqId: null, candidateIds: [B] }),
      // no candidates at all: model never asked
      result({
        id: 'b',
        expectedFaqId: A,
        gotFaqId: null,
        candidateIds: [],
        asked: false,
        validCall: false,
        reason: 'no_candidates',
      }),
      // reachable but the model said none
      result({ id: 'c', expectedFaqId: A, gotFaqId: null }),
      // none, right without the model
      result({
        id: 'd',
        expectedFaqId: null,
        gotFaqId: null,
        candidateIds: [],
        asked: false,
        validCall: false,
        reason: 'no_candidates',
      }),
      // none, the model said none
      result({ id: 'e', expectedFaqId: null, gotFaqId: null }),
      // invalid tool call (e.g. an injected id)
      result({
        id: 'f',
        expectedFaqId: null,
        gotFaqId: null,
        validCall: false,
      }),
      // an acceptable alternative counts as right
      result({
        id: 'g',
        expectedFaqId: null,
        acceptableFaqIds: [B],
        gotFaqId: B,
        candidateIds: [B],
      }),
      result({ id: 'h', expectedFaqId: A, gotFaqId: null, reason: 'error' }),
    ];
    const report = summarize({
      outcome: { results: rs, spentUsd: 0, stopped: null },
      totalCases: rs.length,
      model: real,
      retrieval: 'postgresql',
      budgetUsd: 5,
    });
    expect(report.metrics).toMatchObject({
      accuracy: 0.5,
      wrongAnswerRate: 0,
      modelAsked: 6,
      // answerable a b c h: 2 of 4 had the FAQ among the candidates (c, h)
      retrievalRecall: 0.5,
      modelRecall: 0,
      noneWithoutModel: 1,
      invalidCalls: 1,
      failedRuns: 1,
    });
    expect(report.failures.map((f) => [f.id, f.kind, f.stage])).toEqual([
      ['a', 'missed', 'retrieval'],
      ['b', 'missed', 'retrieval'],
      ['c', 'missed', 'model'],
      ['h', 'missed', 'error'],
    ]);
    const md = markdownReport(report);
    expect(md).toContain('| Model asked | 6 of 8 |');
    expect(md).toContain('| Retrieval recall@8 | 50.0% |');
    expect(md).toContain('| Model recall (FAQ retrieved) | 0.0% |');
    expect(md).toContain('| none without the model | 1 |');
    expect(md).toContain('| Invalid tool calls | 1 |');
    expect(md).toContain('| Ended in error / timeout | 1 |');
    expect(md).toContain('| a | missed | retrieval |');
  });

  it('a run stopped by the budget does not pass', () => {
    const report = summarize({
      outcome: {
        results: results.slice(0, 4),
        spentUsd: 5.2,
        stopped: 'budget',
      },
      totalCases: 10,
      model: real,
      retrieval: 'memory',
      budgetUsd: 5,
    });
    expect(report.gate.pass).toBe(false);
    expect(report.gate.reasons).toEqual([
      'stopped early (budget) after 4 of 10 cases',
      'in-memory retrieval only approximates production: rerun with --pg',
    ]);
    expect(report.cases).toEqual({ total: 10, run: 4 });
  });

  it('nearest-rank percentiles', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(percentile([4, 1, 3, 2], 0.95)).toBe(4);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 0.5)).toBe(50);
    expect(percentile(hundred, 0.95)).toBe(95);
  });

  it('writes JSON for .json and Markdown for .md', () => {
    const report = summarize({
      outcome: { results, spentUsd: 0.01, stopped: null },
      totalCases: 10,
      model: real,
      retrieval: 'memory',
      budgetUsd: 5,
      now,
    });
    const json = join(tmp, 'nested', 'report.json');
    const md = join(tmp, 'report.md');
    writeReport(json, report);
    writeReport(md, report);
    expect(JSON.parse(readFileSync(json, 'utf8'))).toEqual(report);
    const text = readFileSync(md, 'utf8');
    expect(text).toBe(markdownReport(report));
    expect(text).toContain('## Gate: FAIL');
    expect(text).toContain('| Wrong-answer rate | 20.0% |');
    expect(text).toContain('| none recall | 66.7% |');
    expect(text).toContain('| Latency p50 / p95 | 50 / 3500 ms |');
    expect(text).toContain('| zh-TW | 1 | 100.0% | 0.0% |');
    expect(text).toContain(
      `| r7 | wrong_answer | model | ${A} | ${B} | answered |`,
    );
    expect(text).toContain(`| r10 | missed | model | ${B} | none | no_match |`);
  });
});

describe('retrieval only (--retrieval-only)', () => {
  const A = FAQ(1);
  const B = FAQ(2);
  const C = FAQ(3);
  const base: EvalCase = {
    id: 'q',
    locale: 'en-GB',
    persona: 'paraphrase',
    message: 'm',
    expectedFaqId: A,
  };

  it('asks for candidates exactly as the suggest workflow does (service locale, subject + message, Enquiry Type boost, 8 candidates)', () => {
    expect(retrievalQuery({ ...base, message: '  forgot password ' })).toEqual({
      locale: 'en-GB',
      category: null,
      text: 'forgot password',
      limit: 8,
    });
    expect(
      retrievalQuery({ ...base, locale: 'zh-TW', message: '忘記密碼' }),
    ).toEqual({ locale: 'zh-CN', category: null, text: '忘記密碼', limit: 8 });
    expect(
      retrievalQuery({
        ...base,
        source: 'submit',
        subject: ' Invoice ',
        category: 'payments_subscriptions',
        message: 'where is it',
      }),
    ).toEqual({
      locale: 'en-GB',
      category: 'payments_subscriptions',
      text: 'Invoice\n\nwhere is it',
      limit: 8,
    });
    expect(
      retrievalQuery({
        ...base,
        source: 'submit',
        subject: 'Video',
        category: 'technical_support',
        message: '',
      }),
    ).toMatchObject({ category: 'account_technical', text: 'Video' });
  });

  it('runs only the retrieval: candidates in order and the time per case, no model', async () => {
    const seen: string[] = [];
    const qa = {
      findCandidates: (search: { text: string }) => {
        seen.push(search.text);
        return Promise.resolve(
          [B, A].map((id) => ({
            id,
            category: 'other' as const,
            question: 'q',
            answer: 'a',
            score: 1,
          })),
        );
      },
      findPublished: () => Promise.reject(new Error('not used')),
      findPopular: () => Promise.reject(new Error('not used')),
    };
    const progress: number[] = [];
    const results = await runRetrieval({
      cases: [
        {
          ...base,
          role: 'pays_for_another_account',
          conversationId: 'c',
          turn: 2,
        },
        { ...base, id: 'n', expectedFaqId: null },
      ],
      qa,
      onCase: (_r, i) => progress.push(i),
    });
    expect(seen).toEqual(['m', 'm']);
    expect(progress).toEqual([0, 1]);
    expect(results[0]).toMatchObject({
      id: 'q',
      role: 'pays_for_another_account',
      conversationId: 'c',
      turn: 2,
      expectedFaqId: A,
      acceptableFaqIds: [],
      candidateIds: [B, A],
    });
    expect(results[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  function hit(
    over: Partial<RetrievalResult> & Pick<RetrievalResult, 'candidateIds'>,
  ): RetrievalResult {
    return {
      id: 'x',
      locale: 'en-GB',
      persona: 'paraphrase',
      role: null,
      conversationId: null,
      turn: null,
      message: 'm',
      expectedFaqId: A,
      acceptableFaqIds: [],
      latencyMs: 10,
      ...over,
    };
  }
  // 5 answerable: rank 1, rank 2, rank 5 (via an acceptable id), rank 8, missing; 2 none (one with no candidates)
  const rs: RetrievalResult[] = [
    hit({ id: 'r1', candidateIds: [A, B], latencyMs: 5 }),
    hit({ id: 'r2', candidateIds: [B, A], locale: 'zh-TW', latencyMs: 20 }),
    hit({
      id: 'r3',
      candidateIds: [B, B, B, B, C, A],
      acceptableFaqIds: [C],
      persona: 'mixed_language',
      locale: 'zh-CN',
      role: 'pays_for_another_account',
    }),
    hit({
      id: 'r4',
      candidateIds: [B, B, B, B, B, B, B, A],
      conversationId: 'c',
      turn: 2,
    }),
    hit({ id: 'r5', candidateIds: [B, C], locale: 'zh-TW', message: 'lost' }),
    hit({
      id: 'r6',
      candidateIds: [],
      expectedFaqId: null,
      persona: 'unanswerable',
    }),
    hit({
      id: 'r7',
      candidateIds: [B],
      expectedFaqId: null,
      acceptableFaqIds: [B],
      latencyMs: 300,
    }),
  ];
  const now = new Date('2026-10-29T10:00:00.000Z');
  const report = summarizeRetrieval({
    results: rs,
    totalCases: 7,
    retrieval: 'postgresql',
    faqs: 35,
    now,
  });

  it('reports recall@1 / @3 / @8 over answerable cases (an acceptable id counts), latency and empty retrievals for none cases', () => {
    expect(report).toMatchObject({
      kind: 'retrieval-only',
      generatedAt: '2026-10-29T10:00:00.000Z',
      retrieval: 'postgresql',
      faqs: 35,
      cases: { total: 7, run: 7 },
    });
    expect(report.note).toMatch(/no model/i);
    expect(report.overall).toEqual({
      cases: 7,
      answerable: 5,
      recallAt1: 0.2,
      recallAt3: 0.4,
      recallAt8: 0.8,
      meanRank: 4,
      noneEmpty: 0.5,
    });
    expect(report.latencyMs).toEqual({ p50: 10, p95: 300, max: 300 });
  });

  it('slices recall by locale, language, case type, role and turn', () => {
    expect(report.byLocale['zh-TW']).toMatchObject({
      answerable: 2,
      recallAt1: 0,
      recallAt3: 0.5,
      recallAt8: 0.5,
    });
    expect(Object.keys(report.byLanguage)).toEqual(['en-GB', 'mixed', 'zh-TW']);
    expect(report.byLanguage.mixed).toMatchObject({
      recallAt3: 0,
      recallAt8: 1,
    });
    expect(report.byPersona.unanswerable).toMatchObject({
      cases: 1,
      answerable: 0,
      recallAt8: null,
      noneEmpty: 1,
    });
    expect(report.byRole.pays_for_another_account).toMatchObject({
      answerable: 1,
      recallAt8: 1,
    });
    expect(report.byTurn.follow_up).toMatchObject({
      recallAt3: 0,
      recallAt8: 1,
    });
    expect(report.misses).toEqual([
      {
        id: 'r5',
        locale: 'zh-TW',
        persona: 'paraphrase',
        role: null,
        message: 'lost',
        expectedFaqId: A,
        acceptableFaqIds: [],
        candidateIds: [B, C],
      },
    ]);
  });

  it('writes the retrieval report as JSON or Markdown, saying no model ran', () => {
    const md = markdownRetrievalReport(report);
    expect(md).toContain(
      '# Helpdesk retrieval eval (retrieval only, no model)',
    );
    expect(md).toContain('- Retrieval: postgresql');
    expect(md).toContain('| Recall@1 / @3 / @8 | 20.0% / 40.0% / 80.0% |');
    expect(md).toContain(
      '| Retrieval latency p50 / p95 / max | 10 / 300 / 300 ms |',
    );
    expect(md).toContain('## By language');
    expect(md).toContain(
      '| zh-TW | 2 | 2 | 0.0% | 50.0% | 50.0% | 2.0 | n/a |',
    );
    expect(md).toContain(
      '| r5 | zh-TW | paraphrase | 001 | — | 002, 003 | lost |',
    );
    const json = join(tmp, 'retrieval.json');
    writeReport(json, report);
    expect(JSON.parse(readFileSync(json, 'utf8'))).toEqual(report);
    writeReport(join(tmp, 'retrieval.md'), report);
    expect(readFileSync(join(tmp, 'retrieval.md'), 'utf8')).toBe(md);
  });

  it('runs the qa10k dev set through the in-memory retrieval', async () => {
    const library = loadFaqs(join(DIR, 'qa10k', 'faqs.json'));
    const dev = loadCases(join(DIR, 'qa10k', 'dev.jsonl')).slice(0, 300);
    const results = await runRetrieval({
      cases: dev,
      qa: memoryQaSource(library),
    });
    const r: RetrievalReport = summarizeRetrieval({
      results,
      totalCases: dev.length,
      retrieval: 'memory',
      faqs: library.length,
    });
    expect(r.cases).toEqual({ total: 300, run: 300 });
    expect(r.overall.recallAt8).toBeGreaterThan(0.5);
    expect(r.note).toMatch(/approximat/);
  });
});

describe('model and budget settings', () => {
  it('uses the real model only with an OpenRouter key', () => {
    expect(chooseModel({})).toEqual({ kind: 'fake', model: FAKE_MODEL_ID });
    expect(chooseModel({ OPENROUTER_API_KEY: '  ' })).toEqual({
      kind: 'fake',
      model: FAKE_MODEL_ID,
    });
    // 和生产一样（分级方案，owner 2026-11-03）：小模型，聊天缺省不思考，提交工单那条路也不思考
    expect(chooseModel({ OPENROUTER_API_KEY: 'k' })).toEqual({
      kind: 'real',
      model: 'google/gemma-4-31b-it',
      thinking: 'off',
    });
    expect(chooseModel({ OPENROUTER_API_KEY: 'k' }, 'ticket')).toEqual({
      kind: 'real',
      model: 'google/gemma-4-31b-it',
    });
    expect(
      thinkingLabel(chooseModel({ OPENROUTER_API_KEY: 'k' }, 'ticket')),
    ).toBe(', thinking off');
    expect(
      chooseModel(
        {
          OPENROUTER_API_KEY: 'k',
          HELPDESK_SUGGEST_MODEL: 'anthropic/claude-haiku',
          HELPDESK_SUGGEST_THINKING: 'off',
        },
        'chat',
      ),
    ).toEqual({
      kind: 'real',
      model: 'anthropic/claude-haiku',
      thinking: 'off',
    });
    // 没配 HELPDESK_SUGGEST_MODEL 时和生产选同一个模型（代码里定的那个）
    expect(
      chooseModel(
        {
          OPENROUTER_API_KEY: 'k',
          AI_AVAILABLE_MODELS: 'deepseek/deepseek-r1,google/gemini-3.5-flash',
        },
        'ticket',
      ),
    ).toEqual({ kind: 'real', model: 'google/gemma-4-31b-it' });
  });

  it('takes a longer deadline from HELPDESK_EVAL_DEADLINE_MS for real models only, and names it in the label', () => {
    // 思考档位要看不截时限时的质量与延迟；不给就是线上的 3.5 秒
    expect(evalDeadline({})).toBeUndefined();
    expect(evalDeadline({ HELPDESK_EVAL_DEADLINE_MS: ' 30000 ' })).toBe(30_000);
    for (const bad of ['0', '-5', '1.5', 'abc', '600001'])
      expect(() => evalDeadline({ HELPDESK_EVAL_DEADLINE_MS: bad })).toThrow(
        'HELPDESK_EVAL_DEADLINE_MS must be a whole number from 1 to 600000',
      );
    const model = chooseModel({
      OPENROUTER_API_KEY: 'k',
      HELPDESK_SUGGEST_THINKING: 'low',
      HELPDESK_EVAL_DEADLINE_MS: '30000',
    });
    expect(model).toEqual({
      kind: 'real',
      model: 'google/gemma-4-31b-it',
      thinking: 'low',
      deadlineMs: 30_000,
    });
    expect(thinkingLabel(model)).toBe(', thinking low, deadline 30000 ms');
    expect(chooseModel({ HELPDESK_EVAL_DEADLINE_MS: '30000' })).toEqual({
      kind: 'fake',
      model: FAKE_MODEL_ID,
    });
  });

  it('takes the thinking cut-off from HELPDESK_EVAL_CUTOFF_MS (0 = thinking only, no backup) and names it in the label', () => {
    // 线上思考截在 6.3 秒、同时发不思考的后备；评测要比截断前后
    expect(evalCutoff({})).toBeUndefined();
    expect(evalCutoff({ HELPDESK_EVAL_CUTOFF_MS: ' 0 ' })).toBe(0);
    expect(evalCutoff({ HELPDESK_EVAL_CUTOFF_MS: '6300' })).toBe(6_300);
    for (const bad of ['-5', '1.5', 'abc', '600001'])
      expect(() => evalCutoff({ HELPDESK_EVAL_CUTOFF_MS: bad })).toThrow(
        'HELPDESK_EVAL_CUTOFF_MS must be a whole number from 0 to 600000',
      );
    const env = {
      OPENROUTER_API_KEY: 'k',
      HELPDESK_SUGGEST_THINKING: 'high',
      HELPDESK_EVAL_DEADLINE_MS: '60000',
      HELPDESK_EVAL_CUTOFF_MS: '0',
    };
    expect(deadlineDeps(env)).toEqual({
      deadlineMs: 60_000,
      timeoutMs: 60_000,
      cutoffMs: 0,
    });
    expect(deadlineDeps({})).toEqual({});
    const model = chooseModel(env);
    expect(model).toMatchObject({ deadlineMs: 60_000, cutoffMs: 0 });
    expect(thinkingLabel(model)).toBe(
      ', thinking high, deadline 60000 ms, no backup',
    );
    expect(
      thinkingLabel(chooseModel({ ...env, HELPDESK_EVAL_CUTOFF_MS: '9000' })),
    ).toBe(', thinking high, deadline 60000 ms, cut-off 9000 ms');
    expect(chooseModel(env, 'ticket')).not.toHaveProperty('cutoffMs');
  });

  it('caps spend at HELPDESK_EVAL_BUDGET_USD, 5 USD by default', () => {
    expect(DEFAULT_BUDGET_USD).toBe(5);
    expect(budgetFrom({})).toBe(5);
    expect(budgetFrom({ HELPDESK_EVAL_BUDGET_USD: '0.5' })).toBe(0.5);
    for (const bad of ['0', '-1', 'abc', 'Infinity'])
      expect(() => budgetFrom({ HELPDESK_EVAL_BUDGET_USD: bad })).toThrow(
        'HELPDESK_EVAL_BUDGET_USD must be a decimal number from 0 (exclusive) to 10000',
      );
  });
});

/** 每一步发一次请求、花 costUsd（null = 没有价格）、用 tokens，选第一个候选。 */
function payingRunner(costUsd: number | null, tokens = 100): AgentStepRunner {
  return {
    run: (spec, context) => {
      const at = { turn: context.trace.turn, step: context.step };
      context.trace.emit('request/context', { ...at, provider: 'stub' });
      context.trace.emit('assistant/message', {
        ...at,
        model: 'stub',
        usage: { inputTokens: tokens, outputTokens: 1 },
        costUsd,
      });
      context.trace.emit('tool/call', { ...at, callId: 'c', name: 'pick_faq' });
      context.trace.emit('tool/result', {
        ...at,
        callId: 'c',
        name: 'pick_faq',
      });
      const [first] = spec.tool.enumArgs.faqId;
      return Promise.resolve({
        kind: 'called',
        args: { intent: 'question', faqId: first },
      });
    },
  };
}

/** 请求发出去了（OpenRouter 照样计费），但到期被 abort，没有 usage。 */
const abortedRunner: AgentStepRunner = {
  run: (_spec, context) => {
    context.trace.emit('request/context', {
      turn: context.trace.turn,
      step: context.step,
      provider: 'stub',
    });
    return Promise.resolve({ kind: 'aborted' });
  },
};

const ENV = { OPENROUTER_API_KEY: 'stub', HELPDESK_SUGGEST_MODEL: 'stub' };

describe('memory retrieval: popular FAQs (v3 §1 alternatives)', () => {
  it('offers popular FAQs only, the category first, in the locale, without the excluded ones', async () => {
    const qa = memoryQaSource(faqs);
    const zh = await qa.findPopular({
      locale: 'zh-CN',
      category: 'courses_learning',
      excludeIds: [FAQ(5)],
      limit: 3,
    });
    expect(zh.map((c) => [c.id, c.question, c.score])).toEqual([
      [FAQ(6), '如何加入直播课？', 0],
      [FAQ(1), '如何重置密码？', 0],
      [FAQ(9), '如何更改我的订阅？', 0],
    ]);
    expect(
      (
        await qa.findPopular({
          locale: 'en-GB',
          category: null,
          excludeIds: [],
          limit: 2,
        })
      ).map((c) => c.question),
    ).toEqual([
      'How do I reset my password?',
      'How can I access my course materials?',
    ]);
  });
});

describe('running the cases', () => {
  const answerable = cases.filter((c) => c.persona === 'paraphrase');

  it('stops once the spend reaches the budget (checked before each case: one case may overshoot)', async () => {
    const outcome = await runCases({
      cases: answerable.slice(0, 10),
      qa: memoryQaSource(faqs),
      runner: payingRunner(0.4),
      env: ENV,
      budgetUsd: 1,
    });
    // 0.4 + 0.4 + 0.4 = 1.2 ≥ 1：第 4 条不再跑
    expect(outcome.results).toHaveLength(3);
    expect(outcome.stopped).toBe('budget');
    expect(outcome.spentUsd).toBeCloseTo(1.2, 10);
    expect(outcome.results.map((r) => r.costUsd)).toEqual([0.4, 0.4, 0.4]);
    expect(outcome.results[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 1,
      reason: 'answered',
      asked: true,
      validCall: true,
      unpricedCalls: 0,
    });
  });

  it('stops when a model reports tokens but no price, because the cap cannot be kept', async () => {
    const outcome = await runCases({
      cases: answerable.slice(0, 5),
      qa: memoryQaSource(faqs),
      runner: payingRunner(null),
      env: ENV,
      budgetUsd: 5,
    });
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].unpricedCalls).toBe(1);
    expect(outcome.stopped).toBe('unknown_cost');
  });

  it('runs a free (zero-priced) model through', async () => {
    const outcome = await runCases({
      cases: answerable.slice(0, 5),
      qa: memoryQaSource(faqs),
      runner: payingRunner(0),
      env: ENV,
      budgetUsd: 5,
      callCeilingUsd: 0,
    });
    expect(outcome.stopped).toBeNull();
    expect(outcome.results).toHaveLength(5);
  });

  it('charges a request that was aborted before its usage arrived at the per-call ceiling', async () => {
    const outcome = await runCases({
      cases: answerable.slice(0, 10),
      qa: memoryQaSource(faqs),
      runner: abortedRunner,
      env: ENV,
      budgetUsd: 1,
      callCeilingUsd: 0.4,
    });
    expect(outcome.stopped).toBe('budget');
    expect(outcome.results).toHaveLength(3);
    expect(outcome.spentUsd).toBeCloseTo(1.2, 10);
    expect(outcome.results[0]).toMatchObject({
      reason: 'timeout',
      asked: true,
      validCall: false,
      unpricedCalls: 1,
      costUsd: 0,
    });
  });

  it('stops on an aborted request when the price per call is unknown', async () => {
    const outcome = await runCases({
      cases: answerable.slice(0, 5),
      qa: memoryQaSource(faqs),
      runner: abortedRunner,
      env: ENV,
      budgetUsd: 5,
    });
    expect(outcome.results).toHaveLength(1);
    expect(outcome.stopped).toBe('unknown_cost');
  });

  it('prices one call from the catalog: the longest prompt plus the step output limit (150 tokens), unknown off-catalog', async () => {
    // gpt-4o-mini: $0.15 / $0.60 per million tokens
    expect(PICK_FAQ_MAX_TOKENS).toBe(150);
    expect(await callCeilingUsd('openai/gpt-4o-mini')).toBeCloseTo(
      (CALL_PROMPT_TOKENS_MAX * 0.15 + 150 * 0.6) / 1e6,
      12,
    );
    expect(await callCeilingUsd('acme/brand-new-model')).toBeNull();
  });

  it('runs through when every case is within budget', async () => {
    const seen: number[] = [];
    const outcome = await runCases({
      cases: answerable.slice(0, 4),
      qa: memoryQaSource(faqs),
      runner: payingRunner(0.001),
      env: ENV,
      budgetUsd: 5,
      onCase: (_result, index) => seen.push(index),
    });
    expect(outcome.stopped).toBeNull();
    expect(outcome.results).toHaveLength(4);
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it('runs cases concurrently with --concurrency, keeping results in case order', async () => {
    let inFlight = 0;
    let peak = 0;
    const base = payingRunner(0.001);
    const slow: AgentStepRunner = {
      run: async (spec, context) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((done) => setTimeout(done, 5));
        inFlight -= 1;
        return base.run(spec, context);
      },
    };
    const seen: number[] = [];
    const picked = answerable.slice(0, 7);
    const outcome = await runCases({
      cases: picked,
      qa: memoryQaSource(faqs),
      runner: slow,
      env: ENV,
      budgetUsd: 5,
      concurrency: 3,
      onCase: (_result, index) => seen.push(index),
    });
    expect(peak).toBe(3);
    expect(outcome.stopped).toBeNull();
    expect(outcome.results.map((r) => r.id)).toEqual(picked.map((c) => c.id));
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('with concurrency, stops at the budget (each worker checks before its next case)', async () => {
    const outcome = await runCases({
      cases: answerable.slice(0, 10),
      qa: memoryQaSource(faqs),
      runner: payingRunner(0.4),
      env: ENV,
      budgetUsd: 1,
      concurrency: 2,
    });
    expect(outcome.stopped).toBe('budget');
    // 并发 2：最多比串行多跑 1 条
    expect(outcome.results.length).toBeGreaterThanOrEqual(3);
    expect(outcome.results.length).toBeLessThanOrEqual(4);
    expect(outcome.results.map((r) => r.id)).toEqual(
      answerable.slice(0, outcome.results.length).map((c) => c.id),
    );
  });

  it('without a key the service answers nothing, like production', async () => {
    const outcome = await runCases({
      cases: answerable.slice(0, 2),
      qa: memoryQaSource(faqs),
      runner: payingRunner(0.001),
      env: {},
      budgetUsd: 5,
    });
    expect(outcome.results.map((r) => [r.gotFaqId, r.reason])).toEqual([
      [null, 'no_key'],
      [null, 'no_key'],
    ]);
  });

  it('runs the whole set through the pi workflow with the fake model and writes both reports', async () => {
    const model = chooseModel({});
    const { runner, env } = await runnerFor(model);
    const outcome = await runCases({
      cases,
      qa: memoryQaSource(faqs),
      runner,
      env: env({}),
      budgetUsd: DEFAULT_BUDGET_USD,
      // pi 的 faux provider 估 token、价格为 0：不花钱，不按缺价停
      paid: false,
    });
    expect(outcome.stopped).toBeNull();
    expect(outcome.results).toHaveLength(cases.length);
    // 假模型永远选检索排第一的候选；没有候选时不问模型
    for (const r of outcome.results) {
      if (r.candidateIds.length > 0) {
        expect([r.id, r.gotFaqId, r.reason, r.asked]).toEqual([
          r.id,
          r.candidateIds[0],
          'answered',
          true,
        ]);
        expect(r.alternativeIds).toEqual([]);
      } else {
        expect([r.id, r.gotFaqId, r.reason, r.asked]).toEqual([
          r.id,
          null,
          'no_candidates',
          false,
        ]);
        // nothing retrieved: the popular FAQs of the seed library, code only
        expect(r.alternativeIds.length).toBeGreaterThan(0);
        expect(r.alternativeIds.length).toBeLessThanOrEqual(3);
        for (const id of r.alternativeIds)
          expect(faqs.find((f) => f.id === id)?.popular).toBe(true);
      }
      expect(r.costUsd).toBe(0);
    }
    // submit 用例带主题与工单类型走 submit 路径
    const submit = outcome.results.filter((r) => r.id.startsWith('sub-'));
    expect(submit.length).toBeGreaterThanOrEqual(4);
    expect(submit.some((r) => r.gotFaqId !== null)).toBe(true);

    const report = summarize({
      outcome,
      totalCases: cases.length,
      model,
      retrieval: 'memory',
      budgetUsd: DEFAULT_BUDGET_USD,
    });
    expect(report.model.kind).toBe('fake');
    expect(report.model.note).toMatch(/not a model/);
    expect(report.gate.pass).toBe(false);
    expect(report.gate.reasons).toContain(
      'fake model: not a real-model result',
    );
    expect(Object.keys(report.byPersona).sort()).toEqual(
      [...EVAL_PERSONAS].sort(),
    );
    expect(Object.keys(report.byLocale)).toEqual([...EVAL_LOCALES]);
    expect(report.metrics.latencyMs.p95).toBeLessThan(3_000);

    writeReport(join(tmp, 'fake.json'), report);
    writeReport(join(tmp, 'fake.md'), report);
    expect(
      (JSON.parse(readFileSync(join(tmp, 'fake.json'), 'utf8')) as EvalReport)
        .cases,
    ).toEqual({ total: cases.length, run: cases.length });
    expect(readFileSync(join(tmp, 'fake.md'), 'utf8')).toContain(
      'fake `fake/top-candidate`',
    );
  }, 60_000);
});

describe('npm run eval:helpdesk (cli)', () => {
  const two = cases.filter((c) => ['en-01', 'en-07'].includes(c.id));
  function files(lines = two) {
    const dir = mkdtempSync(join(tmp, 'cli-'));
    const path = join(dir, 'cases.jsonl');
    writeFileSync(path, lines.map((c) => JSON.stringify(c)).join('\n'));
    return { dir, path };
  }
  function io() {
    const lines: string[] = [];
    return { lines, log: (line: string) => lines.push(line) };
  }
  const read = (path: string) =>
    JSON.parse(readFileSync(path, 'utf8')) as EvalReport;

  it('without a key runs the fake model, writes the default report next to the cwd and exits 0', async () => {
    const { dir, path } = files();
    const out = io();
    const code = await runCli(['--cases', path], {
      env: {},
      cwd: dir,
      log: out.log,
    });
    expect(code).toBe(0);
    const report = read(join(dir, 'helpdesk-eval-report.json'));
    expect(report.model.kind).toBe('fake');
    expect(report.cases).toEqual({ total: 2, run: 2 });
    expect(out.lines.at(-1)).toBe(
      `report: ${join(dir, 'helpdesk-eval-report.json')}`,
    );
  }, 30_000);

  it.each([
    [['--limit', '0'], '--limit must be a positive integer'],
    [['--limit', 'abc'], '--limit must be a positive integer'],
    [['--concurrency', '0'], '--concurrency must be an integer from 1 to 16'],
    [['--concurrency', '17'], '--concurrency must be an integer from 1 to 16'],
  ])('exits 2 on %j', async (argv, message) => {
    const { dir, path } = files();
    const out = io();
    expect(
      await runCli(['--cases', path, ...argv], {
        env: {},
        cwd: dir,
        log: out.log,
      }),
    ).toBe(2);
    expect(out.lines.at(-1)).toBe(message);
  });

  it('exits 2 with a clear message for an empty cases file', async () => {
    const { dir } = files();
    writeFileSync(join(dir, 'empty.jsonl'), '');
    const out = io();
    expect(
      await runCli(['--cases', join(dir, 'empty.jsonl')], {
        env: {},
        cwd: dir,
        log: out.log,
      }),
    ).toBe(2);
    expect(out.lines.at(-1)).toMatch(/no cases$/);
  });

  function realDeps(
    runner: AgentStepRunner,
    ceiling: number | null = 0.001,
    close = jest.fn(),
  ) {
    const runnerFor = jest.fn((model: { model: string }) =>
      Promise.resolve({
        runner,
        env: (base: NodeJS.ProcessEnv) => ({
          ...base,
          HELPDESK_SUGGEST_MODEL: model.model,
        }),
      }),
    );
    const pgQaSource = jest.fn(() =>
      Promise.resolve({ qa: memoryQaSource(faqs), close }),
    );
    return {
      runnerFor,
      pgQaSource,
      close,
      callCeilingUsd: () => Promise.resolve(ceiling),
    };
  }
  const KEY = {
    OPENROUTER_API_KEY: 'test-key-local-only',
    HELPDESK_SUGGEST_MODEL: 'acme/model',
  };

  it('with a key runs the real model it would use in production, as a paid run, and exits 0 when the gate passes', async () => {
    const { dir, path } = files();
    const deps = realDeps(payingRunner(0.001));
    const code = await runCli(
      ['--cases', path, '--pg', 'postgres://eval', '--out', 'r/out.json'],
      { env: KEY, cwd: dir, log: io().log, ...deps },
    );
    const report = read(join(dir, 'r', 'out.json'));
    expect(report.gate.reasons).toEqual([]);
    expect(code).toBe(0);
    expect(deps.runnerFor).toHaveBeenCalledWith({
      kind: 'real',
      model: 'acme/model',
    });
    expect(deps.pgQaSource).toHaveBeenCalledWith(
      'postgres://eval',
      expect.any(Array),
      expect.any(String),
    );
    expect(deps.close).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      model: { kind: 'real', model: 'acme/model' },
      retrieval: 'postgresql',
    });
  });

  it('exits 1 when the real-model gate fails, and a paid run stops on a missing price', async () => {
    const { dir, path } = files();
    // a model missing from the price catalog: no cost per reply, no ceiling
    const deps = realDeps(payingRunner(null), null);
    const code = await runCli(['--cases', path, '--pg', 'postgres://eval'], {
      env: KEY,
      cwd: dir,
      log: io().log,
      ...deps,
    });
    expect(code).toBe(1);
    const report = read(join(dir, 'helpdesk-eval-report.json'));
    expect(report.budget.stopped).toBe('unknown_cost');
    expect(report.gate.pass).toBe(false);
  });

  it('exits 1 for a real-model run on in-memory retrieval or a --limit subset', async () => {
    const { dir, path } = files();
    for (const argv of [[], ['--pg', 'postgres://eval', '--limit', '1']]) {
      const deps = realDeps(payingRunner(0.001));
      expect(
        await runCli(['--cases', path, ...argv], {
          env: KEY,
          cwd: dir,
          log: io().log,
          ...deps,
        }),
      ).toBe(1);
    }
  });

  it('--retrieval-only runs only the retrieval (never a model, even with a key), on --pg, and exits 0', async () => {
    const { dir, path } = files();
    const deps = realDeps(payingRunner(0.001));
    const out = io();
    const code = await runCli(
      [
        '--cases',
        path,
        '--pg',
        'postgres://eval',
        '--retrieval-only',
        '--out',
        'r.json',
      ],
      { env: KEY, cwd: dir, log: out.log, ...deps },
    );
    expect(code).toBe(0);
    expect(deps.runnerFor).not.toHaveBeenCalled();
    expect(deps.pgQaSource).toHaveBeenCalledTimes(1);
    expect(deps.close).toHaveBeenCalledTimes(1);
    const report = JSON.parse(
      readFileSync(join(dir, 'r.json'), 'utf8'),
    ) as RetrievalReport;
    expect(report).toMatchObject({
      kind: 'retrieval-only',
      retrieval: 'postgresql',
      cases: { total: 2, run: 2 },
    });
    expect(out.lines.some((l) => l.startsWith('recall@1/@3/@8 '))).toBe(true);
  });

  it('--retrieval-only takes the qa10k files through --cases and --faqs, with --limit', async () => {
    const out = io();
    const dir = mkdtempSync(join(tmp, 'cli-'));
    const code = await runCli(
      [
        '--cases',
        join(DIR, 'qa10k', 'dev.jsonl'),
        '--faqs',
        join(DIR, 'qa10k', 'faqs.json'),
        '--retrieval-only',
        '--limit',
        '40',
        '--out',
        'r.md',
      ],
      { env: {}, cwd: dir, log: out.log },
    );
    expect(code).toBe(0);
    const md = readFileSync(join(dir, 'r.md'), 'utf8');
    expect(md).toContain('- Cases: 40 of 5000');
    expect(md).toContain('- FAQs: 35');
    expect(md).toContain('- Retrieval: memory');
  });

  it('closes the PostgreSQL schema and exits 2 when the run throws', async () => {
    const { dir, path } = files();
    const deps = realDeps({
      run: () => Promise.reject(new Error('boom')),
    });
    const broken = jest.fn(() => {
      throw new Error('disk full');
    });
    const out = io();
    const code = await runCli(['--cases', path, '--pg', 'postgres://eval'], {
      env: KEY,
      cwd: dir,
      log: out.log,
      ...deps,
      writeReport: broken,
    });
    expect(code).toBe(2);
    expect(out.lines.at(-1)).toBe('disk full');
    expect(deps.close).toHaveBeenCalledTimes(1);
  });
});

const PG_URL = process.env.HELPDESK_TEST_DATABASE_URL;
const pgIt = PG_URL ? it : it.skip;

describe('PostgreSQL retrieval (HELPDESK_TEST_DATABASE_URL)', () => {
  pgIt(
    'runs the production candidate SQL in a scratch schema and drops it afterwards',
    async () => {
      const url = PG_URL as string;
      const { qa, close } = await pgQaSource(url, faqs, helpdeskMigrationSql());
      let schemas: string[] = [];
      try {
        const password = await qa.findCandidates({
          text: 'forgot password reset email',
          locale: 'en-GB',
          category: null,
          limit: 5,
        });
        expect(password[0]?.id).toBe(FAQ(1));
        const zh = await qa.findPublished(FAQ(1), 'zh-CN');
        expect(zh?.answer).toBe(faqs[0].answerZh);
        // the memory source offers the same popular FAQs as the production SQL (same order needs updated_at, so as a set)
        const search = {
          locale: 'zh-CN',
          category: 'payments_subscriptions' as const,
          excludeIds: [],
          limit: 3,
        };
        const popular = await qa.findPopular(search);
        expect(popular).toHaveLength(3);
        expect(popular[0].category).toBe('payments_subscriptions');
        for (const c of popular)
          expect(faqs.find((f) => f.id === c.id)?.popular).toBe(true);
      } finally {
        await close();
        const pool = new Pool({ connectionString: url });
        // only this process's scratch schemas: '_' is a LIKE wildcard, so 'hdeval_%' also matched the
        // hdevalgate_* schema of the release gate suite running in another worker (flaky in the full run)
        schemas = (
          await pool.query<{ nspname: string }>(
            'SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1)',
            [`hdeval_${process.pid}_`],
          )
        ).rows.map((row) => row.nspname);
        await pool.end();
      }
      expect(schemas).toEqual([]);
    },
    60_000,
  );

  pgIt(
    'runs the qa10k library through the production retrieval in --retrieval-only mode',
    async () => {
      const library = loadFaqs(join(DIR, 'qa10k', 'faqs.json'));
      // 每 10 条取 1 条：各语言 / 类型都有（文件按语言与类型分块写入）
      const some = loadCases(join(DIR, 'qa10k', 'dev.jsonl')).filter(
        (_, i) => i % 10 === 0,
      );
      const { qa, close } = await pgQaSource(
        PG_URL as string,
        library,
        helpdeskMigrationSql(),
      );
      try {
        const results = await runRetrieval({ cases: some, qa });
        const report = summarizeRetrieval({
          results,
          totalCases: some.length,
          retrieval: 'postgresql',
          faqs: library.length,
        });
        expect(report.cases.run).toBe(500);
        // 检索改进（繁体 / 粤语归一、跨语言、IDF、拼写容错）的下限；改进前约 0.91 / 0.72 / 0.80
        expect(report.overall.recallAt8).toBeGreaterThan(0.93);
        expect(report.byLanguage['zh-TW'].recallAt8).toBeGreaterThan(0.88);
        expect(report.byPersona.typo.recallAt8).toBeGreaterThan(0.85);
        expect(report.latencyMs.p95).toBeLessThan(300);
      } finally {
        await close();
      }
    },
    60_000,
  );
});
