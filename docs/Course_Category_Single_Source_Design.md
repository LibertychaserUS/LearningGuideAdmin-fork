# Course Category Single-Source & Content Contract Refactor Design（课程分类单一来源 + 内容契约重构设计）

- 日期：2026-11-12
- 状态：Draft —— 等待缝清单确认后按 TDD 实施
- 范围：LearningGuideAdmin（唯一写方与真源）+ LearningGuidePortal（只读消费方）
- 权威输入：
  - `docs/Course_Management_PRD_v2.0_CN.docx`（v2.0，2026-10-30）：§1 课程管理是学生端唯一课程数据源；§4 层级与 ID 规则；§9.1 Category 必填、分类由开发预置；§11.1 Category 创建时带入可修改；§14/§15.5 试看与价格不在版本快照内；§16 课程包跨环境；§23 不产生半导入草稿
  - `docs/Course_Module_Architecture_Design.md`（Admin 为课程主数据唯一写入方，Portal 只读）
  - `docs/Portal_Projection_API.md`（v1.2，Portal 只读投影）
  - Owner 指令（2026-11-12）：数据模型要有层次、可扩展、原子性；做好解耦；测试用黑盒规格测试；TDD
- 本文件是本次重构的设计 SSOT；实现前先更新本文，实现后回填偏差。

## 1. 旧架构根因（按根因归类，非症状罗列）

| # | 根因 | 证据（现状） |
|---|---|---|
| R1 | 分类有四个互不相通的来源、两个写权威 | Admin `CourseCatalogueEntry`；Portal `portalContent.categories`（写死 3 值）；Portal `data.catalogue`（自有 CRUD）；Portal 课程 `category` 字符串。Admin 导入 `resolveCategory` 自动建分类；Portal 旧后台 catalogue POST/PATCH 也能建/改名/归档 |
| R2 | 没有贯穿跨环境产物的稳定键 | 指纹与版本快照存分类 UUID（每环境随机）；分类 name 是唯一稳定键，但快照/指纹没用它 |
| R3 | 数据库层缺约束 | 唯一索引 `(parentId, name)` 对 `parentId IS NULL` 无效（NULLS DISTINCT），一级分类可重名；无大小写不敏感唯一；无层级/环校验；外层只有服务层"先查后插" |
| R4 | 导入/导出把假状态固化成数据 | 导入查不到分类就新建（写"社会"造出与 Society 并列的分类）；导出兜底 `Uncategorized`、Excel 导入兜底 `Uncategorised`，回导即造分类；导入在事务外创建分类，失败留下孤儿 |
| R5 | 投影读实时行而非线上版本 | Portal 投影/历史版本导出读取当前 `CommerceCourse.category`，草稿改分类先于发布影响线上；历史版本导出分类名漂移 |
| R6 | Portal 把分类当字符串与显示名 | 课程同时有 `category` 字符串与 `categoryId` 且无同步；课程页只比字符串、订阅页四重匹配、概览三重匹配；缺分类默认 `European Humanities`；CMS 与翻译强制恰好 3 个分类 |
| R7 | 权益/支付按显示名耦合 | `ProductPlan/Entitlement.scopeId` = 英文显示名；覆盖判断 `scopeId === course.category` 字符串比较；"3 个分类 = 全部"、AI 点数档位都写死数量 3 |
| R8 | 状态靠指纹反推 | "No draft" 由内容哈希反推；哈希含环境 UUID，跨环境永远不等，且每改内容模型语义漂移 |
| R9 | 无分类生命周期 | Admin 无分类管理 API（只能迁移/导入造）；删除分类 FK SET NULL 静默丢分类；`subjectId` 在 Admin 是死字段，Portal 另有 subject UI，两套模型不连通；`Science` 无预置迁移 |

## 2. 目标与非目标

目标：
1. Admin `CourseCatalogueEntry` 是分类的唯一真源与唯一写方；分类集合由开发预置（seed/迁移）。
2. 稳定键 = 分类路径（`name` 序列）；显示名走 `localized` 模板；UID 只是本环境存储编号。
3. 分类是有层次的树（当前深度 ≤ 2：category → subject），模型不封死深度。
4. 所有跨边界产物（版本快照、课程包、指纹输入、Portal 投影）只带稳定键。
5. Portal 只读 Admin 分类接口（带缓存与降级），全站单一分类解析函数；未分类只出现在"全部"下。
6. 权益 scope 用稳定键；支付按稳定键挂价格（价格供给归付款负责人）。
7. 导入分类解析与课程写入同一事务，查不到即整体拒绝；导出不带任何占位分类。
8. 内容模型与导入契约一并重制（Part B）：模板/课程包是带版本号的机读契约；内容模型承载纯文本展品、多触发、双语测评、学习点双锚点、媒体校验和与多 rendition；导入不静默丢数据。
8. 分类变更（草稿）不泄漏到线上；发布后生效。

非目标（本轮不做）：
- P1 的"Portal 全量读 Admin 已发布课程"（本次只做分类接口与 Portal 分类消费）。
- Stripe 价格/套餐的创建与同步（付款负责人）；本设计只保接口。
- 分类管理 UI（创建/改名/排序）——分类由开发预置；管理仍走迁移。
- 运营位（Discovery Banner）投影。
- 任何旧格式兼容层：旧课程包（formatVersion 1）直接拒绝；Portal 课程字段收敛为单一 `categoryKey`，不兼容 `category`/`categoryId` 双字段。

## 3. 数据模型

```mermaid
erDiagram
  CourseCatalogueEntry ||--o{ CourseCatalogueEntry : parent
  CourseCatalogueEntry ||--o{ CommerceCourse : category
  CommerceCourse ||--o{ CourseVersion : versions
  CommerceCourse ||--o{ CourseLocalization : localizations

  CourseCatalogueEntry {
    string id PK "环境本地 UUID（存储编号）"
    string name "稳定键（同父下大小写不敏感唯一）"
    json localized "通用模板 {lang:{field:text}}"
    string parentId FK "NULL=一级；深度<=2"
    int sortOrder
    string status "ACTIVE|ARCHIVED"
  }
  CommerceCourse {
    string id PK
    string categoryId FK "可空；发布要求 ACTIVE 且层级合法"
    string legacyCategory "只读遗留，不再写入"
    int draftRevision "每次草稿写入 +1"
    int liveBaseRevision "发布时=当时 draftRevision"
  }
  CourseVersion {
    string id PK
    json snapshotData "v3：course.categoryPath:string[]|null"
  }
```

模型规则：

- I1 一级分类：`lower(name)` 唯一（部分唯一索引 `WHERE "parentId" IS NULL`）。
- I2 子级分类：同父下 `lower(name)` 唯一（部分唯一索引 `WHERE "parentId" IS NOT NULL`）。
- I3 深度 ≤ 2：子节点的父必须是一级分类；服务层校验（未来放开深度只改校验，不改表）。
- I4 禁止自指与环：写入时校验。
- I5 课程只能引用 ACTIVE 分类；层级为一级或二级。
- I6 退场只有 ARCHIVED（无删除端点）；`ON DELETE SET NULL` 仅作 DB 兜底。
- I7 `subjectId` 停止读写（列保留，后续迁移删除）；课程只保留一个分类成员关系 `categoryId`；二级成员归属一级由 `parentId` 推导。
- I8 `name` 改名走迁移；改名后旧课程包因找不到分类而**拒绝导入**（不自动重建）——这是有意的安全行为。
- I9 快照 v3 `course.categoryPath: string[] | null`；v2 快照回读时按 categoryId 在本环境解析一次，找不到即报错。

## 4. Admin 接口契约

### C1 `GET /api/portal/v1/categories`（新增，Portal 消费）
- 鉴权：`/api/portal/**` 服务鉴权（`AUTH_ENABLED=true` 时 `X-API-Key` = `AUTH_TOKEN`）。
- 响应包络：`{success:true,data:[node],error:null,message}`。
- `node = { name, localized, sortOrder, children:[node] }`；只含 `ACTIVE`；按 `sortOrder` 升序、同序按 `name`；嵌套树。
- 契约不暴露 UUID；客户端不得依赖 `id`。
- 缓存：`Cache-Control: private, max-age=60`。

### C2 `GET /api/backoffice/courses/categories`（保留）
- 形状不变 `{id,name,localized}`；只返回一级 `ACTIVE`；按 `sortOrder,name`。

### C3/C4 课程创建/更新分类校验
- 创建：`categoryId` 必填 → 缺失 `CATEGORY_REQUIRED`；不存在 `CATEGORY_NOT_FOUND`；`ARCHIVED` `CATEGORY_ARCHIVED`；层级 >2 `CATEGORY_INVALID_LEVEL`。
- 更新：`categoryId` 置空 → `CATEGORY_REQUIRED`；其余同上。
- 校验在唯一一处（catalogue repository/service），DB 约束兜底。

### C5 课程包导入（新规格 formatVersion = 2，不兼容旧包）
- manifest：`formatVersion: 2`，`course.categoryPath: string[] | null`（必填字段，null 表示未分类）；**不再有** `course.category` 字符串字段。
- 旧规格包（formatVersion ≠ 2，或含 `course.category`、或缺 `categoryPath`）→ 整个 job `FAILED`，错误码 `PACKAGE_FORMAT_UNSUPPORTED`；不做任何兼容解析。
- 解析：逐级在 ACTIVE 节点中按 `name` 或 `localized` 任一语言显示名匹配（trim、大小写不敏感）。
- 解析失败：整个 job `FAILED`，错误码 `CATEGORY_NOT_FOUND`，消息列出未解析路径；**不创建分类**；草稿保持原样（原子）。
- 解析与课程写入同一事务；失败不留孤儿分类。

### C6 课程包导出（只出 v2）
- `formatVersion = 2`；输出快照的 `categoryPath`；未分类 → `null`；不写 `course.category`；禁止 `Uncategorized`/`Uncategorised` 任何占位词。

### C7 版本快照与恢复
- v3 快照存 `categoryPath`，不存 UUID。
- Restore：按路径在本环境解析；失败 `CATEGORY_NOT_FOUND`，草稿不变；成功则写回本地 `categoryId`。
- v2 快照：按 `categoryId` 本地解析，失败报错（不做静默置空）。

### C8 Portal 投影
- `category`/`categoryLocalized` 取自**线上版本快照**的 `categoryPath`（发布时点），而非当前行；草稿改分类不影响线上；历史版本预览/导出使用该版本的路径。

