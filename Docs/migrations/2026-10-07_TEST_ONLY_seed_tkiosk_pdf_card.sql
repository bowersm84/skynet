/*
  2026-10-07_TEST_ONLY_seed_tkiosk_pdf_card.sql
  TEST ONLY (ylzmyjjqibpbqbwjsnqj). NEVER RUN ON PROD. File under Docs/migrations as TEST-only.

  Why: every production card on file is Excel, so the Traveler Kiosk's
  Print Production Card button (D-TKIOSK-13 / 13a) can never be clicked on TEST.
  This gives ONE running job a PDF production card so the button can be reviewed.

  What: inserts one job_documents row on J-000175 (MZ-4, in_progress, part AC58)
  typed Production Log (Blank), pointing at that job's own drawing PDF in S3
  (no new file is uploaded; the "card" prints as the drawing). Labelled in
  file_name and notes. Guarded: refuses unless J-000175 is in flight and has no
  production card yet; re-running is a no-op.

  Remove after S14 closes:
    delete from job_documents where notes like 'TEST_ONLY seed (S14 A2)%';

  Run as ONE statement. Pure-ASCII block comments only.
*/
with target as (
  select j.id as job_id, d.file_url, d.file_size
  from jobs j
  join lateral (
    select jd.file_url, jd.file_size
    from job_documents jd
    join document_types dt on dt.id = jd.document_type_id
    where jd.job_id = j.id and dt.code = 'drawing' and jd.file_url is not null
      and lower(jd.file_name) like '%.pdf'
    order by jd.created_at
    limit 1
  ) d on true
  where j.job_number = 'J-000175'
    and j.status in ('assigned', 'in_setup', 'in_progress')
    and not exists (
      select 1 from job_documents x
      join document_types xt on xt.id = x.document_type_id
      where x.job_id = j.id and xt.code = 'production_log_blank'
    )
),
ins as (
  insert into job_documents (job_id, document_type_id, file_name, file_url, mime_type, file_size, status, source, notes, uploaded_by)
  select t.job_id,
         (select id from document_types where code = 'production_log_blank'),
         'TEST_ONLY production card (AC48 drawing).pdf',
         t.file_url,
         'application/pdf',
         t.file_size,
         'approved',
         null,
         'TEST_ONLY seed (S14 A2) - Claude 2026-10-07. Points at this job''s drawing PDF so the Traveler Kiosk Print Production Card button can be reviewed. Remove after S14 closes.',
         null
  from target t
  returning id, job_id
)
select jsonb_build_object(
  'inserted', (select count(*) from ins),
  'seed_doc_id', (select id from ins),
  'job', 'J-000175',
  'note', case when (select count(*) from ins) = 0
               then 'NO-OP: J-000175 not in flight, or it already has a production card'
               else 'seeded' end
) as result;
