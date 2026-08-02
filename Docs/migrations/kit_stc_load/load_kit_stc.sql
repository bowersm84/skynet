-- ============================================================
-- load_kit_stc.sql — Kit & STC Registry data load (workbook v5_3)
-- Run with psql from the folder containing this file + csv/:
--   psql "$TEST_DB_URL" -f load_kit_stc.sql
-- Idempotent:
--   * Reference data (parties, skus, components, bom, sales, lines,
--     invoices, lots, aircraft) upserts on natural keys — safe to
--     re-run as transcription batches grow.
--   * Workflow rows (stc_requests, kit_installations) insert-only:
--     re-runs never clobber statuses, links, or notes added in the UI.
--   * Notes fields: first write wins; manual edits are preserved.
-- ============================================================
\set ON_ERROR_STOP on

BEGIN;

-- ---------- staging ----------
CREATE TEMP TABLE stage_parties (normalized_name text, name text, fishbowl_customer_number text) ON COMMIT DROP;
CREATE TEMP TABLE stage_skus (part_number text, description text) ON COMMIT DROP;
CREATE TEMP TABLE stage_components (part_number text, description text) ON COMMIT DROP;
CREATE TEMP TABLE stage_bom (kit_part_number text, component_part_number text, line_number text, qty_per_kit text, uom text) ON COMMIT DROP;
CREATE TEMP TABLE stage_sales (so_number text, party_key text, customer_po text, order_date text, ship_date text, so_status text, salesperson text) ON COMMIT DROP;
CREATE TEMP TABLE stage_sale_lines (so_number text, kit_part_number text, qty_ordered text, qty_shipped text, invoice_numbers text) ON COMMIT DROP;
CREATE TEMP TABLE stage_invoices (invoice_number text, party_key text, so_number text, first_ship_date text, invoice_lines text, salesperson text) ON COMMIT DROP;
CREATE TEMP TABLE stage_lots (book_code text, lot_number text, log_date text, kit_part_as_written text, kit_part_key text, customer_as_written text, party_key text, invoice_as_written text, stud_number text, rec_platemount_number text, record_status text, source_page text, transcription_confidence text, transcription_notes text, notes text) ON COMMIT DROP;
CREATE TEMP TABLE stage_aircraft (aircraft_key text, serial_number text, registration text, country text) ON COMMIT DROP;
CREATE TEMP TABLE stage_aircraft_registrations (aircraft_key text, registration text, observed_date text, source text) ON COMMIT DROP;
CREATE TEMP TABLE stage_requests (intake_number text, received_date text, requester_name text, requester_company text, requester_email text, requester_party_key text, claimed_kit_number text, claimed_kit_part text, claimed_aircraft_serial text, claimed_registration text, purchased_from_text text, status text, aircraft_key text, posted text, notes text) ON COMMIT DROP;

\copy stage_parties FROM 'csv/parties.csv' WITH (FORMAT csv, HEADER true)
\copy stage_skus FROM 'csv/skus.csv' WITH (FORMAT csv, HEADER true)
\copy stage_components FROM 'csv/components.csv' WITH (FORMAT csv, HEADER true)
\copy stage_bom FROM 'csv/bom.csv' WITH (FORMAT csv, HEADER true)
\copy stage_sales FROM 'csv/sales.csv' WITH (FORMAT csv, HEADER true)
\copy stage_sale_lines FROM 'csv/sale_lines.csv' WITH (FORMAT csv, HEADER true)
\copy stage_invoices FROM 'csv/invoices.csv' WITH (FORMAT csv, HEADER true)
\copy stage_lots FROM 'csv/lots.csv' WITH (FORMAT csv, HEADER true)
\copy stage_aircraft FROM 'csv/aircraft.csv' WITH (FORMAT csv, HEADER true)
\copy stage_aircraft_registrations FROM 'csv/aircraft_registrations.csv' WITH (FORMAT csv, HEADER true)
\copy stage_requests FROM 'csv/requests.csv' WITH (FORMAT csv, HEADER true)

