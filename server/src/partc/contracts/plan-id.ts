/**
 * planId 的显式派生（设计 §14 C6）。
 *
 * planId = (courseKey, contentVersionId, targetId, planVersion) 的显式记录：
 * plan/{courseKey}/{contentVersionId}/{targetId}/v{planVersion}。
 * 分段用 stable token（不含斜杠）；不使用任何摘要。
 */
export const PLAN_ID_PATTERN =
  /^plan\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/v[1-9]\d*$/;

export function derivePlanId(input: {
  courseKey: string;
  contentVersionId: string;
  targetId: string;
  planVersion: number;
}): string {
  return `plan/${input.courseKey}/${input.contentVersionId}/${input.targetId}/v${input.planVersion}`;
}
