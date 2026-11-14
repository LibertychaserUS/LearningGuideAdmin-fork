# Modeling life v2 示范包 · 阶段 A 映射计划

- 状态：阶段 A 完成（盘点 + 映射计划）；阶段 B（构建）与阶段 C（验证）已完成 —— 见 `README.md` 与 `build/` 下的构建/验收脚本
- 构建产物：`lite/modeling-life-v2-lite.lgcourse.zip`（入库）、`full/modeling-life-v2-full.lgcourse.zip`（本地，不入库）
- 实际落地与阶段 A 计划的差异：L002 使用 **MP4 chapter track**（ffmpeg 注入）而非 `chapters/*.json`；资源数 38（template + 37 媒体/文档/时间源）；其余映射按本计划执行
- 输入旧包：`Modeling life内容文件.zip`（157 MB，Owner 提供，原始素材）
- 规格依据：`docs/Course_Package_Spec_v2.md`（packageFormat=2 / templateVersion=2 / snapshotFormat=3）
- 设计依据：`docs/Course_Category_Single_Source_Design.md` §14 C0–C17
- 契约 SSOT：`server/src/partc/contracts/`（manifest / template-v2 / content-version / rendition / alignment / evidence-spec / stage）
- 输出目录：`docs/package-examples/modeling-life-v2/`（本阶段只写本目录与 `/tmp` 构建目录，不改 Admin/Portal 实现代码）

---

## 0. 结论摘要

1. 旧包可完整清点：2 docx、2 mp4、5 png、1 个真实 xlsx（课程信息表）+ 1 个 Office 锁文件；另有 macOS `__MACOSX` 与 `.DS_Store` 噪声，全部不属于交付。
2. 课程模型可完整抽取：2 课、**7 个学习点**、**35 个展品（29 个有图，6 个纯文本）**、**26 道知识题**、**2 道应用题**、阅读清单、双语元数据（课程/课时/学习点/展品）。
3. 旧包的时间列**不可用且不可信**：9 个旧时间值中 7 个按 Excel 日分数解释后超过真实视频时长（详见 §2.6）。这直接印证 v2 红线：旧时间一律丢弃，时间只能由字幕/章节/ASR 机器派生。
4. 旧包只有 1 个真实 xlsx（课程信息），**不含 v2 模板**；`docs/Course_Content_Template_modeling_life.xlsx` 是旧 v1 模板（含 `Start · EN video` / `Trigger · EN video` 时间列），只能作为内容参考，**不得进入 v2 包**。
5. 29 个展品图里有 27 个来自 docx 内嵌图，长边普遍低于 v2 媒体规格 2000 px；2 个展品图（1.2 / 1.4）与封面在包内为独立 PNG。需要决定“向内容方要原图”或“示范用 Lanczos 放大”，见 §8。
6. 示范包建议资源总数 **39**（template + 38 媒体/文档/时间源），使用 `courseKey=modeling-life`、`categoryPath=["Science"]`、`learningLanguages=["en-GB","zh-CN"]`（有序回退链；中文视频 N/A）、`studyMode=both`、`versionNo=1`。
7. 时间源策略：**L001 用外部字幕 SRT（优先级 ①）**，**L002 用包内 chapters JSON（优先级 ②）**，正好在一个示范包里同时展示两条机器派生路径；两段视频本身都无字幕轨/章节轨。

---

## 1. 红线与不可协商项

来自规格 §1、§4.4、§8 与设计 C0：

| 编号 | 红线 | 本计划落点 |
|---|---|---|
| R1 | 模板中 **MUST NOT** 出现任何时间列（`HUMAN_TIME_FORBIDDEN`） | v2 模板无 `start/trigger/time/duration` 列；旧时间全部丢弃 |
| R2 | 全系统 **不使用任何内容哈希/digest** 作为身份、工件绑定或校验清单 | manifest / 模板 / Media 均无 `sha256/checksum/digest`；完整性靠 ZIP CRC32 + size/type |
| R3 | **不得出现环境 UUID**；资产身份 = `assetKey + assetVersion` | assetKey 用语义稳定键（如 `l1-video`、`ex-1-02`），非环境本地 id |
| R4 | 包是**闭合契约**：manifest 声明的文件必须存在，存在文件必须声明 | 构建后逐项对账；剔除 `__MACOSX`、`.DS_Store`、`~$` 锁文件 |
| R5 | **旧格式一律拒绝**，不做兼容层 | 不写 `formatVersion:1`、`templateVersion:1`、`course.category`、`checksums` |
| R6 | 每个视频 rendition × 每个语言必须有机器时间源（ALN-7） | L001 SRT、L002 chapters JSON；provenance/annotations 记录 sourceKind 与 ruleVersion |
| R7 | 分类只写稳定键路径；未分类为 `null`，禁止占位分类 | `categoryPath: ["Science"]`（若 Admin 稳定键不同则替换） |
| R8 | 对齐只有 `verified` 可进发布；verified 必须有人签收 | 阶段 B 由示范 Operator 在 Sandbox 播放复核后签收 |
| R9 | 媒体是既成输入；机器只做对齐/选择/布局/检查/留痕 | 不从视频切片/转码；图像只在必要时做示范用尺寸处理并记录 |
| R10 | `provenance` 只用于来源判定与追溯，不参与身份/幂等/staleness | `provenance.sourceEnv="sandbox"`，`annotations` 放审计与展示信息 |

---

## 2. 旧包清点（F1）

### 2.1 ZIP 条目（已按 cp437 → utf-8 修复文件名）

源包 164,976,649 字节。修复后有效交付物如下（已剔除 `__MACOSX/`、`.DS_Store`、Office 锁文件）：

