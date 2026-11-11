-- ============================================================================
-- S17 Batch D1 — Fishbowl Manufacture Order for an assembly build:
--                 queue, lifecycle, read-back verification, post cards
-- 2026-11-11  ·  D-ASM-01, -10, -11, -24; records D-ASM-52…55
--
-- What this adds
--   1. The push queue takes non-pricing commands (D-ASM-24): new kinds, an
--      idempotency key, a link to the build. Pricing pushes are untouched.
--   2. A build that should have a Fishbowl MO gets one queued at creation
--      (mo_create — the bridge creates and issues it), cancelled with the
--      build (mo_cancel), and closed short once the post is verified
--      (mo_close_short).
--   3. The bridge's answer lands on the build (MO id, number, state, error).
--   4. Read-back: every time the bridge refreshes the MO / WO / tag mirrors,
--      released builds are checked against what was actually posted in
--      Fishbowl — quantity, consumed component lots, finished lot — and move
--      to posted / verified / mismatch with the differences recorded.
--   5. A hand-made MO can be linked by number, so the read-back works even
--      when the bridge did not create the MO.
--
-- SAFE BY DEFAULT: nothing is queued unless app_settings.fb_mo_enabled is
-- true, and then only for builds whose part number starts with
-- app_settings.fb_write_part_prefix. This file seeds fb_mo_enabled = false.
-- TEST is switched on separately (Claude, 2026-11-11) with the prefix
-- 'SKYTEST-', so only the dedicated test parts can reach Fishbowl from TEST.
--
-- Applied on TEST by Claude on 2026-11-11 (migration s17_d1_fishbowl_mo_posting) and
-- exercised there with stand-in mirror rows, since removed: build created → MO
-- queued → bridge answer lands → tablet run → release → post card → read-back
-- posted → verified → close-short queued; a hand-made MO linked by number; a wrong
-- component lot and a wrong finished lot reported as a mismatch, then verified
-- once corrected; a cancelled build withdraws its queued MO.
-- PROD: not yet — Batch D is not complete. Do not run on PROD until told.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Push queue: non-pricing commands (D-ASM-24)
-- ---------------------------------------------------------------------------
ALTER TABLE public.fb_push_commands DROP CONSTRAINT IF EXISTS fb_push_commands_kind_check;
ALTER TABLE public.fb_push_commands ADD CONSTRAINT fb_push_commands_kind_check
  CHECK (kind IN ('prices', 'rules', 'tree', 'groups',
                  'mo_create', 'mo_cancel', 'mo_close_short', 'mo_note', 'inventory_add', 'inventory_scrap'));
