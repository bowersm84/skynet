# FB1 Batch D — PROD Cutover Runbook

**Fishbowl Bridge + Order Queue → skynet.skybolt.com**
Runbook v1.0 · August 27, 2026 · Owner: Matt Bowers

Order matters: database first (harmless without code), then the bridge (fills the mirror), then the code (needs both), then people. Every step has a check; do not start the next step until the check passes. Nothing here touches Fishbowl except reading it and voiding your test SO at the end.

Prerequisites already confirmed: admin login on `skyserver` (Windows Server 2025); outbound 443 to `*.supabase.co` from the server; `skynet-bridge` Fishbowl user + Integrated App accepted; `hold` session mode proven (nobody refused a Fishbowl login since Aug 24).

---

## D1 · PROD database (Supabase SQL Editor, project `luzungoqfuplspzbqctb`) — ≈ 20 min

Run the five migration files **in this order**, one paste each, and confirm each verify row before the next:

| # | File (Docs/migrations/) | Expected verify row |
|---|---|---|
| 1 | `2026-08-25_fishbowl_bridge_a.sql` | `fb_tables 6 · fb_policies 6 · fb_functions 6 · roles_ok true · role_checks 1 · co_line_cols 3 · last_rev 0` |
| 2 | `2026-08-25_fishbowl_bridge_b.sql` | `covered_ok true · fb_functions_b 5 · view_cols 3 · reresolved_now 0 · open_orders 0` (0 — nothing mirrored yet) |
| 3 | `2026-08-26_fishbowl_bridge_c1.sql` | `parent_col 1 · assembly_ok true · convert_overloads 1 · convert_signature p_fb_so_id integer, p_line_ids integer[], p_components jsonb · view_col 1` |
| 4 | `2026-08-26_fishbowl_bridge_c2.sql` | `inv_cols 3 · state_col 1 · fb_functions_c2 2 · view_ok 1` |
| 5 | `2026-08-27_fishbowl_bridge_c2_2.sql` | `view_col 1 · pending_lines_now null · shipped_lines_open_sos null · queue_count 0` |

Preflight (read-only) before #1, same as TEST — expect `user_has_role(uuid,text[])` and PG ≥ 15:

```sql
SELECT
  (SELECT string_agg(conname || ': ' || pg_get_constraintdef(oid), ' | ')
     FROM pg_constraint WHERE conrelid = 'public.profiles'::regclass AND contype = 'c')      AS profile_checks,
  (SELECT string_agg(oid::regprocedure::text, ' | ') FROM pg_proc WHERE proname = 'user_has_role') AS user_has_role_sig,
  current_setting('server_version')                                                          AS pg_version;
```

## D2 · Bridge identity on PROD — ≈ 5 min

