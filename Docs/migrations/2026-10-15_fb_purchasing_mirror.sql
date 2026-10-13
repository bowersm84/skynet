/* =====================================================================================
   2026-10-15_fb_purchasing_mirror.sql  --  D-FB-55 / D-GIZA-29 / D-GIZA-30.
   TEST applied by Claude; PROD by Matt, BEFORE bridge 1.10 runs against PROD and before the app push.

   Bridge 1.10 mirrors Fishbowl purchase orders: headers (po + vendor), lines (poitem + poitemtype) and
   receipts with their lot numbers (receiptitem + trackinginfo tableId 1259138490 'ReceiptItem', the
   join proven by the 10/14 Giza receipts pull). Read-only from Fishbowl; written only through
   fb_upsert_purchasing, gated like every fb_upsert_* (integration or admin).

     BLOCK 1  preview (read-only)
     BLOCK 2  tables fb_purchase_orders / fb_purchase_order_lines / fb_po_receipts, RLS (authenticated
              read), fb_sync_state.last_purchasing_at; authenticated read on fb_shipment_lots (the
              Movements report lists Giza shipments; the table had RLS on and no policy)
     BLOCK 3  fb_upsert_purchasing(p_orders, p_lines, p_receipts)
     BLOCK 4  v_program_purchasing: every PO line for a program's parts (cage, retainer, nylon, nut) and
              its product (the Electrolab MS21077-5 plating lines), with remaining, due, receipts with
              lots, and the tracker lots sent on an Electrolab PO
     BLOCK 5  verify (read-only)

   Status note: Fishbowl status names come from postatus / poitemstatus when the bridge can read them.
   Where a name is missing the view treats PO status ids 60 Fulfilled, 70 Closed Short (both seen in
   the 10/14 pull), 80 Void and 95 Historical (Fishbowl's standard ids, not yet seen here) as closed.
   Fishbowl times are Eastern: every date in the view is taken in America/New_York.
   ===================================================================================== */


/* ===================================== BLOCK 1 =====================================
   PREVIEW. Expect: all false / 0 on a first run.
   ================================================================================== */
SELECT jsonb_build_object(
  'tables_exist', (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
                     AND table_name IN ('fb_purchase_orders', 'fb_purchase_order_lines', 'fb_po_receipts')),
  'clock_column', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fb_sync_state' AND column_name = 'last_purchasing_at'),
  'shipment_lots_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'fb_shipment_lots'),
  'fn_exists', EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fb_upsert_purchasing')
) AS preview;


/* ===================================== BLOCK 2 =====================================
   TABLES, RLS, CLOCK.
   ================================================================================== */
