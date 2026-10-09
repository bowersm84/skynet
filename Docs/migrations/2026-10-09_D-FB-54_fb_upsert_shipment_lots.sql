/* =====================================================================================
   2026-10-09_D-FB-54_fb_upsert_shipment_lots.sql
   Bridge 1.9 shipments poller -- the SkyNet side. Adds:
     - fb_sync_state.last_shipments_at (the poller's clock, stamped by the RPC)
     - public.fb_upsert_shipment_lots(p_rows jsonb) RETURNS integer
         SECURITY DEFINER behind _fb_gate(['integration','admin']) like every fb_upsert_*;
         upserts public.fb_shipment_lots on (fb_shipitem_id, lot_number) with source
         'bridge'; de-duplicates within a batch (DISTINCT ON) so one ON CONFLICT statement
         can never touch a row twice; drops rows missing a ship item, lot, SO or part.
   fb_shipment_lots and kit_attach_fb_shipment_lots already exist (D-KSTC-37,
   2026-10-09_kit_fb_shipment_lots_step1_schema.sql) and are unchanged.

   RUN ORDER (SQL Editor -- ONE BLOCK PER RUN)
     BLOCK 1  apply                      expect: success, no rows
     BLOCK 2  verify (read-only)         expect: every *_ok true
     BLOCK 3  smoke (writes, then RAISES to roll back)
                                         expect: an ERROR whose text starts SMOKE_OK
     BLOCK 4  after smoke (read-only)    expect: smoke_rows_left 0
   PROD: run BEFORE the bridge 1.9.0 deploy to skyserver (migration before code).

   TEST (ylzmyjjqibpbqbwjsnqj): applied by Claude 2026-10-09; BLOCKS 2-4 run, results in
   the conversation.
   ===================================================================================== */


/* ------------------------------- BLOCK 1 : apply ----------------------------------- */

ALTER TABLE public.fb_sync_state ADD COLUMN IF NOT EXISTS last_shipments_at timestamptz;

CREATE OR REPLACE FUNCTION public.fb_upsert_shipment_lots(p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration', 'admin']);
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSON array';
  END IF;

  INSERT INTO public.fb_shipment_lots
    (fb_shipitem_id, lot_number, so_number, fb_soitem_id, so_line, product_num, kit_line,
     kit_product_num, kit_member, kit_qty_fulfilled, ship_number, ship_status, date_shipped,
     qty_shipped, lot_qty, source)
  SELECT DISTINCT ON ((r->>'shipItemId')::integer, btrim(r->>'lotNumber'))
         (r->>'shipItemId')::integer,
         btrim(r->>'lotNumber'),
         btrim(r->>'soNum'),
         NULLIF(r->>'soItemId', '')::integer,
         NULLIF(r->>'soLine', '')::integer,
         btrim(r->>'productNum'),
         NULLIF(r->>'kitLine', '')::integer,
         NULLIF(btrim(r->>'kitProductNum'), ''),
         (r->>'kitMember')::boolean,
         NULLIF(r->>'kitQtyFulfilled', '')::numeric,
         NULLIF(btrim(r->>'shipNum'), ''),
         NULLIF(btrim(r->>'shipStatus'), ''),
         NULLIF(r->>'dateShipped', '')::date,
         NULLIF(r->>'qtyShipped', '')::numeric,
         NULLIF(r->>'lotQty', '')::numeric,
         'bridge'
  FROM jsonb_array_elements(p_rows) AS r
  WHERE NULLIF(r->>'shipItemId', '') IS NOT NULL
    AND NULLIF(btrim(r->>'lotNumber'), '') IS NOT NULL
    AND NULLIF(btrim(r->>'soNum'), '') IS NOT NULL
    AND NULLIF(btrim(r->>'productNum'), '') IS NOT NULL
  ORDER BY (r->>'shipItemId')::integer, btrim(r->>'lotNumber')
  ON CONFLICT (fb_shipitem_id, lot_number) DO UPDATE SET
    so_number         = EXCLUDED.so_number,
    fb_soitem_id      = EXCLUDED.fb_soitem_id,
    so_line           = EXCLUDED.so_line,
    product_num       = EXCLUDED.product_num,
    kit_line          = EXCLUDED.kit_line,
    kit_product_num   = EXCLUDED.kit_product_num,
    kit_member        = EXCLUDED.kit_member,
    kit_qty_fulfilled = EXCLUDED.kit_qty_fulfilled,
    ship_number       = EXCLUDED.ship_number,
    ship_status       = EXCLUDED.ship_status,
    date_shipped      = EXCLUDED.date_shipped,
    qty_shipped       = EXCLUDED.qty_shipped,
    lot_qty           = EXCLUDED.lot_qty,
    source            = EXCLUDED.source,
    last_loaded_at    = now();
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE public.fb_sync_state SET last_shipments_at = now() WHERE id = 1;
  RETURN v_n;
END
$function$;

REVOKE ALL ON FUNCTION public.fb_upsert_shipment_lots(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fb_upsert_shipment_lots(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.fb_upsert_shipment_lots(jsonb) TO authenticated, service_role;


/* ------------------------------- BLOCK 2 : verify (read-only) ---------------------- */

SELECT jsonb_build_object(
  'fn_ok', EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                   AND proname = 'fb_upsert_shipment_lots'),
  'anon_blocked_ok', NOT has_function_privilege('anon', 'public.fb_upsert_shipment_lots(jsonb)', 'EXECUTE'),
  'authenticated_ok', has_function_privilege('authenticated', 'public.fb_upsert_shipment_lots(jsonb)', 'EXECUTE'),
  'clock_ok', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                      AND table_name = 'fb_sync_state' AND column_name = 'last_shipments_at'),
  'attach_fn_ok', EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                          AND proname = 'kit_attach_fb_shipment_lots'),
  'bridge_profile_ok', EXISTS (SELECT 1 FROM public.profiles WHERE username = 'fishbowl-bridge'
                               AND is_active AND (role = 'integration' OR 'integration' = ANY(roles)))
) AS verify;


