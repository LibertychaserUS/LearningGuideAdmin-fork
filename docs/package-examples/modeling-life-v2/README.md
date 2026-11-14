# Modeling life · 课程资源包 v2 示范包

这是一个符合 **Course Package Spec v2** 的示范课程包，用于两件事：

1. **内容制作方**照着它交付：模板怎么填、素材怎么命名、哪些东西不要交。
2. **产品/售前**拿它演示：时间全机器派生、低置信阻断、闭合包拒绝坏包、跨环境 provenance。

| 项 | 值 |
|---|---|
| 规格 | [`docs/Course_Package_Spec_v2.md`](../../Course_Package_Spec_v2.md) |
| 设计 | [`docs/Course_Category_Single_Source_Design.md`](../../Course_Category_Single_Source_Design.md) §14 C0–C17 |
| 契约 SSOT | `server/src/partc/contracts/`（manifest / template-v2 / content-version / rendition / alignment / evidence-spec / stage） |
| 版本矩阵 | `packageFormat = 2` · `templateVersion = 2` · `snapshotFormat = 3` |
| 课程身份 | `courseKey = modeling-life` · `versionNo = 1` · `categoryPath = ["Science"]` |
| 旧内容来源 | Owner 提供的 `Modeling life内容文件.zip`（157 MB，原始素材，非 v1 包） |

> 三份配套文档：**制作方**看 [`GUIDE-for-producers.md`](GUIDE-for-producers.md)；
> **产品演示**看 [`GUIDE-for-product.md`](GUIDE-for-product.md)；
> **新旧差异一页纸**看 [`OLD-vs-V2.md`](OLD-vs-V2.md)。

---

## 1. 这个包怎么用：导入 → 机器派生时间 → 签收 → 预览 → 发布

一个 v2 包从文件到上线只有五步。**没有任何一步需要人输入时间。**

| # | 步骤 | 谁做 | 系统做什么 | 产物 |
|---|---|---|---|---|
| 1 | **导入** | Operator | 上传 zip → 校验（schema / 版本 / 闭合包 / code 唯一 / 双语 / 分类）→ 全部通过才允许确认 | import job（`AWAITING_CONFIRM` 或 `FAILED` + 报告） |
| 2 | **机器派生时间** | 系统 | `parse → validate → deriveTiming → align`：按字幕 > 章节轨 > ASR 优先级，对**每个视频 × 每个语言**独立派生毫秒区间 | renditions（`startMs/endMs`）、proposed alignments、时间审计报告 |
| 3 | **签收** | Operator（Sandbox） | 按审计报告在 Sandbox 播放复核语义，把 proposed 对齐签成 `verified` | 只含 verified 对齐的冻结候选内容 |
| 4 | **预览 / 签收 Plan** | Operator | `plans/preview` 编译确定性 Plan（检查 STR/ALN/TIM/PLN）→ `save` → `approve`（显式接受 warnings） | 已批准的 Plan（绑定 `planId + planVersion`） |
| 5 | **发布** | Operator | `plans/apply` / `plans/publish` 冻结 ContentVersion（含 planPin）；课程上线仍走既有发布与 live-status | 不可变 ContentVersion + 线上快照 |

关键语义：

- **导入是原子的**：任何 error → 整包拒绝，草稿/分类/对齐都不变，不产生半成品。
- **incomplete ≠ error**：缺语言、缺正文等记为 incomplete，允许入库，但**阻止发布**。
- **只有 verified 对齐能进 Plan**；低置信或没有时间源 → 该阶段 blocked，发布门拒绝。
- **发布 ≠ 内容维护**：Production 禁用 authoring，但允许 import / plan approve / publish / status。

完整可复制的演示步骤（含 lite 包、API 与预期错误码）见 [`GUIDE-for-product.md`](GUIDE-for-product.md)。

---

## 2. 包结构逐项说明

lite 包的完整条目（full 包结构相同，仅媒体为真实时长/体积）：

