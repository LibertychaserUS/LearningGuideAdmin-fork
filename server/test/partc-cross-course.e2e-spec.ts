import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import type { Response } from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { TEMPLATE_V2_HEADERS } from '../src/partc/contracts';
import { signInAs } from './helpers/employee-session';

/**
 * 缝 S4（Part C v2）缺陷回归：R14 跨课程键冲突 + R15 多课时正文覆盖。
 *
 * R14：课程局部键（stageKey/objectiveKey/evidenceKey/contentKey）是课程局部
 * 语义，但导入按全局唯一键 upsert（pcStage.stageKey / pcObjective.objectiveKey /
 * pcEvidenceSpec(evidenceKey,version) / pcContentSpec(contentKey,version) /
 * pcRendition.renditionKey 均不含 courseKey）。同模板第二门课要么
 * PACKAGE_FORMAT_UNSUPPORTED 整包失败（stageKey 归属检查），要么把第一门课的
 * content spec/block/rendition 改属（upsert update courseKey）。
 * 修复约定：课程局部键在导出/导入两侧注入 courseKey 命名空间
 * （step-${courseKey}-${lessonCode} / obj-… / ev-… / contentKey=${courseKey}.${lessonCode}，
 * 附属键 ${main}.reading / .knowledge-test / .application-test），稳定可往返，
 * 无内容哈希。
 *
 * R15：import 投影把全包第一个 body 块当作所有课时正文 → 多课时文本课互相
 * 覆盖。修复约定：按课时自己的 contentKey 取对应 body 块；语言中立共享语义
 * （每课时一块、多语言共享）保留。
 *
 * 黑盒边界：行为经 backoffice HTTP 观察；Prisma 只用于 arrange/cleanup 与
 * pc_* 仓库层归属断言。
 */

jest.setTimeout(180_000);

const PREFIX = `E2E-XCOURSE-${Date.now()}`;

// 与 partc-package 套件同口径：草稿导出仅在 Sandbox 调试路径放行
// （PRD §16.2 默认只允许线上版本导出）。
process.env.VERSION_NUMBERING_MODE = 'sandbox';
process.env.ALLOW_DRAFT_EXPORT = 'on';

const STAGING_ROOT = path.resolve(
  process.env.COURSE_PACKAGE_ROOT?.trim() || 'storage/course-package',
);

/**
 * 本套件对修复后键规则的独立期望（不复用被测实现，防公式漂移被自证掩盖）：
 * 主 contentKey = `${courseKey}.${lessonCode}`。
 */
function expectedContentKey(courseKey: string, lessonCode: string): string {
  return `${courseKey}.${lessonCode}`;
}

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
  lessons: Array<{
    id: string;
    code: string;
    localizations?: Array<{ language: string; textHtml: string | null }>;
  }>;
}

