-- =====================================================================================
-- 2026-09-29_D-INV-08_lot_vendor_guard.sql
-- D-INV-08: one lot number = one vendor, one material, one size. Corrects the two lots
-- that broke that rule, then adds a database guard so it cannot happen again.
--
-- Target:   TEST (ylzmyjjqibpbqbwjsnqj) first, then PROD (luzungoqfuplspzbqctb).
-- Run with: $env:PGCLIENTENCODING = 'UTF8'
--           & C:\pgsql\bin\psql.exe $env:PROD_DB_URL -v ON_ERROR_STOP=1 -P pager=off -f .\2026-09-29_D-INV-08_lot_vendor_guard.sql
-- Default:  DRY RUN. The last line is ROLLBACK. Change it to COMMIT; after review.
-- Re-run:   Idempotent. Corrections already applied are skipped with a NOTICE.
--
-- 1. Corrections (from the paperwork on file):
--    - Lot 2592, PO P3961 (644 x 144", received 2026-09-21): entered as Alro. The packing
--      list and cert are Tri Star (heat 572882, the same heat as PO P3660).
--      Vendor Alro -> Tri Star; catalog row -> Tri Star 303 Stainless 0.375.
--    - Lot 2376, PO SK2021082, the two opening-load receipts (11 x 144", 4 x 48",
--      2026-06-11): entered as Alro. The cert attached to both is EMJ (heat 10081093).
--      Vendor Alro -> EMJ; catalog row -> EMJ 7075-T6 0.375.
--    Usage rows charged to those receipts get the same catalog row. Balances do not move:
--    no receipt, quantity or charge changes. Each corrected receipt's before-image goes to
--    audit_logs (event material_receipt_corrected, tag LOTVENDOR-0929).
--    Rows are found by lot + PO + vendor + length + quantity, never by id (TEST and PROD
--    ids differ); the block stops if a target is not found exactly once.
--
-- 2. Guard: trg_material_receiving_lot_guard, BEFORE INSERT or UPDATE of the lot, vendor,
--    material, size, category, blank type or catalog row on material_receiving. One lot
--    number is one vendor, one material and one size (for blanks, one dash and one blank
--    type). It refuses a receipt when:
--      - the same lot number (ignoring case and spaces) is already on file under a
--        different vendor (ignoring case, spaces and punctuation), category, material,
--        size / dash or blank type; or
--      - its vendor differs from the vendor of the catalog row it points at.
--    A new PO from the same vendor under the same lot is allowed: bar lots follow the heat,
--    and one heat arrives on several POs (lot 2592, heat 572882, POs P3660 and P3961).
--    Blank lots used to be shared across the dash numbers on one pallet; that practice is
--    discontinued. The lots it left (11 on PROD: 47269, 47580, 47938, 48096, 48371, 49999,
--    50045, 50346, 50509, 50510, 51215) stay as history: an edit to one of their rows is
--    refused only for a dash / material conflict the edit itself creates, so the rows can
--    still be moved, noted or corrected. Vendor and category conflicts are never
--    grandfathered. A new receipt on one of those lots is refused: new material gets
--    its own lot number.
--    Count-discovery receipts copy their source, so they pass. The messages are plain
--    English; the Armory shows them as the save error.
-- =====================================================================================

BEGIN;

-- -------------------------------------------------------------------------------------
-- 0. PREVIEW: the rows about to change (read-only)
-- -------------------------------------------------------------------------------------
SELECT mr.lot_number, mr.po_number, mr.vendor, mr.bar_length_inches AS len, mr.quantity,
       m.vendor AS catalog_vendor,
       (SELECT count(*) FROM material_usage mu WHERE mu.material_receiving_id = mr.id) AS usage_rows
  FROM material_receiving mr
  LEFT JOIN materials m ON m.id = mr.material_id
 WHERE (mr.lot_number = '2592' AND mr.po_number = 'P3961')
    OR (mr.lot_number = '2376' AND mr.po_number = 'SK2021082')
 ORDER BY mr.lot_number, mr.received_at;

-- -------------------------------------------------------------------------------------
-- 1. Corrections
-- -------------------------------------------------------------------------------------
DO $$
DECLARE
  v_tristar_303  uuid;
  v_emj_7075     uuid;
  v_n            int;
  v_done         int;
  r              record;
  v_fixed        int := 0;
BEGIN
  v_tristar_303 := (SELECT m.id FROM materials m JOIN material_types mt ON mt.id = m.material_type_id
                     WHERE m.vendor = 'Tri Star' AND mt.name = '303 Stainless Steel' AND m.bar_size_inches = 0.375 AND m.is_active);
  v_emj_7075    := (SELECT m.id FROM materials m JOIN material_types mt ON mt.id = m.material_type_id
                     WHERE m.vendor = 'EMJ' AND mt.name = '7075-T6 Aluminum' AND m.bar_size_inches = 0.375 AND m.is_active);
  IF v_tristar_303 IS NULL OR v_emj_7075 IS NULL THEN
    RAISE EXCEPTION 'GUARD_CATALOG_ROWS: Tri Star 303 0.375 = %, EMJ 7075-T6 0.375 = % (both must exist, active)', v_tristar_303, v_emj_7075;
  END IF;

  -- 2592 / P3961 --------------------------------------------------------------------
  v_n := (SELECT count(*) FROM material_receiving
           WHERE lot_number = '2592' AND po_number = 'P3961' AND vendor = 'Alro'
             AND bar_length_inches = 144 AND quantity = 644);
  v_done := (SELECT count(*) FROM material_receiving
              WHERE lot_number = '2592' AND po_number = 'P3961' AND vendor = 'Tri Star'
                AND bar_length_inches = 144 AND quantity = 644 AND material_id = v_tristar_303);
  IF v_n = 0 AND v_done = 1 THEN
    RAISE NOTICE 'D-INV-08: lot 2592 / P3961 already Tri Star - skipped';
  ELSIF v_n = 1 THEN
    FOR r IN SELECT * FROM material_receiving
              WHERE lot_number = '2592' AND po_number = 'P3961' AND vendor = 'Alro'
                AND bar_length_inches = 144 AND quantity = 644
    LOOP
      INSERT INTO audit_logs (event_type, details)
      VALUES ('material_receipt_corrected', jsonb_build_object(
                'tag', 'LOTVENDOR-0929', 'decision', 'D-INV-08',
                'change', 'vendor Alro -> Tri Star; catalog row -> Tri Star 303 Stainless 0.375',
                'evidence', 'Tri Star packing list SSP-107838 and cert CC0000124964-00, PO P3961, heat 572882',
                'before', to_jsonb(r)));
      UPDATE material_receiving SET vendor = 'Tri Star', material_id = v_tristar_303 WHERE id = r.id;
      UPDATE material_usage SET material_id = v_tristar_303 WHERE material_receiving_id = r.id;
      v_fixed := v_fixed + 1;
    END LOOP;
  ELSE
    RAISE EXCEPTION 'GUARD_TARGET_2592: expected 1 Alro receipt on lot 2592 / P3961, found % (and % already corrected)', v_n, v_done;
  END IF;

  -- 2376 / SK2021082: the two opening-load receipts ---------------------------------
  v_n := (SELECT count(*) FROM material_receiving
           WHERE lot_number = '2376' AND po_number = 'SK2021082' AND vendor = 'Alro'
             AND ((bar_length_inches = 144 AND quantity = 11) OR (bar_length_inches = 48 AND quantity = 4)));
  v_done := (SELECT count(*) FROM material_receiving
              WHERE lot_number = '2376' AND po_number = 'SK2021082' AND vendor = 'EMJ' AND material_id = v_emj_7075
                AND ((bar_length_inches = 144 AND quantity = 11) OR (bar_length_inches = 48 AND quantity = 4)));
  IF v_n = 0 AND v_done = 2 THEN
    RAISE NOTICE 'D-INV-08: lot 2376 opening-load receipts already EMJ - skipped';
  ELSIF v_n = 2 THEN
    FOR r IN SELECT * FROM material_receiving
              WHERE lot_number = '2376' AND po_number = 'SK2021082' AND vendor = 'Alro'
                AND ((bar_length_inches = 144 AND quantity = 11) OR (bar_length_inches = 48 AND quantity = 4))
    LOOP
      INSERT INTO audit_logs (event_type, details)
      VALUES ('material_receipt_corrected', jsonb_build_object(
                'tag', 'LOTVENDOR-0929', 'decision', 'D-INV-08',
                'change', 'vendor Alro -> EMJ; catalog row -> EMJ 7075-T6 Aluminum 0.375',
                'evidence', 'EMJ certificate of test, customer order SK2021082, invoice T943445, heat 10081093',
                'before', to_jsonb(r)));
      UPDATE material_receiving SET vendor = 'EMJ', material_id = v_emj_7075 WHERE id = r.id;
      UPDATE material_usage SET material_id = v_emj_7075 WHERE material_receiving_id = r.id;
      v_fixed := v_fixed + 1;
    END LOOP;
  ELSE
    RAISE EXCEPTION 'GUARD_TARGET_2376: expected 2 Alro opening-load receipts on lot 2376 / SK2021082, found % (and % already corrected)', v_n, v_done;
  END IF;

  RAISE NOTICE 'D-INV-08: % receipts corrected', v_fixed;
END $$;

-- -------------------------------------------------------------------------------------
-- 2. The guard
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.material_vendor_key(p_vendor text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $$
  -- "Tri Star", "TRI STAR " and "Tri-Star" are the same vendor.
  SELECT lower(regexp_replace(COALESCE(p_vendor, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

CREATE OR REPLACE FUNCTION public.material_lot_item_conflict(
  a_type text, a_size text, a_blank_type uuid,
  b_type text, b_size text, b_blank_type uuid, p_category text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $$
  -- Two receipts of one category are different items: another material, another size or
  -- dash, or (blanks) another blank type. Vendor and category are checked separately.
  SELECT a_type IS DISTINCT FROM b_type
      OR a_size IS DISTINCT FROM b_size
      OR (p_category = 'blank' AND a_blank_type IS DISTINCT FROM b_blank_type)
$$;

CREATE OR REPLACE FUNCTION public.material_receiving_lot_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_lot         text;
  v_old_lot     text := NULL;
  v_is_update   boolean := (TG_OP = 'UPDATE');
  v_cat_vendor  text;
  v_conflict    uuid;
  v_c_vendor    text;
  v_c_type      text;
  v_c_size      text;
  v_c_po        text;
BEGIN
  v_lot := upper(btrim(COALESCE(NEW.lot_number, '')));
  IF v_lot = '' THEN
    RETURN NEW;
  END IF;
  IF v_is_update THEN
    v_old_lot := upper(btrim(COALESCE(OLD.lot_number, '')));
  END IF;

  -- The receipt's vendor must be the vendor of the catalog row it points at.
  v_cat_vendor := (SELECT m.vendor FROM materials m WHERE m.id = NEW.material_id);
  IF v_cat_vendor IS NOT NULL
     AND public.material_vendor_key(v_cat_vendor) <> public.material_vendor_key(NEW.vendor) THEN
    RAISE EXCEPTION 'This receipt says vendor % but the material chosen is %''s. Pick the vendor on the paperwork, then the material.',
      COALESCE(NULLIF(btrim(NEW.vendor), ''), '(blank)'), v_cat_vendor
      USING ERRCODE = 'P0001';
  END IF;

  -- Serialize receipts of the same lot number so two can't race past each other.
  PERFORM pg_advisory_xact_lock(hashtext('material_receiving_lot:' || v_lot));

  -- Vendor or category conflicts always block. A dash / material conflict the row already
  -- had before this edit (the legacy shared blank lots) is history, not something this
  -- write created, so it does not block the edit.
  v_conflict := (SELECT mr.id FROM material_receiving mr
                  WHERE upper(btrim(mr.lot_number)) = v_lot
                    AND mr.id IS DISTINCT FROM NEW.id
                    AND (public.material_vendor_key(mr.vendor) <> public.material_vendor_key(NEW.vendor)
                         OR mr.category IS DISTINCT FROM NEW.category
                         OR (public.material_lot_item_conflict(mr.material_type, mr.bar_size, mr.blank_type_id,
                                                               NEW.material_type, NEW.bar_size, NEW.blank_type_id, NEW.category)
                             AND NOT (v_is_update AND v_old_lot = v_lot AND OLD.category IS NOT DISTINCT FROM NEW.category
                                      AND public.material_lot_item_conflict(mr.material_type, mr.bar_size, mr.blank_type_id,
                                                                            OLD.material_type, OLD.bar_size, OLD.blank_type_id, OLD.category))))
                  ORDER BY mr.received_at, mr.id
                  LIMIT 1);
  IF v_conflict IS NOT NULL THEN
    v_c_vendor := (SELECT mr.vendor        FROM material_receiving mr WHERE mr.id = v_conflict);
    v_c_type   := (SELECT mr.material_type FROM material_receiving mr WHERE mr.id = v_conflict);
    v_c_size   := (SELECT CASE WHEN mr.category = 'blank' THEN 'dash ' || mr.bar_size ELSE mr.bar_size END FROM material_receiving mr WHERE mr.id = v_conflict);
    v_c_po     := (SELECT mr.po_number     FROM material_receiving mr WHERE mr.id = v_conflict);
    RAISE EXCEPTION 'Lot % is already on file from % (% %, PO %). A lot number belongs to one vendor, one material and one size or dash, and this receipt is % (% %). Check the paperwork, or give this material a new lot number.',
      btrim(NEW.lot_number), COALESCE(v_c_vendor, '(no vendor)'), COALESCE(v_c_type, ''), COALESCE(v_c_size, ''), COALESCE(v_c_po, '-'),
      COALESCE(NULLIF(btrim(NEW.vendor), ''), '(no vendor)'), COALESCE(NEW.material_type, ''),
      COALESCE(CASE WHEN NEW.category = 'blank' THEN 'dash ' || NEW.bar_size ELSE NEW.bar_size END, '')
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_material_receiving_lot_guard ON public.material_receiving;
CREATE TRIGGER trg_material_receiving_lot_guard
  BEFORE INSERT OR UPDATE OF lot_number, vendor, material_type, bar_size, category, blank_type_id, material_id
  ON public.material_receiving
  FOR EACH ROW EXECUTE FUNCTION public.material_receiving_lot_guard();

-- -------------------------------------------------------------------------------------
-- 3. VERIFY
-- -------------------------------------------------------------------------------------
SELECT 'lots with more than one vendor (expect 0)' AS item,
       (SELECT count(*) FROM (SELECT upper(btrim(lot_number)) FROM material_receiving
                               GROUP BY 1 HAVING count(DISTINCT public.material_vendor_key(vendor)) > 1) x)::text AS state
UNION ALL
SELECT 'bar lots with more than one material/size, or shared with blanks (expect 0)',
       (SELECT count(*) FROM (SELECT upper(btrim(lot_number)) FROM material_receiving
                               GROUP BY 1 HAVING count(DISTINCT category) > 1
                                  OR count(DISTINCT (material_type, bar_size)) FILTER (WHERE category = 'bar') > 1) x)::text
UNION ALL
SELECT 'legacy shared blank lots kept as history (expect 11 on PROD, 10 on TEST)',
       (SELECT count(*)::text || ': ' || COALESCE(string_agg(l, ', ' ORDER BY l), '') FROM (
          SELECT upper(btrim(lot_number)) AS l FROM material_receiving WHERE category = 'blank'
           GROUP BY 1 HAVING count(DISTINCT (material_type, bar_size, blank_type_id)) > 1) x)
UNION ALL
SELECT 'receipts whose vendor differs from their catalog row (expect 0)',
       (SELECT count(*) FROM material_receiving mr JOIN materials m ON m.id = mr.material_id
         WHERE m.vendor IS NOT NULL AND public.material_vendor_key(m.vendor) <> public.material_vendor_key(mr.vendor))::text
UNION ALL
SELECT 'usage rows whose catalog row differs from their receipt''s (expect 0)',
       (SELECT count(*) FROM material_usage mu JOIN material_receiving mr ON mr.id = mu.material_receiving_id
         WHERE mu.material_id IS DISTINCT FROM mr.material_id AND mu.material_id IS NOT NULL)::text
UNION ALL
SELECT 'lot 2592', (SELECT string_agg(DISTINCT vendor, ', ') FROM material_receiving WHERE lot_number = '2592')
UNION ALL
SELECT 'lot 2376', (SELECT string_agg(DISTINCT vendor, ', ') FROM material_receiving WHERE lot_number = '2376')
UNION ALL
SELECT 'audit rows tagged LOTVENDOR-0929 (expect 3)',
       (SELECT count(*) FROM audit_logs WHERE event_type = 'material_receipt_corrected' AND details->>'tag' = 'LOTVENDOR-0929')::text
UNION ALL
SELECT 'guard trigger present',
       (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_material_receiving_lot_guard')::text;

ROLLBACK;   -- DRY RUN. After reviewing the preview, NOTICEs and VERIFY, change this line to COMMIT; and run again.
