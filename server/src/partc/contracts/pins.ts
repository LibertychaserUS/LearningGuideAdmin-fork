import { z } from 'zod';
import { AssetKeySchema, ContentKeySchema } from './brands';
import { positiveIntSchema } from './primitives';

/**
 * 冻结 pin（设计 §14 C3/C6）。
 *
 * Plan 的 inputClosure 与 ContentVersion 的冻结内容共用同一种 pin 结构：
 * specPin = (contentKey, version)，assetPin = (assetKey, assetVersion)。
 * 版本比较靠显式版本号 + 字节相等，不使用任何摘要（C0 红线⑦）。
 */

export const SpecPinSchema = z.strictObject({
  contentKey: ContentKeySchema,
  version: positiveIntSchema,
});

export type SpecPin = z.infer<typeof SpecPinSchema>;

export const AssetPinSchema = z.strictObject({
  assetKey: AssetKeySchema,
  assetVersion: positiveIntSchema,
});

export type AssetPin = z.infer<typeof AssetPinSchema>;
