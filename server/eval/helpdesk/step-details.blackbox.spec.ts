import { stepDetails } from './conversations';

type Ev = { type: string; data: Record<string, unknown> };
const turnEnd = (branch: unknown): Ev => ({
  type: 'turn/end',
  data: branch === undefined ? {} : { branch },
});
const retrieve = (
  candidates: unknown[],
  extra: { direct?: unknown; branch?: string } = {},
): Ev => ({
  type: 'step/end',
  data: {
    name: 'retrieve',
    ...(extra.branch !== undefined ? { branch: extra.branch } : {}),
    output: {
      candidates,
      ...(extra.direct !== undefined ? { direct: extra.direct } : {}),
    },
  },
});
const pick = (confidence: unknown, branch?: string): Ev => ({
  type: 'step/end',
  data: {
    name: 'pick_faq',
    ...(branch !== undefined ? { branch } : {}),
    args: { confidence },
  },
});

describe('stepDetails', () => {
  it('S1 branch thinking', () => {
    expect(stepDetails([turnEnd('thinking')]).branch).toBe('thinking');
  });
  it('S1 branch quick', () => {
    expect(stepDetails([turnEnd('quick')]).branch).toBe('quick');
  });
  it.each([['other'], [''], [5], [null], [undefined]])(
    'S1 other branch value %j -> null',
    (b) => {
      expect(stepDetails([turnEnd(b)]).branch).toBeNull();
    },
  );
  it('S1 no turn/end -> null', () => {
    expect(stepDetails([retrieve([{ id: 'a', score: 1 }])]).branch).toBeNull();
  });

  it('S2 quick branch counts only quick step/end events', () => {
    const r = stepDetails([
      retrieve([{ id: 'slow', score: 1 }], { direct: 'slow-d' }),
      pick('low'),
      retrieve([{ id: 'fast', score: 2 }], {
        branch: 'quick',
        direct: 'fast-d',
      }),
      pick('high', 'quick'),
      turnEnd('quick'),
    ]);
    expect(r.candidateIds).toEqual(['fast']);
    expect(r.direct).toBe('fast-d');
    expect(r.confidence).toBe('high');
  });
  it('S2 thinking branch ignores quick events', () => {
    const r = stepDetails([
      retrieve([{ id: 'fast', score: 2 }], {
        branch: 'quick',
        direct: 'fast-d',
      }),
      pick('high', 'quick'),
      retrieve([{ id: 'slow', score: 1 }], { direct: 'slow-d' }),
      pick('low'),
      turnEnd('thinking'),
    ]);
    expect(r.candidateIds).toEqual(['slow']);
    expect(r.direct).toBe('slow-d');
    expect(r.confidence).toBe('low');
  });
  it('S2 null branch counts events whose branch is not quick', () => {
    const r = stepDetails([
      retrieve([{ id: 'fast', score: 2 }], { branch: 'quick' }),
      retrieve([{ id: 'slow', score: 1 }], { branch: 'thinking' }),
      turnEnd(undefined),
    ]);
    expect(r.candidateIds).toEqual(['slow']);
  });
  it('S2 quick branch with only non-quick events yields nothing', () => {
    const r = stepDetails([
      retrieve([{ id: 'slow', score: 1 }], { direct: 'd' }),
      pick('high'),
      turnEnd('quick'),
    ]);
    expect(r.candidateIds).toEqual([]);
    expect(r.candidateScores).toEqual([]);
    expect(r.direct).toBeNull();
    expect(r.confidence).toBeNull();
  });
  it('S2 only step/end events count (not step/start)', () => {
    const r = stepDetails([
      {
        type: 'step/start',
        data: {
          name: 'retrieve',
          output: { candidates: [{ id: 'x', score: 1 }], direct: 'x' },
        },
      },
      {
        type: 'step/start',
        data: { name: 'pick_faq', args: { confidence: 'x' } },
      },
      turnEnd('thinking'),
    ]);
    expect(r.candidateIds).toEqual([]);
    expect(r.direct).toBeNull();
    expect(r.confidence).toBeNull();
  });

  it('S3 candidate ids and scores in order', () => {
    const r = stepDetails([
      retrieve([
        { id: 'a', score: 0.9, rerankScore: 0.8 },
        { id: 'b', score: 0.5 },
        { id: 'c', score: 0.1, rerankScore: 0 },
      ]),
      turnEnd('thinking'),
    ]);
    expect(r.candidateIds).toEqual(['a', 'b', 'c']);
    expect(r.candidateScores).toEqual([
      { id: 'a', score: 0.9, rerankScore: 0.8 },
      { id: 'b', score: 0.5 },
      { id: 'c', score: 0.1, rerankScore: 0 },
    ]);
    expect('rerankScore' in r.candidateScores[1]).toBe(false);
  });
  it('S3 missing or non-number score -> null', () => {
    const r = stepDetails([
      retrieve([
        { id: 'a' },
        { id: 'b', score: '0.5' },
        { id: 'c', score: null },
        { id: 'd', score: 0 },
      ]),
    ]);
    expect(r.candidateScores).toEqual([
      { id: 'a', score: null },
      { id: 'b', score: null },
      { id: 'c', score: null },
      { id: 'd', score: 0 },
    ]);
  });
  it('S3 non-number rerankScore is omitted', () => {
    const r = stepDetails([
      retrieve([
        { id: 'a', score: 1, rerankScore: '0.7' },
        { id: 'b', score: 1, rerankScore: null },
      ]),
    ]);
    expect(r.candidateScores).toEqual([
      { id: 'a', score: 1 },
      { id: 'b', score: 1 },
    ]);
    for (const s of r.candidateScores) expect('rerankScore' in s).toBe(false);
  });
  it('S3 entries without a string id are dropped', () => {
    const r = stepDetails([
      retrieve([
        { id: 'a', score: 1 },
        { id: 5, score: 2 },
        { score: 3 },
        null,
        { id: null, score: 4 },
        { id: 'b', score: 5 },
      ]),
    ]);
    expect(r.candidateIds).toEqual(['a', 'b']);
    expect(r.candidateScores.map((s) => s.id)).toEqual(['a', 'b']);
  });
  it('S3 other step names are ignored', () => {
    const r = stepDetails([
      {
        type: 'step/end',
        data: {
          name: 'other',
          output: { candidates: [{ id: 'z', score: 1 }], direct: 'z' },
        },
      },
    ]);
    expect(r.candidateIds).toEqual([]);
    expect(r.direct).toBeNull();
  });

  it('S4 direct string', () => {
    expect(stepDetails([retrieve([], { direct: 'card-1' })]).direct).toBe(
      'card-1',
    );
  });
  it.each([[5], [null], [{ id: 'x' }], [undefined]])(
    'S4 non-string direct %j -> null',
    (d) => {
      expect(
        stepDetails([retrieve([{ id: 'a', score: 1 }], { direct: d })]).direct,
      ).toBeNull();
    },
  );

  it('S5 confidence string from pick_faq', () => {
    expect(stepDetails([pick('high')]).confidence).toBe('high');
  });
  it.each([[5], [null], [undefined], [{}]])(
    'S5 non-string confidence %j -> null',
    (c) => {
      expect(stepDetails([pick(c)]).confidence).toBeNull();
    },
  );
  it('S5 pick_faq without args -> null', () => {
    expect(
      stepDetails([{ type: 'step/end', data: { name: 'pick_faq' } }])
        .confidence,
    ).toBeNull();
  });

  it('S6 no retrieve step -> empty lists and direct null', () => {
    const r = stepDetails([pick('high'), turnEnd('thinking')]);
    expect(r.candidateIds).toEqual([]);
    expect(r.candidateScores).toEqual([]);
    expect(r.direct).toBeNull();
    expect(r.confidence).toBe('high');
  });
  it('S6 empty log -> all empty / null', () => {
    expect(stepDetails([])).toEqual({
      candidateIds: [],
      candidateScores: [],
      direct: null,
      confidence: null,
      branch: null,
    });
  });
});
