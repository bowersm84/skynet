/* ===========================================================================
   2026-10-27_D-LOT-03_j000380_void_retag_j000391_blank_deduction.sql
   SkyNet MES - WO-2610-0042 (Fastenal Duluth, 1,000 x SK4-15P, Bolt Master 1)

   WHAT THIS DOES
     J-000380  retag blank lot 47927 -> 50346 (dash 2" -> 15), PLN-47927-261022-0003
               -> PLN-50346-261022-0003 (D-LOT-01 tail-preserving rule), then void the
               job the way the app's compliance-reject does: status cancelled,
               compliance_outcome rejected, good_pieces 0. Its 1-pc phantom batch
               FLN-100340 (verified 0) is rejected with 0 good / 0 bad so it leaves the
               compliance queue. job_splits.old_lot_number is backfilled with 47927
               (the RPC left it NULL because blank jobs have no job_materials row).
     J-000391  set blank_lot_number 50346 / blank_dash 15 so finishing deducts blanks by
               verified count (Blanks Phase 2), backfill consume_blank_lot for every
               already-verified send (FLN-100338 = 352), void the floating 1,000-blank
               kiosk Add Material charge (qty 0, linked to the SK4PB15 receipt), and
               resolve the open unknown_lot reconciliation flag.
     audit_logs rows for every write, marker D-LOT-03.

   HOW TO RUN (Supabase SQL Editor, RLS toggle OFF, one block at a time)
     1. PREVIEW  -> one row, expect preview_ok = true   (read-only)
     2. APPLY    -> one DO block; every guard must hold or it raises and writes nothing
     3. VERIFY   -> one row, expect verify_ok = true
   TEST first (seeded replica, 2026-10-27_D-LOT-03_TEST_seed.sql), then PROD, same text.
   =========================================================================== */


/* ---------------------------------------------------------------------------
   1. PREVIEW - current state (read-only). Expect preview_ok = true.
   --------------------------------------------------------------------------- */
select
  j380.job_number                                   as j380,
  j380.status                                       as j380_status,
  j380.blank_lot_number                             as j380_blank_lot,
  j380.blank_dash                                   as j380_dash,
  j380.production_lot_number                        as j380_pln,
  j380.good_pieces                                  as j380_good,
  s340.finishing_lot_number                         as s340_fln,
  s340.quantity                                     as s340_qty,
  s340.verified_count                               as s340_verified,
  s340.compliance_status                            as s340_compliance,
  s340.material_lot_number                          as s340_mat_lot,
  sp.old_lot_number                                 as split_old_lot,
  sp.new_lot_number                                 as split_new_lot,
  j391.job_number                                   as j391,
  j391.blank_lot_number                             as j391_blank_lot,
  j391.production_lot_number                        as j391_pln,
  (select coalesce(sum(verified_count), 0) from finishing_sends where job_id = j391.id)                         as j391_verified_total,
  (select count(*) from material_usage where job_id = j391.id and finishing_send_id is not null)                  as j391_finishing_usage_rows,
  mu.quantity_used                                  as kiosk_charge_qty,
  mu.material_receiving_id                          as kiosk_charge_receipt,
  fl.status                                         as flag_status,
  rcv.id                                            as sk4pb15_receipt,
  ma.used_bars                                      as sk4pb15_used,
  ma.available_bars                                 as sk4pb15_available,
  (   j380.job_number = 'J-000380'
  and j380.status = 'manufacturing_complete'
  and j380.blank_lot_number = '47927'
  and j380.production_lot_number = 'PLN-47927-261022-0003'
  and j380.quantity = 1 and j380.good_pieces = 1
  and s340.job_id = j380.id and s340.finishing_lot_number = 'FLN-100340'
  and s340.quantity = 1 and s340.verified_count = 0
  and s340.compliance_status = 'pending_compliance'
  and s340.production_lot_number = 'PLN-47927-261022-0003'
  and s340.material_lot_number is null
  and sp.original_job_id = j380.id and sp.new_job_id = j391.id
  and sp.old_lot_number is null and sp.new_lot_number = '50346'
  and j391.job_number = 'J-000391'
  and j391.blank_lot_number is null
  and j391.production_lot_number = 'PLN-50346-261023-0004'
  and j391.work_order_id = j380.work_order_id
  and mu.job_id = j391.id and mu.lot_number = '50346'
  and mu.quantity_used = 1000 and mu.material_receiving_id is null and mu.finishing_send_id is null
  and fl.status = 'open' and fl.flag_type = 'unknown_lot' and fl.lot_number = '50346'
  and fl.material_usage_id = mu.id
  and rcv.id is not null
  )                                                 as preview_ok
