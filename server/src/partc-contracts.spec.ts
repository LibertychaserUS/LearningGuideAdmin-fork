/**
 * Part C P0 契约冻结测试（设计 §14 C5 P0 / C3 / C6 / C7 / C10）。
 *
 * 覆盖：
 * 1. 版本矩阵三轴（C0）；
 * 2. 15+1 个实体（C3，含表格中额外列出的 Course）的 v1 schema、品牌 smart constructor
 *    与关键约束正反例；
 * 3. C5 错误码表（含评审补齐的应用门码）；
 * 4. Plan canonical JSON（无 status/时间戳/随机/locale）、inputClosure 显式结构、
 *    字节相等比较（PLN-1）；
 * 5. CI grep 断言：模板契约无时间列、契约层无 checksum/contentHash 身份字段、
 *    旧包拒绝、Plan 无 wall-clock 字段；
 * 6. 课程包 provenance/annotations（C10.4/C10.6）、Rendition ASR/强制对齐来源、
 *    Alignment 派生审计元组、快照 provenance（评审阻断 3/5/6）。
 *
 * 位置：本文件在 `src/` 下，由默认 jest rootDir 收录（评审阻断 11：契约冻结
 * 必须进 CI 门禁）；CI 另以 `npm run test:partc` 显式执行并与 shell grep 门禁并行。
 *
 * 数据库/HTTP 层不在 P0 范围；本文件是纯契约测试，不连库。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ALIGNMENT_SOURCE_KINDS,
  ANCHOR_SOURCES,
  AssetKeySchema,
  BlockSchema,
  CONTENT_SPEC_TYPES,
  ContentKeySchema,
  ContentSpecSchema,
  ContentVersionContentSchema,
  ContentVersionSchema,
  CourseKeySchema,
  CourseSchema,
  EvidenceAttainmentSchema,
  EvidenceSpecSchema,
  LearningEventInputSchema,
  LearningEventSchema,
  LocaleSchema,
  MediaAssetSchema,
  ObjectiveSchema,
  PART_C_ARTIFACT_SCHEMAS,
  PART_C_ENTITY_SCHEMAS,
  PackageAnnotationsSchema,
  PackageManifestV2Schema,
  PackageProvenanceSchema,
  PlanApprovalSchema,
  PlanBodySchema,
  PlanEntrySchema,
  PlanRecordSchema,
  PrerequisiteEdgeSchema,
  RENDITION_BUSINESS_KEY_FIELDS,
  RenditionSchema,
  SnapshotV3Schema,
  StageKeySchema,
  StageSchema,
  TEMPLATE_V2_HEADERS,
  TEMPLATE_V2_HUMAN_SHEETS,
  TEMPLATE_V2_SHEET_SCHEMAS,
  TimeMsSchema,
  assertNoHumanTimeColumns,
  assertPackageReaderCompatible,
  canonicalJson,
  derivePlanEntryId,
  derivePlanId,
  evidenceAttainmentIdentity,
  findHumanTimeColumns,
  mediaAssetIdentity,
  parsePackageManifestV2,
  parseTemplateMetaRow,
  planBodiesEqual,
  planBodyBytes,
  renditionBusinessKey,
} from './partc/contracts';
import type { PartCEntityName } from './partc/contracts';
import {
  PART_C_ENVIRONMENT_ERROR_DEFINITIONS,
  PART_C_ERROR_DEFINITIONS,
  PART_C_PIPELINE_PHASES,
  PartCError,
  isPartCError,
  partCEnvironmentErrorHttpStatus,
  partCErrorHttpStatus,
} from './partc/errors';
import type { PartCErrorCode } from './partc/errors';
import {
  PACKAGE_FORMAT_VERSION,
  SNAPSHOT_FORMAT_VERSION,
  TEMPLATE_VERSION,
  VERSION_MATRIX,
  isSupportedPackageFormat,
  isSupportedSnapshotFormat,
  isSupportedTemplateVersion,
} from './partc/version-matrix';

const ISO = '2026-11-12T08:00:00Z';
const SERVER_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// fixtures（全部为合法 v1 实例；测试内只经 schema 观察，不 import 私有实现）
// ---------------------------------------------------------------------------

function courseFixture() {
  return {
    courseKey: 'modeling-life',
    categoryPath: ['Science'],
    titleLocalized: {
      'en-GB': { title: 'Modeling Life' },
      'zh-CN': { title: '建模人生' },
    },
    publishTargets: [
      { languages: ['en-GB', 'zh-CN'], modalities: ['video', 'text'] },
    ],
  };
}

function containerStageFixture() {
  return {
    courseKey: 'modeling-life',
    stageKey: 'stage-01',
    parentStageKey: null,
    orderKey: '000001',
    kind: 'stage',
    goal: 'Understand why modeling matters',
    objectiveKeys: [],
    exitEvidence: [],
    exitRollup: { kind: 'all' },
    status: 'active',
  };
}

function leafStageFixture() {
  return {
    courseKey: 'modeling-life',
    stageKey: 'step-01',
    parentStageKey: 'stage-01',
    orderKey: '000001.000001',
    kind: 'step',
    goal: 'Explain the purpose of a model',
    objectiveKeys: ['obj-01'],
    exitEvidence: ['ev-01'],
    exitRollup: { kind: 'atLeast', n: 1 },
    durationBudget: 600000,
    status: 'active',
  };
}

function objectiveFixture() {
  return {
    objectiveKey: 'obj-01',
    statement: 'Explain why models are useful',
    status: 'active',
  };
}

function prerequisiteEdgeFixture() {
  return {
    fromStageKey: 'stage-01',
    toStageKey: 'step-01',
    kind: 'requires',
  };
}

function evidenceSpecFixture() {
  return {
    evidenceKey: 'ev-01',
    version: 1,
    kind: 'assessment',
    objectiveKeys: ['obj-01'],
    measure: {
      kind: 'assessment',
      contentKey: 'lesson-01',
      blockIds: ['q-01'],
    },
    scoring: 'points',
    threshold: 60,
    attempts: 2,
  };
}

function videoBlockFixture() {
  return {
    contentKey: 'lesson-01',
    version: 1,
    blockId: 'v-01',
    kind: 'video',
    payload: { kind: 'video' },
  };
}

function textBlockFixture() {
  return {
    contentKey: 'lesson-01',
    version: 1,
    blockId: 't-01',
    kind: 'text',
    payload: { kind: 'text', html: '<p>Modeling</p>' },
  };
}

function questionBlockFixture() {
  return {
    contentKey: 'lesson-01',
    version: 1,
    blockId: 'q-01',
    kind: 'question',
    payload: {
      kind: 'question',
      questionLocalized: {
        'en-GB': { question: 'What is a model?' },
        'zh-CN': { question: '什么是模型？' },
      },
      referenceAnswerLocalized: {
        'en-GB': { referenceAnswer: 'A simplified representation' },
        'zh-CN': { referenceAnswer: '一种简化的表示' },
      },
    },
  };
}

function contentSpecFixture() {
  return {
    contentKey: 'lesson-01',
    version: 1,
    type: 'video',
    titleLocalized: {
      'en-GB': { title: 'Lesson 1' },
      'zh-CN': { title: '第一课' },
    },
    blocks: [videoBlockFixture(), textBlockFixture(), questionBlockFixture()],
  };
}

function videoRenditionFixture() {
  return {
    renditionKey: 'r-video-en',
    contentKey: 'lesson-01',
    blockId: 'v-01',
    language: 'en-GB',
    modality: 'video',
    occurrenceKey: 'main',
    carrierType: 'asset',
    carrierKey: 'asset-video-01',
    carrierVersion: 1,
    startMs: 0,
    endMs: 120000,
    anchorSource: 'subtitle',
    revision: 1,
  };
}

function textRenditionFixture() {
  return {
    renditionKey: 'r-text-en',
    contentKey: 'lesson-01',
    blockId: 't-01',
    language: 'en-GB',
    modality: 'text',
    occurrenceKey: 'main',
    carrierType: 'document',
    carrierKey: 'doc-lesson-01',
    carrierVersion: 1,
    headingCode: '1-1',
    offset: 0,
    anchorSource: 'doc-structure',
    revision: 1,
  };
}

function mediaAssetFixture() {
  return {
    assetKey: 'asset-video-01',
    assetVersion: 1,
    kind: 'video',
    language: 'en-GB',
    durationMs: 600000,
    uri: 'media/lesson-01.mp4',
  };
}

function alignmentFixture() {
  return {
    alignmentId: 'aln-01',
    stageKey: 'step-01',
    renditionKey: 'r-video-en',
    objectiveKey: 'obj-01',
    role: 'primary',
    status: 'verified',
    provenance: 'human',
    verifiedBy: 'employee-1',
    verifiedAt: ISO,
    verifiedAgainst: {
      renditionRevision: 1,
      carrierVersion: 1,
      specVersion: 1,
    },
  };
}

function contentVersionContentFixture() {
  return {
    courseKey: 'modeling-life',
    versionNo: 1,
    categoryPath: ['Science'],
    stages: [containerStageFixture(), leafStageFixture()],
    prerequisiteEdges: [prerequisiteEdgeFixture()],
    specPins: [{ contentKey: 'lesson-01', version: 1 }],
    renditions: [videoRenditionFixture(), textRenditionFixture()],
    alignments: [alignmentFixture()],
    evidenceSpecs: [evidenceSpecFixture()],
    assetPins: [{ assetKey: 'asset-video-01', assetVersion: 1 }],
  };
}

function contentVersionFixture() {
  return {
    ...contentVersionContentFixture(),
    contentVersionId: 'cv-01',
    frozenAt: ISO,
    planPin: {
      planId: derivePlanId({
        courseKey: 'modeling-life',
        contentVersionId: 'cv-01',
        targetId: 'target-01',
        planVersion: 1,
      }),
      planVersion: 1,
    },
  };
}

function inputClosureFixture() {
  return {
    courseKey: 'modeling-life',
    structureRevision: 3,
    specPins: [{ contentKey: 'lesson-01', version: 1 }],
    assetPins: [{ assetKey: 'asset-video-01', assetVersion: 1 }],
    alignmentSetVersion: 7,
    targetId: 'target-01',
    resolvedChoices: [],
    ruleVersion: 'rules-v1',
    compilerVersion: 'compiler-v1',
  };
}

function planEntryFixture() {
  return {
    entryId: derivePlanEntryId({
      stageKey: 'step-01',
      alignmentId: 'aln-01',
      occurrenceKey: 'main',
    }),
    stageKey: 'step-01',
    alignmentId: 'aln-01',
    orderKey: '000001.000001.000001',
    placement: {
      type: 'media',
      assetKey: 'asset-video-01',
      assetVersion: 1,
      startMs: 0,
      endMs: 120000,
    },
    status: 'ok',
  };
}

function planWarningFixture() {
  return { code: 'PREREQUISITE_RECOMMENDS', stageKey: 'step-01' };
}

function planBodyFixture() {
  return {
    planId: derivePlanId({
      courseKey: 'modeling-life',
      contentVersionId: 'cv-01',
      targetId: 'target-01',
      planVersion: 1,
    }),
    contentVersionId: 'cv-01',
    targetId: 'target-01',
    planVersion: 1,
    inputClosure: inputClosureFixture(),
    entries: [planEntryFixture()],
    warnings: [planWarningFixture()],
    compilerVersion: 'compiler-v1',
    ruleVersion: 'rules-v1',
  };
}

function minimalPlanBodyFixture() {
  return {
    planId: derivePlanId({
      courseKey: 'modeling-life',
      contentVersionId: 'cv-01',
      targetId: 'target-01',
      planVersion: 1,
    }),
    contentVersionId: 'cv-01',
    targetId: 'target-01',
    planVersion: 1,
    inputClosure: {
      courseKey: 'modeling-life',
      structureRevision: 0,
      specPins: [],
      assetPins: [],
      alignmentSetVersion: 0,
      targetId: 'target-01',
      resolvedChoices: [],
      ruleVersion: 'r1',
      compilerVersion: 'c1',
    },
    entries: [],
    warnings: [],
    compilerVersion: 'c1',
    ruleVersion: 'r1',
  };
}

function planApprovalFixture() {
  return {
    planId: planBodyFixture().planId,
    planVersion: 1,
    decision: 'approved',
    approvedBy: 'employee-1',
    approvedAt: ISO,
    acceptedWarnings: [planWarningFixture()],
  };
}

function learningEventInputFixture() {
  return {
    eventId: 'evt-01',
    sessionId: 'sess-01',
    type: 'started',
    occurredAt: ISO,
    contentVersionId: 'cv-01',
    stageKey: 'step-01',
    sequence: 1,
  };
}

function learningEventFixture() {
  return {
    ...learningEventInputFixture(),
    userId: 'user-01',
    receivedAt: ISO,
  };
}

function evidenceAttainmentFixture() {
  return {
    contentVersionId: 'cv-01',
    stageKey: 'step-01',
    evidenceKey: 'ev-01',
    attemptNo: 1,
    score: 88,
    attained: true,
    gradedBy: 'grader-1',
    gradedAt: ISO,
  };
}

function snapshotCourseHeaderFixture() {
  return {
    courseKey: 'modeling-life',
    categoryPath: ['Science'],
    titleLocalized: {
      'en-GB': { title: 'Modeling Life' },
      'zh-CN': { title: '建模人生' },
    },
    learningLanguages: ['en-GB', 'zh-CN'],
  };
}

function snapshotV3Fixture() {
  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    capturedAt: ISO,
    course: snapshotCourseHeaderFixture(),
    contentVersion: contentVersionFixture(),
  };
}

function packageProvenanceFixture() {
  return {
    sourceEnv: 'sandbox',
    sourceVersionLabel: '4.2',
    exportedAt: ISO,
    exportedBy: 'operator@example.com',
    courseKey: 'modeling-life',
    planPin: {
      planId: derivePlanId({
        courseKey: 'modeling-life',
        contentVersionId: 'cv-01',
        targetId: 'target-01',
        planVersion: 1,
      }),
      planVersion: 1,
    },
    approvalRef: 'APR-0001',
    auditSummaryRef: 'audit/2026-11-12-modeling-life-1.json',
    asr: {
      modelVersion: 'asr-model-v1',
      params: { beam: 5, language: 'en-GB', vad: true },
      ruleVersion: 'asr-rules-v1',
    },
  };
}

function packageManifestFixture() {
  return {
    format: 'lg-course-package',
    formatVersion: PACKAGE_FORMAT_VERSION,
    packageId: 'pkg-01',
    exportedAt: ISO,
    minReaderVersion: PACKAGE_FORMAT_VERSION,
    extensionsUsed: [],
    extensionsRequired: [],
    course: {
      courseKey: 'modeling-life',
      titleLocalized: {
        'en-GB': { title: 'Modeling Life' },
        'zh-CN': { title: '建模人生' },
      },
      categoryPath: ['Science'],
      learningLanguages: ['en-GB', 'zh-CN'],
      studyMode: 'both',
    },
    content: contentVersionContentFixture(),
    resources: [
      {
        id: 'template-01',
        kind: 'template',
        path: 'template.xlsx',
        size: 2048,
      },
      {
        id: 'asset-video-01',
        kind: 'video',
        path: 'media/lesson-01.mp4',
        size: 1048576,
      },
    ],
    provenance: packageProvenanceFixture(),
    annotations: {
      exportedBy: 'admin',
      verification: [
        {
          kind: 'timing-audit',
          lessonCode: 'lesson-01',
          sourceKind: 'asr',
          sourceArtifact: 'asr:asset-video-01:en-GB',
          ruleVersion: 'asr-rules-v1',
        },
      ],
    },
  };
}

function templateMetaRowFixture() {
  return {
    templateVersion: TEMPLATE_VERSION,
    courseCode: 'modeling-life',
    learningLanguages: ['en-GB', 'zh-CN'],
    studyMode: 'both',
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectInvalid(
  schema: { safeParse: (input: unknown) => { success: boolean } },
  value: unknown,
): void {
  expect(schema.safeParse(value).success).toBe(false);
}

function expectValid(
  schema: { safeParse: (input: unknown) => { success: boolean } },
  value: unknown,
): void {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `expected valid, got ${JSON.stringify((result as { error?: unknown }).error)}`,
    );
  }
  expect(result.success).toBe(true);
}

function catchPartCError(fn: () => unknown): PartCError {
  try {
    fn();
  } catch (error) {
    if (isPartCError(error)) return error;
    throw error;
  }
  throw new Error(`expected PartCError but nothing was thrown`);
}

function expectPartCError(fn: () => unknown, code: PartCErrorCode): void {
  const error = catchPartCError(fn);
  expect(error.code).toBe(code);
}

// ---------------------------------------------------------------------------
// 1. 版本矩阵（C0）
// ---------------------------------------------------------------------------

describe('P0 version matrix (C0)', () => {
  it('freezes packageFormat=2, templateVersion=2, snapshotFormat=3', () => {
    expect(VERSION_MATRIX).toEqual({
      packageFormat: 2,
      templateVersion: 2,
      snapshotFormat: 3,
    });
    expect(PACKAGE_FORMAT_VERSION).toBe(2);
    expect(TEMPLATE_VERSION).toBe(2);
    expect(SNAPSHOT_FORMAT_VERSION).toBe(3);
    expect(Object.isFrozen(VERSION_MATRIX)).toBe(true);
  });

  it('rejects any value other than the frozen version on each axis', () => {
    expect(isSupportedPackageFormat(2)).toBe(true);
    expect(isSupportedPackageFormat(1)).toBe(false);
    expect(isSupportedTemplateVersion(2)).toBe(true);
    expect(isSupportedTemplateVersion(3)).toBe(false);
    expect(isSupportedSnapshotFormat(3)).toBe(true);
    expect(isSupportedSnapshotFormat(2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. 品牌类型与 smart constructor（C3）
// ---------------------------------------------------------------------------

describe('P0 branded keys and smart constructors (C3)', () => {
  it('accepts valid stable keys, locales and integer milliseconds', () => {
    expect(CourseKeySchema.parse('modeling-life')).toBe('modeling-life');
    expect(StageKeySchema.parse('step-01')).toBe('step-01');
    expect(ContentKeySchema.parse('lesson-01')).toBe('lesson-01');
    expect(AssetKeySchema.parse('asset-video-01')).toBe('asset-video-01');
    expect(LocaleSchema.parse('en-GB')).toBe('en-GB');
    expect(LocaleSchema.parse('zh-CN')).toBe('zh-CN');
    expect(TimeMsSchema.parse(0)).toBe(0);
    expect(TimeMsSchema.parse(120000)).toBe(120000);
  });

  it('rejects keys with spaces, path separators or leading punctuation', () => {
    for (const bad of ['has space', '/absolute', '../parent', '', '-leading']) {
      expectInvalid(CourseKeySchema, bad);
      expectInvalid(StageKeySchema, bad);
      expectInvalid(ContentKeySchema, bad);
      expectInvalid(AssetKeySchema, bad);
    }
  });

  it('rejects malformed locales', () => {
    for (const bad of ['EN-gb', 'english', 'zh_CN', 'e', '']) {
      expectInvalid(LocaleSchema, bad);
    }
  });

  it('rejects negative or fractional milliseconds', () => {
    expectInvalid(TimeMsSchema, -1);
    expectInvalid(TimeMsSchema, 1.5);
    expectInvalid(TimeMsSchema, Number.NaN);
    expectInvalid(TimeMsSchema, '1000');
  });
});

// ---------------------------------------------------------------------------
// 3. 实体 schema 正向解析（C3）
// ---------------------------------------------------------------------------

describe('P0 entity registry and happy-path parsing (C3)', () => {
  const fixtures: Record<PartCEntityName, unknown> = {
    Course: courseFixture(),
    Stage: leafStageFixture(),
    PrerequisiteEdge: prerequisiteEdgeFixture(),
    Objective: objectiveFixture(),
    EvidenceSpec: evidenceSpecFixture(),
    ContentSpec: contentSpecFixture(),
    Block: questionBlockFixture(),
    Rendition: videoRenditionFixture(),
    MediaAsset: mediaAssetFixture(),
    Alignment: alignmentFixture(),
    ContentVersion: contentVersionFixture(),
    Plan: minimalPlanBodyFixture(),
    PlanEntry: planEntryFixture(),
    PlanApproval: planApprovalFixture(),
    LearningEvent: learningEventFixture(),
    EvidenceAttainment: evidenceAttainmentFixture(),
  };

  it('freezes exactly the C3 entity set (15 + Course)', () => {
    expect(Object.keys(PART_C_ENTITY_SCHEMAS)).toHaveLength(16);
    for (const name of Object.keys(fixtures)) {
      expect(PART_C_ENTITY_SCHEMAS).toHaveProperty(name);
    }
  });

  it('parses one valid v1 instance per entity', () => {
    for (const [name, schema] of Object.entries(PART_C_ENTITY_SCHEMAS)) {
      expectValid(schema, fixtures[name as PartCEntityName]);
    }
  });

  it('parses the artifact contracts (package-v2/template-v2/snapshot-v3/plan/event)', () => {
    expectValid(
      PART_C_ARTIFACT_SCHEMAS.PackageManifestV2,
      packageManifestFixture(),
    );
    expectValid(PART_C_ARTIFACT_SCHEMAS.SnapshotV3, snapshotV3Fixture());
    expectValid(PART_C_ARTIFACT_SCHEMAS.PlanBody, planBodyFixture());
    expectValid(PART_C_ARTIFACT_SCHEMAS.PlanRecord, {
      ...planBodyFixture(),
      status: 'approved',
    });
    expectValid(PART_C_ARTIFACT_SCHEMAS.PlanApproval, planApprovalFixture());
    expectValid(
      PART_C_ARTIFACT_SCHEMAS.LearningEventInput,
      learningEventInputFixture(),
    );
    expectValid(PART_C_ARTIFACT_SCHEMAS.LearningEvent, learningEventFixture());
    expectValid(ContentVersionContentSchema, contentVersionContentFixture());
    expectValid(TEMPLATE_V2_SHEET_SCHEMAS.Meta, templateMetaRowFixture());
  });
});

// ---------------------------------------------------------------------------
// 4. 实体约束负例（C3/C4）
// ---------------------------------------------------------------------------

describe('P0 entity constraints reject design violations (C3/C4)', () => {
  it('Stage: closed kind, program-generated orderKey, media-sum budget only', () => {
    const stage = leafStageFixture();
    expectInvalid(StageSchema, { ...stage, kind: 'chapter' });
    expectInvalid(StageSchema, { ...stage, orderKey: '1' });
    expectInvalid(StageSchema, { ...stage, durationBudget: -5 });
    // 时间轴字段在意图域不存在：strict schema 直接拒绝
    expectInvalid(StageSchema, { ...stage, plannedStartMs: 1000 });
    expectInvalid(StageSchema, { ...stage, exitRollup: { kind: 'most' } });
  });

  it('PrerequisiteEdge: no self-reference, closed kind', () => {
    expectInvalid(PrerequisiteEdgeSchema, {
      fromStageKey: 'step-01',
      toStageKey: 'step-01',
      kind: 'requires',
    });
    expectInvalid(PrerequisiteEdgeSchema, {
      ...prerequisiteEdgeFixture(),
      kind: 'blocks',
    });
  });

  it('Objective: retired status is a closed vocabulary', () => {
    expectInvalid(ObjectiveSchema, {
      ...objectiveFixture(),
      status: 'deleted',
    });
  });

  it('EvidenceSpec: completion/attendance/self-report/watch-rate are not evidence', () => {
    for (const forbidden of [
      'completion',
      'attendance',
      'self-report',
      'watch-completion-rate',
    ]) {
      expectInvalid(EvidenceSpecSchema, {
        ...evidenceSpecFixture(),
        kind: forbidden,
      });
    }
    expectInvalid(EvidenceSpecSchema, {
      ...evidenceSpecFixture(),
      measure: {
        kind: 'performance',
        rubric: 'x',
      },
    });
    expectInvalid(EvidenceSpecSchema, {
      ...evidenceSpecFixture(),
      attempts: 0,
    });
    expectInvalid(EvidenceSpecSchema, {
      ...evidenceSpecFixture(),
      objectiveKeys: [],
    });
  });

  it('ContentSpec: six-value closed type, no stageKey/sort DSL/authoritative anchors', () => {
    expect(CONTENT_SPEC_TYPES).toEqual([
      'video',
      'text',
      'exhibit',
      'reading',
      'knowledge-test',
      'application-test',
    ]);
    expectInvalid(ContentSpecSchema, {
      ...contentSpecFixture(),
      type: 'chapter',
    });
    expectInvalid(ContentSpecSchema, {
      ...contentSpecFixture(),
      stageKey: 'step-01',
    });
    expectInvalid(ContentSpecSchema, {
      ...contentSpecFixture(),
      blocks: [{ ...textBlockFixture(), contentKey: 'lesson-99' }],
    });
    expectInvalid(ContentSpecSchema, {
      ...contentSpecFixture(),
      blocks: [textBlockFixture(), textBlockFixture()],
    });
    expectInvalid(ContentSpecSchema, { ...contentSpecFixture(), blocks: [] });
  });

  it('Block: payload kind must match, bilingual questions require zh-CN', () => {
    const question = questionBlockFixture();
    expectInvalid(BlockSchema, {
      ...question,
      payload: {
        kind: 'question',
        questionLocalized: { 'en-GB': { question: 'Q?' } },
        referenceAnswerLocalized: {
          'en-GB': { referenceAnswer: 'A' },
          'zh-CN': { referenceAnswer: '答' },
        },
      },
    });
    expectInvalid(BlockSchema, { ...question, kind: 'text' });
    expectInvalid(BlockSchema, { ...question, kind: 'timeline' });
    expectInvalid(BlockSchema, { ...question, timeMs: 1000 });
  });

  it('Rendition: single coordinate source, half-open interval, closed anchor sources', () => {
    const video = videoRenditionFixture();
    expectInvalid(RenditionSchema, { ...video, endMs: undefined });
    expectInvalid(RenditionSchema, { ...video, endMs: 0 });
    expectInvalid(RenditionSchema, { ...video, headingCode: '1-1' });
    expectInvalid(RenditionSchema, {
      ...textRenditionFixture(),
      startMs: 0,
      endMs: 1000,
    });
    expectInvalid(RenditionSchema, {
      ...video,
      anchorSource: 'doc-structure',
    });
    expectInvalid(RenditionSchema, {
      ...textRenditionFixture(),
      anchorSource: 'subtitle',
    });
    expectInvalid(RenditionSchema, { ...video, carrierVersion: 0 });
    expectValid(RenditionSchema, {
      ...video,
      startMs: undefined,
      endMs: undefined,
      anchorSource: 'import-legacy',
    });
    expect(RENDITION_BUSINESS_KEY_FIELDS).toEqual([
      'contentKey',
      'blockId',
      'language',
      'modality',
      'carrierType',
      'carrierKey',
      'carrierVersion',
      'occurrenceKey',
    ]);
  });

  it('MediaAsset: identity is assetKey+assetVersion, duration is a probed attribute only', () => {
    expect(
      mediaAssetIdentity(MediaAssetSchema.parse(mediaAssetFixture())),
    ).toBe('asset-video-01@1');
    expectInvalid(MediaAssetSchema, {
      ...mediaAssetFixture(),
      durationMs: undefined,
    });
    expectInvalid(MediaAssetSchema, {
      ...mediaAssetFixture(),
      kind: 'image',
    });
    expectInvalid(MediaAssetSchema, {
      ...mediaAssetFixture(),
      durationMs: 0,
    });
    expectInvalid(MediaAssetSchema, {
      ...mediaAssetFixture(),
      uri: '',
    });
    // 身份之外不允许摘要字段（strict + 全库 grep 断言）
    expectInvalid(MediaAssetSchema, {
      ...mediaAssetFixture(),
      sha256: 'deadbeef',
    });
  });

  it('Alignment: verified requires human signoff; stale is derived, never stored', () => {
    expectInvalid(AlignmentSchemaForTest(), {
      ...alignmentFixture(),
      status: 'stale',
    });
    const verified = alignmentFixture();
    expectInvalid(AlignmentSchemaForTest(), {
      ...verified,
      verifiedBy: undefined,
    });
    expectInvalid(AlignmentSchemaForTest(), {
      ...alignmentFixture(),
      status: 'proposed',
    });
    expectValid(AlignmentSchemaForTest(), {
      ...alignmentFixture(),
      status: 'proposed',
      verifiedBy: undefined,
      verifiedAt: undefined,
      verifiedAgainst: undefined,
    });
  });

  it('ContentVersion: frozen alignments must glue to stages, renditions and pins', () => {
    const content = contentVersionContentFixture();
    expectInvalid(ContentVersionContentSchema, {
      ...content,
      alignments: [{ ...alignmentFixture(), objectiveKey: 'obj-99' }],
    });
    expectInvalid(ContentVersionContentSchema, {
      ...content,
      alignments: [{ ...alignmentFixture(), status: 'proposed' }],
    });
    expectInvalid(ContentVersionContentSchema, {
      ...content,
      renditions: [
        videoRenditionFixture(),
        textRenditionFixture(),
        {
          ...textRenditionFixture(),
          renditionKey: 'r-x',
          contentKey: 'lesson-99',
        },
      ],
    });
    expectInvalid(ContentVersionContentSchema, {
      ...content,
      renditions: [
        { ...videoRenditionFixture(), carrierKey: 'asset-video-99' },
        textRenditionFixture(),
      ],
    });
    expectInvalid(ContentVersionContentSchema, {
      ...content,
      alignments: [
        alignmentFixture(),
        { ...alignmentFixture(), alignmentId: 'aln-02' },
      ],
    });
    expectInvalid(ContentVersionContentSchema, {
      ...content,
      stages: [
        containerStageFixture(),
        { ...leafStageFixture(), exitEvidence: ['ev-99'] },
      ],
    });
    expectInvalid(ContentVersionContentSchema, {
      ...content,
      stages: [
        containerStageFixture(),
        { ...leafStageFixture(), orderKey: '000001' },
      ],
    });
    expectInvalid(ContentVersionContentSchema, {
      ...content,
      stages: [
        containerStageFixture(),
        { ...leafStageFixture(), parentStageKey: 'stage-99' },
      ],
    });
    expectInvalid(ContentVersionContentSchema, {
      ...content,
      renditions: [videoRenditionFixture(), videoRenditionFixture()],
    });
    // ALN-3：verifiedAgainst 必须与冻结 pin 集一致（否则冻结时即 stale）
    expectInvalid(ContentVersionContentSchema, {
      ...content,
      alignments: [
        {
          ...alignmentFixture(),
          verifiedAgainst: {
            renditionRevision: 2,
            carrierVersion: 1,
            specVersion: 1,
          },
        },
      ],
    });
    expectInvalid(ContentVersionContentSchema, {
      ...content,
      alignments: [
        {
          ...alignmentFixture(),
          verifiedAgainst: {
            renditionRevision: 1,
            carrierVersion: 1,
            specVersion: 2,
          },
        },
      ],
    });
    // STR-5：assessment 型证据的 measure 必须指向已 pin 的内容
    expectInvalid(ContentVersionContentSchema, {
      ...content,
      evidenceSpecs: [
        {
          ...evidenceSpecFixture(),
          measure: {
            kind: 'assessment',
            contentKey: 'lesson-99',
            blockIds: ['q-01'],
          },
        },
      ],
    });
  });

  it('PlanEntry: entryId derivation, gap only on explicit non-ok entries', () => {
    expectValid(PlanEntrySchema, planEntryFixture());
    expectInvalid(PlanEntrySchema, {
      ...planEntryFixture(),
      entryId: 'plain-id',
    });
    expectInvalid(PlanEntrySchema, {
      ...planEntryFixture(),
      placement: { type: 'gap', reason: 'ALN-1' },
      status: 'ok',
    });
    expectValid(PlanEntrySchema, {
      ...planEntryFixture(),
      placement: { type: 'gap', reason: 'ALN-1' },
      status: 'degraded',
    });
    expectInvalid(PlanEntrySchema, {
      ...planEntryFixture(),
      placement: { ...planEntryFixture().placement, startMs: 120000 },
    });
    expectInvalid(PlanEntrySchema, {
      ...planEntryFixture(),
      placement: { type: 'gap', reason: 'STR-1' },
      status: 'blocked',
    });
  });

  it('PlanApproval: rejected approval cannot accept warnings', () => {
    expectInvalid(PlanApprovalSchema, {
      ...planApprovalFixture(),
      decision: 'rejected',
    });
    expectValid(PlanApprovalSchema, {
      ...planApprovalFixture(),
      decision: 'rejected',
      acceptedWarnings: [],
    });
  });

  it('LearningEvent: server-authoritative fields are not client input', () => {
    expectInvalid(LearningEventInputSchema, {
      ...learningEventInputFixture(),
      receivedAt: ISO,
    });
    expectInvalid(LearningEventInputSchema, {
      ...learningEventInputFixture(),
      userId: 'user-01',
    });
    expectInvalid(LearningEventInputSchema, {
      ...learningEventInputFixture(),
      elapsedSeconds: 30,
    });
    expectInvalid(LearningEventInputSchema, {
      ...learningEventInputFixture(),
      occurredAt: '2026-11-12T08:00:00+00:00',
    });
    expectInvalid(LearningEventInputSchema, {
      ...learningEventInputFixture(),
      type: 'watched',
    });
    expectInvalid(LearningEventSchema, learningEventInputFixture());
  });

  it('EvidenceAttainment: score or rubricLevel required, attempt is monotonic per key', () => {
    expectInvalid(EvidenceAttainmentSchema, {
      ...evidenceAttainmentFixture(),
      score: undefined,
    });
    expectValid(EvidenceAttainmentSchema, {
      ...evidenceAttainmentFixture(),
      score: undefined,
      rubricLevel: 'excellent',
    });
    expectInvalid(EvidenceAttainmentSchema, {
      ...evidenceAttainmentFixture(),
      score: -1,
    });
  });

  it('Course: no local category table, no timeline fields', () => {
    expectValid(CourseSchema, { ...courseFixture(), publishTargets: [] });
    expectInvalid(CourseSchema, {
      ...courseFixture(),
      publishTargets: undefined,
    });
    expectInvalid(CourseSchema, {
      ...courseFixture(),
      category: 'Science',
    });
    expectInvalid(CourseSchema, {
      ...courseFixture(),
      timeline: [{ week: 1 }],
    });
  });

  it('SnapshotV3: course.categoryPath is the Part A surface, must agree with the freeze', () => {
    const snapshot = snapshotV3Fixture();
    expectInvalid(SnapshotV3Schema, { ...snapshot, formatVersion: 2 });
    expectInvalid(SnapshotV3Schema, {
      ...snapshot,
      course: { ...snapshot.course, categoryPath: ['Society'] },
    });
    expectInvalid(SnapshotV3Schema, {
      ...snapshot,
      course: { ...snapshot.course, courseKey: 'other-course' },
    });
  });
});

/** AlignmentSchema 只用于本文件断言（避免与实体注册表混淆）。 */
function AlignmentSchemaForTest() {
  return PART_C_ENTITY_SCHEMAS.Alignment;
}

