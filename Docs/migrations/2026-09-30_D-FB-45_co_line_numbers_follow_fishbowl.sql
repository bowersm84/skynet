/* ==========================================================================================
   D-FB-45  -  CO line number = Fishbowl line number, kept in step with Fishbowl
   Delivered 2026-09-30.  Requires the D-FB-42 migration (2026-09-30_D-FB-42_co_line_components_releases.sql).
   TEST: applied by Claude.  PROD: run by Matt AFTER the D-FB-42 migration.

   WHY: Matt, 2026-09-30 - "the line numbers should come from the Fishbowl line number and should be
   the same all the way through SkyNet." CO line numbers were SkyNet's own next-free counter, so FB
   line 2 showed as CO line #1 and FB line 3 as #10. Fishbowl also renumbers lines when a line above
   is deleted (SO 15548: Freight moved up to line 9 on 9/9 when line 9 was removed; 3 such shifts on
   PROD), so the number must be followed, not copied once.

   RULE: every CO line linked to a live Fishbowl line carries that line's number (lowest, if it still
   merges several - the 6 D-FB-26 merges left in place). A CO line with no live Fishbowl line (hand-keyed,
   or its Fishbowl line was deleted) keeps its number unless a Fishbowl-linked line needs it; then it
   moves to the next free number above everything on the CO. Every move is audited.

   HOW TO RUN - four independent blocks, one at a time:
     Block 1  FUNCTIONS  _co_sync_line_numbers, fb_convert_to_co v5, co_sync_all_line_numbers,
                         and the fb_ingest_delta patch (guarded by md5 + a unique anchor; re-run safe).
                         From this moment ingest renumbers a CO whenever its SO syncs.
     Block 2  DRY RUN    SELECT co_sync_all_line_numbers(true)  - performs every renumber, reports,
                         rolls itself back.  Paste the result to Claude before Block 3.
     Block 3  LIVE       SELECT co_sync_all_line_numbers(false)
     Block 4  VERIFY     expect mismatched = 0 and merged = the D-FB-26 lines still in place
   ========================================================================================== */

/* ================================= Block 1: FUNCTIONS ================================= */

