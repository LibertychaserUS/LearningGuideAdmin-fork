import type {
  JsonObject,
  TurnEndReason,
} from '../../../contracts/helpdesk-trace';
import type { RunTrace } from '../trace/run-trace';

/**
 * 工作流层（helpdesk-agent-v2-pi-dsh §1「两层」）：每个工作流是一张写死的步骤表，
 * 下一步永远由我们的代码按上一步校验过的结果决定，模型从不决定。
 * - code 步：检索、校验、查订单……纯代码；
 * - agent 步：交给 AgentStepRunner（pi-agent-core 的 Agent，原样使用）只做这一步，
 *   只给这一步的工具，参数全部枚举锁定；runner 只回报「调了什么」，怎么走由 decide 决定。
 * 新模板（订单状态卡片、只给链接、低置信度选项）= 新的一张步骤表，不动这里与 runner。
 */
/** 思考档位（OpenRouter 的 reasoning effort；off = none）。 */
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export type ThinkingSetting = (typeof THINKING_LEVELS)[number];

export type ModelTarget = {
  provider: 'openrouter';
  model: string;
  apiKey: string;
  baseUrl: string;
  /**
   * 给了就发 OpenRouter 的 reasoning effort（off → none；模型不支持的档位由 pi 就近取）。不给 = off：
   * pi 价目里能思考的模型（DeepSeek v4.1 flash、Gemini 2.5 flash）发 none，价目外的什么都不发。
   */
  thinking?: ThinkingSetting;
};

export type AgentStepSpec = {
  /** 不含任何学员原文。 */
  system: string;
  /** 学员原文只放在这里（不可信输入）。 */
  prompt: string;
  /** 这一步唯一的工具；enumArgs 全部是枚举锁定的字符串（必填）。 */
  tool: {
    name: string;
    description: string;
    enumArgs: Record<string, readonly string[]>;
    /**
     * v5（可选）：枚举值的列表（例如答案块 id）。模型可以不给；给了每项都必须在枚举里，
     * 是否合用（子集、连续、条数）由工作流的代码再核。
     */
    listArgs?: Record<string, readonly string[]>;
    /**
     * v5（可选）：模型写的短句（参数名 → 给模型的说明）。可以不给；从不原样展示，
     * 一律先过 guard.ts 的代码守卫。日志里只记长度（文字按学员原文对待）。
     */
    textArgs?: Record<string, string>;
    /** v5：必填的真 / 假（参数名 → 说明），例如 explain 的 covered。 */
    flagArgs?: Record<string, string>;
  };
  maxTokens: number;
  /**
   * 这一步走哪家 provider。缺省 = 只选最便宜（owner 2026-10-31）。'fastest' = 首字最快、且单价不超过
   * 模型目录价的 provider：只有拆问（split_asks）用，owner 2026-11-06 选「拆问走最快的，设价格上限」。
   */
  routing?: 'fastest';
};

/** 工具调用里枚举以外的参数（v5）；没有这类参数的步骤为 undefined。 */
export type AgentCallExtras = {
  lists: Record<string, string[]>;
  texts: Record<string, string>;
  flags: Record<string, boolean>;
};

export type AgentStepOutcome =
  | {
      kind: 'called';
      args: Record<string, string>;
      /** v5：spec 有 listArgs / textArgs / flagArgs 时才有。 */
      extras?: AgentCallExtras;
    }
  | { kind: 'no_call' }
  | { kind: 'error'; message: string }
  | { kind: 'aborted' };

export type AgentStepContext = {
  trace: RunTrace;
  step: number;
  name: string;
  signal: AbortSignal;
  model: ModelTarget;
  /** 发往模型的 W3C traceparent（每次请求一个新 span）。 */
  traceparent: () => string;
};

/** 跑一个 agent 步；实现见 pi-step-runner.ts（ESM 的 pi 用 import() 加载，单测换假的）。 */
export interface AgentStepRunner {
  run(
    spec: AgentStepSpec,
    context: AgentStepContext,
  ): Promise<AgentStepOutcome>;
}

export type Transition = { next: string } | { end: TurnEndReason };

/**
 * code 步里顺带问一次模型（例如和检索同时把一句话拆成几件事）：这次调用记成自己的一步
 * （step/start、step/end 带 parent = 这个 code 步的编号），不改变下一步怎么走，也不占步骤表的次数。
 * 超时取 min(timeoutMs, 这一步的期限)；出错、超时、放弃都只是 outcome，由 code 步自己决定怎么办。
 * 可以不等它（把 promise 留在 state 里，后面的步再等）：run 结束时还没回来的就取消（step/end 记
 * outcome cancelled），所以每次调用都在 run 结束前记完。
 */