### C9 草稿状态（替代指纹判 No draft）
- 显式状态：`draftRevision`（每次草稿写入 +1）与 `liveBaseRevision`（发布时取当时值）；`No draft ⇔ draftRevision == liveBaseRevision`。
- 语义（有意偏离 PRD 字面"完全一致"）：编辑后又改回相同内容仍视为"有草稿"；Restore 线上版本 → No draft；Restore 旧版本 → 有草稿；导入课程包 → 有草稿；Publish → No draft。
- 内容哈希不再参与 No draft；若保留 contentHash 仅供排查，不得包含任何环境私有 ID。

## 5. Portal 契约

### P1 Admin 分类客户端
- server-only：`services/adminCatalogue.ts`；env 优先 `ADMIN_PORTAL_BASE_URL`/`ADMIN_PORTAL_API_TOKEN`，缺省回落 `KS_TUTOR_BASE_URL`/`KS_TUTOR_API_KEY`（同一 Admin origin/AUTH_TOKEN，零部署改动）。
- 请求：`GET /api/portal/v1/categories`，`X-API-Key`，超时 ≤3s，`cache:'no-store'`。
- 任何凭证不得进入客户端组件/日志。

### P2 缓存与降级
- `services/adminCatalogueCache.ts`：内存 TTL 60s、single-flight、失败退避 15s、保留 last-good；冷启动失败回退内置种子列表（Science / Chinese Humanities / European Humanities / Society，含中文名），页面不崩。

### P3 单一表示 + 单一解析器（productStore 一起改）
- `ProductCourse` 只保留 `categoryKey: string | null`（分类稳定键）；删除 `category` 与 `categoryId` 双字段；Portal `data.catalogue` 与内嵌后台的 catalogue 引用一并退役（写入口 410，读路径删除）。
- `resolveCourseCategory(course, catalogue) → { name, localized } | null`：只按 `categoryKey` 精确匹配（大小写不敏感）；未知 key → `null`。不再有第二条"旧字符串兜底"路径。
- 全站唯一入参口径；禁止任何地方再写第二套匹配。

### P4 展示面
- `/portal/courses?category=<name>`：只显示解析后 name 相等的课程；`All` 显示全部（含未分类）；未知值 → 空列表，不回退默认分类。
- 课程卡、首页卡、页脚、课程详情面包屑/chip、My Learning、公开课/Understanding/学习页面包屑：显示 `localized` 当前语言名；未分类不显示分类徽标/链接。
- 禁止 `|| 'European Humanities'` 及等价兜底。

### P5 权益与订阅
- `ProductPlan/Entitlement.scopeId` 语义固定为分类稳定键（= `categoryKey` = Admin `name`）。
- 覆盖判断：`resolved(course).name === scope.key`。
- "全部分类" = 目录中全部 ACTIVE 分类被覆盖（不再用数量 ≥3）。
- AI 点数从 plan 数据读取，不再按分类数量写死。
- 支付侧只消费 `(scopeKey, term, device) → price`；Society 无价格时不可售是支付配置问题。

### P6 Portal CMS
- `PUT /api/backoffice/portal` 拒绝包含分类变更的 payload（`422 CATEGORIES_MANAGED_IN_ADMIN`）；翻译接口同样拒绝分类；`PortalContentEditor` 移除分类编辑区。
- 分类显示名唯一来源 = Admin `localized`。

### P7 Portal 旧后台 catalogue 写入口
- `POST/PATCH /api/backoffice/courses/catalogue*` → `410 CATALOGUE_MANAGED_IN_ADMIN`；读保留（只读过渡）。
- 课程元数据编辑中的分类下拉改为只读展示（写入被拒）。

### P8 课程页试看 CTA
- "开始试看"链接由数据推导：已发布且 `trial enabled` 且存在公开首课的课程 + 其第一门公开课时；无则隐藏 CTA。禁止任何写死课程/课时 ID。

## 6. 统一数据规格与存量迁移（不保留旧格式）

统一数据规格（本轮一次性切换）：
- 课程包 manifest：v2（`formatVersion: 2`，`categoryPath`，无 `category`）——旧包拒绝（`PACKAGE_FORMAT_UNSUPPORTED`）。
- 版本快照：v3（`categoryPath`）——v2 快照仅在本环境按 `categoryId` 回读，恢复成功后的下一次发布即为 v3。
- Portal product 数据：schema v2（单一 `categoryKey`）——迁移后不再存在 `category`/`categoryId` 双字段与 `data.catalogue`。

- M1 一级分类去重：按 `lower(trim(name))` 归并（保留最早创建行），把 `CommerceCourse.categoryId/subjectId` 重指到保留行；输出报告。
- M2 加索引：两条部分唯一索引（I1/I2）。
- M3 背填：`categoryId IS NULL AND legacyCategory 非空` → 按名称（trim/大小写不敏感）匹配；仍不中则保持 NULL 并报告（发布被 Category is required 拦截，不造假分类）。迁移完成后 `legacyCategory` 停止读取。
- M4 归档/子级引用：`categoryId` 指向 ARCHIVED 或层级非法 → 能重映射到有效一级则重映射，否则置空并报告。
- M5 占位词：`Uncategorized`/`Uncategorised` 及其它历史占位分类若存在，迁移中标记归档并报告；不得再被导入命中（导入只认 ACTIVE）。
- M6 预置补全：幂等迁移补 `Science` 种子，并给四个预置分类补 `localized`（en-GB=name，zh-CN 已有）。
- M7 快照：存量 v2 快照不批量改写，Restore 时按 v2 规则解析；新发布一律 v3。
- M8 Portal 侧（schema v2）：课程字段 `category` + `categoryId` 合并为单一 `categoryKey`；迁移规则：旧 `category` 字符串按稳定键（trim/大小写不敏感）匹配 Admin ACTIVE 分类 → 写入 `categoryKey`；匹配不到 → `null` 并输出报告；`categoryId` 与 `data.catalogue` 全部删除（写入口 410、读路径移除）。旧课程包不迁移（新规格拒绝旧包）。

## 7. 缝（黑盒测试边界，TDD 逐缝红→绿）

| 缝 | 契约 | 测试层级 | Admin 测试文件 | Portal 测试文件 |
|---|---|---|---|---|
| S1 分类读接口 | C1/C2 | HTTP e2e | `server/test/category-portal-api.e2e-spec.ts` | — |
| S2 目录不变式 | I1–I4 | DB/迁移 e2e | `server/test/category-invariants.e2e-spec.ts` | — |
| S3 课程绑定校验 | C3/C4 | HTTP e2e | `server/test/category-course-binding.e2e-spec.ts` | — |
| S4 导入导出 | C5/C6 | job/HTTP e2e | `server/test/category-package.e2e-spec.ts` | — |
| S5 快照/恢复/草稿状态 | C7/C9 | HTTP e2e | `server/test/category-version.e2e-spec.ts` | — |
| S6 目录客户端与缓存 | P1/P2 | 单测（假 HTTP） | — | `tests/unit/admin-catalogue-client.test.ts` |
| S7 解析器与展示面 | P3/P4/P8 | 单测/页面行为 | — | `tests/unit/category-surfaces.test.ts` |
| S8 权益与 CMS/旧后台 | P5/P6/P7 | 单测/路由 | — | `tests/unit/category-entitlement.test.ts`、`tests/unit/category-cms-guard.test.ts` |
| S9 模板 v2 契约 | B1 | HTTP/job e2e | `server/test/content-template-v2.e2e-spec.ts` | — |
| S10 展品模型 | B2.1 | HTTP/job e2e | `server/test/content-exhibit-model.e2e-spec.ts` | — |
| S11 学习点双锚点 | B2.2 | HTTP/job e2e | `server/test/content-learning-point.e2e-spec.ts` | — |
| S12 双语测评 | B2.3 | HTTP/job e2e | `server/test/content-bilingual-tests.e2e-spec.ts` | — |
| S13 导入保真与报告 | B3 | HTTP/job e2e | `server/test/content-import-fidelity.e2e-spec.ts` | — |
| S14 往返保真 | B2.4/B4 | HTTP/job e2e | `server/test/content-roundtrip.e2e-spec.ts` | — |

测试要求（全部适用）：
- 黑盒：只经 HTTP 接口、路由、页面输出或既有公共入口观察行为；不 import 尚未存在的内部模块，不断言私有字段。
- 规格化：每个测试标注对应 I/C/P 编号。
- 边角必测：大小写重名、NULL 父重名、跨父同名合法；localized 显示名匹配（中文名）、trim；未知分类整体拒绝且草稿不变；null 分类 round-trip；ARCHIVED 不可绑定；Restore 缺分类报错；草稿改分类不泄漏到投影；发布后生效；Admin 不可用降级；4 个分类下"全部"语义；显示名变化不影响权益匹配；未知 `?category=` 空结果；并发导入同名不重复。

## 8. 待拍板（实现前需 Owner 确认）

- O1 编辑后手动改回相同内容：按显式状态算"有草稿"（本设计采用）；若坚持 PRD 字面"完全一致"，需额外内容比较，仅此一处。
- O2 试看 CTA 的数据源：本设计取"第一门已发布且开启试看的课程 + 其公开首课"；若要运营驱动，需增加 Banner 投影（P1 后续）。
- O3 `subjectId` 停止读写、层级收敛为单一成员 `categoryId`（二级节点归属一级）；若产品仍要独立 Subject 字段，另行立项。
- O4 Portal 客户端 env 复用 `KS_TUTOR_*` 作为缺省（零部署改动）；若要独立变量，需部署侧配合。

## 9. 风险

- e2e 使用本地专用库 `learning_guide_e2e`（`postgresql://admin:admin@localhost:5432/learning_guide_e2e`，已迁移最新 schema）；本地 dev 库 `learning_guide_db` 存在一个此前失败的历史迁移（`20261026000000_add_knowledge_chunk`，错误码 0A000），与本重构无关，需要单独修复；CI/SIT 复验。
- 存量数据真实形态未知（是否有重复一级分类、legacyCategory 值域、ARCHIVED 引用），M1–M5 需在 Sandbox 演练后进 Production。
- Portal 课程仍来自 productStore（P1 未做），但字段已收敛为单一 `categoryKey`；P1 切换后由 Admin 投影提供同一语义。
- 分类改名会使旧课程包导入被拒（有意行为），需要在操作手册中写明。

## 10. CI 落点

