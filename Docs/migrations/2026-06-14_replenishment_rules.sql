-- 2026-06-14_replenishment_rules.sql
-- Replenishment Rules: minimum on-hand bar thresholds per material type + bar size.
-- In-app low-stock alerts only (no email this round). Applied to TEST 2026-06-14.
--
-- One rule per (material_type_id, bar_size_id). below-min is evaluated in-app by
-- comparing the rule's min_bars against the total available bars for that
-- material type + size across all lots (thresholds are vendor-agnostic).

create table if not exists public.material_replenishment_rules (
  id               uuid primary key default gen_random_uuid(),
  material_type_id uuid not null references public.material_types(id),
  bar_size_id      uuid not null references public.bar_sizes(id),
  min_bars         numeric not null default 0,
  is_active        boolean not null default true,
  notes            text,
  created_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (material_type_id, bar_size_id)
);

-- RLS: authenticated users may read/write (mirrors the other Armory master-data tables).
alter table public.material_replenishment_rules enable row level security;

create policy "material_replenishment_rules_select_authenticated"
  on public.material_replenishment_rules for select
  to authenticated using (true);

create policy "material_replenishment_rules_insert_authenticated"
  on public.material_replenishment_rules for insert
  to authenticated with check (true);

create policy "material_replenishment_rules_update_authenticated"
  on public.material_replenishment_rules for update
  to authenticated using (true) with check (true);

create policy "material_replenishment_rules_delete_authenticated"
  on public.material_replenishment_rules for delete
  to authenticated using (true);
