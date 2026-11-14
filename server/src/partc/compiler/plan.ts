import {
  LOCALE_PATTERN,
  PlanBodySchema,
  STABLE_KEY_PATTERN,
  derivePlanEntryId,
  derivePlanId,
  planBodyBytes,
} from '../contracts';
import type {
  DeliveryModality,
  PlanBody,
  PlanEntry,
  PlanWarning,
} from '../contracts';
import { PartCError } from '../errors';
import {
  PLAN_MACHINE_TIMING_SOURCES,
  PLAN_ROLE_ORDER,
  evaluatePlanInvariants,
} from './invariants';
import type {
  MediaAssetTimingInfo,
  PlanGap,
  PlanInvariantReport,
  PlanSource,
  PlanTarget,
  RenditionTimingSourcePin,
  StageSelection,
  StageSelectionGap,
} from './invariants';
import type { LinearizeResult } from './linearize';
import { detectUnsupportedOrdering } from './parse';
import type { CompilerIssue } from './parse';

/**
 * Part C 编译器 P5：compilePlan（设计 §14 C5 P5、C6、C4、C7）。
 *
 * - 纯函数：输入闭包与内容全显式；不读时钟、不发 IO、不用随机数、不依赖 locale。
 * - 检查 STR/ALN/TIM/PLN 与发布门 G1–G3（G1 契约闭合；G2 结构+覆盖+证据绑定；
 *   G3 确定性+预算）。任一阻塞 → status=blocked 并输出显式 gap。
 * - λ：交付叶偏序的唯一规范线性延伸（linearize.ts，STR-3）。
 * - σ：target 过滤（语言显式回退链 + modality）→ role 次序 → occurrence →
 *   renditionKey tie-break（invariants.ts）。每个交付叶至少一个 entry：
 *   有材料则 ok/degraded placement，缺材料则 gap（ALN-1/2/4/6/TIM-1）。
 * - canonical Plan（C6）：bytes 只含确定性内容，不含 status/时间戳/随机/locale；
 *   planId = (courseKey, contentVersionId, targetId, planVersion) 显式派生；
 *   同输入重编译 bytes 相等（PLN-1，golden 锁定）。
 * - PlanEntry.orderKey = `{λ名次}.{阶段内序号}`（6 位零填充路径段），保证
 *   entries 按线性延伸严格升序；stageKey 通过 entry.stageKey 保留。
 *
 * v1 不支持的排序语义（choice/multi-target）显式拒绝：resolvedChoices 非空抛
 * UNSUPPORTED_ORDERING（C5 P5 冻结错误码）；多 target 不在输入形状内表达。
 */

export const PLAN_RULE_VERSION = 'plan-rules-v1' as const;
export const PLAN_COMPILER_VERSION = 'plan-compiler-v1' as const;

/**
 * 编译器调用方违反了 CompilePlanInput 的显式契约（标量形态非法）。
 * 内容层面的缺陷不抛错，而是进入 blocked + issues/gaps（C4「违反即 blocked」）。
 */
export class PlanInputError extends Error {
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PlanInputError';
    this.details = details;
  }
}

export interface CompilePlanInput {
  readonly content: PlanSource;
  readonly target: PlanTarget;
  readonly contentVersionId: string;
  /** 单调递增（C6）；本次编译产出的显式版本号。 */
  readonly planVersion: number;
  /** 结构修订计数器（C6 inputClosure）。 */
  readonly structureRevision: number;
  /** verified/rejected/stale 影响对齐集时 +1 的单调计数器（C6）。 */
  readonly alignmentSetVersion: number;
  /** 容器探测出的媒体资产（durationMs 用于 TIM-1 范围校验）。 */
  readonly mediaAssets?: readonly MediaAssetTimingInfo[];
  /** rendition → 机器时间源审计 pin（ALN-7；ASR/强制对齐必须携带）。 */
  readonly timingSources?: readonly RenditionTimingSourcePin[];
  /** v1 必须为空；非空 → UNSUPPORTED_ORDERING（choice 容器延后）。 */
  readonly resolvedChoices?: readonly string[];
  /** 规则版本 pin；缺省用本模块常量（不同值 ⇒ 不同 inputClosure ⇒ 不同 bytes）。 */
  readonly ruleVersion?: string;
  readonly compilerVersion?: string;
}

export interface PublishGateReport {
  readonly gate: 'G1' | 'G2' | 'G3';
  readonly passed: boolean;
  readonly issues: readonly CompilerIssue[];
}

