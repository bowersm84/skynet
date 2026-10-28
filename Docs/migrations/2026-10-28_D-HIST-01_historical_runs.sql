/* 2026-10-28_D-HIST-01_historical_runs.sql
   D-HIST-01: traveler archive (Form 10-100 Work Travelers, Oct 2021 - May 2026) as read-only reference data.
   One row per machine run. Loaded by the per-year files 2026-10-28_D-HIST-01_load_YYYY.sql, then resolved
   to SkyNet parts, machines and jobs by public.historical_runs_resolve().
   - machine_on_traveler is the machine printed on the traveler. Travelers were often printed ahead of the
     order and could fall out of sync, so where the same run exists in SkyNet (same part + same lot number),
     skynet_job_id is set and SkyNet is the record (Matt, 2026-10-28).
   - Rows with no quantity recorded on the machine row are loaded as review_status = 'excluded'.
   - The source files on Google Drive remain the controlled record; source_file is the path below
     Travelers-Post-10-1-21.
   Run on TEST first, then the identical file on PROD. Safe to re-run. Block comments only (SQL Editor). */

create table if not exists public.historical_runs (
  id                   uuid primary key default gen_random_uuid(),
  source               text not null default 'traveler_archive',
  source_file          text not null,
  source_seq           smallint not null default 1,
  extract_batch        text,
  folder_year          smallint,
  folder_month         smallint,
  folder_order         text,
  folder_part          text,
  order_number         text,
  part_number_raw      text,
  part_id              uuid references public.parts(id) on delete set null,
  customer_raw         text,
  customer_name        text,
  order_qty            integer,
  order_kind           text,
  machine_raw          text,
  machine_on_traveler  text,
  machine_type         text,
  machine_match        text,
  machines_all         text[],
  machine_id           uuid references public.machines(id) on delete set null,
  qty_produced         integer,
  run_date             date,
  run_date_raw         text,
  lot_number           text,
  lot_date             date,
  operator_initials    text,
  material_raw         text,
  drawing_rev          text,
  tso_rev              text,
  start_date           date,
  due_date             date,
  final_process        text,
  manufacturing_no     text,
  heat_lot             text,
  traveler_notes       text,
  ops                  jsonb,
  flags                text[] not null default '{}',
  skynet_job_id        uuid references public.jobs(id) on delete set null,
  review_status        text not null default 'ok',
  review_note          text,
  loaded_at            timestamptz not null default now(),
  resolved_at          timestamptz,
  constraint historical_runs_source_uq unique (source_file, source_seq),
  constraint historical_runs_review_status_ck check (review_status in ('ok', 'needs_review', 'excluded'))
);

comment on table public.historical_runs is
  'D-HIST-01: machine runs read from the Form 10-100 Work Traveler archive (Oct 2021 - May 2026). Read-only reference; the Drive files remain the controlled record. SkyNet wins where skynet_job_id is set.';
comment on column public.historical_runs.machine_on_traveler is
  'Machine as printed on the traveler, normalized (M2 -> Mazak 2). "Mazak ?" = type known, number not recorded. May differ from the machine actually used.';
comment on column public.historical_runs.skynet_job_id is
  'Same run recorded in SkyNet (same part + same lot number). SkyNet is the record for that run.';
comment on column public.historical_runs.run_date is
  'Date on the traveler machine row, year corrected from the lot number where a rollover typo was evident (see flags). Null when not recorded; lot_date is the fallback.';

create index if not exists historical_runs_part_idx    on public.historical_runs (part_id);
create index if not exists historical_runs_machine_idx on public.historical_runs (machine_id);
create index if not exists historical_runs_lot_idx     on public.historical_runs (lot_number);

alter table public.historical_runs enable row level security;
drop policy if exists historical_runs_read on public.historical_runs;
create policy historical_runs_read on public.historical_runs for select to authenticated using (true);
revoke all on public.historical_runs from anon;
/* read-only to app users; loads and corrections run as postgres in the SQL Editor */
revoke insert, update, delete, truncate, references, trigger on public.historical_runs from authenticated;

/* Resolve part, machine and SkyNet job links. Re-runnable; only fills what is still null. */
create or replace function public.historical_runs_resolve()
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_part_exact   integer := 0;
  v_part_folder  integer := 0;
  v_part_norm    integer := 0;
  v_machine      integer := 0;
  v_job          integer := 0;
