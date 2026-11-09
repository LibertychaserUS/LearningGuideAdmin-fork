import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';

import type {
  AgentStepContext,
  AgentStepOutcome,
  AgentStepRunner,
  AgentStepSpec,
} from '../../src/ai/helpdesk/workflow/engine';
import { TEMPLATES } from '../../src/ai/helpdesk/workflow/guard';
import { runCli } from './cli';
import {
  CONVERSATION_GATE,
  isHandoverRequest,
  loadConversations,
  markdownConversationReport,
  runConversations,
  summarizeConversations,
  score,
  stepDetails,
  type ConversationOutcome,
  type EvalConversation,
  type GotTurn,
  type TurnExpectation,
  type TurnResult,
} from './conversations';
import {
  acceptedRank,
  helpdeskMigrationSql,
  loadCases,
  loadFaqs,
  memoryQaSource,
  pgQaSource,
  runnerFor,
  runRetrieval,
  summarizeRetrieval,
  type EvalCase,
} from './harness';

/**
 * v5 对话评测（Part F）在 CI 里跑：文件格式与加载、按 Portal 的方式逐轮带 context、打分与闸门、
 * 整个样例集用假模型（pi faux provider）真跑一遍；另有免费的只检索闸门（Part G5「CI: retrieval-only eval
 * on the seed FAQs and cases, gate recall@8 ≥ 95%」）。从不连真模型。
 */
const DIR = __dirname;
const SAMPLE = join(DIR, 'v5-conversations.sample.jsonl');
const faqs = loadFaqs(join(DIR, 'faqs.json'));
const FAQ = (n: number) =>
  `0192f0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hd-v5-eval-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('v5 conversation files', () => {
  it('loads the committed sample: every expected FAQ is in the seed library, and every kind is covered', () => {
    const conversations = loadConversations(SAMPLE);
    expect(conversations.length).toBeGreaterThanOrEqual(8);
    const ids = new Set(faqs.map((f) => f.id));
    const kinds = new Set<string>();
    for (const c of conversations)
      for (const t of c.turns) {
        if ('click' in t) {
          expect(ids).toContain(t.click);
          continue;
        }
        if (!t.expect) continue;
        kinds.add(t.expect.kind);
        if ('faqId' in t.expect) expect(ids).toContain(t.expect.faqId);
      }
    expect(kinds).toEqual(
      new Set(['answer', 'clarify', 'smalltalk', 'no_match', 'handover']),
    );
    expect(new Set(conversations.map((c) => c.locale))).toEqual(
      new Set(['en-GB', 'zh-CN', 'zh-TW']),
    );
    expect(conversations.some((c) => c.language === 'mixed')).toBe(true);
    expect(new Set(conversations.map((c) => c.set))).toEqual(
      new Set(['multi_turn', 'casual']),
    );
  });

  it('reads every .jsonl in a directory (the eval-v5 folder) and refuses duplicate ids', () => {
    const dir = join(tmp, 'sets');
    mkdirSync(dir);
    const line = (id: string) =>
      JSON.stringify({
        id,
        set: 'casual',
        locale: 'en-GB',
        persona: 'user',
        turns: [
          { message: 'hi', expect: { kind: 'smalltalk', intent: 'greeting' } },
        ],
      });
    writeFileSync(join(dir, 'a.jsonl'), `${line('a1')}\n\n${line('a2')}\n`);
    writeFileSync(join(dir, 'b.jsonl'), `${line('b1')}\n`);
    writeFileSync(join(dir, 'notes.md'), 'ignored');
    expect(loadConversations(dir).map((c) => c.id)).toEqual(['a1', 'a2', 'b1']);
    writeFileSync(join(dir, 'c.jsonl'), `${line('a1')}\n`);
    expect(() => loadConversations(dir)).toThrow(/duplicate conversation a1/);
  });

  const good = {
    id: 'x',
    set: 'multi_turn',
    locale: 'zh-CN',
    persona: 'pays for another account',
    turns: [
      { message: '怎么取消', expect: { kind: 'answer', faqId: FAQ(12) } },
    ],
  };
  it.each([
    ['an unknown set', { set: 'long' }],
    ['an unknown locale', { locale: 'fr-FR' }],
    ['no turns', { turns: [] }],
    ['a click first', { turns: [{ click: FAQ(1) }] }],
    [
      'an unknown kind',
      { turns: [{ message: 'hi', expect: { kind: 'escalate' } }] },
    ],
    [
      'an answer without a uuid',
      {
        turns: [{ message: 'hi', expect: { kind: 'answer', faqId: 'faq-1' } }],
      },
    ],
    [
      'clarify without covered',
      {
        turns: [{ message: 'hi', expect: { kind: 'clarify', faqId: FAQ(1) } }],
      },
    ],
    [
      'an unknown small-talk intent',
      {
        turns: [
          { message: 'hi', expect: { kind: 'smalltalk', intent: 'joke' } },
        ],
      },
    ],
    [
      'a click that is not a uuid',
      { turns: [{ message: 'hi' }, { click: 'next' }] },
    ],
    ['an empty message', { turns: [{ message: ' ' }] }],
  ])('rejects %s with its line number', (_name, patch) => {
    const path = join(tmp, 'bad.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify(good)}\n${JSON.stringify({ ...good, ...patch })}\n`,
    );
    expect(() => loadConversations(path)).toThrow(
      `${path}:2: malformed conversation`,
    );
  });

  it('says so when a file has no conversations', () => {
    const path = join(tmp, 'empty.jsonl');
    writeFileSync(path, '\n');
    expect(() => loadConversations(path)).toThrow(/no conversations/);
  });

  it('knows the Portal v4 handover words (en / zh, Traditional too, any case)', () => {
    for (const text of [
      '我要转人工',
      '轉人工',
      'Can I speak to someone?',
      'HUMAN please',
      '我要投訴',
    ])
      expect(isHandoverRequest(text)).toBe(true);
    for (const text of ['how do I reset my password', '谢谢'])
      expect(isHandoverRequest(text)).toBe(false);
  });
});

