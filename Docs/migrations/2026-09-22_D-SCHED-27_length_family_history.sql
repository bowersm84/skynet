-- =====================================================================================
-- 2026-09-22_D-SCHED-27_length_family_history.sql
-- D-SCHED-27 — Length-family scheduling history (data layer)
-- v1.1 (2026-09-22): after the TEST run of v1.0 — §3 trigger no longer relabels the seed's own write
--   as 'manual' (source is respected when the caller sets it with the key; explicit opt-out = key NULL +
--   source 'manual'); §7 revokes the inherited default privileges before granting SELECT. TEST received
--   these two fixes via 2026-09-22_D-SCHED-27_TEST_hotfix_source_and_grants.sql; PROD runs this file only.
--
-- TEST FIRST (ylzmyjjqibpbqbwjsnqj). PROD (luzungoqfuplspzbqctb) only after the TEST pass.
--
-- HOW TO RUN
--   TEST  : Supabase SQL Editor, ONE SECTION AT A TIME (the Editor shows only the last
--           result set; every section ends with its own gate SELECT). DO blocks use := only.
--   PROD  : psql, single transaction, gates visible in the output:
--             $env:PGCLIENTENCODING = 'UTF8'
--             psql $env:PROD_DB_URL -v ON_ERROR_STOP=1 -1 -f .\2026-09-22_D-SCHED-27_length_family_history.sql
--
-- WHAT THIS ADDS
--   §1  derive_length_family(part_number, description)  — deterministic two-tier rule
--   §2  parts.length_family_key / length_dash / length_family_source / length_family_set_at
--   §3  trigger: fills the key on new/renamed parts ONLY when it is NULL (never overwrites)
--   §4  seed: dry-run preview, then guarded write; strike list for doubtful tier-2 families
--   §5  views: v_part_run_rates, v_length_family_machine_history, v_length_family_material,
--              v_part_observed_material, v_job_first_run
--   §6  part_machine_stats repaired: start basis coalesce(production_start, actual_start),
--              pieces basis good_pieces>0 else quantity (matches lib/scheduling effectiveTimePerUnit)
--   §7  grants (authenticated only — same posture as the report views)
--   §8  end-state snapshot
--
-- RULE (D-SCHED-27, agreed 2026-09-22)
--   Tier 1 (rule_desc): description begins "-N " → N is the dash. stem = leading [A-Z]+digits
--     token of the part number; the first digit run in the remainder equal to N is masked '#'.
--     SK4C4S "-4 Stud Stainless Slotted" → SK4C#S / 4.   SK26C1W1 "-1 Wing Stud" → SK26C#W1 / 1.
--   Tier 2 (rule_tail): description has no leading dash AND the part number ends in a digit run
--     preceded by a non-digit → that run is the dash. SK26CS6 "2600 Series Slotted Stud" → SK26CS# / 6.
--     Tier 2 is only trusted when the family has ≥ 2 members (seed) or already exists (trigger).
--   A stored value is never overwritten by the rule. Manual corrections set source = 'manual'.
--   parts.family_key (D-AISCHED-05, pricing/costing grain) is untouched.
-- =====================================================================================


-- ───────────────────────────── §0 PRE-FLIGHT (read-only) ─────────────────────────────
-- Expect: every "exists" column false; prod_done_runs_visible_to_stats small (PROD showed 21 of 184).
select
  exists (select 1 from information_schema.columns where table_schema='public' and table_name='parts' and column_name='length_family_key') as col_exists,
  exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='derive_length_family') as fn_exists,
  exists (select 1 from information_schema.views where table_schema='public' and table_name in ('v_part_run_rates','v_length_family_machine_history','v_length_family_material','v_part_observed_material','v_job_first_run')) as views_exist,
  (select count(*) from parts where part_type='manufactured') as manufactured_parts,
  (select sum(completed_runs) from part_machine_stats) as prod_done_runs_visible_to_stats,
  (select count(*) from jobs where assigned_machine_id is not null
     and status in ('manufacturing_complete','pending_passivation','in_passivation','pending_post_manufacturing','ready_for_outsourcing','at_external_vendor','ready_for_assembly','in_assembly','pending_tco','complete','incomplete')) as prod_done_runs_actual;


