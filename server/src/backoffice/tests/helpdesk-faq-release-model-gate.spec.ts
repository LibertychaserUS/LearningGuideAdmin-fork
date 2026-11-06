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
  scoreModelAnswer,
  selectModelEvalCases,
  type ModelEvalCase,
  type ReleaseEvalItem,
} from '../modules/helpdesk/faqs/faqReleaseModelGate';

/**
 * 发布前的真流程抽样检查（owner 2026-11-03 选「抽样跑测试集」）：抽哪些问题、怎么判分、什么时候不通过。
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
): ReleaseEvalAnswer => ({
  kind,
  nodeId,
  costUsd,
  unpricedCalls: 0,
});

function fakeAnswerer(
  reply: (message: string) => ReleaseEvalAnswer,
  available = true,
) {
  const asked: { message: string; locale: string }[] = [];
  const answerer: ReleaseAnswerer = {
    available: () => available,
    model: () => 'google/gemma-4-31b-it',
    forRelease: () => ({
      ask: ({ message, locale }) => {
        asked.push({ message, locale });
        return Promise.resolve(reply(message));
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

const fixed = () => new Date('2026-11-03T10:00:00.000Z');

describe('the live-pipeline sample: which questions', () => {
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

  it('maps keys to this release, accepts the entry card of a follow-up, skips cards this release lacks and asks each text once', () => {
    const { cases, skipped } = selectModelEvalCases({
      items,
      snapshot,
      changed: new Set(),
      regression: [],
    });
    expect(skipped).toBe(1);
    expect(cases.map((c) => c.id).sort()).toEqual([
      'a1',
      'a2',
      'a3',
      'n1',
      's1',
    ]);
    const late = cases.find((c) => c.id === 'a2') as ModelEvalCase;
    // the follow-up's entry card is right too, counted on its own (viaEntry)
    expect(late).toMatchObject({
      locale: 'en-GB',
      faqId: id(2),
      acceptable: [],
      entryIds: [id(1)],
    });
    expect(cases.find((c) => c.id === 'a3') as ModelEvalCase).toMatchObject({
      faqId: id(3),
      acceptable: [id(1)],
      entryIds: [],
    });
    // zh-TW and mixed are asked the way Portal sends them (zh-CN)
    expect(cases.find((c) => c.id === 'a3')?.locale).toBe('zh-CN');
    const twice = selectModelEvalCases({
      items: [...items, { ...items[0], id: 'dup' }],
      snapshot,
      changed: new Set(),
      regression: [],
    });
    expect(twice.cases.filter((c) => c.message === '怎么退款')).toHaveLength(1);
  });

  it('takes a fixed sample (same questions every release), then every question about a changed card, then the regression cases', () => {
    const one = selectModelEvalCases({
      items,
      snapshot,
      changed: new Set(),
      regression: [],
      limits: { sampleSize: 2 },
    });
    const again = selectModelEvalCases({
      items,
      snapshot,
      changed: new Set(),
      regression: [],
      limits: { sampleSize: 2 },
    });
    expect(one.cases.map((c) => c.id)).toEqual(again.cases.map((c) => c.id));
    expect(one.cases).toHaveLength(2);
    const withChanged = selectModelEvalCases({
      items,
      snapshot,
      changed: new Set(['password']),
      regression: [
        { faqId: id(3), locale: 'zh-TW', text: '密碼又忘了' },
        { faqId: id(99), locale: 'en-GB', text: 'a card that is gone' },
      ],
      limits: { sampleSize: 0 },
    });
    expect(withChanged.cases.map((c) => [c.source, c.id])).toEqual([
      ['changed', 'a3'],
      ['regression', 'regression-1'],
    ]);
  });
});

describe('the live-pipeline sample: blind share', () => {
  it('takes half of the fixed sample from the blind set and fills the rest from S650', () => {
    const blind = items
      .filter((item) => item.faq !== 'not-in-this-library')
      .map((item) => ({
        ...item,
        id: `b-${item.id}`,
        message: `${item.message} ?`,
        set: 'blind' as const,
      }));
    const mixed = [
      ...items.map((item) => ({ ...item, set: 's650' as const })),
      ...blind,
    ];
    const { cases } = selectModelEvalCases({
      items: mixed,
      snapshot,
      changed: new Set(),
      regression: [],
      limits: { sampleSize: 4 },
    });
    expect(cases.filter((c) => c.id.startsWith('b-'))).toHaveLength(2);
    expect(cases.filter((c) => !c.id.startsWith('b-'))).toHaveLength(2);
    // 盲出题不够时由 S650 补满
    const few = selectModelEvalCases({
      items: [
        ...items.map((item) => ({ ...item, set: 's650' as const })),
        blind[0],
      ],
      snapshot,
      changed: new Set(),
      regression: [],
      limits: { sampleSize: 4 },
    });
    expect(few.cases.filter((c) => c.id.startsWith('b-'))).toHaveLength(1);
    expect(few.cases).toHaveLength(4);
  });
});

describe('the live-pipeline sample: scoring', () => {
  const [refund, late, , nomatch, small] = selectModelEvalCases({
    items,
    snapshot,
    changed: new Set(),
    regression: [],
    limits: { sampleSize: 99 },
  }).cases.sort((a, b) => a.id.localeCompare(b.id));
  it('counts another card as a wrong card, no card as not answered, and no answer at all as an error', () => {
    expect(refund.id).toBe('a1');
    expect(scoreModelAnswer(refund, answer('answer', id(1)))).toMatchObject({
      right: true,
      wrongCard: false,
    });
    expect(scoreModelAnswer(refund, answer('answer', id(3)))).toMatchObject({
      right: false,
      wrongCard: true,
    });
    expect(scoreModelAnswer(refund, answer('no_match'))).toMatchObject({
      right: false,
      wrongCard: false,
    });
    expect(scoreModelAnswer(refund, answer('error'))).toMatchObject({
      error: true,
      wrongCard: false,
    });
  });
  it('the entry card that leads to the labelled follow-up is right, counted on its own', () => {
    expect(late.id).toBe('a2');
    expect(scoreModelAnswer(late, answer('answer', id(1)))).toMatchObject({
      right: true,
      viaEntry: true,
      wrongCard: false,
    });
    expect(scoreModelAnswer(late, answer('answer', id(2)))).toMatchObject({
      right: true,
      viaEntry: false,
    });
  });
  it('any card on a no-match question is wrong; a card on small talk is only an extra card (R3)', () => {
    expect(nomatch.id).toBe('n1');
    expect(scoreModelAnswer(nomatch, answer('answer', id(1)))).toMatchObject({
      wrongCard: true,
    });
    // a follow-up question that says the answer does not cover it is right; one that claims it does is not
    expect(
      scoreModelAnswer(nomatch, {
        ...answer('clarify', id(1)),
        covered: false,
      }),
    ).toMatchObject({ right: true, wrongCard: false });
    expect(
      scoreModelAnswer(nomatch, { ...answer('clarify', id(1)), covered: true }),
    ).toMatchObject({ right: false, wrongCard: false });
    expect(small.id).toBe('s1');
    expect(scoreModelAnswer(small, answer('answer', id(1)))).toMatchObject({
      wrongCard: false,
      extraCard: true,
    });
    expect(scoreModelAnswer(small, answer('smalltalk'))).toMatchObject({
      right: true,
    });
  });
});

describe('the live-pipeline sample: pass or fail', () => {
  const right = (message: string) =>
    message === '怎么退款'
      ? answer('answer', id(1))
      : message === 'late refund?'
        ? answer('answer', id(1))
        : message === '忘記密碼'
          ? answer('answer', id(3))
          : message === '你好'
            ? answer('smalltalk')
            : answer('no_match');

  it('passes when the wrong-card rate is within 2%, reporting progress, cost and the model', async () => {
    const { answerer, asked } = fakeAnswerer(right);
    const progress: FaqReleaseEvalProgress[] = [];
    const prepared: number[] = [];
    const report = await createModelReleaseGate({
      answerer,
      items: () => items,
      prepare: (version) => Promise.resolve(prepared.push(version)),
      now: fixed,
      limits: { progressEvery: 2 },
    }).evaluate(
      input({ progress: (p) => Promise.resolve(Boolean(progress.push(p))) }),
    );
    expect(report).toMatchObject({ kind: 'model', passed: true });
    expect(report.summary).toContain('google/gemma-4-31b-it');
    expect(report.metrics).toMatchObject({
      cases: 5,
      wrongCards: 0,
      wrongRate: 0,
      errors: 0,
      skippedCases: 1,
      rightRate: 1,
    });
    expect(report.metrics.costUsd).toBeCloseTo(0.0005, 6);
    expect(asked).toHaveLength(5);
    expect(prepared).toEqual([2]);
    expect(progress[0]).toEqual({ stage: 'vectors', done: 0, total: 1 });
    expect(progress.at(-1)).toEqual({ stage: 'model', done: 5, total: 5 });
  });

  it('fails above 2% wrong cards and lists the misses with keys', async () => {
    const { answerer } = fakeAnswerer((message) =>
      message === '怎么退款' ? answer('answer', id(3)) : right(message),
    );
    const report = await createModelReleaseGate({
      answerer,
      items: () => items,
      now: fixed,
    }).evaluate(input());
    expect(report.passed).toBe(false);
    expect(report.summary).toContain('wrong card 20.0% > 2.0%');
    expect(report.misses).toEqual([
      {
        id: 'a1',
        source: 'sample',
        locale: 'zh-CN',
        text: '怎么退款',
        expected: 'refund',
        got: 'answer:password',
      },
    ]);
  });

  it('fails when the wrong-card rate rose more than 1 point above the live version', async () => {
    const many: ReleaseEvalItem[] = Array.from({ length: 60 }, (_, i) => ({
      id: `r${i}`,
      locale: 'en-GB',
      message: `refund ${i}`,
      expect: 'answer',
      faq: 'refund',
    }));
    let n = 0;
    const { answerer } = fakeAnswerer(() =>
      n++ === 0 ? answer('answer', id(3)) : answer('answer', id(1)),
    );
    const previous = {
      version: 1,
      evalReport: { parts: [{ kind: 'model', metrics: { wrongRate: 0 } }] },
    };
    const report = await createModelReleaseGate({
      answerer,
      items: () => many,
      now: fixed,
    }).evaluate(input({ previous }));
    expect(report.metrics).toMatchObject({
      wrongCards: 1,
      previousWrongRate: 0,
    });
    expect(report.passed).toBe(false);
    expect(report.summary).toContain('above the live version');
  });

  it('does not count a run where many questions got no answer (model or balance problem)', async () => {
    const { answerer } = fakeAnswerer(() => answer('error'));
    const report = await createModelReleaseGate({
      answerer,
      items: () => items,
      now: fixed,
    }).evaluate(input());
    expect(report.passed).toBe(false);
    expect(report.metrics.errors).toBe(5);
    expect(report.summary).toContain('got no answer');
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
    const { answerer, asked } = fakeAnswerer(() => answer('answer', id(1), 1));
    const budget = await createModelReleaseGate({
      answerer,
      items: () => items,
      now: fixed,
      limits: { concurrency: 1 },
    }).evaluate(input());
    expect(budget.passed).toBe(false);
    expect(budget.summary).toContain(`budget ($${MODEL_GATE.budgetUsd})`);
    expect(asked).toHaveLength(1);
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
