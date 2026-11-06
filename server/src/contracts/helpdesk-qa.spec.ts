import {
  EXCERPT_RULES,
  FAQ_SIGNALS,
  GUARD_LIMITS,
  GUARDED_FIELDS,
  SITUATION_SIGNALS,
  SUGGEST_CONTEXT_LIMITS,
  SUGGEST_INTENTS,
  SUGGEST_TURN_FIELDS,
  faqReleaseEtag,
  isFaqSignal,
  isSituationSignal,
  parseSuggestContext,
  suggestTurnProblems,
  SUGGEST_MORE_MAX,
} from './helpdesk-qa';
import { INTENTS } from '../ai/helpdesk/workflow/faq-workflow';

/** Helpdesk v5 契约（fixture v6）的纯函数部分；线上例子由 backoffice/tests/helpdesk-contract-fixture.spec.ts 锁。 */
const NODE = '01a18100-0000-7000-8000-000000000022';

describe('situation signals (Part A)', () => {
  it('FAQ signals are the situation signals minus open_ticket_waiting, in the chip priority order', () => {
    expect(FAQ_SIGNALS).toEqual([
      'payment_failed',
      'payment_pending',
      'recent_purchase',
      'trial_ending',
      'subscription_expired',
      'subscription_cancelled',
      'email_unverified',
      'from_order',
    ]);
    expect(
      SITUATION_SIGNALS.filter((s) => s !== 'open_ticket_waiting').sort(),
    ).toEqual([...FAQ_SIGNALS].sort());
    expect(isSituationSignal('open_ticket_waiting')).toBe(true);
    expect(isFaqSignal('open_ticket_waiting')).toBe(false);
    expect(isFaqSignal('payment_failed')).toBe(true);
    expect(isFaqSignal('PAYMENT_FAILED')).toBe(false);
  });
});

describe('suggest intents', () => {
  it('extend the v2 pick_faq intents, keeping their order', () => {
    expect(SUGGEST_INTENTS.slice(0, INTENTS.length)).toEqual([...INTENTS]);
    expect(SUGGEST_INTENTS.slice(INTENTS.length)).toEqual([
      'greeting',
      'farewell',
      'vague',
      'clarify',
    ]);
  });
});

describe('parseSuggestContext', () => {
  it('is null for an older Portal (no context), and keeps only the keys given', () => {
    expect(parseSuggestContext(undefined)).toBeNull();
    expect(parseSuggestContext(null)).toBeNull();
    expect(parseSuggestContext({})).toEqual({});
    expect(parseSuggestContext({ nodeId: NODE.toUpperCase() })).toEqual({
      nodeId: NODE,
    });
  });

  it('trims the recent learner turns and drops empty ones', () => {
    expect(
      parseSuggestContext({
        sessionId: NODE,
        recentTurns: ['  first  ', '', 'second'],
      }),
    ).toEqual({ sessionId: NODE, recentTurns: ['first', 'second'] });
    expect(
      parseSuggestContext({
        recentTurns: ['字'.repeat(SUGGEST_CONTEXT_LIMITS.recentTurnMax)],
      })?.recentTurns?.[0],
    ).toHaveLength(SUGGEST_CONTEXT_LIMITS.recentTurnMax);
  });

  it.each([
    ['a list', []],
    ['a string', 'x'],
    ['a malformed nodeId', { nodeId: 'faq-1' }],
    ['a numeric sessionId', { sessionId: 7 }],
    ['more than 3 turns', { recentTurns: ['a', 'b', 'c', 'd'] }],
    ['turns that are not a list', { recentTurns: 'a' }],
    ['a turn that is not text', { recentTurns: [1] }],
    ['a turn with a control character', { recentTurns: ['a\u0000b'] }],
    ['a turn over 500 characters', { recentTurns: ['x'.repeat(501)] }],
  ])('refuses %s', (_name, raw) => {
    expect(() => parseSuggestContext(raw)).toThrow(/context/);
  });
});

