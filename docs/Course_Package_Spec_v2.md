# Learning Guide 课程资源包规格 v2（Course Package Spec）

- 版本：packageFormat = 2 · templateVersion = 2 · snapshotFormat = 3
- 状态：定稿（与设计文档 §14 Part C 一致）
- 适用范围：Admin 导出/导入、内容团队交付、跨环境传输
- 关键词：**MUST / MUST NOT / SHOULD**（按 RFC 2119 语义）

## 1. 总则

1. 课程包是一个 ZIP 文件（扩展名 `.zip` 或 `.lgcourse.zip`），根目录包含 `manifest.json` 与模板工作簿。
2. 包是**闭合契约**：包内每个文件都必须在 `manifest.json` 声明；声明但缺失、存在但未声明、路径越界（`..`、绝对路径）均为错误，整包拒绝。
3. 旧格式一律拒绝：`formatVersion ≠ 2` → `PACKAGE_FORMAT_UNSUPPORTED`；模板缺少 `templateVersion=2` → `TEMPLATE_FORMAT_UNSUPPORTED`。**不提供兼容层。**
4. 包与导入**不使用任何内容哈希/digest**：包身份 = `(formatVersion, course.courseKey, content.versionNo)`；传输完整性由 ZIP 自带 CRC32 + 文件大小/类型校验保证。
5. `exportedAt` 等元信息 MAY 出现在 manifest 的 `annotations` 中，MUST NOT 参与包身份、幂等与 staleness 判定。
6. 同一 `(course.courseKey, content.versionNo)` 重复导入 MUST 为 no-op（天然幂等）；不同版本导入按"整包替换草稿 + 写后删差集"处理。

## 2. ZIP 结构（示例）

```text
C001_4.lgcourse.zip
├── manifest.json                 # 必需，唯一入口
├── template.xlsx                 # 必需，templateVersion=2
├── lessons/
│   ├── L001.docx                 # 课时脚本/正文
│   └── L002.docx
├── media/
│   ├── cover.png                 # 课程封面
│   ├── L001-video-en.mp4         # 视频（按资产声明路径，不依赖文件名语义）
│   ├── L001-exhibit-1.png
│   └── L001-exhibit-1-thumb.png  # 方形缩略图
├── subtitles/
│   └── L001.en-GB.srt            # 时间派生源（有视频锚点时必须）
└── chapters/
    └── L001.json                 # 或使用 MP4 chapter track（二选一）
```

- 文件名与目录 MAY 任意命名；语义只来自 `manifest.content.renditions[]` /
  `manifest.content.assetPins[]` 的 `assetKey + assetVersion` 与模板中的稳定
  code，MUST NOT 从文件名/目录推断任何含义。
- 不包含：`timing.json`（导入时派生的内部产物）、任何哈希清单、环境 ID、学员数据、订单与学习记录。

## 3. manifest.json

契约 SSOT：`server/src/partc/contracts/package-manifest.ts`（Zod `strictObject`；
本文与该 schema 不一致时以 schema 为准）。manifest 是**嵌套**结构：课程身份在
`course`，冻结内容在 `content`，文件清单在 `resources`。

