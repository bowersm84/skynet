# Fishbowl Bridge Audit — November 2026 (bridge 1.10.0)

**Date:** 2026-11-03 · **Sprint:** S17 Batch 0 (read-only) · **Plan:** `Docs/Implementation_Plans/S17_Implementation_Plan.md` v1.1
**Source audited:** `tools/fishbowl-bridge/` on `main` at `1565e2a` (branch `feature/s17-assembly`), plus the SQL in `Docs/migrations/` that the bridge calls.
**Method:** code reading only. Nothing was run against Fishbowl or Supabase PROD. Two read-only catalog queries were run on Supabase TEST (`ylzmyjjqibpbqbwjsnqj`) on 2026-11-03 to confirm what the repo files cannot show (current function list, `fb_*` RLS posture, `fb_sync_state` columns, `fb_ingest_delta` patch markers). Secret values are never printed here; keys are named only.
**Citations:** `file:line` relative to the repo root. "TEST catalog" means the 2026-11-03 query above. Plan §6 Fishbowl facts are referenced, not re-derived.

---

## 1. Runtime shape

### 1.1 Entry and process lifecycle
- Entry is `tools/fishbowl-bridge/src/index.mjs`. Modes by argv: run forever (default), `--once`, `--backfill`, `--mirror-rules`, `--mirror-valuation`, `--mirror-shipments`, `--mirror-purchasing` (`index.mjs:3-9`, `index.mjs:507-576`). The SO backfill is a separate script, `scripts/backfill.mjs` (`package.json:13`).
- `main()` logs a start banner (`index.mjs:514`), signs in to Supabase (`index.mjs:515`), reads the pricing clocks from `fb_sync_state` (`index.mjs:516-517`), logs the push gate (`index.mjs:518-519`) and the shipments/purchasing modes (`index.mjs:542-543`), then loops `cycle()` until `stopping` (`index.mjs:577-595`).
- Loop timing: after a good cycle it sleeps `max(POLL_MS − elapsed, 1000)` (`index.mjs:593-594`), so a long cycle stretches the cadence rather than overlapping. After a failed cycle it backs off `min(60000, 5000·2^min(failures,4))` ms (`index.mjs:589`).
- SIGINT / SIGTERM set `stopping`; the current cycle finishes, then `fb.logout()` (`index.mjs:596-602`). NSSM gives it 15 s (`scripts/install-service.ps1:27`). An uncaught error in `main()` logs `fatal:` and exits 1 (`index.mjs:604-607`); NSSM restarts after 10 s (`install-service.ps1:25-26`).
- Every Fishbowl call in a cycle runs inside one `fb.withSession()` (`index.mjs:423`; `fishbowl.mjs:118-125`) — one session per process (D-FB-37). `SESSION_MODE=per_cycle` logs in and out around each cycle (`fishbowl.mjs:119-121`); skyserver runs `per_cycle` (`Docs/Decisions.md:3829`).

### 1.2 Cycle order and cadence
There is no poller registry. The order is the literal sequence in `cycle()` (`index.mjs:421-451`):

| # | Step | Function | Cadence | Clock |
|---|---|---|---|---|
| 1 | SO Envers tail | `tail()` `index.mjs:370-393` | every cycle (`POLL_MS` 20 000) | `fb_sync_state.last_rev` |
| 2 | Reconciler | `reconcile()` `index.mjs:395-419` | `RECONCILE_MS` 900 000 (`index.mjs:426`) | in-memory `lastReconcileAt` (`index.mjs:31`) |
| 3 | Users | `syncUsers()` `index.mjs:60-67` | `USERS_MS` 86 400 000 (`index.mjs:430`) | in-memory `lastUsersAt` (`index.mjs:33`) |
| 4 | Inventory | `syncInventory()` `index.mjs:79-139` | `INVENTORY_MS` 300 000 (`index.mjs:434`) | in-memory `lastInventoryAt` (`index.mjs:32`) |
| 5 | Shipments | `shipmentsCycleGuarded()` `index.mjs:295-307` | every cycle, ≤ `SHIPMENTS_MAX_SOS` SOs | queue `pendingShipmentSos` (`index.mjs:44`) |
| 6 | Purchasing | `purchasingCycleGuarded()` `index.mjs:355-368` | poll every `PURCHASING_MS` 600 000; read every cycle | queue `pendingPurchasingPos` (`index.mjs:52`) |
| 7 | Pricing mirrors + nightly slot | `pricingCycleGuarded()` `index.mjs:252-260` | customers every `POLL_CUSTOMERS_SEC`; products slot nightly 02:10; history nightly 02:20 | `fb_sync_state.last_*_at` via `nightlyDue()` (`pricing.mjs:129-138`) |
| 8 | Push executor | `pushCycleGuarded()` `index.mjs:267-275` | every cycle, ≤ `FB_PUSH_MAX_PER_CYCLE` | `fb_push_commands` |
| 9 | Heartbeat | `sky.heartbeat()` `index.mjs:444-447` | after every successful cycle | `fb_sync_state.last_heartbeat_at` |

The in-memory clocks start at 0, so a restart runs reconcile, users and inventory on its first cycle. Nightly jobs read their clocks from `fb_sync_state`, so a restart never double-runs them (`pricing.mjs:125-128`).

The nightly products slot runs, in order: products → part costs → valuation + month-end snapshot → shipments sweep → purchasing window → kits site → rules/tree → push auto (`index.mjs:157-235`); SO history has its own 02:20 slot (`index.mjs:237-245`).

### 1.3 Failure isolation
- **Guarded steps** (shipments, purchasing, pricing, push) catch their own errors, log them and stand down for 15 minutes: `SHIPMENTS_RETRY_MS`, `PURCHASING_RETRY_MS`, `PRICING_RETRY_MS`, `PUSH_RETRY_MS` = 900 000 (`index.mjs:37`, `:48`, `:57`, `:266`). Shipments and purchasing keep their queues on failure (`index.mjs:303-306`, `:364-367`).
- **Inside the nightly slot** valuation, shipments sweep, purchasing window, kits sync, rules/tree and push auto are each in their own try/catch (`index.mjs:171-234`). Customers, products, part costs and SO history are not; a throw there pauses all pricing for 15 minutes (`index.mjs:256-259`).
- **Unguarded steps:** tail, reconcile, users and inventory. A throw in any of them aborts the whole cycle, so steps 5–8 do not run that cycle; the loop logs it, writes `last_error` through the heartbeat and backs off (`index.mjs:582-590`). A `Fishbowl login failed` message clears the token (`index.mjs:587`).

### 1.4 Start-up self-checks and the health surface
- `config.mjs` throws on a missing `FB_USER`, `FB_PASS`, `SB_URL`, `SB_ANON_KEY`, `SB_BRIDGE_EMAIL` or `SB_BRIDGE_PASSWORD` (`config.mjs:28-32`, `:44-58`). A failed Supabase sign-in is fatal (`skynet.mjs:36-41`; `index.mjs:604-607`). Fishbowl is not contacted at start; `ensureSession()` logs in lazily on the first query (`fishbowl.mjs:68-70`).
- The tail refuses to run while `last_rev` is 0 ("run `npm run backfill` first") (`index.mjs:376-379`).
- **There is no `/health` endpoint**; the bridge opens no listening socket. Health is the `fb_heartbeat(p_state jsonb)` RPC after each good cycle (`index.mjs:444-447`), which sets `last_heartbeat_at`, `bridge_version`, `bridge_host`, `last_error`, `last_error_at` (`Docs/migrations/2026-08-25_fishbowl_bridge_a.sql:262-277`). The `last_rev`, `reconciled` and `backfilled` keys the bridge sends are ignored by the RPC (same lines).
- The Order Queue banner reads `fb_sync_state`: green under 2 min, amber 2–10 min, red over 10 min or any `last_error` (`src/lib/fishbowl.js:186-197`; `src/components/orderqueue/SyncStatusBanner.jsx:14-16`).
- Failures in guarded steps never reach `last_error`; the next good heartbeat writes `last_error = NULL` (`2026-08-25_fishbowl_bridge_a.sql:272`). Their only signal is the log file and each mirror's own stamp.
- Log file: `logs\bridge-YYYY-MM-DD.log`, named by UTC date (`skynet.mjs:9-15`; `README.md:175`).

