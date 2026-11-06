import { createMemoryAgentEventLog } from '../trace/agent-event.store';
import { RunTrace } from '../trace/run-trace';
import {
  runWorkflow,
  type AgentStepRunner,
  type ModelTarget,
  type WorkflowTemplate,
} from './engine';

/**
 * 工作流层（我们写死的步骤表）：下一步永远由我们的代码按上一步校验过的结果决定，模型从不决定；
 * 每个 agent 步交给 runner（pi Agent）只做这一步；任何失败都结束为 error / timeout / aborted。
 */
const RUN = '0192eeee-0000-7000-8000-000000000020';
const MODEL: ModelTarget = {
  provider: 'openrouter',
  model: 'test/model',
  apiKey: 'test-key-local-only',
  baseUrl: 'http://llm.test/v1',
};

type State = { trail: string[]; pick?: string };

const template: WorkflowTemplate<State> = {
  name: 'demo',
  start: 'first',
  steps: {
    first: {
      kind: 'code',
      run: (state) =>
        Promise.resolve({
          state: { trail: [...state.trail, 'first'] },
          then: { next: 'choose' },
          output: { found: 2 },
        }),
    },
    choose: {
      kind: 'agent',
      prepare: () => ({
        system: 'pick one',
        prompt: '{"options":["a","b"]}',
        tool: {
          name: 'pick',
          description: 'Pick an option',
          enumArgs: { option: ['a', 'b', 'none'] },
        },
        maxTokens: 20,
      }),
      decide: (state, args) =>
        args && args.option !== 'none'
          ? { state: { ...state, pick: args.option }, then: { next: 'last' } }
          : { state, then: { end: 'no_match' } },
    },
    last: {
      kind: 'code',
      run: (state) =>
        Promise.resolve({
          state: { ...state, trail: [...state.trail, 'last'] },
          then: { end: 'answered' },
        }),
    },
  },
};

function setup(
  runner?: AgentStepRunner,
  signal = new AbortController().signal,
) {
  const log = createMemoryAgentEventLog();
  const trace = new RunTrace(RUN, log);
  const deps = {
    trace,
    runner,
    model: MODEL,
    signal,
    stepTimeoutMs: () => 3_000,
    traceparent: () =>
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  };
  const events = async () => {
    trace.emit('turn/end', { turn: 1, reason: 'test' });
    await trace.flush();
    return (await log.read(RUN)).filter((e) => e.type !== 'turn/end');
  };
  return { deps, events };
}