describe('Part C cross-course keys and multi-lesson text bodies (e2e)', () => {
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
          name: `${PREFIX} Category`,
        },
      } as never,
      create: {
        name: `${PREFIX} Category`,
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
    await prisma.pcAlignment
      .deleteMany({ where: { alignmentId: { contains: PREFIX } } })
      .catch(() => undefined);
    await prisma.pcRendition
      .deleteMany({ where: { renditionKey: { contains: PREFIX } } })
      .catch(() => undefined);
    await prisma.pcContentSpec
      .deleteMany({ where: { contentKey: { contains: PREFIX } } })
      .catch(() => undefined);
    await prisma.pcEvidenceSpec
      .deleteMany({ where: { evidenceKey: { contains: PREFIX } } })
      .catch(() => undefined);
    await prisma.pcObjective
      .deleteMany({ where: { objectiveKey: { contains: PREFIX } } })
      .catch(() => undefined);
    await prisma.pcMediaAsset
      .deleteMany({ where: { assetKey: { contains: PREFIX } } })
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

  /** 上传并确认为新课程（onConflict=ABORT；courseKey 必须未被占用）。 */
  async function importAsNewCourse(
    bytes: Buffer,
    name: string,
  ): Promise<{ status: string; courseId: string }> {
    const job = await uploadPackage(bytes, name);
    return confirmToReady(job.jobId);
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
  ): Promise<{ bytes: Buffer; manifest: Record<string, unknown> }> {
    const started = await agent
      .post(`/api/backoffice/courses/${courseId}/export`)
      .send({ version: 'working' })
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

  /** 把导出的包重新导入到同一课程（替换草稿；与 partc-package 套件同路径）。 */
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

  /** 经 API 创建 TEXT_ONLY 课程并写入课时正文。 */
  async function createTextCourse(
    code: string,
    lessons: Array<{ code: string; title: string; textHtml: string }>,
  ): Promise<CourseDetail> {
    createdCourseCodes.push(code);
    const created = await agent
      .post('/api/backoffice/courses')
      .send({
        code,
        title: `${code} title`,
        learningMode: 'TEXT_ONLY',
        categoryId: subCategoryId,
      })
      .expect(201);
    const courseId = dataOf<CourseDetail>(created).id;
    for (const lesson of lessons) {
      const detail = dataOf<CourseDetail>(
        await agent
          .post(`/api/backoffice/courses/${courseId}/lessons`)
          .send({ code: lesson.code, title: lesson.title })
          .expect(201),
      );
      const createdLesson = detail.lessons.find(
        (entry) => entry.code === lesson.code,
      );
      if (!createdLesson) {
        throw new Error(`lesson ${lesson.code} was not created`);
      }
      await agent
        .put(`/api/backoffice/courses/${courseId}/lessons/${createdLesson.id}`)
        .send({ title: lesson.title, textHtml: lesson.textHtml })
        .expect(200);
    }
    return getCourse(courseId);
  }

  function escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 最小 DOCX（与导出端 buildDocxFromHtml 同构；mammoth 可读回）。 */
  async function buildMinimalDocx(paragraphs: string[]): Promise<Buffer> {
    const blocks = paragraphs
      .filter((text) => text.trim() !== '')
      .map(
        (text) =>
          `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`,
      );
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${blocks.join('')}<w:sectPr/></w:body></w:document>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`;
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
    const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', contentTypes);
    zip.file('_rels/.rels', rootRels);
    zip.file('word/document.xml', document);
    zip.file('word/styles.xml', styles);
    zip.file('word/_rels/document.xml.rels', documentRels);
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  /** 同一模板（同一 lesson_code）的最小 Part C v2 文本包；stage 键按课程命名。 */
  async function buildSameTemplatePackage(params: {
    courseKey: string;
    lessonCode: string;
    body: string;
  }): Promise<{ zip: Buffer; manifest: Record<string, unknown> }> {
    const { courseKey, lessonCode, body } = params;
    const docPath = `lessons/${lessonCode}.en-GB.docx`;
    const docAssetKey = `${courseKey}-doc`;
    const docx = await buildMinimalDocx([body]);
    const workbook = XLSX.utils.book_new();
    const append = (name: string, rows: unknown[][]): void => {
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet([
          [...TEMPLATE_V2_HEADERS[name as keyof typeof TEMPLATE_V2_HEADERS]],
          ...rows,
        ]),
        name,
      );
    };
    append('Meta', [[2, courseKey, 'en-GB', 'text']]);
    append('Media', [
      [docAssetKey, 'lesson-text', lessonCode, 'en-GB', docPath, null],
    ]);
    append('Course Info', [['title', 'en-GB', `${courseKey} title`]]);
    append('Lessons', [[lessonCode, 1, 'en-GB', 'Lesson one', null]]);
    append('Learning Points', []);
    append('Exhibits', []);
    append('Reading List', []);
    append('Knowledge Test', []);
    append('Application Test', []);
    const template = XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;
    const manifest = {
      format: 'lg-course-package',
      formatVersion: 2,
      packageId: `pkg_${courseKey}_1`,
      exportedAt: new Date().toISOString(),
      minReaderVersion: 2,
      extensionsUsed: [],
      extensionsRequired: [],
      course: {
        courseKey,
        titleLocalized: { 'en-GB': { title: `${courseKey} title` } },
        categoryPath: null,
        learningLanguages: ['en-GB'],
        studyMode: 'text',
      },
      content: {
        courseKey,
        versionNo: 1,
        categoryPath: null,
        stages: [
          {
            courseKey,
            stageKey: `program-${courseKey}`,
            parentStageKey: null,
            orderKey: '000001',
            kind: 'program',
            goal: `${courseKey} title`,
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
        specPins: [
          { contentKey: expectedContentKey(courseKey, lessonCode), version: 1 },
        ],
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
        assetPins: [{ assetKey: docAssetKey, assetVersion: 1 }],
      },
      resources: [
        {
          id: 'template',
          kind: 'template',
          path: 'template.xlsx',
          size: template.length,
        },
        { id: docAssetKey, kind: 'document', path: docPath, size: docx.length },
      ],
      provenance: {
        sourceEnv: 'sandbox',
        sourceVersionLabel: '1.0',
        exportedAt: '2026-11-16T00:00:00Z',
        exportedBy: 'operator@example.com',
        courseKey,
        planPin: {
          planId: `plan/${courseKey}/export-1.0/target-default/v1`,
          planVersion: 1,
        },
        approvalRef: 'APPROVED-1',
        auditSummaryRef: `audit/${courseKey}/1.0.json`,
      },
      annotations: { slug: courseKey.toLowerCase() },
    };
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    zip.file('template.xlsx', template);
    zip.file(docPath, docx);
    return {
      zip: await zip.generateAsync({ type: 'nodebuffer' }),
      manifest: manifest as unknown as Record<string, unknown>,
    };
  }

  it('R14: imports two courses exported from the same template (same lesson code) as distinct courses', async () => {
    const ckA = `${PREFIX}-A`;
    const ckB = `${PREFIX}-B`;
    const lessonCode = 'L1';

    // 两个课程用同一模板（同一 lesson code），各自导出课程包。
    const courseA = await createTextCourse(ckA, [
      { code: lessonCode, title: 'Lesson one', textHtml: '<p>Body A.</p>' },
    ]);
    const courseB = await createTextCourse(ckB, [
      { code: lessonCode, title: 'Lesson one', textHtml: '<p>Body B.</p>' },
    ]);
    const pkgA = await exportAndDownload(courseA.id);
    const pkgB = await exportAndDownload(courseB.id);

    // 释放课程码，两个包作为各自的新课程导入（同模板、不同课程）。
    await prisma.commerceCourse
      .deleteMany({ where: { code: { in: [ckA, ckB] } } })
      .catch(() => undefined);

    await importAsNewCourse(pkgA.bytes, 'same-template-a.zip');
    // 修复前：第二个导入撞 pcStage.stageKey 全局唯一/归属检查 → 422
    // PACKAGE_FORMAT_UNSUPPORTED（stageKey is already owned by another course）。
    const importB = await importAsNewCourse(pkgB.bytes, 'same-template-b.zip');
    expect(importB.status).toBe('READY');

    // 阶段键课程间互不冲突：各自拥有含自己 courseKey 的键。
    const stagesA = await prisma.pcStage.findMany({
      where: { courseKey: ckA },
      orderBy: { orderKey: 'asc' },
    });
    expect(stagesA.map((stage) => stage.stageKey)).toEqual([
      `program-${ckA}`,
      `step-${ckA}-${lessonCode}`,
    ]);
    const stagesB = await prisma.pcStage.findMany({
      where: { courseKey: ckB },
      orderBy: { orderKey: 'asc' },
    });
    expect(stagesB.map((stage) => stage.stageKey)).toEqual([
      `program-${ckB}`,
      `step-${ckB}-${lessonCode}`,
    ]);

    // 内容规格/块/rendition 各自归属（修复前为改属：upsert 把第一门课的
    // contentKey=lessonCode 行 update courseKey 给第二门课）。
    const specA = await prisma.pcContentSpec.findUnique({
      where: {
        contentKey_version: {
          contentKey: expectedContentKey(ckA, lessonCode),
          version: 1,
        },
      },
    });
    expect(specA?.courseKey).toBe(ckA);
    const specB = await prisma.pcContentSpec.findUnique({
      where: {
        contentKey_version: {
          contentKey: expectedContentKey(ckB, lessonCode),
          version: 1,
        },
      },
    });
    expect(specB?.courseKey).toBe(ckB);
    const blocksA = await prisma.pcBlock.findMany({
      where: { contentKey: expectedContentKey(ckA, lessonCode), version: 1 },
    });
    expect(blocksA.length).toBeGreaterThanOrEqual(1);
    const renditionsA = await prisma.pcRendition.findMany({
      where: { contentKey: expectedContentKey(ckA, lessonCode) },
    });
    expect(renditionsA.length).toBeGreaterThanOrEqual(1);

    // 再导出 B：Pc 真源键原样携带（round-trip 稳定，不回退）。
    const reB = await exportAndDownload(importB.courseId);
    const reStages =
      (reB.manifest.content as { stages?: Array<{ stageKey: string }> })
        .stages ?? [];
    expect(reStages.map((stage) => stage.stageKey)).toEqual(
      expect.arrayContaining([`step-${ckB}-${lessonCode}`]),
    );
    expect(
      reStages.some((stage) => stage.stageKey === `step-${lessonCode}`),
    ).toBe(false);
    const rePins =
      (
        reB.manifest.content as {
          specPins?: Array<{ contentKey: string; version: number }>;
        }
      ).specPins ?? [];
    expect(
      rePins.some(
        (pin) => pin.contentKey === expectedContentKey(ckB, lessonCode),
      ),
    ).toBe(true);
  });

  it('R14: same lesson_code packages keep their own content specs (no ownership steal)', async () => {
    const ck1 = `${PREFIX}-S1`;
    const ck2 = `${PREFIX}-S2`;
    const lessonCode = 'L1';

    // 同一模板的最小包：stage 键已按课程命名，但 lesson_code 相同。
    // 修复前 align 派生 contentKey=lessonCode → 第二个导入把第一个课程的
    // pcContentSpec/pcBlock 改属并整组替换（静默改属）。
    const pkg1 = await buildSameTemplatePackage({
      courseKey: ck1,
      lessonCode,
      body: 'Same template body one.',
    });
    const pkg2 = await buildSameTemplatePackage({
      courseKey: ck2,
      lessonCode,
      body: 'Same template body two.',
    });

    await importAsNewCourse(pkg1.zip, 'same-template-s1.zip');
    await importAsNewCourse(pkg2.zip, 'same-template-s2.zip');

    const spec1 = await prisma.pcContentSpec.findUnique({
      where: {
        contentKey_version: {
          contentKey: expectedContentKey(ck1, lessonCode),
          version: 1,
        },
      },
    });
    expect(spec1).not.toBeNull();
    expect(spec1?.courseKey).toBe(ck1);
    const spec2 = await prisma.pcContentSpec.findUnique({
      where: {
        contentKey_version: {
          contentKey: expectedContentKey(ck2, lessonCode),
          version: 1,
        },
      },
    });
    expect(spec2).not.toBeNull();
    expect(spec2?.courseKey).toBe(ck2);

    // 第一门课的块与 rendition 在第二门课导入后仍然完整存在。
    const blocks1 = await prisma.pcBlock.findMany({
      where: { contentKey: expectedContentKey(ck1, lessonCode), version: 1 },
    });
    expect(blocks1.length).toBeGreaterThanOrEqual(1);
    const renditions1 = await prisma.pcRendition.findMany({
      where: { contentKey: expectedContentKey(ck1, lessonCode) },
    });
    expect(renditions1.length).toBeGreaterThanOrEqual(1);
  });

  it('R15: two lessons keep their own text bodies after import (no cross-lesson overwrite)', async () => {
    const ck = `${PREFIX}-TEXT`;
    const bodyOne = '<h1>Section one</h1><p>Alpha lesson body one.</p>';
    const bodyTwo = '<h1>Section two</h1><p>Beta lesson body two.</p>';
    const course = await createTextCourse(ck, [
      { code: 'L1', title: 'Lesson one', textHtml: bodyOne },
      { code: 'L2', title: 'Lesson two', textHtml: bodyTwo },
    ]);

    const exported = await exportAndDownload(course.id);

    // 回导入同一课程（替换草稿；与 partc-package 套件同路径）。
    const stagedJob = await stageImportPackage(
      exported.manifest,
      exported.bytes,
      course.id,
    );
    await confirmToReady(stagedJob);

    // 用户路径：课程详情里两课时的正文各自保留。
    const detail = await getCourse(course.id);
    const l1 = detail.lessons.find((lesson) => lesson.code === 'L1');
    const l2 = detail.lessons.find((lesson) => lesson.code === 'L2');
    expect(l1).toBeDefined();
    expect(l2).toBeDefined();
    const l1Html = l1!.localizations?.[0]?.textHtml ?? '';
    const l2Html = l2!.localizations?.[0]?.textHtml ?? '';
    expect(l1Html).toContain('Alpha lesson body one');
    expect(l1Html).not.toContain('Beta lesson body two');
    // 修复前：两个课时都拿到全包第一个 body 块（L1 的正文），此断言红。
    expect(l2Html).toContain('Beta lesson body two');
    expect(l2Html).not.toContain('Alpha lesson body one');
  });
});
