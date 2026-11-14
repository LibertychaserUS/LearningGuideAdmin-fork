import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

import {
  AlignmentSchema,
  AssetPinSchema,
  AuditParamsSchema,
  CategoryPathSchema,
  ContentVersionSchema,
  EvidenceSpecSchema,
  PlanApprovalSchema,
  PlanBodySchema,
  PlanRecordSchema,
  PrerequisiteEdgeSchema,
  PublicationSchema,
  PublishTargetSchema,
  RenditionSchema,
  SpecPinSchema,
  STABLE_KEY_PATTERN,
  StageSchema,
  type Alignment,
  type ContentVersion,
  type EvidenceSpec,
  type PlanApproval,
  type PlanRecord,
  type PrerequisiteEdge,
  type Publication,
  type Rendition,
  type Stage,
} from '../contracts';
import type { InputClosure } from '../contracts';
import { PartCError } from '../errors';
import type {
  PlanApplyPort,
  PlanApplyTransaction,
  PlanLivePointer,
  PlanSourceSnapshot,
  StoredPlan,
} from '../compiler/apply';
import type {
  MediaAssetTimingInfo,
  PlanSource,
  PlanTimingSourceKind,
  RenditionTimingSourcePin,
} from '../compiler/invariants';
import { PrismaService } from '../../prisma/prisma.service';
import { findCategoryByPath } from '../../commerce-courses/category-path';

/**
 * Part C 管理端仓库层（评审阻断 4-API；设计 §14 C3/C5 P5–P6/C9 步骤 5）。
 *
 * - 只做 DB ↔ 契约（src/partc/contracts）的映射；语义校验在 service/compiler。
 * - `loadPlanInput` 是 apply 门的唯一内容来源：用 Plan 的 inputClosure 从 DB
 *   读同一份 source（树/renditions/verified 对齐/证据/资产），重算与冻结都对它做，
 *   绝不接受外部传入的冻结内容（评审阻断 8）。apply 事务内的读取全部走同一
 *   `Prisma.TransactionClient`（findPlanIn/findLatestApprovalIn/loadSourceIn）。
 * - 全系统不使用内容哈希等摘要作为身份：这里没有任何摘要参与身份或比较。
 *
 * 集成注意：live 指针由发布记录（`pc_publication`）派生 —— 最高有效发布
 * （validFrom <= now 且 validTo 为空或 > now）即线上版本。apply 写入内容版本
 * 的同时追加一条发布记录并把上一条的 validTo 收敛为本次 validFrom；不另存
 * 可空指针列，也不使用任何内容哈希。
 */

/** v1 只允许单一 target（C0：多 target 延后）。 */
export const PART_C_SINGLE_TARGET_ID = 'target-1';

export interface StageTreeView {
  readonly stages: readonly Stage[];
  readonly prerequisiteEdges: readonly PrerequisiteEdge[];
}

type DbClient = Prisma.TransactionClient | PrismaService;

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function depthOfOrderKey(orderKey: string): number {
  return orderKey.split('.').length;
}

@Injectable()
export class PartcAdminRepository {
  constructor(private readonly prisma: PrismaService) {}

  async courseExists(courseKey: string): Promise<boolean> {
    const row = await this.prisma.pcCourse.findUnique({
      where: { courseKey },
      select: { courseKey: true },
    });
    return row !== null;
  }

  // -------------------------------------------------------------------------
  // Stage 树（意图域；orderKey 由 service 生成，本层只做原子替换）
  // -------------------------------------------------------------------------

  private async readStages(
    client: DbClient,
    courseKey: string,
  ): Promise<Stage[]> {
    const rows = await client.pcStage.findMany({
      where: { courseKey },
      orderBy: { orderKey: 'asc' },
    });
    return rows.map((row) =>
      StageSchema.parse({
        courseKey: row.courseKey,
        stageKey: row.stageKey,
        parentStageKey: row.parentStageKey,
        orderKey: row.orderKey,
        kind: row.kind,
        goal: row.goal,
        objectiveKeys: [...row.objectiveKeys],
        exitEvidence: [...row.exitEvidence],
        exitRollup: row.exitRollup,
        ...(row.durationBudget === null
          ? {}
          : { durationBudget: row.durationBudget }),
        status: row.status,
      }),
    );
  }

  private async readEdges(
    client: DbClient,
    courseKey: string,
  ): Promise<PrerequisiteEdge[]> {
    const rows = await client.pcPrerequisiteEdge.findMany({
      where: { fromStage: { courseKey } },
      orderBy: [
        { fromStageKey: 'asc' },
        { toStageKey: 'asc' },
        { kind: 'asc' },
      ],
    });
    return rows.map((row) =>
      PrerequisiteEdgeSchema.parse({
        fromStageKey: row.fromStageKey,
        toStageKey: row.toStageKey,
        kind: row.kind,
      }),
    );
  }

  async loadStageTree(courseKey: string): Promise<StageTreeView> {
    return {
      stages: await this.readStages(this.prisma, courseKey),
      prerequisiteEdges: await this.readEdges(this.prisma, courseKey),
    };
  }

  /**
   * 原子替换整棵阶段树：删除不再声明的阶段（深度倒序，级联其对齐），
   * 先删全部边、再以两阶段写 orderKey（避免同父重排时的唯一键冲突），
   * 最后重建边。保留阶段的 PcAlignment 不删除（人签对齐优先，ALN-2）。
   */
  async replaceStageTree(
    courseKey: string,
    stages: readonly Stage[],
    edges: readonly PrerequisiteEdge[],
  ): Promise<StageTreeView> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.pcStage.findMany({
        where: { courseKey },
        select: { stageKey: true, parentStageKey: true, orderKey: true },
      });
      const incomingKeys = new Set<string>(
        stages.map((stage) => stage.stageKey),
      );
      // stageKey 全局稳定且不可跨课程复用（C3）：发现别门课程已占用即拒绝，
      // 绝不通过 upsert 把别人的阶段"搬"过来。
      const foreignOwners = await tx.pcStage.findMany({
        where: {
          stageKey: { in: [...incomingKeys] },
          courseKey: { not: courseKey },
        },
        select: { stageKey: true, courseKey: true },
      });
      if (foreignOwners.length > 0) {
        throw new ConflictException({
          code: 'STAGE_KEY_CONFLICT',
          message: `stageKey is already owned by another course: ${foreignOwners
            .map((owner) => `${owner.stageKey}@${owner.courseKey}`)
            .join(', ')}`,
        });
      }
      const depthByKey = new Map<string, number>();
      for (const row of existing) {
        depthByKey.set(row.stageKey, depthOfOrderKey(row.orderKey));
      }
      const depthOf = (key: string): number => {
        let depth = 1;
        let current = existing.find(
          (row) => row.stageKey === key,
        )?.parentStageKey;
        let guard = 0;
        while (current !== null && current !== undefined && guard < 32) {
          depth += 1;
          current = existing.find(
            (row) => row.stageKey === current,
          )?.parentStageKey;
          guard += 1;
        }
        return depth;
      };
      const removed = existing
        .filter((row) => !incomingKeys.has(row.stageKey))
        .sort(
          (left, right) => depthOf(right.stageKey) - depthOf(left.stageKey),
        );
      for (const row of removed) {
        await tx.pcAlignment.deleteMany({ where: { stageKey: row.stageKey } });
        await tx.pcStage.delete({ where: { stageKey: row.stageKey } });
      }

