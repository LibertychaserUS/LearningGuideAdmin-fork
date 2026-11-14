-- Part C 契约补齐（评审阻断 3/5/6；设计 §14 C3/C7/C10.3/C10.4）
--
-- 1) PcRendition.anchorSource 词表补齐 asr / forced-alignment（C7 视频时间源），
--    并同步「视频时间锚点必须落在 asset 载体」的 CHECK。
-- 2) PcAlignment 增加派生审计元组 sourceKind/sourceArtifact/modelVersion/params/
--    ruleVersion（C7/C10.4；审计数据不参与身份、幂等与 staleness）。
-- 3) PcContentVersion 增加环境局部来源标签 sourceEnv/sourceLabel（C10.3）。
--
-- 本迁移只加列/替换 CHECK，不改写既有行；历史行在对应列上保持 NULL 且合法。

-- 1) Rendition anchorSource 闭集与载体约束
ALTER TABLE "pc_rendition" DROP CONSTRAINT "pc_rendition_anchor_source_chk";
ALTER TABLE "pc_rendition" ADD CONSTRAINT "pc_rendition_anchor_source_chk"
  CHECK ("anchorSource" IN ('subtitle', 'chapter', 'asr', 'forced-alignment', 'doc-structure', 'import-legacy'));

ALTER TABLE "pc_rendition" DROP CONSTRAINT "pc_rendition_anchor_carrier_chk";
ALTER TABLE "pc_rendition" ADD CONSTRAINT "pc_rendition_anchor_carrier_chk"
  CHECK ("anchorSource" NOT IN ('subtitle', 'chapter', 'asr', 'forced-alignment') OR "carrierType" = 'asset');

-- 2) Alignment 派生审计元组（全有或全无；ASR/强制对齐必须 pin 模型与参数）
ALTER TABLE "pc_alignment"
  ADD COLUMN "sourceKind" TEXT,
  ADD COLUMN "sourceArtifact" TEXT,
  ADD COLUMN "modelVersion" TEXT,
  ADD COLUMN "params" JSONB,
  ADD COLUMN "ruleVersion" TEXT;

ALTER TABLE "pc_alignment" ADD CONSTRAINT "pc_alignment_source_kind_chk"
  CHECK ("sourceKind" IS NULL OR "sourceKind" IN ('subtitle', 'chapter', 'asr', 'forced-alignment', 'doc-structure'));

ALTER TABLE "pc_alignment" ADD CONSTRAINT "pc_alignment_source_audit_tuple_chk"
  CHECK (
    ("sourceKind" IS NULL AND "sourceArtifact" IS NULL AND "ruleVersion" IS NULL)
    OR ("sourceKind" IS NOT NULL AND "sourceArtifact" IS NOT NULL AND "ruleVersion" IS NOT NULL)
  );

ALTER TABLE "pc_alignment" ADD CONSTRAINT "pc_alignment_source_model_pins_chk"
  CHECK (
    (
      "modelVersion" IS NULL
      AND "params" IS NULL
      AND ("sourceKind" IS NULL OR "sourceKind" NOT IN ('asr', 'forced-alignment'))
    )
    OR (
      "sourceKind" IN ('asr', 'forced-alignment')
      AND "modelVersion" IS NOT NULL
      AND "params" IS NOT NULL
      AND jsonb_typeof("params") = 'object'
    )
  );

-- 3) ContentVersion 环境局部来源标签（C10.3；不参与内容身份）
ALTER TABLE "pc_content_version"
  ADD COLUMN "sourceEnv" TEXT,
  ADD COLUMN "sourceLabel" TEXT;

ALTER TABLE "pc_content_version" ADD CONSTRAINT "pc_content_version_source_env_chk"
  CHECK ("sourceEnv" IS NULL OR "sourceEnv" IN ('sandbox', 'production'));
