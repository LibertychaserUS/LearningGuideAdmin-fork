-- 课程分类的各语言显示名进库（2026-11-12），用通用多语言模板 localized：
--   { "<语言>": { "name": "<显示名>" } }，与 Exhibit.localized 同一形状。
-- 之前只有英文 name 在库里、中文名写死在前端，两种语言不在同一个地方。
-- 现在 name 只做稳定键（导入按它匹配），界面一律从 localized 取。
ALTER TABLE "CourseCatalogueEntry" ADD COLUMN "localized" JSONB NOT NULL DEFAULT '{}';

-- 已有分类：英文显示名就是现在的 name。
UPDATE "CourseCatalogueEntry"
SET "localized" = jsonb_build_object('en-GB', jsonb_build_object('name', name));

-- 预置一级分类补中文显示名（原前端映射表的内容）。
UPDATE "CourseCatalogueEntry" AS c
SET "localized" = c."localized" || jsonb_build_object('zh-CN', jsonb_build_object('name', preset.zh))
FROM (VALUES
  ('science', '科学'),
  ('chinese humanities', '中国人文'),
  ('european humanities', '欧洲人文'),
  ('society', '社会')
) AS preset(name, zh)
WHERE c."parentId" IS NULL AND lower(c.name) = preset.name;
