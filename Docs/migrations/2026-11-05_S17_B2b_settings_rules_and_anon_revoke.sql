-- ============================================================================
-- S17 Batch B2b — app_setting_set with category / label / unit / sort_order
--                  (Add rule), and the anon revoke the B1/B2 functions missed
-- 2026-11-05  ·  D-ASM-34, D-ASM-36
--
-- Applied on TEST by Claude on 2026-11-04 (migrations
-- s17_b2b_settings_rules_and_anon_revoke, s17_b2b_public_revoke_remainder);
-- this file is the consolidated PROD copy. Run after B1 and B2, before the
-- Batch B + B2 deploy. Idempotent.
--
-- Why: Supabase's default privileges grant the anon role EXECUTE on every new
-- function, and _fb_gate passes a caller with no user id, so until this file
-- runs anyone holding the public anon key can call the assembly and settings
-- functions. Verified closed on TEST with the query at the bottom.
-- ============================================================================

-- 1. Settings: full-row set so the Costing rules tab can add a rule.
DROP FUNCTION IF EXISTS public.app_setting_set(text, jsonb, text);
CREATE OR REPLACE FUNCTION public.app_setting_set(
  p_key text, p_value jsonb, p_description text DEFAULT NULL,
  p_category text DEFAULT NULL, p_label text DEFAULT NULL, p_unit text DEFAULT NULL, p_sort_order integer DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._fb_gate(ARRAY['admin']);
  IF p_key IS NULL OR btrim(p_key) = '' OR p_key !~ '^[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Setting key must be lowercase letters, digits and underscores';
  END IF;
  INSERT INTO public.app_settings (key, value, description, category, label, unit, sort_order, updated_by, updated_at)
  VALUES (p_key, p_value, p_description, COALESCE(p_category, 'general'), p_label, p_unit, COALESCE(p_sort_order, 0), auth.uid(), now())
  ON CONFLICT (key) DO UPDATE SET
    value       = EXCLUDED.value,
    description = COALESCE(EXCLUDED.description, public.app_settings.description),
    category    = COALESCE(p_category, public.app_settings.category),
    label       = COALESCE(p_label, public.app_settings.label),
    unit        = COALESCE(p_unit, public.app_settings.unit),
    sort_order  = COALESCE(p_sort_order, public.app_settings.sort_order),
    updated_by  = EXCLUDED.updated_by, updated_at = now();
END $$;
REVOKE ALL ON FUNCTION public.app_setting_set(text, jsonb, text, text, text, text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.app_setting_set(text, jsonb, text, text, text, text, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.app_setting_set(text, jsonb, text, text, text, text, integer) TO authenticated, service_role;

-- 2. No anon EXECUTE on any SECURITY DEFINER function from this sprint.
REVOKE ALL ON FUNCTION public.assembly_build_create(text, integer, text, text, uuid[], text, uuid, uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembly_build_assign(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembly_build_release(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembly_build_cancel(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembly_lot_assign(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembly_lot_set_is_new(text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembly_request_sync(integer[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembly_seed_checklists_from_fishbowl() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembly_template_set(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembly_step_set(uuid, text, integer, numeric, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembly_part_set_family(text[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembly_instruction_step_type(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.profile_set_avatar(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_build_create(text, integer, text, text, uuid[], text, uuid, uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembly_build_assign(uuid, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembly_build_release(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembly_build_cancel(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembly_lot_assign(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembly_lot_set_is_new(text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembly_request_sync(integer[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembly_seed_checklists_from_fishbowl() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembly_template_set(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembly_step_set(uuid, text, integer, numeric, integer, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembly_part_set_family(text[], text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembly_instruction_step_type(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.profile_set_avatar(uuid, text, text) TO authenticated, service_role;

-- 3. Three older bridge upserts that carried EXECUTE through PUBLIC.
REVOKE ALL ON FUNCTION public.fb_upsert_customers(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fb_upsert_products(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fb_upsert_so_history(jsonb, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fb_upsert_customers(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fb_upsert_products(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fb_upsert_so_history(jsonb, timestamptz) TO authenticated, service_role;

-- 4. Views and tables from this sprint: no anon SELECT (RLS already denies rows; this closes the grant too).
REVOKE SELECT ON public.v_assemblers, public.v_assembly_builds_board, public.v_assembly_checklist_families, public.v_assembly_requests_open FROM anon;
REVOKE ALL ON public.assembly_bom, public.assembly_component_checkins, public.fb_customers, public.fb_group_retired,
              public.fb_part_costs, public.fb_products, public.fb_so_history_lines FROM anon;

-- 5. Future functions created by this role no longer grant anon EXECUTE by default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;

-- ---------------------------------------------------------------------------
-- Verification: expect no rows.
-- select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and (p.proname like 'assembly\_%' or p.proname in ('app_setting_set','profile_set_avatar') or p.proname like 'fb\_upsert\_%')
--   and p.prosecdef and pg_get_function_result(p.oid) <> 'trigger' and has_function_privilege('anon', p.oid, 'EXECUTE');
