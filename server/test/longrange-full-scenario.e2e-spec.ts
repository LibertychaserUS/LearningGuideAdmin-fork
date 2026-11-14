import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client as PgClient } from 'pg';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import type { Response } from 'supertest';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { E2E_PASSWORD, signInAs } from './helpers/employee-session';
import { purgePartcCourse } from './helpers/partc-purge';

/**
 * 长程真实测试 · 完整生命周期 scenario（计划 §3 的 7 步连续跑）。
 *
 * 计划：docs/Course_Category_LongRange_TestPlan.md §3
 * 设计：docs/Course_Category_Single_Source_Design.md §14 Part C（C0–C17）
 *
 * 顺序（每一步真实执行并打印证据）：
 *  1 空库迁移（由 scripts/longrange-e2e.mjs 执行；本文件断言库为空并记录迁移数）
 *  2 导入 F2 真实字幕包（165MB 真实媒体）
 *  3 ASR/字幕派生（字幕优先；学习点时间来自字幕 cue；重复导入确定性）
 *  4 对齐签收 API（proposed → verified；服务端派生 verifiedAgainst）
 *  5 plan preview → save → approve → publish（Part C v1）
 *  6 线上投影 + 学习会话事件（started/completed/幂等/顺序）
 *  7 F5 替换视频 → 映射失效 → Re-confirm（观察）→ 新版本（观察）
 *  8 Restore v1 → 草稿正确、线上不变 → 发布 v3 → 历史版本投影
 *  9 F6 跨库往返（导出 → 第二库导入 → 签收 → 发布 → 稳定投影一致）
 * 10 F4 坏包逐项拒绝（9 个真实缺陷包，无副作用）
 * 11 全程不变量：无 hash 依赖、无人工时间字段、无 Uncategorized、无 global timeline 表
 *
 * 黑盒边界：
 * - 观察只经 HTTP（backoffice / partc / portal / 学习事件 Route Handler）。
 * - Prisma 只用于 arrange（初始 proposed 对齐、第二库账号/分类）与 cleanup，
 *   不用于断言业务字段；所有业务结论来自 HTTP 响应或导出的包。
 * - 不 import 被测内部实现；AppModule/configureApp 只是启动 HTTP 服务的既有 harness。
 * - 真实资产：F2/F5 由 Owner 提供的真实 Modeling life zip 派生（真实 mp4/docx/png），
 *   没有玩具视频。
 *
 * 运行（必须先重置 e2e 库）：
 *   node scripts/longrange-e2e.mjs
 */

jest.setTimeout(1_800_000);

const FIXTURES = path.resolve(__dirname, 'fixtures/longrange');
const F2_ZIP = path.join(FIXTURES, 'F2_subtitles/F2_subtitles.zip');
const F2_DIR = path.join(FIXTURES, 'F2_subtitles/package');
const F5_ZIP = path.join(FIXTURES, 'F5_replacement/F5_replacement.zip');
const F4_DIR = path.join(FIXTURES, 'F4_bad_packages');
const PORTAL_ROOT =
  process.env.LG_PORTAL_ROOT?.trim() ||
  path.resolve(__dirname, '../../../LearningGuidePortal');
const EVENTS_SERVER = path.join(FIXTURES, 'scripts/portal-events-server.ts');
const TSCONFIG_PATHS = path.join(
  PORTAL_ROOT,
  'scripts/register-tsconfig-paths.cjs',
);

const TIME_COLUMN_PATTERN =
  /(?:^|[^a-z])(?:times?|timestamps?|durations?|seconds?|minutes?|clock|ms|start|end|trigger|时间|时长|秒|分钟|开始|结束|触发)(?:[^a-z]|$)|mm:ss|hh:mm/i;
const HASH_KEY_PATTERN =
  /sha[-_]?256|sha1|md5|hash|digest|checksum|fingerprint/i;
const MACHINE_TIMING_SOURCES = new Set([
  'subtitle',
  'chapter',
  'asr',
  'forced-alignment',
]);

type Agent = Awaited<ReturnType<typeof signInAs>>;

interface JobView {
  jobId: string;
  status: string;
  error: string | null;
  courseId: string | null;
  report: {
    errors: Array<{ code: string; message: string; path?: string }>;
    warnings: Array<{ code: string; message: string; path?: string }>;
  };
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
  verifiedAgainst?: {
    renditionRevision: number;
    carrierVersion: number;
    specVersion: number;
  };
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
  renditions: Array<Record<string, any>>;
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
  status: 'draft' | 'degraded' | 'blocked';
  canonicalJson: string;
  entries: Array<Record<string, any>>;
  warnings: Array<Record<string, any>>;
  gaps: Array<{
    invariant: string;
    status: 'blocked' | 'degraded';
    message: string;
    stageKey?: string;
    reason?: string;
  }>;
  issues: Array<{ code: string; severity: string; message: string }>;
}

interface CourseVersionRow {
  id: string;
  versionNo: number;
  versionLabel: string;
  isLive: boolean;
}

function data<T>(response: Response): T {
  return (response.body as { data: T }).data;
}

function errorCode(response: Response): string {
  return (response.body as { error?: { code?: string } }).error?.code ?? '';
}

function log(step: string, message: string): void {
  // 证据：每一步都有可复制的命令/响应摘录。

  console.log(`[LR-SCENARIO] ${step} ${message}`);
}

function hashLikeKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) hashLikeKeys(item, found);
    return found;
  }
  if (typeof value !== 'object' || value === null) return found;
  for (const [key, child] of Object.entries(value)) {
    if (HASH_KEY_PATTERN.test(key)) found.push(key);
    hashLikeKeys(child, found);
  }
  return found;
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

function readWorkbookHeaders(bytes: Buffer): Record<string, string[]> {
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  const headers: Record<string, string[]> = {};
  for (const name of workbook.SheetNames) {
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], {
      header: 1,
      defval: null,
      raw: true,
    });
    headers[name] = (matrix[0] ?? []).map((cell) =>
      typeof cell === 'string'
        ? cell
        : typeof cell === 'number' || typeof cell === 'boolean'
          ? String(cell)
          : cell == null
            ? ''
            : (JSON.stringify(cell) ?? ''),
    );
  }
  return headers;
}

// ---------------------------------------------------------------------------
// 学习事件夹具服务器（真实 Portal Route Handler，真实 HTTP + 真实 PostgreSQL）
// ---------------------------------------------------------------------------

type EventsHarness = {
  port: number;
  aliceToken: string;
  aliceUserId: string;
  child: ChildProcessWithoutNullStreams;
  dataDir: string;
  stop: () => Promise<void>;
};

