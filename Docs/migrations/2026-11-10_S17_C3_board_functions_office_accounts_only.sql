-- ============================================================================
-- S17 C3 — kiosk-only accounts cannot run the Assembly Board's functions
-- 2026-11-10  ·  D-ASM-48
--
-- Matt, Nov 10: assemblers get the tablet and nothing else. The office app is
-- locked for them in the build (profiles.kiosk_only); this is the same rule on
-- the server, so it holds even if someone calls the functions directly.
-- A kiosk-only account is refused by: assembly_build_create, _assign,
-- _release, _cancel. The kiosk's own functions (start, clock in/out, sign-off,
-- closeout, avatar, PIN) are untouched. The assembly lead (assembly role, not
-- kiosk-only) and admins are unaffected.
--
-- Applied on TEST by Claude on 2026-11-10 (migration
-- s17_c3_board_functions_office_accounts_only). The four function bodies are
-- the B1 versions (checked against TEST by hash) plus one line each.
-- PROD ORDER: after C2a (it needs profiles.kiosk_only), before the Batch C deploy.
-- ============================================================================

-- Kiosk-only accounts (assemblers) may run the kiosk's functions and nothing that belongs to the office.
CREATE OR REPLACE FUNCTION public._office_account_only()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid AND kiosk_only) THEN
    RAISE EXCEPTION 'This account works on the assembly tablet only' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public._office_account_only() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.assembly_build_create(
  p_part_number text, p_quantity integer, p_build_kind text,
  p_priority text DEFAULT 'normal', p_request_ids uuid[] DEFAULT NULL,
  p_rework_source_lot text DEFAULT NULL, p_program_id uuid DEFAULT NULL, p_program_final_lot_id uuid DEFAULT NULL,
  p_work_order_assembly_id uuid DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  IF v_part.assembly_family IS NOT NULL THEN
    SELECT id INTO v_tpl FROM public.assembly_checklist_templates
     WHERE family_key = v_part.assembly_family AND wave = 1 AND status <> 'retired' ORDER BY (status = 'approved') DESC LIMIT 1;
    SELECT COALESCE(MAX(wave), 1) INTO v_waves FROM public.assembly_checklist_templates
     WHERE family_key = v_part.assembly_family AND status <> 'retired';
  END IF;
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
END $$;

CREATE OR REPLACE FUNCTION public.assembly_build_assign(p_build_id uuid, p_bench_id uuid DEFAULT NULL, p_profile_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  PERFORM public._office_account_only();
  UPDATE public.assembly_builds
     SET bench_id = COALESCE(p_bench_id, bench_id), assigned_to = p_profile_id, assigned_at = now(),
         status = CASE WHEN status = 'requested' THEN 'assigned' ELSE status END
   WHERE id = p_build_id AND status IN ('requested', 'assigned');
  IF NOT FOUND THEN RAISE EXCEPTION 'Build cannot be assigned in its current state'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.assembly_build_release(p_build_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.assembly_builds%ROWTYPE;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  PERFORM public._office_account_only();
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Unknown build'; END IF;
  IF b.status NOT IN ('complete', 'pending_tco') THEN RAISE EXCEPTION 'Only a completed build can be released (status %)', b.status; END IF;
  IF b.work_order_assembly_id IS NOT NULL AND b.status = 'pending_tco' THEN
    RAISE EXCEPTION 'This build closes through TCO, not release';
  END IF;
  UPDATE public.assembly_builds
     SET status = 'released', released_by = auth.uid(), released_at = now(),
         fb_post_status = CASE WHEN build_kind = 'program' THEN 'not_applicable' ELSE 'ready_to_post' END
   WHERE id = p_build_id;
  UPDATE public.assembly_requests SET status = 'built' WHERE build_id = p_build_id AND status = 'in_build';
END $$;

CREATE OR REPLACE FUNCTION public.assembly_build_cancel(p_build_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  PERFORM public._office_account_only();
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  UPDATE public.assembly_builds
     SET status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = btrim(p_reason)
   WHERE id = p_build_id AND status IN ('requested', 'assigned', 'paused');
  IF NOT FOUND THEN RAISE EXCEPTION 'Only a requested, assigned or paused build can be cancelled'; END IF;
  UPDATE public.assembly_requests SET status = 'open', build_id = NULL WHERE build_id = p_build_id AND status = 'in_build';
END $$;

-- Verify: expect 4.
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('assembly_build_create','assembly_build_assign','assembly_build_release','assembly_build_cancel')
  and p.prosrc like '%_office_account_only%';
