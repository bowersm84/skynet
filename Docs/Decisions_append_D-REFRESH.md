## 2026-08-14 — TEST refreshed from PROD; refresh tooling hardened to v3

Ran the PROD→TEST data refresh. Three failures in sequence, each a distinct class,
each now covered by an automated preflight (`Docs/preflight-test-parity.ps1`).
Runbook rewritten as `Refresh_TEST_from_PROD_Runbook_v3.md`, superseding the v1
`.docx` and the v2 markdown. New decision series: **D-REFRESH**.

### D-REFRESH-01 — Parity preflight is a script, not a habit

- **Decision:** `Docs/preflight-test-parity.ps1` (read-only) runs six checks before
  any refresh: column parity, NOT NULL parity, routine parity, trigger parity,
  remap-collision audit, constraint parity. Exit 0 clear / 1 blockers / 2
  exclusions needed.
- **Why:** Every blocker hit on 2026-08-14 was knowable in advance. The checks
  existed only as ad-hoc queries, so they were run inconsistently and interpreted
  by eye.
- **Direction rule:** differences almost always run TEST-ahead-of-PROD, which is
  correct for a TEST→PROD workflow and is not a blocker — PROD data cannot violate
  a constraint TEST lacks. PROD-ahead is what stops a load.

### D-REFRESH-02 — Never run parity checks in the Supabase SQL Editor

- **What:** The editor's JSON result view silently truncates at 100 rows. A NOT
  NULL parity check returned 100 of 182 rows and read as a clean pass — no error,
  no indicator. Truncation is indistinguishable from success.
- **Rule:** parity checks go through `psql`. Where a result could exceed 100 rows,
  reduce it to a single-row `count(*) || md5(string_agg(...))` fingerprint.
- **Relation to the known editor gotcha:** distinct from "only the last result set
  is returned when multiple statements run together" — same class (silent partial
  output), different mechanism.

### D-REFRESH-03 — UNIQUE on a user-reference column must be excluded from the dump

- **What:** The refresh remaps every PROD user id onto the single TEST admin id.
  Any table with a unique constraint on a user-reference column therefore collides
  once PROD holds rows for two users. `cert_signatures` (bare `UNIQUE (user_id)`)
  aborted the load; `kiosk_sessions` was already excluded for the same reason.
  Both now excluded in the script.
- **Why it is dangerous:** the fault is **latent and arms itself with no schema
  change** — it fires the first time a second person uses the feature. Nothing in
  a schema diff catches it. Preflight check E enumerates candidates and reports
  the live distinct-user count per table, so "latent" and "collides now" are
  distinguished.
- **Guard:** confirm a table is a leaf (nothing FKs to it) before excluding;
  excluding a parent moves the failure to the child.
- **Cost:** TEST has no signature images after a refresh. Arguably more correct
  than every cert package in TEST bearing the admin's signature.

### D-REFRESH-04 — Suspend USER triggers for the duration of the load

- **Decision:** The load file is wrapped in
  `ALTER TABLE ... DISABLE TRIGGER USER` / `ENABLE TRIGGER USER` across every
  public table, inside the existing `--single-transaction`.
- **Why:** A data-only dump replays historical rows through today's business
  rules. Triggers fire on INSERT only, so rows written before a rule existed are
  grandfathered on PROD but re-validated on load. The load died on
  `trg_enforce_machine_bar_length` (D-KIOSK-03, shipped the previous day): PROD
  holds `job_materials` rows with 144" bars on a Mazak, from before Mazaks were
  capped at 48". The data isn't wrong — the rule is newer than the data.
- **Three more were queued behind it:** `cert_packages_block_mutation`,
  `enforce_consolidation_material_lot`, and `raise_material_reconciliation_flags`.
  The last would not have errored — it would have *manufactured* flag rows while
  the dump's own flags loaded alongside. Silent divergence, worse than a failure.
  Fixing triggers one at a time would have meant one re-run per trigger.
- **`USER`, not `ALL`:** `ALL` reaches system/FK triggers and is refused on managed
  Supabase (the May 2026 lesson). `USER` leaves referential integrity armed.
- **Transactional:** disable, data, and re-enable are one atomic unit — trigger
  state cannot be left wrong by a failed load.
- **Side benefit:** touch triggers stay suspended, so `updated_at` keeps PROD's
  values instead of being stamped with the load time. Higher fidelity, not lower.
- **General principle:** any process that re-INSERTs historical rows — refresh,
  restore, backfill, migration replay — must consider that validation triggers are
  newer than the data. Grandfathering is invisible until the rows move.

### D-REFRESH-05 — Trigger definitions are a recovery artifact

Several triggers (`trg_enforce_machine_bar_length` among them) were applied by hand
and do not exist in `Docs/migrations/`. `pg_get_triggerdef` output is captured to
`test_triggers.sql` before any trigger manipulation. Costs nothing; it is the only
recovery path if trigger state ends up wrong.

### PROD promotions surfaced by this refresh (tracked separately, not part of it)

- `v_sales_mts_production` and `priority` on `v_sales_weekly_report_v3` — PROD has
  neither; `SalesDashboard.jsx` queries both and fails silently via `|| []`, so the
  MTS section is absent and no order has ever rendered a crit pill in PROD. Either
  PROD runs an older bundle or the dashboard has been quietly partial since June.
- `Docs/migrations/2026-08-03_kit_packing_slip.sql` — `kit_find_lots_by_so`,
  `kit_record_component_lots`, and the `kit_stc_documents` document_type CHECK.
- Open question: whether PROD should drop `v_sales_weekly_report` v1 and v2, which
  TEST has already shed. PROD currently carries three generations of one report.
