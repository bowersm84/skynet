-- =============================================================================
-- Kit component-lot BACKFILL loader (D-KSTC-25) -- v2
--
-- Usage (PowerShell, run FROM this folder so \copy finds the CSV):
--   Dry run (report only, no writes):
--     & C:\pgsql\bin\psql.exe $env:TEST_DB_URL -f load_kit_component_lots.sql
--   Insert pass:
--     & C:\pgsql\bin\psql.exe $env:TEST_DB_URL -v run_insert=1 -f load_kit_component_lots.sql
--   Then repeat both against $env:PROD_DB_URL.
--
-- v2: preflight guard (schema migration must run first); invoice bridge for
-- paper-era lots -- the paper books recorded INVOICES not SOs (D-KSTC-11), so
-- lots without an SO resolve via kit_lots.invoice_as_written ->
-- fishbowl_invoices.invoice_number -> so_number. Bridge reach depends on the
-- fishbowl_invoices export window; re-export from 2024-01-01 and rerun the
-- kit_stc_load refresh to widen it.
--
-- Idempotent: ON CONFLICT (kit_lot_id, part, lot) DO NOTHING.
-- =============================================================================
\if :{?run_insert}
\else
\set run_insert 0
\endif

\echo === Preflight ===
SELECT (to_regclass('public.kit_lot_component_lots') IS NOT NULL) AS table_ok \gset
\if :table_ok
\echo table present -- proceeding
\else
\echo *** public.kit_lot_component_lots is MISSING.
\echo *** Run 2026-08-03_kit_lot_component_lots_schema.sql first, then rerun this loader.
\quit
\endif

\echo === Staging CSV ===
CREATE TEMP TABLE staging_klcl (
  so_number text, shipment_number text, ship_date text, so_line_no text,
  parent_kit text, part_number text, lot_number text, qty_shipped text
);
\copy staging_klcl FROM 'kit_component_lots_load.csv' WITH (FORMAT csv, HEADER true)

-- Normalized working sets ---------------------------------------------------
CREATE TEMP VIEW v_stage AS
SELECT NULLIF(regexp_replace(so_number, '\D', '', 'g'), '')        AS so_digits,
       upper(regexp_replace(trim(parent_kit), '\s+', ' ', 'g'))    AS parent_norm,
       trim(part_number)                                           AS part_number,
       trim(lot_number)                                            AS lot_number,
       qty_shipped::numeric                                        AS qty,
       ship_date::date                                             AS ship_date,
       shipment_number,
       NULLIF(regexp_replace(so_line_no, '\D', '', 'g'), '')::integer AS so_line_no
FROM staging_klcl;

-- One row per (lot, resolvable SO). so_via: 'direct' = linked sale or
-- so_as_written (bench era); 'invoice' = paper-era bridge through
-- fishbowl_invoices; 'none' = no resolvable SO (kept for universe counts).
CREATE TEMP VIEW v_lots AS
WITH base AS (
  SELECT kl.id AS kit_lot_id, kl.lot_number, kl.source, kb.code AS book_code,
         NULLIF(regexp_replace(COALESCE(ks.so_number, kl.so_as_written, ''), '\D', '', 'g'), '') AS so_digits,
         kl.invoice_as_written,
         upper(regexp_replace(trim(COALESCE(sku.part_number, kl.kit_part_as_written, '')), '\s+', ' ', 'g')) AS sku_norm
  FROM public.kit_lots kl
  JOIN public.kit_books kb            ON kb.id  = kl.book_id
  LEFT JOIN public.kit_skus sku       ON sku.id = kl.kit_sku_id
  LEFT JOIN public.kit_sale_lines ksl ON ksl.id = kl.kit_sale_line_id
  LEFT JOIN public.kit_sales ks       ON ks.id  = ksl.kit_sale_id
  WHERE kl.record_status = 'active'
),
inv_bridge AS (
  SELECT DISTINCT b.kit_lot_id,
         NULLIF(regexp_replace(fi.so_number, '\D', '', 'g'), '') AS so_digits
  FROM base b
  CROSS JOIN LATERAL regexp_matches(b.invoice_as_written, '\d+', 'g') AS m(runs)
  JOIN public.fishbowl_invoices fi
    ON NULLIF(regexp_replace(fi.invoice_number, '\D', '', 'g'), '') = m.runs[1]
  WHERE b.so_digits IS NULL
    AND b.invoice_as_written IS NOT NULL
    AND fi.so_number IS NOT NULL
)
SELECT b.kit_lot_id, b.lot_number, b.source, b.book_code, b.so_digits, b.sku_norm,
       'direct'::text AS so_via
FROM base b WHERE b.so_digits IS NOT NULL
UNION ALL
SELECT b.kit_lot_id, b.lot_number, b.source, b.book_code, i.so_digits, b.sku_norm, 'invoice'
FROM inv_bridge i JOIN base b ON b.kit_lot_id = i.kit_lot_id
WHERE i.so_digits IS NOT NULL
UNION ALL
SELECT b.kit_lot_id, b.lot_number, b.source, b.book_code, NULL, b.sku_norm, 'none'
FROM base b
WHERE b.so_digits IS NULL
  AND NOT EXISTS (SELECT 1 FROM inv_bridge i
                  WHERE i.kit_lot_id = b.kit_lot_id AND i.so_digits IS NOT NULL);

CREATE TEMP VIEW v_matched AS
SELECT DISTINCT l.kit_lot_id, l.book_code, l.lot_number AS kit_lot_number,
       l.source AS lot_source, l.so_via,
       s.part_number, s.lot_number, s.qty, s.ship_date, s.shipment_number,
       s.so_line_no, s.so_digits