- Admin `.github/workflows/ci.yml` 新增 `e2e` job：`pgvector/pgvector:pg16` 服务容器（`learning_guide_e2e`）+ `npx prisma migrate deploy` + `npm run test:e2e -- --runInBand`，与本地入口一致；迁移历史含 pgvector（`vector(1536)` + HNSW），官方 `postgres:16` 镜像会在 `CREATE EXTENSION vector` 处 0A000 失败，因此镜像必须用 pgvector 版本（docker-compose/README/setup 脚本已同步）。此前的 Admin CI 只跑单元测试（`npm test`）与 client build，从未跑过 e2e——这就是"e2e 需要数据库"此前没人踩到的原因。
- Portal `Verify`（ci.yml）已运行 `npm run test:ci`（含 `test:unit`），S6–S8 的单元/路由级测试天然在 CI 内；不需要新 job。Portal 的 Postgres io 证据走既有的 `Study Group PG I/O` workflow。

## 11. 内容模型与导入契约（Part B，**已被 Part C 取代，待按阶段树模型重写**）

### B1 模板 v2（机读契约，版本化）
- `Meta` sheet：`templateVersion = 2`、Course code、Learning language（视频/文本载体语言，稳定 key）、Study mode（video/text/both key）。
- `Media` sheet（新增，必需）：`asset_key | kind（cover/video/image/model3d/thumbnail/lesson-text/subtitle/chapters）| lesson_code | language | relative_path | thumbnail_of`。导入只按 `asset_key` 引用；禁止文件名约定与 ZIP 目录剥除。
- 枚举全部用稳定 key（category_key / preset_key / reading_type_key / exhibit_kind_key），显示名只出现在文档与 `localized`。
- **模板里没有任何时间列，人也不参与任何时间输入**。时间完全由导入服务**机器派生**：
  1. **容器时长**（MP4 `mvhd`/ffprobe）——校验裁判；
  2. **字幕轨**（SRT/VTT/ASS，随包交付并在 Media sheet 声明；缺失时导入服务可用 ASR 现场生成，属机器步骤）——学习点标题按脚本/字幕文本对齐到 cue 起点；正文里的 `[Exhibit: Exx]` 标记按所在对话行 → 字幕 cue 对齐得到触发时间；
  3. **MP4 chapter track**（若交付）——章节轨直接映射 learning points；
  4. 派生置信度不足、cue 对不上、缺字幕且无法 ASR → **整包失败/该课时 incomplete**，机器报告指出缺什么；由内容团队补齐交付物，不设人工打点环节。
  文本模式 LP 锚点来自 DOCX Heading 1（结构解析）。`timing.json` 是派生结果（导入时生成、随快照存档、导出时带出），不是人工交付物。
- `timing.json` 契约：`{templateVersion, courseCode, entries:[{lessonCode, language, kind:"lp"|"trigger", lpCode?, exhibitCode?, timeMs, source}]}`；`timeMs` 整数毫秒、稳定 code、无环境 ID；`source` 记录派生来源（subtitle/chapter/asr）供审计。该文件由导入服务派生并持久化（随快照存档、导出带出），**不是人工交付物**；导入按 `lessonCode/language/kind/lpCode|exhibitCode` 与模板 join：缺必需条目 → incomplete/error；未知 code → error；重复真值键 → error；越界按视频时长校验。任何冒号文本都不进入解析链路。
- 校验以真实视频时长为唯一裁判：`0 ≤ t < duration`（等于时长无效）；越界 → error（带 sheet/row/col），**不 clamp、不重解释、不 ×1440/÷60**；时长缺失/探测失败 → 导入失败，不跳过校验。
- 旧模板（无 `templateVersion` 或结构不符）→ 整个 job `FAILED`，错误码 `TEMPLATE_FORMAT_UNSUPPORTED`。
- 模板由 schema 生成（列名/枚举/校验与解析器同源）；Checklist 只作人工工作流，不作导入依据；跨表 join 一律用稳定 code（Lesson/Exhibit code），不用显示标签。

### B2 内容模型 v2（Prisma）
- B2.1 展品：`ExhibitKind = IMAGE | TEXT | VIDEO | MODEL3D`（新增 TEXT）；`bodyHtml` 承载纯文本展品；媒体以 asset 引用（primary + thumbnail 两种 rendition），不存文件名；正文引用用 `exhibit code`。
- B2.2 学习点：`LearningPoint` 唯一键 `(lessonId, language, code)`；两个可空锚点 `videoTimeMs`（整数毫秒，来自打点工具）、`textAnchorHeading`（来自 DOCX H1）；同一 code 可同时拥有两种锚点；单值 `source` 停止写入（列保留过渡，读逻辑不再依赖）。
- B2.3 触发点：同一展品在同一视频可出现在多个时间点——这是内容事实，不是重复。约束改为真值键唯一 `(lessonId, exhibitId, language, timeMs)`；相同时间重复行 → 校验错误（不静默去重）。导入语义为"整包替换草稿"，同一包重复导入结果完全一致（幂等由替换 + 真值键保证，不靠限制出现次数）。每行 `sortOrder` 排序。**双向避免**：① 根——DB 真值键唯一索引，任何写入路径都产不出重复行；② 生产端——派生器与导出器跑与导入端**同一个校验器**，派生结果含重复真值键即报错、不产出；③ 消费端——导入校验发现重复真值键整包拒绝并给源坐标。注意：不同展品在同一时间点出现是合法的（真值键含 exhibitId），不视为重复。
- B2.4 测评语言：`KnowledgeQuestion` / `ApplicationTest` 增加 localized 承载（`questionLocalized`、`referenceAnswerLocalized`，标准模板 `{lang:{field:text}}`）；v2 写入必须 en-GB + zh-CN 齐全；完整性门禁要求语言齐全。
- B2.5 媒体：资产身份 = `assetKey + assetVersion`（替换即新版本），**不使用内容哈希**；同一逻辑资产的多 rendition 用引用关系表达；docx 内嵌图提取为资产并绑定 exhibit code。
- B2.6 语言语义拆分：`learningLanguages`（视频/正文载体语言，模板定义）与元数据本地化语言（CourseLocalization 恒为 en-GB + zh-CN）分开；English-only 课程不得丢弃中文元数据，不得把同一份英文 HTML 写给所有语言。
- B2.7 快照 v3 覆盖以上全部内容形态；课程包 v2 与快照同形；导出/导入 round-trip 语义一致（展品、触发、阅读、测评、媒体、语言）。

### B3 导入链（单一 parser + 单一校验门）
- 一个 parser，按 `templateVersion` 分派；未知版本整体拒绝。
- 校验先于清洗：重复 exhibit code、缺媒体、非法枚举、缺失语言、时间越界 → 按冻结设计 §17.4 分级（error 阻断整包 / incomplete 阻止发布），不得自动改名、跳过或静默降级。处理顺序固定：`parse`（纯函数）→ 媒体探测/时长读取 → 范围校验 → 写入；任一步失败整包拒绝。
- 一个语义一个检查器：打点工具、导出、导入共用同一套校验函数（相同真值键、越界、非法枚举等），生产端与消费端不写两套判断；DB 约束是最后兜底。
- 时间 join：模板不含时间列；导入服务先机器派生 timing（字幕/章节/ASR），再按稳定 code 与模板关联（lessonCode + language + kind + lpCode/exhibitCode）；两边的 code 集合必须互相覆盖——模板里有锚点但派生缺失 → incomplete/error，派生结果里有未知 code → error。派生必须确定性：同一包重复导入得到逐条一致的 timeMs。
- 时间审计报告（语义真实的唯一保底）：导入完成后为每个学习点/触发生成审计条目——毫秒值、格式化 `mm:ss.mmm`、以及在有字幕/转写时该时刻附近的文本片段；Operator 按 PRD 的 Sandbox 流程播放复核。三层保证缺一不可：**语法真实**靠唯一格式的 parser，**物理真实**靠视频时长校验，**语义真实**（这个时间点是否真的是那个学习点/展品）只有播放复核能确认，导入器不做也无法做语义推断。
- 所有 warning/error 持久化到 job report，带源坐标（sheet/row/col）与 sourceMap；未消费的列/行必须显式报出。
- raw 素材导入（xlsx/docx zip）统一走 v2 模板解析与同一导入管线；不再按文件名猜媒体，不再"任意 docx/xlsx 自动变课程"，不满足 v2 契约即拒绝。
- 导入后按 Checklist 的计数维度（Lessons/KT/AT/Exhibits/Readings）做源-产对账，差异进报告。
- 原子性沿用 C5：分类解析与课程写入同一事务。

### B4 保留清单（逐条验证，映射 S9–S14）
课程→课时两级与稳定 code；每语言文本可表达、缺语言显式 incomplete；富文本正文/对话轮次/段落级中英对照/图注位置；展品图片+方形缩略图、双语标题描述、来源、纯文本展品、正文位置引用、每视频触发时间；学习点同一编号双锚点；时间整数毫秒（派生）+ 视频时长校验；大视频与图片资产存取/时长读取；知识/应用测试按课时且双语；推荐阅读 type/title/author/why；分类单源（S1–S8）；完整性分级可阻断缺失语言与测评；展品编号可被正文/触发器引用；原始素材留存与数量对账；版本快照/导出覆盖全部内容形态。

### B5 存量内容迁移
- 旧课程包一律拒绝（`PACKAGE_FORMAT_UNSUPPORTED`）；库内存量内容按 B2 迁移：
  - `LearningPoint` 的 V-x/T-x 成对编号：同课时内可唯一配对的合并为一条（双锚点），无法配对的原样保留并列入报告；
  - `Exhibit` 无 TEXT 类型的存量行迁移为 IMAGE（media 为空的原样保留并报告）；
  - `ExhibitTrigger` 去掉唯一约束（数据无需改写）；
  - 测评双语缺失的课时标记 incomplete（不造假翻译）；
  - `MediaAsset.sha256` 回填：已有文件计算校验和，无法读取的报告。
- 迁移在 Sandbox 演练并产出报告后才进 Production。

