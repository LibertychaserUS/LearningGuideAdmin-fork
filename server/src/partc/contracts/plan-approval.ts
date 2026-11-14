import { z } from 'zod';
import { PlanWarningSchema } from './plan';
import { PLAN_ID_PATTERN } from './plan-id';
import {
  isoUtcSchema,
  nonEmptyTextSchema,
  positiveIntSchema,
} from './primitives';

/**
 * PlanApproval（设计 §14 C3/C4 G4 / C6）。
 *
 * 绑定 canonical bytes 的 (planId, planVersion)；apply 只认已批准。
 * acceptedWarnings 显式记录被接受的结构化 warning；拒绝时不接受任何 warning。
 */
export const PLAN_APPROVAL_DECISIONS = ['approved', 'rejected'] as const;
export type PlanApprovalDecision = (typeof PLAN_APPROVAL_DECISIONS)[number];

export const PlanApprovalSchema = z
  .strictObject({
    planId: z.string().regex(PLAN_ID_PATTERN, 'malformed planId'),
    planVersion: positiveIntSchema,
    decision: z.enum(PLAN_APPROVAL_DECISIONS),
    approvedBy: nonEmptyTextSchema,
    approvedAt: isoUtcSchema,
    acceptedWarnings: z.array(PlanWarningSchema),
  })
  .refine(
    (approval) =>
      approval.decision === 'approved' ||
      approval.acceptedWarnings.length === 0,
    'a rejected approval must not accept warnings',
  );

export type PlanApproval = z.infer<typeof PlanApprovalSchema>;
