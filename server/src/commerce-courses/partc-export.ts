import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import {
  PackageManifestV2Schema,
  type Alignment,
  type ContentVersionContent,
  type PackageManifestV2,
  type PackageProvenance,
  type PrerequisiteEdge,
  type Rendition,
  type Stage,
} from '../partc/contracts';
import {
  PACKAGE_FORMAT_TAG,
  PACKAGE_FORMAT_VERSION,
  TEMPLATE_VERSION,
} from '../partc/version-matrix';
import type {
  PackageCourse,
  PackageExhibit,
  PackageLesson,
} from './contracts/manifest';

/**
 * 课程包 Part C v2 导出装配器（评审阻断 2/3/9；设计 SSOT §14 C0/C6/C10.3/C10.4）。
 *
 * - 唯一契约：产物必须通过 `PackageManifestV2Schema`（SSOT）校验后才写出；
 *   manifest 含 provenance/annotations（C10.4/C10.6）与 asr pin（C7）。
 * - 闭合包：manifest.json 是唯一入口，resources 与包内文件一一对应；不写任何
 *   哈希清单（C0 红线⑦），传输完整性靠 ZIP CRC32 + 大小/类型。
 * - 分类：只写完整 `categoryPath`（父链在前）；未分类 null；禁止占位词。
 * - 时间：导出不发明时间；旧课程的学习点/触发秒值以 `chapters`（机器章节源）
 *   随包携带，导入端按 C7 规则从章节源派生毫秒区间；rendition 的
 *   `anchorSource = import-legacy` 供重绑基准。模板本身无任何时间列。
 * - 阶段树：旧课程没有显式阶段树，导出按“课程 program → 每课时 step”生成
 *   机器结构（objective/evidence 由课时机械派生），不虚构教学内容。
 */

type SheetName =
  | 'Meta'
  | 'Media'
  | 'Course Info'
  | 'Lessons'
  | 'Learning Points'
  | 'Exhibits'
  | 'Reading List'
  | 'Knowledge Test'
  | 'Application Test';

const HEADERS: Record<SheetName, string[]> = {
  Meta: ['templateVersion', 'courseCode', 'learningLanguages', 'studyMode'],
  Media: [
    'asset_key',
    'kind',
    'lesson_code',
    'language',
    'relative_path',
    'thumbnail_of',
  ],
  'Course Info': ['field', 'language', 'text'],
  Lessons: ['lesson_code', 'order', 'language', 'title', 'description'],
  'Learning Points': ['lesson_code', 'lp_code', 'language', 'title'],
  Exhibits: [
    'lesson_code',
    'exhibit_code',
    'media_type',
    'asset_key',
    'language',
    'title',
    'description',
    'source',
  ],
  'Reading List': ['lesson_code', 'type', 'title', 'author', 'why'],
  'Knowledge Test': [
    'lesson_code',
    'order',
    'language',
    'question',
    'reference_answer',
  ],
  'Application Test': [
    'lesson_code',
    'language',
    'question',
    'reference_answer',
  ],
};

interface MediaRegistration {
  readonly assetKey: string;
  readonly kind: string;
  readonly lessonCode: string | null;
  readonly language: string | null;
  readonly relativePath: string;
  readonly thumbnailOf: string | null;
  readonly bytes: Buffer;
  readonly resourceKind: string;
}

export interface PartcExportIdentity {
  readonly courseKey: string;
  readonly slug: string;
  readonly categoryPath: string[] | null;
  readonly learningLanguages: string[];
  readonly studyMode: 'video' | 'text' | 'both';
  readonly titleLocalized: Record<string, Record<string, string>>;
  /** 本环境单调版本号（草稿导出用 1；版本导出用该版本 versionNo）。 */
  readonly versionNo: number;
}

export interface PartcExportOptions {
  readonly identity: PartcExportIdentity;
  readonly provenance: PackageProvenance;
  readonly annotations: Record<string, unknown>;
  readonly exportedAt: string;
  /**
   * 本环境 Pc 数据中的 verified 对齐（含 C3/C10.4 审计元组）。
   *
   * 导出只搬运 Pc 真源里已签收的对齐；但课程包内容来自工作区聚合（模板/媒体），
   * 因此只写“能被本包表达”的对齐：引用已导出 stage/rendition、objective 属于
   * 该 stage、且 verifiedAgainst 与导出的 rendition/pin 一致。其余不写入包
   * （包的 content 必须自洽，契约 superRefine 会拒绝悬空引用）。
   */
  readonly alignments?: readonly Alignment[];
  /**
   * 本环境 Pc 真源的媒体身份（C3/C10.1：assetKey 环境无关，assetVersion 单调）。
   *
   * 导出模板/清单必须沿用包导入时的 `assetKey + assetVersion`，不得重新合成
   * 环境本地 key（B 缺陷：换视频后导出仍需体现 `l1-video@2`，否则旧映射与
   * 资产版本无法判 stale）。未提供时按旧行为从工作区聚合生成稳定 key。
   */
  readonly carriedMedia?: readonly CarriedMediaAsset[];
  /**
   * Pc 真源的 rendition 记录（C3/C10.4）。提供时导出 `content.renditions`
   * 原样使用 Pc 记录（稳定 renditionKey/carrierKey/carrierVersion/revision/
   * 坐标/时间源），不再用 legacy 聚合重新合成键；对齐也按这些记录直接
   * 筛 verified。缺省时回退 legacy 合成（仅旧课程）。
   */
  readonly pcRenditions?: readonly Rendition[];
  /**
   * Pc 真源的媒体字节（按 assetKey+assetVersion）。用于把视频/文档/展品/
   * 字幕的真实文件随包携带：文档必须用原始 DOCX（重新生成会丢 Heading），
   * 字幕必须随包（否则跨环境只能按章节重新猜时间）。
   */
  readonly carriedAssets?: readonly CarriedAsset[];
  /**
   * C10.4：Pc 真源的阶段树/证据规格（导入课程导出时必须原样携带稳定
   * stageKey，否则跨环境无法还原阶段身份与 verified 对齐）。缺省时按旧
   * legacy 内容机械合成（仅用于从未进入 Part C 的旧课程）。
   */
  readonly stages?: readonly Stage[];
  readonly evidenceSpecs?: readonly ContentVersionContent['evidenceSpecs'][number][];
  /** C3/C10.4：Pc 真源的先修 DAG（DAG 不是树，必须原样携带）。 */
  readonly prerequisiteEdges?: readonly PrerequisiteEdge[];
}

/** PcMediaAsset 的字节投影（导出按 assetKey+assetVersion 取真源文件）。 */
export interface CarriedAsset {
  readonly assetKey: string;
  readonly assetVersion: number;
  /** PcMediaAsset.kind（cover/video/image/model3d/thumbnail/lesson-text/subtitle/chapters）。 */
  readonly kind: string;
  readonly language: string | null;
  /** 文件扩展名（不含点；用于包内路径，如 srt/vtt/docx/json）。 */
  readonly extension: string;
  readonly bytes: Buffer;
}

/** PcRendition 的媒体身份投影（导出按 slot 回填 assetKey/assetVersion）。 */
export interface CarriedMediaAsset {
  readonly contentKey: string;
  readonly blockId: string;
  readonly language: string;
  readonly modality: string;
  readonly occurrenceKey: string;
  readonly carrierType: string;
  readonly carrierKey: string;
  readonly carrierVersion: number;
  /**
   * C7 时间审计：该 rendition 的真实机器时间源（subtitle/chapter/asr/…）。
   * 导出必须原样携带，否则重导出会把 ASR/字幕派生结果伪装成 import-legacy。
   */
  readonly anchorSource: string;
}

export interface PartcPackageArtifacts {
  /** Part C v2 包字节。 */
  readonly bytes: Buffer;
  /** 已通过契约校验的 manifest（便于测试/审计断言）。 */
  readonly manifest: PackageManifestV2;
}

function stableToken(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, 100);
  return cleaned === '' ? fallback : cleaned;
}

function studyModeOf(course: PackageCourse): 'video' | 'text' | 'both' {
  switch (course.learningMode) {
    case 'VIDEO_ONLY':
      return 'video';
    case 'TEXT_ONLY':
      return 'text';
    default:
      return 'both';
  }
}

function exhibitMediaType(exhibit: PackageExhibit): string {
  switch (exhibit.type) {
    case 'IMAGE':
      return 'image';
    case 'VIDEO':
      return 'video';
    case 'MODEL3D':
      return 'model3d';
    default:
      return 'image';
  }
}