```jsonc
{
  "format": "lg-course-package",
  "formatVersion": 2,
  "packageId": "pkg_C001_4",          // 可选，稳定 token
  "exportedAt": "2026-11-12T08:00:00Z", // 可选；不参与内容身份
  "minReaderVersion": 2,              // 读取器最低能力
  "extensionsUsed": [],               // 可用可忽略
  "extensionsRequired": [],           // 不认识就拒绝整包
  "course": {
    "courseKey": "C001",              // 稳定键，跨环境不变
    "titleLocalized": { "en-GB": { "title": "C001 title" }, "zh-CN": { "title": "课程标题" } },
    "categoryPath": ["Science"],      // 稳定键路径；null = 未分类
    "learningLanguages": ["en-GB"],   // BCP 47，有序回退链
    "studyMode": "video"              // video | text | both
  },
  "content": {                        // ContentVersionContent（冻结内容，只含稳定键）
    "courseKey": "C001",
    "versionNo": 4,                   // 单调递增整数，由导出方分配
    "categoryPath": ["Science"],      // MUST 与 course.categoryPath 相同
    "stages": [ /* Stage[]，至少 1 个（C3） */ ],
    "prerequisiteEdges": [ /* PrerequisiteEdge[] */ ],
    "specPins": [ /* {contentKey, version}[] */ ],
    "renditions": [ /* Rendition[] */ ],
    "alignments": [ /* VerifiedAlignment[]，只允许 verified */ ],
    "evidenceSpecs": [ /* EvidenceSpec[] */ ],
    "assetPins": [ /* {assetKey, assetVersion}[] */ ]
  },
  "resources": [
    { "id": "template", "kind": "template", "path": "template.xlsx", "size": 18440 },
    { "id": "cover",     "kind": "cover",    "path": "media/cover.png", "size": 184400 },
    { "id": "L001-video-en", "kind": "video", "path": "media/L001-video-en.mp4", "size": 139718382 },
    { "id": "L001-script",   "kind": "document", "path": "lessons/L001.docx", "size": 51200 }
  ],
  "provenance": {
    "sourceEnv": "sandbox",            // sandbox | production（服务端强制判定，不看文件名）
    "sourceVersionLabel": "4.2",       // Sandbox X.Y / Production Version N
    "exportedAt": "2026-11-12T08:00:00Z",
    "exportedBy": "operator@example.com",
    "courseKey": "C001",
    "planPin": { "planId": "PL-0007", "planVersion": 3 },
    "approvalRef": "APR-0003",
    "auditSummaryRef": "audit/2026-11-12-C001-4.2.json",
    "asr": { "modelVersion": "asr-2026-01", "params": {}, "ruleVersion": "asr-v1" }
  },
  "annotations": { "exportedBy": "admin", "slug": "c001" }
}
```

`resources[]` 形状固定为 `{ id, kind, path, size }`：`id` 是稳定资源 id（媒体 =
`assetKey`，文档/模板 = 稳定文档 id），`path` 是包内相对路径，`size` 是字节数
（由 ZIP 条目大小校验，不引入摘要）。`resources[].kind ∈ template | document |
cover | video | audio | image | model3d | thumbnail | lesson-text | subtitle |
chapters`。媒体与内容的关联只来自 `content.renditions[]` / `content.assetPins[]`
中的 `assetKey + assetVersion`，不从文件名/目录推断。

`content` 与 `contentVersionContent` 契约同构（设计 §14 C3）：
`stages[]`、`prerequisiteEdges[]`、`specPins[]`、`renditions[]`、
`alignments[]`（**只允许 verified**，含 `verifiedBy/verifiedAt/verifiedAgainst`
审计元组与派生 `sourceKind/sourceArtifact/modelVersion/params/ruleVersion`）、
`evidenceSpecs[]`、`assetPins[]`。导出时只写“能被本包表达”的 verified 对齐
（stage/rendition 均在包内、objective 属于该 stage、`verifiedAgainst` 与导出
revision/carrierVersion/spec pin 一致）；其余不伪造、不写入包。

`provenance` 为 v2 导出方 MUST 写入的块；解析端在
`PACKAGE_SOURCE_ENFORCEMENT` off（休眠）时接受缺省以保持既有导入行为，on 时
生产环境缺 provenance 或非 `sandbox` 来源一律整包拒绝并返回
`PACKAGE_SOURCE_NOT_ALLOWED`。来源判定只认该字段，不依据文件名/路径/目录结构。
`provenance` 与 `annotations` 都不参与包身份、幂等与 staleness 判定；
`annotations` 是自由 JSON 对象（`z.record`），用于随包携带审计/导出元数据。

规则：

- `assetKey` 在包内唯一且稳定。manifest 的 `resources[]` 不携带 `thumbnailOf`
  等语义字段（固定为 `{id, kind, path, size}`）；缩略图与主资源的关联在模板
  Media sheet 的 `thumbnail_of` 列登记（内容侧对账用，manifest 为准）。
