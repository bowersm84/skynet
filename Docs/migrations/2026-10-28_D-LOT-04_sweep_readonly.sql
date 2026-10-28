/* ===========================================================================
   2026-10-28_D-LOT-04_sweep_readonly.sql            READ-ONLY - changes nothing
   SkyNet MES - blank/material leftovers to review before any data correction

   Three queries. Run each one alone in the SQL Editor (it shows only the last
   result set) and export the grid. Each returns well under 100 rows.
     Q1  Bolt Master jobs past setup with no blank lot recorded
     Q2  material_usage rows with quantity and no receipt, one row per job
     Q3  open material reconciliation flags
   Mark up what each row should become; corrections come as a separate,
   TEST-rehearsed file afterwards (the D-LOT-03 pattern).
   =========================================================================== */


/* ---------------------------------------------------------------------------
   Q1 - Bolt Master jobs past setup with no blank lot recorded
        bar_material = what the kiosk Add Material screen recorded instead
        verified = pieces finishing verified (what blanks would be deducted on)
   --------------------------------------------------------------------------- */
select
  j.job_number,
  m.code                                                        as machine,
  p.part_number,
  j.status,
  w.wo_number,
  w.customer,
  to_char(j.production_start at time zone 'America/New_York', 'YYYY-MM-DD') as started,
  j.production_lot_number                                       as pln,
  (select string_agg(distinct coalesce(jm.material_type, '?') || ' / ' || coalesce(jm.bar_size, '?') || ' / lot ' || coalesce(jm.lot_number, '?'), '; ')
     from job_materials jm where jm.job_id = j.id)             as bar_material,
  (select coalesce(sum(u.quantity_used), 0) from material_usage u
    where u.job_id = j.id and u.finishing_send_id is null)     as kiosk_charged,
  (select count(*) from material_usage u
    where u.job_id = j.id and u.material_receiving_id is null and u.quantity_used > 0) as receiptless_rows,
  (select coalesce(sum(f.verified_count), 0) from finishing_sends f where f.job_id = j.id) as verified,
  (select count(*) from finishing_sends f where f.job_id = j.id and f.compliance_status = 'approved') as approved_batches,
  (select string_agg(distinct f.material_lot_number, ', ') from finishing_sends f where f.job_id = j.id) as send_material_lots
from jobs j
join machines m on m.id = j.assigned_machine_id
left join parts p on p.id = j.component_id
left join work_orders w on w.id = j.work_order_id
where m.code ilike 'bm%'
  and j.blank_lot_number is null
  and j.production_lot_number is not null
  and j.status not in ('cancelled', 'assigned', 'ready', 'pending_compliance', 'in_setup')
order by j.production_start;


/* ---------------------------------------------------------------------------
   Q2 - material_usage rows with quantity and no receipt, one row per job
        kind: kiosk = Add Material charge; finishing = blank consumption at finishing
   --------------------------------------------------------------------------- */
select
  coalesce(j.job_number, '(no job)')                            as job_number,
  m.code                                                        as machine,
  p.part_number,
  j.status,
  string_agg(distinct u.lot_number, ', ')                       as lots,
  string_agg(distinct case when u.finishing_send_id is null then 'kiosk' else 'finishing' end, ', ') as kind,
  count(*)                                                      as rows,
  sum(u.quantity_used)                                          as qty,
  (select string_agg(distinct coalesce(jm.material_type, '?') || ' / ' || coalesce(jm.bar_size, '?'), '; ')
     from job_materials jm where jm.job_id = j.id)             as job_material,
  (select count(*) from material_receiving mr
    where mr.lot_number = any (array_agg(u.lot_number)))       as receipts_with_that_lot,
  (select count(*) from material_reconciliation_flags f
    where f.status = 'open' and f.material_usage_id = any (array_agg(u.id))) as open_flags,
  to_char(min(u.used_at) at time zone 'America/New_York', 'YYYY-MM-DD') as first_used,
  to_char(max(u.used_at) at time zone 'America/New_York', 'YYYY-MM-DD') as last_used
from material_usage u
left join jobs j on j.id = u.job_id
left join machines m on m.id = j.assigned_machine_id
left join parts p on p.id = j.component_id
where u.material_receiving_id is null
  and u.quantity_used > 0
group by j.id, j.job_number, m.code, p.part_number, j.status
order by m.code nulls last, min(u.used_at);


/* ---------------------------------------------------------------------------
   Q3 - open material reconciliation flags
   --------------------------------------------------------------------------- */
select
  f.flag_type,
  f.lot_number,
  f.material_type,
  f.bar_size,
  f.quantity_delta,
  f.occurrence_count,
  j.job_number,
  m.code                                                        as machine,
  p.part_number,
  to_char(f.raised_at at time zone 'America/New_York', 'YYYY-MM-DD') as raised,
  to_char(f.last_seen_at at time zone 'America/New_York', 'YYYY-MM-DD') as last_seen,
  (select count(*) from material_receiving mr where mr.lot_number = f.lot_number) as receipts_with_that_lot
from material_reconciliation_flags f
left join jobs j on j.id = f.job_id
left join machines m on m.id = j.assigned_machine_id
left join parts p on p.id = j.component_id
where f.status = 'open'
order by f.flag_type, f.raised_at;
