import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { Prisma } from '@prisma/client';
import type { Response } from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { captureVersionSnapshot } from '../src/commerce-courses/version-snapshot';
import { buildMinimalMp4 } from '../src/partc/compiler/parse.fixtures';
import { TEMPLATE_V2_HEADERS } from '../src/partc/contracts';
import { signInAs } from './helpers/employee-session';

/**
 * 缝 S4（Part C v2，评审阻断 2/3/4-Admin/9）：课程包导入/导出端到端。
 *
 * 覆盖：
 * - Part C v2 包（唯一 v2 契约 SSOT：courseKey/categoryPath/content/resources/
 *   provenance）真实上传 → parse→validate→deriveTiming→align → 确认导入；
 * - pc_* 实体落库（仓库层）：PcCourse/PcStage/PcContentSpec/PcRendition/
 *   PcMediaAsset，时间坐标来自字幕（subtitle）派生；
 * - 导入后 preview 数据可见（legacy 工作区投影：学习点毫秒→秒）；
 * - 导出写 Part C v2 manifest（provenance/annotations、完整 categoryPath）、
 *   再导入 round-trip；
 * - 二级分类导出/导入保留父链（阻断 9）；
 * - 快照 v3 provenance 区块（C10.3/C10.4）。
 *
 * 黑盒边界：行为经 backoffice HTTP 观察；Prisma 只用于 arrange/cleanup 与
 * 「pc_* 仓库层落库」断言（Part C 管理端 API 属后续阶段，尚无读接口）。
 */

jest.setTimeout(180_000);

const PREFIX = `E2E-PARTC-${Date.now()}`;
const STAGING_ROOT = path.resolve(
  process.env.COURSE_PACKAGE_ROOT?.trim() || 'storage/course-package',
);

// 1x1 PNG（有效签名 + 结构；媒体校验用）
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

interface JobView {
  jobId: string;
  status: string;
  error: string | null;
  courseId: string | null;
  package: { courseCode: string } | null;
  report: {
    errors: Array<{ code: string; message: string }>;
    warnings: Array<{ code: string; message: string }>;
  };
}

interface CourseDetail {
  id: string;
  code: string;
  categoryId: string | null;
  category: { id: string; name: string } | null;
  lessons: Array<{ id: string; code: string }>;
}

interface PreviewLesson {
  code: string;
  learningPoints: Array<{ code: string; timeSeconds: number | null }>;
}

function sheet(name: keyof typeof TEMPLATE_V2_HEADERS, rows: unknown[][]) {
  return { name, rows };
}

function assetKeyOf(courseKey: string, suffix: string): string {
  return `${courseKey}-${suffix}`;
}

function buildWorkbook(
  courseKey: string,
  lessonCode: string,
  title: string,
): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheets = [
    sheet('Meta', [[2, courseKey, 'en-GB', 'video']]),
    sheet('Media', [
      [
        assetKeyOf(courseKey, 'cover'),
        'cover',
        null,
        null,
        'media/cover.png',
        null,
      ],
      [
        assetKeyOf(courseKey, 'video'),
        'video',
        lessonCode,
        'en-GB',
        `media/${lessonCode}.en-GB.mp4`,
        null,
      ],
      [
        assetKeyOf(courseKey, 'sub'),
        'subtitle',
        lessonCode,
        'en-GB',
        `subtitles/${lessonCode}.en-GB.srt`,
        null,
      ],
      [
        assetKeyOf(courseKey, 'image'),
        'image',
        lessonCode,
        'en-GB',
        `media/${lessonCode}-exhibit.png`,
        null,
      ],
    ]),
    sheet('Course Info', [
      ['title', 'en-GB', title],
      ['shortDescription', 'en-GB', `${title} short`],
      ['overview', 'en-GB', `${title} overview`],
      ['whatYouLearn', 'en-GB', 'Outcome one'],
      ['whatYouLearn', 'en-GB', 'Outcome two'],
    ]),
    sheet('Lessons', [[lessonCode, 1, 'en-GB', 'Lesson one', 'Lesson desc']]),
    sheet('Learning Points', [
      [lessonCode, '1.1', 'en-GB', 'Why models matter'],
      [lessonCode, '1.2', 'en-GB', 'Here is a model'],
    ]),
    sheet('Exhibits', [
      [
        lessonCode,
        'ex-1',
        'image',
        assetKeyOf(courseKey, 'image'),
        'en-GB',
        'A model',
        'A model photo',
        null,
      ],
    ]),
    sheet('Reading List', []),
    sheet('Knowledge Test', []),
    sheet('Application Test', []),
  ];
  for (const entry of sheets) {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        [...TEMPLATE_V2_HEADERS[entry.name]],
        ...entry.rows,
      ]),
      entry.name,
    );
  }
  return XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
  }) as Buffer;
}