### B8 内容包格式严谨性（闭合契约）
- 版本与关闭性：manifest 必须声明 `formatVersion: 2`、模板必须声明 `templateVersion: 2`；未知/缺失版本 → 拒绝。包内文件必须与 manifest 一一对应——声明但缺失 → 错误，未声明文件 → 错误（闭合包，不靠目录猜内容）。
- 唯一清单：`manifest.json` 是唯一入口；每个资产有 `asset_key`、kind、相对路径、语言、所属课时；禁止从文件名/目录推断任何语义。
- 稳定键：lesson/exhibit/LP 一律用 code；分类用 `categoryPath`；快照与包不带任何环境 UUID。
- 全量静态校验（写入前、同一事务内）：schema 校验（JSON Schema/Zod）、引用完整性（code 双向覆盖）、真值键重复、语言完整性、时间范围（派生后）；所有错误带源坐标（sheet/row/col 或 JSON path）。
- 无静默修复：不自动改名、不跳过行、不造占位分类、不做时间启发式；修包是内容团队的责任，系统只拒绝并给出精确报告。
- 确定性：同一输入重复导入产生逐条一致的内容（派生时间确定性；exportedAt 等元数据不参与内容身份）。
- 往返保证：导出器与导入器共用同一 schema 与校验器，`import(export(package))` 语义等价，由 S14 锁定。
- 单一 schema 源：模板生成、校验器、导出器、文档由同一份 schema 定义产出；版本升级必须带迁移规则与拒绝规则。
- CI：仓库内置 good/bad fixture 包，契约测试在 CI 必跑（Admin `e2e` job）。

### B6 风险
- 内容模型变更面大，必须按缝 TDD；模板 v2 需要与内容团队确认交付格式（模板由开发生成并提供）。
- docx 内嵌图提取与对话段落解析规则需要 fixture 测试（用真实 Lesson docx 作样例）。
- 存量数据形态未知，B5 迁移需 Sandbox 演练。

### B7 测试可运行性要求（实现必须保证）
- 导入 worker：`src/commerce-courses/heavy-tasks.ts` 以 `new Worker(path.join(__dirname, 'import-worker.js'))` 启动 worker；在 ts-jest e2e 与 GH CI 下 `__dirname` 指向 `server/src/commerce-courses`，worker 文件不存在，导入 job 无法运行（S4 红证据的 blocker）。实现必须让导入 job 在测试/CI 环境可执行：worker 路径同时支持 dist 解析与源码（ts-node/tsx）解析，或提供 `HEAVY_TASKS_INLINE=1` 进程内执行开关；测试与 CI 走同一入口，不得只在本地手工可跑。
- e2e 服务镜像必须是 `pgvector/pgvector:pg16`（迁移含 `CREATE EXTENSION vector`；官方 `postgres:16` 会 0A000）；已同步 ci.yml / docker-compose / README / setup 脚本。
- 测试库：`learning_guide_e2e`（47 迁移全量应用）；新增迁移后需在 CI job 内 `prisma migrate deploy` 而非依赖本地库。
- 本地 Docker VM 磁盘当前接近/达到 100% 会阻断临时容器与镜像拉取；实现阶段需先清理（`docker system df` / `docker image prune`），否则 CI 等价验证无法本地复跑。

---

## 12. Part C 草案（已由 §14 定稿取代；保留为决策记录）

- 组织原则是**阶段树**（Stage Tree），不是时间。时间不在课程层做第一性建模。
- **不持久化"课程编排时间轴"**：课程时间轴只在展示/分析时由模型按需折叠计算（派生视图），不进快照、不做身份、不做进度真相。
- 模型只保留三样：① 阶段树（顺序、前置/约束）；② 每个资产的媒体时间线（PTS/时长，物理事实）；③ **阶段 ↔ 媒体区间映射**（哪个资产的哪一段服务哪个阶段/内容片段；对齐由机器派生并可校验）。时长只存在于媒体资产（精确值）；文本/练习**不设时长、不估算**；课程"总时长"（如有）就是媒体时长之和（PRD 口径：Lesson 时长=视频时长，Course 时长=全部 Lesson 视频时长之和；纯文本课程不显示时长），不是课程级时间模型。
- 进度：按阶段/内容单元的完成度计；视频内位置按 (用户, 资产) 记 PTS。
- 收益：消除全局时钟同步类缺陷；阶段重排不会让时间失效；快照只存"树 + 映射 + 版本"。
- 边界：不要时间轴 ≠ 不要时间——时间只存在于两处：资产的物理时间线与阶段的对齐区间。
- 学习时间（wall-clock）不属于内容模型：由**学习会话事件**记录（started / paused / resumed / completed / abandoned + 时间戳，客户端与服务端时间双记，事件带幂等键），时长由事件派生；中途退出、断线、续学、计时是否暂停等规则属《学习会话规格》，另立文档，不进入内容包/快照。
- 学习事件契约（最小版）：输入 `{eventId, type:'started'|'completed'(可扩展 paused/resumed/abandoned), sessionId, occurredAt(ISO 8601 UTC, 客户端时钟), content:{contentVersionId, stageId, unitId?}, sequence?}`；服务端补 `id, userId, receivedAt`（权威时钟）。DB 追加写 `LearningEvent`（`eventId` 唯一幂等；索引 `(userId, contentVersionId, stageId)`、`(sessionId, sequence)`）。时长/完成态由事件派生，**不接收客户端 elapsed/秒数**。校验：type 枚举、occurredAt 合理区间、completed 前必须有 started、stageId 必须属于该内容版本。
- **视频模式与文本模式不是两套独立内容**（修订 PRD §12.5「两套独立 LP、不要求一致」的旧抽象）：同一 `Stage/ContentUnit` 是唯一语义身份；video anchor（`assetKey + sha256 + [startMs,endMs]`）与 text anchor（`documentVersion + headingCode/offset`）只是同一 stage 的两种 rendition 坐标。模式切换按 `stageId`，不按时间；两模式内容不一致处由机器报告（不静默各自成立）。
- **测量的参考系是身份，不是绝对时间轴**：每份资产有自己的时间线（PTS/时长，精确）与稳定身份 `assetKey + assetVersion`（替换即新版本；**不使用内容哈希做身份**——重编码即变、不指认版本、无对齐价值）；duration 只是资产属性，用于校验，不参与身份。stage→坐标映射绑定 `(assetKey, assetVersion)`。资产替换 = 映射失效，需重新派生/确认（对应 PRD 的 Re-confirm）。不存在全局绝对时间轴；"绝对"的是 stageId 与资产身份。

---

## 13. 意外复杂度删除台账

| 项 | 设计状态 | 代码/测试状态 | 下一步 |
|---|---|---|---|
| 两套独立 LP（视频/文本各一套、不要求一致） | **已删**：§14 Part C 定稿（同一 Stage 的 rendition 坐标；切换按 stageId）；PRD §12.5 原文待正式修订 | 未开始（内容侧按 §14 落地） | 按 §14 C9 实施 |
| Portal 内嵌 catalogue 双后台 | **已删**（设计） | **Portal 侧已实现并实测绿**（2026-11-12：`npm run typecheck` 0 错误、S6–S8 29/29）；**Admin 侧分类 core 未完成**（ADM-CORE 中断） | 完成 ADM-CORE（分类接口/绑定校验）→ Admin e2e S1/S3 转绿 |
| 分类写死（3 值联合 / ≥3=全部 / AI 点数档位） | **已删**（设计） | Portal 侧已实现并实测绿（同上）；Admin 侧分类读接口未完成 | 同 ADM-CORE |
| 时间手输（mm:ss / Excel 时间格式 / 人工打点） | **已删**：B1/Part C（模板无时间列，字幕/章节/ASR 机器派生，`timing.json` 为派生产物） | 旧 bolt-on 迁移 `20261112070000_content_model_v2`、`20261112080000_content_time_ms` 与 6 个 `content-*` 测试待删除 | 新内容模型定稿后重写测试与实现 |

### 待删/待改清单（钉死，执行时机 = Part C 定稿后的重写步骤）

- [ ] 删除迁移目录：`server/prisma/migrations/20261112070000_content_model_v2/`、`server/prisma/migrations/20261112080000_content_time_ms/`
- [ ] 删除测试文件（6 个）：`server/test/content-template-v2.e2e-spec.ts`、`content-exhibit-model.e2e-spec.ts`、`content-learning-point.e2e-spec.ts`、`content-bilingual-tests.e2e-spec.ts`、`content-import-fidelity.e2e-spec.ts`、`content-roundtrip.e2e-spec.ts`
- [ ] 回退/重写 `server/prisma/schema.prisma` 的内容侧 hunk：`ExhibitType.TEXT`、`Exhibit.bodyHtml`、`LearningPoint.source` 可空化 + `videoTimeMs` + `textAnchorHeading`、`ExhibitTrigger.timeMs/sortOrder/@@unique(lessonId,exhibitId,language,timeMs)`、`KnowledgeQuestion.questionLocalized/referenceAnswerLocalized`、`ApplicationTest.questionLocalized/referenceAnswerLocalized`（新模型落地时按其形状重建，不在旧 hunk 上修补）
- [ ] **保留**（勿误删）：`server/prisma/migrations/20261112050000_catalogue_single_source/`、`20261112060000_course_draft_revision_state/`、`CommerceCourse.draftRevision/liveBaseRevision`（C9 草稿状态）、5 个 `category-*.e2e-spec.ts`、Portal 侧全部改动
- [ ] 删除后重建本地 `learning_guide_e2e`（drop → create → `prisma migrate deploy`），避免旧迁移已应用造成的 schema 漂移；CI 每次用新库不受影响
- [ ] 执行前用 `git status` 复核：停止的 ADM-IMPORT 代理未留下内容侧生产代码（截止当前无）；若有残留一并清理

---

## 14. Part C 定稿：阶段树与内容编排（v1）

### C0 范围、红线与版本矩阵

