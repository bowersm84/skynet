/* ============================================================================
   2026-10-27  D-MACH-02  Nexturn 8 (NT-8) added; Nexturns ahead of the Bolt Masters
   ----------------------------------------------------------------------------
   Data only. No schema change, no code change, no deploy.

   1. Inserts NT-8 "Nexturn 8" at Leesburg (location code SB-LEES):
        machine_type Nexturn, model 'Nexturn SA-20B' (same string as NT-1/2/4/5/6,
        so the D-SCHED-27 same-model rate peers pick it up), model_year 2026,
        bar 0.787 dia x 144 in (D-MACHINFO-01 SA-20 convention; 12 ft Tracer 20),
        capabilities 'Swiss-type, 20 mm bar, oscillation turning',
        active, commissioned, kiosk enabled, status available.
   2. Sets display_order (absolute values):
        MZ-1..7 and GN-1 unchanged (1..8)
        NT-1..NT-8  ->  9..16
        BM-1..BM-6  -> 17..22
        Finishing tanks / ovens unchanged (100+).
      display_order drives every machine list: Schedule (Command grid, list
      view, picker), Mainframe, Production Display, Traveler and Material kiosks.
   3. Two audit_logs rows: machine_added, machine_lineup_reordered (operator NULL).

   TEST (ylzmyjjqibpbqbwjsnqj): applied by Claude 2026-10-27.
   PROD (luzungoqfuplspzbqctb): run by Matt in the SQL Editor.

   Run each block ALONE (the editor returns only the last result set).
   ============================================================================ */


/* ---------------------------------------------------------------------------
   BLOCK 1  PREVIEW  (read-only)
   Expect: 14 rows in target order. NT-1..7 and BM-1..6 show their current
           order; the NT-8 row has a blank name and current_order (not yet
           inserted). nt8_exists = false and lees_found = true on every row.
   --------------------------------------------------------------------------- */
WITH target(code, new_order) AS (
  VALUES ('NT-1', 9), ('NT-2', 10), ('NT-3', 11), ('NT-4', 12), ('NT-5', 13),
         ('NT-6', 14), ('NT-7', 15), ('NT-8', 16),
         ('BM-1', 17), ('BM-2', 18), ('BM-3', 19), ('BM-4', 20), ('BM-5', 21), ('BM-6', 22)
)
SELECT t.code,
       m.name,
       m.display_order AS current_order,
       t.new_order,
       (SELECT EXISTS (SELECT 1 FROM machines x WHERE upper(x.code) = 'NT-8')) AS nt8_exists,
       (SELECT EXISTS (SELECT 1 FROM locations l WHERE l.code = 'SB-LEES'))   AS lees_found
FROM target t
LEFT JOIN machines m ON m.code = t.code
ORDER BY t.new_order;


/* ---------------------------------------------------------------------------
   BLOCK 2  APPLY  (atomic; any guard failure raises and nothing is written)
   --------------------------------------------------------------------------- */
DO $$
DECLARE
  v_loc     uuid;
  v_id      uuid;
  v_cnt     int;
  v_before  jsonb;
  v_after   jsonb;
  v_nt_max  int;
  v_bm_min  int;
