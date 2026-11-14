import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Test, TestingModule } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import { Client as PgClient } from 'pg';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import type { Response } from 'supertest';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { E2E_PASSWORD, signInAs } from './helpers/employee-session';

/**
 * 长程真实测试 T5 + T6（docs/Course_Category_LongRange_TestPlan.md §2）。
 *
 * T5 导入原子性与幂等：
 * - 分类 / 时间 / 内容任一失败 → 整包回滚，草稿不变（HTTP 可观察状态逐字段相同）。
 * - 同一真实包导入两次 → 可观察投影逐条一致（no-op），无重复 stage/alignment。
 * - 并发导入同一课程 → 一个成功或整齐失败，不出现重复行/半成品。
 * T6 快照 / 版本 / 投影：
 * - 冻结快照（GET partc/content-versions）含 categoryPath + 阶段/rendition 映射，
 *   不含环境 UUID 身份（无 categoryId/assetId，对齐身份必须稳定可搬运）。
 * - 草稿改动不泄漏已发布快照；再次发布后生效。
 * - Restore 缺分类/缺资产报错且草稿不变。
 * - F6 跨库（同实例第二个 database）：导出 → 导入 → 发布 → 快照投影一致。
 *
 * 黑盒边界：
 * - 所有断言只读 HTTP 响应（backoffice / partc API）。Prisma 只用于 arrange
 *   （分类/外部 stage/坏版本/第二个库的账号）与 cleanup，不用于断言业务字段。
 * - 真实资产：F2_subtitles 由真实 Modeling life zip 构建（两段真实视频、真实
 *   docx/png），F4 基线是真实视频的 10 秒真实截取，没有合成玩具视频。
 * - 不 import 生产域逻辑；AppModule/configureApp 只是启动 HTTP 服务的既有 harness。
 *
 * 运行：
 *   export DATABASE_URL=postgresql://admin:admin@localhost:5432/learning_guide_e2e
 *   npx jest --runInBand test/longrange-atomicity-snapshot.e2e-spec.ts
 */

jest.setTimeout(900_000);

const PREFIX = `E2E-LR-T56-${Date.now()}`;
// 真实包 F2 的 courseKey 固定为 modeling-life；测试库的 PcContentVersion 是
// 发布后不可删的 append-only 行，所以每次运行把它重写到唯一键，互不污染。
const MODELING_KEY = `${PREFIX}-MODELING`;
const FIXTURES = path.resolve(__dirname, 'fixtures/longrange');
const F2_ZIP = path.join(FIXTURES, 'F2_subtitles/F2_subtitles.zip');
const F4_BASELINE_DIR = path.join(FIXTURES, 'F4_bad_packages/_baseline');
const F4_BAD_TIME_ZIP = path.join(
  FIXTURES,
  'F4_bad_packages/05-out-of-range-time.zip',
);

type Agent = Awaited<ReturnType<typeof signInAs>>;

interface JobView {
  jobId: string;
  status: string;
  error: string | null;
  courseId: string | null;
  report: {
    errors: Array<{ code: string; message: string }>;
    warnings: Array<{ code: string; message: string }>;
  };
}

interface CourseDetail {
  id: string;
  code: string;
  hasDraft: boolean;
  lifecycleStatus: string;
  category: { id: string; name: string } | null;
  lessons: Array<{
    id: string;
    code: string;
    localizations: Array<{
      language: string;
      title: string;
      videoAssetId: string | null;
      videoDurationSeconds: number | null;
    }>;
  }>;
}

interface StageView {
  stageKey: string;
  parentStageKey: string | null;
  orderKey: string;
  kind: string;
  goal: string;
  objectiveKeys: string[];
  exitEvidence: string[];
  status: string;
}

interface AlignmentView {
  alignmentId: string;
  stageKey: string;
  renditionKey: string;
  objectiveKey: string;
  role: string;
  status: string;
  provenance: string;
  sourceKind?: string;
  verifiedBy?: string;
  verifiedAt?: string;
  verifiedAgainst?: unknown;
}

interface RenditionView {
  renditionKey: string;
  modality: string;
  anchorSource: string;
  startMs: number;
  endMs: number;
}

interface ContentVersionView {
  contentVersionId: string;
  courseKey: string;
  versionNo: number;
  frozenAt: string;
  sourceEnv?: string;
  sourceLabel?: string;
  categoryPath: string[] | null;
  stages: StageView[];
  renditions: RenditionView[];
  alignments: AlignmentView[];
  evidenceSpecs: unknown[];
  assetPins: Array<{ assetKey: string; assetVersion: number }>;
  planPin: { planId: string; planVersion: number };
}

interface PlanView {
  planId: string;
  planVersion: number;
  contentVersionId: string;
  targetId: string;
  status: string;
  canonicalJson: string;
  entries: unknown[];
  warnings: Array<Record<string, unknown>>;
  gaps: Array<{ reason: string; message: string }>;
  issues: unknown[];
}

interface MutableManifest {
  packageId?: string;
  course: { courseKey: string; categoryPath?: string[] };
  content: {
    courseKey?: string;
    categoryPath?: string[];
    stages?: Array<{ courseKey?: string }>;
  };
  resources: Array<{ kind: string; size?: number; path?: string; id?: string }>;
  provenance?: { courseKey?: string } | null;
}

interface ExportedManifestLite {
  content?: {
    alignments?: unknown[];
    renditions?: unknown[];
    stages?: Array<{ stageKey: string }>;
  };
}

interface EmployeeAccountRow {
  login_email: string;
  role: string;
  account_status: string;
  email_verification: string;
  email_verified_at: string;
  password_hash: string;
  is_bootstrap_admin: boolean;
}

interface PreviewView {
  content?: {
    lessons?: Array<{
      code: string;
      learningPoints?: Array<{ code: string }>;
      exhibits?: Array<{ code: string }>;
    }>;
  };
}

function data<T>(response: Response): T {
  return (response.body as { data: T }).data;
}

