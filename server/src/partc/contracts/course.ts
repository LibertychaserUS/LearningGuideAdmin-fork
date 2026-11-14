import { z } from 'zod';
import { CourseKeySchema } from './brands';
import {
  CategoryPathSchema,
  LocalizedTemplateSchema,
  PublishTargetSchema,
  nonNegativeIntSchema,
} from './primitives';

/**
 * Course（设计 §14 C3/C6）。
 *
 * 无本地分类表、无时间轴字段；publishTargets 空 = 不可发布。
 * 分类只带 categoryPath（稳定键路径），不带环境 UUID。
 *
 * structureRevision / alignmentSetVersion 是 C6 inputClosure 的单调计数器：
 * 写入路径每次修改 +1（缺省 0 只为兼容既有夹具；存储层始终有值）。
 */
export const CourseSchema = z.strictObject({
  courseKey: CourseKeySchema,
  categoryPath: CategoryPathSchema,
  titleLocalized: LocalizedTemplateSchema,
  publishTargets: z.array(PublishTargetSchema),
  structureRevision: nonNegativeIntSchema.default(0),
  alignmentSetVersion: nonNegativeIntSchema.default(0),
});

export type Course = z.infer<typeof CourseSchema>;
