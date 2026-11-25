-- ============================================================================
-- S17 Batch D2b — release review: the lead checks a build before it is released
-- 2026-11-25  ·  D-ASM-63
--
-- Why: with automatic posting (D2a), Release is the last human step before
-- Fishbowl changes. Until now it was one click with nothing to look at.
--
-- What this adds
--   1. assembly_build_review(build): everything the lead reviews, in one read:
--      the build, who worked on it, the lots pulled, every sign-off with who
--      signed and the readings, anything that blocks release, what release will
--      do in Fishbowl, and earlier reviews of the same build.
--   2. assembly_build_release_reviewed(...): release with a recorded sample
--      check (pieces sampled, pass). Refuses a failed sample and a build with a
--      missing or failed sign-off. May correct the good and bad counts, with a
--      reason; the counts before and after are kept. Signs the checklist's
--      Release step, when it has one.
--   3. assembly_build_send_back(...): returns a completed build to the tablet
--      with a required reason. Nothing is posted.
--   4. assembly_release_reviews: one row per review action. Never edited.
--   5. The one-click assembly_build_release refuses unless it is called by the
--      reviewed release, while app_settings.assembly_release_review_required is
--      true (seeded true).
--
-- Program (two-wave Giza) builds: reviewed and released the same way, but they
-- cannot be sent back and their counts cannot be corrected here, because their
-- closeout writes the Giza ledger.
--
-- Applied on TEST by Claude on 2026-11-25 (migrations s17_d2b_release_review and
-- s17_d2b_review_checked_by; this file is the two together).
-- On TEST the setting was then switched to false until the new screen is on
-- test-skynet, so the old Release button keeps working meanwhile.
-- PROD: not yet — Batch D is not complete. Do not run on PROD until told.
-- Run after D2a.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Setting
-- ---------------------------------------------------------------------------
INSERT INTO public.app_settings (key, value, description, category, label, unit, sort_order) VALUES
  ('assembly_release_review_required', 'true'::jsonb,
   'When true, a build can only be released through the release review: the lead looks over the lots and sign-offs, records a sample check, and then releases the build or sends it back.',
   'assembly', 'Review a build before release', NULL, 30)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Build columns: the latest send-back, for the board and the tablet
-- ---------------------------------------------------------------------------
ALTER TABLE public.assembly_builds
  ADD COLUMN IF NOT EXISTS sent_back_reason text,
  ADD COLUMN IF NOT EXISTS sent_back_at     timestamptz,
  ADD COLUMN IF NOT EXISTS sent_back_by     uuid REFERENCES public.profiles(id);
COMMENT ON COLUMN public.assembly_builds.sent_back_reason IS
  'Why the lead last sent this build back from the release review. Kept after the build is closed out again; the full history is in assembly_release_reviews.';

-- ---------------------------------------------------------------------------
-- 3. The review record
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.assembly_release_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_id      uuid NOT NULL REFERENCES public.assembly_builds(id) ON DELETE CASCADE,
  action        text NOT NULL CHECK (action IN ('released', 'sent_back')),
  sample_qty    integer CHECK (sample_qty IS NULL OR sample_qty >= 0),
  sample_result text CHECK (sample_result IS NULL OR sample_result IN ('pass', 'fail')),
  note          text,
  reason        text,                -- why it was sent back
  good_before   integer,
  bad_before    integer,
  good_after    integer,
  bad_after     integer,
  count_reason  text,                -- why the counts were corrected
  reviewed_by   uuid REFERENCES public.profiles(id),
  reviewed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assembly_release_reviews_build_idx ON public.assembly_release_reviews (build_id, reviewed_at);
COMMENT ON TABLE public.assembly_release_reviews IS
  'One row per release-review action on an assembly build (released or sent back): the sample check, any count correction with the counts before and after, who and when. Written only by assembly_build_release_reviewed and assembly_build_send_back; never edited.';

