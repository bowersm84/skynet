# Kit Component-Lot Backfill (D-KSTC-24 / D-KSTC-25)

Loads shipped component lot numbers per kit lot into `kit_lot_component_lots`,
sourced from the curated Fishbowl "Shipping Report - Tracking Information"
export (per-lot rows; `lot_qty == qty_shipped` verified 100% on the
2026-08-03 export against packing slip S16373).

## Files
| File | Purpose |
|---|---|
| `2026-08-03_kit_lot_component_lots_schema.sql` | Table + indexes + RLS + touch trigger (run FIRST, once per env) |
| `filter_shipping_report.py` | Fishbowl export -> load CSV (re-runnable each refresh) |
| `kit_component_lots_load.csv` | Filtered load file from the 2026-08-03 export (38,207 rows) |
| `load_kit_component_lots.sql` | v2 psql loader: preflight + dry-run report + guarded idempotent insert |

## How lots resolve to SOs
- **Bench-era lots** (`source='skynet'`): direct — linked sale's
  `kit_sales.so_number`, else digit-normalized `so_as_written`. SO is a
  required entry field (D-KSTC-16/17), so all bench lots resolve.
- **Paper-era lots** (`source='paper_transcription'`): the books recorded
  INVOICES, not SOs (D-KSTC-11). The loader bridges
  `invoice_as_written` -> `fishbowl_invoices.invoice_number` -> `so_number`.
  Bridge reach = the `fishbowl_invoices` export window. To cover transcribed
  2024+ lots, re-export the Fishbowl invoice report from **2024-01-01**
  forward and rerun the `kit_stc_load` refresh before running this loader.
  (The shipping CSV starts 2024-01-02, so pre-2024 invoices can't match
  regardless — those lots remain era-gapped.)
- Void / no_entry lots excluded. Fishbowl `parent_kit_number` must equal the
  lot's SKU (normalized), so multi-kit SOs route components to the right kit.
  Same SKU logged twice on one SO: both lots receive the same set.

## Run order
```powershell
# 0. (once per env) schema migration -- SQL Editor, or:
& C:\pgsql\bin\psql.exe $env:TEST_DB_URL -f ..\2026-08-03_kit_lot_component_lots_schema.sql

# 1. dry run -- report only, run FROM this folder so \copy finds the CSV
& C:\pgsql\bin\psql.exe $env:TEST_DB_URL -f load_kit_component_lots.sql

# 2. insert pass
& C:\pgsql\bin\psql.exe $env:TEST_DB_URL -v run_insert=1 -f load_kit_component_lots.sql

# 3. repeat 0-2 against $env:PROD_DB_URL after TEST spot-checks
```
The loader preflights the target table and exits with instructions if the
migration hasn't run. A dry run that shows `resolvable_so = 0` in section 2a
means no lots carry a usable SO yet (e.g., TEST at paper-only baseline before
the invoice window is widened) — that's a data statement, not a failure.

## Behaviors & limits
- Idempotent: `ON CONFLICT (kit_lot_id, part, lot) DO NOTHING`. Re-running with
  a refreshed export only adds new rows; an existing row's qty is first-write-wins.
- Table writes are RPC/psql-only by design (no INSERT/UPDATE/DELETE RLS
  policies yet). Phase 2 adds admin/compliance correction policies copying the
  sibling kit-table expressions, plus the packing-slip RPC.
- Rows the CSV has that the registry lacks (kit never logged / SO era gap) are
  reported, not loaded. Re-run the loader after each transcription batch or
  Fishbowl refresh to pick them up.

## Refresh cycle
```powershell
python filter_shipping_report.py "<new export>.csv" kit_component_lots_load.csv
# then dry run + insert as above, TEST then PROD
```

## Rehearsal
Local Postgres 16, 2026-08-03 (two rounds): migration clean; report sections
verified incl. SKU-mismatch, era-gap, and SO-resolvability breakdowns; insert
covered S16373 same-SKU fan-out, sale-line path, invoice-bridge path (21+21+10+21
= 73 rows), idempotent rerun inserted 0; preflight quits cleanly when the table
is missing; loaded rows verified line-for-line against packing slip S16373.
