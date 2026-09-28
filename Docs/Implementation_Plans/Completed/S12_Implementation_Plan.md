# SkyNet MES — Sprint 12 Implementation Plan

**Sprint 12 — Fishbowl Pricing Link (Phase F, D-PRICE-24 → D-PRICE-53)**

Implementation Plan v1.0 · September 25, 2026

**Owner:** Matt Bowers
**Hard date:** Rev 82 activates 2026-10-01 (scheduled book `95b56bae…`). Batch A must be on PROD, bridge 1.7.0 running with `FB_PUSH_ENABLED=true`, and the Rev 81 prices push done, before the night of Sept 30.

---

## 1. Sprint Goal

Retire the manual "download Products CSV → Fishbowl Data Import" step. SkyNet becomes the source of truth for Fishbowl's product prices, pricing rules, the `Product:SkyNet:*` product tree and the SkyNet customer groups. The bridge carries every change to Fishbowl through one queue; the portal shows a confirmation that says, in one line, whether Fishbowl equals the book in effect today; the Oct 1 flip publishes itself.

Matt's answers (2026-09-25) locked into this plan: rounding = whatever SkyNet does (round to nearest 0.01, ± 0); rules for sets and kits = yes (Fixed price rules); the 150 legacy rules = retire; the exports supplied = used as the baseline (§3.4).

---

## 2. Findings (PROD, read-only, 2026-09-25)

### 2.1 Prices — Rev 81 (in effect) vs Fishbowl
`2026-09-25_DIAG_fb_price_alignment_READONLY.sql`, non-resale rows incl. the 16 Common Sets:

| | count |
|---|---|
| Book rows priced (non-resale) | 3,224 |
| Known to Fishbowl | 3,127 |
| Equal at 2 dp | 2,607 |
| **Differ** | **520** |
| Not in Fishbowl | 97 |

The 520 by cause: **152 Fishbowl $0.00** (ZG Skytanium series, SK203A…, SK4002-29/30HS); **157 Fishbowl = book ÷ 1.30** (SK4003, SK4002R/ZG4002R Ringed, SK4001SFW, SK4002SFW — a whole uplift never landed); **104 Fishbowl = book ÷ 1.25** (SK2800S, SK28S3TS, SK25S51, ALoc, ZG2600B/R/RB, ZG25T3); **74 penny** (the D-PRICE-22 export used `toFixed(2)`: 48.355 → 48.35, the book rounds to 48.36); **13 other lower** (the 16 sets are ~25 % under book, e.g. SK2600FW-SET1 $14.70 vs $18.37); **20 Fishbowl HIGHER**.

**Q1 — "what is the difference?"** The 20 higher rows are the SK4002-xHS Sealed Series (SpaceX) and SK-P3-1125. Fishbowl carries every HS part at **Rev 81 × 1.385** (SK4002-10HS $50.82 vs book $36.71; -2HS $38.50 vs $27.81; -16HS $61.50 vs $44.42) — a 38.5 % uplift someone applied in Fishbowl that never reached the guide. Rev 82 (× 1.15) still lands below it ($42.21). SK-P3-1125 is $40.84 vs $38.89 (5 %). **No SO line for any HS part or SK-P3-1125 since Jan 2025**, so this is a policy call with no revenue behind it. **Decision (Matt, 2026-09-25): SkyNet aligns to Fishbowl.** `2026-09-25_D-PRICE-53_align_book_to_fishbowl_higher.sql` sets the 20 Rev 81 rows to Fishbowl's current price and Rev 82 to that × 1.15 (uniform Oct 1 uplift; edit one expression if Rev 82 should instead stay at Fishbowl's current price). SK4002-29HS/-30HS are $0 in Fishbowl and keep the book price. Every other drift class (÷1.30, ÷1.25, $0, penny, sets) goes SkyNet → Fishbowl in the push.

Resale (Fishbowl-owned, D-PRICE-13): 1,039 rows, 3 differ (SK244-461, SK245A36, SK245C36 at $0 in Fishbowl). Resale rows are pushed only with `include_resale`.

