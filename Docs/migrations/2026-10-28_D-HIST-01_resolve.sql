/* 2026-10-28_D-HIST-01_resolve.sql
   D-HIST-01: link the loaded traveler runs to SkyNet parts, machines and jobs. Run after all six load files.
   Re-runnable: only fills links that are still empty, so run it again after adding parts or aliases.
   Expect rows = 2233 and excluded = 148; the link counts depend on the parts in this database. */

select public.historical_runs_resolve() as result;