/** 按提示脚本回话的 runner：pick_faq 按学员原文，explain 按追问。 */
function scriptedRunner(script: {
  pick: Record<string, Record<string, unknown>>;
  explain?: Record<string, { covered: boolean; explanation?: string }>;
}) {
  const prompts: Record<string, unknown>[] = [];
  const runner: AgentStepRunner = {
    run(
      spec: AgentStepSpec,
      context: AgentStepContext,
    ): Promise<AgentStepOutcome> {
      const prompt = JSON.parse(spec.prompt) as Record<string, unknown> & {
        candidates?: { id: string }[];
        shown?: { id: string } | null;
      };
      // 缺省不思考（分级方案）：每步只发一次请求，没有后备那一路
      expect(context.model.thinking).toBe('off');
      prompts.push(prompt);
      if (spec.tool.name === 'explain') {
        const e = script.explain?.[prompt.followUp as string] ?? {
          covered: false,
        };
        const texts: Record<string, string> = {};
        if (e.explanation) texts.explanation = e.explanation;
        return Promise.resolve({
          kind: 'called',
          args: { covered: e.covered ? 'yes' : 'no' },
          extras: { lists: {}, texts, flags: {} },
        });
      }
      const s = script.pick[prompt.message as string] ?? {
        intent: 'question',
        faqId: 'none',
      };
      const ids = (prompt.candidates ?? []).map((c) => c.id);
      const wanted = String(s.faqId);
      const faqId =
        wanted === 'shown'
          ? (prompt.shown?.id ?? 'none')
          : wanted.startsWith('not:')
            ? (ids.find((id) => id !== wanted.slice(4)) ?? 'none')
            : wanted;
      const texts: Record<string, string> = {};
      if (s.reply) texts.reply = s.reply as string;
      return Promise.resolve({
        kind: 'called',
        args: { intent: s.intent as string, faqId, confidence: 'sure' },
        extras: { lists: {}, texts, flags: {} },
      });
    },
  };
  return { runner, prompts };
}

