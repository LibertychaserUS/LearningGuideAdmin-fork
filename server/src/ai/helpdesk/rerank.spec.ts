import type {
  HelpdeskQaCandidate,
  HelpdeskQaSource,
} from '../../contracts/helpdesk-qa';
import {
  directPick,
  openRouterReranker,
  RERANK_LIMITS,
  rerankConfig,
  rerankedSource,
} from './rerank';

const card = (
  n: number,
  extra: Partial<HelpdeskQaCandidate> = {},
): HelpdeskQaCandidate => ({
  id: `0192dddd-0000-7000-8000-${String(n).padStart(12, '0')}`,
  category: 'account_technical',
  question: `Question ${n}`,
  answer: `Answer ${n}`,
  score: 10 - n,
  type: 'answer',
  ...extra,
});

const KEY = 'test-openrouter-key-local-only';

describe('rerankConfig (read each call; the tiered defaults unless set, off with "off" or without a key)', () => {
  it('uses the tiered defaults with only a key (owner 2026-11-03)', () => {
    expect(rerankConfig({ OPENROUTER_API_KEY: KEY })).toEqual({
      model: 'voyageai/rerank-2.5-lite',
      keep: 5,
      direct: { score: 0.84, margin: 0.05 },
    });
  });

  it('is off without a key or with HELPDESK_RERANK_MODEL=off', () => {
    expect(
      rerankConfig({ HELPDESK_RERANK_MODEL: 'voyageai/rerank-2.5-lite' }),
    ).toBeNull();
    expect(rerankConfig({})).toBeNull();
    expect(
      rerankConfig({ OPENROUTER_API_KEY: KEY, HELPDESK_RERANK_MODEL: ' OFF ' }),
    ).toBeNull();
  });

  it('reads model, keep and the direct thresholds; off means "keep all" / "never direct", bad values mean the defaults', () => {
    expect(
      rerankConfig({
        OPENROUTER_API_KEY: KEY,
        HELPDESK_RERANK_MODEL: ' voyageai/rerank-2.5-lite ',
        HELPDESK_RERANK_KEEP: '5',
        HELPDESK_RERANK_DIRECT: '0.83, 0.05',
      }),
    ).toEqual({
      model: 'voyageai/rerank-2.5-lite',
      keep: 5,
      direct: { score: 0.83, margin: 0.05 },
    });
    expect(
      rerankConfig({
        OPENROUTER_API_KEY: KEY,
        HELPDESK_RERANK_MODEL: 'cohere/rerank-v3',
        HELPDESK_RERANK_KEEP: 'off',
        HELPDESK_RERANK_DIRECT: 'OFF',
      }),
    ).toEqual({ model: 'cohere/rerank-v3', keep: null, direct: null });
    for (const [keep, direct] of [
      ['0', '1.5,0.1'],
      ['x', '0.8'],
      ['2.5', '0.8,'],
    ])
      expect(
        rerankConfig({
          OPENROUTER_API_KEY: KEY,
          HELPDESK_RERANK_MODEL: 'not a model id',
          HELPDESK_RERANK_KEEP: keep,
          HELPDESK_RERANK_DIRECT: direct,
        }),
      ).toEqual({
        model: 'voyageai/rerank-2.5-lite',
        keep: 5,
        direct: { score: 0.84, margin: 0.05 },
      });
  });
});

