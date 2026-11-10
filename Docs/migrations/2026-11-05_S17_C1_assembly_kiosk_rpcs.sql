-- ============================================================================
-- S17 Batch C1 — assembly kiosk: PIN resolution, components and lots, start,
--                 clock in / out, step sign-offs, closeout (lot + cost),
--                 the Giza move wrapper, kiosk and TV views
-- 2026-11-05  ·  D-ASM-02, -07, -08, -15, -17, -20, -21, -22
--
-- Applied on TEST by Claude on 2026-11-05 (migrations s17_c1_assembly_kiosk_rpcs,
-- s17_c1_program_move_nut_part, s17_c1_wave_templates,
-- s17_c1_program_move_follow_branch); this file is the consolidated PROD copy,
-- run before the Batch C deploy. Idempotent.
-- TEST run: stud build started with validated lots and a second PIN (new lot
-- set), four sign-offs, closeout → lot 80000, cost snapshot; a Giza program
-- build closed wave 1 (ledger move washer_inserted, 5 pcs, nylon lot 51853,
-- split branch followed) and was correctly refused at wave 2 by the tracker's
-- own "nothing baked yet" guard until plating and bake are logged.
--
-- Identity model: the kiosk JWT carries sub = profile id and role =
-- authenticated (audit §2.2), so auth.uid() is the signed-in assembler and
-- _fb_gate(ARRAY['admin','assembly']) gates every call. A second person never
-- signs in: their PIN is passed to the RPC and resolved server-side
-- (assembly_pin_resolve) — the client never sends a second person's id.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. PIN resolution (second person on a two-PIN step)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._assembly_pin_profile(p_pin text, p_roles text[])
RETURNS public.profiles LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v public.profiles%ROWTYPE; n integer;
BEGIN
  IF p_pin IS NULL OR length(btrim(p_pin)) < 4 THEN RAISE EXCEPTION 'PIN not recognized'; END IF;
  SELECT COUNT(*) INTO n FROM public.profiles WHERE pin_code = btrim(p_pin) AND is_active;
  IF n <> 1 THEN RAISE EXCEPTION 'PIN not recognized'; END IF;
  SELECT * INTO v FROM public.profiles WHERE pin_code = btrim(p_pin) AND is_active;
  IF NOT (v.role = ANY(p_roles) OR COALESCE(v.roles, '{}') && p_roles) THEN
    RAISE EXCEPTION 'PIN not recognized';
  END IF;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public._assembly_pin_profile(text, text[]) FROM PUBLIC, anon, authenticated;

