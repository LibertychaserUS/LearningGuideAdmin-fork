-- 分类层级规则的落点修正（设计 SSOT §3 I3 / §14 C3/C9）。
--
-- I3 原文："深度 ≤ 2：子节点的父必须是一级分类；服务层校验（未来放开深度只改校验，不改表）"。
-- 20261112050000_catalogue_single_source 的 DB 触发器同时固化了 I3（深度）与 I4（自指）。
-- 深度规则属于服务层（课程绑定校验 C3/C4 的 CATEGORY_INVALID_LEVEL），DB 固化会导致：
--   1) 无法构造三级节点的测试夹具（server/test/category-course-binding.e2e-spec.ts）；
--   2) 放开深度必须改库对象，与 I3 的可扩展性要求相悖。
-- 本迁移只保留 I4 自指与父节点存在性兜底，深度规则回到服务层。
-- 红线核对：不涉及任何 hash/digest、时间或身份字段。

CREATE OR REPLACE FUNCTION "CourseCatalogueEntry_enforce_hierarchy"()
RETURNS trigger AS $$
BEGIN
    IF NEW."parentId" IS NULL THEN
        RETURN NEW;
    END IF;

    -- I4：禁止自指。
    IF NEW."parentId" = NEW.id THEN
        RAISE EXCEPTION 'CourseCatalogueEntry % cannot be its own parent (I4)', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;

    -- 父节点必须存在（FK 亦兜底；这里给出更清晰的错误）。
    IF NOT EXISTS (
        SELECT 1 FROM "CourseCatalogueEntry" p WHERE p.id = NEW."parentId"
    ) THEN
        RAISE EXCEPTION 'CourseCatalogueEntry % parent % does not exist', NEW.id, NEW."parentId"
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
