import { z } from 'zod';
import { CourseKeySchema, StageKeySchema, TimeMsSchema } from './brands';
import { nonEmptyTextSchema, stableTokenSchema } from './primitives';

/**
 * Stage（设计 §14 C3/C4）。
 *
 * 意图域只表达包含、目标、出口证据、排序意图；不含时间码/页码/周次。
 * 包含森林（≤1 父、无环）、交付叶判定（无子节点且 objectiveKeys/exitEvidence 非空）
 * 与容器 exitEvidence 为空是跨行不变量（STR-1），由编译器/发布门校验。
 */

export const STAGE_KINDS = ['program', 'phase', 'stage', 'step'] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

/** 退役不复用：active 才能进入发布。 */
export const STAGE_STATUSES = ['active', 'retired'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/**
 * orderKey 由程序生成（C3），是零填充的数值路径段：
 * "000001"、"000001.000002"。STR-3 的线性化按该路径的字典序比较。
 */
export const STAGE_ORDER_KEY_PATTERN = /^\d{6}(?:\.\d{6})*$/;
export const stageOrderKeySchema = z
  .string()
  .regex(
    STAGE_ORDER_KEY_PATTERN,
    'orderKey must be zero-padded numeric path segments',
  );

/** 出口证据汇总规则（C3/C8）：all / anyOf / atLeast(n)。 */
export const ExitRollupSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all') }),
  z.strictObject({ kind: z.literal('anyOf') }),
  z.strictObject({
    kind: z.literal('atLeast'),
    n: z.number().int().positive(),
  }),
]);

export type ExitRollup = z.infer<typeof ExitRollupSchema>;

export const StageSchema = z.strictObject({
  courseKey: CourseKeySchema,
  stageKey: StageKeySchema,
  parentStageKey: StageKeySchema.nullable(),
  orderKey: stageOrderKeySchema,
  kind: z.enum(STAGE_KINDS),
  goal: nonEmptyTextSchema,
  objectiveKeys: z.array(stableTokenSchema),
  exitEvidence: z.array(stableTokenSchema),
  exitRollup: ExitRollupSchema,
  /**
   * 仅作为媒体求和预算的设计约束（C7 时间三角色之二），不是课程时间轴，
   * 也不参与任何身份或排期推导。
   */
  durationBudget: TimeMsSchema.optional(),
  status: z.enum(STAGE_STATUSES),
});

export type Stage = z.infer<typeof StageSchema>;
