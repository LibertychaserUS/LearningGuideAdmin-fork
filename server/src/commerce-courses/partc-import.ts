import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { Prisma } from '@prisma/client';
import {
  PackageManifestV2Schema,
  type ContentSpec,
  type PackageManifestV2,
  type PublishTarget,
  type Rendition,
  type Stage,
} from '../partc/contracts';
import {
  alignPackage,
  assetVersionsFromPins,
  type AlignResult,
  type ProposedAlignment,
} from '../partc/compiler/align';
import {
  deriveTiming,
  probeMp4DurationMs,
  type DocumentHeadingInput,
  type DocumentStructureInput,
  type TimingResult,
  type TranscriptArtifactInput,
} from '../partc/compiler/derive-timing';
import {
  parsePackage,
  type CompilerIssue,
  type PackageIR,
  type RawSheet,
  type RawWorkbook,
} from '../partc/compiler/parse';
import {
  hasBlockingErrors,
  validatePackage,
  type ValidatedRows,
} from '../partc/compiler/validate';
import { PartCError } from '../partc/errors';
import { convertDocxToHtml } from './docx-to-html';
import type {
  PackageValidationIssue,
  PackageValidationReport,
} from './contracts/manifest';
import type { VersionSnapshot, SnapshotLesson } from './version-snapshot';

/**
 * Part C v2 课程包导入适配层（评审阻断 2/3/4-Admin；设计 SSOT §14 C5 P1–P4、
 * C10.3/C10.4）。
 *
 * 职责边界：
 * - 契约：manifest 只按 `partc/contracts/package-manifest.ts`（唯一 SSOT）解析；
 *   本模块不另立 v2 形状。
 * - 编译器：`parsePackage → validatePackage → deriveTiming → alignPackage`
 *   全部复用 `src/partc/compiler` 的纯函数，不复制任何校验/派生逻辑。
 * - 持久化：pc_* 实体的仓库层（C3 映射，见 prisma/schema.prisma 注释）。
 *   事务边界由调用方（package-importer 的 job 约定）提供。
 * - 兼容：本模块只处理 Part C v2 包；旧聚合形状（course.lessons）仍走既有
 *   legacy importer（过渡适配层，见 contracts/manifest.ts 头注）。
 *
 * 全系统不使用内容哈希/digest：这里没有任何 sha/checksum 参与身份。
 */

/** manifest 是否满足 Part C v2 契约（唯一 v2 SSOT）。 */
export function isPartCV2Manifest(raw: unknown): raw is PackageManifestV2 {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  return PackageManifestV2Schema.safeParse(raw).success;
}

/**
 * 解码模板工作簿（xlsx）为编译器 RawWorkbook。
 * 第一行是表头；其余行为数据行（空行交给 parse 的 isBlankRow 过滤）。
 */
export function decodeTemplateWorkbook(
  bytes: Buffer | Uint8Array,
): RawWorkbook {
  const workbook = XLSX.read(Buffer.from(bytes), { type: 'buffer' });
  const sheets: Record<string, RawSheet> = {};
  for (const name of workbook.SheetNames) {
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], {
      header: 1,
      defval: null,
      raw: true,
    });
    const headers = matrix[0] ?? [];
    const rows = matrix.slice(1).map((row) => row);
    sheets[name] = { headers, rows };
  }
  return { sheets };
}

/** 模板资源路径（manifest.resources 中 kind === 'template' 的唯一一项）。 */
export function templateResourcePathOf(manifest: PackageManifestV2): string {
  const template = manifest.resources.find(
    (resource) => resource.kind === 'template',
  );
  if (!template) {
    throw new PartCError(
      'TEMPLATE_FORMAT_UNSUPPORTED',
      'package must declare exactly one template resource',
      { reason: 'template-resource-count', count: 0 },
    );
  }
  return template.path;
}

export interface PartcCompileInput {
  readonly manifest: PackageManifestV2;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly workbook: RawWorkbook;
  readonly documents?: readonly DocumentStructureInput[];
}

export interface PartcCompiledPackage {
  readonly ir: PackageIR;
  readonly rows: ValidatedRows;
  readonly timing: TimingResult;
  readonly align: AlignResult;
  /** validation + timing + align 的全部 issue（error 阻断、incomplete 阻止发布）。 */
  readonly issues: readonly CompilerIssue[];
}

/** 编译期阻断错误：携带结构化 issue 报告（job report 必须有错误码与源坐标）。 */
export class PartcCompileError extends Error {
  readonly code: string;
  readonly report: PackageValidationReport;
  constructor(code: string, message: string, report: PackageValidationReport) {
    super(message);
    this.name = 'PartcCompileError';
    this.code = code;
    this.report = report;
  }
}

function issueToValidationIssue(issue: CompilerIssue): PackageValidationIssue {
  const coordinate = issue.source;
  const path =
    coordinate?.sheet !== undefined
      ? `${coordinate.sheet}${coordinate.row !== undefined ? `!${coordinate.row}` : ''}${coordinate.column ? `!${coordinate.column}` : ''}`
      : coordinate?.path;
  return {
    level: issue.severity === 'error' ? 'error' : 'warning',
    code: issue.code,
    message:
      issue.details === undefined
        ? issue.message
        : `${issue.message} ${JSON.stringify(issue.details)}`,
    ...(path === undefined ? {} : { path }),
  };
}