function exhibitResourceKind(mediaType: string): string {
  return mediaType;
}

function textOfProvide(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['title', 'name', 'text', 'label']) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        return candidate.trim();
      }
    }
  }
  return null;
}

/**
 * 生成最小可用 DOCX（正文 HTML → WordprocessingML）：保留段落与标题 1 结构，
 * mammoth 可读回（导入端唯一 DOCX 解析链路）。导出只做内容搬运，不改写正文。
 */
async function buildDocxFromHtml(html: string): Promise<Buffer> {
  const escapeXml = (text: string): string =>
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const blocks: string[] = [];
  const matches = html.matchAll(/<(h1|h2|p|li)[^>]*>([\s\S]*?)<\/\1>/gi);
  const pushParagraph = (style: 'Heading1' | null, text: string): void => {
    if (text.trim() === '') return;
    const paragraphStyle =
      style === null ? '' : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
    blocks.push(
      `<w:p>${paragraphStyle}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`,
    );
  };
  for (const match of matches) {
    const tag = match[1].toLowerCase();
    const text = match[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    pushParagraph(tag === 'h1' ? 'Heading1' : null, text);
  }
  if (blocks.length === 0) {
    pushParagraph(null, html.replace(/<[^>]+>/g, ' ').trim());
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${blocks.join('')}<w:sectPr/></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/></w:style>
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

function expandVideoAnchors(
  points: Array<{ code: string; timeSeconds: number | null }>,
  durationMs: number | null,
): Array<{ code: string; startMs: number; endMs: number }> {
  const sorted = [...points]
    .filter(
      (point): point is { code: string; timeSeconds: number } =>
        point.timeSeconds !== null && Number.isFinite(point.timeSeconds),
    )
    .sort((left, right) =>
      left.timeSeconds !== right.timeSeconds
        ? left.timeSeconds - right.timeSeconds
        : left.code < right.code
          ? -1
          : 1,
    );
  const out: Array<{ code: string; startMs: number; endMs: number }> = [];
  for (const [index, point] of sorted.entries()) {
    const startMs = Math.max(0, Math.round(point.timeSeconds * 1000));
    const next = sorted[index + 1];
    const duration = durationMs ?? null;
    let endMs: number;
    if (next !== undefined && Math.round(next.timeSeconds * 1000) > startMs) {
      endMs = Math.round(next.timeSeconds * 1000);
    } else if (duration !== null && duration > startMs) {
      endMs = duration;
    } else {
      endMs = startMs + 1000;
    }
    if (endMs <= startMs) continue;
    out.push({ code: point.code, startMs, endMs });
  }
  return out;
}

interface BuiltPackage {
  readonly media: MediaRegistration[];
  readonly templateBytes: Buffer;
  readonly content: ContentVersionContent;
}

/**
 * 把导出包内的媒体身份替换为 Pc 真源（assetKey + assetVersion）。
 *
 * 只做机械重命名：Media 工作表的 asset_key、manifest.resources[].id、
 * content.assetPins 与 rendition 的 carrierKey/carrierVersion。内容、路径、
 * 坐标与审计元组均不改写；找不到对应 slot 的媒体（封面/缩略图等）保持原样。
 */
function applyCarriedMedia(
  built: BuiltPackage,
  carried: readonly CarriedMediaAsset[],
): BuiltPackage {
  const workbook = XLSX.read(built.templateBytes, { type: 'buffer' });
  const mediaSheet = workbook.Sheets.Media;
  const exhibitSheet = workbook.Sheets.Exhibits;
  const mediaRows =
    mediaSheet === undefined
      ? []
      : XLSX.utils.sheet_to_json<unknown[]>(mediaSheet, {
          header: 1,
          defval: null,
          raw: true,
        });
  const exhibitRows =
    exhibitSheet === undefined
      ? []
      : XLSX.utils.sheet_to_json<unknown[]>(exhibitSheet, {
          header: 1,
          defval: null,
          raw: true,
        });

  const videoByLessonLanguage = new Map<string, CarriedMediaAsset>();
  const documentByLessonLanguage = new Map<string, CarriedMediaAsset>();
  const exhibitByLessonCode = new Map<string, CarriedMediaAsset>();
  const thumbnailByLessonBlock = new Map<string, CarriedMediaAsset>();
  for (const asset of carried) {
    if (asset.carrierType === 'asset' && asset.occurrenceKey === 'thumbnail') {
      thumbnailByLessonBlock.set(
        `${asset.contentKey}\u0000${asset.blockId}`,
        asset,
      );
      continue;
    }
    if (asset.carrierType === 'document' && asset.blockId === 'body') {
      documentByLessonLanguage.set(
        `${asset.contentKey}\u0000${asset.language}`,
        asset,
      );
      continue;
    }
    if (
      asset.carrierType === 'asset' &&
      asset.modality === 'video' &&
      asset.blockId === 'video'
    ) {
      videoByLessonLanguage.set(
        `${asset.contentKey}\u0000${asset.language}`,
        asset,
      );
      continue;
    }
    if (
      asset.carrierType === 'asset' &&
      asset.blockId !== 'video' &&
      asset.modality !== 'text' &&
      // 展品触发 rendition 的 blockId 也是展品 code，但载体是视频文件
      // （modality=video）；它们走视频行的携带，不能覆盖展品图片行。
      asset.modality !== 'video' &&
      // 缩略图 rendition 与主图同 blockId；Media 主图行只能对 main。
      asset.occurrenceKey === 'main'
    ) {
      exhibitByLessonCode.set(
        `${asset.contentKey}\u0000${asset.blockId}`,
        asset,
      );
    }
  }

  // C7/C10.4：导出携带真实时间源。按 (contentKey, blockId, language,
  // modality) 归并 rendition 的 anchorSource；同一组出现不同来源时不猜，
  // 保留导出端原有取值（冲突会由后续人工复核显式暴露）。
  const anchorSourceByIdentity = new Map<string, string | null>();
  const renditionIdentity = (value: {
    contentKey: string;
    blockId: string;
    language: string;
    modality: string;
  }): string =>
    `${value.contentKey}\u0000${value.blockId}\u0000${value.language}\u0000${value.modality}`;
  for (const asset of carried) {
    const key = renditionIdentity(asset);
    const existing = anchorSourceByIdentity.get(key);
    if (existing === undefined) {
      anchorSourceByIdentity.set(key, asset.anchorSource);
    } else if (existing !== asset.anchorSource) {
      anchorSourceByIdentity.set(key, null);
    }
  }

  // Exhibits 工作表：asset_key → (lesson_code, exhibit_code)。
  const exhibitCodeByAssetKey = new Map<
    string,
    { lessonCode: string; exhibitCode: string }
  >();
  for (const row of exhibitRows.slice(1)) {
    const [lessonCode, exhibitCode, , assetKey] = row as [
      string,
      string,
      string,
      string | null,
    ];
    if (
      typeof lessonCode === 'string' &&
      typeof exhibitCode === 'string' &&
      typeof assetKey === 'string' &&
      assetKey !== ''
    ) {
      exhibitCodeByAssetKey.set(assetKey, { lessonCode, exhibitCode });
    }
  }

  // Media 工作表：asset_key(0) | kind(1) | lesson_code(2) | language(3)
  const renamed = new Map<string, { assetKey: string; version: number }>();
  for (let index = 1; index < mediaRows.length; index += 1) {
    const row = mediaRows[index];
    const assetKey = row[0];
    const kind = row[1];
    const lessonCode = row[2];
    const language = row[3];
    if (typeof assetKey !== 'string' || assetKey === '') continue;
    let target: CarriedMediaAsset | undefined;
    if (
      kind === 'video' &&
      typeof lessonCode === 'string' &&
      typeof language === 'string'
    ) {
      target = videoByLessonLanguage.get(`${lessonCode}\u0000${language}`);
    } else if (
      kind === 'lesson-text' &&
      typeof lessonCode === 'string' &&
      typeof language === 'string'
    ) {
      target = documentByLessonLanguage.get(`${lessonCode}\u0000${language}`);
    } else if (kind === 'thumbnail' && typeof lessonCode === 'string') {
      // legacy 缩略图键 `exhibit-<code>-thumb` → Pc `l1-ex1-thumb`。
      const match = /^exhibit-(.+)-thumb$/.exec(assetKey);
      if (match !== null) {
        target = thumbnailByLessonBlock.get(`${lessonCode}\u0000${match[1]}`);
      }
    } else if (
      (kind === 'image' || kind === 'video' || kind === 'model3d') &&
      typeof lessonCode === 'string' &&
      (language === null || language === undefined)
    ) {
      const exhibit = exhibitCodeByAssetKey.get(assetKey);
      if (exhibit !== undefined) {
        target = exhibitByLessonCode.get(
          `${exhibit.lessonCode}\u0000${exhibit.exhibitCode}`,
        );
      }
    }
    if (target !== undefined && target.carrierKey !== assetKey) {
      renamed.set(assetKey, {
        assetKey: target.carrierKey,
        version: target.carrierVersion,
      });
      row[0] = target.carrierKey;
    }
  }

  // 缩略图行的 thumbnail_of(5) 指向主图 asset_key；主图改名后必须同步，
  // 否则重导入时 REFERENCE_UNRESOLVED（闭合包引用必须可解析）。
  if (renamed.size > 0) {
    for (let index = 1; index < mediaRows.length; index += 1) {
      const row = mediaRows[index];
      if (row[1] !== 'thumbnail') continue;
      const thumbnailOf = row[5];
      if (typeof thumbnailOf !== 'string' || thumbnailOf === '') continue;
      const target = renamed.get(thumbnailOf);
      if (target !== undefined) row[5] = target.assetKey;
    }
  }

  // 携带真实时间源（即使没有重命名也要落）；同时按 carriedMedia 回填
  // carrierKey/carrierVersion（换视频 = 新版本）。
  const nextRenditions = built.content.renditions.map((rendition) => {
    const target = renamed.get(rendition.carrierKey);
    const carriedSource = anchorSourceByIdentity.get(
      renditionIdentity(rendition),
    );
    const anchorSource =
      carriedSource === undefined || carriedSource === null
        ? rendition.anchorSource
        : carriedSource;
    const next = {
      ...rendition,
      ...(target === undefined
        ? {}
        : { carrierKey: target.assetKey, carrierVersion: target.version }),
      ...(anchorSource === rendition.anchorSource ? {} : { anchorSource }),
    } as unknown as Rendition;
    return next;
  });
  const renditionsChanged = nextRenditions.some(
    (rendition, index) => rendition !== built.content.renditions[index],
  );

  if (renamed.size === 0) {
    if (!renditionsChanged) return built;
    return {
      ...built,
      content: { ...built.content, renditions: nextRenditions },
    };
  }

  // 机械重命名必须写回工作表：manifest.resources[].id 与 rendition.carrierKey
  // 已改用携带的 assetKey，模板 Media/Exhibits 不写回就会与清单不一致。
  workbook.Sheets.Media = XLSX.utils.aoa_to_sheet(mediaRows);
  if (exhibitSheet !== undefined) {
    for (let index = 1; index < exhibitRows.length; index += 1) {
      const row = exhibitRows[index];
      const assetKey = row[3];
      if (typeof assetKey !== 'string' || assetKey === '') continue;
      const target = renamed.get(assetKey);
      if (target !== undefined) row[3] = target.assetKey;
    }
    workbook.Sheets.Exhibits = XLSX.utils.aoa_to_sheet(exhibitRows);
  }

  const nextTemplate = XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
  }) as Buffer;

  const nextMedia = built.media.map((entry) => {
    const target = renamed.get(entry.assetKey);
    const thumbnailTarget =
      entry.thumbnailOf === null ? undefined : renamed.get(entry.thumbnailOf);
    if (target === undefined && thumbnailTarget === undefined) return entry;
    return {
      ...entry,
      ...(target === undefined ? {} : { assetKey: target.assetKey }),
      ...(thumbnailTarget === undefined
        ? {}
        : { thumbnailOf: thumbnailTarget.assetKey }),
    };
  });

  const versionByAssetKey = new Map(
    [...renamed.entries()].map(([, to]) => [to.assetKey, to.version]),
  );
  type PinAssetKey = (typeof built.content.assetPins)[number]['assetKey'];
  const nextPins = built.content.assetPins
    .map((pin) => {
      const target = renamed.get(pin.assetKey);
      const assetKey = (target?.assetKey ?? pin.assetKey) as PinAssetKey;
      return {
        assetKey,
        assetVersion: versionByAssetKey.get(assetKey) ?? pin.assetVersion,
      };
    })
    .sort((left, right) =>
      left.assetKey < right.assetKey
        ? -1
        : left.assetKey > right.assetKey
          ? 1
          : 0,
    );

  return {
    media: nextMedia,
    templateBytes: nextTemplate,
    content: {
      ...built.content,
      renditions: nextRenditions,
      assetPins: nextPins,
    },
  };
}

/**
 * Pc rendition → 章节秒值覆盖（contentKey × language → lpCode → startMs）。
 * 只收视频 LP rendition（occurrenceKey = `lp.<code>`），以导出内容的当前坐标
 * 为准；标题仍由 legacy 学习点提供（Pc 不存标题）。
 */
function buildPcTimingOverride(
  renditions: readonly Rendition[],
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const rendition of renditions) {
    if (rendition.modality !== 'video') continue;
    if (!rendition.occurrenceKey.startsWith('lp.')) continue;
    if (rendition.startMs === undefined) continue;
    const code = rendition.occurrenceKey.slice(3);
    const key = `${rendition.contentKey}\u0000${rendition.language}`;
    const byCode = out.get(key) ?? new Map<string, number>();
    byCode.set(code, rendition.startMs);
    out.set(key, byCode);
  }
  return out;
}

