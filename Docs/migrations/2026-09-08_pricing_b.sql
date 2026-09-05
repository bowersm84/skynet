/* ============================================================================
   S11 Batch B — v_customer_purchases: last_paid = the most recent NON-ZERO unit
   price (a $0 backorder / no-charge line was masking the real last price —
   found on Airparts' SK2003-42A during the Batch A verify).
   Supabase SQL Editor, TEST then PROD. Idempotent (CREATE OR REPLACE).
   ============================================================================ */
CREATE OR REPLACE VIEW public.v_customer_purchases WITH (security_invoker = on) AS
WITH lines AS (
  SELECT fb_customer_id, product_key, product_num, description, qty_fulfilled AS qty, unit_price, fb_date_created AS dt, 'history' AS src
  FROM public.fb_so_history_lines WHERE COALESCE(qty_fulfilled,0) > 0
  UNION ALL
  SELECT so.fb_customer_id, upper(regexp_replace(l.product_num, '\s', '', 'g')), l.product_num, l.description, l.qty_ordered, l.unit_price, so.fb_date_created, 'open'
  FROM public.fb_sales_order_lines l JOIN public.fb_sales_orders so ON so.fb_so_id = l.fb_so_id
  WHERE l.removed_at IS NULL AND so.removed_at IS NULL AND l.type_id IN (10, 30)
    AND NOT EXISTS (SELECT 1 FROM public.fb_so_history_lines h WHERE h.fb_soitem_id = l.fb_soitem_id)
)
SELECT fb_customer_id, product_key, MAX(product_num) AS product_num, MAX(description) AS description,
       MIN(dt)::date AS first_bought, MAX(dt)::date AS last_bought, COUNT(*) AS lines,
       SUM(qty) AS qty, SUM(qty * COALESCE(unit_price,0)) AS revenue,
       (array_agg(unit_price ORDER BY dt DESC) FILTER (WHERE unit_price > 0))[1] AS last_paid,
       MIN(unit_price) FILTER (WHERE unit_price > 0) AS min_paid, MAX(unit_price) AS max_paid
FROM lines GROUP BY fb_customer_id, product_key;

GRANT SELECT ON public.v_customer_purchases TO authenticated;

/* verify — Airparts: SK2003-42A last_paid should now be > 0 */
SELECT product_num, qty, revenue, last_paid, last_bought FROM public.v_customer_purchases WHERE fb_customer_id = 671 ORDER BY revenue DESC LIMIT 5;
