/* 2026-10-28_D-HIST-02_archive_in_run_history.sql
   D-HIST-02: the traveler archive (public.historical_runs, D-HIST-01) joins the run evidence the
   scheduler already reads. Views only; no table changes. TEST first, then the identical file on PROD.
   Safe to re-run.

   1. v_part_run_rates (the D-SCHED-27 single history source) gains archive rows through UNION ALL,
      and a new last column, source = 'skynet' | 'archive'. Archive rows are paper-era and never rated
      (no hours on a traveler), so they add "has run here" evidence and never touch a rate or a
      duration suggestion. Only archive rows with a quantity, a SkyNet part, a specific machine,
      review_status 'ok' and no SkyNet twin (skynet_job_id) are included. The SkyNet branch is
      unchanged column for column.
   2. v_length_family_machine_history: runs_detail entries carry source, and a new last column,
      archive_runs, counts the traveler runs inside runs/paper_runs.
   3. v_job_first_run: prior_part_runs and prior_family_runs also count archive runs dated before the
      job's anchor, so a part made before SkyNet is no longer flagged as a first run. Archive runs on
      an unnumbered machine count here (the part was made; the machine does not matter for this flag).
      New last columns archive_part_runs, archive_family_runs.
   Block comments only (SQL Editor). */

/* Fingerprint of the SkyNet rows before the change, to prove they come through untouched. */
drop table if exists pg_temp._dhist02_before;
create temp table _dhist02_before as
select count(*) as n,
       md5(string_agg(md5(row(r.job_id, r.job_number, r.part_id, r.part_number, r.length_family_key, r.length_dash, r.machine_id, r.machine_name, r.machine_code, r.machine_model, r.machine_type, r.status, r.quantity, r.good_pieces, r.pieces, r.time_per_unit, r.tpu_minutes, r.tpu_derived, r.is_paper_era, r.is_rated, r.calendar_rate, r.steady_rate, r.steady_min, r.steady_max, r.n_clean, r.n_sends, r.sent_total, r.production_start, r.actual_start, r.actual_end)::text), '' order by md5(row(r.job_id, r.job_number, r.part_id, r.part_number, r.length_family_key, r.length_dash, r.machine_id, r.machine_name, r.machine_code, r.machine_model, r.machine_type, r.status, r.quantity, r.good_pieces, r.pieces, r.time_per_unit, r.tpu_minutes, r.tpu_derived, r.is_paper_era, r.is_rated, r.calendar_rate, r.steady_rate, r.steady_min, r.steady_max, r.n_clean, r.n_sends, r.sent_total, r.production_start, r.actual_start, r.actual_end)::text) collate "C")) as fp
  from public.v_part_run_rates r
 where r.job_id is not null;

