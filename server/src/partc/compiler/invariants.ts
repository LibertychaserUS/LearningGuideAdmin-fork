import { assetKey as asAssetKey, renditionBusinessKey } from '../contracts';
import type {
  Alignment,
  AlignmentRole,
  AssetPin,
  DeliveryModality,
  EvidenceSpec,
  GapReason,
  PlanPlacement,
  PrerequisiteEdge,
  Rendition,
  SpecPin,
  Stage,
} from '../contracts';
import { TIMING_RULE_PARAMETERS } from './derive-timing';
import { linearizeDeliveryOrder } from './linearize';
import type { LinearizeResult } from './linearize';
import type { CompilerIssue, IssueSeverity } from './parse';

/**
 * Part C 编译器 P5 不变量与 σ 选择（设计 §14 C4 STR/ALN/TIM/PLN、C2、C5 P5）。
 *
 * 一个语义一个检查器：本模块是 Plan 编译侧对「阶段树 + rendition + 对齐 + 证据 +
 * pins」的唯一检查点（P2 validate 检查的是包/模板 IR，与本模块的输入工件不同）。
 *
 * - G1 契约闭合：阶段/rendition/对齐/证据/pins 的键唯一、引用可解析（无摘要、无 UUID）。
 * - G2 结构+覆盖+证据绑定：STR-1（包含森林/层级/叶与容器规则）、STR-4/5（证据）、
 *   STR-2/7（交付序无环，由 linearize）、ALN-1/2/3/4/6（纤维非空、只吃 verified、
 *   坐标单源、教学覆盖、stale 读时派生）、ALN-7/TIM-1（每个视频 rendition × 每个
 *   语言必须有机器时间源；低置信/无源均 blocked）。
 * - σ 选择：target 过滤（语言显式回退链 + modality 类别）、role 次序
 *   （primary > support > assessment > auxiliary）、occurrence、renditionKey tie-break。
 *   语言回退按「同一内容块槽位」进行：槽位 = (contentKey, blockId, role, objective,
 *   occurrenceKey)，槽位内取回退链中最早语言；同语言多载体按 renditionKey 升序。
 * - 不猜：无 verified 对齐、无机器时间源、无资产时长的阶段一律 blocked（显式 gap），
 *   绝不 clamp、不估算、不静默取别的语言当同语言。
 */

// ---------------------------------------------------------------------------
// 输入类型
// ---------------------------------------------------------------------------

export const PLAN_MACHINE_TIMING_SOURCES = [
  'subtitle',
  'chapter',
  'asr',
  'forced-alignment',
] as const;
export type PlanTimingSourceKind = (typeof PLAN_MACHINE_TIMING_SOURCES)[number];

const MACHINE_TIMING_SOURCE_SET: ReadonlySet<string> = new Set(
  PLAN_MACHINE_TIMING_SOURCES,
);

/** provenance.params 的取值（与 derive-timing 同口径的 JSON 标量）。 */
export type PlanParamValue = string | number | boolean | null;

/**
 * 一条 rendition 的时间源审计 pin（C7 / ALN-7）。
 *
 * ASR / 强制对齐是内部派生工件：必须携带 modelVersion/params/ruleVersion 与
 * 置信度（C5 P3），否则视为无机器时间源（TIMING_SOURCE_MISSING）；置信度低于
 * TIMING_RULE_PARAMETERS.minTranscriptConfidence → ALIGNMENT_LOW_CONFIDENCE。
 * 字幕/章节是包内交付物，无置信度字段。
 */
export interface RenditionTimingSourcePin {
  readonly renditionKey: string;
  readonly sourceKind: PlanTimingSourceKind;
  readonly sourceArtifact: string;
  readonly confidence?: number;
  readonly modelVersion?: string;
  readonly params?: Readonly<Record<string, PlanParamValue>>;
  readonly ruleVersion: string;
}

/**
 * 显式 target（C3 Course.publishTargets 的单 target 形态，v1 不允许多 target）。
 * languages 是有序回退链；modalities 为交付模态集合。
 */
export interface PlanTarget {
  readonly targetId: string;
  readonly languages: readonly string[];
  readonly modalities: readonly DeliveryModality[];
}

/** Plan 编译的显式内容源（草稿或冻结内容的稳定键视图）。 */
export interface PlanSource {
  readonly courseKey: string;
  readonly stages: readonly Stage[];
  readonly prerequisiteEdges: readonly PrerequisiteEdge[];
  readonly renditions: readonly Rendition[];
  readonly alignments: readonly Alignment[];
  readonly evidenceSpecs: readonly EvidenceSpec[];
  readonly specPins: readonly SpecPin[];
  readonly assetPins: readonly AssetPin[];
}

/**
 * 媒体资产的时长视图（TIM-1 范围校验唯一需要的资产属性；身份 = assetKey+
 * assetVersion，durationMs 只是容器探测出的物理属性，不参与身份）。
 */
export interface MediaAssetTimingInfo {
  readonly assetKey: string;
  readonly assetVersion: number;
  readonly durationMs?: number;
}

export interface PlanInvariantInput {
  readonly source: PlanSource;
  readonly target: PlanTarget;
  readonly mediaAssets?: readonly MediaAssetTimingInfo[];
  readonly timingSources?: readonly RenditionTimingSourcePin[];
}

// ---------------------------------------------------------------------------
// 输出类型
// ---------------------------------------------------------------------------

export type EffectiveAlignmentStatus =
  'verified' | 'proposed' | 'rejected' | 'stale' | 'dangling';

export interface GateReport {
  readonly gate: 'G1' | 'G2';
  readonly passed: boolean;
  readonly issues: readonly CompilerIssue[];
}

/** 计划级 gap（不变量违反的显式记录；stage 级 gap 另由 StageSelection.gaps 携带）。 */
export interface PlanGap {
  readonly invariant: string;
  readonly status: 'blocked' | 'degraded';
  readonly message: string;
  readonly stageKey?: string;
  readonly renditionKey?: string;
  readonly alignmentId?: string;
  readonly entryId?: string;
  readonly reason?: GapReason;
  readonly details?: Record<string, unknown>;
}

