/* =====================================================================
   D-FBCLOSE-01 - CO lines Fishbowl has already shipped stop haunting Demand
   2026-11-23 | SkyNet PROD (luzungoqfuplspzbqctb), SQL Editor
   Proven on TEST first (ylzmyjjqibpbqbwjsnqj).

   Gap: Fishbowl line status 50 (Fulfilled) and 60 (Closed Short) arrive
   as plain line_status_changed events and nothing closes the SkyNet CO
   line. Voids, cancels and removals already go to the Order Queue
   exception list (D-FB-14/15/48) and are left as they are.

   Adds:
     v_co_line_fb_state         Fishbowl state per CO line (read)
     v_co_fb_closed_review      allocated lines Fishbowl already closed (read)
     _co_close_line             internal: close a line, handle its WOs, audit
     _co_close_from_fb          internal: close a line per its Fishbowl state
     trg_fb_line_closed         bridge hook on fb_sales_order_lines
     co_resolve_fb_closed_line  RPC (admin, scheduler): keep_as_stock | review_wo
     co_release_demand_lines    RPC (admin, scheduler; order_processor for
                                non-shipped reasons): manual Release on Demand
   Rules (Matt, 2026-11-23): Fulfilled -> line complete; Closed Short ->
   line cancelled, shipped qty in the reason; lines with an active
   allocation are never auto-closed - they go to the review list, default
   action keep the WO as stock.

   Run each block on its own, in order. Block comments only.
   ===================================================================== */


/* ---------------------------------------------------------------------
   BLOCK 1 - PREVIEW (read-only)
   Expect on PROD as of 2026-11-23 (may drift as orders ship):
   fulfilled_unallocated 2 | fulfilled_allocated 17 | short_unallocated 0 | short_allocated 0
   --------------------------------------------------------------------- */
with st as (
  select l.customer_order_line_id as id,
    case when count(*) filter (where l.status_id not in (50,60,70,75,95)) > 0 then 'open'
         when count(*) filter (where l.status_id in (70,75)) > 0 then 'cancelled'
         when count(*) filter (where l.status_id = 95) > 0 then 'historical'
         when count(*) filter (where l.status_id = 60) > 0 then 'closed_short'
         else 'fulfilled' end as fb_state
  from fb_sales_order_lines l
  where l.customer_order_line_id is not null and l.removed_at is null
  group by l.customer_order_line_id
), cand as (
  select st.fb_state,
    exists (select 1 from customer_order_allocations a where a.customer_order_line_id = cl.id and a.is_active) as allocated
  from st join customer_order_lines cl on cl.id = st.id join customer_orders co on co.id = cl.customer_order_id
  where cl.status in ('not_started','in_progress') and co.status <> 'cancelled' and st.fb_state in ('fulfilled','closed_short')
)
select count(*) filter (where fb_state = 'fulfilled' and not allocated) as fulfilled_unallocated,
       count(*) filter (where fb_state = 'fulfilled' and allocated) as fulfilled_allocated,
       count(*) filter (where fb_state = 'closed_short' and not allocated) as short_unallocated,
       count(*) filter (where fb_state = 'closed_short' and allocated) as short_allocated
from cand;


/* ---------------------------------------------------------------------
   BLOCK 2 - SCHEMA (views, functions, trigger, grants)
   Run as one batch. Expect: "Success. No rows returned".
   --------------------------------------------------------------------- */
create or replace view public.v_co_line_fb_state with (security_invoker = true) as
select l.customer_order_line_id,
  count(*)::int as fb_lines,
  count(*) filter (where l.status_id not in (50,60,70,75,95))::int as open_lines,
  case when count(*) filter (where l.status_id not in (50,60,70,75,95)) > 0 then 'open'
       when count(*) filter (where l.status_id in (70,75)) > 0 then 'cancelled'
       when count(*) filter (where l.status_id = 95) > 0 then 'historical'
       when count(*) filter (where l.status_id = 60) > 0 then 'closed_short'
       else 'fulfilled' end as fb_state,
  trim_scale(sum(l.qty_ordered)) as fb_qty_ordered,
  trim_scale(sum(l.qty_fulfilled)) as fb_qty_shipped,
  string_agg(distinct so.so_number, ', ') as so_numbers,
  max(so.fb_date_completed) as fb_completed_at
