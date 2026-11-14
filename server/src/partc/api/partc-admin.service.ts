import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { z } from 'zod';

import {
  EVIDENCE_KINDS,
  EVIDENCE_SCORINGS,
  ALIGNMENT_ROLES,
  EvidenceMeasureSchema,
  EvidenceSpecSchema,
  ExitRollupSchema,
  PLAN_ID_PATTERN,
  PlanApprovalSchema,
  PrerequisiteEdgeSchema,
  STAGE_KINDS,
  STAGE_STATUSES,
  StageSchema,
  VerifiedAgainstSchema,
  canonicalJson,
  type Alignment,
  type EvidenceSpec,
  type PlanRecord,
  type PlanWarning,
  type PrerequisiteEdge,
  type Stage,
} from '../contracts';
import type { SourceEnv } from '../contracts/environment';
import {
  PlanApplyError,
  applyApprovedPlan,
  type ApplyResult,
} from '../compiler/apply';
import { compilePlan, type CompilePlanResult } from '../compiler/plan';
import { detectUnsupportedOrdering } from '../compiler/parse';
import {
  PART_C_ERROR_DEFINITIONS,
  PartCError,
  isPartCError,
  partCEnvironmentErrorHttpStatus,
  partCErrorHttpStatus,
  type PartCEnvironmentErrorCode,
  type PartCErrorCode,
} from '../errors';
import {
  COMMERCE_CONFIG,
  type CommerceCourseConfig,
} from '../../commerce-courses/commerce.config';
import {
  PART_C_SINGLE_TARGET_ID,
  PartcAdminRepository,
  type StageTreeView,
} from './partc-admin.repository';

/**
 * Part C 管理端服务（评审阻断 4-API；设计 §14 C0/C5 P5–P6/C9 步骤 5/C10）。
 *
 * - StageTree 编辑（意图域）：服务端生成 orderKey（C3 程序生成），校验
 *   STR-1（交付叶 objectiveKeys/exitEvidence 非空、容器 exitEvidence 为空、
 *   kind 层级严格加深）与 exitEvidence 可解析；choice 容器 v1 一律拒绝
 *   （UNSUPPORTED_ORDERING，复用 parse 的同一扫描器）。
 * - 计划生命周期：preview（纯计算 + 返回 canonical JSON）→ save（客户端回传
 *   bytes，服务端按当前 DB 重算并字节相等才落 PcPlan）→ approve（写
 *   PcPlanApproval；-approved 时 status=approved）→ apply/publish（apply 门在
 *   apply.ts，事务内读 DB plan/最新决定并重算）。
 * - EvidenceSpec 管理：按 (evidenceKey, version) 版本化，version 服务端生成。
 * - 错误码：PartC 管线的冻结码表原样返回（HTTP 状态按 errors.ts 映射）；
 *   apply 的 PlanApplyError refusal code 也是契约词表（PLAN_NOT_APPROVED 等）。
 *
 * 能力/会话：控制器沿用员工会话（全局 BackofficeAccessGuard）与
 * CourseCapabilityGuard（ENV_CAPABILITY_ENFORCEMENT 默认 off）。
 */

const StageWriteSchema = z.strictObject({
  stageKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  parentStageKey: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
    .nullable()
    .default(null),
  kind: z.enum(STAGE_KINDS),
  goal: z.string().min(1),
  objectiveKeys: z.array(
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  ),
  exitEvidence: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)),
  exitRollup: ExitRollupSchema.optional(),
  durationBudget: z.number().int().nonnegative().optional(),
  status: z.enum(STAGE_STATUSES).optional(),
});

const PrerequisiteEdgeWriteSchema = z.strictObject({
  fromStageKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  toStageKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  kind: z.enum(['requires', 'recommends']),
});

const StageTreeWriteSchema = z.strictObject({
  stages: z.array(StageWriteSchema).min(1),
  prerequisiteEdges: z.array(PrerequisiteEdgeWriteSchema).default([]),
});