// ---------------------------------------------------------------------------
// 5. Plan canonical JSON（C6 / PLN-1）
// ---------------------------------------------------------------------------

describe('P0 Plan canonical JSON and input closure (C6/PLN-1)', () => {
  it('derives planId explicitly from (courseKey, contentVersionId, targetId, planVersion)', () => {
    const planId = derivePlanId({
      courseKey: 'modeling-life',
      contentVersionId: 'cv-01',
      targetId: 'target-01',
      planVersion: 2,
    });
    expect(planId).toBe('plan/modeling-life/cv-01/target-01/v2');
    expect(
      derivePlanId({
        courseKey: 'modeling-life',
        contentVersionId: 'cv-01',
        targetId: 'target-01',
        planVersion: 2,
      }),
    ).toBe(planId);
    expectInvalid(PlanBodySchema, { ...planBodyFixture(), planId: 'plan/x' });
    expectInvalid(PlanBodySchema, {
      ...planBodyFixture(),
      planId: derivePlanId({
        courseKey: 'modeling-life',
        contentVersionId: 'cv-02',
        targetId: 'target-01',
        planVersion: 1,
      }),
    });
  });

  it('keeps status, wall-clock, random and locale fields out of PlanBody', () => {
    const body = planBodyFixture();
    expectInvalid(PlanBodySchema, { ...body, status: 'approved' });
    expectInvalid(PlanBodySchema, { ...body, plannedAt: ISO });
    expectInvalid(PlanBodySchema, { ...body, createdAt: ISO });
    expectInvalid(PlanBodySchema, { ...body, nonce: 'abc' });
    expectInvalid(PlanBodySchema, { ...body, locale: 'en-GB' });
    expectInvalid(PlanBodySchema, {
      ...body,
      inputClosure: { ...inputClosureFixture(), locale: 'en-GB' },
    });
    // status 外置：PlanRecord = canonical body + 外置状态
    expectValid(PlanRecordSchema, { ...body, status: 'approved' });
    expectInvalid(PlanRecordSchema, { ...body, status: 'published' });
  });

  it('inputClosure is explicit and carries a monotonic alignmentSetVersion (no digest)', () => {
    const closure = inputClosureFixture();
    expect(closure.alignmentSetVersion).toBe(7);
    expectInvalid(PlanBodySchema, {
      ...planBodyFixture(),
      inputClosure: { ...closure, alignmentSetVersion: -1 },
    });
    expectInvalid(PlanBodySchema, {
      ...planBodyFixture(),
      inputClosure: { ...closure, alignmentSetVersion: '7' },
    });
    expectInvalid(PlanBodySchema, {
      ...planBodyFixture(),
      inputClosure: {
        ...closure,
        assetPins: [
          { assetKey: 'asset-video-02', assetVersion: 1 },
          { assetKey: 'asset-video-01', assetVersion: 1 },
        ],
      },
    });
    expectInvalid(PlanBodySchema, {
      ...planBodyFixture(),
      inputClosure: {
        ...closure,
        specPins: [
          { contentKey: 'lesson-02', version: 1 },
          { contentKey: 'lesson-01', version: 1 },
        ],
      },
    });
    // 任何摘要形态的字段都不属于 inputClosure（strict schema）
    expectInvalid(PlanBodySchema, {
      ...planBodyFixture(),
      inputClosure: { ...closure, closureDigest: 'abc' },
    });
  });

  it('requires entries sorted by ascending orderKey with unique entryId', () => {
    const body = planBodyFixture();
    const secondEntry = {
      ...planEntryFixture(),
      entryId: derivePlanEntryId({
        stageKey: 'step-01',
        alignmentId: 'aln-01',
        occurrenceKey: 'alt',
      }),
      orderKey: '000001.000001.000002',
    };
    expectValid(PlanBodySchema, {
      ...body,
      entries: [planEntryFixture(), secondEntry],
    });
    expectInvalid(PlanBodySchema, {
      ...body,
      entries: [secondEntry, planEntryFixture()],
    });
    expectInvalid(PlanBodySchema, {
      ...body,
      entries: [planEntryFixture(), planEntryFixture()],
    });
  });

  it('compares plans by canonical bytes, not by key insertion order', () => {
    const parsed = PlanBodySchema.parse(planBodyFixture());
    const bytes = planBodyBytes(parsed);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    const reparsed = PlanBodySchema.parse(JSON.parse(bytes));
    expect(planBodyBytes(reparsed)).toBe(bytes);
    expect(planBodiesEqual(parsed, reparsed)).toBe(true);
    const bumped = PlanBodySchema.parse({
      ...planBodyFixture(),
      planVersion: 2,
      planId: derivePlanId({
        courseKey: 'modeling-life',
        contentVersionId: 'cv-01',
        targetId: 'target-01',
        planVersion: 2,
      }),
    });
    expect(planBodiesEqual(parsed, bumped)).toBe(false);
    // Plan 级 status 外置；entry 级 status 是确定性输出的一部分。
    const wire = JSON.parse(bytes) as Record<string, unknown>;
    expect(wire).not.toHaveProperty('status');
    expect(Array.isArray(wire.entries)).toBe(true);
  });

  it('locks golden bytes for a minimal plan (PLN-1)', () => {
    const parsed = PlanBodySchema.parse(minimalPlanBodyFixture());
    expect(planBodyBytes(parsed)).toBe(
      '{"compilerVersion":"c1","contentVersionId":"cv-01","entries":[],"inputClosure":{' +
        '"alignmentSetVersion":0,"assetPins":[],"compilerVersion":"c1","courseKey":"modeling-life",' +
        '"resolvedChoices":[],"ruleVersion":"r1","specPins":[],"structureRevision":0,"targetId":"target-01"},' +
        '"planId":"plan/modeling-life/cv-01/target-01/v1","planVersion":1,"ruleVersion":"r1",' +
        '"targetId":"target-01","warnings":[]}',
    );
  });
});