- `language` 用 BCP 47（内容载体语言）；`lessonCode` 指向模板中的课时稳定 code。
- 未知的 `extensionsRequired` MUST 导致整包拒绝；`extensionsUsed` 未知项 MAY 忽略但原样保留。
- **无 `sha256`/`checksum`/`digest` 字段**（规格层面禁止）。

### 3.1 环境与来源（annotations，不参与身份）

`annotations` MAY 携带以下环境信息，MUST NOT 参与包身份、幂等与 staleness 判定：

```jsonc
"annotations": {
  "sourceEnv": "sandbox",              // sandbox | production
  "sourceLabel": "Sandbox 4.2",        // 来源版本标签（PRD Source）
  "exportedAt": "2026-11-12T08:00:00Z",
  "verification": [
    {
      "kind": "timing-audit",
      "lessonCode": "L001",
      "sourceKind": "subtitle",          // subtitle | chapter | asr | forced-alignment
      "sourceArtifact": "subtitles/L001.en-GB.srt",
      "modelVersion": null,              // ASR 时必填
      "params": null,
      "ruleVersion": "time-range-v1",
      "verifiedBy": "operator@example.com",
      "verifiedAt": "2026-11-12T07:50:00Z"
    }
  ]
}
```

- 跨环境导入时，目标环境若按同一 `assetKey + assetVersion` 落地文件（不转码），已验证的对齐保持 verified；若转码/替换文件，相关对齐自动 stale，需要重新派生与确认（Re-confirm）。
- `assetKey` MUST 环境无关（不是环境本地 UUID）；`assetVersion` 在同一 key 下语义一致。

## 4. 模板工作簿（templateVersion = 2）

### 4.1 必备 sheet

