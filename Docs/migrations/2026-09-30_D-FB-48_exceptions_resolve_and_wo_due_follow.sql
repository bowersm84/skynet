/* ==========================================================================================
   D-FB-48 / D-DATE-04  -  Exceptions resolve in the Order Queue; part changes are exceptions;
                           work_orders.due_date follows its customer-order lines
   Delivered 2026-09-30.  TEST: applied by Claude.  PROD: run by Matt BEFORE pushing the code.

   WHY: Matt, 2026-09-30 - every order is driven by Fishbowl and the Order Queue; nobody changes
   customer orders directly in SkyNet. Resolving an exception still sent people to Customer Orders,
   a Fishbowl date change never reached the WO's own due date (35 of 101 open PROD WOs stale), and a
   product change on a linked line was logged but not raised.

   CONTENTS (Block 1, run once; idempotent)
     1a  _wo_resync_due_date(wo)        - SQL twin of lib/woDueDate.js resyncWODueDates (D-DATE-01/02)
     1b  trg_co_line_due_resync         - a CO line's due date changes -> its open WOs follow (D-DATE-04)
     1c  wo_resync_all_due_dates(dry)   - the one-shot for WOs already stale
     1d  co_cancel_line(line, reason)   - the Customer Orders cancel sequence, now one server function
     1e  fb_resolve_exception(ev, act)  - Apply Fishbowl quantity / Cancel CO line(s), then acknowledge
     1f  fb_ingest_delta patch          - product change on a linked open line -> exception
     1g  co_line_set_components         - restores the D-FB-42 gate (D-FB-47 was TEST-only and is retired)

   HOW TO RUN - four independent blocks, one at a time:
     Block 1  FUNCTIONS
     Block 2  DRY RUN   SELECT wo_resync_all_due_dates(true)   - paste to Claude before Block 3
     Block 3  LIVE      SELECT wo_resync_all_due_dates(false)
     Block 4  VERIFY
   ========================================================================================== */

/* ================================= Block 1: FUNCTIONS ================================= */

/* ---- 1a. one WO's derived due date: earliest real due date across its active CO allocations ----
   Same rule as resyncWODueDates (both updated this round): skipped when the WO is complete or
   cancelled, has no active allocation (stock-only WOs keep their manual date), or no line has a
   real date; dates before 2000-01-01 are Fishbowl typos and ignored (D-CODATE-02b). */
