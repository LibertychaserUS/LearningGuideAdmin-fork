# Learning Guide BackOffice - Agent 开发文档

## 版本信息

| 项目 | 内容 |
|------|------|
| 项目名称 | Learning Guide BackOffice |
| 文档版本 | v1.0 |
| 后端技术栈 | Node.js + TypeScript（NestJS，2026-10-14 拍板） |
| 数据库 | PostgreSQL + Prisma ORM |
| 前端技术栈 | React + TypeScript + Vite |
| UI 框架 | Ant Design 5.x |
| Markdown 编辑器 | ~~md-editor-v3~~ **@uiw/react-md-editor**（需支持 LaTeX/KaTeX；2026-10-14 Phase 4 用户裁决改拍，见 §3.3.2） |
| 状态管理 | Zustand（全局状态）+ React Context（少量轻量配置，2026-10-14 拍板） |

---

## 1. 系统概述

### 1.1 系统定位

**Learning Guide BackOffice** 是一个结构化课程知识库管理系统，核心功能包括：

- **Knowledge System（知识库）**：管理课程结构（Course -> Lesson -> Page 三级树形），支持 Markdown 编辑（含 LaTeX 公式）、文件导入转 Markdown、版本发布与历史版本查看。
- **AI Tutor（AI 辅导）**：基于知识库内容，提供 Lecture 模式和 Socratic 模式的 AI 对话交互，支持 System Prompt 和 Welcome Message 自定义配置。
- **HelpDesk 工单（2026-10-28 新增，Tickets v1）**：学员在 Portal 提交的客服工单在 BackOffice「Help Desk」页以 Enquiries 三栏（Figma 1324:2）呈现，员工回复、写内部备注、打标签、标记已处理（请学员确认）；同页 Common Questions Tab 维护常见问题库。工单数据归 Portal（唯一写入方），BackOffice 只经 Portal 集成接口读写，见 §4A。
- **HelpDesk Common Questions 与推荐答案（2026-10-28 Figma 对齐）**：问答库归 BackOffice（唯一写入方，§4A.7），Portal 只读已发布的；学员提交前由 Agent 角色从已发布问答里推荐一条（§4A.8）。

### 1.2 核心对象

| 对象 | 说明 |
|------|------|
| Course | 课程，一级目录节点 |
| Lesson | 章节，二级目录节点，属于某个 Course |
| Page | 页面/内容，三级叶子节点，存储 Markdown 内容 |
| Release | 发布快照，记录某个 Course 在某一时刻的完整内容 |
| PromptTemplate | AI 提示词模板，预设 Lecture 和 Socratic 两种模式 |
| CourseAiConfig | 课程专属 AI 配置，关联 Course 和 PromptTemplate |
| AiChatSession | AI 对话记录 |

### 1.3 架构原则（不可协商）

1. **高可扩展性**：模块必须解耦。AI 模块不能使用硬编码的特定 LLM 厂商，必须使用**策略模式（Strategy Pattern）**或适配器模式，方便后续无缝接入任何第三方 API。
2. **高安全性**：所有 API 密钥必须通过环境变量注入，绝不允许出现在前端代码中。AI 请求必须经过后端代理（Proxy），**严禁前端直接调用 LLM API**。
3. **高可维护性**：代码必须包含详细注释。数据库表结构变更必须通过 Migration（如 Prisma Migrate）管理。
4. **可扩展性设计**：后端代码中预留"切片（Chunking）"和"向量检索（Vector Search）"的接口钩子（Hook），未来可直接平滑升级。

---

## 2. 数据库模型设计（Prisma Schema）

> 注意：以下 Schema 为最终版，Agent 开发前必须严格按此创建并执行 `prisma migrate dev`。
> 实装锁定 Prisma 6.x（v7 起移除 `url=env()` 写法，2026-10-14 拍板暂锁 6.x；双向关系已按 Prisma 要求补齐）。
>
> **2026-10-16 结构扁平化改拍**：原三级 Course→Lesson→Page 简化为两级 Course→Page。
> Lesson（文件夹）层删除：原 Lesson 标题变为 Page.title（md 文件标题），原 Lesson 下属各 Page 的内容合并为该 Page 的 contentMd，以 `# {原Page标题}` 作为 H1 section 拼接。
> Page 新增 `sectionTags`（Json）：按 heading（H1-H6，2026-10-19 由 H1/H2/H3 扩展）slug 映射用户自定义 tags，用于 AI 投喂时的语义标注。
>
> **2026-10-20 AI 配置改按 Release 维度改拍**（用户裁决）：`CourseAiConfig` 由「每课程一份」（`courseId @unique`）改为**每个 Release 一份**（`@@unique([courseId, releaseId])`；无配置行时按模板默认值运行，新建 Release 不继承）。
> 同时：① 课程级 Online 开关由 `CourseAiConfig.online` **搬到 `Course.aiTutorOnline`**（online 保持课程级语义）；② `Course` 新增 `aiTestReleaseId`——后台 AI Tutor **测试所选 Release**（null 时回退 `currentReleaseId`）。用户侧 AI Tutor 仍只读 `currentReleaseId`（上线版本）；③ `Course` 新增 `editingReleaseId`（2026-10-20 二次改拍）——**当前编辑版本指针**，历史弹窗 `editing` 标识来源，由「Create Release」与「切换到此版本」写入。

>
> **2026-10-28 HelpDesk 工单不建表**：工单、消息、附件、事件全部由 Portal 存储（Portal 是唯一写入方，见 §4A 与 `docs/System_Architecture_4_Components.md`）。BackOffice 不为工单新增任何 Prisma 模型或迁移，也不直连 Portal 数据库。
>
> **2026-10-28 HelpDesk 问答库与推荐日志建表（Figma addendum §A / §C）**：三张新表，只加不改：
> - `helpdesk_questions`、`helpdesk_question_revisions`（迁移 `20261028090000_helpdesk_questions`，归 BackOffice）：问答库与只追加的修订记录（触发器拒绝 UPDATE / DELETE）；`version` 乐观并发，修订与修改同一事务；全文 GIN 索引 `to_tsvector('english', question || ' ' || answer)` 与关键词 GIN 索引。
> - **Tickets v2（迁移 `20261029090000_helpdesk_faqs`）**：`helpdesk_faqs`（中英双语一行：`category` 四选一、`popular`、`question_en/answer_en/question_zh/answer_zh`、`keywords`、`status` published / archived、`version`）与只追加的 `helpdesk_faq_revisions`；`helpdesk_suggestions` 加 `faq_id`、`source`（submit / chat / chip），`category` 可空，outcome 增加 helpful / not_helpful。**运维说明**：`helpdesk_questions` / `helpdesk_question_revisions` 从 v2 起不再被任何代码读写（Common Questions 界面与 `/api/helpdesk/questions` 接口已删除），表与数据保留，留待之后单独的清理迁移删除；已提交的迁移一律不改。
> - **FAQ 检索拼写容错（迁移 `20261029150000_helpdesk_faqs_typo_keys`，2026-10-29）**：`helpdesk_faqs` 加生成列 `typo_keys`（`helpdesk_faq_typo_keys(question_en, keywords)`：≥5 个字母的词及每个删一个字母的写法，IMMUTABLE SQL 函数）与 GIN 索引 `helpdesk_faqs_typo_keys_idx`。**运维说明**：不需要任何扩展（没有用 pg_trgm）；加 STORED 生成列会在短暂的 ACCESS EXCLUSIVE 锁下重写 `helpdesk_faqs`（几十到几千行，瞬间完成）。
> - `helpdesk_suggestions`（迁移 `20261028090100_helpdesk_suggestions`，归 Agent）：每次推荐检索一行；`outcome` 首个为准；`query_text` 90 天后清空；`qa_id` 跨域不建外键。
> - Prisma 模型 `HelpdeskQuestion` / `HelpdeskQuestionRevision` / `HelpdeskSuggestion` 只声明表结构；CHECK、表达式索引与触发器以迁移 SQL 为准。

```prisma
// ==========================================
// 核心实体
// ==========================================

model User {
  id          String    @id @default(uuid())
  email       String    @unique
  name        String?
  courses     Course[]
}

// 第一层：课程 (Course)
model Course {
  id              String    @id @default(uuid())
  title           String
  description     String?
  externalId      String?   // 对应外部同步源的 ID
  structureJson   Json?     // 存储树形目录的原始结构，用于快速渲染
  currentReleaseId String?  // 上线版本指针（§3.4.3/§4.3.3）：用户侧 AI Tutor 读此 Release 快照
  // 后台「测试所选 Release」（2026-10-20 新增）：AI Tutor 后台测试对话读此 Release 快照；null 时回退 currentReleaseId
  aiTestReleaseId  String?
  // 当前编辑版本指针（2026-10-20 二次改拍，普通标量列，不建外键）：新建 Release 或「切换到此版本」后指向该 Release
  editingReleaseId String?
  // 课程级 Online 开关（2026-10-20 由 CourseAiConfig.online 搬移而来）：该课程 AI Tutor 是否对用户侧开放
  aiTutorOnline   Boolean   @default(false)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  pages           Page[]
  releases        Release[]
  aiConfigs       CourseAiConfig[]   // 每个 Release 各一份 AI 配置（2026-10-20 由一对一改为按 Release 一对多）
  // 反向关联（Prisma 双向关系要求）：users 为隐式多对多，
  // migrate 时生成联接表 _CourseToUser
  users           User[]
  aiChatSessions  AiChatSession[]
}

// 第二层：页面/内容 (Page)（2026-10-16 扁平化：原 Lesson → Page 合并）
model Page {
  id            String    @id @default(uuid())
  courseId      String
  course        Course    @relation(fields: [courseId], references: [id], onDelete: Cascade)
  title         String    // 原 Lesson 标题（md 文件标题）
  contentMd     String    @db.Text  // 合并后的 Markdown：各原 Page 以 `# {Page标题}` 为 H1 拼接（Lesson.title 不入内容）
  sectionTags   Json?     // H1-H6 级标签映射：{ "h1-slug": ["tag1"] }（2026-10-16：移除页面级 tags，仅保留 section tags 用于 AI 语义标注；2026-10-19：标签范围由 H1/H2/H3 扩展至 H1-H6）
  sortOrder     Int
  syncState     SyncState @default(SYNCED) // 外部源同步状态（§3.2.2）

  @@index([courseId, sortOrder])
}

// 全局 Tag 词库（2026-10-16 方案 B 轻量版：用户输入新 tag 自动沉淀，颜色自动分配）
model Tag {
  id      String @id @default(uuid())
  name    String @unique  // tag 名称（唯一）
  color   String          // 预设语义色（antd preset）或自动分配色
}

// 同步状态枚举（§3.2.2 外部源接管模型）
enum SyncState {
  SYNCED  // 与外部源一致
  STALE   // 本地独有或外部已变更，已失效（置灰，不作 AI Tutor 知识库）
}

// ==========================================
// 发布与版本控制
// ==========================================

model Release {
  id              String    @id @default(uuid())
  courseId        String
  course          Course    @relation(fields: [courseId], references: [id])
  versionTag      String    // 版本号，格式: "CourseName_YYYYMMDDHHmm"（精确到分钟）
  revisionNotes   String    @db.Text  // 本次修订的备注
  snapshotData    Json      // 完整内容快照: { pages: [{ id, title, contentMd, sectionTags }] }（2026-10-16 扁平化；去 tags）
  createdAt       DateTime  @default(now())

  // 反向关联：该 Release 对应的 AI 配置（2026-10-20 按 Release 一份）
  aiConfigs       CourseAiConfig[]

  @@index([courseId, createdAt])
}

// ==========================================
// AI Tutor 配置模块
// ==========================================

// AI 提示词模板库（预设两套模式）
model PromptTemplate {
  id              String    @id @default(uuid())
  mode            String    // 枚举: "LECTURE" | "SOCRATIC"
  systemPrompt    String    @db.Text  // 系统提示词
  welcomeMsg      String    @db.Text  // 欢迎语
  isDefault       Boolean   @default(false)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  // 反向关联：被哪些课程引用（CourseAiConfig 双外键需 Prisma 多关系命名消歧，2026-10-14 补齐）
  lectureConfigs  CourseAiConfig[] @relation("LectureTemplate")
  socraticConfigs CourseAiConfig[] @relation("SocraticTemplate")
}

// 课程 + 发布版本 专属的 AI 配置（2026-10-20 改拍：由「每课程一份」→「每个 Release 一份」）
// 2026-10-20 二次改拍（用户裁决）：System Prompt / Welcome Message / LLM Model 三者在各自维度上**再按模式（Lecture / Socratic）分别保存**
model CourseAiConfig {
  id                  String    @id @default(uuid())
  courseId            String
  course              Course    @relation(fields: [courseId], references: [id], onDelete: Cascade)
  releaseId           String
  release             Release   @relation(fields: [releaseId], references: [id], onDelete: Cascade)

  // 引用基础模板
  lectureModeId       String?
  socraticModeId      String?
  lectureTemplate     PromptTemplate? @relation("LectureTemplate", fields: [lectureModeId], references: [id])
  socraticTemplate    PromptTemplate? @relation("SocraticTemplate", fields: [socraticModeId], references: [id])

  // 覆盖自定义的提示词（按模式分开，可选；有值即优先于该模式模板）
  // 2026-10-20 由单一 customSystemPrompt / customWelcomeMsg 拆分而来（存量值迁移时两模式同时回填）
  lectureSystemPrompt   String? @db.Text
  socraticSystemPrompt  String? @db.Text
  lectureWelcomeMsg     String? @db.Text
  socraticWelcomeMsg    String? @db.Text

  // LLM 配置（llmProvider / llmBaseUrl / apiKey 课程级共享；model 按模式，null 时回退 AI_AVAILABLE_MODELS[0]）
  llmProvider         String    // 如: "openrouter"
  lectureModel        String?
  socraticModel       String?
  llmBaseUrl          String?   // 可选的自定义 Base URL
  apiKey              String?   // 加密存储

  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt

  // 每个 Release 至多一份配置（2026-10-20 改拍；原 `courseId @unique` 已移除）
  @@unique([courseId, releaseId])
}
// 注：课程级 Online 开关已移至 Course.aiTutorOnline（2026-10-20）；System Prompt / Welcome / Model 按模式分开（2026-10-20）；无该 Release 的配置行时按模板默认值运行。

// AI 对话记录（后台调试用）
model AiChatSession {
  id          String    @id @default(uuid())
  courseId    String
  course      Course    @relation(fields: [courseId], references: [id])
  messages    Json      // 聊天记录: [{role: 'user'|'ai', content: string, createdAt: ISOString}]
  mode        String    // 当前对话使用的模式: "LECTURE" | "SOCRATIC"
  createdAt   DateTime  @default(now())

  @@index([courseId, createdAt])
}

// AI 对话限流计数（2026-10-24 新增；原为进程内存，多实例时各算各的）
// 每次放行写一行；同一 key 用 pg_advisory_xact_lock 串行，滑动 60 秒窗口，被拒请求不计数
model AiRateLimitHit {
  id    BigInt   @id @default(autoincrement())
  key   String   // "<courseId>" 或 "<courseId>::study-group"
  hitAt DateTime @default(now()) @map("hit_at") @db.Timestamptz(6)

  @@index([key, hitAt])
  @@map("ai_rate_limit_hits")
}
```

### 2.1 初始种子数据（Seed Data）

初始化数据库后，必须插入以下默认数据（**例外：PromptTemplate 允许省略，2026-10-26 起运行时按 `src/ai/prompts/` 文件兜底**）：

**PromptTemplate 默认数据（2026-10-23 起改为独立文件源）：**

- System Prompt：`server/src/ai/prompts/lecture.md`、`server/src/ai/prompts/socratic.md`
- Welcome Message：`server/src/ai/prompts/welcome.yaml`（按 Lecture/Socratic × `zh-CN`/`en-GB` 维护）
- 同步命令：`npm run prompts:sync`（upsert `lecture-default` / `socratic-default`，不触碰课程级覆盖）
- 落库口径：`PromptTemplate.welcomeMsg` 存 `zh-CN` 供后台展示；学员端 welcome 按 `locale` 读取文件对应语言
- 欢迎语口径：课程已在进入 AI Tutor 前选定，默认文案不再提示“请选择一个课程”
- **运行时兜底（2026-10-26）**：应用启动**不写库**；库中缺少某模式默认行时，`GET /api/ai/prompts` 与对话提示词解析直接回退上述文件默认值（`src/ai/prompts/`），因此空库 / 云端未执行 `prompts:sync` 时后台不再出现空白 Prompt。`npm run prompts:sync` 仍保留为“主动把文件内容写入数据库”的手段。

---

## 3. 模块 A：Knowledge System（知识库管理）

### 3.1 功能概述

Knowledge System 是系统的主界面，采用「顶部整宽 Tab 栏 + 下方左右两栏」布局：

- **顶部（整宽 Tab 栏）**："Knowledge Pages"（编辑器，含左侧 TOC）与 "Releases"（版本发布，2026-10-19 由 "Publish" 更名）两个 Tab，横跨下方整行、位于课程树列（含同步目标）**上方**
- **下方左侧**：课程目录树（Course → Page → Heading），搜索框，Sync 按钮（**仅 "Knowledge Pages" Tab 显示**；"Releases" Tab 下隐藏整个课程树栏，仅保留最左侧模块导航列 Knowledge/AI Tutor）
- **下方右侧**：当前 Tab 对应的内容（编辑器 / 版本发布）

> **2026-10-19 布局改拍**（对齐 Figma 帧 `1.1 Page Editor` 节点 665:543）：原 Tab 页签位于右侧内容列内、与左侧课程树列并排且略低于「同步目标」；现提升为**跨「课程树列 + 内容区」的整宽 Tab 栏**，置于同步目标上方。Tab 样式对齐 Figma：激活态主色 `#145CFF`、字号 16px/字重 600、底部 2px 激活下划线 + 整条底边线；非激活态 `#000000`。

> **2026-10-19 Releases Tab 调整**（用户裁决）：Tab 2 名称 `Publish` → **`Releases`**；列表上方新增标题行 `Knowledge Releases`；列 `Current Version` → `Latest Release`；Action 按钮 `Publish` → `Create Release`；`Releases` Tab 下隐藏左侧课程树栏（同步目标 / 课程树 / Sync 按钮），仅保留最左侧模块导航列。

> **2026-10-19 内容面板样式统一**（用户裁决「完全按 Figma」，覆盖 Knowledge Pages / Knowledge Releases / AI Tutor 三区）：所有页面**主内容区统一为白色内容面板**——填充 `#FFFFFF`、圆角 **12px**（`radius.lg`）、**无边框**、阴影 `shadow.card`（`0 1px 2px -1px rgba(0,0,0,.1), 0 1px 3px rgba(0,0,0,.1)`），置于页面底色 `#F8FAFC` 之上；**子内容块**（文本框/表格/公式区/下拉）圆角统一 **8px**（`radius.md`）；**输入类控件**（输入框/文本域/下拉）描边统一 `1px #E2E8F0`、底色 `#FAFBFC`（经主题 `components.Input/Select` 注入，token `color.inputBorder`/`color.inputBg`）。实现：AntD `Card` 封装层默认改为无边框 + 卡片阴影（圆角由主题 `borderRadiusLG=12` 提供），非 Card 区域（编辑器 / Releases）使用新增 `ui/Panel` 封装，输入类规格经 ConfigProvider `components` 注入；**不改动任何页面内容与布局结构**。
> **2026-10-19 左侧课程树列卡片化**（用户追加）：左侧课程树列（同步目标 / 课程树 / Sync 按钮）同样卡片化——`MainLayout` 的 `Sider` 去掉右边框、底色改为页面底色 `#F8FAFC` 并加内边距 `spacing.lg`，`Sidebar` 根节点改为 `ui/Panel`，使该列在灰底上**悬浮为白色圆角卡片**，与右侧内容面板**对称统一**（三段式骨架与页面底色均不变）。

> **2026-10-16 扁平化改拍**：原三级 Course→Lesson→Page 简化为两级 Course→Page。
> Lesson（文件夹）层删除：原 Lesson 标题变为 Page.title（md 文件标题），原 Lesson 下属各 Page 合并为该 Page 的 contentMd，各原 Page 标题作为 H1 section。
> 树结构扩展为 Course → Page → Heading（H1-H6）三级，Heading 级作为目录（TOC），点击可定位编辑器。
> **2026-10-19 层级扩展改拍**：Heading/TOC/标签支持范围由 H1/H2/H3 扩展至 **H1-H6**（BlockNote heading schema 原生支持 6 级，块编辑器右键插入菜单同步放开 H4-H6；sectionTags 迁移与 AI 上下文分段正则由 `#{1,3}` 放宽为 `#{1,6}`）。
> **2026-10-29 补注**：BlockNote 已整体移除（§3.3.2 改拍），H1-H6 由 Markdown `#{1,6}` 语法直接书写；TOC 解析与 `#{1,6}` 正则不变。

> **Phase 4 排版对齐注记（2026-10-14，按用户设计稿）**：整体为「顶部 Header + 模块导航列 + 课程树列 + 内容区」四段——Header 白底，左侧 logo+产品名、右侧通知铃铛与当前用户（演示身份静态占位）；模块导航列含 **Knowledge / AI Tutor** 两个入口（当前模块高亮）；树列顶部搜索框、底部 Sync 按钮；预设标签配色：Core Knowledge 蓝 / Teaching Guidance 绿 / Misconception 橙 / Assessment 紫。

> **2026-10-19 模块导航列可收起**（用户裁决，完全收起隐藏；形态更新为**半圆括号式贴边把手**）：最左侧模块导航列（Knowledge / AI Tutor）新增收起/展开按钮——按钮为**半圆括号式贴边把手**（外侧整边圆弧、内侧平直，约 22×48），紧贴该列**右边缘垂直居中**（不跨边界）；点击后整列向左滑出隐藏（宽 160 → 0，带 0.2s 过渡），把手随停靠到最左边缘作为展开入口；方向符号用文本 **❮ / ❯**（fontSize 16 / fontWeight 700，加粗放大，随状态切换）。收起状态由 `MainLayout` 本地 state 维护，不改动 `ModuleNav` 组件本身。

> **2026-10-20 模块导航列白底铺满 + AI Tutor 布局调整**（用户裁决，对齐 Figma 图 1/图 2）：
> ① **模块导航列整列白底**：最左侧模块导航列（Knowledge / AI Tutor）背景统一为白色 `#FFFFFF` 并**铺满至该列底部**（此前 `<nav>` 仅按内容高度渲染，下方露出布局灰底 `#F8FAFC`）；实现为 `ModuleNav` 根节点与 `MainLayout` 导航列容器高度补 100%。
> ② **AI Tutor 顶部栏**：**展示方式与 Knowledge 顶部 Tab 栏（Knowledge Pages / Releases）保持一致**——全宽白色栏、高 63px、内边距 `0 24px`、底部 1px 分隔线；标题文字为模块名 **「AI Tutor」**（主色 `#145CFF`、字号 16px、字重 600、底部 2px 下划线，宽度 = 文字宽度）。经 `MainLayout` 的 `topBar` 槽位注入，位于导航列右侧、内容区上方。（原右侧静态 "Testing" 徽章于 **2026-10-20 按用户裁决移除**，Testing/Live 徽章改挂对话头部 versionTag 右侧，见 §4.3.1）
> ③ **Change Course 下拉移入配置面板**：由 AI Tutor 顶部栏移入**左侧配置面板卡片标题行右侧**，与 Course 名同一行。
> ④ **配置面板底部操作栏**：**脱离配置卡片**，改为卡片**下方**独立区块（卡片下边界上移至 LLM Model 功能区下方、不再包裹操作栏）；操作栏纵向位置不变（仍在左列底部）；去掉顶部分隔线，`Reset` 为**蓝色下划线文字链接**（左），`Unsaved changes` + `Save Configuration` 靠右。
> ⑤ **顶部栏标题与配置卡标题对调**（2026-10-20 追加）：顶部栏标题由「当前 Course 名」改为**模块名「AI Tutor」**；配置面板卡片标题行左侧由「AI Tutor 配置」改为**当前 Course 名**（Online 开关仍紧贴其右侧）。

### 3.2 左侧边栏（Sidebar）

#### 3.2.1 树形导航组件（2026-10-16 扁平化 + TOC）

- 实现三级嵌套树形组件：Course（一级）→ Page（二级，原 Lesson）→ Heading（三级，contentMd 中的 H1-H6，2026-10-19 扩展）
- **树按同步目标过滤**：树中只显示当前同步目标对应的本地课程；目标尚未同步时显示空态提示
- Course 节点**默认始终展开、不可折叠**，不显示展开箭头（2026-10-19 改）
- Page 节点点击→打开编辑器；点击行尾 chevron→展开其下 Heading 目录（TOC）
- Heading 节点（H1-H6，2026-10-19 扩展）点击→编辑器滚动定位到对应块（TOC 功能，2026-10-16 新增）
- 节点图标行内渲染；层级缩进收紧为 16px
- 支持搜索框，**匹配 Page 标题 + 全部 Heading（H1-H6）**（2026-10-19 改：原仅按标题过滤，且无结果时整棵树空白）。匹配范围**仅标题与 heading，不含正文**；命中规则：**标题命中→显示该页全部 Heading；仅 Heading 命中→只显示匹配的 Heading**；命中分支自动展开；点击命中的 Heading 直接定位（跨文件自动切换并滚动）；**无匹配结果时树区域显示「无匹配结果」空态提示**；搜索过滤时禁用拖拽排序
- **Course 节点悬停菜单**：新建页面、**上传文档建页**（见 §3.2.3）、删除课程（2026-10-19 改：上传入口从 Page 移至 Course）
- **Page 节点悬停菜单**：删除页面（2026-10-19 改：移除新建页面 / 上传文档建页）
- **Page 节点支持拖拽排序（2026-10-19 新增）**：鼠标悬停时行左侧显示拖拽把手（⣿），按住把手拖动即可调整 Page 在**同一 Course 内**的先后顺序；拖拽结束立即经 §5.1.2「批量排序接口」持久化 `sortOrder`；排序对全部 Page 生效（含外部同步页；再次执行同步结构可能被外部源覆盖）