### 1.5 Environment keys
`.env` is read from the bridge folder; a real environment variable wins, and the **first** occurrence of a key in `.env` wins (`config.mjs:20-26`). Only the literal `true` turns on the "opposite-default" flags (`config.mjs:64-67`, `:90-97`).

| Key | Default | Purpose | Source |
|---|---|---|---|
| `FB_HOST` | `192.168.1.251` | Fishbowl server | `config.mjs:42` |
| `FB_PORT` | `2456` | Fishbowl REST port | `config.mjs:43` |
| `FB_USER` | required | Fishbowl service account (`skynet-bridge`, `FB1_Cutover_Runbook.md:105`) | `config.mjs:44` |
| `FB_PASS` | required | its password | `config.mjs:45` |
| `FB_APP_ID` | `4350` | Integrated App id | `config.mjs:46` |
| `SESSION_MODE` | `hold` | `per_cycle` = log in/out each cycle | `config.mjs:49` |
| `FB_TIMEOUT_MS` | `30000` | per-request timeout | `config.mjs:50` |
| `FB_IMPORT_TIMEOUT_MS` | `300000` | import (push) timeout | `config.mjs:52` |
| `SB_URL` | required | SkyNet Supabase URL | `config.mjs:55` |
| `SB_ANON_KEY` | required | anon key (no service key, see below) | `config.mjs:56` |
| `SB_BRIDGE_EMAIL` | required | `integration` profile login | `config.mjs:57` |
| `SB_BRIDGE_PASSWORD` | required | its password | `config.mjs:58` |
| `POLL_MS` | `20000` | cycle period | `config.mjs:60` |
| `RECONCILE_MS` | `900000` | reconciler period | `config.mjs:61` |
| `INVENTORY_MS` | `300000` | inventory period | `config.mjs:62` |
| `USERS_MS` | `86400000` | users period | `config.mjs:63` |
| `INVENTORY_DRY_RUN` | off (literal `true` only) | build inventory payload, write nothing | `config.mjs:67` |
| `AVAILABLE_LOCATION_GROUPS` | `1,6` | groups counted as available | `config.mjs:69-70` |
| `POLL_CUSTOMERS_SEC` | `900` | customers poll | `config.mjs:73` |
| `PRODUCTS_NIGHTLY_AT` | `02:10` | products slot (local) | `config.mjs:74` |
| `HISTORY_NIGHTLY_AT` | `02:20` | SO history slot | `config.mjs:75` |
| `HISTORY_BACKFILL_FROM` | `2023-11-27` | history start | `config.mjs:76` |
| `HISTORY_PAGE` | `2000` | rows per history page | `config.mjs:77` |
| `PRICING_BATCH` | `500` | rows per `fb_upsert_*` call | `config.mjs:78` |
| `KITS_SYNC_ENABLED` | on (only `false` disables) | nightly kits-site push | `config.mjs:80` |
| `PART_COSTS_ENABLED` | on | part-cost mirror | `config.mjs:83` |
| `VALUATION_ENABLED` | on | valuation mirror + month-end snapshot | `config.mjs:86` |
| `OVERLAP_REVS` | `200` | tail re-reads this many revisions | `config.mjs:87` |
| `CHUNK` | `50` | SOs per ingest call | `config.mjs:88` |
| `FB_PUSH_ENABLED` | off (literal `true` only) | real writes to Fishbowl | `config.mjs:97` |
| `FB_PUSH_SB_HOST` | `luzungoqfuplspzbqctb.supabase.co` | only SkyNet host a real push may run on | `config.mjs:98` |
| `FB_PUSH_AUTO` | on | nightly `fb_push_auto` | `config.mjs:100` |
| `FB_PUSH_MAX_PER_CYCLE` | `3` | commands claimed per cycle | `config.mjs:101` |
| `RULES_TREE_ENABLED` | on | rules + tree mirrors | `config.mjs:103` |
| `SHIPMENTS_ENABLED` / `SHIPMENTS_DRY_RUN` | on / off | shipments poller | `config.mjs:109-110` |
| `SHIPMENTS_SWEEP_DAYS` / `SHIPMENTS_MAX_SOS` / `SHIPMENTS_ATTACH_MS` | `14` / `100` / `900000` | sweep window, per-cycle cap, attach period | `config.mjs:111-113` |
| `PURCHASING_ENABLED` / `PURCHASING_DRY_RUN` | on / off | purchasing mirror | `config.mjs:119-120` |
| `PURCHASING_MS` / `PURCHASING_OVERLAP_MS` / `PURCHASING_WINDOW_DAYS` / `PURCHASING_MAX_POS` / `PURCHASING_BATCH_POS` | `600000` / `1800000` / `365` / `300` / `100` | purchasing cadence and caps | `config.mjs:121-125` |
| `FB_IMPORT_PRODUCT` / `_RULES` / `_TREE_CATEGORIES` / `_TREE` / `_GROUPS` | `Product-Pricing` / `Pricing-Rules` / `Product-Tree-Categories` / `Product-Tree` / `Customer-Group-Relations` | Fishbowl import names | `config.mjs:128-136` |

- **Supabase service key:** none, by design. The bridge signs in as the `integration` profile with the anon key (`skynet.mjs:1-2`, `:30-41`; `README.md:5-6`). `KITS_SUPABASE_URL` / `KITS_SERVICE_ROLE_KEY` are Edge Function secrets of `sync-kits`, not bridge keys (`Docs/Decisions.md:3819`).
- **Valuation / pricing keys:** only the switches above (`VALUATION_ENABLED`, `PART_COSTS_ENABLED`, `KITS_SYNC_ENABLED`, `RULES_TREE_ENABLED`, `FB_PUSH_*`). No cost or rate value is configured in the bridge.
- **Dry-run flags:** `INVENTORY_DRY_RUN`, `SHIPMENTS_DRY_RUN`, `PURCHASING_DRY_RUN`; the push queue's dry run is the gate in §4, not a key of its own.
- Every key above appears in `tools/fishbowl-bridge/.env.example` (lines 3-72), most commented out at their defaults.

### 1.6 Packaging and install on skyserver (`D:\SkyNetBridge`)
The repo has no build script for the zip. The bundle command is in `Docs/FB1_Cutover_Runbook.md:87-89`; the per-version deploy order is the cheatsheet's §11 (`Docs/SkyNet_Claude_Cheatsheet.docx`, "Deploy runbook per version": certutil hash check → sc stop → robocopy backup → tar -xf over `D:\SkyNetBridge` → npm install --omit=dev → .env edits → sc start → coverage DIAG; rollback is two folder renames) and `Docs/Decisions.md:3828`. The per-version runbook those notes cite (`2026-09-23_Bridge_1.6.0_SkyServer_Deploy_Runbook.md`) is **not in the repo**, so the exact switches on `certutil`, `robocopy` and `tar` below are their standard forms, not copied from a repo file.

On Matt's PC (repo root, the bridge change committed):
1. Build the bundle — no `node_modules`, `.env` or `logs` (`FB1_Cutover_Runbook.md:87-89`, `Decisions.md:3828`):
   `Compress-Archive -Force -DestinationPath "$env:USERPROFILE\Desktop\SkyNetBridge.zip" -Path tools\fishbowl-bridge\package.json, tools\fishbowl-bridge\package-lock.json, tools\fishbowl-bridge\README.md, tools\fishbowl-bridge\.env.example, tools\fishbowl-bridge\src, tools\fishbowl-bridge\scripts`
