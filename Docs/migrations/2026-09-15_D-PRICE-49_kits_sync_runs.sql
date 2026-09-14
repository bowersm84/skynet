-- D-PRICE-49 (SkyNet side) — kits_sync_runs: one row per sync-kits Edge Function run (dry runs included).
-- Idempotent. TEST and PROD (PROD already has it from the Editor run; re-running is harmless).
create table if not exists public.kits_sync_runs (
  id            bigint generated always as identity primary key,
  ran_at        timestamptz not null default now(),
  triggered_by  text,                   -- 'publish' | 'nightly' | 'manual' | 'dry_run'
  as_of         date not null,
  book_label    text,
  dry_run       boolean not null default false,
  kits_seen     integer, prices_written integer, prices_unchanged integer, stale_marked integer,
  discontinued  integer, components_rewritten integer,
  unmatched_registry_only text[],       -- registry kits the kits site does not list
  unmatched_site_only     text[],       -- kits-site kits the registry does not know
  report        jsonb,                  -- the full diff (price before/after per kit)
  error         text
);
alter table public.kits_sync_runs enable row level security;
drop policy if exists kits_sync_runs_read on public.kits_sync_runs;
create policy kits_sync_runs_read on public.kits_sync_runs for select to authenticated using (true);
comment on table public.kits_sync_runs is 'D-PRICE-49: log of sync-kits Edge Function runs (SkyNet book → skybolt-kits kit_pricing / kits / kit_components).';
select count(*) as runs from public.kits_sync_runs;   -- verify: 0 on a fresh table
