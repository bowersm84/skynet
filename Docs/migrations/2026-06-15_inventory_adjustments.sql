-- 2026-06-15_inventory_adjustments.sql
-- Cycle-count inventory adjustment workflow + material_availability view.
-- Applied to TEST and PROD 2026-06-15.
--
-- Availability becomes "received - used + approved adjustments". All availability
-- reads (Armory inventory, both kiosks, lot suggestions) point at the
-- material_availability view so an approved cycle count goes live everywhere at once.
--
-- Submitters: admin / compliance / machinist / finishing (enforced in the submit RPC).
-- Approvers:  admin / compliance (enforced in the review RPCs); self-approval blocked.
-- All writes flow through SECURITY DEFINER RPCs; the table has SELECT-only RLS.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Adjustment requests — one row per counted lot whose count differs from system.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.inventory_adjustment_requests (
  id                    uuid primary key default gen_random_uuid(),
  count_session_id      uuid not null,                       -- groups the lines of one cycle count
  material_receiving_id uuid not null references public.material_receiving(id) on delete cascade,
  -- snapshot at submit time so history/review reads don't depend on later changes
  material_type         text,
  bar_size              text,
  lot_number            text,
  system_bars_at_count  numeric not null,                    -- rounded system availability when counted
  counted_bars          numeric not null,                    -- physical count entered
  adjustment_delta      numeric not null,                    -- counted - system
  price_per_bar         numeric,                             -- snapshot for the impact calc
  financial_impact      numeric,                             -- adjustment_delta * price_per_bar (null if no price)
  reason                text,
  status                text not null default 'pending'
                          check (status in ('pending', 'approved', 'rejected')),
  requested_by          uuid references public.profiles(id),
  requested_at          timestamptz not null default now(),
  reviewed_by           uuid references public.profiles(id),
  reviewed_at           timestamptz,
  review_notes          text
);

create index if not exists idx_iar_session    on public.inventory_adjustment_requests(count_session_id);
create index if not exists idx_iar_status     on public.inventory_adjustment_requests(status);
create index if not exists idx_iar_receiving  on public.inventory_adjustment_requests(material_receiving_id);

-- At most one pending adjustment per receiving row (backs the "skipped (already pending)" path).
create unique index if not exists uq_iar_pending_per_receiving
  on public.inventory_adjustment_requests(material_receiving_id)
  where status = 'pending';

alter table public.inventory_adjustment_requests enable row level security;

-- Reads are open to authenticated; all writes go through the RPCs below.
drop policy if exists "iar_select_authenticated" on public.inventory_adjustment_requests;
create policy "iar_select_authenticated" on public.inventory_adjustment_requests
  for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. material_availability — per-receiving-row availability view.
--    available_bars   = received - used + SUM(approved adjustment deltas)
--    available_inches = received_inches - used_inches + (approved delta * bar_length)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.material_availability as
with usage as (
  select material_receiving_id,
         coalesce(sum(quantity_used), 0)        as used_bars,
         coalesce(sum(quantity_used_inches), 0) as used_inches
  from public.material_usage
  group by material_receiving_id
),
adj as (
  select material_receiving_id,
         coalesce(sum(adjustment_delta), 0) as adjustment_delta
  from public.inventory_adjustment_requests
  where status = 'approved'
  group by material_receiving_id
)
select
  r.id                                                              as material_receiving_id,
  r.material_id,
  r.material_type,
  r.bar_size,
  r.lot_number,
  r.vendor,
  r.rack,
  r.received_at,
  r.po_number,
  r.price_per_bar,
  r.bar_length_inches,
  r.quantity                                                        as received_bars,
  coalesce(u.used_bars, 0)                                          as used_bars,
  coalesce(u.used_inches, 0)                                        as used_inches,
  coalesce(a.adjustment_delta, 0)                                   as adjustment_delta,
  (r.quantity - coalesce(u.used_bars, 0) + coalesce(a.adjustment_delta, 0)) as available_bars,
  ((r.quantity * coalesce(r.bar_length_inches, 0)) - coalesce(u.used_inches, 0)
     + (coalesce(a.adjustment_delta, 0) * coalesce(r.bar_length_inches, 0)))  as available_inches
from public.material_receiving r
left join usage u on u.material_receiving_id = r.id
left join adj   a on a.material_receiving_id = r.id;

