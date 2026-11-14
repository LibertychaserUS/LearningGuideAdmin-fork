import {
  ContentVersionContentSchema,
  ContentVersionSchema,
  canonicalJson,
  planBodyBytes,
} from '../contracts';
import type {
  ContentVersion,
  ContentVersionContent,
  InputClosure,
  PlanApproval,
  PlanBody,
  PlanRecord,
  PlanWarning,
} from '../contracts';
import type { SourceEnv } from '../contracts/environment';
import type { DeliveryModality } from '../contracts';
import { PartCError } from '../errors';
import type { CompilePlanResult } from './plan';
import { compilePlan } from './plan';
import type {
  MediaAssetTimingInfo,
  PlanSource,
  RenditionTimingSourcePin,
} from './invariants';

/**
 * Part C 编译器 P6：save / apply / publish（设计 §14 C5 P6、C6、C4 G3–G5）。
 *
 * - save：客户端携带 preview 的 (planId, planVersion)，服务端用同一 compilePlan
 *   重算；canonical bytes 不等 ⇒ PLAN_PREVIEW_STALE（C6 冻结错误码，409）。
 *   比较用字节相等，不用任何摘要（C0 红线⑦）。
 * - apply/publish（评审阻断 8：门在服务端，不信任外部传入）：
 *   1. 事务内从 DB 读 Plan 记录与**最新** PlanApproval —— 外部传入的
 *      PlanRecord/Approval 一律不参与判定；后续 rejected 决定因此能阻断旧的
 *      approved（只看最新决定）。
 *   2. Plan 状态必须是 approved，最新决定必须是 approved，且绑定
 *      (planId, planVersion)、acceptedWarnings 与 plan.warnings 结构化相等。
 *   3. 用该 Plan 的 inputClosure 通过 `loadPlanInput` 从 DB 读同一内容源，
 *      以同一 compilePlan 重算；canonical bytes 与 DB 存的原文不等 ⇒
 *      PLAN_INPUT_CHANGED（pins 相同但 stage 树/entries 被替换也逃不掉，
 *      因为比较的是完整 canonical bytes，不是 pins 摘要）。
 *   4. 冻结 ContentVersion 的内容由**同一份** source 派生（不读外部 content），
 *      并校验 entries/stages 与该 source 的树、verified 对齐、rendition/placement
 *      坐标逐项一致；任何不一致 ⇒ FREEZE_CONTENT_MISMATCH。
 *   5. 随后在同一事务写 ContentVersion（含 planPin）与 live 指针（C5 P6）。
 * - 幂等：同一 (courseKey, versionNo) 已存在且内容（除审计时间 frozenAt 与环境
 *   局部 sourceEnv/sourceLabel 外）与 planPin 都相同 ⇒ already-applied，不再写
 *   live 指针（防止旧计划把线上指针拨回）。内容不同 ⇒ VERSION_CONFLICT，不覆盖。
 *
 * 本模块是纯决策 + 事务端口（PlanApplyPort）：DB/仓库层实现端口；编译器不触库、
 * 不读时钟（frozenAt 由薄壳以审计时间传入）。
 */

// ---------------------------------------------------------------------------
// save：preview 一致性（PLAN_PREVIEW_STALE）
// ---------------------------------------------------------------------------

export interface PlanPreviewSnapshot {
  readonly planId: string;
  readonly planVersion: number;
  /** preview 时服务端存下的 canonical bytes 原文。 */
  readonly bytes: string;
}

/**
 * save 携带的 preview 与当前重算结果必须字节相等；否则 PLAN_PREVIEW_STALE。
 * planId/planVersion 先比（显式身份），再比 canonical bytes（内容）。
 */
export function assertPlanPreviewCurrent(
  preview: PlanPreviewSnapshot,
  current: PlanBody,
): void {
  const currentBytes = planBodyBytes(current);
  if (
    preview.planId !== current.planId ||
    preview.planVersion !== current.planVersion ||
    preview.bytes !== currentBytes
  ) {
    throw new PartCError(
      'PLAN_PREVIEW_STALE',
      'plan preview is stale: recompile and preview again before saving',
      {
        previewPlanId: preview.planId,
        currentPlanId: current.planId,
        previewPlanVersion: preview.planVersion,
        currentPlanVersion: current.planVersion,
        bytesEqual: preview.bytes === currentBytes,
      },
    );
  }
}

