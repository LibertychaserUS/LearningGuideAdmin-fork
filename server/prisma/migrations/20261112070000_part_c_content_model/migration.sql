-- Part C 内容模型（设计 SSOT：docs/Course_Category_Single_Source_Design.md §14 C3/C9；
-- 契约唯一来源：server/src/partc/contracts/）。
-- 阶段 2 SCHEMA：C3 的 15 实体（PlanEntry 不入表 —— entries[] 是 Plan canonical JSON
-- 的一部分，按 C6；实体映射见 prisma/schema.prisma 的 Part C 段落头注释）。
--
-- 本迁移在 Prisma 生成的 DDL 之上手工补充（Prisma DSL 表达不了，全部可溯源 §14）：
-- 1) CHECK：C3 闭合词表（stage.kind/status、evidence kind/scoring、block.kind、
--    rendition modality/carrierType/anchorSource、alignment role/status/provenance、
--    plan.status、learning event type、media asset kind、content spec type）与数值区间
--    （0≤startMs<endMs、video/audio 必须有 >0 的 durationMs、attempts≥1、threshold≥0 等）。
-- 2) NULLS 安全的唯一键：pc_stage(parentStageKey, orderKey) 用 NULLS NOT DISTINCT，
--    根节点（parentStageKey IS NULL）同样参与「同父 orderKey 唯一」（C9.3）。
-- 3) 触发器：pc_content_version 冻结后不可变；pc_learning_event append-only 且
--    completed 前必须有 started；pc_plan 工件正文不可变、仅 status 可迁移；
--    Alignment provenance≠human ⇒ 创建时只能 proposed。
--
-- 不在 DB 层实现（P0 契约 contracts/stage.ts / content-version.ts 明确由编译器/发布门
-- 做跨行校验；C5 P2 允许草稿 incomplete 入库）：STR-1 包含森林无环、kind 层级、
-- 交付叶判定、容器 exitEvidence 为空；STR-7 requires∪sequence 闭包无环；ALN-* 覆盖与
-- 纤维非空；PlanEntry 只引用 verified。Rendition.endMs ≤ durationMs 依赖资产行
-- （TIM-1/C7），由导入/编译器按 PcMediaAsset.durationMs 校验。
--
-- 红线核对：全表无 hash/checksum/digest 列；无任何人类时间输入列或估算时长列；
-- Plan 以 canonicalJson TEXT 原文保存、比较用字节相等，不用摘要。

-- CreateTable
CREATE TABLE "pc_course" (
    "courseKey" TEXT NOT NULL,
    "categoryPath" JSONB,
    "titleLocalized" JSONB NOT NULL,
    "publishTargets" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pc_course_pkey" PRIMARY KEY ("courseKey")
);

-- CreateTable
CREATE TABLE "pc_stage" (
    "stageKey" TEXT NOT NULL,
    "courseKey" TEXT NOT NULL,
    "parentStageKey" TEXT,
    "orderKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "objectiveKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exitEvidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exitRollup" JSONB NOT NULL,
    "durationBudget" INTEGER,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pc_stage_pkey" PRIMARY KEY ("stageKey")
);

-- CreateTable
CREATE TABLE "pc_prerequisite_edge" (
    "fromStageKey" TEXT NOT NULL,
    "toStageKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,

    CONSTRAINT "pc_prerequisite_edge_pkey" PRIMARY KEY ("fromStageKey","toStageKey","kind")
);

-- CreateTable
CREATE TABLE "pc_objective" (
    "objectiveKey" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pc_objective_pkey" PRIMARY KEY ("objectiveKey")
);

-- CreateTable
CREATE TABLE "pc_evidence_spec" (
    "evidenceKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "objectiveKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "measure" JSONB NOT NULL,
    "scoring" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "attempts" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pc_evidence_spec_pkey" PRIMARY KEY ("evidenceKey","version")
);

-- CreateTable
CREATE TABLE "pc_content_spec" (
    "contentKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "titleLocalized" JSONB NOT NULL,
    "objectiveHints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pc_content_spec_pkey" PRIMARY KEY ("contentKey","version")
);

