import type { CompilePlanInput } from './plan';

/**
 * Plan 编译器测试夹具（P5/P6）。
 *
 * 结构：两棵 program 森林、三个交付叶；requires step-1 → step-3（与树序一致的
 * 先修）；recommends step-1 → step-3；同内容块双语言 rendition（en-GB / zh-CN）
 * 用于验证语言显式回退链；step-1/step-2 共用同一视频 rendition；assessment
 * 渲染用于 STR-5 证据绑定与 assessment placement。
 *
 * 塔尖口径：assetKey 环境无关、无任何摘要字段；时间坐标来自 subtitle/asr 的
 * 机器派生记录（timingSources pin 只描述来源，不在夹具里做人造时间输入——
 * 坐标值是派生结果，测试只验证编译器行为）。
 */

export const FIXTURE_COURSE_KEY = 'modeling-life';

function stages(): unknown[] {
  return [
    {
      courseKey: FIXTURE_COURSE_KEY,
      stageKey: 'program-1',
      parentStageKey: null,
      orderKey: '000001',
      kind: 'program',
      goal: 'First programme',
      objectiveKeys: [],
      exitEvidence: [],
      exitRollup: { kind: 'all' },
      status: 'active',
    },
    {
      courseKey: FIXTURE_COURSE_KEY,
      stageKey: 'step-1',
      parentStageKey: 'program-1',
      orderKey: '000001.000001',
      kind: 'step',
      goal: 'Watch the lesson',
      objectiveKeys: ['obj-1'],
      exitEvidence: ['ev-1'],
      exitRollup: { kind: 'all' },
      durationBudget: 180000,
      status: 'active',
    },
    {
      courseKey: FIXTURE_COURSE_KEY,
      stageKey: 'step-2',
      parentStageKey: 'program-1',
      orderKey: '000001.000002',
      kind: 'step',
      goal: 'Apply the lesson',
      objectiveKeys: ['obj-1'],
      exitEvidence: ['ev-1'],
      exitRollup: { kind: 'all' },
      durationBudget: 120000,
      status: 'active',
    },
    {
      courseKey: FIXTURE_COURSE_KEY,
      stageKey: 'program-2',
      parentStageKey: null,
      orderKey: '000002',
      kind: 'program',
      goal: 'Second programme',
      objectiveKeys: [],
      exitEvidence: [],
      exitRollup: { kind: 'all' },
      status: 'active',
    },
    {
      courseKey: FIXTURE_COURSE_KEY,
      stageKey: 'step-3',
      parentStageKey: 'program-2',
      orderKey: '000002.000001',
      kind: 'step',
      goal: 'Build the model',
      objectiveKeys: ['obj-2'],
      exitEvidence: ['ev-2'],
      exitRollup: { kind: 'all' },
      durationBudget: 61000,
      status: 'active',
    },
  ];
}

function prerequisiteEdges(): unknown[] {
  return [
    { fromStageKey: 'step-1', toStageKey: 'step-3', kind: 'requires' },
    { fromStageKey: 'step-1', toStageKey: 'step-3', kind: 'recommends' },
  ];
}

function renditions(): unknown[] {
  return [
    {
      renditionKey: 'r-video-en',
      contentKey: 'lesson-1',
      blockId: 'video',
      language: 'en-GB',
      modality: 'video',
      occurrenceKey: 'main',
      carrierType: 'asset',
      carrierKey: 'asset-video-en',
      carrierVersion: 1,
      startMs: 0,
      endMs: 60000,
      anchorSource: 'subtitle',
      revision: 1,
    },
    {
      renditionKey: 'r-video-zh',
      contentKey: 'lesson-1',
      blockId: 'video',
      language: 'zh-CN',
      modality: 'video',
      occurrenceKey: 'main',
      carrierType: 'asset',
      carrierKey: 'asset-video-zh',
      carrierVersion: 1,
      startMs: 0,
      endMs: 61000,
      // 默认夹具保持契约词表内的 anchorSource；ASR/forced-alignment 场景由测试
      // 显式改写（契约枚举补齐前，冻结 ContentVersion 只接受契约内取值）。
      anchorSource: 'subtitle',
      revision: 1,
    },
    {
      renditionKey: 'r-doc-en',
      contentKey: 'lesson-1',
      blockId: 'body',
      language: 'en-GB',
      modality: 'text',
      occurrenceKey: 'main',
      carrierType: 'document',
      carrierKey: 'doc-lesson-en',
      carrierVersion: 2,
      headingCode: 'H1',
      offset: 0,
      anchorSource: 'doc-structure',
      revision: 1,
    },
    {
      renditionKey: 'r-doc-zh',
      contentKey: 'lesson-1',
      blockId: 'body',
      language: 'zh-CN',
      modality: 'text',
      occurrenceKey: 'main',
      carrierType: 'document',
      carrierKey: 'doc-lesson-zh',
      carrierVersion: 1,
      headingCode: 'H1',
      offset: 0,
      anchorSource: 'doc-structure',
      revision: 1,
    },
    {
      renditionKey: 'r-test-en',
      contentKey: 'lesson-1.knowledge-test',
      blockId: 'q.1',
      language: 'en-GB',
      modality: 'text',
      occurrenceKey: 'main',
      carrierType: 'document',
      carrierKey: 'doc-test-en',
      carrierVersion: 1,
      anchorSource: 'doc-structure',
      revision: 1,
    },
    {
      renditionKey: 'r-test-zh',
      contentKey: 'lesson-1.knowledge-test',
      blockId: 'q.1',
      language: 'zh-CN',
      modality: 'text',
      occurrenceKey: 'main',
      carrierType: 'document',
      carrierKey: 'doc-test-zh',
      carrierVersion: 1,
      anchorSource: 'doc-structure',
      revision: 1,
    },
  ];
}

