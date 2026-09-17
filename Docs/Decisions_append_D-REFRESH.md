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

## 2026-09-13 — TEST refreshed from PROD; refresh tooling to v4 (deferred constraints)

Ran the PROD→TEST data refresh. The preflight raised one blocker that proved to be a
false positive, and the load itself failed on a class the v3 trigger suspension did not
anticipate: deferred constraint events. Both are covered below; the script is now v4.
Refresh completed and verified — TEST mirrors PROD, the eleven TEST users are intact.

### D-REFRESH-06 — Drain deferred constraint events before re-arming triggers

- **Failure:** stage 5 aborted and rolled back with
  `ERROR: cannot ALTER TABLE "price_items" because it has pending trigger events`,
  raised from `ALTER TABLE public.price_items ENABLE TRIGGER USER;` in the v3
  re-enable block. The data loaded cleanly; the load died putting the triggers back.
- **Cause:** `price_items` carries two `DEFERRABLE INITIALLY DEFERRED` foreign keys
  (`price_items_ladder_fk` → `price_ladders`, `price_items_rule_fk` → `price_rules`).
  Their referential-integrity events queue for COMMIT rather than firing per row, and
  Postgres refuses `ALTER TABLE ... ENABLE TRIGGER` on any table holding pending
  trigger events. These are internal RI triggers, so `DISABLE TRIGGER USER` never
  touched them — correct per D-REFRESH-04, and exactly why the events were still queued.
- **Fix (v4):** `SET CONSTRAINTS ALL IMMEDIATE;` immediately before the re-enable loop,
  inside the same transaction. This forces the deferred checks to run then rather than
  at COMMIT; nothing is skipped and nothing is validated differently — only earlier.
- **Scope:** three tables in `public` carry deferrable constraints and could raise the
  same error — `price_items` (the two FKs), `jobs` (`jobs_no_machine_overlap`), and
  `outbound_sends` (`trg_enforce_consolidation_material_lot`). One `SET CONSTRAINTS ALL
  IMMEDIATE` covers all of them and any added later.
- **Why it appeared now:** the pricing schema (S11, D-PRICE-29 onward) is the first to
  use deferrable FKs. Like the D-REFRESH-03 collision, this was latent in the tooling
  and armed itself when a new feature landed, with no change to the refresh script.

### Preflight gap found — check A classifies views by name, not by relkind

Check A reported a BLOCKER: 15 columns "on PROD but not TEST", all on
`report_job_efficiency`. That object is a **view** on PROD that does not exist on TEST,
and a data-only dump emits no `COPY` for views, so it cannot abort a load. The check
buckets views by the name prefix `^v_`, but the reports module names its views
`report_*` (D-RPT-02), so they fall through to the blocker path.

Confirmed harmless before overriding, by comparing base-table columns only:
PROD 1470, TEST 1470, **PROD-only base-table columns: 0**.

Not fixed this round. The fix is to classify from `pg_class.relkind in ('v','m')`
rather than the name, otherwise every future refresh re-raises this as a blocker and
the gate loses its meaning.

### Refresh record — 2026-09-13

- **Preflight:** exit 1. A — false positive above. B, D — ok (281 columns, 39 triggers).
  C — ok; the same two TEST-only functions as 2026-08-14 (`kit_find_lots_by_so`,
  `kit_record_component_lots`) remain un-promoted. E — `cert_signatures` (2 distinct
  users) and `kiosk_sessions` (8) flagged, both already excluded by the script since v3.
  F — 431 constraints on each side with **none unique to either**; the fingerprint
  differs on definition text only. The single semantic difference is
  `kit_stc_documents_document_type_check`, where TEST additionally allows
  `packing_slip` — TEST-ahead, the safe direction, and part of the un-promoted
  `2026-08-03_kit_packing_slip.sql` above.
- **Exclusions:** unchanged — `profiles`, `kiosk_sessions`, `cert_signatures`.
- **Profiles:** 11 before, 11 after; `auth.users` 11 both. `Compare-Object` of
  `test_profiles_baseline.txt` against `test_profiles_after.txt` returned **no
  differences**, so `role` and the `roles[]` additional-role column survived intact.
- **Row counts:** TEST equals PROD on all eleven spot-check tables — work_orders 229,
  jobs 316, job_routing_steps 1075, finishing_sends 1070, material_receiving 200,
  material_usage 724, customer_orders 200, kit_lots 1444, kit_lot_component_lots 16977,
  stc_requests 72, and **material_reconciliation_flags 35** — that last one matching
  exactly is the proof the trigger suspension held and no flags were manufactured.
  `kiosk_sessions` and `cert_signatures` 0 by design.
- **Triggers:** 39 user triggers, **0 left disabled** — the rollback of the first
  attempt also restored trigger state, as the single-transaction design promises.
- **Sequences:** no sequence has a null `last_value`; every `setval` rode along.
- **Recovery path used:** the first attempt rolled back completely (data tables empty,
  profiles intact, triggers re-armed). Rather than re-dump, the existing
  `public_fixed.sql` was patched with the same `SET CONSTRAINTS ALL IMMEDIATE` and the
  load re-run on its own — 52s, exit 0 — followed by `ANALYZE`. The `ANALYZE` warnings
  about `pg_authid`, `pg_database` and other shared catalogs are normal on Supabase.
- **Still outstanding:** the UI smoke test (§5) — logging in as each role — has not been
  done. Note also that no TEST profile currently carries `roles = {purchaser}`, so the
  purchaser coverage §5 asks for is already absent and is not something the refresh lost.
- **Housekeeping:** because the load was finished by hand, the script's own
  `Remove-Item -Recurse -Force $tmp` never ran. A 37 MB PROD data dump remains at
  `%TEMP%\skynet_refresh_20260913_180146` and should be deleted.
