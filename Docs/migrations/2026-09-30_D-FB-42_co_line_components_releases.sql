/* ==========================================================================================
   D-FB-42 / D-FB-43 / D-FB-44 / D-CODATE-04  -  Order Queue UX round, Batch A (database)
   Delivered 2026-09-30.  TEST: applied by Claude (see report).  PROD: run by Matt after
   the frontend round passes on TEST.  Run this file top to bottom as ONE sheet in the SQL
   editor or via psql; it is idempotent (CREATE OR REPLACE / IF NOT EXISTS / ON CONFLICT).

   What it does
   1. customer_order_line_components   - structured "Components Needed" per CO line
   2. fb_line_purchase_components      - which BOM components a Purchase disposition buys
   3. _co_line_component_ok()          - a component is the part itself or a node of its BOM
   4. fb_convert_to_co v4              - ONE CO LINE PER FISHBOWL LINE (supersedes D-FB-26/27);
                                         p_components = { part_id: { components:[uuid..], note } }
   5. fb_set_disposition v2            - new p_components arg; Purchase on a BOM part requires
                                         the component list (old 3-arg signature dropped)
   6. co_line_set_components()         - edit a CO line's component list (Edit CO modal)
   7. v_co_line_dates v3               - target = later of (entered + 45 bd, real Fishbowl due);
                                         scheduled_finish follows merged jobs to their host
   8. v_co_line_component_status       - per (CO line, component): jobs, latest scheduled end,
                                         state; includes components the WO makes but nobody asked for
   9. backfill: open CO lines whose part has no BOM get themselves as the component
  10. grants + VERIFY
   ========================================================================================== */

/* ---------- 1. customer_order_line_components ---------- */
CREATE TABLE IF NOT EXISTS public.customer_order_line_components (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_order_line_id uuid NOT NULL REFERENCES public.customer_order_lines(id) ON DELETE CASCADE,
  component_id           uuid NOT NULL REFERENCES public.parts(id),
  created_by             uuid REFERENCES public.profiles(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_order_line_id, component_id)
);
CREATE INDEX IF NOT EXISTS idx_colc_line ON public.customer_order_line_components(customer_order_line_id);
ALTER TABLE public.customer_order_line_components ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS colc_select ON public.customer_order_line_components;
CREATE POLICY colc_select ON public.customer_order_line_components FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.customer_order_line_components FROM anon, public;
GRANT SELECT ON public.customer_order_line_components TO authenticated;

/* ---------- 2. fb_line_purchase_components ---------- */
CREATE TABLE IF NOT EXISTS public.fb_line_purchase_components (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fb_soitem_id integer NOT NULL REFERENCES public.fb_sales_order_lines(fb_soitem_id) ON DELETE CASCADE,
  component_id uuid NOT NULL REFERENCES public.parts(id),
  created_by   uuid REFERENCES public.profiles(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fb_soitem_id, component_id)
);
CREATE INDEX IF NOT EXISTS idx_flpc_line ON public.fb_line_purchase_components(fb_soitem_id);
ALTER TABLE public.fb_line_purchase_components ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flpc_select ON public.fb_line_purchase_components;
CREATE POLICY flpc_select ON public.fb_line_purchase_components FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.fb_line_purchase_components FROM anon, public;
GRANT SELECT ON public.fb_line_purchase_components TO authenticated;

