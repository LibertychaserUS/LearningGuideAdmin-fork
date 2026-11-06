import type {
  HelpdeskQaCandidate,
  HelpdeskQaSearch,
  HelpdeskQaSource,
} from '../../../contracts/helpdesk-qa';
import { createMemoryAgentEventLog } from '../trace/agent-event.store';
import { RunTrace } from '../trace/run-trace';
import { assistWorkflow, initialAssistState } from './assist-workflow';
import {
  runWorkflow,
  type AgentStepOutcome,
  type AgentStepSpec,
} from './engine';
import {
  askPool,
  asksOf,
  asksPicked,
  composeAsks,
  mayHaveSeveralAsks,
  MULTI_ASK,
  pickAsksSpec,
} from './multi-ask';

const id = (n: number) =>
  `0192eeee-1111-7000-8000-${String(n).padStart(12, '0')}`;
const node = (
  n: number,
  extra: Partial<HelpdeskQaCandidate> = {},
): HelpdeskQaCandidate => ({
  id: id(n),
  category: 'account_technical',
  question: `Question ${n}`,
  answer: `Answer ${n}`,
  score: 1,
  type: 'answer',
  entry: true,
  blocks: [{ id: 'b1', text: `Answer ${n}` }],
  optionOf: [],
  ...extra,
});

const called = (
  args: Record<string, string>,
  texts: Record<string, string> = {},
  lists: Record<string, string[]> = {},
): AgentStepOutcome => ({
  kind: 'called',
  args,
  extras: { lists, texts, flags: {} },
});

describe('mayHaveSeveralAsks (code-only pre-filter before the split call)', () => {
  it.each([
    'grace period 是什么意思 怎么补付',
    '直播课里怎么 Leave Session，离开后还能 rejoin 吗？',
    'How do I reset my password? Also my payment failed.',
    'Where do I change my email and how long does the link last',
    '订阅过期了 怎么续费 还能看哪些课',
    '能不能把邮箱换掉，还有我的语言改成英文，一起保存？',
  ])('lets through %s', (message) => {
    expect(mayHaveSeveralAsks(message)).toBe(true);
  });

  it.each([
    '账号邮箱怎么改',
    'reset password',
    'hi there',
    '忘记密码了',
    'I cannot see my course anymore',
  ])('keeps %s on the one-ask path', (message) => {
    expect(mayHaveSeveralAsks(message)).toBe(false);
  });
});

describe('asksOf (reading the split call)', () => {
  it('keeps two or three clean asks in order', () => {
    expect(
      asksOf(called({ count: '2' }, { ask1: ' A? ', ask2: 'B?' })),
    ).toEqual(['A?', 'B?']);
    expect(
      asksOf(called({ count: '3' }, { ask1: 'A', ask2: 'B', ask3: 'C' })),
    ).toEqual(['A', 'B', 'C']);
  });

  it('falls back to one ask on count 1, a failed call, an empty, long or duplicate ask', () => {
    expect(asksOf(called({ count: '1' }, { ask1: 'A', ask2: 'B' }))).toEqual(
      [],
    );
    expect(asksOf({ kind: 'no_call' })).toEqual([]);
    expect(asksOf({ kind: 'error', message: 'x' })).toEqual([]);
    expect(asksOf(called({ count: '2' }, { ask1: 'A' }))).toEqual([]);
    expect(
      asksOf(
        called(
          { count: '2' },
          { ask1: 'A', ask2: 'x'.repeat(MULTI_ASK.askMax + 1) },
        ),
      ),
    ).toEqual([]);
    expect(
      asksOf(called({ count: '2' }, { ask1: 'Same', ask2: 'same' })),
    ).toEqual([]);
  });
});

