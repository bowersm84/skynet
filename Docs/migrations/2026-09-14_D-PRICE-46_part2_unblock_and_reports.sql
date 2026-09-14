-- D-PRICE-46 part 2 — unblock kit sums; review reports (2026-09-14)
-- psql only (see part 1 header). TEST first:  psql $env:TEST_DB_URL -v ON_ERROR_STOP=1 -f <this file> *> d46b_test.log
-- Touches the DRAFT book only. Absolute, re-runnable.

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- BLOCK 5 — two fix-ups from the Block 3 coverage report
--   5a. Instruction sheets (pricing_excluded_products) are free documents: keep them in the registry BOM,
--       drop them from the book's component list so they do not block the kit sum.
--   5b. Hardware already in Rev 82 with no price, but with a PO cost in the seed: price it at 2× cost.
-- ═════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_book uuid; v_docs int; v_hw int;
begin
  v_book := (select id from public.price_books where status = 'draft' order by effective_from desc limit 1);

  delete from public.price_kit_components c
   using public.price_items i
   where c.item_id = i.id and i.book_id = v_book and i.kit_sku_id is not null
     and exists (select 1 from public.pricing_excluded_products x where x.product_key = c.component_key);
  get diagnostics v_docs = row_count;

  update public.price_items i
     set list_price = round(h.po_cost * 2, 3), status = 'priced', updated_at = now(),
         notes = coalesce(i.notes || ' | ', '') || 'Priced 2 × last PO cost ' || h.po_cost || ' (' || h.basis || ') for kit sums (D-PRICE-46); replaced by fb_part_costs (D-PRICE-47)'
    from (values
      ('D188C', 0.8862, 'Last PO 05/2026 — Amazing Magnets'),
      ('MS24693-C273', 0.1200, 'Last PO 06/2026 — BILD INDUSTRIES'),
      ('MS24693-C271', 0.1600, 'Last PO 07/2025 — MONROE AEROSPACE'),
      ('MS24693-C274', 0.1400, 'Last PO 05/2026 — BILD INDUSTRIES'),
      ('MS24693-C275', 0.1400, 'Last PO 06/2025 — BILD INDUSTRIES'),
      ('MS24693-C276', 0.1600, 'Last PO 06/2025 — BILD INDUSTRIES'),
      ('MS24693-C49', 0.0900, 'Last PO 03/2024 — AIRCRAFT SPRUCE & SPECIALTY'),
      ('MS24693-C4', 0.1400, 'Last PO 02/2025 — BILD INDUSTRIES'),
      ('MS24693-C50', 0.1200, 'Last PO 10/2025 — MONROE AEROSPACE'),
      ('MS24693-C272', 0.1000, 'Last PO 06/2026 — BILD INDUSTRIES'),
      ('MS24693-C48', 0.0900, 'Last PO 05/2024 — MONROE AEROSPACE'),
      ('MS24693-C52', 0.1100, 'Last PO 10/2025 — BILD INDUSTRIES'),
      ('MS24693-C270', 0.2200, 'Last PO 07/2025 — MONROE AEROSPACE'),
      ('MS24693-C28', 0.0610, 'Last PO 08/2025 — BILD INDUSTRIES'),
      ('MS24693-C26', 0.0600, 'Last PO 09/2025 — BILD INDUSTRIES'),
      ('MS24693-C30', 0.1000, 'Last PO 01/2026 — BILD INDUSTRIES'),
      ('MS24693-C293', 0.2600, 'Last PO 09/2024 — MONROE AEROSPACE'),
      ('MS24693-S52', 0.0900, 'Last PO 06/2025 — BILD INDUSTRIES'),
      ('MS24693-S51', 0.1300, 'Last PO 07/2025 — MONROE AEROSPACE'),
      ('MS24693-S3', 0.0500, 'Last PO 10/2025 — BILD INDUSTRIES'),
      ('MS21044N08', 0.1700, 'Last PO 05/2026 — BILD INDUSTRIES'),
      ('MS21044C06', 0.3100, 'Last PO 09/2024 — BILD INDUSTRIES'),
      ('MS21044C4', 1.3000, 'Last PO 04/2026 — BILD INDUSTRIES'),
      ('NAS1515-H-3L', 0.0400, 'Last PO 06/2026 — ECAS, LLC DBA MONROE AEROSPACE'),
      ('NAS1515-H-08L', 0.0600, 'Last PO 06/2026 — ECAS, LLC DBA MONROE AEROSPACE'),
      ('SR4SS', 0.4700, 'Last PO 07/2026 — AIRCRAFT SPRUCE & SPECIALTY'),
      ('AN960C10L', 0.0500, 'Last PO 03/2024 — AIRCRAFT SPRUCE & SPECIALTY'),
      ('AN960C6L', 0.0200, 'Last PO 02/2024 — BILD INDUSTRIES'),
      ('AN960-10L', 0.1700, 'Last PO 03/2024 — BILD INDUSTRIES'),
      ('MS28775-008', 0.9800, 'Last PO 09/2025 — AIRCRAFT SPRUCE & SPECIALTY'),
      ('MS28775-011', 1.0100, 'Last PO 09/2025 — AIRCRAFT SPRUCE & SPECIALTY'),
      ('SK244-461', 0.2000, 'Last PO 12/2025 — ELECTROLAB II, INC')
    ) as h(part_number, po_cost, basis)
   where i.book_id = v_book
     and i.part_key = upper(regexp_replace(h.part_number, '\s', '', 'g'))
     and (i.list_price is null or i.status = 'no_price');
  get diagnostics v_hw = row_count;

  raise notice 'D-PRICE-46 part 2: % instruction-sheet component rows removed from kit sums; % existing unpriced hardware items priced at 2× cost', v_docs, v_hw;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- BLOCK 6 — coverage after the fix-ups (same as Block 3). Expect Cowling and Option nearly complete;
