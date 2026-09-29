-- =====================================================================================
-- 2026-09-29_PROD_material_traceability_cleanup.sql
-- Step 1 of the raw-material inventory correction: traceability rows only.
--
-- Target:   PROD (luzungoqfuplspzbqctb). Rehearsed on TEST (ylzmyjjqibpbqbwjsnqj)
--           2026-09-29: dry run, live run, idempotent re-run (all SKIP).
-- Run with: $env:PGCLIENTENCODING = 'UTF8'
--           & C:\pgsql\bin\psql.exe $env:PROD_DB_URL -f 2026-09-29_PROD_material_traceability_cleanup.sql
--           (Session pooler, port 5432.) No psql meta-commands in this file.
-- Default:  DRY RUN. The last line is ROLLBACK. Review the NOTICE summary and the
--           verification result, then change the last line to COMMIT; and run again.
-- Re-run:   Idempotent. Each item detects its own applied state and reports SKIP.
--           Anything in neither the expected before-state nor the applied state
--           raises a named GUARD_ exception and nothing is written.
--
-- What it does (8 items, no deletes, no UUIDs hardcoded, located by business keys):
--   A. Void three stray usage entries, each keyed and then removed BEFORE that job's
--      Start Production, so the lot never made parts on the job. Follows the
--      J-000188 precedent (2026-08-20): row kept, quantity zeroed, "Voided ..." note.
--      Additionally clears the receipt link (the cert package pulls mill certs and
--      heat numbers from it) and the lot number (link_unknown_lot_usage re-attaches
--      ANY unlinked row carrying the flag's lot, regardless of material or date).
--      The keyed lot, bars and inches are preserved in the note and in audit_logs.
--        J-000087  lot 2587  12 bars  0.375 41L40 on a 0.750 job; ran lot 2548
--        J-000147  lot 2566   6 bars  rack-staged; machinist ran lot 2610
--        J-000223  lot 2634   2 bars  keyed as 303; lot is received as 304; ran 2530
--   B. Re-point one rack staging to the job it was meant for.
--        J-000094 -> J-000043  lot 2610  2 bars (Jun 26). Scott was staging 2610 to
--        J-000043 on MZ-4 two bars at a time (Jun 24, 24, 25; Patrick Jun 29 at the
--        machine); J-000094 is a 7075 0.500 job and removed the entry before start.
--        Same lot, same cert as J-000043 already carries. Inventory unchanged.
--        J-000043 job_materials.bars_loaded is NOT bumped (27 stays): its record is
--        a 144" bar on MZ-4 (limit 48"), predating the limit, so
--        trg_enforce_machine_bar_length rejects any update to that row. J-000043
--        will read 29 charged / 27 loaded; the note on the row explains why.
--   C. Correct the material name on three job records to match BOTH the part master
--      and the lot's receipt (the cert package prints job_materials.material_type).
--        J-000096     lot 2608  4140 Steel        -> 41L40 Steel
--        J-000155     lot 2376  6061-T6 Aluminum  -> 7075-T6 Aluminum
--        RQ-98484131  lot 2616  4140 Steel        -> 4130 Steel
--      material_loads is left as keyed (it is the append-only record of what the
--      operator entered); the correction is recorded in audit_logs.
--   D. Resolve the open unknown_lot flag on lot 2634 (raised by the J-000223 entry)
--      WITHOUT linking, so nobody attaches a 304 receipt to a 303 job.
--
-- Balance effects (bar basis, as the Inventory screen shows it). All are absorbed by
-- the step 3 full count; none needs an adjustment now:
--   2587 144" line  -15 -> -3   (+12, J-000087 void)
--   2566 144" line  +6          (J-000147 void)
--   2610, 2634      unchanged
--
-- Out of scope here (see the 2026-09-29 findings): J-000087's part master says
-- 8620 Steel while the job ran 41L40 (Quality ruling); RQ-98484131's approved cert
-- package FLN-100052-CP2 (Quality); null-lot usage rows; pre-count unlinked usage;
-- Nylon naming; bar lengths. The link_unknown_lot_usage fix rides step 2.
-- =====================================================================================

