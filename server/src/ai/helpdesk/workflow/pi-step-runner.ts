import type {
  AgentTool,
  BeforeToolCallResult,
} from '@earendil-works/pi-agent-core' with { 'resolution-mode': 'import' };
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };

import type { JsonObject } from '../../../contracts/helpdesk-trace';
import type {
  AgentCallExtras,
  AgentStepContext,
  AgentStepOutcome,
  AgentStepRunner,
  AgentStepSpec,
  ModelTarget,
  ThinkingSetting,
} from './engine';

/**
 * agent 步的运行时：@earendil-works/pi-agent-core 的 Agent，原样使用（不打补丁、不 fork）。
 * pi 只发 ESM，这里用真正的 import() 加载（server 是 nodenext 的 CommonJS）；单测可换 source。
 *
 * 闸：只给这一步的工具，参数是 StringEnum（pi 的 TypeBox 校验）；beforeToolCall 白名单 + 一步至多
 * 一个调用；工具结果 terminate:true，且 finishTurn 一律 end（一轮、一次请求）；signal 一到 abort()；
 * 不重试（maxRetries 0），能要求就要求必须调工具（tool_choice required）；不发 pi 的署名头。
 *
 * 事件（dsh 名字，一个订阅者）：请求发出前 request/context + request/header（含 traceparent，
 * 从不含 key 或鉴权头）；message_end → assistant/message（usage、costUsd = pi usage.cost.total，
 * 模型不在 pi 的价目里时为 null（未知，不是免费）、stopReason，出错时 error {name, code}）；
 * tool_execution_start → tool/call（arguments 为模型给的参数 JSON）；tool_execution_end →
 * tool/result（失败时 error {name, code}）。step/start、step/end 由工作流写
 * （每个 agent 步正好是 pi 的一个 turn，code 步也要有）。
 *
 * 模型可能把学员原文塞进被拒的调用或 provider 的报错（审核元数据带原文）：这些只记形状——
 * 被拒的参数只记长度（rejectedArguments），不像标识符的工具名记 invalid_name，pi 的校验文字与
 * provider 的报错文字一律不记，只记 code。日志里的学员原文因此只在 LEARNER_TEXT_FIELDS 里。
 */
// 依次加载：共用 typebox 等依赖，并发 import() 在 Jest 的 ESM 加载器里会撞上链接竞争
async function importPi() {
  const core = await import('@earendil-works/pi-agent-core');
  const ai = await import('@earendil-works/pi-ai');
  const openrouter = await import('@earendil-works/pi-ai/providers/openrouter');
  return { core, ai, openrouter };
}
export type PiModules = Awaited<ReturnType<typeof importPi>>;

let loading: Promise<PiModules> | undefined;

/** 加载一次 pi（失败下次再试）。 */
export function loadPi(): Promise<PiModules> {
  loading ??= importPi();
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}

