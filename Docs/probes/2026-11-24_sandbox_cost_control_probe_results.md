# S17 D2 probe 2 — costs, postings, and a hand-built control

**Run:** November 24, 2026, by Claude Code, for Matt Bowers. **Draft until Matt approves it.**
**Target:** the Fishbowl 26.11 sandbox `SKYFB-TEST` (`http://192.168.1.59:2456`), a copy of the live database taken November 24. Checked before anything else on every run: database version row `Fishbowl v2026.11` (26.11), company `SANDBOX 26.11 - NOT LIVE`. The live Fishbowl and SkyNet (TEST and PROD) were not touched.
**Script:** `tools/fishbowl-bridge/scripts/probe-sandbox-fulfill.mjs`, run as `PROBE_LOG_NAME=probe-sandbox-cost` (new steps `costing`, `add-stock`, `compare`). Run log: `tools/fishbowl-bridge/logs/probe-sandbox-cost.jsonl` (git-ignored, redacted); the full side-by-side read is beside it as `probe-sandbox-cost-compare-1795558219691.json`.
**The two builds:** `SBX-COST-API` was built through the API. `SBX-COST-HAND` was built by Matt in the sandbox client, the way it is done on live today: Quick Fulfill, cancel the first box, then the Finish Work Order screen. Both were for `SKYTEST-STUD-ASSEMBLY`, quantity 4, using lot A of each component.

## Answers

| Question | Answer | Evidence |
|---|---|---|
| What is the company costing method? | **Average Costing.** No `SKYTEST-` part has a standard cost. | Setting `Acct Costing Method` = `Average Costing`. Every `SKYTEST-` part has a standard cost of $0. Every consumption row is charged at the part's average cost at that moment (§2). |
| What unit cost does the finished lot carry, and how is it derived from the components? | **$0.1859 a unit in both builds.** Fishbowl adds up everything the build consumed, at each component's *average* cost, and divides by the good units only. | Work order cost $0.5578 = STUD 4 × $0.0797 ($0.3187) + SPRING 4 × $0.0199 ($0.0797) + CUP 4 × $0.0299 ($0.1195) + PIN 4 × $0.0100 ($0.0398), ÷ 3 good = $0.1859. Finished-lot cost layer: 3 units, $0.5578. **Lot A's own price is not used.** At the entered costs ($3.50 a set) the build would have cost $14.00, or $4.67 a unit. |
| Is the cost of the scrapped unit absorbed into the good units, or posted elsewhere? | **Absorbed into the 3 good units, in both builds.** Nothing is posted elsewhere. | The finished-lot cost layer carries the full $0.5578 over 3 units. There is no scrap inventory row, scrap posting or cost layer for the fourth unit. The hand build recorded no scrap at all and came out the same. |
| Does the API build leave the same postings as the hand build? | **Yes.** | Each build left one work-order posting record (status "For Journal Entry", $0 posted) and one line per item, all $0 posted. Neither left any `post` row. There are no accounts: Fishbowl's accounting link is NONE and every account setting is unset (§1). |
| Does the API build leave the same lot genealogy as the hand build? | **Yes.** | The pick lines finished on lot A, 4 of each. The work order's tracking ties the finished lot (SBX-81001 / SBX-81002) to lot A of each component. The inventory log's pick, consumption and receipt rows carry the same lots. Under the comparison rules below, every one of these sections came back "same". |
| Is there any difference a quality or accounting reviewer would care about? | **One for quality, none for accounting.** The API build records the scrapped unit; the hand build cannot. Its record shows 3 made from 4 sets of parts, with nothing saying why. | Finished-good line on the work order: API used 3, scrapped 1; hand used 3, scrapped 0. The only other difference is the receipt row's cost column ($0.0431 vs $0.0565), which is the finished good's average cost just before each receipt. It differs only because the API build ran first (§3). |

No route is chosen by this probe.

