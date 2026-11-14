import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CourseStorageService } from './storage.service';
import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';
import { PackageInspector, PackageError } from './package-inspector';
import { PackageImporter, ImportError } from './package-importer';
import type {
  PackageManifest,
  PackageValidationReport,
} from './contracts/manifest';
import type { PackageManifestV2 } from '../partc/contracts/package-manifest';
import { PackageManifestV2Schema } from '../partc/contracts/package-manifest';
import { isPartCV2Manifest } from './partc-import';
import { runImportWorker } from './heavy-tasks';
import { packageSourceEnforcementFromEnv } from '../partc/compiler/parse';
import { PricingService } from './pricing.service';
import { PublishingService } from './publishing.service';

export interface JobReport {
  errors: PackageValidationReport['errors'];
  warnings: PackageValidationReport['warnings'];
  /** 结构性摘要（Part C：contract/courseKey/lessonCount/mediaCount）。 */
  details?: Record<string, unknown>;
}

export interface JobView {
  jobId: string;
  kind: string;
  status: string;
  stage: string | null;
  progress: number;
  error: string | null;
  courseId: string | null;
  sourceVersionId: string | null;
  fileLabel: string | null;
  package: {
    packageId: string;
    courseCode: string;
    slug: string;
    lessons: number;
    mediaFiles: number;
    incomplete: boolean;
  } | null;
  conflicts: unknown;
  /**
   * 等待确认阶段预先判定的 Course ID 冲突（仅「从包新建」的导入作业）：
   * 便于前端在点「导入课程」之前就提示「覆盖草稿 / 已上线拒绝」。
   */
  conflict: {
    existingCourseCode: string;
    existingCourseId: string;
    live: boolean;
  } | null;
  report: JobReport;
}

/**
 * C10.6 生产导入来源门（PACKAGE_SOURCE_ENFORCEMENT=on 时启用）。
 *
 * 顺序固定：先按 PackageManifestV2Schema（唯一契约 SSOT）严格校验整包，再判来源。
 * - 整包不满足 v2 契约（legacy 聚合形状、缺 categoryPath、未知字段、伪造结构）
 *   → PACKAGE_SOURCE_NOT_ALLOWED：生产只接受 Sandbox 导出的 v2 包；
 * - v2 包 provenance 缺失或 sourceEnv !== 'sandbox' → PACKAGE_SOURCE_NOT_ALLOWED；
 * - 判定只看服务端解析出的字段，绝不依据文件名/路径/声明位置（C10.6）。
 */
function assertConfirmPackageSourceAllowed(raw: unknown): void {
  const parsed = PackageManifestV2Schema.safeParse(raw);
  if (!parsed.success) {
    throw new ImportError(
      'PACKAGE_SOURCE_NOT_ALLOWED',
      422,
      'Production imports only accept Part C v2 course packages exported from a sandbox environment; this package does not satisfy the v2 contract.',
    );
  }
  const provenance = parsed.data.provenance;
  if (provenance === undefined || provenance.sourceEnv !== 'sandbox') {
    throw new ImportError(
      'PACKAGE_SOURCE_NOT_ALLOWED',
      422,
      'Production imports only accept course packages exported from a sandbox environment.',
    );
  }
}

/**
 * 课程包导入/导出作业（DB 队列 + FOR UPDATE SKIP LOCKED，见设计文档 §20）。
 * 上传 → 校验 → AWAITING_CONFIRM → 确认导入；导出 → READY → 下载。
 */
@Injectable()
export class PackageJobsService {
  private readonly logger = new Logger(PackageJobsService.name);
  // 分块上传单块大小：远小于边缘（CloudFront/App Runner）的单请求限制，保证每块都快速完整传�?
  private static readonly RAW_CHUNK_BYTES = 5 * 1024 * 1024;
  // 允许分块比约定略大一点点的容差（避免末端对齐误差导致误判�?
  private static readonly RAW_CHUNK_SLACK_BYTES = 1024;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CourseStorageService,
    private readonly inspector: PackageInspector,
    private readonly importer: PackageImporter,
    private readonly pricing: PricingService,
    private readonly publishing: PublishingService,
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {}

  // ===== 原始素材分块上传的公共小工具 =====

  /** 分块�?staging 中的键（�?index 块）�?*/
  private rawChunkKey(jobId: string, index: number): string {
    return this.storage.stagingKey(jobId, `rawchunk/${index}`);
  }