BEGIN;

-- -------------------------------------------------------------------------------------
-- 0. PREVIEW: current state of every target (read-only)
-- -------------------------------------------------------------------------------------
select 'usage' as kind, j.job_number as job, to_char(mu.used_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') as key,
       concat_ws(' | ', 'lot ' || coalesce(mu.lot_number, '(null)'), mu.quantity_used || ' bars', mu.quantity_used_inches || ' in',
                 case when mu.material_receiving_id is null then 'unlinked' else 'linked' end, right(coalesce(mu.notes, ''), 90)) as state
from material_usage mu join jobs j on j.id = mu.job_id
where mu.used_at in ('2026-07-07 13:37:58.516+00', '2026-08-06 19:17:45.023+00', '2026-09-23 13:50:22.599+00', '2026-06-26 15:32:53.316+00')
  and j.job_number in ('J-000087', 'J-000147', 'J-000223', 'J-000094', 'J-000043')
union all
select 'job_materials', j.job_number, jm.lot_number, concat_ws(' | ', jm.material_type, jm.bar_size, jm.bars_loaded || ' loaded')
from job_materials jm join jobs j on j.id = jm.job_id
where j.job_number in ('J-000096', 'J-000155', 'RQ-98484131', 'J-000043')
union all
select 'flag', coalesce(j.job_number, '-'), f.lot_number, concat_ws(' | ', f.flag_type, f.status, 'x' || f.occurrence_count, f.resolution_notes)
from material_reconciliation_flags f left join jobs j on j.id = f.job_id
where f.flag_type = 'unknown_lot' and f.lot_number = '2634'
order by 1, 2;


-- -------------------------------------------------------------------------------------
-- 1. CORRECTION (guarded, idempotent)
-- -------------------------------------------------------------------------------------
DO $$
declare
  c_marker  constant text := 'TRACE-0929';
  c_tag     constant text := '2026-09-29_PROD_material_traceability_cleanup.sql';
  c_ts_94   constant timestamptz := '2026-06-26 15:32:53.316+00';
  -- TEST rehearsal hook only: when skybolt.dry_run = 'on' the block raises at the end
  -- so everything rolls back. Not set in this file; the ROLLBACK line is the dry run.
  v_dry     boolean := coalesce(current_setting('skybolt.dry_run', true), '') = 'on';
  v_summary text := '';
  v_applied int := 0;
  v_skipped int := 0;
  r         record;
  v_job     uuid;
  v_job2    uuid;
  v_id      uuid;
  v_n       int;
  v_before  jsonb;
begin
  -- ---------------------------------------------------------------------------
  -- A. Void stray entries removed before Start Production
  -- ---------------------------------------------------------------------------
  for r in
    select * from (values
      ('J-000087', '2026-07-07 13:37:58.516+00'::timestamptz, '2587', 12, 576::numeric, true,  '2548',
       'Keyed 12 x 0.375 dia 41L40 on a 0.750 dia job; removed 29 min later and replaced by lot 2548 before Start Production.'),
      ('J-000147', '2026-08-06 19:17:45.023+00'::timestamptz, '2566',  6, 288::numeric, true,  '2610',
       'Rack-staged as lot 2566; machinist entered 2610 at the machine (lot_mismatch 2026-08-07); entry removed and job started on 2610.'),
      ('J-000223', '2026-09-23 13:50:22.599+00'::timestamptz, '2634',  2, 288::numeric, false, '2530',
       'Keyed lot 2634 as 303 (the lot is received as 304); removed 28 min later and replaced by lot 2530 before Start Production.')
    ) as t(job_number, used_at, lot, qty, inches, linked, ran_lot, reason)
  loop
    v_job := (select j.id from jobs j where j.job_number = r.job_number);
    if v_job is null then
      raise exception 'GUARD_JOB_MISSING: % not found', r.job_number;
    end if;

    v_n := (select count(*) from material_usage mu where mu.job_id = v_job and mu.used_at = r.used_at);
    if v_n <> 1 then
      raise exception 'GUARD_ROW_COUNT: % usage at % matched % rows, expected 1', r.job_number, r.used_at, v_n;
    end if;
    v_id := (select mu.id from material_usage mu where mu.job_id = v_job and mu.used_at = r.used_at);

    if coalesce((select mu.quantity_used = 0 and mu.lot_number is null
                        and coalesce(mu.notes, '') like '%' || c_marker || '%'
                   from material_usage mu where mu.id = v_id), false) then
      v_skipped := v_skipped + 1;
      v_summary := v_summary || format(E'\n  SKIP   A %s: lot %s entry already voided', r.job_number, r.lot);
      continue;
    end if;

    if not coalesce((select mu.lot_number = r.lot and mu.quantity_used = r.qty and mu.quantity_used_inches = r.inches
                            and (mu.material_receiving_id is not null) = r.linked
                            and mu.finishing_send_id is null
                       from material_usage mu where mu.id = v_id), false) then
      raise exception 'GUARD_PRESTATE: % usage % is not lot % / % bars / % in / linked=%',
        r.job_number, v_id, r.lot, r.qty, r.inches, r.linked;
    end if;

    -- The premise, checked rather than assumed: entry before Start Production, job ran another lot.
    if not coalesce((select j.production_start > r.used_at from jobs j where j.id = v_job), false) then
      raise exception 'GUARD_PREMISE: % started production before its lot % entry', r.job_number, r.lot;
    end if;
    if not exists (select 1 from job_materials jm where jm.job_id = v_job and jm.lot_number = r.ran_lot) then
      raise exception 'GUARD_PREMISE: % job_materials lot is not %', r.job_number, r.ran_lot;
    end if;

    v_before := (select to_jsonb(mu) from material_usage mu where mu.id = v_id);

    update material_usage mu set
        quantity_used         = 0,
        quantity_used_inches  = 0,
        material_receiving_id = null,
        material_id           = null,
        lot_number            = null,
        notes = concat_ws(' | ', mu.notes, format(
          'Voided 2026-09-29 (%s): keyed as lot %s, %s bars, %s in; removed before Start Production, job ran lot %s. '
          'Lot cleared so Reconciliation linking cannot re-attach it. (M. Bowers)',
          c_marker, r.lot, r.qty, r.inches, r.ran_lot))
     where mu.id = v_id;

    insert into audit_logs (event_type, job_id, details)
    values ('material_usage_voided', v_job,
            jsonb_build_object('correction', c_tag, 'marker', c_marker, 'reason', r.reason, 'before', v_before));

    v_applied := v_applied + 1;
    v_summary := v_summary || format(E'\n  APPLY  A %s: voided lot %s entry (%s bars)', r.job_number, r.lot, r.qty);
  end loop;

  -- ---------------------------------------------------------------------------
  -- B. Re-point the Jun 26 rack staging of lot 2610 from J-000094 to J-000043
  -- ---------------------------------------------------------------------------
  v_job  := (select j.id from jobs j where j.job_number = 'J-000094');
  v_job2 := (select j.id from jobs j where j.job_number = 'J-000043');
  if v_job is null or v_job2 is null then
    raise exception 'GUARD_JOB_MISSING: J-000094 or J-000043 not found';
  end if;

  v_n := (select count(*) from material_usage mu where mu.job_id in (v_job, v_job2) and mu.used_at = c_ts_94);
  if v_n <> 1 then
    raise exception 'GUARD_ROW_COUNT: 2610 staging at % matched % rows, expected 1', c_ts_94, v_n;
  end if;
  v_id := (select mu.id from material_usage mu where mu.job_id in (v_job, v_job2) and mu.used_at = c_ts_94);

  if coalesce((select mu.job_id = v_job2 and coalesce(mu.notes, '') like '%' || c_marker || '%'
                 from material_usage mu where mu.id = v_id), false) then
    v_skipped := v_skipped + 1;
    v_summary := v_summary || E'\n  SKIP   B J-000094 -> J-000043: already re-pointed';
  else
    if not coalesce((select mu.job_id = v_job and mu.lot_number = '2610' and mu.quantity_used = 2
                            and mu.quantity_used_inches = 288 and mu.finishing_send_id is null
                            and mr.lot_number = '2610' and mr.material_type = '6061-T6 Aluminum' and mr.bar_size = '1.250 dia'
                       from material_usage mu join material_receiving mr on mr.id = mu.material_receiving_id
                      where mu.id = v_id), false) then
      raise exception 'GUARD_PRESTATE: 2610 staging row % is not J-000094 / 2 bars / 288 in / linked to a 6061 1.250 lot 2610 receipt', v_id;
    end if;
    -- Premise: J-000043 is a 6061 1.250 job on lot 2610, running on the same machine on Jun 26;
    -- J-000094 had not started.
    if not coalesce((select jm.lot_number = '2610' and jm.material_type = '6061-T6 Aluminum' and jm.bar_size = '1.250 dia'
                       from job_materials jm where jm.job_id = v_job2), false) then
      raise exception 'GUARD_PREMISE: J-000043 is not a 6061-T6 1.250 lot 2610 job';
    end if;
    if not coalesce((select j43.production_start < c_ts_94 and j43.actual_end > c_ts_94
                            and j94.production_start > c_ts_94
                            and j43.assigned_machine_id = j94.assigned_machine_id
                       from jobs j43, jobs j94 where j43.id = v_job2 and j94.id = v_job), false) then
      raise exception 'GUARD_PREMISE: J-000043 was not running on J-000094''s machine at %, or J-000094 had started', c_ts_94;
    end if;

    v_before := (select to_jsonb(mu) from material_usage mu where mu.id = v_id);

    update material_usage mu set
        job_id = v_job2,
        notes  = concat_ws(' | ', mu.notes, format(
          'Re-pointed 2026-09-29 (%s) from J-000094 to J-000043: rack staging of 2 bars of 2610 on MZ-4 during '
          'J-000043''s run (staged 2 at a time Jun 24-29); J-000094 is a 7075 0.500 job and removed the entry before start. '
          'J-000043 bars_loaded left at 27 (machine bar-length trigger blocks updates to that row). (M. Bowers)', c_marker))
     where mu.id = v_id;

    insert into audit_logs (event_type, job_id, details)
    values ('material_usage_repointed', v_job2,
            jsonb_build_object('correction', c_tag, 'marker', c_marker, 'from_job', 'J-000094', 'to_job', 'J-000043', 'before', v_before));

    v_applied := v_applied + 1;
    v_summary := v_summary || E'\n  APPLY  B J-000094 -> J-000043: 2 bars of 2610 re-pointed';
  end if;

  -- ---------------------------------------------------------------------------
  -- C. Material name on three job records -> matches part master AND lot receipt
  -- ---------------------------------------------------------------------------
  for r in
    select * from (values
      ('J-000096',    '2608', '4140 Steel',       '41L40 Steel'),
      ('J-000155',    '2376', '6061-T6 Aluminum', '7075-T6 Aluminum'),
      ('RQ-98484131', '2616', '4140 Steel',       '4130 Steel')
    ) as t(job_number, lot, old_type, new_type)
  loop
    v_job := (select j.id from jobs j where j.job_number = r.job_number);
    if v_job is null then
      raise exception 'GUARD_JOB_MISSING: % not found', r.job_number;
    end if;

    v_n := (select count(*) from job_materials jm where jm.job_id = v_job);
    if v_n <> 1 then
      raise exception 'GUARD_ROW_COUNT: % has % job_materials rows, expected 1', r.job_number, v_n;
    end if;

    if exists (select 1 from job_materials jm where jm.job_id = v_job and jm.material_type = r.new_type and jm.lot_number = r.lot) then
      v_skipped := v_skipped + 1;
      v_summary := v_summary || format(E'\n  SKIP   C %s: already %s', r.job_number, r.new_type);
      continue;
    end if;

    if not exists (select 1 from job_materials jm where jm.job_id = v_job and jm.material_type = r.old_type and jm.lot_number = r.lot) then
      raise exception 'GUARD_PRESTATE: % job_materials is not % lot %', r.job_number, r.old_type, r.lot;
    end if;

    -- Premise: the part master and the lot's receipt(s) both say new_type; no receipt of this lot says old_type.
    if coalesce((select mt.name from jobs j join parts p on p.id = j.component_id
                   join material_types mt on mt.id = p.material_type_id where j.id = v_job), '') <> r.new_type then
      raise exception 'GUARD_PREMISE: % part master material is not %', r.job_number, r.new_type;
    end if;
    if not exists (select 1 from material_receiving mr where mr.lot_number = r.lot and mr.material_type = r.new_type)
       or exists (select 1 from material_receiving mr where mr.lot_number = r.lot and mr.material_type = r.old_type) then
      raise exception 'GUARD_PREMISE: lot % receipts do not uniformly say %', r.lot, r.new_type;
    end if;

    v_before := (select to_jsonb(jm) from job_materials jm where jm.job_id = v_job);

    update job_materials jm set material_type = r.new_type, updated_at = now() where jm.job_id = v_job;

    insert into audit_logs (event_type, job_id, details)
    values ('job_material_type_corrected', v_job,
            jsonb_build_object('correction', c_tag, 'marker', c_marker, 'lot', r.lot,
                               'from', r.old_type, 'to', r.new_type,
                               'basis', 'part master and lot receipt agree', 'before', v_before));

    v_applied := v_applied + 1;
    v_summary := v_summary || format(E'\n  APPLY  C %s: %s -> %s', r.job_number, r.old_type, r.new_type);
  end loop;

  -- ---------------------------------------------------------------------------
  -- D. Resolve the open unknown_lot flag on lot 2634 without linking
  -- ---------------------------------------------------------------------------
  v_job := (select j.id from jobs j where j.job_number = 'J-000223');

  if exists (select 1 from material_reconciliation_flags f
              where f.flag_type = 'unknown_lot' and f.lot_number = '2634' and f.job_id = v_job
                and f.status = 'resolved' and coalesce(f.resolution_notes, '') like '%' || c_marker || '%') then
    v_skipped := v_skipped + 1;
    v_summary := v_summary || E'\n  SKIP   D lot 2634 unknown_lot flag: already resolved';
  else
    v_n := (select count(*) from material_reconciliation_flags f
             where f.flag_type = 'unknown_lot' and f.lot_number = '2634' and f.job_id = v_job and f.status = 'open');
    if v_n <> 1 then
      raise exception 'GUARD_ROW_COUNT: % open unknown_lot flags for 2634 / J-000223, expected 1', v_n;
    end if;
    v_id := (select f.id from material_reconciliation_flags f
              where f.flag_type = 'unknown_lot' and f.lot_number = '2634' and f.job_id = v_job and f.status = 'open');
    if (select f.occurrence_count from material_reconciliation_flags f where f.id = v_id) <> 1 then
      raise exception 'GUARD_PRESTATE: lot 2634 flag has more than one occurrence; another entry shares it';
    end if;
    -- Nothing may still be waiting to be linked on this lot once A has run.
    if exists (select 1 from material_usage mu where mu.lot_number = '2634' and mu.material_receiving_id is null) then
      raise exception 'GUARD_PREMISE: unlinked usage on lot 2634 remains; resolve it first';
    end if;

    v_before := (select to_jsonb(f) from material_reconciliation_flags f where f.id = v_id);

    update material_reconciliation_flags f set
        status           = 'resolved',
        resolved_at      = now(),
        resolution_notes = format(
          'Resolved 2026-09-29 (%s) without linking: the J-000223 entry keyed lot 2634 as 303 (the lot is received as 304) '
          'and was removed before Start Production; the job ran lot 2530. Usage row voided. (M. Bowers)', c_marker)
     where f.id = v_id;

    insert into audit_logs (event_type, job_id, details)
    values ('reconciliation_flag_resolved', v_job,
            jsonb_build_object('correction', c_tag, 'marker', c_marker, 'lot', '2634', 'linked', false, 'before', v_before));

    v_applied := v_applied + 1;
    v_summary := v_summary || E'\n  APPLY  D lot 2634 unknown_lot flag resolved, not linked';
  end if;

  v_summary := format('%s: %s applied, %s skipped', c_tag, v_applied, v_skipped) || v_summary;
  raise notice '%', v_summary;
  if v_dry then
    raise exception 'DRY RUN, rolled back. %', v_summary;
  end if;
end $$;


-- -------------------------------------------------------------------------------------
-- 2. VERIFY: state after the block, inside the same transaction
--    Expect: 3 usage rows at 0 bars / lot (null) / unlinked / TRACE-0929 note;
--            the 2610 row on J-000043; three job_materials names corrected;
--            the 2634 flag resolved; 8 audit rows (3 voided, 1 repointed,
--            3 type_corrected, 1 flag_resolved), or no new ones on a re-run.
--            Expected PROD balances after: 2587 144" -3, 2587 48" 13, 2566 144" 29,
--            2610 unchanged.
-- -------------------------------------------------------------------------------------
select 'usage' as kind, j.job_number as job, to_char(mu.used_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') as key,
       concat_ws(' | ', 'lot ' || coalesce(mu.lot_number, '(null)'), mu.quantity_used || ' bars', mu.quantity_used_inches || ' in',
                 case when mu.material_receiving_id is null then 'unlinked' else 'linked' end, right(coalesce(mu.notes, ''), 90)) as state
from material_usage mu join jobs j on j.id = mu.job_id
where mu.used_at in ('2026-07-07 13:37:58.516+00', '2026-08-06 19:17:45.023+00', '2026-09-23 13:50:22.599+00', '2026-06-26 15:32:53.316+00')
  and j.job_number in ('J-000087', 'J-000147', 'J-000223', 'J-000094', 'J-000043')
union all
select 'job_materials', j.job_number, jm.lot_number, concat_ws(' | ', jm.material_type, jm.bar_size, jm.bars_loaded || ' loaded')
from job_materials jm join jobs j on j.id = jm.job_id
where j.job_number in ('J-000096', 'J-000155', 'RQ-98484131', 'J-000043')
union all
select 'flag', coalesce(j.job_number, '-'), f.lot_number, concat_ws(' | ', f.flag_type, f.status, left(f.resolution_notes, 90))
from material_reconciliation_flags f left join jobs j on j.id = f.job_id
where f.flag_type = 'unknown_lot' and f.lot_number = '2634'
union all
select 'balance', mr.lot_number, mr.bar_length_inches || '"', round(sum(v.available_bars), 1) || ' bars (screen basis)'
from material_receiving mr join material_availability v on v.material_receiving_id = mr.id
where mr.category = 'bar' and mr.lot_number in ('2587', '2566', '2610')
group by mr.lot_number, mr.bar_length_inches
union all
select 'audit', a.event_type, count(*)::text, 'rows tagged TRACE-0929'
from audit_logs a where a.details->>'marker' = 'TRACE-0929'
group by a.event_type
order by 1, 2, 3;

ROLLBACK;   -- DRY RUN. After reviewing the NOTICE and the VERIFY result, change this line to COMMIT; and run again.
