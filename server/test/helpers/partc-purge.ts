import type { PrismaService } from '../../src/prisma/prisma.service';

/**
 * 清除一门 Part C 课程的全部本地行（测试专用；courseKey 必须属于本套件）。
 *
 * 顺序受 FK 约束：事件/达成 → 审批/发布/内容版本/plan → 对齐 →
 * rendition/block/spec/evidence/objective/media → 边 → stage → course。
 * 只做 cleanup/arrange，不用于业务断言。
 *
 * 发布产物 PcContentVersion 是 append-only（DB 触发器拒绝 DELETE），又被
 * PcPublication / PcPlanApproval / PcCourse 引用；不删掉它们，PcCourse 的
 * DELETE 会因 FK（onDelete: Restrict）失败，残留一行 pc_course，破坏串跑链路
 * 中后续套件的空库前置。这里在一个事务里先删子行，并按会话临时绕过不可变
 * 触发器：`session_replication_role` 的 `true` 表示 transaction-local，只作用于
 * 本事务连接，范围仅限本套件的唯一 courseKey。它不改产品/迁移行为，仅是测试清理。
 *
 * `mediaUriFragments` 用于回收测试导入产生的媒体资产行（uri 含 courseId）：
 * 资产行按 (assetKey, assetVersion) upsert，不属于任何 Part C 外键，只按载体
 * key 删除会漏掉封面/字幕等非 rendition 载体，故由调用方显式给出本套件的 courseId。
 */
export async function purgePartcCourse(
  prisma: PrismaService,
  courseKey: string,
  mediaUriFragments: readonly string[] = [],
): Promise<void> {
  const stages = await prisma.pcStage
    .findMany({ where: { courseKey }, select: { stageKey: true } })
    .catch(() => []);
  const stageKeys = stages.map((stage) => stage.stageKey);
  const plans = await prisma.pcPlan
    .findMany({ where: { courseKey }, select: { planId: true } })
    .catch(() => []);
  const planIds = plans.map((plan) => plan.planId);
  const specs = await prisma.pcContentSpec
    .findMany({ where: { courseKey }, select: { contentKey: true } })
    .catch(() => []);
  const contentKeys = specs.map((spec) => spec.contentKey);
  const renditionRows = contentKeys.length
    ? await prisma.pcRendition
        .findMany({
          where: { contentKey: { in: contentKeys } },
          select: { carrierKey: true },
        })
        .catch(() => [])
    : [];
  const carrierKeys = [...new Set(renditionRows.map((row) => row.carrierKey))];
  const versions = await prisma.pcContentVersion
    .findMany({ where: { courseKey }, select: { contentVersionId: true } })
    .catch(() => []);
  const contentVersionIds = versions.map((version) => version.contentVersionId);

  await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT set_config('session_replication_role', 'replica', true)`,
    );
    if (contentVersionIds.length) {
      await tx.pcLearningEvent.deleteMany({
        where: { contentVersionId: { in: contentVersionIds } },
      });
      await tx.pcEvidenceAttainment.deleteMany({
        where: { contentVersionId: { in: contentVersionIds } },
      });
    }
    await tx.pcPublication.deleteMany({ where: { courseKey } });
    if (planIds.length) {
      await tx.pcPlanApproval.deleteMany({
        where: { planId: { in: planIds } },
      });
    }
    // ContentVersion 引用 Plan（planId/planVersion, Restrict），必须先删版本。
    await tx.pcContentVersion.deleteMany({ where: { courseKey } });
    await tx.pcPlan.deleteMany({ where: { courseKey } });
  });
  if (stageKeys.length) {
    await prisma.pcAlignment
      .deleteMany({ where: { stageKey: { in: stageKeys } } })
      .catch(() => undefined);
    await prisma.pcPrerequisiteEdge
      .deleteMany({
        where: {
          OR: [
            { fromStageKey: { in: stageKeys } },
            { toStageKey: { in: stageKeys } },
          ],
        },
      })
      .catch(() => undefined);
  }
  if (contentKeys.length) {
    await prisma.pcRendition
      .deleteMany({ where: { contentKey: { in: contentKeys } } })
      .catch(() => undefined);
    await prisma.pcBlock
      .deleteMany({ where: { contentKey: { in: contentKeys } } })
      .catch(() => undefined);
    await prisma.pcContentSpec
      .deleteMany({ where: { contentKey: { in: contentKeys } } })
      .catch(() => undefined);
  }
  const objectives = await prisma.pcObjective
    .findMany({ where: { courseKey }, select: { objectiveKey: true } })
    .catch(() => []);
  if (objectives.length) {
    await prisma.pcObjective
      .deleteMany({
        where: { objectiveKey: { in: objectives.map((o) => o.objectiveKey) } },
      })
      .catch(() => undefined);
  }
  if (carrierKeys.length) {
    await prisma.pcMediaAsset
      .deleteMany({
        where: {
          assetKey: { in: carrierKeys },
          assetVersion: 1,
        },
      })
      .catch(() => undefined);
  }
  if (mediaUriFragments.length) {
    await prisma.pcMediaAsset
      .deleteMany({
        where: {
          OR: mediaUriFragments.map((fragment) => ({
            uri: { contains: fragment },
          })),
        },
      })
      .catch(() => undefined);
  }
  const evidenceKeys = new Set<string>();
  for (const stage of stages) {
    const row = await prisma.pcStage
      .findUnique({
        where: { stageKey: stage.stageKey },
        select: { exitEvidence: true },
      })
      .catch(() => null);
    row?.exitEvidence.forEach((key) => evidenceKeys.add(key));
  }
  if (evidenceKeys.size) {
    await prisma.pcEvidenceSpec
      .deleteMany({ where: { evidenceKey: { in: [...evidenceKeys] } } })
      .catch(() => undefined);
  }
  if (stageKeys.length) {
    await prisma.pcStage
      .deleteMany({ where: { stageKey: { in: stageKeys } } })
      .catch(() => undefined);
  }
  await prisma.pcCourse
    .deleteMany({ where: { courseKey } })
    .catch(() => undefined);
}
