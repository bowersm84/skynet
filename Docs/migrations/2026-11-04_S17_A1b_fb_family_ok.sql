-- ============================================================================
-- S17 Batch A1b — fb_family_ok: clear a family's error entry on recovery
-- 2026-11-04  ·  companion to 2026-11-04_S17_A1_fb_pick_ship_post_tags_boms_mo.sql
--
-- Why: fb_family_error() records a failure for ANY guarded step, but only the
-- six new upsert RPCs clear their own entry. The sales-order tail, reconcile,
-- users, inventory, shipments (lots), purchasing and pricing readers have no
-- RPC of their own, so their entries would never clear. The bridge's guard now
-- calls this on every success.
--
-- Run on TEST now (before CC's re-run), on PROD together with the A1 migration.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fb_family_ok(p_family text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._fb_gate(ARRAY['integration','admin']);
  UPDATE public.fb_sync_state
     SET family_errors = family_errors - p_family
   WHERE id = 1 AND family_errors ? p_family;
END $$;
REVOKE ALL ON FUNCTION public.fb_family_ok(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fb_family_ok(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.fb_family_ok(text) TO authenticated, service_role;

COMMENT ON FUNCTION public.fb_family_ok(text) IS
  'Bridge 1.11: removes the family''s entry from fb_sync_state.family_errors after a successful run; a no-op when there is no entry.';
