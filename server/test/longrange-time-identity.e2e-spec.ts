import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { execFileSync } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import type { Response } from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { CourseStorageService } from '../src/commerce-courses/storage.service';
import { signInAs } from './helpers/employee-session';

/**
 * 长程真实测试 T1 + T2（计划 docs/Course_Category_LongRange_TestPlan.md §2 T1/T2；
 * 设计 SSOT §14 Part C C3/C7/C10.1/C10.6）。
 *
 * 黑盒边界：所有行为只经 backoffice HTTP（导入作业、课程详情、Part C 管理端 API、
 * 导出的 Part C v2 包）与导出包内的机器产物观察；不 import 被测内部实现，
 * 不断言私有字段。Prisma/Storage 仅用于 arrange/cleanup 与作业清理。
 *
 * 真实资产：F1–F5 夹具全部由 Owner 提供的真实 Modeling life 包派生
 * （真实 165MB zip：2 个真实 mp4、2 个真实 docx、真实 png；无玩具视频）。
 * 夹具说明见 test/fixtures/longrange/README.md。
 *
 * 本文件只新增测试；任何实现缺陷以红用例 + blocker 记录，不修改生产代码。
 */

jest.setTimeout(900_000);

const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures/longrange');
const F2_ZIP = path.join(FIXTURE_ROOT, 'F2_subtitles/F2_subtitles.zip');
const F3_ZIP = path.join(FIXTURE_ROOT, 'F3_chapters/F3_chapters.zip');
const F5_ZIP = path.join(FIXTURE_ROOT, 'F5_replacement/F5_replacement.zip');
const F2_DIR = path.join(FIXTURE_ROOT, 'F2_subtitles/package');
const F3_DIR = path.join(FIXTURE_ROOT, 'F3_chapters/package');
const F5_DIR = path.join(FIXTURE_ROOT, 'F5_replacement/package');
const F4_DIR = path.join(FIXTURE_ROOT, 'F4_bad_packages');
const F4_OUT_OF_RANGE_ZIP = path.join(F4_DIR, '05-out-of-range-time.zip');
const F4_BASELINE_ZIP = path.join(F4_DIR, '_baseline');

const COURSE_KEY = 'modeling-life';
const TIME_COLUMN_PATTERN =
  /(?:^|[^a-z])(?:times?|timestamps?|durations?|seconds?|minutes?|clock|ms|start|end|trigger|时间|时长|秒|分钟|开始|结束|触发)(?:[^a-z]|$)|mm:ss|hh:mm/i;

interface JobView {
  jobId: string;
  status: string;
  error: string | null;
  courseId: string | null;
  package?: { courseCode?: string; lessons?: number; mediaFiles?: number };
  report: {
    errors: Array<{ code: string; message: string; path?: string }>;
    warnings: Array<{ code: string; message: string; path?: string }>;
  };
}

interface ChapterCue {
  startMs: number;
  title: string;
}

interface ManifestV2Like {
  formatVersion?: number;
  course: { courseKey: string; learningLanguages: string[] };
  content: {
    courseKey: string;
    versionNo: number;
    assetPins: Array<{ assetKey: string; assetVersion: number }>;
    renditions: Array<Record<string, unknown>>;
    stages: Array<Record<string, unknown>>;
    specPins: Array<{ contentKey: string; version: number }>;
  };
  resources: Array<{ id: string; kind: string; path: string; size: number }>;
  provenance?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

interface ExportView {
  bytes: Buffer;
  manifest: ManifestV2Like;
  chapters: Record<string, ChapterCue[]>;
  mediaRows: unknown[][];
  templateHeaders: Record<string, string[]>;
}

function dataOf<T>(res: Response): T {
  return (res.body as { data: T }).data;
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

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 递归收集疑似哈希/摘要字段名（C0 红线⑦：全系统不使用哈希身份）。 */
function hashLikeKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) hashLikeKeys(item, found);
    return found;
  }
  if (typeof value !== 'object' || value === null) return found;
  for (const [key, child] of Object.entries(value)) {
    if (/sha256|sha1|md5|hash|digest|checksum/i.test(key)) found.push(key);
    hashLikeKeys(child, found);
  }
  return found;
}

// ---------------------------------------------------------------------------
// ZIP / workbook 改包助手（只在测试内存中派生夹具变体；不改生产代码）
// ---------------------------------------------------------------------------

async function loadZipEntries(buffer: Buffer): Promise<Map<string, Buffer>> {
  const zip = await JSZip.loadAsync(buffer);
  const entries = new Map<string, Buffer>();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    entries.set(name, await entry.async('nodebuffer'));
  }
  return entries;
}

async function packZip(entries: Map<string, Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, bytes] of entries) zip.file(name, bytes);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

/** 把夹具目录（未压缩的 _baseline 目录）打包成闭合 zip 的内存条目。 */
async function readDirectoryEntries(dir: string): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(full, relative);
      else entries.set(relative, await fs.readFile(full));
    }
  };
  await walk(dir, '');
  return entries;
}

function manifestOf(entries: Map<string, Buffer>): ManifestV2Like {
  const bytes = entries.get('manifest.json');
  if (!bytes) throw new Error('package has no manifest.json');
  return JSON.parse(bytes.toString('utf8')) as ManifestV2Like;
}

function syncResourceSizes(
  manifest: ManifestV2Like,
  entries: Map<string, Buffer>,
): void {
  for (const resource of manifest.resources) {
    const bytes = entries.get(resource.path);
    if (!bytes) throw new Error(`missing package resource ${resource.path}`);
    resource.size = bytes.length;
  }
}

function loadWorkbook(bytes: Buffer): XLSX.WorkBook {
  return XLSX.read(bytes, { type: 'buffer' });
}

function sheetRows(workbook: XLSX.WorkBook, name: string): unknown[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], {
    header: 1,
    defval: null,
    raw: true,
  });
}

function saveWorkbook(workbook: XLSX.WorkBook): Buffer {
  return XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
  }) as Buffer;
}

function templatePathOf(manifest: ManifestV2Like): string {
  const template = manifest.resources.find(
    (resource) => resource.kind === 'template',
  );
  if (!template) throw new Error('package has no template resource');
  return template.path;
}

function setSheetRows(
  workbook: XLSX.WorkBook,
  name: string,
  rows: unknown[][],
): void {
  workbook.Sheets[name] = XLSX.utils.aoa_to_sheet(rows);
}