BEGIN
  v_loc := (SELECT id FROM locations WHERE code = 'SB-LEES');
  IF v_loc IS NULL THEN
    RAISE EXCEPTION 'D-MACH-02: location SB-LEES not found';
  END IF;

  IF EXISTS (SELECT 1 FROM machines WHERE upper(code) = 'NT-8') THEN
    RAISE EXCEPTION 'D-MACH-02: NT-8 already exists - nothing changed';
  END IF;

  v_cnt := (SELECT count(*) FROM machines
            WHERE code IN ('NT-1','NT-2','NT-3','NT-4','NT-5','NT-6','NT-7',
                           'BM-1','BM-2','BM-3','BM-4','BM-5','BM-6'));
  IF v_cnt <> 13 THEN
    RAISE EXCEPTION 'D-MACH-02: expected 13 NT/BM rows, found %', v_cnt;
  END IF;

  v_before := (SELECT jsonb_object_agg(code, display_order)
               FROM machines
               WHERE machine_type IN ('Nexturn', 'Bolt Master'));

  INSERT INTO machines
    (location_id, name, code, machine_type, status, display_order,
     is_active, is_commissioned, kiosk_enabled,
     max_bar_length, model, model_year, max_bar_diameter_in, capabilities)
  VALUES
    (v_loc, 'Nexturn 8', 'NT-8', 'Nexturn', 'available', 16,
     true, true, true,
     144, 'Nexturn SA-20B', 2026, 0.787, 'Swiss-type, 20 mm bar, oscillation turning');

  v_id := (SELECT id FROM machines WHERE code = 'NT-8' AND location_id = v_loc);

  UPDATE machines m
     SET display_order = t.new_order
    FROM (VALUES ('NT-1', 9), ('NT-2', 10), ('NT-3', 11), ('NT-4', 12), ('NT-5', 13),
                 ('NT-6', 14), ('NT-7', 15),
                 ('BM-1', 17), ('BM-2', 18), ('BM-3', 19), ('BM-4', 20), ('BM-5', 21), ('BM-6', 22)
         ) AS t(code, new_order)
   WHERE m.code = t.code;

  v_nt_max := (SELECT max(display_order) FROM machines WHERE machine_type = 'Nexturn');
  v_bm_min := (SELECT min(display_order) FROM machines WHERE machine_type = 'Bolt Master');
  IF v_nt_max IS NULL OR v_bm_min IS NULL OR v_nt_max >= v_bm_min THEN
    RAISE EXCEPTION 'D-MACH-02: post-check failed (NT max %, BM min %)', v_nt_max, v_bm_min;
  END IF;

  v_after := (SELECT jsonb_object_agg(code, display_order)
              FROM machines
              WHERE machine_type IN ('Nexturn', 'Bolt Master'));

  INSERT INTO audit_logs (event_type, machine_id, operator_id, details)
  VALUES
    ('machine_added', v_id, NULL,
     jsonb_build_object('decision', 'D-MACH-02', 'code', 'NT-8', 'name', 'Nexturn 8',
                        'model', 'Nexturn SA-20B', 'model_year', 2026,
                        'location_code', 'SB-LEES', 'display_order', 16)),
    ('machine_lineup_reordered', NULL, NULL,
     jsonb_build_object('decision', 'D-MACH-02',
                        'reason', 'Nexturns ahead of the Bolt Masters',
                        'before', v_before, 'after', v_after));
END $$;


/* ---------------------------------------------------------------------------
   BLOCK 3  VERIFY  (read-only, one row)
   Expect:
     lineup     = MZ-1,MZ-2,MZ-3,MZ-4,MZ-5,MZ-7,MZ-6,GN-1,NT-1,NT-2,NT-3,NT-4,
                  NT-5,NT-6,NT-7,NT-8,BM-1,BM-2,BM-3,BM-4,BM-5,BM-6
     nt8        = Nexturn 8 | Nexturn SA-20B | 2026 | 16 | active | commissioned
                  | kiosk | available | SB-LEES
     audit_rows = 2
   --------------------------------------------------------------------------- */
SELECT
  (SELECT string_agg(code, ',' ORDER BY display_order)
     FROM machines WHERE machine_type <> 'finishing') AS lineup,
  (SELECT m.name || ' | ' || m.model || ' | ' || m.model_year || ' | ' || m.display_order
          || ' | ' || CASE WHEN m.is_active THEN 'active' ELSE 'INACTIVE' END
          || ' | ' || CASE WHEN m.is_commissioned THEN 'commissioned' ELSE 'NOT commissioned' END
          || ' | ' || CASE WHEN m.kiosk_enabled THEN 'kiosk' ELSE 'no kiosk' END
          || ' | ' || m.status || ' | ' || l.code
     FROM machines m JOIN locations l ON l.id = m.location_id
    WHERE m.code = 'NT-8') AS nt8,
  (SELECT count(*) FROM audit_logs
    WHERE details->>'decision' = 'D-MACH-02') AS audit_rows;