from (select 1) x
left join jobs j380                           on j380.id = '8a87be74-0dd0-4cbb-96a9-8c46923a22e1'
left join jobs j391                           on j391.id = '4b046e5b-16a6-43c9-b337-0563844e67ad'
left join finishing_sends s340                on s340.id = '739bd49e-0930-4ac8-bf9c-9273a8c9737e'
left join job_splits sp                       on sp.id   = '7a6e7625-8cba-40bd-8b98-db7a403ed444'
left join material_usage mu                   on mu.id   = 'a6867790-820d-49bb-a6c3-dbb85a5323bb'
left join material_reconciliation_flags fl    on fl.id   = '031b6686-ca13-4818-833a-f2f5855833f6'
left join material_receiving rcv              on rcv.category = 'blank' and rcv.lot_number = '50346' and rcv.bar_size = '15'
left join material_availability ma            on ma.material_receiving_id = rcv.id;


/* ---------------------------------------------------------------------------
   2. APPLY - one transaction. Raises (nothing written) if any guard fails.
   --------------------------------------------------------------------------- */
do $$
declare
  v_marker     text := 'D-LOT-03';
  v_file       text := '2026-10-27_D-LOT-03_j000380_void_retag_j000391_blank_deduction.sql';
  v_j380       uuid := '8a87be74-0dd0-4cbb-96a9-8c46923a22e1';   /* J-000380 */
  v_j391       uuid := '4b046e5b-16a6-43c9-b337-0563844e67ad';   /* J-000391 */
  v_s340       uuid := '739bd49e-0930-4ac8-bf9c-9273a8c9737e';   /* FLN-100340 - the 1-pc phantom batch on J-000380 */
  v_split      uuid := '7a6e7625-8cba-40bd-8b98-db7a403ed444';   /* job_splits J-000380 -> J-000391 */
  v_mu_kiosk   uuid := 'a6867790-820d-49bb-a6c3-dbb85a5323bb';   /* J-000391 kiosk charge: 1,000 blanks, no receipt */
  v_flag       uuid := '031b6686-ca13-4818-833a-f2f5855833f6';   /* open unknown_lot flag on that charge */
  v_old_lot    text := '47927';
  v_new_lot    text := '50346';
  v_old_dash   text := '2"';
  v_new_dash   text := '15';
  v_old_pln    text := 'PLN-47927-261022-0003';
  v_new_pln    text := 'PLN-50346-261022-0003';
  v_now        timestamptz := now();
  v_actor      uuid;
  v_recv       uuid;
  v_recv_n     integer;
  v_j380_row   jobs%rowtype;
  v_j391_row   jobs%rowtype;
  v_s340_row   finishing_sends%rowtype;
  v_split_row  job_splits%rowtype;
  v_mu_row     material_usage%rowtype;
  v_flag_row   material_reconciliation_flags%rowtype;
  v_send       record;
  v_result     text;
  v_backfilled jsonb := '[]'::jsonb;
  v_void_note  text;