-- CreateTable
CREATE TABLE "pc_block" (
    "contentKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "blockId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "pc_block_pkey" PRIMARY KEY ("contentKey","version","blockId")
);

-- CreateTable
CREATE TABLE "pc_rendition" (
    "renditionKey" TEXT NOT NULL,
    "contentKey" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "modality" TEXT NOT NULL,
    "occurrenceKey" TEXT NOT NULL,
    "carrierType" TEXT NOT NULL,
    "carrierKey" TEXT NOT NULL,
    "carrierVersion" INTEGER NOT NULL,
    "startMs" INTEGER,
    "endMs" INTEGER,
    "headingCode" TEXT,
    "offset" INTEGER,
    "anchorSource" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pc_rendition_pkey" PRIMARY KEY ("renditionKey")
);

-- CreateTable
CREATE TABLE "pc_media_asset" (
    "assetKey" TEXT NOT NULL,
    "assetVersion" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "language" TEXT,
    "durationMs" INTEGER,
    "uri" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pc_media_asset_pkey" PRIMARY KEY ("assetKey","assetVersion")
);

-- CreateTable
CREATE TABLE "pc_alignment" (
    "alignmentId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "renditionKey" TEXT NOT NULL,
    "objectiveKey" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "provenance" TEXT NOT NULL,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMPTZ(6),
    "verifiedAgainst" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pc_alignment_pkey" PRIMARY KEY ("alignmentId")
);

-- CreateTable
CREATE TABLE "pc_content_version" (
    "contentVersionId" TEXT NOT NULL,
    "courseKey" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "frozenAt" TIMESTAMPTZ(6) NOT NULL,
    "categoryPath" JSONB,
    "stages" JSONB NOT NULL,
    "prerequisiteEdges" JSONB NOT NULL,
    "specPins" JSONB NOT NULL,
    "renditions" JSONB NOT NULL,
    "alignments" JSONB NOT NULL,
    "evidenceSpecs" JSONB NOT NULL,
    "assetPins" JSONB NOT NULL,
    "planId" TEXT NOT NULL,
    "planVersion" INTEGER NOT NULL,

    CONSTRAINT "pc_content_version_pkey" PRIMARY KEY ("contentVersionId")
);

-- CreateTable
CREATE TABLE "pc_plan" (
    "planId" TEXT NOT NULL,
    "courseKey" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "planVersion" INTEGER NOT NULL,
    "inputClosure" JSONB NOT NULL,
    "canonicalJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "compilerVersion" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pc_plan_pkey" PRIMARY KEY ("planId")
);

