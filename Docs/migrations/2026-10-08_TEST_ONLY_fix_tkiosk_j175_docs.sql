/*
  2026-10-08_TEST_ONLY_fix_tkiosk_j175_docs.sql
  TEST ONLY (ylzmyjjqibpbqbwjsnqj). NEVER RUN ON PROD. File under Docs/migrations as TEST-only.

  Why: Matt's A2 test on Oct 8 - Print Production Card on J-000175 (MZ-4)
  failed "file could not be read". TEST's J-000175 drawing row still points at
  the AC48 drawing (jobs/090843b7-.../1786015394902_AC48_-_Sleeve.pdf). On PROD
  that was the wrong drawing for this AC58 job: it was replaced on Sep 29 by
  AC58 - Sleeve.pdf and the AC48 object is no longer in S3. The Oct 7 seed
  (ca134a40) copied the same stale key. TEST predates the PROD fix.

  What (two rows, both on J-000175, guarded on their current keys so a
  re-run is a no-op):
    1. Drawing b1442867-3aa2-4dc1-adea-606830786733 -> PROD's current
       drawing: AC58 - Sleeve.pdf, jobs/090843b7-.../1790692026924_AC58_-_Sleeve.pdf
    2. Seeded card ca134a40-9e25-40ee-ab26-a72d63061de3 -> J-000161's real
       production-card print copy (008 SK26P Stud REV2), made by
       skynet-print-copy 1.1 and downloaded by Matt on Oct 8, so it exists.
       Still labelled TEST_ONLY; notes keep the 'TEST_ONLY seed (S14 A2)'
       prefix so the cleanup line in the Oct 7 seed file still removes it.

  Run as ONE statement. Pure-ASCII block comments only.
*/
with drawing as (
  update job_documents
     set file_name = 'AC58 - Sleeve.pdf',
         file_url  = 'jobs/090843b7-33e3-47ba-a558-382a956d4003/1790692026924_AC58_-_Sleeve.pdf',
         mime_type = 'application/pdf',
         file_size = 159185
   where id = 'b1442867-3aa2-4dc1-adea-606830786733'
     and file_url = 'jobs/090843b7-33e3-47ba-a558-382a956d4003/1786015394902_AC48_-_Sleeve.pdf'
  returning id
),
card as (
  update job_documents
     set file_name = 'TEST_ONLY production card (008 SK26P print copy).pdf',
         file_url  = 'jobs/ca3d824b-f9be-4177-9f2d-02eeef836ec8/1785957603740_008_SK26P_Stud_REV2.xls.print.pdf',
         mime_type = 'application/pdf',
         file_size = null,
         notes     = 'TEST_ONLY seed (S14 A2) - Claude 2026-10-07, repointed 2026-10-08 to J-000161''s real production-card print copy (the AC48 drawing it first used is gone from S3). Remove after S14 closes.'
   where id = 'ca134a40-9e25-40ee-ab26-a72d63061de3'
     and file_url = 'jobs/090843b7-33e3-47ba-a558-382a956d4003/1786015394902_AC48_-_Sleeve.pdf'
  returning id
)
select jsonb_build_object(
  'drawing_rows_updated', (select count(*) from drawing),
  'card_rows_updated', (select count(*) from card),
  'note', case when (select count(*) from drawing) + (select count(*) from card) = 0
               then 'NO-OP: rows already repointed' else 'repointed' end
) as result;