- 本节取代 §11（Part B）与 §12 草案；§13 台账继续有效。
- Owner 红线（摘要，全部不可回退）：① 阶段树是组织原则、时间非主键；② 阶段必须由出口证据定义；③ 树+DAG+对齐矩阵（DAG 不是树）；④ 不持久化课程时间轴；⑤ 媒体是既成输入，机器只做对齐/选择/布局/检查/留痕；⑥ 无人工时间输入、无估算时长；⑦ 资产身份 = `assetKey+assetVersion`，**全系统不使用任何哈希/digest**（身份、工件绑定、历史、幂等一律不用）；⑧ 对齐是一等数据且只有 verified 可进发布；⑨ Plan/Apply 分离、预览复用执行路径；⑩ 内容单元与阶段分离、6 类封闭词表；⑪ 学习时间是会话事件域；⑫ 包是闭合契约、旧格式拒绝；⑬ 分类单源在 Admin；⑭ 教学法质量由人签收。
- **对综合稿的 owner override**：综合稿中的 `planId=digest(...)`、`planDigest`、`verifiedAlignmentSetDigest` 等一律替换为**显式版本号 + canonical JSON 字节相等比较 + 单调计数器**（见 C6）。
- prior-art 只抄四样：SCORM activity tree + sequencing rules + rollup；IMS LD「act 以完成推进、时限只作兜底」；DITA map/topic/keyref（结构与内容分离）；Terraform plan/apply（含 as-run 对账）。不抄：完整导航运行时、IMS LD B/C、任何语义 DSL。
- 版本矩阵（三轴独立，单次升级）：`packageFormat = 2`（含 Part A 分类 + Part B 契约 + Part C 设计）、`templateVersion = 2`、`snapshotFormat = 3`。
- v1 范围：`stage/step` 两级 + `requires` 先修 + 单一 target + preview/approve/apply/publish + 事件/as-run。**延后**：choice 容器（编译器直接拒绝 `UNSUPPORTED_ORDERING`）、多 target、多角色评审矩阵、LLM proposed。**不延后（产品级硬需求）**：视频三功能不砍（LP 导航与按 LP 记进度、展品触发、视频试看截止），因此**每个视频 rendition × 每个语言都必须有机器时间源**——默认 ASR 从音轨派生（内部工件），外部字幕/章节优先，强制对齐仅在课时显式声明"文本稿=口播稿"时启用。

### C1 三域模型与术语

- **意图域 StageTree**：只表达包含、目标、出口证据、先修与排序意图；不含任何时间码/页码/周次。
- **交付域 Plan**：针对一个显式 target 的确定性线性化与选择，是独立、不可变、可签收的工件。
- **体验域 as-run**：append-only 学习事件与证据达成账本对 Plan 的投影（轨迹，不是截面），用于对账与回放，不写回 Plan。
- **桥 Alignment**：`stage × rendition × objective` 的三元跨度（多对多矩阵），带 `role/status/provenance`。
- **冻结 ContentVersion**：把树、spec pins、rendition、仅 verified 的对齐（含审计元组）、证据规格、资产 pins、分类路径、已批准的 planPin 一次冻结；发布后不可变。
- 术语：Stage/交付叶（无子节点的 stage）/Rendition（内容块在语言×模态×载体上的一个点）/Alignment/Plan/PlanEntry/as-run/ContentVersion/EvidenceSpec/EvidenceAttainment。

### C2 数学骨架（对 owner #13 的修正）

- **原始丛在内容侧，不在阶段基上**：`π_K: R → K`（K=内容块），`R_k` = 同一 block 的 rendition 有限集；阶段纤维 `F_s := Alignment 跨度在阶段侧的像`（派生，不是原语）。理由：对齐是多对多，不存在函子 `B^op→Set` 提供限制映射；把纤维设为阶段原语会导致"纤维成员靠对齐、对齐又靠纤维"的循环。
- **Alignment 是带装饰的三元跨度** `A ⊆ S×R×O`；`verified` = 粘合条件成立（rendition 业务键唯一、审计元组匹配、objective 属于该 stage、有人签收）；`stale` 读时派生（审计元组与 pin 集不匹配），无写传播。
- **Plan = 幂集截面**：λ 为交付叶偏序的规范线性延伸；σ(s) 为按 target 过滤后的非空 verified rendition 集合（一个阶段可由多块服务，不是单值函数）。
- **as-run 是轨迹不是截面**：截面无历史；学习有回看/乱序/缺失。
- **Version = 冻结快照 + planPin**；版本间不持久化映射，staleness/迁移由 pin 比较派生。
- 只保留四条可执行事实：偏序+拓扑序→线性化正确；纤维非空→发布门；跨度+拉回→多对多与覆盖；版本 pin→确定性与 stale。**数学词只进文档与不变量，不进代码框架。**

### C3 数据模型（15 实体，v1）

| 实体 | 关键字段 | 约束 |
|---|---|---|
| Course | courseKey、categoryPath、titleLocalized、publishTargets[{languages 有序回退链, modalities}] | 无本地分类表、无时间轴字段；publishTargets 空=不可发布 |
| Stage | courseKey、stageKey（稳定不可变）、parentStageKey、orderKey（程序生成）、kind(program/phase/stage/step)、goal、objectiveKeys、exitEvidence[]、exitRollup(all/anyOf/atLeast)、durationBudget?、status | 包含森林（≤1 父、无环）；交付叶=无子节点且 objectiveKeys/exitEvidence 非空；容器 exitEvidence 必须为空 |
| PrerequisiteEdge | fromStageKey、toStageKey、kind(requires/recommends) | requires 进入交付序；多父允许；与 sequence 闭包合并后无环 |
| Objective | objectiveKey、statement、status | 退役不复用 |
| EvidenceSpec | evidenceKey、version、kind(assessment/artifact/performance)、objectiveKeys、measure、scoring、threshold、attempts | completion/出勤/自报/观看完成率**不得**作为证据 |
| ContentSpec | contentKey、version、type(6 类闭集)、titleLocalized、blocks[]、objectiveHints?(弱)、sourceRefs? | 发布后不可变；不含 stageKey/排序 DSL/权威锚点/时长 |
| Block | contentKey、version、blockId（稳定不复用）、kind(text/video/audio/image/model3d/question/code)、payload | blockId 是机器可引用最小单位 |
| Rendition | renditionKey、contentKey、blockId、language、modality、occurrenceKey、carrierType(asset/document)、carrierKey、carrierVersion、startMs?/endMs?、headingCode?/offset?、anchorSource(subtitle/chapter/asr/forced-alignment/doc-structure/import-legacy)、revision | `UNIQUE(contentKey,blockId,language,modality,carrierType,carrierKey,carrierVersion,occurrenceKey)`（全 NOT NULL）；`0≤startMs<endMs≤durationMs`；坐标单源 |
| MediaAsset | assetKey、assetVersion、kind、language?、durationMs?(容器探测)、uri | 身份=(assetKey,assetVersion)；**无哈希**；duration 仅属性 |
| Alignment | alignmentId、stageKey、renditionKey、objectiveKey、role(primary/support/assessment/auxiliary)、status(存储 proposed/verified/rejected；stale 读时派生)、provenance(human/import/legacy/semantic)、sourceKind(subtitle/chapter/asr/forced-alignment)、sourceArtifact、modelVersion?/params?/ruleVersion、verifiedBy/verifiedAt、verifiedAgainst{renditionRevision,carrierVersion,specVersion} | `UNIQUE(stageKey,renditionKey)`；provenance≠human ⇒ 创建时 proposed；verified 必须有人签收 |
| ContentVersion | contentVersionId、courseKey、versionNo(单调)、frozenAt、stages、prerequisiteEdges、specPins、renditions、alignments(仅 verified)、evidenceSpecs、assetPins、categoryPath、planPin{planId,planVersion} | 冻结时对齐全部 verified 且非 stale；只含稳定键；发布后不可变 |
| Plan | planId、contentVersionId、targetId、planVersion(单调)、inputClosure、status(draft/approved/degraded/blocked/superseded，外置)、entries[]、warnings[]、compilerVersion、ruleVersion | canonical JSON bytes 不含 status/时间戳/随机/locale；同输入重编译 bytes 相等 |
| PlanEntry | entryId(stageKey+alignmentId+occurrenceKey)、stageKey、alignmentId、orderKey、placement(media[assetKey,assetVersion,startMs,endMs]/document[documentKey,documentVersion,headingCode?,offset?]/assessment[contentKey,blockIds]/gap[reason])、status(ok/degraded/blocked) | 引用必须 verified；gap 只用于显式 degraded |
| PlanApproval | planId、planVersion、decision、approvedBy、approvedAt、acceptedWarnings | 绑定 canonical bytes 的 planVersion；apply 只认已批准 |
| LearningEvent | eventId(幂等)、userId、sessionId、type(started/completed[+paused/resumed/abandoned])、occurredAt、receivedAt(权威)、contentVersionId、stageKey、sequence | append-only；completed 前必须有 started |
| EvidenceAttainment | contentVersionId、stageKey、evidenceKey、attemptNo、score/rubricLevel、attained、gradedBy、gradedAt | 证据达成的唯一账本；发布门与 as-run 读它 |

### C4 不变量与发布门

阻塞级（发布必须全过，违反即 `blocked` 并给出显式 gap）：
- **STR-1 包含森林**：≤1 父、无环、父子同课程；`kind` 层级合法；交付叶必须有非空 objectiveKeys 与 exitEvidence；容器 exitEvidence 为空。
- **STR-2 交付序无环**：sequence 兄弟链投影到叶 + requires + （v1.1 choice 选中链）合并后 SCC 均为单点。
- **STR-3 线性化确定性**：λ 唯一算法（前驱就位者中按 orderKey 路径字典序 + stageKey tie-break）；parallel 有规范顺序但不产生边；golden bytes 锁定。
- **STR-4 阶段由证据定义**：completion 是 completionRule，不是证据；证据 kind 封闭 assessment/artifact/performance。
- **STR-5 证据绑定**：每个 exitEvidence 必须解析到同型 EvidenceSpec，且存在 verified assessment alignment 指向其 measure 的 spec/blockIds，objective 覆盖成立。
- **STR-7 先修**：端点存在、同课程、无自指；requires ∪ sequence 闭包无环；recommends 只出 warning。
- **ALN-1 纤维非空**：每个交付叶 × 每个 target 必须有按回退链与 modality 过滤后的 verified 对齐；否则该 target blocked。
- **ALN-2 只吃 verified**：PlanEntry 只能引用 effStatus=verified；proposed 仅 draft；rejected 不参与；stale 阻塞。
- **ALN-3 粘合/坐标单源**：Rendition 业务键全局唯一；Alignment 不存坐标；多阶段共享同一 rendition 同一坐标；verifiedAgainst 与当前 pin 一致。
- **ALN-4 教学覆盖**：每个交付叶的每个 objective 至少一个 verified primary 对齐（support/auxiliary 不计）；缺失 ⇒ blocked + 显式 gap。
- **ALN-6 stale 派生**：effStatus=stale ⇔ 审计元组与 pin 集不匹配；读时派生，无写传播；stale 不得被 plan/发布引用。
- **ALN-7 时间源完备（产品级硬需求）**：每个视频 rendition × 每个语言必须有机器时间源与对齐（`subtitle | chapter | asr | forced-alignment`）；无源 → `TIMING_SOURCE_MISSING`，置信度不足 → `ALIGNMENT_LOW_CONFIDENCE`；两者均使该阶段 blocked（交付叶被阻断即不可发布），错误带源坐标。ASR 模型版本/参数/ruleVersion pin 进 provenance，同输入重复派生逐条一致。
- **TIM-1 时间来源**：坐标只能来自容器探测/字幕/章节/DOCX 结构；无源 ⇒ `TIMING_SOURCE_MISSING`，不猜。
- **PLN-1 Plan 确定性**：同一 inputClosure + ruleVersion + compilerVersion 必须产出字节相等的 canonical plan。