ALTER TABLE public.assembly_release_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assembly_release_reviews_read ON public.assembly_release_reviews;
CREATE POLICY assembly_release_reviews_read ON public.assembly_release_reviews FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.assembly_release_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.assembly_release_reviews TO authenticated;
GRANT ALL ON public.assembly_release_reviews TO service_role;

-- ---------------------------------------------------------------------------
-- 4. What blocks a release: a PIN step that is not signed, or signed as failed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._assembly_release_blockers(p_build_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(x.msg ORDER BY x.ord, x.msg), '[]'::jsonb)
  FROM (
    SELECT 0 AS ord, 'The build has no checklist' AS msg
      FROM public.assembly_builds b
     WHERE b.id = p_build_id AND public._assembly_template_for_wave(b.id) IS NULL
    UNION ALL
    SELECT s.step_order,
           CASE WHEN so.id IS NULL THEN 'Not signed: ' || s.label ELSE 'Failed: ' || s.label END
      FROM public.assembly_builds b
      JOIN public.assembly_checklist_steps s ON s.template_id = public._assembly_template_for_wave(b.id)
      LEFT JOIN public.assembly_step_signoffs so ON so.build_id = b.id AND so.wave = b.wave_current AND so.step_id = s.id
     WHERE b.id = p_build_id AND s.pins_required > 0 AND s.step_type <> 'release'
       AND (so.id IS NULL OR so.result <> 'pass')
  ) x;
