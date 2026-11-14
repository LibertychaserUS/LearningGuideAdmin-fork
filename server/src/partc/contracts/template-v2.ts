import { z } from 'zod';
import { AssetKeySchema, CourseKeySchema, LocaleSchema } from './brands';
import { MEDIA_ASSET_KINDS } from './media-asset';
import { PartCError } from '../errors';
import { TEMPLATE_VERSION } from '../version-matrix';
import {
  StudyModeSchema,
  localeKeySchema,
  nonEmptyTextSchema,
  packageRelativePathSchema,
  positiveIntSchema,
  stableTokenSchema,
} from './primitives';

/**
 * 模板 v2 机读契约（设计 §14 C0/C5 P0、B1、C7）。
 *
 * 模板由本 schema 生成（列名/枚举/校验与解析器同源，B8）；本文件只冻结
 * 机器可读表结构，Checklist 属人工工作流，不在机器契约内。
 *
 * 红线：模板里没有任何时间列，人也不参与任何时间输入（C0 ⑥/C7）。
 * LP 标题与正文 [Exhibit: Exx] 标记的时间由导入服务按字幕/章节/DOCX 结构
 * 机器派生；本契约出现任何时间列即 HUMAN_TIME_FORBIDDEN。
 *
 * 列命名：稳定 key 用 snake_case；Meta 列名沿用 B1 机读字段名。
 */

export const TemplateMetaRowSchema = z.strictObject({
  templateVersion: z.literal(TEMPLATE_VERSION),
  courseCode: CourseKeySchema,
  learningLanguages: z.array(localeKeySchema).min(1),
  studyMode: StudyModeSchema,
});

export const TemplateMediaRowSchema = z.strictObject({
  asset_key: AssetKeySchema,
  kind: z.enum(MEDIA_ASSET_KINDS),
  lesson_code: stableTokenSchema.nullable(),
  language: LocaleSchema.nullable(),
  relative_path: packageRelativePathSchema,
  thumbnail_of: AssetKeySchema.nullable(),
});

export const COURSE_INFO_FIELDS = [
  'title',
  'shortDescription',
  'overview',
  'whatYouLearn',
  'provides',
] as const;
export type CourseInfoField = (typeof COURSE_INFO_FIELDS)[number];

export const TemplateCourseInfoRowSchema = z.strictObject({
  field: z.enum(COURSE_INFO_FIELDS),
  language: LocaleSchema,
  text: nonEmptyTextSchema,
});

export const TemplateLessonRowSchema = z.strictObject({
  lesson_code: stableTokenSchema,
  order: positiveIntSchema,
  language: LocaleSchema,
  title: nonEmptyTextSchema,
  description: nonEmptyTextSchema.nullable(),
});

/** 学习点只有稳定编号与标题；锚点时间由机器派生，模板无锚点列。 */
export const TemplateLearningPointRowSchema = z.strictObject({
  lesson_code: stableTokenSchema,
  lp_code: stableTokenSchema,
  language: LocaleSchema,
  title: nonEmptyTextSchema,
});

export const EXHIBIT_MEDIA_TYPES = [
  'image',
  'video',
  'audio',
  'model3d',
  'text',
] as const;
export type ExhibitMediaType = (typeof EXHIBIT_MEDIA_TYPES)[number];

export const TemplateExhibitRowSchema = z
  .strictObject({
    lesson_code: stableTokenSchema,
    exhibit_code: stableTokenSchema,
    media_type: z.enum(EXHIBIT_MEDIA_TYPES),
    asset_key: AssetKeySchema.nullable(),
    language: LocaleSchema,
    title: nonEmptyTextSchema,
    description: nonEmptyTextSchema.nullable(),
    source: nonEmptyTextSchema.nullable(),
  })
  .refine(
    (row) =>
      row.media_type === 'text'
        ? row.asset_key === null
        : row.asset_key !== null,
    'media_type text has no asset_key; other media types require one',
  );

export const READING_TYPES = ['book', 'article', 'paper', 'other'] as const;
export type ReadingType = (typeof READING_TYPES)[number];

export const TemplateReadingRowSchema = z.strictObject({
  lesson_code: stableTokenSchema,
  type: z.enum(READING_TYPES),
  title: nonEmptyTextSchema,
  author: nonEmptyTextSchema.nullable(),
  why: nonEmptyTextSchema.nullable(),
});