The 97 not in Fishbowl: **10 asterisk rows** (`SK2018-A2*…F65*`, `SK2018C*` — guide footnote spelling; Fishbowl has the plain numbers, and the book ALSO has plain Resale twins for 10 of the 11 — see §6.3, they would miss the Oct 1 increase); **11 renamed "(Discontinued)"** in Fishbowl (99833-P098, 82-14-080-20, …); **76 no product at all** (SK-FL68 bonded nutplates, SKN-…ACR/PCR, SKFA65-…SS, SK35C45/46, QL4S-EXT…). The last two groups are reported by the sync status, never pushed.

### 2.2 Rules — Fishbowl's 150 active rules vs the SkyNet model
All 150 are quantity-triggered Percent rules on Matt's June tree (`Product:SkyNet:Rule A:100/300/500/500/1000/5000` …): percentages match rules A–J, L, M; tiers are qty triggers at 500 / 1,000 / 5,000, so **any customer at 500+ pays the Tier 1 percentage (64 %) where SkyNet says 83 %**; no tier account groups exist (SkyNet: 109 tiered customers — 63 T1, 17 T2, 27 T3, 2 Premier); `Rule E | T1` is filed under the Rule D node; K/N/P rule sets still exist (SkyNet mapped K→D, N→C, P→A); L/M tier-3 percents are truncated (35/47/46 vs .352/.472/.464); every rule rounds "up to nearest 0.01 + $0.01". Fishbowl applies the lowest valid price among same-type rules, which is how the 500+ overlap resolves today. **Decision: retire all 150** (deactivate, not delete — history stays).

### 2.3 Kits and sets
Rev 82: 334 component sums, all on the `q100_q300_q500` ladder; 317 resolve Each, only 117 resolve q100/q300/q500 in the grid; **316 of 334 have mixed-rule components** (Common Sets = A + J; kits = A/B/C/J + `none`-ladder hardware), so no percent rule reproduces a set price → **Fixed price rules per set/kit** (§5). Engine inconsistency found: `pricing_get_price` (the authority) prices a kit for a tier customer and prices `none`-ladder hardware at Each inside a q100 sum (AC500-C1 at qty 100 = $3,131.19), while `pricing_item_prices` (grid/export) returns no q100 for the same kit. The push follows the RPC; reconciling the grid is a small follow-on (§10).

### 2.4 Fishbowl capabilities confirmed
`POST /api/import/:name` (name = import name with dashes) takes the same CSV as the Data Import module, as JSON array-of-arrays, with the bridge's existing session token. Imports used: **Product** (ProductNumber + Price; whole file or nothing), **Pricing-Rules** (25 columns, create/update by name, 30-char names), **Product-Tree-Categories** (Name ≤ 30, Description, Path), **Product-Tree** (ProductNumber, Path; only adds), **Customer-Group-Relations** (CustomerName, CustomerGroupName; confirmed by Matt's export). Precedence: Customer > Customer Group > All; lower tree node beats higher; among same-type rules the lowest price wins.

---

## 3. Where We Are at Sprint 12 Open

### 3.1 Code state
Bridge 1.6.0 on skyserver (D-FB-40 inventory scope) reading Fishbowl only. Portal v4.7 exports the D-PRICE-22 Products CSV. Rev 81 active since 2026-05-26; Rev 82 scheduled 2026-10-01 (D-PRICE-52 mirror verified); nightly kits push (D-PRICE-49) live since 09-23.

### 3.2 Delivered this round (2026-09-25)
- `Docs/migrations/2026-09-25_D-PRICE-53_fb_pricing_link_schema.sql` — Batch A schema (§6), run end to end in a scratch Postgres 16 on a 223-item PROD slice covering all 38 (rule, ladder) combos. **Applied on TEST 2026-09-25** (Matt, psql; verify row = §6). Same day, on TEST (Claude, under the revised org rule): the two one-shots below, then the file's final revision — import-format helpers `_fb_pct`/`_fb_money` in `fb_push_enqueue`, the first-push guard in `fb_push_auto`, and the kit-pricing / sync-status rewrite for the 8 s API timeout (§10). The file in `Docs/migrations/` must be the final revision (17 functions).
- `2026-09-25_D-PRICE-53_Bridge_1.7.0_CC_Prompt.md` — Batch A bridge (§7), anchors verified against the 1.6.0 source, `node --check` + 5 unit tests green on the applied copy.
- `2026-09-25_DIAG_fb_price_alignment_READONLY.sql` — the pre-migration pass/fail (§2.1).
- `2026-09-25_D-PRICE-53_asterisk_tooling_dedupe.sql` — one-shot, dry run by default (§6.3).
- `2026-09-25_D-PRICE-53_align_book_to_fishbowl_higher.sql` — one-shot, dry run by default (§2.1); preview must show 20 rows on PROD (the scratch slice had its Fishbowl prices overwritten, so it showed 0 there — mechanics verified only).

