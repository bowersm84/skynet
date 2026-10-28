/* ===========================================================================
   2026-10-27_D-SCHED-31_mz5_resequence.sql
   SkyNet MES - Mazak 5 (MZ-5) queue re-sequence behind J-000393

   WHY
     J-000393 (SK-T26T, 234 pcs, lot 2644) was created at 9:51 AM by the lot-change
     split of J-000272. split_job_lot_change copied J-000272's planned end (Oct 22,
     already past), so J-000393 has start Oct 27 9:51 AM, end Oct 22, 1 minute.
     Adjust End Date cannot fix it: getMachineQueue sorts by scheduled_start, so the
     two jobs still waiting on stale slots (J-000341 Oct 24-26, J-000363 Oct 26-30)
     sit AHEAD of J-000393 in the queue, the cascade never moves them, and the new
     J-000393 window collides with J-000363 -> jobs_no_machine_overlap.

   WHAT (one transaction, through the app's own change_end_with_cascade RPC)
     J-000393  ends at v_end below (default Fri Oct 30, 5:00 PM EDT: 234 pcs at the
               312-in-95.8-h pace J-000272 actually ran on this part, +10% buffer).
     Then, back to back, each keeping its estimated_minutes and the existing order:
       J-000341 (SK4C5W1, 2,460 min) -> J-000363 (SK26C8W1, 6,659) ->
       J-000367 (SK4-7W1, 3,660)     -> J-000335 (SK26-8W1, 2,520)
     Status, machine, compliance untouched. One audit_logs row, marker D-SCHED-31.

   HOW TO RUN (Supabase SQL Editor, RLS toggle OFF, one block at a time)
     1. PREVIEW -> five rows (current and proposed windows, ET); expect preview_ok = true on every row
     2. APPLY   -> one DO block; raises and changes nothing if any guard fails
     3. VERIFY  -> one row, expect verify_ok = true
   To use a different end for J-000393, change v_end in PREVIEW and APPLY (same value).
   =========================================================================== */


/* ---------------------------------------------------------------------------
   1. PREVIEW (read-only). Times shown in America/New_York.
   --------------------------------------------------------------------------- */
with p as (select timestamptz '2026-10-30 17:00 America/New_York' as v_end),
q(seq, job_number, exp_status, exp_start, exp_end, exp_minutes) as (values
  (0, 'J-000393', 'in_progress', timestamptz '2026-10-27 13:51:12+00', timestamptz '2026-10-22 14:08:34+00', 1),
  (1, 'J-000341', 'assigned',    timestamptz '2026-10-24 07:08:34+00', timestamptz '2026-10-26 00:08:34+00', 2460),
  (2, 'J-000363', 'assigned',    timestamptz '2026-10-26 00:08:34+00', timestamptz '2026-10-30 15:08:00+00', 6659),
  (3, 'J-000367', 'assigned',    timestamptz '2026-10-30 15:08:00+00', timestamptz '2026-11-02 04:08:00+00', 3660),
  (4, 'J-000335', 'assigned',    timestamptz '2026-11-02 04:08:00+00', timestamptz '2026-11-03 22:08:00+00', 2520)
),
cur as (
  select q.*, j.status, j.scheduled_start, j.scheduled_end, j.estimated_minutes, m.code,
         w.due_date
    from q join jobs j on j.job_number = q.job_number
    left join machines m on m.id = j.assigned_machine_id
    left join work_orders w on w.id = j.work_order_id
)
select c.seq, c.job_number, c.code, c.status, c.estimated_minutes,
       to_char(c.scheduled_start at time zone 'America/New_York', 'Dy Mon DD HH12:MI AM') as now_start,
       to_char(c.scheduled_end   at time zone 'America/New_York', 'Dy Mon DD HH12:MI AM') as now_end,
       to_char(case when c.seq = 0 then c.scheduled_start
                    else (select v_end from p) + make_interval(mins => coalesce((select sum(x.exp_minutes) from q x where x.seq between 1 and c.seq - 1), 0)::int)
               end at time zone 'America/New_York', 'Dy Mon DD HH12:MI AM')       as new_start,
       to_char(case when c.seq = 0 then (select v_end from p)
                    else (select v_end from p) + make_interval(mins => (select sum(x.exp_minutes) from q x where x.seq between 1 and c.seq)::int)
               end at time zone 'America/New_York', 'Dy Mon DD HH12:MI AM')       as new_end,
       c.due_date,
       (    c.code = 'MZ-5'
        and c.status = c.exp_status
        and c.scheduled_start = c.exp_start
        and c.scheduled_end   = c.exp_end
        and c.estimated_minutes = c.exp_minutes
        and (select count(*) from jobs j2
              where j2.assigned_machine_id = (select id from machines where code = 'MZ-5')
                and j2.status in ('ready','assigned','pending_compliance','in_setup','in_progress')
                and j2.job_number not in (select job_number from q)
                and j2.scheduled_end > timestamptz '2026-10-27 13:51:12+00') = 0
       ) as preview_ok
  from cur c
 order by c.seq;


