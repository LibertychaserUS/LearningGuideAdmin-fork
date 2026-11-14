-- 显式草稿状态（设计 C9，替代指纹判 No draft）：
--   No draft ⇔ draftRevision == liveBaseRevision。
-- 已有的 20261112020000_course_draft_revision 只加了乐观并发 revision，没有这两个字段，
-- 这里补齐；hasDraft 列保留，服务层切换完成前继续由它驱动旧路径。
ALTER TABLE "CommerceCourse" ADD COLUMN "draftRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CommerceCourse" ADD COLUMN "liveBaseRevision" INTEGER NOT NULL DEFAULT 0;

-- 存量语义：hasDraft = true 的课程视作"有草稿"（draftRevision > liveBaseRevision）。
UPDATE "CommerceCourse" SET "draftRevision" = 1 WHERE "hasDraft" = true;