describe('openRouterReranker (POST {baseUrl}/rerank)', () => {
  const reply = (body: unknown, status = 200) =>
    jest.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status })),
    );

  it('sends the model, the clipped query and the documents with the key, and returns scores in document order', async () => {
    const fetch = reply({
      results: [
        { index: 1, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.2 },
      ],
    });
    const rerank = openRouterReranker({
      model: 'voyageai/rerank-2.5-lite',
      apiKey: KEY,
      baseUrl: 'http://llm.test/api/v1/',
      fetch,
    });
    const long = 'q'.repeat(RERANK_LIMITS.queryChars + 50);
    await expect(rerank(long, ['a', 'b'])).resolves.toEqual([0.2, 0.9]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://llm.test/api/v1/rerank');
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${KEY}`,
    );
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'voyageai/rerank-2.5-lite',
      query: 'q'.repeat(RERANK_LIMITS.queryChars),
      documents: ['a', 'b'],
    });
  });

  it.each([
    ['an HTTP error', reply({ error: { code: 404 } }, 404)],
    ['a missing score', reply({ results: [{ index: 0, relevance_score: 1 }] })],
    [
      'an index out of range',
      reply({
        results: [
          { index: 0, relevance_score: 1 },
          { index: 5, relevance_score: 1 },
        ],
      }),
    ],
    ['a network failure', jest.fn(() => Promise.reject(new Error('reset')))],
  ])(
    'returns null on %s (caller keeps the retrieval order)',
    async (_, fetch) => {
      const rerank = openRouterReranker({
        model: 'm',
        apiKey: KEY,
        baseUrl: 'http://llm.test/api/v1',
        fetch: fetch,
      });
      await expect(rerank('q', ['a', 'b'])).resolves.toBeNull();
    },
  );
});

describe('rerankedSource (only findCandidates changes)', () => {
  const found = [card(1), card(2), card(3)];
  const qa: HelpdeskQaSource = {
    findCandidates: () => Promise.resolve(found),
    findPublished: () => Promise.resolve(null),
    findPopular: () => Promise.resolve([]),
  };
  const search = { locale: 'en-GB', category: null, text: 'reset', limit: 10 };

  it('orders by rerank score (ties keep retrieval order), adds rerankScore and keeps at most keep cards', async () => {
    const rerank = jest.fn(() => Promise.resolve([0.1, 0.7, 0.7]));
    const ranked = rerankedSource(qa, rerank, 2);
    const out = await ranked.findCandidates(search);
    expect(out.map((c) => [c.id, c.rerankScore])).toEqual([
      [card(2).id, 0.7],
      [card(3).id, 0.7],
    ]);
    expect(rerank).toHaveBeenCalledWith('reset', [
      'Question 1\nAnswer 1',
      'Question 2\nAnswer 2',
      'Question 3\nAnswer 3',
    ]);
  });

  it('returns the retrieval result unchanged when the reranker fails', async () => {
    const ranked = rerankedSource(qa, () => Promise.resolve(null), 1);
    await expect(ranked.findCandidates(search)).resolves.toBe(found);
  });

  it('reranks the pool of retrieval candidates plus the vector top cards (deduplicated), asking for RERANK_LIMITS.vectorPool', async () => {
    const findVectorCandidates = jest.fn(() =>
      Promise.resolve([card(2, { score: 0.9 }), card(7, { score: 0.8 })]),
    );
    const rerank = jest.fn((query: string, docs: string[]) =>
      Promise.resolve(
        docs.map((d) => (d.startsWith('Question 7') ? 0.9 : 0.1)),
      ),
    );
    const ranked = rerankedSource({ ...qa, findVectorCandidates }, rerank, 2);
    const out = await ranked.findCandidates(search);
    expect(findVectorCandidates).toHaveBeenCalledWith({
      locale: 'en-GB',
      text: 'reset',
      limit: RERANK_LIMITS.vectorPool,
    });
    expect(rerank.mock.calls[0][1]).toHaveLength(4);
    expect(out.map((c) => c.id)).toEqual([card(7).id, card(1).id]);
  });

  it('a failing vector side leaves the retrieval candidates', async () => {
    const ranked = rerankedSource(
      { ...qa, findVectorCandidates: () => Promise.reject(new Error('x')) },
      (_, docs) => Promise.resolve(docs.map(() => 0.5)),
      null,
    );
    expect((await ranked.findCandidates(search)).map((c) => c.id)).toEqual(
      found.map((c) => c.id),
    );
  });

  it('with search.context, also asks vectors and the reranker with "previous → message" and keeps the higher score per card', async () => {
    const findVectorCandidates = jest.fn((q: { text: string }) =>
      Promise.resolve(q.text.includes('→') ? [card(8)] : []),
    );
    const rerank = jest.fn((query: string, docs: string[]) =>
      Promise.resolve(
        docs.map((d) =>
          query.includes('→')
            ? d.startsWith('Question 8')
              ? 0.9
              : 0.2
            : d.startsWith('Question 1')
              ? 0.6
              : 0.1,
        ),
      ),
    );
    const ranked = rerankedSource({ ...qa, findVectorCandidates }, rerank, 3);
    const out = await ranked.findCandidates({
      ...search,
      text: 'and WeChat Pay?',
      context: ' Which ways can I pay? ',
    });
    expect(findVectorCandidates.mock.calls.map((c) => c[0].text)).toEqual([
      'and WeChat Pay?',
      'Which ways can I pay? → and WeChat Pay?',
    ]);
    expect(rerank.mock.calls.map((c) => c[0])).toEqual([
      'and WeChat Pay?',
      'Which ways can I pay? → and WeChat Pay?',
    ]);
    expect(out.map((c) => [c.id, c.rerankScore])).toEqual([
      [card(8).id, 0.9],
      [card(1).id, 0.6],
      [card(2).id, 0.2],
    ]);
  });

  it('with search.context, one failing rerank call still ranks by the other', async () => {
    const rerank = jest.fn((query: string, docs: string[]) =>
      Promise.resolve(query.includes('→') ? null : docs.map(() => 0.5)),
    );
    const out = await rerankedSource(qa, rerank, null).findCandidates({
      ...search,
      context: 'before',
    });
    expect(out.map((c) => c.rerankScore)).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('directPick (give the top card without the model only when the reranker is sure)', () => {
  const direct = { score: 0.8, margin: 0.1 };
  it('picks the top answer card above the score with enough lead', () => {
    const top = card(1, { rerankScore: 0.9 });
    expect(directPick([top, card(2, { rerankScore: 0.7 })], direct)).toBe(top);
    expect(directPick([top], direct)).toBe(top);
  });

  it.each([
    ['no thresholds', [card(1, { rerankScore: 0.99 })], null],
    ['no rerank score', [card(1)], direct],
    ['score below', [card(1, { rerankScore: 0.79 })], direct],
    [
      'lead too small',
      [card(1, { rerankScore: 0.9 }), card(2, { rerankScore: 0.85 })],
      direct,
    ],
    [
      'a choice card on top',
      [card(1, { rerankScore: 0.95, type: 'choice' })],
      direct,
    ],
    ['no candidates', [], direct],
  ] as const)('returns null with %s', (_, list, thresholds) => {
    expect(directPick([...list], thresholds)).toBeNull();
  });
});