export interface StageSelectionGap {
  readonly reason: GapReason;
  readonly status: 'blocked' | 'degraded';
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/** σ 选中的一条 rendition 及其 concretely materialized placement。 */
export interface SelectedPlacement {
  readonly alignment: Alignment;
  readonly rendition: Rendition;
  readonly placement: PlanPlacement;
  readonly status: 'ok' | 'blocked';
}

export interface StageSelection {
  readonly stage: Stage;
  readonly selected: readonly SelectedPlacement[];
  readonly gaps: readonly StageSelectionGap[];
}

export interface PlanInvariantReport {
  readonly linearization: LinearizeResult;
  /** 按 λ 名次排序的交付叶选择；linearization.ok=false 时为空。 */
  readonly selections: readonly StageSelection[];
  readonly issues: readonly CompilerIssue[];
  /** 计划级 gap（结构/全局不变量；stage 级 gap 见 selections）。 */
  readonly gaps: readonly PlanGap[];
  readonly g1: GateReport;
  readonly g2: GateReport;
}

// ---------------------------------------------------------------------------
// 内部上下文
// ---------------------------------------------------------------------------

/**
 * σ 的角色次序（C4「role 次序」）：primary → support → assessment → auxiliary。
 * 这是 plan 编译器 v1 的规则常量，随 ruleVersion 版本化；ALN-4 的教学覆盖只看
 * primary（support/auxiliary 不计）。
 */
export const PLAN_ROLE_ORDER = [
  'primary',
  'support',
  'assessment',
  'auxiliary',
] as const;

const ROLE_ORDER: Readonly<Record<AlignmentRole, number>> = Object.fromEntries(
  PLAN_ROLE_ORDER.map((role, index) => [role, index]),
) as Readonly<Record<AlignmentRole, number>>;

const STAGE_KIND_LEVEL: Readonly<Record<Stage['kind'], number>> = {
  program: 1,
  phase: 2,
  stage: 3,
  step: 4,
};

const VIDEO_MODALITY_CLASS: ReadonlySet<string> = new Set(['video', 'audio']);
const TEXT_MODALITY_CLASS: ReadonlySet<string> = new Set(['text']);

function modalityClass(modality: DeliveryModality): ReadonlySet<string> {
  return modality === 'video' ? VIDEO_MODALITY_CLASS : TEXT_MODALITY_CLASS;
}

export interface InvariantContext {
  readonly source: PlanSource;
  readonly target: PlanTarget;
  readonly languageIndex: ReadonlyMap<string, number>;
  readonly stageByKey: ReadonlyMap<string, Stage>;
  readonly childStageKeysByParent: ReadonlyMap<string, readonly string[]>;
  readonly renditionByKey: ReadonlyMap<string, Rendition>;
  readonly alignmentsByStage: ReadonlyMap<string, readonly Alignment[]>;
  readonly alignmentsByRendition: ReadonlyMap<string, readonly Alignment[]>;
  readonly specPinByContentKey: ReadonlyMap<string, number>;
  readonly assetPinKeys: ReadonlySet<string>;
  readonly timingPinByRenditionKey: ReadonlyMap<
    string,
    RenditionTimingSourcePin
  >;
  readonly durationByAsset: ReadonlyMap<string, number>;
}

function assetIdentity(assetKey: string, assetVersion: number): string {
  return `${assetKey}@${assetVersion}`;
}

function buildContext(input: PlanInvariantInput): InvariantContext {
  const languageIndex = new Map<string, number>();
  input.target.languages.forEach((language, index) => {
    if (!languageIndex.has(language)) languageIndex.set(language, index);
  });

  const stageByKey = new Map<string, Stage>();
  for (const stage of input.source.stages) {
    if (!stageByKey.has(stage.stageKey)) stageByKey.set(stage.stageKey, stage);
  }
  const childStageKeysByParent = new Map<string, string[]>();
  for (const stage of input.source.stages) {
    if (stage.parentStageKey === null) continue;
    const list = childStageKeysByParent.get(stage.parentStageKey) ?? [];
    list.push(stage.stageKey);
    childStageKeysByParent.set(stage.parentStageKey, list);
  }

  const renditionByKey = new Map<string, Rendition>();
  for (const rendition of input.source.renditions) {
    if (!renditionByKey.has(rendition.renditionKey)) {
      renditionByKey.set(rendition.renditionKey, rendition);
    }
  }

  const alignmentsByStage = new Map<string, Alignment[]>();
  const alignmentsByRendition = new Map<string, Alignment[]>();
  for (const alignment of input.source.alignments) {
    const byStage = alignmentsByStage.get(alignment.stageKey) ?? [];
    byStage.push(alignment);
    alignmentsByStage.set(alignment.stageKey, byStage);
    const byRendition = alignmentsByRendition.get(alignment.renditionKey) ?? [];
    byRendition.push(alignment);
    alignmentsByRendition.set(alignment.renditionKey, byRendition);
  }

  const specPinByContentKey = new Map<string, number>();
  for (const pin of input.source.specPins) {
    if (!specPinByContentKey.has(pin.contentKey)) {
      specPinByContentKey.set(pin.contentKey, pin.version);
    }
  }

  const assetPinKeys = new Set<string>();
  for (const pin of input.source.assetPins) {
    assetPinKeys.add(assetIdentity(pin.assetKey, pin.assetVersion));
  }

  const timingPinByRenditionKey = new Map<string, RenditionTimingSourcePin>();
  for (const pin of input.timingSources ?? []) {
    if (!timingPinByRenditionKey.has(pin.renditionKey)) {
      timingPinByRenditionKey.set(pin.renditionKey, pin);
    }
  }

  const durationByAsset = new Map<string, number>();
  for (const asset of input.mediaAssets ?? []) {
    if (asset.durationMs !== undefined) {
      durationByAsset.set(
        assetIdentity(asset.assetKey, asset.assetVersion),
        asset.durationMs,
      );
    }
  }

  return {
    source: input.source,
    target: input.target,
    languageIndex,
    stageByKey,
    childStageKeysByParent,
    renditionByKey,
    alignmentsByStage,
    alignmentsByRendition,
    specPinByContentKey,
    assetPinKeys,
    timingPinByRenditionKey,
    durationByAsset,
  };
}

// ---------------------------------------------------------------------------
// issue 构造
// ---------------------------------------------------------------------------

function makeIssue(
  severity: IssueSeverity,
  code: CompilerIssue['code'],
  message: string,
  invariant: string,
  details?: Record<string, unknown>,
  path?: string,
): CompilerIssue {
  return {
    severity,
    code,
    message,
    invariant,
    ...(path === undefined ? {} : { source: { path } }),
    ...(details === undefined ? {} : { details }),
  };
}

function issueBlocking(issue: CompilerIssue): boolean {
  return issue.severity === 'error' || issue.severity === 'incomplete';
}

// ---------------------------------------------------------------------------
// ALN-2/ALN-6：effStatus（stale 读时派生，绝不落库）
// ---------------------------------------------------------------------------

/**
 * 对齐有效状态（ALN-2 只吃 verified；ALN-6 stale 派生）：
 * - 存储状态 proposed/rejected 原样返回；
 * - verified 时按审计元组与当前 pin 集逐一比对：renditionRevision /
 *   carrierVersion / specVersion 任一不匹配或 pin 缺失 → stale；
 * - 引用不存在的 rendition、objective 不属于该 stage → dangling（粘合条件不成立，
 *   由 G1/G2 以 ALN-3 报 error）。
 */
export function evaluateAlignmentEffectiveStatus(
  alignment: Alignment,
  context: Pick<
    InvariantContext,
    'renditionByKey' | 'specPinByContentKey' | 'stageByKey'
  >,
): { status: EffectiveAlignmentStatus; reasons: readonly string[] } {
  const rendition = context.renditionByKey.get(alignment.renditionKey);
  if (rendition === undefined) {
    return { status: 'dangling', reasons: ['rendition-not-found'] };
  }
  const stage = context.stageByKey.get(alignment.stageKey);
  if (stage === undefined) {
    return { status: 'dangling', reasons: ['stage-not-found'] };
  }
  if (!stage.objectiveKeys.includes(alignment.objectiveKey)) {
    return { status: 'dangling', reasons: ['objective-not-in-stage'] };
  }
  if (alignment.status !== 'verified') {
    return { status: alignment.status, reasons: [] };
  }
  if (alignment.verifiedAgainst === undefined) {
    // schema 层不允许；防御性地按 stale 处理（审计元组缺失 = 粘合失败）。
    return { status: 'stale', reasons: ['missing-audit-tuple'] };
  }
  const reasons: string[] = [];
  if (alignment.verifiedAgainst.renditionRevision !== rendition.revision) {
    reasons.push('rendition-revision-mismatch');
  }
  if (alignment.verifiedAgainst.carrierVersion !== rendition.carrierVersion) {
    reasons.push('carrier-version-mismatch');
  }
  const specVersion = context.specPinByContentKey.get(rendition.contentKey);
  if (specVersion === undefined) {
    reasons.push('spec-pin-missing');
  } else if (alignment.verifiedAgainst.specVersion !== specVersion) {
    reasons.push('spec-version-mismatch');
  }
  return reasons.length === 0
    ? { status: 'verified', reasons: [] }
    : { status: 'stale', reasons };
}

function isRenditionAdmittedToTarget(
  rendition: Rendition,
  target: PlanTarget,
  languageIndex: ReadonlyMap<string, number>,
): boolean {
  if (!languageIndex.has(rendition.language)) return false;
  return target.modalities.some((modality) =>
    modalityClass(modality).has(rendition.modality),
  );
}

// ---------------------------------------------------------------------------
// G1：契约闭合
// ---------------------------------------------------------------------------

function checkContractClosure(context: InvariantContext): CompilerIssue[] {
  const { source } = context;
  const issues: CompilerIssue[] = [];

  const seenStageKeys = new Set<string>();
  const seenOrderKeys = new Set<string>();
  source.stages.forEach((stage, index) => {
    if (seenStageKeys.has(stage.stageKey)) {
      issues.push(
        makeIssue(
          'error',
          'STAGE_INVALID',
          'duplicate stageKey in content',
          'STR-1',
          { stageKey: stage.stageKey },
          `content.stages[${index}].stageKey`,
        ),
      );
    }
    seenStageKeys.add(stage.stageKey);
    if (seenOrderKeys.has(stage.orderKey)) {
      issues.push(
        makeIssue(
          'error',
          'STAGE_INVALID',
          'duplicate orderKey in content (linearization would be ambiguous)',
          'STR-3',
          { stageKey: stage.stageKey, orderKey: stage.orderKey },
          `content.stages[${index}].orderKey`,
        ),
      );
    }
    seenOrderKeys.add(stage.orderKey);
    if (stage.courseKey !== source.courseKey) {
      issues.push(
        makeIssue(
          'error',
          'STAGE_INVALID',
          'stage.courseKey must equal the content courseKey',
          'STR-1',
          { stageKey: stage.stageKey, courseKey: stage.courseKey },
          `content.stages[${index}].courseKey`,
        ),
      );
    }
  });

  const seenRenditionKeys = new Set<string>();
  const seenBusinessKeys = new Set<string>();
  source.renditions.forEach((rendition, index) => {
    if (seenRenditionKeys.has(rendition.renditionKey)) {
      issues.push(
        makeIssue(
          'error',
          'CODE_DUPLICATE',
          'duplicate renditionKey in content',
          'ALN-3',
          { renditionKey: rendition.renditionKey },
          `content.renditions[${index}].renditionKey`,
        ),
      );
    }
    seenRenditionKeys.add(rendition.renditionKey);
    const businessKey = renditionBusinessKey(rendition);
    if (seenBusinessKeys.has(businessKey)) {
      issues.push(
        makeIssue(
          'error',
          'CODE_DUPLICATE',
          'duplicate rendition business key (coordinates must have one source)',
          'ALN-3',
          { renditionKey: rendition.renditionKey },
          `content.renditions[${index}]`,
        ),
      );
    }
    seenBusinessKeys.add(businessKey);
    if (!context.specPinByContentKey.has(rendition.contentKey)) {
      issues.push(
        makeIssue(
          'error',
          'REFERENCE_UNRESOLVED',
          'rendition references a contentKey without a spec pin',
          'ALN-3',
          {
            renditionKey: rendition.renditionKey,
            contentKey: rendition.contentKey,
          },
          `content.renditions[${index}].contentKey`,
        ),
      );
    }
    if (
      rendition.carrierType === 'asset' &&
      !context.assetPinKeys.has(
        assetIdentity(rendition.carrierKey, rendition.carrierVersion),
      )
    ) {
      issues.push(
        makeIssue(
          'error',
          'REFERENCE_UNRESOLVED',
          'rendition references an asset without an asset pin',
          'ALN-3',
          {
            renditionKey: rendition.renditionKey,
            carrierKey: rendition.carrierKey,
            carrierVersion: rendition.carrierVersion,
          },
          `content.renditions[${index}].carrierKey`,
        ),
      );
    }
  });

  const seenSpecPinKeys = new Set<string>();
  source.specPins.forEach((pin, index) => {
    if (seenSpecPinKeys.has(pin.contentKey)) {
      issues.push(
        makeIssue(
          'error',
          'CODE_DUPLICATE',
          'duplicate contentKey in spec pins (input closure must be canonical)',
          'G1',
          { contentKey: pin.contentKey },
          `content.specPins[${index}].contentKey`,
        ),
      );
    }
    seenSpecPinKeys.add(pin.contentKey);
  });
  const seenAssetPinKeys = new Set<string>();
  source.assetPins.forEach((pin, index) => {
    if (seenAssetPinKeys.has(pin.assetKey)) {
      issues.push(
        makeIssue(
          'error',
          'CODE_DUPLICATE',
          'duplicate assetKey in asset pins (input closure must be canonical)',
          'G1',
          { assetKey: pin.assetKey },
          `content.assetPins[${index}].assetKey`,
        ),
      );
    }
    seenAssetPinKeys.add(pin.assetKey);
  });

  source.alignments.forEach((alignment, index) => {
    const stage = context.stageByKey.get(alignment.stageKey);
    if (stage === undefined) {
      issues.push(
        makeIssue(
          'error',
          'REFERENCE_UNRESOLVED',
          'alignment references an unknown stage',
          'ALN-3',
          { alignmentId: alignment.alignmentId, stageKey: alignment.stageKey },
          `content.alignments[${index}].stageKey`,
        ),
      );
    }
    if (!context.renditionByKey.has(alignment.renditionKey)) {
      issues.push(
        makeIssue(
          'error',
          'REFERENCE_UNRESOLVED',
          'alignment references an unknown rendition',
          'ALN-3',
          {
            alignmentId: alignment.alignmentId,
            renditionKey: alignment.renditionKey,
          },
          `content.alignments[${index}].renditionKey`,
        ),
      );
    }
    if (
      stage !== undefined &&
      !stage.objectiveKeys.includes(alignment.objectiveKey)
    ) {
      issues.push(
        makeIssue(
          'error',
          'ALIGNMENT_CONFLICT',
          'verified glue condition requires the alignment objective to belong to its stage',
          'ALN-3',
          {
            alignmentId: alignment.alignmentId,
            stageKey: alignment.stageKey,
            objectiveKey: alignment.objectiveKey,
          },
          `content.alignments[${index}].objectiveKey`,
        ),
      );
    }
  });

  const seenEvidenceKeys = new Set<string>();
  source.evidenceSpecs.forEach((spec, index) => {
    if (seenEvidenceKeys.has(spec.evidenceKey)) {
      issues.push(
        makeIssue(
          'error',
          'CODE_DUPLICATE',
          'duplicate evidenceKey in content',
          'STR-5',
          { evidenceKey: spec.evidenceKey },
          `content.evidenceSpecs[${index}].evidenceKey`,
        ),
      );
    }
    seenEvidenceKeys.add(spec.evidenceKey);
    if (
      spec.measure.kind === 'assessment' &&
      !context.specPinByContentKey.has(spec.measure.contentKey)
    ) {
      issues.push(
        makeIssue(
          'error',
          'REFERENCE_UNRESOLVED',
          'assessment evidence measures unpinned content',
          'STR-5',
          {
            evidenceKey: spec.evidenceKey,
            contentKey: spec.measure.contentKey,
          },
          `content.evidenceSpecs[${index}].measure.contentKey`,
        ),
      );
    }
  });

  return issues;
}

// ---------------------------------------------------------------------------
// STR-1 / STR-4 / STR-5 / STR-7：结构与证据
// ---------------------------------------------------------------------------

function checkStructure(context: InvariantContext): CompilerIssue[] {
  const { source } = context;
  const issues: CompilerIssue[] = [];

  // 空课程不产生可交付计划：不允许「零 entry 的 draft 计划」悄悄通过发布门。
  if (source.stages.length === 0) {
    issues.push(
      makeIssue(
        'error',
        'STAGE_INVALID',
        'content version must contain at least one stage (an empty plan is not publishable)',
        'STR-1',
        undefined,
        'content.stages',
      ),
    );
  }

  const parentIndexByKey = new Map<string, string>();
  source.stages.forEach((stage, index) => {
    if (stage.parentStageKey === null) return;
    const parent = context.stageByKey.get(stage.parentStageKey);
    if (parent === undefined) {
      issues.push(
        makeIssue(
          'error',
          'STAGE_INVALID',
          'parentStageKey does not exist in this content version',
          'STR-1',
          { stageKey: stage.stageKey, parentStageKey: stage.parentStageKey },
          `content.stages[${index}].parentStageKey`,
        ),
      );
      return;
    }
    parentIndexByKey.set(stage.stageKey, stage.parentStageKey);
    if (STAGE_KIND_LEVEL[stage.kind] <= STAGE_KIND_LEVEL[parent.kind]) {
      issues.push(
        makeIssue(
          'error',
          'STAGE_INVALID',
          'stage kind must be strictly deeper than its parent kind',
          'STR-1',
          {
            stageKey: stage.stageKey,
            kind: stage.kind,
            parentKind: parent.kind,
          },
          `content.stages[${index}].kind`,
        ),
      );
    }
  });

  // 包含环（单父结构下沿父指针走链）。
  const reportedCycles = new Set<string>();
  source.stages.forEach((stage, index) => {
    const seen = new Set<string>();
    let current: string | undefined = stage.stageKey;
    while (current !== undefined) {
      if (seen.has(current)) {
        const cycle = [...seen].sort();
        const key = cycle.join('\u0000');
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          issues.push(
            makeIssue(
              'error',
              'STAGE_INVALID',
              'containment graph contains a cycle',
              'STR-1',
              { stageKeys: cycle },
              `content.stages[${index}].parentStageKey`,
            ),
          );
        }
        break;
      }
      seen.add(current);
      current = parentIndexByKey.get(current);
    }
  });

