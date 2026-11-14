import { z } from 'zod';
import { CourseKeySchema } from './brands';
import { ContentVersionContentSchema, PlanPinSchema } from './content-version';
import { SourceEnvSchema } from './environment';
import { MEDIA_ASSET_KINDS } from './media-asset';
import {
  AuditParamsSchema,
  CategoryPathSchema,
  LocalizedTemplateSchema,
  StudyModeSchema,
  isoUtcSchema,
  localeKeySchema,
  nonEmptyTextSchema,
  packageRelativePathSchema,
  positiveIntSchema,
  stableTokenSchema,
} from './primitives';
import { PACKAGE_FORMAT_TAG, PACKAGE_FORMAT_VERSION } from '../version-matrix';
import { PartCError } from '../errors';

/**
 * 课程包 v2 契约（设计 §14 C0/C5 P0、C10.4/C10.6、B8、C9 prior-art）。
 *
 * 本文件是课程包 formatVersion=2 的唯一契约 SSOT：manifest 形状、provenance
 * 与 annotations 只在这里声明；其他模块（含 commerce-courses 的导入/导出
 * 适配层）必须从本 schema 派生，不得另立第二套 v2 形状。
 *
 * - 闭合包：manifest.json 是唯一入口；resources 与包内文件一一对应
 *   （声明缺失 → PACKAGE_FILE_MISSING；未声明文件 → PACKAGE_FILE_UNKNOWN）。
 * - 稳定键：只带 courseKey/categoryPath/assetKey+assetVersion 等稳定身份，
 *   不带任何环境 UUID，也不带任何内容摘要（包身份 =
 *   (formatVersion, courseKey, versionNo)）。
 * - 旧包（formatVersion ≠ 2、含 course.category、缺 categoryPath）整体拒绝：
 *   PACKAGE_FORMAT_UNSUPPORTED，不做兼容解析。
 * - provenance（C10.6）：sourceEnv/sourceVersionLabel/exportedAt/exportedBy/
 *   courseKey/planPin/approvalRef/auditSummaryRef/asr pin；exportedAt 与审计
 *   信息不参与身份、幂等与 staleness。
 * - annotations（C10.4）：审计报告与导出元数据随包携带，不参与身份。
 * - 资源完整性靠 ZIP CRC32 + 大小/类型校验；本契约只声明 size 与 kind。
 */

export const PACKAGE_RESOURCE_KINDS = [
  'template',
  'document',
  ...MEDIA_ASSET_KINDS,
] as const;
export type PackageResourceKind = (typeof PACKAGE_RESOURCE_KINDS)[number];

export const PackageResourceSchema = z.strictObject({
  /** 资源稳定 id：媒体 = assetKey；文档/模板 = 稳定文档 id。 */
  id: stableTokenSchema,
  kind: z.enum(PACKAGE_RESOURCE_KINDS),
  path: packageRelativePathSchema,
  /** 字节数；由 ZIP 条目大小校验，不引入摘要。 */
  size: z.number().int().nonnegative(),
});

export type PackageResource = z.infer<typeof PackageResourceSchema>;

export const PackageCourseV2Schema = z.strictObject({
  courseKey: CourseKeySchema,
  titleLocalized: LocalizedTemplateSchema,
  /** Part A C5：必填字段；null = 未分类；不再有 course.category。 */
  categoryPath: CategoryPathSchema,
  learningLanguages: z.array(localeKeySchema).min(1),
  studyMode: StudyModeSchema,
});

export type PackageCourseV2 = z.infer<typeof PackageCourseV2Schema>;

/**
 * 包 provenance（设计 §14 C10.6，v2 manifest 的唯一 SSOT）。
 *
 * - 导出方 MUST 写入完整 provenance；解析方按本 schema 严格校验字段。
 * - 不参与包身份、幂等与 staleness 判定；只用于来源判定与争议追溯。
 * - 来源判定只看 `sourceEnv`（服务端解析出的字段），绝不依据文件名/路径。
 * - `asr` 是该包时间派生所用 ASR 的模型/参数/规则 pin（C7）；无 ASR 派生时缺省。
 * - 解析时 provenance 缺省可被接受，仅为保持 PACKAGE_SOURCE_ENFORCEMENT 休眠
 *   （off）时的既有行为；来源强制 on 时，生产环境缺 provenance 即
 *   PACKAGE_SOURCE_NOT_ALLOWED（C10.6）。
 */
export const PackageProvenanceAsrPinsSchema = z.strictObject({
  modelVersion: nonEmptyTextSchema,
  params: AuditParamsSchema,
  ruleVersion: nonEmptyTextSchema,
});

export type PackageProvenanceAsrPins = z.infer<
  typeof PackageProvenanceAsrPinsSchema
>;