2. Hash it: `certutil -hashfile "$env:USERPROFILE\Desktop\SkyNetBridge.zip" SHA256`, and copy the zip to skyserver (Remote Desktop) (`FB1_Cutover_Runbook.md:92`).

On skyserver, elevated cmd:
3. Apply the version's PROD migration first, if it has one (migration before code: `Docs/migrations/2026-10-09_D-FB-54_fb_upsert_shipment_lots.sql:18-19`).
4. `certutil -hashfile SkyNetBridge.zip SHA256` — must match step 2.
5. `sc stop SkyNetFishbowlBridge`, then repeat `sc query SkyNetFishbowlBridge` until `STOPPED` (the bridge finishes its cycle first; `README.md:173-174`). Service name: `scripts/install-service.ps1:4`. `nssm` is not on skyserver's PATH; `sc` does the job (`Decisions.md:3828`).
6. Back up: `robocopy D:\SkyNetBridge D:\SkyNetBridge_v1.10.0_<yyyy-mm-dd> /E` (backup-folder precedent `D:\SkyNetBridge_v1.4.0_2026-09-23`, `Decisions.md:3828`).
7. Extract over the folder: `tar -xf SkyNetBridge.zip -C D:\SkyNetBridge` — `D:\SkyNetBridge\package.json` must exist afterwards (`FB1_Cutover_Runbook.md:92`). `.env`, `logs` and `nssm.exe` are not in the zip and stay.
8. `cd /d D:\SkyNetBridge`, then `npm install --omit=dev`, then `node --check src\index.mjs` (no output = OK) (`FB1_Cutover_Runbook.md:95-97`).
9. Edit `D:\SkyNetBridge\.env` for any new keys. Delete a line rather than adding a second copy — the first occurrence wins (`config.mjs:24`).
10. Run the version's one-shot if it has one (for example `npm run mirror:purchasing` for 1.10, `README.md:149-150`).
11. `sc start SkyNetFishbowlBridge`.
12. Confirm: in PROD SQL, `select last_rev, last_heartbeat_at, now() - last_heartbeat_at as age, bridge_version, bridge_host, last_error from fb_sync_state;` → age under 20 s, the new version, host `skyserver`, no error (`FB1_Cutover_Runbook.md:159`). The newest `D:\SkyNetBridge\logs\bridge-*.log` shows `SkyNet Fishbowl Bridge v<version> starting on …` (`index.mjs:514`). Run the coverage DIAG (`Docs/migrations/2026-09-23_DIAG_fb_inventory_coverage_READONLY.sql`).
13. Rollback: `sc stop`, rename `D:\SkyNetBridge` aside, rename the step-6 backup to `D:\SkyNetBridge`, `sc start` (cheatsheet §11).

---

## 2. Fishbowl client (`src/fishbowl.mjs`)

### 2.1 Login, token, transport
- `login()` POSTs `/api/login` with `{ appName, appDescription, appId, username, password }` and keeps `token` from the JSON reply; non-200 throws `FishbowlError('Fishbowl login failed …')` (`fishbowl.mjs:46-56`). `appName` is `'SkyNet Bridge'`, `appId` defaults to 4350 (`config.mjs:46-48`).
- `logout()` POSTs `/api/logout` with the bearer token; failures only warn (`fishbowl.mjs:58-66`).
- Transport is `node:http`, deliberately: `/api/data-query` is a GET with a SQL body, which `fetch()` refuses (`fishbowl.mjs:3-4`). `_call(method, path, headers, body, timeoutOverride)` is the one low-level request (`fishbowl.mjs:29-44`); on timeout it destroys the request with `Fishbowl request timed out after … ms` (`fishbowl.mjs:39`). Non-UTF-8 bytes fall back to latin1 (`fishbowl.mjs:15-20`).

### 2.2 `query(sql)` — the read helper
- Signature `async query(sql)` → array of row objects (`fishbowl.mjs:73-92`). Sends `GET /api/data-query`, `Content-Type: application/sql`, body = SQL (`fishbowl.mjs:75-77`).
- On 401 it clears the token, logs in once and retries once (`fishbowl.mjs:78-85`). Any other non-200 throws `FishbowlError('data-query failed (status): body :: first 200 chars of SQL')` (`fishbowl.mjs:86-88`). A non-array reply throws (`fishbowl.mjs:90`).
- Rows come back with Fishbowl's own column aliases; every SQL statement lives in `src/queries.mjs` (`queries.mjs:1-2`), and every row is normalised in `src/mapper.mjs` (timestamps `ts()`, numbers `num()`/`int()`, booleans `bool()`, dates `dateOnly()`, local datetimes for WHERE clauses `fbDateTime()` in America/New_York) (`mapper.mjs:7-44`, `:164-185`).
- **Retry:** the client retries only the 401 re-login. Cycle-level backoff is in §1.1. Supabase RPCs retry 3 times with 1 s·attempt sleeps; a permission error (`42501`) or a missing function (`PGRST202`) throws at once; a JWT error re-signs in (`skynet.mjs:47-68`).
- **Fail fast / fail loud in code:** errors are thrown, never swallowed into partial data — `FishbowlError` carries status and body (`fishbowl.mjs:6-13`); a lot row of any tracking type other than `Lot Number` is dropped so "nothing loads and the log says so — never wrong lots" (`shipments.mjs:15-17`, `:45-48`); SQL inputs are validated (`queries.mjs:90-91`, `:289`, `:296`); string lists are escaped and an empty list becomes `NULL` (`queries.mjs:10-14`); "Do not guess new ones" for column names (`queries.mjs:2`). The one tolerated degradation is the pricing poller losing `paymentterms` / `accountgroup`, logged once (`pricing.mjs:11-19`).

### 2.3 Other REST endpoints in use
- Only one: `importRows(name, rows)` → `POST /api/import/<name>` with a JSON array-of-arrays (header row first), import timeout, same 401 re-login, non-2xx throws with up to 1 500 chars of body (`fishbowl.mjs:94-115`). Import names used: `Product-Pricing`, `Pricing-Rules`, `Product-Tree-Categories`, `Product-Tree`, `Customer-Group-Relations` (`config.mjs:128-136`; `push.mjs:15-23`).
- There is no JSON REST helper yet (no `POST /api/manufacture-orders`, no inventory add/scrap). Batch D adds one beside `importRows`, using `_call`.

---

## 3. Readers

### 3.1 Sales orders — the Envers tail
- **Module / functions:** `tail()` (`index.mjs:370-393`) → `revisionMap(fb, from, to)` (`sync.mjs:64-75`) → `ingestIds(...)` (`sync.mjs:38-61`) → `fetchOrders(...)` (`sync.mjs:24-34`) → RPC `fb_ingest_delta(p_payload jsonb)` (`skynet.mjs:70`).
- **Cursor on `revinfo`:** `SELECT MAX(id) AS maxRev FROM revinfo` (`queries.mjs:17`). The stored cursor is `fb_sync_state.last_rev`, read once per process with `fb_get_cursor()` (`index.mjs:373-375`; `2026-08-25_fishbowl_bridge_a.sql:233-244`). The window is `(max(last_rev − OVERLAP_REVS, 0), maxRev]` (`index.mjs:383`). Who/when per revision: `SELECT id, timestamp, modifiedUserId FROM revinfo WHERE id IN (…)` (`queries.mjs:27`).
- **Which `_aud` tables are tailed:** exactly two, `soitem_aud` and `so_aud`, hard-coded in one statement (`queries.mjs:21-25`):
  ```sql
  SELECT x.soId, MAX(x.REV) AS rev FROM (
      SELECT soId, REV FROM soitem_aud WHERE REV > ${from} AND REV <= ${to}
      UNION ALL
      SELECT id AS soId, REV FROM so_aud WHERE REV > ${from} AND REV <= ${to}
    ) x JOIN so s ON s.id = x.soId WHERE s.statusId <> 10 GROUP BY x.soId
  ```
  The join to `so` drops Estimates (D-FB-11). There is no table list or registry: "which tables" is this SQL.
