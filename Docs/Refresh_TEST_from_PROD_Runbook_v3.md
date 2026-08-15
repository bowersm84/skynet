# Refresh TEST from PROD — Runbook v3

**Applies to:** SkyNet MES
**PROD:** `luzungoqfuplspzbqctb` · `skynet.skybolt.com`
**TEST:** `ylzmyjjqibpbqbwjsnqj` · `test-skynet.skybolt.com`
**Scripts:** `Docs/preflight-test-parity.ps1` (read-only) → `Docs/refresh-test-from-prod.ps1` (v3)
**Supersedes:** Runbook v2 / the v1 `.docx`

> **The refresh copies DATA ONLY.** Schema, functions, views, RLS policies,
> triggers, Edge Function secrets, and S3 objects are not carried. The preflight
> exists to find the gaps that matter before they abort a load.

---

## Quick path (when the preflight is clean)

```powershell
cd C:\Users\mabow\skynet_vs\Docs
.\preflight-test-parity.ps1                       # read-only; exit 0 = clear
psql $env:TEST_DB_URL -c "select full_name, role, roles from public.profiles order by full_name;" | Set-Content test_profiles_baseline.txt
.\refresh-test-from-prod.ps1                      # type REFRESH
# then Section 5 verification
```

Everything below is the detail behind those four lines.

---

## 1. Environment

| Item | Requirement |
|---|---|
| `pg_dump` / `psql` | `C:\pgsql\bin` (EnterpriseDB binaries) on PATH |
| `PROD_DB_URL`, `TEST_DB_URL` | Permanent Windows **user** env vars, **Session pooler port 5432** |
| Execution policy | `CurrentUser` = `RemoteSigned` |
| TEST idle | The refresh wipes all TEST data tables |

**Session pooler only.** Transaction pooler (6543) and the IPv6 direct host do not
work with `pg_dump`.

VS Code terminals cache their environment at launch. Both scripts self-load, but
ad-hoc `psql` does not:

```powershell
$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
$env:PROD_DB_URL = [Environment]::GetEnvironmentVariable("PROD_DB_URL","User")
$env:TEST_DB_URL = [Environment]::GetEnvironmentVariable("TEST_DB_URL","User")
```

**If the script won't run** (`not digitally signed`) it picked up a
Mark-of-the-Web flag from a zip or sync. `Unblock-File .\refresh-test-from-prod.ps1`,
then re-run. Worth confirming `git status --short` is clean on the path first —
the repo's Google Drive history makes stray copies plausible.

---

## 2. Preflight

```powershell
.\preflight-test-parity.ps1
```

Exit codes: **0** clear · **1** blockers, do not run · **2** dump exclusions needed.

The six checks and why each exists:

| Check | Catches | Consequence if skipped |
|---|---|---|
| **A. Column parity** | a column on PROD but not TEST | `COPY` aborts, whole load rolls back |
| **B. NOT NULL parity** | TEST-only NOT NULL column with no default | `COPY` aborts |
| **C. Routine parity** | RPCs on one side only | silent: missing feature in TEST, or un-promoted work |
| **D. Trigger parity** | TEST-only triggers | fire against PROD data during load |
| **E. Remap collision** | `UNIQUE` on a user-reference column | duplicate-key abort |
| **F. Constraint parity** | `CHECK`/`UNIQUE`/`FK` definition drift | invisible to A and B; can abort on a CHECK |

**Never run these checks in the Supabase SQL Editor.** Its JSON view silently
truncates at 100 rows — no error, no indicator. On 2026-08-14 a NOT NULL check
returned 100 of 182 rows and read as a clean pass. The preflight uses `psql`
throughout and reduces each check to a single-row fingerprint for that reason.

### Reading the direction

Differences almost always run **TEST ahead of PROD** — that is the correct
direction for a TEST→PROD workflow and is not a blocker. Since you are loading
PROD data into TEST, nothing imported can violate a constraint TEST doesn't have.
The reverse (**PROD ahead**) is what stops a load.

### Check E in detail — the failure mode that keeps returning