  source.stages.forEach((stage, index) => {
    const children = context.childStageKeysByParent.get(stage.stageKey) ?? [];
    if (children.length === 0) {
      if (stage.objectiveKeys.length === 0) {
        issues.push(
          makeIssue(
            'error',
            'STAGE_INVALID',
            'delivery leaf (no children) must declare objectiveKeys',
            'STR-1',
            { stageKey: stage.stageKey },
            `content.stages[${index}].objectiveKeys`,
          ),
        );
      }
      if (stage.exitEvidence.length === 0) {
        issues.push(
          makeIssue(
            'error',
            'STAGE_INVALID',
            'delivery leaf (no children) must declare exitEvidence',
            'STR-1',
            { stageKey: stage.stageKey },
            `content.stages[${index}].exitEvidence`,
          ),
        );
      }
    } else if (stage.exitEvidence.length > 0) {
      issues.push(
        makeIssue(
          'error',
          'STAGE_INVALID',
          'container stage must not declare exitEvidence',
          'STR-1',
          { stageKey: stage.stageKey },
          `content.stages[${index}].exitEvidence`,
        ),
      );
    }
    if (
      stage.exitRollup.kind === 'atLeast' &&
      stage.exitRollup.n > stage.exitEvidence.length
    ) {
      issues.push(
        makeIssue(
          'error',
          'EVIDENCE_UNSUPPORTED',
          'exitRollup atLeast(n) cannot be satisfied by the declared exitEvidence',
          'STR-4',
          {
            stageKey: stage.stageKey,
            n: stage.exitRollup.n,
            declared: stage.exitEvidence.length,
          },
          `content.stages[${index}].exitRollup`,
        ),
      );
    }
  });

