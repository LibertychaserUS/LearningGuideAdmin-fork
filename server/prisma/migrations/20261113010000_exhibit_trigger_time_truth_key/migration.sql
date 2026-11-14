-- T3-3/T3-4：触发点真值键是 (lesson, exhibit, language, timeMs)。
-- 同一展品在同一语言的多个不同时间点是不同内容事实；旧唯一键
-- (lessonId, exhibitId, language) 会把它们折叠/拒绝。把 timeSeconds 纳入唯一键，
-- 完全相同的真值键仍是重复（T3-5 在派生层拒绝）。
DROP INDEX IF EXISTS "ExhibitTrigger_lessonId_exhibitId_language_key";

CREATE UNIQUE INDEX "ExhibitTrigger_lessonId_exhibitId_language_timeSeconds_key"
  ON "ExhibitTrigger"("lessonId", "exhibitId", "language", "timeSeconds");
