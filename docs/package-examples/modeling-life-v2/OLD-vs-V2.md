# 旧包 vs v2 示范包（一页对照）

对照对象：

- **旧交付物**：Owner 提供的 `Modeling life内容文件.zip`（157 MB，原始素材）。
- **旧 v1 平台包**：`formatVersion = 1` 的课程包（被 v2 明确拒绝的格式）。
- **v2 示范包**：本目录 `lite/` 与 `full/` 中的 `*.lgcourse.zip`。

## 1. 差异总表

| 维度 | 旧交付物（Modeling life 源） | 旧 v1 平台包 | v2 示范包 |
|---|---|---|---|
| 形态 | 原始素材 zip：1 个 xlsx + 2 个 docx + 2 个 mp4 + 若干 png，含 `.DS_Store`、`__MACOSX`、`~$` 锁文件 | `.zip` + manifest，`formatVersion = 1` | `.lgcourse.zip` 闭合包，`formatVersion = 2`、`templateVersion = 2` |
| 入口与清单 | **没有 manifest**，内容靠文件名/目录理解 | manifest 宽松，允许目录推断 | `manifest.json` 唯一入口；`resources[]` 与 ZIP 条目 **1:1**；声明缺失/多余/越界都整包拒绝 |
| 时间 | xlsx 两列：`视频开始节点`、`exhibit弹窗触发节点`；Excel 日分数存储，同一列混用 `00:10` / `06:52` 两种解释 | 时间值随包携带 | **模板没有任何时间列**；时间由字幕 > 章节轨 > ASR 机器派生为 `[startMs, endMs)`，用真实容器时长强校验 |
| 分类 | `course info` 工作表里写显示名 `Science` | `course.category` 字符串（显示名） | `course.categoryPath = ["Science"]` 稳定键路径；未分类为 `null`；导入查不到即整包拒绝，**不创建分类** |
| 媒体引用 | 文件名/目录即语义（`lesson1-exhibit-1.png`…） | 按文件名约定猜媒体 | `asset_key + asset_version`；Media sheet 登记 `relative_path`，manifest `resources[]` 为准；**不从文件名推断** |
| 内容身份 | 无 | 依赖内容哈希（含环境 UUID，跨环境永不等） | `(formatVersion, courseKey, versionNo)`；**全系统无任何 sha256/checksum/digest**；完整性靠 ZIP CRC32 + 大小/类型 |
| 版本/审计 | 无 | 哈希 + 时间戳 | 显式 `versionNo` 单调；`provenance`（来源/planPin/审批/审计引用）+ `annotations`（时间审计）；二者**不参与身份与 stale** |
| 语言 | 元数据基本只有英文，中文列为空；docx 内含中英对照 | 单语/缺语言可静默通过 | `learningLanguages` 有序回退链；课程元数据恒为 en-GB + zh-CN；缺语言 = `LANGUAGE_MISSING`（incomplete，阻断发布），**不机翻** |
| 校验行为 | 无 | 宽松、可自动修复、可能半导入 | **校验先于清洗**；任一 error → 整包原子拒绝；incomplete 允许入库但阻止发布；**不自动改名/跳行/造分类/猜时间** |
| 失败报告 | 无 | 粗粒度错误 | 每条 error/incomplete/warning 带 `sheet/row/column` 或 JSON path；导入后做源-产计数对账 |
| 环境 | 无 | 哈希里带环境 UUID | 无环境 UUID；`assetKey` 跨环境稳定；`provenance.sourceEnv`（sandbox/production）决定生产导入资格 |
| 幂等 | 无 | 靠哈希比对 | 同一 `(courseKey, versionNo)` 重复导入 **no-op**；新版本“替换草稿 + 写后删差集” |
| 旧格式 | — | 就是旧格式 | 不提供兼容层：`formatVersion ≠ 2`、缺 `templateVersion=2`、出现 `course.category`/`checksums` 一律拒绝 |

## 2. 旧时间列为什么必须丢弃（实测证据）

旧 xlsx 的时间单元格以 Excel 日分数存储。按 1 天 = 86400 s 解释，与真实视频时长对比：

| 旧字段 | 原值 | 解释为时刻 | 真实时长 | 判定 |
|---|---:|---:|---:|---|
| 1.1 视频开始 | 6.944444e-3 | 00:10:00.000 | 24:29.312 | 值本身合法 |
| 1.1 展品1触发 | 2.569444e-2 | 00:37:00.000 | 24:29.312 | **越界** |
| 1.1 展品2触发 | 0.111111 | 02:40:00.000 | 24:29.312 | **越界** |
| 1.2 视频开始 | 0.286111 | 06:52:00.000 | 24:29.312 | **越界** |
| 1.3 视频开始 | 0.407639 | 09:47:00.000 | 24:29.312 | **越界** |
| 1.4 视频开始 | 0.712500 | 17:06:00.000 | 24:29.312 | **越界** |
| 1.5 视频开始 | 0.815972 | 19:35:00.000 | 24:29.312 | **越界** |
| 2.1 视频开始 | 6.944444e-3 | 00:10:00.000 | 26:24.264 | 值本身合法 |
| 2.2 视频开始 | 0.836111 | 20:04:00.000 | 26:24.264 | **越界** |

同一列里既有“日分数”，又有被误读成 `mm:ss` 的显示值（`00:10`、`06:52`）。
结论：旧时间 **100% 丢弃**，不迁移、不 clamp、不重解释；v2 从字幕/章节/ASR 重新派生。

## 3. 旧包 → v2 我们具体做了什么

**丢弃：**

- 全部旧时间列与时间值（两列、9 个学习点/触发点）；
- 旧分类显示名与“查不到就建分类”的行为；
- 文件名/目录语义、`checksums.sha256`、任何哈希清单、环境 UUID；
- `.DS_Store`、`__MACOSX`、`~$` 锁文件；
- 旧 xlsx 作为唯一内容真源（它只保留 KT/AT/阅读的英文内容参考）。

**重做/派生：**

- 以 docx 为内容真源：2 课时、7 学习点、35 展品（29 图 + 6 纯文本）、26 知识题、2 应用题、6 阅读；
- 分类改稳定键 `["Science"]`；课程元数据补 en-GB + zh-CN；
- 时间：L001 用 142 条字幕 cue（`subtitle`），L002 用 MP4 chapter track（`chapter`），
  每条 LP 派生 `[startMs, endMs)` 并冻结进 rendition；
- 媒体身份改为 `asset_key + asset_version`，Media sheet 与 `resources[]` 一一对应；
- 审计随包携带：`annotations.verification`（两条 timing-audit）+ `provenance`
  （sourceEnv、planPin、approvalRef、auditSummaryRef）。

**保留：**

- 教学媒体原文件不转码、不放大、不重写（lite 仅把视频截到 15 s 用于演示，已标注；
  full 的 L002 仅注入章节轨元数据）；
- docx 正文与中英对照内容；
- 课程标题与课程定位。

## 4. 一句话

旧包是“**素材 + 人工时间 + 文件名约定 + 哈希**”；v2 示范包是“**闭合清单 + 稳定键 +
机器派生时间 + 显式版本与来源审计**”，且没有一行时间需要人填。
