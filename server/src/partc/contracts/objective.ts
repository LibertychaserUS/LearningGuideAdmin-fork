import { z } from 'zod';
import { nonEmptyTextSchema, stableTokenSchema } from './primitives';

/**
 * Objective（设计 §14 C3）。
 *
 * objectiveKey 稳定；退役不复用（status=retired 后不得复活同一 key）。
 */
export const OBJECTIVE_STATUSES = ['active', 'retired'] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

export const ObjectiveSchema = z.strictObject({
  objectiveKey: stableTokenSchema,
  statement: nonEmptyTextSchema,
  status: z.enum(OBJECTIVE_STATUSES),
});

export type Objective = z.infer<typeof ObjectiveSchema>;