/**
 * 从 Pc 真源替换包内媒体字节并补齐机器时间源文件（C7/C10.4）。
 *
 * - 同 assetKey 的 Video/文档/展品/缩略图用 Pc 原文件（DOCX 必须原样，重建会
 *   丢 Heading/文本锚点）。
 * - 只在 Pc 侧存在的字幕（输入源）随包携带；否则跨环境导入只能按点锚点重新
 *   猜时间，无法保持 verified 对齐的坐标。
 * - chapters 不携带：它是由当前 rendition 坐标重新生成的导出产物，不是输入源。
 *   用目标环境上一次导入残留的旧章节字节覆盖会把旧视频的时间带回包内
 *   （换 assetVersion 后的 P8/Re-confirm 会被静默绕过）。
 */
function applyCarriedAssets(
  built: BuiltPackage,
  assets: readonly CarriedAsset[],
): BuiltPackage {
  const byKeyVersion = new Map(
    assets.map((asset) => [`${asset.assetKey}@${asset.assetVersion}`, asset]),
  );
  const latestByKey = new Map<string, CarriedAsset>();
  for (const asset of assets) {
    const current = latestByKey.get(asset.assetKey);
    if (current === undefined || asset.assetVersion > current.assetVersion) {
      latestByKey.set(asset.assetKey, asset);
    }
  }
  const pinVersion = new Map<string, number>(
    built.content.assetPins.map((pin) => [pin.assetKey, pin.assetVersion]),
  );
  const pick = (assetKey: string): CarriedAsset | undefined => {
    const pinned = pinVersion.get(assetKey);
    if (pinned !== undefined) {
      const exact = byKeyVersion.get(`${assetKey}@${pinned}`);
      if (exact !== undefined) return exact;
    }
    return latestByKey.get(assetKey);
  };

  const workbook = XLSX.read(built.templateBytes, { type: 'buffer' });
  const lessonsSheet = workbook.Sheets.Lessons;
  const lessonCodes =
    lessonsSheet === undefined
      ? []
      : XLSX.utils
          .sheet_to_json<unknown[]>(lessonsSheet, {
            header: 1,
            defval: null,
            raw: true,
          })
          .slice(1)
          .map((row) => (typeof row[0] === 'string' ? row[0] : ''))
          .filter((code) => code !== '');
  const videoLessonsByLanguage = new Map<string, string[]>();
  for (const entry of built.media) {
    if (
      entry.kind === 'video' &&
      entry.lessonCode !== null &&
      entry.language !== null
    ) {
      const list = videoLessonsByLanguage.get(entry.language) ?? [];
      if (!list.includes(entry.lessonCode)) list.push(entry.lessonCode);
      videoLessonsByLanguage.set(entry.language, list);
    }
  }
  const lessonFor = (
    assetKey: string,
    language: string | null,
  ): string | null => {
    const tokens = assetKey
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const byToken = lessonCodes.find((code) =>
      tokens.includes(code.toLowerCase()),
    );
    if (byToken !== undefined) return byToken;
    // 自定义 assetKey（如 `<courseKey>-subtitle`）不含 lesson token：当该语言
    // 只有唯一视频课时时可无歧义绑定；多课时不做猜测（宁缺不误绑）。
    const candidates =
      language === null ? [] : (videoLessonsByLanguage.get(language) ?? []);
    return candidates.length === 1 ? candidates[0] : null;
  };

  const usedPaths = new Set(built.media.map((entry) => entry.relativePath));
  const uniquePath = (path: string): string => {
    if (!usedPaths.has(path)) {
      usedPaths.add(path);
      return path;
    }
    const slash = path.lastIndexOf('/');
    const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
    const file = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = file.lastIndexOf('.');
    const stem = dot > 0 ? file.slice(0, dot) : file;
    const ext = dot > 0 ? file.slice(dot) : '';
    let index = 2;
    let candidate = `${dir}${stem}-${index}${ext}`;
    while (usedPaths.has(candidate)) {
      index += 1;
      candidate = `${dir}${stem}-${index}${ext}`;
    }
    usedPaths.add(candidate);
    return candidate;
  };

  const media: MediaRegistration[] = built.media.map((entry) => {
    // C7/C10.4：chapters 是「按当前 rendition 坐标导出的机器时间源」，不是
    // 输入源。跨环境携带只搬运真实输入产物（视频/DOCX/字幕/图片等）；
    // 若用目标环境上一次导入残留的 chapters 字节覆盖本次重新生成的章节文件，
    // 换视频（新 assetVersion）后旧时间会被带回包内（P8/Re-confirm 失效）。
    if (entry.kind === 'chapters') return entry;
    const source = pick(entry.assetKey);
    if (source === undefined || source.kind !== entry.kind) return entry;
    return { ...entry, bytes: source.bytes };
  });

  const addedKeys = new Set(media.map((entry) => entry.assetKey));
  const pins: Array<{ assetKey: string; assetVersion: number }> = [
    ...built.content.assetPins,
  ];
  const extraAssets = [...assets]
    .filter((asset) => asset.kind === 'subtitle')
    .sort((left, right) =>
      left.assetKey < right.assetKey
        ? -1
        : left.assetKey > right.assetKey
          ? 1
          : left.assetVersion - right.assetVersion,
    );
  for (const asset of extraAssets) {
    if (addedKeys.has(asset.assetKey)) continue;
    // 只带最新版本（同一 assetKey 的旧版本不重复成行）。
    if (latestByKey.get(asset.assetKey) !== asset) continue;
    addedKeys.add(asset.assetKey);
    const lessonCode = lessonFor(asset.assetKey, asset.language);
    const language = asset.language;
    if (language === null || lessonCode === null) continue;
    if (!pins.some((pin) => pin.assetKey === asset.assetKey)) {
      pins.push({
        assetKey: asset.assetKey,
        assetVersion: asset.assetVersion,
      });
    }
    const folder = 'subtitles';
    const base = lessonCode ?? 'shared';
    const relativePath = uniquePath(
      `${folder}/${base}.${language}.${asset.extension}`,
    );
    media.push({
      assetKey: asset.assetKey,
      kind: asset.kind,
      lessonCode,
      language,
      relativePath,
      thumbnailOf: null,
      bytes: asset.bytes,
      resourceKind: asset.kind,
    });
  }

  const mediaRows: unknown[][] = [
    [...HEADERS.Media],
    ...media.map((entry) => [
      entry.assetKey,
      entry.kind,
      entry.lessonCode,
      entry.language,
      entry.relativePath,
      entry.thumbnailOf,
    ]),
  ];
  workbook.Sheets.Media = XLSX.utils.aoa_to_sheet(mediaRows);
  const templateBytes = XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
  }) as Buffer;

  return {
    media,
    templateBytes,
    content: {
      ...built.content,
      assetPins: pins.sort((left, right) =>
        left.assetKey < right.assetKey
          ? -1
          : left.assetKey > right.assetKey
            ? 1
            : 0,
      ) as ContentVersionContent['assetPins'],
    },
  };
}