**Same in both builds, and worth Crystalyn and Roger knowing:** under Average Costing a lot's own price does not follow the lot. Lot A came in at $2.00 a stud, but the build was charged the part average of $0.0797. Fishbowl's cost-layer link for the consumption points at the oldest $0 layer of each part, not at lot A's layer. After both builds, lot A's layers still show 20 left at their entered price while lot A holds 12 (§2).

## 1. Postings, for Roger and Crystalyn

**There are no accounts on any of these rows.** On this sandbox the accounting link is switched off (`Acct Type` = `NONE`). Every account setting is unset (−1): inventory asset, cost of goods sold, inventory adjustment, scrapped inventory, cost variance and the rest. The `SKYTEST-` parts have no accounts of their own.

What Fishbowl keeps for a work order is a posting record waiting to become a journal entry (status 70, "For Journal Entry"). While the accounting link is NONE it is never sent, so "posted to accounting" stays $0. The sandbox is a copy of live, so live is probably set up the same way. **Not run:** this probe did not read live Fishbowl's accounting settings.

The "cost on the work order" column is the cost Fishbowl worked out for each line. It is the figure a journal entry would carry if accounting were connected.

### SBX-COST-API (built through the API)

| Row | Item | Quantity | Account | Cost on the work order | Posted to accounting |
|---|---|---|---|---|---|
| Work-order posting | SBX-COST-API:001, status For Journal Entry, not posted | — | none | — | — |
| Line | SKYTEST-STUD-ASSEMBLY (finished good) | 3 good, 1 scrapped | none | $0.5578 | $0.00 |
| Line | SKYTEST-STUD | 4 used | none | $0.3187 | $0.00 |
| Line | SKYTEST-SPRING | 4 used | none | $0.0797 | $0.00 |
| Line | SKYTEST-CUP | 4 used | none | $0.1195 | $0.00 |
| Line | SKYTEST-PIN | 4 used | none | $0.0398 | $0.00 |
| `post` rows | none | — | — | — | — |

### SBX-COST-HAND (built by hand)

| Row | Item | Quantity | Account | Cost on the work order | Posted to accounting |
|---|---|---|---|---|---|
| Work-order posting | SBX-COST-HAND:001, status For Journal Entry, not posted | — | none | — | — |
| Line | SKYTEST-STUD-ASSEMBLY (finished good) | 3 good, 0 scrapped | none | $0.5578 | $0.00 |
| Line | SKYTEST-STUD | 4 used | none | $0.3187 | $0.00 |
| Line | SKYTEST-SPRING | 4 used | none | $0.0797 | $0.00 |
| Line | SKYTEST-CUP | 4 used | none | $0.1195 | $0.00 |
| Line | SKYTEST-PIN | 4 used | none | $0.0398 | $0.00 |
| `post` rows | none | — | — | — | — |

The finished-good line's cost equals the four component lines added together: the good units carry the whole cost of the build.

### The stock added for this probe (T2), for reference

Eight `post` rows of type Adjust, one per lot added, each "Entered" with $0 posted and no account. Amount = 20 × the unit cost entered:

| Part | Unit cost entered | Lot A | Lot B |
|---|---|---|---|
| SKYTEST-STUD | $2.00 | $40.00 | $40.00 |
| SKYTEST-SPRING | $0.50 | $10.00 | $10.00 |
| SKYTEST-CUP | $0.75 | $15.00 | $15.00 |
| SKYTEST-PIN | $0.25 | $5.00 | $5.00 |

## 2. Costing set-up (T1, T2) and what the builds did to it

Part cost (average cost / quantity / total value) at three points:

| Part | Before T2 | After T2 (40 added) | After both builds |
|---|---|---|---|
| SKYTEST-STUD | $0 / 964 / $0 | $0.079681 / 1,004 / $80.00 | $0.079681 / 996 / $79.36 |
| SKYTEST-SPRING | $0 / 964 / $0 | $0.019920 / 1,004 / $20.00 | $0.019920 / 996 / $19.84 |
| SKYTEST-CUP | $0 / 964 / $0 | $0.029880 / 1,004 / $30.00 | $0.029880 / 996 / $29.76 |
| SKYTEST-PIN | $0 / 964 / $0 | $0.009960 / 1,004 / $10.00 | $0.009960 / 996 / $9.92 |
| SKYTEST-STUD-ASSEMBLY | $0.043103 / 29 / $1.25 | unchanged | $0.067587 / 35 / $2.37 |