/* ---------- 3. component validity ---------- */
CREATE OR REPLACE FUNCTION public._co_line_component_ok(p_part_id uuid, p_component_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_component_id = p_part_id
      OR EXISTS (SELECT 1 FROM public.explode_bom(p_part_id, 1) b WHERE b.component_id = p_component_id AND NOT b.is_cycle);
$$;
REVOKE ALL ON FUNCTION public._co_line_component_ok(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._co_line_component_ok(uuid, uuid) TO authenticated;

/* ---------- 4. fb_convert_to_co v4: one CO line per Fishbowl line ---------- */
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

  /* ---- D-FB-43: one CO line per Fishbowl line, in Fishbowl line order ---- */
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
           disposition_at = now(), disposition_note = 'Converted to ' || v_co_number || ' line ' || v_next_line
     WHERE fb_soitem_id = v_line.fb_soitem_id;

    v_lines_created := v_lines_created + 1;
    v_results := v_results || jsonb_build_object('part_number', v_part_number, 'action', 'created',
                     'co_line_number', v_next_line, 'qty', v_qty, 'fb_lines', v_line.line_number::text,
                     'due', v_line.effective_due_date, 'components', array_length(v_comp_ids, 1));
  END LOOP;

  RETURN jsonb_build_object(
    'customer_order_id', v_co_id, 'co_number', v_co_number, 'created', v_created,
    'lines_created', v_lines_created, 'lines_added', 0, 'lines', v_results, 'skipped', v_skipped);
END;
$function$;
REVOKE ALL ON FUNCTION public.fb_convert_to_co(integer, integer[], jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fb_convert_to_co(integer, integer[], jsonb) TO authenticated;

/* ---------- 5. fb_set_disposition v2: Purchase on a BOM part names the components ---------- */
DROP FUNCTION IF EXISTS public.fb_set_disposition(integer[], text, text);
CREATE OR REPLACE FUNCTION public.fb_set_disposition(p_line_ids integer[], p_disposition text, p_note text DEFAULT NULL::text, p_components jsonb DEFAULT '{}'::jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_eligible integer[];
  v_line     record;
  v_ids      uuid[];
  v_cid      uuid;
  v_n        integer;
BEGIN
  PERFORM public._fb_gate(ARRAY['order_processor', 'admin']);
  IF p_disposition IS NULL OR p_disposition NOT IN ('pending', 'stock', 'purchased', 'covered', 'assembly', 'ignore') THEN
    RAISE EXCEPTION 'Disposition % cannot be set by hand (production goes through Create CO)', COALESCE(p_disposition, 'NULL')
      USING ERRCODE = '22023';
  END IF;
  IF p_line_ids IS NULL OR array_length(p_line_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  SELECT array_agg(fb_soitem_id) INTO v_eligible
    FROM public.fb_sales_order_lines
   WHERE fb_soitem_id = ANY (p_line_ids) AND removed_at IS NULL AND customer_order_line_id IS NULL AND type_id IN (10, 12, 80);
  IF v_eligible IS NULL THEN
    RETURN 0;
  END IF;

  IF p_disposition = 'purchased' THEN
    /* D-FB-42: a Purchase on a SkyNet product that has a BOM must say which component(s) are bought */
    FOR v_line IN
      SELECT f.fb_soitem_id, f.line_number, f.part_id, p.part_number
        FROM public.fb_sales_order_lines f JOIN public.parts p ON p.id = f.part_id
       WHERE f.fb_soitem_id = ANY (v_eligible)
         AND EXISTS (SELECT 1 FROM public.assembly_bom b WHERE b.assembly_id = f.part_id)
       ORDER BY f.line_number
    LOOP
      SELECT array_agg(DISTINCT (e)::uuid) INTO v_ids
        FROM jsonb_array_elements_text(COALESCE(p_components -> (v_line.fb_soitem_id::text), '[]'::jsonb)) e;
      IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
        RAISE EXCEPTION 'Purchase: choose which component(s) of % are being purchased (Fishbowl line %)', v_line.part_number, v_line.line_number
          USING ERRCODE = '22023';
      END IF;
      FOREACH v_cid IN ARRAY v_ids LOOP
        IF NOT public._co_line_component_ok(v_line.part_id, v_cid) THEN
          RAISE EXCEPTION 'Component % is not % or a component of its bill of materials', v_cid, v_line.part_number USING ERRCODE = '22023';
        END IF;
      END LOOP;
      DELETE FROM public.fb_line_purchase_components WHERE fb_soitem_id = v_line.fb_soitem_id;
      INSERT INTO public.fb_line_purchase_components (fb_soitem_id, component_id, created_by)
      SELECT v_line.fb_soitem_id, c, v_uid FROM unnest(v_ids) c;
    END LOOP;
    /* BOM-less parts carry no purchase list */
    DELETE FROM public.fb_line_purchase_components
     WHERE fb_soitem_id = ANY (v_eligible)
       AND NOT EXISTS (SELECT 1 FROM public.fb_sales_order_lines f JOIN public.assembly_bom b ON b.assembly_id = f.part_id
                        WHERE f.fb_soitem_id = fb_line_purchase_components.fb_soitem_id);
  ELSE
    DELETE FROM public.fb_line_purchase_components WHERE fb_soitem_id = ANY (v_eligible);
  END IF;

  UPDATE public.fb_sales_order_lines
     SET disposition = p_disposition,
         disposition_by = v_uid,
         disposition_at = now(),
         disposition_note = NULLIF(btrim(p_note), '')
   WHERE fb_soitem_id = ANY (v_eligible);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;
REVOKE ALL ON FUNCTION public.fb_set_disposition(integer[], text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fb_set_disposition(integer[], text, text, jsonb) TO authenticated;

/* ---------- 6. co_line_set_components: Edit CO modal ---------- */
CREATE OR REPLACE FUNCTION public.co_line_set_components(p_line_id uuid, p_component_ids uuid[], p_note text DEFAULT NULL::text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_part   uuid;
  v_status text;
  v_pn     text;
  v_ids    uuid[];
  v_cid    uuid;
BEGIN
  PERFORM public._fb_gate(ARRAY['order_processor', 'admin', 'customer_service']);
  SELECT col.part_id, col.status, p.part_number INTO v_part, v_status, v_pn
    FROM public.customer_order_lines col JOIN public.parts p ON p.id = col.part_id
   WHERE col.id = p_line_id FOR UPDATE OF col;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CO line not found' USING ERRCODE = '22023';
  END IF;
  IF v_status NOT IN ('not_started', 'in_progress') THEN
    RAISE EXCEPTION 'CO line is %; components can only change on an open line', v_status USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT c) INTO v_ids FROM unnest(COALESCE(p_component_ids, ARRAY[]::uuid[])) c;
  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Components Needed: select at least one component for %', v_pn USING ERRCODE = '22023';
  END IF;
  FOREACH v_cid IN ARRAY v_ids LOOP
    IF NOT public._co_line_component_ok(v_part, v_cid) THEN
      RAISE EXCEPTION 'Component % is not % or a component of its bill of materials', v_cid, v_pn USING ERRCODE = '22023';
    END IF;
  END LOOP;
  DELETE FROM public.customer_order_line_components WHERE customer_order_line_id = p_line_id AND NOT (component_id = ANY (v_ids));
  INSERT INTO public.customer_order_line_components (customer_order_line_id, component_id, created_by)
  SELECT p_line_id, c, v_uid FROM unnest(v_ids) c ON CONFLICT DO NOTHING;
  IF p_note IS NOT NULL THEN
    UPDATE public.customer_order_lines SET components_needed = NULLIF(btrim(p_note), '') WHERE id = p_line_id;
  END IF;
  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('co_line_components_set', v_uid, jsonb_build_object('customer_order_line_id', p_line_id, 'part_number', v_pn, 'component_ids', to_jsonb(v_ids)));
  RETURN array_length(v_ids, 1);
END;
$function$;
REVOKE ALL ON FUNCTION public.co_line_set_components(uuid, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.co_line_set_components(uuid, uuid[], text) TO authenticated;

/* ---------- 7. v_co_line_dates v3 (D-CODATE-04): target = later of 45 bd and a real Fishbowl due ---------- */
CREATE OR REPLACE VIEW public.v_co_line_dates WITH (security_invoker = true) AS
 SELECT col.id AS customer_order_line_id,
    col.customer_order_id,
    COALESCE(fb.entered_on, (col.created_at AT TIME ZONE 'America/New_York')::date) AS entered_on,
    CASE WHEN fb.entered_on IS NOT NULL THEN 'fishbowl'::text ELSE 'skynet'::text END AS entered_source,
    GREATEST(
      add_business_days(COALESCE(fb.entered_on, (col.created_at AT TIME ZONE 'America/New_York')::date), 45),
      CASE WHEN COALESCE(fb.fb_due_is_default, false) THEN NULL::date
           ELSE COALESCE(fb.fb_due, CASE WHEN col.due_date >= '2000-01-01'::date THEN col.due_date ELSE NULL::date END) END
    ) AS target_date,
    COALESCE(fb.fb_due, CASE WHEN col.due_date >= '2000-01-01'::date THEN col.due_date ELSE NULL::date END) AS fb_due_date,
    COALESCE(fb.fb_due_is_default, false) AS fb_due_is_default,
    col.due_date AS line_due_date,
    sf.scheduled_finish,
    COALESCE(sf.has_unscheduled_jobs, false) AS has_unscheduled_jobs
   FROM customer_order_lines col
     LEFT JOIN LATERAL ( SELECT min((so.fb_date_created AT TIME ZONE 'America/New_York')::date) AS entered_on,
            min(CASE WHEN l.effective_due_date >= '2000-01-01'::date THEN l.effective_due_date ELSE NULL::date END) AS fb_due,
            bool_or(l.due_date_is_default) AS fb_due_is_default
           FROM fb_sales_order_lines l
             JOIN fb_sales_orders so ON so.fb_so_id = l.fb_so_id
          WHERE l.customer_order_line_id = col.id AND l.removed_at IS NULL) fb ON true
     LEFT JOIN LATERAL ( SELECT max((COALESCE(h.scheduled_end, j.scheduled_end) AT TIME ZONE 'America/New_York')::date) AS scheduled_finish,
            bool_or(j.scheduled_end IS NULL AND j.status::text IN ('pending_compliance', 'ready', 'assigned')) AS has_unscheduled_jobs
           FROM customer_order_allocations a
             JOIN jobs j ON j.work_order_id = a.work_order_id
             LEFT JOIN jobs h ON h.id = j.merged_into_job_id
          WHERE a.customer_order_line_id = col.id AND a.is_active AND j.status::text <> 'cancelled'
            AND COALESCE(j.is_maintenance, false) = false) sf ON true;

/* ---------- 8. v_co_line_component_status (D-FB-44) ---------- */
CREATE OR REPLACE VIEW public.v_co_line_component_status WITH (security_invoker = true) AS
WITH requested AS (
  SELECT c.customer_order_line_id, c.component_id FROM customer_order_line_components c
), wo_jobs AS (
  SELECT a.customer_order_line_id,
         COALESCE(j.component_id, j.part_id) AS component_id,
         j.id AS job_id, j.job_number, j.status::text AS status, j.quantity,
         (COALESCE(h.scheduled_end, j.scheduled_end) AT TIME ZONE 'America/New_York')::date AS scheduled_end,
         COALESCE(h.assigned_machine_id, j.assigned_machine_id) AS machine_id,
         w.wo_number, h.job_number AS merged_into
    FROM customer_order_allocations a
    JOIN work_orders w ON w.id = a.work_order_id
    JOIN jobs j ON j.work_order_id = a.work_order_id
    LEFT JOIN jobs h ON h.id = j.merged_into_job_id
   WHERE a.is_active AND j.status::text <> 'cancelled'
     AND COALESCE(j.is_maintenance, false) = false
     AND COALESCE(j.is_standalone_finishing, false) = false
), keys AS (
  SELECT customer_order_line_id, component_id FROM requested
  UNION
  SELECT customer_order_line_id, component_id FROM wo_jobs WHERE component_id IS NOT NULL
)
SELECT k.customer_order_line_id, k.component_id,
       p.part_number, p.description, p.part_type,
       (r.component_id IS NOT NULL) AS requested,
       count(wj.job_id) AS job_count,
       max(wj.scheduled_end) AS latest_scheduled_end,
       COALESCE(bool_or(wj.scheduled_end IS NULL AND wj.status IN ('pending_compliance', 'ready', 'assigned')), false) AS has_unscheduled,
       CASE
         WHEN count(wj.job_id) = 0 THEN 'no_job'
         WHEN bool_or(wj.status IN ('in_setup', 'in_progress')) THEN 'running'
         WHEN bool_and(wj.status IN ('manufacturing_complete', 'at_external_vendor', 'ready_for_outsourcing', 'ready_for_assembly',
                                      'in_assembly', 'pending_tco', 'complete', 'merged')) THEN 'made'
         WHEN bool_or(wj.scheduled_end IS NULL AND wj.status IN ('pending_compliance', 'ready', 'assigned')) THEN 'unscheduled'
         ELSE 'scheduled'
       END AS state,
       COALESCE(jsonb_agg(jsonb_build_object(
           'job_number', wj.job_number, 'status', wj.status, 'quantity', wj.quantity,
           'scheduled_end', wj.scheduled_end, 'machine', m.code, 'wo_number', wj.wo_number, 'merged_into', wj.merged_into)
         ORDER BY wj.job_number) FILTER (WHERE wj.job_id IS NOT NULL), '[]'::jsonb) AS jobs
  FROM keys k
  JOIN parts p ON p.id = k.component_id
  LEFT JOIN requested r ON r.customer_order_line_id = k.customer_order_line_id AND r.component_id = k.component_id
  LEFT JOIN wo_jobs wj ON wj.customer_order_line_id = k.customer_order_line_id AND wj.component_id = k.component_id
  LEFT JOIN machines m ON m.id = wj.machine_id
 GROUP BY k.customer_order_line_id, k.component_id, p.part_number, p.description, p.part_type, r.component_id;

/* ---------- 9. backfill: open lines on BOM-less parts make the part itself ---------- */
INSERT INTO public.customer_order_line_components (customer_order_line_id, component_id, created_by)
SELECT col.id, col.part_id, NULL
  FROM public.customer_order_lines col
 WHERE col.status IN ('not_started', 'in_progress')
   AND NOT EXISTS (SELECT 1 FROM public.assembly_bom b WHERE b.assembly_id = col.part_id)
   AND NOT EXISTS (SELECT 1 FROM public.customer_order_line_components c WHERE c.customer_order_line_id = col.id)
ON CONFLICT DO NOTHING;

/* ---------- 10. grants ---------- */
REVOKE ALL ON public.v_co_line_dates, public.v_co_line_component_status FROM anon, authenticated, public;
GRANT SELECT ON public.v_co_line_dates, public.v_co_line_component_status TO authenticated;
REVOKE ALL ON public.v_wo_dates FROM anon, public;
GRANT SELECT ON public.v_wo_dates TO authenticated;

/* ---------- VERIFY (one row; expect convert_v4 = 1, set_disp_4arg = 1, set_disp_3arg = 0, views 2, anon grants 0) ---------- */
SELECT jsonb_build_object(
  'convert_v4',      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fb_convert_to_co' AND pg_get_functiondef(p.oid) LIKE '%D-FB-43%'),
  'set_disp_4arg',   (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fb_set_disposition' AND p.pronargs = 4),
  'set_disp_3arg',   (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fb_set_disposition' AND p.pronargs = 3),
  'views',           (SELECT count(*) FROM pg_views WHERE schemaname = 'public' AND viewname IN ('v_co_line_dates', 'v_co_line_component_status')),
  'anon_view_grants',(SELECT count(*) FROM information_schema.role_table_grants WHERE grantee = 'anon' AND table_name IN ('v_co_line_dates', 'v_co_line_component_status', 'customer_order_line_components', 'fb_line_purchase_components')),
  'backfilled_self_rows', (SELECT count(*) FROM public.customer_order_line_components c JOIN public.customer_order_lines col ON col.id = c.customer_order_line_id WHERE c.component_id = col.part_id),
  'open_lines_without_components', (SELECT count(*) FROM public.customer_order_lines col WHERE col.status IN ('not_started','in_progress') AND NOT EXISTS (SELECT 1 FROM public.customer_order_line_components c WHERE c.customer_order_line_id = col.id)),
  'target_moved_later', (SELECT count(*) FROM public.v_co_line_dates d JOIN public.customer_order_lines col ON col.id = d.customer_order_line_id WHERE col.status IN ('not_started','in_progress') AND d.target_date > add_business_days(d.entered_on, 45))
) AS verify;
