import type { ErrorResponse, SuccessResponse } from './helpers/http-response';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import JSZip from 'jszip';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { CourseStorageService } from '../src/commerce-courses/storage.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { signInAs } from './helpers/employee-session';

/**
 * 缝 S5：快照、恢复、草稿状态、投影时点。
 * 设计 SSOT：docs/Course_Category_Single_Source_Design.md
 *
 * 覆盖的规格：
 * - C7 版本快照与恢复：v3 快照存 categoryPath、不存分类 UUID；Restore 按路径在本环境
 *   解析，失败 CATEGORY_NOT_FOUND 且草稿不变；v2 快照按 categoryId 本地解析，找不到即报错。
 * - C8 Portal 投影：category/categoryLocalized 取线上版本快照（发布时点），草稿改分类
 *   不泄漏到线上；历史版本预览/导出使用该版本的分类路径，而不是当前行。
 * - C9 草稿状态：显式状态语义（draftRevision 与 liveBaseRevision），内容哈希不再参与
 *   No draft；Restore 线上版本 → No draft；Restore 旧版本/导入课程包 → 有草稿；
 *   Publish → No draft；编辑后手动改回原值仍为有草稿（O1）。
 * - I9 快照 v3 的 course.categoryPath 形状。
 *
 * 黑盒边界：行为只经 backoffice / portal HTTP 观察；不断言私有字段，不 import 尚不存在
 * 的内部模块。分类没有 HTTP 管理入口（设计 §2：分类由开发预置），所以分类与"坏版本"
 * 快照只用数据库 arrange / cleanup；所有断言都读 HTTP 响应。
 *
 * 运行：export DATABASE_URL=postgresql://admin:admin@localhost:5432/learning_guide_e2e
 */

type Agent = Awaited<ReturnType<typeof signInAs>>;

interface CategoryFixture {
  id: string;
  name: string;
  localized: Record<string, { name: string }>;
}

interface CategoryRef {
  id: string;
  name: string;
  localized: Record<string, { name?: string }> | null;
}

interface CourseDetail {
  id: string;
  code: string;
  slug: string;
  hasDraft: boolean;
  category: CategoryRef | null;
  localizations: Array<{
    language: string;
    title: string;
    shortDescription: string | null;
    overview: string | null;
    whatYouLearn: unknown;
    provides: unknown;
  }>;
  lessons: Array<{
    id: string;
    code: string;
    localizations: Array<{
      language: string;
      title: string;
      description: string | null;
      textHtml: string | null;
    }>;
  }>;
}

interface CourseListItem {
  id: string;
  code: string;
  hasDraft: boolean;
  category: CategoryRef | null;
}

interface PortalCourseRow {
  id: string;
  code: string;
  category: string | null;
  categoryLocalized: Record<string, { name?: string }> | null;
}

interface SnapshotLocalizationJson {
  language: string;
  title: string;
  [key: string]: unknown;
}

interface SnapshotJson {
  formatVersion: number;
  capturedAt?: string;
  course: {
    code: string;
    slug: string;
    categoryId?: string | null;
    categoryPath?: string[] | null;
    learningMode?: string;
    defaultContentLanguage?: string;
    learningLanguages?: string[];
    localizations: SnapshotLocalizationJson[];
    lessons: Array<Record<string, unknown>>;
  };
}

interface VersionDetail {
  id: string;
  versionLabel: string;
  snapshotData: SnapshotJson;
}

const PREFIX = `E2E-CAT-VER-${Date.now()}`;

// 导出作业由 DB 队列 worker 每 2s 轮询一次；CI 上给足余量，避免默认 5s 超时抖动。
jest.setTimeout(60_000);

