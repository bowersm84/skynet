# Bridge 1.11.0 — install on skyserver (PROD)

**For:** Matt · **Sprint:** S17 Batch A1 · **Decisions:** D-ASM-23, D-FB-58, D-FB-59 · **Date:** 2026-11-04

Bridge 1.11 adds the Assembly read side: the picks, ships, MOs and BOMs families (each on its own cursor), the tags
and postings pollers, the hourly tag sweep and nightly BOM sweep, guards on every poller (with error entries that
clear on recovery), kit links from `objecttoobject`, and the push-dispatch hardening (D-FB-58…62). The SO tail,
`last_rev` and `fb_ingest_delta` are unchanged.

**Order matters:** both PROD migrations (A1, then A1b) go in **before** the new bridge. 1.11 calls RPCs that only
the migrations create; 1.10 ignores the new tables and functions, so running them first is safe with 1.10 still
running.

Every command below is for an **elevated Windows PowerShell 5.1** window, pasted one line at a time. Use `sc.exe`,
never `sc` (in PowerShell `sc` means `Set-Content`).

---

## On Matt's PC

1. Build the bundle (after the A1 commit is on `main`). This prints the zip's path and its SHA256; keep the hash:
   ```
   powershell -ExecutionPolicy Bypass -File C:\Users\mabow\skynet_vs\tools\fishbowl-bridge\scripts\package.ps1
   ```
   The zip is `SkyNetBridge-1.11.0.zip` on the Desktop: `package.json`, `package-lock.json`, `README.md`,
   `.env.example`, `src\`, `scripts\`. No `node_modules`, `.env` or `logs`.
2. Copy the zip to skyserver over Remote Desktop, to `D:\SkyNetBridge-1.11.0.zip`.

## In Supabase PROD (SQL Editor)

3. Run `Docs/migrations/2026-11-04_S17_A1_fb_pick_ship_post_tags_boms_mo.sql` (the whole file; it is idempotent),
   then `Docs/migrations/2026-11-04_S17_A1b_fb_family_ok.sql`. Check:
   ```sql
   select fb_get_family_cursors();
   select proname from pg_proc where proname in ('fb_family_error', 'fb_family_ok') order by 1;
   ```
   → a JSON object with `picks`, `ships`, `mos`, `boms` all `null` and `so` = the current `last_rev`; then two rows,
   `fb_family_error` and `fb_family_ok`.

## On skyserver (elevated PowerShell)

4. Check the copy arrived intact — the hash must match step 1:
   ```
   Get-FileHash -Algorithm SHA256 D:\SkyNetBridge-1.11.0.zip
   ```
5. Stop the service, then repeat the query until it says `STOPPED` (the bridge finishes its cycle first):
   ```
   sc.exe stop SkyNetFishbowlBridge
   sc.exe query SkyNetFishbowlBridge
   ```
6. Back up the running folder (robocopy's exit code 1 means "files copied", which is success):
   ```
   robocopy D:\SkyNetBridge "D:\SkyNetBridge_v1.10.0_$(Get-Date -Format yyyy-MM-dd)" /E
   ```
7. Unzip 1.11.0 over the folder. `.env`, `logs` and `nssm.exe` are not in the zip, so they stay as they are — the
   existing `.env` carries forward unchanged:
   ```
   tar -xf D:\SkyNetBridge-1.11.0.zip -C D:\SkyNetBridge
   Test-Path D:\SkyNetBridge\.env
   Select-String -Path D:\SkyNetBridge\src\config.mjs -Pattern "version: '1.11.0'"
   ```
   → `True`, and one matching line.
8. Install dependencies (none changed in 1.11; this is the standard step) and check the entry point parses:
   ```
   Set-Location D:\SkyNetBridge
   npm install --omit=dev
   node --check src\index.mjs
   ```
   → `node --check` prints nothing.
9. Add the four new keys to `.env`. They are optional (these are the defaults), but writing them down makes the
   settings visible. Open the file in Notepad, check none of the four is already there (the **first** occurrence
   of a key wins), add the lines at the end, and save:
   ```
   notepad D:\SkyNetBridge\.env
   ```
   ```
   FB_TAGS_INTERVAL_MS=300000
   FB_TAGS_SWEEP_INTERVAL_MS=3600000
   FB_POSTINGS_INTERVAL_MS=300000
   FB_SWEEP_HOUR=2
   ```
10. Start the service:
    ```
    sc.exe start SkyNetFishbowlBridge
    sc.exe query SkyNetFishbowlBridge
    ```
    → `RUNNING`.

## Confirm (a minute after the start)

11. The log shows the start banner, the first-run backfills, and one cycle line per cycle:
    ```
    Get-ChildItem D:\SkyNetBridge\logs\bridge-*.log | Sort-Object LastWriteTime | Select-Object -Last 1 | Get-Content -Tail 60
    Select-String -Path D:\SkyNetBridge\logs\bridge-*.log -Pattern 'bridge 1.11.0 cycle' | Select-Object -Last 3
    ```
    Expect, in order: `SkyNet Fishbowl Bridge v1.11.0 starting on <skyserver's host name> …`; then once each,
    `picks: first run on this database — …`, `ships: first run …`, `mos: first run …`, `boms: first run …`,
    `tags: sweep · scope … part(s) · … tag(s) read …`, `postings: first load (180 days) …`; then every cycle
    `bridge 1.11.0 cycle: cycleMs=… max_rev=… so=… picks=… ships=… mos=… boms=… tags=… postings=…`.
    On the PC-against-TEST run (2026-11-03): the four family backfills took about 8 s together (picks 99 picks /
    1,078 lines, ships 1,786, MOs 1,182, BOMs 2,280); a first cycle that also swept tags (2,832), loaded postings
    (1,802) and ran the pricing nightly slot took 28.3 s; ordinary cycles took 0.6–2.5 s, and a 2,000-revision window
    (picks 199, ships 69, MOs 80, BOMs 6) 1.1 s. A `… failed, retrying in …` line names the step and stands only that
    step down.
