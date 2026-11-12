/**
 * 库里数据的多语言模板（与 Exhibit.localized、DiscoveryBanner.localized 同一形状）。
 *
 * 一行数据的可翻译字段统一存在一个 JSON 列 `localized` 里：
 *
 *   { "en-GB": { "name": "Society" }, "zh-CN": { "name": "社会" } }
 *
 * - 第一层键是 BCP 47 语言代码，第二层是字段名；所有语言地位相同，没有"主语言列 + 译文表"。
 * - 行自己的稳定键（如分类的 name）只用于匹配与兜底显示，不参与翻译。
 * - 加一种语言、加一个可翻译字段都不改表结构；前端不保存任何库里数据的译文。
 * - 取值规则只有一条，前后端各实现一份，用同一份用例锁住（localized.cases.json，
 *   client/tests/fixtures 里有逐字节相同的副本）：
 *   当前语言 → 同一主语言的其它地区（zh-CN 可用 zh-TW）→ 默认语言 en-GB → 兜底值。
 *
 * 新增一个需要多语言显示名的表：加 `localized Json @default("{}")`，接口原样返回
 * parseLocalized 的结果，界面用 pickLocalized / localizedName 取当前语言。
 */

export const DEFAULT_LANGUAGE = 'en-GB';

/** Admin 后台与课程内容支持的语言（唯一来源）。 */
export const LANGUAGES = ['en-GB', 'zh-CN'] as const;
export type Language = (typeof LANGUAGES)[number];

/** { 语言: { 字段: 文本 } } */
export type Localized<F extends string = string> = Record<
  string,
  Partial<Record<F, string>>
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 把库里的 JSON 收成模板形状：只留给定字段里的非空字符串，空语言丢掉。 */
export function parseLocalized<F extends string>(
  value: unknown,
  fields: readonly F[],
): Localized<F> {
  const result: Localized<F> = {};
  if (!isRecord(value)) return result;
  for (const [language, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const kept: Partial<Record<F, string>> = {};
    for (const field of fields) {
      const text = entry[field];
      if (typeof text === 'string' && text.trim()) kept[field] = text;
    }
    if (Object.keys(kept).length) result[language] = kept;
  }
  return result;
}

const baseLanguage = (language: string) => language.split('-')[0].toLowerCase();

/** 按当前语言取一个字段；规则见文件头。 */
export function pickLocalized<F extends string>(
  localized: Localized<F> | null | undefined,
  field: F,
  language: string,
  fallback: string,
): string {
  const texts = localized ?? {};
  const textIn = (lang: string) =>
    texts[lang]?.[field]?.trim() ? texts[lang]?.[field] : undefined;
  const exact = textIn(language);
  if (exact) return exact;
  const sibling = Object.keys(texts)
    .sort()
    .find(
      (lang) => baseLanguage(lang) === baseLanguage(language) && textIn(lang),
    );
  if (sibling) return textIn(sibling) as string;
  return textIn(DEFAULT_LANGUAGE) ?? fallback;
}

/** 每种必填语言里缺哪些字段（空白算缺）；全齐返回空数组。 */
export function missingLocalized<F extends string>(
  localized: Localized<F> | null | undefined,
  fields: readonly F[],
  languages: readonly string[] = LANGUAGES,
): Array<{ language: string; field: F }> {
  const missing: Array<{ language: string; field: F }> = [];
  for (const language of languages) {
    for (const field of fields) {
      if (!localized?.[language]?.[field]?.trim()) {
        missing.push({ language, field });
      }
    }
  }
  return missing;
}
