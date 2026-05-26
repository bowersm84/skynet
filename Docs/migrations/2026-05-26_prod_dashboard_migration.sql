-- SKY57 — Schedule Change Requests (Production-meeting + future kiosk)
-- Table + RLS (mirrors customer_orders convention) + SECURITY DEFINER write RPC.

create table if not exists public.schedule_change_requests (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.jobs(id),
  current_end   timestamptz,                 -- snapshot of scheduled_end at request time
  requested_end timestamptz not null,
  note          text,
  source        text not null default 'production_meeting'
                  check (source in ('production_meeting','kiosk')),
  status        text not null default 'open'
                  check (status in ('open','applied','dismissed')),
  requested_by  uuid references public.profiles(id),   -- null for dashboard/meeting requests
  created_at    timestamptz not null default now(),
  actioned_by   uuid references public.profiles(id),
  actioned_at   timestamptz
);

create index if not exists scr_status_idx on public.schedule_change_requests(status);
create index if not exists scr_job_idx    on public.schedule_change_requests(job_id);

alter table public.schedule_change_requests enable row level security;

-- Read: any authenticated user (mirrors co_select). Anon dashboard reads OPEN rows only,
-- which is all the "already requested" marker needs.
create policy scr_select_authenticated on public.schedule_change_requests
  for select to authenticated using (true);

create policy scr_select_anon_open on public.schedule_change_requests
  for select to anon using (status = 'open');

-- Update (Apply / Dismiss): admin / scheduler / customer_service only (mirrors co_update).
create policy scr_update on public.schedule_change_requests
  for update to authenticated
  using (exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and (profiles.role)::text = any (array['admin'::text,'scheduler'::text,'customer_service'::text])
  ))
  with check (exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and (profiles.role)::text = any (array['admin'::text,'scheduler'::text,'customer_service'::text])
  ));

-- No INSERT policy: every insert goes through submit_change_request() below.
-- No DELETE policy: dismissal is a status update, never a hard delete.

-- Controlled write. SECURITY DEFINER inserts as the function owner, bypassing RLS, so it
-- works whether the dashboard is anon or a low-privilege display session. Validates the job,
-- guards the date, attributes kiosk requests to the machinist, and de-dupes identical
-- open requests (decision 3).
create or replace function public.submit_change_request(
  p_job_id        uuid,
  p_requested_end timestamptz,
  p_note          text default null,
  p_source        text default 'production_meeting'
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job         record;
  v_existing    uuid;
  v_requested_by uuid;
  v_id          uuid;
begin
  if p_source not in ('production_meeting','kiosk') then
    raise exception 'Invalid source: %', p_source;
  end if;

  select id, status, scheduled_end into v_job from public.jobs where id = p_job_id;
  if not found then
    raise exception 'Job % not found', p_job_id;
  end if;
  if v_job.status in ('complete','cancelled') then
    raise exception 'Job % is % and cannot take a change request', p_job_id, v_job.status;
  end if;

  if p_requested_end is null then
    raise exception 'Requested end date is required';
  end if;
  if p_requested_end::date < current_date then
    raise exception 'Requested end date cannot be in the past';
  end if;

  -- kiosk carries the machinist; dashboard/meeting requests are unattributed
  v_requested_by := case when p_source = 'kiosk' then auth.uid() else null end;

  -- de-dupe: identical open request for this job + date → return existing, no new row
  select id into v_existing
  from public.schedule_change_requests
  where job_id = p_job_id and status = 'open' and requested_end = p_requested_end
  limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

  insert into public.schedule_change_requests
    (job_id, current_end, requested_end, note, source, status, requested_by)
  values
    (p_job_id, v_job.scheduled_end, p_requested_end, nullif(btrim(p_note), ''),
     p_source, 'open', v_requested_by)
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.submit_change_request(uuid, timestamptz, text, text)
  to anon, authenticated;