#### 3.2.2 Sync 同步（外部源接管模型）

> **设计改拍（2026-10-14）**：原「全量强制覆盖」语义改为**非破坏性外部源接管模型**。外部源是课程主数据（master），本地在同步结果上做修改；再次同步**绝不覆盖或丢失本地内容**，过期内容以「灰度失效」标记交用户处置。
>
> **2026-10-16 扁平化改拍**：外部源仍为 Course→Lesson→Page 三级，本地为 Course→Page 两级。同步时将外部一个 Lesson 映射为本地一个 Page（contentMd = `# {Lesson.title}` + 各外部 Page 以 `# {Page.title}` 为 H1 拼接）。
>
> **2026-10-22 改拍（Portal 对接，仅标题同步）**：外部源从 Mock fixture 切换为 LearningGuidePortal 已发布课程目录（`GET /api/integration/catalogue`，服务间 `X-API-Key`）。本期**只同步课程标题与 lesson（Page）标题，不读写课程正文**；本地已有 `contentMd` 保持不变。课程匹配键 `Course.externalId = Portal course.slug`，页面匹配键 `Page.externalId = Portal lesson.id`（同日新增字段）。
>
> **2026-10-26 改拍（课程 ID 内置映射表）**：课程主数据后续归 BackOffice，KS 只需按 **courseID** 建立对应关系，因此**取消运行时向 Portal 拉取课程目录**（删除 `portal-source.service.ts` 与 `PORTAL_API_BASE_URL` / `PORTAL_API_TOKEN`）。同步数据源改由 KS 内置映射表 `server/src/sync/course-registry.ts` 提供：`externalId` 即 courseID，`title` 供建课与标题同步，当前无 lesson 结构化数据（`lessons` 恒为空）。**同步目的与算法完全不变**（仍为课程标题 + 课时标题同步，正文不动）。后续 BackOffice 提供课程接口时，只替换映射表数据源，`SyncService` 无需改动。
>
> 选择器口径：`GET /api/sync/external-courses` 返回「映射表课程 ∪ 本地带 `externalId` 的课程」，映射表外的本地课程仍可选中，避免侧栏丢失入口；对映射表外课程执行同步返回 `unchanged: true`（无可同步项）。

**同步目标选取**：Sidebar 顶部为**课程选择器**（下拉列出映射表课程，带状态）。**选中即切换、无锁定机制**：切换目标前自动 `flushSave` 落盘当前草稿，树与编辑器随之切到新目标课程，并**自动选中该课程上次编辑的页面**。未选中时同步按钮禁用。原「新建课程」入口**彻底移除**——课程身份由映射表的 courseID 决定。

**按钮**：

| 按钮 | 接口 | 行为 |
|------|------|------|
| 同步课程标题 | POST /api/sync/structure `{ externalId }` | 同步课程标题 + 课时标题（Page.title），不写入/覆盖正文 |

> `POST /api/sync/all` 保留路由但返回 400 `CONTENT_SYNC_DISABLED`；2026-10-22 起正文同步禁用，只允许标题同步。

**同步算法（按 externalId 匹配，标题兜底）**：

| 情形 | 行为 |
|------|------|
| 课程在本地不存在 | 新建 Course（title = 映射表 title，externalId = courseID） |
| 课程已存在 | 仅当标题不同时更新 Course.title |
| Page 按 `Page.externalId` 命中 | 仅当标题不同时更新 Page.title，正文完全不动 |
| Page 未命中但标题相同 | 回填 `Page.externalId`，并按需更新标题 |
| 本地无该 lesson | 新增空 Page（contentMd = ''，sortOrder 按映射表顺序） |
| 映射表无该 lesson | 本期不标记 STALE，避免误伤本地正文；后续内容同步阶段再处理 |
| 课程不在映射表但本地存在 | 视为本地独有课程：返回 `unchanged: true`，不建课不报错 |

**STALE（灰度失效）节点**：外部内容阶段保留原有语义；本期标题同步不产生新的 STALE 节点。

**响应**：`{ created, courseCreated, updated, staleMarked, unchanged }` 变更摘要（`created` = 新建 Page 数，`courseCreated` = 新建 Course 数；2026-10-26 新增 `courseCreated`，避免首次导入无 lesson 的课程时误报「无变更」）。

> **数据源实现**：`server/src/sync/course-registry.ts`（内置 courseID → 标题映射表）+ `server/src/sync/catalogue-source.service.ts`（数据源服务）。**不再需要任何 Portal 目录接口配置**；e2e 通过 `overrideProvider(CatalogueSourceService)` 注入带 lesson 结构的假数据源，继续覆盖标题同步与课时建页算法。

#### 3.2.3 上传文档建页（2026-10-15 实现落地；同日按用户设计稿改为两步弹窗「Upload and Parse」）

- **入口**：树中 Page 节点悬停菜单「上传文档建页」→ 打开弹窗（不再直接调系统文件选择器）
- **弹窗两步**（按用户设计稿；2026-11-05 增加单文件 UTF-8 `.tex`）：
  1. **选择文件**：虚线拖拽区（Drag and drop file, or Browse）+ 文件 chip；前端预校验（扩展名白名单 + ≤15MB，§10.1）；文案按实际白名单显示（设计稿中 epub/ppt 不支持；xls/doc 已于 2026-10-19 扩充，tex 于 2026-11-05 扩充）；Next 进入解析
  2. **转换预览**：`POST /api/files/convert`（仅 multipart `file`）→ 后端二次校验 → 常规格式由 markitdown-ts **本地**转换，`.tex` 使用保守转换分支，保留 `$...$`/`$$...$$` 公式，转换章节、段落、列表、强调和链接；纯排版间距命令忽略，未知命令及外部文件/图片引用保留为可见原文供用户检查 → 弹窗内预览返回的 Markdown 内容；**Import** 才真正建页：复用 `POST /api/courses/:courseId/pages`（§5.1.2）以 `{ title, contentMd: markdown }` 新建 Page（标题=文件名去扩展名，`syncState=SYNCED`）→ 前端刷新树并自动选中进编辑器
- **失败**：格式不支持/超限/转换失败/结果为空均 400（统一响应格式），弹窗内提示；Cancel 或关闭弹窗则什么都不落（转换阶段不建页、不落盘，内存 Buffer 直转）
- 音视频文件**不在本轮范围**（2026-10-15 拍板，随 §12 事项 #4 真实外部源接入一并设计）

### 3.3 右侧内容区 - Tab 1: Knowledge Pages（编辑器）

#### 3.3.1 页面布局

- 顶部显示当前选中 Page 的标题，**默认展示态 + 铅笔就地编辑（2026-10-19 改）**（对齐 Figma `1.1 Page Editor` 665:543）：
  - **展示态**：大标题文本（约 30px / 字重 700 / 黑色）+ 右侧常显铅笔按钮（16×16 图标的 20×20 容器）；标题下方一条分隔线
  - **编辑态**：点击铅笔 → 就地切换为输入框（自动聚焦）；`Enter` / 失焦保存，`Esc` 取消（回滚到进入编辑前的标题）
  - 原「常驻可编辑填充输入框」形态废弃
- 标题区右侧保留保存状态提示（页面级 Tags 已移除，见 §3.3.3）
- 主体区域为 Markdown 编辑器

#### 3.3.2 Markdown 编辑器要求（2026-10-29 改拍：CodeMirror 6 源码编辑器 + 预览）

> **选型改拍（2026-10-15，用户裁决）**：原 `@uiw/react-md-editor` 全文 Markdown 编辑 + live 预览，不符合「逐块编辑、右键插入、无顶栏工具栏」的诉求。改用 **BlockNote**（`@blocknote/react`）实现 Notion/Jupyter 式块编辑器。
>
> **选型改拍（2026-10-29，用户裁决，覆盖 2026-10-15 的 BlockNote 拍板）**：BlockNote 块编辑器在大文档（约 300 block / 35KB）下「选中文字即卡死」，实测关闭全部浮动 UI 后无改善，判定为**结构性成本**（整页单一 ProseMirror contenteditable、无视口虚拟化、文档级选区 + 整篇 blocks↔md 序列化）。改为 **CodeMirror 6 纯 Markdown 源码编辑器 + 预览按钮**：
>
> - 编辑器内核：`@codemirror/state|view|commands|language|lang-markdown|search`（原生视口虚拟化，选区/布局成本与文档大小无关；跨块选中、撤销、查找均为免费能力）
> - `contentMd` 直接就是编辑器内容 → **不再存在 blocks ↔ markdown 的整篇序列化**（原 60~250ms 长任务消失）
> - 标题栏最右侧新增「预览 / 编辑」切换：预览用与 Portal/AI Tutor 相同的 `remark-math + rehype-katex` 渲染
> - 保存策略改为：**编辑期间每 5 分钟自动保存 + 离开编辑页/切页/切课程立即保存**（`flushSave` 返回 boolean，失败阻断切换并提示重试）；另有 `pagehide/visibilitychange` 写入 localStorage 的草稿兜底
> - **已下线**（原第 2/3/4 条的块级交互）：侧边 ⋮ 拖拽手柄、块级右键插入菜单、选中浮动格式工具条、块拖拽重排；Markdown 语法由作者直接书写
> - §3.3.3 的 section tags 编辑入口随之暂时下线（数据 `Page.sectionTags` 保留不变，待用户裁决后续入口）

**核心不变量（必须守住）**：

- `Page.contentMd` 是**唯一存储格式**，且现在**直接就是编辑器内容**（无 blocks 中间态，因此不存在「块 ↔ markdown」往返与整篇序列化）
- **KaTeX 公式**：源码里写 `$…$`（行内）/ `$$…$$`（块级）；预览用 `remark-math + rehype-katex` 渲染（与 Portal、AI Tutor 同一渲染器）
- **源码模式为唯一模式**（2026-10-29）：编辑器即 Markdown 源码，右侧「预览」按钮切换到只读渲染，不提供块级视图

**交互模型**（2026-10-29）：

1. **源码编辑**：CodeMirror 6（`@codemirror/lang-markdown`）提供 Markdown 语法高亮、行号、查找（`Ctrl+F`）、撤销/重做；跨段落选中就是普通文本选区（成本与文档大小无关）
2. **Live Preview 装饰层（2026-10-29，M2+M3）**：在纯文本上就地渲染——Heading 放大字号并隐藏 `#`、粗体/斜体/删除线/行内代码加样式并隐藏标记、无序列表隐藏 `- ` 改用项目符号；**Widget 层渲染 `$…$` 行内公式、`$$…$$` 块级公式（KaTeX）、`![](url)` 图片、GFM 表格（HTML `<table>`）**；**光标或选区进入该范围时自动回退显示原始 Markdown**，保证可编辑。性能口径：行级/行内装饰按 `view.visibleRanges` 计算；**块级 Widget 由 StateField 全文档扫描**（CM6 禁止 ViewPlugin 提供 block 装饰），并在语法树异步推进后重建
3. **常驻格式工具条**：编辑器上方一行，选中时高亮当前格式；提供 H1/H2/H3、段落、粗体（`Ctrl+B`）、斜体（`Ctrl+I`）、删除线、行内代码、行内公式 `$…$`、链接、无序/有序列表、引用。**行内格式（粗体/斜体/删除线/行内代码/行内公式）为 toggle 语义**：选区已被同一对标记包裹时再次点击/按快捷键会剥离标记，否则包裹；空选区时光标夹在一对标记中间则剥离该对标记，否则插入标记对并将光标置于中间（2026-10-27 M5）
4. **右键插入菜单**：插入表格（GFM 模板）、公式块 `$$…$$`、行内公式、图片 `![](url)`、代码块、引用、分割线
5. **预览**：标题栏最右侧「预览 / 编辑」按钮；进预览前强制提交当前文本，保证所见内容与草稿一致；预览只读
6. **顶部仅保留**：页面标题（展示态 + 铅笔就地编辑，§3.3.1）、保存状态、预览开关
7. **TOC**：左侧目录仍由 `contentMd` 解析 H1-H6 生成（§3.2.1）；点击后编辑器按 Markdown 行号定位并滚动

**保存与兜底**：

| 时机 | 行为 |
|------|------|
| 编辑输入 | 300ms 防抖把编辑器文本提交进 `draft.contentMd`（无序列化成本） |
| 周期自动保存 | 编辑期间**每 5 分钟**一次（`flushSave`） |
| 离开编辑页 / 切页 / 切课程 | 立即 `flushSave`；**保存失败则阻断切换**并在标题栏提示「重试」，避免覆盖丢稿 |
| 浏览器刷新 / 关闭 / 切后台 | `pagehide` + `visibilitychange(hidden)` 把「未保存」草稿写入 `localStorage`（已保存内容不写）；下次打开该页若与服务端不同则询问「恢复 / 丢弃」 |
| 激活发布版本 | **丢弃草稿并清本地草稿**（服务端已用快照整体替换，禁止旧内容回写） |

> `flushSave` 语义：返回 `boolean`；以「请求快照」判定是否置 `saved`（请求期间又改了内容则保持 `dirty` 并重启自动保存）；同一时刻只有一个写入在飞（串行化，防乱序 PUT）。

**图片与表格**：

- 图片：Markdown 原生 `![alt](url)`（外链）；粘贴图片自动上传属于**待设计项**（需 `POST /api/files/image`，随 §12 #4 与音视频一起接入）
- 表格：Markdown GFM 表格语法，**支持就地可视化编辑**（见下方「表格就地编辑」）

**与现有链路的兼容性**：

- 上传建页（§3.2.3）产出的 `contentMd` 直接作为编辑器内容，无需任何转换
- AI 知识源（§4.3.3）读 `contentMd`，与编辑器无关
- 发布快照存 `contentMd`，激活后重新加载同一字符串

**依赖**：`@codemirror/state`、`@codemirror/view`、`@codemirror/commands`、`@codemirror/language`、`@codemirror/lang-markdown`、`@codemirror/search`；`@uiw/react-md-editor` + `remark-math` + `rehype-katex` + `katex` 供预览与 AI Tutor 渲染使用。

**历史选型（已废弃，2026-10-15 → 2026-10-29）**：曾使用 BlockNote（`@blocknote/react|core|mantine|math-block@0.56`）实现 Notion/Jupyter 式块编辑器（块左侧 ⋮ 菜单、右键插入、选中浮窗、拖拽重排、`tryParseMarkdownToBlocks` + `blocksToMarkdownLossy` 往返、块变更后 500ms 防抖）。废弃原因：大文档（约 300 block / 35KB）下选中文字即卡顿且浏览器无响应；关闭全部浮动 UI 后无改善，判定为结构性成本（整页单一 ProseMirror contenteditable、无视口虚拟化、文档级选区）。相关依赖已从 `package.json` 移除，源码已删除。

**已知限制（2026-10-29）**：

1. **多客户端/多标签冲突无版本比较**：本地草稿恢复只比较 `contentMd` / `title` 与当前服务端内容，不判断「谁更新」。彻底解决需 `PageNode.updatedAt` 或乐观锁（后续排期项）。
2. **本地草稿 key 无员工维度、无 TTL**：key 为 `kg.draft.<pageId>`，共享工作站上换员工登录同一浏览器时可能看到他人的未保存草稿；localStorage 容量无自动清理策略。
3. **切 Tab 在飞保存与「激活版本」的极窄竞态**：若切到 Releases Tab 时那次保存请求尚未返回，而激活恰在此后完成，理论上旧内容可能晚于激活落库（需在一次请求延迟内完成「打开历史→选版本→确认」才可能触发）。
4. **切页重试的最坏等待**：保存未收敛时最多 3 次有界重试（每次 120ms 间隔 + 可能 1 次 PUT/GET），慢网下点树到页面切换可能延迟 1~2 秒，且当前无 loading 指示。
5. **预览↔编辑切换会重建编辑器实例**：撤销历史在预览往返时清空（与切页丢弃历史同源）；如需保留需改用 Compartment 方案。
6. **Live Preview 覆盖范围（2026-10-29 M2+M3）**：Heading / 粗体 / 斜体 / 删除线 / 行内代码 / 无序列表 / `$…$` 行内公式 / `$$…$$` 块级公式 / `![](url)` 图片 / GFM 表格。实现分两层：**行级/行内**由 ViewPlugin 按 `view.visibleRanges` 计算；**块级 Widget（块公式、表格、整行图片）由 StateField 提供**（CM6 禁止 ViewPlugin 提供 block 装饰与跨行 replace），因此块级是全文档扫描 + 语法树推进后重建。编辑器语言使用 **GFM**（`markdown({ base: markdownLanguage })`）。
7. **块级解析的边界**：多行 `$$` 公式闭合最多向后 500 行（超出保留源码）；`$$$$` / `$$ $$` 等畸形写法保留源码；GFM 表格仅渲染「首行以 `|` 开头」的独立表格（无外框管道、引用块内表格保留源码）；**表格单元格在预览态渲染行内 Markdown（`**粗体**` / `*斜体*` / `~~删除线~~` / `` `行内代码` `` / `$行内公式$` / 链接 / 图片）**，编辑态下单元格显示原始 Markdown 文本；块公式内部若含表格/图片，以块公式为准（避免两个 block 装饰重叠）。
8. **表格 Widget 支持就地编辑（2026-10-27 M4）**：预览态点击表格或右上角「✎ 编辑表格」按钮进入编辑态——所有单元格变为 contentEditable，工具条提供 `＋行` / `＋列` / `－行` / `－列` / `完成`；`Tab`/`Shift+Tab` 在单元格间跳转（末尾 Tab 自动加行），`Enter` 跳到下一行同列，`Esc` 取消。点「完成」或失焦时把整张表序列化回 GFM 并通过 `view.dispatch` 替换原范围写回 `contentMd`。实现上通过 `setEditingTable` StateEffect 锁定该表范围，锁定期间「选区接触 → 回退源码」规则对其失效；`markdownBlockWidgets` 与 `markdownLivePreview` 均改为工厂函数，由 `MarkdownSourceEditor` 注入 `getView`。块级公式与图片 Widget 仍为只读渲染（点进范围回退源码）。
9. **右键在既有表格行内插入新表格会并表**：GFM 中相邻 `|` 行属于同一张表，当前插入只补单个换行，会把新表并入旧表（内容不丢，可 `Ctrl+Z`）。已知限制，下一轮改为补空行分隔。
10. **图片外链依赖网络与跨域**：`![](url)` 若 URL 失效或站点禁止外链，Widget 只显示破图图标；`data:` 占位串（如历史数据中的 `data:image/png;base64...`）会显示损坏图片，需要作者自行清理。

#### 3.3.3 Tags 管理（2026-10-16 重构：移除页面级 tags，仅保留 section tags + 全局 Tag 词库方案 B）

> **2026-10-29 状态变更**：随着编辑器改为 CM6 源码模式（§3.3.2 改拍），标题标签浮层（每个 H1-H6 下方 TagManager）**暂时下线**。`Page.sectionTags` 数据结构与保存链路不变（仍随 `contentMd` 一起保存），但当前版本**没有编辑入口**。后续入口方案（预览态打标 / 侧栏打标 / 彻底下线）待用户裁决后补文档。

- **页面级 tags 已移除**：编辑器顶部不再显示页面级 TagManager，`Page.tags` 字段删除。
- **section tags**（`Page.sectionTags`，Json 映射 `{ "h{n}-slug": ["tag1"] }`）：
  - ~~每个 H1-H6 标题下方显示一个轻量 TagManager~~（**2026-10-29 起无编辑入口**，见上方状态变更；数据结构与保存链路保留）
  - key = `h{层级}-{slug}`，如 `h1-overview`、`h2-subsection`（层级前缀避免同名冲突）
  - slug = heading 文本小写、空格转 `-`、去特殊字符
  - ~~修改时实时更新 `sectionTags`，随 contentMd 一起保存~~（**2026-10-29 起无编辑入口**；保存链路仍原样回传该字段）
  - 用途：AI 投喂时为对应内容段落标注语义标签（如「核心概念」「易错点」），帮助 AI 精准引用
- **全局 Tag 词库（方案 B 轻量版）**：
  - 独立 `Tag` 表（name 唯一、color），初始内置 4 个预设 tag（Core Knowledge=蓝、Teaching Guidance=绿、Misconception=橙、Assessment=紫）
  - 用户输入 tag 时：输入框带 AutoComplete 联想已有 tag；命中词库则用其颜色
  - 输入未命中的新 tag → 自动分配颜色（按 name 哈希到预设色板）并**写入 Tag 词库**，供后续选择
  - 颜色自动分配：对 tag name 做哈希取模到色板（蓝/绿/橙/紫/红/青/金/粉），同名 tag 颜色稳定
  - 第一版不做独立 Tag 管理界面，靠「输入即沉淀」自动维护词库；删 tag/改色留后续

### 3.4 右侧内容区 - Tab 2: Releases（版本发布）

#### 3.4.1 发布列表

列表上方标题行显示 `Knowledge Releases`（2026-10-19 新增）。表格展示所有 Course 的发布状态，列包括：

| 列名 | 说明 |
|------|------|
| Course Name | 课程名称 |
| Revision Notes | **最新发布快照**的备注（2026-10-20 随「纯快照」改拍：原「激活版本备注」；若无则显示 "No revision notes provided"） |
| Latest Release | **最新发布的快照版本号**（`createdAt` 最新者），格式 `CourseName_YYYYMMDDHHmm`，可点击进入历史（2026-10-19 由 "Current Version" 更名；2026-10-20 由「激活版本」改为「最新快照版本」，Live 状态在历史弹窗内展示） |
| Action | Create Release 按钮（2026-10-19 由 "Publish" 更名） |

#### 3.4.2 Latest Release 交互

> **设计改拍（2026-10-15，用户裁决）**：原「只读查看、无回滚」改为**激活版本模型**——历史版本可浏览、可切换为激活版本。
> **设计改拍（2026-10-20，用户裁决）**：Create Release 改为**纯快照、不改 Live 指针**（§3.4.3）；历史弹窗新增删除 ×；Live 状态标识由「激活中」改为 **live**。
> **设计改拍（2026-10-20 二次，用户裁决）**：**「切换到此版本」语义收窄为「仅恢复快照到可编辑草稿」**——**不再改动 `Course.currentReleaseId`（Live 指针）**；**Live 指针只能由 AI Tutor 板块的 §3.4.4「Set Live」变更**。按钮**对所有版本（含 Live）显示**；`Course.aiTestReleaseId` 对应标识由「测试所选」改文案为 **`testing`**。
> **设计改拍（2026-10-20 三次，用户裁决）**：**`editing` 标识下移到版本行**——移除 Modal 标题行的课程名与 `editing` 标签（标题仅「历史版本」）；`editing` 改为**紧贴版本名右侧**，标识**当前编辑版本**（`Course.editingReleaseId`）；**该版本行不显示「切换到此版本」按钮**（已处于编辑态，禁止再切换）。

- 点击版本号，弹出 Modal（标题「历史版本」）展示该 Course 的历史版本列表
- **Modal 标题**（2026-10-20 三次改拍）：仅显示「历史版本」；**移除**课程名与 `editing` 标签
- **`editing` 判定**（2026-10-20 三次改拍，`Course.editingReleaseId`）：**新建 Release 后落在该新版本**（§3.4.3）；**点击「切换到此版本」后落在被切换的版本**（本文步骤 3）。二者均写入 `Course.editingReleaseId`；`Set Live`（§3.4.4）不改变它；删除该版本时指针一并清空（§3.4.5）
- 每个已发布版本显示：版本号、发布时间、Revision Notes；状态标签（2026-10-20 三次改拍定序）：**`editing`**（该版本为 `Course.editingReleaseId`，**紧贴版本名右侧**）、**`live`**（该版本为 `Course.currentReleaseId`）、**`testing`**（该版本为 `Course.aiTestReleaseId`）
- **每个已发布版本行尾提供删除 ×**（2026-10-20 新增，§3.4.5）：点击后二次确认删除；**若该版本为 Live 版本，或为 AI Tutor 后台「测试所选 Release」（`Course.aiTestReleaseId`），则禁止删除、隐藏或置灰该 ×**，后端同样返回 409 保护
- **「切换到此版本」按钮**（2026-10-20 二次/三次改拍）：**所有版本（含 Live）显示**，**但 `editing` 版本不显示**：
  1. 二次确认弹窗：明确提示「切换将以该版本内容**覆盖当前可编辑草稿**（含未发布的修改）」，**不再提 AI Tutor**；用户确认后才执行
  2. 前端调用 `POST /api/courses/:id/activate-release`，传入 `{ releaseId }`
  3. 后端在**单事务**内：校验 releaseId 属于该 Course → 用该 Release 的 snapshotData **重建 Page 草稿**（快照中仅含发布时刻的 SYNCED 节点，重建节点一律 `syncState=SYNCED`，后续 Sync 按标题匹配不受影响）→ **置 `Course.editingReleaseId` = 该 Release**；**不更新 `Course.currentReleaseId`**
  4. 前端刷新课程树与编辑器（当前草稿指向的页面可能已不存在，需清空选中态）

