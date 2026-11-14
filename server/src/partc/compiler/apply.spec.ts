import type {
  ContentVersion,
  ContentVersionContent,
  PlanApproval,
  PlanRecord,
} from '../contracts';
import { PartCError } from '../errors';
import {
  PlanApplyError,
  applyApprovedPlan,
  assertPlanPreviewCurrent,
  buildFrozenContentVersion,
  checkApplyEligibility,
  checkFreezeMatchesClosure,
  freezeContentFromSnapshot,
  savePlan,
} from './apply';
import type {
  ApplyApprovedPlanInput,
  FreezeInput,
  PlanApplyPort,
  PlanApplyTransaction,
  PlanLivePointer,
  PlanSourceSnapshot,
  StoredPlan,
} from './apply';
import { compilePlan } from './plan';
import type { CompilePlanResult } from './plan';
import {
  FIXTURE_COURSE_KEY,
  buildCompilePlanInput,
  buildPlanFixtureArrays,
} from './plan.fixtures';
import type { LooseRecord } from './plan.fixtures';

/**
 * P6 save/apply/publish 单元测试（设计 §14 C5 P6、C6、C4 G3–G5）。
 *
 * 覆盖：preview bytes 相等（PLAN_PREVIEW_STALE）、PlanApproval 绑定与
 * acceptedWarnings 显式一致、冻结内容与 inputClosure 一致、单事务原子性
 * （live 指针失败即整体回滚）、幂等（already-applied 不回拨线上指针）、
 * 版本冲突不覆盖。
 *
 * 评审阻断 8（明确要求修改本文件的断言）：apply 门不再接受外部传入的
 * PlanRecord/PlanApproval/冻结内容；Plan 与最新审批从事务端口读 DB，
 * 内容由同一 inputClosure 重算，重算 bytes 不等 ⇒ PLAN_INPUT_CHANGED
 * （原断言为 PLAN_PREVIEW_STALE，属评审要求的行为变更）。
 */

const FROZEN_AT = '2026-11-12T10:00:00Z';

function compileHappy(): CompilePlanResult {
  return compilePlan(buildCompilePlanInput());
}

function storedPlanFor(
  result: CompilePlanResult,
  status: PlanRecord['status'] = 'approved',
): StoredPlan {
  return {
    record: { ...result.body, status },
    canonicalJson: result.bytes,
  };
}

function approvalFor(
  plan: PlanRecord,
  overrides: Partial<PlanApproval> = {},
): PlanApproval {
  return {
    planId: plan.planId,
    planVersion: plan.planVersion,
    decision: 'approved',
    approvedBy: 'editor-1',
    approvedAt: FROZEN_AT,
    acceptedWarnings: plan.warnings,
    ...overrides,
  };
}

function sourceSnapshot(): PlanSourceSnapshot {
  const fixture = buildPlanFixtureArrays();
  return {
    source: {
      courseKey: FIXTURE_COURSE_KEY,
      stages: fixture.stages,
      prerequisiteEdges: fixture.prerequisiteEdges,
      renditions: fixture.renditions,
      alignments: fixture.alignments,
      evidenceSpecs: fixture.evidenceSpecs,
      specPins: fixture.specPins,
      assetPins: fixture.assetPins,
    },
    mediaAssets: fixture.mediaAssets,
    timingSources: fixture.timingSources,
    target: fixture.target,
    categoryPath: null,
    // 与 buildCompilePlanInput 的闭包计数器一致（夹具用显式值，不用集合计数）。
    structureRevision: fixture.structureRevision,
    alignmentSetVersion: fixture.alignmentSetVersion,
  } as unknown as PlanSourceSnapshot;
}

function freezeContent(): ContentVersionContent {
  const fixture = buildPlanFixtureArrays();
  return {
    courseKey: FIXTURE_COURSE_KEY,
    versionNo: 1,
    categoryPath: null,
    stages: fixture.stages,
    prerequisiteEdges: fixture.prerequisiteEdges,
    specPins: fixture.specPins,
    renditions: fixture.renditions,
    alignments: fixture.alignments,
    evidenceSpecs: fixture.evidenceSpecs,
    assetPins: fixture.assetPins,
  } as unknown as ContentVersionContent;
}

