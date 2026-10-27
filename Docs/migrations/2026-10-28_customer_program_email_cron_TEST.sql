/* ===================================================================================== */
/* 2026-10-28_customer_program_email_cron_TEST.sql — S16 Batch B, TEST ONLY */
/* Schedules cp-gmail-ingest every 10 minutes on the TEST project (ylzmyjjqibpbqbwjsnqj). */
/* Run AFTER 2026-10-28_customer_program_email.sql AND after the function is deployed */
/* (verify_jwt off) with the GMAIL_SA_KEY secret set. Re-running replaces the schedule. */
/* The call carries the Vault token cp_ingest_token; the function checks it. */
/* ===================================================================================== */
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cp-gmail-ingest';

SELECT cron.schedule(
  'cp-gmail-ingest',
  '*/10 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ylzmyjjqibpbqbwjsnqj.supabase.co/functions/v1/cp-gmail-ingest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-ingest-token', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cp_ingest_token')),
    body := '{}'::jsonb,
    timeout_milliseconds := 145000);
  $cron$
);

/* ---------------------------------------------------------------- verify (single row) */
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'cp-gmail-ingest';