#### 3.4.3 Create Release 流程

> **设计改拍（2026-10-15）**：Create Release 语义 = 创建快照 + **激活**（发布即激活）。
> **设计改拍（2026-10-20，用户裁决）**：Create Release 语义改为 **纯快照**——**仅创建快照，不改动 `Course.currentReleaseId`（Live 指针）**，因此**不影响 AI Tutor 的上线版本**；也不改动 `Course.aiTestReleaseId`（后台测试所选 Release，需用户在 AI Tutor 头部手动选择）。快照仅收录 `syncState=SYNCED` 的节点（延续 §3.2.2「STALE 不作 AI 知识库」）。
> **设计改拍（2026-10-20 三次，用户裁决）**：新建 Release 后，**置 `Course.editingReleaseId` = 该新 Release**（`editing` 标识落在新版本，§3.4.2）。

1. 用户点击某个 Course 的 "Create Release" 按钮
2. 弹出 Modal，要求填写 Revision Notes（必填）
3. 确认后，前端调用 `POST /api/courses/:id/release` 接口，传入 revisionNotes
4. 后端在**单事务**内执行以下逻辑：
   - 读取当前 Course 下所有 Pages（**过滤 STALE 节点**）
   - 生成版本号：`CourseTitle_YYYYMMDDHHmm`
   - 将所有当前内容聚合为 JSON 快照：`{ pages: [{ id, title, contentMd, sectionTags }] }`
   - 写入 Release 表
   - **置 `Course.editingReleaseId` = 该新 Release**（当前编辑版本指针；`editing` 标识来源，§3.4.2）
   - **不更新 `Course.currentReleaseId`**（纯快照；**Live 指针只能由 AI Tutor 板块的 §3.4.4「Set Live」变更**）
5. 前端刷新 Releases 列表

> **重要**：Create Release 动作是发布整个 Course 下所有页面的快照，不是单个 Page。
> **2026-10-16 扁平化**：快照结构从 `{ lessons: [...] }` 改为 `{ pages: [...] }`，activate 时直接重建 Page（不再经过 Lesson）。
> **2026-10-20 纯快照改拍影响**：首次发布后 `currentReleaseId` 仍为空，用户侧 AI Tutor 无上线版本；后台测试需在 AI Tutor 头部 Release 选择器手动选择该版本（会写入 `Course.aiTestReleaseId`）。

#### 3.4.4 Set Live（设为上线版本，轻量；2026-10-20 新增）

> **设计改拍（2026-10-20，用户裁决）**：**`Course.currentReleaseId`（Live 指针）只能由 AI Tutor 板块的 Set Live 变更**——Knowledge 板块不再提供任何改变 Live 的入口。
> - §3.4.2「切换到此版本」（`activate-release`）：**仅恢复快照到可编辑草稿**（覆盖式，有破坏性，需二次确认），**不动 Live 指针**。
> - §3.4.4「Set Live」：**轻量**，**仅切换上线指针**（`Course.currentReleaseId`），**不重建、不覆盖当前可编辑草稿**。

1. 用户在 AI Tutor 对话头部点击 **Set Live**（针对「当前测试所选 Release」，§4.3.1）
2. 前端调用 `POST /api/courses/:id/set-live`，传入 `{ releaseId }`
3. 后端在单事务内：校验 releaseId 属于该 Course → 更新 `Course.currentReleaseId` = 该 Release → 返回 `{ id, versionTag }`
4. **不触碰 Page 草稿**（与 `activate-release` 的关键区别）
5. 前端对话头部左徽章由 `Testing` 切为 `Live`

#### 3.4.5 删除版本（Delete Release；2026-10-20 新增）

> **设计改拍（2026-10-20，用户裁决）**：Releases 历史版本支持删除。**双保护**——Live 版本与 AI Tutor 后台「测试所选 Release」均不可删除。

1. 用户在历史弹窗点击某版本的删除 ×
2. 二次确认弹窗：提示「将永久删除该版本快照，不可撤销」，用户确认后才执行
3. 前端调用 `DELETE /api/releases/:releaseId`
4. 后端校验：
   - Release 不存在 → 404
   - Release 为所属 Course 的 Live 版本（`Course.currentReleaseId`）→ 409 `CONFLICT`「上线版本不可删除」
   - Release 为所属 Course 的 AI Tutor 后台测试所选版本（`Course.aiTestReleaseId`）→ 409 `CONFLICT`「后台测试所选版本不可删除」
   - 其余 → 单事务内删除该 Release（其关联 `CourseAiConfig` 行经 `onDelete: Cascade` 一并删除）；**若被删除的版本恰为 `Course.editingReleaseId`，同事务将该指针清空（置 null）**
5. 前端刷新 Releases 列表（历史弹窗）

> **注**：删除仅移除该快照与对应 AI 配置，**不改动** `Course.currentReleaseId` / `Course.aiTestReleaseId` / Page 草稿（因双保护已排除这两类版本）。**当前编辑版本（`editingReleaseId`）不属于双保护，允许删除；删除后该指针清空**（§3.4.2 `editing` 标识随之消失）。

---

## 4. 模块 B：AI Tutor（AI 辅导）

### 4.1 功能概述

AI Tutor 是一个独立的功能板块，提供 AI 对话能力。其知识库来源于 Knowledge System 中选中的 Course。

页面布局（2026-10-15 改版对齐设计稿；2026-10-20 按 Figma 图 1/图 2 调整）：
- **顶部栏（全宽）**：**展示方式与 Knowledge 顶部 Tab 栏一致**——白色栏、高 63px、底部 1px 分隔线；标题为模块名 **「AI Tutor」**（主色 `#145CFF`、16px、字重 600、底部 2px 下划线，宽度=文字宽度）。（原右侧静态 "Testing" 徽章于 2026-10-20 按用户裁决**移除**；Testing/Live 徽章改挂在对话头部 versionTag 右侧，§4.3.1）
- **左侧（占 40%）**：配置面板卡片（System Prompt、Welcome Message、LLM Model）——卡片标题行由左到右为**当前 Course 名** →（紧贴）"Online" 文字 + Switch（§4.2.6）→ 最右 "Change Course" 下拉选择器（下拉面板最下侧固定「管理所有 online」链接）；**卡片的 Reset / Save 操作栏脱离卡片，位于卡片下方**（左列底部，纵向位置不变）
- **右侧（占 60%）**：测试对话窗口（头部左侧为**知识库 Release 选择器 + Set Live**、中间模式切换、右侧 New Chat、消息列表、输入框）

> **2026-10-20 左右分栏比例改拍**（用户裁决）：AI Tutor 页面左右两栏由固定宽度改为按比例分配——左「配置」列 **40%**（`flex: 0 0 40%`，固定占比、不收缩）、右「对话」列 **60%**（`flex: 1 1 0`，占满剩余）。
> **2026-10-20 顶部栏标题与配置卡标题对调**（用户裁决）：顶部栏标题显示模块名「AI Tutor」；配置面板卡片标题行左侧显示**当前 Course 名**（原「AI Tutor 配置」文案弃用）。

### 4.2 左侧配置面板

#### 4.2.1 System Prompt

- 文本域（Textarea，较大行数），支持编辑当前课程使用的 AI 人设
- 编辑后需点击 "Save" 才能持久化
- **按模式分开保存（2026-10-20 二次改拍，用户裁决）**：Lecture 与 Socratic 各自的 System Prompt **独立存一份**；切换模式时输入框载入该模式的自定义值（无则用该模式模板默认值）

#### 4.2.2 Welcome Message

- 文本域（Textarea），支持编辑欢迎语
- **按模式分开保存（2026-10-20 二次改拍）**：同 System Prompt，Lecture / Socratic 各自独立一份

#### 4.2.3 LLM Model 配置

- 下拉框，切换模型（数据源为 `AI_AVAILABLE_MODELS` env，逗号分隔）
- 后端需提供模型列表接口（`GET /api/ai/models`），支持扩展
- **默认模型**：取 `AI_AVAILABLE_MODELS` 列表第一个；当前为 `deepseek/deepseek-v4.1-flash`
- **按模式分开（2026-10-20 二次改拍）**：Lecture / Socratic 各自一个模型；切换模式时同步切换；该模式未设置时回退默认模型（`AI_AVAILABLE_MODELS[0]`）
- **用途**：所选模型即该（课程 × 模式）AI Tutor 对话使用的模型（含测试与学生端），保存后对该模式生效
- **API Key**：统一使用服务端全局 `OPENROUTER_API_KEY`，课程级 API Key 覆盖已下线（2026-10-15）；后端 `CourseAiConfig.apiKey` 字段及加密逻辑保留，仅前端不再暴露入口

#### 4.2.4 Reset 按钮

- 点击后，清空**当前所选模式**的自定义输入（只重置 Lecture / Socratic 中当前这一个）
- System Prompt / Welcome Message 恢复为**该模式**的默认 PromptTemplate（PromptTemplate 表 load isDefault=true 的记录；**2026-10-26：库中无该模式默认行时回退 `src/ai/prompts/` 文件默认值**）；LLM Model 回退默认模型
- 接口带 `mode`：`POST /api/ai/config/:courseId/reset`（body `{ mode }`；§5.2）

#### 4.2.5 Save 按钮

- 保存当前修改到 CourseAiConfig 表（**2026-10-20 改按 Release 维度**：保存到「当前测试所选 Release」对应的那份配置，见 §4.3.1/§3.4.4；**2026-10-20 二次改拍：再按模式**——只写**当前所选模式**那一份）
- 包括：`mode` + lectureModeId/socraticModeId + 该模式的三项值（System Prompt、Welcome Message、Model）+ 共享的 llmProvider 等
- 配置面板底部操作栏（**2026-10-20 脱离配置卡片，位于卡片下方、左列底部**）：无顶部分隔线；左侧为**蓝色下划线文字链接 "Reset"**；右侧依次为橙色 "Unsaved changes" 未保存提示与蓝色主按钮 "Save Configuration"
- **未保存改动提醒**：切换模式 / 切换课程 / 切换 Release 前，若存在未保存改动则弹二次确认（保存 / 取消；§4.3.6）

> **2026-10-20 配置按 Release 维度改拍**（用户裁决）：AI 配置（知识库 / system prompt / welcome message / LLM model）**随 Release 保存**——每个 Release 各有一份 `CourseAiConfig`（`@@unique([courseId, releaseId])`）；切换 Release 时，左侧面板加载该 Release 已保存的配置（system prompt / welcome message / LLM model 按该次 Save 的状态回显；无配置行时按 PromptTemplate 默认值）；Save Configuration 写入该 Release 的那份配置。新建 Release 不继承上一版本的配置（按模板默认起步）。

> **2026-10-20 二次改拍：AI 配置再按模式维度**（用户裁决，修复「保存后切换 Lecture/Socratic 不再更新」问题）：System Prompt / Welcome Message / LLM Model 三者**均按 Lecture / Socratic 分别保存**——切换模式时左侧面板载入**该模式**的已保存值（无自定义则模板默认值），Save Configuration 只写**当前模式**那一份；Reset 亦只重置当前模式。存量单份自定义值迁移时**同时回填到两个模式**（现状不失，用户可后续分开调整）。

#### 4.2.6 Online 开关与管理弹窗（2026-10-20 新增）

- **Online 开关**：位于配置卡片标题行 Course 名右侧紧贴处，开关**左侧**为文字 "Online"；语义为「**该课程**的 AI Tutor 是否对用户侧开放」（课程级开关，与 Release 无关；后台测试对话不受影响，仍可正常调试）。
  - **切换即时生效**：`PUT /api/ai/config/:courseId/online`（body `{ online: boolean }`），返回最新 `AiConfigView`；**无需点击 Save Configuration**。
  - **存储**：`Course.aiTutorOnline`（§2，默认 false；2026-10-20 由 `CourseAiConfig.online` 搬移而来，保持课程级语义）。
- **「管理所有 online」入口**：位于 "Change Course" 下拉面板**最下侧固定一行链接**；点击后关闭下拉并打开管理弹窗。
- **管理弹窗**：表格展示全部 AI Tutor（Course），列 = `AI Tutor 名称` / `Online 状态`；支持**按名称排序、按 Online 状态排序**（点列头切换升降序）；**右上角搜索框按名称过滤**。排序与过滤均在**前端本地**完成（数据源 `GET /api/ai/tutors`，数据量为课程量级）。每行提供开关，**点即改即存**（同上接口）；当改动的正是当前选中课程时，同步更新左侧卡片标题行的 Online 开关。
- **用户侧接口（2026-10-22 实现）**：`GET /api/user/ai-tutors` 返回所有已配置 `externalId` 的课程，每条含 `online`（课程开关）与 `available`（= online && 存在 `currentReleaseId`）。Portal 仅在 `available=true` 时展示「询问 AI 导师」入口；**接口不做缓存**，Online 开关切换后下一次请求立即生效。
- **学员端欢迎语（2026-10-22 新增，2026-10-23 支持 locale）**：`GET /api/user/ai-tutors/:externalId/welcome?locale=zh-CN|en-GB` 返回该课程在 `LECTURE` / `SOCRATIC` 两种模式下生效的 `{ lecture, socratic }` 欢迎语（课程自定义 > 课程绑定模板 > 文件默认值，只读 `currentReleaseId`）；仅返回 welcome 文本，不返回 System Prompt。课程不存在 / 未开放 / 无上线版本分别返回 404 / 403 / 409。

### 4.3 右侧对话面板

#### 4.3.1 对话头部

- 左侧：**知识库 Release 选择器**（2026-10-20 新增）——显示「当前测试所选 Release」的 versionTag（蓝色、可点击），其右侧为**动态徽章**（所选 Release ≠ 上线版本时显示 `Testing`；所选 Release = 上线版本时显示 `Live`，均为浅绿底绿字）；再右侧为 **Set Live** 主色按钮。
  - 点击 versionTag 展开下拉：按发布时间**倒序**列出该 Course 全部 Release，**上线版本行**显示绿色 `Live` 徽章、当前所选项高亮；点某行 = 切换 AI Tutor 测试所用 Release（**持久化到后端 `Course.aiTestReleaseId`**）。
  - **版本说明展示（2026-10-28 新增）**：每个下拉项为两行布局——第一行 versionTag + Live 徽章；第二行展示 `revisionNotes`（单行截断 + `…`，hover 弹出完整说明 Tooltip）。`revisionNotes` 为空时显示灰色占位「无版本说明 / No version notes」，而非留白导致视觉落差。
  - **滑动窗口（2026-10-28 新增）**：当 Release 数量 > **5** 时，下拉菜单启用垂直滚动（`max-height: 300px` + `overflow-y: auto`，约容纳 5 个双行项）；≤5 时不设高度限制，自然展开。阈值 5 固定为常量，不上调不调低。
  - **Set Live**：仅把 `Course.currentReleaseId` 指向所选 Release，**不重建/覆盖 Page 草稿**（§3.4.4）；成功后左徽章由 `Testing` 切为 `Live`。
  - 切换 Release 时若 AI 配置有未保存改动：**弹未保存改动提醒**（保存 / 取消；§4.3.6）。
  - **进入 AI Tutor 时刷新（2026-10-23 修复）**：模块切换不会清空 `aiStore`，因此每次进入 AI Tutor 都重新拉取当前课程的 `config` 与 Release 列表；在 Knowledge Pages 新建的 Release 会立即出现在版本下拉中。若配置面板存在未保存改动，只刷新列表与配置元数据，**不覆盖表单内容**。Create Release 仍只生成快照，Live 指针只由 Set Live 变更。
- 中间：Lecture / Socratic 模式切换（**胶囊型分段控件**，样式见下方注记）
- 右侧：+ New Chat 按钮（**主色实心主按钮**，样式见下方注记）

> **2026-10-20 对话头部控件样式调整**（用户裁决，按参考图）：
> - **模式切换**（§4.3.2）由 `Segmented` 默认灰底样式改为**胶囊型分段控件**——整体 1px 主色 `#1D6BFF` 描边 + 白底 + 全圆角（`999`）；**选中项实心主色底 + 白字 + 字重 600**，**未选中项白底 + 主色字 + 字重 600**。
> - **New Chat**（§4.3.3）由默认次级按钮改为**主色实心主按钮**（`type="primary"`：底色 `#1D6BFF`、圆角 8px、白色加粗文字）+ 前置 `+` 图标。

#### 4.3.2 模式切换

- Segmented 切换 `Lecture` 和 `Socratic` 模式
- **切换前若有未保存改动**：弹未保存改动提醒（保存 / 取消；§4.3.6）——保存则先写当前模式再切换，取消则丢弃改动后切换
- **关键逻辑**：切换模式时，左侧的 **System Prompt / Welcome Message / LLM Model 三者均自动更新为对应模式的值**（优先使用**该模式**的自定义配置，无自定义则使用该模式模板默认值；§4.2.1–§4.2.3）
  - **2026-10-20 二次改拍**：自定义配置本身已按模式分开存储，故切换模式时总能载入对应模式的独立值（修复此前「保存后切换模式不再更新」的问题）

#### 4.3.3 New Chat

- 清空右侧对话框的当前聊天记录（含浏览器 localStorage 中的上次会话）
- 显示 Welcome Message 作为 AI 的第一条消息

> **对话持久化拍板（2026-10-14，§12 事项 #6）**：对话记录**不落库**。"上一次聊天"经浏览器 localStorage 持久化（按 courseId+mode 隔离），短时间退出页面再回来可恢复；点击 New Chat 清空；当前无长期记忆需求。`AiChatSession` 表保留（后续调试/持久化启用用），MVP 不写入，`/api/ai/sessions` 系列接口不实现。
>
> **补充（2026-10-22，用户拍板）**：为支持对话质量测试，新增**文件级运行日志**（每次对话一行 JSON，落 `server/app-logs/ai-chat-*.log`），仅记录元数据与 80 字预览，**不保存完整会话、不提供会话查询接口**；与上述「不落库」决策不冲突，详见 §4.4.2 第 7 步。

#### 4.3.4 对话流程

1. 用户在底部输入框输入消息，点击发送
2. 前端调用 `POST /api/ai/chat-stream` 接口，传入：
   - courseId（当前选中的课程）
   - message（用户输入）
   - mode（当前模式：lecture 或 socratic）
3. 后端执行以下逻辑：
   - 知识库上下文来源（**2026-10-15 拍板改；2026-10-20 按 Release 维度更新**）：后台测试对话读取 **`Course.aiTestReleaseId` 指向的「测试所选 Release」**（为空时回退 `Course.currentReleaseId`）的 snapshotData 聚合课程资料，**不再读实时草稿**——创建 Release 后未再次发布的编辑不影响 AI；用户侧 AI Tutor 仍只读 `Course.currentReleaseId`（上线版本）。若课程从未发布（两个指针均为空），返回错误提示「该课程尚未发布知识库版本，请先在 Knowledge 模块 Releases 页创建版本」（2026-10-19 文案随 Tab 更名更新）
   - 组装 Prompt：`System Prompt + [CONTEXT: 课程资料] + 用户消息`
   - 调用 LLM API（流式）
   - 将流式响应转发给前端
   - 对话不落库（2026-10-14 拍板，见 §4.3.2）
4. 前端以流式（SSE 或 fetch stream）方式逐块渲染 AI 回复

#### 4.3.5 对话消息格式

每条消息包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| role | string | "user" 或 "ai" |
| content | string | 消息内容（Markdown 格式） |
| createdAt | string | ISO 8601 时间戳 |

#### 4.3.6 未保存改动提醒（Unsaved Changes Guard；2026-10-20 新增）

> **设计改拍（2026-10-20，用户裁决）**：左侧配置面板的 System Prompt / Welcome Message / LLM Model（含当前模式的改动）若有**未保存**内容，在执行**会丢弃这些改动**的操作前，必须弹**二次确认**，避免用户误丢编辑。

- **判定**：当前 `form`（System Prompt / Welcome Message / LLM Model）与 `initialForm`（上次载入/保存后的基线）不一致 → 视为「有未保存改动」（与操作栏 "Unsaved changes" 提示同口径，§4.2.5）。
- **触发场景**（本次范围）：`切换 Lecture/Socratic 模式`（§4.3.2）、`切换课程 Change Course`（§4.2.1）、`切换 Release 版本`（§4.3.1）。（New Chat 不触发。）
- **提醒方式**：弹窗，提示「当前配置有未保存改动」，两个按钮：
  - **保存**：先执行与 Save Configuration 完全一致的操作（`PUT /api/ai/config` 写当前模式，§4.2.5）；**保存成功后**再执行用户原本的操作；若保存失败（如未选 Release、后端校验错误）则**中止**原操作并提示错误。
  - **取消**：**不保存**，直接丢弃改动并执行用户原本的操作。

### 4.4 AI Gateway Proxy（后端安全核心）

#### 4.4.1 接口定义

**POST /api/ai/chat-stream**

请求体：

```json
{
  "courseId": "string",
  "message": "string",
  "mode": "LECTURE | SOCRATIC",
  "history": [{ "role": "user | assistant", "content": "string" }]
}
```

> `history` 为可选字段（2026-10-14 补充）：前端把 localStorage 会话的最近若干条随请求携带，后端仅取最近 10 条拼入多轮上下文，保证对话连续性（对话本身仍不落库）。

**POST /api/user/ai/chat-stream（2026-10-22 新增，Portal 学员端专用）**

请求体：

```json
{
  "externalCourseId": "portal-course-slug",
  "message": "string",
  "mode": "LECTURE | SOCRATIC",
  "locale": "en-GB | zh-CN",
  "history": [{ "role": "user | assistant", "content": "string" }]
}
```

> 与后台 `/api/ai/chat-stream` 完全隔离：`externalCourseId` 按 `Course.externalId` 解析；**必须** `aiTutorOnline=true`；知识库只读 `Course.currentReleaseId`，**禁止**使用 `aiTestReleaseId`；不接受客户端传入 `releaseId`、`systemPrompt`、`knowledgePack` 等字段。

响应：Stream（Server-Sent Events 格式，帧格式与后台接口一致：`{delta}` / `{done}` / `{error}`）

#### 4.4.2 核心处理逻辑

1. **参数校验**：验证 courseId、message、mode 必填
2. **加载配置**：根据 courseId + 测试所选 Release 获取对应的 CourseAiConfig（2026-10-20 按 Release 维度），解析 LLM 提供商和模型（apiKey 字段经 AES-256-GCM 解密后仅在内存中使用，环境变量 `AI_CONFIG_ENCRYPTION_KEY`，2026-10-14 拍板）
3. **加载知识库上下文**：读取 **`Course.aiTestReleaseId`（为空回退 `currentReleaseId`）** 指向 Release 的 `snapshotData.pages`，按 H1-H6 section 切分 contentMd，每段拼接对应 `sectionTags`（如有），聚合为带语义标注的课程资料
4. **组装 Prompt**：
   - 获取对应模式的 PromptTemplate（**2026-10-26 完整优先级：课程自定义 > 课程绑定模板 > 库内默认模板 > `src/ai/prompts/` 文件默认值**）
   - 拼接：`System Prompt` + `[CONTEXT_START]` + 课程资料 + `[CONTEXT_END]` + 用户消息
   - 2026-10-22 起不再追加固定苏格拉底指令：默认 Socratic 模板（MixSocratic v8）已包含完整教学规则，运行时仅按学员 `locale` 追加语言指令。
5. **代理转发**：经 Provider 适配器（策略模式，首批接入 OpenRouter，OpenAI 兼容接口，2026-10-14 §12 事项 #2 拍板）调用实际 API（流式）
6. **流式返回**：将 LLM 的流式 Chunk 以 SSE 格式转发给前端
7. **日志记录**：
   - **会话不落库**（2026-10-14 拍板，见 §4.3.2；AiChatSession 表保留不写入）
   - **运行日志落文件**（2026-10-22 用户拍板，用于对话质量测试）：每次 `streamChat` 结束后由 `AiChatLogger` 旁路追加一行 JSON 到 `server/app-logs/ai-chat-YYYY-MM-DD.log`（本地时区日期），不受会话不落库决策影响
     - 记录字段：`ts / courseId / releaseId / mode / provider / model / historyCount / latencyMs / status(ok|error|aborted) / error(≤300 字) / questionChars / answerChars / question(≤80 字) / answer(≤80 字)`
     - 安全约束：**绝不记录 apiKey / baseUrl / 完整 Prompt**；用户提问与模型回答均只保留前 80 字预览；写盘失败仅告警，不影响对话主流程
     - 演进预留：日志写入封装在 `AiChatLogger.write()` 单一入口，后续替换为结构化 JSON/DB/OTel 时 `AiChatService.streamChat()` 的 Prompt 组装与 Provider 调用代码不需改动