### 3.3 Not delivered yet
Batch B (portal panel), Batch C (rules cutover runbook execution). One batch per round per the cheatsheet.

### 3.4 Baseline exports (Matt, 2026-09-25)
`ProductTreeCategories_092526.csv` (430 categories, 66 under `Product:SkyNet`), `CustomerGroupRelations_092526.csv` (groups: 20% Kits 2,206 · FBO Pricing 6 · Priority Pricing 5 · 30% Kits 1 · Boeing Test 1 — none are tiers), `Customers_092526.csv`, `Product_092526.csv`, `PricingRules.csv` (7,606 rows, 150 active). **Q2:** `ProductTree_092526.csv` (8,228 rows) supplied: 3,193 rows / 3,118 products under `Product:SkyNet` nodes, no product under two SkyNet rules; by rule letter Fishbowl vs Rev 81 differs only slightly (A +21, B −27, D +4, E +3, C −1, G +1; 7 products under the retired K/N/P nodes). Confirms the plan: the fresh `Product:SkyNet:<rule>:<ladder>` branch is populated from the book, so membership becomes exact and the June nodes go inert. Per-product drift is `v_fb_tree_drift` once the bridge mirrors `producttotree`. **Q3:** the group relations import is confirmed; the 7 SkyNet groups must exist in Fishbowl before the first groups push (§9 step 4).

---

## 4. Sprint Scope

### 4.1 In scope
- Batch A: schema + bridge 1.7.0 (mirrors, queue, push executor, nightly auto).
- Batch B: portal — Price Books › **Fishbowl sync** panel (status card from `pricing_fb_sync_status`, four push buttons with dry-run toggle and options, command history, drift drill-downs from the four views).
- Batch C: rules cutover on PROD — groups created, tree pushed, rules pushed with `retire_legacy`, Estimate-SO verification, CS briefing.
- Data fixes: asterisk tooling dedupe; the 11 "(Discontinued)" renames are Fishbowl-side (rename back or accept the gap).

