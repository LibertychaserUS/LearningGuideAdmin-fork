import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { CourseStorageService } from '../src/commerce-courses/storage.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { signInAs } from './helpers/employee-session';

/**
 * 缝 C10.7：环境能力矩阵（设计 SSOT §14 C10.7）。
 *
 * - 休眠开关 ENV_CAPABILITY_ENFORCEMENT 默认 off：Production 下 authoring 照常可用
 *   （UAT 即生产，部署后不能锁死编辑）。
 * - on：Production 下内容编辑/新建 → 403 CAPABILITY_DISABLED；import / publish /
 *   live-status 不被能力门拦截；Sandbox 下 authoring 可用。
 * - 环境由服务端配置（VERSION_NUMBERING_MODE）判定，不信任客户端。
 *
 * 黑盒边界：只经 backoffice HTTP 观察；Prisma 仅用于取预置分类 id 与清理。
 */

const PREFIX = `E2E-CAP-${Date.now()}`;

interface ErrorBody {
  success: boolean;
  data: null;
  error: { code: string; message: string };
}

describe('C10.7 environment capability matrix (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let categoryId: string;
  const createdCodes: string[] = [];

  async function buildApp(env: {
    numbering: 'sandbox' | 'production';
    enforcement: 'on' | 'off';
  }): Promise<INestApplication<App>> {
    process.env.VERSION_NUMBERING_MODE = env.numbering;
    process.env.ENV_CAPABILITY_ENFORCEMENT = env.enforcement;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const created = moduleFixture.createNestApplication();
    configureApp(created);
    await created.init();
    return created;
  }

  beforeAll(async () => {
    app = await buildApp({ numbering: 'production', enforcement: 'off' });
    prisma = app.get(PrismaService);
    const society = await prisma.courseCatalogueEntry.findFirstOrThrow({
      where: { parentId: null, name: 'Society', status: 'ACTIVE' },
      select: { id: true },
    });
    categoryId = society.id;
  });

  afterAll(async () => {
    delete process.env.ENV_CAPABILITY_ENFORCEMENT;
    delete process.env.VERSION_NUMBERING_MODE;
    await prisma.commerceCourse
      .deleteMany({ where: { code: { startsWith: `${PREFIX}-` } } })
      .catch(() => undefined);
    await app.close();
  });

  it('dormant (default off): production still allows course authoring', async () => {
    const agent = await signInAs(app, 'ADMIN');
    const code = `${PREFIX}-DORMANT`;
    createdCodes.push(code);
    await agent
      .post('/api/backoffice/courses')
      .send({ code, title: `${code} title`, categoryId })
      .expect(201);
  });

  it('enforced in production: authoring → 403 CAPABILITY_DISABLED; import/publish/status are not capability-blocked', async () => {
    const enforced = await buildApp({
      numbering: 'production',
      enforcement: 'on',
    });
    try {
      const agent = await signInAs(enforced, 'ADMIN');
      const code = `${PREFIX}-BLOCKED`;
      createdCodes.push(code);
      const blocked = await agent
        .post('/api/backoffice/courses')
        .send({ code, title: `${code} title`, categoryId });
      expect(blocked.status).toBe(403);
      expect((blocked.body as ErrorBody).error.code).toBe(
        'CAPABILITY_DISABLED',
      );

      // 唯一内容写路径 = 导入包：import 不被能力门拦截（无文件时是 400 校验错误）。
      const importRes = await agent.post('/api/backoffice/courses/import');
      expect(importRes.status).not.toBe(403);

      // publish / status 允许（未知课程 → 404/409，而不是能力 403）。
      const publishRes = await agent
        .post(`/api/backoffice/courses/${code}/publish`)
        .send({});
      expect(publishRes.status).not.toBe(403);
      const statusRes = await agent
        .post(`/api/backoffice/courses/${code}/live-status`)
        .send({ status: 'ONLINE', reason: 'capability e2e' });
      expect(statusRes.status).not.toBe(403);

      // 评审阻断 7：`:id/import` 与同域 import 子路径必须是 course.import，
      // 不能在能力强制下被误判为 authoring（否则 Production 无法导入）。
      for (const path of [
        `/api/backoffice/courses/${code}/import`,
        `/api/backoffice/courses/${code}/readings/import`,
        `/api/backoffice/courses/${code}/understanding/import`,
      ]) {
        const res = await agent.post(path).send({});
        expect(res.status).not.toBe(403);
      }
      const restoreRes = await agent
        .post(`/api/backoffice/courses/${code}/restore`)
        .send({ versionId: 'unknown-version' });
      expect(restoreRes.status).not.toBe(403);

      // 对齐人签收是发布门的人签：Production 允许 publish，故不得 403
      // （未知课程 → 404 COURSE_NOT_FOUND，而不是能力 403）。
      const signOffRes = await agent
        .post(`/api/backoffice/courses/${code}/partc/alignments/aln-x/sign-off`)
        .send({ decision: 'verified' });
      expect(signOffRes.status).not.toBe(403);

      // 复核 operations 路由：运营位不是课程内容（C10.7 将 operations 列为
      // Production 可用），不能落进课程能力门。
      const operationsRes = await agent
        .put('/api/backoffice/operations/popular-courses')
        .send({ items: [] });
      expect(operationsRes.status).toBe(200);
    } finally {
      await enforced.close();
    }
  });

  it('enforced in sandbox: authoring still works', async () => {
    delete process.env.VERSION_NUMBERING_MODE;
    const sandbox = await buildApp({ numbering: 'sandbox', enforcement: 'on' });
    try {
      const agent = await signInAs(sandbox, 'ADMIN');
      const code = `${PREFIX}-SANDBOX`;
      createdCodes.push(code);
      await agent
        .post('/api/backoffice/courses')
        .send({ code, title: `${code} title`, categoryId })
        .expect(201);
    } finally {
      await sandbox.close();
    }
  });

  it('C10.6 enforcement on: production import rejects non-sandbox provenance with PACKAGE_SOURCE_NOT_ALLOWED', async () => {
    process.env.PACKAGE_SOURCE_ENFORCEMENT = 'on';
    const enforced = await buildApp({
      numbering: 'production',
      enforcement: 'off',
    });
    try {
      const agent = await signInAs(enforced, 'ADMIN');
      const storage = enforced.get(CourseStorageService);
      const prismaService = enforced.get(PrismaService);
      const code = `${PREFIX}-PROVENANCE`;
      createdCodes.push(code);
      const manifest = {
        format: 'lg-course-package',
        formatVersion: 2,
        packageId: `pkg_${randomUUID()}`,
        exportedAt: new Date().toISOString(),
        source: {},
        incomplete: false,
        course: {
          code,
          slug: code.toLowerCase(),
          categoryPath: null,
          learningMode: 'TEXT_ONLY',
          learningLanguages: ['en-GB'],
          defaultContentLanguage: 'en-GB',
          localized: { 'en-GB': { title: `${code} title` } },
          lessons: [],
        },
      };
      const job = await prismaService.coursePackageJob.create({
        data: {
          kind: 'IMPORT',
          status: 'AWAITING_CONFIRM',
          sourceFileName: 'provenance-e2e.zip',
        },
        select: { id: true },
      });
      await storage.putStaging(
        storage.stagingKey(job.id, '__manifest.json'),
        Buffer.from(JSON.stringify(manifest), 'utf8'),
      );
      const res = await agent
        .post(`/api/backoffice/courses/import/${job.id}/confirm`)
        .send({ onConflict: 'ABORT' });
      expect(res.status).toBe(422);
      expect((res.body as ErrorBody).error.code).toBe(
        'PACKAGE_SOURCE_NOT_ALLOWED',
      );
      const after = await prismaService.coursePackageJob.findUniqueOrThrow({
        where: { id: job.id },
        select: { status: true },
      });
      expect(after.status).toBe('FAILED');
      await prismaService.coursePackageJob.delete({ where: { id: job.id } });
      await storage.clearStagingPrefix(job.id);
    } finally {
      delete process.env.PACKAGE_SOURCE_ENFORCEMENT;
      await enforced.close();
    }
  });

  it('C10.6 enforcement on: a legacy-shaped package with forged sandbox provenance is still rejected (strict v2 contract gate)', async () => {
    process.env.PACKAGE_SOURCE_ENFORCEMENT = 'on';
    const enforced = await buildApp({
      numbering: 'production',
      enforcement: 'off',
    });
    try {
      const agent = await signInAs(enforced, 'ADMIN');
      const storage = enforced.get(CourseStorageService);
      const prismaService = enforced.get(PrismaService);
      const code = `${PREFIX}-FORGED`;
      createdCodes.push(code);
      // legacy 聚合形状（course.lessons 而非 Part C v2 的 courseKey/content）
      // 加上一份语法完整的伪造 provenance：旧实现在来源门只读 sourceEnv，
      // 会放行并交给 legacy importer；严格 v2 契约校验必须整体拒绝。
      const manifest = {
        format: 'lg-course-package',
        formatVersion: 2,
        packageId: `pkg_${randomUUID()}`,
        exportedAt: new Date().toISOString(),
        source: {},
        incomplete: false,
        provenance: {
          sourceEnv: 'sandbox',
          sourceVersionLabel: '4.2',
          exportedAt: '2026-11-12T08:00:00Z',
          exportedBy: 'forger@example.com',
          courseKey: code,
          planPin: {
            planId: `plan/${code}/cv-1/target-default/v1`,
            planVersion: 1,
          },
          approvalRef: 'APPROVED-FORGED',
          auditSummaryRef: `audit/${code}/4.2.json`,
        },
        course: {
          code,
          slug: code.toLowerCase(),
          categoryPath: null,
          learningMode: 'TEXT_ONLY',
          learningLanguages: ['en-GB'],
          defaultContentLanguage: 'en-GB',
          localized: { 'en-GB': { title: `${code} title` } },
          lessons: [],
        },
      };
      const job = await prismaService.coursePackageJob.create({
        data: {
          kind: 'IMPORT',
          status: 'AWAITING_CONFIRM',
          sourceFileName: 'forged-provenance-e2e.zip',
        },
        select: { id: true },
      });
      await storage.putStaging(
        storage.stagingKey(job.id, '__manifest.json'),
        Buffer.from(JSON.stringify(manifest), 'utf8'),
      );
      const res = await agent
        .post(`/api/backoffice/courses/import/${job.id}/confirm`)
        .send({ onConflict: 'ABORT' });
      expect(res.status).toBe(422);
      expect((res.body as ErrorBody).error.code).toBe(
        'PACKAGE_SOURCE_NOT_ALLOWED',
      );
      const after = await prismaService.coursePackageJob.findUniqueOrThrow({
        where: { id: job.id },
        select: { status: true },
      });
      expect(after.status).toBe('FAILED');
      // 伪造 provenance 的 legacy 包绝不能落任何课程。
      const course = await prismaService.commerceCourse.findFirst({
        where: { code },
        select: { id: true },
      });
      expect(course).toBeNull();
      await prismaService.coursePackageJob.delete({ where: { id: job.id } });
      await storage.clearStagingPrefix(job.id);
    } finally {
      delete process.env.PACKAGE_SOURCE_ENFORCEMENT;
      await enforced.close();
    }
  });
});
