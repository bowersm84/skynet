/* ===========================================================================
   2026-10-29_WO-2610-0050_cancel.sql
   SkyNet MES - cancel the SK26-6W stock placeholder WO-2610-0050 (J-000395)

   WHY
     WO-2610-0050 was a make-to-stock placeholder (2,400 SK26-6W2 / SK2600-6W)
     until the customer order arrived (WO-2610-0064, AEVEX, J-000410, now merged
     into J-000366). J-000395 was unmerged from J-000366 on Oct 29 (D-JOBMERGE-22)
     and is back to pending_compliance with nothing made against it.

   WHAT
     Cancel, not delete - the same as WO-2606-0052 and WO-2608-0036. The merge
     history (job_merge_allocations) and the audit trail point at this WO and job,
     so a hard delete is blocked by the database and would erase the record.
     J-000395 -> cancelled. WO-2610-0050 -> cancelled (drops out of Order Lookup,
     which hides cancelled work orders). Its two assembly lines stay as they are,
     as on the earlier cancelled WOs. One audit row per record, marker WO-2610-0050-cancel.

   HOW TO RUN (Supabase SQL Editor, RLS toggle OFF, one block at a time)
     1. PREVIEW -> one row, expect preview_ok = true
     2. APPLY   -> one DO block; raises and changes nothing if a guard fails
     3. VERIFY  -> one row, expect verify_ok = true
   =========================================================================== */


/* ---------------------------------------------------------------------------
   1. PREVIEW (read-only)
   --------------------------------------------------------------------------- */
select
  w.status                                                                        as wo_status,
  w.order_type,
  (select string_agg(j.job_number || ':' || j.status, ', ') from jobs j where j.work_order_id = w.id) as jobs,
  (select count(*) from finishing_sends f join jobs j on j.id = f.job_id where j.work_order_id = w.id) as finishing_sends,
  (select count(*) from job_merge_allocations a where a.member_work_order_id = w.id and a.is_active)   as active_merges,
  (select count(*) from customer_order_allocations c where c.work_order_id = w.id)                     as customer_allocations,
  (    w.status = 'pending'
   and w.order_type = 'make_to_stock'
   and (select count(*) from jobs j where j.work_order_id = w.id) = 1
   and (select count(*) from jobs j where j.work_order_id = w.id and j.job_number = 'J-000395'
          and j.status = 'pending_compliance' and j.production_lot_number is null
          and j.setup_start is null and j.production_start is null and j.merged_into_job_id is null) = 1
   and (select count(*) from finishing_sends f join jobs j on j.id = f.job_id where j.work_order_id = w.id) = 0
   and (select count(*) from job_merge_allocations a where a.member_work_order_id = w.id and a.is_active) = 0
   and (select count(*) from customer_order_allocations c where c.work_order_id = w.id) = 0
  )                                                                               as preview_ok
from work_orders w
where w.wo_number = 'WO-2610-0050';


/* ---------------------------------------------------------------------------
   2. APPLY
   --------------------------------------------------------------------------- */
do $$
declare
  v_marker text := 'WO-2610-0050-cancel';
  v_file   text := '2026-10-29_WO-2610-0050_cancel.sql';
  v_wo     work_orders%rowtype;
  v_job    jobs%rowtype;
  v_actor  uuid;
  v_n      integer;
begin
  v_actor := coalesce(
    (select p.id from profiles p where p.username = 'mbowers' and p.role = 'admin'),
    (select p.id from profiles p where p.username = 'mabowers84'));
  if v_actor is null then raise exception 'WO-2610-0050 cancel: actor profile not found'; end if;

  v_wo := (select w from work_orders w where w.wo_number = 'WO-2610-0050' for update);
  if v_wo.id is null then raise exception 'WO-2610-0050 not found'; end if;
  if v_wo.status <> 'pending' or v_wo.order_type <> 'make_to_stock' then
    raise exception 'WO-2610-0050 not in expected state (status %, type %) - nothing changed', v_wo.status, v_wo.order_type;
  end if;

  v_n := (select count(*) from jobs j where j.work_order_id = v_wo.id);
  if v_n <> 1 then raise exception 'WO-2610-0050 has % jobs, expected 1 - nothing changed', v_n; end if;

  v_job := (select j from jobs j where j.work_order_id = v_wo.id for update);
  if v_job.job_number <> 'J-000395' or v_job.status <> 'pending_compliance'
     or v_job.production_lot_number is not null or v_job.setup_start is not null
     or v_job.production_start is not null or v_job.merged_into_job_id is not null then
    raise exception 'J-000395 not in expected state (status %, pln %, merged_into %) - nothing changed',
      v_job.status, v_job.production_lot_number, v_job.merged_into_job_id;
  end if;

  if exists (select 1 from finishing_sends f where f.job_id = v_job.id) then
    raise exception 'J-000395 has finishing batches - nothing changed';
  end if;
  if exists (select 1 from job_merge_allocations a where a.member_work_order_id = v_wo.id and a.is_active) then
    raise exception 'WO-2610-0050 still has an active merge - nothing changed';
  end if;
  if exists (select 1 from customer_order_allocations c where c.work_order_id = v_wo.id) then
    raise exception 'WO-2610-0050 has customer order allocations - nothing changed';
  end if;

  update jobs
     set status     = 'cancelled',
         updated_at = now()
   where id = v_job.id;

  update work_orders
     set status     = 'cancelled',
         updated_at = now()
   where id = v_wo.id;

  insert into audit_logs (event_type, job_id, operator_id, details) values
  ('job_cancelled_by_sql', v_job.id, v_actor, jsonb_build_object(
     'job_number', 'J-000395', 'work_order', 'WO-2610-0050', 'status_before', v_job.status,
     'reason', 'Stock placeholder replaced by the customer order WO-2610-0064 (J-000410); unmerged from J-000366 on 2026-10-29',
     'marker', v_marker, 'correction', v_file)),
  ('work_order_cancelled_by_sql', null, v_actor, jsonb_build_object(
     'wo_number', 'WO-2610-0050', 'work_order_id', v_wo.id, 'status_before', v_wo.status, 'order_type', v_wo.order_type,
     'reason', 'Stock placeholder replaced by the customer order WO-2610-0064',
     'marker', v_marker, 'correction', v_file));
end $$;


/* ---------------------------------------------------------------------------
   3. VERIFY. Expect verify_ok = true.
   --------------------------------------------------------------------------- */
select
  w.status                                                                        as wo_status,
  (select string_agg(j.job_number || ':' || j.status, ', ') from jobs j where j.work_order_id = w.id) as jobs,
  (select count(*) from audit_logs l where l.details->>'marker' = 'WO-2610-0050-cancel')               as audit_rows,
  (select h.job_number || ' target ' || (h.quantity + coalesce((select sum(a.requested_qty) from job_merge_allocations a
          where a.host_job_id = h.id and a.is_active), 0)) from jobs h where h.job_number = 'J-000366') as host_now,
  (    w.status = 'cancelled'
   and (select count(*) from jobs j where j.work_order_id = w.id and j.status <> 'cancelled') = 0
   and (select count(*) from audit_logs l where l.details->>'marker' = 'WO-2610-0050-cancel') = 2
  )                                                                               as verify_ok
from work_orders w
where w.wo_number = 'WO-2610-0050';
