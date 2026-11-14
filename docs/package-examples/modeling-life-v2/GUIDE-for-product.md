# 产品演示脚本 · Modeling life v2 示范包

本脚本给产品/售前用，目标是在 20 分钟内讲清四件事：

1. **时间全机器派生**：模板没有时间列，人也不输入时间。
2. **低置信 / 无源阻断**：派生不出来的阶段不能发布，系统不猜。
3. **闭合包拒绝坏包**：缺文件、多文件、旧格式、时间列都会被整包拒绝，并给出精确坐标。
4. **跨环境 provenance**：Production 只接受 Sandbox 导出的 v2 包，来源判定看字段不看文件名。

演示素材：`lite/modeling-life-v2-lite.lgcourse.zip`（约 13 MB，视频截到 15 s），
full 包（161 MB）只用于讲解真实媒体，不要现场上传。

> 说明：Part C 的计划/签收/发布目前是**管理端 API**（`/api/backoffice/courses/:courseKey/partc/**`），
> 课程包导入有 UI。下面的步骤优先用 UI，需要展示计划门时用 curl。
> Portal 的 Part C 学习计划投影仍属后续 P1，本演示不依赖 Portal 页面。

---

## 1. 准备（约 5 分钟）

### 1.1 起后端

```bash
cd server
# 首次：准备 .env（数据库、端口、首个管理员）
cp .env.example .env
# 至少设置：
#   DATABASE_URL="postgresql://admin:admin@localhost:5432/learning_guide_db"
#   PORT=3000
#   BOOTSTRAP_ADMIN_EMAIL=demo@example.com
#   BOOTSTRAP_ADMIN_PASSWORD=<演示密码>

npx prisma migrate deploy
npm run start:dev
```

首次启动会按 `BOOTSTRAP_ADMIN_*` 建首个管理员（已有员工时不会重复创建）。
健康检查：`curl -s http://localhost:3000/api/health` 返回 `{"status":"ok",...}`。

### 1.2 起前端

```bash
cd client
npm run dev        # Vite 默认 http://localhost:5173，/api 代理到 :3000
```

用上面的管理员账号登录。

### 1.3 确认前提

- 目标环境存在 **ACTIVE** 分类 `Science`（Admin 预置分类）。没有的话导入会报
  `CATEGORY_NOT_FOUND`——这本身也是一个演示点：系统不会自动造分类。
- 准备一个干净的课程库（本演示的 `courseKey=modeling-life` 不要已存在）。
  重复演示请删掉该课程或重建本地库。

---

## 2. 镜头 1：时间全机器派生

### 2.1 先证明“模板里没有时间”

打开 `full/package/template.xlsx`（或从 lite zip 解压），展示 9 张 sheet：
Meta / Media / Course Info / Lessons / Learning Points / Exhibits / Reading List /
Knowledge Test / Application Test。指出：

- `Learning Points` 只有 `lesson_code, lp_code, language, title`；
- `Exhibits` 只有 `media_type, asset_key, title...`，**没有触发时间**；
- 全表没有 `start/end/time/duration/trigger/时间/时长` 任何列。

命令行也可以证明：

```bash
cd docs/package-examples/modeling-life-v2
python3 -I - <<'EOF'
import zipfile
z = zipfile.ZipFile('lite/modeling-life-v2-lite.lgcourse.zip')
print('\n'.join(z.namelist()))
EOF
```

### 2.2 导入

UI：**课程管理 → 导入课程包 → 选择 `modeling-life-v2-lite.lgcourse.zip`**。
上传后后台异步解析校验，页面轮询到 `AWAITING_CONFIRM`（校验通过，等待确认）
或 `FAILED`（带报告）。

API 等价：

```bash
BASE=http://localhost:3000/api
COOKIE=/tmp/lg-demo-cookie.txt

# 登录（员工会话 cookie）
curl -s -c "$COOKIE" -X POST "$BASE/backoffice/auth/sign-in" \
  -H 'content-type: application/json' \
  -d '{"email":"demo@example.com","password":"<演示密码>"}' | jq '.data.employee'

# 上传课程包（multipart 字段名必须是 file）
JOB=$(curl -s -b "$COOKIE" -F "file=@lite/modeling-life-v2-lite.lgcourse.zip" \
  "$BASE/backoffice/courses/import" | jq -r '.data.jobId')
echo "$JOB"

# 轮询校验结果
curl -s -b "$COOKIE" "$BASE/backoffice/courses/import/$JOB" \
  | jq '{status:.data.status, error:.data.error, report:.data.report}'
```

