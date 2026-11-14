import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import type { Response } from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { signInAs } from './helpers/employee-session';

/**
 * 缝 S-API（评审阻断 4-API / 7 / 8）：Part C 管理端 API 全链路 e2e。
 *
 * 覆盖：
 * - StageTree 编辑：服务端生成 orderKey、STR-1 叶/容器规则、choice 拒绝；
 * - EvidenceSpec 版本化；
 * - preview → save → approve → publish 全链路（apply 门在服务端，写
 *   PcContentVersion + planPin；重复 publish 幂等 already-applied）；
 * - 后续 rejected 决定阻断 apply（即使之前 approved）；
 * - 同一 pins 下改 stage 树 → apply 拒绝（PLAN_BLOCKED / PLAN_INPUT_CHANGED）；
 * - 能力开关 off/on 两态：on + Production 下阶段树编辑 403 CAPABILITY_DISABLED，
 *   计划工作流（preview/save/approve/publish）不被能力门拦截。
 *
 * 黑盒边界：行为经 backoffice HTTP 观察；Prisma 只用于 arrange（Part C 导入/
 * 对齐签收不属本阶段 API）与 cleanup。
 */

jest.setTimeout(120_000);

const PREFIX = `E2E-PCAPI-${Date.now()}`;

interface PlanBodyView {
  planId: string;
  planVersion: number;
  contentVersionId: string;
  targetId: string;
  status: string;
  canonicalJson: string;
  entries: unknown[];
  warnings: Array<{ code: string }>;
}

function data<T>(response: Response): T {
  return (response.body as { data: T }).data;
}

