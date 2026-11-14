import { z } from 'zod';
import { StageKeySchema } from './brands';
import {
  isoUtcSchema,
  nonEmptyTextSchema,
  nonNegativeIntSchema,
  stableTokenSchema,
} from './primitives';

/**
 * LearningEvent（设计 §14 C3/C8 与 §12 学习事件契约）。
 *
 * 学习时间是会话事件域，不属于内容模型：
 * - 客户端只提交 eventId/sessionId/type/occurredAt/内容引用/sequence；
 * - 服务端补 userId 与 receivedAt（权威时钟）；不接收客户端 elapsed/秒数；
 * - append-only；eventId 唯一幂等；completed 之前必须有 started 是跨事件规则；
 * - (userId, contentVersionId, stageKey) 与 (sessionId, sequence) 为查询索引。
 */
export const LEARNING_EVENT_TYPES = [
  'started',
  'paused',
  'resumed',
  'completed',
  'abandoned',
] as const;
export type LearningEventType = (typeof LEARNING_EVENT_TYPES)[number];

const learningEventClientShape = {
  eventId: stableTokenSchema,
  sessionId: stableTokenSchema,
  type: z.enum(LEARNING_EVENT_TYPES),
  occurredAt: isoUtcSchema,
  contentVersionId: stableTokenSchema,
  stageKey: StageKeySchema,
  sequence: nonNegativeIntSchema.optional(),
};

/** 客户端输入：不接受 userId/receivedAt（服务端权威字段）。 */
export const LearningEventInputSchema = z.strictObject(
  learningEventClientShape,
);

export type LearningEventInput = z.infer<typeof LearningEventInputSchema>;

/** 落库记录：append-only。 */
export const LearningEventSchema = z.strictObject({
  ...learningEventClientShape,
  userId: nonEmptyTextSchema,
  receivedAt: isoUtcSchema,
});

export type LearningEvent = z.infer<typeof LearningEventSchema>;