```text
modeling-life-v2-lite.lgcourse.zip
├── manifest.json                       # 唯一入口；闭合清单
├── template.xlsx                       # 机读内容合同（9 张机器 sheet）
├── lessons/
│   ├── L001.docx                       # 课时正文/脚本（只用于文本锚点）
│   └── L002.docx
├── media/
│   ├── cover.png                       # 课程封面
│   ├── videos/
│   │   ├── l1.mp4                      # L001 视频（lite: 15 s / full: 24:29.312）
│   │   └── l2.mp4                      # L002 视频，含 MP4 chapter track
│   ├── exhibits/
│   │   ├── l1-01.png … l1-17.png       # L001 展品图（12 张）
│   │   └── l2-01.png … l2-17.png       # L002 展品图（17 张）
│   └── thumbnails/
│       ├── l1-02.png                   # 方形缩略图（thumbnail_of=ex-l1-02）
│       └── l1-04.png
└── subtitles/
    └── L001.en-GB.srt                  # L001 的首选时间源（142 cues）
```

> **没有 `chapters/` 目录**：规格允许“MP4 chapter track 或 `chapters/*.json`”二选一。
> 本示范的 L002 用的是 **MP4 内嵌 chapter track**（2 章，标题=学习点标题），
> 因此不在包里放 `chapters/*.json`。两种方式不要同时给。

### 2.1 `manifest.json`

manifest 是包的**唯一入口与闭合清单**，字段分六组：

| 分组 | 字段 | 作用 | 谁能改 |
|---|---|---|---|
| 格式 | `format` / `formatVersion` / `minReaderVersion` / `extensionsUsed` / `extensionsRequired` | 声明“我是 v2 包”；未知 `extensionsRequired` 整包拒绝 | 机器 |
| 身份 | `course.courseKey` + `content.versionNo`（+ `formatVersion`） | **包身份**，跨环境稳定 | 机器 |
| 课程 | `course.titleLocalized` / `categoryPath` / `learningLanguages` / `studyMode` | 课程级元数据；分类只写稳定键 | 机器（来源于 Admin 课程设置） |
| 冻结内容 | `content.stages` / `prerequisiteEdges` / `specPins` / `renditions` / `alignments` / `evidenceSpecs` / `assetPins` | 阶段树 + 交付物 + 对齐，**只含稳定键** | 机器（导入/导出派生） |
| 文件清单 | `resources[] = {id, kind, path, size}` | 与 ZIP 条目 **1:1**；`size` 逐字节校验 | 机器 |
| 来源/审计 | `provenance` / `annotations` | 来源环境、planPin、审批与审计引用、时间源审计 | 机器（导出时写入） |

身份规则（务必讲清楚）：

- 包身份 = **`(formatVersion, course.courseKey, content.versionNo)`**。
- `packageId`、`exportedAt`、`provenance`、`annotations` **都不参与**身份、幂等与 staleness。
- 同一 `(courseKey, versionNo)` 重复导入是 **no-op**。
- **没有 `sha256` / `checksum` / `digest` 任何字段**；完整性靠 ZIP CRC32 + 声明大小 + 类型校验。

本包实测：`resources` 38 条（1 个 template + 37 个媒体资源）；`content` 含 3 个 stage
（1 program + 2 step）、1 条 `requires`、8 个 `specPins`、71 个 renditions、
67 个 alignments（7 primary / 2 support / 58 auxiliary，全部 verified）、
4 个 evidenceSpecs、37 个 assetPins。

### 2.2 `template.xlsx`（templateVersion = 2）

9 张**机器可读** sheet，列名由契约 schema 生成（不是手写第二份）：

| sheet | 列 | 作用 |
|---|---|---|
| Meta | `templateVersion, courseCode, learningLanguages, studyMode` | 版本与课程身份 |
| Media | `asset_key, kind, lesson_code, language, relative_path, thumbnail_of` | 文件清单（内容侧登记） |
| Course Info | `field, language, text` | 5 个课程元数据字段 × en-GB/zh-CN |
| Lessons | `lesson_code, order, language, title, description` | 课时 |
| Learning Points | `lesson_code, lp_code, language, title` | 学习点（**只有编号与标题**） |
| Exhibits | `lesson_code, exhibit_code, media_type, asset_key, language, title, description, source` | 展品（图/视频/音频/3D/纯文本） |
| Reading List | `lesson_code, type, title, author, why` | 推荐阅读（仅英文） |
| Knowledge Test | `lesson_code, order, language, question, reference_answer` | 知识题（双语） |
| Application Test | `lesson_code, language, question, reference_answer` | 应用题（每课一题，双语） |