-- ───────────────────────────── §1 FUNCTION ─────────────────────────────
create or replace function public.derive_length_family(p_part_number text, p_description text)
returns table (length_family_key text, length_dash integer, length_family_source text)
language sql
immutable
as $fn$
  with d as (
    select (regexp_match(coalesce(p_description, ''), '^-(\d+)\s'))[1]               as desc_dash,
           (regexp_match(coalesce(p_part_number, ''), '^([A-Z]+\d+)(.*)$'))[1]       as stem,
           (regexp_match(coalesce(p_part_number, ''), '^([A-Z]+\d+)(.*)$'))[2]       as rest
  ),
  t1 as (
    select desc_dash, stem, rest,
           case when desc_dash is not null and stem is not null
                     and rest ~ ('(^|[^0-9])' || desc_dash || '([^0-9]|$)')
                then stem || regexp_replace(rest, '(^|[^0-9])' || desc_dash || '([^0-9]|$)', '\1#\2')
           end as k1
    from d
  ),
  t2 as (
    select desc_dash, stem, rest, k1,
           case when k1 is null and desc_dash is null and stem is not null and rest ~ '[^0-9]\d+$'
                then stem || regexp_replace(rest, '\d+$', '#')
           end as k2,
           (regexp_match(rest, '(\d+)$'))[1] as tail_digits
    from t1
  )
  select coalesce(k1, k2)                                                          as length_family_key,
         case when k1 is not null then desc_dash::int
              when k2 is not null then tail_digits::int end                        as length_dash,
         case when k1 is not null then 'rule_desc'
              when k2 is not null then 'rule_tail' end                              as length_family_source
  from t2
  where coalesce(k1, k2) is not null
$fn$;

comment on function public.derive_length_family(text, text) is
  'D-SCHED-27: deterministic length-family key. Tier 1 from a leading "-N " in the description, tier 2 from the trailing digit run when the description has no dash. Returns no row when neither applies.';

-- Gate §1: the eight canonical cases.
select v.part_number, v.description, f.length_family_key, f.length_dash, f.length_family_source
from (values
  ('SK4C4S',   '-4 Stud Stainless Slotted'),
  ('SK4-4S',   '-4 Stud Steel Slotted'),
  ('SK26C1W1', '-1 Wing Stud Stainless'),
  ('SK26-P11', '-11 Stud Steel Phillips'),
  ('SK26CS6',  '2600 Series Slotted Stud'),
  ('SK244-42', '4000 Series CLoc Platemount Insert'),
  ('SK4C11W2', '4000 SERIES - PINNED WING STUD ASSY - STAINLESS'),
  ('QL4-BASE', 'Nut Gimble')
) as v(part_number, description)
left join lateral public.derive_length_family(v.part_number, v.description) f on true
order by v.part_number;
-- Expect: SK4C4S→SK4C#S/4/rule_desc · SK4-4S→SK4-#S/4/rule_desc · SK26C1W1→SK26C#W1/1/rule_desc ·
--         SK26-P11→SK26-P#/11/rule_desc · SK26CS6→SK26CS#/6/rule_tail · SK244-42→SK244-#/42/rule_tail (struck in §4) ·
--         SK4C11W2→SK4C11W#/2/rule_tail (singleton, not seeded) · QL4-BASE→NULL


-- ───────────────────────────── §2 COLUMNS ─────────────────────────────
alter table public.parts
  add column if not exists length_family_key    text,
  add column if not exists length_dash          integer,
  add column if not exists length_family_source text
    check (length_family_source in ('rule_desc', 'rule_tail', 'manual')),
  add column if not exists length_family_set_at timestamptz;

create index if not exists parts_length_family_key_idx on public.parts (length_family_key) where length_family_key is not null;

comment on column public.parts.length_family_key is
  'D-SCHED-27 machining family: part number with the length dash masked to # (SK4C#S). Scheduling grain — identical except length. Distinct from family_key (pricing/costing). Set by derive_length_family() or manually; never overwritten by the rule once set.';
comment on column public.parts.length_dash is 'D-SCHED-27: the dash (length index) masked out of length_family_key.';
comment on column public.parts.length_family_source is 'D-SCHED-27: rule_desc | rule_tail | manual.';

-- Gate §2
select column_name, data_type from information_schema.columns
where table_schema='public' and table_name='parts' and column_name like 'length_%' order by column_name;
-- Expect 4 rows.


-- ───────────────────────────── §3 TRIGGER ─────────────────────────────
create or replace function public.parts_length_family_fill()
returns trigger
language plpgsql
as $tg$
declare
  v_key    text;
  v_dash   integer;
  v_source text;