// ---------------------------------------------------------------------------
// 6. CI grep 断言（C5 P0）
// ---------------------------------------------------------------------------

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      collectKeys(child, out);
    }
  }
  return out;
}

const HASH_TOKEN_PATTERN =
  /(checksum|contenthash|sha-?256|sha-?1\b|md-?5|digest|createhash|createhmac|\bhash\b)/i;
const IDENTITY_HASH_KEY_PATTERN =
  /^(?:checksum|contenthash|content_hash|sha256|sha1|md5|digest)$/i;
const WALL_CLOCK_KEY_PATTERN =
  /(^|_)(?:createdat|updatedat|plannedat|publishedat|generatedat|exportedat|frozenat|approvedat|verifiedat|occurredat|receivedat|gradedat|timestamp|time|date|now|locale|language|nonce|seed|random|uuid)$/i;

describe('P0 CI grep assertions (C5 P0)', () => {
  it('contract source never mentions checksum/contentHash/sha*/digest identifiers', () => {
    const partcRoot = path.join(SERVER_ROOT, 'src', 'partc');
    const files = listTsFiles(partcRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect({
        file,
        match: fs.readFileSync(file, 'utf8').match(HASH_TOKEN_PATTERN),
      }).toEqual({
        file,
        match: null,
      });
    }
  });

  it('every zod-declared contract in src is free of hash identity field declarations', () => {
    const srcRoot = path.join(SERVER_ROOT, 'src');
    const zodFiles = listTsFiles(srcRoot).filter((file) =>
      /from ['"]zod['"]|require\(['"]zod['"]\)/.test(
        fs.readFileSync(file, 'utf8'),
      ),
    );
    // P0 契约层全部经 zod 声明；旧 Prisma 内容列的清理属 C9 步骤 3（迁移域）。
    expect(zodFiles.length).toBeGreaterThan(0);
    for (const file of zodFiles) {
      expect({
        file,
        match: fs.readFileSync(file, 'utf8').match(HASH_TOKEN_PATTERN),
      }).toEqual({
        file,
        match: null,
      });
    }
  });

  it('no parsed entity/artifact instance carries a hash identity key', () => {
    const instances: unknown[] = [
      PART_C_ENTITY_SCHEMAS.Course.parse(courseFixture()),
      PART_C_ENTITY_SCHEMAS.Stage.parse(leafStageFixture()),
      PART_C_ENTITY_SCHEMAS.PrerequisiteEdge.parse(prerequisiteEdgeFixture()),
      PART_C_ENTITY_SCHEMAS.Objective.parse(objectiveFixture()),
      PART_C_ENTITY_SCHEMAS.EvidenceSpec.parse(evidenceSpecFixture()),
      PART_C_ENTITY_SCHEMAS.ContentSpec.parse(contentSpecFixture()),
      PART_C_ENTITY_SCHEMAS.Block.parse(questionBlockFixture()),
      PART_C_ENTITY_SCHEMAS.Rendition.parse(videoRenditionFixture()),
      PART_C_ENTITY_SCHEMAS.MediaAsset.parse(mediaAssetFixture()),
      PART_C_ENTITY_SCHEMAS.Alignment.parse(alignmentFixture()),
      PART_C_ENTITY_SCHEMAS.ContentVersion.parse(contentVersionFixture()),
      PART_C_ENTITY_SCHEMAS.Plan.parse(planBodyFixture()),
      PART_C_ENTITY_SCHEMAS.PlanEntry.parse(planEntryFixture()),
      PART_C_ENTITY_SCHEMAS.PlanApproval.parse(planApprovalFixture()),
      PART_C_ENTITY_SCHEMAS.LearningEvent.parse(learningEventFixture()),
      PART_C_ENTITY_SCHEMAS.EvidenceAttainment.parse(
        evidenceAttainmentFixture(),
      ),
      PackageManifestV2Schema.parse(packageManifestFixture()),
      SnapshotV3Schema.parse(snapshotV3Fixture()),
    ];
    for (const instance of instances) {
      for (const key of collectKeys(instance)) {
        expect(key).not.toMatch(IDENTITY_HASH_KEY_PATTERN);
      }
    }
  });

  it('PlanBody key inventory and canonical bytes carry no wall-clock or locale fields', () => {
    const parsed = PlanBodySchema.parse(planBodyFixture());
    const keys = collectKeys(parsed);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toMatch(WALL_CLOCK_KEY_PATTERN);
    }
    const bytes = planBodyBytes(parsed);
    expect(bytes).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(bytes).not.toMatch(/[0-9a-f]{64}/i);
  });

  it('media identity is assetKey+assetVersion and plan bytes contain no fixed-width hex identity', () => {
    const asset = MediaAssetSchema.parse(mediaAssetFixture());
    expect(mediaAssetIdentity(asset)).toBe('asset-video-01@1');
    expect(mediaAssetIdentity({ ...asset, assetVersion: 2 })).toBe(
      'asset-video-01@2',
    );
    expect(planBodyBytes(PlanBodySchema.parse(planBodyFixture()))).not.toMatch(
      /[0-9a-f]{40,}/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. 旧包拒绝与包契约闭合（C5/B8）
// ---------------------------------------------------------------------------

describe('P0 package v2 contract and legacy rejection (C5/B8)', () => {
  it('accepts a closed v2 package and enforces course/content agreement', () => {
    const parsed = parsePackageManifestV2(packageManifestFixture());
    expect(parsed.formatVersion).toBe(2);
    expect(parsed.course.courseKey).toBe('modeling-life');
    expect(parsed.content.versionNo).toBe(1);
    expectInvalid(PackageManifestV2Schema, {
      ...packageManifestFixture(),
      course: {
        ...packageManifestFixture().course,
        categoryPath: ['Society'],
      },
    });
  });

  it('rejects legacy packages with PACKAGE_FORMAT_UNSUPPORTED (no compatibility parsing)', () => {
    const legacy = {
      format: 'lg-course-package',
      formatVersion: 1,
      packageId: 'pkg-legacy',
      exportedAt: ISO,
      source: { environment: 'sandbox', courseCode: 'modeling-life' },
      incomplete: false,
      course: {
        code: 'modeling-life',
        slug: 'modeling-life',
        category: 'Science',
        learningMode: 'VIDEO_ONLY',
        learningLanguages: ['en-GB'],
        defaultContentLanguage: 'en-GB',
        localized: {},
        lessons: [],
      },
    };
    expectPartCError(
      () => parsePackageManifestV2(legacy),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );

    const versionMismatch = { ...packageManifestFixture(), formatVersion: 1 };
    expectPartCError(
      () => parsePackageManifestV2(versionMismatch),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );

    const withLegacyCategory = {
      ...packageManifestFixture(),
      course: { ...packageManifestFixture().course, category: 'Science' },
    };
    expectPartCError(
      () => parsePackageManifestV2(withLegacyCategory),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );

    const missingCategoryPath = clone(packageManifestFixture());
    delete (
      missingCategoryPath.course as Partial<typeof missingCategoryPath.course>
    ).categoryPath;
    expectPartCError(
      () => parsePackageManifestV2(missingCategoryPath),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );

    const withHashField = {
      ...packageManifestFixture(),
      contentHash: 'deadbeef',
    };
    expectPartCError(
      () => parsePackageManifestV2(withHashField),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );
  });

  it('rejects readers/extensions beyond the frozen v1 capability set', () => {
    const newerReader = parsePackageManifestV2({
      ...packageManifestFixture(),
      minReaderVersion: PACKAGE_FORMAT_VERSION + 1,
    });
    expectPartCError(
      () => assertPackageReaderCompatible(newerReader),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );
    const unknownExtension = parsePackageManifestV2({
      ...packageManifestFixture(),
      extensionsRequired: ['future-alignment-format'],
    });
    expectPartCError(
      () => assertPackageReaderCompatible(unknownExtension),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );
    expect(() =>
      assertPackageReaderCompatible(
        parsePackageManifestV2(packageManifestFixture()),
      ),
    ).not.toThrow();
  });

  it('keeps the package closed: no traversal paths, no duplicate resources, no env ids in content', () => {
    expectInvalid(PackageManifestV2Schema, {
      ...packageManifestFixture(),
      resources: [
        {
          id: 'template-01',
          kind: 'template',
          path: '../template.xlsx',
          size: 1,
        },
      ],
    });
    expectInvalid(PackageManifestV2Schema, {
      ...packageManifestFixture(),
      resources: [
        { id: 'a', kind: 'template', path: 'same.xlsx', size: 1 },
        { id: 'b', kind: 'template', path: 'same.xlsx', size: 2 },
      ],
    });
    const content = clone(contentVersionContentFixture()) as Record<
      string,
      unknown
    >;
    content.contentVersionId = 'env-local-id';
    expectInvalid(PackageManifestV2Schema, {
      ...packageManifestFixture(),
      content,
    });
    const withPlanPin = clone(contentVersionContentFixture()) as Record<
      string,
      unknown
    >;
    withPlanPin.planPin = { planId: 'plan/x', planVersion: 1 };
    expectInvalid(PackageManifestV2Schema, {
      ...packageManifestFixture(),
      content: withPlanPin,
    });
  });
});

// ---------------------------------------------------------------------------
// 7b. 包 provenance/annotations 与 Part C 审计字段（C10.4/C10.6；评审阻断 3/5/6）
// ---------------------------------------------------------------------------

describe('P0 package provenance/annotations and audit contracts (C10)', () => {
  it('accepts the full sandbox provenance block and rejects malformed pins', () => {
    const parsed = parsePackageManifestV2(packageManifestFixture());
    expect(parsed.provenance?.sourceEnv).toBe('sandbox');
    expect(parsed.provenance?.asr?.modelVersion).toBe('asr-model-v1');
    expect(parsed.annotations).toEqual(packageManifestFixture().annotations);

    const missingPin = clone(packageManifestFixture()) as unknown as {
      provenance: Record<string, unknown>;
    };
    delete missingPin.provenance.exportedBy;
    expectPartCError(
      () => parsePackageManifestV2(missingPin),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );

    const badParams = clone(packageManifestFixture()) as unknown as {
      provenance: { asr: { params: unknown } };
    };
    badParams.provenance.asr.params = ['not', 'params'];
    expectPartCError(
      () => parsePackageManifestV2(badParams),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );
  });

  it('keeps provenance out of identity: absent provenance still parses while enforcement is dormant', () => {
    const manifest = clone(packageManifestFixture()) as Record<string, unknown>;
    delete manifest.provenance;
    const parsed = parsePackageManifestV2(manifest);
    expect(parsed.provenance).toBeUndefined();
  });

  it('rejects provenance.courseKey drift and non-object annotations', () => {
    const drift = clone(packageManifestFixture()) as unknown as {
      provenance: Record<string, unknown>;
    };
    drift.provenance.courseKey = 'other-course';
    expectPartCError(
      () => parsePackageManifestV2(drift),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );

    const badAnnotations = clone(packageManifestFixture()) as Record<
      string,
      unknown
    >;
    badAnnotations.annotations = ['not', 'object'];
    expectInvalid(PackageManifestV2Schema, badAnnotations);
    expectValid(PackageProvenanceSchema, packageProvenanceFixture());
    expectInvalid(PackageAnnotationsSchema, ['not', 'object']);
  });

  it('freezes asr/forced-alignment anchor sources on asset carriers (C7)', () => {
    expect(ANCHOR_SOURCES).toEqual([
      'subtitle',
      'chapter',
      'asr',
      'forced-alignment',
      'doc-structure',
      'import-legacy',
    ]);
    for (const anchorSource of ['asr', 'forced-alignment']) {
      expectValid(RenditionSchema, {
        ...videoRenditionFixture(),
        anchorSource,
      });
      expectInvalid(RenditionSchema, {
        ...textRenditionFixture(),
        anchorSource,
      });
    }
  });

  it('carries the alignment derivation audit tuple only in its valid shapes (C10.4)', () => {
    expect(ALIGNMENT_SOURCE_KINDS).toEqual([
      'subtitle',
      'chapter',
      'asr',
      'forced-alignment',
      'doc-structure',
    ]);
    const base = {
      ...alignmentFixture(),
      status: 'proposed',
      verifiedBy: undefined,
      verifiedAt: undefined,
      verifiedAgainst: undefined,
    };
    expectValid(AlignmentSchemaForTest(), {
      ...base,
      sourceKind: 'subtitle',
      sourceArtifact: 'subtitles/lesson-01.en-GB.srt',
      ruleVersion: 'timing-rules-v1',
    });
    expectValid(AlignmentSchemaForTest(), {
      ...base,
      sourceKind: 'asr',
      sourceArtifact: 'asr:asset-video-01:en-GB',
      modelVersion: 'asr-model-v1',
      params: { beam: 5 },
      ruleVersion: 'asr-rules-v1',
    });
    expectValid(AlignmentSchemaForTest(), {
      ...base,
      sourceKind: 'doc-structure',
      sourceArtifact: 'doc-lesson-01',
      ruleVersion: 'timing-rules-v1',
    });
    // sourceKind/sourceArtifact/ruleVersion 必须齐全
    expectInvalid(AlignmentSchemaForTest(), {
      ...base,
      sourceKind: 'subtitle',
    });
    // ASR/强制对齐必须 pin 模型与参数
    expectInvalid(AlignmentSchemaForTest(), {
      ...base,
      sourceKind: 'asr',
      sourceArtifact: 'asr:asset-video-01:en-GB',
      ruleVersion: 'asr-rules-v1',
    });
    // 其它来源不得携带模型 pin
    expectInvalid(AlignmentSchemaForTest(), {
      ...base,
      sourceKind: 'subtitle',
      sourceArtifact: 'subtitles/lesson-01.en-GB.srt',
      ruleVersion: 'timing-rules-v1',
      modelVersion: 'asr-model-v1',
    });
  });

  it('records env-local source labels on ContentVersion and snapshot provenance (C10.3)', () => {
    expectValid(ContentVersionSchema, {
      ...contentVersionFixture(),
      sourceEnv: 'sandbox',
      sourceLabel: 'Sandbox 4.2',
    });
    expectInvalid(ContentVersionSchema, {
      ...contentVersionFixture(),
      sourceEnv: 'uat',
    });
    expectValid(SnapshotV3Schema, {
      ...snapshotV3Fixture(),
      provenance: packageProvenanceFixture(),
      annotations: { exportedBy: 'admin' },
    });
    expectInvalid(SnapshotV3Schema, {
      ...snapshotV3Fixture(),
      provenance: { ...packageProvenanceFixture(), courseKey: 'other-course' },
    });
  });
});

// ---------------------------------------------------------------------------
// 8. 模板契约无时间列（B1/C5 P1）
// ---------------------------------------------------------------------------

describe('P0 template v2 contract has no time columns (B1/C5 P1)', () => {
  it('derives every machine sheet header from its schema and none looks like time', () => {
    const sheets = Object.keys(TEMPLATE_V2_SHEET_SCHEMAS);
    expect(sheets).toEqual([
      'Meta',
      'Media',
      'Course Info',
      'Lessons',
      'Learning Points',
      'Exhibits',
      'Reading List',
      'Knowledge Test',
      'Application Test',
    ]);
    for (const sheet of sheets as Array<keyof typeof TEMPLATE_V2_HEADERS>) {
      const headers = TEMPLATE_V2_HEADERS[sheet];
      expect(headers.length).toBeGreaterThan(0);
      expect(findHumanTimeColumns(headers)).toEqual([]);
      expect(() => assertNoHumanTimeColumns(headers)).not.toThrow();
    }
    expect(TEMPLATE_V2_HEADERS.Media).toEqual([
      'asset_key',
      'kind',
      'lesson_code',
      'language',
      'relative_path',
      'thumbnail_of',
    ]);
    expect(TEMPLATE_V2_HUMAN_SHEETS).toEqual(['Checklist']);
    expect(TEMPLATE_V2_SHEET_SCHEMAS).not.toHaveProperty('Checklist');
  });

  it('fails closed with HUMAN_TIME_FORBIDDEN on legacy time headers', () => {
    const legacyHeaders = [
      'Lesson ID',
      'Trigger · EN video',
      'Trigger · 中文 video',
      'Start (mm:ss)',
      '时长',
      'timestamp',
    ];
    const expectedOffenders = legacyHeaders.slice(1);
    expect(findHumanTimeColumns(legacyHeaders)).toEqual(expectedOffenders);
    expectPartCError(
      () => assertNoHumanTimeColumns(legacyHeaders),
      'HUMAN_TIME_FORBIDDEN',
    );
    const error = catchPartCError(() =>
      assertNoHumanTimeColumns(legacyHeaders),
    );
    expect((error.details as { columns: string[] }).columns).toEqual(
      expectedOffenders,
    );
  });

  it('rejects non-v2 template meta with TEMPLATE_FORMAT_UNSUPPORTED', () => {
    expectValid(TEMPLATE_V2_SHEET_SCHEMAS.Meta, templateMetaRowFixture());
    expectPartCError(
      () =>
        parseTemplateMetaRow({
          ...templateMetaRowFixture(),
          templateVersion: 1,
        }),
      'TEMPLATE_FORMAT_UNSUPPORTED',
    );
    expectPartCError(
      () =>
        parseTemplateMetaRow({
          ...templateMetaRowFixture(),
          templateVersion: undefined,
        }),
      'TEMPLATE_FORMAT_UNSUPPORTED',
    );
    expectInvalid(TEMPLATE_V2_SHEET_SCHEMAS.Meta, {
      ...templateMetaRowFixture(),
      durationColumn: 'mm:ss',
    });
  });
});

// ---------------------------------------------------------------------------
// 9. 错误码表（C5）
// ---------------------------------------------------------------------------

describe('P0 error code table (C5)', () => {
  const EXPECTED_CODES: PartCErrorCode[] = [
    'PACKAGE_FORMAT_UNSUPPORTED',
    'TEMPLATE_FORMAT_UNSUPPORTED',
    'PACKAGE_FILE_MISSING',
    'PACKAGE_FILE_UNKNOWN',
    'HUMAN_TIME_FORBIDDEN',
    'CATEGORY_NOT_FOUND',
    'TIMING_SOURCE_MISSING',
    'UNSUPPORTED_ORDERING',
    'PLAN_PREVIEW_STALE',
    'PLAN_NOT_APPROVED',
    'PLAN_INPUT_CHANGED',
    'CONTENT_VERSION_NOT_FOUND',
    'ASSET_NOT_FOUND',
  ];

  it('freezes exactly the C5 and application-gate error codes', () => {
    expect(Object.keys(PART_C_ERROR_DEFINITIONS).sort()).toEqual(
      [...EXPECTED_CODES].sort(),
    );
  });

  it('gives every code a phase, an HTTP status and a description', () => {
    for (const code of EXPECTED_CODES) {
      const definition = PART_C_ERROR_DEFINITIONS[code];
      expect(PART_C_PIPELINE_PHASES).toContain(definition.phase);
      expect(definition.httpStatus).toBeGreaterThanOrEqual(400);
      expect(definition.httpStatus).toBeLessThan(500);
      expect(typeof definition.retryable).toBe('boolean');
      expect(definition.description.length).toBeGreaterThan(0);
      expect(partCErrorHttpStatus(code)).toBe(definition.httpStatus);
    }
    expect(PART_C_ERROR_DEFINITIONS.PLAN_PREVIEW_STALE.httpStatus).toBe(409);
    expect(PART_C_ERROR_DEFINITIONS.PLAN_NOT_APPROVED.phase).toBe('P6');
    expect(PART_C_ERROR_DEFINITIONS.PLAN_NOT_APPROVED.httpStatus).toBe(409);
    expect(PART_C_ERROR_DEFINITIONS.PLAN_INPUT_CHANGED.phase).toBe('P6');
    expect(PART_C_ERROR_DEFINITIONS.PLAN_INPUT_CHANGED.retryable).toBe(true);
    expect(PART_C_ERROR_DEFINITIONS.CONTENT_VERSION_NOT_FOUND.phase).toBe('P7');
    expect(PART_C_ERROR_DEFINITIONS.CONTENT_VERSION_NOT_FOUND.httpStatus).toBe(
      404,
    );
  });

  it('freezes the C10 environment gates (source + capability)', () => {
    expect(Object.keys(PART_C_ENVIRONMENT_ERROR_DEFINITIONS).sort()).toEqual([
      'CAPABILITY_DISABLED',
      'PACKAGE_SOURCE_NOT_ALLOWED',
    ]);
    expect(partCEnvironmentErrorHttpStatus('PACKAGE_SOURCE_NOT_ALLOWED')).toBe(
      422,
    );
    expect(partCEnvironmentErrorHttpStatus('CAPABILITY_DISABLED')).toBe(403);
  });

  it('carries the code and machine-readable details on PartCError', () => {
    const error = new PartCError('TIMING_SOURCE_MISSING', 'missing cues', {
      lessonCode: 'lesson-01',
    });
    expect(isPartCError(error)).toBe(true);
    expect(error.code).toBe('TIMING_SOURCE_MISSING');
    expect(error.name).toBe('PartCError');
    expect(error.details).toEqual({ lessonCode: 'lesson-01' });
    expect(isPartCError(new Error('other'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. 业务键与身份辅助（C3）
// ---------------------------------------------------------------------------

describe('P0 identity helpers avoid hashing (C3)', () => {
  it('builds rendition business keys from the eight NOT NULL fields', () => {
    const rendition = RenditionSchema.parse(videoRenditionFixture());
    expect(renditionBusinessKey(rendition)).toBe(
      [
        'lesson-01',
        'v-01',
        'en-GB',
        'video',
        'asset',
        'asset-video-01',
        '1',
        'main',
      ].join('\u0000'),
    );
  });

  it('derives entry ids explicitly instead of by digest', () => {
    expect(
      derivePlanEntryId({
        stageKey: 'step-01',
        alignmentId: 'aln-01',
        occurrenceKey: 'main',
      }),
    ).toBe('entry:step-01:aln-01:main');
  });

  it('identifies evidence attainment rows by the ledger key tuple', () => {
    const first = EvidenceAttainmentSchema.parse(evidenceAttainmentFixture());
    const second = EvidenceAttainmentSchema.parse({
      ...evidenceAttainmentFixture(),
      attemptNo: 2,
    });
    expect(evidenceAttainmentIdentity(first)).toBe(
      ['cv-01', 'step-01', 'ev-01', '1'].join('\u0000'),
    );
    expect(evidenceAttainmentIdentity(first)).not.toBe(
      evidenceAttainmentIdentity(second),
    );
  });
});