发布门：G1 包/契约闭合；G2 结构+覆盖+证据绑定（STR/ALN）；G3 确定性+预算；G4 PlanApproval 人签（acceptedWarnings 显式）；G5 冻结快照（pins 齐全）。

### C5 管线与失败语义

P0 契约冻结 → P1 parse → P2 validate → P3 deriveTiming → P4 align → P5 plan → P6 apply/publish → P7 run → P8 change/restore/round-trip。
- **P0**：同一 schema 源生成 package-v2/template-v2/snapshot-v3/plan/event 契约与校验器；CI grep 断言（模板无时间列、全库无 hash 身份字段、旧包拒绝、plan 无 wall-clock）。
- **P1**：`PACKAGE_FORMAT_UNSUPPORTED` / `TEMPLATE_FORMAT_UNSUPPORTED` / `PACKAGE_FILE_MISSING/UNKNOWN` / `HUMAN_TIME_FORBIDDEN` / `CATEGORY_NOT_FOUND`。
- **P2**：error 整包拒绝（原子）；incomplete（缺语言/缺证据规格）允许入库、阻止发布；warning 入报告不静默。
- **P3**：容器探测 duration；时间源按优先级——① 外部字幕 cue（SRT/VTT）② MP4 chapter track ③ **ASR（默认兜底，从音轨生成转写与时间，内部派生工件、非交付物）** ④ 强制对齐（仅课时显式声明"文本稿=口播稿"时）；DOCX Heading 仅用于文本锚点；**每个语言独立派生**（en-GB/zh-CN 视频各自时间源）；点锚点按 ruleVersion 展开为 `[start,end)`（规则见 C7）；ASR 模型版本、参数、ruleVersion 全部 pin 进 provenance，同输入重复派生逐条一致；低置信 → `ALIGNMENT_LOW_CONFIDENCE`，无源 → `TIMING_SOURCE_MISSING`，越界/负值带源坐标 error；输出审计报告（毫秒、`mm:ss.mmm`、邻近文本、sourceKind），语义真实性靠 Sandbox 播放复核。
- **P4**：同一事务从 Part B payload 派生 ContentSpec/Block/Rendition；生成 proposed Alignment（仅从旧内容重绑或显式 binding seed 生成；**全新包不猜 stage↔内容绑定**）；旧 spec 置 superseded；blockId+anchorSig 不变则重绑，否则 stale。全新课程的人选绑定走 Admin API：`POST /api/backoffice/courses/:courseKey/partc/alignments`，body `{stageKey, renditionKey, objectiveKey, role}`，写入 `status=proposed / provenance=human`，随后必须走 `alignments/:id/sign-off` 人签收（服务端校验 stage 属于课程、objective 属于该 stage、rendition 已落库；`(stageKey,renditionKey)` 冲突返回 409）。
- **P5**：`compilePlan` 纯函数；输入闭包（显式结构，见 C6）；检查 STR/ALN/TIM/PLN；λ+σ+预算；输出 canonicalJson + planId + status + warnings + ruleTrace；preview 与 save 同一函数。
- **P6**：save 必须携带 preview 的 `planId + planVersion` 且服务端重算 bytes 相等（不等 ⇒ `PLAN_PREVIEW_STALE`）；apply/publish 校验 status/审批/inputClosure 重算一致后单事务写 ContentVersion + planPin + live 指针。
- **P7**：Portal 只读已发布快照 + pinned plan；媒体只引用 assetKey+assetVersion+半开区间（不切片/不转码）；事件 append-only；证据由评分/教师写 EvidenceAttainment；as-run 对账。`404` 未知 stage/version；离线补报超窗拒绝；completed 无 started 拒绝。
- **P8**：新 assetVersion → 草稿 stale 报告（受影响阶段/对齐清单）→ 重新派生验证 → 新 plan/新版本；Restore 按旧 pins 重建草稿（缺资产 `ASSET_NOT_FOUND`，草稿不变）；导出/导入 round-trip 语义等价。

### C6 Plan 工件（无哈希版）

- **inputClosure（显式结构，非 digest）**：`{courseKey, structureRevision, specPins[], assetPins[], alignmentSetVersion(单调计数器，verified/rejected/stale 影响时+1), targetId, resolvedChoices, ruleVersion, compilerVersion}`。
- `planId` = `(courseKey, contentVersionId, targetId, planVersion)` 的显式记录；`planVersion` 单调递增；canonical JSON bytes 存原文，**比较用字节相等**，不用 digest。
- `status` 外置在 Plan 表/PlanState，不进 bytes；PlanApproval 绑定 `(planId, planVersion)`；save 携带 `(planId, planVersion)`，服务端重算 bytes 不等 ⇒ `PLAN_PREVIEW_STALE`。
- 确定性：无 wall-clock/随机/locale；同输入 bytes 相等（golden 测试）。
- 三视图 diff：tree diff、alignment matrix diff、rundown diff；as-run 与 plan 的逐 entry 对账（not-started/started/completed/missing/out-of-order/repeat/completed-without-start）。

### C7 时间与媒体

- 时间三角色：媒体固有属性（容器探测，输入）、设计约束（durationBudget，仅对媒体求和校验）、派生排期（Plan/展示，输出）。
- v1 派生源（按优先级）：① 外部字幕 SRT/VTT；② MP4 chapter track；③ **ASR（默认兜底：从音轨生成转写与时间，内部派生工件，非交付物）**；④ 强制对齐（仅当课时显式声明"文本稿=口播稿"时启用）。DOCX Heading 仅用于文本锚点。**每个语言独立派生**（en-GB/zh-CN 视频各自时间源）。ASR 模型版本、参数、ruleVersion 全部 pin 进 provenance；同输入重复派生逐条一致。审计字段：`sourceKind ∈ {subtitle, chapter, asr, forced-alignment}`、`sourceArtifact`（字幕/章节轨文件或 ASR 转写工件）、`modelVersion/params/ruleVersion`。
- **点锚点 → `[start, end)` 规则（写入 ruleVersion）**：有字幕 cue ⇒ 用 cue 区间；只有点锚点 ⇒ `end = 同 stage 下一个锚点 - 1ms`，否则 `end = duration`；最小窗口/最大窗口/gap 阈值以参数形式版本化；`0 ≤ start < end ≤ duration` 强校验。
- 审计报告：每个锚点的毫秒值、`mm:ss.mmm`、邻近文本片段；人只在 Sandbox 播放复核，不输入时间。
- 禁止清单：模板时间列、估算时长、clamp、冒号解析、手工打点、把 duration 估算进课程总时长。课程总时长 = 视频时长求和（纯文本课不显示）。

### C8 证据与学习会话

- EvidenceSpec 三型：assessment（引用 assessment 型 ContentSpec 的 question blocks）、artifact、performance（rubric）；`exitRollup ∈ all/anyOf/atLeast(n)`。
- EvidenceAttainment：唯一账本，写入方=评分服务/教师；发布门与 as-run 都读它；completion 不写此处。
- LearningEvent：见 §12 已定契约（eventId 幂等、receivedAt 权威、completed 前必须 started、按 contentVersion+stageKey 关联）。
- as-run：事件 × plan 投影；与 plan 的差异显式状态化，不写回 Plan。

### C9 实施顺序与待删清单

1. 执行 §13 待删清单（两个 content 迁移、6 个 content 测试、schema 内容 hunk、重建 e2e 库）。
2. P0 契约冻结：contracts（Zod）+ 版本矩阵 + CI grep 断言。
3. 按实体建 Prisma 迁移（NULLS 安全的唯一键；CHECK 约束）；DB 约束兜住 Prisma 表达不了的规则。
4. 编译器（parse/validate/deriveTiming/align/plan/apply）纯函数核心 + 薄壳；golden bytes 测试。
5. 管理端 API（stage 编辑、预览/签收/发布、证据规格）；Portal 事件域（append-only 表）+ as-run 对账。
6. 黑盒测试（对应长程测试计划 T1–T8）+ 真实 165MB 夹具；CI e2e job。
7. Review Agent 门禁 → fork CI → 上游（owner 确认）。

### C10 环境模型（Sandbox / Production）

对应 PRD §3.1（两套环境，同一套代码）、§15.3（版本编号与 Source）、§14.1（Re-confirm）。

1. **资产身份跨环境稳定**：`assetKey` MUST 像 Course ID 一样环境无关（不得是环境本地 UUID/自增）；`assetVersion` 在同一 key 下语义一致。Production 导入课程包时按包内同一 `assetKey + assetVersion` 在新环境落地文件并登记；落地报告列出每个资产的落地结果（新增/复用/失败）。
2. **verified 对齐的携带规则**：Alignment 的 `verifiedAgainst` 审计元组包含 `(assetKey, assetVersion, 文件未转码标记)`。跨环境导入时：
   - 目标环境直接使用同一 `assetKey + assetVersion`（不转码、不换文件）→ 对齐**保持 verified**，审计元组随包带入；
   - 目标环境转码/替换文件（产生新 assetVersion）→ 相关对齐自动 **stale**，必须按 C7 重新派生并确认（PRD Re-confirm 的正式化）。