**这张表里没有任何时间列**：没有 `start/end/time/duration/trigger/时间/时长`。
发现时间列 → `HUMAN_TIME_FORBIDDEN`，整包拒绝。

### 2.3 `lessons/*.docx`

课时正文/脚本。它的角色有两个：

- 提供课时富文本正文（导入时转成正文 block）；
- **只用于文本锚点**（DOCX Heading 1 → 文本模式学习点锚点）。
  它**不是**视频时间来源；视频时间只来自字幕/章节/ASR。

### 2.4 `subtitles/*.srt`

外部字幕是**首选时间源**（C7 优先级 ①）：

- UTF-8、SRT 或 VTT；cues 必须满足 `0 ≤ start < end ≤ 真实时长`。
- 学习点标题/展品标题按字幕文本对齐到 cue 起点；`[Exhibit: Exx]` 标记按所在对话行对齐。
- 本示范：`L001.en-GB.srt`，142 cues，覆盖全部 5 个 L001 学习点标题。

### 2.5 `chapters`（MP4 chapter track 或 `chapters/*.json`）

**二选一**，是第二优先级时间源：

- MP4 chapter track：章节标题映射学习点，章节起点即锚点；本示范的 L002 用这种方式。
- `chapters/*.json`：按规范给出章节起点（整数毫秒），导入时仍会做范围校验。
- 章节位置是**媒体事实**，不是课程设计时间；模板里不出现。

### 2.6 `media/*`

| 类型 | 规格 | 本示范 |
|---|---|---|
| 视频 | MP4 / H.264 / ≤1080p / ≤500 MB | L001 1469.312 s（24:29.312），L002 1584.264 s（26:24.264） |
| 图片 | JPG/PNG/WebP，长边建议 ≥2000 px，≤20 MB | 29 张展品图 + 封面（部分原图长边 <2000 px，见 §7） |
| 3D | GLB，≤50 MB | 无 |
| 缩略图 | 正方形，≥400×400 | 2 张（`thumbnail_of` 指向 `ex-l1-02` / `ex-l1-04`） |
| 字幕 | SRT/VTT（UTF-8） | 1 个 SRT |
| 章节 | MP4 track 或 JSON | L002 MP4 track（2 章） |

媒体**不缩不放不转码**：教学资产是既成输入（C0 红线⑤）。构建只做两处经标注的非内容改动：
lite 包把视频截到 15 s（`annotations.variant=lite`），以及给 L002 注入章节轨
（stream copy，标题=学习点标题）。full 包保留真实视频与图片，仅 L002 的章节轨是
注入的元数据。

### 2.7 `resources[]` 与 Media sheet 的关系

两者必须**一一对应**（manifest 为准）：

- `resources[].id` = Media sheet 的 `asset_key`（模板资源 id = `template`）；
- `resources[].kind` = Media sheet 的 `kind`（唯一例外：Media 的 `lesson-text` 对应 manifest 的 `document`）；
- `resources[].path` = Media sheet 的 `relative_path`；
- `resources[].size` = ZIP 条目的真实字节数；
- `thumbnail_of` 只存在于 Media sheet（内容侧对账），manifest 的资源形状固定为 `{id, kind, path, size}`。

声明但缺失 → `PACKAGE_FILE_MISSING`；存在但未声明 → `PACKAGE_FILE_UNKNOWN`；
路径越界（`..`、绝对路径）→ 整包拒绝。

### 2.8 `provenance` 与 `annotations`

