-- ============================================================================
-- FB1 Batch B — Order Queue RPCs, `covered` disposition, linker v2, queue view v2
-- File: Docs/migrations/2026-08-25_fishbowl_bridge_b.sql
-- Requires: 2026-08-25_fishbowl_bridge_a.sql applied. TEST first. Idempotent.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Disposition CHECK: add `covered` — a Fishbowl line whose demand is already
--    represented by an existing CO line (D-FB-21). Old CHECK dropped by definition.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.fb_sales_order_lines'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%disposition%' AND pg_get_constraintdef(oid) ILIKE '%kit_header%'
  LOOP
    EXECUTE format('ALTER TABLE public.fb_sales_order_lines DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.fb_sales_order_lines ADD CONSTRAINT fb_sales_order_lines_disposition_check
  CHECK (disposition IN ('pending','production','stock','purchased','covered','kit_header','ignore','unlisted'));

-- ---------------------------------------------------------------------------
-- 2. Bulk disposition (D-FB-13: order_processor / admin). `production` is only
--    reachable through fb_convert_to_co; linked lines are never re-dispositioned here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_set_disposition(p_line_ids integer[], p_disposition text, p_note text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM public._fb_gate(ARRAY['order_processor', 'admin']);
  IF p_disposition IS NULL OR p_disposition NOT IN ('pending', 'stock', 'purchased', 'covered', 'ignore') THEN
    RAISE EXCEPTION 'Disposition % cannot be set by hand (production goes through Create CO)', COALESCE(p_disposition, 'NULL')
      USING ERRCODE = '22023';
  END IF;
  IF p_line_ids IS NULL OR array_length(p_line_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;
  UPDATE public.fb_sales_order_lines
     SET disposition = p_disposition,
         disposition_by = auth.uid(),
         disposition_at = now(),
         disposition_note = NULLIF(btrim(p_note), '')
   WHERE fb_soitem_id = ANY (p_line_ids)
     AND removed_at IS NULL
     AND customer_order_line_id IS NULL
     AND type_id IN (10, 12, 80);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Convert selected lines to Customer Order lines (D-FB-12)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_convert_to_co(p_fb_so_id integer, p_line_ids integer[])
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
  v_qty           integer;
  v_col_id        uuid;
  v_lines_created integer := 0;
  v_skipped       jsonb := '[]'::jsonb;
  v_id            integer;
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

  -- Customer: resolved on ingest; resolve or create here if it was not.
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

  -- Existing CO for this SO (linked, or matching by Fishbowl order number the way formatCONumber does)
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
    IF v_line.status_id IN (50, 60, 70, 75, 95) THEN
      v_skipped := v_skipped || jsonb_build_object('fb_soitem_id', v_id, 'line', v_line.line_number, 'reason', 'line is closed in Fishbowl'); CONTINUE;
    END IF;
    v_qty := round(COALESCE(v_line.qty_to_fulfill, v_line.qty_ordered - v_line.qty_fulfilled))::integer;
    IF v_qty <= 0 THEN
      v_skipped := v_skipped || jsonb_build_object('fb_soitem_id', v_id, 'line', v_line.line_number, 'reason', 'nothing left to fulfill'); CONTINUE;
    END IF;

    v_next_line := v_next_line + 1;
    INSERT INTO public.customer_order_lines (
      customer_order_id, line_number, part_id, quantity_ordered, due_date, priority, notes,
      fb_qty_ordered, fb_qty_fulfilled, fb_qty_to_fulfill)
    VALUES (
      v_co_id, v_next_line, v_line.part_id, v_qty, v_line.effective_due_date, v_priority,
      NULLIF(concat_ws(' · ',
        'Fishbowl SO ' || v_so.so_number || ' line ' || v_line.line_number,
        CASE WHEN v_line.customer_part_num IS NOT NULL THEN 'Cust P/N ' || v_line.customer_part_num END,
        CASE WHEN v_line.rev_level IS NOT NULL THEN 'Rev ' || v_line.rev_level END), ''),
      v_line.qty_ordered, v_line.qty_fulfilled, v_line.qty_to_fulfill)
    RETURNING id INTO v_col_id;

    UPDATE public.fb_sales_order_lines
       SET customer_order_line_id = v_col_id, disposition = 'production', disposition_by = v_uid,
           disposition_at = now(), disposition_note = 'Converted to ' || v_co_number || ' line ' || v_next_line
     WHERE fb_soitem_id = v_id;
    v_lines_created := v_lines_created + 1;
  END LOOP;

  IF v_lines_created = 0 THEN
    RAISE EXCEPTION 'No lines could be converted: %', v_skipped::text USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object(
    'customer_order_id', v_co_id, 'co_number', v_co_number, 'created', v_created,
    'lines_created', v_lines_created, 'skipped', v_skipped);
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Exception acknowledgement (used by Batch C's Exceptions tab; shipped now)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_ack_event(p_event_id bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public._fb_gate(ARRAY['order_processor', 'admin']);
  UPDATE public.fb_sync_events
     SET acknowledged_by = auth.uid(), acknowledged_at = now()
   WHERE id = p_event_id AND acknowledged_at IS NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Re-resolve unresolved lines against the parts / kit masters (D-FB-23).
--    Newly added parts pick up their open SO lines; human dispositions are never touched.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_reresolve_lines()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_parts integer;
  v_kits  integer;
BEGIN
  PERFORM public._fb_gate(ARRAY['order_processor', 'admin', 'integration']);
  UPDATE public.fb_sales_order_lines f
     SET part_id = p.id, resolution = 'part',
         disposition = CASE
           WHEN f.disposition IN ('pending', 'unlisted') AND p.part_type = 'purchased' THEN 'purchased'
           WHEN f.disposition = 'unlisted' THEN 'pending'
           ELSE f.disposition END
    FROM public.parts p
   WHERE f.part_id IS NULL AND f.type_id IN (10, 12) AND f.removed_at IS NULL
     AND upper(btrim(p.part_number)) = upper(btrim(COALESCE(f.part_num, f.product_num)));
  GET DIAGNOSTICS v_parts = ROW_COUNT;
  UPDATE public.fb_sales_order_lines f
     SET kit_sku_id = k.id, resolution = 'kit'
    FROM public.kit_skus k
   WHERE f.kit_sku_id IS NULL AND f.type_id = 80 AND f.removed_at IS NULL
     AND upper(btrim(k.part_number)) = upper(btrim(f.product_num));
  GET DIAGNOSTICS v_kits = ROW_COUNT;
  RETURN v_parts + v_kits;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Linker v2: exact-qty, then due-date, then line-order tie-break (D-FB-22)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_link_existing_cos()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r       record;
  l       record;
  cand    record;
  v_n     integer;
  v_linked_orders integer := 0;
  v_linked_lines  integer := 0;
  v_ambiguous jsonb := '[]'::jsonb;
  v_unmatched jsonb := '[]'::jsonb;
  v_unlinked  jsonb := '[]'::jsonb;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration', 'admin']);

  FOR r IN
    SELECT co.id, co.co_number, co.fishbowl_order_id,
           (SELECT s.fb_so_id FROM public.fb_sales_orders s
             WHERE s.removed_at IS NULL
               AND upper(regexp_replace(s.so_number, '[^A-Za-z0-9]', '', 'g'))
                 = upper(regexp_replace(co.fishbowl_order_id, '[^A-Za-z0-9]', '', 'g'))
             ORDER BY s.fb_so_id DESC LIMIT 1) AS fb_so_id
      FROM public.customer_orders co
     WHERE co.status IN ('not_started', 'in_progress') AND co.fishbowl_order_id IS NOT NULL
     ORDER BY co.co_number
  LOOP
    IF r.fb_so_id IS NULL THEN
      v_unmatched := v_unmatched || jsonb_build_object('co_number', r.co_number, 'fishbowl_order_id', r.fishbowl_order_id);
      CONTINUE;
    END IF;

    UPDATE public.fb_sales_orders SET customer_order_id = r.id
     WHERE fb_so_id = r.fb_so_id AND customer_order_id IS NULL;
    IF FOUND THEN
      v_linked_orders := v_linked_orders + 1;
    END IF;

    FOR l IN
      SELECT id, line_number, part_id, quantity_ordered, due_date
        FROM public.customer_order_lines
       WHERE customer_order_id = r.id AND status IN ('not_started', 'in_progress')
       ORDER BY line_number
    LOOP
      IF EXISTS (SELECT 1 FROM public.fb_sales_order_lines WHERE customer_order_line_id = l.id) THEN
        CONTINUE;
      END IF;
      SELECT count(*) INTO v_n
        FROM public.fb_sales_order_lines f
       WHERE f.fb_so_id = r.fb_so_id AND f.removed_at IS NULL AND f.customer_order_line_id IS NULL
         AND f.part_id = l.part_id AND f.type_id IN (10, 12);
      IF v_n = 0 THEN
        v_unlinked := v_unlinked || jsonb_build_object('co_number', r.co_number, 'line_number', l.line_number);
        CONTINUE;
      END IF;
      SELECT f.fb_soitem_id, f.qty_ordered, f.qty_fulfilled, f.qty_to_fulfill INTO cand
        FROM public.fb_sales_order_lines f
       WHERE f.fb_so_id = r.fb_so_id AND f.removed_at IS NULL AND f.customer_order_line_id IS NULL
         AND f.part_id = l.part_id AND f.type_id IN (10, 12)
       ORDER BY (f.qty_ordered = l.quantity_ordered) DESC,
                (f.effective_due_date IS NOT DISTINCT FROM l.due_date) DESC,
                f.line_number
       LIMIT 1;
      UPDATE public.fb_sales_order_lines
         SET customer_order_line_id = l.id, disposition = 'production', disposition_at = now(),
             disposition_note = 'Linked to existing CO by fb_link_existing_cos'
       WHERE fb_soitem_id = cand.fb_soitem_id;
      UPDATE public.customer_order_lines
         SET fb_qty_ordered = cand.qty_ordered, fb_qty_fulfilled = cand.qty_fulfilled, fb_qty_to_fulfill = cand.qty_to_fulfill
       WHERE id = l.id;
      v_linked_lines := v_linked_lines + 1;
      IF v_n > 1 THEN
        v_ambiguous := v_ambiguous || jsonb_build_object('co_number', r.co_number, 'line_number', l.line_number,
                                                         'candidates', v_n, 'picked_fb_soitem_id', cand.fb_soitem_id);
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'linked_orders', v_linked_orders, 'linked_lines', v_linked_lines,
    'ambiguous', v_ambiguous, 'unmatched_open_cos', v_unmatched, 'co_lines_without_fb_line', v_unlinked);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fb_set_disposition(integer[], text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fb_convert_to_co(integer, integer[])      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fb_ack_event(bigint)                      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fb_reresolve_lines()                      FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fb_set_disposition(integer[], text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fb_convert_to_co(integer, integer[])      TO authenticated;
GRANT EXECUTE ON FUNCTION public.fb_ack_event(bigint)                      TO authenticated;
GRANT EXECUTE ON FUNCTION public.fb_reresolve_lines()                      TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. Queue view v2: covered_lines, actionable_lines, suspect_dates (D-FB-24)
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_fb_order_queue;
CREATE VIEW public.v_fb_order_queue WITH (security_invoker = true) AS
SELECT s.fb_so_id, s.so_number, s.fb_customer_id, s.customer_id, s.customer_name, s.customer_po,
       s.status_id, s.priority_id, s.salesman, s.location_group_id,
       s.fb_date_created, s.fb_date_issued, s.fb_date_last_modified, s.last_synced_at,
       s.customer_order_id, co.co_number AS linked_co_number,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL)                                   AS line_count,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'pending')     AS pending_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'production')  AS production_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'stock')       AS stock_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'purchased')   AS purchased_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'covered')     AS covered_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'unlisted')    AS unlisted_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition IN ('ignore','kit_header')) AS ignored_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.type_id IN (10, 12) AND l.customer_order_line_id IS NULL) AS actionable_lines,
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
  (SELECT pg_get_constraintdef(oid) LIKE '%covered%' FROM pg_constraint
     WHERE conname = 'fb_sales_order_lines_disposition_check')                                                  AS covered_ok,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('fb_set_disposition','fb_convert_to_co','fb_ack_event','fb_reresolve_lines','fb_link_existing_cos')) AS fb_functions_b,
  (SELECT count(*) FROM information_schema.columns WHERE table_name = 'v_fb_order_queue'
     AND column_name IN ('covered_lines','actionable_lines','suspect_dates'))                                   AS view_cols,
  (SELECT public.fb_reresolve_lines())                                                                          AS reresolved_now,
  (SELECT count(*) FROM public.v_fb_order_queue WHERE status_id IN (20, 25))                                    AS open_orders;
-- Expected: covered_ok true · fb_functions_b 5 · view_cols 3 · reresolved_now 0 (or small) · open_orders ≈ 144
