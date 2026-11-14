# 课程内容系统 · 长程真实测试计划（Long-Range Real Test Plan）

- 日期：2026-11-12
- 状态：待实现收口后执行（内容模型 Part C 定稿 + 实现 workflow 全绿后）
- 执行方式：`Workflow` 脚本 `lg-longrange-real-tests`（会话脚本目录），本地真实 Postgres（learning_guide_e2e）+ 真实媒体 + 真实 zip
- 测试对象：新的时间/参考系模型、包闭合契约、阶段/rendition 映射、学习会话事件、分类与权益回归

## 运行方式（owner 2026-11-14：长程不上 CI，本地跑）

夹具由 owner 提供的 165MB 真实包生成，体积上不了 git；因此长程套件**不在 CI**（`.github/workflows/ci.yml` 的 e2e job 只跑标准 e2e，说明写在 job 注释里）。

```bash
cd server
# 一次：生成夹具（需要真实 zip 与 ffmpeg）
python3 -I test/fixtures/longrange/scripts/build_all.py
# 每条：空库 + 迁移 + 串跑
export DATABASE_URL=postgresql://admin:admin@localhost:5432/learning_guide_e2e
npx prisma migrate deploy
npm run test:longrange
```

`test:longrange` 用独立配置 `test/jest-longrange.json`（`longrange-*.e2e-spec.ts`），默认 `test:e2e` 已通过 `testPathIgnorePatterns` 排除这些文件——两套不会互相混跑，也不会因缺夹具把 CI 判红。

## 0. 测试原则

- 黑盒：只经 HTTP / Route Handler / 页面输出观察行为；不 import 内部实现、不断言私有字段。
- 真实资产：以真实 Modeling life 包（165MB：2 docx、2 mp4、5 png、1 xlsx）为基座，不用玩具视频代替时长与时序。
- 规格来自设计文档：每个用例标注 I/C/P/B/S 编号。
- 失败必须红在该红的步骤；任何"跳过/容忍"要显式记录。
- 长程：不止单点，跑完整生命周期（导入→派生→发布→学习→换视频→重确认→新版本→恢复→跨环境往返）。

## 1. 夹具（Fixtures）

| 夹具 | 内容 | 用途 |
|---|---|---|
| F1 真实包 | Modeling life 原始 zip（无字幕/章节轨） | 验证"无派生源 → 拒绝/incomplete"；验证 165MB 真实时长 |
| F2 字幕包 | F1 + 合成 SRT/VTT（由 docx 脚本生成时间 cue） | 字幕派生学习点/展品触发 |
| F3 章节包 | F1 + 带 chapter track 的 mp4（ffmpeg 注入） | 章节轨直接映射学习点 |
| F4 坏包集合 | 缺 manifest 字段 / 未知文件 / 版本缺失 / 重复真值键 / 越界时间 / 未知 code / 缺语言 / 非法媒体类型 / zip 路径穿越 | fail-closed 边角 |
| F5 替换包 | F2 的同课时新视频（时长不同） | 资产新版本 → 映射失效 → Re-confirm |
| F6 跨环境包 | F2 导出物 | 两库往返、分类/阶段稳定键 |

## 2. 测试矩阵

### T1 资产身份与版本
- 上传产生 `assetKey + assetVersion`；库内/API/包内**不存在**内容哈希字段与依赖。
- 重新上传 = 新 assetVersion；旧 stage→坐标映射标记失效，需重新派生/确认。
- 同一 assetKey 的旧版本仍可读快照，不可用于新映射。

### T2 时间派生（全机器）
- F1（无字幕无章节）：ASR 从音轨派生转写与时间（内部工件），学习点/触发生成坐标；低置信 → 阶段 blocked `ALIGNMENT_LOW_CONFIDENCE`；**不得猜时间**。
- F2：SRT/VTT cue 对齐学习点标题与 `[Exhibit]` 标记 → timeMs 入库；字幕优先于 ASR；重复导入逐条一致（确定性）。
- F3：chapter track 直接映射学习点；章节缺失的课时回退 ASR。
- 每个语言独立派生：en-GB 与 zh-CN 视频各自时间源与对齐；一个语言缺失不静默复制另一个语言。
- ASR 模型版本/参数/ruleVersion 记录在 provenance 与 Alignment（sourceKind/sourceArtifact），同输入重复派生逐条一致。
- 越界（≥duration）、负值、空值 → error 带源坐标；duration 从容器读取，与 ffprobe 一致。
- 模板中不存在任何时间列（出现即未知列报告/拒绝）。

