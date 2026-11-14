import { z } from 'zod';
import {
  AssetKeySchema,
  ContentKeySchema,
  StageKeySchema,
  TimeMsSchema,
} from './brands';
import { stageOrderKeySchema } from './stage';
import {
  nonNegativeIntSchema,
  positiveIntSchema,
  stableTokenSchema,
} from './primitives';

/**
 * PlanEntry（设计 §14 C3/C6/C7）。
 *
 * entryId = stageKey + alignmentId + occurrenceKey 的显式派生（无摘要）。
 * placement 四型：media（半开区间 [startMs,endMs)）/ document（headingCode/offset）/
 * assessment（contentKey + question blockIds）/ gap（仅显式非 ok 状态，gap.reason
 * 取不变量编号，不能把缺失伪装成 ok）。
 * 引用必须 verified、stale 阻塞（ALN-2/ALN-6）—— 由编译器在生成前检查；
 * schema 负责结构闭合与坐标区间合法。
 */

export const ENTRY_STATUSES = ['ok', 'degraded', 'blocked'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

/** gap 原因 = C4 阻塞不变量编号（交付叶级可定位的那些）。 */
export const GAP_REASON_CODES = [
  'ALN-1',
  'ALN-2',
  'ALN-4',
  'ALN-6',
  'TIM-1',
] as const;
export type GapReason = (typeof GAP_REASON_CODES)[number];

export const PlanPlacementSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('media'),
    assetKey: AssetKeySchema,
    assetVersion: positiveIntSchema,
    startMs: TimeMsSchema,
    endMs: TimeMsSchema,
  }),
  z.strictObject({
    type: z.literal('document'),
    documentKey: stableTokenSchema,
    documentVersion: positiveIntSchema,
    headingCode: stableTokenSchema.optional(),
    offset: nonNegativeIntSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('assessment'),
    contentKey: ContentKeySchema,
    blockIds: z.array(stableTokenSchema).min(1),
  }),
  z.strictObject({
    type: z.literal('gap'),
    reason: z.enum(GAP_REASON_CODES),
  }),
]);

export type PlanPlacement = z.infer<typeof PlanPlacementSchema>;

/** entryId 的显式格式，与 derivePlanEntryId 同源。 */
export const PLAN_ENTRY_ID_PATTERN =
  /^entry:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/;

export const planEntryIdSchema = z
  .string()
  .regex(PLAN_ENTRY_ID_PATTERN, 'malformed entryId');

export const PlanEntrySchema = z
  .strictObject({
    entryId: planEntryIdSchema,
    stageKey: StageKeySchema,
    alignmentId: stableTokenSchema,
    orderKey: stageOrderKeySchema,
    placement: PlanPlacementSchema,
    status: z.enum(ENTRY_STATUSES),
  })
  .superRefine((entry, ctx) => {
    if (entry.placement.type === 'gap' && entry.status === 'ok') {
      ctx.addIssue({
        code: 'custom',
        message:
          'gap placement is only allowed on explicit degraded/blocked entries; ok entries must carry a concrete placement',
        path: ['status'],
      });
    }
    if (entry.placement.type === 'media') {
      if (entry.placement.startMs >= entry.placement.endMs) {
        ctx.addIssue({
          code: 'custom',
          message: 'must satisfy 0 <= startMs < endMs',
          path: ['placement', 'endMs'],
        });
      }
    }
  });

export type PlanEntry = z.infer<typeof PlanEntrySchema>;

/** entryId = entry:{stageKey}:{alignmentId}:{occurrenceKey}（C3 显式派生）。 */
export function derivePlanEntryId(input: {
  stageKey: string;
  alignmentId: string;
  occurrenceKey: string;
}): string {
  return `entry:${input.stageKey}:${input.alignmentId}:${input.occurrenceKey}`;
}
