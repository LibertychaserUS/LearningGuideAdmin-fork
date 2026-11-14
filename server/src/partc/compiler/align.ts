import {
  AlignmentSchema,
  BlockSchema,
  ContentSpecSchema,
  RenditionSchema,
  renditionBusinessKey,
} from '../contracts';
import type {
  Alignment,
  AlignmentRole,
  Block,
  BlockPayload,
  ContentSpec,
  Rendition,
} from '../contracts';
import type {
  CompilerIssue,
  IssueSeverity,
  PackageIR,
  SourceCoordinate,
} from './parse';
import type {
  DocumentStructureInput,
  TimingProvenance,
  TimingResult,
} from './derive-timing';
import type {
  ExhibitRow,
  LessonRow,
  TypedRow,
  ValidatedRows,
} from './validate';

/**
 * Part C 编译器 P4：从 Part B payload + 派生时间生成内容工件（设计 §14 C5 P4、C3、C4）。
 *
 * 产物（全部纯函数、确定性、无内容指纹、无环境 UUID）：
 * - ContentSpec/Block：每个 lesson 一主体 spec（contentKey=lesson_code，
 *   type=video|text），外加 reading / knowledge-test / application-test 三个可选的
 *   附属 spec（contentKey=`{lesson}.{kind}`）。blockId 稳定：video / body /
 *   exhibit code / reading.N / q.{order} / application。
 * - Rendition：由 TimingResult 的坐标 + 媒体绑定生成；业务键严格按 C3 八字段，
 *   renditionKey 由稳定字段拼接（不含 carrierVersion：资产换版保持逻辑身份，
 *   revision 递增），坐标单源（asset 只有 start/end，document 只有 heading/offset）。
 * - proposed Alignment：只从旧内容（manifest.content.alignments）重绑或显式
 *   bindingSeeds 生成；provenance 只会是 import/legacy，status 恒为 proposed
 *   （verified 必须有人签收，导入器不替人签）。blockId+anchorSig 不变 → rebound；
 *   锚点/载体变化 → stale（revision +1），并显式报告。
 * - 旧 spec（specPins 中未被本包派生的 contentKey）与旧 rendition 进入 superseded。
 *
 * 不猜：没有旧对齐也没有显式 seed 时，不生成任何 Alignment；stage 与内容的
 * 语义绑定必须由人/显式输入给出，机器只做导入重 bind。
 */

export const ALIGN_RULE_VERSION = 'align-rules-v1' as const;

// ---------------------------------------------------------------------------
// 输入/输出
// ---------------------------------------------------------------------------

export interface AlignmentSeed {
  readonly stageKey: string;
  readonly contentKey: string;
  readonly blockId?: string;
  readonly language?: string;
  readonly objectiveKey: string;
  readonly role: AlignmentRole;
  /** 导入派生的 provenance 只能是 import/legacy（C3：verified 必须人签）。 */
  readonly provenance?: 'import' | 'legacy';
}

export interface AlignOptions {
  /**
   * 包内 assetKey → 导入后分配的 assetVersion（资产落库层提供）。
   * 缺项即无法构建媒体坐标 → CONTENT_INCOMPLETE error（不猜版本）。
   */
  readonly assetVersions: Readonly<Record<string, number>>;
  /** 显式 stage↔内容绑定种子（新课程导入时由 Admin 阶段树/人工绑定提供）。 */
  readonly bindingSeeds?: readonly AlignmentSeed[];
}

export interface AlignInput {
  readonly ir: PackageIR;
  readonly rows: ValidatedRows;
  readonly timing: TimingResult;
  readonly documents?: readonly DocumentStructureInput[];
  readonly options: AlignOptions;
}

export type AlignmentRebind = 'new' | 'rebound' | 'stale';

export interface ProposedAlignment {
  readonly alignment: Alignment;
  readonly provenance: 'import' | 'legacy';
  /** P4：blockId+anchorSig 不变 → rebound；变化 → stale（需重新确认）。 */
  readonly rebind: AlignmentRebind;
  readonly previousAlignmentId?: string;
  /**
   * 该对齐所用时间源的审计元组（C7：sourceKind/sourceArtifact/modelVersion/
   * params/ruleVersion）。导入只产出 proposed（verified 必须人签），因此这些
   * 字段随 proposal 携带并由薄壳持久化，不进入 Alignment.status=verified 的
   * verifiedBy/verifiedAt/verifiedAgainst 审计三件套。
   */
  readonly timingProvenance?: TimingProvenance;
  /**
   * 该对齐所用时间源的派生置信度 0..1（ASR/强制对齐的转写坐标必须有值）。
   * 与 timingProvenance 同为审计数据，不参与身份。
   */
  readonly confidence?: number;
}

export interface AlignResult {
  readonly ruleVersion: typeof ALIGN_RULE_VERSION;
  readonly contentSpecs: readonly ContentSpec[];
  readonly blocks: readonly Block[];
  readonly renditions: readonly Rendition[];
  readonly alignments: readonly ProposedAlignment[];
  readonly superseded: {
    readonly contentKeys: readonly string[];
    readonly renditionKeys: readonly string[];
  };
  readonly issues: readonly CompilerIssue[];
}

