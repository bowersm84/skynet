/*
  2026-10-09_TEST_ONLY_reset_j168_to_queued.sql
  TEST ONLY (ylzmyjjqibpbqbwjsnqj). NEVER RUN ON PROD. File under Docs/migrations as TEST-only.

  Why: Batch B's browser pass needs two Start Setups on MZ-5 (the only idle TEST
  machine with queued work): first from the Traveler Kiosk, then from the MZ-5
  machine tablet (regression check of Kiosk.jsx's shared setup helper). Run this
  between the two to put J-000168 back exactly as it was on Oct 9:
  status assigned, setup_start NULL, assigned_user_id NULL, production_start NULL.

  Guarded: only acts while J-000168 is in_setup with production not started.
  Re-running is a no-op. Audit rows and the idle-log row from the kiosk start are
  left in place (they record what happened).

  Run as ONE statement in the TEST SQL Editor. Pure-ASCII block comments only.
*/
with r as (
  update jobs
     set status = 'assigned',
         setup_start = null,
         assigned_user_id = null,
         updated_at = now()
   where job_number = 'J-000168'
     and status = 'in_setup'
     and production_start is null
  returning id
)
select jsonb_build_object(
  'reset', (select count(*) from r),
  'note', case when (select count(*) from r) = 0
               then 'NO-OP: J-000168 is not in setup, or production has started'
               else 'J-000168 is queued again on MZ-5' end
) as result;