  // STR-7：先修端点/自指/跨课程（交付序无环由 linearize 检查）。
  source.prerequisiteEdges.forEach((edge, index) => {
    const from = context.stageByKey.get(edge.fromStageKey);
    const to = context.stageByKey.get(edge.toStageKey);
    if (from === undefined || to === undefined) {
      // linearize 已对缺失端点报 PREREQUISITE_INVALID；这里只补自指/跨课程。
      return;
    }
    if (
      edge.fromStageKey === edge.toStageKey ||
      from.courseKey !== source.courseKey ||
      to.courseKey !== source.courseKey
    ) {
      issues.push(
        makeIssue(
          'error',
          'PREREQUISITE_INVALID',
          'prerequisite edge must not be self-referential or cross-course',
          'STR-7',
          { fromStageKey: edge.fromStageKey, toStageKey: edge.toStageKey },
          `content.prerequisiteEdges[${index}]`,
        ),
      );
    }
  });

  issues.push(...checkEvidenceBinding(context));
  return issues;
}

/** STR-5 证据绑定（与 P2 validate 的判定语义一致，输入工件不同）。 */
function checkEvidenceBinding(context: InvariantContext): CompilerIssue[] {
  const { source } = context;
  const issues: CompilerIssue[] = [];
  const specByKey = new Map<string, EvidenceSpec>();
  for (const spec of source.evidenceSpecs) {
    if (!specByKey.has(spec.evidenceKey)) specByKey.set(spec.evidenceKey, spec);
  }
  const verifiedAlignments = source.alignments.filter(
    (alignment) =>
      evaluateAlignmentEffectiveStatus(alignment, context).status ===
      'verified',
  );

  source.stages.forEach((stage, index) => {
    const coveringObjectives = new Set<string>();
    for (const evidenceKey of stage.exitEvidence) {
      const spec = specByKey.get(evidenceKey);
      if (spec === undefined) {
        issues.push(
          makeIssue(
            'incomplete',
            'EVIDENCE_INCOMPLETE',
            'exitEvidence has no matching EvidenceSpec (publish-blocking)',
            'STR-5',
            { stageKey: stage.stageKey, evidenceKey },
            `content.stages[${index}].exitEvidence`,
          ),
        );
        continue;
      }
      for (const objectiveKey of spec.objectiveKeys) {
        coveringObjectives.add(objectiveKey);
      }
      if (spec.kind === 'assessment' && spec.measure.kind === 'assessment') {
        const measure = spec.measure;
        const bound = verifiedAlignments.some((alignment) => {
          if (alignment.stageKey !== stage.stageKey) return false;
          if (alignment.role !== 'assessment') return false;
          if (!stage.objectiveKeys.includes(alignment.objectiveKey))
            return false;
          const rendition = context.renditionByKey.get(alignment.renditionKey);
          if (rendition === undefined) return false;
          return (
            rendition.contentKey === measure.contentKey &&
            measure.blockIds.includes(rendition.blockId)
          );
        });
        if (!bound) {
          issues.push(
            makeIssue(
              'incomplete',
              'EVIDENCE_INCOMPLETE',
              'assessment evidence needs a verified assessment alignment to its measure blocks',
              'STR-5',
              { stageKey: stage.stageKey, evidenceKey },
              `content.stages[${index}].exitEvidence`,
            ),
          );
        }
      }
    }
    for (const objectiveKey of stage.objectiveKeys) {
      if (!coveringObjectives.has(objectiveKey)) {
        issues.push(
          makeIssue(
            'incomplete',
            'EVIDENCE_INCOMPLETE',
            'stage objective is not covered by any exit evidence objective set',
            'STR-5',
            { stageKey: stage.stageKey, objectiveKey },
            `content.stages[${index}].objectiveKeys`,
          ),
        );
      }
    }
  });
  return issues;
}