function errorCode(response: Response): string {
  return (response.body as { error?: { code?: string } }).error?.code ?? '';
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** 只保留可观察的稳定投影（用于失败前后逐字段比较）。 */
function observableOf(input: {
  detail: CourseDetail;
  preview: unknown;
  stages: { stages: StageView[]; prerequisiteEdges: unknown[] };
  alignments: AlignmentView[];
}) {
  return {
    detail: input.detail,
    preview: input.preview,
    stages: input.stages,
    alignments: input.alignments,
  };
}

function publishableWarnings(plan: PlanView): PlanView['warnings'] {
  return plan.warnings;
}

function binaryParser(
  res: NodeJS.ReadableStream,
  callback: (error: Error | null, body?: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
  res.on('error', (error: Error) => callback(error));
}

/**
 * F4 的 `_baseline/` 是合法的最小 v2 包（真实视频 10 秒截取 + 真实封面 +
 * 合法模板/字幕），但夹具只保存了未打包目录；这里按 manifest.resources
 * 原样装配 ZIP（不修改任何内容）。
 */
async function buildCleanBaselineZip(): Promise<Buffer> {
  const manifestBytes = await fs.readFile(
    path.join(F4_BASELINE_DIR, 'manifest.json'),
  );
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    resources: Array<{ path: string }>;
  };
  const zip = new JSZip();
  zip.file('manifest.json', manifestBytes);
  for (const resource of manifest.resources) {
    const bytes = await fs.readFile(path.join(F4_BASELINE_DIR, resource.path));
    zip.file(resource.path, bytes);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('Long-range T5 (import atomicity/idempotency) + T6 (snapshot/version/projection)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let agent: Agent;

  let f2Zip: Buffer;
  let f2CourseZip: Buffer;
  let baselineZip: Buffer;
  let badTimeZip: Buffer;
  const createdCourseIds: string[] = [];
  const createdJobIds: string[] = [];
  const createdCourseKeys: string[] = [];
  const storageRoot = path.resolve(
    process.env.COURSE_PACKAGE_ROOT?.trim() || 'storage/course-package',
  );

  /**
   * 清除一门 Part C 课程的全部本地行（测试专用、只用于本套件固定键/前缀）。
   * 顺序受 FK 约束：事件/达成 → 审批/发布/内容版本/plan → 对齐 →
   * rendition/block/spec/evidence/objective/media → 边 → stage → course。
   * 只做 cleanup/arrange，不用于业务断言。
   */
  async function purgePartcCourse(courseKey: string): Promise<void> {
    const stages = await prisma.pcStage
      .findMany({ where: { courseKey }, select: { stageKey: true } })
      .catch(() => []);
    const stageKeys = stages.map((stage) => stage.stageKey);
    const plans = await prisma.pcPlan
      .findMany({ where: { courseKey }, select: { planId: true } })
      .catch(() => []);
    const planIds = plans.map((plan) => plan.planId);
    const specs = await prisma.pcContentSpec
      .findMany({ where: { courseKey }, select: { contentKey: true } })
      .catch(() => []);
    const contentKeys = specs.map((spec) => spec.contentKey);
    const renditionRows = contentKeys.length
      ? await prisma.pcRendition
          .findMany({
            where: { contentKey: { in: contentKeys } },
            select: { carrierKey: true },
          })
          .catch(() => [])
      : [];
    const carrierKeys = [
      ...new Set(renditionRows.map((row) => row.carrierKey)),
    ];
    const versions = await prisma.pcContentVersion
      .findMany({ where: { courseKey }, select: { contentVersionId: true } })
      .catch(() => []);
    const contentVersionIds = versions.map(
      (version) => version.contentVersionId,
    );

    if (contentVersionIds.length) {
      await prisma.pcLearningEvent
        .deleteMany({ where: { contentVersionId: { in: contentVersionIds } } })
        .catch(() => undefined);
      await prisma.pcEvidenceAttainment
        .deleteMany({ where: { contentVersionId: { in: contentVersionIds } } })
        .catch(() => undefined);
    }
    // PcContentVersion / PcPublication / 其绑定的 PcPlan 是发布后不可变的
    // append-only 行（DB 触发器拒绝删除）；cleanup 不触碰它们。测试因此为每次
    // 运行使用唯一 courseKey，避免历史行影响新用例。
    if (planIds.length === 0) {
      await prisma.pcPlan
        .deleteMany({ where: { courseKey } })
        .catch(() => undefined);
    }
    if (stageKeys.length) {
      await prisma.pcAlignment
        .deleteMany({ where: { stageKey: { in: stageKeys } } })
        .catch(() => undefined);
      await prisma.pcPrerequisiteEdge
        .deleteMany({
          where: {
            OR: [
              { fromStageKey: { in: stageKeys } },
              { toStageKey: { in: stageKeys } },
            ],
          },
        })
        .catch(() => undefined);
    }
    if (contentKeys.length) {
      await prisma.pcRendition
        .deleteMany({ where: { contentKey: { in: contentKeys } } })
        .catch(() => undefined);
      await prisma.pcBlock
        .deleteMany({ where: { contentKey: { in: contentKeys } } })
        .catch(() => undefined);
      await prisma.pcContentSpec
        .deleteMany({ where: { contentKey: { in: contentKeys } } })
        .catch(() => undefined);
    }
    const objectives = await prisma.pcObjective
      .findMany({ where: { courseKey }, select: { objectiveKey: true } })
      .catch(() => []);
    if (objectives.length) {
      await prisma.pcObjective
        .deleteMany({
          where: {
            objectiveKey: { in: objectives.map((o) => o.objectiveKey) },
          },
        })
        .catch(() => undefined);
    }
    if (carrierKeys.length) {
      await prisma.pcMediaAsset
        .deleteMany({
          where: {
            assetKey: { in: carrierKeys },
            assetVersion: 1,
          },
        })
        .catch(() => undefined);
    }
    const evidenceKeys = new Set<string>();
    for (const stage of stages) {
      const row = await prisma.pcStage
        .findUnique({
          where: { stageKey: stage.stageKey },
          select: { exitEvidence: true },
        })
        .catch(() => null);
      row?.exitEvidence.forEach((key) => evidenceKeys.add(key));
    }
    if (evidenceKeys.size) {
      await prisma.pcEvidenceSpec
        .deleteMany({ where: { evidenceKey: { in: [...evidenceKeys] } } })
        .catch(() => undefined);
    }
    if (stageKeys.length) {
      await prisma.pcStage
        .deleteMany({ where: { stageKey: { in: stageKeys } } })
        .catch(() => undefined);
    }
    await prisma.pcCourse
      .deleteMany({ where: { courseKey } })
      .catch(() => undefined);
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    agent = await signInAs(app, 'ADMIN');

    // 本套件使用真实包的固定 courseKey；重写到本次运行的唯一键后导入。
    await purgePartcCourse(MODELING_KEY);
    await prisma.commerceCourse
      .deleteMany({ where: { code: MODELING_KEY } })
      .catch(() => undefined);

    f2Zip = await fs.readFile(F2_ZIP);
    f2CourseZip = await mutatePackage(f2Zip, (manifest) =>
      rewriteCourseKey(manifest, MODELING_KEY),
    );
    baselineZip = await buildCleanBaselineZip();
    badTimeZip = await fs.readFile(F4_BAD_TIME_ZIP);

    // 真实包的分类路径是 ["Science"]；设计规定分类单源在 Admin，没有 HTTP 管理入口。
    // 这里只 arrange 一个 ACTIVE 分类（若 seed 已存在则复用）。
    const science = await prisma.courseCatalogueEntry.findFirst({
      where: { name: 'Science', parentId: null },
      select: { id: true },
    });
    if (science) {
      await prisma.courseCatalogueEntry.update({
        where: { id: science.id },
        data: { status: 'ACTIVE' },
      });
    } else {
      await prisma.courseCatalogueEntry.create({
        data: {
          name: 'Science',
          parentId: null,
          status: 'ACTIVE',
          sortOrder: 0,
        },
      });
    }
  });

  afterAll(async () => {
    // best effort cleanup：只删本套件创建的课程与作业；append-only 事件失败不影响。
    for (const jobId of createdJobIds) {
      await prisma.coursePackageJob
        .deleteMany({ where: { id: jobId } })
        .catch(() => undefined);
      await fs
        .rm(path.join(storageRoot, jobId), { recursive: true, force: true })
        .catch(() => undefined);
    }
    for (const id of createdCourseIds) {
      await prisma.coursePackageJob
        .deleteMany({ where: { courseId: id } })
        .catch(() => undefined);
      await prisma.courseVersion
        .deleteMany({ where: { courseId: id } })
        .catch(() => undefined);
      await prisma.commerceCourse
        .deleteMany({ where: { id } })
        .catch(() => undefined);
    }
    for (const courseKey of createdCourseKeys) {
      await purgePartcCourse(courseKey);
    }
    await app.close();
  });

  async function getJob(
    jobId: string,
    client: Agent = agent,
  ): Promise<JobView> {
    const res = await client
      .get(`/api/backoffice/courses/import/${jobId}`)
      .expect(200);
    return data<JobView>(res);
  }

  async function upload(
    bytes: Buffer | Uint8Array,
    name: string,
    targetCourseId?: string,
    client: Agent = agent,
  ): Promise<JobView> {
    const endpoint = targetCourseId
      ? `/api/backoffice/courses/${targetCourseId}/import`
      : '/api/backoffice/courses/import';
    const res = await client.post(endpoint).attach('file', Buffer.from(bytes), {
      filename: name,
      contentType: 'application/zip',
    });
    const body = res.body as { data?: JobView; error?: { code: string } };
    if (!body.data?.jobId) {
      throw new Error(
        `upload failed: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    createdJobIds.push(body.data.jobId);
    return body.data;
  }

  async function confirm(
    jobId: string,
    onConflict: 'ABORT' | 'CREATE_NEW_COURSE' | 'NEW_VERSION' = 'ABORT',
    client: Agent = agent,
  ): Promise<Response> {
    return client
      .post(`/api/backoffice/courses/import/${jobId}/confirm`)
      .send({ onConflict });
  }

  async function confirmReady(
    jobId: string,
    onConflict: 'ABORT' | 'CREATE_NEW_COURSE' | 'NEW_VERSION' = 'ABORT',
    client: Agent = agent,
  ): Promise<{ status: string; courseId: string }> {
    const res = await confirm(jobId, onConflict, client);
    if (res.status !== 200) {
      const job = await getJob(jobId, client);
      throw new Error(
        `confirm failed (${res.status}): ${JSON.stringify(res.body)} report=${JSON.stringify(job.report)}`,
      );
    }
    const view = data<{ status: string; courseId: string }>(res);
    expect(view.status).toBe('READY');
    createdCourseIds.push(view.courseId);
    return view;
  }

  async function importNew(
    bytes: Buffer | Uint8Array,
    name: string,
    client: Agent = agent,
  ): Promise<{ jobId: string; courseId: string }> {
    const job = await upload(bytes, name, undefined, client);
    if (job.status !== 'AWAITING_CONFIRM') {
      const full = await getJob(job.jobId, client);
      throw new Error(
        `upload validation did not reach AWAITING_CONFIRM (status=${job.status}): ${JSON.stringify(full.report)} error=${full.error}`,
      );
    }
    const ready = await confirmReady(job.jobId, 'CREATE_NEW_COURSE', client);
    return { jobId: job.jobId, courseId: ready.courseId };
  }

  async function courseDetail(courseId: string): Promise<CourseDetail> {
    const res = await agent
      .get(`/api/backoffice/courses/${courseId}`)
      .expect(200);
    return data<CourseDetail>(res);
  }

  async function coursePreview(courseId: string): Promise<unknown> {
    const res = await agent
      .get(`/api/backoffice/courses/${courseId}/preview`)
      .expect(200);
    return data<unknown>(res);
  }

  async function partcStages(
    courseKey: string,
    client: Agent = agent,
  ): Promise<{
    stages: StageView[];
    prerequisiteEdges: unknown[];
  }> {
    const res = await client
      .get(`/api/backoffice/courses/${courseKey}/partc/stages`)
      .expect(200);
    return data(res);
  }

  async function partcAlignments(
    courseKey: string,
    client: Agent = agent,
  ): Promise<AlignmentView[]> {
    const res = await client
      .get(`/api/backoffice/courses/${courseKey}/partc/alignments`)
      .expect(200);
    return data<AlignmentView[]>(res);
  }

  async function partcRenditions(
    courseKey: string,
    client: Agent = agent,
  ): Promise<Array<Record<string, unknown>>> {
    const res = await client
      .get(`/api/backoffice/courses/${courseKey}/partc/renditions`)
      .expect(200);
    return data<Array<Record<string, unknown>>>(res);
  }

  async function contentVersions(
    courseKey: string,
    client: Agent = agent,
  ): Promise<ContentVersionView[]> {
    const res = await client
      .get(`/api/backoffice/courses/${courseKey}/partc/content-versions`)
      .expect(200);
    return data<ContentVersionView[]>(res);
  }

  async function observe(courseKey: string, courseId: string) {
    return observableOf({
      detail: await courseDetail(courseId),
      preview: await coursePreview(courseId),
      stages: await partcStages(courseKey),
      alignments: await partcAlignments(courseKey),
    });
  }

  /** 读包内 manifest + 工作簿，改 courseKey / categoryPath / 单个缺陷后重新打包。 */
  async function mutatePackage(
    bytes: Buffer,
    mutator: (manifest: MutableManifest) => void,
  ): Promise<Buffer> {
    const zip = await JSZip.loadAsync(bytes);
    const manifest = JSON.parse(
      await zip.file('manifest.json')!.async('string'),
    ) as MutableManifest;
    mutator(manifest);
    const templateEntry = zip.file('template.xlsx');
    if (templateEntry) {
      const workbook = XLSX.read(await templateEntry.async('nodebuffer'), {
        type: 'buffer',
      });
      const meta = workbook.Sheets.Meta;
      if (meta) {
        const matrix = XLSX.utils.sheet_to_json<unknown[]>(meta, {
          header: 1,
          defval: null,
        });
        const headers = matrix[0] ?? [];
        const codeIndex = headers.indexOf('courseCode');
        for (let row = 1; row < matrix.length; row += 1) {
          if (codeIndex >= 0)
            matrix[row][codeIndex] = manifest.course.courseKey;
        }
        workbook.Sheets.Meta = XLSX.utils.aoa_to_sheet(matrix);
      }
      const templateBytes = XLSX.write(workbook, {
        type: 'buffer',
        bookType: 'xlsx',
      }) as Buffer;
      zip.file('template.xlsx', templateBytes);
      const templateResource = manifest.resources.find(
        (resource: { kind: string }) => resource.kind === 'template',
      );
      if (templateResource) templateResource.size = templateBytes.length;
    }
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  function rewriteCourseKey(
    manifest: MutableManifest,
    courseKey: string,
  ): void {
    manifest.course.courseKey = courseKey;
    manifest.content.courseKey = courseKey;
    for (const stage of manifest.content.stages ?? []) {
      stage.courseKey = courseKey;
    }
    manifest.packageId = `pkg_${courseKey}_${Date.now()}`;
    if (manifest.provenance) manifest.provenance.courseKey = courseKey;
  }

  async function signOffAllProposed(
    courseKey: string,
    client: Agent = agent,
  ): Promise<void> {
    const alignments = await partcAlignments(courseKey, client);
    for (const alignment of alignments.filter(
      (entry) => entry.status === 'proposed',
    )) {
      const res = await client
        .post(
          `/api/backoffice/courses/${courseKey}/partc/alignments/${alignment.alignmentId}/sign-off`,
        )
        .send({ decision: 'verified' });
      expect([200, 409]).toContain(res.status);
    }
  }

  /**
   * arrange：导入器按设计“不猜”（无旧对齐、无显式 binding seed 时不生成
   * Alignment）。T6.1 需要一份可发布的 verified 集合，这里直接用 Prisma
   * 落下两条人签 verified 对齐（与 partc-api e2e 的既有 arrange 方式一致）；
   * 创建 binding 的正式入口是 POST /partc/alignments + sign-off（见 T6.0，
   * 这里为了只测快照/发布机制而直接 arrange）；断言仍只读 HTTP。
   */
  async function arrangeVerifiedVideoAlignments(
    courseKey: string,
  ): Promise<void> {
    const stages = await prisma.pcStage.findMany({
      where: { courseKey, kind: 'step' },
      orderBy: { orderKey: 'asc' },
      select: { stageKey: true, objectiveKeys: true },
    });
    const contentByStage: Record<string, string> = {
      'lesson-1': 'L1',
      'lesson-2': 'L2',
    };
    for (const [index, stage] of stages.entries()) {
      const contentKey = contentByStage[stage.stageKey];
      if (!contentKey) continue;
      const renditions = await prisma.pcRendition.findMany({
        where: {
          contentKey,
          modality: 'video',
          language: 'en-GB',
          anchorSource: 'subtitle',
        },
        orderBy: { renditionKey: 'asc' },
      });
      if (renditions.length === 0) continue;
      const spec = await prisma.pcContentSpec.findFirst({
        where: { contentKey },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const objectiveKey = stage.objectiveKeys[0];
      for (const [renditionIndex, rendition] of renditions.entries()) {
        const alignmentId = `aln.${String(index + 1).padStart(4, '0')}.${String(
          renditionIndex + 1,
        ).padStart(4, '0')}`;
        await prisma.pcAlignment.upsert({
          where: {
            stageKey_renditionKey: {
              stageKey: stage.stageKey,
              renditionKey: rendition.renditionKey,
            },
          },
          create: {
            alignmentId,
            stageKey: stage.stageKey,
            renditionKey: rendition.renditionKey,
            objectiveKey,
            role: renditionIndex === 0 ? 'primary' : 'support',
            status: 'verified',
            provenance: 'human',
            verifiedBy: 'e2e-editor',
            verifiedAt: new Date('2026-11-13T00:00:00Z'),
            verifiedAgainst: json({
              renditionRevision: rendition.revision,
              carrierVersion: rendition.carrierVersion,
              specVersion: spec?.version ?? 1,
            }),
          },
          update: {
            objectiveKey,
            role: renditionIndex === 0 ? 'primary' : 'support',
            status: 'verified',
            provenance: 'human',
            verifiedBy: 'e2e-editor',
            verifiedAt: new Date('2026-11-13T00:00:00Z'),
            verifiedAgainst: json({
              renditionRevision: rendition.revision,
              carrierVersion: rendition.carrierVersion,
              specVersion: spec?.version ?? 1,
            }),
          },
        });
      }
    }
  }

  async function publishPartcPlan(
    courseKey: string,
    client: Agent = agent,
  ): Promise<{
    plan: PlanView;
    published: { status: string; contentVersionId: string; versionNo: number };
  }> {
    const base = `/api/backoffice/courses/${courseKey}/partc`;
    const preview = await client.post(`${base}/plans/preview`).send({});
    expect(preview.status).toBe(200);
    const plan = data<PlanView>(preview);
    if (plan.status === 'blocked') {
      throw new Error(
        `plan blocked: gaps=${JSON.stringify(plan.gaps)} issues=${JSON.stringify(plan.issues)}`,
      );
    }
    const saved = await client.post(`${base}/plans/save`).send({
      planId: plan.planId,
      planVersion: plan.planVersion,
      canonicalJson: plan.canonicalJson,
    });
    expect(saved.status).toBe(200);
    const approved = await client.post(`${base}/plans/approve`).send({
      planId: plan.planId,
      planVersion: plan.planVersion,
      decision: 'approved',
      acceptedWarnings: publishableWarnings(plan),
    });
    expect(approved.status).toBe(200);
    const published = await client.post(`${base}/plans/publish`).send({
      planId: plan.planId,
      planVersion: plan.planVersion,
    });
    expect(published.status).toBe(200);
    return {
      plan,
      published: data<{
        status: string;
        contentVersionId: string;
        versionNo: number;
      }>(published),
    };
  }

  /** 草稿导出 F6 包并等待 worker 产出（真实 165MB 媒体随包）。 */
  async function exportWorkingZip(
    courseId: string,
    client: Agent = agent,
  ): Promise<Buffer> {
    const started = await client
      .post(`/api/backoffice/courses/${courseId}/export`)
      .send({ version: 'working' })
      .expect(202);
    const jobId = data<{ jobId: string }>(started).jobId;
    createdJobIds.push(jobId);
    const deadline = Date.now() + 180_000;
    for (;;) {
      const res = await client
        .get(`/api/backoffice/courses/export/${jobId}`)
        .expect(200);
      const job = data<{ status: string; error: string | null }>(res);
      if (job.status === 'READY') break;
      if (job.status === 'FAILED') {
        throw new Error(`export failed: ${job.error}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`export did not finish: status=${job.status}`);
      }
      await sleep(500);
    }
    const download = await client
      .get(`/api/backoffice/courses/export/${jobId}/download`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    return download.body as Buffer;
  }

  // =========================================================================
  // T5.1 失败整包回滚：时间源失败 / 分类失败都不得改动草稿
  // =========================================================================

  it('T5.1 rolls the whole package back on a timing error (draft unchanged)', async () => {
    const courseKey = `${PREFIX}-ATOMIC`.toUpperCase();
    createdCourseKeys.push(courseKey);
    const base = await mutatePackage(baselineZip, (manifest) =>
      rewriteCourseKey(manifest, courseKey),
    );
    const imported = await importNew(base, `${courseKey}-baseline.zip`);
    const before = await observe(courseKey, imported.courseId);

    const badTime = await mutatePackage(badTimeZip, (manifest) =>
      rewriteCourseKey(manifest, courseKey),
    );
    const badJob = await upload(
      badTime,
      `${courseKey}-bad-time.zip`,
      imported.courseId,
    );
    const validated = await getJob(badJob.jobId);
    if (validated.status === 'FAILED') {
      // 上传校验阶段即整包拒绝（编译/派生全部在写入之前）。
      expect(validated.report.errors.map((error) => error.code)).toContain(
        'TIMING_RANGE_INVALID',
      );
    } else {
      const failed = await confirm(badJob.jobId);
      expect([409, 422]).toContain(failed.status);
      expect(errorCode(failed)).toBe('TIMING_RANGE_INVALID');
    }

    const after = await observe(courseKey, imported.courseId);
    expect(after).toEqual(before);
  });

  it('T5.1 rolls back on a category resolution error after media transfer', async () => {
    const courseKey = `${PREFIX}-ATOMIC-CAT`.toUpperCase();
    createdCourseKeys.push(courseKey);
    const base = await mutatePackage(baselineZip, (manifest) =>
      rewriteCourseKey(manifest, courseKey),
    );
    const imported = await importNew(base, `${courseKey}-baseline.zip`);
    const before = await observe(courseKey, imported.courseId);

    const badCategory = await mutatePackage(base, (manifest) => {
      rewriteCourseKey(manifest, courseKey);
      manifest.course.categoryPath = [`${PREFIX}-NO-SUCH-CATEGORY`];
      manifest.content.categoryPath = [`${PREFIX}-NO-SUCH-CATEGORY`];
    });
    const badJob = await upload(
      badCategory,
      `${courseKey}-bad-category.zip`,
      imported.courseId,
    );
    const failed = await confirm(badJob.jobId);
    expect(failed.status).toBe(422);
    expect(errorCode(failed)).toBe('CATEGORY_NOT_FOUND');

    const after = await observe(courseKey, imported.courseId);
    expect(after).toEqual(before);
  });

  // =========================================================================
  // T5.2 同一真实包导入两次：可观察投影逐条一致（no-op），无重复行
  // =========================================================================

  it('T5.2 re-imports the real F2 package as a no-op without duplicate observable rows', async () => {
    const imported = await importNew(f2CourseZip, 'F2_subtitles.zip');
    createdCourseKeys.push(MODELING_KEY);
    const courseKey = MODELING_KEY;

    const stages1 = await partcStages(courseKey);
    const alignments1 = await partcAlignments(courseKey);
    const preview1 = await coursePreview(imported.courseId);
    const detail1 = await courseDetail(imported.courseId);

    // 同一包导入到已有课程（只替换草稿）。
    const job2 = await upload(
      f2CourseZip,
      'F2_subtitles.zip',
      imported.courseId,
    );
    expect(job2.status).toBe('AWAITING_CONFIRM');
    const second = await confirm(job2.jobId);
    expect(second.status).toBe(200);

    const stages2 = await partcStages(courseKey);
    const alignments2 = await partcAlignments(courseKey);
    const preview2 = await coursePreview(imported.courseId);
    const detail2 = await courseDetail(imported.courseId);

    // 阶段/对齐按稳定键逐条一致，且没有重复的 stageKey 或 (stageKey,renditionKey)。
    expect(stages2.stages.map((stage) => stage.stageKey)).toEqual(
      stages1.stages.map((stage) => stage.stageKey),
    );
    expect(stages2).toEqual(stages1);
    const alignKey = (a: AlignmentView) => `${a.stageKey}|${a.renditionKey}`;
    expect(new Set(alignments2.map(alignKey)).size).toBe(alignments2.length);
    expect([...alignments2].map(alignKey).sort()).toEqual(
      [...alignments1].map(alignKey).sort(),
    );
    expect(
      alignments2.map((a) => ({
        stageKey: a.stageKey,
        renditionKey: a.renditionKey,
        objectiveKey: a.objectiveKey,
        role: a.role,
        status: a.status,
        sourceKind: a.sourceKind,
      })),
    ).toEqual(
      alignments1.map((a) => ({
        stageKey: a.stageKey,
        renditionKey: a.renditionKey,
        objectiveKey: a.objectiveKey,
        role: a.role,
        status: a.status,
        sourceKind: a.sourceKind,
      })),
    );

    // 工作区投影：课时/学习点/展品逐条一致，数量不增长。
    const lessonCodes = (preview: PreviewView) =>
      (preview.content?.lessons ?? []).map((lesson) => ({
        code: lesson.code,
        learningPoints: (lesson.learningPoints ?? []).map((lp) => lp.code),
        exhibits: (lesson.exhibits ?? []).map((exhibit) => exhibit.code),
      }));
    expect(lessonCodes(preview2)).toEqual(lessonCodes(preview1));
    expect(detail2.lessons.map((lesson) => lesson.code)).toEqual(
      detail1.lessons.map((lesson) => lesson.code),
    );
    expect(new Set(stages2.stages.map((s) => s.stageKey)).size).toBe(
      stages2.stages.length,
    );
  });

  // =========================================================================
  // T5.3 并发导入同一课程：一个成功或整齐失败，无重复/半成品
  // =========================================================================

  it('T5.3 handles two concurrent imports of the same new course without duplicates', async () => {
    const courseKey = `${PREFIX}-CONC`.toUpperCase();
    createdCourseKeys.push(courseKey);
    const zip = await mutatePackage(baselineZip, (manifest) =>
      rewriteCourseKey(manifest, courseKey),
    );

    const [jobA, jobB] = await Promise.all([
      upload(zip, `${courseKey}-a.zip`),
      upload(zip, `${courseKey}-b.zip`),
    ]);
    expect(jobA.status).toBe('AWAITING_CONFIRM');
    expect(jobB.status).toBe('AWAITING_CONFIRM');

    const [resA, resB] = await Promise.all([
      confirm(jobA.jobId, 'CREATE_NEW_COURSE'),
      confirm(jobB.jobId, 'CREATE_NEW_COURSE'),
    ]);
    const statuses = [resA.status, resB.status].sort();
    // 一个成功；另一个必须可识别地失败。500（INTERNAL_ERROR / 唯一键冲突）不算
    // “整齐失败”，先完成无重复/无半成品检查，再把该契约缺口作为红项断言。
    const exactlyOneSuccess = statuses[0] === 200 && statuses[1] >= 400;
    const cleanFailure = statuses[1] < 500;
    expect(exactlyOneSuccess).toBe(true);

    const winner = resA.status === 200 ? resA : resB;
    const courseId = data<{ courseId: string }>(winner).courseId;
    createdCourseIds.push(courseId);

    // 列表里只出现一门该 code 的课程。
    const list = await agent
      .get(
        `/api/backoffice/courses?search=${encodeURIComponent(courseKey)}&pageSize=50`,
      )
      .expect(200);
    const matches = (
      data<{ courses: Array<{ code: string }> }>(list).courses ?? []
    ).filter((row) => row.code === courseKey);
    expect(matches).toHaveLength(1);

    const stages = await partcStages(courseKey);
    expect(new Set(stages.stages.map((s) => s.stageKey)).size).toBe(
      stages.stages.length,
    );
    const alignments = await partcAlignments(courseKey);
    const key = (a: AlignmentView) => `${a.stageKey}|${a.renditionKey}`;
    expect(new Set(alignments.map(key)).size).toBe(alignments.length);

    // 半成品检查：草稿投影必须能完整读取（课程详情有课时、预览可读）。
    const detail = await courseDetail(courseId);
    expect(detail.lessons.length).toBeGreaterThan(0);
    const preview = (await coursePreview(courseId)) as PreviewView;
    expect(preview).toBeTruthy();

    expect(cleanFailure).toBe(true);
  });

  // =========================================================================
  // T6.0 导入不猜绑定（C5 P4）：人显式创建 proposed 再签收
  // =========================================================================

  it('T6.0 import does not guess bindings; a human creates proposed alignments explicitly and signs them off', async () => {
    const courseKey = MODELING_KEY;
    // 重新导入真实包到同一课程（不会覆盖人签；此处 T6.1 尚未 arrange）。
    const courseRow = await agent
      .get(
        `/api/backoffice/courses?search=${encodeURIComponent(courseKey)}&pageSize=50`,
      )
      .expect(200);
    const row = (
      data<{ courses: Array<{ code: string; id?: string }> }>(courseRow)
        .courses ?? []
    ).find((item) => item.code === courseKey);
    expect(row).toBeTruthy();

    const stages = await partcStages(courseKey);
    const afterImport = await partcAlignments(courseKey);
    expect(stages.stages.length).toBeGreaterThan(0);

    // 依据：设计 §14 C5 P4——全新包不猜 stage↔内容绑定。导入只派生
    // ContentSpec/Block/Rendition；不得凭空产生 proposed 对齐（否则等于机器
    // 替人绑定）。人选绑定必须走显式 API：POST /partc/alignments。
    expect(afterImport.filter((a) => a.status === 'proposed')).toEqual([]);

    // 引用一条已由导入落库的 rendition（机器只引用既有行，不合成）。
    const step = stages.stages.find((stage) => stage.kind === 'step');
    expect(step).toBeDefined();
    expect(step!.objectiveKeys.length).toBeGreaterThan(0);
    const renditions = await partcRenditions(courseKey);
    const video = renditions.find((entry) => entry.modality === 'video');
    expect(video).toBeDefined();

    // 显式创建 proposed（provenance=human）；服务端校验 stage 属于课程、
    // objective 属于该 stage、rendition 已落库。
    const created = await agent
      .post(`/api/backoffice/courses/${courseKey}/partc/alignments`)
      .send({
        stageKey: step!.stageKey,
        renditionKey: video!.renditionKey,
        objectiveKey: step!.objectiveKeys[0],
        role: 'primary',
      })
      .expect(201);
    const proposed = data<AlignmentView>(created);
    expect(proposed.status).toBe('proposed');
    expect(proposed.provenance).toBe('human');

    // 再走人签收：proposed → verified（服务端派生 verifiedAgainst 审计元组）。
    const signed = await agent
      .post(
        `/api/backoffice/courses/${courseKey}/partc/alignments/${proposed.alignmentId}/sign-off`,
      )
      .send({ decision: 'verified' })
      .expect(200);
    const verified = data<AlignmentView>(signed);
    expect(verified.status).toBe('verified');
    expect(verified.verifiedBy).toBeTruthy();
    expect(verified.verifiedAgainst).toBeDefined();

    // 清理：该行只用于验证「显式创建 → 人签收」链路；删除后让后续测试回到
    // 导入态（C5 P4：无绑定），也避免把显式 API 生成的环境本地 UUID
    // alignmentId 带进 T6.1 的冻结快照断言。
    await prisma.pcAlignment.delete({
      where: { alignmentId: verified.alignmentId },
    });
    expect(await partcAlignments(courseKey)).toEqual([]);
  });

  // =========================================================================
  // T6.1 冻结快照：categoryPath + 阶段/rendition 映射，且无环境 UUID 身份
  // =========================================================================

  it('T6.1 freezes categoryPath and stage/rendition mappings without environment UUID identity', async () => {
    // 复用 T5.2 导入的真实 F2 课程。
    const courseKey = MODELING_KEY;
    const course = await agent
      .get(
        `/api/backoffice/courses?search=${encodeURIComponent(courseKey)}&pageSize=50`,
      )
      .expect(200);
    const row = (
      data<{ courses: Array<{ code: string; id: string }> }>(course).courses ??
      []
    ).find((item) => item.code === courseKey);
    expect(row).toBeTruthy();

    // 导入器不猜语义绑定（设计 ALN：无旧对齐/无显式 seed ⇒ 无 proposal）。
    // T6.1 需要一份可发布的 verified 集合，这里用 arrange 直接落下两条人签
    // verified（创建 binding 的 HTTP 入口见 T6.0），随后只经 HTTP 发布。
    await arrangeVerifiedVideoAlignments(courseKey);
    await signOffAllProposed(courseKey);
    const { published } = await publishPartcPlan(courseKey);
    expect(published.status).toBe('applied');

    const versions = await contentVersions(courseKey);
    expect(versions.length).toBeGreaterThanOrEqual(1);
    const frozen = versions.at(-1)!;

    // 分类是稳定路径，不是环境 UUID。
    expect(frozen.categoryPath).toEqual(['Science']);
    expect(frozen).not.toHaveProperty('categoryId');

    // 阶段 + rendition 映射：stageKey 稳定、video rendition 有机器时间源坐标。
    expect(frozen.stages.map((stage) => stage.stageKey).sort()).toEqual(
      ['lesson-1', 'lesson-2', 'program-modeling-life'].sort(),
    );
    const videoRenditions = frozen.renditions.filter(
      (rendition) => rendition.modality === 'video',
    );
    expect(videoRenditions.length).toBeGreaterThan(0);
    for (const rendition of videoRenditions) {
      expect(rendition.anchorSource).toBe('subtitle');
      expect(typeof rendition.startMs).toBe('number');
      expect(typeof rendition.endMs).toBe('number');
      expect(rendition.startMs).toBeLessThan(rendition.endMs);
    }
    // 资产 pins 用 (assetKey, assetVersion)，不是环境 assetId。
    expect(frozen.assetPins.length).toBeGreaterThan(0);
    for (const pin of frozen.assetPins) {
      expect(pin.assetKey).toEqual(expect.any(String));
      expect(pin.assetVersion).toBe(1);
      expect(pin).not.toHaveProperty('assetId');
    }
    // 冻结只收 verified 对齐。
    expect(frozen.alignments.length).toBeGreaterThan(0);
    expect(frozen.alignments.every((a) => a.status === 'verified')).toBe(true);
    // 无环境 UUID 身份：对齐身份必须是稳定可搬运的 token，不能是随机 UUID。
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(
      frozen.alignments.filter((alignment) => uuid.test(alignment.alignmentId)),
    ).toEqual([]);
  });

  // =========================================================================
  // T6.2 草稿改动不泄漏已发布快照；再次发布后生效
  // =========================================================================

  it('T6.2 keeps the published snapshot unchanged after a draft stage edit, then publishes v2', async () => {
    const courseKey = MODELING_KEY;
    const before = await contentVersions(courseKey);
    expect(before.length).toBe(1);
    const v1 = before[0];

    const tree = await partcStages(courseKey);
    const edited = {
      stages: tree.stages.map((stage) => ({
        stageKey: stage.stageKey,
        parentStageKey: stage.parentStageKey,
        kind: stage.kind,
        goal:
          stage.stageKey === 'lesson-1' ? 'Draft-only goal edit' : stage.goal,
        objectiveKeys: stage.objectiveKeys,
        exitEvidence: stage.exitEvidence,
        status: stage.status,
      })),
      prerequisiteEdges: tree.prerequisiteEdges,
    };
    const put = await agent
      .put(`/api/backoffice/courses/${courseKey}/partc/stages`)
      .send(edited);
    expect(put.status).toBe(200);

    const duringDraft = await contentVersions(courseKey);
    expect(duringDraft).toEqual(before);
    expect(duringDraft[0].stages).toEqual(v1.stages);

    const { published } = await publishPartcPlan(courseKey);
    expect(published.status).toBe('applied');
    expect(published.versionNo).toBe(2);

    const after = await contentVersions(courseKey);
    expect(after.length).toBe(2);
    // 旧版本逐字段不变（不可变快照）。
    expect(after[0]).toEqual(v1);
    const v2 = after[1];
    expect(v2.versionNo).toBe(2);
    expect(v2.stages.find((stage) => stage.stageKey === 'lesson-1')?.goal).toBe(
      'Draft-only goal edit',
    );
  });

  // =========================================================================
  // T6.3 Restore：缺分类报错且草稿不变（PART C / legacy 投影的共同规则）
  // =========================================================================

  it('T6.3 refuses restore when the snapshot category path no longer resolves and leaves the draft unchanged', async () => {
    // 使用 T5.1 的真实基线课程，先发布 v1（legacy 工作区快照 v3）。
    const courseKey = `${PREFIX}-ATOMIC`.toUpperCase();
    const courseRow = await agent
      .get(
        `/api/backoffice/courses?search=${encodeURIComponent(courseKey)}&pageSize=50`,
      )
      .expect(200);
    const row = (
      data<{ courses: Array<{ code: string; id?: string }> }>(courseRow)
        .courses ?? []
    ).find((item) => item.code === courseKey);
    expect(row).toBeTruthy();
    const courseId = row.id as string;

    // 构造一个 ACTIVE 分类，并直接排一条 v3 快照（坏版本无 HTTP 写入口）。
    const category = await prisma.courseCatalogueEntry.create({
      data: {
        name: `${PREFIX} TEMP CAT`,
        parentId: null,
        status: 'ACTIVE',
        sortOrder: 0,
      },
      select: { id: true, name: true },
    });
    const snapshot = {
      formatVersion: 3,
      capturedAt: new Date().toISOString(),
      course: {
        code: courseKey,
        slug: courseKey.toLowerCase(),
        categoryPath: [category.name],
        learningMode: 'VIDEO_AND_TEXT',
        defaultContentLanguage: 'en-GB',
        learningLanguages: ['en-GB'],
        localizations: [
          {
            language: 'en-GB',
            title: `${courseKey} legacy title`,
            shortDescription: null,
            overview: null,
            whatYouLearn: [],
            provides: [],
          },
        ],
        lessons: [],
      },
    };
    const version = await prisma.courseVersion.create({
      data: {
        courseId,
        versionNo: 900,
        versionLabel: '900.0',
        versionSeries: 900,
        versionMinor: 0,
        snapshotData: json(snapshot),
        createdBy: null,
      },
      select: { id: true },
    });
    createdCourseIds.push(courseId);
    // 删除分类：restore 必须报 CATEGORY_NOT_FOUND，且在任何写入之前失败。
    await prisma.courseCatalogueEntry.delete({ where: { id: category.id } });

    const before = await observe(courseKey, courseId);
    const restored = await agent
      .post(`/api/backoffice/courses/${courseId}/restore`)
      .send({ versionId: version.id });
    expect(restored.status).toBe(422);
    expect(errorCode(restored)).toBe('CATEGORY_NOT_FOUND');
    const after = await observe(courseKey, courseId);
    expect(after).toEqual(before);
  });

  it('T6.3 refuses restore when a referenced media asset no longer exists and leaves the draft unchanged', async () => {
    const courseKey = `${PREFIX}-ATOMIC-ASSET`.toUpperCase();
    createdCourseKeys.push(courseKey);
    const base = await mutatePackage(baselineZip, (manifest) =>
      rewriteCourseKey(manifest, courseKey),
    );
    const imported = await importNew(base, `${courseKey}-baseline.zip`);
    const before = await observe(courseKey, imported.courseId);

    // 快照引用一个本环境不存在的 CourseMediaAsset id（v3 快照 + 当前存在的分类）。
    const missingAssetId = randomUUID();
    const snapshot = {
      formatVersion: 3,
      capturedAt: new Date().toISOString(),
      course: {
        code: courseKey,
        slug: courseKey.toLowerCase(),
        categoryPath: ['Science'],
        coverAssetId: null,
        learningMode: 'VIDEO_AND_TEXT',
        defaultContentLanguage: 'en-GB',
        learningLanguages: ['en-GB'],
        localizations: [
          {
            language: 'en-GB',
            title: `${courseKey} restore title`,
            shortDescription: null,
            overview: null,
            whatYouLearn: [],
            provides: [],
          },
        ],
        lessons: [
          {
            id: randomUUID(),
            code: `${courseKey}-RESTORE`,
            sortOrder: 0,
            localizations: [
              {
                language: 'en-GB',
                title: 'Restore lesson',
                description: null,
                videoAssetId: missingAssetId,
                videoDurationSeconds: 10,
                textHtml: null,
                textLearningPoints: null,
              },
            ],
            exhibits: [],
            learningPoints: [],
            triggers: [],
            readings: [],
            questions: [],
            applicationTest: null,
          },
        ],
      },
    };
    const version = await prisma.courseVersion.create({
      data: {
        courseId: imported.courseId,
        versionNo: 901,
        versionLabel: '901.0',
        versionSeries: 901,
        versionMinor: 0,
        snapshotData: json(snapshot),
        createdBy: null,
      },
      select: { id: true },
    });

    const restored = await agent
      .post(`/api/backoffice/courses/${imported.courseId}/restore`)
      .send({ versionId: version.id });
    // 计划的契约：缺资产 → ASSET_NOT_FOUND，草稿不变（C5 P8）。
    const after = await observe(courseKey, imported.courseId);
    expect(after).toEqual(before);
    expect([404, 422]).toContain(restored.status);
    expect(errorCode(restored)).toBe('ASSET_NOT_FOUND');
  });

  // =========================================================================
  // T6.4 F6 跨库：导出 → 第二个 database 导入 → 发布 → 投影一致
  // =========================================================================

  it('T6.4 exports, imports into a second database, publishes, and keeps the stable projection identical', async () => {
    const courseKey = MODELING_KEY;
    const env1Versions = await contentVersions(courseKey);
    expect(env1Versions.length).toBeGreaterThanOrEqual(2);
    const env1 = env1Versions.at(-1)!;

    const list = await agent
      .get(
        `/api/backoffice/courses?search=${encodeURIComponent(courseKey)}&pageSize=50`,
      )
      .expect(200);
    const row = (
      data<{ courses: Array<{ code: string; id: string }> }>(list).courses ?? []
    ).find((item) => item.code === courseKey);
    expect(row).toBeTruthy();

    const exported = await exportWorkingZip(row!.id);
    expect(exported.length).toBeGreaterThan(1_000_000);
    const exportedZip = await JSZip.loadAsync(exported);
    const exportedManifest = JSON.parse(
      await exportedZip.file('manifest.json')!.async('string'),
    ) as ExportedManifestLite;

    console.log(
      `[F6] exported bytes=${exported.length} alignments=${exportedManifest.content?.alignments?.length ?? 0} renditions=${exportedManifest.content?.renditions?.length ?? 0}`,
    );

    const baseUrl = process.env.DATABASE_URL;
    if (!baseUrl) throw new Error('DATABASE_URL is required for F6');
    const secondDb = `learning_guide_e2e_f6_${Date.now()}`;
    const adminUrl = baseUrl.replace(/\/[^/]+$/, '/postgres');
    const secondUrl = baseUrl.replace(/\/[^/]+$/, `/${secondDb}`);
    const admin = new PgClient({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${secondDb}"`);
    await admin.end();

    const serverRoot = path.resolve(__dirname, '..');
    execFileSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['prisma', 'migrate', 'deploy'],
      {
        cwd: serverRoot,
        env: { ...process.env, DATABASE_URL: secondUrl },
        stdio: 'pipe',
        timeout: 180_000,
      },
    );

    console.log(`[F6] migrated ${secondDb}`);

    // 目标库安排：分类单源（Science）+ 同一员工凭据（会话在目标库校验）。
    const second = new PgClient({ connectionString: secondUrl });
    await second.connect();
    let employeeRow: { login_email: string } | null = null;
    try {
      const existingScience = await second.query(
        `SELECT id FROM "CourseCatalogueEntry" WHERE name = 'Science' AND "parentId" IS NULL`,
      );
      if (existingScience.rows.length === 0) {
        await second.query(
          `INSERT INTO "CourseCatalogueEntry"
             (id, name, description, "parentId", status, "sortOrder", "createdAt", "updatedAt", localized)
           VALUES (gen_random_uuid()::text, 'Science', '', NULL, 'ACTIVE', 0, now(), now(), '{}'::jsonb)`,
        );
      }
      const source = new PgClient({ connectionString: baseUrl });
      await source.connect();
      try {
        const employee = await source.query(
          `SELECT login_email, role, account_status, email_verification, email_verified_at, password_hash, is_bootstrap_admin
             FROM employees WHERE login_email = $1`,
          ['e2e-admin@example.com'],
        );
        expect(employee.rows).toHaveLength(1);
        const e = employee.rows[0] as EmployeeAccountRow;
        await second.query(
          `INSERT INTO employees
             (login_email, role, account_status, email_verification, email_verified_at, password_hash, is_bootstrap_admin, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())`,
          [
            e.login_email,
            e.role,
            e.account_status,
            e.email_verification,
            e.email_verified_at,
            e.password_hash,
            e.is_bootstrap_admin,
          ],
        );
        employeeRow = e;
      } finally {
        await source.end();
      }
    } catch (error) {
      await second.end().catch(() => undefined);
      throw error;
    }

    const originalDbUrl = process.env.DATABASE_URL;
    let secondApp: INestApplication<App> | null = null;
    try {
      process.env.DATABASE_URL = secondUrl;
      const secondModule: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      secondApp = secondModule.createNestApplication();
      configureApp(secondApp);
      await secondApp.init();
      const f6Agent = request.agent(secondApp.getHttpServer());
      globalThis.__lgboRateBuckets?.clear();
      await f6Agent
        .post('/api/auth/sign-in')
        .send({ email: employeeRow.login_email, password: E2E_PASSWORD })
        .expect(200);

      console.log('[F6] second app ready');

      const imported = await importNew(exported, 'F6_export.zip', f6Agent);

      console.log(`[F6] imported into ${imported.courseId}`);
      const env2Alignments = await partcAlignments(courseKey, f6Agent);
      const env2Stages = await partcStages(courseKey, f6Agent);
      const previewRes = await f6Agent
        .post(`/api/backoffice/courses/${courseKey}/partc/plans/preview`)
        .send({});
      const env2Preview = data<PlanView>(previewRes);

      console.log(
        `[F6] env2 alignments=${env2Alignments.length} stages=${JSON.stringify(env2Stages.stages.map((stage) => stage.stageKey))} planStatus=${env2Preview.status} gaps=${JSON.stringify(env2Preview.gaps.map((gap) => gap.reason))}`,
      );

      const exportedStageKeys = (exportedManifest.content?.stages ?? []).map(
        (stage) => stage.stageKey,
      );
      const env1StageKeys = env1.stages.map((stage) => stage.stageKey);

      console.log(
        `[F6] stage identity exported=${JSON.stringify(exportedStageKeys)} frozen=${JSON.stringify(env1StageKeys)}`,
      );
      const env2Detail = await f6Agent
        .get(`/api/backoffice/courses/${imported.courseId}`)
        .expect(200);
      expect(data<CourseDetail>(env2Detail).lessons.length).toBeGreaterThan(0);

      // 跨环境投影契约（§14 C10.4 / §17）：导出包必须原样携带稳定阶段键与
      // verified 对齐，导入端才有可人签/可发布的 proposal。
      expect(exportedManifest.content?.alignments?.length ?? 0).toBeGreaterThan(
        0,
      );
      expect(exportedStageKeys).toEqual(env1StageKeys);
      expect(env2Alignments.length).toBeGreaterThan(0);
      expect(env2Preview.status).not.toBe('blocked');

      // 以下真实发布 + 冻结投影对比只有在导出携带对齐后才可达。
      await signOffAllProposed(courseKey, f6Agent);
      await publishPartcPlan(courseKey, f6Agent);
      const env2Versions = await contentVersions(courseKey, f6Agent);
      expect(env2Versions.length).toBe(1);
      const env2 = env2Versions[0];
      const stable = (version: ContentVersionView) => ({
        categoryPath: version.categoryPath,
        stages: version.stages,
        renditions: version.renditions,
        evidenceSpecs: version.evidenceSpecs,
        assetPins: version.assetPins,
      });
      expect(stable(env2)).toEqual(stable(env1));
    } finally {
      if (secondApp) await secondApp.close();
      process.env.DATABASE_URL = originalDbUrl;
      await second.end().catch(() => undefined);
      const cleanup = new PgClient({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup
        .query(`DROP DATABASE IF EXISTS "${secondDb}" WITH (FORCE)`)
        .catch(() => undefined);
      await cleanup.end();
    }
  });
});