function sortByRenditionKey(renditions: readonly Rendition[]): Rendition[] {
  return [...renditions].sort((left, right) =>
    left.renditionKey < right.renditionKey
      ? -1
      : left.renditionKey > right.renditionKey
        ? 1
        : 0,
  );
}

/** 把 Pc rendition 的载体身份并入 assetPins（Pc 版本优先于 legacy 合成版本）。 */
function mergeAssetPins(
  pins: ContentVersionContent['assetPins'],
  renditions: readonly Rendition[],
): ContentVersionContent['assetPins'] {
  const merged = new Map<string, number>();
  for (const pin of pins) merged.set(pin.assetKey, pin.assetVersion);
  for (const rendition of renditions) {
    merged.set(rendition.carrierKey, rendition.carrierVersion);
  }
  return [...merged.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([assetKey, assetVersion]) => ({
      assetKey,
      assetVersion,
    })) as unknown as ContentVersionContent['assetPins'];
}

/**
 * 把 legacy 聚合课程（draft 或版本快照）装配成 Part C v2 包。
 * 调用方提供媒体字节（path → bytes）。
 */
export async function assemblePartcPackage(
  course: PackageCourse,
  media: ReadonlyMap<string, Buffer>,
  options: PartcExportOptions,
): Promise<PartcPackageArtifacts> {
  let built = await buildPackageContents(
    course,
    media,
    options.identity,
    options.alignments ?? [],
    {
      ...(options.stages === undefined ? {} : { stages: options.stages }),
      ...(options.evidenceSpecs === undefined
        ? {}
        : { evidenceSpecs: options.evidenceSpecs }),
      ...(options.prerequisiteEdges === undefined
        ? {}
        : { prerequisiteEdges: options.prerequisiteEdges }),
      // 章节源以 Pc 真源为准（导出的“机器章节”必须反映当前 rendition 坐标，
      // 不能沿用 legacy 工作区里上一次导入的旧秒值）。
      ...(options.pcRenditions === undefined
        ? {}
        : {
            timingByLessonLanguage: buildPcTimingOverride(options.pcRenditions),
          }),
    },
  );
  if (options.carriedMedia !== undefined && options.carriedMedia.length > 0) {
    built = applyCarriedMedia(built, options.carriedMedia);
  }
  if (options.carriedAssets !== undefined && options.carriedAssets.length > 0) {
    // 用 Pc 真源字节替换同 assetKey 的 Media 文件（原始 DOCX 保留 Heading），
    // 并补齐字幕/章节等只在 Pc 侧存在的机器时间源文件。
    built = applyCarriedAssets(built, options.carriedAssets);
  }
  // A/C：导出以 Pc 真源 rendition 记录为准（稳定 renditionKey + carrierKey
  // + carrierVersion + revision + 坐标 + anchorSource）。legacy 聚合只提供
  // 叙事内容（标题/阅读/题目），不再决定内容身份。
  // 闭合包：只写载体确实随包交付（Media 行存在）的 rendition；否则 import
  // 侧会因 assetPins 引用未交付资产而整包拒绝。
  const deliveredCarrierKeys = new Set(
    built.media.map((entry) => entry.assetKey),
  );
  const deliveredPcRenditions = sortByRenditionKey(
    (options.pcRenditions ?? []).filter((rendition) =>
      deliveredCarrierKeys.has(rendition.carrierKey),
    ),
  );
  if (deliveredPcRenditions.length > 0) {
    const pinned = mergeAssetPins(
      built.content.assetPins,
      deliveredPcRenditions,
    );
    built = {
      ...built,
      content: {
        ...built.content,
        renditions: deliveredPcRenditions,
        assetPins: pinned,
        alignments: exportableAlignments(
          options.alignments ?? [],
          built.content.stages,
          deliveredPcRenditions,
          built.content.specPins,
        ),
      },
    };
  } else {
    // 旧课程（无 Pc 数据）：按业务身份把 Pc 对齐映射到导出合成键。
    const exportAlignments = remapAlignmentsToExportRenditions(
      options.alignments ?? [],
      built.content.renditions,
      options.carriedMedia ?? [],
    );
    built = {
      ...built,
      content: {
        ...built.content,
        alignments: exportableAlignments(
          exportAlignments,
          built.content.stages,
          built.content.renditions,
          built.content.specPins,
        ),
      },
    };
  }
  const templatePath = 'template.xlsx';
  const resources = [
    {
      id: 'template',
      kind: 'template' as const,
      path: templatePath,
      size: built.templateBytes.length,
    },
    ...built.media.map((entry) => ({
      id: entry.assetKey,
      kind: entry.resourceKind,
      path: entry.relativePath,
      size: entry.bytes.length,
    })),
  ];

  const manifest = PackageManifestV2Schema.parse({
    format: PACKAGE_FORMAT_TAG,
    formatVersion: PACKAGE_FORMAT_VERSION,
    packageId: `pkg_${options.identity.courseKey}_${options.identity.versionNo}`,
    exportedAt: options.exportedAt,
    minReaderVersion: PACKAGE_FORMAT_VERSION,
    extensionsUsed: [],
    extensionsRequired: [],
    course: {
      courseKey: options.identity.courseKey,
      titleLocalized: options.identity.titleLocalized,
      categoryPath: options.identity.categoryPath,
      learningLanguages: options.identity.learningLanguages,
      studyMode: options.identity.studyMode,
    },
    content: built.content,
    resources,
    provenance: options.provenance,
    annotations: options.annotations,
  });

  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file(templatePath, built.templateBytes);
  for (const entry of built.media) {
    zip.file(entry.relativePath, entry.bytes);
  }
  return {
    bytes: await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    }),
    manifest,
  };
}