12. In PROD SQL:
    ```sql
    select bridge_version, bridge_host, now() - last_heartbeat_at as age, last_error,
           last_rev, last_picks_rev, last_ships_rev, last_mos_rev, last_boms_rev,
           last_tags_at, last_postings_at, last_boms_sweep_at, last_tags_sweep_at, family_errors
    from fb_sync_state where id = 1;
    ```
    → `bridge_version = '1.11.0'`, `bridge_host` = skyserver's host name, age under 20 s, `last_error` null, the four family cursors set
    and within a few hundred of `last_rev`, `last_tags_at` / `last_postings_at` recent, `family_errors = {}`.
13. Spot checks (the same as TEST's VERIFY):
    ```sql
    select count(*) from fb_pick_items where removed_at is null;
    select signal, count(*) from v_fb_line_pick_state group by 1 order by 2 desc;
    select * from v_fb_line_ship_state where fb_soitem_id in (108409, 108410, 108411);
    select part_num, tag_num, lot_number, qty, location from fb_tags where part_num = 'SK4C5P' and removed_at is null order by tag_created;
    ```

## Rollback

14. If 1.11 misbehaves: stop the service, move the 1.11 folder aside, put the backup back, start. The A1 and A1b
    migrations stay (1.10 ignores both).
    ```
    sc.exe stop SkyNetFishbowlBridge
    sc.exe query SkyNetFishbowlBridge
    Rename-Item D:\SkyNetBridge D:\SkyNetBridge_v1.11.0_failed
    Rename-Item "D:\SkyNetBridge_v1.10.0_$(Get-Date -Format yyyy-MM-dd)" D:\SkyNetBridge
    sc.exe start SkyNetFishbowlBridge
    ```
    (If the rollback is on a later day than step 6, type the backup folder's date instead of `$(Get-Date …)`.)
