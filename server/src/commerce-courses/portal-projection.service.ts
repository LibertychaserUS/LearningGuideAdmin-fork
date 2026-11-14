import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  captureVersionSnapshot,
  type VersionSnapshot,
} from './version-snapshot';
import { CATEGORY_FIELDS, type CategoryField } from './localized-fields';
import { parseLocalized, type Localized } from '../common/i18n/localized';
import { findCategoryByPath, snapshotCategoryPath } from './category-path';

type SnapshotLesson = VersionSnapshot['course']['lessons'][number];
type SnapshotLocalization = VersionSnapshot['course']['localizations'][number];

/** C1 的 Portal 分类节点（不含任何环境 UUID）。 */
export interface CatalogueTreeNode {
  name: string;
  localized: Localized<CategoryField>;
  sortOrder: number;
  children: CatalogueTreeNode[];
}

/**
 * Portal v1 只读投影（设计文档 §22.2）：从 v2 数据重建 Portal 课程详情。
 *
 * P1b：线上内容来自 **live version 快照**，而不是工作区行。
 * 这样保存草稿不会提前改变 Portal，Publish 后才切换。
 */
@Injectable()
export class PortalProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * C1：Portal 分类读接口的数据源（只含 ACTIVE，按 sortOrder 升序、同序按 name）。
   * 契约不暴露 UUID——Portal 只拿稳定键 name/localized/sortOrder/children（§4 C1）。
   */
  async listCategoryTree(): Promise<CatalogueTreeNode[]> {
    const rows = await this.prisma.courseCatalogueEntry.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        localized: true,
        sortOrder: true,
        parentId: true,
      },
    });
    const nodeById = new Map<string, CatalogueTreeNode>();
    for (const row of rows) {
      nodeById.set(row.id, {
        name: row.name,
        localized: parseLocalized(row.localized, CATEGORY_FIELDS),
        sortOrder: row.sortOrder,
        children: [],
      });
    }
    const roots: CatalogueTreeNode[] = [];
    for (const row of rows) {
      const node = nodeById.get(row.id);
      if (!node) continue;
      if (row.parentId === null) {
        roots.push(node);
        continue;
      }
      const parent = nodeById.get(row.parentId);
      // 父节点必须是 ACTIVE 且出现在本次结果里（I6：退场节点及其子树不投影）。
      if (parent) parent.children.push(node);
    }
    return roots;
  }

  async listCourses(limit = 50) {
    const rows = await this.prisma.commerceCourse.findMany({
      where: {
        liveStatus: 'ONLINE',
        liveVersionId: { not: null },
        archivedAt: null,
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: { category: true, cover: true, localizations: true },
    });
    const versions = await this.prisma.courseVersion.findMany({
      where: {
        id: {
          in: rows
            .map((row) => row.liveVersionId)
            .filter((id): id is string => Boolean(id)),
        },
      },
      select: { id: true, snapshotData: true },
    });
    const snapshotById = new Map(
      versions.map((version) => [
        version.id,
        version.snapshotData as unknown as VersionSnapshot,
      ]),
    );
    return Promise.all(
      rows.map(async (row) => {
        const snapshot = snapshotById.get(row.liveVersionId ?? '') ?? null;
        return this.toSummary(
          row,
          snapshot,
          await this.categoryForSnapshot(snapshot),
        );
      }),
    );
  }

  /**
   * C8：投影分类取线上版本快照的 categoryPath（发布时点），不读当前行——
   * 草稿改分类不影响线上；显示名（localized）取当前分类行。
   */
  private async categoryForSnapshot(
    snapshot: VersionSnapshot | null,
  ): Promise<{ name: string; localized: unknown } | null> {
    if (!snapshot) return null;
    const path = await snapshotCategoryPath(this.prisma, snapshot);
    if (!path || path.length === 0) return null;
    const row = await findCategoryByPath(this.prisma, path);
    return row ? { name: row.name, localized: row.localized } : null;
  }

  async getCourseById(id: string) {
    const row = await this.prisma.commerceCourse.findUnique({
      where: { id },
      include: {
        category: true,
        cover: true,
        localizations: true,
        trialRows: true,
        plans: {
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (
      !row ||
      row.liveStatus !== 'ONLINE' ||
      row.archivedAt ||
      !row.liveVersionId
    )
      return null;
    const version = await this.prisma.courseVersion.findUnique({
      where: { id: row.liveVersionId },
      select: { snapshotData: true },
    });
    if (!version) return null;
    const snapshot = version.snapshotData as unknown as VersionSnapshot;
    return this.toDetail(
      row,
      snapshot,
      await this.categoryForSnapshot(snapshot),
    );
  }

  /** 预览投影：草稿或指定版本，仅在 Portal preview token 校验通过后调用。 */
  async getPreviewCourse(courseId: string, versionId?: string) {
    const row = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      include: {
        category: true,
        cover: true,
        localizations: true,
        trialRows: true,
        plans: {
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!row || row.archivedAt) return null;

    let snapshot: VersionSnapshot;
    let versionLabel: string | null = null;
    if (versionId) {
      const version = await this.prisma.courseVersion.findFirst({
        where: { id: versionId, courseId },
        select: { snapshotData: true, versionLabel: true },
      });
      if (!version) return null;
      snapshot = version.snapshotData as unknown as VersionSnapshot;
      versionLabel = version.versionLabel;
    } else {
      snapshot = await captureVersionSnapshot(this.prisma, courseId);
    }

    return {
      ...this.toDetail(row, snapshot, await this.categoryForSnapshot(snapshot)),
      preview: {
        source: versionId ? 'version' : 'draft',
        versionLabel,
      },
    };
  }

  async getCoverBytes(courseId: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: {
        liveStatus: true,
        archivedAt: true,
        cover: { select: { storageKey: true, extension: true, size: true } },
      },
    });
    if (
      !course ||
      course.liveStatus !== 'ONLINE' ||
      course.archivedAt ||
      !course.cover
    )
      return null;
    return {
      storageKey: course.cover.storageKey,
      extension: course.cover.extension,
      size: course.cover.size,
    };
  }

  async getMediaBytes(courseId: string, assetId: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { liveStatus: true, archivedAt: true },
    });
    if (!course || course.liveStatus !== 'ONLINE' || course.archivedAt)
      return null;
    const asset = await this.prisma.courseMediaAsset.findFirst({
      where: { id: assetId, courseId },
      select: { storageKey: true, extension: true, size: true },
    });
    if (!asset) return null;
    return {
      storageKey: asset.storageKey,
      extension: asset.extension,
      size: asset.size,
    };
  }

  /** 预览媒体（草稿/指定版本）：只要课程未归档即可，不要求已 ONLINE。 */
  async getPreviewCoverBytes(courseId: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: {
        archivedAt: true,
        cover: { select: { storageKey: true, extension: true, size: true } },
      },
    });
    if (!course || course.archivedAt || !course.cover) return null;
    return {
      storageKey: course.cover.storageKey,
      extension: course.cover.extension,
      size: course.cover.size,
    };
  }

  async getPreviewMediaBytes(courseId: string, assetId: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { archivedAt: true },
    });
    if (!course || course.archivedAt) return null;
    const asset = await this.prisma.courseMediaAsset.findFirst({
      where: { id: assetId, courseId },
      select: { storageKey: true, extension: true, size: true },
    });
    if (!asset) return null;
    return {
      storageKey: asset.storageKey,
      extension: asset.extension,
      size: asset.size,
    };
  }

  private toSummary(
    row: {
      id: string;
      slug: string;
      code: string;
      subtitle: string | null;
      level: string | null;
      tags: unknown;
      referencePrice: number | null;
      discount: number | null;
      category: { name: string; localized: unknown } | null;
      localizations: SnapshotLocalization[];
      cover: { storageKey: string } | null;
    },
    snapshot: VersionSnapshot | null,
    category: { name: string; localized: unknown } | null,
  ) {
    const loc =
      this.pickLocalization(
        snapshot?.course.localizations,
        snapshot?.course.defaultContentLanguage,
      ) ?? row.localizations[0];
    const lessons = snapshot?.course.lessons ?? [];
    return {
      id: row.id,
      slug: snapshot?.course.slug ?? row.slug,
      code: snapshot?.course.code ?? row.code,
      title: loc?.title ?? row.slug,
      subtitle: row.subtitle ?? null,
      shortDescription: loc?.shortDescription ?? null,
      description: loc?.overview ?? null,
      // C8：分类来自线上版本快照的路径，不是当前行。
      category: category?.name ?? null,
      categoryLocalized: parseLocalized(category?.localized, CATEGORY_FIELDS),
      level: row.level ?? null,
      tags: row.tags ?? [],
      referencePrice: row.referencePrice ?? 0,
      discount: row.discount ?? 0,
      coverUrl: row.cover ? `/api/portal/v1/media/${row.id}/cover` : null,
      lessonCount: lessons.length,
      totalDurationSeconds: this.totalDuration(
        lessons,
        snapshot?.course.defaultContentLanguage,
      ),
      learningMode: snapshot?.course.learningMode ?? null,
      learningLanguages: snapshot?.course.learningLanguages ?? [],
    };
  }

  private toDetail(
    row: {
      id: string;
      slug: string;
      code: string;
      subtitle: string | null;
      level: string | null;
      tags: unknown;
      referencePrice: number | null;
      discount: number | null;
      category: { name: string; localized: unknown } | null;
      cover: { storageKey: string } | null;
      localizations: SnapshotLocalization[];
      trialEnabled: boolean;
      trialRows: Array<{
        lessonId: string;
        status: string;
        videoCutoffSeconds?: number | null;
        textCutoffLearningPointId?: string | null;
        confirmedTextCutoffCode?: string | null;
        videoCutoffByLanguage?: unknown;
        textCutoffByLanguage?: unknown;
      }>;
      plans: Array<{
        id: string;
        name: string;
        termMonths: number;
        amountMinor: number;
        currency: string;
        stripeLookupKey: string | null;
        trialEligible: boolean;
      }>;
    },
    snapshot: VersionSnapshot,
    category: { name: string; localized: unknown } | null,
  ) {
    const loc =
      this.pickLocalization(
        snapshot.course.localizations,
        snapshot.course.defaultContentLanguage,
      ) ?? row.localizations[0];
    const publicLessonIds = new Set(
      row.trialRows
        .filter((trial) => trial.status === 'READY')
        .map((trial) => trial.lessonId),
    );
    const trialRowByLesson = new Map(
      row.trialRows.map((trial) => [trial.lessonId, trial]),
    );
    const lessons = [...snapshot.course.lessons].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );
    return {
      id: row.id,
      slug: snapshot.course.slug ?? row.slug,
      code: snapshot.course.code ?? row.code,
      title: loc?.title ?? row.slug,
      subtitle: row.subtitle ?? null,
      shortDescription: loc?.shortDescription ?? null,
      description: loc?.overview ?? null,
      // C8：历史版本预览/详情用该版本快照的路径。
      category: category?.name ?? null,
      categoryLocalized: parseLocalized(category?.localized, CATEGORY_FIELDS),
      level: row.level ?? null,
      tags: row.tags ?? [],
      referencePrice: row.referencePrice ?? 0,
      discount: row.discount ?? 0,
      coverUrl: row.cover ? `/api/portal/v1/media/${row.id}/cover` : null,
      learningMode: snapshot.course.learningMode,
      learningLanguages: snapshot.course.learningLanguages ?? [],
      defaultContentLanguage: snapshot.course.defaultContentLanguage,
      whatYouLearn: loc?.whatYouLearn ?? [],
      provides: loc?.provides ?? [],
      lessonCount: lessons.length,
      totalDurationSeconds: this.totalDuration(
        lessons,
        snapshot.course.defaultContentLanguage,
      ),
      trial: {
        enabled: row.trialEnabled,
        lessonIds: [...publicLessonIds],
      },
      plans: row.plans.map((plan) => ({
        id: plan.id,
        name: plan.name,
        termMonths: plan.termMonths,
        amountMinor: plan.amountMinor,
        currency: plan.currency,
        lookupKey: plan.stripeLookupKey,
        trialEligible: plan.trialEligible,
      })),
      sections: [
        {
          id: 'all',
          title: 'Lessons',
          lessons: lessons.map((lesson) => {
            const lessonLoc = this.pickLocalization(
              lesson.localizations,
              snapshot.course.defaultContentLanguage,
            );
            const trialRow = trialRowByLesson.get(lesson.id);
            const isPublic = publicLessonIds.has(lesson.id);
            return {
              id: lesson.id,
              title: lessonLoc?.title ?? lesson.code,
              summary: lessonLoc?.description ?? null,
              durationSeconds: lessonLoc?.videoDurationSeconds ?? null,
              isPublic,
              // 试看截止点：正式 Portal 与 Admin 预览、学员视角预览共用同一份规则
              // （视频按秒、文本按截止 LP），避免三处各写一套。
              trial: isPublic
                ? {
                    videoCutoffSeconds: this.cutoffForLanguage(
                      trialRow?.videoCutoffByLanguage,
                      trialRow?.videoCutoffSeconds ?? null,
                      lessonLoc?.language,
                    ),
                    textCutoffLearningPointId:
                      trialRow?.textCutoffLearningPointId ?? null,
                    textCutoffCode: trialRow?.confirmedTextCutoffCode ?? null,
                  }
                : null,
              contents: this.rebuildContents(lesson, snapshot, row.id),
            };
          }),
        },
      ],
    };
  }

  private rebuildContents(
    lesson: SnapshotLesson,
    snapshot: VersionSnapshot,
    courseId: string,
  ) {
    const loc = this.pickLocalization(
      lesson.localizations,
      snapshot.course.defaultContentLanguage,
    );
    const contents: unknown[] = [];
    if (loc?.videoAssetId) {
      contents.push({
        id: `${lesson.code}-video`,
        title: '',
        type: 'video',
        mode: 'lecture',
        url: this.mediaUrl(courseId, loc.videoAssetId),
        nodes: lesson.exhibits.map((exhibit) => {
          const trigger = lesson.triggers.find(
            (entry) =>
              entry.exhibitCode === exhibit.code &&
              entry.language === loc.language,
          );
          return {
            id: exhibit.code,
            title: exhibit.code,
            type: this.mapExhibitType(exhibit.type),
            url: exhibit.mediaAssetId
              ? this.mediaUrl(courseId, exhibit.mediaAssetId)
              : undefined,
            triggerTime: trigger?.timeSeconds ?? 0,
          };
        }),
      });
    }
    if (loc?.textHtml) {
      contents.push({
        id: `${lesson.code}-text`,
        title: '',
        type: 'text',
        mode: 'lecture',
        html: loc.textHtml,
        nodes: [],
      });
    }
    return contents;
  }

  private mediaUrl(courseId: string, assetId: string): string {
    return `/api/portal/v1/media/${courseId}/assets/${assetId}`;
  }

  /** 按语言取视频截止秒数，缺省回退到单语言字段。 */
  private cutoffForLanguage(
    byLanguage: unknown,
    fallback: number | null,
    language: string | undefined,
  ): number | null {
    if (byLanguage && typeof byLanguage === 'object') {
      const map = byLanguage as Record<string, unknown>;
      const value = language ? map[language] : undefined;
      if (typeof value === 'number') return value;
      if (value === null) return null;
    }
    return fallback;
  }

  private pickLocalization<T extends { language: string }>(
    entries: T[] | undefined,
    language: string | undefined,
  ): T | undefined {
    if (!entries?.length) return undefined;
    return entries.find((entry) => entry.language === language) ?? entries[0];
  }

  private totalDuration(
    lessons: SnapshotLesson[],
    language: string | undefined,
  ): number {
    return lessons.reduce((sum, lesson) => {
      const loc = this.pickLocalization(lesson.localizations, language);
      return sum + (loc?.videoDurationSeconds ?? 0);
    }, 0);
  }

  private mapExhibitType(type: string): string {
    if (type === 'IMAGE') return 'image';
    if (type === 'VIDEO') return 'video';
    if (type === 'MODEL3D') return 'model3d';
    return 'image';
  }
}