async function buildPackageContents(
  course: PackageCourse,
  media: ReadonlyMap<string, Buffer>,
  identity: PartcExportIdentity,
  partcAlignments: readonly Alignment[],
  sourceStructure: {
    stages?: readonly Stage[];
    evidenceSpecs?: readonly ContentVersionContent['evidenceSpecs'][number][];
    prerequisiteEdges?: readonly PrerequisiteEdge[];
    timingByLessonLanguage?: ReadonlyMap<string, ReadonlyMap<string, number>>;
  } = {},
): Promise<BuiltPackage> {
  const courseKey = identity.courseKey;
  const defaultLanguage =
    identity.learningLanguages[0] ?? course.defaultContentLanguage;
  const registrations: MediaRegistration[] = [];
  const courseInfoRows: unknown[][] = [];
  const lessonRows: unknown[][] = [];
  const lpRows: unknown[][] = [];
  const exhibitRows: unknown[][] = [];
  const readingRows: unknown[][] = [];
  const knowledgeRows: unknown[][] = [];
  const applicationRows: unknown[][] = [];
  const usedAssetKeys = new Set<string>();
  const uniqueAssetKey = (candidate: string): string => {
    let key = candidate;
    let index = 2;
    while (usedAssetKeys.has(key)) {
      key = `${candidate}-${index}`;
      index += 1;
    }
    usedAssetKeys.add(key);
    return key;
  };
  const bytesOf = (path: string | undefined): Buffer | null => {
    if (!path) return null;
    return media.get(path) ?? null;
  };
  // 包内路径必须全局唯一（闭合包 resources[].path 唯一）：旧模型里不同课时的
  // 展品 code 可重复，导出时确定性追加序号（不改内容、不含哈希）。
  const usedPaths = new Set<string>();
  const uniquePath = (path: string): string => {
    if (!usedPaths.has(path)) {
      usedPaths.add(path);
      return path;
    }
    const slash = path.lastIndexOf('/');
    const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
    const file = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = file.lastIndexOf('.');
    const stem = dot > 0 ? file.slice(0, dot) : file;
    const extension = dot > 0 ? file.slice(dot) : '';
    let index = 2;
    let candidate = `${dir}${stem}-${index}${extension}`;
    while (usedPaths.has(candidate)) {
      index += 1;
      candidate = `${dir}${stem}-${index}${extension}`;
    }
    usedPaths.add(candidate);
    return candidate;
  };
  const register = (
    assetKey: string,
    resourceKind: string,
    path: string,
    bytes: Buffer,
    lessonCode: string | null,
    language: string | null,
    thumbnailOf: string | null,
  ): void => {
    registrations.push({
      assetKey,
      kind: resourceKind,
      lessonCode,
      language,
      relativePath: uniquePath(path),
      thumbnailOf,
      bytes,
      // Media sheet 的 lesson-text 行对应 manifest 的 document 资源（契约 1:1 映射）。
      resourceKind: resourceKind === 'lesson-text' ? 'document' : resourceKind,
    });
  };

  // 课程封面
  const coverBytes = bytesOf(course.cover);
  if (course.cover && coverBytes) {
    register(
      uniqueAssetKey('cover'),
      'cover',
      course.cover,
      coverBytes,
      null,
      null,
      null,
    );
  }

  // Course Info
  for (const language of identity.learningLanguages) {
    const loc = course.localized[language];
    if (!loc) continue;
    if (loc.title) courseInfoRows.push(['title', language, loc.title]);
    if (loc.shortDescription)
      courseInfoRows.push(['shortDescription', language, loc.shortDescription]);
    if (loc.overview) courseInfoRows.push(['overview', language, loc.overview]);
    for (const item of loc.whatYouLearn ?? []) {
      if (typeof item === 'string' && item.trim() !== '') {
        courseInfoRows.push(['whatYouLearn', language, item]);
      }
    }
    for (const item of loc.provides ?? []) {
      const text = textOfProvide(item);
      if (text !== null) courseInfoRows.push(['provides', language, text]);
    }
  }

  const stages: Stage[] = [];
  const evidenceSpecs: ContentVersionContent['evidenceSpecs'] = [];
  const specPins: Array<{ contentKey: string; version: number }> = [];
  const renditions: Rendition[] = [];
  const assetPins = new Map<string, number>();

  const rootStageKey = stableToken(`program-${courseKey}`, 'program');
  const lessons = [...(course.lessons ?? [])].sort(
    (left, right) => left.order - right.order,
  );
  if (lessons.length > 0) {
    stages.push({
      courseKey,
      stageKey: rootStageKey,
      parentStageKey: null,
      orderKey: '000001',
      kind: 'program',
      goal: course.localized[defaultLanguage]?.title ?? course.code,
      objectiveKeys: [],
      exitEvidence: [],
      exitRollup: { kind: 'all' },
      status: 'active',
    } as unknown as Stage);
  } else {
    // 空课程（无课时）：仍须产出可通过 STR-1 的闭合阶段树。这里用一个课程级
    // 交付叶表达"完成课程"这一机械目标，不虚构任何教学内容。
    const objectiveKey = stableToken(`obj-${courseKey}`, 'obj-course');
    const evidenceKey = stableToken(`ev-${courseKey}`, 'ev-course');
    stages.push({
      courseKey,
      stageKey: stableToken(`step-${courseKey}`, 'step-course'),
      parentStageKey: null,
      orderKey: '000001',
      kind: 'step',
      goal: course.localized[defaultLanguage]?.title ?? course.code,
      objectiveKeys: [objectiveKey],
      exitEvidence: [evidenceKey],
      exitRollup: { kind: 'all' },
      status: 'active',
    } as unknown as Stage);
    evidenceSpecs.push({
      evidenceKey,
      version: 1,
      kind: 'artifact',
      objectiveKeys: [objectiveKey],
      measure: {
        kind: 'artifact',
        instructions: 'Complete the course.',
      },
      scoring: 'pass-fail',
      threshold: 1,
      attempts: 1,
    } as unknown as ContentVersionContent['evidenceSpecs'][number]);
  }
  for (const [lessonIndex, lesson] of lessons.entries()) {
    await writeLesson(
      lesson,
      lessonIndex,
      course,
      defaultLanguage,
      {
        stages,
        rootStageKey,
        courseKey,
        lessonRows,
        lpRows,
        exhibitRows,
        readingRows,
        knowledgeRows,
        applicationRows,
        renditions,
        assetPins,
        specPins,
        evidenceSpecs,
        ...(sourceStructure.timingByLessonLanguage === undefined
          ? {}
          : { timingByLessonLanguage: sourceStructure.timingByLessonLanguage }),
      },
      { register, bytesOf, uniqueAssetKey },
    );
  }

  // 阅读/知识题/应用题的内容 key 只在课时有对应行时 pin。
  const lessonCodes = new Set(
    lessons.map((lesson) => stableToken(lesson.code, 'lesson')),
  );
  for (const pin of [...specPins]) {
    if (
      !lessonCodes.has(pin.contentKey) &&
      !/\.(reading|knowledge-test|application-test)$/.test(pin.contentKey)
    ) {
      throw new Error(
        `spec pin ${pin.contentKey} is not derived from the package payload`,
      );
    }
  }

  // 模板工作簿
  const workbook = XLSX.utils.book_new();
  const append = (name: SheetName, rows: unknown[][]): void => {
    const sheet = XLSX.utils.aoa_to_sheet([HEADERS[name], ...rows]);
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  };
  append('Meta', [
    [
      TEMPLATE_VERSION,
      courseKey,
      identity.learningLanguages.join(','),
      identity.studyMode,
    ],
  ]);
  append(
    'Media',
    registrations.map((entry) => [
      entry.assetKey,
      entry.kind,
      entry.lessonCode,
      entry.language,
      entry.relativePath,
      entry.thumbnailOf,
    ]),
  );
  append('Course Info', courseInfoRows);
  append('Lessons', lessonRows);
  append('Learning Points', lpRows);
  append('Exhibits', exhibitRows);
  append('Reading List', readingRows);
  append('Knowledge Test', knowledgeRows);
  append('Application Test', applicationRows);
  const templateBytes = XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
  }) as Buffer;

  // renditionKey 稳定且包内唯一：超长稳定键在同一个包内按确定性序号消重
  // （不使用任何摘要；顺序来自稳定排序的课时/语言/学习点）。
  const dedupedRenditions: Rendition[] = [];
  const seenRenditionKeys = new Set<string>();
  for (const rendition of renditions) {
    let renditionKey = rendition.renditionKey;
    let suffix = 2;
    while (seenRenditionKeys.has(renditionKey)) {
      renditionKey = `${rendition.renditionKey.slice(0, 120)}-${suffix}`;
      suffix += 1;
    }
    seenRenditionKeys.add(renditionKey);
    dedupedRenditions.push(
      renditionKey === rendition.renditionKey
        ? rendition
        : { ...rendition, renditionKey },
    );
  }

  // C3 assetPins：导出包内每个 Media 行都必须有显式版本（不猜版本）。
  // 注册时已按语义写入的 pin 保留；其余（封面/章节/文档/展品缩略图）补 1。
  for (const entry of registrations) {
    if (!assetPins.has(entry.assetKey)) assetPins.set(entry.assetKey, 1);
  }

  // C10.4：导入课程的 Pc 真源阶段/证据规格优先（稳定 stageKey 跨环境不变）。
  // 只有结构自洽（每个 exitEvidence 都能解析到证据规格）时才采用；否则回退到
  // 机械合成结构，避免导出带悬空证据引用（旧课程/不完整 Pc 数据）。
  const overrideStages =
    sourceStructure.stages !== undefined && sourceStructure.stages.length > 0
      ? sourceStructure.stages
      : undefined;
  const overrideEvidenceSpecs =
    sourceStructure.evidenceSpecs !== undefined &&
    sourceStructure.evidenceSpecs.length > 0
      ? sourceStructure.evidenceSpecs
      : undefined;
  const overrideReady =
    overrideStages !== undefined &&
    overrideEvidenceSpecs !== undefined &&
    (() => {
      const keys = new Set(
        overrideEvidenceSpecs.map((spec) => spec.evidenceKey),
      );
      return overrideStages.every((stage) =>
        (stage.exitEvidence ?? []).every((key) => keys.has(key)),
      );
    })();
  const effectiveStages = overrideReady ? [...overrideStages] : stages;
  const effectiveEvidenceSpecs = overrideReady
    ? [...overrideEvidenceSpecs]
    : evidenceSpecs;

  const content: ContentVersionContent = {
    courseKey,
    versionNo: Math.max(1, Math.trunc(identity.versionNo)),
    categoryPath: identity.categoryPath,
    stages: effectiveStages,
    prerequisiteEdges: overrideReady
      ? [...(sourceStructure.prerequisiteEdges ?? [])]
      : [],
    specPins,
    renditions: dedupedRenditions,
    alignments: exportableAlignments(
      partcAlignments,
      effectiveStages,
      dedupedRenditions,
      specPins,
    ),
    evidenceSpecs: effectiveEvidenceSpecs,
    assetPins: [...assetPins.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([assetKey, assetVersion]) => ({ assetKey, assetVersion })),
  } as unknown as ContentVersionContent;

  return { media: registrations, templateBytes, content };
}