from public.fb_sales_order_lines l
join public.fb_sales_orders so on so.fb_so_id = l.fb_so_id
where l.customer_order_line_id is not null and l.removed_at is null
group by l.customer_order_line_id;

create or replace view public.v_co_fb_closed_review with (security_invoker = true) as
select l.id as customer_order_line_id, co.id as customer_order_id, co.co_number, c.name as customer,
  l.line_number, p.part_number, p.description as part_description,
  l.quantity_ordered, l.quantity_fulfilled,
  s.fb_state, s.so_numbers, s.fb_completed_at, s.fb_qty_ordered, s.fb_qty_shipped,
  a.work_orders, a.allocated,
  j.jobs_summary,
  case when coalesce(j.running_jobs,0) > 0 then 'running'
       when coalesce(j.awaiting_tco_jobs,0) > 0 then 'awaiting_tco'
       when coalesce(j.done_jobs,0) > 0 then 'jobs_complete'
       else 'no_jobs' end as job_state
from public.customer_order_lines l
join public.customer_orders co on co.id = l.customer_order_id
left join public.customers c on c.id = co.customer_id
left join public.parts p on p.id = l.part_id
join public.v_co_line_fb_state s on s.customer_order_line_id = l.id
join lateral (
  select string_agg(distinct w.wo_number, ', ') as work_orders, sum(x.quantity_allocated)::int as allocated
    from public.customer_order_allocations x join public.work_orders w on w.id = x.work_order_id
   where x.customer_order_line_id = l.id and x.is_active
) a on a.allocated is not null
left join lateral (
  select string_agg(jb.job_number || ' ' || jb.status || coalesce(' @' || m.name, ''), '; ' order by jb.job_number) as jobs_summary,
    count(*) filter (where jb.status in ('ready','pending_compliance','assigned','in_setup','in_progress',
                                         'pending_passivation','in_passivation','ready_for_outsourcing')) as running_jobs,
    count(*) filter (where jb.status in ('manufacturing_complete','pending_tco')) as awaiting_tco_jobs,
    count(*) filter (where jb.status = 'complete') as done_jobs
    from public.jobs jb left join public.machines m on m.id = jb.assigned_machine_id
   where jb.work_order_id in (select x.work_order_id from public.customer_order_allocations x
                               where x.customer_order_line_id = l.id and x.is_active)
     and jb.merged_into_job_id is null and jb.status not in ('cancelled','merged')
) j on true
where l.status in ('not_started','in_progress') and co.status <> 'cancelled'
  and s.fb_state in ('fulfilled','closed_short');

