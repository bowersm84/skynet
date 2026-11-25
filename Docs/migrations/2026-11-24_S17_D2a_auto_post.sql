-- ============================================================================
-- S17 Batch D2a — a released build is posted to Fishbowl by the bridge
-- 2026-11-24  ·  D-ASM-59, -60 (probes); records the D2a decisions
--
-- What this adds
--   1. Queue kind wo_post: finish the work order's pick lines on the lots the
--      tablet recorded, then fulfill the work order (produced, scrapped,
--      finished lot, destination). The bridge does the Fishbowl side.
--   2. Settings: fb_auto_post_enabled (seeded false), fb_auto_post_min_version
--      (26.11), fb_post_dest_location_id (3 = Receiving).
--   3. The bridge reports the Fishbowl server version in its heartbeat; it is
--      kept in fb_sync_state.fishbowl_version.
--   4. Post states posting and post_failed, with fb_post_method and
--      fb_post_error on the build.
--   5. Release queues the post when the build qualifies; otherwise the build
--      goes to Ready to post exactly as before, with the reason on the card.
--   6. The bridge's answer lands on the build. A failure never retries by
--      itself: the card shows the reason, and a person retries or posts by hand.
--   7. Read-back also compares the quantity consumed per component and, for an
--      automatic post, the scrapped quantity.
--   8. The part-number fence: empty now means NO part; '*' means every part.
--
-- SAFE BY DEFAULT: fb_auto_post_enabled is seeded false. With it false, release
-- behaves as it did after D1d. The bridge has its own switch as well.
--
-- First cut, on purpose: one lot per component, good + bad equal to the build
-- quantity, one wave, a bridge-made MO. Anything else stays a hand post.
-- Rework and program builds are untouched by this file.
--
-- Applied on TEST by Claude on 2026-11-24 (migration s17_d2a_auto_post) and
-- exercised there inside a rolled-back transaction: release queues the post;
-- a bridge failure and a forced dry run land as post_failed with the reason;
-- retry queues attempt 2 and a second queue is refused; a finished post is
-- read back as verified; a scrap difference on an automatic post is a
-- mismatch; the three hand-posted builds keep their results; the fence
-- answers '' = no part and '*' = every part. The 12 function bodies on TEST
-- match this file byte for byte. The one difference from what ran on TEST is
-- the first DO block, rewritten with := so it runs in the SQL Editor; that
-- version was then run on TEST too (it changes nothing the second time).
-- PROD: not yet — Batch D is not complete. Do not run on PROD until told.
-- Run after D1, D1b, D1c, D1d and D1e. Whichever of D1 and the D-PRICE-75
-- original-price SQL reaches PROD second must keep the other's queue kinds.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Queue: the wo_post kind. The existing list is kept whatever it holds
--    (TEST and PROD differ: 'origprice' was added by D-PRICE-75).
-- ---------------------------------------------------------------------------
DO $kind$
DECLARE v_def text; v_kinds text[];
BEGIN
  -- := assignments only: the SQL Editor rewrites SELECT ... INTO inside a DO block.
  v_def := (SELECT pg_get_constraintdef(oid) FROM pg_constraint
             WHERE conrelid = 'public.fb_push_commands'::regclass AND conname = 'fb_push_commands_kind_check');
  IF v_def IS NULL THEN RAISE EXCEPTION 'fb_push_commands_kind_check not found'; END IF;
  IF position('wo_post' in v_def) = 0 THEN            -- already there on a second run: nothing to do
    v_kinds := (SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
                  FROM regexp_matches(v_def, '''([a-z_]+)''::text', 'g') AS m);
    IF v_kinds IS NULL OR NOT ('mo_create' = ANY (v_kinds)) THEN
      RAISE EXCEPTION 'fb_push_commands_kind_check is not the list D1 left: %', v_def;
    END IF;
    v_kinds := v_kinds || 'wo_post'::text;
    EXECUTE 'ALTER TABLE public.fb_push_commands DROP CONSTRAINT fb_push_commands_kind_check';
    EXECUTE format('ALTER TABLE public.fb_push_commands ADD CONSTRAINT fb_push_commands_kind_check CHECK (kind = ANY (%L::text[]))', v_kinds);
  END IF;
END
$kind$;

CREATE OR REPLACE FUNCTION public.fb_push_enqueue_cmd(p_kind text, p_payload jsonb, p_key text,
                                                      p_note text DEFAULT NULL, p_build_id uuid DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id bigint;
BEGIN
  IF p_kind NOT IN ('mo_create', 'mo_cancel', 'mo_close_short', 'mo_note', 'inventory_add', 'inventory_scrap', 'wo_post') THEN
    RAISE EXCEPTION 'fb_push_enqueue_cmd: % is not a non-pricing command', p_kind;
  END IF;
  IF p_key IS NULL OR btrim(p_key) = '' THEN RAISE EXCEPTION 'fb_push_enqueue_cmd: an idempotency key is required'; END IF;
  SELECT id INTO v_id FROM public.fb_push_commands
   WHERE idempotency_key = p_key AND status IN ('queued', 'running', 'done') LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO public.fb_push_commands (kind, status, dry_run, options, import_name, payload, requested_by, note, idempotency_key, build_id)
  VALUES (p_kind, 'queued', false, '{}'::jsonb, NULL, p_payload, auth.uid(), p_note, p_key, p_build_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.fb_push_enqueue_cmd(text, jsonb, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fb_push_enqueue_cmd(text, jsonb, text, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Settings
-- ---------------------------------------------------------------------------
INSERT INTO public.app_settings (key, value, description, category, label, unit, sort_order) VALUES
  ('fb_auto_post_enabled', 'false'::jsonb,
   'When true, releasing a build queues its Fishbowl post for the bridge: the pick lines are finished on the lots the tablet recorded and the work order is fulfilled. When false, every build goes to Ready to post for a hand post.',
   'fishbowl', 'Post finished builds to Fishbowl automatically', NULL, 40),
  ('fb_auto_post_min_version', '"26.11"'::jsonb,
   'The lowest Fishbowl version that may be posted to automatically. The work-order fulfill call and the pick save were proven on 26.11 (D-ASM-59, D-ASM-60).',
   'fishbowl', 'Lowest Fishbowl version for automatic posting', NULL, 50),
  ('fb_post_dest_location_id', '3'::jsonb,
   'The Fishbowl location id a finished lot is received into by an automatic post. 3 is Receiving in the Main location group, where work-order finished goods land today.',
   'fishbowl', 'Fishbowl location for the finished lot', NULL, 60)
ON CONFLICT (key) DO NOTHING;

UPDATE public.app_settings
   SET description = 'Only builds whose part number starts with this are sent to Fishbowl. Empty = no part at all. * = every part. Keep SKYTEST- until cutover (D-ASM-11).'
 WHERE key = 'fb_write_part_prefix';

-- ---------------------------------------------------------------------------
-- 3. The Fishbowl server version, reported by the bridge
-- ---------------------------------------------------------------------------
ALTER TABLE public.fb_sync_state
  ADD COLUMN IF NOT EXISTS fishbowl_version    text,
  ADD COLUMN IF NOT EXISTS fishbowl_version_at timestamptz;
COMMENT ON COLUMN public.fb_sync_state.fishbowl_version IS
  'The Fishbowl server version the bridge last read, as major.minor (25.9, 26.11). NULL until a bridge that reports it has run.';

CREATE OR REPLACE FUNCTION public.fb_heartbeat(p_state jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  PERFORM public._fb_gate(ARRAY['integration', 'admin']);
  UPDATE public.fb_sync_state
     SET last_heartbeat_at   = now(),
         bridge_version      = COALESCE(p_state->>'version', bridge_version),
         bridge_host         = COALESCE(p_state->>'host', bridge_host),
         last_error          = p_state->>'last_error',
         last_error_at       = CASE WHEN p_state->>'last_error' IS NULL THEN last_error_at ELSE now() END,
         fishbowl_version    = COALESCE(NULLIF(p_state->>'fishbowl_version', ''), fishbowl_version),
         fishbowl_version_at = CASE WHEN NULLIF(p_state->>'fishbowl_version', '') IS NULL THEN fishbowl_version_at ELSE now() END,
         updated_at          = now()
   WHERE id = 1;
END;
$function$;

-- 26.11 >= 26.11, 26.9.1 < 26.11, 27.1 >= 26.11. Anything unreadable is "no".
CREATE OR REPLACE FUNCTION public._fb_version_at_least(p_version text, p_min text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE a text[]; m text[];
BEGIN
  a := regexp_match(COALESCE(p_version, ''), '^(\d+)\.(\d+)');
  m := regexp_match(COALESCE(p_min, ''), '^(\d+)\.(\d+)');
  IF a IS NULL OR m IS NULL THEN RETURN false; END IF;
  RETURN (a[1]::integer, a[2]::integer) >= (m[1]::integer, m[2]::integer);
END $$;
REVOKE ALL ON FUNCTION public._fb_version_at_least(text, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The part-number fence, one definition: '' = no part, '*' = every part
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._fb_part_in_fence(p_part_number text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN p_part_number IS NULL THEN false
    WHEN f.prefix = ''  THEN false
    WHEN f.prefix = '*' THEN true
    ELSE left(p_part_number, length(f.prefix)) = f.prefix
  END
  FROM (SELECT btrim(public._assembly_setting_text('fb_write_part_prefix', 'SKYTEST-')) AS prefix) f;
$$;
REVOKE ALL ON FUNCTION public._fb_part_in_fence(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._assembly_mo_wanted(p_kind text, p_part_number text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public._assembly_setting_text('fb_mo_enabled', 'false') = 'true'
     AND p_kind IN ('order', 'stock', 'special')          -- rework posts by scrap + add (D-ASM-16); Giza posting is unchanged
     AND public._fb_part_in_fence(p_part_number);
$$;
REVOKE ALL ON FUNCTION public._assembly_mo_wanted(text, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Build columns and post states
-- ---------------------------------------------------------------------------
ALTER TABLE public.assembly_builds
  ADD COLUMN IF NOT EXISTS fb_post_method text,
  ADD COLUMN IF NOT EXISTS fb_post_error  text;
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assembly_builds_fb_post_method_check') THEN
    ALTER TABLE public.assembly_builds ADD CONSTRAINT assembly_builds_fb_post_method_check
      CHECK (fb_post_method IS NULL OR fb_post_method IN ('auto', 'manual'));
  END IF;
  ALTER TABLE public.assembly_builds DROP CONSTRAINT IF EXISTS assembly_builds_fb_post_status_check;
  ALTER TABLE public.assembly_builds ADD CONSTRAINT assembly_builds_fb_post_status_check
    CHECK (fb_post_status IN ('not_posted', 'ready_to_post', 'posting', 'post_failed', 'posted', 'verified', 'mismatch', 'not_applicable'));
END
$chk$;
COMMENT ON COLUMN public.assembly_builds.fb_post_method IS
  'auto = the bridge was asked to post this build; manual = it is a hand post (see fb_post_error for why); NULL = automatic posting was off at release.';
COMMENT ON COLUMN public.assembly_builds.fb_post_error IS
  'Why the build is not posted automatically, or why the automatic post failed. Shown on the post card.';

-- ---------------------------------------------------------------------------
-- 6. Does this build qualify for an automatic post? NULL = yes; otherwise why not.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._assembly_auto_post_block(p_build_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.assembly_builds%ROWTYPE; v_ver text; v_min text; v_txt text;
BEGIN
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id;
  IF b.id IS NULL THEN RETURN 'the build was not found'; END IF;
  IF b.build_kind NOT IN ('order', 'stock', 'special') THEN
    RETURN 'a ' || b.build_kind || ' build is not posted through a manufacture order';
  END IF;
  IF b.fb_mo_state <> 'issued' OR b.fb_mo_id IS NULL OR b.fb_mo_num IS NULL THEN
    RETURN 'the build has no bridge-made Fishbowl MO (MO state: ' || b.fb_mo_state || ')';
  END IF;
  IF NOT public._fb_part_in_fence(b.part_number) THEN RETURN 'the part is outside the Fishbowl write fence'; END IF;
  v_min := public._assembly_setting_text('fb_auto_post_min_version', '26.11');
  v_ver := (SELECT s.fishbowl_version FROM public.fb_sync_state s WHERE s.id = 1);
  IF NOT public._fb_version_at_least(v_ver, v_min) THEN
    RETURN 'Fishbowl is version ' || COALESCE(v_ver, 'unknown') || '; automatic posting needs ' || v_min || ' or later';
  END IF;
  IF b.wave_count <> 1 THEN RETURN 'a two-wave build is posted by hand'; END IF;
  IF COALESCE(b.good_quantity, 0) <= 0 THEN RETURN 'no good pieces were recorded'; END IF;
  IF COALESCE(b.good_quantity, 0) + COALESCE(b.bad_quantity, 0) <> b.quantity THEN
    RETURN format('good + bad is %s of the %s ordered; a short build is posted by hand',
                  COALESCE(b.good_quantity, 0) + COALESCE(b.bad_quantity, 0), b.quantity);
  END IF;
  IF b.assembly_lot_number IS NULL OR btrim(b.assembly_lot_number) = '' THEN RETURN 'the build has no finished lot number'; END IF;

  -- Every component of the Fishbowl BOM has exactly one recorded lot.
  IF NOT EXISTS (SELECT 1 FROM public.fb_boms fb WHERE fb.bom_num = b.part_number AND fb.active AND fb.removed_at IS NULL) THEN
    RETURN 'the Fishbowl BOM for ' || b.part_number || ' is not in the mirror';
  END IF;
  SELECT string_agg(e.part_num, ', ' ORDER BY e.part_num) INTO v_txt
    FROM (SELECT DISTINCT bi.part_num
            FROM public.fb_boms fb
            JOIN public.fb_bom_items bi ON bi.fb_bom_id = fb.fb_bom_id AND bi.type_id = 20 AND COALESCE(bi.uom_id, 0) <> 4
           WHERE fb.bom_num = b.part_number AND fb.active AND fb.removed_at IS NULL) e
   WHERE NOT EXISTS (SELECT 1 FROM public.assembly_component_lots cl
                      WHERE cl.build_id = b.id AND cl.component_part_number = e.part_num);
  IF v_txt IS NOT NULL THEN RETURN 'no lot was recorded for ' || v_txt; END IF;
  SELECT string_agg(x.part, ', ' ORDER BY x.part) INTO v_txt
    FROM (SELECT cl.component_part_number AS part
            FROM public.assembly_component_lots cl WHERE cl.build_id = b.id
           GROUP BY cl.component_part_number HAVING COUNT(DISTINCT cl.lot_number) > 1) x;
  IF v_txt IS NOT NULL THEN RETURN 'more than one lot was pulled for ' || v_txt || '; a build with split lots is posted by hand'; END IF;
  SELECT string_agg(DISTINCT cl.component_part_number, ', ' ORDER BY cl.component_part_number) INTO v_txt
    FROM public.assembly_component_lots cl
   WHERE cl.build_id = b.id
     AND NOT EXISTS (SELECT 1 FROM public.fb_boms fb
                       JOIN public.fb_bom_items bi ON bi.fb_bom_id = fb.fb_bom_id AND bi.type_id = 20
                      WHERE fb.bom_num = b.part_number AND fb.active AND fb.removed_at IS NULL
                        AND bi.part_num = cl.component_part_number);
  IF v_txt IS NOT NULL THEN RETURN 'a lot was recorded for ' || v_txt || ', which is not on the Fishbowl BOM'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._assembly_auto_post_block(uuid) FROM PUBLIC, anon, authenticated;

-- Queue the post. The caller holds the build row lock and has checked it qualifies.
CREATE OR REPLACE FUNCTION public._assembly_post_enqueue(p_build_id uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.assembly_builds%ROWTYPE; v_attempt integer; v_id bigint;
BEGIN
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id;
  IF EXISTS (SELECT 1 FROM public.fb_push_commands c
              WHERE c.build_id = b.id AND c.kind = 'wo_post' AND c.status IN ('queued', 'running')) THEN
    RAISE EXCEPTION 'A post is already queued for build %', b.build_number;
  END IF;
  SELECT COUNT(*) + 1 INTO v_attempt FROM public.fb_push_commands c WHERE c.build_id = b.id AND c.kind = 'wo_post';
  UPDATE public.assembly_builds
     SET fb_post_status = 'posting', fb_post_method = 'auto', fb_post_error = NULL
   WHERE id = p_build_id;
  v_id := public.fb_push_enqueue_cmd(
    'wo_post',
    jsonb_build_object(
      'build_id', b.id, 'build_number', b.build_number, 'mo_number', b.fb_mo_num, 'fb_mo_id', b.fb_mo_id,
      'part_number', b.part_number, 'quantity', b.quantity,
      'produced', b.good_quantity, 'scrapped', COALESCE(b.bad_quantity, 0),
      'finished_lot', b.assembly_lot_number,
      'destination_location_id', NULLIF(public._assembly_setting_text('fb_post_dest_location_id', '3'), '')::integer,
      'lots', (SELECT jsonb_agg(jsonb_build_object('part', cl.component_part_number, 'lot', cl.lot_number)
                                ORDER BY cl.component_part_number)
                 FROM public.assembly_component_lots cl WHERE cl.build_id = b.id),
      'min_version', public._assembly_setting_text('fb_auto_post_min_version', '26.11'),
      'attempt', v_attempt,
      'write_part_prefix', btrim(public._assembly_setting_text('fb_write_part_prefix', 'SKYTEST-'))),
    'wo_post:' || b.id::text || ':' || v_attempt::text,
    'Post build ' || b.build_number || CASE WHEN v_attempt > 1 THEN ' (attempt ' || v_attempt || ')' ELSE '' END,
    b.id);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public._assembly_post_enqueue(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Release. As C3 left it, plus the automatic post. Queueing the post must
--    never stop the release.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assembly_build_release(p_build_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.assembly_builds%ROWTYPE; v_block text;
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
-- 8. The bridge's answer lands on the build (D1's trigger, plus wo_post)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_push_commands_build_result_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_dry boolean;
BEGIN
  IF NEW.build_id IS NULL OR NEW.status NOT IN ('done', 'failed') OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
  BEGIN
    v_dry := NEW.dry_run OR COALESCE((NEW.result->>'dry_run')::boolean, false);
    IF NEW.kind = 'mo_create' THEN
      IF NEW.status = 'done' AND NOT v_dry THEN
        UPDATE public.assembly_builds
           SET fb_mo_id = NULLIF(NEW.result->>'fb_mo_id', '')::integer,
               fb_mo_num = COALESCE(NULLIF(NEW.result->>'mo_number', ''), fb_mo_num),
               fb_mo_state = 'issued', fb_mo_error = NULL
         WHERE id = NEW.build_id AND fb_mo_state IN ('queued', 'error');
      ELSIF NEW.status = 'done' THEN
        UPDATE public.assembly_builds SET fb_mo_state = 'error', fb_mo_error = 'Dry run: the bridge did not create the MO (its write switch is off)'
         WHERE id = NEW.build_id AND fb_mo_state = 'queued';
      ELSE
        UPDATE public.assembly_builds SET fb_mo_state = 'error', fb_mo_error = COALESCE(NEW.error, 'The bridge could not create the MO')
         WHERE id = NEW.build_id AND fb_mo_state = 'queued';
      END IF;
    ELSIF NEW.kind = 'mo_cancel' THEN
      IF NEW.status = 'done' AND NOT v_dry THEN
        UPDATE public.assembly_builds SET fb_mo_state = 'cancelled', fb_mo_error = NULL WHERE id = NEW.build_id;
      ELSE
        UPDATE public.assembly_builds SET fb_mo_error = 'MO not cancelled in Fishbowl: ' || COALESCE(NEW.error, 'dry run') WHERE id = NEW.build_id;
      END IF;
    ELSIF NEW.kind = 'mo_close_short' THEN
      IF NEW.status = 'done' AND NOT v_dry THEN
        UPDATE public.assembly_builds SET fb_mo_state = 'closed_short' WHERE id = NEW.build_id AND fb_mo_state = 'issued';
      ELSE
        UPDATE public.assembly_builds SET fb_mo_error = 'MO not closed short in Fishbowl: ' || COALESCE(NEW.error, 'dry run') WHERE id = NEW.build_id;
      END IF;
    ELSIF NEW.kind = 'wo_post' THEN
      -- done, for real: the build stays 'posting' until the read-back sees the post in the mirror.
      IF NEW.status = 'done' AND NOT v_dry THEN
        UPDATE public.assembly_builds SET fb_post_error = NULL WHERE id = NEW.build_id AND fb_post_status = 'posting';
      ELSIF NEW.status = 'done' THEN
        UPDATE public.assembly_builds
           SET fb_post_status = 'post_failed', fb_post_error = 'Dry run: the bridge did not post the build (its write switch is off)'
         WHERE id = NEW.build_id AND fb_post_status = 'posting';
      ELSE
        UPDATE public.assembly_builds
           SET fb_post_status = 'post_failed', fb_post_error = left(COALESCE(NEW.error, 'The bridge could not post the build'), 1000)
         WHERE id = NEW.build_id AND fb_post_status = 'posting';
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fb_push_commands_build_result_trg: %', SQLERRM;     -- never block the bridge's report
  END;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 9. Read-back. As D1 left it, plus:
--    - builds that are posting or post_failed are checked too, and keep that
--      state until the post is actually seen in Fishbowl;
--    - the quantity each component's work-order line used is compared with
--      BOM quantity x (good + bad);
--    - for an automatic post, the scrapped quantity is compared with the bad
--      count. A hand post cannot record scrap, so it is not compared there.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._assembly_verify_posts(p_build_ids uuid[] DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b record; v_mo record; n integer := 0;
  v_good numeric; v_bad numeric; v_built numeric; v_posted numeric; v_wo_used numeric; v_mo_qty numeric; v_scrap numeric;
  v_missing jsonb; v_unexpected jsonb; v_seen jsonb; v_qty jsonb; v_fg_found boolean; v_auto boolean; v_scrap_off boolean; v_new text; v_diff jsonb;
BEGIN
  FOR b IN
    SELECT x.* FROM public.assembly_builds x
     WHERE x.status = 'released' AND x.fb_mo_num IS NOT NULL
       AND x.fb_post_status IN ('ready_to_post', 'posting', 'post_failed', 'posted', 'mismatch')
       AND (p_build_ids IS NULL OR x.id = ANY (p_build_ids))
     FOR UPDATE SKIP LOCKED
  LOOP
    SELECT m.fb_mo_id, m.status, m.status_id INTO v_mo
      FROM public.fb_manufacture_orders m
     WHERE m.mo_num = b.fb_mo_num AND m.removed_at IS NULL
     ORDER BY m.fb_mo_id DESC LIMIT 1;
    IF v_mo.fb_mo_id IS NULL THEN CONTINUE; END IF;                 -- the MO is not in the mirror (yet)

    v_good  := COALESCE(b.good_quantity, 0);
    v_bad   := COALESCE(b.bad_quantity, 0);
    v_built := v_good + v_bad;
    SELECT COALESCE(MAX(i.qty_fulfilled), 0), COALESCE(MAX(i.qty_to_fulfill), b.quantity) INTO v_posted, v_mo_qty
      FROM public.fb_mo_items i
     WHERE i.fb_mo_id = v_mo.fb_mo_id AND i.type_id = 10 AND i.part_num = b.part_number;
    SELECT COALESCE(SUM(wi.qty_used), 0), COALESCE(SUM(wi.qty_scrapped), 0) INTO v_wo_used, v_scrap
      FROM public.fb_wo_items wi JOIN public.fb_work_orders w ON w.fb_wo_id = wi.fb_wo_id
     WHERE w.fb_mo_id = v_mo.fb_mo_id AND wi.type_id = 10 AND wi.part_num = b.part_number;
    v_posted := GREATEST(v_posted, v_wo_used);

    SELECT COALESCE(jsonb_agg(jsonb_build_object('part', e.part, 'lot', e.lot) ORDER BY e.part, e.lot), '[]'::jsonb) INTO v_missing
      FROM (SELECT DISTINCT cl.component_part_number AS part, cl.lot_number AS lot
              FROM public.assembly_component_lots cl WHERE cl.build_id = b.id) e
     WHERE NOT EXISTS (SELECT 1 FROM public.fb_wo_consumed_lots c JOIN public.fb_work_orders w ON w.fb_wo_id = c.fb_wo_id
                        WHERE w.fb_mo_id = v_mo.fb_mo_id AND c.part_num = e.part AND c.lot_number = e.lot AND c.status_id = 40);

    SELECT COALESCE(jsonb_agg(jsonb_build_object('part', a.part, 'lot', a.lot) ORDER BY a.part, a.lot), '[]'::jsonb) INTO v_unexpected
      FROM (SELECT DISTINCT c.part_num AS part, c.lot_number AS lot
              FROM public.fb_wo_consumed_lots c JOIN public.fb_work_orders w ON w.fb_wo_id = c.fb_wo_id
             WHERE w.fb_mo_id = v_mo.fb_mo_id AND c.lot_number IS NOT NULL AND c.status_id = 40) a
     WHERE NOT EXISTS (SELECT 1 FROM public.assembly_component_lots cl
                        WHERE cl.build_id = b.id AND cl.component_part_number = a.part AND cl.lot_number = a.lot);

    -- Quantity used per component, against BOM quantity x pieces built.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('part', e.part, 'expected', e.expected, 'used', e.used) ORDER BY e.part), '[]'::jsonb) INTO v_qty
      FROM (SELECT bi.part_num AS part, SUM(bi.quantity) * v_built AS expected,
                   COALESCE((SELECT SUM(wi.qty_used) FROM public.fb_wo_items wi JOIN public.fb_work_orders w ON w.fb_wo_id = wi.fb_wo_id
                              WHERE w.fb_mo_id = v_mo.fb_mo_id AND wi.type_id = 20 AND wi.part_num = bi.part_num), 0) AS used
              FROM public.fb_boms fb
              JOIN public.fb_bom_items bi ON bi.fb_bom_id = fb.fb_bom_id AND bi.type_id = 20 AND COALESCE(bi.uom_id, 0) <> 4
             WHERE fb.bom_num = b.part_number AND fb.active AND fb.removed_at IS NULL
             GROUP BY bi.part_num) e
     WHERE e.used IS DISTINCT FROM e.expected;

    -- Scrap is compared only when a real automatic post finished for this build.
    v_auto := EXISTS (SELECT 1 FROM public.fb_push_commands c
                       WHERE c.build_id = b.id AND c.kind = 'wo_post' AND c.status = 'done'
                         AND NOT c.dry_run AND NOT COALESCE((c.result->>'dry_run')::boolean, false));
    v_scrap_off := v_auto AND v_scrap IS DISTINCT FROM v_bad;

    v_fg_found := b.assembly_lot_number IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.fb_tags t
       WHERE t.part_num = b.part_number AND t.lot_number = b.assembly_lot_number AND t.removed_at IS NULL);
    SELECT COALESCE(jsonb_agg(DISTINCT t.lot_number), '[]'::jsonb) INTO v_seen
      FROM public.fb_tags t
     WHERE t.part_num = b.part_number AND t.removed_at IS NULL AND t.lot_number IS NOT NULL
       AND t.lot_number IS DISTINCT FROM b.assembly_lot_number
       AND t.tag_created >= b.released_at - interval '2 hours'
       -- a lot SkyNet itself gave to another build of this part is not a surprise
       AND NOT EXISTS (SELECT 1 FROM public.assembly_builds o
                        WHERE o.id <> b.id AND o.part_number = b.part_number AND o.assembly_lot_number = t.lot_number);

    v_new := CASE
      -- nothing (or not everything) posted yet: an automatic post in flight or failed keeps saying so
      WHEN v_posted <= 0 OR v_posted < v_good
           THEN CASE WHEN b.fb_post_status IN ('posting', 'post_failed') THEN b.fb_post_status ELSE 'ready_to_post' END
      WHEN jsonb_array_length(v_missing) > 0 OR jsonb_array_length(v_unexpected) > 0
           OR v_posted > v_good OR jsonb_array_length(v_qty) > 0 OR v_scrap_off                THEN 'mismatch'
      WHEN v_fg_found                                                                     THEN 'verified'
      WHEN jsonb_array_length(v_seen) > 0                                                 THEN 'mismatch'   -- posted, our lot absent, another lot appeared
      ELSE 'posted'                                                                                          -- posted; the finished lot has not reached the mirror yet
    END;

    v_diff := jsonb_build_object(
      'mo_status', v_mo.status, 'mo_qty', v_mo_qty, 'posted_qty', v_posted, 'expected_qty', v_good,
      'lots_missing', v_missing, 'lots_unexpected', v_unexpected,
      'qty_used_off', v_qty, 'built_qty', v_built,
      'scrap_expected', v_bad, 'scrap_posted', v_scrap, 'scrap_compared', v_auto,
      'finished_lot_expected', b.assembly_lot_number, 'finished_lot_found', v_fg_found, 'finished_lots_seen', v_seen,
      'checked_at', now());

    UPDATE public.assembly_builds
       SET fb_mo_id = v_mo.fb_mo_id,
           fb_post_status = v_new,
           fb_post_diff = v_diff,
           fb_posted_qty = v_posted,
           fb_posted_at = CASE WHEN v_good > 0 AND v_posted >= v_good THEN COALESCE(fb_posted_at, now()) ELSE NULL END,
           fb_verified_at = CASE WHEN v_new = 'verified' THEN COALESCE(fb_verified_at, now()) ELSE NULL END,
           -- seen posted without a finished automatic post: it was posted by hand
           fb_post_method = CASE WHEN v_new IN ('posted', 'verified', 'mismatch') AND NOT v_auto THEN 'manual' ELSE fb_post_method END
     WHERE id = b.id
       AND (fb_post_status IS DISTINCT FROM v_new OR fb_posted_qty IS DISTINCT FROM v_posted OR fb_mo_id IS DISTINCT FROM v_mo.fb_mo_id
            OR (fb_post_diff - 'checked_at') IS DISTINCT FROM (v_diff - 'checked_at'));
    IF FOUND THEN n := n + 1; END IF;

    -- Verified with pieces left on the MO (good < built): release the rest in Fishbowl.
    IF v_new = 'verified' AND b.fb_mo_state = 'issued' AND v_mo_qty > v_posted AND v_mo.status_id < 60 THEN
      PERFORM public.fb_push_enqueue_cmd('mo_close_short',
        jsonb_build_object('build_id', b.id, 'build_number', b.build_number, 'mo_number', b.fb_mo_num, 'fb_mo_id', v_mo.fb_mo_id,
                           'write_part_prefix', btrim(public._assembly_setting_text('fb_write_part_prefix', 'SKYTEST-'))),
        'mo_close_short:' || b.id::text, 'Close short MO for build ' || b.build_number, b.id);
    END IF;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public._assembly_verify_posts(uuid[]) FROM PUBLIC, anon, authenticated;

-- The trigger that runs it after every mirror refresh looks at the same states.
CREATE OR REPLACE FUNCTION public._assembly_verify_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    IF EXISTS (SELECT 1 FROM public.assembly_builds
                WHERE status = 'released' AND fb_mo_num IS NOT NULL
                  AND fb_post_status IN ('ready_to_post', 'posting', 'post_failed', 'posted', 'mismatch')) THEN
      PERFORM public._assembly_verify_posts(NULL);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'assembly post verification skipped: %', SQLERRM;
  END;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 10. Ask the bridge again after a failed automatic post (a person's decision)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assembly_build_post_retry(p_build_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.assembly_builds%ROWTYPE; v_block text;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin', 'assembly', 'order_processor']);
  PERFORM public._office_account_only();
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Unknown build'; END IF;
  IF b.status <> 'released' THEN RAISE EXCEPTION 'The build is not released'; END IF;
  IF b.fb_post_status <> 'post_failed' THEN
    RAISE EXCEPTION 'Only a failed automatic post can be retried (this build is %)', b.fb_post_status;
  END IF;
  IF public._assembly_setting_text('fb_auto_post_enabled', 'false') <> 'true' THEN
    RAISE EXCEPTION 'Automatic posting is switched off (see the Fishbowl settings)';
  END IF;
  v_block := public._assembly_auto_post_block(p_build_id);
  IF v_block IS NOT NULL THEN RAISE EXCEPTION 'This build cannot be posted automatically: %', v_block; END IF;
  PERFORM public._assembly_post_enqueue(p_build_id);
END $$;
REVOKE ALL ON FUNCTION public.assembly_build_post_retry(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_build_post_retry(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 11. The post card: two more columns (added at the end) and the two new states
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_assembly_post_cards WITH (security_invoker = true) AS
SELECT b.id, b.build_number, b.build_kind, b.part_number, p.description AS part_description,
       b.quantity, b.good_quantity, b.bad_quantity, b.assembly_lot_number,
       b.fb_mo_num, b.fb_mo_id, b.fb_mo_state, b.fb_mo_error,
       b.fb_post_status, b.fb_posted_qty, b.fb_posted_at, b.fb_verified_at, b.fb_post_diff,
       b.released_at, rb.full_name AS released_by_name,
       mo.status AS mo_status, mo.status_id AS mo_status_id,
       (SELECT jsonb_agg(jsonb_build_object('part', x.part, 'description', x.description, 'lot', x.lot, 'qty', x.qty)
                         ORDER BY x.sort_id NULLS LAST, x.part, x.lot)
          FROM (SELECT cl.component_part_number AS part, cl.lot_number AS lot, cl.qty,
                       bi.part_description AS description, bi.sort_id
                  FROM public.assembly_component_lots cl
                  LEFT JOIN public.fb_boms fb ON fb.bom_num = b.part_number AND fb.active AND fb.removed_at IS NULL
                  LEFT JOIN public.fb_bom_items bi ON bi.fb_bom_id = fb.fb_bom_id AND bi.part_num = cl.component_part_number AND bi.type_id = 20
                 WHERE cl.build_id = b.id) x) AS component_lots,
       (SELECT string_agg(r.so_number || ' #' || r.line_number, ', ' ORDER BY r.so_number, r.line_number)
          FROM public.assembly_requests r WHERE r.build_id = b.id) AS so_lines,
       b.fb_post_method, b.fb_post_error
FROM public.assembly_builds b
LEFT JOIN public.parts p ON p.id = b.part_id
LEFT JOIN public.profiles rb ON rb.id = b.released_by
LEFT JOIN LATERAL (SELECT m.status, m.status_id FROM public.fb_manufacture_orders m
                    WHERE m.mo_num = b.fb_mo_num AND m.removed_at IS NULL ORDER BY m.fb_mo_id DESC LIMIT 1) mo ON true
WHERE b.status = 'released'
  AND (b.fb_post_status IN ('ready_to_post', 'posting', 'post_failed', 'posted', 'mismatch')
       OR (b.fb_post_status = 'verified' AND b.fb_verified_at > now() - interval '24 hours'));
GRANT SELECT ON public.v_assembly_post_cards TO authenticated;
REVOKE ALL ON public.v_assembly_post_cards FROM anon;

-- ---------------------------------------------------------------------------
-- Verify (one row; every value should be true)
-- ---------------------------------------------------------------------------
SELECT
  (SELECT pg_get_constraintdef(oid) LIKE '%wo_post%' FROM pg_constraint WHERE conname = 'fb_push_commands_kind_check')        AS kind_added,
  (SELECT COUNT(*) = 3 FROM public.app_settings WHERE key IN ('fb_auto_post_enabled', 'fb_auto_post_min_version', 'fb_post_dest_location_id')) AS settings_seeded,
  (SELECT value = 'false'::jsonb FROM public.app_settings WHERE key = 'fb_auto_post_enabled')                                  AS auto_post_is_off,
  public._fb_version_at_least('26.11', '26.11') AND public._fb_version_at_least('27.1', '26.11')
    AND NOT public._fb_version_at_least('26.9.1', '26.11') AND NOT public._fb_version_at_least('25.9', '26.11')
    AND NOT public._fb_version_at_least(NULL, '26.11')                                                                        AS version_rule_ok,
  (SELECT pg_get_constraintdef(oid) LIKE '%post_failed%' FROM pg_constraint WHERE conname = 'assembly_builds_fb_post_status_check') AS post_states_added,
  NOT has_function_privilege('anon', 'public.assembly_build_post_retry(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public._assembly_post_enqueue(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public._assembly_post_enqueue(uuid)', 'EXECUTE')                          AS grants_ok;