As the prompt expected, the part cost after T2 is not the cost entered. The 40 new units at $2.00 are averaged with 964 already on hand at $0.

**Cost layers.** Before T2, each component had two $0 layers of 500 (464 and 500 left). T2 added one layer per lot at the entered price (20 at $2.00, $0.50, $0.75, $0.25). After both builds:

- the oldest $0 layer of each component went from 464 to 456 left;
- both lot A layers still show 20 left at the entered price, although lot A now holds 12;
- the finished good gained one layer per build: 3 units, $0.5578.

Fishbowl draws cost layers oldest first, whatever lot is picked, and charges the average cost. Fishbowl kept no cost history for these parts (no `partcosthistory` rows).

**The inventory log's cost column** holds the part's average cost at the moment of the row: the cost before the change, for a receipt. For example, the second STUD add shows $0.0407 (= $40 ÷ 984 after the first add).

## 3. Side by side (T6)

Compared by data query. For each build the queries read:

- the MO and its items;
- the work order and its items;
- the pick lines and their lots;
- the work order's tracking rows;
- every inventory log row tied to its pick lines or work-order items, with the lots on each row;
- which cost layer each of those rows drew on;
- the finished good's cost layer;
- the finished lot's tag;
- the work-order posting and its lines;
- every `post` row written during the build, five seconds either side.

Before comparing, ids, order numbers, timestamps and the user were removed, and the MO, the work order and the finished lot were given the same name in both.

| | SBX-COST-API | SBX-COST-HAND | |
|---|---|---|---|
| MO status | Fulfilled | Fulfilled | same |
| MO items | finished good 3 of 4 fulfilled; each component 4 of 4 | same | same |
| Work order | Fulfilled; 4 ordered; cost $0.5578; header scrap field blank | same | same |
| Finished-good line | used 3, **scrapped 1**, cost $0.5578 | used 3, **scrapped 0**, cost $0.5578 | **differs** |
| Component lines | 4 used, 0 scrapped each; STUD $0.3187, SPRING $0.0797, CUP $0.1195, PIN $0.0398 | same | same |
| Pick lines | 4 lines Finished, 4 each from Stock, lot A | same | same |
| Tracking (genealogy) | finished lot on the finished-good line, quantity 4; lot A of each component, 4 each | same | same |
| Inventory log | 4 pick moves Stock → Production (+4, lot A); 4 consumptions at Production (−4, lot A); 1 receipt into Receiving (+3, finished lot) | same | same, except the receipt's cost column |
| Receipt row cost column | $0.0431 | $0.0565 | **differs** |
| Cost layers drawn by the consumptions | the oldest $0 layer of each component | same | same |
| Finished-lot cost layer | 3 units, $0.5578 ($0.1859 each) | same | same |
| Finished lot | SBX-81001: 3 in Receiving | SBX-81002: 3 in Receiving | same (the lot number is set by the probe) |
| Work-order posting | 1 record, For Journal Entry; 5 lines at $0 posted | same | same |
| `post` rows | none | none | same |

**The differences, and what they mean:**

1. **Scrap on the finished-good line: 1 (API) vs 0 (hand).** Matt reported that the Finish Work Order screen has no scrap field, so the fourth unit could not be entered as scrap. Both builds consumed 4 sets of components, made 3, and put the whole cost into the 3. Only the API record says one unit was scrapped. For a quality reviewer, the API record is the more complete one. For an accounting reviewer, nothing changes: the cost, layers and postings are identical.
2. **The receipt row's cost column: $0.0431 vs $0.0565.** This is the finished good's average cost just before each receipt. The API build ran first and raised the average from $0.0431 ($1.25 over 29) to $0.0565 ($1.81 over 32), so the hand build's receipt saw the higher figure. It comes from the order the builds ran in, not from the route. The cost the finished lot actually carries ($0.5578 over 3) is the same in both.

