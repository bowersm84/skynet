-- ============================================================================
-- S17 D1b — two rules found during Batch D1 (CC's report, 2026-11-11)
-- D-ASM-56
--
-- 1. No build without an approved checklist. Enforces D-ASM-07 in the
--    database: a build created for a part whose checklist family had been
--    retired got no checklist at all, and the tablet would have let it close
--    with no sign-offs. Now:
--      · assembly_build_create refuses, in a plain sentence, a part SkyNet does
--        not know, a part with no checklist family, and a family whose
--        checklist is not approved;
--      · the tablet refuses to start or close out a build that has no
--        checklist for its current wave.
-- 2. The pricing queue's Cancel (fb_push_cancel) refuses a command that
--    belongs to an assembly build. It would have withdrawn a queued MO request
--    and left the build showing "queued" for ever.
--
-- Applied on TEST by Claude on 2026-11-11 (migration
-- s17_d1b_checklist_required_and_queue_cancel) and probed there in a
-- rolled-back block: the test assembly still builds and queues its MO; the
-- pricing Cancel is refused on that command; an unknown part and a part with
-- no checklist family are refused; the tablet refuses a build with no checklist.
--
-- PROD: with Batch D, after 2026-11-11_S17_D1_fishbowl_mo_posting.sql. Not yet.
-- Note for cutover: every assembly part needs an APPROVED checklist family
-- before it can be built. On TEST 135 of 298 active assembly parts have none.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.assembly_build_create(p_part_number text, p_quantity integer, p_build_kind text, p_priority text DEFAULT 'normal'::text, p_request_ids uuid[] DEFAULT NULL::uuid[], p_rework_source_lot text DEFAULT NULL::text, p_program_id uuid DEFAULT NULL::uuid, p_program_final_lot_id uuid DEFAULT NULL::uuid, p_work_order_assembly_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid(); v_part public.parts%ROWTYPE; v_tpl uuid; v_waves integer := 1; v_id uuid;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  PERFORM public._office_account_only();
  IF p_part_number IS NULL OR btrim(p_part_number) = '' THEN RAISE EXCEPTION 'Part number is required'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'Quantity must be greater than zero'; END IF;
  IF p_build_kind NOT IN ('order','stock','special','rework','program') THEN RAISE EXCEPTION 'Unknown build kind %', p_build_kind; END IF;
  IF p_build_kind = 'rework' AND (p_rework_source_lot IS NULL OR btrim(p_rework_source_lot) = '') THEN
    RAISE EXCEPTION 'A rework build needs the source lot number';
  END IF;

  SELECT * INTO v_part FROM public.parts WHERE part_number = btrim(p_part_number) LIMIT 1;

  -- D-ASM-56: no build without an approved checklist.
  IF v_part.id IS NULL THEN
    RAISE EXCEPTION '% is not set up in SkyNet. Add it in the Armory as an assembly and give it a checklist family before building it.', btrim(p_part_number);
  END IF;
  IF v_part.assembly_family IS NULL THEN
    RAISE EXCEPTION '% has no checklist family. Assign it to one in Armory, Checklists, before building it.', v_part.part_number;
  END IF;
  SELECT id INTO v_tpl FROM public.assembly_checklist_templates
   WHERE family_key = v_part.assembly_family AND wave = 1 AND status = 'approved' LIMIT 1;
  IF v_tpl IS NULL THEN
    RAISE EXCEPTION 'The checklist for % is not approved yet. It has to be approved in Armory, Checklists, before this part can be built.', v_part.part_number;
  END IF;
  SELECT COALESCE(MAX(wave), 1) INTO v_waves FROM public.assembly_checklist_templates
   WHERE family_key = v_part.assembly_family AND status = 'approved';
  IF p_build_kind = 'program' THEN v_waves := 2; END IF;

  INSERT INTO public.assembly_builds
    (part_id, part_number, quantity, build_kind, priority, wave_count, work_order_assembly_id,
     program_id, program_final_lot_id, checklist_template_id, rework_source_lot,
     fb_post_status, note, created_by)
  VALUES
    (v_part.id, btrim(p_part_number), p_quantity, p_build_kind, COALESCE(NULLIF(p_priority,''), 'normal'), v_waves, p_work_order_assembly_id,
     p_program_id, p_program_final_lot_id, v_tpl, NULLIF(btrim(p_rework_source_lot), ''),
     CASE WHEN p_build_kind = 'program' THEN 'not_applicable' ELSE 'not_posted' END, p_note, v_uid)
  RETURNING id INTO v_id;

  IF p_request_ids IS NOT NULL THEN
    UPDATE public.assembly_requests SET status = 'in_build', build_id = v_id
     WHERE id = ANY(p_request_ids) AND status = 'open';
  END IF;
  RETURN v_id;
END $function$;

-- The tablet: a build with no checklist for its current wave cannot be started or closed.
-- (Patches the two functions in place, so whatever version is installed keeps the rest of its body.)
DO $patch$
DECLARE d text; a text; n text;
BEGIN
  d := replace(pg_get_functiondef('public.assembly_build_start(uuid, jsonb, text)'::regprocedure), E'\r', '');
  a := E'    RAISE EXCEPTION ''This build cannot be started (status %)'', b.status;\n  END IF;\n';
  n := a || E'  IF public._assembly_template_for_wave(p_build_id) IS NULL THEN\n    RAISE EXCEPTION ''This build has no checklist, so it cannot be started. Tell the assembly lead.'';\n  END IF;\n';
  IF position('has no checklist' in d) = 0 THEN
    IF position(a in d) = 0 THEN RAISE EXCEPTION 'assembly_build_start: anchor not found'; END IF;
    EXECUTE replace(d, a, n);
  END IF;

  d := replace(pg_get_functiondef('public.assembly_build_closeout(uuid, integer, integer, text)'::regprocedure), E'\r', '');
  a := E'  v_tpl := public._assembly_template_for_wave(p_build_id);\n';
  n := a || E'  IF v_tpl IS NULL THEN\n    RAISE EXCEPTION ''This build has no checklist, so it cannot be closed out. Tell the assembly lead.'';\n  END IF;\n';
  IF position('has no checklist' in d) = 0 THEN
    IF position(a in d) = 0 THEN RAISE EXCEPTION 'assembly_build_closeout: anchor not found'; END IF;
    EXECUTE replace(d, a, n);
  END IF;
END
$patch$;

-- The pricing queue's Cancel is for pricing commands only.
CREATE OR REPLACE FUNCTION public.fb_push_cancel(p_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._pricing_gate(public._pricing_edit_roles());
  IF EXISTS (SELECT 1 FROM public.fb_push_commands WHERE id = p_id AND kind NOT IN ('prices', 'rules', 'tree', 'groups')) THEN
    RAISE EXCEPTION 'Command % belongs to an assembly build. Cancel the build, or link an MO, from the Assembly Board.', p_id;
  END IF;
  UPDATE public.fb_push_commands SET status = 'cancelled', finished_at = now() WHERE id = p_id AND status = 'queued';
  IF NOT FOUND THEN RAISE EXCEPTION 'fb_push_cancel: command % is not queued', p_id; END IF;
END $function$;
