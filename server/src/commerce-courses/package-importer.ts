import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { PackageManifest, PackageExhibit } from './contracts/manifest';
import type { PackageManifestV2 } from '../partc/contracts/package-manifest';
import { parsePackage } from '../partc/compiler/parse';
import { PartCError } from '../partc/errors';
import { CourseStorageService } from './storage.service';
import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';
import { validateMediaFile } from './media-validate';
import {
  applyVersionSnapshotInTx,
  type VersionSnapshot,
} from './version-snapshot';
import { findCategoryByPath, CategoryResolutionError } from './category-path';
import { HISTORY_ACTIONS } from './publishing.service';
import {
  buildPartcVersionSnapshot,
  compilePartcPackageFromIr,
  decodeTemplateWorkbook,
  extractPartcDocuments,
  isPartCV2Manifest,
  persistPartcEntities,
  templateResourcePathOf,
  PartcCompileError,
  reportFromPartCError,
} from './partc-import';
import { extractAsrTranscripts } from './asr-adapter';

/**
 * 并发导入同一课程时的唯一键竞争：Prisma P2002（CommerceCourse.code）必须映射
 * 为可识别的 409 `PACKAGE_CONFLICT`，而不是 500。事务已整体回滚（无半成品）。
 */
function asImportConflict(error: unknown): unknown {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  ) {
    const rawTarget = (error as { meta?: { target?: unknown } }).meta?.target;
    const target = Array.isArray(rawTarget)
      ? rawTarget.map(String)
      : typeof rawTarget === 'string' || typeof rawTarget === 'number'
        ? [String(rawTarget)]
        : [];
    if (target.some((entry) => entry.includes('code'))) {
      return new ImportError(
        'PACKAGE_CONFLICT',
        409,
        'Course ID was created by a concurrent import; the second import is refused (no partial rows were written).',
      );
    }
  }
  return error;
}

export interface ImportOptions {
  onConflict: 'ABORT' | 'CREATE_NEW_COURSE' | 'NEW_VERSION';
  reassignCodes: boolean;
  actorEmployeeId: string | null;
}

export class ImportError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public report?: {
      errors: Array<{
        level: 'error' | 'warning';
        code: string;
        message: string;
        path?: string;
      }>;
      warnings: Array<{
        level: 'error' | 'warning';
        code: string;
        message: string;
        path?: string;
      }>;
      incomplete: boolean;
    },
  ) {
    super(message);
  }
}

interface ImportedMediaMeta {
  assetId: string;
  kind: string;
  extension: string;
  storageKey: string;
  mimeType: string;
  size: number;
  originalName: string;
}

/**
 * 把已校验的课程包写入数据库（媒体先转存再到 DB，失败回滚）。
 * 结果固定创建 Working copy / HIDDEN（跨环境状态不搬运，见 §17.2）。
 */