- **Fetch SQL:** headers (`queries.mjs:29-33`), lines (`queries.mjs:35-42`) and kit definitions `SELECT kitProductId, productId, kitItemTypeId FROM kititem WHERE kitProductId IN (…)` (`queries.mjs:45`). Kit children are tagged by `tagKitChildren()` — positional, from the nearest kit header, `kitItemTypeId 10` only (`sync.mjs:6-21`; `mapper.mjs:107-132`) — and land in `fb_sales_order_lines.parent_fb_soitem_id` (`2026-08-26_fishbowl_bridge_c1.sql:13`, `:596`).
- **Written:** `fb_sales_orders`, `fb_sales_order_lines`, `fb_sync_events` via `fb_ingest_delta` (definition `2026-08-26_fishbowl_bridge_c1.sql:285-722`, later patched in place by D-FB-45 and D-FB-48 — see §7).
- **Cursor advance:** only the last chunk carries `rev_to` (`sync.mjs:36-54`); `fb_ingest_delta` moves `last_rev = GREATEST(last_rev, rev_to)` and `last_rev_at` only when `source = 'tail'` (`c1.sql:707-711`). Reconcile stamps `last_reconcile_at`, backfill `last_backfill_at` (`c1.sql:712-715`). The in-memory `lastRev = max` follows (`index.mjs:391`).
- **Deletes and reappearances:** an SO id the fetch no longer finds is sent in `removed_ids` (`sync.mjs:31-33`) and gets `removed_at` plus an `so_removed` event (`c1.sql:690-704`); a line missing from a fetched SO gets `removed_at` (`c1.sql:657-662`); a row that comes back clears `removed_at` and records a `reappeared` change (`c1.sql:410-411`, `:437`, `:562-563`, `:595`).
- **Adding an audited table (Batch A: `pick`, `pickitem`, `ship`, `shipcarton`, `shipitem`, `mo`, `moitem`, `wo`, `woitem`, `bominstructionitem`; `trackingtext` — verify at deploy that `trackingtext_aud` exists, plan §6):** it is not a list edit. Each family needs:
  1. a revision query in `queries.mjs` over its `_aud` table for the same window, returning the key the fetch needs (pick/ship → SO id or pick/ship id; mo/wo → MO id; bominstructionitem → BOM id);
  2. a current-state fetch query and a pure mapper with a `node --test` file (pattern: `shipments.mjs` + `shipments.test.mjs`);
  3. a SkyNet mirror table, an `fb_upsert_<x>(p_rows jsonb)` RPC and a stamp column (pattern §5);
  4. a wrapper in `skynet.mjs` (pattern `skynet.mjs:104`);
  5. a call site in `index.mjs`, guarded and queued like shipments (`index.mjs:277-307`);
  6. a decision on the cursor: today the single `last_rev` advances inside the **SO** ingest. A new family that reads the same window after `ingestIds` has committed `rev_to` loses its window if it then fails (the 200-revision overlap covers only small gaps). Either collect the new families' ids before the ingest commits, or give each family its own cursor column (see §7).
  Picking, packing and shipping already touch `soitem`, so the SO is re-fetched within a cycle (`index.mjs:389-390`), but `fb_ingest_delta`'s payload carries no pick, ship or posting data.

### 3.2 Reconciler
- `reconcile()` compares Fishbowl's open SOs `SELECT id, statusId, dateLastModified FROM so WHERE statusId IN (20,25)` (`queries.mjs:308`) with the mirror's open SOs (`skynet.mjs:234-243`) and refetches any SO missing, newer by more than 1 s, or no longer open (`index.mjs:395-419`). Each refetched SO is also queued for shipments (`index.mjs:416`).

### 3.3 Inventory
- `syncInventory()` (`index.mjs:79-139`). Scope = open-SO part ids ∪ SkyNet part numbers ∪ already-mirrored numbers ∪ Product-class valuation parts ∪ reorder-point parts (`index.mjs:80-90`; `skynet.mjs:161-232`), resolved by `SELECT p.id AS partId, p.num AS partNum FROM part p WHERE p.num IN (…)` (`queries.mjs:105`).
- SQL (`queries.mjs:114-117`):
  ```sql
  SELECT p.id AS partId, p.num AS partNum, q.LOCATIONGROUPID AS locationGroupId,
      q.QTYONHAND AS qtyOnHand, q.QTYALLOCATED AS qtyAllocated, q.QTYNOTAVAILABLE AS qtyNotAvailable, q.QTYONORDER AS qtyOnOrder
    FROM part p LEFT JOIN qtyinventorytotals q ON q.PARTID = p.id
    WHERE p.id IN (…)
  ```
- Aggregated per part by `aggregateInventory()` (`inventory.mjs:26-60`); written by `fb_upsert_inventory(p_rows jsonb)` to `fb_part_inventory` (incl. `qty_not_available`, `by_location`, `part_id`), stamping `last_inventory_at` (`Docs/migrations/2026-10-07_S13_A_fb_valuation_reorder.sql:244-276`).
- No deletes: a Fishbowl part with no stock record is written as a zero row; an unknown number gets no row (`inventory.mjs:4-12`). Cadence 5 min; no watermark (full scope each time). **No lot detail** — `qtyinventorytotals` is per location group; Batch A's `fb_tags` is new.

### 3.4 Shipments (`src/shipments.mjs`, D-FB-54)
- Queue: SO ids from the tail, reconciler, start-up sweep and nightly sweep (`index.mjs:309-319`, `:390`, `:416`); sweep SQL `SELECT DISTINCT si.soId … WHERE ship.dateShipped >= '<date>'` (`queries.mjs:90-97`). ≤ `SHIPMENTS_MAX_SOS` per cycle; an id leaves the queue only after its read succeeded (`index.mjs:280-293`).
- **The `trackinginfo` join** (`queries.mjs:83-84`):
  ```sql
  LEFT JOIN trackinginfo ti ON ti.recordId = shi.id AND ti.tableId = 1555030112
  LEFT JOIN parttracking pt ON pt.id = ti.partTrackingId
  ```
  `1555030112` is the shipped-item tracking history (`shipitem.tagId` is cleared once a shipment ships); `-1515431424` is the pick history — named in a comment only, no query uses it yet (`queries.mjs:50-51`). Lot rows are those whose `pt.name` is `Lot Number` (`shipments.mjs:17`, `:45-48`). Full statement `queries.mjs:54-86` (one row per shipped item per lot, with kit membership from `kititem`).
- **`fb_shipment_lots` upsert shape:** payload keys (camelCase) `shipItemId, lotNumber, soNum, soItemId, soLine, productNum, kitLine, kitProductNum, kitMember, kitQtyFulfilled, shipNum, shipStatus, dateShipped, qtyShipped, lotQty` (`shipments.mjs:21-42`, `trackingName` dropped at `:50-54`) → `fb_upsert_shipment_lots(p_rows jsonb) RETURNS integer`, `SECURITY DEFINER`, `_fb_gate(['integration','admin'])`, `DISTINCT ON (shipItemId, lotNumber)`, `ON CONFLICT (fb_shipitem_id, lot_number) DO UPDATE`, `source = 'bridge'`, stamps `last_shipments_at` (`Docs/migrations/2026-10-09_D-FB-54_fb_upsert_shipment_lots.sql:30-96`). Table and PK: `2026-10-09_kit_fb_shipment_lots_step1_schema.sql:15-34`.
- Attach: `kit_attach_fb_shipment_lots(p_dry_run)` after any cycle that wrote rows and at least every `SHIPMENTS_ATTACH_MS` (`index.mjs:289-292`; `skynet.mjs:106`).
- Deletes: none — rows are only upserted; a ship status change is picked up on re-read, a shipment item that disappears keeps its last row (§7).

