import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import type { Response } from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { signInAs } from './helpers/employee-session';

/**
 * 长程真实测试 T3 + T4（计划 docs/Course_Category_LongRange_TestPlan.md §2）。
 *
 * 设计 SSOT：docs/Course_Category_Single_Source_Design.md §14 Part C
 * - C1/C3/C4（阶段×rendition×对齐；ALN-1/ALN-4/ALN-6、TIM-1）
 * - C5 P1–P4（parse/validate/deriveTiming/align 的失败语义）
 * - C7（每个语言独立时间源；展品多触发真值键）
 * - C10.6（provenance 与 PACKAGE_SOURCE_ENFORCEMENT）
 *
 * 覆盖：
 * - T3 阶段/rendition：同一 stageKey 同时有视频区间与文本 heading；模式切换按
 *   stageKey 而非时间；两模式覆盖不一致 → 机器报告（degraded + ALN-1 gap）。
 * - T3 展品多触发：同一展品三个不同 timeMs；同真值键重复 → error；
 *   不同展品同一时间点合法。
 * - T4 包闭合：formatVersion / templateVersion 门禁；manifest ↔ 文件一一对应
 *   （缺/多/未知/大小不符）；枚举稳定 key（显示名不参与匹配）；
 *   包内无 sha256/hash 字段；provenance 存在且导出必写；
 *   PACKAGE_SOURCE_ENFORCEMENT on/off 两态。
 *
 * 约束：
 * - 只新建测试文件；不修改生产代码。发现实现缺陷 → 用例如实红并记录证据。
 * - 黑盒：行为只经 backoffice HTTP 观察；Prisma 只用于 arrange / cleanup。
 * - 真实资产：F2 真实包（165MB，真实 docx/字幕/视频）与 F4 真实素材截取；
 *   F4 基线的 10s 视频是真实 Lesson 2 的截取，非合成“玩具视频”。
 *
 * 运行：
 *   cd server && export DATABASE_URL=postgresql://admin:admin@localhost:5432/learning_guide_e2e
 *   npx jest --config ./test/jest-e2e.json longrange-stage-package --runInBand
 */

jest.setTimeout(600_000);

const PREFIX = `E2E-LRT34-${Date.now()}`;
const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures/longrange');
const F2_ROOT = path.join(FIXTURE_ROOT, 'F2_subtitles');
const F2_PACKAGE = path.join(F2_ROOT, 'package');
const F4_ROOT = path.join(FIXTURE_ROOT, 'F4_bad_packages');
const BASELINE_ROOT = path.join(F4_ROOT, '_baseline');
const STAGING_ROOT = path.resolve(
  process.env.COURSE_PACKAGE_ROOT?.trim() || 'storage/course-package',
);

type Json = Prisma.InputJsonValue;

function json(value: unknown): Json {
  return value as Json;
}

function data<T>(res: Response): T {
  return (res.body as { data: T }).data;
}

function errorCode(res: Response): string {
  return (res.body as { error: { code: string } }).error.code;
}

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

interface PlanView {
  planId: string;
  planVersion: number;
  contentVersionId: string;
  targetId: string;
  status: 'draft' | 'degraded' | 'blocked';
  canonicalJson: string;
  entries: Array<{
    entryId: string;
    stageKey: string;
    alignmentId: string;
    orderKey: string;
    placement: {
      type: 'media' | 'document' | 'assessment' | 'gap';
      assetKey?: string;
      startMs?: number;
      endMs?: number;
      headingCode?: string;
      reason?: string;
    };
    status: 'ok' | 'degraded' | 'blocked';
  }>;
  warnings: Array<{ code: string; stageKey?: string; entryId?: string }>;
  gaps: Array<{
    invariant: string;
    status: 'blocked' | 'degraded';
    message: string;
    stageKey?: string;
    reason?: string;
    details?: { modality?: string };
  }>;
  issues: Array<{ code: string; severity: string; message: string }>;
}

interface PreviewLesson {
  code: string;
  learningPoints: Array<{ code: string; timeSeconds: number | null }>;
  exhibits: Array<{
    code: string;
    triggers: Array<{ language: string; timeSeconds: number }>;
  }>;
}

// ---------------------------------------------------------------------------
// ZIP / XLSX 变体构造（只读真实素材，不触碰 src/）
// ---------------------------------------------------------------------------

async function readBytes(file: string): Promise<Buffer> {
  return fs.readFile(file);
}

interface PackageVariant {
  bytes: Buffer;
  manifest: Record<string, unknown> & {
    resources: Array<{ id: string; kind: string; path: string; size: number }>;
  };
}

async function openZip(bytes: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(bytes);
}

async function zipBytes(zip: JSZip): Promise<Buffer> {
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function readWorkbook(bytes: Buffer): Record<string, unknown[][]> {
  const wb = XLSX.read(bytes, { type: 'buffer' });
  const sheets: Record<string, unknown[][]> = {};
  for (const name of wb.SheetNames) {
    sheets[name] = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], {
      header: 1,
      defval: null,
      raw: true,
    });
  }
  return sheets;
}

function writeWorkbook(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** 把包内 template.xlsx 读出来、交给 mutate、写回 zip 并同步 manifest 大小。 */
async function rewriteTemplate(
  zip: JSZip,
  manifest: PackageVariant['manifest'],
  mutate: (sheets: Record<string, unknown[][]>) => void,
): Promise<void> {
  const bytes = await zip.file('template.xlsx')!.async('nodebuffer');
  const sheets = readWorkbook(bytes);
  mutate(sheets);
  const next = writeWorkbook(sheets);
  zip.file('template.xlsx', next);
  const resource = manifest.resources.find(
    (entry) => entry.kind === 'template',
  );
  if (resource) resource.size = next.length;
}

async function loadBaselineVariant(): Promise<{
  zip: JSZip;
  manifest: PackageVariant['manifest'];
}> {
  // 用 baseline 目录重新打 zip（所有用例的单一基线，避免依赖某个缺陷包）。
  const baselineZip = new JSZip();
  const manifest = JSON.parse(
    await readBytes(path.join(BASELINE_ROOT, 'manifest.json')).then((b) =>
      b.toString('utf8'),
    ),
  ) as PackageVariant['manifest'];
  baselineZip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, `${prefix}${entry.name}/`);
      } else {
        baselineZip.file(`${prefix}${entry.name}`, await readBytes(full));
      }
    }
  };
  await walk(path.join(BASELINE_ROOT, 'media'), 'media/');
  await walk(path.join(BASELINE_ROOT, 'subtitles'), 'subtitles/');
  baselineZip.file(
    'template.xlsx',
    await readBytes(path.join(BASELINE_ROOT, 'template.xlsx')),
  );
  return { zip: baselineZip, manifest };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 在真实 docx 的正文末尾插入 [Exhibit: code] 段落（真实 docx + 测试标记）。 */
