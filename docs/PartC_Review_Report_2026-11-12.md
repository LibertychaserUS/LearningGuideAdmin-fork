# Part C v1 实现评审报告（REQUEST_CHANGES）

- 日期：2026-11-12
- 范围：Admin `fix/course-category-single-source`（HEAD dd08e83）与 Portal `fix/course-category-single-source`（HEAD f2a0e43f）全部未提交变更
- 设计基准：`docs/Course_Category_Single_Source_Design.md` §14 C0–C10、`docs/Course_Package_Spec_v2.md`、`agents/review-agent.md`
- 结论：**REQUEST_CHANGES**

## 通过项（证据）

- Admin Part C 9 suites / 174 tests 通过；category e2e 47 tests 全过；server build 通过；单测 143 suites / 2323 tests 通过。
- Portal test:unit 1745 tests 通过；tsc/lint 通过。
- C10 休眠开关默认 off，行为不变（integr 落实）。

## 阻断项（12）

1. **Portal `next build` 失败**：`app/api/learning/events/route.ts:35` 导出 `createLearningEventsPostHandler` 命名函数；Next.js Route 只允许 HTTP method 与配置导出。修法：handler factory 移到 `services/learningEventsHttp.ts`，route 仅保留 `dynamic` 与 `POST`；同步测试导入并重跑 build。
2. **v2 课程包三份互不兼容 manifest 契约**：`commerce-courses/contracts/manifest.ts`（legacy v2，实际导入导出用）vs `partc/contracts/package-manifest.ts`（缺 provenance）vs `docs/Course_Package_Spec_v2.md`（顶层 courseKey/contentVersionNo/capabilities/provenance）。三者都声明 formatVersion=2。修法：指定 Part C package-manifest 为唯一 SSOT；commerce-courses 导入/导出/job 改用该契约；补 round-trip e2e。
3. **C10 provenance/sourceEnv/sourceLabel/快照审计字段缺失**：package-manifest 无 provenance/annotations；parse.ts 在契约外私建 schema；exporter 不写 provenance；PcContentVersion 无 sourceEnv/sourceLabel；快照无 provenance 区块。修法：纳入 P0 契约并由 exporter 写入；实体与快照补字段。
4. **Part C v1 未端到端接线**：parse/validate/deriveTiming/align/compilePlan/apply 无生产调用方；pc_* 表无写入方；无 Part C 管理端 API；Portal `learning_plan_entries` 无写入方（事件端点对任何 contentVersion 都 404）。修法：接入导入 job/API/Portal 投影，或明确缩小范围并修正文档表述。
5. **Rendition.anchorSource 与 DB CHECK 缺 asr/forced-alignment**：契约 enum 与 migration CHECK 仅 4 值；derive-timing 输出 asr/forced-alignment 依赖 `as unknown as` 强转。修法：契约 + Prisma + CHECK 补齐，删除强转，补 ASR rendition 冻结测试。
6. **Alignment 缺 C3/C10.4 审计字段**：无 sourceKind/sourceArtifact/modelVersion/params/ruleVersion；timingProvenance 只在内存。修法：契约 + Prisma + 迁移补字段，align 持久化，补审计查询测试。
7. **能力路由误分类**：`POST /courses/:id/import` 被判为 `course.authoring`；开启强制后生产无法导入，与 C10.7/C10.8 冲突。修法：`segments.includes('import')` 归 `course.import`（export 判定之后），补 `:id/import`、publish、restore、live-status e2e，复核 operations 路由。
8. **apply/publish 门信任外部审批与冻结内容**：只检查传入的 PlanRecord/Approval，不查 DB；后续 rejected 不能阻断旧 approved；pins 相同但 stage 树/entries 被替换的冻结内容可写入。修法：事务端口增加 findPlan/findLatestApproval；要求 DB 最新决定为 approved；冻结内容由同一 inputClosure 重算并校验 entries/stages。
9. **二级分类草稿导出丢父路径**：`snapshot.ts:279` 只写末级 name。修法：用 categoryPathForId 或 include 父链，补二级分类导出/导入 e2e。
10. **Admin CI e2e 门禁红（3 例）**：`test/ai.e2e-spec.ts` 的 history/Release 隔离/限流分桶与既有单测直接矛盾，pristine HEAD 可复现；本次未提交变更也改了 `server/src/ai/**`，须证明无关或修复/经 Owner 书面同意后精确隔离；不得静默弱化。
11. **Part C 契约冻结测试未接入门禁**：`server/test/partc-contracts.spec.ts`（1686 行 / 49 tests，含 P0 CI grep 断言）不在 jest rootDir/regex 内，CI 从未执行。修法：移入 src 或增加 jest project/script 并在 CI 显式运行；另加真实 grep 断言。
12. **订阅页仍用 Portal CMS 3 个旧分类**：页面传 `content.categories`（3 个写死 id），后端按 Admin 4 个 ACTIVE 分类判定 all_categories → 3/3 显示、Society 不可购、标签硬编码。修法：订阅页改用 Admin catalogue（4 个 ACTIVE，name+localized），统一 owned/remaining/计数与后端 activeCategoryKeys，补 4 分类页面测试。

## 说明

- 清理、契约、schema、API-ADMIN 四个阶段在本轮因上下文中的"行 先休眠吧"被误读为"停止实现"而拒做（该指示实际只针对 Sandbox 能力开关休眠）；相关缺口已并入上述阻断项。
- 修复完成后需重跑：Admin build/lint/unit/partc/contract spec/e2e；Portal build/typecheck/unit；C10 开关默认 off 的行为回归。
