-- =====================================================================================
-- 2026-09-29_PROD_blank_lot_48096_cost_fix.sql
-- Lot 48096, 2700 Stainless dash 9, 7,950 pcs (AJ Fasteners, entered 2026-09-29): the
-- cost was keyed as a $0.11 TOTAL, giving $0.0000138 per piece. It is $0.11 PER PIECE
-- (Matt, 2026-09-29), in line with the other 2700 Stainless receipts ($0.11-$0.145 per
-- piece; the same lot's dash 6 is $0.11). New receipt value: 7,950 x $0.11 = $874.50.
--
-- Target:   PROD only (luzungoqfuplspzbqctb); the receipt does not exist on TEST.
-- Run with: $env:PGCLIENTENCODING = 'UTF8'
--           & C:\pgsql\bin\psql.exe $env:PROD_DB_URL -v ON_ERROR_STOP=1 -P pager=off -f .\2026-09-29_PROD_blank_lot_48096_cost_fix.sql
-- Default:  DRY RUN. The last line is ROLLBACK. Change it to COMMIT; after review.
-- Re-run:   Idempotent: once corrected, the block skips with a NOTICE.
-- Changes price_per_bar on one receipt only. Before-image to audit_logs, tag
-- BLANK-48096-COST-0929. The D-INV-08 guard does not watch price, so it does not fire.
-- =====================================================================================

BEGIN;

-- PREVIEW
SELECT lot_number, material_type, bar_size AS dash, quantity, price_per_bar AS per_piece,
       round((price_per_bar * quantity)::numeric, 2) AS total
  FROM material_receiving
 WHERE lot_number = '48096' AND category = 'blank'
 ORDER BY received_at;

DO $$
DECLARE
  v_n     int;
  v_done  int;
  r       record;
BEGIN
  v_n := (SELECT count(*) FROM material_receiving
           WHERE lot_number = '48096' AND category = 'blank' AND material_type = '2700 Stainless'
             AND bar_size = '9' AND quantity = 7950 AND price_per_bar < 0.001);
  v_done := (SELECT count(*) FROM material_receiving
              WHERE lot_number = '48096' AND category = 'blank' AND material_type = '2700 Stainless'
                AND bar_size = '9' AND quantity = 7950 AND price_per_bar = 0.11);

  IF v_n = 0 AND v_done = 1 THEN
    RAISE NOTICE 'Lot 48096 dash 9 is already $0.11 per piece - skipped';
    RETURN;
  END IF;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'GUARD_TARGET: expected 1 lot 48096 2700 Stainless dash 9 receipt priced under $0.001 per piece, found % (% already corrected)', v_n, v_done;
  END IF;

  FOR r IN SELECT * FROM material_receiving
            WHERE lot_number = '48096' AND category = 'blank' AND material_type = '2700 Stainless'
              AND bar_size = '9' AND quantity = 7950 AND price_per_bar < 0.001
  LOOP
    INSERT INTO audit_logs (event_type, details)
    VALUES ('material_receipt_corrected', jsonb_build_object(
              'tag', 'BLANK-48096-COST-0929', 'decision', 'D-INV-08',
              'change', 'price_per_bar ' || r.price_per_bar || ' -> 0.11 (total $0.11 -> $874.50)',
              'reason', 'Cost keyed as a $0.11 total instead of $0.11 per piece (Matt Bowers, 2026-09-29)',
              'before', to_jsonb(r)));
    UPDATE material_receiving SET price_per_bar = 0.11 WHERE id = r.id;
  END LOOP;

  RAISE NOTICE 'Lot 48096 dash 9 set to $0.11 per piece ($874.50)';
END $$;

-- VERIFY
SELECT 'lot 48096 dash 9' AS item,
       (SELECT 'per piece ' || price_per_bar || ', total $' || round((price_per_bar * quantity)::numeric, 2)
          FROM material_receiving WHERE lot_number = '48096' AND bar_size = '9') AS state
UNION ALL
SELECT 'audit rows tagged BLANK-48096-COST-0929 (expect 1)',
       (SELECT count(*)::text FROM audit_logs WHERE details->>'tag' = 'BLANK-48096-COST-0929');

ROLLBACK;   -- DRY RUN. After reviewing the preview, NOTICE and VERIFY, change this line to COMMIT; and run again.
