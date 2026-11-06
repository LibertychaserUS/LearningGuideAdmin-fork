import type {
  AgentEventEnvelope,
  JsonObject,
} from '../../../contracts/helpdesk-trace';
import { createMemoryAgentEventLog } from '../trace/agent-event.store';
import { RunTrace } from '../trace/run-trace';
import type { AgentStepContext, AgentStepSpec, ModelTarget } from './engine';
import {
  loadPi,
  FASTEST_ROUTING,
  OPENROUTER_ROUTING,
  openRouterRouting,
  openRouterSource,
  PiStepRunner,
  THINKING_TOKENS,
  type ModelSource,
} from './pi-step-runner';

/**
 * 一个 agent 步 = 一个原样的 pi-agent-core Agent，带四道闸：只给这一步的工具（beforeToolCall 白名单）、
 * 参数枚举锁定（pi 的 TypeBox 校验）、一步至多一个工具调用、finishTurn 一轮即止；期限到就 abort()。
 * 事件映射成 dsh 名字：request/context、request/header、assistant/message、tool/call、tool/result。
 * 真的 pi（ESM，--experimental-vm-modules），模型用 pi 自带的 faux provider；
 * OpenRouter 那条用假的 fetch 看真实请求体，不连网、不用真 key。
 */
const IDS = [
  '0192bbbb-0000-7000-8000-000000000001',
  '0192bbbb-0000-7000-8000-000000000002',
];
const SPEC: AgentStepSpec = {
  system: 'Call pick_faq once.',
  prompt: '{"enquiry":{"message":"reset my password"}}',
  tool: {
    name: 'pick_faq',
    description: 'Pick the FAQ that answers the enquiry, or none.',
    enumArgs: { faqId: [...IDS, 'none'] },
  },
  maxTokens: 80,
};
const TARGET: ModelTarget = {
  provider: 'openrouter',
  model: 'openai/gpt-4o-mini',
  apiKey: 'test-openrouter-key-local-only',
  baseUrl: 'http://llm.test/api/v1',
};
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01';
const RUN = '0192eeee-0000-7000-8000-000000000030';

type Faux = Awaited<ReturnType<typeof faux>>;
async function faux(tokensPerSecond?: number) {
  const pi = await loadPi();
  const handle = pi.ai.fauxProvider(tokensPerSecond ? { tokensPerSecond } : {});
  const models = pi.ai.createModels();
  models.setProvider(handle.provider);
  const source: ModelSource = () => ({ models, model: handle.getModel() });
  return { pi, handle, source };
}

async function runStep(
  f: Faux,
  options: { signal?: AbortSignal; spec?: AgentStepSpec } = {},
) {
  const log = createMemoryAgentEventLog();
  const trace = new RunTrace(RUN, log);
  const context: AgentStepContext = {
    trace,
    step: 2,
    name: 'pick_faq',
    signal: options.signal ?? new AbortController().signal,
    model: TARGET,
    traceparent: () => TRACEPARENT,
  };
  const outcome = await new PiStepRunner({ source: f.source }).run(
    options.spec ?? SPEC,
    context,
  );
  trace.emit('turn/end', { turn: 1, reason: 'test' });
  await trace.flush();
  const events = (await log.read(RUN)).filter((e) => e.type !== 'turn/end');
  return { outcome, events };
}

const types = (events: AgentEventEnvelope[]) => events.map((e) => e.type);
const of = (events: AgentEventEnvelope[], type: string) =>
  events.filter((e) => e.type === type).map((e) => e.data);