| # | 文件 | 字节 | 角色 |
|---|---|---:|---|
| 1 | `Lesson 1 文本课件.docx` | 3,100,051 | L001 文本课件（含 12 张内嵌 PNG） |
| 2 | `Lesson 2文本课件.docx` | 1,141,651 | L002 文本课件（含 17 张内嵌 PNG） |
| 3 | `Lesson 1视频课件.mp4` | 139,718,382 | L001 视频 |
| 4 | `Lesson 2视频课件.mp4` | 21,124,683 | L002 视频 |
| 5 | `课程封面.png` | 1,750,526 | 课程封面 |
| 6 | `lesson1-exhibit-1.png` | 1,207,457 | 展品 1.2 高清图（咖啡 T,W,V,C） |
| 7 | `lesson1-exhibit-2.png` | 908,422 | 展品 1.4 高清图（三个一维状态空间） |
| 8 | `lesson1-exhibit1缩略图.png` | 1,504,663 | 展品 1.2 方形缩略图 |
| 9 | `lesson1-exhibit2缩略图.png` | 1,158,424 | 展品 1.4 方形缩略图 |
| 10 | `modeling life课程信息.xlsx` | 19,597 | 旧课程信息工作簿（5 sheet） |
| — | `~$modeling life课程信息.xlsx` | 165 | Office 锁文件，**丢弃** |
| — | `__MACOSX/**`、`.DS_Store` | — | macOS 噪声，**丢弃** |

与任务口径的对应：2 docx / 2 mp4 / 5 png / 2 xlsx。其中“模板”实为 `docs/Course_Content_Template_modeling_life.xlsx`（旧 v1 模板，不在 zip 内）；zip 内的第二个 xlsx 是锁文件，不是模板。

### 2.2 视频探测（ffprobe，真实容器）

| 课时 | 时长 | 分辨率 | 视频 | 音频 | 字幕轨 | 章节轨 |
|---|---:|---|---|---|---|---:|
| L001 | 1,469.233 s（24:29.233） | 1920×1080 | H.264 | AAC | 0 | 0 |
| L002 | 1,584.263 s（26:24.263） | 960×544 | H.264 | AAC | 0 | 0 |

结论：旧包**没有任何字幕或章节时间源**。v2 必须补字幕/章节（或 ASR）。两段视频均在 500 MB、1080p 规格内。

### 2.3 图片探测

| 文件 | 尺寸 | 长边 | 备注 |
|---|---:|---:|---|
| `课程封面.png` | 1844×853 | 1844 | 低于 v2 的 2000 px 长边建议 |
| `lesson1-exhibit-1.png` | 2170×725 | 2170 | 合规 |
| `lesson1-exhibit-2.png` | 2169×725 | 2169 | 合规 |
| `lesson1-exhibit1缩略图.png` | 1254×1254 | 1254 | 正方形，≥400 px，合规 |
| `lesson1-exhibit2缩略图.png` | 1254×1254 | 1254 | 正方形，≥400 px，合规 |

docx 内嵌 29 张展品图：长边多在 1000–1900 px，仅少数接近 2000 px（最大 1897 px）。详见 §3.3 与 §8 决策 D8。

### 2.4 旧课程信息工作簿（`modeling life课程信息.xlsx`）

5 个 sheet：`course info`、`Lessons`、`exploration-reading list`、`knowledge test`、`application test`。

- `course info`：分类 `Science`、标题、简述、overview、6 条 what you'll learn、6 条 provides；**只有英文，中文列为空**。
- `Lessons`：2 课、7 个学习点；含 `视频开始节点`（LP）与 `exhibit弹窗触发节点`（展品）两个**旧时间列**；展品只登记了 2 条（E01/E02 占位），与 docx 实际的 35 个展品不符。
- `exploration-reading list`：L001 3 条阅读；无 L002 阅读。
- `knowledge test`：L001 18 题、L002 8 题，共 26 题；**只有英文**。
- `application test`：每课 1 题，共 2 题；**只有英文**。

### 2.5 docx 结构（内容真源）

两个 docx 均无命名样式（`pStyle` 全空），标题通过字号/加粗区分。已按文本模式抽取：

| 课时 | 非空段落 | 内嵌 PNG | 学习点标题 | Exhibit 标题 |
|---|---:|---:|---:|---:|
| L001 | 259 | 12 | 5（1.1–1.5） | 18（Exhibit 1.1–1.18） |
| L002 | 221 | 17 | 2（2.1–2.2） | 17（Exhibit 2.1–2.17） |

docx 同时携带英文与中文（`1.1 <EN>` / `1.1 <中文>`、`Exhibit X.Y` / `展品 X.Y`），是课时/学习点/展品双语的权威来源。

### 2.6 旧时间列缺陷（关键证据）

旧工作簿的时间单元格以 Excel 日分数存储。按 1 天 = 86400 s 解释并与真实时长对比：

| 旧字段 | 原值 | 解释为时刻 | 真实时长 | 判定 |
|---|---:|---:|---:|---|
| 1.1 视频开始 | 6.944444e-3 | 00:10:00.000 | 24:29.233 | 值本身合法 |
| 1.1 展品1触发 | 2.569444e-2 | 00:37:00.000 | 24:29.233 | **越界** |
| 1.1 展品2触发 | 0.111111 | 02:40:00.000 | 24:29.233 | **越界** |
| 1.2 视频开始 | 0.286111 | 06:52:00.000 | 24:29.233 | **越界** |
| 1.3 视频开始 | 0.407639 | 09:47:00.000 | 24:29.233 | **越界** |
| 1.4 视频开始 | 0.712500 | 17:06:00.000 | 24:29.233 | **越界** |
| 1.5 视频开始 | 0.815972 | 19:35:00.000 | 24:29.233 | **越界** |
| 2.1 视频开始 | 6.944444e-3 | 00:10:00.000 | 26:24.263 | 值本身合法 |
| 2.2 视频开始 | 0.836111 | 20:04:00.000 | 26:24.263 | **越界** |

旧 v1 模板还把其中两个单元格显示成 `00:10`、`06:52`（把日分数误读成 mm:ss），同一列内混用两种解释，进一步证明旧时间不可用。