-- Line uniqueness needed for idempotent sale-line upserts (loader pre-sums duplicates)
CREATE UNIQUE INDEX IF NOT EXISTS ksl_sale_sku_unique ON public.kit_sale_lines (kit_sale_id, kit_sku_id);

-- ---------- 1. parties ----------
INSERT INTO public.kit_parties (name, normalized_name, fishbowl_customer_number)
SELECT name, normalized_name, NULLIF(fishbowl_customer_number,'')
FROM stage_parties
ON CONFLICT (normalized_name) DO UPDATE
SET fishbowl_customer_number = COALESCE(public.kit_parties.fishbowl_customer_number,
                                        EXCLUDED.fishbowl_customer_number);

-- ---------- 2. skus ----------
INSERT INTO public.kit_skus (part_number, description)
SELECT part_number, NULLIF(description,'')
FROM stage_skus
ON CONFLICT (part_number) DO UPDATE
SET description = COALESCE(NULLIF(public.kit_skus.description,''), EXCLUDED.description);

-- ---------- 3. components (+ optional MES part link) ----------
INSERT INTO public.kit_components (part_number, description)
SELECT part_number, NULLIF(description,'')
FROM stage_components
ON CONFLICT (part_number) DO UPDATE
SET description = COALESCE(NULLIF(public.kit_components.description,''), EXCLUDED.description);

UPDATE public.kit_components kc
SET part_id = p.id
FROM public.parts p
WHERE kc.part_id IS NULL AND UPPER(p.part_number) = UPPER(kc.part_number);

-- ---------- 4. BOM ----------
INSERT INTO public.kit_bom_lines (kit_sku_id, component_id, line_number, qty_per_kit, uom, source)
SELECT ks.id, kc.id,
       NULLIF(b.line_number,'')::integer,
       COALESCE(NULLIF(b.qty_per_kit,'')::numeric, 0),
       COALESCE(NULLIF(b.uom,''),'ea'),
       'workbook_v5_3 Components tab'
FROM stage_bom b
JOIN public.kit_skus ks ON UPPER(ks.part_number) = UPPER(b.kit_part_number)
JOIN public.kit_components kc ON UPPER(kc.part_number) = UPPER(b.component_part_number)
ON CONFLICT (kit_sku_id, component_id) DO UPDATE
SET line_number = EXCLUDED.line_number,
    qty_per_kit = EXCLUDED.qty_per_kit,
    uom = EXCLUDED.uom,
    source = EXCLUDED.source;

-- ---------- 5. sales + lines ----------
INSERT INTO public.kit_sales (so_number, party_id, customer_po, order_date, ship_date, so_status, salesperson)
SELECT s.so_number, kp.id, NULLIF(s.customer_po,''),
       NULLIF(s.order_date,'')::date, NULLIF(s.ship_date,'')::date,
       NULLIF(s.so_status,''), NULLIF(s.salesperson,'')
FROM stage_sales s
LEFT JOIN public.kit_parties kp ON kp.normalized_name = s.party_key
ON CONFLICT (so_number) DO UPDATE
SET party_id = COALESCE(EXCLUDED.party_id, public.kit_sales.party_id),
    customer_po = EXCLUDED.customer_po,
    order_date = EXCLUDED.order_date,
    ship_date = EXCLUDED.ship_date,
    so_status = EXCLUDED.so_status,
    salesperson = EXCLUDED.salesperson;

INSERT INTO public.kit_sale_lines (kit_sale_id, kit_sku_id, qty_ordered, qty_shipped, invoice_numbers)
SELECT sa.id, ks.id,
       NULLIF(l.qty_ordered,'')::integer, NULLIF(l.qty_shipped,'')::integer,
       NULLIF(l.invoice_numbers,'')
