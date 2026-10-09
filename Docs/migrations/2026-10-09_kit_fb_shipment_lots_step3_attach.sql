/* =====================================================================================
   2026-10-09_kit_fb_shipment_lots_step3_attach.sql  --  PROD step 3 of 3
   ONE BLOCK PER RUN. BLOCK A is the dry run (writes, reports, rolls itself back).
   REVIEW STOP after A: paste its output to Claude before BLOCK B.

   EXPECTED (computed independently from ThePull3.csv and PROD's 233 bench lots):
     mirror_rows 2571 | mirror_shipped_kit_rows 2012 | loose_rows_after_a_kit 464
     bench_lots 233 | kit_lots_matched 225 | planned_rows 2495 | inserted_rows 2495
     already_present 0 | off_bom_rows 0 (all 714 kit/part pairs are on the registry BOM)
     unmatched_bench_lots:
       so_not_in_mirror       [4805]            SO 18592SG -- nothing shipped in the pull
       not_shipped_yet        [4864, 4865]      SO 19400 still Entered in Fishbowl
       kit_not_shipped_on_so  [8312, 8344, 8345, 100090, 100105]   (office review)
     kits_shipped_vs_logged: a list for review (kits Fishbowl shipped vs kit lots logged)
   ===================================================================================== */


/* ------------------------------- BLOCK A : dry run --------------------------------- */

SELECT public.kit_attach_fb_shipment_lots() AS dry_run;


/* ------------------------------- BLOCK B : live (after the review stop) ------------ */
/* Expect inserted_rows 2495 and the same counts as BLOCK A. */

SELECT public.kit_attach_fb_shipment_lots(false) AS live_run;


/* ------------------------------- BLOCK C : verify (read-only) ---------------------- */
/* Expect component_rows_total 19472 (16977 + 2495), bench_rows 2495,
   bench_lots_covered 225, needs_review 0, rerun_inserted 0 (the dry rerun proves it
   is idempotent), mirror_rows 2571. */

SELECT jsonb_build_object(
  'component_rows_total', (SELECT count(*) FROM public.kit_lot_component_lots),
  'bench_rows', (SELECT count(*) FROM public.kit_lot_component_lots c
                 JOIN public.kit_lots kl ON kl.id = c.kit_lot_id
                 WHERE kl.source = 'skynet' AND c.source = 'fishbowl_backfill'),
  'bench_lots_covered', (SELECT count(DISTINCT c.kit_lot_id) FROM public.kit_lot_component_lots c
                         JOIN public.kit_lots kl ON kl.id = c.kit_lot_id
                         WHERE kl.source = 'skynet'),
  'needs_review', (SELECT count(*) FROM public.kit_lot_component_lots c
                   JOIN public.kit_lots kl ON kl.id = c.kit_lot_id
                   WHERE kl.source = 'skynet' AND c.needs_review),
  'rerun_inserted', (public.kit_attach_fb_shipment_lots(true)->>'inserted_rows')::integer,
  'mirror_rows', (SELECT count(*) FROM public.fb_shipment_lots)
) AS verify;