**决策 D1：旧时间 100% 丢弃，不迁移、不 clamp、不重解释。** v2 包内不出现任何旧时间字段；时间由 §4.6 的机器来源重新派生。

---

## 3. 课程模型抽取

### 3.1 课程身份

| 字段 | 值 | 来源/说明 |
|---|---|---|
| courseKey | `modeling-life` | 稳定 slug；旧 `C001` 是 Admin 课程编号，不是稳定键（D7） |
| packageId | `pkg_modeling-life_v1` | 可选稳定 token |
| versionNo | `1` | 示范包首个版本 |
| categoryPath | `["Science"]` | 旧分类显示名；需确认 Admin 稳定键（D6） |
| learningLanguages | `["en-GB", "zh-CN"]` | 有序回退链；`zh-CN` 必须声明，否则双语元数据/KT/AT 行触发 `LANGUAGE_UNDECLARED`。中文视频 N/A（旧 Checklist） |
| studyMode | `both` | 视频 + 文本双模式 |
| titleLocalized | en-GB `Modeling life` / zh-CN `建模生命` | 中文标题为已授权的展示用元数据 |
| 双语元数据 | 课程 5 字段、课时、学习点、展品均 en-GB + zh-CN | 课程级中文来自 `course_content.json`（已作者化）；KT/AT 中文见 D2 |

### 3.2 七个学习点

| 课时 | LP code | 英文标题 | 中文标题 |
|---|---|---|---|
| L001 | 1.1 | State Variables and State Spaces | 状态变量与状态空间 |
| L001 | 1.2 | Defining Vectors | 向量的定义 |
| L001 | 1.3 | State Space Rules for Operating with Vectors | 状态空间中的向量运算规则 |
| L001 | 1.4 | Vectors And Vector Spaces | 向量与向量空间 |
| L001 | 1.5 | Vectors and Trajectories Change in State Space, Time Series Translation | 向量与轨迹：状态空间中的变化，时序转换 |
| L002 | 2.1 | Pitchfork Bifurcation in a Model of Public Opinion | 舆论模型中的叉式分岔 |
| L002 | 2.2 | Transcritical Bifurcation | 跨临界分岔 |

### 3.3 三十五个展品（29 图 + 6 纯文本）

图片归属按 docx 中“图后紧跟 Exhibit 标题”的顺序判定。`pkg` = 包内独立高清 PNG；`docx` = 从对应 docx 解出的内嵌 PNG。

| 课时 | Exhibit | 标题（EN，截断） | 类型 | 图源 | 字节 | 尺寸 |
|---|---|---|---|---:|---|---:|---|
| L001 | 1.1 | Constellation diagram used as an introductory illustration | image | docx | 1,780,157 | 1024×1024 |
| L001 | 1.2 | A cup of coffee described by four state variables (T, W, V, C)… | image | pkg | 1,207,457 | 2170×725 |
| L001 | 1.3 | States Have Units | **text** | — | — | — |
| L001 | 1.4 | Three examples of one-dimensional state spaces… | image | pkg | 908,422 | 2169×725 |
| L001 | 1.5 | Dynamic System and State Variable | **text** | — | — | — |
| L001 | 1.6 | A one-dimensional state axis: the state is X = 4 at time t₁ and X = 6 at time t₂ | image | docx | 5,714 | 1112×113 |
| L001 | 1.7 | Three two-dimensional state spaces: shark–tuna, insulin–glucose, susceptible–infected | image | docx | 20,043 | 1112×280 |
| L001 | 1.8 | A three-dimensional state space with shark, tuna and plankton axes… | image | docx | 585,881 | 1536×1024 |
| L001 | 1.9 | A point (3, 7) in the shark–tuna plane… | image | docx | 18,061 | 1112×301 |
| L001 | 1.10 | Two Vector Operations | **text** | — | — | — |
| L001 | 1.11 | Vector addition: green (1, 3) + blue (8, 4) = red resultant | image | docx | 20,164 | 1112×300 |
| L001 | 1.12 | Scalar multiplication of a vector A by 2, 0.5, −1 and −0.5 | image | docx | 12,317 | 1112×288 |
| L001 | 1.13 | Real Numbers / Complex Numbers | **text** | — | — | — |
| L001 | 1.14 | State Spaces of Increasing Dimension (ℝ, ℝ², ℝ³, ℝⁿ) | **text** | — | — | — |
| L001 | 1.15 | Change of state on a one-dimensional temperature axis… | image | docx | 13,042 | 1112×150 |
| L001 | 1.16 | The Romeo–Juliet plane with states (L, L), (H, H), (H, L)… | image | docx | 481,622 | 1536×1024 |
| L001 | 1.17 | Oscillations in the populations of sharks and tuna over time | image | docx | 45,720 | 1112×313 |
| L001 | 1.18 | Key Concepts | **text** | — | — | — |
| L002 | 2.1 | Lesson cover image: the pitchfork bifurcation… | image | docx | 149,023 | 1826×1216 |
| L002 | 2.2 | The two compartments of the model… | image | docx | 17,162 | 998×208 |
| L002 | 2.3 | The two-compartment diagram with transition rates… | image | docx | 19,980 | 626×235 |
| L002 | 2.4 | The differential equations for the two compartments… | image | docx | 17,946 | 834×296 |
| L002 | 2.5 | The state variable X = (P − N) / 2m… | image | docx | 38,388 | 1897×472 |
| L002 | 2.6 | Converting the two-variable equation into a single-variable equation… | image | docx | 38,824 | 1010×526 |
| L002 | 2.7 | Deriving the form of the transition rate K_NP… | image | docx | 31,104 | 388×559 |
| L002 | 2.8 | Expressing N and P in terms of X… | image | docx | 115,939 | 1142×830 |
| L002 | 2.9 | The vector field X′ versus X for a = 0.8 / 1.5 / 2.2… | image | docx | 133,084 | 1596×1105 |
| L002 | 2.10 | From one stable equilibrium to three (S-U-S)… | image | docx | 129,318 | 1134×984 |
| L002 | 2.11 | The bifurcation diagram of the pitchfork bifurcation… | image | docx | 64,044 | 926×576 |
| L002 | 2.12 | The Allee-effect model X′ = 0.1X(X/a − 1)(1 − X/k)… | image | docx | 64,986 | 1400×422 |
| L002 | 2.13 | State space with the Allee effect for a < k… | image | docx | 10,515 | 1584×301 |
| L002 | 2.14 | State space with the Allee effect for a > k… | image | docx | 10,646 | 1600×351 |
| L002 | 2.15 | The two cases compared, a < k and a > k… | image | docx | 25,224 | 1613×697 |
| L002 | 2.16 | Definition of a bifurcation… | image | docx | 19,282 | 1450×118 |
| L002 | 2.17 | The transcritical bifurcation diagram… | image | docx | 196,412 | 1776×571 |

