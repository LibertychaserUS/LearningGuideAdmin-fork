import { z } from 'zod';
import { StageKeySchema } from './brands';

/**
 * PrerequisiteEdge（设计 §14 C3/C4 STR-7）。
 *
 * requires 进入交付序；recommends 只出 warning。允许多父（DAG，不是树）；
 * 端点存在、同课程、与 sequence 闭包合并后无环是跨行不变量。
 * 自指在单条记录内即可拒绝，因此放进 schema。
 */
export const PREREQUISITE_KINDS = ['requires', 'recommends'] as const;
export type PrerequisiteKind = (typeof PREREQUISITE_KINDS)[number];

export const PrerequisiteEdgeSchema = z
  .strictObject({
    fromStageKey: StageKeySchema,
    toStageKey: StageKeySchema,
    kind: z.enum(PREREQUISITE_KINDS),
  })
  .refine(
    (edge) => edge.fromStageKey !== edge.toStageKey,
    'prerequisite edge must not be self-referential',
  );

export type PrerequisiteEdge = z.infer<typeof PrerequisiteEdgeSchema>;