/** CompilerIssue[] → job report（error 阻断；incomplete/warning 只入报告）。 */
export function reportFromIssues(
  issues: readonly CompilerIssue[],
): PackageValidationReport {
  const errors: PackageValidationIssue[] = [];
  const warnings: PackageValidationIssue[] = [];
  for (const issue of issues) {
    const mapped = issueToValidationIssue(issue);
    if (issue.severity === 'error') errors.push(mapped);
    else warnings.push(mapped);
  }
  return {
    errors,
    warnings,
    incomplete: issues.some((issue) => issue.severity !== 'warning'),
  };
}

/** PartCError → 报告（单条错误，带 code 与 details.path）。 */
export function reportFromPartCError(
  error: PartCError,
): PackageValidationReport {
  const details = error.details ?? {};
  const coordinates: string[] = [];
  if (typeof details.path === 'string') coordinates.push(details.path);
  if (typeof details.sheet === 'string') coordinates.push(details.sheet);
  const issues = Array.isArray(details.issues)
    ? (details.issues as Array<Record<string, unknown>>)
    : [];
  return {
    errors: [
      {
        level: 'error',
        code: error.code,
        message:
          issues.length > 0
            ? `${error.message}: ${issues
                .map((issue) => {
                  const text = (value: unknown): string =>
                    typeof value === 'string'
                      ? value
                      : (JSON.stringify(value) ?? '');
                  return `${text(issue.path)} ${text(issue.message)}`;
                })
                .join('; ')}`
            : error.message,
        ...(coordinates.length > 0 ? { path: coordinates.join(' / ') } : {}),
      },
    ],
    warnings: [],
    incomplete: true,
  };
}

/**
 * 编译器主管线（纯函数段）：parse → validate → deriveTiming → align。
 * 任一阶段出现 blocking error 即抛 PartcCompileError（整包拒绝，原子）。
 * incomplete 只入报告，允许入库为草稿（C5 P2）。
 */
export function compilePartcPackage(
  input: PartcCompileInput,
): PartcCompiledPackage {
  const ir = parsePackage({
    manifest: input.manifest,
    files: input.files,
    workbook: input.workbook,
  });
  return compilePartcPackageFromIr(ir, input.documents);
}

/** 同一管线的后半段（已 parse 的 IR；供薄壳先抽取 DOCX / ASR 再派生时间）。 */
export function compilePartcPackageFromIr(
  ir: PackageIR,
  documents?: readonly DocumentStructureInput[],
  transcripts?: readonly TranscriptArtifactInput[],
  assetVersions?: Readonly<Record<string, number>>,
): PartcCompiledPackage {
  const validation = validatePackage(ir);
  const timing = deriveTiming({
    ir,
    rows: validation.rows,
    documents,
    // C5 P3/C7 ③：ASR 是默认兜底时间源；薄壳为每个视频 × 每个语言生成转写
    // 工件后传入。缺失即视为无 ASR 源（不猜时间）。
    ...(transcripts === undefined ? {} : { transcripts }),
  });
  const align = alignPackage({
    ir,
    rows: validation.rows,
    timing,
    documents,
    // 资产版本来自 manifest.content.assetPins（身份=assetKey+assetVersion；
    // 换视频携带新版本时不猜、不复用旧版本）。
    options: {
      assetVersions: assetVersions ?? assetVersionsFromPins(ir),
    },
  });
  const issues = [...validation.issues, ...timing.issues, ...align.issues];
  if (hasBlockingErrors(issues)) {
    const report = reportFromIssues(issues);
    // 顶层错误码取首个阻断 issue 的封闭词表码（C5 冻结码表；不新造码）。
    throw new PartcCompileError(
      report.errors[0]?.code ?? 'PACKAGE_FORMAT_UNSUPPORTED',
      'course package failed Part C validation',
      report,
    );
  }
  return { ir, rows: validation.rows, timing, align, issues };
}

// ---------------------------------------------------------------------------
// DOCX 文档结构（文本锚点与 [Exhibit: code] 触发标记）
// ---------------------------------------------------------------------------

const EXHIBIT_MARKER = /\[Exhibit:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s*\]/g;

/** DOCX 标题编号/文本 → 契约要求的稳定 token（编码，不改写正文）。 */
function stableHeadingCode(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, 120);
  return cleaned === '' ? 'heading' : cleaned;
}

function htmlToLines(html: string): string[] {
  return html
    .split(/<\/(?:p|h[1-6]|li|div|tr)>|<br\s*\/?>/i)
    .map((line) =>
      line
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => line !== '');
}

/**
 * 从包内 lesson-text（DOCX）抽取 DocumentStructureInput（C7：DOCX Heading
 * 只用于文本锚点；正文 [Exhibit: code] 标记用于触发点）。
 * 多个语言独立抽取；解析失败不阻断（deriveTiming 会以 incomplete 显式报告）。
 */
export async function extractPartcDocuments(
  ir: PackageIR,
): Promise<DocumentStructureInput[]> {
  const documents: DocumentStructureInput[] = [];
  for (const row of ir.template.sheets.Media) {
    const values = row.values;
    if (values.kind !== 'lesson-text') continue;
    const lessonCode = values.lesson_code;
    const language = values.language;
    const assetKey = values.asset_key;
    const relativePath = values.relative_path;
    if (
      typeof lessonCode !== 'string' ||
      typeof language !== 'string' ||
      typeof assetKey !== 'string' ||
      typeof relativePath !== 'string'
    ) {
      continue;
    }
    const bytes = ir.files.get(relativePath);
    if (!bytes) continue;
    const converted = await convertDocxToHtml(Buffer.from(bytes));
    const headings: DocumentHeadingInput[] = converted.headings.map(
      (heading) => ({
        // Rendition.headingCode 契约要求稳定 token；DOCX 标题可能只有人类文本，
        // 这里做确定性编码（编号优先），供锚点与 rendition 使用。
        headingCode: stableHeadingCode(heading.code || heading.title),
        title: heading.title,
      }),
    );
    const triggerMarkers: Array<{ exhibitCode: string; lineText: string }> = [];
    for (const line of htmlToLines(converted.html)) {
      EXHIBIT_MARKER.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = EXHIBIT_MARKER.exec(line)) !== null) {
        triggerMarkers.push({ exhibitCode: match[1], lineText: line });
      }
    }
    documents.push({
      assetKey,
      lessonCode,
      language,
      headings,
      triggerMarkers,
      ...(converted.html.trim() === '' ? {} : { html: converted.html }),
    });
  }
  return documents;
}

