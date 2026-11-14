import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import type { Response } from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import type { ErrorResponse } from './helpers/http-response';
import { signInAs } from './helpers/employee-session';

/**
 * 缝 S4：课程包导入/导出分类行为（设计 SSOT：docs/Course_Category_Single_Source_Design.md）。
 *
 * 覆盖规格：
 * - C5 课程包导入（新规格 formatVersion = 2，不兼容旧包）：
 *   manifest.course.categoryPath: string[] | null 必填；不再有 course.category；
 *   逐级在 ACTIVE 节点中按 name 或 localized 任一语言显示名匹配（trim、大小写不敏感）；
 *   解析失败 → 整个 job FAILED，错误码 CATEGORY_NOT_FOUND，消息列出未解析路径；
 *   不创建分类；解析与课程写入同一事务（失败草稿保持原样）。
 * - C6 课程包导出（只出 v2）：formatVersion = 2；categoryPath 为 null 表示未分类；
 *   不写 course.category；禁止 Uncategorized/Uncategorised 任何占位词。
 * - I8 分类改名后旧包找不到分类 → 拒绝导入，不自动重建（本文件用"不存在的路径"覆盖同一条安全行为）。
 * - M5 占位词不得再被导入/导出命中。
 * - M6 预置分类的 localized 显示名（中文名"社会"）是导入匹配的一部分。
 *
 * 黑盒边界：行为全部经 backoffice HTTP（supertest）观察（job 视图、课程详情、分类列表），
 * 不断言私有字段/内部数据结构。数据库与本地包暂存目录只用于 arrange / cleanup。
 *
 * 驱动方式说明（为什么不是每个用例都 POST 一个 zip）：
 * 1) 分类解析发生在「确认导入」写入事务里（C5）。POST /courses/import 的解包校验跑在
 *    worker 线程（server/src/commerce-courses/heavy-tasks.ts 加载同目录 import-worker.js）。
 *    ts-jest 下 __dirname 是源码目录，import-worker.js 只有 dist 构建后才有；未构建的
 *    环境下该路径不存在，上传端点会把 job 标成 FAILED（"Cannot find module ..."），
 *    与规格行为无关。任务允许「既有 package e2e 模式驱动」：本文件对解析/原子性/并发
 *    用例沿用 test/commerce-courses-workflow.e2e-spec.ts 的模式——用 Prisma 建
 *    AWAITING_CONFIRM 作业，把已校验的 __manifest.json 放进本地暂存目录（与
 *    CourseStorageService 的本地驱动同一布局），再走 HTTP 的 confirm / GET job 观察行为。
 * 2) 旧规格包拒绝（C5 的校验点）与导出（C6）分别走真实上传端点（POST /courses/import）
 *    与导出端点（POST /courses/:id/export + GET export job + 下载），不经过暂存 arrange。
 *
 * 运行（本地专用 e2e 库，已迁移到最新 schema）：
 *   export DATABASE_URL=postgresql://admin:admin@localhost:5432/learning_guide_e2e
 *   npm run test:e2e -- category-package --runInBand
 * CI：.github/workflows/ci.yml 的 e2e job 以 postgres:16 服务 + npx prisma migrate deploy
 * 准备同一 schema，再执行 npm run test:e2e -- --runInBand。
 */

jest.setTimeout(120_000);

const PREFIX = `E2E-CAT-PKG-${Date.now()}`;

/** 包暂存目录（本地驱动回退路径；与 commerce.config.ts 的默认值一致）。 */
const STAGING_ROOT = path.resolve(
  process.env.COURSE_PACKAGE_ROOT?.trim() || 'storage/course-package',
);

interface TestManifest {
  format: 'lg-course-package';
  formatVersion: number;
  packageId?: string;
  exportedAt?: string;
  source?: {
    environment?: string;
    courseCode?: string;
    sourceVersion?: string;
  };
  incomplete?: boolean;
  provenance?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  course: Record<string, unknown> & {
    code?: string;
    slug?: string;
    courseKey?: string;
    categoryPath?: string[] | null;
    category?: string;
  };
}

interface JobReportIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
}

interface JobView {
  jobId: string;
  kind: string;
  status: string;
  stage: string | null;
  progress: number;
  error: string | null;
  courseId: string | null;
  report: { errors: JobReportIssue[]; warnings: JobReportIssue[] };
}

interface CategoryNode {
  id: string;
  name: string;
  localized: Record<string, unknown>;
}

