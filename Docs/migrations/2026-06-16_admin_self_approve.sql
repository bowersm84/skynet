-- 2026-06-16_admin_self_approve.sql
-- Let admins approve/reject their own cycle-count adjustments.
--
-- Follow-up to 2026-06-15_inventory_adjustments.sql. Both review RPCs blocked the
-- requester from reviewing their own session ("You cannot review your own adjustment").
-- Admins are now exempt from that self-review block; compliance is still blocked
-- (a second approver must review compliance-submitted sessions). The Armory UI mirrors
-- this — `isOwn` only disables the approve controls for non-admins.
--
-- Only the self-review guard changes; the role gate, decision validation, and
-- reject-requires-note rules are unchanged. CREATE OR REPLACE preserves the existing
-- grants (authenticated). Apply to TEST + PROD.

-- ─────────────────────────────────────────────────────────────────────────────
-- review_inventory_adjustment — single line. Admins may review their own.
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
  -- Admins may approve their own; everyone else needs a second reviewer.
  if v_requested_by = v_uid and v_role <> 'admin' then
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
-- review_inventory_adjustment_session — whole session. Admins may review their own.
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
  -- Admins may approve their own session; everyone else needs a second reviewer.
  if v_role <> 'admin'
     and exists (select 1 from public.inventory_adjustment_requests
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