1. Dashboard (PROD) → Authentication → Users → Add user → *Create new user*: `fishbowl-bridge@skybolt.com`, a **new** strong password (do not reuse TEST's), **Auto Confirm User** on.
2. SQL Editor:

```sql
INSERT INTO public.profiles (id, email, full_name, role, is_active, must_change_password)
SELECT id, email, 'Fishbowl Bridge', 'integration', true, false
  FROM auth.users WHERE email = 'fishbowl-bridge@skybolt.com'
ON CONFLICT (id) DO UPDATE
   SET role = 'integration', full_name = 'Fishbowl Bridge', is_active = true, must_change_password = false;
```

Check: `select username, role, is_active from profiles where email = 'fishbowl-bridge@skybolt.com';` → `integration · true`.

## D3 · PROD data fixes — ≈ 5 min

**a. Parts master typo** (found by the TEST linkage, D-FB closeout). Preview, then fix:

```sql
select id, part_number, part_type, is_active from parts where part_number in ('SK2500-55W','SK2500-5SW');
```
Expect exactly one row, `SK2500-55W`. Then:
```sql
begin;
update parts set part_number = 'SK2500-5SW' where part_number = 'SK2500-55W';
select part_number from parts where part_number in ('SK2500-55W','SK2500-5SW');
commit;
```

**b. Ashley's add-on role** (Armory → Users → Additional Roles → Order Processor once the code is live, or now by SQL):

```sql
update profiles set roles = array_append(roles, 'order_processor')
 where username = 'ahall' and not ('order_processor' = any(roles))
returning username, role, roles;
```

## D4 · Bridge on the Fishbowl server — ≈ 45 min

All on `skyserver`, logged in as `admin`, Command Prompt (Admin).

**a. Node.js.** In a browser on the server: https://nodejs.org → download the **Windows Installer (.msi), 64-bit, LTS** → run it, defaults throughout (leave "Tools for Native Modules" unchecked). Open a **new** Command Prompt (Admin):

```
node -v
npm -v
```
Expect `v22.x` (or newer) and an npm version.

**b. Bridge files.** On **your PC** (repo root, `feature/fishbowl-bridge` fully committed), build a clean bundle — no `node_modules`, no `.env`, no logs:

```powershell
Compress-Archive -Force -DestinationPath "$env:USERPROFILE\Desktop\SkyNetBridge.zip" -Path `
  tools\fishbowl-bridge\package.json, tools\fishbowl-bridge\package-lock.json, tools\fishbowl-bridge\README.md, `
  tools\fishbowl-bridge\.env.example, tools\fishbowl-bridge\src, tools\fishbowl-bridge\scripts
```

Copy `SkyNetBridge.zip` to the server (Remote Desktop clipboard/drag works), extract to **`D:\SkyNetBridge`** so that `D:\SkyNetBridge\package.json` exists. Then, on the server:

```
cd /d D:\SkyNetBridge
npm install --omit=dev
node --check src\index.mjs
```
Expect `added N packages … 0 vulnerabilities` and no output from `--check`.

**c. `.env` for PROD.** `notepad D:\SkyNetBridge\.env` (save as *All Files*, name exactly `.env`; UTF-8 or Notepad's default both work):

```
FB_HOST=192.168.1.251
FB_PORT=2456
FB_USER=skynet-bridge
FB_PASS=<Fishbowl skynet-bridge password>
FB_APP_ID=4350
SESSION_MODE=hold

SB_URL=https://luzungoqfuplspzbqctb.supabase.co
SB_ANON_KEY=<PROD anon key — Supabase Dashboard → Project Settings → API → anon public>
SB_BRIDGE_EMAIL=fishbowl-bridge@skybolt.com
SB_BRIDGE_PASSWORD=<password from D2>

POLL_MS=20000
RECONCILE_MS=900000
INVENTORY_MS=300000
USERS_MS=86400000
OVERLAP_REVS=200
CHUNK=50
AVAILABLE_LOCATION_GROUPS=1,6
```

`FB_HOST` can stay as the LAN address even though the bridge now runs on that machine.

**d. Backfill PROD** (one-shot, idempotent):

```
npm run backfill
```
Expect `backfill: N open SO(s)` (≈ 145–150), three chunks, `cursor set`, the **linkage report JSON** (copy it — it is April's cleanup list, D6), `backfill complete`. Then a smoke run:

```
npm run once
```
Expect `cursor loaded`, `users: … upserted`, `inventory: … upserted`, `bridge stopped`, no ERROR lines.

**e. Windows service.** Download https://nssm.cc/release/nssm-2.24.zip on the server, extract, copy `win64\nssm.exe` to `D:\SkyNetBridge\nssm.exe`. Then:

```
powershell -ExecutionPolicy Bypass -File D:\SkyNetBridge\scripts\install-service.ps1 -Nssm D:\SkyNetBridge\nssm.exe
D:\SkyNetBridge\nssm.exe status SkyNetFishbowlBridge
```
Expect `Installed and started SkyNetFishbowlBridge` and `SERVICE_RUNNING`. If PowerShell is blocked by policy, the equivalent plain commands are:

```
D:\SkyNetBridge\nssm.exe install SkyNetFishbowlBridge "C:\Program Files\nodejs\node.exe" "D:\SkyNetBridge\src\index.mjs"
D:\SkyNetBridge\nssm.exe set SkyNetFishbowlBridge AppDirectory D:\SkyNetBridge
D:\SkyNetBridge\nssm.exe set SkyNetFishbowlBridge AppStdout D:\SkyNetBridge\logs\service-stdout.log
D:\SkyNetBridge\nssm.exe set SkyNetFishbowlBridge AppStderr D:\SkyNetBridge\logs\service-stderr.log
D:\SkyNetBridge\nssm.exe set SkyNetFishbowlBridge AppRotateFiles 1
D:\SkyNetBridge\nssm.exe set SkyNetFishbowlBridge AppRotateBytes 10485760
D:\SkyNetBridge\nssm.exe set SkyNetFishbowlBridge AppExit Default Restart
D:\SkyNetBridge\nssm.exe set SkyNetFishbowlBridge Start SERVICE_AUTO_START
D:\SkyNetBridge\nssm.exe start SkyNetFishbowlBridge
```

Check in PROD SQL: `select last_rev, last_heartbeat_at, now() - last_heartbeat_at as age, bridge_version, bridge_host, last_error from fb_sync_state;` → age under 20 s, `1.2.0`, host `skyserver`, no error.

**f. Reboot test** (do this once, after hours or with warning): restart the server → after it is back, the same query shows a fresh heartbeat without anyone touching it. If not, `nssm status` and the two log files in `D:\SkyNetBridge\logs\`.

## D5 · Code to PROD — ≈ 15 min

Only after D4's heartbeat is green. On your PC:

```powershell
git checkout main
git pull
git merge --ff-only feature/fishbowl-bridge
git push origin main
```

Amplify builds PROD. Then on https://skynet.skybolt.com as admin: **Order Queue** in the nav → banner green (`bridge v1.2.0 on skyserver`) → Queue / All Open counts match PROD Fishbowl → expand one SO: kit tree, Avail column, dispositions. Customer Orders → FB chips on the linked manual COs, sync banner. If the page shows *Not authorized* on any action while logged in as admin, stop and send me the message.

## D6 · April's cleanup list — ≈ 30 min of April's time

From the D4 backfill report (or re-run any time: `select public.fb_link_existing_cos();`):

- `unmatched_open_cos` — SkyNet COs still open whose Fishbowl SO is no longer Issued/In Progress. Get their Fishbowl status (Data module, one statement):
  `SELECT num, statusId, dateCompleted FROM so WHERE num IN ('…','…') ORDER BY num`
  Fulfilled (60) / Closed Short (70) → close the SkyNet CO (Customer Orders → Mark complete / Cancel as appropriate). Status 10 → the SO was never issued: issue it or cancel the CO. Missing from the result → the CO's Fishbowl Order ID is a typo: Edit CO → correct it → the linker picks it up within a day (or re-run it).
- `ambiguous` — review as on TEST (same part twice on an SO; the linker matched by quantity, then due date).
- `co_lines_without_fb_line` — the CO line's part isn't on the SO (TEST found AC48 vs AC58) — check against the customer PO.

Also void **SO 18750** (the callie jon braun test order) in Fishbowl; the bridge marks it dead and nothing in PROD references it.

## D7 · Watch for 48 hours

- Order Queue banner stays green; `fb_sync_state.last_error` stays null (`select last_error, last_error_at from fb_sync_state;`).
- Exceptions tab: anything appearing is a real Fishbowl change on a converted line — Ashley handles per the tab.
- Ashley's first real day: dispositions and at least one Create CO on a live order → CO in Demand → WO scheduled without CS re-keying.
- TEST bridge on your PC can keep running against TEST for development; two bridges reading Fishbowl is fine. Stop it whenever you don't need TEST live.

## D8 · Closeout (after the 48 h)

Send me: the D4 backfill log + linkage report, the D5 screenshots, and any exceptions from D7. I then deliver: Spec v4.4 (Fishbowl Bridge & Order Queue section, Customer Orders / Customers updates), the Decisions.md FB1 closeout entry (CC), the cheat-sheet ops section (service name, log paths, restart, backfill re-run, cursor reset, `.env` keys), the FB1 test script `.docx` (T-01…T-22 as executed), and the plan renamed `FB1_Implementation_Plan_CLOSED.md`.

---

### If something goes wrong

| Symptom | Do |
|---|---|
| Migration verify row off | Stop; send me the row and the error. Migrations are idempotent — re-running after a fix is safe. |
| `Supabase sign-in failed` in the bridge log | D2 password / email mismatch in `.env`, or the user isn't auto-confirmed. |
| `Fishbowl login failed (401)` | `FB_USER` must be `skynet-bridge` (hyphen); password case-sensitive; app must still be Accepted in Setup → Settings → Integrated Apps. |
| `rpc … rejected: 42501` | The profile isn't `integration` — re-run D2's SQL. |
| Banner amber/red after cutover | `nssm status SkyNetFishbowlBridge`, then `D:\SkyNetBridge\logs\service-stderr.log`. Restart with `nssm restart SkyNetFishbowlBridge`. |
| Someone refused a Fishbowl login ("maximum users") | `.env`: `SESSION_MODE=per_cycle`, then `nssm restart SkyNetFishbowlBridge`. |
| Need to reload everything | `cd /d D:\SkyNetBridge && npm run backfill` — idempotent, no events emitted. |
