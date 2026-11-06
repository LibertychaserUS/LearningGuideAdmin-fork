import { createMemoryEvalCacheStore } from '../../contracts/helpdesk-eval-cache';
import type {
  HelpdeskQaCandidate,
  HelpdeskQaSource,
} from '../../contracts/helpdesk-qa';
import { createReleaseAnswerer } from './release-answerer';
import type {
  AgentStepContext,
  AgentStepOutcome,
  AgentStepSpec,
} from './workflow/engine';

/**
 * 发布前真流程抽样检查的答题器（契约 helpdesk-release-eval.ts）：候选来源钉在候选版本上（qaFor），
 * 按聊天面板的第一句问，回出了哪张卡；没有 key、出错 → error（不算答错）。模型是假的 runner。
 */
const id = (n: number) =>
  `0192dddd-0000-7000-8000-${String(n).padStart(12, '0')}`;

const RESET: HelpdeskQaCandidate = {
  id: id(1),
  category: 'account_technical',
  question: 'How do I reset my password?',
  answer: 'Use **Forgot password** on the sign-in page.',
  score: 2,
  type: 'answer',
  entry: true,
  blocks: [{ id: 'b1', text: 'Use **Forgot password** on the sign-in page.' }],
  optionOf: [],
  relation: 'search',
};

const ENV = {
  OPENROUTER_API_KEY: 'test-openrouter-key-local-only',
  OPENROUTER_BASE_URL: 'http://llm.test/v1',
  HELPDESK_SUGGEST_MODEL: 'test/cheap-model',
  HELPDESK_RERANK_MODEL: 'off',
};

function setup(
  reply: (spec: AgentStepSpec) => Promise<AgentStepOutcome>,
  env: NodeJS.ProcessEnv = ENV,
  cache?: ReturnType<typeof createMemoryEvalCacheStore>,
) {
  const pinned: { version: number; snapshot: unknown }[] = [];
  const qa: HelpdeskQaSource = {
    findCandidates: () => Promise.resolve([RESET]),
    findPublished: (faqId) =>
      Promise.resolve(faqId === RESET.id ? { ...RESET, score: 0 } : null),
    findPopular: () => Promise.resolve([]),
    releaseVersion: () => Promise.resolve(7),
  };
  const run = jest.fn((spec: AgentStepSpec, context: AgentStepContext) => {
    void context;
    return reply(spec);
  });
  const answerer = createReleaseAnswerer({
    qaFor: (version, snapshot) => {
      pinned.push({ version, snapshot });
      return qa;
    },
    runner: { run },
    env: () => env,
    ...(cache ? { cache } : {}),
  });
  return { answerer, pinned, run };
}

const called = (args: Record<string, string>): Promise<AgentStepOutcome> =>
  Promise.resolve({
    kind: 'called',
    args,
    extras: { lists: {}, texts: {}, flags: {} },
  });

describe('release answerer (live pipeline on a candidate release)', () => {
  it('pins the QA source to the candidate release and returns the card the user would see', async () => {
    const { answerer, pinned, run } = setup((spec) =>
      spec.tool.name === 'explain'
        ? called({ covered: 'no' })
        : called({ intent: 'question', faqId: RESET.id, confidence: 'sure' }),
    );
    expect(answerer.available()).toBe(true);
    expect(answerer.model()).toBe('test/cheap-model');
    const session = answerer.forRelease({
      version: 7,
      snapshot: { nodes: [] },
    });
    expect(pinned).toEqual([{ version: 7, snapshot: { nodes: [] } }]);
    const got = await session.ask({
      message: 'forgot my password',
      locale: 'en-GB',
    });
    // intent and covered go to the shared scoring (contracts/helpdesk-eval-scoring.ts)
    expect(got).toMatchObject({
      kind: 'answer',
      nodeId: RESET.id,
      intent: 'question',
      covered: null,
    });
    expect(run).toHaveBeenCalled();
    // every question is its own user: the per-user hourly limit never cuts a sample short
    for (let i = 0; i < 35; i += 1)
      expect(
        (await session.ask({ message: `password ${i}`, locale: 'en-GB' })).kind,
      ).toBe('answer');
  });

  it('a model that picks nothing is no card; a model error is an error, never a wrong card', async () => {
    const none = setup(() =>
      called({ intent: 'question', faqId: 'none', confidence: 'sure' }),
    );
    expect(
      (
        await none.answerer
          .forRelease({ version: 7, snapshot: {} })
          .ask({ message: 'something else', locale: 'zh-CN' })
      ).nodeId,
    ).toBeNull();
    const failing = setup(() =>
      Promise.resolve({ kind: 'error', message: 'boom' } as AgentStepOutcome),
    );
    expect(
      await failing.answerer
        .forRelease({ version: 7, snapshot: {} })
        .ask({ message: 'forgot my password', locale: 'en-GB' }),
    ).toMatchObject({ kind: 'error', nodeId: null, failure: 'error' });
  });

  it('with the stage cache, the same question on the same cards is asked of the model once and answered the same', async () => {
    const cache = createMemoryEvalCacheStore();
    const { answerer, run } = setup(
      () => called({ intent: 'question', faqId: RESET.id, confidence: 'sure' }),
      ENV,
      cache,
    );
    const session = answerer.forRelease({ version: 7, snapshot: {} });
    const first = await session.ask({
      message: 'forgot my password',
      locale: 'en-GB',
    });
    const calls = run.mock.calls.length;
    expect(first.cache?.step).toMatchObject({ hits: 0 });
    expect(first.cache?.step.misses).toBeGreaterThan(0);
    // a later check (another session on the same cards) pays nothing for it
    const again = await answerer
      .forRelease({ version: 8, snapshot: {} })
      .ask({ message: 'forgot my password', locale: 'en-GB' });
    expect(run.mock.calls.length).toBe(calls);
    expect(again).toMatchObject({
      kind: first.kind,
      nodeId: first.nodeId,
      intent: first.intent,
      spend: { model: 0, rerank: 0, embed: 0 },
    });
    expect(again.cache?.step).toMatchObject({ misses: 0 });
    // bypass asks again and leaves the cache as it was
    await answerer
      .forRelease({ version: 8, snapshot: {} })
      .ask({ message: 'forgot my password', locale: 'en-GB', cache: 'bypass' });
    expect(run.mock.calls.length).toBe(calls * 2);
  });

  it('is not available without an API key, and then answers nothing', async () => {
    const { answerer, run } = setup(() => called({}), {
      HELPDESK_RERANK_MODEL: 'off',
    });
    expect(answerer.available()).toBe(false);
    expect(
      await answerer
        .forRelease({ version: 7, snapshot: {} })
        .ask({ message: 'forgot my password', locale: 'en-GB' }),
    ).toMatchObject({ kind: 'error', failure: 'no_key' });
    expect(run).not.toHaveBeenCalled();
  });
});