create or replace view public.v_part_run_rates as
with runs as (
  select j.id as job_id,
         j.job_number,
         j.component_id as part_id,
         p.part_number,
         p.length_family_key,
         p.length_dash,
         j.assigned_machine_id as machine_id,
         m.name as machine_name,
         m.code as machine_code,
         m.model as machine_model,
         m.machine_type,
         j.status,
         j.quantity,
         j.good_pieces,
         case when j.good_pieces > 0 then j.good_pieces else j.quantity end as pieces,
         j.time_per_unit,
         j.production_start,
         j.actual_start,
         j.actual_end,
         j.production_start is null as is_paper_era,
         case
           when j.time_per_unit > 0::numeric then j.time_per_unit::numeric
           when j.production_start is not null and j.actual_end > j.production_start and j.good_pieces > 0
             then extract(epoch from j.actual_end - j.production_start) / 60.0 / j.good_pieces::numeric
           else null::numeric
         end as tpu_minutes,
         j.time_per_unit is null or j.time_per_unit <= 0::numeric as tpu_derived,
         coalesce((j.actual_end - j.production_start) < '01:00:00'::interval, false) as is_short_run
    from jobs j
    join parts p on p.id = j.component_id
    join machines m on m.id = j.assigned_machine_id
   where j.status::text = any (array['manufacturing_complete', 'pending_passivation', 'in_passivation',
                                     'pending_post_manufacturing', 'ready_for_outsourcing', 'at_external_vendor',
                                     'ready_for_assembly', 'in_assembly', 'pending_tco', 'complete', 'incomplete']::text[])
     and not coalesce(j.is_maintenance, false)
     and not coalesce(j.is_standalone_finishing, false)
), waypoints as (
  select f.job_id,
         f.sent_at,
         f.quantity::numeric as quantity,
         f.is_partial_send,
         lag(f.sent_at) over (partition by f.job_id order by f.sent_at) as prev_send,
         row_number() over (partition by f.job_id order by f.sent_at desc) = 1 as is_last
    from finishing_sends f
   where not coalesce(f.is_standalone, false)
), iv as (
  select w.job_id,
         w.quantity,
         w.sent_at,
         w.is_partial_send,
         w.is_last,
         extract(epoch from w.sent_at - coalesce(w.prev_send, r_1.production_start)) / 3600.0 as span_h
    from waypoints w
    join runs r_1 on r_1.job_id = w.job_id
), clean as (
  select iv.job_id,
         count(*) filter (where iv.span_h >= 18::numeric and iv.span_h <= 30::numeric
                            and not (iv.is_last and not iv.is_partial_send)) as n_clean,
         percentile_cont(0.5::double precision) within group
           (order by ((iv.quantity / nullif(iv.span_h, 0::numeric) * 24.0)::double precision))
           filter (where iv.span_h >= 18::numeric and iv.span_h <= 30::numeric
                     and not (iv.is_last and not iv.is_partial_send)) as steady_rate,
         min(iv.quantity / nullif(iv.span_h, 0::numeric) * 24.0)
           filter (where iv.span_h >= 18::numeric and iv.span_h <= 30::numeric
                     and not (iv.is_last and not iv.is_partial_send)) as steady_min,
         max(iv.quantity / nullif(iv.span_h, 0::numeric) * 24.0)
           filter (where iv.span_h >= 18::numeric and iv.span_h <= 30::numeric
                     and not (iv.is_last and not iv.is_partial_send)) as steady_max,
         count(*) as n_sends,
         sum(iv.quantity) as sent_total
    from iv
   group by iv.job_id
)
select r.job_id,
       r.job_number,
       r.part_id,
       r.part_number,
       r.length_family_key,
       r.length_dash,
       r.machine_id,
       r.machine_name,
       r.machine_code,
       r.machine_model,
       r.machine_type,
       r.status,
       r.quantity,
       r.good_pieces,
       r.pieces,
       r.time_per_unit,
       r.tpu_minutes,
       r.tpu_derived,
       r.is_paper_era,
       r.tpu_minutes > 0::numeric and not r.is_short_run as is_rated,
       case
         when r.tpu_minutes > 0::numeric and not r.is_short_run then round(1440::numeric / r.tpu_minutes)::integer
         else null::integer
       end as calendar_rate,
       round(c.steady_rate)::integer as steady_rate,
       round(c.steady_min)::integer as steady_min,
       round(c.steady_max)::integer as steady_max,
       coalesce(c.n_clean, 0::bigint)::integer as n_clean,
       coalesce(c.n_sends, 0::bigint)::integer as n_sends,
       c.sent_total::integer as sent_total,
       r.production_start,
       r.actual_start,
       r.actual_end,
       'skynet'::text as source
  from runs r
  left join clean c on c.job_id = r.job_id
union all
/* D-HIST-02: traveler archive runs. Paper-era, never rated. */
select null::uuid as job_id,
       ('TRV ' || coalesce(h.order_number, '?'))::character varying(50) as job_number,
       h.part_id,
       p.part_number,
       p.length_family_key,
       p.length_dash,
       h.machine_id,
       m.name as machine_name,
       m.code as machine_code,
       m.model as machine_model,
       m.machine_type,
       'archive'::character varying(30) as status,
       h.qty_produced as quantity,
       h.qty_produced as good_pieces,
       h.qty_produced as pieces,
       null::numeric(10,2) as time_per_unit,
       null::numeric as tpu_minutes,
       false as tpu_derived,
       true as is_paper_era,
       false as is_rated,
       null::integer as calendar_rate,
       null::integer as steady_rate,
       null::integer as steady_min,
       null::integer as steady_max,
       0 as n_clean,
       0 as n_sends,
       null::integer as sent_total,
       null::timestamptz as production_start,
       null::timestamptz as actual_start,
       ((coalesce(h.run_date, h.lot_date) + time '12:00') at time zone 'America/New_York') as actual_end,
       'archive'::text as source
  from historical_runs h
  join parts p on p.id = h.part_id
  join machines m on m.id = h.machine_id
 where h.review_status = 'ok'
   and h.skynet_job_id is null
   and coalesce(h.qty_produced, 0) > 0;

