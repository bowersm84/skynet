KIT & STC REGISTRY — DATA LOAD (workbook v5_3)
==============================================

Prereq: 2026-08-01_kit_stc_registry_schema.sql already applied (done on TEST).

Run from this folder (paths in the script are relative):

  cd <this folder>
  & C:\pgsql\bin\psql.exe $env:TEST_DB_URL -f load_kit_stc.sql

PROD later, after TEST verification:

  & C:\pgsql\bin\psql.exe $env:PROD_DB_URL -f load_kit_stc.sql

Expected verification counts (TEST, first run):
  kit_parties 1856 | kit_skus 477 | kit_components 697 (3 linked to MES parts)
  kit_bom_lines 4420 | kit_sales 828 | kit_sale_lines 1347 | fishbowl_invoices 3596
  kit_lots 648 (647 with SKU - RV 3931 is a VOID row with no part written; 531 with party)
  kit_lots linked to sale line 0 (correct: transcribed rows are 2023-24,
    invoice window starts 2025-07-30; this pass activates as transcription
    reaches the 2025+ pages)
  aircraft 70 | aircraft_registrations 67 | stc_requests 71 (71 aircraft-linked, 2 lot-linked)
  kit_installations 2 (intake #34 -> SK203 99000, #66 -> BEECH 76958, both verified)
  stc_issuances 0 by design - and it stays empty for the historical rows.
    The six pre-system doc-sends (intakes 60, 61, 62, 65, 68, 70) are ACCEPTED
    AS ISSUED on the workbook's word: status 'issued' plus the sent date in
    notes IS the record for a send that predates the system (D-KSTC-22).
    Which certificate and version went out was never captured, and inventing
    those identities now would be fabrication, so nothing is reconstructed.
    stc_issuances records go-forward sends only - issuances created through
    the C2 workflow, where the document identity is known at send time.
    Intakes 1-71 are the only rows where 'issued' may exist without an
    stc_issuances row.

Idempotency rules:
  * Reference data upserts on natural keys - re-run any time with a fresh
    csv/ set as transcription batches or Fishbowl exports grow.
  * stc_requests and kit_installations are INSERT-ONLY: re-runs never touch
    statuses, links, or notes edited in the UI.
  * notes columns: first write wins; manual notes are never overwritten.
  * kit_lots upsert only touches rows whose source = 'paper_transcription';
    SkyNet-native lots are never modified by the loader.
  * bench-entered lots carrying so_as_written auto-link to sale lines on the
    next loader run after a Fishbowl export refresh.
