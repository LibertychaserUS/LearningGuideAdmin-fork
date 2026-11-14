import { canonicalJson } from '../contracts';
import type {
  CompilerIssue,
  IssueSeverity,
  PackageIR,
  SourceCoordinate,
} from './parse';
import type {
  ExhibitRow,
  LearningPointRow,
  MediaRow,
  TypedRow,
  ValidatedRows,
} from './validate';

/**
 * Part C 编译器 P3：机器派生时间（设计 §14 C5 P3、C7、C0「视频时间源」硬需求）。
 *
 * 红线（C0 ⑥/C7）：
 * - 模板/包里没有任何人工时间输入；本模块只从机器来源派生坐标，优先级：
 *   ① 外部字幕 SRT/VTT cue；② MP4 chapter track（或包内 chapters JSON）；
 *   ③ ASR（默认兜底：从音轨生成转写与时间，内部派生工件、非交付物）；
 *   ④ 强制对齐（仅课时显式声明「文本稿=口播稿」时启用）；
 *   DOCX Heading 只用于文本锚点（不是媒体时间源）。
 * - 每个视频 × 每个语言独立派生；一个语言缺失不静默复制另一个语言的源。
 * - 点锚点按 ruleVersion 冻结的规则展开为半开区间 [start,end)：
 *   有字幕 cue ⇒ 用 cue 区间；只有点锚点 ⇒ end = 同一载体下一个锚点 - 1ms，
 *   否则 end = duration；最小窗口/最大窗口/gap 阈值随 TIMING_RULE_VERSION 版本化。
 * - ASR / 强制对齐的 modelVersion/params/ruleVersion 逐条 pin 进坐标与审计报告
 *   （provenance）；同输入重复派生逐条一致。
 * - 任何缺失/越界/歧义都进 report：无源 → TIMING_SOURCE_MISSING（incomplete，
 *   阻止发布，ALN-7）；置信度不足 → ALIGNMENT_LOW_CONFIDENCE（incomplete）；
 *   越界/负值/非法源工件 → TIMING_RANGE_INVALID / TRANSCRIPT_INVALID（error）。
 *   带源坐标，不猜、不 clamp。
 * - 输出审计报告（毫秒、mm:ss.mmm、邻近文本、sourceKind/sourceArtifact/
 *   modelVersion/params/ruleVersion）供 Sandbox 播放复核；语义真实性由人复核，
 *   机器不做语义推断。
 *
 * 纯函数边界：容器/字幕/章节全部从 PackageIR.files 的字节确定性解析；ASR 与
 * 强制对齐不能在本模块内运行模型——它们是「内部派生工件」，由薄壳（导入服务）
 * 默认从音轨生成后以 TranscriptArtifactInput 传入；DOCX 结构（Heading 与
 * [Exhibit: code] 对话行）由薄壳用既有 DOCX→HTML 步骤抽取后以
 * DocumentStructureInput 传入（本模块不引 mammoth/异步 IO/外部进程）。
 */

// ---------------------------------------------------------------------------
// 规则版本与参数（C7「以参数形式版本化」；改值必须换 ruleVersion）
// ---------------------------------------------------------------------------

export const TIMING_RULE_VERSION = 'timing-rules-v1' as const;

export const TIMING_RULE_PARAMETERS = Object.freeze({
  /** 点锚点展开后的窗口下限：低于此值是噪声，error。 */
  minWindowMs: 500,
  /** 窗口上限：超过只告警（规则本身仍按 C7 字面展开）。 */
  maxWindowMs: 15 * 60 * 1000,
  /** 相邻锚点间隔阈值：超过只告警，便于复核长区间。 */
  gapThresholdMs: 2 * 60 * 1000,
  /**
   * ASR / 强制对齐 cue 的最低置信度（0..1）。低于此值 → ALIGNMENT_LOW_CONFIDENCE
   * （incomplete，阶段 blocked，ALN-7）；不 clamp、不猜。
   */
  minTranscriptConfidence: 0.65,
});

export type TimingRuleParameters = typeof TIMING_RULE_PARAMETERS;

// ---------------------------------------------------------------------------
// 输入/输出类型
// ---------------------------------------------------------------------------

export interface DocumentHeadingInput {
  readonly headingCode: string;
  readonly title: string;
  readonly offset?: number;
}

export interface TriggerMarkerInput {
  /** 正文 [Exhibit: code] 的 code。 */
  readonly exhibitCode: string;
  /** 标记所在的对话行文本（可含标记本身；匹配前会剥掉）。 */
  readonly lineText: string;
}

export interface DocumentStructureInput {
  /** 与 Media sheet kind='lesson-text' 的 asset_key 一致。 */
  readonly assetKey: string;
  readonly lessonCode: string;
  readonly language: string;
  readonly headings: readonly DocumentHeadingInput[];
  readonly triggerMarkers: readonly TriggerMarkerInput[];
  /** 正文 HTML（薄壳 DOCX→HTML 产物）；align 用于派生正文块。 */
  readonly html?: string;
}

export interface TimingDerivationInput {
  readonly ir: PackageIR;
  readonly rows: ValidatedRows;
  readonly documents?: readonly DocumentStructureInput[];
  /**
   * ASR / 强制对齐的内部派生工件（薄壳生成，C5 P3/C7）。ASR 是默认兜底：
   * 薄壳对每个视频 × 每个语言从音轨生成转写工件后传入；缺失即视为无 ASR 源。
   */
  readonly transcripts?: readonly TranscriptArtifactInput[];
  /**
   * 课时的显式声明「文本稿=口播稿」。强制对齐只在声明存在时启用（C7 ④）；
   * 声明由内容侧显式给出（模板契约尚无该列，见实现报告 blocker），
   * 编译器绝不自行推断。
   */
  readonly forcedAlignmentDeclarations?: readonly ForcedAlignmentDeclaration[];
}

export type TimingAnchorKind = 'lp' | 'trigger';

/** 派生的时间源种类（C7：subtitle/chapter/asr/forced-alignment + 文本锚点）。 */
export type TimingSourceKind =
  'subtitle' | 'chapter' | 'asr' | 'forced-alignment' | 'doc-structure';

/** provenance.params 的取值（JSON 标量；确定性 JSON 可比较）。 */
export type TimingParamValue = string | number | boolean | null;

/**
 * 一条坐标的派生审计元组（C7）：sourceKind/sourceArtifact 必有；
 * ASR / 强制对齐额外 pin modelVersion/params/ruleVersion。
 * 不参与内容身份；只用于复核与争议追溯。
 */
export interface TimingProvenance {
  readonly sourceKind: TimingSourceKind;
  /** 字幕/章节=包内路径；ASR/强制对齐=内部工件 id；doc-structure=document assetKey。 */
  readonly sourceArtifact: string;
  readonly modelVersion?: string;
  readonly params?: Readonly<Record<string, TimingParamValue>>;
  /** 派生规则版本（ASR/强制对齐工件的 ruleVersion；其余为 TIMING_RULE_VERSION）。 */
  readonly ruleVersion: string;
}

/** 一条 ASR / 强制对齐的转写 cue（内部工件；整数毫秒 + 置信度）。 */
export interface TranscriptCueInput {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  /** 0..1；由转写/对齐模型给出。 */
  readonly confidence: number;
}

/**
 * ASR / 强制对齐转写工件（内部派生工件，非交付物，不进课程包）。
 *
 * - `assetKey`/`language` 必须对应包内该语言的视频载体（每语言独立派生）。
 * - `sourceArtifact` 是工件稳定标识（如 `asr:asset-video-en:en-GB`）。
 * - modelVersion/params/ruleVersion 原样 pin 进坐标与审计报告；
 *   若 manifest.provenance.asr 存在，必须与之一致（PROVENANCE_MISMATCH）。
 */
export interface TranscriptArtifactInput {
  readonly sourceKind: 'asr' | 'forced-alignment';
  readonly assetKey: string;
  readonly language: string;
  readonly sourceArtifact: string;
  readonly modelVersion: string;
  readonly params: Readonly<Record<string, TimingParamValue>>;
  readonly ruleVersion: string;
  readonly cues: readonly TranscriptCueInput[];
  /** 仅强制对齐：被对齐的文本稿 document assetKey（须与声明一致）。 */
  readonly documentAssetKey?: string;
}

/** 课时显式声明「文本稿=口播稿」（C7 ④；强制对齐的唯一启用依据）。 */
export interface ForcedAlignmentDeclaration {
  readonly lessonCode: string;
  readonly language: string;
  readonly documentAssetKey: string;
}

/** 一条派生坐标（尚未分配 renditionKey/carrierVersion；P4 align 消费）。 */
export interface TimingCoordinate {
  readonly lessonCode: string;
  readonly language: string;
  readonly kind: TimingAnchorKind;
  /** lpCode 或 exhibitCode。 */
  readonly code: string;
  readonly occurrenceKey: string;
  readonly carrierType: 'asset' | 'document';
  readonly carrierKey: string;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly headingCode?: string;
  readonly offset?: number;
  readonly anchorSource: TimingSourceKind;
  /** 与 provenance.sourceKind 同值（兼容既有消费者；单一事实仍是 provenance）。 */
  readonly source: TimingSourceKind;
  /** 该坐标的完整派生审计元组（C7；ASR 时含 modelVersion/params/ruleVersion）。 */
  readonly provenance: TimingProvenance;
  /** 转写来源的 cue 置信度（0..1）；字幕/章节/doc-structure 无此字段。 */
  readonly confidence?: number;
  /** 匹配到/邻近的源文本（cue 文本、章节标题、Heading 标题）。 */
  readonly nearbyText: string;
}

export interface TimingAuditEntry {
  readonly lessonCode: string;
  readonly language: string;
  readonly kind: TimingAnchorKind;
  readonly code: string;
  readonly occurrenceKey: string;
  readonly carrierType: 'asset' | 'document';
  readonly carrierKey: string;
  readonly startMs?: number;
  /** mm:ss.mmm（毫秒精度；分钟可超过 59）。 */
  readonly startFormatted?: string;
  readonly endMs?: number;
  readonly endFormatted?: string;
  readonly headingCode?: string;
  readonly anchorSource: TimingSourceKind;
  /** C7 审计字段：派生源种类/工件/模型 pin/规则版本。 */
  readonly sourceKind: TimingSourceKind;
  readonly sourceArtifact: string;
  readonly modelVersion?: string;
  readonly params?: Readonly<Record<string, TimingParamValue>>;
  readonly ruleVersion: string;
  readonly confidence?: number;
  readonly nearbyText: string;
}

export interface TimingAssetInfo {
  readonly assetKey: string;
  readonly durationMs: number | null;
  readonly chapterSource: 'track' | 'json' | null;
}

