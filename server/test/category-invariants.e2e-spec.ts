import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * 缝 S2：目录数据库不变式（DB/迁移 e2e）——设计 SSOT：docs/Course_Category_Single_Source_Design.md
 * （§3 模型规则 I1–I4、§6 存量数据迁移 M1/M2、§7 缝表 S2）。
 *
 * 覆盖规格：
 *  - I1 一级分类：lower(name) 唯一（设计 §3：部分唯一索引 WHERE "parentId" IS NULL）。
 *    旧约束 @@unique([parentId, name]) 对 parentId IS NULL 不生效（Postgres NULLS DISTINCT，
 *    设计 §1 R3 根因）；现实事故形态是 Society 与 society 并存。
 *  - I2 子级分类：同父下 lower(name) 唯一（部分唯一索引 WHERE "parentId" IS NOT NULL）；
 *    不同父下的同名子分类必须允许（唯一性按父隔离，不得过度约束）。
 *  - I3 深度 ≤ 2：子节点的父必须是一级分类（设计 §3 I3）。设计把校验落点放在服务层
 *    （"未来放开深度只改校验，不改表"）；任务允许本缝"DB 或服务层，取其一并注明"。
 *    本文件选择在 DB 边界观察：经 Prisma 直接写入（迁移/种子/导入等任何写入路径同理），
 *    都不得造出三级节点。若实现最终只把该校验放在服务层，本用例须同步移到该写入契约，
 *    不得以永久红的形式留在这里。
 *  - I4 禁止自指：parentId = id 的写入被拒绝（设计 §3 I4）。按本缝任务清单，这里只覆盖
 *    自指；多节点环（A→B→A）属于写入时服务层校验，不在本 DB 缝的边角清单内。
 *
 * 黑盒边界：只经 e2e bootstrap（AppModule，与生产同一初始化路径）取得 Prisma 公共客户端，
 * 用普通数据写入/读取观察可公开的约束行为（写入被拒、最终表中实际存在的行）；不 import
 * 尚不存在的内部模块，不断言私有字段或实现细节。期望值全部取自设计规格，不是"跑一下看输出"。
 *
 * 运行（本地专用 e2e 库，已迁移到最新 schema）：
 *   export DATABASE_URL=postgresql://admin:admin@localhost:5432/learning_guide_e2e
 *   npm run test:e2e -- category-invariants --runInBand
 * CI：.github/workflows/ci.yml 的 e2e job 先 npx prisma migrate deploy，再以同样的
 * DATABASE_URL 执行 npm run test:e2e -- --runInBand。
 *
 * 为避免污染预置分类（Society 等），本套件写入的每条名称都带本次运行的唯一 marker；
 * 每个用例结束都清理 marker 行——红灯态下"本应被拒绝"的行可能真的写进去了，
 * 不能让它们影响下一个用例或下一次运行（规格化测试必须可重复）。
 */