function verifiedAgainst(
  renditionRevision: number,
  carrierVersion: number,
  specVersion: number,
): Record<string, number> {
  return { renditionRevision, carrierVersion, specVersion };
}

function alignments(): unknown[] {
  return [
    {
      alignmentId: 'a1',
      stageKey: 'step-1',
      renditionKey: 'r-video-en',
      objectiveKey: 'obj-1',
      role: 'primary',
      status: 'verified',
      provenance: 'human',
      verifiedBy: 'editor-1',
      verifiedAt: '2026-11-10T09:00:00Z',
      verifiedAgainst: verifiedAgainst(1, 1, 1),
    },
    {
      alignmentId: 'a2',
      stageKey: 'step-1',
      renditionKey: 'r-video-zh',
      objectiveKey: 'obj-1',
      role: 'primary',
      status: 'verified',
      provenance: 'human',
      verifiedBy: 'editor-1',
      verifiedAt: '2026-11-10T09:01:00Z',
      verifiedAgainst: verifiedAgainst(1, 1, 1),
    },
    {
      alignmentId: 'a3',
      stageKey: 'step-1',
      renditionKey: 'r-doc-en',
      objectiveKey: 'obj-1',
      role: 'primary',
      status: 'verified',
      provenance: 'human',
      verifiedBy: 'editor-1',
      verifiedAt: '2026-11-10T09:02:00Z',
      verifiedAgainst: verifiedAgainst(1, 2, 1),
    },
    {
      alignmentId: 'a4',
      stageKey: 'step-1',
      renditionKey: 'r-doc-zh',
      objectiveKey: 'obj-1',
      role: 'primary',
      status: 'verified',
      provenance: 'human',
      verifiedBy: 'editor-1',
      verifiedAt: '2026-11-10T09:03:00Z',
      verifiedAgainst: verifiedAgainst(1, 1, 1),
    },
    {
      alignmentId: 'a5',
      stageKey: 'step-1',
      renditionKey: 'r-test-en',
      objectiveKey: 'obj-1',
      role: 'assessment',
      status: 'verified',
      provenance: 'human',
      verifiedBy: 'editor-1',
      verifiedAt: '2026-11-10T09:04:00Z',
      verifiedAgainst: verifiedAgainst(1, 1, 1),
    },
    {
      alignmentId: 'a6',
      stageKey: 'step-2',
      renditionKey: 'r-video-en',
      objectiveKey: 'obj-1',
      role: 'primary',
      status: 'verified',
      provenance: 'human',
      verifiedBy: 'editor-1',
      verifiedAt: '2026-11-10T09:05:00Z',
      verifiedAgainst: verifiedAgainst(1, 1, 1),
    },
    {
      alignmentId: 'a7',
      stageKey: 'step-3',
      renditionKey: 'r-video-zh',
      objectiveKey: 'obj-2',
      role: 'primary',
      status: 'verified',
      provenance: 'human',
      verifiedBy: 'editor-1',
      verifiedAt: '2026-11-10T09:06:00Z',
      verifiedAgainst: verifiedAgainst(1, 1, 1),
    },
    {
      alignmentId: 'a8',
      stageKey: 'step-3',
      renditionKey: 'r-test-zh',
      objectiveKey: 'obj-2',
      role: 'assessment',
      status: 'verified',
      provenance: 'human',
      verifiedBy: 'editor-1',
      verifiedAt: '2026-11-10T09:07:00Z',
      verifiedAgainst: verifiedAgainst(1, 1, 1),
    },
    {
      alignmentId: 'a9',
      stageKey: 'step-2',
      renditionKey: 'r-test-en',
      objectiveKey: 'obj-1',
      role: 'assessment',
      status: 'verified',
      provenance: 'human',
      verifiedBy: 'editor-1',
      verifiedAt: '2026-11-10T09:08:00Z',
      verifiedAgainst: verifiedAgainst(1, 1, 1),
    },
  ];
}

function evidenceSpecs(): unknown[] {
  return [
    {
      evidenceKey: 'ev-1',
      version: 1,
      kind: 'assessment',
      objectiveKeys: ['obj-1'],
      measure: {
        kind: 'assessment',
        contentKey: 'lesson-1.knowledge-test',
        blockIds: ['q.1'],
      },
      scoring: 'points',
      threshold: 0.6,
      attempts: 2,
    },
    {
      evidenceKey: 'ev-2',
      version: 1,
      kind: 'artifact',
      objectiveKeys: ['obj-2'],
      measure: { kind: 'artifact', instructions: 'Submit the exercise.' },
      scoring: 'pass-fail',
      threshold: 1,
      attempts: 1,
    },
  ];
}