**Same in both, worth noting:** the work order's tracking row for the finished lot says 4 in both builds, although 3 went into the lot's tag. The user differs (the bridge's Fishbowl user vs Matt); by the comparison rules it is ignored.

**Matt's notes on the hand build:** lot A on all four components. Finished 3 of 4 into Receiving as lot SBX-81002. The fourth unit was not entered as scrap, because the screen has no field for it. "Create new work order with remaining materials" was left unticked, and each MO has exactly one work order.

## 4. The steps

| Step | Call | Result |
|---|---|---|
| T1 costing | data queries (`costing`) | Average Costing; accounting type NONE; every account setting −1; components $0, 964 on hand each, two $0 layers each. |
| T2 add stock | 8 × `POST /api/parts/:id/inventory/add` `{"location":{"id":1},"quantity":"20","uom":{"id":1},"unitCost":"2.00","note":"SBX probe 2 cost control (S17 D2) - sandbox only","trackingItems":[{"partTracking":{"id":1},"value":"SBX-CA-STUD"}]}` (and the other seven) | 200 each; 20 of each lot in Stock; one cost layer per lot at the entered price; one Adjust `post` row each. |
| T3 create + issue | `POST /api/manufacture-orders` + `…/issue`, quantity 4, twice | SBX-COST-API: MO 5794, WO 9306, pick 21598. SBX-COST-HAND: MO 5795, WO 9307, pick 21599. Both Issued. |
| T4 read | `GET /api/work-orders/9306`; `GET /api/picks/21598` (fenced as a write) | WO Entered, five items of 4, no consume items; pick Entered, four lines of 4. |
| T4 start | `POST /api/picks/21598/start` | Started; source Stock; no lot, nothing committed. |
| T4 finish pick lines | `POST /api/legacy/external/GetPickRq`, then `…/SavePickRq` with each line on lot A, status 40 | statusCode 1000; all four lines Finished, each on its lot A tag. |
| T4 fulfill | `POST /api/work-orders/9306/fulfill` `{"finishedGoods":[{"itemId":49020,"quantityUsed":"3","quantityScrapped":"1","destinationLocationId":3,"tracking":{"trackingItems":[{"partTracking":{"id":1},"value":"SBX-81001"}]}}],"splitWorkOrder":false}`, no `rawGoods` | 200 Fulfilled. |
| T5 hand build | Matt, in the sandbox client | Done as in §3. |
| T6 compare | data queries (`compare`) | §3. |

**Not run:**

- Scrap on the hand build: the Finish Work Order screen has no field for it.
- Lot B: added in T2 but not used by either build. It still has 20 of each.
- Live Fishbowl's accounting settings: not read.

## 5. Checks

1. **Target fences:** each refused before any network call:
   - an unset `FB_SANDBOX_URL` ("is not set — refusing to run (there is no default target)");
   - `192.168.1.251`, `skyserver`, `localhost` and `127.0.0.1` ("is the live Fishbowl or this PC — refusing to run").
2. **Parts:** the run log holds 17 writes: 8 inventory adds, 2 creates, 2 issues, 1 pick read, 1 pick start, 1 `GetPickRq`, 1 `SavePickRq` and 1 fulfill. Every one names only `SKYTEST-` parts. Every session's check read 26.11 / `SANDBOX 26.11 - NOT LIVE`.
3. **`rawGoods`:** no row of `probe-sandbox-cost.jsonl` contains it. The script now refuses any fulfill body that carries it. (Probe 1's separate run log does contain it, from probe 1's runs 2 and 3.)
4. **Secrets:** none of the 7 files this probe saved holds the bridge password, a token, a ticket or an `Authorization` value.

## 6. What is left in the sandbox

- SBX-COST-API and SBX-COST-HAND are Fulfilled.
- SBX-81001 (3) and SBX-81002 (3) are in Receiving.
- Lot A has 12 of each component in Stock; lot B has 20 of each.
- Part costs are as in §2.
- Nothing was written to live Fishbowl or SkyNet.