-- Signed-in callers may look up a PIN to show the second person's name before confirming.
CREATE OR REPLACE FUNCTION public.assembly_pin_resolve(p_pin text)
RETURNS TABLE (profile_id uuid, full_name text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v public.profiles%ROWTYPE;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly','compliance']);
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
  v := public._assembly_pin_profile(p_pin, ARRAY['admin','assembly','compliance']);
  RETURN QUERY SELECT v.id, v.full_name::text;
END $$;
REVOKE ALL ON FUNCTION public.assembly_pin_resolve(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_pin_resolve(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Components of a build and the lots on hand for each (the tap list)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assembly_kiosk_components(p_build_id uuid)
RETURNS TABLE (component_part_number text, part_description text, qty_per_unit numeric, qty_needed numeric,
               wave integer, lots jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.assembly_builds%ROWTYPE;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Unknown build'; END IF;

  RETURN QUERY
  SELECT bi.part_num,
         bi.part_description,
         bi.quantity,
         (bi.quantity * b.quantity)::numeric,
         CASE WHEN b.build_kind = 'program' AND bi.part_description ILIKE '%nylon%' THEN 1
              WHEN b.build_kind = 'program' THEN 2 ELSE 1 END AS wave,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('tag_id', t.fb_tag_id, 'lot', t.lot_number, 'qty', t.qty,
                                                       'location', t.location, 'received', t.tag_created)
                                    ORDER BY t.tag_created)
                   FROM public.fb_tags t
                   WHERE t.part_num = bi.part_num AND t.removed_at IS NULL AND t.qty > 0 AND t.lot_number IS NOT NULL), '[]'::jsonb)
  FROM public.fb_boms fb
  JOIN public.fb_bom_items bi ON bi.fb_bom_id = fb.fb_bom_id AND bi.type_id = 20 AND COALESCE(bi.uom_id, 0) <> 4
  WHERE fb.bom_num = b.part_number AND fb.active AND fb.removed_at IS NULL
    -- program builds: the tracked nut itself is the program lot, not a pulled component
    AND NOT (b.build_kind = 'program' AND EXISTS (
          SELECT 1 FROM public.program_parts pp JOIN public.parts p ON p.id = pp.part_id
          WHERE pp.program_id = b.program_id AND pp.role = 'nut' AND p.part_number = bi.part_num))
  ORDER BY bi.sort_id, bi.part_num;
END $$;
REVOKE ALL ON FUNCTION public.assembly_kiosk_components(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_kiosk_components(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Sessions
-- ---------------------------------------------------------------------------
-- Close the caller's other open sessions (starting a build pauses the running one — Jody, Feb 13).
CREATE OR REPLACE FUNCTION public._assembly_pause_others(p_profile_id uuid, p_keep_build_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, build_id FROM public.assembly_sessions
           WHERE profile_id = p_profile_id AND clock_out IS NULL AND build_id <> p_keep_build_id LOOP
    UPDATE public.assembly_sessions SET clock_out = now(), pause_reason = COALESCE(pause_reason, 'switched build') WHERE id = r.id;
    UPDATE public.assembly_builds SET status = 'paused'
     WHERE id = r.build_id AND status = 'in_progress'
       AND NOT EXISTS (SELECT 1 FROM public.assembly_sessions s WHERE s.build_id = r.build_id AND s.clock_out IS NULL);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public._assembly_pause_others(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.assembly_session_clock_in(p_build_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); b public.assembly_builds%ROWTYPE; v_id uuid;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Unknown build'; END IF;
  IF b.status NOT IN ('in_progress', 'paused') THEN RAISE EXCEPTION 'Start this build first (status %)', b.status; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.assembly_component_lots WHERE build_id = p_build_id AND wave = b.wave_current) THEN
    RAISE EXCEPTION 'Pull the component lots before clocking in';
  END IF;
  PERFORM public._assembly_pause_others(v_uid, p_build_id);
  SELECT id INTO v_id FROM public.assembly_sessions WHERE build_id = p_build_id AND profile_id = v_uid AND clock_out IS NULL;
  IF v_id IS NULL THEN
    INSERT INTO public.assembly_sessions (build_id, wave, profile_id) VALUES (p_build_id, b.wave_current, v_uid) RETURNING id INTO v_id;
  END IF;
  UPDATE public.assembly_builds SET status = 'in_progress', assigned_to = COALESCE(assigned_to, v_uid) WHERE id = p_build_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.assembly_session_clock_in(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_session_clock_in(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.assembly_session_clock_out(p_build_id uuid, p_qty_done integer DEFAULT NULL, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
  UPDATE public.assembly_sessions SET clock_out = now(), qty_done = p_qty_done, pause_reason = NULLIF(btrim(p_reason), '')
   WHERE build_id = p_build_id AND profile_id = v_uid AND clock_out IS NULL;
  UPDATE public.assembly_builds SET status = 'paused'
   WHERE id = p_build_id AND status = 'in_progress'
     AND NOT EXISTS (SELECT 1 FROM public.assembly_sessions s WHERE s.build_id = p_build_id AND s.clock_out IS NULL);
END $$;
REVOKE ALL ON FUNCTION public.assembly_session_clock_out(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_session_clock_out(uuid, integer, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Start: lots validated against Fishbowl on hand, second PIN on a new set
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assembly_build_start(p_build_id uuid, p_lots jsonb, p_second_pin text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); b public.assembly_builds%ROWTYPE; c record; e jsonb; v_need numeric; v_have numeric;
  v_set jsonb := '[]'::jsonb; v_new boolean; v_second public.profiles%ROWTYPE; v_second_id uuid; v_session uuid;
  v_require_second boolean := COALESCE((SELECT (value)::boolean FROM public.app_settings WHERE key = 'assembly_lot_new_set_second_pin'), true);
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Unknown build'; END IF;
  IF b.status NOT IN ('requested', 'assigned', 'paused', 'in_progress') THEN
    RAISE EXCEPTION 'This build cannot be started (status %)', b.status;
  END IF;
  IF EXISTS (SELECT 1 FROM public.assembly_component_lots WHERE build_id = p_build_id AND wave = b.wave_current) THEN
    -- lots already pulled for this wave: this is a resume
    v_session := public.assembly_session_clock_in(p_build_id);
    RETURN jsonb_build_object('resumed', true, 'session_id', v_session);
  END IF;
  IF p_lots IS NULL OR jsonb_typeof(p_lots) <> 'array' OR jsonb_array_length(p_lots) = 0 THEN
    RAISE EXCEPTION 'Pull at least one lot for every component';
  END IF;

  -- Every component of this wave must be covered by lots that exist on hand for that part.
  FOR c IN SELECT * FROM public.assembly_kiosk_components(p_build_id) WHERE wave = b.wave_current LOOP
    v_need := c.qty_needed;
    SELECT COALESCE(SUM((x->>'qty')::numeric), 0) INTO v_have
    FROM jsonb_array_elements(p_lots) x WHERE x->>'part' = c.component_part_number;
    IF v_have <= 0 THEN RAISE EXCEPTION 'No lot pulled for %', c.component_part_number; END IF;
    IF v_have < v_need THEN
      RAISE EXCEPTION 'Lots pulled for % cover % of the % needed', c.component_part_number, v_have, v_need;
    END IF;
  END LOOP;

  FOR e IN SELECT x FROM jsonb_array_elements(p_lots) x LOOP
    IF NOT EXISTS (SELECT 1 FROM public.assembly_kiosk_components(p_build_id) k
                   WHERE k.component_part_number = e->>'part' AND k.wave = b.wave_current) THEN
      RAISE EXCEPTION '% is not a component of this build', e->>'part';
    END IF;
    SELECT COALESCE(SUM(t.qty), 0) INTO v_have FROM public.fb_tags t
     WHERE t.part_num = e->>'part' AND t.lot_number = e->>'lot' AND t.removed_at IS NULL AND t.qty > 0;
    IF v_have <= 0 THEN
      RAISE EXCEPTION 'Lot % is not on hand for % — check the bin and the lot number', e->>'lot', e->>'part';
    END IF;
    IF v_have < (e->>'qty')::numeric THEN
      RAISE EXCEPTION 'Lot % of % has % on hand, % pulled', e->>'lot', e->>'part', v_have, e->>'qty';
    END IF;
    v_set := v_set || jsonb_build_object('part', e->>'part', 'lot', e->>'lot');
  END LOOP;

  -- Second PIN when this combination of lots has never been built for this part (D-ASM-08).
  v_new := b.build_kind NOT IN ('program', 'rework') AND public.assembly_lot_set_is_new(b.part_number, v_set);
  IF v_new AND v_require_second THEN
    IF p_second_pin IS NULL THEN
      RAISE EXCEPTION 'NEW_LOT_SET: this combination of lots is new for % — a second person must check the pull', b.part_number;
    END IF;
    v_second := public._assembly_pin_profile(p_second_pin, ARRAY['admin','assembly','compliance']);
    IF v_second.id = v_uid THEN RAISE EXCEPTION 'The second check must be a different person'; END IF;
    v_second_id := v_second.id;
  END IF;

  INSERT INTO public.assembly_component_lots (build_id, wave, component_part_number, component_part_id, fb_tag_id, lot_number, qty, validated_qty, picked_by, second_pin_by)
  SELECT p_build_id, b.wave_current, x->>'part', (SELECT id FROM public.parts WHERE part_number = x->>'part' LIMIT 1),
         NULLIF(x->>'tag_id', '')::bigint, x->>'lot', (x->>'qty')::numeric,
         (SELECT COALESCE(SUM(t.qty), 0) FROM public.fb_tags t WHERE t.part_num = x->>'part' AND t.lot_number = x->>'lot' AND t.removed_at IS NULL),
         v_uid, v_second_id
  FROM jsonb_array_elements(p_lots) x
  ON CONFLICT (build_id, wave, component_part_number, lot_number) DO UPDATE SET qty = EXCLUDED.qty;

  UPDATE public.assembly_builds
     SET status = 'in_progress', started_at = COALESCE(started_at, now()), assigned_to = COALESCE(assigned_to, v_uid)
   WHERE id = p_build_id;
  PERFORM public._assembly_pause_others(v_uid, p_build_id);
  INSERT INTO public.assembly_sessions (build_id, wave, profile_id) VALUES (p_build_id, b.wave_current, v_uid) RETURNING id INTO v_session;

  RETURN jsonb_build_object('started', true, 'session_id', v_session, 'new_lot_set', v_new, 'second_check_by', v_second_id);
END $$;
REVOKE ALL ON FUNCTION public.assembly_build_start(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_build_start(uuid, jsonb, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4b. Which template governs the build's current wave (two-wave builds use the
--     family's wave-2 template for their second wave).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._assembly_template_for_wave(p_build_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
           WHEN b.wave_current = 2 THEN COALESCE(
             (SELECT t2.id FROM public.assembly_checklist_templates t2
               JOIN public.assembly_checklist_templates t1 ON t1.family_key = t2.family_key
              WHERE t1.id = b.checklist_template_id AND t2.wave = 2 AND t2.status <> 'retired' LIMIT 1),
             b.checklist_template_id)
           ELSE b.checklist_template_id
         END
  FROM public.assembly_builds b WHERE b.id = p_build_id;
$$;
REVOKE ALL ON FUNCTION public._assembly_template_for_wave(uuid) FROM PUBLIC, anon;
-- v_assembly_kiosk_builds runs with the caller's permissions and calls this to build `steps`,
-- so signed-in users must be able to execute it (it only returns a template id). (CC, 2026-11-10)
GRANT EXECUTE ON FUNCTION public._assembly_template_for_wave(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Step sign-off: n PINs resolved server-side, readings against the threshold
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assembly_step_signoff(p_build_id uuid, p_step_id uuid, p_pins text[], p_readings jsonb DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); b public.assembly_builds%ROWTYPE; s public.assembly_checklist_steps%ROWTYPE; v_tpl uuid;
  v_p1 public.profiles%ROWTYPE; v_p2 public.profiles%ROWTYPE; v_pin1 uuid; v_pin2 uuid;
  v_result text := 'pass'; v_min numeric; v_cnt integer;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Unknown build'; END IF;
  IF b.status NOT IN ('in_progress', 'paused') THEN RAISE EXCEPTION 'The build is not running'; END IF;
  v_tpl := public._assembly_template_for_wave(p_build_id);
  SELECT * INTO s FROM public.assembly_checklist_steps WHERE id = p_step_id;
  IF s.id IS NULL OR s.template_id IS DISTINCT FROM v_tpl THEN RAISE EXCEPTION 'That step is not on this build''s checklist'; END IF;
  IF s.pins_required = 0 THEN RAISE EXCEPTION 'This step needs no sign-off'; END IF;
  IF COALESCE(array_length(p_pins, 1), 0) < s.pins_required THEN
    RAISE EXCEPTION 'This step needs % PIN(s)', s.pins_required;
  END IF;

  v_p1 := public._assembly_pin_profile(p_pins[1], ARRAY['admin','assembly','compliance']);
  v_pin1 := v_p1.id;
  IF s.pins_required = 2 THEN
    v_p2 := public._assembly_pin_profile(p_pins[2], ARRAY['admin','assembly','compliance']);
    v_pin2 := v_p2.id;
    IF v_pin2 = v_pin1 THEN RAISE EXCEPTION 'Two different people must sign this step'; END IF;
  END IF;
  IF s.distinct_from IS NOT NULL AND b.assigned_to IS NOT NULL AND v_pin1 = b.assigned_to THEN
    RAISE EXCEPTION 'The first signer on "%" must not be the assembler', s.label;
  END IF;

  IF s.readings_count > 0 THEN
    v_cnt := CASE WHEN p_readings IS NULL OR jsonb_typeof(p_readings) <> 'array' THEN 0 ELSE jsonb_array_length(p_readings) END;
    IF v_cnt < s.readings_count THEN RAISE EXCEPTION '"%" needs % reading(s)', s.label, s.readings_count; END IF;
    IF s.threshold_min IS NOT NULL THEN
      SELECT MIN((x)::text::numeric) INTO v_min FROM jsonb_array_elements(p_readings) x;
      IF v_min < s.threshold_min THEN v_result := 'fail'; END IF;
    END IF;
  END IF;

  INSERT INTO public.assembly_step_signoffs (build_id, wave, step_id, pin_1, pin_2, readings, result, note, signed_at)
  VALUES (p_build_id, b.wave_current, p_step_id, v_pin1, v_pin2, p_readings, v_result, NULLIF(btrim(p_note), ''), now())
  ON CONFLICT (build_id, wave, step_id) DO UPDATE SET
    pin_1 = EXCLUDED.pin_1, pin_2 = EXCLUDED.pin_2, readings = EXCLUDED.readings, result = EXCLUDED.result,
    note = EXCLUDED.note, signed_at = now();

  RETURN jsonb_build_object('result', v_result, 'step', s.label, 'threshold_min', s.threshold_min, 'min_reading', v_min,
                            'signed_by', jsonb_build_array(v_p1.full_name, v_p2.full_name));
END $$;
REVOKE ALL ON FUNCTION public.assembly_step_signoff(uuid, uuid, text[], jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_step_signoff(uuid, uuid, text[], jsonb, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Giza two-wave moves through a gated wrapper (D-ASM-22)
--    _program_gate keeps its roles; it also honours a transaction-local flag
--    that only this wrapper sets, after its own gate and stage check.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._program_gate(p_roles text[] DEFAULT ARRAY['admin'::text, 'order_processor'::text])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  IF current_setting('skynet.assembly_program_move', true) = '1' THEN RETURN; END IF;
  IF NOT public.user_has_role(v_uid, VARIADIC p_roles) THEN
    RAISE EXCEPTION 'Not authorized: requires one of %', array_to_string(p_roles, ', ') USING ERRCODE = '42501';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.assembly_log_program_move(p_build_id uuid, p_stage text, p_qty integer, p_done_by text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.assembly_builds%ROWTYPE; v_nut uuid; v_insert text; v_cage text; v_retainer text; v_out jsonb; v_dest uuid;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','order_processor','assembly']);
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id;
  IF b.id IS NULL OR b.build_kind <> 'program' OR b.program_id IS NULL OR b.program_final_lot_id IS NULL THEN
    RAISE EXCEPTION 'Not a program build';
  END IF;
  IF p_stage NOT IN ('washer_inserted', 'assembled') THEN RAISE EXCEPTION 'The kiosk logs washer_inserted or assembled only'; END IF;
  SELECT part_id INTO v_nut FROM public.program_parts WHERE program_id = b.program_id AND role = 'nut' LIMIT 1;
  IF v_nut IS NULL THEN RAISE EXCEPTION 'The program has no tracked nut part'; END IF;

  SELECT lot_number INTO v_insert FROM public.assembly_component_lots
   WHERE build_id = p_build_id AND wave = 1 ORDER BY picked_at LIMIT 1;
  -- cage and retainer lots by the component's Fishbowl description (SK21077-5-4 Steel Cage, SK21077-5-1 Steel Retainer)
  SELECT MAX(CASE WHEN d.part_description ILIKE '%cage%' THEN cl.lot_number END),
         MAX(CASE WHEN d.part_description ILIKE '%retain%' THEN cl.lot_number END)
    INTO v_cage, v_retainer
    FROM public.assembly_component_lots cl
    LEFT JOIN LATERAL (SELECT bi.part_description FROM public.fb_bom_items bi WHERE bi.part_num = cl.component_part_number LIMIT 1) d ON true
   WHERE cl.build_id = p_build_id AND cl.wave = 2;

  PERFORM set_config('skynet.assembly_program_move', '1', true);
  v_out := public.program_log_entry(
    b.program_id, v_nut, p_stage, p_qty,
    CASE WHEN p_stage = 'washer_inserted' THEN v_insert ELSE NULL END,
    b.program_final_lot_id,
    CASE WHEN p_stage = 'assembled' THEN v_cage ELSE NULL END,
    CASE WHEN p_stage = 'assembled' THEN v_retainer ELSE NULL END,
    NULL, NULL, NULL, CURRENT_DATE, p_done_by, 'assembly kiosk ' || b.build_number);
  PERFORM set_config('skynet.assembly_program_move', '0', true);

  -- follow the lot the tracker routed the pieces to (a split makes a new branch, D-GIZA-22)
  v_dest := NULLIF(v_out->>'lot_id', '')::uuid;
  IF v_dest IS NOT NULL AND v_dest <> b.program_final_lot_id THEN
    UPDATE public.assembly_builds SET program_final_lot_id = v_dest WHERE id = p_build_id;
  END IF;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.assembly_log_program_move(uuid, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_log_program_move(uuid, text, integer, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Closeout: required steps passed, good / bad, lot number, cost snapshot,
--    program waves
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assembly_build_closeout(p_build_id uuid, p_good integer, p_bad integer DEFAULT 0, p_inspector_pin text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); b public.assembly_builds%ROWTYPE; v_tpl uuid; v_missing text; v_lot text; v_minutes numeric;
  v_rate numeric; v_ovh numeric; v_comp numeric; v_labor numeric; v_conv numeric; v_done_by text; v_insp record;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Unknown build'; END IF;
  IF b.status NOT IN ('in_progress', 'paused') THEN RAISE EXCEPTION 'The build is not running (status %)', b.status; END IF;
  IF p_good IS NULL OR p_good < 0 OR COALESCE(p_bad, 0) < 0 OR p_good + COALESCE(p_bad, 0) = 0 THEN RAISE EXCEPTION 'Enter the good and bad counts'; END IF;
  IF p_good + COALESCE(p_bad, 0) > b.quantity THEN RAISE EXCEPTION 'Good + bad (%) exceeds the build quantity (%)', p_good + COALESCE(p_bad, 0), b.quantity; END IF;
  v_tpl := public._assembly_template_for_wave(p_build_id);

  -- An inspector PIN given here signs a one-PIN inspect step if it is still open.
  IF p_inspector_pin IS NOT NULL THEN
    SELECT s.id, s.label INTO v_insp FROM public.assembly_checklist_steps s
     WHERE s.template_id = v_tpl AND s.step_type = 'inspect' AND s.pins_required = 1
       AND NOT EXISTS (SELECT 1 FROM public.assembly_step_signoffs so WHERE so.build_id = p_build_id AND so.wave = b.wave_current AND so.step_id = s.id AND so.result = 'pass')
     ORDER BY s.step_order LIMIT 1;
    IF v_insp.id IS NOT NULL THEN
      PERFORM public.assembly_step_signoff(p_build_id, v_insp.id, ARRAY[p_inspector_pin], NULL, 'closeout');
    END IF;
  END IF;

  -- Every PIN step of this wave must carry a passing sign-off (release is Jody's board, not the kiosk).
  SELECT string_agg(s.label, ', ' ORDER BY s.step_order) INTO v_missing
  FROM public.assembly_checklist_steps s
  WHERE s.template_id = v_tpl AND s.pins_required > 0 AND s.step_type <> 'release'
    AND NOT EXISTS (SELECT 1 FROM public.assembly_step_signoffs so
                    WHERE so.build_id = p_build_id AND so.wave = b.wave_current AND so.step_id = s.id AND so.result = 'pass');
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'Sign off first: %', v_missing; END IF;

  -- Close every open session on the build.
  UPDATE public.assembly_sessions SET clock_out = now(), pause_reason = COALESCE(pause_reason, 'closeout')
   WHERE build_id = p_build_id AND clock_out IS NULL;

  SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (clock_out - clock_in)) / 60), 0) INTO v_minutes FROM public.assembly_sessions WHERE build_id = p_build_id;
  SELECT COALESCE(string_agg(DISTINCT upper(left(coalesce(pr.full_name, pr.username), 1) || COALESCE(substring(pr.full_name FROM ' (\S)'), '')), '/'), '')
    INTO v_done_by FROM public.assembly_sessions s JOIN public.profiles pr ON pr.id = s.profile_id WHERE s.build_id = p_build_id;

  IF b.build_kind = 'program' AND b.wave_current = 1 THEN
    PERFORM public.assembly_log_program_move(p_build_id, 'washer_inserted', p_good, v_done_by);
    UPDATE public.assembly_builds
       SET good_quantity = p_good, bad_quantity = COALESCE(p_bad, 0), wave_current = 2, status = 'assigned',
           note = COALESCE(note || E'\n', '') || 'Wave 1 (insert nylon) closed ' || now()::date || '; awaiting dry film and bake'
     WHERE id = p_build_id;
    RETURN jsonb_build_object('closed_wave', 1, 'next', 'dry film and bake, then wave 2', 'good', p_good, 'bad', COALESCE(p_bad, 0));
  END IF;

  IF b.build_kind = 'program' THEN
    PERFORM public.assembly_log_program_move(p_build_id, 'assembled', p_good, v_done_by);
    v_lot := NULL;
  ELSE
    v_lot := public.assembly_lot_assign(p_build_id);
  END IF;

  UPDATE public.assembly_builds
     SET status = 'complete', good_quantity = p_good, bad_quantity = COALESCE(p_bad, 0), completed_at = now()
   WHERE id = p_build_id;

  -- Cost snapshot (D-ASM-15): labor from real minutes, components from Fishbowl standard cost
  -- (or the Armory unit cost), overhead on conversion. Batch D refreshes component cost from the posted WO.
  SELECT COALESCE((value)::numeric, 0) INTO v_rate FROM public.app_settings WHERE key = 'assembly_labor_rate';
  SELECT COALESCE((value)::numeric, 0) INTO v_ovh  FROM public.app_settings WHERE key = 'mfg_support_overhead_pct';
  SELECT COALESCE(SUM(k.qty_per_unit * COALESCE(NULLIF(c.std_cost, 0), p.unit_cost, 0)), 0) INTO v_comp
  FROM public.assembly_kiosk_components(p_build_id) k
  LEFT JOIN public.fb_part_costs c ON c.part_num = k.component_part_number
  LEFT JOIN public.parts p ON p.part_number = k.component_part_number;
  v_labor := CASE WHEN p_good > 0 THEN (v_minutes / 60.0) * v_rate / p_good ELSE 0 END;
  v_conv  := v_labor;
  INSERT INTO public.assembly_build_costs (build_id, good_qty, minutes_total, minutes_per_unit, labor_rate, labor_cost_unit,
                                           component_cost_unit, overhead_pct, overhead_unit, model_cost_unit, basis_note, computed_at)
  VALUES (p_build_id, p_good, round(v_minutes, 1), CASE WHEN p_good > 0 THEN round(v_minutes / p_good, 3) ELSE NULL END,
          v_rate, round(v_labor, 4), round(v_comp, 4), v_ovh, round(v_conv * v_ovh / 100.0, 4),
          round(v_comp + v_labor + v_conv * v_ovh / 100.0, 4),
          'labor: session minutes × app_settings.assembly_labor_rate; components: fb_part_costs.std_cost else parts.unit_cost; overhead on conversion; pending Batch D read-back',
          now())
  ON CONFLICT (build_id) DO UPDATE SET good_qty = EXCLUDED.good_qty, minutes_total = EXCLUDED.minutes_total,
    minutes_per_unit = EXCLUDED.minutes_per_unit, labor_rate = EXCLUDED.labor_rate, labor_cost_unit = EXCLUDED.labor_cost_unit,
    component_cost_unit = EXCLUDED.component_cost_unit, overhead_pct = EXCLUDED.overhead_pct, overhead_unit = EXCLUDED.overhead_unit,
    model_cost_unit = EXCLUDED.model_cost_unit, basis_note = EXCLUDED.basis_note, computed_at = now();

  RETURN jsonb_build_object('closed', true, 'lot', v_lot, 'good', p_good, 'bad', COALESCE(p_bad, 0), 'minutes', round(v_minutes, 1));
END $$;
REVOKE ALL ON FUNCTION public.assembly_build_closeout(uuid, integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_build_closeout(uuid, integer, integer, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Views for the kiosk and the TV
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_assembly_kiosk_builds WITH (security_invoker = true) AS
SELECT b.id, b.build_number, b.part_number, p.description AS part_description, b.quantity, b.build_kind, b.status, b.priority,
       b.wave_count, b.wave_current, b.assigned_to, pa.full_name AS assigned_name, pa.avatar_icon AS assigned_avatar_icon, pa.avatar_color AS assigned_avatar_color,
       b.checklist_template_id, t.name AS template_name, t.status AS template_status,
       b.assembly_lot_number, b.rework_source_lot, b.program_id, b.note, b.created_at, b.started_at,
       (SELECT MIN(r.due_date) FROM public.assembly_requests r WHERE r.build_id = b.id) AS earliest_due,
       EXISTS (SELECT 1 FROM public.assembly_component_lots cl WHERE cl.build_id = b.id AND cl.wave = b.wave_current) AS lots_pulled,
       (SELECT COUNT(*)::int FROM public.assembly_sessions s WHERE s.build_id = b.id AND s.clock_out IS NULL) AS open_sessions,
       (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(s.clock_out, now()) - s.clock_in)) / 60), 0)::numeric(10,1)
          FROM public.assembly_sessions s WHERE s.build_id = b.id) AS minutes_total,
       (SELECT jsonb_agg(jsonb_build_object('step_id', s.id, 'order', s.step_order, 'type', s.step_type, 'label', s.label,
                                            'pins', s.pins_required, 'readings', s.readings_count, 'unit', s.reading_unit,
                                            'threshold', s.threshold_min, 'sample', s.sample_qty, 'text', s.instruction_text,
                                            'signed', so.id IS NOT NULL, 'result', so.result, 'signed_at', so.signed_at)
                         ORDER BY s.step_order)
          FROM public.assembly_checklist_steps s
          LEFT JOIN public.assembly_step_signoffs so ON so.step_id = s.id AND so.build_id = b.id AND so.wave = b.wave_current
          WHERE s.template_id = public._assembly_template_for_wave(b.id)) AS steps
FROM public.assembly_builds b
LEFT JOIN public.parts p ON p.id = b.part_id
LEFT JOIN public.profiles pa ON pa.id = b.assigned_to
LEFT JOIN public.assembly_checklist_templates t ON t.id = b.checklist_template_id
WHERE b.status IN ('requested', 'assigned', 'in_progress', 'paused');
GRANT SELECT ON public.v_assembly_kiosk_builds TO authenticated;
REVOKE ALL ON public.v_assembly_kiosk_builds FROM anon;

CREATE OR REPLACE VIEW public.v_assembly_tv WITH (security_invoker = true) AS
SELECT b.id, b.build_number, b.part_number, b.quantity, b.status, b.priority, b.build_kind, b.wave_current, b.wave_count,
       pa.full_name AS assigned_name, pa.avatar_icon, pa.avatar_color,
       (SELECT MIN(r.due_date) FROM public.assembly_requests r WHERE r.build_id = b.id) AS earliest_due,
       (SELECT MIN(r.due_date) FROM public.assembly_requests r WHERE r.build_id = b.id) < CURRENT_DATE AS late,
       (SELECT COUNT(*)::int FROM public.assembly_sessions s WHERE s.build_id = b.id AND s.clock_out IS NULL) AS open_sessions,
       b.started_at, b.completed_at, b.assembly_lot_number
FROM public.assembly_builds b
LEFT JOIN public.profiles pa ON pa.id = b.assigned_to
WHERE b.status IN ('requested', 'assigned', 'in_progress', 'paused', 'complete')
   OR (b.status = 'released' AND b.released_at > now() - interval '24 hours');
GRANT SELECT ON public.v_assembly_tv TO authenticated;
REVOKE ALL ON public.v_assembly_tv FROM anon;

-- ---------------------------------------------------------------------------
-- 9. Giza family: the seeded single template becomes the two waves of the
--    MS21077-5 traveler (wave 1 insert nylon; wave 2 final assembly into cage)
-- ---------------------------------------------------------------------------
DO $giza$
DECLARE t1 uuid; t2 uuid; fam text;
BEGIN
  SELECT family_key, id INTO fam, t1 FROM public.assembly_checklist_templates
   WHERE family_key = 'pull_check>crimp_check>gauge_check' AND wave = 1 LIMIT 1;
  IF t1 IS NULL THEN RETURN; END IF;
  UPDATE public.assembly_checklist_templates SET name = 'Giza nut plate — wave 1: insert nylon' WHERE id = t1;
  DELETE FROM public.assembly_checklist_steps WHERE template_id = t1;
  INSERT INTO public.assembly_checklist_steps (template_id, step_order, step_type, label, pins_required, distinct_from, instruction_text)
  VALUES (t1, 1, 'instruction', 'Nylon washer flat side up in the plate nut', 0, NULL, 'NYLON WASHER FLAT SIDE UP IN PLATE NUT'),
         (t1, 2, 'pull_check', 'Insert check (checked by 1 / 2)', 2, 'puller', NULL);
  SELECT id INTO t2 FROM public.assembly_checklist_templates WHERE family_key = fam AND wave = 2;
  IF t2 IS NULL THEN
    INSERT INTO public.assembly_checklist_templates (family_key, wave, name, status, source, seed_note)
    VALUES (fam, 2, 'Giza nut plate — wave 2: final assembly into cage', 'draft', 'seed', 'Split from the single seeded template, 2026-11-05 (MS21077-5 traveler)')
    RETURNING id INTO t2;
    INSERT INTO public.assembly_checklist_steps (template_id, step_order, step_type, label, pins_required, distinct_from, sample_qty)
    VALUES (t2, 1, 'crimp_check', 'Crimp 10 pieces and have checked (1st / 2nd)', 2, 'crimper', 10),
           (t2, 2, 'gauge_check', 'Check 25 pieces in each bag with bolt (1 / 2)', 2, NULL, 25),
           (t2, 3, 'pull_check', 'Checked by', 1, 'puller', NULL);
  END IF;
END
$giza$;