begin
  -- Human edit: the key changed and the caller did NOT set the source in the same statement.
  -- (The seed and any rule-sourced writer set the source with the key, so they are respected.)
  if tg_op = 'UPDATE'
     and new.length_family_key is distinct from old.length_family_key
     and new.length_family_key is not null
     and new.length_family_source is not distinct from old.length_family_source then
    new.length_family_source := 'manual';
    new.length_family_set_at := now();
    return new;
  end if;

  -- A stored key is never overwritten by the rule.
  if new.length_family_key is not null then
    if new.length_family_set_at is null then
      new.length_family_set_at := now();
    end if;
    return new;
  end if;

  -- Explicit opt-out: key cleared and marked manual → "this part has no family"; the rule stays out.
  if new.length_family_source = 'manual' then
    return new;
  end if;

  -- Rule applies only to manufactured parts.
  if new.part_type is distinct from 'manufactured' then
    return new;
  end if;

  v_key    := (select f.length_family_key    from public.derive_length_family(new.part_number, new.description) f);
  v_dash   := (select f.length_dash          from public.derive_length_family(new.part_number, new.description) f);
  v_source := (select f.length_family_source from public.derive_length_family(new.part_number, new.description) f);

  if v_key is null then
    return new;
  end if;

  -- Tier 2 is only trusted when the family already exists on another part.
  if v_source = 'rule_tail'
     and not exists (select 1 from public.parts p where p.length_family_key = v_key and p.id is distinct from new.id) then
    return new;
  end if;

  new.length_family_key    := v_key;
  new.length_dash          := v_dash;
  new.length_family_source := v_source;
  new.length_family_set_at := now();
  return new;
end
$tg$;

drop trigger if exists trg_parts_length_family_fill on public.parts;
create trigger trg_parts_length_family_fill
  before insert or update of part_number, description, length_family_key
  on public.parts
  for each row execute function public.parts_length_family_fill();

-- Gate §3
select tgname, tgenabled from pg_trigger where tgrelid = 'public.parts'::regclass and tgname = 'trg_parts_length_family_fill';
-- Expect 1 row, tgenabled = 'O'.


-- ───────────────────────────── §4 SEED ─────────────────────────────
-- 4a. DRY RUN — what the seed would write. Review before 4b. Tier-2 singletons are excluded;
--     the strike list removes families whose trailing digits are not lengths.
with cand as (
  select p.id, p.part_number, p.description, p.family_key, f.length_family_key, f.length_dash, f.length_family_source
  from public.parts p
  join lateral public.derive_length_family(p.part_number, p.description) f on true
  where p.part_type = 'manufactured' and p.length_family_key is null
),
sized as (
  select c.*, count(*) over (partition by c.length_family_key) as members
  from cand c
),
would_write as (
  select * from sized
  where (length_family_source = 'rule_desc' or members >= 2)
    and length_family_key not in ('SK244-#', 'SK21077-5-#')            -- STRIKE LIST (Matt, 2026-09-22): thread sizes / insert sizes, not lengths
)
select length_family_key, length_family_source, count(*) as parts,
       min(length_dash) as min_dash, max(length_dash) as max_dash,
       string_agg(distinct coalesce(family_key, '∅'), ',') as pricing_family_keys,
       string_agg(part_number, ' ' order by length_dash, part_number) as members
from would_write
group by 1, 2 order by parts desc, 1;
-- Expect (PROD 2026-09-22): 28 families, 306 parts. SK26CS# 20 · SK4C#S 20 · SK27CP# 19 · SK4-#P 19 · SK4-#S 19 · SK4C#P 19 ·
--   SK4C# 18 · SK4C#C 18 · SK26-P# 17 · SK26CP# 15 · SK26C#W1 14 · SK27CS# 12 · ZG26-#W1 12 · SK27-P# 11 ·
--   SK26-S# 10 · SK26SFW# 10 · SK26-#W1 9 · SK26FB#SB 7 · SK35CC# 6 · SK35CS# 6 · SK27-S# 5 · SK26FB# 4 · SK28T# 4 ·
--   SK4-#W1 3 · SK4C#W1 3 · ZG26SC# 3 · SK4SFW# 2 · SK26FB#S 1 (rule_desc singleton — allowed). Nothing else.

