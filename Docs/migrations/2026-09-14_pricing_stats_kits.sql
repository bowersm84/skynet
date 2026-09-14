-- D-PRICE-44 step 1c — statistics RPCs admit Fishbowl kit header lines (line_type_id 80).
-- Companion to 2026-09-14_v_customer_purchases_kits.sql. Same signatures, so CREATE OR REPLACE keeps the
-- existing grants (SECURITY DEFINER, STABLE). Run on TEST, then PROD; safe before or after the backfill.
-- Only change in each body: (10,12) → (10,12,80). Kit header lines carry the kit's price, so revenue,
-- orders and "who buys this part" now include kit sales.

CREATE OR REPLACE FUNCTION public.pricing_part_customers(p_part text, p_limit integer DEFAULT 10)
 RETURNS TABLE(fb_customer_id integer, customer_number text, name_clean text, tier text, salesman text, qty numeric, revenue numeric, orders bigint, last_bought date, last_paid numeric, avg_paid numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH h AS (
    SELECT l.fb_customer_id, l.fb_so_id, l.qty_fulfilled AS qty, l.unit_price, l.fb_date_created
    FROM public.fb_so_history_lines l
    WHERE l.product_key = upper(regexp_replace(p_part, '\s', '', 'g'))
      AND COALESCE(l.qty_fulfilled,0) > 0 AND (l.line_type_id IS NULL OR l.line_type_id IN (10,12,80))   -- D-PRICE-44: kit headers
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
$function$;

CREATE OR REPLACE FUNCTION public.pricing_top_customers(p_limit integer DEFAULT 10)
 RETURNS TABLE(fb_customer_id integer, customer_number text, name_clean text, tier text, salesman text, is_active boolean, revenue_12m numeric, revenue_all numeric, orders_12m bigint, orders_all bigint, parts_all bigint, last_order date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH h AS (
    SELECT l.fb_customer_id, l.fb_so_id, l.product_key, l.qty_fulfilled * COALESCE(l.unit_price,0) AS rev, l.fb_date_created
    FROM public.fb_so_history_lines l
    WHERE COALESCE(l.qty_fulfilled,0) > 0 AND (l.line_type_id IS NULL OR l.line_type_id IN (10,12,80))   -- D-PRICE-44: kit headers
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
$function$;

-- Verify (run separately): both bodies carry the new literal, and no pricing object still filters to (10,12) alone.
select p.proname,
       pg_get_functiondef(p.oid) ~ 'IN \(10,12,80\)' as has_80,
       pg_get_functiondef(p.oid) ~ 'IN \(10,12\)\)'  as still_old
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('pricing_top_customers', 'pricing_part_customers');
-- expect: has_80 true / still_old false on both rows