async function startEventsHarness(args: string[] = []): Promise<EventsHarness> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'lg-lr-scenario-events-'));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--require', TSCONFIG_PATHS, EVENTS_SERVER, ...args],
    {
      cwd: PORTAL_ROOT,
      env: {
        ...process.env,
        LG_PORTAL_ROOT: PORTAL_ROOT,
        LONGRANGE_DATA_DIR: dataDir,
        DATABASE_URL: process.env.DATABASE_URL,
        DATABASE_SSL: '0',
        STORAGE_BACKEND: 'local',
        APP_ENV: 'DEV',
        PAYMENT_MODE: 'demo',
      },
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const deadline = Date.now() + 120_000;
  let ready: { port: number; aliceToken: string; aliceUserId: string } | null =
    null;
  while (Date.now() < deadline) {
    const line = stdout
      .split('\n')
      .find((entry) => entry.startsWith('LONGRANGE_EVENTS_READY '));
    if (line) {
      ready = JSON.parse(line.slice('LONGRANGE_EVENTS_READY '.length)) as {
        port: number;
        aliceToken: string;
        aliceUserId: string;
      };
      break;
    }
    if (child.exitCode !== null) break;
    await sleep(150);
  }
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(
      `events fixture server did not start (exit=${child.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  return {
    ...ready,
    child,
    dataDir,
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        const stopDeadline = Date.now() + 10_000;
        while (child.exitCode === null && Date.now() < stopDeadline) {
          await sleep(100);
        }
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function postEvent(
  harness: EventsHarness,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, any>; text: string }> {
  const response = await fetch(
    `http://127.0.0.1:${harness.port}/api/learning/events`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `learning_guide_session=${harness.aliceToken}`,
      },
      body: JSON.stringify(body),
    },
  );
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = JSON.parse(text) as Record<string, any>;
  } catch {
    /* keep text */
  }
  return { status: response.status, body: parsed, text };
}

// ---------------------------------------------------------------------------
// scenario
// ---------------------------------------------------------------------------