计数：L001 = 18（12 图 + 6 文本），L002 = 17（17 图 + 0 文本）；合计 35（29 图 + 6 纯文本）。

**注意**：v2 校验器要求纯文本展品的 `description` 非空，否则该 block 不生成并报 `CONTENT_INCOMPLETE`。6 个纯文本展品目前只有标题，阶段 B 必须补齐正文（D3）。

### 3.4 知识题与应用题

| 课时 | Knowledge Test | Application Test | 阅读 |
|---|---:|---:|---:|
| L001 | 18 | 1 | 3 |
| L002 | 8 | 1 | 3（旧源缺失，见 D5） |
| 合计 | **26** | **2** | **6** |

旧源所有 KT/AT 仅有英文列；v2 的 `LANGUAGE_MISSING` 检查要求每课 KT/AT 都有 en-GB 与 zh-CN 行，否则对应 question block 不生成且发布被阻止（见 D2）。

### 3.5 双语状态矩阵

| 内容 | en-GB | zh-CN | 处理 |
|---|---|---|---|
| 课程 5 字段 | 有 | 有（已作者化） | 直接写入 Course Info |
| 课时标题/描述 | 有（docx） | 有（docx） | 直接写入 Lessons |
| 学习点标题 | 有（docx/xlsx） | 有（docx） | 直接写入 Learning Points |
| 展品标题 | 有（docx） | 有（docx） | 直接写入 Exhibits |
| 展品描述（纯文本正文） | 部分只有标题 | 部分只有标题 | 阶段 B 补齐 6 条（D3） |
| Knowledge Test | 有（xlsx） | **缺** | 阶段 B 需内容方作者化（D2） |
| Application Test | 有（xlsx） | **缺** | 阶段 B 需内容方作者化（D2） |

---

## 4. v2 映射计划

### 4.1 模板工作簿（templateVersion=2）

机器 sheet 共 9 张，列名严格取自 `template-v2.ts`；`Checklist` 是人工工作流，不进入机器契约。任何时间列都会触发 `HUMAN_TIME_FORBIDDEN`。

| Sheet | 列（精确顺序） | 本包行数 | 映射说明 |
|---|---|---:|---|
| Meta | `templateVersion, courseCode, learningLanguages, studyMode` | 1 | `2`, `modeling-life`, `en-GB,zh-CN`, `both`。`learningLanguages` 必须包含 `zh-CN`，否则所有中文元数据/KT/AT 行报 `LANGUAGE_UNDECLARED`（error） |
| Media | `asset_key, kind, lesson_code, language, relative_path, thumbnail_of` | 38 | 见 §4.2；与 manifest.resources 一一对应 |
| Course Info | `field, language, text` | 10 | 5 字段 × 2 语言：title / shortDescription / overview / whatYouLearn / provides |
| Lessons | `lesson_code, order, language, title, description` | 4 | L001/L002 × 2 语言 |
| Learning Points | `lesson_code, lp_code, language, title` | 14 | 7 LP × 2 语言 |
| Exhibits | `lesson_code, exhibit_code, media_type, asset_key, language, title, description, source` | 70 | 35 展品 × 2 语言；text 展品 `asset_key` 为空且 `description` 必填 |
| Reading List | `lesson_code, type, title, author, why` | 6 | 每课 3 条，英文（该 sheet 无 language 列） |
| Knowledge Test | `lesson_code, order, language, question, reference_answer` | 52 | 26 题 × 2 语言（中文待作者化，D2） |
| Application Test | `lesson_code, language, question, reference_answer` | 4 | 2 题 × 2 语言（中文待作者化，D2） |

枚举稳定键：

- `Media.kind ∈ cover | video | audio | image | model3d | thumbnail | lesson-text | subtitle | chapters`
- `Exhibits.media_type ∈ image | video | audio | model3d | text`
- `Reading List.type ∈ book | article | paper | other`
- `studyMode ∈ video | text | both`

### 4.2 Media sheet 资产清单（assetKey）

命名规则：全部为语义稳定键；**不含环境 UUID、不含内容哈希、不含文件名推断**。

| assetKey | kind | lesson_code | language | relative_path | thumbnail_of |
|---|---|---|---|---|---|
| `modeling-life-cover` | cover | — | — | `media/cover.png` | — |
| `l1-video` | video | L001 | en-GB | `media/videos/l1.mp4` | — |
| `l2-video` | video | L002 | en-GB | `media/videos/l2.mp4` | — |
| `l1-subtitle` | subtitle | L001 | en-GB | `subtitles/L001.en-GB.srt` | — |
| `l2-chapters` | chapters | L002 | en-GB | `chapters/L002.en-GB.json` | — |
| `l1-doc` | lesson-text | L001 | en-GB | `lessons/L001.docx` | — |
| `l2-doc` | lesson-text | L002 | en-GB | `lessons/L002.docx` | — |
| `ex-l1-01` | image | L001 | —（语言中立） | `media/exhibits/l1-01.png` | — |
| `ex-l1-02` | image | L001 | — | `media/exhibits/l1-02.png` | — |
| `ex-l1-02-thumb` | thumbnail | L001 | — | `media/thumbnails/l1-02.png` | `ex-l1-02` |
| `ex-l1-04` | image | L001 | — | `media/exhibits/l1-04.png` | — |
| `ex-l1-04-thumb` | thumbnail | L001 | — | `media/thumbnails/l1-04.png` | `ex-l1-04` |
| `ex-l2-01` … `ex-l2-17` | image | L002 | — | `media/exhibits/l2-01.png` … `l2-17.png` | — |