预期：`status = AWAITING_CONFIRM`，`report.errors = []`。

讲解点：此时**还没有任何时间被人输入**。系统刚做完的是：

- 包闭合 / 版本 / code 唯一 / 双语 / 分类解析；
- `deriveTiming` 按 **字幕优先**（L001 的 `subtitles/L001.en-GB.srt`，142 cues）
  与 **章节轨**（L002 的 MP4 chapter track，2 章）派生毫秒区间；
- `alignPackage` 生成 rendition 与 proposed 对齐；
- 生成**时间审计报告**（毫秒、`mm:ss.mmm`、邻近文本），供 Operator 播放复核。

### 2.3 确认导入

```bash
curl -s -b "$COOKIE" -X POST "$BASE/backoffice/courses/import/$JOB/confirm" \
  -H 'content-type: application/json' \
  -d '{"onConflict":"ABORT"}' | jq '.data'
```

UI 上是同一个动作：查看校验信息 → 确认导入。首次导入用 `ABORT`；
重复演示请删课或重建库（同 `courseKey` 已存在会被拒绝，这是有意的）。

### 2.4 展示派生结果

```bash
# 课程包里冻结的 rendition（时间坐标）
jq '.content.renditions[] | select(.blockId=="video") |
    {renditionKey, startMs, endMs, anchorSource}' \
  full/package/manifest.json | head -40

# 时间审计（随包 annotations 携带，不参与身份）
jq '.annotations.verification' full/package/manifest.json
```

对着投影讲：

- `startMs/endMs` 是**整数毫秒**，来源是 `subtitle` 或 `chapter`；
- 同样的派生可以用真实编译器复算：
  `build/verify_with_compiler.ts` 会打印 L001/L002 每条 LP 的区间并断言与 manifest
  **逐毫秒 MATCH**（见 README §6）；
- 单元格里没有任何时间，时间只在媒体资产与对齐矩阵里。

---

## 3. 镜头 2：签收 → 预览 → 发布

### 3.1 对齐签收（只在需要时）

本示范包导入时**已带 verified 对齐与审计元组**（`verifiedBy/verifiedAt/verifiedAgainst`），
可以直接走到发布门。真实制作方包第一次导入时对齐是 `proposed`，必须由 Operator
在 Sandbox 播放复核后逐条签收：

```bash
# 查看对齐（demo 包：67 条，全部 verified）
curl -s -b "$COOKIE" "$BASE/backoffice/courses/modeling-life/partc/alignments" \
  | jq '.data | group_by(.status) | map({status:.[0].status, n:length})'

# 真实包的单条签收（proposed → verified）
# curl -s -b "$COOKIE" -X POST \
#   "$BASE/backoffice/courses/modeling-life/partc/alignments/<alignmentId>/sign-off" \
#   -H 'content-type: application/json' -d '{"decision":"verified"}'
```

讲解点：**只有 verified 能进 Plan**；stale 会按审计元组与 pin 不匹配派生，阻塞发布。

### 3.2 预览 Plan（纯函数、可复现）

```bash
curl -s -b "$COOKIE" -X POST \
  "$BASE/backoffice/courses/modeling-life/partc/plans/preview" \
  | tee /tmp/plan-preview.json \
  | jq '{status:.data.status, entries:(.data.entries|length),
         blocked:([.data.entries[]|select(.status=="blocked")]|length),
         warnings:.data.warnings, gaps:.data.gaps}'
```

预期（用与 `plans/preview` 相同的编译函数实测）：`status = draft`，`entries = 9`，
`blocked = 0`，`warnings = []`，三张门 G1/G2/G3 全 pass。

讲解点：

- Plan 是 `(courseKey, contentVersionId, targetId, planVersion)` 的确定性工件；
- 同一输入重复编译**字节相等**（canonical JSON，无 wall-clock / 随机 / locale）；
- 预览与保存走**同一编译函数**，保存时服务端重算并比对字节。

### 3.3 保存 → 签收 → 应用