      // 边属于树结构：整组替换。
      await tx.pcPrerequisiteEdge.deleteMany({
        where: {
          OR: [{ fromStage: { courseKey } }, { toStage: { courseKey } }],
        },
      });

      // 阶段一：把仍保留的行挪到临时 orderKey（课程内唯一、格式合法），
      // 这样阶段二的同父重排不会撞唯一索引。
      const retained = existing.filter((row) => incomingKeys.has(row.stageKey));
      for (const [index, row] of retained.entries()) {
        const depth = depthByKey.get(row.stageKey) ?? 1;
        const temp = `${'999999.'.repeat(depth)}${String(999000 + index).padStart(6, '0')}`;
        await tx.pcStage.update({
          where: { stageKey: row.stageKey },
          data: { orderKey: temp, parentStageKey: null },
        });
      }

      // 阶段二：按深度升序写最终值（父先于子；FK 只要求父存在）。
      const ordered = [...stages].sort(
        (left, right) =>
          depthOfOrderKey(left.orderKey) - depthOfOrderKey(right.orderKey) ||
          (left.orderKey < right.orderKey ? -1 : 1),
      );
      for (const stage of ordered) {
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
        await tx.pcStage.upsert({
          where: { stageKey: stage.stageKey },
          create: { stageKey: stage.stageKey, ...data },
          update: data,
        });
      }

      for (const edge of edges) {
        await tx.pcPrerequisiteEdge.create({
          data: {
            fromStageKey: edge.fromStageKey,
            toStageKey: edge.toStageKey,
            kind: edge.kind,
          },
        });
      }

