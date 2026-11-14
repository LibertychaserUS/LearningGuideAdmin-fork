import {
  LEGACY_PACKAGE_FORMAT_VERSION,
  PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
  RETIRED_RAW_SOURCE_ENVIRONMENTS,
  type PackageManifest,
  type PackageValidationIssue,
  type PackageValidationReport,
} from './contracts/manifest';

/**
 * manifest 结构校验（tolerant：未知字段忽略；关键字段缺失报 error）。
 * 内容完整性（多语言、学习点、测试）在 package-validate.ts 里结合媒体校验。
 *
 * raw 素材导入已退役：原始素材转换产物带 LEGACY_PACKAGE_FORMAT_VERSION（1）
 * 与 EXCEL_TEMPLATE/EXCEL_IMPORT 来源标识，这里整体拒绝
 * （PACKAGE_FORMAT_UNSUPPORTED），不再有任何兼容转换路径。
 */
export function validateManifestShape(raw: unknown): {
  manifest?: PackageManifest;
  report: PackageValidationReport;
} {
  const errors: PackageValidationIssue[] = [];
  const warnings: PackageValidationIssue[] = [];
  const push = (
    level: 'error' | 'warning',
    code: string,
    message: string,
    path?: string,
  ) =>
    (level === 'error' ? errors : warnings).push({
      level,
      code,
      path,
      message,
    });

  const obj = raw as Record<string, unknown>;
  if (!obj || typeof obj !== 'object') {
    push('error', 'PACKAGE_MANIFEST_INVALID', 'manifest.json is not an object');
    return { report: { errors, warnings, incomplete: true } };
  }
  if (obj.format !== PACKAGE_FORMAT) {
    push(
      'error',
      'PACKAGE_MANIFEST_INVALID',
      `format must be "${PACKAGE_FORMAT}"`,
      'format',
    );
  }
  const retiredRawSource =
    typeof obj.source === 'object' &&
    obj.source !== null &&
    (RETIRED_RAW_SOURCE_ENVIRONMENTS as readonly unknown[]).includes(
      (obj.source as { environment?: unknown }).environment,
    );
  if (obj.formatVersion === LEGACY_PACKAGE_FORMAT_VERSION || retiredRawSource) {
    // raw 素材导入已退役：不再声明/接受 v2 之外的 legacy 产物。
    push(
      'error',
      'PACKAGE_FORMAT_UNSUPPORTED',
      'raw material import is retired; build a Part C v2 course package (formatVersion 2) instead',
      'formatVersion',
    );
  } else if (
    typeof obj.formatVersion !== 'number' ||
    obj.formatVersion !== PACKAGE_FORMAT_VERSION
  ) {
    push(
      'error',
      'PACKAGE_FORMAT_UNSUPPORTED',
      `unsupported formatVersion (only ${PACKAGE_FORMAT_VERSION} is accepted; legacy packages are rejected without compatibility parsing)`,
      'formatVersion',
    );
  }
  const course = obj.course as Record<string, unknown> | undefined;
  if (!course || typeof course !== 'object') {
    push('error', 'PACKAGE_MANIFEST_INVALID', 'course is required', 'course');
    return { report: { errors, warnings, incomplete: true } };
  }
  // C5：v2 不再有 course.category 字符串；出现即旧规格包，整体拒绝。
  if (Object.prototype.hasOwnProperty.call(course, 'category')) {
    push(
      'error',
      'PACKAGE_FORMAT_UNSUPPORTED',
      'course.category is not part of formatVersion 2; use course.categoryPath',
      'course.category',
    );
  }
  // C5：categoryPath 是必填字段（null = 未分类），缺失即旧规格包。
  if (!Object.prototype.hasOwnProperty.call(course, 'categoryPath')) {
    push(
      'error',
      'PACKAGE_FORMAT_UNSUPPORTED',
      'course.categoryPath is required in formatVersion 2',
      'course.categoryPath',
    );
  } else if (
    course.categoryPath !== null &&
    (!Array.isArray(course.categoryPath) ||
      !course.categoryPath.every(
        (segment) => typeof segment === 'string' && segment.trim().length > 0,
      ))
  ) {
    push(
      'error',
      'PACKAGE_FORMAT_UNSUPPORTED',
      'course.categoryPath must be null or an array of non-empty strings',
      'course.categoryPath',
    );
  }
  const str = (v: unknown, p: string, required = true): void => {
    if (
      required
        ? typeof v !== 'string' || !v
        : v != null && typeof v !== 'string'
    ) {
      push('error', 'PACKAGE_MANIFEST_INVALID', `${p} is required`, p);
    }
  };
  str(course.code, 'course.code');
  str(course.slug, 'course.slug');
  str(course.learningMode, 'course.learningMode');
  if (
    !Array.isArray(course.learningLanguages) ||
    course.learningLanguages.length === 0
  ) {
    push(
      'error',
      'PACKAGE_MANIFEST_INVALID',
      'course.learningLanguages is required',
      'course.learningLanguages',
    );
  }
  str(course.defaultContentLanguage, 'course.defaultContentLanguage');
  const localized = course.localized as Record<string, unknown> | undefined;
  if (!localized || typeof localized !== 'object') {
    push(
      'error',
      'PACKAGE_MANIFEST_INVALID',
      'course.localized is required',
      'course.localized',
    );
  }
  const lessons = course.lessons;
  if (!Array.isArray(lessons) || lessons.length === 0) {
    warnings.push({
      level: 'warning',
      code: 'COURSE_NO_LESSONS',
      path: 'course.lessons',
      message: 'course has no lessons',
    });
  }

  if (errors.length > 0) {
    return { report: { errors, warnings, incomplete: true } };
  }
  return {
    manifest: raw as PackageManifest,
    report: { errors, warnings, incomplete: false },
  };
}
