# 长程真实测试夹具（F1–F6）

对应计划：`docs/Course_Category_LongRange_TestPlan.md` §1；
对应设计：`docs/Course_Category_Single_Source_Design.md` §14 Part C（C0–C17）；
对应格式：`docs/Course_Package_Spec_v2.md`（packageFormat=2 / templateVersion=2）。

本目录只包含**测试 / 夹具 / 生成脚本**，不修改任何生产代码。所有生成脚本都是
黑盒的：只读写本目录与真实素材，不 import `src/` 内部实现。

## 真实素材

- 源包（Owner 提供，165 MB）：
  `/Users/nihao/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_2r9lp9dzjsqc22_8c54/msg/attach/97a7391c0f3e5cbcfee4a9785c2f4c05/2026-11/Rec/3a59f264fcf791b8/F/1/Modeling life内容文件.zip`
- 两段真实视频、两个真实 docx、真实封面与展品图；**没有任何玩具视频**。
  （F4 的最小包也用真实视频的 10 秒真实截取，而不是合成视频。）

## 目录

```text
longrange/
├── README.md
├── .gitignore                 # 生成的大体积产物不入库，可重跑
├── data/
│   └── course_content.json    # 从真实 docx/xlsx 抽出的课程模型（单一事实源）
├── F1/                        # 真实包解压 + 清点 + ffprobe
│   ├── package/               # 解压后的真实内容（cp437→utf-8 修复文件名）
│   ├── inventory.json/.txt
│   └── ffprobe.json
├── F2_subtitles/              # 字幕包（v2）
│   ├── package/  F2_subtitles.zip  build.json  alternates/
├── F3_chapters/               # 章节包（v2）
│   ├── package/  F3_chapters.zip   build.json
├── F4_bad_packages/           # 9 个最小坏包
│   ├── _baseline/  01-...zip … 09-...zip  build.json
├── F5_replacement/            # 替换视频包（v2）
│   ├── package/  F5_replacement.zip  build.json
└── scripts/
    ├── build_all.py           # 一键重建 + 自检
    ├── build_f1_real_package.py
    ├── build_course_data.py
    ├── build_workbook.mjs     # 用 xlsx 库生成 templateVersion=2 工作簿
    ├── build_subtitles.py
    ├── build_packages.py      # F2/F3/F5
    ├── build_f4_bad_packages.py
    ├── fixture_common.py  fixture_manifest.py
    └── verify_fixtures.py     # 233 项结构自检
```

## 重建与自检

```bash
cd /Users/nihao/AI infra/LearningGuideAdmin/server/test/fixtures/longrange
python3 -I scripts/build_all.py
```

`build_all.py` 依次执行 F1 解压清点 → 课程模型抽取 → F2/F3/F5 → F4 →
`verify_fixtures.py`。全部可重复；退出码 0 表示自检通过。

## F1 真实包

- 解压文件名修复：ZIP 顶层目录条目未置 UTF-8 标志位（0x800），Python 按 cp437
  解码；脚本按 `name.encode('cp437').decode('utf-8')` 还原（GBK/GB18030 兜底）。
- 清点：25 个 ZIP 条目（内容条目 11，含目录；内容文件 10；`__MACOSX`/`.DS_Store`/
  `~$…xlsx` 等垃圾 14 个已跳过）。
- 内容文件：2 docx、2 mp4、5 png（封面 + 2 展品 + 2 缩略图）、1 xlsx。
- **无字幕文件、无 MP4 章节轨**（`inventory.json` 的 `hasSubtitles=false`、
  `hasChapterTracks=false`），因此 F1 不能提供派生时间源。
- 真实时长（ffprobe）：

```text
Lesson 1视频课件.mp4  durationMs=1469312  video=1 audio=1 chapters=0 subtitles=0
Lesson 2视频课件.mp4  durationMs=1584263  video=1 audio=1 chapters=0 subtitles=0
```

- 真实工作簿是旧模板（无 Meta / 无 Media sheet，且含旧时间列）。F1 保持原样，
  作为真实素材与「无派生源」基座；F2/F3/F5 才按 v2 契约生成 manifest + 模板。

## F2 字幕包（v2）

- 从两个真实 docx 的**标题 / 对话 / 展品行**生成 SRT/VTT：
  - `subtitles/l1.en-GB.srt`（142 cues，SRT）
  - `subtitles/l2.en-GB.vtt`（110 cues，WEBVTT）
  - 另一格式保存在 `F2_subtitles/alternates/`（不随包）。
- 每个学习点标题在对应字幕中**恰好出现一次**（1.1–1.5、2.1–2.2），避免
  `TIMING_AMBIGUOUS`；展品标题也作为 cue 文本。
- 时间 cue 是在真实视频时长内**均匀分布**的占位值（不是人工打点），但文件是
  标准可解析 SRT/VTT，且最后一条 cue 的结束时间 ≤ 容器时长。
- `template.xlsx`：templateVersion=2，含 **Media sheet**
  （`asset_key | kind | lesson_code | language | relative_path | thumbnail_of`）。
  Media sheet 与 `manifest.resources[]` 一一对应。
- 时间源只有 en-GB 字幕；课程元数据/文本行提供 en-GB + zh-CN，zh-CN 没有视频
  rendition（文本模式），因此不静默复制 en-GB 的时间源。