/* ---------------------------------------------------------------------------
   2. APPLY
   --------------------------------------------------------------------------- */
do $$
declare
  v_end      timestamptz := timestamptz '2026-10-30 17:00 America/New_York';   /* J-000393 end - keep equal to PREVIEW */
  v_marker   text := 'D-SCHED-31';
  v_file     text := '2026-10-27_D-SCHED-31_mz5_resequence.sql';
  v_mz5      uuid;
  v_actor    uuid;
  v_393      jobs%rowtype;
  v_before   jsonb;
  v_cursor   timestamptz;
  v_cascade  jsonb := '[]'::jsonb;
  v_minutes  integer;
  v_open     integer;
  r          record;
begin
  v_mz5 := (select id from machines where code = 'MZ-5');
  if v_mz5 is null then raise exception 'D-SCHED-31: machine MZ-5 not found'; end if;

  v_actor := coalesce(
    (select p.id from profiles p where p.username = 'mbowers' and p.role = 'admin'),
    (select p.id from profiles p where p.username = 'mabowers84'));
  if v_actor is null then raise exception 'D-SCHED-31: actor profile not found'; end if;

  /* from J-000393's start on, the MZ-5 queue must be exactly these five jobs */
  v_open := (select count(*) from jobs
              where assigned_machine_id = v_mz5
                and status in ('ready','assigned','pending_compliance','in_setup','in_progress')
                and job_number not in ('J-000393','J-000341','J-000363','J-000367','J-000335')
                and scheduled_end > timestamptz '2026-10-27 13:51:12+00');
  if v_open <> 0 then raise exception 'D-SCHED-31: % other open job(s) on MZ-5 from Oct 27 on - nothing changed', v_open; end if;

  for r in
    select q.*, j.id as job_id, j.status, j.scheduled_start, j.scheduled_end, j.estimated_minutes, j.assigned_machine_id
      from (values
        (0, 'J-000393', 'in_progress', timestamptz '2026-10-27 13:51:12+00', timestamptz '2026-10-22 14:08:34+00', 1),
        (1, 'J-000341', 'assigned',    timestamptz '2026-10-24 07:08:34+00', timestamptz '2026-10-26 00:08:34+00', 2460),
        (2, 'J-000363', 'assigned',    timestamptz '2026-10-26 00:08:34+00', timestamptz '2026-10-30 15:08:00+00', 6659),
        (3, 'J-000367', 'assigned',    timestamptz '2026-10-30 15:08:00+00', timestamptz '2026-11-02 04:08:00+00', 3660),
        (4, 'J-000335', 'assigned',    timestamptz '2026-11-02 04:08:00+00', timestamptz '2026-11-03 22:08:00+00', 2520)
      ) as q(seq, job_number, exp_status, exp_start, exp_end, exp_minutes)
      left join jobs j on j.job_number = q.job_number
     order by q.seq
  loop
    if r.job_id is null then raise exception 'D-SCHED-31: % not found', r.job_number; end if;
    if r.assigned_machine_id is distinct from v_mz5
       or r.status is distinct from r.exp_status
       or r.scheduled_start is distinct from r.exp_start
       or r.scheduled_end is distinct from r.exp_end
       or r.estimated_minutes is distinct from r.exp_minutes then
      raise exception 'D-SCHED-31: % not in expected state (status %, start %, end %, minutes %)',
        r.job_number, r.status, r.scheduled_start, r.scheduled_end, r.estimated_minutes;
    end if;
  end loop;

  v_393 := (select j from jobs j where j.job_number = 'J-000393' for update);
  if v_end <= greatest(v_393.scheduled_start, now()) then
    raise exception 'D-SCHED-31: v_end % must be after J-000393 start and after now', v_end;
  end if;

  v_before := (select jsonb_agg(jsonb_build_object('job_number', j.job_number, 'scheduled_start', j.scheduled_start,
                                                   'scheduled_end', j.scheduled_end, 'estimated_minutes', j.estimated_minutes)
                                order by j.scheduled_start)
                 from jobs j
                where j.job_number in ('J-000393','J-000341','J-000363','J-000367','J-000335'));

  /* back-to-back chain behind J-000393, keeping each job's estimated_minutes */
  v_cursor := v_end;
  for r in
    select j.id, j.job_number, j.estimated_minutes
      from (values (1, 'J-000341'), (2, 'J-000363'), (3, 'J-000367'), (4, 'J-000335')) as o(seq, job_number)
      join jobs j on j.job_number = o.job_number
     order by o.seq
  loop
    v_cascade := v_cascade || jsonb_build_object(
      'job_id',    r.id,
      'new_start', v_cursor,
      'new_end',   v_cursor + make_interval(mins => r.estimated_minutes));
    v_cursor := v_cursor + make_interval(mins => r.estimated_minutes);
  end loop;

  v_minutes := greatest(1, round(extract(epoch from (v_end - v_393.scheduled_start)) / 60.0))::integer;

  /* the app's own write path: cascade first, then the target end + minutes (constraint deferred) */
  perform public.change_end_with_cascade(v_393.id, v_end, v_minutes, v_cascade);

  insert into audit_logs (event_type, job_id, operator_id, details) values
  ('schedule_resequenced_by_sql', v_393.id, v_actor, jsonb_build_object(
      'machine', 'MZ-5', 'target', 'J-000393', 'new_end', v_end, 'new_minutes', v_minutes,
      'order', jsonb_build_array('J-000393','J-000341','J-000363','J-000367','J-000335'),
      'reason', 'Lot-change continuation inherited J-000272''s past end (Oct 22); waiting jobs on stale slots sat ahead of it, so Adjust End Date hit jobs_no_machine_overlap',
      'cascade', v_cascade, 'before', v_before,
      'marker', v_marker, 'correction', v_file));
