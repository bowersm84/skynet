# Rev 81 pricing loader

`load_rev81.py` is the one-shot Python 3 script (needs `openpyxl` and `pandas`) that turned the Excel pricing guide
into the Pricing Portal's first price book. It reads the inputs listed in its own docstring — the Rev 81 guide, Matt's
two decision workbooks, the 2026-09-03 Fishbowl pull (`PartsTable.csv`, `SaleHistory.csv`, `CustomerTotals.csv`) and
the compare round's pickles — applies decisions D-PRICE-05…15, and writes two outputs: `Docs/migrations/2026-09-05_pricing_seed_rev81.sql`
(Rev 81 active, Rev 82 cloned and scheduled for Oct 1, tiers and exceptions seeded) and `load_report.md` (counts for
every rule applied, which is what the seed's fingerprint is checked against). It is not part of the app or the Vite
build and is not meant to be re-run: **the seed SQL is the artifact of record** — the price book is edited in `/pricing`
from here on, never by re-loading the spreadsheet. The script and its report are committed so the provenance of every
seeded row stays readable.
