-- ============================================================================
-- S17 C2a — the PIN vault (additive; safe to run before the new build)
-- 2026-11-10  ·  D-ASM-43, D-ASM-44
--
-- Why: profiles.pin_code is plain text and readable by every signed-in user
-- (and, until C0b, by the public anon key). The kiosk's two-person checks
-- assume a PIN proves a second person. This migration moves PINs into a table
-- that no browser role can read, hashes them, counts failed attempts, and puts
-- every lookup and every change behind a function.
--
-- ADDITIVE: the old column keeps working. Until the new build is live, a
-- transitional trigger mirrors any change of profiles.pin_code into the vault.
-- C2b (run AFTER the new build is live and confirmed) drops the old column,
-- the trigger and the open write policies on profiles.
--
-- Applied on TEST by Claude on 2026-11-10 (migrations s17_c2a_pin_vault,
-- s17_c2a_pin_resolve_text_cast, s17_c2a_assembly_pin_resolve_volatile,
-- s17_c2a_pin_misses_return_not_raise, s17_c2a_pin_authenticate_operator_fields,
-- s17_c2a_pin_throttle_device_and_address).
-- This file is the consolidated PROD copy; every function body below was checked
-- against TEST's live definition by hash.
-- PROD ORDER: C1 (kiosk functions) first, then this file, both before the Batch C deploy.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Flags on profiles (readable; they replace every "do I have a PIN?" read)
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS has_pin          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS must_change_pin  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS kiosk_only       boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.profiles.has_pin IS 'Maintained by the PIN vault: true when a PIN is on file. The PIN itself is never readable.';
COMMENT ON COLUMN public.profiles.must_change_pin IS 'True after an admin sets a temporary PIN; the kiosk forces a new PIN at the next sign-in.';
COMMENT ON COLUMN public.profiles.kiosk_only IS 'Account with no office login (no real email, random password nobody holds) — e.g. assemblers.';

-- ---------------------------------------------------------------------------
-- 2. The vault and the attempt log — no browser role can read either
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profile_pins (
  profile_id    uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  pin_hash      text NOT NULL,
  is_temporary  boolean NOT NULL DEFAULT false,
  set_by        uuid,
  set_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.pin_attempts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  context       text NOT NULL,              -- kiosk_sign_in | resolve | set | admin_set
  throttle_key  text NOT NULL,              -- ip:<addr>|dev:<device> (kiosk sign-in) | uid:<profile id>
  scope_key     text,                       -- ip:<addr> — the wider bucket for kiosk sign-in
  actor         uuid,
  success       boolean NOT NULL,
  note          text
);
CREATE INDEX IF NOT EXISTS pin_attempts_key_idx ON public.pin_attempts (throttle_key, at DESC);
ALTER TABLE public.pin_attempts ADD COLUMN IF NOT EXISTS scope_key text;
CREATE INDEX IF NOT EXISTS pin_attempts_scope_idx ON public.pin_attempts (scope_key, at DESC) WHERE scope_key IS NOT NULL;

ALTER TABLE public.profile_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pin_attempts ENABLE ROW LEVEL SECURITY;
-- An explicit deny policy (the RLS guardrail requires a policy; nothing may read these from a browser).
DROP POLICY IF EXISTS profile_pins_no_client_access ON public.profile_pins;
CREATE POLICY profile_pins_no_client_access ON public.profile_pins FOR ALL TO authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS pin_attempts_no_client_access ON public.pin_attempts;
CREATE POLICY pin_attempts_no_client_access ON public.pin_attempts FOR ALL TO authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON public.profile_pins, public.pin_attempts FROM PUBLIC, anon, authenticated;

-- has_pin follows the vault.
CREATE OR REPLACE FUNCTION public._profile_pins_flag_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.profiles SET has_pin = false, must_change_pin = false WHERE id = OLD.profile_id;
    RETURN OLD;
  END IF;
  UPDATE public.profiles SET has_pin = true, must_change_pin = NEW.is_temporary WHERE id = NEW.profile_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS profile_pins_flag ON public.profile_pins;