#### 4.4.3 错误处理

- API 调用失败时，返回错误信息给前端并显示
- 支持重试机制（建议最多重试 2 次）
- 简单限流：同一 courseId 每分钟最多 10 次请求

---

### 4.5 AI Tutor 母版迁移（2026-11-04）

用户确认以 `AITutor-main` 通用对话为基座，在现有 BackOffice 中实施。最新契约与实施阶段见 [母版迁移实施记录](AI_tutor/Motherbase_Refactor.md)，优先于本节较早的历史轮数和 localStorage 隔离说明。Release / Online / 四套 Prompt 的配置与发布语义保留；单次请求绑定有效配置，增量转发、取消与失败终态显式处理；后台会话按员工、课程、Release 隔离，模式共享历史。Lecture 最近六个完整成功轮次，Socratic 十轮。Assessment 保留独立配置，实际评分后置。

## 4A. 模块 C：HelpDesk 工单（Tickets v1，2026-10-28 新增）

> 依据：`lg-helpdesk/tickets-v1-spec.md` §1/§4/§5（Integration）/§7（2026-10-28 用户拍板：「每个工单就是一个小卡片在 Back Office 上 … 按原有 UI UX 风格 … TDD 锁住」）。v1 不做：飞书同步、前端埋点、AI 客服、SaaS。
> **待视觉验收**：Enquiries 三栏按 Figma 1324:2 实现；没有画板的部分（筛选弹层、之后的消息与内部备注、状态胶囊、回复框、日期分隔文字、空态、只读提示条、Common Questions Tab 与新增 / 编辑弹窗）沿用同一套颜色或 Knowledge / AI Tutor 的 antd 表格与弹窗，由用户手动验收。
> **2026-10-28 Figma 对齐（`lg-helpdesk/tickets-v1-figma-addendum.md`，与原方案冲突时以它为准）**：Figma 文件 `sxro3x6YXENJvjhGExmlQ7`，BackOffice Enquiries 画板 1324:2。卡片看板改为 Enquiries 三栏（§4A.3），新增 Common Questions 问答库（§4A.7）、Agent 推荐（§4A.8）与 Portal → Admin 集成鉴权（§4A.9）。工单分类改为四个 Enquiry Type：`technical_support` / `course_content` / `payments_subscriptions` / `other`。
> **Tickets v2（2026-10-28 20:40Z，`lg-helpdesk/tickets-v2-figma-addendum.md`，与上面冲突时以它为准）**：Common Questions（§4A.7）由双语 FAQs 取代，Enquiries 中栏改为学员时间线；见 §4A.10。§4A.7 与 §4A.8 中关于 `helpdesk_questions` 的内容只作历史记录。

### 4A.1 归属与数据流

- **Portal 是工单的唯一写入方**（工单 / 消息 / 附件 / 事件，状态机只在 Portal 服务端执行）。BackOffice 不建表、不直连 Portal 库。
- 数据流：浏览器 → BackOffice Server `/api/helpdesk/**`（员工会话 + 菜单权限）→ Portal 集成接口 `/api/integration/helpdesk/**`（服务间 `Authorization: Bearer PORTAL_HELPDESK_TOKEN`，RFC 6750）。浏览器从不直连 Portal。
- 写操作由 BackOffice Server 注入当前登录员工作为 `agent { id: employeeId, name: displayName }`；请求体里的 agent 字段一律忽略，员工无法冒充他人。
- 幂等：浏览器每次提交生成一个 `Idempotency-Key`（UUID），重试沿用同一个（回复框：正文与回复 / 内部备注都没变才沿用，任何一项变了就换新）；写操作的结果只作用于发出请求的那条咨询，员工已切到别的咨询时只同步左栏那一行；Server 原样转发给 Portal，未带时 Server 生成一个。Portal 只接受 UUID，Server 对非 UUID 的键直接 400 `INVALID_INPUT`。并发：写操作携带 `expectedSequence`，Portal 返回 409 `stale_ticket` 时页面重新加载工单并提示。
- 实现位置：`server/src/backoffice/modules/helpdesk/`
  - `portalHelpdeskClient.ts`：**唯一**的 Portal 客户端文件（URL、鉴权头、超时、problem+json 映射、字段名归一化都在这里，Portal 字段名有出入只改这一个文件）
  - `helpdeskService.ts`：Enquiries 筛选（状态 / 类型 / 标签 / 搜索）、待回复判定、可用操作、输入校验、员工身份注入
  - `questions/`：Common Questions 数据层（`questionContracts.ts`、`questionRepository.ts` 原生 SQL、`questionService.ts` 业务规则），§4A.7
  - `contracts.ts`：两端共用的类型与常量
  - 控制器 `server/src/backoffice/nest/helpdesk.controller.ts`、`helpdesk-questions.controller.ts`（员工端问答 + Portal 读已发布问答），注册在 `BackofficeModule`；共用的错误转换在 `helpdesk-http.ts`
  - 前端（2026-10-28 按 Figma 1324:2 重做，卡片看板与独立详情页已删除）：`client/src/backoffice/pages/HelpDeskPage.tsx`（页头 +「+ Add Question」+ 两个 Tab；路由 `/:locale/help-desk/:ticketId?` 一条，切换咨询不重新挂载）；`client/src/backoffice/helpdesk/`（`EnquiriesView.tsx` 三栏状态与写操作、`EnquiryList.tsx` 左栏、`EnquiryConversation.tsx` 中栏、`StudentPanel.tsx` 右栏、`QuestionsView.tsx` 问答表格、`QuestionModal.tsx` 新增 / 编辑弹窗、`icons.tsx`）；纯逻辑 `lib/helpdeskView.ts`（头像 / 标签配色、首字母、时间、筛选参数、可见操作）与 `lib/helpdeskQuestions.ts`（表单校验、筛选、排序、行操作）；`lib/helpdeskApi.ts`（接口，保留 HelpDesk 错误码）、`lib/helpdeskFormat.ts`（状态 / 类型 / 订阅文案）、`contracts/helpdesk.ts`、`helpdesk.css`（只新增 `hd*` 类，颜色与尺寸集中在 `.hdPage` 变量里，便于随 Figma 调整）；文案在 `messages/en-GB.json`、`zh-CN.json` 的 `helpDesk` 段。前端单测 `client/tests/*.test.ts`（`npm test`，Node 自带 `node:test` + 类型擦除，无新依赖）

### 4A.2 状态与员工端文案

| 状态 | 员工端（en-GB / zh-CN） | 员工可做 |
|---|---|---|
| OPEN | New / 待受理 | Claim、Reply、Internal note |
| ASSIGNED | In progress / 处理中 | Reply、Internal note、Handled — ask learner to confirm |
| WAITING_USER | Waiting for learner / 等待用户 | Reply、Internal note、Handled — ask learner to confirm |
| PENDING_CONFIRM | Awaiting confirmation / 待用户确认 | Internal note |
| CLOSED | Closed / 已结束 | Internal note |
| CANCELLED | Withdrawn / 已撤回 | 只读 |

- 可用操作由 Server 按状态计算后随详情返回（`available`），前端只按它显示按钮；状态是否真的允许仍以 Portal 状态机为准（不允许时 409 `invalid_transition`）。
- 公开回复会把工单转为 WAITING_USER，未认领时自动认领（Portal 执行）。

### 4A.3 Enquiries（`/:locale/help-desk`，Figma 1324:2；2026-10-28 取代卡片看板）

- 页头「Help Desk」+ 副标题「Manage student enquiries and common questions」+「+ Add Question」按钮；两个 Tab：Enquiries、Common Questions（§4A.7）。
- 三栏：左 340px 列表（搜索「Search students or enquiries…」匹配姓名、邮箱、主题、工单号；筛选按钮：状态 / Enquiry Type / 标签）；中间对话；右 387px 学员信息、订阅、标签。界面细节由前端按 Figma 实现，此处只定 Server 行为。（2026-10-28 审查修复）Figma 宽 1672 时三栏与设计稿一致；1280–1440 的笔记本上中栏至少 420px，左右两栏按比例让出、最窄 280 / 300；再窄时三栏横向滚动。
- 列表接口：`GET /api/helpdesk/tickets?status=&category=&tag=&q=&cursor=&limit=`（§5.4）。Portal 只接受**一个**状态值，所以 `status` 取 `all`（缺省）/ `needs_reply` / 六个状态之一；`category` 为四个 Enquiry Type 之一；`tag` ≤32 字；`q` ≤120 字（与 Portal 一致）；`limit` 1–100（缺省 30），按 `nextCursor` 滚动加载。每个参数只能出现一次且是文本：`?q=a&q=b` 之类重复参数一律 400 `INVALID_INPUT`（Common Questions 列表与 Portal 读问题接口同样处理）。地址栏里 `all` 只是状态 / 类型的缺省值，搜索词或标签为 all 照常筛选。
- 每行：`contactEmail`、`preview`（首条消息前 120 字）、`unreadByAgent`（未读圆点）、`tags`、`needsReply`（Portal 给了就用，否则 OPEN 或「ASSIGNED 且学员最后发言」）。
- 计数 `counts`：`{ needsReply, all, OPEN, ASSIGNED, WAITING_USER, PENDING_CONFIRM, CLOSED, CANCELLED }`（Portal `needs_reply` / `all` / 各状态，缺项由 Server 推算）。
- 打开工单时前端调 `mark_read`（仅 FULL；VIEW 打开不清未读）。「Mark as reviewed」= `propose_resolution`（工单进 PENDING_CONFIRM，请学员确认）——**这是假设，待产品确认**。回复未认领工单时 Portal 自动认领。
- 标签：`add_tag` / `remove_tag`（1–32 字、去首尾空白并合并中间空白、不含控制字符；每单 ≤10 个由 Portal 判定，幂等），只有 FULL 可用。
- 附件：图片（png / jpeg / webp / gif）内联显示，其它（pdf / txt / csv / docx / xlsx）一律作为下载；≤10 MB；绝不放行 html / svg。
- Portal 未配置（Server 缺 `PORTAL_HELPDESK_BASE_URL` / `PORTAL_HELPDESK_TOKEN`，或 Portal 返回 `integration_disabled` / 拒绝令牌）→ 503 `HELPDESK_NOT_CONNECTED`，页面显示「HelpDesk is not connected yet / HelpDesk 尚未接通」。

### 4A.4 工单详情（`/:locale/help-desk/:ticketId`，Figma 1324:2 中栏 + 右栏）

> 2026-10-28 起详情不再是独立页面：选中左栏一行即在中栏 / 右栏展开。中栏 = 日期分隔 + Enquiry 卡片（主题、Enquiry Type 标签、`联系邮箱 · 时间`、正文、附件 chip「文件名 + 大小」经代理打开、**Mark as reviewed** = `propose_resolution`）+ 之后的消息 + 回复框；右栏 = 姓名 / 邮箱、Student Information、Current Subscription Plan（Active 绿色胶囊，无订阅显示「—」）、Tags（`+ Add Tag`，× 删除，仅 FULL）。打开即调 `mark_read`（仅 FULL 且确有未读），并带上当时看到的 `expectedSequence`：之后学员新发的消息不会被这次 mark_read 清掉未读。2026-10-28 审查后补回 **Claim / 接单**（Tickets v1 spec §7）：只在 OPEN 且 FULL 时显示在 Enquiry 卡片底部、Mark as reviewed 的位置，样式同 Mark as reviewed；接单后工单进 ASSIGNED，才出现 Mark as reviewed（状态表规定 propose_resolution 只在 ASSIGNED / WAITING_USER）。Figma 1324:2 在新咨询上画的是 Mark as reviewed，这一处差异**待视觉验收 / 产品确认**。回复未认领工单时 Portal 仍会自动认领。事件时间线不在 Figma 中，未做。下面几条为原卡片看板时期的描述，以本段为准。

- 左栏对话：学员消息靠左、员工消息靠右（带员工名），**内部备注**用琥珀色底与「Internal note / 内部备注」标记区分（学员永远看不到）；附件图片缩略图经 BackOffice Server 代理 `GET /api/helpdesk/attachments/:id` 加载（浏览器不直连 Portal），点击新窗口打开原图。
- 底部回复区（仅 FULL）：Reply to learner / Internal note 二选一 + 文本框（1–5000 字）+ Send。
- 头部操作（仅 FULL）：Claim、Handled — ask learner to confirm（确认窗口 72 小时，到期 Portal 自动结案）。
- 右栏：学员（姓名、邮箱、语言）、状态、处理人、分类、创建时间、确认截止时间、评分、事件时间线（CloudEvents `type` 去掉 `com.ilovelearningguide.helpdesk.ticket.` 前缀后按事件名显示）。
- 2026-10-28 Figma：详情另带 `student { id, name, accountEmail, contactEmail, joinedAt, totalEnquiries, currentCourse }`（Portal 没给时 Server 用 learner 兜底，其余为 null）与 `subscription { planName, billingCycle, status, renewalDate } | null`（null 时界面显示「—」），均为 Portal 只读投影。
- **VIEW 角色看不到任何操作控件**（服务端同样拒绝，见 §4A.5）。
- 409 `stale_ticket`：重新加载工单并提示「This ticket was updated, please check again」。错误只在操作区内联显示一次。

### 4A.5 权限

- 菜单 `helpDesk`：`GET /api/helpdesk/**` = VIEW；所有写接口（POST / PUT，含标签、已读、问答增改 / 发布 / 下线 / 归档 / 排序）= CREATE，只有 FULL 可用（`route-access.ts` 登记）。当前矩阵：Admin、Operation Admin 为 FULL；其余四个角色为 VIEW（只读）。
- `/api/integration/helpdesk/**`（Portal → Admin）在 `route-access.ts` 里单独归为 `helpdeskIntegration`：**明确豁免员工登录**，只认 Bearer `ADMIN_HELPDESK_TOKEN`（§4A.9）；带员工 Cookie 也没用。只有 `integration/helpdesk` 前缀享受豁免，`/api/integration/**` 的其它路径仍按「未登记 = 仅 Admin」。
- 未登录 401 `INVALID_EMPLOYEE_ACCOUNT`；只读角色调写接口 403 `NOT_AUTHORISED`，且不会调用 Portal。

### 4A.6 错误码（BackOffice 统一信封 `error.code`）

| Portal 返回 | BackOffice 状态 / code |
|---|---|
| Server 未配置 Portal 地址或令牌 | 503 `HELPDESK_NOT_CONNECTED`（不发出请求） |
| 503 `integration_disabled`、401、403 | 503 `HELPDESK_NOT_CONNECTED`（不把 Portal 的 401 透传成员工会话失效） |
| 404 | 404 `TICKET_NOT_FOUND` |
| 400 `invalid_request` / `validation_failed` / `idempotency_key_required` | 400 `INVALID_INPUT`（2026-10-28 联调后统一，页面有对应文案） |
| 409 `stale_ticket` / `invalid_transition` / `idempotency_conflict` / `tag_limit_reached` / `reopen_window_passed` | 409 `STALE_TICKET` / `INVALID_TRANSITION` / `IDEMPOTENCY_CONFLICT` / `TAG_LIMIT_REACHED` / `REOPEN_WINDOW_PASSED`（problem `code` 转大写；员工端可能收到的每个 409 都有文案，由契约测试锁定） |
| 其它 4xx（problem+json） | 同状态码，`code` 取 problem `code` 转大写，缺省 `INVALID_INPUT` |
| 5xx、无法连接、响应无法解析 | 502 `HELPDESK_UNAVAILABLE` |
| 超时（JSON 5 秒、附件 10 秒） | 504 `HELPDESK_UNAVAILABLE` |

`expectedSequence` 必须是 ≥1 的整数（Portal 每单至少有 created 事件，sequence 从 1 开始）；0 或负数在 Server 直接 400 `INVALID_INPUT`，不发给 Portal。

**线上契约（2026-10-28 两端联调后锁定）**：`server/src/backoffice/tests/fixtures/helpdesk-contract.json` 与 `client/tests/fixtures/helpdesk-contract.json`（两份相同，Portal 仓库 `tests/fixtures/helpdesk-contract.json` 也是同一份）取自 Portal + Admin 在本地真实联调的请求 / 回包并脱敏。`helpdesk-contract-fixture.spec.ts`（server）锁：枚举一致、能完整读出 Portal 的列表 / 详情、发给 Portal 的消息与动作体、Portal 每个 problem code 的映射、给 Portal 的 questions / suggest / outcome 回包形状；`client/tests/helpdesk-contract.test.ts` 锁：两份 fixture 相同、Portal 会发来的订阅状态（`active` / `cancel_at_period_end` / `grace`）与计费周期（`annual` / `semiannual`）在两种语言都有文案、员工端可能收到的 409 都有文案。改契约时三份一起改。

Common Questions（BackOffice 自己判定）：400 `INVALID_INPUT`、404 `QUESTION_NOT_FOUND`、409 `VERSION_CONFLICT`（版本不一致，先于状态检查）、409 `INVALID_TRANSITION`（如下线草稿、编辑已归档）。

### 4A.7 Common Questions 问答库（Figma addendum §A）

- **归属**：BackOffice 是唯一写入方（四组件「一份数据一个写入方」）；Portal 只经 `GET /api/integration/helpdesk/questions` 读已发布的；Agent 经契约 `HelpdeskQaSource`（`server/src/contracts/helpdesk-qa.ts`）读候选。
- **字段**：`locale`（en-GB / zh-CN）、`category`（四个 Enquiry Type）、`question`（1–200）、`answer`（纯文本保留换行，1–4000，URL 渲染时自动成链接）、`keywords`（≤20 个，每个 ≤40，去重并转小写）（问题、答案、关键词不得含控制字符，制表符与换行除外，否则 400 `INVALID_INPUT`；PostgreSQL TEXT 不收 U+0000）、`status`（draft / published / archived）、`featured`（Portal 右栏展示）、`sort_order`、`version`、`created_by` / `updated_by`（员工 id）、时间戳。
- **状态**：draft ⇄ published（publish / unpublish）；draft / published → archived；archived → published（恢复）。归档后不能编辑；没有删除。
- **并发**：每次修改带 `version`；SQL 为 `UPDATE … WHERE id = $1 AND version = $2`，不一致 409 `VERSION_CONFLICT`、什么都不改；成功 `version + 1`。编辑弹窗收到 409 后取最新版本（`GET /api/helpdesk/questions/:id`），保留员工已输入的草稿并提示，再点保存即用新版本；问题已不存在（404）则关闭弹窗并刷新列表。新增 / 编辑保存成功以 toast「Question saved.」确认。
- **修订**：每次修改在同一事务里追加一行 `helpdesk_question_revisions`（`create` / `update` / `publish` / `unpublish` / `archive`，`snapshot` 为修改后的整行）；排序变化记 `update`。
- **排序**：`POST /api/helpdesk/questions/reorder { items: [{ id, version }] }` 按给定顺序设为 10、20、30…，任一行版本不符整体不改；只有位置变化的行 `version + 1`。新建时排在该语言最后（最大值 + 10）。
- **计数**：列表与详情的 `stats { shown, solved, declined }` 来自 Agent 的 `helpdesk_suggestions`（经契约 `HelpdeskSuggestionStats`，由 AppModule 注入）；读不到时为 0，不影响页面。
- **Portal 读取**：只返回已发布、指定语言（`featured=true` 时只要 featured），按 `sort_order`；强 ETag = 公开内容的 SHA-256；`If-None-Match` 命中（含弱比较、逗号列表、`*`）返回 304；`Cache-Control: no-cache`（Portal 自有 60 秒缓存）。
- **界面**：Common Questions Tab 与「+ Add Question」弹窗没有 Figma 画板，复用 Knowledge / AI Tutor 的表格与弹窗样式，**待视觉验收**。

### 4A.8 推荐答案（Agent 角色，Figma addendum §C）

- 代码：`server/src/ai/helpdesk/`（`helpdesk-suggest.service.ts`、`helpdesk-suggestion.store.ts`、`helpdesk-suggest.controller.ts`），只在 `agent` 角色挂载（`AiModule.register({ learnerApi: true, helpdeskQa })`）。候选来源实现在 BackOffice（`createPgHelpdeskQaSource`），由 `app.module.ts` 组装注入；双方互不 import（eslint 边界不变）。
- 流程：①每学员每小时 10 次（共用 `ai_rate_limit_hits`，key `helpdesk-suggest:<learnerId>`），超出返回 null；②候选 = 该语言已发布问题，英文全文（`english` 配置，OR 连接、去停用词）+ 关键词出现在学员原文中 + 中文双字片段命中问题，同类 ×1.25，取前 8（SQL 先取两路命中再打分：全文一路的 WHERE 就是索引表达式 `@@ to_tsquery`，走 GIN 索引 `helpdesk_questions_search_idx`，PG 用例对真实 `CANDIDATES_SQL` 做 EXPLAIN 锁定；关键词 / 双字一路是「片段出现在原文里」，只能扫该语言已发布的行）；没有候选**不调模型**；③（2026-10-29 起，见 §4A.11）由写死的工作流 `retrieve → pick_faq → validate → answer` 决定每一步；只有 `pick_faq` 一步调模型：用原样的 pi-agent-core `Agent`（pi-ai 的 OpenRouter provider）跑一次，只给这一步的工具 `pick_faq`，两个参数都枚举锁定（`terminate: true`）：先 `intent`（question / own_account / someone_else / exception / private_data / instructions / off_topic，2026-10-29 起：模型只分类，代码只在 question 与 own_account 时出 FAQ，own_account 即「帮我退款 / 取消 / 改资料」这类代办，推讲自助办法的那条），再 `faqId`（候选 id 或 `none`）；学员原文超过 2000 字时送开头 600 字 + 结尾 1400 字（长信的问题常在最后），`beforeToolCall` 只放行这一个工具、一步最多一次调用、`finishTurn` 即结束、到期 abort；选 `none`、不调工具、调用不合法都按 null；模型写在代码里：`google/gemini-2.5-flash`，部署不用配（`HELPDESK_SUGGEST_MODEL` 只在要临时换模型时设；不看 AI Tutor 的 `AI_AVAILABLE_MODELS`）（2026-10-29 qa10k dev 难例真模型对比：答错率 gemini-2.5-flash 9.2% < deepseek-v4.1-flash 12.3% < gpt-4o-mini 18.8%；claude-haiku-5.5 经 OpenRouter 不按要求调工具，不可用）；超时 3 秒；整次推荐（限流 + 检索 + 模型）另有 3.5 秒总期限，低于 Portal 的 4 秒等待：模型只拿剩余时间，过了期限才定下的答案不返回、日志不记 `qa_id`（学员没看到，不计入 shown）；学员原文含控制字符（制表符与换行除外）400 `invalid_request`，不调模型；没有 `OPENROUTER_API_KEY` 或任何错误都返回 null（永不阻塞学员提交）；④返回库里的原答案，模型从不写给学员看的文字；学员原文只放在 user 消息里，system 提示要求忽略其中指令。
- 日志：每次检索写一行 `helpdesk_suggestions`（`id` UUIDv7、`learner_id`、`locale`、`category`、`query_text`、`candidate_ids`、`qa_id|null`、`model|null`、`latency_ms`、`outcome`）。
- 结果：`POST …/suggestions/:id/outcome { outcome: solved | declined | edited }` 幂等，**首个为准**（条件更新 `WHERE outcome IS NULL`）；同值重复返回 `changed: false`，不同值不覆盖也不报错。
- 保留：没有定时任务，`query_text` 90 天后由推荐流程顺手清空（每个实例每小时最多一次，失败不影响推荐）；运维也可手动执行 `UPDATE helpdesk_suggestions SET query_text = NULL WHERE created_at < now() - interval '90 days' AND query_text IS NOT NULL`。
- 中文检索限制：PostgreSQL 没有中文分词，中文靠关键词与双字片段命中；建议给中文问答多填关键词。

### 4A.9 Portal → Admin 集成鉴权（Figma addendum §E）

- 路径 `/api/integration/helpdesk/**`：`GET faqs`、`GET faqs/:id`（admin 角色，v2 取代 `GET questions`）、`POST suggest` 与 `POST suggestions/:id/outcome`（agent 角色）。
- `Authorization: Bearer <ADMIN_HELPDESK_TOKEN>`（RFC 6750），每次请求现读环境变量、`timingSafeEqual` 定长比较；令牌为空 → 503 `integration_disabled`（本地也不放行）；缺失 / 错误 → 401 `invalid_token`（带 `WWW-Authenticate: Bearer realm="helpdesk", error="invalid_token"`，与 Portal 集成接口同一个代码，RFC 6750 §3.1）。
- 成功体为纯 JSON（不套 §5.3 信封）；错误一律 RFC 9457 `application/problem+json`：`{ type: "https://www.ilovelearningguide.com/problems/<code>", title, status, detail, code }`，code 为 `invalid_token` / `integration_disabled` / `invalid_request` / `not_found` / `internal_error`。请求体不是合法 JSON、路由不存在等在控制器之外发生的错误，也由全局过滤器对这一前缀输出 problem+json。
- 拆分部署时：`faqs` 在 admin 实例，`suggest*` 在 agent 实例；Portal 只配一个 `ADMIN_HELPDESK_BASE_URL`，需由网关按路径分流或两个角色同进程（今天的部署方式）。

### 4A.10 Tickets v2：FAQs 与学员时间线（2026-10-28，`tickets-v2-figma-addendum.md`）

