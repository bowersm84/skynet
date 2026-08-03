-- =============================================================================
-- Kit component-lot traceability (D-KSTC-24)
-- One row per kit lot x component part x lot shipped. As-written strings are
-- the record; component_id is the normalized link when the part number matches
-- kit_components. UNIQUE (kit_lot_id, part, lot) makes every load path
-- idempotent (backfill, packing-slip upload, Fishbowl refresh rerun).
--
-- Writes are RPC-mediated by design: no direct INSERT/UPDATE/DELETE policies.
-- The backfill runs via psql (bypasses RLS); the Phase 2 packing-slip RPC is
-- SECURITY DEFINER. Admin/compliance correction policies get added in Phase 2
-- copying the exact expressions used on sibling kit tables in the repo.
--
-- Run: TEST first, then PROD. Single transaction; safe to re-run only after a
-- failed (rolled-back) attempt -- it is not IF NOT EXISTS by design.
-- =============================================================================
BEGIN;

CREATE TABLE public.kit_lot_component_lots (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kit_lot_id uuid NOT NULL,
  component_id uuid,
  part_number_as_written text NOT NULL,
  lot_number_as_written text NOT NULL,
  qty_shipped numeric,
  ship_date date,
  shipment_number text,
  so_line_no integer,
  source text NOT NULL DEFAULT 'packing_slip'
    CHECK (source = ANY (ARRAY['fishbowl_backfill'::text, 'packing_slip'::text, 'manual'::text])),
  needs_review boolean NOT NULL DEFAULT false,
  review_reason text,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT kit_lot_component_lots_pkey PRIMARY KEY (id),
  CONSTRAINT klcl_unique UNIQUE (kit_lot_id, part_number_as_written, lot_number_as_written),
  CONSTRAINT klcl_lot_fkey FOREIGN KEY (kit_lot_id) REFERENCES public.kit_lots(id),
  CONSTRAINT klcl_component_fkey FOREIGN KEY (component_id) REFERENCES public.kit_components(id),
  CONSTRAINT klcl_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id),
  CONSTRAINT klcl_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id)
);

CREATE INDEX klcl_lot_idx       ON public.kit_lot_component_lots (kit_lot_id);
CREATE INDEX klcl_lotnum_idx    ON public.kit_lot_component_lots (lot_number_as_written);
CREATE INDEX klcl_part_idx      ON public.kit_lot_component_lots (part_number_as_written);
CREATE INDEX klcl_component_idx ON public.kit_lot_component_lots (component_id);

-- Standing kit-registry touch trigger (exists on TEST and PROD).
CREATE TRIGGER klcl_touch BEFORE UPDATE ON public.kit_lot_component_lots
  FOR EACH ROW EXECUTE FUNCTION public.kstc_touch_updated_at();

ALTER TABLE public.kit_lot_component_lots ENABLE ROW LEVEL SECURITY;

CREATE POLICY klcl_select ON public.kit_lot_component_lots
  FOR SELECT TO authenticated USING (true);

-- Verification (last statement): table + policy present.
SELECT
  (SELECT count(*) FROM information_schema.tables
    WHERE table_schema='public' AND table_name='kit_lot_component_lots') AS table_created,
  (SELECT count(*) FROM pg_policies
    WHERE schemaname='public' AND tablename='kit_lot_component_lots')   AS policies,
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname='public' AND tablename='kit_lot_component_lots')   AS indexes;

COMMIT;
