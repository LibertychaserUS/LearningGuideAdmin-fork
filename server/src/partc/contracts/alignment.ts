import { z } from 'zod';
import { StageKeySchema } from './brands';
import {
  AuditParamsSchema,
  isoUtcSchema,
  nonEmptyTextSchema,
  positiveIntSchema,
  stableTokenSchema,
} from './primitives';

/**
 * Alignment（设计 §14 C3/C4/C8/C10.4）。
 *
 * stage × rendition × objective 的三元跨度，带 role/status/provenance。
 * - UNIQUE(stageKey, renditionKey)：DB 唯一索引兜底，编译器按此检查。
 * - 存储状态只有 proposed / verified / rejected；stale 是读时派生（ALN-6），
 *   绝不落库，因此出现 status='stale' 即契约违规。
 * - provenance ≠ human ⇒ 创建时只能是 proposed（跨状态规则在写入路径执行）。
 * - verified 必须有人签收：verifiedBy/verifiedAt/verifiedAgainst 三者齐全；
 *   非 verified 记录不得携带审计元组。
 * - 派生审计元组（C7/C10.4）：sourceKind/sourceArtifact/ruleVersion 三者齐全或
 *   全空；ASR 与强制对齐必须 pin modelVersion 与 params；其余来源不得携带
 *   modelVersion/params。审计数据不参与身份、幂等与 staleness，只用于复核与
 *   争议追溯。
 * - doc-structure 是文本锚点（DOCX Heading）的派生来源；它只可能是 document
 *   载体，与 Rendition.anchorSource 同词表（C7 审计字段）。
 */

export const ALIGNMENT_ROLES = [
  'primary',
  'support',
  'assessment',
  'auxiliary',
] as const;
export type AlignmentRole = (typeof ALIGNMENT_ROLES)[number];

export const ALIGNMENT_STORED_STATUSES = [
  'proposed',
  'verified',
  'rejected',
] as const;
export type AlignmentStoredStatus = (typeof ALIGNMENT_STORED_STATUSES)[number];

export const ALIGNMENT_PROVENANCES = [
  'human',
  'import',
  'legacy',
  'semantic',
] as const;
export type AlignmentProvenance = (typeof ALIGNMENT_PROVENANCES)[number];

/** 派生来源词表（C3 sourceKind / C7；与 Rendition.anchorSource 同源）。 */
export const ALIGNMENT_SOURCE_KINDS = [
  'subtitle',
  'chapter',
  'asr',
  'forced-alignment',
  'doc-structure',
] as const;
export type AlignmentSourceKind = (typeof ALIGNMENT_SOURCE_KINDS)[number];

/** 必须 pin 模型版本与参数的来源（C7/C10.6：ASR 逐条可追溯）。 */
export const MODEL_PINNED_SOURCE_KINDS = ['asr', 'forced-alignment'] as const;

/** 粘合审计元组：与当前 pin 集逐一比对，不匹配即读时派生 stale。 */
export const VerifiedAgainstSchema = z.strictObject({
  renditionRevision: positiveIntSchema,
  carrierVersion: positiveIntSchema,
  specVersion: positiveIntSchema,
});

export type VerifiedAgainst = z.infer<typeof VerifiedAgainstSchema>;

export const AlignmentSchema = z
  .strictObject({
    alignmentId: stableTokenSchema,
    stageKey: StageKeySchema,
    renditionKey: stableTokenSchema,
    objectiveKey: stableTokenSchema,
    role: z.enum(ALIGNMENT_ROLES),
    status: z.enum(ALIGNMENT_STORED_STATUSES),
    provenance: z.enum(ALIGNMENT_PROVENANCES),
    /** C7/C10.4 派生审计：来源种类（字幕/章节/ASR/强制对齐/文档结构）。 */
    sourceKind: z.enum(ALIGNMENT_SOURCE_KINDS).optional(),
    /** 字幕/章节=包内路径；ASR/强制对齐=内部工件 id；doc-structure=document assetKey。 */
    sourceArtifact: nonEmptyTextSchema.optional(),
    /** ASR/强制对齐模型版本；其余来源必须为空。 */
    modelVersion: nonEmptyTextSchema.optional(),
    /** ASR/强制对齐派生参数；其余来源必须为空。 */
    params: AuditParamsSchema.optional(),
    /** 派生规则版本（C7 以参数形式版本化）。 */
    ruleVersion: nonEmptyTextSchema.optional(),
    /**
     * 派生置信度 0..1。ASR/强制对齐的派生必须在写入路径（align/导入）给出值，
     * DB CHECK 兜底；其余来源可省略。审计数据，不参与身份/staleness。
     */
    confidence: z.number().finite().min(0).max(1).optional(),
    verifiedBy: nonEmptyTextSchema.optional(),
    verifiedAt: isoUtcSchema.optional(),
    verifiedAgainst: VerifiedAgainstSchema.optional(),
  })
  .superRefine((alignment, ctx) => {
    const audit =
      alignment.verifiedBy !== undefined &&
      alignment.verifiedAt !== undefined &&
      alignment.verifiedAgainst !== undefined;
    if (alignment.status === 'verified' && !audit) {
      ctx.addIssue({
        code: 'custom',
        message:
          'verified alignment requires verifiedBy, verifiedAt and verifiedAgainst',
        path: ['status'],
      });
    }
    if (alignment.status !== 'verified') {
      if (
        alignment.verifiedBy !== undefined ||
        alignment.verifiedAt !== undefined ||
        alignment.verifiedAgainst !== undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'only verified alignments may carry the audit tuple',
          path: ['status'],
        });
      }
    }

    // 派生审计三元组：sourceKind/sourceArtifact/ruleVersion 全有或全无。
    const hasSourceKind = alignment.sourceKind !== undefined;
    const hasSourceArtifact = alignment.sourceArtifact !== undefined;
    const hasRuleVersion = alignment.ruleVersion !== undefined;
    if (
      hasSourceKind !== hasSourceArtifact ||
      hasSourceKind !== hasRuleVersion
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'sourceKind, sourceArtifact and ruleVersion must be provided together',
        path: ['sourceKind'],
      });
    }
    const modelPinned =
      alignment.sourceKind !== undefined &&
      (MODEL_PINNED_SOURCE_KINDS as readonly string[]).includes(
        alignment.sourceKind,
      );
    if (modelPinned) {
      if (alignment.modelVersion === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `${alignment.sourceKind} provenance requires modelVersion`,
          path: ['modelVersion'],
        });
      }
      if (alignment.params === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `${alignment.sourceKind} provenance requires params`,
          path: ['params'],
        });
      }
    } else if (
      alignment.modelVersion !== undefined ||
      alignment.params !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'modelVersion/params are only allowed for asr/forced-alignment provenance',
        path: ['modelVersion'],
      });
    }
  });

export type Alignment = z.infer<typeof AlignmentSchema>;

/** 冻结快照 / 发布门只接受 verified 对齐（ALN-2）。 */
export const VerifiedAlignmentSchema = AlignmentSchema.refine(
  (alignment) => alignment.status === 'verified',
  'only verified alignments may enter a frozen content version',
);

export type VerifiedAlignment = z.infer<typeof VerifiedAlignmentSchema>;
