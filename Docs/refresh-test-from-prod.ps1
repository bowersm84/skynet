# refresh-test-from-prod.ps1   (v2 — 2026-06-22)
# -----------------------------------------------------------------------------
# Mirrors PROD Supabase public-schema DATA into the SkyNet TEST project, while
# PRESERVING the test users. This WIPES test data (except profiles) and replaces
# it with a copy of PROD.
#
# What it does NOT touch:  auth.users, auth.identities, public.profiles
#   -> your hand-built TEST users and their roles survive every refresh.
#
# How it works (Supabase-safe):
#   Supabase does NOT let you disable FK triggers or use session_replication_role,
#   so we cannot just "load with checks off." Instead:
#     1. Dump PROD data (excluding profiles).
#     2. Remap every PROD user id in the dump to the TEST admin id, so every
#        user-reference column lands on a valid TEST profile (no FK violations).
#     3. Back up TEST profiles (TRUNCATE CASCADE can reach them via FKs), and
#        REFUSE to proceed if there are none to preserve.
#     4. Wipe TEST data tables, then restore profiles (with home_location_id
#        nulled — see note) if the cascade removed them.
#     5. Load the remapped dump in one transaction (empty tables -> no dup keys).
#   Imported "who did this" columns all read as the TEST admin (cosmetic only;
#   test roles by logging in as each user, not by historical attribution).
#
# v2 changes (why this is safe now):
#   * profiles.home_location_id is NULLED in the restore. The wipe truncates
#     public.locations, and TRUNCATE ... CASCADE reaches public.profiles through
#     the profiles_home_location_id_fkey FK. Because we restore profiles BEFORE
#     step 5 repopulates locations, a non-null home_location_id would violate the
#     FK and abort the restore (this is the v1 failure). home_location is cosmetic
#     for role testing; if you want it back, set it after a refresh.
#   * Pre-wipe guard: if TEST currently has zero profiles to back up (e.g. a
#     previous run failed partway), the script STOPS before touching TEST so it
#     can never silently wipe an already-empty user table. Restore your TEST
#     users first, then re-run.
#
# Prereqs (one-time):
#   - PowerShell must be allowed to run this local script. If you see
#     "not digitally signed", run once (see runbook Section 2e / T10):
#       Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
#       Unblock-File .\refresh-test-from-prod.ps1
#   - PostgreSQL client tools (pg_dump, psql) at C:\pgsql\bin (EnterpriseDB
#     "binaries" zip), with that folder on the permanent PATH.
#   - Two SESSION-POOLER connection strings (port 5432) saved as PERMANENT user
#     vars PROD_DB_URL and TEST_DB_URL. (Transaction pooler / 6543 and the IPv6
#     direct host will NOT work with pg_dump.)
#   - The script self-loads PATH + credentials on each run, so a stale VS Code
#     terminal is no longer a problem — just run the script.
#
# Usage:
#   ./refresh-test-from-prod.ps1
# -----------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

# -----------------------------------------------------------------------------
# Self-load environment (handles VS Code terminals that cached an old environment
# at launch).
# -----------------------------------------------------------------------------
$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
if (-not $env:PROD_DB_URL) { $env:PROD_DB_URL = [Environment]::GetEnvironmentVariable("PROD_DB_URL","User") }
if (-not $env:TEST_DB_URL) { $env:TEST_DB_URL = [Environment]::GetEnvironmentVariable("TEST_DB_URL","User") }

$TEST_REF = 'ylzmyjjqibpbqbwjsnqj'        # SkyNet TEST project ref — hard safety guard

$prod = $env:PROD_DB_URL
$test = $env:TEST_DB_URL

if (-not $prod -or -not $test) {
  throw "Set PROD_DB_URL and TEST_DB_URL (Session pooler connection strings) before running."
}
if ($test -notmatch $TEST_REF) {
  throw "SAFETY STOP: TEST_DB_URL does not contain the test project ref ($TEST_REF). Refusing to run."
}
if ($prod -match $TEST_REF) {
  throw "SAFETY STOP: PROD_DB_URL looks like the TEST project. Refusing to run."
}

