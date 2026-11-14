# 内容制作方填写手册 · Course Package v2

本手册面向**内容制作方**：你交付内容与素材，平台负责打包、派生时间、校验与上线。
配套的示范包见 [`README.md`](README.md)；新旧格式差异见 [`OLD-vs-V2.md`](OLD-vs-V2.md)。

---

## 0. 你交付什么

| 交付物 | 形态 | 说明 |
|---|---|---|
| 课程内容工作簿 | `template.xlsx`（`templateVersion = 2`） | 9 张机器 sheet，见 §2 |
| 课时正文 | `lessons/*.docx` | 富文本/脚本；只用于正文与**文本锚点**，不提供任何视频时间 |
| 视频 | `media/videos/*.mp4` | H.264，≤1080p，≤500 MB；**真实时长是时间校验的裁判** |
| 图片 / 封面 / 缩略图 | PNG/JPG/WebP | 展品图长边建议 ≥2000 px；缩略图正方形 ≥400×400 |
| 时间源 | 字幕 `subtitles/*.srt`（优先）或章节轨 `chapters/*.json` / MP4 chapter track | 每个视频 × 每个语言都必须有可派生时间源 |
| 3D 模型（如有） | `.glb` | ≤50 MB |

**不要交付**：时间列、毫秒/`mm:ss` 打点、内容哈希清单、环境 ID、学员/订单数据、
`timing.json`。这些要么由机器生成，要么属于运行环境。

---

## 1. 三条铁律

1. **模板里没有时间。** 不要新增 `start/end/time/duration/trigger/时间/时长/秒` 等列，
   也不要把时间写进任何单元格或备注。发现时间列 → `HUMAN_TIME_FORBIDDEN`，整包拒绝。
2. **语义只来自稳定 code。** 学习点、展品、课时、媒体一律用 code / `asset_key` 关联；
   不要用标题、文件名、目录名互相指认。
3. **文件名不携带语义。** `l1-01.png` 只是文件；它代表什么由 Media sheet 的
   `asset_key` 和 Exhibits 的 `exhibit_code` 决定。改名不影响语义，删声明会断链。

---

## 2. 逐 sheet 逐列说明

通用规则：

- 第一行必须是表头，列名与顺序按模板给的原样，不要增删列（未知列会报
  `TEMPLATE_COLUMN_UNKNOWN`；未知 sheet 会报 `TEMPLATE_SHEET_UNKNOWN`）。
- 一行一个“语言变体”：同一内容的中英文各占一行，靠 `language` 区分。
- 不允许合并单元格；不要加说明行、备注行、合计行。
- 空白单元格留空，不要写 `-`、`N/A`、`无`（除字段本身允许空）。

### 2.1 `Meta`

| 列 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `templateVersion` | ✅ | 固定 `2` | 写成 1 或缺失 → `TEMPLATE_FORMAT_UNSUPPORTED` |
| `courseCode` | ✅ | 稳定 slug | 必须与 manifest 的 `course.courseKey` 完全一致（本示范：`modeling-life`） |
| `learningLanguages` | ✅ | 逗号分隔的 BCP 47，按回退顺序 | 本示范：`en-GB,zh-CN`；顺序有意义，第一个是默认载体语言 |
| `studyMode` | ✅ | `video` / `text` / `both` | 本示范：`both` |

### 2.2 `Course Info`

| 列 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `field` | ✅ | `title` / `shortDescription` / `overview` / `whatYouLearn` / `provides` | 封闭词表；每个字段两种语言都要有 |
| `language` | ✅ | `en-GB` / `zh-CN` | 课程元数据**恒为**这两种语言 |
| `text` | ✅ | 非空文本 | `provides` 可写成多条能力，用分号分隔 |

注意：分类**不在这张表里**。分类是 manifest 的 `course.categoryPath`（稳定键路径），
由 Admin 课程设置提供；模板里没有分类列。

### 2.3 `Lessons`

| 列 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `lesson_code` | ✅ | 稳定 code，如 `L001` | 跨 sheet 关联的唯一依据；不要用标题 |
| `order` | ✅ | 正整数 | 课时顺序；同一语言内从 1 开始 |
| `language` | ✅ | BCP 47 | 必须在 `learningLanguages` 中声明 |
| `title` | ✅ | 非空文本 | 该语言的课时标题 |
| `description` | 可选 | 文本 | 该语言的课时简介 |