-- 4b. GUARDED WRITE. Same predicate as 4a. Idempotent (only NULL keys are written).
do $seed$
declare
  v_before  integer;
  v_written integer;
  v_after   integer;
  v_fams    integer;
begin
  v_before := (select count(*) from public.parts where length_family_key is not null);

  with cand as (
    select p.id, f.length_family_key, f.length_dash, f.length_family_source
    from public.parts p
    join lateral public.derive_length_family(p.part_number, p.description) f on true
    where p.part_type = 'manufactured' and p.length_family_key is null
  ),
  sized as (
    select c.*, count(*) over (partition by c.length_family_key) as members from cand c
  ),
  would_write as (
    select * from sized
    where (length_family_source = 'rule_desc' or members >= 2)
      and length_family_key not in ('SK244-#', 'SK21077-5-#')
  )
  update public.parts p
     set length_family_key    = w.length_family_key,
         length_dash          = w.length_dash,
         length_family_source = w.length_family_source,
         length_family_set_at = now()
    from would_write w
   where w.id = p.id;

  get diagnostics v_written = row_count;
  v_after := (select count(*) from public.parts where length_family_key is not null);
  v_fams  := (select count(distinct length_family_key) from public.parts where length_family_key is not null);

  raise notice 'D-SCHED-27 seed: keyed before=% written=% after=% families=%', v_before, v_written, v_after, v_fams;

  if v_written = 0 and v_before = 0 then
    raise exception 'D-SCHED-27 seed wrote nothing on an empty column — rule or strike list is wrong, aborting';
  end if;
end
$seed$;

-- Gate §4
select
  (select count(*) from parts where length_family_key is not null) as keyed_parts,
  (select count(distinct length_family_key) from parts) as families,
  (select length_family_key || ' / ' || length_dash || ' / ' || length_family_source from parts where part_number = 'SK4C4S')  as sk4c4s,
  (select length_family_key || ' / ' || length_dash || ' / ' || length_family_source from parts where part_number = 'SK26CS6') as sk26cs6,
  (select coalesce(length_family_key, 'NULL') from parts where part_number = 'SK244-42') as sk244_42_expect_null,
  (select coalesce(length_family_key, 'NULL') from parts where part_number = 'SK4C11W2') as sk4c11w2_expect_null,
  (select count(*) from parts where family_key = 'SK4-S' and length_family_key in ('SK4-#S', 'SK4C#S')) as sk4_s_split_into_two_families;
-- Expect: keyed_parts 306 · families 28 · sk4c4s = SK4C#S / 4 / rule_desc · sk26cs6 = SK26CS# / 6 / rule_tail · both NULL checks = NULL · split = 39.
-- (v1.0 on TEST showed 'manual' here — that was the trigger bug fixed in v1.1; if you see 'manual' on PROD, stop.)