完整映射（29 条 image + 2 条 thumbnail）：

| assetKey | 源文件 | 目标路径 |
|---|---|---|
| `ex-l1-01` | docx L001 `image1.png` | `media/exhibits/l1-01.png` |
| `ex-l1-02` | 包内 `lesson1-exhibit-1.png` | `media/exhibits/l1-02.png` |
| `ex-l1-02-thumb` | 包内 `lesson1-exhibit1缩略图.png` | `media/thumbnails/l1-02.png` |
| `ex-l1-04` | 包内 `lesson1-exhibit-2.png` | `media/exhibits/l1-04.png` |
| `ex-l1-04-thumb` | 包内 `lesson1-exhibit2缩略图.png` | `media/thumbnails/l1-04.png` |
| `ex-l1-06` | docx L001 `image4.png` | `media/exhibits/l1-06.png` |
| `ex-l1-07` | docx L001 `image5.png` | `media/exhibits/l1-07.png` |
| `ex-l1-08` | docx L001 `image6.png` | `media/exhibits/l1-08.png` |
| `ex-l1-09` | docx L001 `image7.png` | `media/exhibits/l1-09.png` |
| `ex-l1-11` | docx L001 `image8.png` | `media/exhibits/l1-11.png` |
| `ex-l1-12` | docx L001 `image9.png` | `media/exhibits/l1-12.png` |
| `ex-l1-15` | docx L001 `image10.png` | `media/exhibits/l1-15.png` |
| `ex-l1-16` | docx L001 `image11.png` | `media/exhibits/l1-16.png` |
| `ex-l1-17` | docx L001 `image12.png` | `media/exhibits/l1-17.png` |
| `ex-l2-01` … `ex-l2-17` | docx L002 `image1.png` … `image17.png` | `media/exhibits/l2-01.png` … `l2-17.png` |

（L001 的 1.3 / 1.5 / 1.10 / 1.13 / 1.14 / 1.18 为纯文本，无 Media 行，`Exhibits.asset_key` 为空。）

### 4.3 包内文件布局

```
modeling-life-v2/                     # 文档目录（PLAN.md + 构建产物）
├── PLAN.md                           # 本计划（不进入 zip）
├── manifest.json                     # 必需，唯一入口
├── template.xlsx                     # templateVersion=2
├── lessons/
│   ├── L001.docx
│   └── L002.docx
├── media/
│   ├── cover.png
│   ├── videos/l1.mp4
│   ├── videos/l2.mp4
│   ├── exhibits/l1-01.png … l1-17.png
│   └── exhibits/l2-01.png … l2-17.png
│   └── thumbnails/l1-02.png, l1-04.png
├── subtitles/
│   └── L001.en-GB.srt                # 时间源 ①
└── chapters/
    └── L002.en-GB.json               # 时间源 ②
```

打包文件名：`modeling-life-v1.lgcourse.zip`。zip 内不包含 `__MACOSX`、`.DS_Store`、`~$` 锁文件、`PLAN.md`、`README.md`、任何哈希清单或 `timing.json`。

### 4.4 manifest.json 计划

`formatVersion=2`、`minReaderVersion=2`、`extensionsUsed/Required=[]`。资源总数 **39**（template + 38 媒体/文档/时间源）；`resources[]` 固定形状 `{id, kind, path, size}`。