/**
 * 本环境导入的 assetVersion 约定。
 *
 * 身份 = `assetKey + assetVersion`（C0 红线⑦），版本由包内
 * `manifest.content.assetPins` 显式声明（B/D 缺陷：换视频必须携带新版本），
 * 不得由导入器猜测。该函数保留为单元测试与"全新环境"默认值的参考实现；
 * 生产导入必须使用 `assetVersionsFromPins`。
 */
export function initialAssetVersions(
  rows: ValidatedRows,
): Record<string, number> {
  const versions: Record<string, number> = {};
  for (const row of rows.media) versions[row.value.asset_key] = 1;
  return versions;
}

/**
 * 包内显式 asset pins（`manifest.content.assetPins`）→ assetVersions。
 * 缺 pin 的媒体资产不会被赋版本（align 报 CONTENT_INCOMPLETE，不猜）。
 */
export function assetVersionsFromPins(ir: PackageIR): Record<string, number> {
  const versions: Record<string, number> = {};
  for (const pin of ir.content.assetPins) {
    versions[pin.assetKey] = pin.assetVersion;
  }
  return versions;
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sortBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function pinVersion(ir: PackageIR, contentKey: string): number {
  return (
    ir.content.specPins.find((pin) => pin.contentKey === contentKey)?.version ??
    1
  );
}

const EXHIBIT_MODALITY: Readonly<
  Record<'image' | 'video' | 'audio' | 'model3d', Rendition['modality']>
> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  model3d: 'model3d',
};

const EXHIBIT_BLOCK_KIND: Readonly<
  Record<'image' | 'video' | 'audio' | 'model3d', Block['kind']>
> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  model3d: 'model3d',
};

function exhibitPayload(
  kind: 'image' | 'video' | 'audio' | 'model3d',
  altLocalized: Record<string, Record<string, string>> | undefined,
): BlockPayload {
  switch (kind) {
    case 'image':
      return altLocalized === undefined
        ? { kind: 'image' }
        : { kind: 'image', altLocalized };
    case 'video':
      return { kind: 'video' };
    case 'audio':
      return { kind: 'audio' };
    case 'model3d':
      return { kind: 'model3d' };
  }
}

// ---------------------------------------------------------------------------
// ContentSpec / Block 派生
// ---------------------------------------------------------------------------

interface DerivedSpecs {
  readonly specs: ContentSpec[];
  readonly blocks: Block[];
  readonly blockIdsByContentKey: Map<string, Set<string>>;
  readonly issues: CompilerIssue[];
}

function lessonTitleLocalized(
  lessonRows: readonly TypedRow<LessonRow>[],
): Record<string, Record<string, string>> {
  const localized: Record<string, Record<string, string>> = {};
  for (const row of lessonRows) {
    if (localized[row.value.language] === undefined) {
      localized[row.value.language] = { title: row.value.title };
    }
  }
  return localized;
}