$$;
REVOKE ALL ON FUNCTION public._assembly_release_blockers(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The review, in one read
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assembly_build_review(p_build_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.assembly_builds%ROWTYPE; v_tpl uuid; v_block text; v_post jsonb;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin', 'assembly', 'compliance']);
  PERFORM public._office_account_only();
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Unknown build'; END IF;
  v_tpl := public._assembly_template_for_wave(p_build_id);

  -- What releasing will do in Fishbowl, on the counts as they stand now.
  IF b.build_kind = 'program' THEN
    v_post := jsonb_build_object('mode', 'none', 'note', NULL);
  ELSIF b.build_kind IN ('order', 'stock', 'special')
        AND public._assembly_setting_text('fb_auto_post_enabled', 'false') = 'true' THEN
    v_block := public._assembly_auto_post_block(p_build_id);
    v_post := CASE WHEN v_block IS NULL THEN jsonb_build_object('mode', 'auto', 'note', NULL)
                   ELSE jsonb_build_object('mode', 'manual', 'note', 'Post by hand: ' || v_block) END;
  ELSE
    v_post := jsonb_build_object('mode', 'manual', 'note', NULL);
  END IF;

  RETURN jsonb_build_object(
    'build', jsonb_build_object(
      'id', b.id, 'build_number', b.build_number, 'part_number', b.part_number,
      'part_description', (SELECT p.description FROM public.parts p WHERE p.id = b.part_id),
      'build_kind', b.build_kind, 'status', b.status, 'quantity', b.quantity,
      'good_quantity', b.good_quantity, 'bad_quantity', b.bad_quantity,
      'assembly_lot_number', b.assembly_lot_number, 'wave_count', b.wave_count, 'wave_current', b.wave_current,
      'started_at', b.started_at, 'completed_at', b.completed_at,
      'fb_mo_num', b.fb_mo_num, 'fb_mo_state', b.fb_mo_state,
      'sent_back_reason', b.sent_back_reason, 'sent_back_at', b.sent_back_at,
      'sent_back_by', (SELECT COALESCE(pr.full_name, pr.username) FROM public.profiles pr WHERE pr.id = b.sent_back_by)),
    'review_required', public._assembly_setting_text('assembly_release_review_required', 'true') = 'true',
    'can_release', b.status = 'complete',
    'can_send_back', b.status = 'complete' AND b.build_kind <> 'program',
    'can_correct_counts', b.status = 'complete' AND b.build_kind <> 'program',
    'post', v_post,
    'people', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', x.name, 'minutes', x.minutes) ORDER BY x.name)
        FROM (SELECT COALESCE(pr.full_name, pr.username) AS name,
                     round(SUM(EXTRACT(EPOCH FROM (COALESCE(s.clock_out, now()) - s.clock_in)) / 60)::numeric, 1) AS minutes
                FROM public.assembly_sessions s JOIN public.profiles pr ON pr.id = s.profile_id
               WHERE s.build_id = b.id GROUP BY 1) x), '[]'::jsonb),
    'lots', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'wave', cl.wave, 'part', cl.component_part_number, 'description', d.description,
               'lot', cl.lot_number, 'qty', cl.qty,
               'picked_by', COALESCE(pk.full_name, pk.username), 'picked_at', cl.picked_at,
               -- the second PIN at start when it was used; otherwise whoever signed the pull check (D-ASM-58)
               'checked_by', COALESCE(COALESCE(sp.full_name, sp.username),
                 (SELECT string_agg(DISTINCT COALESCE(q.full_name, q.username), ', ')
                    FROM public.assembly_step_signoffs pso
                    JOIN public.assembly_checklist_steps ps ON ps.id = pso.step_id AND ps.step_type = 'pull_check'
                    JOIN public.profiles q ON q.id IN (pso.pin_1, pso.pin_2)
                   WHERE pso.build_id = b.id AND pso.wave = cl.wave AND pso.result = 'pass')))
             ORDER BY cl.wave, cl.component_part_number, cl.lot_number)
        FROM public.assembly_component_lots cl
        LEFT JOIN public.profiles pk ON pk.id = cl.picked_by
        LEFT JOIN public.profiles sp ON sp.id = cl.second_pin_by
        LEFT JOIN LATERAL (SELECT bi.part_description AS description
                             FROM public.fb_boms fb
                             JOIN public.fb_bom_items bi ON bi.fb_bom_id = fb.fb_bom_id AND bi.type_id = 20 AND bi.part_num = cl.component_part_number
                            WHERE fb.bom_num = b.part_number AND fb.active AND fb.removed_at IS NULL LIMIT 1) d ON true
       WHERE cl.build_id = b.id), '[]'::jsonb),
    'steps', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'wave', w.wave, 'order', s.step_order, 'type', s.step_type, 'label', s.label,
               'pins_required', s.pins_required, 'sample_qty', s.sample_qty,
               'readings_count', s.readings_count, 'reading_unit', s.reading_unit, 'threshold_min', s.threshold_min,
               'signed', so.id IS NOT NULL, 'result', so.result, 'readings', so.readings, 'note', so.note,
               'signed_at', so.signed_at,
               'signed_by', (SELECT COALESCE(jsonb_agg(n.name), '[]'::jsonb)
                               FROM (VALUES (COALESCE(p1.full_name, p1.username)), (COALESCE(p2.full_name, p2.username))) AS n(name)
                              WHERE n.name IS NOT NULL),
               'signed_before_send_back', so.id IS NOT NULL AND b.sent_back_at IS NOT NULL AND so.signed_at < b.sent_back_at)
             ORDER BY w.wave, s.step_order)
        FROM (SELECT 1 AS wave, b.checklist_template_id AS tpl
              UNION ALL
              SELECT 2, v_tpl WHERE b.wave_current = 2) w
        JOIN public.assembly_checklist_steps s ON s.template_id = w.tpl
        LEFT JOIN public.assembly_step_signoffs so ON so.build_id = b.id AND so.wave = w.wave AND so.step_id = s.id
        LEFT JOIN public.profiles p1 ON p1.id = so.pin_1
        LEFT JOIN public.profiles p2 ON p2.id = so.pin_2), '[]'::jsonb),
    'blockers', public._assembly_release_blockers(b.id),
    'reviews', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'action', r.action, 'sample_qty', r.sample_qty, 'sample_result', r.sample_result, 'note', r.note,
               'reason', r.reason, 'good_before', r.good_before, 'bad_before', r.bad_before,
               'good_after', r.good_after, 'bad_after', r.bad_after, 'count_reason', r.count_reason,
               'reviewed_by', COALESCE(pr.full_name, pr.username), 'reviewed_at', r.reviewed_at)
             ORDER BY r.reviewed_at)
        FROM public.assembly_release_reviews r LEFT JOIN public.profiles pr ON pr.id = r.reviewed_by
       WHERE r.build_id = b.id), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.assembly_build_review(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_build_review(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. The one-click release: as D2a left it, plus the review guard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assembly_build_release(p_build_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.assembly_builds%ROWTYPE; v_block text;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  PERFORM public._office_account_only();
  -- D2b: while the review is required, only the reviewed release may call this.
  IF public._assembly_setting_text('assembly_release_review_required', 'true') = 'true'
     AND COALESCE(current_setting('skynet.release_reviewed', true), '') <> '1' THEN
    RAISE EXCEPTION 'Review the build before releasing it: use Release on the Assembly Board';
  END IF;
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Unknown build'; END IF;
  IF b.status NOT IN ('complete', 'pending_tco') THEN RAISE EXCEPTION 'Only a completed build can be released (status %)', b.status; END IF;
  IF b.work_order_assembly_id IS NOT NULL AND b.status = 'pending_tco' THEN
    RAISE EXCEPTION 'This build closes through TCO, not release';
  END IF;
  UPDATE public.assembly_builds
     SET status = 'released', released_by = auth.uid(), released_at = now(),
         fb_post_status = CASE WHEN build_kind = 'program' THEN 'not_applicable' ELSE 'ready_to_post' END,
         fb_post_method = NULL, fb_post_error = NULL
   WHERE id = p_build_id;
  UPDATE public.assembly_requests SET status = 'built' WHERE build_id = p_build_id AND status = 'in_build';

  IF b.build_kind IN ('order', 'stock', 'special')
     AND public._assembly_setting_text('fb_auto_post_enabled', 'false') = 'true' THEN
    BEGIN
      v_block := public._assembly_auto_post_block(p_build_id);
      IF v_block IS NULL THEN
        PERFORM public._assembly_post_enqueue(p_build_id);
      ELSE
        UPDATE public.assembly_builds SET fb_post_method = 'manual', fb_post_error = 'Post by hand: ' || v_block WHERE id = p_build_id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.assembly_builds
         SET fb_post_status = 'ready_to_post', fb_post_method = 'manual',
             fb_post_error = 'Post by hand: the automatic post could not be queued (' || SQLERRM || ')'
       WHERE id = p_build_id;
    END;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.assembly_build_release(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_build_release(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Release with the review recorded
--    p_good / p_bad: leave NULL to keep the counts the tablet recorded.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assembly_build_release_reviewed(
  p_build_id uuid, p_sample_qty integer, p_sample_result text, p_note text DEFAULT NULL,
  p_good integer DEFAULT NULL, p_bad integer DEFAULT NULL, p_count_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b public.assembly_builds%ROWTYPE; v_good integer; v_bad integer; v_changed boolean; v_blockers jsonb; v_tpl uuid;
  v_minutes numeric; v_rate numeric; v_ovh numeric; v_comp numeric; v_labor numeric; r public.assembly_builds%ROWTYPE;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  PERFORM public._office_account_only();
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Unknown build'; END IF;
  IF b.status <> 'complete' THEN RAISE EXCEPTION 'Only a completed build can be released (status %)', b.status; END IF;

  v_good := COALESCE(p_good, b.good_quantity, 0);
  v_bad  := COALESCE(p_bad, b.bad_quantity, 0);
  v_changed := v_good IS DISTINCT FROM COALESCE(b.good_quantity, 0) OR v_bad IS DISTINCT FROM COALESCE(b.bad_quantity, 0);
  IF v_changed THEN
    IF b.build_kind = 'program' THEN RAISE EXCEPTION 'The counts on a program build cannot be corrected here'; END IF;
    IF p_count_reason IS NULL OR btrim(p_count_reason) = '' THEN RAISE EXCEPTION 'Say why the counts are being corrected'; END IF;
    IF v_good < 0 OR v_bad < 0 OR v_good + v_bad = 0 THEN RAISE EXCEPTION 'Enter the good and bad counts'; END IF;
    IF v_good + v_bad > b.quantity THEN RAISE EXCEPTION 'Good + bad (%) exceeds the build quantity (%)', v_good + v_bad, b.quantity; END IF;
  END IF;

  IF p_sample_result IS DISTINCT FROM 'pass' AND p_sample_result IS DISTINCT FROM 'fail' THEN
    RAISE EXCEPTION 'Record the sample check as pass or fail';
  END IF;
  IF p_sample_result = 'fail' THEN RAISE EXCEPTION 'A build whose sample failed cannot be released. Send it back.'; END IF;
  IF p_sample_qty IS NULL OR p_sample_qty < 1 THEN RAISE EXCEPTION 'Enter how many pieces were sampled (at least 1)'; END IF;
  IF p_sample_qty > v_good + v_bad THEN RAISE EXCEPTION 'Sampled % of % built', p_sample_qty, v_good + v_bad; END IF;

  v_blockers := public._assembly_release_blockers(p_build_id);
  IF jsonb_array_length(v_blockers) > 0 THEN
    RAISE EXCEPTION 'This build cannot be released yet: %',
      (SELECT string_agg(x, '; ') FROM jsonb_array_elements_text(v_blockers) x);
  END IF;

  IF v_changed THEN
    UPDATE public.assembly_builds SET good_quantity = v_good, bad_quantity = v_bad WHERE id = p_build_id;
    -- the cost snapshot is per good piece: restate it on the corrected count
    SELECT c.minutes_total, COALESCE(c.labor_rate, 0), COALESCE(c.overhead_pct, 0), COALESCE(c.component_cost_unit, 0)
      INTO v_minutes, v_rate, v_ovh, v_comp
      FROM public.assembly_build_costs c WHERE c.build_id = p_build_id;
    IF FOUND THEN
      v_labor := CASE WHEN v_good > 0 THEN (COALESCE(v_minutes, 0) / 60.0) * v_rate / v_good ELSE 0 END;
      UPDATE public.assembly_build_costs
         SET good_qty = v_good,
             minutes_per_unit = CASE WHEN v_good > 0 THEN round(COALESCE(v_minutes, 0) / v_good, 3) ELSE NULL END,
             labor_cost_unit = round(v_labor, 4),
             overhead_unit = round(v_labor * v_ovh / 100.0, 4),
             model_cost_unit = round(v_comp + v_labor + v_labor * v_ovh / 100.0, 4),
             basis_note = basis_note || '; good count corrected at release review',
             computed_at = now()
       WHERE build_id = p_build_id;
    END IF;
  END IF;

  INSERT INTO public.assembly_release_reviews
    (build_id, action, sample_qty, sample_result, note, good_before, bad_before, good_after, bad_after, count_reason, reviewed_by)
  VALUES
    (p_build_id, 'released', p_sample_qty, 'pass', NULLIF(btrim(p_note), ''),
     b.good_quantity, b.bad_quantity, v_good, v_bad,
     CASE WHEN v_changed THEN btrim(p_count_reason) ELSE NULL END, auth.uid());

  -- The checklist's own Release step, when it has one, is signed by this review.
  v_tpl := public._assembly_template_for_wave(p_build_id);
  INSERT INTO public.assembly_step_signoffs (build_id, wave, step_id, pin_1, pin_2, readings, result, note, signed_at)
  SELECT p_build_id, b.wave_current, s.id, auth.uid(), NULL, NULL, 'pass', 'Signed by the release review', now()
    FROM public.assembly_checklist_steps s
   WHERE s.template_id = v_tpl AND s.step_type = 'release'
  ON CONFLICT (build_id, wave, step_id) DO UPDATE SET
    pin_1 = EXCLUDED.pin_1, pin_2 = NULL, result = 'pass', note = EXCLUDED.note, signed_at = now();

  PERFORM set_config('skynet.release_reviewed', '1', true);
  PERFORM public.assembly_build_release(p_build_id);
  PERFORM set_config('skynet.release_reviewed', '', true);

  SELECT * INTO r FROM public.assembly_builds WHERE id = p_build_id;
  RETURN jsonb_build_object('released', true, 'build_number', r.build_number,
                            'good_quantity', r.good_quantity, 'bad_quantity', r.bad_quantity,
                            'fb_post_status', r.fb_post_status, 'fb_post_error', r.fb_post_error);
END $$;
REVOKE ALL ON FUNCTION public.assembly_build_release_reviewed(uuid, integer, text, text, integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_build_release_reviewed(uuid, integer, text, text, integer, integer, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Send a completed build back to the tablet. Nothing is posted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assembly_build_send_back(
  p_build_id uuid, p_reason text, p_sample_qty integer DEFAULT NULL, p_sample_result text DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.assembly_builds%ROWTYPE;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  PERFORM public._office_account_only();
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Unknown build'; END IF;
  IF b.status <> 'complete' THEN RAISE EXCEPTION 'Only a completed build can be sent back (status %)', b.status; END IF;
  IF b.build_kind = 'program' THEN RAISE EXCEPTION 'A program build cannot be sent back from here'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'Say why the build is being sent back'; END IF;
  IF p_sample_result IS NOT NULL AND p_sample_result NOT IN ('pass', 'fail') THEN
    RAISE EXCEPTION 'Record the sample check as pass or fail';
  END IF;
  IF p_sample_qty IS NOT NULL AND p_sample_qty < 0 THEN RAISE EXCEPTION 'The sample quantity cannot be negative'; END IF;

  INSERT INTO public.assembly_release_reviews
    (build_id, action, sample_qty, sample_result, note, reason, good_before, bad_before, reviewed_by)
  VALUES
    (p_build_id, 'sent_back', p_sample_qty, p_sample_result, NULLIF(btrim(p_note), ''), btrim(p_reason),
     b.good_quantity, b.bad_quantity, auth.uid());

  -- Back on the tablet as a paused build: the assembler resumes it, redoes what the reason asks, and closes it out again.
  -- The lots, the sign-offs and the finished lot number stay as they are.
  UPDATE public.assembly_builds
     SET status = 'paused', completed_at = NULL, good_quantity = NULL, bad_quantity = NULL,
         sent_back_reason = btrim(p_reason), sent_back_at = now(), sent_back_by = auth.uid()
   WHERE id = p_build_id;
END $$;
REVOKE ALL ON FUNCTION public.assembly_build_send_back(uuid, text, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_build_send_back(uuid, text, integer, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Verify (one row; every value should be true)
-- ---------------------------------------------------------------------------
SELECT
  (SELECT value = 'true'::jsonb FROM public.app_settings WHERE key = 'assembly_release_review_required')                        AS review_required_seeded,
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.assembly_release_reviews'::regclass)                                  AS rls_on,
  (SELECT COUNT(*) = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'assembly_release_reviews')                  AS one_read_policy,
  NOT has_table_privilege('anon', 'public.assembly_release_reviews', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.assembly_release_reviews', 'INSERT')                                    AS table_grants_ok,
  NOT has_function_privilege('anon', 'public.assembly_build_review(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.assembly_build_release_reviewed(uuid, integer, text, text, integer, integer, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.assembly_build_send_back(uuid, text, integer, text, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public._assembly_release_blockers(uuid)', 'EXECUTE')                        AS function_grants_ok,
  NOT has_table_privilege('kiosk_assembler', 'public.assembly_release_reviews', 'SELECT')
    AND NOT has_function_privilege('kiosk_assembler', 'public.assembly_build_release_reviewed(uuid, integer, text, text, integer, integer, text)', 'EXECUTE') AS tablet_role_has_no_access;
