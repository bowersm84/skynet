# S17 D2 probe — posting a finished build to Fishbowl 26.11 with nobody keying it

**Run:** November 24, 2026, by Claude Code, for Matt Bowers. **Draft until Matt approves it.**
**Target:** the Fishbowl 26.11 sandbox `SKYFB-TEST` (`http://192.168.1.59:2456`), a copy of the live database taken November 24. Checked before anything else on every run: database version row `Fishbowl v2026.11` (26.11), company `SANDBOX 26.11 - NOT LIVE`. The live Fishbowl and SkyNet (TEST and PROD) were not touched.
**Script:** `tools/fishbowl-bridge/scripts/probe-sandbox-fulfill.mjs` (signed in as the bridge's own integrated app, "SkyNet Bridge" 4350, whose approval came across with the copy). Run log: `tools/fishbowl-bridge/logs/probe-sandbox-fulfill.jsonl` (git-ignored, redacted), with the full legacy requests and answers beside it.

## Verdict

| Question | Answer | Evidence |
|---|---|---|
| Can a pick line be finished with a chosen lot, no person involved? | **Yes** — through the REST legacy wrapper, `POST /api/legacy/external/SavePickRq`. No 26.11 REST pick call can do it. | 12 lines on 3 picks finished, each on the lot Fishbowl would not take by default (STUD 100452, SPRING 100746, CUP 100583, PIN 58663): status 40 Finished, source tag = that lot's tag, the line's tracking = that lot. |
| Does fulfill then consume exactly those lots? | **Yes** | Work orders 9303, 9304, 9305 each consumed 2 of every component from the pick items' lots. Over the three runs each chosen lot's tag dropped by 6 (CUP 100583: 500 → 494; STUD 100452: 490 → 484); the default lots (100236, 100512, 100147, 54285) did not move. With `rawGoods` omitted (9303) and with `rawGoods` naming each `pickItemId` (9304), the work order records the same lots as the pick. |
| Does produced 1 + scrapped 1 of 2 consume components for 2 units? | **Yes** | Finished good: used 1, scrapped 1; every raw good used 2; one finished-lot tag of 1 in Receiving; no inventory row for the scrapped unit. |
| Can `rawGoods.tracking` override the pick item's lot? | **Accepted, but it only rewrites the record — never use it.** | Work order 9305 was sent the other lot of each part. Fishbowl answered 200 Fulfilled, took the stock from the pick items' lots (100452 …), and wrote the override lots (100236, 100512, 100147, 54285) onto the work order's consumption record. Fishbowl now holds two different lots for one consumption. |
| Does route B work with chosen lots and a supplied unit cost? | **Yes, mechanically.** The accounting is different from a work order and needs Roger and Crystalyn. | Add 1 `SKYTEST-STUD-ASSEMBLY` lot `SBX-B-0001` at $1.25 → tag 105313 in Receiving, cost layer $1.25. Scrap 1 of each component from a named lot → exactly that lot's tag −1. Postings: five `post` rows of type Adjust (§4). |

No route is chosen by this probe.

## 1. What differs from what was known (T0)

- **The API docs are not served as pages.** `/apidocs` answers 404 to a plain request; it is a route of the Fishbowl web app, whose bundle (`/assets/index-DdtuTQlM.js`) carries the whole documentation ("Fishbowl API Documentation - Version 26.11"). Read from the bundle: work orders (search, get, update, add item, fulfill), picks (search, get, start, item start / hold / unhold), parts inventory (add, cycle, move, scrap). The fulfill and pick text matches §2 of the prompt.
- **`GET /api/picks/:id` can write.** The docs: on a partly available pick it splits a line into an available and a Short quantity "and that split is saved"; a failure while sourcing returns 400. The script fences it as a write.
- **Before the pick is started there are no `consumeItems` at all** on `GET /api/work-orders/:id` (an empty list, not items without `pickItemId`). After the pick is finished every raw good has one consume item carrying `pickItemId` and `pickItemStatus: Finished`.
- **The REST pick start commits nothing.** After `POST /api/picks/:id/start`: pick and lines Started (20), source location Stock, no tag, no lot, `finishable: false`.
- **The finished good has no default destination.** `destLocation` is null on this BOM's finished-good item, so the destination must be sent. Receiving (location 3) was used: 1,549 of the last 120 days' work-order finished goods were received there (Stock 5, Production 3, Assembly 3).
- **The legacy wrapper is `POST /api/legacy/external/<RequestName>`**, not in the REST docs. Any request name answers 405 to GET (the route exists); `/api/legacy`, `/api/legacy/external`, `/api/legacy/json` answer 404. The body is the request element itself — `{"GetPickRq": {"PickNum": "…"}}` — and a body without it is refused inside the answer ("No unmarshaller for element PickNum"). The answer is the legacy envelope: `{"FbiJson": {"Ticket": …, "FbiMsgsRs": {"statusCode": 1000, "GetPickRs": {"statusCode": 1000, "Pick": {…}}}}}`. HTTP is 200 either way; success is `statusCode` 1000 inside.
- **`rawGoods.tracking` is not checked against the pick item** (verdict row 4).

## 2. The steps

| Step | Call | Result |
|---|---|---|
| T1 preflight | data queries | BOM `SKYTEST-STUD-ASSEMBLY` id 2407 (active); parts 11814 (finished good), 11809 STUD, 11812 SPRING, 11811 CUP, 11810 PIN, all Lot Number (part tracking 1). Two lots per component in Main / Stock, 471–500 each; none short. The sandbox also holds `SKYTEST-AB-00016/18/21/22/23` copied from live — not touched. |
| T2 create + issue | `POST /api/manufacture-orders` `{"number":"SBX-PROBE-1","locationGroup":{"id":1},"configurations":[{"bom":{"id":2407},"quantity":"2"}]}` → 200; `POST …/5791/issue` → 200 Issued | MO 5791, work order 9303 `SBX-PROBE-1:001`, pick 21595 `WSBX-PROBE-1:001`. Runs 2 and 3: MO 5792 / WO 9304 / pick 21596 and MO 5793 / WO 9305 / pick 21597. |
| T3 read | `GET /api/work-orders/9303`, `GET /api/picks/21595` | WO Entered, five items of 2, `consumeItems` empty, no `pickItemId`. Pick Entered, four lines, no source, tag or lot. |
| T4 start | `POST /api/picks/21595/start` → 200 | Pick and lines Started; source Stock; nothing committed; no lot. |
| T5 fulfill too early | `POST /api/work-orders/9303/fulfill`, `finishedGoods` only | **400** "The work order's pick must be finished before the raw goods can be consumed automatically." — "Finish the pick, or supply rawGoods to consume the finished pick items only. Pick Item ID: 131593". Same on runs 2 and 3. |
| T6a REST | — | **Not run:** the 26.11 REST API has no call that commits or finishes a pick line. |
| T6b legacy wrapper | `POST /api/legacy/external/GetPickRq` then `…/SavePickRq` | **Works** (below). |
| T6c legacy API directly | — | **Not run:** not needed. |
| T7 fulfill ×3 | `POST /api/work-orders/:id/fulfill` | 9303 `rawGoods` omitted → 200 Fulfilled; 9304 `rawGoods` naming each `pickItemId` → 200 Fulfilled; 9305 `rawGoods` with another lot as tracking → 200 Fulfilled (row 4). |
| T8 route B | `POST /api/parts/:id/inventory/add`, `…/scrap` ×4 | All 200 (empty body). |

### T6b — finishing a pick line with a chosen lot

`GetPickRq` returns the pick as a legacy object (`PickItems.PickItem[]`, each with `PickItemID`, `Status`, `Part`, a placeholder `Tag` with `TagID: -1`, `Quantity`, `Tracking: ""`, source `Location`, `DestinationTag` = the Production staging tag 102040). `SavePickRq` sends the whole pick back with the chosen lines changed. The changed CUP line, as sent (other fields of the line and the other lines unchanged):

```json
{ "PickItemID": 131595, "Status": 40,
  "Part": { "PartID": 11811, "Num": "SKYTEST-CUP", "…": "as returned" },
  "Tag": { "TagID": 104630, "Num": "141376", "PartNum": "SKYTEST-CUP",
           "Location": { "LocationID": 1, "Name": "Stock", "…": "as returned" },
           "Quantity": 500, "QuantityCommitted": 0, "TypeID": 30,
           "Tracking": { "TrackingItem": { "PartTracking": { "PartTrackingID": 1, "Name": "Lot Number", "…": "as returned" }, "TrackingValue": "100583" } } },
  "Quantity": 2,
  "Tracking": { "TrackingItem": { "PartTracking": { "PartTrackingID": 1, "…": "as returned" }, "TrackingValue": "100583" } } }
```

Body: `{"SavePickRq": {"Pick": <the pick>}}`. Answer: `FbiMsgsRs.statusCode` 1000, `SavePickRs.statusCode` 1000, the saved pick. In the database the line is status 40, `srcTagId` 104630 (lot 100583), moved to a new staging tag in Production holding 2 committed of lot 100583, and its `trackinginfo` row (table −1515431424) reads 100583. Lines can be finished one at a time (CUP first, then the other three); the pick turns Finished when the last line is.

### T7 — what each fulfill did (data queries)

| | WO 9303 (omitted) | WO 9304 (`pickItemId`s) | WO 9305 (override) |
|---|---|---|---|
| MO / WO status | Fulfilled / Fulfilled | Fulfilled / Fulfilled | Fulfilled / Fulfilled |
| Finished lot | `SBX-80001`, 1 in Receiving (tag 105302) | `SBX-80002`, 1 (tag 105307) | `SBX-80003`, 1 (tag 105312) |
| Unit cost (cost layer) | $0.00 | $0.00 | $0.00 |
| Consumed, per component | 2 | 2 | 2 |
| Lot on the pick item | 100452 / 100746 / 100583 / 58663 | same | same |
| Lot on the work-order item | same as the pick | same as the pick | **100236 / 100512 / 100147 / 54285** |

Inventory log per run: four `yld` rows (pick moves, Stock → Production 3315, lot = the pick), four `csm` rows (−2 each, from Production), one `rcv` row (+1 finished good into Receiving). Posting: one `postwo` per work order (status 70) with a `postwoitem` per item, all at $0. Every `SKYTEST-` part and lot costs $0, so cost distribution cannot be seen with these parts.

## 3. Request bodies (T7, redacted)

```json
{ "finishedGoods": [ { "itemId": 49005, "quantityUsed": "1", "quantityScrapped": "1", "destinationLocationId": 3,
    "tracking": { "trackingItems": [ { "partTracking": { "id": 1 }, "value": "SBX-80001" } ] } } ],
  "splitWorkOrder": false }
```
Run 2 adds, per raw good, `"rawGoods": [ { "itemId": 49011, "consumeItems": [ { "quantity": "2", "uom": { "id": 1 }, "pickItemId": 131597 } ] }, …]`. Run 3 adds to each consume item `"tracking": { "trackingItems": [ { "partTracking": { "id": 1 }, "value": "100236" } ] }` (the part's other lot).

Route B (T8):
```json
POST /api/parts/11814/inventory/add
{ "location": { "id": 3 }, "quantity": "1", "uom": { "id": 1 }, "unitCost": "1.25",
  "note": "SBX probe route B (S17 D2) - sandbox only",
  "trackingItems": [ { "partTracking": { "id": 1 }, "value": "SBX-B-0001" } ] }

POST /api/parts/11809/inventory/scrap   (and 11812, 11811, 11810 with their named lots)
{ "location": { "id": 1 }, "quantity": "1", "uom": { "id": 1 },
  "note": "SBX probe route B (S17 D2) - sandbox only",
  "trackingItems": [ { "partTracking": { "id": 1 }, "value": "100452" } ] }
```

## 4. Postings — for Roger and Crystalyn

| What | Rows Fishbowl created | Type | Amount |
|---|---|---|---|
| Route A: three work-order fulfills | `postwo` 1 per work order (status 70), `postwoitem` 1 per item; **no `post` rows** | work-order posting (`postwo`) | $0.00 (the test parts cost $0) |
| Route B: add 1 `SKYTEST-STUD-ASSEMBLY`, lot `SBX-B-0001`, unit cost $1.25 | `post` 50073 (status 10, quantity 1, part 11814); inventory log `adj:inc` +1 in Receiving; cost layer $1.25 | Adjust | $1.25 |
| Route B: scrap 1 each of STUD, SPRING, CUP, PIN from a named lot | `post` 50074–50077 (status 10, quantity 1 each); inventory log `adj:scp` −1 each in Stock | Adjust | $0.00 each |

The `post` rows carry no account: the accounting export maps each posting type to an account, so the accounts are read from the accounting integration's settings, not from these tables. With real parts, route B would expense the components as **scrap at their cost** and bring the finished lot in at **whatever unit cost is supplied**, with no link between the two; route A keeps Fishbowl's work-order costing (components rolled into the finished good). A repeat with costed test parts would show real amounts.

## 5. Not run

- T6a (no REST route exists) and T6c (not needed).
- Close short; a partial build with `splitWorkOrder`; cost distribution with non-zero component costs.
- Cleanup: the sandbox keeps what the probe made (below).

## 6. Left in the sandbox

MOs 5791–5793 (`SBX-PROBE-1…3`), Fulfilled; finished lots `SBX-80001`, `SBX-80002`, `SBX-80003` (1 each) and `SBX-B-0001` (1, $1.25) in Receiving; component lots 100452, 100746, 100583, 58663 down 7 each (6 consumed, 1 scrapped), now 483–493.
