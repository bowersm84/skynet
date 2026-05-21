# refresh-test-from-prod.ps1
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
#     3. Back up TEST profiles (TRUNCATE CASCADE can reach them via FKs).
#     4. Wipe TEST data tables, then restore profiles if the cascade removed them.
#     5. Load the remapped dump in one transaction (empty tables -> no dup keys).
#   Imported "who did this" columns all read as the TEST admin (cosmetic only;
#   test roles by logging in as each user, not by historical attribution).
#
# Schema is assumed already in sync (keep applying every migration to TEST too —
# this tool moves data only). A data-only load fails cleanly (full rollback) if a
# column is missing on test, so a drifted schema can't silently corrupt anything.
#
# Prereqs (one-time):
#   - PostgreSQL client tools (pg_dump, psql) available at C:\pgsql\bin (from the
#     EnterpriseDB "binaries" zip), with that folder added to the permanent PATH:
#       [Environment]::SetEnvironmentVariable("Path",
#         [Environment]::GetEnvironmentVariable("Path","User") + ";C:\pgsql\bin", "User")
#   - Two SESSION-POOLER connection strings (port 5432) saved as PERMANENT user vars:
#       $u = "postgresql://postgres.<prodref>:<pwd>@<host>:5432/postgres"
#       [Environment]::SetEnvironmentVariable("PROD_DB_URL", $u, "User")
#       $u = "postgresql://postgres.ylzmyjjqibpbqbwjsnqj:<pwd>@<host>:5432/postgres"
#       [Environment]::SetEnvironmentVariable("TEST_DB_URL", $u, "User")
#     (Transaction pooler / 6543 and the IPv6 direct host will NOT work with pg_dump.)
#   - These are saved in your Windows user profile, never in this committed file.
#     The script self-loads them on each run (see the self-load block below), so a
#     stale VS Code terminal is no longer a problem — just run the script.
#
# Usage:
#   ./refresh-test-from-prod.ps1
# -----------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

# -----------------------------------------------------------------------------
# Self-load environment (handles VS Code terminals that cached an old environment
# at launch). Pulls the permanent Windows PATH + saved credentials into THIS
# session so pg_dump/psql resolve and PROD_DB_URL/TEST_DB_URL are populated,
# whether or not the terminal was opened after they were set.
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
$wipeSql  = Join-Path $tmp 'wipe.sql'

# ---------------------------------------------------------------------------
# STEP 1 — Dump PROD data, excluding profiles (we keep TEST's own users).
# ---------------------------------------------------------------------------
Write-Host "1/5  Dumping PROD public data (excluding profiles)..." -ForegroundColor Cyan
pg_dump $prod --data-only --no-owner --no-privileges --schema=public --exclude-table=public.profiles -f $pubSql
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $pubSql) -or (Get-Item $pubSql).Length -eq 0) {
  throw "PROD dump failed or produced an empty file. Aborting before touching TEST."
}

# ---------------------------------------------------------------------------
# STEP 2 — Remap every PROD user id in the dump to the TEST admin id.
# Supabase does NOT allow disabling FK triggers, so we cannot load PROD's user
# ids (they don't exist in TEST's profiles). Instead we rewrite them in the dump
# file itself, so every "who did this" column points at a valid TEST profile.
# PROD's user ids are fetched live so the list never goes stale.
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
  Write-Host "      Cascade reached profiles -> restoring TEST users..." -ForegroundColor Cyan
  psql $test -v ON_ERROR_STOP=1 -f $profBak
  if ($LASTEXITCODE -ne 0) {
    throw "CRITICAL: profiles restore failed. Restore manually from: $profBak"
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