begin
  /* part: traveler part number, exact */
  update public.historical_runs h set part_id = p.id
    from public.parts p
   where h.part_id is null and h.part_number_raw is not null
     and upper(p.part_number) = upper(btrim(h.part_number_raw));
  get diagnostics v_part_exact = row_count;

  /* part: folder part number, exact */
  update public.historical_runs h set part_id = p.id
    from public.parts p
   where h.part_id is null and h.folder_part is not null
     and upper(p.part_number) = upper(btrim(h.folder_part));
  get diagnostics v_part_folder = row_count;

  /* part: spaces and a trailing "(...)" note removed, e.g. "SK212-12S((GANESH" */
  update public.historical_runs h set part_id = p.id
    from public.parts p
   where h.part_id is null and h.part_number_raw is not null
     and upper(regexp_replace(p.part_number, '\s+', '', 'g'))
       = upper(regexp_replace(regexp_replace(h.part_number_raw, '\s*\(.*$', ''), '\s+', '', 'g'));
  get diagnostics v_part_norm = row_count;

  /* machine by name; "Mazak ?" and other unnumbered entries stay null with machine_type kept */
  update public.historical_runs h set machine_id = m.id
    from public.machines m
   where h.machine_id is null and h.machine_on_traveler is not null
     and lower(m.name) = lower(h.machine_on_traveler);
  get diagnostics v_machine = row_count;

  /* same run already in SkyNet: same part + same traveler lot number. SkyNet is the record. */
  update public.historical_runs h set skynet_job_id = j.id
    from public.jobs j
   where h.skynet_job_id is null and h.part_id is not null and h.lot_number is not null
     and j.component_id = h.part_id
     and coalesce(j.status, '') <> 'cancelled'
     and upper(btrim(j.production_lot_number)) = upper(btrim(h.lot_number));
  get diagnostics v_job = row_count;

  update public.historical_runs set resolved_at = now() where id is not null;

  return jsonb_build_object(
    'rows',            (select count(*) from public.historical_runs),
    'part_linked_now', v_part_exact + v_part_folder + v_part_norm,
    'machine_linked_now', v_machine,
    'skynet_linked_now',  v_job,
    'part_linked',     (select count(*) from public.historical_runs where part_id is not null),
    'machine_linked',  (select count(*) from public.historical_runs where machine_id is not null),
    'in_skynet',       (select count(*) from public.historical_runs where skynet_job_id is not null),
    'excluded',        (select count(*) from public.historical_runs where review_status = 'excluded'));
end;
$function$;

revoke all on function public.historical_runs_resolve() from public, anon, authenticated;

/* Part x machine summary of the archive: what has run where, how often, how many, last time.
   Excludes rows SkyNet already holds and rows with no production recorded. */
create or replace view public.v_historical_part_machine
with (security_invoker = on) as
select h.part_id,
       p.part_number,
       h.machine_id,
       coalesce(m.name, h.machine_on_traveler, h.machine_raw) as machine_name,
       h.machine_type,
       count(*)::integer                                       as runs,
       coalesce(sum(h.qty_produced), 0)::integer               as pieces,
       min(coalesce(h.run_date, h.lot_date))                   as first_run,
       max(coalesce(h.run_date, h.lot_date))                   as last_run,
       round(avg(h.qty_produced))::integer                     as avg_lot,
       array_agg(distinct h.customer_name) filter (where h.customer_name is not null) as customers
  from public.historical_runs h
  left join public.parts p on p.id = h.part_id
  left join public.machines m on m.id = h.machine_id
 where h.review_status <> 'excluded'
   and h.skynet_job_id is null
 group by h.part_id, p.part_number, h.machine_id, coalesce(m.name, h.machine_on_traveler, h.machine_raw), h.machine_type;

grant select on public.v_historical_part_machine to authenticated;

/* VERIFY (expect: table_exists, resolve_fn, view_exists and rls_on all true) */
select to_regclass('public.historical_runs') is not null               as table_exists,
       to_regprocedure('public.historical_runs_resolve()') is not null as resolve_fn,
       to_regclass('public.v_historical_part_machine') is not null     as view_exists,
       (select relrowsecurity from pg_class where oid = 'public.historical_runs'::regclass) as rls_on;