-- ───────────────────────────── §5 VIEWS ─────────────────────────────
-- 5a. One row per production-done run on a machine. Rate basis identical to lib/scheduling.js
--     effectiveTimePerUnit: recorded time_per_unit, else production_start → actual_end ÷ good_pieces.
--     Paper-era rows (no production_start) carry is_paper_era = true and never rate.
--     steady_rate = median parts/day over clean finishing-send intervals (18–30 h between waypoints,
--     final non-partial completion send excluded) — the D-COST-31 waypoint method.
create or replace view public.v_part_run_rates as
with runs as (
  select j.id as job_id, j.job_number, j.component_id as part_id, p.part_number,
         p.length_family_key, p.length_dash,
         j.assigned_machine_id as machine_id, m.name as machine_name, m.code as machine_code,
         m.model as machine_model, m.machine_type,
         j.status, j.quantity, j.good_pieces,
         case when j.good_pieces > 0 then j.good_pieces else j.quantity end as pieces,
         j.time_per_unit, j.production_start, j.actual_start, j.actual_end,
         (j.production_start is null) as is_paper_era,
         case when j.time_per_unit > 0 then j.time_per_unit::numeric
              when j.production_start is not null and j.actual_end > j.production_start and j.good_pieces > 0
                then (extract(epoch from (j.actual_end - j.production_start)) / 60.0) / j.good_pieces
         end as tpu_minutes,
         (j.time_per_unit is null or j.time_per_unit <= 0) as tpu_derived
  from public.jobs j
  join public.parts p on p.id = j.component_id
  join public.machines m on m.id = j.assigned_machine_id
  where j.status in ('manufacturing_complete','pending_passivation','in_passivation','pending_post_manufacturing',
                     'ready_for_outsourcing','at_external_vendor','ready_for_assembly','in_assembly',
                     'pending_tco','complete','incomplete')
    and not coalesce(j.is_maintenance, false)
    and not coalesce(j.is_standalone_finishing, false)
),
waypoints as (
  select f.job_id, f.sent_at, f.quantity::numeric as quantity, f.is_partial_send,
         lag(f.sent_at) over (partition by f.job_id order by f.sent_at) as prev_send,
         (row_number() over (partition by f.job_id order by f.sent_at desc) = 1) as is_last
  from public.finishing_sends f
  where not coalesce(f.is_standalone, false)
),
iv as (
  select w.job_id, w.quantity, w.sent_at, w.is_partial_send, w.is_last,
         extract(epoch from (w.sent_at - coalesce(w.prev_send, r.production_start))) / 3600.0 as span_h
  from waypoints w
  join runs r on r.job_id = w.job_id
),
clean as (
  select job_id,
         count(*) filter (where span_h between 18 and 30 and not (is_last and not is_partial_send)) as n_clean,
         percentile_cont(0.5) within group (order by quantity / nullif(span_h, 0) * 24.0)
           filter (where span_h between 18 and 30 and not (is_last and not is_partial_send)) as steady_rate,
         min(quantity / nullif(span_h, 0) * 24.0) filter (where span_h between 18 and 30 and not (is_last and not is_partial_send)) as steady_min,
         max(quantity / nullif(span_h, 0) * 24.0) filter (where span_h between 18 and 30 and not (is_last and not is_partial_send)) as steady_max,
         count(*) as n_sends,
         sum(quantity) as sent_total
  from iv
  group by job_id
)
select r.job_id, r.job_number, r.part_id, r.part_number, r.length_family_key, r.length_dash,
       r.machine_id, r.machine_name, r.machine_code, r.machine_model, r.machine_type,
       r.status, r.quantity, r.good_pieces, r.pieces,
       r.time_per_unit, r.tpu_minutes, r.tpu_derived, r.is_paper_era,
       (r.tpu_minutes > 0) as is_rated,
       case when r.tpu_minutes > 0 then round(1440 / r.tpu_minutes)::integer end as calendar_rate,
       round(c.steady_rate)::integer as steady_rate,
       round(c.steady_min)::integer  as steady_min,
       round(c.steady_max)::integer  as steady_max,
       coalesce(c.n_clean, 0)::integer as n_clean,
       coalesce(c.n_sends, 0)::integer as n_sends,
       c.sent_total::integer as sent_total,
       r.production_start, r.actual_start, r.actual_end
from runs r
left join clean c on c.job_id = r.job_id;

comment on view public.v_part_run_rates is
  'D-SCHED-27: one row per production-done run on a machine. calendar_rate = 1440/tpu (effectiveTimePerUnit basis); steady_rate = median clean waypoint rate (D-COST-31). Paper-era rows never rate. Read by lib/scheduling.js.';