describe('PiStepRunner on pi-agent-core', () => {
  it('returns the validated pick and records the step in dsh event names', async () => {
    const f = await faux();
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage(
        [f.pi.ai.fauxToolCall('pick_faq', { faqId: IDS[1] }, { id: 'call_1' })],
        { stopReason: 'toolUse' },
      ),
      // never asked for: terminate + finishTurn end the step after one request
      f.pi.ai.fauxAssistantMessage('a second request'),
    ]);
    const { outcome, events } = await runStep(f);
    expect(outcome).toEqual({ kind: 'called', args: { faqId: IDS[1] } });
    expect(f.handle.state.callCount).toBe(1);
    expect(types(events)).toEqual([
      'request/context',
      'request/header',
      'assistant/message',
      'tool/call',
      'tool/result',
    ]);
    const [context] = of(events, 'request/context');
    expect(context).toMatchObject({ turn: 1, step: 2, provider: 'faux' });
    expect(of(events, 'request/header')).toEqual([
      { turn: 1, step: 2, reason: 'step', traceparent: TRACEPARENT },
    ]);
    const [reply] = of(events, 'assistant/message');
    expect(reply).toMatchObject({
      turn: 1,
      step: 2,
      stopReason: 'toolUse',
      toolCalls: 1,
    });
    expect(reply.usage).toEqual({
      inputTokens: expect.any(Number) as unknown,
      outputTokens: expect.any(Number) as unknown,
      cacheReadTokens: expect.any(Number) as unknown,
      reasoningTokens: expect.any(Number) as unknown,
    });
    expect(typeof reply.costUsd).toBe('number');
    expect(of(events, 'tool/call')).toEqual([
      {
        turn: 1,
        step: 2,
        callId: 'call_1',
        name: 'pick_faq',
        arguments: JSON.stringify({ faqId: IDS[1] }),
      },
    ]);
    expect(of(events, 'tool/result')).toEqual([
      {
        turn: 1,
        step: 2,
        callId: 'call_1',
        name: 'pick_faq',
        result: { faqId: IDS[1] },
      },
    ]);
  });

  it('passes "none" through for the template to decide', async () => {
    const f = await faux();
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage(
        [f.pi.ai.fauxToolCall('pick_faq', { faqId: 'none' })],
        {
          stopReason: 'toolUse',
        },
      ),
    ]);
    expect((await runStep(f)).outcome).toEqual({
      kind: 'called',
      args: { faqId: 'none' },
    });
  });

  it.each([
    [
      'an invented id',
      [
        {
          name: 'pick_faq',
          args: { faqId: '0192bbbb-0000-7000-8000-0000000000ff' },
        },
      ],
      ['invalid_arguments'],
    ],
    [
      'an extra argument',
      [{ name: 'pick_faq', args: { faqId: IDS[0], answer: 'free text' } }],
      ['invalid_arguments'],
    ],
    [
      'a missing argument',
      [{ name: 'pick_faq', args: {} }],
      ['invalid_arguments'],
    ],
    [
      'an unknown tool',
      [{ name: 'refund_order', args: { orderId: '1' } }],
      ['unknown_tool'],
    ],
    [
      'two calls',
      [
        { name: 'pick_faq', args: { faqId: IDS[0] } },
        { name: 'pick_faq', args: { faqId: IDS[1] } },
      ],
      ['too_many_calls', 'too_many_calls'],
    ],
    [
      'a valid call next to an unknown one',
      [
        { name: 'pick_faq', args: { faqId: IDS[0] } },
        { name: 'show_orders', args: {} },
      ],
      ['too_many_calls', 'unknown_tool'],
    ],
  ])(
    'counts %s as no call, with one request only',
    async (_name, calls, codes) => {
      const f = await faux();
      f.handle.setResponses([
        f.pi.ai.fauxAssistantMessage(
          calls.map((c, i) =>
            f.pi.ai.fauxToolCall(c.name, c.args as JsonObject, {
              id: `call_${i}`,
            }),
          ),
          { stopReason: 'toolUse' },
        ),
        f.pi.ai.fauxAssistantMessage(
          [f.pi.ai.fauxToolCall('pick_faq', { faqId: IDS[0] })],
          {
            stopReason: 'toolUse',
          },
        ),
      ]);
      const { outcome, events } = await runStep(f);
      expect(outcome).toEqual({ kind: 'no_call' });
      expect(f.handle.state.callCount).toBe(1);
      expect(of(events, 'tool/call').map((c) => c.name)).toEqual(
        calls.map((c) => c.name),
      );
      for (const c of of(events, 'tool/call'))
        if (codes[0] !== 'too_many_calls') expect(c.arguments).toBeUndefined();
      const results = of(events, 'tool/result');
      expect(results.map((r) => (r.error as JsonObject).code)).toEqual(codes);
      for (const r of results) {
        expect(r.result).toBeUndefined();
        expect((r.error as JsonObject).name).toBe('ToolError');
      }
    },
  );

  it('never stores model-echoed text from a rejected call (arguments or validation message)', async () => {
    const echo = 'my email is lena@example.com';
    const f = await faux();
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage(
        [f.pi.ai.fauxToolCall('pick_faq', { faqId: echo }, { id: 'call_x' })],
        { stopReason: 'toolUse' },
      ),
    ]);
    const { outcome, events } = await runStep(f);
    expect(outcome).toEqual({ kind: 'no_call' });
    expect(JSON.stringify(events)).not.toContain('lena@example.com');
    expect(of(events, 'tool/call')).toEqual([
      {
        turn: 1,
        step: 2,
        callId: 'call_x',
        name: 'pick_faq',
        rejectedArguments: {
          length: JSON.stringify({ faqId: echo }).length,
        },
      },
    ]);
    // dsh tool/result error is {name, code} only
    expect(of(events, 'tool/result')).toEqual([
      {
        turn: 1,
        step: 2,
        callId: 'call_x',
        name: 'pick_faq',
        error: { name: 'ToolError', code: 'invalid_arguments' },
      },
    ]);
  });

  it('records a call cut off by the token limit as truncated', async () => {
    const f = await faux();
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage(
        [f.pi.ai.fauxToolCall('pick_faq', { faqId: IDS[0] }, { id: 'call_t' })],
        { stopReason: 'length' },
      ),
    ]);
    const { outcome, events } = await runStep(f);
    expect(outcome).toEqual({ kind: 'no_call' });
    expect(of(events, 'tool/result')).toEqual([
      {
        turn: 1,
        step: 2,
        callId: 'call_t',
        name: 'pick_faq',
        error: { name: 'ToolError', code: 'truncated' },
      },
    ]);
  });

  it('keeps a model-made tool name only when it looks like an identifier', async () => {
    const f = await faux();
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage(
        [f.pi.ai.fauxToolCall('tell lena@example.com', {}, { id: 'call_n' })],
        { stopReason: 'toolUse' },
      ),
    ]);
    const { events } = await runStep(f);
    expect(JSON.stringify(events)).not.toContain('lena@example.com');
    expect(of(events, 'tool/call')[0]).toMatchObject({ name: 'invalid_name' });
    expect(of(events, 'tool/result')[0]).toMatchObject({
      name: 'invalid_name',
      error: { name: 'ToolError', code: 'unknown_tool' },
    });
  });

  it('counts a text answer as no call and keeps the text (learner-derived) on the message', async () => {
    const f = await faux();
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage('Reset it on the sign-in page.'),
    ]);
    const { outcome, events } = await runStep(f);
    expect(outcome).toEqual({ kind: 'no_call' });
    expect(of(events, 'assistant/message')[0]).toMatchObject({
      stopReason: 'stop',
      toolCalls: 0,
      text: 'Reset it on the sign-in page.',
    });
  });

  it('reports a provider error as an error', async () => {
    const f = await faux();
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage([], {
        stopReason: 'error',
        errorMessage: '429 rate limited upstream',
      }),
    ]);
    const { outcome, events } = await runStep(f);
    expect(outcome).toEqual({
      kind: 'error',
      message: '429 rate limited upstream',
    });
    const [reply] = of(events, 'assistant/message');
    expect(reply).toMatchObject({
      stopReason: 'error',
      error: { name: 'ProviderError', code: 'http_429' },
    });
    // provider error text can carry the request (moderation metadata): never stored
    expect(reply.errorMessage).toBeUndefined();
  });

  it.each([
    ['Provider finish_reason: content_filter', 'content_filter'],
    ['OpenRouter error (503): upstream busy', 'http_503'],
    ['socket hang up', 'provider_error'],
  ])('maps the provider error %j to the code %s', async (message, code) => {
    const f = await faux();
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage([], {
        stopReason: 'error',
        errorMessage: message,
      }),
    ]);
    const { events } = await runStep(f);
    expect(of(events, 'assistant/message')[0].error).toEqual({
      name: 'ProviderError',
      code,
    });
  });

  it('aborts the agent when the signal fires and returns at once', async () => {
    const f = await faux(5);
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage('a very long answer '.repeat(200)),
    ]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    const { outcome } = await runStep(f, { signal: controller.signal });
    expect(outcome).toEqual({ kind: 'aborted' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('does not call the model when the signal is already aborted', async () => {
    const f = await faux();
    const controller = new AbortController();
    controller.abort();
    const { outcome, events } = await runStep(f, { signal: controller.signal });
    expect(outcome).toEqual({ kind: 'aborted' });
    expect(f.handle.state.callCount).toBe(0);
    expect(events).toEqual([]);
  });
});

/**
 * v5（Part B / D / H）：pick_faq 多了可选的列表（答案块 id）与短句（opening / closing / reply），
 * explain 有必填的真 / 假（covered）。pi 原样校验；短句从不进日志，只记长度。
 */
describe('PiStepRunner v5 arguments (lists, short texts, flags)', () => {
  const V5: AgentStepSpec = {
    ...SPEC,
    tool: {
      ...SPEC.tool,
      enumArgs: { intent: ['question', 'greeting'], faqId: [...IDS, 'none'] },
      listArgs: { blocks: ['b1', 'b2', 'b3'], unused: [] },
      textArgs: { opening: 'One warm line.', reply: 'Small talk.' },
    },
  };
  const EXPLAIN: AgentStepSpec = {
    ...SPEC,
    tool: {
      name: 'explain',
      description: 'Explain the shown answer.',
      enumArgs: {},
      textArgs: { explanation: 'In simpler words.' },
      flagArgs: { covered: 'Does the answer say it?' },
    },
  };

  async function call(spec: AgentStepSpec, name: string, args: JsonObject) {
    const f = await faux();
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage(
        [f.pi.ai.fauxToolCall(name, args, { id: 'call_1' })],
        { stopReason: 'toolUse' },
      ),
    ]);
    return runStep(f, { spec });
  }

  it("returns lists and texts as extras, and logs only the texts' lengths", async () => {
    const opening = "Don't worry, lena@example.com:";
    const { outcome, events } = await call(V5, 'pick_faq', {
      intent: 'question',
      faqId: IDS[0],
      blocks: ['b2', 'b3'],
      opening,
    });
    expect(outcome).toEqual({
      kind: 'called',
      args: { intent: 'question', faqId: IDS[0] },
      extras: {
        lists: { blocks: ['b2', 'b3'] },
        texts: { opening },
        flags: {},
      },
    });
    expect(JSON.stringify(events)).not.toContain('lena@example.com');
    expect(of(events, 'tool/call')).toEqual([
      {
        turn: 1,
        step: 2,
        callId: 'call_1',
        name: 'pick_faq',
        arguments: JSON.stringify({
          intent: 'question',
          faqId: IDS[0],
          blocks: ['b2', 'b3'],
        }),
        texts: { opening: { length: [...opening].length } },
      },
    ]);
    expect(of(events, 'tool/result')[0].result).toEqual({
      intent: 'question',
      faqId: IDS[0],
      blocks: ['b2', 'b3'],
    });
  });

  it('accepts a call without the optional list and texts', async () => {
    const { outcome } = await call(V5, 'pick_faq', {
      intent: 'greeting',
      faqId: 'none',
    });
    expect(outcome).toEqual({
      kind: 'called',
      args: { intent: 'greeting', faqId: 'none' },
      extras: { lists: {}, texts: {}, flags: {} },
    });
  });

  it.each([
    ['a block id outside the enum', { blocks: ['b9'] }],
    ['a list argument whose enum is empty (not offered)', { unused: ['x'] }],
  ])('counts %s as no call', async (_name, patch) => {
    const { outcome, events } = await call(V5, 'pick_faq', {
      intent: 'question',
      faqId: IDS[0],
      ...(patch as JsonObject),
    });
    expect(outcome).toEqual({ kind: 'no_call' });
    expect(of(events, 'tool/call')[0].arguments).toBeUndefined();
  });

  it('gets a number as text from pi (the code guard then rejects the digits)', async () => {
    const { outcome, events } = await call(V5, 'pick_faq', {
      intent: 'question',
      faqId: IDS[0],
      opening: 42,
    });
    expect(outcome).toMatchObject({ extras: { texts: { opening: '42' } } });
    expect(of(events, 'tool/call')[0].texts).toEqual({
      opening: { length: 2 },
    });
  });

  it('returns a required flag, and a call without it is no call', async () => {
    const explanation = 'Only a few minutes.';
    expect(
      (await call(EXPLAIN, 'explain', { explanation, covered: true })).outcome,
    ).toEqual({
      kind: 'called',
      args: {},
      extras: { lists: {}, texts: { explanation }, flags: { covered: true } },
    });
    expect((await call(EXPLAIN, 'explain', { explanation })).outcome).toEqual({
      kind: 'no_call',
    });
  });
});