async function docxWithMarkers(
  docxBytes: Buffer,
  markers: ReadonlyArray<{ exhibitCode: string; lineText: string }>,
): Promise<Buffer> {
  const zip = await openZip(docxBytes);
  let xml = await zip.file('word/document.xml')!.async('string');
  const paragraphs = markers
    .map(
      (marker) =>
        `<w:p><w:r><w:t xml:space="preserve">${escapeXml(
          `[Exhibit: ${marker.exhibitCode}] ${marker.lineText}`,
        )}</w:t></w:r></w:p>`,
    )
    .join('');
  if (/<w:sectPr[\s\S]*?<\/w:sectPr>/.test(xml)) {
    xml = xml.replace(/(<w:sectPr[\s\S]*?<\/w:sectPr>)/, `${paragraphs}$1`);
  } else {
    xml = xml.replace('</w:body>', `${paragraphs}</w:body>`);
  }
  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

interface VariantOptions {
  courseKey: string;
  lessonCode: string;
  srt?: string;
  docx?: {
    bytes: Buffer;
    markers: ReadonlyArray<{ exhibitCode: string; lineText: string }>;
  };
  exhibits?: ReadonlyArray<{
    code: string;
    assetKey: string;
    path: string;
    bytes: Buffer;
  }>;
  provenanceSourceEnv?: 'sandbox' | 'production';
}

/**
 * 从 F4 真实素材基线生成一个“键全局唯一”的合法 Part C v2 包：
 * courseKey/lesson/stage/objective/evidence/content/assets 全部加前缀，
 * 模板 Meta/Media/Lessons/LP/Exhibits 同步改写。
 */
async function buildUniqueVariant(
  options: VariantOptions,
): Promise<PackageVariant> {
  const { zip, manifest } = await loadBaselineVariant();
  const key = options.courseKey;
  const lesson = options.lessonCode;
  const docAsset = `${key}-doc`;
  const imageAssets = options.exhibits ?? [];
  const coverKey = `${key}-cover`;
  const videoKey = `${key}-video`;
  const subKey = `${key}-sub`;
  const docPath = `lessons/${lesson}.en-GB.docx`;

  manifest.course = {
    courseKey: key,
    titleLocalized: { 'en-GB': { title: `${key} title` } },
    categoryPath: (manifest.course as { categoryPath?: unknown }).categoryPath,
    learningLanguages: ['en-GB'],
    studyMode: 'video',
  };
  const content = manifest.content as Record<string, unknown>;
  content.courseKey = key;
  content.specPins = [{ contentKey: lesson, version: 1 }];
  content.stages = [
    {
      courseKey: key,
      stageKey: `${key}-program`,
      parentStageKey: null,
      orderKey: '000001',
      kind: 'program',
      goal: `${key} programme`,
      objectiveKeys: [],
      exitEvidence: [],
      exitRollup: { kind: 'all' },
      status: 'active',
    },
    {
      courseKey: key,
      stageKey: `${key}-lesson`,
      parentStageKey: `${key}-program`,
      orderKey: '000001.000001',
      kind: 'step',
      goal: `${key} lesson`,
      objectiveKeys: [`${key}-obj`],
      exitEvidence: [`${key}-ev`],
      exitRollup: { kind: 'all' },
      status: 'active',
    },
  ];
  content.evidenceSpecs = [
    {
      evidenceKey: `${key}-ev`,
      version: 1,
      kind: 'artifact',
      objectiveKeys: [`${key}-obj`],
      measure: { kind: 'artifact', instructions: 'Complete the artefact.' },
      scoring: 'pass-fail',
      threshold: 1,
      attempts: 1,
    },
  ];
  const assetPins = [{ assetKey: coverKey, assetVersion: 1 }];
  assetPins.push({ assetKey: videoKey, assetVersion: 1 });
  assetPins.push({ assetKey: subKey, assetVersion: 1 });
  if (options.docx) assetPins.push({ assetKey: docAsset, assetVersion: 1 });
  for (const exhibit of imageAssets) {
    assetPins.push({ assetKey: exhibit.assetKey, assetVersion: 1 });
  }
  content.assetPins = assetPins;

  const resources = [
    { id: 'template', kind: 'template', path: 'template.xlsx', size: 0 },
    { id: coverKey, kind: 'cover', path: 'media/cover.png', size: 0 },
    { id: videoKey, kind: 'video', path: 'media/bad-video.mp4', size: 0 },
    {
      id: subKey,
      kind: 'subtitle',
      path: `subtitles/${lesson}.en-GB.srt`,
      size: 0,
    },
  ];
  if (options.docx) {
    resources.push({ id: docAsset, kind: 'document', path: docPath, size: 0 });
  }
  resources.push(
    ...imageAssets.map((exhibit) => ({
      id: exhibit.assetKey,
      kind: 'image',
      path: exhibit.path,
      size: 0,
    })),
  );
  manifest.resources = resources;

  const provenance = manifest.provenance as Record<string, unknown>;
  provenance.sourceEnv = options.provenanceSourceEnv ?? 'sandbox';
  provenance.sourceVersionLabel = '9.9';
  provenance.exportedBy = 'longrange-t34@example.com';
  provenance.courseKey = key;
  provenance.planPin = {
    planId: `plan/${key}/export-9.9/target-default/v1`,
    planVersion: 1,
  };
  provenance.approvalRef = 'APPROVAL-T34';
  provenance.auditSummaryRef = `audit/${key}/9.9.json`;
  (manifest as Record<string, unknown>).packageId = `pkg_${key}`;
  manifest.annotations = {
    slug: key.toLowerCase(),
    generatedBy: 'longrange-t34',
  };

  // 模板：Meta / Media / Lessons / Learning Points / Exhibits 全部改为稳定键。
  await rewriteTemplate(zip, manifest, (sheets) => {
    sheets.Meta = [sheets.Meta[0], [2, key, 'en-GB', 'video']];
    const mediaRows: unknown[][] = [
      [
        'asset_key',
        'kind',
        'lesson_code',
        'language',
        'relative_path',
        'thumbnail_of',
      ],
      [coverKey, 'cover', null, null, 'media/cover.png', null],
      [videoKey, 'video', lesson, 'en-GB', 'media/bad-video.mp4', null],
      [
        subKey,
        'subtitle',
        lesson,
        'en-GB',
        `subtitles/${lesson}.en-GB.srt`,
        null,
      ],
    ];
    if (options.docx) {
      mediaRows.push([docAsset, 'lesson-text', lesson, 'en-GB', docPath, null]);
    }
    for (const exhibit of imageAssets) {
      mediaRows.push([
        exhibit.assetKey,
        'image',
        lesson,
        'en-GB',
        exhibit.path,
        null,
      ]);
    }
    sheets.Media = mediaRows;
    sheets.Lessons = [
      ['lesson_code', 'order', 'language', 'title', 'description'],
      [lesson, 1, 'en-GB', 'Baseline lesson', 'Baseline description'],
    ];
    sheets['Learning Points'] = [
      ['lesson_code', 'lp_code', 'language', 'title'],
      [lesson, '1.1', 'en-GB', 'Baseline learning point'],
    ];
    sheets.Exhibits = [
      [
        'lesson_code',
        'exhibit_code',
        'media_type',
        'asset_key',
        'language',
        'title',
        'description',
        'source',
      ],
      ...imageAssets.map((exhibit, index) => [
        lesson,
        exhibit.code,
        'image',
        exhibit.assetKey,
        'en-GB',
        `Exhibit ${index + 1}`,
        `Exhibit ${exhibit.code} description`,
        null,
      ]),
    ];
    sheets['Course Info'] = [
      ['field', 'language', 'text'],
      ['title', 'en-GB', `${key} title`],
      ['shortDescription', 'en-GB', 'Long-range T3/T4 fixture'],
      ['overview', 'en-GB', 'Long-range T3/T4 fixture overview'],
      ['whatYouLearn', 'en-GB', 'Stage and package closure'],
    ];
    sheets['Knowledge Test'] = [
      ['lesson_code', 'order', 'language', 'question', 'reference_answer'],
    ];
    sheets['Application Test'] = [
      ['lesson_code', 'language', 'question', 'reference_answer'],
    ];
  });

  const srtBytes =
    options.srt !== undefined
      ? Buffer.from(options.srt, 'utf8')
      : await zip.file(`subtitles/BL1.en-GB.srt`)!.async('nodebuffer');
  zip.file(`subtitles/${lesson}.en-GB.srt`, srtBytes);
  // 旧 BL1 字幕路径不在 resources 中：删掉，保持包闭合。
  zip.remove('subtitles/BL1.en-GB.srt');

  if (options.docx) {
    const docx = await docxWithMarkers(
      options.docx.bytes,
      options.docx.markers,
    );
    zip.file(docPath, docx);
  }
  for (const exhibit of imageAssets) {
    zip.file(exhibit.path, exhibit.bytes);
  }

  const bytesByPath = new Map<string, number>();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    bytesByPath.set(name, (await entry.async('nodebuffer')).length);
  }
  for (const resource of manifest.resources) {
    const size = bytesByPath.get(resource.path);
    if (size === undefined) {
      throw new Error(`variant resource missing from zip: ${resource.path}`);
    }
    resource.size = size;
  }

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  return { bytes: await zipBytes(zip), manifest };
}