create or replace function public._co_close_line(
  p_line_id uuid, p_outcome text, p_reason text, p_wo_mode text, p_uid uuid, p_source text,
  p_extra jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_status    text;
  v_ordered   integer;
  v_fulfilled integer;
  v_co_number text;
  v_line_no   integer;
  v_part      text;
  v_wos       uuid[];
  v_wo        uuid;
  v_wo_number text;
  v_converted text[] := '{}';
  v_flagged   text[] := '{}';
  v_shared    text[] := '{}';
  v_fb_done   timestamptz;
begin
  if p_outcome is null or p_outcome not in ('complete','cancel') then
    raise exception 'Unknown outcome % (complete | cancel)', coalesce(p_outcome, 'NULL') using errcode = '22023';
  end if;
  if p_wo_mode is not null and p_wo_mode not in ('keep_as_stock','review_wo') then
    raise exception 'Unknown work-order mode % (keep_as_stock | review_wo)', p_wo_mode using errcode = '22023';
  end if;

  perform 1 from public.customer_order_lines where id = p_line_id for update;
  v_status := (select status from public.customer_order_lines where id = p_line_id);
  if v_status is null then
    raise exception 'CO line % not found', p_line_id using errcode = '22023';
  end if;
  v_co_number := (select co.co_number from public.customer_order_lines l join public.customer_orders co on co.id = l.customer_order_id where l.id = p_line_id);
  v_line_no   := (select line_number from public.customer_order_lines where id = p_line_id);
  v_part      := (select p.part_number from public.customer_order_lines l join public.parts p on p.id = l.part_id where l.id = p_line_id);
  if v_status not in ('not_started','in_progress') then
    return jsonb_build_object('line_id', p_line_id, 'co_number', v_co_number, 'line_number', v_line_no,
                              'part_number', v_part, 'skipped', 'line is ' || v_status);
  end if;
  v_ordered   := (select quantity_ordered from public.customer_order_lines where id = p_line_id);
  v_fulfilled := coalesce((select quantity_fulfilled from public.customer_order_lines where id = p_line_id), 0);

  v_wos := (select array_agg(distinct work_order_id) from public.customer_order_allocations
             where customer_order_line_id = p_line_id and is_active);
  if v_wos is not null then
    if p_wo_mode is null then
      return jsonb_build_object('line_id', p_line_id, 'co_number', v_co_number, 'line_number', v_line_no,
                                'part_number', v_part, 'review', true,
                                'work_orders', (select jsonb_agg(wo_number order by wo_number) from public.work_orders where id = any (v_wos)));
    end if;
    update public.customer_order_allocations
       set is_active = false, deactivated_at = now(), deactivated_by = p_uid
     where customer_order_line_id = p_line_id and is_active;
    foreach v_wo in array v_wos loop
      v_wo_number := (select wo_number from public.work_orders where id = v_wo);
      if p_wo_mode = 'review_wo' then
        update public.work_orders set has_cancelled_allocation = true where id = v_wo;
        v_flagged := v_flagged || v_wo_number;
      elsif not exists (select 1 from public.customer_order_allocations where work_order_id = v_wo and is_active) then
        update public.work_orders
           set order_type = 'make_to_stock', customer = null, po_number = null, is_combined = false
         where id = v_wo and order_type = 'make_to_order';
        v_converted := v_converted || v_wo_number;
      else
        v_shared := v_shared || v_wo_number;
      end if;
      perform public._wo_resync_due_date(v_wo);
    end loop;
  end if;

  if p_outcome = 'complete' then
    /* co_fulfillment_adjustments.adjusted_by is NOT NULL: bridge and sweep
       closes have no user, so they are recorded in the audit row only */
    if v_fulfilled < v_ordered and p_uid is not null then
      insert into public.co_fulfillment_adjustments
        (customer_order_line_id, old_fulfilled, new_fulfilled, delta, reason, adjusted_by)
      values (p_line_id, v_fulfilled, v_ordered, v_ordered - v_fulfilled, p_reason, p_uid);
    end if;
    v_fb_done := nullif(p_extra ->> 'fb_completed_at', '')::timestamptz;
    update public.customer_order_lines
       set quantity_fulfilled = greatest(v_fulfilled, v_ordered), status = 'complete',
           fulfilled_at = coalesce(v_fb_done, now()), fulfilled_by = p_uid
     where id = p_line_id;
  else
    update public.customer_order_lines
       set status = 'cancelled', cancelled_at = now(), cancelled_by = p_uid, cancel_reason = p_reason
     where id = p_line_id;
  end if;

  insert into public.audit_logs (event_type, operator_id, details)
  values ('co_line_closed_external', p_uid, jsonb_build_object(
    'customer_order_line_id', p_line_id, 'co_number', v_co_number, 'line_number', v_line_no, 'part_number', v_part,
    'outcome', p_outcome, 'reason', p_reason, 'source', p_source, 'wo_mode', p_wo_mode,
    'old_status', v_status, 'old_fulfilled', v_fulfilled, 'ordered', v_ordered,
    'wo_converted_to_stock', to_jsonb(v_converted), 'wo_flagged_for_review', to_jsonb(v_flagged),
    'wo_still_serving_others', to_jsonb(v_shared), 'decision', 'D-FBCLOSE-01') || coalesce(p_extra, '{}'::jsonb));

  return jsonb_build_object('line_id', p_line_id, 'co_number', v_co_number, 'line_number', v_line_no,
    'part_number', v_part, 'outcome', p_outcome, 'reason', p_reason,
    'wo_converted_to_stock', to_jsonb(v_converted), 'wo_flagged_for_review', to_jsonb(v_flagged),
    'wo_still_serving_others', to_jsonb(v_shared));
end;
$fn$;

create or replace function public._co_close_from_fb(
  p_line_id uuid, p_source text, p_wo_mode text default null, p_uid uuid default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_state  text;
  v_so     text;
  v_done   timestamptz;
  v_ord    numeric;
  v_ship   numeric;
  v_reason text;
begin
  v_state := (select fb_state from public.v_co_line_fb_state where customer_order_line_id = p_line_id);
  if v_state is null or v_state not in ('fulfilled','closed_short') then
    return jsonb_build_object('line_id', p_line_id,
      'skipped', coalesce('Fishbowl line is ' || v_state, 'no live Fishbowl line linked'));
  end if;
  v_so   := (select so_numbers      from public.v_co_line_fb_state where customer_order_line_id = p_line_id);
  v_done := (select fb_completed_at from public.v_co_line_fb_state where customer_order_line_id = p_line_id);
  v_ord  := (select fb_qty_ordered  from public.v_co_line_fb_state where customer_order_line_id = p_line_id);
  v_ship := (select fb_qty_shipped  from public.v_co_line_fb_state where customer_order_line_id = p_line_id);
  if v_state = 'fulfilled' then
    v_reason := 'Shipped complete in Fishbowl (SO ' || v_so
             || coalesce(', ' || to_char(v_done at time zone 'America/New_York', 'YYYY-MM-DD'), '') || ')';
  else
    v_reason := 'Closed short in Fishbowl (SO ' || v_so || '): shipped ' || v_ship::text || ' of ' || v_ord::text;
  end if;
  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    v_reason := v_reason || ' - ' || btrim(p_note);
  end if;
  return public._co_close_line(p_line_id,
    case when v_state = 'fulfilled' then 'complete' else 'cancel' end,
    v_reason, p_wo_mode, p_uid, p_source,
    jsonb_build_object('fb_state', v_state, 'so_numbers', v_so, 'fb_completed_at', v_done,
                       'fb_qty_ordered', v_ord, 'fb_qty_shipped', v_ship));
end;
$fn$;

create or replace function public.trg_fb_line_closed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v jsonb;
begin
  begin
    v := public._co_close_from_fb(new.customer_order_line_id, 'bridge', null, null, null);
  exception when others then
    insert into public.audit_logs (event_type, details)
    values ('co_line_close_external_failed', jsonb_build_object(
      'customer_order_line_id', new.customer_order_line_id, 'fb_soitem_id', new.fb_soitem_id,
      'error', sqlerrm, 'decision', 'D-FBCLOSE-01'));
  end;
  return null;
end;
$fn$;

drop trigger if exists trg_fb_line_closed on public.fb_sales_order_lines;
create trigger trg_fb_line_closed
after update of status_id, customer_order_line_id, removed_at on public.fb_sales_order_lines
for each row
when (new.customer_order_line_id is not null and new.removed_at is null and new.status_id in (50, 60)
      and (old.status_id is distinct from new.status_id
           or old.customer_order_line_id is distinct from new.customer_order_line_id
           or old.removed_at is distinct from new.removed_at))
execute function public.trg_fb_line_closed();

create or replace function public.co_resolve_fb_closed_line(p_line_id uuid, p_action text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v jsonb;
begin
  perform public._fb_gate(array['admin','scheduler']);
  if p_action is null or p_action not in ('keep_as_stock','review_wo') then
    raise exception 'Unknown action % (keep_as_stock | review_wo)', coalesce(p_action, 'NULL') using errcode = '22023';
  end if;
  v := public._co_close_from_fb(p_line_id, 'review', p_action, auth.uid(), p_note);
  if v ? 'skipped' then
    raise exception 'Nothing to resolve: %', v ->> 'skipped' using errcode = '22023';
  end if;
  return v;
end;
$fn$;

create or replace function public.co_release_demand_lines(p_line_ids uuid[], p_reason text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_uid     uuid := auth.uid();
  v_id      uuid;
  v_out     jsonb := '[]'::jsonb;
  v_label   text;
  v_text    text;
begin
  perform public._fb_gate(array['admin','scheduler','order_processor']);
  if p_reason is null or p_reason not in ('shipped_from_stock','cancelled_by_customer','duplicate','other') then
    raise exception 'Unknown reason % (shipped_from_stock | cancelled_by_customer | duplicate | other)', coalesce(p_reason, 'NULL')
      using errcode = '22023';
  end if;
  if p_reason = 'shipped_from_stock' and v_uid is not null and not public.user_has_role(v_uid, 'admin', 'scheduler') then
    raise exception 'Only admin or scheduler can release a line as shipped from stock' using errcode = '42501';
  end if;
  if p_reason = 'other' and nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'A note is required when the reason is Other' using errcode = '22023';
  end if;
  if p_line_ids is null or cardinality(p_line_ids) = 0 then
    raise exception 'No lines given' using errcode = '22023';
  end if;
  v_label := case p_reason
               when 'shipped_from_stock'    then 'Released on Demand: shipped from stock'
               when 'cancelled_by_customer' then 'Released on Demand: cancelled by customer'
               when 'duplicate'             then 'Released on Demand: duplicate line'
               else 'Released on Demand' end;
  v_text := concat_ws(' - ', v_label, nullif(btrim(coalesce(p_note, '')), ''));
  foreach v_id in array p_line_ids loop
    v_out := v_out || jsonb_build_array(public._co_close_line(
      v_id, case when p_reason = 'shipped_from_stock' then 'complete' else 'cancel' end,
      v_text, 'keep_as_stock', v_uid, 'release', jsonb_build_object('release_reason', p_reason)));
  end loop;
  return jsonb_build_object('released', v_out);
end;
$fn$;

revoke all on function public._co_close_line(uuid, text, text, text, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public._co_close_from_fb(uuid, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.trg_fb_line_closed() from public, anon, authenticated;
grant execute on function public._co_close_line(uuid, text, text, text, uuid, text, jsonb) to service_role;
grant execute on function public._co_close_from_fb(uuid, text, text, uuid, text) to service_role;
revoke all on function public.co_resolve_fb_closed_line(uuid, text, text) from public, anon;
revoke all on function public.co_release_demand_lines(uuid[], text, text) from public, anon;
grant execute on function public.co_resolve_fb_closed_line(uuid, text, text) to authenticated, service_role;
grant execute on function public.co_release_demand_lines(uuid[], text, text) to authenticated, service_role;
revoke all on public.v_co_line_fb_state from anon;
revoke all on public.v_co_fb_closed_review from anon;
grant select on public.v_co_line_fb_state to authenticated, service_role;
grant select on public.v_co_fb_closed_review to authenticated, service_role;


/* ---------------------------------------------------------------------
   BLOCK 3 - ONE-TIME SWEEP
   Closes every open line Fishbowl already shipped that has no active
   allocation; allocated lines are left for the review list.
   Expect: "Success. No rows returned". Counts land in audit_logs
   (event co_fb_close_sweep) and show in Block 4.
   --------------------------------------------------------------------- */
do $$
declare
  r          record;
  v          jsonb;
  n_closed   integer := 0;
  n_review   integer := 0;
  n_skipped  integer := 0;
begin
  for r in
    select s.customer_order_line_id as id
      from public.v_co_line_fb_state s
      join public.customer_order_lines l on l.id = s.customer_order_line_id
      join public.customer_orders co on co.id = l.customer_order_id
     where s.fb_state in ('fulfilled','closed_short')
       and l.status in ('not_started','in_progress') and co.status <> 'cancelled'
  loop
    v := public._co_close_from_fb(r.id, 'sweep', null, null, null);
    if v ? 'review' then
      n_review := n_review + 1;
    elsif v ? 'skipped' then
      n_skipped := n_skipped + 1;
    else
      n_closed := n_closed + 1;
    end if;
  end loop;
  insert into public.audit_logs (event_type, details)
  values ('co_fb_close_sweep', jsonb_build_object('closed', n_closed, 'to_review', n_review,
          'skipped', n_skipped, 'decision', 'D-FBCLOSE-01'));
end $$;


/* ---------------------------------------------------------------------
   BLOCK 4 - VERIFY (read-only, one row)
   Expect on PROD: objects_ok true | anon_blocked true | sweep_closed 2 |
   sweep_to_review 17 | review_rows 17 | stuck_unallocated 0 |
   tailwind_l4 complete | irwin_19400_l6 complete
   (sweep and review counts may drift if orders shipped since Block 1)
   --------------------------------------------------------------------- */
select
  ((select count(*) from pg_class where relname in ('v_co_line_fb_state','v_co_fb_closed_review')) = 2
   and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
        and p.proname in ('_co_close_line','_co_close_from_fb','trg_fb_line_closed','co_resolve_fb_closed_line','co_release_demand_lines')) = 5
   and exists (select 1 from pg_trigger where tgname = 'trg_fb_line_closed')) as objects_ok,
  (not has_function_privilege('anon', 'public.co_release_demand_lines(uuid[],text,text)', 'EXECUTE')
   and not has_function_privilege('anon', 'public.co_resolve_fb_closed_line(uuid,text,text)', 'EXECUTE')
   and not has_function_privilege('anon', 'public._co_close_line(uuid,text,text,text,uuid,text,jsonb)', 'EXECUTE')
   and not has_function_privilege('authenticated', 'public._co_close_line(uuid,text,text,text,uuid,text,jsonb)', 'EXECUTE')) as anon_blocked,
  (select (details ->> 'closed')::int from public.audit_logs where event_type = 'co_fb_close_sweep' order by created_at desc limit 1) as sweep_closed,
  (select (details ->> 'to_review')::int from public.audit_logs where event_type = 'co_fb_close_sweep' order by created_at desc limit 1) as sweep_to_review,
  (select count(*) from public.v_co_fb_closed_review) as review_rows,
  (select count(*) from public.v_co_line_fb_state s join public.customer_order_lines l on l.id = s.customer_order_line_id
    where s.fb_state in ('fulfilled','closed_short') and l.status in ('not_started','in_progress')
      and not exists (select 1 from public.customer_order_allocations a where a.customer_order_line_id = l.id and a.is_active)) as stuck_unallocated,
  (select l.status from public.customer_order_lines l join public.customer_orders co on co.id = l.customer_order_id
    where co.co_number = 'CO-20586-20188' and l.line_number = 4) as tailwind_l4,
  (select l.status from public.customer_order_lines l join public.customer_orders co on co.id = l.customer_order_id
    where co.co_number = 'CO-7259-19400' and l.line_number = 6) as irwin_19400_l6;