# Admin profile in TEST that imported rows will be re-owned to.
$ADMIN_ID = '004b6b6e-68cf-4824-bf52-db9d15468745'   # Matt Bowers (admin) in TEST

Write-Host ""
Write-Host "This will ERASE data in TEST ($TEST_REF) and replace it with a copy of PROD." -ForegroundColor Yellow
Write-Host "Preserved (untouched): auth.users, auth.identities, public.profiles" -ForegroundColor Yellow
$confirm = Read-Host "Type REFRESH to continue"
if ($confirm -ne 'REFRESH') { Write-Host "Aborted."; exit 1 }

$tmp      = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("skynet_refresh_" + (Get-Date -Format yyyyMMdd_HHmmss)))
$pubSql   = Join-Path $tmp 'public.sql'
$fixedSql = Join-Path $tmp 'public_fixed.sql'
$profBak  = Join-Path $tmp 'profiles_backup.sql'
$profSafe = Join-Path $tmp 'profiles_backup_safe.sql'
$wipeSql  = Join-Path $tmp 'wipe.sql'

# ---------------------------------------------------------------------------
# STEP 1 — Dump PROD data, excluding profiles (we keep TEST's own users).
# ---------------------------------------------------------------------------
Write-Host "1/5  Dumping PROD public data (excluding profiles + kiosk_sessions)..." -ForegroundColor Cyan
# Exclude profiles (we keep TEST's users) and kiosk_sessions. The latter is
# ephemeral live-login state AND a remap-collision source: its partial unique
# index (one active session per operator+machine+device) is violated once every
# PROD operator is collapsed onto the single TEST admin. It's a leaf table, so
# leaving it empty on TEST is safe; sessions regenerate as people log in.
pg_dump $prod --data-only --no-owner --no-privileges --schema=public --exclude-table=public.profiles --exclude-table=public.kiosk_sessions -f $pubSql
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $pubSql) -or (Get-Item $pubSql).Length -eq 0) {
  throw "PROD dump failed or produced an empty file. Aborting before touching TEST."
}

# ---------------------------------------------------------------------------
# STEP 2 — Remap every PROD user id in the dump to the TEST admin id.
# ---------------------------------------------------------------------------
Write-Host "2/5  Remapping PROD user ids -> TEST admin in the dump..." -ForegroundColor Cyan
$prodUserIds = (psql $prod -t -A -c "SELECT id FROM profiles") -split "`r?`n" | Where-Object { $_ -match '^[0-9a-f-]{36}$' }
if (-not $prodUserIds -or $prodUserIds.Count -eq 0) {
  throw "Could not read PROD user ids. Aborting before touching TEST."
}
$text = Get-Content $pubSql -Raw
foreach ($id in $prodUserIds) { $text = $text.Replace($id, $ADMIN_ID) }
# Write UTF-8 without BOM; psql cannot parse UTF-16 and would silently no-op.
[System.IO.File]::WriteAllText($fixedSql, $text, (New-Object System.Text.UTF8Encoding($false)))

# ---------------------------------------------------------------------------
# STEP 3 — Back up TEST profiles. TRUNCATE ... CASCADE on data tables can reach
# profiles through FKs, so we snapshot them and restore after the wipe.
# ---------------------------------------------------------------------------
Write-Host "3/5  Backing up TEST users (profiles)..." -ForegroundColor Cyan
pg_dump $test --data-only --no-owner --table=public.profiles -f $profBak
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $profBak) -or (Get-Item $profBak).Length -eq 0) {
  throw "Profiles backup failed. Aborting before touching TEST (your users are untouched)."
}

