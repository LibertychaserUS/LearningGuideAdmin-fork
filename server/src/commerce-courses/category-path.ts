import { UnprocessableEntityException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CATEGORY_FIELDS } from './localized-fields';
import { parseLocalized } from '../common/i18n/localized';

/**
 * 分类稳定键路径解析（设计 SSOT §3 I1–I5、§4 C5/C7、§14 C10）。
 *
 * 稳定键 = 分类路径（`name` 序列）；解析只认 ACTIVE 节点，逐级按
 * `name` 或 `localized` 的任一语言显示名匹配（trim、大小写不敏感）。
 * 找不到返回 null，由调用方决定错误码（导入/恢复 = CATEGORY_NOT_FOUND），
 * 绝不创建分类、不造占位分类（M5）。
 */

export interface CategoryNodeRow {
  id: string;
  name: string;
  localized: unknown;
  parentId: string | null;
  status: string;
  sortOrder: number;
}

/** C5/C7：分类路径在本环境解析失败（不创建分类、不静默置空）。 */
export class CategoryResolutionError extends UnprocessableEntityException {
  readonly unresolvedPath: string[] | null;
  constructor(path: string[] | null, detail?: string) {
    const label = path && path.length ? path.join(' / ') : '(unknown)';
    super({
      code: 'CATEGORY_NOT_FOUND',
      message: detail ?? `Category path does not resolve: ${label}`,
      unresolvedPath: path,
    });
    this.unresolvedPath = path;
  }
}

/** PrismaService / TransactionClient 共同的最小查询面。 */
type CategoryReader = PrismaService | Prisma.TransactionClient;

const normalise = (value: string): string => value.trim().toLowerCase();

function matchesSegment(row: CategoryNodeRow, segment: string): boolean {
  if (normalise(row.name) === normalise(segment)) return true;
  const localized = parseLocalized(row.localized, CATEGORY_FIELDS);
  return Object.values(localized).some(
    (entry) =>
      typeof entry.name === 'string' &&
      normalise(entry.name) === normalise(segment),
  );
}

const CATEGORY_SELECT = {
  id: true,
  name: true,
  localized: true,
  parentId: true,
  status: true,
  sortOrder: true,
} as const;

/**
 * 逐级解析分类路径；任一级找不到（或不是 ACTIVE）返回 null。
 * 同一父下的多个匹配按 sortOrder、name 排序取第一个（稳定确定性）。
 */
export async function findCategoryByPath(
  db: CategoryReader,
  path: readonly string[],
): Promise<CategoryNodeRow | null> {
  if (path.length === 0) return null;
  let parentId: string | null = null;
  let matched: CategoryNodeRow | null = null;
  for (const segment of path) {
    const rows: CategoryNodeRow[] = await db.courseCatalogueEntry.findMany({
      where: { parentId, status: 'ACTIVE' },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: CATEGORY_SELECT,
    });
    const exact: CategoryNodeRow | undefined = rows.find(
      (row) => normalise(row.name) === normalise(segment),
    );
    const found: CategoryNodeRow | undefined =
      exact ?? rows.find((row) => matchesSegment(row, segment));
    if (!found) return null;
    parentId = found.id;
    matched = found;
  }
  return matched;
}

/** 解析单个分类 id（v2 快照回读）；只做存在性解析，不要求 ACTIVE。 */
export async function findCategoryById(
  db: CategoryReader,
  id: string,
): Promise<CategoryNodeRow | null> {
  return db.courseCatalogueEntry.findUnique({
    where: { id },
    select: CATEGORY_SELECT,
  });
}

/** 由分类 id 生成稳定键路径（祖先在前）；分类不存在返回 null。 */
export async function categoryPathForId(
  db: CategoryReader,
  categoryId: string | null,
): Promise<string[] | null> {
  if (!categoryId) return null;
  const segments: string[] = [];
  let current = await findCategoryById(db, categoryId);
  if (!current) return null;
  let guard = 0;
  while (current && guard < 16) {
    segments.unshift(current.name);
    current = current.parentId
      ? await findCategoryById(db, current.parentId)
      : null;
    guard += 1;
  }
  return segments;
}

/**
 * 快照 → 分类路径（C7/I9）：v3 直接读 `categoryPath`；v2 按 `categoryId`
 * 在本环境解析一次（找不到返回 null，由调用方决定是否报错）。
 */
export async function snapshotCategoryPath(
  db: CategoryReader,
  snapshot: {
    course: {
      categoryPath?: string[] | null;
      categoryId?: string | null;
    };
  },
): Promise<string[] | null> {
  // v2 快照带 categoryId 键（值可为 null）；v3 不写该键，只写 categoryPath。
  if (Object.prototype.hasOwnProperty.call(snapshot.course, 'categoryId')) {
    return categoryPathForId(db, snapshot.course.categoryId ?? null);
  }
  return snapshot.course.categoryPath ?? null;
}