function deriveContentSpecs(
  ir: PackageIR,
  rows: ValidatedRows,
  documents: readonly DocumentStructureInput[],
  issues: CompilerIssue[],
): DerivedSpecs {
  const specs: ContentSpec[] = [];
  const blocks: Block[] = [];
  const blockIdsByContentKey = new Map<string, Set<string>>();

  const lessonCodes = [
    ...new Set(rows.lessons.map((row) => row.value.lesson_code)),
  ].sort();

  const documentsByLesson = new Map<string, DocumentStructureInput[]>();
  for (const document of documents) {
    const list = documentsByLesson.get(document.lessonCode) ?? [];
    list.push(document);
    documentsByLesson.set(document.lessonCode, list);
  }

  for (const lessonCode of lessonCodes) {
    const lessonRows = rows.lessons.filter(
      (row) => row.value.lesson_code === lessonCode,
    );
    const titleLocalized = lessonTitleLocalized(lessonRows);
    if (Object.keys(titleLocalized).length === 0) {
      issues.push(
        makeIssue(
          'incomplete',
          'CONTENT_INCOMPLETE',
          'lesson has no localized title rows to build a content spec',
          { sheet: 'Lessons', column: 'lesson_code' },
          { lessonCode, reason: 'lesson-title-missing' },
        ),
      );
      continue;
    }

    const mainContentKey = lessonCode;
    const mainBlocks: Block[] = [];

    const videoRows = rows.media.filter(
      (row) =>
        row.value.kind === 'video' && row.value.lesson_code === lessonCode,
    );
    if (videoRows.length > 0) {
      mainBlocks.push(
        BlockSchema.parse({
          contentKey: mainContentKey,
          version: pinVersion(ir, mainContentKey),
          blockId: 'video',
          kind: 'video',
          payload: { kind: 'video' },
        }),
      );
    }

    // 正文块：同一 lesson 的多个语言文档共用语言中立的结构块，正文由
    // document carrier（各语言 DOCX）承载；html 取声明语言顺序中的第一个。
    const lessonDocuments = documentsByLesson.get(lessonCode) ?? [];
    const preferredDocument = [...ir.course.learningLanguages]
      .map((language) =>
        lessonDocuments.find(
          (document) =>
            document.language === language &&
            document.html !== undefined &&
            document.html.trim() !== '',
        ),
      )
      .find((document) => document !== undefined);
    if (preferredDocument !== undefined) {
      mainBlocks.push(
        BlockSchema.parse({
          contentKey: mainContentKey,
          version: pinVersion(ir, mainContentKey),
          blockId: 'body',
          kind: 'text',
          payload: { kind: 'text', html: preferredDocument.html },
        }),
      );
    } else {
      const documentRows = rows.media.filter(
        (row) =>
          row.value.kind === 'lesson-text' &&
          row.value.lesson_code === lessonCode,
      );
      if (documentRows.length > 0) {
        issues.push(
          makeIssue(
            'incomplete',
            'CONTENT_INCOMPLETE',
            'lesson documents exist but no extracted body HTML is available',
            { sheet: 'Media', column: 'kind' },
            { lessonCode, reason: 'document-html-missing' },
          ),
        );
      }
    }

    // 展品块（exhibit_code = blockId；语言变体由 Rendition 的 language/carrier 表达）。
    const exhibitRows = rows.exhibits.filter(
      (row) => row.value.lesson_code === lessonCode,
    );
    const exhibitCodes = [
      ...new Set(exhibitRows.map((row) => row.value.exhibit_code)),
    ].sort();
    for (const exhibitCode of exhibitCodes) {
      const variants = exhibitRows.filter(
        (row) => row.value.exhibit_code === exhibitCode,
      );
      const first = variants[0];
      if (first.value.media_type === 'text') {
        const description = first.value.description?.trim() ?? '';
        if (description === '') {
          issues.push(
            makeIssue(
              'incomplete',
              'CONTENT_INCOMPLETE',
              'text exhibit has no description to use as its body',
              {
                sheet: 'Exhibits',
                row: first.rowNumber,
                column: 'description',
              },
              { lessonCode, exhibitCode, reason: 'text-exhibit-body-missing' },
            ),
          );
          continue;
        }
        mainBlocks.push(
          BlockSchema.parse({
            contentKey: mainContentKey,
            version: pinVersion(ir, mainContentKey),
            blockId: exhibitCode,
            kind: 'text',
            payload: {
              kind: 'text',
              html: `<p>${escapeHtml(description)}</p>`,
            },
          }),
        );
        continue;
      }
      const altLocalized: Record<string, Record<string, string>> = {};
      for (const variant of variants) {
        if (variant.value.title !== '') {
          altLocalized[variant.value.language] = { alt: variant.value.title };
        }
      }
      mainBlocks.push(
        BlockSchema.parse({
          contentKey: mainContentKey,
          version: pinVersion(ir, mainContentKey),
          blockId: exhibitCode,
          kind: EXHIBIT_BLOCK_KIND[first.value.media_type],
          payload: exhibitPayload(
            first.value.media_type,
            Object.keys(altLocalized).length > 0 ? altLocalized : undefined,
          ),
        }),
      );
    }

    if (mainBlocks.length === 0) {
      issues.push(
        makeIssue(
          'incomplete',
          'CONTENT_INCOMPLETE',
          'lesson yields no content blocks (no video, body HTML or exhibits)',
          { sheet: 'Lessons', column: 'lesson_code' },
          { lessonCode, reason: 'no-blocks' },
        ),
      );
    } else {
      const spec = ContentSpecSchema.parse({
        contentKey: mainContentKey,
        version: pinVersion(ir, mainContentKey),
        type: videoRows.length > 0 ? 'video' : 'text',
        titleLocalized,
        blocks: mainBlocks,
      });
      specs.push(spec);
      blocks.push(...spec.blocks);
      blockIdsByContentKey.set(
        mainContentKey,
        new Set(spec.blocks.map((block) => block.blockId)),
      );
    }

    // 推荐阅读：单独 reading spec；每行一个 body block（元数据确定性渲染）。
    const readingRows = rows.readings.filter(
      (row) => row.value.lesson_code === lessonCode,
    );
    if (readingRows.length > 0) {
      const readingKey = `${lessonCode}.reading`;
      const readingBlocks = readingRows.map((row, index) => {
        const author =
          row.value.author === null ? '' : ` — ${escapeHtml(row.value.author)}`;
        const why =
          row.value.why === null ? '' : `<p>${escapeHtml(row.value.why)}</p>`;
        return BlockSchema.parse({
          contentKey: readingKey,
          version: pinVersion(ir, readingKey),
          blockId: `reading.${index + 1}`,
          kind: 'text',
          payload: {
            kind: 'text',
            html: `<p>${escapeHtml(row.value.title)}${author}</p>${why}`,
          },
        });
      });
      specs.push(
        ContentSpecSchema.parse({
          contentKey: readingKey,
          version: pinVersion(ir, readingKey),
          type: 'reading',
          titleLocalized,
          blocks: readingBlocks,
        }),
      );
      blocks.push(...readingBlocks);
      blockIdsByContentKey.set(
        readingKey,
        new Set(readingBlocks.map((block) => block.blockId)),
      );
    }

    // 知识测评：按 order 把 en-GB/zh-CN 行配对成双语 question block（B2.4）。
    const ktRows = rows.knowledgeTests.filter(
      (row) => row.value.lesson_code === lessonCode,
    );
    if (ktRows.length > 0) {
      const ktKey = `${lessonCode}.knowledge-test`;
      const byOrder = new Map<number, typeof ktRows>();
      for (const row of ktRows) {
        const list = byOrder.get(row.value.order) ?? [];
        list.push(row);
        byOrder.set(row.value.order, list);
      }
      const ktBlocks: Block[] = [];
      for (const order of [...byOrder.keys()].sort((a, b) => a - b)) {
        const group = byOrder.get(order) as typeof ktRows;
        const en = group.find((row) => row.value.language === 'en-GB');
        const zh = group.find((row) => row.value.language === 'zh-CN');
        if (en === undefined || zh === undefined) {
          issues.push(
            makeIssue(
              'incomplete',
              'LANGUAGE_MISSING',
              'knowledge question needs both en-GB and zh-CN rows for one order',
              {
                sheet: 'Knowledge Test',
                row: group[0].rowNumber,
                column: 'order',
              },
              { lessonCode, order },
            ),
          );
          continue;
        }
        ktBlocks.push(
          BlockSchema.parse({
            contentKey: ktKey,
            version: pinVersion(ir, ktKey),
            blockId: `q.${order}`,
            kind: 'question',
            payload: {
              kind: 'question',
              questionLocalized: {
                'en-GB': { question: en.value.question },
                'zh-CN': { question: zh.value.question },
              },
              referenceAnswerLocalized: {
                'en-GB': { referenceAnswer: en.value.reference_answer },
                'zh-CN': { referenceAnswer: zh.value.reference_answer },
              },
            },
          }),
        );
      }
      if (ktBlocks.length > 0) {
        specs.push(
          ContentSpecSchema.parse({
            contentKey: ktKey,
            version: pinVersion(ir, ktKey),
            type: 'knowledge-test',
            titleLocalized,
            blocks: ktBlocks,
          }),
        );
        blocks.push(...ktBlocks);
        blockIdsByContentKey.set(
          ktKey,
          new Set(ktBlocks.map((block) => block.blockId)),
        );
      }
    }

    // 应用测评：每课时一条双语 question block。
    const atRows = rows.applicationTests.filter(
      (row) => row.value.lesson_code === lessonCode,
    );
    if (atRows.length > 0) {
      const atKey = `${lessonCode}.application-test`;
      const en = atRows.find((row) => row.value.language === 'en-GB');
      const zh = atRows.find((row) => row.value.language === 'zh-CN');
      if (en === undefined || zh === undefined) {
        issues.push(
          makeIssue(
            'incomplete',
            'LANGUAGE_MISSING',
            'application test needs both en-GB and zh-CN rows',
            {
              sheet: 'Application Test',
              row: atRows[0].rowNumber,
              column: 'language',
            },
            { lessonCode },
          ),
        );
      } else {
        const atBlock = BlockSchema.parse({
          contentKey: atKey,
          version: pinVersion(ir, atKey),
          blockId: 'application',
          kind: 'question',
          payload: {
            kind: 'question',
            questionLocalized: {
              'en-GB': { question: en.value.question },
              'zh-CN': { question: zh.value.question },
            },
            referenceAnswerLocalized: {
              'en-GB': { referenceAnswer: en.value.reference_answer },
              'zh-CN': { referenceAnswer: zh.value.reference_answer },
            },
          },
        });
        specs.push(
          ContentSpecSchema.parse({
            contentKey: atKey,
            version: pinVersion(ir, atKey),
            type: 'application-test',
            titleLocalized,
            blocks: [atBlock],
          }),
        );
        blocks.push(atBlock);
        blockIdsByContentKey.set(atKey, new Set(['application']));
      }
    }
  }

  return {
    specs: sortBy(specs, (spec) => spec.contentKey),
    blocks,
    blockIdsByContentKey,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Rendition 派生
// ---------------------------------------------------------------------------

interface RenditionCandidate {
  readonly contentKey: string;
  readonly blockId: string;
  readonly language: string;
  readonly modality: Rendition['modality'];
  readonly occurrenceKey: string;
  readonly carrierType: 'asset' | 'document';
  readonly carrierKey: string;
  /** §14 C3 anchorSource 词表（subtitle/chapter/asr/forced-alignment/…）。 */
  readonly anchorSource: Rendition['anchorSource'];
  readonly startMs?: number;
  readonly endMs?: number;
  readonly headingCode?: string;
  readonly offset?: number;
  readonly provenance?: TimingProvenance;
  /** 转写来源（ASR/强制对齐）的派生置信度 0..1。 */
  readonly confidence?: number;
}

function anchorIdentity(rendition: {
  readonly contentKey: string;
  readonly blockId: string;
  readonly language: string;
  readonly modality: string;
  readonly carrierType: string;
  readonly carrierKey: string;
  readonly occurrenceKey: string;
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

function coordinatesEqual(
  left: {
    startMs?: number;
    endMs?: number;
    headingCode?: string;
    offset?: number;
  },
  right: {
    startMs?: number;
    endMs?: number;
    headingCode?: string;
    offset?: number;
  },
): boolean {
  return (
    left.startMs === right.startMs &&
    left.endMs === right.endMs &&
    left.headingCode === right.headingCode &&
    left.offset === right.offset
  );
}

interface DerivedRenditions {
  readonly renditions: Rendition[];
  /** renditionKey/载体锚点 → 时间源审计元组（C7；无时间坐标的载体无此键）。 */
  readonly provenanceByAnchor: Map<string, TimingProvenance>;
  /** renditionKey/载体锚点 → 派生置信度 0..1（仅 ASR/强制对齐的转写坐标有值）。 */
  readonly confidenceByAnchor: Map<string, number>;
}

function deriveRenditions(
  input: AlignInput,
  blockIdsByContentKey: Map<string, Set<string>>,
  issues: CompilerIssue[],
): DerivedRenditions {
  const { ir, rows, timing } = input;
  const assetVersions = input.options.assetVersions;

  const candidates: RenditionCandidate[] = [];

  const requireBlock = (
    contentKey: string,
    blockId: string,
    reason: string,
  ): boolean => {
    const blockIds = blockIdsByContentKey.get(contentKey);
    if (blockIds === undefined || !blockIds.has(blockId)) {
      issues.push(
        makeIssue(
          'incomplete',
          'CONTENT_INCOMPLETE',
          'derived rendition has no matching content block',
          undefined,
          { contentKey, blockId, reason },
        ),
      );
      return false;
    }
    return true;
  };

  const requireAssetVersion = (assetKey: string): number | null => {
    const version = assetVersions[assetKey];
    if (version === undefined || !Number.isInteger(version) || version < 1) {
      issues.push(
        makeIssue(
          'error',
          'CONTENT_INCOMPLETE',
          'media asset has no assigned assetVersion in this environment',
          { sheet: 'Media', column: 'asset_key' },
          { assetKey, reason: 'missing-asset-version' },
        ),
      );
      return null;
    }
    return version;
  };

  // 1) 时间坐标（P3）→ Rendition（视频区间 / DOCX heading）。
  for (const coordinate of timing.coordinates) {
    const contentKey = coordinate.lessonCode;
    if (coordinate.carrierType === 'asset') {
      const blockId = coordinate.kind === 'lp' ? 'video' : coordinate.code;
      if (!requireBlock(contentKey, blockId, 'timing-asset-block-missing')) {
        continue;
      }
      const version = requireAssetVersion(coordinate.carrierKey);
      if (version === null) continue;
      candidates.push({
        contentKey,
        blockId,
        language: coordinate.language,
        modality: 'video',
        occurrenceKey: coordinate.occurrenceKey,
        carrierType: 'asset',
        carrierKey: coordinate.carrierKey,
        anchorSource: coordinate.anchorSource,
        startMs: coordinate.startMs,
        endMs: coordinate.endMs,
        provenance: coordinate.provenance,
        ...(coordinate.confidence === undefined
          ? {}
          : { confidence: coordinate.confidence }),
      });
    } else {
      const blockId = 'body';
      if (!requireBlock(contentKey, blockId, 'timing-document-block-missing')) {
        continue;
      }
      const version = requireAssetVersion(coordinate.carrierKey);
      if (version === null) continue;
      candidates.push({
        contentKey,
        blockId,
        language: coordinate.language,
        modality: 'text',
        occurrenceKey: coordinate.occurrenceKey,
        carrierType: 'document',
        carrierKey: coordinate.carrierKey,
        anchorSource: coordinate.anchorSource,
        headingCode: coordinate.headingCode,
        offset: coordinate.offset,
        provenance: coordinate.provenance,
        ...(coordinate.confidence === undefined
          ? {}
          : { confidence: coordinate.confidence }),
      });
    }
  }

  // 2) 正文 document rendition（每语言 DOCX 一个 body 坐标）。
  for (const row of rows.media) {
    if (row.value.kind !== 'lesson-text') continue;
    if (row.value.lesson_code === null || row.value.language === null) continue;
    const contentKey = row.value.lesson_code;
    if (!requireBlock(contentKey, 'body', 'document-block-missing')) continue;
    const version = requireAssetVersion(row.value.asset_key);
    if (version === null) continue;
    candidates.push({
      contentKey,
      blockId: 'body',
      language: row.value.language,
      modality: 'text',
      occurrenceKey: 'body',
      carrierType: 'document',
      carrierKey: row.value.asset_key,
      anchorSource: 'doc-structure',
    });
  }

  // 3) 展品展示 rendition（primary；thumbnail 单独一条）。
  const exhibitRowsByLesson = new Map<string, TypedRow<ExhibitRow>[]>();
  for (const row of rows.exhibits) {
    const list = exhibitRowsByLesson.get(row.value.lesson_code) ?? [];
    list.push(row);
    exhibitRowsByLesson.set(row.value.lesson_code, list);
  }
  for (const row of rows.exhibits) {
    if (row.value.media_type === 'text') continue;
    if (row.value.asset_key === null) continue;
    const contentKey = row.value.lesson_code;
    if (
      !requireBlock(contentKey, row.value.exhibit_code, 'exhibit-block-missing')
    ) {
      continue;
    }
    const version = requireAssetVersion(row.value.asset_key);
    if (version === null) continue;
    candidates.push({
      contentKey,
      blockId: row.value.exhibit_code,
      language: row.value.language,
      modality: EXHIBIT_MODALITY[row.value.media_type],
      occurrenceKey: 'main',
      carrierType: 'asset',
      carrierKey: row.value.asset_key,
      anchorSource: 'import-legacy',
    });
  }

  // 4) 缩略图 rendition（thumbnail_of → exhibit block）。
  for (const row of rows.media) {
    if (row.value.kind !== 'thumbnail') continue;
    if (row.value.thumbnail_of === null) continue;
    const exhibitRows =
      row.value.lesson_code === null
        ? []
        : (exhibitRowsByLesson.get(row.value.lesson_code) ?? []).filter(
            (exhibit) => exhibit.value.asset_key === row.value.thumbnail_of,
          );
    if (exhibitRows.length === 0) continue; // cover 缩略图属课程级，不是 block rendition
    const exhibit = exhibitRows[0];
    const contentKey = exhibit.value.lesson_code;
    if (
      !requireBlock(
        contentKey,
        exhibit.value.exhibit_code,
        'thumbnail-block-missing',
      )
    ) {
      continue;
    }
    const language = row.value.language ?? exhibit.value.language;
    const version = requireAssetVersion(row.value.asset_key);
    if (version === null) continue;
    candidates.push({
      contentKey,
      blockId: exhibit.value.exhibit_code,
      language,
      modality: 'image',
      occurrenceKey: 'thumbnail',
      carrierType: 'asset',
      carrierKey: row.value.asset_key,
      anchorSource: 'import-legacy',
    });
  }

  // 旧 rendition 的锚点/revision 基准（按 anchor identity 匹配，忽略 assetVersion：
  // 跨环境版本是本地分配，逻辑身份由 assetKey 承担，版本变化使 revision +1 → stale）。
  const oldByIdentity = new Map<string, Rendition[]>();
  for (const old of ir.content.renditions) {
    const key = anchorIdentity(old);
    const list = oldByIdentity.get(key) ?? [];
    list.push(old);
    oldByIdentity.set(key, list);
  }

  const renditions: Rendition[] = [];
  const provenanceByAnchor = new Map<string, TimingProvenance>();
  const confidenceByAnchor = new Map<string, number>();
  const seenBusinessKeys = new Set<string>();
  for (const candidate of candidates) {
    const version = assetVersions[candidate.carrierKey];
    const oldCandidates = oldByIdentity.get(anchorIdentity(candidate)) ?? [];
    const previous = [...oldCandidates].sort(
      (a, b) => b.carrierVersion - a.carrierVersion || b.revision - a.revision,
    )[0];
    let revision = 1;
    if (previous !== undefined) {
      const unchanged =
        previous.carrierVersion === version &&
        previous.anchorSource === candidate.anchorSource &&
        coordinatesEqual(previous, candidate);
      revision = unchanged ? previous.revision : previous.revision + 1;
    }

    const renditionKey = [
      'r',
      candidate.contentKey,
      candidate.blockId,
      candidate.language,
      candidate.modality,
      candidate.carrierType,
      candidate.carrierKey,
      candidate.occurrenceKey,
    ].join('.');
    if (renditionKey.length > 128) {
      issues.push(
        makeIssue(
          'error',
          'CONTENT_INCOMPLETE',
          'derived renditionKey exceeds the stable-token length limit',
          undefined,
          { renditionKey, reason: 'rendition-key-too-long' },
        ),
      );
      continue;
    }

    const plain = {
      renditionKey,
      contentKey: candidate.contentKey,
      blockId: candidate.blockId,
      language: candidate.language,
      modality: candidate.modality,
      occurrenceKey: candidate.occurrenceKey,
      carrierType: candidate.carrierType,
      carrierKey: candidate.carrierKey,
      carrierVersion: version,
      ...(candidate.startMs === undefined
        ? {}
        : { startMs: candidate.startMs }),
      ...(candidate.endMs === undefined ? {} : { endMs: candidate.endMs }),
      ...(candidate.headingCode === undefined
        ? {}
        : { headingCode: candidate.headingCode }),
      ...(candidate.offset === undefined ? {} : { offset: candidate.offset }),
      anchorSource: candidate.anchorSource,
      revision,
    };
    const parsed = RenditionSchema.safeParse(plain);
    if (!parsed.success) {
      issues.push(
        makeIssue(
          'error',
          'CONTENT_INCOMPLETE',
          'derived rendition does not satisfy the frozen contract',
          undefined,
          {
            renditionKey,
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.map(String).join('.'),
              message: issue.message,
            })),
          },
        ),
      );
      continue;
    }
    const rendition = parsed.data;
    const businessKey = renditionBusinessKey(rendition);
    if (seenBusinessKeys.has(businessKey)) {
      issues.push(
        makeIssue(
          'error',
          'CODE_DUPLICATE',
          'duplicate rendition business key',
          undefined,
          { renditionKey, reason: 'rendition-business-key' },
        ),
      );
      continue;
    }
    seenBusinessKeys.add(businessKey);
    renditions.push(rendition);
    if (candidate.provenance !== undefined) {
      provenanceByAnchor.set(anchorIdentity(rendition), candidate.provenance);
    }
    if (candidate.confidence !== undefined) {
      confidenceByAnchor.set(anchorIdentity(rendition), candidate.confidence);
    }
  }

  return {
    renditions: sortBy(renditions, (rendition) => rendition.renditionKey),
    provenanceByAnchor,
    confidenceByAnchor,
  };
}

// ---------------------------------------------------------------------------
// proposed Alignment 派生（P4）
// ---------------------------------------------------------------------------

interface PendingAlignment {
  alignmentId: string;
  stageKey: string;
  renditionKey: string;
  objectiveKey: string;
  role: AlignmentRole;
  provenance: 'import' | 'legacy';
  rebind: AlignmentRebind;
  previousAlignmentId?: string;
}

function deriveAlignments(
  input: AlignInput,
  renditions: readonly Rendition[],
  provenanceByAnchor: ReadonlyMap<string, TimingProvenance>,
  confidenceByAnchor: ReadonlyMap<string, number>,
  issues: CompilerIssue[],
): ProposedAlignment[] {
  const { ir } = input;
  const stageByKey = new Map<string, (typeof ir.content.stages)[number]>(
    ir.content.stages.map((stage) => [stage.stageKey, stage]),
  );
  const oldRenditionByKey = new Map(
    ir.content.renditions.map((rendition) => [
      rendition.renditionKey,
      rendition,
    ]),
  );
  const derivedByAnchor = new Map<string, Rendition>();
  const provenanceByRenditionKey = new Map<string, TimingProvenance>();
  const confidenceByRenditionKey = new Map<string, number>();
  for (const rendition of renditions) {
    derivedByAnchor.set(anchorIdentity(rendition), rendition);
    const provenance = provenanceByAnchor.get(anchorIdentity(rendition));
    if (provenance !== undefined) {
      provenanceByRenditionKey.set(rendition.renditionKey, provenance);
    }
    const confidence = confidenceByAnchor.get(anchorIdentity(rendition));
    if (confidence !== undefined) {
      confidenceByRenditionKey.set(rendition.renditionKey, confidence);
    }
  }

  const pending: PendingAlignment[] = [];
  const pairIndex = new Map<string, PendingAlignment>();
  const usedIds = new Set<string>();

  const addPending = (entry: PendingAlignment): void => {
    const pairKey = `${entry.stageKey}\u0000${entry.renditionKey}`;
    const existing = pairIndex.get(pairKey);
    if (existing !== undefined) {
      if (
        existing.objectiveKey !== entry.objectiveKey ||
        existing.role !== entry.role
      ) {
        issues.push(
          makeIssue(
            'error',
            'ALIGNMENT_CONFLICT',
            'the same (stageKey, renditionKey) pair received conflicting alignment proposals',
            { path: 'bindingSeeds' },
            {
              stageKey: entry.stageKey,
              renditionKey: entry.renditionKey,
              existing: {
                objectiveKey: existing.objectiveKey,
                role: existing.role,
              },
              incoming: {
                objectiveKey: entry.objectiveKey,
                role: entry.role,
              },
            },
          ),
        );
      }
      return;
    }
    pairIndex.set(pairKey, entry);
    pending.push(entry);
    usedIds.add(entry.alignmentId);
  };

  // 1) 旧内容 verified 对齐 → 重绑为 proposed（provenance=import/legacy）。
  const oldAlignments = sortBy(
    ir.content.alignments,
    (alignment) => alignment.alignmentId,
  );
  for (const old of oldAlignments) {
    const stage = stageByKey.get(old.stageKey);
    if (
      stage === undefined ||
      !stage.objectiveKeys.includes(old.objectiveKey)
    ) {
      issues.push(
        makeIssue(
          'warning',
          'ALIGNMENT_UNBOUND',
          'old alignment stage/objective no longer exists; it is not re-proposed',
          { path: `content.alignments.${old.alignmentId}` },
          { alignmentId: old.alignmentId, stageKey: old.stageKey },
        ),
      );
      continue;
    }
    const oldRendition = oldRenditionByKey.get(old.renditionKey);
    if (oldRendition === undefined) {
      issues.push(
        makeIssue(
          'warning',
          'ALIGNMENT_UNBOUND',
          'old alignment references an unknown rendition',
          { path: `content.alignments.${old.alignmentId}` },
          { alignmentId: old.alignmentId, renditionKey: old.renditionKey },
        ),
      );
      continue;
    }
    const derived = derivedByAnchor.get(anchorIdentity(oldRendition));
    if (derived === undefined) {
      issues.push(
        makeIssue(
          'warning',
          'ALIGNMENT_UNBOUND',
          'old alignment rendition is not re-derived by this package (stale, dropped)',
          { path: `content.alignments.${old.alignmentId}` },
          {
            alignmentId: old.alignmentId,
            renditionKey: old.renditionKey,
            reason: 'rendition-unbound',
          },
        ),
      );
      continue;
    }
    const unchanged =
      oldRendition.carrierVersion === derived.carrierVersion &&
      oldRendition.anchorSource === derived.anchorSource &&
      coordinatesEqual(oldRendition, derived);
    addPending({
      alignmentId: old.alignmentId,
      stageKey: old.stageKey,
      renditionKey: derived.renditionKey,
      objectiveKey: old.objectiveKey,
      role: old.role,
      provenance: old.provenance === 'legacy' ? 'legacy' : 'import',
      rebind: unchanged ? 'rebound' : 'stale',
      previousAlignmentId: old.alignmentId,
    });
  }

  // 2) 显式 binding seeds（不猜：语义绑定必须显式给出）。
  (input.options.bindingSeeds ?? []).forEach((seed, index) => {
    const stage = stageByKey.get(seed.stageKey);
    if (stage === undefined) {
      issues.push(
        makeIssue(
          'error',
          'ALIGNMENT_SEED_UNBOUND',
          'binding seed references an unknown stageKey',
          { path: `bindingSeeds[${index}].stageKey` },
          { stageKey: seed.stageKey },
        ),
      );
      return;
    }
    if (!stage.objectiveKeys.includes(seed.objectiveKey)) {
      issues.push(
        makeIssue(
          'error',
          'ALIGNMENT_SEED_UNBOUND',
          'binding seed objectiveKey does not belong to its stage',
          { path: `bindingSeeds[${index}].objectiveKey` },
          { stageKey: seed.stageKey, objectiveKey: seed.objectiveKey },
        ),
      );
      return;
    }
    const matches = renditions.filter(
      (rendition) =>
        rendition.contentKey === seed.contentKey &&
        (seed.blockId === undefined || rendition.blockId === seed.blockId) &&
        (seed.language === undefined || rendition.language === seed.language),
    );
    if (matches.length === 0) {
      issues.push(
        makeIssue(
          'error',
          'ALIGNMENT_SEED_UNBOUND',
          'binding seed matches no derived rendition',
          { path: `bindingSeeds[${index}]` },
          {
            stageKey: seed.stageKey,
            contentKey: seed.contentKey,
            blockId: seed.blockId,
            language: seed.language,
          },
        ),
      );
      return;
    }
    for (const rendition of matches) {
      addPending({
        alignmentId: '', // 稍后按确定性计数器分配
        stageKey: seed.stageKey,
        renditionKey: rendition.renditionKey,
        objectiveKey: seed.objectiveKey,
        role: seed.role,
        provenance: seed.provenance ?? 'import',
        rebind: 'new',
      });
    }
  });

  // 3) 确定性 id 分配：保留旧 id；新 proposal 按 (stageKey, renditionKey) 排序后
  //    用单调计数器 aln.000001…（本地 id；内容身份仍是 (stageKey, renditionKey) 对）。
  const newOnes = sortBy(
    pending.filter((entry) => entry.alignmentId === ''),
    (entry) => `${entry.stageKey}\u0000${entry.renditionKey}`,
  );
  let counter = 1;
  for (const entry of newOnes) {
    let candidateId = '';
    do {
      candidateId = `aln.${String(counter).padStart(6, '0')}`;
      counter += 1;
    } while (usedIds.has(candidateId));
    entry.alignmentId = candidateId;
    usedIds.add(candidateId);
  }

  const proposed = pending.map((entry) => {
    const alignment = AlignmentSchema.parse({
      alignmentId: entry.alignmentId,
      stageKey: entry.stageKey,
      renditionKey: entry.renditionKey,
      objectiveKey: entry.objectiveKey,
      role: entry.role,
      status: 'proposed',
      provenance: entry.provenance,
    });
    const timingProvenance = provenanceByRenditionKey.get(entry.renditionKey);
    const confidence = confidenceByRenditionKey.get(entry.renditionKey);
    return {
      alignment,
      provenance: entry.provenance,
      rebind: entry.rebind,
      ...(entry.previousAlignmentId === undefined
        ? {}
        : { previousAlignmentId: entry.previousAlignmentId }),
      ...(timingProvenance === undefined ? {} : { timingProvenance }),
      ...(confidence === undefined ? {} : { confidence }),
    } satisfies ProposedAlignment;
  });

  return sortBy(
    proposed,
    (entry) =>
      `${entry.alignment.stageKey}\u0000${entry.alignment.renditionKey}`,
  );
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * P4 align：派生 ContentSpec/Block/Rendition + proposed Alignment（纯函数）。
 * 同一输入（含旧内容、assetVersions、seeds、documents）逐字节同输出。
 */
export function alignPackage(input: AlignInput): AlignResult {
  const issues: CompilerIssue[] = [];
  const derived = deriveContentSpecs(
    input.ir,
    input.rows,
    input.documents ?? [],
    issues,
  );
  const renditions = deriveRenditions(
    input,
    derived.blockIdsByContentKey,
    issues,
  );
  const alignments = deriveAlignments(
    input,
    renditions.renditions,
    renditions.provenanceByAnchor,
    renditions.confidenceByAnchor,
    issues,
  );

  const derivedContentKeys = new Set(
    derived.specs.map((spec) => spec.contentKey),
  );
  const derivedAnchors = new Set(
    renditions.renditions.map((rendition) => anchorIdentity(rendition)),
  );
  const supersededContentKeys = input.ir.content.specPins
    .map((pin) => pin.contentKey)
    .filter((contentKey) => !derivedContentKeys.has(contentKey))
    .sort();
  const supersededRenditionKeys = input.ir.content.renditions
    .filter((rendition) => !derivedAnchors.has(anchorIdentity(rendition)))
    .map((rendition) => rendition.renditionKey)
    .sort();

  return {
    ruleVersion: ALIGN_RULE_VERSION,
    contentSpecs: derived.specs,
    blocks: derived.blocks,
    renditions: renditions.renditions,
    alignments,
    superseded: {
      contentKeys: supersededContentKeys,
      renditionKeys: supersededRenditionKeys,
    },
    issues,
  };
}