### T3 阶段 / rendition
- 同一 stageId 同时有 video interval 与 text heading；模式切换按 stageId，不按时间。
- 两模式内容不一致 → 机器报告（不静默各自成立）。
- 展品多触发：同一展品三个不同 timeMs → 三条；同 (lesson, exhibit, language, timeMs) 重复 → error。
- 不同展品同一时间点 → 合法。

### T4 包闭合与版本
- formatVersion/templateVersion 缺失或未知 → 拒绝；旧包拒绝。
- manifest 声明与文件一一对应：缺失/多余文件 → error；未知文件 → error。
- 枚举稳定 key；显示名不参与匹配。
- 包内不存在 sha256/hash 字段要求（grep 断言 + manifest schema）。
- **provenance 强制**：Production 导入 `provenance.sourceEnv !== 'sandbox'` 或 provenance 缺失 → `PACKAGE_SOURCE_NOT_ALLOWED`；伪造文件名/路径不改变判定；Sandbox 导出包在 Production 导入通过。
- **provenance.asr**：ASR modelVersion/params/ruleVersion 存在且与派生产物一致；同包重复导入派生结果逐条一致。
- **能力矩阵**：Production 下 content authoring/新建/结构变更接口 → 403 `CAPABILITY_DISABLED`（服务端强制）；import、plan preview/approve、publish、restore、change status、operations 可用；Sandbox 下 authoring 可用。

### T5 导入原子性与幂等
- 分类/时间/内容任一失败 → 整包回滚，草稿不变。
- 同一包导入两次 → 内容逐条一致（no-op）；写后删差集，无残留行。
- 并发导入同一课程 → 一个成功或整齐失败，无重复行、无半成品。

### T6 快照 / 版本 / 投影
- 快照 v3 存 categoryPath + stage/rendition 映射；不含环境 UUID 身份。
- 草稿改分类/阶段 → 线上投影不变；发布后生效。
- Restore 旧版本：映射按当前资产解析；缺资产/分类 → CATEGORY_NOT_FOUND/ASSET_NOT_FOUND，草稿不变。
- 跨环境：导出→导入另一库→发布→投影一致（F6）。

### T7 学习会话事件
- started/completed 事件：幂等键重复提交不产生双份；completed 前必须有 started。
- 客户端时间不可信：服务端 receivedAt 为权威；离线补报超窗拒绝。
- 事件按 contentVersion + stageId 关联；跨版本统计不串。

### T8 分类与权益回归（保留层）
- 分类单源、稳定键、四错误码、S1–S8 回归。
- 权益 scope 按稳定键；"全部"= 全部 ACTIVE 分类。

## 3. 长程生命周期脚本（一个连续 scenario）

1. 空库 → 迁移 → 导入 F2（字幕包）→ 派生时间 → 阶段树/映射落库
2. 发布 v1 → 线上投影校验 → 学习会话事件（start/complete + 幂等）
3. 导入 F5（替换视频）→ 映射全部标记失效 → Re-confirm → 发布 v2
4. Restore v1 → 草稿正确、线上不变 → 发布 v3 → 历史版本投影
5. 导出 F6 → 导入第二个库（学习指南二库）→ 发布 → 投影对比
6. 对 F4 坏包集合逐项拒绝，草稿/分类/时间均无副作用
7. 全程检查：无 hash 依赖、无人工时间字段、无 Uncategorized、无 global timeline 表

## 4. 通过标准

- 上述矩阵全绿，或每一项红都有明确归属（实现缺陷 / 内容包不合格 / 环境限制）与证据。
- 长程 scenario 每一步有命令输出或 API 响应摘录。
- 生成的测试文件与 fixture 脚本落盘在仓库，CI 的 e2e job 可复跑。
