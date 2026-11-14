import type { PrismaService } from '../prisma/prisma.service';
import { CourseStorageService } from './storage.service';
import {
  buildCourseSnapshot,
  packageMediaPath,
  type CourseAggregate,
} from './snapshot';
import type {
  PackageCourse,
  PackageExhibit,
  PackageLesson,
  PackageLessonLocalization,
  PackageReading,
} from './contracts/manifest';
import type { PackageProvenance } from '../partc/contracts/package-manifest';
import {
  AlignmentSchema,
  EvidenceSpecSchema,
  PrerequisiteEdgeSchema,
  RenditionSchema,
  StageSchema,
  type Alignment,
  type EvidenceSpec,
  type PrerequisiteEdge,
  type Rendition,
  type Stage,
} from '../partc/contracts';
import type { VersionSnapshot } from './version-snapshot';
import { categoryPathForId, snapshotCategoryPath } from './category-path';
import { assemblePartcPackage, partcIdentityFromCourse } from './partc-export';
import type { CarriedAsset, CarriedMediaAsset } from './partc-export';

/**
 * 课程包导出（评审阻断 2/3/9；设计 SSOT §14 C5/C6/C10）。
 *
 * 产物是 **Part C v2 包**（唯一 v2 契约 SSOT）：
 * - manifest 通过 PackageManifestV2Schema 校验后才写出（含 course/content/
 *   resources/provenance/annotations；provenance 带 asr pin）；
 * - 模板工作簿由同一 schema 的列定义产出；包闭合（resources 与文件 1:1）；
 * - 分类写完整 `categoryPath`（父链在前，二级分类不丢）；未分类 null；
 * - 不写任何哈希清单（C0 红线），不写占位分类。
 */

export interface ExportOptions {
  /** 导出操作者（provenance.exportedBy；缺省 admin）。 */
  exportedBy?: string;
  /** 导出环境（provenance.sourceEnv；缺省从版本号模式沙箱）。 */
  sourceEnv?: 'sandbox' | 'production';
  /** 目标版本号（草稿导出 1；版本导出取该版本 versionNo）。 */
  versionNo?: number;
  /** 版本导出的版本标签（provenance.sourceVersionLabel / annotations）。 */
  versionLabel?: string;
}

function sanitizeSegment(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+/, '')
      .replace(/[-.]+$/, '')
      .slice(0, 80) || 'export'
  );
}

/**
 * 导出审计（C10.4）：从本环境 Pc 真源读取 verified 对齐与时间源种类。
 *
 * - `alignments`：kept verified Pc alignments（含 sourceKind/sourceArtifact/
 *   modelVersion/params/ruleVersion 与 verifiedBy/verifiedAt/verifiedAgainst
 *   审计元组）；由 partc-export 过滤到本包能表达的条目。
 * - `timingSources`：Pc rendition 的 anchorSource ∪ verified alignment 的
 *   sourceKind（时间审计的机器来源）；无 Pc 数据时退回 `import-legacy`
 *   （旧工作区导出的锚点来源）。
 * - 环境 UUID/哈希一律不出现：只搬稳定键与审计元组。
 */
