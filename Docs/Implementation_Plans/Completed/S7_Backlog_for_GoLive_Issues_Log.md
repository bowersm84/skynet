# Issues Discovered During Sprint 7 — For Go-Live Issues Log

**Captured:** May 16, 2026
**Context:** Items surfaced during Sprint 7 RLS hardening that are NOT in S7 scope and need future work. Add to your go-live issues log.

---

## 🐛 New bugs discovered today

### Issue 1 — Edge Function audit_logs writes have been silently failing
- **Severity:** Medium (no user-facing impact, but loss of audit trail for user-management events)
- **Affected:** `manage-users` and `kiosk-authenticate` Edge Functions
- **Root cause:** Edge Function code writes columns `actor_id`, `action`, `target_type`, `target_id`. The actual schema has `event_type`, `job_id`, `machine_id`, `operator_id`. The `from('audit_logs').insert(...)` returns `{ data, error }` but the result isn't checked, so errors are silently swallowed.
- **Impact:** Every user invite, password reset, PIN reset, profile update, kiosk PIN auth success, and PIN collision since Edge Function deployment has produced **zero** audit log entries.
- **Fix options:**
  - (a) Update Edge Function inserts to use schema column names (`event_type` instead of `action`, etc.)
  - (b) Update schema to add the columns the Edge Functions expect (would require app code update too)
  - Recommend (a) — frontend already uses correct column names, so unifying on the schema is the path of least resistance
- **Where to fix:** `supabase/functions/manage-users/index.ts` and `supabase/functions/kiosk-authenticate/index.ts`. Approximately 8 insert sites across the two functions.

### Issue 2 — Compliance "Additional Documents" upload doesn't refresh UI
- **Severity:** Low (data integrity fine, just confusing UX)
- **Affected:** `src/components/ComplianceReview.jsx` → `handleAdditionalUpload`
- **Symptom:** Operator uploads an additional document via the "Upload Document" button. S3 upload succeeds. `job_documents` row is inserted successfully. But the UI doesn't refresh to show the new document — operator thinks nothing happened. Refresh page → doc appears.
- **Root cause:** `handleAdditionalUpload` calls `fetchJobDetails(jobId)` which updates only one slice of state. The parent component's broader state (pending batches, recently approved) isn't refreshed.
- **Fix:** Mirror the post-delete pattern from `handleDeleteDocument` (line ~990). After the `setJobDetails(...)` call, also call `fetchPendingBatches()` and `fetchRecentlyApprovedBatches()`.

### Issue 3 — Duplicate SELECT policies on `job_documents`
- **Severity:** Very low (harmless, just unnecessary)
- **Affected:** `job_documents` table policies
- **Symptom:** Two SELECT policies exist for authenticated users, both identical (`USING (true)`). Names: `Allow authenticated read` and `job_documents_select_authenticated`.
- **Fix:** Drop one. The newer-named `job_documents_select_authenticated` matches the M8 naming convention; keep that one. One-line cleanup migration whenever convenient.

---

## ✅ Issues fixed today during S7 (logged for traceability)

### Issue 4 — Test environment missing `acknowledge_plan` in resolution CHECK constraint
- **Status:** ✅ Fixed on test during M9 regression
- **What happened:** Test's `job_shortfall_resolutions.resolution` CHECK constraint allowed only `accept_short`, `requeue`, `cancel_shortfall`. Prod also had `acknowledge_plan`. Clicking the "Acknowledge" button on a plan-only shortfall in test errored with `violates check constraint`.
- **Fix applied:** ALTER TABLE to drop and recreate the constraint with `acknowledge_plan` included. Test now matches prod.
- **Why it happened:** Constraint update was applied to prod at some point but not propagated to test. Schema migration discipline gap.

### Issue 5 — S3 bucket missing CORS rule for test origin
- **Status:** ✅ Fixed on bucket (`skynet-files-skybolt`) during M8 regression
- **What happened:** S3 bucket CORS only allowed `https://skynet.skybolt.com`. Document upload from `https://test-skynet.skybolt.com` was blocked by browser CORS preflight.
- **Fix applied:** Added `https://test-skynet.skybolt.com` and `http://localhost:5173` to AllowedOrigins.
- **Why it happened:** Test environment was added later; CORS config was never updated to match.

---

## 🔮 Future-work backlog spawned by S7

