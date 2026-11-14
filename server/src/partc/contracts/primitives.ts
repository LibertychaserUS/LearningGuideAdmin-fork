import { z } from 'zod';
import { LOCALE_PATTERN, STABLE_KEY_PATTERN } from './brands';

/**
 * Part C 契约共用基础类型（设计 §14 C1/C3）。
 *
 * 只放跨实体复用、语义封闭的部件：稳定 token、本地化模板、UTC 时间戳、
 * 包内相对路径、分类路径。实体的枚举各自定义在所属实体文件里。
 */

export const nonEmptyTextSchema = z.string().min(1);

/** 未品牌化的稳定键（用于 renditionKey/alignmentId/blockId 等内部标识）。 */
export const stableTokenSchema = z
  .string()
  .regex(STABLE_KEY_PATTERN, 'must be a stable token');

/** 供 record 键使用的 locale 形态（不叠加品牌）。 */
export const localeKeySchema = z.string().regex(LOCALE_PATTERN);

export const positiveIntSchema = z.number().int().positive();
export const nonNegativeIntSchema = z.number().int().nonnegative();

/**
 * 派生/审计参数的取值（JSON 标量；确定性 JSON 可比较，C7/C10.6）。
 * 用于 ASR 参数 pin 与 Alignment 的时间源审计元组；不参与内容身份。
 */
export const AuditParamValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export type AuditParamValue = z.infer<typeof AuditParamValueSchema>;

export const AuditParamsSchema = z.record(z.string(), AuditParamValueSchema);

export type AuditParams = z.infer<typeof AuditParamsSchema>;

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * 审计时间戳：ISO 8601 UTC（必须带 Z）。
 * 只用于审计记录（frozenAt/approvedAt/occurredAt/receivedAt 等），
 * 绝不进入 Plan 的 canonical bytes（C6）。
 */
export const isoUtcSchema = z
  .string()
  .regex(ISO_UTC_PATTERN, 'must be an ISO 8601 UTC timestamp ending in Z')
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    'must be a real instant',
  );

/**
 * 包内相对路径：非绝对、无反斜杠、无 . 与 .. 段。包是闭合契约（B8），
 * 文件只按 manifest 声明寻址，不做目录剥除或文件名推断。
 */
export const packageRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('\\') &&
      !value.includes('\\') &&
      value
        .split('/')
        .every(
          (segment) => segment !== '' && segment !== '.' && segment !== '..',
        ),
    'must be a closed-package relative path without traversal segments',
  );

/**
 * 本地化通用模板 {lang:{field:text}}（Admin 全库统一形态，见 i18n 约定）。
 * keys 为 locale、values 为字段字典；至少一个 locale。
 */
export const LocalizedTemplateSchema = z
  .record(localeKeySchema, z.record(stableTokenSchema, z.string().min(1)))
  .refine(
    (value) => Object.keys(value).length > 0,
    'localized template must contain at least one locale',
  );

export type LocalizedTemplate = z.infer<typeof LocalizedTemplateSchema>;

/**
 * 双语字段（B2.4）：en-GB 与 zh-CN 必须齐全，字段名由调用方固定。
 * 模板形态为 {lang:{field:text}}。
 */
export function bilingualFieldSchema(field: string) {
  const inner = () => z.strictObject({ [field]: nonEmptyTextSchema });
  return z.strictObject({
    'en-GB': inner(),
    'zh-CN': inner(),
  });
}

/** 分类稳定键路径（C3 Course / C7 / Part A I9）：null 表示未分类。 */
export const CategoryPathSchema = z.array(nonEmptyTextSchema).min(1).nullable();

/**
 * 发布目标（C3 Course）：languages 为有序回退链，modalities 为交付模态。
 * 空 publishTargets = 不可发布（发布门在编译器/发布门实现）。
 */
export const DeliveryModalitySchema = z.enum(['video', 'text']);
export type DeliveryModality = z.infer<typeof DeliveryModalitySchema>;

export const PublishTargetSchema = z.strictObject({
  languages: z.array(z.string().regex(LOCALE_PATTERN)).min(1),
  modalities: z.array(DeliveryModalitySchema).min(1),
});

export type PublishTarget = z.infer<typeof PublishTargetSchema>;

/** 课程学习模式稳定 key（B1 Meta：video/text/both）。 */
export const StudyModeSchema = z.enum(['video', 'text', 'both']);
export type StudyMode = z.infer<typeof StudyModeSchema>;

/** 内容块被承载的模态（C3 Rendition：语言 × 模态 × 载体）。 */
export const ContentModalitySchema = z.enum([
  'text',
  'video',
  'audio',
  'image',
  'model3d',
]);
export type ContentModality = z.infer<typeof ContentModalitySchema>;
