import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import type { ErrorResponse, SuccessResponse } from './helpers/http-response';
import { signInAs } from './helpers/employee-session';

/**
 * 课程与分类绑定校验（设计 SSOT：docs/Course_Category_Single_Source_Design.md）。
 *
 * 缝 S3，覆盖：
 * - C3 创建课程：categoryId 必填；不存在 → CATEGORY_NOT_FOUND；
 *   ARCHIVED → CATEGORY_ARCHIVED；层级 >2 → CATEGORY_INVALID_LEVEL。
 * - C4 更新课程：categoryId 置空 → CATEGORY_REQUIRED；不存在 → CATEGORY_NOT_FOUND。
 * - I5 课程只能引用 ACTIVE 分类，层级为一级或二级。
 * - 回归：发布时分类缺失仍被 completeness 拦截（既有行为）。
 *
 * 黑盒边界：行为只经 backoffice HTTP（supertest）观察，不断言私有字段/内部结构。
 * 分类管理没有 HTTP 入口（设计 §2 非目标：分类由开发预置），因此 ARCHIVED、二级、
 * 三级分类这些测试数据只能用数据库直接造；数据库只用于 arrange / cleanup，
 * 所有断言都读 HTTP 响应。
 *
 * 状态码说明：设计 C3/C4 只钉业务错误码，未钉 HTTP 状态码。因此这里按既有错误包络
 * `{success:false,data:null,error:{code,message}}` 严格断言 code，并只要求 4xx，
 * 不臆造具体状态。
 */

const PREFIX = `E2E-CAT-BIND-${Date.now()}`;

interface CategoryFixture {
  id: string;
  name: string;
}

