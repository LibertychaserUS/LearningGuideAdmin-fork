import { HttpException } from '@nestjs/common';
import JSZip from 'jszip';
import type {
  PackageCourse,
  PackageManifest,
  PackageValidationReport,
} from './contracts/manifest';
import type { PackageManifestV2 } from '../partc/contracts/package-manifest';
import { PartCError } from '../partc/errors';
import { validateManifestShape } from './manifest.validate';
import { validateCourseContent } from './package-validate';
import { validateMediaFile, MediaValidationError } from './media-validate';
import {
  compilePartcPackage,
  decodeTemplateWorkbook,
  isPartCV2Manifest,
  reportFromIssues,
  reportFromPartCError,
  templateResourcePathOf,
  PartcCompileError,
} from './partc-import';
import type { CommerceCourseConfig } from './commerce.config';
import { CourseStorageService } from './storage.service';

export interface ExtractedPackage {
  manifest: PackageManifest | PackageManifestV2;
  files: Map<string, Buffer>;
}

export class PackageError extends HttpException {
  readonly code: string;
  readonly httpStatus: number;
  readonly reason: string;
  constructor(code: string, status: number, message: string) {
    super({ code, message }, status);
    this.code = code;
    this.httpStatus = status;
    this.reason = message;
  }
}

/** 校验失败且带有结构化报告（C5：job report 必须带错误码与源坐标）。 */
export class PackageValidationError extends PackageError {
  constructor(
    code: string,
    status: number,
    message: string,
    readonly report: PackageValidationReport,
  ) {
    super(code, status, message);
  }
}

const MAX_ENTRIES = 10_000;

/**
 * 课程包解析 + 全面校验（解压、manifest、媒体、内容完整性、冲突）。
 * 纯逻辑，不落库；结果供导入作业消费。见设计文档 §5.4。
 *
 * 资源完整性不使用任何 checksums/摘要清单（C0 红线⑦：全系统不使用
 * 哈希/digest 做身份或完整性权威）：Part C v2 包靠闭合 resources + 大小校验，
 * legacy 包不再校验 checksums.sha256（raw 素材导入已退役）。
 */
export class PackageInspector {
  constructor(
    private readonly config: CommerceCourseConfig,
    private readonly storage: CourseStorageService,
  ) {}

  /** 安全解压 + 校验，返回 manifest 与文件表。 */
  async inspect(zipBytes: Buffer): Promise<{
    manifest: PackageManifest | PackageManifestV2;
    files: Map<string, Buffer>;
    report: PackageValidationReport;
  }> {
    if (zipBytes.length > this.config.packageMaxBytes) {
      throw new PackageError(
        'PACKAGE_TOO_LARGE',
        413,
        'Course package exceeds size limit.',
      );
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(zipBytes);
    } catch {
      throw new PackageError(
        'PACKAGE_INVALID_ZIP',
        400,
        'Invalid or corrupt ZIP.',
      );
    }

    const entries = Object.values(zip.files).filter((f) => !f.dir);
    if (entries.length > MAX_ENTRIES) {
      throw new PackageError(
        'PACKAGE_INVALID_ZIP',
        400,
        'Too many files in package.',
      );
    }

    let total = 0;
    const files = new Map<string, Buffer>();
    for (const entry of entries) {
      const name = entry.name;
      if (name.includes('..') || name.startsWith('/') || name.includes('\\')) {
        throw new PackageError(
          'PACKAGE_INVALID_ZIP',
          400,
          `Illegal path in package: ${name}`,
        );
      }
      const bytes = await entry.async('nodebuffer');
      total += bytes.length;
      if (total > this.config.packageMaxBytes) {
        throw new PackageError(
          'PACKAGE_TOO_LARGE',
          413,
          'Unpacked package exceeds size limit.',
        );
      }
      files.set(name, bytes);
    }

    const manifestBytes = files.get('manifest.json');
    if (!manifestBytes) {
      // A .docx/.pptx/.xlsx is also a ZIP; give a clear message instead of "missing manifest".
      const looksLikeOfficeDoc =
        files.has('word/document.xml') ||
        files.has('[Content_Types].xml') ||
        files.has('word/') ||
        [...files.keys()].some((n) => n.startsWith('word/'));
      throw new PackageError(
        'PACKAGE_NOT_A_COURSE',
        422,
        looksLikeOfficeDoc
          ? 'This looks like a Word/Office document, not a course package. Word/PDF are lesson materials; upload a .lgcourse.zip course package instead.'
          : 'manifest.json is missing — this is not a course package. Upload a .lgcourse.zip course package.',
      );
    }
    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      throw new PackageError(
        'PACKAGE_MANIFEST_INVALID',
        400,
        'manifest.json is not valid JSON.',
      );
    }

    // 契约分派：Part C v2（唯一 v2 SSOT）走编译器校验；旧聚合形状走既有校验。
    if (isPartCV2Manifest(rawManifest)) {
      return this.inspectPartcPackage(rawManifest, files);
    }