const ENV = {
  OPENROUTER_API_KEY: 'fake-key-local-only',
  OPENROUTER_BASE_URL: 'http://fake-model.invalid/api/v1',
  HELPDESK_SUGGEST_MODEL: 'fake/scripted',
  // 精排缺省开（会发 /rerank 请求）；这里只看对话怎样送到 Admin
  HELPDESK_RERANK_MODEL: 'off',
};

describe('scoring a turn', () => {
  const got = (kind: GotTurn['kind'], nodeId: string | null = null) => ({
    kind,
    intent: null,
    nodeId,
    covered: null,
    guard: null,
    blocks: [],
  });

  it.each([
    [{ kind: 'smalltalk', intent: 'greeting' }],
    [{ kind: 'smalltalk', intent: 'off_topic' }],
    [{ kind: 'handover' }],
  ] as TurnExpectation[][])(
    'R3: a card where %j was expected is not a wrong FAQ but an extra card, and not right either',
    (wanted) => {
      // 用户 2026-10-30 16:52：期望寒暄或转人工时给卡片不算错（转人工也先尽量用卡片解决），单独记「多给卡片」
      expect(score(wanted, got('answer', FAQ(13)), 0)).toEqual({
        right: false,
        wrongFaq: false,
        extraCard: true,
      });
      expect(score(wanted, got('no_match'), 0)).toMatchObject({
        wrongFaq: false,
        extraCard: false,
      });
    },
  );

  it('still counts a card where no_match or clarify was expected as a wrong FAQ', () => {
    expect(score({ kind: 'no_match' }, got('answer', FAQ(13)), 0)).toEqual({
      right: false,
      wrongFaq: true,
    });
    expect(
      score(
        { kind: 'clarify', faqId: FAQ(13), covered: true },
        got('answer', FAQ(12)),
        0,
      ),
    ).toMatchObject({ wrongFaq: true });
  });
});

describe('which branch answered', () => {
  // 开思考的聊天同时跑两路：复核要看给出回答的那一路的候选与 confidence
  const step = (name: string, data: Record<string, unknown>) => ({
    type: 'step/end',
    data: { name, ...data },
  });
  const log = (branch?: string) => [
    step('retrieve', {
      branch: 'quick',
      output: { candidates: [{ id: 'q1', score: 0.5 }], direct: 'q1' },
    }),
    step('retrieve', {
      output: {
        candidates: [
          { id: 't1', score: 0.03, rerankScore: 0.91 },
          { id: 't2', score: 0.02, rerankScore: 0.4 },
        ],
      },
    }),
    step('pick_faq', { branch: 'quick', args: { confidence: 'sure' } }),
    step('pick_faq', { args: { confidence: 'unsure' } }),
    { type: 'turn/end', data: branch ? { branch } : {} },
  ];

  const thinking = [
    { id: 't1', score: 0.03, rerankScore: 0.91 },
    { id: 't2', score: 0.02, rerankScore: 0.4 },
  ];

  it.each([
    ['thinking', thinking, null, 'unsure'],
    ['quick', [{ id: 'q1', score: 0.5 }], 'q1', 'sure'],
  ])(
    'reads the steps of the %s branch',
    (branch, candidateScores, direct, confidence) => {
      expect(stepDetails(log(branch))).toEqual({
        candidateIds: candidateScores.map((c) => c.id),
        candidateScores,
        direct,
        confidence,
        branch,
      });
    },
  );

  it('keeps a missing score as null and drops ids that are not strings', () => {
    expect(
      stepDetails([
        {
          type: 'step/end',
          data: {
            name: 'retrieve',
            output: { candidates: [{ id: 'a' }, { id: 7, score: 1 }] },
          },
        },
      ]),
    ).toMatchObject({
      candidateIds: ['a'],
      candidateScores: [{ id: 'a', score: null }],
      direct: null,
    });
  });

  it('reads the only branch when there is no backup', () => {
    expect(stepDetails(log().slice(1))).toEqual({
      candidateIds: ['t1', 't2'],
      candidateScores: thinking,
      direct: null,
      confidence: 'unsure',
      branch: null,
    });
  });
});