const EvidenceSpecWriteSchema = z.strictObject({
  kind: z.enum(EVIDENCE_KINDS),
  objectiveKeys: z
    .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/))
    .min(1),
  measure: EvidenceMeasureSchema,
  scoring: z.enum(EVIDENCE_SCORINGS),
  threshold: z.number().nonnegative(),
  attempts: z.number().int().positive(),
});

/** P8 restore：按内容版本 id 或本环境 versionNo 指定要恢复的冻结版本。 */
const RestoreBodySchema = z
  .strictObject({
    contentVersionId: z.string().uuid().optional(),
    versionNo: z.number().int().positive().optional(),
  })
  .refine(
    (value) =>
      (value.contentVersionId === undefined) !==
      (value.versionNo === undefined),
    { message: 'exactly one of contentVersionId / versionNo is required' },
  );

const PlanIdentityBodySchema = z.strictObject({
  planId: z.string().regex(PLAN_ID_PATTERN, 'malformed planId'),
  planVersion: z.number().int().positive(),
});

const PlanSaveBodySchema = PlanIdentityBodySchema.extend({
  canonicalJson: z.string().min(2),
});

/** 人签收（C3/C4 ALN-2）：只允许 proposed → verified | rejected。 */
const AlignmentSignOffBodySchema = z.strictObject({
  decision: z.enum(['verified', 'rejected']),
  /**
   * 客户端观察到的粘合元组（可选）。服务端按当前 DB 重算；不等即
   * ALIGNMENT_STALE（与 plan save 的字节相等检查同一模式）。
   */
  verifiedAgainst: VerifiedAgainstSchema.optional(),
});

/**
 * 显式 stage ↔ rendition ↔ objective 绑定（D 缺陷：全新课程包不猜绑定）。
 * 人指定四个稳定键与 role；写入 status=proposed，随后仍走人签收。
 */
const AlignmentCreateBodySchema = z.strictObject({
  stageKey: z.string().min(1).max(255),
  renditionKey: z.string().min(1).max(255),
  objectiveKey: z.string().min(1).max(255),
  role: z.enum(ALIGNMENT_ROLES),
});

const PlanApprovalBodySchema = PlanIdentityBodySchema.extend({
  decision: z.enum(['approved', 'rejected']),
  acceptedWarnings: z
    .array(
      z.strictObject({
        code: z.enum(['PREREQUISITE_RECOMMENDS', 'DEGRADED_PLACEMENT']),
        stageKey: z.string().optional(),
        alignmentId: z.string().optional(),
        entryId: z.string().optional(),
      }),
    )
    .default([]),
});

type StageWriteBody = z.infer<typeof StageWriteSchema>;

/** 阶段 kind 的深度序（STR-1：子必须严格深于父）。 */
const STAGE_KIND_DEPTH: Readonly<Record<Stage['kind'], number>> = {
  program: 1,
  phase: 2,
  stage: 3,
  step: 4,
};

export interface PlanView {
  readonly planId: string;
  readonly planVersion: number;
  readonly contentVersionId: string;
  readonly targetId: string;
  readonly status: PlanRecord['status'];
  readonly canonicalJson: string;
  readonly entries: CompilePlanResult['entries'];
  readonly warnings: readonly PlanWarning[];
  readonly gates: CompilePlanResult['gates'];
  readonly gaps: CompilePlanResult['gaps'];
  readonly issues: CompilePlanResult['issues'];
}

function padSegment(value: number): string {
  return String(value).padStart(6, '0');
}

/**
 * orderKey 程序生成（C3）：兄弟顺序 = 请求数组顺序；root 为 `000001`，
 * 子级沿父路径追加一段（`000001.000002`）。客户端不提供 orderKey。
 */
export function generateOrderKeys(
  stages: readonly StageWriteBody[],
): Map<string, string> {
  const siblingsByParent = new Map<string | null, string[]>();
  for (const stage of stages) {
    const siblings = siblingsByParent.get(stage.parentStageKey) ?? [];
    siblings.push(stage.stageKey);
    siblingsByParent.set(stage.parentStageKey, siblings);
  }
  const orderKeys = new Map<string, string>();
  const assign = (parentKey: string | null, prefix: string): void => {
    for (const [index, stageKey] of (
      siblingsByParent.get(parentKey) ?? []
    ).entries()) {
      const segment = padSegment(index + 1);
      const orderKey = prefix === '' ? segment : `${prefix}.${segment}`;
      orderKeys.set(stageKey, orderKey);
      assign(stageKey, orderKey);
    }
  };
  assign(null, '');
  return orderKeys;
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new UnprocessableEntityException({
      code: 'VALIDATION_ERROR',
      message: parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    });
  }
  return parsed.data;
}