    const shape = validateManifestShape(rawManifest);
    if (!shape.manifest || shape.report.errors.length > 0) {
      throw new PackageValidationError(
        shape.report.errors[0]?.code ?? 'PACKAGE_MANIFEST_INVALID',
        400,
        firstError(shape.report),
        shape.report,
      );
    }

    // 媒体校验
    const mediaWarnings: PackageValidationReport['warnings'] = [];
    for (const [, ref] of collectMediaRefs(shape.manifest.course)) {
      const bytes = files.get(ref);
      if (!bytes) {
        throw new PackageError(
          'PACKAGE_MEDIA_INVALID',
          422,
          `Missing media file: ${ref}`,
        );
      }
      try {
        validateMediaFile(
          { name: ref.split('/').pop() ?? ref, bytes: files.get(ref)! },
          this.config,
        );
      } catch (error) {
        if (error instanceof MediaValidationError) {
          throw new PackageError(
            'PACKAGE_MEDIA_INVALID',
            422,
            `${ref}: ${error.message}`,
          );
        }
        throw error;
      }
    }

    const content = validateCourseContent(shape.manifest.course, {
      forAction: 'import',
    });
    const report: PackageValidationReport = {
      errors: [...shape.report.errors, ...content.errors],
      warnings: [
        ...shape.report.warnings,
        ...content.warnings,
        ...mediaWarnings,
      ],
      incomplete: content.incomplete,
    };
    return { manifest: shape.manifest, files, report };
  }

  /**
   * Part C v2 包校验：闭合包、模板 v2、媒体签名、编译器 P1–P4。
   * 只读校验（不落库）：blocking error → PackageValidationError（job FAILED）；
   * incomplete/warning 只入报告（允许入库、阻止发布，C5 P2）。
   */
  private inspectPartcPackage(
    manifest: PackageManifestV2,
    files: Map<string, Buffer>,
  ): {
    manifest: PackageManifestV2;
    files: Map<string, Buffer>;
    report: PackageValidationReport;
  } {
    try {
      const templatePath = templateResourcePathOf(manifest);
      const templateBytes = files.get(templatePath);
      if (!templateBytes) {
        throw new PartCError(
          'PACKAGE_FILE_MISSING',
          'manifest.resources declares a template that is missing from the package',
          { path: templatePath },
        );
      }
      const mediaKinds = new Set([
        'cover',
        'video',
        'audio',
        'image',
        'model3d',
        'thumbnail',
      ]);
      for (const resource of manifest.resources) {
        const bytes = files.get(resource.path);
        if (!bytes) {
          throw new PartCError(
            'PACKAGE_FILE_MISSING',
            'manifest.resources declares a file that is missing from the package',
            { path: resource.path, id: resource.id, kind: resource.kind },
          );
        }
        if (!mediaKinds.has(resource.kind)) continue;
        try {
          validateMediaFile(
            {
              name: resource.path.split('/').pop() ?? resource.path,
              bytes,
            },
            this.config,
          );
        } catch (error) {
          throw new PackageError(
            'PACKAGE_MEDIA_INVALID',
            422,
            `${resource.path}: ${error instanceof MediaValidationError ? error.message : 'invalid media'}`,
          );
        }
      }
      const workbook = decodeTemplateWorkbook(templateBytes);
      const compiled = compilePartcPackage({
        manifest,
        files: files,
        workbook,
      });
      const report = reportFromIssues(compiled.issues);
      return {
        manifest,
        files,
        report: {
          ...report,
          details: {
            contract: 'partc-v2',
            courseKey: String(manifest.course.courseKey),
            lessonCount: new Set(
              compiled.rows.lessons.map((row) => row.value.lesson_code),
            ).size,
            mediaCount: compiled.rows.media.length,
          },
        },
      };
    } catch (error) {
      if (error instanceof PartcCompileError) {
        throw new PackageValidationError(
          error.code,
          422,
          error.message,
          error.report,
        );
      }
      if (error instanceof PartCError) {
        const report = reportFromPartCError(error);
        throw new PackageValidationError(
          error.code,
          422,
          error.message,
          report,
        );
      }
      throw error;
    }
  }
}

function firstError(report: PackageValidationReport): string {
  return report.errors[0]?.message ?? 'Invalid manifest.';
}

/** 遍历 manifest，收集所有媒体相对路径（cover/video/exhibit/thumbnail）。 */
export function collectMediaRefs(
  course: PackageCourse,
): Array<[string, string]> {
  const refs: Array<[string, string]> = [];
  if (course.cover) refs.push(['cover', course.cover]);
  for (const lesson of course.lessons ?? []) {
    for (const [, loc] of Object.entries(lesson.localized ?? {})) {
      if (loc.video?.file) refs.push(['video', loc.video.file]);
    }
    for (const ex of lesson.exhibits ?? []) {
      if (ex.file) refs.push(['exhibit', ex.file]);
      if (ex.thumbnail) refs.push(['thumbnail', ex.thumbnail]);
    }
  }
  return refs;
}