// ---------------------------------------------------------------------------
// pc_* 持久化（仓库层；调用方提供事务）
// ---------------------------------------------------------------------------

export interface PartcPersistContext {
  readonly courseId: string;
  /** 资源路径 → 本环境存储 uri（媒体/文档/字幕均落地）。 */
  readonly uriByPath: ReadonlyMap<string, string>;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** JSON 列写入：null/undefined 必须落 DB NULL（update 时 undefined 会保留旧值）。 */
function jsonOrDbNull(
  value: unknown,
): Prisma.InputJsonValue | Prisma.NullTypes.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : value;
}

export function publishTargetsOf(manifest: PackageManifestV2): PublishTarget[] {
  const modalities =
    manifest.course.studyMode === 'video'
      ? (['video'] as const)
      : manifest.course.studyMode === 'text'
        ? (['text'] as const)
        : (['video', 'text'] as const);
  return [
    {
      languages: [...manifest.course.learningLanguages],
      modalities: [...modalities],
    },
  ];
}

function stageDepth(
  stageKey: string,
  stages: ReadonlyMap<string, Pick<Stage, 'stageKey' | 'parentStageKey'>>,
): number {
  let depth = 1;
  let current = stages.get(stageKey)?.parentStageKey ?? null;
  let guard = 0;
  while (current !== null && guard < 32) {
    depth += 1;
    current = stages.get(current)?.parentStageKey ?? null;
    guard += 1;
  }
  return depth;
}

/**
 * 把编译产物写入 pc_* 实体（C3 映射）。同一事务内完成；调用方负责事务边界。
 *
 * 幂等/重导入语义：课程/媒体/内容规格/rendition 按稳定键 upsert；阶段按
 * stageKey upsert 并删除本次不再声明的阶段；verified 对齐绝不覆盖（人签优先）。
 */
