/* ===================================================================================== */
/* 2026-10-27_customer_program_kaytech_name.sql — S16 Batch A follow-up (D-CPROG-01) */
/* Renames the Kaytech program so the Dashboards menu and the page header read */
/* "Kaytech Dashboard" (both render customer_programs.name + " Dashboard"). */
/* The committed seed already inserts 'Kaytech'; PROD was seeded from the earlier copy */
/* that inserted 'Kaytech Industries'. The Fishbowl customer link (fb_customer_id 9068) */
/* is unchanged. */
/* Applied on TEST by Claude 2026-10-27 (1 row, KAYTECH | Kaytech). PROD: run by Matt. */
/* Idempotent: a second run updates nothing. */
/* ===================================================================================== */
UPDATE public.customer_programs
   SET name = 'Kaytech'
 WHERE code = 'KAYTECH'
   AND name = 'Kaytech Industries'
RETURNING code, name;

/* Check: expect one row, KAYTECH | Kaytech. */
SELECT code, name FROM public.customer_programs WHERE code = 'KAYTECH';