/**
 * 从 Pc 真源挑选可随包导出的 verified 对齐（C3/C10.4 审计元组原样保留）。
 *
 * 只写本包能表达的记录：stage 与 rendition 都在包内、objective 属于该 stage、
 * verifiedAgainst 与导出的 rendition revision/carrierVersion 与 spec pin 一致，
 * 且 (stageKey, renditionKey) 唯一。其余（工作区里已不存在或已换版）不写包，
 * 由 Pc 真源继续承载；绝不伪造坐标或审计元组。
 */
function renditionBusinessIdentity(rendition: {
  contentKey: string;
  blockId: string;
  language: string;
  modality: string;
  carrierType: string;
  carrierKey: string;
  occurrenceKey: string;
}): string {
  return [
    rendition.contentKey,
    rendition.blockId,
    rendition.language,
    rendition.modality,
    rendition.carrierType,
    rendition.carrierKey,
    rendition.occurrenceKey,
  ].join('\u0000');
}

/**
 * 把 Pc 真源的 verified 对齐映射到导出包的 renditionKey。
 *
 * Pc renditionKey = `r.<contentKey>.<blockId>.<language>.<modality>.
 * <carrierType>.<carrierKey>.<occurrenceKey>`（carrierKey 为 Pc 资产键）。
 * carriedMedia 提供同一业务身份与 Pc 资产键，因此可以先定位 Pc rendition，
 * 再按业务身份找到导出 rendition。verifiedAgainst 的 renditionRevision /
 * carrierVersion 取导出 rendition（环境本地值），specVersion 原样保留。
 */
function remapAlignmentsToExportRenditions(
  alignments: readonly Alignment[],
  renditions: readonly Rendition[],
  carried: readonly CarriedMediaAsset[],
): Alignment[] {
  const byBusinessIdentity = new Map(
    renditions.map((rendition) => [
      renditionBusinessIdentity(rendition),
      rendition,
    ]),
  );
  const carriedByKey = new Map(
    carried.map((asset) => [
      [
        'r',
        asset.contentKey,
        asset.blockId,
        asset.language,
        asset.modality,
        asset.carrierType,
        asset.carrierKey,
        asset.occurrenceKey,
      ].join('.'),
      asset,
    ]),
  );
  const out: Alignment[] = [];
  for (const alignment of alignments) {
    const asset = carriedByKey.get(alignment.renditionKey);
    if (asset === undefined) continue;
    const rendition = byBusinessIdentity.get(renditionBusinessIdentity(asset));
    if (rendition === undefined) continue;
    // C10.4：审计元组（含 verifiedAgainst）原样携带，绝不按导出端本地值重写；
    // 与导出 rendition revision/carrierVersion 不一致的条目由
    // exportableAlignments 过滤（stale 不进包）。
    out.push({
      ...alignment,
      renditionKey: rendition.renditionKey,
    });
  }
  return out;
}

function exportableAlignments(
  alignments: readonly Alignment[],
  stages: readonly Stage[],
  renditions: readonly Rendition[],
  specPins: ReadonlyArray<{ contentKey: string; version: number }>,
): Alignment[] {
  const stageByKey = new Map(stages.map((stage) => [stage.stageKey, stage]));
  const renditionByKey = new Map(
    renditions.map((rendition) => [rendition.renditionKey, rendition]),
  );
  const pinByContentKey = new Map(
    specPins.map((pin) => [pin.contentKey, pin.version]),
  );
  const seenPairs = new Set<string>();
  const out: Alignment[] = [];
  const sorted = [...alignments].sort((left, right) =>
    left.alignmentId < right.alignmentId
      ? -1
      : left.alignmentId > right.alignmentId
        ? 1
        : 0,
  );
  for (const alignment of sorted) {
    if (alignment.status !== 'verified') continue;
    const stage = stageByKey.get(alignment.stageKey);
    if (stage === undefined) continue;
    if (!stage.objectiveKeys.includes(alignment.objectiveKey)) continue;
    const rendition = renditionByKey.get(alignment.renditionKey);
    if (rendition === undefined) continue;
    if (alignment.verifiedAgainst !== undefined) {
      if (
        alignment.verifiedAgainst.renditionRevision !== rendition.revision ||
        alignment.verifiedAgainst.carrierVersion !== rendition.carrierVersion
      ) {
        continue;
      }
      const pin = pinByContentKey.get(rendition.contentKey);
      if (pin !== undefined && alignment.verifiedAgainst.specVersion !== pin) {
        continue;
      }
    }
    const pair = `${alignment.stageKey}\u0000${alignment.renditionKey}`;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    out.push(alignment);
  }
  return out;
}

