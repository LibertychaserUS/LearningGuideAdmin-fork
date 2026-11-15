# RBAC 能力模型改造计划（立项稿）

- 状态：评审后修订（2026-11-14，两轮评审 + 8-agent workflow）
- 关联缺陷：BUG-0329（员工账号权限）、其上游问题为"策略重复 + 粒度只到菜单"
- 范围：LearningGuideAdmin（`server/` NestJS + `client/` Vite SPA）
- 目标读者：Admin 前后端 owner、QA
- 日期：2026-11-14

---

## 1. 为什么要做

当前 RBAC 能跑，但有三个结构性债（均有代码证据）：

| # | 问题 | 证据 |
|---|---|---|
| 1 | 策略有两份，客户端还丢弃服务端下发的结论 | 两端各有一份完整策略模块（`server/.../rbac/permissions.ts` 203 行、`client/.../rbac/permissions.ts` 205 行）；服务端已在 `auth.controller.ts:331-334` 给出 `menus/settings/canManageEmployeeAccount`，客户端 `SessionPayload` 不含这些字段，`AppShell.tsx:94`、`SettingsSubNav.tsx:28`、`ModulePages.tsx:45-48`(MenuGuard) 各自用本地矩阵重算。（注：曾以为 `operations → course` 只在客户端，实际服务端 `route-access.ts:186-191` 也有，只是用途不同，不构成漂移） |
| 2 | 授权粒度只到"菜单"，员工账号管理是角色布尔特例 | `canAccessEmployeeAccount(role) => role === 'ADMIN'`；路由上单开 `employeeAdmin` kind；会话单开 `canManageEmployeeAccount` |
| 3 | 路由 → 权限是手写 if 链，漏登记静默放行 | `server/src/backoffice/nest/route-access.ts`（208 行）；未登记路径落到 `employeeAdmin`，语义是"只有 Admin"，两个方向都可能错 |

补充：动作与级别是两套词表（`ActionKind` vs `PermissionLevel`），靠 `isActionAllowed` 的 switch 桥接；HTTP 动词 → 动作靠各模块手写规则（`actionFor`、`backofficeCourseAction`）。

**结论**：问题不是"少几条校验"，而是"被授权的对象"建模错了——现在的对象是菜单，应该是能力。

---

## 2. 目标与非目标

### 目标

1. **单一策略源**：角色 → 能力只有一份，服务端持有。
2. **能力级授权**：`模块:动作`（如 `course:publish`、`employee:manage`），菜单/级别/设置子项都由能力投影出来。
3. **声明式执行**：路由在 controller 方法上声明所需能力；漏声明 = 拒绝 + CI 失败。
4. **客户端不持有策略**：会话下发 `capabilities`，客户端只渲染。
5. **行为零变化**：PRD §3.2 的 6 角色 × 8 菜单语义原样保留，通过等价测试证明。

### 非目标

- 不改 PRD §3.2 的角色与菜单定义。
- 不引入按人配置权限（per-user ACL）——能力模型为它留了口子，但本期不做。
- 不改 Portal 学员端权限：`/api/user/**`（服务密钥）与 `/api/portal/**`（Admin 托管的 6 个 handler）都保持现状的通道语义。
- 不动 HelpDesk 集成令牌、KS 内部令牌这类服务间鉴权。

---

## 3. 目标模型

#

## 3.1 能力是原子单位

命名：`<domain>.<resource>.<action>`（2–4 段，小写），**不带菜单名**。

注册表每条能力带三个属性：

```ts
type Capability = {
  id: 'course.cover.update'
  domain: 'course'                  // 与 MenuKey 的映射在 surface 层定义，不反向依赖
  level: 'VIEW' | 'EDIT' | 'FULL'   // 仅用于兼容视图 levelFor 的投影，不是授权单位
  kind: 'enforced' | 'presentation'
}
```

> **`level` 是必需的（评审修正）**：没有它，"FULL ≈ 一组能力"就无法反推回 `EDIT/FULL`，P0 的 6×8 等价也不可能成立（FINANCE 的 order/reporting=FULL、ADMIN 的 settings=FULL、GRAPHIC_DESIGNER 的 course=EDIT 都投不出来）。`level` 只是便于兼容期展示，授权判断仍然逐条能力。

| 域 | 能力（附 level） |
|---|---|
| course | `course.view`(VIEW)；`course.meta.update` / `course.localization.update` / `course.lesson.create·update·delete·reorder` / `course.lesson.media.upload` / `course.cover.update`(EDIT)；`course.package.import` / `course.package.export` / `course.version.publish` / `course.plan.update` / `course.trial.update` / `course.syncStripe.run` / `course.ops.update`(FULL) |
| knowledge | `knowledge.page.view` / `knowledge.release.view`(VIEW)；`knowledge.page.update` / `knowledge.upload.convert`(EDIT)；`knowledge.page.create` / `knowledge.page.delete` / `knowledge.release.publish` / `knowledge.tag.manage`(FULL) |
| aiTutor | `aiTutor.view` / `aiTutor.chat.test`(VIEW)；`aiTutor.config.update`(EDIT)；`aiTutor.config.publish`(FULL) |
| student | `student.view`(VIEW)；`student.email.change` / `student.access.change` / `student.status.change`(FULL) |
| employee | `employee.view`(VIEW)；`employee.create` / `employee.role.assign` / `employee.status.change` / `employee.password.reset`(FULL) |
| helpDesk | `helpDesk.ticket.view`(VIEW)；`helpDesk.ticket.reply` / `helpDesk.ticket.assign` / `helpDesk.faq.update` / `helpDesk.faq.publish`(FULL) |
| settings | `settings.view`(VIEW)；`settings.learningAccess.update`(EDIT)；`settings.learningAccess.publish`(FULL) |
| order / reporting | `order.view` / `reporting.view`(VIEW)；`order.manage` / `reporting.manage`(FULL，presentation：后台暂无接口) |