async function loadPartcExportAudit(
  prisma: PrismaService,
  courseKey: string,
  contentKeys: readonly string[],
): Promise<{ alignments: Alignment[]; timingSources: string[] }> {
  const [alignmentRows, renditionRows] = await Promise.all([
    prisma.pcAlignment.findMany({
      where: { status: 'verified', stage: { courseKey } },
      orderBy: { alignmentId: 'asc' },
    }),
    contentKeys.length === 0
      ? Promise.resolve([])
      : prisma.pcRendition.findMany({
          where: { contentKey: { in: [...contentKeys] } },
          select: { anchorSource: true },
        }),
  ]);
  const alignments: Alignment[] = [];
  for (const row of alignmentRows) {
    const parsed = AlignmentSchema.safeParse({
      alignmentId: row.alignmentId,
      stageKey: row.stageKey,
      renditionKey: row.renditionKey,
      objectiveKey: row.objectiveKey,
      role: row.role,
      status: row.status,
      provenance: row.provenance,
      ...(row.sourceKind === null ? {} : { sourceKind: row.sourceKind }),
      ...(row.sourceArtifact === null
        ? {}
        : { sourceArtifact: row.sourceArtifact }),
      ...(row.modelVersion === null ? {} : { modelVersion: row.modelVersion }),
      ...(row.params === null ? {} : { params: row.params }),
      ...(row.ruleVersion === null ? {} : { ruleVersion: row.ruleVersion }),
      ...(row.confidence === null ? {} : { confidence: row.confidence }),
      ...(row.verifiedBy === null ? {} : { verifiedBy: row.verifiedBy }),
      ...(row.verifiedAt === null
        ? {}
        : { verifiedAt: row.verifiedAt.toISOString() }),
      ...(row.verifiedAgainst === null
        ? {}
        : { verifiedAgainst: row.verifiedAgainst }),
    });
    if (parsed.success) alignments.push(parsed.data);
  }
  const timingSources = new Set<string>();
  for (const row of renditionRows) timingSources.add(row.anchorSource);
  for (const alignment of alignments) {
    if (alignment.sourceKind !== undefined) {
      timingSources.add(alignment.sourceKind);
    }
  }
  return {
    alignments,
    timingSources:
      timingSources.size > 0 ? [...timingSources].sort() : ['import-legacy'],
  };
}

/** 课程内容 key 集合（课时主体 + 附属 spec）；用于按课程筛选 Pc rendition。 */
function contentKeysOfLessonCodes(lessonCodes: readonly string[]): string[] {
  const keys: string[] = [];
  for (const code of lessonCodes) {
    keys.push(
      code,
      `${code}.reading`,
      `${code}.knowledge-test`,
      `${code}.application-test`,
    );
  }
  return keys;
}

/**
 * C10.4：导出沿用的 Pc 真源结构（稳定 stageKey/objective/evidence）。
 * 导入过的 Part C 课程必须原样携带阶段树，否则跨环境导入会重新合成
 * `step-<lessonCode>` 等不同的 stageKey，verified 对齐无法携带。
 */
async function loadPcStructure(
  prisma: PrismaService,
  courseKey: string,
): Promise<{
  stages: Stage[];
  evidenceSpecs: EvidenceSpec[];
  prerequisiteEdges: PrerequisiteEdge[];
}> {
  const [stageRows, evidenceRows, edgeRows] = await Promise.all([
    prisma.pcStage.findMany({
      where: { courseKey },
      orderBy: { orderKey: 'asc' },
    }),
    prisma.pcEvidenceSpec.findMany({
      orderBy: [{ evidenceKey: 'asc' }, { version: 'desc' }],
    }),
    prisma.pcPrerequisiteEdge.findMany({
      where: { fromStage: { courseKey } },
      orderBy: [
        { fromStageKey: 'asc' },
        { toStageKey: 'asc' },
        { kind: 'asc' },
      ],
    }),
  ]);
  const stages: Stage[] = [];
  for (const row of stageRows) {
    const parsed = StageSchema.safeParse({
      courseKey: row.courseKey,
      stageKey: row.stageKey,
      parentStageKey: row.parentStageKey,
      orderKey: row.orderKey,
      kind: row.kind,
      goal: row.goal,
      objectiveKeys: row.objectiveKeys,
      exitEvidence: row.exitEvidence,
      exitRollup: row.exitRollup,
      ...(row.durationBudget === null
        ? {}
        : { durationBudget: row.durationBudget }),
      status: row.status,
    });
    if (parsed.success) stages.push(parsed.data);
  }
  // 只携带本课程阶段实际引用的证据规格（证据表全局按 key 版本化，
  // 不能把其他课程的规格带进闭合包）。
  const referencedEvidence = new Set<string>();
  for (const stage of stages) {
    for (const key of stage.exitEvidence ?? []) referencedEvidence.add(key);
  }
  const latestByKey = new Map<string, EvidenceSpec>();
  for (const row of evidenceRows) {
    if (!referencedEvidence.has(row.evidenceKey)) continue;
    if (latestByKey.has(row.evidenceKey)) continue;
    const parsed = EvidenceSpecSchema.safeParse({
      evidenceKey: row.evidenceKey,
      version: row.version,
      kind: row.kind,
      objectiveKeys: row.objectiveKeys,
      measure: row.measure,
      scoring: row.scoring,
      threshold: row.threshold,
      attempts: row.attempts,
    });
    if (parsed.success) latestByKey.set(row.evidenceKey, parsed.data);
  }
  return {
    stages,
    evidenceSpecs: [...latestByKey.values()].sort((left, right) =>
      left.evidenceKey < right.evidenceKey
        ? -1
        : left.evidenceKey > right.evidenceKey
          ? 1
          : 0,
    ),
    prerequisiteEdges: edgeRows.flatMap((row) => {
      const parsed = PrerequisiteEdgeSchema.safeParse({
        fromStageKey: row.fromStageKey,
        toStageKey: row.toStageKey,
        kind: row.kind,
      });
      return parsed.success ? [parsed.data] : [];
    }),
  };
}