```jsonc
{
  "format": "lg-course-package",
  "formatVersion": 2,
  "packageId": "pkg_modeling-life_v1",
  "exportedAt": "2026-11-13T00:00:00Z",   // 演示固定值；不参与身份
  "minReaderVersion": 2,
  "extensionsUsed": [],
  "extensionsRequired": [],
  "course": {
    "courseKey": "modeling-life",
    "titleLocalized": {
      "en-GB": { "title": "Modeling life" },
      "zh-CN": { "title": "建模生命" }
    },
    "categoryPath": ["Science"],
    "learningLanguages": ["en-GB", "zh-CN"],
    "studyMode": "both"
  },
  "content": {
    "courseKey": "modeling-life",
    "versionNo": 1,
    "categoryPath": ["Science"],
    "stages": [ /* 3 个：program + lesson-l001 + lesson-l002，见 §4.5 */ ],
    "prerequisiteEdges": [ /* 1 条：lesson-l001 requires → lesson-l002 */ ],
    "specPins": [ /* 8 条：每课的 lesson / .reading / .knowledge-test / .application-test */ ],
    "renditions": [ /* 由编译器派生，见 §4.5；不手写时间 */ ],
    "alignments": [ /* 只放 verified，带审计元组；人签后导出 */ ],
    "evidenceSpecs": [ /* 4 条：每课 KT + AT 各一条 assessment */ ],
    "assetPins": [ /* 38 条，与 Media sheet 非 template 行一致 */ ]
  },
  "resources": [
    { "id": "template", "kind": "template", "path": "template.xlsx", "size": 0 },
    { "id": "modeling-life-cover", "kind": "cover", "path": "media/cover.png", "size": 1750526 },
    { "id": "l1-video", "kind": "video", "path": "media/videos/l1.mp4", "size": 139718382 },
    { "id": "l2-video", "kind": "video", "path": "media/videos/l2.mp4", "size": 21124683 },
    { "id": "l1-subtitle", "kind": "subtitle", "path": "subtitles/L001.en-GB.srt", "size": 0 },
    { "id": "l2-chapters", "kind": "chapters", "path": "chapters/L002.en-GB.json", "size": 0 },
    { "id": "l1-doc", "kind": "document", "path": "lessons/L001.docx", "size": 3100051 },
    { "id": "l2-doc", "kind": "document", "path": "lessons/L002.docx", "size": 1141651 },
    { "id": "ex-l1-01", "kind": "image", "path": "media/exhibits/l1-01.png", "size": 1780157 },
    /* … 其余 image/thumbnail … */
  ],
  "provenance": {
    "sourceEnv": "sandbox",
    "sourceVersionLabel": "1.0",
    "exportedAt": "2026-11-13T00:00:00Z",
    "exportedBy": "demo-operator@example.com",
    "courseKey": "modeling-life",
    "planPin": {
      "planId": "plan/modeling-life/content-v1/target-default/v1",
      "planVersion": 1
    },
    "approvalRef": "APR-DEMO-0001",
    "auditSummaryRef": "audit/modeling-life/v1.json",
    "asr": { "modelVersion": "asr-demo-v1", "params": {}, "ruleVersion": "asr-rules-v1" }
  },
  "annotations": {
    "sourceEnv": "sandbox",
    "sourceLabel": "Sandbox 1.0",
    "demo": true,
    "generatedBy": "package-example-builder",
    "legacySource": "Modeling life内容文件.zip",
    "timingSources": ["subtitle", "chapter"],
    "contentCounts": {
      "lessons": 2, "learningPoints": 7, "exhibits": 35,
      "textExhibits": 6, "knowledgeTests": 26,
      "applicationTests": 2, "readings": 6
    },
    "verification": [
      {
        "kind": "timing-audit",
        "lessonCode": "L001",
        "sourceKind": "subtitle",
        "sourceArtifact": "subtitles/L001.en-GB.srt",
        "modelVersion": null,
        "params": null,
        "ruleVersion": "timing-rules-v1",
        "verifiedBy": "demo-operator@example.com",
        "verifiedAt": "2026-11-13T00:00:00Z"
      },
      {
        "kind": "timing-audit",
        "lessonCode": "L002",
        "sourceKind": "chapter",
        "sourceArtifact": "chapters/L002.en-GB.json",
        "modelVersion": null,
        "params": null,
        "ruleVersion": "timing-rules-v1",
        "verifiedBy": "demo-operator@example.com",
        "verifiedAt": "2026-11-13T00:00:00Z"
      }
    ]
  }
}
```

强制一致项：

- `provenance.asr` 只在实际使用 ASR 派生时出现；若 L001 使用外部字幕/章节，必须省略该块（或换成实际 ASR pin），不得声明未使用的模型。

- `course.courseKey === content.courseKey === provenance.courseKey`
- `course.categoryPath === content.categoryPath`（逐字节 JSON 相等）
- `resources[].path` 无绝对路径、无 `..`、无重复
- `resources[].id` 与 Media sheet 的 `asset_key` 同名同值
- **无 `sha256` / `checksum` / `digest` 字段**
- `size` 由构建时 `stat` 真实文件写入；示例中的 `0` 是占位，构建后必须替换

### 4.5 content 模型（由编译器派生，不手写时间）

**阶段树（3 个 stage）**

| stageKey | parent | orderKey | kind | objectiveKeys | exitEvidence | exitRollup |
|---|---|---|---|---|---|---|
| `program-modeling-life` | null | `000001` | program | [] | [] | all |
| `lesson-l001` | `program-modeling-life` | `000001.000001` | step | `obj-1.1 … obj-1.5` | `ev-l001-kt`, `ev-l001-at` | all |
| `lesson-l002` | `program-modeling-life` | `000001.000002` | step | `obj-2.1`, `obj-2.2` | `ev-l002-kt`, `ev-l002-at` | all |

**先修**：`{ fromStageKey: "lesson-l001", toStageKey: "lesson-l002", kind: "requires" }`（示范 DAG，不是树）。

**specPins（8）**：`L001`, `L001.reading`, `L001.knowledge-test`, `L001.application-test`, `L002`, `L002.reading`, `L002.knowledge-test`, `L002.application-test`，version 均为 1。

**evidenceSpecs（4，全部 assessment）**

| evidenceKey | objectiveKeys | measure.contentKey | measure.blockIds | scoring / threshold / attempts |
|---|---|---|---|---|
| `ev-l001-kt` | `obj-1.1 … obj-1.5` | `L001.knowledge-test` | `q.1` … `q.18` | points / 0.8 / 2 |
| `ev-l001-at` | `obj-1.1 … obj-1.5` | `L001.application-test` | `application` | points / 0.8 / 2 |
| `ev-l002-kt` | `obj-2.1`, `obj-2.2` | `L002.knowledge-test` | `q.1` … `q.8` | points / 0.8 / 2 |
| `ev-l002-at` | `obj-2.1`, `obj-2.2` | `L002.application-test` | `application` | points / 0.8 / 2 |

**renditions（派生规则）**

编译器（`align.ts`）按以下稳定 blockId 派生，示范包不手写坐标：

- LP 视频坐标 → `contentKey=L001/L002`、`blockId=video`、`modality=video`、`carrierKey=l1-video/l2-video`、`anchorSource=subtitle/chapter`、`startMs/endMs` 来自时间源。
- 文本正文 → `blockId=body`、`modality=text`、`carrierType=document`、`anchorSource=doc-structure`。
- 展品块 → `blockId=<exhibit_code>`（如 `1.2`）、`modality=image/text`；视频内触发另有一条 `modality=video` 的 occurrence rendition。
- 缩略图 → 单独 rendition（`thumbnail`）。
- 阅读 → `contentKey=L00x.reading`、`blockId=reading.N`。
- KT → `contentKey=L00x.knowledge-test`、`blockId=q.N`；AT → `contentKey=L00x.application-test`、`blockId=application`。