CREATE TABLE IF NOT EXISTS public.fb_purchase_orders (
  fb_po_id            integer PRIMARY KEY,
  po_number           text NOT NULL,
  status_id           integer,
  status_name         text,
  type_id             integer,
  vendor_id           integer,
  vendor_name         text,
  vendor_so           text,
  buyer               text,
  location_group_id   integer,
  date_created        timestamptz,
  date_issued         timestamptz,
  date_confirmed      timestamptz,
  date_completed      timestamptz,
  date_last_modified  timestamptz,
  first_synced_at     timestamptz NOT NULL DEFAULT now(),
  last_synced_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_purchase_orders_po_number_idx ON public.fb_purchase_orders (po_number);

CREATE TABLE IF NOT EXISTS public.fb_purchase_order_lines (
  fb_poitem_id           integer PRIMARY KEY,
  fb_po_id               integer NOT NULL REFERENCES public.fb_purchase_orders (fb_po_id),
  po_number              text,
  line_number            integer,
  type_id                integer,
  type_name              text,
  status_id              integer,
  status_name            text,
  fb_part_id             integer,
  part_num               text,
  description            text,
  outsourced_part_num    text,
  outsourced_description text,
  vendor_part_num        text,
  rev_level              text,
  qty_to_fulfill         numeric,
  qty_fulfilled          numeric,
  qty_picked             numeric,
  unit_cost              numeric,
  total_cost             numeric,
  uom_id                 integer,
  date_scheduled         timestamptz,
  date_last_fulfillment  timestamptz,
  removed_at             timestamptz,
  first_synced_at        timestamptz NOT NULL DEFAULT now(),
  last_synced_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_purchase_order_lines_po_idx ON public.fb_purchase_order_lines (fb_po_id);
CREATE INDEX IF NOT EXISTS fb_purchase_order_lines_part_idx ON public.fb_purchase_order_lines (upper(part_num));
CREATE INDEX IF NOT EXISTS fb_purchase_order_lines_outsourced_idx ON public.fb_purchase_order_lines (upper(outsourced_part_num));

CREATE TABLE IF NOT EXISTS public.fb_po_receipts (
  fb_receiptitem_id   integer NOT NULL,
  lot_number          text NOT NULL DEFAULT '',
  fb_poitem_id        integer,
  fb_po_id            integer,
  po_number           text,
  fb_part_id          integer,
  part_num            text,
  qty                 numeric,
  lot_qty             numeric,
  status_id           integer,
  date_received       timestamptz,
  date_last_modified  timestamptz,
  removed_at          timestamptz,
  first_synced_at     timestamptz NOT NULL DEFAULT now(),
  last_synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fb_receiptitem_id, lot_number)
);
CREATE INDEX IF NOT EXISTS fb_po_receipts_poitem_idx ON public.fb_po_receipts (fb_poitem_id);
CREATE INDEX IF NOT EXISTS fb_po_receipts_received_idx ON public.fb_po_receipts (date_received);

ALTER TABLE public.fb_purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fb_purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fb_po_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fb_purchase_orders_read ON public.fb_purchase_orders;
CREATE POLICY fb_purchase_orders_read ON public.fb_purchase_orders FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS fb_purchase_order_lines_read ON public.fb_purchase_order_lines;
CREATE POLICY fb_purchase_order_lines_read ON public.fb_purchase_order_lines FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS fb_po_receipts_read ON public.fb_po_receipts;
CREATE POLICY fb_po_receipts_read ON public.fb_po_receipts FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.fb_purchase_orders, public.fb_purchase_order_lines, public.fb_po_receipts TO authenticated;
REVOKE ALL ON public.fb_purchase_orders, public.fb_purchase_order_lines, public.fb_po_receipts FROM anon;

/* The Movements report lists Giza shipments: authenticated may read the shipment-lot mirror. */
DROP POLICY IF EXISTS fb_shipment_lots_read ON public.fb_shipment_lots;
CREATE POLICY fb_shipment_lots_read ON public.fb_shipment_lots FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.fb_shipment_lots TO authenticated;

ALTER TABLE public.fb_sync_state ADD COLUMN IF NOT EXISTS last_purchasing_at timestamptz;


/* ===================================== BLOCK 3 =====================================
   fb_upsert_purchasing. One call carries a set of POs in full: their header, every line and every
   receipt. Lines / receipts of those POs that are not in the payload are marked removed (and come
   back if they reappear). Returns counts. Gated like fb_upsert_shipment_lots.
   ================================================================================== */
CREATE OR REPLACE FUNCTION public.fb_upsert_purchasing(p_orders jsonb, p_lines jsonb, p_receipts jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids integer[];
  v_orders integer; v_lines integer; v_receipts integer; v_rm_lines integer; v_rm_receipts integer;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration', 'admin']);
  IF jsonb_typeof(coalesce(p_orders, 'null'::jsonb)) <> 'array' OR jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_receipts, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'p_orders, p_lines and p_receipts must be JSON arrays';
  END IF;

  INSERT INTO public.fb_purchase_orders AS t
    (fb_po_id, po_number, status_id, status_name, type_id, vendor_id, vendor_name, vendor_so, buyer, location_group_id,
     date_created, date_issued, date_confirmed, date_completed, date_last_modified)
  SELECT DISTINCT ON ((r->>'poId')::integer)
         (r->>'poId')::integer, btrim(r->>'poNum'), NULLIF(r->>'statusId', '')::integer, NULLIF(btrim(r->>'statusName'), ''),
         NULLIF(r->>'typeId', '')::integer, NULLIF(r->>'vendorId', '')::integer, NULLIF(btrim(r->>'vendorName'), ''),
         NULLIF(btrim(r->>'vendorSo'), ''), NULLIF(btrim(r->>'buyer'), ''), NULLIF(r->>'locationGroupId', '')::integer,
         NULLIF(r->>'dateCreated', '')::timestamptz, NULLIF(r->>'dateIssued', '')::timestamptz, NULLIF(r->>'dateConfirmed', '')::timestamptz,
         NULLIF(r->>'dateCompleted', '')::timestamptz, NULLIF(r->>'dateLastModified', '')::timestamptz
    FROM jsonb_array_elements(p_orders) r
   WHERE NULLIF(r->>'poId', '') IS NOT NULL AND NULLIF(btrim(r->>'poNum'), '') IS NOT NULL
   ORDER BY (r->>'poId')::integer
  ON CONFLICT (fb_po_id) DO UPDATE SET
    po_number = EXCLUDED.po_number, status_id = EXCLUDED.status_id, status_name = EXCLUDED.status_name, type_id = EXCLUDED.type_id,
    vendor_id = EXCLUDED.vendor_id, vendor_name = EXCLUDED.vendor_name, vendor_so = EXCLUDED.vendor_so, buyer = EXCLUDED.buyer,
    location_group_id = EXCLUDED.location_group_id, date_created = EXCLUDED.date_created, date_issued = EXCLUDED.date_issued,
    date_confirmed = EXCLUDED.date_confirmed, date_completed = EXCLUDED.date_completed, date_last_modified = EXCLUDED.date_last_modified,
    last_synced_at = now();
  GET DIAGNOSTICS v_orders = ROW_COUNT;

  SELECT array_agg(DISTINCT (r->>'poId')::integer) INTO v_ids
    FROM jsonb_array_elements(p_orders) r WHERE NULLIF(r->>'poId', '') IS NOT NULL;

  INSERT INTO public.fb_purchase_order_lines AS t
    (fb_poitem_id, fb_po_id, po_number, line_number, type_id, type_name, status_id, status_name, fb_part_id, part_num, description,
     outsourced_part_num, outsourced_description, vendor_part_num, rev_level, qty_to_fulfill, qty_fulfilled, qty_picked,
     unit_cost, total_cost, uom_id, date_scheduled, date_last_fulfillment, removed_at)
  SELECT DISTINCT ON ((r->>'poItemId')::integer)
         (r->>'poItemId')::integer, (r->>'poId')::integer, NULLIF(btrim(r->>'poNum'), ''), NULLIF(r->>'lineNumber', '')::integer,
         NULLIF(r->>'typeId', '')::integer, NULLIF(btrim(r->>'typeName'), ''), NULLIF(r->>'statusId', '')::integer, NULLIF(btrim(r->>'statusName'), ''),
         NULLIF(r->>'partId', '')::integer, NULLIF(btrim(r->>'partNum'), ''), NULLIF(btrim(r->>'description'), ''),
         NULLIF(btrim(r->>'outsourcedPartNum'), ''), NULLIF(btrim(r->>'outsourcedDescription'), ''), NULLIF(btrim(r->>'vendorPartNum'), ''),
         NULLIF(btrim(r->>'revLevel'), ''), NULLIF(r->>'qtyToFulfill', '')::numeric, NULLIF(r->>'qtyFulfilled', '')::numeric,
         NULLIF(r->>'qtyPicked', '')::numeric, NULLIF(r->>'unitCost', '')::numeric, NULLIF(r->>'totalCost', '')::numeric,
         NULLIF(r->>'uomId', '')::integer, NULLIF(r->>'dateScheduled', '')::timestamptz, NULLIF(r->>'dateLastFulfillment', '')::timestamptz, NULL
    FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) r
   WHERE NULLIF(r->>'poItemId', '') IS NOT NULL AND (r->>'poId')::integer = ANY (v_ids)
   ORDER BY (r->>'poItemId')::integer
  ON CONFLICT (fb_poitem_id) DO UPDATE SET
    fb_po_id = EXCLUDED.fb_po_id, po_number = EXCLUDED.po_number, line_number = EXCLUDED.line_number, type_id = EXCLUDED.type_id,
    type_name = EXCLUDED.type_name, status_id = EXCLUDED.status_id, status_name = EXCLUDED.status_name, fb_part_id = EXCLUDED.fb_part_id,
    part_num = EXCLUDED.part_num, description = EXCLUDED.description, outsourced_part_num = EXCLUDED.outsourced_part_num,
    outsourced_description = EXCLUDED.outsourced_description, vendor_part_num = EXCLUDED.vendor_part_num, rev_level = EXCLUDED.rev_level,
    qty_to_fulfill = EXCLUDED.qty_to_fulfill, qty_fulfilled = EXCLUDED.qty_fulfilled, qty_picked = EXCLUDED.qty_picked,
    unit_cost = EXCLUDED.unit_cost, total_cost = EXCLUDED.total_cost, uom_id = EXCLUDED.uom_id, date_scheduled = EXCLUDED.date_scheduled,
    date_last_fulfillment = EXCLUDED.date_last_fulfillment, removed_at = NULL, last_synced_at = now();
  GET DIAGNOSTICS v_lines = ROW_COUNT;

  UPDATE public.fb_purchase_order_lines l SET removed_at = now()
   WHERE l.fb_po_id = ANY (v_ids) AND l.removed_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) r WHERE (r->>'poItemId')::integer = l.fb_poitem_id);
  GET DIAGNOSTICS v_rm_lines = ROW_COUNT;

  INSERT INTO public.fb_po_receipts AS t
    (fb_receiptitem_id, lot_number, fb_poitem_id, fb_po_id, po_number, fb_part_id, part_num, qty, lot_qty, status_id,
     date_received, date_last_modified, removed_at)
  SELECT DISTINCT ON ((r->>'receiptItemId')::integer, coalesce(btrim(r->>'lotNumber'), ''))
         (r->>'receiptItemId')::integer, coalesce(btrim(r->>'lotNumber'), ''), NULLIF(r->>'poItemId', '')::integer, (r->>'poId')::integer,
         NULLIF(btrim(r->>'poNum'), ''), NULLIF(r->>'partId', '')::integer, NULLIF(btrim(r->>'partNum'), ''),
         NULLIF(r->>'qty', '')::numeric, NULLIF(r->>'lotQty', '')::numeric, NULLIF(r->>'statusId', '')::integer,
         NULLIF(r->>'dateReceived', '')::timestamptz, NULLIF(r->>'dateLastModified', '')::timestamptz, NULL
    FROM jsonb_array_elements(coalesce(p_receipts, '[]'::jsonb)) r
   WHERE NULLIF(r->>'receiptItemId', '') IS NOT NULL AND (r->>'poId')::integer = ANY (v_ids)
   ORDER BY (r->>'receiptItemId')::integer, coalesce(btrim(r->>'lotNumber'), '')
  ON CONFLICT (fb_receiptitem_id, lot_number) DO UPDATE SET
    fb_poitem_id = EXCLUDED.fb_poitem_id, fb_po_id = EXCLUDED.fb_po_id, po_number = EXCLUDED.po_number, fb_part_id = EXCLUDED.fb_part_id,
    part_num = EXCLUDED.part_num, qty = EXCLUDED.qty, lot_qty = EXCLUDED.lot_qty, status_id = EXCLUDED.status_id,
    date_received = EXCLUDED.date_received, date_last_modified = EXCLUDED.date_last_modified, removed_at = NULL, last_synced_at = now();
  GET DIAGNOSTICS v_receipts = ROW_COUNT;

  UPDATE public.fb_po_receipts x SET removed_at = now()
   WHERE x.fb_po_id = ANY (v_ids) AND x.removed_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_receipts, '[]'::jsonb)) r
                      WHERE (r->>'receiptItemId')::integer = x.fb_receiptitem_id AND coalesce(btrim(r->>'lotNumber'), '') = x.lot_number);
  GET DIAGNOSTICS v_rm_receipts = ROW_COUNT;

  UPDATE public.fb_sync_state SET last_purchasing_at = now() WHERE id = 1;
  RETURN jsonb_build_object('orders', v_orders, 'lines', v_lines, 'receipts', v_receipts,
                            'removed_lines', v_rm_lines, 'removed_receipts', v_rm_receipts);