describe('running conversations like the Portal chat', () => {
  const conversation: EvalConversation = {
    id: 'c1',
    set: 'multi_turn',
    locale: 'en-GB',
    persona: 'user',
    flow: 'clarify_clause',
    turns: [
      { message: 'hello', expect: { kind: 'smalltalk', intent: 'greeting' } },
      {
        message: 'can I get a refund',
        expect: { kind: 'answer', faqId: FAQ(13) },
      },
      {
        message: 'what does fewer than two lessons mean?',
        expect: { kind: 'clarify', faqId: FAQ(13), covered: true },
      },
      { click: FAQ(12) },
      {
        message: 'and with PayPal?',
        expect: { kind: 'clarify', faqId: FAQ(12), covered: false },
      },
      { message: 'still lost', expect: { kind: 'handover' } },
      { message: 'I want a human', expect: { kind: 'handover' } },
      { message: 'bye' },
    ],
  };
  const script = {
    pick: {
      hello: {
        intent: 'greeting',
        faqId: 'none',
        reply: 'Hi! What can I help with?',
      },
      'can I get a refund': { intent: 'question', faqId: FAQ(13) },
      'what does fewer than two lessons mean?': {
        intent: 'clarify',
        faqId: 'shown',
      },
      'and with PayPal?': { intent: 'clarify', faqId: 'shown' },
      'still lost': { intent: 'question', faqId: 'none' },
      'I want a human': { intent: 'question', faqId: 'none' },
      bye: { intent: 'farewell', faqId: 'none' },
    },
    explain: {
      'what does fewer than two lessons mean?': {
        covered: true,
        explanation:
          'No problem: if you have finished at most one lesson, you can still ask within 14 days.',
      },
    },
  };

  it('sends the shown card, the session and the earlier words; clicks never reach Admin, handover words do (Portal bc0aa9d)', async () => {
    const { runner, prompts } = scriptedRunner(script);
    const outcome = await runConversations({
      conversations: [conversation],
      qa: memoryQaSource(faqs),
      runner,
      env: ENV,
      budgetUsd: 1,
      paid: false,
    });
    const results = outcome.results;
    expect(results.map((r) => [r.got.kind, r.right])).toEqual([
      ['smalltalk', true],
      ['answer', true],
      ['clarify', true],
      ['click', null],
      ['clarify', true],
      ['no_match', true],
      ['handover', true],
      ['smalltalk', null],
    ]);
    // the first turn has no card; after an answer the card is on screen; a click replaces it
    const picks = prompts.filter((p) => 'message' in p);
    expect(
      picks.map((p) => (p.shown as { id: string } | null)?.id ?? null),
    ).toEqual([null, null, FAQ(13), FAQ(12), FAQ(12), FAQ(12), FAQ(12)]);
    expect(picks[3].recentTurns).toEqual([
      'hello',
      'can I get a refund',
      'what does fewer than two lessons mean?',
    ]);
    expect(results.filter((r) => r.calledAdmin)).toHaveLength(7);
    // no answer card on the handover-word turn → the handover card alone
    expect(results[6].got).toMatchObject({ handover: true, nodeId: null });
    // two unsolved in a row (the uncovered clarify, then a no_match) → the handover card is offered
    expect(results[5].unsolvedStreak).toBe(2);
    expect(results[2].grounded).toBe(true);
    // for review: the candidates the model saw and its confidence
    expect(results[1].got.candidateIds).toContain(FAQ(13));
    expect(results[1].got.confidence).toBe('sure');
    // for the sincerity review: the words the learner saw
    expect(results[0].got.said?.reply).toEqual(expect.any(String));
    expect(results[2].got.said?.explanation).toEqual(expect.any(String));
    expect(results.every((r) => r.escapes.length === 0)).toBe(true);
    expect(outcome).toMatchObject({ conversationsRun: 1, stopped: null });
  });

  it('checks an explanation given on a handover-word turn against the card Admin explained, not as an escape', async () => {
    const { runner } = scriptedRunner({
      pick: {
        'can I get a refund': { intent: 'question', faqId: FAQ(13) },
        'I want a human, what does fewer than two lessons mean?': {
          intent: 'clarify',
          faqId: 'shown',
        },
      },
      explain: {
        'I want a human, what does fewer than two lessons mean?': {
          covered: true,
          explanation:
            'No problem: if you have finished at most one lesson, you can still ask within 14 days.',
        },
      },
    });
    const outcome = await runConversations({
      conversations: [
        {
          ...conversation,
          id: 'c-handover-clarify',
          turns: [
            {
              message: 'can I get a refund',
              expect: { kind: 'answer', faqId: FAQ(13) },
            },
            {
              message: 'I want a human, what does fewer than two lessons mean?',
              expect: { kind: 'handover' },
            },
          ],
        },
      ],
      qa: memoryQaSource(faqs),
      runner,
      env: ENV,
      budgetUsd: 1,
      paid: false,
    });
    const handover = outcome.results[1];
    expect(handover.got).toMatchObject({ kind: 'handover', handover: true });
    expect(handover.right).toBe(true);
    expect(handover.grounded).toBe(true);
    expect(handover.escapes).toEqual([]);
  });

  it('scores a wrong card, an ungrounded explanation and a wrong small-talk intent', async () => {
    const { runner } = scriptedRunner({
      pick: {
        // greeting ≡ vague for the learner (sameSmalltalk); off_topic is a real miss
        hello: { intent: 'off_topic', faqId: 'none' },
        'can I get a refund': { intent: 'question', faqId: `not:${FAQ(13)}` },
        'what does fewer than two lessons mean?': {
          intent: 'clarify',
          faqId: 'shown',
        },
      },
      explain: {
        'what does fewer than two lessons mean?': {
          covered: true,
          explanation: 'It means 3 lessons.',
        },
      },
    });
    const outcome = await runConversations({
      conversations: [
        { ...conversation, turns: conversation.turns.slice(0, 3) },
      ],
      qa: memoryQaSource(faqs),
      runner,
      env: ENV,
      budgetUsd: 1,
      paid: false,
    });
    const [hello, answer, clarify] = outcome.results;
    expect(hello).toMatchObject({
      right: false,
      got: { kind: 'smalltalk', intent: 'off_topic' },
    });
    expect(answer).toMatchObject({ right: false, wrongFaq: true });
    // the guard refused the ungrounded number: the learner saw no explanation
    expect(clarify).toMatchObject({
      right: false,
      grounded: null,
      got: { kind: 'clarify', covered: false, guard: { reason: 'ungrounded' } },
    });
    const report = summarizeConversations({
      outcome,
      totalConversations: 1,
      model: { kind: 'real', model: 'test/model' },
      retrieval: 'memory',
      budgetUsd: 1,
    });
    expect(report.metrics).toMatchObject({
      scoredTurns: 3,
      accuracy: 0,
      wrongFaqRate: 0.3333,
      smalltalkIntentAccuracy: 0,
      clarifyGrounded: null,
      guardEscapes: 0,
    });
    expect(report.gate.pass).toBe(false);
    expect(report.gate.reasons).toEqual([
      'wrong FAQ 0.3333 > 2%',
      'small-talk intent 0 < 95%',
    ]);
  });

  it('a handover word still asks Admin: an answer card comes first and the handover card ends the reply (neither wrong nor extra)', async () => {
    const { runner } = scriptedRunner({
      pick: {
        'can I get a refund or must I ask 客服?': {
          intent: 'question',
          faqId: FAQ(13),
        },
        'I want a human about my refund': {
          intent: 'question',
          faqId: FAQ(13),
        },
      },
    });
    const outcome = await runConversations({
      conversations: [
        {
          ...conversation,
          flow: undefined,
          turns: [
            {
              message: 'can I get a refund or must I ask 客服?',
              expect: { kind: 'answer', faqId: FAQ(13) },
            },
          ],
        },
        {
          ...conversation,
          id: 'c2',
          flow: undefined,
          turns: [
            {
              message: 'I want a human about my refund',
              expect: { kind: 'handover' },
            },
          ],
        },
      ],
      qa: memoryQaSource(faqs),
      runner,
      env: ENV,
      budgetUsd: 1,
      paid: false,
    });
    expect(
      outcome.results.map((r) => [
        r.got.kind,
        r.got.handover,
        r.right,
        r.wrongFaq,
        r.extraCard,
        r.calledAdmin,
      ]),
    ).toEqual([
      ['answer', true, true, false, false, true],
      ['answer', true, true, false, false, true],
    ]);
  });

  it('R3: counts a card shown where small talk or a handover was expected as an extra card, not a wrong one', async () => {
    // 用户 2026-10-30 16:52：想道谢或要人工时出了卡片，不算答错卡（转人工也先尽量用卡片解决），单独数
    const { runner } = scriptedRunner({
      pick: {
        'thanks for the refund help, bye': {
          intent: 'question',
          faqId: `not:${FAQ(0)}`,
        },
        'still lost with my refund': {
          intent: 'question',
          faqId: `not:${FAQ(0)}`,
        },
      },
    });
    const outcome = await runConversations({
      conversations: [
        {
          ...conversation,
          flow: undefined,
          turns: [
            {
              message: 'thanks for the refund help, bye',
              expect: { kind: 'smalltalk', intent: 'farewell' },
            },
          ],
        },
        {
          ...conversation,
          id: 'c2',
          flow: undefined,
          turns: [
            {
              message: 'still lost with my refund',
              expect: { kind: 'handover' },
            },
          ],
        },
      ],
      qa: memoryQaSource(faqs),
      runner,
      env: ENV,
      budgetUsd: 1,
      paid: false,
    });
    expect(
      outcome.results.map((r) => [
        r.got.kind,
        r.right,
        r.wrongFaq,
        r.extraCard,
      ]),
    ).toEqual([
      ['answer', false, false, true],
      ['answer', false, false, true],
    ]);
    const report = summarizeConversations({
      outcome,
      totalConversations: 2,
      model: { kind: 'fake', model: 'fake/x' },
      retrieval: 'memory',
      budgetUsd: 1,
    });
    expect(report.metrics).toMatchObject({
      wrongFaqRate: 0,
      extraCards: 2,
      extraCardRate: 1,
    });
  });

  it('stops at the budget before the next conversation', async () => {
    const { runner } = scriptedRunner(script);
    const outcome = await runConversations({
      conversations: [conversation, { ...conversation, id: 'c2' }],
      qa: memoryQaSource(faqs),
      runner,
      env: ENV,
      budgetUsd: 0,
      paid: false,
    });
    expect(outcome).toMatchObject({
      conversationsRun: 0,
      stopped: 'budget',
      results: [],
    });
  });
});

