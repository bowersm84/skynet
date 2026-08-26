-- ============================================================================
-- FB1 Batch C2 — users + inventory snapshot RPCs, recent-changes view
-- File: Docs/migrations/2026-08-26_fishbowl_bridge_c2.sql
-- Requires: _a, _b, _c1 applied. TEST first. Idempotent.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.fb_part_inventory
  ADD COLUMN IF NOT EXISTS qty_not_available numeric,
  ADD COLUMN IF NOT EXISTS by_location jsonb,
  ADD COLUMN IF NOT EXISTS part_id uuid REFERENCES public.parts(id);
CREATE INDEX IF NOT EXISTS idx_fbinv_part ON public.fb_part_inventory (part_id);

ALTER TABLE public.fb_sync_state ADD COLUMN IF NOT EXISTS last_users_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Users (D-FB-34): names only. Also back-fills fb_username on events that predate the user list.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_upsert_users(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration', 'admin']);
  INSERT INTO public.fb_users (fb_user_id, username, full_name, is_active, synced_at)
  SELECT (r->>'id')::integer,
         r->>'userName',
         NULLIF(btrim(concat_ws(' ', r->>'firstName', r->>'lastName')), ''),
         COALESCE((r->>'activeFlag')::boolean, true),
         now()
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) r
   WHERE r->>'id' IS NOT NULL AND r->>'userName' IS NOT NULL
  ON CONFLICT (fb_user_id) DO UPDATE
     SET username = EXCLUDED.username, full_name = EXCLUDED.full_name,
         is_active = EXCLUDED.is_active, synced_at = now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE public.fb_sync_events e
     SET fb_username = u.username
    FROM public.fb_users u
   WHERE e.fb_username IS NULL AND e.fb_modified_user_id = u.fb_user_id;
  UPDATE public.fb_sync_state SET last_users_at = now(), updated_at = now() WHERE id = 1;
  RETURN v_n;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Inventory snapshot (D-FB-33). Rows: { partId, partNum, onHand, allocated, notAvailable, onOrder, available, byLocation }
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_upsert_inventory(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration', 'admin']);
  INSERT INTO public.fb_part_inventory
    (part_num, fb_part_id, qty_on_hand, qty_allocated, qty_not_available, qty_available, qty_on_order, by_location, part_id, snapshot_at)
  SELECT r->>'partNum',
         NULLIF(r->>'partId', '')::integer,
         NULLIF(r->>'onHand', '')::numeric,
         NULLIF(r->>'allocated', '')::numeric,
         NULLIF(r->>'notAvailable', '')::numeric,
         NULLIF(r->>'available', '')::numeric,
         NULLIF(r->>'onOrder', '')::numeric,
         r->'byLocation',
         (SELECT p.id FROM public.parts p WHERE upper(btrim(p.part_number)) = upper(btrim(r->>'partNum')) LIMIT 1),
         now()
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) r
   WHERE COALESCE(r->>'partNum', '') <> ''
  ON CONFLICT (part_num) DO UPDATE
     SET fb_part_id = EXCLUDED.fb_part_id, qty_on_hand = EXCLUDED.qty_on_hand, qty_allocated = EXCLUDED.qty_allocated,
         qty_not_available = EXCLUDED.qty_not_available, qty_available = EXCLUDED.qty_available,
         qty_on_order = EXCLUDED.qty_on_order, by_location = EXCLUDED.by_location,
         part_id = COALESCE(EXCLUDED.part_id, public.fb_part_inventory.part_id), snapshot_at = now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE public.fb_sync_state SET last_inventory_at = now(), updated_at = now() WHERE id = 1;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.fb_upsert_users(jsonb)     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fb_upsert_inventory(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fb_upsert_users(jsonb)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.fb_upsert_inventory(jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Recent changes / exceptions view (Order Queue tabs)
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_fb_recent_changes;
CREATE VIEW public.v_fb_recent_changes WITH (security_invoker = true) AS
SELECT e.id, e.event_type, e.changes, e.fb_rev, e.fb_modified_user_id, e.fb_timestamp, e.created_at,
       e.affects_co, e.requires_ack, e.acknowledged_at, e.acknowledged_by,
       COALESCE(e.fb_username, u.username) AS changed_by,
       e.fb_so_id, s.so_number, s.customer_name, s.status_id AS so_status_id,
       s.customer_order_id, co.co_number,
       e.fb_soitem_id, l.line_number, l.product_num, l.part_num, l.disposition, l.status_id AS line_status_id,
       l.customer_order_line_id, col.line_number AS co_line_number, col.status AS co_line_status
  FROM public.fb_sync_events e
  JOIN public.fb_sales_orders s ON s.fb_so_id = e.fb_so_id
  LEFT JOIN public.fb_sales_order_lines l ON l.fb_soitem_id = e.fb_soitem_id
  LEFT JOIN public.customer_orders co ON co.id = s.customer_order_id
  LEFT JOIN public.customer_order_lines col ON col.id = l.customer_order_line_id
  LEFT JOIN public.fb_users u ON u.fb_user_id = e.fb_modified_user_id;

GRANT SELECT ON public.v_fb_recent_changes TO authenticated;
REVOKE ALL ON public.v_fb_recent_changes FROM anon;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification (last result set)
-- ---------------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_name = 'fb_part_inventory'
     AND column_name IN ('qty_not_available','by_location','part_id'))                                          AS inv_cols,
  (SELECT count(*) FROM information_schema.columns WHERE table_name = 'fb_sync_state' AND column_name = 'last_users_at') AS state_col,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('fb_upsert_users','fb_upsert_inventory'))                     AS fb_functions_c2,
  (SELECT count(*) FROM information_schema.views WHERE table_name = 'v_fb_recent_changes')                       AS view_ok;
-- Expected: inv_cols 3 · state_col 1 · fb_functions_c2 2 · view_ok 1
