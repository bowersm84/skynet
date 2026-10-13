/*
  2026-10-09_TEST_ONLY_reset_j167_to_queued.sql
  TEST ONLY (ylzmyjjqibpbqbwjsnqj). NEVER RUN ON PROD. File under Docs/migrations as TEST-only.

  Why: Batch B's browser pass started J-000167 on MZ-5 from the Traveler Kiosk
  ("Start Setup anyway", Oct 9 10:00). The machine-tablet regression check
  (Batch B VERIFY 3d) needs MZ-5 free, so J-000167 goes back to queued:
  status assigned, setup_start NULL, assigned_user_id NULL - as it was before
  the kiosk start. Applied by Claude on TEST on Oct 9.

  Guarded: only acts while J-000167 is in_setup with production not started.
  Re-running is a no-op. The job_setup_started audit row and the idle-log row
  stay (they record what happened).

  Run as ONE statement. Pure-ASCII block comments only.
*/
with r as (
  update jobs
     set status = 'assigned',
         setup_start = null,
         assigned_user_id = null,
         updated_at = now()
   where job_number = 'J-000167'
     and status = 'in_setup'
     and production_start is null
  returning id
)
select jsonb_build_object(
  'reset', (select count(*) from r),
  'note', case when (select count(*) from r) = 0
               then 'NO-OP: J-000167 is not in setup, or production has started'
               else 'J-000167 is queued again on MZ-5' end
) as result;
