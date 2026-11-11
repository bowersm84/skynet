# SkyNet Fishbowl Bridge

Mirrors Fishbowl Advanced sales orders (Issued + In Progress) into SkyNet's `fb_*` tables and keeps them current,
and since v1.3 also mirrors the customer master, the product list and the SO history the Pricing Portal reads.
Reads Fishbowl through login / data-query / logout. Writes to SkyNet only through the `fb_*` RPCs, signed in as the
`integration` profile with the anon key — no service-role key anywhere on the plant network. Since v1.7 (D-PRICE-53)
it also carries SkyNet's price book INTO Fishbowl through one write path, the CSV import endpoint, and only when
`FB_PUSH_ENABLED=true` on PROD — see "Fishbowl pricing link" below. In short: it reads Fishbowl and writes to
Fishbowl only through the push queue. Since v1.11 it also mirrors picks, shipments, postings, tags, BOMs and
manufacture orders for the Assembly module (S17) — see "Assembly mirrors" below.

Design: `Docs/Implementation_Plans/FB1_Implementation_Plan.md` and `S11_Implementation_Plan.md` §7.
Field-level notes on what Fishbowl gives us: `Docs/Fishbowl_Data_Context.md`.
Decisions: `Docs/Decisions.md` (D-FB-*, D-PRICE-19/20/26).

## How it works
- Every `POLL_MS` (20 s): read `MAX(revinfo.id)`; for revisions above the stored cursor (minus a 200-revision overlap),
  collect the SO ids touched in `soitem_aud` / `so_aud`, refetch those SOs in full, and post them to `fb_ingest_delta`.
  The RPC upserts by fingerprint, marks lines missing from the payload as removed, writes `fb_sync_events`, and
  advances the cursor only when the last chunk of a window lands.
- Every `RECONCILE_MS` (15 min): compare Fishbowl's open SOs with the mirror's open SOs and refetch any that differ.
- Every `INVENTORY_MS` (5 min): on-hand / allocated / available per part, from `qtyinventorytotals` summed per
  location group; `AVAILABLE_LOCATION_GROUPS` decides which groups count as available (default Main + Warehouse).
  Shown as the "Avail" column in the Order Queue and as the inventory chips in Create Work Order (D-FB-39).
  **Scope (D-FB-40, v1.6; widened D-FB-52, v1.8):** the union of every part on an open SO line, every SkyNet
  `parts.part_number`, every part already in `fb_part_inventory`, every part classed Product in `fb_part_valuation`
  and every `fb_reorder_points` part — a few thousand parts, resolved to Fishbowl parts through `part.num`.
  **Zero rows:** the query starts from `part` and LEFT JOINs the totals, so a Fishbowl part with no stock record is
  written with every quantity 0 and `by_location = {}`. Before v1.6 such a part was skipped, and because the poller
  sends nothing for a part it did not read, its mirrored row kept its last values indefinitely (113 of 443 rows on
  2026-09-23). A part number Fishbowl does not know gets no row at all, so "no row" means "not a Fishbowl part".
  Every in-scope part is sent every cycle, which is what makes the D-FB-39 staleness test meaningful.
  Per cycle at ~1,300 parts: one `parts`/`fb_part_inventory` page read each, ~5 Fishbowl reads of 300 ids, and
  ~3 `fb_upsert_inventory` calls of 500 rows.
  **`INVENTORY_DRY_RUN=true`** builds the payload, logs the cycle line and the probe parts (SK-O, SK40S47-13S,
  SK26FB, SK4000-3S, SK4000CGP81, SK4C13C, SK4FB13S), and returns without writing. Only the literal `true` enables
  it — unlike `KITS_SYNC_ENABLED`, an absent or misspelt value leaves the poller writing normally.
  The arithmetic is a pure function in `src/inventory.mjs`; `node src/inventory.test.mjs` exercises it.
- Every `USERS_MS` (daily): Fishbowl user names (never password hashes or MFA secrets) so events say who changed what.
- Every cycle: `fb_heartbeat` (the Order Queue banner reads it).

### Pricing mirrors (v1.3, D-PRICE-26)
Three more read-only pollers, all inside the same Fishbowl session as the cycle above — the bridge never opens a
second session (D-FB-37). Each writes through its own `_pricing_gate('integration')` RPC, which stamps its clock in
`fb_sync_state`; `/pricing` shows the three ages.