function buildSrt(): string {
  return [
    '1',
    '00:00:01,000 --> 00:00:04,000',
    'Welcome to the course.',
    '',
    '2',
    '00:00:05,000 --> 00:00:09,500',
    'Why models matter',
    '',
    '3',
    '00:00:10,000 --> 00:00:12,000',
    'Here is a model',
    '',
  ].join('\n');
}

interface BuiltPackage {
  zip: Buffer;
  manifest: Record<string, unknown> & {
    course: { courseKey: string; categoryPath: string[] | null };
    content: { courseKey: string };
    resources: Array<{ id: string; kind: string; path: string; size: number }>;
  };
  files: Map<string, Buffer>;
}

/** 独立构造 Part C v2 包（不经过导出器；契约列名来自唯一 schema 源）。 */
function buildPartcPackage(params: {
  courseKey: string;
  categoryPath: string[] | null;
  sourceEnv?: 'sandbox' | 'production';
}): BuiltPackage {
  const courseKey = params.courseKey;
  const lessonCode = `${courseKey}-L1`;
  const title = `${courseKey} title`;
  const files = new Map<string, Buffer>();
  const template = buildWorkbook(courseKey, lessonCode, title);
  files.set('template.xlsx', template);
  files.set('media/cover.png', PNG);
  files.set(
    `media/${lessonCode}.en-GB.mp4`,
    Buffer.from(buildMinimalMp4(60_000)),
  );
  files.set(
    `subtitles/${lessonCode}.en-GB.srt`,
    Buffer.from(buildSrt(), 'utf8'),
  );
  files.set(`media/${lessonCode}-exhibit.png`, PNG);
  const manifest = {
    format: 'lg-course-package',
    formatVersion: 2,
    packageId: `pkg_${randomUUID()}`,
    exportedAt: new Date().toISOString(),
    minReaderVersion: 2,
    extensionsUsed: [],
    extensionsRequired: [],
    course: {
      courseKey,
      titleLocalized: { 'en-GB': { title } },
      categoryPath: params.categoryPath,
      learningLanguages: ['en-GB'],
      studyMode: 'video',
    },
    content: {
      courseKey,
      versionNo: 1,
      categoryPath: params.categoryPath,
      stages: [
        {
          courseKey,
          stageKey: `program-${courseKey}`,
          parentStageKey: null,
          orderKey: '000001',
          kind: 'program',
          goal: title,
          objectiveKeys: [],
          exitEvidence: [],
          exitRollup: { kind: 'all' },
          status: 'active',
        },
        {
          courseKey,
          stageKey: `step-${courseKey}`,
          parentStageKey: `program-${courseKey}`,
          orderKey: '000001.000001',
          kind: 'step',
          goal: 'Lesson one',
          objectiveKeys: [`obj-${courseKey}`],
          exitEvidence: [`ev-${courseKey}`],
          exitRollup: { kind: 'all' },
          status: 'active',
        },
      ],
      prerequisiteEdges: [],
      specPins: [{ contentKey: lessonCode, version: 1 }],
      renditions: [],
      alignments: [],
      evidenceSpecs: [
        {
          evidenceKey: `ev-${courseKey}`,
          version: 1,
          kind: 'artifact',
          objectiveKeys: [`obj-${courseKey}`],
          measure: { kind: 'artifact', instructions: 'Complete the lesson.' },
          scoring: 'pass-fail',
          threshold: 1,
          attempts: 1,
        },
      ],
      assetPins: [
        { assetKey: assetKeyOf(courseKey, 'video'), assetVersion: 1 },
        { assetKey: assetKeyOf(courseKey, 'image'), assetVersion: 1 },
      ],
    },
    resources: [
      {
        id: 'template',
        kind: 'template',
        path: 'template.xlsx',
        size: template.length,
      },
      ...[
        'media/cover.png',
        `media/${lessonCode}.en-GB.mp4`,
        `subtitles/${lessonCode}.en-GB.srt`,
        `media/${lessonCode}-exhibit.png`,
      ].map((resourcePath) => ({
        id:
          resourcePath === 'media/cover.png'
            ? assetKeyOf(courseKey, 'cover')
            : resourcePath.endsWith('.mp4')
              ? assetKeyOf(courseKey, 'video')
              : resourcePath.endsWith('.srt')
                ? assetKeyOf(courseKey, 'sub')
                : assetKeyOf(courseKey, 'image'),
        kind: resourcePath.endsWith('.mp4')
          ? 'video'
          : resourcePath.endsWith('.srt')
            ? 'subtitle'
            : resourcePath === 'media/cover.png'
              ? 'cover'
              : 'image',
        path: resourcePath,
        size: files.get(resourcePath)!.length,
      })),
    ],
    provenance: {
      sourceEnv: params.sourceEnv ?? 'sandbox',
      sourceVersionLabel: '4.2',
      exportedAt: '2026-11-12T08:00:00Z',
      exportedBy: 'operator@example.com',
      courseKey,
      planPin: {
        planId: `plan/${courseKey}/export-4.2/target-default/v1`,
        planVersion: 1,
      },
      approvalRef: 'APPROVED-1',
      auditSummaryRef: `audit/${courseKey}/4.2.json`,
    },
    annotations: {
      slug: courseKey.toLowerCase(),
      sourceEnv: params.sourceEnv ?? 'sandbox',
      versionLabel: '4.2',
    },
  };
  return { zip: Buffer.alloc(0), manifest, files };
}