export async function persistPartcEntities(
  tx: Prisma.TransactionClient,
  compiled: PartcCompiledPackage,
  context: PartcPersistContext,
): Promise<void> {
  const { ir, rows, timing, align } = compiled;
  const manifest = ir.manifest;
  const courseKey = manifest.course.courseKey;

  await tx.pcCourse.upsert({
    where: { courseKey },
    create: {
      courseKey,
      categoryPath: jsonOrDbNull(manifest.course.categoryPath),
      titleLocalized: jsonValue(manifest.course.titleLocalized),
      publishTargets: jsonValue(publishTargetsOf(manifest)),
    },
    update: {
      categoryPath: jsonOrDbNull(manifest.course.categoryPath),
      titleLocalized: jsonValue(manifest.course.titleLocalized),
      publishTargets: jsonValue(publishTargetsOf(manifest)),
    },
  });

  // 媒体资产（身份 = assetKey + assetVersion；无哈希）。版本来自包内显式
  // assetPins（B：换视频必须是新版本，旧版本行保留可读）。
  const assetVersions = assetVersionsFromPins(ir);
  const durationByAssetKey = new Map(
    timing.assets.map((asset) => [asset.assetKey, asset.durationMs]),
  );
  for (const row of rows.media) {
    const media = row.value;
    const uri = context.uriByPath.get(media.relative_path);
    const assetVersion = assetVersions[media.asset_key];
    if (assetVersion === undefined) {
      // 未被任何 rendition 引用且未 pin 的媒体（如课程封面/纯展示资源）不属于
      // Part C 资产身份：align.requireAssetVersion 已对 rendition 载体报
      // CONTENT_INCOMPLETE，这里跳过即可，绝不猜版本。
      continue;
    }
    const durationMs =
      media.kind === 'video' || media.kind === 'audio'
        ? (durationByAssetKey.get(media.asset_key) ??
          (() => {
            const bytes = ir.files.get(media.relative_path);
            return bytes ? probeMp4DurationMs(bytes) : null;
          })())
        : null;
    await tx.pcMediaAsset.upsert({
      where: {
        assetKey_assetVersion: {
          assetKey: media.asset_key,
          assetVersion,
        },
      },
      create: {
        assetKey: media.asset_key,
        assetVersion,
        kind: media.kind,
        language: media.language,
        durationMs,
        uri: uri ?? `package:${media.relative_path}`,
      },
      update: {
        kind: media.kind,
        language: media.language,
        durationMs,
        uri: uri ?? `package:${media.relative_path}`,
      },
    });
  }

  // 阶段：upsert 本次声明；删除不再声明的阶段（按深度倒序避免父先于子）。
  const incomingStages = new Map<string, Stage>(
    ir.content.stages.map((stage) => [String(stage.stageKey), stage]),
  );
  const existingStages = await tx.pcStage.findMany({
    where: { courseKey },
    select: { stageKey: true, parentStageKey: true, courseKey: true },
  });
  const depthByKey = new Map<string, number>();
  const depthOf = (key: string): number => {
    const cached = depthByKey.get(key);
    if (cached !== undefined) return cached;
    let depth = 1;
    let current = existingStages.find(
      (s) => s.stageKey === key,
    )?.parentStageKey;
    let guard = 0;
    while (current && guard < 32) {
      depth += 1;
      current = existingStages.find(
        (s) => s.stageKey === current,
      )?.parentStageKey;
      guard += 1;
    }
    depthByKey.set(key, depth);
    return depth;
  };
  const removed = existingStages
    .filter((stage) => !incomingStages.has(stage.stageKey))
    .sort((left, right) => depthOf(right.stageKey) - depthOf(left.stageKey));
  for (const stage of removed) {
    await tx.pcAlignment.deleteMany({ where: { stageKey: stage.stageKey } });
    await tx.pcStage.delete({ where: { stageKey: stage.stageKey } });
  }
  const orderedStages = [...ir.content.stages].sort(
    (left, right) =>
      stageDepth(left.stageKey, incomingStages) -
      stageDepth(right.stageKey, incomingStages),
  );
  for (const stage of orderedStages) {
    const data = {
      courseKey,
      parentStageKey: stage.parentStageKey,
      orderKey: stage.orderKey,
      kind: stage.kind,
      goal: stage.goal,
      objectiveKeys: [...stage.objectiveKeys],
      exitEvidence: [...stage.exitEvidence],
      exitRollup: jsonValue(stage.exitRollup),
      durationBudget: stage.durationBudget ?? null,
      status: stage.status,
    };
    const owner = existingStages.find((row) => row.stageKey === stage.stageKey);
    if (owner !== undefined && owner.courseKey !== courseKey) {
      throw new PartCError(
        'PACKAGE_FORMAT_UNSUPPORTED',
        'stageKey is already owned by another course; stage keys must be globally stable',
        { stageKey: stage.stageKey, ownerCourseKey: owner.courseKey },
      );
    }
    await tx.pcStage.upsert({
      where: { stageKey: stage.stageKey },
      create: { stageKey: stage.stageKey, ...data },
      update: data,
    });
  }

  // 目标：stage/evidence/alignment 引用到的 objective 必须存在（PcAlignment FK）。
  const objectiveKeys = new Set<string>();
  for (const stage of ir.content.stages) {
    stage.objectiveKeys.forEach((key) => objectiveKeys.add(key));
  }
  for (const spec of ir.content.evidenceSpecs) {
    spec.objectiveKeys.forEach((key) => objectiveKeys.add(key));
  }
  for (const proposed of align.alignments) {
    objectiveKeys.add(proposed.alignment.objectiveKey);
  }
  for (const objectiveKey of [...objectiveKeys].sort()) {
    await tx.pcObjective.upsert({
      where: { objectiveKey },
      create: {
        objectiveKey,
        courseKey,
        statement: objectiveKey,
        status: 'active',
      },
      update: { courseKey },
    });
  }

  // 先修边：整组替换（边没有独立身份，属于树结构）。
  await tx.pcPrerequisiteEdge.deleteMany({
    where: {
      OR: [{ fromStage: { courseKey } }, { toStage: { courseKey } }],
    },
  });
  for (const edge of ir.content.prerequisiteEdges) {
    await tx.pcPrerequisiteEdge.create({
      data: {
        fromStageKey: edge.fromStageKey,
        toStageKey: edge.toStageKey,
        kind: edge.kind,
      },
    });
  }

  // 证据规格：按 (evidenceKey, version) 版本化 upsert；旧版本保留。
  for (const spec of ir.content.evidenceSpecs) {
    await tx.pcEvidenceSpec.upsert({
      where: {
        evidenceKey_version: {
          evidenceKey: spec.evidenceKey,
          version: spec.version,
        },
      },
      create: {
        evidenceKey: spec.evidenceKey,
        version: spec.version,
        kind: spec.kind,
        objectiveKeys: [...spec.objectiveKeys],
        measure: jsonValue(spec.measure),
        scoring: spec.scoring,
        threshold: spec.threshold,
        attempts: spec.attempts,
      },
      update: {
        kind: spec.kind,
        objectiveKeys: [...spec.objectiveKeys],
        measure: jsonValue(spec.measure),
        scoring: spec.scoring,
        threshold: spec.threshold,
        attempts: spec.attempts,
      },
    });
  }

  // 内容规格与块：同版本内整组替换（block 顺序 = sortOrder）。
  for (const spec of align.contentSpecs) {
    await tx.pcContentSpec.upsert({
      where: {
        contentKey_version: {
          contentKey: spec.contentKey,
          version: spec.version,
        },
      },
      create: contentSpecData(spec, courseKey),
      update: {
        courseKey,
        type: spec.type,
        titleLocalized: jsonValue(spec.titleLocalized),
        objectiveHints: [...(spec.objectiveHints ?? [])],
        sourceRefs: [...(spec.sourceRefs ?? [])],
      },
    });
    await tx.pcBlock.deleteMany({
      where: { contentKey: spec.contentKey, version: spec.version },
    });
    for (const [index, block] of spec.blocks.entries()) {
      await tx.pcBlock.create({
        data: {
          contentKey: block.contentKey,
          version: block.version,
          blockId: block.blockId,
          sortOrder: index,
          kind: block.kind,
          payload: jsonValue(block.payload),
        },
      });
    }
  }

  // Rendition：稳定 renditionKey 幂等 upsert（坐标单源，无哈希）。
  //
  // C5 P8 / C10.2 Re-confirm：换视频（新 assetVersion）、坐标或时间源变化时，
  // 必须以已落库的记录为基准把 revision 单调 +1。包内通常不携带旧 rendition，
  // 若只信包内派生值（恒为 1），旧 verified 对齐的 verifiedAgainst 审计元组会
  // 误判为「仍然匹配」而静默沿用旧签收。revision 一经变化，ALN-6 读时派生
  // stale，旧对齐不得进入 plan/发布，必须重新派生并人签。
  for (const rendition of align.renditions) {
    const existing = await tx.pcRendition.findUnique({
      where: { renditionKey: rendition.renditionKey },
      select: {
        revision: true,
        carrierVersion: true,
        startMs: true,
        endMs: true,
        headingCode: true,
        offset: true,
        anchorSource: true,
      },
    });
    let revision = rendition.revision;
    if (existing !== null) {
      const changed =
        existing.carrierVersion !== rendition.carrierVersion ||
        existing.startMs !== (rendition.startMs ?? null) ||
        existing.endMs !== (rendition.endMs ?? null) ||
        existing.headingCode !== (rendition.headingCode ?? null) ||
        existing.offset !== (rendition.offset ?? null) ||
        existing.anchorSource !== rendition.anchorSource;
      revision = Math.max(
        changed ? existing.revision + 1 : existing.revision,
        rendition.revision,
      );
    }
    const data = renditionData({ ...rendition, revision });
    await tx.pcRendition.upsert({
      where: { renditionKey: rendition.renditionKey },
      create: data,
      update: data,
    });
  }

  // 对齐：导入默认只产出 proposed；但包内携带的 verified 对齐在
  // 「同一 assetKey+assetVersion、锚点未变」时保持 verified（C10.2：审计元组
  // 随包携带，人签不因换环境丢失）。锚点/版本变化 → stale 降级为 proposed。
  const oldVerifiedById = new Map(
    (ir.content.alignments ?? []).map((alignment) => [
      alignment.alignmentId,
      alignment,
    ]),
  );
  const renditionByKey = new Map(
    align.renditions.map((rendition) => [rendition.renditionKey, rendition]),
  );
  const specVersionByContentKey = new Map<string, number>();
  for (const pin of ir.content.specPins) {
    const current = specVersionByContentKey.get(pin.contentKey) ?? 0;
    if (pin.version > current) {
      specVersionByContentKey.set(pin.contentKey, pin.version);
    }
  }
  let alignmentWrites = 0;
  for (const proposed of align.alignments) {
    const carried = carriedVerification(proposed, {
      oldVerifiedById,
      renditionByKey,
      specVersionByContentKey,
    });
    const written = await persistProposedAlignment(
      tx,
      proposed,
      courseKey,
      carried,
    );
    if (written) alignmentWrites += 1;
  }

  // C6 inputClosure 单调计数器：本事务写入了树/边与对齐，各自 +1。
  await tx.pcCourse.update({
    where: { courseKey },
    data: {
      structureRevision: { increment: 1 },
      ...(alignmentWrites === 0
        ? {}
        : { alignmentSetVersion: { increment: 1 } }),
    },
  });
}