### Item 6 — Migrate `Finishing.jsx` to JWT-per-PIN auth pattern
- **Severity:** Medium (security posture + reliability)
- **Why it matters:** The finishing computer relies on a persisted Supabase auth session from a previous login. This means every operator who uses that computer effectively acts as whoever last logged in. PIN identifies the operator only in React state, not in Supabase auth. Audit logs reflect the persisted session's user, not the PIN-identified operator.
- **Long-term fix:** Build a finishing-specific Edge Function (or extend `kiosk-authenticate` to handle finishing-station auth) that mints a JWT per PIN entry, matching the `Kiosk.jsx` pattern.
- **Side benefit:** Once done, `profiles` SELECT can be narrowed to `auth.uid() = id` for users (admin lookups via service_role Edge Function only), tightening PIN exposure.

### Item 7 — Move `audit_logs` INSERTs behind an Edge Function
- **Severity:** Low-Medium (audit integrity hardening)
- **Why it matters:** Today, any authenticated user can insert forged audit log entries (e.g., logging an action as someone else). Profile F prevents tampering with existing records but doesn't validate the integrity of new ones.
- **Long-term fix:** Wrap the 11 frontend `audit_logs.insert(...)` sites behind an Edge Function that validates `operator_id` matches the calling JWT's user. Then graduate `audit_logs` from Profile F to Profile E (full service-role lockdown).
- **Pairs well with:** Issue 1 above — fixing the Edge Function column mismatch and building the integrity layer can be the same project.

### Item 8 — `tools` / `tool_instances` usage audit
- **Severity:** Low (technical debt)
- **Why it matters:** Sprint 7 src/ grep found **zero** references to either table. They have RLS policies, role-restricted admin write access — but nothing in the app reads or writes them. They may be vestigial, or admin-via-SQL-only, or used in a path I missed.
- **Action:** Investigate. If vestigial, drop. If admin-only, document the admin SQL playbook. If used somewhere I missed, document where.

### Item 9 — `outbound_sends.source_type` CHECK constraint drift
- **Severity:** Very low (not affecting current flows we know of)
- **Status:** Pending — not fixed during S7 because it didn't surface
- **What:** Prod constraint allows `source_type` to be NULL (`CHECK (source_type IS NULL OR source_type = ANY(...))`). Test does NOT allow NULL. Test is stricter.
- **Fix:** ALTER TABLE on test to align with prod (relax the constraint). One-line SQL.

### Item 10 — Narrow `profiles` SELECT (post-PIN-hashing)
- **Severity:** Low (current state already blocks anon — the big exposure)
- **Why it matters:** Today, any authenticated user can read every profile row including plain-text `pin_code`. Narrowing to `USING (auth.uid() = id)` would close this gap.
- **Blocked by:** PIN hashing (S5 backlog item) AND Finishing.jsx JWT migration (Item 6 above). Cannot narrow until those land.
- **Sequence:** PIN hashing → Finishing.jsx Edge Function migration → narrow profiles SELECT.

### Item 11 — CI guardrail SQL wiring
- **Severity:** Medium (prevents future regression)
- **Status:** SQL drafted today (see `rls_guardrail.sql` deliverable). Wiring into CI is the next step.
- **Options:**
  - GitHub Actions step that runs the SQL against the test Supabase before allowing merge to main
  - Amplify pre-build hook
  - Manual SQL run before each prod deploy (no automation)
- **Recommend:** GitHub Actions step against test DB on every PR. Fail the build if the guardrail returns any rows.

---

## Cross-references

For each issue, the relevant Sprint 7 doc context:

| Issue | Where it surfaced |
|---|---|
| 1 (Edge Function audit_logs columns) | M7 prep, discovered while verifying audit_logs schema |
| 2 (Compliance UI refresh) | M8 regression, document upload test |
| 3 (Duplicate job_documents SELECT) | M8 verification (count of 5 instead of 4) |
| 4 (acknowledge_plan drift — fixed) | M9 regression, Acknowledge button on test |
| 5 (S3 CORS — fixed) | M8 regression, document upload test |
| 6 (Finishing JWT migration) | M7 design — Finishing kiosk auth model investigation |
| 7 (Audit log integrity Edge Function) | M7 design — Profile F vs Profile E |
| 8 (tools/tool_instances audit) | M6 prep, src/ grep |
| 9 (outbound_sends drift) | Original schema diff at start of S7 |
| 10 (Narrow profiles SELECT) | M7 design — D1 decision |
| 11 (CI guardrail wiring) | Batch D / closeout |
