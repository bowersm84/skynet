# preflight-test-parity.ps1   (v1 - 2026-08-14)
# -----------------------------------------------------------------------------
# READ-ONLY parity preflight for the PROD -> TEST data refresh. Touches nothing;
# run it before refresh-test-from-prod.ps1 and fix anything it flags.
#
# Every check here exists because it failed a real refresh:
#   A. Column parity      - a PROD column TEST lacks aborts the COPY.
#   B. NOT NULL parity    - a TEST-only NOT NULL column with no default aborts it.
#   C. Routine parity     - functions are NOT carried by a data-only dump.
#   D. Trigger parity     - a TEST-only trigger fires against PROD data on load.
#   E. Collision audit    - a UNIQUE constraint on a user-reference column
#                           collides once the id remap collapses every PROD user
#                           onto one TEST admin. This is the cert_signatures
#                           failure of 2026-08-14 and the kiosk_sessions one
#                           before it. LATENT: arms itself the moment a second
#                           person uses the feature, with no schema change.
#   F. Constraint parity  - CHECK/UNIQUE/FK defs are invisible to A and B.
#
# Usage:  ./preflight-test-parity.ps1
# -----------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
if (-not $env:PROD_DB_URL) { $env:PROD_DB_URL = [Environment]::GetEnvironmentVariable("PROD_DB_URL","User") }
if (-not $env:TEST_DB_URL) { $env:TEST_DB_URL = [Environment]::GetEnvironmentVariable("TEST_DB_URL","User") }

$TEST_REF = 'ylzmyjjqibpbqbwjsnqj'
$prod = $env:PROD_DB_URL
$test = $env:TEST_DB_URL

if (-not $prod -or -not $test) { throw "Set PROD_DB_URL and TEST_DB_URL (Session pooler, port 5432)." }
if ($test -notmatch $TEST_REF) { throw "SAFETY STOP: TEST_DB_URL is not the TEST project ($TEST_REF)." }
if ($prod -match $TEST_REF)    { throw "SAFETY STOP: PROD_DB_URL looks like TEST." }

$blockers = New-Object System.Collections.ArrayList
$notes    = New-Object System.Collections.ArrayList

function Q($url, $sql) { return (psql $url -t -A -c $sql) }

Write-Host ""
Write-Host "PROD -> TEST refresh preflight" -ForegroundColor Cyan
Write-Host "------------------------------" -ForegroundColor Cyan

# --- A. Column parity (base tables AND views) --------------------------------
Write-Host "A. Column parity..." -NoNewline
$colSql = "select table_name||'.'||column_name||' :: '||data_type from information_schema.columns where table_schema='public' order by 1;"
$pCols = Q $prod $colSql
$tCols = Q $test $colSql
$colDiff = Compare-Object $pCols $tCols
$prodOnlyCols = @($colDiff | Where-Object { $_.SideIndicator -eq '<=' -and $_.InputObject -notmatch '^v_' })
$testOnlyCols = @($colDiff | Where-Object { $_.SideIndicator -eq '=>' -and $_.InputObject -notmatch '^v_' })
$viewDiff     = @($colDiff | Where-Object { $_.InputObject -match '^v_' })
if ($prodOnlyCols.Count -gt 0) {
  [void]$blockers.Add("A: $($prodOnlyCols.Count) column(s) exist on PROD but not TEST. The COPY will abort.")
  Write-Host " BLOCKER" -ForegroundColor Red
  $prodOnlyCols | ForEach-Object { Write-Host "     PROD only: $($_.InputObject)" -ForegroundColor Red }
} else {
  Write-Host " ok" -ForegroundColor Green
}
if ($testOnlyCols.Count -gt 0) { [void]$notes.Add("A: $($testOnlyCols.Count) TEST-only base-table column(s) (TEST ahead; see check B).") }
if ($viewDiff.Count -gt 0)     { [void]$notes.Add("A: $($viewDiff.Count) view column difference(s) - views are not copied by a data-only dump; informational only.") }

# --- B. NOT NULL parity ------------------------------------------------------
Write-Host "B. NOT NULL parity..." -NoNewline
$nnSql = "select count(*)||'|'||md5(string_agg(table_name||'.'||column_name, ',' order by table_name, column_name)) from information_schema.columns where table_schema='public' and is_nullable='NO' and column_default is null;"
$pNn = (Q $prod $nnSql).Trim()
$tNn = (Q $test $nnSql).Trim()
if ($pNn -ne $tNn) {
  [void]$blockers.Add("B: NOT NULL sets differ (PROD $pNn vs TEST $tNn). A TEST-only NOT NULL column with no default will abort the COPY.")
  Write-Host " BLOCKER" -ForegroundColor Red
} else {
  Write-Host " ok  ($($pNn.Split('|')[0]) columns)" -ForegroundColor Green
}