export const PackageProvenanceSchema = z.strictObject({
  sourceEnv: SourceEnvSchema,
  /** 导出环境的版本标签（Sandbox `X.Y` 或 Production `Version N`）。 */
  sourceVersionLabel: nonEmptyTextSchema,
  exportedAt: isoUtcSchema,
  exportedBy: nonEmptyTextSchema,
  courseKey: CourseKeySchema,
  /** 指向已签收的 Plan 与审批记录，供追溯（C10.6）。 */
  planPin: PlanPinSchema,
  approvalRef: nonEmptyTextSchema,
  auditSummaryRef: nonEmptyTextSchema,
  asr: PackageProvenanceAsrPinsSchema.optional(),
});

export type PackageProvenance = z.infer<typeof PackageProvenanceSchema>;

/**
 * 包 annotations（C10.4）：审计报告与导出元数据随包携带。
 * 只要求是 JSON 对象；内容原样保留，不参与身份、幂等与 staleness。
 */
export const PackageAnnotationsSchema = z.record(z.string(), z.unknown());

export type PackageAnnotations = z.infer<typeof PackageAnnotationsSchema>;

export const PackageManifestV2Schema = z
  .strictObject({
    format: z.literal(PACKAGE_FORMAT_TAG),
    formatVersion: z.literal(PACKAGE_FORMAT_VERSION),
    packageId: stableTokenSchema.optional(),
    /** 导出元数据；不参与内容身份（B8 确定性）。 */
    exportedAt: isoUtcSchema.optional(),
    /** glTF 式能力声明：读取器版本必须 ≥ 本包的 minReaderVersion。 */
    minReaderVersion: positiveIntSchema,
    extensionsUsed: z.array(stableTokenSchema).default([]),
    extensionsRequired: z.array(stableTokenSchema).default([]),
    course: PackageCourseV2Schema,
    content: ContentVersionContentSchema,
    resources: z.array(PackageResourceSchema).min(1),
    /** C10.6 来源与追溯块（唯一 SSOT 见 PackageProvenanceSchema）。 */
    provenance: PackageProvenanceSchema.optional(),
    /** C10.4 审计/导出元数据（不参与身份）。 */
    annotations: PackageAnnotationsSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.course.courseKey !== manifest.content.courseKey) {
      ctx.addIssue({
        code: 'custom',
        message: 'course.courseKey must equal content.courseKey',
        path: ['course', 'courseKey'],
      });
    }
    if (
      JSON.stringify(manifest.course.categoryPath) !==
      JSON.stringify(manifest.content.categoryPath)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'course.categoryPath must equal content.categoryPath',
        path: ['course', 'categoryPath'],
      });
    }
    if (
      manifest.provenance !== undefined &&
      manifest.provenance.courseKey !== manifest.course.courseKey
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'provenance.courseKey must equal course.courseKey',
        path: ['provenance', 'courseKey'],
      });
    }
    const seenPaths = new Set<string>();
    for (const resource of manifest.resources) {
      if (seenPaths.has(resource.path)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate resource path ${resource.path}`,
          path: ['resources'],
        });
      }
      seenPaths.add(resource.path);
    }
  });

export type PackageManifestV2 = z.infer<typeof PackageManifestV2Schema>;

/** v1 扩展词表为空：任何 extensionsRequired 都必须整体拒绝。 */
export const PART_C_PACKAGE_EXTENSIONS: readonly string[] = [];

/**
 * 解析 v2 manifest。任何结构不合法（含旧包）统一映射为
 * PACKAGE_FORMAT_UNSUPPORTED（C5 P1）。错误详情带 Zod issue 摘要，便于报告。
 */
export function parsePackageManifestV2(input: unknown): PackageManifestV2 {
  const parsed = PackageManifestV2Schema.safeParse(input);
  if (!parsed.success) {
    throw new PartCError(
      'PACKAGE_FORMAT_UNSUPPORTED',
      'course package does not satisfy the v2 contract',
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return parsed.data;
}

/**
 * 读取器能力校验：minReaderVersion 高于当前读取器、或声明了未知 required
 * 扩展 → 整包拒绝（B8/C9：未知 required 一律拒绝整包）。
 */
export function assertPackageReaderCompatible(
  manifest: PackageManifestV2,
): void {
  if (manifest.minReaderVersion > PACKAGE_FORMAT_VERSION) {
    throw new PartCError(
      'PACKAGE_FORMAT_UNSUPPORTED',
      `package requires reader version ${manifest.minReaderVersion}, this reader supports ${PACKAGE_FORMAT_VERSION}`,
      { minReaderVersion: manifest.minReaderVersion },
    );
  }
  const unknownRequired = manifest.extensionsRequired.filter(
    (extension) => !PART_C_PACKAGE_EXTENSIONS.includes(extension),
  );
  if (unknownRequired.length > 0) {
    throw new PartCError(
      'PACKAGE_FORMAT_UNSUPPORTED',
      'package requires unsupported extensions',
      { unknownRequired },
    );
  }
}