/** 只改一个维度、不需要成功导入的基线变体。 */
async function buildDefectVariant(
  mutate: (ctx: {
    sheets: Record<string, unknown[][]>;
    manifest: PackageVariant['manifest'];
  }) => void,
  zipMutate?: (zip: JSZip) => Promise<void> | void,
): Promise<Buffer> {
  const { zip, manifest } = await loadBaselineVariant();
  const templateBytes = await zip.file('template.xlsx')!.async('nodebuffer');
  const sheets = readWorkbook(templateBytes);
  mutate({ sheets, manifest });
  const nextTemplate = writeWorkbook(sheets);
  zip.file('template.xlsx', nextTemplate);
  const templateResource = manifest.resources.find(
    (resource) => resource.kind === 'template',
  );
  if (templateResource) templateResource.size = nextTemplate.length;
  if (zipMutate) await zipMutate(zip);
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  return zipBytes(zip);
}

/** 伪造 provenance 的 legacy 聚合包（非 v2 契约，只满足 legacy 上传校验）。 */
async function forgedLegacyZip(courseCode: string): Promise<Buffer> {
  const zip = new JSZip();
  const manifest = {
    format: 'lg-course-package',
    formatVersion: 2,
    packageId: `pkg_forged_${courseCode}`,
    exportedAt: '2026-11-13T00:00:00Z',
    minReaderVersion: 2,
    extensionsUsed: [],
    extensionsRequired: [],
    provenance: {
      sourceEnv: 'sandbox',
      sourceVersionLabel: '1.0',
      exportedAt: '2026-11-13T00:00:00Z',
      exportedBy: 'forger@example.com',
      courseKey: courseCode,
      planPin: { planId: `plan/${courseCode}/x/v1`, planVersion: 1 },
      approvalRef: 'FORGED',
      auditSummaryRef: 'forged',
    },
    course: {
      code: courseCode,
      slug: courseCode.toLowerCase(),
      learningMode: 'VIDEO_AND_TEXT',
      learningLanguages: ['en-GB'],
      defaultContentLanguage: 'en-GB',
      categoryPath: ['Science'],
      localized: {
        'en-GB': {
          title: courseCode,
          shortDescription: 'forged legacy package',
          overview: 'forged legacy package',
          whatYouLearn: ['x'],
        },
      },
      lessons: [],
    },
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  return zipBytes(zip);
}

function forbiddenHashKeys(value: unknown, trail: string[] = []): string[] {
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      hits.push(...forbiddenHashKeys(item, [...trail, String(index)])),
    );
    return hits;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/sha[-_]?256|checksum|digest|hash|fingerprint|md5/i.test(key)) {
        hits.push([...trail, key].join('.'));
      }
      hits.push(...forbiddenHashKeys(child, [...trail, key]));
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 主套件
// ---------------------------------------------------------------------------