FROM stage_sale_lines l
JOIN public.kit_sales sa ON sa.so_number = l.so_number
JOIN public.kit_skus ks ON UPPER(ks.part_number) = UPPER(l.kit_part_number)
ON CONFLICT (kit_sale_id, kit_sku_id) DO UPDATE
SET qty_ordered = EXCLUDED.qty_ordered,
    qty_shipped = EXCLUDED.qty_shipped,
    invoice_numbers = EXCLUDED.invoice_numbers;

-- ---------- 6. invoices ----------
INSERT INTO public.fishbowl_invoices (invoice_number, party_id, so_number, first_ship_date, invoice_lines, salesperson)
SELECT i.invoice_number, kp.id, NULLIF(i.so_number,''),
       NULLIF(i.first_ship_date,'')::date,
       NULLIF(i.invoice_lines,'')::integer, NULLIF(i.salesperson,'')
FROM stage_invoices i
LEFT JOIN public.kit_parties kp ON kp.normalized_name = i.party_key
ON CONFLICT (invoice_number) DO UPDATE
SET party_id = COALESCE(EXCLUDED.party_id, public.fishbowl_invoices.party_id),
    so_number = EXCLUDED.so_number,
    first_ship_date = EXCLUDED.first_ship_date,
    invoice_lines = EXCLUDED.invoice_lines,
    salesperson = EXCLUDED.salesperson;

-- ---------- 7. lots ----------
INSERT INTO public.kit_lots (book_id, lot_number, kit_sku_id, log_date, kit_part_as_written,
       customer_as_written, party_id, invoice_as_written, stud_number, rec_platemount_number,
       record_status, source, source_page, transcription_confidence, transcription_notes, notes)
SELECT b.id, l.lot_number::integer, ks.id,
       NULLIF(l.log_date,'')::date, NULLIF(l.kit_part_as_written,''),
       NULLIF(l.customer_as_written,''), kp.id, NULLIF(l.invoice_as_written,''),
       NULLIF(l.stud_number,''), NULLIF(l.rec_platemount_number,''),
       l.record_status, 'paper_transcription', NULLIF(l.source_page,''),
       NULLIF(l.transcription_confidence,''), NULLIF(l.transcription_notes,''), NULLIF(l.notes,'')
FROM stage_lots l
JOIN public.kit_books b ON b.code = l.book_code
LEFT JOIN public.kit_skus ks ON UPPER(ks.part_number) = l.kit_part_key
LEFT JOIN public.kit_parties kp ON kp.normalized_name = l.party_key
ON CONFLICT (book_id, lot_number) DO UPDATE
SET kit_sku_id = COALESCE(EXCLUDED.kit_sku_id, public.kit_lots.kit_sku_id),
    log_date = EXCLUDED.log_date,
    kit_part_as_written = EXCLUDED.kit_part_as_written,
    customer_as_written = EXCLUDED.customer_as_written,
    party_id = COALESCE(EXCLUDED.party_id, public.kit_lots.party_id),
    invoice_as_written = EXCLUDED.invoice_as_written,
    stud_number = EXCLUDED.stud_number,
    rec_platemount_number = EXCLUDED.rec_platemount_number,
    record_status = EXCLUDED.record_status,
    source_page = EXCLUDED.source_page,
    transcription_confidence = EXCLUDED.transcription_confidence,
    transcription_notes = EXCLUDED.transcription_notes,
    notes = COALESCE(public.kit_lots.notes, EXCLUDED.notes)
WHERE public.kit_lots.source = 'paper_transcription';

-- ---------- 8. aircraft ----------
INSERT INTO public.aircraft (serial_number, registration, country)
SELECT NULLIF(a.serial_number,''), NULLIF(a.registration,''), NULLIF(a.country,'')
FROM stage_aircraft a
WHERE COALESCE(a.serial_number,'') <> ''
ON CONFLICT (serial_number) DO UPDATE
SET registration = COALESCE(public.aircraft.registration, EXCLUDED.registration),
    country = COALESCE(public.aircraft.country, EXCLUDED.country);

