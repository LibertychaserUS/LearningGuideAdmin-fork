import {
  EVAL_CACHE,
  createMemoryEvalCacheStore,
  emptyAskStats,
  evalCacheKey,
  measureSpend,
  replayLatency,
  runInEvalAsk,
  type EvalCacheMode,
} from '../../contracts/helpdesk-eval-cache';
import { cachedReranker, openRouterReranker, type Reranker } from './rerank';
import { createMemoryAgentEventLog } from './trace/agent-event.store';
import { RunTrace } from './trace/run-trace';
import { cachedStepRunner } from './workflow/cached-step-runner';
import type {
  AgentStepContext,
  AgentStepOutcome,
  AgentStepRunner,
  AgentStepSpec,
} from './workflow/engine';

/**
 * 发布前检查的分层结果缓存（contracts/helpdesk-eval-cache.ts）：模型步与精排两层。
 * 同样的输入只付一次钱；命中照原耗时等、可以被取消；只记完整的结果；不在检查的一问里 = 原样直通。
 */
const RUN = '0192eeee-0000-7000-8000-000000000020';

const SPEC: AgentStepSpec = {
  system: 'pick a card',
  prompt: 'forgot my password\n[1] reset password',
  tool: {
    name: 'pick_faq',
    description: 'pick',
    enumArgs: { faqId: ['1', 'none'] },
  },
  maxTokens: 200,
};

function context(signal = new AbortController().signal): AgentStepContext {
  return {
    trace: new RunTrace(RUN, createMemoryAgentEventLog()),
    step: 1,
    name: 'pick',
    signal,
    model: {
      provider: 'openrouter',
      model: 'test/cheap',
      apiKey: 'test-key-one',
      baseUrl: 'http://llm.test/v1',
    },
    traceparent: () => '00-0-0-01',
  };
}

/** 假的模型：每次调用都在链路里记一笔 0.001 美元的花费，按 reply 回。 */
function fakeRunner(
  reply: () => AgentStepOutcome = () => ({
    kind: 'called',
    args: { faqId: '1' },
    extras: { lists: {}, texts: { opening: 'hi' }, flags: {} },
  }),
) {
  const run = jest.fn((spec: AgentStepSpec, ctx: AgentStepContext) => {
    void spec;
    ctx.trace.emit('assistant/message', { costUsd: 0.001 });
    return Promise.resolve(reply());
  });
  return { runner: { run } as AgentStepRunner, run };
}

function inAsk<T>(
  store: ReturnType<typeof createMemoryEvalCacheStore> | null,
  mode: EvalCacheMode,
  fn: () => Promise<T>,
) {
  const stats = emptyAskStats();
  return runInEvalAsk({ store, mode, stats }, fn).then((value) => ({
    value,
    stats,
  }));
}