describe('askPool / pickAsksSpec / asksPicked', () => {
  const asks = [
    { n: 1, text: 'first' },
    { n: 3, text: 'third' },
  ];
  const candidates = [node(1), node(2), node(3)];

  it('pools the asks’ own cards and the whole message’s cards rank by rank, without repeats', () => {
    expect(
      askPool([
        [node(1), node(2)],
        [node(3), node(1)],
        [node(4), node(5), node(6)],
      ]).map((c) => c.id),
    ).toEqual([id(1), id(3), id(4), id(2), id(5), id(6)]);
    const many = Array.from({ length: 20 }, (_, i) => node(i + 1));
    expect(askPool([many, many])).toHaveLength(MULTI_ASK.poolMax);
  });

  it('gives each open ask the shared pool (+ none), a confidence and a block list', () => {
    const spec: AgentStepSpec = pickAsksSpec({
      message: 'm',
      asks,
      candidates,
    });
    expect(spec.tool.enumArgs).toEqual({
      intent: [
        'question',
        'own_account',
        'someone_else',
        'exception',
        'private_data',
        'instructions',
        'off_topic',
      ],
      card1: [id(1), id(2), id(3), 'none'],
      confidence1: ['sure', 'unsure'],
      card3: [id(1), id(2), id(3), 'none'],
      confidence3: ['sure', 'unsure'],
    });
    expect(Object.keys(spec.tool.listArgs ?? {})).toEqual([
      'blocks1',
      'blocks3',
    ]);
    expect(spec.tool.textArgs).toBeUndefined();
    const prompt = JSON.parse(spec.prompt) as {
      asks: unknown[];
      candidates: { id: string }[];
    };
    expect(prompt.asks).toEqual([
      { n: 1, text: 'first' },
      { n: 3, text: 'third' },
    ]);
    expect(prompt.candidates.map((c) => c.id)).toEqual([id(1), id(2), id(3)]);
  });

  it('takes a sure card from the pool; the same card may answer two asks; none, unsure, an unknown id or no call is no card', () => {
    const { intent, picks } = asksPicked(
      asks,
      candidates,
      {
        intent: 'question',
        card1: id(2),
        confidence1: 'sure',
        card3: id(2),
        confidence3: 'sure',
      },
      { lists: { blocks1: ['b1'] }, texts: {}, flags: {} },
    );
    expect(intent).toBe('question');
    expect(picks.get(1)).toEqual({ nodeId: id(2), blocks: ['b1'] });
    expect(picks.get(3)).toEqual({ nodeId: id(2), blocks: [] });
    const unsure = asksPicked(
      asks,
      candidates,
      {
        intent: 'question',
        card1: id(1),
        confidence1: 'unsure',
        card3: id(9),
        confidence3: 'sure',
      },
      undefined,
    );
    expect([...unsure.picks.values()]).toEqual([null, null]);
    const none = asksPicked(asks, candidates, null, undefined);
    expect(none.intent).toBeNull();
    expect([...none.picks.values()]).toEqual([null, null]);
  });
});

describe('composeAsks', () => {
  const nodes = new Map([1, 2, 3, 4].map((n) => [id(n), node(n)]));
  const of = (key: string) => nodes.get(key);

  it('keeps the asked order, shows a card once, and counts asks with no card', () => {
    const result = composeAsks(
      [
        { nodeId: id(2), blocks: [] },
        null,
        { nodeId: id(2), blocks: [] },
        { nodeId: id(1), blocks: [] },
      ],
      of,
    );
    expect(result.first?.node.id).toBe(id(2));
    expect(result.more.map((c) => c.faqId)).toEqual([id(1)]);
    expect(result.missed).toBe(1);
  });

  it('caps the reply at three cards and has no first card when nothing was found', () => {
    const four = composeAsks(
      [1, 2, 3, 4].map((n) => ({ nodeId: id(n), blocks: [] })),
      of,
    );
    expect([four.first?.node.id, ...four.more.map((c) => c.faqId)]).toEqual([
      id(1),
      id(2),
      id(3),
    ]);
    expect(composeAsks([null, null], of)).toEqual({
      first: null,
      more: [],
      missed: 2,
    });
  });
});

describe('assist workflow: an ask the reranker is sure of needs no model call', () => {
  it('picks every ask directly and composes without pick_asks', async () => {
    const reset = node(1, { rerankScore: 0.95 });
    const email = node(2, { rerankScore: 0.93 });
    const weak = node(3, { rerankScore: 0.4 });
    const byText: Record<string, HelpdeskQaCandidate[]> = {
      'How do I reset my password? And where do I change my email?': [weak],
      'How do I reset my password?': [reset, weak],
      'Where do I change my email?': [email, weak],
    };
    const qa: HelpdeskQaSource = {
      findCandidates: (search: HelpdeskQaSearch) =>
        Promise.resolve(byText[search.text] ?? []),
      findPublished: () => Promise.resolve(null),
      findPopular: () => Promise.resolve([]),
    };
    const run = jest.fn((spec: AgentStepSpec) =>
      Promise.resolve<AgentStepOutcome>(
        spec.tool.name === 'split_asks'
          ? called(
              { count: '2' },
              {
                ask1: 'How do I reset my password?',
                ask2: 'Where do I change my email?',
              },
            )
          : called({ intent: 'question', faqId: 'none', confidence: 'sure' }),
      ),
    );
    const trace = new RunTrace(id(99), createMemoryAgentEventLog());
    const { state, reason, trail } = await runWorkflow(
      assistWorkflow({
        qa,
        limit: 10,
        left: () => 5_000,
        direct: { score: 0.816, margin: 0.05 },
        multiAsk: true,
      }),
      initialAssistState({
        locale: 'en-GB',
        category: null,
        message: 'How do I reset my password? And where do I change my email?',
        context: {},
      }),
      {
        trace,
        runner: { run },
        model: {
          provider: 'openrouter',
          model: 'test/model',
          apiKey: 'test-key-local-only',
          baseUrl: 'http://llm.test/v1',
        },
        stepTimeoutMs: () => 3_000,
        traceparent: () =>
          '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
    );
    expect(reason).toBe('answered');
    expect(trail).toEqual([
      'retrieve',
      'pick_faq',
      'route',
      'retrieve_asks',
      'compose',
    ]);
    expect(run.mock.calls.map(([spec]) => spec.tool.name)).toEqual([
      'split_asks',
      'pick_faq',
    ]);
    expect(state.turn).toMatchObject({
      kind: 'answer',
      nodeId: reset.id,
      more: [{ faqId: email.id }],
    });
    expect(state.intent).toBe('question');
  });
});