/** 规则轨迹（确定性、可审阅；不进 canonical bytes）。 */
export interface PlanRuleTrace {
  readonly ruleVersion: string;
  readonly compilerVersion: string;
  readonly roleOrder: readonly string[];
  readonly languageChain: readonly string[];
  readonly modalities: readonly DeliveryModality[];
  readonly timingSources: readonly string[];
  readonly linearization: {
    readonly leaves: readonly {
      readonly stageKey: string;
      readonly orderKey: string;
      readonly rank: number;
    }[];
    readonly edges: readonly {
      readonly fromStageKey: string;
      readonly toStageKey: string;
      readonly kind: string;
    }[];
  };
  readonly selection: readonly {
    readonly stageKey: string;
    readonly items: readonly {
      readonly entryId: string;
      readonly alignmentId: string;
      readonly renditionKey: string;
      readonly placementType: string;
      readonly status: string;
    }[];
  }[];
}

export interface CompilePlanResult {
  readonly body: PlanBody;
  /** canonical JSON bytes（比较用字节相等，不用摘要）。 */
  readonly bytes: string;
  readonly status: 'draft' | 'degraded' | 'blocked';
  readonly entries: readonly PlanEntry[];
  readonly warnings: readonly PlanWarning[];
  /** 显式 gap 台账（stage 级 gap 同时物化为 gap PlanEntry）。 */
  readonly gaps: readonly PlanGap[];
  readonly issues: readonly CompilerIssue[];
  readonly gates: readonly PublishGateReport[];
  readonly linearization: LinearizeResult;
  readonly ruleTrace: PlanRuleTrace;
}

// ---------------------------------------------------------------------------
// 标量验证（契约层形态）
// ---------------------------------------------------------------------------

function assertScalarContract(input: CompilePlanInput): void {
  if (!Number.isInteger(input.planVersion) || input.planVersion < 1) {
    throw new PlanInputError('planVersion must be a positive integer', {
      planVersion: input.planVersion,
    });
  }
  if (
    !Number.isInteger(input.structureRevision) ||
    input.structureRevision < 0
  ) {
    throw new PlanInputError(
      'structureRevision must be a non-negative integer',
      {
        structureRevision: input.structureRevision,
      },
    );
  }
  if (
    !Number.isInteger(input.alignmentSetVersion) ||
    input.alignmentSetVersion < 0
  ) {
    throw new PlanInputError(
      'alignmentSetVersion must be a non-negative integer (monotonic counter)',
      { alignmentSetVersion: input.alignmentSetVersion },
    );
  }
  if (!STABLE_KEY_PATTERN.test(input.contentVersionId)) {
    throw new PlanInputError('contentVersionId must be a stable token', {
      contentVersionId: input.contentVersionId,
    });
  }
  if (!STABLE_KEY_PATTERN.test(input.content.courseKey)) {
    throw new PlanInputError('content.courseKey must be a stable token', {
      courseKey: input.content.courseKey,
    });
  }
  if (!STABLE_KEY_PATTERN.test(input.target.targetId)) {
    throw new PlanInputError('target.targetId must be a stable token', {
      targetId: input.target.targetId,
    });
  }
  if (input.target.languages.length === 0) {
    throw new PlanInputError(
      'target.languages must be a non-empty fallback chain',
    );
  }
  for (const language of input.target.languages) {
    if (!LOCALE_PATTERN.test(language)) {
      throw new PlanInputError('target.languages must be locale keys', {
        language,
      });
    }
  }
  if (input.target.modalities.length === 0) {
    throw new PlanInputError('target.modalities must be non-empty');
  }
  for (const modality of input.target.modalities) {
    if (modality !== 'video' && modality !== 'text') {
      throw new PlanInputError('target.modalities must contain video|text', {
        modality,
      });
    }
  }
  const ruleVersion = input.ruleVersion ?? PLAN_RULE_VERSION;
  if (ruleVersion.length === 0) {
    throw new PlanInputError('ruleVersion must be a non-empty string');
  }
  const compilerVersion = input.compilerVersion ?? PLAN_COMPILER_VERSION;
  if (compilerVersion.length === 0) {
    throw new PlanInputError('compilerVersion must be a non-empty string');
  }
}

// ---------------------------------------------------------------------------
// inputClosure 规范化（排序 + 去重；重复本身由 G1 报错）
// ---------------------------------------------------------------------------

function canonicalSpecPins(content: PlanSource): PlanSource['specPins'] {
  const sorted = [...content.specPins].sort((left, right) => {
    if (left.contentKey !== right.contentKey) {
      return left.contentKey < right.contentKey ? -1 : 1;
    }
    return left.version - right.version;
  });
  const seen = new Set<string>();
  return sorted.filter((pin) => {
    if (seen.has(pin.contentKey)) return false;
    seen.add(pin.contentKey);
    return true;
  });
}