function freezeInput(overrides: Partial<FreezeInput> = {}): FreezeInput {
  return {
    content: freezeContent(),
    contentVersionId: 'cv-frozen-1',
    versionNo: 1,
    frozenAt: FROZEN_AT,
    ...overrides,
  };
}

interface FakePortState {
  plans: StoredPlan[];
  approvals: PlanApproval[];
  versions: ContentVersion[];
  pointers: PlanLivePointer[];
  transactions: number;
}

interface FakePortOptions {
  failOnPointer?: boolean;
  /** 覆盖 loadPlanInput 返回（用于模拟 pins 相同但树被替换）。 */
  snapshot?: PlanSourceSnapshot;
  /** 覆盖 findPlan（默认按 planId/planVersion 查 plans）。 */
  planOverride?: StoredPlan | null;
  /** 覆盖 findLatestApproval（默认取 approvals 最后一条）。 */
  latestApprovalOverride?: PlanApproval | null;
}

function createFakePort(options: FakePortOptions = {}): {
  state: FakePortState;
  port: PlanApplyPort;
} {
  const state: FakePortState = {
    plans: [],
    approvals: [],
    versions: [],
    pointers: [],
    transactions: 0,
  };
  const port: PlanApplyPort = {
    async runInTransaction(work) {
      state.transactions += 1;
      const staged: FakePortState = {
        plans: [...state.plans],
        approvals: [...state.approvals],
        versions: [...state.versions],
        pointers: [...state.pointers],
        transactions: state.transactions,
      };
      const transaction: PlanApplyTransaction = {
        findPlan(input: {
          planId: string;
          planVersion: number;
        }): Promise<StoredPlan | null> {
          if (options.planOverride !== undefined) {
            return Promise.resolve(options.planOverride);
          }
          return Promise.resolve(
            staged.plans.find(
              (stored) =>
                stored.record.planId === input.planId &&
                stored.record.planVersion === input.planVersion,
            ) ?? null,
          );
        },
        findLatestApproval(input: {
          planId: string;
          planVersion: number;
        }): Promise<PlanApproval | null> {
          if (options.latestApprovalOverride !== undefined) {
            return Promise.resolve(options.latestApprovalOverride);
          }
          const matching = staged.approvals.filter(
            (approval) =>
              approval.planId === input.planId &&
              approval.planVersion === input.planVersion,
          );
          return Promise.resolve(matching.at(-1) ?? null);
        },
        loadPlanInput(): Promise<PlanSourceSnapshot> {
          return Promise.resolve(options.snapshot ?? sourceSnapshot());
        },
        findContentVersion(input: {
          courseKey: string;
          versionNo: number;
        }): Promise<ContentVersion | null> {
          const found =
            staged.versions.find(
              (version) =>
                version.courseKey === input.courseKey &&
                version.versionNo === input.versionNo,
            ) ?? null;
          return Promise.resolve(found);
        },
        insertContentVersion(version: ContentVersion): Promise<void> {
          staged.versions.push(version);
          return Promise.resolve();
        },
        setLiveContentVersion(pointer: PlanLivePointer): Promise<void> {
          if (options.failOnPointer === true) {
            return Promise.reject(new Error('live pointer write failed'));
          }
          staged.pointers.push(pointer);
          return Promise.resolve();
        },
      };
      const result = await work(transaction);
      state.plans = staged.plans;
      state.approvals = staged.approvals;
      state.versions = staged.versions;
      state.pointers = staged.pointers;
      return result;
    },
  };
  return { state, port };
}

function seedApproved(
  state: FakePortState,
  result: CompilePlanResult = compileHappy(),
): StoredPlan {
  const stored = storedPlanFor(result);
  state.plans.push(stored);
  state.approvals.push(approvalFor(stored.record));
  return stored;
}

