/* ============================================================================================
   PROD one-shot: retire the orphaned fb_part_inventory row for SK244-16SENC
   Fishbowl part 9558 (SK244-16SENC) was merged into part 9555 (SK244-16ENC) on 2026-10-06. The bridge
   gives a number Fishbowl no longer knows no row at all, so the old row froze at its 14:56 UTC values
   (qty 0). fb_part_inventory is a mirror cache with no FKs pointing at it; removing a row for a part that
   no longer exists restores "no row = not a Fishbowl part" (D-FB-40). Run block 1, read it, then block 2.
   Follow-up for closeout (bridge): retire rows for numbers that resolve to no Fishbowl part automatically.
   ============================================================================================ */

/* ---------- BLOCK 1 : PREVIEW (read-only). Expect exactly one row: SK244-16SENC, fb_part_id 9558, qty 0,
   skynet_part false, in_valuation 0, stale_minutes > 60. If anything else shows, stop. ---------- */
SELECT i.part_num, i.fb_part_id, i.qty_on_hand, i.snapshot_at,
       i.part_id IS NOT NULL AS skynet_part,
       (SELECT count(*) FROM public.fb_part_valuation v WHERE v.part_key = upper(btrim(i.part_num)) AND v.removed_at IS NULL) AS in_valuation,
       round(extract(epoch FROM (s.last_inventory_at - i.snapshot_at)) / 60) AS stale_minutes
  FROM public.fb_part_inventory i, public.fb_sync_state s
 WHERE s.id = 1
   AND upper(btrim(i.part_num)) = 'SK244-16SENC';

/* ---------- BLOCK 2 : APPLY. Guarded: deletes only if the row is still the orphan the preview showed. ---------- */
DELETE FROM public.fb_part_inventory i
 USING public.fb_sync_state s
 WHERE s.id = 1
   AND upper(btrim(i.part_num)) = 'SK244-16SENC'
   AND i.fb_part_id = 9558
   AND i.part_id IS NULL
   AND i.snapshot_at < s.last_inventory_at - interval '60 minutes'
   AND NOT EXISTS (SELECT 1 FROM public.fb_part_valuation v WHERE v.part_key = 'SK244-16SENC' AND v.removed_at IS NULL)
 RETURNING i.part_num, i.fb_part_id, i.snapshot_at;

/* ---------- BLOCK 3 : VERIFY (its own statement). Expect 0 stale rows. ---------- */
SELECT count(*) AS stale_rows
  FROM public.fb_part_inventory i, public.fb_sync_state s
 WHERE s.id = 1 AND i.snapshot_at < s.last_inventory_at - interval '10 minutes';
