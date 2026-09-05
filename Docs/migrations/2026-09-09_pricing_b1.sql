/* ============================================================================
   S11 Batch B.1 — exclusions, drop-ship fix, customer / part statistics
   Supabase SQL Editor, TEST first, then PROD (with the schema + seed, at cutover). Idempotent.

   1. pricing_excluded_products — non-sellable Fishbowl products kept out of
      history, typeaheads and statistics (Matt's 8 resale removals + every
      non-inventory part type). Add rows any time.
   2. Line-type correction: Fishbowl line type 30 is "Discount %", NOT drop ship;
      drop ship is 12 (lib/fishbowl.js FB_LINE_TYPE, D-FB-08). The history poller
      and the open-mirror side of the view used (10,30). Fixed to (10,12) here and
      in the bridge (CC prompt). Existing type-30 rows are deleted; drop-ship lines
      arrive on the re-backfill (history_cursor reset below).
   3. v_customer_purchases rebuilt with both fixes.
   4. pricing_top_customers(limit) and pricing_part_customers(part, limit).
   ============================================================================ */

/* ---------- 1. exclusions */
CREATE TABLE IF NOT EXISTS public.pricing_excluded_products (
  product_num text PRIMARY KEY,
  product_key text GENERATED ALWAYS AS (upper(regexp_replace(product_num, '\s', '', 'g'))) STORED,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pricing_excluded_products_key ON public.pricing_excluded_products(product_key);
ALTER TABLE public.pricing_excluded_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pricing_excluded_products_select_authenticated ON public.pricing_excluded_products;
CREATE POLICY pricing_excluded_products_select_authenticated ON public.pricing_excluded_products FOR SELECT TO authenticated USING (true);

INSERT INTO public.pricing_excluded_products (product_num, reason) VALUES
  ('00000', 'Fishbowl part type: labor'),
  ('050P', 'Fishbowl part type: labor'),
  ('07763436', 'Fishbowl part type: labor'),
  ('1111', 'Fishbowl part type: labor'),
  ('203K23', 'Fishbowl part type: labor'),
  ('3/8"ROUND', 'Fishbowl part type: labor'),
  ('3126A211', 'Fishbowl part type: labor'),
  ('6001Z', 'Fishbowl part type: labor'),
  ('61440194', 'Fishbowl part type: labor'),
  ('61440541', 'Fishbowl part type: labor'),
  ('69042Z', 'Fishbowl part type: labor'),
  ('98381A548', 'Fishbowl part type: labor'),
  ('A18028760', 'Fishbowl part type: labor'),
  ('ALRO NOTES', 'Fishbowl part type: labor'),
  ('CATALOG', 'removed by Matt 2026-09-03 (resale review)'),
  ('COUNTRY OF ORIGIN USA', 'Fishbowl part type: labor'),
  ('CUSTOMER NOTES', 'removed by Matt 2026-09-03 (resale review)'),
  ('DHL', 'Fishbowl part type: labor'),
  ('DRIILS', 'Fishbowl part type: labor'),
  ('ECOCOOL 741', 'Fishbowl part type: labor'),
  ('ENVIROMENTAL CHARGE', 'Fishbowl part type: service'),
  ('ENVIROMENTAL CHARGES', 'Fishbowl part type: service'),
  ('EXPEDITE CHARGE', 'Fishbowl part type: labor'),
  ('FEDEX ACCT ON FILE', 'Fishbowl part type: internal use'),
  ('Freight', 'Fishbowl part type: internal use'),
  ('FUEL SURCHARGE', 'Fishbowl part type: internal use'),
  ('LB1 r2', 'Fishbowl part type: labor'),
  ('LTHG-01', 'Fishbowl part type: labor'),
  ('LX20-F022-1400', 'Fishbowl part type: labor'),
  ('MACHINE LUBE', 'Fishbowl part type: labor'),
  ('MACHINE TOOLS', 'Fishbowl part type: labor'),
  ('Mesh Basket', 'Fishbowl part type: labor'),
  ('MFG CERTS', 'Fishbowl part type: labor'),
  ('MINIMUM LOT CHARGE', 'Fishbowl part type: service'),
  ('MSC# 62667126', 'Fishbowl part type: labor'),
  ('MSC# 90010083', 'Fishbowl part type: labor'),
  ('nan', 'Fishbowl part type: labor'),
  ('NADCAP CERT', 'Fishbowl part type: service'),
  ('PART CONVEYOR UNIT', 'Fishbowl part type: labor'),
  ('RELEASE DATE', 'Fishbowl part type: service'),
  ('Restocking fee', 'removed by Matt 2026-09-03 (resale review)'),
  ('Safety Glasses', 'Fishbowl part type: labor'),
  ('SHIPPING', 'Fishbowl part type: internal use'),
  ('SK2003-AW5S', 'removed by Matt 2026-09-03 (resale review)'),
  ('SK201/203 Clip', 'removed by Matt 2026-09-03 (resale review)'),
  ('SK212-12E', 'removed by Matt 2026-09-03 (resale review)'),
  ('t-slot Nut', 'Fishbowl part type: labor'),
  ('TESTING', 'Fishbowl part type: labor'),
  ('UPS ACCT ON FILE', 'Fishbowl part type: internal use'),
  ('USPS  Freight', 'removed by Matt 2026-09-03 (resale review)'),
  ('USPS Freight (deact)', 'Fishbowl part type: service'),
  ('Wire Fee', 'Fishbowl part type: internal use'),
  ('WIRE TRANSFER FEE', 'Fishbowl part type: internal use'),
  ('ZGO65-50H', 'removed by Matt 2026-09-03 (resale review)')
ON CONFLICT (product_num) DO NOTHING;

/* ---------- 2. line-type correction */
DELETE FROM public.fb_so_history_lines WHERE line_type_id IS NOT NULL AND line_type_id NOT IN (10, 12);
UPDATE public.fb_sync_state SET history_cursor = NULL WHERE id = 1;   /* next bridge run (or `npm run backfill:pricing`) re-reads from 2023-11-27 with typeId IN (10,12) */

/* ---------- 3. view */
CREATE OR REPLACE VIEW public.v_customer_purchases WITH (security_invoker = on) AS
WITH lines AS (
  SELECT fb_customer_id, product_key, product_num, description, qty_fulfilled AS qty, unit_price, fb_date_created AS dt, 'history' AS src
  FROM public.fb_so_history_lines WHERE COALESCE(qty_fulfilled,0) > 0 AND (line_type_id IS NULL OR line_type_id IN (10, 12))
  UNION ALL
  SELECT so.fb_customer_id, upper(regexp_replace(l.product_num, '\s', '', 'g')), l.product_num, l.description, l.qty_ordered, l.unit_price, so.fb_date_created, 'open'
  FROM public.fb_sales_order_lines l JOIN public.fb_sales_orders so ON so.fb_so_id = l.fb_so_id
  WHERE l.removed_at IS NULL AND so.removed_at IS NULL AND l.type_id IN (10, 12)
    AND NOT EXISTS (SELECT 1 FROM public.fb_so_history_lines h WHERE h.fb_soitem_id = l.fb_soitem_id)
)
SELECT l.fb_customer_id, l.product_key, MAX(l.product_num) AS product_num, MAX(l.description) AS description,
       MIN(dt)::date AS first_bought, MAX(dt)::date AS last_bought, COUNT(*) AS lines,
       SUM(qty) AS qty, SUM(qty * COALESCE(unit_price,0)) AS revenue,
       (array_agg(unit_price ORDER BY dt DESC) FILTER (WHERE unit_price > 0))[1] AS last_paid,
       MIN(unit_price) FILTER (WHERE unit_price > 0) AS min_paid, MAX(unit_price) AS max_paid
FROM lines l
WHERE NOT EXISTS (SELECT 1 FROM public.pricing_excluded_products x WHERE x.product_key = l.product_key)
GROUP BY l.fb_customer_id, l.product_key;
GRANT SELECT ON public.v_customer_purchases TO authenticated;

/* ---------- 4. statistics */
CREATE OR REPLACE FUNCTION public.pricing_top_customers(p_limit integer DEFAULT 10)
RETURNS TABLE (fb_customer_id integer, customer_number text, name_clean text, tier text, salesman text, is_active boolean,
               revenue_12m numeric, revenue_all numeric, orders_12m bigint, orders_all bigint, parts_all bigint, last_order date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH h AS (
    SELECT l.fb_customer_id, l.fb_so_id, l.product_key, l.qty_fulfilled * COALESCE(l.unit_price,0) AS rev, l.fb_date_created
    FROM public.fb_so_history_lines l
    WHERE COALESCE(l.qty_fulfilled,0) > 0 AND (l.line_type_id IS NULL OR l.line_type_id IN (10,12))
      AND NOT EXISTS (SELECT 1 FROM public.pricing_excluded_products x WHERE x.product_key = l.product_key)
  ),
  agg AS (
    SELECT fb_customer_id,
           SUM(rev) FILTER (WHERE fb_date_created >= now() - interval '12 months') AS revenue_12m,
           SUM(rev) AS revenue_all,
           COUNT(DISTINCT fb_so_id) FILTER (WHERE fb_date_created >= now() - interval '12 months') AS orders_12m,
           COUNT(DISTINCT fb_so_id) AS orders_all,
           COUNT(DISTINCT product_key) AS parts_all,
           MAX(fb_date_created)::date AS last_order
    FROM h GROUP BY fb_customer_id
  )
  SELECT a.fb_customer_id, c.customer_number, COALESCE(c.name_clean, '#' || a.fb_customer_id), c.tier, c.salesman, COALESCE(c.is_active, true),
         COALESCE(a.revenue_12m,0), a.revenue_all, COALESCE(a.orders_12m,0), a.orders_all, a.parts_all, a.last_order
  FROM agg a LEFT JOIN public.v_customer_pricing_current c ON c.fb_customer_id = a.fb_customer_id
  ORDER BY a.revenue_12m DESC NULLS LAST, a.revenue_all DESC
  LIMIT p_limit
$$;

CREATE OR REPLACE FUNCTION public.pricing_part_customers(p_part text, p_limit integer DEFAULT 10)
RETURNS TABLE (fb_customer_id integer, customer_number text, name_clean text, tier text, salesman text,
               qty numeric, revenue numeric, orders bigint, last_bought date, last_paid numeric, avg_paid numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH h AS (
    SELECT l.fb_customer_id, l.fb_so_id, l.qty_fulfilled AS qty, l.unit_price, l.fb_date_created
    FROM public.fb_so_history_lines l
    WHERE l.product_key = upper(regexp_replace(p_part, '\s', '', 'g'))
      AND COALESCE(l.qty_fulfilled,0) > 0 AND (l.line_type_id IS NULL OR l.line_type_id IN (10,12))
  ),
  agg AS (
    SELECT fb_customer_id, SUM(qty) AS qty, SUM(qty * COALESCE(unit_price,0)) AS revenue, COUNT(DISTINCT fb_so_id) AS orders,
           MAX(fb_date_created)::date AS last_bought,
           (array_agg(unit_price ORDER BY fb_date_created DESC) FILTER (WHERE unit_price > 0))[1] AS last_paid,
           SUM(qty * COALESCE(unit_price,0)) / NULLIF(SUM(qty) FILTER (WHERE unit_price > 0),0) AS avg_paid
    FROM h GROUP BY fb_customer_id
  )
  SELECT a.fb_customer_id, c.customer_number, COALESCE(c.name_clean, '#' || a.fb_customer_id), c.tier, c.salesman,
         a.qty, a.revenue, a.orders, a.last_bought, a.last_paid, round(a.avg_paid, 4)
  FROM agg a LEFT JOIN public.v_customer_pricing_current c ON c.fb_customer_id = a.fb_customer_id
  ORDER BY a.revenue DESC
  LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION public.pricing_top_customers(integer), public.pricing_part_customers(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pricing_top_customers(integer), public.pricing_part_customers(text, integer) TO authenticated;

/* ---------- verify (run separately) */
SELECT count(*) AS excluded FROM public.pricing_excluded_products;                                 /* 54 */
SELECT name_clean, tier, revenue_12m, revenue_all, orders_12m, last_order FROM public.pricing_top_customers(10);
SELECT name_clean, tier, qty, revenue, last_paid, last_bought FROM public.pricing_part_customers('SK2003-42A', 5);
