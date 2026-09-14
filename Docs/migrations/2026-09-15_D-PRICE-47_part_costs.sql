-- D-PRICE-47 — Latest purchase cost from Fishbowl → hardware valued at 2× cost in kit sums (2026-09-15)
-- v2: fb_upsert_part_costs now carries the D-FB-07 role gate (integration / admin). Re-run on TEST and PROD;
--     everything here is CREATE OR REPLACE / IF NOT EXISTS, so re-running is safe.
-- psql: TEST first, then PROD. Idempotent. No data written to price books by this file; the RPC that does
-- (pricing_refresh_hardware_costs) is draft-only, gated, and called from the portal or by Matt.
--
-- Pieces:
--   1. fb_part_costs — one row per part: latest RECEIVED PO line (cost, vendor, PO, date) + Fishbowl std cost.
--      Written nightly by the bridge via fb_upsert_part_costs(jsonb) (same pattern as the other mirrors).
--   2. price_items.cost_plus — marks items whose Each is derived from cost (the Kit Hardware section).
--   3. pricing_refresh_hardware_costs(p_book, p_markup) — sets Each = round(last_cost × (1 + markup), 3) for
--      cost_plus items in a DRAFT book; markup defaults to 1.0 (Matt, 2026-09-14: "double the hardware cost").
--      Published books never move; a new draft (clone) or the Refresh costs button picks up current costs.
--   4. v_hardware_cost_drift — active-book cost_plus items whose Each is >10% away from 2× today's cost.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1. mirror table
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.fb_part_costs (
  part_key        text primary key,                       -- upper(strip(product_num or part_num)) — joins price_items.part_key
  part_num        text not null,
  product_num     text,
  fb_part_id      integer,
  last_cost       numeric,                                -- unit cost of the latest received PO line
  last_cost_date  timestamptz,                            -- poitem.dateLastFulfillment of that line
  last_po_number  text,
  last_vendor     text,
  last_qty        numeric,
  std_cost        numeric,                                -- part.stdCost (Fishbowl's own standard cost), for comparison
  synced_at       timestamptz not null default now()
);
comment on table public.fb_part_costs is 'Fishbowl mirror (D-PRICE-47): latest received purchase cost per part. Written by the bridge nightly via fb_upsert_part_costs. Read by pricing_refresh_hardware_costs and the Kit Registry price panel.';
create index if not exists fb_part_costs_date_idx on public.fb_part_costs (last_cost_date desc);

alter table public.fb_part_costs enable row level security;
drop policy if exists fb_part_costs_read on public.fb_part_costs;
create policy fb_part_costs_read on public.fb_part_costs for select to authenticated using (true);
-- writes only through the SECURITY DEFINER upsert below (bridge role) — no insert/update policies.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. bridge upsert — mirrors the shape of the other fb_upsert_* RPCs: one jsonb array of rows.
--    Row keys: part_num, product_num, fb_part_id, last_cost, last_cost_date, last_po_number, last_vendor, last_qty, std_cost
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.fb_upsert_part_costs(p_rows jsonb)
returns integer
language plpgsql security definer set search_path to 'public'
as $$
declare v_n int;
begin
  perform public._pricing_gate(array['integration','admin']);   -- same gate as fb_upsert_products / customers / so_history (D-FB-07)
  insert into public.fb_part_costs (part_key, part_num, product_num, fb_part_id, last_cost, last_cost_date, last_po_number, last_vendor, last_qty, std_cost, synced_at)
  select upper(regexp_replace(coalesce(r.product_num, r.part_num), '\s', '', 'g')),
         r.part_num, r.product_num, r.fb_part_id, r.last_cost, r.last_cost_date, r.last_po_number, r.last_vendor, r.last_qty, r.std_cost, now()
  from jsonb_to_recordset(p_rows) as r(part_num text, product_num text, fb_part_id integer, last_cost numeric, last_cost_date timestamptz,
                                       last_po_number text, last_vendor text, last_qty numeric, std_cost numeric)
  where r.part_num is not null
  on conflict (part_key) do update
    set part_num = excluded.part_num, product_num = excluded.product_num, fb_part_id = excluded.fb_part_id,
        last_cost = excluded.last_cost, last_cost_date = excluded.last_cost_date, last_po_number = excluded.last_po_number,
        last_vendor = excluded.last_vendor, last_qty = excluded.last_qty, std_cost = excluded.std_cost, synced_at = now();
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.fb_upsert_part_costs(jsonb) from public;
revoke execute on function public.fb_upsert_part_costs(jsonb) from anon;
grant execute on function public.fb_upsert_part_costs(jsonb) to authenticated, service_role;   -- role-gated inside: only integration / admin get past the first line

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 3. cost-plus marker + refresh RPC
-- ─────────────────────────────────────────────────────────────────────────────────────────────
alter table public.price_items add column if not exists cost_plus boolean not null default false;
comment on column public.price_items.cost_plus is 'Each is derived from fb_part_costs.last_cost × (1 + markup) by pricing_refresh_hardware_costs (D-PRICE-47). Set for the Kit Hardware section.';

-- mark the Kit Hardware section items in every book that has the section (draft today; clones inherit the flag)
update public.price_items i set cost_plus = true
  from public.price_sections s
 where s.id = i.section_id and s.name = 'Kit Hardware (cost-based)' and not i.cost_plus;

create or replace function public.pricing_refresh_hardware_costs(p_book uuid, p_markup numeric default 1.0)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_updated int; v_no_cost int; v_added int;
begin
  perform public._pricing_gate(public._pricing_edit_roles());
  perform public._pricing_assert_draft(p_book);
  if p_markup is null or p_markup < 0 then
    raise exception 'pricing_refresh_hardware_costs: p_markup must be >= 0 (got %)', p_markup using errcode = '22023';
  end if;

  -- a. every cost_plus item with a cost on file: Each = cost × (1 + markup)
  update public.price_items i
     set list_price = round(c.last_cost * (1 + p_markup), 3), status = 'priced', updated_at = now(),
         notes = 'Cost-plus: ' || c.last_cost || ' × ' || (1 + p_markup) || ' — ' || coalesce(c.last_vendor, '?') || ' ' || coalesce(c.last_po_number, '') || ' ' || to_char(c.last_cost_date, 'YYYY-MM-DD') || ' (D-PRICE-47)'
    from public.fb_part_costs c
   where i.book_id = p_book and i.cost_plus and c.part_key = i.part_key and c.last_cost > 0;
  get diagnostics v_updated = row_count;

  -- b. kit components that still block a sum and DO have a cost: add them to the Kit Hardware section
  insert into public.price_items (book_id, section_id, part_number, description, list_price, rule_code, ladder_code, status, sort, notes, cost_plus, fb_product_id)
  select p_book, s.id, coalesce(c.product_num, c.part_num),
         (select p.description from public.fb_products p where p.product_key = c.part_key limit 1),
         round(c.last_cost * (1 + p_markup), 3),
         (select rule_code from public.price_items where book_id = p_book and cost_plus limit 1),
         coalesce((select ladder_code from public.price_items where book_id = p_book and cost_plus limit 1), 'none'),
         'priced', 5000 + row_number() over (order by c.part_key),
         'Cost-plus: ' || c.last_cost || ' × ' || (1 + p_markup) || ' — ' || coalesce(c.last_vendor, '?') || ' ' || coalesce(c.last_po_number, '') || ' ' || to_char(c.last_cost_date, 'YYYY-MM-DD') || ' (D-PRICE-47, auto-added for a kit sum)',
         true,
         (select p.fb_product_id from public.fb_products p where p.product_key = c.part_key limit 1)
  from public.price_sections s
  join public.fb_part_costs c on c.last_cost > 0
  where s.book_id = p_book and s.name = 'Kit Hardware (cost-based)'
    and exists (select 1 from public.price_kit_components k join public.price_items ki on ki.id = k.item_id
                where ki.book_id = p_book and k.component_key = c.part_key)
    and not exists (select 1 from public.price_items x where x.book_id = p_book and x.part_key = c.part_key);
  get diagnostics v_added = row_count;

  v_no_cost := (select count(*) from public.price_items i
                 where i.book_id = p_book and i.cost_plus
                   and not exists (select 1 from public.fb_part_costs c where c.part_key = i.part_key and c.last_cost > 0));

  return jsonb_build_object('updated', v_updated, 'added', v_added, 'no_cost_on_file', v_no_cost, 'markup', p_markup);
end $$;
revoke all on function public.pricing_refresh_hardware_costs(uuid, numeric) from public;
revoke execute on function public.pricing_refresh_hardware_costs(uuid, numeric) from anon;
grant execute on function public.pricing_refresh_hardware_costs(uuid, numeric) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 4. drift view — what the active book charges for hardware vs what 2× today's cost would be
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace view public.v_hardware_cost_drift as
select b.id as book_id, b.rev_label, i.part_number, i.part_key, i.list_price as book_each,
       c.last_cost, round(c.last_cost * 2, 3) as cost_plus_now, c.last_cost_date, c.last_vendor,
       round(i.list_price / nullif(c.last_cost * 2, 0) - 1, 3) as drift_pct,
       (select count(*) from public.price_kit_components k join public.price_items ki on ki.id = k.item_id
         where ki.book_id = b.id and k.component_key = i.part_key) as kits_using
from public.price_items i
join public.price_books b on b.id = i.book_id and b.status = 'active'
join public.fb_part_costs c on c.part_key = i.part_key
where i.cost_plus and c.last_cost > 0
  and abs(i.list_price / nullif(c.last_cost * 2, 0) - 1) > 0.10;

-- verify (psql prints all): table, RPCs, flag count, view compiles
select count(*) as cost_plus_items from public.price_items where cost_plus;                         -- expect 50 (40 seeded + 10 repriced) in the draft
select proname, pg_get_functiondef(oid) like '%_pricing_gate(array[''integration'',''admin''])%' as has_role_gate
  from pg_proc where proname in ('fb_upsert_part_costs', 'pricing_refresh_hardware_costs') order by 1;   -- fb_upsert_part_costs: true
select count(*) from public.v_hardware_cost_drift;                                                  -- 0 until the bridge has written costs
