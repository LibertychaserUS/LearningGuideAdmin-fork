/**
 * Part C 版本矩阵（设计 §14 C0）。
 *
 * 三轴独立、单次升级：
 * - packageFormat = 2（课程包 v2：Part A 分类 + Part B 契约 + Part C 设计）
 * - templateVersion = 2（Excel 模板 v2）
 * - snapshotFormat = 3（版本快照 v3，单文件；快照 JSON 内以 formatVersion: 3 标记，
 *   与既有 CourseVersion.snapshotData 的 formatVersion 字段同义）
 *
 * 未知/缺失版本的旧产物一律拒绝（C5 P1，PACKAGE_FORMAT_UNSUPPORTED /
 * TEMPLATE_FORMAT_UNSUPPORTED），不做兼容解析。
 */

export const PACKAGE_FORMAT_VERSION = 2 as const;
export const TEMPLATE_VERSION = 2 as const;
export const SNAPSHOT_FORMAT_VERSION = 3 as const;

/** 课程包 manifest 的格式标识（与既有 v1 同名，版本由 formatVersion 区分）。 */
export const PACKAGE_FORMAT_TAG = 'lg-course-package' as const;

export const VERSION_MATRIX = Object.freeze({
  packageFormat: PACKAGE_FORMAT_VERSION,
  templateVersion: TEMPLATE_VERSION,
  snapshotFormat: SNAPSHOT_FORMAT_VERSION,
});

export type VersionMatrix = typeof VERSION_MATRIX;

export function isSupportedPackageFormat(value: number): boolean {
  return value === PACKAGE_FORMAT_VERSION;
}

export function isSupportedTemplateVersion(value: number): boolean {
  return value === TEMPLATE_VERSION;
}

export function isSupportedSnapshotFormat(value: number): boolean {
  return value === SNAPSHOT_FORMAT_VERSION;
}
