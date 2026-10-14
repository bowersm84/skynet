/* =====================================================================================
   2026-10-15_giza_part_aliases.sql  --  D-GIZA-31. TEST applied by Claude; PROD by Matt.

   Electrolab PO 4316 (11,126 for lot 3007, issued 10/13) is mirrored but missing from the Giza
   purchasing panel: its line is SK21077-5, Skybolt's own number for the steel nutplate, and the
   panel only knew MS21077-5 and the four component numbers. Shipping also writes MS21077.

     BLOCK 1  preview (read-only)
     BLOCK 2  programs.match_part_numbers: the other numbers a program's product goes by.
              Giza: MS21077-5, SK21077-5, MS21077 (never SK21077C-5, the stainless nutplate).
     BLOCK 3  v_program_purchasing and v_program_demand match those numbers too (same columns)
     BLOCK 4  PO numbers on the two sends to Electrolab, logged without one (the form had no PO
              field): lot 3006 9,829 -> PO 4248, lot 3007 11,126 -> PO 4316. Guarded, audited.
     BLOCK 5  verify (read-only)
   ===================================================================================== */


/* ===================================== BLOCK 1 =====================================
   PREVIEW. PROD expect: column false; po_4316_in_view 0; sends_without_po 2.
   ================================================================================== */
SELECT jsonb_build_object(
  'column', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'programs' AND column_name = 'match_part_numbers'),
  'po_4316_in_view', (SELECT count(*) FROM public.v_program_purchasing WHERE po_number = '4316'),
  'sends_without_po', (SELECT count(*) FROM public.program_ledger WHERE stage = 'sent_plating' AND voided_at IS NULL AND coalesce(btrim(po_number), '') = '')
) AS preview;


/* ===================================== BLOCK 2 =====================================
   ALIASES.
   ================================================================================== */
ALTER TABLE public.programs ADD COLUMN IF NOT EXISTS match_part_numbers text[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN public.programs.match_part_numbers IS
  'D-GIZA-31: other part numbers the program product goes by in Fishbowl and on paperwork (matched case-insensitively, exactly). fb_product_num always counts.';
UPDATE public.programs SET match_part_numbers = ARRAY['MS21077-5', 'SK21077-5', 'MS21077'] WHERE code = 'GIZA-21077';


/* ===================================== BLOCK 3 =====================================
   VIEWS. Same columns as before, so CREATE OR REPLACE keeps grants and dependants.
   ================================================================================== */
CREATE OR REPLACE VIEW public.v_program_purchasing WITH (security_invoker = true) AS
WITH program_part_nums AS (
  SELECT pg.id AS program_id, upper(pr.part_number) AS part_key, pp.role
    FROM public.programs pg
    JOIN public.program_parts pp ON pp.program_id = pg.id
    JOIN public.parts pr ON pr.id = pp.part_id
  UNION
  SELECT pg.id, upper(btrim(x)), 'assembly'
    FROM public.programs pg, unnest(pg.match_part_numbers || ARRAY[pg.fb_product_num]) x
   WHERE coalesce(btrim(x), '') <> ''
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

CREATE OR REPLACE VIEW public.v_program_demand WITH (security_invoker = true) AS
SELECT p.id AS program_id,
       p.code AS program_code,
       s.so_number,
       l.line_number,
       l.product_num,
       LEAST(l.qty_ordered, l.qty_to_fulfill) AS qty_ordered,
       l.qty_fulfilled,
       GREATEST(LEAST(l.qty_ordered, l.qty_to_fulfill) - l.qty_fulfilled, 0::numeric) AS open_qty,
       l.effective_due_date,
       CURRENT_DATE - l.effective_due_date AS days_late
  FROM public.programs p
  JOIN public.fb_sales_orders s
    ON s.customer_name ILIKE '%' || p.customer_match || '%'
   AND s.removed_at IS NULL
   AND s.status_id = ANY (ARRAY[10, 20, 25])
  JOIN public.fb_sales_order_lines l
    ON l.fb_so_id = s.fb_so_id
   AND upper(btrim(l.product_num)) IN (SELECT upper(btrim(x)) FROM unnest(p.match_part_numbers || ARRAY[p.fb_product_num]) x WHERE x IS NOT NULL)
   AND l.type_id = 10
   AND l.removed_at IS NULL
 WHERE p.is_active
   AND NOT (coalesce(LEAST(l.qty_ordered, l.qty_to_fulfill), 0) = 0 AND coalesce(l.qty_fulfilled, 0) = 0);

GRANT SELECT ON public.v_program_demand TO authenticated, service_role;


/* ===================================== BLOCK 4 =====================================
   PO NUMBERS ON THE TWO SENDS. Each update only touches the matching entry while it still has no PO.
   ================================================================================== */
DO $$
DECLARE c record; v_id uuid;
BEGIN
  FOR c IN SELECT * FROM (VALUES ('3006', 9829::numeric, '4248'), ('3007', 11126::numeric, '4316')) AS t(lot, qty, po) LOOP
    SELECT g.id INTO v_id FROM public.program_ledger g JOIN public.program_final_lots fl ON fl.id = coalesce(g.from_lot_id, g.final_lot_id)
     WHERE g.stage = 'sent_plating' AND g.voided_at IS NULL AND fl.lot_number = c.lot AND g.qty = c.qty AND coalesce(btrim(g.po_number), '') = '';
    IF v_id IS NULL THEN
      RAISE NOTICE 'lot %: no send of % without a PO; nothing to do', c.lot, c.qty;
      CONTINUE;
    END IF;
    UPDATE public.program_ledger SET po_number = c.po WHERE id = v_id;
    INSERT INTO public.audit_logs (event_type, operator_id, details)
    VALUES ('program_ledger_corrected', auth.uid(), jsonb_build_object('entry_id', v_id, 'lot', c.lot, 'field', 'po_number', 'from', NULL, 'to', c.po,
            'reason', 'Electrolab PO for this send (Fishbowl); the Sent to Electrolab form had no PO field until D-GIZA-31'));
    RAISE NOTICE 'lot % send of %: PO %', c.lot, c.qty, c.po;
  END LOOP;
END $$;


/* ===================================== BLOCK 5 =====================================
   VERIFY. PROD expect: aliases {MS21077-5,SK21077-5,MS21077}; PO 4316 line 1 SK21077-5, assembly,
   11,126 remaining, sent [3007 11,126]; PO 4248 sent [3006 9,829]; demand still 75,000 / 60,266.
   ================================================================================== */
SELECT jsonb_build_object(
  'aliases', (SELECT match_part_numbers FROM public.programs WHERE code = 'GIZA-21077'),
  'po_4316', (SELECT jsonb_agg(jsonb_build_object('line', line_number, 'part', part_num, 'role', role, 'remaining', qty_remaining, 'open', is_open, 'late', is_late, 'sent', tracker_sent))
                FROM public.v_program_purchasing WHERE po_number = '4316'),
  'po_4248_sent', (SELECT tracker_sent FROM public.v_program_purchasing WHERE po_number = '4248' AND part_num = 'MS21077-5' LIMIT 1),
  'demand', (SELECT jsonb_build_object('ordered', ordered, 'open', open_qty) FROM public.v_program_pipeline)
) AS verify;