create or replace view public.v_length_family_machine_history as
select length_family_key,
       machine_id,
       machine_name,
       machine_code,
       machine_model,
       machine_type,
       count(*)::integer as runs,
       count(*) filter (where is_rated)::integer as rated_runs,
       count(*) filter (where is_paper_era)::integer as paper_runs,
       count(distinct part_id)::integer as parts_run,
       (select array_agg(d.d order by d.d) as array_agg
          from unnest(array_agg(distinct r.length_dash)) d(d)) as dashes,
       sum(pieces)::integer as pieces,
       round(sum(pieces) filter (where is_rated)::numeric
             / nullif(sum(pieces::numeric * tpu_minutes) filter (where is_rated), 0::numeric) * 1440::numeric)::integer as calendar_rate,
       round(percentile_cont(0.5::double precision) within group (order by (steady_rate::double precision))
             filter (where steady_rate is not null))::integer as steady_median,
       min(steady_rate) as steady_min,
       max(steady_rate) as steady_max,
       sum(n_clean)::integer as n_clean,
       max(actual_end) as last_run_at,
       jsonb_agg(jsonb_build_object('dash', length_dash, 'part_number', part_number, 'job_number', job_number,
                                    'pieces', pieces, 'calendar_rate', calendar_rate, 'steady_rate', steady_rate,
                                    'is_paper_era', is_paper_era, 'ended_at', actual_end, 'source', source)
                 order by length_dash, actual_end) as runs_detail,
       count(*) filter (where source = 'archive')::integer as archive_runs
  from v_part_run_rates r
 where length_family_key is not null
 group by length_family_key, machine_id, machine_name, machine_code, machine_model, machine_type;