/** 从 F2 派生「无字幕无章节」变体（真实素材不变；F1 语义的 v2 包）。 */
async function buildNoTimingSourceVariant(bytes: Buffer): Promise<Buffer> {
  const entries = await loadZipEntries(bytes);
  const manifest = manifestOf(entries);
  const removedIds = new Set(
    manifest.resources
      .filter((resource) => resource.kind === 'subtitle')
      .map((resource) => resource.id),
  );
  const removedPaths = new Set(
    manifest.resources
      .filter((resource) => resource.kind === 'subtitle')
      .map((resource) => resource.path),
  );
  manifest.resources = manifest.resources.filter(
    (resource) => resource.kind !== 'subtitle',
  );
  manifest.content.assetPins = manifest.content.assetPins.filter(
    (pin) => !removedIds.has(pin.assetKey),
  );
  for (const resourcePath of removedPaths) entries.delete(resourcePath);

  const templatePath = templatePathOf(manifest);
  const workbook = loadWorkbook(entries.get(templatePath)!);
  setSheetRows(
    workbook,
    'Media',
    sheetRows(workbook, 'Media').filter(
      (row, index) => index === 0 || row[1] !== 'subtitle',
    ),
  );
  entries.set(templatePath, saveWorkbook(workbook));
  entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  syncResourceSizes(manifest, entries);
  entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return packZip(entries);
}

/**
 * 从 F2 派生「字幕 + 章节同时存在」变体：章节 cue 时间与字幕完全不同，
 * 用来观察 C7 时间源优先级（字幕应优先）。
 */
async function buildSubtitlePlusChapterVariant(
  bytes: Buffer,
): Promise<{ bytes: Buffer; chapterTimes: Record<string, number[]> }> {
  const entries = await loadZipEntries(bytes);
  const manifest = manifestOf(entries);
  const chapterTimes: Record<string, number[]> = {
    L1: [5000, 15000, 25000, 35000, 45000],
    L2: [5000, 15000],
  };
  const titles: Record<string, string[]> = {
    L1: [
      'State Variables and State Spaces',
      'Defining Vectors',
      'State Space Rules for Operating with Vectors',
      'Vectors And Vector Spaces',
      'Vectors and Trajectories Change in State Space, Time Series Translation',
    ],
    L2: [
      'Pitchfork Bifurcation in a Model of Public Opinion',
      'Transcritical Bifurcation',
    ],
  };

  const workbook = loadWorkbook(entries.get(templatePathOf(manifest))!);
  const media = sheetRows(workbook, 'Media');
  const added: Array<{ lesson: string; path: string; id: string }> = [];
  for (const lesson of Object.keys(chapterTimes)) {
    const id = `${lesson.toLowerCase()}-chapters`;
    const resourcePath = `chapters/${lesson}.en-GB.json`;
    const cues = chapterTimes[lesson].map((startMs, index) => ({
      startMs,
      title: titles[lesson][index],
    }));
    entries.set(resourcePath, Buffer.from(JSON.stringify(cues), 'utf8'));
    manifest.resources.push({
      id,
      kind: 'chapters',
      path: resourcePath,
      size: 0,
    });
    manifest.content.assetPins.push({ assetKey: id, assetVersion: 1 });
    media.push([id, 'chapters', lesson, 'en-GB', resourcePath, null]);
    added.push({ lesson, path: resourcePath, id });
  }
  setSheetRows(workbook, 'Media', media);
  entries.set(templatePathOf(manifest), saveWorkbook(workbook));
  syncResourceSizes(manifest, entries);
  entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return { bytes: await packZip(entries), chapterTimes };
}

/** 基线坏包变体：空字幕（size=0，仍是闭合包）。 */
async function buildEmptySubtitleVariant(bytes: Buffer): Promise<Buffer> {
  const entries = await loadZipEntries(bytes);
  const manifest = manifestOf(entries);
  const subtitle = manifest.resources.find(
    (resource) => resource.kind === 'subtitle',
  );
  if (!subtitle) throw new Error('baseline has no subtitle resource');
  entries.set(subtitle.path, Buffer.alloc(0));
  syncResourceSizes(manifest, entries);
  entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return packZip(entries);
}

/** 基线坏包变体：章节 JSON 的 startMs 为负值（非法机器时间源）。 */
async function buildNegativeChapterVariant(bytes: Buffer): Promise<Buffer> {
  const entries = await loadZipEntries(bytes);
  const manifest = manifestOf(entries);
  const subtitle = manifest.resources.find(
    (resource) => resource.kind === 'subtitle',
  );
  if (!subtitle) throw new Error('baseline has no subtitle resource');
  const chaptersPath = 'chapters/BL1.en-GB.json';
  const chaptersId = 'bad-chapters';
  const oldId = subtitle.id;
  const oldPath = subtitle.path;
  subtitle.id = chaptersId;
  subtitle.kind = 'chapters';
  subtitle.path = chaptersPath;
  subtitle.size = 0;
  for (const pin of manifest.content.assetPins) {
    if (pin.assetKey === oldId) pin.assetKey = chaptersId;
  }
  const workbook = loadWorkbook(entries.get(templatePathOf(manifest))!);
  const media = sheetRows(workbook, 'Media');
  for (const row of media) {
    if (row[1] === 'subtitle') {
      row[0] = chaptersId;
      row[1] = 'chapters';
      row[4] = chaptersPath;
    }
  }
  setSheetRows(workbook, 'Media', media);
  entries.set(templatePathOf(manifest), saveWorkbook(workbook));
  entries.delete(oldPath);
  entries.set(
    chaptersPath,
    Buffer.from(
      JSON.stringify([{ startMs: -1000, title: 'Baseline learning point' }]),
      'utf8',
    ),
  );
  syncResourceSizes(manifest, entries);
  entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return packZip(entries);
}

/** 基线坏包变体：模板出现时间列（start_ms）→ HUMAN_TIME_FORBIDDEN。 */
async function buildTimeColumnVariant(bytes: Buffer): Promise<Buffer> {
  const entries = await loadZipEntries(bytes);
  const manifest = manifestOf(entries);
  const templatePath = templatePathOf(manifest);
  const workbook = loadWorkbook(entries.get(templatePath)!);
  const rows = sheetRows(workbook, 'Learning Points');
  rows[0] = [...rows[0], 'start_ms'];
  setSheetRows(workbook, 'Learning Points', rows);
  entries.set(templatePath, saveWorkbook(workbook));
  syncResourceSizes(manifest, entries);
  entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return packZip(entries);
}

// ---------------------------------------------------------------------------
// 夹具事实计算（读真实 subtitle / 真实 mp4 chapter track / ffprobe）
// ---------------------------------------------------------------------------