```bash
PLAN_ID=$(jq -r '.data.planId' /tmp/plan-preview.json)
PLAN_VER=$(jq -r '.data.planVersion' /tmp/plan-preview.json)
CANON=$(jq -r '.data.canonicalJson' /tmp/plan-preview.json)

# 保存（回传 canonical bytes）
curl -s -b "$COOKIE" -X POST "$BASE/backoffice/courses/modeling-life/partc/plans/save" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg p "$PLAN_ID" --argjson v "$PLAN_VER" --arg c "$CANON" \
        '{planId:$p, planVersion:$v, canonicalJson:$c}')" \
  | jq '{status:.data.status, planVersion:.data.planVersion}'

# 人签（acceptedWarnings 必须与 preview.warnings 结构化相等；本包为空数组）
curl -s -b "$COOKIE" -X POST "$BASE/backoffice/courses/modeling-life/partc/plans/approve" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg p "$PLAN_ID" --argjson v "$PLAN_VER" \
        '{planId:$p, planVersion:$v, decision:"approved", acceptedWarnings:[]}')" \
  | jq '.data'

# 应用 = 冻结 ContentVersion（幂等；plans/publish 是同义入口）
curl -s -b "$COOKIE" -X POST "$BASE/backoffice/courses/modeling-life/partc/plans/apply" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg p "$PLAN_ID" --argjson v "$PLAN_VER" '{planId:$p, planVersion:$v}')" \
  | jq '.data'
```

讲解点（发布门的四道关）：

- **G1** 包/契约闭合；
- **G2** 结构 + 覆盖 + 证据绑定（STR/ALN）；
- **G3** 确定性 + 预算；
- **G4** 人签：`PlanApproval` 绑定 `(planId, planVersion)`，warnings 必须显式接受。
- 任何一步被拒都有显式错误码：`PLAN_NOT_APPROVED`、`PLAN_PREVIEW_STALE`、
  `PLAN_INPUT_CHANGED`、`PLAN_BLOCKED`。

> 课程“上线/上架”仍走既有发布与 live-status（`POST /courses/:id/publish`、
> `POST /courses/:id/live-status`）；Part C 的 apply 负责冻结内容版本。
> Portal 的学习计划投影是后续 P1，不在本演示范围。

---

## 4. 镜头 3：低置信 / 无源阻断

### 4.1 先看规则本身（30 秒，确定性）

```bash
cd server
npm test -- --runTestsByPath src/partc/compiler/derive-timing.spec.ts \
  -t "low-confidence"
```

这条单测直接断言：ASR 置信度低于 `minTranscriptConfidence` →
`ALIGNMENT_LOW_CONFIDENCE`（incomplete，带源坐标），阶段不能发布。

### 4.2 再看不给时间源的端到端后果

做一个“L002 没有任何 verified 对齐”的包（只改 manifest JSON，不动媒体）：

```bash
cd /tmp
rm -rf ml-noL002 && mkdir ml-noL002
python3 -I - <<'EOF'
import zipfile, json
src = '/Users/nihao/AI infra/LearningGuideAdmin/docs/package-examples/modeling-life-v2/lite/modeling-life-v2-lite.lgcourse.zip'
dst = '/tmp/ml-noL002'
zipfile.ZipFile(src).extractall(dst)
p = dst + '/manifest.json'
m = json.load(open(p))
m['content']['alignments'] = [a for a in m['content']['alignments']
                              if a['stageKey'] != 'lesson-l002']
json.dump(m, open(p, 'w'), ensure_ascii=False)
EOF
cd /tmp/ml-noL002 && zip -qr /tmp/ml-noL002.lgcourse.zip . -x '.DS_Store'
```

然后导入这个包（用 §2.2 的同一条命令，换文件名），确认导入能成功（它是
incomplete，不是 error），再预览 Plan：

```bash
curl -s -b "$COOKIE" -X POST \
  "$BASE/backoffice/courses/modeling-life/partc/plans/preview" \
  | tee /tmp/p-blocked.json \
  | jq '{status:.data.status, gaps:.data.gaps,
         issues:[.data.issues[]|{code,invariant,details}]}'
```

预期：`status = "blocked"`；gap 是 `ALN-1`（该交付叶没有 target 内的 verified rendition）
与 `ALN-7`（视频 rendition 没有 verified 对齐 / 机器时间源）。

