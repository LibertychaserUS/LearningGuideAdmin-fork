import { z } from 'zod';
import { CourseKeySchema } from './brands';
import { ContentVersionSchema } from './content-version';
import {
  PackageAnnotationsSchema,
  PackageProvenanceSchema,
} from './package-manifest';
import {
  CategoryPathSchema,
  LocalizedTemplateSchema,
  isoUtcSchema,
  localeKeySchema,
} from './primitives';
import { SNAPSHOT_FORMAT_VERSION } from '../version-matrix';

/**
 * 版本快照 v3（设计 §14 C0 版本矩阵 / C7 / C10.3 / C10.4 / Part A I9）。
 *
 * 单文件；快照 JSON 用 formatVersion: 3 标记（与既有 CourseVersion.snapshotData
 * 的 formatVersion 字段同义）。course.categoryPath 是 Part A 的保留面
 * （历史版本导出/投影按发布时点路径）；Part C 的冻结内容在 contentVersion 里。
 * capturedAt 是审计时间（记录写入时间），不参与内容身份（B8 确定性）。
 *
 * provenance / annotations（C10.3/C10.4）：审计报告与来源标签随快照携带，
 * 供 Production 争议追溯；它们是审计数据，不参与内容身份与 staleness 判定。
 */
export const SnapshotCourseHeaderSchema = z.strictObject({
  courseKey: CourseKeySchema,
  categoryPath: CategoryPathSchema,
  titleLocalized: LocalizedTemplateSchema,
  learningLanguages: z.array(localeKeySchema).min(1),
});

export type SnapshotCourseHeader = z.infer<typeof SnapshotCourseHeaderSchema>;

export const SnapshotV3Schema = z
  .strictObject({
    formatVersion: z.literal(SNAPSHOT_FORMAT_VERSION),
    capturedAt: isoUtcSchema,
    course: SnapshotCourseHeaderSchema,
    contentVersion: ContentVersionSchema,
    /** C10.4 audit blocks carried by the snapshot (identity-neutral). */
    provenance: PackageProvenanceSchema.optional(),
    annotations: PackageAnnotationsSchema.optional(),
  })
  .superRefine((snapshot, ctx) => {
    if (snapshot.course.courseKey !== snapshot.contentVersion.courseKey) {
      ctx.addIssue({
        code: 'custom',
        message: 'course.courseKey must equal contentVersion.courseKey',
        path: ['course', 'courseKey'],
      });
    }
    if (
      JSON.stringify(snapshot.course.categoryPath) !==
      JSON.stringify(snapshot.contentVersion.categoryPath)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'course.categoryPath must equal contentVersion.categoryPath',
        path: ['course', 'categoryPath'],
      });
    }
    if (
      snapshot.provenance !== undefined &&
      snapshot.provenance.courseKey !== snapshot.course.courseKey
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'provenance.courseKey must equal course.courseKey',
        path: ['provenance', 'courseKey'],
      });
    }
  });

export type SnapshotV3 = z.infer<typeof SnapshotV3Schema>;