describe('runWorkflow', () => {
  it('v5: hands the extras (lists, short texts, flags) to decide, and logs the texts only by length', async () => {
    const seen: unknown[] = [];
    const withExtras: WorkflowTemplate<State> = {
      ...template,
      steps: {
        ...template.steps,
        choose: {
          ...(template.steps.choose as Extract<
            (typeof template.steps)[string],
            { kind: 'agent' }
          >),
          decide: (state, args, extras) => {
            seen.push(extras);
            return {
              state: { ...state, pick: args?.option },
              then: { end: 'answered' },
            };
          },
        },
      },
    };
    const run = jest.fn<
      ReturnType<AgentStepRunner['run']>,
      Parameters<AgentStepRunner['run']>
    >(() =>
      Promise.resolve({
        kind: 'called',
        args: { option: 'a' },
        extras: {
          lists: { blocks: ['b1'] },
          texts: { reply: 'Hi Lena!' },
          flags: { covered: true },
        },
      }),
    );
    const { deps, events } = setup({ run });
    await runWorkflow(withExtras, { trail: [] }, deps);
    expect(seen).toEqual([
      {
        lists: { blocks: ['b1'] },
        texts: { reply: 'Hi Lena!' },
        flags: { covered: true },
      },
    ]);
    const end = (await events()).find(
      (e) => e.type === 'step/end' && e.data.name === 'choose',
    );
    expect(end?.data).toMatchObject({
      args: { option: 'a' },
      lists: { blocks: ['b1'] },
      flags: { covered: true },
      texts: { reply: { length: 8 } },
    });
    expect(JSON.stringify(end)).not.toContain('Lena');
  });

  it('walks the step table the code chooses and records each step', async () => {
    const run = jest.fn<
      ReturnType<AgentStepRunner['run']>,
      Parameters<AgentStepRunner['run']>
    >(() => Promise.resolve({ kind: 'called', args: { option: 'b' } }));
    const { deps, events } = setup({ run });
    const result = await runWorkflow(template, { trail: [] }, deps);
    expect(result).toEqual({
      state: { trail: ['first', 'last'], pick: 'b' },
      reason: 'answered',
      trail: ['first', 'choose', 'last'],
    });
    const [spec, ctx] = run.mock.calls[0];
    expect(spec.tool.enumArgs).toEqual({ option: ['a', 'b', 'none'] });
    expect(ctx).toMatchObject({ step: 2, name: 'choose', model: MODEL });
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.traceparent()).toMatch(/^00-/);
    expect((await events()).map((e) => [e.type, e.data])).toEqual([
      ['step/start', { turn: 1, step: 1, name: 'first', kind: 'code' }],
      [
        'step/end',
        {
          turn: 1,
          step: 1,
          name: 'first',
          kind: 'code',
          then: { next: 'choose' },
          output: { found: 2 },
        },
      ],
      [
        'step/start',
        { turn: 1, step: 2, name: 'choose', kind: 'agent', tools: ['pick'] },
      ],
      [
        'step/end',
        {
          turn: 1,
          step: 2,
          name: 'choose',
          kind: 'agent',
          outcome: 'called',
          args: { option: 'b' },
          then: { next: 'last' },
        },
      ],
      ['step/start', { turn: 1, step: 3, name: 'last', kind: 'code' }],
      [
        'step/end',
        {
          turn: 1,
          step: 3,
          name: 'last',
          kind: 'code',
          then: { end: 'answered' },
        },
      ],
    ]);
  });

  it('tells the listener each step as it starts; a listener that throws changes nothing', async () => {
    const seen: string[] = [];
    const { deps } = setup({
      run: () => Promise.resolve({ kind: 'called', args: { option: 'a' } }),
    });
    const result = await runWorkflow(
      template,
      { trail: [] },
      {
        ...deps,
        onStep: (name) => {
          seen.push(name);
          throw new Error('listener gone');
        },
      },
    );
    expect(seen).toEqual(['first', 'choose', 'last']);
    expect(result).toMatchObject({ reason: 'answered', trail: seen });
  });

  it('labels every step of a side branch, so two runs of one request stay apart in the trace', async () => {
    // 聊天开思考时同一次推荐同时跑两路（思考、不思考的后备）：后备那一路的步骤带 branch
    const { deps, events } = setup({
      run: () => Promise.resolve({ kind: 'called', args: { option: 'a' } }),
    });
    await runWorkflow(template, { trail: [] }, { ...deps, branch: 'quick' });
    const steps = (await events()).filter((e) => e.type.startsWith('step/'));
    expect(steps).toHaveLength(6);
    expect(steps.map((e) => e.data.branch)).toEqual(Array(6).fill('quick'));
  });

  it('lets the template decide on no tool call', async () => {
    const { deps } = setup({ run: () => Promise.resolve({ kind: 'no_call' }) });
    await expect(
      runWorkflow(template, { trail: [] }, deps),
    ).resolves.toMatchObject({
      reason: 'no_match',
    });
  });

  it('ends as error when the step fails, whatever the template would say', async () => {
    const { deps, events } = setup({
      run: () => Promise.resolve({ kind: 'error', message: '502' }),
    });
    await expect(
      runWorkflow(template, { trail: [] }, deps),
    ).resolves.toMatchObject({
      reason: 'error',
    });
    expect((await events()).at(-1)?.data).toMatchObject({
      outcome: 'error',
      then: { end: 'error' },
    });
  });

  it('ends as timeout when the step runs past its time, even if the runner never settles', async () => {
    let signal: AbortSignal | undefined;
    const { deps } = setup({
      run: (_spec, context) => {
        signal = context.signal;
        return new Promise(() => undefined);
      },
    });
    const started = Date.now();
    await expect(
      runWorkflow(
        template,
        { trail: [] },
        { ...deps, stepTimeoutMs: () => 20 },
      ),
    ).resolves.toMatchObject({ reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(signal?.aborted).toBe(true);
  });

  it('computes the step time when the step starts', async () => {
    const stepTimeoutMs = jest.fn(() => 3_000);
    const { deps } = setup({ run: () => Promise.resolve({ kind: 'no_call' }) });
    await runWorkflow(template, { trail: [] }, { ...deps, stepTimeoutMs });
    expect(stepTimeoutMs).toHaveBeenCalledTimes(1);
  });

  it('ends as aborted when the caller goes away mid-step', async () => {
    const controller = new AbortController();
    const { deps } = setup(
      { run: () => new Promise(() => undefined) },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 20);
    await expect(
      runWorkflow(template, { trail: [] }, deps),
    ).resolves.toMatchObject({ reason: 'aborted' });
  });

  it('treats a runner that reports aborted as timed out when the caller is still there', async () => {
    const { deps } = setup({ run: () => Promise.resolve({ kind: 'aborted' }) });
    await expect(
      runWorkflow(template, { trail: [] }, deps),
    ).resolves.toMatchObject({ reason: 'timeout' });
  });

  it('does not start an agent step once the caller has gone', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = jest.fn();
    const { deps } = setup({ run }, controller.signal);
    await expect(
      runWorkflow(template, { trail: [] }, deps),
    ).resolves.toMatchObject({ reason: 'aborted' });
    expect(run).not.toHaveBeenCalled();
  });

  it('ends as error on an unknown step, a missing runner, or a loop past the table size', async () => {
    const { deps } = setup();
    await expect(
      runWorkflow({ ...template, start: 'nowhere' }, { trail: [] }, deps),
    ).resolves.toMatchObject({ reason: 'error' });
    await expect(
      runWorkflow(template, { trail: [] }, deps),
    ).resolves.toMatchObject({
      reason: 'error',
    });
    const loop: WorkflowTemplate<State> = {
      name: 'loop',
      start: 'again',
      steps: {
        again: {
          kind: 'code',
          run: (state) => Promise.resolve({ state, then: { next: 'again' } }),
        },
      },
    };
    const looping = setup();
    await expect(
      runWorkflow(loop, { trail: [] }, looping.deps),
    ).resolves.toMatchObject({
      reason: 'error',
    });
    expect(
      (await looping.events()).filter((e) => e.type === 'step/start'),
    ).toHaveLength(1);
  });

  describe('a model call inside a code step (multi-ask: split while retrieving)', () => {
    const splitSpec = {
      system: 'split',
      prompt: '{"message":"a and b"}',
      tool: {
        name: 'split_asks',
        description: 'Split',
        enumArgs: { count: ['1', '2'] },
        textArgs: { ask1: 'first', ask2: 'second' },
      },
      maxTokens: 50,
    };
    const parallel: WorkflowTemplate<State> = {
      name: 'parallel',
      start: 'retrieve',
      steps: {
        retrieve: {
          kind: 'code',
          async run(state, context) {
            const [found, outcome] = await Promise.all([
              Promise.resolve(3),
              context.agent('split_asks', splitSpec, { timeoutMs: 1_000 }),
            ]);
            return {
              state: { ...state, pick: outcome.kind },
              then: { end: 'answered' },
              output: { found },
            };
          },
        },
      },
    };

    it('records the call as its own agent step under the code step, texts only by length', async () => {
      const { deps, events } = setup({
        run: (_spec, context) => {
          expect(context.name).toBe('split_asks');
          return Promise.resolve({
            kind: 'called',
            args: { count: '2' },
            extras: {
              lists: {},
              texts: { ask1: 'how do I change my email', ask2: 'refund?' },
              flags: {},
            },
          });
        },
      });
      const result = await runWorkflow(parallel, { trail: [] }, deps);
      expect(result).toMatchObject({
        reason: 'answered',
        trail: ['retrieve'],
        state: { pick: 'called' },
      });
      const steps = (await events()).map((e) => [e.type, e.data]);
      expect(steps).toEqual([
        ['step/start', { turn: 1, step: 1, name: 'retrieve', kind: 'code' }],
        [
          'step/start',
          {
            turn: 1,
            step: 2,
            name: 'split_asks',
            kind: 'agent',
            tools: ['split_asks'],
            parent: 1,
          },
        ],
        [
          'step/end',
          {
            turn: 1,
            step: 2,
            name: 'split_asks',
            kind: 'agent',
            parent: 1,
            outcome: 'called',
            args: { count: '2' },
            lists: {},
            flags: {},
            texts: { ask1: { length: 24 }, ask2: { length: 7 } },
          },
        ],
        [
          'step/end',
          {
            turn: 1,
            step: 1,
            name: 'retrieve',
            kind: 'code',
            then: { end: 'answered' },
            output: { found: 3 },
          },
        ],
      ]);
    });

    it('gives the code step the timeout as an outcome instead of ending the run', async () => {
      const { deps } = setup({ run: () => new Promise(() => undefined) });
      const started = Date.now();
      const result = await runWorkflow(
        parallel,
        { trail: [] },
        { ...deps, stepTimeoutMs: () => 30 },
      );
      expect(result).toMatchObject({
        reason: 'answered',
        state: { pick: 'aborted' },
      });
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('reports a missing runner as an error outcome', async () => {
      const { deps } = setup();
      await expect(
        runWorkflow(parallel, { trail: [] }, deps),
      ).resolves.toMatchObject({
        reason: 'answered',
        state: { pick: 'error' },
      });
    });
  });
});