> 评审修正的两处：`settings` 原来只有一个 `learningAccess.switch`，无法表达 4 个角色的 `settings=VIEW`；`course.plan.update` 之外还缺 `trial` 与 `sync-stripe`（现有引擎把它们判为 CREATE）。已补齐。

#

## 3.2 角色是 bundle；能力不是从矩阵机械推出来的

```ts
ROLE_CAPABILITIES: Record<EmployeeRole, CapabilityId[]>
```

- 定义时允许组语法（`course.*`、`course.lesson.*`），**构建期展开成显式集合**；运行期不出现通配符，审计日志与 diff 都可读。
- 角色只是 bundle 的一个名字。将来要"按人加一条能力"（目前明确不做），只需给用户挂增量集合，模型不用改。

> **重要修正（评审发现）**：能力**不能**只由"矩阵 + 模块"机械展开。现有授权里存在矩阵表达不了的特例：
> - `GET /api/courses` 只对 knowledge / aiTutor 开放（`route-access.ts:199-205`），因此 OPERATION_ADMIN 虽然 course=FULL，读它仍然 403，`server/test/backoffice.e2e-spec.ts:160-176` 已断言；
> - `POST /ai/chat-stream` 是 VIEW、`files/convert` 是 EDIT_EXISTING、helpdesk/students 的写是 CREATE（`route-access.ts:53-77`），纯按动词或按级别展开都会变。
>
> 所以：**每条路由的能力来自 `route-access` 的显式映射（P1 逐条抄成声明），矩阵只决定"角色持有哪些能力"**。等价测试也不能用"矩阵投影"，必须用"旧引擎对 (role, method, path) 的判定 == 新引擎的判定"逐条对比。

#

## 3.3 Surface：菜单与按钮是能力的投影

```ts
MENU_SURFACE: Record<MenuKey, CapabilityId[]>           // 任一能力存在 → 菜单可见
SETTINGS_SUB_SURFACE: Record<SettingsSubKey, CapabilityId[]>
```

- 产品重排导航时只改 surface，不动授权。
- **兼容投影**：`levelFor(role, menu)` = 该角色在 `MENU_SURFACE[menu]` 中拥有的能力的最大 `level`。这是精确的，不是靠动词名猜。
- **bundle 生成规则**：角色在某菜单的矩阵级别为 `L` 时，授予该菜单下所有 `level ≤ L` 的能力。由此 6×8 逐格投影**恒等**——这是 P1 的机械保证，不是人工核对。
- **`employee.*` 是例外，单独授予**：它不属于 8 个 `MenuKey`，不参与上面的按菜单展开。规则写死为"**只有 ADMIN 持有** `employee.view / employee.create / employee.role.assign / employee.status.change / employee.password.reset`"。`SETTINGS_SUB_SURFACE.employeeAccount = [employee.view]`；OPERATION_ADMIN 虽然 `settings=FULL`，**不得**因此拿到 `employee.*`（与 `backoffice.e2e-spec.ts` 的 employees=403 断言一致）。这条必须有独立测试。
- **真正的等价标准**仍然是逐路由判定（见 §6），投影只是兼容视图。

#

## 3.4 执行点（服务端）

```ts
@Require('course.view')            @Get()
@Require('course.version.publish') @Post(':id/publish')
@Require('course.cover.update')    @Put(':id/cover')
@RequireAny('knowledge.page.view', 'aiTutor.view')   // 共享路由，显式表达"任一"
@Public() @ServiceOnly() @InternalOnly() @SignedIn()
```

- 全局 guard 从 Metadata 读声明；**无声明 → 403 + 结构化告警**（默认拒绝，由下面的模式开关控制）。
- **模式开关**：`RBAC_ENFORCEMENT=shadow|enforce`，默认 `shadow`。P2a/P2b 用 `shadow`（只记录判定，不拦截），P2c 切 `enforce`。没有这个开关，§3.4 的"无条件 403"会和 §4"P2c 前不改线上授权"直接冲突。
- **元数据作用域**：装饰器只允许标在**方法**上，禁止类级 `@Public/@Require`（Nest 会把类级元数据继承到未覆盖的方法；`auth.controller.ts` 同一个类里既有 public 又有必须登录的方法）。扫描测试按方法枚举，类级标记直接判失败。
- `route-access.ts` 的 if 链在 P2 末尾整体删除。
- 路径归一化（大小写、尾斜杠）收进 guard，不散落在业务判断里。
- 拒绝日志带 `{ employeeId, role, capability, method, path }`；能力串稳定，可直接做审计统计。

