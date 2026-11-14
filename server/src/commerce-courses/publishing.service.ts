import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  COMMERCE_CONFIG,
  type CommerceCourseConfig,
  type VersionNumberingMode,
} from './commerce.config';
import {
  computeCompleteness,
  canExport,
  type CourseCompleteness,
} from './completeness';
import {
  applyVersionSnapshotInTx,
  captureVersionSnapshot,
  detailToCompletenessInput,
  snapshotToCompletenessInput,
  type VersionSnapshot,
} from './version-snapshot';
import { TrialService } from './trial.service';
import { snapshotContentHash } from './content-hash';

export interface VersionLabelResult {
  label: string;
  series: number;
  minor: number;
}

/** 纯函数：下一次发布的版本编号（PRD §15.3）。 */
export function nextVersionLabel(
  mode: VersionNumberingMode,
  last: {
    versionSeries: number;
    versionMinor: number;
    exportedAt?: Date | string | null;
  } | null,
): VersionLabelResult {
  if (mode === 'production') {
    const minor = (last?.versionMinor ?? 0) + 1;
    return { label: `Version ${minor}`, series: 0, minor };
  }
  if (!last) return { label: '1.1', series: 1, minor: 1 };
  if (last.exportedAt) {
    const series = last.versionSeries + 1;
    return { label: `${series}.1`, series, minor: 1 };
  }
  const minor = last.versionMinor + 1;
  return {
    label: `${last.versionSeries}.${minor}`,
    series: last.versionSeries,
    minor,
  };
}

export const HISTORY_ACTIONS = {
  PUBLISH: 'PUBLISH',
  DELETE_DRAFT: 'DELETE_DRAFT',
  RESTORE: 'RESTORE',
  EXPORT_PACKAGE: 'EXPORT_PACKAGE',
  IMPORT_PACKAGE: 'IMPORT_PACKAGE',
  CHANGE_STATUS: 'CHANGE_STATUS',
  OPERATIONS_PUBLISH: 'OPERATIONS_PUBLISH',
  CREATE_COURSE: 'CREATE_COURSE',
} as const;

