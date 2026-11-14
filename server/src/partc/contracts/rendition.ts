import { z } from 'zod';
import { ContentKeySchema, LocaleSchema, TimeMsSchema } from './brands';
import {
  ContentModalitySchema,
  positiveIntSchema,
  stableTokenSchema,
} from './primitives';

/**
 * Rendition（设计 §14 C3/C4 ALN-3）。
 *
 * 内容块在「语言 × 模态 × 载体」上的一个点。业务键：
 * (contentKey, blockId, language, modality, carrierType, carrierKey, carrierVersion,
 * occurrenceKey) 全部 NOT NULL 且全局唯一 —— 这里由 renditionBusinessKey() 承载，
 * DB 侧由后续迁移的唯一索引兜底。
 *
 * 坐标单源：asset 载体只允许 startMs/endMs（半开区间，来自字幕/章节/容器探测），
 * document 载体只允许 headingCode/offset（DOCX 结构）。0 ≤ startMs < endMs，
 * endMs ≤ durationMs 依赖 MediaAsset，由导入/编译器按资产校验。
 * anchorSource 记录派生来源（C7：无源即 TIMING_SOURCE_MISSING，不猜）。
 */

export const CARRIER_TYPES = ['asset', 'document'] as const;
export type CarrierType = (typeof CARRIER_TYPES)[number];

export const ANCHOR_SOURCES = [
  'subtitle',
  'chapter',
  'asr',
  'forced-alignment',
  'doc-structure',
  'import-legacy',
] as const;
export type AnchorSource = (typeof ANCHOR_SOURCES)[number];

/** 只能落在 asset（音视频）载体上的派生来源（C7：视频时间锚点）。 */
export const ASSET_ANCHOR_SOURCES = [
  'subtitle',
  'chapter',
  'asr',
  'forced-alignment',
] as const;

export const RenditionSchema = z
  .strictObject({
    renditionKey: stableTokenSchema,
    contentKey: ContentKeySchema,
    blockId: stableTokenSchema,
    language: LocaleSchema,
    modality: ContentModalitySchema,
    occurrenceKey: stableTokenSchema,
    carrierType: z.enum(CARRIER_TYPES),
    carrierKey: stableTokenSchema,
    carrierVersion: positiveIntSchema,
    startMs: TimeMsSchema.optional(),
    endMs: TimeMsSchema.optional(),
    headingCode: stableTokenSchema.optional(),
    offset: z.number().int().nonnegative().optional(),
    anchorSource: z.enum(ANCHOR_SOURCES),
    revision: positiveIntSchema,
  })
  .superRefine((rendition, ctx) => {
    const hasStart = rendition.startMs !== undefined;
    const hasEnd = rendition.endMs !== undefined;
    if (hasStart !== hasEnd) {
      ctx.addIssue({
        code: 'custom',
        message: 'startMs and endMs must be provided together',
        path: ['startMs'],
      });
    }
    if (
      rendition.startMs !== undefined &&
      rendition.endMs !== undefined &&
      rendition.startMs >= rendition.endMs
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'must satisfy 0 <= startMs < endMs',
        path: ['endMs'],
      });
    }
    if (rendition.carrierType === 'asset') {
      if (
        rendition.headingCode !== undefined ||
        rendition.offset !== undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'asset carriers must not carry document coordinates',
          path: ['carrierType'],
        });
      }
    } else if (
      rendition.startMs !== undefined ||
      rendition.endMs !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'document carriers must not carry media coordinates',
        path: ['carrierType'],
      });
    }
    if (
      (ASSET_ANCHOR_SOURCES as readonly string[]).includes(
        rendition.anchorSource,
      ) &&
      rendition.carrierType !== 'asset'
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `${rendition.anchorSource} anchors require an asset carrier`,
        path: ['anchorSource'],
      });
    }
    if (
      rendition.anchorSource === 'doc-structure' &&
      rendition.carrierType !== 'document'
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'doc-structure anchors require a document carrier',
        path: ['anchorSource'],
      });
    }
  });

export type Rendition = z.infer<typeof RenditionSchema>;

/** Rendition 业务键的稳定字符串形式（无哈希，直接字段拼接）。 */
export function renditionBusinessKey(rendition: Rendition): string {
  return [
    rendition.contentKey,
    rendition.blockId,
    rendition.language,
    rendition.modality,
    rendition.carrierType,
    rendition.carrierKey,
    String(rendition.carrierVersion),
    rendition.occurrenceKey,
  ].join('\u0000');
}

/** 供后续编译器复用的业务键字段清单（DB 唯一索引同源）。 */
export const RENDITION_BUSINESS_KEY_FIELDS = [
  'contentKey',
  'blockId',
  'language',
  'modality',
  'carrierType',
  'carrierKey',
  'carrierVersion',
  'occurrenceKey',
] as const;
