-- =====================================================================================
-- 2026-09-29_PROD_blank_lot_48096_material_fix.sql
-- Lot 48096: the 2700 dash 9 blank receipt entered 2026-09-29 15:15 (7,950 pcs, AJ
-- Fasteners) was keyed as 2700 Steel. It is 2700 Stainless (Matt, 2026-09-29).
--
-- Target:   PROD only (luzungoqfuplspzbqctb). The row does not exist on TEST (TEST was
--           copied before it was entered), so there is no TEST run.
-- Run with: $env:PGCLIENTENCODING = 'UTF8'
--           & C:\pgsql\bin\psql.exe $env:PROD_DB_URL -v ON_ERROR_STOP=1 -P pager=off -f .\2026-09-29_PROD_blank_lot_48096_material_fix.sql
-- Default:  DRY RUN. The last line is ROLLBACK. Change it to COMMIT; after review.
-- Re-run:   Idempotent: once corrected, the block skips with a NOTICE.
--
-- Changes one receipt: material_type 2700 Steel -> 2700 Stainless, and blank_type_id to
-- the AJ Fasteners 2700 Stainless dash 9 blank type. Quantity, lot, dash, price, rack
-- and documents are unchanged. Nothing has been consumed from the receipt (the block
-- stops if that is no longer true). Before-image to audit_logs, tag BLANK-48096-0929.
-- Works before or after the D-INV-08 guard: lot 48096 is a legacy shared-dash lot, and
-- this edit keeps the vendor and creates no new conflict.
-- =====================================================================================

BEGIN;

-- PREVIEW
SELECT mr.lot_number, mr.material_type, mr.bar_size AS dash, mr.quantity, mr.vendor,
       bt.stud_series, bt.stud_length, bt.material_type AS blank_type_material,
       to_char(mr.created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') AS created
  FROM material_receiving mr
  LEFT JOIN blank_types bt ON bt.id = mr.blank_type_id
 WHERE mr.lot_number = '48096'
 ORDER BY mr.received_at;

DO $$
DECLARE
  v_stainless  uuid;
  v_n          int;
  v_done       int;
  v_used       int;
  r            record;
BEGIN
  v_stainless := (SELECT bt.id FROM blank_types bt
                   WHERE bt.stud_series::text = '2700' AND bt.stud_length::text = '9'
                     AND bt.material_type = 'Stainless' AND bt.vendor = 'AJ Fasteners' AND bt.is_active);
  IF v_stainless IS NULL THEN
    RAISE EXCEPTION 'GUARD_BLANK_TYPE: no active AJ Fasteners 2700 Stainless dash 9 blank type';
  END IF;

  v_n := (SELECT count(*) FROM material_receiving
           WHERE lot_number = '48096' AND category = 'blank' AND material_type = '2700 Steel'
             AND bar_size = '9' AND quantity = 7950 AND vendor = 'AJ Fasteners'
             AND (created_at AT TIME ZONE 'America/New_York')::date = '2026-09-29');
  v_done := (SELECT count(*) FROM material_receiving
              WHERE lot_number = '48096' AND category = 'blank' AND material_type = '2700 Stainless'
                AND bar_size = '9' AND quantity = 7950 AND blank_type_id = v_stainless);

  IF v_n = 0 AND v_done = 1 THEN
    RAISE NOTICE 'Lot 48096 dash 9 is already 2700 Stainless - skipped';
    RETURN;
  END IF;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'GUARD_TARGET: expected 1 2700 Steel dash 9 receipt on lot 48096 (7,950 pcs, entered 2026-09-29), found % (% already corrected)', v_n, v_done;
  END IF;

  FOR r IN SELECT * FROM material_receiving
            WHERE lot_number = '48096' AND category = 'blank' AND material_type = '2700 Steel'
              AND bar_size = '9' AND quantity = 7950 AND vendor = 'AJ Fasteners'
              AND (created_at AT TIME ZONE 'America/New_York')::date = '2026-09-29'
  LOOP
    v_used := (SELECT count(*) FROM material_usage mu WHERE mu.material_receiving_id = r.id AND mu.quantity_used > 0)
            + (SELECT count(*) FROM inventory_adjustment_requests iar WHERE iar.material_receiving_id = r.id);
    IF v_used > 0 THEN
      RAISE EXCEPTION 'GUARD_IN_USE: % usage or count rows already reference this receipt; stop and review before changing its material', v_used;
    END IF;

    INSERT INTO audit_logs (event_type, details)
    VALUES ('material_receipt_corrected', jsonb_build_object(
              'tag', 'BLANK-48096-0929', 'decision', 'D-INV-08',
              'change', 'material 2700 Steel -> 2700 Stainless; blank type -> AJ Fasteners 2700 Stainless dash 9',
              'reason', 'Keyed as Steel in error at receiving (Matt Bowers, 2026-09-29)',
              'before', to_jsonb(r)));

    UPDATE material_receiving
       SET material_type = '2700 Stainless', blank_type_id = v_stainless
     WHERE id = r.id;
  END LOOP;

  RAISE NOTICE 'Lot 48096 dash 9 moved to 2700 Stainless';
END $$;

-- VERIFY
SELECT 'lot 48096 rows' AS item,
       (SELECT string_agg(material_type || ' dash ' || bar_size || ' q' || quantity, ' | ' ORDER BY received_at)
          FROM material_receiving WHERE lot_number = '48096') AS state
UNION ALL
SELECT 'materials on lot 48096 (expect 1: 2700 Stainless)',
       (SELECT count(DISTINCT material_type)::text || ': ' || string_agg(DISTINCT material_type, ', ')
          FROM material_receiving WHERE lot_number = '48096')
UNION ALL
SELECT 'audit rows tagged BLANK-48096-0929 (expect 1)',
       (SELECT count(*)::text FROM audit_logs WHERE details->>'tag' = 'BLANK-48096-0929');

ROLLBACK;   -- DRY RUN. After reviewing the preview, NOTICE and VERIFY, change this line to COMMIT; and run again.