### 3.5 Purchase orders (`src/purchasing.mjs`, D-FB-55)
- Window queue `SELECT po.id AS poId FROM po WHERE po.dateCreated >= … OR po.dateIssued >= … OR po.dateCompleted IS NULL` (`queries.mjs:288-292`) at start-up, nightly and one-shot; changed-PO poll every `PURCHASING_MS` with `PURCHASING_OVERLAP_MS` look-back over `po.dateLastModified` UNION `receiptitem.dateLastModified` (`queries.mjs:295-300`; `index.mjs:335-353`; `purchasing.mjs:115-117`).
- Reads per batch: headers (`queries.mjs:258-262`), lines (`queries.mjs:264-273`), receipts with lot `LEFT JOIN trackinginfo ti ON ti.recordId = ri.id AND ti.tableId = 1259138490` (`queries.mjs:275-285`); status names once from `postatus` / `poitemstatus` (`queries.mjs:304-305`; `purchasing.mjs:120-134`).
- Written: `fb_upsert_purchasing(p_orders, p_lines, p_receipts)` → `fb_purchase_orders`, `fb_purchase_order_lines`, `fb_po_receipts`; lines and receipts no longer present get `removed_at`; stamps `last_purchasing_at` (`Docs/migrations/2026-10-15_fb_purchasing_mirror.sql:141-235`).

### 3.6 Users
- `SELECT id, userName, firstName, lastName, activeFlag FROM sysuser` (`queries.mjs:100`) → `fb_upsert_users(p_rows)` → `fb_users`, stamps `last_users_at` (`index.mjs:60-67`; `Docs/migrations/2026-08-26_fishbowl_bridge_c2.sql:23-47`). Daily; upsert only, no deletes. Passwords and MFA secrets are never read (D-FB-34).

### 3.7 Pricing read side
| Mirror | SQL | Written / stamp | Cadence and cursor |
|---|---|---|---|
| customers | `queries.mjs:139-149` (+ account groups `queries.mjs:152-153`) | `fb_upsert_customers` → `fb_customers`, `last_customers_at` (`2026-09-04_pricing_schema.sql:648-667`) | every 900 s; `dateLastModified > last_customers_at − 1 h` (`pricing.mjs:44-45`) |
| products | `queries.mjs:156-157` | `fb_upsert_products` → `fb_products`, `last_products_at` (`pricing_schema.sql:671-683`) | nightly 02:10, full read |
| part costs | `queries.mjs:175-193` | `fb_upsert_part_costs` → `fb_part_costs`; **no stamp** (`2026-09-15_D-PRICE-47_part_costs.sql:44-63`; `index.mjs:163-166`) | rides the products slot; de-duplicated in `partCosts.mjs:20-42` |
| SO history | `queries.mjs:202-214` | `fb_upsert_so_history(p_rows, p_cursor)` → `fb_so_history_lines`, `last_history_at`, `history_cursor` (`pricing_schema.sql:687-702`) | nightly 02:20, paged by `so.dateLastModified` from `history_cursor` (`pricing.mjs:83-123`) |
| product tree | `queries.mjs:221-225` | `fb_upsert_product_tree(p_nodes, p_members)`, `last_tree_at` (`2026-09-25_D-PRICE-53_fb_pricing_link_schema.sql:260-282`) | nightly, full snapshot; absent rows marked removed |
| pricing rules | `queries.mjs:234-250` | `fb_upsert_pricing_rules(p_rows)`, `last_rules_at` (`D-PRICE-53 schema:224-255`) | nightly, full snapshot |

The pricing mirrors gate with `_pricing_gate(['integration','admin'])`, not `_fb_gate` (`pricing_schema.sql:227-236`, `:652`).

### 3.8 Valuation and month-end
- `partValuation` (`queries.mjs:122-133`) → `fb_upsert_part_valuation(p_rows)` → `fb_part_valuation`, stamps `last_valuation_at`; then `fb_finish_part_valuation()` retires rows not in tonight's read using the DB clock (`valuation.mjs:55-66`; `2026-10-07_S13_A_fb_valuation_reorder.sql:52-127`). Then `inventory_snapshot_take()` decides whether a month-end snapshot is due (`index.mjs:171-185`; `skynet.mjs:117`).

---

## 4. Push queue (`src/push.mjs`, D-PRICE-53)

### 4.1 `fb_push_commands` (`Docs/migrations/2026-09-25_D-PRICE-53_fb_pricing_link_schema.sql:140-166`)
`id bigserial PK, kind text NOT NULL CHECK (kind IN ('prices','rules','tree','groups')), book_id uuid, as_of date NOT NULL DEFAULT CURRENT_DATE, status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')), dry_run boolean NOT NULL DEFAULT false, options jsonb NOT NULL DEFAULT '{}', import_name text NOT NULL, payload jsonb, row_count integer, requested_by uuid, requested_at timestamptz NOT NULL DEFAULT now(), started_at, finished_at, bridge_host text, result jsonb, error text, note text`. Index `(status, id)`. RLS on, one SELECT policy for `authenticated`; anon revoked.

### 4.2 RPCs (all `SECURITY DEFINER`, anon revoked: `D-PRICE-53 schema:1007-1011`)
| RPC | Signature | Behaviour | Source |
|---|---|---|---|
| `fb_push_next` | `(p_host text DEFAULT NULL) RETURNS jsonb` | `_fb_gate(['integration','admin'])`; returns NULL while any command has been `running` < 30 min; fails any `running` ≥ 30 min; claims the oldest `queued` with `FOR UPDATE SKIP LOCKED`, sets `running`, `started_at`, `bridge_host`; returns `{id, kind, book_id, as_of, dry_run, options, import_name, payload, row_count}` | `:169-189` |
| `fb_push_finish` | `(p_id bigint, p_ok boolean, p_result jsonb DEFAULT NULL, p_error text DEFAULT NULL) RETURNS void` | command must be `running`; `done`/`failed`, `result`, `error` (2 000 chars); stamps `fb_sync_state.last_push_at` / `last_push_kind` only for a real (non-dry) success | `:191-208` |
| `fb_push_cancel` | `(p_id bigint) RETURNS void` | `_pricing_gate(_pricing_edit_roles())`; `queued` → `cancelled` | `:210-218` |
| `fb_push_enqueue` | `(p_kind text, p_book uuid DEFAULT NULL, p_options jsonb DEFAULT '{}', p_dry_run boolean DEFAULT false, p_note text DEFAULT NULL, p_as_of date DEFAULT CURRENT_DATE) RETURNS bigint` | `_pricing_gate(['admin','integration'])`; kind must be one of the four; needs a price book; **refuses if a command of the same kind is queued or running**; builds the payload server-side from `pricing_fb_expected_*` | `:874-970` |
| `fb_push_auto` | `(p_as_of date DEFAULT CURRENT_DATE) RETURNS jsonb` | nightly; queues prices/rules when the book in effect changed since the last real push | `:975-1002` |

Bridge wrappers: `pushNext(host)`, `pushFinish(id, ok, result, error)`, `pushAuto()` (`skynet.mjs:139-143`).