#

## 3.5 客户端

- `/api/session` 下发 `capabilities: string[]`；`EmployeeContext` 一并携带（现在是 `SessionEmployee`，评审指出计划漏了这一层：`employeeSession.ts:5,11,20`）。
- 客户端判断用能力串；菜单/子项/按钮由能力派生。
- **过渡层要改的对**：`WorkspaceAccessProvider` 只挂在 knowledge/aiTutor/helpDesk 三处（`App.tsx:147/157/171`），全仓 **13 个文件** import `rbac/permissions`（App、ShellRoute、AppShell、SettingsSubNav、employeeSession、workspaceAccess、workspaceAccessState、CourseEditorPage、CourseManagementPage、EmployeeAccountPage、LearningAccessPage、ModulePages、StudentManagementPage）。评审确认 `access.can(action)` **没有任何调用点**，真正被用的是菜单作用域的 `canEdit/canCreate/canPublish` —— 过渡层应保留这三个布尔量（由该域能力集合推导），而不是保留 `can(action)`。
- `MenuGuard`（`ModulePages.tsx:45-48`）吃的是路由上写死的 `menu` 字面量，不是 URL 反查；P3 改为从 Context 的 capabilities 判断，不复制 MENU_SURFACE。
- **P3 与 P4 的顺序冲突（评审发现）**：P3 删 `ROLE_MATRIX`，但 `roleAccessRows`（`EmployeeAccountPage.tsx:638`）依赖它，计划却把改造放到 P4。合并为：`roleAccessRows` 在 P3 一并改为读能力清单。

#

## 3.6 治理规则（防止原子化变成碎片化）

1. 注册表只有一个文件；CI 校验命名格式、唯一性、无未登记使用。
2. 每条能力必须标注 `enforced | presentation`，且至少被一条路由或一个 surface 引用。
3. 角色 bundle 的变更必须在 PR 描述里给出**能力级 diff**（加了什么、减了什么），不允许只写"调整了权限"。
4. 新增能力必须同时给出：所属域、动作语义、默认授权角色、审计字段。

---

#

## 3.7 两层能力：环境层与身份层（2026-11-14 已定：分层）

仓库里本来就有第二套能力，只是语义不同。两者**分层并存，不做合并**：

| | 环境层（已有） | 身份层（本次新建） |
|---|---|---|
| 问题 | 这个**部署环境**允许这类操作吗？ | 这个**员工**允许吗？ |
| 注册表 | `COURSE_CAPABILITIES` = `course.authoring` / `course.import` / `course.publish` / `course.status`（`partc/contracts/environment.ts:32-37`） | `CAPABILITY_REGISTRY`（§3.1） |
| 依据 | `VERSION_NUMBERING_MODE` 推出的 environment × 能力矩阵（`:46-51`） | 角色 bundle |
| 执行 | `CourseCapabilityGuard`（`commerce-courses/course-capability.guard.ts:33`），挂在 `commerce-courses.controller.ts:57` 与 `partc-admin.controller.ts:37` | 新 `CapabilityGuard` |
| 拒绝码 | `CAPABILITY_DISABLED`（403） | `NOT_AUTHORISED`（403） |
| 现状 | 默认休眠（`ENV_CAPABILITY_ENFORCEMENT=off` 时原样放行） | 新上线 |

**执行顺序：认证 → 环境层 → 身份层。**

> **评审修正（第二轮）**：这个顺序在现有挂载方式下做不到。`BackofficeAccessGuard` 与新的 `CapabilityGuard` 是 **APP_GUARD（全局）**，`CourseCapabilityGuard` 是 **controller 级 `@UseGuards`**，Nest 固定按 `global → controller → route` 执行，实际顺序是"认证 → 身份层 → 环境层"，两层同时拒绝时会先抛 `NOT_AUTHORISED`，用户看不到 `CAPABILITY_DISABLED`。
>
> 修法：把环境层也改成**全局守卫**（内部按路径匹配课程路由），顺序才可控；同时要补上覆盖面——现在 `pages` / `releases` / `files` / `sync` / `tags` 控制器都没有 `@UseGuards`，其 `/api/courses/**`、`/api/pages/**` 等路径也不匹配 `COURSE_PREFIX`，`ENV_CAPABILITY_ENFORCEMENT=on` 时仍然绕得过。这两项计入 P2a。

1. 认证先跑，401 语义不变（`backoffice-access.guard.ts:87`）；
2. 环境层判定部署策略——它和"你是谁"无关，先给出 `CAPABILITY_DISABLED` 比伪装成"你没权限"更准确；
3. 身份层最后判定角色能力。