| Poller | When | Reads | Writes |
|---|---|---|---|
| customers | every `POLL_CUSTOMERS_SEC` (900 s) | `customer` ⋈ `sysuser` ⋈ `paymentterms`, plus account groups via `accountgrouprelation`. First run is a full backfill; after that `dateLastModified > last_customers_at − 1 h`. | `fb_upsert_customers` → `fb_customers` (the RPC computes `name_clean` and self-links SkyNet `customers` by Fishbowl customer number) |
| products | nightly at `PRODUCTS_NIGHTLY_AT` (02:10 local) | the whole `product` ⋈ `part` table (~11k rows) | `fb_upsert_products` → `fb_products` (the RPC also links `price_items.fb_product_id`) |
| part_costs | with the products poll (D-PRICE-47) | latest RECEIVED `poitem` ⋈ `po` line per `part` (cost, date, PO number, vendor, qty) plus `part.stdCost`. Full read, no cursor. Skipped when `PART_COSTS_ENABLED=false` | `fb_upsert_part_costs` → `fb_part_costs`; the RPC derives `part_key` from `coalesce(product_num, part_num)` and stamps no `fb_sync_state` clock |
| so_history | nightly at `HISTORY_NIGHTLY_AT` (02:20 local) | `soitem` ⋈ `so` product lines (`typeId` 10 Sale / 12 Drop Ship) and kit header lines (`typeId` 80, D-PRICE-44), every status but Estimate (10), Voided (80), Cancelled (85) and Expired (90), paged 2,000 rows at a time from `fb_sync_state.history_cursor` (`HISTORY_BACKFILL_FROM` when there is none) | `fb_upsert_so_history` → `fb_so_history_lines`, each page carrying its own `dateLastModified` as the new cursor |

Nightly means "today's HH:MM has passed and the last run was before it", read from `fb_sync_state` — so a restart
cannot double-run a nightly job, and a bridge that was down at 02:20 catches up when it comes back.
After the part-costs read, the nightly slot also POSTs the `sync-kits` Edge Function (D-PRICE-49), which pushes the
price book's kit prices to the public skybolt-kits project. `KITS_SYNC_ENABLED=false` skips it. A failure there is
logged and swallowed: the kits site missing a night must not stand the Fishbowl mirrors down.

`part_costs` is the exception: `fb_sync_state` has no `last_part_costs_at` column, so it has no clock of its own
and instead runs immediately after each products poll. That keeps it nightly without letting it fire on every
20 s cycle, which is what an unscheduled `nightlyDue(null, …)` would do.
`paymentterms` and `accountgroup` are the two table names not confirmed on 25.9: if either read fails the poller
logs one warning and carries on without that column for the life of the process, rather than guessing names. A poll that finds nothing to do still calls its RPC with an empty payload, so the three ages on /pricing mean "last polled", not "last time anything changed". A pricing failure never stops the SO tail: it is logged and the pollers stand down for 15 minutes.

### Fishbowl pricing link (v1.7, D-PRICE-53)
Two more nightly mirrors in the products slot, and an outbound queue:

| Piece | When | Reads / writes |
|---|---|---|
| product tree | nightly, after part costs | `producttree` + `producttotree` ⋈ `product` → `fb_upsert_product_tree` → `fb_product_tree_nodes` / `fb_product_tree` (paths built in `rulesTree.mjs`) |
| pricing rules | nightly, with the tree | `pricingrule` with its type ids resolved through `productincltype` / `customerincltype` / `patype` / `pabaseamounttype` / `rndtype` → `fb_upsert_pricing_rules` → `fb_pricing_rules` |
| push auto | nightly, last | `fb_push_auto()`: never makes the first push of a kind; after that, when the book in effect is not the book of the last real prices/rules push, it QUEUES both (the Oct 1 case) |
| push executor | every cycle | `fb_push_next` claims the oldest `fb_push_commands` row; `push.mjs` POSTs its payload to `/api/import/<name>`; `fb_push_finish` records status/body; the mirror the push touched is re-read at once |

