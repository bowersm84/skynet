# SkyNet MES — Sprint 11 Implementation Plan

**Sprint 11 — Pricing Portal (`/pricing`)**

Implementation Plan v1.0 · September 3, 2026

**Owner:** Matt Bowers
**Hard date:** October 1, 2026 price increase (+15% on every Each) must activate from the portal.
**Status:** Discovery closed 2026-09-03. Build starts Batch A.

---

## 1. Sprint Goal

Replace the shared Excel pricing guide with a SkyNet module that is the single source of pricing truth: a versioned price book with effective dates, the rule/ladder engine that reproduces every price on the guide, customer tier qualification, per-customer purchase history from Fishbowl, customer price sheets, and — in later phases — quoting and write-back of prices into Fishbowl.

The Oct 1 book is created and scheduled in Batch A, so the increase is a data event, not a deploy.

---

## 2. Background (what discovery found)

- The guide (Rev 81, 2026-05-26) is a **price book**: 2,264 single parts + 133 range rows, priced as `Each × rule multiplier` (rules A–P, 6 columns), with ~20 break-ladder variants by section, 17 SET rows summed from components, and a hand-typed "10000/25K" column on 66 parts. Anomalies were listed, decided and applied (`2026-09-03_Pricing_Guide_Anomalies_v2.xlsx`).
- **Fishbowl** (pull 2026-09-03): 10,980 products; 2,164 guide parts match exactly, 133 ranges resolve to 962 real SKUs, 100 guide parts have no product, 115 list prices disagree with the guide, 1,170 sold products are not on the guide (→ Resale section), 6,189 active products have never sold (Matt to remove). The 150 **active** Fishbowl pricing rules (2026-06-23) encode the guide but as *quantity* triggers for all customers — tier pricing is handed to anyone at 500+. The portal stops that; Phase F replaces those rules.
- **Tiers** are customer qualifications, not quantity breaks: 100/300/500 for everyone; Tier 1/2/3 and Premier by assignment. Paid-price analysis flagged 106 clear tier customers and 259 to review (`2026-09-03_Fishbowl_vs_Guide_Compare.xlsx`, tab *Customer tier candidates*); PinAir / Air Tractor / Irwin trade below Tier 3 on negotiated parts.
- **Customer master cleanup done today in Fishbowl:** 13,979 customers inactivated (no sales, not in QBO; plus hcollins' no-sales book), 40 Salesman fields set, hcollins retired (17 accounts → sgriner). Pending, packaged: rename of 459 tagged names (runbook + SQL).

---

## 3. Scope

### 3.1 In scope (this sprint — Batches A–D, live before Oct 1)
- Schema, RLS, RPCs, views for price books / rules / ladders / sections / items / exceptions / customer tiers.
- **Rev 81 loader**: one-shot Node script → seed SQL, applying every anomaly decision; Rev 82 (Oct 1, +15%) cloned and scheduled.
- **Bridge v1.3**: `fb_customers` mirror and `fb_so_history_lines` (all SO history since 2023-11-27, then incremental) + nightly product price snapshot (`fb_products`).
- `/pricing` module: Catalog, Customers (tier, history, price sheet), Price Books (view / clone / uplift / edit / schedule / diff), Lookup (part + customer + qty → price with basis).
- Customer **price sheet** export (XLSX + PDF).
- **Fishbowl Products CSV** export from the active book (interim manual write-back of list prices until Phase F).
- SkyNet `customers.name` sweep after the Fishbowl rename runs.
- Spec bump to v4.6, Decisions.md D-PRICE-##.

### 3.2 Later phases (planned, not this sprint)
- **Phase E — Quoting** (`quotes`, `quote_lines`, quote PDF from the acknowledgement layout, 14-day lock, `Q-YYMM-NNNN`).
- **Phase F — Fishbowl write-back** (`fb_outbound_commands` → bridge → `POST /api/import/Products` and `/api/import/Product-Pricing-Rules`; account groups Tier 1/2/3/Premier; deactivate the 150 qty-triggered rules; parity via `GET /api/products/:id/best-price`).

### 3.3 Out of scope
- Cost/margin in the portal (costing model stays separate; D-COST-##).
- Editing Fishbowl customers from SkyNet.
- Quantity-based *tier* pricing of any kind.

---

## 4. Decisions Locked

| ID | Topic | Decision |
|---|---|---|
| D-PRICE-01 | Source of truth | The portal's active price book. The Excel guide is retired after cutover; Rev 81 is the seed. |
| D-PRICE-02 | Price model | `unit price = Each × multiplier`. Each stored to **3 dp** (`ROUND(x,3)`). Displayed/quoted prices rounded half-up to 2 dp at use time. |
| D-PRICE-03 | Columns | Quantity breaks 100 / 300 / 500 — everyone. Tier 1 / 2 / 3 / **Premier** — customer qualification, no quantity trigger. The quantities printed in the guide's tier headers are ignored. |
| D-PRICE-04 | Tier vs break | A tiered customer pays the tier price at any quantity (tier multipliers are always below the 500-break in every rule). Non-tiered customers get the largest break their quantity reaches. |
| D-PRICE-05 | Premier | One standard: **Premier = Tier 3 × 0.97** on parts flagged `has_premier` (the 66 that carry the column today). A Premier customer buying an unflagged part pays Tier 3. |
| D-PRICE-06 | Customer-part specials | SK201-2…-6 (PinAir, 83.3% of T3) and SK40R17-1/-1E/-2 (Air Tractor, 82.4% of T3) become `price_exceptions` keyed on customer × part as a **percent of Tier 3**, so they move with the Each. Other Premier customers on those parts get the 97% standard. |
| D-PRICE-07 | Rule table | F Tier 3 = 0.73. K → D. N → C. P retired; its 4 parts → A with ladder `each_t1_t2` (no breaks, no Tier 3). Rule table becomes 7 columns (incl. Premier as the global 0.97). |
| D-PRICE-08 | Ladders | Per section, loaded as decided: standard (100/300/500/T1/T2/T3), tools (5/10/25), platemount (10/50/T1/T2/T3-Dealer), etc. Kit/set header ladders ignored. Every ladder is data (`price_ladders`), never schema. |
| D-PRICE-09 | Kits / sets | 17 SET rows + Cloc 2000 Kit = Σ component prices per column, computed live from `kit_components`. No stored kit price. |
| D-PRICE-10 | Range rows | Kept as the price holder; expanded on load to the Fishbowl SKUs that exist (962). Ranges with no product (30) load nothing. Range syntax is never parsed at runtime. |
| D-PRICE-11 | Duplicates / overrides | Duplicate part rows: higher Each wins. Hand-typed break cells ignored. Each-as-formula → its value. Each = 0 row dropped. |
| D-PRICE-12 | Unpriced parts | 76 guide rows without an Each and 120 resale items → `status = 'no_price'`; visible in Catalog as "No pricing available", excluded from sheets/quotes. |
| D-PRICE-13 | Resale section | 1,170 Fishbowl products sold since Nov-23 and not on the guide → section **Resale Items**: Each = Fishbowl `product.price`, ladder `none` (no breaks, no tiers, no Premier). Matt's proposal-sheet edits applied (8 removed, 3 priced, 3 aliased). Resale Eaches are **not** uplifted on Oct 1 (assumption — see §11). |
| D-PRICE-14 | DFAR | `R` and blank → `N`. |
| D-PRICE-15 | Oct 1 | Rev 82 = clone of Rev 81 with every catalog Each × 1.15 (3 dp), `effective_from = 2026-10-01`, status `scheduled`. Price resolution is by date, so activation is automatic and price sheets "as of Oct 1" can be produced in September. |
| D-PRICE-16 | Book lifecycle | `draft → scheduled → active → superseded`. Only one book can be effective for a date. Edits only on drafts; a scheduled book reverts to draft to edit. |
| D-PRICE-17 | Access | Edit (books, items, rules, tiers, exceptions): **admin** only. View everything (incl. tiers, history, sheets): admin, `customer_service` (April, Christy, Sawyer, Peyton), president, viewer. Office login only — no PIN, no kiosk JWT. Gate in `roles.js` (`canViewPricing`, `canEditPricing`) and in every RPC (`_pricing_gate`). |
| D-PRICE-18 | Customer key | Fishbowl is the customer master. Tiers and exceptions key on `fb_customer_id`; SkyNet `customers.id` is linked where the Order Queue linker already set it. |
| D-PRICE-19 | Purchase history | `fb_so_history_lines` = every SO line since 2023-11-27 (all statuses except Estimate/Void), refreshed nightly by `dateLastModified` + on-demand; open SOs continue to come from `fb_sales_order_lines`. `v_customer_purchases` unions both. |
| D-PRICE-20 | Salesperson | `fb_customers.salesman` (Fishbowl username) → SkyNet profile via `fb_users`/email; rep tags in names are display-stripped (`name_clean`) until the Fishbowl rename runs. |
| D-PRICE-21 | Price sheet | Guide-style sections; the customer's purchased parts by default (toggle: full catalog / chosen sections); one price column = their tier (or the three breaks for non-tiered); DFAR flag; "Prices effective <date>", book rev, salesperson; XLSX (SheetJS) and PDF (pdf-lib), generated client-side. |
| D-PRICE-22 | Interim Fishbowl sync | Price Books page exports a Fishbowl **Products** import CSV (ProductNumber, Price) from any book so Matt can push list prices by hand until Phase F. |
| D-PRICE-23 | Quotes (Phase E) | Lock the resolved prices for 14 days; `Q-YYMM-NNNN`; rep = logged-in user; layout from the Fishbowl acknowledgement; terms = the returns text. |
| D-PRICE-24 | Write-back (Phase F) | Outbound-only command queue polled by the bridge (D-FB-01 preserved). Qty breaks → all-customer rules; tiers → account-group rules; the 150 qty-triggered tier rules deactivated. |
| D-PRICE-25 | Feature flag | `FEATURES.PRICING_PORTAL` (config.js). False → `/pricing` renders the "not enabled" card. |

---

## 5. Data Model

All new tables in `public`; SELECT for `authenticated` via RLS; **no direct write policies** — writes only through SECURITY DEFINER RPCs behind `_pricing_gate(text[])` (NULL-uid SQL-Editor passthrough, `user_has_role`, anon revoked). Bridge tables use `_fb_gate` (D-FB-07).

### 5.1 Price book
```
price_books        id, rev_label ('Rev 81 — Jun 2026'), effective_from date, status (draft|scheduled|active|superseded),
                   source ('guide_rev81'|'clone'), cloned_from_book_id, uplift_pct numeric, premier_pct numeric DEFAULT 0.97,
                   notes, created_by, created_at, published_by, published_at
price_rules        book_id, code, m_q100, m_q300, m_q500, m_tier1, m_tier2, m_tier3  (PK book_id, code)
price_ladders      book_id, code ('standard','tools_5_10_25','platemount','kit_2_5','each_t1_t2','none', …),
                   columns jsonb  -- [{key:'q100',kind:'qty',min:100,label:'100'}, …, {key:'tier1',kind:'tier'}, …]
price_sections     id, book_id, name, sort, kind (catalog|resale), header_note, dfar_default
price_items        id, book_id, section_id, part_number (citext), fb_product_id, part_id, kit_sku_id, description,
                   list_price numeric(12,3), rule_code, ladder_code, has_premier bool, dfar bool,
                   xref_arconic, xref_lisi, nsn, cessna, sort, status (priced|no_price|component_sum),
                   source_row int, range_of text,   UNIQUE (book_id, part_number)
kit_components     item_id, component_part_number, qty numeric DEFAULT 1
price_exceptions   id, fb_customer_id, part_number, mode (pct_of_tier3|fixed), value numeric, note,
                   effective_from, effective_to, created_by, created_at
```
Books are copied whole on clone (rules, ladders, sections, items, kit_components); exceptions are book-independent.

### 5.2 Customers
```
fb_customers            fb_customer_id PK, customer_number, name, name_clean, is_active, salesman, account_groups,
                        payment_terms, fb_date_created, fb_date_modified, synced_at, removed_at, customer_id uuid (SkyNet link)
customer_pricing        id, fb_customer_id, tier (none|tier1|tier2|tier3|premier), effective_from date, effective_to,
                        set_by, note, created_at        -- history kept; current = effective_to IS NULL
fb_so_history_lines     fb_soitem_id PK, fb_so_id, so_number, fb_customer_id, so_status_id, line_status_id, product_num,
                        part_num, description, qty_ordered, qty_fulfilled, unit_price, total_price,
                        fb_date_created, fb_date_completed, salesman, synced_at
fb_products             fb_product_id PK, product_num, part_num, description, list_price, is_active, synced_at
```
Views: `v_customer_purchases` (history ∪ open lines; part, first/last, qty, revenue, last price), `v_customer_pricing_current`, `v_price_matrix` (item × ladder column → price, for the book effective on a date).

### 5.3 RPCs (SECURITY DEFINER)
| RPC | Role gate | Purpose |
|---|---|---|
| `pricing_book_for_date(as_of)` | view | Effective book id (max `effective_from ≤ as_of`, status ∉ draft) |
| `pricing_get_price(part, fb_customer_id, qty, as_of)` | view | Returns unit_price, column used, tier, exception flag, book rev, `no_price` reason |
| `pricing_customer_sheet(fb_customer_id, as_of, mode)` | view | Rows for the price sheet |
| `pricing_clone_book(src, label, effective_from, uplift_pct)` | admin | Deep copy; catalog Eaches × (1+pct), 3 dp |
| `pricing_publish_book(book, effective_from)` | admin | draft → scheduled/active; supersedes overlapping books |
| `pricing_unpublish_book(book)` | admin | scheduled → draft |
| `pricing_upsert_item / delete_item / upsert_rule / upsert_ladder / upsert_section` | admin | Draft books only |
| `pricing_set_customer_tier(fb_customer_id, tier, effective_from, note)` | admin | Closes the open row, opens a new one |
| `pricing_upsert_exception / close_exception` | admin | |
| `fb_upsert_customers(jsonb)`, `fb_upsert_so_history(jsonb)`, `fb_upsert_products(jsonb)` | `_fb_gate(integration)` | Bridge v1.3 |

### 5.4 Price resolution (`pricing_get_price`, and the same logic in `src/lib/pricing.js` for grids)
1. `book = pricing_book_for_date(as_of)`; `item = price_items[book, part]` (case-insensitive). Missing → `no_price('not in book')`. `status = no_price` → `no_price`.
2. `component_sum` → recurse over `kit_components` with the same customer/qty/as_of and sum.
3. Resale (`ladder none`) → `list_price`.
4. `tier = customer's tier at as_of` (none if no customer).
5. Exception for (customer, part) in effect → `pct_of_tier3 × list × m_tier3` (or fixed) → done.
6. Tier ≠ none and the ladder has tier columns: `premier` → `has_premier ? list × m_tier3 × premier_pct : list × m_tier3`; else `list × m_<tier>`. Ladder `each_t1_t2` with tier3/premier → Tier 2 value.
7. Otherwise: largest `qty` column with `min ≤ qty` → `list × m_<col>`; none → `list`.
8. Round half-up to 2 dp on output; carry the unrounded value for extended totals.

---

## 6. Loader (Rev 81 → seed)

`tools/pricing-loader/load_rev81.mjs` (Node, `xlsx`; outside the Vite build). Reads the guide + the decision workbooks, writes `Docs/migrations/2026-09-XX_pricing_seed_rev81.sql` (one transaction, idempotent on `(book_id, part_number)`) and `load_report.md` (counts per rule applied). Rules, in order:

1. Skip SK5S5-*, D8-316-709-190, row 1493, the 8 resale removals.
2. Rule table from Q15:W30 with D-PRICE-07 applied; ladders from header rows per the *Ladders* decisions.
3. Items: Each `ROUND(,3)`; duplicates → higher Each; typed break cells ignored; DFAR R/blank → N; descriptions from Matt's *No description* answers; `has_premier` = column O populated.
4. Ranges → one item per Fishbowl SKU from *Range rows → SKUs*, `range_of` = the source string.
5. SET rows + Cloc 2000 Kit → `component_sum` with `kit_components` from the formula references (rows 64/121/216/233/312/454/593/610 + 657 + 744/748, per SET).
6. Rule-P parts → rule A, ladder `each_t1_t2`.
7. Exceptions: PinAir × SK201-2/3/31/4/5/6 @ 0.833; Air Tractor × SK40R17-1/-1E/-2 @ 0.824 (fb_customer_ids from `fb_customers`).
8. Resale section from the compare workbook + Matt's proposal sheet: FB `product.price` (3 dp); 120 → `no_price`; SK244-461 1.50, SK245A36 2.00, SK245C36 5.00; SK213-1SD → SK212-12SD's row; SK203A01A → SK203A01AE's row; SK212-12S8 → SK212-12S's row.
9. `fb_product_id` / `part_id` / `kit_sku_id` resolved by part number (D-FB-08 rule).
10. Rev 82: `pricing_clone_book(rev81, 'Rev 82 — Oct 2026', '2026-10-01', 0.15)` — catalog sections only.
11. Tier seed: `customer_pricing` rows for the 106 candidates at their inferred tier, `note = 'seeded from paid-price analysis 2026-09-03 — confirm'`; everyone else `none`.

Verification (SQL Editor, aggregation only): item count = 2,264 − skips + 962 + resale; `count(*) || md5(string_agg(part_number || list_price))` fingerprint matches the loader's; a 12-part spot table (SK2600-1 rule C, SK40S5-2S rule A, an SK35C L part, a SET, a resale item, a Rule-P part) reproduces the guide's cells at every column.

---

## 7. Bridge v1.3 (`tools/fishbowl-bridge/`)

- **`customers` poller** — every 15 min: `SELECT id, number, name, activeFlag, defaultSalesmanId, dateCreated, dateLastModified FROM customer WHERE dateLastModified > :cursor`; join `sysuser` for the username; account groups via `accountgrouprelation`. Backfill all on first run. `name_clean` computed in the RPC (strip `/AB /CE /PM /SG /HC`).
- **`so_history` poller** — nightly 02:00 + `--backfill` flag: `soitem` joined `so` for `so.statusId NOT IN (10,80,85,90)` and `so.dateLastModified > :cursor`; product lines only (`typeId IN (10,30)`). ~35k customer×product lines expected on backfill; upsert in 500-row batches.
- **`products` poller** — nightly: `product` ⋈ `part` → `fb_products` (gives Phase F its parity baseline and the Resale section its prices).
- `fb_sync_state` gains `last_customers_at`, `last_history_at`, `last_products_at`. Banner in `/pricing` shows the three ages.
- Same identity (`skynet-bridge`, `integration` role), same `_fb_gate`, same PROD/TEST split (D-FB-37).

---

## 8. `/pricing` Module

Route `/pricing` outside MainApp (KitKiosk pattern), office session only, `FEATURES.PRICING_PORTAL`, header shows book in effect today and the scheduled Rev 82 with its date. Tabs:

1. **Lookup** — part typeahead (items + Fishbowl products), customer typeahead (`fb_customers`, clean name + number + salesman chip), qty, as-of date (defaults today; quick toggle "Oct 1"). Shows the price, the column used, tier, exception badge, all columns of the ladder, DFAR, xrefs, kit breakdown, and the customer's last 5 purchases of that part.
2. **Catalog** — sections → items grid (`v_price_matrix`), search across part / xref / NSN / description, "as of" date, tier columns hidden unless `canViewPricing`, Resale section last, `no_price` rows greyed.
3. **Customers** — search; tier badge with history; **Set tier** (admin); exceptions list (admin edit); purchase history (part, description, first/last, qty, revenue, last paid vs current price, %); **Price sheet** button → options (as-of date, purchased-only / sections / full, XLSX / PDF).
4. **Price Books** (admin; read-only card for others) — list with status/effective dates; open a book: sections/items editable when draft, rules and ladders tabs, **Diff vs active** (Each / % change per part, the guide's "% diff" columns done properly), **Clone** (label, effective date, % uplift), **Schedule / Unschedule / Publish now**, **Export Fishbowl Products CSV**.

Shared: `src/lib/pricing.js` (client-side mirror of §5.4 for grid rendering; the RPC remains authoritative for anything that leaves the screen), `src/lib/priceSheet.js` (SheetJS/pdf-lib), `src/components/pricing/*`.

---

## 9. Claude Code Prompt Batches

### Batch A — Schema, loader, bridge (target TEST 2026-09-08)
- `2026-09-04_pricing_schema.sql` — tables, RLS, gates, RPCs, views (TEST).
- Loader script + `load_report.md`; `2026-09-05_pricing_seed_rev81.sql` (TEST) → Rev 81 active, Rev 82 scheduled, tiers seeded, exceptions seeded.
- Bridge v1.3 pollers + `fb_*` RPCs; run on TEST from Matt's PC (per_cycle), `--backfill` history.
- Quick test: `pricing_get_price` spot table; `v_customer_purchases` for Airparts and PinAir; banner ages.

### Batch B — Portal shell, Lookup, Catalog, Customers (target TEST 2026-09-12)
- `config.js` flag, `roles.js` gates, route, `Pricing.jsx` shell, Lookup, Catalog, Customers (tier set, history). No Price Books editing yet.
- Quick test: April looks up SK40S5-2S for Airparts (Tier 3) at qty 50 → $3.47 today, Oct 1 toggle → $3.99; a non-tiered customer at 300 → break price; PinAir SK201-2 → exception price.

### Batch C — Price Books, price sheet, exports (target TEST 2026-09-18)
- Price Books page (diff, clone, edit, schedule), price sheet XLSX/PDF, Fishbowl Products CSV export, SkyNet `customers.name` sweep SQL (run after the Fishbowl rename).
- Walkthrough with April + Christy on TEST; annotated-screenshot fixes.

### Batch D — PROD cutover (target 2026-09-24)
1. Schema SQL on PROD → 2. seed SQL on PROD (Rev 81 active, Rev 82 scheduled Oct 1) → 3. bridge v1.3 to skyserver (NSSM restart, `--backfill` once) → 4. flag on, fast-forward merge → 5. verify the spot table on PROD; Products CSV import into Fishbowl for the 115 list-price mismatches + resale prices (optional, Matt's call) → 6. retire the Excel guide (read-only copy in Drive).
Expected visible outcome: `/pricing` on PROD shows "Rev 81 in effect · Rev 82 effective 2026-10-01"; Oct 1 needs no action.

### Batch E — Quoting (October)
### Batch F — Fishbowl write-back (Oct/Nov)

Batches are gated: A ✅ before B, B ✅ before C. Every prompt opens `BEFORE STARTING: Read Docs/Decisions.md and plan in full`, SQL ships as its own file, Decisions.md append is the prompt's final task.

---

## 10. Test Checklist

| ID | Test |
|---|---|
| T-01 | Seed fingerprint on TEST matches `load_report.md`; item count per section matches; 962 range-derived items carry `range_of`. |
| T-02 | Spot table (12 parts × 7 columns) reproduces Rev 81 cell-for-cell at 2 dp. |
| T-03 | `pricing_book_for_date('2026-09-30')` = Rev 81; `('2026-10-01')` = Rev 82; Rev 82 Each = ROUND(Rev 81 × 1.15, 3); resale Eaches unchanged. |
| T-04 | Tiered customer, qty 1 → tier price; non-tiered, qty 299 → 100-break, qty 300 → 300-break; qty 5,000 non-tiered → 500-break (never a tier). |
| T-05 | Premier customer on a `has_premier` part → T3 × 0.97; on a non-flagged part → Tier 3. |
| T-06 | PinAir × SK201-2 → 83.3% of T3; another Premier customer × SK201-2 → 97%. |
| T-07 | SET row = Σ components at the customer's column; changes when a component Each changes in a draft. |
| T-08 | Rule-P parts: no break columns, Tier 3/Premier customers get Tier 2. |
| T-09 | `no_price` items show "No pricing available" and are absent from sheets. |
| T-10 | Resale item → Fishbowl Each at any qty/tier. |
| T-11 | RLS: `customer_service` can read everything, cannot call an admin RPC (error), sees no edit controls; `machinist` cannot open `/pricing`. |
| T-12 | Bridge: new Fishbowl customer appears in `fb_customers` within 15 min; a closed SO lands in history after the nightly run; `name_clean` strips the tag. |
| T-13 | Price sheet for Airparts (purchased-only, as of Oct 1) opens in Excel and as PDF; header shows date, rev, salesperson; DFAR column present. |
| T-14 | Clone → edit one Each in the draft → diff shows exactly one part → schedule → lookup on that date reflects it; unschedule reverts. |
| T-15 | Fishbowl Products CSV from Rev 81 imports into Fishbowl TEST (or a 5-row test) without error. |
| T-16 | SkyNet `customers.name` sweep leaves CO numbers and links intact. |

---

## 11. Risks & Open Items

- **Fishbowl keeps giving tier prices at 500+ until Phase F.** Reps must price SOs from the portal (as they do from the sheet today). Interim mitigation: Products CSV export keeps `product.price` = Each so acknowledgements stop printing $0/wrong list.
- **Resale Each and the +15%** — plan assumes resale items are *not* uplifted (they follow Fishbowl). Confirm.
- **Tier seeds are candidates**, not truth — April/Sawyer must confirm the 106 before sheets go to customers; sheets for `none` customers show breaks only, so a wrong seed is visible, not silent.
- **`fb_customer_id` vs SkyNet `customers`** — the Order Queue linker set `customer_id` on SOs, not on customers; the sweep (Batch C) sets `fb_customers.customer_id` by matching `customers.customer_id` = Fishbowl customer number. Unmatched SkyNet customers get no tier until linked.
- **History volume** — ~35k lines; SheetJS price sheets are fine, but the Customers history grid paginates at 500.
- **Rename timing** — until the Fishbowl rename runs, `name_clean` handles display; after it runs, `fb_customers` self-heals from the poller.
- **Rev 82 edits after scheduling** — any Each change on the Oct 1 book must go through unschedule → edit → reschedule; the UI enforces it.

---

## 12. Spec & Documentation Updates
- Spec → **v4.6**: §3.1 roles (pricing gates), new §5.28 Pricing Portal, §10 schema, §11 D-PRICE rows, §13 Fishbowl bridge v1.3.
- `Docs/Decisions.md` — D-PRICE-01…25 appended by CC (Batch A), later batches append their own.
- `Docs/migrations/` — schema and seed SQL; `tools/pricing-loader/` committed with its report.
- `Docs/Fishbowl_Data_Context.md` — customers / so history / products sections.

## 13. Definition of Done
- T-01…T-16 pass on TEST; Batch D sequence completed on PROD; `/pricing` live for admin + customer_service + president/viewer.
- Rev 82 scheduled on PROD with `effective_from = 2026-10-01`; the Oct 1 morning check is a single lookup, not a deploy.
- Excel guide marked superseded; Spec v4.6 + Decisions.md updated.
