-- Blanks Phase 2 — bolt-master consumption.
-- Recorded copy of the migration block applied in the Supabase SQL editor.
-- Run on TEST (ylzmyjjqibpbqbwjsnqj) first, verify, then PROD (luzungoqfuplspzbqctb).

-- 1) The blank lot chosen at the kiosk at job start. No deduction happens here;
--    the value is read later at finishing completion to drive consumption.
alter table public.jobs
  add column if not exists blank_lot_number text;

-- 2) Tie a material_usage deduction to the finishing send that produced it.
--    The partial unique index makes consumption idempotent per finishing send:
--    re-completing the same send cannot insert a second usage row.
alter table public.material_usage
  add column if not exists finishing_send_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'material_usage_finishing_send_id_fkey'
  ) then
    alter table public.material_usage
      add constraint material_usage_finishing_send_id_fkey
      foreign key (finishing_send_id) references public.finishing_sends(id);
  end if;
end $$;

create unique index if not exists material_usage_finishing_send_id_key
  on public.material_usage(finishing_send_id)
  where finishing_send_id is not null;

-- 3) Idempotent consumption: deduct a blank lot by James's verified finishing count.
--    Attributes the usage to the real on-hand blank receipt for the lot so the
--    material_availability view (received - used + adjustments) drops accordingly.
create or replace function public.consume_blank_lot(
  p_finishing_send_id uuid,
  p_job_id uuid,
  p_lot_number text,
  p_quantity integer,
  p_used_by uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_receiving_id uuid;
begin
  if p_quantity is null or p_quantity <= 0 then
    return;
  end if;

  -- Already deducted for this finishing send? No-op (idempotent guard).
  if exists (
    select 1 from material_usage where finishing_send_id = p_finishing_send_id
  ) then
    return;
  end if;

  -- Resolve the real on-hand blank receipt for this lot (earliest receipt wins).
  select mr.id
    into v_receiving_id
  from material_receiving mr
  where mr.lot_number = p_lot_number
    and mr.category = 'blank'
  order by mr.received_at asc
  limit 1;

  begin
    insert into material_usage (
      material_receiving_id, material_id, lot_number, job_id,
      quantity_used, quantity_used_inches, used_by, used_at,
      finishing_send_id, notes
    ) values (
      v_receiving_id, null, p_lot_number, p_job_id,
      p_quantity, null, p_used_by, now(),
      p_finishing_send_id, 'Blank consumption at finishing (verified count)'
    );
  exception when unique_violation then
    -- Concurrent / retried insert for the same finishing send: treat as success.
    return;
  end;
end;
$$;

grant execute on function public.consume_blank_lot(uuid, uuid, text, integer, uuid) to authenticated;