-- Same read audience as material_receiving (authenticated app + anon kiosks).
grant select on public.material_availability to authenticated, anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. submit_inventory_adjustments — create a pending session from a list of counts.
--    p_items: jsonb array of { material_receiving_id, counted_bars }.
--    Skips lines with no delta or an already-pending row. Returns {inserted,skipped,total_impact}.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.submit_inventory_adjustments(
  p_count_session_id uuid,
  p_items            jsonb,
  p_reason           text
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_role     text;
  v_item     jsonb;
  v_rid      uuid;
  v_counted  numeric;
  v_sys      numeric;
  v_delta    numeric;
  v_av       record;
  v_inserted int := 0;
  v_skipped  int := 0;
  v_total    numeric := 0;
  v_impact   numeric;
begin
  select role into v_role from public.profiles where id = v_uid;
  if v_role is null or v_role not in ('admin', 'compliance', 'machinist', 'finishing') then
    raise exception 'Not authorized to submit inventory adjustments';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    v_rid     := (v_item ->> 'material_receiving_id')::uuid;
    v_counted := (v_item ->> 'counted_bars')::numeric;

    select available_bars, price_per_bar, material_type, bar_size, lot_number
      into v_av
      from public.material_availability
     where material_receiving_id = v_rid;

    if not found then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_sys   := round(v_av.available_bars);
    v_delta := v_counted - v_sys;

    -- no change, or a pending request already exists for this lot → skip
    if v_delta = 0
       or exists (select 1 from public.inventory_adjustment_requests
                  where material_receiving_id = v_rid and status = 'pending') then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_impact := case when v_av.price_per_bar is not null then v_delta * v_av.price_per_bar else null end;

    insert into public.inventory_adjustment_requests (
      count_session_id, material_receiving_id, material_type, bar_size, lot_number,
      system_bars_at_count, counted_bars, adjustment_delta, price_per_bar, financial_impact,
      reason, status, requested_by, requested_at
    ) values (
      p_count_session_id, v_rid, v_av.material_type, v_av.bar_size, v_av.lot_number,
      v_sys, v_counted, v_delta, v_av.price_per_bar, v_impact,
      p_reason, 'pending', v_uid, now()
    );

    v_inserted := v_inserted + 1;
    v_total    := v_total + coalesce(v_impact, 0);
  end loop;

  return json_build_object('inserted', v_inserted, 'skipped', v_skipped, 'total_impact', v_total);
end;
$$;

grant execute on function public.submit_inventory_adjustments(uuid, jsonb, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. review_inventory_adjustment — approve/reject a single line.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.review_inventory_adjustment(
  p_adjustment_id uuid,
  p_decision      text,
  p_notes         text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_role         text;
  v_requested_by uuid;
begin
  select role into v_role from public.profiles where id = v_uid;
  if v_role is null or v_role not in ('admin', 'compliance') then
    raise exception 'Not authorized to review inventory adjustments';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Invalid decision';
  end if;

  select requested_by into v_requested_by
    from public.inventory_adjustment_requests
   where id = p_adjustment_id and status = 'pending';
  if not found then
    raise exception 'Adjustment not found or already reviewed';
  end if;
  if v_requested_by = v_uid then
    raise exception 'You cannot review your own adjustment';
  end if;
  if p_decision = 'rejected' and (p_notes is null or btrim(p_notes) = '') then
    raise exception 'A note is required to reject';
  end if;

  update public.inventory_adjustment_requests
     set status       = p_decision,
         reviewed_by  = v_uid,
         reviewed_at  = now(),
         review_notes = p_notes
   where id = p_adjustment_id;
end;
$$;

grant execute on function public.review_inventory_adjustment(uuid, text, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. review_inventory_adjustment_session — approve/reject all pending lines of a session.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.review_inventory_adjustment_session(
  p_count_session_id uuid,
  p_decision         text,
  p_notes            text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
begin
  select role into v_role from public.profiles where id = v_uid;
  if v_role is null or v_role not in ('admin', 'compliance') then
    raise exception 'Not authorized to review inventory adjustments';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Invalid decision';
  end if;
  if exists (select 1 from public.inventory_adjustment_requests
             where count_session_id = p_count_session_id
               and status = 'pending'
               and requested_by = v_uid) then
    raise exception 'You cannot review your own adjustment session';
  end if;
  if p_decision = 'rejected' and (p_notes is null or btrim(p_notes) = '') then
    raise exception 'A note is required to reject';
  end if;

  update public.inventory_adjustment_requests
     set status       = p_decision,
         reviewed_by  = v_uid,
         reviewed_at  = now(),
         review_notes = p_notes
   where count_session_id = p_count_session_id and status = 'pending';
end;
$$;

grant execute on function public.review_inventory_adjustment_session(uuid, text, text) to authenticated;