**非会话通道的凭据（现状，必须在计划里落定）**：`service` 走 `ApiKeyGuard`（`AUTH_ENABLED!=='true'` 时直接放行，是开关不是令牌）、`internal` 走 `KS_SERVICE_TOKEN || AUTH_TOKEN`（Bearer 或 `X-API-Key`，未配置时仅非部署环境放行）、`helpdeskIntegration` 走每次现读的 `ADMIN_HELPDESK_TOKEN`。P2c 删除 `route-access.ts` 时这些分流必须原样保留，否则线上 401。

**两条不变式（进 CI）：**

- 两个注册表的 id 集合**互不相交**（`course.import` 是环境级，`course.package.import` 是身份级，同名必错）；
- 同一路由可以同时要求两层，语义是"**与**"：`POST /backoffice/courses/import` 既受环境层 `course.import` 约束，也要求身份层 `course.package.import`。

**本期不改环境层的判定方式**（仍是路径映射 + 环境矩阵），只固定层级、顺序与去重规则；把它的路径映射也声明式化的收益不大，不计入本期。

## 4. 分阶段计划

> P1 之后的每个阶段可独立发布；P0 的测试与 P1 同 PR 落地（P0 单独提交红灯会挂 CI，见下）。任何阶段都不改变线上授权结果，除 P2c 的"未声明即拒绝"。

### P0 — 基线与等价测试（0.5 人日）

- 冻结旧引擎对 `(role, method, path)` 的判定为基线。范围是**全仓 31 个 controller、235 个 handler**（不是 backoffice/nest 的 86 个——其余 149 个分在三组，明细见 §4 P2a；另见 §12 Q2）。
- 产出 `policy-equivalence.spec.ts`。**与 P1 同一个 PR 落地**：CI 直接跑 `npm test`，单独提交红灯会卡住所有人。

**验收**：基线快照入库；等价测试在 P1 合入时由红转绿。
**注意**：这份测试 import 旧 `route-access`，P2c 删除旧引擎时必须同步改写，否则编译失败（已列入删除清单）。

### P1 — 策略与投影（1 人日，无行为变化）

- 新增 `server/src/backoffice/modules/rbac/capabilities.ts`（原子能力注册表 + `enforced|presentation` 标注）与 `policy.ts`（`ROLE_CAPABILITIES`、`MENU_SURFACE`、`SETTINGS_SUB_SURFACE`、`menuVisible/levelFor/menusFor/settingsFor`）。
- 能力初版按 §3.1 的表落地；`ROLE_CAPABILITIES` 由现有矩阵 + `route-access` 反推生成，生成脚本入库，便于复核。
- 治理校验测试：命名格式、唯一性、无用能力、未登记能力，以及与 `COURSE_CAPABILITIES` 的**互斥校验**（§3.7）。
- 旧 `permissions.ts` 保留但改为委托 `policy.ts`，避免双份实现。

**验收**：等价测试全绿；`route-access` 与 guard 行为不变；无客户端改动。

### P2 — 声明式执行（4.5 人日）

**P2a 声明与扫描（3 人日）**
1. 新增装饰器与 `CapabilityGuard`。**执行顺序必须在 `BackofficeAccessGuard` 之后**：role 由后者写入 `request.employee`（`backoffice-access.guard.ts:87-88`），顺序反了会导致影子日志拿不到 role，且无会话请求从 401 `INVALID_EMPLOYEE_ACCOUNT` 变成 403 `NOT_AUTHORISED`（`test/backoffice.e2e-spec.ts:56-57` 有断言）。
2. 逐 handler 补声明：**31 个 controller、235 个 handler**。分组如下（评审逐个数过）：

   | 组 | handler |
   |---|---|
   | `backoffice/nest` | 86 |
   | 业务模块 | `commerce-courses` 66、`partc-admin` 19、`ai` 12（含 3 个 service）、`releases` 7、`pages` 5、`courses` 5、`operations` 5、`sync` 3、`files` 3、`tags` 4 = **129** |
   | 其余 | `portal-courses` 6、`ks-internal` 8、`helpdesk-suggest` 2、`learner-image` 1、`app` 1、`health` 1、`environment` 1 = **20** |

   `86 + 129 + 20 = 235`。五类非菜单通道（`public/service/internal/helpdeskIntegration/signedIn`）按 §3.7 的凭据语义分别声明。
3. 串联环境层与身份层：认证 → `CourseCapabilityGuard` → `CapabilityGuard`，两者都过才放行；补两条不变式测试（id 不相交、同路由两层相与）。
4. 路由扫描测试：用 Nest `DiscoveryService` + `ALL_ROLES` 装配。**位置必须在 `server/src/` 下**（`package.json:102-107` 的 jest roots 只含 src 与 eval），并注入 `DATABASE_URL` 等最小环境——`AppModule` 在文件求值期就会校验 env（`app.module.ts:202-203`、`env.validation.ts:9-13`），缺变量直接抛错。`main.ts` 的 2 条非 `/api` 裸路由单独列入白名单。

**P2b 影子比对（0.5 人日）**
5. DEV 同时运行新旧引擎，只比对、不拦截。门槛：声明覆盖 100% + 已声明路由在 6 个角色下判定逐条一致（未声明路由必然有差异，不能当门槛）。