describe('Long-range T3/T4: stage/rendition and package closure (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let agent: Awaited<ReturnType<typeof signInAs>>;
  const createdJobIds: string[] = [];
  const createdCourseIds: string[] = [];
  const createdCourseCodes: string[] = [];

  async function buildApp(env: {
    numbering?: 'sandbox' | 'production';
    enforcement?: 'on' | 'off';
    sourceEnforcement?: 'on' | 'off';
  }): Promise<INestApplication<App>> {
    if (env.numbering) process.env.VERSION_NUMBERING_MODE = env.numbering;
    else delete process.env.VERSION_NUMBERING_MODE;
    if (env.enforcement)
      process.env.ENV_CAPABILITY_ENFORCEMENT = env.enforcement;
    else delete process.env.ENV_CAPABILITY_ENFORCEMENT;
    if (env.sourceEnforcement)
      process.env.PACKAGE_SOURCE_ENFORCEMENT = env.sourceEnforcement;
    else delete process.env.PACKAGE_SOURCE_ENFORCEMENT;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const created = moduleFixture.createNestApplication();
    configureApp(created);
    await created.init();
    return created;
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

  async function getJob(jobId: string): Promise<JobView> {
    const res = await agent
      .get(`/api/backoffice/courses/import/${jobId}`)
      .expect(200);
    return data<JobView>(res);
  }

  function confirmImport(jobId: string): Promise<Response> {
    return agent
      .post(`/api/backoffice/courses/import/${jobId}/confirm`)
      .send({ onConflict: 'ABORT' });
  }

  async function confirmToReady(jobId: string): Promise<{ courseId: string }> {
    const res = await confirmImport(jobId);
    if (res.status !== 200) {
      const job = await getJob(jobId);
      throw new Error(
        `confirm failed (${res.status}): ${JSON.stringify(res.body)} report=${JSON.stringify(job.report)}`,
      );
    }
    const view = data<{ status: string; courseId: string }>(res);
    expect(view.status).toBe('READY');
    createdCourseIds.push(view.courseId);
    return { courseId: view.courseId };
  }

  function binaryParser(
    res: NodeJS.ReadableStream,
    callback: (error: Error | null, body?: Buffer) => void,
  ): void {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
    res.on('error', (error) => callback(error));
  }

  async function exportAndDownload(courseId: string): Promise<{
    bytes: Buffer;
    manifest: Record<string, unknown>;
    zip: JSZip;
  }> {
    const started = await agent
      .post(`/api/backoffice/courses/${courseId}/export`)
      .send({ version: 'working' })
      .expect(202);
    const jobId = data<{ jobId: string }>(started).jobId;
    createdJobIds.push(jobId);
    const deadline = Date.now() + 120_000;
    let status = '';
    while (Date.now() < deadline) {
      const job = await agent
        .get(`/api/backoffice/courses/export/${jobId}`)
        .expect(200);
      const view = data<JobView>(job);
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
    const zip = await openZip(bytes);
    const manifest = JSON.parse(
      await zip.file('manifest.json')!.async('string'),
    ) as Record<string, unknown>;
    return { bytes, manifest, zip };
  }

  async function previewOf(courseId: string): Promise<PreviewLesson[]> {
    const res = await agent
      .get(`/api/backoffice/courses/${courseId}/preview`)
      .expect(200);
    return data<{ lessons: PreviewLesson[] }>(res).lessons;
  }

  // ---- arrange：Part C 计划预览（stage/rendition）-----------

  interface ModeFixture {
    courseKey: string;
    lessonKey: string;
    ktKey: string;
    obj1: string;
    obj2: string;
    ev1: string;
    ev2: string;
  }

  async function seedModeFixture(suffix: string): Promise<ModeFixture> {
    const courseKey = `${PREFIX}-${suffix}`;
    const lessonKey = `${courseKey}-lesson`;
    const ktKey = `${courseKey}-kt`;
    const obj1 = `${courseKey}-obj-1`;
    const obj2 = `${courseKey}-obj-2`;
    const ev1 = `${courseKey}-ev-1`;
    const ev2 = `${courseKey}-ev-2`;
    await prisma.pcCourse.create({
      data: {
        courseKey,
        categoryPath: Prisma.DbNull,
        titleLocalized: json({ 'en-GB': { title: `${courseKey} title` } }),
        publishTargets: json([
          { languages: ['en-GB'], modalities: ['video', 'text'] },
        ]),
      },
    });
    await prisma.pcObjective.createMany({
      data: [
        { objectiveKey: obj1, statement: 'Objective one', status: 'active' },
        { objectiveKey: obj2, statement: 'Objective two', status: 'active' },
      ],
    });
    await prisma.pcContentSpec.createMany({
      data: [
        {
          contentKey: lessonKey,
          version: 1,
          type: 'video',
          titleLocalized: json({ 'en-GB': { title: 'Lesson' } }),
        },
        {
          contentKey: ktKey,
          version: 1,
          type: 'knowledge-test',
          titleLocalized: json({ 'en-GB': { title: 'Knowledge test' } }),
        },
      ],
    });
    await prisma.pcMediaAsset.create({
      data: {
        assetKey: `${courseKey}-video`,
        assetVersion: 1,
        kind: 'video',
        language: 'en-GB',
        durationMs: 60_000,
        uri: `test:${courseKey}/video.mp4`,
      },
    });
    await prisma.pcRendition.createMany({
      data: [
        {
          renditionKey: `${courseKey}-r-video`,
          contentKey: lessonKey,
          blockId: 'video',
          language: 'en-GB',
          modality: 'video',
          occurrenceKey: 'main',
          carrierType: 'asset',
          carrierKey: `${courseKey}-video`,
          carrierVersion: 1,
          startMs: 0,
          endMs: 60_000,
          anchorSource: 'subtitle',
          revision: 1,
        },
        {
          renditionKey: `${courseKey}-r-text`,
          contentKey: lessonKey,
          blockId: 'body',
          language: 'en-GB',
          modality: 'text',
          occurrenceKey: 'main',
          carrierType: 'document',
          carrierKey: `${courseKey}-doc`,
          carrierVersion: 1,
          headingCode: 'H1',
          offset: 0,
          anchorSource: 'doc-structure',
          revision: 1,
        },
        {
          renditionKey: `${courseKey}-r-kt`,
          contentKey: ktKey,
          blockId: 'q.1',
          language: 'en-GB',
          modality: 'text',
          occurrenceKey: 'main',
          carrierType: 'document',
          carrierKey: `${courseKey}-kt-doc`,
          carrierVersion: 1,
          anchorSource: 'doc-structure',
          revision: 1,
        },
      ],
    });
    return { courseKey, lessonKey, ktKey, obj1, obj2, ev1, ev2 };
  }

  function stageBody(fixture: ModeFixture) {
    return {
      stages: [
        {
          stageKey: `${fixture.courseKey}-program`,
          parentStageKey: null,
          kind: 'program',
          goal: 'Programme',
          objectiveKeys: [],
          exitEvidence: [],
        },
        {
          stageKey: `${fixture.courseKey}-step-1`,
          parentStageKey: `${fixture.courseKey}-program`,
          kind: 'step',
          goal: 'Dual-mode step',
          objectiveKeys: [fixture.obj1],
          exitEvidence: [fixture.ev1],
        },
        {
          stageKey: `${fixture.courseKey}-step-2`,
          parentStageKey: `${fixture.courseKey}-program`,
          kind: 'step',
          goal: 'Video-only step',
          objectiveKeys: [fixture.obj2],
          exitEvidence: [fixture.ev2],
        },
      ],
      prerequisiteEdges: [],
    };
  }

  async function seedModeAlignments(fixture: ModeFixture): Promise<void> {
    const verifiedAgainst = json({
      renditionRevision: 1,
      carrierVersion: 1,
      specVersion: 1,
    });
    const step1 = `${fixture.courseKey}-step-1`;
    const step2 = `${fixture.courseKey}-step-2`;
    await prisma.pcAlignment.createMany({
      data: [
        {
          alignmentId: `${fixture.courseKey}-a-video`,
          stageKey: step1,
          renditionKey: `${fixture.courseKey}-r-video`,
          objectiveKey: fixture.obj1,
          role: 'primary',
          status: 'verified',
          provenance: 'human',
          verifiedBy: 'e2e-editor',
          verifiedAt: new Date('2026-11-13T09:00:00Z'),
          verifiedAgainst,
        },
        {
          alignmentId: `${fixture.courseKey}-a-text`,
          stageKey: step1,
          renditionKey: `${fixture.courseKey}-r-text`,
          objectiveKey: fixture.obj1,
          role: 'support',
          status: 'verified',
          provenance: 'human',
          verifiedBy: 'e2e-editor',
          verifiedAt: new Date('2026-11-13T09:01:00Z'),
          verifiedAgainst,
        },
        {
          alignmentId: `${fixture.courseKey}-a-assessment-1`,
          stageKey: step1,
          renditionKey: `${fixture.courseKey}-r-kt`,
          objectiveKey: fixture.obj1,
          role: 'assessment',
          status: 'verified',
          provenance: 'human',
          verifiedBy: 'e2e-editor',
          verifiedAt: new Date('2026-11-13T09:02:00Z'),
          verifiedAgainst,
        },
        {
          alignmentId: `${fixture.courseKey}-a-video-2`,
          stageKey: step2,
          renditionKey: `${fixture.courseKey}-r-video`,
          objectiveKey: fixture.obj2,
          role: 'primary',
          status: 'verified',
          provenance: 'human',
          verifiedBy: 'e2e-editor',
          verifiedAt: new Date('2026-11-13T09:03:00Z'),
          verifiedAgainst,
        },
      ],
    });
  }

  async function setupModePreview(
    suffix: string,
  ): Promise<{ fixture: ModeFixture; plan: PlanView }> {
    const fixture = await seedModeFixture(suffix);
    const base = `/api/backoffice/courses/${fixture.courseKey}/partc`;
    // 证据规格先落库（stage 的 exitEvidence 必须可解析，STR-5 编辑期检查）。
    const specs: Array<{ evidenceKey: string; body: unknown }> = [
      {
        evidenceKey: fixture.ev1,
        body: {
          kind: 'assessment',
          objectiveKeys: [fixture.obj1],
          measure: {
            kind: 'assessment',
            contentKey: fixture.ktKey,
            blockIds: ['q.1'],
          },
          scoring: 'points',
          threshold: 0.6,
          attempts: 2,
        },
      },
      {
        // step-2 用 artifact 证据：只缺文本 rendition，不引入评估 rendition
        // （否则 kt 的 text 模态会被算作文本覆盖，掩盖跨模式缺口）。
        evidenceKey: fixture.ev2,
        body: {
          kind: 'artifact',
          objectiveKeys: [fixture.obj2],
          measure: { kind: 'artifact', instructions: 'Submit the artefact.' },
          scoring: 'pass-fail',
          threshold: 1,
          attempts: 1,
        },
      },
    ];
    for (const spec of specs) {
      const res = await agent
        .put(`${base}/evidence-specs/${spec.evidenceKey}`)
        .send(spec.body);
      expect(res.status).toBe(200);
    }
    const stages = await agent.put(`${base}/stages`).send(stageBody(fixture));
    expect(stages.status).toBe(200);
    await seedModeAlignments(fixture);
    const preview = await agent.post(`${base}/plans/preview`).send({});
    expect(preview.status).toBe(200);
    return { fixture, plan: data<PlanView>(preview) };
  }

  // ---- 生命周期 -----------------------------------------------------------

  beforeAll(async () => {
    app = await buildApp({});
    prisma = app.get(PrismaService);
    agent = await signInAs(app, 'ADMIN');
  });

  afterAll(async () => {
    delete process.env.ENV_CAPABILITY_ENFORCEMENT;
    delete process.env.VERSION_NUMBERING_MODE;
    delete process.env.PACKAGE_SOURCE_ENFORCEMENT;
    for (const code of createdCourseCodes) {
      await prisma.commerceCourse
        .deleteMany({ where: { code } })
        .catch(() => undefined);
    }
    await prisma.commerceCourse
      .deleteMany({ where: { code: { startsWith: PREFIX } } })
      .catch(() => undefined);
    // pc_* 无跨域外键，按前缀清理（arrange 与导入的 Part C 实体）。
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
      .deleteMany({ where: { evidenceKey: { startsWith: PREFIX } } })
      .catch(() => undefined);
    await prisma.pcObjective
      .deleteMany({ where: { objectiveKey: { startsWith: PREFIX } } })
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
    await app.close();
  });

  // =========================================================================
  // T4-0 真实 165MB 包整体过 v2 校验（真实 zip + 真实媒体，无玩具视频）
  // =========================================================================

  it('T4-0 accepts the genuine 165MB Modeling life package (F2) through Part C v2 validation', async () => {
    const bytes = await readBytes(
      path.join(FIXTURE_ROOT, 'F2_subtitles', 'F2_subtitles.zip'),
    );
    expect(bytes.length).toBeGreaterThan(150 * 1024 * 1024);
    const job = await uploadPackage(bytes, 'F2_subtitles.zip');
    expect(job.status).toBe('AWAITING_CONFIRM');
    expect(job.package?.courseCode).toBe('modeling-life');
    expect(job.report.errors).toEqual([]);
  });

  // =========================================================================
  // T3-a 阶段/rendition：同一 stage 双模式 + 切换按 stageKey
  // =========================================================================

  it('T3-1 same stageKey carries both a video interval and a text heading; switching is keyed by stageKey', async () => {
    const { fixture, plan } = await setupModePreview('MODE');
    const stepKey = `${fixture.courseKey}-step-1`;
    const stepEntries = plan.entries.filter(
      (entry) => entry.stageKey === stepKey,
    );
    const media = stepEntries.filter(
      (entry) => entry.placement.type === 'media',
    );
    const document = stepEntries.filter(
      (entry) => entry.placement.type === 'document',
    );

    // 同一 stageId 同时有视频区间与文本 heading（不是两套独立 LP）。
    expect(media.length).toBeGreaterThanOrEqual(1);
    expect(document.length).toBeGreaterThanOrEqual(1);
    expect(media[0].placement.startMs).toBe(0);
    expect(media[0].placement.endMs).toBe(60_000);
    expect(document[0].placement.headingCode).toBe('H1');

    // 模式切换按 stageKey：两条 entry 同一 stageKey、同一阶序 rank 段，
    // 没有按时间（startMs）另造 stage。
    expect(new Set(stepEntries.map((entry) => entry.stageKey))).toEqual(
      new Set([stepKey]),
    );
    const rankOf = (orderKey: string) => orderKey.split('.')[0];
    expect(
      new Set(stepEntries.map((entry) => rankOf(entry.orderKey))).size,
    ).toBe(1);
    expect(plan.canonicalJson).not.toMatch(/time-based-stage/i);
  });

  // =========================================================================
  // T3-b 两模式不一致 → 机器报告（degraded + ALN-1 gap）
  // =========================================================================

  it('T3-2 cross-mode coverage mismatch is reported by the machine (ALN-1 degraded gap), not silently accepted', async () => {
    const { fixture, plan } = await setupModePreview('MISMATCH');
    const step2 = `${fixture.courseKey}-step-2`;

    const modalityGap = plan.gaps.find(
      (gap) =>
        gap.stageKey === step2 &&
        gap.invariant === 'ALN-1' &&
        gap.status === 'degraded' &&
        gap.details?.modality === 'text',
    );
    expect(modalityGap).toBeDefined();
    expect(modalityGap!.message).toContain('text modality');

    // 机器报告进入 plan status 与 warnings（不静默各自成立）。
    expect(plan.status).toBe('degraded');
    expect(
      plan.warnings.some(
        (warning) =>
          warning.code === 'DEGRADED_PLACEMENT' && warning.stageKey === step2,
      ),
    ).toBe(true);
    expect(plan.gaps.some((gap) => gap.stageKey === step2)).toBe(true);
    // 另一模式（step-1 双模式）不受影响，仍各有条目。
    expect(
      plan.entries.filter((entry) => entry.stageKey === step2).length,
    ).toBeGreaterThan(0);
  });

  // =========================================================================
  // T3-c 展品多触发 / 真值键 / 不同展品同时间
  // =========================================================================

  const exhibitCourseKey = `${PREFIX}-EXHIBIT`;
  let exhibitImportPromise: Promise<{ courseId: string }> | undefined;
  let exhibitExportPromise:
    | Promise<{ bytes: Buffer; manifest: Record<string, unknown>; zip: JSZip }>
    | undefined;

  async function buildExhibitPackage(
    courseKey: string,
    markers: ReadonlyArray<{ exhibitCode: string; lineText: string }>,
  ): Promise<PackageVariant> {
    const docx = await readBytes(path.join(F2_PACKAGE, 'lessons', 'l1.docx'));
    const ex1 = await readBytes(path.join(F2_PACKAGE, 'media', 'l1-ex1.png'));
    const ex2 = await readBytes(path.join(F2_PACKAGE, 'media', 'l1-ex2.png'));
    const srt = [
      '1',
      '00:00:00,500 --> 00:00:02,000',
      'Baseline learning point',
      '',
      '2',
      '00:00:02,500 --> 00:00:04,000',
      'alpha one',
      '',
      '3',
      '00:00:04,500 --> 00:00:06,000',
      'bravo two',
      '',
      '4',
      '00:00:06,500 --> 00:00:08,000',
      'charlie three',
      '',
      '5',
      '00:00:08,500 --> 00:00:09,900',
      'delta four',
      '',
    ].join('\n');
    return buildUniqueVariant({
      courseKey,
      lessonCode: `${courseKey}-L1`,
      srt,
      docx: { bytes: docx, markers },
      exhibits: [
        {
          code: 'EX1',
          assetKey: `${courseKey}-ex1`,
          path: 'media/ex1.png',
          bytes: ex1,
        },
        {
          code: 'EX2',
          assetKey: `${courseKey}-ex2`,
          path: 'media/ex2.png',
          bytes: ex2,
        },
      ],
    });
  }

  /**
   * 真实 Part C v2 包导入（真实 docx + 真实媒体截取 + 真实展品图）。
   * EX1 有三条不同 cue（bravo/alpha/charlie）；EX2 与 EX1 的 bravo 同时间。
   */
  async function ensureExhibitImported(): Promise<{ courseId: string }> {
    if (exhibitImportPromise === undefined) {
      exhibitImportPromise = (async () => {
        const built = await buildExhibitPackage(exhibitCourseKey, [
          { exhibitCode: 'EX1', lineText: 'bravo two' },
          { exhibitCode: 'EX1', lineText: 'alpha one' },
          { exhibitCode: 'EX1', lineText: 'charlie three' },
          { exhibitCode: 'EX2', lineText: 'bravo two' },
        ]);
        createdCourseCodes.push(exhibitCourseKey);
        const job = await uploadPackage(
          built.bytes,
          `${exhibitCourseKey}-sandbox.zip`,
        );
        expect(job.status).toBe('AWAITING_CONFIRM');
        expect(job.report.errors).toEqual([]);
        const ready = await confirmToReady(job.jobId);
        return ready;
      })();
    }
    return exhibitImportPromise;
  }

  async function ensureExhibitExport(): Promise<{
    bytes: Buffer;
    manifest: Record<string, unknown>;
    zip: JSZip;
  }> {
    if (exhibitExportPromise === undefined) {
      exhibitExportPromise = ensureExhibitImported().then(({ courseId }) =>
        exportAndDownload(courseId),
      );
    }
    return exhibitExportPromise;
  }

  it('T3-3 same exhibit at three distinct timeMs yields three triggers in both preview and the exported package', async () => {
    const { courseId } = await ensureExhibitImported();
    const lessons = await previewOf(courseId);
    const lesson = lessons.find(
      (entry) => entry.code === `${exhibitCourseKey}-L1`,
    );
    expect(lesson).toBeDefined();
    const previewEx1 = lesson!.exhibits.find(
      (exhibit) => exhibit.code === 'EX1',
    )!;
    const previewTimes = previewEx1.triggers.map(
      (trigger) => trigger.timeSeconds,
    );

    const exported = await ensureExhibitExport();
    const renditions =
      (
        exported.manifest.content as {
          renditions?: Array<{
            blockId: string;
            modality: string;
            occurrenceKey: string;
            startMs?: number;
          }>;
        }
      ).renditions ?? [];
    const exportEx1 = renditions.filter(
      (rendition) =>
        rendition.blockId === 'EX1' &&
        rendition.modality === 'video' &&
        rendition.occurrenceKey.startsWith('trigger'),
    );
    const exportTimes = exportEx1.map((rendition) => rendition.startMs);

    // 诊断（不作断言，仅用于把缺陷定位到“派生层 vs 投影层”）：Part C 派生结果
    // 本身保留了几条触发 rendition。断言仍只使用 HTTP 输出（preview / 导出包）。
    const partcDerivedCount = await prisma.pcRendition.count({
      where: {
        contentKey: `${exhibitCourseKey}-L1`,
        blockId: 'EX1',
        modality: 'video',
      },
    });

    console.log(
      'T3-3 diagnostic: partcDerivedCount=%d previewTimes=%j exportTimes=%j',
      partcDerivedCount,
      previewTimes,
      exportTimes,
    );

    // 设计：同一展品同一视频的多个时间点是内容事实（真值键含 timeMs），
    // 预览与导出都必须保留三条。当前实现把 legacy 投影折叠成一条 → 红。
    expect({
      previewCount: previewTimes.length,
      exportCount: exportEx1.length,
    }).toEqual({
      previewCount: 3,
      exportCount: 3,
    });
    expect(new Set(previewTimes).size).toBe(3);
    expect(new Set(exportTimes).size).toBe(3);
  });

  it('T3-4 different exhibits at the same time are legal (both retained)', async () => {
    const { courseId } = await ensureExhibitImported();
    const lessons = await previewOf(courseId);
    const lesson = lessons.find(
      (entry) => entry.code === `${exhibitCourseKey}-L1`,
    )!;
    const ex1 = lesson.exhibits.find((exhibit) => exhibit.code === 'EX1')!;
    const ex2 = lesson.exhibits.find((exhibit) => exhibit.code === 'EX2')!;
    const ex1Times = ex1.triggers.map((trigger) => trigger.timeSeconds);
    const ex2Times = ex2.triggers.map((trigger) => trigger.timeSeconds);
    // 不同展品同一时间点合法：真值键含 exhibitId；两条都在且时间相交。
    expect(ex2Times.length).toBeGreaterThanOrEqual(1);
    expect(ex1Times.some((time) => ex2Times.includes(time))).toBe(true);
  });

  it('T3-5 duplicate exhibit trigger truth key (same lesson/exhibit/language/timeMs) is an error at import', async () => {
    // 独立 courseKey，避免与 T3-3/T3-4 的已导入课程冲突（confirm 冲突路径
    // 不会进入 Part C 编译，测不到真值键错误）。
    const duplicateKey = `${PREFIX}-EXHIBIT-DUP`;
    createdCourseCodes.push(duplicateKey);
    const duplicate = await buildExhibitPackage(duplicateKey, [
      { exhibitCode: 'EX1', lineText: 'alpha one' },
      { exhibitCode: 'EX1', lineText: 'alpha one' },
    ]);
    const job = await uploadPackage(
      duplicate.bytes,
      `${PREFIX}-DUP-sandbox.zip`,
    );
    expect(job.status).toBe('AWAITING_CONFIRM');
    const confirm = await confirmImport(job.jobId);
    expect(confirm.status).toBe(422);
    expect(errorCode(confirm)).toBe('TIMING_AMBIGUOUS');

    const failed = await getJob(job.jobId);
    expect(failed.status).toBe('FAILED');
    const duplicateError = failed.report.errors.find(
      (error) => error.code === 'TIMING_AMBIGUOUS',
    );
    expect(duplicateError).toBeDefined();
    expect(duplicateError?.message ?? '').toContain(
      'duplicate exhibit trigger truth key',
    );
  });

  // =========================================================================
  // T4-1 formatVersion / templateVersion 门禁
  // =========================================================================

  it('T4-1 rejects missing/unknown formatVersion with PACKAGE_FORMAT_UNSUPPORTED', async () => {
    const missing = await readBytes(
      path.join(F4_ROOT, '03-version-missing.zip'),
    );
    const missingJob = await uploadPackage(missing, 'format-missing.zip');
    expect(missingJob.status).toBe('FAILED');
    expect(missingJob.report.errors[0]?.code).toBe(
      'PACKAGE_FORMAT_UNSUPPORTED',
    );

    const legacyVersion = await buildDefectVariant(({ manifest }) => {
      (manifest as Record<string, unknown>).formatVersion = 1;
    });
    const legacyJob = await uploadPackage(legacyVersion, 'format-v1.zip');
    expect(legacyJob.status).toBe('FAILED');
    expect(legacyJob.report.errors[0]?.code).toBe('PACKAGE_FORMAT_UNSUPPORTED');
  });

  it('T4-2 rejects a template whose Meta templateVersion is not 2 with TEMPLATE_FORMAT_UNSUPPORTED', async () => {
    for (const value of [1, null] as const) {
      const bytes = await buildDefectVariant(({ sheets }) => {
        sheets.Meta = [
          sheets.Meta[0],
          [value, 'bad-baseline', 'en-GB', 'video'],
        ];
      });
      const job = await uploadPackage(
        bytes,
        `template-version-${String(value)}.zip`,
      );
      expect(job.status).toBe('FAILED');
      expect(job.report.errors[0]?.code).toBe('TEMPLATE_FORMAT_UNSUPPORTED');
    }
  });

  // =========================================================================
  // T4-3 manifest ↔ 文件一一对应（缺 / 多 / 未知 / 大小不符）
  // =========================================================================

  it('T4-3 enforces a closed package: missing declared file, undeclared extra file, and size mismatch are all rejected', async () => {
    // ① manifest 声明但 zip 缺失。
    const missingFile = await buildDefectVariant(
      () => undefined,
      (zip) => {
        zip.remove('media/bad-video.mp4');
      },
    );
    const missingJob = await uploadPackage(missingFile, 'missing-file.zip');
    expect(missingJob.status).toBe('FAILED');
    expect(missingJob.report.errors[0]?.code).toBe('PACKAGE_FILE_MISSING');
    expect(missingJob.report.errors[0]?.path).toContain('media/bad-video.mp4');

    // ② zip 内存在 manifest 未声明的文件（未知文件）。
    const unknownFile = await buildDefectVariant(
      () => undefined,
      (zip) => {
        zip.file('media/orphan.bin', Buffer.from('orphan'));
      },
    );
    const unknownJob = await uploadPackage(unknownFile, 'unknown-file.zip');
    expect(unknownJob.status).toBe('FAILED');
    expect(unknownJob.report.errors[0]?.code).toBe('PACKAGE_FILE_UNKNOWN');
    expect(unknownJob.report.errors[0]?.path).toContain('media/orphan.bin');

    // ③ 声明大小与实际字节不符（闭合包按大小校验，无哈希）。
    const sizeMismatch = await buildDefectVariant(({ manifest }) => {
      const video = manifest.resources.find(
        (resource) => resource.kind === 'video',
      );
      if (video) video.size += 1;
    });
    const sizeJob = await uploadPackage(sizeMismatch, 'size-mismatch.zip');
    expect(sizeJob.status).toBe('FAILED');
    expect(sizeJob.report.errors[0]?.code).toBe('PACKAGE_FORMAT_UNSUPPORTED');
    expect(sizeJob.report.errors[0]?.message).toContain('size');
  });

  // =========================================================================
  // T4-4 枚举稳定 key；显示名不参与匹配
  // =========================================================================

  it('T4-4 closed enum rejects unknown resource kind, and references match stable codes not display names', async () => {
    const illegal = await readBytes(
      path.join(F4_ROOT, '08-illegal-media-type.zip'),
    );
    const illegalJob = await uploadPackage(illegal, 'illegal-kind.zip');
    expect(illegalJob.status).toBe('FAILED');
    // 非法资源 kind 使包不再满足 v2 契约（PackageManifestV2Schema 枚举），
    // 上传按契约分派走 fail-closed 拒绝；具体码取决于分派入口
    // （PACKAGE_FORMAT_UNSUPPORTED 或 PACKAGE_MANIFEST_INVALID），但绝不接受。
    expect([
      'PACKAGE_FORMAT_UNSUPPORTED',
      'PACKAGE_MANIFEST_INVALID',
    ]).toContain(illegalJob.report.errors[0]?.code);

    // Knowledge Test 用课时“显示标题”而不是稳定 lesson_code → 未知引用。
    // 若显示名参与匹配，这里会通过；正确行为是按稳定 key fail-closed。
    const displayNameRef = await buildDefectVariant(({ sheets }) => {
      sheets['Knowledge Test'] = [
        ['lesson_code', 'order', 'language', 'question', 'reference_answer'],
        ['Baseline lesson', 1, 'en-GB', 'What is a state?', 'A number.'],
      ];
    });
    const displayJob = await uploadPackage(
      displayNameRef,
      'display-name-ref.zip',
    );
    expect(displayJob.status).toBe('FAILED');
    // 显示标题含空格，本身就不是稳定 key → 行级拒绝；即使能过 schema，
    // 也只会按 stable key 匹配（下一条）。
    expect(['TEMPLATE_ROW_INVALID', 'REFERENCE_UNRESOLVED']).toContain(
      displayJob.report.errors[0]?.code,
    );

    // 合法 stable token 但不是本课程的 lesson_code（显示名的 slug 形态）→ 未知引用。
    const stableButUnknown = await buildDefectVariant(({ sheets }) => {
      sheets['Knowledge Test'] = [
        ['lesson_code', 'order', 'language', 'question', 'reference_answer'],
        ['Baseline-lesson', 1, 'en-GB', 'What is a state?', 'A number.'],
      ];
    });
    const unknownJob = await uploadPackage(
      stableButUnknown,
      'stable-unknown.zip',
    );
    expect(unknownJob.status).toBe('FAILED');
    expect(unknownJob.report.errors[0]?.code).toBe('REFERENCE_UNRESOLVED');
  });

  // =========================================================================
  // T4-5 包内无 sha256 / hash 字段
  // =========================================================================

  it('T4-5 source and exported packages carry no sha256/hash/checksum/digest field', async () => {
    // 真实 F2 包 manifest（真实 165MB 包，非玩具）。
    const f2Manifest = JSON.parse(
      await readBytes(path.join(F2_PACKAGE, 'manifest.json')).then((bytes) =>
        bytes.toString('utf8'),
      ),
    ) as Record<string, unknown>;
    expect(forbiddenHashKeys(f2Manifest)).toEqual([]);

    const baselineManifest = JSON.parse(
      await readBytes(path.join(BASELINE_ROOT, 'manifest.json')).then((bytes) =>
        bytes.toString('utf8'),
      ),
    ) as Record<string, unknown>;
    expect(forbiddenHashKeys(baselineManifest)).toEqual([]);

    // 导出包（真实导入课程的 HTTP 导出）：manifest 与条目名都不得携带哈希。
    const exported = await ensureExhibitExport();
    expect(forbiddenHashKeys(exported.manifest)).toEqual([]);
    const rawManifest = await exported.zip
      .file('manifest.json')!
      .async('string');
    expect(rawManifest).not.toMatch(/sha[-_]?256|checksum|digest|fingerprint/i);
    const entryNames = Object.keys(exported.zip.files);
    expect(
      entryNames.filter((name) =>
        /sha[-_]?256|checksums?\.|\.sha\b|digest/i.test(name),
      ),
    ).toEqual([]);
  });

  // =========================================================================
  // T4-6 provenance 存在且导出必写；导出包闭合
  // =========================================================================

  it('T4-6 export always writes provenance and a closed manifest whose resources match the zip one-to-one', async () => {
    const exported = await ensureExhibitExport();
    const manifest = exported.manifest as {
      formatVersion: number;
      provenance?: Record<string, unknown>;
      annotations?: Record<string, unknown>;
      resources?: Array<{
        id: string;
        kind: string;
        path: string;
        size: number;
      }>;
      content?: { courseKey?: string };
      course?: { courseKey?: string };
    };
    expect(manifest.formatVersion).toBe(2);
    expect(manifest.provenance).toBeDefined();
    expect(manifest.provenance!.sourceEnv).toBe('sandbox');
    expect(manifest.provenance!.courseKey).toBe(exhibitCourseKey);
    expect(manifest.provenance!.sourceVersionLabel).toBeTruthy();
    expect(manifest.provenance!.exportedAt).toBeTruthy();
    expect(manifest.provenance!.exportedBy).toBeTruthy();
    expect(manifest.provenance!.planPin).toBeDefined();
    expect(manifest.provenance!.approvalRef).toBeTruthy();
    expect(manifest.provenance!.auditSummaryRef).toBeTruthy();
    expect(manifest.annotations).toBeDefined();

    // 闭合：zip 文件（除 manifest.json）与 resources 一一对应，大小一致。
    const fileEntries = Object.entries(exported.zip.files).filter(
      ([name, entry]) => !entry.dir && name !== 'manifest.json',
    );
    const actual = new Map<string, number>();
    for (const [name, entry] of fileEntries) {
      actual.set(name, (await entry.async('nodebuffer')).length);
    }
    const declared = new Map(
      (manifest.resources ?? []).map((resource) => [
        resource.path,
        resource.size,
      ]),
    );
    expect([...actual.keys()].sort()).toEqual([...declared.keys()].sort());
    for (const [file, size] of actual) {
      expect(declared.get(file)).toBe(size);
    }
    // 资源 id / kind 是稳定 key，不是显示名。
    // 依据：docs/Course_Package_Spec_v2.md 的 resources[].kind 封闭枚举
    // （template | document | cover | video | audio | image | model3d |
    // thumbnail | lesson-text | subtitle | chapters）；旧正则漏了 subtitle /
    // lesson-text，与契约 SSOT 不一致。
    for (const resource of manifest.resources ?? []) {
      expect(resource.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
      expect(resource.kind).toMatch(
        /^(template|document|cover|video|audio|image|model3d|thumbnail|lesson-text|subtitle|chapters)$/,
      );
    }
  });

  // =========================================================================
  // T4-7 PACKAGE_SOURCE_ENFORCEMENT off / on
  // =========================================================================

  it('T4-7a enforcement off (default): a forged legacy package is not source-rejected (behaviour unchanged)', async () => {
    const code = `${PREFIX}-FORGED-OFF`;
    createdCourseCodes.push(code);
    const bytes = await forgedLegacyZip(code);
    const job = await uploadPackage(bytes, 'forged-sandbox-name.zip');
    expect(job.status).toBe('AWAITING_CONFIRM');
    const confirm = await confirmImport(job.jobId);
    // off：来源门完全休眠；可能导入成功，也可能因 legacy 形状别的问题失败，
    // 但绝不因 provenance/sourceEnv 被拒。
    if (confirm.status !== 200) {
      expect(errorCode(confirm)).not.toBe('PACKAGE_SOURCE_NOT_ALLOWED');
    } else {
      createdCourseIds.push(data<{ courseId: string }>(confirm).courseId);
    }
  });

  it('T4-7b enforcement on + production: forged-provenance legacy and production-env v2 packages are rejected; a sandbox v2 package passes', async () => {
    const prod = await buildApp({
      numbering: 'production',
      enforcement: 'off',
      sourceEnforcement: 'on',
    });
    try {
      const prodAgent = await signInAs(prod, 'ADMIN');
      const uploadAs = async (
        bytes: Buffer,
        name: string,
      ): Promise<JobView> => {
        const res = await prodAgent
          .post('/api/backoffice/courses/import')
          .attach('file', bytes, {
            filename: name,
            contentType: 'application/zip',
          });
        expect([200, 201]).toContain(res.status);
        const job = (res.body as { data?: JobView }).data;
        if (!job?.jobId) throw new Error(`upload failed: ${res.status}`);
        createdJobIds.push(job.jobId);
        return job;
      };

      // ① 伪造 provenance 的 legacy 包（文件名带 sandbox，证明不看文件名/路径）。
      const forgedCode = `${PREFIX}-FORGED-ON`;
      const forged = await uploadAs(
        await forgedLegacyZip(forgedCode),
        `${forgedCode}-sandbox.zip`,
      );
      expect(forged.status).toBe('AWAITING_CONFIRM');
      const forgedConfirm = await prodAgent
        .post(`/api/backoffice/courses/import/${forged.jobId}/confirm`)
        .send({ onConflict: 'ABORT' });
      expect(forgedConfirm.status).toBe(422);
      expect(errorCode(forgedConfirm)).toBe('PACKAGE_SOURCE_NOT_ALLOWED');

      // ② 合法 v2 形状但 provenance.sourceEnv=production（伪造来源）→ 拒绝。
      const prodEnvVariant = await buildUniqueVariant({
        courseKey: `${PREFIX}-V2-PROD`,
        lessonCode: `${PREFIX}-V2-PROD-L1`,
        provenanceSourceEnv: 'production',
      });
      const prodEnv = await uploadAs(
        prodEnvVariant.bytes,
        `${PREFIX}-V2-PROD.zip`,
      );
      expect(prodEnv.status).toBe('AWAITING_CONFIRM');
      const prodEnvConfirm = await prodAgent
        .post(`/api/backoffice/courses/import/${prodEnv.jobId}/confirm`)
        .send({ onConflict: 'ABORT' });
      expect(prodEnvConfirm.status).toBe(422);
      expect(errorCode(prodEnvConfirm)).toBe('PACKAGE_SOURCE_NOT_ALLOWED');

      // ③ Sandbox 导出的 v2 包在 Production（enforcement on）通过来源门并导入。
      const sandboxKey = `${PREFIX}-V2-SANDBOX`;
      createdCourseCodes.push(sandboxKey);
      const sandboxVariant = await buildUniqueVariant({
        courseKey: sandboxKey,
        lessonCode: `${sandboxKey}-L1`,
        provenanceSourceEnv: 'sandbox',
      });
      const sandboxJob = await uploadAs(
        sandboxVariant.bytes,
        `${sandboxKey}.zip`,
      );
      expect(sandboxJob.status).toBe('AWAITING_CONFIRM');
      const sandboxConfirm = await prodAgent
        .post(`/api/backoffice/courses/import/${sandboxJob.jobId}/confirm`)
        .send({ onConflict: 'ABORT' });
      expect(sandboxConfirm.status).toBe(200);
      expect(data<{ status: string }>(sandboxConfirm).status).toBe('READY');
      createdCourseIds.push(
        data<{ courseId: string }>(sandboxConfirm).courseId,
      );
    } finally {
      await prod.close();
    }
  });
});