- `provenance` 是 v2 导出方**必须写入**的来源块：`sourceEnv`、`sourceVersionLabel`、
  `exportedAt`、`exportedBy`、`courseKey`、`planPin`、`approvalRef`、`auditSummaryRef`、
  以及使用 ASR 时的 `asr{modelVersion, params, ruleVersion}`。
  - 生产环境开启 `PACKAGE_SOURCE_ENFORCEMENT` 后，**只接受 `sourceEnv = sandbox`**；
    否则 `PACKAGE_SOURCE_NOT_ALLOWED`。来源判定只看这个字段，**不看文件名/目录**。
- `annotations` 是自由 JSON，用于随包携带审计元数据：本包含 `timingSources`
  （subtitle + chapter）、`verification`（两条 timing-audit）、`contentCounts`、
  `demoValues` 等。**不参与身份、幂等与 staleness。**

### 2.9 包里没有的东西

- 没有 `timing.json`（导入时派生的内部产物，不是交付物）；
- 没有任何哈希清单；
- 没有环境 UUID / 环境本地自增 ID；
- 没有学员数据、订单、学习记录；
- 没有旧格式字段（`course.category` 字符串、`checksums`、模板时间列）。

---

## 3. 哪些是生产方要填的、哪些是机器生成的

| 产物 | 生产方 | 机器 | 人签 |
|---|---|---|---|
| `template.xlsx` 的 9 张 sheet 内容 | ✅ 填 | 模板列由 schema 生成 | — |
| 视频 / 图片 / 封面 / 缩略图 | ✅ 提供原文件 | 探测时长/尺寸、校验规格 | — |
| 字幕 / 章节轨 | ✅ 提供（或由 ASR 机器兜底） | 解析 cue、按语言派生 | — |
| `manifest.json` | — | ✅ 导出器/构建器生成 | — |
| `resources[].size`、闭合校验 | — | ✅ | — |
| 时间（`startMs/endMs`） | ❌ **不填、不估算、不打点** | ✅ 机器派生 | 只播放复核语义 |
| proposed alignments | — | ✅ 派生 | — |
| verified alignments | — | 提供审计元组 | ✅ Operator 播放复核后签收 |
| 时间审计报告 | — | ✅ 生成（毫秒 / `mm:ss.mmm` / 邻近文本） | ✅ 按报告复核 |
| Plan 预览 / 批准 | — | ✅ 确定性编译 | ✅ Operator 显式接受 warnings |
| 分类 | 只给**稳定键**（如 `Science`） | 解析为本地分类，查不到整包拒绝 | — |

一句话：**生产方交付“内容 + 素材 + 机器可读的时间源”，机器交付 manifest 与时间，
人只做语义复核与签收。**

---

## 4. 内容清单

| 项目 | 数量 | 来源 |
|---|---:|---|
| 课时 | 2（L001 / L002） | 旧 docx / xlsx |
| 学习点 | 7（工作簿 14 行 = 7 × en-GB/zh-CN） | 旧 docx / xlsx |
| 展品 | 35（29 图 + 6 纯文本） | 旧 docx（29 内嵌图 + 2 包内高清图 + 2 缩略图） |
| 知识题 | 26（L001 18 + L002 8） | 旧 v1 模板 |
| 应用题 | 2（每课 1） | 旧 v1 模板 |
| 阅读 | 6（每课 3） | 旧 v1 模板 |
| 视频 | 2（L001 24:29.312 / L002 26:24.264） | 旧包 MP4，未转码 |
| 字幕 | 1（L001 en-GB SRT，142 cues） | 由 L001 docx 脚本/标题生成 |
| 章节 | L002 MP4 chapter track（2 章） | ffmpeg 注入（stream copy） |

课程身份：`courseKey=modeling-life`、`categoryPath=["Science"]`、
`learningLanguages=["en-GB","zh-CN"]`、`studyMode=both`、`versionNo=1`。
分类只写稳定键，显示名由 Admin localized 提供。

---

## 5. 时间是怎么来的（红线）

模板中**没有任何时间列**；时间只来自机器可读来源：

