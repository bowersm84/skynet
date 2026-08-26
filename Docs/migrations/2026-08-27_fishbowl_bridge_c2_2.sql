-- ============================================================================
-- FB1 Batch C2.2 — remaining = ordered − shipped; shipped lines are not pending (D-FB-36)
-- File: Docs/migrations/2026-08-27_fishbowl_bridge_c2_2.sql
-- Requires: _a, _b, _c1, _c2 applied. TEST first. Idempotent.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Fishbowl's soitem.qtyToFulfill is the quantity of the NEXT fulfillment and keeps its last value once a line is
--    fully shipped (ordered 5 · shipped 5 · qtyToFulfill 5). Remaining demand is ordered − shipped, everywhere.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_convert_to_co(p_fb_so_id integer, p_line_ids integer[], p_components jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
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
  g               record;
  v_qty           integer;
  v_existing      record;
  v_col_id        uuid;
  v_col_number    integer;
  v_components    text;
  v_note          text;
  v_lines_created integer := 0;
  v_lines_added   integer := 0;
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

  -- ---- validate every requested line first; nothing is written until the set is known ----
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
      v_skipped := v_skipped || jsonb_build_object('fb_soitem_id', v_id, 'line', v_line.line_number, 'reason', 'part inactive in SkyNet — reactivate in Armory'); CONTINUE;
    END IF;
    IF v_line.status_id IN (50, 60, 70, 75, 95) THEN
      v_skipped := v_skipped || jsonb_build_object('fb_soitem_id', v_id, 'line', v_line.line_number, 'reason', 'line is closed in Fishbowl'); CONTINUE;
    END IF;
    IF round(GREATEST(v_line.qty_ordered - v_line.qty_fulfilled, 0))::integer <= 0 THEN
      v_skipped := v_skipped || jsonb_build_object('fb_soitem_id', v_id, 'line', v_line.line_number, 'reason', 'nothing left to fulfill'); CONTINUE;
    END IF;
    IF NOT (v_id = ANY (v_valid_ids)) THEN
      v_valid_ids := v_valid_ids || v_id;
    END IF;
  END LOOP;

  IF array_length(v_valid_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No lines could be converted: %', v_skipped::text USING ERRCODE = '22023';
  END IF;

  -- ---- customer ----
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

  -- ---- CO header: linked, else matched by Fishbowl order number the way formatCONumber does, else new ----
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

  -- ---- one CO line per part (D-FB-26) ----
  FOR g IN
    SELECT f.part_id, p.part_number,
           SUM(round(GREATEST(f.qty_ordered - f.qty_fulfilled, 0))::integer) AS qty,
           MIN(f.effective_due_date) AS due,
           array_agg(f.fb_soitem_id ORDER BY f.line_number) AS ids,
           string_agg(f.line_number::text, ', ' ORDER BY f.line_number) AS fb_lines,
           string_agg(DISTINCT f.customer_part_num, ', ') AS cust_pns,
           string_agg(DISTINCT f.rev_level, ', ') AS revs
      FROM public.fb_sales_order_lines f
      JOIN public.parts p ON p.id = f.part_id
     WHERE f.fb_soitem_id = ANY (v_valid_ids)
     GROUP BY f.part_id, p.part_number
     ORDER BY MIN(f.line_number)
  LOOP
    v_qty := g.qty;
    v_components := NULLIF(btrim(COALESCE(p_components->>(g.part_id::text), '')), '');
    v_note := concat_ws(' · ',
      'Fishbowl SO ' || v_so.so_number || ' line' || CASE WHEN array_length(g.ids, 1) > 1 THEN 's ' ELSE ' ' END || g.fb_lines,
      CASE WHEN g.cust_pns IS NOT NULL THEN 'Cust P/N ' || g.cust_pns END,
      CASE WHEN g.revs IS NOT NULL THEN 'Rev ' || g.revs END);

    -- an open CO line for this part on this CO absorbs the quantity (D-FB-26)
    SELECT id, line_number, quantity_ordered, notes, components_needed INTO v_existing
      FROM public.customer_order_lines
     WHERE customer_order_id = v_co_id AND part_id = g.part_id AND status IN ('not_started', 'in_progress')
     ORDER BY line_number LIMIT 1;

    IF FOUND THEN
      UPDATE public.customer_order_lines
         SET quantity_ordered = quantity_ordered + v_qty,
             due_date = LEAST(COALESCE(due_date, g.due), COALESCE(g.due, due_date)),
             notes = NULLIF(concat_ws(E'\n', notes, '+' || v_qty || ' via Order Queue: ' || v_note), ''),
             components_needed = CASE
               WHEN v_components IS NULL THEN components_needed
               ELSE NULLIF(concat_ws(E'\n', components_needed, v_components), '') END
       WHERE id = v_existing.id;
      v_col_id := v_existing.id;
      v_col_number := v_existing.line_number;
      v_lines_added := v_lines_added + 1;
      v_results := v_results || jsonb_build_object('part_number', g.part_number, 'action', 'added',
                       'co_line_number', v_col_number, 'qty', v_qty, 'fb_lines', g.fb_lines);
    ELSE
      IF v_components IS NULL THEN
        RAISE EXCEPTION 'Components Needed is required for % (new CO line)', g.part_number USING ERRCODE = '22023';
      END IF;
      v_next_line := v_next_line + 1;
      INSERT INTO public.customer_order_lines (
        customer_order_id, line_number, part_id, quantity_ordered, due_date, priority, notes, components_needed)
      VALUES (v_co_id, v_next_line, g.part_id, v_qty, g.due, v_priority, v_note, v_components)
      RETURNING id INTO v_col_id;
      v_col_number := v_next_line;
      v_lines_created := v_lines_created + 1;
      v_results := v_results || jsonb_build_object('part_number', g.part_number, 'action', 'created',
                       'co_line_number', v_col_number, 'qty', v_qty, 'fb_lines', g.fb_lines);
    END IF;

    UPDATE public.fb_sales_order_lines
       SET customer_order_line_id = v_col_id, disposition = 'production', disposition_by = v_uid,
           disposition_at = now(), disposition_note = 'Converted to ' || v_co_number || ' line ' || v_col_number
     WHERE fb_soitem_id = ANY (g.ids);

    UPDATE public.customer_order_lines c
       SET fb_qty_ordered = s.o, fb_qty_fulfilled = s.f, fb_qty_to_fulfill = s.t
      FROM (SELECT SUM(qty_ordered) AS o, SUM(qty_fulfilled) AS f, SUM(qty_to_fulfill) AS t
              FROM public.fb_sales_order_lines WHERE customer_order_line_id = v_col_id AND removed_at IS NULL) s
     WHERE c.id = v_col_id;
  END LOOP;

  RETURN jsonb_build_object(
    'customer_order_id', v_co_id, 'co_number', v_co_number, 'created', v_created,
    'lines_created', v_lines_created, 'lines_added', v_lines_added, 'lines', v_results, 'skipped', v_skipped);
END;
$$;

REVOKE ALL ON FUNCTION public.fb_convert_to_co(integer, integer[], jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fb_convert_to_co(integer, integer[], jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Queue view v4 (D-FB-36): shipped / closed lines are not pending, not actionable; shipped_lines added
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_fb_order_queue;
CREATE VIEW public.v_fb_order_queue WITH (security_invoker = true) AS
SELECT s.fb_so_id, s.so_number, s.fb_customer_id, s.customer_id, s.customer_name, s.customer_po,
       s.status_id, s.priority_id, s.salesman, s.location_group_id,
       s.fb_date_created, s.fb_date_issued, s.fb_date_last_modified, s.last_synced_at,
       s.customer_order_id, co.co_number AS linked_co_number,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL)                                   AS line_count,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'pending'
                                       AND l.status_id NOT IN (50, 60, 70, 75, 95))                AS pending_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'production')  AS production_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'stock')       AS stock_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'purchased')   AS purchased_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'covered')     AS covered_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'assembly')    AS assembly_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'unlisted')    AS unlisted_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition IN ('ignore','kit_header')) AS ignored_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.type_id IN (10, 12) AND l.status_id IN (50, 60)) AS shipped_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.type_id IN (10, 12) AND l.customer_order_line_id IS NULL
                                       AND l.status_id NOT IN (50, 60, 70, 75, 95))                AS actionable_lines,
       min(l.effective_due_date) FILTER (WHERE l.removed_at IS NULL AND l.type_id IN (10, 12))     AS earliest_due,
       COALESCE(bool_or(l.due_date_is_default) FILTER (WHERE l.removed_at IS NULL AND l.type_id IN (10, 12)), false) AS has_default_dates,
       COALESCE(bool_or(l.effective_due_date < DATE '2000-01-01' OR l.effective_due_date > DATE '2100-01-01')
                FILTER (WHERE l.removed_at IS NULL AND l.type_id IN (10, 12)), false)              AS suspect_dates,
       (SELECT count(*) FROM public.fb_sync_events e
         WHERE e.fb_so_id = s.fb_so_id AND e.requires_ack AND e.acknowledged_at IS NULL)          AS open_exceptions
  FROM public.fb_sales_orders s
  LEFT JOIN public.customer_orders co ON co.id = s.customer_order_id
  LEFT JOIN public.fb_sales_order_lines l ON l.fb_so_id = s.fb_so_id
 WHERE s.removed_at IS NULL
 GROUP BY s.fb_so_id, co.co_number;

GRANT SELECT ON public.v_fb_order_queue TO authenticated;
REVOKE ALL ON public.v_fb_order_queue FROM anon;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification (last result set)
-- ---------------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_name = 'v_fb_order_queue' AND column_name = 'shipped_lines') AS view_col,
  (SELECT sum(pending_lines) FROM public.v_fb_order_queue WHERE status_id IN (20, 25))                                     AS pending_lines_now,
  (SELECT sum(shipped_lines) FROM public.v_fb_order_queue WHERE status_id IN (20, 25))                                     AS shipped_lines_open_sos,
  (SELECT count(*) FROM public.v_fb_order_queue WHERE status_id IN (20, 25) AND pending_lines > 0)                         AS queue_count;
-- Expected: view_col 1 · pending_lines_now well below the old 980 · queue_count below the old 107
