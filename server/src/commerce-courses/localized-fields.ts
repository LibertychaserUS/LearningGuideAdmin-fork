import { parseLocalized, type Localized } from '../common/i18n/localized';

/**
 * 课程模块里各张表的可翻译字段（通用多语言模板，见 common/i18n/localized.ts）。
 * 新增一张带多语言显示名的表：在这里声明字段，读写都走 parseLocalized / pickLocalized。
 */

/** 展品（Exhibit.localized）的可翻译字段。 */
export const EXHIBIT_FIELDS = ['title', 'description'] as const;

/** 首页 Discovery Banner（DiscoveryBanner.localized）的可翻译字段。 */
export const BANNER_FIELDS = ['headline', 'subheading', 'buttonLabel'] as const;

/** 分类的可翻译字段（通用多语言模板，见 common/i18n/localized.ts）。 */
export const CATEGORY_FIELDS = ['name', 'description'] as const;
export type CategoryField = (typeof CATEGORY_FIELDS)[number];

export interface CategoryRef {
  id: string;
  /** 稳定键：导入按它匹配，某语言没有显示名时兜底显示。 */
  name: string;
  localized: Localized<CategoryField>;
}

export function categoryRef(
  entry: { id: string; name: string; localized?: unknown } | null | undefined,
): CategoryRef | null {
  if (!entry) return null;
  return {
    id: entry.id,
    name: entry.name,
    localized: parseLocalized(entry.localized, CATEGORY_FIELDS),
  };
}