### 4.3 Handler loop
`runPushCommands(fb, sky, { cfg, log, max })` (`push.mjs:40-85`): up to `max` times — claim with `pushNext` (`:43`); compute the gate (`:45-47`); resolve the imports for the kind with `importsFor(kind, cfg)` (`:48`, switch at `:15-23`); for each import, `rowsOf(payload, key)` requires a header-plus-rows array (`:33-37`), a 0-row import is skipped, a dry run logs the header and first row and sends nothing, a real one calls `fb.importRows` (`:51-64`); then `pushFinish(id, true, result)` (`:65`). On any throw: `pushFinish(id, false, result, message)` and continue (`:66-71`). After a real push the mirror it touched is re-read at once (`:72-82`).
- **Idempotency:** no SkyNet idempotency key. The guarantees are one command per kind queued/running (`fb_push_enqueue :885-887`), one command running at a time globally (`fb_push_next :176-178`), and Fishbowl imports that are idempotent by nature (README: Product Pricing by number, rules by name; `README.md:172`).
- **Retry/backoff:** none per command; a failed command stays `failed` and is re-queued by hand (`README.md:170-172`). A crash mid-command is failed by `fb_push_next` after 30 min. An exception escaping `runPushCommands` stands the executor down 15 min (`index.mjs:265-275`).
- **Fishbowl error recording:** the message (incl. Fishbowl's status and up to 1 500 chars of body from `importRows`) goes to `error`; `result` keeps `{dry_run, forced, reason, imports[], rows, host, version}` (`push.mjs:49`, `:62`, `:67-69`).
- **Flag gating:** `canPushFor(cfg)` — real only when `FB_PUSH_ENABLED` is literally `true` AND the host of `SB_URL` equals `FB_PUSH_SB_HOST` (default PROD); otherwise every claimed command is a forced dry run, finished `done` with `result.dry_run = true` (`push.mjs:6-10`, `:25-31`, `:46-47`). A command's own `dry_run` behaves the same way. Tested in `push.test.mjs:9`.
- **What a new command type needs** (Batch D: `mo_create`, `mo_issue`, `mo_note`, `mo_delete`, `inventory_add`, `inventory_scrap`): there is no dispatch table, only the `importsFor` switch. Each new kind needs (1) the `kind` CHECK widened; (2) an enqueue path — `fb_push_enqueue` cannot be reused (pricing-only kinds, needs a book, same-kind exclusivity would block a second MO, `import_name` is `NOT NULL`); (3) a handler in the bridge that does not go through `rowsOf` (which rejects a JSON object payload) and calls a new REST method on `Fishbowl`; (4) its own flag ANDed with the existing gate (`FB_MO_ENABLED`, `FB_INVADD_ENABLED`, plan D-ASM-10) and a dry-run log of the body; (5) an idempotency key column; (6) a read-back after the write. See §7 for the hazard in today's ordering.

---

## 5. Supabase conventions

### 5.1 Upsert RPCs and the gate
- Naming: `fb_upsert_<entity>(p_rows jsonb) RETURNS integer` (row count). Multi-part snapshots take one argument per part (`fb_upsert_purchasing(p_orders, p_lines, p_receipts)`, `fb_upsert_product_tree(p_nodes, p_members)`). TEST catalog lists 12 `fb_upsert_*` functions, all `SECURITY DEFINER`.
- Body pattern: `LANGUAGE plpgsql SECURITY DEFINER SET search_path = public`; first statement `PERFORM public._fb_gate(ARRAY['integration','admin'])`; validate `jsonb_typeof(p_rows) = 'array'`; `INSERT … SELECT … FROM jsonb_array_elements(p_rows)` with `DISTINCT ON` the conflict key so one statement cannot touch a row twice; `ON CONFLICT … DO UPDATE`; stamp `fb_sync_state.last_<x>_at = now()` inside the RPC; `REVOKE ALL … FROM PUBLIC` / `REVOKE EXECUTE … FROM anon`; `GRANT EXECUTE … TO authenticated, service_role` (template: `2026-10-09_D-FB-54_fb_upsert_shipment_lots.sql:30-96`).
- Payload keys are camelCase and match the bridge mapper (`shipments.mjs:21`; `purchasing.mjs:24`). The one exception is `fb_upsert_part_costs`, which reads snake_case through `jsonb_to_recordset` — a mismatched key arrives as NULL, not an error (`mapper.mjs:216-220`).
- `_fb_gate(p_roles text[])`: `SECURITY DEFINER`; NULL `auth.uid()` (SQL Editor, cron) passes; otherwise `user_has_role(uid, VARIADIC p_roles)` or `42501 Not authorized` (`2026-08-25_fishbowl_bridge_a.sql:209-228`). The pricing mirrors use the same shape under `_pricing_gate` (`2026-09-04_pricing_schema.sql:227-236`).

### 5.2 RLS on `fb_*` tables
- Convention: RLS on, **one** `FOR SELECT TO authenticated USING (true)` policy, `GRANT SELECT … TO authenticated`, `REVOKE ALL … FROM anon`, no write policies (writes only through the RPCs) (`2026-08-25_fishbowl_bridge_a.sql:180-207`; D-FB-18).
- TEST catalog, 2026-11-03: all 23 `fb_*` tables have RLS on and exactly one policy. `fb_shipment_lots` was created with no policy (`2026-10-09_kit_fb_shipment_lots_step1_schema.sql:37-40`) and given the read policy by D-FB-55 (`2026-10-15_fb_purchasing_mirror.sql:130-131`). `fb_reorder_points` is the exception, `FOR ALL TO authenticated` (`2026-10-07_S13_A_fb_valuation_reorder.sql:150`).
- Views: `WITH (security_invoker = true)`, `GRANT SELECT TO authenticated`, `REVOKE ALL FROM anon` (`2026-08-27_fishbowl_bridge_c2_2.sql:226-261`).

### 5.3 Migration files that created the bridge objects
`2026-08-25_fishbowl_bridge_a.sql` (state, users, SOs, lines, events, inventory, gate, cursor, heartbeat, ingest), `2026-08-25_fishbowl_bridge_b.sql` (disposition, convert-to-CO, ack, re-resolve, linkage), `2026-08-26_fishbowl_bridge_c1.sql` (`assembly` / `covered` dispositions, `parent_fb_soitem_id`, ingest v2), `2026-08-26_fishbowl_bridge_c2.sql` (users, inventory RPCs, recent-changes view), `2026-08-27_fishbowl_bridge_c2_2.sql` (queue view v4), `2026-09-04_pricing_schema.sql`, `2026-09-15_D-PRICE-47_part_costs.sql`, `2026-09-25_D-PRICE-53_fb_pricing_link_schema.sql`, `2026-09-30_D-FB-42_co_line_components_releases.sql`, `2026-09-30_D-FB-45_co_line_numbers_follow_fishbowl.sql`, `2026-09-30_D-FB-48_exceptions_resolve_and_wo_due_follow.sql`, `2026-10-01_D-FB-50_retire_covered_disposition.sql`, `2026-10-07_S13_A_fb_valuation_reorder.sql`, `2026-10-09_kit_fb_shipment_lots_step1_schema.sql`, `2026-10-09_D-FB-54_fb_upsert_shipment_lots.sql`, `2026-10-15_fb_purchasing_mirror.sql` (all in `Docs/migrations/`).

### 5.4 Order Queue functions and views
- `fb_set_disposition(p_line_ids integer[], p_disposition text, p_note text DEFAULT NULL, p_components jsonb DEFAULT '{}') RETURNS integer` — `_fb_gate(['order_processor','admin'])` (`2026-09-30_D-FB-42_co_line_components_releases.sql:250-322`), patched by D-FB-50 to refuse `covered` (`2026-10-01_D-FB-50_retire_covered_disposition.sql:26-52`). Client wrapper `setDisposition()` (`src/lib/fishbowl.js:368-374`).
- `fb_convert_to_co(p_fb_so_id integer, p_line_ids integer[], p_components jsonb)`, `fb_resolve_exception(p_event_id bigint, p_action text, p_note text DEFAULT NULL)` (`2026-09-30_D-FB-48…sql:196`), `fb_ack_event(p_event_id bigint)`, `fb_reresolve_lines()` (TEST catalog).
- **`fb_mark_line_covered` does not exist** (no file, not in the TEST catalog); "covered" was retired by D-FB-50.
- **There is no per-line view.** The queue reads `v_fb_order_queue` per SO (`2026-08-27_fishbowl_bridge_c2_2.sql:226-258`; `src/lib/fishbowl.js:298-307`) and `fb_sales_order_lines` directly with an embedded select (`src/lib/fishbowl.js:309-329`), plus `v_co_line_dates` and `v_co_line_component_status` for CO-linked lines (`2026-09-30_D-FB-42…sql:369`, `:400`; `src/lib/fishbowl.js:402-415`).

---

## 6. Facts for Batches A–D
Every name below exists today. Names the plan proposes that do not exist yet are listed after the table and are not facts.

| Need | Exact name | Source |
|---|---|---|
| Fishbowl read helper | `fb.query(sql)` → row array | `tools/fishbowl-bridge/src/fishbowl.mjs:73-92` |
| Fishbowl low-level request (for new REST writes) | `_call(method, path, headers, body, timeoutOverride)` | `tools/fishbowl-bridge/src/fishbowl.mjs:29-44` |
| Fishbowl write pattern to copy | `importRows(name, rows)` | `tools/fishbowl-bridge/src/fishbowl.mjs:99-115` |
| One session per cycle | `fb.withSession(fn)` | `tools/fishbowl-bridge/src/fishbowl.mjs:118-125` |
| Error class | `FishbowlError(message, status, body)` | `tools/fishbowl-bridge/src/fishbowl.mjs:6-13` |
| SkyNet RPC helper | `sky.rpc(name, args)` (3 attempts) | `tools/fishbowl-bridge/src/skynet.mjs:48-68` |
| Bridge Supabase identity | role `integration`, keys `SB_BRIDGE_EMAIL` / `SB_BRIDGE_PASSWORD` / `SB_ANON_KEY` | `tools/fishbowl-bridge/src/skynet.mjs:1-2`; `config.mjs:55-58` |
| Revision max | `q.maxRev` = `SELECT MAX(id) AS maxRev FROM revinfo` | `tools/fishbowl-bridge/src/queries.mjs:17` |
| SO revision window | `q.soRevs(from, to)` (`soitem_aud` ∪ `so_aud`) | `tools/fishbowl-bridge/src/queries.mjs:21-25` |
| Revision who/when | `q.revInfo(revs)`, `revisionMap(fb, from, to)` | `tools/fishbowl-bridge/src/queries.mjs:27`; `sync.mjs:64-75` |
| Tail cursor column | `fb_sync_state.last_rev` (+ `last_rev_at`) | `tools/fishbowl-bridge/src/index.mjs:374`; `Docs/migrations/2026-08-25_fishbowl_bridge_a.sql:43-44` |
| Cursor RPCs | `fb_get_cursor()`, `fb_set_cursor(p_rev bigint)` (forward only) | `tools/fishbowl-bridge/src/skynet.mjs:74-76`; `fishbowl_bridge_a.sql:233-260` |
| Overlap | `OVERLAP_REVS` = 200 | `tools/fishbowl-bridge/src/config.mjs:87` |
| Queue + guard pattern | `pendingShipmentSos`, `shipmentsCycleGuarded()`, `SHIPMENTS_RETRY_MS` 900 000 | `tools/fishbowl-bridge/src/index.mjs:44-48`, `:277-307` |
| Cycle insertion point | `cycle()` steps | `tools/fishbowl-bridge/src/index.mjs:421-451` |
| Lot tracking type | `LOT_TRACKING_NAME = 'Lot Number'` | `tools/fishbowl-bridge/src/shipments.mjs:17` |
| Shipped-item lot join | `trackinginfo.recordId = shipitem.id AND tableId = 1555030112` | `tools/fishbowl-bridge/src/queries.mjs:83` |
| Pick-history tableId | `-1515431424` (comment only, unused) | `tools/fishbowl-bridge/src/queries.mjs:51` |
| Receipt lot join | `tableId = 1259138490` | `tools/fishbowl-bridge/src/queries.mjs:282` |
| Local-time WHERE values | `fbDateTime(v)` (America/New_York) | `tools/fishbowl-bridge/src/mapper.mjs:164-185` |
| Number/bool/date normalisers | `ts`, `num`, `int`, `bool`, `dateOnly`, `chunk` | `tools/fishbowl-bridge/src/mapper.mjs:7-44`, `:156-160` |
| Shipment-lot mirror | `fb_shipment_lots`, PK `(fb_shipitem_id, lot_number)` | `Docs/migrations/2026-10-09_kit_fb_shipment_lots_step1_schema.sql:15-34` |
| Shipment-lot upsert | `fb_upsert_shipment_lots(p_rows jsonb) RETURNS integer`; wrapper `sky.upsertShipmentLots(rows)` | `Docs/migrations/2026-10-09_D-FB-54_fb_upsert_shipment_lots.sql:30-92`; `tools/fishbowl-bridge/src/skynet.mjs:104` |
| Shipment-lot payload keys | `shipItemId … trackingName` | `tools/fishbowl-bridge/src/shipments.mjs:22-42` |
| Gate | `_fb_gate(p_roles text[])` | `Docs/migrations/2026-08-25_fishbowl_bridge_a.sql:212-228` |
| Existing stamps | `last_rev_at, last_heartbeat_at, last_backfill_at, last_reconcile_at, last_inventory_at, last_users_at, last_customers_at, last_products_at, last_history_at, history_cursor, last_rules_at, last_tree_at, last_push_at, last_push_kind, last_valuation_at, last_shipments_at, last_purchasing_at` | TEST catalog; added in `fishbowl_bridge_a.sql:41-54`, `fishbowl_bridge_c2.sql:18`, `pricing_schema.sql:208-211`, `D-PRICE-53 schema:115-119`, `S13_A…sql:15`, `D-FB-54…sql:28`, `fb_purchasing_mirror.sql:133` |
| Heartbeat | `fb_heartbeat(p_state jsonb)`; wrapper `sky.heartbeat(state)` | `fishbowl_bridge_a.sql:262-277`; `tools/fishbowl-bridge/src/skynet.mjs:72` |
| Push table | `fb_push_commands` (columns §4.1) | `Docs/migrations/2026-09-25_D-PRICE-53_fb_pricing_link_schema.sql:140-158` |
| Push RPCs | `fb_push_next(p_host)`, `fb_push_finish(p_id, p_ok, p_result, p_error)`, `fb_push_cancel(p_id)`, `fb_push_enqueue(p_kind, p_book, p_options, p_dry_run, p_note, p_as_of)`, `fb_push_auto(p_as_of)` | `Docs/migrations/2026-09-25_D-PRICE-53_fb_pricing_link_schema.sql:169`, `:191`, `:210`, `:874`, `:975`; wrappers `tools/fishbowl-bridge/src/skynet.mjs:139-143` |
| Push bridge functions | `runPushCommands`, `importsFor`, `canPushFor`, `rowsOf` | `tools/fishbowl-bridge/src/push.mjs:15-85` |
| Push flags | `FB_PUSH_ENABLED` → `config.push.enabled`; `FB_PUSH_SB_HOST` → `config.push.allowedSbHost` | `tools/fishbowl-bridge/src/config.mjs:96-102` |
| Disposition RPC | `fb_set_disposition(p_line_ids integer[], p_disposition text, p_note text, p_components jsonb)`; hand-settable: `pending, stock, purchased, assembly, ignore` | `D-FB-42…sql:252`; `D-FB-50…sql:40-43`; `src/lib/fishbowl.js:117-123` |
| Disposition CHECK | `pending, production, stock, purchased, covered, assembly, kit_header, ignore, unlisted` | `Docs/migrations/2026-08-26_fishbowl_bridge_c1.sql:31-32` |
| Kit parent column | `fb_sales_order_lines.parent_fb_soitem_id` (from payload `parentId`) | `fishbowl_bridge_c1.sql:13`, `:596`; `tools/fishbowl-bridge/src/mapper.mjs:103` |
| Queue view | `v_fb_order_queue` | `Docs/migrations/2026-08-27_fishbowl_bridge_c2_2.sql:226-258`; `src/lib/fishbowl.js:298-307` |
| Service / path / logs | `SkyNetFishbowlBridge`, `D:\SkyNetBridge`, `logs\bridge-YYYY-MM-DD.log` | `tools/fishbowl-bridge/scripts/install-service.ps1:4`; `Docs/FB1_Cutover_Runbook.md:92`; `tools/fishbowl-bridge/src/skynet.mjs:14` |
| Version constant | `config.version = '1.10.0'`, `package.json` `"version": "1.10.0"` | `tools/fishbowl-bridge/src/config.mjs:39`; `tools/fishbowl-bridge/package.json:3` |

**Plan names that do not exist yet** (S17 plan §7.1, §9.1, §9.4 — new, not facts): `fb_pick_items`, `fb_shipments`, `fb_ship_cartons`, `fb_ship_items`, `fb_postings`, `fb_posting_items`, `fb_tags`, `fb_boms`, `fb_bom_items`, `fb_bom_instructions`, `fb_manufacture_orders`, `fb_mo_items`, `fb_work_orders`, `fb_wo_items`, `fb_wo_consumed_lots`, views `v_fb_line_pick_state` / `v_fb_line_ship_state`, push kinds `mo_create` / `mo_issue` / `mo_note` / `mo_delete` / `inventory_add` / `inventory_scrap`, keys `FB_MO_ENABLED` / `FB_INVADD_ENABLED` / `FB_MO_DRY_RUN`.

---

## 7. Surprises and risks

1. **The tail is SO-only with one cursor.** The audited-table set is one hard-coded SQL statement (`queries.mjs:21-25`), and `last_rev` advances inside `fb_ingest_delta`'s SO ingest (`c1.sql:707-711`). Adding ten-plus audited tables is a new code path per family, and any family read after the SO ingest commits can lose its window on failure. *Recommendation (Batch A, the one refactor that pays):* an audit-tail module with a small registry (`{ auditTables, idQuery, fetch, upsert, stamp }`) and one cursor column per family (for example a `last_<family>_rev`), each advanced by that family's upsert RPC — or, at minimum, collect every family's ids for the window before `ingestIds` runs.
2. **Push dispatch can stall on an unknown kind.** `importsFor(cmd.kind)` runs before the `try` (`push.mjs:48` vs `:50`), so a kind the bridge does not know throws out of `runPushCommands`: the executor stands down 15 min and the claimed command stays `running` until `fb_push_next` fails it after 30 min. If Batch D's SQL ships a new kind before the bridge that handles it, pricing pushes stall too. *Recommendation:* a dispatch table keyed by kind, resolved inside the `try`, finishing unknown kinds as `failed` with a clear error.
3. **The queue is pricing-shaped.** `kind` CHECK (`D-PRICE-53 schema:141`), `import_name NOT NULL` (`:147`), `fb_push_enqueue` (pricing kinds, needs a book, one-per-kind exclusivity, `:874-887`) and `rowsOf` (header-plus-rows only, `push.mjs:33-37`) all need generalising for MO and inventory commands; there is no idempotency-key column (D-ASM-10 needs one). One command runs at a time across all kinds (`fb_push_next :176-178`), so a 5-minute pricing import delays MO writes.
4. **Real pushes are PROD-only by construction** (`canPushFor`, `push.mjs:25-31`). Batch D's write tests can only be real on PROD (consistent with D-ASM-11); TEST exercises the forced dry run.
5. **Plan §7.1 says the new mirrors are "RLS on / no policies".** The actual convention is RLS on with one SELECT policy for `authenticated` (TEST: 23 of 23 `fb_*` tables). The Order Queue reads `fb_*` tables from the browser as `authenticated` (`src/lib/fishbowl.js:320-329`), so "no policies" would hide the new rows from the UI. Follow the existing convention.
6. **Repo files are not the current source of two functions.** `fb_ingest_delta` was patched in place by D-FB-45 and D-FB-48 with md5 guards (`2026-09-30_D-FB-45…sql:353-390`; `2026-09-30_D-FB-48…sql:334-361`), and `fb_set_disposition` by D-FB-50 with text anchors (`2026-10-01_D-FB-50…sql:26-52`; its header notes PROD and TEST differ in line endings, `:14-16`). TEST's `fb_ingest_delta` carries both markers, md5 `8794ae0ba1d23df9814465ad47991612` (TEST catalog). Any Batch A change to either function must start from `pg_get_functiondef` on the target, not from `c1.sql`.
7. **Sub-poller failures are invisible on the banner.** Only unguarded failures reach `last_error`, and the next good heartbeat clears it (`fishbowl_bridge_a.sql:272`). Batch A's new pollers should stamp their own clocks and the banner should read them (already flagged as D-PRICE-49 follow-up (4), `Docs/Decisions.md:3820`).
8. **Inventory, users, reconcile and tail are unguarded** (`index.mjs:424-437`): one failure skips shipments, purchasing, pricing and push for that cycle. New Batch A pollers should use the guarded pattern.
9. **`fb_shipment_lots` never deletes.** A shipment item removed in Fishbowl keeps its last row (§3.4). Batch D's ship-lot gate should read `ship_status = 'Shipped'` and treat absence of a fresh read as unknown.
10. **Cycle length.** All readers run serially in one Fishbowl session; Batch A adds roughly ten audited tables plus `tag` and `postso`. A long cycle simply slows the 20 s cadence (`index.mjs:593-594`); measure cycle time on the PC-against-TEST run before deploy.
11. **Names in the Batch 0 prompt that do not exist:** `fb_mark_line_covered` (§5.4); a "Supabase service key" for the bridge (§1.5); a `/health` endpoint (§1.4).
12. **Dead code / TODO:** `q.statusOf` is never called (`queries.mjs:309`); `void chunk` import guard (`rulesTree.mjs:78-79`); the part-costs query still carries "TWO UNVERIFIED ASSUMPTIONS" (`po.statusId = 70` is Void; `part.defaultProductId` exists) (`queries.mjs:163-168`) — the query has run nightly since 1.4.0, which settles the second, not the first.
13. **Stale wording:** the Integrated App description still says "sales order sync (read-only)" (`config.mjs:48`) and the service description "read-only against Fishbowl" (`install-service.ps1:19`), though the bridge writes through the push queue since 1.7. README's Windows-service section documents `nssm` (`README.md:153-156`) while skyserver is run with `sc` (`Decisions.md:3828`).
14. **Kit membership has two rules.** The SO ingest tags kit children with `kitItemTypeId 10` positionally (`sync.mjs:12`; `mapper.mjs:111-132`); the shipments query accepts any `kititem` row, contiguous under the header (`queries.mjs:57-69`; D-FB-54). Batch A's `objecttoobject` link (plan §6) supersedes both for SO lines.
15. **D-FB-56 is not in `Docs/Decisions.md`.** It appears only in `Docs/SkyNet_Scheduling_Context_2026-10-28.md:270` as "not in `main` as of Oct 28". D-FB-57 is therefore appended after D-FB-55, the last D-FB entry in the file.
