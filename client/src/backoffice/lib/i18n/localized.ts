/**
 * 库里数据的多语言模板（前端一半）。形状与取值规则见
 * server/src/common/i18n/localized.ts；两边用同一份用例锁住
 * （tests/fixtures/localized.cases.json）。
 *
 * 前端不保存任何库里数据的译文：显示名一律从接口返回的 localized 取。
 */

export const DEFAULT_LANGUAGE = 'en-GB'

/** { 语言: { 字段: 文本 } } */
export type Localized<F extends string = string> = Record<string, Partial<Record<F, string>>>

const baseLanguage = (language: string) => language.split('-')[0].toLowerCase()

/** 当前语言 → 同一主语言的其它地区 → en-GB → 兜底值。 */
export function pickLocalized<F extends string>(
  localized: Localized<F> | null | undefined,
  field: F,
  language: string,
  fallback: string,
): string {
  const texts = localized ?? {}
  const textIn = (lang: string) => (texts[lang]?.[field]?.trim() ? texts[lang]?.[field] : undefined)
  const exact = textIn(language)
  if (exact) return exact
  const sibling = Object.keys(texts)
    .sort()
    .find((lang) => baseLanguage(lang) === baseLanguage(language) && textIn(lang))
  if (sibling) return textIn(sibling) as string
  return textIn(DEFAULT_LANGUAGE) ?? fallback
}

/** 带稳定键 name 的行（分类等）在当前语言下的显示名。 */
export function localizedName(
  language: string,
  row: { name: string; localized?: Localized<'name'> | null } | null | undefined,
): string {
  if (!row?.name) return ''
  return pickLocalized(row.localized, 'name', language, row.name)
}