create or replace view public.v_job_first_run as
select j.id as job_id,
       j.job_number,
       j.status,
       j.component_id as part_id,
       p.part_number,
       p.length_family_key,
       p.length_dash,
       j.assigned_machine_id as machine_id,
       j.scheduled_start,
       j.production_start,
       coalesce(j.production_start, j.scheduled_start, j.created_at) as anchor_at,
       pr.prior_part_runs + ar.n as prior_part_runs,
       fr.prior_family_runs + af.n as prior_family_runs,
       case
         when pr.prior_part_runs + ar.n = 0 and coalesce(fr.prior_family_runs + af.n, 0) = 0 then 'part_and_family'::text
         when pr.prior_part_runs + ar.n = 0 then 'part'::text
         else null::text
       end as first_run_kind,
       ar.n as archive_part_runs,
       af.n as archive_family_runs
  from jobs j
  join parts p on p.id = j.component_id
  cross join lateral (
    select count(*)::integer as prior_part_runs
      from jobs pj
     where pj.component_id = j.component_id
       and pj.id <> j.id
       and pj.assigned_machine_id is not null
       and pj.status::text = any (array['manufacturing_complete', 'pending_passivation', 'in_passivation',
                                        'pending_post_manufacturing', 'ready_for_outsourcing', 'at_external_vendor',
                                        'ready_for_assembly', 'in_assembly', 'pending_tco', 'complete', 'incomplete']::text[])
       and coalesce(pj.production_start, pj.actual_start, pj.scheduled_start)
           < coalesce(j.production_start, j.scheduled_start, j.created_at)) pr
  cross join lateral (
    select count(*)::integer as prior_family_runs
      from jobs pj
      join parts pp on pp.id = pj.component_id
     where p.length_family_key is not null
       and pp.length_family_key = p.length_family_key
       and pj.component_id <> j.component_id
       and pj.assigned_machine_id is not null
       and pj.status::text = any (array['manufacturing_complete', 'pending_passivation', 'in_passivation',
                                        'pending_post_manufacturing', 'ready_for_outsourcing', 'at_external_vendor',
                                        'ready_for_assembly', 'in_assembly', 'pending_tco', 'complete', 'incomplete']::text[])
       and coalesce(pj.production_start, pj.actual_start, pj.scheduled_start)
           < coalesce(j.production_start, j.scheduled_start, j.created_at)) fr
  /* D-HIST-02: traveler runs of this part, and of the rest of its length family, before the job's anchor */
  cross join lateral (
    select count(*)::integer as n
      from historical_runs h
     where h.part_id = j.component_id
       and h.review_status = 'ok'
       and h.skynet_job_id is null
       and coalesce(h.qty_produced, 0) > 0
       and coalesce(h.run_date, h.lot_date)
           < (coalesce(j.production_start, j.scheduled_start, j.created_at) at time zone 'America/New_York')::date) ar
  cross join lateral (
    select count(*)::integer as n
      from historical_runs h
      join parts hp on hp.id = h.part_id
     where p.length_family_key is not null
       and hp.length_family_key = p.length_family_key
       and h.part_id <> j.component_id
       and h.review_status = 'ok'
       and h.skynet_job_id is null
       and coalesce(h.qty_produced, 0) > 0
       and coalesce(h.run_date, h.lot_date)
           < (coalesce(j.production_start, j.scheduled_start, j.created_at) at time zone 'America/New_York')::date) af
 where not coalesce(j.is_maintenance, false)
   and not coalesce(j.is_standalone_finishing, false);

/* VERIFY (one row). skynet_rows_unchanged must be true. Expected on PROD (2026-10-28 baseline):
   skynet_runs 285 (more if jobs completed since), archive_runs 1242, first_run_flagged well below
   today's 243 of 415 jobs. TEST 2026-10-28: 201 SkyNet rows unchanged, 1233 archive rows,
   738 archive runs in family history, first runs flagged 218 -> 33 of 347 jobs. */
select (select count(*) from public.v_part_run_rates where source = 'skynet')                  as skynet_runs,
       (select n from _dhist02_before) = (select count(*) from public.v_part_run_rates r where r.job_id is not null)
         and (select fp from _dhist02_before) = (select md5(string_agg(md5(row(r.job_id, r.job_number, r.part_id, r.part_number, r.length_family_key, r.length_dash, r.machine_id, r.machine_name, r.machine_code, r.machine_model, r.machine_type, r.status, r.quantity, r.good_pieces, r.pieces, r.time_per_unit, r.tpu_minutes, r.tpu_derived, r.is_paper_era, r.is_rated, r.calendar_rate, r.steady_rate, r.steady_min, r.steady_max, r.n_clean, r.n_sends, r.sent_total, r.production_start, r.actual_start, r.actual_end)::text), '' order by md5(row(r.job_id, r.job_number, r.part_id, r.part_number, r.length_family_key, r.length_dash, r.machine_id, r.machine_name, r.machine_code, r.machine_model, r.machine_type, r.status, r.quantity, r.good_pieces, r.pieces, r.time_per_unit, r.tpu_minutes, r.tpu_derived, r.is_paper_era, r.is_rated, r.calendar_rate, r.steady_rate, r.steady_min, r.steady_max, r.n_clean, r.n_sends, r.sent_total, r.production_start, r.actual_start, r.actual_end)::text) collate "C")) from public.v_part_run_rates r where r.job_id is not null)
                                                                                               as skynet_rows_unchanged,
       (select count(*) from public.v_part_run_rates where source = 'archive')                 as archive_runs,
       (select coalesce(sum(archive_runs), 0) from public.v_length_family_machine_history)     as family_archive_runs,
       (select count(*) from public.v_job_first_run)                                           as jobs,
       (select count(*) from public.v_job_first_run where first_run_kind is not null)          as first_run_flagged;