即使先保存，**签收也会被拒绝**：blocked 的 Plan 不允许 approve。

```bash
B_ID=$(jq -r '.data.planId' /tmp/p-blocked.json)
B_VER=$(jq -r '.data.planVersion' /tmp/p-blocked.json)
B_CANON=$(jq -r '.data.canonicalJson' /tmp/p-blocked.json)

# 保存可以成功（Plan 作为工件落库）
curl -s -b "$COOKIE" -X POST "$BASE/backoffice/courses/modeling-life/partc/plans/save" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg p "$B_ID" --argjson v "$B_VER" --arg c "$B_CANON" \
        '{planId:$p,planVersion:$v,canonicalJson:$c}')" > /dev/null

# 签收被拒：HTTP 409，PLAN_NOT_APPROVED（"a blocked plan cannot be approved"）
curl -s -b "$COOKIE" -X POST "$BASE/backoffice/courses/modeling-life/partc/plans/approve" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg p "$B_ID" --argjson v "$B_VER" \
        '{planId:$p,planVersion:$v,decision:"approved",acceptedWarnings:[]}')" | jq '.'
```

预期 HTTP 409，拒绝码 `PLAN_NOT_APPROVED`。没有签收就不可能有 apply；
即使已签收的 Plan 之后因内容/对齐变化变成 blocked，apply 也会以 `PLAN_BLOCKED` 拒绝
（服务端重算后判定）。

讲解口径：

- **导入成功 ≠ 能发布**。缺语言、缺正文、缺时间源是 `incomplete`，允许入库供编辑，
  但发布门会阻断；
- 系统**不猜时间、不 clamp、不估算**：没有字幕/章节/ASR 就是没有；
- 修法在内容侧：补字幕、补章节轨，或让 ASR 兜底并 pin 模型版本；
  人只做播放复核，不手输时间。

> 纯编译器层面可以独立复现：对同一个“无时间源”目录运行
> `build/verify_with_compiler.ts`，会看到 `TIMING_SOURCE_MISSING` 与缺失的 LP 坐标。

---

## 5. 镜头 4：闭合包拒绝坏包

所有变体都在 `/tmp` 里做，**不要修改示范包原件**。四种坏包与预期错误码
（均已实测）：

| 变体 | 做法 | 预期错误码 |
|---|---|---|
| 缺文件 | 删掉 manifest 已声明的 `media/cover.png` | `PACKAGE_FILE_MISSING` |
| 多文件 | 往根目录加一个 `extra.txt` | `PACKAGE_FILE_UNKNOWN` |
| 旧格式 | 把 `manifest.formatVersion` 改成 `1` | `PACKAGE_FORMAT_UNSUPPORTED` |
| 时间列 | 给 `Exhibits` 加一列 `trigger_time` 并填 `00:10`（同时更新 manifest 的 template size） | `HUMAN_TIME_FORBIDDEN` |

快速造包：

```bash
cd /tmp
rm -rf ml-bad && mkdir -p ml-bad
python3 -I - <<'EOF'
import zipfile, os, shutil, json
src = '/Users/nihao/AI infra/LearningGuideAdmin/docs/package-examples/modeling-life-v2/lite/modeling-life-v2-lite.lgcourse.zip'
base = '/tmp/ml-bad'
for name in ['missing', 'unknown', 'oldformat', 'timecol']:
    d = os.path.join(base, name); shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    zipfile.ZipFile(src).extractall(d)
os.remove(os.path.join(base, 'missing', 'media/cover.png'))
open(os.path.join(base, 'unknown', 'extra.txt'), 'w').write('not declared\n')
p = os.path.join(base, 'oldformat', 'manifest.json')
m = json.load(open(p)); m['formatVersion'] = 1
json.dump(m, open(p, 'w'), ensure_ascii=False)
EOF

# 时间列变体（用 server 的 xlsx，改完同步 manifest 里的 template size）
cd server
node -e "
const X=require('xlsx'), fs=require('fs');
const dir='/tmp/ml-bad/timecol';
const wb=X.readFile(dir+'/template.xlsx');
const rows=X.utils.sheet_to_json(wb.Sheets['Exhibits'],{header:1,defval:''});
rows[0].push('trigger_time');
for(let i=1;i<rows.length;i++) rows[i][rows[0].length-1]='00:10';
wb.Sheets['Exhibits']=X.utils.aoa_to_sheet(rows); X.writeFile(wb,dir+'/template.xlsx');
const m=JSON.parse(fs.readFileSync(dir+'/manifest.json','utf8'));
m.resources.find(r=>r.kind==='template').size=fs.statSync(dir+'/template.xlsx').size;
fs.writeFileSync(dir+'/manifest.json',JSON.stringify(m));
"

# 分别打包并上传
for d in missing unknown oldformat timecol; do
  (cd "/tmp/ml-bad/$d" && zip -qr "/tmp/ml-bad-$d.lgcourse.zip" . -x '.DS_Store')
  echo "=== $d ==="
  J=$(curl -s -b "$COOKIE" -F "file=@/tmp/ml-bad-$d.lgcourse.zip" \
        "$BASE/backoffice/courses/import" | jq -r '.data.jobId')
  curl -s -b "$COOKIE" "$BASE/backoffice/courses/import/$J" \
    | jq '{status:.data.status, error:.data.error, errors:.data.report.errors}'
done
```