function specPins(): unknown[] {
  return [
    { contentKey: 'lesson-1', version: 1 },
    { contentKey: 'lesson-1.knowledge-test', version: 1 },
  ];
}

function assetPins(): unknown[] {
  return [
    { assetKey: 'asset-video-en', assetVersion: 1 },
    { assetKey: 'asset-video-zh', assetVersion: 1 },
  ];
}

function mediaAssets(): unknown[] {
  return [
    { assetKey: 'asset-video-en', assetVersion: 1, durationMs: 60000 },
    { assetKey: 'asset-video-zh', assetVersion: 1, durationMs: 61000 },
  ];
}

function timingSources(): unknown[] {
  return [
    {
      renditionKey: 'r-video-en',
      sourceKind: 'subtitle',
      sourceArtifact: 'media/en-gb.srt',
      ruleVersion: 'timing-rules-v1',
    },
    {
      renditionKey: 'r-video-zh',
      sourceKind: 'subtitle',
      sourceArtifact: 'media/zh-cn.srt',
      ruleVersion: 'timing-rules-v1',
    },
  ];
}

function target(): unknown {
  return {
    targetId: 'target-zh',
    languages: ['zh-CN', 'en-GB'],
    modalities: ['video', 'text'],
  };
}

export interface PlanFixtureOverrides {
  readonly stages?: readonly unknown[];
  readonly prerequisiteEdges?: readonly unknown[];
  readonly renditions?: readonly unknown[];
  readonly alignments?: readonly unknown[];
  readonly evidenceSpecs?: readonly unknown[];
  readonly specPins?: readonly unknown[];
  readonly assetPins?: readonly unknown[];
  readonly mediaAssets?: readonly unknown[];
  readonly timingSources?: readonly unknown[];
  readonly target?: unknown;
  readonly planVersion?: number;
  readonly structureRevision?: number;
  readonly alignmentSetVersion?: number;
}

type MutableArrays = {
  stages: unknown[];
  prerequisiteEdges: unknown[];
  renditions: unknown[];
  alignments: unknown[];
  evidenceSpecs: unknown[];
  specPins: unknown[];
  assetPins: unknown[];
  mediaAssets: unknown[];
  timingSources: unknown[];
  target: unknown;
  planVersion: number;
  contentVersionId: string;
  structureRevision: number;
  alignmentSetVersion: number;
  resolvedChoices: string[];
  ruleVersion?: string;
  compilerVersion?: string;
};

/** 返回可自由改写的可变夹具（结构化克隆，互不污染）。 */
export function buildPlanFixtureArrays(
  overrides: PlanFixtureOverrides = {},
): MutableArrays {
  return structuredClone({
    stages: overrides.stages ?? stages(),
    prerequisiteEdges: overrides.prerequisiteEdges ?? prerequisiteEdges(),
    renditions: overrides.renditions ?? renditions(),
    alignments: overrides.alignments ?? alignments(),
    evidenceSpecs: overrides.evidenceSpecs ?? evidenceSpecs(),
    specPins: overrides.specPins ?? specPins(),
    assetPins: overrides.assetPins ?? assetPins(),
    mediaAssets: overrides.mediaAssets ?? mediaAssets(),
    timingSources: overrides.timingSources ?? timingSources(),
    target: overrides.target ?? target(),
    planVersion: overrides.planVersion ?? 1,
    contentVersionId: 'cv-01',
    structureRevision: overrides.structureRevision ?? 4,
    alignmentSetVersion: overrides.alignmentSetVersion ?? 7,
    resolvedChoices: [],
  }) as unknown as MutableArrays;
}

export function buildCompilePlanInput(
  overrides: PlanFixtureOverrides = {},
): CompilePlanInput {
  const fixture = buildPlanFixtureArrays(overrides);
  return {
    content: {
      courseKey: FIXTURE_COURSE_KEY,
      stages: fixture.stages,
      prerequisiteEdges: fixture.prerequisiteEdges,
      renditions: fixture.renditions,
      alignments: fixture.alignments,
      evidenceSpecs: fixture.evidenceSpecs,
      specPins: fixture.specPins,
      assetPins: fixture.assetPins,
    },
    target: fixture.target,
    contentVersionId: fixture.contentVersionId,
    planVersion: fixture.planVersion,
    structureRevision: fixture.structureRevision,
    alignmentSetVersion: fixture.alignmentSetVersion,
    mediaAssets: fixture.mediaAssets,
    timingSources: fixture.timingSources,
    resolvedChoices: fixture.resolvedChoices,
  } as unknown as CompilePlanInput;
}

/** 类型放宽的读写辅助（测试直接改夹具字段）。 */
export type LooseRecord = Record<string, any>;