- **FAQs Tab（Figma 1379:2，`?tab=faqs`；旧链接 `?tab=questions` 自动换成 `?tab=faqs`）**：搜索（防抖 300ms）+「All categories」+「All FAQs / Popular / Not popular」+「N FAQs」，筛选与页码都写在地址栏；表格列 Question / Answer（界面语言的问题 + 答案第一行去 Markdown）、Category（颜色按分类固定）、Popular（Yes 绿 / No 灰）、Last Updated、Action（Edit 描边按钮 + Preview 链接）；每页 10 条，「Showing 1–8 of 8 FAQs」+ 页码。代码 `client/src/backoffice/helpdesk/FaqsView.tsx`、`lib/helpdeskFaqs.ts`。
- **新增 / 编辑抽屉（Figma 1379:299，`FaqDrawer.tsx`）**：盖在 Tab 下方的内容区上，右侧 620 宽；Category* + Popular FAQ、Question / Answer（English）*、Question / Answer（Chinese）*、Keywords。答案工具栏 B / 1. / • / Link 只插入 Markdown 子集（Link 在工具栏下方要地址，只收 http(s) / mailto）。保存即发布；新建带 `Idempotency-Key`（同内容重试沿用），编辑带 `version`，409 时载入最新版本、保留草稿并提示；404 关闭抽屉并提示已不存在。「Delete FAQ」（只在编辑时，左下角）确认后归档。Escape / 遮罩 / × / Cancel 在有未保存修改时先确认。
- **Preview（`FaqPreview.tsx`）**：只读弹窗，EN / 中文 切换（缺省跟随界面语言），答案经唯一的安全渲染器 `Markdown.tsx`（只生成 React 元素，原始 HTML 当文字，外链新标签页 + `rel="noopener noreferrer"`）。VIEW 角色没有「+ Add FAQ」与 Edit / Delete，但能 Preview。
- **Enquiries 中栏 = 学员时间线（Figma 1324:2 v2，`EnquiryTimeline.tsx`）**：选中工单后取 `GET /api/helpdesk/tickets?learnerId=<Portal user id>&limit=10`，与选中的工单合并（只留同一学员，新的在前，最多 10 条，选中的一定在），按日期分组。时间线上其它卡片的详情各取一次（只读 GET，不调 mark_read），以便每张卡片都有正文、附件与 AI 块；点卡片主题即选中（URL 保留筛选）。每张卡片的操作栏 4 个等宽按钮：Mark as reviewed（OPEN 时为 Claim / 接单）、Email student（展开这张卡片的回复框）、Internal notes（展开内部备注与备注框；员工端的内部备注只在这里出现）、Flag follow-up（`flag` / `unflag` 开关，`aria-pressed`）。写操作按卡片自己的 id 与 sequence 发出，结果提示在那张卡片下。卡片后是它的 AI 块（`aiAssist`）：标题「AI Support Assistant」+「AI-generated」+ 右侧机器人头像；`helpful` / `solved` 绿色「Student feedback: Yes, this solved my issue」，`not_helpful` / `declined` 红色「…No, I still submit to support team」，没有反馈（或 `edited`）不显示。VIEW 整个操作栏不显示，内部备注只读显示在对话里。
- **左栏**：标了跟进的行在名字旁有小旗子；筛选弹层多一个「Flagged」勾选（URL `flagged=true`）。
- **跨应用联调（2026-10-28，Portal `tests/e2e/helpdesk-integration.spec.ts`，脚本在 `lg-helpdesk/integration-harness/`）**：本机 PostgreSQL 16 + 全部 Prisma 迁移、Server、Vite 客户端与 Portal dev 一起跑，令牌只用本地值；模型用 `OPENROUTER_BASE_URL` 指向本地假端点（只回第一个候选 id），另跑一次不配模型 key（chat / submit 返回 null，chip 直接返回 FAQ）。发现并修好的都在客户端，各有组件测试锁住：① 搜索防抖期间改了别的筛选会被防抖写回覆盖（FAQs Tab 与 Enquiries 左栏，`FaqsView.tsx` / `EnquiriesView.tsx` 改为写在最新的地址栏参数上）；② 选中卡片时滚的是整段（卡片 + AI 块 + 对话），比中栏高时把日期分隔顶出去，改为只滚卡片本身、每次选中只滚一次；③ 直接打开较早那张卡片的链接时，上面卡片的详情（正文、AI 块）后到会把它挤出中栏，改为上面每多一张载好的卡片再滚一次（`EnquiryTimeline.tsx`）。
- **待视觉验收**：Preview 弹窗、Link 地址行、Delete / 放弃修改确认、按钮的展开 / 按下 / 禁用态、回复框与备注面板、当前卡片的高亮边框、卡片上的状态胶囊（放在 meta 行右侧）、左栏小旗子与 Flagged 勾选。截图与对照：`lg-helpdesk/tickets-v2-shots/app-1324-2-*.png`、`app-1379-2-*.png`、`app-1379-299-*.png`、`app-faq-preview-*.png` 与对应 `compare-*.png`。


### 4A.11 推荐链路、追踪与评测（2026-10-29，`lg-helpdesk/helpdesk-agent-v2-pi-dsh.md`）

- **没有自主 agent 循环**：工作流（`server/src/ai/helpdesk/workflow/engine.ts` + `faq-workflow.ts`）是写死的步骤表，代码决定下一步；agent 步由 `pi-step-runner.ts` 用**不改动**的 `@earendil-works/pi-agent-core` / `@earendil-works/pi-ai` 1.4.0 执行（ESM，经 `import()` 加载；Node ≥ 22.19）。学员可见行为不变：模型只选候选 id 或 none，答案是库里的原文，任何失败（无 key、3 秒超时、工具调用不合法、abort、限流、错误）返回 null，绝不阻塞建单；Portal ↔ Admin 契约向后兼容。
- **事件日志**（迁移 `20261029120000_helpdesk_agent_events`，表 `helpdesk_agent_events`）：照 DeepSeek Harness 的 SessionEvent，信封 `{ type, seq, time, data }`，主键 `(run_id, seq)`，`seq` 每个 run 从 1 连续；类型 `turn/start` · `step/start` · `request/context` · `request/header` · `assistant/message` · `tool/call` · `tool/result` · `step/end` · `turn/end` · `feedback`。只追加：触发器拒绝一切 UPDATE / DELETE，唯一例外是 90 天后清学员原文（`turn/start.input`、`assistant/message.text`）。模型可能把学员原文塞进被拒的调用或 provider 报错，这些只记形状（2026-10-29 复核）：`tool/call.arguments` 只记通过枚举校验的参数，被拒的只记 `rejectedArguments.length`；不像标识符的工具名记 `invalid_name`；`tool/result.error` 只有 `{ name, code }`（不记 pi 的校验文字）；`assistant/message` 出错只记 `error { name: 'ProviderError', code }`（`http_<状态>` / finish_reason / `provider_error`，不记报错原文）。`costUsd` 来自 pi 价目；模型不在价目里时为 `null`（未知，不是免费）。事件在后台写，失败重试一次，再失败只记日志、不影响推荐；`feedback` 只接在已有的 run 后面；`main.ts` 开了 `enableShutdownHooks`，SIGTERM 时先写完缓冲的事件。从不记 key 与鉴权头。
- **run id 与对话链**：Portal 先生成 `runId`（UUIDv7），它同时是 Portal 的 assist 行 id、Admin 的 suggestion id 与事件日志的 run；`parentRunId` = 该学员 24 小时内最早一条尚未关联工单的 assist 行（没有为 null），`turn/start` 记下它，读接口据此拼出 `chain`。
- **W3C Trace Context**：Portal 每次调 Admin 都带 `traceparent`（有合法的入站 `traceparent` 就开它的子 span，否则新 trace；版本固定 `00`）；Admin 接收后 `turn/start` 记 `traceId` / `spanId` / `parentSpanId`，发往 OpenRouter 的每次请求再开子 span（`request/header` 事件记下发出的值）。不合法的入站值直接重开 trace。
- **读接口**（BackOffice，§5.4）：`GET /api/helpdesk/agent-runs/:runId` 与 `…/events/:seq`，helpDesk VIEW 及以上可读，只读、`no-store`，给的是**导出副本**（学员原文脱敏为 `{ redacted: true }`）。BackOffice 只经契约 `src/contracts/helpdesk-trace.ts` 的 `HELPDESK_TRACE_SOURCE` 读（`BackofficeModule.register({ helpdeskTrace })`，`app.module.ts` 组装），不 import ai。
- **「查看链路」/ View trace（client）**：每个 AI 块右上的链接按钮打开只读抽屉（`TraceDrawer.tsx`，沿用 FAQ 抽屉样式）：概要（结束原因、模型、token、费用、时延、选中的 FAQ、候选、Trace ID、对话中的 run 数）+ 事件列表（时间偏移、类型、步骤、模型 / token / 费用 / 工具参数 / 错误）；时间偏移按 ms / s / min / h / d 显示，读不出的时间显示「—」；价格未知显示 Unknown / 未知；新的结束原因没有文案时原样显示；没有记录显示「No trace was recorded for this answer.」，加载失败可「Try again / 重试」。**待视觉验收**（无画板）：抽屉与按钮在 AI 块上的位置。
- **评测**（`server/eval/helpdesk/`）：`cases.jsonl` 162 条（en-GB / zh-CN / zh-TW × paraphrase、terse、typo、mixed_language、unanswerable、injection、over_reach、ambiguous（相邻 FAQ）、multi_intent、long（超过 2000 字），每格至少 2 条；另有 6 条 `source: submit` 带主题与工单类型；`acceptableFaqIds` 标出也算答对的 FAQ（2026-10-29 用户：学员要我们代办的请求，如「帮我退款 / 取消 / 删号 / 查订单」，我们做不了，期望答案就是讲自助办法的那条 FAQ，不再是 none；none 只留给没有 FAQ 帮得上的问题）；繁体用例 5 条在 `note` 里写明：检索做繁转简以前它们检索不到）对着 `faqs.json` 的种子 FAQ，走真正的 `HelpdeskSuggestService` 与 pi 工作流。`npm run eval:helpdesk -- --out report.json|report.md [--pg <url>] [--limit N] [--concurrency N]`（`--concurrency` 1–16，缺省 1，同时跑几条；每个 worker 开跑前查预算，最多多花 N − 1 条；走 HTTP 代理的环境要加 `NODE_USE_ENV_PROXY=1`，Node 自带的 fetch 才会走代理）：有 `OPENROUTER_API_KEY` 用真模型（与生产选同一个模型，`HELPDESK_SUGGEST_MODEL` 可覆盖），花费上限 `HELPDESK_EVAL_BUDGET_USD`（缺省 5 美元，只给评测用；每条开跑前检查，最多超出一条的费用；被 abort、拿不到 usage 的请求按价目算出的单次上限记账，价格未知就停），闸门不过退出码 1；没有 key 用 pi 的 faux provider（永远选检索第一名），报告标明「不是模型成绩」，退出码 0；参数或运行出错退出码 2（入口 `cli.ts`，有测试）。报告：准确率、答错率、none 精确率 / 召回率、p50 / p95、费用、按 persona / locale 拆分、检索与模型分开（recall@8、模型 recall、问过模型的条数、没问模型的 none、非法调用、出错 / 超时数）、失败清单（每条标 stage：error / retrieval / model）、闸门（答错率 ≤ 2%、p95 ≤ 3 秒、出错 / 超时 / 限流 / 无 key ≤ 2%、期望 FAQ 已在候选中的用例模型答对 ≥ 80%；只有真模型、整套用例、`--pg` 的一次运行才可能通过，`--limit` 子集与内存检索都不过）。检索缺省是内存近似，`--pg` 在临时 schema 跑真实的候选 SQL（跑完删掉）。`eval.spec.ts` 随 `npm test` 在 CI 里跑（假模型，不连网）。
- **你可能想问（helpdesk-v3 §1，2026-10-29）**：推荐没有答案时，回包的 `alternatives` 由代码给出、从不再问模型：检索到的候选按检索顺序前 3 个；没有可用候选（无候选、无 key、出错、chip 的 FAQ 已下架）就取该语言的热门（`popular`）已发布 FAQ，工单的 FAQ 分类在前、再按更新时间（契约 `HelpdeskQaSource.findPopular`，SQL 是 `listPublished` 加 `boost` / `excludeIds`）；查热门最多等 `ALTERNATIVES_TIMEOUT_MS` = 300 ms（3.5 秒期限后再查也在 Portal 的 4 秒内），查不到给 `[]`。从不含刚给学员看过的 FAQ（chip 的 `faqId` 与 `shownFaqIds`），去重；`rate_limited` 与调用方已断开（`aborted`）为 `[]`，参数不合法照旧 400。答案仍是库里原文：学员点一个就按 chip 带 `faqId` 再问。`turn/end` 加 `alternatives: [faqId…]`。评测报告加「Alternatives recall (answerable, no answer)」：该有答案却没答的用例里，期望（或可接受）的 FAQ 在 alternatives 中的比例（`alternativesRecall` / `alternativesOffered` / `unansweredAnswerable`）。BackOffice 读 Portal 的 `aiAssist` 每项加 `rating`（学员给这次 AI 回答的 1–5 分，没评为 null；只认 1–5 的整数）。学生时间线里每张工单卡片在状态胶囊后显示学员给工单的评分「评分 n/5 / Rating n/5」，没有评分时「未评分 / Not rated」（按 v3 §2 原文，未关闭的工单也显示）；AI 块有评分时显示「评分 n/5」。
- **qa10k 评测集（2026-10-29，`server/eval/helpdesk/qa10k/`）**：10,000 条（`dev.jsonl` / `test.jsonl` 各 5,000，按对话整组切分、不跨文件）对着同目录的 `faqs.json`（35 条：14 条种子 + 21 条依据 Portal 文案）；字段另有 `role`、`conversationId` + `turn`（多轮），标注规则与人工审校的改动见 `STATS.md`「Label audit」（账号 / 付款**操作**请求为 null，除非有 FAQ 讲学员自己怎么做）。harness 接受这三个可选字段，报告另按 role、语言（en-GB / zh-CN / zh-TW / mixed）、case type 与轮次（single / first / follow_up）拆分。`--retrieval-only`（可加 `--pg`）只跑检索：recall@1 / @3 / @8、平均名次、无候选的 none 占比与检索耗时，整体与各拆分都有，从不问模型（有 key 也不问），退出码 0。检索只在 dev 上调，test 只在调完后跑一次。
- **候选检索 v2（2026-10-29，`faqRepository.ts` `FAQ_CANDIDATES_SQL` + `faqSearchText.ts`）**：① 繁体 → 简体（`opencc-js` 1.4.2 锁版本，港 / 台字形；不用台湾词组表：它把「登出」换成「注销」、「離線」换成「脱机」），再加一份港台用词与粤语 → 普通话的改写（`MANDARIN_VARIANTS`：电邮 → 邮箱、户口 → 账号、唔 → 不、咗 → 了、点样 → 怎么 …；只放语言差异，不放业务同义词，后者由运营写进关键词）；双字取自简体与改写，关键词同时对原文、简体与改写；② 英文全文与中文双字不再看界面语言；③ 双字按 IDF 加权（w = ln((N+1)/df) / ln(N+1)），只靠 w < 0.1 的常见双字（「怎么」「可以」）不算命中；④ 英文拼写容错：对称删除，生成列 `typo_keys` + GIN 索引，查询端同一规则展开（编辑距离 1，含相邻对调）；⑤ 关键词前缀改为每条查询编译一次的正则，ts_rank 只算全文命中的行。dev 检索 recall@8 90.6% → 95.1%（zh-TW 72.2% → 95.0%，typo 80.0% → 90.5%），test 95.0%；35 条 FAQ 时 p95 12–13 ms。上千条 FAQ 时关键词与双字两路仍是逐行扫描（与改动前同阶），3,045 行近重复库压测 p95 约 0.4–0.6 s（改动前约 0.58 s）；下一步是把双字与关键词前缀也做成带 GIN 索引的生成列。报告：`lg-helpdesk/qa10k/retrieval-dev-before.md` / `retrieval-dev-after.md` / `retrieval-test-after.md`；锁定用例：`helpdesk-faq-search-text.spec.ts`、`helpdesk-faqs-repository.pg.spec.ts`、`eval.spec.ts`（PG：dev 每 10 条取 1 条，recall@8 > 93%、zh-TW > 88%、typo > 85%）。
- **订单关联的咨询（helpdesk-v4 Part A，2026-10-29，契约 v5）**：学员从付款记录发起咨询时 Portal 校验订单属于本人后存下订单号；BackOffice 读 Portal 集成接口时，列表与详情每条工单多 `orderId`（字母、数字、`_`、`-`，≤64，否则 null），详情多 `order`：Portal 用代码从订单记录投影的只读块，`portalHelpdeskClient.ts` 的 `normaliseOrder` 只留 `{ id, status, amount, currency, planName, kind, createdAt, paymentMode }` 这 8 个字段（多给的卡号、Stripe 标识、地址等一律丢弃；格式不对的字段为 null；订单号不合格整体为 null；`amount` 是最小货币单位的整数，`currency` 小写）。AI 助手与推荐接口从不接触订单。右栏在「Current Subscription Plan」后加「订单 / Order」块（`StudentPanel.tsx` `OrderBlock`，沿用订阅块的行样式）：订单号 + 「复制」（剪贴板被拒时选中订单号并提示按 Ctrl/⌘+C，结果在 `role="status"` 里播报）、状态胶囊（已支付绿；待支付 / 支付失败琥珀；其余灰）、金额（按币种小数位换算）、方案、下单日期、支付方式；只有 `orderId` 的工单才显示，Portal 这次没读到订单（`order` 为 null）时只有订单号与复制，并提示「暂时读不到这个订单的详情」。不链到订单页：BackOffice 的 Order Management 还是占位页，Portal 的 `/backoffice/orders` 也不能按地址打开某个订单。左栏有 `orderId` 的行在预览旁有一个小「订单 / Order」标签（读屏为「关联订单 <订单号>」）。新状态都没有画板，待视觉验收。


### 4A.12 Helpdesk v5 契约先行（2026-10-30，`lg-helpdesk/helpdesk-v5-context-chips-and-smalltalk.md` + `helpdesk-v5-faq-graph-design.md`，契约 fixture v6）

先定契约，Admin 与 Portal 两边并行实现；全部是增量：旧的 Portal、旧的 Admin 照常工作，第一次发布版本之前逐条发布照旧。锁定 / 灵活的界线（Oliver）：模型只在固定列表里选枚举和 id（候选里的 faqId、所选答案的块 id、confidence），只写短句（寒暄回复、答案开头 / 结尾、clarify 解释），每句都过代码守卫，任何一条不过就用固定模板；模型从不陈述事实、从不收到学员数据（订单、套餐、信号）。

- **契约位置**：`server/src/contracts/helpdesk-qa.ts`（Agent 与 BackOffice 共用）：`SITUATION_SIGNALS`（Portal 只用代码、只读自己的数据算，不发给 Admin）、`FAQ_SIGNALS`（FAQ 可打的标签，顺序 = Portal 选情境 chip 的优先级；`open_ticket_waiting` 不是 FAQ）、`FAQ_NODE_TYPES` answer|choice、`FAQ_EDGE_KINDS` follow_up|option、`FAQ_RELEASE_STATUSES`、`FaqBlock` / `FaqNode` / `FaqEdge` / `FaqRelease`、`faqReleaseEtag`、`SUGGEST_KINDS`、`SUGGEST_INTENTS`（v2 的七个 + greeting / farewell / vague / clarify；farewell 单列是因为 Portal 在答过之后接评分卡）、`CONFIDENCE_LEVELS`、`GUARD_RESULTS` / `GUARD_REASONS` / `GUARDED_FIELDS` / `SuggestGuard`、`GUARD_LIMITS`（开头 / 结尾 30 zh · 80 en，回复 80 · 200，解释 150 · 350）、`EXCERPT_RULES`（1–3 个连续块；≤3 块或 ≤200 字给整条）、`SuggestRequestContext` + `parseSuggestContext`、`SuggestTurnFields` + `suggestTurnProblems`（每种 kind 的规则，纯函数，两边测试与自检用）。
- **FAQ 信号标签**（迁移 `20261030140000_helpdesk_faq_signals`：`helpdesk_faqs.signals text[] NOT NULL DEFAULT '{}'`，CHECK 只收 `FAQ_SIGNALS` 且 ≤8）：员工新建 / 编辑时可带 `signals`（只收 FAQ_SIGNALS，去重并按优先级排；未知值 400）；**不带就保留原值**（旧的编辑器只改文字不会清掉）；只改标签也算修改（升版本、写修订）。Portal 读到的每条已发布 FAQ 多 `signals`。client 有 `FAQ_SIGNALS` 与中英标签 `faqSignalLabel`（编辑器多选由后续实现，待视觉验收）。
- **答案块**（`faqs/faqBlocks.ts` `splitAnswerBlocks`）：发布时由代码切块，id 按顺序 b1..bn：每段一块、每组编号步骤一块、每个列表一块；逐行走与 `faqMarkdown.ts` 渲染器相同的状态机（共用 `ORDERED` / `BULLET`），所以每块单独渲染 = 它在整条答案里的渲染（共享 Markdown 语料与评测种子库全部锁定）。Portal 只按 id 渲染。
- **发布快照**（`faqs/faqRelease.ts`）：快照存双语（`FaqSnapshotNode` 带 `blocksEn` / `blocksZh`，`FaqSnapshotEdge` 的 label 可空 = 子节点的问题，另有 phrasings 不发给 Portal）；`freezeNode` 发布时切块（choice 节点没有块）；`publicRelease` 按语言挑字段、解析 label；`currentRelease` 做 ETag `"v<version>"` 与 If-None-Match。来源经 `HELPDESK_FAQ_RELEASE_SOURCE`（`FaqReleaseSource.current()`）注入；发布表接上之前是 `noFaqReleases`（永远 404 no_release，Portal 照旧读逐条发布的列表）。
- **新集成接口** `GET /api/integration/helpdesk/faq-release/current?locale=`（`HelpdeskIntegrationFaqReleaseController`）：见 §5.5。规范里写的是 `/api/helpdesk/integration/…`，但 `/api/helpdesk/**` 是员工菜单的命名空间（会话鉴权），所以放在 Bearer 守卫管的 `/api/integration/helpdesk/**` 下，与其它集成读接口一致。
- **推荐请求的 context**：`parseInput` 解析并校验 `context`（不合法 400 `invalid_request`），存在 `SuggestInput.context`；有 context 的请求按契约要回 `SuggestTurnFields`，由 v5 工作流实现（守卫、模板、摘录、clarify 步）。**不带 context 的请求回包与 v5 逐字相同**。
- **契约 fixture v6**（server 与 client 两份、Portal 一份，逐字节相同，Portal 固定 sha256）：新枚举、FAQ 例子的 `signals`、发布快照的请求 / 回包 / 头 / 304 / 404、带 context 的请求，以及每种 kind 一个回包（带摘录的 answer、choice、smalltalk、zh-CN 的 smalltalk 模板回退（发布前，releaseVersion null）、clarify、clarify 未覆盖、no_match）。
- **测试**：`src/contracts/helpdesk-qa.spec.ts`、`backoffice/tests/helpdesk-faq-blocks.spec.ts`、`helpdesk-faq-release.spec.ts`（投影、ETag / 304 / 404 / 400 / 401 / 503）、`helpdesk-faqs-service.spec.ts`（信号）、`helpdesk-faqs-repository.pg.spec.ts`（信号列与约束）、`helpdesk-contract-fixture.spec.ts`（v6）、`ai/helpdesk/helpdesk-suggest.service.spec.ts`（context）、client `tests/helpdesk-contract.test.ts`（v6 标签）。

### 4A.13 FAQ 问题树：存储、发布与运行时开关（2026-10-30，`helpdesk-v5-faq-graph-design.md` §2、§2.2、§2.3、§6、§8.1–8.2）

- **迁移** `20261030150000_helpdesk_faq_graph`（只加不改）：
  - `helpdesk_faqs` 加 `key`（唯一；旧行按英文问题确定地回填：小写、去撇号、非字母数字换成 `-`、≤60 字，重名按创建先后 `-2`、`-3`；不带 key 的 INSERT 由触发器同样取）、`node_type` answer|choice、`entry`（缺省 true）、`phrasing_text` / `phrasing_tsv`（问法的检索文字，问法表的触发器维护）。不动 `updated_at`，Portal 的 ETag 不变。SQL 函数 `helpdesk_faq_slug` 与 `faqKeys.ts` `faqKeySlug` 同一规则（pg 测试逐条比对）。
  - 新表 `helpdesk_faq_edges`（DAG：parent → child，follow_up | option，position，label_en/zh 可空 = 子节点的问题；两端 FK ON DELETE RESTRICT；UNIQUE (parent, child)；CHECK parent ≠ child）、`helpdesk_faq_edge_revisions`（只追加：改前 / 改后、谁、何时）、`helpdesk_faq_phrasings`（en-GB / zh-CN / zh-TW，≤200 字，staff | flywheel | seed，UNIQUE (faq_id, locale, lower(text))）、`helpdesk_faq_releases`（version 唯一；状态 draft | evaluating | published | rejected | superseded；snapshot 写入后不再改、行不删除（触发器）；部分唯一索引保证至多一行 published）、`helpdesk_faq_release_nodes`（发布版本的检索行，从快照派生、与快照同一事务写入、只追加；列名与 `helpdesk_faqs` 相同）。
