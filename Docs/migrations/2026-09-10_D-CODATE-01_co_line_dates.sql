/* ============================================================================
   2026-09-10  D-CODATE-01: three dates per customer-order line  (TEST first, then PROD)
   ----------------------------------------------------------------------------
   Additive only: one immutable helper function and one read-only view. Run
   the whole block on TEST, verify the CC round against TEST, then run the
   same block on PROD before deploying.

   Per CO line the view derives, at read time (nothing stored, nothing for the
   Fishbowl bridge or fb_convert_to_co to maintain):
     entered_on        the day the order was entered: Fishbowl SO creation
                       date for Fishbowl-sourced lines (min fb_date_created
                       over the line's linked SO lines, America/New_York),
                       else the SkyNet line's created_at
     target_date       entered_on + 45 business days (weekends skipped)
     fb_due_date       Fishbowl's live effective due (min over linked lines:
                       Remaining Parts Ship Date, else dateScheduledFulfillment),
                       else the CO line's own due_date (manual COs)
     fb_due_is_default true when Fishbowl never received a real date (the
                       line carries the creation timestamp)
     line_due_date     customer_order_lines.due_date as stored
     scheduled_finish  latest scheduled_end across non-cancelled, non-
                       maintenance jobs on the line's actively allocated WOs
     has_unscheduled_jobs  any such job still without a scheduled_end
   ========================================================================== */

create or replace function public.add_business_days(p_start date, p_days integer)
returns date
language plpgsql
immutable
strict
as $$
declare
  v_d date := p_start;
  v_n integer := 0;
begin
  while v_n < p_days loop
    v_d := v_d + 1;
    if extract(isodow from v_d) < 6 then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_d;
end
$$;

comment on function public.add_business_days(date, integer) is
  'D-CODATE-01: p_start plus p_days Monday-Friday days (no holiday table yet).';

create or replace view public.v_co_line_dates
with (security_invoker = true)
as
select col.id as customer_order_line_id,
       col.customer_order_id,
       coalesce(fb.entered_on, (col.created_at at time zone 'America/New_York')::date) as entered_on,
       case when fb.entered_on is not null then 'fishbowl' else 'skynet' end as entered_source,
       public.add_business_days(
         coalesce(fb.entered_on, (col.created_at at time zone 'America/New_York')::date), 45) as target_date,
       coalesce(fb.fb_due, col.due_date) as fb_due_date,
       coalesce(fb.fb_due_is_default, false) as fb_due_is_default,
       col.due_date as line_due_date,
       sf.scheduled_finish,
       coalesce(sf.has_unscheduled_jobs, false) as has_unscheduled_jobs
from public.customer_order_lines col
left join lateral (
  select min((so.fb_date_created at time zone 'America/New_York')::date) as entered_on,
         min(l.effective_due_date) as fb_due,
         bool_or(l.due_date_is_default) as fb_due_is_default
  from public.fb_sales_order_lines l
  join public.fb_sales_orders so on so.fb_so_id = l.fb_so_id
  where l.customer_order_line_id = col.id
    and l.removed_at is null
) fb on true
left join lateral (
  select max((j.scheduled_end at time zone 'America/New_York')::date) as scheduled_finish,
         bool_or(j.scheduled_end is null and j.status in ('pending_compliance', 'ready', 'assigned')) as has_unscheduled_jobs
  from public.customer_order_allocations a
  join public.jobs j on j.work_order_id = a.work_order_id
  where a.customer_order_line_id = col.id
    and a.is_active
    and j.status <> 'cancelled'
    and coalesce(j.is_maintenance, false) = false
) sf on true;

comment on view public.v_co_line_dates is
  'D-CODATE-01: per CO line - entered_on (Fishbowl SO creation, else SkyNet), target_date (= entered_on + 45 business days), live Fishbowl due, and the scheduled finish of its allocated work. Read-time derivation; nothing stored.';

grant select on public.v_co_line_dates to authenticated;

/* ---------------------------------------------------------------- verify */
/* 1. the helper: 2026-09-10 (Thu) + 45 business days = 2026-11-12 (Thu) */
select public.add_business_days(date '2026-09-10', 45) as target_from_sep_10,
       public.add_business_days(date '2026-09-12', 1)  as sat_plus_1_is_mon;

/* 2. sample of open lines through the view (run as a second statement) */
select v.customer_order_line_id, co.co_number, col.line_number,
       v.entered_on, v.entered_source, v.target_date, v.fb_due_date, v.fb_due_is_default,
       v.scheduled_finish, v.has_unscheduled_jobs
from public.v_co_line_dates v
join public.customer_order_lines col on col.id = v.customer_order_line_id
join public.customer_orders co on co.id = col.customer_order_id
where col.status in ('not_started', 'in_progress')
order by v.target_date
limit 25;

/* 3. who can read the Fishbowl staging tables through a security_invoker view
      (the Demand/Orders screens need SELECT for customer_service / scheduler /
      purchaser / admin; a role without it silently falls back to SkyNet dates) */
select tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('fb_sales_orders', 'fb_sales_order_lines')
order by tablename, policyname;