/** 去重后的派生源 pin 汇总（导出/快照 provenance 携带用；确定性排序）。 */
export interface TimingSourcePin {
  readonly sourceKind: TimingSourceKind;
  readonly sourceArtifact: string;
  readonly modelVersion?: string;
  readonly params?: Readonly<Record<string, TimingParamValue>>;
  readonly ruleVersion: string;
}

export interface TimingResult {
  readonly ruleVersion: typeof TIMING_RULE_VERSION;
  readonly parameters: TimingRuleParameters;
  readonly coordinates: readonly TimingCoordinate[];
  readonly audit: readonly TimingAuditEntry[];
  readonly assets: readonly TimingAssetInfo[];
  /** 本结果实际使用的时间源 pin（含 ASR modelVersion/params/ruleVersion）。 */
  readonly provenance: readonly TimingSourcePin[];
  readonly issues: readonly CompilerIssue[];
}

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

function makeIssue(
  severity: IssueSeverity,
  code: CompilerIssue['code'],
  message: string,
  source: SourceCoordinate | undefined,
  details?: Record<string, unknown>,
): CompilerIssue {
  return { severity, code, message, source, details };
}

/** mm:ss.mmm（总分钟数，不折小时；与审计报告口径一致）。 */
export function formatTimecode(ms: number): string {
  const total = Math.round(ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  const pad = (value: number, width: number): string =>
    String(value).padStart(width, '0');
  return `${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}

function clampText(text: string, max = 160): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max
    ? collapsed
    : `${collapsed.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// MP4（ISO BMFF）容器探测：durationMs + chapter track/chpl
// ---------------------------------------------------------------------------

interface Mp4Box {
  readonly type: string;
  readonly start: number;
  readonly size: number;
  readonly headerSize: number;
  readonly end: number;
}

function makeView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
  view: DataView,
): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      const large = view.getBigUint64(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(large);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) break;
    boxes.push({ type, start: offset, size, headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
}

function childBoxes(
  bytes: Uint8Array,
  parent: Mp4Box,
  view: DataView,
): Mp4Box[] {
  return readBoxes(bytes, parent.start + parent.headerSize, parent.end, view);
}

function findBox(boxes: readonly Mp4Box[], type: string): Mp4Box | undefined {
  return boxes.find((box) => box.type === type);
}

function readMvhdDurationMs(
  bytes: Uint8Array,
  mvhd: Mp4Box,
  view: DataView,
): number | null {
  const payload = mvhd.start + mvhd.headerSize;
  if (payload + 4 > mvhd.end) return null;
  const version = bytes[payload];
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (payload + 32 > mvhd.end) return null;
    timescale = view.getUint32(payload + 20);
    duration = Number(view.getBigUint64(payload + 24));
  } else {
    if (payload + 20 > mvhd.end) return null;
    timescale = view.getUint32(payload + 12);
    duration = view.getUint32(payload + 16);
  }
  if (timescale <= 0 || duration <= 0) return null;
  // 向上取整到整数毫秒：保证 endMs = durationMs 的合法区间不被浮点残差拒绝。
  return Math.ceil((duration * 1000) / timescale);
}

/**
 * 容器探测：MP4 的 mvhd → durationMs（整数毫秒）。解析失败返回 null
 * （调用方按 TIMING_SOURCE_MISSING 处理，不跳过校验、不估算）。
 */
export function probeMp4DurationMs(bytes: Uint8Array): number | null {
  try {
    const view = makeView(bytes);
    const top = readBoxes(bytes, 0, bytes.byteLength, view);
    const moov = findBox(top, 'moov');
    if (moov === undefined) return null;
    const mvhd = findBox(childBoxes(bytes, moov, view), 'mvhd');
    if (mvhd === undefined) return null;
    return readMvhdDurationMs(bytes, mvhd, view);
  } catch {
    return null;
  }
}

export interface ChapterCue {
  readonly startMs: number;
  readonly endMs?: number;
  readonly title: string;
}

interface SampleTableInfo {
  readonly sampleCount: number;
  readonly sampleDurationsTicks: readonly number[];
  readonly sampleSizes: readonly number[];
  readonly sampleOffsets: readonly number[];
}

function readTrackId(
  bytes: Uint8Array,
  tkhd: Mp4Box,
  view: DataView,
): number | null {
  const payload = tkhd.start + tkhd.headerSize;
  if (payload + 4 > tkhd.end) return null;
  const version = bytes[payload];
  const trackIdOffset = version === 1 ? payload + 20 : payload + 12;
  if (trackIdOffset + 4 > tkhd.end) return null;
  return view.getUint32(trackIdOffset);
}

function readMdhd(
  bytes: Uint8Array,
  mdhd: Mp4Box,
  view: DataView,
): { timescale: number; duration: number } | null {
  const payload = mdhd.start + mdhd.headerSize;
  if (payload + 4 > mdhd.end) return null;
  const version = bytes[payload];
  if (version === 1) {
    if (payload + 32 > mdhd.end) return null;
    return {
      timescale: view.getUint32(payload + 20),
      duration: Number(view.getBigUint64(payload + 24)),
    };
  }
  if (payload + 20 > mdhd.end) return null;
  return {
    timescale: view.getUint32(payload + 12),
    duration: view.getUint32(payload + 16),
  };
}

function readHandlerType(bytes: Uint8Array, hdlr: Mp4Box): string | null {
  const payload = hdlr.start + hdlr.headerSize;
  if (payload + 12 > hdlr.end) return null;
  return String.fromCharCode(
    bytes[payload + 8],
    bytes[payload + 9],
    bytes[payload + 10],
    bytes[payload + 11],
  );
}

function readSampleTable(
  bytes: Uint8Array,
  stbl: Mp4Box,
  view: DataView,
): SampleTableInfo | null {
  const kids = childBoxes(bytes, stbl, view);
  const stts = findBox(kids, 'stts');
  const stsz = findBox(kids, 'stsz');
  const stsc = findBox(kids, 'stsc');
  const stco = findBox(kids, 'stco');
  const co64 = findBox(kids, 'co64');
  if (
    stts === undefined ||
    stsz === undefined ||
    stsc === undefined ||
    (stco === undefined && co64 === undefined)
  ) {
    return null;
  }

  // stts → 每个 sample 的 delta（保持时间轴顺序）
  const sttsPayload = stts.start + stts.headerSize;
  const sttsCount = view.getUint32(sttsPayload + 4);
  const durationsRaw: number[] = [];
  for (let i = 0; i < sttsCount; i += 1) {
    const at = sttsPayload + 8 + i * 8;
    if (at + 8 > stts.end) return null;
    const sampleCount = view.getUint32(at);
    const delta = view.getUint32(at + 4);
    for (let j = 0; j < sampleCount; j += 1) durationsRaw.push(delta);
  }

  // stsz → sample sizes
  const stszPayload = stsz.start + stsz.headerSize;
  const uniformSize = view.getUint32(stszPayload + 4);
  const sampleCount = view.getUint32(stszPayload + 8);
  const sampleSizes: number[] = [];
  if (uniformSize !== 0) {
    for (let i = 0; i < sampleCount; i += 1) sampleSizes.push(uniformSize);
  } else {
    for (let i = 0; i < sampleCount; i += 1) {
      const at = stszPayload + 12 + i * 4;
      if (at + 4 > stsz.end) return null;
      sampleSizes.push(view.getUint32(at));
    }
  }

  // stco / co64 → chunk offsets
  const chunkOffsets: number[] = [];
  if (stco !== undefined) {
    const payload = stco.start + stco.headerSize;
    const count = view.getUint32(payload + 4);
    for (let i = 0; i < count; i += 1) {
      const at = payload + 8 + i * 4;
      if (at + 4 > stco.end) return null;
      chunkOffsets.push(view.getUint32(at));
    }
  } else if (co64 !== undefined) {
    const payload = co64.start + co64.headerSize;
    const count = view.getUint32(payload + 4);
    for (let i = 0; i < count; i += 1) {
      const at = payload + 8 + i * 8;
      if (at + 8 > co64.end) return null;
      chunkOffsets.push(Number(view.getBigUint64(at)));
    }
  }

  // stsc → 每个 chunk 的 samples_per_chunk
  const stscPayload = stsc.start + stsc.headerSize;
  const stscCount = view.getUint32(stscPayload + 4);
  const stscEntries: Array<{ firstChunk: number; samplesPerChunk: number }> =
    [];
  for (let i = 0; i < stscCount; i += 1) {
    const at = stscPayload + 8 + i * 12;
    if (at + 12 > stsc.end) return null;
    stscEntries.push({
      firstChunk: view.getUint32(at),
      samplesPerChunk: view.getUint32(at + 4),
    });
  }

  const sampleOffsets: number[] = [];
  let sampleIndex = 0;
  for (let chunk = 1; chunk <= chunkOffsets.length; chunk += 1) {
    let samplesPerChunk = 0;
    for (const entry of stscEntries) {
      if (entry.firstChunk <= chunk) samplesPerChunk = entry.samplesPerChunk;
      else break;
    }
    let offset = chunkOffsets[chunk - 1];
    for (let s = 0; s < samplesPerChunk && sampleIndex < sampleCount; s += 1) {
      sampleOffsets[sampleIndex] = offset;
      offset += sampleSizes[sampleIndex];
      sampleIndex += 1;
    }
  }

  return {
    sampleCount,
    sampleDurationsTicks: durationsRaw,
    sampleSizes,
    sampleOffsets,
  };
}

function decodeChapterSample(
  bytes: Uint8Array,
  offset: number,
  size: number,
): string {
  if (size <= 0 || offset < 0 || offset + size > bytes.length) return '';
  if (size >= 2) {
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length > 0 && 2 + length <= size) {
      return decodeUtf8(bytes.subarray(offset + 2, offset + 2 + length)).trim();
    }
  }
  return decodeUtf8(bytes.subarray(offset, offset + size)).trim();
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

// ---------------------------------------------------------------------------
// MP4 chapter track / chpl（C7 派生源②；与 chapters JSON 二选一）
// ---------------------------------------------------------------------------

interface TrackInfo {
  readonly trak: Mp4Box;
  readonly trackId: number | null;
  readonly handlerType: string | null;
  readonly chapterRefs: readonly number[];
}

function readChapterRefs(
  bytes: Uint8Array,
  trakKids: readonly Mp4Box[],
  view: DataView,
): number[] {
  const tref = findBox(trakKids, 'tref');
  if (tref === undefined) return [];
  const chap = findBox(childBoxes(bytes, tref, view), 'chap');
  if (chap === undefined) return [];
  const payload = chap.start + chap.headerSize;
  const count = Math.floor((chap.end - payload) / 4);
  const refs: number[] = [];
  for (let i = 0; i < count; i += 1) {
    refs.push(view.getUint32(payload + i * 4));
  }
  return refs;
}

function sortChapterCues(cues: readonly ChapterCue[]): ChapterCue[] {
  const sorted = [...cues].sort((a, b) =>
    a.startMs !== b.startMs
      ? a.startMs - b.startMs
      : a.title < b.title
        ? -1
        : a.title > b.title
          ? 1
          : 0,
  );
  const out: ChapterCue[] = [];
  let lastStart = -1;
  for (const cue of sorted) {
    if (cue.startMs === lastStart) continue;
    out.push(cue);
    lastStart = cue.startMs;
  }
  return out.map((cue, index) => ({
    startMs: cue.startMs,
    endMs:
      index + 1 < out.length && cue.endMs === undefined
        ? out[index + 1].startMs
        : cue.endMs,
    title: cue.title,
  }));
}

function readChapterTrackCues(
  bytes: Uint8Array,
  trak: Mp4Box,
  view: DataView,
): ChapterCue[] {
  const trakKids = childBoxes(bytes, trak, view);
  const mdia = findBox(trakKids, 'mdia');
  if (mdia === undefined) return [];
  const mdiaKids = childBoxes(bytes, mdia, view);
  const mdhd = findBox(mdiaKids, 'mdhd');
  if (mdhd === undefined) return [];
  const mdhdInfo = readMdhd(bytes, mdhd, view);
  if (mdhdInfo === null || mdhdInfo.timescale <= 0) return [];
  const minf = findBox(mdiaKids, 'minf');
  if (minf === undefined) return [];
  const stbl = findBox(childBoxes(bytes, minf, view), 'stbl');
  if (stbl === undefined) return [];
  const table = readSampleTable(bytes, stbl, view);
  if (table === null) return [];

  const count = Math.min(
    table.sampleCount,
    table.sampleSizes.length,
    table.sampleOffsets.length,
  );
  const cues: ChapterCue[] = [];
  let ticks = 0;
  for (let i = 0; i < count; i += 1) {
    const startMs = Math.round((ticks * 1000) / mdhdInfo.timescale);
    ticks += table.sampleDurationsTicks[i] ?? 0;
    const title = decodeChapterSample(
      bytes,
      table.sampleOffsets[i],
      table.sampleSizes[i],
    );
    if (title !== '') cues.push({ startMs, title });
  }
  return sortChapterCues(cues);
}

function readChplCues(
  bytes: Uint8Array,
  moov: Mp4Box,
  view: DataView,
): ChapterCue[] {
  const udta = findBox(childBoxes(bytes, moov, view), 'udta');
  if (udta === undefined) return [];
  const chpl = findBox(childBoxes(bytes, udta, view), 'chpl');
  if (chpl === undefined) return [];
  const payload = chpl.start + chpl.headerSize;
  if (payload + 5 > chpl.end) return [];
  const version = bytes[payload];
  let cursor = payload + 4;
  if (version === 1) cursor += 4; // 4 字节 reserved
  if (cursor + 1 > chpl.end) return [];
  const count = bytes[cursor];
  cursor += 1;
  const cues: ChapterCue[] = [];
  for (let i = 0; i < count; i += 1) {
    if (cursor + 9 > chpl.end) break;
    const ticks = Number(view.getBigUint64(cursor));
    cursor += 8;
    const length = bytes[cursor];
    cursor += 1;
    if (cursor + length > chpl.end) break;
    const title = decodeUtf8(bytes.subarray(cursor, cursor + length)).trim();
    cursor += length;
    // chpl 起点单位 = 100ns（1/10µs）→ 毫秒。
    if (title !== '') cues.push({ startMs: Math.round(ticks / 10000), title });
  }
  return sortChapterCues(cues);
}

/**
 * 从 MP4 字节提取 chapter track（ffmpeg 注入的标准布局：video trak 的
 * tref/chap 指向章节文本轨，stts/stsz/stsc/stco 定位样本）；没有 chapter track
 * 时回退 Nero chpl 盒。解析失败返回空数组（不猜、不阻断其它派生源）。
 */
export function extractMp4Chapters(bytes: Uint8Array): ChapterCue[] {
  try {
    const view = makeView(bytes);
    const top = readBoxes(bytes, 0, bytes.byteLength, view);
    const moov = findBox(top, 'moov');
    if (moov === undefined) return [];
    const moovKids = childBoxes(bytes, moov, view);
    const traks = moovKids.filter((box) => box.type === 'trak');

    const trackInfos: TrackInfo[] = traks.map((trak) => {
      const kids = childBoxes(bytes, trak, view);
      const tkhd = findBox(kids, 'tkhd');
      const mdia = findBox(kids, 'mdia');
      const mdiaKids = mdia === undefined ? [] : childBoxes(bytes, mdia, view);
      const hdlr = findBox(mdiaKids, 'hdlr');
      return {
        trak,
        trackId: tkhd === undefined ? null : readTrackId(bytes, tkhd, view),
        handlerType: hdlr === undefined ? null : readHandlerType(bytes, hdlr),
        chapterRefs: readChapterRefs(bytes, kids, view),
      };
    });

    const chapterTrackIds = new Set<number>();
    for (const info of trackInfos) {
      for (const ref of info.chapterRefs) chapterTrackIds.add(ref);
    }

    if (chapterTrackIds.size > 0) {
      const fromTracks: ChapterCue[] = [];
      for (const info of trackInfos) {
        if (info.trackId === null) continue;
        if (!chapterTrackIds.has(info.trackId)) continue;
        fromTracks.push(...readChapterTrackCues(bytes, info.trak, view));
      }
      if (fromTracks.length > 0) return sortChapterCues(fromTracks);
    }

    return readChplCues(bytes, moov, view);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 字幕 SRT / VTT（纯文本机器解析；无时间输入通道外的任何来源）
// ---------------------------------------------------------------------------

export interface SubtitleCue {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export class SubtitleSyntaxError extends Error {
  readonly line?: number;

  constructor(message: string, line?: number) {
    super(message);
    this.name = 'SubtitleSyntaxError';
    this.line = line;
  }
}

export function detectSubtitleFormat(source: string): 'srt' | 'vtt' {
  const body = stripBom(source).trimStart();
  return /^WEBVTT\b/i.test(body) ? 'vtt' : 'srt';
}

function stripBom(source: string): string {
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
}

function normalizeNewlines(source: string): string {
  return stripBom(source).replace(/\r\n?/g, '\n');
}

function parseTimeToken(token: string): number | null {
  const match = /^(?:(\d{1,4}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(
    token.trim(),
  );
  if (match === null) return null;
  const hours = match[1] === undefined ? 0 : Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4].padEnd(3, '0'));
  if (minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

interface SubtitleBlock {
  readonly lineNumber: number;
  readonly lines: readonly string[];
}

function splitSubtitleBlocks(source: string): SubtitleBlock[] {
  const normalized = normalizeNewlines(source);
  const blocks: SubtitleBlock[] = [];
  const lines = normalized.split('\n');
  let current: string[] = [];
  let startLine = 1;
  lines.forEach((line, index) => {
    if (line.trim() === '') {
      if (current.length > 0) {
        blocks.push({ lineNumber: startLine, lines: current });
        current = [];
      }
      startLine = index + 2;
      return;
    }
    if (current.length === 0) startLine = index + 1;
    current.push(line);
  });
  if (current.length > 0)
    blocks.push({ lineNumber: startLine, lines: current });
  return blocks;
}

function parseTimingLine(
  line: string,
  blockLine: number,
): { startMs: number; endMs: number } {
  const arrow = line.indexOf('-->');
  if (arrow < 0) {
    throw new SubtitleSyntaxError(
      'cue timing line must contain -->',
      blockLine,
    );
  }
  const left = line.slice(0, arrow).trim();
  const right = line
    .slice(arrow + 3)
    .trim()
    .split(/\s+/)[0];
  const startMs = parseTimeToken(left);
  const endMs = parseTimeToken(right ?? '');
  if (startMs === null || endMs === null) {
    throw new SubtitleSyntaxError(
      'cue timing must be hh:mm:ss,mmm / mm:ss.mmm',
      blockLine,
    );
  }
  if (startMs >= endMs) {
    throw new SubtitleSyntaxError('cue start must be < cue end', blockLine);
  }
  return { startMs, endMs };
}

/**
 * SRT 解析：块 = 可选序号行 + 时间行 + 文本行；时间用逗号或点毫秒。
 * 语法错误抛 SubtitleSyntaxError（带块起始行号），由 deriveTiming 转 issue。
 */
export function parseSrt(source: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const block of splitSubtitleBlocks(source)) {
    const lines = [...block.lines];
    let index = cues.length + 1;
    if (/^\d+$/.test(lines[0].trim())) {
      index = Number(lines[0].trim());
      lines.shift();
    }
    if (lines.length === 0) {
      throw new SubtitleSyntaxError('cue block is empty', block.lineNumber);
    }
    const timing = parseTimingLine(lines[0], block.lineNumber);
    const text = lines.slice(1).join('\n').trim();
    cues.push({ index, ...timing, text });
  }
  return cues;
}

/** VTT 解析：WEBVTT 头、NOTE/STYLE/REGION 块跳过、可选 cue id、cue settings 忽略。 */
export function parseVtt(source: string): SubtitleCue[] {
  const normalized = normalizeNewlines(source);
  const firstLine = normalized.split('\n', 1)[0].trim();
  if (!/^WEBVTT\b/i.test(firstLine)) {
    throw new SubtitleSyntaxError('VTT must start with WEBVTT', 1);
  }
  const cues: SubtitleCue[] = [];
  for (const block of splitSubtitleBlocks(normalized)) {
    const first = block.lines[0].trim();
    if (/^(NOTE|STYLE|REGION)\b/i.test(first)) continue;
    if (/^WEBVTT\b/i.test(first)) continue;
    let lines = [...block.lines];
    if (!lines[0].includes('-->')) {
      lines = lines.slice(1); // 可选 cue identifier
    }
    if (lines.length === 0) continue;
    const timing = parseTimingLine(lines[0], block.lineNumber);
    const text = lines.slice(1).join('\n').trim();
    cues.push({ index: cues.length + 1, ...timing, text });
  }
  return cues;
}

export function parseSubtitleCues(
  source: string,
  format: 'srt' | 'vtt' | 'auto' = 'auto',
): SubtitleCue[] {
  const resolved = format === 'auto' ? detectSubtitleFormat(source) : format;
  return resolved === 'vtt' ? parseVtt(source) : parseSrt(source);
}

// ---------------------------------------------------------------------------
// chapters JSON（与 MP4 chapter track 二选一；只收整数毫秒）
// ---------------------------------------------------------------------------

export function parseChaptersJson(value: unknown): ChapterCue[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'object' &&
        value !== null &&
        Array.isArray((value as Record<string, unknown>).chapters)
      ? ((value as Record<string, unknown>).chapters as unknown[])
      : null;
  if (list === null) {
    throw new SubtitleSyntaxError(
      'chapters JSON must be an array or { chapters: [...] }',
    );
  }
  const entries: Array<{ startMs: number; title: string }> = [];
  list.forEach((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new SubtitleSyntaxError(`chapters[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    const startMs = record.startMs;
    if (title === '') {
      throw new SubtitleSyntaxError(`chapters[${index}].title is required`);
    }
    if (
      typeof startMs !== 'number' ||
      !Number.isInteger(startMs) ||
      startMs < 0
    ) {
      throw new SubtitleSyntaxError(
        `chapters[${index}].startMs must be a non-negative integer millisecond`,
      );
    }
    entries.push({ startMs, title });
  });
  entries.sort((a, b) =>
    a.startMs !== b.startMs
      ? a.startMs - b.startMs
      : a.title < b.title
        ? -1
        : 1,
  );
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].startMs === entries[i - 1].startMs) {
      throw new SubtitleSyntaxError(
        'chapters must have strictly increasing startMs values',
      );
    }
  }
  return entries.map((entry, index) => ({
    startMs: entry.startMs,
    endMs: index + 1 < entries.length ? entries[index + 1].startMs : undefined,
    title: entry.title,
  }));
}

// ---------------------------------------------------------------------------
// 字幕/章节文本匹配（保守：唯一命中才派生，0/多命中都显式报告）
// ---------------------------------------------------------------------------

function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/^\s*\d+(?:[.)]\d+)*[.)、]?\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripExhibitMarkers(text: string): string {
  return text.replace(/\[Exhibit:[^\]]*\]/gi, ' ');
}

function matchAgainst<T>(
  items: readonly T[],
  textOf: (item: T) => string,
  needle: string,
): number[] {
  if (needle === '') return [];
  const exact: number[] = [];
  const contains: number[] = [];
  items.forEach((item, index) => {
    const candidate = normalizeForMatch(textOf(item));
    if (candidate === needle) exact.push(index);
    else if (candidate.includes(needle)) contains.push(index);
  });
  if (exact.length > 0) return exact;
  return contains;
}

// ---------------------------------------------------------------------------
// 主入口：deriveTiming
// ---------------------------------------------------------------------------

function mediaSlotKey(
  kind: string,
  lessonCode: string,
  language: string,
): string {
  return `${kind}\u0000${lessonCode}\u0000${language}`;
}

function indexMedia(rows: ValidatedRows): Map<string, TypedRow<MediaRow>> {
  const index = new Map<string, TypedRow<MediaRow>>();
  for (const row of rows.media) {
    const { kind, lesson_code: lessonCode, language } = row.value;
    if (lessonCode === null || language === null) continue;
    index.set(mediaSlotKey(kind, lessonCode, language), row);
  }
  return index;
}

function mediaSource(
  row: TypedRow<MediaRow> | undefined,
  column: string,
): SourceCoordinate | undefined {
  return row === undefined
    ? undefined
    : { sheet: 'Media', row: row.rowNumber, column };
}

// ---------------------------------------------------------------------------
// ASR / 强制对齐工件索引与校验（C5 P3 / C7 ③④）
// ---------------------------------------------------------------------------

interface IndexedTranscriptArtifact {
  readonly artifact: TranscriptArtifactInput;
  readonly index: number;
}

interface TranscriptIndex {
  /** slot key = (video assetKey, language)；每语言独立。 */
  readonly asrBySlot: Map<string, IndexedTranscriptArtifact>;
  readonly forcedBySlot: Map<string, IndexedTranscriptArtifact>;
  readonly declarationBySlot: Map<string, ForcedAlignmentDeclaration>;
}

function transcriptSlotKey(assetKey: string, language: string): string {
  return `${assetKey}\u0000${language}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isParamValue(value: unknown): value is TimingParamValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isCueArray(value: unknown): value is readonly TranscriptCueInput[] {
  return Array.isArray(value);
}

/**
 * 校验并索引转写工件与强制对齐声明。任何非法工件都是 error（包/管道缺陷，
 * 不静默丢弃）；缺失工件不是错误（按无源处理，见 deriveSlot）。
 */
function indexTranscriptArtifacts(
  input: TimingDerivationInput,
  issues: CompilerIssue[],
): TranscriptIndex {
  const asrBySlot = new Map<string, IndexedTranscriptArtifact>();
  const forcedBySlot = new Map<string, IndexedTranscriptArtifact>();
  const declarationBySlot = new Map<string, ForcedAlignmentDeclaration>();

  const videoRowByAsset = new Map<string, TypedRow<MediaRow>>();
  const documentAssetsByLessonLanguage = new Map<string, Set<string>>();
  for (const row of input.rows.media) {
    if (row.value.kind === 'video') {
      videoRowByAsset.set(row.value.asset_key, row);
    }
    if (
      row.value.kind === 'lesson-text' &&
      row.value.lesson_code !== null &&
      row.value.language !== null
    ) {
      const key = `${row.value.lesson_code}\u0000${row.value.language}`;
      const set = documentAssetsByLessonLanguage.get(key) ?? new Set<string>();
      set.add(row.value.asset_key);
      documentAssetsByLessonLanguage.set(key, set);
    }
  }

  const lessonLanguages = new Set(
    input.rows.lessons.map(
      (row) => `${row.value.lesson_code}\u0000${row.value.language}`,
    ),
  );

  (input.forcedAlignmentDeclarations ?? []).forEach((declaration, index) => {
    const key = `${declaration.lessonCode}\u0000${declaration.language}`;
    const path = `forcedAlignmentDeclarations[${index}]`;
    if (!lessonLanguages.has(key)) {
      issues.push(
        makeIssue(
          'error',
          'TRANSCRIPT_INVALID',
          'forced-alignment declaration references an unknown lesson/language',
          { path },
          {
            lessonCode: declaration.lessonCode,
            language: declaration.language,
            reason: 'declaration-unknown-lesson',
          },
        ),
      );
      return;
    }
    const documents =
      documentAssetsByLessonLanguage.get(key) ?? new Set<string>();
    if (!documents.has(declaration.documentAssetKey)) {
      issues.push(
        makeIssue(
          'error',
          'TRANSCRIPT_INVALID',
          'forced-alignment declaration must reference the lesson text document of this lesson/language',
          { path },
          {
            lessonCode: declaration.lessonCode,
            language: declaration.language,
            documentAssetKey: declaration.documentAssetKey,
            reason: 'declaration-document-mismatch',
          },
        ),
      );
      return;
    }
    const existing = declarationBySlot.get(key);
    if (
      existing !== undefined &&
      existing.documentAssetKey !== declaration.documentAssetKey
    ) {
      issues.push(
        makeIssue(
          'error',
          'TRANSCRIPT_INVALID',
          'a lesson/language may declare at most one spoken-script document',
          { path },
          {
            lessonCode: declaration.lessonCode,
            language: declaration.language,
            first: existing.documentAssetKey,
            second: declaration.documentAssetKey,
            reason: 'declaration-conflict',
          },
        ),
      );
      return;
    }
    declarationBySlot.set(key, declaration);
  });

  (input.transcripts ?? []).forEach((artifact, index) => {
    const path = `transcripts[${index}]`;
    const fail = (message: string, reason: string, extra = {}): void => {
      issues.push(
        makeIssue(
          'error',
          'TRANSCRIPT_INVALID',
          message,
          { path },
          {
            sourceKind: artifact.sourceKind,
            assetKey: artifact.assetKey,
            language: artifact.language,
            reason,
            ...extra,
          },
        ),
      );
    };

    if (
      artifact.sourceKind !== 'asr' &&
      artifact.sourceKind !== 'forced-alignment'
    ) {
      fail(
        'transcript sourceKind must be asr or forced-alignment',
        'invalid-source-kind',
      );
      return;
    }
    for (const [field, value] of [
      ['sourceArtifact', artifact.sourceArtifact],
      ['modelVersion', artifact.modelVersion],
      ['ruleVersion', artifact.ruleVersion],
    ] as const) {
      if (typeof value !== 'string' || value.trim() === '') {
        fail(`transcript ${field} must be a non-empty string`, 'missing-pin', {
          field,
        });
        return;
      }
    }
    if (!isPlainObject(artifact.params)) {
      fail('transcript params must be a JSON object', 'invalid-params');
      return;
    }
    for (const [name, value] of Object.entries(artifact.params)) {
      if (!isParamValue(value)) {
        fail(
          'transcript params values must be JSON scalars',
          'invalid-params',
          {
            param: name,
          },
        );
        return;
      }
    }

    const videoRow = videoRowByAsset.get(artifact.assetKey);
    if (videoRow === undefined) {
      fail(
        'transcript assetKey must reference a video carrier declared in the Media sheet',
        'unknown-asset',
      );
      return;
    }
    if (
      videoRow.value.language !== null &&
      videoRow.value.language !== artifact.language
    ) {
      fail(
        'transcript language must equal the language of its video carrier',
        'language-mismatch',
        { carrierLanguage: videoRow.value.language },
      );
      return;
    }

    const slotKey = transcriptSlotKey(artifact.assetKey, artifact.language);

    if (artifact.sourceKind === 'forced-alignment') {
      const lessonKey = `${videoRow.value.lesson_code ?? ''}\u0000${artifact.language}`;
      const declaration = declarationBySlot.get(lessonKey);
      if (declaration === undefined) {
        fail(
          'forced alignment is only allowed when the lesson explicitly declares its text script as the spoken script',
          'forced-alignment-not-declared',
        );
        return;
      }
      if (artifact.documentAssetKey !== declaration.documentAssetKey) {
        fail(
          'forced-alignment artifact must align the declared spoken-script document',
          'forced-alignment-document-mismatch',
          { declared: declaration.documentAssetKey },
        );
        return;
      }
      if (forcedBySlot.has(slotKey)) {
        issues.push(
          makeIssue(
            'error',
            'TIMING_AMBIGUOUS',
            'more than one forced-alignment artifact exists for the same video/language',
            { path },
            {
              assetKey: artifact.assetKey,
              language: artifact.language,
              reason: 'duplicate-forced-alignment',
            },
          ),
        );
        return;
      }
      forcedBySlot.set(slotKey, { artifact, index });
    } else {
      if (asrBySlot.has(slotKey)) {
        issues.push(
          makeIssue(
            'error',
            'TIMING_AMBIGUOUS',
            'more than one ASR transcript exists for the same video/language',
            { path },
            {
              assetKey: artifact.assetKey,
              language: artifact.language,
              reason: 'duplicate-asr',
            },
          ),
        );
        return;
      }
      asrBySlot.set(slotKey, { artifact, index });
    }

    if (!isCueArray(artifact.cues)) {
      fail('transcript cues must be an array', 'invalid-cues');
      return;
    }

    artifact.cues.forEach((cue, cueIndex) => {
      const cuePath = `${path}.cues[${cueIndex}]`;
      if (
        !Number.isInteger(cue.startMs) ||
        !Number.isInteger(cue.endMs) ||
        cue.startMs < 0 ||
        cue.endMs <= cue.startMs
      ) {
        issues.push(
          makeIssue(
            'error',
            'TIMING_RANGE_INVALID',
            'transcript cue must satisfy 0 <= startMs < endMs (integer milliseconds)',
            { path: cuePath },
            {
              sourceKind: artifact.sourceKind,
              assetKey: artifact.assetKey,
              language: artifact.language,
              startMs: cue.startMs,
              endMs: cue.endMs,
            },
          ),
        );
      }
      if (
        typeof cue.confidence !== 'number' ||
        !Number.isFinite(cue.confidence) ||
        cue.confidence < 0 ||
        cue.confidence > 1
      ) {
        issues.push(
          makeIssue(
            'error',
            'TRANSCRIPT_INVALID',
            'transcript cue confidence must be a number in [0, 1]',
            { path: cuePath },
            {
              sourceKind: artifact.sourceKind,
              assetKey: artifact.assetKey,
              language: artifact.language,
              confidence: cue.confidence,
              reason: 'invalid-confidence',
            },
          ),
        );
      }
    });

    if (artifact.cues.length === 0) {
      issues.push(
        makeIssue(
          'incomplete',
          'TIMING_SOURCE_MISSING',
          'transcript artifact contains no cues (no derivable time source)',
          { path },
          {
            sourceKind: artifact.sourceKind,
            assetKey: artifact.assetKey,
            language: artifact.language,
            reason: 'transcript-empty',
          },
        ),
      );
    }
  });

  return { asrBySlot, forcedBySlot, declarationBySlot };
}

interface PendingPointAnchor {
  readonly lpRow: TypedRow<LearningPointRow>;
  readonly startMs: number;
  readonly chapterTitle: string;
  readonly durationMs: number;
  readonly provenance: TimingProvenance;
}

/**
 * P3 deriveTiming：从机器来源派生全部 LP/触发的半开区间与审计报告。
 * 只在 VIDEO（asset carrier）上派生媒体时间锚点；DOCX Heading 派生 document 坐标。
 * 时间源优先级：字幕 > 章节 > ASR > 强制对齐（每语言独立）。
 */
export function deriveTiming(input: TimingDerivationInput): TimingResult {
  const { ir, rows } = input;
  const issues: CompilerIssue[] = [];
  const coordinates: TimingCoordinate[] = [];
  const assets: TimingAssetInfo[] = [];

  const documents = new Map<string, DocumentStructureInput>();
  for (const document of input.documents ?? []) {
    documents.set(document.assetKey, document);
  }

  const mediaIndex = indexMedia(rows);
  const transcriptIndex = indexTranscriptArtifacts(input, issues);
  const declaredLanguages = [...ir.course.learningLanguages];

  const courseLessons = [
    ...new Set(rows.lessons.map((row) => row.value.lesson_code)),
  ].sort();

  for (const lessonCode of courseLessons) {
    for (const language of declaredLanguages) {
      deriveSlot({
        ir,
        rows,
        issues,
        coordinates,
        assets,
        mediaIndex,
        transcriptIndex,
        documents,
        lessonCode,
        language,
      });
    }
  }

  coordinates.sort(compareCoordinates);
  const audit = coordinates.map(toAuditEntry);

  assertAsrProvenance(ir, coordinates, issues);

  return {
    ruleVersion: TIMING_RULE_VERSION,
    parameters: TIMING_RULE_PARAMETERS,
    coordinates,
    audit,
    assets: assets.sort((a, b) =>
      a.assetKey < b.assetKey ? -1 : a.assetKey > b.assetKey ? 1 : 0,
    ),
    provenance: collectSourcePins(coordinates),
    issues,
  };
}

/**
 * C10.6/T4：manifest.provenance.asr 存在时，必须与实际使用的 ASR 派生工件一致。
 * 只比较实际产出坐标的工件；不一致 → PROVENANCE_MISMATCH（error，不静默）。
 */
function assertAsrProvenance(
  ir: PackageIR,
  coordinates: readonly TimingCoordinate[],
  issues: CompilerIssue[],
): void {
  const declared = ir.provenance?.asr;
  if (declared === undefined) return;
  const usedAsrArtifacts = new Map<string, TimingProvenance>();
  for (const coordinate of coordinates) {
    const provenance = coordinate.provenance;
    if (provenance.sourceKind !== 'asr') continue;
    usedAsrArtifacts.set(provenance.sourceArtifact, provenance);
  }
  const declaredParams = canonicalJson(declared.params);
  for (const [sourceArtifact, provenance] of [...usedAsrArtifacts].sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  )) {
    const matches =
      provenance.modelVersion === declared.modelVersion &&
      provenance.ruleVersion === declared.ruleVersion &&
      canonicalJson(provenance.params ?? {}) === declaredParams;
    if (!matches) {
      issues.push(
        makeIssue(
          'error',
          'PROVENANCE_MISMATCH',
          'manifest.provenance.asr does not match the ASR artifact used for timing derivation',
          { path: 'provenance.asr' },
          {
            sourceArtifact,
            declared: {
              modelVersion: declared.modelVersion,
              params: declared.params,
              ruleVersion: declared.ruleVersion,
            },
            derived: {
              modelVersion: provenance.modelVersion,
              params: provenance.params,
              ruleVersion: provenance.ruleVersion,
            },
          },
        ),
      );
    }
  }
}

function collectSourcePins(
  coordinates: readonly TimingCoordinate[],
): TimingSourcePin[] {
  const byKey = new Map<string, TimingSourcePin>();
  for (const coordinate of coordinates) {
    const pin: TimingSourcePin = {
      sourceKind: coordinate.provenance.sourceKind,
      sourceArtifact: coordinate.provenance.sourceArtifact,
      ...(coordinate.provenance.modelVersion === undefined
        ? {}
        : { modelVersion: coordinate.provenance.modelVersion }),
      ...(coordinate.provenance.params === undefined
        ? {}
        : { params: coordinate.provenance.params }),
      ruleVersion: coordinate.provenance.ruleVersion,
    };
    byKey.set(canonicalJson(pin), pin);
  }
  return [...byKey.values()].sort((left, right) => {
    const leftKey = canonicalJson(left);
    const rightKey = canonicalJson(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function compareCoordinates(a: TimingCoordinate, b: TimingCoordinate): number {
  const left = [
    a.lessonCode,
    a.language,
    a.kind,
    a.code,
    a.occurrenceKey,
    a.carrierType,
    a.carrierKey,
  ].join('\u0000');
  const right = [
    b.lessonCode,
    b.language,
    b.kind,
    b.code,
    b.occurrenceKey,
    b.carrierType,
    b.carrierKey,
  ].join('\u0000');
  return left < right ? -1 : left > right ? 1 : 0;
}

function toAuditEntry(coordinate: TimingCoordinate): TimingAuditEntry {
  return {
    lessonCode: coordinate.lessonCode,
    language: coordinate.language,
    kind: coordinate.kind,
    code: coordinate.code,
    occurrenceKey: coordinate.occurrenceKey,
    carrierType: coordinate.carrierType,
    carrierKey: coordinate.carrierKey,
    startMs: coordinate.startMs,
    startFormatted:
      coordinate.startMs === undefined
        ? undefined
        : formatTimecode(coordinate.startMs),
    endMs: coordinate.endMs,
    endFormatted:
      coordinate.endMs === undefined
        ? undefined
        : formatTimecode(coordinate.endMs),
    headingCode: coordinate.headingCode,
    anchorSource: coordinate.anchorSource,
    sourceKind: coordinate.provenance.sourceKind,
    sourceArtifact: coordinate.provenance.sourceArtifact,
    ...(coordinate.provenance.modelVersion === undefined
      ? {}
      : { modelVersion: coordinate.provenance.modelVersion }),
    ...(coordinate.provenance.params === undefined
      ? {}
      : { params: coordinate.provenance.params }),
    ruleVersion: coordinate.provenance.ruleVersion,
    ...(coordinate.confidence === undefined
      ? {}
      : { confidence: coordinate.confidence }),
    nearbyText: coordinate.nearbyText,
  };
}

interface SlotContext {
  readonly ir: PackageIR;
  readonly rows: ValidatedRows;
  readonly issues: CompilerIssue[];
  readonly coordinates: TimingCoordinate[];
  readonly assets: TimingAssetInfo[];
  readonly mediaIndex: Map<string, TypedRow<MediaRow>>;
  readonly transcriptIndex: TranscriptIndex;
  readonly documents: Map<string, DocumentStructureInput>;
  readonly lessonCode: string;
  readonly language: string;
}

function deriveSlot(context: SlotContext): void {
  const {
    ir,
    rows,
    issues,
    coordinates,
    assets,
    mediaIndex,
    transcriptIndex,
    documents,
    lessonCode,
    language,
  } = context;

  const lpRows = rows.learningPoints.filter(
    (row) =>
      row.value.lesson_code === lessonCode && row.value.language === language,
  );
  const videoRow = mediaIndex.get(mediaSlotKey('video', lessonCode, language));
  const subtitleRow = mediaIndex.get(
    mediaSlotKey('subtitle', lessonCode, language),
  );
  const chaptersRow = mediaIndex.get(
    mediaSlotKey('chapters', lessonCode, language),
  );
  const documentRow = mediaIndex.get(
    mediaSlotKey('lesson-text', lessonCode, language),
  );
  const documentStructure =
    documentRow === undefined
      ? undefined
      : documents.get(documentRow.value.asset_key);

  const markers = documentStructure?.triggerMarkers ?? [];
  if (lpRows.length === 0 && markers.length === 0) return;

  let durationMs: number | null = null;
  let subtitleCues: SubtitleCue[] = [];
  let chapterCues: ChapterCue[] = [];
  let videoBytes: Uint8Array | undefined;

  if (videoRow !== undefined) {
    videoBytes = ir.files.get(videoRow.value.relative_path);
    if (videoBytes === undefined) {
      issues.push(
        makeIssue(
          'error',
          'TIMING_SOURCE_MISSING',
          'video bytes are missing from the closed package file set',
          mediaSource(videoRow, 'relative_path'),
          { lessonCode, language, reason: 'video-bytes-missing' },
        ),
      );
    } else {
      durationMs = probeMp4DurationMs(videoBytes);
      if (durationMs === null) {
        issues.push(
          makeIssue(
            'error',
            'TIMING_SOURCE_MISSING',
            'container duration probe failed; timing validation cannot run',
            mediaSource(videoRow, 'relative_path'),
            { lessonCode, language, reason: 'duration-unavailable' },
          ),
        );
      }
    }
  }

  if (subtitleRow !== undefined) {
    const bytes = ir.files.get(subtitleRow.value.relative_path);
    if (bytes === undefined) {
      issues.push(
        makeIssue(
          'error',
          'TIMING_SOURCE_MISSING',
          'subtitle bytes are missing from the closed package file set',
          mediaSource(subtitleRow, 'relative_path'),
          { lessonCode, language, reason: 'subtitle-bytes-missing' },
        ),
      );
    } else {
      const source = decodeUtf8(bytes);
      const extensionIsVtt = /\.vtt$/i.test(subtitleRow.value.relative_path);
      try {
        subtitleCues = parseSubtitleCues(
          source,
          extensionIsVtt ? 'vtt' : 'auto',
        );
      } catch (error) {
        const line =
          error instanceof SubtitleSyntaxError ? error.line : undefined;
        issues.push(
          makeIssue(
            'error',
            'TIMING_SOURCE_MISSING',
            'subtitle could not be parsed into cues',
            {
              ...(mediaSource(subtitleRow, 'relative_path') ?? {}),
              ...(line === undefined ? {} : { line }),
            },
            {
              lessonCode,
              language,
              reason: 'invalid-subtitle',
              detail: error instanceof Error ? error.message : String(error),
            },
          ),
        );
      }
      if (subtitleCues.length === 0 && videoRow !== undefined) {
        issues.push(
          makeIssue(
            'error',
            'TIMING_SOURCE_MISSING',
            'subtitle file contains no cues',
            mediaSource(subtitleRow, 'relative_path'),
            { lessonCode, language, reason: 'subtitle-empty' },
          ),
        );
      }
    }
  }

  let chapterSource: 'track' | 'json' | null = null;
  if (chaptersRow !== undefined) {
    const bytes = ir.files.get(chaptersRow.value.relative_path);
    if (bytes === undefined) {
      issues.push(
        makeIssue(
          'error',
          'TIMING_SOURCE_MISSING',
          'chapters JSON is missing from the closed package file set',
          mediaSource(chaptersRow, 'relative_path'),
          { lessonCode, language, reason: 'chapters-bytes-missing' },
        ),
      );
    } else {
      try {
        chapterCues = parseChaptersJson(
          JSON.parse(decodeUtf8(bytes)) as unknown,
        );
        chapterSource = 'json';
      } catch (error) {
        issues.push(
          makeIssue(
            'error',
            'TIMING_SOURCE_MISSING',
            'chapters JSON could not be parsed',
            mediaSource(chaptersRow, 'relative_path'),
            {
              lessonCode,
              language,
              reason: 'invalid-chapters',
              detail: error instanceof Error ? error.message : String(error),
            },
          ),
        );
      }
    }
  } else if (videoBytes !== undefined) {
    chapterCues = extractMp4Chapters(videoBytes);
    if (chapterCues.length > 0) chapterSource = 'track';
  }

  if (videoRow !== undefined) {
    assets.push({
      assetKey: videoRow.value.asset_key,
      durationMs,
      chapterSource,
    });
  }

  if (
    videoRow === undefined &&
    (subtitleRow !== undefined || chaptersRow !== undefined)
  ) {
    // 字幕/章节只能派生于视频载体；无视频时它们是孤立交付物（不猜、不忽略）。
    if (subtitleRow !== undefined) {
      issues.push(
        makeIssue(
          'error',
          'TIMING_SOURCE_MISSING',
          'subtitle is declared without a lesson video carrier',
          mediaSource(subtitleRow, 'relative_path'),
          { lessonCode, language, reason: 'subtitle-without-video' },
        ),
      );
    }
  }

  if (documentRow !== undefined && documentStructure === undefined) {
    issues.push(
      makeIssue(
        'incomplete',
        'TIMING_SOURCE_MISSING',
        'DOCX structure is not available for this lesson document (text anchors missing)',
        mediaSource(documentRow, 'relative_path'),
        { lessonCode, language, reason: 'document-structure-unavailable' },
      ),
    );
  }
  if (
    documentStructure !== undefined &&
    (documentStructure.lessonCode !== lessonCode ||
      documentStructure.language !== language)
  ) {
    issues.push(
      makeIssue(
        'error',
        'TIMING_SOURCE_MISSING',
        'DOCX structure does not match the media row lesson/language binding',
        mediaSource(documentRow, 'asset_key'),
        {
          lessonCode,
          language,
          reason: 'document-structure-mismatch',
          structureLesson: documentStructure.lessonCode,
          structureLanguage: documentStructure.language,
        },
      ),
    );
  }

  // 媒体时间源优先级（C7）：字幕 > 章节 > ASR > 强制对齐；每语言独立。
  const videoAssetKey = videoRow?.value.asset_key;
  const asrEntry =
    videoAssetKey === undefined
      ? undefined
      : transcriptIndex.asrBySlot.get(
          transcriptSlotKey(videoAssetKey, language),
        );
  const forcedEntry =
    videoAssetKey === undefined
      ? undefined
      : transcriptIndex.forcedBySlot.get(
          transcriptSlotKey(videoAssetKey, language),
        );
  const attempts = buildSourceAttempts({
    videoAssetKey,
    subtitleRow,
    subtitleCues,
    chaptersRow,
    chapterSource,
    chapterCues,
    asrEntry,
    forcedEntry,
  });

  const pendingPoints: PendingPointAnchor[] = [];

  for (const lpRow of lpRows) {
    const lp = lpRow.value;
    let videoAnchorDerived = false;

    if (videoRow !== undefined) {
      const needle = normalizeForMatch(lp.title);
      for (const attempt of attempts) {
        const matches = matchAgainst(attempt.cues, (cue) => cue.text, needle);
        if (matches.length === 0) continue;
        if (matches.length > 1) {
          issues.push(
            makeIssue(
              'error',
              'TIMING_AMBIGUOUS',
              `learning point title matches more than one ${attempt.label}`,
              {
                sheet: 'Learning Points',
                row: lpRow.rowNumber,
                column: 'title',
              },
              {
                lessonCode,
                language,
                lpCode: lp.lp_code,
                sourceKind: attempt.sourceKind,
                sourceArtifact: attempt.provenance.sourceArtifact,
                matches: matches.map((index) => attempt.cues[index].text),
              },
            ),
          );
          videoAnchorDerived = true;
          break;
        }
        const cue = attempt.cues[matches[0]];
        if (attempt.sourceKind === 'chapter') {
          // 章节是点锚点：按 C7 规则在 expandPointAnchors 中展开为 [start,end)
          // （end = 同一载体下一个锚点 - 1ms，否则 duration），不使用章节轨的
          // 隐含区间端点。
          pendingPoints.push({
            lpRow,
            startMs: cue.startMs,
            chapterTitle: cue.text,
            durationMs: durationMs ?? 0,
            provenance: attempt.provenance,
          });
          videoAnchorDerived = true;
          break;
        }
        if (cue.endMs === undefined) {
          issues.push(
            makeIssue(
              'error',
              'TRANSCRIPT_INVALID',
              'transcript cue has no end time; [start,end) cannot be derived',
              attempt.sourceCoordinate,
              {
                lessonCode,
                language,
                lpCode: lp.lp_code,
                sourceKind: attempt.sourceKind,
                sourceArtifact: attempt.provenance.sourceArtifact,
                startMs: cue.startMs,
              },
            ),
          );
          videoAnchorDerived = true;
          break;
        }
        const interval = validateCueInterval(
          { startMs: cue.startMs, endMs: cue.endMs },
          durationMs,
          attempt.sourceCoordinate,
          lessonCode,
          language,
          issues,
          {
            sourceKind: attempt.sourceKind,
            sourceArtifact: attempt.provenance.sourceArtifact,
          },
        );
        if (interval === null) {
          videoAnchorDerived = true;
          break;
        }
        pushLowConfidenceIssue(
          issues,
          attempt,
          cue.confidence,
          {
            sheet: 'Learning Points',
            row: lpRow.rowNumber,
            column: 'title',
          },
          { lessonCode, language, lpCode: lp.lp_code },
        );
        coordinates.push({
          lessonCode,
          language,
          kind: 'lp',
          code: lp.lp_code,
          occurrenceKey: `lp.${lp.lp_code}`,
          carrierType: 'asset',
          carrierKey: videoRow.value.asset_key,
          startMs: interval.startMs,
          endMs: interval.endMs,
          anchorSource: attempt.sourceKind,
          source: attempt.sourceKind,
          provenance: attempt.provenance,
          ...(cue.confidence === undefined
            ? {}
            : { confidence: cue.confidence }),
          nearbyText: clampText(cue.text),
        });
        videoAnchorDerived = true;
        break;
      }

      if (!videoAnchorDerived) {
        issues.push(
          makeIssue(
            'incomplete',
            'TIMING_SOURCE_MISSING',
            'learning point has a video carrier but no machine timing source matches (subtitle/chapter/ASR/forced-alignment)',
            {
              sheet: 'Learning Points',
              row: lpRow.rowNumber,
              column: 'title',
            },
            {
              lessonCode,
              language,
              lpCode: lp.lp_code,
              reason:
                attempts.length === 0 ? 'no-timing-source' : 'no-anchor-match',
              availableSources: attempts.map((attempt) => attempt.sourceKind),
            },
          ),
        );
      }
    }

    // 文本锚点（DOCX Heading）：视频 LP 同样派生 text rendition（同一 stage 双坐标）。
    if (documentStructure !== undefined) {
      const matches = matchHeading(
        documentStructure.headings,
        lp.lp_code,
        lp.title,
      );
      if (matches.length === 1) {
        const heading = documentStructure.headings[matches[0]];
        const headingAssetKey =
          documentRow?.value.asset_key ?? documentStructure.assetKey;
        coordinates.push({
          lessonCode,
          language,
          kind: 'lp',
          code: lp.lp_code,
          occurrenceKey: `lp.${lp.lp_code}`,
          carrierType: 'document',
          carrierKey: headingAssetKey,
          ...(heading.offset === undefined ? {} : { offset: heading.offset }),
          headingCode: heading.headingCode,
          anchorSource: 'doc-structure',
          source: 'doc-structure',
          provenance: {
            sourceKind: 'doc-structure',
            sourceArtifact: headingAssetKey,
            ruleVersion: TIMING_RULE_VERSION,
          },
          nearbyText: clampText(heading.title),
        });
      } else if (matches.length > 1) {
        issues.push(
          makeIssue(
            'error',
            'TIMING_AMBIGUOUS',
            'learning point matches more than one DOCX heading',
            { sheet: 'Learning Points', row: lpRow.rowNumber, column: 'title' },
            { lessonCode, language, lpCode: lp.lp_code },
          ),
        );
      } else if (videoRow === undefined) {
        issues.push(
          makeIssue(
            'incomplete',
            'TIMING_SOURCE_MISSING',
            'learning point has neither a video anchor nor a matching DOCX heading',
            { sheet: 'Learning Points', row: lpRow.rowNumber, column: 'title' },
            {
              lessonCode,
              language,
              lpCode: lp.lp_code,
              reason: 'no-anchor-source',
            },
          ),
        );
      } else {
        issues.push(
          makeIssue(
            'incomplete',
            'TIMING_SOURCE_MISSING',
            'text-mode rendition is missing because no DOCX heading matches this learning point',
            { sheet: 'Learning Points', row: lpRow.rowNumber, column: 'title' },
            {
              lessonCode,
              language,
              lpCode: lp.lp_code,
              reason: 'heading-unmatched',
            },
          ),
        );
      }
    } else if (videoRow === undefined) {
      issues.push(
        makeIssue(
          'incomplete',
          'TIMING_SOURCE_MISSING',
          'learning point has no derivable anchor source (no video, no DOCX structure)',
          { sheet: 'Learning Points', row: lpRow.rowNumber, column: 'title' },
          {
            lessonCode,
            language,
            lpCode: lp.lp_code,
            reason: 'no-anchor-source',
          },
        ),
      );
    }
  }

  expandPointAnchors(pendingPoints, {
    issues,
    coordinates,
    videoRow,
    lessonCode,
    language,
  });

  if (markers.length > 0) {
    deriveTriggers({
      rows,
      issues,
      coordinates,
      lessonCode,
      language,
      videoRow,
      documentStructure,
      attempts,
      durationMs,
    });
  }
}

// ---------------------------------------------------------------------------
// 时间源候选（优先级链）与匹配（C7）
// ---------------------------------------------------------------------------

interface SourceCue {
  readonly startMs: number;
  readonly endMs?: number;
  readonly text: string;
  readonly confidence?: number;
}

interface SourceAttempt {
  readonly sourceKind: 'subtitle' | 'chapter' | 'asr' | 'forced-alignment';
  readonly label: string;
  readonly cues: readonly SourceCue[];
  readonly provenance: TimingProvenance;
  readonly sourceCoordinate: SourceCoordinate | undefined;
}

function buildSourceAttempts(args: {
  readonly videoAssetKey: string | undefined;
  readonly subtitleRow: TypedRow<MediaRow> | undefined;
  readonly subtitleCues: readonly SubtitleCue[];
  readonly chaptersRow: TypedRow<MediaRow> | undefined;
  readonly chapterSource: 'track' | 'json' | null;
  readonly chapterCues: readonly ChapterCue[];
  readonly asrEntry: IndexedTranscriptArtifact | undefined;
  readonly forcedEntry: IndexedTranscriptArtifact | undefined;
}): SourceAttempt[] {
  const attempts: SourceAttempt[] = [];
  const {
    videoAssetKey,
    subtitleRow,
    subtitleCues,
    chaptersRow,
    chapterSource,
    chapterCues,
    asrEntry,
    forcedEntry,
  } = args;

  if (subtitleRow !== undefined && subtitleCues.length > 0) {
    attempts.push({
      sourceKind: 'subtitle',
      label: 'subtitle cue',
      cues: subtitleCues,
      provenance: {
        sourceKind: 'subtitle',
        sourceArtifact: subtitleRow.value.relative_path,
        ruleVersion: TIMING_RULE_VERSION,
      },
      sourceCoordinate: mediaSource(subtitleRow, 'relative_path'),
    });
  }

  if (chapterCues.length > 0) {
    const sourceArtifact =
      chapterSource === 'json' && chaptersRow !== undefined
        ? chaptersRow.value.relative_path
        : `asset:${videoAssetKey ?? ''}#chapter-track`;
    attempts.push({
      sourceKind: 'chapter',
      label: 'chapter',
      cues: chapterCues.map((cue) => ({
        startMs: cue.startMs,
        ...(cue.endMs === undefined ? {} : { endMs: cue.endMs }),
        text: cue.title,
      })),
      provenance: {
        sourceKind: 'chapter',
        sourceArtifact,
        ruleVersion: TIMING_RULE_VERSION,
      },
      sourceCoordinate:
        chapterSource === 'json'
          ? mediaSource(chaptersRow, 'relative_path')
          : undefined,
    });
  }

  if (asrEntry !== undefined) {
    attempts.push(transcriptAttempt(asrEntry, 'ASR transcript cue'));
  }
  if (forcedEntry !== undefined) {
    attempts.push(transcriptAttempt(forcedEntry, 'forced-alignment cue'));
  }
  return attempts;
}

function transcriptAttempt(
  entry: IndexedTranscriptArtifact,
  label: string,
): SourceAttempt {
  const artifact = entry.artifact;
  return {
    sourceKind: artifact.sourceKind,
    label,
    cues: artifact.cues.map((cue) => ({
      startMs: cue.startMs,
      endMs: cue.endMs,
      text: cue.text,
      confidence: cue.confidence,
    })),
    provenance: {
      sourceKind: artifact.sourceKind,
      sourceArtifact: artifact.sourceArtifact,
      modelVersion: artifact.modelVersion,
      params: artifact.params,
      ruleVersion: artifact.ruleVersion,
    },
    sourceCoordinate: { path: `transcripts[${entry.index}]` },
  };
}

/**
 * ASR / 强制对齐的低置信度判定（C7/ALN-7）：低于参数阈值 → incomplete，
 * 阶段 blocked；坐标仍产出供 Sandbox 播放复核（人工复核，不输入时间）。
 */
function pushLowConfidenceIssue(
  issues: CompilerIssue[],
  attempt: SourceAttempt,
  confidence: number | undefined,
  source: SourceCoordinate,
  details: Record<string, unknown>,
): void {
  if (confidence === undefined) return;
  if (
    attempt.sourceKind !== 'asr' &&
    attempt.sourceKind !== 'forced-alignment'
  ) {
    return;
  }
  const threshold = TIMING_RULE_PARAMETERS.minTranscriptConfidence;
  if (confidence >= threshold) return;
  issues.push(
    makeIssue(
      'incomplete',
      'ALIGNMENT_LOW_CONFIDENCE',
      `${attempt.label} confidence is below the rule threshold; the stage is blocked pending review`,
      source,
      {
        ...details,
        sourceKind: attempt.sourceKind,
        sourceArtifact: attempt.provenance.sourceArtifact,
        modelVersion: attempt.provenance.modelVersion,
        confidence,
        threshold,
      },
    ),
  );
}

function matchHeading(
  headings: readonly DocumentHeadingInput[],
  lpCode: string,
  title: string,
): number[] {
  const byCode = headings
    .map((heading, index) => ({ heading, index }))
    .filter(({ heading }) => heading.headingCode === lpCode)
    .map(({ index }) => index);
  if (byCode.length > 0) return byCode;
  return matchAgainst(
    headings,
    (heading) => heading.title,
    normalizeForMatch(title),
  );
}

function validateCueInterval(
  cue: { startMs: number; endMs: number },
  durationMs: number | null,
  source: SourceCoordinate | undefined,
  lessonCode: string,
  language: string,
  issues: CompilerIssue[],
  details: Record<string, unknown> = {},
): { startMs: number; endMs: number } | null {
  if (durationMs === null) return null;
  const valid =
    cue.startMs >= 0 &&
    cue.endMs > cue.startMs &&
    cue.startMs < durationMs &&
    cue.endMs <= durationMs;
  if (!valid) {
    issues.push(
      makeIssue(
        'error',
        'TIMING_RANGE_INVALID',
        'cue interval violates 0 <= startMs < endMs <= durationMs',
        source,
        {
          lessonCode,
          language,
          startMs: cue.startMs,
          endMs: cue.endMs,
          durationMs,
          ...details,
        },
      ),
    );
    return null;
  }
  return { startMs: cue.startMs, endMs: cue.endMs };
}

function expandPointAnchors(
  points: readonly PendingPointAnchor[],
  context: {
    readonly issues: CompilerIssue[];
    readonly coordinates: TimingCoordinate[];
    readonly videoRow: TypedRow<MediaRow> | undefined;
    readonly lessonCode: string;
    readonly language: string;
  },
): void {
  const { issues, coordinates, videoRow, lessonCode, language } = context;
  if (points.length === 0) return;
  const ordered = [...points].sort((a, b) =>
    a.startMs !== b.startMs
      ? a.startMs - b.startMs
      : a.lpRow.value.lp_code < b.lpRow.value.lp_code
        ? -1
        : 1,
  );
  const carrierKey = videoRow?.value.asset_key ?? '';
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    const durationMs = current.durationMs;
    const next = ordered[index + 1];
    if (durationMs <= 0) continue; // duration 不可用已单独报 error
    if (current.startMs < 0 || current.startMs >= durationMs) {
      issues.push(
        makeIssue(
          'error',
          'TIMING_RANGE_INVALID',
          'point anchor startMs violates 0 <= startMs < durationMs',
          {
            sheet: 'Learning Points',
            row: current.lpRow.rowNumber,
            column: 'title',
          },
          {
            lessonCode,
            language,
            lpCode: current.lpRow.value.lp_code,
            startMs: current.startMs,
            durationMs,
          },
        ),
      );
      continue;
    }
    let endMs: number;
    if (next !== undefined) {
      if (next.startMs <= current.startMs) {
        issues.push(
          makeIssue(
            'error',
            'TIMING_RANGE_INVALID',
            'point anchors must have distinct start times for [start,end) expansion',
            {
              sheet: 'Learning Points',
              row: current.lpRow.rowNumber,
              column: 'title',
            },
            {
              lessonCode,
              language,
              lpCode: current.lpRow.value.lp_code,
              startMs: current.startMs,
              nextStartMs: next.startMs,
            },
          ),
        );
        continue;
      }
      endMs = next.startMs - 1;
    } else {
      endMs = durationMs;
    }
    if (endMs <= current.startMs || endMs > durationMs) {
      issues.push(
        makeIssue(
          'error',
          'TIMING_RANGE_INVALID',
          'expanded point-anchor interval violates 0 <= start < end <= duration',
          {
            sheet: 'Learning Points',
            row: current.lpRow.rowNumber,
            column: 'title',
          },
          {
            lessonCode,
            language,
            lpCode: current.lpRow.value.lp_code,
            startMs: current.startMs,
            endMs,
            durationMs,
          },
        ),
      );
      continue;
    }
    const windowMs = endMs - current.startMs;
    if (windowMs < TIMING_RULE_PARAMETERS.minWindowMs) {
      issues.push(
        makeIssue(
          'error',
          'TIMING_RANGE_INVALID',
          'expanded point-anchor window is below the rule minimum',
          {
            sheet: 'Learning Points',
            row: current.lpRow.rowNumber,
            column: 'title',
          },
          {
            lessonCode,
            language,
            lpCode: current.lpRow.value.lp_code,
            windowMs,
            minWindowMs: TIMING_RULE_PARAMETERS.minWindowMs,
          },
        ),
      );
      continue;
    }
    if (windowMs > TIMING_RULE_PARAMETERS.gapThresholdMs) {
      issues.push(
        makeIssue(
          'warning',
          'TIMING_WINDOW_LARGE',
          'point-anchor window exceeds the gap threshold (review the anchor)',
          {
            sheet: 'Learning Points',
            row: current.lpRow.rowNumber,
            column: 'title',
          },
          {
            lessonCode,
            language,
            lpCode: current.lpRow.value.lp_code,
            windowMs,
            gapThresholdMs: TIMING_RULE_PARAMETERS.gapThresholdMs,
          },
        ),
      );
    }
    if (windowMs > TIMING_RULE_PARAMETERS.maxWindowMs) {
      issues.push(
        makeIssue(
          'warning',
          'TIMING_WINDOW_LARGE',
          'point-anchor window exceeds the rule maximum',
          {
            sheet: 'Learning Points',
            row: current.lpRow.rowNumber,
            column: 'title',
          },
          {
            lessonCode,
            language,
            lpCode: current.lpRow.value.lp_code,
            windowMs,
            maxWindowMs: TIMING_RULE_PARAMETERS.maxWindowMs,
          },
        ),
      );
    }
    coordinates.push({
      lessonCode,
      language,
      kind: 'lp',
      code: current.lpRow.value.lp_code,
      occurrenceKey: `lp.${current.lpRow.value.lp_code}`,
      carrierType: 'asset',
      carrierKey,
      startMs: current.startMs,
      endMs,
      anchorSource: 'chapter',
      source: 'chapter',
      provenance: current.provenance,
      nearbyText: clampText(current.chapterTitle),
    });
  }
}

function deriveTriggers(context: {
  readonly rows: ValidatedRows;
  readonly issues: CompilerIssue[];
  readonly coordinates: TimingCoordinate[];
  readonly lessonCode: string;
  readonly language: string;
  readonly videoRow: TypedRow<MediaRow> | undefined;
  readonly documentStructure: DocumentStructureInput | undefined;
  readonly attempts: readonly SourceAttempt[];
  readonly durationMs: number | null;
}): void {
  const {
    rows,
    issues,
    coordinates,
    lessonCode,
    language,
    videoRow,
    documentStructure,
    attempts,
    durationMs,
  } = context;
  const markers = documentStructure?.triggerMarkers ?? [];

  const exhibitIndex = new Map<string, TypedRow<ExhibitRow>>();
  for (const row of rows.exhibits) {
    if (
      row.value.lesson_code !== lessonCode ||
      row.value.language !== language
    ) {
      continue;
    }
    exhibitIndex.set(row.value.exhibit_code, row);
  }

  const occurrences = new Map<string, number>();
  const truthKeys = new Set<string>();

  markers.forEach((marker, markerIndex) => {
    const path = `documents.${documentStructure?.assetKey}.triggerMarkers[${markerIndex}]`;
    const exhibit = exhibitIndex.get(marker.exhibitCode);
    if (exhibit === undefined) {
      issues.push(
        makeIssue(
          'error',
          'TRIGGER_EXHIBIT_UNKNOWN',
          'trigger marker references an exhibit_code that this lesson/language does not declare',
          { path },
          { lessonCode, language, exhibitCode: marker.exhibitCode },
        ),
      );
      return;
    }
    if (videoRow === undefined) {
      issues.push(
        makeIssue(
          'error',
          'TIMING_SOURCE_MISSING',
          'exhibit trigger needs a lesson video carrier',
          { path },
          {
            lessonCode,
            language,
            exhibitCode: marker.exhibitCode,
            reason: 'trigger-without-video',
          },
        ),
      );
      return;
    }
    const needle = normalizeForMatch(stripExhibitMarkers(marker.lineText));
    if (needle === '') {
      issues.push(
        makeIssue(
          'error',
          'TIMING_SOURCE_MISSING',
          'trigger marker has no dialogue text to align',
          { path },
          {
            lessonCode,
            language,
            exhibitCode: marker.exhibitCode,
            reason: 'trigger-line-empty',
          },
        ),
      );
      return;
    }

    let resolved = false;
    for (const attempt of attempts) {
      const matches = matchAgainst(attempt.cues, (cue) => cue.text, needle);
      if (matches.length === 0) continue;
      if (matches.length > 1) {
        issues.push(
          makeIssue(
            'error',
            'TIMING_AMBIGUOUS',
            `trigger dialogue line matches more than one ${attempt.label}`,
            { path },
            {
              lessonCode,
              language,
              exhibitCode: marker.exhibitCode,
              sourceKind: attempt.sourceKind,
              sourceArtifact: attempt.provenance.sourceArtifact,
              matches: matches.map((index) => attempt.cues[index].text),
            },
          ),
        );
        resolved = true;
        break;
      }
      const cue = attempt.cues[matches[0]];
      if (attempt.sourceKind === 'chapter') {
        // 章节是点锚点：触发窗口从章节起点到视频结束（无同 stage 下一锚点上下文）。
        const endMs = durationMs ?? 0;
        if (
          durationMs === null ||
          cue.startMs < 0 ||
          cue.startMs >= durationMs ||
          endMs <= cue.startMs
        ) {
          issues.push(
            makeIssue(
              'error',
              'TIMING_RANGE_INVALID',
              'chapter anchor violates 0 <= startMs < endMs <= durationMs',
              { path },
              {
                lessonCode,
                language,
                exhibitCode: marker.exhibitCode,
                sourceKind: attempt.sourceKind,
                sourceArtifact: attempt.provenance.sourceArtifact,
                startMs: cue.startMs,
                durationMs,
              },
            ),
          );
          resolved = true;
          break;
        }
        addTriggerCoordinate({
          issues,
          coordinates,
          occurrences,
          truthKeys,
          path,
          lessonCode,
          language,
          videoAssetKey: videoRow.value.asset_key,
          marker,
          interval: { startMs: cue.startMs, endMs },
          nearbyText: clampText(cue.text),
          attempt,
          confidence: undefined,
        });
        resolved = true;
        break;
      }
      if (cue.endMs === undefined) {
        issues.push(
          makeIssue(
            'error',
            'TRANSCRIPT_INVALID',
            'transcript cue has no end time; [start,end) cannot be derived',
            attempt.sourceCoordinate,
            {
              lessonCode,
              language,
              exhibitCode: marker.exhibitCode,
              sourceKind: attempt.sourceKind,
              sourceArtifact: attempt.provenance.sourceArtifact,
              startMs: cue.startMs,
            },
          ),
        );
        resolved = true;
        break;
      }
      const interval = validateCueInterval(
        { startMs: cue.startMs, endMs: cue.endMs },
        durationMs,
        attempt.sourceCoordinate,
        lessonCode,
        language,
        issues,
        {
          exhibitCode: marker.exhibitCode,
          sourceKind: attempt.sourceKind,
          sourceArtifact: attempt.provenance.sourceArtifact,
        },
      );
      if (interval === null) {
        resolved = true;
        break;
      }
      pushLowConfidenceIssue(
        issues,
        attempt,
        cue.confidence,
        { path },
        { lessonCode, language, exhibitCode: marker.exhibitCode },
      );
      addTriggerCoordinate({
        issues,
        coordinates,
        occurrences,
        truthKeys,
        path,
        lessonCode,
        language,
        videoAssetKey: videoRow.value.asset_key,
        marker,
        interval,
        nearbyText: clampText(cue.text),
        attempt,
        confidence: cue.confidence,
      });
      resolved = true;
      break;
    }

    if (!resolved) {
      issues.push(
        makeIssue(
          'incomplete',
          'TIMING_SOURCE_MISSING',
          'trigger dialogue line matches no machine timing source (subtitle/chapter/ASR/forced-alignment)',
          { path },
          {
            lessonCode,
            language,
            exhibitCode: marker.exhibitCode,
            reason:
              attempts.length === 0
                ? 'no-timing-source'
                : 'trigger-line-unresolved',
            lineText: clampText(marker.lineText),
            availableSources: attempts.map((attempt) => attempt.sourceKind),
          },
        ),
      );
    }
  });
}

function addTriggerCoordinate(args: {
  readonly issues: CompilerIssue[];
  readonly coordinates: TimingCoordinate[];
  readonly occurrences: Map<string, number>;
  readonly truthKeys: Set<string>;
  readonly path: string;
  readonly lessonCode: string;
  readonly language: string;
  readonly videoAssetKey: string;
  readonly marker: TriggerMarkerInput;
  readonly interval: { startMs: number; endMs: number };
  readonly nearbyText: string;
  readonly attempt: SourceAttempt;
  readonly confidence: number | undefined;
}): void {
  const {
    issues,
    coordinates,
    occurrences,
    truthKeys,
    path,
    lessonCode,
    language,
    videoAssetKey,
    marker,
    interval,
    nearbyText,
    attempt,
    confidence,
  } = args;

  const truthKey = `${marker.exhibitCode}\u0000${interval.startMs}`;
  if (truthKeys.has(truthKey)) {
    issues.push(
      makeIssue(
        'error',
        'TIMING_AMBIGUOUS',
        'duplicate exhibit trigger truth key (lesson, exhibit, language, timeMs)',
        { path },
        {
          lessonCode,
          language,
          exhibitCode: marker.exhibitCode,
          startMs: interval.startMs,
        },
      ),
    );
    return;
  }
  truthKeys.add(truthKey);

  const occurrence = (occurrences.get(marker.exhibitCode) ?? 0) + 1;
  occurrences.set(marker.exhibitCode, occurrence);
  coordinates.push({
    lessonCode,
    language,
    kind: 'trigger',
    code: marker.exhibitCode,
    occurrenceKey: `trigger.${occurrence}`,
    carrierType: 'asset',
    carrierKey: videoAssetKey,
    startMs: interval.startMs,
    endMs: interval.endMs,
    anchorSource: attempt.sourceKind,
    source: attempt.sourceKind,
    provenance: attempt.provenance,
    ...(confidence === undefined ? {} : { confidence }),
    nearbyText,
  });
}