export type CodeStepContext = {
  agent(
    name: string,
    spec: AgentStepSpec,
    options?: { timeoutMs?: number },
  ): Promise<AgentStepOutcome>;
};

export type CodeStep<S> = {
  kind: 'code';
  run(
    state: S,
    context: CodeStepContext,
  ): Promise<{ state: S; then: Transition; output?: JsonObject }>;
};

export type AgentStep<S> = {
  kind: 'agent';
  prepare(state: S): AgentStepSpec;
  /** args 是 runner 校验过的工具参数；没有有效调用时为 null。extras 是 v5 的列表、短句与真 / 假。 */
  decide(
    state: S,
    args: Record<string, string> | null,
    extras?: AgentCallExtras,
  ): { state: S; then: Transition };
};

export type WorkflowTemplate<S> = {
  name: string;
  start: string;
  steps: Record<string, CodeStep<S> | AgentStep<S>>;
};

export type WorkflowDeps = {
  trace: RunTrace;
  runner?: AgentStepRunner;
  model?: ModelTarget;
  /** 调用方放弃（Portal 断开）：不再开新步，正在跑的 agent 步立即放弃，结束为 aborted。 */
  signal?: AbortSignal;
  /** 一个 agent 步最多跑多久（开步时现算：min(3 s, 离总期限还剩)）；到时结束为 timeout。 */
  stepTimeoutMs: () => number;
  traceparent: () => string;
  /** 每开一步就告诉调用方步骤名（Portal 的「思考中」面板）；它抛错也不影响这次 run。 */
  onStep?: (name: string) => void;
  /** 同一次推荐里并行的另一路（例如不思考的后备）：每个 step/start、step/end 都带上它。 */
  branch?: string;
};

const ABORTED: AgentStepOutcome = { kind: 'aborted' };

/** 日志里的 extras：列表与真 / 假原样，短句只有长度。 */
export function extrasLog(extras: AgentCallExtras): JsonObject {
  return {
    lists: extras.lists,
    flags: extras.flags,
    texts: Object.fromEntries(
      Object.entries(extras.texts).map(([key, text]) => [
        key,
        { length: [...text].length },
      ]),
    ),
  };
}

/** runner 不理 signal 也不等它：abort 一到就当 aborted 处理。 */
function untilAborted(
  work: Promise<AgentStepOutcome>,
  signal: AbortSignal,
): Promise<AgentStepOutcome> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<AgentStepOutcome>((resolve) => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([
    work.catch((error: unknown) => ({
      kind: 'error' as const,
      message: error instanceof Error ? error.message : String(error),
    })),
    aborted,
  ]).finally(() => signal.removeEventListener('abort', onAbort));
}