# --- C. Routine parity -------------------------------------------------------
Write-Host "C. Routine parity..." -NoNewline
$fnSql = "select p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by 1;"
$pFn = Q $prod $fnSql
$tFn = Q $test $fnSql
$fnDiff = Compare-Object $pFn $tFn
$prodOnlyFn = @($fnDiff | Where-Object { $_.SideIndicator -eq '<=' })
$testOnlyFn = @($fnDiff | Where-Object { $_.SideIndicator -eq '=>' })
if ($prodOnlyFn.Count -gt 0) {
  [void]$blockers.Add("C: $($prodOnlyFn.Count) function(s) on PROD but not TEST. Not a load failure, but TEST will not behave like PROD.")
  Write-Host " REVIEW" -ForegroundColor Yellow
  $prodOnlyFn | ForEach-Object { Write-Host "     PROD only: $($_.InputObject)" -ForegroundColor Yellow }
} else {
  Write-Host " ok" -ForegroundColor Green
}
if ($testOnlyFn.Count -gt 0) {
  [void]$notes.Add("C: $($testOnlyFn.Count) TEST-only function(s) - un-promoted work, queue for PROD:")
  $testOnlyFn | ForEach-Object { [void]$notes.Add("      $($_.InputObject)") }
}

# --- D. Trigger parity -------------------------------------------------------
Write-Host "D. Trigger parity..." -NoNewline
$trgSql = "select c.relname||' :: '||t.tgname||' -> '||p.proname from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by 1;"
$pTrg = Q $prod $trgSql
$tTrg = Q $test $trgSql
$trgDiff = Compare-Object $pTrg $tTrg
if ($trgDiff) {
  [void]$notes.Add("D: trigger sets differ. TEST-only triggers fire against PROD data during the load.")
  $trgDiff | ForEach-Object { [void]$notes.Add("      $($_.SideIndicator) $($_.InputObject)") }
  Write-Host " REVIEW" -ForegroundColor Yellow
} else {
  Write-Host " ok  ($($pTrg.Count) triggers)" -ForegroundColor Green
}

# --- E. Remap collision audit (the cert_signatures class) --------------------
Write-Host "E. Remap collision audit..." -NoNewline
$uqSql = @"
with user_cols as (
  select c.conrelid, unnest(c.conkey) as attnum
  from pg_constraint c
  where c.contype = 'f' and c.confrelid = 'public.profiles'::regclass
),
uniq as (
  select i.indrelid, unnest(i.indkey::int[]) as attnum
  from pg_index i where i.indisunique
)
select distinct u.indrelid::regclass::text||'|'||a.attname
from uniq u
join user_cols uc on uc.conrelid = u.indrelid and uc.attnum = u.attnum
join pg_attribute a on a.attrelid = u.indrelid and a.attnum = u.attnum
order by 1;
"@
$candidates = @(Q $prod $uqSql | Where-Object { $_ -match '\|' })
$mustExclude = New-Object System.Collections.ArrayList
foreach ($c in $candidates) {
  $parts = $c -split '\|'
  $tbl = $parts[0]; $col = $parts[1]
  $n = (Q $prod "select count(distinct $col) from $tbl where $col is not null;").Trim()
  if ([int]$n -gt 1) { [void]$mustExclude.Add("$tbl ($col: $n distinct users on PROD)") }
  else               { [void]$notes.Add("E: $tbl.$col - $n distinct user(s) on PROD; no collision yet, but latent.") }
}
if ($mustExclude.Count -gt 0) {
  Write-Host " ACTION" -ForegroundColor Yellow
  foreach ($m in $mustExclude) { Write-Host "     must be excluded from the dump: $m" -ForegroundColor Yellow }
  [void]$notes.Add("E: confirm each is a leaf (nothing FKs to it) before excluding.")
} else {
  Write-Host " ok" -ForegroundColor Green
}

# --- F. Constraint parity ----------------------------------------------------
Write-Host "F. Constraint parity..." -NoNewline
$conSql = "select count(*)||'|'||md5(string_agg(conrelid::regclass::text||'.'||conname||'|'||pg_get_constraintdef(oid), ',' order by conrelid::regclass::text, conname)) from pg_constraint where connamespace='public'::regnamespace and contype in ('c','u','f');"
$pCon = (Q $prod $conSql).Trim()
$tCon = (Q $test $conSql).Trim()
if ($pCon -ne $tCon) {
  [void]$notes.Add("F: constraint definitions differ (PROD $pCon vs TEST $tCon). Usually fine when TEST is the more permissive side; check if the load fails on a CHECK.")
  Write-Host " REVIEW" -ForegroundColor Yellow
} else {
  Write-Host " ok" -ForegroundColor Green
}

# --- Summary -----------------------------------------------------------------
Write-Host ""
if ($notes.Count -gt 0) {
  Write-Host "Notes:" -ForegroundColor DarkGray
  $notes | ForEach-Object { Write-Host "  - $_" -ForegroundColor DarkGray }
  Write-Host ""
}
if ($blockers.Count -gt 0) {
  Write-Host "BLOCKERS - do not run the refresh:" -ForegroundColor Red
  $blockers | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  Write-Host ""
  exit 1
}
if ($mustExclude.Count -gt 0) {
  Write-Host "Add the --exclude-table flags listed above to refresh-test-from-prod.ps1 STEP 1, then run." -ForegroundColor Yellow
  Write-Host ""
  exit 2
}
Write-Host "Preflight clear. Capture the TEST profile baseline, then run refresh-test-from-prod.ps1." -ForegroundColor Green
Write-Host ""
exit 0