END $$;

REVOKE EXECUTE ON FUNCTION public.fb_upsert_purchasing(jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fb_upsert_purchasing(jsonb, jsonb, jsonb) TO authenticated, service_role;


/* ===================================== BLOCK 4 =====================================
   v_program_purchasing. One row per PO line for a program part or the program's product.
   ================================================================================== */
CREATE OR REPLACE VIEW public.v_program_purchasing WITH (security_invoker = true) AS
WITH program_part_nums AS (
  SELECT pg.id AS program_id, upper(pr.part_number) AS part_key, pp.role
    FROM public.programs pg
    JOIN public.program_parts pp ON pp.program_id = pg.id
    JOIN public.parts pr ON pr.id = pp.part_id
  UNION
  SELECT pg.id, upper(pg.fb_product_num), 'assembly'
    FROM public.programs pg WHERE pg.fb_product_num IS NOT NULL
),
lines AS (
  SELECT DISTINCT ON (k.program_id, l.fb_poitem_id) k.program_id, k.role, l.*
    FROM public.fb_purchase_order_lines l
    JOIN program_part_nums k ON k.part_key IN (upper(l.part_num), upper(coalesce(l.outsourced_part_num, '')))
   WHERE l.removed_at IS NULL
   ORDER BY k.program_id, l.fb_poitem_id, (k.part_key = upper(l.part_num)) DESC
)
SELECT l.program_id,
       l.role,
       l.fb_poitem_id,
       l.fb_po_id,
       o.po_number,
       o.vendor_name,
       (o.vendor_name ILIKE '%electrolab%') AS is_plating,
       o.status_id   AS po_status_id,
       o.status_name AS po_status,
       (o.date_issued AT TIME ZONE 'America/New_York')::date AS issued_date,
       l.line_number,
       l.type_name,
       l.status_id   AS line_status_id,
       l.status_name AS line_status,
       l.part_num,
       l.outsourced_part_num,
       l.description,
       coalesce(l.qty_to_fulfill, 0) AS qty_ordered,
       coalesce(l.qty_fulfilled, 0)  AS qty_received,
       CASE WHEN c.po_closed THEN 0 ELSE GREATEST(coalesce(l.qty_to_fulfill, 0) - coalesce(l.qty_fulfilled, 0), 0) END AS qty_remaining,
       NOT c.po_closed AND GREATEST(coalesce(l.qty_to_fulfill, 0) - coalesce(l.qty_fulfilled, 0), 0) > 0 AS is_open,
       (l.date_scheduled AT TIME ZONE 'America/New_York')::date        AS due_date,
       (l.date_last_fulfillment AT TIME ZONE 'America/New_York')::date AS last_received_date,
       (NOT c.po_closed AND GREATEST(coalesce(l.qty_to_fulfill, 0) - coalesce(l.qty_fulfilled, 0), 0) > 0
         AND (l.date_scheduled AT TIME ZONE 'America/New_York')::date < (now() AT TIME ZONE 'America/New_York')::date) AS is_late,
       l.unit_cost,
       coalesce((SELECT jsonb_agg(jsonb_build_object('date', (r.date_received AT TIME ZONE 'America/New_York')::date, 'qty', coalesce(r.lot_qty, r.qty), 'lot', NULLIF(r.lot_number, ''))
                                  ORDER BY r.date_received, r.fb_receiptitem_id)
                   FROM public.fb_po_receipts r WHERE r.fb_poitem_id = l.fb_poitem_id AND r.removed_at IS NULL), '[]'::jsonb) AS receipts,
       CASE WHEN o.vendor_name ILIKE '%electrolab%' THEN
         coalesce((SELECT jsonb_agg(jsonb_build_object('lot', fl.lot_number, 'qty', g.qty, 'date', g.entry_date) ORDER BY g.entry_date, fl.lot_number)
                     FROM public.program_ledger g
                     JOIN public.program_final_lots fl ON fl.id = coalesce(g.from_lot_id, g.final_lot_id)
                    WHERE g.program_id = l.program_id AND g.stage = 'sent_plating' AND g.voided_at IS NULL
                      AND regexp_replace(upper(btrim(g.po_number)), '^P', '') = regexp_replace(upper(btrim(o.po_number)), '^P', '')), '[]'::jsonb)
       ELSE '[]'::jsonb END AS tracker_sent
  FROM lines l
  JOIN public.fb_purchase_orders o ON o.fb_po_id = l.fb_po_id
  CROSS JOIN LATERAL (SELECT CASE WHEN o.status_name IS NOT NULL
                                  THEN o.status_name IN ('Fulfilled', 'Closed Short', 'Void', 'Historical')
                                  ELSE coalesce(o.status_id, 0) IN (60, 70, 80, 95) END AS po_closed) c
 WHERE coalesce(o.status_name, '') <> 'Void' AND coalesce(o.status_id, 0) <> 80;

GRANT SELECT ON public.v_program_purchasing TO authenticated, service_role;


/* ===================================== BLOCK 5 =====================================
   VERIFY. Expect: tables 3, rls_on 3, clock true, shipment_lots_policy 1, fn granted to authenticated
   only (not anon), view_rows 0 until the bridge's first purchasing pass.
   ================================================================================== */
SELECT jsonb_build_object(
  'tables', (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
               AND table_name IN ('fb_purchase_orders', 'fb_purchase_order_lines', 'fb_po_receipts')),
  'rls_on', (SELECT count(*) FROM pg_class WHERE oid IN ('public.fb_purchase_orders'::regclass, 'public.fb_purchase_order_lines'::regclass, 'public.fb_po_receipts'::regclass) AND relrowsecurity),
  'clock', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fb_sync_state' AND column_name = 'last_purchasing_at'),
  'shipment_lots_policy', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'fb_shipment_lots'),
  'fn_authenticated', has_function_privilege('authenticated', 'public.fb_upsert_purchasing(jsonb, jsonb, jsonb)', 'EXECUTE'),
  'fn_anon', has_function_privilege('anon', 'public.fb_upsert_purchasing(jsonb, jsonb, jsonb)', 'EXECUTE'),
  'view_rows', (SELECT count(*) FROM public.v_program_purchasing)
) AS verify;
