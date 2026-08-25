-- ============================================================================
-- FB1 Batch C1 — Queue refinements: kit parent tagging, per-part CO conversion with
--   mandatory Components Needed, `assembly` disposition, inactive-part block, RPSD in the diff
-- File: Docs/migrations/2026-08-26_fishbowl_bridge_c1.sql
-- Requires: _a and _b applied. TEST first. Idempotent.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Kit parent link (D-FB-29) — set by the bridge from Fishbowl `kititem`
-- ---------------------------------------------------------------------------
ALTER TABLE public.fb_sales_order_lines ADD COLUMN IF NOT EXISTS parent_fb_soitem_id integer;
CREATE INDEX IF NOT EXISTS idx_fbsol_parent ON public.fb_sales_order_lines (parent_fb_soitem_id) WHERE parent_fb_soitem_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Disposition CHECK: add `assembly` (D-FB-28)
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
  CHECK (disposition IN ('pending','production','stock','purchased','covered','assembly','kit_header','ignore','unlisted'));

-- ---------------------------------------------------------------------------
-- 3. fb_set_disposition v2: `assembly` allowed by hand
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_set_disposition(p_line_ids integer[], p_disposition text, p_note text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM public._fb_gate(ARRAY['order_processor', 'admin']);
  IF p_disposition IS NULL OR p_disposition NOT IN ('pending', 'stock', 'purchased', 'covered', 'assembly', 'ignore') THEN
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
-- 4. fb_convert_to_co v2 (D-FB-26/27/30): one CO line per part; adds to an open CO line
--    for the same part when one exists; Components Needed mandatory for new lines;
--    inactive parts refused. Old 2-argument signature dropped so PostgREST sees one function.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.fb_convert_to_co(integer, integer[]);

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
    IF round(COALESCE(v_line.qty_to_fulfill, v_line.qty_ordered - v_line.qty_fulfilled))::integer <= 0 THEN
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
           SUM(round(COALESCE(f.qty_to_fulfill, f.qty_ordered - f.qty_fulfilled))::integer) AS qty,
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
-- 5. Ingest v2
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_ingest_delta(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_source        text := COALESCE(p_payload->>'source', 'tail');
  v_rev_to        bigint := NULLIF(p_payload->>'rev_to', '')::bigint;
  v_emit          boolean;
  v_order         jsonb;
  v_h             jsonb;
  v_l             jsonb;
  v_so_id         integer;
  v_status        smallint;
  v_fp            text;
  v_old           public.fb_sales_orders%ROWTYPE;
  v_new_so        boolean;
  v_customer_id   uuid;
  v_changes       jsonb;
  v_rev           bigint;
  v_rev_user      integer;
  v_rev_ts        timestamptz;
  v_rev_username  text;
  v_line_old      public.fb_sales_order_lines%ROWTYPE;
  v_line_id       integer;
  v_lfp           text;
  v_part_id       uuid;
  v_part_type     text;
  v_kit_id        uuid;
  v_resolution    text;
  v_disposition   text;
  v_key           text;
  v_part_num      text;
  v_product_num   text;
  v_type          smallint;
  v_lstatus       smallint;
  v_dsf           timestamptz;
  v_rpsd          date;
  v_eff           date;
  v_default       boolean;
  v_qty_ordered   numeric;
  v_qty_fulfilled numeric;
  v_qty_to_fulfill numeric;
  v_ids           integer[];
  v_removed_id    integer;
  v_col           record;
  v_alloc         numeric;
  v_delta         numeric;
  v_ack           boolean;
  c_ins  integer := 0;  c_upd  integer := 0;  c_same integer := 0;  c_skip integer := 0;  c_gone integer := 0;
  c_lins integer := 0;  c_lupd integer := 0;  c_lrem integer := 0;  c_ev   integer := 0;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration', 'admin']);
  v_emit := v_source <> 'backfill';

  FOR v_order IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'orders', '[]'::jsonb)) LOOP
    v_h      := v_order->'header';
    v_so_id  := (v_h->>'id')::integer;
    v_status := (v_h->>'statusId')::smallint;
    v_rev      := NULLIF(v_order->>'rev', '')::bigint;
    v_rev_user := NULLIF(v_order->>'revUserId', '')::integer;
    v_rev_ts   := NULLIF(v_order->>'revTimestamp', '')::timestamptz;
    v_rev_username := NULL;
    IF v_rev_user IS NOT NULL THEN
      SELECT username INTO v_rev_username FROM public.fb_users WHERE fb_user_id = v_rev_user;
    END IF;
    v_fp := md5((v_h - 'dateLastModified')::text);

    SELECT * INTO v_old FROM public.fb_sales_orders WHERE fb_so_id = v_so_id FOR UPDATE;
    v_new_so := NOT FOUND;

    -- D-FB-11: only Issued / In Progress orders enter SkyNet; anything already mirrored keeps updating.
    IF v_new_so AND v_status NOT IN (20, 25) THEN
      c_skip := c_skip + 1;
      CONTINUE;
    END IF;

    -- Customer resolve (customers.customer_id is the Fishbowl id as text); auto-create from Fishbowl data.
    v_customer_id := NULL;
    SELECT id INTO v_customer_id FROM public.customers WHERE customer_id = (v_h->>'customerId');
    IF v_customer_id IS NULL AND (v_h->>'customerId') ~ '^[0-9]{1,6}$' AND COALESCE(v_h->>'customerName', '') <> '' THEN
      INSERT INTO public.customers (customer_id, name, is_active, notes)
      VALUES (v_h->>'customerId', v_h->>'customerName', true,
              'Auto-created by Fishbowl Bridge from SO ' || COALESCE(v_h->>'num', ''))
      RETURNING id INTO v_customer_id;
    END IF;

    IF v_new_so THEN
      INSERT INTO public.fb_sales_orders (
        fb_so_id, so_number, fb_customer_id, customer_name, customer_po, status_id, priority_id, type_id,
        location_group_id, salesman, salesman_id, created_by_username, fb_date_created, fb_date_issued,
        fb_date_completed, fb_date_last_modified, note, ship_to_name, custom_fields, raw, fingerprint, last_rev, customer_id)
      VALUES (
        v_so_id, COALESCE(v_h->>'num', ''), (v_h->>'customerId')::integer, v_h->>'customerName', v_h->>'customerPO',
        v_status, NULLIF(v_h->>'priorityId', '')::smallint, NULLIF(v_h->>'typeId', '')::smallint,
        NULLIF(v_h->>'locationGroupId', '')::smallint, v_h->>'salesman', NULLIF(v_h->>'salesmanId', '')::integer,
        v_h->>'username', NULLIF(v_h->>'dateCreated', '')::timestamptz, NULLIF(v_h->>'dateIssued', '')::timestamptz,
        NULLIF(v_h->>'dateCompleted', '')::timestamptz, NULLIF(v_h->>'dateLastModified', '')::timestamptz,
        v_h->>'note', v_h->>'shipToName', v_h->'customFields', v_h, v_fp, v_rev, v_customer_id);
      c_ins := c_ins + 1;
      IF v_emit THEN
        INSERT INTO public.fb_sync_events (fb_so_id, event_type, changes, fb_rev, fb_modified_user_id, fb_username, fb_timestamp)
        VALUES (v_so_id, 'so_created', jsonb_build_object('status_id', v_status, 'so_number', v_h->>'num'), v_rev, v_rev_user, v_rev_username, v_rev_ts);
        c_ev := c_ev + 1;
      END IF;

    ELSIF v_old.fingerprint IS DISTINCT FROM v_fp OR v_old.removed_at IS NOT NULL THEN
      v_changes := '{}'::jsonb;
      IF v_old.status_id IS DISTINCT FROM v_status THEN
        v_changes := v_changes || jsonb_build_object('status_id', jsonb_build_object('old', v_old.status_id, 'new', v_status));
      END IF;
      IF v_old.customer_po IS DISTINCT FROM (v_h->>'customerPO') THEN
        v_changes := v_changes || jsonb_build_object('customer_po', jsonb_build_object('old', v_old.customer_po, 'new', v_h->>'customerPO'));
      END IF;
      IF v_old.priority_id IS DISTINCT FROM NULLIF(v_h->>'priorityId', '')::smallint THEN
        v_changes := v_changes || jsonb_build_object('priority_id', jsonb_build_object('old', v_old.priority_id, 'new', NULLIF(v_h->>'priorityId', '')::smallint));
      END IF;
      IF v_old.salesman IS DISTINCT FROM (v_h->>'salesman') THEN
        v_changes := v_changes || jsonb_build_object('salesman', jsonb_build_object('old', v_old.salesman, 'new', v_h->>'salesman'));
      END IF;
      IF v_old.customer_name IS DISTINCT FROM (v_h->>'customerName') THEN
        v_changes := v_changes || jsonb_build_object('customer_name', jsonb_build_object('old', v_old.customer_name, 'new', v_h->>'customerName'));
      END IF;
      IF v_old.note IS DISTINCT FROM (v_h->>'note') THEN
        v_changes := v_changes || jsonb_build_object('note', jsonb_build_object('old', left(v_old.note, 200), 'new', left(v_h->>'note', 200)));
      END IF;
      IF v_old.removed_at IS NOT NULL THEN
        v_changes := v_changes || jsonb_build_object('reappeared', jsonb_build_object('old', true, 'new', false));
      END IF;

      UPDATE public.fb_sales_orders SET
        so_number = COALESCE(v_h->>'num', so_number),
        fb_customer_id = (v_h->>'customerId')::integer,
        customer_name = v_h->>'customerName',
        customer_po = v_h->>'customerPO',
        status_id = v_status,
        priority_id = NULLIF(v_h->>'priorityId', '')::smallint,
        type_id = NULLIF(v_h->>'typeId', '')::smallint,
        location_group_id = NULLIF(v_h->>'locationGroupId', '')::smallint,
        salesman = v_h->>'salesman',
        salesman_id = NULLIF(v_h->>'salesmanId', '')::integer,
        created_by_username = v_h->>'username',
        fb_date_created = NULLIF(v_h->>'dateCreated', '')::timestamptz,
        fb_date_issued = NULLIF(v_h->>'dateIssued', '')::timestamptz,
        fb_date_completed = NULLIF(v_h->>'dateCompleted', '')::timestamptz,
        fb_date_last_modified = NULLIF(v_h->>'dateLastModified', '')::timestamptz,
        note = v_h->>'note',
        ship_to_name = v_h->>'shipToName',
        custom_fields = v_h->'customFields',
        raw = v_h,
        fingerprint = v_fp,
        last_rev = COALESCE(v_rev, last_rev),
        last_synced_at = now(),
        removed_at = NULL,
        customer_id = COALESCE(customer_id, v_customer_id)
      WHERE fb_so_id = v_so_id;
      c_upd := c_upd + 1;

      IF v_emit AND v_changes <> '{}'::jsonb THEN
        INSERT INTO public.fb_sync_events (fb_so_id, event_type, changes, fb_rev, fb_modified_user_id, fb_username, fb_timestamp, affects_co, requires_ack)
        VALUES (v_so_id,
                CASE WHEN v_changes ? 'status_id' THEN 'so_status_changed' ELSE 'so_changed' END,
                v_changes, v_rev, v_rev_user, v_rev_username, v_rev_ts,
                v_old.customer_order_id IS NOT NULL,
                v_old.customer_order_id IS NOT NULL AND v_status IN (80, 85, 90));
        c_ev := c_ev + 1;
      END IF;

      -- D-FB-14: PO number is a safe field on the linked CO.
      IF v_old.customer_order_id IS NOT NULL AND v_changes ? 'customer_po' THEN
        UPDATE public.customer_orders SET po_number = v_h->>'customerPO', updated_at = now()
         WHERE id = v_old.customer_order_id;
      END IF;

    ELSE
      UPDATE public.fb_sales_orders
         SET last_rev = COALESCE(v_rev, last_rev), last_synced_at = now(),
             fb_date_last_modified = COALESCE(NULLIF(v_h->>'dateLastModified', '')::timestamptz, fb_date_last_modified)
       WHERE fb_so_id = v_so_id;
      c_same := c_same + 1;
    END IF;

    -- ----- lines -----
    v_ids := ARRAY[]::integer[];
    FOR v_l IN SELECT * FROM jsonb_array_elements(COALESCE(v_order->'lines', '[]'::jsonb)) LOOP
      v_line_id := (v_l->>'id')::integer;
      v_ids := v_ids || v_line_id;
      v_lfp := md5((v_l - 'dateLastModified')::text);
      v_type := (v_l->>'typeId')::smallint;
      v_lstatus := (v_l->>'statusId')::smallint;
      v_product_num := COALESCE(v_l->>'productNum', '');
      v_part_num := NULLIF(v_l->>'partNum', '');
      v_dsf := NULLIF(v_l->>'dateScheduledFulfillment', '')::timestamptz;
      v_rpsd := NULLIF(v_l->>'remainingPartsShipDate', '')::date;
      v_eff := COALESCE(v_rpsd, (v_dsf AT TIME ZONE 'America/New_York')::date);
      v_default := v_rpsd IS NULL AND v_dsf IS NOT NULL
                   AND (v_dsf AT TIME ZONE 'America/New_York')::time <> TIME '00:00:00';
      v_qty_ordered := COALESCE(NULLIF(v_l->>'qtyOrdered', '')::numeric, 0);
      v_qty_fulfilled := COALESCE(NULLIF(v_l->>'qtyFulfilled', '')::numeric, 0);
      v_qty_to_fulfill := NULLIF(v_l->>'qtyToFulfill', '')::numeric;

      SELECT * INTO v_line_old FROM public.fb_sales_order_lines WHERE fb_soitem_id = v_line_id FOR UPDATE;

      IF NOT FOUND THEN
        -- D-FB-08 resolution, D-FB-09 auto-disposition (first sight only)
        v_part_id := NULL; v_part_type := NULL; v_kit_id := NULL;
        v_key := upper(btrim(COALESCE(v_part_num, v_product_num)));
        IF v_type = 80 THEN
          SELECT id INTO v_kit_id FROM public.kit_skus WHERE upper(btrim(part_number)) = upper(btrim(v_product_num)) LIMIT 1;
          v_resolution := CASE WHEN v_kit_id IS NOT NULL THEN 'kit' ELSE 'unlisted_skybolt' END;
          v_disposition := 'kit_header';
        ELSIF v_type IN (10, 12) THEN
          SELECT id, part_type INTO v_part_id, v_part_type FROM public.parts WHERE upper(btrim(part_number)) = v_key LIMIT 1;
          IF v_part_id IS NULL AND v_part_num IS NOT NULL THEN
            SELECT id, part_type INTO v_part_id, v_part_type FROM public.parts WHERE upper(btrim(part_number)) = upper(btrim(v_product_num)) LIMIT 1;
          END IF;
          IF v_part_id IS NOT NULL THEN
            v_resolution := 'part';
            v_disposition := CASE WHEN v_part_type = 'purchased' THEN 'purchased' ELSE 'pending' END;
          ELSIF v_key ~ '^(SK|ZG|QL)' THEN
            v_resolution := 'unlisted_skybolt';
            v_disposition := 'pending';
          ELSE
            v_resolution := 'unlisted';
            v_disposition := 'unlisted';
          END IF;
        ELSE
          v_resolution := 'n_a';
          v_disposition := 'ignore';
        END IF;

        INSERT INTO public.fb_sales_order_lines (
          fb_soitem_id, fb_so_id, line_number, type_id, status_id, product_num, part_num, fb_product_id, fb_part_id,
          fb_part_type_id, description, qty_ordered, qty_fulfilled, qty_picked, qty_to_fulfill, uom_id, unit_price,
          total_price, date_scheduled_fulfillment, remaining_parts_ship_date, effective_due_date, due_date_is_default,
          rev_level, customer_part_num, note, custom_fields, raw, fingerprint, last_rev, parent_fb_soitem_id,
          part_id, kit_sku_id, resolution, disposition)
        VALUES (
          v_line_id, v_so_id, COALESCE((v_l->>'soLineItem')::integer, 0), v_type, v_lstatus, v_product_num, v_part_num,
          NULLIF(v_l->>'productId', '')::integer, NULLIF(v_l->>'fbPartId', '')::integer,
          NULLIF(v_l->>'partTypeId', '')::smallint, v_l->>'description', v_qty_ordered, v_qty_fulfilled,
          NULLIF(v_l->>'qtyPicked', '')::numeric, v_qty_to_fulfill, NULLIF(v_l->>'uomId', '')::integer,
          NULLIF(v_l->>'unitPrice', '')::numeric, NULLIF(v_l->>'totalPrice', '')::numeric, v_dsf, v_rpsd, v_eff, v_default,
          v_l->>'revLevel', v_l->>'customerPartNum', v_l->>'note', v_l->'customFields', v_l, v_lfp, v_rev,
          NULLIF(v_l->>'parentId', '')::integer,
          v_part_id, v_kit_id, v_resolution, v_disposition);
        c_lins := c_lins + 1;
        IF v_emit AND NOT v_new_so THEN
          INSERT INTO public.fb_sync_events (fb_so_id, fb_soitem_id, event_type, changes, fb_rev, fb_modified_user_id, fb_username, fb_timestamp)
          VALUES (v_so_id, v_line_id, 'line_added',
                  jsonb_build_object('product_num', v_product_num, 'qty_ordered', v_qty_ordered, 'disposition', v_disposition),
                  v_rev, v_rev_user, v_rev_username, v_rev_ts);
          c_ev := c_ev + 1;
        END IF;

      ELSIF v_line_old.fingerprint IS DISTINCT FROM v_lfp OR v_line_old.removed_at IS NOT NULL THEN
        v_changes := '{}'::jsonb;
        IF v_line_old.qty_ordered IS DISTINCT FROM v_qty_ordered THEN
          v_changes := v_changes || jsonb_build_object('qty_ordered', jsonb_build_object('old', v_line_old.qty_ordered, 'new', v_qty_ordered));
        END IF;
        IF v_line_old.qty_fulfilled IS DISTINCT FROM v_qty_fulfilled THEN
          v_changes := v_changes || jsonb_build_object('qty_fulfilled', jsonb_build_object('old', v_line_old.qty_fulfilled, 'new', v_qty_fulfilled));
        END IF;
        IF v_line_old.qty_to_fulfill IS DISTINCT FROM v_qty_to_fulfill THEN
          v_changes := v_changes || jsonb_build_object('qty_to_fulfill', jsonb_build_object('old', v_line_old.qty_to_fulfill, 'new', v_qty_to_fulfill));
        END IF;
        IF v_line_old.status_id IS DISTINCT FROM v_lstatus THEN
          v_changes := v_changes || jsonb_build_object('status_id', jsonb_build_object('old', v_line_old.status_id, 'new', v_lstatus));
        END IF;
        IF v_line_old.effective_due_date IS DISTINCT FROM v_eff THEN
          v_changes := v_changes || jsonb_build_object('effective_due_date', jsonb_build_object('old', v_line_old.effective_due_date, 'new', v_eff));
        END IF;
        IF v_line_old.remaining_parts_ship_date IS DISTINCT FROM v_rpsd THEN
          v_changes := v_changes || jsonb_build_object('remaining_parts_ship_date', jsonb_build_object('old', v_line_old.remaining_parts_ship_date, 'new', v_rpsd));
        END IF;
        IF v_line_old.product_num IS DISTINCT FROM v_product_num THEN
          v_changes := v_changes || jsonb_build_object('product_num', jsonb_build_object('old', v_line_old.product_num, 'new', v_product_num));
        END IF;
        IF v_line_old.removed_at IS NOT NULL THEN
          v_changes := v_changes || jsonb_build_object('reappeared', jsonb_build_object('old', true, 'new', false));
        END IF;

        UPDATE public.fb_sales_order_lines SET
          line_number = COALESCE((v_l->>'soLineItem')::integer, line_number),
          type_id = v_type,
          status_id = v_lstatus,
          product_num = v_product_num,
          part_num = v_part_num,
          fb_product_id = NULLIF(v_l->>'productId', '')::integer,
          fb_part_id = NULLIF(v_l->>'fbPartId', '')::integer,
          fb_part_type_id = NULLIF(v_l->>'partTypeId', '')::smallint,
          description = v_l->>'description',
          qty_ordered = v_qty_ordered,
          qty_fulfilled = v_qty_fulfilled,
          qty_picked = NULLIF(v_l->>'qtyPicked', '')::numeric,
          qty_to_fulfill = v_qty_to_fulfill,
          uom_id = NULLIF(v_l->>'uomId', '')::integer,
          unit_price = NULLIF(v_l->>'unitPrice', '')::numeric,
          total_price = NULLIF(v_l->>'totalPrice', '')::numeric,
          date_scheduled_fulfillment = v_dsf,
          remaining_parts_ship_date = v_rpsd,
          effective_due_date = v_eff,
          due_date_is_default = v_default,
          rev_level = v_l->>'revLevel',
          customer_part_num = v_l->>'customerPartNum',
          note = v_l->>'note',
          custom_fields = v_l->'customFields',
          raw = v_l,
          fingerprint = v_lfp,
          last_rev = COALESCE(v_rev, last_rev),
          last_synced_at = now(),
          removed_at = NULL,
          parent_fb_soitem_id = NULLIF(v_l->>'parentId', '')::integer
        WHERE fb_soitem_id = v_line_id;
        c_lupd := c_lupd + 1;

        -- D-FB-14 / D-FB-15: propagate to the linked CO line
        v_ack := false;
        IF v_line_old.customer_order_line_id IS NOT NULL THEN
          SELECT id, status, quantity_ordered, quantity_fulfilled, due_date INTO v_col
            FROM public.customer_order_lines WHERE id = v_line_old.customer_order_line_id;
          IF FOUND THEN
            -- D-FB-26: several Fishbowl lines may share one CO line — the CO line shows their sums.
            UPDATE public.customer_order_lines c
               SET fb_qty_ordered = s.o, fb_qty_fulfilled = s.f, fb_qty_to_fulfill = s.t
              FROM (SELECT SUM(qty_ordered) AS o, SUM(qty_fulfilled) AS f, SUM(qty_to_fulfill) AS t
                      FROM public.fb_sales_order_lines
                     WHERE customer_order_line_id = v_col.id AND removed_at IS NULL) s
             WHERE c.id = v_col.id;
            IF v_col.status IN ('not_started', 'in_progress') THEN
              IF v_changes ? 'qty_ordered' THEN
                v_delta := v_qty_ordered - v_line_old.qty_ordered;
                SELECT COALESCE(SUM(quantity_allocated), 0) INTO v_alloc
                  FROM public.customer_order_allocations
                 WHERE customer_order_line_id = v_col.id AND is_active;
                IF v_delta > 0
                   OR ((v_col.quantity_ordered + v_delta) >= (v_alloc + v_col.quantity_fulfilled)
                       AND (v_col.quantity_ordered + v_delta) > 0) THEN
                  UPDATE public.customer_order_lines
                     SET quantity_ordered = quantity_ordered + round(v_delta)::integer
                   WHERE id = v_col.id;
                ELSE
                  v_ack := true;
                END IF;
              END IF;
              IF v_changes ? 'effective_due_date' AND v_eff IS NOT NULL THEN
                UPDATE public.customer_order_lines SET due_date = v_eff WHERE id = v_col.id;
              END IF;
              IF v_lstatus IN (70, 75) THEN
                v_ack := true;
              END IF;
            END IF;
          END IF;
        END IF;

        IF v_emit AND v_changes <> '{}'::jsonb THEN
          INSERT INTO public.fb_sync_events (fb_so_id, fb_soitem_id, event_type, changes, fb_rev, fb_modified_user_id, fb_username, fb_timestamp, affects_co, requires_ack)
          VALUES (v_so_id, v_line_id,
                  CASE WHEN v_changes ? 'status_id' THEN 'line_status_changed' ELSE 'line_changed' END,
                  v_changes, v_rev, v_rev_user, v_rev_username, v_rev_ts,
                  v_line_old.customer_order_line_id IS NOT NULL, v_ack);
          c_ev := c_ev + 1;
        END IF;

      ELSE
        UPDATE public.fb_sales_order_lines
           SET last_rev = COALESCE(v_rev, last_rev), last_synced_at = now()
         WHERE fb_soitem_id = v_line_id;
      END IF;
    END LOOP;

    -- D-FB-05: lines no longer on the SO
    IF COALESCE((v_order->>'complete')::boolean, true) THEN
      FOR v_line_old IN
        SELECT * FROM public.fb_sales_order_lines
         WHERE fb_so_id = v_so_id AND removed_at IS NULL AND NOT (fb_soitem_id = ANY (v_ids))
      LOOP
        UPDATE public.fb_sales_order_lines
           SET removed_at = now(), last_rev = COALESCE(v_rev, last_rev), last_synced_at = now()
         WHERE fb_soitem_id = v_line_old.fb_soitem_id;
        c_lrem := c_lrem + 1;
        IF v_line_old.customer_order_line_id IS NOT NULL THEN
          UPDATE public.customer_order_lines c
             SET fb_qty_ordered = s.o, fb_qty_fulfilled = s.f, fb_qty_to_fulfill = s.t
            FROM (SELECT SUM(qty_ordered) AS o, SUM(qty_fulfilled) AS f, SUM(qty_to_fulfill) AS t
                    FROM public.fb_sales_order_lines
                   WHERE customer_order_line_id = v_line_old.customer_order_line_id AND removed_at IS NULL) s
           WHERE c.id = v_line_old.customer_order_line_id;
        END IF;
        IF v_emit THEN
          v_ack := false;
          IF v_line_old.customer_order_line_id IS NOT NULL THEN
            SELECT (status IN ('not_started', 'in_progress')) INTO v_ack
              FROM public.customer_order_lines WHERE id = v_line_old.customer_order_line_id;
          END IF;
          INSERT INTO public.fb_sync_events (fb_so_id, fb_soitem_id, event_type, changes, fb_rev, fb_modified_user_id, fb_username, fb_timestamp, affects_co, requires_ack)
          VALUES (v_so_id, v_line_old.fb_soitem_id, 'line_removed',
                  jsonb_build_object('product_num', v_line_old.product_num, 'qty_ordered', v_line_old.qty_ordered),
                  v_rev, v_rev_user, v_rev_username, v_rev_ts,
                  v_line_old.customer_order_line_id IS NOT NULL, COALESCE(v_ack, false));
          c_ev := c_ev + 1;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  -- SOs that no longer exist in Fishbowl
  FOR v_removed_id IN
    SELECT value::integer FROM jsonb_array_elements_text(COALESCE(p_payload->'removed_ids', '[]'::jsonb))
  LOOP
    SELECT * INTO v_old FROM public.fb_sales_orders WHERE fb_so_id = v_removed_id AND removed_at IS NULL FOR UPDATE;
    IF FOUND THEN
      UPDATE public.fb_sales_orders SET removed_at = now(), last_synced_at = now() WHERE fb_so_id = v_removed_id;
      c_gone := c_gone + 1;
      IF v_emit THEN
        INSERT INTO public.fb_sync_events (fb_so_id, event_type, changes, affects_co, requires_ack)
        VALUES (v_removed_id, 'so_removed', jsonb_build_object('so_number', v_old.so_number),
                v_old.customer_order_id IS NOT NULL, v_old.customer_order_id IS NOT NULL);
        c_ev := c_ev + 1;
      END IF;
    END IF;
  END LOOP;

  -- cursor / state
  IF v_source = 'tail' AND v_rev_to IS NOT NULL THEN
    UPDATE public.fb_sync_state
       SET last_rev = GREATEST(last_rev, v_rev_to), last_rev_at = now(), updated_at = now()
     WHERE id = 1;
  ELSIF v_source = 'reconcile' THEN
    UPDATE public.fb_sync_state SET last_reconcile_at = now(), updated_at = now() WHERE id = 1;
  ELSIF v_source = 'backfill' THEN
    UPDATE public.fb_sync_state SET last_backfill_at = now(), updated_at = now() WHERE id = 1;
  END IF;

  RETURN jsonb_build_object(
    'orders_inserted', c_ins, 'orders_updated', c_upd, 'orders_unchanged', c_same, 'orders_skipped', c_skip,
    'orders_removed', c_gone, 'lines_inserted', c_lins, 'lines_updated', c_lupd, 'lines_removed', c_lrem, 'events', c_ev);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Queue view v3: assembly_lines
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
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'assembly')    AS assembly_lines,
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
  (SELECT count(*) FROM information_schema.columns WHERE table_name = 'fb_sales_order_lines' AND column_name = 'parent_fb_soitem_id') AS parent_col,
  (SELECT pg_get_constraintdef(oid) LIKE '%assembly%' FROM pg_constraint WHERE conname = 'fb_sales_order_lines_disposition_check') AS assembly_ok,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fb_convert_to_co')                                              AS convert_overloads,
  (SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fb_convert_to_co' LIMIT 1)                                       AS convert_signature,
  (SELECT count(*) FROM information_schema.columns WHERE table_name = 'v_fb_order_queue' AND column_name = 'assembly_lines') AS view_col;
-- Expected: parent_col 1 · assembly_ok true · convert_overloads 1 · convert_signature "p_fb_so_id integer, p_line_ids integer[], p_components jsonb" · view_col 1