预期四个 job 都是 `FAILED`，`error` 分别是对应错误码；报告里的 `errors[]` 带
`source.sheet / row / column`（或 JSON path）。讲解点：

- **校验先于清洗、原子拒绝**：任一 error → 整包拒绝，草稿/分类/对齐都不变；
- **不自动修复**：不改名、不跳过行、不造占位分类、不猜时间；
- **闭合包**：声明↔文件必须 1:1；路径不能越界；未声明的文件也算坏包。

---

## 6. 镜头 5：跨环境 provenance

设计决策：**Production 只接受 Sandbox 导出的 v2 包**；来源判定只认服务端解析出的
`provenance.sourceEnv`，不看文件名/目录。强制开关默认休眠，演示时显式打开。

### 6.1 起一个“生产配置”的实例

另开一个终端（同一个库即可，但建议独立库避免污染），用不同端口：

```bash
cd server
PORT=3001 \
VERSION_NUMBERING_MODE=production \
PACKAGE_SOURCE_ENFORCEMENT=on \
ENV_CAPABILITY_ENFORCEMENT=on \
npm run start:dev
```

- `VERSION_NUMBERING_MODE=production` 让服务端把当前环境判定为 Production；
- `PACKAGE_SOURCE_ENFORCEMENT=on` 打开来源门；
- `ENV_CAPABILITY_ENFORCEMENT=on` 打开能力矩阵（Production 禁 authoring）。

### 6.2 正常：Sandbox 包被接受

用 §2.2 的登录/上传命令指向 `BASE=http://localhost:3001/api`，上传 lite 包：

- 上传校验通过（`AWAITING_CONFIRM`）；
- `confirm` 时来源门检查 `provenance.sourceEnv === "sandbox"` → 通过；
- 导入成功。演示 `jq '.provenance' full/package/manifest.json`：
  `sourceEnv=sandbox`、`sourceVersionLabel=1.0`、`planPin`、`approvalRef`、`auditSummaryRef`。

### 6.3 伪造来源：被拒

把包复制一份，只改 `provenance.sourceEnv = "production"`：

```bash
cd /tmp
rm -rf ml-forged && mkdir ml-forged
python3 -I - <<'EOF'
import zipfile, json, os
src = '/Users/nihao/AI infra/LearningGuideAdmin/docs/package-examples/modeling-life-v2/lite/modeling-life-v2-lite.lgcourse.zip'
dst = '/tmp/ml-forged'
zipfile.ZipFile(src).extractall(dst)
p = dst + '/manifest.json'
m = json.load(open(p)); m['provenance']['sourceEnv'] = 'production'
json.dump(m, open(p, 'w'), ensure_ascii=False)
EOF
(cd /tmp/ml-forged && zip -qr /tmp/ml-forged.lgcourse.zip . -x '.DS_Store')
```

上传 → 校验通过（契约本身合法）→ `confirm` 返回
**`PACKAGE_SOURCE_NOT_ALLOWED`**（job `FAILED`，草稿不变）。

讲解点：来源不是靠文件名/目录/上传位置判断，而是包内字段；伪造字段会被服务端
按同一契约识破。`provenance` **不参与包身份、幂等与 staleness**，只用于来源判定
与追溯（谁、在哪个环境、基于哪份字幕/章节、何时验证）。

