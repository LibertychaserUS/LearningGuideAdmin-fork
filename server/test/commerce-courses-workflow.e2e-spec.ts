import type { SuccessResponse, ErrorResponse } from './helpers/http-response';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PublishingService } from '../src/commerce-courses/publishing.service';
import { PrismaService } from '../src/prisma/prisma.service';
import request from 'supertest';
import {
  E2E_PASSWORD,
  ensureEmployee,
  resetRateLimits,
  signInAs,
} from './helpers/employee-session';

/**
 * 商品课程发布与课时编辑的幂等与原子性：重复点"发布""删除草稿"（或两人同时点）
 * 只生成一个版本、只执行一次；课时并发新建、改成重复 code、重复删除、跨课程排序都不返回 500。
 */
describe('Commerce course workflow (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const code = `E2E-WF-${Date.now()}`;
  /** C3：创建课程必须带 ACTIVE 分类；预置 Society 由迁移幂等补种。 */
  let categoryId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    const society = await prisma.courseCatalogueEntry.findFirstOrThrow({
      where: { parentId: null, name: 'Society', status: 'ACTIVE' },
      select: { id: true },
    });
    categoryId = society.id;
  });

  afterAll(async () => {
    const courses = await prisma.commerceCourse.findMany({
      where: {
        code: {
          in: [code, `${code}-L`, `${code}-O`, `${code}-P`, `${code}-H`],
        },
      },
    });
    for (const course of courses) {
      await prisma.commerceCourse.update({
        where: { id: course.id },
        data: { liveVersionId: null },
      });
      await prisma.courseVersion.deleteMany({ where: { courseId: course.id } });
      await prisma.commerceCourse
        .delete({ where: { id: course.id } })
        .catch(() => undefined);
    }
    await app.close();
  });

  it('lists each category with its name in every language from the database', async () => {
    const agent = await signInAs(app, 'ADMIN');
    const listed: SuccessResponse<
      Array<{ name: string; localized: Record<string, { name?: string }> }>
    > = await agent.get('/api/backoffice/courses/categories').expect(200);
    const society = listed.body.data.find((c) => c.name === 'Society');
    expect(society?.localized).toEqual({
      'en-GB': { name: 'Society' },
      'zh-CN': { name: '社会' },
    });
  });

  it('publishes once when Publish is pressed twice at the same time', async () => {
    const agent = await signInAs(app, 'ADMIN');
    const created: SuccessResponse<{ id: string }> = await agent
      .post('/api/backoffice/courses')
      .send({ code: `${code}-P`, title: 'Publish e2e', categoryId });
    const id: string = created.body.data.id;
    await agent
      .post(`/api/backoffice/courses/${id}/lessons`)
      .send({ title: 'One' })
      .expect(201);

    // 内容完成度不是这里要测的：放行，并让两个请求都过了完成度检查再一起往下走，
    // 这样旧代码里两边一定都读到"还没有版本"，各自用 versionNo=1 去写。
    const publishing = app.get(PublishingService);
    let arrived = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => (release = resolve));
    const spy = jest
      .spyOn(publishing, 'completenessForDraft')
      .mockImplementation(async () => {
        arrived += 1;
        if (arrived === 2) release();
        await bothArrived;
        return { canPublish: true, publishBlockers: [] } as never;
      });
    try {
      const both = await Promise.all([
        agent.post(`/api/backoffice/courses/${id}/publish`).send({}),
        agent.post(`/api/backoffice/courses/${id}/publish`).send({}),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
      const conflict: ErrorResponse = both.find((r) => r.status === 409)!;
      expect(conflict.body.error.code).toBe('NO_DRAFT');
      expect(
        await prisma.courseVersion.count({ where: { courseId: id } }),
      ).toBe(1);
      expect(
        await prisma.courseAuthoringActivity.count({
          where: { courseId: id, action: 'PUBLISH' },
        }),
      ).toBe(1);

      // 再点一次：草稿已发布，409，不多出版本
      const again: ErrorResponse = await agent
        .post(`/api/backoffice/courses/${id}/publish`)
        .send({});
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('NO_DRAFT');
      expect(
        await prisma.courseVersion.count({ where: { courseId: id } }),
      ).toBe(1);

      // 改动后再发布：版本号顺延到 2
      await agent
        .post(`/api/backoffice/courses/${id}/lessons`)
        .send({ title: 'Two' })
        .expect(201);
      const second: SuccessResponse<{ versionNo: number }> = await agent
        .post(`/api/backoffice/courses/${id}/publish`)
        .send({});
      expect(second.status).toBe(200);
      expect(second.body.data.versionNo).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps has-draft after editing a value back to the live content (C9 / O1)', async () => {
    const agent = await signInAs(app, 'ADMIN');
    const created: SuccessResponse<{ id: string }> = await agent
      .post('/api/backoffice/courses')
      .send({ code: `${code}-H`, title: `${code} fingerprint`, categoryId });
    const id: string = created.body.data.id;
    const lesson: SuccessResponse<{ lessons: { id: string }[] }> = await agent
      .post(`/api/backoffice/courses/${id}/lessons`)
      .send({ title: 'One' })
      .expect(201);
    const lessonId = lesson.body.data.lessons[0].id;

    const publishing = app.get(PublishingService);
    const spy = jest
      .spyOn(publishing, 'completenessForDraft')
      .mockResolvedValue({ canPublish: true, publishBlockers: [] } as never);
    try {
      await agent
        .post(`/api/backoffice/courses/${id}/publish`)
        .send({})
        .expect(200);
      const v1 = await prisma.courseVersion.findFirstOrThrow({
        where: { courseId: id },
      });
      // 诊断指纹仍保留（不参与 No draft/版本身份；C9/C0 红线）。
      expect(v1.contentHash).toMatch(/^[0-9a-f]{64}$/);

      // 改了再改回原样：显式状态语义（O1）——仍然是有草稿；
      // 内容比较/指纹不再参与 No draft。
      const edited: SuccessResponse<{ hasDraft: boolean }> = await agent
        .put(`/api/backoffice/courses/${id}/lessons/${lessonId}`)
        .send({ title: 'Uno' });
      expect(edited.body.data.hasDraft).toBe(true);
      const reverted: SuccessResponse<{ hasDraft: boolean }> = await agent
        .put(`/api/backoffice/courses/${id}/lessons/${lessonId}`)
        .send({ title: 'One' });
      expect(reverted.body.data.hasDraft).toBe(true);
      const detail: SuccessResponse<{ hasDraft: boolean }> = await agent.get(
        `/api/backoffice/courses/${id}`,
      );
      expect(detail.body.data.hasDraft).toBe(true);

      // C9：有草稿就生成新版本（无论内容是否与线上相同）；发布后 No draft。
      const republished: SuccessResponse<{ versionNo: number }> = await agent
        .post(`/api/backoffice/courses/${id}/publish`)
        .send({})
        .expect(200);
      expect(republished.body.data.versionNo).toBe(2);
      const afterPublish = await prisma.commerceCourse.findUniqueOrThrow({
        where: { id },
      });
      expect(afterPublish.hasDraft).toBe(false);
      // C9：发布冻结 liveBaseRevision = draftRevision。
      expect(afterPublish.draftRevision).toBe(afterPublish.liveBaseRevision);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps course events append-only, each with its transaction id', async () => {
    const course = await prisma.commerceCourse.findFirstOrThrow({
      where: { code: `${code}-H` },
    });
    const event = await prisma.courseAuthoringActivity.findFirstOrThrow({
      where: { courseId: course.id, action: 'PUBLISH' },
    });
    expect(event.txid > 0n).toBe(true);
    await expect(
      prisma.courseAuthoringActivity.update({
        where: { id: event.id },
        data: { detail: { edited: true } },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.courseAuthoringActivity.delete({ where: { id: event.id } }),
    ).rejects.toThrow(/append-only/);
    expect(
      await prisma.courseAuthoringActivity.count({ where: { id: event.id } }),
    ).toBe(1);
  });

  it('refuses a draft write from a page opened before someone else saved (PRD 23)', async () => {
    const alice = await signInAs(app, 'ADMIN');
    const bobEmail = await ensureEmployee('e2e-admin-bob@example.com', 'ADMIN');
    resetRateLimits();
    const bob = request.agent(app.getHttpServer());
    await bob
      .post('/api/auth/sign-in')
      .send({ email: bobEmail, password: E2E_PASSWORD })
      .expect(200);

    const created: SuccessResponse<{ id: string }> = await alice
      .post('/api/backoffice/courses')
      .send({ code: `${code}-R`, title: `${code} revision`, categoryId });
    expect(created.body).toMatchObject({ error: null });
    const id: string = created.body.data.id;
    const lesson: SuccessResponse<{ lessons: { id: string }[] }> = await alice
      .post(`/api/backoffice/courses/${id}/lessons`)
      .send({ title: 'One' })
      .expect(201);
    const lessonId = lesson.body.data.lessons[0].id;
    const url = `/api/backoffice/courses/${id}/lessons/${lessonId}`;

    // 两人同时打开课程，拿到同一个 ETag
    const opened = await alice.get(`/api/backoffice/courses/${id}`).expect(200);
    const etag = opened.headers.etag;
    expect(etag).toMatch(/^"r\d+"$/);
    await bob.get(`/api/backoffice/courses/${id}`).expect(200);

    // Alice 同一页面并行保存两处：都成功
    const saves = await Promise.all([
      alice.put(url).set('If-Match', etag).send({ title: 'Uno' }),
      alice.put(url).set('If-Match', etag).send({ description: 'First' }),
    ]);
    expect(saves.map((r) => r.status)).toEqual([200, 200]);

    // Bob 用打开时的 ETag 保存：409，提示刷新
    const stale: ErrorResponse = await bob
      .put(url)
      .set('If-Match', etag)
      .send({ title: 'Eins' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('COURSE_STALE');
    expect(stale.body.error.message).toContain('Refresh');

    // 刷新后用新 ETag 保存：成功
    const refreshed = await bob.get(`/api/backoffice/courses/${id}`);
    const fresh = refreshed.headers.etag;
    const ok = await bob
      .put(url)
      .set('If-Match', fresh)
      .send({ title: 'Eins' });
    expect(ok.status).toBe(200);
    expect(ok.headers.etag).not.toBe(fresh);

    // 失败的写入不占 revision：之后用同一个 ETag 仍能保存
    const current = ok.headers.etag;
    await bob
      .put(
        `/api/backoffice/courses/${id}/lessons/00000000-0000-0000-0000-000000000000`,
      )
      .set('If-Match', current)
      .send({ title: 'Nobody' })
      .expect(404);
    await alice
      .get(`/api/backoffice/courses/${id}`)
      .expect(200)
      .expect('ETag', current);
  });

  it('deletes a draft once when Delete draft is pressed twice at the same time', async () => {
    const agent = await signInAs(app, 'ADMIN');
    const course = await prisma.commerceCourse.findFirstOrThrow({
      where: { code: `${code}-P` },
    });
    const id = course.id;
    await agent
      .post(`/api/backoffice/courses/${id}/lessons`)
      .send({ title: 'Draft only' })
      .expect(201);
    expect(
      (await prisma.commerceCourse.findUniqueOrThrow({ where: { id } }))
        .hasDraft,
    ).toBe(true);

    const both = await Promise.all([
      agent.post(`/api/backoffice/courses/${id}/delete-draft`).send({}),
      agent.post(`/api/backoffice/courses/${id}/delete-draft`).send({}),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await prisma.courseAuthoringActivity.count({
        where: { courseId: id, action: 'DELETE_DRAFT' },
      }),
    ).toBe(1);
    const after = await prisma.commerceCourse.findUniqueOrThrow({
      where: { id },
    });
    expect(after.hasDraft).toBe(false);
    // 草稿课时被线上版本（2 节课）覆盖掉
    expect(
      await prisma.lesson.count({ where: { courseId: id, archivedAt: null } }),
    ).toBe(2);
  });

  it('keeps lesson edits consistent under double clicks', async () => {
    const agent = await signInAs(app, 'ADMIN');
    const created: SuccessResponse<{ id: string }> = await agent
      .post('/api/backoffice/courses')
      .send({ code: `${code}-L`, title: 'Lessons e2e', categoryId });
    const id: string = created.body.data.id;

    // 同时新建两节课：序号和默认 code 各不相同
    const made = await Promise.all([
      agent
        .post(`/api/backoffice/courses/${id}/lessons`)
        .send({ title: 'One' }),
      agent
        .post(`/api/backoffice/courses/${id}/lessons`)
        .send({ title: 'Two' }),
    ]);
    expect(made.map((r) => r.status)).toEqual([201, 201]);
    const lessons = await prisma.lesson.findMany({
      where: { courseId: id },
      orderBy: { sortOrder: 'asc' },
    });
    expect(lessons.map((l) => l.sortOrder)).toEqual([1, 2]);
    expect(new Set(lessons.map((l) => l.code)).size).toBe(2);

    // 改成另一节课已有的 code：409，标题也不会被写进去
    // （两次新建谁先拿到锁不固定，所以先记下第二节课原来的标题）
    const before = await prisma.lessonLocalization.findFirstOrThrow({
      where: { lessonId: lessons[1].id },
    });
    const dup: ErrorResponse = await agent
      .put(`/api/backoffice/courses/${id}/lessons/${lessons[1].id}`)
      .send({ code: lessons[0].code, title: 'Should not stick' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('LESSON_CODE_DUPLICATE');
    const title = await prisma.lessonLocalization.findFirst({
      where: { lessonId: lessons[1].id },
    });
    expect(title?.title).toBe(before.title);

    // 重复删除：一次 200，一次 404
    const deletes = await Promise.all([
      agent.delete(`/api/backoffice/courses/${id}/lessons/${lessons[1].id}`),
      agent.delete(`/api/backoffice/courses/${id}/lessons/${lessons[1].id}`),
    ]);
    expect(deletes.map((r) => r.status).sort()).toEqual([200, 404]);
  });

  it('refuses to reorder lessons that belong to another course', async () => {
    const agent = await signInAs(app, 'ADMIN');
    const mine: SuccessResponse<{ id: string }> = await agent
      .post('/api/backoffice/courses')
      .send({ code: `${code}-O`, title: 'Order e2e', categoryId });
    const other = await prisma.commerceCourse.findFirst({
      where: { code: `${code}-L` },
    });
    const myId: string = mine.body.data.id;
    await agent
      .post(`/api/backoffice/courses/${myId}/lessons`)
      .send({ title: 'Mine' });
    const myLesson = await prisma.lesson.findFirstOrThrow({
      where: { courseId: myId },
    });
    const otherLesson = await prisma.lesson.findFirstOrThrow({
      where: { courseId: other!.id },
    });

    const res = await agent
      .put(`/api/backoffice/courses/${myId}/lessons/reorder`)
      .send({ lessonIds: [myLesson.id, otherLesson.id] });
    expect(res.status).toBe(404);
    const untouched = await prisma.lesson.findUniqueOrThrow({
      where: { id: otherLesson.id },
    });
    expect(untouched.sortOrder).toBe(otherLesson.sortOrder);
    const unchanged = await prisma.lesson.findUniqueOrThrow({
      where: { id: myLesson.id },
    });
    expect(unchanged.sortOrder).toBe(myLesson.sortOrder);

    await agent
      .put(`/api/backoffice/courses/${myId}/lessons/reorder`)
      .send({})
      .expect(400);
  });

  it('imports a confirmed package at most once and never cancels one that is importing', async () => {
    const agent = await signInAs(app, 'ADMIN');
    const job = await prisma.coursePackageJob.create({
      data: {
        kind: 'IMPORT',
        status: 'AWAITING_CONFIRM',
        sourceFileName: 'e2e.zip',
      },
    });
    // 让两次确认都先读到 AWAITING_CONFIRM 再往下走：并发窗口在本机只有一两毫秒，
    // 不卡住就很难撞上。旧代码（先查再改）在这里会两次都开始导入，没有 409。
    // 只拦确认接口里的读（看调用栈），别的地方读同一任务照常放行。
    const delegate = prisma.coursePackageJob;
    const original: typeof delegate.findUnique =
      delegate.findUnique.bind(delegate);
    let arrived = 0;
    let done = 0;
    let release: () => void = () => undefined;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    const spy = jest.spyOn(delegate, 'findUnique').mockImplementation(((
      args: Parameters<typeof original>[0],
    ) => {
      const read = original(args);
      const fromConfirm = new Error().stack?.includes('confirmImport');
      if (args.where.id !== job.id || !fromConfirm || arrived >= 2) return read;
      arrived += 1;
      // 两次读都拿到结果之后才一起放行，保证两边看到的都是 AWAITING_CONFIRM
      return read.then(async (row) => {
        done += 1;
        if (done === 2) release();
        await bothRead;
        return row;
      });
    }) as unknown as typeof delegate.findUnique);
    try {
      const confirms = await Promise.all([
        agent
          .post(`/api/backoffice/courses/import/${job.id}/confirm`)
          .send({ onConflict: 'ABORT' }),
        agent
          .post(`/api/backoffice/courses/import/${job.id}/confirm`)
          .send({ onConflict: 'ABORT' }),
      ]);
      // 只有一次能认领任务；另一次 409。认领到的那次因为暂存文件不存在而失败，这里不关心
      expect(arrived).toBe(2);
      expect(confirms.filter((r) => r.status === 409)).toHaveLength(1);
      spy.mockRestore();

      await prisma.coursePackageJob.update({
        where: { id: job.id },
        data: { status: 'IMPORTING' },
      });
      await agent
        .post(`/api/backoffice/courses/import/${job.id}/cancel`)
        .expect(409);
      const after = await prisma.coursePackageJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(after.status).toBe('IMPORTING');
    } finally {
      spy.mockRestore();
      await prisma.coursePackageJob.delete({ where: { id: job.id } });
    }
  });
});
