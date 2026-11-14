-- Part C schema 缺口补齐（阶段 2 FIX2-SCHEMA；设计 §14 C3/C6/C10、评审阻断 6）
--
-- 1) PcAlignment.confidence：派生置信度 0..1（nullable）；ASR / 强制对齐的
--    派生对齐必须有值（其余来源可空）。审计数据，不参与身份/幂等/staleness。
-- 2) PcContentSpec / PcObjective 归属列 courseKey：键按课程作用域
--    （内容规格：(courseKey, contentKey, version)；目标：(courseKey, objectiveKey)）。
--    历史行按唯一归属回填；歧义或无归属保持 NULL（NULLS DISTINCT，合法）。
-- 3) PcCourse 单调计数器 structureRevision / alignmentSetVersion（C6
--    inputClosure）。迁移按当前确定性计数回填，保证不低估当前修订；此后由
--    写入路径 +1。
-- 4) PcPublication 发布记录表（追加写；validFrom/validTo = valid time，
--    createdAt = transaction time）。live 指针由最高有效发布派生（不存指针列）。
--    迁移为每门已有内容版本的课程回填”最高 versionNo 即当前 live”的记录，
--    保持迁移前后行为一致。
--
-- 无任何哈希/摘要列（C0 红线⑦）。本迁移只加列/加表/回填，不改写内容数据。

-- 1) Alignment 派生置信度 -----------------------------------------------------
ALTER TABLE "pc_alignment" ADD COLUMN "confidence" DOUBLE PRECISION;

ALTER TABLE "pc_alignment" ADD CONSTRAINT "pc_alignment_confidence_range_chk"
  CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));

ALTER TABLE "pc_alignment" ADD CONSTRAINT "pc_alignment_confidence_source_chk"
  CHECK (
    "sourceKind" IS NULL
    OR "sourceKind" NOT IN ('asr', 'forced-alignment')
    OR "confidence" IS NOT NULL
  );

-- 2) ContentSpec / Objective 课程归属 -----------------------------------------
ALTER TABLE "pc_objective" ADD COLUMN "courseKey" TEXT;
ALTER TABLE "pc_content_spec" ADD COLUMN "courseKey" TEXT;

-- Objective 归属：经 alignment→stage 得到唯一课程；多课程共用的 key 保持 NULL。
UPDATE "pc_objective" o
SET "courseKey" = scope."courseKey"
FROM (
  SELECT a."objectiveKey" AS objective_key, MIN(s."courseKey") AS "courseKey"
  FROM "pc_alignment" a
  JOIN "pc_stage" s ON s."stageKey" = a."stageKey"
  GROUP BY a."objectiveKey"
  HAVING COUNT(DISTINCT s."courseKey") = 1
) scope
WHERE o."objectiveKey" = scope.objective_key;

-- ContentSpec 归属：经 rendition→alignment→stage 得到唯一课程。
UPDATE "pc_content_spec" cs
SET "courseKey" = scope."courseKey"
FROM (
  SELECT r."contentKey" AS content_key, MIN(s."courseKey") AS "courseKey"
  FROM "pc_rendition" r
  JOIN "pc_alignment" a ON a."renditionKey" = r."renditionKey"
  JOIN "pc_stage" s ON s."stageKey" = a."stageKey"
  GROUP BY r."contentKey"
  HAVING COUNT(DISTINCT s."courseKey") = 1
) scope
WHERE cs."contentKey" = scope.content_key;

CREATE UNIQUE INDEX "pc_objective_courseKey_objectiveKey_key"
  ON "pc_objective"("courseKey", "objectiveKey");
CREATE INDEX "pc_objective_courseKey_idx" ON "pc_objective"("courseKey");

CREATE UNIQUE INDEX "pc_content_spec_courseKey_contentKey_version_key"
  ON "pc_content_spec"("courseKey", "contentKey", "version");
CREATE INDEX "pc_content_spec_courseKey_idx" ON "pc_content_spec"("courseKey");

-- 3) 课程级单调计数器 ---------------------------------------------------------
ALTER TABLE "pc_course"
  ADD COLUMN "structureRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "alignmentSetVersion" INTEGER NOT NULL DEFAULT 0;

UPDATE "pc_course" c
SET
  "structureRevision" = (
    SELECT COUNT(*) FROM "pc_stage" s WHERE s."courseKey" = c."courseKey"
  ) + (
    SELECT COUNT(*)
    FROM "pc_prerequisite_edge" e
    JOIN "pc_stage" s ON s."stageKey" = e."fromStageKey"
    WHERE s."courseKey" = c."courseKey"
  ),
  "alignmentSetVersion" = (
    SELECT COUNT(*)
    FROM "pc_alignment" a
    JOIN "pc_stage" s ON s."stageKey" = a."stageKey"
    WHERE s."courseKey" = c."courseKey"
  );

-- 4) 发布记录 ----------------------------------------------------------------
CREATE TABLE "pc_publication" (
  "id" TEXT NOT NULL,
  "courseKey" TEXT NOT NULL,
  "contentVersionId" TEXT NOT NULL,
  "versionNo" INTEGER NOT NULL,
  "validFrom" TIMESTAMP(6) WITH TIME ZONE NOT NULL,
  "validTo" TIMESTAMP(6) WITH TIME ZONE,
  "actor" TEXT NOT NULL,
  "summary" TEXT,
  "createdAt" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pc_publication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pc_publication_courseKey_versionNo_key"
  ON "pc_publication"("courseKey", "versionNo");
CREATE INDEX "pc_publication_courseKey_validFrom_idx"
  ON "pc_publication"("courseKey", "validFrom");

ALTER TABLE "pc_publication" ADD CONSTRAINT "pc_publication_courseKey_fkey"
  FOREIGN KEY ("courseKey") REFERENCES "pc_course"("courseKey")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "pc_publication" ADD CONSTRAINT "pc_publication_contentVersionId_fkey"
  FOREIGN KEY ("contentVersionId") REFERENCES "pc_content_version"("contentVersionId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "pc_publication" ADD CONSTRAINT "pc_publication_valid_interval_chk"
  CHECK ("validTo" IS NULL OR "validTo" > "validFrom");

-- 回填：迁移前 live = 该课程最高 versionNo（仓库旧实现）。为每门有内容版本的
-- 课程追加一条 open 发布记录，保持迁移后的派生结果与迁移前一致。
INSERT INTO "pc_publication" (
  "id", "courseKey", "contentVersionId", "versionNo",
  "validFrom", "validTo", "actor", "summary", "createdAt"
)
SELECT
  gen_random_uuid()::text,
  cv."courseKey",
  cv."contentVersionId",
  cv."versionNo",
  cv."frozenAt",
  NULL,
  'migration',
  'backfilled live pointer: highest content version',
  CURRENT_TIMESTAMP
FROM "pc_content_version" cv
JOIN (
  SELECT "courseKey", MAX("versionNo") AS max_version_no
  FROM "pc_content_version"
  GROUP BY "courseKey"
) latest
  ON latest."courseKey" = cv."courseKey"
 AND latest.max_version_no = cv."versionNo"
ON CONFLICT ("courseKey", "versionNo") DO NOTHING;