function contentSpecData(
  spec: ContentSpec,
  courseKey: string,
): Prisma.PcContentSpecCreateInput {
  return {
    contentKey: spec.contentKey,
    version: spec.version,
    courseKey,
    type: spec.type,
    titleLocalized: jsonValue(spec.titleLocalized),
    objectiveHints: [...(spec.objectiveHints ?? [])],
    sourceRefs: [...(spec.sourceRefs ?? [])],
  };
}

function renditionData(rendition: Rendition): Prisma.PcRenditionCreateInput {
  return {
    renditionKey: rendition.renditionKey,
    contentKey: rendition.contentKey,
    blockId: rendition.blockId,
    language: rendition.language,
    modality: rendition.modality,
    occurrenceKey: rendition.occurrenceKey,
    carrierType: rendition.carrierType,
    carrierKey: rendition.carrierKey,
    carrierVersion: rendition.carrierVersion,
    startMs: rendition.startMs ?? null,
    endMs: rendition.endMs ?? null,
    headingCode: rendition.headingCode ?? null,
    offset: rendition.offset ?? null,
    anchorSource: rendition.anchorSource,
    revision: rendition.revision,
  };
}

interface CarriedVerification {
  readonly verifiedBy: string;
  readonly verifiedAt: Date;
  readonly verifiedAgainst: {
    readonly renditionRevision: number;
    readonly carrierVersion: number;
    readonly specVersion: number;
  };
}

/**
 * C10.2：包内 verified 对齐跨环境保持 verified 的判定。
 * 仅当重绑为「未变化」（同 assetVersion、同锚点）且审计元组与本次派生
 * rendition/spec pin 完全一致时，原样携带人签；否则不携带（留给 proposed/stale）。
 */
function carriedVerification(
  proposed: ProposedAlignment,
  context: {
    oldVerifiedById: ReadonlyMap<
      string,
      {
        verifiedBy?: string | null;
        verifiedAt?: string | null;
        verifiedAgainst?: {
          renditionRevision: number;
          carrierVersion: number;
          specVersion: number;
        } | null;
      }
    >;
    renditionByKey: ReadonlyMap<
      string,
      { revision: number; carrierVersion: number; contentKey: string }
    >;
    specVersionByContentKey: ReadonlyMap<string, number>;
  },
): CarriedVerification | null {
  if (
    proposed.rebind !== 'rebound' ||
    proposed.previousAlignmentId === undefined
  ) {
    return null;
  }
  const old = context.oldVerifiedById.get(proposed.previousAlignmentId);
  if (
    old === undefined ||
    typeof old.verifiedBy !== 'string' ||
    typeof old.verifiedAt !== 'string' ||
    old.verifiedAgainst === undefined ||
    old.verifiedAgainst === null
  ) {
    return null;
  }
  const rendition = context.renditionByKey.get(proposed.alignment.renditionKey);
  if (rendition === undefined) return null;
  const specVersion = context.specVersionByContentKey.get(rendition.contentKey);
  if (specVersion === undefined) return null;
  const { verifiedAgainst } = old;
  if (
    verifiedAgainst.renditionRevision !== rendition.revision ||
    verifiedAgainst.carrierVersion !== rendition.carrierVersion ||
    verifiedAgainst.specVersion !== specVersion
  ) {
    return null;
  }
  return {
    verifiedBy: old.verifiedBy,
    verifiedAt: new Date(old.verifiedAt),
    verifiedAgainst,
  };
}

