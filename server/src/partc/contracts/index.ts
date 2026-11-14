/**
 * Part C P0 契约冻结入口（设计 §14 C5 P0）。
 *
 * 同一 schema 源导出：15+1 个实体（C3 表格含 Course 共 16 行）、
 * 课程包 v2、模板 v2、快照 v3、Plan/PlanEntry/PlanApproval、LearningEvent 契约
 * 与 canonical JSON 工具。后续阶段（parser/compiler/API/Portal）只 import 本目录，
 * 不另写第二套 schema。
 */
import type { z } from 'zod';

export * from './brands';
export * from './primitives';
export * from './environment';
export * from './pins';
export * from './course';
export * from './stage';
export * from './prerequisite-edge';
export * from './objective';
export * from './evidence-spec';
export * from './block';
export * from './content-spec';
export * from './rendition';
export * from './media-asset';
export * from './alignment';
export * from './content-version';
export * from './publication';
export * from './snapshot';
export * from './plan-entry';
export * from './plan-id';
export * from './plan';
export * from './plan-approval';
export * from './learning-event';
export * from './evidence-attainment';
export * from './package-manifest';
export * from './template-v2';
export * from './canonical-json';

import { CourseSchema } from './course';
import { StageSchema } from './stage';
import { PrerequisiteEdgeSchema } from './prerequisite-edge';
import { ObjectiveSchema } from './objective';
import { EvidenceSpecSchema } from './evidence-spec';
import { ContentSpecSchema } from './content-spec';
import { BlockSchema } from './block';
import { RenditionSchema } from './rendition';
import { MediaAssetSchema } from './media-asset';
import { AlignmentSchema } from './alignment';
import { ContentVersionSchema } from './content-version';
import { PlanBodySchema, PlanRecordSchema } from './plan';
import { PlanEntrySchema } from './plan-entry';
import { PlanApprovalSchema } from './plan-approval';
import {
  LearningEventSchema,
  LearningEventInputSchema,
} from './learning-event';
import { EvidenceAttainmentSchema } from './evidence-attainment';
import { SnapshotV3Schema } from './snapshot';
import { PackageManifestV2Schema } from './package-manifest';

/** 实体 schema 注册表（C3，测试与后续阶段共用）。 */
export const PART_C_ENTITY_SCHEMAS = {
  Course: CourseSchema,
  Stage: StageSchema,
  PrerequisiteEdge: PrerequisiteEdgeSchema,
  Objective: ObjectiveSchema,
  EvidenceSpec: EvidenceSpecSchema,
  ContentSpec: ContentSpecSchema,
  Block: BlockSchema,
  Rendition: RenditionSchema,
  MediaAsset: MediaAssetSchema,
  Alignment: AlignmentSchema,
  ContentVersion: ContentVersionSchema,
  Plan: PlanBodySchema,
  PlanEntry: PlanEntrySchema,
  PlanApproval: PlanApprovalSchema,
  LearningEvent: LearningEventSchema,
  EvidenceAttainment: EvidenceAttainmentSchema,
} as const satisfies Record<string, z.ZodType>;

export type PartCEntityName = keyof typeof PART_C_ENTITY_SCHEMAS;

/** 工件/协议 schema 注册表（C5 P0 的 package-v2/template-v2/snapshot-v3/plan/event）。 */
export const PART_C_ARTIFACT_SCHEMAS = {
  PackageManifestV2: PackageManifestV2Schema,
  SnapshotV3: SnapshotV3Schema,
  PlanBody: PlanBodySchema,
  PlanRecord: PlanRecordSchema,
  PlanApproval: PlanApprovalSchema,
  LearningEventInput: LearningEventInputSchema,
  LearningEvent: LearningEventSchema,
} as const satisfies Record<string, z.ZodType>;
