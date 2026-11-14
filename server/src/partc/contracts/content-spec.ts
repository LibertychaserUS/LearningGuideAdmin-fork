import { z } from 'zod';
import { ContentKeySchema } from './brands';
import { BlockSchema } from './block';
import {
  LocalizedTemplateSchema,
  nonEmptyTextSchema,
  positiveIntSchema,
  stableTokenSchema,
} from './primitives';

/**
 * ContentSpec（设计 §14 C3）。
 *
 * 发布后不可变；不含 stageKey / 排序 DSL / 权威锚点 / 时长 —— strictObject
 * 会拒绝任何越界字段（例如有人想塞 stageKey 或时间列）。
 *
 * type 为 6 值封闭词表（C0 ⑩「内容单元与阶段分离、6 类封闭词表」）：
 * 内容单元按交付物形态分为 视频/文本/展品/阅读/知识测评/应用测评。
 * 这里的「视频/文本」是内容载体形态，不是语义身份：同一 Stage 由 video/text
 * 两种 rendition 服务（C0 修订 PRD §12.5），语义身份始终是 stageKey。
 */

export const CONTENT_SPEC_TYPES = [
  'video',
  'text',
  'exhibit',
  'reading',
  'knowledge-test',
  'application-test',
] as const;
export type ContentSpecType = (typeof CONTENT_SPEC_TYPES)[number];

export const ContentSpecSchema = z
  .strictObject({
    contentKey: ContentKeySchema,
    version: positiveIntSchema,
    type: z.enum(CONTENT_SPEC_TYPES),
    titleLocalized: LocalizedTemplateSchema,
    blocks: z.array(BlockSchema).min(1),
    /** 弱提示：不构成权威绑定，编译器不得据此代替 Alignment。 */
    objectiveHints: z.array(stableTokenSchema).min(1).optional(),
    sourceRefs: z.array(nonEmptyTextSchema).min(1).optional(),
  })
  .superRefine((spec, ctx) => {
    const seen = new Set<string>();
    for (const block of spec.blocks) {
      if (
        block.contentKey !== spec.contentKey ||
        block.version !== spec.version
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'block contentKey/version must equal the enclosing content spec',
          path: ['blocks', block.blockId],
        });
      }
      if (seen.has(block.blockId)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate blockId ${block.blockId} within content spec`,
          path: ['blocks', block.blockId],
        });
      }
      seen.add(block.blockId);
    }
  });

export type ContentSpec = z.infer<typeof ContentSpecSchema>;