async function persistProposedAlignment(
  tx: Prisma.TransactionClient,
  proposed: ProposedAlignment,
  courseKey: string,
  carried: CarriedVerification | null,
): Promise<boolean> {
  const alignment = proposed.alignment;
  const stage = await tx.pcStage.findUnique({
    where: { stageKey: alignment.stageKey },
    select: { courseKey: true },
  });
  if (!stage || stage.courseKey !== courseKey) return false;
  const existing = await tx.pcAlignment.findUnique({
    where: {
      stageKey_renditionKey: {
        stageKey: alignment.stageKey,
        renditionKey: alignment.renditionKey,
      },
    },
    select: { alignmentId: true, status: true, provenance: true },
  });
  if (existing?.status === 'verified') {
    // 人签对齐优先：导入重绑不得把 verified 降级为 proposed（ALN-2/ALN-6）。
    return false;
  }
  const audit = proposed.timingProvenance;
  const modelPinned =
    audit !== undefined &&
    (audit.sourceKind === 'asr' || audit.sourceKind === 'forced-alignment');
  const desiredStatus = carried === null ? 'proposed' : 'verified';
  const data = {
    stageKey: alignment.stageKey,
    renditionKey: alignment.renditionKey,
    objectiveKey: alignment.objectiveKey,
    role: alignment.role,
    status: desiredStatus,
    provenance: proposed.provenance,
    sourceKind: audit?.sourceKind ?? null,
    sourceArtifact: audit?.sourceArtifact ?? null,
    modelVersion: modelPinned ? (audit?.modelVersion ?? null) : null,
    params: modelPinned ? jsonValue(audit?.params ?? {}) : Prisma.DbNull,
    ruleVersion: audit?.ruleVersion ?? null,
    // ASR/强制对齐的派生坐标必须携带置信度（DB CHECK 兜底）。
    confidence: proposed.confidence ?? null,
    verifiedBy: carried?.verifiedBy ?? null,
    verifiedAt: carried?.verifiedAt ?? null,
    verifiedAgainst:
      carried === null ? Prisma.DbNull : jsonValue(carried.verifiedAgainst),
  };
  if (existing) {
    await tx.pcAlignment.update({
      where: { alignmentId: existing.alignmentId },
      data,
    });
    return true;
  }
  // DB 触发器（C3）：provenance≠human 的行创建时必须是 proposed。
  // 携带进来的 verified 审计元组在创建后立即写回（更新不受创建触发器限制）。
  const created = await tx.pcAlignment.create({
    data: {
      alignmentId: randomUUID(),
      ...data,
      status: 'proposed',
      verifiedBy: null,
      verifiedAt: null,
      verifiedAgainst: Prisma.DbNull,
    },
    select: { alignmentId: true },
  });
  if (desiredStatus === 'verified') {
    await tx.pcAlignment.update({
      where: { alignmentId: created.alignmentId },
      data: {
        status: 'verified',
        verifiedBy: data.verifiedBy,
        verifiedAt: data.verifiedAt,
        verifiedAgainst: data.verifiedAgainst,
      },
    });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Part C 包 → 本环境 legacy 工作区快照（Admin 预览/发布/导出共用）
// ---------------------------------------------------------------------------

interface CourseInfoCollector {
  title?: string;
  shortDescription?: string;
  overview?: string;
  whatYouLearn: string[];
  provides: string[];
}

function courseInfoByLanguage(
  rows: ValidatedRows,
): Map<string, CourseInfoCollector> {
  const byLanguage = new Map<string, CourseInfoCollector>();
  for (const row of rows.courseInfo) {
    const value = row.value;
    const entry = byLanguage.get(value.language) ?? {
      whatYouLearn: [],
      provides: [],
    };
    switch (value.field) {
      case 'title':
        entry.title ??= value.text;
        break;
      case 'shortDescription':
        entry.shortDescription ??= value.text;
        break;
      case 'overview':
        entry.overview ??= value.text;
        break;
      case 'whatYouLearn':
        entry.whatYouLearn.push(value.text);
        break;
      case 'provides':
        entry.provides.push(value.text);
        break;
    }
    byLanguage.set(value.language, entry);
  }
  return byLanguage;
}

export interface PartcSnapshotOptions {
  readonly courseId: string;
  readonly slug: string;
  /** 媒体资源路径 → 本环境 CourseMediaAsset id。 */
  readonly mediaAssetIdByPath: ReadonlyMap<string, string>;
  readonly mediaExtensionByPath: ReadonlyMap<string, string>;
}

const EXHIBIT_TYPE_BY_MEDIA: Readonly<
  Record<string, 'IMAGE' | 'VIDEO' | 'MODEL3D' | null>
> = {
  image: 'IMAGE',
  video: 'VIDEO',
  model3d: 'MODEL3D',
  audio: null,
  text: null,
};

/**
 * 把 Part C 编译产物映射为 v3 版本快照形态（legacy 工作区）。
 *
 * 这是「Part C 内容模型 → 既有 Admin 工作区/预览投影」的机械投影：只按稳定
 * code 关联，不做任何内容改写；Part C 语义（阶段树/对齐/毫秒区间）仍以 pc_*
 * 为真源，快照只承载 v3 的展示/发布面。provenance/annotations 原样携带
 * （C10.3/C10.4：审计数据不参与身份）。
 */
export function buildPartcVersionSnapshot(
  compiled: PartcCompiledPackage,
  options: PartcSnapshotOptions,
): VersionSnapshot {
  const { ir, rows, timing } = compiled;
  const course = ir.manifest.course;
  const courseKey = course.courseKey;
  const infoByLanguage = courseInfoByLanguage(rows);
  const defaultLanguage = course.learningLanguages[0];
  const learningMode =
    course.studyMode === 'video'
      ? 'VIDEO_ONLY'
      : course.studyMode === 'text'
        ? 'TEXT_ONLY'
        : 'VIDEO_AND_TEXT';

  const durationByAssetKey = new Map(
    timing.assets.map((asset) => [asset.assetKey, asset.durationMs]),
  );

  const lessonCodes = [
    ...new Set(rows.lessons.map((row) => row.value.lesson_code)),
  ];
  const lessonOrder = new Map(
    rows.lessons.map((row) => [row.value.lesson_code, row.value.order]),
  );
  lessonCodes.sort(
    (left, right) =>
      (lessonOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (lessonOrder.get(right) ?? Number.MAX_SAFE_INTEGER) ||
      (left < right ? -1 : left > right ? 1 : 0),
  );

  // buildPartcVersionSnapshot 的正文由 align 的 body 块提供（语言中立结构块）。
  const bodyHtml = compiled.align.blocks.find(
    (block) => block.blockId === 'body',
  )?.payload;
  const bodyHtmlText =
    bodyHtml !== undefined && bodyHtml.kind === 'text' ? bodyHtml.html : null;

  const lessons: SnapshotLesson[] = lessonCodes.map((lessonCode, index) => {
    const lessonRows = rows.lessons.filter(
      (row) => row.value.lesson_code === lessonCode,
    );
    const languages = [
      ...new Set(lessonRows.map((row) => row.value.language)),
    ].sort(
      (left, right) =>
        course.learningLanguages.indexOf(left) -
        course.learningLanguages.indexOf(right),
    );
    const lps = rows.learningPoints.filter(
      (row) => row.value.lesson_code === lessonCode,
    );
    const coordinates = timing.coordinates.filter(
      (coordinate) => coordinate.lessonCode === lessonCode,
    );
    const localizations = languages.map((language) => {
      const row = lessonRows.find((entry) => entry.value.language === language);
      const videoRow = rows.media.find(
        (entry) =>
          entry.value.kind === 'video' &&
          entry.value.lesson_code === lessonCode &&
          entry.value.language === language,
      );
      const documentRow = rows.media.find(
        (entry) =>
          entry.value.kind === 'lesson-text' &&
          entry.value.lesson_code === lessonCode &&
          entry.value.language === language,
      );
      const durationMs = videoRow
        ? durationByAssetKey.get(videoRow.value.asset_key)
        : null;
      return {
        language,
        title: row?.value.title ?? lessonCode,
        description: row?.value.description ?? null,
        videoAssetId: videoRow
          ? (options.mediaAssetIdByPath.get(videoRow.value.relative_path) ??
            null)
          : null,
        videoDurationSeconds:
          durationMs !== null && durationMs !== undefined
            ? Math.round(durationMs / 1000)
            : null,
        // 正文块是语言中立结构块（align 语义）：所有语言共享同一 html。
        textHtml: documentRow !== undefined ? bodyHtmlText : null,
        textLearningPoints: [],
      };
    });

    const exhibits = collectExhibits(lessonCode, rows, options);
    const exhibitCodeByAsset = new Map<string, string>();
    for (const exhibit of exhibits) {
      if (exhibit.mediaAssetId) {
        exhibitCodeByAsset.set(exhibit.code, exhibit.code);
      }
    }
    const learningPoints = lps.map((row, lpIndex) => {
      const videoCoordinate = coordinates.find(
        (coordinate) =>
          coordinate.kind === 'lp' &&
          coordinate.code === row.value.lp_code &&
          coordinate.language === row.value.language &&
          coordinate.carrierType === 'asset',
      );
      const documentCoordinate = coordinates.find(
        (coordinate) =>
          coordinate.kind === 'lp' &&
          coordinate.code === row.value.lp_code &&
          coordinate.language === row.value.language &&
          coordinate.carrierType === 'document',
      );
      const videoRow = rows.media.find(
        (entry) =>
          entry.value.kind === 'video' &&
          entry.value.lesson_code === lessonCode &&
          entry.value.language === row.value.language,
      );
      const hasVideo = videoRow !== undefined;
      return {
        language: row.value.language,
        code: row.value.lp_code,
        title: row.value.title,
        source: hasVideo ? 'VIDEO' : 'TEXT',
        timeSeconds:
          videoCoordinate?.startMs !== undefined
            ? Math.round(videoCoordinate.startMs / 1000)
            : null,
        anchorHeading:
          documentCoordinate?.headingCode ?? row.value.title ?? null,
        sortOrder: lpIndex,
      };
    });
    const triggers = coordinates
      .filter(
        (coordinate) =>
          coordinate.kind === 'trigger' && coordinate.carrierType === 'asset',
      )
      .map((coordinate) => ({
        exhibitCode: coordinate.code,
        language: coordinate.language,
        timeSeconds:
          coordinate.startMs !== undefined
            ? Math.round(coordinate.startMs / 1000)
            : 0,
      }));

    const readings = rows.readings
      .filter((row) => row.value.lesson_code === lessonCode)
      .map((row, readingIndex) => ({
        language: defaultLanguage,
        type: row.value.type.toUpperCase(),
        title: row.value.title,
        author: row.value.author ?? null,
        whyRecommended: row.value.why ?? null,
        sortOrder: readingIndex,
      }));

    const questionsByOrder = new Map<
      number,
      {
        code: string;
        question: string;
        referenceAnswer: string | null;
        sortOrder: number;
        enabled: boolean;
      }
    >();
    for (const row of rows.knowledgeTests.filter(
      (entry) => entry.value.lesson_code === lessonCode,
    )) {
      if (questionsByOrder.has(row.value.order)) continue;
      if (row.value.language !== defaultLanguage && questionsByOrder.size > 0) {
        // legacy 测评行不含语言维度：保留默认语言行，非默认语言文本仍完整
        // 保存在 Part C ContentSpec（pc_block）里。
        continue;
      }
      questionsByOrder.set(row.value.order, {
        code: `q${row.value.order}`,
        question: row.value.question,
        referenceAnswer: row.value.reference_answer,
        sortOrder: row.value.order,
        enabled: true,
      });
    }
    const applicationRow =
      rows.applicationTests.find(
        (entry) =>
          entry.value.lesson_code === lessonCode &&
          entry.value.language === defaultLanguage,
      ) ??
      rows.applicationTests.find(
        (entry) => entry.value.lesson_code === lessonCode,
      );

    return {
      id: randomUUID(),
      code: lessonCode,
      sortOrder: index + 1,
      localizations,
      exhibits,
      learningPoints,
      // 演练真值键 (lesson, exhibit, language, timeMs)：同一展品在同一语言的
      // 多个时间点是内容事实（T3-3），只有完全相同的真值键才是重复（T3-5 在
      // 派生层已拒绝）。这里只去掉逐字重复，绝不按 (exhibit, language) 折叠。
      triggers: triggers.filter(
        (trigger, triggerIndex) =>
          triggers.findIndex(
            (other) =>
              other.exhibitCode === trigger.exhibitCode &&
              other.language === trigger.language &&
              other.timeSeconds === trigger.timeSeconds,
          ) === triggerIndex,
      ),
      readings,
      questions: [...questionsByOrder.values()],
      applicationTest: applicationRow
        ? {
            scenario: applicationRow.value.question,
            referenceAnswer: applicationRow.value.reference_answer,
            enabled: true,
          }
        : null,
    };
  });

  const localizations = course.learningLanguages.map((language) => {
    const info = infoByLanguage.get(language);
    const titleLocalized = course.titleLocalized[language] as
      Record<string, string> | undefined;
    return {
      language,
      title: info?.title ?? titleLocalized?.title ?? courseKey,
      shortDescription: info?.shortDescription ?? null,
      overview: info?.overview ?? null,
      whatYouLearn: info?.whatYouLearn ?? [],
      provides: info?.provides ?? [],
    };
  });

  const coverRow = rows.media.find((row) => row.value.kind === 'cover');
  return {
    formatVersion: 3,
    capturedAt: new Date().toISOString(),
    course: {
      code: courseKey,
      slug: options.slug,
      categoryPath: course.categoryPath,
      coverAssetId: coverRow
        ? (options.mediaAssetIdByPath.get(coverRow.value.relative_path) ?? null)
        : null,
      learningMode,
      defaultContentLanguage: defaultLanguage,
      learningLanguages: [...course.learningLanguages],
      localizations,
      lessons,
    },
    ...(ir.provenance
      ? {
          provenance: ir.provenance,
        }
      : {}),
    ...(ir.annotations ? { annotations: ir.annotations } : {}),
  };
}

function collectExhibits(
  lessonCode: string,
  rows: ValidatedRows,
  options: PartcSnapshotOptions,
): SnapshotLesson['exhibits'] {
  const exhibitRows = rows.exhibits.filter(
    (row) => row.value.lesson_code === lessonCode,
  );
  const codes = [...new Set(exhibitRows.map((row) => row.value.exhibit_code))];
  const out: SnapshotLesson['exhibits'] = [];
  for (const code of codes) {
    const variants = exhibitRows.filter(
      (row) => row.value.exhibit_code === code,
    );
    const first = variants[0];
    const type = EXHIBIT_TYPE_BY_MEDIA[first.value.media_type];
    if (type === null || type === undefined) continue; // legacy 枚举无 TEXT/AUDIO
    const assetRow = first.value.asset_key
      ? rows.media.find((row) => row.value.asset_key === first.value.asset_key)
      : undefined;
    const thumbnail = rows.media.find(
      (row) =>
        row.value.kind === 'thumbnail' &&
        row.value.thumbnail_of === first.value.asset_key,
    );
    const localized: Record<string, { title: string; description?: string }> =
      {};
    for (const variant of variants) {
      localized[variant.value.language] = {
        title: variant.value.title,
        ...(variant.value.description === null
          ? {}
          : { description: variant.value.description }),
      };
    }
    out.push({
      code,
      type,
      mediaAssetId: assetRow
        ? (options.mediaAssetIdByPath.get(assetRow.value.relative_path) ?? null)
        : null,
      thumbnailAssetId: thumbnail
        ? (options.mediaAssetIdByPath.get(thumbnail.value.relative_path) ??
          null)
        : null,
      sourceText: first.value.source ?? null,
      localized,
    });
  }
  return out;
}
