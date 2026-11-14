/**
 * 阶段 D：真实验证（独立 scratch 库 learning_guide_example）。
 *
 * 目标：用**真实导入服务与 HTTP 端点**（不是编译器单测）导入 lite 示范包，
 * 断言：READY、时间由字幕/章节机器派生、provenance 被记录、无时间列/哈希、
 * 9 个 F4 坏包全部 fail-closed 拒绝且无副作用。
 *
 * 运行（必须在 server/ 下，DATABASE_URL 指向 scratch 库）：
 *   DATABASE_URL="postgresql://admin:admin@localhost:5432/learning_guide_example" \
 *   node --experimental-vm-modules node_modules/jest/bin/jest.js \
 *     --config /tmp/phase-d/jest-e2e.json --runInBand
 *
 * 本文件只读实现代码，不修改 Admin/Portal。
 *
 * 2026-11-13 fix3 后实测结论：示范包（manifest 携带 verified 对齐，符合规格 §3）
 * 在**新环境首次导入**时为 READY。导入适配层先以 proposed 行满足
 * `pc_alignment_creation_guard`（provenance≠human 创建时必须 proposed），再在
 * 同一事务内写回包内 verified 审计元组（更新不受创建触发器限制），因此 C10.2
 * 「同 assetKey+assetVersion、锚点未变则保持 verified」成立。
 * 历史：修复前该路径被 20261112070000 的创建触发器阻断（HTTP 500，事务回滚）。
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import type { Response } from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../../../../server/src/app.module';
import { configureApp } from '../../../../server/src/common/app-setup';
import { PrismaService } from '../../../../server/src/prisma/prisma.service';
import { signInAs } from '../../../../server/test/helpers/employee-session';

jest.setTimeout(900_000);

const SERVER_ROOT = path.resolve(__dirname, '../../../../server');
const EXAMPLE_ROOT = path.resolve(__dirname, '..');
const LITE_ZIP = path.join(EXAMPLE_ROOT, 'lite/modeling-life-v2-lite.lgcourse.zip');
const F4_DIR = path.join(SERVER_ROOT, 'test/fixtures/longrange/F4_bad_packages');
const STAGING_ROOT = path.resolve(
  process.env.COURSE_PACKAGE_ROOT?.trim() || 'storage/course-package',
);

const COURSE_KEY = 'modeling-life';
const HASH_KEY_PATTERN = /sha[-_]?256|sha1|md5|hash|digest|checksum|fingerprint/i;
const TIME_COLUMN_PATTERN =
  /(?:^|[^a-z])(?:times?|timestamps?|durations?|seconds?|minutes?|clock|ms|start|end|trigger|时间|时长|秒|分钟|开始|结束|触发)(?:[^a-z]|$)|mm:ss|hh:mm/i;
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

interface JobView {
  jobId: string;
  status: string;
  error: string | null;
  courseId: string | null;
  package: { courseCode: string } | null;
  report: {
    errors: Array<{ code: string; message: string; path?: string }>;
    warnings: Array<{ code: string; message: string; path?: string }>;
  };
}

function dataOf<T>(res: Response): T {
  return (res.body as { data: T }).data;
}

function errorCode(response: Response): string {
  return (response.body as { error?: { code?: string } }).error?.code ?? '';
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

function readWorkbookHeaders(bytes: Buffer): Record<string, string[]> {
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  const headers: Record<string, string[]> = {};
  for (const name of workbook.SheetNames) {
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], {
      header: 1,
      defval: null,
      raw: true,
    });
    headers[name] = (matrix[0] ?? []).map((cell) => String(cell ?? ''));
  }
  return headers;
}

describe('Phase D: import the Modeling life v2 lite package into a scratch DB', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let agent: Awaited<ReturnType<typeof signInAs>>;
  let importedCourseId = '';
  let importedJobId = '';
  let importedUnbound = 0;
  const createdJobIds: string[] = [];
  const log: string[] = [];

  const note = (line: string): void => {
    log.push(line);
    // eslint-disable-next-line no-console
    console.log(`[PHASE-D] ${line}`);
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    // scratch 库由运行脚本在每次执行前 drop/create + migrate（冻结工件不可 TRUNCATE）。
    agent = await signInAs(app, 'ADMIN');
    note(
      `database=${(await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`)[0]?.current_database}`,
    );
  });

  afterAll(async () => {
    for (const jobId of createdJobIds) {
      await prisma.coursePackageJob
        .deleteMany({ where: { id: jobId } })
        .catch(() => undefined);
      await fs
        .rm(path.join(STAGING_ROOT, jobId), { recursive: true, force: true })
        .catch(() => undefined);
    }
    await app.close();
    // 证据摘录：整段日志写进 /tmp，便于报告引用。
    await fs
      .writeFile('/tmp/phase-d/verify-phase-d.log', log.join('\n'), 'utf8')
      .catch(() => undefined);
  });

  async function getJob(jobId: string): Promise<JobView> {
    const res = await agent
      .get(`/api/backoffice/courses/import/${jobId}`)
      .expect(200);
    return dataOf<JobView>(res);
  }

  async function uploadPackage(bytes: Buffer, name: string) {
    return agent.post('/api/backoffice/courses/import').attach('file', bytes, {
      filename: name,
      contentType: 'application/zip',
    });
  }

  it('package redlines hold on the real zip bytes (no hash, no time column, no UUID, closed)', async () => {
    const zipBytes = await fs.readFile(LITE_ZIP);
    const zip = await JSZip.loadAsync(zipBytes);
    expect(Object.keys(zip.files)).not.toContain('timing.json');
    const manifest = JSON.parse(
      await zip.file('manifest.json')!.async('string'),
    ) as Record<string, unknown>;
    expect(manifest.formatVersion).toBe(2);
    expect(hashLikeKeys(manifest)).toEqual([]);
    expect(UUID_PATTERN.test(JSON.stringify(manifest))).toBe(false);
    const templateName = Object.keys(zip.files).find((name) =>
      /template\.xlsx$/.test(name),
    );
    expect(templateName).toBeDefined();
    const headers = readWorkbookHeaders(
      await zip.file(templateName!)!.async('nodebuffer'),
    );
    const timeHeaders: string[] = [];
    for (const [sheet, cols] of Object.entries(headers)) {
      for (const col of cols) {
        if (TIME_COLUMN_PATTERN.test(col)) timeHeaders.push(`${sheet}.${col}`);
      }
    }
    expect(timeHeaders).toEqual([]);
    note(
      `package redlines: hashKeys=0 uuid=0 timeColumns=0 sheets=${Object.keys(headers).length}`,
    );
  });

  it('READY: importing the shipped package (manifest carries verified alignments) succeeds and keeps them verified', async () => {
    const zipBytes = await fs.readFile(LITE_ZIP);

    // 上传 → AWAITING_CONFIRM（校验阶段本身无 error）
    const uploaded = await uploadPackage(
      zipBytes,
      'modeling-life-v2-lite.lgcourse.zip',
    );
    expect([200, 201]).toContain(uploaded.status);
    const job = dataOf<JobView>(uploaded);
    expect(job.jobId).toBeTruthy();
    createdJobIds.push(job.jobId);
    importedJobId = job.jobId;
    importedUnbound = job.report.warnings.filter(
      (warning) => warning.code === 'ALIGNMENT_UNBOUND',
    ).length;
    expect(job.status).toBe('AWAITING_CONFIRM');
    expect(job.package?.courseCode).toBe(COURSE_KEY);
    expect(job.report.errors).toEqual([]);
    note(
      `upload: job=${job.jobId} status=${job.status} course=${job.package?.courseCode} errors=0 warnings=${job.report.warnings.length} alignmentUnbound=${importedUnbound}`,
    );

    // 确认导入 → READY（fix3 后携带 verified 对齐不再被创建触发器阻断）
    const confirmed = await agent
      .post(`/api/backoffice/courses/import/${job.jobId}/confirm`)
      .send({ onConflict: 'ABORT' });
    expect(confirmed.status).toBe(200);
    const result = dataOf<{ status: string; courseId: string }>(confirmed);
    expect(result.status).toBe('READY');
    importedCourseId = result.courseId;
    note(
      `confirm: http=${confirmed.status} status=${result.status} courseId=${result.courseId} code=${errorCode(confirmed) || 'ok'}`,
    );

    // 导入落库且只有一份课程（失败回滚的反面证据）
    expect(
      await prisma.pcCourse.count({ where: { courseKey: COURSE_KEY } }),
    ).toBe(1);
    expect(
      await prisma.commerceCourse.count({ where: { code: COURSE_KEY } }),
    ).toBe(1);
  });

  it('carried verified alignments keep their audit tuple; timing/provenance/media land as specified', async () => {
    const zipBytes = await fs.readFile(LITE_ZIP);
    const source = await JSZip.loadAsync(zipBytes);
    const manifestRaw = JSON.parse(
      await source.file('manifest.json')!.async('string'),
    ) as {
      content: {
        alignments: Array<{
          alignmentId: string;
          status: string;
        }>;
        renditions: Array<{
          renditionKey: string;
          contentKey: string;
          modality: string;
          anchorSource: string;
          startMs: number;
          endMs: number;
        }>;
      };
    };
    const shippedRenditions = manifestRaw.content.renditions;
    const shippedAlignmentCount = manifestRaw.content.alignments.length;
    const result = { courseId: importedCourseId };

    // 课程/分类/阶段
    const pcCourse = await prisma.pcCourse.findUnique({
      where: { courseKey: COURSE_KEY },
      select: { courseKey: true, categoryPath: true },
    });
    expect(pcCourse!.categoryPath).toEqual(['Science']);
    const course = await prisma.commerceCourse.findUnique({
      where: { id: result.courseId },
      select: { code: true, categoryId: true, hasDraft: true },
    });
    expect(course?.code).toBe(COURSE_KEY);
    expect(course?.hasDraft).toBe(true);
    const category = await prisma.courseCatalogueEntry.findUnique({
      where: { id: course!.categoryId! },
      select: { name: true },
    });
    expect(category?.name).toBe('Science');
    const stages = await prisma.pcStage.findMany({
      where: { courseKey: COURSE_KEY },
      select: { kind: true },
    });
    expect(stages.length).toBe(3);
    expect(stages.filter((s) => s.kind === 'program').length).toBe(1);
    expect(stages.filter((s) => s.kind === 'step').length).toBe(2);

    // 时间由字幕/章节机器派生：DB 与出厂 manifest 的 7 个视频坐标逐毫秒一致
    const videoRenditions = shippedRenditions.filter(
      (r) =>
        r.modality === 'video' &&
        (r.anchorSource === 'subtitle' || r.anchorSource === 'chapter'),
    );
    expect(videoRenditions.length).toBe(7);
    const dbRenditions = await prisma.pcRendition.findMany({
      where: { contentKey: { in: ['L001', 'L002'] }, modality: 'video' },
      select: { renditionKey: true, anchorSource: true, startMs: true, endMs: true },
    });
    const byKey = new Map(dbRenditions.map((r) => [r.renditionKey, r]));
    for (const expected of videoRenditions) {
      const actual = byKey.get(expected.renditionKey);
      expect(actual).toBeDefined();
      expect(actual!.anchorSource).toBe(expected.anchorSource);
      expect(actual!.startMs).toBe(expected.startMs);
      expect(actual!.endMs).toBe(expected.endMs);
      expect(actual!.endMs!).toBeGreaterThan(actual!.startMs!);
    }
    const subtitleCount = dbRenditions.filter((r) => r.anchorSource === 'subtitle').length;
    const chapterCount = dbRenditions.filter((r) => r.anchorSource === 'chapter').length;
    expect(subtitleCount).toBe(5);
    expect(chapterCount).toBe(2);
    note(
      `timing: subtitle=${subtitleCount} chapter=${chapterCount} all 7 match shipped manifest ms-exact`,
    );

    // provenance 被记录（包 provenance 随作业落库 + 每条机器对齐带派生审计）
    const jobRow = await prisma.coursePackageJob.findUnique({
      where: { id: importedJobId },
      select: { manifest: true },
    });
    const storedManifest = jobRow?.manifest as
      | { provenance?: Record<string, unknown> }
      | null;
    expect(storedManifest?.provenance?.sourceEnv).toBe('sandbox');
    expect(storedManifest?.provenance?.sourceVersionLabel).toBe('1.0');
    expect(storedManifest?.provenance?.courseKey).toBe(COURSE_KEY);

    // C10.2：包内 verified 对齐在同一 assetKey+assetVersion、锚点未变时保持
    // verified；无法重绑的对齐按 ALIGNMENT_UNBOUND 丢弃（警告，不静默）。
    const alignments = await prisma.pcAlignment.findMany({
      where: { stage: { courseKey: COURSE_KEY } },
      select: {
        status: true,
        provenance: true,
        sourceKind: true,
        verifiedBy: true,
        verifiedAt: true,
        verifiedAgainst: true,
      },
    });
    // 67 条包内 verified 对齐全部落库并保持 verified（2 条 ALIGNMENT_UNBOUND
    // 只是重绑诊断警告，最终仍由包内审计元组写回，不丢行、不降级）。
    expect(alignments.length).toBe(shippedAlignmentCount);
    expect(alignments.every((row) => row.status === 'verified')).toBe(true);
    expect(alignments.every((row) => row.provenance === 'import')).toBe(true);
    for (const row of alignments) {
      expect(row.verifiedBy).toBe('demo-operator@example.com');
      expect(row.verifiedAt).not.toBeNull();
      expect(row.verifiedAgainst).toEqual({
        renditionRevision: 1,
        carrierVersion: 1,
        specVersion: 1,
      });
    }
    const videoAlignments = await prisma.pcAlignment.findMany({
      where: {
        stage: { courseKey: COURSE_KEY },
        rendition: { contentKey: { in: ['L001', 'L002'] }, modality: 'video' },
      },
      select: { status: true, sourceKind: true },
    });
    expect(videoAlignments.length).toBe(7);
    expect(videoAlignments.every((row) => row.status === 'verified')).toBe(true);
    expect(
      videoAlignments.filter((row) => row.sourceKind === 'subtitle').length,
    ).toBe(5);
    expect(
      videoAlignments.filter((row) => row.sourceKind === 'chapter').length,
    ).toBe(2);
    note(
      `alignments: ${alignments.length}/${shippedAlignmentCount} verified carried (unbound=${importedUnbound}); video=7 (subtitle=5 chapter=2)`,
    );

    // 媒体时长来自容器探测
    const media = await prisma.pcMediaAsset.findMany({
      where: { assetKey: { startsWith: 'l1-' } },
      select: { assetKey: true, kind: true, durationMs: true },
    });
    const video = media.find((m) => m.kind === 'video');
    expect(video?.durationMs).toBeGreaterThan(0);
    note(`media: l1-* assets=${media.length} videoDurationMs=${video?.durationMs}`);

    // 同一 (courseKey, versionNo) 重复确认必须 no-op / 显式冲突，不得出现第二份课程
    const repeat = await uploadPackage(
      zipBytes,
      'modeling-life-v2-lite.lgcourse.zip',
    );
    const repeatJob = (repeat.body as { data?: JobView }).data;
    if (repeatJob?.jobId) {
      createdJobIds.push(repeatJob.jobId);
      const repeatConfirm = await agent
        .post(`/api/backoffice/courses/import/${repeatJob.jobId}/confirm`)
        .send({ onConflict: 'ABORT' });
      const repeatStatus = dataOf<{ status?: string }>(repeatConfirm).status ?? '';
      note(
        `idempotency: confirm http=${repeatConfirm.status} status=${repeatStatus} code=${errorCode(repeatConfirm) || 'ok'}`,
      );
      expect(
        await prisma.commerceCourse.count({ where: { code: COURSE_KEY } }),
      ).toBe(1);
    }
  });

  it('rejects all 9 F4 bad packages fail-closed with no side effects', async () => {
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

    for (const entry of expected) {
      const bytes = await fs.readFile(path.join(F4_DIR, entry.file));
      const res = await uploadPackage(bytes, entry.file);
      const body = res.body as { data?: JobView; error?: { code?: string } };
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
        status = 'REJECTED';
        code = errorCode(res);
        expect([400, 422]).toContain(res.status);
      }
      note(`bad-package ${entry.file} http=${res.status} status=${status} code=${code}`);
      expect(['FAILED', 'REJECTED']).toContain(status);
      expect(entry.codes).toContain(code);
    }

    expect(await prisma.commerceCourse.count()).toBe(coursesBefore);
    expect(await prisma.courseCatalogueEntry.count()).toBe(categoriesBefore);
    expect(await prisma.pcStage.count()).toBe(stagesBefore);
    note(
      `bad-packages rejected=9/9 coursesUnchanged=${coursesBefore} categoriesUnchanged=${categoriesBefore} stagesUnchanged=${stagesBefore}`,
    );
  });
});