/**
 * Pc 真源的 rendition 记录（A/C 缺陷）：导出内容身份必须来自 Pc，而不是
 * 从 legacy 聚合重新合成 `r.<lesson>.video....video-<lesson>-<lang>`。
 */
async function loadPcRenditions(
  prisma: PrismaService,
  contentKeys: readonly string[],
): Promise<Rendition[]> {
  if (contentKeys.length === 0) return [];
  const rows = await prisma.pcRendition.findMany({
    where: { contentKey: { in: [...contentKeys] } },
    orderBy: { renditionKey: 'asc' },
  });
  const renditions: Rendition[] = [];
  for (const row of rows) {
    const parsed = RenditionSchema.safeParse({
      renditionKey: row.renditionKey,
      contentKey: row.contentKey,
      blockId: row.blockId,
      language: row.language,
      modality: row.modality,
      occurrenceKey: row.occurrenceKey,
      carrierType: row.carrierType,
      carrierKey: row.carrierKey,
      carrierVersion: row.carrierVersion,
      ...(row.startMs === null ? {} : { startMs: row.startMs }),
      ...(row.endMs === null ? {} : { endMs: row.endMs }),
      ...(row.headingCode === null ? {} : { headingCode: row.headingCode }),
      ...(row.offset === null ? {} : { offset: row.offset }),
      anchorSource: row.anchorSource,
      revision: row.revision,
    });
    if (parsed.success) renditions.push(parsed.data);
  }
  return renditions;
}

/**
 * Pc 真源媒体字节（C10.1/C7）：视频/原始 DOCX/展品/缩略图/字幕。按
 * `assetKey@assetVersion` 提供，导出端只搬运不转码、不重命名。
 */
async function loadPcAssets(
  prisma: PrismaService,
  storage: CourseStorageService,
  courseId: string,
): Promise<CarriedAsset[]> {
  const rows = await prisma.pcMediaAsset.findMany({
    where: { uri: { contains: courseId } },
    orderBy: [{ assetKey: 'asc' }, { assetVersion: 'asc' }],
  });
  const assets: CarriedAsset[] = [];
  for (const row of rows) {
    let bytes: Buffer;
    try {
      bytes = await storage.getMedia(row.uri);
    } catch {
      // Pc 资产缺失时导出失败（不允许坏包）；恢复路径另行报 ASSET_NOT_FOUND。
      throw new Error(`Export failed: Pc media missing for ${row.assetKey}`);
    }
    const extension = row.uri.split('.').pop()?.toLowerCase() ?? 'bin';
    assets.push({
      assetKey: row.assetKey,
      assetVersion: row.assetVersion,
      kind: row.kind,
      language: row.language,
      extension,
      bytes,
    });
  }
  return assets;
}