预计 renditions 量级 70+（7 LP 视频 + 7 LP 文本锚点 + 2 body + 29 展品展示 + 29 展品触发 + 2 缩略图等）。**最终数量以编译器输出为准**，不在 PLAN 中固化。

**alignments（只放 verified）**

- 每个 LP 的视频 rendition → 对应 `obj-x.y` 的 `primary` 对齐（满足 ALN-4）。
- 每个 LP 的文本 rendition → 对应 `obj-x.y` 的 `support` 或 `primary` 对齐。
- 每个展品 rendition → 其所服务 LP 的 `obj-x.y` 的 `auxiliary`/`support` 对齐。
- `verifiedBy/verifiedAt/verifiedAgainst` 三件套齐全；`verifiedAgainst` 必须与冻结的 renditionRevision / carrierVersion / specVersion 一致。
- 阶段 B 先在 Sandbox 生成 proposed，Operator 播放复核后签收为 verified，再导出。

### 4.6 字幕 / 章节生成策略（字幕优先 + 章节示例）

优先级严格按 C7：① 外部字幕 SRT/VTT → ② MP4 chapter track 或包内 chapters JSON → ③ ASR 默认兜底 → ④ 强制对齐（仅课时显式声明“文本稿=口播稿”）。DOCX Heading 只用于文本锚点。

本示范包设计：

| 课时 | 时间源 | 路径 | anchorSource | 说明 |
|---|---|---|---|---|
| L001 | 外部字幕 SRT | `subtitles/L001.en-GB.srt` | `subtitle` | 展示优先级 ①；cue 文本包含 LP 标题与 Exhibit 标题，供编译器匹配 |
| L002 | 包内 chapters JSON | `chapters/L002.en-GB.json` | `chapter` | 展示优先级 ②；章节标题 = LP 标题，`startMs` 为整数毫秒 |

章节 JSON 形状（`parseChaptersJson` 已支持）：

```json
{
  "chapters": [
    { "startMs": 0,     "title": "Pitchfork Bifurcation in a Model of Public Opinion" },
    { "startMs": 600000, "title": "Transcritical Bifurcation" }
  ]
}
```

规则：

- 每个视频 × 每个语言独立派生；本包只有 en-GB。
- 点锚点展开为半开区间 `[start, end)`；有字幕 cue 用 cue 区间；只有点锚点时 `end = 下一锚点 - 1ms`，无下一锚点时 `end = duration`；`0 ≤ start < end ≤ duration`。
- `ruleVersion` 使用 `timing-rules-v1`；ASR/强制对齐必须 pin `modelVersion/params/ruleVersion` 到 `provenance.asr` 与 Alignment 审计字段。
- 字幕/章节文件必须包含可匹配的 LP 标题与展品标题；否则对应锚点缺失 → `TIMING_SOURCE_MISSING`，阶段 blocked。
- **不得**把旧时间列、估算时长或手工打点写入任何字幕/章节文件。

时间源生成工具（阶段 B）：

- 首选：在本机运行真实 ASR（如 `mlx-whisper` / `whisper.cpp`）从音轨生成带时间戳转写，再渲染为 SRT；`provenance.asr` 记录模型与参数。
- 若 ASR 不可用：仅允许在**显式声明“文本稿=口播稿”**时使用强制对齐（`anchorSource=forced-alignment`，pin 模型/参数）。
- 若两者都不可用：示范包必须标记为 `demo` 且**不得**声称语义时间已验证；不得用均匀分布 cue 冒充真实字幕进入“verified”包（违反 R8/语义真实性）。

---

## 5. 红线核对清单（构建后逐项断言）

| 检查 | 命令/方式 | 期望 |
|---|---|---|
| 模板无时间列 | `assertNoHumanTimeColumns(headers)` / 编译导入 | 0 命中 |
| manifest 无哈希 | `grep -Ei 'sha256\|checksum\|digest' manifest.json template Media` | 0 命中 |
| 无环境 UUID | 检查所有 `assetKey/id/path` 均为稳定键 | 0 命中 UUID 形态 |
| 闭合包 | manifest.resources ↔ zip 条目双向对账 | 完全相等 |
| 旧字段 | `grep -E 'formatVersion.*1|templateVersion.*1|"category"|checksums'` | 0 命中 |
| 分类 | `course.categoryPath === content.categoryPath` | 相等 |
| 键一致 | `course.courseKey === content.courseKey === provenance.courseKey === Meta.courseCode` | 相等 |
| 时间范围 | 编译器 P3/P5 | `0 ≤ start < end ≤ duration` |
| 时间源完备 | 每个 video × language 有 subtitle/chapter | 通过 |
| 资源大小 | 每个 `resources[].size === stat(file).size` | 全等 |
| 语言完整 | Course Info / Lessons / KT / AT 双语 | 无 `LANGUAGE_MISSING` |
| verified 对齐 | 冻结快照只含 verified | 通过 |
| round-trip | 导入 → 导出 → 再导入 | 语义等价 |

---