-- CreateTable
CREATE TABLE "pc_plan_approval" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "planVersion" INTEGER NOT NULL,
    "decision" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMPTZ(6) NOT NULL,
    "acceptedWarnings" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "pc_plan_approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pc_learning_event" (
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contentVersionId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "sequence" INTEGER,

    CONSTRAINT "pc_learning_event_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "pc_evidence_attainment" (
    "id" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "evidenceKey" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "score" DOUBLE PRECISION,
    "rubricLevel" TEXT,
    "attained" BOOLEAN NOT NULL,
    "gradedBy" TEXT NOT NULL,
    "gradedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pc_evidence_attainment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pc_stage_courseKey_idx" ON "pc_stage"("courseKey");

-- CreateIndex
CREATE UNIQUE INDEX "pc_stage_parentStageKey_orderKey_key" ON "pc_stage"("parentStageKey", "orderKey") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "pc_prerequisite_edge_toStageKey_idx" ON "pc_prerequisite_edge"("toStageKey");

-- CreateIndex
CREATE INDEX "pc_block_contentKey_blockId_idx" ON "pc_block"("contentKey", "blockId");

-- CreateIndex
CREATE UNIQUE INDEX "pc_block_contentKey_version_sortOrder_key" ON "pc_block"("contentKey", "version", "sortOrder");

-- CreateIndex
CREATE INDEX "pc_rendition_carrierType_carrierKey_carrierVersion_idx" ON "pc_rendition"("carrierType", "carrierKey", "carrierVersion");

-- CreateIndex
CREATE UNIQUE INDEX "pc_rendition_business_key_key" ON "pc_rendition"("contentKey", "blockId", "language", "modality", "carrierType", "carrierKey", "carrierVersion", "occurrenceKey");

-- CreateIndex
CREATE INDEX "pc_alignment_renditionKey_idx" ON "pc_alignment"("renditionKey");

-- CreateIndex
CREATE INDEX "pc_alignment_objectiveKey_idx" ON "pc_alignment"("objectiveKey");

-- CreateIndex
CREATE UNIQUE INDEX "pc_alignment_stageKey_renditionKey_key" ON "pc_alignment"("stageKey", "renditionKey");

-- CreateIndex
CREATE UNIQUE INDEX "pc_content_version_courseKey_versionNo_key" ON "pc_content_version"("courseKey", "versionNo");

-- CreateIndex
CREATE UNIQUE INDEX "pc_plan_courseKey_contentVersionId_targetId_planVersion_key" ON "pc_plan"("courseKey", "contentVersionId", "targetId", "planVersion");

-- CreateIndex
CREATE UNIQUE INDEX "pc_plan_planId_planVersion_key" ON "pc_plan"("planId", "planVersion");

-- CreateIndex
CREATE INDEX "pc_plan_approval_planId_planVersion_idx" ON "pc_plan_approval"("planId", "planVersion");

-- CreateIndex
CREATE INDEX "pc_learning_event_userId_contentVersionId_stageKey_idx" ON "pc_learning_event"("userId", "contentVersionId", "stageKey");

-- CreateIndex
CREATE INDEX "pc_learning_event_sessionId_sequence_idx" ON "pc_learning_event"("sessionId", "sequence");

-- CreateIndex
CREATE INDEX "pc_learning_event_started_lookup_idx" ON "pc_learning_event"("userId", "sessionId", "contentVersionId", "stageKey");

-- CreateIndex
CREATE UNIQUE INDEX "pc_evidence_attainment_ledger_key" ON "pc_evidence_attainment"("contentVersionId", "stageKey", "evidenceKey", "attemptNo");

-- AddForeignKey
ALTER TABLE "pc_stage" ADD CONSTRAINT "pc_stage_courseKey_fkey" FOREIGN KEY ("courseKey") REFERENCES "pc_course"("courseKey") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pc_stage" ADD CONSTRAINT "pc_stage_parentStageKey_fkey" FOREIGN KEY ("parentStageKey") REFERENCES "pc_stage"("stageKey") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pc_prerequisite_edge" ADD CONSTRAINT "pc_prerequisite_edge_fromStageKey_fkey" FOREIGN KEY ("fromStageKey") REFERENCES "pc_stage"("stageKey") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pc_prerequisite_edge" ADD CONSTRAINT "pc_prerequisite_edge_toStageKey_fkey" FOREIGN KEY ("toStageKey") REFERENCES "pc_stage"("stageKey") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pc_block" ADD CONSTRAINT "pc_block_contentKey_version_fkey" FOREIGN KEY ("contentKey", "version") REFERENCES "pc_content_spec"("contentKey", "version") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pc_alignment" ADD CONSTRAINT "pc_alignment_stageKey_fkey" FOREIGN KEY ("stageKey") REFERENCES "pc_stage"("stageKey") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pc_alignment" ADD CONSTRAINT "pc_alignment_renditionKey_fkey" FOREIGN KEY ("renditionKey") REFERENCES "pc_rendition"("renditionKey") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pc_alignment" ADD CONSTRAINT "pc_alignment_objectiveKey_fkey" FOREIGN KEY ("objectiveKey") REFERENCES "pc_objective"("objectiveKey") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pc_content_version" ADD CONSTRAINT "pc_content_version_courseKey_fkey" FOREIGN KEY ("courseKey") REFERENCES "pc_course"("courseKey") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pc_content_version" ADD CONSTRAINT "pc_content_version_planId_planVersion_fkey" FOREIGN KEY ("planId", "planVersion") REFERENCES "pc_plan"("planId", "planVersion") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pc_plan" ADD CONSTRAINT "pc_plan_courseKey_fkey" FOREIGN KEY ("courseKey") REFERENCES "pc_course"("courseKey") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pc_plan_approval" ADD CONSTRAINT "pc_plan_approval_planId_planVersion_fkey" FOREIGN KEY ("planId", "planVersion") REFERENCES "pc_plan"("planId", "planVersion") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pc_learning_event" ADD CONSTRAINT "pc_learning_event_contentVersionId_fkey" FOREIGN KEY ("contentVersionId") REFERENCES "pc_content_version"("contentVersionId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pc_evidence_attainment" ADD CONSTRAINT "pc_evidence_attainment_contentVersionId_fkey" FOREIGN KEY ("contentVersionId") REFERENCES "pc_content_version"("contentVersionId") ON DELETE RESTRICT ON UPDATE NO ACTION;


-- ============================================================
-- C3 CHECK 约束（闭合词表与区间）
-- ============================================================

-- Course（C3：publishTargets 空=不可发布；分类只带稳定键路径）
ALTER TABLE "pc_course" ADD CONSTRAINT "pc_course_publish_targets_chk"
  CHECK (jsonb_typeof("publishTargets") = 'array');
ALTER TABLE "pc_course" ADD CONSTRAINT "pc_course_title_localized_chk"
  CHECK (jsonb_typeof("titleLocalized") = 'object');
ALTER TABLE "pc_course" ADD CONSTRAINT "pc_course_category_path_chk"
  CHECK ("categoryPath" IS NULL OR jsonb_typeof("categoryPath") = 'array');

-- Stage（C3：kind 闭集 / status 闭集 / orderKey 零填充数值路径 / exitRollup 判别联合）
-- 注：无环、kind 层级、容器 exitEvidence 为空属跨行不变量，按 P0 契约由编译器/发布门校验。
ALTER TABLE "pc_stage" ADD CONSTRAINT "pc_stage_kind_chk"
  CHECK ("kind" IN ('program', 'phase', 'stage', 'step'));
ALTER TABLE "pc_stage" ADD CONSTRAINT "pc_stage_status_chk"
  CHECK ("status" IN ('active', 'retired'));
ALTER TABLE "pc_stage" ADD CONSTRAINT "pc_stage_order_key_chk"
  CHECK ("orderKey" ~ '^[0-9]{6}(\.[0-9]{6})*$');
ALTER TABLE "pc_stage" ADD CONSTRAINT "pc_stage_duration_budget_chk"
  CHECK ("durationBudget" IS NULL OR "durationBudget" >= 0);
ALTER TABLE "pc_stage" ADD CONSTRAINT "pc_stage_exit_rollup_chk"
  CHECK (
    jsonb_typeof("exitRollup") = 'object'
    AND "exitRollup" ->> 'kind' IN ('all', 'anyOf', 'atLeast')
    AND (
      "exitRollup" ->> 'kind' <> 'atLeast'
      OR COALESCE("exitRollup" ->> 'n' ~ '^[1-9][0-9]*$', false)
    )
  );
ALTER TABLE "pc_stage" ADD CONSTRAINT "pc_stage_not_self_parent_chk"
  CHECK ("parentStageKey" IS NULL OR "parentStageKey" <> "stageKey");

-- PrerequisiteEdge（C3/STR-7：kind 闭集；禁自指）
ALTER TABLE "pc_prerequisite_edge" ADD CONSTRAINT "pc_prerequisite_edge_kind_chk"
  CHECK ("kind" IN ('requires', 'recommends'));
ALTER TABLE "pc_prerequisite_edge" ADD CONSTRAINT "pc_prerequisite_edge_not_self_chk"
  CHECK ("fromStageKey" <> "toStageKey");

-- Objective（C3：退役不复用，status 闭集）
ALTER TABLE "pc_objective" ADD CONSTRAINT "pc_objective_status_chk"
  CHECK ("status" IN ('active', 'retired'));

-- EvidenceSpec（C3/C8：三型闭集；completion/出勤/自报/观看完成率不在词表；measure 与 kind 同型）
ALTER TABLE "pc_evidence_spec" ADD CONSTRAINT "pc_evidence_spec_kind_chk"
  CHECK ("kind" IN ('assessment', 'artifact', 'performance'));
ALTER TABLE "pc_evidence_spec" ADD CONSTRAINT "pc_evidence_spec_scoring_chk"
  CHECK ("scoring" IN ('points', 'rubric', 'pass-fail'));
ALTER TABLE "pc_evidence_spec" ADD CONSTRAINT "pc_evidence_spec_threshold_chk"
  CHECK ("threshold" >= 0);
ALTER TABLE "pc_evidence_spec" ADD CONSTRAINT "pc_evidence_spec_attempts_chk"
  CHECK ("attempts" >= 1);
ALTER TABLE "pc_evidence_spec" ADD CONSTRAINT "pc_evidence_spec_measure_kind_chk"
  CHECK (jsonb_typeof("measure") = 'object' AND "measure" ->> 'kind' = "kind");
ALTER TABLE "pc_evidence_spec" ADD CONSTRAINT "pc_evidence_spec_version_chk"
  CHECK ("version" >= 1);
ALTER TABLE "pc_evidence_spec" ADD CONSTRAINT "pc_evidence_spec_objectives_chk"
  CHECK (cardinality("objectiveKeys") >= 1);

-- ContentSpec（C3：6 类闭集；不含 stageKey/排序 DSL/权威锚点/时长 —— 列集本身即证明）
ALTER TABLE "pc_content_spec" ADD CONSTRAINT "pc_content_spec_type_chk"
  CHECK ("type" IN ('video', 'text', 'exhibit', 'reading', 'knowledge-test', 'application-test'));
ALTER TABLE "pc_content_spec" ADD CONSTRAINT "pc_content_spec_version_chk"
  CHECK ("version" >= 1);
ALTER TABLE "pc_content_spec" ADD CONSTRAINT "pc_content_spec_title_localized_chk"
  CHECK (jsonb_typeof("titleLocalized") = 'object');

-- Block（C3：7 类闭集；blockId 是机器可引用最小单位；payload 与 kind 同型）
ALTER TABLE "pc_block" ADD CONSTRAINT "pc_block_kind_chk"
  CHECK ("kind" IN ('text', 'video', 'audio', 'image', 'model3d', 'question', 'code'));
ALTER TABLE "pc_block" ADD CONSTRAINT "pc_block_payload_kind_chk"
  CHECK (jsonb_typeof("payload") = 'object' AND "payload" ->> 'kind' = "kind");
ALTER TABLE "pc_block" ADD CONSTRAINT "pc_block_sort_order_chk"
  CHECK ("sortOrder" >= 0);
ALTER TABLE "pc_block" ADD CONSTRAINT "pc_block_version_chk"
  CHECK ("version" >= 1);

-- Rendition（C3/ALN-3：坐标单源 + 半开区间 0≤startMs<endMs；业务键全 NOT NULL 已由 DDL 保证）
ALTER TABLE "pc_rendition" ADD CONSTRAINT "pc_rendition_modality_chk"
  CHECK ("modality" IN ('text', 'video', 'audio', 'image', 'model3d'));
ALTER TABLE "pc_rendition" ADD CONSTRAINT "pc_rendition_carrier_type_chk"
  CHECK ("carrierType" IN ('asset', 'document'));
ALTER TABLE "pc_rendition" ADD CONSTRAINT "pc_rendition_anchor_source_chk"
  CHECK ("anchorSource" IN ('subtitle', 'chapter', 'doc-structure', 'import-legacy'));
ALTER TABLE "pc_rendition" ADD CONSTRAINT "pc_rendition_start_end_pair_chk"
  CHECK (("startMs" IS NULL) = ("endMs" IS NULL));
ALTER TABLE "pc_rendition" ADD CONSTRAINT "pc_rendition_interval_chk"
  CHECK ("startMs" IS NULL OR ("startMs" >= 0 AND "startMs" < "endMs"));
ALTER TABLE "pc_rendition" ADD CONSTRAINT "pc_rendition_coordinate_single_source_chk"
  CHECK (
    ("carrierType" = 'asset' AND "headingCode" IS NULL AND "offset" IS NULL)
    OR ("carrierType" = 'document' AND "startMs" IS NULL AND "endMs" IS NULL)
  );
ALTER TABLE "pc_rendition" ADD CONSTRAINT "pc_rendition_anchor_carrier_chk"
  CHECK ("anchorSource" NOT IN ('subtitle', 'chapter') OR "carrierType" = 'asset');
ALTER TABLE "pc_rendition" ADD CONSTRAINT "pc_rendition_doc_anchor_carrier_chk"
  CHECK ("anchorSource" <> 'doc-structure' OR "carrierType" = 'document');
ALTER TABLE "pc_rendition" ADD CONSTRAINT "pc_rendition_offset_chk"
  CHECK ("offset" IS NULL OR "offset" >= 0);
ALTER TABLE "pc_rendition" ADD CONSTRAINT "pc_rendition_carrier_version_chk"
  CHECK ("carrierVersion" >= 1);
ALTER TABLE "pc_rendition" ADD CONSTRAINT "pc_rendition_revision_chk"
  CHECK ("revision" >= 1);

-- MediaAsset（C3/C7：身份=assetKey+assetVersion；durationMs 只是容器探测属性，无哈希列）
ALTER TABLE "pc_media_asset" ADD CONSTRAINT "pc_media_asset_kind_chk"
  CHECK ("kind" IN ('cover', 'video', 'audio', 'image', 'model3d', 'thumbnail', 'lesson-text', 'subtitle', 'chapters'));
ALTER TABLE "pc_media_asset" ADD CONSTRAINT "pc_media_asset_duration_chk"
  CHECK (
    ("kind" IN ('video', 'audio') AND "durationMs" IS NOT NULL AND "durationMs" > 0)
    OR ("kind" NOT IN ('video', 'audio') AND "durationMs" IS NULL)
  );
ALTER TABLE "pc_media_asset" ADD CONSTRAINT "pc_media_asset_version_chk"
  CHECK ("assetVersion" >= 1);

-- Alignment（C3：存储状态只有 proposed/verified/rejected；stale 读时派生；
-- verified 必须有人签收，非 verified 不得携带审计元组）
ALTER TABLE "pc_alignment" ADD CONSTRAINT "pc_alignment_role_chk"
  CHECK ("role" IN ('primary', 'support', 'assessment', 'auxiliary'));
ALTER TABLE "pc_alignment" ADD CONSTRAINT "pc_alignment_status_chk"
  CHECK ("status" IN ('proposed', 'verified', 'rejected'));
ALTER TABLE "pc_alignment" ADD CONSTRAINT "pc_alignment_provenance_chk"
  CHECK ("provenance" IN ('human', 'import', 'legacy', 'semantic'));
ALTER TABLE "pc_alignment" ADD CONSTRAINT "pc_alignment_verified_audit_chk"
  CHECK (
    ("status" = 'verified'
      AND "verifiedBy" IS NOT NULL
      AND "verifiedAt" IS NOT NULL
      AND "verifiedAgainst" IS NOT NULL)
    OR ("status" <> 'verified'
      AND "verifiedBy" IS NULL
      AND "verifiedAt" IS NULL
      AND "verifiedAgainst" IS NULL)
  );
ALTER TABLE "pc_alignment" ADD CONSTRAINT "pc_alignment_verified_against_chk"
  CHECK ("verifiedAgainst" IS NULL OR jsonb_typeof("verifiedAgainst") = 'object');

-- ContentVersion（C3：冻结快照；只含稳定键；发布后不可变由下方触发器兜底）
ALTER TABLE "pc_content_version" ADD CONSTRAINT "pc_content_version_version_no_chk"
  CHECK ("versionNo" >= 1);
ALTER TABLE "pc_content_version" ADD CONSTRAINT "pc_content_version_plan_version_chk"
  CHECK ("planVersion" >= 1);
ALTER TABLE "pc_content_version" ADD CONSTRAINT "pc_content_version_snapshot_shapes_chk"
  CHECK (
    jsonb_typeof("stages") = 'array'
    AND jsonb_typeof("prerequisiteEdges") = 'array'
    AND jsonb_typeof("specPins") = 'array'
    AND jsonb_typeof("renditions") = 'array'
    AND jsonb_typeof("alignments") = 'array'
    AND jsonb_typeof("evidenceSpecs") = 'array'
    AND jsonb_typeof("assetPins") = 'array'
  );
ALTER TABLE "pc_content_version" ADD CONSTRAINT "pc_content_version_category_path_chk"
  CHECK ("categoryPath" IS NULL OR jsonb_typeof("categoryPath") = 'array');

-- Plan（C3/C6：status 外置闭集；planId 显式派生格式；canonicalJson 不含 status/时间戳）
ALTER TABLE "pc_plan" ADD CONSTRAINT "pc_plan_status_chk"
  CHECK ("status" IN ('draft', 'approved', 'degraded', 'blocked', 'superseded'));
ALTER TABLE "pc_plan" ADD CONSTRAINT "pc_plan_version_chk"
  CHECK ("planVersion" >= 1);
ALTER TABLE "pc_plan" ADD CONSTRAINT "pc_plan_id_chk"
  CHECK ("planId" ~ '^plan/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/v[1-9][0-9]*$');
ALTER TABLE "pc_plan" ADD CONSTRAINT "pc_plan_input_closure_chk"
  CHECK (jsonb_typeof("inputClosure") = 'object');

-- PlanApproval（C3：绑定 (planId,planVersion)；rejected 不接受任何 warning）
ALTER TABLE "pc_plan_approval" ADD CONSTRAINT "pc_plan_approval_decision_chk"
  CHECK ("decision" IN ('approved', 'rejected'));
ALTER TABLE "pc_plan_approval" ADD CONSTRAINT "pc_plan_approval_version_chk"
  CHECK ("planVersion" >= 1);
ALTER TABLE "pc_plan_approval" ADD CONSTRAINT "pc_plan_approval_warnings_chk"
  CHECK (
    jsonb_typeof("acceptedWarnings") = 'array'
    AND ("decision" = 'approved' OR jsonb_array_length("acceptedWarnings") = 0)
  );

-- LearningEvent（C3/C8：type 闭集；append-only 与 completed 前置由触发器兜底）
ALTER TABLE "pc_learning_event" ADD CONSTRAINT "pc_learning_event_type_chk"
  CHECK ("type" IN ('started', 'paused', 'resumed', 'completed', 'abandoned'));
ALTER TABLE "pc_learning_event" ADD CONSTRAINT "pc_learning_event_sequence_chk"
  CHECK ("sequence" IS NULL OR "sequence" >= 0);

-- EvidenceAttainment（C3：唯一账本；score/rubricLevel 至少给一个）
ALTER TABLE "pc_evidence_attainment" ADD CONSTRAINT "pc_evidence_attainment_attempt_chk"
  CHECK ("attemptNo" >= 1);
ALTER TABLE "pc_evidence_attainment" ADD CONSTRAINT "pc_evidence_attainment_score_chk"
  CHECK ("score" IS NULL OR "score" >= 0);
ALTER TABLE "pc_evidence_attainment" ADD CONSTRAINT "pc_evidence_attainment_measure_chk"
  CHECK ("score" IS NOT NULL OR "rubricLevel" IS NOT NULL);

-- ============================================================
-- 触发器（跨行/跨状态规则，P0 契约要求写入路径兜底）
-- ============================================================

-- ContentVersion 冻结后不可变（C1：发布后不可变；历史靠新版本+追加写发布记录）
CREATE OR REPLACE FUNCTION "pc_content_version_immutable"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'pc_content_version is immutable after freeze (% rejected)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pc_content_version_no_update_delete"
  BEFORE UPDATE OR DELETE ON "pc_content_version"
  FOR EACH ROW EXECUTE FUNCTION "pc_content_version_immutable"();

CREATE TRIGGER "pc_content_version_no_truncate"
  BEFORE TRUNCATE ON "pc_content_version"
  FOR EACH STATEMENT EXECUTE FUNCTION "pc_content_version_immutable"();

-- LearningEvent append-only（C3/C8）
CREATE OR REPLACE FUNCTION "pc_learning_event_append_only"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'pc_learning_event is append-only (% rejected)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pc_learning_event_no_update_delete"
  BEFORE UPDATE OR DELETE ON "pc_learning_event"
  FOR EACH ROW EXECUTE FUNCTION "pc_learning_event_append_only"();

CREATE TRIGGER "pc_learning_event_no_truncate"
  BEFORE TRUNCATE ON "pc_learning_event"
  FOR EACH STATEMENT EXECUTE FUNCTION "pc_learning_event_append_only"();

-- completed 前必须有 started（C3「completed 前必须有 started」/ P7「completed 无 started 拒绝」）
-- 作用域：同一 (userId, sessionId, contentVersionId, stageKey)。
CREATE OR REPLACE FUNCTION "pc_learning_event_completed_requires_started"()
RETURNS trigger AS $$
BEGIN
  IF NEW."type" = 'completed' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "pc_learning_event"
      WHERE "userId" = NEW."userId"
        AND "sessionId" = NEW."sessionId"
        AND "contentVersionId" = NEW."contentVersionId"
        AND "stageKey" = NEW."stageKey"
        AND "type" = 'started'
    ) THEN
      RAISE EXCEPTION 'completed event % has no started event in the same session/stage', NEW."eventId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pc_learning_event_completed_guard"
  BEFORE INSERT ON "pc_learning_event"
  FOR EACH ROW EXECUTE FUNCTION "pc_learning_event_completed_requires_started"();

-- Plan 工件正文不可变；status 外置可迁移（C1/C6：canonical bytes 不因状态改变）
CREATE OR REPLACE FUNCTION "pc_plan_body_immutable"()
RETURNS trigger AS $$
BEGIN
  IF NEW."planId" IS DISTINCT FROM OLD."planId"
     OR NEW."courseKey" IS DISTINCT FROM OLD."courseKey"
     OR NEW."contentVersionId" IS DISTINCT FROM OLD."contentVersionId"
     OR NEW."targetId" IS DISTINCT FROM OLD."targetId"
     OR NEW."planVersion" IS DISTINCT FROM OLD."planVersion"
     OR NEW."inputClosure" IS DISTINCT FROM OLD."inputClosure"
     OR NEW."canonicalJson" IS DISTINCT FROM OLD."canonicalJson"
     OR NEW."compilerVersion" IS DISTINCT FROM OLD."compilerVersion"
     OR NEW."ruleVersion" IS DISTINCT FROM OLD."ruleVersion"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'pc_plan artifact body is immutable; only status may change (planId=%)', OLD."planId"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pc_plan_body_guard"
  BEFORE UPDATE ON "pc_plan"
  FOR EACH ROW EXECUTE FUNCTION "pc_plan_body_immutable"();

-- Alignment provenance≠human ⇒ 创建时只能是 proposed（C3 注记；人工后续签收可转 verified）
CREATE OR REPLACE FUNCTION "pc_alignment_creation_status"()
RETURNS trigger AS $$
BEGIN
  IF NEW."provenance" <> 'human' AND NEW."status" <> 'proposed' THEN
    RAISE EXCEPTION 'alignment % created by % must start as proposed', NEW."alignmentId", NEW."provenance"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pc_alignment_creation_guard"
  BEFORE INSERT ON "pc_alignment"
  FOR EACH ROW EXECUTE FUNCTION "pc_alignment_creation_status"();