interface CourseDetail {
  id: string;
  code: string;
  slug: string;
  categoryId: string | null;
  category: {
    id: string;
    name: string;
    localized: Record<string, unknown>;
  } | null;
  localizations: Array<{ language: string; title: string }>;
  lessons?: Array<{ id: string; code: string }>;
}

describe('Course package import/export category behaviour (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let agent: Awaited<ReturnType<typeof signInAs>>;

  /** 预置一级分类 Society 的 id（课程创建/导入的目标分类）。 */
  let societyId: string;
  /** 若环境里已预置 ACTIVE 的 Science（M6 补种后会出现），本套件临时归档并在 afterAll 恢复。 */
  let archivedScienceId: string | null = null;
  /** 本套件创建的 package job，afterAll 清理。 */
  const createdJobIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    agent = await signInAs(app, 'ADMIN');

    // arrange：预置分类 Society 必须存在（迁移 20261112030000 幂等补种）。
    const categories = await listCategories();
    const society = categories.find(
      (node) => node.name.trim().toLowerCase() === 'society',
    );
    if (!society) {
      throw new Error(
        'prerequisite missing: the seeded ACTIVE top-level category "Society" must exist in the e2e database',
      );
    }
    societyId = society.id;

    // C5 用例 1 要求目标环境没有 Science。当前迁移未补种 Science；如果将来 M6 补种，
    // 这里临时归档，保证用例语义稳定（import 只匹配 ACTIVE），afterAll 恢复。
    const science = await prisma.courseCatalogueEntry.findFirst({
      where: {
        parentId: null,
        name: { equals: 'Science', mode: 'insensitive' },
      },
      select: { id: true, status: true },
    });
    if (science?.status === 'ACTIVE') {
      archivedScienceId = science.id;
      await prisma.courseCatalogueEntry.update({
        where: { id: science.id },
        data: { status: 'ARCHIVED' },
      });
    }
  });

  afterAll(async () => {
    // 清理本套件造的数据（best effort：课程事件是 append-only，失败不影响其它测试）。
    await prisma.commerceCourse
      .deleteMany({ where: { code: { startsWith: `${PREFIX}-` } } })
      .catch(() => undefined);
    // Part C 导入会写 pc_* 仓库层（courseKey = 课程 code）；按前缀清理。
    await prisma.pcRendition
      .deleteMany({ where: { renditionKey: { contains: PREFIX } } })
      .catch(() => undefined);
    await prisma.pcContentSpec
      .deleteMany({ where: { contentKey: { contains: PREFIX } } })
      .catch(() => undefined);
    await prisma.pcStage
      .deleteMany({ where: { courseKey: { contains: PREFIX } } })
      .catch(() => undefined);
    await prisma.pcCourse
      .deleteMany({ where: { courseKey: { contains: PREFIX } } })
      .catch(() => undefined);
    if (createdJobIds.length) {
      await prisma.coursePackageJob
        .deleteMany({ where: { id: { in: createdJobIds } } })
        .catch(() => undefined);
      for (const jobId of createdJobIds) {
        await fs
          .rm(path.join(STAGING_ROOT, jobId), { recursive: true, force: true })
          .catch(() => undefined);
      }
    }
    if (archivedScienceId) {
      await prisma.courseCatalogueEntry
        .update({
          where: { id: archivedScienceId },
          data: { status: 'ACTIVE' },
        })
        .catch(() => undefined);
    }
    await app.close();
  });

  // ===== 小工具 =====

  function uniqueCode(label: string): string {
    return `${PREFIX}-${label}`.toUpperCase();
  }

  function dataOf<T>(res: Response): T {
    return (res.body as { data: T }).data;
  }

  async function listCategories(): Promise<CategoryNode[]> {
    const res = await agent
      .get('/api/backoffice/courses/categories')
      .expect(200);
    return dataOf<CategoryNode[]>(res);
  }

  /** 分类名（trim/大小写不敏感）在 ACTIVE 一级分类列表里的出现次数。 */
  async function categoryNameCount(name: string): Promise<number> {
    const categories = await listCategories();
    return categories.filter(
      (node) => node.name.trim().toLowerCase() === name.toLowerCase(),
    ).length;
  }

  async function getJob(
    kind: 'import' | 'export',
    jobId: string,
  ): Promise<JobView> {
    const res = await agent
      .get(`/api/backoffice/courses/${kind}/${jobId}`)
      .expect(200);
    return dataOf<JobView>(res);
  }

  async function confirmImport(
    jobId: string,
    body: { onConflict: 'ABORT' | 'CREATE_NEW_COURSE' | 'NEW_VERSION' } = {
      onConflict: 'ABORT',
    },
  ): Promise<Response> {
    return agent
      .post(`/api/backoffice/courses/import/${jobId}/confirm`)
      .send(body);
  }

  async function getCourse(courseId: string): Promise<CourseDetail> {
    const res = await agent
      .get(`/api/backoffice/courses/${courseId}`)
      .expect(200);
    return dataOf<CourseDetail>(res);
  }

  async function listCoursesBySearch(
    search: string,
  ): Promise<Array<{ id: string; code: string }>> {
    const res = await agent
      .get('/api/backoffice/courses')
      .query({ search, pageSize: 100 })
      .expect(200);
    return dataOf<{ courses: Array<{ id: string; code: string }> }>(res)
      .courses;
  }

  async function createDraftCourse(label: string): Promise<CourseDetail> {
    const code = uniqueCode(label);
    const res = await agent
      .post('/api/backoffice/courses')
      .send({ code, title: `${code} original title`, categoryId: societyId })
      .expect(201);
    return dataOf<CourseDetail>(res);
  }

  /** 业务错误包络：设计只钉错误码，未钉 HTTP 状态码，这里只要求 4xx。 */
  function expectRejectedWithCode(res: Response, code: string): void {
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = res.body as ErrorResponse['body'];
    expect(body.success).toBe(false);
    expect(body.data).toBeNull();
    expect(body.error?.code).toBe(code);
  }

  /** 导出当前草稿（version='working'），返回 export job id。 */
  async function startDraftExport(courseId: string): Promise<string> {
    const res = await agent
      .post(`/api/backoffice/courses/${courseId}/export`)
      .send({ version: 'working' })
      .expect(202);
    const data = dataOf<{ jobId: string }>(res);
    createdJobIds.push(data.jobId);
    return data.jobId;
  }

  async function waitForExportJob(jobId: string): Promise<JobView> {
    const deadline = Date.now() + 60_000;
    let last: JobView | null = null;
    while (Date.now() < deadline) {
      last = await getJob('export', jobId);
      if (last.status === 'READY' || last.status === 'FAILED') return last;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(
      `export job ${jobId} did not settle in time (last status: ${last?.status ?? 'unknown'})`,
    );
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

  async function downloadExport(jobId: string): Promise<Buffer> {
    const res = await agent
      .get(`/api/backoffice/courses/export/${jobId}/download`)
      .buffer(true)
      .parse(binaryParser as never)
      .expect(200);
    return res.body as Buffer;
  }

  interface ExportedManifest {
    manifest: TestManifest;
    rawText: string;
  }

  async function downloadManifest(jobId: string): Promise<ExportedManifest> {
    const bytes = await downloadExport(jobId);
    const zip = await JSZip.loadAsync(bytes);
    const entry = zip.file('manifest.json');
    if (!entry) {
      throw new Error('exported package is missing manifest.json');
    }
    const rawText = await entry.async('string');
    return { manifest: JSON.parse(rawText) as TestManifest, rawText };
  }

  /**
   * 构造新规格（formatVersion=2）课程包 manifest。
   * categoryPath 省略 → 字段缺省（旧规格形态）；legacyCategory 存在 → 带 course.category（旧规格形态）。
   */
  function makeManifest(params: {
    code: string;
    categoryPath?: string[] | null;
    includeCategoryPath?: boolean;
    legacyCategory?: string;
    formatVersion?: number;
    title?: string;
  }): TestManifest {
    const title = params.title ?? `${params.code} package title`;
    const course: TestManifest['course'] = {
      code: params.code,
      slug: params.code.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      learningMode: 'TEXT_ONLY',
      learningLanguages: ['en-GB'],
      defaultContentLanguage: 'en-GB',
      localized: {
        'en-GB': {
          title,
          shortDescription: `${params.code} short description`,
          overview: `${params.code} overview`,
          whatYouLearn: [`${params.code} outcome`],
        },
      },
      lessons: [
        {
          code: 'L1',
          order: 1,
          localized: {
            'en-GB': {
              title: 'Lesson 1',
              text: {
                html: '<p>Lesson body</p>',
                learningPoints: [{ code: 'LP1', heading: 'Intro' }],
              },
            },
          },
        },
      ],
    };
    if (params.categoryPath !== undefined) {
      course.categoryPath = params.categoryPath;
    }
    if (params.legacyCategory !== undefined) {
      course.category = params.legacyCategory;
    }
    return {
      format: 'lg-course-package',
      formatVersion: params.formatVersion ?? 2,
      packageId: `pkg_e2e_${randomUUID()}`,
      exportedAt: new Date().toISOString(),
      source: {
        environment: 'E2E',
        courseCode: params.code,
        sourceVersion: 'draft',
      },
      incomplete: false,
      course,
    };
  }

  /**
   * 既有 package e2e 模式：直接建一个已通过上传校验的 AWAITING_CONFIRM 作业，
   * 把 manifest 放进本地暂存目录（storageKey 布局 = `<jobId>/__manifest.json`）。
   * 后续行为全部走 HTTP confirm / GET job 观察。
   */
  async function createAwaitingImportJob(
    manifest: TestManifest,
    targetCourseId?: string,
    packageFiles?: Map<string, Buffer>,
  ): Promise<string> {
    const job = await prisma.coursePackageJob.create({
      data: {
        kind: 'IMPORT',
        status: 'AWAITING_CONFIRM',
        stage: 'VALIDATED',
        sourceFileName: `${manifest.course.code}.lgcourse.zip`,
        courseId: targetCourseId ?? null,
      },
      select: { id: true },
    });
    const stagingDir = path.join(STAGING_ROOT, job.id);
    for (const [name, bytes] of packageFiles ?? []) {
      const target = path.join(stagingDir, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    }
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(
      path.join(stagingDir, '__manifest.json'),
      JSON.stringify(manifest),
    );
    createdJobIds.push(job.id);
    return job.id;
  }

  /** 确认为 READY，返回课程 id；红在预览/导入缺失时给出可读原因。 */
  async function confirmImportToReady(jobId: string): Promise<string> {
    const res = await confirmImport(jobId);
    if (res.status !== 200) {
      throw new Error(
        `expected import confirm to succeed, got ${res.status}: ${JSON.stringify(res.body)}`,
      );
    }
    const data = dataOf<{ status: string; courseId: string }>(res);
    expect(data.status).toBe('READY');
    expect(typeof data.courseId).toBe('string');
    return data.courseId;
  }

  /**
   * C5 失败契约：整个 job FAILED，且结构化错误码 = 期望值。
   * 设计只要求「job FAILED + 错误码」，未钉校验发生在上传还是确认阶段：
   * 已 FAILED 的作业直接读 report；仍在等待确认的作业按真实用户路径确认并读错误包络。
   */
  async function expectImportJobRejected(
    jobId: string,
    expectedCode: string,
  ): Promise<JobView> {
    let job = await getJob('import', jobId);
    if (job.status === 'AWAITING_CONFIRM') {
      const res = await confirmImport(jobId);
      expectRejectedWithCode(res, expectedCode);
      job = await getJob('import', jobId);
    }
    expect(job.status).toBe('FAILED');
    const codes = job.report.errors.map((issue) => issue.code);
    if (!codes.includes(expectedCode)) {
      throw new Error(
        `job ${jobId} failed without structured code ${expectedCode}: ` +
          `status=${job.status}, error=${JSON.stringify(job.error)}, reportCodes=${JSON.stringify(codes)}`,
      );
    }
    return job;
  }

  // ===== 用例 =====

  it('fails the whole job with CATEGORY_NOT_FOUND and creates no category when categoryPath targets a missing node (C5, I8, M5)', async () => {
    // 前置：目标环境没有 ACTIVE 的 Science（beforeAll 已归档任何预置 Science）。
    expect(await categoryNameCount('Science')).toBe(0);
    const before = (await listCategories()).map((node) => node.name).sort();

    const code = uniqueCode('PKG-MISSING');
    const manifest = makeManifest({ code, categoryPath: ['Science'] });
    const jobId = await createAwaitingImportJob(manifest);

    const res = await confirmImport(jobId);
    expectRejectedWithCode(res, 'CATEGORY_NOT_FOUND');

    const job = await getJob('import', jobId);
    expect(job.status).toBe('FAILED');
    // 「消息含 Science」：未解析路径必须出现在作业错误里，便于运营定位。
    expect(job.error ?? '').toContain('Science');

    // 「不创建分类」：ACTIVE 一级分类列表与导入前完全一致。
    const after = (await listCategories()).map((node) => node.name).sort();
    expect(after).toEqual(before);
    // 失败不产生课程（黑盒：列表按 code 搜不到）。
    const courses = await listCoursesBySearch(code);
    expect(courses.some((course) => course.code === code)).toBe(false);
  });

  it('resolves a Chinese localized display name in categoryPath to the existing Society category (C5, M6)', async () => {
    const code = uniqueCode('PKG-ZH');
    // Society 的 zh-CN localized.name = 社会（迁移 20261112040000）。
    const manifest = makeManifest({ code, categoryPath: ['社会'] });
    const jobId = await createAwaitingImportJob(manifest);

    const courseId = await confirmImportToReady(jobId);
    const detail = await getCourse(courseId);
    expect(detail.code).toBe(code);
    // 稳定键是 Society；课程详情里的 category 即 CategoryRef（id/name/localized）。
    expect(detail.category?.name).toBe('Society');
  });

  it('resolves categoryPath with surrounding whitespace and case differences to Society (C5, I1)', async () => {
    const code = uniqueCode('PKG-TRIM');
    const manifest = makeManifest({ code, categoryPath: ['  society  '] });
    const jobId = await createAwaitingImportJob(manifest);

    const courseId = await confirmImportToReady(jobId);
    const detail = await getCourse(courseId);
    expect(detail.category?.name).toBe('Society');
    // 大小写/空白变体绝不能造出第二个分类行。
    expect(await categoryNameCount('society')).toBe(1);
  });

  const legacyPackageCases: Array<{
    label: string;
    build: (code: string) => TestManifest;
  }> = [
    {
      label: 'formatVersion=1 with course.category',
      build: (code) =>
        makeManifest({
          code,
          formatVersion: 1,
          legacyCategory: 'Society',
        }),
    },
    {
      label: 'formatVersion=2 with legacy course.category',
      build: (code) =>
        makeManifest({
          code,
          categoryPath: ['Society'],
          legacyCategory: 'Society',
        }),
    },
    {
      label: 'formatVersion=2 without categoryPath',
      build: (code) => makeManifest({ code }),
    },
  ];

  it.each(legacyPackageCases)(
    'rejects a legacy package ($label) with PACKAGE_FORMAT_UNSUPPORTED without compatibility parsing (C5)',
    async ({ build }) => {
      // 先建一门同 code 的草稿：兼容解析若真的发生，会命中并替换这门草稿。
      const draft = await createDraftCourse(
        `PKG-LEGACY-${randomUUID().slice(0, 8)}`,
      );
      const manifest = build(draft.code);

      // 走真实上传端点：旧规格拒绝属于上传校验（C5「整个 job FAILED」）。
      const zip = new JSZip();
      zip.file('manifest.json', JSON.stringify(manifest, null, 2));
      const bytes = await zip.generateAsync({ type: 'nodebuffer' });
      const res = await agent
        .post('/api/backoffice/courses/import')
        .attach('file', bytes, {
          filename: `${draft.code}.lgcourse.zip`,
          contentType: 'application/zip',
        });
      expect([200, 201]).toContain(res.status);
      const uploaded = (res.body as { data?: JobView }).data;
      if (!uploaded?.jobId) {
        throw new Error(
          `upload did not create an import job: ${res.status} ${JSON.stringify(res.body)}`,
        );
      }
      createdJobIds.push(uploaded.jobId);

      await expectImportJobRejected(
        uploaded.jobId,
        'PACKAGE_FORMAT_UNSUPPORTED',
      );

      // 「不做任何兼容解析，草稿不变」：同 code 的草稿仍是创建时的样子。
      const after = await getCourse(draft.id);
      const titleOf = (detail: CourseDetail) =>
        detail.localizations.find((loc) => loc.language === 'en-GB')?.title;
      expect(titleOf(after)).toBe(titleOf(draft));
      expect(after.category?.name).toBe('Society');
    },
  );

  it('exports an uncategorized course as formatVersion 2 with categoryPath null and no placeholder category (C6, M5)', async () => {
    const draft = await createDraftCourse('EXPORT-UNCATEGORIZED');
    // 未分类课程是存量形态（M3 背填不中）：C3 之后新建必须带分类，故直接改库模拟旧数据。
    await prisma.commerceCourse.update({
      where: { id: draft.id },
      data: { categoryId: null, legacyCategory: null },
    });

    const jobId = await startDraftExport(draft.id);
    const job = await waitForExportJob(jobId);
    expect(job.status).toBe('READY');

    const { manifest, rawText } = await downloadManifest(jobId);
    expect(manifest.format).toBe('lg-course-package');
    // C6：只出 v2。
    expect(manifest.formatVersion).toBe(2);
    // C6：未分类 → categoryPath 必填字段明确为 null（不是缺省、不是空数组）。
    expect(
      Object.prototype.hasOwnProperty.call(manifest.course, 'categoryPath'),
    ).toBe(true);
    expect(manifest.course.categoryPath).toBeNull();
    // C6：不再写 course.category 字符串字段。
    expect(
      Object.prototype.hasOwnProperty.call(manifest.course, 'category'),
    ).toBe(false);
    // M5：任何占位词都不得出现在导出清单里。
    expect(rawText).not.toMatch(/Uncategorised?/i);
  });

  it('round-trips categoryPath through export then import and keeps the category name (C5, C6)', async () => {
    const source = await createDraftCourse('ROUND-TRIP');

    const exportJobId = await startDraftExport(source.id);
    const exportJob = await waitForExportJob(exportJobId);
    expect(exportJob.status).toBe('READY');
    const { manifest: exported } = await downloadManifest(exportJobId);

    // 导出侧契约：Part C v2（唯一 v2 SSOT）+ 稳定键路径（不含环境 UUID）。
    expect(exported.formatVersion).toBe(2);
    expect(exported.course.categoryPath).toEqual(['Society']);
    expect(exported.course.courseKey).toBe(source.code);

    // 导入侧契约：同一份包重新走 Part C 编译器管线（parse→validate→
    // deriveTiming→align），分类路径解析回同名分类，草稿被替换为包内容。
    const zipBytes = await downloadExport(exportJobId);
    const zip = await JSZip.loadAsync(zipBytes);
    const packageFiles = new Map<string, Buffer>();
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || entry.name === 'manifest.json') continue;
      packageFiles.set(entry.name, await entry.async('nodebuffer'));
    }
    const importJobId = await createAwaitingImportJob(
      exported,
      source.id,
      packageFiles,
    );
    const courseId = await confirmImportToReady(importJobId);
    expect(courseId).toBe(source.id);
    const detail = await getCourse(courseId);
    expect(detail.code).toBe(source.code);
    expect(detail.category?.name).toBe('Society');
  });

  it('keeps the draft untouched when an import fails category resolution (C5)', async () => {
    const draft = await createDraftCourse('DRAFT-KEEP');
    const before = await getCourse(draft.id);

    // 坏包：指向不存在的分类；导入到已有课程（POST /courses/:id/import 的作业形态）。
    const badManifest = makeManifest({
      code: draft.code,
      categoryPath: ['Science'],
      title: `${draft.code} REPLACED BY BAD PACKAGE`,
    });
    const jobId = await createAwaitingImportJob(badManifest, draft.id);

    const res = await confirmImport(jobId);
    expectRejectedWithCode(res, 'CATEGORY_NOT_FOUND');
    const job = await getJob('import', jobId);
    expect(job.status).toBe('FAILED');

    // 原子性：草稿原样（标题/分类/课程身份都没有被坏包替换）。
    const after = await getCourse(draft.id);
    const titleOf = (detail: CourseDetail) =>
      detail.localizations.find((loc) => loc.language === 'en-GB')?.title;
    expect(titleOf(after)).toBe(titleOf(before));
    expect(after.category?.name).toBe('Society');
    expect(after.categoryId).toBe(before.categoryId);
    expect(after.code).toBe(before.code);
  });

  it('concurrent imports of the same category name do not create duplicate category rows (C5, I1, I2)', async () => {
    expect(await categoryNameCount('society')).toBe(1);

    // 两个作业、两种写法（大小写 / 前后空白），并发确认：都应解析到既有 Society。
    const manifestA = makeManifest({
      code: uniqueCode('PKG-CONCURRENT-A'),
      categoryPath: ['society'],
    });
    const manifestB = makeManifest({
      code: uniqueCode('PKG-CONCURRENT-B'),
      categoryPath: [' Society '],
    });
    const [jobA, jobB] = await Promise.all([
      createAwaitingImportJob(manifestA),
      createAwaitingImportJob(manifestB),
    ]);
    const [courseA, courseB] = await Promise.all([
      confirmImportToReady(jobA),
      confirmImportToReady(jobB),
    ]);

    expect((await getCourse(courseA)).category?.name).toBe('Society');
    expect((await getCourse(courseB)).category?.name).toBe('Society');
    // unique 索引兜底的目标状态：分类表里仍只有一条 Society（没有 society / " Society " 变体）。
    expect(await categoryNameCount('society')).toBe(1);
    const categories = await listCategories();
    expect(
      categories.filter((node) =>
        node.name.trim().toLowerCase().startsWith('society'),
      ),
    ).toHaveLength(1);
  });
});