FROM v_stage s
JOIN v_lots l ON l.so_digits IS NOT NULL
            AND l.so_digits = s.so_digits
            AND l.sku_norm  = s.parent_norm;

\echo === DRY-RUN REPORT =========================================
\echo --- 1. Staged input ---
SELECT count(*) AS staged_rows,
       count(DISTINCT so_digits) AS staged_sos,
       count(DISTINCT parent_norm) AS staged_kits,
       min(ship_date) AS first_ship, max(ship_date) AS last_ship
FROM v_stage;

\echo --- 2a. Registry universe: SO resolvability (active lots) ---
SELECT count(DISTINCT kit_lot_id) AS active_lots,
       count(DISTINCT kit_lot_id) FILTER (WHERE so_digits IS NOT NULL) AS resolvable_so,
       count(DISTINCT kit_lot_id) FILTER (WHERE so_via = 'direct')     AS via_so_field,
       count(DISTINCT kit_lot_id) FILTER (WHERE so_via = 'invoice')    AS via_invoice_bridge,
       count(DISTINCT kit_lot_id) FILTER (WHERE so_via = 'none')       AS unresolvable
FROM v_lots;

\echo --- 2b. Resolvable lots by source ---
SELECT source, so_via, count(DISTINCT kit_lot_id) AS lots
FROM v_lots WHERE so_digits IS NOT NULL
GROUP BY 1, 2 ORDER BY 1, 2;

\echo --- 3. Match result ---
SELECT count(DISTINCT kit_lot_id) AS kit_lots_receiving_rows,
       count(DISTINCT so_digits)  AS sos_matched,
       count(DISTINCT (kit_lot_id, part_number, lot_number)) AS component_lot_rows
FROM v_matched;

\echo --- 4. Receiving lots by book / source / path ---
SELECT book_code, lot_source, so_via,
       count(DISTINCT kit_lot_id) AS lots,
       count(DISTINCT (kit_lot_id, part_number, lot_number)) AS rows
FROM v_matched GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

\echo --- 5. Resolvable lots whose SO is absent from the CSV (era gap) ---
SELECT l.book_code, l.source, l.so_via, count(DISTINCT l.kit_lot_id) AS lots
FROM v_lots l
WHERE l.so_digits IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM v_stage s WHERE s.so_digits = l.so_digits)
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

\echo --- 6. SO in CSV but kit SKU mismatch (lot receives nothing) ---
SELECT l.book_code, l.lot_number AS kit_lot, l.sku_norm AS logged_sku,
       s.parent_norm AS fishbowl_kit, s.so_digits AS so, count(*) AS csv_rows
FROM v_lots l
JOIN v_stage s ON s.so_digits = l.so_digits
WHERE l.so_digits IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM v_matched m WHERE m.kit_lot_id = l.kit_lot_id)
  AND l.sku_norm <> ''
GROUP BY 1, 2, 3, 4, 5
ORDER BY 1, 2, csv_rows DESC
LIMIT 25;

\echo --- 7. Rows that would insert (post component-link, pre-conflict) ---
WITH comp AS (
  SELECT DISTINCT ON (part_norm) id, part_norm FROM (
    SELECT id, upper(regexp_replace(part_number, '\s+', ' ', 'g')) AS part_norm
    FROM public.kit_components) c
  ORDER BY part_norm, id
),
agg AS (
  SELECT kit_lot_id, part_number, lot_number
  FROM v_matched GROUP BY 1, 2, 3
)
SELECT count(*) AS candidate_rows,
       count(*) FILTER (WHERE c.id IS NOT NULL) AS linked_to_kit_components,
       count(*) FILTER (WHERE c.id IS NULL)     AS as_written_only
FROM agg a
LEFT JOIN comp c ON c.part_norm = upper(regexp_replace(a.part_number, '\s+', ' ', 'g'));

\if :run_insert
\echo === INSERT PASS ============================================
BEGIN;

WITH comp AS (
  SELECT DISTINCT ON (part_norm) id, part_norm FROM (
    SELECT id, upper(regexp_replace(part_number, '\s+', ' ', 'g')) AS part_norm
    FROM public.kit_components) c
  ORDER BY part_norm, id
),
agg AS (
  SELECT kit_lot_id, part_number, lot_number,
         sum(qty) AS qty, min(ship_date) AS ship_date,
         min(shipment_number) AS shipment_number, min(so_line_no) AS so_line_no
  FROM (SELECT DISTINCT kit_lot_id, part_number, lot_number, qty, ship_date,
               shipment_number, so_line_no
        FROM v_matched) dedup
  GROUP BY 1, 2, 3
)
INSERT INTO public.kit_lot_component_lots
  (kit_lot_id, component_id, part_number_as_written, lot_number_as_written,
   qty_shipped, ship_date, shipment_number, so_line_no, source)
SELECT a.kit_lot_id, c.id, a.part_number, a.lot_number,
       a.qty, a.ship_date, a.shipment_number, a.so_line_no,
       'fishbowl_backfill'
FROM agg a
LEFT JOIN comp c ON c.part_norm = upper(regexp_replace(a.part_number, '\s+', ' ', 'g'))
ON CONFLICT ON CONSTRAINT klcl_unique DO NOTHING;

-- Verification (last statement before COMMIT)
SELECT count(*) AS total_rows_in_table,
       count(*) FILTER (WHERE source = 'fishbowl_backfill') AS backfill_rows,
       count(DISTINCT kit_lot_id) AS kit_lots_covered,
       count(*) FILTER (WHERE component_id IS NOT NULL) AS linked_rows
FROM public.kit_lot_component_lots;

COMMIT;
\else
\echo (dry run only -- rerun with -v run_insert=1 to write)
\endif