/**
 * 导出时沿用的媒体身份（C3/C10.1）：从 PcRendition 读取每个导出席位的
 * `carrierKey + carrierVersion`，让导出的 Media 行/资产 pin 与导入时的
 * assetKey/版本一致（不换版、不重命名）。无 Pc 数据的旧课程返回空数组。
 */
async function loadCarriedMedia(
  prisma: PrismaService,
  contentKeys: readonly string[],
): Promise<CarriedMediaAsset[]> {
  if (contentKeys.length === 0) return [];
  const rows = await prisma.pcRendition.findMany({
    where: { contentKey: { in: [...contentKeys] } },
    select: {
      contentKey: true,
      blockId: true,
      language: true,
      modality: true,
      occurrenceKey: true,
      carrierType: true,
      carrierKey: true,
      carrierVersion: true,
      anchorSource: true,
    },
    orderBy: [
      { contentKey: 'asc' },
      { blockId: 'asc' },
      { language: 'asc' },
      { occurrenceKey: 'asc' },
    ],
  });
  return rows.map((row) => ({
    contentKey: row.contentKey,
    blockId: row.blockId,
    language: row.language,
    modality: row.modality,
    occurrenceKey: row.occurrenceKey,
    carrierType: row.carrierType,
    carrierKey: row.carrierKey,
    carrierVersion: row.carrierVersion,
    anchorSource: row.anchorSource,
  }));
}

/**
 * 组装导出 provenance（C10.6）：
 * - 优先沿用导入时随包的 provenance（含 asr pin），只更新导出时间/导出人；
 * - 否则按本环境内容版本生成显式 planPin（planId 是显式派生记录，非摘要；
 *   C0 红线⑦），审批引用指向该 plan 版本（无 Part C 审批时为未审批导出标记）。
 */
async function resolveExportProvenance(
  prisma: PrismaService,
  options: {
    courseId: string;
    courseKey: string;
    sourceEnv: 'sandbox' | 'production';
    sourceVersionLabel: string;
    exportedBy: string;
    exportedAt: string;
    /** C10.4 时间审计来源（Pc 数据派生；无 Pc 数据时 import-legacy）。 */
    timingSources: readonly string[];
    snapshotProvenance?: PackageProvenance;
  },
): Promise<{
  provenance: PackageProvenance;
  annotations: Record<string, unknown>;
}> {
  const inherited = options.snapshotProvenance;
  let asr = inherited?.asr;
  if (!asr) {
    // 最近一次 Part C 导入包的 ASR pin（若该课程的派生时间来自 ASR，导出必须携带）。
    const job = await prisma.coursePackageJob.findFirst({
      where: { courseId: options.courseId, kind: 'IMPORT', status: 'READY' },
      orderBy: { createdAt: 'desc' },
      select: { manifest: true },
    });
    const manifest = job?.manifest as {
      provenance?: { asr?: PackageProvenance['asr'] };
    } | null;
    asr = manifest?.provenance?.asr;
  }
  const pcVersion = await prisma.pcContentVersion.findFirst({
    where: { courseKey: options.courseKey },
    orderBy: { versionNo: 'desc' },
    select: { planId: true, planVersion: true },
  });
  const planPin = pcVersion
    ? { planId: pcVersion.planId, planVersion: pcVersion.planVersion }
    : {
        planId: `plan/${sanitizeSegment(options.courseKey)}/export-${sanitizeSegment(
          options.sourceVersionLabel,
        )}/target-default/v1`,
        planVersion: 1,
      };
  const provenance: PackageProvenance = {
    sourceEnv: inherited?.sourceEnv ?? options.sourceEnv,
    sourceVersionLabel:
      inherited?.sourceVersionLabel ?? options.sourceVersionLabel,
    exportedAt: options.exportedAt,
    exportedBy: options.exportedBy,
    courseKey: options.courseKey as never,
    planPin: planPin,
    approvalRef: pcVersion
      ? `plan-approval:${sanitizeSegment(pcVersion.planId)}:v${pcVersion.planVersion}`
      : (inherited?.approvalRef ??
        `unapproved-export:${sanitizeSegment(options.courseKey)}`),
    auditSummaryRef:
      inherited?.auditSummaryRef ??
      `audit/${sanitizeSegment(options.courseKey)}/${sanitizeSegment(
        options.sourceVersionLabel,
      )}.json`,
    ...(asr ? { asr } : {}),
  };
  const annotations: Record<string, unknown> = {
    sourceEnv: provenance.sourceEnv,
    sourceLabel: options.sourceVersionLabel,
    exportedBy: options.exportedBy,
    exportedAt: options.exportedAt,
    versionLabel: options.sourceVersionLabel,
    timingSources: [...options.timingSources],
  };
  return { provenance, annotations };
}