**P2c 切换与删除（1 人日）**
6. 打开"未声明即 403"；删除 `route-access.ts`；
7. 同步改写：P0 的等价测试（import 旧引擎）、`route-access.spec.ts`（330 行按菜单组织的用例）、`students.spec.ts:15,68-84`（import `routeAccess`）、7 个 `*-rbac.spec.ts`。
8. 全仓 235 个 handler 与 6×8 投影双绿。

**验收**：扫描测试通过（覆盖率 100%）；已声明路由判定逐条一致；旧引擎与其测试全部有等价替代。

> **依赖**：`commerce-courses.controller.ts` 等文件正被 Part C 工作流修改（未提交），P2 需在其合入后开始。可先做 students / helpdesk / employees 试点。

### P3 — 会话下发与客户端切换（2 人日）

- `/api/session` 增加 `capabilities`；`SessionPayload` 与 `EmployeeContext` 一并通过（`employeeSession.ts:5,11,20`）。
- 13 个 import `rbac/permissions` 的文件改为消费能力（清单见 §3.5）。
- `WorkspaceAccessProvider` 保留 `canEdit/canCreate/canPublish` 三个布尔量，内部由能力推导；**不保留 `can(action)`**（评审确认它当前零调用）。
- `MenuGuard` 改由 Context 判断，不复制 surface。
- `roleAccessRows` 与 `EmployeeAccountPage` 的角色矩阵展示**在此阶段**一并改为读服务端能力（与 P4 的顺序冲突见 §3.5）。**需要新增一个只读接口**：`GET /api/admin/roles`（ADMIN 才能访问，返回 `[{ role, capabilities[] }]`），否则该页面除"本人 session"外没有任何合法的角色→能力来源。
- 删除客户端策略副本；保留展示常量（菜单顺序、路径段）。

**验收**：客户端不再 import `ROLE_MATRIX`；四个角色（ADMIN / GRAPHIC_DESIGNER / OPERATION_ADMIN / FINANCE）菜单、设置子项、关键按钮与改造前逐屏一致（截图）。

### P4 — 员工账号能力化与收尾（1 人日）

- `employeeAdmin` kind、`canManageEmployeeAccount`、`canAccessEmployeeAccount` 删除，改由 `employee.view` / `employee.role.assign` / `employee.status.change` 表达；
- BUG-0329 的角色矩阵展示改为读服务端能力（消除对本地矩阵的依赖）；
- 文档更新（PRD 映射表、`BackOffice_Portal_Implementation.md` §3）；
- 清理死代码与旧测试。

**验收**：0329 的三张验证截图在改造后重现；全仓无 `role === 'ADMIN'` 形式的授权判断（员工不变量除外）。

**合计：约 9 人日**（P0 0.5 + P1 1 + P2 4.5 + P3 2 + P4 1；不含评审与 DEV 观察等待）。

---

## 5. 兼容与迁移策略

1. **先包装、后替换**：P1 让旧 API 委托新策略，行为不变；P2 才切换执行引擎。
2. **影子比对**：P2 期间同时运行旧解析与新声明，仅记录差异不拦截；门槛是"声明覆盖 100% + 已声明路由判定一致"（未声明路由必然有差异，不能作为门槛）。
3. **客户端零信任**：即使客户端判断错了，服务端仍按能力拒绝——客户端只影响可见性，不影响安全性。
4. **回滚**：每个 PR 独立。**注意 P2c 一旦删除 `route-access.ts`，就不存在"关开关回旧引擎"**；前端与 API 同镜像（`main.ts:24-62`），回滚单位是整包回滚到上一版本。因此 P2c 必须与切换同一次发布，并在发布前确认上一版本可回退。

---

## 6. 测试策略

| 层次 | 内容 |
|---|---|
| 等价（唯一权威口径） | 旧引擎对 `(role, method, path)` 的判定 == 新引擎判定，逐路由比较；6×8 投影只作为兼容视图校验，**不能**当作等价标准（§3.2） |
| 覆盖 | 路由扫描：每个 handler 有声明或豁免；每个 **enforced** 能力至少被一条路由引用；每个 presentation 能力必须属于某个可见菜单 |
| 契约 | 会话 `capabilities` 推出的菜单 == `menus`；客户端渲染的菜单 == 会话菜单 |
| 行为 | 保留现有 route-access 用例的核心断言（迁移为能力断言），例如 Course=EDIT 不能 publish、HelpDesk 写需要 FULL |
| 回归 | 浏览器验证：至少覆盖 ADMIN / GRAPHIC_DESIGNER / OPERATION_ADMIN / FINANCE 四个角色的菜单与关键按钮 |
| 破坏面（必须同步改） | `server/test/backoffice.e2e-spec.ts:180-186` 断言 `menus/canManageEmployeeAccount`；`students.spec.ts:15,68-84` import `routeAccess`；7 个 `*-rbac.spec.ts`；`BackofficeAccessGuard` 生产装配 1 处（`app.module.ts:189`）+ 测试装配 9 处；客户端 `MenuGuard` 与 13 个 import `rbac/permissions` 的文件 |

---