完整性：`Lessons` 必须覆盖 `learningLanguages` ∪ `{en-GB, zh-CN}` 的每一种语言；
缺行 → `LANGUAGE_MISSING`（incomplete，阻断发布）。
同一 `lesson_code + language` 重复 → `CODE_DUPLICATE`。

### 2.4 `Learning Points`

| 列 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `lesson_code` | ✅ | 已存在的课时 code | 引用不存在的课时 → `REFERENCE_UNRESOLVED` |
| `lp_code` | ✅ | 稳定编号，如 `1.1` | 同一课时、同一语言内唯一 |
| `language` | ✅ | BCP 47 | 必须是已声明语言 |
| `title` | ✅ | 非空文本 | 时间由机器按字幕/章节对齐到标题或正文；**不要加时间列** |

要点：

- 中文学习点也要登记（本示范 7 个学习点 × 2 语言 = 14 行）。
- 如果某个语言没有对应的视频/文档载体，该语言不会派生媒体锚点（系统报
  `TIMING_SOURCE_MISSING` / incomplete），但不会伪造时间。

### 2.5 `Exhibits`

| 列 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `lesson_code` | ✅ | 课时 code | |
| `exhibit_code` | ✅ | 稳定 code，如 `ex-l1-01` | 同一课时、同一语言内唯一；**全语言 `media_type` 必须一致** |
| `media_type` | ✅ | `image` / `video` / `audio` / `model3d` / `text` | `text` 是纯文本展品 |
| `asset_key` | 条件 | Media sheet 中的 `asset_key` | `media_type=text` 时必须为空；其他类型必须非空 |
| `language` | ✅ | BCP 47 | 标题/描述的语言 |
| `title` | ✅ | 非空文本 | 该语言的展品标题 |
| `description` | 可选 | 文本 | 该语言的展品描述；纯文本展品的正文建议写在这里 |
| `source` | 可选 | 文本 | 来源/版权说明 |

常见坑：

- `exhibit_code` 不能占用编译器保留 id：`video`、`body`、`application`、`q.<数字>`、
  `reading.<数字>`（→ `CODE_RESERVED`）。
- 图片展品的标题/描述不会从图片 OCR 得到；必须双行（en-GB / zh-CN）填写。
- 展品在正文中的引用位置、视频触发时间都由机器派生，**展品表里没有触发时间列**。

### 2.6 `Reading List`

| 列 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `lesson_code` | ✅ | 课时 code | |
| `type` | ✅ | `book` / `article` / `paper` / `other` | 稳定枚举 |
| `title` | ✅ | 非空文本 | 阅读标题（可含页码范围） |
| `author` | 可选 | 文本 | 作者/机构 |
| `why` | 可选 | 文本 | 推荐理由 |

推荐阅读**只有英文**（没有 `language` 列），这是规格的既定语义。

### 2.7 `Knowledge Test`

| 列 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `lesson_code` | ✅ | 课时 code | |
| `order` | ✅ | 正整数 | 同一课时、同一语言内唯一 |
| `language` | ✅ | `en-GB` / `zh-CN` | 双语必填 |
| `question` | ✅ | 非空文本 | 题干 |
| `reference_answer` | ✅ | 非空文本 | 参考答案（不是评分脚本） |

完整性：只要该课时有知识题，就必须 en-GB + zh-CN 两套行；缺一套 → `LANGUAGE_MISSING`
（incomplete，阻断发布）。**不要机翻凑数**；没有中文就明确标记待补。

### 2.8 `Application Test`

| 列 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `lesson_code` | ✅ | 课时 code | 每课时每语言**只能有一题** |
| `language` | ✅ | `en-GB` / `zh-CN` | 双语必填 |
| `question` | ✅ | 非空文本 | 应用题题干 |
| `reference_answer` | ✅ | 非空文本 | 参考解答 |

同一 `lesson_code + language` 出现两行 → `CODE_DUPLICATE`。

### 2.9 `Media`（新增，必需）