CREATE OR REPLACE FUNCTION public._wo_resync_due_date(p_wo_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_status   text;
  v_due      date;
  v_n        integer;
  v_earliest date;
  v_wo       text;
BEGIN
  SELECT status, due_date, wo_number INTO v_status, v_due, v_wo FROM public.work_orders WHERE id = p_wo_id FOR UPDATE;
  IF NOT FOUND OR v_status IN ('complete', 'cancelled') THEN RETURN NULL; END IF;
  SELECT count(*), min(col.due_date) FILTER (WHERE col.due_date >= DATE '2000-01-01')
    INTO v_n, v_earliest
    FROM public.customer_order_allocations a
    JOIN public.customer_order_lines col ON col.id = a.customer_order_line_id
   WHERE a.work_order_id = p_wo_id AND a.is_active;
  IF v_n = 0 OR v_earliest IS NULL OR v_earliest IS NOT DISTINCT FROM v_due THEN RETURN NULL; END IF;
  UPDATE public.work_orders SET due_date = v_earliest WHERE id = p_wo_id;
  RETURN jsonb_build_object('work_order_id', p_wo_id, 'wo_number', v_wo, 'from', v_due, 'to', v_earliest);
END;
$function$;
REVOKE ALL ON FUNCTION public._wo_resync_due_date(uuid) FROM PUBLIC, anon, authenticated;

/* ---- 1b. follow on every due-date change, whoever makes it (ingest, split, Edit CO) ----
   Never allowed to fail the statement that fired it: ingest runs inside this trigger's reach. */
CREATE OR REPLACE FUNCTION public.trg_co_line_due_resync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  r record;
  v jsonb;
BEGIN
  FOR r IN
    SELECT DISTINCT a.work_order_id FROM public.customer_order_allocations a
     WHERE a.customer_order_line_id = NEW.id AND a.is_active
  LOOP
    BEGIN
      v := public._wo_resync_due_date(r.work_order_id);
      IF v IS NOT NULL THEN
        INSERT INTO public.audit_logs (event_type, operator_id, details)
        VALUES ('wo_due_date_followed_co', auth.uid(),
                v || jsonb_build_object('customer_order_line_id', NEW.id, 'rule', 'D-DATE-04'));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.audit_logs (event_type, details)
      VALUES ('wo_due_date_resync_failed', jsonb_build_object('work_order_id', r.work_order_id,
              'customer_order_line_id', NEW.id, 'error', SQLERRM));
    END;
  END LOOP;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.trg_co_line_due_resync() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_co_line_due_resync ON public.customer_order_lines;
CREATE TRIGGER trg_co_line_due_resync
  AFTER UPDATE OF due_date ON public.customer_order_lines
  FOR EACH ROW WHEN (OLD.due_date IS DISTINCT FROM NEW.due_date)
  EXECUTE FUNCTION public.trg_co_line_due_resync();

/* ---- 1c. one-shot for the WOs already stale ---- */
CREATE OR REPLACE FUNCTION public.wo_resync_all_due_dates(p_dry_run boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_changes jsonb := '[]'::jsonb;
  v         jsonb;
  r         record;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin']);
  BEGIN
    FOR r IN
      SELECT DISTINCT w.id, w.wo_number
        FROM public.work_orders w
        JOIN public.customer_order_allocations a ON a.work_order_id = w.id AND a.is_active
       WHERE w.status NOT IN ('complete', 'cancelled')
       ORDER BY w.wo_number
    LOOP
      v := public._wo_resync_due_date(r.id);
      IF v IS NOT NULL THEN
        v_changes := v_changes || (v - 'work_order_id');
        INSERT INTO public.audit_logs (event_type, operator_id, details)
        VALUES ('wo_due_date_followed_co', auth.uid(), v || jsonb_build_object('rule', 'D-DATE-04 one-shot'));
      END IF;
    END LOOP;
    IF p_dry_run THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'D-DATE-04 DRYRUN';
    END IF;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'D-DATE-04 DRYRUN' THEN RAISE; END IF;
  END;
  RETURN jsonb_build_object('dry_run', p_dry_run, 'wos_changed', jsonb_array_length(v_changes), 'changes', v_changes);
END;
$function$;
REVOKE ALL ON FUNCTION public.wo_resync_all_due_dates(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wo_resync_all_due_dates(boolean) TO authenticated;

/* ---- 1d. cancel a CO line: the four steps Customer Orders ran in the browser, in the same order ----
   1 line -> cancelled (first, so the allocation trigger's status recalc leaves it alone),
   2 read its active WOs, 3 deactivate the allocations, 4 flag those WOs has_cancelled_allocation;
   then (D-DATE-04) re-derive their due dates, since the earliest date may have been this line. */
CREATE OR REPLACE FUNCTION public.co_cancel_line(p_line_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_line record;
  v_wos  uuid[];
  v_wo   uuid;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin', 'order_processor']);
  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'A reason is required to cancel a CO line' USING ERRCODE = '22023';
  END IF;
  SELECT col.id, col.status, col.line_number, co.co_number, p.part_number::text AS part_number
    INTO v_line
    FROM public.customer_order_lines col
    JOIN public.customer_orders co ON co.id = col.customer_order_id
    JOIN public.parts p ON p.id = col.part_id
   WHERE col.id = p_line_id
     FOR UPDATE OF col;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CO line not found' USING ERRCODE = '22023';
  END IF;
  IF v_line.status = 'cancelled' THEN
    RETURN jsonb_build_object('co_number', v_line.co_number, 'line_number', v_line.line_number, 'already_cancelled', true);
  END IF;
  IF v_line.status = 'complete' THEN
    RAISE EXCEPTION '% line #% (%) is complete and cannot be cancelled', v_line.co_number, v_line.line_number, v_line.part_number
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.customer_order_lines
     SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_uid, cancel_reason = btrim(p_reason)
   WHERE id = p_line_id;
  SELECT array_agg(DISTINCT work_order_id) INTO v_wos
    FROM public.customer_order_allocations WHERE customer_order_line_id = p_line_id AND is_active;
  UPDATE public.customer_order_allocations
     SET is_active = false, deactivated_at = now(), deactivated_by = v_uid
   WHERE customer_order_line_id = p_line_id AND is_active;
  IF v_wos IS NOT NULL THEN
    UPDATE public.work_orders SET has_cancelled_allocation = true WHERE id = ANY (v_wos);
    FOREACH v_wo IN ARRAY v_wos LOOP
      PERFORM public._wo_resync_due_date(v_wo);
    END LOOP;
  END IF;

  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('co_line_cancelled', v_uid, jsonb_build_object('customer_order_line_id', p_line_id, 'co_number', v_line.co_number,
          'line_number', v_line.line_number, 'part_number', v_line.part_number, 'reason', btrim(p_reason),
          'work_orders', (SELECT jsonb_agg(wo_number ORDER BY wo_number) FROM public.work_orders WHERE id = ANY (COALESCE(v_wos, ARRAY[]::uuid[])))));
  RETURN jsonb_build_object('co_number', v_line.co_number, 'line_number', v_line.line_number, 'part_number', v_line.part_number,
          'work_orders', (SELECT COALESCE(jsonb_agg(wo_number ORDER BY wo_number), '[]'::jsonb) FROM public.work_orders WHERE id = ANY (COALESCE(v_wos, ARRAY[]::uuid[]))));
END;
$function$;
REVOKE ALL ON FUNCTION public.co_cancel_line(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.co_cancel_line(uuid, text) TO authenticated;

/* ---- 1e. resolve an exception where it is raised, then acknowledge it ----
   apply_qty     a quantity cut that was held back (D-FB-14): once the WO allocation has been reduced
                 in Edit WO, apply the Fishbowl change to the CO line. Refuses, naming the WO, while
                 allocated + fulfilled would exceed the new quantity.
   cancel_lines  line removed / voided, SO voided / cancelled / expired / deleted, product changed:
                 cancel the open CO line(s) through co_cancel_line with a reason built from the event.
                 A live Fishbowl line whose product changed goes back to the Queue as pending, resolved
                 to its new part. Refuses when a target CO line also carries other Fishbowl lines
                 (a D-FB-26 combination on a WO) - that one is resolved by hand and acknowledged. */
CREATE OR REPLACE FUNCTION public.fb_resolve_exception(p_event_id bigint, p_action text, p_note text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  e         public.fb_sync_events%ROWTYPE;
  v_so      public.fb_sales_orders%ROWTYPE;
  v_line    public.fb_sales_order_lines%ROWTYPE;
  v_col     record;
  v_delta   numeric;
  v_new     integer;
  v_alloc   integer;
  v_wos     text;
  v_targets uuid[];
  v_t       uuid;
  v_others  text;
  v_reason  text;
  v_label   text;
  v_key     text;
  v_pid     uuid;
  v_ptype   text;
  v_result  jsonb := '{}'::jsonb;
  v_done    jsonb := '[]'::jsonb;
BEGIN
  PERFORM public._fb_gate(ARRAY['order_processor', 'admin']);
  SELECT * INTO e FROM public.fb_sync_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exception % not found', p_event_id USING ERRCODE = '22023'; END IF;
  IF NOT e.requires_ack THEN RAISE EXCEPTION 'Event % is not an exception', p_event_id USING ERRCODE = '22023'; END IF;
  IF e.acknowledged_at IS NOT NULL THEN RAISE EXCEPTION 'Exception % is already resolved', p_event_id USING ERRCODE = '22023'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('apply_qty', 'cancel_lines') THEN
    RAISE EXCEPTION 'Unknown action % (apply_qty | cancel_lines)', COALESCE(p_action, 'NULL') USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_so FROM public.fb_sales_orders WHERE fb_so_id = e.fb_so_id;
  IF e.fb_soitem_id IS NOT NULL THEN
    SELECT * INTO v_line FROM public.fb_sales_order_lines WHERE fb_soitem_id = e.fb_soitem_id;
  END IF;

  IF p_action = 'apply_qty' THEN
    IF NOT (e.changes ? 'qty_ordered') OR jsonb_typeof(e.changes -> 'qty_ordered') <> 'object' OR v_line.fb_soitem_id IS NULL THEN
      RAISE EXCEPTION 'Exception % is not a quantity change on a line', p_event_id USING ERRCODE = '22023';
    END IF;
    v_delta := (e.changes -> 'qty_ordered' ->> 'new')::numeric - (e.changes -> 'qty_ordered' ->> 'old')::numeric;
    SELECT col.id, col.quantity_ordered, col.quantity_fulfilled, col.status, col.line_number, co.co_number
      INTO v_col
      FROM public.customer_order_lines col JOIN public.customer_orders co ON co.id = col.customer_order_id
     WHERE col.id = v_line.customer_order_line_id
       FOR UPDATE OF col;
    IF v_col.id IS NULL THEN
      RAISE EXCEPTION 'Fishbowl line % is no longer linked to a CO line - Acknowledge instead', v_line.line_number USING ERRCODE = '22023';
    END IF;
    IF v_col.status NOT IN ('not_started', 'in_progress') THEN
      RAISE EXCEPTION '% line #% is % - Acknowledge instead', v_col.co_number, v_col.line_number, v_col.status USING ERRCODE = '22023';
    END IF;
    v_new := v_col.quantity_ordered + round(v_delta)::integer;
    SELECT COALESCE(sum(a.quantity_allocated), 0), string_agg(DISTINCT w.wo_number, ', ')
      INTO v_alloc, v_wos
      FROM public.customer_order_allocations a JOIN public.work_orders w ON w.id = a.work_order_id
     WHERE a.customer_order_line_id = v_col.id AND a.is_active;
    IF v_new <= 0 THEN
      RAISE EXCEPTION 'Fishbowl leaves nothing to make on % line #% - use Cancel CO line', v_col.co_number, v_col.line_number USING ERRCODE = '22023';
    END IF;
    IF v_new < v_alloc + v_col.quantity_fulfilled THEN
      RAISE EXCEPTION '% line #% would drop to % pcs, but % are allocated (%) and % fulfilled - reduce the allocation in Edit WO to % or less, then apply',
        v_col.co_number, v_col.line_number, v_new, v_alloc, v_wos, v_col.quantity_fulfilled, v_new - v_col.quantity_fulfilled
        USING ERRCODE = '22023';
    END IF;
    UPDATE public.customer_order_lines SET quantity_ordered = v_new WHERE id = v_col.id;
    PERFORM public.recalc_co_line_status(v_col.id);
    v_result := jsonb_build_object('action', 'apply_qty', 'co_number', v_col.co_number, 'line_number', v_col.line_number,
                                   'from', v_col.quantity_ordered, 'to', v_new);
  ELSE
    IF e.event_type IN ('line_removed', 'line_status_changed', 'line_changed') AND v_line.fb_soitem_id IS NOT NULL THEN
      SELECT array_agg(col.id) INTO v_targets
        FROM public.customer_order_lines col
       WHERE col.id = v_line.customer_order_line_id AND col.status IN ('not_started', 'in_progress');
      v_label := CASE e.event_type WHEN 'line_removed' THEN 'line removed'
                                   WHEN 'line_status_changed' THEN 'line voided/cancelled'
                                   ELSE 'product changed' END;
    ELSIF e.event_type IN ('so_status_changed', 'so_removed') THEN
      SELECT array_agg(DISTINCT col.id) INTO v_targets
        FROM public.fb_sales_order_lines l
        JOIN public.customer_order_lines col ON col.id = l.customer_order_line_id
       WHERE l.fb_so_id = e.fb_so_id AND col.status IN ('not_started', 'in_progress');
      v_label := CASE e.event_type WHEN 'so_removed' THEN 'SO deleted' ELSE 'SO voided/cancelled/expired' END;
    ELSE
      RAISE EXCEPTION 'Exception % (%) has no CO line to cancel - Acknowledge instead', p_event_id, e.event_type USING ERRCODE = '22023';
    END IF;
    IF v_targets IS NULL THEN
      RAISE EXCEPTION 'No open CO line to cancel for this exception - Acknowledge instead' USING ERRCODE = '22023';
    END IF;
    FOREACH v_t IN ARRAY v_targets LOOP
      SELECT string_agg(l.line_number::text, ', ' ORDER BY l.line_number) INTO v_others
        FROM public.fb_sales_order_lines l
       WHERE l.customer_order_line_id = v_t AND l.removed_at IS NULL
         AND l.fb_soitem_id IS DISTINCT FROM e.fb_soitem_id
         AND e.event_type NOT IN ('so_status_changed', 'so_removed');
      IF v_others IS NOT NULL THEN
        RAISE EXCEPTION 'That CO line also carries Fishbowl line(s) % (combined before D-FB-43) - resolve it by hand and Acknowledge', v_others
          USING ERRCODE = '22023';
      END IF;
    END LOOP;
    v_reason := concat_ws(' - ',
      'Fishbowl ' || v_label || ' (SO ' || COALESCE(v_so.so_number, e.fb_so_id::text)
        || CASE WHEN v_line.line_number IS NOT NULL AND e.event_type NOT IN ('so_status_changed', 'so_removed') THEN ' line ' || v_line.line_number ELSE '' END || ')',
      NULLIF(btrim(COALESCE(p_note, '')), ''));
    FOREACH v_t IN ARRAY v_targets LOOP
      v_done := v_done || public.co_cancel_line(v_t, v_reason);
    END LOOP;
    v_result := jsonb_build_object('action', 'cancel_lines', 'cancelled', v_done);

    /* product changed on a live, open Fishbowl line: back to the Queue as the new part */
    IF e.event_type = 'line_changed' AND e.changes ? 'product_num'
       AND v_line.removed_at IS NULL AND v_line.status_id NOT IN (50, 60, 70, 75, 95) THEN
      v_key := upper(btrim(COALESCE(v_line.part_num, v_line.product_num)));
      SELECT id, part_type INTO v_pid, v_ptype FROM public.parts WHERE upper(btrim(part_number)) = v_key LIMIT 1;
      UPDATE public.fb_sales_order_lines
         SET customer_order_line_id = NULL,
             part_id = v_pid,
             resolution = CASE WHEN v_pid IS NOT NULL THEN 'part' WHEN v_key ~ '^(SK|ZG|QL)' THEN 'unlisted_skybolt' ELSE 'unlisted' END,
             disposition = CASE WHEN v_pid IS NOT NULL AND v_ptype = 'purchased' THEN 'purchased'
                                WHEN v_pid IS NULL AND v_key !~ '^(SK|ZG|QL)' THEN 'unlisted'
                                ELSE 'pending' END,
             disposition_by = v_uid, disposition_at = now(),
             disposition_note = 'Back to the queue: product changed in Fishbowl, old CO line cancelled (D-FB-48)'
       WHERE fb_soitem_id = v_line.fb_soitem_id;
      v_result := v_result || jsonb_build_object('requeued_fb_line', v_line.line_number, 'new_part_in_skynet', v_pid IS NOT NULL);
    END IF;
  END IF;

  UPDATE public.fb_sync_events SET acknowledged_by = v_uid, acknowledged_at = now() WHERE id = p_event_id;
  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('fb_exception_resolved', v_uid, jsonb_build_object('event_id', p_event_id, 'event_type', e.event_type,
          'so_number', v_so.so_number, 'action', p_action, 'note', NULLIF(btrim(COALESCE(p_note, '')), ''), 'result', v_result));
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.fb_resolve_exception(bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fb_resolve_exception(bigint, text, text) TO authenticated;

/* ---- 1f. fb_ingest_delta: a product change on a linked open CO line is an exception ----
   Patched in place (md5 of the D-FB-45 version, identical on TEST and PROD; anchor must occur once).
   Re-running is a no-op. */
DO $patch$
DECLARE
  v_def    text := pg_get_functiondef('public.fb_ingest_delta(jsonb)'::regprocedure);
  v_nl     text := chr(13) || chr(10);
  v_anchor text;
  v_n      integer;
BEGIN
  IF position('D-FB-48' in v_def) > 0 THEN
    RAISE NOTICE 'fb_ingest_delta already carries the D-FB-48 rule - skipped';
    RETURN;
  END IF;
  IF md5(v_def) <> 'aa96822e797a5286620e5596d8271e39' THEN
    RAISE EXCEPTION 'GUARD_INGEST: fb_ingest_delta is not the D-FB-45 version (md5 %) - stop and tell Claude', md5(v_def);
  END IF;
  v_anchor := '              IF v_lstatus IN (70, 75) THEN' || v_nl || '                v_ack := true;' || v_nl || '              END IF;';
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'GUARD_ANCHOR: anchor found % times (expected 1)', v_n;
  END IF;
  EXECUTE replace(v_def, v_anchor, v_anchor || v_nl
    || '              -- D-FB-48: a different product on a linked open line is never applied silently' || v_nl
    || '              IF v_changes ? ''product_num'' THEN' || v_nl
    || '                v_ack := true;' || v_nl
    || '              END IF;');
  RAISE NOTICE 'fb_ingest_delta patched with the D-FB-48 rule';
END
$patch$;

/* ---- 1g. co_line_set_components: back to the D-FB-42 gate (no-op on PROD) ---- */
DO $gate$
DECLARE v_def text := pg_get_functiondef('public.co_line_set_components(uuid, uuid[], text)'::regprocedure);
BEGIN
  IF position('''scheduler''' in v_def) > 0 THEN
    EXECUTE replace(replace(v_def,
      '  /* D-FB-47: the same roles that can open Edit CO (CustomerOrders CAN_EDIT_ROLES) plus order_processor */' || chr(10), ''),
      'ARRAY[''order_processor'', ''admin'', ''customer_service'', ''scheduler'']', 'ARRAY[''order_processor'', ''admin'', ''customer_service'']');
    RAISE NOTICE 'co_line_set_components gate restored to D-FB-42';
  END IF;
END
$gate$;

/* ================================== Block 2: DRY RUN ================================== */
SELECT public.wo_resync_all_due_dates(true) AS dry_run;

/* =================================== Block 3: LIVE ==================================== */
SELECT public.wo_resync_all_due_dates(false) AS applied;

/* ================================== Block 4: VERIFY =================================== */
SELECT jsonb_build_object(
  'stale_open_wo_due_dates', (SELECT count(*) FROM public.work_orders w
       JOIN LATERAL (SELECT min(col.due_date) FILTER (WHERE col.due_date >= DATE '2000-01-01') AS m
                       FROM public.customer_order_allocations a JOIN public.customer_order_lines col ON col.id = a.customer_order_line_id
                      WHERE a.work_order_id = w.id AND a.is_active) x ON true
      WHERE w.status NOT IN ('complete', 'cancelled') AND x.m IS NOT NULL AND w.due_date IS DISTINCT FROM x.m),
  'trigger_present', (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_co_line_due_resync' AND NOT tgisinternal),
  'ingest_part_rule', (SELECT position('D-FB-48' in pg_get_functiondef('public.fb_ingest_delta(jsonb)'::regprocedure)) > 0),
  'ingest_line_numbers_hook', (SELECT position('D-FB-45' in pg_get_functiondef('public.fb_ingest_delta(jsonb)'::regprocedure)) > 0),
  'functions', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
                  AND p.proname IN ('_wo_resync_due_date', 'trg_co_line_due_resync', 'wo_resync_all_due_dates', 'co_cancel_line', 'fb_resolve_exception')),
  'anon_exec_any', has_function_privilege('anon', 'public.fb_resolve_exception(bigint, text, text)', 'EXECUTE')
                   OR has_function_privilege('anon', 'public.co_cancel_line(uuid, text)', 'EXECUTE'),
  'helper_exec_authenticated', has_function_privilege('authenticated', 'public._wo_resync_due_date(uuid)', 'EXECUTE'),
  'set_components_gate_has_scheduler', position('''scheduler''' in pg_get_functiondef('public.co_line_set_components(uuid, uuid[], text)'::regprocedure)) > 0
) AS verify;