@Injectable()
export class PublishingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trial: TrialService,
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {}

  /** 读取工作区（草稿）并计算完成度。 */
  async completenessForDraft(courseId: string): Promise<CourseCompleteness> {
    const [detail, trial] = await Promise.all([
      this.draftDetail(courseId),
      this.trial.get(courseId),
    ]);
    return computeCompleteness(
      detailToCompletenessInput({
        ...detail,
        trialRows: trial.rows
          .filter((row) => row.inTrial)
          .map((row) => ({
            lessonId: row.lessonId,
            status: row.status,
            videoCutoffSeconds: row.videoCutoffSeconds,
            textCutoffLearningPointId: row.textCutoffLearningPointId,
          })),
      }),
    );
  }

  async draftDetail(courseId: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      include: {
        category: true,
        cover: true,
        localizations: true,
        trialRows: true,
        lessons: {
          where: { archivedAt: null },
          orderBy: { sortOrder: 'asc' },
          include: {
            localizations: { include: { video: true } },
            exhibits: { include: { media: true, thumbnail: true } },
            readings: { orderBy: { sortOrder: 'asc' } },
            questions: { orderBy: { sortOrder: 'asc' } },
            applicationTest: true,
            learningPoints: { orderBy: { sortOrder: 'asc' } },
            triggers: true,
          },
        },
      },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    return course;
  }

  /** 发布草稿：生成不可变版本，立即成为本环境线上版本。 */
  async publish(
    courseId: string,
    actorEmployeeId: string | null,
    options?: { notifyLearners?: boolean },
  ) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        code: true,
        liveVersionId: true,
        liveStatus: true,
        draftRevision: true,
        liveBaseRevision: true,
        draftSourceType: true,
        draftSourceEnvironment: true,
        draftSourceVersionLabel: true,
        archivedAt: true,
      },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    if (course.archivedAt) {
      throw new ConflictException({
        code: 'COURSE_ARCHIVED',
        message: 'Archived course cannot be published',
      });
    }
    // C9/O1：No draft ⇔ draftRevision == liveBaseRevision（不再比较内容哈希）。
    if (course.draftRevision === course.liveBaseRevision) {
      throw new ConflictException({
        code: 'NO_DRAFT',
        message: 'There is no draft to publish.',
      });
    }

    const completeness = await this.completenessForDraft(courseId);
    if (!completeness.canPublish) {
      throw new ConflictException({
        code: 'PUBLISH_BLOCKED',
        message: completeness.publishBlockers.join(' '),
        blockers: completeness.publishBlockers,
      });
    }

    const source = this.resolveSource(course);
    // 锁住课程行后再取上一版本号、拍快照：两人同时点发布时第二个请求等第一个提交，
    // 然后看到草稿已发布返回 NO_DRAFT，不会撞 (courseId, versionNo) 唯一键变成 500。
    const version = await this.prisma.$transaction(
      async (tx) => {
        const [locked] = await tx.$queryRaw<
          {
            draftRevision: number;
            liveBaseRevision: number;
            liveVersionId: string | null;
          }[]
        >`
          SELECT "draftRevision", "liveBaseRevision", "liveVersionId"
          FROM "CommerceCourse" WHERE id = ${courseId} FOR UPDATE`;
        if (!locked || locked.draftRevision === locked.liveBaseRevision) {
          throw new ConflictException({
            code: 'NO_DRAFT',
            message: 'There is no draft to publish.',
          });
        }
        const snapshot = await captureVersionSnapshot(tx, courseId);
        // 仅供排查的诊断指纹；不参与 No draft/版本身份（C9/C0 红线）。
        const contentHash = await snapshotContentHash(tx, snapshot);
        const last = await tx.courseVersion.findFirst({
          where: { courseId },
          orderBy: { versionNo: 'desc' },
          select: {
            versionNo: true,
            versionSeries: true,
            versionMinor: true,
            exportedAt: true,
          },
        });
        const numbering = nextVersionLabel(
          this.config.versionNumberingMode,
          last,
        );
        const created = await tx.courseVersion.create({
          data: {
            courseId,
            versionNo: (last?.versionNo ?? 0) + 1,
            versionLabel: numbering.label,
            versionSeries: numbering.series,
            versionMinor: numbering.minor,
            sourceEnvironment: source.environment,
            sourceVersionLabel: source.label,
            snapshotData: snapshot as unknown as Prisma.InputJsonValue,
            contentHash,
            wentLiveAt: new Date(),
            createdBy: actorEmployeeId,
          },
        });
        await tx.commerceCourse.update({
          where: { id: courseId },
          data: {
            liveVersionId: created.id,
            // 首次发布后为 Offline；之后发布保持当前状态（PRD §17）
            liveStatus: course.liveVersionId ? course.liveStatus : 'OFFLINE',
            lifecycleStatus: 'LIVE',
            hasDraft: false,
            // C9：发布时冻结草稿基线 → No draft。
            liveBaseRevision: locked.draftRevision,
            draftSourceType: null,
            draftSourceEnvironment: null,
            draftSourceVersionLabel: null,
          },
        });
        await tx.courseAuthoringActivity.create({
          data: {
            courseId,
            versionNo: created.versionNo,
            actorEmployeeId,
            action: HISTORY_ACTIONS.PUBLISH,
            detail: {
              versionLabel: numbering.label,
              sourceEnvironment: source.environment,
              sourceVersionLabel: source.label,
              notifyLearners: Boolean(options?.notifyLearners),
            },
          },
        });
        return created;
      },
      { timeout: 30_000 },
    );

    return {
      versionId: version.id,
      versionLabel: version.versionLabel,
      versionNo: version.versionNo,
    };
  }

  private resolveSource(course: {
    draftSourceType: string | null;
    draftSourceEnvironment: string | null;
    draftSourceVersionLabel: string | null;
  }): { environment: string | null; label: string | null } {
    if (
      course.draftSourceType === 'RESTORE' &&
      course.draftSourceVersionLabel
    ) {
      return { environment: null, label: course.draftSourceVersionLabel };
    }
    if (course.draftSourceType === 'IMPORT' && course.draftSourceVersionLabel) {
      return {
        environment: course.draftSourceEnvironment,
        label: course.draftSourceVersionLabel,
      };
    }
    if (this.config.versionNumberingMode === 'production') {
      return { environment: null, label: null };
    }
    return { environment: null, label: null };
  }

  /** Delete draft：用线上版本覆盖草稿；从未发布时不可用。 */
  async deleteDraft(courseId: string, actorEmployeeId: string | null) {
    // 锁住课程行再判断和覆盖：重复点击或与发布同时发生时按顺序执行，第二次看到没有草稿返回 409。
    return this.prisma.$transaction(
      async (tx) => {
        const [course] = await tx.$queryRaw<
          {
            liveVersionId: string | null;
            draftRevision: number;
            liveBaseRevision: number;
          }[]
        >`
          SELECT "liveVersionId", "draftRevision", "liveBaseRevision"
          FROM "CommerceCourse" WHERE id = ${courseId} FOR UPDATE`;
        if (!course)
          throw new NotFoundException({
            code: 'COURSE_NOT_FOUND',
            message: 'Course not found',
          });
        if (
          !course.liveVersionId ||
          course.draftRevision === course.liveBaseRevision
        ) {
          throw new ConflictException({
            code: 'NO_DRAFT',
            message: 'There is no draft to delete. Publish a version first.',
          });
        }
        const live = await tx.courseVersion.findUnique({
          where: { id: course.liveVersionId },
          select: {
            id: true,
            versionNo: true,
            versionLabel: true,
            snapshotData: true,
          },
        });
        if (!live)
          throw new NotFoundException({
            code: 'VERSION_NOT_FOUND',
            message: 'Live version not found',
          });

        await applyVersionSnapshotInTx(
          tx,
          courseId,
          live.snapshotData as unknown as VersionSnapshot,
        );
        await tx.commerceCourse.update({
          where: { id: courseId },
          data: {
            hasDraft: false,
            // C9：草稿丢弃后回到线上基线（No draft）。
            draftRevision: course.liveBaseRevision,
            lifecycleStatus: 'LIVE',
            draftSourceType: null,
            draftSourceEnvironment: null,
            draftSourceVersionLabel: null,
          },
        });
        await tx.courseAuthoringActivity.create({
          data: {
            courseId,
            versionNo: live.versionNo,
            actorEmployeeId,
            action: HISTORY_ACTIONS.DELETE_DRAFT,
            detail: { keptVersion: live.versionLabel },
          },
        });
        return { deleted: true, keptVersion: live.versionLabel };
      },
      { timeout: 60_000 },
    );
  }

  /** Restore：把版本快照写入草稿，发布后才影响线上。 */
  async restore(
    courseId: string,
    versionId: string,
    actorEmployeeId: string | null,
  ) {
    const version = await this.prisma.courseVersion.findUnique({
      where: { id: versionId },
    });
    if (!version || version.courseId !== courseId) {
      throw new NotFoundException({
        code: 'VERSION_NOT_FOUND',
        message: 'Version not found',
      });
    }
    // 标记草稿、写快照、记历史在同一事务里：中途失败不会留下"有草稿但内容没恢复"的半成品。
    const hasDraft = await this.prisma.$transaction(
      async (tx) => {
        const [locked] = await tx.$queryRaw<
          {
            liveVersionId: string | null;
            draftRevision: number;
            liveBaseRevision: number;
          }[]
        >`
          SELECT "liveVersionId", "draftRevision", "liveBaseRevision"
          FROM "CommerceCourse" WHERE id = ${courseId} FOR UPDATE`;
        if (!locked)
          throw new NotFoundException({
            code: 'COURSE_NOT_FOUND',
            message: 'Course not found',
          });
        // C7：快照的分类解析失败会在写入任何内容前抛出 CATEGORY_NOT_FOUND。
        await applyVersionSnapshotInTx(
          tx,
          courseId,
          version.snapshotData as unknown as VersionSnapshot,
        );
        // C9：Restore 线上版本 → No draft；Restore 旧版本 → 有草稿。
        const isLiveVersion = version.id === locked.liveVersionId;
        const nextDraftRevision = isLiveVersion
          ? locked.liveBaseRevision
          : locked.draftRevision + 1;
        await tx.commerceCourse.update({
          where: { id: courseId },
          data: {
            hasDraft: !isLiveVersion,
            draftRevision: nextDraftRevision,
            lifecycleStatus: isLiveVersion ? 'LIVE' : 'WORKING',
            draftSourceType: 'RESTORE',
            draftSourceEnvironment: null,
            draftSourceVersionLabel: version.versionLabel,
          },
        });
        await tx.courseAuthoringActivity.create({
          data: {
            courseId,
            versionNo: version.versionNo,
            actorEmployeeId,
            action: HISTORY_ACTIONS.RESTORE,
            detail: { restoredFrom: version.versionLabel },
          },
        });
        return !isLiveVersion;
      },
      { timeout: 60_000 },
    );
    return { restoredFrom: version.versionLabel, hasDraft };
  }

  /** Change status：Online / Hidden / Offline，必须填原因；不生成版本。 */
  async changeStatus(
    courseId: string,
    body: { status: 'ONLINE' | 'HIDDEN' | 'OFFLINE'; reason?: string },
    actorEmployeeId: string | null,
  ) {
    const reason = (body.reason ?? '').trim();
    if (!reason) {
      throw new ConflictException({
        code: 'REASON_REQUIRED',
        message: 'A reason is required to change status.',
      });
    }
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { id: true, liveVersionId: true, liveStatus: true },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    if (!course.liveVersionId) {
      throw new ConflictException({
        code: 'NOT_PUBLISHED',
        message: 'Publish the course first.',
      });
    }
    const from = course.liveStatus;
    await this.prisma.$transaction([
      this.prisma.commerceCourse.update({
        where: { id: courseId },
        data: { liveStatus: body.status },
      }),
      this.prisma.courseAuthoringActivity.create({
        data: {
          courseId,
          actorEmployeeId,
          action: HISTORY_ACTIONS.CHANGE_STATUS,
          detail: { from, to: body.status, reason },
          reason,
        },
      }),
    ]);
    return { from, to: body.status, reason };
  }

  async listVersions(courseId: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { liveVersionId: true },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    const versions = await this.prisma.courseVersion.findMany({
      where: { courseId },
      orderBy: { versionNo: 'desc' },
      select: {
        id: true,
        versionNo: true,
        versionLabel: true,
        versionSeries: true,
        versionMinor: true,
        sourceEnvironment: true,
        sourceVersionLabel: true,
        wentLiveAt: true,
        exportedAt: true,
        createdAt: true,
        createdBy: true,
      },
    });
    return versions.map((version) => ({
      ...version,
      isLive: version.id === course.liveVersionId,
    }));
  }

  async getVersion(courseId: string, versionId: string) {
    const version = await this.prisma.courseVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        courseId: true,
        versionNo: true,
        versionLabel: true,
        sourceEnvironment: true,
        sourceVersionLabel: true,
        snapshotData: true,
        wentLiveAt: true,
        exportedAt: true,
      },
    });
    if (!version || version.courseId !== courseId) {
      throw new NotFoundException({
        code: 'VERSION_NOT_FOUND',
        message: 'Version not found',
      });
    }
    return version;
  }

  /** 导出前检查：线上版本必须存在且 3 步完成（PRD §16.2）。 */
  async assertExportable(courseId: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        code: true,
        liveVersionId: true,
        trialEnabled: true,
        trialRows: {
          select: {
            lessonId: true,
            status: true,
            videoCutoffSeconds: true,
            textCutoffLearningPointId: true,
          },
        },
      },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    if (!course.liveVersionId) {
      throw new ConflictException({
        code: 'EXPORT_REQUIRES_LIVE_VERSION',
        message: 'Publish the course before exporting.',
      });
    }
    const live = await this.prisma.courseVersion.findUnique({
      where: { id: course.liveVersionId },
      select: { id: true, versionLabel: true, snapshotData: true },
    });
    if (!live)
      throw new NotFoundException({
        code: 'VERSION_NOT_FOUND',
        message: 'Live version not found',
      });
    const trial = await this.trial.get(courseId);
    const completeness = computeCompleteness(
      snapshotToCompletenessInput(
        live.snapshotData as unknown as VersionSnapshot,
        {
          trialEnabled: course.trialEnabled,
          trialRows: trial.rows
            .filter((row) => row.inTrial)
            .map((row) => ({
              lessonId: row.lessonId,
              status: row.status,
              videoCutoffSeconds: row.videoCutoffSeconds,
              textCutoffLearningPointId: row.textCutoffLearningPointId,
            })),
        },
      ),
    );
    if (!canExport(completeness)) {
      throw new ConflictException({
        code: 'VERSION_INCOMPLETE',
        message:
          'This version is incomplete. Complete all 3 steps, publish, then export.',
        blockers: [
          ...completeness.steps.courseInformation.missing,
          ...completeness.steps.content.missing,
          ...completeness.steps.trial.missing,
        ],
      });
    }
    return { versionId: live.id, versionLabel: live.versionLabel };
  }

  async markExported(versionId: string, actorEmployeeId: string | null) {
    const version = await this.prisma.courseVersion.update({
      where: { id: versionId },
      data: { exportedAt: new Date(), exportedBy: actorEmployeeId },
      select: { id: true, courseId: true, versionNo: true, versionLabel: true },
    });
    await this.prisma.courseAuthoringActivity.create({
      data: {
        courseId: version.courseId,
        versionNo: version.versionNo,
        actorEmployeeId,
        action: HISTORY_ACTIONS.EXPORT_PACKAGE,
        detail: { versionLabel: version.versionLabel },
      },
    });
    return version;
  }

  /** History：只读、分页（PRD §21）。 */
  async listHistory(
    courseId: string,
    query: { page?: number; pageSize?: number },
  ) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const where = { courseId };
    const [rows, total] = await Promise.all([
      this.prisma.courseAuthoringActivity.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.courseAuthoringActivity.count({ where }),
    ]);
    const actorIds = [
      ...new Set(
        rows
          .map((row) => row.actorEmployeeId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const employees = actorIds.length
      ? await this.prisma.employee.findMany({
          where: { employeeId: { in: actorIds } },
          select: { employeeId: true, loginEmail: true },
        })
      : [];
    const nameById = new Map(
      employees.map((employee) => [
        employee.employeeId,
        employee.loginEmail.split('@')[0] ?? employee.loginEmail,
      ]),
    );
    return {
      items: rows.map((row) => ({
        id: row.id.toString(),
        time: row.createdAt,
        operator: row.actorEmployeeId
          ? (nameById.get(row.actorEmployeeId) ?? row.actorEmployeeId)
          : 'System',
        action: row.action,
        versionNo: row.versionNo,
        detail: row.detail,
      })),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async recordHistory(
    courseId: string | null,
    action: string,
    detail: unknown,
    actorEmployeeId: string | null,
    versionNo?: number,
  ) {
    return this.prisma.courseAuthoringActivity.create({
      data: {
        courseId,
        versionNo: versionNo ?? null,
        action,
        detail: detail ?? {},
        actorEmployeeId,
      },
    });
  }
}