3. **版本标签环境局部**：Sandbox 版本号 `X.Y` 与 Production `Version N` 互不通用。`ContentVersion` 增加 `sourceEnv`（sandbox/production）与 `sourceLabel`（如 `Sandbox 4.2`）；Production 的 `versionNo` 本地单调生成，`sourceLabel` 记录来源（PRD 的 Source 字段）；包 manifest 的 `annotations` 记录来源，**不参与身份与幂等**。
4. **审计报告随包/快照走**：时间审计与证据审计（派生源 subtitle/chapter、`ruleVersion`、验证人、验证时间、审计元组）随包 `annotations` 与快照 provenance 区块携带；Production MUST 能查询"这条时间/对齐是在 Sandbox 里由谁、基于哪份字幕/章节、何时验证"，用于争议追溯。审计数据不参与身份、幂等与 staleness 判定（staleness 只看审计元组与 pins 的匹配）。
5. 职责边界：Sandbox 承担端到端测试与**语义真实性播放复核**；机械校验（格式/范围/覆盖/一致性）全部由编译器执行，环境差异不得改变校验结果。
6. **包 provenance 与来源强制**（owner 决策：Production 只接受 Sandbox 导出的包）：
   - manifest v2 MUST 携带 `provenance: {sourceEnv: 'sandbox'|'production', sourceVersionLabel: 'X.Y', exportedAt, exportedBy, courseKey, planPin, approvalRef, auditSummaryRef, asr: {modelVersion, params, ruleVersion}}`；ASR 相关 pin 用于派生确定性与争议追溯；
   - 服务端强制：生产环境导入仅接受 `provenance.sourceEnv === 'sandbox'` 且 `formatVersion === 2` 的包，否则 `PACKAGE_SOURCE_NOT_ALLOWED`；来源判定只看服务端解析出的字段，MUST NOT 依据文件名/路径/声明位置；
   - `provenance` 不参与包身份、幂等与 staleness；`planPin/approvalRef` 指向已签收的 Plan 与审批记录，供追溯。
   - 旧 v1 包无 provenance、无 verified 对齐、无 asset pins、分类为显示名——**无法满足该决策，必须升级到 v2**（不提供兼容）。
7. **环境能力矩阵与 RBAC**（服务端强制，不靠 UI 隐藏）：
   - Production：禁用内容编辑/新建课程/改结构（403 `CAPABILITY_DISABLED`）；允许 import、plan preview/approve、publish、restore、change status、operations；
   - Sandbox：允许全部授权（内容编写 + 导入 + 发布演练）；
   - RBAC 增加显式 capability：`course.authoring`、`course.import`、`course.publish`、`course.status`，路由层统一判定（替换现有"课程菜单 VIEW/EDIT"、且 EDIT 可改分类的旧模型）；分类修改归 `course.authoring` 且仅 Sandbox。
   - 边界澄清："不允许维护" ≠ "不允许发布/上下架"：PRD §15/§17 要求 Production 导入后 Publish、Change status；"维护"精确指内容编辑/新建/结构变更。
8. **Production 唯一内容写路径 = 导入包**（不变量，与服务端 capability 双重保障）：生产环境不存在任何非导入的内容写入路径（API 层同时校验 capability 与来源 provenance）；该不变量纳入发布门检查与 Code Review 清单。
- **数学骨架（用于写不变量，不用于造框架）**：基空间 B = 阶段偏序（包含树 + 先修 DAG；**DAG 不是树**——树是"唯一父"的特例，先修允许多父，把 DAG 压成树只能复制节点或丢身份）；纤维 F_b = 服务于阶段 b 的各 rendition（视频区间/文本块/测评/展品/语言变体）；对齐 = 局部平凡化之间的转移/粘合数据，`verified` = 粘合条件成立，`stale` = 转移断裂；**Plan = 在 B 的一个线性延伸上的截面**；**as-run = 学习者实际走过的截面**；内容版本 = 一个带图册的丛（发布=冻结，迁移=丛映射）。基是离散偏序，精确对象是**偏序集上的层（sheaf）**，纤维丛是连续类比。由此得到四条可实现的不变量：① 每个可发布阶段的纤维非空且全为 verified；② 重叠处粘合一致（同一 content block 服务多个 stage 时坐标一致）；③ 每个 target 存在截面（Plan 可交付）；④ 先修关系无环（B 是偏序而非预序）。
- **历史与追溯不使用内容哈希**：版本 = 不可变快照 + 追加写的发布记录（`versionNo/releaseId`、`publishedAt`、`validFrom/validTo`、操作者、变更摘要）；"某时刻线上是哪一版" = 查询发布记录的生效区间（valid time；记录写入时间另存为 transaction time）；版本差异按需计算（diff on demand），不预存指纹；操作历史 = append-only 事件日志。变更是否发生由写入路径显式记录，不靠内容比对推断。
- **prior-art 对齐（包与媒体调研）**：包结构采用 OCI manifest 骨架（`schemaVersion`、`mediaType`、`resources[{id, kind, size}]`）+ glTF 能力声明（`minReaderVersion`、`extensionsUsed/extensionsRequired`，未知 required 一律拒绝整包）+ EPUB/SCORM 的 structure 树 + 稳定 id；时间锚点采用 xAPI Video Profile/Media Fragments 的**半开区间** `[startMs, endMs)`（校验 `0 ≤ start < end ≤ duration`），内部整数毫秒；引用采用 IIIF/Web Annotation 的 selector 形态（不自创 selector）；版本采用 IMF 思路（版本=新 composition + 复用已有资产）+ 单调 `versionNo`；幂等采用 kubectl apply/prune 的 last-applied + 写后删差集（只删旧清单记录过、新清单不再引用、且无其他版本引用的资源）。**所有 digest/哈希机制不采用**（owner 决定）：包身份 = `(formatVersion, courseId, contentVersionNo)`；资源完整性靠 ZIP CRC32 + 大小/类型校验；同一 `(courseId, versionNo)` 重复导入为 no-op。

## 15. 实施回填（2026-11-12 阶段 5 INTEGRATE）

- **C9 草稿状态**：`CommerceCourse.draftRevision/liveBaseRevision` 已接入全部写入路径；`No draft ⇔ draftRevision == liveBaseRevision`，内容哈希不再参与 No draft（只作诊断字段保留）。Publish 不再做"内容相同则跳版本"的去重；Restore 线上版本 → No draft，Restore 旧版本/导入 → 有草稿。E2E：`category-version`、`commerce-courses-workflow`。
- **C7/I9 快照 v3**：`captureVersionSnapshot` 输出 `formatVersion: 3` + `course.categoryPath`，不写 `categoryId`；恢复/导出/投影按"含 categoryId 键 = v2、按 id 解析；否则按 path 解析"的规则处理，失败 `CATEGORY_NOT_FOUND` 且草稿不变。E2E：`category-version`、`category-package`。
- **C8 投影**：Portal 列表/详情/历史预览的 `category/categoryLocalized` 取线上版本快照的 `categoryPath`（显示名取当前分类行 localized），草稿改分类不泄漏。E2E：`category-version`。
- **C5/C6 课程包 v2（Part A 分类）**：`formatVersion = 2`；`course.categoryPath: string[] | null` 取代 `course.category`；缺失/旧字段 → 上传校验 `PACKAGE_FORMAT_UNSUPPORTED`（job report 带码）；导入按路径逐级匹配 ACTIVE（name/localized、trim、大小写不敏感），与课程写入同一事务，失败整包拒绝且不创建分类；导出只出 v2、未分类为 null、无占位词。E2E：`category-package`。
- **C3/C4 绑定校验**：创建/更新课程统一校验分类存在、ACTIVE、层级 ≤ 2（`CATEGORY_REQUIRED/NOT_FOUND/ARCHIVED/INVALID_LEVEL`）。I3 深度规则回到服务层：迁移 `20261112080000_catalogue_depth_service_rule` 把 DB 触发器收敛为仅 I4 自指/父存在性兜底；S2 的 I3 DB 边界用例按该文件头注记移交给 S3 服务层用例。E2E：`category-course-binding`、`category-invariants`。
- **C1**：`GET /api/portal/v1/categories` 已实现（ACTIVE 嵌套树、`sortOrder,name`、不暴露 UUID、`Cache-Control: private, max-age=60`）。E2E：`category-portal-api`。
- **C10.6 来源强制（休眠）**：`PACKAGE_SOURCE_ENFORCEMENT` 默认 off；on 时生产目标仅接受 `provenance.sourceEnv === 'sandbox'`，否则 `PACKAGE_SOURCE_NOT_ALLOWED`（只读服务端解析字段）。Part C `parsePackage` 与既有课程包导入端点（confirm 认领后、写入前）都已接线；off 时导入行为与现状完全一致。C10 错误码置于 `errors.ts` 的 `PART_C_ENVIRONMENT_ERROR_DEFINITIONS`，C5 冻结码表不变。单测：`parse.spec.ts`；E2E：`partc-environment`。
- **C10.7 能力强制（休眠）**：`ENV_CAPABILITY_ENFORCEMENT` 默认 off（off 时路由行为与现状一致）；on 时 `CourseCapabilityGuard` 按服务端 `VERSION_NUMBERING_MODE` 强制四能力，Production authoring → 403 `CAPABILITY_DISABLED`，import/publish/status 可用；导出不归 authoring。E2E：`partc-environment`；单测：`contracts/environment.spec.ts`。
- **C7/ALN-7 视频时间源**：`derive-timing.ts` 实现"字幕 > 章节 > ASR（默认兜底）> 强制对齐"，每语言独立派生；低置信 → `ALIGNMENT_LOW_CONFIDENCE`，无源 → `TIMING_SOURCE_MISSING`；`manifest.provenance.asr` 的 modelVersion/params/ruleVersion 与实际工件不一致即拒绝。单测：`derive-timing.spec.ts`、`invariants.spec.ts`、`parse.spec.ts`。
- **集成遗留（非本轮设计引入，目标分支 HEAD dd08e83 同样红）**：`ai.e2e-spec.ts` 的 history/Release 隔离/限流分桶 3 例与同仓既有契约互相矛盾（详见实现报告 blockers），待 Owner 裁决后修测试或改产品行为。
- **接线范围校正（2026-11-13 FIX2-WIRING）**：Part C 的存储、编译器与管理端 API（含对齐人签收）**在 Admin 侧已端到端接线**；Portal 侧只接到学习事件域，`learning_plan_entries` 投影写入方仍为 **P1**。无投影部署的事件端点按 contentVersionId 记录并标 `stageValidated=false`（不 404、不猜 stage）；有投影时仍严格校验 stageKey（C5 P7）。

## 16. 实施回填（2026-11-12 阶段 2A FIX-ADMIN：导入/导出/快照接线）