export type StreamSource = {
  streamSimple(
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
};
export type ModelSource = (
  pi: PiModules,
  target: ModelTarget,
  routing?: AgentStepSpec['routing'],
) => {
  models: StreamSource;
  model: Model<Api>;
  /** model.cost 是真价格（缺省 true）；false 时费用未知，costUsd 记 null。 */
  priced?: boolean;
};

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * OpenRouter 的 provider 路由：先用最便宜的、且收下我们发的全部参数（工具、reasoning）的 provider。
 * 2026-10-31 owner 选了「只选最便宜」：按吞吐排时最快的几家比最便宜的贵 10 到 20 倍（3,499 轮实花约
 * 5.4 美元，按目录价只记 0.7 美元）；最便宜的慢一些（九成 4.5 秒内），慢的由 6.3 秒切换兜住。
 * 只写排序规则，不写 provider 名字（模型任意）。按价格排时目录价接近实付，costUsd 也就接近真花费。
 */
export const OPENROUTER_ROUTING = {
  sort: 'price',
  require_parameters: true,
} as const;

/**
 * spec.routing 'fastest'（只有拆问用，owner 2026-11-06）：按首字延迟排，单价不超过模型的目录价
 * （OpenRouter max_price，美元 / 百万 token；不高于目录价，costUsd 仍是上限）。2026-11-06 同一批句子经本代码
 * 各 200 次拆问实测：中位 2.3 → 1.3 秒，九成 5.9 → 3.0 秒，超过 2.5 秒拆问时限的 45% → 14%；直连另测 360 次
 * 费用约 +6%。价目外的模型没有目录价、设不了上限：照旧最便宜。
 */
export const FASTEST_ROUTING = {
  sort: 'latency',
  require_parameters: true,
} as const;

export function openRouterRouting(
  routing: AgentStepSpec['routing'],
  known: Model<Api> | undefined,
) {
  const cost = known?.cost;
  return routing === 'fastest' && cost && cost.input > 0 && cost.output > 0
    ? {
        ...FASTEST_ROUTING,
        max_price: { prompt: cost.input, completion: cost.output },
      }
    : { ...OPENROUTER_ROUTING };
}
let openRouterModels: ReturnType<PiModules['ai']['createModels']> | undefined;

/**
 * pi-ai 的 OpenRouter provider。模型 id 随 HELPDESK_SUGGEST_MODEL 任意：目录里有就用目录的价格
 * （openai-completions 接口），没有就按 OpenRouter 的 chat completions 现造；base URL 每次现读。
 * 给了 target.thinking 就把模型标成能思考，价目外的模型 pi 才会发 reasoning（档位即 Agent 的 thinkingLevel）。
 */
export const openRouterSource: ModelSource = (pi, target, step) => {
  if (!openRouterModels) {
    openRouterModels = pi.ai.createModels();
    openRouterModels.setProvider(pi.openrouter.openrouterProvider());
  }
  const known = openRouterModels.getModel('openrouter', target.model);
  // 价目里写明不会思考的模型（如 qwen3-30b-a3b-instruct-2507、mistral-small-3.2）关思考时不发 reasoning：
  // 发了 effort none，require_parameters 会把它所有 provider 都筛掉（OpenRouter 404，2026-11-02 实测）
  const thinks =
    target.thinking !== undefined &&
    !(target.thinking === 'off' && known !== undefined && !known.reasoning);
  const routing = { openRouterRouting: openRouterRouting(step, known) };
  const model: Model<Api> =
    known?.api === 'openai-completions'
      ? {
          ...known,
          baseUrl: target.baseUrl,
          compat: { ...known.compat, ...routing },
          ...(thinks ? { reasoning: true } : {}),
        }
      : {
          id: target.model,
          name: target.model,
          api: 'openai-completions',
          provider: 'openrouter',
          baseUrl: target.baseUrl,
          reasoning: thinks,
          input: ['text'],
          cost: known?.cost ?? NO_COST,
          contextWindow: known?.contextWindow ?? 128_000,
          maxTokens: known?.maxTokens ?? 4_096,
          compat: routing,
        };
  return { models: openRouterModels, model, priced: known !== undefined };
};

/**
 * 思考时在每步的 maxTokens 上另给的额度：思考的字也算在 max_tokens 里，不另给，选卡片的调用会被截断
 * （2026-10-30 实测 DeepSeek low 档 23% 截断）。档位与 pi 给 Anthropic 等的默认思考预算相同；
 * 只按用掉的计费，真正的上限是期限。
 */
export const THINKING_TOKENS: Readonly<Record<ThinkingSetting, number>> = {
  off: 0,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
};

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;

/** provider 报错只留 code：HTTP 状态、finish_reason，其余 provider_error。 */
function providerErrorCode(message: string): string {
  const status = /^(\d{3})\b/.exec(message) ?? /\((\d{3})\):/.exec(message);
  if (status) return `http_${status[1]}`;
  const finish = /^Provider finish_reason: ([a-z_]+)$/.exec(message);
  return finish ? finish[1] : 'provider_error';
}

function assistantData(message: AssistantMessage, priced: boolean): JsonObject {
  const usage = message.usage;
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return {
    model: message.responseModel ?? message.model,
    usage: {
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      reasoningTokens: usage.reasoning ?? 0,
    },
    costUsd: priced ? usage.cost.total : null,
    stopReason: message.stopReason,
    toolCalls: message.content.filter((block) => block.type === 'toolCall')
      .length,
    ...(message.durationMs !== undefined
      ? { durationMs: message.durationMs }
      : {}),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    // 模型的文字可能复述学员原文：按学员原文对待（90 天清空、导出脱敏）
    ...(text ? { text: clip(text, 500) } : {}),
    ...(message.errorMessage
      ? {
          error: {
            name: 'ProviderError',
            code: providerErrorCode(message.errorMessage),
          },
        }
      : {}),
  };
}

export type PiStepRunnerOptions = {
  load?: () => Promise<PiModules>;
  source?: ModelSource;
  /** 测试用：替换 provider 的 HTTP fetch。 */
  fetch?: typeof fetch;
};

export class PiStepRunner implements AgentStepRunner {
  private readonly load: () => Promise<PiModules>;
  private readonly source: ModelSource;

  constructor(private readonly options: PiStepRunnerOptions = {}) {
    this.load = options.load ?? loadPi;
    this.source = options.source ?? openRouterSource;
  }

  async run(
    spec: AgentStepSpec,
    context: AgentStepContext,
  ): Promise<AgentStepOutcome> {
    const pi = await this.load();
    const { signal, trace, step } = context;
    if (signal.aborted) return { kind: 'aborted' };
    const {
      models,
      model,
      priced = true,
    } = this.source(pi, context.model, spec.routing);
    const allowed = [spec.tool.name];
    const toolName = (name: string) =>
      IDENTIFIER.test(name) ? name : 'invalid_name';
    // v5 的列表参数：枚举为空（例如候选都没有答案块）就不给模型这个参数
    const lists = Object.entries(spec.tool.listArgs ?? {}).filter(
      ([, values]) => values.length > 0,
    );
    const texts = Object.entries(spec.tool.textArgs ?? {});
    const flags = Object.entries(spec.tool.flagArgs ?? {});
    const hasExtras =
      spec.tool.listArgs !== undefined ||
      spec.tool.textArgs !== undefined ||
      spec.tool.flagArgs !== undefined;
    const textKeys = new Set(texts.map(([key]) => key));
    const known = new Set([
      ...Object.keys(spec.tool.enumArgs),
      ...lists.map(([key]) => key),
      ...textKeys,
      ...flags.map(([key]) => key),
    ]);
    // 原样记参数只限通过校验的那种：只有这些键、枚举都在、列表每项都在枚举里、真 / 假是布尔、短句是文字
    const valid = (args: unknown) => {
      if (typeof args !== 'object' || args === null || Array.isArray(args))
        return false;
      const record = args as Record<string, unknown>;
      return (
        Object.keys(record).every((key) => known.has(key)) &&
        Object.entries(spec.tool.enumArgs).every(([key, values]) => {
          const value = record[key];
          return typeof value === 'string' && values.includes(value);
        }) &&
        lists.every(([key, values]) => {
          const value = record[key];
          return (
            value === undefined ||
            (Array.isArray(value) &&
              value.every((v) => typeof v === 'string' && values.includes(v)))
          );
        }) &&
        flags.every(([key]) => typeof record[key] === 'boolean') &&
        // pi 把数字、布尔转成文字（TypeBox 转换）再交给工具：这里同样接受，守卫再看内容
        texts.every(([key]) =>
          ['undefined', 'string', 'number', 'boolean'].includes(
            typeof record[key],
          ),
        )
      );
    };
    // 日志里的参数：模型写的短句换成长度（可能复述学员原文），其余原样
    const loggable = (args: unknown): JsonObject => {
      if (textKeys.size === 0) return { arguments: JSON.stringify(args ?? {}) };
      const record = args as Record<string, unknown>;
      const kept = Object.fromEntries(
        Object.entries(record).filter(([key]) => !textKeys.has(key)),
      );
      const lengths = Object.fromEntries(
        Object.entries(record)
          .filter(([key]) => textKeys.has(key))
          .map(([key, value]) => [key, { length: [...String(value)].length }]),
      );
      return { arguments: JSON.stringify(kept), texts: lengths };
    };
    let closed = false;
    let picked: Record<string, string> | null = null;
    let extras: AgentCallExtras | undefined;
    let lastStop: AssistantMessage['stopReason'] | null = null;
    const blocked = new Map<string, string>();
    const emit = (type: Parameters<typeof trace.emit>[0], data: JsonObject) => {
      if (!closed) trace.emit(type, { turn: trace.turn, step, ...data });
    };

    const tool: AgentTool = {
      name: spec.tool.name,
      label: spec.tool.name,
      description: spec.tool.description,
      parameters: pi.ai.Type.Object(
        {
          ...Object.fromEntries(
            Object.entries(spec.tool.enumArgs).map(([key, values]) => [
              key,
              pi.ai.StringEnum([...values]),
            ]),
          ),
          // v5：长度、条数不写进 schema——超了也只是由代码守卫回退，不该让整个调用作废
          ...Object.fromEntries(
            lists.map(([key, values]) => [
              key,
              pi.ai.Type.Optional(
                pi.ai.Type.Array(pi.ai.StringEnum([...values])),
              ),
            ]),
          ),
          ...Object.fromEntries(
            texts.map(([key, description]) => [
              key,
              pi.ai.Type.Optional(pi.ai.Type.String({ description })),
            ]),
          ),
          ...Object.fromEntries(
            flags.map(([key, description]) => [
              key,
              pi.ai.Type.Boolean({ description }),
            ]),
          ),
        },
        { additionalProperties: false },
      ),
      execute: (_id, args) => {
        // pi 已按 TypeBox 校验：枚举参数是枚举里的字符串，列表每项在枚举里，短句是文字，真 / 假是布尔
        const record = args as Record<string, unknown>;
        picked = Object.fromEntries(
          Object.keys(spec.tool.enumArgs).map((key) => [
            key,
            record[key] as string,
          ]),
        );
        if (hasExtras)
          extras = {
            lists: Object.fromEntries(
              lists
                .filter(([key]) => Array.isArray(record[key]))
                .map(([key]) => [key, [...(record[key] as string[])]]),
            ),
            texts: Object.fromEntries(
              texts
                .filter(([key]) => typeof record[key] === 'string')
                .map(([key]) => [key, record[key] as string]),
            ),
            flags: Object.fromEntries(
              flags.map(([key]) => [key, record[key] as boolean]),
            ),
          };
        const details: JsonObject = extras
          ? { ...picked, ...extras.lists, ...extras.flags }
          : picked;
        return Promise.resolve({
          content: [{ type: 'text', text: 'Recorded.' }],
          details,
          terminate: true,
        });
      },
    };

    const agent = new pi.core.Agent({
      initialState: {
        systemPrompt: spec.system,
        model,
        tools: [tool],
        thinkingLevel: context.model.thinking ?? 'off',
      },
      streamFn: (requestModel, transcript, streamOptions) => {
        const traceparent = context.traceparent();
        emit('request/context', {
          provider: requestModel.provider,
          model: requestModel.id,
          api: requestModel.api,
        });
        emit('request/header', { reason: 'step', traceparent });
        return models.streamSimple(requestModel, transcript, {
          ...streamOptions,
          apiKey: context.model.apiKey,
          headers: { ...streamOptions?.headers, traceparent },
          temperature: 0,
          maxTokens:
            spec.maxTokens + THINKING_TOKENS[context.model.thinking ?? 'off'],
          maxRetries: 0,
          // openai-completions 原样转成 tool_choice（SimpleStreamOptions 的类型只列 auto / none）
          toolChoice: 'required' as SimpleStreamOptions['toolChoice'],
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        });
      },
      beforeToolCall: ({ toolCall, assistantMessage }) => {
        const calls = assistantMessage.content.filter(
          (block) => block.type === 'toolCall',
        ).length;
        const code = !allowed.includes(toolCall.name)
          ? 'not_allowed'
          : calls !== 1
            ? 'too_many_calls'
            : null;
        if (!code) return Promise.resolve(undefined);
        blocked.set(toolCall.id, code);
        const result: BeforeToolCallResult = {
          block: true,
          reason:
            code === 'too_many_calls'
              ? 'Call exactly one tool.'
              : 'This tool is not available in this step.',
          terminate: true,
        };
        return Promise.resolve(result);
      },
      finishTurn: () => ({ action: 'end' }),
      toolExecution: 'sequential',
      identity: { attribution: null },
    });

    agent.subscribe((event) => {
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        lastStop = event.message.stopReason;
        emit('assistant/message', assistantData(event.message, priced));
      } else if (event.type === 'tool_execution_start') {
        const raw = JSON.stringify(event.args ?? {});
        emit('tool/call', {
          callId: event.toolCallId,
          name: toolName(event.toolName),
          ...(allowed.includes(event.toolName) && valid(event.args)
            ? loggable(event.args)
            : { rejectedArguments: { length: raw.length } }),
        });
      } else if (event.type === 'tool_execution_end') {
        const base = {
          callId: event.toolCallId,
          name: toolName(event.toolName),
        };
        if (!event.isError) {
          emit('tool/result', {
            ...base,
            result: (event.result as { details: JsonObject }).details,
          });
          return;
        }
        // 中止后的事件已被 closed 挡掉，这里不会有 aborted
        const code =
          blocked.get(event.toolCallId) ??
          (!allowed.includes(event.toolName)
            ? 'unknown_tool'
            : lastStop === 'length'
              ? 'truncated'
              : 'invalid_arguments');
        emit('tool/result', { ...base, error: { name: 'ToolError', code } });
      }
    });

    // 中止后到的事件不再记（工作流已经写了 step/end）；不等 provider 收尾，立即返回
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<void>((resolve) => {
      onAbort = () => {
        closed = true;
        agent.abort();
        resolve();
      };
    });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const prompting = agent.prompt(spec.prompt);
      prompting.catch(() => undefined);
      await Promise.race([prompting, aborted]);
    } catch (error) {
      return {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      closed = true;
      signal.removeEventListener('abort', onAbort);
    }
    if (signal.aborted || lastStop === 'aborted') return { kind: 'aborted' };
    const last = agent.state.messages
      .filter((message) => message.role === 'assistant')
      .at(-1);
    if (!last || last.stopReason === 'error')
      return {
        kind: 'error',
        message: clip(last?.errorMessage ?? 'no response', 300),
      };
    if (!picked) return { kind: 'no_call' };
    return extras
      ? { kind: 'called', args: picked, extras }
      : { kind: 'called', args: picked };
  }
}