interface LessonBuildContext {
  readonly stages: Stage[];
  readonly rootStageKey: string;
  readonly courseKey: string;
  readonly lessonRows: unknown[][];
  readonly lpRows: unknown[][];
  readonly exhibitRows: unknown[][];
  readonly readingRows: unknown[][];
  readonly knowledgeRows: unknown[][];
  readonly applicationRows: unknown[][];
  readonly renditions: Rendition[];
  readonly assetPins: Map<string, number>;
  readonly specPins: Array<{ contentKey: string; version: number }>;
  readonly evidenceSpecs: ContentVersionContent['evidenceSpecs'];
  readonly timingByLessonLanguage?: ReadonlyMap<
    string,
    ReadonlyMap<string, number>
  >;
}

interface LessonBuildHelpers {
  readonly register: (
    assetKey: string,
    resourceKind: string,
    path: string,
    bytes: Buffer,
    lessonCode: string | null,
    language: string | null,
    thumbnailOf: string | null,
  ) => void;
  readonly bytesOf: (path: string | undefined) => Buffer | null;
  readonly uniqueAssetKey: (candidate: string) => string;
}

async function writeLesson(
  lesson: PackageLesson,
  lessonIndex: number,
  course: PackageCourse,
  defaultLanguage: string,
  context: LessonBuildContext,
  helpers: LessonBuildHelpers,
): Promise<void> {
  const lessonCode = stableToken(lesson.code, `lesson-${lessonIndex + 1}`);
  const stepKey = stableToken(`step-${lessonCode}`, `step-${lessonIndex + 1}`);
  const objectiveKey = stableToken(
    `obj-${lessonCode}`,
    `obj-${lessonIndex + 1}`,
  );
  const evidenceKey = stableToken(`ev-${lessonCode}`, `ev-${lessonIndex + 1}`);
  const localizedEntries = Object.entries(lesson.localized ?? {});
  const title =
    localizedEntries.find(([language]) => language === defaultLanguage)?.[1]
      .title ??
    localizedEntries[0]?.[1]?.title ??
    lessonCode;

  context.stages.push({
    courseKey: context.courseKey,
    stageKey: stepKey,
    parentStageKey: context.rootStageKey,
    orderKey: `000001.${String(lessonIndex + 1).padStart(6, '0')}`,
    kind: 'step',
    goal: title,
    objectiveKeys: [objectiveKey],
    exitEvidence: [evidenceKey],
    exitRollup: { kind: 'all' },
    status: 'active',
  } as unknown as Stage);
  context.evidenceSpecs.push({
    evidenceKey,
    version: 1,
    kind: 'artifact',
    objectiveKeys: [objectiveKey],
    measure: {
      kind: 'artifact',
      instructions: `Complete the lesson ${title}.`,
    },
    scoring: 'pass-fail',
    threshold: 1,
    attempts: 1,
  } as unknown as ContentVersionContent['evidenceSpecs'][number]);

  const mainContentKey = lessonCode;
  context.specPins.push({ contentKey: mainContentKey, version: 1 });

  // 展品媒体与触发所依赖的媒体：先按课时注册一次（语言无关，避免重复文件）。
  const exhibitAssets = new Map<
    string,
    { assetKey: string | null; mediaType: string; thumbKey: string | null }
  >();
  for (const exhibit of lesson.exhibits ?? []) {
    const mediaType = exhibitMediaType(exhibit);
    const exhibitCode = stableToken(exhibit.code, 'exhibit');
    let assetKey: string | null = null;
    const fileBytes = helpers.bytesOf(exhibit.file);
    if (exhibit.file && fileBytes) {
      assetKey = helpers.uniqueAssetKey(`exhibit-${exhibitCode}`);
      helpers.register(
        assetKey,
        exhibitResourceKind(mediaType),
        exhibit.file,
        fileBytes,
        lessonCode,
        null,
        null,
      );
      context.assetPins.set(assetKey, 1);
    }
    let thumbKey: string | null = null;
    const thumbBytes = helpers.bytesOf(exhibit.thumbnail);
    if (exhibit.thumbnail && thumbBytes) {
      thumbKey = helpers.uniqueAssetKey(`exhibit-${exhibitCode}-thumb`);
      helpers.register(
        thumbKey,
        'thumbnail',
        exhibit.thumbnail,
        thumbBytes,
        lessonCode,
        null,
        assetKey,
      );
      context.assetPins.set(thumbKey, 1);
    }
    exhibitAssets.set(exhibitCode, { assetKey, mediaType, thumbKey });

    for (const [variantLanguage, variant] of Object.entries(
      exhibit.localized ?? {},
    )) {
      context.exhibitRows.push([
        lessonCode,
        exhibitCode,
        mediaType,
        assetKey,
        variantLanguage,
        variant.title,
        variant.description ?? null,
        exhibit.source ?? null,
      ]);
      if (assetKey !== null && mediaType !== 'text') {
        context.renditions.push({
          renditionKey: renditionKeyOf(
            mainContentKey,
            exhibitCode,
            variantLanguage,
            mediaType === 'video' ? 'video' : mediaType,
            'asset',
            assetKey,
            'main',
          ),
          contentKey: mainContentKey,
          blockId: exhibitCode,
          language: variantLanguage,
          modality:
            mediaType === 'video'
              ? 'video'
              : mediaType === 'model3d'
                ? 'model3d'
                : 'image',
          occurrenceKey: 'main',
          carrierType: 'asset',
          carrierKey: assetKey,
          carrierVersion: 1,
          anchorSource: 'import-legacy',
          revision: 1,
        } as unknown as Rendition);
      }
    }
  }

  for (const [language, loc] of localizedEntries) {
    context.lessonRows.push([
      lessonCode,
      lessonIndex + 1,
      language,
      loc.title,
      loc.description ?? null,
    ]);

    const videoBytes = helpers.bytesOf(loc.video?.file);
    let videoAssetKey: string | null = null;
    let videoDurationMs: number | null = null;
    if (loc.video?.file && videoBytes) {
      videoAssetKey = helpers.uniqueAssetKey(`video-${lessonCode}-${language}`);
      helpers.register(
        videoAssetKey,
        'video',
        loc.video.file,
        videoBytes,
        lessonCode,
        language,
        null,
      );
      context.assetPins.set(videoAssetKey, 1);
      videoDurationMs =
        loc.video.durationSeconds !== undefined
          ? Math.round(loc.video.durationSeconds * 1000)
          : null;
    }

    const videoPoints = (loc.video?.learningPoints ?? []).map((point) => ({
      code: point.code,
      title: point.title,
      timeSeconds: point.timeSeconds,
    }));
    if (videoAssetKey !== null) {
      // 机器章节源：优先 Pc 真源的当前 rendition 起点（秒级取整，供章节机器源
      // 与黑盒断言），否则才回退 legacy 学习点秒值；无源不生成 cue（不写 0）。
      const pcStarts = context.timingByLessonLanguage?.get(
        `${mainContentKey}\u0000${language}`,
      );
      const cues = [...videoPoints]
        .map((point) => {
          const fromPc = pcStarts?.get(point.code);
          const startMs =
            fromPc !== undefined
              ? Math.round(fromPc / 1000) * 1000
              : point.timeSeconds !== null && Number.isFinite(point.timeSeconds)
                ? Math.max(0, Math.round(point.timeSeconds * 1000))
                : undefined;
          return { code: point.code, title: point.title, startMs };
        })
        .filter(
          (cue): cue is { code: string; title: string; startMs: number } =>
            cue.startMs !== undefined,
        )
        .sort((left, right) =>
          left.startMs !== right.startMs
            ? left.startMs - right.startMs
            : left.code < right.code
              ? -1
              : 1,
        )
        .map((cue) => ({ startMs: cue.startMs, title: cue.title }))
        .filter(
          (cue, index, list) =>
            index === 0 || cue.startMs !== list[index - 1].startMs,
        );
      if (cues.length > 0) {
        const chapterPath = `chapters/${stableToken(lessonCode, 'lesson')}.${language}.json`;
        helpers.register(
          helpers.uniqueAssetKey(`chapters-${lessonCode}-${language}`),
          'chapters',
          chapterPath,
          Buffer.from(JSON.stringify(cues), 'utf8'),
          lessonCode,
          language,
          null,
        );
      }
      const expanded = expandVideoAnchors(videoPoints, videoDurationMs);
      for (const anchor of expanded) {
        context.renditions.push({
          renditionKey: renditionKeyOf(
            mainContentKey,
            'video',
            language,
            'video',
            'asset',
            videoAssetKey,
            `lp.${stableToken(anchor.code, 'lp')}`,
          ),
          contentKey: mainContentKey,
          blockId: 'video',
          language,
          modality: 'video',
          occurrenceKey: `lp.${stableToken(anchor.code, 'lp')}`,
          carrierType: 'asset',
          carrierKey: videoAssetKey,
          carrierVersion: 1,
          startMs: anchor.startMs,
          endMs: anchor.endMs,
          anchorSource: 'import-legacy',
          revision: 1,
        } as unknown as Rendition);
      }
      // 触发点：legacy 触发秒值 → 占位 rendition（触发真实坐标由导入端按
      // 字幕/章节/文档标记重新派生；这里只保留稳定引用关系供重绑）。
      const triggerPoints = (loc.video?.exhibitTriggers ?? [])
        .filter((trigger) => {
          const asset = exhibitAssets.get(
            stableToken(trigger.exhibitRef, 'exhibit'),
          );
          return asset !== undefined && asset.assetKey !== null;
        })
        .map((trigger) => ({
          exhibitCode: stableToken(trigger.exhibitRef, 'exhibit'),
          timeSeconds: trigger.timeSeconds,
        }));
      const expandedTriggers = expandVideoAnchors(
        triggerPoints.map((trigger) => ({
          code: trigger.exhibitCode,
          timeSeconds: trigger.timeSeconds,
        })),
        videoDurationMs,
      );
      for (const anchor of expandedTriggers) {
        // 真值键 (lesson, exhibit, language, timeMs)：同一展品的多个时间点是
        // 不同内容事实（T3-3）。occurrenceKey 必须含时间，否则三条触发会得到
        // 相同 renditionKey 并被包内去重折叠成一条。
        const occurrenceKey = stableToken(
          `trigger-${anchor.code}-${anchor.startMs}`,
          'trigger',
        );
        context.renditions.push({
          renditionKey: renditionKeyOf(
            mainContentKey,
            anchor.code,
            language,
            'video',
            'asset',
            videoAssetKey,
            occurrenceKey,
          ),
          contentKey: mainContentKey,
          blockId: anchor.code,
          language,
          modality: 'video',
          occurrenceKey,
          carrierType: 'asset',
          carrierKey: videoAssetKey,
          carrierVersion: 1,
          startMs: anchor.startMs,
          endMs: anchor.endMs,
          anchorSource: 'import-legacy',
          revision: 1,
        } as unknown as Rendition);
      }
    }
    for (const point of videoPoints) {
      context.lpRows.push([
        lessonCode,
        stableToken(point.code, 'lp'),
        language,
        point.title,
      ]);
    }

    // 文本学习点（含文档锚点）
    const textPoints = loc.text?.learningPoints ?? [];
    for (const point of textPoints) {
      context.lpRows.push([
        lessonCode,
        stableToken(point.code, 'lp'),
        language,
        point.heading,
      ]);
    }
    if (loc.text?.html) {
      const docAssetKey = helpers.uniqueAssetKey(
        `doc-${lessonCode}-${language}`,
      );
      const docBytes = await buildDocxFromHtml(loc.text.html);
      helpers.register(
        docAssetKey,
        'lesson-text',
        `lessons/${stableToken(lessonCode, 'lesson')}.${language}.docx`,
        docBytes,
        lessonCode,
        language,
        null,
      );
      // 文本锚点 rendition 的载体是这份 DOCX：ContentVersion.assetPins 必须
      // 带版本，否则重导入时 align 以 CONTENT_INCOMPLETE 拒绝（不猜版本）。
      context.assetPins.set(docAssetKey, 1);
      context.renditions.push({
        renditionKey: renditionKeyOf(
          mainContentKey,
          'body',
          language,
          'text',
          'document',
          docAssetKey,
          'body',
        ),
        contentKey: mainContentKey,
        blockId: 'body',
        language,
        modality: 'text',
        occurrenceKey: 'body',
        carrierType: 'document',
        carrierKey: docAssetKey,
        carrierVersion: 1,
        anchorSource: 'doc-structure',
        revision: 1,
      } as unknown as Rendition);
      for (const point of textPoints) {
        context.renditions.push({
          renditionKey: renditionKeyOf(
            mainContentKey,
            'body',
            language,
            'text',
            'document',
            docAssetKey,
            `lp.${stableToken(point.code, 'lp')}`,
          ),
          contentKey: mainContentKey,
          blockId: 'body',
          language,
          modality: 'text',
          occurrenceKey: `lp.${stableToken(point.code, 'lp')}`,
          carrierType: 'document',
          carrierKey: docAssetKey,
          carrierVersion: 1,
          headingCode: stableToken(point.heading, 'heading'),
          anchorSource: 'doc-structure',
          revision: 1,
        } as unknown as Rendition);
      }
    }
  }

  // 推荐阅读：模板每行一个阅读项（无语言列），只导出默认语言行。
  const readingKey = `${lessonCode}.reading`;
  const defaultReadings = lesson.recommendedReading?.[defaultLanguage] ?? [];
  if (defaultReadings.length > 0) {
    context.specPins.push({ contentKey: readingKey, version: 1 });
    for (const reading of defaultReadings) {
      context.readingRows.push([
        lessonCode,
        reading.type.toLowerCase(),
        reading.title,
        reading.author ?? null,
        reading.why ?? null,
      ]);
    }
  }

  // 知识测试：legacy 单语行 → 默认语言（双语承载属 Part C 模型，不在旧数据里）。
  const questions = lesson.knowledgeTest?.questions ?? [];
  if (lesson.knowledgeTest?.enabled && questions.length > 0) {
    context.specPins.push({
      contentKey: `${lessonCode}.knowledge-test`,
      version: 1,
    });
    for (const [index, question] of questions.entries()) {
      context.knowledgeRows.push([
        lessonCode,
        index + 1,
        defaultLanguage,
        question.question,
        question.referenceAnswer ?? '(not provided)',
      ]);
    }
  }

  if (lesson.applicationTest?.enabled) {
    context.specPins.push({
      contentKey: `${lessonCode}.application-test`,
      version: 1,
    });
    context.applicationRows.push([
      lessonCode,
      defaultLanguage,
      lesson.applicationTest.scenario,
      lesson.applicationTest.referenceAnswer ?? '(not provided)',
    ]);
  }
}

