/* ============================================================================
   2026-09-03  Nexturn 3 slot correction: J-000116 + J-000158  (PROD)
   ----------------------------------------------------------------------------
   J-000116 (SK35CC38) completed ~22 days ahead of its slot; J-000158 (SK-NS)
   started immediately after but its slot still sits at Sep 25 - Oct 2, so the
   Week view never fetches it (D-SCHED gap, held 2026-08-28) and the Sep 25 -
   Oct 2 window is phantom-reserved on the machine.

   Same correction shape as the J-000207 one-shot (2026-08-28): pull the
   early-started job's slot to its own recorded live start, span preserved;
   and snap the completed predecessor's scheduled_end to its actual_end.
   Order matters - the predecessor's end is shrunk FIRST so the move never
   trips jobs_no_machine_overlap.

   Three independent blocks, ONE at a time in the Supabase SQL Editor:
     STEP 1  PREVIEW (read-only) - both jobs, the machine's full queue with a
             conflict flag against the new span, and a shop-wide scan for any
             OTHER ongoing job whose slot sits in the future (the class).
             Paste the grid back.                              << REVIEW STOP
     STEP 2  APPLY (DO block) - v_dry_run := true by default: performs the
             writes, reports old -> new in the error text, rolls itself back.
             Flip v_dry_run := false and run again to apply.
     STEP 3  VERIFY (read-only) - corrected slots, machine queue order,
             zero-overlap self-check, audit rows.

   Writes (live run only):
     jobs J-000116  scheduled_end -> actual_end                (absolute)
     jobs J-000158  scheduled_start -> COALESCE(setup_start, production_start,
                    actual_start); scheduled_end -> that + the row's own
                    (scheduled_end - scheduled_start) span     (absolute anchors)
     audit_logs     one 'schedule_slot_corrected' row per job
   Nothing else changes: no downstream job moves, no status, no estimates.
   ========================================================================== */


/* ------------------------------- STEP 1: PREVIEW (read-only) -------------- */
with j158 as (
  select j.*, coalesce(j.setup_start, j.production_start, j.actual_start) as live_start,
         (j.scheduled_end - j.scheduled_start) as span
  from public.jobs j where j.job_number = 'J-000158'
),
j116 as (
  select j.* from public.jobs j where j.job_number = 'J-000116'
),
new_span as (
  select live_start as new_start, live_start + span as new_end from j158
)
select 1 as sect, 'J-000116 (predecessor)' as item, to_jsonb(json_build_object(
         'id', j.id, 'status', j.status, 'machine', m.name,
         'scheduled_start', j.scheduled_start, 'scheduled_end', j.scheduled_end,
         'setup_start', j.setup_start, 'actual_end', j.actual_end,
         'would_set_scheduled_end', j.actual_end)) as detail
from j116 j left join public.machines m on m.id = j.assigned_machine_id
union all
select 2, 'J-000158 (early start)', to_jsonb(json_build_object(
         'id', j.id, 'status', j.status, 'machine', m.name,
         'scheduled_start', j.scheduled_start, 'scheduled_end', j.scheduled_end,
         'setup_start', j.setup_start, 'production_start', j.production_start,
         'live_start', j.live_start, 'span', j.span::text,
         'would_set_start', ns.new_start, 'would_set_end', ns.new_end))
from j158 j cross join new_span ns
left join public.machines m on m.id = j.assigned_machine_id
union all
select 3, 'machine queue: ' || q.job_number, to_jsonb(json_build_object(
         'status', q.status, 'part', p.part_number,
         'scheduled_start', q.scheduled_start, 'scheduled_end', q.scheduled_end,
         'conflicts_with_new_span',
           (q.job_number not in ('J-000116', 'J-000158')
            and q.scheduled_start < ns.new_end and q.scheduled_end > ns.new_start)))
from j158 j cross join new_span ns
join public.jobs q on q.assigned_machine_id = j.assigned_machine_id
  and q.scheduled_start is not null and q.status <> 'cancelled'
  and q.scheduled_end > now() - interval '30 days'
left join public.parts p on p.id = q.component_id
union all
select 4, 'CLASS SCAN: ' || s.job_number || ' on ' || coalesce(m.name, '?'), to_jsonb(json_build_object(
         'status', s.status, 'part', p.part_number,
         'scheduled_start', s.scheduled_start, 'scheduled_end', s.scheduled_end,
         'live_start', coalesce(s.setup_start, s.production_start, s.actual_start),
         'note', 'ongoing job whose slot starts in the future - same anomaly'))
from public.jobs s
left join public.machines m on m.id = s.assigned_machine_id
left join public.parts p on p.id = s.component_id
where s.status in ('in_setup', 'in_progress', 'pending_passivation', 'in_passivation')
  and s.scheduled_start > now()
  and s.job_number <> 'J-000158'
order by 1, 2;


/* ------------------------------- STEP 2: APPLY (dry run by default) ------- */
do $$
declare
  v_dry_run   constant boolean := true;   /* flip to false to apply */
  v_early     constant text := 'J-000158';
  v_pred      constant text := 'J-000116';
  v_e         record;
  v_p         record;
  v_live      timestamptz;
  v_span      interval;
  v_new_start timestamptz;
  v_new_end   timestamptz;
  v_conflicts integer;