@Injectable()
export class PackageImporter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CourseStorageService,
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {}

  async importPackage(
    manifestRaw: PackageManifest | PackageManifestV2,
    files: Map<string, Buffer>,
    options: ImportOptions,
  ): Promise<{ courseId: string }> {
    if (isPartCV2Manifest(manifestRaw)) {
      return this.importPartcPackage(manifestRaw, files, options);
    }
    const manifest = manifestRaw;
    const { course } = manifest;

    // 冲突检测：Course ID（课程身份）与 slug（URL 标识）要分开判断。
    // - Course ID 已存在 → 按冲突策略处理（拒绝 / NEW_VERSION 未实现）；
    // - 仅 slug 撞车（Course ID 唯一）→ 自动追加序号生成唯一 slug，
    //   绝不能把「标题 slug 相同」误报成「Course ID 已存在」而拒绝导入。
    const targetCode = course.code;
    let targetSlug = course.slug;
    const existingByCode = await this.prisma.commerceCourse.findFirst({
      where: { code: course.code },
      select: { id: true, code: true },
    });
    if (existingByCode) {
      // PRD §9.2 / §16.3：Course ID 已存在时必须拒绝导入；已有课程请使用 Import package。
      if (
        options.onConflict === 'ABORT' ||
        options.onConflict === 'CREATE_NEW_COURSE'
      ) {
        throw new ImportError(
          'PACKAGE_CONFLICT',
          409,
          `Course ${existingByCode.code} already exists. The Course ID must not already exist in this Admin, or the import is refused.`,
        );
      }
      // NEW_VERSION 暂未实现，按冲突处理
      if (options.onConflict === 'NEW_VERSION') {
        throw new ImportError(
          'PACKAGE_CONFLICT',
          409,
          'NEW_VERSION import not implemented yet.',
        );
      }
    }
    const slugOwner = await this.prisma.commerceCourse.findFirst({
      where: { slug: targetSlug },
      select: { id: true },
    });
    if (slugOwner) {
      targetSlug = await this.uniqueSlug(targetSlug);
    }

    const courseId = randomUUID();
    const mediaKeyMap = new Map<string, ImportedMediaMeta>();

    // 1) 媒体转存
    try {
      await this.transferMedia(courseId, manifest, files, mediaKeyMap);
    } catch (error) {
      await this.rollbackMedia(courseId, mediaKeyMap);
      throw error;
    }

    // 2) DB 写入（C5：分类解析与课程写入同一事务；解析失败整体回滚，
    //    不创建分类、不留孤儿）
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const categoryId = await this.resolveCategoryPath(tx, course);
          await this.writeCourse(
            tx,
            courseId,
            { targetCode, targetSlug, categoryId },
            manifest,
            mediaKeyMap,
          );
        },
        { timeout: 60_000 },
      );
    } catch (error) {
      await this.rollbackMedia(courseId, mediaKeyMap);
      throw asImportConflict(error);
    }

    return { courseId };
  }

  /**
   * 导入到已有课程（PRD §16，CM16）：只替换草稿，线上版本不变。
   * Course ID 必须一致；试看与价格按包更新；价格稍后由调用方在本环境 Stripe 重新创建。
   */
  async importIntoExistingCourse(
    courseId: string,
    manifestRaw: PackageManifest | PackageManifestV2,
    files: Map<string, Buffer>,
    actorEmployeeId: string | null,
  ): Promise<{ courseId: string }> {
    if (isPartCV2Manifest(manifestRaw)) {
      return this.importPartcIntoExistingCourse(
        courseId,
        manifestRaw,
        files,
        actorEmployeeId,
      );
    }
    const manifest = manifestRaw;
    const existing = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { id: true, code: true },
    });
    if (!existing)
      throw new ImportError('COURSE_NOT_FOUND', 404, 'Course not found.');
    if (existing.code !== manifest.course.code) {
      throw new ImportError(
        'PACKAGE_COURSE_ID_MISMATCH',
        422,
        'The Course ID in the package must match this course, or the import is refused.',
      );
    }

    const mediaKeyMap = new Map<string, ImportedMediaMeta>();
    try {
      await this.transferMedia(courseId, manifest, files, mediaKeyMap);
      // 媒体资产必须先落库，applyVersionSnapshot 才能写入视频/展品外键。
      await this.createMediaRows(courseId, mediaKeyMap);
    } catch (error) {
      await this.rollbackMedia(courseId, mediaKeyMap);
      throw error;
    }

    try {
      const snapshot = this.snapshotFromPackage(manifest, mediaKeyMap);
      await this.prisma.$transaction(
        async (tx) => {
          // C5/C7：v3 快照按 categoryPath 在同一事务内解析；失败整体回滚，草稿不变。
          try {
            await applyVersionSnapshotInTx(tx, courseId, snapshot);
          } catch (error) {
            if (error instanceof CategoryResolutionError) {
              throw new ImportError('CATEGORY_NOT_FOUND', 422, error.message);
            }
            throw error;
          }
          await tx.commerceCourse.update({
            where: { id: courseId },
            data: {
              hasDraft: true,
              // C9：导入整包 = 显式"有草稿"状态。
              draftRevision: { increment: 1 },
              lifecycleStatus: 'WORKING',
              // 导入整包覆盖草稿：已打开的编辑页再保存会收到 409，而不是覆盖导入结果
              revision: { increment: 1 },
              revisionBy: null,
              trialEnabled: Boolean(manifest.course.trial?.enabled),
              draftSourceType: 'IMPORT',
              draftSourceEnvironment: manifest.source.environment ?? null,
              draftSourceVersionLabel: manifest.source.sourceVersion ?? null,
            },
          });

          // applyVersionSnapshot 可能复用/重建 Lesson 与 LP 行，必须重新从数据库取实际 ID。
          const actualLessons = await tx.lesson.findMany({
            where: { courseId, archivedAt: null },
            select: { id: true, code: true },
          });
          const lessonIdByCode = new Map(
            actualLessons.map((lesson) => [lesson.code, lesson.id]),
          );
          const lessonCodeById = new Map(
            actualLessons.map((lesson) => [lesson.id, lesson.code]),
          );
          const learningPoints = await tx.learningPoint.findMany({
            where: { lesson: { courseId } },
            select: { id: true, lessonId: true, code: true },
          });
          const lpIdByKey = new Map(
            learningPoints.map((lp) => [
              `${lessonCodeById.get(lp.lessonId) ?? ''}|${lp.code}`,
              lp.id,
            ]),
          );
          const lpIds = new Set(learningPoints.map((lp) => lp.id));
          const resolveCutoff = (lessonCode: string, ref?: string | null) => {
            if (!ref) return null;
            return (
              lpIdByKey.get(`${lessonCode}|${ref}`) ??
              (lpIds.has(ref) ? ref : null)
            );
          };

          await tx.trialSetting.deleteMany({ where: { courseId } });
          if (manifest.course.trial?.enabled) {
            for (const row of manifest.course.trial.lessons ?? []) {
              const lessonId = lessonIdByCode.get(row.lessonRef);
              if (!lessonId) continue;
              await tx.trialSetting.create({
                data: {
                  courseId,
                  lessonId,
                  videoCutoffSeconds: row.videoCutoffSeconds ?? null,
                  textCutoffLearningPointId: resolveCutoff(
                    row.lessonRef,
                    row.textCutoffLearningPoint,
                  ),
                  status: (row.status ?? 'READY') as never,
                },
              });
            }
          }

          await tx.coursePlan.updateMany({
            where: { courseId, active: true },
            data: { active: false },
          });
          for (const [index, plan] of (
            manifest.course.pricing ?? []
          ).entries()) {
            await tx.coursePlan.create({
              data: {
                id: randomUUID(),
                courseId,
                name: plan.name,
                scope: 'COURSE',
                scopeId: courseId,
                termMonths: plan.termMonths,
                device: 'WEB',
                amountMinor: plan.amountMinor,
                currency: (plan.currency || 'usd').toLowerCase(),
                stripeLookupKey: plan.lookupKey,
                sortOrder: index,
                active: true,
              },
            });
          }

          await tx.courseAuthoringActivity.create({
            data: {
              courseId,
              actorEmployeeId,
              action: HISTORY_ACTIONS.IMPORT_PACKAGE,
              detail: {
                packageId: manifest.packageId,
                sourceEnvironment: manifest.source.environment ?? null,
                sourceVersionLabel: manifest.source.sourceVersion ?? null,
              },
            },
          });
        },
        { timeout: 60_000 },
      );
      return { courseId };
    } catch (error) {
      await this.rollbackMedia(courseId, mediaKeyMap);
      throw asImportConflict(error);
    }
  }

  // ===== Part C v2 课程包（唯一 v2 契约 SSOT）=====

  /**
   * Part C v2 包导入（新建课程）：parse→validate→deriveTiming→align 编译器管线
   * + pc_* 实体（仓库层）+ v3 工作区快照。分类解析与全部写入同一事务。
   */
  private async importPartcPackage(
    manifest: PackageManifestV2,
    files: Map<string, Buffer>,
    options: ImportOptions,
  ): Promise<{ courseId: string }> {
    const courseKey = manifest.course.courseKey;
    const existingByCode = await this.prisma.commerceCourse.findFirst({
      where: { code: courseKey },
      select: { id: true, code: true },
    });
    if (existingByCode) {
      if (
        options.onConflict === 'ABORT' ||
        options.onConflict === 'CREATE_NEW_COURSE'
      ) {
        throw new ImportError(
          'PACKAGE_CONFLICT',
          409,
          `Course ${existingByCode.code} already exists. The Course ID must not already exist in this Admin, or the import is refused.`,
        );
      }
      throw new ImportError(
        'PACKAGE_CONFLICT',
        409,
        'NEW_VERSION import not implemented yet.',
      );
    }
    let targetSlug = partcSlugOf(manifest);
    const slugOwner = await this.prisma.commerceCourse.findFirst({
      where: { slug: targetSlug },
      select: { id: true },
    });
    if (slugOwner) targetSlug = await this.uniqueSlug(targetSlug);

    const compiled = await this.compilePartcPackage(manifest, files);
    const courseId = randomUUID();
    const transfer = await this.transferPartcMedia(courseId, manifest, files);
    try {
      const snapshot = buildPartcVersionSnapshot(compiled, {
        courseId,
        slug: targetSlug,
        mediaAssetIdByPath: transfer.assetIdByPath,
        mediaExtensionByPath: transfer.extensionByPath,
      });
      await this.prisma.$transaction(
        async (tx) => {
          const categoryId = await this.resolvePartcCategory(tx, manifest);
          await tx.commerceCourse.create({
            data: {
              id: courseId,
              code: courseKey,
              slug: targetSlug,
              categoryId,
              learningMode: snapshot.course
                .learningMode as unknown as Prisma.CommerceCourseCreateInput['learningMode'],
              defaultContentLanguage: snapshot.course.defaultContentLanguage,
              learningLanguages: snapshot.course.learningLanguages,
              lifecycleStatus: 'WORKING',
              liveStatus: 'HIDDEN',
              hasDraft: true,
              draftRevision: 1,
              trialEnabled: false,
              localizations: {
                create: snapshot.course.localizations.map((loc) => ({
                  language: loc.language,
                  title: loc.title,
                  shortDescription: loc.shortDescription,
                  overview: loc.overview,
                  whatYouLearn: loc.whatYouLearn ?? [],
                  provides: loc.provides ?? [],
                })),
              },
            },
          });
          await this.createPartcMediaRows(tx, courseId, transfer);
          await applyVersionSnapshotInTx(tx, courseId, snapshot);
          await persistPartcEntities(tx, compiled, {
            courseId,
            uriByPath: transfer.uriByPath,
          });
          await tx.courseAuthoringActivity.create({
            data: {
              courseId,
              actorEmployeeId: options.actorEmployeeId,
              action: 'IMPORT',
              detail: {
                packageFormat: 2,
                courseKey,
                provenance: (manifest.provenance ??
                  null) as unknown as Prisma.InputJsonValue,
              },
            },
          });
        },
        { timeout: 120_000 },
      );
    } catch (error) {
      await this.rollbackPartcMedia(transfer);
      throw asImportConflict(error);
    }
    return { courseId };
  }

  /**
   * Part C v2 包导入到已有课程（只替换草稿，线上版本不变）：
   * Course ID（courseKey）必须一致；试看与价格不随 Part C 包变更。
   */
  private async importPartcIntoExistingCourse(
    courseId: string,
    manifest: PackageManifestV2,
    files: Map<string, Buffer>,
    actorEmployeeId: string | null,
  ): Promise<{ courseId: string }> {
    const existing = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { id: true, code: true, slug: true },
    });
    if (!existing)
      throw new ImportError('COURSE_NOT_FOUND', 404, 'Course not found.');
    if (existing.code !== manifest.course.courseKey) {
      throw new ImportError(
        'PACKAGE_COURSE_ID_MISMATCH',
        422,
        'The Course ID in the package must match this course, or the import is refused.',
      );
    }
    const compiled = await this.compilePartcPackage(manifest, files);
    const transfer = await this.transferPartcMedia(courseId, manifest, files);
    try {
      const snapshot = buildPartcVersionSnapshot(compiled, {
        courseId,
        slug: existing.slug,
        mediaAssetIdByPath: transfer.assetIdByPath,
        mediaExtensionByPath: transfer.extensionByPath,
      });
      await this.prisma.$transaction(
        async (tx) => {
          await this.resolvePartcCategory(tx, manifest);
          await this.createPartcMediaRows(tx, courseId, transfer);
          await applyVersionSnapshotInTx(tx, courseId, snapshot);
          await tx.commerceCourse.update({
            where: { id: courseId },
            data: {
              hasDraft: true,
              // C9：导入整包 = 显式"有草稿"状态。
              draftRevision: { increment: 1 },
              lifecycleStatus: 'WORKING',
              revision: { increment: 1 },
              revisionBy: null,
              draftSourceType: 'IMPORT',
              draftSourceEnvironment: manifest.provenance?.sourceEnv ?? null,
              draftSourceVersionLabel:
                manifest.provenance?.sourceVersionLabel ?? null,
            },
          });
          await persistPartcEntities(tx, compiled, {
            courseId,
            uriByPath: transfer.uriByPath,
          });
          await tx.courseAuthoringActivity.create({
            data: {
              courseId,
              actorEmployeeId,
              action: HISTORY_ACTIONS.IMPORT_PACKAGE,
              detail: {
                packageFormat: 2,
                courseKey: manifest.course.courseKey,
                provenance: (manifest.provenance ??
                  null) as unknown as Prisma.InputJsonValue,
              },
            },
          });
        },
        { timeout: 120_000 },
      );
      return { courseId };
    } catch (error) {
      await this.rollbackPartcMedia(transfer);
      throw error;
    }
  }

  /** Part C 编译器管线（parse→validate→deriveTiming→align）。 */
  private async compilePartcPackage(
    manifest: PackageManifestV2,
    files: Map<string, Buffer>,
  ) {
    const templatePath = templateResourcePathOf(manifest);
    const templateBytes = files.get(templatePath);
    if (!templateBytes) {
      throw new ImportError(
        'PACKAGE_FILE_MISSING',
        422,
        `Template resource is missing from the package: ${templatePath}`,
      );
    }
    try {
      const workbook = decodeTemplateWorkbook(templateBytes);
      const ir = parsePackage({
        manifest,
        files: files,
        workbook,
      });
      const documents = await extractPartcDocuments(ir);
      // C5 P3/C7 ③：ASR 默认兜底（env 驱动 provider）。每个视频 × 每个语言
      // 独立派生转写工件；缺失即无 ASR 源，编译器按 ALN-7 显式报告。
      const transcripts = await extractAsrTranscripts(ir);
      return compilePartcPackageFromIr(ir, documents, transcripts);
    } catch (error) {
      if (error instanceof PartcCompileError) {
        throw new ImportError(error.code, 422, error.message, error.report);
      }
      if (error instanceof PartCError) {
        throw new ImportError(
          error.code,
          422,
          error.message,
          reportFromPartCError(error),
        );
      }
      throw error;
    }
  }

  /** C5：分类路径解析（Part C 包；不创建分类、不猜）。 */
  private async resolvePartcCategory(
    tx: Prisma.TransactionClient,
    manifest: PackageManifestV2,
  ): Promise<string | null> {
    const path = manifest.course.categoryPath;
    if (path === null) return null;
    const row = await findCategoryByPath(tx, path);
    if (!row) {
      throw new ImportError(
        'CATEGORY_NOT_FOUND',
        422,
        `Category path does not resolve to an ACTIVE category: ${path.join(' / ')}`,
      );
    }
    return row.id;
  }

  /**
   * Part C 包内资源落地：媒体按签名校验后转存；字幕/章节/DOCX 原文一并落地
   * （审计可追溯；文档不建 CourseMediaAsset 行）。
   */
  private async transferPartcMedia(
    courseId: string,
    manifest: PackageManifestV2,
    files: Map<string, Buffer>,
  ): Promise<PartcMediaTransfer> {
    const transfer: PartcMediaTransfer = {
      uriByPath: new Map(),
      assetIdByPath: new Map(),
      extensionByPath: new Map(),
      mediaMetas: [],
      storageKeys: [],
      mediaAssetIds: [],
    };
    const mediaKinds = new Set([
      'cover',
      'video',
      'audio',
      'image',
      'model3d',
      'thumbnail',
    ]);
    for (const resource of manifest.resources) {
      if (resource.kind === 'template') continue;
      const bytes = files.get(resource.path);
      if (!bytes) {
        throw new ImportError(
          'PACKAGE_FILE_MISSING',
          422,
          `Package resource is missing: ${resource.path}`,
        );
      }
      const assetId = randomUUID();
      const extension = fileExtension(resource.path);
      const storageKey = this.storage.mediaKey(courseId, assetId, extension);
      await this.storage.putMedia(storageKey, bytes);
      transfer.storageKeys.push(storageKey);
      transfer.extensionByPath.set(resource.path, extension);
      transfer.uriByPath.set(resource.path, storageKey);
      if (!mediaKinds.has(resource.kind)) continue;
      let validated;
      try {
        validated = validateMediaFile(
          { name: baseName(resource.path), bytes },
          this.config,
        );
      } catch {
        throw new ImportError(
          'PACKAGE_MEDIA_INVALID',
          422,
          `Invalid media: ${resource.path}`,
        );
      }
      transfer.assetIdByPath.set(resource.path, assetId);
      transfer.mediaAssetIds.push(assetId);
      transfer.mediaMetas.push({
        assetId,
        kind: validated.kind,
        extension: validated.extension,
        storageKey,
        mimeType: validated.mimeType,
        size: validated.size,
        originalName: validated.originalName,
      });
    }
    return transfer;
  }

  private async createPartcMediaRows(
    tx: Prisma.TransactionClient,
    courseId: string,
    transfer: PartcMediaTransfer,
  ): Promise<void> {
    for (const meta of transfer.mediaMetas) {
      await tx.courseMediaAsset.create({
        data: {
          id: meta.assetId,
          courseId,
          kind: meta.kind as never,
          originalName: meta.originalName,
          mimeType: meta.mimeType,
          extension: meta.extension,
          size: meta.size,
          storageKey: meta.storageKey,
        },
      });
    }
  }

  private async rollbackPartcMedia(
    transfer: PartcMediaTransfer,
  ): Promise<void> {
    if (transfer.mediaAssetIds.length > 0) {
      await this.prisma.courseMediaAsset
        .deleteMany({ where: { id: { in: transfer.mediaAssetIds } } })
        .catch(() => undefined);
    }
    await Promise.all(
      transfer.storageKeys.map((key) =>
        this.storage.removeMedia(key).catch(() => undefined),
      ),
    );
  }

  private snapshotFromPackage(
    manifest: PackageManifest,
    mediaKeyMap: Map<string, ImportedMediaMeta>,
  ): VersionSnapshot {
    const { course } = manifest;
    const capturedAt = new Date().toISOString();
    // C7/I9：导入后的草稿快照同样只带稳定键路径。
    // 已校验的 v2 包必有 categoryPath；历史暂存作业（v1 形态）才回退 category 字符串。
    const legacyCategory = (course as { category?: unknown }).category;
    const categoryPath =
      course.categoryPath !== undefined
        ? course.categoryPath
        : typeof legacyCategory === 'string' && legacyCategory.trim()
          ? [legacyCategory.trim()]
          : null;
    return {
      formatVersion: 3,
      capturedAt,
      course: {
        code: course.code,
        slug: course.slug,
        categoryPath,
        coverAssetId: course.cover
          ? (mediaKeyMap.get(course.cover)?.assetId ?? null)
          : null,
        learningMode: course.learningMode,
        defaultContentLanguage: course.defaultContentLanguage,
        learningLanguages: course.learningLanguages,
        localizations: Object.entries(course.localized).map(
          ([language, loc]) => ({
            language,
            title: loc.title,
            shortDescription: loc.shortDescription ?? null,
            overview: loc.overview ?? null,
            whatYouLearn: loc.whatYouLearn ?? [],
            provides: loc.provides ?? [],
          }),
        ),
        lessons: [...(course.lessons ?? [])]
          .sort((a, b) => a.order - b.order)
          .map((lesson) => {
            const exhibits = (lesson.exhibits ?? []).map((exhibit) => ({
              code: exhibit.code,
              type: exhibit.type,
              mediaAssetId: exhibit.file
                ? (mediaKeyMap.get(exhibit.file)?.assetId ?? null)
                : null,
              thumbnailAssetId: exhibit.thumbnail
                ? (mediaKeyMap.get(exhibit.thumbnail)?.assetId ?? null)
                : null,
              sourceText: exhibit.source ?? null,
              localized: exhibit.localized,
            }));
            return {
              id: randomUUID(),
              code: lesson.code,
              sortOrder: lesson.order,
              localizations: Object.entries(lesson.localized).map(
                ([language, loc]) => ({
                  language,
                  title: loc.title,
                  description: loc.description ?? null,
                  videoAssetId: loc.video?.file
                    ? (mediaKeyMap.get(loc.video.file)?.assetId ?? null)
                    : null,
                  videoDurationSeconds: loc.video?.durationSeconds ?? null,
                  textHtml: loc.text?.html ?? null,
                  textLearningPoints: loc.text?.learningPoints ?? [],
                }),
              ),
              exhibits,
              learningPoints: Object.entries(lesson.localized).flatMap(
                ([language, loc]) => [
                  ...(loc.video?.learningPoints ?? []).map((lp, index) => ({
                    language,
                    code: lp.code,
                    title: lp.title,
                    source: 'VIDEO',
                    timeSeconds: lp.timeSeconds,
                    anchorHeading: null,
                    sortOrder: index,
                  })),
                  ...(loc.text?.learningPoints ?? []).map((lp, index) => ({
                    language,
                    code: lp.code,
                    title: lp.heading,
                    source: 'TEXT',
                    timeSeconds: null,
                    anchorHeading: lp.heading,
                    sortOrder: (loc.video?.learningPoints?.length ?? 0) + index,
                  })),
                ],
              ),
              triggers: Object.entries(lesson.localized).flatMap(
                ([language, loc]) =>
                  (loc.video?.exhibitTriggers ?? []).map((trigger) => ({
                    exhibitCode: trigger.exhibitRef,
                    language,
                    timeSeconds: trigger.timeSeconds,
                  })),
              ),
              readings: Object.entries(lesson.recommendedReading ?? {}).flatMap(
                ([language, rows]) =>
                  (rows ?? []).map((row, index) => ({
                    language,
                    type: row.type,
                    title: row.title,
                    author: row.author ?? null,
                    whyRecommended: row.why ?? null,
                    sortOrder: index,
                  })),
              ),
              questions: (lesson.knowledgeTest?.questions ?? []).map(
                (question, index) => ({
                  code: question.code,
                  question: question.question,
                  referenceAnswer: question.referenceAnswer ?? null,
                  sortOrder: index,
                  enabled: true,
                }),
              ),
              applicationTest: lesson.applicationTest?.enabled
                ? {
                    scenario: lesson.applicationTest.scenario,
                    referenceAnswer:
                      lesson.applicationTest.referenceAnswer ?? null,
                    enabled: true,
                  }
                : null,
            };
          }),
      },
    };
  }

  /** 生成未被占用的 slug：base、base-2、base-3…（slug 仅要求唯一，非课程身份）。 */
  private async uniqueSlug(base: string): Promise<string> {
    const root = (base || 'course').trim().toLowerCase() || 'course';
    for (let i = 2; i < 1000; i++) {
      const candidate = `${root}-${i}`;
      const taken = await this.prisma.commerceCourse.findFirst({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
    }
    return `${root}-${Date.now().toString(36)}`;
  }

  /**
   * C5：分类路径解析（不创建分类、不猜）。逐级在 ACTIVE 节点中按 name 或
   * localized 任一语言显示名匹配（trim、大小写不敏感）；失败 → 整个 job
   * CATEGORY_NOT_FOUND，消息列出未解析路径。
   */
  private async resolveCategoryPath(
    db: Prisma.TransactionClient,
    course: { categoryPath?: string[] | null; category?: unknown },
  ): Promise<string | null> {
    const legacyCategory = course.category;
    const path =
      course.categoryPath !== undefined
        ? course.categoryPath
        : typeof legacyCategory === 'string' && legacyCategory.trim()
          ? [legacyCategory.trim()]
          : null;
    if (path === null) return null;
    const row = await findCategoryByPath(db, path);
    if (!row) {
      throw new ImportError(
        'CATEGORY_NOT_FOUND',
        422,
        `Category path does not resolve to an ACTIVE category: ${path.join(' / ')}`,
      );
    }
    return row.id;
  }

  private async transferMedia(
    courseId: string,
    manifest: PackageManifest,
    files: Map<string, Buffer>,
    map: Map<string, ImportedMediaMeta>,
  ): Promise<void> {
    const { course } = manifest;
    const store = async (relPath: string) => {
      const bytes = files.get(relPath);
      if (!bytes)
        throw new ImportError(
          'PACKAGE_MEDIA_INVALID',
          422,
          `Missing media: ${relPath}`,
        );
      let validated;
      try {
        validated = validateMediaFile(
          { name: relPath.split('/').pop() ?? relPath, bytes },
          this.config,
        );
      } catch {
        throw new ImportError(
          'PACKAGE_MEDIA_INVALID',
          422,
          `Invalid media: ${relPath}`,
        );
      }
      const assetId = randomUUID();
      const storageKey = this.storage.mediaKey(
        courseId,
        assetId,
        validated.extension,
      );
      await this.storage.putMedia(storageKey, bytes);
      map.set(relPath, {
        assetId,
        kind: validated.kind,
        extension: validated.extension,
        storageKey,
        mimeType: validated.mimeType,
        size: validated.size,
        originalName: validated.originalName,
      });
      return { assetId, validated };
    };

    if (course.cover) await store(course.cover);
    for (const lesson of course.lessons ?? []) {
      for (const [, loc] of Object.entries(lesson.localized ?? {})) {
        if (loc.video?.file) await store(loc.video.file);
      }
      for (const ex of lesson.exhibits ?? []) {
        if (ex.file) await store(ex.file);
        if (ex.thumbnail) await store(ex.thumbnail);
      }
    }
  }

  /** 导入已有课程时补齐媒体资产行；新建课程在 writeCourse 的事务内创建。 */
  private async createMediaRows(
    courseId: string,
    map: Map<string, ImportedMediaMeta>,
  ): Promise<void> {
    if (map.size === 0) return;
    await this.prisma.courseMediaAsset.createMany({
      data: [...map.values()].map((meta) => ({
        id: meta.assetId,
        courseId,
        kind: meta.kind as never,
        originalName: meta.originalName,
        mimeType: meta.mimeType,
        extension: meta.extension,
        size: meta.size,
        storageKey: meta.storageKey,
      })),
    });
  }

  private async rollbackMedia(
    courseId: string,
    map: Map<string, ImportedMediaMeta>,
  ): Promise<void> {
    const ids = [...map.values()].map((m) => m.assetId);
    if (ids.length) {
      await this.prisma.courseMediaAsset
        .deleteMany({ where: { id: { in: ids }, courseId } })
        .catch(() => undefined);
    }
    await Promise.all(
      [...map.values()].map((m) => this.storage.removeMedia(m.storageKey)),
    );
  }

  private async writeCourse(
    tx: Prisma.TransactionClient,
    courseId: string,
    ids: { targetCode: string; targetSlug: string; categoryId: string | null },
    manifest: PackageManifest,
    mediaKeyMap: Map<string, ImportedMediaMeta>,
  ): Promise<void> {
    const { course } = manifest;

    const coverAssetId = course.cover
      ? (mediaKeyMap.get(course.cover)?.assetId ?? null)
      : null;

    await tx.commerceCourse.create({
      data: {
        id: courseId,
        code: ids.targetCode,
        slug: ids.targetSlug,
        categoryId: ids.categoryId,
        learningMode: course.learningMode,
        defaultContentLanguage: course.defaultContentLanguage,
        learningLanguages: course.learningLanguages,
        coverAssetId: null,
        lifecycleStatus: 'WORKING',
        liveStatus: 'HIDDEN',
        hasDraft: true,
        // C9：导入新建 = 有草稿（liveBaseRevision 默认 0）。
        draftRevision: 1,
        trialEnabled: Boolean(course.trial?.enabled),
        localizations: {
          create: Object.entries(course.localized).map(([language, loc]) => ({
            language,
            title: loc.title,
            shortDescription: loc.shortDescription ?? null,
            overview: loc.overview ?? null,
            whatYouLearn: loc.whatYouLearn ?? [],
            provides: (loc.provides ?? []) as unknown as Prisma.InputJsonValue,
          })),
        },
      },
    });

    // 媒体资产行（须在 CommerceCourse 之后，因 courseId 外键指向它）
    for (const meta of mediaKeyMap.values()) {
      await tx.courseMediaAsset.create({
        data: {
          id: meta.assetId,
          courseId,
          kind: meta.kind as never,
          originalName: meta.originalName,
          mimeType: meta.mimeType,
          extension: meta.extension,
          size: meta.size,
          storageKey: meta.storageKey,
        },
      });
    }

    if (coverAssetId) {
      await tx.commerceCourse.update({
        where: { id: courseId },
        data: { coverAssetId },
      });
    }

    // 课时
    const lessonIdByCode = new Map<string, string>();
    const lpIdByKey = new Map<string, string>();
    for (const lesson of [...(course.lessons ?? [])].sort(
      (a, b) => a.order - b.order,
    )) {
      const lessonId = randomUUID();
      lessonIdByCode.set(lesson.code, lessonId);
      await tx.lesson.create({
        data: {
          id: lessonId,
          courseId,
          code: lesson.code,
          sortOrder: lesson.order,
          localizations: {
            create: Object.entries(lesson.localized).map(([language, loc]) => ({
              language,
              title: loc.title,
              description: loc.description ?? null,
              videoAssetId: loc.video?.file
                ? (mediaKeyMap.get(loc.video.file)?.assetId ?? null)
                : null,
              videoDurationSeconds: loc.video?.durationSeconds ?? null,
              textHtml: loc.text?.html ?? null,
              textLearningPoints: (loc.text?.learningPoints ??
                []) as unknown as Prisma.InputJsonValue,
            })),
          },
        },
      });

      // 展品
      const exhibitIdByCode = new Map<string, string>();
      for (const ex of lesson.exhibits ?? []) {
        const exhibitId = await this.createExhibit(
          tx,
          lessonId,
          ex,
          mediaKeyMap,
        );
        exhibitIdByCode.set(ex.code, exhibitId);
      }

      // 学习点 + 触发器
      for (const [language, loc] of Object.entries(lesson.localized)) {
        const videoLps = loc.video?.learningPoints ?? [];
        const textLps = loc.text?.learningPoints ?? [];
        let order = 0;
        for (const lp of videoLps) {
          const createdLp = await tx.learningPoint.create({
            data: {
              lessonId,
              language,
              code: lp.code,
              title: lp.title,
              source: 'VIDEO',
              timeSeconds: lp.timeSeconds,
              sortOrder: order++,
            },
          });
          lpIdByKey.set(`${lesson.code}|${lp.code}`, createdLp.id);
        }
        for (const lp of textLps) {
          const createdLp = await tx.learningPoint.create({
            data: {
              lessonId,
              language,
              code: lp.code,
              title: lp.heading,
              source: 'TEXT',
              anchorHeading: lp.heading,
              sortOrder: order++,
            },
          });
          lpIdByKey.set(`${lesson.code}|${lp.code}`, createdLp.id);
        }
        for (const trigger of loc.video?.exhibitTriggers ?? []) {
          const exId = exhibitIdByCode.get(trigger.exhibitRef);
          if (exId) {
            await tx.exhibitTrigger.create({
              data: {
                lessonId,
                exhibitId: exId,
                language,
                timeSeconds: trigger.timeSeconds,
              },
            });
          }
        }
      }

      // 推荐阅读
      for (const [language, readings] of Object.entries(
        lesson.recommendedReading ?? {},
      )) {
        let order = 0;
        for (const r of readings ?? []) {
          await tx.recommendedReading.create({
            data: {
              lessonId,
              language,
              type: r.type,
              title: r.title,
              author: r.author ?? null,
              whyRecommended: r.why ?? null,
              sortOrder: order++,
            },
          });
        }
      }

      // 知识测试
      if (lesson.knowledgeTest?.questions?.length) {
        let order = 0;
        for (const q of lesson.knowledgeTest.questions) {
          await tx.knowledgeQuestion.create({
            data: {
              lessonId,
              code: q.code,
              question: q.question,
              referenceAnswer: q.referenceAnswer ?? null,
              sortOrder: order++,
            },
          });
        }
      }
      // 应用测试
      if (lesson.applicationTest?.enabled) {
        await tx.applicationTest.create({
          data: {
            lessonId,
            scenario: lesson.applicationTest.scenario,
            referenceAnswer: lesson.applicationTest.referenceAnswer ?? null,
            enabled: true,
          },
        });
      }
    }

    // 试用
    if (course.trial?.enabled) {
      for (const row of course.trial.lessons ?? []) {
        const lessonId = lessonIdByCode.get(row.lessonRef);
        if (!lessonId) continue;
        await tx.trialSetting.create({
          data: {
            courseId,
            lessonId,
            videoCutoffSeconds: row.videoCutoffSeconds ?? null,
            textCutoffLearningPointId: row.textCutoffLearningPoint
              ? (lpIdByKey.get(
                  `${row.lessonRef}|${row.textCutoffLearningPoint}`,
                ) ?? null)
              : null,
            status: (row.status ?? 'READY') as never,
          },
        });
      }
    }

    // 价格随包带入；Stripe 由导入完成后在同一环境重新创建
    for (const [index, plan] of (course.pricing ?? []).entries()) {
      await tx.coursePlan.create({
        data: {
          id: randomUUID(),
          courseId,
          name: plan.name,
          scope: 'COURSE',
          scopeId: courseId,
          termMonths: plan.termMonths,
          device: 'WEB',
          amountMinor: plan.amountMinor,
          currency: (plan.currency || 'usd').toLowerCase(),
          stripeLookupKey: plan.lookupKey,
          sortOrder: index,
          active: true,
        },
      });
    }

    // 审计
    await tx.courseAuthoringActivity.create({
      data: {
        courseId,
        action: 'IMPORT',
        detail: {
          manifestFormat: manifest.formatVersion,
          packageId: manifest.packageId,
        },
      },
    });
  }

  private async createExhibit(
    tx: Prisma.TransactionClient,
    lessonId: string,
    ex: PackageExhibit,
    mediaKeyMap: Map<string, ImportedMediaMeta>,
  ): Promise<string> {
    const exhibitId = randomUUID();
    await tx.exhibit.create({
      data: {
        id: exhibitId,
        lessonId,
        code: ex.code,
        type: ex.type,
        mediaAssetId: ex.file
          ? (mediaKeyMap.get(ex.file)?.assetId ?? null)
          : null,
        thumbnailAssetId: ex.thumbnail
          ? (mediaKeyMap.get(ex.thumbnail)?.assetId ?? null)
          : null,
        sourceText: ex.source ?? null,
        localized: ex.localized,
      },
    });
    return exhibitId;
  }
}

interface PartcMediaTransfer {
  /** 资源路径 → 本环境存储 uri（含媒体/字幕/章节/DOCX）。 */
  readonly uriByPath: Map<string, string>;
  /** 媒体资源路径 → CourseMediaAsset id（legacy 工作区投影用）。 */
  readonly assetIdByPath: Map<string, string>;
  readonly extensionByPath: Map<string, string>;
  readonly mediaMetas: ImportedMediaMeta[];
  readonly storageKeys: string[];
  readonly mediaAssetIds: string[];
}

/** Part C 包的 URL slug：优先导出方 annotations.slug，否则由 courseKey 机械派生。 */
function partcSlugOf(manifest: PackageManifestV2): string {
  const annotated = manifest.annotations?.slug;
  if (typeof annotated === 'string' && annotated.trim() !== '') {
    return annotated.trim().toLowerCase();
  }
  const key = String(manifest.course.courseKey);
  const derived = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return derived || 'course';
}

function baseName(relativePath: string): string {
  return relativePath.split('/').pop() ?? relativePath;
}

function fileExtension(relativePath: string): string {
  const name = baseName(relativePath);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'bin';
  return name.slice(dot + 1).toLowerCase();
}
