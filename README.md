# Learning Guide BackOffice

结构化课程知识库管理系统：**Knowledge System**（Course → Lesson → Page 三级知识树、
Markdown 编辑含 LaTeX、发布快照与历史版本、外部同步）+ **AI Tutor**（Lecture /
Socratic 双模式流式对话、PromptTemplate 与课程级 AI 配置）。

## 开发文档

- [Learning Guide BackOffice - Agent 开发文档 v1.0](docs/Learning_Guide_BackOffice_Agent_Development_Document.md) — 开发基准。系统概述与架构原则、Prisma Schema、知识库模块、AI Tutor 模块、API 接口规范、前端架构、开发步骤（Phase 1-7）、安全规范、待确认事项。

## 技术栈

| 层 | 选择 |
|---|---|
| 后端 | Node.js + TypeScript + NestJS（2026-10-14 拍板） |
| 数据库 | PostgreSQL + Prisma ORM |
| 前端 | React + TypeScript + Vite + Ant Design 5.x |
| 状态管理 | Zustand（全局状态）+ React Context（少量轻量配置） |
| 编辑器 | @uiw/react-md-editor（KaTeX 渲染；2026-10-14 Phase 4 用户裁决，替代原 md-editor-v3） |

## 目录结构

```
docs/        开发文档
agents/      双智能体定义（Dev / Review）
server/      后端（NestJS + Prisma，Phase 1 已搭建）
client/      前端（React + Vite + Ant Design 5.x，Phase 1 已搭建）
```

## 协作工作流

- **用户裁决**：所有方案性建议经用户同意后执行，不得擅自变更已拍板决策
- **变更同步**：增删改查模块 / 接口 / 表结构变更，先改设计文档再实现（单一事实来源）
- **双智能体**：[Dev Agent](agents/dev-agent.md)（开发）+ [Review Agent](agents/review-agent.md)（测试与代码审查）
- **审查门禁**：每次开发变更必须经 Review Agent 独立审查（新上下文），APPROVE 才算完成
- **Git**：`feature/<task>` 分支日常开发；大迭代（Phase 完成/阶段性交付）推送分支并发 PR 到 main，合并条件 = 审查通过（大迭代完整定义见 [.trae/rules/project_rules.md](.trae/rules/project_rules.md)）
- **注册智能体**：将 agents/ 下两个文件的「系统提示词」段落粘贴到 Trae 智能体创建界面即可；项目协作规则见 [.trae/rules/project_rules.md](.trae/rules/project_rules.md)

## 一键安装环境

本项目为 **Node.js** 工程（**无 Python / venv**）：依赖版本由 `server/package-lock.json`、`client/package-lock.json` 锁定，Node 版本见 `.nvmrc` 与各 `package.json` 的 `engines`；JS 依赖就地隔离在各自的 `node_modules`（等价于 Python 的 venv）。

前置要求：Node.js ≥ 22.19（server 的 pi-agent-core 需要；`nvm use` 自动读取 `.nvmrc`）、npm ≥ 10；数据库二选一——本机 PostgreSQL，或 Docker 一键起库。

```powershell
# Windows
.\setup.ps1                 # 安装 Node 依赖 + 生成 server/.env
.\setup.ps1 -WithDocker     # 额外用 Docker 启动 PostgreSQL 16
```

```bash
# macOS / Linux / WSL
./setup.sh                  # 安装 Node 依赖 + 生成 server/.env
./setup.sh --with-docker    # 额外用 Docker 启动 PostgreSQL 16
```

脚本不会写入任何密钥；`server/.env` 由 `server/.env.example` 复制而来，请自行填写 `DATABASE_URL` 与 `AI_CONFIG_ENCRYPTION_KEY`。

## 开发

### 后端（server/）

```bash
cd server
npm install
npx prisma migrate dev   # 应用迁移
npx prisma db seed       # 种子数据（幂等）
npm run start:dev        # http://localhost:3000
```

Helpdesk 推荐评测（设计文档 §4A.11）：`npm run eval:helpdesk -- --out helpdesk-eval-report.md`。有 `OPENROUTER_API_KEY` 时用真模型、花费上限 `HELPDESK_EVAL_BUDGET_USD`（缺省 5 美元）；没有 key 时用假模型，报告注明不是模型成绩。只有真模型、整套用例且加 `--pg <DATABASE_URL>` 的运行才可能过闸（退出码 0）。10,000 条的 qa10k 集（`server/eval/helpdesk/qa10k/`，dev / test 各 5,000，见其中 `STATS.md`）：`--cases eval/helpdesk/qa10k/test.jsonl --faqs eval/helpdesk/qa10k/faqs.json`；`--retrieval-only`（可加 `--pg`）只跑检索、报 recall@1 / @3 / @8，从不问模型。

Helpdesk 数据飞轮（v5 Part G3–G6：夜间缺口挖掘、FAQ 候选、回归用例与 CI 评测门、指标；Admin 读不到 Portal 的库，数据只来自 Portal 的 insights 接口）：见 [docs/Helpdesk_Data_Flywheel.md](docs/Helpdesk_Data_Flywheel.md)。

### 前端（client/）

```bash
cd client
npm install
npm run dev              # http://localhost:5173
```

> 注：`npm install` 适合已有 `node_modules` 的增量更新；若要与 `package-lock.json` 严格一致（首次安装 / CI），请改用 `npm ci`（见上文「一键安装环境」）。

### 数据库

二选一：

- **本机 PostgreSQL 16**（Windows 服务名 `postgresql-x64-16`），账号/密码均为 admin，库名 learning_guide_db；
- **Docker 一键起库**：`docker compose up -d postgres`（镜像 `pgvector/pgvector:pg16`，默认 admin/admin@localhost:5432；若 5432 被占用可 `POSTGRES_PORT=5433 docker compose up -d postgres`）。

连接串存于 `server/.env`（不入库），模板见 `server/.env.example`。表结构变更只走 Prisma Migrate，禁止手改数据库。
