import {
  emptyAskStats,
  type EvalCacheMode,
} from '../../contracts/helpdesk-eval-cache';
import type {
  ReleaseAnswerer,
  ReleaseEvalAnswer,
} from '../../contracts/helpdesk-release-eval';
import type {
  FaqReleaseSnapshot,
  FaqSnapshotNode,
} from '../modules/helpdesk/faqs/faqRelease';
import type { FaqReleaseEvalProgress } from '../modules/helpdesk/faqs/faqReleaseGate';
import {
  MODEL_GATE,
  createModelReleaseGate,
  loadReleaseEvalItems,
  planQuestions,
  scoreModelAnswer,
  type EvalQuestion,
  type ReleaseEvalItem,
} from '../modules/helpdesk/faqs/faqReleaseModelGate';
import {
  followupParents,
  planFollowups,
} from '../modules/helpdesk/faqs/release-check/questions';
import { wilson } from '../modules/helpdesk/faqs/release-check/stats';

/**
 * 发布前的真流程检查（release check v2，owner 2026-11-06 批准）：问哪些题、怎么判分、什么时候不通过：
 * 全部题、逐题和上线版本比、新出的错复问确认、漂移抽查、Wilson 区间上界、切片、库里没卡别给卡。
 * 答题器是假的（真的那个在 src/ai/helpdesk/release-answerer.ts，跑整条线上流程）。
 */
const id = (n: number) =>
  `0192d4f0-0000-7000-8000-${String(n).padStart(12, '0')}`;