end $$;


/* ---------------------------------------------------------------------------
   3. VERIFY. Expect verify_ok = true.
   --------------------------------------------------------------------------- */
with mz5 as (
  select j.job_number, j.status, j.scheduled_start, j.scheduled_end, j.estimated_minutes,
         lag(j.scheduled_end) over (order by j.scheduled_start) as prev_end
    from jobs j
   where j.assigned_machine_id = (select id from machines where code = 'MZ-5')
     and j.status in ('ready','assigned','pending_compliance','in_setup','in_progress')
     and j.scheduled_end > (select scheduled_start from jobs where job_number = 'J-000393')
)
select
  string_agg(job_number || ' ' || to_char(scheduled_start at time zone 'America/New_York', 'Mon DD HH12:MI AM')
             || ' -> ' || to_char(scheduled_end at time zone 'America/New_York', 'Mon DD HH12:MI AM'),
             ' | ' order by scheduled_start)                                               as mz5_queue,
  string_agg(job_number, ',' order by scheduled_start)                                     as job_order,
  count(*) filter (where scheduled_end <= scheduled_start)                                 as inverted_windows,
  count(*) filter (where prev_end is not null and scheduled_start < prev_end)              as overlaps,
  (select count(*) from audit_logs where details->>'marker' = 'D-SCHED-31')                as audit_rows,
  (    string_agg(job_number, ',' order by scheduled_start) = 'J-000393,J-000341,J-000363,J-000367,J-000335'
   and count(*) filter (where scheduled_end <= scheduled_start) = 0
   and count(*) filter (where prev_end is not null and scheduled_start < prev_end) = 0
   and bool_and(status = case when job_number = 'J-000393' then 'in_progress' else 'assigned' end)
   and (select count(*) from audit_logs where details->>'marker' = 'D-SCHED-31') = 1
  )                                                                                        as verify_ok
from mz5;
