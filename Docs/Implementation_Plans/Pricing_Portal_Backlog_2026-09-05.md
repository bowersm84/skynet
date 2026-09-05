# Pricing Portal — backlog after S11 (as of 2026-09-05, PROD live)

Priority: **P1** = needed before/around Oct 1 or unblocks daily use · **P2** = next sprint · **P3** = later.

## A. Fishbowl integration (Phase F)
| P | Item | Notes |
|---|---|---|
| P1 | **Price write-back to Fishbowl** (D-PRICE-24) | Outbound command queue polled by the bridge → `POST /api/import/Products` (list price) and `/api/import/Product-Pricing-Rules`. Replaces the manual Products CSV. Needed for Oct 1 if you don't want to import the CSV by hand. |
| P1 | **Retire the 150 qty-triggered "tier" rules in Fishbowl** | Today Fishbowl still gives Tier 1/2/3 prices to anyone at 500/1,000/5,000. Replace with account groups Tier 1 / Tier 2 / Tier 3 / Premier + membership from `customer_pricing`, rules per group; deactivate the qty rules. |
| P2 | Parity check | Nightly `GET /api/products/:id/best-price` sample vs `pricing_get_price` for a customer set; report drift. |
| P2 | Won quote → Fishbowl SO/Estimate | Bridge write-back of a quote as an SO (or Estimate) so the 14-day lock is enforced by the order, not by the rep retyping prices. |
| P3 | History poll cadence | Optional hourly interval (`HISTORY_POLL_SEC`) instead of nightly, if statistics need to be fresher. |
| P3 | Bridge alerting | Portal banner turns amber / email if a nightly clock is >26 h old or the tail stalls. |

## B. Documents & communication
| P | Item | Notes |
|---|---|---|
| P1 | **Email send from SkyNet** (option b) | `send-price-list` / `send-quote` edge function via SES: from `pricing@skybolt.com` (identity to verify), reply-to the rep, PDF attached, `sent_at` / `sent_to` stamped. Today reps attach the PDF themselves. |
| P2 | Quote header edits after save; per-line notes / lead times | Currently a saved quote is immutable except status; changes = reopen → new number. |
| P2 | Price list "what changed since your last list" | Diff against the customer's previous issued PL; print a change column. |
| P2 | Full-catalog / section-based price lists | RPC supports `mode = 'all'`; UI only offers purchased parts + add. |
| P3 | Pictures on PDFs; Excel price list with quantity breaks; print view of a Catalog section | |
| P3 | Quote → price list conversion; duplicate quote to another customer | |

## C. Portal features
| P | Item | Notes |
|---|---|---|
| P1 | **Tier confirmation workflow** | 108 seeded tiers carry "confirm"; 259 "Mixed — review" customers have no tier (Irwin, $1.06M on one part, is one). A review queue: candidates, paid-price evidence, one-click confirm/reject; bulk import of customer-part specials for negotiated accounts. |
| P2 | Ladder editor | Ladder columns are data (D-PRICE-08) but SQL-only; add create/edit UI (column labels, qty mins, tier columns). |
| P2 | Price Books housekeeping | Delete/archive drafts, edit book notes and `premier_pct`, rename/reorder sections, drag-reorder items, change section kind, kit component editor (qty, add/remove). |
| P2 | Specials governance | Reps create specials via price lists (D-PRICE-29): audit view by creator, expiry dates, admin review; alert when a special drifts far from the book. |
| P2 | Customer linkage | Only 1,065 SkyNet `customers` rows auto-linked to `fb_customers`; link the rest / create SkyNet customers from Fishbowl on CO creation. |
| P3 | Costing hook | Cost / margin per quote line from the costing model (D-COST); price realization (paid vs book) report; quote win/loss stats. |
| P3 | Uncle Bob for pricing | "Which tier does this customer look like?", "what did we quote last time", anomaly flags. |
| P3 | Responsive / mobile pass; DFAR filter; catalog export to XLSX | |
| P3 | Engine regression guard | Nightly job comparing the client mirror (`columnPrice`) with `pricing_item_prices()` over the active book; alert on any mismatch. |

## D. Data hygiene (mostly Matt / Fishbowl side)
| P | Item | Notes |
|---|---|---|
| P1 | 120 resale items with **no price** and the 115 Fishbowl list-price mismatches | Products import from Rev 81 (interim) or Phase F. |
| P1 | **Fishbowl customer rename** (parked runbook) → then `2026-09-24_customers_name_sweep.sql` | 459 names; 18 collision pairs to merge; 7 tag-vs-salesman conflicts to decide. |
| P2 | Block 9 (any SO ever) for the 13,979 inactivated customers | Reactivate from the rollback files if any had an open order or estimate. |
| P2 | 6,189 never-sold Fishbowl products | Inactivate in Fishbowl (list delivered: *Never sold — remove*). |
| P2 | 100 guide parts with no Fishbowl product; 1,392 guide parts never sold | Create the products or drop the rows; prune in Rev 83. |
| P3 | Picture coverage | Only 149 parts have a picture; admin upload exists — a session with the catalog photographer. |

## E. Documentation / close-out
| P | Item | Notes |
|---|---|---|
| P1 | Spec v4.6 (§5.28 Pricing Portal, roles, schema, D-PRICE index), `S11_Implementation_Plan_CLOSED.md` | Claude, on a fresh `src.zip`. |
| P2 | User guide for sales (one page: quote, price list, tiers, Oct 1) | |
| P2 | Node port of the Rev 81 loader (Python today) | Only if a full re-seed is ever needed; the seed SQL is the artifact of record. |