/**
 * 从课程聚合生成 Part C v2 包（草稿导出）。
 * 分类路径取完整父链（blocker 9：二级分类不能只写末级 name）。
 */
export async function buildCoursePackage(
  prisma: PrismaService,
  storage: CourseStorageService,
  courseId: string,
  sourceVersion: string,
  options: ExportOptions = {},
): Promise<Buffer> {
  const agg = (await prisma.commerceCourse.findUnique({
    where: { id: courseId },
    include: {
      category: true,
      cover: true,
      localizations: true,
      trialRows: true,
      plans: { where: { active: true }, orderBy: { sortOrder: 'asc' } },
      lessons: {
        orderBy: { sortOrder: 'asc' },
        include: {
          localizations: { include: { video: true } },
          exhibits: { include: { media: true, thumbnail: true } },
          readings: { orderBy: { sortOrder: 'asc' } },
          questions: { orderBy: { sortOrder: 'asc' } },
          applicationTest: true,
          learningPoints: { orderBy: { sortOrder: 'asc' } },
          triggers: true,
        },
      },
    },
  })) as unknown as CourseAggregate | null;
  if (!agg) throw new Error('Course not found');

  const categoryPath = await categoryPathForId(prisma, agg.categoryId);
  const { course, media } = buildCourseSnapshot(agg, categoryPath);
  const mediaBytes = await readMediaBytes(storage, media);
  const exportedAt = new Date().toISOString();
  const contentKeys = contentKeysOfLessonCodes(
    agg.lessons.map((lesson) => lesson.code),
  );
  const audit = await loadPartcExportAudit(prisma, course.code, contentKeys);
  const { provenance, annotations } = await resolveExportProvenance(prisma, {
    courseId,
    courseKey: course.code,
    sourceEnv: options.sourceEnv ?? 'sandbox',
    sourceVersionLabel: options.versionLabel ?? sourceVersion,
    exportedBy: options.exportedBy ?? 'admin',
    exportedAt,
    timingSources: audit.timingSources,
  });
  const [pcStructure, pcRenditionsAll, carriedAssets] = await Promise.all([
    loadPcStructure(prisma, course.code),
    loadPcRenditions(prisma, contentKeys),
    loadPcAssets(prisma, storage, courseId),
  ]);
  // B 缺陷配套：legacy 工作区已明确“无机器时间源”的课时 × 语言，不得把 Pc
  // 里历史残留的带坐标 video rendition 当作当前内容导出（否则 0/null 时间源
  // 课程会重新出现旧时间）。有任一时间源时保留 Pc 全量坐标。
  const timedLessonLanguages = new Set<string>();
  for (const lesson of agg.lessons) {
    for (const lp of lesson.learningPoints ?? []) {
      if (lp.timeSeconds !== null) {
        timedLessonLanguages.add(`${lesson.code}\u0000${lp.language}`);
      }
    }
  }
  const pcRenditions = pcRenditionsAll.filter(
    (rendition) =>
      !(rendition.modality === 'video') ||
      timedLessonLanguages.has(
        `${rendition.contentKey}\u0000${rendition.language}`,
      ),
  );
  const assembled = await assemblePartcPackage(course, mediaBytes, {
    identity: partcIdentityFromCourse(course, {
      versionNo: options.versionNo ?? 1,
      categoryPath,
    }),
    provenance,
    annotations: { ...annotations, slug: agg.slug },
    exportedAt,
    alignments: audit.alignments,
    carriedMedia: await loadCarriedMedia(prisma, contentKeys),
    ...pcStructure,
    ...(pcRenditions.length === 0 ? {} : { pcRenditions }),
    ...(carriedAssets.length === 0 ? {} : { carriedAssets }),
  });
  return assembled.bytes;
}