## 7. 验收标准（DoD）

1. 仓库中只有一份角色策略，客户端零策略副本。
2. 全仓 31 个 controller、235 个 handler 都通过装饰器声明能力（或列入显式豁免）；扫描测试在 CI 中阻止漏声明。
3. 对全部**已声明路由**（235 个 handler 全覆盖 + 显式豁免清单），新引擎判定与旧引擎在 6 个角色下逐条相等；未声明路由按设计拒绝。6×8 投影仅作为兼容视图校验。
4. 四类角色在浏览器中的菜单、设置子项、关键操作按钮与改造前一致（附截图）。
5. BUG-0329 的"最后一个 Admin"与"角色权限展示"在新模型下仍然成立。
6. `route-access.ts`、客户端 `rbac/permissions.ts` 的策略部分、`employeeAdmin` 特例均已删除。
7. 仓库内只有一套能力模型：`commerce-courses/course-capability.guard.ts` 的 `course.authoring/course.publish` 已并入或明确边界（见 §12）。

---

## 8. 风险与依赖

| 风险 | 影响 | 应对 |
|---|---|---|
| Part C 工作流正在改 `commerce-courses.*`、路由相关文件 | P2 冲突 | P2 排在其合入之后；先做 P1（纯新增） |
| 两套判定引擎短期并存 | 双重真相 | 影子只比对已声明路由；门槛是"声明覆盖率 100% + 已声明路由判定一致"（见 P2b） |
| 路由扫描看不到全部路由 | 漏声明被误判为"已覆盖" | `app.module.ts:177` 按 APP_ROLES 条件装配，测试须用 ALL_ROLES；`main.ts:49-57` 的裸 Express 路由不在模块图里，需单独列出并纳入扫描白名单 |
| 仓库已有第二套能力（环境能力） | 两套 capability 并存 | `commerce-courses/course-capability.guard.ts:20-43` 已有 `course.authoring/course.publish` + `ENV_CAPABILITY_ENFORCEMENT`；已定分层（§3.7），工作项在 P1/P2a |
| 授权拒绝没有审计落点 | 无法复盘越权 | `main.ts:77` 的 accessLog 只记请求；P2 时一并加 `{employeeId, role, capability, method, path}` 的拒绝日志 |
| 客户端缓存旧 `menus` 字段 | 过渡期不一致 | P3 保留 `menus` 一个版本，下一版本删除 |
| `EmployeeRole` 类型在 client/server 各有一份 | 角色新增需改两处 | 本期不处理，记入后续“契约共享”事项 |
| 共享路由的"任一允许"语义被能力化后表达不清 | 授权放宽/收紧 | 用 `@RequireAny` 显式写；等价测试覆盖 knowledge/aiTutor 共享路由 |

---

## 9. 附录 A：现有角色矩阵（改造基线）

| 角色 | course | knowledge | aiTutor | order | reporting | student | helpDesk | settings |
|---|---|---|---|---|---|---|---|---|
| ADMIN | FULL | FULL | FULL | FULL | FULL | FULL | FULL | FULL |
| COURSE_CREATOR | VIEW | VIEW | VIEW | VIEW | VIEW | VIEW | VIEW | VIEW |
| GRAPHIC_DESIGNER | EDIT | VIEW | VIEW | VIEW | VIEW | VIEW | VIEW | VIEW |
| FINANCE | VIEW | VIEW | VIEW | FULL | FULL | VIEW | VIEW | VIEW |
| OPERATION_ADMIN | FULL | NONE | NONE | FULL | FULL | FULL | FULL | FULL |
| OPERATION_AI | VIEW | FULL | FULL | VIEW | VIEW | VIEW | VIEW | VIEW |

## 10. 附录 B：迁移工作表（从 route-access 提取）

| 现有规则 | 迁移为 |
|---|---|
| `first === 'students'` READ/WRITE | `student.view` / `student.access.change` / `student.email.change` / `student.status.change` |
| `first === 'helpdesk'` READ/WRITE | `helpDesk.ticket.view` / `helpDesk.ticket.reply` / `helpDesk.faq.publish` |
| `first === 'learning-access'` GET / 写 | `settings.view`（GET）/ `settings.learningAccess.publish`（写）；**不能合并成一条**，否则 settings=VIEW 的四个角色会丢掉 GET |
| `first === 'backoffice' && second === 'operations'` | `course.ops.update` / `course.view` |
| `backofficeCourseAction()` 四类 | `course.view` / `course.*.update` / `course.package.*` / `course.version.publish`；`plans`→`course.plan.update`、`trial`→`course.trial.update`、`sync-stripe`→`course.syncStripe.run`（三者都是 FULL，不是 EDIT） |
| `sharedWithAiTutor()` | 共享**读**路由用 `@RequireAny('knowledge.page.view','aiTutor.view')`；`POST courses/:id/set-live` 旧引擎判 PUBLISH，必须用 `@RequireAny('knowledge.release.publish','aiTutor.config.publish')`，否则会从 2 个角色放宽到 5 个 |
| `actionFor()` 的老式 `courses/pages/releases/sync/files/tags` | `knowledge.*` 对应能力 |
| `first === 'admin'` 与未登记兜底 | `employee.view` / `employee.role.assign` / `employee.status.change`（未声明改为拒绝） |
| `public / service / internal / helpdeskIntegration / signedIn` | 保留为独立装饰器 |

