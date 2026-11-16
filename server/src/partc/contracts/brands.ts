import { z } from 'zod';

/**
 * Part C 稳定键与时间字段的品牌类型（设计 §14 C3）。
 *
 * 品牌类型只承担两件事：
 * 1. 在类型层区分语义相近的字符串/数字（courseKey 不会被误传成 stageKey）；
 * 2. 所有入口先经 smart constructor 校验，非法值在边界即被拒绝。
 *
 * 红线（C0）：时间只以整数毫秒出现（TimeMs），媒体身份 = assetKey + assetVersion，
 * 不使用任何内容摘要作为身份或工件绑定。
 */

/** 稳定键：字母数字开头，允许 . _ -，长度 1..128；不含空白与路径分隔符。 */
export const STABLE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** BCP-47 风格的 locale key，例如 en-GB、zh-CN、en。 */
export const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Z][a-zA-Z]{1,7})*$/;

/** 时间点/时长：整数毫秒，非负。媒体时间线是物理事实，见 C7。 */
export const TimeMsSchema = z
  .number()
  .int('TimeMs must be an integer number of milliseconds')
  .nonnegative('TimeMs must be >= 0')
  .brand<'TimeMs'>();

export const CourseKeySchema = z
  .string()
  .regex(STABLE_KEY_PATTERN, 'courseKey must be a stable key')
  .brand<'CourseKey'>();

export const StageKeySchema = z
  .string()
  .regex(STABLE_KEY_PATTERN, 'stageKey must be a stable key')
  .brand<'StageKey'>();

export const ContentKeySchema = z
  .string()
  .regex(STABLE_KEY_PATTERN, 'contentKey must be a stable key')
  .brand<'ContentKey'>();

export const AssetKeySchema = z
  .string()
  .regex(STABLE_KEY_PATTERN, 'assetKey must be a stable key')
  .brand<'AssetKey'>();

export const LocaleSchema = z
  .string()
  .regex(LOCALE_PATTERN, 'locale must look like en-GB / zh-CN / en')
  .brand<'Locale'>();

export type TimeMs = z.infer<typeof TimeMsSchema>;
export type CourseKey = z.infer<typeof CourseKeySchema>;
export type StageKey = z.infer<typeof StageKeySchema>;
export type ContentKey = z.infer<typeof ContentKeySchema>;
export type AssetKey = z.infer<typeof AssetKeySchema>;
export type Locale = z.infer<typeof LocaleSchema>;

/** 校验失败抛 ZodError；成功返回品牌值。 */
export function timeMs(value: number): TimeMs {
  return TimeMsSchema.parse(value);
}

export function courseKey(value: string): CourseKey {
  return CourseKeySchema.parse(value);
}

export function stageKey(value: string): StageKey {
  return StageKeySchema.parse(value);
}

export function contentKey(value: string): ContentKey {
  return ContentKeySchema.parse(value);
}

export function assetKey(value: string): AssetKey {
  return AssetKeySchema.parse(value);
}

export function locale(value: string): Locale {
  return LocaleSchema.parse(value);
}

/**
 * 课程局部内容键的课程级命名空间注入（R14 缺陷修复）。
 *
 * lesson 的模板 lesson_code 是课程局部语义（同一模板可被多门课复用），但
 * pc_content_spec/pc_block/pc_rendition 的键是全局唯一的：不加命名空间时，
 * 同模板第二门课的导入会把这些行 upsert 改属给后导入的课程（静默覆盖）。
 * 因此主 contentKey 一律按 `${courseKey}.${lessonCode}` 合成，附属 spec 键从
 * 主键派生（`${main}.reading` / `.knowledge-test` / `.application-test`）。
 * 导出侧（partc-export）与导入侧（compiler/align、compiler/validate、
 * exporter 的 Pc 真源加载、partc-import 的投影）共用同一公式，保证
 * 导出→导入→再导出稳定往返。不使用任何内容哈希。
 *
 * courseKey 与 lessonCode 均已被 STABLE_KEY_PATTERN 约束，合成结果仍是
 * 合法稳定键。
 */
export function partcContentKey(
  courseKeyValue: string,
  lessonCode: string,
): string {
  return `${courseKeyValue}.${lessonCode}`;
}