describe('PiStepRunner through the pi OpenRouter provider (fake fetch)', () => {
  function sse(chunks: unknown[]) {
    const body =
      chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') +
      'data: [DONE]\n\n';
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  const chunk = (delta: unknown, extra: Record<string, unknown> = {}) => ({
    id: 'gen-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'openai/gpt-4o-mini',
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  });

  async function call(
    respond: () => Response,
    model: ModelTarget = TARGET,
    spec: AgentStepSpec = SPEC,
  ) {
    const fetch = jest.fn((url: string | URL | Request, init?: RequestInit) => {
      void url;
      void init;
      return Promise.resolve(respond());
    });
    const log = createMemoryAgentEventLog();
    const trace = new RunTrace(RUN, log);
    const outcome = await new PiStepRunner({
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).run(spec, {
      trace,
      step: 2,
      name: 'pick_faq',
      signal: new AbortController().signal,
      model,
      traceparent: () => TRACEPARENT,
    });
    trace.emit('turn/end', { turn: 1, reason: 'test' });
    await trace.flush();
    return { outcome, fetch, events: await log.read(RUN) };
  }
  const picked = () =>
    sse([
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_t',
            type: 'function',
            function: {
              name: 'pick_faq',
              arguments: JSON.stringify({ faqId: IDS[0] }),
            },
          },
        ],
      }),
      {
        ...chunk({}),
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      },
    ]);
  const sentReasoning = (fetch: jest.Mock) =>
    (
      JSON.parse(
        (fetch.mock.calls[0] as [unknown, RequestInit])[1].body as string,
      ) as { reasoning?: unknown }
    ).reasoning;

  const sentMaxTokens = (fetch: jest.Mock) => {
    const body = JSON.parse(
      (fetch.mock.calls[0] as [unknown, RequestInit])[1].body as string,
    ) as { max_tokens?: number; max_completion_tokens?: number };
    return body.max_tokens ?? body.max_completion_tokens;
  };

  it.each([
    ['off', { effort: 'none' }, 0],
    ['low', { effort: 'low' }, 2_048],
    ['high', { effort: 'high' }, 16_384],
  ] as const)(
    'sends thinking %s as the OpenRouter reasoning effort, with room to think on top of the step limit, also for a model missing from the catalog',
    async (thinking, reasoning, room) => {
      // 思考的字也算在 max_tokens 里：不另给额度，选卡片的调用会被截断（2026-10-30 实测 low 档 23% 截断）
      // 档位与 pi 给 Anthropic 等的默认思考预算相同（medium 8192；DeepSeek 不收 medium 档）
      expect(THINKING_TOKENS).toEqual({
        off: 0,
        low: 2_048,
        medium: 8_192,
        high: 16_384,
      });
      expect(THINKING_TOKENS[thinking]).toBe(room);
      // gpt-4o-mini 在价目里（不会思考）；真正不在价目里的模型用 acme/brand-new-model
      for (const model of [
        'deepseek/deepseek-v4.1-flash',
        'acme/brand-new-model',
      ]) {
        const { outcome, fetch } = await call(picked, {
          ...TARGET,
          model,
          thinking,
        });
        expect(outcome).toEqual({ kind: 'called', args: { faqId: IDS[0] } });
        expect(sentReasoning(fetch)).toEqual(reasoning);
        expect(sentMaxTokens(fetch)).toBe(SPEC.maxTokens + room);
      }
    },
  );

  it('with thinking off sends no reasoning to a catalog model that cannot think (its providers would all be filtered out)', async () => {
    // 2026-11-02：qwen3-30b-a3b-instruct-2507 带 effort none + require_parameters → OpenRouter 404 No endpoints
    for (const model of [
      'qwen/qwen3-30b-a3b-instruct-2507',
      'mistralai/mistral-small-3.2-24b-instruct',
    ]) {
      const { outcome, fetch } = await call(picked, {
        ...TARGET,
        model,
        thinking: 'off',
      });
      expect(outcome).toEqual({ kind: 'called', args: { faqId: IDS[0] } });
      expect(sentReasoning(fetch)).toBeUndefined();
    }
  });

  it('asks OpenRouter for its cheapest providers that take every parameter we send, also for a model missing from the catalog', async () => {
    // owner 2026-10-31：只选最便宜（最快的几家贵 10 到 20 倍）；慢的由 6.3 秒切换兜住
    for (const model of ['deepseek/deepseek-v4.1-flash', TARGET.model]) {
      const { fetch } = await call(picked, {
        ...TARGET,
        model,
        thinking: 'high',
      });
      const body = JSON.parse(
        (fetch.mock.calls[0] as [unknown, RequestInit])[1].body as string,
      ) as { provider?: unknown };
      expect(body.provider).toEqual(OPENROUTER_ROUTING);
      expect(OPENROUTER_ROUTING).toEqual({
        sort: 'price',
        require_parameters: true,
      });
    }
  });

  it("for a step that asks for the fastest provider (only split_asks), sorts by latency under the model's catalog price; a model missing from the catalog stays on the cheapest", async () => {
    // owner 2026-11-06：拆问走最快的，设价格上限；其他步骤照旧只选最便宜
    const pi = await loadPi();
    const catalog = openRouterSource(pi, TARGET).model.cost;
    const fastest: AgentStepSpec = { ...SPEC, routing: 'fastest' };
    const sent = async (model: string, spec: AgentStepSpec) => {
      const { fetch } = await call(picked, { ...TARGET, model }, spec);
      return (
        JSON.parse(
          (fetch.mock.calls[0] as [unknown, RequestInit])[1].body as string,
        ) as { provider?: unknown }
      ).provider;
    };
    expect(await sent(TARGET.model, fastest)).toEqual({
      sort: 'latency',
      require_parameters: true,
      max_price: { prompt: catalog.input, completion: catalog.output },
    });
    expect(FASTEST_ROUTING).toEqual({
      sort: 'latency',
      require_parameters: true,
    });
    expect(await sent('acme/brand-new-model', fastest)).toEqual(
      OPENROUTER_ROUTING,
    );
    expect(await sent(TARGET.model, SPEC)).toEqual(OPENROUTER_ROUTING);
    // 目录价是 0（免费模型）也设不了上限：照旧最便宜
    const free = {
      ...openRouterSource(pi, TARGET).model,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    expect(openRouterRouting('fastest', free)).toEqual(OPENROUTER_ROUTING);
  });

  it('without a thinking setting turns thinking off for a catalog model and sends nothing for any other', async () => {
    // pi 的价目里 DeepSeek v4.1 flash 能思考：2026-10-30 之前的评测都是 effort none（思考关）
    const { fetch } = await call(picked, {
      ...TARGET,
      model: 'deepseek/deepseek-v4.1-flash',
    });
    expect(sentReasoning(fetch)).toEqual({ effort: 'none' });
    const other = await call(picked, {
      ...TARGET,
      model: 'acme/brand-new-model',
    });
    expect(sentReasoning(other.fetch)).toBeUndefined();
  });

  it('sends one OpenRouter chat request with the enum-locked tool, required tool choice and the traceparent', async () => {
    const { outcome, fetch, events } = await call(() =>
      sse([
        chunk({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_9',
              type: 'function',
              function: {
                name: 'pick_faq',
                arguments: JSON.stringify({ faqId: IDS[0] }),
              },
            },
          ],
        }),
        {
          ...chunk({}),
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 20,
            total_tokens: 1020,
          },
        },
      ]),
    );
    expect(outcome).toEqual({ kind: 'called', args: { faqId: IDS[0] } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url instanceof Request ? url.url : url.toString()).toBe(
      'http://llm.test/api/v1/chat/completions',
    );
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TARGET.apiKey}`);
    expect(headers.get('traceparent')).toBe(TRACEPARENT);
    // no pi attribution headers
    expect(headers.get('http-referer')).toBeNull();
    expect(headers.get('x-openrouter-title')).toBeNull();
    const body = JSON.parse(init?.body as string) as {
      max_completion_tokens?: number;
      max_tokens?: number;
      messages: unknown[];
      tools: {
        function: {
          name: string;
          parameters: { properties: { faqId: { enum: string[] } } };
        };
      }[];
    };
    expect(body).toMatchObject({
      model: 'openai/gpt-4o-mini',
      stream: true,
      temperature: 0,
      tool_choice: 'required',
    });
    expect(body.max_completion_tokens ?? body.max_tokens).toBe(80);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe('pick_faq');
    expect(body.tools[0].function.parameters.properties.faqId.enum).toEqual([
      ...IDS,
      'none',
    ]);
    expect(JSON.stringify(body.messages)).toContain('reset my password');
    // the key is never logged
    expect(JSON.stringify(events)).not.toContain(TARGET.apiKey);
    const reply = events.find((e) => e.type === 'assistant/message')?.data;
    expect(reply).toMatchObject({
      usage: {
        inputTokens: 1000,
        outputTokens: 20,
        cacheReadTokens: 0,
        reasoningTokens: 0,
      },
      stopReason: 'toolUse',
      model: 'openai/gpt-4o-mini',
    });
    // catalog price for gpt-4o-mini: $0.15 / $0.60 per million tokens
    expect(reply?.costUsd).toBeCloseTo((1000 * 0.15 + 20 * 0.6) / 1e6, 10);
    expect(
      events.find((e) => e.type === 'request/context')?.data,
    ).toMatchObject({
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      api: 'openai-completions',
    });
  });

  it.each([429, 500, 503])('does not retry a %s', async (status) => {
    const { outcome, fetch } = await call(
      () =>
        new Response(JSON.stringify({ error: { message: 'busy' } }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(outcome.kind).toBe('error');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps learner text from a provider error body out of the log', async () => {
    const { outcome, events } = await call(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'Input flagged',
              code: 403,
              metadata: {
                raw: 'flagged_input: reset my password',
                flagged_input: 'reset my password',
              },
            },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
    );
    expect(outcome.kind).toBe('error');
    expect(JSON.stringify(events)).not.toContain('reset my password');
    expect(
      events.find((e) => e.type === 'assistant/message')?.data.error,
    ).toEqual({ name: 'ProviderError', code: 'http_403' });
  });

  it('records the cost as unknown (null) for a model missing from the catalog', async () => {
    const fetch = jest.fn(() =>
      Promise.resolve(
        sse([
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_u',
                type: 'function',
                function: {
                  name: 'pick_faq',
                  arguments: JSON.stringify({ faqId: IDS[0] }),
                },
              },
            ],
          }),
          {
            ...chunk({}),
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0012 },
          },
        ]),
      ),
    );
    const log = createMemoryAgentEventLog();
    const trace = new RunTrace(RUN, log);
    await new PiStepRunner({
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).run(SPEC, {
      trace,
      step: 2,
      name: 'pick_faq',
      signal: new AbortController().signal,
      model: { ...TARGET, model: 'acme/brand-new-model' },
      traceparent: () => TRACEPARENT,
    });
    trace.emit('turn/end', { turn: 1, reason: 'test' });
    await trace.flush();
    const reply = (await log.read(RUN)).find(
      (e) => e.type === 'assistant/message',
    )?.data;
    expect(reply).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 10 },
      costUsd: null,
    });
  });

  it('uses any OpenRouter model id, also one missing from the catalog', async () => {
    const pi = await loadPi();
    const { model } = openRouterSource(pi, {
      ...TARGET,
      model: 'acme/brand-new-model',
    });
    expect(model).toMatchObject({
      id: 'acme/brand-new-model',
      provider: 'openrouter',
      api: 'openai-completions',
      baseUrl: TARGET.baseUrl,
    });
    const known = openRouterSource(pi, TARGET).model;
    expect(known.cost.input).toBeGreaterThan(0);
    expect(known.baseUrl).toBe(TARGET.baseUrl);
  });
});
