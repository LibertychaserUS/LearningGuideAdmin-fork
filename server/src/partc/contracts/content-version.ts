import { z } from 'zod';
import { CourseKeySchema } from './brands';
import { VerifiedAlignmentSchema } from './alignment';
import { SourceEnvSchema } from './environment';
import { EvidenceSpecSchema } from './evidence-spec';
import { AssetPinSchema, SpecPinSchema } from './pins';
import { PLAN_ID_PATTERN } from './plan-id';
import { PrerequisiteEdgeSchema } from './prerequisite-edge';
import { RenditionSchema, renditionBusinessKey } from './rendition';
import { StageSchema } from './stage';
import {
  CategoryPathSchema,
  isoUtcSchema,
  nonEmptyTextSchema,
  positiveIntSchema,
  stableTokenSchema,
} from './primitives';

/**
 * ContentVersion（设计 §14 C3/C4/C1）。
 *
 * 把树、spec pins、rendition、仅 verified 的对齐（含审计元组）、证据规格、
 * 资产 pins、分类路径、已批准的 planPin 一次冻结；发布后不可变。
 * 冻结时对齐全部 verified 且非 stale（stale 读时派生，见 ALN-6）。
 *
 * 这里的 ContentVersionContentSchema 只含稳定键与冻结内容，可在环境间搬运
 * （课程包 v2 与快照 v3 共用，见 B2.7/B8）；ContentVersionSchema 额外携带
 * 本环境存储编号 contentVersionId、审计时间 frozenAt 与本地 planPin。
 */

export const PlanPinSchema = z.strictObject({
  planId: z.string().regex(PLAN_ID_PATTERN, 'malformed planId'),
  planVersion: positiveIntSchema,
});

export type PlanPin = z.infer<typeof PlanPinSchema>;

