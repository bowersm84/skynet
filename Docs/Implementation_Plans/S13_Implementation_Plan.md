# SkyNet MES — Sprint 13 Implementation Plan

**Sprint 13 — Fishbowl Inventory Module: Stock Levels, Reorder Points, Month-End Valuation**

Implementation Plan v1.0 · October 6, 2026

**Owner:** Matt Bowers
**Status:** Discovery closed Oct 6 (seed workbook decided, Fishbowl query supplied, QBO accounts read). Awaiting plan sign-off.
**Target:** Batches A–C on PROD by Oct 20, so the first automatic month-end snapshot lands the night of Oct 31 → Nov 1.

---

## 1. Sprint Goal

Make SkyNet the one place to look for Fishbowl *Product* inventory: a Fishbowl Inventory group in the Armory with live stock levels for every Product-class part, a reorder-point system seeded from Purchasing's critical-parts sheet with in-app alerts, and a month-end valuation report that gives Crystalyn the three journal-entry lines she posts in QuickBooks Online, with the per-part and per-lot support behind them.

---

## 2. Background

- Bridge 1.7.0 already mirrors Fishbowl on-hand / allocated / available / on-order every 5 minutes into `fb_part_inventory`, but only for ~1,300 parts (open-SO parts ∪ SkyNet parts ∪ anything already mirrored, D-FB-40). No part class, UOM, or average cost is mirrored; `fb_part_costs` carries last PO cost and std cost only.
- Purchasing keeps minimums on paper (`Critical_inventory_levels.pdf`, 55 parts in 9 categories). The seed workbook resolved every row to a Fishbowl part number (49 exact, 6 by decision). Day-one state against the 10/06 export: **SK2600CGP174 is below min** (126,985 on hand vs 150,000); SK2FW2SE and SK4FW2SE have no min yet.
- The QBO fresh start on Sept 1 opened inventory from `Skybolt_Opening_Inventory_Valuation_v1_0.xlsx` (Sept 2 snapshot). QBO as of Sept 30 (read Oct 6): **Inventory $1,561,080.53 = Finished Goods $1,236,249.94 + Raw Inventory $324,830.59**; the step-up from the old $1,300,825.65 was posted to COGS account **Inventory Adjustment (P&L)** (−$260,254.88, dated before Sept 1). Purchases are expensed as incurred (`Purchases - Raw Materials`, `Purchases - Outsourced Products`), so the books run a periodic method: each month-end needs a true-up of the two inventory accounts against Inventory Adjustment (P&L). No September true-up has been posted.
- The opening valuation basis is Matt's Fishbowl query (`Inventory_Detail_Query.txt`): `part.customFields '$."33".value'` is the valuation class, `partcost.avgCost` the unit cost, `SUM(tag.qty)` the quantity, `typeId = 10`. Product class on Sept 2: 1,656 parts, $1,236,249.94; on Oct 6: 1,655 parts with stock, $1,257,341.18, of which 577 parts carry a $0 average cost (understated value — a Fishbowl data-quality item, not fixed here). Raw bars and blanks were valued from SkyNet (negative lots floored to zero, 15 bar lots without a cost valued at $0).

---

## 3. Decisions Locked (Oct 6 answers + defaults)