ALTER TABLE public.fb_push_commands ALTER COLUMN import_name DROP NOT NULL;
ALTER TABLE public.fb_push_commands
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS build_id uuid REFERENCES public.assembly_builds(id) ON DELETE SET NULL;
-- One live command per key: a failed or cancelled one may be queued again.
CREATE UNIQUE INDEX IF NOT EXISTS fb_push_commands_idempotency_live
  ON public.fb_push_commands (idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status IN ('queued', 'running', 'done');
CREATE INDEX IF NOT EXISTS fb_push_commands_build_idx ON public.fb_push_commands (build_id) WHERE build_id IS NOT NULL;

-- The pricing banner's "last push" is about pricing pushes only.
CREATE OR REPLACE FUNCTION public.fb_push_finish(p_id bigint, p_ok boolean, p_result jsonb DEFAULT NULL::jsonb, p_error text DEFAULT NULL::text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_kind text; v_dry boolean;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration','admin']);
  v_kind := (SELECT c.kind FROM public.fb_push_commands c WHERE c.id = p_id AND c.status = 'running');
  IF v_kind IS NULL THEN RAISE EXCEPTION 'fb_push_finish: command % is not running', p_id; END IF;
  /* a dry run -- asked for, or forced by the bridge's gate (result.dry_run) -- is not a push */
  v_dry := (SELECT c.dry_run FROM public.fb_push_commands c WHERE c.id = p_id) OR COALESCE((p_result->>'dry_run')::boolean, false);
  UPDATE public.fb_push_commands
     SET status = CASE WHEN p_ok THEN 'done' ELSE 'failed' END, finished_at = now(), result = p_result, error = left(p_error, 2000)
   WHERE id = p_id AND status = 'running';
  IF p_ok AND NOT v_dry AND v_kind IN ('prices', 'rules', 'tree', 'groups') THEN
    UPDATE public.fb_sync_state SET last_push_at = now(), last_push_kind = v_kind, updated_at = now() WHERE id = 1;
  END IF;
END $function$;

-- Internal enqueue for non-pricing commands. Never callable from a browser.
CREATE OR REPLACE FUNCTION public.fb_push_enqueue_cmd(p_kind text, p_payload jsonb, p_key text,
                                                      p_note text DEFAULT NULL, p_build_id uuid DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id bigint;
BEGIN
  IF p_kind NOT IN ('mo_create', 'mo_cancel', 'mo_close_short', 'mo_note', 'inventory_add', 'inventory_scrap') THEN
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
-- 2. Settings: the SkyNet-side switch and the part-number fence
-- ---------------------------------------------------------------------------
INSERT INTO public.app_settings (key, value, description, category, label, unit, sort_order) VALUES
  ('fb_mo_enabled', 'false'::jsonb,
   'When true, a new assembly build queues a Fishbowl Manufacture Order for the bridge to create and issue (D-ASM-01).',
   'fishbowl', 'Create Fishbowl MOs for assembly builds', NULL, 10),
  ('fb_write_part_prefix', '"SKYTEST-"'::jsonb,
   'Only builds whose part number starts with this are sent to Fishbowl. Empty = every part. Keep SKYTEST- until cutover (D-ASM-11).',
   'fishbowl', 'Part-number fence for Fishbowl writes', NULL, 20),
  ('fb_mo_number_prefix', '"SKYTEST-"'::jsonb,
   'Put in front of the SkyNet build number to make the Fishbowl MO number. Empty at cutover on PROD; TEST always keeps a prefix so its numbers can never collide with PROD''s.',
   'fishbowl', 'Fishbowl MO number prefix', NULL, 30)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public._assembly_setting_text(p_key text, p_default text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT value #>> '{}' FROM public.app_settings WHERE key = p_key), p_default);
$$;
REVOKE ALL ON FUNCTION public._assembly_setting_text(text, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Build columns for the Fishbowl side
-- ---------------------------------------------------------------------------
ALTER TABLE public.assembly_builds
  ADD COLUMN IF NOT EXISTS fb_mo_state     text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS fb_mo_error     text,
  ADD COLUMN IF NOT EXISTS fb_post_diff    jsonb,
  ADD COLUMN IF NOT EXISTS fb_posted_qty   numeric,
  ADD COLUMN IF NOT EXISTS fb_posted_at    timestamptz,
  ADD COLUMN IF NOT EXISTS fb_verified_at  timestamptz;
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assembly_builds_fb_mo_state_check') THEN
    ALTER TABLE public.assembly_builds ADD CONSTRAINT assembly_builds_fb_mo_state_check
      CHECK (fb_mo_state IN ('none', 'queued', 'issued', 'linked', 'error', 'cancelled', 'closed_short'));
  END IF;
END
$chk$;
COMMENT ON COLUMN public.assembly_builds.fb_mo_state IS
  'none = no Fishbowl MO wanted; queued = waiting for the bridge; issued = bridge created and issued it; linked = a hand-made MO linked by number; error = the bridge could not create it (see fb_mo_error); cancelled; closed_short.';

-- Should this build have a bridge-made MO?
CREATE OR REPLACE FUNCTION public._assembly_mo_wanted(p_kind text, p_part_number text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public._assembly_setting_text('fb_mo_enabled', 'false') = 'true'
     AND p_kind IN ('order', 'stock', 'special')          -- rework posts by scrap + add (D-ASM-16); Giza posting is unchanged
     AND left(p_part_number, length(public._assembly_setting_text('fb_write_part_prefix', 'SKYTEST-')))
         = public._assembly_setting_text('fb_write_part_prefix', 'SKYTEST-');
$$;
REVOKE ALL ON FUNCTION public._assembly_mo_wanted(text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._assembly_mo_enqueue_create(p_build_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.assembly_builds%ROWTYPE; v_num text;
BEGIN
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id;
  v_num := public._assembly_setting_text('fb_mo_number_prefix', 'SKYTEST-') || b.build_number;
  UPDATE public.assembly_builds SET fb_mo_num = v_num, fb_mo_state = 'queued', fb_mo_error = NULL WHERE id = p_build_id;
  PERFORM public.fb_push_enqueue_cmd(
    'mo_create',
    jsonb_build_object('build_id', b.id, 'build_number', b.build_number, 'mo_number', v_num,
                       'bom_number', b.part_number, 'quantity', b.quantity, 'issue', true,
                       'note', format('SkyNet assembly build %s (%s)', b.build_number, b.build_kind),
                       'write_part_prefix', public._assembly_setting_text('fb_write_part_prefix', 'SKYTEST-')),
    'mo_create:' || b.id::text,
    'Assembly build ' || b.build_number,
    b.id);
END $$;
REVOKE ALL ON FUNCTION public._assembly_mo_enqueue_create(uuid) FROM PUBLIC, anon, authenticated;

-- A new build queues its MO. A failure here must never stop the build from being created.
CREATE OR REPLACE FUNCTION public.assembly_builds_mo_create_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public._assembly_mo_wanted(NEW.build_kind, NEW.part_number) THEN RETURN NULL; END IF;
  BEGIN
    PERFORM public._assembly_mo_enqueue_create(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.assembly_builds SET fb_mo_state = 'error', fb_mo_error = 'Could not queue the Fishbowl MO: ' || SQLERRM WHERE id = NEW.id;
  END;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS assembly_builds_mo_create ON public.assembly_builds;
CREATE TRIGGER assembly_builds_mo_create AFTER INSERT ON public.assembly_builds
  FOR EACH ROW EXECUTE FUNCTION public.assembly_builds_mo_create_trg();

-- A cancelled build takes its MO with it.
CREATE OR REPLACE FUNCTION public.assembly_builds_mo_cancel_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' AND NEW.fb_mo_state IN ('queued', 'issued', 'error') THEN
    BEGIN
      -- not picked up by the bridge yet: just withdraw the command
      UPDATE public.fb_push_commands SET status = 'cancelled', finished_at = now()
       WHERE build_id = NEW.id AND kind = 'mo_create' AND status = 'queued';
      IF FOUND OR NEW.fb_mo_state = 'error' THEN
        UPDATE public.assembly_builds SET fb_mo_state = 'cancelled' WHERE id = NEW.id;
      ELSE
        PERFORM public.fb_push_enqueue_cmd('mo_cancel',
          jsonb_build_object('build_id', NEW.id, 'build_number', NEW.build_number, 'mo_number', NEW.fb_mo_num, 'fb_mo_id', NEW.fb_mo_id,
                             'write_part_prefix', public._assembly_setting_text('fb_write_part_prefix', 'SKYTEST-')),
          'mo_cancel:' || NEW.id::text, 'Cancel MO for build ' || NEW.build_number, NEW.id);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.assembly_builds SET fb_mo_error = 'Could not queue the MO cancel: ' || SQLERRM WHERE id = NEW.id;
    END;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS assembly_builds_mo_cancel ON public.assembly_builds;
CREATE TRIGGER assembly_builds_mo_cancel AFTER UPDATE OF status ON public.assembly_builds
  FOR EACH ROW EXECUTE FUNCTION public.assembly_builds_mo_cancel_trg();

-- ---------------------------------------------------------------------------
-- 4. The bridge's answer lands on the build
--    Expected result of mo_create: {"fb_mo_id": 1234, "mo_number": "…", "status": "Issued", "created": true}
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
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fb_push_commands_build_result_trg: %', SQLERRM;     -- never block the bridge's report
  END;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS fb_push_commands_build_result ON public.fb_push_commands;
CREATE TRIGGER fb_push_commands_build_result AFTER UPDATE OF status ON public.fb_push_commands
  FOR EACH ROW EXECUTE FUNCTION public.fb_push_commands_build_result_trg();

-- ---------------------------------------------------------------------------
-- 5. Read-back: what was actually posted in Fishbowl, against the build
--    posted qty  = finished-good quantity fulfilled on the MO
--    lots        = (part, lot) pairs consumed by the MO's work order(s)
--    finished lot = a tag of the finished part carrying the build's lot number
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._assembly_verify_posts(p_build_ids uuid[] DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b record; v_mo record; n integer := 0;
  v_good numeric; v_posted numeric; v_wo_used numeric; v_mo_qty numeric;
  v_missing jsonb; v_unexpected jsonb; v_seen jsonb; v_fg_found boolean; v_new text; v_diff jsonb;
BEGIN
  FOR b IN
    SELECT x.* FROM public.assembly_builds x
     WHERE x.status = 'released' AND x.fb_mo_num IS NOT NULL
       AND x.fb_post_status IN ('ready_to_post', 'posted', 'mismatch')
       AND (p_build_ids IS NULL OR x.id = ANY (p_build_ids))
     FOR UPDATE SKIP LOCKED
  LOOP
    SELECT m.fb_mo_id, m.status, m.status_id INTO v_mo
      FROM public.fb_manufacture_orders m
     WHERE m.mo_num = b.fb_mo_num AND m.removed_at IS NULL
     ORDER BY m.fb_mo_id DESC LIMIT 1;
    IF v_mo.fb_mo_id IS NULL THEN CONTINUE; END IF;                 -- the MO is not in the mirror (yet)

    v_good := COALESCE(b.good_quantity, 0);
    SELECT COALESCE(MAX(i.qty_fulfilled), 0), COALESCE(MAX(i.qty_to_fulfill), b.quantity) INTO v_posted, v_mo_qty
      FROM public.fb_mo_items i
     WHERE i.fb_mo_id = v_mo.fb_mo_id AND i.type_id = 10 AND i.part_num = b.part_number;
    SELECT COALESCE(SUM(wi.qty_used), 0) INTO v_wo_used
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
      WHEN v_posted <= 0 OR v_posted < v_good                                              THEN 'ready_to_post'
      WHEN jsonb_array_length(v_missing) > 0 OR jsonb_array_length(v_unexpected) > 0
           OR v_posted > v_good                                                           THEN 'mismatch'
      WHEN v_fg_found                                                                     THEN 'verified'
      WHEN jsonb_array_length(v_seen) > 0                                                 THEN 'mismatch'   -- posted, our lot absent, another lot appeared
      ELSE 'posted'                                                                                          -- posted; the finished lot has not reached the mirror yet
    END;

    v_diff := jsonb_build_object(
      'mo_status', v_mo.status, 'mo_qty', v_mo_qty, 'posted_qty', v_posted, 'expected_qty', v_good,
      'lots_missing', v_missing, 'lots_unexpected', v_unexpected,
      'finished_lot_expected', b.assembly_lot_number, 'finished_lot_found', v_fg_found, 'finished_lots_seen', v_seen,
      'checked_at', now());

    UPDATE public.assembly_builds
       SET fb_mo_id = v_mo.fb_mo_id,
           fb_post_status = v_new,
           fb_post_diff = v_diff,
           fb_posted_qty = v_posted,
           fb_posted_at = CASE WHEN v_good > 0 AND v_posted >= v_good THEN COALESCE(fb_posted_at, now()) ELSE NULL END,
           fb_verified_at = CASE WHEN v_new = 'verified' THEN COALESCE(fb_verified_at, now()) ELSE NULL END
     WHERE id = b.id
       AND (fb_post_status IS DISTINCT FROM v_new OR fb_posted_qty IS DISTINCT FROM v_posted OR fb_mo_id IS DISTINCT FROM v_mo.fb_mo_id
            OR (fb_post_diff - 'checked_at') IS DISTINCT FROM (v_diff - 'checked_at'));
    IF FOUND THEN n := n + 1; END IF;

    -- Verified with pieces left on the MO (good < built): release the rest in Fishbowl.
    IF v_new = 'verified' AND b.fb_mo_state = 'issued' AND v_mo_qty > v_posted AND v_mo.status_id < 60 THEN
      PERFORM public.fb_push_enqueue_cmd('mo_close_short',
        jsonb_build_object('build_id', b.id, 'build_number', b.build_number, 'mo_number', b.fb_mo_num, 'fb_mo_id', v_mo.fb_mo_id,
                           'write_part_prefix', public._assembly_setting_text('fb_write_part_prefix', 'SKYTEST-')),
        'mo_close_short:' || b.id::text, 'Close short MO for build ' || b.build_number, b.id);
    END IF;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public._assembly_verify_posts(uuid[]) FROM PUBLIC, anon, authenticated;

-- Runs after every mirror refresh. It must never make the bridge's upsert fail.
CREATE OR REPLACE FUNCTION public._assembly_verify_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    IF EXISTS (SELECT 1 FROM public.assembly_builds
                WHERE status = 'released' AND fb_mo_num IS NOT NULL AND fb_post_status IN ('ready_to_post', 'posted', 'mismatch')) THEN
      PERFORM public._assembly_verify_posts(NULL);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'assembly post verification skipped: %', SQLERRM;
  END;
  RETURN NULL;
END $$;

DO $trg$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fb_manufacture_orders', 'fb_mo_items', 'fb_work_orders', 'fb_wo_items', 'fb_wo_consumed_lots', 'fb_tags'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_assembly_verify', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public._assembly_verify_trg()',
                   t || '_assembly_verify', t);
  END LOOP;
END
$trg$;

-- Office actions on the post card (admin, assembly lead, order processor — never a tablet-only account)
CREATE OR REPLACE FUNCTION public.assembly_verify_posts(p_build_ids uuid[] DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._fb_gate(ARRAY['admin', 'assembly', 'order_processor']);
  PERFORM public._office_account_only();
  RETURN public._assembly_verify_posts(p_build_ids);
END $$;
REVOKE ALL ON FUNCTION public.assembly_verify_posts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_verify_posts(uuid[]) TO authenticated, service_role;

-- Link a hand-made MO by its Fishbowl number (the fallback when the bridge did not create it).
CREATE OR REPLACE FUNCTION public.assembly_build_link_mo(p_build_id uuid, p_mo_num text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._fb_gate(ARRAY['admin', 'assembly', 'order_processor']);
  PERFORM public._office_account_only();
  IF p_mo_num IS NULL OR btrim(p_mo_num) = '' THEN RAISE EXCEPTION 'Enter the Fishbowl MO number'; END IF;
  UPDATE public.fb_push_commands SET status = 'cancelled', finished_at = now()
   WHERE build_id = p_build_id AND kind = 'mo_create' AND status = 'queued';
  UPDATE public.assembly_builds
     SET fb_mo_num = btrim(p_mo_num), fb_mo_id = NULL, fb_mo_state = 'linked', fb_mo_error = NULL
   WHERE id = p_build_id AND status <> 'cancelled' AND fb_post_status NOT IN ('verified', 'not_applicable');
  IF NOT FOUND THEN RAISE EXCEPTION 'This build cannot be linked to an MO in its current state'; END IF;
  PERFORM public._assembly_verify_posts(ARRAY[p_build_id]);
END $$;
REVOKE ALL ON FUNCTION public.assembly_build_link_mo(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_build_link_mo(uuid, text) TO authenticated, service_role;

-- Ask the bridge again after an error.
CREATE OR REPLACE FUNCTION public.assembly_build_mo_retry(p_build_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.assembly_builds%ROWTYPE;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin', 'assembly', 'order_processor']);
  PERFORM public._office_account_only();
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Unknown build'; END IF;
  IF b.status = 'cancelled' THEN RAISE EXCEPTION 'The build is cancelled'; END IF;
  IF b.fb_mo_state NOT IN ('error', 'none') THEN RAISE EXCEPTION 'The Fishbowl MO is already % for this build', b.fb_mo_state; END IF;
  IF NOT public._assembly_mo_wanted(b.build_kind, b.part_number) THEN
    RAISE EXCEPTION 'Fishbowl MOs are switched off for this part (see the Fishbowl settings)';
  END IF;
  PERFORM public._assembly_mo_enqueue_create(p_build_id);
END $$;
REVOKE ALL ON FUNCTION public.assembly_build_mo_retry(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_build_mo_retry(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Views
-- ---------------------------------------------------------------------------
-- The board view lists b.*, so it is recreated to pick up the new columns.
DROP VIEW IF EXISTS public.v_assembly_builds_board;
CREATE VIEW public.v_assembly_builds_board WITH (security_invoker = true) AS
SELECT b.*,
       p.description AS part_description, p.assembly_family,
       bn.name AS bench_name,
       pa.full_name AS assigned_name, pa.avatar_icon AS assigned_avatar_icon, pa.avatar_color AS assigned_avatar_color,
       t.name AS template_name, t.status AS template_status,
       (SELECT COUNT(*)::int FROM public.assembly_requests r WHERE r.build_id = b.id) AS request_count,
       (SELECT COUNT(*)::int FROM public.assembly_sessions s WHERE s.build_id = b.id AND s.clock_out IS NULL) AS open_sessions,
       (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(s.clock_out, now()) - s.clock_in)) / 60), 0)::numeric(10,1)
          FROM public.assembly_sessions s WHERE s.build_id = b.id) AS minutes_total,
       (SELECT COUNT(*)::int FROM public.assembly_component_lots cl WHERE cl.build_id = b.id) AS lots_recorded
FROM public.assembly_builds b
LEFT JOIN public.parts p ON p.id = b.part_id
LEFT JOIN public.assembly_benches bn ON bn.id = b.bench_id
LEFT JOIN public.profiles pa ON pa.id = b.assigned_to
LEFT JOIN public.assembly_checklist_templates t ON t.id = b.checklist_template_id;
GRANT SELECT ON public.v_assembly_builds_board TO authenticated;
REVOKE ALL ON public.v_assembly_builds_board FROM anon;

-- Ashley's post card: what to key in Quick Fulfill, and what came back.
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
          FROM public.assembly_requests r WHERE r.build_id = b.id) AS so_lines
FROM public.assembly_builds b
LEFT JOIN public.parts p ON p.id = b.part_id
LEFT JOIN public.profiles rb ON rb.id = b.released_by
LEFT JOIN LATERAL (SELECT m.status, m.status_id FROM public.fb_manufacture_orders m
                    WHERE m.mo_num = b.fb_mo_num AND m.removed_at IS NULL ORDER BY m.fb_mo_id DESC LIMIT 1) mo ON true
WHERE b.status = 'released'
  AND (b.fb_post_status IN ('ready_to_post', 'posted', 'mismatch')
       OR (b.fb_post_status = 'verified' AND b.fb_verified_at > now() - interval '24 hours'));
GRANT SELECT ON public.v_assembly_post_cards TO authenticated;
REVOKE ALL ON public.v_assembly_post_cards FROM anon;