The payload is built server-side by `fb_push_enqueue` (from `pricing_fb_expected_*`) at enqueue time and stored on the
command, so what was sent is auditable. Kinds: `prices` → Product-Pricing (Product, Price; items priced by the SkyNet
percentage rules carry the book's list price to the last decimal, D-PRICE-54); `rules` → Pricing-Rules (25 columns,
upsert by name, every SkyNet rule named `SN …`; every push switches off SkyNet's own rules the book no longer has, and
`retire_legacy` also switches off every other active rule); `tree` → Product-Tree-Categories then Product-Tree;
`groups` → Customer-Group-Relations (it creates a group that does not exist yet; rules are only built for groups that do).
The confirmation is `SELECT pricing_fb_sync_status();` (portal: Pricing › Fishbowl Sync).

**Safety.** A push is real only when `FB_PUSH_ENABLED=true` AND the bridge's `SB_URL` host is `FB_PUSH_SB_HOST`
(default PROD). Otherwise a claimed command is a *forced dry run*: rows logged, nothing sent, `result.dry_run=true`,
which `fb_push_auto` does not count as a push. The PC bridge on TEST therefore exercises the whole path without
being able to write to Fishbowl. A command's own `dry_run` flag behaves the same way. A 0-row payload completes
without calling Fishbowl. `npm run mirror:rules` runs one rules + tree mirror pass and exits (first load).
`npm run fb:columns -- pricingrule producttree …` prints the columns Fishbowl actually has (read-only discovery).

### Inventory valuation mirror and month-end snapshot (v1.8, D-FB-52 / D-FB-53)
Two more pieces in the products nightly slot, after part costs:

| Piece | When | Reads / writes |
|---|---|---|
| valuation | nightly, after part costs | the opening-valuation query: every `part` with `typeId = 10`, its class (`customFields '$."33".value'`), `SUM(tag.qty)`, `partcost.avgCost / totalCost / qty`, the product and BOM flags → `fb_upsert_part_valuation` in batches → `fb_part_valuation`; then `fb_finish_part_valuation` retires rows that were not in tonight's read (cutoff from the DB clock). Stamps `fb_sync_state.last_valuation_at`. Skipped when `VALUATION_ENABLED=false` |
| month-end snapshot | nightly, right after the valuation | `inventory_snapshot_take()` — the RPC decides whether a snapshot is due (the 1st of the month, or a month-end missed while the bridge was down) and freezes Product parts + SkyNet bars and blanks into `inventory_valuation_snapshots`. Until the S13 Batch C migration exists the call answers PGRST202 and the bridge logs one `month-end snapshot skipped` warning per night |