- **编辑**（`faqGraphService.ts` + `faqGraphRepository.ts`，原生 SQL）：边的 kind 由父节点类型决定；choice 至多 4 个选项（文字 ≤24 中文字 / 40 英文字符）、answer 至多 6 条追问；**成环在同一事务里用递归 CTE 拒绝**，所有边的写入先拿同一把事务级 advisory 锁，两条互相指向的并发边不可能都通过；每次建 / 改 / 删 / 重排都追加修订。节点字段 key / type / entry 走原来的 `PUT /api/helpdesk/faqs/:id`（不带就保留原值，旧的编辑器不受影响）；choice 节点的提问不许数字、链接、邮箱；**归档一个还有已发布父节点的节点 → 409 `FAQ_HAS_PARENTS`**（消息里列出父节点）。
- **图检查**（`faqGraphChecks.ts` `checkFaqGraph`，纯函数）：边的两端都在快照里（没归档）、不重复、无环（DFS）、离最近入口 ≤4 条边、非入口节点都能从入口走到、option 只从 choice 出 / follow_up 只从 answer 出、choice 2–4 个选项且提问不陈述事实、answer ≤6 条追问、两种语言都在且覆盖文字两种语言要么都给要么都不给、解析后的选项文字 ≤24 / 40、answer 两种语言都切得出块。
- **发布**（`faqReleaseService.ts`）：「发布新版本」= REPEATABLE READ 读一份工作表 → `freezeSnapshot`（只要已发布节点，块此时切好，同一父节点下 position 重编为 0..n-1）→ 图检查 → 写入版本与检索行 → 检查过了才跑评测门（evaluating）→ 过 = draft（可以发布），不过 = rejected。工作表和最新版本（或当前发布的）一模一样 → 不新建（幂等）。发布 = 同一事务里旧的 → superseded、这一版 → published（已发布再发布 = 原样返回）。回滚 = 把曾经上线过的版本的快照复制成新版本并立刻发布（不再跑评测，报告写明来源；图检查照跑；当前上线的就来自它 → 原样返回）。 **后台检查**（2026-11-03）：生产里「发布新版本」/「重新检查」立刻返回 evaluating，检查在后台跑；`helpdesk_faq_releases` 新列 `eval_run_id` / `eval_started_at` / `eval_heartbeat_at` / `eval_progress`（迁移 `20261103120000_helpdesk_faq_release_eval_runs`），每 30 秒心跳并写进度（retrieval / vectors / model n/total）；心跳超过 3 分钟没动 = 「检查中断」（服务重启、部署打断），可以重新检查，新的一次用 run id 做 CAS 接管，旧的那次的进度与结果都写不进去（它也会收到 abort）。正在检查的再点 → 409 `FAQ_RELEASE_EVALUATING`。列表里每个 evaluating 版本带 `evaluation {state running|interrupted, startedAt, progress}`。
- **评测门**（`faqReleaseGate.ts`）：缺省是免费的检索评测 —— 每个入口 answer 节点的中英问题与每一种问法检索那一版快照（生产同一条候选 SQL），recall@8 ≥ 95% 且比当前发布版本低不超过 1 个点；没过的用例至多 50 条写进报告。检索过了再跑**真流程检查**（release check v2，owner 2026-11-06 批准；v1 是 2026-11-03 的 300 道抽样。`faqReleaseModelGate.ts` 组装，`release-check/` 下四块各管一件事：`questions.ts` 问哪些题、`runner.ts` 并发问两个版本与复问、`policy.ts` 判定、`report.ts` 报告）：题目 = dev 集 `release-eval/eval-v6-dev.jsonl` **全部**（2026-11-03，按 v3.5 的 685 张卡重标，不含用户数据：盲出题 blind 275 条，出题模型只看用户情境、没见过卡片，两个模型独立标卡、分歧由更强的模型裁定，指不清的 vague 不收；S650 1,409 条）+ 员工接受过的回归用例（是那张卡自己的问题或问法的不问，记 `regressionLeaked`）+ 追问题（B5：dev 集里标的卡是子卡的题，按 Portal 发追问的样子再问一次：屏幕上开着父卡 `context.nodeId`、也算刚看过，前一句是父卡的问题；只问这一版动过的父卡：父卡、它的子卡的字段或问法、或它下面的边改了；没有上线版本时全部父卡都问）。测试集从不进来。每题在候选版本与上线版本上各走一遍生产同一条流程（`src/ai/helpdesk/release-answerer.ts`：同一个 `HelpdeskSuggestService`，候选钉在那一版快照上，关键词 + 向量召回、精排、小模型选卡作答；先等这一版的向量算好），不写建议表、链路只在内存。**分层缓存**（`contracts/helpdesk-eval-cache.ts`，表 `helpdesk_eval_stage_cache`，迁移 `20261106000000_helpdesk_eval_stage_cache`）：问句向量、精排、模型步各按这一层发出去的请求的 SHA-256 存结果、原耗时与花费，同样的输入不再付钱，命中照原耗时等；14 天后不再用（每次检查开始时顺手删过期的）；`EVAL_CACHE.version` 加一全部作废；线上聊天不用这份缓存。所以没改过的卡的题不花钱，只有输入变了的题真问。自动打分（`contracts/helpdesk-eval-scoring.ts`，和评测脚本同一份）：出的卡是金卡 / 可接受卡 / 入口祖先 = 对；该 no_match 却出卡 = 错；寒暄出卡只记 extraCard；超时算没答上，不算错卡。判定按套件（`policy.ts`）：全部单问与 S650 的错卡率 95% Wilson 上界 ≤ 2%（拦发布）；语言 / 写法切片 ≥ 200 题时点估计 ≤ 2%，不够 200 只看；盲测、追问、改过的卡上的题只看；逐题和上线版本比，新出的错不读缓存再问 2 次，3 次里 2 次错才算真的变差，任何套件（含只看的）有一道就不通过；库里没卡却给了卡 ≤ 3%；没得到回答超过 5%，或漂移抽查（每次 40 道不读缓存重问）变了超过 2 道 → 这次检查不算数。预算 3 美元（到了就停、判不通过）：第一次缓存是空的最贵，之后只付改过的题。报告另有：套件与切片、按轻重排好的问题清单（至多 50）、花费（按层、按版本、缓存命中、省下多少）、收据（模型、题数与题集指纹、缓存版本、门槛）、每张卡进过几道题的候选（`candidatePool`）与平均每道真问的花费（下一版开始前的估计用，`release-check/estimate.ts`）、重复问法（`release-check/collisions.ts`：这一版新加的文字和别的卡上的文字余弦 ≥ 0.95 的至多 30 对，读内存里已有的向量、不调模型；只提醒不拦，两张卡的用户状态信号不同的标 byState）。没有 `OPENROUTER_API_KEY` / 没余额 → 不通过并写明，不悄悄算过。只在 app.module 组装了答题器时开（生产）；`HELPDESK_RELEASE_MODEL_EVAL=off` 关掉；NODE_ENV=test 不组装。
- **运行时的唯一开关**（`faqQaSource.ts` `createPgHelpdeskQaSource`；`FaqService.published` / `publishedOne`）：有发布版本 → Agent 的候选、单条、热门与 Portal 的 FAQ 列表 / 单条都只读那一版（检索走 `helpdesk_faq_release_nodes`，节点、块与边来自快照，按发布行 id 缓存在进程里）；还没有 → 照旧读逐条发布的行。员工改了工作表，学员看到的要等下一次发布。`releaseVersion()` 给 assist log。
- **检索**：候选 SQL 由 `candidatesSql('live' | 'release')` 生成（同一条 SQL，只换表并加版本条件），加了问法一路（英文全文 `phrasing_tsv` + 中文双字，繁体问法也对得上），并支持 `entryOnly`（缺省 true）与节点类型（缺省只要 answer，旧的 Portal 不会渲染 choice）。屏幕上有卡片（`nodeId`）时：先是它的全部子节点（命中的按得分在前），再是它父节点的其它子节点里命中的，最后是普通检索。候选多带 `type`、`entry`、`blocks`、`optionOf`（哪些 choice 节点把它当选项）、`relation`（child / sibling / search）。
- **种子**（`faqLibrarySeed.ts` + 命令行 `npm run seed:helpdesk-faqs -- <library.json> [--employee-id <uuid>] [--no-release]`，脚本在 `eval/helpdesk/`，不进 nest build）：读 v1 / v2 库文件（key、signals、phrasings、parentKey、followUps、choice 的 options、`source: "existing:<id>"` 按 id 认领旧行）→ 经正常的服务层按 key 幂等写入 → 建版本 v1 并发布。不删除库里没有的东西。2026-10-29 的正式库（99 条）在本地临时库上跑过：v1 发布，检索评测 recall@8 100%（198 例），第二次运行 99 条不变、不新建版本。
- **测试**：`helpdesk-faq-graph-checks.spec.ts`（每条规则、冻结、差异、slug）、`helpdesk-faq-graph.pg.spec.ts`（回填、SQL = TS slug、边与修订、成环与并发、上限、重排、归档拒绝、问法与检索、树、发布 / 拒绝 / 重新检查 / 原子发布 / 回滚 / 差异 / 运行时开关 / 子节点优先 / 真检索评测 / 缓存）、`helpdesk-faq-release-gate.spec.ts`、`helpdesk-faq-library-seed.pg.spec.ts`（解析 + 两次导入）、`helpdesk-faq-graph-rbac.spec.ts`、`helpdesk-faqs-service.spec.ts`（节点字段、归档拒绝、开关）。

### 4A.14 聊天面板 v5 的 Agent：寒暄、clarify、三段式答案与 choice 卡片（2026-10-30，`helpdesk-v5-context-chips-and-smalltalk.md` Part B / D / H，`helpdesk-v5-faq-graph-design.md` §4）

- **只对 v5 的 Portal**：请求带 `context`（§4A.12）的 `chat` 走新的 assist 工作流（`src/ai/helpdesk/workflow/assist-workflow.ts`），`chip` 不问模型、开头结尾用模板；提交工单（submit）与不带 context 的请求照旧走 `faq-workflow.ts`，回包与 v5 逐字相同。
- **步骤表**（engine 与 pi-agent-core 都不改，只在 `pi-step-runner.ts` 的工具 spec 里加了三种可选参数：`listArgs` 枚举列表、`textArgs` 短句、`flagArgs` 真 / 假；长度不写进 schema，超了只由守卫回退，不会让整个调用作废；短句在日志里只记长度）：
  - `retrieve`（代码）：屏幕上有卡片时先是它的子节点、再是它父节点的其它子节点、最后是入口节点的普通检索（`entryOnly: true`、`types: [answer, choice]`）；屏幕上那张卡片另取出来，永远可选、排在 faqId 枚举最前。**没有候选也问模型**（寒暄要靠它分类）。
  - `pick_faq`（同一次调用，没有多一次延迟）：`intent`（`SUGGEST_INTENTS`）、`faqId`（候选 / 屏幕上的卡片 / none）、`confidence` sure|unsure、`blocks`（候选答案块 id 的枚举列表；只给可摘录的答案 = >3 块且 >200 字）、`opening` / `closing`（只在选了答案时）、`reply`（只在 greeting / farewell / vague / off_topic 时）。模型只收到学员这句话、之前 ≤3 句原文、屏幕上的卡片与候选，**从不收到学员数据**。
  - 分路（代码）：greeting / farewell / off_topic → `smalltalk`；vague → 话题对得上的 choice 卡片（选中的 choice，或前 3 个候选里 ≥2 个同属的 choice），没有就寒暄；clarify（或选了屏幕上那张卡片）→ `explain`；question / own_account → `route`；someone_else / exception / private_data / instructions → no_match（照旧给 alternatives）；没有屏幕上卡片的 clarify 当普通问题。
  - `route`（代码）：选中 choice → 它；**unsure** → 所选答案所属的 choice 卡片（没选 → 前排候选同属的 choice；屏幕上那张不重复给），学员自己 A/B/C/D；sure → 所选答案（模型确定没有就 no_match，不硬给）。answer 节点：`chooseExcerpt` 核摘录（1–3 个连续、属于所选答案；答案 ≤3 块或 ≤200 字、不合法、全选 → `[]` = 整条），opening / closing 过守卫，不过用模板；choice 节点不加开头结尾（guard null）。
  - `explain`（第二个 agent 步，只在 clarify）：工具 `explain { explanation, covered }`，只给那张卡片的整条答案、追问与之前的原文；→ `ground`（代码）：covered false → clarify `covered:false`，guard `not_covered`；covered 且过接地守卫 → 解释（去掉加粗星号的纯文本）；否则 covered false + 原因（ungrounded、ai_filler…）。explain 超时 / 出错 → covered false + `timeout` / `error`。Portal 对 covered false 显示固定文案 + 转人工卡，计一次没解决。
- **守卫**（`workflow/guard.ts`，纯函数）：短句依次查 missing → markup（Markdown、代码、HTML、换行）→ email → link → digit（任何数字，全角也算）→ too_long（按学员的文字：写了汉字用 zh 上限，否则 en 上限，`GUARD_LIMITS`）→ blocked_phrase（退款、免费、保证、承诺、优惠、价格…与「没找到 / couldn't find / 搜索」类）→ ai_filler（「当然！」「作为 AI」「希望对你有帮助」「我理解你的感受」「Great question」「I hope this helps」…）→ script（学员写汉字回复就得有汉字，写拉丁字母回复里不能有汉字）。比较前 NFKC + 小写 + 繁转简（OpenCC），zh-TW 与 zh-CN 一套词表。解释另查**接地**：每个数字串、链接、邮箱、金额、`**界面文字**` 都必须在那条答案里；承诺类词只在答案本身也写了时允许。固定模板（Part B / H 的原文，zh-CN / zh-TW / en，按学员写的字选；每条自己也过守卫）：寒暄（hello 与 vague 同一句）、谢谢 / 再见、跑题、开头、结尾。
- **回包**：`SuggestTurnFields`（契约 `suggestTurnProblems` 自检），寒暄的 `confidence` 为 null；寒暄与 clarify 没有 alternatives；alternatives 不含屏幕上那张卡片；过了总期限的寒暄 / 解释同样作废（no_match）；`releaseVersion` 来自 `HelpdeskQaSource.releaseVersion()`，读不到为 null。
- **日志**（迁移 `20261030160000_helpdesk_suggestion_turns`，只加列）：`helpdesk_suggestions` 多 `kind`、`intent`、`confidence`、`node_id`（回包的卡片；clarify 时是屏幕上那张，faq_id 为 null）、`blocks`、`guard_result` / `guard_reason` / `guard_fallback`、`covered`、`session_id`、`release_version`，都有 CHECK；从不记模型写的文字。事件日志：`turn/start` 多 `context { nodeId, sessionId, recentTurns: 条数 }`，之前的原文在 `input.recentTurns`；`turn/end` 多 `kind` / `intent` / `confidence` / `nodeId` / `blocks` / `covered` / `guard` / `releaseVersion`，给学员看的短句只在 `turn/end.output`（新的学员原文字段：90 天清空、导出脱敏）；step/end 与 tool/call 里的短句只有长度。
- **评测**（`eval/helpdesk/conversations.ts`，`npm run eval:helpdesk -- --conversations <文件或目录> [--pg …] [--faqs …] [--limit N] [--out …]`）：Part F 的对话集（JSONL，一行一段对话，每轮标期望的 kind：answer faqId / clarify faqId + covered / smalltalk intent / no_match / handover；`{"click": id}` 是点追问 / 选项，不调 Admin）。像 Portal 一样带 context 逐轮问（会话 id、屏幕上的卡片、最近 3 句原文、v4 的转人工关键词与「连续两轮没解决」），报逐轮准确率、答错 FAQ、寒暄意图、clarify 接地、守卫逃逸、守卫回退率，按 set / locale / 语言 / persona / flow 切片；闸门：0 逃逸、接地 100%、答错 ≤2%、寒暄意图 ≥95%（真模型才可能过；语气与摘录覆盖由另外的 LLM 评审打分）。样例 `eval/helpdesk/v5-conversations.sample.jsonl`（8 段，用种子库）。假模型（没有 key）v5 也选第一个候选、不写短句、explain 一律 covered false。
- **CI 的免费检索闸**（`eval/helpdesk/conversations.spec.ts`）：生产候选 SQL（PostgreSQL）跑种子 FAQ 自己的中英问题 + 种子用例，recall@8 ≥ 95%。为此种子评测库（`eval/helpdesk/faqs.json` 与 `qa10k/faqs.json` 的前 14 条，两份一致）补了 4 条 FAQ 的关键词（忘了密码；月付 / 年付；stop paying / 续费 / 停掉；improvement / recommend / 改进 / 意见）：种子用例 recall@8 93.7% → 98.4%（剩下两条错别字用例）。
- **测试**：`workflow/guard.spec.ts`（`fixtures/guard-corpus.json` 语料：zh-CN / zh-TW / en / 中英混写、全角数字、每个原因码；上限边界；接地；模板；fixture v6 的例子）、`workflow/pi-step-runner.spec.ts`（v5 参数，真的 pi + faux provider）、`workflow/engine.spec.ts`（extras）、`helpdesk-suggest.v5.spec.ts`（每种 kind、choice、clarify 的各种失败、chip、无 key、限流、期限、日志与脱敏；另有真的 pi + faux 走两步）、`helpdesk-suggestion.store.pg.spec.ts`（新列与约束）、`eval/helpdesk/conversations.spec.ts`。

### 4A.15 BackOffice 的问题树编辑、树视图、对话预览与发布新版本（2026-10-30，`helpdesk-v5-faq-graph-design.md` §5.1–§5.4；没有 Figma 画板，待视觉验收）

- **FAQ 抽屉的「追问与选项」**（`client/src/backoffice/helpdesk/FaqGraphSection.tsx`）：卡片类型 answer / choice（单选；choice 时答案框是一句提问，前端与服务端同样拒绝数字、链接、邮箱）、入口问题开关、学员情境多选（`FAQ_SIGNALS`，中英标签，按优先级排序）——这三项属于草稿，跟「Save FAQ」一起 PUT。编辑已有 FAQ 时另有立即写入工作副本的部分：子节点列表（choice 显示 A/B/C/D；拖动或上移 / 下移按钮排序 → `PUT …/edges/order`；改显示文字，两种语言要么都填要么都空，选项 ≤24 / 40、追问 ≤200 → `PUT /faq-edges/:id`；移除 → `DELETE`）、「添加已有问题」（搜索，自己不出现、已连的标「已添加」）、「新建追问 / 新建选项」（新建一条同分类、非入口的 answer FAQ 再连上，带 Idempotency-Key）、到上限（选项 4、追问 6）时两个按钮禁用；学员的问法（en-GB / zh-CN / zh-TW，≤200 字，至多 30 种；来源 flywheel / seed 标出）。新建 FAQ 时只显示三项草稿字段与「先保存再添加」。错误码都有中英文案（`FAQ_EDGE_CYCLE`、`FAQ_HAS_PARENTS`…）。
- **问题树**（`FaqTreeDrawer.tsx`，FAQs 表格每行「问题树」，VIEW 也能开）：`GET …/tree` 的缩进大纲，根与第一层展开，逐个展开 / 收起（按钮 `aria-expanded`）与全部展开 / 收起；选项标 A/B/C/D，覆盖文字与问题不同时两者都显示；共享节点标「也出现在 N 处」并列出另外的父问题；图检查的提醒（层级、孤立、缺语言…，按规则本地化）挂在节点下；环与超深分支标出。
- **对话预览**（`FaqChatPreview.tsx`，问题树抽屉的第二个 Tab）：`GET /api/helpdesk/faq-releases/preview?locale=` 取工作副本的 Portal 投影，`client/src/backoffice/lib/helpdeskGraph.ts` `previewTurn` 按 Portal 点击时的规则渲染：answer = 固定开场「好的，这个问题可以这样处理：」/「Here's how to sort this out:」→ 引用卡片「来自：<问题>」+ 整条答案 → 固定结尾 →「你可能还想问：」至多 4 个追问（多出的条数提示员工）；choice = 提问 + A/B/C/D 按钮；只用边种类对、子节点在的边。EN / 中文切换（学员点过的路径保留），可选起点（入口节点，热门在前），重新开始。不模拟打字提问（那要问模型）。
- **版本发布**（`FaqReleasesDrawer.tsx`，FAQs Tab 页头「版本发布」）：当前上线版本；工作副本相对它的差异（问题 / 连接的新增、修改（列出字段）、移除，问法增减）与图检查（问题按 key + 规则文案）；「发布新版本」（FULL）→ `POST /faq-releases`，提示「已创建 vN」或「没有改动」；版本历史（状态、发布 / 创建时间、检查与评测 recall@8、没命中的用例数、每个版本的改动）；「发布 vN」与「回滚到此版本」都先确认，「重新检查」不需要；按钮只在服务端会成功时出现（`releaseActions`）。VIEW 只看。 2026-11-03：按钮改叫「生成新版本」（它只生成版本、不上线）；抽屉开着时一直连着版本列表的长连接（owner 2026-11-03「端口应该常连」：`GET /api/helpdesk/faq-releases/stream`，SSE，权限同列表 VIEW；`faqReleaseStream.ts`：连上先推一次，`FaqReleaseService.onChange` 在开始 / 进度 / 结果 / 发布时立刻推，服务端另外对数据库补查（有版本在检查时 3 秒、没有时 30 秒，只在列表变了才推），以覆盖跑在别的实例上的检查与心跳停了变「检查中断」；每 20 秒一行注释防负载均衡断开；断了 EventSource 按 retry 3 秒重连），浏览器不定时重读；结果栏显示进度（「检查中：真流程检查 120 / 1696」），出结果后多一行「真流程检查通过：错卡 0.5%，1684 题，约 ¥0.44」（没过时带原因）；「生成新版本」下面先显示估计（`GET /api/helpdesk/faq-releases/working` 带 `estimate`，服务端按上线版本那次检查的 `candidatePool` 与平均每道真问的花费估，不调模型：「预计问 1696 道题（单问 1684、追问 12）；约 91 道要真问，约 ¥0.33（上限 ¥22）」；没有可参考的检查只给题数和上限）；v2 检查出结果后每一行有「检查详情」，展开是一个模块 5 个页签（`FaqCheckReport.tsx`：套件、切片、问题、花费、重复问法），内容区限高自己滚动，不加长页面；套件没过的原因按界面语言由套件的规则与报告收据里的门槛写出（待视觉验收）；心跳停了状态显示「检查中断」+ 提示，可「重新检查」。锁定：`tests/helpdesk-graph-ui.test.tsx`、浏览器 E2E `e2e/helpdesk-releases.e2e.test.mjs`（真 EventSource，含重连、打开后不再读列表）、`helpdesk-faq-release-stream.spec.ts`、`helpdesk-faq-graph-rbac.spec.ts`（HTTP 层 SSE）。
- **测试**：`client/tests/helpdesk-graph.test.ts`（重排、文字与问法校验、大纲、预览的三段式与模板、≤4 个追问、起点、版本操作、每条规则与状态都有中英文案）、`client/tests/helpdesk-graph-ui.test.tsx`（经 HelpDeskPage 与假的 BackOffice Server：上面每个流程，含拖动、VIEW 只读、Escape）、`helpdesk-faqs.test.ts`（草稿的 type / entry / signals、choice 提问校验）；服务端 `helpdesk-faq-graph.pg.spec.ts`（preview：工作副本与版本、语言、错误）与 `helpdesk-faq-graph-rbac.spec.ts`（preview 是 VIEW 的读接口，不被当成版本号）。

### 4A.16 v5 终检修复（2026-10-30；推送等 FKO 扩写与剩下的真实测试都做完再一起推 V4，2026-10-29 用户）