## 11. 附录 C：改造后会被删除的东西

- `server/src/backoffice/nest/route-access.ts`（208 行）及其 330 行测试
- `server/src/backoffice/modules/rbac/access.ts`（被能力判定取代）
- `client/src/backoffice/rbac/permissions.ts` 中的 `ROLE_MATRIX / levelFor / isActionAllowed / visibleMenus / visibleSettingsSubs / canAccessEmployeeAccount`
- `client/.../EmployeeAccountPage.tsx` 中对本地矩阵的依赖（改为服务端能力）
- `client/src/backoffice/rbac/permissions.ts` 的 `ActionKind`、`PermissionLevel` 与 `roleAccessRows`
- `client/tests/role-access.test.ts`（断言的是本地矩阵，随策略迁移改写）
- `CourseManagementPage.tsx:77` 的 `role === 'ADMIN' || role === 'OPERATION_ADMIN'`（改为 `course.version.publish` 能力），以及 P0 生成、import 旧引擎的等价测试
- 会话中的 `menus / settings / canManageEmployeeAccount`（P3 兼容一个版本后删除）

---

## 12. 待拍板（评审后新增，未定之前不进入 P2）

**Q1｜与既有环境能力的关系 —— 已定（2026-11-14）：分层，见 §3.7。**
仓库已有一套点号命名的环境能力（`course.authoring/import/publish/status`，`partc/contracts/environment.ts:32-37`），带环境矩阵、默认休眠。当时两个选项：
- (a) 合并：角色能力吸收它，环境矩阵退化为"环境开关"；
- (b) **分层（选定）**：环境层管"这个部署允不允许"，身份层管"这个人允不允许"。

选 (b) 的理由：两者是正交维度——"环境不允许"和"这个人不允许"会同时出现，合并后每改一次环境策略都要重算所有角色 bundle，且会把部署事实伪装成人员权限。分层后各自演进，拒绝码也分得开（`CAPABILITY_DISABLED` vs `NOT_AUTHORISED`）。
工作项：P1 加注册表互斥校验；P2a 加守卫串联与顺序。

**Q2｜100% 声明覆盖的责任边界**
默认拒绝上线前，谁保证 controller 图全覆盖？`service`（`/api/user/**`、`/api/portal/**`）、`internal`（`/api/ks/**`）、`helpdeskIntegration` 是否必须在第一批装饰器内？（建议：是，否则线上 403。）

**Q3｜删掉旧引擎后的回滚单位**
前端与 API 同镜像，`route-access.ts` 删除后不存在开关回退。回滚是"整包回退上一版本"还是保留一个版本的"双引擎开关"？（建议：整包回退，且 P2c 与切换同一次发布。）

**Q4｜扫描测试放在哪、怎么进 CI —— 已定：放 `server/src/backoffice/tests/`，复用现有 jest 与 CI 步骤，注入最小 env。**
约束：`AppModule` 在文件求值期就校验 env（缺 `DATABASE_URL` 直接抛错），`server/package.json` 的 jest roots 只含 `src/` 与 `eval/`；放 `server/test/` 则两个 job 都不会执行它。

**Q5｜删除旧引擎后，等价测试怎么办**
P0 的等价测试 import 旧引擎，P2c 删除后无法编译。是随 P2c 一起删除（等价性从此由扫描测试 + 能力断言保证），还是保留旧引擎的一个冻结副本仅用于测试？（建议一起删除，并把关键用例转成能力断言。）

---

## 13. 评审记录（2026-11-14）

### 已确认并已修正

| # | 结论 | 严重度 | 修正位置 |
|---|---|---|---|
| 1 | 作用域漏算：`backoffice/nest` 只有 86 个 handler，全仓 31 个 controller / 235 个 handler（其余 149 = 129 + 20，明细见 §4 P2a） | blocker | §4 P2a、§7 DoD |
| 2 | 能力表缺 `level` 元数据，`levelFor` 无法还原 6×8（FINANCE order/reporting FULL、ADMIN settings FULL、GRAPHIC_DESIGNER course EDIT 都投不出） | blocker | §3.1、§3.3 |
| 3 | `settings` 域只有一个 `learningAccess.switch`，4 个 `settings=VIEW` 的角色投不出 VIEW | major | §3.1 |
| 4 | 附录 B 迁移丢动作维度：learning-access GET、`plans/trial/sync-stripe`、`set-live`（会从 2 个角色放宽到 5 个） | major | 附录 B |
| 5 | 两套能力系统无阶段承接 | major | §12 Q1 |
| 6 | 扫描测试跑不进 CI（`AppModule` 求值期校验 env、jest roots 不含 test/） | major | §4 P2a、§12 Q4 |
| 7 | 客户端改动面：13 个文件 import 策略，provider 只覆盖 3 个菜单；`can(action)` 零调用点 | major | §3.5、§4 P3 |
| 8 | capabilities 未接入 `EmployeeContext`；P3 删矩阵与 P4 改 EmployeeAccountPage 顺序冲突 | major | §3.5、§4 P3 |
| 9 | 守卫顺序：`CapabilityGuard` 必须在 `BackofficeAccessGuard` 之后，否则 401→403 契约破裂 | major | §4 P2a |
| 10 | P2c 删旧引擎会让 P0 等价测试无法编译 | major | §4 P0/P2c、§12 Q5 |
| 11 | `CourseManagementPage.tsx:77` 的 `role === 'ADMIN' || 'OPERATION_ADMIN'` 未登记 | minor | §11 |
| 12 | 计数与行号错误（7 个 rbac spec、1+9 处守卫装配、helpdesk/students 行号） | minor | §6 |
| 13 | "静默放行"只对 Admin 成立（其余 5 个角色是 fail-closed） | minor | §1 |