/* ------------------------------- BLOCK 3 : smoke ----------------------------------- */
/* As the bridge's own profile: a machinist is refused; the bridge upserts 3 rows (one a
   duplicate within the batch, one missing its lot -- so 1 stored), re-sends the row as
   Shipped (update, not insert), and stamps the clock. Then RAISES so all of it rolls back. */

DO $smoke$
DECLARE
  v_bridge uuid := (SELECT id FROM public.profiles WHERE username = 'fishbowl-bridge' AND is_active LIMIT 1);
  v_machinist uuid := (SELECT id FROM public.profiles WHERE role = 'machinist' AND is_active
                         AND NOT ('admin' = ANY(roles)) AND NOT ('integration' = ANY(roles))
                       ORDER BY username LIMIT 1);
  v_refused text := 'NOT REFUSED';
  v_first integer;
  v_second integer;
  v_status text;
  v_clock timestamptz;
  v_before timestamptz := (SELECT last_shipments_at FROM public.fb_sync_state WHERE id = 1);
  v_row jsonb := '{"shipItemId": 990000001, "lotNumber": "SMOKE-LOT", "soNum": "SMOKE-SO", "soItemId": 1,
                   "soLine": 2, "productNum": "SMOKE-PART", "kitLine": 1, "kitProductNum": "SMOKE-KIT",
                   "kitMember": true, "kitQtyFulfilled": 1, "shipNum": "SSMOKE", "shipStatus": "Entered",
                   "dateShipped": null, "qtyShipped": 5, "lotQty": 5}';
BEGIN
  IF v_bridge IS NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: no fishbowl-bridge profile'; END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_machinist, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.fb_upsert_shipment_lots(jsonb_build_array(v_row));
  EXCEPTION WHEN insufficient_privilege THEN v_refused := 'refused';
  END;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_bridge, 'role', 'authenticated')::text, true);
  v_first := public.fb_upsert_shipment_lots(jsonb_build_array(v_row, v_row, v_row - 'lotNumber'));
  v_second := public.fb_upsert_shipment_lots(jsonb_build_array(
                v_row || '{"shipStatus": "Shipped", "dateShipped": "2026-10-09"}'::jsonb));
  v_status := (SELECT ship_status || ' ' || COALESCE(date_shipped::text, '-') || ' ' || source
               FROM public.fb_shipment_lots WHERE fb_shipitem_id = 990000001);
  v_clock := (SELECT last_shipments_at FROM public.fb_sync_state WHERE id = 1);

  RAISE EXCEPTION '%: machinist=[%] first=% second=% row=[%] clock_moved=%  (all rolled back)',
    CASE WHEN v_refused = 'refused' AND v_first = 1 AND v_second = 1
              AND v_status = 'Shipped 2026-10-09 bridge'
              AND v_clock IS NOT NULL AND v_clock IS DISTINCT FROM v_before
         THEN 'SMOKE_OK' ELSE 'SMOKE_FAIL' END,
    v_refused, v_first, v_second, v_status, (v_clock IS DISTINCT FROM v_before);
END
$smoke$;


/* ------------------------------- BLOCK 4 : after smoke (read-only) ----------------- */

SELECT (SELECT count(*) FROM public.fb_shipment_lots WHERE fb_shipitem_id = 990000001) AS smoke_rows_left;