| 列 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `asset_key` | ✅ | 稳定 key，如 `l1-video` / `ex-l1-01` | 包内唯一；**跨环境不变**，不得是 UUID/自增号 |
| `kind` | ✅ | `cover` / `video` / `audio` / `image` / `model3d` / `thumbnail` / `lesson-text` / `subtitle` / `chapters` | 与文件真实类型一致 |
| `lesson_code` | 条件 | 课时 code | `video/audio/subtitle/chapters/lesson-text` 必须绑定课时 |
| `language` | 条件 | BCP 47 | `video/subtitle/lesson-text` 必须写语言；图片/封面/缩略图可空 |
| `relative_path` | ✅ | 包内相对路径，如 `media/exhibits/l1-01.png` | 不允许绝对路径或 `..` |
| `thumbnail_of` | 可选 | 主资源的 `asset_key` | 缩略图指向主图；指向不存在的 key → `REFERENCE_UNRESOLVED` |

要点：

- Media sheet 必须与 `manifest.resources[]` **一一对应**（导入以 manifest 为准；
  两边不一致 → error）。
- 同一 `kind + lesson_code + language` 只能有一个载体（如一个英文视频）→ 否则
  `MEDIA_AMBIGUOUS`。
- **没有 sha256 列**，也不要提供校验和清单。
- 文件放进 zip 时保留 `relative_path` 的目录结构；不要依赖文件名推断内容。

---

## 3. 素材交付要求

| 素材 | 要求 | 备注 |
|---|---|---|
| 视频 | MP4 / H.264 / ≤1080p / ≤500 MB | 时长会被容器探测，是时间范围校验的唯一裁判；不要裁剪后忘记更新字幕 |
| 图片 | JPG/PNG/WebP，长边 ≥2000 px，≤20 MB | 原图优先；不要用截图放大凑尺寸 |
| 封面 | 同上 | 与课程标题一致 |
| 缩略图 | 正方形 ≥400×400 | 在 Media sheet 用 `thumbnail_of` 绑定 |
| 3D | GLB，≤50 MB | |
| 字幕 | SRT/VTT，UTF-8 | cue 必须落在 `0 ≤ start < end ≤ duration`；文本要能对上学习点/展品标题 |
| 章节 | MP4 chapter track 或 `chapters/*.json` | 二选一；章节标题=学习点标题，起点为整数毫秒 |

时间源优先级（你只需提供其中一种，系统按序选择）：

1. 外部字幕（SRT/VTT）——**推荐**，可读、可复核；
2. MP4 chapter track；
3. ASR 默认兜底（系统从音轨生成，内部工件，不需你交付）；
4. 强制对齐（仅当课时显式声明“文本稿=口播稿”）。

**每个视频 × 每个语言都要有来源。** 只有英文视频却有中文学习点时，中文不会派生
媒体锚点（incomplete）；这不是错误数据，但会阻止“全阶段发布”。

---

## 4. 常见错误与修复

| # | 现象 / 错误码 | 根因 | 正确做法 |
|---|---|---|---|
| 1 | `HUMAN_TIME_FORBIDDEN` | 模板里加了时间/时长/触发列，或写了 `mm:ss` | 删掉时间列与时间值；只提供字幕/章节等时间源 |
| 2 | 媒体对不上 / 内容错位；引用不存在的 key 时 `REFERENCE_UNRESOLVED` | 用文件名猜媒体（如把 `l1-02.png` 当“第二个学习点”） | 语义只由 `asset_key` + `exhibit_code` 决定；按 Media/Exhibits 两表绑定 |
| 3 | `CATEGORY_NOT_FOUND` | 分类写成显示名（`科学` / `Science` 混用）或写了不存在的路径 | 只写**稳定键**（本示范 `["Science"]`）；导入不创建分类，查不到整包拒绝 |
| 4 | `LANGUAGE_MISSING`（incomplete） | Lessons/Course Info/KT/AT 缺中文或英文行 | 每个字段/课时/测评补齐 en-GB + zh-CN；不要用机翻 |
| 5 | `CODE_DUPLICATE` | 同一 `lesson_code+language` 下 `lp_code`/`exhibit_code`/KT `order`/AT 重复 | code 在同一作用域内唯一；改 code，不要靠改标题绕过 |
| 6 | `PACKAGE_FILE_MISSING` | manifest 声明了文件但 zip 里没有 | 打包时按 `resources[].path` 收齐文件 |
| 7 | `PACKAGE_FILE_UNKNOWN` | zip 里有 manifest 未声明的文件（含 `.DS_Store`、锁文件） | 删除临时文件，或补声明（通常应删除） |
| 8 | `REFERENCE_UNRESOLVED` | Exhibit 的 `asset_key` 不在 Media；`thumbnail_of` 指向不存在；LP 引用未知课时 | 先建 Media 行，再在 Exhibit/缩略图引用 |
| 9 | `MEDIA_BINDING_MISSING` | 视频/字幕/正文没写 `lesson_code` 或 `language` | 按 §2.9 补齐绑定 |
| 10 | `MEDIA_AMBIGUOUS` | 同一课时同一语言放了两个视频/两个字幕 | 每个槽位只留一个载体；多余版本用新 `asset_key` 另行管理 |
| 11 | `TEMPLATE_FORMAT_UNSUPPORTED` | `templateVersion` 不是 2 | 用平台提供的 v2 模板，不要复用旧模板 |
| 12 | `PACKAGE_FORMAT_UNSUPPORTED` | 交的是 v1 旧包 / 带 `course.category` 字符串 / 带 `checksums` | 用 v2 重出；旧包没有兼容层 |
| 13 | `CODE_RESERVED` | `exhibit_code` 用了 `video`/`body`/`application`/`q.1`/`reading.1` | 换一个业务 code，如 `ex-l1-01` |
| 14 | 导入成功但发布被拒 | incomplete（缺语言/缺正文/缺证据）或时间源不足 | 看 job report 的 incomplete/warning；补齐内容或时间源后再发布 |