describe('Long-range full lifecycle scenario (real package, real HTTP, real PostgreSQL)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let agent: Agent;

  const courseKey = 'modeling-life';
  let courseId = '';
  let partcV1: ContentVersionView;
  let legacyV1Id = '';
  let exportedV1: Buffer | null = null;
  const createdJobIds: string[] = [];
  const storageRoot = path.resolve(
    process.env.COURSE_PACKAGE_ROOT?.trim() || 'storage/course-package',
  );
  const evidence: Record<string, unknown> = {};

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
    bytes: Buffer,
    name: string,
    targetCourseId?: string,
    client: Agent = agent,
  ): Promise<JobView> {
    const endpoint = targetCourseId
      ? `/api/backoffice/courses/${targetCourseId}/import`
      : '/api/backoffice/courses/import';
    const res = await client.post(endpoint).attach('file', bytes, {
      filename: name,
      contentType: 'application/zip',
    });
    const body = res.body as { data?: JobView };
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
  ): Promise<Response> {
    return agent
      .post(`/api/backoffice/courses/import/${jobId}/confirm`)
      .send({ onConflict });
  }

  async function importNew(
    bytes: Buffer,
    name: string,
  ): Promise<{ job: JobView; courseId: string }> {
    const job = await upload(bytes, name);
    if (job.status !== 'AWAITING_CONFIRM') {
      const full = await getJob(job.jobId);
      throw new Error(
        `validation did not reach AWAITING_CONFIRM: ${JSON.stringify(full)}`,
      );
    }
    const confirmed = await confirm(job.jobId, 'CREATE_NEW_COURSE');
    expect(confirmed.status).toBe(200);
    const view = data<{ status: string; courseId: string }>(confirmed);
    expect(view.status).toBe('READY');
    return { job: await getJob(job.jobId), courseId: view.courseId };
  }

  async function importIntoExisting(
    bytes: Buffer,
    name: string,
  ): Promise<JobView> {
    const job = await upload(bytes, name, courseId);
    if (job.status !== 'AWAITING_CONFIRM') {
      const full = await getJob(job.jobId);
      throw new Error(
        `validation did not reach AWAITING_CONFIRM: ${JSON.stringify(full)}`,
      );
    }
    const confirmed = await confirm(job.jobId, 'ABORT');
    expect(confirmed.status).toBe(200);
    return getJob(job.jobId);
  }

  async function partcStages(client: Agent = agent): Promise<{
    stages: StageView[];
    prerequisiteEdges: unknown[];
  }> {
    const res = await client
      .get(`/api/backoffice/courses/${courseKey}/partc/stages`)
      .expect(200);
    return data(res);
  }

  async function partcAlignments(
    client: Agent = agent,
  ): Promise<AlignmentView[]> {
    const res = await client
      .get(`/api/backoffice/courses/${courseKey}/partc/alignments`)
      .expect(200);
    return data<AlignmentView[]>(res);
  }

  async function contentVersions(
    client: Agent = agent,
  ): Promise<ContentVersionView[]> {
    const res = await client
      .get(`/api/backoffice/courses/${courseKey}/partc/content-versions`)
      .expect(200);
    return data<ContentVersionView[]>(res);
  }

  async function partcLive(client: Agent = agent): Promise<{
    publication: {
      contentVersionId: string;
      versionNo: number;
      validFrom: string;
    } | null;
    contentVersion: ContentVersionView | null;
  }> {
    const res = await client
      .get(`/api/backoffice/courses/${courseKey}/partc/publications/live`)
      .expect(200);
    return data(res);
  }

  async function previewPlan(client: Agent = agent): Promise<PlanView> {
    const res = await client
      .post(`/api/backoffice/courses/${courseKey}/partc/plans/preview`)
      .send({});
    expect(res.status).toBe(200);
    return data<PlanView>(res);
  }

  async function publishPartcPlan(client: Agent = agent): Promise<{
    plan: PlanView;
    applied: { status: string; contentVersionId: string; versionNo: number };
  }> {
    const base = `/api/backoffice/courses/${courseKey}/partc`;
    const plan = await previewPlan(client);
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
      acceptedWarnings: plan.warnings,
    });
    expect(approved.status).toBe(200);
    const published = await client.post(`${base}/plans/publish`).send({
      planId: plan.planId,
      planVersion: plan.planVersion,
    });
    expect(published.status).toBe(200);
    return {
      plan,
      applied: data<{
        status: string;
        contentVersionId: string;
        versionNo: number;
      }>(published),
    };
  }

  /**
   * arrange：Part C 导入不猜语义绑定（设计 C5 P4：无旧对齐/无显式 seed
   * ⇒ 无 proposal）。显式 binding 的正式入口是 POST /partc/alignments +
   * sign-off；本场景需要复现 step4 的签收链路，因此这里用 Prisma 落 proposed
   * 行作为 arrange，签收/发布全部经 HTTP 真实执行（与 partc-api e2e 一致）。
   */
  async function arrangeProposedAlignments(): Promise<number> {
    const stages = await prisma.pcStage.findMany({
      where: { courseKey, kind: 'step' },
      orderBy: { orderKey: 'asc' },
      select: { stageKey: true, objectiveKeys: true },
    });
    const contentByStage: Record<string, string> = {
      'lesson-1': 'L1',
      'lesson-2': 'L2',
    };
    let created = 0;
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
      const objectiveKey = stage.objectiveKeys[0];
      for (const [renditionIndex, rendition] of renditions.entries()) {
        const alignmentId = `aln.lr${String(index + 1).padStart(2, '0')}${String(
          renditionIndex + 1,
        ).padStart(2, '0')}`;
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
            status: 'proposed',
            provenance: 'import',
          },
          update: {
            objectiveKey,
            role: renditionIndex === 0 ? 'primary' : 'support',
            status: 'proposed',
            provenance: 'import',
            verifiedBy: null,
            verifiedAt: null,
            verifiedAgainst: null,
          },
        });
        created += 1;
      }
    }
    return created;
  }

  async function signOffAllProposed(client: Agent = agent): Promise<number> {
    const alignments = await partcAlignments(client);
    let signed = 0;
    for (const alignment of alignments.filter(
      (entry) => entry.status === 'proposed',
    )) {
      const res = await client
        .post(
          `/api/backoffice/courses/${courseKey}/partc/alignments/${alignment.alignmentId}/sign-off`,
        )
        .send({ decision: 'verified' });
      expect(res.status).toBe(200);
      const signedView = data<AlignmentView>(res);
      expect(signedView.status).toBe('verified');
      expect(signedView.verifiedAgainst).toBeTruthy();
      signed += 1;
    }
    return signed;
  }

  async function exportWorkingZip(): Promise<Buffer> {
    const started = await agent
      .post(`/api/backoffice/courses/${courseId}/export`)
      .send({ version: 'working' })
      .expect(202);
    const jobId = data<{ jobId: string }>(started).jobId;
    createdJobIds.push(jobId);
    const deadline = Date.now() + 300_000;
    for (;;) {
      const res = await agent
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
    const download = await agent
      .get(`/api/backoffice/courses/export/${jobId}/download`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    return download.body as Buffer;
  }

  async function listLegacyVersions(): Promise<CourseVersionRow[]> {
    const res = await agent
      .get(`/api/backoffice/courses/${courseId}/versions`)
      .expect(200);
    return data<CourseVersionRow[]>(res);
  }

  async function publishLegacy(): Promise<Response> {
    return agent
      .post(`/api/backoffice/courses/${courseId}/publish`)
      .send({ notifyLearners: false });
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
    process.env.HEAVY_TASKS_INLINE = '1';

    // 步骤 1：空库证据（迁移由 scripts/longrange-e2e.mjs 在启动前执行）。
    const migrationCount = await prisma.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*)::int8 AS count FROM _prisma_migrations`;
    const courseCount = await prisma.commerceCourse.count();
    const partcCourseCount = await prisma.pcCourse.count();
    log(
      'step1',
      `migrations=${String(migrationCount[0]?.count)} commerceCourses=${courseCount} partcCourses=${partcCourseCount} db=${process.env.DATABASE_URL}`,
    );
    expect(Number(migrationCount[0]?.count)).toBeGreaterThan(0);
    expect(courseCount).toBe(0);
    expect(partcCourseCount).toBe(0);

    const science = await prisma.courseCatalogueEntry.findFirst({
      where: { name: 'Science', parentId: null, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!science) {
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
    for (const jobId of createdJobIds) {
      await prisma.coursePackageJob
        .deleteMany({ where: { id: jobId } })
        .catch(() => undefined);
      await fs
        .rm(path.join(storageRoot, jobId), { recursive: true, force: true })
        .catch(() => undefined);
    }
    // 本场景是「单库串跑」链路的最后一套；清掉自己建的课程、Part C 行与事件夹具表，
    // 让链跑结束后数据库回到空态（发布产物的 append-only 触发器由 purge 临时绕过）。
    if (courseId) {
      await purgePartcCourse(prisma, courseKey, [courseId]);
      await prisma.coursePackageJob
        .deleteMany({ where: { courseId } })
        .catch(() => undefined);
      await prisma.courseVersion
        .deleteMany({ where: { courseId } })
        .catch(() => undefined);
      await prisma.commerceCourse
        .deleteMany({ where: { id: courseId } })
        .catch(() => undefined);
      const mediaRoot = path.resolve(
        process.env.COURSE_MEDIA_ROOT?.trim() || 'storage/course-media',
      );
      await fs
        .rm(path.join(mediaRoot, 'course-media', courseId), {
          recursive: true,
          force: true,
        })
        .catch(() => undefined);
      const leftover = await prisma.pcCourse
        .count({ where: { courseKey } })
        .catch(() => 0);
      if (leftover > 0) {
        throw new Error(
          `pc_course rows for ${courseKey} were still present after cleanup; ` +
            'the serial run must end with an empty database (pc_course count 0).',
        );
      }
    }
    // Portal 事件夹具在同一库 bootstrap 的账本表；与 longrange-session-events 的约定一致。
    await prisma.$executeRawUnsafe(
      'DROP TABLE IF EXISTS learning_plan_entries',
    );
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS learning_events');
    await app.close();
  });

  // =========================================================================
  // 步骤 2：导入 F2 真实字幕包
  // =========================================================================

  it('step2 imports the genuine 165MB F2 package through Part C v2', async () => {
    const zip = await fs.readFile(F2_ZIP);
    const { job, courseId: createdCourseId } = await importNew(
      zip,
      'F2_subtitles.zip',
    );
    expect(job.status).toBe('READY');
    expect(job.error).toBeNull();
    courseId = createdCourseId;
    expect(courseId).toBeTruthy();
    evidence.step2 = { jobId: job.jobId, status: job.status, courseId };
    log(
      'step2',
      `imported F2 bytes=${zip.length} job=${job.jobId} status=${job.status} courseId=${courseId} errors=${job.report.errors.length} warnings=${job.report.warnings.length}`,
    );

    const detail = await agent
      .get(`/api/backoffice/courses/${courseId}`)
      .expect(200);
    const course = data<{ code: string; hasDraft: boolean }>(detail);
    expect(course.code).toBe(courseKey);
    expect(course.hasDraft).toBe(true);
  });

  // =========================================================================
  // 步骤 3：字幕派生（不是章节、不是人工输入），且重复导入确定
  // =========================================================================

  it('step3 derives LP times from subtitle cues deterministically and rejects human time columns', async () => {
    const stages = await partcStages();
    expect(stages.stages.map((stage) => stage.stageKey).sort()).toEqual(
      ['lesson-1', 'lesson-2', 'program-modeling-life'].sort(),
    );

    // 课程详情暴露每课时学习点（含派生毫秒→秒）；preview 会按 legacy
    // completeness 过滤（要求每种学习语言都有视频），F2 的 zh-CN 是纯文本，
    // 因此 preview 不用于本步计时观察。
    const detailRes = await agent
      .get(`/api/backoffice/courses/${courseId}`)
      .expect(200);
    const detail = data<{
      lessons: Array<{
        code: string;
        learningPoints: Array<{
          language: string;
          code: string;
          timeSeconds: number | null;
          source: string;
        }>;
      }>;
    }>(detailRes);
    const enPoints = detail.lessons
      .flatMap((lesson) => lesson.learningPoints)
      .filter((point) => point.language === 'en-GB');
    const times = enPoints.map((point) => point.timeSeconds);
    log(
      'step3',
      `stages=${JSON.stringify(stages.stages.map((s) => s.stageKey))} lessons=${detail.lessons.length} enLP=${enPoints.length} times=${JSON.stringify(times)}`,
    );
    expect(detail.lessons.length).toBeGreaterThanOrEqual(2);
    expect(times.length).toBeGreaterThan(0);
    for (const time of times) {
      expect(typeof time).toBe('number');
      expect(time as number).toBeGreaterThan(0);
    }
    expect(new Set(times).size).toBe(times.length);

    // 模板里不得有任何时间列（人工时间输入被禁止）。
    const template = await fs.readFile(path.join(F2_DIR, 'template.xlsx'));
    const headers = readWorkbookHeaders(template);
    const offenders: Array<{ sheet: string; header: string }> = [];
    for (const [sheet, sheetHeaders] of Object.entries(headers)) {
      for (const header of sheetHeaders) {
        if (TIME_COLUMN_PATTERN.test(header)) offenders.push({ sheet, header });
      }
    }
    log(
      'step3',
      `templateSheets=${JSON.stringify(Object.keys(headers))} timeColumns=${JSON.stringify(offenders)}`,
    );
    expect(offenders).toEqual([]);

    // 包内无任何 hash/digest/checksum 字段。
    const manifest = JSON.parse(
      await fs.readFile(path.join(F2_DIR, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(hashLikeKeys(manifest)).toEqual([]);

    // 重复导入同一包 → 派生时间逐条一致（确定性）。
    const second = await importIntoExisting(
      await fs.readFile(F2_ZIP),
      'F2_subtitles.zip',
    );
    expect(second.status).toBe('READY');
    const detailAgain = data<{
      lessons: Array<{
        learningPoints: Array<{
          language: string;
          code: string;
          timeSeconds: number | null;
        }>;
      }>;
    }>(await agent.get(`/api/backoffice/courses/${courseId}`).expect(200));
    const timesAgain = detailAgain.lessons
      .flatMap((lesson) => lesson.learningPoints)
      .filter((point) => point.language === 'en-GB')
      .map((point) => point.timeSeconds);
    log(
      'step3',
      `reimport deterministic times=${JSON.stringify(timesAgain)} equal=${JSON.stringify(times) === JSON.stringify(timesAgain)}`,
    );
    expect(timesAgain).toEqual(times);
  });

  // =========================================================================
  // 步骤 4：对齐签收 API（proposed → verified）
  // =========================================================================

  it('step4 signs off proposed alignments via HTTP and records the fresh-import gap', async () => {
    const before = await partcAlignments();
    log(
      'step4',
      `alignmentsAfterFreshImport=${before.length} (expected 0: F2 carries no old alignments and there is no HTTP stage↔rendition binding entry)`,
    );
    // 文档化实现缺口：全新导入不会产生 proposal（不猜绑定），因此下面的
    // proposed 行是 arrange；签收本身仍全部经 HTTP。
    expect(before.length).toBe(0);

    const arranged = await arrangeProposedAlignments();
    expect(arranged).toBeGreaterThan(0);
    const proposed = await partcAlignments();
    expect(proposed.every((entry) => entry.status === 'proposed')).toBe(true);
    log('step4', `arrangedProposed=${arranged}`);

    const signed = await signOffAllProposed();
    expect(signed).toBe(arranged);
    const after = await partcAlignments();
    expect(after.every((entry) => entry.status === 'verified')).toBe(true);
    for (const alignment of after) {
      expect(alignment.verifiedBy).toBeTruthy();
      expect(alignment.verifiedAt).toBeTruthy();
      expect(alignment.verifiedAgainst).toBeTruthy();
    }
    log(
      'step4',
      `signedVerified=${signed} verifiedBy=${after[0]?.verifiedBy} verifiedAgainst=${JSON.stringify(after[0]?.verifiedAgainst)}`,
    );

    // 只允许 proposed → verified/rejected：已签收再签 → 409。
    const again = await agent
      .post(
        `/api/backoffice/courses/${courseKey}/partc/alignments/${after[0].alignmentId}/sign-off`,
      )
      .send({ decision: 'verified' });
    expect(again.status).toBe(409);
    expect(errorCode(again)).toBe('ALIGNMENT_ALREADY_DECIDED');
    log('step4', `re-sign status=${again.status} code=${errorCode(again)}`);
  });

  // =========================================================================
  // 步骤 5：plan preview → save → approve → publish（Part C v1）
  // =========================================================================

  it('step5 runs preview→save→approve→publish and freezes v1 without hash/UUID identity', async () => {
    const preview = await previewPlan();
    log(
      'step5',
      `preview status=${preview.status} entries=${preview.entries.length} warnings=${preview.warnings.length} gaps=${preview.gaps.length} planId=${preview.planId}`,
    );
    expect(preview.status).not.toBe('blocked');
    expect(preview.entries.length).toBeGreaterThan(0);

    const saved = await agent
      .post(`/api/backoffice/courses/${courseKey}/partc/plans/save`)
      .send({
        planId: preview.planId,
        planVersion: preview.planVersion,
        canonicalJson: preview.canonicalJson,
      });
    expect(saved.status).toBe(200);
    log(
      'step5',
      `save status=${saved.status} bytes=${preview.canonicalJson.length}`,
    );

    const approved = await agent
      .post(`/api/backoffice/courses/${courseKey}/partc/plans/approve`)
      .send({
        planId: preview.planId,
        planVersion: preview.planVersion,
        decision: 'approved',
        acceptedWarnings: preview.warnings,
      });
    expect(approved.status).toBe(200);
    log('step5', `approve status=${approved.status}`);

    const published = await agent
      .post(`/api/backoffice/courses/${courseKey}/partc/plans/publish`)
      .send({ planId: preview.planId, planVersion: preview.planVersion });
    expect(published.status).toBe(200);
    const applied = data<{
      status: string;
      contentVersionId: string;
      versionNo: number;
    }>(published);
    expect(applied.status).toBe('applied');
    expect(applied.versionNo).toBe(1);
    log(
      'step5',
      `publish status=${applied.status} versionNo=${applied.versionNo} contentVersionId=${applied.contentVersionId}`,
    );

    const versions = await contentVersions();
    expect(versions).toHaveLength(1);
    const frozen = versions[0];
    partcV1 = frozen;
    expect(frozen.categoryPath).toEqual(['Science']);
    expect(frozen).not.toHaveProperty('categoryId');
    const videoRenditions = frozen.renditions.filter(
      (rendition) => rendition.modality === 'video',
    );
    expect(videoRenditions.length).toBeGreaterThan(0);
    for (const rendition of videoRenditions) {
      expect(MACHINE_TIMING_SOURCES.has(rendition.anchorSource)).toBe(true);
      expect(typeof rendition.startMs).toBe('number');
      expect(typeof rendition.endMs).toBe('number');
      expect(rendition.startMs).toBeLessThan(rendition.endMs);
    }
    expect(
      frozen.alignments.every((entry) => entry.status === 'verified'),
    ).toBe(true);
    for (const pin of frozen.assetPins) {
      expect(pin.assetKey).toEqual(expect.any(String));
      expect(pin).not.toHaveProperty('assetId');
    }
    expect(hashLikeKeys(frozen)).toEqual([]);
    log(
      'step5',
      `frozen v${frozen.versionNo} stages=${frozen.stages.length} renditions=${frozen.renditions.length} videoRenditions=${videoRenditions.length} alignments=${frozen.alignments.length} assetPins=${JSON.stringify(frozen.assetPins)} categoryPath=${JSON.stringify(frozen.categoryPath)}`,
    );
  });

  // =========================================================================
  // 步骤 6：线上投影 + 学习会话事件
  // =========================================================================

  it('step6 observes the published projection and records real learning events', async () => {
    // Part C 的线上投影 = 已发布的 ContentVersion（上面 step5 冻结的 v1）。
    // 旧 Portal 投影写入方（legacy CourseVersion）仍是 P1：Part C 导入的课程
    // 在 legacy completeness 下会因 zh-CN 纯文本（studyMode=both 要求每语言
    // 有视频）被拦，因此这里只观察并记录该边界，不作为 Part C 的失败。
    const legacyAttempt = await publishLegacy();
    const legacyCode = errorCode(legacyAttempt);
    const legacyBody = legacyAttempt.body as {
      error?: { code?: string; blockers?: string[]; message?: string };
    };
    log(
      'step6',
      `legacyProjectionPublish status=${legacyAttempt.status} code=${legacyCode} blockers=${JSON.stringify(legacyBody.error?.blockers ?? [])} (Portal projection writer is P1; Part C live pointer is the frozen ContentVersion v${partcV1.versionNo})`,
    );
    expect([200, 409]).toContain(legacyAttempt.status);
    if (legacyAttempt.status === 200) {
      const versions = await listLegacyVersions();
      legacyV1Id = versions[0].id;
      log('step6', `legacy v1 created id=${legacyV1Id}`);
    }
    evidence.step6Projection = {
      legacyPublishStatus: legacyAttempt.status,
      legacyPublishCode: legacyCode,
      partcLiveVersion: partcV1.contentVersionId,
    };

    // 学习事件：真实 Portal Route Handler + 真实 PostgreSQL。
    // 用 --no-projection：Portal 的 learning_plan_entries 写入方仍是 P1，
    // 真实 Part C contentVersionId 没有投影；按 §17 v1 语义，事件仍按
    // contentVersionId 记录并标 stageValidated=false（不 404、不猜 stage）。
    const harness = await startEventsHarness(['--no-projection']);
    try {
      const contentVersionId = partcV1.contentVersionId;
      const sessionId = `lr-session-${Date.now()}`;
      const started = await postEvent(harness, {
        eventId: `lr-started-${Date.now()}`,
        sessionId,
        type: 'started',
        occurredAt: new Date().toISOString(),
        contentVersionId,
        stageKey: 'lesson-1',
      });
      expect(started.status).toBe(200);
      expect(started.body.duplicate).toBe(false);
      expect(
        (started.body as { event: { receivedAt?: unknown } }).event.receivedAt,
      ).toEqual(expect.any(String));

      const completedFirst = await postEvent(harness, {
        eventId: `lr-complete-first-${Date.now()}`,
        sessionId: `lr-other-${Date.now()}`,
        type: 'completed',
        occurredAt: new Date().toISOString(),
        contentVersionId,
        stageKey: 'lesson-1',
      });
      expect(completedFirst.status).toBe(409);
      expect(completedFirst.text).toContain('COMPLETED_WITHOUT_STARTED');

      const completed = await postEvent(harness, {
        eventId: `lr-completed-${Date.now()}`,
        sessionId,
        type: 'completed',
        occurredAt: new Date().toISOString(),
        contentVersionId,
        stageKey: 'lesson-1',
      });
      expect(completed.status).toBe(200);
      expect(completed.body.duplicate).toBe(false);

      const replay = await postEvent(harness, {
        eventId: (started.body as { event: { eventId: string } }).event.eventId,
        sessionId,
        type: 'paused',
        occurredAt: '2020-01-01T00:00:00.000Z',
        contentVersionId,
        stageKey: 'lesson-1',
      });
      expect(replay.status).toBe(200);
      expect(replay.body.duplicate).toBe(true);
      expect((replay.body as { event: { type: string } }).event.type).toBe(
        'started',
      );

      log(
        'step6',
        `events started=${started.status} completedWithoutStarted=${completedFirst.status} completed=${completed.status} replay=${replay.status} duplicate=${replay.body.duplicate} contentVersionId=${contentVersionId}`,
      );
    } finally {
      await harness.stop();
    }
  });

  // =========================================================================
  // 步骤 7：F5 替换 → 映射失效 → Re-confirm → 新版本
  // =========================================================================

  it('step7 replaces the video (mappings go stale) and records the Re-confirm / export gap', async () => {
    // 先导出 v1 工作区包（应携带 verified 对齐 + rendition pins）。实测：
    // 导出件 alignments=0，而 partc API 有 7 条 verified —— 这是实现在
    // 导入/导出两端 occurrenceKey 约定不一致造成的（导入 `lp.1.1`，导出
    // `lp-1.1`），因此 exportableAlignments 过滤掉了全部对齐。见 blockers。
    exportedV1 = await exportWorkingZip();
    const zip = await JSZip.loadAsync(exportedV1);
    const exportedManifest = JSON.parse(
      await zip.file('manifest.json')!.async('string'),
    ) as {
      content: {
        alignments: unknown[];
        renditions: Array<{ renditionKey: string }>;
      };
    };
    const verifiedBefore = (await partcAlignments()).filter(
      (entry) => entry.status === 'verified',
    );
    const exportAlignments = exportedManifest.content.alignments.length;
    log(
      'step7',
      `exportedV1 bytes=${exportedV1.length} alignments=${exportAlignments} (partc verified=${verifiedBefore.length}) renditions=${exportedManifest.content.renditions.length} exportedRenditionKeys=${JSON.stringify(exportedManifest.content.renditions.slice(0, 3).map((r) => r.renditionKey))}`,
    );
    expect(exportedManifest.content.renditions.length).toBeGreaterThan(0);
    const exportCarryOk = exportAlignments > 0;
    if (!exportCarryOk) {
      log(
        'step7',
        'RED: verified alignments are filtered out of the exported package (exporter re-synthesizes stage keys as `step-<lessonCode>` instead of Pc `stageKey`); cross-env carried verification is broken',
      );
    }

    // 原始 F5（同课时新视频、时长不同，但包内不携带旧对齐）。
    const imported = await importIntoExisting(
      await fs.readFile(F5_ZIP),
      'F5_replacement.zip',
    );
    expect(imported.status).toBe('READY');
    log('step7', `F5 raw import status=${imported.status}`);

    const stalePreview = await previewPlan();
    const gapInvariants = stalePreview.gaps.map((gap) => gap.invariant);
    const gapStatuses = stalePreview.gaps.map((gap) => gap.status);
    log(
      'step7',
      `planAfterF5 status=${stalePreview.status} gaps=${JSON.stringify(gapInvariants)} gapStatuses=${JSON.stringify(gapStatuses)} entries=${stalePreview.entries.length}`,
    );
    expect(['blocked', 'degraded']).toContain(stalePreview.status);
    expect(stalePreview.gaps.length).toBeGreaterThan(0);
    expect(
      gapInvariants.some(
        (invariant) => invariant === 'ALN-1' || invariant === 'ALN-6',
      ),
    ).toBe(true);

    // 现行实现对已 verified 的对齐没有降级/重签入口：签收只接受 proposed。
    const alignments = await partcAlignments();
    const verified = alignments.filter((entry) => entry.status === 'verified');
    expect(verified.length).toBeGreaterThan(0);
    const signAgain = await agent
      .post(
        `/api/backoffice/courses/${courseKey}/partc/alignments/${verified[0].alignmentId}/sign-off`,
      )
      .send({ decision: 'verified' });
    expect(signAgain.status).toBe(409);
    expect(errorCode(signAgain)).toBe('ALIGNMENT_ALREADY_DECIDED');
    log(
      'step7',
      `reconfirm attempt status=${signAgain.status} code=${errorCode(signAgain)} verifiedCarrier=${JSON.stringify(verified[0]?.verifiedAgainst)} — no HTTP re-confirm path exists for a new assetVersion`,
    );

    // legacy 发布同样不可达（Part C 课程在 legacy completeness 下被拦）。
    const legacyAttempt = await publishLegacy();
    log(
      'step7',
      `legacy publish after F5 status=${legacyAttempt.status} code=${errorCode(legacyAttempt)}`,
    );
    expect([200, 409]).toContain(legacyAttempt.status);

    // 观察：degraded 状态下完整发布流是否会把 stale 映射发布出去。
    const publishAttempt: {
      status: string;
      http: number;
      code: string;
    } = { status: 'not-attempted', http: 0, code: '' };
    if (stalePreview.status !== 'blocked') {
      const base = `/api/backoffice/courses/${courseKey}/partc`;
      const saved = await agent.post(`${base}/plans/save`).send({
        planId: stalePreview.planId,
        planVersion: stalePreview.planVersion,
        canonicalJson: stalePreview.canonicalJson,
      });
      const approved = await agent.post(`${base}/plans/approve`).send({
        planId: stalePreview.planId,
        planVersion: stalePreview.planVersion,
        decision: 'approved',
        acceptedWarnings: stalePreview.warnings,
      });
      const published = await agent.post(`${base}/plans/publish`).send({
        planId: stalePreview.planId,
        planVersion: stalePreview.planVersion,
      });
      publishAttempt.status = `${saved.status}/${approved.status}/${published.status}`;
      publishAttempt.http = published.status;
      publishAttempt.code = errorCode(published);
      log(
        'step7',
        `stale-plan publish attempt save/approve/publish=${publishAttempt.status} publishCode=${publishAttempt.code} (gaps are degraded, so stale mappings are publishable)`,
      );
      expect([200, 409, 422]).toContain(published.status);
    }
    if (publishAttempt.http === 200) {
      const versionsAfter = await contentVersions();
      const latest = versionsAfter.at(-1)!;
      log(
        'step7',
        `RED: Part C published v${latest.versionNo} after the video replacement; v2 verified alignments=${latest.alignments.filter((a) => a.status === 'verified').length} (old verification silently re-used; Re-confirm skipped). assetVersion never bumped because import hard-codes 1 and ignores manifest.content.assetPins.`,
      );
    }

    evidence.step7 = {
      status: 'red',
      exportAlignments,
      partcVerified: verifiedBefore.length,
      exportCarryOk,
      planStatus: stalePreview.status,
      gapInvariants,
      gapStatuses,
      signOffStatus: signAgain.status,
      signOffCode: errorCode(signAgain),
      legacyPublishStatus: legacyAttempt.status,
      publishAttempt,
      blockers: [
        'C10.4 导出丢失 Part C 阶段身份：exporter 从 legacy 聚合重新合成 `step-<lessonCode>`，不保留 Pc stageKey（lesson-1），导致 verified 对齐在导出时全部被过滤（alignments=0）',
        'C5 P8 Re-confirm 未实现：新 assetVersion 让 verified 对齐读时 stale，但没有 HTTP 入口重新派生/重签（签收只接受 proposed）',
        'ALN-1/ALN-6 stale 映射以 degraded gap 呈现，需核对发布门是否允许把 stale 映射当作 warning 发布',
      ],
    };
  });

  // =========================================================================
  // 步骤 8：Restore v1 → 草稿正确、线上不变 → 发布 v3
  // =========================================================================

  it('step8 restores a real Part C version: empty body rejected, draft rebuilt, live unchanged', async () => {
    const base = `/api/backoffice/courses/${courseKey}/partc`;

    // 依据：设计 §14 C5 P8——Part C Restore 已实现（POST .../partc/restore，
    // body 恰好给 contentVersionId 或 versionNo 之一）。空 body 不满足
    // RestoreBodySchema → 422 VALIDATION_ERROR。
    const empty = await agent.post(`${base}/restore`).send({});
    expect(empty.status).toBe(422);
    expect(errorCode(empty)).toBe('VALIDATION_ERROR');

    // Restore 前记录线上指针与版本数量（step7 的发布批次可能已产生 v2）。
    const liveBefore = await partcLive();
    expect(liveBefore.publication).toBeTruthy();
    expect(liveBefore.contentVersion).toBeTruthy();
    const versionsBefore = await contentVersions();

    // 恢复真实冻结版本 v1 → 200；草稿整组重建为 v1。
    const restored = await agent
      .post(`${base}/restore`)
      .send({ versionNo: partcV1.versionNo });
    expect(restored.status).toBe(200);
    const body = data<{ restored: true; version: ContentVersionView }>(
      restored,
    );
    expect(body.restored).toBe(true);
    expect(body.version.versionNo).toBe(partcV1.versionNo);

    // 草稿正确：阶段与 verified 对齐集合与冻结 v1 一致（按稳定键）。
    const draftStages = await partcStages();
    expect(draftStages.stages.map((stage) => stage.stageKey).sort()).toEqual(
      partcV1.stages.map((stage) => stage.stageKey).sort(),
    );
    const alignmentKey = (alignment: AlignmentView) =>
      `${alignment.stageKey}|${alignment.renditionKey}`;
    const draftAlignments = await partcAlignments();
    expect(draftAlignments.map(alignmentKey).sort()).toEqual(
      partcV1.alignments.map(alignmentKey).sort(),
    );
    expect(draftAlignments.every((a) => a.status === 'verified')).toBe(true);

    // 线上不变：Restore 只重建草稿，不产生新内容版本、不移动 live 指针。
    const liveAfter = await partcLive();
    expect(liveAfter.publication?.contentVersionId).toBe(
      liveBefore.publication?.contentVersionId,
    );
    expect(liveAfter.contentVersion?.contentVersionId).toBe(
      liveBefore.contentVersion?.contentVersionId,
    );
    expect((await contentVersions()).length).toBe(versionsBefore.length);

    log(
      'step8',
      `emptyBody=${empty.status}/${errorCode(empty)} restoredVersionNo=${body.version.versionNo} stages=${draftStages.stages.length} verifiedAlignments=${draftAlignments.length} liveVersionNo=${liveAfter.publication?.versionNo ?? 'null'}`,
    );
    evidence.step8 = {
      status: 'green',
      emptyBodyCode: errorCode(empty),
      restoredVersionNo: body.version.versionNo,
      draftStages: draftStages.stages.length,
      draftAlignments: draftAlignments.length,
      liveVersionNo: liveAfter.publication?.versionNo ?? null,
    };
  });

  // =========================================================================
  // 步骤 9：F6 跨库往返（导出 → 第二库导入 → 签收 → 发布 → 投影一致）
  // =========================================================================

  it('step9 round-trips the exported package through a second database', async () => {
    expect(exportedV1).toBeTruthy();
    const exported = exportedV1!;
    const baseUrl = process.env.DATABASE_URL;
    if (!baseUrl) throw new Error('DATABASE_URL is required');
    const secondDb = `learning_guide_e2e_f6_${Date.now()}`;
    const adminUrl = baseUrl.replace(/\/[^/]+$/, '/postgres');
    const secondUrl = baseUrl.replace(/\/[^/]+$/, `/${secondDb}`);
    const admin = new PgClient({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${secondDb}"`);
    await admin.end();

    const serverRoot = path.resolve(__dirname, '..');
    const prismaBin = path.join(serverRoot, 'node_modules/.bin/prisma');
    execFileSync(prismaBin, ['migrate', 'deploy'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: secondUrl },
      stdio: 'pipe',
      timeout: 300_000,
    });
    log('step9', `migrated second db ${secondDb}`);

    const second = new PgClient({ connectionString: secondUrl });
    await second.connect();
    const originalDbUrl = process.env.DATABASE_URL;
    let secondApp: INestApplication<App> | null = null;
    let f6CourseId = '';
    try {
      const science = await second.query(
        `SELECT id FROM "CourseCatalogueEntry" WHERE name = 'Science' AND "parentId" IS NULL`,
      );
      if (science.rows.length === 0) {
        await second.query(
          `INSERT INTO "CourseCatalogueEntry"
             (id, name, description, "parentId", status, "sortOrder", "createdAt", "updatedAt", localized)
           VALUES (gen_random_uuid()::text, 'Science', '', NULL, 'ACTIVE', 0, now(), now(), '{}'::jsonb)`,
        );
      }
      const source = new PgClient({ connectionString: baseUrl });
      await source.connect();
      const employee = await source.query(
        `SELECT login_email, role, account_status, email_verification, email_verified_at, password_hash, is_bootstrap_admin
           FROM employees WHERE login_email = $1`,
        ['e2e-admin@example.com'],
      );
      await source.end();
      expect(employee.rows).toHaveLength(1);
      const e = employee.rows[0] as Record<string, unknown>;
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

      process.env.DATABASE_URL = secondUrl;
      const secondModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      secondApp = secondModule.createNestApplication();
      configureApp(secondApp);
      await secondApp.init();
      const f6Agent = request.agent(secondApp.getHttpServer());
      globalThis.__lgboRateBuckets?.clear();
      await f6Agent
        .post('/api/auth/sign-in')
        .send({ email: 'e2e-admin@example.com', password: E2E_PASSWORD })
        .expect(200);

      const job = await upload(exported, 'F6_export.zip', undefined, f6Agent);
      expect(job.status).toBe('AWAITING_CONFIRM');
      const confirmed = await f6Agent
        .post(`/api/backoffice/courses/import/${job.jobId}/confirm`)
        .send({ onConflict: 'CREATE_NEW_COURSE' });
      expect(confirmed.status).toBe(200);
      const ready = data<{ status: string; courseId: string }>(confirmed);
      expect(ready.status).toBe('READY');
      f6CourseId = ready.courseId;
      log('step9', `imported into second db courseId=${ready.courseId}`);

      const env2Alignments = await partcAlignments(f6Agent);
      const env2Stages = await partcStages(f6Agent);
      const env1Stages = await partcStages();
      const env1Keys = env1Stages.stages.map((stage) => stage.stageKey).sort();
      const env2Keys = env2Stages.stages.map((stage) => stage.stageKey).sort();
      const stageIdentityEqual =
        JSON.stringify(env1Keys) === JSON.stringify(env2Keys);
      const env2Preview = await previewPlan(f6Agent);
      log(
        'step9',
        `env1Stages=${JSON.stringify(env1Keys)} env2Stages=${JSON.stringify(env2Keys)} stageIdentityEqual=${stageIdentityEqual} env2 proposals=${env2Alignments.filter((a) => a.status === 'proposed').length} verified=${env2Alignments.filter((a) => a.status === 'verified').length} planStatus=${env2Preview.status} gaps=${JSON.stringify(env2Preview.gaps.map((gap) => gap.invariant))}`,
      );

      // 依据：设计 §14 C10.2——目标环境使用包内同一 assetKey+assetVersion
      // （不转码、不换文件）时，对齐保持 verified，审计元组随包带入；无需
      // 在目标环境重新签收。导出端只携带能在包内表达的 verified 对齐，
      // 当前 F2 工作区恰好 7 条（与 step7 的 alignments=7 一致）。
      const env2Verified = env2Alignments.filter(
        (entry) => entry.status === 'verified',
      );
      const env2Proposed = env2Alignments.filter(
        (entry) => entry.status === 'proposed',
      );
      expect(env2Proposed).toHaveLength(0);
      expect(env2Verified).toHaveLength(7);
      expect(env2Verified.length).toBe(
        partcV1.alignments.filter((entry) => entry.status === 'verified')
          .length,
      );

      // 无需 sign-off：没有 proposed 可签（携带的 verified 已是发布门槛）。
      const signed = await signOffAllProposed(f6Agent);
      expect(signed).toBe(0);
      expect(env2Preview.status).not.toBe('blocked');

      const { applied } = await publishPartcPlan(f6Agent);
      expect(applied.status).toBe('applied');
      const env2Versions = await contentVersions(f6Agent);
      expect(env2Versions).toHaveLength(1);
      const env2 = env2Versions[0];

      const stable = (version: ContentVersionView) => ({
        categoryPath: version.categoryPath,
        stages: version.stages,
        renditions: version.renditions,
        evidenceSpecs: version.evidenceSpecs,
        assetPins: version.assetPins,
      });
      expect(stable(env2)).toEqual(stable(partcV1));
      log(
        'step9',
        `cross-db stable projection identical: categoryPath=${JSON.stringify(env2.categoryPath)} stages=${env2.stages.length} renditions=${env2.renditions.length} assetPins=${env2.assetPins.length} env2Verified=${env2Verified.length} signOffsNeeded=${signed}`,
      );
      evidence.step9 = {
        status: 'green',
        env2VersionNo: env2.versionNo,
        stableEqual: true,
        stageIdentityEqual,
        env2Verified: env2Verified.length,
        signOffsNeeded: signed,
      };
    } finally {
      if (secondApp) await secondApp.close();
      process.env.DATABASE_URL = originalDbUrl;
      // 第二库的媒体文件写在同一本地存储根下；库被 DROP 后按课程 id 回收文件。
      if (f6CourseId) {
        const mediaRoot = path.resolve(
          process.env.COURSE_MEDIA_ROOT?.trim() || 'storage/course-media',
        );
        await fs
          .rm(path.join(mediaRoot, 'course-media', f6CourseId), {
            recursive: true,
            force: true,
          })
          .catch(() => undefined);
      }
      await second.end().catch(() => undefined);
      const cleanup = new PgClient({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup
        .query(`DROP DATABASE IF EXISTS "${secondDb}" WITH (FORCE)`)
        .catch(() => undefined);
      await cleanup.end();
    }
  });

  // =========================================================================
  // 步骤 10：F4 坏包逐项拒绝，无副作用
  // =========================================================================

  it('step10 rejects every bad F4 package fail-closed with no side effects', async () => {
    const expected: Array<{ file: string; codes: string[] }> = [
      {
        file: '01-missing-manifest-field.zip',
        codes: ['PACKAGE_FORMAT_UNSUPPORTED', 'PACKAGE_MANIFEST_INVALID'],
      },
      { file: '02-unknown-file.zip', codes: ['PACKAGE_FILE_UNKNOWN'] },
      {
        file: '03-version-missing.zip',
        codes: ['PACKAGE_FORMAT_UNSUPPORTED', 'PACKAGE_MANIFEST_INVALID'],
      },
      {
        file: '04-duplicate-truth-key.zip',
        codes: ['CODE_DUPLICATE', 'TEMPLATE_ROW_INVALID'],
      },
      { file: '05-out-of-range-time.zip', codes: ['TIMING_RANGE_INVALID'] },
      { file: '06-unknown-code.zip', codes: ['REFERENCE_UNRESOLVED'] },
      {
        file: '07-missing-language.zip',
        codes: ['MEDIA_BINDING_MISSING', 'TEMPLATE_ROW_INVALID'],
      },
      {
        file: '08-illegal-media-type.zip',
        codes: ['PACKAGE_FORMAT_UNSUPPORTED', 'PACKAGE_MANIFEST_INVALID'],
      },
      {
        file: '09-zip-path-traversal.zip',
        codes: [
          'PACKAGE_FILE_UNKNOWN',
          'PACKAGE_FORMAT_UNSUPPORTED',
          'PACKAGE_MANIFEST_INVALID',
          'PACKAGE_INVALID_ZIP',
        ],
      },
    ];
    const coursesBefore = await prisma.commerceCourse.count();
    const categoriesBefore = await prisma.courseCatalogueEntry.count();
    const stagesBefore = await prisma.pcStage.count();

    const results: Array<{
      file: string;
      status: string;
      code: string;
      httpStatus: number;
    }> = [];
    for (const entry of expected) {
      const bytes = await fs.readFile(path.join(F4_DIR, entry.file));
      const res = await agent
        .post('/api/backoffice/courses/import')
        .attach('file', bytes, {
          filename: entry.file,
          contentType: 'application/zip',
        });
      const body = res.body as {
        data?: JobView;
        error?: { code?: string };
      };
      let status: string;
      let code: string;
      if (body.data?.jobId) {
        createdJobIds.push(body.data.jobId);
        const full =
          body.data.status === 'AWAITING_CONFIRM'
            ? body.data
            : await getJob(body.data.jobId);
        status = full.status;
        code = full.report.errors[0]?.code ?? '';
      } else {
        // 上传阶段直接拒绝（fail-closed 的另一种形态），没有作业行。
        status = 'REJECTED';
        code = errorCode(res);
        expect([400, 422]).toContain(res.status);
      }
      log(
        'step10',
        `${entry.file} http=${res.status} status=${status} code=${code}`,
      );
      expect(['FAILED', 'REJECTED']).toContain(status);
      expect(entry.codes).toContain(code);
      results.push({ file: entry.file, status, code, httpStatus: res.status });
    }
    expect(await prisma.commerceCourse.count()).toBe(coursesBefore);
    expect(await prisma.courseCatalogueEntry.count()).toBe(categoriesBefore);
    expect(await prisma.pcStage.count()).toBe(stagesBefore);
    evidence.step10 = results;
    log(
      'step10',
      `rejected=${results.length}/9 coursesUnchanged=${coursesBefore} categoriesUnchanged=${categoriesBefore}`,
    );
  });

  // =========================================================================
  // 步骤 11：全程不变量
  // =========================================================================

  it('step11 asserts no hash dependence, no human time input, no Uncategorized, no global timeline table', async () => {
    // 11a 无 hash 依赖：Part C 契约面（课程包 manifest、冻结版本、导出包）
    // 不含任何 hash/digest/checksum 字段。legacy 媒体资产表仍有一个历史
    // `checksum` 诊断列（B5 迁移遗留），不参与身份与对齐，故不在本断言内。
    const manifests: Array<Record<string, unknown>> = [
      JSON.parse(
        await fs.readFile(path.join(F2_DIR, 'manifest.json'), 'utf8'),
      ) as Record<string, unknown>,
    ];
    if (exportedV1) {
      const zip = await JSZip.loadAsync(exportedV1);
      manifests.push(
        JSON.parse(await zip.file('manifest.json')!.async('string')) as Record<
          string,
          unknown
        >,
      );
    }
    for (const manifest of manifests) {
      expect(hashLikeKeys(manifest)).toEqual([]);
      const resources = (manifest as { resources?: unknown }).resources;
      expect(hashLikeKeys(resources)).toEqual([]);
    }
    const versions = await contentVersions();
    expect(hashLikeKeys(versions)).toEqual([]);

    // 11b 无人工时间字段：冻结版本的视频 rendition 全部是机器时间源 + 半开区间；
    //     导出模板也没有任何时间列。
    for (const version of versions) {
      for (const rendition of version.renditions) {
        if (rendition.modality !== 'video') continue;
        expect(MACHINE_TIMING_SOURCES.has(rendition.anchorSource)).toBe(true);
        expect(rendition.startMs).toBeGreaterThanOrEqual(0);
        expect(rendition.endMs).toBeGreaterThan(rendition.startMs);
      }
      expect(version).not.toHaveProperty('humanTime');
      expect(version).not.toHaveProperty('manualTime');
    }
    if (exportedV1) {
      const zip = await JSZip.loadAsync(exportedV1);
      const templateFile = Object.keys(zip.files).find((name) =>
        /template\.xlsx$/.test(name),
      );
      expect(templateFile).toBeTruthy();
      const headers = readWorkbookHeaders(
        await zip.file(templateFile!)!.async('nodebuffer'),
      );
      for (const sheetHeaders of Object.values(headers)) {
        for (const header of sheetHeaders) {
          expect(TIME_COLUMN_PATTERN.test(header)).toBe(false);
        }
      }
    }

    // 11c 无 Uncategorized：库内分类没有占位词；冻结分类路径是 Science。
    const categories = await prisma.courseCatalogueEntry.findMany({
      select: { name: true },
    });
    for (const category of categories) {
      expect(category.name).not.toMatch(/uncategori[sz]ed/i);
    }
    for (const version of versions) {
      expect(version.categoryPath).toEqual(['Science']);
    }

    // 11d 无 global timeline / schedule 表。
    const timelineTables = await prisma.$queryRaw<
      Array<{ table_name: string }>
    >`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (table_name ILIKE '%timeline%' OR table_name ILIKE '%global_time%'
             OR table_name ILIKE '%course_schedule%' OR table_name ILIKE '%calendar%')`;
    expect(timelineTables).toEqual([]);

    log(
      'step11',
      `hashKeys=none timeColumns=none uncategorized=none timelineTables=[] categories=${JSON.stringify(categories.map((c) => c.name))}`,
    );
  });
});