-- 5b. Family × machine roll-up (the "FAMILY HAS RUN HERE" section and Uncle Bob's family source).
create or replace view public.v_length_family_machine_history as
select r.length_family_key,
       r.machine_id, r.machine_name, r.machine_code, r.machine_model, r.machine_type,
       count(*)::integer                                          as runs,
       count(*) filter (where r.is_rated)::integer                as rated_runs,
       count(*) filter (where r.is_paper_era)::integer            as paper_runs,
       count(distinct r.part_id)::integer                         as parts_run,
       (select array_agg(d order by d) from unnest(array_agg(distinct r.length_dash)) d) as dashes,
       sum(r.pieces)::integer                                     as pieces,
       -- piece-weighted calendar rate over rated runs — identical math to computePartsPerDaySuggestion
       round( sum(r.pieces) filter (where r.is_rated)
            / nullif(sum(r.pieces * r.tpu_minutes) filter (where r.is_rated), 0) * 1440 )::integer as calendar_rate,
       round(percentile_cont(0.5) within group (order by r.steady_rate) filter (where r.steady_rate is not null))::integer as steady_median,
       min(r.steady_rate)                                         as steady_min,
       max(r.steady_rate)                                         as steady_max,
       sum(r.n_clean)::integer                                    as n_clean,
       max(r.actual_end)                                          as last_run_at,
       jsonb_agg(jsonb_build_object(
           'dash', r.length_dash, 'part_number', r.part_number, 'job_number', r.job_number,
           'pieces', r.pieces, 'calendar_rate', r.calendar_rate, 'steady_rate', r.steady_rate,
           'is_paper_era', r.is_paper_era, 'ended_at', r.actual_end)
         order by r.length_dash, r.actual_end)                    as runs_detail
from public.v_part_run_rates r
where r.length_family_key is not null
group by r.length_family_key, r.machine_id, r.machine_name, r.machine_code, r.machine_model, r.machine_type;

comment on view public.v_length_family_machine_history is
  'D-SCHED-27: per length family × machine — runs, dashes, piece-weighted calendar rate, steady-rate range, per-run detail. Feeds ScheduleJobModal Step 1/3, Adjust End Date, and scheduleSnapshot.';

-- 5c. Observed material per family (what bar the family has actually been loaded with — link 4).
create or replace view public.v_length_family_material as
with loads as (
  select p.length_family_key, jm.material_type, jm.bar_size,
         count(distinct jm.job_id) as loads, coalesce(sum(jm.bars_loaded), 0)::integer as bars
  from public.job_materials jm
  join public.jobs j  on j.id = jm.job_id
  join public.parts p on p.id = j.component_id
  where p.length_family_key is not null and jm.material_type is not null and jm.bar_size is not null
  group by p.length_family_key, jm.material_type, jm.bar_size
)
select length_family_key, material_type, bar_size, loads::integer as loads, bars,
       round(100.0 * loads / sum(loads) over (partition by length_family_key))::integer as share_pct,
       (row_number() over (partition by length_family_key order by loads desc, bars desc) = 1) as is_primary
from loads;

-- 5d. Observed material per part (parts without a family still get the link).
create or replace view public.v_part_observed_material as
with loads as (
  select j.component_id as part_id, p.part_number, jm.material_type, jm.bar_size,
         count(distinct jm.job_id) as loads, coalesce(sum(jm.bars_loaded), 0)::integer as bars
  from public.job_materials jm
  join public.jobs j  on j.id = jm.job_id
  join public.parts p on p.id = j.component_id
  where jm.material_type is not null and jm.bar_size is not null
  group by j.component_id, p.part_number, jm.material_type, jm.bar_size
)
select part_id, part_number, material_type, bar_size, loads::integer as loads, bars,
       round(100.0 * loads / sum(loads) over (partition by part_id))::integer as share_pct,
       (row_number() over (partition by part_id order by loads desc, bars desc) = 1) as is_primary
from loads;

-- 5e. First-run flag per job (link 6). Prior = a production-done, machine-assigned run of the same
--     part / same family that STARTED before this job's own anchor (production_start, else
--     scheduled_start, else created_at). Paper-era runs count as prior runs — they prove the part ran.
--     first_run_kind: 'part_and_family' (nothing in the part or its family has run; also parts with
--     no family) · 'part' (this length has not run, but family members have) · NULL otherwise.
create or replace view public.v_job_first_run as
select j.id as job_id, j.job_number, j.status, j.component_id as part_id, p.part_number,
       p.length_family_key, p.length_dash,
       j.assigned_machine_id as machine_id, j.scheduled_start, j.production_start,
       coalesce(j.production_start, j.scheduled_start, j.created_at) as anchor_at,
       pr.prior_part_runs, fr.prior_family_runs,
       case when pr.prior_part_runs = 0 and coalesce(fr.prior_family_runs, 0) = 0 then 'part_and_family'
            when pr.prior_part_runs = 0                                           then 'part'
       end as first_run_kind