- **事件日志清空**（新迁移 `20261030170000_helpdesk_agent_events_purge_turn_end`，只替换触发器函数）：90 天清空学员原文时，`turn/end` 只准去掉 `output` 一个字段（`NEW.data = OLD.data - 'output'`），改别的字段仍被只追加触发器拒绝。
- **守卫加严**（`workflow/guard.ts`，语料 `fixtures/guard-corpus.json` 多约 46 条）：比较前再去掉 `\p{Cf}` 隐形字符（零宽、方向控制；短句与解释里出现即 `markup`）、去重音（NFKD 去 `\p{Mn}`）、弯引号变直、汉字之间的空白去掉；用文字写的数量（中英数词 + 时间或钱的单位：「十四天」「两个工作日」「fourteen days」「a few minutes」）短句里算 `digit`，解释里必须在答案里出现；承诺类（一定、马上、已为你、I will make sure、definitely、right away…）并入挡词；拉丁词按整词加常见后缀匹配（free 不再挡 freeze）；任何「点 + ≥2 个字母」的主机名都算链接；解释里的邮箱与链接按整串比对答案（去掉协议、www. 与末尾斜杠），「搜索 / 检索」与承诺词只有答案本身写了才放行。已知限制：序数词（第二步）不挡。
- **发布门**（`faqReleaseGate.ts` / `faqReleaseService.ts` / `faqGraphRepository.ts`）：回滚版本的 recall 跟着 `sourceReport` 找原报告（至多 10 层）；没有入口 answer 的版本不通过；报告多 `baselineVersion`（评测时对比的上线版本）。发布在 `RELEASE_LOCK` 里读当前上线版本：版本号比上线的旧，或 `baselineVersion` 与上线的不同（回滚除外）→ 409 `FAQ_RELEASE_STALE`（先「重新检查」）。两个版本同时发布：一个成功，另一个 409。
- **归档与连接的竞态**（`faqRepository.ts`）：归档先 `FOR UPDATE` 锁住这条，再查已发布的父节点，有就 409 `FAQ_HAS_PARENTS`；BackOffice 的删除提示列出这些父节点的问题（`FaqDrawer.tsx`，待视觉验收）。
- **候选**（`faqQaSource.ts` `CANDIDATE_NEAR`）：屏幕上那张卡片的子节点最多 4 个没打分的进候选，检索结果至少留 4 个位置。
- **种子**（`faqLibrarySeed.ts`）：key 认领不到时按英文问题（去空白、小写）认领唯一、没被别的 key 用的旧行，并在报告里写一条警告；命令行参数严格解析（`parseSeedArgs`，不认识的参数退出码 2），报告有失败退出码 1（`seedExitCode`）。已知限制：种子不删除、不重排已有的连接。
- **BackOffice 可访问性**（待视觉验收）：问题树改成嵌套的 `<ul>`（每层有 `aria-label`，选项字母读作「选项 A：」）；问题树编辑每个操作后焦点落到合理的位置，并在 `aria-live="polite"` 里播报（已添加、已新建、已移除、已保存文字、已移动、问法增删）；版本发布的确认取消后焦点回到打开它的按钮。


---

### 4A.17 分级小模型方案是缺省（2026-11-03，owner：「默认模型这里都要改」「推到线上也是要用我们的最新方案」）

代码缺省就是这一套，部署只要 `OPENROUTER_API_KEY`；缺省值集中在 `server/src/contracts/helpdesk-defaults.ts`（Agent 与 BackOffice 两边都读），环境变量只用来临时换掉某一层，设成 `off` 关掉那一层（见 §8）。

| 层 | 做什么 | 缺省 | 变量 |
|---|---|---|---|
| L1 召回 | 字词检索 ∪ 向量前 10；平铺，所有已发布答案卡都参与，边只给显示（追问 chip、选项卡）；向量与精排还按「上一句 → 这一句」再查一次，取高分 | bge-m3、平铺、带上一句 | `HELPDESK_EMBED_MODEL`、`HELPDESK_SEARCH_SCOPE`、`HELPDESK_QUERY_CONTEXT` |
| L2 精排 | 召回池精排，留前 5 张；第一名 ≥ 0.816 且领先 ≥ 0.05 → 直接给卡，不调模型 | Voyage rerank-2.5-lite | `HELPDESK_RERANK_MODEL`、`HELPDESK_RERANK_KEEP`、`HELPDESK_RERANK_DIRECT` |
| L3 小模型 | 挑卡、解释、寒暄（只分类 / 抽取，参数枚举锁定；守卫不过 → 退回固定流程） | gemma-4-31b，不开思考 | `HELPDESK_SUGGEST_MODEL`、`HELPDESK_SUGGEST_THINKING` |

- 所有调用经 OpenRouter，按价格选最便宜的提供方（`provider.sort = price`）；BackOffice 的「AI 按指令改卡」与缺口挖掘用同一个 L3 模型。
- 向量：发布新版本时自动算；服务启动时把线上版本缺的向量补上（按文本哈希，算过的不再算，写入 `ON CONFLICT DO NOTHING`），部署不用手动跑 `helpdesk:faq-vectors`。向量或精排失败、超时 → 退回字词检索 / 原顺序，学员照样拿到候选。
- 模型输出健康：近 60 分钟任一步非法调用、被守卫退回或出错超过 5%（至少 20 次）→ 日志 WARN `model_output_degraded`；`GET /api/helpdesk/agent-runs/health?hours=24` 可查。不做页面（PRD 没有设计）。
- 依据（v3.3 卡库 685 张，2026-11-03 终测，Claude 盲评，是 AI 评不是人工）：错卡 S650 test 0.19% / 多轮 0.91% / 闲聊 1.20%；每答 ¥0.0010 / 0.0023 / 0.0019；p50 / p95 1.2 / 3.6 秒、2.4 / 5.6 秒、2.2 / 4.7 秒。多轮集用于诊断过，数字偏乐观。

### 4A.18 其它 Helpdesk 文档（2026-11-05）

- 数据飞轮、FAQ 候选与审核（含 `faq-candidates/:id/review`、`faq-map`）、HelpDesk 数据页（趋势图、每日工单数）：[Helpdesk_Data_Flywheel.md](Helpdesk_Data_Flywheel.md)。
- FAQ 修改记录（Change Log 标签、改动详情、每张卡的历史）：[Helpdesk_FAQ_Change_Log.md](Helpdesk_FAQ_Change_Log.md)。
- Portal 一侧（学员页、聊天面板、Help Centre、迁移 017–026）：Portal 仓库 `docs/phase1/helpdesk-tickets.md`，先看它的 §0「Current state」。

---

## 5. API 接口规范

### 5.1 知识库相关接口

#### 5.1.1 课程 CRUD

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/courses | 获取所有 Course 列表 |
| GET | /api/courses/:id | 获取单个 Course（含下属 Pages） |
| POST | /api/courses | 创建 Course |
| PUT | /api/courses/:id | 更新 Course |
| DELETE | /api/courses/:id | 删除 Course（级联删除 Page） |

> **删除保护（2026-10-14 拍板）**：Course 下已存在 Release 历史版本时拒绝删除，返回 409 `CONFLICT`。

#### 5.1.2 页面 CRUD（2026-10-16 扁平化：原 Lesson 端点删除，Page 直接挂 Course）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/courses/:courseId/pages | 在指定 Course 下创建 Page |
| GET | /api/pages/:id | 获取单个 Page（含 contentMd、sectionTags） |
| PUT | /api/pages/:id | 更新 Page（标题、contentMd、sectionTags、排序） |
| PUT | /api/courses/:courseId/pages/reorder | 批量重排 Course 下 Page 顺序：body `{ orderedIds: string[] }`（须为该 Course **全部** Page id 的一个排列）；事务内按数组下标重写 `sortOrder`（2026-10-19 新增，左侧树拖拽排序用） |
| DELETE | /api/pages/:id | 删除 Page |

> **批量排序接口校验**：`orderedIds` 必须无重复、且集合等于该 Course 现有全部 Page id，否则 400 `VALIDATION_ERROR`；`courseId` 不存在返回 404。
>
> 原 `POST /api/courses/:courseId/lessons`、`PUT/DELETE /api/lessons/:id`、`PUT /api/lessons/:id/reorder`、`POST /api/courses/:lessonId/pages` 已删除（2026-10-16；`reorder` 语义于 2026-10-19 以 Course 级批量排序接口重建）。

#### 5.1.3 发布与版本

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/courses/:id/release | **纯快照**：创建 Course 快照（需 revisionNotes；快照仅含 SYNCED 节点）；**置 `Course.editingReleaseId` = 该新版本**；**不改动 `currentReleaseId`/`aiTestReleaseId`**（2026-10-20 由「发布即激活」改拍，§3.4.3） |
| GET | /api/courses/:id/releases | 获取 Course 的所有 Release 历史（含 `isActive`=是否 Live、`isTestSelected`=是否后台测试所选、`isEditing`=是否当前编辑版本，2026-10-20 加；2026-10-15 加 isActive） |
| GET | /api/releases/:releaseId | 获取某个 Release 的快照详情 |
| DELETE | /api/releases/:releaseId | **删除版本**（2026-10-20 新增，§3.4.5）：Live 版本或后台测试所选版本返回 409 `CONFLICT`；级联删除其 AI 配置；**若为当前编辑版本则清空 `Course.editingReleaseId`** |
| POST | /api/courses/:id/activate-release | **恢复历史快照到可编辑草稿**：`{ releaseId }`；事务内以该快照重建 Page 草稿树，**置 `Course.editingReleaseId` = 该版本**，**不改 `currentReleaseId`**（2026-10-20 二次/三次改拍，§3.4.2） |
| POST | /api/courses/:id/set-live | **设为上线版本（轻量）**：`{ releaseId }`；仅更新 `Course.currentReleaseId`，**不重建/覆盖 Page 草稿**（2026-10-20 新增，§3.4.4；与 activate-release 的区别） |

#### 5.1.4 同步接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/sync/external-courses | 列出同步目标课程（映射表课程 ∪ 本地带 externalId 的课程，含同步状态：未同步/已同步/有更新），供选择器 |
| POST | /api/sync/structure | 同步课程标题 + 课时标题，body `{ externalId }`；正文不动 |
| POST | /api/sync/all | 正文同步已禁用（2026-10-22）：返回 400 `CONTENT_SYNC_DISABLED` |

> 同步语义详见 §3.2.2。2026-10-26 起数据源为 KS 内置课程 ID 映射表（`server/src/sync/course-registry.ts`），**不再需要 `PORTAL_API_BASE_URL` / `PORTAL_API_TOKEN`**，也不再运行时访问 Portal 目录接口。

#### 5.1.5 文件上传（2026-10-15 新增；同日按 §3.2.3 弹窗设计改为仅转换不建页）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/files/convert | multipart：`file`（白名单+≤15MB，§10.1）；本地转 Markdown（markitdown-ts 为主；`.xls`→SheetJS `xlsx`、`.doc`→`word-extractor`、单文件 UTF-8 `.tex`→保守 LaTeX 转换），返回 `{ title, markdown }`；**不建页**——用户在弹窗预览确认后经 §5.1.2 `POST /api/courses/:courseId/pages` 建页；校验/转换失败 400 |

> 原 `POST /api/files/upload`（转换+建页一步完成）已废弃（2026-10-15），被两步流程取代。

#### 5.1.6 全局 Tag 词库（2026-10-16 方案 B 轻量版）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/tags | 列出所有 tag（name、color），供 TagManager AutoComplete 联想（TagManager 入口自 2026-10-29 起暂时下线，接口与词库保留） |
| POST | /api/tags | 创建 tag：`{ name }`；name 已存在则返回已有记录；新 tag 颜色由后端自动分配（按 name 哈希到预设色板） |

### 5.2 AI 相关接口

> **2026-10-20 按 Release 维度改拍**：AI 配置（§4.2.5）与「测试所选 Release」均按 Release 组织。`GET/PUT config` 与 `reset` 默认作用于该 Course 的**测试所选 Release**（后端解析：`Course.aiTestReleaseId` ?? `Course.currentReleaseId`）；`AiConfigView` 返回 `releaseId` / `releaseTag` / `isLive`（测试所选 Release 是否为上线版本）/ `online`（Course 级）。学生端仍只读上线版本。

> **2026-10-20 二次改拍：AI 配置再按模式维度**（用户裁决，修复「保存后切换 Lecture/Socratic 不再更新」）：System Prompt / Welcome Message / LLM Model 三者按模式分开存储。`AiConfigView` 改为返回**按模式分组**的视图（见下）；`PUT config` 与 `reset` 均需携带 `mode`，只作用于**该模式**那一份。

`AiConfigView`（`GET config` / `PUT config` / `reset` / `active-release` / `online` 的返回）：
```json
{
  "courseId": "string",
  "releaseId": "string | null",
  "releaseTag": "string | null",
  "isLive": false,
  "online": false,
  "llmProvider": "openrouter",
  "hasApiKey": false,
  "lecture":  { "systemPrompt": "string | null", "welcomeMsg": "string | null", "model": "string" },
  "socratic": { "systemPrompt": "string | null", "welcomeMsg": "string | null", "model": "string" }
}
```
> `lecture/socratic` 下的 `systemPrompt` / `welcomeMsg` 为**自定义覆盖值**（null = 未自定义，前端回退该模式模板默认值）；`model` 为**该模式生效模型**（自定义 ?? `AI_AVAILABLE_MODELS[0]`）。

`PUT /api/ai/config` 请求体（**新增 `mode`，只写该模式**）：
```json
{
  "courseId": "string",
  "mode": "LECTURE | SOCRATIC",
  "llmProvider": "openrouter",
  "systemPrompt": "string | null",
  "welcomeMsg": "string | null",
  "llmModel": "string",
  "apiKey": "string?  // 省略=不变，空串=清除"
}
```

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/ai/chat-stream | 流式 AI 对话（SSE 响应）；后端按该 Course 的**测试所选 Release** 解析知识库快照 |
| GET | /api/ai/models | 获取可用的 LLM 模型列表（数据源 `AI_AVAILABLE_MODELS` env） |
| GET | /api/ai/prompts | 获取默认 PromptTemplate 列表（仅 `isDefault=true`；**2026-10-26：库中缺失的模式按 `src/ai/prompts/` 文件默认值合成返回**，只读不写库；字段 `id` / `mode` / `systemPrompt` / `welcomeMsg` / `isDefault`） |
| PUT | /api/ai/config | 保存某（课程 × 测试所选 Release × **模式**）的 AI 配置（body 含 `mode`，只写该模式的三项值 + 共享 llmProvider/llmBaseUrl/apiKey） |
| GET | /api/ai/config/:courseId | 获取某 Course 的 AI 配置（apiKey 脱敏，绝不返回明文；含 `releaseId`/`releaseTag`/`isLive` 用于对话头部展示；含 `online` 用户侧开放状态；System Prompt / Welcome / Model **按模式分组**返回，见上方 `AiConfigView`） |
| POST | /api/ai/config/:courseId/reset | 重置测试所选 Release 的**当前模式**（body `{ mode }`）配置为默认 |
| PUT | /api/ai/config/:courseId/active-release | **设置测试所选 Release**：body `{ releaseId }` → 持久化 `Course.aiTestReleaseId`，返回最新 `AiConfigView`（2026-10-20 新增，§4.3.1） |
| PUT | /api/ai/config/:courseId/online | 设置某 Course 的 Online 状态（开关即时生效，body `{ online: boolean }`，返回最新 AiConfigView；写 `Course.aiTutorOnline`；§4.2.6） |
| GET | /api/ai/tutors | 列出全部 AI Tutor（Course）及名称 / Online 状态（读 `Course.aiTutorOnline`，供「管理所有 online」弹窗，§4.2.6） |
| GET | /api/user/ai-tutors | 用户侧读取 AI Tutor 可用性列表（2026-10-22 实现）：返回所有有 `externalId` 的课程，字段 `online` / `available`；无缓存 |
| GET | /api/user/ai-tutors/:externalId/welcome?locale= | 用户侧读取某课程两种模式的欢迎语（2026-10-23 支持 locale）：返回 `{ lecture, socratic }`；默认模板按 locale 读取 `src/ai/prompts/welcome.yaml`，只读上线 Release，不返回 System Prompt |
| POST | /api/user/ai/chat-stream | 用户侧流式对话（2026-10-22 新增）：body `{ externalCourseId, message, mode, locale, history }`；强制 Online + 只读 `currentReleaseId`（详见 §4.4.1） |

> **边界**：Course 尚无任何 Release 时，`GET config` 返回模板默认值（`releaseId`/`releaseTag` 为 null、`isLive=false`）；此时 `PUT config`/`reset` 返回 400（无 Release 可绑定），前端提示「请先创建 Release」。
>
> 对话记录接口（GET/POST/DELETE `/api/ai/sessions`）不实现（2026-10-14 拍板：对话不落库，见 §4.3.2），待长期持久化启用后再补。

### 5.3 统一响应格式

所有 API 响应统一使用以下格式：

```json
{
  "success": true,
  "data": { ... },
  "error": null,
  "message": "操作成功"
}
```

错误时：

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "参数校验失败"
  }
}
```

### 5.4 HelpDesk 工单接口（2026-10-28 新增，§4A；同日按 Figma addendum 更新）

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | /api/helpdesk/tickets?status=&category=&tag=&q=&cursor=&limit= | helpDesk VIEW | `status` ∈ `all`（缺省）/ `needs_reply` / `OPEN` / `ASSIGNED` / `WAITING_USER` / `PENDING_CONFIRM` / `CLOSED` / `CANCELLED`；`category` 为四个 Enquiry Type；`tag` ≤32；`q` ≤120；`limit` 1–100（缺省 30）；返回 `{ tickets: (TicketSummary & { needsReply })[], nextCursor, counts }` |
| GET | /api/helpdesk/tickets/:ticketId | helpDesk VIEW | TicketDetail（含内部备注、附件、事件时间线、`student`、`subscription`）+ `needsReply` + `available: { claim, reply, internalNote, proposeResolution, tag, markRead }` |
| POST | /api/helpdesk/tickets/:ticketId/messages | helpDesk FULL | body `{ body, internal, expectedSequence }`，头 `Idempotency-Key`（UUID）；Server 注入 `agent`；返回最新 TicketDetail |
| POST | /api/helpdesk/tickets/:ticketId/actions | helpDesk FULL | body `{ action: "claim" \| "propose_resolution" \| "add_tag" \| "remove_tag" \| "mark_read" \| "flag" \| "unflag", expectedSequence, tag? }`（v2：`flag` / `unflag` 必带 expectedSequence）（`mark_read` 可不带 expectedSequence，前端总是带上，Portal 只在工单 sequence 未超过它时清未读；标签动作必带 `tag`），头 `Idempotency-Key`（UUID）；Server 注入 `agent`；返回最新 TicketDetail |
| GET | /api/helpdesk/attachments/:attachmentId | helpDesk VIEW | 代理 Portal 附件（png / jpeg / webp / gif 内联；pdf / txt / csv / docx / xlsx 以 `Content-Disposition: attachment` 下载；txt / csv 转发 Portal 标的 charset（只认 `utf-8` / `utf-16le` / `utf-16be`；GBK 等旧编码 Portal 不标，这里也不标，绝不自补 utf-8）；≤ 10 MB），`Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'` |
| GET | /api/helpdesk/tickets?learnerId=&limit=10 · ?flagged=true | helpDesk VIEW | v2：学员时间线（`learnerId` ≤128 字、无控制字符）与「Flagged」筛选（只接受 `true`，其它值 400）；原样转给 Portal。列表行带 `flagged`、`available` |
| GET | /api/helpdesk/faqs?category=&popular=true\|false&q=&page=&pageSize= | helpDesk VIEW | v2 FAQs 列表（不含已删除 = 归档）；`pageSize` 缺省 10、最大 50；返回 `{ faqs, total, page, pageSize }` |
| GET | /api/helpdesk/faqs/:id · /:id/revisions | helpDesk VIEW | 单条 FAQ（归档或不存在 404 `FAQ_NOT_FOUND`）；修订记录新的在前 |
| POST | /api/helpdesk/faqs | helpDesk FULL | body `{ category, popular, questionEn, answerEn, questionZh, answerZh, keywords[] }`，可带 `Idempotency-Key`（同 key 不同内容 422 `IDEMPOTENCY_KEY_REUSED`）→ 201 FAQ（保存即发布） |
| PUT | /api/helpdesk/faqs/:id | helpDesk FULL | 同上 body + `version`；内容与当前一致时原样返回（幂等：丢响应后的重试、没改动的保存不升版本、不写修订）；内容不同且版本不符 409 `VERSION_CONFLICT` |
| POST | /api/helpdesk/faqs/:id/archive | helpDesk FULL | body `{ version }`；Delete FAQ = 归档，幂等；还有已发布的父节点在用 → 409 `FAQ_HAS_PARENTS`（v5 §4A.13；与新建连接同时发生时也一样，§4A.16） |
| POST / PUT | /api/helpdesk/faqs · /:id（v5 节点字段） | helpDesk FULL | §4A.13：body 可多带 `key`（小写字母数字 . _ -，≤80；撞了 409 `FAQ_KEY_TAKEN`；新建不带 = 英文问题的 slug）、`type` answer\|choice、`entry`；不带就保留原值 |
| GET | /api/helpdesk/faqs/:id/edges · /:id/edge-revisions · /:id/tree | helpDesk VIEW | §4A.13：`{ children: [{ edge, node, label }], parents }`；边的修订（新的在前）；从该节点展开的树 `{ root: { node, edge, label, depth, parentCount, alsoAppearsIn, warnings, cycle, truncated, children }, nodes }` |
| POST | /api/helpdesk/faqs/:id/edges | helpDesk FULL | body `{ childId, kind?, labelEn?, labelZh?, position? }` → 201 新建 / 200 已有同样的边；409 `FAQ_EDGE_EXISTS` / `FAQ_EDGE_CYCLE` / `FAQ_TOO_MANY_CHILDREN` / `FAQ_ARCHIVED` |
| PUT | /api/helpdesk/faqs/:id/edges/order | helpDesk FULL | body `{ childIds }`（必须正好是现有子节点，否则 409 `FAQ_CHILDREN_CHANGED`） |
| PUT · DELETE | /api/helpdesk/faq-edges/:edgeId | helpDesk FULL | PUT body `{ labelEn, labelZh }`（null = 用子节点的问题；两种语言要么都给要么都不给）；DELETE 幂等 `{ deleted, edge }` |
| GET · POST | /api/helpdesk/faqs/:id/phrasings | helpDesk VIEW / FULL | `{ phrasings }`；POST body `{ locale: en-GB\|zh-CN\|zh-TW, text ≤200, source?: staff\|flywheel }` → 201 / 200 已有；每条至多 30 种 |
| DELETE | /api/helpdesk/faq-phrasings/:id | helpDesk FULL | 幂等 `{ deleted }` |
| GET | /api/helpdesk/faq-releases · /working · /diff?head=&base= · /:version · /:version/diff?base= | helpDesk VIEW | 历史 `{ releases, published }`（每个带 `checks`、`evalReport`、`publishable`）；工作表的检查与和当前发布版本的差异；差异 `{ base, head, diff: { nodes, edges, phrasings, same } }` |
| POST | /api/helpdesk/faq-releases · /:version/check · /:version/publish · /:version/rollback | helpDesk FULL | 新建（201；工作表没变 200 返回已有的）、重新检查、发布（只有 publishable 的，否则 409 `FAQ_RELEASE_NOT_READY`；评测之后上线版本变了 409 `FAQ_RELEASE_STALE`，§4A.16；幂等）、回滚（201 新版本并发布；已是它 200；没上线过的 409 `FAQ_RELEASE_NOT_PUBLISHED`） |
| GET | /api/helpdesk/faq-releases/preview?locale=en-GB\|zh-CN&version= | helpDesk VIEW | §4A.15「对话预览」：工作副本（缺省）或某个版本的快照，按 Portal 读 faq-release/current 的同一个投影 `{ source: 'working'\|<版本号>, published, locale, nodes, edges }`（答案块、解析好的边文字）；locale 不对 400 `INVALID_INPUT`，版本不存在 404 `FAQ_RELEASE_NOT_FOUND`；什么都不写 |
| GET | /api/helpdesk/agent-runs/:runId | helpDesk VIEW | 2026-10-29，§4A.11：`{ runId, parentRunId, chain, events }`（导出副本，学员原文脱敏），`Cache-Control: no-store`；不存在或 id 不合法 404 `AGENT_RUN_NOT_FOUND`；没有写接口 |
| GET | /api/helpdesk/agent-runs/:runId/events/:seq | helpDesk VIEW | `{ event, sources, derived }`；`seq` 须为正整数（否则 400 `INVALID_INPUT`），不存在 404 `AGENT_EVENT_NOT_FOUND` |

### 5.5 Helpdesk 集成接口（Portal → Admin，2026-10-28，§4A.9）

| 方法 | 路径 | 角色 | 说明 |
|------|------|------|------|
| GET | /api/integration/helpdesk/faqs?locale=&popular=&category=&q=&limit= · /faqs/:id?locale= | admin | v2：`{ faqs: [{ id, category, popular, question, answer, updatedAt }], etag }`（按 `locale` 取中文或英文；`limit` ≤100），头 `ETag` + `Cache-Control: no-cache`，`If-None-Match` 命中 304；problem code `invalid_request` / `not_found` |
| POST | /api/integration/helpdesk/suggest | agent | v2 body `{ learnerId, locale, source?: "submit" \| "chat" \| "chip", category?, subject?, message, faqId?, runId?, parentRunId? }`（2026-10-29：`runId` 为 Portal 生成的 UUIDv7，给了就作为 suggestion id；`parentRunId` 串起同一对话，§4A.11） → `{ suggestion: { id, faqId, question, answer } \| null, alternatives: { faqId, question }[] }`；`chip` 必带 `faqId`、不调模型；submit 每学员每小时 10 次，chat + chip 共 30 次。v3（2026-10-29，加字段，旧 Portal 不读）：`alternatives`（你可能想问，0–3 个）只在 `suggestion` 为 null 时可能非空，限流 / 调用方已断开为 `[]`；可选 `shownFaqIds`（≤ 20 个 UUID，这段对话里刚给学员看过的 FAQ）不会出现在 alternatives 里 |
| GET | /api/integration/helpdesk/faq-release/current?locale=en-GB\|zh-CN | admin | v6（§4A.12；2026-10-30 起读真实的发布表，§4A.13）：当前已发布的 FAQ 问题树 `{ version, publishedAt, locale, nodes: [{ id, key, type, entry, category, popular, question, answer, blocks: [{ id, text }], signals }], edges: [{ parentId, childId, kind, position, label }] }`，头 `ETag: "v<version>"` + `Cache-Control: no-cache`；`If-None-Match` 命中 304；还没有发布版本 404 `no_release`；locale 不对 400 `invalid_request`。FAQ 列表与单条另多 `signals`。推荐请求可带 `context: { nodeId?, sessionId?, recentTurns? (≤3，每条 ≤500) }`，带了回包才多 `kind` / `intent` / `confidence` / `nodeId` / `blocks` / `opening` / `closing` / `reply` / `explanation` / `covered` / `guard` / `releaseVersion` |
| POST | /api/integration/helpdesk/suggest（v5 回包） | agent | §4A.14：带 `context` 的 `chat` / `chip` 回包在 `suggestion` / `alternatives` 旁多 `kind` answer\|smalltalk\|clarify\|no_match、`intent`、`confidence`、`nodeId`、`blocks`（摘录块 id，`[]` = 整条）、`opening` / `closing`（answer 节点必有：过了守卫的模型短句或固定模板；choice 节点 null）、`reply`（smalltalk）、`explanation` + `covered`（clarify；covered false 时 explanation null）、`guard { result, reason, fallback }`、`releaseVersion`；寒暄与 clarify 的 `alternatives` 为 `[]` |
| POST | /api/integration/helpdesk/suggestions/:id/outcome | agent | body `{ outcome }`：submit 取 `solved` / `declined` / `edited`，chat / chip 取 `helpful` / `not_helpful`（不匹配 400 `invalid_request`）→ `{ id, outcome, changed }`（首个为准） |