describe('v5 conversation report and gate', () => {
  function turn(over: Partial<TurnResult>): TurnResult {
    return {
      conversationId: 'c',
      set: 'casual',
      locale: 'en-GB',
      language: 'en-GB',
      persona: 'user',
      flow: null,
      turn: 1,
      message: 'hi',
      expect: { kind: 'smalltalk', intent: 'greeting' },
      got: {
        kind: 'smalltalk',
        intent: 'greeting',
        nodeId: null,
        covered: null,
        guard: { result: 'passed', reason: null, fallback: [] },
        blocks: [],
      },
      right: true,
      wrongFaq: false,
      viaEntry: false,
      extraCard: false,
      grounded: null,
      escapes: [],
      unsolvedStreak: 0,
      latencyMs: 10,
      costUsd: 0.001,
      unpricedCalls: 0,
      calledAdmin: true,
      ...over,
    };
  }
  const outcome = (results: TurnResult[]): ConversationOutcome => ({
    results,
    conversationsRun: 1,
    spentUsd: 0.01,
    stopped: null,
  });

  it('passes a real-model run that meets every Part F gate', () => {
    const report = summarizeConversations({
      outcome: outcome([
        turn({}),
        turn({
          turn: 2,
          expect: { kind: 'clarify', faqId: FAQ(13), covered: true },
          got: {
            kind: 'clarify',
            intent: 'clarify',
            nodeId: FAQ(13),
            covered: true,
            guard: { result: 'passed', reason: null, fallback: [] },
            blocks: [],
          },
          grounded: true,
        }),
      ]),
      totalConversations: 1,
      model: { kind: 'real', model: 'test/model' },
      retrieval: 'postgresql',
      budgetUsd: 2,
      now: new Date('2026-10-30T00:00:00Z'),
    });
    expect(report.gate).toEqual({ pass: true, reasons: [] });
    expect(report.metrics).toMatchObject({
      accuracy: 1,
      clarifyGrounded: 1,
      smalltalkIntentAccuracy: 1,
      guardEscapes: 0,
      guardFallbackRate: 0,
    });
    expect(report.slices.flow).toEqual({
      none: { turns: 2, accuracy: 1, wrongFaqRate: 0 },
    });
    const md = markdownConversationReport(report);
    expect(md).toContain('Gate: PASS');
    expect(md).toContain('| Clarify grounded | 100.0% (1 explanations) |');
  });

  it('fails on any guard escape, an ungrounded explanation, a partial or fake run', () => {
    const report = summarizeConversations({
      outcome: {
        ...outcome([
          turn({ escapes: ['reply'] }),
          turn({ grounded: false, expect: null, right: null }),
        ]),
        conversationsRun: 1,
      },
      totalConversations: 2,
      model: { kind: 'fake', model: 'fake/top-candidate' },
      retrieval: 'memory',
      budgetUsd: 2,
    });
    expect(report.gate.pass).toBe(false);
    expect(report.gate.reasons).toEqual([
      'fake model: these numbers only show the eval runs',
      'ran 1 of 2 conversations',
      '1 guard escapes',
      'clarify grounded 0 < 100%',
    ]);
    expect(report.failures).toHaveLength(1);
    expect(CONVERSATION_GATE).toEqual({
      guardEscapesMax: 0,
      clarifyGroundedMin: 1,
      wrongFaqRateMax: 0.02,
      smalltalkIntentMin: 0.95,
    });
  });
});

