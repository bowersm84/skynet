-- 2026-09-23_DIAG_fb_inventory_coverage_READONLY.sql
-- READ-ONLY. Single statement, SQL-Editor-ready (no psql meta-commands). Run on PROD.
--
-- Purpose: measure how much Fishbowl inventory reaches SkyNet (fb_part_inventory, D-FB-33).
-- Run it BEFORE the bridge inventory-scope change (baseline) and AFTER (acceptance).
--
-- Sections (one row each unless noted; value is jsonb):
--   1_freshness         last inventory cycle, bridge version, last error, row counts, stale rows, all-zero rows
--   2_coverage_by_type  per SkyNet part_type: parts, known in Fishbowl, with a row, missing, no row at all, stale
--   3_location_groups   per Fishbowl location group: rows with stock, total on hand
--   4_probe             the parts from Matt's 2026-09-23 screenshots + one known-stale row
--
-- "Known in Fishbowl" = the part number appears in fb_products (not removed) or fb_part_costs. It UNDERCOUNTS:
--   a Fishbowl part with no Fishbowl product and no PO cost is invisible to it (SK4FB13S — 53 on hand in Fishbowl
--   on 2026-09-23, no product). So "missing" can reach 0 while such parts still lack a row; "no_row" catches them.
-- "Stale" = snapshot_at more than 10 min before fb_sync_state.last_inventory_at (D-FB-39 rule).
--
-- Baseline (PROD 2026-09-23 ~17:15 UTC):
--   rows 443 · linked to SkyNet parts 317 · stale 113 · all-zero rows 0
--   assembly 207/433 · finished_good 99/244 · manufactured 3/402 · purchased 8/61  (with row / known in Fishbowl)
--   no_row: assembly 241 · finished_good 149 · manufactured 433 · purchased 60  (883 of 1,200 SkyNet parts)
-- First-cycle watch (≤ 5 min after restart): bridge_version = the version you deployed (1.6.0 if the inventory
--   change sits on top of D-PRICE-49's undeployed 1.5.0) · inventory_age_min < 5 · last_error null
--   (baseline last_error_at 2026-09-13 — it must not move).
-- Acceptance after the bridge change (scope = SkyNet parts + sales-order parts + parts already in fb_part_inventory):
--   missing = 0 in every type · no_row small — only SkyNet parts with no Fishbowl part record at all (at most 60
--   today; look at any that surprise you) · stale = 0 · all-zero rows > 0 (proves absence is written as zero,
--   not skipped) · every probe part has a row. Fishbowl on 2026-09-23 for the probes: SK4C13C 1,750, SK4FB13S 53,
--   SK26FB 33,633, SK4000-3S 821,492, SK4000CGP81 1,107,472 (+400,000 on order) — numbers will have moved.
with st as (
  select last_inventory_at, last_heartbeat_at, bridge_version, last_error, last_error_at from fb_sync_state where id = 1
),
known as (
  select part_num as pn from fb_products where removed_at is null and part_num is not null
  union
  select product_num from fb_products where removed_at is null and product_num is not null
  union
  select part_num from fb_part_costs where part_num is not null
),
inv as (
  select i.*,
         (i.snapshot_at < (select last_inventory_at from st) - interval '10 minutes') as is_stale,
         (coalesce(i.qty_on_hand, 0) = 0 and coalesce(i.qty_allocated, 0) = 0
          and coalesce(i.qty_not_available, 0) = 0 and coalesce(i.qty_on_order, 0) = 0) as is_zero
  from fb_part_inventory i
),
lg as (
  select g.key as location_group_id,
         count(*) filter (where coalesce((g.value->>'onHand')::numeric, 0) <> 0) as rows_with_stock,
         sum(coalesce((g.value->>'onHand')::numeric, 0)) as on_hand
  from fb_part_inventory i
  cross join lateral jsonb_each(case when jsonb_typeof(i.by_location) = 'object' then i.by_location else '{}'::jsonb end) g
  group by g.key
)
select '1_freshness' as section, jsonb_build_object(
    'last_inventory_at', (select last_inventory_at from st),
    'inventory_age_min', (select round(extract(epoch from (now() - last_inventory_at)) / 60.0, 1) from st),
    'heartbeat_age_min', (select round(extract(epoch from (now() - last_heartbeat_at)) / 60.0, 1) from st),
    'bridge_version',    (select bridge_version from st),
    'last_error',        (select left(last_error, 200) from st),
    'last_error_at',     (select last_error_at from st),
    'rows',              (select count(*) from inv),
    'rows_linked_to_skynet_part', (select count(*) from inv where part_id is not null),
    'rows_not_in_skynet', (select count(*) from inv where part_id is null),
    'stale_rows',        (select count(*) from inv where is_stale),
    'oldest_stale_snapshot', (select min(snapshot_at) from inv where is_stale),
    'all_zero_rows',     (select count(*) from inv where is_zero)
  ) as value
union all
select '2_coverage_by_type', jsonb_agg(x order by x->>'part_type')
from (
  select jsonb_build_object(
           'part_type', p.part_type,
           'skynet_parts', count(*),
           'known_in_fishbowl', count(*) filter (where k.pn is not null),
           'with_row', count(*) filter (where i.part_id is not null),
           'missing', count(*) filter (where k.pn is not null and i.part_id is null),
           'no_row', count(*) filter (where i.part_id is null),
           'stale', count(*) filter (where i.is_stale)
         ) as x
  from parts p
  left join (select distinct pn from known) k on k.pn = p.part_number
  left join inv i on i.part_id = p.id
  group by p.part_type
) t
union all
select '3_location_groups', jsonb_agg(jsonb_build_object(
    'location_group_id', location_group_id,
    'name', case location_group_id when '1' then 'Main' when '2' then 'Skybolt1' when '3' then 'Skybolt2'
                                   when '4' then 'Skybolt' when '5' then 'Skybolt>2' when '6' then 'Warehouse'
                                   when '7' then 'Material' when '8' then 'Manufacturing' else 'LG ' || location_group_id end,
    'rows_with_stock', rows_with_stock,
    'on_hand', on_hand) order by location_group_id::int)
from lg
union all
select '4_probe', jsonb_agg(jsonb_build_object(
    'part_number', v.pn,
    'skynet_type', p.part_type,
    'known_in_fishbowl', exists (select 1 from known k where k.pn = v.pn),
    'has_row', i.part_num is not null,
    'on_hand', i.qty_on_hand, 'allocated', i.qty_allocated, 'available', i.qty_available, 'on_order', i.qty_on_order,
    'snapshot_at', i.snapshot_at, 'stale', i.is_stale) order by v.ord)
from (values (1, 'SK-O'), (2, 'SK40S47-13S'), (3, 'SK26FB'), (4, 'SK4000-3S'), (5, 'SK4000CGP81'),
             (6, 'SK4C13C'), (7, 'SK4FB13S'), (8, 'SK203C22')) as v(ord, pn)
left join parts p on p.part_number = v.pn
left join inv i on i.part_num = v.pn;