function parseSubtitleText(
  text: string,
): Array<{ startMs: number; text: string }> {
  const blocks = text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').filter((line) => line !== ''));
  const cues: Array<{ startMs: number; text: string }> = [];
  for (const lines of blocks) {
    if (lines.length === 0) continue;
    let index = 0;
    if (/^\d+$/.test(lines[0].trim())) index = 1;
    if (index >= lines.length) continue;
    const timing = /^(\d+):(\d+):(\d+)[,.](\d+)\s*-->/u.exec(lines[index]);
    if (!timing) continue;
    const startMs =
      ((Number(timing[1]) * 60 + Number(timing[2])) * 60 + Number(timing[3])) *
        1000 +
      Number(timing[4].padEnd(3, '0'));
    cues.push({ startMs, text: lines.slice(index + 1).join(' ') });
  }
  return cues;
}

interface LpTimeFact {
  lesson: string;
  code: string;
  title: string;
  startMs: number;
}

/** 用真实包内字幕文件推导每个 LP 的 cue 起点（夹具事实，不是产品实现）。 */
function fixtureSubtitleLpTimes(packageDir: string): LpTimeFact[] {
  const manifest = JSON.parse(
    readFileSync(path.join(packageDir, 'manifest.json'), 'utf8'),
  ) as ManifestV2Like;
  const workbook = loadWorkbook(
    readFileSync(path.join(packageDir, 'template.xlsx')),
  );
  const lpRows = sheetRows(workbook, 'Learning Points').slice(1);
  const subtitleResources = manifest.resources.filter(
    (resource) => resource.kind === 'subtitle',
  );
  const parsed = subtitleResources.map((resource) => ({
    resource,
    cues: parseSubtitleText(
      readFileSync(path.join(packageDir, resource.path), 'utf8'),
    ),
  }));

  const facts: LpTimeFact[] = [];
  for (const row of lpRows) {
    const [lesson, code, language, title] = row as [
      string,
      string,
      string,
      string,
    ];
    if (language !== 'en-GB') continue;
    const needle = normalize(title);
    for (const { cues } of parsed) {
      const hits = cues.filter((cue) => normalize(cue.text) === needle);
      if (hits.length === 1) {
        facts.push({ lesson, code, title, startMs: hits[0].startMs });
        break;
      }
    }
  }
  facts.sort((left, right) =>
    left.lesson === right.lesson
      ? left.startMs - right.startMs
      : left.lesson < right.lesson
        ? -1
        : 1,
  );
  return facts;
}

interface Mp4Facts {
  durationMs: number;
  chapters: ChapterCue[];
  subtitleStreams: number;
}

/** 用 ffprobe 读取真实容器（时长 / chapter track / 字幕流数）。 */
function ffprobeFacts(file: string): Mp4Facts {
  const output = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_format',
      '-show_chapters',
      '-show_streams',
      '-of',
      'json',
      file,
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(output) as {
    format?: { duration?: string };
    chapters?: Array<{ start_time?: string; tags?: { title?: string } }>;
    streams?: Array<{ codec_type?: string }>;
  };
  const durationMs = Math.round(Number(parsed.format?.duration ?? '0') * 1000);
  const chapters = (parsed.chapters ?? []).map((chapter) => ({
    startMs: Math.round(Number(chapter.start_time ?? '0') * 1000),
    title: chapter.tags?.title ?? '',
  }));
  return {
    durationMs,
    chapters,
    subtitleStreams: (parsed.streams ?? []).filter(
      (stream) => stream.codec_type === 'subtitle',
    ).length,
  };
}

function roundedToSeconds(ms: number): number {
  return Math.round(ms / 1000) * 1000;
}

// ---------------------------------------------------------------------------
// HTTP 助手
// ---------------------------------------------------------------------------