# Guard: refuse to wipe if there are no TEST profiles to preserve. This catches
# the case where a previous run failed partway and left profiles empty — wiping
# now would lose your TEST users permanently. Restore your users first.
$profRows = 0; $inCopy = $false
foreach ($l in Get-Content -LiteralPath $profBak) {
  if ($l -match '^COPY public\.profiles \(') { $inCopy = $true; continue }
  if ($inCopy -and $l -eq '\.') { break }
  if ($inCopy -and $l.Trim() -ne '') { $profRows++ }
}
if ($profRows -eq 0) {
  throw "SAFETY STOP: TEST has no profiles to preserve (backup is empty). Refusing to wipe. Restore your TEST users first, then re-run. PROD untouched; TEST unchanged."
}
Write-Host "      $profRows TEST profiles backed up." -ForegroundColor DarkGray

# Build a restore copy with home_location_id NULLED. The wipe clears locations,
# and we restore profiles before step 5 reloads locations, so a non-null
# home_location_id would violate profiles_home_location_id_fkey. Header-aware so
# it stays correct if the column order ever changes.
$inCopy = $false; $hlIdx = -1
$pbLines = foreach ($l in Get-Content -LiteralPath $profBak) {
  if ($l -match '^COPY public\.profiles \((.+?)\) FROM stdin;') {
    $cols = $matches[1] -split '\s*,\s*'; $hlIdx = [array]::IndexOf($cols,'home_location_id'); $inCopy = $true; $l; continue
  }
  if ($inCopy -and $l -eq '\.') { $inCopy = $false; $l; continue }
  if ($inCopy -and $hlIdx -ge 0 -and $l.Trim() -ne '') {
    $f = $l -split "`t"; if ($f.Count -gt $hlIdx) { $f[$hlIdx] = '\N' }; ($f -join "`t")
  } else { $l }
}
[System.IO.File]::WriteAllText($profSafe, ($pbLines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))

# ---------------------------------------------------------------------------
# STEP 4 — Wipe all TEST data tables (except profiles), then restore profiles
# if the cascade removed them. Runs as one psql invocation.
# ---------------------------------------------------------------------------
[System.IO.File]::WriteAllText($wipeSql, @"
DO `$`$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables
           WHERE schemaname = 'public' AND tablename <> 'profiles' LOOP
    EXECUTE format('TRUNCATE TABLE public.%I CASCADE;', r.tablename);
  END LOOP;
END
`$`$;
"@, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "4/5  Wiping TEST data (profiles preserved + restored)..." -ForegroundColor Cyan
psql $test -v ON_ERROR_STOP=1 -f $wipeSql
if ($LASTEXITCODE -ne 0) { throw "Wipe failed. TEST data tables may be partially cleared; re-run after fixing." }

# Restore profiles if the cascade emptied them (no-op if it didn't).
$profCount = (psql $test -t -A -c "SELECT count(*) FROM profiles").Trim()
if ($profCount -eq '0') {
  Write-Host "      Cascade reached profiles -> restoring TEST users (home_location nulled)..." -ForegroundColor Cyan
  psql $test -v ON_ERROR_STOP=1 -f $profSafe
  if ($LASTEXITCODE -ne 0) {
    throw "CRITICAL: profiles restore failed. Restore manually from: $profSafe (or original: $profBak)"
  }
}

# ---------------------------------------------------------------------------
# STEP 5 — Load the remapped PROD data into the now-empty TEST data tables,
# in one transaction. No FK violations (ids remapped), no duplicate keys (wiped).
# ---------------------------------------------------------------------------
Write-Host "5/5  Loading PROD data into TEST (single transaction)..." -ForegroundColor Cyan
psql $test -v ON_ERROR_STOP=1 --single-transaction -f $fixedSql
if ($LASTEXITCODE -ne 0) {
  throw "Load into TEST failed (rolled back). Data tables are empty; your users are safe. Re-run after fixing."
}

psql $test -c "ANALYZE;" | Out-Null

Remove-Item -Recurse -Force $tmp
Write-Host ""
Write-Host "Done. TEST data mirrors PROD; your test users are intact." -ForegroundColor Green
Write-Host "Imported rows are owned by the TEST admin (cosmetic attribution only)." -ForegroundColor Green
Write-Host "Note: profiles.home_location is reset to blank on every refresh (cosmetic)." -ForegroundColor DarkGray
