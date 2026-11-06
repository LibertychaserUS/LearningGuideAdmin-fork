-- 发布前检查的分层结果缓存（release check v2，owner 2026-11-06 批准；src/contracts/helpdesk-eval-cache.ts）：
-- 同一个输入（问句向量 / 一对精排 / 一次模型步）只付一次钱。键是输入的 SHA-256，不存原文；
-- 只有检查读写，线上聊天从不碰。条目 14 天后不再用（读的时候过滤），检查开始时顺手删掉过期的。
CREATE TABLE "helpdesk_eval_stage_cache" (
    "layer" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "helpdesk_eval_stage_cache_pkey" PRIMARY KEY ("layer", "key"),
    CONSTRAINT "helpdesk_eval_stage_cache_layer_check" CHECK ("layer" IN ('embed', 'rerank', 'step')),
    CONSTRAINT "helpdesk_eval_stage_cache_key_check" CHECK ("key" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "helpdesk_eval_stage_cache_latency_check" CHECK ("latency_ms" >= 0),
    CONSTRAINT "helpdesk_eval_stage_cache_cost_check" CHECK ("cost_usd" >= 0)
);

CREATE INDEX "helpdesk_eval_stage_cache_created_at_idx" ON "helpdesk_eval_stage_cache" ("created_at");