function node(n: number, key: string, entry = true): FaqSnapshotNode {
  return {
    id: id(n),
    key,
    type: 'answer',
    entry,
    category: 'other',
    popular: false,
    questionEn: `Q ${key}`,
    answerEn: `A ${key}`,
    questionZh: `问 ${key}`,
    answerZh: `答 ${key}`,
    blocksEn: [],
    blocksZh: [],
    signals: [],
    keywords: [],
    version: 1,
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

// refund（入口）→ refund-late（追问）；password（入口）
const snapshot: FaqReleaseSnapshot = {
  nodes: [
    node(1, 'refund'),
    node(2, 'refund-late', false),
    node(3, 'password'),
  ],
  edges: [
    {
      parentId: id(1),
      childId: id(2),
      kind: 'follow_up',
      position: 0,
      labelEn: null,
      labelZh: null,
    },
  ],
  phrasings: [],
};

const items: ReleaseEvalItem[] = [
  {
    id: 'a1',
    locale: 'zh-CN',
    message: '怎么退款',
    expect: 'answer',
    faq: 'refund',
  },
  {
    id: 'a2',
    locale: 'en-GB',
    message: 'late refund?',
    expect: 'answer',
    faq: 'refund-late',
  },
  {
    id: 'a3',
    locale: 'zh-TW',
    message: '忘記密碼',
    expect: 'answer',
    faq: 'password',
    acceptable: ['refund'],
  },
  {
    id: 'a4',
    locale: 'mixed',
    message: 'gone card',
    expect: 'answer',
    faq: 'not-in-this-library',
  },
  { id: 'n1', locale: 'en-GB', message: 'do my homework', expect: 'no_match' },
  { id: 's1', locale: 'zh-CN', message: '你好', expect: 'smalltalk' },
];

const answer = (
  kind: ReleaseEvalAnswer['kind'],
  nodeId: string | null = null,
  costUsd = 0.0001,
  extra: Partial<ReleaseEvalAnswer> = {},
): ReleaseEvalAnswer => ({
  kind,
  nodeId,
  costUsd,
  unpricedCalls: 0,
  ...extra,
});

type Asked = {
  version: number;
  message: string;
  locale: string;
  cache: EvalCacheMode;
  /** 追问：屏幕上开着的卡（节点 id）。 */
  screen: string | null;
  recentTurns: readonly string[];
};

/** 假答题器：reply 看得到问的是哪一版、缓存怎么用。 */
function fakeAnswerer(
  reply: (message: string, asked: Asked) => ReleaseEvalAnswer,
  available = true,
) {
  const asked: Asked[] = [];
  const answerer: ReleaseAnswerer = {
    available: () => available,
    model: () => 'google/gemma-4-31b-it',
    forRelease: ({ version }) => ({
      ask: ({ message, locale, cache = 'use', screen }) => {
        const one = {
          version,
          message,
          locale,
          cache,
          screen: screen?.nodeId ?? null,
          recentTurns: screen?.recentTurns ?? [],
        };
        asked.push(one);
        return Promise.resolve(reply(message, one));
      },
    }),
  };
  return { answerer, asked };
}

const input = (
  extra: Partial<
    Parameters<ReturnType<typeof createModelReleaseGate>['evaluate']>[0]
  > = {},
) => ({
  version: 2,
  snapshot,
  previous: null,
  ...extra,
});

const live = { version: 1, evalReport: null, snapshot };

const fixed = () => new Date('2026-11-06T10:00:00.000Z');

/** n 道问退款的题（够多，错卡率的区间上界才可能 ≤ 2%：0 / 190 道的上界约 2%）。 */
const refunds = (
  n: number,
  set: 'blind' | 's650' = 's650',
): ReleaseEvalItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${set}-${String(i).padStart(4, '0')}`,
    set,
    locale: i % 2 === 0 ? 'zh-CN' : 'en-GB',
    message: `refund question ${set} ${i}`,
    expect: 'answer',
    faq: 'refund',
  }));

const right = (message: string) =>
  message === '怎么退款' || message === 'late refund?'
    ? answer('answer', id(1))
    : message === '忘記密碼'
      ? answer('answer', id(3))
      : message === '你好'
        ? answer('smalltalk')
        : message.startsWith('refund question')
          ? answer('answer', id(1))
          : answer('no_match');

describe('the live-pipeline check: which questions', () => {
  it('ships the eval-v6 dev split only (275 blind + 1,409 S650 questions for library v3.5, never the test split)', () => {
    const all = loadReleaseEvalItems();
    expect(all).toHaveLength(1684);
    expect(all.filter((item) => item.set === 'blind')).toHaveLength(275);
    expect(all.filter((item) => item.set === 's650')).toHaveLength(1409);
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length);
    expect(new Set(all.map((item) => item.expect))).toEqual(
      new Set(['answer', 'no_match', 'smalltalk']),
    );
    for (const item of all) {
      expect(
        Object.keys(item).every((k) =>
          [
            'id',
            'set',
            'locale',
            'style',
            'message',
            'expect',
            'faq',
            'acceptable',
          ].includes(k),
        ),
      ).toBe(true);
      if (item.expect === 'answer') expect(typeof item.faq).toBe('string');
    }
  });

  it('asks every question (no sampling): maps keys to this release, keeps the entry card of a follow-up apart, skips cards this release lacks and asks each text once', () => {
    const { questions, skipped } = planQuestions({
      items: [...items, { ...items[0], id: 'dup' }],
      snapshot,
      changed: new Set(['password']),
      regression: [],
    });
    expect(skipped).toBe(1);
    expect(questions.map((q) => q.id)).toEqual(['a1', 'a2', 'a3', 'n1', 's1']);
    const byId = new Map(questions.map((q) => [q.id, q]));
    expect(byId.get('a2')).toMatchObject({
      locale: 'en-GB',
      language: 'en-GB',
      faqId: id(2),
      acceptable: [],
      entryIds: [id(1)],
      changed: false,
    });
    // zh-TW and mixed are asked the way Portal sends them (zh-CN); slices keep the original language
    expect(byId.get('a3')).toMatchObject({
      locale: 'zh-CN',
      language: 'zh-TW',
      faqId: id(3),
      acceptable: [id(1)],
      entryIds: [],
      changed: true,
    });
    expect(byId.get('n1')).toMatchObject({ expect: 'no_match', faqId: null });
    expect(questions.every((q) => q.set === 's650')).toBe(true);
  });

  it("adds the regression cases for cards in this release, never one that is its own card's question or phrasing (a leak)", () => {
    const withPhrasing: FaqReleaseSnapshot = {
      ...snapshot,
      phrasings: [{ faqId: id(3), locale: 'zh-CN', text: '密码又忘了怎么办' }],
    };
    const { questions, skipped, leaked } = planQuestions({
      items: [],
      snapshot: withPhrasing,
      changed: new Set(),
      regression: [
        // the phrasing itself, in traditional script and without the punctuation
        { faqId: id(3), locale: 'zh-TW', text: '密碼又忘了 怎麼辦？' },
        // the card's own question
        { faqId: id(3), locale: 'en-GB', text: 'q password' },
        // another card's phrasing is a fair question for this card
        { faqId: id(1), locale: 'zh-CN', text: '密码又忘了怎么办' },
        { faqId: id(3), locale: 'zh-CN', text: '登录不上了' },
        { faqId: id(99), locale: 'en-GB', text: 'a card that is gone' },
      ],
    });
    expect(leaked).toBe(2);
    expect(skipped).toBe(1);
    expect(questions.map((q) => [q.set, q.faqId, q.message])).toEqual([
      ['regression', id(1), '密码又忘了怎么办'],
      ['regression', id(3), '登录不上了'],
    ]);
  });
});

describe('the live-pipeline check: scoring', () => {
  const byId = new Map(
    planQuestions({
      items,
      snapshot,
      changed: new Set(),
      regression: [],
    }).questions.map((q) => [q.id, q]),
  );
  const q = (key: string) => byId.get(key) as EvalQuestion;

  it('counts another card as a wrong card and no card as not answered; a timeout is a miss, any other failure is a broken check', () => {
    expect(scoreModelAnswer(q('a1'), answer('answer', id(1)))).toMatchObject({
      right: true,
      wrongCard: false,
    });
    expect(scoreModelAnswer(q('a1'), answer('answer', id(3)))).toMatchObject({
      right: false,
      wrongCard: true,
      cardWhenNone: false,
    });
    expect(scoreModelAnswer(q('a1'), answer('no_match'))).toMatchObject({
      right: false,
      wrongCard: false,
    });
    expect(
      scoreModelAnswer(
        q('a1'),
        answer('error', null, 0, { failure: 'timeout' }),
      ),
    ).toMatchObject({ timeout: true, error: false, wrongCard: false });
    expect(
      scoreModelAnswer(
        q('a1'),
        answer('error', null, 0, { failure: 'no_key' }),
      ),
    ).toMatchObject({ timeout: false, error: true });
  });

  it('the entry card that leads to the labelled follow-up is right, counted on its own', () => {
    expect(scoreModelAnswer(q('a2'), answer('answer', id(1)))).toMatchObject({
      right: true,
      viaEntry: true,
    });
  });

  it('a card on a no-match question is a wrong card of its own kind; a card on small talk is only an extra card (R3)', () => {
    expect(scoreModelAnswer(q('n1'), answer('answer', id(1)))).toMatchObject({
      wrongCard: true,
      cardWhenNone: true,
    });
    expect(
      scoreModelAnswer(q('n1'), {
        ...answer('clarify', id(1)),
        covered: false,
      }),
    ).toMatchObject({ right: true, wrongCard: false });
    expect(
      scoreModelAnswer(q('n1'), { ...answer('clarify', id(1)), covered: true }),
    ).toMatchObject({ right: false, wrongCard: false });
    expect(scoreModelAnswer(q('s1'), answer('answer', id(1)))).toMatchObject({
      wrongCard: false,
      extraCard: true,
    });
  });

  it('judges a rate on its 95% Wilson upper bound', () => {
    expect(wilson(0, 1684).high).toBeCloseTo(0.00228, 5);
    expect(wilson(1, 400).high).toBeCloseTo(0.01402, 5);
    // five questions cannot show 2%: nothing wrong still has an upper bound of 43%
    expect(wilson(0, 5).high).toBeCloseTo(0.43448, 5);
  });
});

describe('the live-pipeline check: pass or fail', () => {
  it('passes with every question right on both versions, reporting progress, suites, spend and the receipt', async () => {
    const { answerer, asked } = fakeAnswerer((message) => right(message));
    const progress: FaqReleaseEvalProgress[] = [];
    const prepared: number[] = [];
    const report = await createModelReleaseGate({
      answerer,
      items: () => [...items, ...refunds(250)],
      prepare: (version) => Promise.resolve(prepared.push(version)),
      now: fixed,
      limits: { progressEvery: 50 },
    }).evaluate(
      input({
        previous: live,
        progress: (p) => Promise.resolve(Boolean(progress.push(p))),
      }),
    );
    expect(report).toMatchObject({ kind: 'model', passed: true });
    expect(report.summary).toContain('google/gemma-4-31b-it');
    expect(report.summary).toContain('95% upper');
    expect(report.metrics).toMatchObject({
      cases: 255,
      wrongCards: 0,
      wrongRate: 0,
      errors: 0,
      skippedCases: 1,
      rightRate: 1,
      viaEntry: 1,
      newlyWrong: 0,
      liveWrongRate: 0,
    });
    // both versions are asked every question, with the cache
    expect(asked.filter((a) => a.version === 2)).toHaveLength(255);
    expect(asked.filter((a) => a.version === 1)).toHaveLength(255);
    expect(new Set(asked.map((a) => a.cache))).toEqual(new Set(['use']));
    expect(report.metrics.costUsd).toBeCloseTo(0.051, 6);
    expect(report.metrics.costLiveUsd).toBeCloseTo(0.0255, 6);
    expect(prepared).toEqual([2, 1]);
    expect(progress[0]).toEqual({ stage: 'vectors', done: 0, total: 1 });
    expect(progress.at(-1)).toEqual({ stage: 'model', done: 255, total: 255 });
    const suites = new Map(report.suites?.map((s) => [s.id, s]));
    expect(suites.get('combined')).toMatchObject({
      status: 'gate',
      passed: true,
    });
    expect(suites.get('s650')?.n).toBe(255);
    // a language slice below 200 questions is only tracked
    expect(suites.get('language:zh-TW')).toMatchObject({
      status: 'track',
      n: 1,
    });
    expect(report.receipt).toMatchObject({
      model: 'google/gemma-4-31b-it',
      questions: 255,
      liveVersion: 1,
      devSet: 'eval-v6-dev',
    });
  });

  it('fails when the 95% upper bound of wrong cards is above 2%, and lists the misses with keys', async () => {
    const { answerer } = fakeAnswerer((message, asked) =>
      message === 'refund question s650 0' && asked.version === 2
        ? answer('answer', id(3))
        : right(message),
    );
    // 1 wrong of 250: 0.4%, upper bound 2.2%
    const report = await createModelReleaseGate({
      answerer,
      items: () => refunds(250),
      now: fixed,
    }).evaluate(input());
    expect(report.passed).toBe(false);
    expect(report.summary).toContain('wrong card 0.4% (95% upper 2.2%) > 2.0%');
    expect(report.misses).toEqual([
      {
        id: 's650-0000',
        set: 's650',
        locale: 'zh-CN',
        text: 'refund question s650 0',
        expected: 'refund',
        got: 'answer:password',
        why: 'wrong_card',
      },
    ]);
  });

  it('a question newly wrong against the live version fails only when asking again without the cache still gets it wrong', async () => {
    const wrongOnce = (stays: boolean) =>
      fakeAnswerer((message, asked) =>
        message === 'refund question s650 7' &&
        asked.version === 2 &&
        (asked.cache === 'use' || stays)
          ? answer('answer', id(3))
          : right(message),
      );
    const real = wrongOnce(true);
    // 1 wrong of 400 is within 2% (upper 1.4%), but it is new: the card change broke it
    const failed = await createModelReleaseGate({
      answerer: real.answerer,
      items: () => refunds(400),
      now: fixed,
    }).evaluate(input({ previous: live }));
    expect(failed.passed).toBe(false);
    expect(failed.metrics).toMatchObject({
      wrongCards: 1,
      newlyWrong: 1,
      confirmedWorse: 1,
    });
    expect(failed.summary).toContain('newly wrong against the live version');
    expect(failed.misses[0]).toMatchObject({
      id: 's650-0007',
      why: 'newly_wrong',
      live: 'answer:refund',
    });
    expect(real.asked.filter((a) => a.cache === 'bypass')).toHaveLength(
      MODEL_GATE.reaskTimes,
    );
    // the same question right on both re-asks: the model wobbled once, the cards are fine
    const noise = await createModelReleaseGate({
      answerer: wrongOnce(false).answerer,
      items: () => refunds(400),
      now: fixed,
    }).evaluate(input({ previous: live }));
    expect(noise.passed).toBe(true);
    expect(noise.metrics).toMatchObject({ newlyWrong: 1, confirmedWorse: 0 });
  });

  it('the blind set is only tracked for its rate, but a newly wrong blind question still fails', async () => {
    const blindWrong = (alsoLive: boolean) =>
      fakeAnswerer((message, asked) =>
        message === 'refund question blind 0' &&
        (asked.version === 2 || alsoLive)
          ? answer('answer', id(3))
          : right(message),
      ).answerer;
    const all = () => [...refunds(400), ...refunds(10, 'blind')];
    // 1 of 10 blind wrong (10%) on both versions: tracked, not a fail
    const same = await createModelReleaseGate({
      answerer: blindWrong(true),
      items: all,
      now: fixed,
    }).evaluate(input({ previous: live }));
    expect(same.passed).toBe(true);
    expect(same.suites?.find((s) => s.id === 'blind')).toMatchObject({
      status: 'track',
      metrics: { wrongRate: 0.1 },
    });
    const worse = await createModelReleaseGate({
      answerer: blindWrong(false),
      items: all,
      now: fixed,
    }).evaluate(input({ previous: live }));
    expect(worse.passed).toBe(false);
  });

  it('fails when cards are shown for more than 3% of the questions the library has no card for', async () => {
    const none: ReleaseEvalItem[] = Array.from({ length: 30 }, (_, i) => ({
      id: `none-${i}`,
      locale: 'en-GB',
      message: `homework ${i}`,
      expect: 'no_match',
    }));
    const { answerer } = fakeAnswerer((message) =>
      message === 'homework 0' ? answer('answer', id(1)) : right(message),
    );
    const report = await createModelReleaseGate({
      answerer,
      items: () => [...refunds(400), ...none],
      now: fixed,
    }).evaluate(input());
    expect(report.metrics).toMatchObject({
      cardWhenNone: 1,
      cardWhenNoneRate: 0.0333,
    });
    expect(report.passed).toBe(false);
    expect(report.summary).toContain('no card for');
  });

  it('counts a timeout as a miss, and does not count a run where many questions got no answer at all', async () => {
    const timeouts = await createModelReleaseGate({
      answerer: fakeAnswerer((message) =>
        message === 'refund question s650 1'
          ? answer('error', null, 0, { failure: 'timeout' })
          : right(message),
      ).answerer,
      items: () => refunds(250),
      now: fixed,
    }).evaluate(input());
    expect(timeouts.metrics).toMatchObject({ timeouts: 1, errors: 0 });
    expect(timeouts.metrics.rightRate).toBeCloseTo(249 / 250, 4);
    expect(timeouts.passed).toBe(true);
    const broken = await createModelReleaseGate({
      answerer: fakeAnswerer(() =>
        answer('error', null, 0, { failure: 'rate_limited' }),
      ).answerer,
      items: () => items,
      now: fixed,
    }).evaluate(input());
    expect(broken.passed).toBe(false);
    // 5 single questions + the follow-up on refund-late (no live version: every parent is asked)
    expect(broken.metrics.errors).toBe(6);
    expect(broken.summary).toContain('got no answer');
  });

  it('asks some cached answers again without the cache, and does not count the check when more than 2 changed', async () => {
    const hit = {
      ...emptyAskStats(),
      step: { hits: 1, misses: 0, savedUsd: 0.0001 },
    };
    const { answerer, asked } = fakeAnswerer((message, a) =>
      a.cache === 'refresh' && message.endsWith('1')
        ? answer('no_match')
        : { ...right(message), cache: hit },
    );
    const report = await createModelReleaseGate({
      answerer,
      items: () => refunds(250),
      now: fixed,
    }).evaluate(input());
    expect(asked.filter((a) => a.cache === 'refresh')).toHaveLength(
      MODEL_GATE.driftSample,
    );
    expect(report.metrics.driftChecked).toBe(MODEL_GATE.driftSample);
    expect(report.metrics.driftChanged).toBeGreaterThan(MODEL_GATE.driftMax);
    expect(report.metrics.savedUsd).toBeGreaterThan(0);
    expect(report.passed).toBe(false);
    expect(report.summary).toContain('the cache may be stale');
  });

  it('says plainly that it could not run without an API key, and asks nothing', async () => {
    const { answerer, asked } = fakeAnswerer(right, false);
    const report = await createModelReleaseGate({
      answerer,
      items: () => items,
      now: fixed,
    }).evaluate(input());
    expect(report).toMatchObject({ passed: false });
    expect(report.summary).toContain('no model API key');
    expect(asked).toEqual([]);
  });

  it('stops at the budget, and stops when a newer check replaced this one', async () => {
    const { answerer, asked } = fakeAnswerer(() => answer('answer', id(1), 2));
    const budget = await createModelReleaseGate({
      answerer,
      items: () => items,
      now: fixed,
      limits: { concurrency: 1 },
    }).evaluate(input());
    expect(budget.passed).toBe(false);
    expect(budget.summary).toContain(`budget ($${MODEL_GATE.budgetUsd})`);
    expect(asked).toHaveLength(2);
    const replaced = await createModelReleaseGate({
      answerer: fakeAnswerer(right).answerer,
      items: () => items,
      now: fixed,
      limits: { progressEvery: 1, concurrency: 1 },
    }).evaluate(input({ progress: (p) => Promise.resolve(p.done < 2) }));
    expect(replaced.passed).toBe(false);
    expect(replaced.summary).toBe('The check was replaced by a newer one');
    expect(replaced.metrics.cases).toBe(2);
  });
});

describe('the live-pipeline check: follow-ups (B5, parent card on screen)', () => {
  // refund → refund-late; password → refund-late as well (two parents); password → reset (one parent)
  const two: FaqReleaseSnapshot = {
    nodes: [
      node(1, 'refund'),
      node(2, 'refund-late', false),
      node(3, 'password'),
      node(4, 'reset', false),
    ],
    edges: [
      ...snapshot.edges,
      {
        parentId: id(3),
        childId: id(2),
        kind: 'follow_up',
        position: 1,
        labelEn: null,
        labelZh: null,
      },
      {
        parentId: id(3),
        childId: id(4),
        kind: 'follow_up',
        position: 0,
        labelEn: null,
        labelZh: null,
      },
    ],
    phrasings: [],
  };
  const lateItems: ReleaseEvalItem[] = [
    {
      id: 'l1',
      locale: 'en-GB',
      message: 'late one',
      expect: 'answer',
      faq: 'refund-late',
    },
    {
      id: 'l2',
      locale: 'zh-TW',
      message: '晚了',
      expect: 'answer',
      faq: 'refund-late',
    },
    {
      id: 'r1',
      locale: 'zh-CN',
      message: '重设',
      expect: 'answer',
      faq: 'reset',
    },
    {
      id: 'e1',
      locale: 'zh-CN',
      message: '退款',
      expect: 'answer',
      faq: 'refund',
    },
    { id: 'n1', locale: 'en-GB', message: 'homework', expect: 'no_match' },
  ];

  it('asks the dev questions of a child card with its parent on screen, the parent question as the earlier turn, and gives each edge its turn', () => {
    const followups = planFollowups({
      items: lateItems,
      snapshot: two,
      parents: null,
      changed: new Set(),
    });
    expect(followups.map((q) => [q.id, q.faqId, q.screen?.key])).toEqual([
      ['followup:l1', id(2), 'refund'],
      ['followup:l2', id(2), 'password'],
      ['followup:r1', id(4), 'password'],
    ]);
    expect(followups[0]).toMatchObject({
      set: 'followup',
      locale: 'en-GB',
      entryIds: [],
      screen: { nodeId: id(1), recentTurns: ['Q refund'] },
    });
    // zh-TW is sent as zh-CN, and the earlier turn is the parent's Chinese question
    expect(followups[1]).toMatchObject({
      locale: 'zh-CN',
      language: 'zh-TW',
      screen: { recentTurns: ['问 password'] },
    });
    // only the parents this release touched
    expect(
      planFollowups({
        items: lateItems,
        snapshot: two,
        parents: new Set([id(3)]),
        changed: new Set(),
      }).map((q) => q.id),
    ).toEqual(['followup:l2', 'followup:r1']);
  });

  it('a parent is asked again when it, a child, a child phrasing or one of its edges changed; nothing changed = nothing asked; no live version = all', () => {
    expect(followupParents(null, two)).toBeNull();
    expect(followupParents(two, two)).toEqual(new Set());
    const childEdited: FaqReleaseSnapshot = {
      ...two,
      nodes: two.nodes.map((n) =>
        n.id === id(4) ? { ...n, answerEn: 'new words' } : n,
      ),
    };
    expect(followupParents(two, childEdited)).toEqual(new Set([id(3)]));
    // refund-late has two parents: both see the change
    const phrasing: FaqReleaseSnapshot = {
      ...two,
      phrasings: [{ faqId: id(2), locale: 'en-GB', text: 'is it too late' }],
    };
    expect(followupParents(two, phrasing)).toEqual(new Set([id(1), id(3)]));
    const edgeMoved: FaqReleaseSnapshot = {
      ...two,
      edges: two.edges.map((e) =>
        e.childId === id(4) ? { ...e, position: 5 } : e,
      ),
    };
    expect(followupParents(two, edgeMoved)).toEqual(new Set([id(3)]));
    const edgeRemoved: FaqReleaseSnapshot = {
      ...two,
      edges: two.edges.filter((e) => e.childId !== id(4)),
    };
    expect(followupParents(two, edgeRemoved)).toEqual(new Set([id(3)]));
  });

  it('asks follow-ups with the card on screen, keeps them out of the single-question gate and slices, and tracks their rate', async () => {
    const singles = refunds(250);
    const { answerer, asked } = fakeAnswerer((message, a) =>
      a.screen !== null
        ? // the same answers on both versions: two of three follow-ups get a wrong card, tracked, not a fail
          answer('answer', message === 'late one' ? id(3) : id(4))
        : right(message),
    );
    const edited: FaqReleaseSnapshot = {
      ...two,
      nodes: two.nodes.map((n) =>
        n.id === id(2) ? { ...n, answerEn: 'new words' } : n,
      ),
    };
    const report = await createModelReleaseGate({
      answerer,
      items: () => [...singles, ...lateItems],
      now: fixed,
    }).evaluate(
      input({
        snapshot: edited,
        previous: { version: 1, evalReport: null, snapshot: two },
      }),
    );
    // refund-late changed: both of its parents are asked again, with every child question under them
    //（a sibling changes the candidates the model picks from）
    const onScreen = asked.filter((a) => a.screen !== null);
    expect(
      onScreen
        .filter((a) => a.version === 2)
        .map((a) => [a.message, a.screen])
        .sort(),
    ).toEqual([
      ['late one', id(1)],
      ['晚了', id(3)],
      ['重设', id(3)],
    ]);
    expect(onScreen.filter((a) => a.version === 1)).toHaveLength(3);
    expect(report.metrics).toMatchObject({
      followupCases: 3,
      followupWrong: 2,
      followupWrongRate: 0.6667,
      // the single-question numbers do not include follow-ups
      cases: 255,
      wrongCards: 0,
      confirmedWorse: 0,
    });
    const suites = new Map(report.suites?.map((s) => [s.id, s]));
    expect(suites.get('followup')).toMatchObject({
      status: 'track',
      n: 3,
      passed: true,
    });
    expect(suites.get('combined')?.n).toBe(255);
    expect(suites.get('language:en-GB')?.n).toBe(
      singles.filter((i) => i.locale === 'en-GB').length + 2,
    );
    expect(report.passed).toBe(true);
  });

  it('a follow-up newly wrong against the live version fails the check, and the miss names the card on screen', async () => {
    const { answerer } = fakeAnswerer((message, a) =>
      a.screen !== null && a.version === 2
        ? answer('answer', id(3))
        : a.screen !== null
          ? answer('answer', id(2))
          : right(message),
    );
    const edited: FaqReleaseSnapshot = {
      ...two,
      nodes: two.nodes.map((n) =>
        n.id === id(4) ? { ...n, answerEn: 'new words' } : n,
      ),
    };
    const report = await createModelReleaseGate({
      answerer,
      // l1 is asked under refund (not touched); l2 and r1 under password, whose child reset changed
      items: () => [...refunds(250), ...lateItems],
      now: fixed,
    }).evaluate(
      input({
        snapshot: edited,
        previous: { version: 1, evalReport: null, snapshot: two },
      }),
    );
    expect(report.passed).toBe(false);
    expect(report.summary).toContain('newly wrong against the live version');
    expect(report.misses[0]).toMatchObject({
      set: 'followup',
      why: 'newly_wrong',
      onScreen: 'password',
      live: 'answer:refund-late',
    });
  });
});
