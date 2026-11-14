import { z } from 'zod';
import { ContentKeySchema } from './brands';
import {
  nonEmptyTextSchema,
  positiveIntSchema,
  stableTokenSchema,
} from './primitives';

/**
 * EvidenceSpec（设计 §14 C3/C4/C8）。
 *
 * 三型封闭词表：assessment / artifact / performance。
 * completion、出勤、自报、观看完成率不得作为证据 —— 词表里根本没有这些取值，
 * 因此非法证据类型在 schema 边界即被拒绝（STR-4）。
 * measure 与 kind 必须同型：assessment 指向 assessment 型 ContentSpec 的 question blocks。
 */

export const EVIDENCE_KINDS = [
  'assessment',
  'artifact',
  'performance',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_SCORINGS = ['points', 'rubric', 'pass-fail'] as const;
export type EvidenceScoring = (typeof EVIDENCE_SCORINGS)[number];

const AssessmentMeasureSchema = z.strictObject({
  kind: z.literal('assessment'),
  contentKey: ContentKeySchema,
  blockIds: z.array(stableTokenSchema).min(1),
});

const ArtifactMeasureSchema = z.strictObject({
  kind: z.literal('artifact'),
  instructions: nonEmptyTextSchema,
});

const PerformanceMeasureSchema = z.strictObject({
  kind: z.literal('performance'),
  rubric: nonEmptyTextSchema,
});

export const EvidenceMeasureSchema = z.discriminatedUnion('kind', [
  AssessmentMeasureSchema,
  ArtifactMeasureSchema,
  PerformanceMeasureSchema,
]);

export type EvidenceMeasure = z.infer<typeof EvidenceMeasureSchema>;

export const EvidenceSpecSchema = z
  .strictObject({
    evidenceKey: stableTokenSchema,
    version: positiveIntSchema,
    kind: z.enum(EVIDENCE_KINDS),
    objectiveKeys: z.array(stableTokenSchema).min(1),
    measure: EvidenceMeasureSchema,
    scoring: z.enum(EVIDENCE_SCORINGS),
    threshold: z.number().nonnegative(),
    attempts: positiveIntSchema,
  })
  .refine(
    (spec) => spec.measure.kind === spec.kind,
    'measure kind must match evidence kind',
  );

export type EvidenceSpec = z.infer<typeof EvidenceSpecSchema>;