The refresh remaps every PROD user id in the dump onto the single TEST admin id
(the only Supabase-safe way to avoid FK violations, since managed Postgres blocks
`session_replication_role` and `DISABLE TRIGGER ALL`). Any table with a **unique
constraint on a user-reference column** therefore collides the moment PROD holds
rows for two different users.

This is latent and arms itself with **no schema change** — it fires the first time
a second person uses a feature. Known instances:

- `kiosk_sessions.operator_id` (composite partial unique) — excluded since v2
- `cert_signatures.user_id` (bare `UNIQUE`) — excluded in v3, discovered 2026-08-14

Before excluding a newly-flagged table, confirm nothing depends on it:

```powershell
psql $env:PROD_DB_URL -c "select conrelid::regclass, conname from pg_constraint where confrelid='public.<table>'::regclass and contype='f';"
```

Empty result = leaf = safe to exclude. If something references it, excluding the
parent just moves the failure to the child — stop and think instead.

---

## 3. Baseline

```powershell
psql $env:TEST_DB_URL -c "select full_name, role, roles from public.profiles order by full_name;" | Set-Content test_profiles_baseline.txt
psql $env:TEST_DB_URL -c "select count(*) from public.profiles;"
psql $env:TEST_DB_URL -c "select count(*) from auth.users;"
psql $env:TEST_DB_URL -c "select id from public.profiles where id='004b6b6e-68cf-4824-bf52-db9d15468745';"
```

- Both counts should match (10 / 10 as of 2026-08-14).
- The admin id **must** return a row — every imported user-reference column
  remaps onto it, so its absence fails the load on the first FK.
- Capture `roles` (the `text[]` additional-role column, D-MROLE-02), not just
  `role`. Multi-role lives on `profiles`, so it survives the refresh — but this
  is what you diff against afterward to prove it.

---

## 4. Run

```powershell
.\refresh-test-from-prod.ps1
```

Type `REFRESH`. Five stages:

1. `pg_dump` PROD `--data-only --schema=public`, excluding `profiles`,
   `kiosk_sessions`, `cert_signatures`.
2. Remap PROD user ids → TEST admin id in the dump file.
3. Back up TEST `profiles`; **refuse to proceed if zero**.
4. `TRUNCATE ... CASCADE` all public tables except `profiles`; restore profiles
   if the cascade reached them (it does — via `profiles_home_location_id_fkey`).
5. Load inside `--single-transaction`, wrapped in a **user-trigger suspension**,
   then `ANALYZE`.

### Why the trigger suspension (v3)

The dump replays historical rows through **today's** business rules. Triggers only
fire on INSERT, so rows written to PROD before a rule existed were grandfathered
there — but re-inserting them re-validates them. On 2026-08-14 the load died on
`trg_enforce_machine_bar_length` (D-KIOSK-03, shipped the previous day): PROD holds
`job_materials` rows with 144" bars on a Mazak, written before Mazaks were capped
at 48". The data isn't wrong; the rule is newer than the data.

Three more sat further down the same load: `cert_packages_block_mutation`,
`enforce_consolidation_material_lot`, and `raise_material_reconciliation_flags` —
that last one wouldn't error, it would *manufacture* flag rows while the dump's own
flags loaded alongside. Silent divergence is worse than a failure.

`DISABLE TRIGGER USER` (not `ALL`) leaves system/FK triggers armed, which is both
what Supabase permits and what you still want enforcing referential integrity. The
disable, the data, and the re-enable are all inside the one transaction, so trigger
state cannot be left wrong.

Side benefit: with touch triggers suspended, `updated_at` keeps PROD's values
rather than being stamped with the load time.

**If `DISABLE TRIGGER USER` is ever refused**, capture definitions first — several
triggers were applied by hand and are not in `Docs/migrations/`:

```powershell
psql $env:TEST_DB_URL -t -A -c "select pg_get_triggerdef(t.oid)||';' from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by 1;" | Set-Content test_triggers.sql
```

Keep that file regardless. It costs nothing and it's the recovery artifact.

### If it fails

The load is `--single-transaction` — a stage-5 failure rolls back completely,
leaving data tables empty and profiles intact. Fix and re-run; the profiles guard
will pass because they were restored. Backups sit in the temp directory printed in
the error.