function createHttp(
  agent: Awaited<ReturnType<typeof signInAs>>,
  onExportJob: (jobId: string) => void,
) {
  async function uploadPackage(
    bytes: Buffer,
    name: string,
  ): Promise<{ job: JobView; status: number }> {
    const response = await agent
      .post('/api/backoffice/courses/import')
      .attach('file', bytes, {
        filename: name,
        contentType: 'application/zip',
      });
    expect([200, 201]).toContain(response.status);
    return { job: dataOf<JobView>(response), status: response.status };
  }

  async function getJob(jobId: string): Promise<JobView> {
    const response = await agent
      .get(`/api/backoffice/courses/import/${jobId}`)
      .expect(200);
    return dataOf<JobView>(response);
  }

  async function confirm(
    jobId: string,
  ): Promise<{ status: number; data: { status: string; courseId: string } }> {
    const response = await agent
      .post(`/api/backoffice/courses/import/${jobId}/confirm`)
      .send({ onConflict: 'ABORT', overwriteDraft: true });
    const data =
      response.status === 200
        ? dataOf<{ status: string; courseId: string }>(response)
        : { status: 'ERROR', courseId: '' };
    return { status: response.status, data };
  }

  async function importAndConfirm(
    bytes: Buffer,
    name: string,
  ): Promise<{ courseId: string; job: JobView }> {
    const upload = await uploadPackage(bytes, name);
    if (upload.job.status !== 'AWAITING_CONFIRM') {
      throw new Error(
        `upload of ${name} failed validation: ${JSON.stringify(upload.job.report.errors)}`,
      );
    }
    const confirmed = await confirm(upload.job.jobId);
    if (confirmed.status !== 200) {
      const job = await getJob(upload.job.jobId);
      throw new Error(
        `confirm of ${name} failed (${confirmed.status}): ${JSON.stringify(job.report)}`,
      );
    }
    expect(confirmed.data.status).toBe('READY');
    return {
      courseId: confirmed.data.courseId,
      job: await getJob(upload.job.jobId),
    };
  }

  async function courseDetail(
    courseId: string,
  ): Promise<Record<string, unknown>> {
    const response = await agent
      .get(`/api/backoffice/courses/${courseId}`)
      .expect(200);
    return dataOf<Record<string, unknown>>(response);
  }

  async function exportAndParse(courseId: string): Promise<ExportView> {
    const started = await agent
      .post(`/api/backoffice/courses/${courseId}/export`)
      .send({ version: 'working' })
      .expect(202);
    const jobId = dataOf<{ jobId: string }>(started).jobId;
    onExportJob(jobId);
    const deadline = Date.now() + 300_000;
    let status = '';
    while (Date.now() < deadline) {
      const view = dataOf<JobView>(
        await agent.get(`/api/backoffice/courses/export/${jobId}`),
      );
      status = view.status;
      if (status === 'READY' || status === 'FAILED') {
        if (status === 'FAILED') {
          throw new Error(`export job failed: ${view.error ?? 'unknown'}`);
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
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
    ) as ManifestV2Like;
    const chapters: Record<string, ChapterCue[]> = {};
    for (const resource of manifest.resources.filter(
      (entry) => entry.kind === 'chapters',
    )) {
      const match = /^chapters\/([^.]+)\.([^.]+)\.json$/.exec(resource.path);
      if (!match) continue;
      chapters[match[1]] = JSON.parse(
        await zip.file(resource.path)!.async('string'),
      ) as ChapterCue[];
    }
    const templateName = templatePathOf(manifest);
    const workbook = XLSX.read(
      await zip.file(templateName)!.async('nodebuffer'),
      { type: 'buffer' },
    );
    const mediaRows = sheetRows(workbook, 'Media');
    const templateHeaders: Record<string, string[]> = {};
    for (const name of workbook.SheetNames) {
      const rows = sheetRows(workbook, name);
      templateHeaders[name] = (rows[0] ?? []).map((cell) =>
        typeof cell === 'string'
          ? cell
          : typeof cell === 'number' || typeof cell === 'boolean'
            ? String(cell)
            : cell == null
              ? ''
              : (JSON.stringify(cell) ?? ''),
      );
    }
    return { bytes, manifest, chapters, mediaRows, templateHeaders };
  }

  return {
    uploadPackage,
    getJob,
    confirm,
    importAndConfirm,
    courseDetail,
    exportAndParse,
  };
}

// ---------------------------------------------------------------------------
// 套件
// ---------------------------------------------------------------------------

describe('Long-range T1/T2: asset identity and machine timing derivation (real 165MB assets)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let storage: CourseStorageService;
  let agent: Awaited<ReturnType<typeof signInAs>>;
  let http: ReturnType<typeof createHttp>;
  let courseId = '';
  const createdJobIds: string[] = [];

  let f2Export: ExportView;
  let f2Job: JobView;
  let f2Detail: Record<string, unknown>;
  let f2Facts: LpTimeFact[];

  beforeAll(async () => {
    process.env.HEAVY_TASKS_INLINE = '1';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    storage = app.get(CourseStorageService);
    agent = await signInAs(app, 'ADMIN');
    http = createHttp(agent, (jobId) => createdJobIds.push(jobId));
  });

  afterAll(async () => {
    // arrange/cleanup：pc_* 无跨域外键，按稳定 key 清理；commerce 侧按 code 清理。
    const course = await prisma.commerceCourse
      .findFirst({ where: { code: COURSE_KEY }, select: { id: true } })
      .catch(() => null);
    const mediaKeys = ['l1-video', 'l2-video', 'l1-doc', 'l2-doc'];
    const contentVersions = await prisma.pcContentVersion
      .findMany({
        where: { courseKey: COURSE_KEY },
        select: { contentVersionId: true },
      })
      .catch(() => []);
    if (contentVersions.length > 0) {
      const ids = contentVersions.map((row) => row.contentVersionId);
      await prisma.pcPublication
        .deleteMany({ where: { contentVersionId: { in: ids } } })
        .catch(() => undefined);
    }
    const plans = await prisma.pcPlan
      .findMany({
        where: { courseKey: COURSE_KEY },
        select: { planId: true },
      })
      .catch(() => []);
    if (plans.length > 0) {
      await prisma.pcPlanApproval
        .deleteMany({
          where: { planId: { in: plans.map((row) => row.planId) } },
        })
        .catch(() => undefined);
    }
    await prisma.pcPlan
      .deleteMany({ where: { courseKey: COURSE_KEY } })
      .catch(() => undefined);
    await prisma.pcContentVersion
      .deleteMany({ where: { courseKey: COURSE_KEY } })
      .catch(() => undefined);
    await prisma.pcAlignment
      .deleteMany({ where: { stage: { courseKey: COURSE_KEY } } })
      .catch(() => undefined);
    await prisma.pcRendition
      .deleteMany({ where: { contentKey: { in: ['L1', 'L2'] } } })
      .catch(() => undefined);
    await prisma.pcBlock
      .deleteMany({ where: { contentKey: { in: ['L1', 'L2'] } } })
      .catch(() => undefined);
    await prisma.pcContentSpec
      .deleteMany({ where: { contentKey: { in: ['L1', 'L2'] } } })
      .catch(() => undefined);
    await prisma.pcObjective
      .deleteMany({ where: { courseKey: COURSE_KEY } })
      .catch(() => undefined);
    await prisma.pcEvidenceSpec
      .deleteMany({ where: { evidenceKey: { in: ['ev-1', 'ev-2'] } } })
      .catch(() => undefined);
    await prisma.pcMediaAsset
      .deleteMany({
        where: {
          OR: [
            { assetKey: { in: mediaKeys } },
            { uri: { contains: COURSE_KEY } },
          ],
        },
      })
      .catch(() => undefined);
    await prisma.pcCourse
      .deleteMany({ where: { courseKey: COURSE_KEY } })
      .catch(() => undefined);
    if (course) {
      await prisma.commerceCourse
        .deleteMany({ where: { id: course.id } })
        .catch(() => undefined);
      const mediaRoot = path.resolve(
        process.env.COURSE_MEDIA_ROOT?.trim() || 'storage/course-media',
        'course-media',
      );
      await fs
        .rm(path.join(mediaRoot, course.id), { recursive: true, force: true })
        .catch(() => undefined);
    }
    if (createdJobIds.length > 0) {
      await prisma.coursePackageJob
        .deleteMany({ where: { id: { in: createdJobIds } } })
        .catch(() => undefined);
      for (const jobId of createdJobIds) {
        await storage.clearStagingPrefix(jobId).catch(() => undefined);
        await fs
          .rm(
            path.resolve(
              process.env.COURSE_PACKAGE_ROOT?.trim() ||
                'storage/course-package',
              jobId,
            ),
            { recursive: true, force: true },
          )
          .catch(() => undefined);
      }
    }
    await app.close();
  });

  // -------------------------------------------------------------------------
  // T1-A 资产身份与「无哈希」契约（初始导入 + 导出包观察）
  // -------------------------------------------------------------------------
  it('T1-A: real package import produces assetKey+assetVersion pins and no hash fields anywhere in API/manifest', async () => {
    const f2Bytes = await fs.readFile(F2_ZIP);
    console.log(
      'EVIDENCE T1-A input',
      JSON.stringify({
        fixture: F2_ZIP,
        bytes: f2Bytes.length,
      }),
    );
    const upload = await http.uploadPackage(f2Bytes, 'F2_subtitles.zip');
    createdJobIds.push(upload.job.jobId);
    expect(upload.job.status).toBe('AWAITING_CONFIRM');
    expect(upload.job.package?.courseCode).toBe(COURSE_KEY);

    const confirmed = await http.confirm(upload.job.jobId);
    expect(confirmed.status).toBe(200);
    expect(confirmed.data.status).toBe('READY');
    courseId = confirmed.data.courseId;
    f2Job = await http.getJob(upload.job.jobId);
    expect(f2Job.report.errors).toEqual([]);

    f2Detail = await http.courseDetail(courseId);
    f2Export = await http.exportAndParse(courseId);

    // 资产 pin 形状：稳定 assetKey + 正整数 assetVersion（不是环境 UUID）。
    const pins = f2Export.manifest.content.assetPins;
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) {
      expect(typeof pin.assetKey).toBe('string');
      expect(pin.assetKey.length).toBeGreaterThan(0);
      expect(pin.assetKey).not.toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(Number.isInteger(pin.assetVersion)).toBe(true);
      expect(pin.assetVersion).toBeGreaterThanOrEqual(1);
    }
    console.log('EVIDENCE T1-A exported assetPins', JSON.stringify(pins));

    // 无哈希字段依赖：manifest/作业/Part C API 响应都不携带摘要身份。
    expect(hashLikeKeys(f2Export.manifest)).toEqual([]);
    expect(
      f2Export.manifest.resources.some((resource) =>
        /sha256|sha1|md5|hash|digest|checksum/i.test(resource.path),
      ),
    ).toBe(false);
    expect(hashLikeKeys(f2Job)).toEqual([]);
    const stages = dataOf<Record<string, unknown>>(
      await agent
        .get(`/api/backoffice/courses/${COURSE_KEY}/partc/stages`)
        .expect(200),
    );
    const alignments = dataOf<unknown[]>(
      await agent
        .get(`/api/backoffice/courses/${COURSE_KEY}/partc/alignments`)
        .expect(200),
    );
    expect(hashLikeKeys(stages)).toEqual([]);
    expect(hashLikeKeys(alignments)).toEqual([]);
    console.log(
      'EVIDENCE T1-A no-hash scan',
      JSON.stringify({
        manifestHashKeys: hashLikeKeys(f2Export.manifest),
        jobHashKeys: hashLikeKeys(f2Job),
        stagesHashKeys: hashLikeKeys(stages),
        alignmentsHashKeys: hashLikeKeys(alignments),
        packageHadChecksumsFile: false,
      }),
    );
    // 导入的原始包没有任何 checksums 文件，仍然通过（闭合包靠 ZIP CRC32 + size）。
    const packageEntryNames = Object.keys(
      (await JSZip.loadAsync(f2Bytes)).files,
    );
    expect(packageEntryNames).not.toContain('checksums.sha256');
  });

  // -------------------------------------------------------------------------
  // T2-F2 字幕优先 + 确定性（真实 165MB 视频 + 真实 SRT/VTT）
  // -------------------------------------------------------------------------
  it('T2-F2: real subtitles drive LP times (not chapters) and repeated import is byte-for-byte deterministic', async () => {
    expect(f2Export).toBeDefined();
    const f2Bytes = await fs.readFile(F2_ZIP);
    f2Facts = fixtureSubtitleLpTimes(F2_DIR);
    const expectedL1 = f2Facts
      .filter((fact) => fact.lesson === 'L1')
      .map((fact) => ({
        startMs: roundedToSeconds(fact.startMs),
        title: fact.title,
      }));
    const expectedL2 = f2Facts
      .filter((fact) => fact.lesson === 'L2')
      .map((fact) => ({
        startMs: roundedToSeconds(fact.startMs),
        title: fact.title,
      }));
    expect(expectedL1.length).toBe(5);
    expect(expectedL2.length).toBe(2);
    expect(f2Export.chapters['L1']).toEqual(expectedL1);
    expect(f2Export.chapters['L2']).toEqual(expectedL2);

    // 导出模板没有任何时间列（C7 红线；机器只派生，模板无锚点列）。
    const offendingColumns = Object.entries(f2Export.templateHeaders).flatMap(
      ([sheet, headers]) =>
        headers
          .filter((header) => TIME_COLUMN_PATTERN.test(header))
          .map((header) => `${sheet}.${header}`),
    );
    expect(offendingColumns).toEqual([]);

    // 真实容器时长 vs 课程详情（duration 是容器探测属性，不是人工输入）。
    const l1Facts = ffprobeFacts(path.join(F2_DIR, 'media/l1-video.mp4'));
    const l2Facts = ffprobeFacts(path.join(F2_DIR, 'media/l2-video.mp4'));
    const lessons = (f2Detail.lessons ?? []) as Array<{
      code: string;
      localizations: Array<{
        language: string;
        videoAssetId: string | null;
        videoDurationSeconds: number | null;
      }>;
    }>;
    const durationOf = (lessonCode: string, language: string) =>
      lessons
        .find((lesson) => lesson.code === lessonCode)
        ?.localizations.find((loc) => loc.language === language)
        ?.videoDurationSeconds ?? null;
    expect(durationOf('L1', 'en-GB')).toBe(
      Math.round(l1Facts.durationMs / 1000),
    );
    expect(durationOf('L2', 'en-GB')).toBe(
      Math.round(l2Facts.durationMs / 1000),
    );
    // 派生时间从不越过容器时长。
    for (const fact of f2Facts) {
      const durationMs =
        fact.lesson === 'L2' ? l2Facts.durationMs : l1Facts.durationMs;
      expect(fact.startMs).toBeGreaterThanOrEqual(0);
      expect(fact.startMs).toBeLessThan(durationMs);
    }
    console.log(
      'EVIDENCE T2-F2 waveform',
      JSON.stringify({
        subtitleDerived: { L1: expectedL1, L2: expectedL2 },
        ffprobe: {
          L1: {
            durationMs: l1Facts.durationMs,
            subtitleStreams: l1Facts.subtitleStreams,
          },
          L2: {
            durationMs: l2Facts.durationMs,
            subtitleStreams: l2Facts.subtitleStreams,
          },
        },
        detailDurations: {
          L1: durationOf('L1', 'en-GB'),
          L2: durationOf('L2', 'en-GB'),
        },
        templateTimeColumns: offendingColumns,
      }),
    );

    // 确定性：同一包重复导入 → 导出的时间/资产/媒体表逐条一致。
    const reimport = await http.importAndConfirm(f2Bytes, 'F2_subtitles.zip');
    createdJobIds.push(reimport.job.jobId);
    expect(reimport.courseId).toBe(courseId);
    const secondExport = await http.exportAndParse(courseId);
    expect(secondExport.chapters).toEqual(f2Export.chapters);
    expect(secondExport.manifest.content.assetPins).toEqual(
      f2Export.manifest.content.assetPins,
    );
    expect(secondExport.mediaRows).toEqual(f2Export.mediaRows);
    console.log(
      'EVIDENCE T2-F2 determinism',
      JSON.stringify({
        firstChapters: f2Export.chapters,
        secondChapters: secondExport.chapters,
        chaptersEqual:
          JSON.stringify(secondExport.chapters) ===
          JSON.stringify(f2Export.chapters),
      }),
    );
    // 重导入后导出用于后续用例的最新观察。
    f2Export = secondExport;
  });

  // -------------------------------------------------------------------------
  // T2-F3 章节轨映射（真实 ffmpeg 注入的 chapter track）
  // -------------------------------------------------------------------------
  it('T2-F3: real MP4 chapter track maps learning points by chapter start', async () => {
    const l1 = ffprobeFacts(path.join(F3_DIR, 'media/l1-video.mp4'));
    const l2 = ffprobeFacts(path.join(F3_DIR, 'media/l2-video.mp4'));
    expect(l1.chapters.length).toBe(5);
    expect(l2.chapters.length).toBe(2);
    expect(l1.subtitleStreams).toBe(0);
    expect(l2.subtitleStreams).toBe(0);

    const f3Bytes = await fs.readFile(F3_ZIP);
    const imported = await http.importAndConfirm(f3Bytes, 'F3_chapters.zip');
    createdJobIds.push(imported.job.jobId);
    expect(imported.courseId).toBe(courseId);
    const exported = await http.exportAndParse(courseId);

    const expectedL1 = l1.chapters
      .slice()
      .sort((left, right) => left.startMs - right.startMs)
      .map((chapter) => ({
        startMs: roundedToSeconds(chapter.startMs),
        title: chapter.title,
      }));
    const expectedL2 = l2.chapters
      .slice()
      .sort((left, right) => left.startMs - right.startMs)
      .map((chapter) => ({
        startMs: roundedToSeconds(chapter.startMs),
        title: chapter.title,
      }));
    expect(exported.chapters['L1']).toEqual(expectedL1);
    expect(exported.chapters['L2']).toEqual(expectedL2);

    // 与字幕派生的时间显著不同 → 证明使用了 chapter track 而非字幕。
    const subtitleL1 = f2Facts
      .filter((fact) => fact.lesson === 'L1')
      .map((fact) => roundedToSeconds(fact.startMs));
    expect(exported.chapters['L1'].map((cue) => cue.startMs)).not.toEqual(
      subtitleL1,
    );
    console.log(
      'EVIDENCE T2-F3 chapters',
      JSON.stringify({
        ffprobeChapters: { L1: l1.chapters, L2: l2.chapters },
        derivedChapters: exported.chapters,
        subtitleTimesForComparison: {
          L1: subtitleL1,
        },
      }),
    );
  });

  // -------------------------------------------------------------------------
  // T2 每语言独立派生
  // -------------------------------------------------------------------------
  it('T2 per-language: en-GB video derives timing while zh-CN stays text-only (no silent copy)', () => {
    expect(f2Job).toBeDefined();
    const warnings = f2Job.report.warnings;
    const zhWarnings = warnings.filter(
      (warning) =>
        warning.code === 'TIMING_SOURCE_MISSING' &&
        warning.message.includes('"language":"zh-CN"'),
    );
    expect(zhWarnings.length).toBeGreaterThanOrEqual(2);
    const enMissing = warnings.filter(
      (warning) =>
        warning.code === 'TIMING_SOURCE_MISSING' &&
        warning.message.includes('"language":"en-GB"') &&
        warning.message.includes('"lpCode"'),
    );
    expect(enMissing).toEqual([]);

    const videoRows = f2Export.mediaRows
      .slice(1)
      .filter((row) => row[1] === 'video');
    expect(videoRows.length).toBeGreaterThan(0);
    expect(videoRows.every((row) => row[3] === 'en-GB')).toBe(true);
    expect(videoRows.some((row) => row[3] === 'zh-CN')).toBe(false);

    const zhVideoRenditions = f2Export.manifest.content.renditions.filter(
      (rendition) =>
        rendition.language === 'zh-CN' &&
        (rendition.modality === 'video' || rendition.modality === 'audio'),
    );
    expect(zhVideoRenditions).toEqual([]);

    const lessons = (f2Detail.lessons ?? []) as Array<{
      code: string;
      localizations: Array<{
        language: string;
        videoAssetId: string | null;
        videoDurationSeconds: number | null;
      }>;
    }>;
    for (const lesson of lessons) {
      const zh = lesson.localizations.find((loc) => loc.language === 'zh-CN');
      const en = lesson.localizations.find((loc) => loc.language === 'en-GB');
      expect(zh?.videoAssetId ?? null).toBeNull();
      expect(zh?.videoDurationSeconds ?? null).toBeNull();
      expect(en?.videoDurationSeconds ?? null).not.toBeNull();
    }
    console.log(
      'EVIDENCE T2 per-language',
      JSON.stringify({
        zhTimingSourceMissingWarnings: zhWarnings,
        exportedVideoMediaRows: videoRows,
        zhVideoRenditions: zhVideoRenditions.length,
        detail: lessons.map((lesson) => ({
          code: lesson.code,
          languages: lesson.localizations.map((loc) => ({
            language: loc.language,
            videoAssetId: loc.videoAssetId,
            videoDurationSeconds: loc.videoDurationSeconds,
          })),
        })),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // T2 时间源优先级：字幕 > 章节（同一包同时携带时）
  // -------------------------------------------------------------------------
  it('T2 priority: when a package carries both subtitles and chapters, subtitle cues win', async () => {
    const baseBytes = await fs.readFile(F2_ZIP);
    const variant = await buildSubtitlePlusChapterVariant(baseBytes);
    const imported = await http.importAndConfirm(
      variant.bytes,
      'F2_plus_chapters.zip',
    );
    createdJobIds.push(imported.job.jobId);
    expect(imported.courseId).toBe(courseId);
    const exported = await http.exportAndParse(courseId);

    const expectedL1 = f2Facts
      .filter((fact) => fact.lesson === 'L1')
      .map((fact) => ({
        startMs: roundedToSeconds(fact.startMs),
        title: fact.title,
      }));
    // 注入的章节时间（5/15/25/35/45s）绝不能被采用。
    expect(exported.chapters['L1']).toEqual(expectedL1);
    expect(exported.chapters['L1'].map((cue) => cue.startMs)).not.toEqual(
      variant.chapterTimes['L1'],
    );
    console.log(
      'EVIDENCE T2 priority subtitle>chapter',
      JSON.stringify({
        injectedChapterTimes: variant.chapterTimes,
        derivedTimes: exported.chapters,
        expectedSubtitleTimes: expectedL1,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // T2-F1：无字幕/章节 → ASR 默认派生（owner 决策；设计 §14 C7 ③ / ALN-7）
  // -------------------------------------------------------------------------
  it('T2-F1a: a no-source package derives ASR times and fabricates neither 0 ms nor chapters', async () => {
    const baseBytes = await fs.readFile(F2_ZIP);
    const variantBytes = await buildNoTimingSourceVariant(baseBytes);
    const upload = await http.uploadPackage(variantBytes, 'F1_no_source.zip');
    createdJobIds.push(upload.job.jobId);
    // 无源是 incomplete（允许入库、阻止发布），不是 error。
    expect(upload.job.status).toBe('AWAITING_CONFIRM');
    const enWarnings = upload.job.report.warnings.filter(
      (warning) =>
        warning.code === 'TIMING_SOURCE_MISSING' &&
        warning.message.includes('"language":"en-GB"'),
    );
    expect(enWarnings.length).toBeGreaterThan(0);

    const confirmed = await http.confirm(upload.job.jobId);
    expect(confirmed.status).toBe(200);
    expect(confirmed.data.status).toBe('READY');
    expect(confirmed.data.courseId).toBe(courseId);
    const exported = await http.exportAndParse(courseId);

    // 把没有时间源的课程再导出一次并回导，观察「猜 0 秒」是否进入新内容。
    const roundtrip = await http.importAndConfirm(
      exported.bytes,
      'F1_no_source_roundtrip.zip',
    );
    createdJobIds.push(roundtrip.job.jobId);
    expect(roundtrip.courseId).toBe(courseId);
    const afterRoundtrip = await http.exportAndParse(courseId);

    const chapterResourcePresent = exported.manifest.resources.some(
      (resource) => resource.kind === 'chapters',
    );
    const timedVideo = exported.manifest.content.renditions
      .filter(
        (rendition) =>
          rendition.modality === 'video' &&
          rendition.startMs !== undefined &&
          rendition.endMs !== undefined,
      )
      .map((rendition) => ({
        occurrenceKey: String(rendition.occurrenceKey),
        anchorSource: rendition.anchorSource as string,
        startMs: rendition.startMs as number,
        endMs: rendition.endMs as number,
      }));
    const asrVideo = timedVideo.filter(
      (rendition) => rendition.anchorSource === 'asr',
    );
    console.log(
      'EVIDENCE T2-F1a no-source',
      JSON.stringify({
        packageWarnings: enWarnings,
        chapterResourcePresent,
        exportedChapters: exported.chapters,
        timedVideoRenditions: timedVideo.map((rendition) => ({
          occurrenceKey: rendition.occurrenceKey,
          anchorSource: rendition.anchorSource,
          startMs: rendition.startMs,
          endMs: rendition.endMs,
        })),
        afterRoundtripChapters: afterRoundtrip.chapters,
      }),
    );
    // 依据：设计 §14 C7 ③ / ALN-7 与 owner 决策——无外部时间源（字幕/章节）
    // 时由 ASR 从音轨默认派生（内部派生工件、非交付物）；T2-F1b 已单独断言
    // 该派生存在。旧断言「0 timed rendition / 无 chapters 资源」与现行契约
    // 相反，已对齐为：
    //   1) 无源包必须有 ASR 派生的机器时间；
    //   2) 所有带时间的视频都来自机器源（ASR），且是合法半开区间；
    //   3) 导出携带的 chapters（§18 B 的机器时间源）必须是 ASR 派生时间的
    //      秒级取整，且不得出现无源伪造的 0 起点（C7/TIM-1 不写 0）。
    expect(asrVideo.length).toBeGreaterThan(0);
    expect(
      timedVideo.every((rendition) => rendition.anchorSource === 'asr'),
    ).toBe(true);
    expect(
      timedVideo.every((rendition) => rendition.startMs < rendition.endMs),
    ).toBe(true);
    const chapterCues = Object.values(exported.chapters).flat();
    const asrSecondStarts = new Set(
      timedVideo.map(
        (rendition) => Math.round(rendition.startMs / 1000) * 1000,
      ),
    );
    for (const cue of chapterCues) {
      expect(cue.startMs).toBeGreaterThan(0);
      expect(asrSecondStarts.has(cue.startMs)).toBe(true);
    }
    // chapters 资源若存在，必须能解析出 cue（证明是机器时间源而非空壳）。
    if (chapterResourcePresent) {
      expect(chapterCues.length).toBeGreaterThan(0);
    }
  });

  it('T2-F1b[R]: the no-source package must fall back to ASR derivation (owner decision)', async () => {
    const variantBytes = await buildNoTimingSourceVariant(
      await fs.readFile(F2_ZIP),
    );
    const imported = await http.importAndConfirm(
      variantBytes,
      'F1_no_source_asr.zip',
    );
    createdJobIds.push(imported.job.jobId);
    expect(imported.courseId).toBe(courseId);
    const exported = await http.exportAndParse(courseId);
    const asrRenditions = exported.manifest.content.renditions.filter(
      (rendition) =>
        rendition.modality === 'video' &&
        rendition.anchorSource === 'asr' &&
        rendition.startMs !== undefined,
    );
    console.log(
      'EVIDENCE T2-F1b ASR default',
      JSON.stringify({
        asrRenditions: asrRenditions.length,
        anchorSources: [
          ...new Set(
            exported.manifest.content.renditions.map(
              (rendition) => rendition.anchorSource,
            ),
          ),
        ],
        probeHelp:
          'grep -rn "transcripts:" src --include=*.ts → only derive-timing.ts declares the input; no import shell (partc-import.ts/package-importer.ts) passes transcripts',
      }),
    );
    expect(asrRenditions.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // T1-B 替换视频 = 新 assetVersion + 旧映射失效
  // -------------------------------------------------------------------------
  it('T1-B[R]: replacing the real video must bump assetVersion and invalidate old coordinates', async () => {
    const f2Times = f2Facts
      .filter((fact) => fact.lesson === 'L1')
      .map((fact) => roundedToSeconds(fact.startMs));
    const f5Facts = fixtureSubtitleLpTimes(F5_DIR);
    const expectedL1 = f5Facts
      .filter((fact) => fact.lesson === 'L1')
      .map((fact) => ({
        startMs: roundedToSeconds(fact.startMs),
        title: fact.title,
      }));

    const f5Bytes = await fs.readFile(F5_ZIP);
    const f5Manifest = JSON.parse(
      await (
        await JSZip.loadAsync(f5Bytes)
      )
        .file('manifest.json')!
        .async('string'),
    ) as ManifestV2Like;
    const declared = f5Manifest.content.assetPins.filter(
      (pin) => pin.assetKey === 'l1-video',
    );
    expect(declared).toEqual([{ assetKey: 'l1-video', assetVersion: 2 }]);

    const imported = await http.importAndConfirm(f5Bytes, 'F5_replacement.zip');
    createdJobIds.push(imported.job.jobId);
    expect(imported.courseId).toBe(courseId);
    const exported = await http.exportAndParse(courseId);

    // 旧映射确实失效：L1 学习点按新视频重新派生（时间与 F2 不同）。
    expect(exported.chapters['L1']).toEqual(expectedL1);
    expect(exported.chapters['L1'].map((cue) => cue.startMs)).not.toEqual(
      f2Times,
    );

    console.log(
      'EVIDENCE T1-B replacement',
      JSON.stringify({
        declaredAssetPins: f5Manifest.content.assetPins,
        exportedAssetPins: exported.manifest.content.assetPins,
        exportedVideoRenditions: exported.manifest.content.renditions
          .filter((rendition) => rendition.modality === 'video')
          .slice(0, 6),
        f2Times,
        f5Times: exported.chapters['L1'].map((cue) => cue.startMs),
      }),
    );
    // 契约要求：同一 assetKey 的新版本必须体现为 assetVersion=2。
    expect(
      exported.manifest.content.assetPins.some(
        (pin) => pin.assetKey === 'l1-video' && pin.assetVersion === 2,
      ),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T2 越界/负值/空值 → error 带源坐标
  // -------------------------------------------------------------------------
  it('T2 invalid: out-of-range subtitle cue is rejected with TIMING_RANGE_INVALID and a source coordinate', async () => {
    const bytes = await fs.readFile(F4_OUT_OF_RANGE_ZIP);
    const upload = await http.uploadPackage(bytes, '05-out-of-range-time.zip');
    createdJobIds.push(upload.job.jobId);
    expect(upload.job.status).toBe('FAILED');
    expect(upload.job.courseId).toBeNull();
    const error = upload.job.report.errors.find(
      (entry) => entry.code === 'TIMING_RANGE_INVALID',
    );
    expect(error).toBeDefined();
    expect(error!.path ?? '').toMatch(/Media!\d+!relative_path/);
    expect(error!.message).toContain('startMs');
    expect(error!.message).toContain('durationMs');
    console.log(
      'EVIDENCE T2 invalid out-of-range',
      JSON.stringify({
        status: upload.job.status,
        error: error,
        allErrors: upload.job.report.errors,
      }),
    );
  });

  it('T2 invalid: negative chapter time is rejected with a source coordinate (no clamp, no guess)', async () => {
    const variant = await buildNegativeChapterVariant(
      await packZip(await readDirectoryEntries(F4_BASELINE_ZIP)),
    );
    const upload = await http.uploadPackage(variant, 'negative-chapters.zip');
    createdJobIds.push(upload.job.jobId);
    expect(upload.job.status).toBe('FAILED');
    expect(upload.job.courseId).toBeNull();
    const error = upload.job.report.errors.find(
      (entry) => entry.code === 'TIMING_SOURCE_MISSING',
    );
    expect(error).toBeDefined();
    expect(error!.path ?? '').toMatch(/Media!\d+!relative_path/);
    expect(error!.message).toContain('chapters JSON could not be parsed');
    expect(error!.message).toContain('non-negative integer millisecond');
    console.log(
      'EVIDENCE T2 invalid negative',
      JSON.stringify({ status: upload.job.status, error }),
    );
  });

  it('T2 invalid: empty subtitle is rejected with TIMING_SOURCE_MISSING and a source coordinate', async () => {
    const variant = await buildEmptySubtitleVariant(
      await packZip(await readDirectoryEntries(F4_BASELINE_ZIP)),
    );
    const upload = await http.uploadPackage(variant, 'empty-subtitle.zip');
    createdJobIds.push(upload.job.jobId);
    expect(upload.job.status).toBe('FAILED');
    expect(upload.job.courseId).toBeNull();
    const error = upload.job.report.errors.find(
      (entry) => entry.code === 'TIMING_SOURCE_MISSING',
    );
    expect(error).toBeDefined();
    expect(error!.path ?? '').toMatch(/Media!\d+!relative_path/);
    expect(error!.message).toContain('subtitle file contains no cues');
    console.log(
      'EVIDENCE T2 invalid empty',
      JSON.stringify({ status: upload.job.status, error }),
    );
  });

  // -------------------------------------------------------------------------
  // T2 模板出现时间列 → 拒绝
  // -------------------------------------------------------------------------
  it('T2 template: a time column in the template is rejected with HUMAN_TIME_FORBIDDEN', async () => {
    const variant = await buildTimeColumnVariant(
      await packZip(await readDirectoryEntries(F4_BASELINE_ZIP)),
    );
    const upload = await http.uploadPackage(variant, 'time-column.zip');
    createdJobIds.push(upload.job.jobId);
    expect(upload.job.status).toBe('FAILED');
    expect(upload.job.courseId).toBeNull();
    const error = upload.job.report.errors.find(
      (entry) => entry.code === 'HUMAN_TIME_FORBIDDEN',
    );
    expect(error).toBeDefined();
    expect(error!.message.toLowerCase()).toContain('time column');
    console.log(
      'EVIDENCE T2 template time-column',
      JSON.stringify({
        status: upload.job.status,
        error,
        allErrors: upload.job.report.errors,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 阶段 blocked 观察（ALN-1）；ALN-7/低置信当前不可黑盒触达
  // -------------------------------------------------------------------------
  it('T2 blocked observation: plan preview reports a blocked stage; ALN-7/low-confidence cannot be reached black-box', async () => {
    const preview = await agent
      .post(`/api/backoffice/courses/${COURSE_KEY}/partc/plans/preview`)
      .expect(200);
    const plan = dataOf<{
      status: string;
      gaps: Array<{ invariant: string; status: string; reason: string }>;
      issues: Array<{ code: string; invariant?: string }>;
    }>(preview);
    // 阶段在未完成人签/未完成时间源时不是 ok：blocked 或 degraded 都表示不可发布。
    expect(['blocked', 'degraded']).toContain(plan.status);
    expect(plan.gaps.length).toBeGreaterThan(0);
    expect(plan.gaps.every((gap) => gap.status !== 'ok')).toBe(true);
    expect(
      plan.issues.some((issue) => issue.code === 'ALIGNMENT_LOW_CONFIDENCE'),
    ).toBe(false);
    console.log(
      'EVIDENCE T2 blocked observation',
      JSON.stringify({
        planStatus: plan.status,
        gaps: plan.gaps,
        issues: plan.issues,
        lowConfidenceReachable: false,
      }),
    );
  });
});
