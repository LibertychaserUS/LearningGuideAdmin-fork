import { HELPDESK_DEFAULTS } from '../../../contracts/helpdesk-defaults';
import {
  HELPDESK_SETTINGS,
  readHelpdeskSetting,
} from '../../../contracts/helpdesk-settings';
import type {
  ModelHealthReport,
  ModelStepHealth,
} from '../../../contracts/helpdesk-trace';
import type { AgentEventLog, StepHealthRow } from './agent-event.store';

/**
 * 模型输出健康（ModelHealthReport）：每一步的校验没过、守卫拦下、出错超时的比例。
 * 校验与守卫本身不变（没过就降级，学员看不到坏输出）；这里只把降级的比例数出来，
 * 超过阈值就报警（每个实例每 checkEveryMs 顺手查一次最近 windowMinutes，写一行结构化日志）。
 * 换模型、换 provider 时最先在这里看出来（2026-11-02：gemma-4-31b 把布尔后面的键名写坏，
 * 解释那步 75% 被校验拦下，学员一直被推去转人工，评测才发现）。
 */
export const MODEL_HEALTH = {
  /** 报警阈值：任一比例超过它（HELPDESK_MODEL_HEALTH_ALERT 可改，0 到 1 之间）。 */
  threshold: HELPDESK_DEFAULTS.modelHealthAlert,
  /** 一步至少这么多次才判断（太少的比例没有意义）。 */
  minSample: 20,
  checkEveryMs: 15 * 60_000,
  windowMinutes: 60,
  hoursMax: 168,
} as const;

/** 每次现读；不合法 → 缺省。 */
export function healthThreshold(env: NodeJS.ProcessEnv): number {
  return readHelpdeskSetting(HELPDESK_SETTINGS.modelHealthAlert, env);
}

const rate = (n: number, total: number) =>
  total > 0 ? Math.round((n / total) * 10_000) / 10_000 : 0;

export function assessModelHealth(
  rows: StepHealthRow[],
  options: { threshold: number; minSample: number },
): ModelStepHealth[] {
  return rows.map((row) => {
    const invalidRate = rate(row.invalid, row.total);
    const guardFallbackRate = rate(row.guardFallbacks, row.total);
    const failureRate = rate(row.failures, row.total);
    return {
      ...row,
      invalidRate,
      guardFallbackRate,
      failureRate,
      alert:
        row.total >= options.minSample &&
        Math.max(invalidRate, guardFallbackRate, failureRate) >
          options.threshold,
    };
  });
}

export async function modelHealthReport(
  log: Pick<AgentEventLog, 'stepHealth'>,
  input: { hours: number; now: Date; threshold: number },
): Promise<ModelHealthReport> {
  const since = new Date(input.now.getTime() - input.hours * 3_600_000);
  const rows = await log.stepHealth(since);
  return {
    since: since.toISOString(),
    hours: input.hours,
    threshold: input.threshold,
    minSample: MODEL_HEALTH.minSample,
    steps: assessModelHealth(rows, {
      threshold: input.threshold,
      minSample: MODEL_HEALTH.minSample,
    }),
  };
}