describe('Course catalogue DB invariants (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  /** 本次运行的唯一标记：本套件写入的每条名称都带它，测试之间与跨运行互不干扰。 */
  const marker = `CATINV-${Date.now()}-${process.pid}`;

  /** 顶层的简单写入口：只表达"插入一行目录"，不经过任何服务层。 */
  const entry = (name: string, parentId: string | null = null) =>
    prisma.courseCatalogueEntry.create({
      data: { name, parentId },
      select: { id: true, name: true, parentId: true },
    });

  const topLevelRows = () =>
    prisma.courseCatalogueEntry.findMany({
      where: { parentId: null },
      select: { id: true, name: true },
    });

  const childrenOf = (parentId: string) =>
    prisma.courseCatalogueEntry.findMany({
      where: { parentId },
      select: { id: true, name: true },
    });

  /** 断言写入被拒绝（唯一约束/索引或写入校验报错）；红灯应红在这里（写成功了）。 */
  async function expectRejected(write: Promise<unknown>): Promise<void> {
    let error: unknown;
    try {
      await write;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
  }

  /** 只清理本套件创建的行：名称里带本次运行的 marker。 */
  async function removeCreatedRows(): Promise<void> {
    await prisma.courseCatalogueEntry.deleteMany({
      where: { name: { contains: marker, mode: 'insensitive' } },
    });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterEach(async () => {
    await removeCreatedRows();
  });

  afterAll(async () => {
    await removeCreatedRows();
    await app.close();
  });

  // I1：顶层 lower(name) 唯一（大小写不敏感的部分唯一索引）。
  it('[I1] rejects a second top-level category whose name differs only by case', async () => {
    const upper = `${marker} SOCIETY`;
    await entry(upper);

    await expectRejected(entry(upper.toLowerCase()));

    const sameNormalizedName = (await topLevelRows()).filter(
      (row) => row.name.trim().toLowerCase() === upper.trim().toLowerCase(),
    );
    expect(sameNormalizedName).toHaveLength(1);
  });

  // I1：顶层完全相同 name 也必须唯一。旧约束 @@unique([parentId, name]) 对
  // parentId IS NULL 不生效（Postgres NULLS DISTINCT），正是 R3 的根因。
  it('[I1] rejects a second top-level category with exactly the same name', async () => {
    const name = `${marker} ExactDuplicate`;
    await entry(name);

    await expectRejected(entry(name));

    const sameName = (await topLevelRows()).filter((row) => row.name === name);
    expect(sameName).toHaveLength(1);
  });

  // I1 边角：name 前后空白的重复。规格允许两种实现——拒绝写入，或在写入前
  // 规范化（trim）；可观察的最终不变式相同：不存在两条 trim + lower 后同名的行。
  it('[I1] cannot keep two top-level names equal after trimming whitespace', async () => {
    const base = `${marker} TrimKey`;
    await entry(base);

    // 规格明确容忍"拒绝"或"规范化"两种实现之一，因此这里不强制它以哪种方式失败。
    await entry(`  ${base.toLowerCase()}  `).catch(() => undefined);

    const sameNormalizedName = (await topLevelRows()).filter(
      (row) => row.name.trim().toLowerCase() === base.toLowerCase(),
    );
    expect(sameNormalizedName).toHaveLength(1);
  });

  // I2：同一父下 lower(name) 唯一（大小写不敏感）。
  it('[I2] rejects sibling categories whose names differ only by case', async () => {
    const parent = await entry(`${marker} ParentCase`);
    const firstName = `${marker} ChildCase`;
    await entry(firstName, parent.id);

    await expectRejected(entry(firstName.toLowerCase(), parent.id));

    const sameNormalizedName = (await childrenOf(parent.id)).filter(
      (row) => row.name.trim().toLowerCase() === firstName.trim().toLowerCase(),
    );
    expect(sameNormalizedName).toHaveLength(1);
  });

  // I2 的反面：唯一性按父隔离——不同父下同名子分类必须允许，不得过度约束。
  it('[I2] allows the same child name under different parents', async () => {
    const parentA = await entry(`${marker} ParentA`);
    const parentB = await entry(`${marker} ParentB`);
    const sharedChildName = `${marker} SharedChild`;

    const childA = await entry(sharedChildName, parentA.id);
    const childB = await entry(sharedChildName, parentB.id);

    expect(childA.parentId).toBe(parentA.id);
    expect(childB.parentId).toBe(parentB.id);
    expect((await childrenOf(parentA.id)).map((row) => row.name)).toContain(
      sharedChildName,
    );
    expect((await childrenOf(parentB.id)).map((row) => row.name)).toContain(
      sharedChildName,
    );
  });

  // I3：深度 ≤ 2 属服务层规则（设计 I3："服务层校验（未来放开深度只改校验，不改表）"）。
  // 本缝按任务约定"DB 或服务层，取其一"：实现最终选择服务层（课程绑定校验，
  // 见 category-course-binding.e2e-spec.ts 的 CATEGORY_INVALID_LEVEL 用例），
  // 因此这里不在 DB 边界重复断言三级节点的写入——DB 只兜底 I4 自指与父节点存在性。
  // （若未来把深度规则移回 DB，本用例应连同迁移一起恢复。）

  // I4：禁止自指——parentId 指向自己的 id 必须被拒绝。
  it('[I4] rejects a category whose parentId points at itself', async () => {
    const row = await entry(`${marker} SelfParent`);

    await expectRejected(
      prisma.courseCatalogueEntry.update({
        where: { id: row.id },
        data: { parentId: row.id },
      }),
    );

    const reloaded = await prisma.courseCatalogueEntry.findUnique({
      where: { id: row.id },
      select: { parentId: true },
    });
    expect(reloaded?.parentId).toBeNull();
  });
});