## 6. 关键决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | 旧时间列 100% 丢弃 | 9 个值中 7 个越界，且同一列混用两种解释（§2.6） |
| D2 | KT/AT 中文必须由内容方作者化后纳入 | 编译器要求每课 KT/AT 有 en-GB + zh-CN 行；机翻违反“不造假翻译”；缺失将阻止发布 |
| D3 | 6 个纯文本展品必须补 `description` | 编译器以 description 作为 text exhibit 的正文；为空则不生成 block |
| D4 | L001 用 SRT、L002 用 chapters JSON | 一个示范包同时展示两条时间源路径；避免全包只演示一条 |
| D5 | L002 阅读：复用 L001 的 3 条（沿用旧 v1 模板行为）或由内容方补 3 条 L002 专属 | 旧源无 L002 阅读；复用需在 annotations 标注 legacy |
| D6 | `categoryPath=["Science"]` | 与旧值/仓库夹具一致；若 Admin 分类稳定键不同，构建前替换为真实稳定键 |
| D7 | `courseKey="modeling-life"`，不沿用旧 `C001` | `C001` 是 Admin 课程编号；v2 要求环境无关稳定键 |
| D8 | 27 张低分辨率展品图：优先向内容方要原图；示范用可 Lanczos 放大到长边 ≥2000 px 并在 annotations 标注 | 媒体规格要求长边 ≥2000 px；编译器不强制，但示范包应尽量合规 |
| D9 | 缩略图只保留旧包已有的 2 张（1.2 / 1.4）；其余 27 张可选由平面设计补 | 缩略图不是闭合包必需；新增属设计交付物，不由机器生成 |
| D10 | manifest 的 renditions/alignments 由真实编译器/导出器生成，不手写 | 避免契约漂移；保证 round-trip 等价 |
| D11 | 打包前剔除 `__MACOSX`、`.DS_Store`、`~$` 锁文件 | 闭合包不得有未声明文件 |
| D12 | `learningLanguages=["en-GB","zh-CN"]`，中文作为双语元数据；中文视频 N/A | 校验器要求所有行语言必须在 `learningLanguages` 内声明（否则 `LANGUAGE_UNDECLARED`）；仓库夹具同样用双语声明 + 仅英文视频，已验证可行 |

---

## 7. 阶段 B / C 执行清单

### 阶段 B（构建，未开始）

1. **B1 资产落地**：解压旧包（cp437 修复）；提取 29 张 docx 内嵌图；复制 5 张包内 PNG；按 §4.2 命名到 `media/`；生成 `media/exhibits/`、`media/thumbnails/`；记录每张图的尺寸/大小。
2. **B2 内容补齐**：6 条纯文本展品 description；KT/AT 中文（内容方）；L002 阅读（D5）；校验 70 行 Exhibits 双语齐全。
3. **B3 时间源**：ASR/强制对齐生成 `subtitles/L001.en-GB.srt`；生成 `chapters/L002.en-GB.json`（LP 起点，整数毫秒）；`provenance.asr` 与 `annotations.verification` 如实记录。
4. **B4 模板构建**：复用 `server/test/fixtures/longrange/scripts/build_workbook.mjs` 的 sheet/列定义，扩展到 29 个展品图与完整 KT/AT/Reading；输出 `template.xlsx`。
5. **B5 manifest 种子 + 编译派生**：先写课程/资源骨架（§4.4），再用真实 `parsePackage → validatePackage → deriveTiming → alignPackage` 派生 specs/renditions/alignments；在 Sandbox 复核并签收 verified；用导出器生成最终 manifest（保证与导出形状一致）。
6. **B6 打包**：写入 `manifest.json` 的真实 size；剔除噪声文件；生成 `modeling-life-v1.lgcourse.zip`；计算 zip CRC（由 zip 自带，不额外生成清单）。
7. **B7 示范文档**：在输出目录补 `README.md`（给内容制作方的使用说明：模板怎么填、时间源怎么给、哪些字段必填、哪些是红线）。

### 阶段 C（验证，未开始）

1. 运行 §5 全部断言。
2. 用真实导入管线导入示范包：确认无 error；确认 `LANGUAGE_MISSING` 清零；确认 renditions/alignments 与 manifest 一致。
3. 导入 → 导出 → 再导入 round-trip；比对内容、结构、媒体引用、语言、分类路径语义等价。
4. 在 Sandbox 播放复核时间审计报告（毫秒、`mm:ss.mmm`、邻近文本）。
5. 输出验证报告与已知偏差（低分辨率图、缺中文 KT/AT 等）。

---

## 8. 开放项与风险

| # | 项 | 影响 | 建议 |
|---|---|---|---|
| O1 | KT/AT 中文缺失（26 + 2 行） | 阻断发布（`LANGUAGE_MISSING`） | 内容方作者化；不得机翻 |
| O2 | 6 个纯文本展品无正文 | 对应 block 不生成（`CONTENT_INCOMPLETE`） | 由内容方补 1–2 句 description |
| O3 | 无 ASR 工具（本机未安装 whisper/mlx-whisper） | 无法生成真实 L001 字幕 | 阶段 B 安装并 pin 模型；或走强制对齐（需声明文本稿=口播稿） |
| O4 | 27 张展品图 + 封面长边 < 2000 px | 媒体规格偏差 | 优先要原图；否则 Lanczos 放大并标注 |
| O5 | 旧源无 L002 阅读 | 内容不完整 | 复用 L001 3 条（标注 legacy）或补 3 条 |
| O6 | `Science` 是否为 Admin 稳定键未确认 | `CATEGORY_NOT_FOUND` | 构建前查 Admin 分类稳定键 |
| O7 | 旧 `C001` 与 `modeling-life` 的关系 | 课程身份不一致 | 明确 `courseKey` 为稳定 slug；`C001` 只作注释 |
| O8 | 缩略图只有 2 张 | 其余 27 个展品无方形缩略图 | 可选补；不影响包有效性 |
| O9 | 示范包体量约 160 MB | 传输/CI 时间 | 保留真实视频；必要时单独提供轻量“结构演示包” |
| O10 | verified 对齐需要人签 | 无签收则不能发布 | 指定示范 Operator，记录 `verifiedBy/At` |
| O11 | 部分 docx 内嵌图右上角带 “Made with AI” 角标 | 产品演示观感 | 向内容方要无角标原图；或在阶段 B 仅做角标裁切并记录（不改语义内容） |

---

## 9. 本阶段产物

- 本文件：`docs/package-examples/modeling-life-v2/PLAN.md`
- 未改动 `admin/`、`portal/` 或任何实现代码。
- 旧包解压与图像分析仅在 `/tmp/modeling-old-extract`、`/tmp/modeling-docx-img` 中进行。