INSERT INTO public.aircraft (serial_number, registration, country)
SELECT NULL, a.registration, NULLIF(a.country,'')
FROM stage_aircraft a
WHERE COALESCE(a.serial_number,'') = '' AND COALESCE(a.registration,'') <> ''
  AND NOT EXISTS (SELECT 1 FROM public.aircraft x
                  WHERE x.serial_number IS NULL AND x.registration = a.registration);

CREATE TEMP TABLE map_aircraft ON COMMIT DROP AS
SELECT s.aircraft_key, a.id AS aircraft_id
FROM stage_aircraft s
JOIN public.aircraft a
  ON (COALESCE(s.serial_number,'') <> '' AND a.serial_number = s.serial_number)
  OR (COALESCE(s.serial_number,'') = '' AND a.serial_number IS NULL AND a.registration = s.registration);

INSERT INTO public.aircraft_registrations (aircraft_id, registration, observed_date, source)
SELECT DISTINCT ON (m.aircraft_id, r.registration)
       m.aircraft_id, r.registration, NULLIF(r.observed_date,'')::date, r.source
FROM stage_aircraft_registrations r
JOIN map_aircraft m ON m.aircraft_key = r.aircraft_key
WHERE NOT EXISTS (SELECT 1 FROM public.aircraft_registrations x
                  WHERE x.aircraft_id = m.aircraft_id AND x.registration = r.registration)
ORDER BY m.aircraft_id, r.registration, NULLIF(r.observed_date,'')::date NULLS LAST, r.source;

-- ---------- 9. STC requests (insert-only) ----------
INSERT INTO public.stc_requests (intake_number, received_date, channel, requester_name,
       requester_company, requester_email, requester_party_id, claimed_kit_number,
       claimed_kit_part, claimed_aircraft_serial, claimed_registration, purchased_from_text,
       status, aircraft_id, notes)
SELECT r.intake_number::integer, NULLIF(r.received_date,'')::date, 'email',
       NULLIF(r.requester_name,''), NULLIF(r.requester_company,''), NULLIF(r.requester_email,''),
       kp.id, NULLIF(r.claimed_kit_number,''), NULLIF(r.claimed_kit_part,''),
       NULLIF(r.claimed_aircraft_serial,''), NULLIF(r.claimed_registration,''),
       NULLIF(r.purchased_from_text,''), r.status, m.aircraft_id, NULLIF(r.notes,'')
FROM stage_requests r
LEFT JOIN public.kit_parties kp ON kp.normalized_name = r.requester_party_key
LEFT JOIN map_aircraft m ON m.aircraft_key = r.aircraft_key
ON CONFLICT (intake_number) DO NOTHING;

-- ---------- 10. link passes ----------
-- Requests -> lots. Book ranges are disjoint, so a bare number is unambiguous.
UPDATE public.stc_requests r
SET kit_lot_id = kl.id
FROM public.kit_lots kl
WHERE r.kit_lot_id IS NULL
  AND r.claimed_kit_number ~ '^[0-9]{1,9}$'
  AND kl.lot_number = r.claimed_kit_number::integer;

-- Lots -> sale lines, via invoice-as-written -> Fishbowl invoice -> SO -> matching SKU line.
UPDATE public.kit_lots l
SET kit_sale_line_id = sl.id
FROM public.fishbowl_invoices fi
JOIN public.kit_sales s ON s.so_number = fi.so_number
JOIN public.kit_sale_lines sl ON sl.kit_sale_id = s.id
WHERE l.kit_sale_line_id IS NULL
  AND l.kit_sku_id IS NOT NULL
  AND l.invoice_as_written = fi.invoice_number
  AND sl.kit_sku_id = l.kit_sku_id;

