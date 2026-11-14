-- Part C Stage 同父 orderKey 唯一必须是「同一课程内」：跨课程根节点都从
-- '000001' 开始（C3/STR-3 的零填充数值路径是课程局部序号）。原唯一索引
-- (parentStageKey, orderKey) NULLS NOT DISTINCT 会把不同课程的根节点互相判重，
-- 导致第二门课程无法导入 pc_stage。这里把 courseKey 纳入唯一键。

DROP INDEX "pc_stage_parentStageKey_orderKey_key";

CREATE UNIQUE INDEX "pc_stage_courseKey_parentStageKey_orderKey_key"
  ON "pc_stage"("courseKey", "parentStageKey", "orderKey") NULLS NOT DISTINCT;