Every class is mirrored (so a product part nobody has classed yet shows up in SkyNet's QA list); SkyNet filters
to `Product` for Stock Levels, the reorder rules and the month-end. The valuation also widens the 5-minute
inventory scope: every Product-class part and every reorder-point part gets a row (D-FB-52). A failure in
either piece is logged and swallowed; the mirrors and the SO tail are unaffected.
`npm run mirror:valuation` runs one valuation pass and exits (first load, or after fixing the query).

### Shipments poller (v1.9, D-FB-54 / D-KSTC-37)
Every logged kit gets its component lots from Fishbowl's own shipment records — no packing slip (D-KSTC-38).

| Piece | When | Reads / writes |
|---|---|---|
| queue | every cycle | every SO the tail touched (picking, packing and shipping all touch `soitem`) and every SO the reconciler refetched; at start-up and nightly (products slot), every SO with a shipment shipped in the last `SHIPMENTS_SWEEP_DAYS` (14) |
| read | every cycle, up to `SHIPMENTS_MAX_SOS` (100) queued SOs | `so` ⋈ `soitem` ⋈ `shipitem` ⋈ `ship` ⋈ `shipstatus`; the lot from `trackinginfo` (`recordId = shipitem.id`, `tableId = 1555030112`, tracking type `Lot Number`); kit membership from `kititem`, contiguous under the nearest kit header (the packing slip's indentation) → `fb_upsert_shipment_lots` → `fb_shipment_lots` (stamps `last_shipments_at`) |
| attach | after a cycle that wrote rows, and at least every `SHIPMENTS_ATTACH_MS` (15 min) | `kit_attach_fb_shipment_lots(false)`: every Shipped kit-member lot onto the kit lots logged on that SO with that kit part number; idempotent; logs one summary line |

The query is the 2026-10-09 calibrated pull (`Docs/migrations/2026-10-09_FISHBOWL_kit_component_lots_READONLY.sql`
rev 5) scoped by SO id — do not change its joins without re-calibrating against a known slip. Every lot of every
shipped item is mirrored (not only kits); the attach uses kit members only. An SO leaves the queue only after its
read succeeded; a failure stands the step down for 15 min and keeps the queue, and the SO tail is never affected.
The queue is in memory; the first shipments step after start-up queues the sweep window, so a restart or deploy loses nothing. `SHIPMENTS_DRY_RUN=true` reads and
logs (with five sample rows) and asks SkyNet for the attach's self-rolling-back dry run — nothing is written.
`npm run mirror:shipments` runs one sweep + read + attach and exits (first load; set `SHIPMENTS_SWEEP_DAYS` for a
longer window). `SHIPMENTS_ENABLED=false` switches off the queue, the start-up and nightly sweeps and the attach in the running bridge; `npm run mirror:shipments` is an explicit one-shot and runs regardless, like `mirror:valuation`.
Since v1.11 the ships of every SO read here also go through the ship mirror (`fb_upsert_shipments`, below), under
the same `SHIPMENTS_DRY_RUN` switch.
`npm test` runs the unit tests (the nine `node --test` files plus the inventory arithmetic test).

### Purchasing mirror (v1.10, D-FB-55)
Fishbowl purchase orders, whole: header, every line, every received receipt with its lot. SkyNet uses it for the
Giza Dashboard's purchasing section (`v_program_purchasing`) and the Movements report; any other screen can read the
three tables.

| Piece | When | Reads / writes |
|---|---|---|
| window | start-up, nightly (products slot) and the one-shot | every PO created or issued in the last `PURCHASING_WINDOW_DAYS` (365) plus every PO with no `dateCompleted` → queued |
| changed poll | every `PURCHASING_MS` (10 min) | POs whose `po.dateLastModified` or any `receiptitem.dateLastModified` is newer than the previous poll minus `PURCHASING_OVERLAP_MS` (30 min) → queued |
| read | every cycle, up to `PURCHASING_MAX_POS` (300) queued POs, `PURCHASING_BATCH_POS` (100) per read | `po` ⋈ `vendor`; `poitem` ⋈ `poitemtype`; `receiptitem` with its lot from `trackinginfo` (`recordId = receiptitem.id`, `tableId = 1259138490` 'ReceiptItem', tracking type `Lot Number`) → `fb_upsert_purchasing` → `fb_purchase_orders`, `fb_purchase_order_lines`, `fb_po_receipts` (stamps `last_purchasing_at`). Lines and receipts of a PO that are gone from Fishbowl are marked `removed_at` |
| status names | once per process | `postatus` / `poitemstatus`; if either table cannot be read the mirror logs one warning and sends ids only |

A PO always travels whole, so the RPC can see what disappeared. An id leaves the queue only after its read succeeded;
a failure stands the step down for 15 min and keeps the queue; the SO tail is never affected. `PURCHASING_DRY_RUN=true`
reads and logs (with five sample lines) and writes nothing. `npm run mirror:purchasing` runs one window read and exits
(first load). `PURCHASING_ENABLED=false` switches the poller and the nightly window off.

### Assembly mirrors (v1.11, D-ASM-23 / D-FB-58 / D-FB-59)
What S17 Assembly reads from Fishbowl: the pick line flag Ashley sets (D-ASM-06), shipments with carrier and tracking,
the Invoiced stamp (D-ASM-14), on-hand lots, BOMs with their sign-off lines, and manufacture orders down to the lots a
WO consumed (the read-back for D-ASM-01). Migration: `Docs/migrations/2026-11-04_S17_A1_fb_pick_ship_post_tags_boms_mo.sql`.

**Audit-tail registry (`src/audit.mjs`).** Four families, each tailing its own Envers tables on its own cursor in
`fb_sync_state`. Every cycle reads `MAX(revinfo.id)` once and the cursors once (`fb_get_family_cursors`); each family
reads the ids its tables touched in `(cursor − OVERLAP_REVS, maxRev]`, fetches those parents whole and sends them to its
upsert RPC. The cursor moves only inside that RPC (`GREATEST(cursor, p_rev_to)`) and only on a window's last call, so a
family that fails keeps its window and never moves another family's cursor. A window with nothing in it still makes
one empty call (it stamps the clock and moves the cursor). A NULL cursor — the first run on a database — loads the
family's backfill set instead. The sales-order tail is not in the registry: it keeps `last_rev`, `sync.mjs` and
`fb_ingest_delta` exactly as before.

| Family | Audit tables | Cursor | First-run backfill | RPC → mirror |
|---|---|---|---|---|
| picks | `pickitem_aud` (SO picks, `orderTypeId = 20`), `pick_aud` | `last_picks_rev` | every pick on an Issued / In Progress SO | `fb_upsert_pick_items` → `fb_pick_items` (dest location = the D-ASM-06 flag); mirror rows of a re-read pick that Fishbowl no longer has are marked `removed_at` |
| ships | `ship_aud`, `shipcarton_aud`, `shipitem_aud` | `last_ships_rev` | ships created in the last 180 days | `fb_upsert_shipments` → `fb_shipments`, `fb_ship_cartons`, `fb_ship_items` (lots stay in `fb_shipment_lots`) |
| mos | `mo_aud`, `moitem_aud`, `wo_aud`, `woitem_aud`, WO picks in `pickitem_aud` (`orderTypeId = 30`) | `last_mos_rev` | open MOs and MOs created in the last 180 days | `fb_upsert_manufacture_orders` → `fb_manufacture_orders`, `fb_mo_items`, `fb_work_orders`, `fb_wo_items`, `fb_wo_consumed_lots` (every child replaced per MO) |
| boms | `bom_aud`, `bomitem_aud`, `bominstructionitem_aud` | `last_boms_rev` | every active BOM (this counts as the night's sweep) | `fb_upsert_boms` → `fb_boms`, `fb_bom_items`, `fb_bom_instructions` (items and instructions replaced per BOM) |

**Polled mirrors** (no Envers table in Fishbowl for `tag` or `postso`):

| Poller | When | Reads / writes |
|---|---|---|
| tags (`src/tags.mjs`) | every `FB_TAGS_INTERVAL_MS` (5 min) | the tags of every part on an active BOM (Labor excluded; scope refreshed hourly) changed since the previous poll minus 10 min, lot from `trackingtext` → `fb_upsert_tags` → `fb_tags` (stamps `last_tags_at`) |
| postings (`src/postings.mjs`) | every `FB_POSTINGS_INTERVAL_MS` (5 min) | `postso` changed since the previous poll minus 10 min (first load: posted in the last 180 days) with every `postsoitem` → `fb_upsert_postings` → `fb_postings`, `fb_posting_items` (stamps `last_postings_at`) |
| tag sweep | every `FB_TAGS_SWEEP_INTERVAL_MS` (1 h) from `last_tags_sweep_at` (D-FB-62) | the whole tag scope again, sending every live in-scope mirror tag Fishbowl no longer has as removed (Fishbowl deletes a tag once it is emptied, which a delta read cannot see; stamps `last_tags_sweep_at`). An emptied lot therefore leaves `fb_tags` within the hour |
| BOM sweep | nightly at `FB_SWEEP_HOUR` (02:00 local) | every active BOM again (`p_sweep`, stamps `last_boms_sweep_at`) |

The first run on a database is a tag sweep too (about 3 s for the 2,832 tags of TEST's first run). A sweep that
reads no tags while the mirror holds some is treated as a failed read and marks nothing removed.

**Guards.** Every step — the SO tail, reconciler, users, inventory, the four families, tags, postings, shipments,
purchasing and pricing — runs through `guarded(family, fn, { retryMs })` (`src/guard.mjs`): a failure is logged,
recorded in `fb_sync_state.family_errors` through `fb_family_error`, and that step alone stands down (15 min; one
minute for the SO tail, the reconciler and the four families). Entries clear on recovery: the six new families clear
their own key on their next success inside their upsert RPC, and the guard clears the steps that have no upsert RPC
of their own (SO tail, reconcile, users, inventory, shipments, purchasing, pricing, valuation) with `fb_family_ok`
on their first success after a failure and on their first success after a restart (D-FB-61). The A2 banner also
judges an entry by its `at` time against the family's stamp. While the SO tail, reconciler, users or inventory is failing, the heartbeat still
writes it to `last_error`, so the Order Queue banner turns red as before. The cycle fails as a whole only when
Fishbowl cannot answer the cycle's first read (`MAX(revinfo.id)`) or the login. The heartbeat carries `cycleMs` and
`families: { picks, ships, mos, boms, tags, postings: { lastMs, ok } }`, and every cycle logs one line:
`bridge 1.11.0 cycle: cycleMs=… max_rev=… so=… picks=… ships=… mos=… boms=… tags=… postings=…`.

**Kit membership (D-FB-59).** SO kit children now come from Fishbowl's own link, `objecttoobject` `typeId 30`
(component soitem → kit header soitem). The D-FB-29 positional rule still runs first and is kept only for a line
with no link.

**Push dispatch (D-ASM-23).** The executor resolves a command's kind from a table inside the handler's `try`; a kind
this bridge does not know is finished `failed` with `unknown push kind: <kind>`, and the executor goes on to the next
command. No new kinds in 1.11.

| Key | Default | Purpose |
|---|---|---|
| `FB_TAGS_INTERVAL_MS` | `300000` | tag delta poll |
| `FB_TAGS_SWEEP_INTERVAL_MS` | `3600000` | full tag sweep (D-FB-62) |
| `FB_POSTINGS_INTERVAL_MS` | `300000` | postso delta poll |
| `FB_SWEEP_HOUR` | `2` | local hour (0–23) of the nightly BOM sweep |

No one-shot is needed for 1.11: the first cycle after the migration backfills each family and loads tags and postings.

### Manufacture orders (v1.12, S17 D1, D-ASM-52…55)
SkyNet queues `mo_create` when an assembly build is created, `mo_cancel` when it is cancelled and `mo_close_short`
when its post is verified with pieces left (all by triggers; migration `2026-11-11_S17_D1_fishbowl_mo_posting.sql`).
The bridge executes them in `src/mo.mjs` with the request bodies probed on the live Fishbowl on 2026-11-11
(`Docs/Fishbowl_Data_Context.md`, "Manufacture orders through the REST API"):

| Kind | What the bridge does | Result |
|---|---|---|
| `mo_create` | BOM must exist and be active; an MO that already has the number is reused (`created: false`); otherwise `POST /api/manufacture-orders`; then `POST …/issue` while it is Entered | `{fb_mo_id, mo_number, status, created}` |
| `mo_cancel` | find by id or number; refuse if anything is fulfilled; unissue if Issued; `DELETE`; confirm a 404. Already gone counts as deleted | `{deleted: true}` |
| `mo_close_short` | `POST …/close-short` on an Issued or Partial MO | `{closed: true}` |

**Fences.** A kind not in `FB_PUSH_KINDS` is failed unexecuted. Writes need `FB_MO_ENABLED=true` (separate from the
pricing switch `FB_PUSH_ENABLED`); otherwise every MO command is a forced dry run. `FB_WRITE_PART_PREFIX` (default
`SKYTEST-`) must be set, equal the command's `write_part_prefix`, and start the BOM number and every part on the BOM
or MO — the SQL refuses to queue anything else too. An MO number over 25 characters is refused (Fishbowl would cut it
short silently). If Fishbowl answers a write in a way the probe did not, the command fails and every later MO
command is failed unexecuted until the bridge is restarted — it never retries blind. After every real MO command the
MO's mirror rows are re-read in the same cycle; afterwards the mos audit tail keeps them current every cycle. An MO the
bridge deletes (`mo_cancel`) is marked removed in the mirror instead, through `fb_mark_mos_removed` (migration
`2026-11-11_S17_D1c_mo_mirror_removed.sql`, D-ASM-57); the audit tail alone never notices a deleted MO.

**TEST run (Matt's PC):** `FB_PUSH_KINDS=mo_create,mo_cancel,mo_close_short`, `FB_MO_ENABLED=true`,
`FB_PUSH_AUTO=false`, `FB_TAGS_INTERVAL_MS=60000`; `FB_PUSH_ENABLED` stays off. A 401 that forces a re-login is now
logged as a warning, so two bridges on the one Fishbowl user show up in the log if they collide.

## Setup (dev PC against TEST, or the Fishbowl server against PROD)
1. `cd tools/fishbowl-bridge && npm install`
2. Copy `.env.example` to `.env` and fill in `FB_PASS`, `SB_ANON_KEY`, `SB_BRIDGE_PASSWORD` (and `SB_URL` for PROD).
3. First run only: `npm run backfill` — loads every Issued / In Progress SO, sets the cursor, links the COs that
   were created by hand (prints a linkage report).
4. First run only, after the pricing schema is applied: `npm run backfill:pricing` (`node src/index.mjs --backfill`)
   — one full customers + products + SO history load from scratch, then exits. Expect ≈ 6.5k customers,
   10,980 products and ≈ 35k history lines over ~20 pages. Idempotent, safe to re-run.
5. First run only, after the S13 Batch A migration (v1.8): `npm run mirror:valuation` — one full read of every
   typeId-10 part into `fb_part_valuation`, so the next inventory cycle already covers every Product-class part.
6. First run only, after the D-FB-55 migration (v1.10): `npm run mirror:purchasing` — one read of every PO in the
   window into `fb_purchase_orders` / `fb_purchase_order_lines` / `fb_po_receipts`.
7. Smoke test: `npm run once` (one tail + one reconcile, then exits). Then `npm start`.

## Windows service (Fishbowl server)
Upgrades on skyserver: `Docs/Bridge_1_11_Install.md` (bundle from `scripts\package.ps1`; `sc` stop/start).
First install: NSSM (https://nssm.cc) and Node.js >= 18, then as Administrator:
`powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1`
Manage: `nssm status|stop|start|restart SkyNetFishbowlBridge`. Logs: `logs\bridge-YYYY-MM-DD.log` (+ service-stdout/stderr).

## Operations
- Bridge stopped? The Order Queue banner turns amber after 2 min and red after 10 min. Restart the service; the
  tail resumes from the stored cursor and the reconciler covers anything missed.
- Re-run either backfill any time: both are idempotent (`npm run backfill`, `npm run backfill:pricing`).
- Pricing mirror stale? Check `SELECT last_customers_at, last_products_at, last_history_at, history_cursor FROM fb_sync_state;`.
- Valuation mirror stale (Stock Levels costs older than a day)? `SELECT last_valuation_at FROM fb_sync_state;` then
  `npm run mirror:valuation`; the month-end snapshot only runs from the nightly slot, never from the one-shot.
  Re-reading history from a date is `UPDATE fb_sync_state SET history_cursor = '<date>' WHERE id = 1;` then wait for
  02:20, or run `npm run backfill:pricing` for a full reload.
- Reset the cursor (rare): `SELECT public.fb_set_cursor(<rev>)` in the SQL Editor — it only moves forward.
- v1.11 families: `SELECT fb_get_family_cursors(), family_errors FROM fb_sync_state;`. Setting one family's
  `last_<family>_rev` to NULL makes the next cycle backfill that family again; nothing else is affected.
  A `family_errors` entry means that step's last run failed; it disappears on the step's next success (D-FB-61).
- Seat usage: if Fishbowl shows the bridge consuming a user seat, set `SESSION_MODE=per_cycle` and restart.
- Never point two bridges at the same Supabase project; one per project (TEST, PROD) is fine.
- Push stuck `running`? The bridge crashed mid-import: `fb_push_next` fails it after 30 min and moves on. Check
  `logs\bridge-YYYY-MM-DD.log` and `SELECT id, kind, status, error, result FROM fb_push_commands ORDER BY id DESC LIMIT 5;`.
  Re-queue from the portal; every import is idempotent (Product Pricing updates by number, rules by name, tree/groups only add).
- `nssm restart SkyNetFishbowlBridge` can answer `Unexpected status SERVICE_STOP_PENDING` and never start the service
  (the bridge finishes its cycle before it stops). Use `nssm stop`, repeat `nssm status` until `SERVICE_STOPPED`, then `nssm start`.
- Log files are named by UTC date: after 8 pm Eastern the newest `logs\bridge-YYYY-MM-DD.log` carries tomorrow's date.