-- Lots -> sale lines, via so-as-written -> SO -> matching SKU line. Bench-entered
-- rows carry the SO (no invoice exists yet), so they link on the first loader run
-- after the Fishbowl export catches up.
UPDATE public.kit_lots l
SET kit_sale_line_id = sl.id
FROM public.kit_sales s
JOIN public.kit_sale_lines sl ON sl.kit_sale_id = s.id
WHERE l.kit_sale_line_id IS NULL
  AND l.kit_sku_id IS NOT NULL
  AND l.so_as_written = s.so_number
  AND sl.kit_sku_id = l.kit_sku_id;

-- ---------- 11. installations (insert-only) from fully resolved requests ----------
INSERT INTO public.kit_installations (kit_lot_id, kit_sku_id, aircraft_id, installer_party_id,
       status, evidence)
SELECT DISTINCT ON (r.kit_lot_id, r.aircraft_id)
       r.kit_lot_id, kl.kit_sku_id, r.aircraft_id, r.requester_party_id,
       CASE WHEN sr.posted = 'yes' THEN 'verified' ELSE 'claimed' END,
       'STC intake #' || r.intake_number || ' (workbook v5_3)'
FROM public.stc_requests r
JOIN stage_requests sr ON sr.intake_number::integer = r.intake_number
JOIN public.kit_lots kl ON kl.id = r.kit_lot_id
WHERE r.kit_lot_id IS NOT NULL AND r.aircraft_id IS NOT NULL
  AND kl.kit_sku_id IS NOT NULL
  AND r.installation_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.kit_installations x
                  WHERE x.kit_lot_id = r.kit_lot_id AND x.aircraft_id = r.aircraft_id)
ORDER BY r.kit_lot_id, r.aircraft_id, r.intake_number;

UPDATE public.stc_requests r
SET installation_id = ki.id
FROM public.kit_installations ki
WHERE r.installation_id IS NULL
  AND ki.kit_lot_id = r.kit_lot_id AND ki.aircraft_id = r.aircraft_id;

-- ---------- 12. verification ----------
SELECT 'kit_parties' AS tbl, count(*)::text AS rows FROM public.kit_parties
UNION ALL SELECT 'kit_skus', count(*)::text FROM public.kit_skus
UNION ALL SELECT 'kit_components', count(*)::text FROM public.kit_components
UNION ALL SELECT 'kit_components linked to MES parts', count(*)::text FROM public.kit_components WHERE part_id IS NOT NULL
UNION ALL SELECT 'kit_bom_lines', count(*)::text FROM public.kit_bom_lines
UNION ALL SELECT 'kit_sales', count(*)::text FROM public.kit_sales
UNION ALL SELECT 'kit_sale_lines', count(*)::text FROM public.kit_sale_lines
UNION ALL SELECT 'fishbowl_invoices', count(*)::text FROM public.fishbowl_invoices
UNION ALL SELECT 'kit_lots', count(*)::text FROM public.kit_lots
UNION ALL SELECT 'kit_lots with sku resolved', count(*)::text FROM public.kit_lots WHERE kit_sku_id IS NOT NULL
UNION ALL SELECT 'kit_lots with party resolved', count(*)::text FROM public.kit_lots WHERE party_id IS NOT NULL
UNION ALL SELECT 'kit_lots linked to sale line', count(*)::text FROM public.kit_lots WHERE kit_sale_line_id IS NOT NULL
UNION ALL SELECT 'aircraft', count(*)::text FROM public.aircraft
UNION ALL SELECT 'aircraft_registrations', count(*)::text FROM public.aircraft_registrations
UNION ALL SELECT 'stc_requests', count(*)::text FROM public.stc_requests
UNION ALL SELECT 'stc_requests linked to aircraft', count(*)::text FROM public.stc_requests WHERE aircraft_id IS NOT NULL
UNION ALL SELECT 'stc_requests linked to lot', count(*)::text FROM public.stc_requests WHERE kit_lot_id IS NOT NULL
UNION ALL SELECT 'kit_installations', count(*)::text FROM public.kit_installations
UNION ALL SELECT 'stc_issuances (expected 0 - historical sends live in request notes)', count(*)::text FROM public.stc_issuances;

COMMIT;
