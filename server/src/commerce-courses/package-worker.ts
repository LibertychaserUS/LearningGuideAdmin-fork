import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CourseStorageService } from './storage.service';
import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';
import { buildCoursePackage, buildCoursePackageFromSnapshot } from './exporter';
import { PublishingService } from './publishing.service';

/**
 * 导出作业 worker（DB 队列 + FOR UPDATE SKIP LOCKED，见设计文档 §20）。
 * 每实例启动一个轮询循环，多实例安全。导入在 P1a 走同步校验+确认，导出走此 worker。
 */
@Injectable()
export class PackageWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PackageWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly instanceId = `w-${process.pid}-${Date.now().toString(36)}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CourseStorageService,
    private readonly publishing: PublishingService,
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.jobPollMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.reclaimStale();
      for (let i = 0; i < this.config.jobConcurrency; i++) {
        const claimed = await this.claimExport();
        if (!claimed) break;
        await this.runExport(claimed);
      }
    } catch (error) {
      this.logger.warn(
        `worker tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async reclaimStale(): Promise<void> {
    const staleBefore = new Date(Date.now() - this.config.jobStaleMs);
    await this.prisma.coursePackageJob.updateMany({
      where: {
        status: 'EXPORTING',
        OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }],
      },
      data: { status: 'EXPORTING', lockedBy: null, lockedAt: null },
    });
  }

  private async claimExport() {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        courseId: string | null;
        sourceVersionId: string | null;
        actorEmployeeId: string | null;
      }>
    >`
      UPDATE "CoursePackageJob"
      SET "lockedBy" = ${this.instanceId}, "lockedAt" = now(), "heartbeatAt" = now(),
          "attempts" = "attempts" + 1
      WHERE "id" = (
        SELECT "id" FROM "CoursePackageJob"
        WHERE "kind" = 'EXPORT' AND "status" = 'EXPORTING' AND "lockedBy" IS NULL
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
        ORDER BY "createdAt"
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING "id", "courseId", "sourceVersionId", "actorEmployeeId";
    `;
    return rows[0] ?? null;
  }

  private async runExport(job: {
    id: string;
    courseId: string | null;
    sourceVersionId: string | null;
    actorEmployeeId: string | null;
  }): Promise<void> {
    if (!job.courseId) {
      await this.prisma.coursePackageJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', error: 'Missing courseId for export' },
      });
      return;
    }
    try {
      await this.prisma.coursePackageJob.update({
        where: { id: job.id },
        data: { progress: 30, stage: 'PACKING' },
      });
      // sourceVersionId 为空 = 导出当前草稿（不产生版本、不标记 Exported）
      const built = job.sourceVersionId
        ? await buildCoursePackageFromSnapshot(
            this.prisma,
            this.storage,
            job.courseId,
            {
              versionId: job.sourceVersionId,
              environment: this.config.environmentLabel,
              exportedBy: job.actorEmployeeId ?? undefined,
              sourceEnv: this.config.versionNumberingMode,
            },
          )
        : await this.buildDraftPackage(
            job.courseId,
            job.actorEmployeeId ?? undefined,
          );
      const storageKey = this.storage.stagingKey(job.id, 'export.zip');
      await this.storage.putStaging(storageKey, built.bytes);
      await this.prisma.coursePackageJob.update({
        where: { id: job.id },
        data: {
          status: 'READY',
          progress: 100,
          stage: 'READY',
          storageKey,
          bytesTotal: built.bytes.length,
          fileLabel: built.fileName,
        },
      });
      // 导出后该版本标记 Exported；下一次 Sandbox 发布进入下一整数系列。
      // 草稿导出没有版本，跳过标记。
      if (job.sourceVersionId) {
        await this.publishing.markExported(
          job.sourceVersionId,
          job.actorEmployeeId,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Export failed';
      this.logger.error(
        `Export job ${job.id} failed: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.prisma.coursePackageJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', error: message },
      });
    }
  }

  /** 草稿导出：从当前工作区聚合直接打包（未发布的课程也能导出）。 */
  private async buildDraftPackage(
    courseId: string,
    exportedBy?: string,
  ): Promise<{ bytes: Buffer; fileName: string; versionLabel: string }> {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { code: true },
    });
    if (!course) throw new Error('Course not found');
    const bytes = await buildCoursePackage(
      this.prisma,
      this.storage,
      courseId,
      'draft',
      {
        exportedBy,
        sourceEnv: this.config.versionNumberingMode,
        versionLabel: 'draft',
      },
    );
    return {
      bytes,
      fileName: `${course.code}_draft.zip`,
      versionLabel: 'draft',
    };
  }

  /** 导出下载：读 staging 的 export.zip。 */
  async readExport(jobId: string): Promise<Buffer | null> {
    const job = await this.prisma.coursePackageJob.findUnique({
      where: { id: jobId },
    });
    if (!job || job.status !== 'READY' || !job.storageKey) return null;
    return this.storage.getStaging(job.storageKey);
  }
}
