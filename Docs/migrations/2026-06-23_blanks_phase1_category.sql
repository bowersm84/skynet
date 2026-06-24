-- Blanks Phase 1 — category flag on material_receiving.
-- Run on TEST (ylzmyjjqibpbqbwjsnqj) first, verify, then PROD (luzungoqfuplspzbqctb).
alter table public.material_receiving
  add column if not exists category text not null default 'bar';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'material_receiving_category_check'
  ) then
    alter table public.material_receiving
      add constraint material_receiving_category_check check (category in ('bar','blank'));
  end if;
end $$;

create index if not exists idx_material_receiving_category
  on public.material_receiving(category);