Expect two harmless `pg_dump` warnings about circular FK constraints on
`work_order_assemblies` and `component_lots`. A single transaction into empty
tables handles them.

---

## 5. Verification

```powershell
psql $env:TEST_DB_URL -c "select count(*) from public.profiles;"
psql $env:TEST_DB_URL -c "select count(*) from auth.users;"
psql $env:TEST_DB_URL -c "select full_name, role, roles from public.profiles order by full_name;" | Set-Content test_profiles_after.txt
Compare-Object (Get-Content test_profiles_baseline.txt) (Get-Content test_profiles_after.txt)
```

Counts match baseline; `Compare-Object` returns nothing. Losing `roles` would
silently cost the purchaser test coverage.

Row-count spot check — run on both, compare:

```sql
select 'work_orders' t, count(*) from work_orders
union all select 'jobs', count(*) from jobs
union all select 'job_routing_steps', count(*) from job_routing_steps
union all select 'finishing_sends', count(*) from finishing_sends
union all select 'material_receiving', count(*) from material_receiving
union all select 'material_usage', count(*) from material_usage
union all select 'material_reconciliation_flags', count(*) from material_reconciliation_flags
union all select 'customer_orders', count(*) from customer_orders
union all select 'kit_lots', count(*) from kit_lots
union all select 'kit_lot_component_lots', count(*) from kit_lot_component_lots
union all select 'stc_requests', count(*) from stc_requests
order by 1;
```

TEST equals PROD everywhere except `kiosk_sessions` and `cert_signatures` (0 by
design). `material_reconciliation_flags` matching exactly is the proof the trigger
suspension worked — a higher count on TEST means flags were manufactured.

Sequences (`setval` rides along in a data-only dump, but verify — a stale sequence
surfaces later as a confusing duplicate-key error):

```sql
select sequencename from pg_sequences where schemaname='public' and last_value is null;
```

Any row returned never got a `setval`; set it from `max(id)` on the owning table.

UI smoke test — log in as **each role**: admin, compliance, scheduler, machinist,
finishing, and the customer-service account carrying `roles = {purchaser}`. Role
behaviour is verified by logging in, not by attribution in the data. Check
Mainframe counts, kiosk sign-in, RM Forecast (`_rm_forecast_gate`), Kit Registry
search, and one S3 document link.

---

## 6. Expected post-refresh state (not bugs)

| Item | State | Action |
|---|---|---|
| `profiles.home_location_id` | nulled | cosmetic; re-set by hand if wanted |
| `kiosk_sessions` | empty | regenerates as people log in |
| `cert_signatures` | empty | compliance users re-upload if exercising cert packages |
| Attribution (`*_by` columns) | all read as TEST admin | cosmetic; roles tested by login |
| Edge Function secrets | not copied | `extract-part-dimensions` needs its own key on TEST |
| S3 objects | not copied | document links 404 unless the bucket is shared |
| Feature flags | from `src/config.js` | follows the deployed branch, not the DB |

---

## 7. Front-end parity

The refresh does nothing to the deployed bundle. If TEST should run PROD's code,
check the Amplify branch behind `test-skynet.skybolt.com` against the PROD branch
commit in `bowersm84/skynet`.

**Order is non-negotiable: migrations land on a Supabase project before code that
queries the new schema deploys there.**

---

## 8. Close out

Append a dated entry to `Docs/Decisions.md`: preflight findings, exclusions
changed, migrations replayed, profile count preserved, row counts verified.

**Log PROD promotions separately.** The preflight surfaces un-promoted TEST work
every time; each item is its own change with its own rollback story and does not
belong in the refresh entry. Open as of 2026-08-14:

- `v_sales_mts_production` + `priority` on `v_sales_weekly_report_v3` (PROD lacks
  both; `SalesDashboard.jsx` queries them and fails silently via `|| []`)
- `Docs/migrations/2026-08-03_kit_packing_slip.sql` — `kit_find_lots_by_so`,
  `kit_record_component_lots`, and the `kit_stc_documents` CHECK
- whether PROD should drop `v_sales_weekly_report` v1/v2, which TEST has shed