from public.jobs j
join public.parts p on p.id = j.component_id
cross join lateral (
  select count(*)::integer as prior_part_runs
  from public.jobs pj
  where pj.component_id = j.component_id and pj.id <> j.id
    and pj.assigned_machine_id is not null
    and pj.status in ('manufacturing_complete','pending_passivation','in_passivation','pending_post_manufacturing',
                      'ready_for_outsourcing','at_external_vendor','ready_for_assembly','in_assembly',
                      'pending_tco','complete','incomplete')
    and coalesce(pj.production_start, pj.actual_start, pj.scheduled_start) < coalesce(j.production_start, j.scheduled_start, j.created_at)
) pr
cross join lateral (
  select count(*)::integer as prior_family_runs
  from public.jobs pj
  join public.parts pp on pp.id = pj.component_id
  where p.length_family_key is not null
    and pp.length_family_key = p.length_family_key
    and pj.component_id <> j.component_id
    and pj.assigned_machine_id is not null
    and pj.status in ('manufacturing_complete','pending_passivation','in_passivation','pending_post_manufacturing',
                      'ready_for_outsourcing','at_external_vendor','ready_for_assembly','in_assembly',
                      'pending_tco','complete','incomplete')
    and coalesce(pj.production_start, pj.actual_start, pj.scheduled_start) < coalesce(j.production_start, j.scheduled_start, j.created_at)
) fr
where not coalesce(j.is_maintenance, false)
  and not coalesce(j.is_standalone_finishing, false);

comment on view public.v_job_first_run is
  'D-SCHED-27: first_run_kind per job — part_and_family / part / NULL — judged against runs that started before the job''s own anchor. Read by ScheduleJobModal, Kiosk, ProductionDisplay.';

-- Gate §5
select
  (select count(*) from v_part_run_rates) as run_rows,
  (select count(*) from v_part_run_rates where is_rated) as rated_rows,
  (select count(*) from v_part_run_rates where is_paper_era) as paper_rows,
  (select string_agg(machine_code || ':' || runs || 'r/' || coalesce(calendar_rate::text,'-') || 'c/' || coalesce(steady_median::text,'-') || 's', ' ' order by machine_code)
     from v_length_family_machine_history where length_family_key = 'SK4C#S') as sk4c_s_by_machine,
  (select material_type || ' ' || bar_size || ' (' || share_pct || '%)' from v_length_family_material where length_family_key = 'SK4C#S' and is_primary) as sk4c_s_material,
  (select count(*) from v_job_first_run where first_run_kind is not null and status in ('assigned','in_setup','in_progress')) as flagged_first_runs_on_board,
  (select first_run_kind from v_job_first_run where job_number = 'J-000273') as j273_expect_null;
-- Expect (PROD 2026-09-22): run_rows 185 · rated 149 · paper 28 · sk4c_s_by_machine = "MZ-1:1r/-c/-s NT-4:8r/433c/596s NT-7:6r/536c/836s";
--   sk4c_s_material = "303 Stainless Steel 0.375 dia (100%)"; j273 NULL (SK26CS6 ran in May).


-- ───────────────────────────── §6 part_machine_stats REPAIR ─────────────────────────────
-- D-AISCHED-01 keyed on actual_start, which the kiosk never writes (it writes production_start),
-- so the view saw 21 of 184 production-done runs. Same output columns → CREATE OR REPLACE;
-- family_machine_stats (dependent) keeps working. Pieces basis aligned to the app helper.
create or replace view public.part_machine_stats as
with runs as (
  select j.id,
         j.component_id as part_id,
         j.assigned_machine_id as machine_id,
         case when j.good_pieces > 0 then j.good_pieces else j.quantity end as quantity,
         j.estimated_minutes,
         extract(epoch from j.actual_end - coalesce(j.production_start, j.actual_start)) / 60.0 as actual_minutes,
         case when j.setup_start is not null and coalesce(j.production_start, j.actual_start) > j.setup_start
              then extract(epoch from coalesce(j.production_start, j.actual_start) - j.setup_start) / 60.0
              else null::numeric end as setup_minutes,
         j.actual_end
  from public.jobs j
  where j.component_id is not null
    and j.assigned_machine_id is not null
    and coalesce(j.production_start, j.actual_start) is not null
    and j.actual_end is not null
    and j.actual_end > coalesce(j.production_start, j.actual_start)
    and j.status::text <> all (array['cancelled'::text, 'merged'::text])
    and extract(epoch from j.actual_end - coalesce(j.production_start, j.actual_start)) >= 300
    and extract(epoch from j.actual_end - coalesce(j.production_start, j.actual_start)) <= (60 * 60 * 24 * 30)
    and j.quantity > 0
)
select r.part_id,
       p.part_number,
       r.machine_id,
       m.name as machine_name,
       m.code as machine_code,
       count(*) as completed_runs,
       sum(r.quantity) as total_qty,
       round(sum(r.quantity)::numeric / nullif(sum(r.actual_minutes) / 60.0, 0::numeric), 2) as actual_pcs_per_hour,
       round(avg(r.actual_minutes), 1) as avg_actual_minutes,
       round(avg(r.setup_minutes), 1) as avg_setup_minutes,
       round(avg((r.actual_minutes - r.estimated_minutes::numeric) / nullif(r.estimated_minutes, 0)::numeric) filter (where r.estimated_minutes > 0), 3) as est_vs_actual_drift,
       max(r.actual_end) as last_run_at,
       coalesce(mp.missed_qty, 0::bigint) as missed_qty