---

## 5. 提交前自检清单

工作簿：

- [ ] `Meta.templateVersion = 2`，`courseCode` 与 manifest 的 `course.courseKey` 一致。
- [ ] `learningLanguages` 与 `studyMode` 与 manifest 完全一致。
- [ ] 9 张 sheet 名称、列名、列序与模板一致，没有增删列。
- [ ] 全表搜索 `start / end / time / duration / trigger / 时间 / 时长 / 秒 / mm:ss`
      无命中（表头与单元格都查）。
- [ ] `Course Info` 5 个字段 × en-GB/zh-CN 齐全。
- [ ] 每个课时在 `Lessons` 中覆盖所有声明语言 + en-GB/zh-CN。
- [ ] 学习点 `lp_code` 在同一课时同一语言内唯一；中英文各一行。
- [ ] 展品 `exhibit_code` 唯一，且全语言 `media_type` 一致；`text` 无 `asset_key`。
- [ ] KT 的 `order` 在课时+语言内唯一；KT/AT 双语齐全；AT 每课时每语言仅一题。
- [ ] 推荐阅读只提供英文，`type` 用枚举值。

Media 与文件：

- [ ] `Media` 每一行都有 `asset_key`、`kind`、`relative_path`。
- [ ] `video / subtitle / lesson-text` 都写了 `lesson_code` 与 `language`。
- [ ] 同一 `kind + lesson + language` 只有一个文件。
- [ ] `thumbnail_of` 指向存在的图片 `asset_key`。
- [ ] `asset_key` 全局唯一、语义化、跨环境稳定（不是 UUID/自增）。
- [ ] 所有 `relative_path` 是包内相对路径，无 `..`、无绝对路径。
- [ ] zip 里的文件与 Media/`resources[]` 一一对应，没有多余临时文件。
- [ ] 没有任何 `sha256` / `checksum` / `digest` 文件或列。

时间源：

- [ ] 每个视频 × 每个语言都有字幕或章节（或确认允许走 ASR 兜底）。
- [ ] 字幕 cue 都在真实时长内；文本能对应学习点标题/展品标题。
- [ ] 章节标题 = 学习点标题；章节起点单调递增且在时长内。
- [ ] 没有手工打点、没有估算时长、没有把时间写进 docx 正文冒充数据。

分类与环境：

- [ ] 分类只写稳定键路径（如 `["Science"]`），目标环境存在该 ACTIVE 分类。
- [ ] 没有环境 UUID、环境本地 ID、学员/订单数据。
- [ ] `provenance.sourceEnv` 由导出环境填写（Sandbox 包才能进生产）。

---

## 6. 你不需要做的事

- 不需要算时间、填时间、检查时间范围——机器做，且会用真实容器时长强校验。
- 不需要生成 manifest、不需要计算文件大小或校验和。
- 不需要决定对齐是否 verified——那是 Operator 在 Sandbox 播放复核后的签收。
- 不需要为旧格式做兼容——v1 包会被直接拒绝，请用 v2 重出。