function renditionKeyOf(
  contentKey: string,
  blockId: string,
  language: string,
  modality: string,
  carrierType: string,
  carrierKey: string,
  occurrenceKey: string,
): string {
  return stableToken(
    [
      'r',
      contentKey,
      blockId,
      language,
      modality,
      carrierType,
      carrierKey,
      occurrenceKey,
    ].join('.'),
    'rendition',
  );
}

/** 供调用方生成课程级 identity（studyMode/titleLocalized 等）。 */
export function partcIdentityFromCourse(
  course: PackageCourse,
  options: {
    courseKey?: string;
    slug?: string;
    versionNo: number;
    categoryPath?: string[] | null;
  },
): PartcExportIdentity {
  const titleLocalized: Record<string, Record<string, string>> = {};
  for (const [language, loc] of Object.entries(course.localized ?? {})) {
    if (loc.title) titleLocalized[language] = { title: loc.title };
  }
  if (Object.keys(titleLocalized).length === 0) {
    titleLocalized[course.defaultContentLanguage] = { title: course.code };
  }
  return {
    courseKey: options.courseKey ?? course.code,
    slug: options.slug ?? course.slug,
    categoryPath:
      options.categoryPath !== undefined
        ? options.categoryPath
        : course.categoryPath,
    learningLanguages:
      course.learningLanguages.length > 0
        ? course.learningLanguages
        : [course.defaultContentLanguage],
    studyMode: studyModeOf(course),
    titleLocalized,
    versionNo: options.versionNo,
  };
}
