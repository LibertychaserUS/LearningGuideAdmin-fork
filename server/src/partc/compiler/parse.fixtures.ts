import { TEMPLATE_V2_HEADERS } from '../contracts';
import { TEMPLATE_VERSION } from '../version-matrix';
import type { RawPackage, RawSheet, RawWorkbook } from './parse';
import type { DocumentStructureInput } from './derive-timing';

/**
 * 编译器 P1–P4 的测试夹具（只被 *.spec.ts import，不进入生产路径）。
 *
 * 提供：真实结构的 MP4 字节（mvhd / chapter track / chpl）、SRT/VTT 文本、
 * 模板工作簿矩阵、manifest v2 与需要「旧内容重绑」的上一版 ContentVersionContent。
 * 夹具全部使用稳定 key 与整数毫秒；不含任何哈希字段（C0 红线）。
 */

export const COURSE_KEY = 'modeling-life';
export const ISO = '2026-11-12T08:00:00Z';
export const LESSON_CODE = 'lesson-01';
export const LP_CODE = 'lp-01';
export const EXHIBIT_CODE = 'ex-01';
export const DURATION_MS = 600000;

// ---------------------------------------------------------------------------
// 字节工具
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function encodeAscii(text: string): Uint8Array {
  return encoder.encode(text);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  out.set(encodeAscii(type), 4);
  out.set(payload, 8);
  return out;
}

function verFlags(): Uint8Array {
  return new Uint8Array(4);
}

// ---------------------------------------------------------------------------
// MP4 夹具（ISO BMFF）
// ---------------------------------------------------------------------------

function mvhdBox(durationMs: number, timescale = 1000): Uint8Array {
  return box(
    'mvhd',
    concatBytes(verFlags(), u32(0), u32(0), u32(timescale), u32(durationMs)),
  );
}

function tkhdBox(trackId: number, durationMs: number): Uint8Array {
  return box(
    'tkhd',
    concatBytes(
      verFlags(),
      u32(0),
      u32(0),
      u32(trackId),
      u32(0),
      u32(durationMs),
    ),
  );
}

function mdhdBox(durationMs: number, timescale = 1000): Uint8Array {
  return box(
    'mdhd',
    concatBytes(verFlags(), u32(0), u32(0), u32(timescale), u32(durationMs)),
  );
}

function hdlrBox(handler: string): Uint8Array {
  return box(
    'hdlr',
    concatBytes(
      verFlags(),
      u32(0),
      encodeAscii(handler),
      new Uint8Array(12),
      encodeAscii('handler\0'),
    ),
  );
}

function ftypBox(): Uint8Array {
  return box(
    'ftyp',
    concatBytes(encodeAscii('isom'), u32(0x200), encodeAscii('isomiso2')),
  );
}

/** 只有 mvhd 的最小 MP4（时长探测用；无 chapter track / chpl）。 */
export function buildMinimalMp4(durationMs: number): Uint8Array {
  return concatBytes(ftypBox(), box('moov', mvhdBox(durationMs)));
}

export interface ChapterFixture {
  readonly startMs: number;
  readonly title: string;
}

/**
 * 带 ffmpeg 风格 chapter text track 的 MP4：video trak 的 tref/chap 指向
 * trackId=2 的文本轨；stts/stsz/stsc/stco 定位 mdat 内的章节样本
 * （样本 = 2 字节长度 + UTF-8 文本）。
 */
