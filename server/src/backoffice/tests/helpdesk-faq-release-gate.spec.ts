import type {
  FaqSearch,
  ScoredFaq,
} from '../modules/helpdesk/faqs/faqRepository';
import {
  freezeNode,
  type FaqReleaseSnapshot,
} from '../modules/helpdesk/faqs/faqRelease';
import {
  createFaqReleaseGate,
  createRetrievalGate,
  releaseEvalCases,
  RETRIEVAL_GATE,
  type FaqReleaseGate,
} from '../modules/helpdesk/faqs/faqReleaseGate';

/**
 * 发布前的评测门（v5 Part G5，graph design §2.2）：缺省是免费的检索评测（入口 answer 节点的两种语言的
 * 问题 + 每种问法，检索那一版快照，recall@8 ≥ 95% 且比上一版低不超过 1 个点）；真模型评测在开关后面，
 * 测试里关着，开着却没配 → 不通过。检索用假仓库（真 SQL 见 helpdesk-faq-graph.pg.spec.ts）。
 */

function node(id: string, entry = true, type: 'answer' | 'choice' = 'answer') {
  return freezeNode({
    id,
    key: `k-${id}`,
    type,
    entry,
    category: 'other',
    popular: false,
    questionEn: `question ${id}`,
    answerEn: 'Answer.',
    questionZh: `问题 ${id}`,
    answerZh: '答案。',
    signals: [],
    keywords: [],
    version: 1,
    updatedAt: '2026-10-30T00:00:00.000Z',
  });
}

const snapshot: FaqReleaseSnapshot = {
  nodes: [node('a'), node('b'), node('c', false), node('d', true, 'choice')],
  edges: [],
  phrasings: [
    { faqId: 'a', locale: 'zh-TW', text: '問題甲' },
    { faqId: 'c', locale: 'en-GB', text: 'not an entry' },
  ],
};

/** 假检索：answers 里给每个查询返回的 id 顺序。 */
function fakeRepository(answers: (text: string) => string[]) {
  const searches: FaqSearch[] = [];
  return {
    searches,
    searchPublished(search: FaqSearch): Promise<ScoredFaq[]> {
      searches.push(search);
      return Promise.resolve(
        answers(search.text).map((id) => ({ id, score: 1 }) as ScoredFaq),
      );
    },
  };
}

const fixed = () => new Date('2026-10-30T12:00:00Z');

