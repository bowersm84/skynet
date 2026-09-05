# SkyNet Fishbowl Bridge

Mirrors Fishbowl Advanced sales orders (Issued + In Progress) into SkyNet's `fb_*` tables and keeps them current,
and since v1.3 also mirrors the customer master, the product list and the SO history the Pricing Portal reads.
Read-only against Fishbowl (login / data-query / logout only). Writes to SkyNet only through the `fb_*` RPCs,
signed in as the `integration` profile with the anon key — no service-role key anywhere on the plant network.

Design: `Docs/Implementation_Plans/FB1_Implementation_Plan.md` and `S11_Implementation_Plan.md` §7.
Field-level notes on what Fishbowl gives us: `Docs/Fishbowl_Data_Context.md`.
Decisions: `Docs/Decisions.md` (D-FB-*, D-PRICE-19/20/26).

## How it works
- Every `POLL_MS` (20 s): read `MAX(revinfo.id)`; for revisions above the stored cursor (minus a 200-revision overlap),
  collect the SO ids touched in `soitem_aud` / `so_aud`, refetch those SOs in full, and post them to `fb_ingest_delta`.
  The RPC upserts by fingerprint, marks lines missing from the payload as removed, writes `fb_sync_events`, and
  advances the cursor only when the last chunk of a window lands.
- Every `RECONCILE_MS` (15 min): compare Fishbowl's open SOs with the mirror's open SOs and refetch any that differ.
- Every `INVENTORY_MS` (5 min): on-hand / allocated / available per part for every part on an open SO line, from
  `qtyinventorytotals` summed per location group; `AVAILABLE_LOCATION_GROUPS` decides which groups count as
  available (default Main + Warehouse). Shown as the "Avail" column in the Order Queue.
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
| so_history | nightly at `HISTORY_NIGHTLY_AT` (02:20 local) | `soitem` ⋈ `so` product lines (`typeId` 10/30), every status but Estimate (10), Voided (80), Cancelled (85) and Expired (90), paged 2,000 rows at a time from `fb_sync_state.history_cursor` (`HISTORY_BACKFILL_FROM` when there is none) | `fb_upsert_so_history` → `fb_so_history_lines`, each page carrying its own `dateLastModified` as the new cursor |

Nightly means "today's HH:MM has passed and the last run was before it", read from `fb_sync_state` — so a restart
cannot double-run a nightly job, and a bridge that was down at 02:20 catches up when it comes back.
`paymentterms` and `accountgroup` are the two table names not confirmed on 25.9: if either read fails the poller
logs one warning and carries on without that column for the life of the process, rather than guessing names. A poll that finds nothing to do still calls its RPC with an empty payload, so the three ages on /pricing mean "last polled", not "last time anything changed". A pricing failure never stops the SO tail: it is logged and the pollers stand down for 15 minutes.

## Setup (dev PC against TEST, or the Fishbowl server against PROD)
1. `cd tools/fishbowl-bridge && npm install`
2. Copy `.env.example` to `.env` and fill in `FB_PASS`, `SB_ANON_KEY`, `SB_BRIDGE_PASSWORD` (and `SB_URL` for PROD).
3. First run only: `npm run backfill` — loads every Issued / In Progress SO, sets the cursor, links the COs that
   were created by hand (prints a linkage report).
4. First run only, after the pricing schema is applied: `npm run backfill:pricing` (`node src/index.mjs --backfill`)
   — one full customers + products + SO history load from scratch, then exits. Expect ≈ 6.5k customers,
   10,980 products and ≈ 35k history lines over ~20 pages. Idempotent, safe to re-run.
5. Smoke test: `npm run once` (one tail + one reconcile, then exits). Then `npm start`.

## Windows service (Fishbowl server)
Install NSSM (https://nssm.cc) and Node.js >= 18, then as Administrator:
`powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1`
Manage: `nssm status|stop|start|restart SkyNetFishbowlBridge`. Logs: `logs\bridge-YYYY-MM-DD.log` (+ service-stdout/stderr).

## Operations
- Bridge stopped? The Order Queue banner turns amber after 2 min and red after 10 min. Restart the service; the
  tail resumes from the stored cursor and the reconciler covers anything missed.
- Re-run either backfill any time: both are idempotent (`npm run backfill`, `npm run backfill:pricing`).
- Pricing mirror stale? Check `SELECT last_customers_at, last_products_at, last_history_at, history_cursor FROM fb_sync_state;`.
  Re-reading history from a date is `UPDATE fb_sync_state SET history_cursor = '<date>' WHERE id = 1;` then wait for
  02:20, or run `npm run backfill:pricing` for a full reload.
- Reset the cursor (rare): `SELECT public.fb_set_cursor(<rev>)` in the SQL Editor — it only moves forward.
- Seat usage: if Fishbowl shows the bridge consuming a user seat, set `SESSION_MODE=per_cycle` and restart.
- Never point two bridges at the same Supabase project; one per project (TEST, PROD) is fine.
