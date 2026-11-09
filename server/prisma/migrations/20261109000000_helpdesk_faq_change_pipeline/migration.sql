-- Helpdesk FAQ 写入流水线（设计文档「后端架构：接口、编排与中间件」，2026-11-09）。只增不删，旧代码照常能跑。
--
-- 1. helpdesk_faq_changes：一次操作一行（命令、执行者、起因、traceparent、改了几行）。只追加。
--    它同时是发件箱：提交后要做的事（通知各实例、标飞轮候选）都从这里按 seq 往后读，读到哪记在消费者自己那边。
-- 2. 各修订表加 change_id：缺省取本事务的 helpdesk.change_id（流水线 set_config(..., true)），所以已有的 INSERT
--    不用改；不经流水线的写入（旧代码、手工 SQL）照旧是 NULL。流水线提交前按改动号数各修订表（每张都有部分索引）。
--    改动记录写入前拿尾锁（advisory 719330/2），seq 的先后 = 提交的先后。
-- 3. helpdesk_idempotency：所有命令共用的幂等记录（同键同请求 = 原样返回；同键不同请求 = 422）。

CREATE TABLE "helpdesk_faq_changes" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "command" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "employee_id" UUID,
    "cause_kind" TEXT NOT NULL,
    "cause_ref" TEXT,
    "note" TEXT,
    "trace_id" TEXT,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_faq_changes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_faq_changes_seq_key" UNIQUE ("seq"),
    CONSTRAINT "helpdesk_faq_changes_cause_check"
        CHECK ("cause_kind" IN ('ui', 'import', 'flywheel', 'rewrite', 'seed', 'release', 'system'))
);

CREATE INDEX "helpdesk_faq_changes_at_idx" ON "helpdesk_faq_changes"("at");

CREATE TRIGGER "helpdesk_faq_changes_append_only"
    BEFORE UPDATE OR DELETE ON "helpdesk_faq_changes"
    FOR EACH ROW EXECUTE FUNCTION helpdesk_faq_append_only();

-- 本事务的 change_id（流水线用 set_config(..., true) 设；没设 = NULL）
CREATE FUNCTION helpdesk_current_change_id() RETURNS UUID
    LANGUAGE SQL STABLE AS
$$ SELECT NULLIF(current_setting('helpdesk.change_id', true), '')::uuid $$;

ALTER TABLE "helpdesk_faq_revisions" ADD COLUMN "change_id" UUID DEFAULT helpdesk_current_change_id();
ALTER TABLE "helpdesk_faq_edge_revisions" ADD COLUMN "change_id" UUID DEFAULT helpdesk_current_change_id();
ALTER TABLE "helpdesk_faq_phrasing_revisions" ADD COLUMN "change_id" UUID DEFAULT helpdesk_current_change_id();
ALTER TABLE "helpdesk_faq_map_revisions" ADD COLUMN "change_id" UUID DEFAULT helpdesk_current_change_id();
ALTER TABLE "helpdesk_faq_reviews" ADD COLUMN "change_id" UUID DEFAULT helpdesk_current_change_id();
ALTER TABLE "helpdesk_faq_candidate_revisions" ADD COLUMN "change_id" UUID DEFAULT helpdesk_current_change_id();

CREATE INDEX "helpdesk_faq_revisions_change_idx" ON "helpdesk_faq_revisions"("change_id") WHERE "change_id" IS NOT NULL;
CREATE INDEX "helpdesk_faq_edge_revisions_change_idx" ON "helpdesk_faq_edge_revisions"("change_id") WHERE "change_id" IS NOT NULL;
CREATE INDEX "helpdesk_faq_phrasing_revisions_change_idx" ON "helpdesk_faq_phrasing_revisions"("change_id") WHERE "change_id" IS NOT NULL;
CREATE INDEX "helpdesk_faq_map_revisions_change_idx" ON "helpdesk_faq_map_revisions"("change_id") WHERE "change_id" IS NOT NULL;
CREATE INDEX "helpdesk_faq_reviews_change_idx" ON "helpdesk_faq_reviews"("change_id") WHERE "change_id" IS NOT NULL;
CREATE INDEX "helpdesk_faq_candidate_revisions_change_idx" ON "helpdesk_faq_candidate_revisions"("change_id") WHERE "change_id" IS NOT NULL;

CREATE TABLE "helpdesk_idempotency" (
    "command" TEXT NOT NULL,
    "key" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "change_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_idempotency_pkey" PRIMARY KEY ("command", "actor", "key")
);

CREATE INDEX "helpdesk_idempotency_at_idx" ON "helpdesk_idempotency"("at");