| 课时 | 来源（C7 优先级） | 工件 | 说明 |
|---|---|---|---|
| L001 | ① 外部字幕 | `subtitles/L001.en-GB.srt` | cue 文本来自真实 docx（学习点标题、展品标题、英文正文）；cue 时间在**真实容器时长内**均布 |
| L002 | ② MP4 chapter track | `media/videos/l2.mp4` 内嵌章节轨 | 章节标题 = 学习点标题；`anchorSource=chapter` |

派生规则（`ruleVersion = timing-rules-v1`）：

1. **每个视频 × 每个语言独立派生**（en-GB / zh-CN 各自时间源）。
2. 点锚点展开为半开区间 `[start, end)`：
   - 有字幕 cue → 用 cue 区间；
   - 只有点锚点 → `end = 同一 stage 下一锚点 − 1ms`；无下一锚点 → `end = duration`。
3. 强校验 `0 ≤ start < end ≤ duration`（duration = 容器探测的真实时长）；
   越界/负值/空值 → error，带 `sheet/row/column` 或 JSON path。
4. 派生结果**确定性**：同一输入重复派生逐条一致。
5. 缺时间源 → `TIMING_SOURCE_MISSING`；置信度不足 → `ALIGNMENT_LOW_CONFIDENCE`；
   两者都使该课时/阶段 **blocked（不可发布）**，系统**不猜、不 clamp、不估算**。
6. 导入生成**时间审计报告**（毫秒、`mm:ss.mmm`、邻近文本），Operator 在 Sandbox
   播放复核；人只复核，不输入时间。

> 本示范的 cue 与章节位置是机器均布/演示位置，用于展示“字幕优先”和“章节”两条
> 派生路径，**不代表语义级口播对齐**。生产包应由 ASR（默认兜底）或经复核的字幕/章节
> 提供真实位置。

---

## 6. 构建与验收

依赖：`ffmpeg` / `ffprobe`、Node（`server/node_modules` 已装 `xlsx`）、Python 3。

一键重建（从旧包）：

```bash
cd docs/package-examples/modeling-life-v2
python3 -I build/build_package.py \
  --old-zip "/path/to/Modeling life内容文件.zip"
```

只重建 lite（快速迭代）：追加 `--skip-full`。脚本只写 `lite/`、`full/` 与
`/tmp/modeling-life-v2-build/`。

静态验收（每次构建后运行，full 与 lite 各一次）：

```bash
python3 -I build/verify_package.py \
  --package lite/modeling-life-v2-lite.lgcourse.zip --expect lite
python3 -I build/verify_package.py \
  --package full/modeling-life-v2-full.lgcourse.zip --expect full
```

检查内容：manifest 为 v2、无哈希字段、闭合包与大小、9 张机器 sheet 且**无时间列**、
Media ↔ `resources[]` 一一对应、分类/courseKey 一致、无环境 UUID、SRT 可解析且 cue
在真实时长内、MP4 章节轨存在且标题等于学习点、rendition 满足 `0 ≤ start < end ≤ duration`、
verified 对齐带完整审计元组。

深度验收（用**真实 Part C 编译器**，必须在 `server/` 下运行）：

```bash
cd server
# full（构建后存在 full/package/）
TS_NODE_TRANSPILE_ONLY=1 TS_NODE_PROJECT="../docs/package-examples/modeling-life-v2/build/tsconfig.verify.json" \
  npx ts-node "../docs/package-examples/modeling-life-v2/build/verify_with_compiler.ts" \
  --dir "../docs/package-examples/modeling-life-v2/full/package" --server-dir "$(pwd)"

# lite（先解压 zip）
rm -rf /tmp/ml-lite && mkdir -p /tmp/ml-lite
python3 -c "import zipfile;zipfile.ZipFile('../docs/package-examples/modeling-life-v2/lite/modeling-life-v2-lite.lgcourse.zip').extractall('/tmp/ml-lite')"
TS_NODE_TRANSPILE_ONLY=1 TS_NODE_PROJECT="../docs/package-examples/modeling-life-v2/build/tsconfig.verify.json" \
  npx ts-node "../docs/package-examples/modeling-life-v2/build/verify_with_compiler.ts" \
  --dir /tmp/ml-lite --server-dir "$(pwd)"
```

