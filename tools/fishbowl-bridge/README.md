# SkyNet Fishbowl Bridge

Mirrors Fishbowl Advanced sales orders (Issued + In Progress) into SkyNet's `fb_*` tables and keeps them current.
Read-only against Fishbowl (login / data-query / logout only). Writes to SkyNet only through the `fb_*` RPCs,
signed in as the `integration` profile with the anon key — no service-role key anywhere on the plant network.

Design: `Docs/Implementation_Plans/FB1_Implementation_Plan.md`. Decisions: `Docs/Decisions.md` (D-FB-*).

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

## Setup (dev PC against TEST, or the Fishbowl server against PROD)
1. `cd tools/fishbowl-bridge && npm install`
2. Copy `.env.example` to `.env` and fill in `FB_PASS`, `SB_ANON_KEY`, `SB_BRIDGE_PASSWORD` (and `SB_URL` for PROD).
3. First run only: `npm run backfill` — loads every Issued / In Progress SO, sets the cursor, links the COs that
   were created by hand (prints a linkage report).
4. Smoke test: `npm run once` (one tail + one reconcile, then exits). Then `npm start`.

## Windows service (Fishbowl server)
Install NSSM (https://nssm.cc) and Node.js >= 18, then as Administrator:
`powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1`
Manage: `nssm status|stop|start|restart SkyNetFishbowlBridge`. Logs: `logs\bridge-YYYY-MM-DD.log` (+ service-stdout/stderr).

## Operations
- Bridge stopped? The Order Queue banner turns amber after 2 min and red after 10 min. Restart the service; the
  tail resumes from the stored cursor and the reconciler covers anything missed.
- Re-run the backfill any time: it is idempotent (`npm run backfill`).
- Reset the cursor (rare): `SELECT public.fb_set_cursor(<rev>)` in the SQL Editor — it only moves forward.
- Seat usage: if Fishbowl shows the bridge consuming a user seat, set `SESSION_MODE=per_cycle` and restart.
- Never point two bridges at the same Supabase project; one per project (TEST, PROD) is fine.