begin
  select * into v_e from public.jobs where job_number = v_early;
  if v_e.id is null then raise exception 'GUARD: % not found', v_early; end if;
  if v_e.status not in ('in_setup', 'in_progress', 'pending_passivation', 'in_passivation') then
    raise exception 'GUARD: % is % (expected ongoing) - state moved, re-run STEP 1', v_early, v_e.status;
  end if;
  if v_e.scheduled_start is null or v_e.scheduled_end is null then
    raise exception 'GUARD: % has a null slot', v_early;
  end if;
  if v_e.scheduled_start <= now() then
    raise exception 'GUARD: % slot already starts in the past (%) - nothing to correct', v_early, v_e.scheduled_start;
  end if;

  v_live := coalesce(v_e.setup_start, v_e.production_start, v_e.actual_start);
  if v_live is null then
    raise exception 'GUARD: % has no recorded live start (setup_start/production_start/actual_start all null)', v_early;
  end if;
  v_span      := v_e.scheduled_end - v_e.scheduled_start;
  v_new_start := v_live;
  v_new_end   := v_live + v_span;

  select * into v_p from public.jobs where job_number = v_pred;
  if v_p.id is null then raise exception 'GUARD: % not found', v_pred; end if;
  if v_p.assigned_machine_id is distinct from v_e.assigned_machine_id then
    raise exception 'GUARD: % and % are not on the same machine', v_pred, v_early;
  end if;
  if v_p.actual_end is null then
    raise exception 'GUARD: % has no actual_end - cannot snap its slot to reality', v_pred;
  end if;
  if v_p.scheduled_end <= v_p.actual_end then
    raise exception 'GUARD: % scheduled_end (%) is not later than its actual_end (%) - preview state moved', v_pred, v_p.scheduled_end, v_p.actual_end;
  end if;
  if v_p.actual_end > v_new_start then
    raise exception 'GUARD: % actual_end (%) is after % live start (%) - overlapping reality, resolve by hand', v_pred, v_p.actual_end, v_early, v_new_start;
  end if;

  /* no third job may occupy the target span */
  select count(*) into v_conflicts
  from public.jobs q
  where q.assigned_machine_id = v_e.assigned_machine_id
    and q.id not in (v_e.id, v_p.id)
    and q.status <> 'cancelled'
    and q.scheduled_start is not null and q.scheduled_end is not null
    and q.scheduled_start < v_new_end and q.scheduled_end > v_new_start;
  if v_conflicts > 0 then
    raise exception 'GUARD: % other job(s) occupy the target span % - % on this machine - see STEP 1 conflicts', v_conflicts, v_new_start, v_new_end;
  end if;

  /* predecessor first: shrink its slot to reality so the move below cannot
     trip jobs_no_machine_overlap */
  update public.jobs
     set scheduled_end = v_p.actual_end, updated_at = now()
   where id = v_p.id;

  update public.jobs
     set scheduled_start = v_new_start, scheduled_end = v_new_end, updated_at = now()
   where id = v_e.id;

  insert into public.audit_logs (event_type, job_id, machine_id, operator_id, details) values
    ('schedule_slot_corrected', v_p.id, v_p.assigned_machine_id, null, jsonb_build_object(
       'job', v_pred, 'field', 'scheduled_end',
       'old', v_p.scheduled_end, 'new', v_p.actual_end,
       'reason', 'Completed ~3 weeks ahead of slot; end snapped to actual_end so the early-started successor can move into reality. Paired with ' || v_early || '.',
       'via', 'sql one-shot 2026-09-03')),
    ('schedule_slot_corrected', v_e.id, v_e.assigned_machine_id, null, jsonb_build_object(
       'job', v_early, 'field', 'scheduled_start/scheduled_end',
       'old_start', v_e.scheduled_start, 'old_end', v_e.scheduled_end,
       'new_start', v_new_start, 'new_end', v_new_end,
       'reason', 'Started ' || (v_e.scheduled_start - v_live) || ' ahead of slot; slot pulled to recorded live start, span preserved (same shape as J-000207 correction 2026-08-28).',
       'via', 'sql one-shot 2026-09-03'));

  if v_dry_run then
    raise exception 'DRY RUN OK (everything rolled back): % scheduled_end % -> %; % slot [% - %] -> [% - %] (span % preserved). Set v_dry_run := false and run again to apply.',
      v_pred, v_p.scheduled_end, v_p.actual_end,
      v_early, v_e.scheduled_start, v_e.scheduled_end, v_new_start, v_new_end, v_span;
  end if;

  raise notice 'APPLIED: % end -> %; % slot -> [% - %]', v_pred, v_p.actual_end, v_early, v_new_start, v_new_end;
end $$;


/* ------------------------------- STEP 3: VERIFY (read-only) --------------- */
with nt3 as (
  select assigned_machine_id as mid from public.jobs where job_number = 'J-000158'
)
select 1 as sect, 'queue: ' || q.job_number as item, to_jsonb(json_build_object(
         'status', q.status, 'part', p.part_number,
         'scheduled_start', q.scheduled_start, 'scheduled_end', q.scheduled_end,
         'actual_end', q.actual_end)) as detail
from nt3 join public.jobs q on q.assigned_machine_id = nt3.mid
  and q.scheduled_start is not null and q.status <> 'cancelled'
  and q.scheduled_end > now() - interval '30 days'
left join public.parts p on p.id = q.component_id
union all
select 2, 'overlap self-check', to_jsonb(json_build_object('overlapping_pairs', count(*)))
from nt3, public.jobs a, public.jobs b
where a.assigned_machine_id = nt3.mid and b.assigned_machine_id = nt3.mid
  and a.id < b.id and a.status <> 'cancelled' and b.status <> 'cancelled'
  and a.scheduled_start is not null and a.scheduled_end is not null
  and b.scheduled_start is not null and b.scheduled_end is not null
  and a.scheduled_start < b.scheduled_end and b.scheduled_start < a.scheduled_end
union all
select 3, 'audit', to_jsonb(json_build_object('event_type', al.event_type, 'job_id', al.job_id, 'created_at', al.created_at, 'details', al.details))
from public.audit_logs al
where al.event_type = 'schedule_slot_corrected' and al.created_at > now() - interval '1 hour'
order by 1, 2;