async function zipPackage(built: BuiltPackage): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(built.manifest, null, 2));
  for (const [name, bytes] of built.files) zip.file(name, bytes);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('Part C v2 course package import/export (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let agent: Awaited<ReturnType<typeof signInAs>>;
  let societyId: string;
  let subCategoryId: string;
  const createdJobIds: string[] = [];
  const createdCourseCodes: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    agent = await signInAs(app, 'ADMIN');
    const society = await prisma.courseCatalogueEntry.findFirstOrThrow({
      where: { parentId: null, name: 'Society', status: 'ACTIVE' },
      select: { id: true },
    });
    societyId = society.id;
    const sub = await prisma.courseCatalogueEntry.upsert({
      where: {
        parentId_name: {
          parentId: societyId,
          name: `${PREFIX} Sociology`,
        },
      } as never,
      create: {
        name: `${PREFIX} Sociology`,
        parentId: societyId,
        status: 'ACTIVE',
        sortOrder: 99,
      },
      update: { status: 'ACTIVE' },
      select: { id: true },
    });
    subCategoryId = sub.id;
  });

  afterAll(async () => {
    for (const code of createdCourseCodes) {
      await prisma.commerceCourse
        .deleteMany({ where: { code } })
        .catch(() => undefined);
    }
    await prisma.commerceCourse
      .deleteMany({ where: { code: { startsWith: PREFIX } } })
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
    // pc_* 仓库层（无跨域外键）：按本套件前缀清理。
    await prisma.pcAlignment
      .deleteMany({ where: { alignmentId: { contains: PREFIX } } })
      .catch(() => undefined);
    await prisma.pcRendition
      .deleteMany({ where: { renditionKey: { contains: PREFIX } } })
      .catch(() => undefined);
    await prisma.pcContentSpec
      .deleteMany({ where: { contentKey: { startsWith: PREFIX } } })
      .catch(() => undefined);
    await prisma.pcEvidenceSpec
      .deleteMany({ where: { evidenceKey: { contains: PREFIX } } })
      .catch(() => undefined);
    await prisma.pcObjective
      .deleteMany({ where: { objectiveKey: { contains: PREFIX } } })
      .catch(() => undefined);
    await prisma.pcMediaAsset
      .deleteMany({ where: { assetKey: { startsWith: PREFIX } } })
      .catch(() => undefined);
    await prisma.pcStage
      .deleteMany({ where: { courseKey: { startsWith: PREFIX } } })
      .catch(() => undefined);
    await prisma.pcCourse
      .deleteMany({ where: { courseKey: { startsWith: PREFIX } } })
      .catch(() => undefined);
    await prisma.courseCatalogueEntry
      .delete({ where: { id: subCategoryId } })
      .catch(() => undefined);
    await app.close();
  });

  function dataOf<T>(res: Response): T {
    return (res.body as { data: T }).data;
  }

  async function getJob(jobId: string): Promise<JobView> {
    const res = await agent
      .get(`/api/backoffice/courses/import/${jobId}`)
      .expect(200);
    return dataOf<JobView>(res);
  }

  async function uploadPackage(bytes: Buffer, name: string): Promise<JobView> {
    const res = await agent
      .post('/api/backoffice/courses/import')
      .attach('file', bytes, {
        filename: name,
        contentType: 'application/zip',
      });
    expect([200, 201]).toContain(res.status);
    const job = (res.body as { data?: JobView }).data;
    if (!job?.jobId) {
      throw new Error(
        `upload did not create an import job: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    createdJobIds.push(job.jobId);
    return job;
  }

  async function confirmImport(jobId: string): Promise<Response> {
    return agent
      .post(`/api/backoffice/courses/import/${jobId}/confirm`)
      .send({ onConflict: 'ABORT' });
  }

  /** 确认为 READY；失败时带出 job 错误包络，便于定位契约/编译错误。 */
  async function confirmToReady(
    jobId: string,
  ): Promise<{ status: string; courseId: string }> {
    const res = await confirmImport(jobId);
    if (res.status !== 200) {
      const job = await getJob(jobId);
      throw new Error(
        `import confirm failed (${res.status}): ${JSON.stringify(res.body)} report=${JSON.stringify(job.report)}`,
      );
    }
    const data = dataOf<{ status: string; courseId: string }>(res);
    expect(data.status).toBe('READY');
    return data;
  }

  async function getCourse(courseId: string): Promise<CourseDetail> {
    const res = await agent
      .get(`/api/backoffice/courses/${courseId}`)
      .expect(200);
    return dataOf<CourseDetail>(res);
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

  async function exportAndDownload(
    courseId: string,
    version = 'working',
  ): Promise<{ bytes: Buffer; manifest: Record<string, unknown> }> {
    const started = await agent
      .post(`/api/backoffice/courses/${courseId}/export`)
      .send({ version })
      .expect(202);
    const jobId = dataOf<{ jobId: string }>(started).jobId;
    createdJobIds.push(jobId);
    const deadline = Date.now() + 60_000;
    let status = '';
    while (Date.now() < deadline) {
      const job = await agent
        .get(`/api/backoffice/courses/export/${jobId}`)
        .expect(200);
      const view = dataOf<JobView>(job);
      status = view.status;
      if (status === 'READY' || status === 'FAILED') {
        if (status === 'FAILED') {
          throw new Error(`export job failed: ${view.error ?? 'unknown'}`);
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(status).toBe('READY');
    const download = await agent
      .get(`/api/backoffice/courses/export/${jobId}/download`)
      .buffer(true)
      .parse(binaryParser as never)
      .expect(200);
    const bytes = download.body as Buffer;
    const zip = await JSZip.loadAsync(bytes);
    const manifest = JSON.parse(
      await zip.file('manifest.json')!.async('string'),
    ) as Record<string, unknown>;
    return { bytes, manifest };
  }

  async function stageImportPackage(
    manifestRaw: unknown,
    bytes: Buffer,
    targetCourseId: string,
  ): Promise<string> {
    const job = await prisma.coursePackageJob.create({
      data: {
        kind: 'IMPORT',
        status: 'AWAITING_CONFIRM',
        stage: 'VALIDATED',
        courseId: targetCourseId,
        sourceFileName: 'roundtrip.zip',
      },
      select: { id: true },
    });
    const stagingDir = path.join(STAGING_ROOT, job.id);
    const zip = await JSZip.loadAsync(bytes);
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || entry.name === 'manifest.json') continue;
      const target = path.join(stagingDir, entry.name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, await entry.async('nodebuffer'));
    }
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(
      path.join(stagingDir, '__manifest.json'),
      JSON.stringify(manifestRaw),
    );
    createdJobIds.push(job.id);
    return job.id;
  }

  it('imports a Part C v2 package through the compiler, persists pc_* entities and derives timing for preview (C5 P1–P4)', async () => {
    const courseKey = `${PREFIX}-IMPORT`;
    createdCourseCodes.push(courseKey);
    const built = buildPartcPackage({
      courseKey,
      categoryPath: ['Society'],
    });
    const job = await uploadPackage(await zipPackage(built), 'partc.zip');
    expect(job.status).toBe('AWAITING_CONFIRM');
    expect(job.package?.courseCode).toBe(courseKey);

    const result = await confirmToReady(job.jobId);

    const detail = await getCourse(result.courseId);
    expect(detail.code).toBe(courseKey);
    expect(detail.category?.name).toBe('Society');

    // preview 数据：学习点时间来自字幕派生（5s / 10s），legacy 投影为秒。
    const previewRes = await agent
      .get(`/api/backoffice/courses/${result.courseId}/preview`)
      .expect(200);
    const preview = dataOf<{ lessons: PreviewLesson[] }>(previewRes);
    const lesson = preview.lessons.find(
      (entry) => entry.code === `${courseKey}-L1`,
    );
    expect(lesson).toBeDefined();
    expect(
      lesson!.learningPoints.find((lp) => lp.code === '1.1')?.timeSeconds,
    ).toBe(5);
    expect(
      lesson!.learningPoints.find((lp) => lp.code === '1.2')?.timeSeconds,
    ).toBe(10);

    // pc_* 仓库层落库（Part C 管理端 API 属后续阶段）。
    const pcCourse = await prisma.pcCourse.findUnique({
      where: { courseKey },
    });
    expect(pcCourse).not.toBeNull();
    expect(pcCourse!.categoryPath).toEqual(['Society']);
    const stages = await prisma.pcStage.findMany({ where: { courseKey } });
    expect(stages.map((stage) => stage.kind).sort()).toEqual([
      'program',
      'step',
    ]);
    const spec = await prisma.pcContentSpec.findUnique({
      where: {
        contentKey_version: { contentKey: `${courseKey}-L1`, version: 1 },
      },
    });
    expect(spec).not.toBeNull();
    const blocks = await prisma.pcBlock.findMany({
      where: { contentKey: `${courseKey}-L1`, version: 1 },
    });
    expect(blocks.length).toBeGreaterThanOrEqual(2); // video + exhibit block
    const renditions = await prisma.pcRendition.findMany({
      where: { contentKey: `${courseKey}-L1` },
    });
    expect(renditions.length).toBeGreaterThanOrEqual(3); // 2 LP + exhibit
    expect(
      renditions.filter((rendition) => rendition.anchorSource === 'subtitle')
        .length,
    ).toBeGreaterThanOrEqual(2);
    const videoAsset = await prisma.pcMediaAsset.findUnique({
      where: {
        assetKey_assetVersion: {
          assetKey: assetKeyOf(courseKey, 'video'),
          assetVersion: 1,
        },
      },
    });
    expect(videoAsset?.durationMs).toBe(60_000);

    // 快照 v3 provenance 区块（C10.3/C10.4）：导入来源随快照携带。
    const snapshot = await captureVersionSnapshot(prisma, result.courseId);
    expect(snapshot.provenance?.sourceEnv).toBe('sandbox');
    expect(snapshot.provenance?.sourceVersionLabel).toBe('4.2');
    expect(snapshot.provenance?.courseKey).toBe(courseKey);
  });

  it('exports a Part C v2 manifest (provenance/annotations, full categoryPath) and re-imports it (round-trip)', async () => {
    const courseKey = `${PREFIX}-ROUNDTRIP`;
    createdCourseCodes.push(courseKey);
    const built = buildPartcPackage({
      courseKey,
      categoryPath: ['Society'],
    });
    const job = await uploadPackage(await zipPackage(built), 'partc.zip');
    const courseId = (await confirmToReady(job.jobId)).courseId;

    const exported = await exportAndDownload(courseId);
    const manifest = exported.manifest as {
      formatVersion?: number;
      course?: { courseKey?: string; categoryPath?: string[] | null };
      content?: { categoryPath?: string[] | null; stages?: unknown[] };
      resources?: Array<{ kind?: string; path?: string; size?: number }>;
      provenance?: {
        sourceEnv?: string;
        sourceVersionLabel?: string;
        courseKey?: string;
        planPin?: { planId?: string; planVersion?: number };
      };
      annotations?: { slug?: string; versionLabel?: string };
    };
    expect(manifest.formatVersion).toBe(2);
    expect(manifest.course?.courseKey).toBe(courseKey);
    expect(manifest.course?.categoryPath).toEqual(['Society']);
    expect(manifest.content?.categoryPath).toEqual(['Society']);
    expect(manifest.provenance?.sourceEnv).toBe('sandbox');
    expect(manifest.provenance?.courseKey).toBe(courseKey);
    expect(manifest.provenance?.planPin?.planId).toMatch(/^plan\//);
    expect(manifest.annotations?.slug).toBe(courseKey.toLowerCase());
    // 闭合包：template 资源在清单内，且无任何哈希清单文件。
    expect(
      manifest.resources?.some((resource) => resource.kind === 'template'),
    ).toBe(true);
    expect(
      manifest.resources?.some((resource) =>
        /checksums|sha256|digest/i.test(resource.path ?? ''),
      ),
    ).toBe(false);

    // 再导入：同一 Part C 管线消费导出产物（round-trip）。
    const stagedJob = await stageImportPackage(
      manifest,
      exported.bytes,
      courseId,
    );
    await confirmToReady(stagedJob);
    const detail = await getCourse(courseId);
    expect(detail.category?.name).toBe('Society');
  });

  it('exports verified Pc alignments with their audit tuple and keeps them across re-import (C10.4)', async () => {
    const courseKey = `${PREFIX}-AUDIT`;
    createdCourseCodes.push(courseKey);
    const lessonCode = `${courseKey}-L1`;
    const built = buildPartcPackage({
      courseKey,
      categoryPath: ['Society'],
    });
    // 让包内 step 与工作区导出派生的 stepKey 同名（导出按课时生成 step）。
    const stages = (
      built.manifest.content as unknown as {
        stages: Array<{ stageKey: string }>;
      }
    ).stages;
    stages[1].stageKey = `step-${lessonCode}`;
    const job = await uploadPackage(await zipPackage(built), 'partc-audit.zip');
    const courseId = (await confirmToReady(job.jobId)).courseId;

    // 第一次导出：取得工作区导出实际使用的 stage/rendition 稳定键。
    const first = await exportAndDownload(courseId);
    const firstContent = first.manifest.content as {
      stages: Array<{ stageKey: string; objectiveKeys: string[] }>;
      renditions: Array<{
        renditionKey: string;
        contentKey: string;
        blockId: string;
        language: string;
        modality: string;
        occurrenceKey: string;
        carrierType: string;
        carrierKey: string;
        carrierVersion: number;
        startMs?: number;
        endMs?: number;
        headingCode?: string;
        offset?: number;
        anchorSource: string;
        revision: number;
      }>;
    };
    const step = firstContent.stages.find(
      (stage) => stage.stageKey === `step-${lessonCode}`,
    );
    expect(step).toBeDefined();
    const objectiveKey = step!.objectiveKeys[0];
    const rendition = firstContent.renditions.find(
      (entry) => entry.modality === 'video' && entry.startMs !== undefined,
    );
    expect(rendition).toBeDefined();

    // arrange：模拟“人已签收”的 verified 对齐（C3/C4 ALN-2：导入器不替人签）。
    // 导出已携带 asset 身份（carrierKey/carrierVersion），导入也已把 rendition
    // 落库；arrange 只能引用既有行，不得为同一业务键再创建 PcRendition
    // （否则会撞 UNIQUE(contentKey,blockId,language,modality,carrierType,
    // carrierKey,carrierVersion,occurrenceKey) 或制造重复行）。
    const alignmentId = `aln.audit.${courseKey}`;
    const verifiedAt = '2026-11-12T09:30:00Z';
    await prisma.pcObjective.upsert({
      where: { objectiveKey },
      create: {
        objectiveKey,
        statement: 'Complete the lesson.',
        status: 'active',
      },
      update: {},
    });
    const existingRendition = await prisma.pcRendition.findUniqueOrThrow({
      where: { renditionKey: rendition!.renditionKey },
    });
    expect(existingRendition.carrierKey).toBe(rendition!.carrierKey);
    expect(existingRendition.carrierVersion).toBe(rendition!.carrierVersion);
    const verifiedAgainst = {
      renditionRevision: existingRendition.revision,
      carrierVersion: existingRendition.carrierVersion,
      specVersion: 1,
    };
    await prisma.pcAlignment.create({
      data: {
        alignmentId,
        stageKey: step!.stageKey,
        renditionKey: rendition!.renditionKey,
        objectiveKey,
        role: 'primary',
        status: 'verified',
        provenance: 'human',
        sourceKind: 'subtitle',
        sourceArtifact: `subtitles/${lessonCode}.en-GB.srt`,
        modelVersion: null,
        params: Prisma.DbNull,
        ruleVersion: 'timing-rules-v1',
        verifiedBy: 'operator@example.com',
        verifiedAt: new Date(verifiedAt),
        verifiedAgainst,
      },
    });

    // 第二次导出：content.alignments 来自 Pc 真源（verified + 审计元组），
    // annotations.timingSources 记录机器时间源。
    const second = await exportAndDownload(courseId);
    const secondManifest = second.manifest as {
      content: { alignments: Array<Record<string, unknown>> };
      annotations?: { timingSources?: string[] };
    };
    const exported = secondManifest.content.alignments.find(
      (entry) => entry.alignmentId === alignmentId,
    );
    expect(exported).toMatchObject({
      alignmentId,
      stageKey: step!.stageKey,
      renditionKey: rendition!.renditionKey,
      objectiveKey,
      role: 'primary',
      status: 'verified',
      provenance: 'human',
      sourceKind: 'subtitle',
      sourceArtifact: `subtitles/${lessonCode}.en-GB.srt`,
      ruleVersion: 'timing-rules-v1',
      verifiedBy: 'operator@example.com',
      verifiedAt: new Date(verifiedAt).toISOString(),
      verifiedAgainst,
    });
    expect(secondManifest.annotations?.timingSources).toEqual(
      expect.arrayContaining(['subtitle']),
    );

    // 再导入：verified 对齐（人签优先）不得被导入覆盖，审计元组原样保留。
    const stagedJob = await stageImportPackage(
      second.manifest,
      second.bytes,
      courseId,
    );
    await confirmToReady(stagedJob);
    const persisted = await prisma.pcAlignment.findUniqueOrThrow({
      where: { alignmentId },
    });
    expect(persisted.status).toBe('verified');
    expect(persisted.provenance).toBe('human');
    expect(persisted.sourceKind).toBe('subtitle');
    expect(persisted.sourceArtifact).toBe(`subtitles/${lessonCode}.en-GB.srt`);
    expect(persisted.ruleVersion).toBe('timing-rules-v1');
    expect(persisted.verifiedBy).toBe('operator@example.com');
    expect(persisted.verifiedAt?.toISOString()).toBe(
      new Date(verifiedAt).toISOString(),
    );
    expect(persisted.verifiedAgainst).toEqual(verifiedAgainst);
  });

  it('exports and imports a second-level category with the full parent path (blocker 9)', async () => {
    const code = `${PREFIX}-SUB`;
    createdCourseCodes.push(code);
    const created = await agent
      .post('/api/backoffice/courses')
      .send({
        code,
        title: `${code} title`,
        categoryId: subCategoryId,
        learningMode: 'TEXT_ONLY',
      })
      .expect(201);
    const courseId = dataOf<CourseDetail>(created).id;
    const lesson = dataOf<CourseDetail>(
      await agent
        .post(`/api/backoffice/courses/${courseId}/lessons`)
        .send({ title: 'Lesson 1' })
        .expect(201),
    ).lessons[0];
    await agent
      .put(`/api/backoffice/courses/${courseId}/lessons/${lesson.id}`)
      .send({ title: 'Lesson 1', textHtml: '<h1>Part one</h1><p>Body</p>' })
      .expect(200);

    const exported = await exportAndDownload(courseId);
    const manifest = exported.manifest as {
      course?: { categoryPath?: string[] | null };
      content?: { categoryPath?: string[] | null };
    };
    const subName = `${PREFIX} Sociology`;
    expect(manifest.course?.categoryPath).toEqual(['Society', subName]);
    expect(manifest.content?.categoryPath).toEqual(['Society', subName]);

    // 再导入同一课程：二级路径逐级解析回同一分类（不丢父链、不造分类）。
    const stagedJob = await stageImportPackage(
      manifest,
      exported.bytes,
      courseId,
    );
    await confirmToReady(stagedJob);
    const detail = await getCourse(courseId);
    expect(detail.categoryId).toBe(subCategoryId);
    expect(detail.category?.name).toBe(subName);
  });
});