### 4.2 Out of scope
- Pulling Fishbowl edits back into the book (Fishbowl is not a source; drift is reported and re-pushed).
- Removing customers from groups automatically (the relations import only adds; `v_fb_group_drift` lists what to remove by hand).
- Deleting Matt's June tree nodes (inert once their rules are inactive; delete in the client when convenient).
- Per-customer kit exceptions inside kit sums (an exception on a component does not reach the kit's Fixed rule — none exist today).

---

## 5. Decisions Locked (D-PRICE-53)

### 5.1 Source of truth and rounding
SkyNet's book in effect is the truth for product prices (non-resale), rules, the SkyNet tree and the SkyNet groups. Prices are rounded server-side, `round(x, 2)` (nearest, half up), and every rule is "Round to nearest 0.01 ± 0" — identical to the engine's `unit_price_2dp`.

### 5.2 Rule model (all names `SN …`, ≤ 30 chars, unique — asserted by the generator)
| SkyNet concept | Fishbowl rule | Name | Rev 81 count |
|---|---|---|---|
| Quantity break | All customers · Percent · Product Tree `Product:SkyNet:<rule>:<ladder>` · qty min..next-1 (last open) | `SN A std Q100` | 88 |
| Tier 1/2/3 | Customer Group `SkyNet Tier n` · Percent · same node · no qty; missing tier column falls back tier3→tier2→tier1 like the RPC | `SN A std T3` | 72 (+ 4 groups × 18 ladders) |
| Premier | group `SkyNet Premier` gets the Tier 3 rule on every node (`… PR`) plus tier3 × premier_pct on child node `…:Premier` (has_premier items live there) | `SN A std PREM` | 5 |
| Column tiers | groups `SkyNet Column 100/300/500` · Percent = that column, or 100 % (Each) where the ladder lacks it | `SN A 5 C100` | 114 |
| Sets / kits | **Fixed price on the product**: All-customer qty bands from the kit ladder (only where the band differs from Each); one rule per group (`T1 T2 T3 PR C100 C300 C500`), banded only when the price depends on quantity; priced as Σ component × `_fb_price_at` (= `pricing_get_price` semantics, hardware at Each) | `SN K SK2600FW-SET1 T3` | ~160 (16 sets); Rev 82 ~3,170 (317 kits) |
| Exceptions | Customer × Product: pct_of_tier3 → Percent = tier3 × value × 100; fixed → Fixed price | `SN X 552 SK40R17-1` | 9 |

Verified against the engine on the slice: SK2600FW-SET1 each 18.37 / Q100 17.64 / Q300 16.54 / Q500 15.25 / T3 10.97 / T1 11.76 / PR 10.97; AC500-C1 (Rev 82) Q100 3,131.19 / Q500 2,714.52 / T3 1,946.87 (quantity-free); `SN X 552 SK40R17-1` = 32.9808 % → $2.523 = `pricing_get_price`.

### 5.3 Legacy retirement
`retire_legacy` re-sends every active Fishbowl rule not named `SN …` with `isActive FALSE` (Pricing-Rules import updates by name). Nothing is deleted. `fb_push_auto` passes `retire_legacy: true` on the book-change push so Oct 1 does not resurrect anything.

### 5.4 Product tree
A fresh branch `Product:SkyNet:<rule_code>:<ladder_code>` (+ `:Premier` child), created by the categories import, populated by the Product-Tree import from the book's catalog items (3,111 rows on Rev 81; 57 categories). Matt's June nodes are left alone: with their rules inactive they price nothing. A product can sit under several nodes, so adding to the new branch never removes it from the old.

### 5.5 Customer groups
`fb_group_map`: tier1/2/3 → `SkyNet Tier 1/2/3`, premier → `SkyNet Premier`, q100/q300/q500 → `SkyNet Column 100/300/500`. Expected membership = `customer_pricing` as of the date × `fb_customers.name` (Fishbowl's name, incl. the `/ AB` rep tag). Groups must pre-exist in Fishbowl (§9). A tier change adds the new group; the old membership shows as `extra_in_fb` until removed by hand.

### 5.6 Push semantics
- Payload built by `fb_push_enqueue` **at enqueue time** from the expected-set functions and stored on the command (auditable). `only_changed` (default true) diffs against the mirror; `only_products` for smoke tests; `include_resale`; `retire_legacy`; `dry_run`.
- One command runs at a time; a crashed bridge is failed after 30 min; Fishbowl applies a file whole or not at all, so a failed push changes nothing.
- A push is real only when `FB_PUSH_ENABLED=true` AND the bridge's SkyNet host is `FB_PUSH_SB_HOST` (PROD). Everything else is a forced dry run recorded as `result.dry_run=true`, which the nightly trigger ignores. The PC bridge on TEST therefore exercises the whole path and can never write to Fishbowl.
- After a real push the bridge re-mirrors what it touched (products / rules / tree / customers) so the confirmation is true within the cycle.

### 5.7 Automation
Nightly, after the products poll (02:10): `fb_push_auto()` queues a `prices` and a `rules` push when the book in effect is not the book of the last real push of that kind — and **never makes the first push of a kind**: the first prices push and the rules cutover are always queued by hand, so deploying 1.7.0 to PROD with `FB_PUSH_ENABLED=true` cannot trigger either at 02:10. If Batch C is not done by Oct 1, only prices auto-push. Drift on an unchanged book is reported by the status, never auto-pushed (a hand edit in Fishbowl is a question, not something to silently overwrite). Matt pushes from the portal when he wants it gone.

### 5.8 Confirmation
`pricing_fb_sync_status(as_of)` → one jsonb: book in effect, mirror ages, products {expected, in_sync, mismatched, fb_zero, not_in_fishbowl, resale_drift, kits_unresolved, sample}, rules {loaded, expected, by_kind, in_sync, mismatched, missing, inactive_in_fb, legacy_active, extra_sn_active}, tree {…}, groups {…}, queue, last_push per kind, and **`in_sync`** — true only when every population is clean. Detail: `v_fb_price_drift`, `v_fb_rule_drift`, `v_fb_tree_drift`, `v_fb_group_drift`.

---

## 6. Schema Migration (Batch A SQL)

`2026-09-25_D-PRICE-53_fb_pricing_link_schema.sql` — 8 independently runnable blocks, no temp tables, no select-into, pure-ASCII comments; ~71 KB, so **psql is the cleaner route** (`psql $env:TEST_DB_URL -f …`), the Editor works block by block.

| Block | Creates |
|---|---|
| 1 | `fb_pricing_rules`, `fb_product_tree_nodes`, `fb_product_tree` (mirrors), `fb_group_map` (7 rows), `fb_sync_state.last_rules_at / last_tree_at / last_push_at / last_push_kind`; RLS SELECT-to-authenticated, anon revoked |
| 2 | `fb_push_commands` + `fb_push_next(host)`, `fb_push_finish(id, ok, result, error)`, `fb_push_cancel(id)` |
| 3 | `fb_upsert_pricing_rules(jsonb)`, `fb_upsert_product_tree(nodes, members)` — full snapshots, absent rows marked removed |
| 4 | `_fb_ladder_abbrev`, `_fb_price_at(book, item, tier, qty)` — one item at one group/qty, RPC semantics minus exceptions |
| 5 | `pricing_fb_expected_products(book, include_resale)`, `_tree`, `_categories`, `_groups(as_of)`, `_rules(book, as_of)` |
| 6 | the four drift views, `pricing_fb_sync_status(as_of)`, `fb_push_enqueue(kind, book, options, dry_run, note, as_of)`, `fb_push_auto(as_of)` |
| 7 | grants: PUBLIC/anon revoked on all 15 functions; views SELECT to authenticated only (D-RLS-VIEWS01) |
| 8 | verify — expected on PROD today: tables 5 · functions 17 · views 4 · group_map 7 · anon_grants 0 · expected_products 3,127 · expected_tree_rows 3,111 · expected_rules ≈ 448 · expected_categories 57 · expected_groups 109 · `sync.in_sync` false until the mirrors load |

### 6.1 Critical column names (do not guess)
`price_items.part_key` / `fb_products.product_key` (generated, upper, no whitespace); `fb_customers.name` (raw Fishbowl name) vs `name_clean`; `customer_pricing.tier` ∈ none/tier1/tier2/tier3/premier/q100/q300/q500; `price_exceptions.mode` ∈ pct_of_tier3/fixed; `fb_push_commands.payload` = `[[header],[row],…]` (kind `tree`: `{categories:[…], members:[…]}`).

### 6.2 Gates
Bridge RPCs: `_fb_gate(integration, admin)` / `_pricing_gate(integration, admin)`. `fb_push_enqueue`: admin or integration. `fb_push_cancel`: `_pricing_edit_roles()`. `pricing_fb_sync_status`: `_pricing_view_roles()`. All pass a NULL uid (SQL Editor).

### 6.3 Data fix — asterisk tooling (`2026-09-25_D-PRICE-53_asterisk_tooling_dedupe.sql`)
Both books: delete the 10 Resale twins, strip `*` from the 11 catalog rows (`SK2018-A2…F65`, `SK2018C`). Knock-on: those 11 tools take the Oct 1 +15 % in Fishbowl, as the guide intends; today they would silently stay flat. Dry run (ROLLBACK) first; the two previews say 22 / 20 before, 0 / 0 / 22 / 22 after.

---

## 7. Code Changes — Bridge 1.7.0 (Batch A CC prompt)

| File | Change |
|---|---|
| `src/fishbowl.mjs` | `importRows(name, rows)` — the one write path (`POST /api/import/<name>`, JSON array-of-arrays, `FB_IMPORT_TIMEOUT_MS`, 401 re-login once); per-call timeout in `_call` |
| `src/rulesTree.mjs` (new) | `syncProductTree` (paths built in JS from `producttree.parentId`; membership from `producttotree ⋈ product`), `syncPricingRules` (type ids resolved to names; tree rules → path, product rules → number, group rules → `accountgroup.name`), `buildPaths`, `mapRule` |
| `src/push.mjs` (new) | `runPushCommands` (claim → post → finish → re-mirror), `canPushFor` (flag + host gate), `importsFor` (tree = categories then members) |
| `src/queries.mjs` | `productTreeNodes`, `productTreeMembers`, `pricingRules` — **discovery first** via `scripts/fb-columns.mjs` (new; `information_schema` read of the 8 tables); fix names in queries.mjs only |
| `src/skynet.mjs` | `upsertPricingRules`, `upsertProductTree`, `pushNext`, `pushFinish`, `pushAuto`; `pricingState` reads the two new clocks |
| `src/config.mjs` | 1.7.0; `push.{enabled, allowedSbHost, autoEnabled, maxPerCycle}`, `fb.importTimeoutMs`, `rulesTreeEnabled`, `importNames.*` |
| `src/index.mjs` | nightly slot: tree + rules mirrors then `fb_push_auto` (each logged-and-swallowed); every cycle: `pushCycleGuarded()` after the pricing pollers; `--mirror-rules`; start-up line states the push gate |
| tests | `src/rulesTree.test.mjs` (3), `src/push.test.mjs` (2) — `node --test src/rulesTree.test.mjs src/push.test.mjs` |
| docs | `.env.example`, `README.md` (Fishbowl pricing link section + ops note), `package.json` 1.7.0 + `mirror:rules` / `fb:columns` scripts, Decisions.md append |

**Unverified Fishbowl names (discovery step 0 of the prompt):** `producttree(id, name, parentId)`, `producttotree(productId, productTreeId)`, `pricingrule.*Id` columns, `isTier2`, the five type tables' `name`. `accountgroup` = Fishbowl's customer group (already read by the customers poller).

---

## 8. Claude Code Prompt Batches

### 8.1 Batch A — Schema + bridge 1.7.0 (this round)
1. Matt: apply the migration on TEST (psql), run Block 8, paste the verify row.
2. CC: `2026-09-25_D-PRICE-53_Bridge_1.7.0_CC_Prompt.md` (discovery → edits → tests → `npm run mirror:rules` against TEST → dry-run push → STOP, D-PROC-01).
3. Matt: Dev review; `select pricing_fb_sync_status();` on TEST shows `rules.loaded true`, `legacy_active 150`, `tree.loaded true`.
4. Quick test (§9 A).

### 8.2 Batch B — Portal: Price Books › Fishbowl sync (next round)
`src/pages/pricing/PriceBooksPage.jsx` gains a panel: status card (`in_sync` pill, per-population counts, mirror ages, last push per kind), buttons **Push prices / Push rules / Push tree / Push groups** (admin; dry-run checkbox; options: include resale, retire legacy, only changed), **Cancel** on queued commands, a history table over `fb_push_commands` (kind, rows, status, requested by, finished, error, dry run) and drill-down tables over the four drift views (part numbers on every row). Read via `supabase.rpc('pricing_fb_sync_status')` / `.rpc('fb_push_enqueue', …)` / `.rpc('fb_push_cancel', …)`; poll every 20 s while a command is queued/running. No new RPCs.

### 8.3 Batch C — Rules cutover on PROD (runbook, §9 C)
No code. Groups created by hand, `tree` push, `groups` push, `rules` push with `retire_legacy`, Estimate-SO checks, CS briefing, `in_sync` true.

### 8.4 Batch D — Engine follow-on (after Oct 1)
Make `pricing_item_prices` price a `none`-ladder component at Each inside a kit's qty columns (the RPC already does); re-verify D-PRICE-52's kit columns; Catalog grid then shows q100/q300/q500 for 317 kits, not 117.

---

## 9. Test Checklist

**A — Batch A on TEST (PC bridge, forced dry run)**
- [ ] Block 8 verify row matches §6 (TEST has its own counts; `anon_grants 0`, `group_map 7` must hold).
- [ ] `npm run mirror:rules` → `fb_pricing_rules` 7,606 rows (150 active), `fb_product_tree_nodes` ≈ 430, `fb_product_tree` > 0; `pricing_fb_sync_status().rules.legacy_active = 150`.
- [ ] `select fb_push_enqueue('prices', null, '{"only_changed": false, "only_products": ["SK2600-1"]}', true, 'dry');` → bridge logs `DRY RUN … first ["SK2600-1","5.28"]`, command `done`, `result.dry_run true`.
- [ ] `select fb_push_enqueue('rules', null, '{"retire_legacy": true}', true, 'dry');` → row_count ≈ expected_rules + 150; all `SN …` names ≤ 30; command done.
- [x] `fb_push_auto` guard (Claude, TEST, rolled back): no history → nothing; only forced-dry history → nothing; real push of the book in effect → nothing; real push of another book → prices (503 rows) + rules (448, retire_legacy) queued.
- [ ] `v_fb_price_drift` lists SK4002-10HS (fb 50.82 / book 36.71) and a `fb_zero` row; `v_fb_rule_drift` shows 150 `legacy_active`.
- [ ] Duplicate enqueue of a queued kind raises; `fb_push_cancel` on a queued id works, on a done id raises.

**A — result, 2026-09-25 (PC bridge 1.7.0 `fd178a5` on TEST, `FB_PUSH_ENABLED=true` to exercise the host lock): PASS.**
First cycle 12 s: products 10,982 · tree 430 nodes / 8,228 memberships (3,193 under `Product:SkyNet`, 1,548 in the Rule A standard node = the 09-25 export) · rules 7,606 (150 active; types Fixed price 6,989 / Percent 602 / Amount 11 / Markdown 4 = the export; 0 unresolved tree or customer references; `Rule E | T1` still on the Rule D node) · no `push auto:` line. Commands: #14 prices (1), #15 tree (57 + 3,121), #16 groups (109), #17 rules cutover (598 = 448 SkyNet + 150 retirements; retire rows identical to the export but `isActive false`) all dry, nothing sent; #18 prices marked REAL → forced dry with reason `SkyNet host ylzmyjjqibpbqbwjsnqj.supabase.co is not luzungoqfuplspzbqctb.supabase.co`; `fb_push_auto` still queues nothing. Status: `rules.loaded`, `legacy_active 150`, `missing 448`; `tree.loaded`, `missing 3,121`, `categories_missing 56` (`Product:SkyNet` already exists). Fix found and applied on TEST: dry runs (incl. forced) no longer stamp `last_push_at` or appear as `last_push` in the status. Remaining: restart check (clocks persist, nightly slot does not re-run), then remove `FB_PUSH_ENABLED` from the PC `.env`.

**B — Batch A on PROD (skyserver bridge, real)**
- [ ] Migration applied (psql), Block 8 = §6 numbers.
- [ ] `.env` on skyserver: `FB_PUSH_ENABLED=true` (SB_URL already PROD). Deploy 1.7.0, `nssm restart`, start-up line says `fishbowl push: ENABLED`.
- [ ] `npm run mirror:rules` once (or wait for 02:10). `pricing_fb_sync_status()` → `rules.loaded`, `tree.loaded`.
- [ ] Fishbowl rights: the `skynet-bridge` login was set up read-only (FB1). Give its user group the Data-module import rights for Product, Pricing Rules, Product Tree Categories, Product Tree and Customer Group Relations. Without them the smoke push fails cleanly (command `failed`, Fishbowl's message in `error`, nothing changes).
- [ ] Smoke: `fb_push_enqueue('prices', null, '{"only_changed": false, "only_products": ["SK2600-1"]}', false, 'smoke')` — a product whose price already matches; command `done`, Fishbowl status 200, nothing visibly changes.
- [ ] **Rev 81 prices push:** `fb_push_enqueue('prices')` (only_changed) → 520 rows; done; products re-mirrored; `products.mismatched 0`, `fb_zero 0`; DIAG file → `pass` except the 97 `not_in_fb`. Tell CS first (§10 knock-ons).
- [ ] Align-to-Fishbowl one-shot applied FIRST (dry then COMMIT): 20 rows; then the Rev 81 prices push carries 500 rows, not 520.
- [ ] Asterisk dedupe applied (dry then COMMIT); re-run the prices push → 11 more rows.

**C — Rules cutover on PROD (Batch C)**
- [ ] Import-format probe: Data Import › Pricing Rules with `2026-09-25_D-PRICE-53_import_format_probe.csv` (2 inactive rules on SK2600-1). Both open as Percent 58.2 % qty 1000+ and Fixed price $3,131.19 → the payload spelling is right; delete the two rules.
- [ ] Create groups in Fishbowl Customer › Groups: `SkyNet Tier 1`, `SkyNet Tier 2`, `SkyNet Tier 3`, `SkyNet Premier`, `SkyNet Column 100`, `SkyNet Column 300`, `SkyNet Column 500`.
- [ ] `fb_push_enqueue('tree')` → 57 categories + 3,111 memberships; done; `tree.missing 0`.
- [ ] `fb_push_enqueue('groups')` → 109 rows; done; customers re-mirrored; `groups.missing 0`.
- [ ] `fb_push_enqueue('rules', null, '{"retire_legacy": true}')` → ≈ 448 + 150 rows; done; `rules.legacy_active 0`, `missing 0`.
- [ ] Estimate SO (never leaves Fishbowl, D-FB-11), compare with Quote Builder: SK2600-1 × 1 / × 100 / × 500 for a non-tiered customer; the same for a Tier 3 customer (e.g. one of the 27) and for Air Tractor (Premier + exception on SK40R17-1); SK2600FW-SET1 × 1 and × 100; a Column 100 customer if one exists (none today). Every line must equal `pricing_get_price` at 2 dp. This is the precedence check (§10).
- [ ] `pricing_fb_sync_status().in_sync = true`.
- [ ] Oct 1, 02:10–02:30: `fb_push_auto` queued prices + rules for Rev 82; both done; `in_sync` true on Rev 82; kits site synced (D-PRICE-49) the same night.

---

## 10. Risks & Open Items

| Risk | Handling |
|---|---|
| Fishbowl precedence assumptions (Customer > Group > All; lower node beats higher; Product-type rule beats tree rule for kits) | Estimate-SO check before rules go live (§9 C); if a kit Fixed rule loses to a tree rule, kits are removed from the SkyNet tree (they are never members today) |
| `producttree` / `producttotree` / type-table column names unverified on 25.9 | discovery step 0 in the CC prompt; names live in `queries.mjs` only |
| Customer-Group-Relations import: does it create missing groups? does it error on a name already in the group? | groups pre-created by hand; the push runs `only_changed` so existing relations are not re-sent |
| Product-Tree import only adds — a product moved between rule/ladder nodes in a later book keeps the old membership; both nodes' rules stay valid and the lower price wins | `v_fb_tree_drift` shows SkyNet paths per product; remove stale memberships in the client when a rule/ladder change is published (rare; D-PRICE-nn to note per book) |
| Fishbowl caps rule names at 30 chars | asserted by the generator (longest today 26) |
| 3,000+ kit rules on Rev 82 | Fishbowl already holds 7,606; only_changed pushes are small after the first; watch SO line pricing latency on Oct 1 |
| Knock-ons for CS | Rev 81 push: 520 prices move (152 from $0; 20 down incl. the HS series); rule cutover: non-tiered customers lose the 500+/1,000+/5,000+ tier percentages, tiered customers get their tier at any quantity, K/N/P nodes and the misfiled E/D rule stop mattering — brief April and Sawyer before Batch B/C |
| Hand edits in Fishbowl | reported as drift, re-pushed only on demand (or on the next book flip) |
| Engine grid/RPC kit inconsistency (§2.3) | Batch D |
| API statement timeout (`authenticated` = 8 s) | Found on TEST: Rev 82 rule generation took ~10 s, so the Oct 1 auto-push and the portal status would have timed out. Rewritten (kit prices once per distinct component, window functions for bands) with byte-identical output: 1.24 s; Oct 1 auto path 2.25 s; status 1.03 s |
| Fishbowl import duration (Rev 82: 3,419 prices + 3,433 rules) | Batch C's real rules push gives the first timing; raise `FB_IMPORT_TIMEOUT_MS` (300 s) before Oct 1 if needed. A timed-out push is `failed`, re-queued by the next night's auto run with only the rows still different |
| Duplicate Fishbowl products differing by a space (`SK-N114-2S` / `SK-N114 -2S`, -3S, -4S) | Both receive the SkyNet price; clean up in Fishbowl when convenient |
| Anon RLS carry-over | every new object revokes anon; the pre-existing anon EXECUTE on older `fb_upsert_*` RPCs is still the Sept 23 open item |

---

## 11. Spec & Documentation Updates
- Spec v4.8 §Pricing: Phase F delivered (D-PRICE-53): rule model table (§5.2), push semantics, confirmation, automation; Products CSV export stays as a fallback.
- `Docs/Fishbowl_Data_Context.md`: pricingrule / producttree / producttotree / accountgroup notes from discovery; import endpoint.
- README bridge (in the prompt). Cheatsheet: "Claude's tool use against Fishbowl is read-only; the bridge's `importRows` is the only writer, gated by `FB_PUSH_ENABLED` on PROD."

## 12. Definition of Done
Rev 82 in effect on Oct 1 with `pricing_fb_sync_status().in_sync = true`, no manual CSV step, legacy rules inactive, an Estimate SO agreeing with Quote Builder for a non-tiered, a Tier 3 and a Premier customer and a set, and the portal panel showing it.