export function buildMp4WithChapterTrack(
  durationMs: number,
  chapters: readonly ChapterFixture[],
): Uint8Array {
  const samples = chapters.map((chapter) =>
    concatBytes(
      u16(encodeAscii(chapter.title).length),
      encodeAscii(chapter.title),
    ),
  );
  const mdatPayload = concatBytes(...samples);

  const deltas = chapters.map((chapter, index) =>
    index + 1 < chapters.length
      ? chapters[index + 1].startMs - chapter.startMs
      : durationMs - chapter.startMs,
  );
  const stts = box(
    'stts',
    concatBytes(
      verFlags(),
      u32(deltas.length),
      ...deltas.map((delta) => concatBytes(u32(1), u32(delta))),
    ),
  );
  const stsz = box(
    'stsz',
    concatBytes(
      verFlags(),
      u32(0),
      u32(samples.length),
      ...samples.map((sample) => u32(sample.length)),
    ),
  );
  const stsc = box(
    'stsc',
    concatBytes(verFlags(), u32(1), u32(1), u32(samples.length), u32(1)),
  );

  const videoTrak = box(
    'trak',
    concatBytes(
      tkhdBox(1, durationMs),
      box('mdia', concatBytes(mdhdBox(durationMs), hdlrBox('vide'))),
      box('tref', box('chap', u32(2))),
    ),
  );

  const buildChapterTrak = (chunkOffset: number): Uint8Array =>
    box(
      'trak',
      concatBytes(
        tkhdBox(2, durationMs),
        box(
          'mdia',
          concatBytes(
            mdhdBox(durationMs),
            hdlrBox('text'),
            box(
              'minf',
              box(
                'stbl',
                concatBytes(
                  stts,
                  stsz,
                  stsc,
                  box(
                    'stco',
                    concatBytes(verFlags(), u32(1), u32(chunkOffset)),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );

  // moov 长度与 stco 的值无关；先用 0 量长度，再用真实 mdat 起点重建。
  const probeMoov = box(
    'moov',
    concatBytes(mvhdBox(durationMs), videoTrak, buildChapterTrak(0)),
  );
  const chunkOffset = ftypBox().length + probeMoov.length + 8;
  const moov = box(
    'moov',
    concatBytes(mvhdBox(durationMs), videoTrak, buildChapterTrak(chunkOffset)),
  );
  return concatBytes(ftypBox(), moov, box('mdat', mdatPayload));
}

/** 带 Nero chpl 盒的 MP4（chapter track 的兼容回退路径）。 */
export function buildMp4WithChpl(
  durationMs: number,
  chapters: readonly ChapterFixture[],
): Uint8Array {
  const entries = chapters.map((chapter) =>
    concatBytes(
      u64(chapter.startMs * 10000), // chpl 起点单位 = 100ns
      new Uint8Array([encodeAscii(chapter.title).length]),
      encodeAscii(chapter.title),
    ),
  );
  const chpl = box(
    'chpl',
    concatBytes(
      new Uint8Array([1, 0, 0, 0]), // version 1
      u32(0), // reserved
      new Uint8Array([chapters.length]),
      ...entries,
    ),
  );
  return concatBytes(
    ftypBox(),
    box('moov', concatBytes(mvhdBox(durationMs), box('udta', chpl))),
  );
}

// ---------------------------------------------------------------------------
// 字幕文本
// ---------------------------------------------------------------------------

export interface CueFixture {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

function srtTime(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  const pad = (value: number, width: number): string =>
    String(value).padStart(width, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}

export function buildSrt(cues: readonly CueFixture[]): string {
  return cues
    .map(
      (cue, index) =>
        `${index + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${cue.text}\n`,
    )
    .join('\n');
}

export function buildVtt(cues: readonly CueFixture[]): string {
  const body = cues
    .map(
      (cue, index) =>
        `${index + 1}\n${srtTime(cue.startMs).replace(',', '.')} --> ${srtTime(cue.endMs).replace(',', '.')}\n${cue.text}\n`,
    )
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

export const EN_CUES: readonly CueFixture[] = [
  { startMs: 1000, endMs: 4000, text: 'Welcome to modeling life.' },
  { startMs: 5000, endMs: 9500, text: 'Why models matter' },
  { startMs: 10000, endMs: 12000, text: 'Here is a model.' },
];

export const ZH_CUES: readonly CueFixture[] = [
  { startMs: 1000, endMs: 4000, text: '欢迎学习建模人生。' },
  { startMs: 5000, endMs: 9500, text: '为什么模型重要' },
  { startMs: 10000, endMs: 12000, text: '这是一个模型。' },
];

// ---------------------------------------------------------------------------
// 模板工作簿
// ---------------------------------------------------------------------------

function sheet(
  name: keyof typeof TEMPLATE_V2_HEADERS,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): RawSheet {
  return { headers: [...TEMPLATE_V2_HEADERS[name]], rows };
}

export function buildWorkbook(): RawWorkbook {
  return {
    sheets: {
      Meta: sheet('Meta', [
        [TEMPLATE_VERSION, COURSE_KEY, 'en-GB,zh-CN', 'both'],
      ]),
      Media: sheet('Media', [
        ['asset-cover', 'cover', null, null, 'media/cover.png', null],
        [
          'asset-video-en',
          'video',
          LESSON_CODE,
          'en-GB',
          'media/lesson-01.en.mp4',
          null,
        ],
        [
          'asset-video-zh',
          'video',
          LESSON_CODE,
          'zh-CN',
          'media/lesson-01.zh.mp4',
          null,
        ],
        [
          'asset-sub-en',
          'subtitle',
          LESSON_CODE,
          'en-GB',
          'subtitles/lesson-01.en-GB.srt',
          null,
        ],
        [
          'asset-sub-zh',
          'subtitle',
          LESSON_CODE,
          'zh-CN',
          'subtitles/lesson-01.zh-CN.srt',
          null,
        ],
        [
          'asset-doc-en',
          'lesson-text',
          LESSON_CODE,
          'en-GB',
          'lessons/lesson-01.en-GB.docx',
          null,
        ],
        [
          'asset-doc-zh',
          'lesson-text',
          LESSON_CODE,
          'zh-CN',
          'lessons/lesson-01.zh-CN.docx',
          null,
        ],
        [
          'asset-image-01',
          'image',
          LESSON_CODE,
          'en-GB',
          'media/ex-01.png',
          null,
        ],
        [
          'asset-image-01-thumb',
          'thumbnail',
          LESSON_CODE,
          null,
          'media/ex-01-thumb.png',
          'asset-image-01',
        ],
      ]),
      'Course Info': sheet('Course Info', [
        ['title', 'en-GB', 'Modeling Life'],
        ['title', 'zh-CN', '建模人生'],
        ['shortDescription', 'en-GB', 'A course about models'],
        ['shortDescription', 'zh-CN', '一门关于模型的课程'],
        ['overview', 'en-GB', 'Overview'],
        ['overview', 'zh-CN', '概述'],
        ['whatYouLearn', 'en-GB', 'Model thinking'],
        ['whatYouLearn', 'zh-CN', '模型思维'],
        ['provides', 'en-GB', 'Science'],
        ['provides', 'zh-CN', 'Science'],
      ]),
      Lessons: sheet('Lessons', [
        [LESSON_CODE, 1, 'en-GB', 'Why models matter', 'Lesson description'],
        [LESSON_CODE, 1, 'zh-CN', '为什么模型重要', '课时描述'],
      ]),
      'Learning Points': sheet('Learning Points', [
        [LESSON_CODE, LP_CODE, 'en-GB', 'Why models matter'],
        [LESSON_CODE, LP_CODE, 'zh-CN', '为什么模型重要'],
      ]),
      Exhibits: sheet('Exhibits', [
        [
          LESSON_CODE,
          EXHIBIT_CODE,
          'image',
          'asset-image-01',
          'en-GB',
          'A model',
          'A model photo',
          null,
        ],
        [
          LESSON_CODE,
          EXHIBIT_CODE,
          'image',
          'asset-image-01',
          'zh-CN',
          '一个模型',
          '一张模型照片',
          null,
        ],
      ]),
      'Reading List': sheet('Reading List', [
        [
          LESSON_CODE,
          'book',
          'Thinking in Systems',
          'Donella Meadows',
          'Systems thinking primer',
        ],
      ]),
      'Knowledge Test': sheet('Knowledge Test', [
        [
          LESSON_CODE,
          1,
          'en-GB',
          'What is a model?',
          'A simplified representation',
        ],
        [LESSON_CODE, 1, 'zh-CN', '什么是模型？', '一种简化的表示'],
      ]),
      'Application Test': sheet('Application Test', [
        [
          LESSON_CODE,
          'en-GB',
          'Apply modeling to your work.',
          'Describe a model you use.',
        ],
        [
          LESSON_CODE,
          'zh-CN',
          '把建模应用到你的工作中。',
          '描述你使用的一个模型。',
        ],
      ]),
    },
  };
}

// ---------------------------------------------------------------------------
// 文档结构（DOCX 抽取产物的夹具）
// ---------------------------------------------------------------------------

export function buildDocuments(): DocumentStructureInput[] {
  return [
    {
      assetKey: 'asset-doc-en',
      lessonCode: LESSON_CODE,
      language: 'en-GB',
      headings: [
        { headingCode: '1.1', title: 'Why models matter', offset: 120 },
      ],
      triggerMarkers: [
        { exhibitCode: EXHIBIT_CODE, lineText: 'Here is a model.' },
      ],
      html: '<p>Welcome to modeling life.</p><h1>Why models matter</h1><p>Here is a model.</p>',
    },
    {
      assetKey: 'asset-doc-zh',
      lessonCode: LESSON_CODE,
      language: 'zh-CN',
      headings: [{ headingCode: '1.1', title: '为什么模型重要', offset: 100 }],
      triggerMarkers: [
        { exhibitCode: EXHIBIT_CODE, lineText: '这是一个模型。' },
      ],
      html: '<p>欢迎学习建模人生。</p><h1>为什么模型重要</h1><p>这是一个模型。</p>',
    },
  ];
}

// ---------------------------------------------------------------------------
// manifest 内容
// ---------------------------------------------------------------------------

export function baseCourse() {
  return {
    courseKey: COURSE_KEY,
    titleLocalized: {
      'en-GB': { title: 'Modeling Life' },
      'zh-CN': { title: '建模人生' },
    },
    categoryPath: ['Science'],
    learningLanguages: ['en-GB', 'zh-CN'],
    studyMode: 'both',
  };
}

export function baseEvidenceSpec() {
  return {
    evidenceKey: 'ev-01',
    version: 1,
    kind: 'artifact',
    objectiveKeys: ['obj-01'],
    measure: { kind: 'artifact', instructions: 'Submit a model diagram.' },
    scoring: 'pass-fail',
    threshold: 1,
    attempts: 1,
  };
}

export function baseContent() {
  return {
    courseKey: COURSE_KEY,
    versionNo: 1,
    categoryPath: ['Science'],
    stages: [
      {
        courseKey: COURSE_KEY,
        stageKey: 'prog-01',
        parentStageKey: null,
        orderKey: '000001',
        kind: 'program',
        goal: 'Modeling life program',
        objectiveKeys: [],
        exitEvidence: [],
        exitRollup: { kind: 'all' },
        status: 'active',
      },
      {
        courseKey: COURSE_KEY,
        stageKey: 'step-01',
        parentStageKey: 'prog-01',
        orderKey: '000001.000001',
        kind: 'step',
        goal: 'Explain the purpose of a model',
        objectiveKeys: ['obj-01'],
        exitEvidence: ['ev-01'],
        exitRollup: { kind: 'atLeast', n: 1 },
        durationBudget: DURATION_MS,
        status: 'active',
      },
    ],
    prerequisiteEdges: [],
    specPins: [],
    renditions: [],
    alignments: [],
    evidenceSpecs: [baseEvidenceSpec()],
    assetPins: [],
  };
}

export interface PriorContentOptions {
  readonly carrierVersion?: number;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly revision?: number;
  readonly provenance?: 'human' | 'legacy' | 'import';
  readonly includeDocumentRendition?: boolean;
}

/**
 * 上一版（导出侧）ContentVersionContent：携带 verified 对齐与旧 rendition，
 * 用于验证 P4「blockId+anchorSig 不变 → 重绑；变化 → stale」与 provenance 继承。
 */
export function priorContent(options: PriorContentOptions = {}) {
  const carrierVersion = options.carrierVersion ?? 5;
  const startMs = options.startMs ?? 5000;
  const endMs = options.endMs ?? 9500;
  const revision = options.revision ?? 2;
  const provenance = options.provenance ?? 'human';
  const content = baseContent();
  (content as { specPins: unknown[] }).specPins = [
    { contentKey: LESSON_CODE, version: 1 },
  ];
  (content as { assetPins: unknown[] }).assetPins = [
    { assetKey: 'asset-video-en', assetVersion: carrierVersion },
  ];
  (content as { renditions: unknown[] }).renditions = [
    {
      renditionKey: 'old-r-lp-en',
      contentKey: LESSON_CODE,
      blockId: 'video',
      language: 'en-GB',
      modality: 'video',
      occurrenceKey: `lp.${LP_CODE}`,
      carrierType: 'asset',
      carrierKey: 'asset-video-en',
      carrierVersion,
      startMs,
      endMs,
      anchorSource: 'subtitle',
      revision,
    },
  ];
  (content as { alignments: unknown[] }).alignments = [
    {
      alignmentId: 'aln-old-1',
      stageKey: 'step-01',
      renditionKey: 'old-r-lp-en',
      objectiveKey: 'obj-01',
      role: 'primary',
      status: 'verified',
      provenance,
      verifiedBy: 'employee-1',
      verifiedAt: ISO,
      verifiedAgainst: {
        renditionRevision: revision,
        carrierVersion,
        specVersion: 1,
      },
    },
  ];
  return content;
}

// ---------------------------------------------------------------------------
// 课程包
// ---------------------------------------------------------------------------

interface ResourceFixture {
  readonly id: string;
  readonly kind: string;
  readonly path: string;
  readonly bytes: Uint8Array;
}

function buildResources(durationMs: number): ResourceFixture[] {
  return [
    {
      id: 'template-01',
      kind: 'template',
      path: 'template.xlsx',
      bytes: new Uint8Array([0x50, 0x4b, 3, 4, 1, 2]),
    },
    {
      id: 'asset-cover',
      kind: 'cover',
      path: 'media/cover.png',
      bytes: new Uint8Array([137, 80, 78, 71, 1]),
    },
    {
      id: 'asset-video-en',
      kind: 'video',
      path: 'media/lesson-01.en.mp4',
      bytes: buildMinimalMp4(durationMs),
    },
    {
      id: 'asset-video-zh',
      kind: 'video',
      path: 'media/lesson-01.zh.mp4',
      bytes: buildMinimalMp4(durationMs),
    },
    {
      id: 'asset-sub-en',
      kind: 'subtitle',
      path: 'subtitles/lesson-01.en-GB.srt',
      bytes: encodeAscii(buildSrt(EN_CUES)),
    },
    {
      id: 'asset-sub-zh',
      kind: 'subtitle',
      path: 'subtitles/lesson-01.zh-CN.srt',
      bytes: encodeAscii(buildSrt(ZH_CUES)),
    },
    {
      id: 'asset-doc-en',
      kind: 'document',
      path: 'lessons/lesson-01.en-GB.docx',
      bytes: new Uint8Array([0x50, 0x4b, 3, 4, 9]),
    },
    {
      id: 'asset-doc-zh',
      kind: 'document',
      path: 'lessons/lesson-01.zh-CN.docx',
      bytes: new Uint8Array([0x50, 0x4b, 3, 4, 10]),
    },
    {
      id: 'asset-image-01',
      kind: 'image',
      path: 'media/ex-01.png',
      bytes: new Uint8Array([137, 80, 78, 71, 2]),
    },
    {
      id: 'asset-image-01-thumb',
      kind: 'thumbnail',
      path: 'media/ex-01-thumb.png',
      bytes: new Uint8Array([137, 80, 78, 71, 3]),
    },
  ];
}

export interface PackageFixtureOptions {
  readonly durationMs?: number;
  readonly content?: unknown;
  readonly course?: unknown;
  readonly workbook?: RawWorkbook;
  /**
   * provenance 覆盖：undefined = 默认 sandbox 来源（C10.6）；
   * null = 包内不带 provenance 块（休眠开关下的兼容路径）；其余值原样写入。
   */
  readonly provenance?: unknown;
}

export interface PackageFixture {
  readonly pkg: RawPackage;
  readonly documents: DocumentStructureInput[];
}

/** C10.6 默认 provenance：sandbox 导出的包。 */
export function baseProvenance() {
  return {
    sourceEnv: 'sandbox',
    sourceVersionLabel: '4.2',
    exportedAt: ISO,
    exportedBy: 'operator@example.com',
    courseKey: COURSE_KEY,
    planPin: {
      planId: `plan/${COURSE_KEY}/cv-01/target-01/v1`,
      planVersion: 1,
    },
    approvalRef: 'APR-0001',
    auditSummaryRef: 'audit/2026-11-12-modeling-life-1.json',
  };
}

/** 合法闭合 v2 包（valid happy-path fixture，所有门禁可通过）。 */
export function buildPackageFixture(
  options: PackageFixtureOptions = {},
): PackageFixture {
  const durationMs = options.durationMs ?? DURATION_MS;
  const resources = buildResources(durationMs);
  const files = new Map<string, Uint8Array>();
  for (const resource of resources) files.set(resource.path, resource.bytes);

  const provenance =
    options.provenance === undefined ? baseProvenance() : options.provenance;

  const manifest = {
    format: 'lg-course-package',
    formatVersion: 2,
    packageId: 'pkg-01',
    exportedAt: ISO,
    minReaderVersion: 2,
    extensionsUsed: [],
    extensionsRequired: [],
    ...(provenance === null ? {} : { provenance }),
    course: options.course ?? baseCourse(),
    content: options.content ?? baseContent(),
    resources: resources.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      path: resource.path,
      size: resource.bytes.length,
    })),
  };

  return {
    pkg: {
      manifest,
      files,
      workbook: options.workbook ?? buildWorkbook(),
    },
    documents: buildDocuments(),
  };
}

/** 替换包内文件字节（用于 size-mismatch 等负例）。 */
export function withFileBytes(
  pkg: RawPackage,
  path: string,
  bytes: Uint8Array,
): RawPackage {
  const files = new Map(pkg.files);
  files.set(path, bytes);
  return { ...pkg, files };
}

/** 替换资源字节并同步 manifest 声明 size（闭合包 1:1 仍然成立）。 */
export function replaceResourceBytes(
  pkg: RawPackage,
  resourceId: string,
  bytes: Uint8Array,
): RawPackage {
  const manifest = clone(pkg.manifest) as {
    resources: Array<{ id: string; path: string; size: number }>;
  };
  const resource = manifest.resources.find((item) => item.id === resourceId);
  if (resource === undefined) throw new Error(`unknown resource ${resourceId}`);
  resource.size = bytes.length;
  const files = new Map(pkg.files);
  files.set(resource.path, bytes);
  return { ...pkg, files, manifest };
}

/** 删除资源声明与文件（媒体登记行需由调用方同步从工作簿移除）。 */
export function removeResource(
  pkg: RawPackage,
  resourceId: string,
): RawPackage {
  const manifest = clone(pkg.manifest) as {
    resources: Array<{ id: string; path: string }>;
  };
  const resource = manifest.resources.find((item) => item.id === resourceId);
  if (resource === undefined) throw new Error(`unknown resource ${resourceId}`);
  manifest.resources = manifest.resources.filter(
    (item) => item.id !== resourceId,
  );
  const files = new Map(pkg.files);
  files.delete(resource.path);
  return { ...pkg, files, manifest };
}

export function withoutFile(pkg: RawPackage, path: string): RawPackage {
  const files = new Map(pkg.files);
  files.delete(path);
  return { ...pkg, files };
}