function errorCode(response: Response): string {
  return (response.body as { error: { code: string } }).error.code;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

interface CourseFixture {
  courseKey: string;
  lessonKey: string;
  ktKey: string;
  objectiveKey: string;
  evidenceKey: string;
}

describe('Part C admin API (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  async function buildApp(env: {
    numbering?: 'sandbox' | 'production';
    enforcement?: 'on' | 'off';
  }): Promise<INestApplication<App>> {
    if (env.numbering) process.env.VERSION_NUMBERING_MODE = env.numbering;
    else delete process.env.VERSION_NUMBERING_MODE;
    if (env.enforcement)
      process.env.ENV_CAPABILITY_ENFORCEMENT = env.enforcement;
    else delete process.env.ENV_CAPABILITY_ENFORCEMENT;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const created = moduleFixture.createNestApplication();
    configureApp(created);
    await created.init();
    return created;
  }

  /** arrange：Part C 课程 + 内容规格/资产/rendition/objective（stage/对齐另建）。 */
  async function seedCourse(suffix: string): Promise<CourseFixture> {
    const courseKey = `${PREFIX}-${suffix}`;
    const lessonKey = `${courseKey}-lesson-1`;
    const ktKey = `${courseKey}-kt-1`;
    const objectiveKey = `${courseKey}-obj-1`;
    const evidenceKey = `${courseKey}-ev-1`;
    await prisma.pcCourse.create({
      data: {
        courseKey,
        categoryPath: Prisma.DbNull,
        titleLocalized: json({ 'en-GB': { title: `${courseKey} title` } }),
        publishTargets: json([
          { languages: ['en-GB'], modalities: ['video', 'text'] },
        ]),
      },
    });
    await prisma.pcObjective.create({
      data: {
        objectiveKey,
        statement: 'Understand the lesson',
        status: 'active',
      },
    });
    await prisma.pcContentSpec.create({
      data: {
        contentKey: lessonKey,
        version: 1,
        type: 'video',
        titleLocalized: json({ 'en-GB': { title: 'Lesson 1' } }),
      },
    });
    await prisma.pcContentSpec.create({
      data: {
        contentKey: ktKey,
        version: 1,
        type: 'knowledge-test',
        titleLocalized: json({ 'en-GB': { title: 'Knowledge test' } }),
      },
    });
    await prisma.pcMediaAsset.create({
      data: {
        assetKey: `${courseKey}-video`,
        assetVersion: 1,
        kind: 'video',
        language: 'en-GB',
        durationMs: 60000,
        uri: `test:${courseKey}/video.mp4`,
      },
    });
    await prisma.pcRendition.createMany({
      data: [
        {
          renditionKey: `${courseKey}-r-video-en`,
          contentKey: lessonKey,
          blockId: 'video',
          language: 'en-GB',
          modality: 'video',
          occurrenceKey: 'main',
          carrierType: 'asset',
          carrierKey: `${courseKey}-video`,
          carrierVersion: 1,
          startMs: 0,
          endMs: 60000,
          anchorSource: 'subtitle',
          revision: 1,
        },
        {
          renditionKey: `${courseKey}-r-doc-en`,
          contentKey: lessonKey,
          blockId: 'body',
          language: 'en-GB',
          modality: 'text',
          occurrenceKey: 'main',
          carrierType: 'document',
          carrierKey: `${courseKey}-doc-en`,
          carrierVersion: 1,
          headingCode: 'H1',
          offset: 0,
          anchorSource: 'doc-structure',
          revision: 1,
        },
        {
          renditionKey: `${courseKey}-r-test-en`,
          contentKey: ktKey,
          blockId: 'q.1',
          language: 'en-GB',
          modality: 'text',
          occurrenceKey: 'main',
          carrierType: 'document',
          carrierKey: `${courseKey}-doc-test`,
          carrierVersion: 1,
          anchorSource: 'doc-structure',
          revision: 1,
        },
      ],
    });
    return { courseKey, lessonKey, ktKey, objectiveKey, evidenceKey };
  }

  async function seedOfferings(fixture: CourseFixture): Promise<void> {
    const { courseKey, objectiveKey } = fixture;
    await prisma.pcEvidenceSpec.create({
      data: {
        evidenceKey: fixture.evidenceKey,
        version: 1,
        kind: 'assessment',
        objectiveKeys: [objectiveKey],
        measure: json({
          kind: 'assessment',
          contentKey: fixture.ktKey,
          blockIds: ['q.1'],
        }),
        scoring: 'points',
        threshold: 0.6,
        attempts: 2,
      },
    });
    await prisma.pcStage.createMany({
      data: [
        {
          stageKey: `${courseKey}-prog-1`,
          courseKey,
          parentStageKey: null,
          orderKey: '000001',
          kind: 'program',
          goal: 'Programme',
          objectiveKeys: [],
          exitEvidence: [],
          exitRollup: json({ kind: 'all' }),
          status: 'active',
        },
        {
          stageKey: `${courseKey}-step-1`,
          courseKey,
          parentStageKey: `${courseKey}-prog-1`,
          orderKey: '000001.000001',
          kind: 'step',
          goal: 'Watch the lesson',
          objectiveKeys: [objectiveKey],
          exitEvidence: [fixture.evidenceKey],
          exitRollup: json({ kind: 'all' }),
          status: 'active',
        },
      ],
    });
    await seedAlignments(fixture);
  }

  async function seedAlignments(fixture: CourseFixture): Promise<void> {
    const { courseKey, objectiveKey } = fixture;
    const verifiedAgainst = json({
      renditionRevision: 1,
      carrierVersion: 1,
      specVersion: 1,
    });
    await prisma.pcAlignment.createMany({
      data: [
        {
          alignmentId: `${courseKey}-a1`,
          stageKey: `${courseKey}-step-1`,
          renditionKey: `${courseKey}-r-video-en`,
          objectiveKey,
          role: 'primary',
          status: 'verified',
          provenance: 'human',
          verifiedBy: 'e2e-editor',
          verifiedAt: new Date('2026-11-12T09:00:00Z'),
          verifiedAgainst,
        },
        {
          alignmentId: `${courseKey}-a2`,
          stageKey: `${courseKey}-step-1`,
          renditionKey: `${courseKey}-r-doc-en`,
          objectiveKey,
          role: 'support',
          status: 'verified',
          provenance: 'human',
          verifiedBy: 'e2e-editor',
          verifiedAt: new Date('2026-11-12T09:01:00Z'),
          verifiedAgainst,
        },
        {
          alignmentId: `${courseKey}-a3`,
          stageKey: `${courseKey}-step-1`,
          renditionKey: `${courseKey}-r-test-en`,
          objectiveKey,
          role: 'assessment',
          status: 'verified',
          provenance: 'human',
          verifiedBy: 'e2e-editor',
          verifiedAt: new Date('2026-11-12T09:02:00Z'),
          verifiedAgainst,
        },
      ],
    });
  }

  function stageTreeBody(fixture: CourseFixture) {
    return {
      stages: [
        {
          stageKey: `${fixture.courseKey}-prog-1`,
          parentStageKey: null,
          kind: 'program',
          goal: 'Programme',
          objectiveKeys: [],
          exitEvidence: [],
        },
        {
          stageKey: `${fixture.courseKey}-step-1`,
          parentStageKey: `${fixture.courseKey}-prog-1`,
          kind: 'step',
          goal: 'Watch the lesson',
          objectiveKeys: [fixture.objectiveKey],
          exitEvidence: [fixture.evidenceKey],
        },
      ],
      prerequisiteEdges: [],
    };
  }

  beforeAll(async () => {
    app = await buildApp({});
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    delete process.env.ENV_CAPABILITY_ENFORCEMENT;
    delete process.env.VERSION_NUMBERING_MODE;
    // 工作区课程行（apply 的 sourceLabel 取 CommerceCourse.draftSourceVersionLabel）。
    await prisma.commerceCourse
      .deleteMany({ where: { code: { startsWith: PREFIX } } })
      .catch(() => undefined);
    // PcContentVersion 冻结后不可删（DB 触发器），其 planPin 与 course FK 也随之
    // 保留 —— 这是设计（发布后不可变）。可清理的只有草稿树与全局内容工件。
    const courses = await prisma.pcCourse.findMany({
      where: { courseKey: { startsWith: PREFIX } },
      select: { courseKey: true },
    });
    for (const { courseKey } of courses) {
      await prisma.pcStage.deleteMany({ where: { courseKey } });
    }
    await prisma.pcRendition.deleteMany({
      where: { contentKey: { startsWith: PREFIX } },
    });
    await prisma.pcContentSpec.deleteMany({
      where: { contentKey: { startsWith: PREFIX } },
    });
    await prisma.pcMediaAsset.deleteMany({
      where: { assetKey: { startsWith: PREFIX } },
    });
    await prisma.pcObjective.deleteMany({
      where: { objectiveKey: { startsWith: PREFIX } },
    });
    await prisma.pcEvidenceSpec.deleteMany({
      where: { evidenceKey: { startsWith: PREFIX } },
    });
    await app.close();
  });

  it('edits the stage tree (server-generated orderKeys, STR-1 rules, choice rejection)', async () => {
    const fixture = await seedCourse('TREE');
    const agent = await signInAs(app, 'ADMIN');

    // exitEvidence 必须有 EvidenceSpec（STR-5 的编辑期显式报错）。
    const missingEvidence = await agent
      .put(`/api/backoffice/courses/${fixture.courseKey}/partc/stages`)
      .send(stageTreeBody(fixture));
    expect(missingEvidence.status).toBe(422);
    expect(errorCode(missingEvidence)).toBe('VALIDATION_ERROR');

    const spec = await agent
      .put(
        `/api/backoffice/courses/${fixture.courseKey}/partc/evidence-specs/${fixture.evidenceKey}`,
      )
      .send({
        kind: 'assessment',
        objectiveKeys: [fixture.objectiveKey],
        measure: {
          kind: 'assessment',
          contentKey: fixture.ktKey,
          blockIds: ['q.1'],
        },
        scoring: 'points',
        threshold: 0.6,
        attempts: 2,
      });
    expect(spec.status).toBe(200);
    expect(data<{ version: number }>(spec).version).toBe(1);

    const applied = await agent
      .put(`/api/backoffice/courses/${fixture.courseKey}/partc/stages`)
      .send(stageTreeBody(fixture));
    expect(applied.status).toBe(200);
    const stages = data<{
      stages: Array<{ stageKey: string; orderKey: string }>;
    }>(applied).stages;
    expect(stages.map((stage) => stage.orderKey)).toEqual([
      '000001',
      '000001.000001',
    ]);
    // 同一 evidenceKey 再写一次 → 新版本（不覆盖历史）。
    const secondSpec = await agent
      .put(
        `/api/backoffice/courses/${fixture.courseKey}/partc/evidence-specs/${fixture.evidenceKey}`,
      )
      .send({
        kind: 'assessment',
        objectiveKeys: [fixture.objectiveKey],
        measure: {
          kind: 'assessment',
          contentKey: fixture.ktKey,
          blockIds: ['q.1'],
        },
        scoring: 'points',
        threshold: 0.65,
        attempts: 2,
      });
    expect(data<{ version: number }>(secondSpec).version).toBe(2);

    // orderKey 由服务端生成（C3）：客户端携带 orderKey 一律拒绝，不静默忽略。
    const clientOrderKey = stageTreeBody(fixture);
    const withOrderKey = await agent
      .put(`/api/backoffice/courses/${fixture.courseKey}/partc/stages`)
      .send({
        ...clientOrderKey,
        stages: clientOrderKey.stages.map((stage, index) =>
          index === 0 ? { ...stage, orderKey: '000009' } : stage,
        ),
      });
    expect(withOrderKey.status).toBe(422);
    expect(errorCode(withOrderKey)).toBe('VALIDATION_ERROR');

    const choice = await agent
      .put(`/api/backoffice/courses/${fixture.courseKey}/partc/stages`)
      .send({
        ...stageTreeBody(fixture),
        choiceGroups: [{ key: 'choose-one' }],
      });
    expect(choice.status).toBe(422);
    expect(errorCode(choice)).toBe('UNSUPPORTED_ORDERING');

    // 未知课程的读接口 404。
    const missing = await agent.get(
      `/api/backoffice/courses/${PREFIX}-NOPE/partc/stages`,
    );
    expect(missing.status).toBe(404);
    expect(errorCode(missing)).toBe('COURSE_NOT_FOUND');
  });

  it('runs preview → save → approve → publish and refuses a later rejected decision (e2e)', async () => {
    const fixture = await seedCourse('FLOW');
    // 导入课程包会把 provenance.sourceVersionLabel 落到工作区的
    // draftSourceVersionLabel；apply 冻结 ContentVersion 时写进 sourceLabel（C10.3）。
    await prisma.commerceCourse.create({
      data: {
        code: fixture.courseKey,
        slug: fixture.courseKey.toLowerCase(),
        learningMode: 'VIDEO_AND_TEXT',
        learningLanguages: json(['en-GB']),
        draftSourceType: 'IMPORT',
        draftSourceEnvironment: 'sandbox',
        draftSourceVersionLabel: '4.2',
      },
    });
    const agent = await signInAs(app, 'ADMIN');
    const base = `/api/backoffice/courses/${fixture.courseKey}/partc`;

    const spec = await agent
      .put(`${base}/evidence-specs/${fixture.evidenceKey}`)
      .send({
        kind: 'assessment',
        objectiveKeys: [fixture.objectiveKey],
        measure: {
          kind: 'assessment',
          contentKey: fixture.ktKey,
          blockIds: ['q.1'],
        },
        scoring: 'points',
        threshold: 0.6,
        attempts: 2,
      });
    expect(spec.status).toBe(200);
    const stages = await agent
      .put(`${base}/stages`)
      .send(stageTreeBody(fixture));
    expect(stages.status).toBe(200);
    // 对齐签收现由管理端 API 提供（本用例只验证计划链路，故直接用 Prisma
    // arrange 三行已验证人签对齐；签收行为见下一个用例）。
    await seedAlignments(fixture);

    const preview = await agent.post(`${base}/plans/preview`).send({});
    expect(preview.status).toBe(200);
    const plan = data<PlanBodyView>(preview);
    expect(plan.status).toBe('draft');
    expect(plan.planVersion).toBe(1);
    expect(plan.contentVersionId).toBe(`cv-${fixture.courseKey}-v1`);
    expect(plan.entries.length).toBeGreaterThan(0);
    expect(plan.warnings).toEqual([]);

    // save 必须字节相等（服务端按当前 DB 重算）。
    const staleSave = await agent.post(`${base}/plans/save`).send({
      planId: plan.planId,
      planVersion: plan.planVersion,
      canonicalJson: '{"stale":true}',
    });
    expect(staleSave.status).toBe(409);
    expect(errorCode(staleSave)).toBe('PLAN_PREVIEW_STALE');

    const saved = await agent.post(`${base}/plans/save`).send({
      planId: plan.planId,
      planVersion: plan.planVersion,
      canonicalJson: plan.canonicalJson,
    });
    expect(saved.status).toBe(200);
    expect(data<PlanBodyView>(saved).status).toBe('draft');

    const approved = await agent.post(`${base}/plans/approve`).send({
      planId: plan.planId,
      planVersion: plan.planVersion,
      decision: 'approved',
      acceptedWarnings: plan.warnings,
    });
    expect(approved.status).toBe(200);
    expect(data<{ status: string }>(approved).status).toBe('approved');

    const published = await agent
      .post(`${base}/plans/publish`)
      .send({ planId: plan.planId, planVersion: plan.planVersion });
    expect(published.status).toBe(200);
    const applied = data<{
      status: string;
      contentVersionId: string;
      versionNo: number;
    }>(published);
    expect(applied.status).toBe('applied');
    expect(applied.contentVersionId).toBe(`cv-${fixture.courseKey}-v1`);
    expect(applied.versionNo).toBe(1);

    const version = await prisma.pcContentVersion.findFirstOrThrow({
      where: { courseKey: fixture.courseKey },
    });
    expect(version.planId).toBe(plan.planId);
    expect(version.planVersion).toBe(plan.planVersion);
    expect(version.sourceEnv).toBe('sandbox');
    // C10.3：sourceLabel 取包 provenance.sourceVersionLabel（不伪造、环境局部）。
    expect(version.sourceLabel).toBe('4.2');
    expect((version.stages as unknown[]).length).toBe(2);
    expect(
      (version.alignments as Array<{ status: string }>).every(
        (alignment) => alignment.status === 'verified',
      ),
    ).toBe(true);

    // 重复 publish 幂等：不新增版本、不回拨指针。
    const repeat = await agent
      .post(`${base}/plans/publish`)
      .send({ planId: plan.planId, planVersion: plan.planVersion });
    expect(repeat.status).toBe(200);
    expect(data<{ status: string }>(repeat).status).toBe('already-applied');
    expect(
      await prisma.pcContentVersion.count({
        where: { courseKey: fixture.courseKey },
      }),
    ).toBe(1);

    // 后续 rejected 决定必须阻断 apply（旧 approved 不再被信任）。
    const rejected = await agent.post(`${base}/plans/approve`).send({
      planId: plan.planId,
      planVersion: plan.planVersion,
      decision: 'rejected',
    });
    expect(rejected.status).toBe(200);
    const blocked = await agent
      .post(`${base}/plans/publish`)
      .send({ planId: plan.planId, planVersion: plan.planVersion });
    expect(blocked.status).toBe(409);
    expect(errorCode(blocked)).toBe('PLAN_NOT_APPROVED');

    // 同一 pins 下改 stage 树：重新批准后 apply 仍必须拒绝（重算不一致/blocked）。
    const reApproved = await agent.post(`${base}/plans/approve`).send({
      planId: plan.planId,
      planVersion: plan.planVersion,
      decision: 'approved',
      acceptedWarnings: plan.warnings,
    });
    expect(reApproved.status).toBe(200);
    const changedTree = stageTreeBody(fixture);
    changedTree.stages[1].objectiveKeys = [`${fixture.courseKey}-obj-other`];
    const treeUpdate = await agent.put(`${base}/stages`).send(changedTree);
    expect(treeUpdate.status).toBe(200);
    const refused = await agent
      .post(`${base}/plans/publish`)
      .send({ planId: plan.planId, planVersion: plan.planVersion });
    expect(refused.status).toBe(409);
    expect(['PLAN_BLOCKED', 'PLAN_INPUT_CHANGED']).toContain(
      errorCode(refused),
    );
    expect(
      await prisma.pcContentVersion.count({
        where: { courseKey: fixture.courseKey },
      }),
    ).toBe(1);
  });

  it('signs off proposed alignments (proposed → verified/rejected); compilePlan only consumes verified', async () => {
    const fixture = await seedCourse('SIGN');
    await seedOfferings(fixture);
    const base = `/api/backoffice/courses/${fixture.courseKey}/partc`;
    const agent = await signInAs(app, 'ADMIN');
    const a1 = `${fixture.courseKey}-a1`;
    const a2 = `${fixture.courseKey}-a2`;
    const verifiedAgainst = {
      renditionRevision: 1,
      carrierVersion: 1,
      specVersion: 1,
    };

    // arrange：模拟导入派生的 proposed 对齐（人签三件套为空、审计来源保留）。
    await prisma.pcAlignment.update({
      where: { alignmentId: a1 },
      data: {
        status: 'proposed',
        provenance: 'import',
        sourceKind: 'subtitle',
        sourceArtifact: 'subtitles/lesson.en-GB.srt',
        ruleVersion: 'time-range-v1',
        verifiedBy: null,
        verifiedAt: null,
        verifiedAgainst: Prisma.DbNull,
      },
    });

    // 读接口能看到 proposed（管理员复核的对象）。
    const listed = await agent.get(`${base}/alignments`).expect(200);
    const listedBody =
      data<Array<{ alignmentId: string; status: string }>>(listed);
    expect(listedBody.find((entry) => entry.alignmentId === a1)?.status).toBe(
      'proposed',
    );

    // ALN-2：编译/发布只吃 verified —— primary 对齐仍是 proposed ⇒ blocked。
    const blockedPreview = await agent.post(`${base}/plans/preview`).send({});
    expect(blockedPreview.status).toBe(200);
    expect(data<PlanBodyView>(blockedPreview).status).toBe('blocked');

    // 客户端观察到的粘合元组与当前 pin 不等 ⇒ ALIGNMENT_STALE（服务端重算）。
    const stale = await agent.post(`${base}/alignments/${a1}/sign-off`).send({
      decision: 'verified',
      verifiedAgainst: { ...verifiedAgainst, renditionRevision: 2 },
    });
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe('ALIGNMENT_STALE');

    // 人签：verifiedBy 取会话员工，verifiedAgainst 由服务端真源派生。
    const signed = await agent
      .post(`${base}/alignments/${a1}/sign-off`)
      .send({ decision: 'verified', verifiedAgainst });
    expect(signed.status).toBe(200);
    const signedBody = data<{
      status: string;
      verifiedBy: string;
      verifiedAt: string;
      verifiedAgainst: unknown;
      sourceKind?: string;
      ruleVersion?: string;
    }>(signed);
    expect(signedBody.status).toBe('verified');
    expect(typeof signedBody.verifiedBy).toBe('string');
    expect(signedBody.verifiedBy.length).toBeGreaterThan(0);
    expect(signedBody.verifiedAgainst).toEqual(verifiedAgainst);
    // 审计元组由导入派生写入，签收只补人签三件套（不伪造来源）。
    expect(signedBody.sourceKind).toBe('subtitle');
    expect(signedBody.ruleVersion).toBe('time-range-v1');

    // 重复签收 ⇒ 409（状态机只有 proposed → verified/rejected）。
    const again = await agent
      .post(`${base}/alignments/${a1}/sign-off`)
      .send({ decision: 'verified' });
    expect(again.status).toBe(409);
    expect(errorCode(again)).toBe('ALIGNMENT_ALREADY_DECIDED');

    // 签收后 Plan 不再 blocked（alignmentSetVersion 已变，preview 生成新计划）。
    const afterPreview = await agent.post(`${base}/plans/preview`).send({});
    expect(afterPreview.status).toBe(200);
    expect(data<PlanBodyView>(afterPreview).status).toBe('draft');

    // rejected：另一条 proposed 对齐被拒绝，且不得残留人签三件套。
    await prisma.pcAlignment.update({
      where: { alignmentId: a2 },
      data: {
        status: 'proposed',
        provenance: 'import',
        verifiedBy: null,
        verifiedAt: null,
        verifiedAgainst: Prisma.DbNull,
      },
    });
    const rejectedRes = await agent
      .post(`${base}/alignments/${a2}/sign-off`)
      .send({ decision: 'rejected' });
    expect(rejectedRes.status).toBe(200);
    expect(data<{ status: string }>(rejectedRes).status).toBe('rejected');
    const rejectedRow = await prisma.pcAlignment.findUniqueOrThrow({
      where: { alignmentId: a2 },
    });
    expect(rejectedRow.status).toBe('rejected');
    expect(rejectedRow.verifiedBy).toBeNull();
    expect(rejectedRow.verifiedAt).toBeNull();
    expect(rejectedRow.verifiedAgainst).toBeNull();
  });

  it('capability switch off/on: production + enforcement on blocks stage edits but allows plan workflow', async () => {
    const fixture = await seedCourse('CAP');
    // arrange：完整内容直接用 Prisma 落库（阶段编辑 API 在 enforcement on 下会被 403）。
    await seedOfferings(fixture);
    const base = `/api/backoffice/courses/${fixture.courseKey}/partc`;

    // off（默认）：Production 下作者操作照常（UAT 即生产，不能锁死）。
    const offApp = await buildApp({
      numbering: 'production',
      enforcement: 'off',
    });
    try {
      const offAgent = await signInAs(offApp, 'ADMIN');
      const allowed = await offAgent
        .put(`/api/backoffice/courses/${fixture.courseKey}/partc/stages`)
        .send(stageTreeBody(fixture));
      expect(allowed.status).toBe(200);
    } finally {
      await offApp.close();
    }

    // on：Production 下 stage/evidence 编辑 403；plan 工作流全部可用。
    const onApp = await buildApp({
      numbering: 'production',
      enforcement: 'on',
    });
    try {
      const agent = await signInAs(onApp, 'ADMIN');
      const denied = await agent
        .put(`/api/backoffice/courses/${fixture.courseKey}/partc/stages`)
        .send(stageTreeBody(fixture));
      expect(denied.status).toBe(403);
      expect(errorCode(denied)).toBe('CAPABILITY_DISABLED');

      const preview = await agent.post(`${base}/plans/preview`).send({});
      expect(preview.status).toBe(200);
      const plan = data<PlanBodyView>(preview);
      expect(plan.status).toBe('draft');

      const saved = await agent.post(`${base}/plans/save`).send({
        planId: plan.planId,
        planVersion: plan.planVersion,
        canonicalJson: plan.canonicalJson,
      });
      expect(saved.status).toBe(200);

      const approved = await agent.post(`${base}/plans/approve`).send({
        planId: plan.planId,
        planVersion: plan.planVersion,
        decision: 'approved',
        acceptedWarnings: plan.warnings,
      });
      expect(approved.status).toBe(200);

      const published = await agent
        .post(`${base}/plans/publish`)
        .send({ planId: plan.planId, planVersion: plan.planVersion });
      expect(published.status).toBe(200);
      expect(data<{ status: string }>(published).status).toBe('applied');
      const version = await prisma.pcContentVersion.findFirstOrThrow({
        where: { courseKey: fixture.courseKey },
      });
      expect(version.sourceEnv).toBe('production');
    } finally {
      delete process.env.ENV_CAPABILITY_ENFORCEMENT;
      delete process.env.VERSION_NUMBERING_MODE;
      await onApp.close();
    }
  });
});