| # | Decision | Source |
|---|---|---|
| 1 | **Class scope = Product only.** Stock Levels, Reorder Points and the valuation use parts whose Fishbowl valuation class (custom field 33) is `Product`. Tooling/MRO, Raw, Non-Product and unclassified parts are not shown and not valued. The 5-minute mirror keeps every part it holds today for the Order Queue / Create WO — "ignored" means not shown, not un-mirrored. | Matt Q3 |
| 2 | **Below-min basis = on hand**, summed over all location groups (the paper form's column). Available, allocated and on order are shown beside it; "on order covers the gap" is a hint, not a state. | Matt Q2 |
| 3 | **Reorder points are SkyNet-owned.** Fishbowl's own reorder feature is not in use and is not mirrored; nothing writes back to Fishbowl. | Matt Q7 |
| 4 | **Alerts are in-app**: group/tab badges plus a bell notification (`user_notifications`) to every active purchaser and admin on the ok → below crossing only; recovery clears the state silently. No email this sprint. | Matt Q5 |
| 5 | **Visibility**: Stock Levels + Month-End to admin, compliance, purchaser, president, viewer, customer_service, scheduler; Reorder Points visible to the same set, **writes to admin + purchaser only**; snapshot "take now" and "mark posted" admin only. | Matt Q6 |
| 6 | **Valuation basis = the opening query, mirrored nightly**: class from custom field 33, `partcost.avgCost / qty / totalCost`, quantity = `SUM(tag.qty)`. The 5-minute `qtyinventorytotals` feed stays the operational basis; a DIAG proves the two on-hand figures agree per part (expected: identical). | Matt Q4 |
| 7 | **Mirror every `typeId = 10` part's class, filter to Product in SkyNet.** Costs nothing more than `fb_products` (~11k rows nightly) and gives a "Product parts with no class" QA list, so a new part created without the custom field cannot silently drop out of month-end. | Default — veto if you want the literal filter |
| 8 | **Month-end snapshot is frozen data**, taken by the bridge after the nightly valuation mirror on the 1st (period_end = last day of the prior month), idempotent, catch-up if the bridge was down, plus an admin "Snapshot now" for ad-hoc. Raw bars and blanks are valued as-of from SkyNet's own history. | Default |
| 9 | **Raw basis carries the opening rules forward**: negative lots floored to zero, lots without a cost valued at $0 and counted; fractional bars per D-INV-07's charge model. | Default |
| 10 | **Journal entry = change in each balance since the prior snapshot** against the three QBO accounts exactly as named: `Finished Goods`, `Raw Inventory` (under Inventory), `Inventory Adjustment (P&L)` (COGS). The first snapshot's "prior" is the opening entry ($1,236,249.94 / $324,830.59). | Read from QBO Oct 6 |
| 11 | Decision family **D-FBINV-##** for the module; bridge changes **D-FB-52/53**; the month-end report **D-RPT-15**. Spec → **v4.9**. CC takes the next free numbers at build time. | Default |

### Sign-off asks (answer by number; defaults apply if you say "go")

1. **September close.** No Sept 30 snapshot exists. Default: the first entry (Oct 31) carries Sept 2 → Oct 31 movement in one posting. Alternative: you run the Fishbowl query now and I hand-build a one-off Sept 30 workbook (approximate — dated by when the query runs).
2. **No-min rules.** SK2FW2SE and SK4FW2SE seed as active rules in a "No min set" state (visible, never alert) until a min is entered in-app. OK?
3. **Recipients.** Reorder bells go to purchaser + admin (April, Sawyer, you). OK?
4. **Mark posted.** A one-click "Posted — QBO ref ___" on each month-end snapshot so the trail shows what was booked. Include (small)?
5. **Decision 7** (mirror all classes, filter in SkyNet) — keep, or literal Product-only mirror?

---

## 4. Sprint Scope

### 4.1 In scope

- Bridge **1.8.0**: nightly valuation mirror (`fb_part_valuation`), inventory scope widened to every Product-class part ∪ every reorder-point part, nightly snapshot call, one-shot `npm run mirror:valuation`.
- Schema: `fb_part_valuation`, `fb_reorder_points` (+ 55-row seed), reorder evaluation + role notification RPCs, `inventory_valuation_snapshots` (+ lines), `rm_valuation_as_of`, `inventory_snapshot_take`, `inventory_month_end_report`, two registry report views, `fb_sync_state.last_valuation_at`.
- Armory: third dropdown group **Fishbowl Inventory ▾** → **Stock Levels · Reorder Points · Month-End Valuation**, built in `src/components/fbinventory/`.
- Month-end deliverable: on-screen summary + journal entry + detail, XLSX export in the opening workbook's layout, CSV detail.
- Reports module: `fb-stock-on-hand` and `fb-reorder-status` registry rows (CSV + Uncle Bob, like every flat report).
- Spec v4.9, Decisions, cheatsheet update.

### 4.2 Out of scope (named so nobody expects them)

- Email digests (SES) for reorder alerts — follow-up if the bell proves insufficient.
- Writing reorder points or purchase requisitions into Fishbowl (backlog item stands).
- Fixing the 577 zero-cost Product parts in Fishbowl — surfaced as a list, not corrected.
- Pushing the journal entry into QBO — Crystalyn posts from the report.
- Non-Product classes in the module (Tooling/MRO, raw bar in Fishbowl, MS/AN hardware).
- A Sept 30 reconstruction (see sign-off ask 1).

---

## 5. Data Model

### 5.1 `fb_part_valuation` — nightly mirror (bridge)

One row per Fishbowl `part` with `typeId = 10`, keyed by `part_num` as Fishbowl spells it (`SK201/203 Clip`, `SK203C-CAGE`). Columns: `fb_part_id int`, `description text`, `is_active bool`, `valuation_class text` (`Product` | `Non-Product` | `Tooling - MRO` | `Raw - SkyNet Inventory` | `(unclassified)`), `qty_on_hand numeric` (`SUM(tag.qty)`), `avg_cost numeric`, `total_cost numeric`, `cost_layer_qty numeric`, `has_product bool`, `used_in_boms bool`, `synced_at timestamptz`, `removed_at timestamptz` (stamped when a part leaves the nightly result, as `fb_products` does). Generated `part_key` = `upper(regexp_replace(part_num, '\s', '', 'g'))` so it joins `fb_part_costs` and matches the reorder keys. RLS SELECT for authenticated.

RPC `fb_upsert_part_valuation(p_rows jsonb)` — `_fb_gate(ARRAY['integration','admin'])`, upsert by `part_num`, stamps `fb_sync_state.last_valuation_at` (new column), marks rows missing from a full payload `removed_at = now()`.

### 5.2 `fb_reorder_points`

`id uuid PK`, `part_num text NOT NULL` (Fishbowl spelling), `part_key text GENERATED` (unique), `category text` (Cups · Pins · Springs · Rings · Clips · Wings · Sandwich · Cages · Misc.), `min_qty numeric NULL`, `vendor text`, `notes text`, `is_active bool DEFAULT true`, `alert_state text CHECK IN ('ok','below','no_min','no_row')`, `alert_changed_at timestamptz`, `last_notified_at timestamptz`, `created_by/created_at`, `updated_by/updated_at`. RLS FOR ALL TO authenticated (the D-PURCH-02 pattern: write authority in the UI). Seeded with the 55 workbook rows, keys as decided:

| Sheet | Key | Note |
|---|---|---|
| SK2FW2S | SK2FW2SE | your "SK2FWSE" read as SK2FW2SE (only match); no min |
| SK4FW2S | SK4FW2SE | no min, no vendor |
| SK244-116 | SK241-16 | Steel Base Plate, 13,560 on hand |
| SK244-216 | SK242-16 | Steel Top Plate, 13,560 on hand |
| SK244-INS | SK40R17-244 | STEEL INSERT, 13,716 on hand |
| SK203C CAGE | SK203C-CAGE | 64,135 on hand |
| SK4000-2 | SK4000-2 | vendor stays blank ("?" on the sheet) |

### 5.3 Reorder evaluation

`fb_reorder_evaluate()` — SECURITY DEFINER, NULL-uid allowed, PUBLIC/anon revoked. For every active rule: `no_min` when `min_qty IS NULL`, `no_row` when the mirror has no row, `below` when `fb_part_inventory.qty_on_hand < min_qty`, else `ok`. Writes `alert_state` / `alert_changed_at` only on change; on `ok|no_min|no_row → below` inserts one `user_notifications` row per active purchaser/admin (`type = 'reorder_below_min'`, title "SK2600CGP174 below minimum", body "126,985 on hand · min 150,000 · 400,000 on order", payload `{part_num, on_hand, min_qty, on_order}`) through a new `_notify_roles(p_roles text[], …)` — `_notify_compliance` generalised, with `_notify_compliance` left as a one-line wrapper. Returns `{evaluated, below, newly_below, notified}`.

Called at the end of `fb_upsert_inventory` (one added `PERFORM`, CREATE OR REPLACE — the function is 1 KB and its signature does not change), so every 5-minute cycle re-evaluates with no bridge dependency; also callable from the Reorder Points tab ("Re-evaluate").

### 5.4 Month-end snapshots

`inventory_valuation_snapshots`: `id`, `period_end date`, `kind text CHECK IN ('month_end','adhoc')`, `label text`, `taken_at timestamptz`, `taken_by uuid NULL` (NULL = bridge), `fb_valuation_synced_at timestamptz`, `fb_inventory_at timestamptz`, `prior_snapshot_id uuid`, `totals jsonb` (product_value, product_parts, product_zero_cost_parts, product_zero_cost_qty, bars_value, bars_lots, bars_negative_lots, bars_no_cost_lots, blanks_value, blanks_lots, raw_value, total_value), `posted_at`, `posted_by`, `posted_reference text`. Partial unique index on `(period_end) WHERE kind = 'month_end'`.

`inventory_valuation_snapshot_lines`: `snapshot_id`, `source text CHECK IN ('fb_product','rm_bar','rm_blank')`, `line_key text` (part_num or lot), `description text`, `detail jsonb` (material, size, vendor, received, rack, heat…), `qty numeric`, `unit_cost numeric`, `value numeric`, `flags text[]` (`zero_cost`, `negative_floored`, `no_cost`, `inactive`, `count_first` for ≥100k pieces, the opening workbook's amber rule). RLS SELECT for authenticated.

RPCs:
- `rm_valuation_as_of(p_as_of timestamptz)` — per-lot: received `quantity` − Σ `material_usage.charge_bars` (used_at ≤ as-of) + Σ approved `adjustment_delta` (reviewed_at ≤ as-of), unit cost = `price_per_bar` else `price_per_lb × weight_lbs ÷ quantity` (the `report_inventory_movement` derivation), value = `greatest(on_hand, 0) × cost`. Bars and blanks by `material_receiving.category`. STABLE, REPORT_GATE pattern.
- `inventory_snapshot_take(p_period_end date DEFAULT NULL, p_kind text DEFAULT 'month_end', p_label text DEFAULT NULL)` — gate integration/admin. With no `p_period_end`: yesterday in America/New_York; if that is not a month-end and no month-end snapshot is missing, returns `{skipped: true}`; if the most recent month-end has no snapshot (bridge was down), takes it late and records `taken_at`. Builds Product lines from `fb_part_valuation` (class Product, `removed_at IS NULL`, qty ≠ 0 or |total_cost| > 0.005 — the opening query's filter), raw lines from `rm_valuation_as_of(period_end + 1 day 00:00 local)`, computes `totals`, links `prior_snapshot_id` to the latest earlier month-end. Idempotent per `(period_end, kind='month_end')`; ad-hoc snapshots always insert.
- `inventory_month_end_report(p_snapshot_id uuid)` → jsonb: header, prior (or the opening entry constants when there is no prior), balances and deltas per component, and the journal entry lines — `Finished Goods` and `Raw Inventory` debited when the balance rose / credited when it fell, `Inventory Adjustment (P&L)` as the balancing line, two decimals, debits = credits asserted in SQL. Flags and counts for the narrative.
- `inventory_snapshot_mark_posted(p_snapshot_id, p_reference text)` — admin.

### 5.5 Registry views

`v_report_fb_stock_on_hand` (part_number, description, category, on_hand, allocated, available, on_order, avg_cost, est_value, min_qty, reorder_status, flags, inventory_as_of, cost_as_of) and `v_report_fb_reorder_status` (one row per rule). Both revoke anon/public, grant SELECT to authenticated, and get `reports` rows (`sort_order` 130/131, view and export roles as Decision 5). Part numbers on every row (your standing rule).

### 5.6 Critical schema names (do not guess)

`fb_part_inventory.qty_on_hand / qty_allocated / qty_available / qty_on_order / qty_not_available / by_location / snapshot_at`; `fb_sync_state.last_inventory_at / last_products_at`; `fb_part_costs.part_key / std_cost / last_cost`; `material_receiving.category ('bar'|'blank') / quantity / price_per_bar / price_per_lb / weight_lbs / received_at / blank_type_id`; `material_usage.charge_bars / used_at / material_receiving_id`; `inventory_adjustment_requests.adjustment_delta / status / reviewed_at / price_per_bar_at_count`; `user_notifications (recipient_id, type, title, body, payload, created_by)`; `profiles.role / roles / is_active`; `user_has_role(uid, VARIADIC)`.

---

## 6. Bridge 1.8.0 (tools/fishbowl-bridge)

- `queries.mjs`: `partValuation` = the Oct 6 query verbatim minus the on-hand/cost filter, `WHERE p.typeId = 10` (all classes, Decision 7); `partNumsByClass` is not needed — the scope comes from SkyNet.
- `valuation.mjs` (new, pure mapper + poller): rides the products nightly slot after `syncPartCosts`, logged and swallowed like the kits sync; `VALUATION_ENABLED` (only the literal `false` disables).
- `skynet.mjs`: `upsertPartValuation(rows)`, `productClassPartNums()` (paged read of `fb_part_valuation` where class = Product, `removed_at IS NULL`), `reorderPartNums()`, `takeSnapshot()` → `inventory_snapshot_take`.
- `index.mjs`: `syncInventory` scope = open-SO ∪ SkyNet parts ∪ mirrored ∪ Product-class ∪ reorder parts (the cycle line gains two counts); after the nightly valuation mirror, `takeSnapshot()` guarded — a missing RPC (Batch C not yet applied) logs one warning and continues.
- `package.json` 1.8.0, `.env.example`, README (new poller, scope, snapshot, `npm run mirror:valuation` one-shot first load), `src/valuation.test.mjs` for the mapper (class normalisation, nulls, numeric coercion).
- Review route per cheatsheet §11: PC → TEST with `SESSION_MODE=per_cycle`, `KITS_SYNC_ENABLED=false`, `INVENTORY_DRY_RUN=true` first (probe lines now include SK2600CGP174, SK241-16, SK40R17-244, SK4FW2SE), then a real cycle and `npm run mirror:valuation`; DIAG on TEST; skyserver deploy by the per-version runbook after the PROD migration.

Expected load: inventory scope ≈ 1,318 → ~3,000–4,000 parts (every Product-class part, including zero stock) → ~12 Fishbowl reads of 300 and ~7 RPC calls of 500 per 5-minute cycle; one ~11k-row nightly read for the valuation mirror.

---

## 7. Frontend

### 7.1 Armory wiring (`src/pages/Armory.jsx`)

- `TAB_ACCESS_BY_ROLE`: `fb_stock`, `fb_reorder`, `fb_monthend` added per Decision 5.
- `allTabs`: three entries (icons: `Boxes`, `Bell`, `CalendarCheck`); counts: `fb_reorder` = below-min count (one light query on `fb_reorder_points where alert_state='below'`), `fb_monthend` = 1 when the latest month-end snapshot is un-posted and older than 3 days (nudge), else null.
- `TAB_GROUPS`: `{ key: 'fishbowl_inventory', label: 'Fishbowl Inventory', icon: Boxes, ids: FB_INVENTORY_TAB_IDS }` as the third group; `groupedIds` union updated. Group badge = sum of member counts, as today.
- Render: `{activeTab === 'fb_stock' && <StockLevelsTab profile={profile} />}` etc. — nothing else lands in Armory.jsx (353 KB).
- `lib/roles.js`: `FB_INVENTORY_VIEW_ROLES`, `canEditReorderPoints(profile)` (admin, purchaser), `canTakeSnapshot(profile)` (admin).

### 7.2 `src/components/fbinventory/`

- `hooks.js` — `useFbValuation()` (Product rows, `removed_at IS NULL`, paged 1,000), `useFbInventoryMap(partNums)` (reuses `lib/fishbowl.js` batched reader), `useReorderPoints()`, `useSyncState()`.
- `StockLevelsTab.jsx` — one row per Product part: part, description, on hand (5-min), allocated, available, on order, avg cost, est. value (on hand × avg cost, labelled "est."), min + status chip, flags (No cost · Inactive · Count first). Search; filters: Critical only · Below min · Zero stock · No cost · Unclassified Product (parts with has_product and class ≠ Product — the Decision 7 QA list); sort by any column; freshness line "Fishbowl inventory as of 1:12 PM · refreshed every 5 min · costs as of 2:10 AM" (amber when stale per `summarizeFbInventory`); CSV export for export roles via `toCsv`/`downloadCsv`. Rows render in pages of 250 with "show all".
- `ReorderPointsTab.jsx` — the Replenishment Rules pattern: banner "N parts below minimum · evaluated 1:12 PM", table grouped by category (part, description, min, vendor, on hand, available, on order, status chip: OK / Below min / No min set / Not in Fishbowl / Stale, "on order covers" hint), active toggle, edit, delete, Add rule (part typeahead over `fb_part_valuation` Product parts; category select; min; vendor; notes), Re-evaluate button (calls `fb_reorder_evaluate`). Writes gated by `canEditReorderPoints`; every write sets `updated_by`.
- `MonthEndTab.jsx` — list of snapshots (period end · kind · taken · FG · Raw · Total · Posted ref); "Snapshot now" (admin, ad-hoc with label) and "Take Oct 31 now" when a month-end is missing; open a snapshot → summary cards (Finished Goods, Raw – bars, Raw – blanks, Total; prior; change), the journal entry table (Account · Debit · Credit, balanced), narrative lines (parts counted, zero-cost parts and the quantity they hold, negative lots floored, no-cost lots), detail tabs (Product parts · Bars · Blanks, searchable), **Export XLSX** (SheetJS, already a dependency via `catalogExport.js`) with sheets `Summary · Entry Support · Product Detail · SkyNet Bars · SkyNet Blanks · Zero-Cost Products` — the opening workbook's layout so Crystalyn sees the same shape every month — plus CSV per detail tab; Mark posted (admin, reference text).
- `lib/monthEndExport.js` — pure builder from the report jsonb + lines to an AOA workbook; unit test `lib/monthEndExport.test.mjs` on a fixture (balanced entry, sheet totals equal the report totals).

### 7.3 Notifications

`NotificationsBell` already lists `user_notifications`; the `reorder_below_min` type needs a title/body only. If the bell supports a payload link, it deep-links to `/armory` with `tab=fb_reorder` (navigation persistence D-NAV-02 pattern); if not, it stays a plain notification.

---

## 8. Month-End Report — what Crystalyn gets

For period end M (first run Oct 31):

| Line | Source | Prior (Sept 30 / opening) | This month | Change |
|---|---|---|---|---|
| Finished Goods | `fb_product` lines: Σ qty × avg cost | 1,236,249.94 | from snapshot | Δ |
| Raw Inventory | `rm_bar` + `rm_blank` lines | 324,830.59 | from snapshot | Δ |

Journal entry (sign-aware): for each inventory account, debit when the change is positive, credit when negative; `Inventory Adjustment (P&L)` takes the opposite side of the net. Example shape only — numbers come from the snapshot:

```
Finished Goods                 Dr  12,345.67
Raw Inventory                             Cr  3,210.00
Inventory Adjustment (P&L)               Cr  9,135.67
```

The report states the snapshot time, the Fishbowl mirror times it was built from, the counts behind each total, and a "ties to" line: Finished Goods = Product Detail sheet total; Raw Inventory = Bars + Blanks sheet totals. Nothing on the entry is typed by hand.

---

## 9. Claude Code Prompt Batches

Each batch: SQL first (own file, applied to TEST by Claude, result stated), then the CC prompt (feature branch, build and stop — D-PROC-01), then the Quick Test Procedure. Wait for ✅ before the next batch.

### 9.1 Batch A — Data foundation + bridge 1.8.0 (≈1 day)

- `2026-10-07_S13_A_fb_valuation_reorder.sql` — §5.1, §5.2 (+ seed), §5.3, §5.5, `fb_sync_state.last_valuation_at`, grants/RLS, registry rows. Independently-runnable blocks; dry-run seed block with the 55-row preview first.
- `2026-10-07_D-FB-52_bridge_1.8.0_CC_Prompt.md` — §6, feature branch `feature/s13-bridge-valuation`.
- Review: dry run → real cycle from the PC against TEST → `2026-10-07_DIAG_S13_A_READONLY.sql` (coverage by class, reorder states — expect exactly 1 below / 2 no_min / 0 no_row, parity Σtag vs qtyinventorytotals for Product parts, notification rows created) → PROD migration (Matt) → skyserver deploy → DIAG on PROD.
- **Knock-on (say it out loud):** the first PROD evaluation fires one bell to April, Sawyer and you for SK2600CGP174 — tell them before the deploy. `fb_part_inventory` roughly triples; nothing changes visibly in the Order Queue or Create WO except more parts resolving.

### 9.2 Batch B — Armory group: Stock Levels + Reorder Points (≈1 day)

- `2026-10-08_D-FBINV_armory_CC_Prompt.md` — §7.1, §7.2 (first two tabs), §7.3, `lib/roles.js`; branch `feature/s13-fb-inventory`. No SQL.
- Quick test: group renders for admin/purchaser/customer_service; purchaser can add/edit a rule, customer_service cannot; SK2600CGP174 shows Below min; CSV export works for export roles; stale banner when the TEST bridge is off (it usually is — TEST heartbeat Sept 28).

### 9.3 Batch C — Month-End Valuation (≈1–1.5 days)

- `2026-10-09_S13_C_month_end_snapshots.sql` — §5.4, grants/RLS; executed first in a scratch Postgres against a hand-computed scenario (two lots, one negative, one no-cost, two product parts, one zero-cost) per cheatsheet §6, then TEST.
- `2026-10-09_D-RPT-15_month_end_CC_Prompt.md` — `MonthEndTab.jsx`, `lib/monthEndExport.js` + test; branch `feature/s13-month-end`.
- Review on TEST: take an ad-hoc snapshot, open it, export the XLSX, hand-check that Product Detail total = Finished Goods line and Bars + Blanks = Raw Inventory, entry balanced; then PROD migration and merge.

### 9.4 Batch D — Closeout (≈½ day)

- Spec v4.9: new §5.38 Fishbowl Inventory Module (Stock Levels, Reorder Points, Month-End Valuation), §5.27 bridge 1.8.0 note, §10.13 schema additions, Document History row; Decisions D-FBINV-01…, D-FB-52/53, D-RPT-15; cheatsheet v6 (month-end runbook: 1st of the month → check the snapshot landed → export → send to Crystalyn → mark posted).
- First real month-end: Nov 1 morning, confirm the Oct 31 snapshot exists, export, send.

---

## 10. Test Checklist

- Bridge dry run lists every probe part with on hand, class and avg cost; unknown-to-Fishbowl list unchanged from 1.7.0 plus nothing new.
- After a real cycle on TEST: `fb_part_valuation` ≈ 11k rows (typeId 10), Product class ≈ 1,655 with stock; `fb_part_inventory` covers every Product part; parity DIAG = 0 mismatches (or the mismatch list, by part, for review).
- `fb_reorder_evaluate()` on TEST: 55 rules → 52 ok, 1 below (SK2600CGP174), 2 no_min, 0 no_row; a second call creates no new notifications (crossing-only); lowering a min below on-hand clears `below`; raising it re-fires exactly once.
- Role gating: customer_service sees Stock Levels and cannot write rules; purchaser writes rules, cannot take a snapshot; viewer has no CSV export.
- Snapshot: ad-hoc on TEST matches the on-screen totals; `inventory_month_end_report` entry balances to the cent; a second `inventory_snapshot_take()` for the same month-end returns the existing id; `rm_valuation_as_of(now())` equals `material_availability` × cost with negatives floored (DIAG).
- XLSX: six sheets, Arial, totals as formulas, Product Detail total = Summary line; opens in Excel without repair.
- Reports module: both registry rows render, export, and reach Uncle Bob with part numbers on every row.

---

## 11. Risks & Open Items

- **Parity between `SUM(tag.qty)` and `qtyinventorytotals`.** Expected equal; if the DIAG shows drift, the month-end keeps the tag basis (ties to Fishbowl's own valuation report) and Stock Levels keeps the 5-minute basis, labelled — no silent choice.
- **Zero-cost Product parts (577).** The report under-states Finished Goods by whatever those parts are worth. Surfaced as a sheet and a count; fixing `partcost` is Fishbowl-side work. Worth a Fishbowl cost-entry pass before Oct 31.
- **`partcost.avgCost` moves intra-month** (Fishbowl recomputes on receipt). The snapshot freezes the 02:10 nightly value on the 1st; the opening used a Sept 2 extract — the first delta absorbs that gap. State it in the Oct narrative.
- **DST / clock.** Month-end detection runs in America/New_York inside the RPC; the bridge's nightly slot is local-clock driven already, so the 1st-of-month snapshot follows the 02:10 mirror regardless of UTC offset.
- **Bridge down on the 1st.** The catch-up path takes the snapshot when the bridge returns and records the late `taken_at`; the report shows it. "Snapshot now" is the manual backstop.
- **TEST bridge is off most days** (heartbeat Sept 28). Batch B review will show stale chips unless the PC bridge is running against TEST during the review.
- **Spec consolidation debt** (D-PRICE-37…64, D-AISCHED, D-SCHED-22…30) is still queued; v4.9 adds S13 only.

---

## 12. Spec & Documentation Updates

- Spec v4.9 — §5.38 new, §5.27 bridge note, §10.13 schema, Document History.
- Decisions.md — appended by CC inside each prompt; sprint close entry.
- `SkyNet_Claude_Cheatsheet` — v6 with the month-end runbook.
- README (bridge) — 1.8.0 section.
- `Docs/migrations/` — the three S13 SQL files under their delivered names.

---

## 13. Definition of Done

- Bridge 1.8.0 on skyserver; `fb_part_valuation` fresh nightly on PROD; every Product-class part in `fb_part_inventory`.
- Fishbowl Inventory group live on PROD for the roles in Decision 5; 55 reorder rules seeded; SK2600CGP174's alert delivered and visible.
- A month-end snapshot can be taken, opened, exported and marked posted on PROD; the Oct 31 snapshot is scheduled to land automatically.
- Spec v4.9, Decisions and cheatsheet delivered; three migrations filed; branches merged, main == test.