describe('the whole sample through the pi workflow with the fake model', () => {
  it('runs every conversation (templates for every short line, never an escape) and the CLI writes the report', async () => {
    const { runner, env } = await runnerFor({
      kind: 'fake',
      model: 'fake/top-candidate',
    });
    const conversations = loadConversations(SAMPLE);
    const outcome = await runConversations({
      conversations,
      qa: memoryQaSource(faqs),
      runner,
      env: env({}),
      budgetUsd: 1,
      paid: false,
    });
    expect(outcome.conversationsRun).toBe(conversations.length);
    const answered = outcome.results.filter((r) => r.got.kind === 'answer');
    expect(answered.length).toBeGreaterThan(0);
    expect(outcome.results.every((r) => r.escapes.length === 0)).toBe(true);

    const out = join(tmp, 'v5.md');
    const turnsOut = join(tmp, 'turns', 'v5.turns.jsonl');
    const lines: string[] = [];
    const code = await runCli(
      [
        '--conversations',
        SAMPLE,
        '--out',
        out,
        '--turns',
        turnsOut,
        '--concurrency',
        '2',
      ],
      {
        env: {},
        cwd: tmp,
        log: (line) => lines.push(line),
      },
    );
    expect(code).toBe(0);
    // every turn, not just the first 200 failures
    const dumped = readFileSync(turnsOut, 'utf8').trim().split('\n');
    expect(dumped).toHaveLength(outcome.results.length);
    expect(JSON.parse(dumped[0])).toMatchObject({
      conversationId: conversations[0].id,
      turn: 1,
    });
    const md = readFileSync(out, 'utf8');
    expect(md).toContain('# Helpdesk v5 conversation eval');
    expect(md).toContain('Not a model score.');
    expect(lines.some((l) => l.startsWith('gate FAIL'))).toBe(true);
    // the fake model writes no short lines: the learner sees the fixed opening
    expect(TEMPLATES.opening.en).toBe("Here's how to sort this out:");
  });
});