describe('the eval cache contract', () => {
  it('keys are stable across key order, differ by layer and version, and are 64 hex', () => {
    const a = evalCacheKey('step', { b: 1, a: [1, { y: 2, x: 1 }] });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(evalCacheKey('step', { a: [1, { x: 1, y: 2 }], b: 1 })).toBe(a);
    expect(evalCacheKey('rerank', { b: 1, a: [1, { y: 2, x: 1 }] })).not.toBe(
      a,
    );
    expect(evalCacheKey('step', { b: 2, a: [1, { y: 2, x: 1 }] })).not.toBe(a);
  });

  it('the memory store forgets entries after ttlDays', async () => {
    let now = 0;
    const store = createMemoryEvalCacheStore(() => now);
    await store.put('step', [
      { key: 'k', entry: { value: 1, latencyMs: 5, costUsd: 0.1 } },
    ]);
    expect((await store.get('step', ['k', 'other'])).get('k')).toEqual({
      value: 1,
      latencyMs: 5,
      costUsd: 0.1,
    });
    expect((await store.get('rerank', ['k'])).size).toBe(0);
    now = EVAL_CACHE.ttlDays * 86_400_000;
    expect((await store.get('step', ['k'])).size).toBe(0);
    await expect(store.prune?.()).resolves.toBe(1);
  });

  it('replays a latency and stops early when cancelled', async () => {
    jest.useFakeTimers();
    try {
      const done = replayLatency(1_000);
      jest.advanceTimersByTime(1_000);
      await expect(done).resolves.toBe(true);
      const controller = new AbortController();
      const cut = replayLatency(1_000, controller.signal);
      jest.advanceTimersByTime(300);
      controller.abort();
      await expect(cut).resolves.toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('measures the spend reported inside, and passes it to the outer measure', async () => {
    const outer = await measureSpend(async () => {
      const inner = await measureSpend(() => {
        const rerank = openRouterReranker({
          model: 'm',
          apiKey: 'test-key-one',
          baseUrl: 'http://llm.test/v1',
          fetch: () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  results: [{ index: 0, relevance_score: 0.5 }],
                  usage: { cost: 0.0002 },
                }),
              ),
            ),
        });
        return rerank('q', ['a']);
      });
      expect(inner.spent.rerank).toBeCloseTo(0.0002);
      return inner.value;
    });
    expect(outer.value).toEqual([0.5]);
    expect(outer.spent).toEqual({ embed: 0, rerank: 0.0002 });
  });
});