function applyInputFor(stored: StoredPlan): ApplyApprovedPlanInput {
  return {
    planId: stored.record.planId,
    planVersion: stored.record.planVersion,
    versionNo: 1,
    contentVersionId: stored.record.contentVersionId,
    frozenAt: FROZEN_AT,
  };
}

function readyApply(): {
  input: ApplyApprovedPlanInput;
  state: FakePortState;
  port: PlanApplyPort;
} {
  const { state, port } = createFakePort();
  const stored = seedApproved(state);
  return { input: applyInputFor(stored), state, port };
}

describe('P6 save：preview 与重算 bytes 相等（PLAN_PREVIEW_STALE）', () => {
  it('saves a draft record only when the preview bytes still match', () => {
    const recompiled = compileHappy();
    const saved = savePlan({
      preview: {
        planId: recompiled.body.planId,
        planVersion: recompiled.body.planVersion,
        bytes: recompiled.bytes,
      },
      recompiled,
    });
    expect(saved.bytes).toBe(recompiled.bytes);
    expect(saved.record.status).toBe('draft');
    expect(saved.record.planId).toBe(recompiled.body.planId);
  });

  it('refuses to save when the server-side recompute differs from the preview', () => {
    const preview = compileHappy();
    const recompiled = compilePlan({
      ...(buildCompilePlanInput() as unknown as Record<string, unknown>),
      planVersion: 2,
    } as never);
    let error: unknown;
    try {
      savePlan({
        preview: {
          planId: preview.body.planId,
          planVersion: preview.body.planVersion,
          bytes: preview.bytes,
        },
        recompiled,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PartCError);
    expect((error as PartCError).code).toBe('PLAN_PREVIEW_STALE');
  });

  it('accepts an unchanged preview', () => {
    const result = compileHappy();
    expect(() =>
      assertPlanPreviewCurrent(
        {
          planId: result.body.planId,
          planVersion: result.body.planVersion,
          bytes: result.bytes,
        },
        result.body,
      ),
    ).not.toThrow();
  });

  it('rejects changed bytes with PLAN_PREVIEW_STALE', () => {
    const result = compileHappy();
    let error: unknown;
    try {
      assertPlanPreviewCurrent(
        {
          planId: result.body.planId,
          planVersion: result.body.planVersion,
          bytes: '{"stale":true}',
        },
        result.body,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PartCError);
    expect((error as PartCError).code).toBe('PLAN_PREVIEW_STALE');
  });

  it('rejects a mismatched planVersion even before comparing bytes', () => {
    const result = compileHappy();
    let error: unknown;
    try {
      assertPlanPreviewCurrent(
        {
          planId: result.body.planId,
          planVersion: result.body.planVersion + 1,
          bytes: result.bytes,
        },
        result.body,
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as PartCError).code).toBe('PLAN_PREVIEW_STALE');
    expect((error as PartCError).details).toMatchObject({
      previewPlanVersion: result.body.planVersion + 1,
      currentPlanVersion: result.body.planVersion,
    });
  });
});

describe('P6 apply：资格、审批绑定与冻结一致性（G4/G5）', () => {
  it('passes eligibility for an approved plan with matching approval and warnings', () => {
    const plan = storedPlanFor(compileHappy()).record;
    expect(checkApplyEligibility(plan, approvalFor(plan))).toEqual([]);
    expect(checkFreezeMatchesClosure(plan, freezeContent())).toEqual([]);
  });

  it('refuses non-approved status and rejected decisions', () => {
    const result = compileHappy();
    const draft = { ...result.body, status: 'draft' } as unknown as PlanRecord;
    const refusals = checkApplyEligibility(
      draft,
      approvalFor(draft, { decision: 'rejected', acceptedWarnings: [] }),
    );
    expect(refusals.map((refusal) => refusal.code)).toEqual(
      expect.arrayContaining(['PLAN_NOT_APPROVED']),
    );
  });

  it('refuses an approval that binds another (planId, planVersion)', () => {
    const plan = storedPlanFor(compileHappy()).record;
    const refusals = checkApplyEligibility(
      plan,
      approvalFor(plan, { planVersion: plan.planVersion + 1 }),
    );
    expect(refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PLAN_APPROVAL_MISMATCH' }),
      ]),
    );
  });

  it('refuses when acceptedWarnings do not explicitly match the plan warnings', () => {
    const plan = storedPlanFor(compileHappy()).record;
    const missing = checkApplyEligibility(
      plan,
      approvalFor(plan, { acceptedWarnings: [] }),
    );
    expect(missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PLAN_WARNINGS_NOT_ACCEPTED' }),
      ]),
    );
    const extra = checkApplyEligibility(
      plan,
      approvalFor(plan, {
        acceptedWarnings: [
          ...plan.warnings,
          { code: 'DEGRADED_PLACEMENT', stageKey: 'step-9' },
        ],
      }),
    );
    expect(extra).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PLAN_WARNINGS_NOT_ACCEPTED' }),
      ]),
    );
  });

  it('refuses a frozen content whose pins differ from the inputClosure', () => {
    const plan = storedPlanFor(compileHappy()).record;
    const content = freezeContent();
    const tampered = {
      ...content,
      specPins: [{ contentKey: 'lesson-1', version: 2 }],
    } as unknown as ContentVersionContent;
    const refusals = checkFreezeMatchesClosure(plan, tampered);
    expect(refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FREEZE_CONTENT_MISMATCH' }),
      ]),
    );
  });

  it('refuses frozen stages/entries whose tree was swapped even when pins match (blocker 8)', () => {
    const plan = storedPlanFor(compileHappy()).record;
    const content = freezeContent();
    // pins 原样一致，但 stage 树被替换（step-3 被移出冻结树）。
    const tamperedStages = (content.stages as unknown as LooseRecord[]).filter(
      (stage) => stage.stageKey !== 'step-3',
    );
    const swapStages = {
      ...content,
      stages: tamperedStages,
    } as unknown as ContentVersionContent;
    const treeRefusals = checkFreezeMatchesClosure(plan, swapStages);
    expect(treeRefusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FREEZE_CONTENT_MISMATCH' }),
      ]),
    );

    // entry 指向不属于冻结树的 stage ⇒ 拒绝。
    const entries = plan.entries.map((entry, index) =>
      index === 0 ? { ...entry, stageKey: 'ghost-stage' } : entry,
    );
    const ghost = { ...plan, entries } as unknown as PlanRecord;
    const refusals = checkFreezeMatchesClosure(ghost, content);
    expect(refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FREEZE_CONTENT_MISMATCH' }),
      ]),
    );

    // entry 指向未冻结为 verified 的 alignment ⇒ 拒绝。
    const referencedAlignmentId = plan.entries.find(
      (entry) => entry.placement.type !== 'gap',
    )?.alignmentId;
    const badAlignment = (content.alignments as unknown as LooseRecord[]).map(
      (alignment) =>
        alignment.alignmentId === referencedAlignmentId
          ? { ...alignment, alignmentId: 'not-frozen' }
          : alignment,
    );
    const noAlignment = {
      ...content,
      alignments: badAlignment,
    } as unknown as ContentVersionContent;
    const alignmentRefusals = checkFreezeMatchesClosure(plan, noAlignment);
    expect(alignmentRefusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FREEZE_CONTENT_MISMATCH' }),
      ]),
    );
  });

  it('freezes ContentVersion with the approved planPin (G5)', () => {
    const plan = storedPlanFor(compileHappy()).record;
    const version = buildFrozenContentVersion(plan, freezeInput());
    expect(version.planPin).toEqual({
      planId: plan.planId,
      planVersion: plan.planVersion,
    });
    expect(version.contentVersionId).toBe('cv-frozen-1');
    expect(version.frozenAt).toBe(FROZEN_AT);
  });

  it('rejects freeze content carrying non-verified alignments (snapshot must be verified-only)', () => {
    const plan = storedPlanFor(compileHappy()).record;
    const content = freezeContent();
    const proposed = (content.alignments as unknown as LooseRecord[]).map(
      (alignment) => ({
        ...alignment,
        status: 'proposed',
        verifiedBy: undefined,
        verifiedAt: undefined,
        verifiedAgainst: undefined,
      }),
    );
    expect(() =>
      buildFrozenContentVersion(plan, {
        ...freezeInput(),
        content: {
          ...content,
          alignments: proposed,
        } as unknown as ContentVersionContent,
      }),
    ).toThrow();
  });
});