### 被推翻 / 修正的原有判断

- 「两份策略已漂移，证据是 `operations → course` 只在客户端」→ **推翻**：服务端 `route-access.ts:186-191` 也有该映射，用途不同。真正的依据是"两份完整副本 + 客户端丢弃服务端结论"。
- 「保留 `can(action)` 形状可让 25 处调用点零改动」→ **推翻**：`access.can(action)` 零调用点，实际用的是 `canEdit/canCreate/canPublish`。
- 「MENU_SURFACE 覆盖不了员工账号页/运营位页」→ **部分推翻**：员工账号页有 `SETTINGS_SUB_SURFACE`，运营位入口由 `canPublish` 控制，属于能力可表达的范围。

### 第二轮评审（2026-11-14，10 agent：安全 / 本会话改动 / 运维 / 测试 / 文档）

**已修复（代码）**

| # | 结论 | 严重度 | 处理 |
|---|---|---|---|
| 14 | `LAST_ADMIN` 只数 `ACTIVE`，未激活的邀请管理员被当成"可用"，可先建一个 pending Admin 再自降级绕过 | blocker | 计数改为 `ADMIN + ACTIVE + VERIFIED`；用例补"未验证不算数" |
| 15 | 计数与更新是两次独立查询，两个 Admin 并发互降可归零 | major | 合并进一个事务：`pg_advisory_xact_lock` + `FOR UPDATE` + 事务内重算 |
| 16 | 新增中文文案含未翻译的英文 "Admin"，`i18n-guard` 测试变红（CI client job 会红） | blocker | 改为"管理员" |

**已修复（文档）**

| # | 结论 | 严重度 | 修正位置 |
|---|---|---|---|
| 17 | "认证→环境层→身份层"在 Nest 下做不到（全局守卫先于 controller 守卫）；且 pages/releases/files/sync/tags 根本不经过环境层 | major | §3.7 |
| 18 | 未定义 shadow/enforce 开关，§3.4"无条件 403"与 §4"P2c 前不改行为"冲突 | major | §3.4 |
| 19 | 未定义类级/方法级元数据语义（`auth.controller` 同类别混有 public 与受保护方法） | major | §3.4 |
| 20 | 未落定 service/internal/helpdeskIntegration 的凭据语义 | major | §3.7 |
| 21 | handler 分组数字不自洽（126+3+86≠235，漏 20 个） | major | §4 P2a 明细表 |
| 22 | §6 仍把"6×8 矩阵逐格相等"当等价标准，与 §3.2 冲突 | major | §6 |
| 23 | `employee.*` 不属任何 MenuKey，bundle 规则未定义；员工页缺"角色→能力"来源 | major | §3.3、§4 P3 |
| 24 | §8 仍称 Q1 未定；Q4 已决却仍列为待拍板；Portal 边界 `/api/user` 与 `/api/portal` 口径不一 | minor | §8、§12、§2 |

**保留未决**

- **Q5**：P0 等价测试 import 旧引擎，删除后如何保住门禁（建议删除代码、保留已入库的 JSON 快照作为比较源）。
- **可及性提示**：种子迁移总会创建 ACTIVE+VERIFIED 的受保护管理员，且触发器禁止改动它；因此在正常初始化的库里，"最后一个 Admin"分支不会触发，它只在没有种管理员的库（恢复的备份、裁剪环境）生效。若要覆盖日常风险，应另立一条"禁止管理员修改自己的角色/停用自己"的规则——待产品确认。

### 追加决定（2026-11-14）

「最后一个 Admin」在有种管理员的库里不可达（种子账号 ACTIVE+VERIFIED 且受触发器保护）。产品确认：**再加一条可达规则——管理员不能修改自己的角色，也不能停用自己**（改邮箱/密码不受影响）。

- 规则：`contracts/employee.ts` 的 `editsOwnAuthority`；错误码 `SELF_ACCOUNT_EDIT`（409）。
- 与服务端计数规则的关系：self-edit 先判（任何库都生效），`LAST_ADMIN` 作为兜底保留给没有种管理员的库。
- 验证：纯函数 4 例 + 真库两例（自降级被拒、他人降级放行）+ 浏览器截图。