它真实执行 `parsePackage → validatePackage → deriveTiming → alignPackage`，并断言
L001/L002 学习点时间与 manifest 中冻结的 rendition 逐毫秒一致。

当前结果（2026-11-13）：

- 静态检查：**63/63 PASS**（full 与 lite 各一次）。
- 编译器深度检查：**errors = 0**；L001 与 L002 的 LP 时间与 manifest **MATCH**；
  时间源实际使用 `subtitle`（L001）与 `chapter`（L002）。
- 非阻断项：`incomplete = 13`（9 条 `TIMING_SOURCE_MISSING`：7 条 zh-CN 学习点无媒体载体
  + 2 条 DOCX 结构锚点未在检查中提供；4 条 `CONTENT_INCOMPLETE`：正文 HTML 未提供）；
  warnings：lite 2 条 `ALIGNMENT_UNBOUND`，full 另加 2 条 `TIMING_WINDOW_LARGE`。
  均不阻断导入，但会阻止“所有阶段都发布”。

### 阶段 D：真实导入（scratch 库 `learning_guide_example`，2026-11-13）

用真实 HTTP 导入端点（`POST /api/backoffice/courses/import` → `confirm`）跑通了
除「携带 verified 对齐」外的全部链路；**交付包本身首次导入当前是 BLOCKED**，
如实记录如下（脚本：`build/verify_phase_d.e2e-spec.ts`）：

| 检查 | 结果 |
|---|---|
| 包红线（真实 zip 字节） | PASS：hash 键 0、UUID 0、9 张机器 sheet 无时间列、无 `timing.json` |
| 上传校验 | PASS：`AWAITING_CONFIRM`，0 error，15 warning（9 TIMING_SOURCE_MISSING + 4 CONTENT_INCOMPLETE + 2 ALIGNMENT_UNBOUND） |
| 确认导入（交付包） | **BLOCKED**：HTTP 500，`pc_alignment_creation_guard`（`23514` "alignment … created by import must start as proposed"）。导入层按 C10.2 试图携带包内 verified 对齐（`provenance=import` + `status=verified`），与触发器「provenance≠human 创建时必须 proposed」冲突；事务原子回滚，0 行残留 |
| 对照组（同内容、仅 `content.alignments=[]`） | PASS：`READY`，课程/分类（`Science`）/3 stages 落库；7 个视频坐标与出厂 manifest **逐毫秒一致**（L001 subtitle 5 条、L002 chapter 2 条）；`provenance` 随作业落库（`sourceEnv=sandbox`、`sourceVersionLabel=1.0`）；媒体时长探测 15000 ms；重复确认不产生第二门课程 |
| 9 个 F4 坏包 | PASS：9/9 fail-closed（`PACKAGE_MANIFEST_INVALID`/`PACKAGE_FILE_UNKNOWN`/`PACKAGE_FORMAT_UNSUPPORTED`/`CODE_DUPLICATE`/`TIMING_RANGE_INVALID`/`REFERENCE_UNRESOLVED`/`MEDIA_BINDING_MISSING`），课程/分类/阶段计数不变 |

结论：示范包内容、模板、媒体、字幕/章节时间派生均可真实导入；唯一阻断在
「新环境首次导入时把包内 verified 对齐原样携带」与 DB 创建触发器的冲突
（Part C 签收链路的修复项）。产品演示若需完整 `READY`，暂用对照组路径；
修复落地后重跑本脚本即可验证交付包的 `READY`。

---

## 7. 示范值与已知偏差（透明标注）

manifest 的 `annotations` 里逐项写明；摘要：

1. **demo provenance**：`planPin`、`approvalRef`、`auditSummaryRef` 是演示值，
   不对应真实 Plan/审批/审计记录；`sourceEnv=sandbox`、`sourceVersionLabel=1.0`。
2. **demo 签名**：所有 alignment 的 `verifiedBy/verifiedAt/verifiedAgainst` 是演示
   Operator 值（`demo-operator@example.com`），用于展示 verified 形状，不是真实人签。