export async function runWorkflow<S>(
  template: WorkflowTemplate<S>,
  initial: S,
  deps: WorkflowDeps,
): Promise<{ state: S; reason: TurnEndReason; trail: string[] }> {
  const { trace } = deps;
  const turn = trace.turn;
  let state = initial;
  let name = template.start;
  const trail: string[] = [];
  const branch: JsonObject = deps.branch ? { branch: deps.branch } : {};
  /** 跑一次 agent 调用（agent 步与 code 步里的顺带调用共用）：期限到了算 aborted。 */
  const callAgent = (
    spec: AgentStepSpec,
    no: number,
    stepName: string,
    timeoutMs: number,
    cancel?: AbortSignal,
  ): Promise<AgentStepOutcome> => {
    const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
    const signals = [
      timeout,
      ...(deps.signal ? [deps.signal] : []),
      ...(cancel ? [cancel] : []),
    ];
    const signal = signals.length > 1 ? AbortSignal.any(signals) : timeout;
    if (signal.aborted) return Promise.resolve(ABORTED);
    if (!deps.runner || !deps.model)
      return Promise.resolve({ kind: 'error', message: 'no runner' });
    return untilAborted(
      deps.runner.run(spec, {
        trace,
        step: no,
        name: stepName,
        signal,
        model: deps.model,
        traceparent: deps.traceparent,
      }),
      signal,
    );
  };
  /** 一次调用的结果怎么记：模型写的短句只记长度（文字可能复述用户原文），列表与真 / 假是枚举，原样记。 */
  const outcomeLog = (outcome: AgentStepOutcome): JsonObject => ({
    outcome: outcome.kind,
    ...(outcome.kind === 'called' ? { args: outcome.args } : {}),
    ...(outcome.kind === 'called' && outcome.extras
      ? extrasLog(outcome.extras)
      : {}),
  });
  /** code 步里发出、还没回来的调用（run 结束时取消并等它记完）。 */
  const pending = new Set<{
    cancel: AbortController;
    done: Promise<unknown>;
  }>();
  const contextFor = (parent: number): CodeStepContext => ({
    agent(subName, spec, options = {}) {
      const cancel = new AbortController();
      const done = subCall(parent, subName, spec, options, cancel.signal);
      const entry = { cancel, done };
      pending.add(entry);
      void done.finally(() => pending.delete(entry));
      return done;
    },
  });
  const subCall = async (
    parent: number,
    subName: string,
    spec: AgentStepSpec,
    options: { timeoutMs?: number },
    cancel: AbortSignal,
  ): Promise<AgentStepOutcome> => {
    {
      const no = trace.nextStep();
      trace.emit('step/start', {
        turn,
        step: no,
        name: subName,
        kind: 'agent',
        tools: [spec.tool.name],
        parent,
        ...branch,
      });
      const outcome = await callAgent(
        spec,
        no,
        subName,
        Math.min(
          deps.stepTimeoutMs(),
          options.timeoutMs ?? Number.POSITIVE_INFINITY,
        ),
        cancel,
      );
      trace.emit('step/end', {
        turn,
        step: no,
        name: subName,
        kind: 'agent',
        parent,
        ...branch,
        ...(cancel.aborted && outcome.kind === 'aborted'
          ? { outcome: 'cancelled' }
          : outcomeLog(outcome)),
      });
      return outcome;
    }
  };
  const result = await walk();
  for (const entry of pending) entry.cancel.abort();
  await Promise.all([...pending].map((entry) => entry.done));
  return result;

  async function walk(): Promise<{
    state: S;
    reason: TurnEndReason;
    trail: string[];
  }> {
    // 每一步至多走一次：步骤表多大，就最多走多少步
    for (let taken = 0; taken < Object.keys(template.steps).length; taken++) {
      const step = Object.hasOwn(template.steps, name)
        ? template.steps[name]
        : undefined;
      if (!step) return { state, reason: 'error', trail };
      trail.push(name);
      try {
        deps.onStep?.(name);
      } catch {
        // 听的人出了问题不算这次 run 的问题
      }
      const no = trace.nextStep();
      let then: Transition;
      if (step.kind === 'code') {
        trace.emit('step/start', {
          turn,
          step: no,
          name,
          kind: 'code',
          ...branch,
        });
        try {
          const result = await step.run(state, contextFor(no));
          state = result.state;
          then = result.then;
          trace.emit('step/end', {
            turn,
            step: no,
            name,
            kind: 'code',
            ...branch,
            then,
            ...(result.output ? { output: result.output } : {}),
          });
        } catch (error) {
          then = { end: 'error' };
          trace.emit('step/end', {
            turn,
            step: no,
            name,
            kind: 'code',
            ...branch,
            then,
            error: {
              name: error instanceof Error ? error.name : 'Error',
              code: 'step_failed',
            },
          });
        }
      } else {
        const spec = step.prepare(state);
        trace.emit('step/start', {
          turn,
          step: no,
          name,
          kind: 'agent',
          tools: [spec.tool.name],
          ...branch,
        });
        const outcome = await callAgent(spec, no, name, deps.stepTimeoutMs());
        if (outcome.kind === 'aborted')
          then = { end: deps.signal?.aborted ? 'aborted' : 'timeout' };
        else if (outcome.kind === 'error') then = { end: 'error' };
        else {
          const decided = step.decide(
            state,
            outcome.kind === 'called' ? outcome.args : null,
            outcome.kind === 'called' ? outcome.extras : undefined,
          );
          state = decided.state;
          then = decided.then;
        }
        trace.emit('step/end', {
          turn,
          step: no,
          name,
          kind: 'agent',
          ...branch,
          ...outcomeLog(outcome),
          then,
        });
      }
      if ('end' in then) return { state, reason: then.end, trail };
      name = then.next;
    }
    return { state, reason: 'error', trail };
  }
}