      // C6 inputClosure 单调计数器：树/边写入 +1；被删阶段的级联对齐也算
      // 对齐集变化。
      await tx.pcCourse.update({
        where: { courseKey },
        data: {
          structureRevision: { increment: 1 },
          ...(removed.length === 0
            ? {}
            : { alignmentSetVersion: { increment: 1 } }),
        },
      });
    });
    return this.loadStageTree(courseKey);
  }

  // -------------------------------------------------------------------------
  // EvidenceSpec（按 (evidenceKey, version) 版本化；历史版本保留）
  // -------------------------------------------------------------------------

  private mapEvidenceSpec(row: {
    evidenceKey: string;
    version: number;
    kind: string;
    objectiveKeys: string[];
    measure: Prisma.JsonValue;
    scoring: string;
    threshold: number;
    attempts: number;
  }): EvidenceSpec {
    return EvidenceSpecSchema.parse({
      evidenceKey: row.evidenceKey,
      version: row.version,
      kind: row.kind,
      objectiveKeys: [...row.objectiveKeys],
      measure: row.measure,
      scoring: row.scoring,
      threshold: row.threshold,
      attempts: row.attempts,
    });
  }

  private async listLatestEvidenceSpecsIn(
    client: DbClient,
    evidenceKeys?: readonly string[],
  ): Promise<EvidenceSpec[]> {
    const rows = await client.pcEvidenceSpec.findMany({
      where:
        evidenceKeys === undefined
          ? undefined
          : { evidenceKey: { in: [...evidenceKeys] } },
      orderBy: [{ evidenceKey: 'asc' }, { version: 'desc' }],
    });
    const latest = new Map<string, EvidenceSpec>();
    for (const row of rows) {
      if (latest.has(row.evidenceKey)) continue;
      latest.set(row.evidenceKey, this.mapEvidenceSpec(row));
    }
    return [...latest.values()].sort((left, right) =>
      left.evidenceKey < right.evidenceKey ? -1 : 1,
    );
  }

  async listLatestEvidenceSpecs(
    evidenceKeys?: readonly string[],
  ): Promise<EvidenceSpec[]> {
    return this.listLatestEvidenceSpecsIn(this.prisma, evidenceKeys);
  }

  async nextEvidenceSpecVersion(evidenceKey: string): Promise<number> {
    const aggregate = await this.prisma.pcEvidenceSpec.aggregate({
      where: { evidenceKey },
      _max: { version: true },
    });
    return (aggregate._max.version ?? 0) + 1;
  }

  async insertEvidenceSpec(spec: EvidenceSpec): Promise<EvidenceSpec> {
    const row = await this.prisma.pcEvidenceSpec.create({
      data: {
        evidenceKey: spec.evidenceKey,
        version: spec.version,
        kind: spec.kind,
        objectiveKeys: [...spec.objectiveKeys],
        measure: jsonValue(spec.measure),
        scoring: spec.scoring,
        threshold: spec.threshold,
        attempts: spec.attempts,
      },
    });
    return this.mapEvidenceSpec(row);
  }

  // -------------------------------------------------------------------------
  // Plan 输入闭包 → DB 内容源（预览/保存/apply 共用唯一读取点）
  // -------------------------------------------------------------------------

  async loadPlanInput(closure: InputClosure): Promise<PlanSourceSnapshot> {
    return this.loadSource(closure.courseKey);
  }

  async loadSource(courseKey: string): Promise<PlanSourceSnapshot> {
    return this.loadSourceIn(this.prisma, courseKey);
  }

  /**
   * 从一个课程的 DB 状态构造 plan 编译输入：
   * - 课程内容 = 课程 stage 的对齐所引用的 rendition 的 contentKey 闭包
   *   （specPins = 这些 contentKey 的最新版本）；
   * - 证据规格 = 交付叶 exitEvidence 引用的最新版本；
   * - 视频 rendition 全量进入 source（ALN-7 才能发现缺语言/缺对齐）。
   */
  private async loadSourceIn(
    client: DbClient,
    courseKey: string,
  ): Promise<PlanSourceSnapshot> {
    const course = await client.pcCourse.findUnique({
      where: { courseKey },
    });
    if (course === null) {
      throw new PartCError(
        'PLAN_INPUT_CHANGED',
        'course for the plan inputClosure does not exist',
        { courseKey },
      );
    }
    const stages = await this.readStages(client, courseKey);
    const prerequisiteEdges = await this.readEdges(client, courseKey);
    const stageKeys = stages.map((stage) => stage.stageKey);
    const alignmentRows = await client.pcAlignment.findMany({
      where: { stageKey: { in: stageKeys } },
      orderBy: { alignmentId: 'asc' },
    });
    const alignments: Alignment[] = alignmentRows.map((row) =>
      this.mapAlignmentRow(row),
    );

    const seedRenditionKeys = [
      ...new Set(alignments.map((alignment) => alignment.renditionKey)),
    ];
    const seedRenditions =
      seedRenditionKeys.length === 0
        ? []
        : await client.pcRendition.findMany({
            where: { renditionKey: { in: seedRenditionKeys } },
          });
    const closureEvidenceKeys = [
      ...new Set(stages.flatMap((stage) => stage.exitEvidence)),
    ];
    const evidenceSpecs = await this.listLatestEvidenceSpecsIn(
      client,
      closureEvidenceKeys,
    );
    const contentKeys = new Set<string>(
      seedRenditions.map((row) => row.contentKey),
    );
    for (const spec of evidenceSpecs) {
      if (spec.measure.kind === 'assessment') {
        contentKeys.add(spec.measure.contentKey);
      }
    }
    const specRows =
      contentKeys.size === 0
        ? []
        : await client.pcContentSpec.findMany({
            where: { contentKey: { in: [...contentKeys] } },
            orderBy: [{ contentKey: 'asc' }, { version: 'desc' }],
          });
    const latestSpecVersion = new Map<string, number>();
    for (const row of specRows) {
      if (latestSpecVersion.has(row.contentKey)) continue;
      latestSpecVersion.set(row.contentKey, row.version);
    }
    const specPins = SpecPinSchema.array().parse(
      [...latestSpecVersion.entries()]
        .map(([contentKey, version]) => ({ contentKey, version }))
        .sort((left, right) => (left.contentKey < right.contentKey ? -1 : 1)),
    );
    const renditionRows =
      specPins.length === 0
        ? []
        : await client.pcRendition.findMany({
            where: { contentKey: { in: [...latestSpecVersion.keys()] } },
            orderBy: { renditionKey: 'asc' },
          });
    const renditions: Rendition[] = renditionRows.map((row) =>
      RenditionSchema.parse({
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
      }),
    );

    const assetPinMap = new Map<
      string,
      { assetKey: string; assetVersion: number }
    >();
    for (const rendition of renditions) {
      if (rendition.carrierType !== 'asset') continue;
      assetPinMap.set(`${rendition.carrierKey}@${rendition.carrierVersion}`, {
        assetKey: rendition.carrierKey,
        assetVersion: rendition.carrierVersion,
      });
    }
    const assetPins = AssetPinSchema.array().parse(
      [...assetPinMap.values()].sort((left, right) =>
        left.assetKey < right.assetKey ? -1 : 1,
      ),
    );
    const assetRows =
      assetPins.length === 0
        ? []
        : await client.pcMediaAsset.findMany({
            where: {
              OR: assetPins.map((pin) => ({
                assetKey: pin.assetKey,
                assetVersion: pin.assetVersion,
              })),
            },
          });
    const mediaAssets: MediaAssetTimingInfo[] = assetRows.map((row) => ({
      assetKey: row.assetKey,
      assetVersion: row.assetVersion,
      ...(row.durationMs === null ? {} : { durationMs: row.durationMs }),
    }));

    const timingSourcesByRendition = new Map<
      string,
      RenditionTimingSourcePin
    >();
    for (const row of alignmentRows) {
      if (
        row.sourceKind === null ||
        row.sourceArtifact === null ||
        row.ruleVersion === null
      ) {
        continue;
      }
      if (timingSourcesByRendition.has(row.renditionKey)) continue;
      const modelPinned =
        row.sourceKind === 'asr' || row.sourceKind === 'forced-alignment';
      timingSourcesByRendition.set(row.renditionKey, {
        renditionKey: row.renditionKey,
        sourceKind: row.sourceKind as PlanTimingSourceKind,
        sourceArtifact: row.sourceArtifact,
        ruleVersion: row.ruleVersion,
        ...(modelPinned && row.modelVersion !== null
          ? { modelVersion: row.modelVersion }
          : {}),
        ...(modelPinned && row.params !== null
          ? { params: AuditParamsSchema.parse(row.params) }
          : {}),
      });
    }

    const targets = PublishTargetSchema.array().parse(course.publishTargets);
    if (targets.length === 0) {
      throw new PartCError(
        'PLAN_INPUT_CHANGED',
        'course has no publishTargets; a plan cannot be compiled',
        { courseKey },
      );
    }
    if (targets.length > 1) {
      throw new PartCError(
        'UNSUPPORTED_ORDERING',
        'v1 supports a single publish target per course',
        { courseKey, targetCount: targets.length },
      );
    }
    const categoryPath = CategoryPathSchema.parse(course.categoryPath);

    const source: PlanSource = {
      courseKey,
      stages,
      prerequisiteEdges,
      renditions,
      alignments,
      evidenceSpecs,
      specPins,
      assetPins,
    };
    return {
      source,
      mediaAssets,
      timingSources: [...timingSourcesByRendition.values()].sort(
        (left, right) => (left.renditionKey < right.renditionKey ? -1 : 1),
      ),
      target: {
        languages: [...targets[0].languages],
        modalities: [...targets[0].modalities],
      },
      categoryPath,
      // C6 inputClosure 计数器：以持久化的单调计数器为准；历史行（迁移前
      // 写入、计数器仍为 0）回落到确定性计数，保证不低估当前修订。
      structureRevision: Math.max(
        course.structureRevision,
        stages.length + prerequisiteEdges.length,
      ),
      alignmentSetVersion: Math.max(
        course.alignmentSetVersion,
        alignments.length,
      ),
    };
  }

  /**
   * 结构修订计数（C6 inputClosure.structureRevision）：持久化于
   * `pc_course.structureRevision`，写入路径 +1（历史行回落确定性计数）。
   */
  structureRevisionOf(snapshot: PlanSourceSnapshot): number {
    return snapshot.structureRevision;
  }

  /** 对齐集版本（C6 inputClosure.alignmentSetVersion；同上，持久化计数器）。 */
  alignmentSetVersionOf(snapshot: PlanSourceSnapshot): number {
    return snapshot.alignmentSetVersion;
  }

  // -------------------------------------------------------------------------
  // Alignment（人签收：proposed → verified/rejected，C3/C4 ALN-2/C10.4）
  // -------------------------------------------------------------------------

  /** DB 行 → 契约 Alignment（唯一映射点，loadSource/list/sign-off 共用）。 */
  private mapAlignmentRow(row: {
    alignmentId: string;
    stageKey: string;
    renditionKey: string;
    objectiveKey: string;
    role: string;
    status: string;
    provenance: string;
    sourceKind: string | null;
    sourceArtifact: string | null;
    modelVersion: string | null;
    params: Prisma.JsonValue | null;
    ruleVersion: string | null;
    confidence: number | null;
    verifiedBy: string | null;
    verifiedAt: Date | null;
    verifiedAgainst: Prisma.JsonValue | null;
  }): Alignment {
    return AlignmentSchema.parse({
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
  }

  /** 某门课程的全部对齐（管理员复核/签收用；导入派生的 proposed 也在内）。 */
  async listAlignments(courseKey: string): Promise<Alignment[]> {
    const rows = await this.prisma.pcAlignment.findMany({
      where: { stage: { courseKey } },
      orderBy: [{ stageKey: 'asc' }, { renditionKey: 'asc' }],
    });
    return rows.map((row) => this.mapAlignmentRow(row));
  }

  /**
   * 显式 stage ↔ rendition ↔ objective 绑定（人指定，设计 §14 C5 P4 的
   * 「显式 binding 输入」HTTP 入口；D 缺陷：全新课程包不猜绑定，必须由人给出）。
   *
   * 规则（写入即冻结，不猜）：
   * - stageKey 必须属于本课程且 objectiveKey 必须在该 stage.objectiveKeys 内；
   * - renditionKey 必须已由导入/派生落库（机器只引用既有 rendition，不合成）；
   * - UNIQUE(stageKey, renditionKey) 是存储不变量：已 verified/rejected 的
   *   记录不可被本入口改写（409）；已 proposed 且三元组不同 → 409，
   *   三元组完全相同 → 幂等返回原记录；
   * - provenance = human（人显式给出）；status 恒为 proposed —— 仍须走
   *   `alignments/:id/sign-off` 人签收（C0 红线⑭），本入口不代签；
   * - 写入改变对齐集 → alignmentSetVersion +1（C6 inputClosure）。
   */
  async createProposedAlignment(input: {
    courseKey: string;
    stageKey: string;
    renditionKey: string;
    objectiveKey: string;
    role: string;
  }): Promise<Alignment> {
    return this.prisma.$transaction(async (tx) => {
      const stage = await tx.pcStage.findUnique({
        where: { stageKey: input.stageKey },
        select: { courseKey: true, objectiveKeys: true },
      });
      if (stage === null || stage.courseKey !== input.courseKey) {
        throw new NotFoundException({
          code: 'STAGE_NOT_FOUND',
          message: `stage '${input.stageKey}' not found for this course`,
        });
      }
      if (!stage.objectiveKeys.includes(input.objectiveKey)) {
        throw new UnprocessableEntityException({
          code: 'VALIDATION_ERROR',
          message: `objective '${input.objectiveKey}' does not belong to stage '${input.stageKey}'`,
        });
      }
      const rendition = await tx.pcRendition.findUnique({
        where: { renditionKey: input.renditionKey },
        select: { renditionKey: true },
      });
      if (rendition === null) {
        throw new NotFoundException({
          code: 'RENDITION_NOT_FOUND',
          message: `rendition '${input.renditionKey}' not found`,
        });
      }

      const existing = await tx.pcAlignment.findUnique({
        where: {
          stageKey_renditionKey: {
            stageKey: input.stageKey,
            renditionKey: input.renditionKey,
          },
        },
      });
      if (existing !== null) {
        if (existing.status !== 'proposed') {
          throw new ConflictException({
            code: 'ALIGNMENT_ALREADY_DECIDED',
            message: `alignment is already ${existing.status}; create cannot overwrite a signed-off alignment`,
          });
        }
        if (
          existing.objectiveKey !== input.objectiveKey ||
          existing.role !== input.role
        ) {
          throw new ConflictException({
            code: 'ALIGNMENT_CONFLICT',
            message: `(stageKey, renditionKey) already has a proposed alignment with objective '${existing.objectiveKey}' and role '${existing.role}'`,
          });
        }
        return this.mapAlignmentRow(existing);
      }

      const created = await tx.pcAlignment.create({
        data: {
          alignmentId: randomUUID(),
          stageKey: input.stageKey,
          renditionKey: input.renditionKey,
          objectiveKey: input.objectiveKey,
          role: input.role,
          status: 'proposed',
          provenance: 'human',
          sourceKind: null,
          sourceArtifact: null,
          modelVersion: null,
          params: Prisma.DbNull,
          ruleVersion: null,
          confidence: null,
          verifiedBy: null,
          verifiedAt: null,
          verifiedAgainst: Prisma.DbNull,
        },
      });
      const course = await tx.pcCourse.findUniqueOrThrow({
        where: { courseKey: input.courseKey },
        select: { alignmentSetVersion: true },
      });
      const alignmentCount = await tx.pcAlignment.count({
        where: { stage: { courseKey: input.courseKey } },
      });
      await tx.pcCourse.update({
        where: { courseKey: input.courseKey },
        data: {
          alignmentSetVersion:
            Math.max(course.alignmentSetVersion, alignmentCount) + 1,
        },
      });
      return this.mapAlignmentRow(created);
    });
  }

  /**
   * 人签收（C3/C4 ALN-2）：只允许 proposed → verified | rejected。
   *
   * - verifiedAgainst 由服务端按当前 DB 真源派生（rendition revision /
   *   carrierVersion / 该 contentKey 的最新 spec pin），不信任客户端声明；
   *   客户端若回传观察到的元组且与当前值不等 → ALIGNMENT_STALE（C5 P6 同一模式）。
   * - verifiedBy 取会话员工（人签），verifiedAt 取服务端时钟；审计来源字段
   *   （sourceKind/sourceArtifact/ruleVersion/modelVersion/params）由派生写入，
   *   签收只补人签三件套，绝不伪造。
   * - 签收改变 verified/rejected 集 → alignmentSetVersion 抬到「有效值 + 1」
   *   （C6 inputClosure；读取层对历史行有行数回落，故必须严格大于它），
   *   任何已保存 plan 的 apply 会因此被 PLAN_INPUT_CHANGED 拒绝，必须重新预览。
   * - 并发：状态转移用 `updateMany(status='proposed')` 原子判定，输者 409。
   */
  async signOffAlignment(input: {
    courseKey: string;
    alignmentId: string;
    decision: 'verified' | 'rejected';
    actor: string;
    at: Date;
    expectedVerifiedAgainst?: {
      renditionRevision: number;
      carrierVersion: number;
      specVersion: number;
    };
  }): Promise<Alignment> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.pcAlignment.findUnique({
        where: { alignmentId: input.alignmentId },
        include: {
          stage: { select: { courseKey: true, objectiveKeys: true } },
          rendition: {
            select: {
              revision: true,
              carrierVersion: true,
              contentKey: true,
            },
          },
        },
      });
      if (row === null || row.stage.courseKey !== input.courseKey) {
        throw new NotFoundException({
          code: 'ALIGNMENT_NOT_FOUND',
          message: 'alignment not found for this course',
        });
      }
      if (row.status !== 'proposed') {
        throw new ConflictException({
          code: 'ALIGNMENT_ALREADY_DECIDED',
          message: `alignment is already ${row.status}; only proposed alignments can be signed off`,
        });
      }
      if (!row.stage.objectiveKeys.includes(row.objectiveKey)) {
        throw new UnprocessableEntityException({
          code: 'VALIDATION_ERROR',
          message: `alignment objective '${row.objectiveKey}' does not belong to stage '${row.stageKey}'`,
        });
      }

      let data: Prisma.PcAlignmentUpdateManyMutationInput;
      if (input.decision === 'rejected') {
        data = {
          status: 'rejected',
          verifiedBy: null,
          verifiedAt: null,
          verifiedAgainst: Prisma.DbNull,
        };
      } else {
        // ALN-3 粘合元组：rendition 业务键唯一，坐标单源；specVersion = 最新 pin。
        const spec = await tx.pcContentSpec.findFirst({
          where: { contentKey: row.rendition.contentKey },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        if (spec === null) {
          throw new UnprocessableEntityException({
            code: 'VALIDATION_ERROR',
            message: `alignment rendition contentKey '${row.rendition.contentKey}' has no ContentSpec version to verify against`,
          });
        }
        const verifiedAgainst = {
          renditionRevision: row.rendition.revision,
          carrierVersion: row.rendition.carrierVersion,
          specVersion: spec.version,
        };
        const expected = input.expectedVerifiedAgainst;
        if (
          expected !== undefined &&
          (expected.renditionRevision !== verifiedAgainst.renditionRevision ||
            expected.carrierVersion !== verifiedAgainst.carrierVersion ||
            expected.specVersion !== verifiedAgainst.specVersion)
        ) {
          throw new ConflictException({
            code: 'ALIGNMENT_STALE',
            message:
              'verifiedAgainst does not match the current rendition/spec pins; reload before signing off',
            current: verifiedAgainst,
          });
        }
        data = {
          status: 'verified',
          verifiedBy: input.actor,
          verifiedAt: input.at,
          verifiedAgainst: jsonValue(verifiedAgainst),
        };
      }

      const updated = await tx.pcAlignment.updateMany({
        where: { alignmentId: input.alignmentId, status: 'proposed' },
        data,
      });
      if (updated.count !== 1) {
        throw new ConflictException({
          code: 'ALIGNMENT_ALREADY_DECIDED',
          message: 'alignment was signed off concurrently; reload it',
        });
      }
      // C6 inputClosure：对齐集变化必须可见。读取层对历史行回落到对齐行数
      // （`Math.max(counter, rows)`），因此这里把计数器抬到「有效值 + 1」，
      // 保证签收后 alignmentSetVersion 严格变大（单调、不被回退掩盖）。
      const course = await tx.pcCourse.findUniqueOrThrow({
        where: { courseKey: input.courseKey },
        select: { alignmentSetVersion: true },
      });
      const alignmentCount = await tx.pcAlignment.count({
        where: { stage: { courseKey: input.courseKey } },
      });
      await tx.pcCourse.update({
        where: { courseKey: input.courseKey },
        data: {
          alignmentSetVersion:
            Math.max(course.alignmentSetVersion, alignmentCount) + 1,
        },
      });
      const signed = await tx.pcAlignment.findUniqueOrThrow({
        where: { alignmentId: input.alignmentId },
      });
      return this.mapAlignmentRow(signed);
    });
  }

  /**
   * 草稿来源版本标签（C10.3/C10.6）：导入课程包时写入
   * `CommerceCourse.draftSourceVersionLabel`（= 包 provenance.sourceVersionLabel）。
   * apply 冻结 ContentVersion 时写进 sourceLabel（PRD Source 字段/争议追溯）；
   * 非导入内容返回 null（不伪造标签）。
   */
  async findDraftSourceVersionLabel(courseKey: string): Promise<string | null> {
    const row = await this.prisma.commerceCourse.findUnique({
      where: { code: courseKey },
      select: { draftSourceVersionLabel: true },
    });
    return row?.draftSourceVersionLabel ?? null;
  }

  /** 下一个本地内容版本身份（versionNo 单调；contentVersionId 显式派生，无摘要）。 */
  async nextContentVersionIdentity(
    courseKey: string,
  ): Promise<{ versionNo: number; contentVersionId: string }> {
    const aggregate = await this.prisma.pcContentVersion.aggregate({
      where: { courseKey },
      _max: { versionNo: true },
    });
    const versionNo = (aggregate._max.versionNo ?? 0) + 1;
    const contentVersionId = `cv-${courseKey}-v${versionNo}`;
    if (!STABLE_KEY_PATTERN.test(contentVersionId)) {
      throw new PartCError(
        'PLAN_INPUT_CHANGED',
        'derived contentVersionId is not a stable token (courseKey too long)',
        { courseKey, contentVersionId },
      );
    }
    return { versionNo, contentVersionId };
  }

  async maxPlanVersion(
    courseKey: string,
    contentVersionId: string,
    targetId: string,
  ): Promise<number> {
    const aggregate = await this.prisma.pcPlan.aggregate({
      where: { courseKey, contentVersionId, targetId },
      _max: { planVersion: true },
    });
    return aggregate._max.planVersion ?? 0;
  }

  // -------------------------------------------------------------------------
  // Plan / PlanApproval / ContentVersion（apply 事务端口）
  // -------------------------------------------------------------------------

  private mapStoredPlan(row: {
    canonicalJson: string;
    status: string;
  }): StoredPlan {
    const body = PlanBodySchema.parse(JSON.parse(row.canonicalJson));
    const record = PlanRecordSchema.parse({
      ...body,
      status: row.status,
    });
    return { record, canonicalJson: row.canonicalJson };
  }

  private async findPlanIn(
    client: DbClient,
    planId: string,
    planVersion: number,
  ): Promise<StoredPlan | null> {
    const row = await client.pcPlan.findUnique({
      where: { planId_planVersion: { planId, planVersion } },
    });
    return row === null ? null : this.mapStoredPlan(row);
  }

  async findPlan(
    planId: string,
    planVersion: number,
  ): Promise<StoredPlan | null> {
    return this.findPlanIn(this.prisma, planId, planVersion);
  }

  private async findLatestApprovalIn(
    client: DbClient,
    planId: string,
    planVersion: number,
  ): Promise<PlanApproval | null> {
    const row = await client.pcPlanApproval.findFirst({
      where: { planId, planVersion },
      orderBy: [{ approvedAt: 'desc' }, { id: 'desc' }],
    });
    if (row === null) return null;
    return PlanApprovalSchema.parse({
      planId: row.planId,
      planVersion: row.planVersion,
      decision: row.decision,
      approvedBy: row.approvedBy,
      approvedAt: row.approvedAt.toISOString(),
      acceptedWarnings: row.acceptedWarnings,
    });
  }

  async findLatestApproval(
    planId: string,
    planVersion: number,
  ): Promise<PlanApproval | null> {
    return this.findLatestApprovalIn(this.prisma, planId, planVersion);
  }

  async insertPlanRecord(input: {
    planId: string;
    courseKey: string;
    contentVersionId: string;
    targetId: string;
    planVersion: number;
    inputClosure: unknown;
    canonicalJson: string;
    status: PlanRecord['status'];
    compilerVersion: string;
    ruleVersion: string;
  }): Promise<StoredPlan> {
    const row = await this.prisma.pcPlan.create({
      data: {
        planId: input.planId,
        courseKey: input.courseKey,
        contentVersionId: input.contentVersionId,
        targetId: input.targetId,
        planVersion: input.planVersion,
        inputClosure: jsonValue(input.inputClosure),
        canonicalJson: input.canonicalJson,
        status: input.status,
        compilerVersion: input.compilerVersion,
        ruleVersion: input.ruleVersion,
      },
    });
    return this.mapStoredPlan(row);
  }

  async updatePlanStatus(
    planId: string,
    planVersion: number,
    status: PlanRecord['status'],
  ): Promise<void> {
    await this.prisma.pcPlan.update({
      where: { planId_planVersion: { planId, planVersion } },
      data: { status },
    });
  }

  async insertApproval(approval: PlanApproval): Promise<PlanApproval> {
    const row = await this.prisma.pcPlanApproval.create({
      data: {
        planId: approval.planId,
        planVersion: approval.planVersion,
        decision: approval.decision,
        approvedBy: approval.approvedBy,
        approvedAt: new Date(approval.approvedAt),
        acceptedWarnings: jsonValue(approval.acceptedWarnings),
      },
    });
    return PlanApprovalSchema.parse({
      planId: row.planId,
      planVersion: row.planVersion,
      decision: row.decision,
      approvedBy: row.approvedBy,
      approvedAt: row.approvedAt.toISOString(),
      acceptedWarnings: row.acceptedWarnings,
    });
  }

  private mapContentVersionRow(row: {
    contentVersionId: string;
    courseKey: string;
    versionNo: number;
    frozenAt: Date;
    sourceEnv: string | null;
    sourceLabel: string | null;
    categoryPath: Prisma.JsonValue;
    stages: Prisma.JsonValue;
    prerequisiteEdges: Prisma.JsonValue;
    specPins: Prisma.JsonValue;
    renditions: Prisma.JsonValue;
    alignments: Prisma.JsonValue;
    evidenceSpecs: Prisma.JsonValue;
    assetPins: Prisma.JsonValue;
    planId: string;
    planVersion: number;
  }): ContentVersion {
    return ContentVersionSchema.parse({
      contentVersionId: row.contentVersionId,
      courseKey: row.courseKey,
      versionNo: row.versionNo,
      frozenAt: row.frozenAt.toISOString(),
      ...(row.sourceEnv === null ? {} : { sourceEnv: row.sourceEnv }),
      ...(row.sourceLabel === null ? {} : { sourceLabel: row.sourceLabel }),
      categoryPath: row.categoryPath,
      stages: row.stages,
      prerequisiteEdges: row.prerequisiteEdges,
      specPins: row.specPins,
      renditions: row.renditions,
      alignments: row.alignments,
      evidenceSpecs: row.evidenceSpecs,
      assetPins: row.assetPins,
      planPin: { planId: row.planId, planVersion: row.planVersion },
    });
  }

  async findAllContentVersions(courseKey: string): Promise<ContentVersion[]> {
    const rows = await this.prisma.pcContentVersion.findMany({
      where: { courseKey },
      orderBy: { versionNo: 'asc' },
    });
    return rows.map((row) => this.mapContentVersionRow(row));
  }

  async findContentVersionByNo(
    courseKey: string,
    versionNo: number,
  ): Promise<ContentVersion | null> {
    const row = await this.prisma.pcContentVersion.findUnique({
      where: { courseKey_versionNo: { courseKey, versionNo } },
    });
    return row === null ? null : this.mapContentVersionRow(row);
  }

  async findContentVersionById(
    courseKey: string,
    contentVersionId: string,
  ): Promise<ContentVersion | null> {
    const row = await this.prisma.pcContentVersion.findFirst({
      where: { contentVersionId, courseKey },
    });
    return row === null ? null : this.mapContentVersionRow(row);
  }

  async findContentVersionByPin(
    planId: string,
    planVersion: number,
  ): Promise<ContentVersion | null> {
    const row = await this.prisma.pcContentVersion.findFirst({
      where: { planId, planVersion },
      orderBy: { versionNo: 'desc' },
    });
    return row === null ? null : this.mapContentVersionRow(row);
  }

  private async findContentVersionIn(
    client: DbClient,
    courseKey: string,
    versionNo: number,
  ): Promise<ContentVersion | null> {
    const row = await client.pcContentVersion.findUnique({
      where: { courseKey_versionNo: { courseKey, versionNo } },
    });
    return row === null ? null : this.mapContentVersionRow(row);
  }

  private async insertContentVersionIn(
    client: Prisma.TransactionClient,
    version: ContentVersion,
  ): Promise<void> {
    await client.pcContentVersion.create({
      data: {
        contentVersionId: version.contentVersionId,
        courseKey: version.courseKey,
        versionNo: version.versionNo,
        frozenAt: new Date(version.frozenAt),
        sourceEnv: version.sourceEnv ?? null,
        sourceLabel: version.sourceLabel ?? null,
        categoryPath:
          version.categoryPath === null ? Prisma.DbNull : version.categoryPath,
        stages: jsonValue(version.stages),
        prerequisiteEdges: jsonValue(version.prerequisiteEdges),
        specPins: jsonValue(version.specPins),
        renditions: jsonValue(version.renditions),
        alignments: jsonValue(version.alignments),
        evidenceSpecs: jsonValue(version.evidenceSpecs),
        assetPins: jsonValue(version.assetPins),
        planId: version.planPin.planId,
        planVersion: version.planPin.planVersion,
      },
    });
  }

  /**
   * live 指针（C5 P6 / C10）：追加写一条发布记录并把上一条的 validTo 收敛为
   * 本次 validFrom。所有有效发布中 versionNo 最大者即线上版本（派生，不存
   * 指针列）。写入前校验目标版本确实是该课程最高 versionNo，防止旧计划把
   * 指针拨回。
   */
  private async setLiveContentVersionIn(
    client: Prisma.TransactionClient,
    pointer: PlanLivePointer,
  ): Promise<void> {
    const aggregate = await client.pcContentVersion.aggregate({
      where: { courseKey: pointer.courseKey },
      _max: { versionNo: true },
    });
    const live = await client.pcContentVersion.findUnique({
      where: {
        courseKey_versionNo: {
          courseKey: pointer.courseKey,
          versionNo: pointer.versionNo,
        },
      },
      select: { contentVersionId: true },
    });
    if (
      live === null ||
      live.contentVersionId !== pointer.contentVersionId ||
      aggregate._max.versionNo !== pointer.versionNo
    ) {
      throw new PartCError(
        'PLAN_INPUT_CHANGED',
        'live content version pointer must reference the highest versionNo of the course',
        {
          courseKey: pointer.courseKey,
          versionNo: pointer.versionNo,
          highestVersionNo: aggregate._max.versionNo,
        },
      );
    }
    await this.insertPublicationIn(client, {
      courseKey: pointer.courseKey,
      contentVersionId: pointer.contentVersionId,
      versionNo: pointer.versionNo,
      actor: pointer.actor ?? 'system',
      ...(pointer.summary === undefined ? {} : { summary: pointer.summary }),
    });
  }

  /**
   * 发布记录（C10 历史与追溯）：valid time 区间追加写；上一条 open 记录以
   * 本次 validFrom 收口。同一 (courseKey, versionNo) 只能有一条记录。
   */
  private async insertPublicationIn(
    client: Prisma.TransactionClient,
    input: {
      courseKey: string;
      contentVersionId: string;
      versionNo: number;
      actor: string;
      summary?: string;
    },
  ): Promise<Publication> {
    const validFrom = new Date();
    await client.pcPublication.updateMany({
      where: { courseKey: input.courseKey, validTo: null },
      data: { validTo: validFrom },
    });
    const row = await client.pcPublication.create({
      data: {
        courseKey: input.courseKey,
        contentVersionId: input.contentVersionId,
        versionNo: input.versionNo,
        validFrom,
        actor: input.actor,
        summary: input.summary ?? null,
      },
    });
    return this.mapPublication(row);
  }

  private mapPublication(row: {
    id: string;
    courseKey: string;
    contentVersionId: string;
    versionNo: number;
    validFrom: Date;
    validTo: Date | null;
    actor: string;
    summary: string | null;
  }): Publication {
    return PublicationSchema.parse({
      publicationId: row.id,
      courseKey: row.courseKey,
      contentVersionId: row.contentVersionId,
      versionNo: row.versionNo,
      validFrom: row.validFrom.toISOString(),
      ...(row.validTo === null ? {} : { validTo: row.validTo.toISOString() }),
      actor: row.actor,
      ...(row.summary === null ? {} : { summary: row.summary }),
    });
  }

  /**
   * 当前有效发布（live 指针的派生来源）：validFrom <= now 且
   * (validTo 为空或 > now) 的记录中 versionNo 最大者。无发布记录返回 null。
   */
  async findLivePublication(
    courseKey: string,
    now: Date = new Date(),
  ): Promise<Publication | null> {
    const row = await this.prisma.pcPublication.findFirst({
      where: {
        courseKey,
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
      },
      orderBy: [{ versionNo: 'desc' }, { validFrom: 'desc' }],
    });
    return row === null ? null : this.mapPublication(row);
  }

  async listPublications(courseKey: string): Promise<Publication[]> {
    const rows = await this.prisma.pcPublication.findMany({
      where: { courseKey },
      orderBy: [{ versionNo: 'asc' }, { validFrom: 'asc' }],
    });
    return rows.map((row) => this.mapPublication(row));
  }

  // -------------------------------------------------------------------------
  // 可观察面（E）：live 指针与 pc_content_spec / pc_rendition / pc_media_asset
  // 的只读投影（黑盒断言残留/差集；不改变任何数据）。
  // -------------------------------------------------------------------------

  /** live 指针 = 当前有效发布记录 + 其指向的内容版本（无发布时 null）。 */
  async readLivePointer(courseKey: string): Promise<{
    publication: Publication | null;
    contentVersion: ContentVersion | null;
  }> {
    const publication = await this.findLivePublication(courseKey);
    if (publication === null) {
      return { publication: null, contentVersion: null };
    }
    const row = await this.prisma.pcContentVersion.findUnique({
      where: { contentVersionId: publication.contentVersionId },
    });
    return {
      publication,
      contentVersion: row === null ? null : this.mapContentVersionRow(row),
    };
  }

  async listContentSpecs(courseKey: string) {
    const rows = await this.prisma.pcContentSpec.findMany({
      where: { courseKey },
      orderBy: [{ contentKey: 'asc' }, { version: 'asc' }],
      include: {
        blocks: { orderBy: { sortOrder: 'asc' } },
      },
    });
    return rows.map((row) => ({
      contentKey: row.contentKey,
      version: row.version,
      courseKey: row.courseKey,
      type: row.type,
      titleLocalized: row.titleLocalized,
      objectiveHints: [...row.objectiveHints],
      sourceRefs: [...row.sourceRefs],
      blocks: row.blocks.map((block) => ({
        blockId: block.blockId,
        sortOrder: block.sortOrder,
        kind: block.kind,
        payload: block.payload,
      })),
    }));
  }

  private async contentKeysOfCourse(courseKey: string): Promise<string[]> {
    const rows = await this.prisma.pcContentSpec.findMany({
      where: { courseKey },
      select: { contentKey: true },
      distinct: ['contentKey'],
    });
    return rows.map((row) => row.contentKey);
  }

  async listRenditions(courseKey: string): Promise<Rendition[]> {
    const contentKeys = await this.contentKeysOfCourse(courseKey);
    if (contentKeys.length === 0) return [];
    const rows = await this.prisma.pcRendition.findMany({
      where: { contentKey: { in: contentKeys } },
      orderBy: { renditionKey: 'asc' },
    });
    return rows.map((row) =>
      RenditionSchema.parse({
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
      }),
    );
  }

  async listMediaAssets(courseKey: string) {
    const [course, renditions] = await Promise.all([
      this.prisma.commerceCourse.findUnique({
        where: { code: courseKey },
        select: { id: true },
      }),
      this.listRenditions(courseKey),
    ]);
    const carrierKeys = [...new Set(renditions.map((row) => row.carrierKey))];
    const or: Prisma.PcMediaAssetWhereInput[] = [];
    if (carrierKeys.length > 0) or.push({ assetKey: { in: carrierKeys } });
    if (course !== null) or.push({ uri: { contains: course.id } });
    if (or.length === 0) return [];
    const rows = await this.prisma.pcMediaAsset.findMany({
      where: { OR: or },
      orderBy: [{ assetKey: 'asc' }, { assetVersion: 'asc' }],
    });
    return rows.map((row) => ({
      assetKey: row.assetKey,
      assetVersion: row.assetVersion,
      kind: row.kind,
      language: row.language,
      durationMs: row.durationMs,
      uri: row.uri,
    }));
  }

  // -------------------------------------------------------------------------
  // P8 Restore：按冻结版本 pins 重建草稿（单事务；失败草稿不变）
  // -------------------------------------------------------------------------

  /**
   * 用不可变 ContentVersion 重建当前草稿（stage/edge/rendition/alignment/
   * evidence/pins）。先验证分类与资产，再在单事务内整组替换；任何失败
   * （CATEGORY_NOT_FOUND / ASSET_NOT_FOUND）发生在写入之前，草稿保持原样。
   */
  async restoreContentVersion(
    courseKey: string,
    version: ContentVersion,
  ): Promise<{ restored: true; version: ContentVersion }> {
    if (version.categoryPath !== null) {
      const category = await findCategoryByPath(
        this.prisma,
        version.categoryPath,
      );
      if (category === null) {
        throw new UnprocessableEntityException({
          code: 'CATEGORY_NOT_FOUND',
          message: `Category path does not resolve: ${version.categoryPath.join(' / ')}`,
          unresolvedPath: version.categoryPath,
        });
      }
    }
    const requiredAssets = new Map<string, number>();
    for (const pin of version.assetPins) {
      requiredAssets.set(pin.assetKey, pin.assetVersion);
    }
    for (const rendition of version.renditions) {
      requiredAssets.set(rendition.carrierKey, rendition.carrierVersion);
    }
    const existingAssets =
      requiredAssets.size === 0
        ? []
        : await this.prisma.pcMediaAsset.findMany({
            where: {
              OR: [...requiredAssets.entries()].map(
                ([assetKey, assetVersion]) => ({ assetKey, assetVersion }),
              ),
            },
            select: { assetKey: true, assetVersion: true },
          });
    const present = new Set(
      existingAssets.map((row) => `${row.assetKey}@${row.assetVersion}`),
    );
    const missing = [...requiredAssets.entries()]
      .filter(
        ([assetKey, assetVersion]) =>
          !present.has(`${assetKey}@${assetVersion}`),
      )
      .map(([assetKey, assetVersion]) => ({ assetKey, assetVersion }));
    if (missing.length > 0) {
      throw new PartCError(
        'ASSET_NOT_FOUND',
        'restore references assets that do not exist in this environment',
        { missing },
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // 其他课程不得占用同一 stageKey（C3：stageKey 全局稳定）。
      const incomingStageKeys = version.stages.map((stage) => stage.stageKey);
      const foreignOwners = await tx.pcStage.findMany({
        where: {
          stageKey: { in: incomingStageKeys },
          courseKey: { not: courseKey },
        },
        select: { stageKey: true, courseKey: true },
      });
      if (foreignOwners.length > 0) {
        throw new ConflictException({
          code: 'STAGE_KEY_CONFLICT',
          message: `stageKey is already owned by another course: ${foreignOwners
            .map((owner) => `${owner.stageKey}@${owner.courseKey}`)
            .join(', ')}`,
        });
      }

      // 1) 删除当前草稿的阶段/边/对齐（对齐先删，避免 rendition 删除被引用）。
      await tx.pcAlignment.deleteMany({
        where: { stage: { courseKey } },
      });
      await tx.pcPrerequisiteEdge.deleteMany({
        where: {
          OR: [{ fromStage: { courseKey } }, { toStage: { courseKey } }],
        },
      });
      // 自引用父关系是 Restrict：必须从叶子到根逐层删除。
      const existingStages = await tx.pcStage.findMany({
        where: { courseKey },
        select: { stageKey: true, orderKey: true },
      });
      const deleteOrder = [...existingStages].sort(
        (left, right) =>
          depthOfOrderKey(right.orderKey) - depthOfOrderKey(left.orderKey),
      );
      for (const row of deleteOrder) {
        await tx.pcStage.delete({ where: { stageKey: row.stageKey } });
      }

      // 2) 删除该版本的 rendition 集合后重建（内容身份 = 稳定键）。
      const incomingContentKeys = [
        ...new Set(version.renditions.map((rendition) => rendition.contentKey)),
      ];
      if (incomingContentKeys.length > 0) {
        await tx.pcRendition.deleteMany({
          where: { contentKey: { in: incomingContentKeys } },
        });
      }

      // 3) 重建阶段树（父先于子）与先修 DAG。
      const orderedStages = [...version.stages].sort(
        (left, right) =>
          depthOfOrderKey(left.orderKey) - depthOfOrderKey(right.orderKey) ||
          (left.orderKey < right.orderKey ? -1 : 1),
      );
      for (const stage of orderedStages) {
        await tx.pcStage.create({
          data: {
            stageKey: stage.stageKey,
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
          },
        });
      }
      for (const edge of version.prerequisiteEdges) {
        await tx.pcPrerequisiteEdge.create({
          data: {
            fromStageKey: edge.fromStageKey,
            toStageKey: edge.toStageKey,
            kind: edge.kind,
          },
        });
      }

      // 4) 证据规格（按 key+version 幂等；历史版本保留）。
      for (const spec of version.evidenceSpecs) {
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

      // 5) 重建 rendition（坐标/时间源/版本/revision 原样）。
      for (const rendition of version.renditions) {
        await tx.pcRendition.create({
          data: {
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
          },
        });
      }

      // 6) 重建冻结的 verified 对齐。DB 触发器要求非 human 创建时先为
      //    proposed；先插入后更新为 verified（审计元组原样）。
      for (const alignment of version.alignments) {
        await tx.pcAlignment.create({
          data: {
            alignmentId: alignment.alignmentId,
            stageKey: alignment.stageKey,
            renditionKey: alignment.renditionKey,
            objectiveKey: alignment.objectiveKey,
            role: alignment.role,
            status: 'proposed',
            provenance: alignment.provenance,
            sourceKind: alignment.sourceKind ?? null,
            sourceArtifact: alignment.sourceArtifact ?? null,
            modelVersion: alignment.modelVersion ?? null,
            params:
              alignment.params === undefined
                ? Prisma.DbNull
                : jsonValue(alignment.params),
            ruleVersion: alignment.ruleVersion ?? null,
            confidence: alignment.confidence ?? null,
          },
        });
        if (alignment.status === 'verified') {
          await tx.pcAlignment.update({
            where: { alignmentId: alignment.alignmentId },
            data: {
              status: 'verified',
              verifiedBy: alignment.verifiedBy ?? null,
              verifiedAt:
                alignment.verifiedAt === undefined
                  ? null
                  : new Date(alignment.verifiedAt),
              verifiedAgainst:
                alignment.verifiedAgainst === undefined
                  ? Prisma.DbNull
                  : jsonValue(alignment.verifiedAgainst),
            },
          });
        } else if (alignment.status === 'rejected') {
          await tx.pcAlignment.update({
            where: { alignmentId: alignment.alignmentId },
            data: { status: 'rejected' },
          });
        }
      }

      // 7) 分类路径回到该版本；结构/对齐集计数器 +1（单调，不比较哈希）。
      await tx.pcCourse.update({
        where: { courseKey },
        data: {
          categoryPath:
            version.categoryPath === null
              ? Prisma.DbNull
              : jsonValue(version.categoryPath),
          structureRevision: { increment: 1 },
          alignmentSetVersion: { increment: 1 },
        },
      });
    });

    return { restored: true, version };
  }

  /** 事务端口实现（apply/publish 门）：全部读取与写入都在同一事务内。 */
  asApplyPort(): PlanApplyPort {
    return {
      runInTransaction: <T>(
        work: (transaction: PlanApplyTransaction) => Promise<T>,
      ): Promise<T> =>
        // Serializable：apply 门在事务内读「最新决定」并据此写入；ReadCommitted
        // 下并发的 rejected 决定可能在检查之后提交，导致旧 approved 仍被写。
        this.prisma.$transaction(
          async (tx) =>
            work({
              findPlan: async (input) =>
                this.findPlanIn(tx, input.planId, input.planVersion),
              findLatestApproval: async (input) =>
                this.findLatestApprovalIn(tx, input.planId, input.planVersion),
              loadPlanInput: async (closure) =>
                this.loadSourceIn(tx, closure.courseKey),
              findContentVersion: async (input) =>
                this.findContentVersionIn(tx, input.courseKey, input.versionNo),
              insertContentVersion: async (version) =>
                this.insertContentVersionIn(tx, version),
              setLiveContentVersion: async (pointer) =>
                this.setLiveContentVersionIn(tx, pointer),
            }),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
    };
  }
}
