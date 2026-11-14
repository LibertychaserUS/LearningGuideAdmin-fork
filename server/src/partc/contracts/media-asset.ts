import { z } from 'zod';
import { AssetKeySchema, LocaleSchema, TimeMsSchema } from './brands';
import { nonEmptyTextSchema, positiveIntSchema } from './primitives';

/**
 * MediaAsset（设计 §14 C3/C7/B2.5）。
 *
 * 身份 = assetKey + assetVersion（替换即新版本）。全系统不使用任何内容摘要
 * 作为身份或工件绑定（C0 红线⑦）；durationMs 只是容器探测出的资产属性，
 * 仅用于校验与「课程总时长 = 视频时长求和」，不参与身份。
 * 视频/音频资产在导入时必须探测出 durationMs（探测失败 → 导入失败，不跳过校验）。
 */

export const MEDIA_ASSET_KINDS = [
  'cover',
  'video',
  'audio',
  'image',
  'model3d',
  'thumbnail',
  'lesson-text',
  'subtitle',
  'chapters',
] as const;
export type MediaAssetKind = (typeof MEDIA_ASSET_KINDS)[number];

const TIME_BASED_KINDS: ReadonlySet<MediaAssetKind> = new Set([
  'video',
  'audio',
]);

export const MediaAssetSchema = z
  .strictObject({
    assetKey: AssetKeySchema,
    assetVersion: positiveIntSchema,
    kind: z.enum(MEDIA_ASSET_KINDS),
    language: LocaleSchema.optional(),
    durationMs: TimeMsSchema.optional(),
    /**
     * 存储定位符（本环境内部属性）。跨环境搬运一律走 assetKey+assetVersion，
     * 包内路径约束由 PackageResource.path / 模板 Media.relative_path 承担。
     */
    uri: nonEmptyTextSchema,
  })
  .superRefine((asset, ctx) => {
    const timeBased = TIME_BASED_KINDS.has(asset.kind);
    if (timeBased && asset.durationMs === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `${asset.kind} assets must carry a probed durationMs`,
        path: ['durationMs'],
      });
    }
    if (!timeBased && asset.durationMs !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `${asset.kind} assets must not carry durationMs`,
        path: ['durationMs'],
      });
    }
    if (asset.durationMs !== undefined && asset.durationMs <= 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'durationMs must be > 0',
        path: ['durationMs'],
      });
    }
  });

export type MediaAsset = z.infer<typeof MediaAssetSchema>;

/** 资产身份的可比较字符串形式（无哈希）：assetKey@assetVersion。 */
export function mediaAssetIdentity(asset: MediaAsset): string {
  return `${asset.assetKey}@${asset.assetVersion}`;
}