describe('Course category version, restore and draft state (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let storage: CourseStorageService;
  let agent: Agent;

  let categoryA: CategoryFixture;
  let categoryB: CategoryFixture;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    storage = app.get(CourseStorageService);
    agent = await signInAs(app, 'ADMIN');

    categoryA = await createCategory('A');
    categoryB = await createCategory('B');
  });

  afterAll(async () => {
    // best effort：课程事件表是 append-only，清理失败不影响其它测试
    const courses = await prisma.commerceCourse
      .findMany({
        where: { code: { startsWith: PREFIX } },
        select: { id: true },
      })
      .catch(() => []);
    const ids = courses.map((course) => course.id);
    if (ids.length) {
      await prisma.coursePackageJob
        .deleteMany({ where: { courseId: { in: ids } } })
        .catch(() => undefined);
      await prisma.courseVersion
        .deleteMany({ where: { courseId: { in: ids } } })
        .catch(() => undefined);
      await prisma.commerceCourse
        .deleteMany({ where: { id: { in: ids } } })
        .catch(() => undefined);
    }
    await prisma.courseCatalogueEntry
      .deleteMany({ where: { name: { startsWith: PREFIX } } })
      .catch(() => undefined);
    await app.close();
  });

  async function createCategory(label: string): Promise<CategoryFixture> {
    const name = `${PREFIX} ${label}`;
    const localized = {
      'en-GB': { name },
      'zh-CN': { name: `${PREFIX} ${label} 中文` },
    };
    const row = await prisma.courseCatalogueEntry.create({
      data: { name, localized, status: 'ACTIVE', sortOrder: 0 },
      select: { id: true },
    });
    return { id: row.id, name, localized };
  }

  /** 通过 HTTP 造一门可发布（canPublish）的 TEXT_ONLY 课程。 */
  async function createPublishableCourse(label: string, categoryId: string) {
    const code = `${PREFIX}-${label}`.toUpperCase();
    const created: SuccessResponse<CourseDetail> = await agent
      .post('/api/backoffice/courses')
      .send({
        code,
        slug: code.toLowerCase(),
        title: `${code} title`,
        categoryId,
        learningMode: 'TEXT_ONLY',
        defaultContentLanguage: 'en-GB',
        learningLanguages: ['en-GB'],
      })
      .expect(201);
    const id = created.body.data.id;
    await saveCourseLocalization(id, `${code} title`);
    const withLesson: SuccessResponse<CourseDetail> = await agent
      .post(`/api/backoffice/courses/${id}/lessons`)
      .send({ title: 'Lesson 1' })
      .expect(201);
    const lessonId = withLesson.body.data.lessons[0].id;
    await agent
      .put(`/api/backoffice/courses/${id}/lessons/${lessonId}`)
      .send({
        title: 'Lesson 1',
        description: 'Lesson description',
        textHtml: '<h1>Part one</h1><p>Body text</p>',
      })
      .expect(200);
    return { id, code, lessonId };
  }

  async function saveCourseLocalization(id: string, title: string) {
    await agent
      .put(`/api/backoffice/courses/${id}/localizations/en-GB`)
      .send({
        title,
        shortDescription: 'Short description',
        overview: 'Overview text',
        whatYouLearn: [
          'Outcome one',
          'Outcome two',
          'Outcome three',
          'Outcome four',
        ],
        provides: [
          { title: 'Provide one' },
          { title: 'Provide two' },
          { title: 'Provide three' },
          { title: 'Provide four' },
        ],
      })
      .expect(200);
  }

  async function publish(id: string) {
    const res: SuccessResponse<{
      versionId: string;
      versionLabel: string;
      versionNo: number;
    }> = await agent
      .post(`/api/backoffice/courses/${id}/publish`)
      .send({})
      .expect(200);
    return res.body.data;
  }

  async function goOnline(id: string) {
    await agent
      .post(`/api/backoffice/courses/${id}/live-status`)
      .send({ status: 'ONLINE', reason: 'S5 projection e2e' })
      .expect(200);
  }

  async function getDetail(id: string): Promise<CourseDetail> {
    const res: SuccessResponse<CourseDetail> = await agent
      .get(`/api/backoffice/courses/${id}`)
      .expect(200);
    return res.body.data;
  }

  /** 列表接口的 hasDraft 是纯读取，不会触发任何"内容比较"式的草稿清理。 */
  async function hasDraftInList(code: string): Promise<boolean> {
    const res: SuccessResponse<{ courses: CourseListItem[] }> = await agent
      .get(
        `/api/backoffice/courses?search=${encodeURIComponent(code)}&pageSize=50`,
      )
      .expect(200);
    const row = res.body.data.courses.find((item) => item.code === code);
    expect(row).toBeTruthy();
    return row!.hasDraft;
  }

  async function getVersion(
    courseId: string,
    versionId: string,
  ): Promise<VersionDetail> {
    const res: SuccessResponse<VersionDetail> = await agent
      .get(`/api/backoffice/courses/${courseId}/versions/${versionId}`)
      .expect(200);
    return res.body.data;
  }

  /** 只用于 arrange：直接落一条"历史环境里存在过"的版本快照。 */
  async function seedVersion(
    courseId: string,
    snapshot: SnapshotJson,
    label: string,
    versionNo: number,
  ): Promise<{ id: string }> {
    return prisma.courseVersion.create({
      data: {
        courseId,
        versionNo,
        versionLabel: label,
        wentLiveAt: new Date(),
        snapshotData: snapshot as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  }

  async function portalList(): Promise<PortalCourseRow[]> {
    const res: SuccessResponse<PortalCourseRow[]> = await request(
      app.getHttpServer(),
    )
      .get('/api/portal/v1/courses?limit=100')
      .expect(200);
    return res.body.data;
  }

  async function portalCourse(courseId: string): Promise<PortalCourseRow> {
    const res: SuccessResponse<PortalCourseRow> = await request(
      app.getHttpServer(),
    )
      .get(`/api/portal/v1/courses/${courseId}`)
      .expect(200);
    return res.body.data;
  }

  async function portalCategoryInList(code: string): Promise<string | null> {
    const rows = await portalList();
    const row = rows.find((item) => item.code === code);
    expect(row).toBeTruthy();
    return row!.category;
  }

  async function versionPreviewCategory(
    courseId: string,
    versionId: string,
  ): Promise<string | null> {
    const link: SuccessResponse<{ token: string }> = await agent
      .get(
        `/api/backoffice/courses/${courseId}/portal-preview?versionId=${versionId}&locale=en-GB`,
      )
      .expect(200);
    const preview: SuccessResponse<{ category: string | null }> = await request(
      app.getHttpServer(),
    )
      .get(
        `/api/portal/v1/preview/course?token=${encodeURIComponent(
          link.body.data.token,
        )}`,
      )
      .expect(200);
    return preview.body.data.category;
  }

  /** 轮询导出作业直到 READY，然后下载 zip 字节。 */
  async function waitForExport(jobId: string): Promise<Buffer> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const job: SuccessResponse<{ status: string; error?: string | null }> =
        await agent.get(`/api/backoffice/courses/export/${jobId}`).expect(200);
      if (job.body.data.status === 'READY') break;
      if (job.body.data.status === 'FAILED') {
        throw new Error(
          `Export job ${jobId} failed: ${job.body.data.error ?? 'unknown'}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Export job ${jobId} did not finish in time (status=${job.body.data.status})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const download = await agent
      .get(`/api/backoffice/courses/export/${jobId}/download`)
      .buffer(true)
      .parse(
        (
          response: unknown,
          done: (error: Error | null, body: Buffer) => void,
        ) => {
          const stream = response as NodeJS.ReadableStream;
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          stream.on('end', () => done(null, Buffer.concat(chunks)));
        },
      )
      .expect(200);
    return download.body as Buffer;
  }

  /**
   * 最小可导入课程包 manifest：只含文本课程，不引用媒体。
   * 分类同时带 C5 的新字段 `course.categoryPath`（优先）与兼容字段 `course.category`
   * （稳定键 name）；这样本用例只观察"导入产生草稿"的 C9 语义，不依赖 S4 导入实现的进度。
   */
  function buildMinimalManifest(options: {
    courseCode: string;
    slug: string;
    categoryName: string;
    title: string;
  }) {
    return {
      format: 'lg-course-package',
      formatVersion: 1,
      packageId: `pkg_e2e_${randomUUID()}`,
      exportedAt: new Date().toISOString(),
      source: { environment: 'e2e', courseCode: options.courseCode },
      incomplete: false,
      course: {
        code: options.courseCode,
        slug: options.slug,
        categoryPath: [options.categoryName],
        category: options.categoryName,
        learningMode: 'TEXT_ONLY',
        learningLanguages: ['en-GB'],
        defaultContentLanguage: 'en-GB',
        localized: {
          'en-GB': {
            title: options.title,
            shortDescription: 'Imported short description',
            overview: 'Imported overview',
            whatYouLearn: ['One', 'Two', 'Three', 'Four'],
            provides: [
              { title: 'Provide one' },
              { title: 'Provide two' },
              { title: 'Provide three' },
              { title: 'Provide four' },
            ],
          },
        },
        lessons: [
          {
            code: 'L1',
            order: 1,
            localized: {
              'en-GB': {
                title: 'Imported lesson',
                description: 'Imported lesson description',
                text: {
                  html: '<h1>Imported heading</h1><p>Imported body</p>',
                  learningPoints: [{ code: 'T1', heading: 'Imported heading' }],
                },
              },
            },
            exhibits: [],
          },
        ],
        trial: { enabled: false, lessons: [] },
      },
    };
  }

  /**
   * 已有 package e2e 模式（见 test/commerce-courses-workflow.e2e-spec.ts）：
   * 上传解包校验跑在 worker 线程（heavy-tasks.ts 加载同目录 import-worker.js），
   * ts-jest 直接跑 src 时该编译产物不存在；这里直接摆好一个"已校验、待确认"的
   * 导入作业（数据库 + 本地暂存布局只用于 arrange），再经 HTTP confirm 触发真正的
   * 导入事务与草稿状态变化。
   */
  async function stageImportJob(courseId: string, manifest: unknown) {
    const jobId = randomUUID();
    await prisma.coursePackageJob.create({
      data: {
        id: jobId,
        kind: 'IMPORT',
        status: 'AWAITING_CONFIRM',
        courseId,
        sourceFileName: 'e2e-import.lgcourse.zip',
      },
    });
    await storage.putStaging(
      storage.stagingKey(jobId, '__manifest.json'),
      Buffer.from(JSON.stringify(manifest), 'utf8'),
    );
    return jobId;
  }

  it('publishes a v3 snapshot with categoryPath (the stable key, not the category UUID) and projects the published category (C7, C8, I9)', async () => {
    const course = await createPublishableCourse('snapshot', categoryA.id);
    const v1 = await publish(course.id);
    await goOnline(course.id);

    const version = await getVersion(course.id, v1.versionId);
    expect(version.snapshotData.formatVersion).toBe(3);
    expect(version.snapshotData.course.categoryPath).toEqual([categoryA.name]);
    // 分类 UUID 只是本环境存储编号，不得作为快照里的分类身份
    expect(version.snapshotData.course.categoryId ?? null).toBeNull();
    expect(JSON.stringify(version.snapshotData.course)).not.toContain(
      categoryA.id,
    );

    // 版本详情、Portal 列表/详情投影看到的分类与发布时一致
    expect(await portalCategoryInList(course.code)).toBe(categoryA.name);
    const projected = await portalCourse(course.id);
    expect(projected.category).toBe(categoryA.name);
    expect(projected.categoryLocalized?.['zh-CN']?.name).toBe(
      categoryA.localized['zh-CN'].name,
    );
  });

  it('keeps the live projection and historical preview on A while the unpublished draft is changed to B (C8)', async () => {
    const course = await createPublishableCourse('draft-leak', categoryA.id);
    const v1 = await publish(course.id);
    await goOnline(course.id);

    const updated: SuccessResponse<CourseDetail> = await agent
      .put(`/api/backoffice/courses/${course.id}`)
      .send({ categoryId: categoryB.id })
      .expect(200);
    // 草稿本身已经是 B，且处于"有草稿"状态
    expect(updated.body.data.category?.name).toBe(categoryB.name);
    expect(updated.body.data.hasDraft).toBe(true);

    // 但线上投影必须仍是发布时点的 A：草稿分类不泄漏
    expect(await portalCategoryInList(course.code)).toBe(categoryA.name);
    expect((await portalCourse(course.id)).category).toBe(categoryA.name);
    // 历史版本预览用该版本快照的路径，不是当前行
    expect(await versionPreviewCategory(course.id, v1.versionId)).toBe(
      categoryA.name,
    );
  });

  it('projects B only after the draft category change is published (C8)', async () => {
    const course = await createPublishableCourse('publish-b', categoryA.id);
    await publish(course.id);
    await goOnline(course.id);

    await agent
      .put(`/api/backoffice/courses/${course.id}`)
      .send({ categoryId: categoryB.id })
      .expect(200);
    const v2 = await publish(course.id);

    const version = await getVersion(course.id, v2.versionId);
    expect(version.snapshotData.course.categoryPath).toEqual([categoryB.name]);
    expect(await portalCategoryInList(course.code)).toBe(categoryB.name);
    expect((await portalCourse(course.id)).category).toBe(categoryB.name);
  });

  it('fails Restore with CATEGORY_NOT_FOUND when a v2 snapshot points at a deleted category row, leaving the draft unchanged (C7, I9)', async () => {
    const course = await createPublishableCourse(
      'restore-missing-v2',
      categoryA.id,
    );
    const v1 = await publish(course.id);
    await saveCourseLocalization(course.id, 'Draft title kept');

    // 构造"历史环境里 categoryId 指向已删行"的 v2 快照
    const gone = await createCategory(`Gone ${randomUUID().slice(0, 8)}`);
    const clone = JSON.parse(
      JSON.stringify((await getVersion(course.id, v1.versionId)).snapshotData),
    ) as SnapshotJson;
    clone.course.categoryId = gone.id;
    clone.course.localizations[0].title = 'Snapshot should not apply';
    await prisma.courseCatalogueEntry.delete({ where: { id: gone.id } });
    const bad = await seedVersion(course.id, clone, 'bad-v2', 90);

    const before = await getDetail(course.id);
    expect(before.hasDraft).toBe(true);

    const res = await agent
      .post(`/api/backoffice/courses/${course.id}/restore`)
      .send({ versionId: bad.id });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const failure = res.body as ErrorResponse['body'];
    expect(failure.error.code).toBe('CATEGORY_NOT_FOUND');

    // 失败的 Restore 是原子的：草稿内容、分类与草稿状态都不变
    const after = await getDetail(course.id);
    expect(after.hasDraft).toBe(true);
    expect(after.category?.name).toBe(categoryA.name);
    expect(
      after.localizations.find((loc) => loc.language === 'en-GB')?.title,
    ).toBe('Draft title kept');
  });

  it('fails Restore with CATEGORY_NOT_FOUND when a v3 snapshot categoryPath does not resolve, leaving the draft unchanged (C7, I9)', async () => {
    const course = await createPublishableCourse(
      'restore-missing-v3',
      categoryA.id,
    );
    const v1 = await publish(course.id);
    await saveCourseLocalization(course.id, 'Draft title kept');

    const clone = JSON.parse(
      JSON.stringify((await getVersion(course.id, v1.versionId)).snapshotData),
    ) as SnapshotJson;
    clone.formatVersion = 3;
    clone.course.categoryPath = [`${PREFIX} No Such Category`];
    delete clone.course.categoryId;
    clone.course.localizations[0].title = 'Snapshot should not apply';
    const bad = await seedVersion(course.id, clone, 'bad-v3', 91);

    const res = await agent
      .post(`/api/backoffice/courses/${course.id}/restore`)
      .send({ versionId: bad.id });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const failure = res.body as ErrorResponse['body'];
    expect(failure.error.code).toBe('CATEGORY_NOT_FOUND');

    const after = await getDetail(course.id);
    expect(after.hasDraft).toBe(true);
    expect(after.category?.name).toBe(categoryA.name);
    expect(
      after.localizations.find((loc) => loc.language === 'en-GB')?.title,
    ).toBe('Draft title kept');
  });

  it('treats Restore of the live version as No draft (C9)', async () => {
    const course = await createPublishableCourse('restore-live', categoryA.id);
    const v1 = await publish(course.id);
    await saveCourseLocalization(course.id, 'Edited draft title');
    expect(await hasDraftInList(course.code)).toBe(true);

    await agent
      .post(`/api/backoffice/courses/${course.id}/restore`)
      .send({ versionId: v1.versionId })
      .expect(200);

    // 列表是纯读取（不做内容比较）：显式状态应直接是 No draft
    expect(await hasDraftInList(course.code)).toBe(false);
    expect((await getDetail(course.id)).hasDraft).toBe(false);
  });

  it('treats Restore of an older version as has-draft, resolves its category locally, and Publish clears it to No draft (C7, C9)', async () => {
    const course = await createPublishableCourse('restore-old', categoryA.id);
    const v1 = await publish(course.id);
    await saveCourseLocalization(course.id, 'Second live title');
    await publish(course.id);
    expect(await hasDraftInList(course.code)).toBe(false);

    // 草稿先改成 B，再 Restore 旧版本（快照里是 A，v2 按 categoryId 本地解析）
    await agent
      .put(`/api/backoffice/courses/${course.id}`)
      .send({ categoryId: categoryB.id })
      .expect(200);
    await agent
      .post(`/api/backoffice/courses/${course.id}/restore`)
      .send({ versionId: v1.versionId })
      .expect(200);

    const restored = await getDetail(course.id);
    expect(restored.hasDraft).toBe(true);
    expect(restored.category?.name).toBe(categoryA.name);

    const v3 = await publish(course.id);
    const version = await getVersion(course.id, v3.versionId);
    expect(version.snapshotData.course.categoryPath).toEqual([categoryA.name]);
    expect(await hasDraftInList(course.code)).toBe(false);
    expect((await getDetail(course.id)).hasDraft).toBe(false);
  });

  it('treats an imported course package as has-draft and Publish clears it to No draft (C9)', async () => {
    const course = await createPublishableCourse('import-draft', categoryA.id);
    await publish(course.id);
    expect(await hasDraftInList(course.code)).toBe(false);

    const manifest = buildMinimalManifest({
      courseCode: course.code,
      slug: course.code.toLowerCase(),
      categoryName: categoryA.name,
      title: `${course.code} imported`,
    });
    const jobId = await stageImportJob(course.id, manifest);

    const confirmed: SuccessResponse<{ status: string; courseId: string }> =
      await agent
        .post(`/api/backoffice/courses/import/${jobId}/confirm`)
        .send({ onConflict: 'NEW_VERSION' })
        .expect(200);
    expect(confirmed.body.data.status).toBe('READY');
    expect(confirmed.body.data.courseId).toBe(course.id);

    // 导入整包 = 覆盖草稿（显式的"有草稿"状态）
    expect(await hasDraftInList(course.code)).toBe(true);
    expect((await getDetail(course.id)).hasDraft).toBe(true);

    await publish(course.id);
    expect(await hasDraftInList(course.code)).toBe(false);
    expect((await getDetail(course.id)).hasDraft).toBe(false);
  });

  it('keeps has-draft after the editor changes a value and then changes it back to the live value (C9 / O1)', async () => {
    const course = await createPublishableCourse('revert', categoryA.id);
    await publish(course.id);

    const edited: SuccessResponse<CourseDetail> = await agent
      .put(`/api/backoffice/courses/${course.id}/lessons/${course.lessonId}`)
      .send({ title: 'Edited lesson title' })
      .expect(200);
    expect(edited.body.data.hasDraft).toBe(true);

    await agent
      .put(`/api/backoffice/courses/${course.id}/lessons/${course.lessonId}`)
      .send({ title: 'Lesson 1' })
      .expect(200);

    // O1：显式状态语义——编辑后手动改回原值仍算"有草稿"，不再用内容哈希反推
    expect((await getDetail(course.id)).hasDraft).toBe(true);
    expect(await hasDraftInList(course.code)).toBe(true);
  });

  it('exports a historical version with that version category path, not the current row (C6, C8)', async () => {
    const course = await createPublishableCourse(
      'export-history',
      categoryA.id,
    );
    const v1 = await publish(course.id);

    // 草稿改成 B（未发布）：当前行是 B，但 v1 版本快照是 A
    await agent
      .put(`/api/backoffice/courses/${course.id}`)
      .send({ categoryId: categoryB.id })
      .expect(200);

    const started: SuccessResponse<{
      jobId: string;
      versionId: string | null;
      versionLabel: string;
    }> = await agent
      .post(`/api/backoffice/courses/${course.id}/export`)
      .send({ version: v1.versionLabel })
      .expect(202);
    expect(started.body.data.versionId).toBe(v1.versionId);

    const zipBytes = await waitForExport(started.body.data.jobId);
    const zip = await JSZip.loadAsync(zipBytes);
    const manifestFile = zip.file('manifest.json');
    expect(manifestFile).toBeTruthy();
    const manifest = JSON.parse(await manifestFile!.async('string')) as {
      formatVersion?: number;
      provenance?: { sourceVersionLabel?: string };
      annotations?: { versionLabel?: string };
      course: { category?: string; categoryPath?: string[] };
    };

    // Part C v2（唯一 v2 SSOT）：版本标签在 provenance/annotations 里，而非旧 source 块
    expect(manifest.formatVersion).toBe(2);
    expect(manifest.provenance?.sourceVersionLabel).toBe(v1.versionLabel);
    expect(manifest.annotations?.versionLabel).toBe(v1.versionLabel);
    // 历史版本导出用该版本的分类路径（稳定键序列），不是当前行的 B
    expect(manifest.course.categoryPath).toEqual([categoryA.name]);
    expect(manifest.course.category ?? null).not.toBe(categoryB.name);
    // 导出不得出现任何占位分类
    expect(JSON.stringify(manifest)).not.toMatch(/Uncategorised|Uncategorized/);
  });
});