- manifest：`formatVersion=2`、`versionNo=1`、`provenance.sourceEnv=sandbox`、
  分类路径 `["Science"]`，无任何哈希字段。

## F3 章节包（v2）

- 用 ffmpeg 给**真实 mp4** 注入真实 chapter track（`-map_metadata 1 -map_chapters 1
  -codec copy`），按模板学习点编号与标题：
  - L1：5 章（1.1–1.5）
  - L2：2 章（2.1–2.2）
- 章节起始时间按真实时长均匀分布（占位值）；ffmpeg/mov muxer 会把第一章
  start 归 0，后续章节 start 与输入一致。
- Media sheet 不含 subtitle 行，manifest 不含 subtitle 资源；视频行随包声明。
- 实测：`ffprobe -show_chapters` 分别返回 5 / 2 章，无嵌入字幕流。

## F4 坏包集合（9 个最小包）

基线：最小 v2 包（真实 10 秒截取视频 + 真实封面缩略图 + 合法 manifest/模板）。
每个包只改一个缺陷：

| # | 夹具 | 缺陷 | 预期失败（黑盒观察） |
|---|---|---|---|
| 1 | `01-missing-manifest-field` | 删除 `course.titleLocalized` | `PACKAGE_FORMAT_UNSUPPORTED` |
| 2 | `02-unknown-file` | zip 内加入未声明的 `media/orphan.bin` | `PACKAGE_FILE_UNKNOWN` |
| 3 | `03-version-missing` | 删除 `formatVersion` | `PACKAGE_FORMAT_UNSUPPORTED` |
| 4 | `04-duplicate-truth-key` | Learning Points 重复 `(lesson_code, lp_code, language)` | `CODE_DUPLICATE`（error） |
| 5 | `05-out-of-range-time` | 字幕 cue 起始超过真实 duration（20.016s > 10.016s） | `TIMING_RANGE_INVALID`（error） |
| 6 | `06-unknown-code` | Knowledge Test 引用未知 `lesson_code=NOPE` | `REFERENCE_UNRESOLVED`（error） |
| 7 | `07-missing-language` | video Media 行 `language=null` | `MEDIA_BINDING_MISSING`（error） |
| 8 | `08-illegal-media-type` | manifest 资源 `kind=executable`（非法媒体类型） | `PACKAGE_FORMAT_UNSUPPORTED` |
| 9 | `09-zip-path-traversal` | zip 条目 `../evil.txt`（未声明） | `PACKAGE_FILE_UNKNOWN` / 路径穿越拒绝 |

说明：第 8 例在 manifest 层即被资源 kind 枚举拒绝；若只改 Media sheet 的 kind，
解析器会先在「Media↔resources 一一对应」处以 `TEMPLATE_FORMAT_UNSUPPORTED`
fail-closed。两条路径都不接受非法媒体类型。

## F5 替换包（v2）

- 在 F2 基础上，把 **Lesson 1 视频替换为真实视频的截短版**（`ffmpeg -t 1200 -c copy`）。
- 实测时长：F2 `1469312 ms` → F5 `1200067 ms`（关键帧对齐，确实不同）。
- 同一 `assetKey=l1-video` 的 `assetVersion=2`；`content.versionNo=2`；
  `manifest.resources[].size` 同步更新。
- 字幕按新真实时长重新均匀生成（最后 cue ≤ 1200067 ms），因此 F5 本身可导入；
  其映射坐标与 F2 不同，用于后续「资产新版本 → 映射失效 → Re-confirm」。
- Lesson 2 视频不变（对照）。

## F6 跨环境包

**不预构建。** 由测试在运行时经导出接口产生：导入 F2 → 发布/导出 → 得到 F6 →
导入第二个库（学习指南二库）→ 发布 → 投影对比。导出/导入产物建议落在
`F6_export_roundtrip/`（已加入 `.gitignore`）。

## 自检证据

`python3 -I scripts/verify_fixtures.py` 当前结果：

```text
summary: 233/233 checks passed
```

覆盖：F1 清点与无派生源；F2/F3/F5 的 manifest 版本/闭合/resources 大小/Media
sheet 对应/时间源边界；F3 章节数与无字幕；F5 时长变化与 assetVersion；F4 九个
缺陷逐项存在。

## 约束与已知边界

- 未修改生产代码；未使用浏览器；未跑全量 build。
- 生成的大体积产物（`F1/package`、F2/F3/F5/F4 包与 zip）已加入本目录
  `.gitignore`，由 `scripts/build_all.py` 从真实 zip 重建。
- F2/F3/F5 的模板按 v2 契约生成（含 Media sheet、无任何时间列）；真实旧工作簿
  保留在 F1 中作为原始素材。
- F2 的字幕时间与 F3 的章节时间是**均匀分布占位值**，只保证真实可解析与在真实
  时长内；语义真实性仍按设计由 Sandbox 播放复核。
- LP 1.1 的英文标题取自真实 `Lessons` sheet（docx 中 1.1 仅有中文标题）。
- F4 的基线是「最小合法包」，未追求双语完整性（缺 zh-CN 行只会产生
  `LANGUAGE_MISSING` incomplete，不影响各自缺陷的 fail-closed 观察）。
