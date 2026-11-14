import { z } from 'zod';
import { ContentKeySchema } from './brands';
import {
  LocalizedTemplateSchema,
  bilingualFieldSchema,
  nonEmptyTextSchema,
  positiveIntSchema,
  stableTokenSchema,
} from './primitives';

/**
 * Block（设计 §14 C3）。
 *
 * blockId 是机器可引用的最小单位（稳定不复用）。kind 为 7 值封闭词表。
 * payload 与 kind 同型；媒体块本身不持有文件名/哈希 —— 载体由 Rendition 的
 * (carrierType, carrierKey, carrierVersion) 表达（ALN-3 坐标单源）。
 * 测评块按 B2.4 双语承载，en-GB 与 zh-CN 必须齐全。
 */

export const BLOCK_KINDS = [
  'text',
  'video',
  'audio',
  'image',
  'model3d',
  'question',
  'code',
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

const TextPayloadSchema = z.strictObject({
  kind: z.literal('text'),
  html: nonEmptyTextSchema,
});

const VideoPayloadSchema = z.strictObject({ kind: z.literal('video') });
const AudioPayloadSchema = z.strictObject({ kind: z.literal('audio') });
const Model3dPayloadSchema = z.strictObject({ kind: z.literal('model3d') });

const ImagePayloadSchema = z.strictObject({
  kind: z.literal('image'),
  altLocalized: LocalizedTemplateSchema.optional(),
});

const QuestionPayloadSchema = z.strictObject({
  kind: z.literal('question'),
  questionLocalized: bilingualFieldSchema('question'),
  referenceAnswerLocalized: bilingualFieldSchema('referenceAnswer'),
});

const CodePayloadSchema = z.strictObject({
  kind: z.literal('code'),
  language: nonEmptyTextSchema,
  initialCode: z.string().optional(),
});

export const BlockPayloadSchema = z.discriminatedUnion('kind', [
  TextPayloadSchema,
  VideoPayloadSchema,
  AudioPayloadSchema,
  ImagePayloadSchema,
  Model3dPayloadSchema,
  QuestionPayloadSchema,
  CodePayloadSchema,
]);

export type BlockPayload = z.infer<typeof BlockPayloadSchema>;

export const BlockSchema = z
  .strictObject({
    contentKey: ContentKeySchema,
    version: positiveIntSchema,
    blockId: stableTokenSchema,
    kind: z.enum(BLOCK_KINDS),
    payload: BlockPayloadSchema,
  })
  .refine(
    (block) => block.payload.kind === block.kind,
    'payload kind must match block kind',
  );

export type Block = z.infer<typeof BlockSchema>;