begin
  /* ---- actor: Matt's admin profile (PROD: mbowers; TEST: mabowers84) ---- */
  v_actor := coalesce(
    (select p.id from profiles p where p.username = 'mbowers' and p.role = 'admin'),
    (select p.id from profiles p where p.username = 'mabowers84'));
  if v_actor is null then
    raise exception 'D-LOT-03: actor profile not found';
  end if;

  /* ---- the SK4PB15 blank receipt (lot 50346, dash 15) must be unique ---- */
  v_recv_n := (select count(*) from material_receiving mr
                where mr.category = 'blank' and mr.lot_number = v_new_lot and mr.bar_size = v_new_dash);
  if v_recv_n <> 1 then
    raise exception 'D-LOT-03: expected exactly one blank receipt for lot % dash %, found %', v_new_lot, v_new_dash, v_recv_n;
  end if;
  v_recv := (select mr.id from material_receiving mr
              where mr.category = 'blank' and mr.lot_number = v_new_lot and mr.bar_size = v_new_dash);

  /* ---- snapshots + guards (absolute expected values) ---- */
  v_j380_row := (select j from jobs j where j.id = v_j380 for update);
  if v_j380_row.id is null then raise exception 'D-LOT-03: J-000380 row not found'; end if;
  if v_j380_row.job_number <> 'J-000380'
     or v_j380_row.status <> 'manufacturing_complete'
     or v_j380_row.blank_lot_number is distinct from v_old_lot
     or v_j380_row.blank_dash is distinct from v_old_dash
     or v_j380_row.production_lot_number is distinct from v_old_pln
     or v_j380_row.quantity <> 1
     or v_j380_row.good_pieces <> 1 then
    raise exception 'D-LOT-03: J-000380 not in expected state (status %, lot %, dash %, pln %, qty %, good %)',
      v_j380_row.status, v_j380_row.blank_lot_number, v_j380_row.blank_dash, v_j380_row.production_lot_number,
      v_j380_row.quantity, v_j380_row.good_pieces;
  end if;

  v_s340_row := (select s from finishing_sends s where s.id = v_s340 for update);
  if v_s340_row.id is null then raise exception 'D-LOT-03: FLN-100340 send not found'; end if;
  if v_s340_row.job_id <> v_j380
     or v_s340_row.finishing_lot_number is distinct from 'FLN-100340'
     or v_s340_row.quantity <> 1
     or coalesce(v_s340_row.verified_count, -1) <> 0
     or v_s340_row.compliance_status is distinct from 'pending_compliance'
     or v_s340_row.production_lot_number is distinct from v_old_pln
     or v_s340_row.material_lot_number is not null then
    raise exception 'D-LOT-03: FLN-100340 not in expected state (qty %, verified %, compliance %, pln %, mat lot %)',
      v_s340_row.quantity, v_s340_row.verified_count, v_s340_row.compliance_status,
      v_s340_row.production_lot_number, v_s340_row.material_lot_number;
  end if;

  v_split_row := (select sp from job_splits sp where sp.id = v_split for update);
  if v_split_row.id is null then raise exception 'D-LOT-03: job_splits row not found'; end if;
  if v_split_row.original_job_id <> v_j380 or v_split_row.new_job_id <> v_j391
     or v_split_row.old_lot_number is not null
     or v_split_row.new_lot_number is distinct from v_new_lot then
    raise exception 'D-LOT-03: job_splits row not in expected state (old %, new %)',
      v_split_row.old_lot_number, v_split_row.new_lot_number;
  end if;

  v_j391_row := (select j from jobs j where j.id = v_j391 for update);
  if v_j391_row.id is null then raise exception 'D-LOT-03: J-000391 row not found'; end if;
  if v_j391_row.job_number <> 'J-000391'
     or v_j391_row.blank_lot_number is not null
     or v_j391_row.production_lot_number is distinct from 'PLN-50346-261023-0004'
     or v_j391_row.work_order_id is distinct from v_j380_row.work_order_id then
    raise exception 'D-LOT-03: J-000391 not in expected state (blank lot %, pln %)',
      v_j391_row.blank_lot_number, v_j391_row.production_lot_number;
  end if;

  v_mu_row := (select mu from material_usage mu where mu.id = v_mu_kiosk for update);
  if v_mu_row.id is null then raise exception 'D-LOT-03: kiosk material_usage row not found'; end if;
  if v_mu_row.job_id is distinct from v_j391
     or v_mu_row.lot_number is distinct from v_new_lot
     or v_mu_row.quantity_used <> 1000
     or v_mu_row.material_receiving_id is not null
     or v_mu_row.finishing_send_id is not null then
    raise exception 'D-LOT-03: kiosk material_usage row not in expected state (qty %, receipt %)',
      v_mu_row.quantity_used, v_mu_row.material_receiving_id;
  end if;

  v_flag_row := (select f from material_reconciliation_flags f where f.id = v_flag for update);
  if v_flag_row.id is null then raise exception 'D-LOT-03: reconciliation flag not found'; end if;
  if v_flag_row.status <> 'open' or v_flag_row.flag_type <> 'unknown_lot'
     or v_flag_row.lot_number is distinct from v_new_lot
     or v_flag_row.material_usage_id is distinct from v_mu_kiosk then
    raise exception 'D-LOT-03: reconciliation flag not in expected state (status %, type %, lot %)',
      v_flag_row.status, v_flag_row.flag_type, v_flag_row.lot_number;
  end if;

  v_void_note := 'Voided (D-LOT-03, 2026-10-27): blank lot keyed as 47927 (the SK4P3 2" blank) at production start on 2026-10-22; the machinist switched to 50346 on 2026-10-23 through Switch Lot, which required a 1-pc placeholder because the kiosk offers no Correct Lot on blank-lot jobs. Finishing verified 0 pieces on FLN-100340. No parts were made under this job; the SK4-15P run is J-000391. Lot retagged 47927 -> 50346 (dash 2" -> 15), PLN-47927-261022-0003 -> PLN-50346-261022-0003.';

  /* ---- 1. J-000380: retag + void ---- */
  update jobs
     set blank_lot_number      = v_new_lot,
         blank_dash            = v_new_dash,
         production_lot_number = v_new_pln,
         status                = 'cancelled',
         compliance_outcome    = 'rejected',
         good_pieces           = 0,
         compliance_notes      = concat_ws(' | ', compliance_notes, v_void_note),
         updated_at            = v_now
   where id = v_j380;

  /* ---- 2. FLN-100340: lot fields follow the retag; batch rejected 0 good / 0 bad ---- */
  update finishing_sends
     set production_lot_number  = v_new_pln,
         material_lot_number    = v_new_lot,
         compliance_status      = 'rejected',
         compliance_outcome     = 'rejected',
         compliance_good_qty    = 0,
         compliance_bad_qty     = 0,
         compliance_approved_by = v_actor,
         compliance_approved_at = v_now,
         compliance_notes       = 'Rejected as void (D-LOT-03): 1-pc placeholder batch from the Switch Lot on J-000380; finishing verified 0 pieces. No parts exist under this batch. See J-000391 (FLN-100338 and the final batch) for the SK4-15P run.',
         updated_at             = v_now
   where id = v_s340;

  /* ---- 3. job_splits: record the lot that was actually keyed before the switch ---- */
  update job_splits
     set old_lot_number = v_old_lot
   where id = v_split;

  /* ---- 4. J-000391: blank identity so finishing deducts by verified count ---- */
  update jobs
     set blank_lot_number = v_new_lot,
         blank_dash       = v_new_dash,
         updated_at       = v_now
   where id = v_j391;

  /* ---- 5. backfill blank consumption for every send already verified (mirrors Finishing.jsx) ---- */
  for v_send in
    select s.id, s.finishing_lot_number, s.verified_count, s.verified_by
      from finishing_sends s
     where s.job_id = v_j391
       and coalesce(s.verified_count, 0) > 0
       and not exists (select 1 from material_usage u where u.finishing_send_id = s.id)
     order by s.sent_at
  loop
    v_result := public.consume_blank_lot(
                  v_send.id, v_j391, v_new_lot, v_send.verified_count,
                  coalesce(v_send.verified_by, v_actor), v_new_dash);
    if v_result <> 'consumed' then
      raise exception 'D-LOT-03: consume_blank_lot for % returned %', v_send.finishing_lot_number, v_result;
    end if;
    v_backfilled := v_backfilled || jsonb_build_object(
      'finishing_send_id', v_send.id, 'fln', v_send.finishing_lot_number, 'verified_count', v_send.verified_count);
  end loop;

  /* ---- 6. void the floating kiosk charge (keep the row, link it, zero it) ---- */
  update material_usage
     set quantity_used         = 0,
         charge_bars           = 0,
         material_receiving_id = v_recv,
         material_id           = (select mr.material_id from material_receiving mr where mr.id = v_recv),
         notes                 = concat_ws(' | ', notes,
           'Voided (D-LOT-03): kiosk Add Material charge on a blank-lot job; blanks are deducted at finishing by verified count (consume_blank_lot). Linked to the SK4PB15 receipt so it is no longer an orphan.')
   where id = v_mu_kiosk;

  /* ---- 7. resolve the unknown_lot flag ---- */
  update material_reconciliation_flags
     set status                = 'resolved',
         material_receiving_id = v_recv,
         resolved_by           = v_actor,
         resolved_at           = v_now,
         resolution_notes      = 'Resolved (D-LOT-03): the 1,000-blank kiosk charge on J-000391 was voided; blanks are deducted at finishing by verified count against SK4PB15 lot 50346.'
   where id = v_flag;

  /* ---- 8. audit trail ---- */
  insert into audit_logs (event_type, job_id, operator_id, details) values
  ('material_lot_corrected', v_j380, v_actor, jsonb_build_object(
      'job_number', 'J-000380', 'old_lot', v_old_lot, 'new_lot', v_new_lot,
      'old_dash', v_old_dash, 'new_dash', v_new_dash, 'old_pln', v_old_pln, 'new_pln', v_new_pln,
      'forced', true, 'reason', 'Blank lot mis-keyed at production start; Switch Lot used because Correct Lot is not offered on blank-lot jobs',
      'finishing_sends_updated', 1, 'job_splits_old_lot_backfilled', v_old_lot,
      'marker', v_marker, 'correction', v_file, 'before', to_jsonb(v_j380_row) - 'compliance_notes')),
  ('job_voided_by_sql', v_j380, v_actor, jsonb_build_object(
      'job_number', 'J-000380', 'mirrors', 'ComplianceReview reject path (status cancelled, compliance_outcome rejected)',
      'reason', 'No parts made under this job; 1-pc placeholder from the Switch Lot. Production continued on J-000391.',
      'good_pieces_before', v_j380_row.good_pieces, 'good_pieces_after', 0,
      'batch_rejected', jsonb_build_object('finishing_send_id', v_s340, 'fln', 'FLN-100340',
                                           'before', to_jsonb(v_s340_row)),
      'marker', v_marker, 'correction', v_file)),
  ('blank_consumption_backfilled', v_j391, v_actor, jsonb_build_object(
      'job_number', 'J-000391', 'blank_lot_number', v_new_lot, 'blank_dash', v_new_dash,
      'material_receiving_id', v_recv, 'sends', v_backfilled,
      'note', 'jobs.blank_lot_number/blank_dash set; later sends deduct at finishing automatically',
      'marker', v_marker, 'correction', v_file)),
  ('material_usage_voided', v_j391, v_actor, jsonb_build_object(
      'reason', 'Kiosk Add Material charge of 1,000 blanks on a blank-lot job, no receipt; consumption is recorded at finishing by verified count',
      'linked_to_receipt', v_recv,
      'marker', v_marker, 'correction', v_file, 'before', to_jsonb(v_mu_row))),
  ('reconciliation_flag_resolved', v_j391, v_actor, jsonb_build_object(
      'lot', v_new_lot, 'linked', true, 'material_receiving_id', v_recv,
      'marker', v_marker, 'correction', v_file, 'before', to_jsonb(v_flag_row)));