鉴权均为 `Authorization: Bearer ADMIN_HELPDESK_TOKEN`，错误为 problem+json。Portal 的每次调用带 W3C `traceparent` 头（可选，不合法时 Admin 重开 trace，§4A.11）。

> 对应 Portal 集成接口：`GET/POST /api/integration/helpdesk/tickets…`、`GET /api/integration/helpdesk/attachments/:id`（Portal 侧成功体为纯 JSON、错误为 RFC 9457 problem+json）；BackOffice 对浏览器仍用 §5.3 统一信封。

---

## 6. 前端架构

### 6.1 项目结构

```
client/
├── src/
│   ├── theme/
│   │   └── tokens.ts             # 设计 Token 单一来源（颜色/间距/字号/圆角/字重）
│   ├── components/
│   │   ├── layout/               # 布局组件
│   │   │   ├── Sidebar.tsx       # 左侧目录树
│   │   │   ├── Header.tsx        # 顶部导航
│   │   │   ├── ModuleNav.tsx     # 模块导航列
│   │   │   └── MainLayout.tsx
│   │   ├── knowledge/            # Knowledge System 组件
│   │   │   ├── CourseTree.tsx
│   │   │   ├── SearchBox.tsx
│   │   │   ├── SyncButtons.tsx
│   │   │   ├── PageEditor.tsx
│   │   │   ├── TagManager.tsx
│   │   │   ├── PublishPanel.tsx
│   │   │   └── UploadDocumentModal.tsx
│   │   ├── ai/                   # AI Tutor 组件
│   │   │   ├── ConfigPanel.tsx
│   │   │   └── ChatWindow.tsx
│   │   └── ui/                   # UI 封装层（Figma 迁移单一替换点；业务组件一律从此导入）
│   │       ├── index.ts          # barrel 统一出口
│   │       ├── Button.tsx  Card.tsx  Input.tsx  Select.tsx  Tag.tsx
│   │       ├── Modal.tsx  Table.tsx  Tree.tsx  Tabs.tsx  Segmented.tsx
│   │       └── Avatar.tsx  Typography.tsx  Layout.tsx
│   ├── pages/
│   │   ├── KnowledgeSystem.tsx   # 知识库主页
│   │   └── AITutor.tsx           # AI Tutor 主页
│   ├── stores/
│   │   ├── knowledgeStore.ts     # Knowledge 状态管理
│   │   └── aiStore.ts            # AI 状态管理
│   ├── api/
│   │   ├── knowledge.ts
│   │   ├── ai.ts
│   │   └── client.ts             # axios 实例配置
│   ├── App.tsx                   # ConfigProvider 注入 tokens 到 antd theme
│   ├── index.css                 # 全局样式 + CSS 变量（供第三方库覆盖）
│   └── main.tsx
├── package.json
└── vite.config.ts
```

> **Phase 4 实装注记（2026-10-14）**：本轮实装 layout/ 与 knowledge/ 组件、pages/KnowledgeSystem.tsx、api/ 与 stores/knowledgeStore.ts。`ai-tutor/` 组件与 `pages/AITutor.tsx`、`api/ai.ts`、`stores/aiStore.ts`、`hooks/useAI.ts` 属 Phase 6；`hooks/` 其余文件与 `utils/` 未建——zustand store 直接承载状态与动作（标准用法，hooks 薄包装属重复抽象），版本号生成由后端完成（§3.4.3 第 4 步），Markdown 渲染由 @uiw/react-md-editor 承担，前端无对应工具需求。dev 环境 `/api` 经 vite.config.ts 代理至后端 :3000。

> **UI 抽象层与设计 Token（2026-10-16 新增，为 Figma 设计库迁移铺路）**：
> - `theme/tokens.ts` 是颜色/间距/字号/圆角/字重的**单一事实来源**；`index.css` 的 `:root` CSS 变量与之同步，供 CodeMirror / md-editor 等不读取 antd ConfigProvider 的第三方库覆盖。
> - `components/ui/` 是 UI 组件**唯一替换点**：所有业务组件（layout/knowledge/ai/pages）一律 `import from '../ui'`，禁止直接 `import from 'antd'`。未来无论接入 Figma Code Connect、独立组件库还是仅替换 token，都只需修改 `ui/` 与 `tokens.ts`，业务组件零改动。
> - `App.tsx` 通过 `ConfigProvider theme` 注入与 antd 默认值一致的 token（colorPrimary/success/warning/error/fontSize），确保零视觉变化；业务组件自身的边框/文字/圆角通过 `tokens.*` 内联样式控制。未来接入 Figma 设计库时可在此扩展注入范围。
> - 当前 token 值与既有 antd 默认值完全一致，**零视觉变化**。

### 6.2 状态管理策略

- 使用 Zustand 管理全局状态（当前选中的 Course/Lesson/Page、AI 配置、对话状态等；2026-10-14 拍板）
- React Context 仅用于少量轻量配置（如界面偏好），不承载复杂状态
- 各模块状态尽量隔离，避免跨模块耦合
- 服务端状态可使用 React Query (TanStack Query) 管理

### 6.3 Markdown 编辑器配置

> **2026-10-29 改拍（当前实现）**：Knowledge 页面编辑器为 **CodeMirror 6 Markdown 源码编辑器**，不使用 `@uiw/react-md-editor` 的编辑态。预览态复用 `MDEditor.Markdown` + `remark-math` + `rehype-katex`（与 Portal / AI Tutor 同一渲染器）。

```typescript
// 编辑：src/components/knowledge/MarkdownSourceEditor.tsx（CodeMirror 6）
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';

const state = EditorState.create({
  doc: contentMd,                        // contentMd 直接就是编辑器内容（无中间态）
  extensions: [
    lineNumbers(), highlightActiveLine(), drawSelection(), bracketMatching(),
    history(), markdown(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorView.lineWrapping,
  ],
});

// 预览：标题栏「预览 / 编辑」切换后渲染（只读）
import MDEditor from '@uiw/react-md-editor';
<MDEditor.Markdown source={contentMd} remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]} />
```

> 语法高亮由 `@codemirror/lang-markdown`（Lezer 增量解析）提供；视口虚拟化使选区/布局成本与文档大小无关。
> 保存策略：输入 300ms 防抖提交进 draft；**每 5 分钟自动保存 + 离开编辑页/切页/切课程立即保存**；保存失败阻断切换并提示重试；刷新/关闭有 `localStorage` 草稿兜底（详见 §3.3.2）。

> **历史配置（已废弃，2026-10-14 → 2026-10-29）**：曾用 `@uiw/react-md-editor` 的 `preview="live"` 双栏实时编辑 + `previewOptions` 传 remark/rehype 插件，并以 500ms 防抖保存。该编辑器在大文档下与块编辑器一起被替换，编辑态配置已不再使用（`@uiw/react-md-editor` 仅保留 `.Markdown` 渲染用于预览与 AI Tutor）。

---

## 7. 开发步骤（Step-by-Step）

### Phase 1: 项目初始化

1. 分别创建 `server/` 和 `client/` 目录（2026-10-14 拍板：不采用 Monorepo）
2. 配置 PostgreSQL 数据库
3. 初始化 Prisma 并创建 Schema
4. 执行 `prisma migrate dev` 创建数据库表
5. 运行 Seed 脚本插入默认数据（PromptTemplate 等）

### Phase 2: 后端基础

1. 搭建 NestJS 服务器（2026-10-14 拍板）
2. 配置 TypeScript 编译环境
3. 实现 Prisma 客户端单例
4. 实现统一响应格式中间件
5. 实现错误处理中间件
6. 实现环境变量配置（`.env` 文件）

### Phase 3: Knowledge System 后端

1. 实现 Course CRUD 接口
2. 实现 Lesson CRUD 接口
3. 实现 Page CRUD 接口
4. 实现 Release/Publish 接口
5. 实现 Sync 接口（Mock 版本）
6. 实现接口鉴权中间件（基础版）

> **鉴权基础版口径（2026-10-14 拍板，对应 §12 事项 #1）**：Phase 3 仅实现 Guard 骨架——全局注册 `ApiKeyGuard`，由环境变量 `AUTH_ENABLED`（默认 `false`）控制开关；开启时校验请求头 `X-API-Key` 等于 `AUTH_TOKEN`，不匹配返回 401 `UNAUTHORIZED`。完整用户认证（JWT/多用户）推迟至 Phase 7 再行确认。

### Phase 4: Knowledge System 前端

1. 搭建项目骨架（Vite + React + TypeScript + Ant Design）
2. 实现 MainLayout 布局（左侧 Sidebar + 右侧 Tab 内容区）
3. 实现 CourseTree 树形组件
4. 实现 PageEditor 编辑器（集成 @uiw/react-md-editor + KaTeX，2026-10-14 Phase 4 改拍）
5. 实现 TagManager 标签管理
6. 实现 PublishPanel 发布面板
7. 实现 Sync 按钮逻辑
8. 对接后端 API
9. 演示种子数据：`server/prisma/seed-demo.ts`（4 门含公式/表格/标签的示例课程，按标题幂等判重），运行 `npm run seed:demo`（仅本地测试用，不并入业务 Seed）

### Phase 5: AI Tutor 后端

1. 实现 PromptTemplate 管理接口
2. 实现 CourseAiConfig 配置接口
3. 实现 AI Gateway Proxy（策略模式）
   - 实现 OpenRouter 适配器（OpenAI 兼容，2026-10-14 拍板）
   - 预留其他 Provider 的接口
4. 实现流式对话接口（SSE）
5. 实现限流（10 次/分钟/courseId）与 CourseAiConfig apiKey 加密存储（对话不落库，§4.3.2 拍板）

### Phase 6: AI Tutor 前端

1. 实现 AI Tutor 页面布局（左侧配置 + 右侧聊天）
2. 实现 ConfigPanel 配置面板
3. 实现 ModeToggle 模式切换
4. 实现 ChatWindow 对话窗口（流式渲染）
5. 实现 New Chat 功能
6. 对接后端 API

### Phase 7: 完善与优化

1. 文件上传转 Markdown 功能（整合 @firecrawl/anydoc 或 markitdown-ts）
2. 接口鉴权完善（JWT Token）
3. 错误边界与加载状态优化
4. 单元测试与集成测试

---

## 8. 环境变量配置

在 `server/` 目录创建 `.env` 文件（后端进程按 cwd 加载；Phase 1 实装起位置，2026-10-14 拍板更正原「项目根目录」表述）：

```env
# 数据库
DATABASE_URL="postgresql://user:password@localhost:5432/learning_guide_db"

# JWT Secret（如需用户认证）
JWT_SECRET="your-super-secret-jwt-key-change-in-production"

# AI Provider 配置（首批接入 OpenRouter，OpenAI 兼容接口，2026-10-14 §12 事项 #2 拍板）
OPENROUTER_API_KEY="sk-or-xxx"
OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"
# 模型列表接口（GET /api/ai/models）数据源，逗号分隔；第一个为默认模型（§4.2.3）
AI_AVAILABLE_MODELS="deepseek/deepseek-v4.1-flash,deepseek/deepseek-r1,openai/gpt-4o-mini,anthropic/claude-haiku-5.5,google/gemini-3.5-flash,qwen/qwen3.6-flash,google/gemma-4-31b-it:free,nvidia/nemotron-3-super-120b-a12b:free"

# CourseAiConfig.apiKey 加密密钥（AES-256-GCM；64 位 hex 即 32 字节，2026-10-14 拍板）
AI_CONFIG_ENCRYPTION_KEY="0000...64位hex...0000"

# 其他 Provider（按需启用，适配器预留）
# DEEPSEEK_API_KEY="xxx"
# ANTHROPIC_API_KEY="xxx"

# 课程同步（2026-10-26 改拍：数据源为 KS 内置课程 ID 映射表，无需配置）

# 服务间鉴权（可选；开启后所有 /api 请求需带 X-API-Key）
AUTH_ENABLED=false
AUTH_TOKEN=

# HelpDesk 工单（2026-10-28，§4A）：Portal 集成接口地址与服务令牌，每次请求现读（轮换后无需改代码）；
# 任一为空 → /api/helpdesk/** 返回 503 HELPDESK_NOT_CONNECTED
PORTAL_HELPDESK_BASE_URL=
PORTAL_HELPDESK_TOKEN=

# HelpDesk Portal → Admin（2026-10-28，§4A.9）：/api/integration/helpdesk/** 的 Bearer 令牌（与 Portal 的
# ADMIN_HELPDESK_TOKEN 相同），每次请求现读；为空 → 503 integration_disabled
ADMIN_HELPDESK_TOKEN=
# Helpdesk 分级方案（§4A.17）：代码缺省就是这一套，下面都不用设；只在临时换掉某一层时设，off = 关掉那一层
# HELPDESK_SUGGEST_MODEL=google/gemma-4-31b-it
# HELPDESK_SUGGEST_THINKING=off
# HELPDESK_EMBED_MODEL=baai/bge-m3
# HELPDESK_RERANK_MODEL=voyageai/rerank-2.5-lite
# HELPDESK_RERANK_KEEP=5
# HELPDESK_RERANK_DIRECT=0.816,0.05
# HELPDESK_SEARCH_SCOPE=all
# HELPDESK_QUERY_CONTEXT=on
# HELPDESK_MODEL_HEALTH_ALERT=0.05
# FAQ 候选的字词检索方式：lexical（缺省；向量走 L2 精排的召回池）/ vector / hybrid（RRF 合并）；向量失败或超时 1.2 秒 → 这一次退回字词
# HELPDESK_RETRIEVAL=lexical
# 新问题的候选怎么排（每次现读）：flat（缺省）/ hybrid（流程树与对象表里结构最像的前 3 张放最前，原候选一张不少；要先 seed:helpdesk-faq-map 再发布）
# HELPDESK_LOCATOR=flat
# 追问卡带上父卡的问题（精排与挑卡都看「父问题 → 追问」）：on 才开，缺省关
# HELPDESK_CARD_CONTEXT=on
# 演示数据：只有部署的 DEV（APP_ENV=DEV 且 NODE_ENV=production）启动后自动灌一次；off 关掉；SIT / UAT / PROD 永远不灌
# HELPDESK_DEMO_DATA=off
# 只给评测脚本 npm run eval:helpdesk 用（§4A.11），服务不读：真模型评测的花费上限（美元，缺省 5）
# HELPDESK_EVAL_BUDGET_USD=5
# FAQ 问题树发布时也跑真模型评测（§4A.13）：on 才跑，缺省关；开着却没组装 model 评测门 → 版本不通过
# HELPDESK_RELEASE_MODEL_EVAL=on

# 服务器配置
PORT=3000
NODE_ENV=development

# 文件上传配置
MAX_FILE_SIZE=15728640  # 15MB
ALLOWED_EXTENSIONS="txt,md,tex,csv,pdf,docx,xlsx,html,xml,doc,xls"  # 与 §10.1 白名单一致；实际实现为 files.service.ts 常量，不读该 env
```

---

## 9. 安全注意事项

### 9.1 API 密钥管理

- 所有 LLM Provider 的 API Key 必须存储在 `.env` 文件中
- 通过 `process.env` 读取，**绝不允许**出现在前端代码中
- 生产环境使用环境变量管理服务（如 AWS Secrets Manager、HashiCorp Vault）

### 9.2 AI 请求安全

- 前端**禁止**直接调用 LLM 厂商 API（如 api.openai.com）
- 所有 AI 请求必须经过后端代理（`/api/ai/chat-stream`）
- 后端代理负责：身份验证、请求签名、流式转发

### 9.3 输入验证

- 所有 API 入口必须对请求参数进行校验（类型、长度、格式）
- 文件上传必须校验文件类型和白名单
- 文件上传必须校验文件大小（最大 15MB）
- 使用 Zod 或 Joi 进行请求体校验

### 9.4 其他安全措施

- 启用 CORS 配置，限制允许的源
- 实现基础速率限制（rate limiting）
- 敏感操作（删除、发布）需要二次确认
- 数据库连接使用连接池

---

## 10. 文件上传规范

### 10.1 上传限制

| 限制项 | 规则 |
|--------|------|
| 文件数量 | 单次最多 1 个文件 |
| 文件大小 | 最大 15MB |
| 允许格式 | txt, md, csv, pdf, docx, xlsx, html, xml, doc, xls |

> **白名单改拍（2026-10-15，用户裁决）**：原表（含 xls/doc/ppt/epub）按 markitdown-ts 实测支持面调整——旧二进制格式 xls/doc/ppt 与 epub 不支持（上传时明确提示「格式暂不支持」）。
>
> **白名单扩充（2026-10-19，用户裁决）**：重新支持旧版二进制 **.doc / .xls**——`.xls` 用 SheetJS（`xlsx`）解析转 Markdown 表格，`.doc` 用 `word-extractor` 提取纯文本；其余格式仍由 markitdown-ts 转换（ppt/epub 仍不支持）。**限制说明：`.doc` 仅提取纯文本，不含标题层级 / 表格 / 图片**。

> **LaTeX 扩充（2026-11-05）**：支持单文件 UTF-8 `.tex`，将 `\title` 转为一级标题、`\paragraph`/`\subparagraph` 转为五/六级标题、`\par` 转为空行，并转换其他章节、列表、强调和链接，保留公式；`\vspace` 等纯间距命令忽略，未知命令与外部资源引用保留原文以便预览检查。上传单个 `.tex` 不会读取其引用的其他文件；无效 UTF-8、空文件及超限文件仍拒绝。

> **编辑器复制兼容**：转换前将不换行空格视为普通缩进并去除正文共同缩进；独占行的 `\\[`/`\\]` 视为被额外转义的展示公式边界。支持 `equation`/`align`/`gather`/`multline`/`displaymath` 公式环境，`textsc`/`underline`/`texttt` 文本样式、`newline`/`linebreak` 换行和 `center`/`abstract` 容器。同文档标题后的 `\label`/`\ref` 转为标题文字，简单 `\footnote` 转为行内 Note，`quote` 转为 Markdown 引用块，简单 `tabular` 转为 Markdown 表格；复杂表格、自定义宏与无法解析的跨文档引用保持原文，需在导入预览中检查。

> **多行公式**：`align`/`align*` 与 `multline`/`multline*` 转为 `$$` 内的 `aligned`，`gather`/`gather*` 转为 `gathered`，保留 `&` 对齐标记和 `\\` 换行。直接在 Markdown 中输入 `$$` 时，也必须自行包裹 `aligned` 并使用双反斜杠换行。
>
> **Import 请求体上限（2026-10-27 修复）**：上传弹窗的 Import 经 `POST /api/courses/:courseId/pages` 以 JSON 提交 `contentMd`（整份转换结果），而 Express body-parser 默认 JSON 上限仅 **100KB**；大文档（如 500 页 PDF）会在进入控制器前被拒（413，对外曾误报 500）。现于 `configureApp` 显式把 JSON 请求体上限放宽至 **25MB**（覆盖 15MB 原文件的 Markdown 膨胀与 JSON 转义开销），并在全局过滤器把 body-parser 的 `entity.too.large` 映射为 **400 VALIDATION_ERROR + 可读提示**；前端 `createPage` / `updatePage` 超时同步放宽至 120s。超过 25MB 的文档仍需拆分后再上传（拆分方案待评估）。

### 10.2 处理流程

1. 弹窗步骤①：前端校验文件类型和大小（扩展名白名单 + ≤15MB）
2. 弹窗步骤②上传到后端 `POST /api/files/convert`（multipart `file`，§3.2.3/§5.1.5）
3. 后端二次校验文件类型白名单与大小（multer limits）
4. 内存 Buffer 直转，**不落临时目录**（2026-10-15 实现拍板）
5. 调用转换服务：**markitdown-ts** 为主（本地，§12 事项 #3 拍板）；`.xls`→**SheetJS `xlsx`** 转 Markdown 表格，`.doc`→**`word-extractor`** 提取纯文本（2026-10-19 扩充）
6. 生成 Markdown 内容，返回 `{ title, markdown }` 供弹窗预览
7. 用户点击 **Import** → 经 §5.1.2 页面创建接口在指定 Course 下新建 Page（标题=文件名去扩展名；2026-10-16 扁平化后无 Lesson 层，Page 直接挂 Course），前端刷新树自动选中；Cancel 则不落任何数据

### 10.3 转换服务选型建议

| 方案 | 优势 | 适用场景 |
|------|------|----------|
| @firecrawl/anydoc | 支持格式多（docx/xlsx/pptx/pdf/csv/epub 等） | 格式覆盖度优先 |
| markitdown-ts | TypeScript 原生，轻量 | Node/TS 工程化优先 |

> **选型拍板（2026-10-15）**：markitdown-ts。实测（真实 docx/pdf/md 样本）：docx/xlsx/pdf/html/xml/txt/md/csv 转换正常；xls/doc/ppt/epub 不支持；图片类需 LLM 视觉模型（不启用）。原「xml、xls、epub 需单独确认」事项已了结。
>
> **补充选型（2026-10-19，用户裁决）**：为覆盖 markitdown-ts 不支持的旧版二进制格式，新增专用库——`.xls` 用 **SheetJS**（`xlsx`，读 BIFF 转 Markdown 表格）、`.doc` 用 **`word-extractor`**（提取纯文本）；均为**纯本地 Node**，不引入外部程序 / 服务。

---

## 12. 待确认事项

以下事项需要在开发前与产品/架构师确认：

1. **用户认证**：是否需要用户登录、多用户、权限管理？还是先做单人私有部署？（Phase 3 已拍板：单人私有部署，鉴权仅预留骨架，见 §7 Phase 3 注记；完整方案 Phase 7 定）
2. **AI Provider**：初期接入哪些 LLM 提供商？（2026-10-14 拍板：**OpenRouter**（OpenAI 兼容接口，经策略模式适配器接入）；具体启用模型清单由用户后续确认，数据源为 `AI_AVAILABLE_MODELS` env；其他 Provider 仅预留适配器接口）
3. **文件转换**：是否允许调用外部服务？还是必须尽量本地 Node 完成？（2026-10-15 拍板：**本地 markitdown-ts**，不调外部服务；支持面实测见 §10.1；2026-10-19 扩充：新增纯本地库 SheetJS `xlsx` / `word-extractor` 以支持 .xls/.doc，仍不调外部服务）
4. **外部同步源**：Sync 功能对接的外部 API 文档是否已就绪？接口格式如何？
5. **历史版本回滚**：是否需要从 Release 快照回滚到某个历史版本？（2026-10-15 拍板：**需要**，采用「激活版本」模型——历史版本可切换为激活版本，AI 知识库与可编辑草稿同步变为该版本，覆盖草稿前二次确认；详见 §3.4.2/§3.4.3/§4.3.3）
6. **AI 对话持久化**：对话记录是否需要长期保存？是否有数据保留策略？（2026-10-14 拍板：**不落库**；上次会话经浏览器 localStorage 持久化，New Chat 清空；无长期记忆需求，见 §4.3.2）
7. **前端框架最终选定**：React + Vite 还是 Next.js？
8. **部署环境**：生产环境部署在何处？（云服务器、Vercel + Railway 等）

### 2026-11-05 遗留质量检查清理

全仓 ESLint/Oxlint 已清至 0 errors / 0 warnings，未调整规则。表单重置与异步加载分开，组件/工具导出拆开以支持 Fast Refresh，KS 查询向量通过契约令牌注入。完整单测后端 1784 passed / 166 skipped、前端 503 passed；types/build 通过。经用户确认，前端已加入 app/vendor 分包配置，保持 500 kB 阈值；实际构建 34 个 JS 文件、最大 293019 bytes，无构建警告。独立 Review 与手动验收待执行。文件清单和验证命令见 docs/AI_tutor/Motherbase_Refactor.md §8。