describe('P6 apply/publish：单事务写 ContentVersion + planPin + live 指针', () => {
  it('applies an approved DB plan in a single transaction', async () => {
    const { input, state, port } = readyApply();
    const result = await applyApprovedPlan(input, port);
    expect(result).toEqual({
      status: 'applied',
      contentVersionId: input.contentVersionId,
      planId: input.planId,
      planVersion: input.planVersion,
      versionNo: 1,
    });
    expect(state.transactions).toBe(1);
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0].planPin).toEqual({
      planId: input.planId,
      planVersion: input.planVersion,
    });
    expect(state.pointers).toEqual([
      {
        courseKey: FIXTURE_COURSE_KEY,
        contentVersionId: input.contentVersionId,
        versionNo: 1,
      },
    ]);
  });

  it('is idempotent: a repeated apply is a no-op and never flips the live pointer back', async () => {
    const { input, state, port } = readyApply();
    await applyApprovedPlan(input, port);
    const second = await applyApprovedPlan(
      { ...input, frozenAt: '2026-11-13T08:00:00Z' },
      port,
    );
    expect(second.status).toBe('already-applied');
    expect(state.versions).toHaveLength(1);
    expect(state.pointers).toHaveLength(1);
  });

  it('refuses to overwrite a different version occupying the same (courseKey, versionNo)', async () => {
    const { input, state, port } = readyApply();
    await applyApprovedPlan(input, port);
    const other = compilePlan({
      ...(buildCompilePlanInput() as unknown as Record<string, unknown>),
      planVersion: 2,
    } as never);
    const otherStored = storedPlanFor(other);
    state.plans.push(otherStored);
    state.approvals.push(approvalFor(otherStored.record));
    // 版本号已占用：哪怕计划内容不同也不能覆盖（版本号是环境本地单调键）。
    let error: unknown;
    try {
      await applyApprovedPlan(applyInputFor(otherStored), port);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PlanApplyError);
    expect((error as PlanApplyError).refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'VERSION_CONFLICT' }),
      ]),
    );
    expect(state.versions).toHaveLength(1);
  });

  it('rolls back the whole transaction when the live pointer write fails', async () => {
    const { state, port } = createFakePort({ failOnPointer: true });
    const stored = seedApproved(state);
    await expect(
      applyApprovedPlan(applyInputFor(stored), port),
    ).rejects.toThrow('live pointer write failed');
    expect(state.transactions).toBe(1);
    expect(state.versions).toHaveLength(0);
    expect(state.pointers).toHaveLength(0);
  });

  it('refuses when the recomputed closure bytes differ (approval is stale) — PLAN_INPUT_CHANGED', async () => {
    // 模拟审核后内容变化：同一 inputClosure 的 rendition 坐标被改（pins 不变），
    // 重算出的 PlanEntry placement 与已批准原文不同。
    const snapshot = sourceSnapshot();
    const swapped = {
      ...snapshot,
      source: {
        ...snapshot.source,
        renditions: (
          snapshot.source.renditions as unknown as LooseRecord[]
        ).map((rendition) =>
          rendition.renditionKey === 'r-video-en'
            ? { ...rendition, endMs: 59000 }
            : rendition,
        ),
      },
    } as unknown as PlanSourceSnapshot;
    const tampered = createFakePort({ snapshot: swapped });
    const stored = seedApproved(tampered.state);
    let error: unknown;
    try {
      await applyApprovedPlan(applyInputFor(stored), tampered.port);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PartCError);
    expect((error as PartCError).code).toBe('PLAN_INPUT_CHANGED');
    expect(tampered.state.versions).toHaveLength(0);
  });

  it('refuses an unsaved/unknown plan instead of trusting a caller-supplied record (blocker 8)', async () => {
    const { state, port } = createFakePort({ planOverride: null });
    seedApproved(state);
    const result = compileHappy();
    let error: unknown;
    try {
      await applyApprovedPlan(
        {
          planId: result.body.planId,
          planVersion: result.body.planVersion,
          versionNo: 1,
          contentVersionId: result.body.contentVersionId,
          frozenAt: FROZEN_AT,
        },
        port,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PlanApplyError);
    expect((error as PlanApplyError).refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PLAN_NOT_APPROVED' }),
      ]),
    );
  });

  it('refuses when the latest decision is rejected even though an earlier decision was approved', async () => {
    const { state, port } = readyApply();
    const stored = state.plans[0];
    // 在较早 approved 之后追加一条 rejected：apply 只看最新决定。
    state.approvals.push(
      approvalFor(stored.record, {
        decision: 'rejected',
        acceptedWarnings: [],
      }),
    );
    let error: unknown;
    try {
      await applyApprovedPlan(applyInputFor(stored), port);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PlanApplyError);
    expect((error as PlanApplyError).refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PLAN_NOT_APPROVED' }),
      ]),
    );
    expect(state.versions).toHaveLength(0);
  });

  it('refuses a recomputed plan that is blocked', async () => {
    // 同一 source 少了 step-2 的 verified 对齐 ⇒ 重算 blocked ⇒ PLAN_BLOCKED。
    const snapshot = sourceSnapshot();
    const blockedSnapshot = {
      ...snapshot,
      source: {
        ...snapshot.source,
        alignments: (
          buildCompilePlanInput().content.alignments as unknown as LooseRecord[]
        ).filter((alignment) => alignment.stageKey !== 'step-2'),
      },
    } as unknown as PlanSourceSnapshot;
    const blockedPort = createFakePort({ snapshot: blockedSnapshot });
    const stored = seedApproved(blockedPort.state);
    let error: unknown;
    try {
      await applyApprovedPlan(applyInputFor(stored), blockedPort.port);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PlanApplyError);
    expect((error as PlanApplyError).refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PLAN_BLOCKED' }),
      ]),
    );
  });

  it('freezes content from the same DB source (freezeContentFromSnapshot uses closure pins)', () => {
    const stored = storedPlanFor(compileHappy());
    const content = freezeContentFromSnapshot(
      stored.record,
      sourceSnapshot(),
      1,
    );
    expect(content.specPins).toEqual(stored.record.inputClosure.specPins);
    expect(content.assetPins).toEqual(stored.record.inputClosure.assetPins);
    expect(
      content.alignments.every((alignment) => alignment.status === 'verified'),
    ).toBe(true);
  });

  it('excludes stale verified alignments from the frozen content (ALN-6)', () => {
    const stored = storedPlanFor(compileHappy());
    const base = sourceSnapshot();
    // a1 的 verifiedAgainst 与当前 rendition revision 不再匹配 ⇒ 读时 stale，
    // 不得进入冻结快照（否则 buildFrozenContentVersion 会拒绝整份内容）。
    const snapshot = {
      ...base,
      source: {
        ...base.source,
        alignments: base.source.alignments.map((alignment) => {
          if (
            alignment.alignmentId !== 'a1' ||
            alignment.verifiedAgainst === undefined
          ) {
            return alignment;
          }
          return {
            ...alignment,
            verifiedAgainst: {
              renditionRevision: 2,
              carrierVersion: alignment.verifiedAgainst.carrierVersion,
              specVersion: alignment.verifiedAgainst.specVersion,
            },
          };
        }),
      },
    } as unknown as PlanSourceSnapshot;
    const content = freezeContentFromSnapshot(stored.record, snapshot, 1);
    expect(content.alignments.map((a) => a.alignmentId)).not.toContain('a1');
  });
});