/**
 * save：携带 preview 的 (planId, planVersion)，服务端用同一 compilePlan 重算；
 * 字节相等才允许保存草稿记录（C5 P6）。返回的 PlanRecord 的 status 外置
 * （draft/degraded/blocked），canonical bytes 与 preview 完全相同。
 */
export interface PlanSaveInput {
  readonly preview: PlanPreviewSnapshot;
  readonly recompiled: CompilePlanResult;
}

export interface PlanSaveResult {
  readonly record: PlanRecord;
  /** 与 preview.bytes 字节相等（本次重算的 canonical bytes）。 */
  readonly bytes: string;
}

export function savePlan(input: PlanSaveInput): PlanSaveResult {
  assertPlanPreviewCurrent(input.preview, input.recompiled.body);
  const record: PlanRecord = {
    ...input.recompiled.body,
    status: input.recompiled.status,
  };
  return { record, bytes: input.recompiled.bytes };
}

// ---------------------------------------------------------------------------
// apply：资格与冻结内容校验
// ---------------------------------------------------------------------------

export const PLAN_APPLY_REFUSAL_CODES = [
  'PLAN_NOT_APPROVED',
  'PLAN_APPROVAL_MISMATCH',
  'PLAN_WARNINGS_NOT_ACCEPTED',
  'PLAN_BLOCKED',
  'FREEZE_CONTENT_MISMATCH',
  'VERSION_CONFLICT',
] as const;
export type PlanApplyRefusalCode = (typeof PLAN_APPLY_REFUSAL_CODES)[number];

