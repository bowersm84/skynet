-- D-PRICE-44 step 1b — v_customer_purchases: admit kit header lines (type 80) and classify component lines.
-- Run AFTER the bridge with the (10, 12, 80) filter is deployed; safe to run before the backfill finishes
-- (the new columns simply read 0 / false until kit rows arrive). TEST first, then PROD.
--
-- Rule for "via kit": a type-10/12 line at $0 on an SO that also carries a type-80 line. Priced parts on
-- a kit SO stay "direct" (a customer can buy a kit and loose parts together). BOM-based refinement is
-- possible later once kit_skus are mapped to Fishbowl kit product numbers (step 2).
--
-- Existing columns and their order are unchanged (CREATE OR REPLACE VIEW requires it); five columns are
-- appended: qty_direct, qty_via_kit, kit_lines, is_kit, purchase_kind ('kit' | 'direct' | 'via_kit').

create index if not exists fb_so_history_lines_so_type_idx on public.fb_so_history_lines (fb_so_id, line_type_id);

create or replace view public.v_customer_purchases as
with kit_sos as (
  select distinct fb_so_id from public.fb_so_history_lines where line_type_id = 80
  union
  select distinct k.fb_so_id from public.fb_sales_order_lines k where k.type_id = 80 and k.removed_at is null
),
lines as (
  select h.fb_customer_id,
         h.product_key,
         h.product_num,
         h.description,
         h.qty_fulfilled as qty,
         h.unit_price,
         h.fb_date_created as dt,
         'history'::text as src,
         (h.line_type_id = 80) as is_kit_line,
         (coalesce(h.line_type_id, 10) <> 80 and coalesce(h.unit_price, 0) = 0
            and h.fb_so_id in (select fb_so_id from kit_sos)) as via_kit
  from public.fb_so_history_lines h
  where coalesce(h.qty_fulfilled, 0) > 0
    and (h.line_type_id is null or h.line_type_id = any (array[10, 12, 80]))
  union all
  select so.fb_customer_id,
         upper(regexp_replace(l.product_num, '\s', '', 'g')),
         l.product_num,
         l.description,
         l.qty_ordered,
         l.unit_price,
         so.fb_date_created,
         'open'::text,
         (l.type_id = 80),
         (l.type_id <> 80 and coalesce(l.unit_price, 0) = 0 and l.fb_so_id in (select fb_so_id from kit_sos))
  from public.fb_sales_order_lines l
  join public.fb_sales_orders so on so.fb_so_id = l.fb_so_id
  where l.removed_at is null and so.removed_at is null
    and l.type_id = any (array[10, 12, 80])
    and not exists (select 1 from public.fb_so_history_lines h where h.fb_soitem_id = l.fb_soitem_id)
)
select fb_customer_id,
       product_key,
       max(product_num)                                   as product_num,
       max(description)                                   as description,
       min(dt)::date                                      as first_bought,
       max(dt)::date                                      as last_bought,
       count(*)                                           as lines,
       sum(qty)                                           as qty,
       sum(qty * coalesce(unit_price, 0))                 as revenue,
       (array_agg(unit_price order by dt desc) filter (where unit_price > 0))[1] as last_paid,
       min(unit_price) filter (where unit_price > 0)      as min_paid,
       max(unit_price)                                    as max_paid,
       -- appended (D-PRICE-44)
       sum(qty) filter (where not via_kit)                as qty_direct,
       sum(qty) filter (where via_kit)                    as qty_via_kit,
       count(*) filter (where is_kit_line)                as kit_lines,
       bool_or(is_kit_line)                               as is_kit,
       case when bool_or(is_kit_line) then 'kit'
            when coalesce(sum(qty) filter (where not via_kit), 0) > 0 then 'direct'
            else 'via_kit' end                            as purchase_kind
from lines l
where not exists (select 1 from public.pricing_excluded_products x where x.product_key = l.product_key)
group by fb_customer_id, product_key;

-- Verify (run separately). Before the backfill: kit_rows 0, via_kit_rows 0, and total rows / revenue equal
-- to the old view's. After: kit_rows > 0 and, for Irwin, purchase_kind counts that roughly match the
-- 229 $0 parts as via_kit.
select count(*) as rows, count(*) filter (where purchase_kind = 'kit') as kit_rows,
       count(*) filter (where purchase_kind = 'via_kit') as via_kit_rows,
       count(*) filter (where purchase_kind = 'direct') as direct_rows,
       round(sum(revenue)) as revenue
from public.v_customer_purchases;

with irwin as (select fb_customer_id from public.fb_customers where name ilike 'irwin%' order by fb_customer_id limit 1)
select purchase_kind, count(*) as parts, round(sum(revenue)) as revenue, sum(qty_via_kit) as qty_via_kit
from public.v_customer_purchases v, irwin
where v.fb_customer_id = irwin.fb_customer_id
group by 1 order by 1;