/**
 * 从线上版本快照导出 Part C v2 包（PRD §16）。
 * 只导出该版本冻结的内容；试看/价格读取本环境当前值（不在包内）。
 */
export async function buildCoursePackageFromSnapshot(
  prisma: PrismaService,
  storage: CourseStorageService,
  courseId: string,
  options: {
    versionId: string;
    environment: string;
    exportedBy?: string;
    sourceEnv?: 'sandbox' | 'production';
  },
): Promise<{ bytes: Buffer; fileName: string; versionLabel: string }> {
  const [course, version] = await Promise.all([
    prisma.commerceCourse.findUnique({
      where: { id: courseId },
      include: {
        category: true,
        plans: { where: { active: true }, orderBy: { sortOrder: 'asc' } },
        trialRows: true,
      },
    }),
    prisma.courseVersion.findUnique({ where: { id: options.versionId } }),
  ]);
  if (!course) throw new Error('Course not found');
  if (!version || version.courseId !== courseId)
    throw new Error('Live version not found');

  const snapshot = version.snapshotData as unknown as VersionSnapshot;
  const assetIds = new Set<string>();
  if (snapshot.course.coverAssetId) assetIds.add(snapshot.course.coverAssetId);
  for (const lesson of snapshot.course.lessons) {
    for (const loc of lesson.localizations)
      if (loc.videoAssetId) assetIds.add(loc.videoAssetId);
    for (const exhibit of lesson.exhibits) {
      if (exhibit.mediaAssetId) assetIds.add(exhibit.mediaAssetId);
      if (exhibit.thumbnailAssetId) assetIds.add(exhibit.thumbnailAssetId);
    }
  }
  const assets = assetIds.size
    ? await prisma.courseMediaAsset.findMany({
        where: { id: { in: [...assetIds] }, courseId },
      })
    : [];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));

  const mediaBytes = new Map<string, Buffer>();
  const addMedia = async (
    path: string,
    assetId: string | null | undefined,
  ): Promise<string | undefined> => {
    if (!assetId) return undefined;
    const asset = assetById.get(assetId);
    if (!asset) throw new Error(`Export failed: media missing for ${path}`);
    const bytes = await storage.getMedia(asset.storageKey);
    mediaBytes.set(path, bytes);
    return path;
  };

  const cover = snapshot.course.coverAssetId
    ? await addMedia(
        packageMediaPath.cover(
          assetById.get(snapshot.course.coverAssetId)?.extension ?? 'bin',
        ),
        snapshot.course.coverAssetId,
      )
    : undefined;

  const lessons: PackageLesson[] = await Promise.all(
    [...snapshot.course.lessons]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(async (lesson) => {
        const localized: Record<string, PackageLessonLocalization> = {};
        for (const loc of lesson.localizations) {
          const lps = lesson.learningPoints
            .filter((lp) => lp.language === loc.language)
            .sort((a, b) => a.sortOrder - b.sortOrder);
          const video = loc.videoAssetId
            ? {
                file: (await addMedia(
                  packageMediaPath.video(
                    lesson.code,
                    loc.language,
                    assetById.get(loc.videoAssetId)?.extension ?? 'bin',
                  ),
                  loc.videoAssetId,
                )) as string,
                durationSeconds: loc.videoDurationSeconds ?? undefined,
                learningPoints: lps
                  .filter((lp) => lp.source === 'VIDEO')
                  .map((lp) => ({
                    code: lp.code,
                    // C7：无时间源显式 null，绝不写 0 伪造。
                    timeSeconds: lp.timeSeconds ?? null,
                    title: lp.title,
                  })),
                exhibitTriggers: lesson.triggers
                  .filter((trigger) => trigger.language === loc.language)
                  .map((trigger) => ({
                    timeSeconds: trigger.timeSeconds,
                    exhibitRef: trigger.exhibitCode,
                  })),
              }
            : null;
          localized[loc.language] = {
            title: loc.title,
            description: loc.description ?? undefined,
            video,
            text: loc.textHtml
              ? {
                  html: loc.textHtml,
                  learningPoints: lps
                    .filter((lp) => lp.source === 'TEXT')
                    .map((lp) => ({ code: lp.code, heading: lp.title })),
                }
              : null,
          };
        }

        const exhibits: PackageExhibit[] = lesson.exhibits.map((exhibit) => ({
          code: exhibit.code,
          type: exhibit.type as PackageExhibit['type'],
          file: undefined,
          thumbnail: undefined,
          source: exhibit.sourceText ?? undefined,
          localized: (exhibit.localized as PackageExhibit['localized']) ?? {},
        }));

        return {
          code: lesson.code,
          order: lesson.sortOrder,
          localized,
          exhibits,
          recommendedReading: groupReadings(lesson.readings),
          knowledgeTest: {
            enabled: lesson.questions.length > 0,
            questions: lesson.questions
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((question) => ({
                code: question.code,
                question: question.question,
                referenceAnswer: question.referenceAnswer ?? undefined,
              })),
          },
          applicationTest: lesson.applicationTest
            ? {
                enabled: lesson.applicationTest.enabled,
                scenario: lesson.applicationTest.scenario,
                referenceAnswer:
                  lesson.applicationTest.referenceAnswer ?? undefined,
              }
            : undefined,
        };
      }),
  );

  // 展品媒体是异步读取的；上面 map 里先占位，这里统一补齐。
  const pkgLessonByCode = new Map(
    lessons.map((lesson) => [lesson.code, lesson]),
  );
  for (const lesson of snapshot.course.lessons) {
    const pkgLesson = pkgLessonByCode.get(lesson.code);
    if (!pkgLesson) continue;
    for (const [exhibitIndex, exhibit] of lesson.exhibits.entries()) {
      const pkgExhibit = pkgLesson.exhibits?.[exhibitIndex];
      if (!pkgExhibit) continue;
      pkgExhibit.file = await addMedia(
        packageMediaPath.exhibit(
          exhibit.code,
          assetById.get(exhibit.mediaAssetId ?? '')?.extension ?? 'bin',
        ),
        exhibit.mediaAssetId,
      );
      pkgExhibit.thumbnail = await addMedia(
        packageMediaPath.exhibitThumb(
          exhibit.code,
          assetById.get(exhibit.thumbnailAssetId ?? '')?.extension ?? 'bin',
        ),
        exhibit.thumbnailAssetId,
      );
    }
  }

  const lessonCodes = new Set(lessons.map((lesson) => lesson.code));
  const codeByLessonId = new Map(
    snapshot.course.lessons.map((lesson) => [lesson.id, lesson.code]),
  );
  // 课程包里的 Trial 截止点必须用稳定的 LP code，而不是本环境数据库 ID。
  const cutoffIds = [
    ...new Set(
      course.trialRows
        .map((row) => row.textCutoffLearningPointId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const cutoffRows = cutoffIds.length
    ? await prisma.learningPoint.findMany({
        where: { id: { in: cutoffIds } },
        select: { id: true, code: true },
      })
    : [];
  const lpCodeById = new Map(cutoffRows.map((row) => [row.id, row.code]));
  const trial = {
    enabled: course.trialEnabled,
    lessons: course.trialRows
      .map((row) => ({
        lessonRef: codeByLessonId.get(row.lessonId) ?? '',
        videoCutoffSeconds: row.videoCutoffSeconds,
        textCutoffLearningPoint: row.textCutoffLearningPointId
          ? (lpCodeById.get(row.textCutoffLearningPointId) ?? null)
          : null,
        status: row.status,
      }))
      .filter((row) => lessonCodes.has(row.lessonRef)),
  };

  const courseLocalized: PackageCourse['localized'] = {};
  for (const loc of snapshot.course.localizations) {
    courseLocalized[loc.language] = {
      title: loc.title,
      shortDescription: loc.shortDescription ?? undefined,
      overview: loc.overview ?? undefined,
      whatYouLearn: (loc.whatYouLearn as string[] | null) ?? [],
      provides: (loc.provides as unknown[] | null) ?? [],
    };
  }

  // C6/C8：历史版本导出用该版本快照的分类路径（稳定键序列），不是当前行；
  // 未分类 → null，禁止任何占位分类（M5）。
  const categoryPath = await snapshotCategoryPath(prisma, snapshot);
  const pkgCourse: PackageCourse = {
    code: snapshot.course.code,
    slug: snapshot.course.slug,
    categoryPath,
    learningMode: snapshot.course.learningMode as PackageCourse['learningMode'],
    learningLanguages: snapshot.course.learningLanguages,
    defaultContentLanguage: snapshot.course.defaultContentLanguage,
    cover,
    localized: courseLocalized,
    lessons,
    trial,
    pricing: course.plans.map((plan) => ({
      name: plan.name,
      termMonths: plan.termMonths,
      amountMinor: plan.amountMinor,
      currency: plan.currency,
      lookupKey:
        plan.stripeLookupKey ?? `${snapshot.course.code}_${plan.termMonths}m`,
    })),
  };

  const exportedAt = new Date().toISOString();
  const contentKeys = contentKeysOfLessonCodes(
    snapshot.course.lessons.map((lesson) => lesson.code),
  );
  const audit = await loadPartcExportAudit(
    prisma,
    snapshot.course.code,
    contentKeys,
  );
  const { provenance, annotations } = await resolveExportProvenance(prisma, {
    courseId,
    courseKey: snapshot.course.code,
    sourceEnv: options.sourceEnv ?? snapshot.provenance?.sourceEnv ?? 'sandbox',
    sourceVersionLabel: version.versionLabel,
    exportedBy: options.exportedBy ?? 'admin',
    exportedAt,
    timingSources: audit.timingSources,
    snapshotProvenance: snapshot.provenance as PackageProvenance | undefined,
  });
  const assembled = await assemblePartcPackage(pkgCourse, mediaBytes, {
    identity: partcIdentityFromCourse(pkgCourse, {
      versionNo: version.versionNo,
      categoryPath,
    }),
    provenance,
    annotations: { ...annotations, slug: snapshot.course.slug },
    exportedAt,
    alignments: audit.alignments,
    carriedMedia: await loadCarriedMedia(prisma, contentKeys),
    ...(await loadPcStructure(prisma, course.code)),
  });

  return {
    bytes: assembled.bytes,
    fileName: `${snapshot.course.code}_${version.versionLabel}.zip`,
    versionLabel: version.versionLabel,
  };
}

async function readMediaBytes(
  storage: CourseStorageService,
  media: Array<{ path: string; storageKey: string }>,
): Promise<Map<string, Buffer>> {
  const bytes = new Map<string, Buffer>();
  for (const ref of media) {
    if (!ref.storageKey) continue;
    try {
      bytes.set(ref.path, await storage.getMedia(ref.storageKey));
    } catch {
      // 媒体缺失时导出失败（不允许坏包）
      throw new Error(`Export failed: media missing for ${ref.path}`);
    }
  }
  return bytes;
}

function groupReadings(
  readings: Array<{
    language: string;
    type: string;
    title: string;
    author: string | null;
    whyRecommended: string | null;
    sortOrder: number;
  }>,
): Record<string, PackageReading[]> {
  const grouped: Record<string, PackageReading[]> = {};
  for (const reading of [...readings].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  )) {
    (grouped[reading.language] ??= []).push({
      type: reading.type as PackageReading['type'],
      title: reading.title,
      author: reading.author ?? undefined,
      why: reading.whyRecommended ?? undefined,
    });
  }
  return grouped;
}