--   RV and Lancair depend on MS21059L3 / SK2600-SWS / SK294290-2-160W and friends.
-- ═════════════════════════════════════════════════════════════════════════════════════════════
with b as (select id from public.price_books where status = 'draft' order by effective_from desc limit 1),
kits as (select i.id, i.part_number, s.name as section from public.price_items i join public.price_sections s on s.id = i.section_id, b where i.book_id = b.id and i.kit_sku_id is not null and i.status = 'component_sum'),
comp as (
  select k.id, k.section, c.component_key,
         exists (select 1 from public.price_items x, b where x.book_id = b.id and x.part_key = c.component_key and x.status = 'priced' and x.list_price is not null) as resolved
  from kits k join public.price_kit_components c on c.item_id = k.id)
select section, count(distinct id) as kits,
       count(distinct id) filter (where id not in (select id from comp where not resolved)) as fully_priced,
       count(distinct id) filter (where id in (select id from comp where not resolved)) as blocked
from comp group by 1 order by 1;

-- 6b. what still blocks, with the kits each one blocks — the price-or-cost to-do for Matt / April
with b as (select id from public.price_books where status = 'draft' order by effective_from desc limit 1),
kits as (select i.id, i.part_number from public.price_items i, b where i.book_id = b.id and i.kit_sku_id is not null and i.status = 'component_sum'),
comp as (select k.id, k.part_number as kit, c.component_key, c.component_part_number from kits k join public.price_kit_components c on c.item_id = k.id)
select c.component_part_number, count(distinct c.id) as kits_blocked,
       exists (select 1 from public.fb_products p where p.product_key = c.component_key) as in_fishbowl,
       (select p.list_price from public.fb_products p where p.product_key = c.component_key limit 1) as fishbowl_sale_price,
       left(string_agg(distinct c.kit, ', ' order by c.kit), 90) as kits_sample
from comp c, b
where not exists (select 1 from public.price_items x where x.book_id = b.id and x.part_key = c.component_key and x.status = 'priced' and x.list_price is not null)
group by 1, 3, 4 order by kits_blocked desc;

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- BLOCK 7 — kits whose Rev 82 sum lands BELOW today's Fishbowl list (i.e. the July floor was holding them
--   up). Small BOMs here usually mean a registry BOM gap rather than an overpriced kit — April's review list.
-- ═════════════════════════════════════════════════════════════════════════════════════════════
with b as (select id from public.price_books where status = 'draft' order by effective_from desc limit 1),
kits as (select i.id, i.part_number, i.part_key, i.description from public.price_items i, b where i.book_id = b.id and i.kit_sku_id is not null and i.status = 'component_sum'),
sums as (
  select k.id, k.part_number, k.part_key, k.description, sum(c.qty * x.list_price) as sum_each, count(*) as comps, count(x.id) as resolved
  from kits k join public.price_kit_components c on c.item_id = k.id
  left join public.price_items x on x.book_id = (select id from b) and x.part_key = c.component_key and x.status = 'priced'
  group by 1, 2, 3, 4)
select s.part_number, left(s.description, 40) as description, round(s.sum_each, 2) as rev82_sum, p.list_price as fishbowl_list,
       round(s.sum_each / nullif(p.list_price, 0), 3) as ratio, s.comps, s.resolved,
       (select count(*) from public.fb_so_history_lines h where h.product_key = s.part_key and h.line_type_id = 80 and h.fb_date_created >= '2025-09-01') as kit_lines_12m
from sums s join public.fb_products p on p.product_key = s.part_key and p.list_price > 0
where s.resolved = s.comps and s.sum_each < p.list_price
order by ratio;

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- BLOCK 8 — the 157 "zero sales" kits (never repriced in July): how many are priced now and what they
--   would move to. Decision for Matt: keep rule-priced, or inactivate in the registry like Trim / Fuel Tank.
-- ═════════════════════════════════════════════════════════════════════════════════════════════
with b as (select id from public.price_books where status = 'draft' order by effective_from desc limit 1),
kits as (select i.id, i.part_number, i.part_key from public.price_items i, b where i.book_id = b.id and i.kit_sku_id is not null and i.status = 'component_sum'),
sold as (select distinct product_key from public.fb_so_history_lines where line_type_id = 80 and coalesce(qty_fulfilled, 0) > 0),
sums as (select k.id, k.part_number, k.part_key, sum(c.qty * x.list_price) as sum_each, count(*) as comps, count(x.id) as resolved
         from kits k join public.price_kit_components c on c.item_id = k.id
         left join public.price_items x on x.book_id = (select id from b) and x.part_key = c.component_key and x.status = 'priced'
         group by 1, 2, 3)
select count(*) as kits_never_sold,
       count(*) filter (where resolved = comps) as priced_by_rule,
       round(avg(sum_each / nullif(p.list_price, 0)) filter (where resolved = comps), 2) as avg_ratio_vs_fishbowl_list
from sums s left join public.fb_products p on p.product_key = s.part_key
where s.part_key not in (select product_key from sold);