export const TemplateKnowledgeTestRowSchema = z.strictObject({
  lesson_code: stableTokenSchema,
  order: positiveIntSchema,
  language: LocaleSchema,
  question: nonEmptyTextSchema,
  reference_answer: nonEmptyTextSchema,
});

export const TemplateApplicationTestRowSchema = z.strictObject({
  lesson_code: stableTokenSchema,
  language: LocaleSchema,
  question: nonEmptyTextSchema,
  reference_answer: nonEmptyTextSchema,
});

/**
 * 机器可读 sheet 清单（顺序即生成顺序）。Checklist 不在此列：
 * 它只是人工工作流，不作为导入依据（B1）。
 */
export const TEMPLATE_V2_SHEET_SCHEMAS = {
  Meta: TemplateMetaRowSchema,
  Media: TemplateMediaRowSchema,
  'Course Info': TemplateCourseInfoRowSchema,
  Lessons: TemplateLessonRowSchema,
  'Learning Points': TemplateLearningPointRowSchema,
  Exhibits: TemplateExhibitRowSchema,
  'Reading List': TemplateReadingRowSchema,
  'Knowledge Test': TemplateKnowledgeTestRowSchema,
  'Application Test': TemplateApplicationTestRowSchema,
} as const;

export type TemplateV2SheetName = keyof typeof TEMPLATE_V2_SHEET_SCHEMAS;

function headersOf<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
): readonly string[] {
  return Object.keys(schema.shape);
}

/** 每张机器 sheet 的列名（由 schema shape 派生，不手写第二份）。 */
export const TEMPLATE_V2_HEADERS = {
  Meta: headersOf(TemplateMetaRowSchema),
  Media: headersOf(TemplateMediaRowSchema),
  'Course Info': headersOf(TemplateCourseInfoRowSchema),
  Lessons: headersOf(TemplateLessonRowSchema),
  'Learning Points': headersOf(TemplateLearningPointRowSchema),
  Exhibits: headersOf(TemplateExhibitRowSchema),
  'Reading List': headersOf(TemplateReadingRowSchema),
  'Knowledge Test': headersOf(TemplateKnowledgeTestRowSchema),
  'Application Test': headersOf(TemplateApplicationTestRowSchema),
} as const satisfies Record<TemplateV2SheetName, readonly string[]>;

/** 仅供文档/人工工作流使用，不属于机器契约。 */
export const TEMPLATE_V2_HUMAN_SHEETS = ['Checklist'] as const;

/**
 * 疑似时间列：任何命中即视为人工时间输入（C5 P1 HUMAN_TIME_FORBIDDEN）。
 * 英文与中文词都覆盖；按词边界匹配，避免误伤 description 之类的普通列。
 */
export const TIME_COLUMN_HEADER_PATTERN =
  /(?:^|[^a-z])(?:times?|timestamps?|durations?|seconds?|minutes?|clock|ms|start|end|trigger|时间|时长|秒|分钟|开始|结束|触发)(?:[^a-z]|$)|mm:ss|hh:mm/i;

export function findHumanTimeColumns(headers: readonly string[]): string[] {
  return headers.filter((header) => TIME_COLUMN_HEADER_PATTERN.test(header));
}

/** 解析器在读取表头后调用；命中即整包拒绝，不 clamp、不重解释。 */
export function assertNoHumanTimeColumns(headers: readonly string[]): void {
  const offenders = findHumanTimeColumns(headers);
  if (offenders.length > 0) {
    throw new PartCError(
      'HUMAN_TIME_FORBIDDEN',
      'template must not contain human time columns',
      { columns: offenders },
    );
  }
}

/** Meta 版本守卫：缺失/非 2 → TEMPLATE_FORMAT_UNSUPPORTED（C5 P1）。 */
export function parseTemplateMetaRow(input: unknown) {
  const parsed = TemplateMetaRowSchema.safeParse(input);
  if (!parsed.success) {
    throw new PartCError(
      'TEMPLATE_FORMAT_UNSUPPORTED',
      'template does not satisfy the v2 machine contract',
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return parsed.data;
}