end $$;


/* ---------------------------------------------------------------------------
   3. VERIFY - end state. Expect verify_ok = true.
   --------------------------------------------------------------------------- */
select
  (j380.status = 'cancelled' and j380.compliance_outcome = 'rejected' and j380.good_pieces = 0
   and j380.blank_lot_number = '50346' and j380.blank_dash = '15'
   and j380.production_lot_number = 'PLN-50346-261022-0003')                                        as j380_ok,
  (s340.compliance_status = 'rejected' and s340.compliance_good_qty = 0 and s340.compliance_bad_qty = 0
   and s340.production_lot_number = 'PLN-50346-261022-0003' and s340.material_lot_number = '50346')  as fln100340_ok,
  (sp.old_lot_number = '47927' and sp.new_lot_number = '50346')                                      as split_ok,
  (j391.status = 'manufacturing_complete' and j391.blank_lot_number = '50346' and j391.blank_dash = '15'
   and j391.production_lot_number = 'PLN-50346-261023-0004')                                        as j391_ok,
  (select coalesce(sum(u.quantity_used), 0) from material_usage u
    where u.job_id = j391.id and u.finishing_send_id is not null and u.material_receiving_id = rcv.id) as j391_blanks_deducted,
  (select coalesce(sum(s.verified_count), 0) from finishing_sends s where s.job_id = j391.id)         as j391_verified_total,
  (mu.quantity_used = 0 and mu.charge_bars = 0 and mu.material_receiving_id = rcv.id)                 as kiosk_charge_voided,
  (fl.status = 'resolved' and fl.material_receiving_id = rcv.id)                                      as flag_ok,
  ma.used_bars                                                                                       as sk4pb15_used,
  ma.available_bars                                                                                  as sk4pb15_available,
  (select count(*) from finishing_sends s where s.job_id = j380.id and s.compliance_status = 'pending_compliance') as j380_pending_batches,
  (select count(*) from material_reconciliation_flags f where f.lot_number = '50346' and f.status = 'open')        as open_50346_flags,
  (select count(*) from audit_logs a where a.details->>'marker' = 'D-LOT-03')                         as audit_rows,
  (   j380.status = 'cancelled' and j380.compliance_outcome = 'rejected' and j380.good_pieces = 0
  and j380.blank_lot_number = '50346' and j380.blank_dash = '15'
  and j380.production_lot_number = 'PLN-50346-261022-0003'
  and s340.compliance_status = 'rejected' and s340.compliance_good_qty = 0
  and s340.production_lot_number = 'PLN-50346-261022-0003' and s340.material_lot_number = '50346'
  and sp.old_lot_number = '47927'
  and j391.blank_lot_number = '50346' and j391.blank_dash = '15'
  and mu.quantity_used = 0 and mu.charge_bars = 0 and mu.material_receiving_id = rcv.id
  and fl.status = 'resolved'
  and (select coalesce(sum(u.quantity_used), 0) from material_usage u
        where u.job_id = j391.id and u.finishing_send_id is not null and u.material_receiving_id = rcv.id)
      = (select coalesce(sum(s.verified_count), 0) from finishing_sends s where s.job_id = j391.id)
  and (select count(*) from finishing_sends s where s.job_id = j380.id and s.compliance_status = 'pending_compliance') = 0
  and (select count(*) from material_reconciliation_flags f where f.lot_number = '50346' and f.status = 'open') = 0
  and (select count(*) from audit_logs a where a.details->>'marker' = 'D-LOT-03') = 5
  )                                                                                                  as verify_ok
from (select 1) x
left join jobs j380                           on j380.id = '8a87be74-0dd0-4cbb-96a9-8c46923a22e1'
left join jobs j391                           on j391.id = '4b046e5b-16a6-43c9-b337-0563844e67ad'
left join finishing_sends s340                on s340.id = '739bd49e-0930-4ac8-bf9c-9273a8c9737e'
left join job_splits sp                       on sp.id   = '7a6e7625-8cba-40bd-8b98-db7a403ed444'
left join material_usage mu                   on mu.id   = 'a6867790-820d-49bb-a6c3-dbb85a5323bb'
left join material_reconciliation_flags fl    on fl.id   = '031b6686-ca13-4818-833a-f2f5855833f6'
left join material_receiving rcv              on rcv.category = 'blank' and rcv.lot_number = '50346' and rcv.bar_size = '15'
left join material_availability ma            on ma.material_receiving_id = rcv.id;