/**
 * Part G5「CI (free, no model): retrieval-only eval on the seed FAQs and cases, gate recall@8 ≥ 95%」。
 * 生产的候选 SQL（PostgreSQL，HELPDESK_TEST_DATABASE_URL；CI 必给）与内存近似都要过。
 */
describe('retrieval-only gate on the seed FAQs and cases (CI, no model)', () => {
  const RECALL_AT_8_MIN = 0.95;
  // 种子 FAQ 自己的中英文问题（与发布门 faqReleaseGate 同样的做法）+ 种子用例
  const cases: EvalCase[] = [
    ...faqs.flatMap((f): EvalCase[] => [
      {
        id: `faq-${f.id}-en`,
        locale: 'en-GB',
        persona: 'paraphrase',
        message: f.questionEn,
        expectedFaqId: f.id,
      },
      {
        id: `faq-${f.id}-zh`,
        locale: 'zh-CN',
        persona: 'paraphrase',
        message: f.questionZh,
        expectedFaqId: f.id,
      },
    ]),
    ...loadCases(join(DIR, 'cases.jsonl')),
  ];

  const url = process.env.HELPDESK_TEST_DATABASE_URL;
  if (!url && process.env.CI === 'true')
    throw new Error('HELPDESK_TEST_DATABASE_URL is required when CI=true');
  (url ? it : it.skip)(
    'PostgreSQL (the production candidate SQL): recall@8 ≥ 95%, and lists the misses',
    async () => {
      const pg = await pgQaSource(url as string, faqs, helpdeskMigrationSql());
      try {
        const results = await runRetrieval({ cases, qa: pg.qa });
        const report = summarizeRetrieval({
          results,
          totalCases: cases.length,
          retrieval: 'postgresql',
          faqs: faqs.length,
        });
        const misses = results
          .filter((r) => r.expectedFaqId !== null)
          .filter((r) => {
            const rank = acceptedRank(r);
            return rank === null || rank > 8;
          })
          .map((r) => r.id);
        expect(report.overall.answerable).toBeGreaterThan(150);
        // 没过闸时列出没检索到的用例
        expect(
          (report.overall.recallAt8 ?? 0) >= RECALL_AT_8_MIN ? [] : misses,
        ).toEqual([]);
        expect(report.overall.recallAt8).toBeGreaterThanOrEqual(
          RECALL_AT_8_MIN,
        );
      } finally {
        await pg.close();
      }
    },
    60_000,
  );

  it('keeps the pg driver available to the eval', () => {
    expect(typeof Pool).toBe('function');
  });
});