describe('Course category binding validation (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let agent: Awaited<ReturnType<typeof signInAs>>;

  /** 本 spec 通过 HTTP 创建过的课程 code，afterAll 按前缀清理。 */
  const createdCodes: string[] = [];

  let level1: CategoryFixture;
  let level2: CategoryFixture;
  /** 非法的三级节点（一级 → 二级 → 三级），用来验证 I3/I5 的层级上限。 */
  let level3: CategoryFixture;
  let archived: CategoryFixture;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    agent = await signInAs(app, 'ADMIN');

    const toFixture = { id: true, name: true } as const;
    level1 = await prisma.courseCatalogueEntry.create({
      data: {
        name: `${PREFIX} Level One`,
        localized: {
          'en-GB': { name: `${PREFIX} Level One` },
          'zh-CN': { name: `${PREFIX} 一级` },
        },
        status: 'ACTIVE',
        sortOrder: 0,
      },
      select: toFixture,
    });
    level2 = await prisma.courseCatalogueEntry.create({
      data: {
        name: `${PREFIX} Level Two`,
        localized: { 'en-GB': { name: `${PREFIX} Level Two` } },
        parentId: level1.id,
        status: 'ACTIVE',
        sortOrder: 0,
      },
      select: toFixture,
    });
    level3 = await prisma.courseCatalogueEntry.create({
      data: {
        name: `${PREFIX} Level Three`,
        localized: { 'en-GB': { name: `${PREFIX} Level Three` } },
        parentId: level2.id,
        status: 'ACTIVE',
        sortOrder: 0,
      },
      select: toFixture,
    });
    archived = await prisma.courseCatalogueEntry.create({
      data: {
        name: `${PREFIX} Archived`,
        localized: { 'en-GB': { name: `${PREFIX} Archived` } },
        status: 'ARCHIVED',
        sortOrder: 0,
      },
      select: toFixture,
    });
  });

  afterAll(async () => {
    // 清理本 spec 造的数据（best effort：课程事件是 append-only，失败不影响其它测试）。
    await prisma.commerceCourse
      .deleteMany({ where: { code: { startsWith: `${PREFIX}-` } } })
      .catch(() => undefined);
    await prisma.courseCatalogueEntry
      .deleteMany({ where: { name: { startsWith: PREFIX } } })
      .catch(() => undefined);
    await app.close();
  });

  function uniqueCode(label: string): string {
    return `${PREFIX}-${label}`.toUpperCase();
  }

  async function createCourseOk(
    label: string,
    categoryId: string,
  ): Promise<{
    id: string;
    categoryId: string | null;
    category: { id: string; name: string } | null;
  }> {
    const code = uniqueCode(label);
    createdCodes.push(code);
    const res: SuccessResponse<{
      id: string;
      categoryId: string | null;
      category: { id: string; name: string } | null;
    }> = await agent
      .post('/api/backoffice/courses')
      .send({ code, title: `${code} title`, categoryId })
      .expect(201);
    return res.body.data;
  }

  /**
   * C3/C4 的业务错误：严格断言错误码与既有包络；状态码设计未钉，只要求 4xx
   * （2xx/3xx 说明写入被接受了，即为红灯）。
   */
  function expectCategoryError(res: Response, code: string): void {
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = res.body as ErrorResponse['body'];
    expect(body.success).toBe(false);
    expect(body.data).toBeNull();
    expect(body.error.code).toBe(code);
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
  }

  /** 被拒绝的创建不能留下半截课程（黑盒：列表里查不到这个 code）。 */
  async function expectCourseNotCreated(code: string): Promise<void> {
    const listed: SuccessResponse<{ courses: Array<{ code: string }> }> =
      await agent
        .get('/api/backoffice/courses')
        .query({ search: code, pageSize: 100 })
        .expect(200);
    expect(
      listed.body.data.courses.some((course) => course.code === code),
    ).toBe(false);
  }

  // ---- C3 创建 ----

  it('rejects course creation without categoryId with CATEGORY_REQUIRED (C3)', async () => {
    const code = uniqueCode('CREATE-REQUIRED');
    createdCodes.push(code);

    const res: ErrorResponse = await agent
      .post('/api/backoffice/courses')
      .send({ code, title: `${code} title` });

    expectCategoryError(res, 'CATEGORY_REQUIRED');
    await expectCourseNotCreated(code);
  });

  it('rejects course creation pointing at a nonexistent category with CATEGORY_NOT_FOUND (C3)', async () => {
    const code = uniqueCode('CREATE-UNKNOWN');
    createdCodes.push(code);

    const res: ErrorResponse = await agent
      .post('/api/backoffice/courses')
      .send({ code, title: `${code} title`, categoryId: randomUUID() });

    expectCategoryError(res, 'CATEGORY_NOT_FOUND');
    await expectCourseNotCreated(code);
  });

  it('rejects course creation pointing at an ARCHIVED category with CATEGORY_ARCHIVED (C3, I5)', async () => {
    const code = uniqueCode('CREATE-ARCHIVED');
    createdCodes.push(code);

    const res: ErrorResponse = await agent
      .post('/api/backoffice/courses')
      .send({ code, title: `${code} title`, categoryId: archived.id });

    expectCategoryError(res, 'CATEGORY_ARCHIVED');
    await expectCourseNotCreated(code);
  });

  it('rejects course creation pointing at a node deeper than level 2 with CATEGORY_INVALID_LEVEL (C3, I5)', async () => {
    const code = uniqueCode('CREATE-LEVEL3');
    createdCodes.push(code);

    const res: ErrorResponse = await agent
      .post('/api/backoffice/courses')
      .send({ code, title: `${code} title`, categoryId: level3.id });

    expectCategoryError(res, 'CATEGORY_INVALID_LEVEL');
    await expectCourseNotCreated(code);
  });

  // ---- C4 更新 ----

  it('rejects clearing categoryId on update with CATEGORY_REQUIRED and keeps the old category (C4)', async () => {
    const course = await createCourseOk('UPDATE-NULL', level1.id);

    const res: ErrorResponse = await agent
      .put(`/api/backoffice/courses/${course.id}`)
      .send({ categoryId: null });

    expectCategoryError(res, 'CATEGORY_REQUIRED');

    const detail: SuccessResponse<{ categoryId: string | null }> = await agent
      .get(`/api/backoffice/courses/${course.id}`)
      .expect(200);
    expect(detail.body.data.categoryId).toBe(level1.id);
  });

  it('rejects updating categoryId to a nonexistent category with CATEGORY_NOT_FOUND (C4)', async () => {
    const course = await createCourseOk('UPDATE-UNKNOWN', level1.id);

    const res: ErrorResponse = await agent
      .put(`/api/backoffice/courses/${course.id}`)
      .send({ categoryId: randomUUID() });

    expectCategoryError(res, 'CATEGORY_NOT_FOUND');

    const detail: SuccessResponse<{ categoryId: string | null }> = await agent
      .get(`/api/backoffice/courses/${course.id}`)
      .expect(200);
    expect(detail.body.data.categoryId).toBe(level1.id);
  });

  // ---- 合法绑定（C3/C4, I5 正向面） ----

  it('accepts an ACTIVE level-1 category on create and echoes the category ref (C3, I5)', async () => {
    const code = uniqueCode('CREATE-LEVEL1');
    createdCodes.push(code);

    const res: SuccessResponse<{
      categoryId: string | null;
      category: { id: string; name: string } | null;
    }> = await agent
      .post('/api/backoffice/courses')
      .send({ code, title: `${code} title`, categoryId: level1.id })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.categoryId).toBe(level1.id);
    expect(res.body.data.category?.name).toBe(level1.name);
  });

  it('accepts an ACTIVE level-2 category on update and echoes the category ref (C4, I5)', async () => {
    const course = await createCourseOk('UPDATE-LEVEL2', level1.id);

    const res: SuccessResponse<{
      categoryId: string | null;
      category: { id: string; name: string } | null;
    }> = await agent
      .put(`/api/backoffice/courses/${course.id}`)
      .send({ categoryId: level2.id })
      .expect(200);

    expect(res.body.data.categoryId).toBe(level2.id);
    expect(res.body.data.category?.name).toBe(level2.name);
  });

  // ---- 发布回归（既有行为） ----

  it('still blocks publishing when the course has no category (C3 regression: category required)', async () => {
    const course = await createCourseOk('PUBLISH-NO-CATEGORY', level1.id);
    // 存量课程可能没有分类（M3 背填不中时保持 NULL）。C3/C4 落地后创建/更新都不再允许
    // 出现无分类课程，所以这里直接改库模拟存量数据；断言仍全部走 HTTP。
    await prisma.commerceCourse.update({
      where: { id: course.id },
      data: { categoryId: null },
    });

    const detail: SuccessResponse<{
      completeness: {
        steps: { courseInformation: { missing: string[] } };
      };
    }> = await agent.get(`/api/backoffice/courses/${course.id}`).expect(200);
    expect(
      detail.body.data.completeness.steps.courseInformation.missing,
    ).toContain('Category is required.');

    const res: ErrorResponse = await agent
      .post(`/api/backoffice/courses/${course.id}/publish`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PUBLISH_BLOCKED');
    expect(res.body.error.message).toContain(
      'Complete Course Information first.',
    );

    // 拦截后没有生成线上版本。
    const after: SuccessResponse<{ liveVersionId: string | null }> = await agent
      .get(`/api/backoffice/courses/${course.id}`)
      .expect(200);
    expect(after.body.data.liveVersionId).toBeNull();
  });
});
