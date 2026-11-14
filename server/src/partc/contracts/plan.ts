import { z } from 'zod';
import { CourseKeySchema } from './brands';
import { PlanEntrySchema, planEntryIdSchema } from './plan-entry';
import { AssetPinSchema, SpecPinSchema } from './pins';
import { PLAN_ID_PATTERN, derivePlanId } from './plan-id';
import { canonicalJson } from './canonical-json';
import {
  nonNegativeIntSchema,
  nonEmptyTextSchema,
  positiveIntSchema,
  stableTokenSchema,
} from './primitives';

/**
 * Plan 工件（设计 §14 C3/C6，无哈希版）。
 *
 * - inputClosure 是显式结构（不是摘要）：courseKey、structureRevision、specPins、
 *   assetPins、alignmentSetVersion（单调计数器：verified/rejected/stale 影响对齐集时 +1）、
 *   targetId、resolvedChoices、ruleVersion、compilerVersion。
 * - planId = (courseKey, contentVersionId, targetId, planVersion) 的显式记录，
 *   由 derivePlanId() 生成；planVersion 单调递增。
 * - canonical JSON bytes 只含确定性内容：不含 status（外置在 Plan 表/PlanState）、
 *   不含任何 wall-clock 时间戳、随机数、locale 相关文本。
 * - 同输入 + ruleVersion + compilerVersion 必须字节相等（PLN-1）。
 */

export const PLAN_STATUSES = [
  'draft',
  'approved',
  'degraded',
  'blocked',
  'superseded',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_WARNING_CODES = [
  'PREREQUISITE_RECOMMENDS',
  'DEGRADED_PLACEMENT',
] as const;
export type PlanWarningCode = (typeof PLAN_WARNING_CODES)[number];

/** Plan 级 warning 是结构化 code（无本地化散文），保证 bytes 跨 locale 稳定。 */
export const PlanWarningSchema = z.strictObject({
  code: z.enum(PLAN_WARNING_CODES),
  stageKey: stableTokenSchema.optional(),
  alignmentId: stableTokenSchema.optional(),
  entryId: planEntryIdSchema.optional(),
});

export type PlanWarning = z.infer<typeof PlanWarningSchema>;

/**
 * 输入闭包（C6）。alignmentSetVersion 是单调计数器而非摘要：
 * verified/rejected 或 stale 判定受影响时 +1，Plan 通过版本号感知对齐集变化。
 */
export const InputClosureSchema = z
  .strictObject({
    courseKey: CourseKeySchema,
    structureRevision: nonNegativeIntSchema,
    specPins: z.array(SpecPinSchema),
    assetPins: z.array(AssetPinSchema),
    alignmentSetVersion: nonNegativeIntSchema,
    targetId: stableTokenSchema,
    /** v1 无 choice 容器（编译器以 UNSUPPORTED_ORDERING 拒绝），保留有序占位数组。 */
    resolvedChoices: z.array(stableTokenSchema),
    ruleVersion: nonEmptyTextSchema,
    compilerVersion: nonEmptyTextSchema,
  })
  .superRefine((closure, ctx) => {
    for (let index = 1; index < closure.specPins.length; index += 1) {
      if (
        closure.specPins[index - 1].contentKey >=
        closure.specPins[index].contentKey
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'specPins must be sorted by contentKey and unique',
          path: ['specPins', index],
        });
      }
    }
    for (let index = 1; index < closure.assetPins.length; index += 1) {
      if (
        closure.assetPins[index - 1].assetKey >=
        closure.assetPins[index].assetKey
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'assetPins must be sorted by assetKey and unique',
          path: ['assetPins', index],
        });
      }
    }
  });

export type InputClosure = z.infer<typeof InputClosureSchema>;

const planBodyFieldsSchema = z.strictObject({
  planId: z.string().regex(PLAN_ID_PATTERN, 'malformed planId'),
  contentVersionId: stableTokenSchema,
  targetId: stableTokenSchema,
  planVersion: positiveIntSchema,
  inputClosure: InputClosureSchema,
  entries: z.array(PlanEntrySchema),
  warnings: z.array(PlanWarningSchema),
  compilerVersion: nonEmptyTextSchema,
  ruleVersion: nonEmptyTextSchema,
});

type PlanBodyFields = z.infer<typeof planBodyFieldsSchema>;

function refinePlanBody(plan: PlanBodyFields, ctx: z.RefinementCtx): void {
  const expectedPlanId = derivePlanId({
    courseKey: plan.inputClosure.courseKey,
    contentVersionId: plan.contentVersionId,
    targetId: plan.targetId,
    planVersion: plan.planVersion,
  });
  if (plan.planId !== expectedPlanId) {
    ctx.addIssue({
      code: 'custom',
      message: `planId must equal derived id ${expectedPlanId}`,
      path: ['planId'],
    });
  }
  if (plan.inputClosure.targetId !== plan.targetId) {
    ctx.addIssue({
      code: 'custom',
      message: 'targetId must equal inputClosure.targetId',
      path: ['targetId'],
    });
  }
  if (plan.inputClosure.compilerVersion !== plan.compilerVersion) {
    ctx.addIssue({
      code: 'custom',
      message: 'compilerVersion must equal inputClosure.compilerVersion',
      path: ['compilerVersion'],
    });
  }
  if (plan.inputClosure.ruleVersion !== plan.ruleVersion) {
    ctx.addIssue({
      code: 'custom',
      message: 'ruleVersion must equal inputClosure.ruleVersion',
      path: ['ruleVersion'],
    });
  }
  const entryIds = new Set<string>();
  for (let index = 0; index < plan.entries.length; index += 1) {
    const entry = plan.entries[index];
    if (entryIds.has(entry.entryId)) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate entryId ${entry.entryId}`,
        path: ['entries', index, 'entryId'],
      });
    }
    entryIds.add(entry.entryId);
    if (index > 0 && plan.entries[index - 1].orderKey >= entry.orderKey) {
      ctx.addIssue({
        code: 'custom',
        message: 'entries must be sorted by strictly ascending orderKey',
        path: ['entries', index, 'orderKey'],
      });
    }
  }
}

/** canonical Plan 正文：不含 status、时间戳、随机值、locale 文本（C6）。 */
export const PlanBodySchema = planBodyFieldsSchema.superRefine(refinePlanBody);

export type PlanBody = z.infer<typeof PlanBodySchema>;

/** Plan 记录 = canonical bytes 原文 + 外置状态（Plan 表/PlanState）。 */
export const PlanRecordSchema = planBodyFieldsSchema
  .extend({ status: z.enum(PLAN_STATUSES) })
  .superRefine(refinePlanBody);

export type PlanRecord = z.infer<typeof PlanRecordSchema>;

/** canonical bytes（比较用字节相等，不用摘要）。 */
export function planBodyBytes(plan: PlanBody): string {
  return canonicalJson(plan);
}

/** 字节相等比较；调用方应先通过 PlanBodySchema 解析。 */
export function planBodiesEqual(left: PlanBody, right: PlanBody): boolean {
  return planBodyBytes(left) === planBodyBytes(right);
}