function canonicalAssetPins(content: PlanSource): PlanSource['assetPins'] {
  const sorted = [...content.assetPins].sort((left, right) => {
    if (left.assetKey !== right.assetKey) {
      return left.assetKey < right.assetKey ? -1 : 1;
    }
    return left.assetVersion - right.assetVersion;
  });
  const seen = new Set<string>();
  return sorted.filter((pin) => {
    if (seen.has(pin.assetKey)) return false;
    seen.add(pin.assetKey);
    return true;
  });
}

// ---------------------------------------------------------------------------
// PlanEntry 物化
// ---------------------------------------------------------------------------

function padSegment(value: number): string {
  return String(value).padStart(6, '0');
}

function entryOrderKey(rank: number, ordinal: number): string {
  return `${padSegment(rank)}.${padSegment(ordinal)}`;
}

/** gap entry 的显式 id：entry:{stageKey}:gap:{reason}（无摘要、无随机）。 */
export function deriveGapEntryId(stageKey: string, reason: string): string {
  return `entry:${stageKey}:gap:${reason}`;
}

type SelectionTraceItem = PlanRuleTrace['selection'][number]['items'][number];

interface MaterializedStage {
  readonly entries: PlanEntry[];
  readonly gaps: PlanGap[];
  readonly warnings: PlanWarning[];
  readonly traceItems: readonly SelectionTraceItem[];
}

const GAP_STATUS_ORDER: Readonly<Record<'blocked' | 'degraded', number>> = {
  blocked: 0,
  degraded: 1,
};

function materializeStage(
  selection: StageSelection,
  rank: number,
): MaterializedStage {
  const entries: PlanEntry[] = [];
  const gaps: PlanGap[] = [];
  const warnings: PlanWarning[] = [];
  const traceItems: SelectionTraceItem[] = [];
  let ordinal = 0;

  for (const selected of selection.selected) {
    ordinal += 1;
    const entryId = derivePlanEntryId({
      stageKey: selection.stage.stageKey,
      alignmentId: selected.alignment.alignmentId,
      occurrenceKey: selected.rendition.occurrenceKey,
    });
    const entry: PlanEntry = {
      entryId,
      stageKey: selection.stage.stageKey,
      alignmentId: selected.alignment.alignmentId,
      orderKey: entryOrderKey(rank, ordinal),
      placement: selected.placement,
      status: selected.status === 'blocked' ? 'blocked' : 'ok',
    };
    entries.push(entry);
    traceItems.push({
      entryId,
      alignmentId: entry.alignmentId,
      renditionKey: selected.rendition.renditionKey,
      placementType: entry.placement.type,
      status: entry.status,
    });
  }

  // stage 级 gap → 显式 gap entry（只保留每个 reason 的最强状态；同 reason 的
  // blocked 优先于 degraded）。排序保证确定性的 entryId/orderKey。
  const gapByReason = new Map<string, StageSelectionGap>();
  for (const gap of selection.gaps) {
    const existing = gapByReason.get(gap.reason);
    if (
      existing === undefined ||
      GAP_STATUS_ORDER[gap.status] < GAP_STATUS_ORDER[existing.status]
    ) {
      gapByReason.set(gap.reason, gap);
    }
  }
  const orderedGaps = [...gapByReason.values()].sort((left, right) => {
    if (left.reason !== right.reason)
      return left.reason < right.reason ? -1 : 1;
    return GAP_STATUS_ORDER[left.status] - GAP_STATUS_ORDER[right.status];
  });
  for (const gap of orderedGaps) {
    ordinal += 1;
    const entryId = deriveGapEntryId(selection.stage.stageKey, gap.reason);
    entries.push({
      entryId,
      stageKey: selection.stage.stageKey,
      // gap 不引用任何对齐/occurrence；占位符仍满足 entryId 的显式格式。
      alignmentId: 'gap',
      orderKey: entryOrderKey(rank, ordinal),
      placement: { type: 'gap', reason: gap.reason },
      status: gap.status,
    });
    const planGap: PlanGap = {
      invariant: gap.reason,
      status: gap.status,
      message: gap.message,
      stageKey: selection.stage.stageKey,
      entryId,
      reason: gap.reason,
      ...(gap.details === undefined ? {} : { details: gap.details }),
    };
    gaps.push(planGap);
    if (gap.status === 'degraded') {
      warnings.push({
        code: 'DEGRADED_PLACEMENT',
        stageKey: selection.stage.stageKey,
        entryId,
      });
    }
    traceItems.push({
      entryId,
      alignmentId: 'gap',
      renditionKey: '',
      placementType: 'gap',
      status: gap.status,
    });
  }

  return { entries, gaps, warnings, traceItems };
}