from runs r
join public.parts p on p.id = r.part_id
join public.machines m on m.id = r.machine_id
left join lateral (
  select sum(e.quantity) as missed_qty
  from public.missed_production_entries e
  join public.jobs j2 on j2.id = e.job_id
  where j2.component_id = r.part_id and j2.assigned_machine_id = r.machine_id
) mp on true
group by r.part_id, p.part_number, r.machine_id, m.name, m.code, mp.missed_qty;

-- Gate §6
select (select sum(completed_runs) from part_machine_stats) as runs_visible_now,
       (select count(*) from part_machine_stats) as part_machine_rows,
       (select string_agg(machine_code || ':' || completed_runs, ' ' order by machine_code) from part_machine_stats where part_number = 'SK4C4S') as sk4c4s_stats,
       (select count(*) from family_machine_stats) as legacy_family_rows;
-- Expect (PROD 2026-09-22): runs_visible_now = 167 across 139 part×machine rows (was 21 / 20); sk4c4s_stats = "NT-4:1".


-- ───────────────────────────── §7 GRANTS ─────────────────────────────
-- New views inherit Supabase's default privileges (ALL for anon/authenticated/service_role): revoke first, then grant SELECT.
revoke all on public.v_part_run_rates, public.v_length_family_machine_history, public.v_length_family_material,
               public.v_part_observed_material, public.v_job_first_run from authenticated, anon, public;
grant select on public.v_part_run_rates, public.v_length_family_machine_history, public.v_length_family_material,
                public.v_part_observed_material, public.v_job_first_run to authenticated;
grant execute on function public.derive_length_family(text, text) to authenticated;
revoke execute on function public.derive_length_family(text, text) from anon, public;

-- Gate §7
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privs
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('v_part_run_rates','v_length_family_machine_history','v_length_family_material','v_part_observed_material','v_job_first_run')
  and grantee in ('authenticated', 'anon')
group by 1, 2 order by 1, 2;
-- Expect exactly five rows, all authenticated / SELECT. No anon rows.


-- ───────────────────────────── §8 END-STATE SNAPSHOT ─────────────────────────────
select 'parts keyed'                as metric, count(*)::text as value from parts where length_family_key is not null
union all select 'families',        count(distinct length_family_key)::text from parts
union all select 'rule_desc / rule_tail / manual (PROD expect 198 / 108 / 0)',
          (count(*) filter (where length_family_source='rule_desc'))::text || ' / ' ||
          (count(*) filter (where length_family_source='rule_tail'))::text || ' / ' ||
          (count(*) filter (where length_family_source='manual'))::text from parts
union all select 'v_part_run_rates rows (rated)', count(*)::text || ' (' || (count(*) filter (where is_rated))::text || ')' from v_part_run_rates
union all select 'v_length_family_machine_history rows', count(*)::text from v_length_family_machine_history
union all select 'v_length_family_material families', count(distinct length_family_key)::text from v_length_family_material
union all select 'first runs flagged on the board', count(*)::text from v_job_first_run where first_run_kind is not null and status in ('assigned','in_setup','in_progress')
union all select 'part_machine_stats runs visible', sum(completed_runs)::text from part_machine_stats;


-- ───────────────────────────── ROLLBACK (manual, if ever needed) ─────────────────────────────
-- drop view if exists public.v_job_first_run, public.v_part_observed_material, public.v_length_family_material,
--                     public.v_length_family_machine_history, public.v_part_run_rates;
-- drop trigger if exists trg_parts_length_family_fill on public.parts;
-- drop function if exists public.parts_length_family_fill();
-- drop function if exists public.derive_length_family(text, text);
-- alter table public.parts drop column if exists length_family_key, drop column if exists length_dash,
--                          drop column if exists length_family_source, drop column if exists length_family_set_at;
-- part_machine_stats: re-apply the D-AISCHED-01 definition from Docs/migrations/2026-08-15_ai_scheduler_phase1.sql.
