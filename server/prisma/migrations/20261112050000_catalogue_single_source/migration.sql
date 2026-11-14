-- 课程分类单一来源（设计 SSOT：docs/Course_Category_Single_Source_Design.md）
-- 覆盖 §3 I1–I4、§6 M1–M6（ADM-SCHEMA 阶段，I1/I2 数据库约束 + 存量迁移）。
--
-- 顺序有意为之：先做存量归并/重指（M1/M3/M4/M5），再建部分唯一索引（I1/I2），
-- 最后装层级守卫触发器（I3/I4）；否则存量重复会让唯一索引直接建不出来。
--
-- 迁移报告写内部表 "_MigrationReport"（非业务模型、不进入 Prisma schema），每节一条 jsonb，
-- sandbox 演练与上生产后可直接 SELECT 核对影响面。

CREATE TABLE IF NOT EXISTS "_MigrationReport" (
    "id" BIGSERIAL PRIMARY KEY,
    "migration" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- M1 一级分类去重：lower(btrim(name)) 相同的一级分类归并到最早创建的一行。
-- 归并顺序：课程引用 → 子分类（同名先合并） → 删除重复行。
-- 注意 CourseCatalogueEntry.parentId 的外键是 ON DELETE SET NULL：不先搬走子分类，
-- 删除重复父会把子分类静默变成一级分类（正是设计 §1 R9 的根因形态）。
-- ============================================================

CREATE TEMP TABLE "_cat_dup_top" AS
WITH ranked AS (
    SELECT id,
           name,
           first_value(id) OVER w AS keeper_id,
           row_number() OVER w AS rn
    FROM "CourseCatalogueEntry"
    WHERE "parentId" IS NULL
    WINDOW w AS (PARTITION BY lower(btrim(name)) ORDER BY "createdAt", id)
)
SELECT id AS dup_id, keeper_id, name
FROM ranked
WHERE rn > 1;

INSERT INTO "_MigrationReport" ("migration", "section", "detail")
SELECT '20261112050000_catalogue_single_source',
       'M1.top_level_merged',
       COALESCE(
           jsonb_agg(jsonb_build_object(
               'duplicateId', d.dup_id,
               'keeperId', d.keeper_id,
               'name', d.name
           )),
           '[]'::jsonb
       )
FROM "_cat_dup_top" d;

-- 课程直接引用重复一级分类的，重指到保留行。
UPDATE "CommerceCourse" c
SET "categoryId" = d.keeper_id
FROM "_cat_dup_top" d
WHERE c."categoryId" = d.dup_id;

UPDATE "CommerceCourse" c
SET "subjectId" = d.keeper_id
FROM "_cat_dup_top" d
WHERE c."subjectId" = d.dup_id;

-- 重复父下的子分类：保留父已有同名子分类时合并（课程引用重指、删重复子）；
-- 其余子分类改挂到保留父。
CREATE TEMP TABLE "_cat_dup_top_child_merge" AS
SELECT ch.id AS dup_child_id, k.id AS keeper_child_id
FROM "CourseCatalogueEntry" ch
JOIN "_cat_dup_top" d ON ch."parentId" = d.dup_id
JOIN "CourseCatalogueEntry" k ON k."parentId" = d.keeper_id AND k.name = ch.name;

INSERT INTO "_MigrationReport" ("migration", "section", "detail")
SELECT '20261112050000_catalogue_single_source',
       'M1.child_merged_with_keeper',
       COALESCE(
           jsonb_agg(jsonb_build_object(
               'duplicateId', m.dup_child_id,
               'keeperId', m.keeper_child_id
           )),
           '[]'::jsonb
       )
FROM "_cat_dup_top_child_merge" m;

UPDATE "CommerceCourse" c
SET "categoryId" = m.keeper_child_id
FROM "_cat_dup_top_child_merge" m
WHERE c."categoryId" = m.dup_child_id;

UPDATE "CommerceCourse" c
SET "subjectId" = m.keeper_child_id
FROM "_cat_dup_top_child_merge" m
WHERE c."subjectId" = m.dup_child_id;

-- 被合并子分类若有自己的子级（历史三级数据）：先挂到保留子分类；与保留方同名冲突的合并掉。
CREATE TEMP TABLE "_cat_dup_top_gchild_merge" AS
SELECT g.id AS dup_id, k2.id AS keeper_id
FROM "_cat_dup_top_child_merge" m
JOIN "CourseCatalogueEntry" g ON g."parentId" = m.dup_child_id
JOIN "CourseCatalogueEntry" k2 ON k2."parentId" = m.keeper_child_id AND k2.name = g.name;

UPDATE "CommerceCourse" c
SET "categoryId" = m.keeper_id
FROM "_cat_dup_top_gchild_merge" m
WHERE c."categoryId" = m.dup_id;

UPDATE "CommerceCourse" c
SET "subjectId" = m.keeper_id
FROM "_cat_dup_top_gchild_merge" m
WHERE c."subjectId" = m.dup_id;

DELETE FROM "CourseCatalogueEntry" g
USING "_cat_dup_top_gchild_merge" m
WHERE g.id = m.dup_id;

UPDATE "CourseCatalogueEntry" g
SET "parentId" = m.keeper_child_id, "updatedAt" = now()
FROM "_cat_dup_top_child_merge" m
WHERE g."parentId" = m.dup_child_id;

DELETE FROM "CourseCatalogueEntry" ch
USING "_cat_dup_top_child_merge" m
WHERE ch.id = m.dup_child_id;

-- 其余子分类改挂保留父。
UPDATE "CourseCatalogueEntry" ch
SET "parentId" = d.keeper_id, "updatedAt" = now()
FROM "_cat_dup_top" d
WHERE ch."parentId" = d.dup_id;

-- 删除重复一级分类行（此时已无课程/子分类引用）。
DELETE FROM "CourseCatalogueEntry" d
USING "_cat_dup_top" m
WHERE d.id = m.dup_id;

-- M1 子级去重：同一父下 lower(btrim(name)) 相同的子分类同样归并（I2 索引的前置条件）。
CREATE TEMP TABLE "_cat_dup_child" AS
WITH ranked AS (
    SELECT id,
           name,
           "parentId",
           first_value(id) OVER w AS keeper_id,
           row_number() OVER w AS rn
    FROM "CourseCatalogueEntry"
    WHERE "parentId" IS NOT NULL
    WINDOW w AS (PARTITION BY "parentId", lower(btrim(name)) ORDER BY "createdAt", id)
)
SELECT id AS dup_id, keeper_id, name, "parentId"
FROM ranked
WHERE rn > 1;

INSERT INTO "_MigrationReport" ("migration", "section", "detail")
SELECT '20261112050000_catalogue_single_source',
       'M1.sibling_merged',
       COALESCE(
           jsonb_agg(jsonb_build_object(
               'duplicateId', d.dup_id,
               'keeperId', d.keeper_id,
               'parentId', d."parentId",
               'name', d.name
           )),
           '[]'::jsonb
       )
FROM "_cat_dup_child" d;

UPDATE "CommerceCourse" c
SET "categoryId" = d.keeper_id
FROM "_cat_dup_child" d
WHERE c."categoryId" = d.dup_id;

UPDATE "CommerceCourse" c
SET "subjectId" = d.keeper_id
FROM "_cat_dup_child" d
WHERE c."subjectId" = d.dup_id;

-- 被合并子分类若带子级（历史三级数据）：先搬走/合并，再删除。
CREATE TEMP TABLE "_cat_dup_child_gchild_merge" AS
SELECT g.id AS dup_id, k2.id AS keeper_id
FROM "_cat_dup_child" m
JOIN "CourseCatalogueEntry" g ON g."parentId" = m.dup_id
JOIN "CourseCatalogueEntry" k2 ON k2."parentId" = m.keeper_id AND k2.name = g.name;

UPDATE "CommerceCourse" c
SET "categoryId" = m.keeper_id
FROM "_cat_dup_child_gchild_merge" m
WHERE c."categoryId" = m.dup_id;

UPDATE "CommerceCourse" c
SET "subjectId" = m.keeper_id
FROM "_cat_dup_child_gchild_merge" m
WHERE c."subjectId" = m.dup_id;

DELETE FROM "CourseCatalogueEntry" g
USING "_cat_dup_child_gchild_merge" m
WHERE g.id = m.dup_id;

UPDATE "CourseCatalogueEntry" g
SET "parentId" = m.keeper_id, "updatedAt" = now()
FROM "_cat_dup_child" m
WHERE g."parentId" = m.dup_id;

DELETE FROM "CourseCatalogueEntry" d
USING "_cat_dup_child" m
WHERE d.id = m.dup_id;

-- ============================================================
-- M6 预置补全：幂等补 Science 一级分类；四个预置一级分类补 localized（en-GB=name，zh-CN）。
-- 必须早于 M3：存量 legacyCategory='Science' 的课程要靠这次补出来的分类完成背填。
-- ============================================================

INSERT INTO "CourseCatalogueEntry"
    (id, name, localized, description, "parentId", status, "sortOrder", "updatedAt")
SELECT gen_random_uuid()::text,
       'Science',
       jsonb_build_object(
           'en-GB', jsonb_build_object('name', 'Science'),
           'zh-CN', jsonb_build_object('name', '科学')
       ),
       '',
       NULL,
       'ACTIVE'::"CatalogueStatus",
       0,
       now()
WHERE NOT EXISTS (
    SELECT 1
    FROM "CourseCatalogueEntry" c
    WHERE c."parentId" IS NULL AND lower(btrim(c.name)) = 'science'
);

UPDATE "CourseCatalogueEntry" c
SET "localized" = COALESCE(c."localized", '{}'::jsonb)
                  || jsonb_build_object('en-GB', jsonb_build_object('name', c.name)),
    "updatedAt" = now()
WHERE c."parentId" IS NULL
  AND lower(btrim(c.name)) IN (
      'science', 'chinese humanities', 'european humanities', 'society'
  )
  AND NOT (COALESCE(c."localized", '{}'::jsonb) ? 'en-GB');

UPDATE "CourseCatalogueEntry" c
SET "localized" = COALESCE(c."localized", '{}'::jsonb)
                  || jsonb_build_object('zh-CN', jsonb_build_object('name', preset.zh)),
    "updatedAt" = now()
FROM (VALUES
    ('science', '科学'),
    ('chinese humanities', '中国人文'),
    ('european humanities', '欧洲人文'),
    ('society', '社会')
) AS preset(name, zh)
WHERE c."parentId" IS NULL
  AND lower(btrim(c.name)) = preset.name
  AND NOT (COALESCE(c."localized", '{}'::jsonb) ? 'zh-CN');

INSERT INTO "_MigrationReport" ("migration", "section", "detail")
SELECT '20261112050000_catalogue_single_source',
       'M6.presets',
       COALESCE(
           jsonb_agg(jsonb_build_object(
               'categoryId', c.id,
               'name', c.name,
               'status', c.status,
               'localized', c."localized"
           )),
           '[]'::jsonb
       )
FROM "CourseCatalogueEntry" c
WHERE c."parentId" IS NULL
  AND lower(btrim(c.name)) IN (
      'science', 'chinese humanities', 'european humanities', 'society'
  );

-- ============================================================
-- M3 legacyCategory 背填：categoryId 为空且 legacyCategory 非空，按 name（trim、大小写不敏感）
-- 匹配 ACTIVE 分类。多个候选时优先一级分类，再按创建时间取最早。仍不中的保持 NULL 并报告
-- （发布会被 Category is required 拦截，不造假分类；设计 §6 M3）。
-- ============================================================

CREATE TEMP TABLE "_cat_backfill" AS
WITH matched AS (
    SELECT c.id AS course_id,
           cat.id AS cat_id,
           row_number() OVER (
               PARTITION BY c.id
               ORDER BY (cat."parentId" IS NULL) DESC, cat."createdAt", cat.id
           ) AS rn
    FROM "CommerceCourse" c
    JOIN "CourseCatalogueEntry" cat
      ON cat.status = 'ACTIVE'::"CatalogueStatus"
     AND lower(btrim(cat.name)) = lower(btrim(c."legacyCategory"))
    WHERE c."categoryId" IS NULL
      AND btrim(COALESCE(c."legacyCategory", '')) <> ''
)
SELECT course_id, cat_id
FROM matched
WHERE rn = 1;

INSERT INTO "_MigrationReport" ("migration", "section", "detail")
SELECT '20261112050000_catalogue_single_source',
       'M3.backfilled',
       COALESCE(
           jsonb_agg(jsonb_build_object(
               'courseId', b.course_id,
               'categoryId', b.cat_id
           )),
           '[]'::jsonb
       )
FROM "_cat_backfill" b;

UPDATE "CommerceCourse" c
SET "categoryId" = b.cat_id
FROM "_cat_backfill" b
WHERE c.id = b.course_id;

INSERT INTO "_MigrationReport" ("migration", "section", "detail")
SELECT '20261112050000_catalogue_single_source',
       'M3.unmatched',
       COALESCE(
           jsonb_agg(jsonb_build_object(
               'courseId', c.id,
               'legacyCategory', c."legacyCategory"
           )),
           '[]'::jsonb
       )
FROM "CommerceCourse" c
WHERE c."categoryId" IS NULL
  AND btrim(COALESCE(c."legacyCategory", '')) <> '';

-- ============================================================
-- M5 占位分类归档：Uncategorized / Uncategorised（name 或任一 localized 显示名命中，
-- trim、大小写不敏感）标记 ARCHIVED 并报告；导入只认 ACTIVE，之后不会再命中（设计 §6 M5）。
-- ============================================================

CREATE TEMP TABLE "_cat_placeholder" AS
SELECT c.id, c.name
FROM "CourseCatalogueEntry" c
WHERE lower(btrim(c.name)) IN ('uncategorized', 'uncategorised')
   OR EXISTS (
       SELECT 1
       FROM jsonb_each(COALESCE(c."localized", '{}'::jsonb)) AS l(lang, fields)
       WHERE lower(btrim(fields ->> 'name')) IN ('uncategorized', 'uncategorised')
   );

INSERT INTO "_MigrationReport" ("migration", "section", "detail")
SELECT '20261112050000_catalogue_single_source',
       'M5.placeholder_archived',
       COALESCE(
           jsonb_agg(jsonb_build_object(
               'categoryId', p.id,
               'name', p.name
           )),
           '[]'::jsonb
       )
FROM "_cat_placeholder" p;

UPDATE "CourseCatalogueEntry" c
SET status = 'ARCHIVED'::"CatalogueStatus", "updatedAt" = now()
WHERE c.id IN (SELECT p.id FROM "_cat_placeholder" p)
  AND c.status <> 'ARCHIVED'::"CatalogueStatus";

-- ============================================================
-- M4 归档/非法层级引用：课程 categoryId/subjectId 指向 ARCHIVED 或层级非法（>2、环）时，
-- 能重映射到有效一级（ACTIVE 根）则重映射，否则置空并报告（设计 §6 M4、I5）。
-- ============================================================

CREATE TEMP TABLE "_cat_root" AS
WITH RECURSIVE tree AS (
    SELECT id AS node_id, id AS cursor_id, "parentId", 1 AS depth
    FROM "CourseCatalogueEntry"
    UNION ALL
    SELECT t.node_id, p.id, p."parentId", t.depth + 1
    FROM tree t
    JOIN "CourseCatalogueEntry" p ON t."parentId" = p.id
)
CYCLE cursor_id SET is_cycle USING path
SELECT DISTINCT ON (node_id)
       node_id,
       cursor_id AS root_id,
       depth,
       is_cycle
FROM tree
ORDER BY node_id, depth DESC;

INSERT INTO "_MigrationReport" ("migration", "section", "detail")
SELECT '20261112050000_catalogue_single_source',
       'I3.legacy_hierarchy_violations',
       COALESCE(
           jsonb_agg(jsonb_build_object(
               'categoryId', r.node_id,
               'depth', r.depth,
               'cycle', r.is_cycle
           )),
           '[]'::jsonb
       )
FROM "_cat_root" r
WHERE r.depth > 2 OR r.is_cycle;

CREATE TEMP TABLE "_cat_course_category_remap" AS
SELECT c.id AS course_id,
       c."categoryId" AS old_id,
       cat.status AS old_status,
       r.depth AS old_depth,
       r.is_cycle AS old_cycle,
       CASE
           WHEN cat.status = 'ACTIVE'::"CatalogueStatus"
                AND r.depth <= 2
                AND NOT r.is_cycle THEN c."categoryId"
           WHEN r.is_cycle THEN NULL
           WHEN root.status = 'ACTIVE'::"CatalogueStatus" THEN root.id
           ELSE NULL
       END AS new_id
FROM "CommerceCourse" c
JOIN "CourseCatalogueEntry" cat ON cat.id = c."categoryId"
JOIN "_cat_root" r ON r.node_id = cat.id
LEFT JOIN "CourseCatalogueEntry" root ON root.id = r.root_id
WHERE c."categoryId" IS NOT NULL
  AND NOT (cat.status = 'ACTIVE'::"CatalogueStatus" AND r.depth <= 2 AND NOT r.is_cycle);

INSERT INTO "_MigrationReport" ("migration", "section", "detail")
SELECT '20261112050000_catalogue_single_source',
       'M4.category_remapped',
       COALESCE(
           jsonb_agg(jsonb_build_object(
               'courseId', m.course_id,
               'oldCategoryId', m.old_id,
               'oldStatus', m.old_status,
               'oldDepth', m.old_depth,
               'newCategoryId', m.new_id
           )),
           '[]'::jsonb
       )
FROM "_cat_course_category_remap" m;

UPDATE "CommerceCourse" c
SET "categoryId" = m.new_id
FROM "_cat_course_category_remap" m
WHERE c.id = m.course_id;

CREATE TEMP TABLE "_cat_course_subject_remap" AS
SELECT c.id AS course_id,
       c."subjectId" AS old_id,
       cat.status AS old_status,
       r.depth AS old_depth,
       r.is_cycle AS old_cycle,
       CASE
           WHEN cat.status = 'ACTIVE'::"CatalogueStatus"
                AND r.depth <= 2
                AND NOT r.is_cycle THEN c."subjectId"
           WHEN r.is_cycle THEN NULL
           WHEN root.status = 'ACTIVE'::"CatalogueStatus" THEN root.id
           ELSE NULL
       END AS new_id
FROM "CommerceCourse" c
JOIN "CourseCatalogueEntry" cat ON cat.id = c."subjectId"
JOIN "_cat_root" r ON r.node_id = cat.id
LEFT JOIN "CourseCatalogueEntry" root ON root.id = r.root_id
WHERE c."subjectId" IS NOT NULL
  AND NOT (cat.status = 'ACTIVE'::"CatalogueStatus" AND r.depth <= 2 AND NOT r.is_cycle);

INSERT INTO "_MigrationReport" ("migration", "section", "detail")
SELECT '20261112050000_catalogue_single_source',
       'M4.subject_remapped',
       COALESCE(
           jsonb_agg(jsonb_build_object(
               'courseId', m.course_id,
               'oldSubjectId', m.old_id,
               'oldStatus', m.old_status,
               'oldDepth', m.old_depth,
               'newSubjectId', m.new_id
           )),
           '[]'::jsonb
       )
FROM "_cat_course_subject_remap" m;

UPDATE "CommerceCourse" c
SET "subjectId" = m.new_id
FROM "_cat_course_subject_remap" m
WHERE c.id = m.course_id;

-- ============================================================
-- I1/I2 部分唯一索引（M2）：Prisma DSL 表达不了部分索引，走 raw SQL；
-- 原 @@unique([parentId, name]) 保留（对其覆盖的非空 parentId 精确重名仍有约束力）。
-- ============================================================

CREATE UNIQUE INDEX "CourseCatalogueEntry_top_level_name_lower_key"
    ON "CourseCatalogueEntry" (lower(btrim(name)))
    WHERE "parentId" IS NULL;

CREATE UNIQUE INDEX "CourseCatalogueEntry_sibling_name_lower_key"
    ON "CourseCatalogueEntry" ("parentId", lower(btrim(name)))
    WHERE "parentId" IS NOT NULL;

-- ============================================================
-- I3/I4 层级守卫（DB 兜底）：深度 ≤ 2、禁止自指。
-- 设计把业务校验放服务层；S2 缝在黑盒 DB 边界观察（server/test/category-invariants.e2e-spec.ts），
-- 因此这里用触发器兜底任何写入路径（迁移/种子/导入/直写）。
-- 只在 parentId（或 id）变化时触发；更新名称等其它列不付出这个检查成本。
-- 注：I3 的服务层归属以 20261112080000_catalogue_depth_service_rule 为准
-- （该迁移把深度检查移回服务层，只保留 I4 自指兜底）。
-- ============================================================

CREATE OR REPLACE FUNCTION "CourseCatalogueEntry_enforce_hierarchy"()
RETURNS trigger AS $$
DECLARE
    parent_parent_id text;
BEGIN
    IF NEW."parentId" IS NULL THEN
        RETURN NEW;
    END IF;

    -- I4：禁止自指。
    IF NEW."parentId" = NEW.id THEN
        RAISE EXCEPTION 'CourseCatalogueEntry % cannot be its own parent (I4)', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;

    -- I3：父必须是已存在的一级分类（深度 ≤ 2）。
    SELECT p."parentId" INTO parent_parent_id
    FROM "CourseCatalogueEntry" p
    WHERE p.id = NEW."parentId";

    IF NOT FOUND THEN
        RAISE EXCEPTION 'CourseCatalogueEntry % parent % does not exist', NEW.id, NEW."parentId"
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF parent_parent_id IS NOT NULL THEN
        RAISE EXCEPTION 'CourseCatalogueEntry % would be deeper than level 2 (I3)', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;

    -- 把带子级的节点挂到别的父下会造出三级节点，同样拒绝。
    IF TG_OP = 'UPDATE'
       AND NEW."parentId" IS DISTINCT FROM OLD."parentId"
       AND EXISTS (
           SELECT 1 FROM "CourseCatalogueEntry" ch WHERE ch."parentId" = NEW.id
       ) THEN
        RAISE EXCEPTION 'CourseCatalogueEntry % has children and cannot move under a parent (I3)', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CourseCatalogueEntry_hierarchy_guard"
BEFORE INSERT OR UPDATE OF "parentId", "id" ON "CourseCatalogueEntry"
FOR EACH ROW EXECUTE FUNCTION "CourseCatalogueEntry_enforce_hierarchy"();

-- 临时工作表的显式清理（会话结束也会自动消失，这里保持连接干净、可重放）。
DROP TABLE IF EXISTS "_cat_dup_top";
DROP TABLE IF EXISTS "_cat_dup_top_child_merge";
DROP TABLE IF EXISTS "_cat_dup_top_gchild_merge";
DROP TABLE IF EXISTS "_cat_dup_child";
DROP TABLE IF EXISTS "_cat_dup_child_gchild_merge";
DROP TABLE IF EXISTS "_cat_backfill";
DROP TABLE IF EXISTS "_cat_placeholder";
DROP TABLE IF EXISTS "_cat_root";
DROP TABLE IF EXISTS "_cat_course_category_remap";
DROP TABLE IF EXISTS "_cat_course_subject_remap";