function compareWarnings(left: PlanWarning, right: PlanWarning): number {
  if (left.code !== right.code) return left.code < right.code ? -1 : 1;
  const leftStage = left.stageKey ?? '';
  const rightStage = right.stageKey ?? '';
  if (leftStage !== rightStage) return leftStage < rightStage ? -1 : 1;
  const leftEntry = left.entryId ?? '';
  const rightEntry = right.entryId ?? '';
  if (leftEntry !== rightEntry) return leftEntry < rightEntry ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// G3：确定性 + 预算
// ---------------------------------------------------------------------------

function checkGateG3(
  body: PlanBody,
  bytes: string,
  selections: readonly StageSelection[],
  entries: readonly PlanEntry[],
): { gate: PublishGateReport; gaps: readonly PlanGap[] } {
  const issues: CompilerIssue[] = [];
  const gaps: PlanGap[] = [];

  // 确定性（PLN-1）：canonical bytes 必须可被同一 schema 解析且重序列化字节不变；
  // 任何 status/时间戳/随机/locale 字段都会被 strict schema 拒绝。
  const reparsed = PlanBodySchema.safeParse(JSON.parse(bytes) as unknown);
  if (!reparsed.success || planBodyBytes(reparsed.data) !== bytes) {
    issues.push({
      severity: 'error',
      code: 'CONTENT_INCOMPLETE',
      message:
        'canonical plan bytes are not stable under schema re-serialization (PLN-1)',
      invariant: 'PLN-1',
    });
  }

  // 预算（C7/G3）：durationBudget 只对媒体求和校验，不估算任何非媒体时长。
  const entriesByStage = new Map<string, PlanEntry[]>();
  for (const entry of entries) {
    const list = entriesByStage.get(entry.stageKey) ?? [];
    list.push(entry);
    entriesByStage.set(entry.stageKey, list);
  }
  const selectionByStage = new Map<string, StageSelection>(
    selections.map((selection) => [selection.stage.stageKey, selection]),
  );
  for (const [stageKey, stageEntries] of entriesByStage) {
    const selection = selectionByStage.get(stageKey);
    const budget = selection?.stage.durationBudget;
    if (budget === undefined) continue;
    let mediaMs = 0;
    for (const entry of stageEntries) {
      if (entry.placement.type !== 'media') continue;
      mediaMs += entry.placement.endMs - entry.placement.startMs;
    }
    if (mediaMs > budget) {
      const message = `stage media placements total ${mediaMs}ms, exceeding durationBudget ${budget}ms`;
      issues.push({
        severity: 'incomplete',
        code: 'CONTENT_INCOMPLETE',
        message,
        invariant: 'G3',
        details: { stageKey, mediaMs, budget },
      });
      gaps.push({
        invariant: 'G3',
        status: 'blocked',
        message,
        stageKey,
        details: { mediaMs, budget },
      });
    }
  }

  return {
    gate: {
      gate: 'G3',
      passed: issues.every(
        (issue) =>
          issue.severity !== 'error' && issue.severity !== 'incomplete',
      ),
      issues,
    },
    gaps,
  };
}

// ---------------------------------------------------------------------------
// compilePlan
// ---------------------------------------------------------------------------

/**
 * compilePlan：inputClosure + 内容 → canonical Plan（C5 P5 / C6）。
 *
 * preview 与 save 走同一函数：save 侧对重算结果比较 canonical bytes（apply.ts）。
 */
export function compilePlan(input: CompilePlanInput): CompilePlanResult {
  assertScalarContract(input);

  // v1.1 choice 容器延后（C0）：复用 P1 parse 的同一标记扫描器（一个语义一个
  // 检查器），内容侧出现任何 choice 标记都整体拒绝。
  const choicePaths = detectUnsupportedOrdering({ content: input.content });
  if (choicePaths.length > 0) {
    throw new PartCError(
      'UNSUPPORTED_ORDERING',
      'v1 does not support choice containers in the content tree',
      { choicePaths },
    );
  }

  const resolvedChoices = input.resolvedChoices ?? [];
  if (resolvedChoices.length > 0) {
    throw new PartCError(
      'UNSUPPORTED_ORDERING',
      'v1 does not support choice containers or resolved choice sets',
      { resolvedChoices: [...resolvedChoices] },
    );
  }

  const ruleVersion = input.ruleVersion ?? PLAN_RULE_VERSION;
  const compilerVersion = input.compilerVersion ?? PLAN_COMPILER_VERSION;

  const report: PlanInvariantReport = evaluatePlanInvariants({
    source: input.content,
    target: input.target,
    ...(input.mediaAssets === undefined
      ? {}
      : { mediaAssets: input.mediaAssets }),
    ...(input.timingSources === undefined
      ? {}
      : { timingSources: input.timingSources }),
  });

  const identity = {
    courseKey: input.content.courseKey,
    contentVersionId: input.contentVersionId,
    targetId: input.target.targetId,
    planVersion: input.planVersion,
  };
  const planId = derivePlanId(identity);

  const entries: PlanEntry[] = [];
  const stageGaps: PlanGap[] = [];
  const warningList: PlanWarning[] = [];
  const traceSelections: PlanRuleTrace['selection'][number][] = [];

  const selections = report.linearization.ok ? report.selections : [];
  const rankByStageKey = new Map(
    report.linearization.leaves.map((leaf) => [leaf.stageKey, leaf.rank]),
  );
  for (const selection of selections) {
    const rank = rankByStageKey.get(selection.stage.stageKey);
    if (rank === undefined) continue; // defensive; linearization.ok guarantees a rank
    const materialized = materializeStage(selection, rank);
    entries.push(...materialized.entries);
    stageGaps.push(...materialized.gaps);
    warningList.push(...materialized.warnings);
    if (materialized.traceItems.length > 0) {
      traceSelections.push({
        stageKey: selection.stage.stageKey,
        items: materialized.traceItems,
      });
    }
  }

  // recommends 只出 warning（STR-7），不进 bytes 的排序语义。
  for (const warning of report.linearization.warnings) {
    const toStageKey =
      typeof warning.details?.toStageKey === 'string'
        ? warning.details.toStageKey
        : undefined;
    warningList.push({
      code: 'PREREQUISITE_RECOMMENDS',
      ...(toStageKey === undefined ? {} : { stageKey: toStageKey }),
    });
  }
  const warnings = warningList.sort(compareWarnings);

  entries.sort((left, right) => {
    if (left.orderKey !== right.orderKey) {
      return left.orderKey < right.orderKey ? -1 : 1;
    }
    return left.entryId < right.entryId ? -1 : 1;
  });

  const inputClosure = {
    courseKey: input.content.courseKey,
    structureRevision: input.structureRevision,
    specPins: canonicalSpecPins(input.content),
    assetPins: canonicalAssetPins(input.content),
    alignmentSetVersion: input.alignmentSetVersion,
    targetId: input.target.targetId,
    resolvedChoices: [],
    ruleVersion,
    compilerVersion,
  };

  const body = PlanBodySchema.parse({
    planId,
    contentVersionId: input.contentVersionId,
    targetId: input.target.targetId,
    planVersion: input.planVersion,
    inputClosure,
    entries,
    warnings,
    compilerVersion,
    ruleVersion,
  });
  const bytes = planBodyBytes(body);

  const g3 = checkGateG3(body, bytes, selections, entries);

  const gates: PublishGateReport[] = [report.g1, report.g2, g3.gate];
  const blocked =
    gates.some((gate) => !gate.passed) ||
    body.entries.some((entry) => entry.status === 'blocked');
  const degraded = body.entries.some((entry) => entry.status === 'degraded');
  const status: CompilePlanResult['status'] = blocked
    ? 'blocked'
    : degraded
      ? 'degraded'
      : 'draft';

  const gaps: PlanGap[] = [...stageGaps, ...report.gaps, ...g3.gaps];

  const ruleTrace: PlanRuleTrace = {
    ruleVersion,
    compilerVersion,
    roleOrder: [...PLAN_ROLE_ORDER],
    languageChain: [...input.target.languages],
    modalities: [...input.target.modalities],
    timingSources: [...PLAN_MACHINE_TIMING_SOURCES],
    linearization: {
      leaves: report.linearization.leaves.map((leaf) => ({
        stageKey: leaf.stageKey,
        orderKey: leaf.orderKey,
        rank: leaf.rank,
      })),
      edges: report.linearization.edges.map((edge) => ({
        fromStageKey: edge.fromStageKey,
        toStageKey: edge.toStageKey,
        kind: edge.kind,
      })),
    },
    selection: traceSelections,
  };

  return {
    body,
    bytes,
    status,
    entries: body.entries,
    warnings: body.warnings,
    gaps,
    issues: [...report.issues, ...g3.gate.issues],
    gates,
    linearization: report.linearization,
    ruleTrace,
  };
}