  /** 按总字节数推算应有的分块数量（至少 1 块）�?*/
  private chunkCountFor(bytesTotal: number): number {
    return Math.max(
      1,
      Math.ceil(bytesTotal / PackageJobsService.RAW_CHUNK_BYTES),
    );
  }

  /** 读取一个仍处于上传中的作业；不存在 �?404，状态不�?�?409�?*/
  private async requireUploadingJob(jobId: string) {
    const job = await this.prisma.coursePackageJob.findUnique({
      where: { id: jobId },
    });
    if (!job)
      throw new PackageError('PACKAGE_JOB_NOT_FOUND', 404, 'Job not found.');
    if (job.stage !== 'UPLOADING') {
      throw new PackageError(
        'RAW_UPLOAD_NOT_ACTIVE',
        409,
        'Upload is not in progress for this job.',
      );
    }
    return job;
  }

  /** 幂等键命中则返回既有作业，否�?null�?*/
  private findJobByIdempotencyKey(idempotencyKey?: string) {
    if (!idempotencyKey) return Promise.resolve(null);
    return this.prisma.coursePackageJob.findUnique({
      where: { idempotencyKey },
    });
  }

  /** 生成未被占用的兜底课程编号：TEMP001、TEMP002…（基于现有 TEMP* 课程自增）。 */
  private async nextTempCourseCode(): Promise<string> {
    const rows = await this.prisma.commerceCourse.findMany({
      where: { code: { startsWith: 'TEMP' } },
      select: { code: true },
    });
    let max = 0;
    for (const { code } of rows) {
      const m = /^TEMP(\d+)$/i.exec(code);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `TEMP${String(max + 1).padStart(3, '0')}`;
  }

  /** 只读诊断：确认当前存储驱动（S3 或本地）。 */
  storageInfo() {
    return this.storage.describe();
  }

  // ===== 导入 =====
  async createImportJob(
    file: { name: string; bytes: Buffer },
    actorEmployeeId: string | null,
    idempotencyKey?: string,
    targetCourseId?: string,
  ) {
    if (idempotencyKey) {
      const existing = await this.prisma.coursePackageJob.findUnique({
        where: { idempotencyKey },
      });
      if (existing) return this.getJob(existing.id);
    }
    if (file.bytes.length > this.config.packageDirectUploadBytes) {
      throw new PackageError(
        'PACKAGE_TOO_LARGE',
        413,
        'Package too large for direct upload; use chunked upload.',
      );
    }
    const jobId = randomUUID();
    const storageKey = this.storage.stagingKey(jobId, 'package.zip');
    await this.storage.putStaging(storageKey, file.bytes);
    await this.prisma.coursePackageJob.create({
      data: {
        id: jobId,
        kind: 'IMPORT',
        status: 'VALIDATING',
        actorEmployeeId,
        courseId: targetCourseId ?? null,
        idempotencyKey: idempotencyKey ?? null,
        sourceFileName: file.name,
        bytesTotal: file.bytes.length,
        bytesReceived: file.bytes.length,
        packageHash: CourseStorageService.sha256(file.bytes),
        storageKey,
        progress: 10,
      },
    });
    // 同步校验（P1a：包通常较小；大包改�?worker 处理�?
    await this.runValidation(jobId, file.bytes);
    return this.getJob(jobId);
  }

  /**
   * 原始素材导入：上传含 xlsx + 媒体（docx/mp4/png）的 ZIP�?
   * 先转换成标准课程包，再走常规「导入作�?�?校验 �?确认导入」流程�?
   *
   * 转换 + 校验是耗时�?CPU/内存重活：这里只把原始包落盘、建作业就立即返回，
   * 真正的处理放到后台线程执行，前端轮询 import/:jobId。避�?~150MB 素材�?
   * 在网关（CloudFront / App Runner）上因请求超时直�?5xx�?
   */
  async createRawImportJob(
    file: { name: string; bytes: Buffer },
    actorEmployeeId: string | null,
    idempotencyKey?: string,
  ) {
    const existing = await this.findJobByIdempotencyKey(idempotencyKey);
    if (existing) return this.getJob(existing.id);
    if (file.bytes.length > this.config.packageMaxBytes) {
      throw new PackageError(
        'PACKAGE_TOO_LARGE',
        413,
        'Raw materials archive exceeds size limit.',
      );
    }
    const jobId = randomUUID();
    const rawKey = this.storage.stagingKey(jobId, 'raw.zip');
    await this.storage.putStaging(rawKey, file.bytes);
    await this.prisma.coursePackageJob.create({
      data: {
        id: jobId,
        kind: 'IMPORT',
        status: 'VALIDATING',
        stage: 'RAW_QUEUED',
        actorEmployeeId,
        idempotencyKey: idempotencyKey ?? null,
        sourceFileName: file.name,
        bytesTotal: file.bytes.length,
        bytesReceived: file.bytes.length,
        progress: 5,
      },
    });
    // 后台转换 + 校验（不阻塞上传请求）；结果写回同一�?jobId，由前端轮询�?
    void this.processRawImport(jobId, rawKey).catch(() => undefined);
    return this.getJob(jobId);
  }

  /** 后台把原始素材包转成课程包并校验，复用同一�?jobId，供前端轮询�?*/
  private async processRawImport(jobId: string, rawKey: string): Promise<void> {
    try {
      const rawBytes = await this.storage.getStaging(rawKey);
      await this.runRawProcessing(jobId, rawBytes);
    } catch (error) {
      await this.markRawFailed(jobId, error);
    } finally {
      await this.storage.removeStaging(rawKey).catch(() => undefined);
    }
  }

  /** 把原始素�?ZIP 的字节转成课程包并校验（转换/校验都在 worker 线程里做）�?*/
  private async runRawProcessing(
    jobId: string,
    rawBytes: Buffer,
  ): Promise<void> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-raw-'));
    try {
      const rawPath = path.join(tmp, 'raw.zip');
      const outPath = path.join(tmp, 'package.zip');
      await fs.writeFile(rawPath, rawBytes);
      // 旧模板若没有 Course ID 字段，用一个不重复的 TEMP 编号兜底（TEMP001、TEMP002…）；
      // 若 Excel 里带了 Course ID，worker 会优先用它，忽略这里传入的兜底值。
      const fallbackCode = await this.nextTempCourseCode();
      const built = await runImportWorker<{
        warnings: string[];
        courseCode: string;
        slug: string;
        title: string;
        lessonCount: number;
        mediaCount: number;
      }>('raw', { rawPath, outPath, courseCode: fallbackCode });
      const pkgBytes = await fs.readFile(outPath);
      const pkgKey = this.storage.stagingKey(jobId, 'package.zip');
      await this.storage.putStaging(pkgKey, pkgBytes);
      await this.prisma.coursePackageJob.update({
        where: { id: jobId },
        data: {
          storageKey: pkgKey,
          bytesTotal: pkgBytes.length,
          packageHash: CourseStorageService.sha256(pkgBytes),
          sourceFileName: `${built.courseCode}.lgcourse.zip`,
          progress: 40,
          stage: 'VALIDATING',
        },
      });
      await this.runValidation(jobId, pkgBytes);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async markRawFailed(jobId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : '原始素材解析失败';
    await this.prisma.coursePackageJob
      .update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          error: message,
          progress: 100,
          stage: 'FAILED',
        },
      })
      .catch(() => undefined);
  }

  /**
   * 分块上传会话：大素材包（�?150MB+）单�?POST 会被 CloudFront/App Runner
   * 的回源限制中途切断。这里改成前端分块、逐块上传，每块都是小请求�?
   * 这里只建作业，返�?jobId 与建议块大小�?
   */
  async createRawUploadSession(
    file: { name: string; bytesTotal: number },
    actorEmployeeId: string | null,
    idempotencyKey?: string,
  ) {
    const existing = await this.findJobByIdempotencyKey(idempotencyKey);
    if (existing)
      return {
        jobId: existing.id,
        chunkSize: PackageJobsService.RAW_CHUNK_BYTES,
      };
    if (!Number.isFinite(file.bytesTotal) || file.bytesTotal <= 0) {
      throw new PackageError(
        'INVALID_INPUT',
        400,
        'bytesTotal is required for a chunked upload.',
      );
    }
    if (file.bytesTotal > this.config.packageMaxBytes) {
      throw new PackageError(
        'PACKAGE_TOO_LARGE',
        413,
        'Raw materials archive exceeds size limit.',
      );
    }
    const jobId = randomUUID();
    await this.prisma.coursePackageJob.create({
      data: {
        id: jobId,
        kind: 'IMPORT',
        status: 'VALIDATING',
        stage: 'UPLOADING',
        actorEmployeeId,
        idempotencyKey: idempotencyKey ?? null,
        sourceFileName: file.name,
        bytesTotal: file.bytesTotal,
        bytesReceived: 0,
        progress: 0,
      },
    });
    return { jobId, chunkSize: PackageJobsService.RAW_CHUNK_BYTES };
  }

  /** 写入单个分块�?staging，更新进度。每块很小，走的是普通小请求�?*/
  async appendRawChunk(
    jobId: string,
    index: number,
    bytes: Buffer,
  ): Promise<{ jobId: string; progress: number }> {
    const job = await this.requireUploadingJob(jobId);
    if (!Number.isInteger(index) || index < 0) {
      throw new PackageError('INVALID_INPUT', 400, 'Invalid chunk index.');
    }
    if (
      bytes.length >
      PackageJobsService.RAW_CHUNK_BYTES +
        PackageJobsService.RAW_CHUNK_SLACK_BYTES
    ) {
      throw new PackageError('PACKAGE_TOO_LARGE', 413, 'Chunk too large.');
    }
    await this.storage.putStaging(this.rawChunkKey(jobId, index), bytes);
    const total = job.bytesTotal ?? 0;
    const expected = this.chunkCountFor(total);
    const progress = Math.min(85, Math.round(((index + 1) / expected) * 85));
    await this.prisma.coursePackageJob.update({
      where: { id: jobId },
      data: {
        bytesReceived: Math.round((total * (index + 1)) / expected),
        progress,
      },
    });
    return { jobId, progress };
  }

  /** 全部分块到达后：合并为原始素材包，后台转�?+ 校验�?*/
  async completeRawUpload(jobId: string): Promise<JobView> {
    const job = await this.requireUploadingJob(jobId);
    const total = job.bytesTotal ?? 0;
    if (!total) {
      throw new PackageError('INVALID_INPUT', 400, 'Missing upload size.');
    }
    const count = this.chunkCountFor(total);
    for (let i = 0; i < count; i++) {
      const present = await this.storage.hasStaging(this.rawChunkKey(jobId, i));
      if (!present) {
        throw new PackageError(
          'RAW_UPLOAD_INCOMPLETE',
          400,
          `Missing chunk ${i + 1}/${count}.`,
        );
      }
    }
    await this.prisma.coursePackageJob.update({
      where: { id: jobId },
      data: { stage: 'RAW_QUEUED', progress: 88 },
    });
    void this.assembleAndProcessRaw(jobId, count).catch(() => undefined);
    return this.getJob(jobId);
  }

  private async assembleAndProcessRaw(
    jobId: string,
    count: number,
  ): Promise<void> {
    try {
      const parts: Buffer[] = [];
      for (let i = 0; i < count; i++) {
        parts.push(await this.storage.getStaging(this.rawChunkKey(jobId, i)));
      }
      const rawBytes = Buffer.concat(parts);
      await this.runRawProcessing(jobId, rawBytes);
    } catch (error) {
      await this.markRawFailed(jobId, error);
    } finally {
      for (let i = 0; i < count; i++) {
        await this.storage
          .removeStaging(this.rawChunkKey(jobId, i))
          .catch(() => undefined);
      }
    }
  }

  /**
   * 本地目录导入：服务端直接读取仓库内素材目录（�?docs/modeling-life），
   * 打包为原始素�?ZIP 后走原始素材导入流程。用于规避浏览器上传超大文件中断�?
   */
  async createLocalRawImportJob(
    options: { dir?: string; courseCode?: string; slug?: string },
    actorEmployeeId: string | null,
  ) {
    const rel = (options.dir || 'docs/modeling-life').trim();
    const repoRoot = path.resolve(process.cwd(), '..');
    const base = path.resolve(repoRoot, rel);
    if (base !== repoRoot && !base.startsWith(repoRoot + path.sep)) {
      throw new PackageError(
        'RAW_DIR_INVALID',
        400,
        'Directory is outside the repository.',
      );
    }
    // 递归收集子目录文件（flatten �?zip 根：素材/模板可能放在嵌套文件夹里�?
    const files: { name: string; full: string }[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        if (dir === base) {
          throw new PackageError(
            'RAW_DIR_NOT_FOUND',
            404,
            `Directory not found: ${rel}`,
          );
        }
        return;
      }
      for (const name of entries) {
        if (
          name.startsWith('.') ||
          name.startsWith('~$') ||
          name === '__MACOSX'
        )
          continue;
        const full = path.join(dir, name);
        const stat = await fs.stat(full);
        if (stat.isDirectory()) await walk(full);
        else if (stat.isFile()) files.push({ name, full });
      }
    };
    await walk(base);
    if (!files.length) {
      throw new PackageError(
        'RAW_DIR_EMPTY',
        400,
        `Directory has no importable files: ${rel}`,
      );
    }
    const zip = new JSZip();
    for (const file of files) {
      zip.file(file.name, await fs.readFile(file.full));
    }
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    return this.createRawImportJob(
      { name: `${path.basename(base)}.zip`, bytes },
      actorEmployeeId,
    );
  }

  private async runValidation(
    jobId: string,
    providedBytes?: Buffer,
  ): Promise<void> {
    const job = await this.prisma.coursePackageJob.findUnique({
      where: { id: jobId },
    });
    if (!job || !job.storageKey) return;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-ins-'));
    try {
      // 调用方手里已有同一份字节时直接复用，避免再�?staging 读回整包（少一份大缓冲�?
      const zipBytes =
        providedBytes ?? (await this.storage.getStaging(job.storageKey));
      const packagePath = path.join(tmp, 'package.zip');
      const outDir = path.join(tmp, 'files');
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(packagePath, zipBytes);
      // 解压 + 全面校验�?CPU 重活，放�?worker 线程，避免阻塞事件循�?
      const result = await runImportWorker<{
        manifest: PackageManifest | PackageManifestV2;
        report: PackageValidationReport;
        files: string[];
      }>('inspect', { packagePath, outDir, config: this.config });
      const details =
        result.report.details && typeof result.report.details === 'object'
          ? result.report.details
          : undefined;
      await this.prisma.coursePackageJob.update({
        where: { id: jobId },
        data: {
          status:
            result.report.errors.length > 0 ? 'FAILED' : 'AWAITING_CONFIRM',
          stage: 'VALIDATED',
          progress: 100,
          manifest: result.manifest as unknown as Prisma.InputJsonValue,
          report: {
            errors: result.report.errors,
            warnings: result.report.warnings,
            ...(details ? { details } : {}),
          } as unknown as Prisma.InputJsonValue,
          error:
            result.report.errors.length > 0
              ? result.report.errors[0].message
              : null,
        },
      });
      // 暂存解压内容�?staging（媒体二进制 + manifest�?
      await this.persistExtractedFromDir(
        jobId,
        outDir,
        result.files,
        result.manifest,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Validation failed';
      const report = (error as { report?: PackageValidationReport }).report;
      await this.prisma.coursePackageJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          error: message,
          progress: 100,
          ...(report
            ? {
                report: {
                  errors: report.errors,
                  warnings: report.warnings,
                } as unknown as Prisma.InputJsonValue,
              }
            : {}),
        },
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async persistExtractedFromDir(
    jobId: string,
    outDir: string,
    names: string[],
    manifest: PackageManifest | PackageManifestV2,
  ): Promise<void> {
    for (const name of names) {
      const bytes = await fs.readFile(path.join(outDir, name));
      await this.storage.putStaging(
        this.storage.stagingKey(jobId, name),
        bytes,
      );
    }
    await this.storage.putStaging(
      this.storage.stagingKey(jobId, '__manifest.json'),
      Buffer.from(JSON.stringify(manifest)),
    );
  }

  async confirmImport(
    jobId: string,
    body: {
      onConflict: 'ABORT' | 'CREATE_NEW_COURSE' | 'NEW_VERSION';
      reassignCodes?: boolean;
      overwriteDraft?: boolean;
    },
    actorEmployeeId: string | null,
  ) {
    const job = await this.prisma.coursePackageJob.findUnique({
      where: { id: jobId },
    });
    if (!job)
      throw new PackageError('PACKAGE_JOB_NOT_FOUND', 404, 'Job not found.');

    // 读取已校验的包清单（用于判定 Course ID 冲突）。清单缺失不在这里直接拒绝：
    // 先按 AWAITING_CONFIRM 条件认领（双击/并发只允许一个确认进入导入），
    // 认领成功的一侧再按导入失败处理——避免两个并发确认都停在 409。
    let manifest: PackageManifest | PackageManifestV2 | null = null;
    try {
      const manifestBytes = await this.storage.getStaging(
        this.storage.stagingKey(jobId, '__manifest.json'),
      );
      manifest = JSON.parse(manifestBytes.toString('utf8')) as
        PackageManifest | PackageManifestV2;
    } catch {
      // 清单缺失：见下方认领后的失败处理（并发确认的 409 语义只保留在认领竞争上）。
    }

    // 目标课程：来自「导入到已有课程」（Versions 页）时直接写入该课草稿，始终允许。
    let targetCourseId: string | null = job.courseId;

    if (!targetCourseId && manifest) {
      // 从包新建：按 Course ID（Part C courseKey / 旧包 course.code）判断是否已存在
      const courseKey = isPartCV2Manifest(manifest)
        ? String(manifest.course.courseKey)
        : manifest.course.code;
      const existing = await this.prisma.commerceCourse.findFirst({
        where: { code: courseKey },
        select: { id: true, code: true, liveVersionId: true },
      });
      if (existing) {
        if (existing.liveVersionId) {
          // 已上线课程：拒绝，避免影响线上内容（保持作业可取消，不置为 FAILED）
          return {
            jobId,
            status: job.status,
            refused: 'COURSE_ALREADY_LIVE' as const,
            existingCourseCode: existing.code,
            message: `Course ${existing.code} is already live. The import is refused: only draft courses (never published) can be overwritten, so live content is never affected.`,
          };
        }
        if (!body.overwriteDraft) {
          // 草稿课程：询问是否覆盖（不改动作业状态，等待用户确认）
          return {
            jobId,
            status: job.status,
            requiresOverwrite: true as const,
            existingCourseId: existing.id,
            existingCourseCode: existing.code,
          };
        }
        // 用户确认覆盖 → 替换该草稿课程的沙盒草稿内容
        targetCourseId = existing.id;
      }
    }
    // 条件认领：只有一次确认能把任务从 AWAITING_CONFIRM 拿到 IMPORTING�?
    // 双击或两人同时确认不会把同一个包导入两次
    const claimed = await this.prisma.coursePackageJob.updateMany({
      where: { id: jobId, status: 'AWAITING_CONFIRM' },
      data: { status: 'IMPORTING', progress: 0 },
    });
    if (claimed.count === 0) {
      const current = await this.prisma.coursePackageJob.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      throw new PackageError(
        'PACKAGE_JOB_NOT_FOUND',
        409,
        `Job not awaiting confirm (status=${current?.status ?? job.status}).`,
      );
    }
    try {
      // 认领者拿到任务后才发现清单缺失：按导入失败处理（不占 409 的并发语义）。
      if (!manifest) {
        throw new PackageError(
          'PACKAGE_MANIFEST_MISSING',
          409,
          'Package manifest is no longer available; please re-upload the package.',
        );
      }
      // C10.6：来源强制（PACKAGE_SOURCE_ENFORCEMENT，默认休眠）。开启后生产环境
      // 只接受 provenance.sourceEnv === 'sandbox'；判定只看服务端解析出的字段，
      // 不看文件名/路径。off 时完全不做来源判断（现状不变）。
      //
      // 来源门先做整包契约校验（PackageManifestV2Schema 唯一 SSOT）：
      // legacy 聚合形状（course.lessons 等，评审阻断 2）与完全私造的 manifest
      // 无法通过 v2 契约，即使伪造 provenance 也一律 PACKAGE_SOURCE_NOT_ALLOWED，
      // 绝不让 legacy 包借伪造 provenance 混进生产。
      if (
        packageSourceEnforcementFromEnv() &&
        this.config.versionNumberingMode === 'production'
      ) {
        assertConfirmPackageSourceAllowed(manifest);
      }
      const files = await this.loadStagingFiles(jobId, manifest);
      const { courseId } = targetCourseId
        ? await this.importer.importIntoExistingCourse(
            targetCourseId,
            manifest,
            files,
            actorEmployeeId,
          )
        : await this.importer.importPackage(manifest, files, {
            onConflict: body.onConflict,
            reassignCodes: body.reassignCodes ?? false,
            actorEmployeeId,
          });
      await this.prisma.coursePackageJob.update({
        where: { id: jobId },
        data: { status: 'READY', progress: 100, courseId, stage: 'COMMITTED' },
      });
      await this.storage.clearStagingPrefix(jobId);
      // 导入完成后在目标环境重新创建 Stripe 产品/价格（失败不阻断导入�?
      const plans = await this.prisma.coursePlan.findMany({
        where: { courseId, active: true },
        select: { id: true },
      });
      await Promise.all(
        plans.map((plan) =>
          this.pricing.syncPlan(courseId, plan.id).catch(() => undefined),
        ),
      );
      return { jobId, status: 'READY', courseId };
    } catch (error) {
      const code = error instanceof ImportError ? error.code : 'INTERNAL_ERROR';
      const status = error instanceof ImportError ? error.status : 500;
      const message = error instanceof Error ? error.message : 'Import failed';
      const report =
        error instanceof ImportError && error.report
          ? {
              errors: error.report.errors,
              warnings: error.report.warnings,
            }
          : undefined;
      await this.prisma.coursePackageJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          error: message,
          ...(report ? { report: report } : {}),
        },
      });
      throw new PackageError(code, status, message);
    }
  }

  private async loadStagingFiles(
    jobId: string,
    manifest: PackageManifest | PackageManifestV2,
  ): Promise<Map<string, Buffer>> {
    const files = new Map<string, Buffer>();
    if (isPartCV2Manifest(manifest)) {
      for (const resource of manifest.resources) {
        try {
          const bytes = await this.storage.getStaging(
            this.storage.stagingKey(jobId, resource.path),
          );
          files.set(resource.path, bytes);
        } catch {
          // 缺失由导入阶段报 PACKAGE_FILE_MISSING（闭合包一一对应）。
        }
      }
      return files;
    }
    const collect = (rel: string | undefined) => {
      if (rel) files.set(rel, Buffer.alloc(0));
    };
    if (manifest.course.cover) collect(manifest.course.cover);
    for (const lesson of manifest.course.lessons ?? []) {
      for (const loc of Object.values(lesson.localized ?? {}))
        collect(loc.video?.file);
      for (const ex of lesson.exhibits ?? []) {
        collect(ex.file);
        collect(ex.thumbnail);
      }
    }
    for (const rel of [...files.keys()]) {
      try {
        const bytes = await this.storage.getStaging(
          this.storage.stagingKey(jobId, rel),
        );
        files.set(rel, bytes);
      } catch {
        // 缺失由导入阶段报 PACKAGE_MEDIA_INVALID
      }
    }
    return files;
  }

  async cancelJob(jobId: string) {
    const job = await this.prisma.coursePackageJob.findUnique({
      where: { id: jobId },
    });
    if (!job)
      throw new PackageError('PACKAGE_JOB_NOT_FOUND', 404, 'Job not found.');
    // 条件取消：与"确认导入"同时发生时，已开始导入的任务不会被标成已取消、删掉暂存文�?
    const cancelled = await this.prisma.coursePackageJob.updateMany({
      where: { id: jobId, status: { notIn: ['READY', 'IMPORTING'] } },
      data: { status: 'CANCELLED', cancelRequested: true },
    });
    if (cancelled.count === 0) {
      throw new PackageError(
        'PACKAGE_JOB_NOT_FOUND',
        409,
        'Job cannot be cancelled.',
      );
    }
    await this.storage.clearStagingPrefix(jobId);
    return { jobId, status: 'CANCELLED' };
  }

  async getJob(jobId: string): Promise<JobView> {
    const job = await this.prisma.coursePackageJob.findUnique({
      where: { id: jobId },
    });
    if (!job)
      throw new PackageError('PACKAGE_JOB_NOT_FOUND', 404, 'Job not found.');
    const manifest = job.manifest as PackageManifest | PackageManifestV2 | null;
    const report = job.report as JobReport | null;
    return {
      jobId: job.id,
      kind: job.kind,
      status: job.status,
      stage: job.stage,
      progress: job.progress ?? 0,
      error: job.error,
      courseId: job.courseId,
      sourceVersionId: job.sourceVersionId,
      fileLabel: job.fileLabel,
      package: manifest
        ? isPartCV2Manifest(manifest)
          ? {
              packageId:
                manifest.packageId ?? `pkg_${manifest.course.courseKey}`,
              courseCode: String(manifest.course.courseKey),
              slug:
                typeof manifest.annotations?.slug === 'string'
                  ? manifest.annotations.slug
                  : String(manifest.course.courseKey).toLowerCase(),
              lessons: Number(report?.details?.lessonCount ?? 0),
              mediaFiles: manifest.resources.length,
              incomplete: (report?.warnings.length ?? 0) > 0,
            }
          : {
              packageId: manifest.packageId,
              courseCode: manifest.course.code,
              slug: manifest.course.slug,
              lessons: manifest.course.lessons?.length ?? 0,
              mediaFiles: this.countMedia(manifest),
              incomplete: manifest.incomplete,
            }
        : null,
      conflicts: job.conflicts,
      conflict: await this.detectCourseCodeConflict(job, manifest),
      report: report ?? { errors: [], warnings: [] },
    };
  }

  /**
   * 仅对「从包新建」的导入作业，在 Course ID 已存在时给出预判：
   * live=true 表示已上线（应拒绝覆盖），否则为可覆盖的草稿。
   */
  private async detectCourseCodeConflict(
    job: { courseId: string | null; kind: string },
    manifest: PackageManifest | PackageManifestV2 | null,
  ): Promise<{
    existingCourseCode: string;
    existingCourseId: string;
    live: boolean;
  } | null> {
    if (!manifest || job.courseId || job.kind !== 'IMPORT') return null;
    const courseKey = isPartCV2Manifest(manifest)
      ? String(manifest.course.courseKey)
      : manifest.course.code;
    const existing = await this.prisma.commerceCourse.findFirst({
      where: { code: courseKey },
      select: { id: true, code: true, liveVersionId: true },
    });
    if (!existing) return null;
    return {
      existingCourseCode: existing.code,
      existingCourseId: existing.id,
      live: Boolean(existing.liveVersionId),
    };
  }

  private countMedia(manifest: PackageManifest): number {
    let n = manifest.course.cover ? 1 : 0;
    for (const lesson of manifest.course.lessons ?? []) {
      for (const loc of Object.values(lesson.localized ?? {}))
        if (loc.video?.file) n++;
      for (const ex of lesson.exhibits ?? [])
        n += (ex.file ? 1 : 0) + (ex.thumbnail ? 1 : 0);
    }
    return n;
  }

  async listJobs(actorEmployeeId: string | null) {
    return this.prisma.coursePackageJob.findMany({
      where: actorEmployeeId ? { actorEmployeeId } : {},
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        kind: true,
        status: true,
        progress: true,
        sourceFileName: true,
        courseId: true,
        error: true,
        createdAt: true,
      },
    });
  }

  // ===== 导出 =====
  // 默认导出线上版本；versionLabel='working'/'draft' 导出当前草稿（不产生版本）；
  // 其他值按版本号导出历史快照�?
  async startExport(
    courseId: string,
    actorEmployeeId: string | null,
    versionLabel?: string,
  ) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { code: true },
    });
    if (!course) {
      throw new PackageError('COURSE_NOT_FOUND', 404, 'Course not found.');
    }
    let sourceVersionId: string | null;
    let label: string;
    if (versionLabel === 'working' || versionLabel === 'draft') {
      // 草稿导出：不走版本快照，�?worker 从当前工作区聚合打包
      sourceVersionId = null;
      label = 'draft';
    } else if (versionLabel) {
      // 指定了版本号：直接查找对应快�?
      const v = await this.prisma.courseVersion.findFirst({
        where: { courseId, versionLabel },
        select: { id: true, versionLabel: true },
      });
      if (!v) {
        throw new PackageError(
          'PACKAGE_VERSION_NOT_FOUND',
          404,
          `Version ${versionLabel} not found for this course.`,
        );
      }
      sourceVersionId = v.id;
      label = v.versionLabel;
    } else {
      // 默认：导出线上发布版�?
      const exportable = await this.publishing.assertExportable(courseId);
      sourceVersionId = exportable.versionId;
      label = exportable.versionLabel;
    }
    const fileLabel = `${course.code}_${label}.zip`;
    const jobId = randomUUID();
    await this.prisma.coursePackageJob.create({
      data: {
        id: jobId,
        kind: 'EXPORT',
        status: 'EXPORTING',
        courseId,
        actorEmployeeId,
        sourceVersionId,
        fileLabel,
        progress: 0,
      },
    });
    return {
      jobId,
      status: 'EXPORTING',
      versionId: sourceVersionId,
      versionLabel: label,
      fileName: fileLabel,
    };
  }
}
