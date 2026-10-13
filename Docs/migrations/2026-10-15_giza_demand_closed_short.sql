/* =====================================================================================
   2026-10-15_giza_demand_closed_short.sql  --  TEST applied by Claude; PROD by Matt.

   The Giza Dashboard shows 145,020 ordered on SO 15548; Giza ordered 75,000 (acknowledgement
   printed 10/13: lines 4,980 + 0 + 70,020). Lines 1 and 2 are closed short in Fishbowl (status
   60): Fishbowl keeps their original quantity (50,000 / 25,000) in qtyOrdered and puts what is
   still owed in qtyToFulfill (4,980 / 0). v_program_demand read qtyOrdered.

   Fix: a line's ordered quantity is the smaller of qtyOrdered and qtyToFulfill (the same for an
   open line; the short-closed figure for a closed-short one), and lines with nothing ordered and
   nothing shipped are left out. Same columns, same types, so v_program_pipeline (which reads this
   view) is unchanged.

   PROD expect after: ordered 75,000, fulfilled 14,734, open 60,266, one past-due line (line 3).
   ===================================================================================== */


/* ===================================== BLOCK 1 =====================================
   PREVIEW. PROD expect: ordered 145020, open 130286, 3 demand rows.
   ================================================================================== */
SELECT jsonb_build_object(
  'ordered', (SELECT ordered FROM public.v_program_pipeline),
  'open', (SELECT open_qty FROM public.v_program_pipeline),
  'rows', (SELECT count(*) FROM public.v_program_demand)
) AS preview;


/* ===================================== BLOCK 2 =====================================
   VIEW.
   ================================================================================== */
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
   AND l.product_num = p.fb_product_num
   AND l.type_id = 10
   AND l.removed_at IS NULL
 WHERE p.is_active
   AND NOT (coalesce(LEAST(l.qty_ordered, l.qty_to_fulfill), 0) = 0 AND coalesce(l.qty_fulfilled, 0) = 0);

GRANT SELECT ON public.v_program_demand TO authenticated, service_role;


/* ===================================== BLOCK 3 =====================================
   VERIFY. PROD expect: ordered 75000, fulfilled 14734, open 60266; rows line 1 (4980 / 4980 / 0)
   and line 3 (70020 / 9754 / 60266).
   ================================================================================== */
SELECT jsonb_build_object(
  'ordered', (SELECT ordered FROM public.v_program_pipeline),
  'fulfilled', (SELECT fulfilled FROM public.v_program_pipeline),
  'open', (SELECT open_qty FROM public.v_program_pipeline),
  'rows', (SELECT jsonb_agg(jsonb_build_object('line', line_number, 'ordered', qty_ordered, 'shipped', qty_fulfilled, 'open', open_qty, 'days_late', days_late) ORDER BY line_number)
             FROM public.v_program_demand)
) AS verify;