- **Part C v2 包导入（C5 P1–P4）**：`POST /courses/import` 上传校验按契约分派——Part C v2 包（`PackageManifestV2Schema` 唯一 SSOT）走 `parsePackage → validatePackage → deriveTiming → alignPackage`（`src/commerce-courses/partc-import.ts`），确认导入在同一事务内解析分类并写 pc_* 实体（PcCourse/PcStage/PcPrerequisiteEdge/PcObjective/PcEvidenceSpec/PcContentSpec/PcBlock/PcRendition/PcMediaAsset/PcAlignment）；`verified` 对齐绝不被导入覆盖（人签优先）。旧聚合形状只保留为兼容读取（原始素材转换与既有 staged 包），旧 v1 包上传继续 `PACKAGE_FORMAT_UNSUPPORTED`。E2E：`partc-package`（导入→字幕派生时间→preview 数据→pc_* 落库）。
- **Part C v2 包导出（C6/C10.4/C10.6）**：`exporter.ts` 只产出 Part C v2 包（manifest 通过 SSOT schema 校验后写出）；`provenance` 含 sourceEnv/sourceVersionLabel/planPin/approvalRef/auditSummaryRef 与 asr pins（沿用导入 provenance 或本环境 PcContentVersion pin），`annotations` 含 slug/来源/导出元数据；包闭合、无任何哈希清单；旧模板时间以机器章节源 `chapters` 随包携带，导入端按 C7 规则重新派生毫秒区间。Round-trip：导出→再导入同一课程（E2E `partc-package`、`category-package`）。
- **分类路径（阻断 9）**：草稿导出经 `categoryPathForId` 写完整父链（二级分类不丢父级）；历史版本导出继续用版本快照的 `categoryPath`。E2E：`partc-package` 二级分类导出/导入。
- **快照 v3 provenance 区块（C10.3/C10.4）**：`captureVersionSnapshot` 从该课程最近一次成功导入的包 manifest 携带 `provenance`/`annotations`（缺省不带，不参与内容身份）；导出优先沿用快照 provenance。E2E/单测：`partc-package`、`partc-package-roundtrip.spec.ts`。
- **DB 约束修正**：`pc_stage` 的「同父 orderKey 唯一」改为 `(courseKey, parentStageKey, orderKey)`（迁移 `20261112100000_pc_stage_unique_per_course`）——原全局 `(parentStageKey, orderKey)` 会让不同课程的根节点 `000001` 互相判重，第二门课程无法导入。
- **边界（交由后续阶段）**：① `src/partc/compiler/parse.ts` 仍在契约外私建 provenance schema（评审阻断 3 的 FIX-CORE 部分；已在阶段 1 FIX2-ADMIN 删除）；② **Admin 侧已接线**：Part C 管理端 API（stage 编辑、证据规格、计划 preview/save/approve/apply/publish）与对齐人签收 API（proposed→verified/rejected，见 §17）已实现；**Portal 侧 plan 消费仍为 P1**：`learning_plan_entries` 无写入方，Portal 事件端点在该部署无投影时按 contentVersionId 记录且 `stageValidated=false`（不 404、不猜 stage），有投影时仍严格校验 stageKey；③ 原始素材转换（`excel-package`）仍产出旧聚合形状包，切到模板 v2 属清理阶段；④ 双语元数据缺失在导出/导入以 `LANGUAGE_MISSING` warning 显式报告（不造假翻译）。

## 17. 实施回填（2026-11-13 阶段 1 FIX2-ADMIN：阻断 2/3 与安全项）

- **契约单一（阻断 2/3 的编译器部分）**：`src/partc/compiler/parse.ts` 删除本地 `PackageProvenanceSchema`/`PackageProvenanceAsrPins`/`PackageParamValue` 与 `splitManifestEnvelope`/`assertProvenanceMatchesCourse`；`parsePackage` 直接用 `PackageManifestV2Schema` 解析整包，provenance/annotations 与其余字段同源（契约唯一 SSOT）。`contracts/index.ts` 增补 `export * from './environment'`（SourceEnv 为契约类型）。
- **anchorSource 契约补齐（阻断 5 的 FIX-CORE 部分）**：`align.ts` 删除 `isAnchorSourceContractGap` 死分支与 `as unknown as Rendition` 强转；契约 enum 已含 `asr`/`forced-alignment`（另含 `doc-structure`），派生 rendition 一律经 `RenditionSchema` 校验。
- **C10.6 生产导入来源门（严格版）**：`PACKAGE_SOURCE_ENFORCEMENT=on` 且生产环境时，`confirmImport` 先按 `PackageManifestV2Schema` 严格校验整包，再判 `provenance.sourceEnv === 'sandbox'`；legacy 聚合形状、伪造 provenance 的包一律 `PACKAGE_SOURCE_NOT_ALLOWED`，绝无 legacy importer 兜底。off 时行为与现状完全一致。E2E：`partc-environment`（新增「伪造 provenance 的 legacy 包被拒」）。
- **raw 素材导入退役（阻断 2 的清理部分）**：`excel-package` 的原始素材转换不再声明 `formatVersion: 2`，改为显式 `LEGACY_PACKAGE_FORMAT_VERSION`（1）+ `EXCEL_TEMPLATE`/`EXCEL_IMPORT` 来源标识；`manifest.validate` 对该标记整体拒绝（`PACKAGE_FORMAT_UNSUPPORTED`，消息指明 raw 导入退役、改用 Part C v2 包）。**v2 路径删除 `checksums.sha256` 校验**：`package-inspector` 不再校验（v2 包靠闭合 resources + 大小校验；C0 红线⑦无哈希），raw 转换也不再产出 checksums 清单。`package-inspector.spec` 夹具迁移到 Part C v2 形状（并新增 legacy 标记拒绝用例）。
- **C10.3/C10.4 导出审计**：`exporter` 从 Pc 真源读取 verified `PcAlignment`（含 sourceKind/sourceArtifact/modelVersion/params/ruleVersion 与 verifiedBy/verifiedAt/verifiedAgainst 审计元组）与 `PcRendition.anchorSource`；`annotations.timingSources` = 二者并集（无 Pc 数据时回退 `import-legacy`），`content.alignments` = 能被本包表达（stage/rendition/objective 均在包内且 `verifiedAgainst` 与导出 revision/carrierVersion/spec pin 一致）的 verified 对齐，原样携带审计元组（`partc-export.exportableAlignments`，绝不伪造）。apply 冻结 `PcContentVersion.sourceLabel` 取包 `provenance.sourceVersionLabel`（经 `CommerceCourse.draftSourceVersionLabel`，非导入内容不写）。E2E：`partc-package`（verified 对齐 + 审计元组导出→再导入保持 verified 且逐字段一致）、`partc-api`（sourceLabel）。
- **保留的边界**：legacy 聚合形状仍作**历史 staged 包**的兼容读取路径（不开新写出路径；raw 转换已改用 legacy 标记并被拒）；`content-hash`/`packageHash` 等诊断字段不参与身份（C0 红线⑦）；`ai.e2e` 3 例既有矛盾未触碰（Owner 裁决项）。**已闭合的边界**：对齐人签收 API（proposed→verified/rejected，人签 + 服务端派生 verifiedAgainst + 审计元组）已接线，`compilePlan`/冻结只消费 verified；导出原样携带 verified 对齐与审计元组；Portal `learning_plan_entries` 写入方仍为 P1（事件端点无投影时 `stageValidated=false`，见 §16 边界②）。

## 18. 实施回填（2026-11-13 阶段 2 FIX3-EXPORT-RESTORE）

- **A/C 导出以 Pc 真源为准**：`exporter.ts` 新增 `loadPcRenditions`/`loadPcAssets`，`partc-export.ts` 增 `pcRenditions`/`carriedAssets`/`prerequisiteEdges` 选项。`content.renditions` 直接使用 `PcRendition` 记录（稳定 renditionKey/carrierKey/carrierVersion/revision/坐标/anchorSource），不再从 legacy 聚合合成 `step-<lessonCode>` / `video-<lesson>-<lang>` / `exhibit-<code>` 键；`content.prerequisiteEdges` 原样携带 `PcPrerequisiteEdge`（DAG 不是树）；`content.assetPins` 并入 Pc 载体身份。媒体字节按 `assetKey@assetVersion` 从 Pc 真源取：原始 DOCX（重建会丢 Heading/文本锚点）、视频、展品、缩略图（补齐 thumbnail 映射）与字幕/章节文件随包携带，保证跨环境派生与源环境一致。`remapAlignmentsToExportRenditions` 不再改写 `verifiedAgainst`（审计元组绝不伪造；与导出 revision/carrierVersion 不一致的对齐由 `exportableAlignments` 作为 stale 过滤）。
- **B 无时间源不写 0**：`PackageVideoLearningPoint.timeSeconds` 改为 `number | null`；`snapshot.ts`/`exporter.ts` 版本导出把缺失秒值写 `null`（不再 `?? 0`），`partc-export` 只对有限数值生成 chapters cue；无机器时间源时导出包不出现 0 起点伪时间。
- **C10.2 携带 verified 的导入落地**：`partc-import.persistProposedAlignment` 先以 `proposed` 创建（DB 触发器要求），再在同一事务更新为 `verified` 并写回审计元组；同 `assetKey+assetVersion`、锚点未变的跨环境对齐保持 verified（C10.2）。
- **D Part C Restore**：新增 `POST /api/backoffice/courses/:courseKey/partc/restore`（body `{contentVersionId} | {versionNo}`）。先校验分类路径（失败 `CATEGORY_NOT_FOUND`）与 version pins/rendition 载体资产（失败 `ASSET_NOT_FOUND`），再单事务整组重建草稿（stage/edge/rendition/evidence/verified 对齐/分类路径）；失败发生在写入前，草稿不变。Part C 发布路径（`plans/publish`）不经 legacy completeness 门。
- **E 可观察面**：新增只读 `GET .../partc/publications/live`（当前有效发布 + 内容版本）、`GET .../partc/publications`、`GET .../partc/content-specs`、`GET .../partc/renditions`、`GET .../partc/media-assets`，供黑盒断言 live 指针与残留/差集。
- **长程证据（本机 e2e DB）**：full scenario step7 导出 `alignments=7`、`renditions=21`（Pc 键）；step9 第二库导入阶段身份完全一致（`lesson-1/lesson-2/program-modeling-life`）、携带 verified=7。**测试期望待 controller 对齐（不改断言）**：step8 仍断言 `/partc/restore` 404（现端点已存在，空 body → 422）；step9 仍假设导出 0 对齐 → 第二库必须重新签收（现按 C10.2 携带 verified，proposals=0）。