3. **zh-CN KT/AT 与 6 条文本展品正文**：旧包只有英文；示范用中文由本包作者撰写
   （非机翻），在 `annotations.demoValues.zhCnText` 标注，待内容团队复核。
   学习点登记 en-GB + zh-CN 双语标题（中文来自旧 docx），但 zh-CN 没有视频/文档载体，
   因此不派生 zh-CN 媒体锚点（编译器报 incomplete，不阻断导入）；
   中文学习点标题同时保存在 `annotations.learningPointTitlesZh`。
4. **证据规格**：示范包使用 `artifact` 证据（提交书面答案/解答）以保持契约闭合；
   真实生产包应把 KT/AT 以 `assessment` evidence + assessment 对齐绑定到题目 block。
5. **媒体尺寸**：封面 1844 px、多数 docx 内嵌图长边 < 2000 px（媒体规格建议值）。
   构建器**不放大、不重写**教学媒体（C0 红线⑤：媒体是既成输入）；建议内容方换原图。
6. **lite 包**：视频截短到 15 s；图像/文档保持原样。full 包保留真实视频/图片，
   仅 L002 注入章节轨元数据。lite 仅用于演示与入库，不是交付母版。
7. **L002 章节位置**：0 与 50% 时长为演示位置；`TIMING_WINDOW_LARGE` 为长间隔提示，
   不阻断导入。

---

## 8. 红线核对（构建器与 verify 共同保证）

| # | 红线 | 落点 |
|---|---|---|
| R1 | 模板无任何时间列 | `build_workbook.mjs` 写入前断言；verify 按 `TIME_COLUMN_HEADER_PATTERN` 全 sheet 检查 |
| R2 | 无任何内容哈希/digest | manifest schema `strictObject` 拒绝未知字段；verify 递归扫描 `sha256/checksum/digest` |
| R3 | 无环境 UUID | 所有 assetKey/stageKey/renditionKey 为语义稳定键；verify 用 UUID 正则扫描 |
| R4 | 闭合包 | 构建后 `manifest.resources` ↔ ZIP 条目 1:1，大小逐字节校验 |
| R5 | 旧格式拒绝 | 只写 `formatVersion:2` / `templateVersion:2`；无 `course.category` / `checksums` |
| R6 | 每个视频×语言有机器时间源（ALN-7） | L001 SRT、L002 chapter track；编译器实际派生成功 |
| R7 | 分类只写稳定键 | `categoryPath=["Science"]`；course/content 逐字节相等 |
| R8 | 只有 verified 进冻结内容 | `content.alignments` 全为 verified 且带审计三件套 |
| R9 | 媒体不加工 | 不改封面/展品；仅 lite 的 15 s 视频截短（标注）与 L002 章节轨注入 |
| R10 | provenance 不参与身份 | 只用于来源判定与追溯；`annotations` 记录全部 demo 说明 |

---

## 9. 文件清单

| 路径 | 说明 |
|---|---|
| `README.md` | 本文件：包怎么用、结构逐项、谁填什么、验收结果 |
| `GUIDE-for-producers.md` | 制作方填写手册（逐 sheet 逐列 + 常见错误 + 自检清单） |
| `GUIDE-for-product.md` | 产品演示脚本（4 个卖点 + lite 包完整步骤） |
| `OLD-vs-V2.md` | 旧包 vs v2 示范包一页对照 |
| `PLAN.md` | 阶段 A 的盘点与映射计划（决策记录） |
| `build/build_package.py` | 一键重建（真源脚本） |
| `build/build_workbook.mjs` | 生成 `template.xlsx`（列与契约同源） |
| `build/verify_package.py` | 静态验收（63 项） |
| `build/verify_with_compiler.ts` | 用真实 Part C 编译器深度验收 |
| `lite/modeling-life-v2-lite.lgcourse.zip` | 入库的演示包（13 MB） |
| `full/modeling-life-v2-full.lgcourse.zip` | 本地构建产物（161 MB，`.gitignore` 排除） |
| `full/package/` | 解包目录，便于本地查看（`.gitignore` 排除） |