describe('cachedStepRunner (the step layer)', () => {
  it('outside a release check it passes straight through and never touches a cache', async () => {
    const { runner, run } = fakeRunner();
    const cached = cachedStepRunner(runner);
    await cached.run(SPEC, context());
    await cached.run(SPEC, context());
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('asks once for the same request, then replays it with the recorded cost saved', async () => {
    const store = createMemoryEvalCacheStore();
    const { runner, run } = fakeRunner();
    const cached = cachedStepRunner(runner);
    const first = await inAsk(store, 'use', () => cached.run(SPEC, context()));
    expect(first.stats.step).toEqual({ hits: 0, misses: 1, savedUsd: 0 });
    const second = await inAsk(store, 'use', () => cached.run(SPEC, context()));
    expect(run).toHaveBeenCalledTimes(1);
    expect(second.value).toEqual(first.value);
    expect(second.stats.step.hits).toBe(1);
    expect(second.stats.step.savedUsd).toBeCloseTo(0.001);
    // the key holds no API key: another key, same request = same entry
    const otherKey = context();
    otherKey.model = { ...otherKey.model, apiKey: 'test-key-two' };
    await inAsk(store, 'use', () => cached.run(SPEC, otherKey));
    expect(run).toHaveBeenCalledTimes(1);
    // another prompt (other candidates) or another model = a new request
    await inAsk(store, 'use', () =>
      cached.run({ ...SPEC, prompt: `${SPEC.prompt}\n[2] refund` }, context()),
    );
    const thinking = context();
    thinking.model = { ...thinking.model, thinking: 'low' };
    await inAsk(store, 'use', () => cached.run(SPEC, thinking));
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('a hit waits the recorded time, and a cancel during the wait is aborted like a real call', async () => {
    const store = createMemoryEvalCacheStore();
    const key = evalCacheKey('step', {
      spec: SPEC,
      model: {
        provider: 'openrouter',
        model: 'test/cheap',
        baseUrl: 'http://llm.test/v1',
        thinking: null,
      },
    });
    await store.put('step', [
      {
        key,
        entry: { value: { kind: 'no_call' }, latencyMs: 60_000, costUsd: 0 },
      },
    ]);
    const { runner, run } = fakeRunner();
    const controller = new AbortController();
    const pending = inAsk(store, 'use', () =>
      cachedStepRunner(runner).run(SPEC, context(controller.signal)),
    );
    setTimeout(() => controller.abort(), 20);
    await expect(pending).resolves.toMatchObject({
      value: { kind: 'aborted' },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('never stores errors or aborted calls; refresh asks again and replaces; bypass neither reads nor writes', async () => {
    const store = createMemoryEvalCacheStore();
    let answer: AgentStepOutcome = { kind: 'error', message: 'boom' };
    const { runner, run } = fakeRunner(() => answer);
    const cached = cachedStepRunner(runner);
    await inAsk(store, 'use', () => cached.run(SPEC, context()));
    answer = { kind: 'aborted' };
    await inAsk(store, 'use', () => cached.run(SPEC, context()));
    expect(store.rows.size).toBe(0);
    answer = { kind: 'called', args: { faqId: '1' } };
    await inAsk(store, 'use', () => cached.run(SPEC, context()));
    expect(store.rows.size).toBe(1);
    answer = { kind: 'called', args: { faqId: 'none' } };
    await inAsk(store, 'bypass', () => cached.run(SPEC, context()));
    const kept = await inAsk(store, 'use', () => cached.run(SPEC, context()));
    expect(kept.value).toEqual({ kind: 'called', args: { faqId: '1' } });
    const fresh = await inAsk(store, 'refresh', () =>
      cached.run(SPEC, context()),
    );
    expect(fresh.value).toEqual({ kind: 'called', args: { faqId: 'none' } });
    const replaced = await inAsk(store, 'use', () =>
      cached.run(SPEC, context()),
    );
    expect(replaced.value).toEqual({ kind: 'called', args: { faqId: 'none' } });
    // 3 real calls that failed or were stored + bypass + refresh
    expect(run).toHaveBeenCalledTimes(5);
  });

  it('a stored entry of the wrong shape counts as a miss', async () => {
    const store = createMemoryEvalCacheStore();
    const { runner, run } = fakeRunner();
    const cached = cachedStepRunner(runner);
    await inAsk(store, 'use', () => cached.run(SPEC, context()));
    for (const row of store.rows.values())
      row.value = { kind: 'called', args: { faqId: 7 } };
    await inAsk(store, 'use', () => cached.run(SPEC, context()));
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('cachedReranker (the rerank layer, one entry per query and card)', () => {
  function fakeReranker() {
    const calls: string[][] = [];
    const inner: Reranker = (query, documents) => {
      calls.push([...documents]);
      return Promise.resolve(documents.map((d) => d.length / 10));
    };
    return { inner, calls };
  }

  it('passes straight through outside a release check', async () => {
    const { inner, calls } = fakeReranker();
    const rerank = cachedReranker(inner, 'rr');
    await rerank('q', ['a']);
    await rerank('q', ['a']);
    expect(calls).toHaveLength(2);
  });

  it('only sends the cards it has not scored for this query, and keeps the order', async () => {
    const store = createMemoryEvalCacheStore();
    const { inner, calls } = fakeReranker();
    const rerank = cachedReranker(inner, 'rr');
    await inAsk(store, 'use', () => rerank('q', ['aa', 'bbbb']));
    const second = await inAsk(store, 'use', () =>
      rerank('q', ['ccc', 'aa', 'bbbb']),
    );
    expect(second.value).toEqual([0.3, 0.2, 0.4]);
    expect(calls).toEqual([['aa', 'bbbb'], ['ccc']]);
    const third = await inAsk(store, 'use', () =>
      rerank('q', ['bbbb', 'ccc', 'aa']),
    );
    expect(third.value).toEqual([0.4, 0.3, 0.2]);
    expect(third.stats.rerank.hits).toBe(1);
    expect(calls).toHaveLength(2);
    // another query or another model = new pairs
    await inAsk(store, 'use', () => rerank('other', ['aa']));
    await inAsk(store, 'use', () => cachedReranker(inner, 'rr2')('q', ['aa']));
    expect(calls).toHaveLength(4);
  });

  it('does not store a failed rerank', async () => {
    const store = createMemoryEvalCacheStore();
    const rerank = cachedReranker(() => Promise.resolve(null), 'rr');
    await expect(
      inAsk(store, 'use', () => rerank('q', ['a'])),
    ).resolves.toMatchObject({ value: null });
    expect(store.rows.size).toBe(0);
  });
});