export interface PlanApplyRefusal {
  readonly code: PlanApplyRefusalCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export class PlanApplyError extends Error {
  readonly refusals: readonly PlanApplyRefusal[];

  constructor(refusals: readonly PlanApplyRefusal[]) {
    super(
      `plan apply refused: ${refusals.map((refusal) => refusal.code).join(', ')}`,
    );
    this.name = 'PlanApplyError';
    this.refusals = refusals;
  }
}

function compareWarnings(left: PlanWarning, right: PlanWarning): number {
  const leftKey = canonicalJson(left);
  const rightKey = canonicalJson(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function canonicalWarnings(warnings: readonly PlanWarning[]): string {
  return canonicalJson([...warnings].sort(compareWarnings));
}

/** 审批绑定：status=approved、planId/planVersion 一致、warnings 被显式接受（G4）。 */
export function checkApplyEligibility(
  plan: PlanRecord,
  approval: PlanApproval,
): readonly PlanApplyRefusal[] {
  const refusals: PlanApplyRefusal[] = [];
  if (plan.status !== 'approved') {
    refusals.push({
      code: 'PLAN_NOT_APPROVED',
      message: `plan status is '${plan.status}'; only approved plans may be applied`,
      details: { planId: plan.planId, status: plan.status },
    });
  }
  if (approval.decision !== 'approved') {
    refusals.push({
      code: 'PLAN_NOT_APPROVED',
      message: 'the latest approval decision is not approved',
      details: {
        planId: plan.planId,
        planVersion: plan.planVersion,
        decision: approval.decision,
      },
    });
  }
  if (
    approval.planId !== plan.planId ||
    approval.planVersion !== plan.planVersion
  ) {
    refusals.push({
      code: 'PLAN_APPROVAL_MISMATCH',
      message: 'approval does not bind the plan identity (planId, planVersion)',
      details: {
        planId: plan.planId,
        planVersion: plan.planVersion,
        approvalPlanId: approval.planId,
        approvalPlanVersion: approval.planVersion,
      },
    });
  }
  if (
    canonicalWarnings(approval.acceptedWarnings) !==
    canonicalWarnings(plan.warnings)
  ) {
    refusals.push({
      code: 'PLAN_WARNINGS_NOT_ACCEPTED',
      message:
        'acceptedWarnings must explicitly match the plan warnings (structured equality)',
      details: {
        planId: plan.planId,
        planVersion: plan.planVersion,
        warnings: plan.warnings,
        acceptedWarnings: approval.acceptedWarnings,
      },
    });
  }
  return refusals;
}

/**
 * 冻结内容必须与 inputClosure 同一（courseKey 与 spec/asset pins 原样一致，
 * C6「apply/publish 校验 inputClosure 重算一致」的内容侧），并且 plan 的每条
 * entry 必须落在冻结的 stage 树与 verified 对齐/rendition 坐标上。
 *
 * 评审阻断 8 的第二半：即使 pins 相同，stage 树/entries 被替换过的冻结内容
 * 也不得写入 —— 因此这里逐条校验 entry 的结构位置（stageKey、alignmentId、
 * placement 坐标）与冻结内容一致，而不是只比 pin 摘要。
 */
export function checkFreezeMatchesClosure(
  plan: PlanRecord,
  content: ContentVersionContent,
): readonly PlanApplyRefusal[] {
  const refusals: PlanApplyRefusal[] = [];
  if (content.courseKey !== plan.inputClosure.courseKey) {
    refusals.push({
      code: 'FREEZE_CONTENT_MISMATCH',
      message: 'frozen content courseKey does not match the plan inputClosure',
      details: {
        contentCourseKey: content.courseKey,
        closureCourseKey: plan.inputClosure.courseKey,
      },
    });
  }
  const normalizePinRecords = (
    pins: ReadonlyArray<Record<string, unknown>>,
    keyField: string,
    versionField: string,
  ): string =>
    canonicalJson(
      [...pins].sort((left, right) => {
        const leftKey = String(left[keyField]);
        const rightKey = String(right[keyField]);
        if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
        return Number(left[versionField]) - Number(right[versionField]);
      }),
    );
  const contentSpecPins = normalizePinRecords(
    content.specPins,
    'contentKey',
    'version',
  );
  const closureSpecPins = normalizePinRecords(
    plan.inputClosure.specPins,
    'contentKey',
    'version',
  );
  if (contentSpecPins !== closureSpecPins) {
    refusals.push({
      code: 'FREEZE_CONTENT_MISMATCH',
      message: 'frozen content specPins do not match the plan inputClosure',
    });
  }
  const contentAssetPins = normalizePinRecords(
    content.assetPins,
    'assetKey',
    'assetVersion',
  );
  const closureAssetPins = normalizePinRecords(
    plan.inputClosure.assetPins,
    'assetKey',
    'assetVersion',
  );
  if (contentAssetPins !== closureAssetPins) {
    refusals.push({
      code: 'FREEZE_CONTENT_MISMATCH',
      message: 'frozen content assetPins do not match the plan inputClosure',
    });
  }

  // entries/stages：每条 entry 必须属于冻结树，并指向冻结的 verified 对齐与
  // 同一 rendition 坐标（placement 是 rendition 坐标的物化副本）。
  const stageKeys = new Set(content.stages.map((stage) => stage.stageKey));
  const stagesWithChildren = new Set(
    content.stages
      .filter((stage) => stage.parentStageKey !== null)
      .map((stage) => stage.parentStageKey as string),
  );
  const entryStageKeys = new Set(plan.entries.map((entry) => entry.stageKey));
  for (const stage of content.stages) {
    const isDeliveryLeaf = !stagesWithChildren.has(stage.stageKey);
    if (isDeliveryLeaf && !entryStageKeys.has(stage.stageKey)) {
      refusals.push({
        code: 'FREEZE_CONTENT_MISMATCH',
        message: `delivery leaf ${stage.stageKey} has no plan entry in the approved plan`,
        details: { stageKey: stage.stageKey },
      });
    }
    if (!isDeliveryLeaf && entryStageKeys.has(stage.stageKey)) {
      refusals.push({
        code: 'FREEZE_CONTENT_MISMATCH',
        message: `container stage ${stage.stageKey} must not carry plan entries`,
        details: { stageKey: stage.stageKey },
      });
    }
  }
  const alignmentById = new Map(
    content.alignments.map((alignment) => [alignment.alignmentId, alignment]),
  );
  const renditionByKey = new Map(
    content.renditions.map((rendition) => [rendition.renditionKey, rendition]),
  );
  for (const entry of plan.entries) {
    if (!stageKeys.has(entry.stageKey)) {
      refusals.push({
        code: 'FREEZE_CONTENT_MISMATCH',
        message: `plan entry ${entry.entryId} references a stage outside the frozen tree`,
        details: { entryId: entry.entryId, stageKey: entry.stageKey },
      });
      continue;
    }
    if (entry.placement.type === 'gap') continue;
    const alignment = alignmentById.get(entry.alignmentId);
    if (alignment === undefined) {
      refusals.push({
        code: 'FREEZE_CONTENT_MISMATCH',
        message: `plan entry ${entry.entryId} references an alignment that is not verified in the frozen content`,
        details: { entryId: entry.entryId, alignmentId: entry.alignmentId },
      });
      continue;
    }
    if (alignment.stageKey !== entry.stageKey) {
      refusals.push({
        code: 'FREEZE_CONTENT_MISMATCH',
        message: `plan entry ${entry.entryId} stageKey does not match its frozen alignment`,
        details: {
          entryId: entry.entryId,
          entryStageKey: entry.stageKey,
          alignmentStageKey: alignment.stageKey,
        },
      });
      continue;
    }
    const rendition = renditionByKey.get(alignment.renditionKey);
    if (rendition === undefined) {
      refusals.push({
        code: 'FREEZE_CONTENT_MISMATCH',
        message: `plan entry ${entry.entryId} references a rendition outside the frozen content`,
        details: {
          entryId: entry.entryId,
          renditionKey: alignment.renditionKey,
        },
      });
      continue;
    }
    const placement = entry.placement;
    if (placement.type === 'media') {
      const matches =
        rendition.carrierType === 'asset' &&
        rendition.carrierKey === placement.assetKey &&
        rendition.carrierVersion === placement.assetVersion &&
        rendition.startMs === placement.startMs &&
        rendition.endMs === placement.endMs;
      if (!matches) {
        refusals.push({
          code: 'FREEZE_CONTENT_MISMATCH',
          message: `plan entry ${entry.entryId} media placement does not match the frozen rendition coordinates`,
          details: { entryId: entry.entryId },
        });
      }
    } else if (placement.type === 'document') {
      const matches =
        rendition.carrierType === 'document' &&
        rendition.carrierKey === placement.documentKey &&
        rendition.carrierVersion === placement.documentVersion &&
        rendition.headingCode === placement.headingCode &&
        rendition.offset === placement.offset;
      if (!matches) {
        refusals.push({
          code: 'FREEZE_CONTENT_MISMATCH',
          message: `plan entry ${entry.entryId} document placement does not match the frozen rendition coordinates`,
          details: { entryId: entry.entryId },
        });
      }
    } else if (placement.type === 'assessment') {
      if (rendition.contentKey !== placement.contentKey) {
        refusals.push({
          code: 'FREEZE_CONTENT_MISMATCH',
          message: `plan entry ${entry.entryId} assessment placement does not match the frozen rendition contentKey`,
          details: {
            entryId: entry.entryId,
            placementContentKey: placement.contentKey,
            renditionContentKey: rendition.contentKey,
          },
        });
      }
    }
  }
  return refusals;
}

// ---------------------------------------------------------------------------
// 冻结 ContentVersion（planPin 是版本的一部分，C3/C6）
// ---------------------------------------------------------------------------

export interface FreezeInput {
  readonly content: ContentVersionContent;
  readonly contentVersionId: string;
  /** 本环境单调版本号（C10.3：Production 本地生成，不来自包）。 */
  readonly versionNo: number;
  /** 审计时间（薄壳时钟；绝不进入 Plan canonical bytes）。 */
  readonly frozenAt: string;
  /** C10.3 环境局部标签；不参与内容身份。 */
  readonly sourceEnv?: SourceEnv;
  readonly sourceLabel?: string;
}

/** 组装并验证 ContentVersion：树/pins/仅 verified 对齐/planPin 一次冻结（G5）。 */
export function buildFrozenContentVersion(
  plan: PlanRecord,
  freeze: FreezeInput,
): ContentVersion {
  return ContentVersionSchema.parse({
    ...freeze.content,
    contentVersionId: freeze.contentVersionId,
    frozenAt: freeze.frozenAt,
    planPin: {
      planId: plan.planId,
      planVersion: plan.planVersion,
    },
    ...(freeze.sourceEnv === undefined ? {} : { sourceEnv: freeze.sourceEnv }),
    ...(freeze.sourceLabel === undefined
      ? {}
      : { sourceLabel: freeze.sourceLabel }),
  });
}

// ---------------------------------------------------------------------------
// apply：从同一 inputClosure 读取内容源并重算
// ---------------------------------------------------------------------------

/** DB 中的 Plan 原文 + 解析后的记录（status 外置，C6）。 */
export interface StoredPlan {
  readonly record: PlanRecord;
  /** PcPlan.canonicalJson 原文；比较用字节相等，不用摘要。 */
  readonly canonicalJson: string;
}

/**
 * 按 inputClosure 从 DB 读出的同一内容源（结构/pins/资产时长/时间源审计/
 * target 回退链/分类路径），apply 用它重算并派生冻结内容。
 */
export interface PlanSourceSnapshot {
  readonly source: PlanSource;
  readonly mediaAssets: readonly MediaAssetTimingInfo[];
  readonly timingSources: readonly RenditionTimingSourcePin[];
  readonly target: {
    readonly languages: readonly string[];
    readonly modalities: readonly DeliveryModality[];
  };
  readonly categoryPath: ContentVersionContent['categoryPath'];
  /** 当前 DB 结构修订计数（与 inputClosure.structureRevision 同口径派生）。 */
  readonly structureRevision: number;
  /** 当前 DB 对齐集版本计数（与 inputClosure.alignmentSetVersion 同口径派生）。 */
  readonly alignmentSetVersion: number;
}

/**
 * 事务端口。`runInTransaction` 必须保证 work 抛错时整体回滚（C5 P6：
 * ContentVersion + planPin + live 指针同事务）。
 *
 * findPlan/findLatestApproval/loadPlanInput 必须在同一事务内读取：审批可能在
 * 校验与写入之间被改成 rejected，只有同事务快照能保证「最新决定」不被绕过。
 */
export interface PlanApplyTransaction {
  findPlan(input: {
    readonly planId: string;
    readonly planVersion: number;
  }): Promise<StoredPlan | null>;
  /** 最新决定（approved/rejected）；无记录返回 null。 */
  findLatestApproval(input: {
    readonly planId: string;
    readonly planVersion: number;
  }): Promise<PlanApproval | null>;
  /** 同一 inputClosure 的内容源（树/renditions/alignments/证据/pins/资产）。 */
  loadPlanInput(closure: InputClosure): Promise<PlanSourceSnapshot>;
  findContentVersion(input: {
    readonly courseKey: string;
    readonly versionNo: number;
  }): Promise<ContentVersion | null>;
  insertContentVersion(version: ContentVersion): Promise<void>;
  setLiveContentVersion(pointer: PlanLivePointer): Promise<void>;
}

export interface PlanApplyPort {
  runInTransaction<T>(
    work: (transaction: PlanApplyTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface ApplyApprovedPlanInput {
  /** 只传身份：Plan 记录与审批必须从 DB 读（不信任外部传入）。 */
  readonly planId: string;
  readonly planVersion: number;
  /** 本环境单调版本号（薄壳从 DB 计数器派生）。 */
  readonly versionNo: number;
  /** 冻结版本的本地 id；必须等于已保存 Plan 的 contentVersionId。 */
  readonly contentVersionId: string;
  /** 审计时间（薄壳时钟）。 */
  readonly frozenAt: string;
  readonly sourceEnv?: SourceEnv;
  readonly sourceLabel?: string;
}

export interface ApplyResult {
  readonly status: 'applied' | 'already-applied';
  readonly contentVersionId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly versionNo: number;
}

/**
 * PlanRecord = canonical body + 外置 status；canonical bytes 只由 body 字段构成
 * （status 绝不进入 bytes，C6）。这里显式挑字段，杜绝把外部状态序列化进比较。
 */
function planBodyOfRecord(plan: PlanRecord): PlanBody {
  return {
    planId: plan.planId,
    contentVersionId: plan.contentVersionId,
    targetId: plan.targetId,
    planVersion: plan.planVersion,
    inputClosure: plan.inputClosure,
    entries: plan.entries,
    warnings: plan.warnings,
    compilerVersion: plan.compilerVersion,
    ruleVersion: plan.ruleVersion,
  };
}

/** 除审计时间与环境局部标签外的版本内容（幂等比较用；无摘要参与）。 */
function stableVersionContent(version: ContentVersion): string {
  return canonicalJson({
    ...version,
    frozenAt: undefined,
    sourceEnv: undefined,
    sourceLabel: undefined,
  });
}

/** 用 Plan 的 inputClosure 参数 + DB 内容源重算 canonical plan（P5/P6 同一函数）。 */
export function recompileStoredPlan(
  stored: StoredPlan,
  snapshot: PlanSourceSnapshot,
): CompilePlanResult {
  const plan = stored.record;
  return compilePlan({
    content: snapshot.source,
    target: {
      targetId: plan.inputClosure.targetId,
      languages: [...snapshot.target.languages],
      modalities: [...snapshot.target.modalities],
    },
    contentVersionId: plan.contentVersionId,
    planVersion: plan.planVersion,
    structureRevision: plan.inputClosure.structureRevision,
    alignmentSetVersion: plan.inputClosure.alignmentSetVersion,
    mediaAssets: snapshot.mediaAssets,
    timingSources: snapshot.timingSources,
    resolvedChoices: plan.inputClosure.resolvedChoices,
    ruleVersion: plan.inputClosure.ruleVersion,
    compilerVersion: plan.inputClosure.compilerVersion,
  });
}

/** 冻结内容 = 同一份 DB 内容源按 inputClosure 的 pins 派生（不读外部 content）。 */
export function freezeContentFromSnapshot(
  plan: PlanRecord,
  snapshot: PlanSourceSnapshot,
  versionNo: number,
): ContentVersionContent {
  // C1/C4：冻结只收 verified 且非 stale 的对齐（ALN-6 stale 读时派生：
  // verifiedAgainst 与当前 rendition/pin 审计元组不匹配即排除）。
  const specVersionByKey = new Map<string, number>(
    plan.inputClosure.specPins.map((pin) => [pin.contentKey, pin.version]),
  );
  const renditionByKey = new Map(
    snapshot.source.renditions.map((rendition) => [
      rendition.renditionKey,
      rendition,
    ]),
  );
  const freshVerified = snapshot.source.alignments.filter((alignment) => {
    if (alignment.status !== 'verified' || !alignment.verifiedAgainst) {
      return false;
    }
    const rendition = renditionByKey.get(alignment.renditionKey);
    if (rendition === undefined) return false;
    const pinnedSpecVersion = specVersionByKey.get(rendition.contentKey);
    return (
      alignment.verifiedAgainst.renditionRevision === rendition.revision &&
      alignment.verifiedAgainst.carrierVersion === rendition.carrierVersion &&
      alignment.verifiedAgainst.specVersion === pinnedSpecVersion
    );
  });
  return ContentVersionContentSchema.parse({
    courseKey: snapshot.source.courseKey,
    versionNo,
    categoryPath: snapshot.categoryPath,
    stages: [...snapshot.source.stages],
    prerequisiteEdges: [...snapshot.source.prerequisiteEdges],
    specPins: [...plan.inputClosure.specPins],
    renditions: [...snapshot.source.renditions],
    alignments: freshVerified.map((alignment) => ({
      ...alignment,
      status: 'verified' as const,
    })),
    evidenceSpecs: [...snapshot.source.evidenceSpecs],
    assetPins: [...plan.inputClosure.assetPins],
  });
}

/**
 * apply/publish：事务内 DB 门（plan + 最新审批）→ 同一 inputClosure 重算字节
 * 相等 → 冻结内容派生与 entries/stages 校验 → 单事务写 ContentVersion(planPin)
 * + live 指针。任何失败整体回滚，不留半成品。
 */
export async function applyApprovedPlan(
  input: ApplyApprovedPlanInput,
  port: PlanApplyPort,
): Promise<ApplyResult> {
  return port.runInTransaction(async (transaction) => {
    const planIdentity = {
      planId: input.planId,
      planVersion: input.planVersion,
    };
    const stored = await transaction.findPlan(planIdentity);
    if (stored === null) {
      throw new PlanApplyError([
        {
          code: 'PLAN_NOT_APPROVED',
          message:
            'plan is not saved in the database; preview and save it before applying',
          details: planIdentity,
        },
      ]);
    }
    const plan = stored.record;

    const refusals: PlanApplyRefusal[] = [];
    const approval = await transaction.findLatestApproval(planIdentity);
    if (approval === null) {
      refusals.push({
        code: 'PLAN_NOT_APPROVED',
        message: 'plan has no approval record; approve it before applying',
        details: planIdentity,
      });
    } else {
      refusals.push(...checkApplyEligibility(plan, approval));
    }
    if (plan.contentVersionId !== input.contentVersionId) {
      refusals.push({
        code: 'FREEZE_CONTENT_MISMATCH',
        message:
          'the contentVersionId being frozen does not match the saved plan contentVersionId',
        details: {
          planContentVersionId: plan.contentVersionId,
          requestedContentVersionId: input.contentVersionId,
        },
      });
    }
    if (refusals.length > 0) {
      throw new PlanApplyError(refusals);
    }

    // DB 原文与解析后的 record 必须一致（status 不进 bytes）。
    if (planBodyBytes(planBodyOfRecord(plan)) !== stored.canonicalJson) {
      throw new PartCError(
        'PLAN_INPUT_CHANGED',
        'stored plan canonical bytes do not match the parsed plan record',
        planIdentity,
      );
    }

    // P6：同一 inputClosure 的 DB 内容源重算；完整 canonical bytes 必须与
    // 已批准原文相等（stage 树/entries 被替换会改变 bytes，同样被拒绝）。
    // 先比显式计数器（树/对齐集结构变化即使 Plan bytes 不变也必须重新签收）。
    const snapshot = await transaction.loadPlanInput(plan.inputClosure);
    if (
      snapshot.structureRevision !== plan.inputClosure.structureRevision ||
      snapshot.alignmentSetVersion !== plan.inputClosure.alignmentSetVersion
    ) {
      throw new PartCError(
        'PLAN_INPUT_CHANGED',
        'content structure or alignment set changed after the plan was approved; preview and approve again',
        {
          ...planIdentity,
          planStructureRevision: plan.inputClosure.structureRevision,
          currentStructureRevision: snapshot.structureRevision,
          planAlignmentSetVersion: plan.inputClosure.alignmentSetVersion,
          currentAlignmentSetVersion: snapshot.alignmentSetVersion,
        },
      );
    }
    const recomputed = recompileStoredPlan(stored, snapshot);
    if (recomputed.status === 'blocked') {
      throw new PlanApplyError([
        {
          code: 'PLAN_BLOCKED',
          message: 'recomputed plan is blocked and cannot be applied',
          details: planIdentity,
        },
      ]);
    }
    if (recomputed.bytes !== stored.canonicalJson) {
      throw new PartCError(
        'PLAN_INPUT_CHANGED',
        'recomputed plan bytes differ from the approved plan; preview and approve again',
        {
          ...planIdentity,
          recomputedStatus: recomputed.status,
        },
      );
    }

    // 冻结内容由同一 source 派生，且 entries/stages 必须逐项对上（阻断 8）。
    const content = freezeContentFromSnapshot(plan, snapshot, input.versionNo);
    const freezeRefusals = checkFreezeMatchesClosure(plan, content);
    if (freezeRefusals.length > 0) {
      throw new PlanApplyError(freezeRefusals);
    }

    const version = buildFrozenContentVersion(plan, {
      content,
      contentVersionId: input.contentVersionId,
      versionNo: input.versionNo,
      frozenAt: input.frozenAt,
      ...(input.sourceEnv === undefined ? {} : { sourceEnv: input.sourceEnv }),
      ...(input.sourceLabel === undefined
        ? {}
        : { sourceLabel: input.sourceLabel }),
    });
    const identity = {
      contentVersionId: version.contentVersionId,
      planId: plan.planId,
      planVersion: plan.planVersion,
      versionNo: version.versionNo,
    };

    const existing = await transaction.findContentVersion({
      courseKey: version.courseKey,
      versionNo: version.versionNo,
    });
    if (existing !== null) {
      if (
        existing.contentVersionId === version.contentVersionId &&
        stableVersionContent(existing) === stableVersionContent(version)
      ) {
        // 幂等：同一 (courseKey, versionNo) 的重复 apply 是 no-op；不回拨 live 指针。
        return { status: 'already-applied', ...identity };
      }
      throw new PlanApplyError([
        {
          code: 'VERSION_CONFLICT',
          message:
            'a different content version already occupies this (courseKey, versionNo)',
          details: {
            courseKey: version.courseKey,
            versionNo: version.versionNo,
            existingContentVersionId: existing.contentVersionId,
            incomingContentVersionId: version.contentVersionId,
          },
        },
      ]);
    }
    await transaction.insertContentVersion(version);
    await transaction.setLiveContentVersion({
      courseKey: version.courseKey,
      contentVersionId: version.contentVersionId,
      versionNo: version.versionNo,
    });
    return { status: 'applied', ...identity };
  });
}

export interface PlanLivePointer {
  readonly courseKey: string;
  readonly contentVersionId: string;
  readonly versionNo: number;
  /** 发布记录操作者（员工 id 或 system；C10 追溯用，可选）。 */
  readonly actor?: string;
  /** 发布记录变更摘要（可选，不参与身份）。 */
  readonly summary?: string;
}