| sheet | 用途 | 关键规则 |
|---|---|---|
| Meta | 版本与课程身份 | `templateVersion=2`、courseKey、默认内容语言；**无任何时间字段** |
| Course info | 课程级元数据 | 分类列只填**稳定键**（如 `Science`），显示名由 Admin localized 提供；中英文必填；whatYouLearn/provides |
| Lessons | 课时与学习点 | 课时 code（L001…）、标题/描述中英；学习点 code（1.1…）+ 标题；**无起始时间列** |
| Knowledge test | 知识题 | 每行一题；Question/Reference answer 中英双语列；按 Lesson code 关联 |
| Application test | 应用题 | 每课时一题；双语列 |
| Reading list | 推荐阅读 | 仅英文；type/title/author/why |
| Exhibits | 展品 | exhibit code、kind（image/video/model3d/**text**）、双标题/描述、source、媒体 `assetKey`；**无触发时间列** |
| Media | 媒体清单 | 见 4.2 |
| (Checklist) | 人工工作流 | 可选，不作为导入依据 |

### 4.2 Media sheet（新增，必需）

```text
asset_key | kind | lesson_code | language | relative_path | thumbnail_of
```

- 与 `manifest.resources[]` 一一对应（manifest 为准，模板为内容侧登记；两边不一致 → error）。
- **无 sha256 列**。

### 4.3 枚举与稳定键

- 分类（category）、provides 预设、reading type、exhibit kind 等枚举 MUST 使用稳定 key；显示名 MUST NOT 参与匹配。
- 跨 sheet 关联 MUST 使用稳定 code（Lesson code / Exhibit code），MUST NOT 使用显示标签。

### 4.4 时间（关键）

- 模板中 **MUST NOT 存在任何时间列**（发现时间列 → `HUMAN_TIME_FORBIDDEN`）。
- 学习点/展品触发/试看截止的视频时间由导入服务**机器派生**（每个视频 rendition × 每个语言独立派生）：
  1. 外部字幕 cue（SRT/VTT）优先；2. MP4 chapter track；3. **ASR 默认兜底**（从音轨生成转写与时间，内部派生工件、非交付物）；4. 强制对齐仅在课时显式声明"文本稿=口播稿"时启用；DOCX Heading 仅用于文本锚点。
  5. 点锚点 → 半开区间 `[start, end)`：有字幕 cue 用 cue 区间；否则 `end = 同一 stage 下一锚点 - 1ms`，无下一锚点时 `end = duration`；规则参数随 `ruleVersion` 版本化。
- 时间源缺失 → `TIMING_SOURCE_MISSING`；置信度不足 → `ALIGNMENT_LOW_CONFIDENCE`；二者均使该课时/阶段 blocked（不可发布），错误带源坐标。ASR 模型版本、参数、ruleVersion MUST pin 进 `provenance.asr`；同一输入重复派生 MUST 逐条一致（确定性）。
- 校验：`0 ≤ start < end ≤ duration`（容器探测的真实时长）；越界/负值/空值 → error，带 sheet/row/col 或 JSON pointer。
- 导入生成**时间审计报告**（毫秒、`mm:ss.mmm`、邻近文本），供 Operator 在 Sandbox 播放复核；人只复核，不输入时间。

## 5. 媒体规格（沿用 PRD）

| 类型 | 规格 |
|---|---|
| 视频 | MP4（H.264），最高 1080p，≤ 500 MB，建议 16:9 |
| 图片 | JPG / PNG / WebP，长边 ≥ 2000 px，≤ 20 MB |
| 3D | GLB，≤ 50 MB |
| 缩略图 | 正方形，≥ 400 × 400 px |
| 字幕 | SRT / VTT（UTF-8） |
| 章节 | MP4 chapter track 或 `chapters/*.json`（二选一） |

## 6. 导入行为（闭环）

1. **校验先于清洗**：schema、版本、manifest↔文件一一对应、稳定 code 唯一、引用双向覆盖、语言完整性、时间范围；全部通过后才落库（同一事务；分类解析与课程写入同事务）。
2. **原子性**：任何 error → 整包拒绝，草稿/分类/对齐均不变化；不产生半成品。
3. **不自动修复**：不自动改名、不跳过行、不造占位分类（`Uncategorized`/`Uncategorised` 禁止）、不猜时间。
4. **报告**：所有 error/warning 持久化到导入 job，带源坐标；导入后按 Lessons/KT/AT/Exhibits/Readings 做源-产计数对账。
5. **幂等**：同一 `(course.courseKey, content.versionNo)` 重复导入 no-op；新版本按"替换草稿 + 写后删差集"（只删旧清单记录过且无其他版本引用的资源）。
6. **错误码**：`PACKAGE_FORMAT_UNSUPPORTED`、`TEMPLATE_FORMAT_UNSUPPORTED`、`PACKAGE_FILE_MISSING`、`PACKAGE_FILE_UNKNOWN`、`PACKAGE_SOURCE_NOT_ALLOWED`（生产环境导入非 Sandbox 来源或 provenance 缺失）、`HUMAN_TIME_FORBIDDEN`、`TIMING_SOURCE_MISSING`、`ALIGNMENT_LOW_CONFIDENCE`（时间派生置信度不足，阶段 blocked）、`CATEGORY_NOT_FOUND`、`UNSUPPORTED_ORDERING` 等（完整表见设计文档 §14 C5/C10）。

## 7. 导出行为

- 导出 = 从 ContentVersion 生成同一 v2 形状（manifest + 模板 + 媒体）；分类写 `categoryPath`（未分类为 `null`），绝不写占位分类。
- 同一版本重复导出 MUST 产生语义相同的包（允许 `annotations.exportedAt` 不同，不影响身份）。
- 导出/导入 round-trip MUST 语义等价（内容、结构、媒体引用、语言、分类路径）。

## 8. 不在本包/本版范围

- `timing.json`（派生产物，不交付）、任何哈希清单、环境 UUID、学员/订单/学习记录。
- 价格与试看设置的版本化（属课程设置/支付域，另有规格）。
- choice 容器、多 target、LLM proposed、ASR（v1 延后；出现即拒绝）。
