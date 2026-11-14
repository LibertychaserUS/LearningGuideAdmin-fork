import { z } from 'zod';
import { StageKeySchema } from './brands';
import {
  isoUtcSchema,
  nonEmptyTextSchema,
  positiveIntSchema,
  stableTokenSchema,
} from './primitives';

/**
 * EvidenceAttainment（设计 §14 C3/C8）。
 *
 * 证据达成的唯一账本：写入方 = 评分服务/教师；发布门与 as-run 都读它；
 * completion（完成度）不写此处。每次尝试一行：attemptNo 单调，
 * 唯一键 = (contentVersionId, stageKey, evidenceKey, attemptNo)（DB 唯一索引兜底）。
 * score 与 rubricLevel 至少给一个。
 */
export const EvidenceAttainmentSchema = z
  .strictObject({
    contentVersionId: stableTokenSchema,
    stageKey: StageKeySchema,
    evidenceKey: stableTokenSchema,
    attemptNo: positiveIntSchema,
    score: z.number().finite().nonnegative().optional(),
    rubricLevel: nonEmptyTextSchema.optional(),
    attained: z.boolean(),
    gradedBy: nonEmptyTextSchema,
    gradedAt: isoUtcSchema,
  })
  .refine(
    (record) => record.score !== undefined || record.rubricLevel !== undefined,
    'one of score or rubricLevel is required',
  );

export type EvidenceAttainment = z.infer<typeof EvidenceAttainmentSchema>;

/** 账本唯一键的稳定字符串形式（无哈希）。 */
export function evidenceAttainmentIdentity(record: EvidenceAttainment): string {
  return [
    record.contentVersionId,
    record.stageKey,
    record.evidenceKey,
    String(record.attemptNo),
  ].join('\u0000');
}