/** 冻结内容主体（无环境 UUID、无 Plan 状态、无任何摘要）。 */
export const ContentVersionContentSchema = z
  .strictObject({
    courseKey: CourseKeySchema,
    versionNo: positiveIntSchema,
    categoryPath: CategoryPathSchema,
    stages: z.array(StageSchema).min(1),
    prerequisiteEdges: z.array(PrerequisiteEdgeSchema),
    specPins: z.array(SpecPinSchema),
    renditions: z.array(RenditionSchema),
    alignments: z.array(VerifiedAlignmentSchema),
    evidenceSpecs: z.array(EvidenceSpecSchema),
    assetPins: z.array(AssetPinSchema),
  })
  .superRefine((content, ctx) => {
    const stageByKey = new Map(
      content.stages.map((stage) => [stage.stageKey, stage]),
    );
    if (stageByKey.size !== content.stages.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'duplicate stageKey in content version',
        path: ['stages'],
      });
    }
    const orderKeys = new Set<string>();
    for (const stage of content.stages) {
      if (orderKeys.has(stage.orderKey)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate orderKey ${stage.orderKey}`,
          path: ['stages', stage.stageKey],
        });
      }
      orderKeys.add(stage.orderKey);
      if (
        stage.parentStageKey !== null &&
        !stageByKey.has(stage.parentStageKey)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `parentStageKey ${stage.parentStageKey} does not exist`,
          path: ['stages', stage.stageKey, 'parentStageKey'],
        });
      }
      for (const evidenceKey of stage.exitEvidence) {
        if (
          !content.evidenceSpecs.some(
            (spec) => spec.evidenceKey === evidenceKey,
          )
        ) {
          ctx.addIssue({
            code: 'custom',
            message: `exitEvidence ${evidenceKey} has no matching evidence spec`,
            path: ['stages', stage.stageKey, 'exitEvidence'],
          });
        }
      }
    }
    const edgeKeys = new Set<string>();
    for (const edge of content.prerequisiteEdges) {
      if (
        !stageByKey.has(edge.fromStageKey) ||
        !stageByKey.has(edge.toStageKey)
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'prerequisite edge endpoints must exist in this content version',
          path: ['prerequisiteEdges'],
        });
      }
      const edgeKey = `${edge.fromStageKey}\u0000${edge.toStageKey}\u0000${edge.kind}`;
      if (edgeKeys.has(edgeKey)) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicate prerequisite edge',
          path: ['prerequisiteEdges'],
        });
      }
      edgeKeys.add(edgeKey);
    }
    const specByKey = new Map(
      content.specPins.map((pin) => [pin.contentKey, pin.version]),
    );
    if (specByKey.size !== content.specPins.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'duplicate contentKey in spec pins',
        path: ['specPins'],
      });
    }
    const assetPinKeys = new Set(
      content.assetPins.map((pin) => `${pin.assetKey}@${pin.assetVersion}`),
    );
    if (assetPinKeys.size !== content.assetPins.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'duplicate asset pin',
        path: ['assetPins'],
      });
    }
    const renditionByKey = new Map(
      content.renditions.map((rendition) => [
        rendition.renditionKey,
        rendition,
      ]),
    );
    if (renditionByKey.size !== content.renditions.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'duplicate renditionKey',
        path: ['renditions'],
      });
    }
    const businessKeys = new Set<string>();
    for (const rendition of content.renditions) {
      const businessKey = renditionBusinessKey(rendition);
      if (businessKeys.has(businessKey)) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicate rendition business key',
          path: ['renditions', rendition.renditionKey],
        });
      }
      businessKeys.add(businessKey);
      if (!specByKey.has(rendition.contentKey)) {
        ctx.addIssue({
          code: 'custom',
          message: `rendition ${rendition.renditionKey} references unpinned contentKey`,
          path: ['renditions', rendition.renditionKey, 'contentKey'],
        });
      }
      if (
        rendition.carrierType === 'asset' &&
        !assetPinKeys.has(`${rendition.carrierKey}@${rendition.carrierVersion}`)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `rendition ${rendition.renditionKey} references an unpinned asset`,
          path: ['renditions', rendition.renditionKey, 'carrierKey'],
        });
      }
    }
    const evidenceKeys = new Set<string>();
    for (const spec of content.evidenceSpecs) {
      if (evidenceKeys.has(spec.evidenceKey)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate evidenceKey ${spec.evidenceKey}`,
          path: ['evidenceSpecs', spec.evidenceKey],
        });
      }
      evidenceKeys.add(spec.evidenceKey);
      if (
        spec.measure.kind === 'assessment' &&
        !specByKey.has(spec.measure.contentKey)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `evidence ${spec.evidenceKey} measures unpinned content`,
          path: ['evidenceSpecs', spec.evidenceKey, 'measure', 'contentKey'],
        });
      }
    }
    const alignmentPairs = new Set<string>();
    for (const alignment of content.alignments) {
      const stage = stageByKey.get(alignment.stageKey);
      if (!stage) {
        ctx.addIssue({
          code: 'custom',
          message: `alignment ${alignment.alignmentId} references an unknown stage`,
          path: ['alignments', alignment.alignmentId, 'stageKey'],
        });
      } else if (!stage.objectiveKeys.includes(alignment.objectiveKey)) {
        ctx.addIssue({
          code: 'custom',
          message: `alignment ${alignment.alignmentId} objective must belong to its stage`,
          path: ['alignments', alignment.alignmentId, 'objectiveKey'],
        });
      }
      const rendition = renditionByKey.get(alignment.renditionKey);
      if (!rendition) {
        ctx.addIssue({
          code: 'custom',
          message: `alignment ${alignment.alignmentId} references an unknown rendition`,
          path: ['alignments', alignment.alignmentId, 'renditionKey'],
        });
      } else if (alignment.verifiedAgainst) {
        // ALN-3：verifiedAgainst 必须与冻结 pin 集一致，否则冻结时即为 stale。
        if (
          alignment.verifiedAgainst.renditionRevision !== rendition.revision
        ) {
          ctx.addIssue({
            code: 'custom',
            message:
              'verifiedAgainst.renditionRevision must match the frozen rendition',
            path: ['alignments', alignment.alignmentId, 'verifiedAgainst'],
          });
        }
        if (
          alignment.verifiedAgainst.carrierVersion !== rendition.carrierVersion
        ) {
          ctx.addIssue({
            code: 'custom',
            message:
              'verifiedAgainst.carrierVersion must match the frozen rendition',
            path: ['alignments', alignment.alignmentId, 'verifiedAgainst'],
          });
        }
        const pinnedVersion = specByKey.get(rendition.contentKey);
        if (
          pinnedVersion !== undefined &&
          alignment.verifiedAgainst.specVersion !== pinnedVersion
        ) {
          ctx.addIssue({
            code: 'custom',
            message:
              'verifiedAgainst.specVersion must match the frozen spec pin',
            path: ['alignments', alignment.alignmentId, 'verifiedAgainst'],
          });
        }
      }
      const pair = `${alignment.stageKey}\u0000${alignment.renditionKey}`;
      if (alignmentPairs.has(pair)) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicate (stageKey, renditionKey) alignment',
          path: ['alignments', alignment.alignmentId],
        });
      }
      alignmentPairs.add(pair);
    }
  });

export type ContentVersionContent = z.infer<typeof ContentVersionContentSchema>;

export const ContentVersionSchema = ContentVersionContentSchema.extend({
  contentVersionId: stableTokenSchema,
  frozenAt: isoUtcSchema,
  planPin: PlanPinSchema,
  /**
   * C10.3 环境局部标签：来源环境与来源版本标签（如 `Sandbox 4.2` /
   * `Version 7`）。它们随行/快照记录但**不参与内容身份**，也不进入课程包的
   * 跨环境内容（跨环境以 provenance 区块携带）。薄壳在冻结时写入。
   */
  sourceEnv: SourceEnvSchema.optional(),
  sourceLabel: nonEmptyTextSchema.optional(),
});

export type ContentVersion = z.infer<typeof ContentVersionSchema>;
