import { z } from 'zod';
import { CourseKeySchema } from './brands';
import {
  isoUtcSchema,
  nonEmptyTextSchema,
  positiveIntSchema,
  stableTokenSchema,
} from './primitives';

/**
 * Publication（设计 §14 C10：历史与追溯不使用内容哈希）。
 *
 * 版本 = 不可变快照 + 追加写的发布记录。live 指针由最高有效发布派生：
 * `validFrom <= now` 且（`validTo` 为空或 `> now`）的记录中 versionNo 最大者。
 * validFrom/validTo 是 valid time；记录写入时间（transaction time）由存储层
 * createdAt 另存。发布记录不参与内容身份与幂等。
 */
export const PublicationSchema = z
  .strictObject({
    publicationId: stableTokenSchema,
    courseKey: CourseKeySchema,
    contentVersionId: stableTokenSchema,
    versionNo: positiveIntSchema,
    validFrom: isoUtcSchema,
    validTo: isoUtcSchema.optional(),
    /** 操作者（员工 id 或 system）。 */
    actor: nonEmptyTextSchema,
    /** 变更摘要（人类可读；不参与身份）。 */
    summary: nonEmptyTextSchema.optional(),
  })
  .superRefine((publication, ctx) => {
    if (
      publication.validTo !== undefined &&
      Date.parse(publication.validTo) <= Date.parse(publication.validFrom)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'validTo must be strictly after validFrom',
        path: ['validTo'],
      });
    }
  });

export type Publication = z.infer<typeof PublicationSchema>;
