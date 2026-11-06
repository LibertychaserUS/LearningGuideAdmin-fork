import {
  evalCacheKey,
  evalCacheScope,
  replayLatency,
} from '../../../contracts/helpdesk-eval-cache';
import type { RunTrace } from '../trace/run-trace';
import type { AgentStepOutcome, AgentStepRunner } from './engine';

/**
 * 发布前检查用的模型步缓存（契约 contracts/helpdesk-eval-cache.ts 的 step 层）。
 * 键 = 整个请求：system、prompt（含候选卡片）、工具、maxTokens、模型、服务商地址、思考档位；不含 key。
 * 只记 called / no_call（模型真的答完了）；出错、超时、被取消的下一次照样真问。
 * 命中：照记录的耗时等（步骤时限、总期限照常生效），再给记下的结果；链路里不写请求与计价（没花钱）。
 * 不在检查的一问里（线上聊天）→ 原样交给 inner。
 */
export function cachedStepRunner(inner: AgentStepRunner): AgentStepRunner {
  return {
    async run(spec, context) {
      const scope = evalCacheScope();
      if (!scope) return inner.run(spec, context);
      const key = evalCacheKey('step', {
        spec,
        model: {
          provider: context.model.provider,
          model: context.model.model,
          baseUrl: context.model.baseUrl,
          thinking: context.model.thinking ?? null,
        },
      });
      const stats = scope.stats.step;
      if (scope.mode === 'use') {
        const hit = (await scope.store.get('step', [key])).get(key);
        const outcome = hit ? storedOutcome(hit.value) : null;
        if (hit && outcome) {
          if (!(await replayLatency(hit.latencyMs, context.signal)))
            return { kind: 'aborted' };
          stats.hits += 1;
          stats.savedUsd += hit.costUsd;
          return outcome;
        }
      }
      stats.misses += 1;
      let costUsd = 0;
      const started = performance.now();
      const outcome = await inner.run(spec, {
        ...context,
        trace: costTap(context.trace, (usd) => (costUsd += usd)),
      });
      if (outcome.kind === 'called' || outcome.kind === 'no_call')
        await scope.store
          .put('step', [
            {
              key,
              entry: {
                value: outcome,
                latencyMs: Math.round(performance.now() - started),
                costUsd,
              },
            },
          ])
          .catch(() => undefined); // 缓存写不进去不影响这一问
      return outcome;
    },
  };
}

/** 记下的结果读回来：形状不对（旧版本、手改过）= 当没命中。 */
function storedOutcome(value: unknown): AgentStepOutcome | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.kind === 'no_call') return { kind: 'no_call' };
  if (v.kind !== 'called' || typeof v.args !== 'object' || v.args === null)
    return null;
  const args = v.args as Record<string, unknown>;
  if (!Object.values(args).every((arg) => typeof arg === 'string')) return null;
  const extras = v.extras as Record<string, unknown> | undefined;
  return {
    kind: 'called',
    args: args as Record<string, string>,
    ...(extras && typeof extras === 'object'
      ? {
          extras: {
            lists: (extras.lists ?? {}) as Record<string, string[]>,
            texts: (extras.texts ?? {}) as Record<string, string>,
            flags: (extras.flags ?? {}) as Record<string, boolean>,
          },
        }
      : {}),
  };
}

/** 同一条链路，只是顺手记下 assistant/message 的 costUsd（这一步花了多少，命中时算省下的）。 */
function costTap(trace: RunTrace, add: (usd: number) => void): RunTrace {
  return new Proxy(trace, {
    get(target, prop) {
      if (prop === 'emit')
        return (...args: Parameters<RunTrace['emit']>) => {
          const [type, data] = args;
          if (
            type === 'assistant/message' &&
            typeof data.costUsd === 'number' &&
            Number.isFinite(data.costUsd)
          )
            add(data.costUsd);
          target.emit(...args);
        };
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
