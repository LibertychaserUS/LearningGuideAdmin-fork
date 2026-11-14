import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { signInAs } from './helpers/employee-session';
import type { ErrorResponse, SuccessResponse } from './helpers/http-response';

/**
 * 缝 S1：分类读接口（HTTP e2e）。
 * 设计 SSOT：docs/Course_Category_Single_Source_Design.md（§4 Admin 接口契约、§7 缝表）。
 *
 * 覆盖规格：
 * - C1 GET /api/portal/v1/categories
 *   · 响应包络 {success:true,data:[...],error:null,message}；
 *   · 只含 ACTIVE；树形嵌套 children；按 sortOrder 升序、同序按 name；
 *   · node = {name, localized, sortOrder, children}，契约不暴露 UUID（不依赖 id）；
 *   · localized 至少含 en-GB 与 zh-CN（预置 Society 中文 = 社会）；
 *   · 四个预置分类（Science / Chinese Humanities / European Humanities / Society）都在
 *     —— 其中 Science 由 M6 幂等种子迁移补齐（S2 负责落地，本断言按 SSOT 先红）；
 *   · 缓存头 Cache-Control: private, max-age=60。
 * - C1 鉴权：AUTH_ENABLED=true 时 /api/portal/** 必须带正确 X-API-Key，
 *   缺失/错误 → 401，正确 → 200。
 * - C2 GET /api/backoffice/courses/categories（保留）：形状不变 {id,name,localized}，
 *   只返回一级 ACTIVE，按 sortOrder,name。
 * - I6（§3）：全部归档时 C1 的 data 为空数组（退场只有 ARCHIVED）。
 *
 * 黑盒边界：所有断言只经 HTTP（supertest）观察；Prisma 仅用于 arrange/cleanup
 * （分类管理没有 HTTP 写入口，设计 §2 非目标：分类由开发预置）。节点一律用稳定键
 * name 识别，不断言、不依赖 UUID；不 import 尚未实现的内部模块。
 */

interface CatalogueNode {
  name: string;
  localized: Record<string, { name?: string; description?: string }>;
  sortOrder: number;
  children: CatalogueNode[];
}

interface BackofficeCategoryRow {
  id: string;
  name: string;
  localized: Record<string, { name?: string }>;
}

const marker = `S1-E2E-${Date.now()}-${process.pid}`;
const categoryName = (label: string) => `${marker} ${label}`;

/** 设计 C1 的四个预置一级分类（M6）。 */
const PRESET_CATEGORIES = [
  'Science',
  'Chinese Humanities',
  'European Humanities',
  'Society',
] as const;