// ---------------------------------------------------------------------------
// ALN-7 / TIM-1：机器时间源
// ---------------------------------------------------------------------------

export interface MediaTimingVerdict {
  readonly ok: boolean;
  readonly issue?: CompilerIssue;
}

/**
 * 媒体坐标的机器时间源检查（ALN-7/TIM-1/C7）：
 * - 坐标只能来自 subtitle/chapter/asr/forced-alignment，且 rendition 必须带 [start,end)；
 * - asr/forced-alignment 必须有 provenance pin（modelVersion/params/ruleVersion）与
 *   置信度；置信度低于 minTranscriptConfidence → ALIGNMENT_LOW_CONFIDENCE；
 * - 资产时长必须由容器探测（mediaAssets），缺失 → TIMING_SOURCE_MISSING，不跳过校验；
 * - endMs 越过资产时长 → TIMING_RANGE_INVALID（不 clamp）。
 */
export function evaluateMediaTiming(
  rendition: Rendition,
  context: Pick<
    InvariantContext,
    'timingPinByRenditionKey' | 'durationByAsset'
  >,
): MediaTimingVerdict {
  const invariant = rendition.modality === 'video' ? 'ALN-7' : 'TIM-1';
  const missing = (message: string, details?: Record<string, unknown>) => ({
    ok: false as const,
    issue: makeIssue(
      'incomplete',
      'TIMING_SOURCE_MISSING',
      message,
      invariant,
      { renditionKey: rendition.renditionKey, ...details },
    ),
  });

  if (rendition.startMs === undefined || rendition.endMs === undefined) {
    return missing(
      'media rendition has no [startMs, endMs) coordinates derived from a machine source',
    );
  }
  const sourceKind: string = rendition.anchorSource;
  if (!MACHINE_TIMING_SOURCE_SET.has(sourceKind)) {
    return missing(
      `anchorSource '${sourceKind}' is not a machine timing source (subtitle/chapter/asr/forced-alignment)`,
      { anchorSource: sourceKind },
    );
  }
  if (sourceKind === 'asr' || sourceKind === 'forced-alignment') {
    const pin = context.timingPinByRenditionKey.get(rendition.renditionKey);
    if (pin === undefined) {
      return missing(
        'ASR/forced-alignment rendition lacks derivation provenance pins',
        { anchorSource: sourceKind },
      );
    }
    if (pin.sourceKind !== sourceKind) {
      return missing(
        'timing provenance sourceKind does not match the rendition anchorSource',
        { anchorSource: sourceKind, provenanceSourceKind: pin.sourceKind },
      );
    }
    if (
      pin.modelVersion === undefined ||
      pin.modelVersion.length === 0 ||
      pin.params === undefined ||
      pin.ruleVersion.length === 0
    ) {
      return missing(
        'ASR/forced-alignment provenance must pin modelVersion/params/ruleVersion',
        { anchorSource: sourceKind },
      );
    }
    if (pin.confidence === undefined) {
      return missing(
        'ASR/forced-alignment provenance must carry a confidence value',
        { anchorSource: sourceKind },
      );
    }
    if (pin.confidence < TIMING_RULE_PARAMETERS.minTranscriptConfidence) {
      return {
        ok: false,
        issue: makeIssue(
          'incomplete',
          'ALIGNMENT_LOW_CONFIDENCE',
          'derived timing confidence is below the rule threshold',
          'ALN-7',
          {
            renditionKey: rendition.renditionKey,
            confidence: pin.confidence,
            threshold: TIMING_RULE_PARAMETERS.minTranscriptConfidence,
          },
        ),
      };
    }
  }

  const durationMs = context.durationByAsset.get(
    assetIdentity(rendition.carrierKey, rendition.carrierVersion),
  );
  if (durationMs === undefined) {
    return missing(
      'asset duration was not probed from the container; range cannot be validated',
      {
        carrierKey: rendition.carrierKey,
        carrierVersion: rendition.carrierVersion,
      },
    );
  }
  if (rendition.endMs > durationMs) {
    return {
      ok: false,
      issue: makeIssue(
        'incomplete',
        'TIMING_RANGE_INVALID',
        'rendition endMs exceeds the probed asset duration',
        'TIM-1',
        {
          renditionKey: rendition.renditionKey,
          endMs: rendition.endMs,
          durationMs,
        },
      ),
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// σ 选择：target 过滤 + 语言回退 + role 次序 + occurrence + tie-break
// ---------------------------------------------------------------------------

interface EvaluatedAlignment {
  readonly alignment: Alignment;
  readonly rendition: Rendition;
  readonly effStatus: EffectiveAlignmentStatus;
  readonly effReasons: readonly string[];
}

interface StageSelectionDraft {
  readonly stage: Stage;
  readonly evaluated: readonly EvaluatedAlignment[];
  readonly admitted: readonly EvaluatedAlignment[];
  readonly matchingTarget: readonly EvaluatedAlignment[];
  readonly winners: readonly EvaluatedAlignment[];
  readonly gaps: readonly StageSelectionGap[];
  readonly issues: readonly CompilerIssue[];
}

function slotKeyOf(evaluated: EvaluatedAlignment): string {
  return [
    evaluated.rendition.contentKey,
    evaluated.rendition.blockId,
    evaluated.alignment.role,
    evaluated.alignment.objectiveKey,
    evaluated.rendition.occurrenceKey,
  ].join('\u0000');
}

function compareWinners(
  left: EvaluatedAlignment,
  right: EvaluatedAlignment,
  languageIndex: ReadonlyMap<string, number>,
): number {
  const roleDiff =
    ROLE_ORDER[left.alignment.role] - ROLE_ORDER[right.alignment.role];
  if (roleDiff !== 0) return roleDiff;
  const leftKey = left.rendition;
  const rightKey = right.rendition;
  if (leftKey.contentKey !== rightKey.contentKey) {
    return leftKey.contentKey < rightKey.contentKey ? -1 : 1;
  }
  if (leftKey.blockId !== rightKey.blockId) {
    return leftKey.blockId < rightKey.blockId ? -1 : 1;
  }
  if (leftKey.occurrenceKey !== rightKey.occurrenceKey) {
    return leftKey.occurrenceKey < rightKey.occurrenceKey ? -1 : 1;
  }
  if (leftKey.renditionKey !== rightKey.renditionKey) {
    return leftKey.renditionKey < rightKey.renditionKey ? -1 : 1;
  }
  const leftLanguage = languageIndex.get(leftKey.language) ?? -1;
  const rightLanguage = languageIndex.get(rightKey.language) ?? -1;
  if (leftLanguage !== rightLanguage) return leftLanguage - rightLanguage;
  return left.alignment.alignmentId < right.alignment.alignmentId ? -1 : 1;
}

function compareWithinSlot(
  left: EvaluatedAlignment,
  right: EvaluatedAlignment,
  languageIndex: ReadonlyMap<string, number>,
): number {
  const leftLanguage = languageIndex.get(left.rendition.language) ?? -1;
  const rightLanguage = languageIndex.get(right.rendition.language) ?? -1;
  if (leftLanguage !== rightLanguage) return leftLanguage - rightLanguage;
  if (left.rendition.renditionKey !== right.rendition.renditionKey) {
    return left.rendition.renditionKey < right.rendition.renditionKey ? -1 : 1;
  }
  return left.alignment.alignmentId < right.alignment.alignmentId ? -1 : 1;
}

function draftStageSelection(
  stage: Stage,
  context: InvariantContext,
): StageSelectionDraft {
  const alignments = context.alignmentsByStage.get(stage.stageKey) ?? [];
  const evaluated: EvaluatedAlignment[] = [];
  for (const alignment of alignments) {
    const rendition = context.renditionByKey.get(alignment.renditionKey);
    if (rendition === undefined) continue; // G1 已报 REFERENCE_UNRESOLVED
    const eff = evaluateAlignmentEffectiveStatus(alignment, context);
    evaluated.push({
      alignment,
      rendition,
      effStatus: eff.status,
      effReasons: eff.reasons,
    });
  }

  const admitted = evaluated.filter(
    (entry) =>
      entry.effStatus === 'verified' &&
      isRenditionAdmittedToTarget(
        entry.rendition,
        context.target,
        context.languageIndex,
      ),
  );
  const matchingTarget = evaluated.filter((entry) =>
    isRenditionAdmittedToTarget(
      entry.rendition,
      context.target,
      context.languageIndex,
    ),
  );

  const gaps: StageSelectionGap[] = [];
  const issues: CompilerIssue[] = [];

  // stale 是读时派生；即使不阻塞本阶段也要在报告中显式列出（P8 变更复核输入）。
  for (const entry of evaluated) {
    if (entry.effStatus !== 'stale') continue;
    issues.push(
      makeIssue(
        'warning',
        'ALIGNMENT_CONFLICT',
        'verified alignment is stale: its audit tuple no longer matches the current pins',
        'ALN-6',
        {
          stageKey: stage.stageKey,
          alignmentId: entry.alignment.alignmentId,
          renditionKey: entry.alignment.renditionKey,
          reasons: entry.effReasons,
        },
        `content.alignments[${entry.alignment.alignmentId}]`,
      ),
    );
  }

  if (admitted.length === 0) {
    const anyStale = matchingTarget.some(
      (entry) => entry.effStatus === 'stale' || entry.effStatus === 'dangling',
    );
    const reason: GapReason =
      matchingTarget.length === 0 ? 'ALN-1' : anyStale ? 'ALN-6' : 'ALN-2';
    const message =
      reason === 'ALN-1'
        ? 'delivery leaf has no verified rendition admitted by the target (language fallback chain + modality)'
        : reason === 'ALN-6'
          ? 'every target-admitted alignment of this delivery leaf is stale (audit tuple no longer matches the pins)'
          : 'every target-admitted alignment of this delivery leaf is proposed/rejected; only verified alignments may enter a plan';
    gaps.push({ reason, status: 'blocked', message });
    issues.push(
      makeIssue(
        'incomplete',
        reason === 'ALN-6' ? 'ALIGNMENT_CONFLICT' : 'ALIGNMENT_UNBOUND',
        message,
        reason,
        {
          stageKey: stage.stageKey,
          alignmentIds: matchingTarget.map(
            (entry) => entry.alignment.alignmentId,
          ),
          effStatuses: matchingTarget.map((entry) => entry.effStatus),
        },
        `content.stages[${stage.stageKey}]`,
      ),
    );
    return {
      stage,
      evaluated,
      admitted,
      matchingTarget,
      winners: [],
      gaps,
      issues,
    };
  }

  const slots = new Map<string, EvaluatedAlignment[]>();
  for (const entry of admitted) {
    const key = slotKeyOf(entry);
    const list = slots.get(key) ?? [];
    list.push(entry);
    slots.set(key, list);
  }
  const winners: EvaluatedAlignment[] = [];
  for (const key of [...slots.keys()].sort()) {
    const candidates = (slots.get(key) as EvaluatedAlignment[]).sort((a, b) =>
      compareWithinSlot(a, b, context.languageIndex),
    );
    winners.push(candidates[0]);
  }
  winners.sort((a, b) => compareWinners(a, b, context.languageIndex));

  // ALN-4：每个 objective 至少一个 target 内的 verified primary。
  const missingObjectives = stage.objectiveKeys.filter(
    (objectiveKey) =>
      !admitted.some(
        (entry) =>
          entry.alignment.role === 'primary' &&
          entry.alignment.objectiveKey === objectiveKey,
      ),
  );
  if (missingObjectives.length > 0) {
    const message =
      'stage objective has no verified primary alignment admitted by the target';
    gaps.push({
      reason: 'ALN-4',
      status: 'blocked',
      message,
      details: { objectiveKeys: missingObjectives },
    });
    issues.push(
      makeIssue(
        'incomplete',
        'ALIGNMENT_UNBOUND',
        message,
        'ALN-4',
        { stageKey: stage.stageKey, objectiveKeys: missingObjectives },
        `content.stages[${stage.stageKey}].objectiveKeys`,
      ),
    );
  }

  // 多模态 target 下缺失某个交付模态：显式 degraded（机器报告，不静默）。
  if (context.target.modalities.length > 1) {
    for (const modality of context.target.modalities) {
      const admittedForModality = admitted.some((entry) =>
        modalityClass(modality).has(entry.rendition.modality),
      );
      if (!admittedForModality) {
        const message = `delivery leaf has no verified rendition for the target's ${modality} modality`;
        gaps.push({
          reason: 'ALN-1',
          status: 'degraded',
          message,
          details: { modality },
        });
        issues.push(
          makeIssue(
            'warning',
            'ALIGNMENT_UNBOUND',
            message,
            'ALN-1',
            { stageKey: stage.stageKey, modality },
            `content.stages[${stage.stageKey}]`,
          ),
        );
      }
    }
  }

  return { stage, evaluated, admitted, matchingTarget, winners, gaps, issues };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 评估 Plan 编译的 G1/G2 不变量与 σ 选择。
 *
 * 纯函数：输入全显式（含 mediaAssets 时长与 timingSources 审计 pin）；
 * 不读时钟、不发 IO、不依赖 locale。
 */
export function evaluatePlanInvariants(
  input: PlanInvariantInput,
): PlanInvariantReport {
  const context = buildContext(input);
  const g1Issues = checkContractClosure(context);

  const linearization = linearizeDeliveryOrder({
    courseKey: input.source.courseKey,
    stages: input.source.stages,
    prerequisiteEdges: input.source.prerequisiteEdges,
  });

  const g2Issues: CompilerIssue[] = [];
  g2Issues.push(...checkStructure(context));
  g2Issues.push(...linearization.issues);

  const planGaps: PlanGap[] = [];
  const selections: StageSelection[] = [];

  if (linearization.ok) {
    const drafts = linearization.leafStages.map((stage) =>
      draftStageSelection(stage, context),
    );
    for (const draft of drafts) g2Issues.push(...draft.issues);

    const usedRenditionKeys = new Set<string>();
    for (const draft of drafts) {
      for (const winner of draft.winners) {
        usedRenditionKeys.add(winner.rendition.renditionKey);
      }
    }

    // ALN-7 / TIM-1：视频 rendition 全量扫描（每个语言点一个），外加被选中的
    // 时间型 rendition（audio）。issue 对每个 rendition 只发一次。
    const verdictByRenditionKey = new Map<string, MediaTimingVerdict>();
    for (const rendition of input.source.renditions) {
      const isVideo = rendition.modality === 'video';
      const isTimeMedia =
        rendition.carrierType === 'asset' &&
        (rendition.modality === 'video' || rendition.modality === 'audio');
      const isUsed = usedRenditionKeys.has(rendition.renditionKey);
      // 视频 rendition 全量扫描（ALN-7）；其余只在被 σ 选中且是时间型资产时检查。
      if (!isVideo && !(isUsed && isTimeMedia)) continue;
      const verdict = evaluateMediaTiming(rendition, context);
      verdictByRenditionKey.set(rendition.renditionKey, verdict);
      if (!verdict.ok && verdict.issue !== undefined) {
        g2Issues.push(verdict.issue);
        if (isVideo) {
          planGaps.push({
            invariant: 'ALN-7',
            status: 'blocked',
            message: verdict.issue.message,
            renditionKey: rendition.renditionKey,
            details: verdict.issue.details,
          });
        }
      }
      if (isVideo) {
        const hasVerifiedAlignment = (
          context.alignmentsByRendition.get(rendition.renditionKey) ?? []
        ).some(
          (alignment) =>
            evaluateAlignmentEffectiveStatus(alignment, context).status ===
            'verified',
        );
        if (!hasVerifiedAlignment) {
          const message =
            'video rendition has no verified alignment to any stage; ALN-7 requires a machine timing source and a verified alignment for every video rendition × language';
          g2Issues.push(
            makeIssue('incomplete', 'ALIGNMENT_UNBOUND', message, 'ALN-7', {
              renditionKey: rendition.renditionKey,
            }),
          );
          planGaps.push({
            invariant: 'ALN-7',
            status: 'blocked',
            message,
            renditionKey: rendition.renditionKey,
          });
        }
      }
    }

    const emittedPlacementIssues = new Set<string>();
    for (const draft of drafts) {
      const selected: SelectedPlacement[] = [];
      const stageGaps: StageSelectionGap[] = [...draft.gaps];
      const addStageGap = (gap: StageSelectionGap): void => {
        const exists = stageGaps.some(
          (existing) =>
            existing.reason === gap.reason && existing.status === gap.status,
        );
        if (!exists) stageGaps.push(gap);
      };

      for (const winner of draft.winners) {
        const { alignment, rendition } = winner;
        if (alignment.role === 'assessment') {
          selected.push({
            alignment,
            rendition,
            placement: {
              type: 'assessment',
              contentKey: rendition.contentKey,
              blockIds: [rendition.blockId],
            },
            status: 'ok',
          });
          continue;
        }
        if (rendition.carrierType === 'document') {
          selected.push({
            alignment,
            rendition,
            placement: {
              type: 'document',
              documentKey: rendition.carrierKey,
              documentVersion: rendition.carrierVersion,
              ...(rendition.headingCode === undefined
                ? {}
                : { headingCode: rendition.headingCode }),
              ...(rendition.offset === undefined
                ? {}
                : { offset: rendition.offset }),
            },
            status: 'ok',
          });
          continue;
        }

        // asset 载体：必须有机器时间源、可探测时长与合法半开区间。
        const verdict =
          verdictByRenditionKey.get(rendition.renditionKey) ??
          evaluateMediaTiming(rendition, context);
        if (!verdict.ok) {
          const message =
            verdict.issue?.message ??
            'media rendition cannot be placed without a machine timing source';
          selected.push({
            alignment,
            rendition,
            placement: { type: 'gap', reason: 'TIM-1' },
            status: 'blocked',
          });
          addStageGap({ reason: 'TIM-1', status: 'blocked', message });
          continue;
        }
        if (rendition.startMs === undefined || rendition.endMs === undefined) {
          // evaluateMediaTiming 已覆盖；防御性兜底，不产出无坐标的 media placement。
          selected.push({
            alignment,
            rendition,
            placement: { type: 'gap', reason: 'TIM-1' },
            status: 'blocked',
          });
          addStageGap({
            reason: 'TIM-1',
            status: 'blocked',
            message: 'media rendition has no [startMs, endMs) coordinates',
          });
          continue;
        }
        selected.push({
          alignment,
          rendition,
          placement: {
            type: 'media',
            assetKey: asAssetKey(rendition.carrierKey),
            assetVersion: rendition.carrierVersion,
            startMs: rendition.startMs,
            endMs: rendition.endMs,
          },
          status: 'ok',
        });
      }

      // 非时间型 asset 载体（如 text 模态落在 asset 上）没有可表达 placement 的
      // 坐标源（TIM-1）：若被 σ 选中则显式 blocked，每 rendition 报一次。
      for (const selectedEntry of selected) {
        if (selectedEntry.placement.type !== 'gap') continue;
        const rendition = selectedEntry.rendition;
        const key = rendition.renditionKey;
        if (
          rendition.modality === 'video' ||
          rendition.modality === 'audio' ||
          emittedPlacementIssues.has(key)
        ) {
          continue;
        }
        emittedPlacementIssues.add(key);
        g2Issues.push(
          makeIssue(
            'incomplete',
            'TIMING_SOURCE_MISSING',
            'asset carrier without a media/document coordinate source cannot be placed (TIM-1: no guessing)',
            'TIM-1',
            { renditionKey: key, modality: rendition.modality },
          ),
        );
      }

      selections.push({ stage: draft.stage, selected, gaps: stageGaps });
    }
  }

  const issues = [...g1Issues, ...g2Issues];
  const g1: GateReport = {
    gate: 'G1',
    passed: g1Issues.every((issue) => !issueBlocking(issue)),
    issues: g1Issues,
  };
  const g2: GateReport = {
    gate: 'G2',
    passed: g2Issues.every((issue) => !issueBlocking(issue)),
    issues: g2Issues,
  };
  return { linearization, selections, issues, gaps: planGaps, g1, g2 };
}