describe('FAQ release eval gate', () => {
  it('builds cases from entry answers: both questions and every phrasing (zh-TW searched as zh-CN)', () => {
    expect(
      releaseEvalCases(snapshot).map((c) => [
        c.nodeId,
        c.locale,
        c.source,
        c.text,
      ]),
    ).toEqual([
      ['a', 'en-GB', 'question', 'question a'],
      ['a', 'zh-CN', 'question', '问题 a'],
      ['b', 'en-GB', 'question', 'question b'],
      ['b', 'zh-CN', 'question', '问题 b'],
      ['a', 'zh-CN', 'phrasing', '問題甲'],
    ]);
  });

  it('passes when every case finds its node in the top 8 of that release, and searches that release only', async () => {
    const repository = fakeRepository((text) =>
      text.includes('b') ? ['x', 'b'] : ['a'],
    );
    const report = await createRetrievalGate(repository, fixed).evaluate({
      version: 7,
      snapshot,
      previous: null,
    });
    expect(report).toEqual({
      kind: 'retrieval',
      passed: true,
      summary: 'Retrieval eval passed: recall@8 100.0% over 5 cases',
      ranAt: '2026-10-30T12:00:00.000Z',
      metrics: { cases: 5, recallAt1: 0.6, recallAt8: 1 },
      misses: [],
    });
    expect(
      repository.searches.every((s) => s.release === 7 && s.limit === 8),
    ).toBe(true);
    expect(RETRIEVAL_GATE.recallAt8Min).toBe(0.95);
  });

  it('adds the regression cases staff accepted from the flywheel, labelled with their node; cases for nodes not retrievable in this release are counted as skipped', async () => {
    const repository = fakeRepository((text) =>
      text === '甲怎么办' ? ['b', 'a'] : text === 'lost' ? [] : ['a', 'b'],
    );
    const report = await createRetrievalGate(repository, fixed, {
      regressionCases: () =>
        Promise.resolve([
          { faqId: 'a', locale: 'zh-TW', text: '甲怎么办' },
          { faqId: 'b', locale: 'en-GB', text: 'lost' },
          // 不是入口（检索不到）/ 这一版没有的节点：跳过，不算错
          { faqId: 'c', locale: 'en-GB', text: 'x' },
          { faqId: 'gone', locale: 'zh-CN', text: 'y' },
          // a's own phrasing (問題甲) again, in simplified script: a leak, not asked
          { faqId: 'a', locale: 'zh-CN', text: '问题甲。' },
        ]),
    }).evaluate({ version: 3, snapshot, previous: null });
    expect(report.metrics).toMatchObject({
      cases: 7,
      regressionCases: 2,
      regressionSkipped: 2,
      regressionLeaked: 1,
    });
    expect(report.misses).toEqual([
      expect.objectContaining({
        nodeId: 'b',
        key: 'k-b',
        source: 'regression',
        text: 'lost',
      }),
    ]);
    expect(repository.searches.find((s) => s.text === '甲怎么办')?.locale).toBe(
      'zh-CN',
    );
  });

  it('fails below 95% recall@8, listing the misses', async () => {
    const report = await createRetrievalGate(
      fakeRepository((text) => (text === '问题 b' ? [] : ['a', 'b'])),
      fixed,
    ).evaluate({ version: 2, snapshot, previous: null });
    expect(report.passed).toBe(false);
    expect(report.metrics.recallAt8).toBe(0.8);
    expect(report.summary).toContain('recall@8 80.0% < 95%');
    expect(report.misses).toEqual([
      expect.objectContaining({ nodeId: 'b', locale: 'zh-CN', rank: null }),
    ]);
  });

  it('fails when recall@8 drops more than one point below the published release', async () => {
    const many: FaqReleaseSnapshot = {
      nodes: Array.from({ length: 50 }, (_, i) => node(`n${i}`)),
      edges: [],
      phrasings: [],
    };
    // 98 of 100 cases hit: 98%, above 95%, but 2 points below the previous 100%
    let misses = 0;
    const repository = fakeRepository((text) => {
      if (text.startsWith('问题') && misses < 2) {
        misses += 1;
        return [];
      }
      return [text.replace(/^question |^问题 /, '')];
    });
    const report = await createRetrievalGate(repository, fixed).evaluate({
      version: 3,
      snapshot: many,
      previous: {
        version: 2,
        evalReport: {
          kind: 'retrieval',
          passed: true,
          metrics: { recallAt8: 1 },
        },
      },
    });
    expect(report.metrics).toMatchObject({
      recallAt8: 0.98,
      previousRecallAt8: 1,
    });
    expect(report.passed).toBe(false);
    expect(report.summary).toContain('dropped from 100.0% (v2) to 98.0%');
  });

  it('after a rollback compares with the report of the release that was rolled back to', async () => {
    const many: FaqReleaseSnapshot = {
      nodes: Array.from({ length: 50 }, (_, i) => node(`n${i}`)),
      edges: [],
      phrasings: [],
    };
    let misses = 0;
    const repository = fakeRepository((text) => {
      if (text.startsWith('问题') && misses < 2) {
        misses += 1;
        return [];
      }
      return [text.replace(/^question |^问题 /, '')];
    });
    // the live release is a rollback: its own report has no metrics, its source's report has recall@8 100%
    const report = await createRetrievalGate(repository, fixed).evaluate({
      version: 4,
      snapshot: many,
      previous: {
        version: 3,
        evalReport: {
          kind: 'rollback',
          passed: true,
          metrics: {},
          sourceVersion: 1,
          sourceReport: {
            kind: 'combined',
            passed: true,
            metrics: {},
            parts: [
              { kind: 'retrieval', passed: true, metrics: { recallAt8: 1 } },
            ],
          },
        },
      },
    });
    expect(report.metrics).toMatchObject({
      recallAt8: 0.98,
      previousRecallAt8: 1,
    });
    expect(report.passed).toBe(false);
    expect(report.summary).toContain('dropped from 100.0% (v3) to 98.0%');
  });

  it('fails a release with no entry answers (an empty release would leave Portal with no chips and no answers)', async () => {
    const empty: FaqReleaseSnapshot = {
      nodes: [node('c', false), node('d', true, 'choice')],
      edges: [],
      phrasings: [],
    };
    const report = await createRetrievalGate(
      fakeRepository(() => []),
      fixed,
    ).evaluate({ version: 5, snapshot: empty, previous: null });
    expect(report.passed).toBe(false);
    expect(report.metrics.cases).toBe(0);
    expect(report.summary).toContain('no entry answers');
  });

  it('runs the model eval only behind the switch; switched on without a model eval it fails', async () => {
    const retrieval: FaqReleaseGate = createRetrievalGate(
      fakeRepository(() => ['a', 'b']),
      fixed,
    );
    const evaluateModel = jest.fn(() =>
      Promise.resolve({
        kind: 'model' as const,
        passed: true,
        summary: 'model ok',
        ranAt: 'x',
        metrics: {},
        misses: [],
      }),
    );
    const model: FaqReleaseGate = { evaluate: evaluateModel };
    const input = { version: 1, snapshot, previous: null };
    const off = await createFaqReleaseGate({
      retrieval,
      model,
      modelEnabled: false,
    }).evaluate(input);
    expect(off.kind).toBe('retrieval');
    expect(evaluateModel).not.toHaveBeenCalled();
    const on = await createFaqReleaseGate({
      retrieval,
      model,
      modelEnabled: true,
      now: fixed,
    }).evaluate(input);
    expect(on).toMatchObject({ kind: 'combined', passed: true });
    expect(on.parts?.map((p) => p.kind)).toEqual(['retrieval', 'model']);
    const missing = await createFaqReleaseGate({
      retrieval,
      modelEnabled: true,
      now: fixed,
    }).evaluate(input);
    expect(missing.passed).toBe(false);
    expect(missing.summary).toContain('no model eval is configured');
    // the default reads the switch from the environment, and the tests never turn it on
    expect(process.env.HELPDESK_RELEASE_MODEL_EVAL).toBeUndefined();
  });
});