### 6.4 能力矩阵（可选）

在生产配置实例上：

- `PUT /api/backoffice/courses/:id`（内容编辑/分类）→ **403 `CAPABILITY_DISABLED`**；
- `POST /api/backoffice/courses/import`、`plans/*`、`:id/publish`、`:id/live-status`
  → 允许（Production 的“不允许维护”只指内容编辑/新建/结构变更）。

---

## 7. 一页命令清单（lite 全流程）

```bash
BASE=http://localhost:3000/api
COOKIE=/tmp/lg-demo-cookie.txt
PKG=lite/modeling-life-v2-lite.lgcourse.zip

curl -s -c "$COOKIE" -X POST "$BASE/backoffice/auth/sign-in" \
  -H 'content-type: application/json' -d '{"email":"demo@example.com","password":"..."}'

JOB=$(curl -s -b "$COOKIE" -F "file=@$PKG" "$BASE/backoffice/courses/import" | jq -r '.data.jobId')
curl -s -b "$COOKIE" "$BASE/backoffice/courses/import/$JOB" | jq '.data.status'

curl -s -b "$COOKIE" -X POST "$BASE/backoffice/courses/import/$JOB/confirm" \
  -H 'content-type: application/json' -d '{"onConflict":"ABORT"}' | jq '.data'

curl -s -b "$COOKIE" -X POST "$BASE/backoffice/courses/modeling-life/partc/plans/preview" \
  | tee /tmp/p.json | jq '{status:.data.status, n:(.data.entries|length), warnings:.data.warnings}'

PLAN_ID=$(jq -r '.data.planId' /tmp/p.json); PLAN_VER=$(jq -r '.data.planVersion' /tmp/p.json)
CANON=$(jq -r '.data.canonicalJson' /tmp/p.json)

curl -s -b "$COOKIE" -X POST "$BASE/backoffice/courses/modeling-life/partc/plans/save" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg p "$PLAN_ID" --argjson v "$PLAN_VER" --arg c "$CANON" \
        '{planId:$p,planVersion:$v,canonicalJson:$c}')" | jq '.data.status'

curl -s -b "$COOKIE" -X POST "$BASE/backoffice/courses/modeling-life/partc/plans/approve" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg p "$PLAN_ID" --argjson v "$PLAN_VER" \
        '{planId:$p,planVersion:$v,decision:"approved",acceptedWarnings:[]}')" | jq '.data'

curl -s -b "$COOKIE" -X POST "$BASE/backoffice/courses/modeling-life/partc/plans/apply" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg p "$PLAN_ID" --argjson v "$PLAN_VER" '{planId:$p,planVersion:$v}')" \
  | jq '.data'
```

---

## 8. 讲解口径（常见提问）

**Q：包身份是什么？为什么没有哈希？**
A：身份 = `(formatVersion, courseKey, versionNo)`。传输完整性靠 ZIP CRC32 + 声明大小 +
类型校验。哈希会把“重编码/换环境”误判成新内容，且跨环境永远不等；规格明确禁止。

**Q：重复导入会怎样？**
A：同一 `(courseKey, versionNo)` 是 no-op（天然幂等）。新版本按“替换草稿 + 写后删差集”，
只删旧清单记录过、新清单不再引用、且无其他版本引用的资源。

**Q：时间是谁填的？**
A：没有人填。字幕 > 章节轨 > ASR（默认兜底）> 强制对齐；每个视频 × 每个语言独立派生；
区间规则版本化为 `timing-rules-v1`。人只在 Sandbox 播放复核语义并签收。

**Q：低置信会怎样？**
A：`ALIGNMENT_LOW_CONFIDENCE`（incomplete，带源坐标）；该阶段 blocked，发布门拒绝
（`PLAN_BLOCKED`）。系统不猜、不 clamp、不估算。

**Q：旧包能导入吗？**
A：不能，也没有兼容层。`formatVersion ≠ 2`、缺 `templateVersion=2`、出现
`course.category` 字符串或 `checksums` 都会被拒绝。

**Q：Production 能改内容吗？**
A：不能（403 `CAPABILITY_DISABLED`）。Production 的唯一内容写路径是“导入 Sandbox 包”，
之后可以 plan preview/approve/publish、restore、change status。