function parsePlanIdentity(
  planId: string,
  planVersion: number,
): {
  courseKey: string;
  contentVersionId: string;
  targetId: string;
} {
  const segments = planId.split('/');
  const versionSegment = segments.at(-1) ?? '';
  if (
    segments.length !== 5 ||
    segments[0] !== 'plan' ||
    versionSegment !== `v${planVersion}`
  ) {
    throw new UnprocessableEntityException({
      code: 'VALIDATION_ERROR',
      message: 'planId does not match planVersion',
    });
  }
  return {
    courseKey: segments[1],
    contentVersionId: segments[2],
    targetId: segments[3],
  };
}

function compareWarnings(left: PlanWarning, right: PlanWarning): number {
  const leftKey = canonicalJson(left);
  const rightKey = canonicalJson(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function sameWarnings(
  left: readonly PlanWarning[],
  right: readonly PlanWarning[],
): boolean {
  return (
    canonicalJson([...left].sort(compareWarnings)) ===
    canonicalJson([...right].sort(compareWarnings))
  );
}

@Injectable()
export class PartcAdminService {
  constructor(
    private readonly repository: PartcAdminRepository,
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {}

  /** C10.7 环境由服务端配置判定，不信任客户端声明。 */
  private get sourceEnvironment(): SourceEnv {
    return this.config.versionNumberingMode === 'production'
      ? 'production'
      : 'sandbox';
  }

  // -------------------------------------------------------------------------
  // 错误映射（PartC 冻结码表 → HTTP）
  // -------------------------------------------------------------------------

  private rethrow(error: unknown): never {
    if (isPartCError(error)) {
      const status =
        error.code in PART_C_ERROR_DEFINITIONS
          ? partCErrorHttpStatus(error.code as PartCErrorCode)
          : partCEnvironmentErrorHttpStatus(
              error.code as PartCEnvironmentErrorCode,
            );
      throw new HttpException(
        { code: error.code, message: error.message, details: error.details },
        status,
      );
    }
    if (error instanceof PlanApplyError) {
      throw new HttpException(
        {
          code: error.refusals[0]?.code ?? 'PLAN_NOT_APPROVED',
          message: error.message,
          details: error.refusals,
        },
        409,
      );
    }
    throw error;
  }

  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      this.rethrow(error);
    }
  }

  private async assertCourse(courseKey: string): Promise<void> {
    if (!(await this.repository.courseExists(courseKey))) {
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Part C course not found',
      });
    }
  }

  // -------------------------------------------------------------------------
  // StageTree（意图域）
  // -------------------------------------------------------------------------

  async getStageTree(courseKey: string): Promise<StageTreeView> {
    await this.assertCourse(courseKey);
    return this.repository.loadStageTree(courseKey);
  }

  /**
   * 编辑整棵阶段树（原子替换）。orderKey 由服务端按数组顺序生成；
   * 校验：choice 拒绝 → schema → 父存在/kind 层级 → 叶/容器证据规则 →
   * exitEvidence 可解析（最新 EvidenceSpec）→ 边端点/重复。
   */
  async replaceStageTree(
    courseKey: string,
    rawBody: unknown,
  ): Promise<StageTreeView> {
    await this.assertCourse(courseKey);
    return this.run(() => this.replaceStageTreeChecked(courseKey, rawBody));
  }

  private async replaceStageTreeChecked(
    courseKey: string,
    rawBody: unknown,
  ): Promise<StageTreeView> {
    const choicePaths = detectUnsupportedOrdering({ content: rawBody });
    if (choicePaths.length > 0) {
      throw new PartCError(
        'UNSUPPORTED_ORDERING',
        'v1 does not support choice containers in the stage tree',
        { choicePaths },
      );
    }
    const body = parseOrThrow(StageTreeWriteSchema, rawBody);

    const byKey = new Map<string, StageWriteBody>();
    for (const stage of body.stages) {
      if (byKey.has(stage.stageKey)) {
        throw new UnprocessableEntityException({
          code: 'VALIDATION_ERROR',
          message: `duplicate stageKey ${stage.stageKey}`,
        });
      }
      byKey.set(stage.stageKey, stage);
    }
    for (const stage of body.stages) {
      if (stage.parentStageKey !== null && !byKey.has(stage.parentStageKey)) {
        throw new UnprocessableEntityException({
          code: 'VALIDATION_ERROR',
          message: `parentStageKey ${stage.parentStageKey} of ${stage.stageKey} does not exist`,
        });
      }
      if (stage.parentStageKey === stage.stageKey) {
        throw new UnprocessableEntityException({
          code: 'VALIDATION_ERROR',
          message: `stage ${stage.stageKey} must not be its own parent`,
        });
      }
      const parent =
        stage.parentStageKey === null
          ? undefined
          : byKey.get(stage.parentStageKey);
      if (
        parent !== undefined &&
        STAGE_KIND_DEPTH[stage.kind] <= STAGE_KIND_DEPTH[parent.kind]
      ) {
        throw new UnprocessableEntityException({
          code: 'VALIDATION_ERROR',
          message: `stage kind '${stage.kind}' must be strictly deeper than its parent kind '${parent.kind}'`,
        });
      }
    }

    // STR-1：交付叶（无子节点）objectiveKeys/exitEvidence 非空；
    // 容器 exitEvidence 必须为空；atLeast(n) 不得超过证据数。
    const childParents = new Set(
      body.stages
        .map((stage) => stage.parentStageKey)
        .filter((parent): parent is string => parent !== null),
    );
    const latestEvidence = await this.repository.listLatestEvidenceSpecs();
    const evidenceKeys = new Set(
      latestEvidence.map((spec) => spec.evidenceKey),
    );
    for (const stage of body.stages) {
      const isLeaf = !childParents.has(stage.stageKey);
      if (isLeaf) {
        if (stage.objectiveKeys.length === 0) {
          throw new UnprocessableEntityException({
            code: 'VALIDATION_ERROR',
            message: `delivery leaf ${stage.stageKey} must declare objectiveKeys`,
          });
        }
        if (stage.exitEvidence.length === 0) {
          throw new UnprocessableEntityException({
            code: 'VALIDATION_ERROR',
            message: `delivery leaf ${stage.stageKey} must declare exitEvidence`,
          });
        }
        if (
          stage.exitRollup?.kind === 'atLeast' &&
          stage.exitRollup.n > stage.exitEvidence.length
        ) {
          throw new UnprocessableEntityException({
            code: 'VALIDATION_ERROR',
            message: `stage ${stage.stageKey} exitRollup.atLeast(${stage.exitRollup.n}) exceeds its exitEvidence count`,
          });
        }
      } else if (stage.exitEvidence.length > 0) {
        throw new UnprocessableEntityException({
          code: 'VALIDATION_ERROR',
          message: `container stage ${stage.stageKey} must not declare exitEvidence`,
        });
      }
      for (const evidenceKey of stage.exitEvidence) {
        if (!evidenceKeys.has(evidenceKey)) {
          throw new UnprocessableEntityException({
            code: 'VALIDATION_ERROR',
            message: `stage ${stage.stageKey} exitEvidence '${evidenceKey}' has no EvidenceSpec`,
          });
        }
      }
    }

    const orderKeys = generateOrderKeys(body.stages);
    const stages: Stage[] = body.stages.map((stage) =>
      StageSchema.parse({
        courseKey,
        stageKey: stage.stageKey,
        parentStageKey: stage.parentStageKey,
        orderKey: orderKeys.get(stage.stageKey),
        kind: stage.kind,
        goal: stage.goal,
        objectiveKeys: [...stage.objectiveKeys],
        exitEvidence: [...stage.exitEvidence],
        exitRollup: stage.exitRollup ?? { kind: 'all' },
        ...(stage.durationBudget === undefined
          ? {}
          : { durationBudget: stage.durationBudget }),
        status: stage.status ?? 'active',
      }),
    );

    const edgeKeys = new Set<string>();
    const edges: PrerequisiteEdge[] = body.prerequisiteEdges.map((edge) => {
      if (!byKey.has(edge.fromStageKey) || !byKey.has(edge.toStageKey)) {
        throw new UnprocessableEntityException({
          code: 'VALIDATION_ERROR',
          message: `prerequisite edge ${edge.fromStageKey} -> ${edge.toStageKey} references an unknown stage`,
        });
      }
      const key = `${edge.fromStageKey}\u0000${edge.toStageKey}\u0000${edge.kind}`;
      if (edgeKeys.has(key)) {
        throw new UnprocessableEntityException({
          code: 'VALIDATION_ERROR',
          message: `duplicate prerequisite edge ${edge.fromStageKey} -> ${edge.toStageKey} (${edge.kind})`,
        });
      }
      edgeKeys.add(key);
      return PrerequisiteEdgeSchema.parse(edge);
    });

    return this.repository.replaceStageTree(courseKey, stages, edges);
  }

  // -------------------------------------------------------------------------
  // EvidenceSpec（版本化；version 服务端生成）
  // -------------------------------------------------------------------------

  async listEvidenceSpecs(): Promise<EvidenceSpec[]> {
    return this.repository.listLatestEvidenceSpecs();
  }

  async putEvidenceSpec(
    courseKey: string,
    evidenceKey: string,
    rawBody: unknown,
  ): Promise<EvidenceSpec> {
    await this.assertCourse(courseKey);
    const body = parseOrThrow(EvidenceSpecWriteSchema, rawBody);
    const version = await this.repository.nextEvidenceSpecVersion(evidenceKey);
    const spec = EvidenceSpecSchema.parse({
      ...body,
      evidenceKey,
      version,
    });
    return this.repository.insertEvidenceSpec(spec);
  }

  // -------------------------------------------------------------------------
  // Alignment 人签收（proposed → verified/rejected；C3/C4 ALN-2/C10.4）
  // -------------------------------------------------------------------------

  async listAlignments(courseKey: string): Promise<Alignment[]> {
    await this.assertCourse(courseKey);
    return this.repository.listAlignments(courseKey);
  }

  /**
   * 显式创建 proposed 对齐（D 缺陷：不入猜绑定）。
   *
   * 全新课程包的模板/资产不携带 stage ↔ 内容语义，机器不猜（align-rules-v1）；
   * 人通过本 API 显式给出 `stageKey + renditionKey + objectiveKey + role`，写入
   * status=proposed / provenance=human，随后必须走既有 sign-off 人签收。
   * 校验与冲突规则见 repository.createProposedAlignment。
   */
  async createProposedAlignment(
    courseKey: string,
    rawBody: unknown,
  ): Promise<Alignment> {
    await this.assertCourse(courseKey);
    const body = parseOrThrow(AlignmentCreateBodySchema, rawBody);
    return this.run(() =>
      this.repository.createProposedAlignment({
        courseKey,
        stageKey: body.stageKey,
        renditionKey: body.renditionKey,
        objectiveKey: body.objectiveKey,
        role: body.role,
      }),
    );
  }

  /**
   * 人签收：导入/派生得到的 proposed 对齐经本 API 转为 verified（人或复核者
   * 签收，C0 红线⑭）或 rejected。verifiedAgainst 由服务端真源派生；
   * verifiedBy 取会话员工身份。compilePlan/freeze 只消费 verified（ALN-2），
   * 因此签收后必须重新 preview/approve（alignmentSetVersion 已 +1）。
   */
  async signOffAlignment(
    courseKey: string,
    alignmentId: string,
    rawBody: unknown,
    actorEmployeeId: string | null,
  ): Promise<Alignment> {
    await this.assertCourse(courseKey);
    const body = parseOrThrow(AlignmentSignOffBodySchema, rawBody);
    return this.run(() =>
      this.repository.signOffAlignment({
        courseKey,
        alignmentId,
        decision: body.decision,
        actor: actorEmployeeId ?? 'unknown-employee',
        at: new Date(),
        ...(body.verifiedAgainst === undefined
          ? {}
          : { expectedVerifiedAgainst: body.verifiedAgainst }),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Plan 生命周期：preview → save → approve → apply/publish
  // -------------------------------------------------------------------------

  private async compileFromDb(input: {
    courseKey: string;
    contentVersionId: string;
    planVersion: number;
    targetId: string;
  }): Promise<{
    result: CompilePlanResult;
    snapshot: Awaited<ReturnType<PartcAdminRepository['loadSource']>>;
  }> {
    const snapshot = await this.repository.loadSource(input.courseKey);
    const result = compilePlan({
      content: snapshot.source,
      target: {
        targetId: input.targetId,
        languages: [...snapshot.target.languages],
        modalities: [...snapshot.target.modalities],
      },
      contentVersionId: input.contentVersionId,
      planVersion: input.planVersion,
      structureRevision: this.repository.structureRevisionOf(snapshot),
      alignmentSetVersion: this.repository.alignmentSetVersionOf(snapshot),
      mediaAssets: snapshot.mediaAssets,
      timingSources: snapshot.timingSources,
      resolvedChoices: [],
    });
    return { result, snapshot };
  }

  private planView(
    result: CompilePlanResult,
    statusOverride?: PlanRecord['status'],
  ): PlanView {
    return {
      planId: result.body.planId,
      planVersion: result.body.planVersion,
      contentVersionId: result.body.contentVersionId,
      targetId: result.body.targetId,
      status: statusOverride ?? result.status,
      canonicalJson: result.bytes,
      entries: result.body.entries,
      warnings: result.body.warnings,
      gates: result.gates,
      gaps: result.gaps,
      issues: result.issues,
    };
  }

  /**
   * preview：不落库；返回 canonical bytes 供客户端在 save 时回传。
   * planVersion 单调（同一 courseKey/contentVersionId/targetId 内 +1）；
   * contentVersionId = 下一个本地版本（`cv-{courseKey}-v{n}`，显式派生无摘要）。
   */
  async previewPlan(courseKey: string): Promise<PlanView> {
    await this.assertCourse(courseKey);
    return this.run(async () => {
      const identity =
        await this.repository.nextContentVersionIdentity(courseKey);
      const planVersion =
        (await this.repository.maxPlanVersion(
          courseKey,
          identity.contentVersionId,
          PART_C_SINGLE_TARGET_ID,
        )) + 1;
      const { result } = await this.compileFromDb({
        courseKey,
        contentVersionId: identity.contentVersionId,
        planVersion,
        targetId: PART_C_SINGLE_TARGET_ID,
      });
      return this.planView(result);
    });
  }

  /**
   * save：客户端携带 preview 的 (planId, planVersion, canonicalJson)；
   * 服务端按当前 DB 用同一 compilePlan 重算，canonical bytes 不等 ⇒
   * PLAN_PREVIEW_STALE（C5 P6）。bytes 相等才写 PcPlan（status 外置）。
   */
  async savePlan(courseKey: string, rawBody: unknown): Promise<PlanView> {
    await this.assertCourse(courseKey);
    const body = parseOrThrow(PlanSaveBodySchema, rawBody);
    const identity = parsePlanIdentity(body.planId, body.planVersion);
    if (identity.courseKey !== courseKey) {
      throw new UnprocessableEntityException({
        code: 'VALIDATION_ERROR',
        message: 'planId belongs to another course',
      });
    }
    return this.run(async () => {
      const { result } = await this.compileFromDb({
        courseKey,
        contentVersionId: identity.contentVersionId,
        planVersion: body.planVersion,
        targetId: identity.targetId,
      });
      if (result.bytes !== body.canonicalJson) {
        throw new PartCError(
          'PLAN_PREVIEW_STALE',
          'plan preview is stale: recompile and preview again before saving',
          {
            planId: result.body.planId,
            planVersion: result.body.planVersion,
            bytesEqual: false,
          },
        );
      }
      const existing = await this.repository.findPlan(
        body.planId,
        body.planVersion,
      );
      if (existing !== null) {
        if (existing.canonicalJson !== result.bytes) {
          throw new PartCError(
            'PLAN_PREVIEW_STALE',
            'saved plan bytes differ from the recomputed plan; preview again',
            { planId: body.planId, planVersion: body.planVersion },
          );
        }
        return this.planView(result, existing.record.status);
      }
      await this.repository.insertPlanRecord({
        planId: result.body.planId,
        courseKey,
        contentVersionId: result.body.contentVersionId,
        targetId: result.body.targetId,
        planVersion: result.body.planVersion,
        inputClosure: result.body.inputClosure,
        canonicalJson: result.bytes,
        status: result.status,
        compilerVersion: result.body.compilerVersion,
        ruleVersion: result.body.ruleVersion,
      });
      return this.planView(result);
    });
  }

  /**
   * approve/reject：写 PcPlanApproval（绑定 planId+planVersion）；approved 时
   * plan.status=approved，rejected 时回到 draft。blocked 的 plan 不可批准。
   * acceptedWarnings 必须与 plan.warnings 结构化相等（G4）。
   */
  async approvePlan(
    courseKey: string,
    rawBody: unknown,
    actorEmployeeId: string | null,
  ): Promise<{
    planId: string;
    planVersion: number;
    decision: 'approved' | 'rejected';
    status: PlanRecord['status'];
  }> {
    await this.assertCourse(courseKey);
    const body = parseOrThrow(PlanApprovalBodySchema, rawBody);
    const identity = parsePlanIdentity(body.planId, body.planVersion);
    if (identity.courseKey !== courseKey) {
      throw new UnprocessableEntityException({
        code: 'VALIDATION_ERROR',
        message: 'planId belongs to another course',
      });
    }
    return this.run(async () => {
      const stored = await this.repository.findPlan(
        body.planId,
        body.planVersion,
      );
      if (stored === null) {
        throw new NotFoundException({
          code: 'PLAN_NOT_FOUND',
          message: 'plan is not saved; preview and save it before approving',
        });
      }
      if (stored.record.status === 'blocked') {
        throw new ConflictException({
          code: 'PLAN_NOT_APPROVED',
          message: 'a blocked plan cannot be approved',
        });
      }
      if (
        body.decision === 'approved' &&
        !sameWarnings(body.acceptedWarnings, stored.record.warnings)
      ) {
        throw new ConflictException({
          code: 'PLAN_WARNINGS_NOT_ACCEPTED',
          message:
            'acceptedWarnings must explicitly match the plan warnings (structured equality)',
        });
      }
      const approval = parseOrThrow(PlanApprovalSchema, {
        planId: body.planId,
        planVersion: body.planVersion,
        decision: body.decision,
        approvedBy: actorEmployeeId ?? 'unknown-employee',
        approvedAt: new Date().toISOString(),
        acceptedWarnings: body.acceptedWarnings,
      });
      await this.repository.insertApproval(approval);
      const status: PlanRecord['status'] =
        body.decision === 'approved' ? 'approved' : 'draft';
      await this.repository.updatePlanStatus(
        body.planId,
        body.planVersion,
        status,
      );
      return {
        planId: body.planId,
        planVersion: body.planVersion,
        decision: body.decision,
        status,
      };
    });
  }

  /**
   * apply/publish：门在 apply.ts（事务内读 DB plan + 最新决定、同一 inputClosure
   * 重算、冻结内容由同一 source 派生）。重复 apply 幂等（already-applied）；
   * 最新决定为 rejected 时即使之前 approved 也会被拒。
   */
  async applyPlan(courseKey: string, rawBody: unknown): Promise<ApplyResult> {
    await this.assertCourse(courseKey);
    const body = parseOrThrow(PlanIdentityBodySchema, rawBody);
    const identity = parsePlanIdentity(body.planId, body.planVersion);
    if (identity.courseKey !== courseKey) {
      throw new UnprocessableEntityException({
        code: 'VALIDATION_ERROR',
        message: 'planId belongs to another course',
      });
    }
    return this.run(async () => {
      const stored = await this.repository.findPlan(
        body.planId,
        body.planVersion,
      );
      if (stored === null) {
        throw new NotFoundException({
          code: 'PLAN_NOT_FOUND',
          message: 'plan is not saved; preview and save it before applying',
        });
      }
      const existing = await this.repository.findContentVersionByPin(
        body.planId,
        body.planVersion,
      );
      let versionNo: number;
      let contentVersionId: string;
      if (existing !== null) {
        versionNo = existing.versionNo;
        contentVersionId = existing.contentVersionId;
      } else {
        const next =
          await this.repository.nextContentVersionIdentity(courseKey);
        if (next.contentVersionId !== stored.record.contentVersionId) {
          throw new PartCError(
            'PLAN_INPUT_CHANGED',
            'a new content version was published after this plan was previewed; preview and approve again',
            {
              planContentVersionId: stored.record.contentVersionId,
              currentContentVersionId: next.contentVersionId,
            },
          );
        }
        versionNo = next.versionNo;
        contentVersionId = next.contentVersionId;
      }
      // C10.3：sourceLabel 取包 provenance.sourceVersionLabel（导入时落到
      // CommerceCourse.draftSourceVersionLabel）；无来源标签时不写，绝不伪造。
      const sourceLabel =
        await this.repository.findDraftSourceVersionLabel(courseKey);
      return applyApprovedPlan(
        {
          planId: body.planId,
          planVersion: body.planVersion,
          versionNo,
          contentVersionId,
          frozenAt: new Date().toISOString(),
          sourceEnv: this.sourceEnvironment,
          ...(sourceLabel === null ? {} : { sourceLabel }),
        },
        this.repository.asApplyPort(),
      );
    });
  }

  /** publish = apply + live 指针（本阶段 live = 最高 versionNo，见仓库注释）。 */
  async publishPlan(courseKey: string, rawBody: unknown): Promise<ApplyResult> {
    return this.applyPlan(courseKey, rawBody);
  }

  /** 只读：某课程已发布的 Part C 内容版本（按 versionNo 升序）。 */
  async listContentVersions(courseKey: string) {
    await this.assertCourse(courseKey);
    return this.repository.findAllContentVersions(courseKey);
  }

  // -------------------------------------------------------------------------
  // P8 Restore + 可观察面（E）
  // -------------------------------------------------------------------------

  /**
   * P8 Restore：按冻结版本 pins 重建草稿（stage/edge/rendition/alignment/
   * evidence/分类）。缺分类 CATEGORY_NOT_FOUND、缺资产 ASSET_NOT_FOUND；
   * 两者都在写入前失败，草稿保持不变。
   */
  async restoreContentVersion(courseKey: string, rawBody: unknown) {
    await this.assertCourse(courseKey);
    const body = parseOrThrow(RestoreBodySchema, rawBody);
    return this.run(async () => {
      const version =
        body.contentVersionId !== undefined
          ? await this.repository.findContentVersionById(
              courseKey,
              body.contentVersionId,
            )
          : await this.repository.findContentVersionByNo(
              courseKey,
              body.versionNo as number,
            );
      if (version === null) {
        throw new NotFoundException({
          code: 'CONTENT_VERSION_NOT_FOUND',
          message: 'content version not found for this course',
        });
      }
      return this.repository.restoreContentVersion(courseKey, version);
    });
  }

  async listPublications(courseKey: string) {
    await this.assertCourse(courseKey);
    return this.repository.listPublications(courseKey);
  }

  /** live 指针：当前有效发布记录 + 其内容版本（无发布时两者 null）。 */
  async livePublication(courseKey: string) {
    await this.assertCourse(courseKey);
    return this.repository.readLivePointer(courseKey);
  }

  async listContentSpecs(courseKey: string) {
    await this.assertCourse(courseKey);
    return this.repository.listContentSpecs(courseKey);
  }

  async listRenditions(courseKey: string) {
    await this.assertCourse(courseKey);
    return this.repository.listRenditions(courseKey);
  }

  async listMediaAssets(courseKey: string) {
    await this.assertCourse(courseKey);
    return this.repository.listMediaAssets(courseKey);
  }
}