describe('Category read APIs (e2e): S1 / C1 + C2', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  interface Fixture {
    id: string;
    name: string;
  }

  let parent: Fixture;
  let childA: Fixture;
  let childB: Fixture;
  let childArchived: Fixture;
  let tieA: Fixture;
  let tieB: Fixture;
  let archivedTop: Fixture;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const toFixture = { id: true, name: true } as const;
    const localized = (label: string, zhLabel: string) => ({
      'en-GB': { name: categoryName(label) },
      'zh-CN': { name: `${marker} ${zhLabel}` },
    });

    // 树形与同序排序的活动节点。
    parent = await prisma.courseCatalogueEntry.create({
      data: {
        name: categoryName('Parent'),
        localized: localized('Parent', '父级'),
        sortOrder: 900,
      },
      select: toFixture,
    });
    childA = await prisma.courseCatalogueEntry.create({
      data: {
        name: categoryName('Child A'),
        localized: localized('Child A', '子级甲'),
        parentId: parent.id,
        sortOrder: 1,
      },
      select: toFixture,
    });
    childB = await prisma.courseCatalogueEntry.create({
      data: {
        name: categoryName('Child B'),
        localized: localized('Child B', '子级乙'),
        parentId: parent.id,
        sortOrder: 5,
      },
      select: toFixture,
    });
    // 归档节点（一级 + 二级）都不得出现在读接口里。
    childArchived = await prisma.courseCatalogueEntry.create({
      data: {
        name: categoryName('Child Archived'),
        localized: localized('Child Archived', '归档子级'),
        parentId: parent.id,
        sortOrder: 0,
        status: 'ARCHIVED',
      },
      select: toFixture,
    });
    // sortOrder 相同 → 按 name 升序。
    tieA = await prisma.courseCatalogueEntry.create({
      data: {
        name: categoryName('Tie A'),
        localized: localized('Tie A', '同名序甲'),
        sortOrder: 901,
      },
      select: toFixture,
    });
    tieB = await prisma.courseCatalogueEntry.create({
      data: {
        name: categoryName('Tie B'),
        localized: localized('Tie B', '同名序乙'),
        sortOrder: 901,
      },
      select: toFixture,
    });
    archivedTop = await prisma.courseCatalogueEntry.create({
      data: {
        name: categoryName('Archived Top'),
        localized: localized('Archived Top', '归档一级'),
        sortOrder: 902,
        status: 'ARCHIVED',
      },
      select: toFixture,
    });
  });

  afterAll(async () => {
    await prisma.courseCatalogueEntry.deleteMany({
      where: { name: { contains: marker } },
    });
    await app.close();
  });

  const getCatalogue = () =>
    request(app.getHttpServer()).get('/api/portal/v1/categories').expect(200);

  const allNames = (nodes: CatalogueNode[]): string[] =>
    nodes.flatMap((node) => [node.name, ...allNames(node.children)]);

  /** C1 节点结构：name/localized/sortOrder/children，且不暴露 UUID。 */
  function expectNodeContract(node: CatalogueNode): void {
    expect(typeof node.name).toBe('string');
    expect(node.name.trim().length).toBeGreaterThan(0);
    expect(typeof node.sortOrder).toBe('number');
    expect(node.localized).toBeTruthy();
    expect(typeof node.localized).toBe('object');
    expect(Array.isArray(node.children)).toBe(true);
    expect(node).not.toHaveProperty('id');
    for (const child of node.children) expectNodeContract(child);
  }

  describe('C1 GET /api/portal/v1/categories', () => {
    it('[C1] returns the ACTIVE catalogue as a nested tree with the success envelope', async () => {
      const res: SuccessResponse<CatalogueNode[]> = await getCatalogue();

      expect(res.body.success).toBe(true);
      expect(res.body.error).toBeNull();
      expect(typeof res.body.message).toBe('string');
      expect(Array.isArray(res.body.data)).toBe(true);

      const data = res.body.data;
      for (const node of data) expectNodeContract(node);

      // 树形嵌套：子节点挂在父节点 children 下，不出现在一级。
      const parentNode = data.find((node) => node.name === parent.name);
      expect(parentNode).toBeTruthy();
      expect(parentNode?.children.map((node) => node.name)).toEqual([
        childA.name,
        childB.name,
      ]);
      expect(data.map((node) => node.name)).not.toContain(childA.name);

      // 只含 ACTIVE：归档的一级与二级节点都不出现。
      const names = allNames(data);
      expect(names).not.toContain(archivedTop.name);
      expect(names).not.toContain(childArchived.name);

      // 排序：一级 sortOrder 升序（全局性质）；同序按 name（用同序夹具锁定）。
      const topLevelOrders = data.map((node) => node.sortOrder);
      for (let i = 1; i < topLevelOrders.length; i += 1) {
        expect(topLevelOrders[i]).toBeGreaterThanOrEqual(topLevelOrders[i - 1]);
      }
      const topLevelNames = data.map((node) => node.name);
      expect(topLevelNames).toEqual(
        expect.arrayContaining([parent.name, tieA.name, tieB.name]),
      );
      expect(topLevelNames.indexOf(parent.name)).toBeLessThan(
        topLevelNames.indexOf(tieA.name),
      );
      expect(topLevelNames.indexOf(tieA.name)).toBeLessThan(
        topLevelNames.indexOf(tieB.name),
      );

      // 夹具节点的 localized 双语原样返回（en-GB / zh-CN 都取得到）。
      expect(parentNode?.localized['en-GB']?.name).toBe(parent.name);
      expect(parentNode?.localized['zh-CN']?.name).toBe(`${marker} 父级`);
      const childANode = parentNode?.children.find(
        (node) => node.name === childA.name,
      );
      expect(childANode?.localized['en-GB']?.name).toBe(childA.name);
      expect(childANode?.localized['zh-CN']?.name).toBe(`${marker} 子级甲`);
    });

    it('[C1] lists all four preset categories with localized en-GB and zh-CN names (M6)', async () => {
      const res: SuccessResponse<CatalogueNode[]> = await getCatalogue();
      const data = res.body.data;
      const byName = new Map(data.map((node) => [node.name, node]));

      for (const preset of PRESET_CATEGORIES) {
        const node = byName.get(preset);
        expect(node).toBeDefined();
        // 稳定键 = name；en-GB 显示名与稳定键一致（M6）。
        expect(node?.localized['en-GB']?.name).toBe(preset);
        expect(
          (node?.localized['zh-CN']?.name ?? '').trim().length,
        ).toBeGreaterThan(0);
      }
      // 任务指定的具体值：Society 中文 = 社会。
      expect(byName.get('Society')?.localized['zh-CN']?.name).toBe('社会');
    });

    it('[C1] marks the catalogue response as privately cacheable for 60 seconds', async () => {
      const res = await getCatalogue();
      expect(res.headers['cache-control']).toBe('private, max-age=60');
    });

    describe('[C1] API-key auth for /api/portal/**', () => {
      const token = `s1-e2e-token-${marker}`;
      let config: ConfigService;
      let previousEnabled: string | undefined;
      let previousToken: string | undefined;

      beforeAll(() => {
        config = app.get(ConfigService);
        previousEnabled = config.get<string>('AUTH_ENABLED');
        previousToken = config.get<string>('AUTH_TOKEN');
        // 只切换运行期配置（设计 C1：AUTH_ENABLED=true 时 X-API-Key = AUTH_TOKEN）。
        config.set('AUTH_ENABLED', 'true');
        config.set('AUTH_TOKEN', token);
      });

      afterAll(() => {
        config.set('AUTH_ENABLED', previousEnabled ?? 'false');
        config.set('AUTH_TOKEN', previousToken ?? '');
      });

      it('[C1] rejects a missing X-API-Key with 401', async () => {
        const res: ErrorResponse = await request(app.getHttpServer()).get(
          '/api/portal/v1/categories',
        );
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
      });

      it('[C1] rejects a wrong X-API-Key with 401', async () => {
        const res: ErrorResponse = await request(app.getHttpServer())
          .get('/api/portal/v1/categories')
          .set('X-API-Key', `${token}-wrong`);
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
      });

      it('[C1] accepts the configured X-API-Key and returns the catalogue', async () => {
        const res: SuccessResponse<CatalogueNode[]> = await request(
          app.getHttpServer(),
        )
          .get('/api/portal/v1/categories')
          .set('X-API-Key', token)
          .expect(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.data)).toBe(true);
      });
    });

    it('[C1] returns an empty array when every category is archived (I6)', async () => {
      const snapshot = await prisma.courseCatalogueEntry.findMany({
        select: { id: true, status: true },
      });
      await prisma.courseCatalogueEntry.updateMany({
        data: { status: 'ARCHIVED' },
      });
      try {
        const res: SuccessResponse<CatalogueNode[]> = await getCatalogue();
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual([]);
      } finally {
        const activeIds = snapshot
          .filter((row) => row.status === 'ACTIVE')
          .map((row) => row.id);
        if (activeIds.length) {
          await prisma.courseCatalogueEntry.updateMany({
            where: { id: { in: activeIds } },
            data: { status: 'ACTIVE' },
          });
        }
      }
    });
  });

  describe('C2 GET /api/backoffice/courses/categories', () => {
    let agent: Awaited<ReturnType<typeof signInAs>>;

    beforeAll(async () => {
      agent = await signInAs(app, 'ADMIN');
    });

    const getBackofficeCategories = async () =>
      agent.get('/api/backoffice/courses/categories').expect(200);

    it('[C2] keeps the {id,name,localized} shape and only returns top-level ACTIVE categories', async () => {
      const res: SuccessResponse<BackofficeCategoryRow[]> =
        await getBackofficeCategories();
      expect(res.body.success).toBe(true);
      const rows = res.body.data;
      expect(Array.isArray(rows)).toBe(true);

      for (const row of rows) {
        // 形状不变：恰好 {id,name,localized}，没有 children/status/sortOrder。
        expect(Object.keys(row).sort()).toEqual(['id', 'localized', 'name']);
        expect(typeof row.id).toBe('string');
        expect(typeof row.name).toBe('string');
        expect(row.localized).toBeTruthy();
        expect(typeof row.localized).toBe('object');
      }

      const names = rows.map((row) => row.name);
      // 只返回一级：二级（活动）分类不出现。
      expect(names).not.toContain(childA.name);
      expect(names).not.toContain(childB.name);
      // 只返回 ACTIVE：归档一级不出现。
      expect(names).not.toContain(archivedTop.name);
      // 排序：同 sortOrder 的两个一级分类按 name 升序。
      expect(names.indexOf(tieA.name)).toBeGreaterThanOrEqual(0);
      expect(names.indexOf(tieA.name)).toBeLessThan(names.indexOf(tieB.name));
      // 稳定键仍在（C2 保留给后台下拉使用）。
      expect(names).toContain('Society');
    });
  });
});