describe('suggestTurnProblems', () => {
  const passed = { result: 'passed', reason: null, fallback: [] };
  const answer = {
    suggestion: { id: NODE, faqId: NODE, question: 'q', answer: 'a' },
    alternatives: [],
    kind: 'answer',
    intent: 'question',
    confidence: 'sure',
    nodeId: NODE,
    blocks: ['b2', 'b3'],
    opening: 'Here you go:',
    closing: 'Ask me if anything is unclear.',
    reply: null,
    explanation: null,
    covered: null,
    guard: passed,
    releaseVersion: 3,
  };

  it('accepts a well-formed answer and names every field the contract adds', () => {
    expect(suggestTurnProblems(answer)).toEqual([]);
    const { releaseVersion, ...missing } = answer;
    void releaseVersion;
    expect(suggestTurnProblems(missing)).toContain('releaseVersion is missing');
    expect(SUGGEST_TURN_FIELDS).toHaveLength(12);
  });

  it.each([
    ['an unknown kind', { kind: 'handover' }, 'kind is unknown'],
    ['an unknown intent', { intent: 'chat' }, 'intent is unknown'],
    [
      'gapped blocks',
      { blocks: ['b1', 'b3'] },
      'blocks must be contiguous and in order',
    ],
    [
      'too many blocks',
      { blocks: ['b1', 'b2', 'b3', 'b4'] },
      'blocks has more than 3 ids',
    ],
    ['a malformed block id', { blocks: ['p1'] }, 'blocks must be block ids'],
    [
      'an opening without a closing',
      { closing: null },
      'opening and closing come together, or both null (choice)',
    ],
    [
      'a nodeId that is not the answer',
      { nodeId: '01a18100-0000-7000-8000-000000000099' },
      'nodeId must be the suggestion faqId',
    ],
    [
      'a reply next to an answer',
      { reply: 'hi' },
      'reply must be null for answer',
    ],
    [
      'a passed guard with a reason',
      { guard: { ...passed, reason: 'digit' } },
      'guard.reason is null exactly when it passed',
    ],
    [
      'a fallback guard with no field',
      { guard: { result: 'fallback', reason: 'digit', fallback: [] } },
      'guard.fallback is empty exactly when it passed',
    ],
    [
      'release version zero',
      { releaseVersion: 0 },
      'releaseVersion must be a positive integer or null',
    ],
  ])('flags %s', (_name, patch, problem) => {
    expect(suggestTurnProblems({ ...answer, ...patch })).toContain(problem);
  });

  it('checks the per-kind rules for small talk, clarify and no match', () => {
    const empty = {
      suggestion: null,
      alternatives: [],
      intent: null,
      confidence: null,
      nodeId: null,
      blocks: [],
      opening: null,
      closing: null,
      reply: null,
      explanation: null,
      covered: null,
      guard: null,
      releaseVersion: null,
    };
    expect(suggestTurnProblems({ ...empty, kind: 'smalltalk' })).toEqual(
      expect.arrayContaining([
        'smalltalk needs a reply',
        'smalltalk needs a guard',
      ]),
    );
    expect(
      suggestTurnProblems({
        ...empty,
        kind: 'clarify',
        nodeId: NODE,
        covered: true,
        guard: passed,
      }),
    ).toContain('covered clarify needs an explanation');
    expect(
      suggestTurnProblems({
        ...empty,
        kind: 'clarify',
        nodeId: NODE,
        covered: false,
        explanation: 'x',
        guard: passed,
      }),
    ).toContain('uncovered clarify shows no explanation');
    expect(suggestTurnProblems({ ...empty, kind: 'no_match' })).toEqual([]);
    expect(
      suggestTurnProblems({ ...empty, kind: 'no_match', guard: passed }),
    ).toContain('guard must be null for no_match');
    expect(suggestTurnProblems('x')).toEqual(['not an object']);
  });

  describe('several asks in one message (more, missed)', () => {
    const OTHER = '01a18100-0000-7000-8000-000000000002';
    const THIRD = '01a18100-0000-7000-8000-000000000003';
    const extra = (faqId: string, blocks: string[] = []) => ({
      faqId,
      question: 'q2',
      answer: 'a2',
      blocks,
    });

    it('accepts up to two more cards and a missed count next to an answer; both keys are optional', () => {
      expect(
        suggestTurnProblems({
          ...answer,
          more: [extra(OTHER, ['b1', 'b2']), extra(THIRD)],
        }),
      ).toEqual([]);
      expect(suggestTurnProblems({ ...answer, missed: 1 })).toEqual([]);
      expect(SUGGEST_MORE_MAX).toBe(2);
    });

    it.each([
      ['an empty list', { more: [] }, 'more lists 1 to 2 cards'],
      [
        'three more cards',
        {
          more: [
            extra(OTHER),
            extra(THIRD),
            extra('01a18100-0000-7000-8000-000000000004'),
          ],
        },
        'more lists 1 to 2 cards',
      ],
      [
        'the first card again',
        { more: [extra(NODE)] },
        'more cards are all different',
      ],
      [
        'the same card twice',
        { more: [extra(OTHER), extra(OTHER)] },
        'more cards are all different',
      ],
      ['a card with no id', { more: [extra('x')] }, 'more cards need a faqId'],
      [
        'a card with no answer',
        { more: [{ ...extra(OTHER), answer: ' ' }] },
        'more cards need a answer',
      ],
      [
        'gapped blocks',
        { more: [extra(OTHER, ['b1', 'b3'])] },
        'more cards need contiguous block ids',
      ],
      ['missed zero', { missed: 0 }, 'missed is 1 to 2'],
      ['missed three', { missed: 3 }, 'missed is 1 to 2'],
    ])('flags %s', (_name, patch, problem) => {
      expect(suggestTurnProblems({ ...answer, ...patch })).toContain(problem);
    });

    it('only an answer carries them', () => {
      const noMatch = {
        ...answer,
        suggestion: null,
        kind: 'no_match',
        nodeId: null,
        blocks: [],
        opening: null,
        closing: null,
        guard: null,
        alternatives: [],
      };
      expect(
        suggestTurnProblems({ ...noMatch, more: [extra(OTHER)], missed: 1 }),
      ).toEqual(
        expect.arrayContaining([
          'no_match has no more cards',
          'no_match has no missed asks',
        ]),
      );
    });
  });
});

describe('limits', () => {
  it('guard limits per field and script, and the excerpt rules, are the spec numbers', () => {
    expect(Object.keys(GUARD_LIMITS)).toEqual([...GUARDED_FIELDS]);
    expect(GUARD_LIMITS).toEqual({
      opening: { zh: 30, en: 80 },
      closing: { zh: 30, en: 80 },
      reply: { zh: 80, en: 200 },
      explanation: { zh: 150, en: 350 },
    });
    expect(EXCERPT_RULES).toEqual({
      maxBlocks: 3,
      wholeAnswerMaxBlocks: 3,
      wholeAnswerMaxChars: 200,
    });
    expect(faqReleaseEtag(12)).toBe('"v12"');
  });
});
