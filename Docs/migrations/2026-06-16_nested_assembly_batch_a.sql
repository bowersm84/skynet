-- ============================================================================
-- 2026-06-16_nested_assembly_batch_a.sql
-- Nested Assembly — Batch A: schema + BOM explosion primitive
-- Apply to TEST first, verify, then PROD (same file). Idempotent.
-- Additive and inert for all existing single-level work orders.
-- Gated downstream behind FEATURES.NESTED_ASSEMBLY (default false).
-- ============================================================================

-- 1. Assembly hierarchy inside a work order (D-NEST-01) -----------------------
ALTER TABLE public.work_order_assemblies
  ADD COLUMN IF NOT EXISTS parent_work_order_assembly_id uuid;

ALTER TABLE public.work_order_assemblies
  DROP CONSTRAINT IF EXISTS work_order_assemblies_parent_fkey;
ALTER TABLE public.work_order_assemblies
  ADD  CONSTRAINT work_order_assemblies_parent_fkey
       FOREIGN KEY (parent_work_order_assembly_id)
       REFERENCES public.work_order_assemblies(id);

CREATE INDEX IF NOT EXISTS idx_woa_parent
  ON public.work_order_assemblies (parent_work_order_assembly_id)
  WHERE parent_work_order_assembly_id IS NOT NULL;

-- 2. Sub-assembly check-in primitive, Option A (D-NEST-02) --------------------
ALTER TABLE public.assembly_component_checkins
  ADD COLUMN IF NOT EXISTS source_work_order_assembly_id uuid;

ALTER TABLE public.assembly_component_checkins
  DROP CONSTRAINT IF EXISTS assembly_component_checkins_source_fkey;
ALTER TABLE public.assembly_component_checkins
  ADD  CONSTRAINT assembly_component_checkins_source_fkey
       FOREIGN KEY (source_work_order_assembly_id)
       REFERENCES public.work_order_assemblies(id);

ALTER TABLE public.assembly_component_checkins
  ALTER COLUMN job_id DROP NOT NULL;

-- Exactly one source: a component job XOR a sub-assembly woa.
-- Existing rows (job_id set, source NULL) already satisfy this — no data migration.
ALTER TABLE public.assembly_component_checkins
  DROP CONSTRAINT IF EXISTS assembly_component_checkins_one_source_chk;
ALTER TABLE public.assembly_component_checkins
  ADD  CONSTRAINT assembly_component_checkins_one_source_chk
       CHECK ( (job_id IS NOT NULL) <> (source_work_order_assembly_id IS NOT NULL) );

CREATE INDEX IF NOT EXISTS idx_aci_source
  ON public.assembly_component_checkins (source_work_order_assembly_id)
  WHERE source_work_order_assembly_id IS NOT NULL;

-- 3. Recursive BOM explosion (D-NEST-03) -------------------------------------
CREATE OR REPLACE FUNCTION public.explode_bom(p_part_id uuid, p_top_qty integer)
RETURNS TABLE (
  path                uuid[],
  depth               integer,
  parent_part_id      uuid,
  component_id        uuid,
  part_number         text,
  description         text,
  part_type           text,
  sort_order          integer,
  bom_quantity        integer,
  cumulative_quantity integer,
  is_cycle            boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE bom_tree AS (
    SELECT
      ARRAY[ab.component_id]            AS path,
      1                                AS depth,
      ab.assembly_id                   AS parent_part_id,
      ab.component_id                  AS component_id,
      p.part_number::text              AS part_number,
      p.description::text              AS description,
      p.part_type::text                AS part_type,
      ab.sort_order                    AS sort_order,
      ab.quantity                      AS bom_quantity,
      (ab.quantity * p_top_qty)        AS cumulative_quantity,
      false                            AS is_cycle
    FROM public.assembly_bom ab
    JOIN public.parts p ON p.id = ab.component_id
    WHERE ab.assembly_id = p_part_id

    UNION ALL

    SELECT
      bt.path || ab.component_id,
      bt.depth + 1,
      ab.assembly_id,
      ab.component_id,
      p.part_number::text,
      p.description::text,
      p.part_type::text,
      ab.sort_order,
      ab.quantity,
      (ab.quantity * bt.cumulative_quantity),
      (ab.component_id = ANY (bt.path))   AS is_cycle
    FROM bom_tree bt
    JOIN public.assembly_bom ab ON ab.assembly_id = bt.component_id
    JOIN public.parts p          ON p.id = ab.component_id
    WHERE bt.is_cycle = false
      AND bt.depth   < 20
  )
  SELECT path, depth, parent_part_id, component_id, part_number, description,
         part_type, sort_order, bom_quantity, cumulative_quantity, is_cycle
  FROM bom_tree
  ORDER BY path;
$$;

GRANT EXECUTE ON FUNCTION public.explode_bom(uuid, integer) TO authenticated;
