-- ============================================================================
-- S17 D1c — the MO mirror learns that an MO the bridge deleted is gone
-- 2026-11-11  ·  D-ASM-57
--
-- Why: fb_upsert_manufacture_orders can only add or refresh an MO (it sets
-- removed_at back to NULL), and the audit tail re-reads a deleted MO, finds
-- nothing and sends nothing — so an MO deleted in Fishbowl stays in the mirror
-- as last seen (PROD still shows the three probe MOs as Issued or Entered; no
-- MO has ever been marked removed). This adds the narrow fix only: bridge 1.12
-- calls fb_mark_mos_removed after a successful mo_cancel, for the MO it just
-- deleted. The general case (an MO deleted by hand in Fishbowl) is not fixed
-- here.
--
-- What it does, for each MO id given: drops its work orders, their items and
-- consumed lots, and its MO items (Fishbowl deleted them all with the MO), and
-- stamps removed_at. The read-back and the post cards already ignore an MO with
-- removed_at set.
--
-- Written by CC 2026-11-11 for Claude to apply on TEST. Bridge 1.12 degrades
-- without it: the call fails as "missing", is logged, and the command still
-- finishes done (the MO is gone from Fishbowl either way).
-- PROD: with Batch D, after 2026-11-11_S17_D1_fishbowl_mo_posting.sql. Not yet.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fb_mark_mos_removed(p_mo_ids integer[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE n integer := 0; wo_ids integer[];
BEGIN
  PERFORM public._fb_gate(ARRAY['integration','admin']);
  IF p_mo_ids IS NULL OR cardinality(p_mo_ids) = 0 THEN RETURN 0; END IF;
  SELECT array_agg(fb_wo_id) INTO wo_ids FROM public.fb_work_orders WHERE fb_mo_id = ANY(p_mo_ids);
  IF wo_ids IS NOT NULL THEN
    DELETE FROM public.fb_wo_consumed_lots WHERE fb_wo_id = ANY(wo_ids);
    DELETE FROM public.fb_wo_items         WHERE fb_wo_id = ANY(wo_ids);
    DELETE FROM public.fb_work_orders      WHERE fb_wo_id = ANY(wo_ids);
  END IF;
  DELETE FROM public.fb_mo_items WHERE fb_mo_id = ANY(p_mo_ids);
  UPDATE public.fb_manufacture_orders SET removed_at = now(), mirrored_at = now()
   WHERE fb_mo_id = ANY(p_mo_ids) AND removed_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.fb_mark_mos_removed(integer[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fb_mark_mos_removed(integer[]) TO authenticated, service_role;

-- Verify: the function exists and is gated (expect one row, prosecdef true).
SELECT p.proname, p.prosecdef, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'fb_mark_mos_removed';