CREATE TRIGGER profile_pins_flag AFTER INSERT OR UPDATE OR DELETE ON public.profile_pins
  FOR EACH ROW EXECUTE FUNCTION public._profile_pins_flag_trg();

-- ---------------------------------------------------------------------------
-- 3. Internals: format, throttle, lookup
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._pin_format_ok(p_pin text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT p_pin IS NOT NULL AND p_pin ~ '^[0-9]{4,6}$' $$;

-- Five misses in ten minutes on one key locks that key until the oldest of those five is ten minutes old.
CREATE OR REPLACE FUNCTION public._pin_throttle_wait_seconds(p_key text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN COUNT(*) >= 5
              THEN GREATEST(0, CEIL(EXTRACT(EPOCH FROM (MIN(at) + interval '10 minutes' - now()))))::integer
              ELSE 0 END
  FROM (SELECT at FROM public.pin_attempts
        WHERE throttle_key = p_key AND NOT success AND at > now() - interval '10 minutes'
        ORDER BY at DESC LIMIT 5) recent;
$$;

CREATE OR REPLACE FUNCTION public._pin_attempt_log(p_key text, p_context text, p_success boolean, p_actor uuid, p_note text DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.pin_attempts (context, throttle_key, actor, success, note) VALUES (p_context, p_key, p_actor, p_success, p_note);
$$;

-- The one place a typed PIN is compared with the vault.
CREATE OR REPLACE FUNCTION public._pin_lookup(p_pin text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_id uuid; n integer;
BEGIN
  IF NOT public._pin_format_ok(p_pin) THEN RETURN NULL; END IF;
  SELECT COUNT(*), MIN(v.profile_id::text)::uuid INTO n, v_id
  FROM public.profile_pins v JOIN public.profiles p ON p.id = v.profile_id
  WHERE p.is_active AND v.pin_hash = extensions.crypt(p_pin, v.pin_hash);
  IF n = 1 THEN RETURN v_id; END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public._profile_pins_flag_trg() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pin_format_ok(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._pin_throttle_wait_seconds(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pin_attempt_log(text, text, boolean, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pin_lookup(text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Server-side sign-in lookup — the edge function only (service role)
--    Returns {ok:true, profile:{…}} | {ok:false, reason:'not_recognized'} |
--            {ok:false, reason:'locked', retry_after_seconds:n}
--    The profile carries every field kiosk-authenticate hands back as `operator`.
--
--    Two throttle keys, because every kiosk in the shop shares one public address:
--      p_throttle_key = the device  (ip:<addr>|dev:<device id>)  — 5 misses in 10 min lock that device
--      p_scope_key    = the address (ip:<addr>)                  — 30 misses in 10 min lock the address
--    The address ceiling is what still stops a guesser who rotates device ids.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._pin_scope_wait_seconds(p_scope text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN COUNT(*) >= 30
              THEN GREATEST(0, CEIL(EXTRACT(EPOCH FROM (MIN(at) + interval '10 minutes' - now()))))::integer
              ELSE 0 END
  FROM (SELECT at FROM public.pin_attempts
        WHERE scope_key = p_scope AND NOT success AND at > now() - interval '10 minutes'
        ORDER BY at DESC LIMIT 30) recent;
$$;
REVOKE ALL ON FUNCTION public._pin_scope_wait_seconds(text) FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.pin_authenticate(text, text);
DROP FUNCTION IF EXISTS public.pin_authenticate(text, text, text);
CREATE FUNCTION public.pin_authenticate(p_pin text, p_throttle_key text, p_scope_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_key   text := COALESCE(NULLIF(btrim(p_throttle_key), ''), 'unknown');
  v_scope text := NULLIF(btrim(p_scope_key), '');
  v_wait integer; v_id uuid; p public.profiles%ROWTYPE;
BEGIN
  v_wait := public._pin_throttle_wait_seconds(v_key);
  IF v_wait = 0 AND v_scope IS NOT NULL THEN v_wait := public._pin_scope_wait_seconds(v_scope); END IF;
  IF v_wait > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'locked', 'retry_after_seconds', v_wait);
  END IF;
  v_id := public._pin_lookup(p_pin);
  IF v_id IS NULL THEN
    INSERT INTO public.pin_attempts (context, throttle_key, scope_key, actor, success) VALUES ('kiosk_sign_in', v_key, v_scope, NULL, false);
    RETURN jsonb_build_object('ok', false, 'reason', 'not_recognized');
  END IF;
  SELECT * INTO p FROM public.profiles WHERE id = v_id;
  INSERT INTO public.pin_attempts (context, throttle_key, scope_key, actor, success) VALUES ('kiosk_sign_in', v_key, v_scope, v_id, true);
  RETURN jsonb_build_object('ok', true, 'profile', jsonb_build_object(
    'id', p.id, 'email', p.email, 'full_name', p.full_name, 'username', p.username,
    'role', p.role, 'roles', COALESCE(to_jsonb(p.roles), '[]'::jsonb), 'is_active', p.is_active,
    'home_location_id', p.home_location_id, 'can_float', p.can_float, 'can_approve_compliance', p.can_approve_compliance,
    'must_change_pin', p.must_change_pin, 'kiosk_only', p.kiosk_only,
    'avatar_icon', p.avatar_icon, 'avatar_color', p.avatar_color));
END $$;
REVOKE ALL ON FUNCTION public.pin_authenticate(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pin_authenticate(text, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. PIN checks for signed-in callers
--    A wrong PIN must be COUNTED, and a RAISE would roll the count back with
--    everything else — so a PIN miss never raises. Every PIN-taking function
--    returns a rejection instead, and the miss stays logged and throttled.
-- ---------------------------------------------------------------------------
-- One checker for every signed-in path. Returns
--   {ok:true, id, full_name} | {ok:false, reason:'not_recognized', message}
--   | {ok:false, reason:'locked', retry_after_seconds, message}
CREATE OR REPLACE FUNCTION public._pin_check(p_pin text, p_roles text[], p_context text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_key text; v_wait integer; v_id uuid; p public.profiles%ROWTYPE;
BEGIN
  v_key := 'uid:' || COALESCE(v_uid::text, 'server');
  v_wait := public._pin_throttle_wait_seconds(v_key);
  IF v_wait > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'locked', 'retry_after_seconds', v_wait,
                              'message', format('Too many wrong PINs — wait %s minute(s)', CEIL(v_wait / 60.0)));
  END IF;
  v_id := public._pin_lookup(p_pin);
  IF v_id IS NOT NULL THEN SELECT * INTO p FROM public.profiles WHERE id = v_id; END IF;
  IF v_id IS NULL OR (p_roles IS NOT NULL AND NOT (p.role = ANY(p_roles) OR COALESCE(p.roles, '{}') && p_roles)) THEN
    PERFORM public._pin_attempt_log(v_key, p_context, false, v_uid, NULL);
    RETURN jsonb_build_object('ok', false, 'reason', 'not_recognized', 'message', 'PIN not recognized');
  END IF;
  PERFORM public._pin_attempt_log(v_key, p_context, true, v_uid, NULL);
  RETURN jsonb_build_object('ok', true, 'id', p.id, 'full_name', p.full_name);
END $$;
REVOKE ALL ON FUNCTION public._pin_check(text, text[], text) FROM PUBLIC, anon, authenticated;

-- Resolve a second person's PIN (the kiosk echoes the name before confirming; Kit Kiosk's save confirm).
-- Returns {ok:true, profile_id, full_name} or the rejection from _pin_check.
DROP FUNCTION IF EXISTS public.pin_resolve(text, text[]);
CREATE FUNCTION public.pin_resolve(p_pin text, p_roles text[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
  r := public._pin_check(p_pin, p_roles, 'resolve');
  IF (r->>'ok')::boolean THEN
    RETURN jsonb_build_object('ok', true, 'profile_id', r->>'id', 'full_name', r->>'full_name');
  END IF;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.pin_resolve(text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pin_resolve(text, text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.assembly_pin_resolve(text);
CREATE FUNCTION public.assembly_pin_resolve(p_pin text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly','compliance']);
  RETURN public.pin_resolve(p_pin, ARRAY['admin','assembly','compliance']);
END $$;
REVOKE ALL ON FUNCTION public.assembly_pin_resolve(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_pin_resolve(text) TO authenticated, service_role;

-- C1's plain-text lookup is retired.
DROP FUNCTION IF EXISTS public._assembly_pin_profile(text, text[]);

-- The three kiosk functions that take PINs, re-issued on the vault (they replace C1's versions).
-- Start: a wrong second PIN returns {started:false, reason:'second_pin_rejected', …}; no lots are written.
CREATE OR REPLACE FUNCTION public.assembly_build_start(p_build_id uuid, p_lots jsonb, p_second_pin text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); b public.assembly_builds%ROWTYPE; c record; e jsonb; v_need numeric; v_have numeric;
  v_set jsonb := '[]'::jsonb; v_new boolean; v_chk jsonb; v_second_id uuid; v_session uuid;
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
    v_session := public.assembly_session_clock_in(p_build_id);
    RETURN jsonb_build_object('resumed', true, 'session_id', v_session);
  END IF;
  IF p_lots IS NULL OR jsonb_typeof(p_lots) <> 'array' OR jsonb_array_length(p_lots) = 0 THEN
    RAISE EXCEPTION 'Pull at least one lot for every component';
  END IF;

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

  v_new := b.build_kind NOT IN ('program', 'rework') AND public.assembly_lot_set_is_new(b.part_number, v_set);
  IF v_new AND v_require_second THEN
    IF p_second_pin IS NULL THEN
      RAISE EXCEPTION 'NEW_LOT_SET: this combination of lots is new for % — a second person must check the pull', b.part_number;
    END IF;
    v_chk := public._pin_check(p_second_pin, ARRAY['admin','assembly','compliance'], 'second_person');
    IF NOT (v_chk->>'ok')::boolean THEN
      RETURN jsonb_build_object('started', false, 'reason', 'second_pin_rejected') || (v_chk - 'ok');
    END IF;
    v_second_id := (v_chk->>'id')::uuid;
    IF v_second_id = v_uid THEN
      RETURN jsonb_build_object('started', false, 'reason', 'second_pin_rejected', 'message', 'The second check must be a different person');
    END IF;
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

-- Sign-off: a wrong PIN returns {result:'pin_rejected', which:1|2, …}; nothing is written.
CREATE OR REPLACE FUNCTION public.assembly_step_signoff(p_build_id uuid, p_step_id uuid, p_pins text[], p_readings jsonb DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); b public.assembly_builds%ROWTYPE; s public.assembly_checklist_steps%ROWTYPE; v_tpl uuid;
  v_c1 jsonb; v_c2 jsonb; v_pin1 uuid; v_pin2 uuid;
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
  IF COALESCE(array_length(p_pins, 1), 0) < s.pins_required THEN RAISE EXCEPTION 'This step needs % PIN(s)', s.pins_required; END IF;

  IF s.readings_count > 0 THEN
    v_cnt := CASE WHEN p_readings IS NULL OR jsonb_typeof(p_readings) <> 'array' THEN 0 ELSE jsonb_array_length(p_readings) END;
    IF v_cnt < s.readings_count THEN RAISE EXCEPTION '"%" needs % reading(s)', s.label, s.readings_count; END IF;
    IF s.threshold_min IS NOT NULL THEN
      SELECT MIN((x)::text::numeric) INTO v_min FROM jsonb_array_elements(p_readings) x;
      IF v_min < s.threshold_min THEN v_result := 'fail'; END IF;
    END IF;
  END IF;

  v_c1 := public._pin_check(p_pins[1], ARRAY['admin','assembly','compliance'], 'sign_off');
  IF NOT (v_c1->>'ok')::boolean THEN
    RETURN jsonb_build_object('result', 'pin_rejected', 'which', 1, 'step', s.label) || (v_c1 - 'ok');
  END IF;
  v_pin1 := (v_c1->>'id')::uuid;
  IF s.distinct_from IS NOT NULL AND b.assigned_to IS NOT NULL AND v_pin1 = b.assigned_to THEN
    RETURN jsonb_build_object('result', 'pin_rejected', 'which', 1, 'step', s.label,
                              'message', format('The first signer on "%s" must not be the assembler', s.label));
  END IF;
  IF s.pins_required = 2 THEN
    v_c2 := public._pin_check(p_pins[2], ARRAY['admin','assembly','compliance'], 'sign_off');
    IF NOT (v_c2->>'ok')::boolean THEN
      RETURN jsonb_build_object('result', 'pin_rejected', 'which', 2, 'step', s.label) || (v_c2 - 'ok');
    END IF;
    v_pin2 := (v_c2->>'id')::uuid;
    IF v_pin2 = v_pin1 THEN
      RETURN jsonb_build_object('result', 'pin_rejected', 'which', 2, 'step', s.label, 'message', 'Two different people must sign this step');
    END IF;
  END IF;

  INSERT INTO public.assembly_step_signoffs (build_id, wave, step_id, pin_1, pin_2, readings, result, note, signed_at)
  VALUES (p_build_id, b.wave_current, p_step_id, v_pin1, v_pin2, p_readings, v_result, NULLIF(btrim(p_note), ''), now())
  ON CONFLICT (build_id, wave, step_id) DO UPDATE SET
    pin_1 = EXCLUDED.pin_1, pin_2 = EXCLUDED.pin_2, readings = EXCLUDED.readings, result = EXCLUDED.result,
    note = EXCLUDED.note, signed_at = now();

  RETURN jsonb_build_object('result', v_result, 'step', s.label, 'threshold_min', s.threshold_min, 'min_reading', v_min,
                            'signed_by', jsonb_build_array(v_c1->>'full_name', v_c2->>'full_name'));
END $$;

-- Closeout: a rejected inspector PIN returns {closed:false, reason:'inspector_pin_rejected', …}.
CREATE OR REPLACE FUNCTION public.assembly_build_closeout(p_build_id uuid, p_good integer, p_bad integer DEFAULT 0, p_inspector_pin text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); b public.assembly_builds%ROWTYPE; v_tpl uuid; v_missing text; v_lot text; v_minutes numeric;
  v_rate numeric; v_ovh numeric; v_comp numeric; v_labor numeric; v_conv numeric; v_done_by text; v_insp record; v_sig jsonb;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Unknown build'; END IF;
  IF b.status NOT IN ('in_progress', 'paused') THEN RAISE EXCEPTION 'The build is not running (status %)', b.status; END IF;
  IF p_good IS NULL OR p_good < 0 OR COALESCE(p_bad, 0) < 0 OR p_good + COALESCE(p_bad, 0) = 0 THEN RAISE EXCEPTION 'Enter the good and bad counts'; END IF;
  IF p_good + COALESCE(p_bad, 0) > b.quantity THEN RAISE EXCEPTION 'Good + bad (%) exceeds the build quantity (%)', p_good + COALESCE(p_bad, 0), b.quantity; END IF;
  v_tpl := public._assembly_template_for_wave(p_build_id);

  IF p_inspector_pin IS NOT NULL THEN
    SELECT s.id, s.label INTO v_insp FROM public.assembly_checklist_steps s
     WHERE s.template_id = v_tpl AND s.step_type = 'inspect' AND s.pins_required = 1
       AND NOT EXISTS (SELECT 1 FROM public.assembly_step_signoffs so WHERE so.build_id = p_build_id AND so.wave = b.wave_current AND so.step_id = s.id AND so.result = 'pass')
     ORDER BY s.step_order LIMIT 1;
    IF v_insp.id IS NOT NULL THEN
      v_sig := public.assembly_step_signoff(p_build_id, v_insp.id, ARRAY[p_inspector_pin], NULL, 'closeout');
      IF v_sig->>'result' = 'pin_rejected' THEN
        RETURN jsonb_build_object('closed', false, 'reason', 'inspector_pin_rejected') || (v_sig - 'result');
      END IF;
    END IF;
  END IF;

  SELECT string_agg(s.label, ', ' ORDER BY s.step_order) INTO v_missing
  FROM public.assembly_checklist_steps s
  WHERE s.template_id = v_tpl AND s.pins_required > 0 AND s.step_type <> 'release'
    AND NOT EXISTS (SELECT 1 FROM public.assembly_step_signoffs so
                    WHERE so.build_id = p_build_id AND so.wave = b.wave_current AND so.step_id = s.id AND so.result = 'pass');
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'Sign off first: %', v_missing; END IF;

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

-- ---------------------------------------------------------------------------
-- 6. Setters
-- ---------------------------------------------------------------------------
-- Self-service. A PIN already on file must be supplied as p_current_pin (a temporary PIN counts).
-- Returns {ok:true} or {ok:false, reason, message[, retry_after_seconds]}; never raises on a miss.
DROP FUNCTION IF EXISTS public.profile_pin_set(text, text);
CREATE FUNCTION public.profile_pin_set(p_new_pin text, p_current_pin text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_uid uuid := auth.uid(); v_key text; v_wait integer; v_existing public.profile_pins%ROWTYPE; v_other uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
  v_key := 'uid:' || v_uid::text;
  v_wait := public._pin_throttle_wait_seconds(v_key);
  IF v_wait > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'locked', 'retry_after_seconds', v_wait,
                              'message', format('Too many attempts — wait %s minute(s)', CEIL(v_wait / 60.0)));
  END IF;
  IF NOT public._pin_format_ok(p_new_pin) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'format', 'message', 'A PIN is 4 to 6 digits');
  END IF;

  SELECT * INTO v_existing FROM public.profile_pins WHERE profile_id = v_uid;
  IF v_existing.profile_id IS NOT NULL THEN
    IF p_current_pin IS NULL OR v_existing.pin_hash <> extensions.crypt(p_current_pin, v_existing.pin_hash) THEN
      PERFORM public._pin_attempt_log(v_key, 'set', false, v_uid, 'current PIN wrong');
      RETURN jsonb_build_object('ok', false, 'reason', 'current_pin_wrong', 'message', 'Current PIN is not right');
    END IF;
    IF v_existing.pin_hash = extensions.crypt(p_new_pin, v_existing.pin_hash) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'same', 'message', 'Choose a PIN different from your current one');
    END IF;
  END IF;

  v_other := public._pin_lookup(p_new_pin);
  IF v_other IS NOT NULL AND v_other <> v_uid THEN
    PERFORM public._pin_attempt_log(v_key, 'set', false, v_uid, 'unavailable');
    RETURN jsonb_build_object('ok', false, 'reason', 'unavailable', 'message', 'Choose a different PIN');
  END IF;

  INSERT INTO public.profile_pins (profile_id, pin_hash, is_temporary, set_by, set_at)
  VALUES (v_uid, extensions.crypt(p_new_pin, extensions.gen_salt('bf', 6)), false, v_uid, now())
  ON CONFLICT (profile_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, is_temporary = false, set_by = v_uid, set_at = now();
  PERFORM public._pin_attempt_log(v_key, 'set', true, v_uid, NULL);
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.profile_pin_set(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.profile_pin_set(text, text) TO authenticated, service_role;

-- Admin: a temporary PIN the person must replace at their next kiosk sign-in.
CREATE OR REPLACE FUNCTION public.profile_pin_admin_set(p_profile_id uuid, p_temp_pin text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_uid uuid := auth.uid(); v_other uuid;
BEGIN
  IF v_uid IS NOT NULL AND NOT public.user_has_role(v_uid, 'admin') THEN
    RAISE EXCEPTION 'Not authorized: admin only' USING ERRCODE = '42501';
  END IF;
  IF NOT public._pin_format_ok(p_temp_pin) THEN RAISE EXCEPTION 'A PIN is 4 to 6 digits'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_profile_id) THEN RAISE EXCEPTION 'Unknown profile'; END IF;
  v_other := public._pin_lookup(p_temp_pin);
  IF v_other IS NOT NULL AND v_other <> p_profile_id THEN RAISE EXCEPTION 'Choose a different temporary PIN'; END IF;
  INSERT INTO public.profile_pins (profile_id, pin_hash, is_temporary, set_by, set_at)
  VALUES (p_profile_id, extensions.crypt(p_temp_pin, extensions.gen_salt('bf', 6)), true, v_uid, now())
  ON CONFLICT (profile_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, is_temporary = true, set_by = v_uid, set_at = now();
  PERFORM public._pin_attempt_log('uid:' || COALESCE(v_uid::text, 'server'), 'admin_set', true, v_uid, p_profile_id::text);
END $$;
REVOKE ALL ON FUNCTION public.profile_pin_admin_set(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.profile_pin_admin_set(uuid, text) TO authenticated, service_role;

-- Admin: remove a PIN ("Reset PIN").
CREATE OR REPLACE FUNCTION public.profile_pin_clear(p_profile_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NOT NULL AND NOT public.user_has_role(v_uid, 'admin') THEN
    RAISE EXCEPTION 'Not authorized: admin only' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.profile_pins WHERE profile_id = p_profile_id;
END $$;
REVOKE ALL ON FUNCTION public.profile_pin_clear(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.profile_pin_clear(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Bring the existing PINs across, and keep the vault in step with the old
--    column until C2b removes it
-- ---------------------------------------------------------------------------
INSERT INTO public.profile_pins (profile_id, pin_hash, is_temporary, set_at)
SELECT p.id, extensions.crypt(p.pin_code, extensions.gen_salt('bf', 6)), false, now()
FROM public.profiles p
WHERE p.pin_code IS NOT NULL AND p.pin_code ~ '^[0-9]{4,6}$'
ON CONFLICT (profile_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public._profiles_pin_code_sync_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  IF NEW.pin_code IS DISTINCT FROM OLD.pin_code THEN
    IF NEW.pin_code IS NULL THEN
      DELETE FROM public.profile_pins WHERE profile_id = NEW.id;
    ELSIF NEW.pin_code ~ '^[0-9]{4,6}$' THEN
      INSERT INTO public.profile_pins (profile_id, pin_hash, is_temporary, set_by, set_at)
      VALUES (NEW.id, extensions.crypt(NEW.pin_code, extensions.gen_salt('bf', 6)), false, auth.uid(), now())
      ON CONFLICT (profile_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, is_temporary = false, set_by = auth.uid(), set_at = now();
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._profiles_pin_code_sync_trg() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS profiles_pin_code_sync ON public.profiles;
CREATE TRIGGER profiles_pin_code_sync AFTER UPDATE OF pin_code ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public._profiles_pin_code_sync_trg();

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- select (select count(*) from profiles where pin_code is not null) as old_column_pins,
--        (select count(*) from profile_pins) as vault_pins,
--        (select count(*) from profiles where has_pin) as has_pin_flags;      -- all three equal
-- select has_table_privilege('authenticated', 'public.profile_pins', 'SELECT') as browser_reads_vault;   -- false