/* ---- 1a. the one rule ---- */
CREATE OR REPLACE FUNCTION public._co_sync_line_numbers(p_co_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_changes jsonb := '[]'::jsonb;
  v_movers  uuid[];
  v_wants   integer[];
  v_curs    integer[];
  v_pns     text[];
  v_next    integer;
  v_co      text;
  r         record;
  i         integer;
BEGIN
  IF p_co_id IS NULL THEN RETURN v_changes; END IF;
  PERFORM 1 FROM public.customer_order_lines WHERE customer_order_id = p_co_id FOR UPDATE;

  /* desired number per Fishbowl-linked line = its (lowest) live Fishbowl line number. If two lines
     want one number (a CO fed by two SOs), the lower id keeps it; the other counts as unlinked. */
  SELECT array_agg(x.id ORDER BY x.want), array_agg(x.want ORDER BY x.want),
         array_agg(x.cur ORDER BY x.want), array_agg(x.part_number ORDER BY x.want)
    INTO v_movers, v_wants, v_curs, v_pns
    FROM (
      SELECT d.*, row_number() OVER (PARTITION BY d.want ORDER BY d.id) AS rk
        FROM (SELECT col.id, col.line_number AS cur, min(l.line_number) AS want, p.part_number::text AS part_number
                FROM public.customer_order_lines col
                JOIN public.parts p ON p.id = col.part_id
                JOIN public.fb_sales_order_lines l ON l.customer_order_line_id = col.id AND l.removed_at IS NULL
               WHERE col.customer_order_id = p_co_id
               GROUP BY col.id, col.line_number, p.part_number) d
       WHERE d.want > 0
    ) x
   WHERE x.rk = 1 AND x.want <> x.cur;

  IF v_movers IS NULL THEN RETURN v_changes; END IF;

  /* phase 1: movers step aside onto negative numbers (never used otherwise), so swaps and shifts
     inside the CO never trip UNIQUE (customer_order_id, line_number) */
  FOR i IN 1 .. array_length(v_movers, 1) LOOP
    UPDATE public.customer_order_lines SET line_number = -i WHERE id = v_movers[i];
  END LOOP;

  /* phase 2: any other line sitting on a wanted number moves above everything on the CO */
  SELECT GREATEST(COALESCE(max(line_number), 0), (SELECT max(w) FROM unnest(v_wants) w))
    INTO v_next FROM public.customer_order_lines WHERE customer_order_id = p_co_id;
  FOR r IN
    SELECT col.id, col.line_number, p.part_number::text AS part_number
      FROM public.customer_order_lines col JOIN public.parts p ON p.id = col.part_id
     WHERE col.customer_order_id = p_co_id AND col.line_number = ANY (v_wants) AND NOT (col.id = ANY (v_movers))
     ORDER BY col.line_number
  LOOP
    v_next := v_next + 1;
    UPDATE public.customer_order_lines SET line_number = v_next WHERE id = r.id;
    v_changes := v_changes || jsonb_build_object('line_id', r.id, 'part_number', r.part_number,
                   'from', r.line_number, 'to', v_next, 'kind', 'bumped');
  END LOOP;

  /* phase 3: movers take their Fishbowl numbers */
  FOR i IN 1 .. array_length(v_movers, 1) LOOP
    UPDATE public.customer_order_lines SET line_number = v_wants[i] WHERE id = v_movers[i];
    v_changes := v_changes || jsonb_build_object('line_id', v_movers[i], 'part_number', v_pns[i],
                   'from', v_curs[i], 'to', v_wants[i], 'kind', 'follow');
  END LOOP;

  SELECT co_number INTO v_co FROM public.customer_orders WHERE id = p_co_id;
  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('co_line_renumbered', auth.uid(), jsonb_build_object('co_number', v_co, 'customer_order_id', p_co_id,
          'rule', 'D-FB-45 CO line number = Fishbowl line number', 'changes', v_changes));
  RETURN v_changes;
END;
$function$;
REVOKE ALL ON FUNCTION public._co_sync_line_numbers(uuid) FROM PUBLIC, anon, authenticated;

/* ---- 1b. fb_convert_to_co v5 = v4 (D-FB-42/43) + D-FB-45 numbering ---- */
CREATE OR REPLACE FUNCTION public.fb_convert_to_co(p_fb_so_id integer, p_line_ids integer[], p_components jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_uid           uuid := auth.uid();
  v_so            public.fb_sales_orders%ROWTYPE;
  v_line          public.fb_sales_order_lines%ROWTYPE;
  v_co_id         uuid;
  v_co_number     text;
  v_co_status     text;
  v_created       boolean := false;
  v_customer_id   uuid;
  v_customer_code text;
  v_salesperson   uuid;
  v_priority      text;
  v_next_line     integer;
  v_skipped       jsonb := '[]'::jsonb;
  v_results       jsonb := '[]'::jsonb;
  v_id            integer;
  v_valid_ids     integer[] := ARRAY[]::integer[];
  v_part_active   boolean;
  v_part_number   text;
  v_qty           integer;
  v_col_id        uuid;
  v_spec          jsonb;
  v_comp_ids      uuid[];
  v_cid           uuid;
  v_note          text;
  v_line_note     text;
  v_lines_created integer := 0;
  v_col_ids       uuid[] := ARRAY[]::uuid[];
  v_renumbered    jsonb := '[]'::jsonb;
  r               record;
BEGIN
  PERFORM public._fb_gate(ARRAY['order_processor', 'admin']);
  IF p_line_ids IS NULL OR array_length(p_line_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No lines selected' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_so FROM public.fb_sales_orders WHERE fb_so_id = p_fb_so_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fishbowl SO % is not in the mirror', p_fb_so_id USING ERRCODE = '22023';
  END IF;
  IF v_so.removed_at IS NOT NULL OR v_so.status_id NOT IN (20, 25) THEN
    RAISE EXCEPTION 'SO % is not open in Fishbowl (status %)', v_so.so_number, v_so.status_id USING ERRCODE = '22023';
  END IF;

  /* ---- validate every requested line first; nothing is written until the set is known ---- */
  FOREACH v_id IN ARRAY p_line_ids LOOP
    SELECT * INTO v_line FROM public.fb_sales_order_lines WHERE fb_soitem_id = v_id FOR UPDATE;
    IF NOT FOUND OR v_line.fb_so_id <> p_fb_so_id THEN
      v_skipped := v_skipped || jsonb_build_object('fb_soitem_id', v_id, 'reason', 'not on this SO'); CONTINUE;
    END IF;
    IF v_line.removed_at IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_object('fb_soitem_id', v_id, 'line', v_line.line_number, 'reason', 'removed in Fishbowl'); CONTINUE;
    END IF;
    IF v_line.customer_order_line_id IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_object('fb_soitem_id', v_id, 'line', v_line.line_number, 'reason', 'already linked to a CO line'); CONTINUE;
    END IF;
    IF v_line.type_id NOT IN (10, 12) THEN
      v_skipped := v_skipped || jsonb_build_object('fb_soitem_id', v_id, 'line', v_line.line_number, 'reason', 'not a product line'); CONTINUE;
    END IF;
    IF v_line.part_id IS NULL THEN
      v_skipped := v_skipped || jsonb_build_object('fb_soitem_id', v_id, 'line', v_line.line_number, 'reason', 'part not in SkyNet'); CONTINUE;
    END IF;
    SELECT is_active, part_number INTO v_part_active, v_part_number FROM public.parts WHERE id = v_line.part_id;
    IF COALESCE(v_part_active, false) = false THEN
      v_skipped := v_skipped || jsonb_build_object('fb_soitem_id', v_id, 'line', v_line.line_number, 'reason', 'part inactive in SkyNet - reactivate in Armory'); CONTINUE;
    END IF;
    IF v_line.status_id IN (50, 60, 70, 75, 95) THEN
      v_skipped := v_skipped || jsonb_build_object('fb_soitem_id', v_id, 'line', v_line.line_number, 'reason', 'line is closed in Fishbowl'); CONTINUE;
    END IF;
    IF round(GREATEST(v_line.qty_ordered - v_line.qty_fulfilled, 0))::integer <= 0 THEN
      v_skipped := v_skipped || jsonb_build_object('fb_soitem_id', v_id, 'line', v_line.line_number, 'reason', 'nothing left to fulfill'); CONTINUE;
    END IF;
    /* D-FB-42: every new CO line needs at least one valid component of its part */
    v_spec := p_components -> (v_line.part_id::text);
    IF v_spec IS NULL OR jsonb_typeof(v_spec) <> 'object' OR jsonb_typeof(v_spec -> 'components') <> 'array'
       OR jsonb_array_length(v_spec -> 'components') = 0 THEN
      RAISE EXCEPTION 'Components Needed: select at least one component for % (Fishbowl line %)', v_part_number, v_line.line_number USING ERRCODE = '22023';
    END IF;
    FOR v_cid IN SELECT (e)::uuid FROM jsonb_array_elements_text(v_spec -> 'components') e LOOP
      IF NOT public._co_line_component_ok(v_line.part_id, v_cid) THEN
        RAISE EXCEPTION 'Component % is not % or a component of its bill of materials', v_cid, v_part_number USING ERRCODE = '22023';
      END IF;
    END LOOP;
    IF NOT (v_id = ANY (v_valid_ids)) THEN
      v_valid_ids := v_valid_ids || v_id;
    END IF;
  END LOOP;

  IF array_length(v_valid_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No lines could be converted: %', v_skipped::text USING ERRCODE = '22023';
  END IF;

  /* ---- customer ---- */
  v_customer_id := v_so.customer_id;
  IF v_customer_id IS NULL THEN
    SELECT id INTO v_customer_id FROM public.customers WHERE customer_id = v_so.fb_customer_id::text;
    IF v_customer_id IS NULL AND v_so.fb_customer_id::text ~ '^[0-9]{1,6}$' AND COALESCE(v_so.customer_name, '') <> '' THEN
      INSERT INTO public.customers (customer_id, name, is_active, notes)
      VALUES (v_so.fb_customer_id::text, v_so.customer_name, true, 'Auto-created by Fishbowl Bridge from SO ' || v_so.so_number)
      RETURNING id INTO v_customer_id;
    END IF;
    IF v_customer_id IS NULL THEN
      RAISE EXCEPTION 'Customer % (%) could not be resolved', v_so.fb_customer_id, v_so.customer_name USING ERRCODE = '22023';
    END IF;
    UPDATE public.fb_sales_orders SET customer_id = v_customer_id WHERE fb_so_id = p_fb_so_id;
  END IF;
  SELECT customer_id INTO v_customer_code FROM public.customers WHERE id = v_customer_id;

  /* ---- CO header: linked, else matched by Fishbowl order number the way formatCONumber does, else new ---- */
  v_co_id := v_so.customer_order_id;
  IF v_co_id IS NULL THEN
    SELECT id INTO v_co_id
      FROM public.customer_orders
     WHERE upper(regexp_replace(fishbowl_order_id, '[^A-Za-z0-9]', '', 'g'))
         = upper(regexp_replace(v_so.so_number, '[^A-Za-z0-9]', '', 'g'))
       AND status <> 'cancelled'
     ORDER BY created_at DESC LIMIT 1;
  END IF;
  IF v_co_id IS NULL THEN
    v_co_number := 'CO-' || v_customer_code || '-' || upper(regexp_replace(v_so.so_number, '[^A-Za-z0-9]', '', 'g'));
    SELECT id INTO v_salesperson FROM public.profiles
     WHERE v_so.salesman IS NOT NULL AND lower(username) = lower(v_so.salesman) AND is_active
     LIMIT 1;
    INSERT INTO public.customer_orders (co_number, customer_id, fishbowl_order_id, po_number, notes, created_by, salesperson_id)
    VALUES (v_co_number, v_customer_id, v_so.so_number, v_so.customer_po,
            'Created from Fishbowl SO ' || v_so.so_number || ' via Order Queue', v_uid, v_salesperson)
    RETURNING id INTO v_co_id;
    v_created := true;
  ELSE
    SELECT co_number, status INTO v_co_number, v_co_status FROM public.customer_orders WHERE id = v_co_id;
    IF v_co_status = 'cancelled' THEN
      RAISE EXCEPTION 'CO % is cancelled; reinstate it in Customer Orders before converting more lines', v_co_number USING ERRCODE = '22023';
    END IF;
  END IF;
  UPDATE public.fb_sales_orders SET customer_order_id = v_co_id
   WHERE fb_so_id = p_fb_so_id AND customer_order_id IS DISTINCT FROM v_co_id;

  v_priority := CASE v_so.priority_id WHEN 10 THEN 'critical' WHEN 20 THEN 'high' WHEN 40 THEN 'low' WHEN 50 THEN 'low' ELSE 'normal' END;
  SELECT COALESCE(MAX(line_number), 0) INTO v_next_line FROM public.customer_order_lines WHERE customer_order_id = v_co_id;

  /* ---- D-FB-43: one CO line per Fishbowl line, in Fishbowl line order. Inserted at the next free
     numbers first; D-FB-45 then moves every Fishbowl-linked line on the CO to its Fishbowl line number. ---- */
  FOR v_line IN
    SELECT * FROM public.fb_sales_order_lines WHERE fb_soitem_id = ANY (v_valid_ids) ORDER BY line_number
  LOOP
    SELECT part_number INTO v_part_number FROM public.parts WHERE id = v_line.part_id;
    v_qty  := round(GREATEST(v_line.qty_ordered - v_line.qty_fulfilled, 0))::integer;
    v_spec := p_components -> (v_line.part_id::text);
    v_note := NULLIF(btrim(COALESCE(v_spec ->> 'note', '')), '');
    SELECT array_agg(DISTINCT (e)::uuid) INTO v_comp_ids FROM jsonb_array_elements_text(v_spec -> 'components') e;
    v_line_note := concat_ws(' - ',
      'Fishbowl SO ' || v_so.so_number || ' line ' || v_line.line_number,
      CASE WHEN v_line.customer_part_num IS NOT NULL THEN 'Cust P/N ' || v_line.customer_part_num END,
      CASE WHEN v_line.rev_level IS NOT NULL THEN 'Rev ' || v_line.rev_level END);

    v_next_line := v_next_line + 1;
    INSERT INTO public.customer_order_lines (
      customer_order_id, line_number, part_id, quantity_ordered, due_date, priority, notes, components_needed,
      fb_qty_ordered, fb_qty_fulfilled, fb_qty_to_fulfill)
    VALUES (v_co_id, v_next_line, v_line.part_id, v_qty, v_line.effective_due_date, v_priority, v_line_note, v_note,
            v_line.qty_ordered, v_line.qty_fulfilled, v_line.qty_to_fulfill)
    RETURNING id INTO v_col_id;

    INSERT INTO public.customer_order_line_components (customer_order_line_id, component_id, created_by)
    SELECT v_col_id, c, v_uid FROM unnest(v_comp_ids) c
    ON CONFLICT DO NOTHING;

    UPDATE public.fb_sales_order_lines
       SET customer_order_line_id = v_col_id, disposition = 'production', disposition_by = v_uid,
           disposition_at = now()
     WHERE fb_soitem_id = v_line.fb_soitem_id;

    v_lines_created := v_lines_created + 1;
    v_col_ids := v_col_ids || v_col_id;
  END LOOP;

  /* ---- D-FB-45: CO line number = Fishbowl line number ---- */
  v_renumbered := public._co_sync_line_numbers(v_co_id);

  FOR r IN
    SELECT col.id, col.line_number AS co_ln, p.part_number, col.quantity_ordered, col.due_date,
           l.fb_soitem_id, l.line_number AS fb_ln,
           (SELECT count(*) FROM public.customer_order_line_components c WHERE c.customer_order_line_id = col.id) AS comps
      FROM public.customer_order_lines col
      JOIN public.parts p ON p.id = col.part_id
      JOIN public.fb_sales_order_lines l ON l.customer_order_line_id = col.id
     WHERE col.id = ANY (v_col_ids)
     ORDER BY l.line_number
  LOOP
    UPDATE public.fb_sales_order_lines
       SET disposition_note = 'Converted to ' || v_co_number || ' line ' || r.co_ln
     WHERE fb_soitem_id = r.fb_soitem_id;
    v_results := v_results || jsonb_build_object('part_number', r.part_number, 'action', 'created',
                     'co_line_number', r.co_ln, 'qty', r.quantity_ordered, 'fb_lines', r.fb_ln::text,
                     'due', r.due_date, 'components', r.comps);
  END LOOP;

  RETURN jsonb_build_object(
    'customer_order_id', v_co_id, 'co_number', v_co_number, 'created', v_created,
    'lines_created', v_lines_created, 'lines_added', 0, 'lines', v_results, 'skipped', v_skipped,
    'renumbered', (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(v_renumbered) e WHERE NOT ((e->>'line_id')::uuid = ANY (v_col_ids))));
END;
$function$;
REVOKE ALL ON FUNCTION public.fb_convert_to_co(integer, integer[], jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fb_convert_to_co(integer, integer[], jsonb) TO authenticated;

/* ---- 1c. sweep every Fishbowl-linked CO (the one-shot; also safe to re-run any time) ---- */
CREATE OR REPLACE FUNCTION public.co_sync_all_line_numbers(p_dry_run boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_report  jsonb := '[]'::jsonb;
  v_ch      jsonb;
  v_follow  integer := 0;
  v_bumped  integer := 0;
  r         record;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin']);
  BEGIN
    FOR r IN
      SELECT co.id, co.co_number
        FROM public.customer_orders co
       WHERE EXISTS (SELECT 1 FROM public.customer_order_lines col
                       JOIN public.fb_sales_order_lines l ON l.customer_order_line_id = col.id AND l.removed_at IS NULL
                      WHERE col.customer_order_id = co.id)
       ORDER BY co.co_number
    LOOP
      v_ch := public._co_sync_line_numbers(r.id);
      IF jsonb_array_length(v_ch) > 0 THEN
        v_follow := v_follow + (SELECT count(*) FROM jsonb_array_elements(v_ch) e WHERE e->>'kind' = 'follow');
        v_bumped := v_bumped + (SELECT count(*) FROM jsonb_array_elements(v_ch) e WHERE e->>'kind' = 'bumped');
        v_report := v_report || jsonb_build_object('co_number', r.co_number,
          'changes', (SELECT jsonb_agg(jsonb_build_object('part', e->>'part_number', 'from', (e->>'from')::int, 'to', (e->>'to')::int, 'kind', e->>'kind'))
                        FROM jsonb_array_elements(v_ch) e));
      END IF;
    END LOOP;
    IF p_dry_run THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'D-FB-45 DRYRUN';
    END IF;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'D-FB-45 DRYRUN' THEN RAISE; END IF;
  END;
  RETURN jsonb_build_object('dry_run', p_dry_run, 'cos_changed', jsonb_array_length(v_report),
                            'lines_followed', v_follow, 'lines_bumped', v_bumped, 'detail', v_report);
END;
$function$;
REVOKE ALL ON FUNCTION public.co_sync_all_line_numbers(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.co_sync_all_line_numbers(boolean) TO authenticated;

/* ---- 1d. fb_ingest_delta: follow Fishbowl renumbering on every sync of a linked SO ----
   Patched in place rather than re-typed: the function must be exactly the 2026-09-30 version
   (md5 161fd81b..., identical on TEST and PROD) and the anchor must occur once. The hook runs per
   order after its lines and removals, inside its own exception block, so a renumber problem is
   logged to audit_logs and can never stall the bridge. Re-running this block is a no-op. */
DO $patch$
DECLARE
  v_def    text := pg_get_functiondef('public.fb_ingest_delta(jsonb)'::regprocedure);
  v_nl     text := chr(13) || chr(10);
  v_anchor text;
  v_hook   text;
  v_n      integer;
BEGIN
  IF position('D-FB-45' in v_def) > 0 THEN
    RAISE NOTICE 'fb_ingest_delta already carries the D-FB-45 hook - skipped';
    RETURN;
  END IF;
  IF md5(v_def) <> '161fd81b4844da33f6e51e1b8f83d7e3' THEN
    RAISE EXCEPTION 'GUARD_INGEST: fb_ingest_delta is not the 2026-09-30 version (md5 %) - stop and tell Claude', md5(v_def);
  END IF;
  v_anchor := 'END LOOP;' || v_nl || '    END IF;' || v_nl || '  END LOOP;' || v_nl || v_nl || '  -- SOs that no longer exist in Fishbowl';
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'GUARD_ANCHOR: anchor found % times (expected 1)', v_n;
  END IF;
  v_hook := 'END LOOP;' || v_nl || '    END IF;' || v_nl
    || v_nl
    || '    -- D-FB-45: CO line numbers follow Fishbowl line numbers. Never allowed to stall ingest.' || v_nl
    || '    BEGIN' || v_nl
    || '      PERFORM public._co_sync_line_numbers(s.customer_order_id)' || v_nl
    || '         FROM public.fb_sales_orders s WHERE s.fb_so_id = v_so_id AND s.customer_order_id IS NOT NULL;' || v_nl
    || '    EXCEPTION WHEN OTHERS THEN' || v_nl
    || '      INSERT INTO public.audit_logs (event_type, details)' || v_nl
    || '      VALUES (''co_line_renumber_failed'', jsonb_build_object(''fb_so_id'', v_so_id, ''error'', SQLERRM));' || v_nl
    || '    END;' || v_nl
    || '  END LOOP;' || v_nl || v_nl || '  -- SOs that no longer exist in Fishbowl';
  EXECUTE replace(v_def, v_anchor, v_hook);
  RAISE NOTICE 'fb_ingest_delta patched with the D-FB-45 hook';
END
$patch$;

/* =================================== Block 2: DRY RUN =================================== */
SELECT public.co_sync_all_line_numbers(true) AS dry_run;

/* ==================================== Block 3: LIVE ===================================== */
SELECT public.co_sync_all_line_numbers(false) AS applied;

/* =================================== Block 4: VERIFY ==================================== */
WITH linked AS (
  SELECT col.id, col.customer_order_id, col.line_number AS co_ln, min(l.line_number) AS fb_ln, count(*) AS fb_n
    FROM public.customer_order_lines col
    JOIN public.fb_sales_order_lines l ON l.customer_order_line_id = col.id AND l.removed_at IS NULL
   GROUP BY col.id)
SELECT jsonb_build_object(
  'linked_co_lines', (SELECT count(*) FROM linked),
  'mismatched',      (SELECT count(*) FROM linked WHERE co_ln <> fb_ln),
  'merged_multi_fb', (SELECT count(*) FROM linked WHERE fb_n > 1),
  'negative_numbers', (SELECT count(*) FROM public.customer_order_lines WHERE line_number < 0),
  'ingest_hooked',   (SELECT position('D-FB-45' in pg_get_functiondef('public.fb_ingest_delta(jsonb)'::regprocedure)) > 0),
  'convert_v5',      (SELECT position('_co_sync_line_numbers' in pg_get_functiondef('public.fb_convert_to_co(integer, integer[], jsonb)'::regprocedure)) > 0),
  'helper_exec_authenticated', has_function_privilege('authenticated', 'public._co_sync_line_numbers(uuid)', 'EXECUTE'),
  'renumber_audits', (SELECT count(*) FROM public.audit_logs WHERE event_type = 'co_line_renumbered'),
  'renumber_failures', (SELECT count(*) FROM public.audit_logs WHERE event_type = 'co_line_renumber_failed')
) AS verify;
