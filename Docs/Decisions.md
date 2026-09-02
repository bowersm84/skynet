# SkyNet Architectural Decisions

> Append-only knowledge bank. Each decision documents *what* was chosen and *why*, so future sessions don't relitigate settled questions.

---

## Authentication & User Provisioning (Sprint 4 Final — April 28, 2026)

### Login UX: username, not email
- **Decision:** Login screen shows a "Username" field; the `@skybolt.com` domain is auto-appended client-side before `signInWithPassword`.
- **Why:** Operators don't think of themselves by email address. "mbowers" matches what they'd type into anything else. The full email format is still accepted (a user can paste `mbowers@skybolt.com` and it works) — the convenience is for the typical case.
- **Implementation:** `Login.jsx` has a small static `@skybolt.com` suffix label; submit handler appends if not already present.

### Auth flow type: implicit, not PKCE
- **Decision:** `flowType: 'implicit'` in `supabase.js`.
- **Why:** Supabase's admin invite API (`auth.admin.inviteUserByEmail`) does not honor PKCE regardless of the client's flow type setting. PKCE was attempted; it fails because the admin-issued magic link uses a non-PKCE format. Forcing PKCE on the client just produces unusable links from invite emails. Implicit + the `/confirm-invite` mitigation (below) is what works.

### Email link scanner mitigation
- **Decision:** All Supabase magic links route through SkyNet's own `/confirm-invite` intermediate page. The page calls `supabase.auth.verifyOtp({ token_hash, type })` via POST on a button click — never via a GET URL.
- **Why:** Gmail's link scanner pre-fetches GET URLs in incoming emails. Direct Supabase verify URLs are single-use OTPs — Gmail consumes them before the user can click. The intermediate page absorbs the scanner pre-fetch (static HTML, no harm). Scanners do not execute speculative POSTs, so the actual token verification only fires when the user clicks Continue.
- **Email template requirement:** Use `{{ .TokenHash }}` (the long SHA-256 hex hash, ~64 chars), NOT `{{ .Token }}` (a short numeric OTP code). The `verifyOtp` SDK call expects the hash format under the `token_hash` parameter.
- **Five attempts before this worked.** See "Gmail scanner saga" notes below for the full debugging history.

### Email infrastructure
- **Decision:** AWS SES (us-east-1) via SMTP. Custom MAIL FROM = `bounce.skybolt.com`. DKIM 2048-bit (RSA). DNS via SolidCP.
- **Why:** Supabase's default email sender lands in spam. SES with proper domain verification + custom MAIL FROM provides DMARC alignment via DKIM-strict, which is what Skybolt's existing apex DMARC policy (`p=reject; adkim=s; aspf=s`) demands. The bounce subdomain isolates SES's SPF requirement from the Google Workspace SPF on the apex.
- **Apex SPF/DMARC unchanged.** Touching either could break Google Workspace mail flow. The bounce subdomain has its own SPF (`v=spf1 include:amazonses.com ~all`); the apex DMARC catches alignment failures via DKIM only.
- **Production access granted instantly.** Quota 50K/24h, 14/sec — vastly more than needed (<50 emails/month actual usage).

### Email asset hosting
- **Decision:** Public S3 bucket `skynet-email-assets-skybolt` (us-east-1, public-read) for email images/GIFs. Separate from the private `skynet-files-skybolt` bucket.
- **Why:** Email clients aggressively strip inline SVG (Gmail), block CID-attached images by default, and rate-limit external image fetches. Hosting on a public S3 bucket with stable URLs is the standard solution. The branded GIFs and PNGs render reliably across Gmail, Outlook, Apple Mail.
- **Lock icon:** rendered from inline SVG to PNG via `cairosvg` (Python library, much cleaner than hand-drawing). 4.7 KB transparent PNG.

### Self-service password reset
- **Decision:** "Forgot password?" link on the Login screen routes to `/forgot-password`. User enters their username; system calls `resetPasswordForEmail()` with `@skybolt.com` appended. Response is uniform regardless of whether the email exists.
- **Why anti-enumeration:** A different message for "user not found" lets attackers harvest valid usernames. Uniform success message ("If an account exists for X, you'll receive an email") is the standard mitigation. Real success or silent failure both look identical to the user.

### PIN storage: plain text
- **Decision:** `profiles.pin_code` stores 4 digits as plain text. Partial unique index enforces uniqueness (`WHERE pin_code IS NOT NULL`).
- **Why:** Threat model is shoulder-surfing on the shop floor, not remote attack. PINs are 4-digit (10,000 possibilities) — bcrypt would add operational complexity for marginal security gain. Plain text also enables the kiosk's `WHERE pin_code = '1234'` lookup pattern (the PIN both identifies and authenticates the operator).
- **Listed as S5 hardening item.** Hash migration (bcrypt or argon2) is on the post-go-live backlog. Not blocking.

### PIN creation timing
- **Decision:** PIN is captured during `/set-password` (the invite/reset flow), alongside the password. Only for `PIN_REQUIRED_ROLES = ['machinist', 'admin', 'finishing']`.
- **Why:** Setting the PIN at the kiosk before authentication breaks the security model — anyone could claim "I'm Roger and I haven't set a PIN yet." Requiring authentication via the invite token (which is cryptographically bound to a specific user identity) before allowing PIN creation closes the impersonation gap.
- **Other roles (compliance, scheduler, customer_service, assembly) skip the PIN step entirely.** They don't use the kiosks.

### PIN reset behavior
- **Decision:** Admin reset (Armory > Users > Reset PIN) sets `pin_code = NULL`. User sees a soft-prompt modal on next Mainframe load asking them to create a new PIN. Modal is dismissible per session.
- **Why:** Hard requirement (blocking access) is too aggressive for an internal tool. Soft prompt with a "Later" button is courteous but reappears every login until completed. Typically a user will resolve it within one or two sessions.

### Edge Function pattern: `manage-users`
- **Decision:** All admin user CRUD goes through the `manage-users` Supabase Edge Function. Service role key lives only on the server side. Caller is validated as admin via JWT before any action.
- **Why:** The Supabase JS client running in the browser only has the anon key. Admin operations (creating users, resetting passwords) require the service role key, which must never reach the browser. The Edge Function pattern is Supabase's recommended approach for this.
- **Whitelisted update fields:** `role`, `full_name`, `home_location_id`, `can_float`, `can_approve_compliance`, `is_active`. Tampering with `id`, `email`, `created_at` is blocked at the function level (regardless of what the client sends).
- **All actions write to `audit_logs`.**

### Role-based UI gating
- **Decision:** "If you can view a tab, you can edit everything inside it." Single-rule access model. Users tab is the lone exception (admin-only).
- **Implementation:**
  - `TAB_ACCESS_BY_ROLE` map in `Armory.jsx` filters which sub-tabs render
  - `canEditSchedule` / `canCreateWorkOrders` flags in `App.jsx` gate Schedule drag-drop and Mainframe work-order buttons
  - RLS at the database layer mirrors the same constraints (defense in depth)
- **Why:** Multiple permission levels per page (view/edit/admin) creates a combinatorial explosion of states to test. Single rule means QA only verifies "can this role see X?" not "can this role do Y to X?"

---

## Earlier Decisions (Sprint 1–4 Functional, recap)

### Soft delete throughout
- All deletions use `is_active = false` or `status = 'cancelled'`. Exception: `job_documents` allow hard `DELETE` (RLS policy permits it).
- **Why:** Audit trail. Can recover a "deleted" record by flipping the flag back. Avoids cascade-delete surprises.

### Lot # changes blocked on active jobs
- Once a job is `in_progress`, the material lot # cannot change. Mismatch attempts log to `audit_logs`.
- **Why:** Lot traceability is regulatory. Mid-job changes would fragment the chain of custody.

### PLN trigger at Start Production, not material entry
- Production Lot Number generated at the `in_progress` transition.
- **Why:** Material can be entered, then operator may abandon setup. PLN should only exist for jobs that actually started running.

### Per-batch outsourcing
- Each `finishing_sends` row with a pending external step is independent. Routing step + job status only flip to complete when ALL sends returned AND machining done (`actual_end IS NOT NULL`).
- **Why:** Real-world: Batch A may go to plating before Batch B is even washed. Forcing batch synchronization would block the workflow.

### Effective qty precedence
- Centralized in helpers (`getEffectiveQty`, `getBatchQty`, `lib/traveler.js`). Direct reads of `jobs.quantity` forbidden in qty displays.
- Chain: `qty_override` → `outbound_sends.quantity_returned` (if all returned) → `SUM(finishing_sends.compliance_good_qty)` → `SUM(verified_count − bad_qty)` → `SUM(verified_count)` → `jobs.good_pieces` → `jobs.quantity`.
- **Why:** Six different paths could produce a number; without a canonical chain, different parts of the UI showed different values.

### Forced compliance qty entry
- `Accept` and `Rework` outcomes block submission without `good_qty`. `Reject` does not require qty.
- **Why:** Pre-fix, hundreds of approved batches had `null` good_qty, breaking downstream rollups.

### Job Traveler — live, never stored
- Generated on demand via `lib/traveler.js`. Available from 5 surfaces (Kiosk, Compliance, Finishing, WO Lookup, Print Hub).
- **Why:** Static traveler PDFs went stale instantly. Live HTML always reflects current state.

### Standalone J-FIN jobs
- Auto-numbered `J-FIN-XXXXXX`. `work_order_id` and `assigned_machine_id` nullable.
- **Why:** Purchased springs/clips/cups need finishing without a machining work order. Also covers non-Mazak-5 machines during phased rollout (manual work, no kiosk).

### Date/timezone — local-noon UTC
- User-picked dates (e.g., expected return) stored at local-noon UTC. Display formatted in user's local TZ. Never use `new Date('YYYY-MM-DD')` directly — that parses at midnight UTC, displaying as previous-day in US Eastern.
- **Why:** Users entered "Jan 15" and saw "Jan 14" — classic timezone bug.

### Document types — nullable
- `document_type_id` can be NULL. Ad-hoc uploads (additional docs, certs not in master list) use null + status=approved.
- **Why:** Forcing every upload into a predefined bucket killed flexibility for compliance review.

### RLS baseline
- Every table needs SELECT/INSERT/UPDATE/DELETE policies. Kiosk-read tables also need anon SELECT (kiosks aren't logged in via Supabase Auth).
- **Re-audit before go-live:** `SELECT relname, polcmd, count(*) FROM pg_policies JOIN pg_class ON ...` to find tables missing cmd-specific policies. Sprint 4 patched 14 tables for missing UPDATE and 7 for missing DELETE.

### Supabase query nesting limit
- Never nest more than 2 levels deep in a `.select()`. Fetch separately and merge client-side.
- **Why:** Supabase's PostgREST builder produces increasingly complex SQL with nested joins; deep nesting silently breaks RLS evaluation in some edge cases.

---

## Operational Notes & Hard-Won Lessons

### The Gmail scanner saga (April 28)
Five distinct auth-flow attempts before settling on the working architecture:
1. **Implicit flow direct.** Email link → Supabase `/verify` → `#access_token=...`. Gmail scanner consumed the verify URL before the user clicked. Result: `otp_expired`.
2. **PKCE flow on client.** `flowType: 'pkce'` in supabase.js. Admin invite API ignored the client config; emails still came as implicit-flow links.
3. **Intermediate page with GET redirect.** `/confirm-invite` redirected to Supabase verify URL on Continue button click. Gmail's scanner followed the redirect chain too.
4. **Intermediate page with POST verifyOtp + `{{ .Token }}`.** Right architecture (POST), wrong token format. Server returned 403 because `{{ .Token }}` is a short OTP, not a hash.
5. **Intermediate page with POST verifyOtp + `{{ .TokenHash }}`.** Working. Long hex hash matches `verifyOtp({ token_hash })` expectation.

**Lesson:** When debugging email-flow issues, always inspect the actual link structure in the email (via Gmail's "View original" or the DevTools Elements panel on the email). Don't assume what the template is producing — read the bytes.

### Phantom git diff state on Google Drive folders
- VS Code git extension showing "modified" files that have no actual content drift is a Google Drive sync race condition. Confirmed by `git diff --stat` returning no output despite 5+ files marked modified.
- **Fix:** Wait for Drive to finish syncing, then refresh VS Code source control panel. State clears on its own.
- **Long-term:** Migrate the working repo off Google Drive to a local SSD path (e.g., `C:\dev\skynet`). Use git itself for cross-machine sync, not Drive.

### Supabase dual-environment migrations
- Test and production are separate Supabase projects. Schema migrations must be run on BOTH or test will lag behind. Discovered when test environment hit `column profiles.username does not exist` after running a migration on production only.
- **Pattern:** SQL Editor in Supabase Dashboard, paste migration, run. Repeat on the second project.

### Email template paste regression
- When updating Supabase email templates with new HTML, if you start from an older base template, the link format may revert from `/confirm-invite?token={{ .TokenHash }}` to the default `{{ .ConfirmationURL }}`. Always re-verify the link format after pasting.
- **Pattern:** After saving a template, send a test email to yourself, view source, confirm the link is the SkyNet `/confirm-invite` URL — not the raw Supabase verify URL.

### CC prompt format
- Always include "BEFORE STARTING: Read Docs/Decisions.md and Docs/S4_GoLive_Implementation_Plan.md in full" preamble.
- Surgical changes only — exact file, exact lines, exact conditions. Never broad rewrites.
- SQL migrations go in separate code blocks for direct paste into Supabase SQL Editor.
- For new files: deliver as ENTIRE FILES, not Find/Replace blocks. Search/replace patches in CC for full files have failed reliably enough to avoid them.

### Diagnose-before-fix
- Targeted SQL or DOM inspection before any code change. Multiple "React bugs" turned out to be missing RLS policies or wrong email template variables. Two examples this sprint:
  - Rack assignment dropdown not saving → assumed React state bug → was missing RLS UPDATE policy on `material_receiving`
  - Invite link otp_expired → assumed PKCE config issue → was Gmail scanner consuming the GET URL

---

## Sprint 8 — Job-Level Shortfall & Allocation Resolution (May 15, 2026)

Sprint 8 supersedes the Sprint 6 WO-level shortfall feature. Shortfalls become a per-job concern: every job that completes with produced < target gets its own resolution row, and the scheduler resolves each short job through a unified Allocation modal. Spec bump v3.0 → v3.1.

### D-S8-01 — Shortfall granularity: job-level
- **Decision:** Each job with produced < target generates its own `job_shortfall_resolutions` row.
- **Why:** The WO-level model required all jobs on a multi-job WO to reach near-terminal status before a shortfall surfaced. Scheduler couldn't intervene while sibling jobs were still running. Per-job rows surface immediately.

### D-S8-02 — Trigger states
- **Decision:** Shortfall evaluation fires from (a) kiosk Complete Job after `good_pieces` is written, and (b) Compliance post-mfg Accept after `post_mfg_good_qty` is written. Cancelled jobs never trigger.
- **Why:** These are the two moments where the produced count becomes authoritative. Pre-mfg or in-progress states don't have a meaningful "produced" value yet.

### D-S8-03 — Produced calculation
- **Decision:** `COALESCE(post_mfg_good_qty, good_pieces, 0)`. Compliance-verified count takes precedence over operator count.
- **Why:** If Roger downgrades the count at post-mfg, that becomes the source of truth, even if it's below `good_pieces`.

### D-S8-04 — WO target calculation
- **Decision:** WO target = `stock_quantity + order_quantity`. Single-product WO assumed.
- **Why:** No `total_quantity` column exists. Multi-product WO support is deferred (Section 13 backlog).

### D-S8-05 — Allocation flow: manual entry
- **Decision:** No pre-fill, no FIFO suggestions, no auto-distribute in the Allocation modal Step 1. Manual per-CO entry.
- **Why:** Intentional friction. The scarcity decision (who gets cut when there isn't enough to go around) needs to be a conscious human choice, not an algorithm.

### D-S8-06 — Excess handling
- **Decision:** Allocated < produced → remainder auto-flows to stock implicitly. No explicit stock writes.
- **Why:** Stock is residual on the WO (`stock_quantity` field). Whatever the scheduler doesn't allocate to a CO line is by definition stock.

### D-S8-07 — Partial allocation effect (REVISED mid-sprint)
- **Decision:** Allocated < existing `quantity_allocated` → deactivate the allocation row (`is_active = false`) **EXCEPT** for Re-queue, which leaves the allocation active.
- **Original ruling:** Always deactivate on partial — return remainder to demand pool.
- **Why revised:** For Accept Short, deactivation is correct (this WO is not making the rest). For Re-queue, the user has just committed to making the rest from a new job *on this same WO*. Deactivating broke the demand-tracking story — the Miami test case made it visible. Allocations are WO→CO, so the new RQ job naturally inherits an active allocation; the bug was deactivating it.
- **Fix shipped in v3.1.**

### D-S8-08 — Resolution outcomes (REVISED mid-sprint)
- **Decision:** Two outcomes: **Re-queue** (close + new job for the gap at `pending_compliance`) and **Accept Short** (close, required reason).
- **Original ruling:** Three — Accept Short, Re-queue, Cancel Shortfall.
- **Why revised:** Accept Short and Cancel Shortfall did the same thing to the data (commit allocations, deactivate partials, leave unfulfilled CO portions in demand). Only difference was reason-required ceremony. Merging removes a false subdivision and the more rigorous "reason required" behavior wins.
- **DB compatibility:** The resolution CHECK constraint still accepts the legacy `cancel_shortfall` value so the 5 cleaned-up test artifacts (J-000003/05/07/16/17) don't violate; the modal just stops writing it.

### D-S8-09 — Re-queue WO target
- **Decision:** New job goes on the **same** WO. No "new WO" option.
- **Why:** Sibling demand and stock targets live on the WO; a new WO would orphan them. The handful of cases where a new WO is genuinely warranted are rare enough to handle manually.

### D-S8-10 — Re-queue structural anchor
- **Decision:** `work_order_assemblies` remains the structural anchor (provides `work_order_assembly_id` for the new job). However, the new job's `component_id` must come from the shorting job, NOT from `work_order_assemblies.assembly_id`. Same correction applies to the `part_documents` and `part_routing_steps` lookups feeding the new job.
- **Why:** For assembly WOs, `WOA.assembly_id` points to the parent assembly, but jobs make components. Verified manually in the May 15 J-000018 manual split. The code originally used `woa.assembly_id` for both purposes, which is a latent assembly bug. Single-part WOs (test case SK212-12S) didn't expose it because component_id == assembly_id; assembly WOs would have.
- **Fix shipped in v3.1 alongside D-S8-07.**

### D-S8-11 — Re-queue documents pull-forward
- **Decision:** Auto-pull current `part_documents` (`is_current = true`) into `job_documents` at `source = 'part_pulled_forward'`. Filtered by the shorting job's component_id (per D-S8-10).

### D-S8-12 — WO row badge derivation
- **Decision:** Derived via EXISTS check against `job_shortfall_resolutions` where `status = 'open'`. `work_orders.has_open_shortfall` column deprecated, physical drop deferred.
- **Why:** WO badge follows the underlying truth (any job on this WO has an open shortfall) instead of a denormalized flag that can drift.

### D-S8-13 — Card action UX: single Allocate button
- **Decision:** Each card has one Allocate button. Outcome chosen inside the modal at Step 2.
- **Why:** Three buttons (Accept Short / Re-queue / Cancel) implied the outcome was decided before the user even saw the allocation table. The actual decision sequence is: see produced vs target, allocate the produced amount, then pick what to do with the gap.

### D-S8-14 — Card visibility (job-centric)
- **Decision:** Card primary line: `Job # · Part # · Machine`. Parent WO as secondary line. Chevron expands per-CO detail.
- **Why:** The scheduler thinks in jobs, not WOs, when resolving a specific shortage.

### D-S8-15 — Open Shortfalls KPI tile: removed
- **Decision:** No KPI tile on Mainframe. Discovery via WO Lookup → Shortfalls tab only.
- **Why:** Tiles compete for limited Mainframe real estate. Shortfalls are not a daily-frequency event; making them a tab destination is enough.

### D-S8-16 — Finishing-batch advance: effective target = good_pieces (NEW)
- **Decision:** `ComplianceReview.handleApproveBatch` advance check compares total sent to `jobs.good_pieces` (operator-confirmed count), falling back to `jobs.quantity` when `good_pieces` is null (in-flight multi-batch jobs).
- **Why:** When the operator overrides at kiosk Complete (short job), `good_pieces < quantity`. The old `totalSentQty >= jobQty` check could never satisfy, leaving the job stranded at `manufacturing_complete` even after finishing + compliance accept. Exposed by Sprint 8 because Re-queue makes the override case routine; latent before then.

### D-S8-17 — Auto-fulfill on TCO entry (SHIPPED — SKY65, June 3 2026)
- **Decision:** When a re-queue job (identified by `job_shortfall_resolutions.requeue_job_id`) advances past compliance review, auto-fulfill the WO's active CO allocations from its `good_pieces`. Distribution: FIFO by `due_date` asc, then priority (`critical > high > normal > low`). Per-allocation cap = min(remaining good_pieces, CO remaining, WO commitment remaining). Excess flows to stock.
- **Idempotency:** Guarded by `job_shortfall_resolutions.fulfillment_applied_at` timestamp. Re-firing is a no-op.
- **Status:** SHIPPED via SKY65 (June 3 2026). Generalized from the original RQ-only/at-compliance design: fulfillment now fires for **all** jobs on entry into `pending_tco` (after final compliance + any outsourcing). Implemented as a DB trigger (`trg_fulfill_co_on_tco` → `fulfill_co_on_tco_entry` → `fulfill_co_for_job`), not app code, because `pending_tco` is written from 7+ paths. Quantity source is `job_effective_qty()` — a SQL mirror of `effectiveQty.js` (outsourcing returns → compliance-approved finishing → good_pieces → missed entries) — not raw `good_pieces`, so outsourced/finished counts are correct. Idempotency moved to `jobs.co_fulfillment_applied_at`. The three RQ early-fire calls and the `coFulfillment.js` import were removed from `ComplianceReview.jsx`; the helper and `job_shortfall_resolutions.fulfillment_applied_at` are now dead (left in place, drop later). One-time backfill cleared existing `pending_tco` jobs on test + prod.
- **Parity note:** the shipped FIFO ranks priority high/normal/low only — a `critical` CO line currently sorts as `normal`, diverging from the "critical > high > normal > low" above. Align in `fulfill_co_for_job` (and any UI) if critical should ever jump the queue.

### Multi-source CO caveat (noted, not yet a decision)
- The auto-fulfill helper's per-WO commitment math assumes single-source COs (one allocation row per CO line). When the Shipping module brings multi-source COs into play, the formula `quantity_allocated − quantity_fulfilled` over-fulfills because it can't distinguish per-WO contribution.
- Tracking as a known edge case until Shipping sprint addresses it.

---

## Operational Notes (Sprint 8 additions)

### The May 15 deploy incident
Mid-session push of in-flight allocation work to main and Amplify deployed it to prod. Prod broke (WOs invisible — frontend queried `job_shortfall_resolutions`, which didn't exist on prod). Recovery:
1. Amplify rolled back to prior build artifact (no rebuild)
2. `git reset` main to `bed451d`, force-push
3. Clean `hotfix/compliance-qty-override` branch carrying ONLY the role-change content
4. Merged hotfix → main as `5684a04`
5. Test reset to match main

**Lesson:** Direct prod-touching merges require the migration + code pair shipped together. The schema must be on prod *before* the code references it. Going forward: every cutover follows the apply-SQL-to-prod-first procedure even when the code change feels small.

### Mid-sprint design pivots
Sprint 8 had two mid-sprint reversals (D-S8-07 and D-S8-08), both caught during real test scenarios on `test-skynet.skybolt.com`. Both were discovered by Matt running through realistic flows, not by static review. Reinforces: testing on the deployed environment with real data shapes catches things that local-dev-against-test does not.

### Prod-touch discipline
For Sprint 8 cutover, prod schema received the four S8 migrations (backfill, workflow, pivot, idempotency) ahead of the test→main git merge. RLS audit on the new `job_shortfall_resolutions` table confirmed all four DML policies (SELECT, INSERT, UPDATE, DELETE) present. The pivot brought 0 rows forward (no prior `wo_shortfall_resolutions` open rows on prod) — clean cutover, no data motion.

### Git hygiene after May 15
- `feature/allocation-saved` was the branch name used for the Sprint 8 work — name predates the handoff's `feature/job-shortfall` rename suggestion. Cosmetic discrepancy; content is correct.
- After this push, recommend collapsing `feature/allocation-saved`, `feature/allocation-standby`, and any other parked branches that have been fully merged. Single feature branch per sprint going forward.
- The Google Drive repo location remains a latent risk. Migrating off it stays on the backlog.

## Sprint 7 — RLS Security Hardening (May 16, 2026)

### Sprint scope and outcome
- **8 migrations** shipped to test and prod in one day, zero rollbacks, zero user-facing breakage.
- **11 tables** moved from RLS-disabled to RLS-enabled. New baseline: zero public tables without RLS.
- **5 anon SELECT exposures** removed (customer_orders, customer_order_lines, customer_order_allocations, customers, job_documents). 2 intentional anon surfaces preserved (locations, machines — kiosk pre-auth).
- **`wo_shortfall_resolutions`** dropped (deprecated by S8 pivot; zero refs in src/, zero rows on prod).
- **Spec bumped** v3.1 → v3.2.

### D-S7-01 — Access matrix v1 (6 profiles)
- **Decision:** Every public table maps to one of six policy profiles:
  - **A** AUTH-FLAT — authenticated `USING(true)` for all 4 ops (default)
  - **B** AUTH-FLAT + ANON-SELECT — adds intentional anon SELECT (kiosk pre-auth)
  - **C** ROLE-RESTRICTED-CO — admin/scheduler/customer_service writes (customer family)
  - **D** ROLE-RESTRICTED-ADMIN — admin-only writes (materials, tools, etc.)
  - **E** SERVICE-ROLE-ONLY — no auth policies (`lot_number_sequences`, `import_*_staging`)
  - **F** AUDIT-INTEGRITY — SELECT + INSERT only, no UPDATE/DELETE (`audit_logs`)
- **Why:** Existing production already had role-based restrictions on 13 tables that the original plan would have flattened. Preserving them (per the "RLS mirrors UI gating" principle from S4) required broader profile taxonomy than the plan's single "AUTH-FLAT" default.
- **Snapshot:** `Docs/RLS_Access_Matrix_v2.md` (committed). 43 tables mapped.

### D-S7-02 — Drop `wo_shortfall_resolutions`
- **Decision:** Drop the table entirely; the S8 pivot to job-level shortfalls superseded it.
- **Why:** Zero src/ references (verified by grep), zero rows on prod at cutover, zero objects depending on it (FKs, views, functions). Maintaining policies on a dead table is technical debt.
- **Verification before drop:** Cross-checked dependencies via `information_schema.table_constraints`, `pg_depend`, and `information_schema.routines`. All clean.

### D-S7-03 — `audit_logs` → Profile F (append-only integrity)
- **Decision:** Auth users can SELECT and INSERT, but UPDATE and DELETE have no policies (denied for all non-service-role).
- **Why:** AS9100 / FAA audit posture wants tamper resistance. With Profile F, no client (anon or auth) can alter or wipe audit records. Service role bypasses for legitimate admin cleanup. Profile E (full lockdown) was rejected because 11 frontend insert sites use the `from('audit_logs').insert(...)` pattern with the anon/auth key — refactoring them behind an Edge Function is out of scope. Profile F gets the integrity win without the refactor cost.
- **Tradeoff acknowledged:** Forged INSERTs still possible (auth user can write a record claiming someone else did the action). Backlog item: move INSERTs behind an Edge Function, then graduate F → E.

### D-S7-04 — `lot_number_sequences` → Profile E (service-role-only writes)
- **Decision:** Auth users can SELECT (read current sequence state). INSERT/UPDATE/DELETE service-role only. All writes happen via SECURITY DEFINER RPCs (`next_finishing_lot_number`, `next_lot_number`, `next_standalone_finishing_job_number`).
- **Why:** Lot number generation must be atomic. Direct UPDATE access from the client defeats the atomicity guarantee. RPCs running as SECURITY DEFINER bypass RLS by design, so the lockdown doesn't break the kiosk's PLN generation or finishing's FLN generation.
- **Prerequisite migration:** `next_lot_number` and `next_standalone_finishing_job_number` were not SECURITY DEFINER before S7. M7 includes `ALTER FUNCTION ... SECURITY DEFINER` for both, applied in the same transaction as the `lot_number_sequences` RLS lockdown.

### D-S7-05 — `profiles` SELECT scope: keep broad
- **Decision:** `profiles` SELECT remains broad (`USING(true)` for authenticated). The redundant narrow policy ("Users can view own profile" / `auth.uid() = id`) was dropped.
- **Why:** Narrow SELECT would break 4 paths: (1) finishing kiosk PIN auth, (2) main kiosk session restore, (3) admin Users tab, (4) salespeople dropdown on customer order forms. Eliminating those dependencies requires PIN hashing (S5 backlog) AND migrating Finishing.jsx to a JWT-per-PIN pattern (new S7 backlog). Until both land, narrow is not viable.
- **Win that did happen:** RLS enabled means anon (the JS-bundle key) can no longer read profiles. Plain-text PIN exposure to authenticated users persists, but anon exposure (the larger attack surface) is closed.

### D-S7-06 — Preserve role-based restrictions on 13 tables
- **Decision:** Profile C, D, and A* (auth-flat with role overlay) preserved on customer_orders/lines/allocations/customers, materials, material_receiving, material_usage, tools, tool_instances, part_machine_durations, machine_downtime_logs, job_tools, work_order_assembly_routing_steps.
- **Why:** Decisions.md §"Role-based UI gating" (S4) explicitly calls RLS the defense-in-depth mirror of UI role gating. Flattening to AUTH-FLAT would loosen these tables vs current production behavior. Preserving them required broader profile taxonomy in the access matrix (D-S7-01).
- **Operational impact:** Adding a new role (e.g. future `shipping` role) requires updating the EXISTS-check policies on the 13 affected tables. Same speed-bump as adding the role to UI gating maps and to `kiosk-authenticate` `ALLOWED_ROLES` — not a new friction, just an explicit one.

### D-S7-07 — Anon access whitelist
- **Decision:** Exactly 2 anon-readable tables: `machines` (`WHERE is_active = true`) and `locations`. Everything else loses anon access in S7.
- **Why:** Both serve the kiosk PIN screen (which is pre-auth). After Sprint 6's `kiosk-authenticate` Edge Function rollout, all post-PIN kiosk traffic runs as authenticated, so no other table needs anon access.
- **Future additions** to the anon whitelist require explicit Decisions.md justification.

### D-S7-08 — CI guardrail SQL
- **Decision:** A SQL check that returns rows only for public tables violating the security baseline (RLS disabled, or zero policies + not on service-role-only allowlist). Wired into CI to fail builds.
- **File:** `Docs/migrations/rls_guardrail.sql` (committed).
- **Why:** Without an automated gate, new tables added in future sprints would silently drift back into the pre-S7 state. The guardrail is policy-as-code for the security baseline.
- **Allowlist maintenance:** The two import_*_staging tables are intentional Profile E and listed in the guardrail's CTE. Adding new service-role-only tables requires updating the CTE AND adding a Decisions.md entry.

---

## Operational Notes (Sprint 7 additions)

### One-day execution discipline
Sprint 7 shipped 8 migrations across test and prod in a single Saturday session. Pattern that worked:
- Single playbook doc (`Sprint7_Batch_C_Migrations.md`) with one section per migration, each self-contained (BEGIN/COMMIT, verification SELECT, regression checklist)
- Strict order: test → regression → prod, one migration at a time
- Verification numbers predicted in advance so deviation was immediately visible
- Two near-misses (M9 prod-promotion gate initially run against test by mistake; M1 verification run without the migration block) — both caught by independent verification rather than blind trust

### Schema dump aren't snapshot-perfect
`Supabase_SQL_Database.txt` schema dumps from the SQL Editor format CHECK constraints differently than the underlying database, producing cosmetic diffs that look like drift but aren't. Real drift (two cases discovered during S7) needs CHECK constraint inspection, not text diff.

### Edge Function audit log writes silently failing
Discovered during S7 prep — Edge Function `audit_logs.insert(...)` calls use column names that don't exist in the schema (`actor_id`, `action`, `target_type`, `target_id` vs schema's `event_type`, `job_id`, `machine_id`, `operator_id`). The Supabase client's `insert()` returns `{ data, error }` but the Edge Functions don't check the error and don't await it as a throwing call, so every Edge Function audit log write since deployment has silently failed. Frontend `audit_logs` inserts use the correct schema columns and work. Bug logged in backlog; not S7 scope.

### Finishing kiosk auth model
Discovered during S7 prep — `Finishing.jsx` is mounted on `/finishing` outside the `MainApp` authenticated route group, but operates as authenticated because the finishing computer has a persisted Supabase auth session from a prior login. PIN entry identifies the operator in React state, not Supabase auth. This means `audit_logs.actor_id` on finishing entries reflects the persisted session's user, not the PIN-identified operator. Backlog: migrate Finishing.jsx to a `kiosk-authenticate`-style Edge Function flow.

### S3 bucket CORS test origin
Added `https://test-skynet.skybolt.com` to `skynet-files-skybolt` bucket CORS during S7 regression. Document upload from test was previously CORS-blocked. Now works on both environments.

### Test environment CHECK constraint drift
Discovered + fixed during M9 regression: `job_shortfall_resolutions.resolution` CHECK on test was missing `'acknowledge_plan'` (prod had it). Plan-only shortfall "Acknowledge" button errored on test. Constraint updated on test to match prod. Same drift pattern flagged for `outbound_sends.source_type` (test missing NULL allowance) — pending fix, not user-visible today.

---

## 2026-05-16 — v3.3 Cleanup Release (S7 closeout)

Bugfix-only release closing six items from the S7 backlog. No user-facing
behavior change other than the compliance Additional Documents fix.

**Shipped:**
- **Issue 1** — Edge Function `audit_logs` column rename. `manage-users` and
  `kiosk-authenticate` now write `event_type/operator_id/details` (correct
  schema) instead of `action/actor_id/target_type/target_id` (nonexistent).
  Errors are now captured and logged via `console.error` instead of silently
  swallowed. Restored audit trail for every user-management and PIN-auth event.

- **Issue 2** — ComplianceReview Pre-Mfg Additional Documents not displaying
  modal-uploaded docs. **Root cause was different from what the backlog
  recorded.** The backlog described it as a state-refresh miss in
  `handleAdditionalUpload`. The actual bug was a filter contract mismatch:
  the Pre-Mfg "Additional Documents" surface (line 2150 in
  ComplianceReview.jsx) uses `AddJobDocumentModal` for uploads, which
  forces a typed `document_type_id` on insert. The display filter at line
  2167 only showed docs with NULL `document_type_id`, so every
  modal-uploaded doc went into the DB successfully but never displayed.
  Fix: broadened the filter to show any doc whose `document_type_id` is not
  in the Required Documents list for this stage. As a side note, the
  `handleAdditionalUpload` handler (lines 942-974) also got the
  `fetchPendingBatches()`/`fetchRecentlyApprovedBatches()` calls added to
  match the `handleDeleteDocument` pattern — harmless and consistent with
  the other state-mutation handlers, kept in. The two other Additional
  Documents surfaces (post-mfg batch context line 2807, post-mfg job context
  line 3301) still use `handleAdditionalUpload` with inline file pickers
  that insert NULL `document_type_id`, so their existing
  `!d.document_type_id` filters remain correct.

- **Issue 3** — Dropped duplicate SELECT policy `Allow authenticated read`
  on `public.job_documents`. The M8 naming-convention policy
  `job_documents_select_authenticated` remains.

- **Issue 8** — `tools` / `tool_instances` tagged as dormant master data
  (see entry below). No code or schema change.

- **Issue 9** — Aligned test environment's `outbound_sends.source_type`
  CHECK constraint to prod (NULL now permitted). Closed a test/prod drift
  introduced at unknown date.

- **Issue 11** — Wired `rls_guardrail.sql` into a GitHub Actions workflow
  (`.github/workflows/rls-guardrail.yml`) that runs against the TEST
  Supabase on every PR to `main` or `test` and on push to `main`. Build
  fails if any public table has RLS disabled or zero policies (with the
  service-role-only allowlist as the documented exception).

**Deferred to a future auth-hardening sprint** (closely-coupled, will
share a feature branch when scheduled):
- Migrate `Finishing.jsx` to JWT-per-PIN auth pattern (matches Kiosk.jsx)
- Move `audit_logs` INSERTs behind an Edge Function (Profile F → Profile E)
- Narrow `profiles` SELECT to `auth.uid() = id` (blocked by the above + PIN hashing)

**Process learning:** Backlog descriptions are working hypotheses, not
diagnoses. The Issue 2 backlog entry described a state-refresh miss
because that's what symptom-walking suggested at the time. The actual root
cause (filter/upload-path contract mismatch on the Pre-Mfg surface) only
surfaced when we ran the fix and the symptom persisted. Worth a habit:
before declaring a backlog item "small," verify the upload path being
clicked actually maps to the handler the entry names.

---

## 2026-05-16 — `tools` and `tool_instances` are dormant master data

**Status:** Active in schema, dormant in workflow. Not vestigial; reserved
for future resurrection.

**Tables:**
- `public.tools` — catalog of tool types (name, tool_type, description)
- `public.tool_instances` — physical inventory per tool (serial_number,
  status [good/bad/discarded], notes, logged_by, logged_at)

**Original 3-tier model:**
`tools` → `tool_instances` → `job_tools` (which physical tool on which job)

**Current state:** `job_tools` is active and heavily used by `Kiosk.jsx`
(20+ call sites including the tooling-override flow). It carries
`tool_instance_id` as a nullable FK alongside its own free-text
`tool_name`, `tool_type`, and `serial_number` columns. When tooling was
removed from the active workflow, `job_tools` was relaxed to free-text
entry, and the parent tables (`tools`, `tool_instances`) went dormant.

**Why we don't drop them:**
1. `job_tools.tool_instance_id` FK to `tool_instances` would force either
   a constraint drop (leaving an orphan column) or a column drop
   (destroying schema evidence of the original normalized design).
2. Tooling is planned to be resurrected; dropping the master tables
   means rebuilding the model from scratch later.

**RLS posture:** Authenticated SELECT/INSERT/UPDATE/DELETE policies remain
in place per the v1 access matrix default profile. No service-role-only
move. Attack surface is small: no PII, no operational data, two
near-empty tables.

**When tooling is resurrected:** these tables already have the right
shape. The work will be in `job_tools` (require `tool_instance_id` not
null, deprecate the free-text columns or use them as fallback only) and
the Kiosk UI (a real picker instead of free-text). No schema work needed
on the master tables themselves.

---

## 2026-05-17 — Part number is primary across machinist & scheduler surfaces

**Decision:** On Mainframe (machine view + Active/Unassigned/Compliance detail lists), Schedule list view, Kiosk job lineup, and ComplianceReview row displays, `part_number` occupies the primary white-font-mono slot. `job_number` is demoted to a smaller `text-skynet-accent font-mono` secondary slot. Maintenance jobs (no part_number) continue to show `job_number` in the primary slot.

**Why:** Operators identify work by part number; job numbers are auto-generated and carry no meaning to the shop floor or CS team. Closes SKY27 and SKY37 from the go-live issue list.

**Side decision — Finished: X/Y badge (SKY38):** On the Mainframe MachineCard's active-job tile, a small badge in the top-right shows `Finished: X/Y` where X = sum of `compliance_good_qty` for finishing_sends with `compliance_outcome = 'accepted'` for that job, Y = `job.quantity`. Job-level (not WO-level) per Matt's confirmation. Maintenance jobs and jobs with quantity 0 do not render the badge.

**Data path:** Mainframe `fetchData` now issues an extra query against `finishing_sends` filtered by accepted outcome and the active job IDs, then attaches `finished_qty` to each job before `setJobs`. One additional round-trip per dashboard refresh; payload is small (one int per active job).

**Addendum — same date:** Extended scope to the Kiosk active job header, Kiosk Previous Jobs section, and all four Finishing station surfaces (batch row, batch detail, kanban card, pickup table). Customer name on the Kiosk active job header now derives from `customer_order_allocations` via `summarizeWOAllocations`/`CustomerDisplay` (the existing CO-derived display helpers in `lib/workOrderDisplay.js`), with the legacy `work_order.customer` text field retained as fallback. This closes the customer-visibility ask in SKY03 (the legacy field is empty for newly-created WOs from COs, so the previous "already shows customer" assessment was incorrect for current data).

---

## 2026-05-17 — Production Dashboard (SKY47) Batch A — scaffold and 3 sections

**Decision:** New `/dashboards/production` route, listed first in the `DASHBOARDS` menu in `App.jsx`. Refresh interval is 60s via `setInterval` polling (no Supabase realtime channels — meeting-cadence display, not transactional). Layout is a fixed 12-column grid: top row 3/6/3 (Yesterday / Today / Machine Status), bottom strip 12 (Quality). No scrolling — designed for a 1920×1080 TV at Leesburg.

**"Parts made" measurement:** Per Matt, the "post-dry verified" count (`finishing_sends.verified_count` where `verified_at IS NOT NULL`) is the authoritative number, not `jobs.good_pieces` (machinist-entered at job complete) or `finishing_sends.quantity` (machinist-entered when sending). Finishing staff verify the count after the dry step, before compliance handoff — this is the trusted signal. Used for both Yesterday's "Passed finishing" counter and (in Batch B) the active-job target indicator. Distinct from the MachineCard "Finished: X/Y" badge introduced earlier today, which uses `compliance_good_qty` (compliance-verified, end-of-line truth). Both are correct for their context.

**Machine scope:** `machine_type != 'finishing' AND is_active = true` produces the 4 status tiles. Inactive production machines (currently BM-6, on order from OEM) render in a separate "Offline" strip below the tiles so they're visible but don't pollute the live status counts. State priority: down → setup → running → idle.

**Quality window:** Calendar 5 days back via `compliance_approved_at >= NOW() - INTERVAL '5 days'`. Capped at 5 rows per outcome column (rejected/rework). No pagination — short window keeps the meeting focused on recent events.

**Today's Production section is a placeholder in Batch A** with three dashed boxes for the active-jobs panel, changeovers panel, and a working "Demand" counter (open customer orders). Batch B fills in the active-jobs target indicator, changeovers logic, and finalizes the section.

---

## 2026-05-17 — Scheduling rebuild: order-positioned, not datetime-positioned (Batch A foundation)

**Decision:** The scheduler will no longer enter datetimes. The new paradigm is: scheduler picks a machine, picks a position in that machine's queue, and enters an estimated duration (days + hours). The system derives `scheduled_start`/`scheduled_end` by propagating from the previous job's `scheduled_end`. This rebuild ships in three batches — A (quick wins, this entry), B (new Schedule modal), C (drag-drop integration + in-modal reorder).

**Why now:** April (scheduler) has consistently struggled with the existing datetime-entry modal because she doesn't know clock times for upcoming jobs, only their relative order. The existing model also produces zero-duration data in PROD (`scheduled_start = scheduled_end`), which breaks multi-week grid visibility (the Image 1/Image 2 bug Matt flagged on May 17).

**Batch A — what shipped today:**

- **SKY21 — Mainframe Unassigned includes pending-compliance jobs.** Filter expanded from `status='ready'` to also include `status='pending_compliance' AND assigned_machine_id IS NULL`. Detail view gains a small amber "Pending Compliance" badge so the scheduler can distinguish unapproved-but-plannable jobs from ready-to-go jobs at a glance. Schedule.jsx already did this — Mainframe was the asymmetry.
- **Issue 1 — multi-week grid filter.** Schedule grid query switched from "scheduled_start within the week" to interval overlap: a job appears in week W if `[scheduled_start, scheduled_end]` overlaps `[week_start, week_end]`. Legacy carryover for ongoing-status jobs with NULL `scheduled_end` is preserved as a third OR branch.

**Known limitation (Batch A):** Existing PROD data has zero-duration jobs (`scheduled_start = scheduled_end`). Interval overlap does not help these — they continue to display only in the week their `scheduled_start` falls in. The visibility fix takes effect for jobs scheduled under the new Batch B flow once it ships and real durations are entered.

**Batches B and C will receive their own Decisions entries when they ship.**

---

## 2026-05-17 — Scheduling rebuild Batch B — new 3-step Schedule modal

**Decision:** `ScheduleJobModal.jsx` fully rewritten as a 3-step flow: (1) pick machine, (2) pick position in the machine's queue, (3) enter estimated duration in days + hours. The system computes `scheduled_start`/`scheduled_end` via forward propagation from the running job (or now if no running job). The scheduler never enters a datetime. Old datetime-entry modal (~1000 lines) is replaced entirely.

**Helper module:** `src/lib/scheduling.js` (new) is the single source of truth for the queue model — `getMachineQueue`, `isJobRunning`, `jobDuration`, `buildPropagatedQueue`, `formatDurationDH`, `applySchedule`. Pure functions plus one async DB-write helper. Reused by Batch C's drag-drop integration and any future shift handling.

**Propagation model:** Sequential client-side updates. Cascade jobs first (push downstream out of the way), then write the target job's slot. Non-atomic. Acceptable risk at Skybolt's scale (single active scheduler). Promote to a Postgres RPC if races appear.

**Modal entry points (Batch B):**
- Schedule button on an Unassigned-bucket job → opens at Step 1 (full machine picker)
- "Reschedule" on an existing scheduled job (edit mode) → opens at Step 2 with current machine pre-selected and current queue position pre-highlighted; duration pre-filled from `estimated_minutes` (or the diff between `scheduled_end` and `scheduled_start` if `estimated_minutes` is null)
- Drag-drop from list view onto a machine cell (Batch C will wire this) → opens at Step 2 with the drop-target machine pre-selected (works today via the existing `defaults.machineId` prop, but the drop UX itself is Batch C)

**Legacy data handling:** When the propagation walker encounters a job whose duration cannot be derived (`estimated_minutes` null AND `scheduled_end === scheduled_start`), the walker keeps that job's existing times unchanged and advances the cursor to its existing `scheduled_end`. Downstream cascading past such a job may produce overlap until the legacy job is itself rescheduled under the new flow. Documented limitation.

**Status transitions preserved:**
- `pending_compliance` → stays `pending_compliance` after scheduling (just gains machine + times)
- All other statuses → become `assigned`

**Schedule.jsx wire-up:** No changes required. The existing `<ScheduleJobModal>` invocation already passes all props the new modal consumes (`isOpen`, `onClose`, `onSuccess`, `job`, `machines`, `partMachineDurations`, `scheduledJobs`, `profile`, `editMode`, `defaults`, `onReturnToQueue`). The `defaults.date` / `defaults.startTime` fields are now ignored (the modal only reads `defaults.machineId`); the existing drag-drop code paths in Schedule.jsx that set them still work, just with the date/time fields unused.

**Out of scope, deferred to Batch C:**
- Drag-drop UX rebuild (drop-on-machine-row → modal Step 2)
- In-modal drag-reorder for already-queued jobs
- Editing a queued job's duration triggers downstream propagation (currently only "Reschedule" via the modal does this — direct duration edits TBD)

---

## 2026-05-17 — Batch B hotfix: propagation correctness + Step 1 brand grouping

**Two fixes from user testing of the Batch B Schedule modal:**

**Fix 1 — Propagation: pre-insertion jobs no longer shift.**
The walker in `buildPropagatedQueue` previously started its cursor at the running job's `scheduled_end` (or "now" if no running job) and re-timed all jobs in the proposed array — including jobs that were positioned BEFORE the insertion point. Symptom: inserting SK244-42 between SK4C5S and SK4C2P caused SK4C5S to also report as shifting in the Downstream Impact preview. SK4C5S (and all pre-insertion jobs) should remain untouched.

New behavior: pre-insertion jobs keep their current `scheduled_start`/`scheduled_end` exactly. The cursor for the target job's start time is `currentQueue[insertionIndex - 1].scheduled_end`, or "now" only when inserting at index 0 of an empty (or no-running) queue. Post-insertion jobs propagate forward from the target's end.

**Fix 2 — machines.machine_type repurposed Lathe/Mill/Roller → brand values.**
SQL migration `Docs/migrations/2026-05-17_machine_type_to_brand.sql` updates the column in-place: rows are now `'Mazak'`, `'Nexturn'`, `'Ganesh'`, `'Bolt Master'`, or `'finishing'` (unchanged). The only code paths that referenced `machine_type` filtered on `=== 'finishing'` vs `!= 'finishing'`, so this change is non-breaking. Brand grouping is the only meaningful axis for the scheduler — Lathe/Mill/Roller categories carried no operational information.

**Fix 3 — Step 1 layout: location → brand sections, natural-sorted by name.**
Step 1 machine picker now groups machines by location (Leesburg Main Facility first, then Taveres Facility, then any others alphabetically), with brand sub-headers within each location (alphabetical by machine_type), and machines within each brand natural-sorted by name (Mazak 1, 2, 3, ..., 10). The previous "preferred first, queue-depth ascending" sort is removed entirely — operators identify machines by name, not by current availability. The Preferred badge still renders on individual cards; it just no longer affects sort order.

**Side observation (not fixed in this hotfix):** the Tavares facility is stored as "Taveres Facility" (missing the second 'a') in the locations table. Display strings throughout the app reflect this. Worth a one-line SQL UPDATE if desired but not blocking.

---

## 2026-05-17 — Batch B follow-up: close-the-gap option on unschedule

**Decision:** When a job is unscheduled, the user can opt to pull downstream jobs forward to close the gap left behind. This is the symmetric operation to the insert-and-propagate fix shipped earlier today — same propagation engine, inverse direction.

**Helpers added to `src/lib/scheduling.js`:**
- `computeRemovalCascade(currentQueue, removedJobId)` — returns the list of jobs after the removed one whose times need to be shifted forward, walking from the previous job's `scheduled_end` (or the removed job's `scheduled_start` if it was first in queue).
- `applyUnschedule({ supabase, job, cascadeChanges })` — persists the cascade (if any) and then clears the target job's machine + scheduled times in a single helper. Same status transition logic as the old direct-update code: `pending_compliance` stays `pending_compliance`; everything else becomes `ready`.

**UX:**
- The Unschedule Confirmation modal gains a checkbox: "Close the gap — N downstream jobs will move forward to fill the empty slot." Default CHECKED.
- The checkbox is hidden when there are no downstream jobs (unscheduling the last job in a queue, or a job not yet on a machine).
- The "Return to queue" button inside ScheduleJobModal (edit mode) no longer writes to the DB directly. It now routes through the same Unschedule Confirmation modal, so the gap-closing option appears for that flow too. One UI, one code path.

**Legacy data handling:** Same as the insert cascade — when the removal walker encounters a job with no derivable duration, the walker keeps that job's existing times and advances the cursor to its `scheduled_end`. Subsequent jobs propagate from there.

---

## 2026-05-17 — List-view drag-drop UX simplified (Batch B follow-up)

**Removed the inline "Insert here" and "Insert first" drop zones from the list view.** Pre-rebuild, dragging a job onto a machine row in list view expanded the queue to show per-job insertion slots — the user picked the position inline, before the modal opened. Now that the modal's Step 2 is the canonical position-picker, those inline slots produce a double position-pick (once in the list, once in the modal). They added visual noise and confused the flow.

**New behavior in list view:** dragging a job onto a machine row opens the Schedule modal at Step 2 with the machine pre-selected. The user picks the queue position in the modal. Symmetric for dragging an already-scheduled job between machines (edit mode, machine swap).

**Removed code:** the FIRST_ insertion slot block, the per-job insertion slot block, and the now-orphaned `handleListDropAfterJob` handler. The machine-level drop zone (`handleListDropOnMachine`) is preserved as the single drop target per machine.

**Note:** the timeline (grid) view drag-drop has its own separate handlers (`handleDragOver` / `handleDrop` per cell). Those are untouched by this change and will be revisited in the broader timeline-drag-drop pass (Batch C of the scheduling rebuild).

---

## 2026-05-17 — Group 4: Initial product upload / compliance setup (SKY16 + SKY23)

**Two compliance-setup changes shipped together.**

**SKY23 — All newly-created parts default to is_active=false (BOMUpload only).**
Applies to assemblies, finished goods, manufactured components, and purchased parts created via the BOM upload flow. The existing Sprint 7 "Awaiting Activation" workflow (Armory > Products inactive filter, DemandView "Awaiting Activation" badge, blocked Create WO on inactive parts) handles them from there. Roger/Tom activate parts once setup is verified.

NOTE: Manual part creation via Armory > Parts is unchanged — those still default to is_active=true (the user explicitly picked the toggle). SKY23 specifically targets the bulk-import path because that's where the "imported but unverified" problem originates.

**SKY16 — Manufactured parts auto-receive 3 doc requirements on creation (any path), implemented in JS.**

Two code paths, both write the same 3 rows to `part_document_requirements`:
1. **BOMUpload.jsx** — `handleSave` looks up the 3 `document_types` IDs once at the top of the try block, then after creating each new manufactured component, inserts 3 rows: `drawing`, `production_log_blank`, `material_cert`, all `required_at='compliance_review'`, `is_required=true`.
2. **Armory.jsx** — `openPartModal` for a new manufactured part pre-populates `docRequirements` state with the same 3 entries. They render in the Document Requirements section as soon as the modal opens. User can edit/remove/add before saving. `savePart` already persists whatever's in state, so no save-side changes were needed.

**Why JS not a trigger:** the original approach was a Postgres trigger AFTER INSERT on `parts` WHEN part_type='manufactured'. That fired correctly but couldn't pre-populate the Armory modal before save — the user opened the form and saw an empty Document Requirements section, since DB rows didn't exist yet. Moving the logic to JS makes "what you see in the modal is what gets saved" the single mental model, at the cost of two code paths instead of one. The trigger was dropped via `Docs/migrations/2026-05-17_sky16_drop_trigger.sql`.

**Modal limitation:** pre-population happens on modal open based on the part_type at that moment. Changing part_type inside the modal (e.g., from Manufactured to Purchased) does NOT auto-adjust the requirements — user removes/adds manually. Acceptable trade-off; mid-modal part_type changes are rare.

**Optional backfill SQL** for the ~933 existing parts is in `Docs/migrations/2026-05-17_sky16_doc_requirements_backfill.sql`. Idempotent — apply on TEST then PROD if Roger wants the catalog uniform with new parts going forward.

---

## 2026-05-17 — SKY16 follow-up: code name correction + Part Type onChange reset

Two small fixes after testing the prior SKY16 work:

- **Code name:** the 'cert' document_type code is `material_cert`, not `material_certification` (that string doesn't exist in the document_types table — only 2 of 3 requirements were appearing on new manufactured parts). Fixed in `Armory.jsx`, `BOMUpload.jsx`, and the backfill SQL.
- **Part Type onChange reset:** in the Part modal create flow, changing Part Type (e.g., Manufactured → Purchased) now resets docRequirements to match the new type. Manufactured pre-populates the 3 defaults; everything else clears. Edit mode is left alone so existing user configurations aren't blown away. The default-computation logic was factored into a `computeDefaultDocRequirements(partType)` helper at the top of the Armory component so both the modal open and the onChange share one source of truth.

Corrected backfill SQL is in `Docs/migrations/2026-05-17_sky16_doc_requirements_backfill.sql` (idempotent — adds the missing material_cert row to any manufactured part that was given drawing + production_log_blank by the previous buggy version).

---

## 2026-05-18 — Production Dashboard: smart default + date picker

**Problem.** "Yesterday's Output" pulled literal `now - 1 day`, so Sunday/Monday viewing landed on a closed Saturday and showed zeros. Also no way to look back at a specific date — useful for holidays, ad-hoc historical review, or just checking last Tuesday.

**Fix.** Two changes layered together:

1. **Smart default.** A new module-level `lastBusinessDay()` helper walks backward from today until it hits Mon-Fri. Sunday/Monday viewing → Friday, Tuesday → Monday, Wed-Fri → previous day, Saturday → Friday. Becomes the initial value for the new `selectedDate` state.

2. **Date picker.** Native `<input type="date">` in the section header (right side, dark-themed via `colorScheme: 'dark'`). `max` is pinned to today — no future dates. Picking a date updates `selectedDate`, which is in `loadYesterday`'s `useCallback` deps, so the data refetches automatically via the existing polling chain.

Section heading is now dynamic — "Friday's Output" / "Monday's Output" / etc. — based on the selected date's weekday. Subtitle shows the full date for disambiguation.

**Holidays.** This solves manual lookback (pick the day before the holiday to see real numbers). Automatic holiday-aware default is not implemented — Memorial Day Monday will still default to that Monday, so viewer picks Friday May 22 manually. Add a federal holidays list later if it becomes a pattern.

**Timezone note.** All date arithmetic and `<input type="date">` ↔ `Date` conversions use local date parts (year/month/day getters and constructors), not `toISOString`, to avoid UTC midnight drift that would shift the selected day in non-UTC timezones.

---

## 2026-05-18 — Mainframe machine status taxonomy

**Problem.** Machine cards in Mainframe showed "Available" for any machine that wasn't actively producing — uninformative. An idle machine and a machine with 4 jobs queued behind a closed kiosk both said the same thing. Status badge needs to reflect the actual operational state.

**New taxonomy.** Six derived states, computed in `MachineCard.jsx` from machine + job state, priority top-down:

| Status   | Color | Meaning |
|----------|-------|---------|
| Down     | red   | machine.status='down' OR ongoing downtime OR active unplanned maintenance |
| Setup    | blue  | a job is in 'in_setup' on this machine |
| Running  | blue  | a job is in 'in_progress' on this machine |
| Ready    | green | machine is kiosk_enabled AND has queued jobs (just waiting for a machinist to log in) |
| Staged   | amber | machine is NOT kiosk_enabled AND has queued jobs (work is positioned but no kiosk to start from — Wave 2+ rollout pending) |
| Idle     | gray  | no jobs at all |

**Implementation.** Single derived const `derivedStatus` computed once at the top of `MachineCard`. The three display helpers (`getStatusColor`, `getStatusBg`, `getStatusDisplay`) were refactored to key off the new strings. The raw `machine.status` DB column is no longer used in rendering — Down already had its own `isDown` predicate that incorporates downtime and maintenance signals, so the DB column's old 'available' / 'in_use' / 'maintenance' values are now ignored for display purposes.

**Today's mapping (Wave 1 kiosk rollout):** MZ-5 is the only kiosk-enabled machine. So:
- MZ-5 with queue, no active job → **Ready**
- Any other machine with queue, no active job → **Staged**
- When more kiosks come online, those machines will flip from Staged to Ready automatically — no code change needed, just the `machines.kiosk_enabled` toggle.

---

## 2026-05-18 — President's Bridge launched + read-only roles (`president`, `viewer`)

**President's Bridge.** Apollo-themed dashboard at `/bridge`, built for Ned Bowers (Skybolt founder, Apollo program alumnus). Six KPI panels tagged with Apollo flight-controller stations (FLIGHT / GUIDANCE / RETRO / CAPCOM / SURGEON / EECOM). Mission Elapsed Time counts from Skybolt founding day, 23 March 1982. Five parallel Supabase queries on 60s poll: open work orders, machines status, compliance queue, finishing queue, and one master jobs query that derives both the trajectory pipeline and the priority queue. Coming-soon treatment for On-Time Delivery; Assembly panel wakes up when `FEATURES.ASSEMBLY_MODULE` flips true.

**Two new roles in `profiles_role_check`:**
- `president` — Ned. Auto-redirects to `/bridge` on landing at `/`. Once he clicks "BROWSE SKYNET" the redirect doesn't fire again (it's keyed to `window.location.pathname === '/'`). He has read-only access to the main shell.
- `viewer` — generic leadership read-only role. No Bridge access. Lands on the main shell like any other user, sees the read-relevant tab set, all action buttons hidden.

**Read-only enforcement is UI-only.** `src/lib/roles.js` exports `READ_ONLY_ROLES = ['president', 'viewer']` and an `isReadOnlyRole(role)` helper. Main shell renders an amber "READ-ONLY ACCESS" banner across the top for these roles. Primary action buttons (Create WO, Schedule Job, Send Batch, Approve Compliance, etc.) are conditionally rendered via `!isReadOnlyRole(profile?.role)`. RLS policies are not modified — protection is cosmetic. If a read-only user found a way to fire a write directly (browser devtools, API call), RLS would still allow it because their role isn't in the deny path. Acceptable for the threat model: trusted internal viewers, not adversaries.

**Tab visibility for read-only roles:** Mainframe, Schedule, Armory, Compliance, Finishing (status), Customer Orders, Quality, Reports. Hidden: Receiving form, Kiosk routes, Users admin.

**Manual step post-deploy.** Update Ned's profile in PROD: `role = 'president'`, `full_name = 'Ned Bowers'`. Subsequent leadership viewers get `role = 'viewer'`.

**Replaces backlog items:** SKY35 (generic viewer role) — shipped as part of this work.

---

## 2026-05-18 — Read-only banner removed

Per Matt's preference, the amber "READ-ONLY ACCESS" banner that rendered above the main shell for `president` / `viewer` roles is removed. It stacked awkwardly against the existing "TEST ENVIRONMENT — NOT LIVE DATA" banner on TEST, and the action-button gating already provides clear signal that writes aren't available. The `isReadOnlyRole` helper and all button-level gating remain in place.

---

## 2026-05-18 — SKY47 Batch B: Active Jobs + Upcoming Changeovers panels

Closes out the middle "Today's Production" column on the Production Dashboard. Both placeholder boxes from Batch A are now real panels reading live data.

**Active Jobs panel.** Per-job traffic light (red / amber / green / grey) computed in JS after fetch:
- `in_progress` job: `progress_pct = good_pieces / quantity`, `elapsed_pct = (now − production_start) / estimated_minutes`. Green ≥ elapsed − 5%; amber ≥ elapsed − 25%; else red. Grey when no estimate exists.
- `in_setup` job: amber by default; flips red after 2h elapsed setup. No per-part setup estimate exists today, so this is a global hard cutoff — revisit if/when setup duration becomes a tracked attribute.

Sort: red → amber → green → grey, secondary by elapsed-time descending (problem jobs surface first). Visible cap 8; overflow footer "+N more active." Row design: part_number (white, primary), job_number (skynet-accent blue), machine code · name, status badge (SETUP / RUNNING), progress as good/qty plus thin bar, elapsed time, left-border color = traffic light.

**Upcoming Changeovers panel (Interpretation A).** For each machine currently running, show the imminent swap to its next queued job. Two-step query:
1. All `in_setup`/`in_progress` jobs with `assigned_machine_id` + `scheduled_end`.
2. For those machines, all `'ready'` or `'assigned'` jobs with `scheduled_start`, ordered ascending; group by machine in JS, take earliest each.

Pair them; sort by `scheduled_end − now`; cap at 6. Countdown formatting: `Xm` / `Xh Ym` / `Xd Yh`; "OVERDUE" when negative; amber when <1h to changeover.

**Empty states.** Active Jobs: "No active jobs — all machines idle." Changeovers: "No imminent changeovers."

**Polling unchanged at 60s.** The two new loaders join the existing `Promise.all` in `loadAll`.

**Deferred:** per-part setup duration tracking (would make the in_setup traffic light data-driven instead of a 2h global threshold); holiday-aware countdown (currently wall-clock, not business hours). Both fine for v1.

---

## 2026-05-18 — President's Bridge polish pass (post-launch)

Six small changes following Matt's first walkthrough of the live Bridge.

**Machine derived-status helper.** `src/lib/machineStatus.js` exports `deriveMachineStatus(machine, jobsOnMachine, downtimeSignal)` returning one of `down / setup / running / ready / staged / idle`. Logic extracted from `MachineCard.jsx` (now imports the helper) so the Bridge and Mainframe stay in sync on the taxonomy. Single source of truth — future taxonomy changes update both surfaces automatically.

**Drafting divergence noted.** The original prompt drafted the helper's "queued" predicate as `status IN ('ready', 'assigned')`. MachineCard's truth is broader — any job in its input array that isn't `in_setup`/`in_progress` counts as queued, including `pending_compliance`. Mainframe passes `['pending_compliance', 'assigned', 'in_setup', 'in_progress']` jobs to MachineCard, so a `pending_compliance` job on a kiosk-enabled machine surfaces as Ready (correct existing behavior). Helper preserves this — callers control breadth via what they put in `jobsOnMachine`. Bridge passes `['in_setup', 'in_progress', 'ready', 'assigned']` (`pending_compliance` is counted separately in the Compliance Queue KPI).

**Bridge MACHINES ACTIVE panel** now counts machines in Setup + Running + Ready + Staged as "producing" (was: `status = 'in_use'` from the raw DB column, which the May-18 taxonomy decision already retired for Mainframe). Subtitle calls out idle + down counts. Down count tints amber when non-zero.

**Coming Soon standardization.** Assembly Active Jobs panel subtitle changed from "MODULE OFFLINE · AWAITING ACTIVATION" to "COMING SOON · ASSEMBLY MODULE", matching the On-Time Delivery panel's existing "COMING SOON" copy.

**Priority queue.** Expanded from top 3 to top 5 active jobs by quantity. Added the assigned machine code per row (phosphor-dim styling); shows "— UNASSIGNED" in amber for jobs not yet on a machine.

**Dim text legibility.** Bumped the `--muted` CSS var from `#64748b` to `#94a3b8` to lift all the subtitle/footer dim text. Same character of dimness, just less hard to read on the cinema-dark background.

---

## 2026-05-18 — Conditional chemical lot fields (routing-based)

Citric Acid and Alkaline Mix lot fields in the Finishing Station Start Batch modal and the Compliance review screen now hide for batches whose job routing does not include a passivation step. Previously every batch required both fields, forcing operators to fake-fill them for non-stainless work — a real data-integrity issue.

**Predicate.** `src/lib/routing.js` exports `batchRequiresChemicals(routingSteps)` — returns true iff the job's routing has an active step whose `step_name` contains 'passivation' (case-insensitive). "Active" means `status NOT IN ('skipped', 'removed')`. Pending, in_progress, and complete all count — what matters is whether the routing PLANS to include passivation.

**Why routing-based, not material-based.** Earlier same-day draft keyed off `parts.material_type.category`. Broke for Pre-Formed (blank studs are sometimes steel, sometimes stainless underneath) and didn't handle parts whose specific job routing diverges from typical material flow. The routing is the operational truth — if Wash → Passivation → Dry is on the traveler, chemicals are needed; if Wash → Dry only, they aren't.

**Defensive default.** If routing data is missing or empty (shouldn't happen in PROD but possible during edge fetches), return `true` so chemicals appear and the operator is prompted to verify rather than silently skipping required data.

**Schema unchanged.** Both `finishing_sends.chemical_lot_number` and `chemical_lot_number_2` were already nullable. Form persists NULL (not empty string) when hidden.

**Query enrichment.** Every place that loads a finishing batch (or the parent job) for surfaces that show or require chemical lots now joins `routing_steps:job_routing_steps(step_name, status, step_order)`. Applied in `Finishing.jsx` pending + active batch loaders and `ComplianceReview.jsx` pending-batches loader. The per-job manufacturing-complete view in ComplianceReview re-uses the already-fetched `details.routingSteps` array, so no additional fetch.

**Compliance gets the same rule.** Roger's review surface hides the chemical fields for non-passivation batches; identical predicate. Applied in both display sites: per-batch traceability grid and per-job latest-send grid.

**Optional helper text** rendered in place of the hidden fields: "Chemical lot tracking not required — this job's routing does not include passivation." Subtle, italic, matches existing kiosk helper-text style.

**Validation.** The Start Batch button now blocks when `needsChemicals && (!citricAcidLot || !alkalineMixLot)`. Pre-fix the button was already only gated on incoming count — chemical lots were merely warned-on. Tightening this so passivation batches actually require the values they're prompted for.

**Future-proofing.** If passivation step naming ever drifts (e.g., "Citric Passivation", "Nitric Passivation"), the substring match continues to catch it. If naming changes entirely, single point of update in `routing.js`.

**Replaces:** the material-based predicate from the earlier same-day entry. Decision rationale documented above.

**Resolves blocked workflow:** J-000025 (SK4-6P, -6 Stud Steel) which was stuck in James's queue. SK4-6P's routing is Wash → Dry, no Passivation, so chemicals correctly hide.

---

## 2026-05-18 — Production Dashboard accuracy + content overhaul (SKY47 Batch C)

Production Dashboard rewritten across four panels after Matt observed the live dashboard was reporting inaccurate numbers (150K "sent to finishing" was summing batch quantities indiscriminately, including the J-000023 legacy 96,625-piece batch and J-FIN standalone batches).

**Output panel (left column).** "Sent to finishing" / "Passed finishing" replaced with "Passed Finishing" / "Accepted." Passed Finishing = `SUM(verified_count)` from `finishing_sends` where `finishing_completed_at` falls within the selected day and `status = 'finishing_complete'`. Accepted = `SUM(compliance_good_qty)` where `compliance_approved_at` falls within the selected day and `compliance_outcome = 'accepted'`. Both metrics reflect actual flow through Skybolt's quality gates rather than batch creation volume. Parts list below shows top 6 parts accepted that day, grouped by part_number, sorted by qty.

**Machine Status panel (right column).** Now uses `deriveMachineStatus()` from `src/lib/machineStatus.js` (the shared helper created during the Bridge polish work), giving Production / Bridge / Mainframe a single source of truth on machine classification. Buckets adjusted per Matt's call: Running = derived `running + ready + staged` (staged work counts as actively producing); Setup, Down, Idle stay as separate buckets. Idle now means truly idle — no queued or active work. Loader feeds the helper a wide active+queued window (`pending_compliance`, `assigned`, `ready`, `in_setup`, `in_progress`) so a kiosk-enabled machine with only a `pending_compliance` job surfaces as Ready (matching MachineCard truth). Open downtime logs are passed through as the `downtimeSignal` arg.

**Demand panel (middle column, bottom tile).** Replaced "53 open customer orders" count with a top-10 list of parts by remaining demand. Sources `customer_order_lines` rows on open COs, filters to lines with positive remaining qty (`quantity_ordered - quantity_fulfilled > 0`), aggregates by part, sorts descending. Each row shows part number, description (truncated), remaining qty, and earliest due date across the contributing COs. More operationally useful than a raw count — answers "what do we need to make next?" at a glance.

**Active Jobs panel (middle column, top tile).** Two enhancements: (1) delivery date shown per row (from `work_orders.due_date`, appended to the machine-code subtitle as "· DUE Jun 29"); (2) progress metric changed from machinist's `good_pieces / quantity` to `pieces_passed_finishing / target_qty`. `pieces_passed_finishing` is a parallel `SUM(verified_count)` query over `finishing_sends` keyed by `job_id`. `target_qty` resolves as `qty_override ?? quantity` — `qty_override` is a REPLACEMENT for the job's total when set, not a subtraction (corrected from the prompt's draft formula `quantity - qty_override`, verified against Mainframe.jsx line 824). The new displayed metric reflects end-to-end yield rather than just machine output. Note: traffic-light pacing still uses the machinist's `good_pieces / target_qty` as input because finishing yield lags by hours; the displayed number changed, but the urgency signal kept its more-immediate source so a slipping job doesn't go green just because its first batch hasn't finished drying yet.

**Shared helper reuse.** Both Production and Bridge now consume `deriveMachineStatus` from `src/lib/machineStatus.js` — any future taxonomy change updates all three surfaces (Mainframe, Bridge, Production) automatically.

**Known density consequence.** The middle column got denser — Active Jobs now has more columns, Demand is now a list rather than a single tile. Matt acknowledged this trade-off; spatial polish deferred to a follow-up if needed.

---

## 2026-05-18 — Machine commissioning state (BM-6 on order)

New `machines.is_commissioned` boolean column (default TRUE, NOT NULL) distinguishes physical-machine-in-service from `is_active` (soft-delete) and `status` (operational state). A machine can be commissioned + currently down (broken), or not yet commissioned (on order, awaiting physical arrival).

**BM-6** marked `is_commissioned = false` — on order, not yet on the floor.

**Filter rules.** All operational machine queries (Bridge MACHINES ACTIVE, Production Machine Status, Schedule drag-drop targets, kiosk launch lookups, BOM-upload machine picker, Finishing-station machine list) filter `is_commissioned = true`. Master-data surfaces (Armory > Machines, Mainframe grid) show all machines including non-commissioned, with appropriate UI distinction.

**Mainframe treatment.** Non-commissioned machines render with a "Coming Soon" tile — dashed border, 60% opacity, amber "Coming Soon" label, "On Order · Not yet available" body. Implemented as an early-return branch at the top of `MachineCard.jsx` so all interaction (Launch Kiosk button, queue display, status badge, downtime treatment) is naturally precluded — operators can't try to assign work to a machine that doesn't exist.

**Lifecycle.** When BM-6 arrives, flip the flag: `UPDATE machines SET is_commissioned = true WHERE code = 'BM-6';` — no status change needed because the operational `status` is already managed independently. Machine immediately joins counters, becomes draggable on Schedule, and renders as a normal Mainframe card.

**Rationale for new column vs reusing existing.** `is_active` is already overloaded for soft-delete and would lose that semantic if mixed with commissioning. Extending `status` to a new `'on_order'` value would mix "is this machine in service" with "what is its current operational state" — they're independent concerns. A dedicated boolean is clearest and survives transitions cleanly.

**Migration:** `Docs/migrations/2026-05-18_machine_is_commissioned.sql`. Idempotent (`ADD COLUMN IF NOT EXISTS`); verify SELECT returns exactly one row (BM-6) post-apply.

---

## 2026-05-18 — Active Jobs row: due date promoted, elapsed labeled

Following Matt's review of the Production Dashboard before tomorrow's meeting: due date moved out of the buried machine-code subtitle and into a dedicated labeled column at the far right of each ActiveJobRow. Elapsed time also relabeled with an "ELAPSED" header so the two right-edge metrics read clearly. Due date renders in white (vs gray for elapsed) and font-semibold to read as the headline metric — "are we still on track to make that date?" is the production meeting's core question. Jobs missing a `work_order.due_date` show `—` for Due.

Optional follow-up (deferred unless asked): tint due dates amber within 3 days, red when overdue.

---

## 2026-05-18 — Production Dashboard polish: staged jobs included, Demand removed

Operational adjustments after Matt's pre-meeting review.

**Staged machines treated as actively running.** Until the kiosk rollout completes (currently only Mazak 5 is on kiosks), non-kiosk machines with queued work won't show as `in_progress` in the DB even when the operator is physically working on the staged job. Active Jobs list now includes the earliest queued job per `staged` machine (derived state from `deriveMachineStatus`), synthesizing the job as `in_progress` with `production_start = scheduled_start`. Traffic-light logic falls through unchanged — a staged job whose scheduled_start is in the past will register elapsed time and a pace check; a future-scheduled job shows grey. Loader now does a separate machines query alongside the jobs query, groups jobs by machine, and feeds them to `deriveMachineStatus` to identify staged machines.

**J-FIN standalone finishing jobs excluded** from Active Jobs (filter `job_number NOT ILIKE 'J-FIN-%'`). These are finishing-only batches and don't belong in a manufacturing-progress view.

**Due-date fallback chain.** Active Jobs rows previously showed `—` for jobs whose `work_orders.due_date` was null. The loader now resolves an `effective_due_date` per job in JS:
1. `work_orders.due_date` if set
2. Otherwise the earliest active `customer_order_allocations → customer_order_lines.due_date`
3. Otherwise `—`

Implemented by nesting `allocations:customer_order_allocations(is_active, customer_order_line:customer_order_lines(due_date))` inside the existing work_order join, then resolving in a small `effectiveDueDate()` helper. The ActiveJobRow now reads `job.effective_due_date` instead of `job.work_order.due_date`.

**Demand panel removed.** Not pulling its weight for the production meeting — too much surface area for too little signal once the headline is "are active jobs on track to meet their due dates." Middle column now contains just Active Jobs + Upcoming Changeovers. `loadDemand` loader, `demand` state, `loadAll` reference, and the entire Demand tile JSX deleted. Demand-related grep returns clean.

---

## 2026-05-18 — Production Dashboard Active Jobs: scheduled-end as DUE; days+hours formatter

DUE column on Active Jobs now sources from `jobs.scheduled_end` (April's scheduled machining finish date) rather than the work order or customer order line due date. The customer-due fallback chain shipped this morning was removed — for a production meeting, "are we on pace to finish by the scheduled date?" is the actionable signal; customer due date is a separate downstream concern. `work_order` nested join with `allocations` / `customer_order_lines` removed from the loader; `effectiveDueDate` helper deleted.

Elapsed-time formatter extended to days + hours for long-running jobs. 170h 45m now reads as 7d 3h, rounded to the nearest hour for legibility. Jobs under 24h still show Xh Ym; jobs under 1h still show Xm. Matches the at-a-glance scan pattern of the dashboard rather than expecting the viewer to mentally divide by 24.

---

## 2026-05-18 — Active Jobs polish: due-date sort, UP NEXT inline, Quality + Changeovers removed, Down ETA panel

Multi-part Production Dashboard cleanup pre-meeting.

**Active Jobs sort by scheduled_end ascending** — earliest deadlines surface to the top. Traffic-light coloring stays as the left-border accent (pace signal) but no longer drives row order.

**UP NEXT column inline** — each row shows the next queued part on the same machine (status `ready` or `assigned` with `scheduled_start`), with relative time ("in 2h", "in 1d"). Machines with no follow-on job show `—`. Same-row self-duplication is avoided by filtering `q.id !== row.id` (catches the staged-synthesized case where the row's underlying job is also in the queue).

**This-week highlight.** When the next queued job's `scheduled_start` falls within Mon-Fri of the current week, the UP NEXT cell amber-tints (header reads "UP NEXT · THIS WK", part number and relative-time switch to amber). Makes it easy to scan the dashboard for "which changeovers are happening this week" without leaving the Active Jobs list. Week range is computed once per render — Monday 00:00 → Friday 23:59:59 local time.

**Upcoming Changeovers panel deleted** — its data is now inline per row, eliminating duplication. Middle column now contains just one panel: Active Jobs.

**Quality & Inspection panel deleted** — not pulling its weight for the production meeting. The 5-day rejected/rework view is better consumed in the dedicated Quality tab when needed. `loadQuality`, `rejected`/`rework` state, `fiveDaysAgoISO`/`formatDate` helpers, `QualityRow`, and the bottom-strip JSX all removed.

**All active jobs render** — previous 8-row cap with "+N more active" footer removed. If 16 machines are running, all 16 rows render. Density is a tradeoff Matt accepted vs hiding rows behind a footer.

**Down Machines ETA subpanel** added below the Machine Status tiles. For each currently-down machine, finds the active DTU (downtime unit) job — a `jobs` row with `job_number LIKE 'DTU-%'`, status non-terminal, whose `scheduled_start ... scheduled_end` window contains NOW. Displays the DTU number (e.g., DTU-000018), the MO description from `work_orders.notes`, an "UNPLANNED" purple badge when `work_orders.maintenance_type = 'unplanned'`, and `scheduled_end` as the estimated return. MO number itself omitted — DTU + description + ETA carry the signal. Sorted by earliest ETA first; machines down with no active DTU in window still render with TBD placeholder so "machine is down" signal survives. Panel hides when zero machines are down. (Initial draft used `machine_downtime_logs.end_time` — replaced because the DTU job's `scheduled_end` is the authoritative scheduling-side ETA April sets when planning the maintenance window.)

**Helper consolidation.** `formatRelativeStart` (used by UP NEXT column) replaces the deleted `formatChangeoverCountdown`. Same shape, simpler logic — collapses hours-and-minutes down to a single rounded unit ("in 3h", "in 2d").

**Machine codes as a grid.** Each Machine Status tile's code list switched from inline `·`-separated to a CSS `grid-cols-3` layout. Codes line up in clean rows/columns rather than wrapping mid-paragraph; far more legible at the dashboard's typical glance-distance use. Empty tiles still show `—` as before.

**Active Jobs row treatment rebuilt (post-review).** The colored left-border traffic-light strip (green/amber/red/gray) and the ON TRACK / SLIPPING / BEHIND legend at top right are gone. The four-state traffic light wasn't drawing the eye to what mattered — the production meeting's actual questions are "what's behind?" and "what's changing over this week?" Row styling now answers both directly via the whole-row tint:
- **Behind** (`trafficLight === 'red'`): red-tinted background (`bg-red-950/30`), 2px red border (`border-red-500/60`), `BEHIND` badge in red next to the RUNNING/SETUP status pill.
- **This-week changeover** (`next_up.is_this_week`): amber-tinted background (`bg-amber-950/20`), 2px amber border (`border-amber-500/50`). No badge — UP NEXT cell already labels it.
- **Both qualify**: behind wins the background/border (more urgent); UP NEXT cell still gets its amber treatment internally.
- **Neither**: standard gray background, gray border.

Pace signal for non-red states (green / amber / grey) no longer surfaces visually — Matt's call that those three don't justify a discriminator when only "behind" is actionable. Underlying `trafficLight` enrichment kept in the loader so the row can branch on `=== 'red'` without recomputation.

**BEHIND logic simplified to past-due only.** The progress-vs-pace heuristic (good_pieces vs elapsed-time%) is gone entirely — it was flagging every RUNNING job with 0 good_pieces as BEHIND regardless of due date, which masked the actual past-due jobs in a sea of false positives. New logic: `trafficLight = 'red'` iff `scheduled_end < today's midnight`. Jobs with no `scheduled_end` default to not-behind. `SETUP_RED_AFTER_MS`, `estimated_minutes`, `good_pieces`-based progress checks all removed from the trafficLight branch. Elapsed time is still computed and displayed in the ELAPSED column — it just doesn't drive the BEHIND signal anymore.

**10-day forward filter on Active Jobs.** The loader now only emits jobs whose `scheduled_end` is in the past (past-due, BEHIND) or within the next 10 days. Anything scheduled further out is hidden — the TV-projected list stays digestible (8-12 rows typical vs. potentially 40+ if every future-scheduled job rendered). Jobs with NULL `scheduled_end` are kept defensively. Header count (`activeJobs.length`) reflects the visible filtered total, not a hidden global active count — intentional: the dashboard reflects what's visible.

**Machine code elevated to part-number prominence.** Was small gray text under the part number; now bold, white, same font size, on the same line as the part number. The machine name (e.g., "Mazak 5") drops to a small gray subtitle below.

## 2026-05-19 — S9 Batch A: Pre-mfg compliance gated on machine assignment

**Workflow flip.** `ComplianceReview.jsx` pre-mfg filter now requires `assigned_machine_id IS NOT NULL` on `pending_compliance` jobs. Unscheduled jobs are invisible to Roger — they sit in April's Unassigned bucket until scheduled, then surface in his queue with machine context so the review is against the target machine's doc set.

**Why.** Several documents (machine-specific setup sheets, CAM programs, tooling lists) only make sense once the target machine is known. Roger previously approved against the part's master doc set, then April scheduled later, sometimes onto a machine that warranted different docs. The flip puts April first in the chain.

**Machine code surfaced.** Compliance card header sub-line now shows assigned machine code in skynet-accent font-mono, alongside job number / qty / customer. Data was already in the loader; just unused.

**Reschedule onto a different machine reverts to pending_compliance.** `applySchedule()` in `src/lib/scheduling.js` takes a new `revertCompliance` flag. When true:
- `jobs.status` → `pending_compliance`
- Clear `compliance_outcome`, `compliance_notes`, `documents_deferred*` (4 cols)
- All `job_documents.status` → `pending`, clear `approved_by` / `approved_at`

`ScheduleJobModal.jsx` detects the revert case (`editMode && status='assigned' && new_machine !== old_machine`), shows an amber banner in Step 3, switches the Save label to "Reschedule & re-review", and gates on `window.confirm()`. `pending_compliance` reschedules and same-machine reschedules don't trigger.

**Mainframe KPI sync.** "Pending Compliance" tile filters pre-mfg branch by `assigned_machine_id`; post-mfg branch unchanged. KPI now matches the visible section count below.

**Scope edges (intentional v1).**
- `in_setup`/`in_progress` machine swaps don't trigger revert. Operationally the right tool there is Split (Batch B); the modal doesn't block, just doesn't revert.
- `ready` status code path in `ComplianceReview.handleApproveJob` kept as legacy fallback. Won't execute under new rules; not ripped out.
- Document reset is wholesale (every doc to pending). No per-doc machine-specific flag exists.

---

## 2026-05-19 — S9 Batch B: Job Split feature (productized from May 2026 manual splits)

Operational pattern from the May 2026 manual SQL splits productized into a UI feature. Scheduler clicks Split on a job row in WO Lookup, picks a quantity, confirms. Original's quantity reduces; a new job is born in `pending_compliance` — invisible to Roger until April puts it on a machine (per Batch A flip).

**Atomic via Postgres RPC.** `public.split_job(p_job_id, p_new_job_quantity, p_reason)` in one locked transaction:
- Auth: `auth.uid()` + profile role lookup. Rejects all roles except `scheduler` and `admin`.
- Status gate: `pending_compliance`, `ready`, `assigned`, `in_setup`, `in_progress`, `manufacturing_complete`. Blocked downstream and on terminals.
- Quantity validation: `0 < new_qty < pieces_left_to_make` where `pieces_left = quantity − COALESCE(qty_override, 0) − COALESCE(good_pieces, 0)`.
- `FOR UPDATE` lock on original. `quantity` decremented; `qty_override` untouched (preserves prior-work provenance).
- New job INSERT: `pending_compliance`, no machine, no schedule. Notes reference original.
- Clones routing steps (skipping `removed`) with `status='pending'`, operational columns null. `is_added_step=false` — the new job's routing is a fresh snapshot.
- Clones `job_documents` (preserves `file_url`, `uploaded_by`, `source`, `notes`) with `status='pending'`, `approved_*` cleared.
- Does NOT clone `job_materials` or `job_tools` — both are kiosk-time artifacts. New job starts fresh on whatever machine the scheduler picks.
- Audit row in `public.job_splits`.

`SECURITY DEFINER`; `GRANT EXECUTE TO authenticated`. Permission check lives in-function, not via RLS.

**Audit table.** `public.job_splits(id, original_job_id, new_job_id, split_at, split_by, original_qty_before, original_qty_after, new_job_qty, reason)`. Check constraint `before = after + new_qty`. Indexed on `original_job_id` and `split_at DESC`. RLS enabled; authenticated SELECT; INSERTs flow through the function only (no policy by design).

**UI gate.** `src/lib/jobs.js` exports `SPLITTABLE_STATUSES`, `isSplittable(job)`, `canSplitJobs(role)`. Single source of truth shared with the RPC's `k_allowed_statuses`. Split button on WO Lookup job rows (both assembly and non-assembly paths in `Mainframe.jsx`).

**Entry point.** WO Lookup only for v1. Mainframe machine card and Schedule surfaces deferred — start narrow.

**Known v1 limitations.**
- `pieces_left_to_make` slightly overcounts when batches are mid-finishing (`good_pieces` only updates at job complete). Scheduler can mentally adjust.
- Cloned `job_documents` reference the original job's S3 folder path. Files load fine; folder structure mildly untidy.
- Customer order allocations stay at WO level. Both halves fulfill the same WO.
- Operator at the original machine isn't notified their target shrank — they'll see it on next kiosk refresh. UX nudge deferred.
---

## 2026-05-21 — S9 Batch C: Dashboard access, Demand entry date, Bridge product rollup (SHIPPED)

Three issues shipped to prod together (SKY51, SKY54, SKY56). No schema changes. SKY52 (J-FIN
multi-batch) was built in this batch but **reverted before push** — deferred for design (see
`Finishing_Batches_Implementation_Plan.md`).

**SKY56 — Dashboards for all roles; Bridge stays president+admin.** `canAccessDashboards`
changed from `role === 'admin'` to `!!profile?.role` (any authenticated role). The President's
Bridge entry is filtered per-role in the `DASHBOARDS.map` via `canSeeBridge(profile?.role)`
(president + admin only, from `lib/roles.js`). Production + Assembly visible to everyone.

**SKY54 — Entry date on the Demand screen.** `getAllOpenCOLines` now pulls
`customer_order_lines.created_at`, exposed as `entry_date`. CustomerOrders.jsx Demand detail
rows show an "Entered" column. `created_at` = the date the CO line was entered into SkyNet.

**SKY51 part 1 — J-FIN off the dashboards.** Standalone finishing jobs were leaking into the
Bridge priority queue (e.g. SK203C-CAGE / J-FIN-000005 ranking as P3). Fix standardizes on
`is_standalone_finishing = false` for job lists across dashboards. Assembly's in-finishing list
also filtered. **Finishing-throughput tallies KEEP J-FIN** (per Matt — a J-FIN job is
legitimately finishing work); only job lists/queues exclude it. The product rollup (part 2)
also drops J-FIN automatically since standalone jobs have no `work_order_assembly_id`.

**SKY51 part 2 — Bridge PRODUCT rollup.** Priority Manufacturing Queue changed from ranking
component *parts* to ranking *products* (WO assemblies). Per product:
- **Planned** = `work_order_assemblies.order_quantity` (order qty only, NOT order+stock).
- **Actual** = `order_quantity × MIN over components of (through-finishing ÷ component
  job.quantity)`. The ratio form handles assemblies needing >1 of a component per unit (4 screws
  per product reads correctly) and collapses to a simple min for 1:1 parts.
- **Through-finishing** = `SUM(finishing_sends.verified_count)` where `status='finishing_complete'`
  — i.e. pieces that passed finishing, NOT machine count. (Confirmed: every job-bearing component
  goes through finishing — purchased BOM parts get no job — so there is no no-finishing fallback;
  a component with nothing sent reads 0, which is correct.)
- Rows are **click-to-expand** to show component breakdown (part #, machine, through-finishing /
  required). Info note on the panel header explains the interim metric and that it switches to
  assembled quantity once Assembly goes live.
- **Layout fix (follow-up):** the first cut wrapped the four `.priority-row` grid cells in a flex
  div, collapsing them into column 1 (text shifted left). Fix: keep the `priority-row` grid class
  on the element that directly holds the four cells; attach onClick there; render the expand panel
  as a sibling outside the grid row.

---

## 2026-05-21 — TEST-from-PROD data refresh tooling + hard-won Supabase lessons

Built a repeatable PROD→TEST data refresh (`Docs/refresh-test-from-prod.ps1`) so TEST can be
reloaded with live data on demand while preserving hand-built TEST users. Runbook:
`SkyNet_Refresh_TEST_from_PROD_Runbook.docx`. Several non-obvious constraints were discovered the
hard way and MUST be remembered:

**Supabase blocks FK-trigger control.** You are NOT the table owner, so `ALTER TABLE ... DISABLE/
ENABLE TRIGGER ALL` and `SET session_replication_role = replica` to suppress FK enforcement during
a data load **do not work** (`permission denied: ... is a system trigger`). The original
"load with checks off, then re-stamp" design is impossible on managed Supabase. **Correct approach:
remap user IDs in the dump file itself before loading**, so every user-reference column already
points at a valid TEST profile and no FK is ever violated.

**The refresh recipe (Supabase-safe, in the script):**
1. `pg_dump` PROD `--data-only --schema=public --exclude-table=public.profiles`.
2. Fetch PROD user IDs live (`SELECT id FROM profiles`) and string-replace each in the dump with
   the TEST admin ID (`004b6b6e-...`, Matt). Imported "who did this" columns then all read as the
   TEST admin — cosmetic; roles are tested by logging in, not by historical attribution.
3. Back up TEST profiles (`pg_dump --table=public.profiles`).
4. Wipe TEST data tables. **`TRUNCATE ... CASCADE` reaches `public.profiles` through FKs even when
   profiles is excluded from the loop** — it cascades across the public schema and wiped the TEST
   users. Mitigation: back up profiles first, then restore if the post-wipe count is 0. (`auth.users`
   is in a different schema and is NOT reached by the cascade — the 10 login accounts survived, which
   is how profiles were rebuildable.)
5. Load the remapped dump in one transaction (empty tables → no duplicate-key collisions; remapped
   IDs → no FK violations).

**Connection requirement:** use the **Session pooler (port 5432)**. Transaction pooler (6543) and
the IPv6 direct host do NOT work with pg_dump.

**VS Code stale-environment gotcha:** the integrated terminal captures its environment at app
launch; "new" terminals inherit that stale snapshot, so permanent PATH/credential env vars set
afterward aren't visible. The script self-loads PATH + creds from the Windows user store on each run
to sidestep this. For ad-hoc `psql`, load manually or fully restart VS Code.

**Tools:** EnterpriseDB binaries at `C:\pgsql\bin` (winget community source was unregistered →
"No package found"). Credentials stored as permanent Windows user env vars (PROD_DB_URL / TEST_DB_URL),
never in the committed script.

---

## 2026-05-21 — PROD data cleanups (one-time, manual SQL)

**Old-process jobs → TCO.** J-000023 and J-000011 completed entirely via the pre-SkyNet (old)
process and were sitting in the finishing Incoming Queue. Moved to `pending_tco` with an appended
`jobs.notes` annotation ("Moved to TCO - completed via the pre-SkyNet (old) process; finishing not
tracked in SkyNet."), and their `finishing_sends` set to `finishing_complete` (NOT deleted — keeps
the record, drops them out of the queue). Job status otherwise unchanged.

**Phantom finishing batch removed.** J-000017 had a bogus 1-pc Batch B: the machinist sent 641 to
finishing, then completing the job with the already-delivered qty spawned a 1-pc send that James
pushed through finishing though no real part existed. Deleted the qty-1 `finishing_send`
(`bf61d4a5-...`) and decremented `good_pieces` 642 → 641. Verified no `outbound_sends` child existed
(`finishing_send_id` is the only FK referencing finishing_sends). Batch A (641, FLN-100034) untouched.

**Gotcha logged — relative UPDATE double-apply.** The cleanup command used
`good_pieces = good_pieces - 1` (relative). It was run twice; the DELETE was idempotent (`DELETE 0`
the second time) but the relative UPDATE decremented again (641 → 640), corrected with `+ 1`.
**Lesson: for one-shot data corrections, set values absolutely (`SET good_pieces = 641`), not
relatively**, so an accidental re-run is harmless.

---

## 2026-05-26 — SKY57 Schedule Change Requests + Dashboard Quality Metrics

Shipped as one coordinated release (single branch, TEST→PROD). Three threads landed together:
the Production Dashboard bug fixes + compliance note (Release A), then the SKY57 change-request
feature. Spec bumped to v3.5.

### D-S57-01 — Write path: SECURITY DEFINER RPC, not an Edge Function

- **Decision:** Anon/no-auth writes from the Production Dashboard go through a `SECURITY DEFINER`
  Postgres function, `submit_change_request(p_job_id, p_requested_end, p_note, p_source)`, granted
  to `anon` + `authenticated`. NOT a Supabase Edge Function (the original SKY57 plan's Option B).
- **Why:** The Production Dashboard is an unauthenticated TV route (`/dashboards/production`,
  mounted outside `MainApp` — "TV dashboard, no login required"), and the anon client can't cleanly
  write the table. An Edge Function would solve that but drags in an entire net-new surface the repo
  has never had — Deno, CORS config, a service-role secret, `supabase/functions/`, and a
  `supabase functions deploy` step — which is exactly what got SKY57 deferred in the first place.
  A `SECURITY DEFINER` RPC gives the identical controlled, validated, anon-callable write (inserts
  under the function owner, bypassing RLS) using infrastructure we already live in. The kiosk path
  later calls the same RPC, authenticated, so `requested_by` carries the machinist.
- **Validation in the function:** job exists and is not complete/cancelled; `requested_end` present
  and not before today; `requested_by = auth.uid()` only when `source='kiosk'` (NULL for the
  dashboard/meeting path); de-dupe an identical OPEN request for the same job + date (returns the
  existing id, no new row).
- **Lesson:** When the only argument for an Edge Function is "anon can't write this table," reach for
  a `SECURITY DEFINER` RPC first. Same security posture, zero new infra, squarely in the existing
  Postgres/RLS toolset. (The v3.4 spec listed "Edge Functions" in the stack as if assumed — SKY57 is
  the case where the RPC was the right call instead.)

### D-S57-02 — Apply reuses the SKY55 cascade engine; applying auto-dismisses siblings

- **Decision:** The review-queue "Apply" runs the exact SKY55 path —
  `getMachineQueue(scheduledJobs, …)` → `computeEndChangeCascade` → `applyEndDateChange` — identical
  to `handleSaveEndDate` (Adjust End Date). A change request only records "this job should end on
  date X"; nothing moves until the scheduler applies. On Apply, the request is marked `applied` and
  **any other open requests on the same job are auto-dismissed**, so a stale sibling can't be
  double-applied after the schedule already moved (plan open-question 2, resolved).
- **Why:** End-date moves already have a single, tested engine. A request is advisory data, not a
  second scheduling mechanism. Auto-dismissing siblings keeps the queue honest after one is actioned.
- **End-date only.** Start, machine, and queue position stay pinned (consistent with SKY55). No
  compliance revert (that's machine-swap only).
- **Known limitation (accepted):** Apply pulls the downstream queue from `scheduledJobs` (the visible
  week), matching SKY55. A request on a job scheduled outside the current week view moves that job's
  end but cascades neighbors only when the scheduler is on that week. Meeting requests target
  currently-running (in-week) jobs, so acceptable.

### D-S57-03 — RLS mirrors the `customer_orders` convention

- **Decision:** `schedule_change_requests` RLS follows the established `customer_orders` pattern:
  authenticated SELECT (`true`); a second anon SELECT limited to `status='open'` (all the dashboard's
  "already requested" marker needs); UPDATE (Apply/Dismiss) restricted to admin / scheduler /
  customer_service via the `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = ANY(...))`
  check. No INSERT policy (all inserts via the RPC). No DELETE policy (dismissal is a status update,
  never a hard delete).
- **Why:** Match the house style so future audits read consistently. April is scheduler/CS, so she's
  covered by the same role array used across the customer-order tables.
- **Marker + dedup (plan open-question 3, resolved):** the dashboard shows a small marker on a job's
  DUE date when an open request exists, and the RPC no-ops an identical open request — together these
  stop one meeting from filing the same change three times.

### Release A — Production Dashboard quality metrics + the data-entry fix behind them

- **Parts Accepted uncapped.** Removed the `.slice(0, 6)` in `ProductionDisplay.jsx`; the left column
  now lists every distinct accepted part for the day, sorted by qty. (Heavy-day TV overflow flagged to
  Matt; left uncapped per request.)
- **Rejected / Reworked Quality block.** Added under Accepted, off the SAME post-mfg compliance gate
  (`finishing_sends`, same date bounds) so the three numbers always reconcile. Each list aggregates by
  part number + producing machine (`finishing_sends.machine_id`; "—" for standalone J-FIN). **Reworked
  qty = SUM(`compliance_bad_qty`)**. **Rejected qty = `compliance_bad_qty ?? verified_count`** (option
  B).
- **Why option B for Rejected (and the gotcha that forced it):** diagnosis of the post-mfg submit flow
  showed the Reject path requires only a Rejection Reason — it never captures a Bad Quantity, so on a
  plain reject `compliance_bad_qty` saves as NULL. Summing `compliance_bad_qty` alone would have made
  the Rejected count read ~0 even on days batches were rejected. Option B falls back to the whole
  `verified_count` when bad qty is absent, and automatically reads the partial bad qty once partial
  reject ships — no dashboard rework needed then.
- **Require Bad Quantity on Rework + guidance note.** Post-mfg review now blocks a Rework submit
  without a Bad Quantity (≥1), so `compliance_bad_qty` is always populated for the metric. A note on
  the Quantity Check block tells the reviewer Bad Quantity = the parts actually rejected/reworked (not
  the whole batch unless all are affected) and that it feeds the dashboard. The note targets the
  post-mfg review card only — that's where Roger inspects and enters qty, not James in Finishing.
- **Deferred, with plans written:** **partial reject** (today Reject rejects the whole send; making it
  quantity-aware is a flow change touching job advancement + shortfall accounting —
  `Partial_Reject_Implementation_Plan.md`) and **kiosk change requests + requester notification**
  (`Kiosk_Change_Requests_Implementation_Plan.md`). The require-Bad-Qty-on-Reject rule lands with
  partial reject, where it's finally meaningful.

## 2026-05-28 — Retire `qty_override` → Manual Batch entries (missed / pre-system production)

  **Origin.** Surfaced diagnosing a Production Dashboard count bug. The per-job `qty_override` scalar was being used to record carried-over / pre-system production. As built it (a) **froze** the produced count — `getEffectiveQty`'s first branch returned the override and stopped looking at outsourcing returns, approved batches, or the machinist count; and (b) on the dashboard was read as the **denominator** (`target = qty_override ?? quantity`), pinning the goal to the override instead of the real order.

  **Diagnosis gated the migration (per-job classification).** Audited all seven PROD overrides against what SkyNet actually logged (approved finishing batches + lots, outbound returns, `good_pieces`). Finding: only **2 of 7** were genuinely pre-system; the other **5** sit on jobs already tracked in SkyNet finishing, so re-adding them as entries would have **double-counted ~10,400 parts**. The "lot in the override reason matches a finishing lot" signal is *not* sufficient to mark a job already-tracked — production often continued under the same production lot across the go-live cutover (J-000027), so the genuinely-pre-system quantity is a human call, not a data rule.
  - Convert → Manual Batch: **J-000023** (96,625, zero SkyNet production); **J-000022** (79,725, pending Roger confirming its finishing is fresh balance).
  - Retire, no entry (already tracked in finishing): **J-000021, J-000024, J-000025, J-000027, J-000029**.

  **Decision — entry, not a scalar.** New table `missed_production_entries` (`id, job_id, quantity, reason*, production_lot, passivation_lot, created_by, created_at`). RLS: authenticated SELECT; INSERT/UPDATE/DELETE restricted to admin + compliance via the `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = ANY(...))` house pattern. Produced count = normal `getEffectiveQty` chain **+ SUM(missed entries)**; the override-wins-frozen branch is removed. Additive by construction (a true pre-system part never appears in SkyNet's logs) so it can't double-count — *provided* an entry is only ever used for parts SkyNet will never otherwise track.

  **Single source of truth.** Extracted the duplicated `getEffectiveQty` (Mainframe + Assembly) into `src/lib/effectiveQty.js` so the surfaces can't drift; both import it. `SplitJobModal.computeProduced` keeps its own logic (intentionally counts in-flight non-rejected batches for split safety) but drops the `qty_override` line and adds the missed-entry sum.

  **Dashboard.** Numerator `pieces_passed_finishing + SUM(missed entries)` — kept this over routing the whole numerator through the helper, to preserve the end-to-end finishing-yield semantics; denominator reverts `qty_override ?? quantity` → `jobs.quantity` (the real order).

  **UI — "Manual Batch".** The Order Lookup override modal/button is replaced by an admin/compliance **+ Manual Batch** action in the job's batch area (above routing). Entry renders as a "Manual Batch · N pcs · lot …" line alongside the finishing batches; the qty cell shows a small "+" flag when the total includes one. Internal names stay `missed_production_entries` / `handleMissedEntry*` — only user-facing labels say "Manual Batch."

  **Migration (per-job, manual — NOT auto-convert).** Cleared all seven overrides (`UPDATE jobs SET qty_override = null …`; jobs untouched) and deleted the J-000023 placeholder `finishing_send` (96,625, no lot / no compliance / never verified — a future double-count risk if ever approved). Compliance re-enters the genuinely pre-system batches by hand per the classification above.

  **Ordering bite (caught live).** Code embedding the new table shipped to TEST/localhost before the table existed on that Supabase project → the WO Lookup query 400'd (`PGRST200`, "Could not find a relationship between 'jobs' and 'missed_production_entries'") and Order Lookup showed zero work orders, which read as "data wiped" until the table was created. **Rule:** the table migration lands on a project *before* the code that queries it (TEST table → test-branch deploy → validate → PROD table → merge main).

  **Deferred.** (1) Drop the `qty_override` column — keep one release past migration. (2) Remove the now-inert `COALESCE(qty_override)` term in the `split_job` RPC (functionally 0 once overrides cleared, but a dead reference). (3) Genuine *replacement-correction* overrides ("recount confirmed 615 not 620" — a subtractive correction the additive entry model doesn't express) — none in the data today; separate decision if ever needed.

---

## 2026-06-03 — Mandate material entry + material lot in PLN (kiosk Start Production)

**Decision.** Material entry is mandatory at kiosk Start Production — the "Skip Material Setup" override is removed; a non-empty material lot is required to start. PLN format is now `PLN-<lot>-YYMMDD-NNNN`, minted at Start Production. One raw material lot per job (already enforced by the `handleAddMaterial` B1 guard — untouched here). Kiosk-only; non-kiosk machines retain the legacy manual PLN entry at Finishing pickup until they receive a kiosk. Forward-only — existing PLNs and in-progress jobs are untouched.

**Implementation (`src/pages/Kiosk.jsx`, frontend-only — no SQL/migration).** `handleConfirmStartProduction` now blocks with an alert when no material is loaded or the first material's lot is blank, instead of opening the override modal. `generateProductionLotNumber(materialLot)` folds the trimmed lot into the minted number; `handleConfirmMaterials` passes `jobMaterials[0].lot_number`. `handleConfirmMaterialOverride` and the `showMaterialOverrideModal` JSX are left in place but are now unreachable (nothing sets the flag true), so the `material_override` audit event simply stops being produced for new jobs — to be deleted in a later cleanup.

## 2026-06-06 — Raw Material Checkout Kiosk (rack staging, per-load log, kiosk PIN unification)

**What shipped.** A machine-agnostic Raw Material Checkout Kiosk at `/material-kiosk` for staging bar stock ahead of setup; an append-only per-load history (`material_loads`); a shared PIN pad unifying all three kiosks; and a staged-material Start flow on the Machinist Kiosk so staged jobs no longer read as "still needs material."

**Rebased on what already existed.** The implementation plan assumed greenfield, but `job_materials` and the kiosk Start-Production material+lot gate were already in place from the 2026-06-03 work. The build rebased onto them rather than recreating them. The rack kiosk mirrors `Finishing.jsx`'s anon `profiles.pin_code` auth and writes the same `job_materials` row the Machinist Kiosk uses.

**Schema (TEST + PROD, ahead of code).** One atomic migration: deduped the 17 multi-row jobs by SUMMING `bars_loaded` + remnants onto the earliest row (all same type/size/lot reloads); added `material_master_id` (FK `materials`, resolved via `bar_sizes.size_decimal` → `materials.bar_size_inches`); added `reconciled_by`/`reconciled_at`; added `UNIQUE(job_id)`; and reversed the NOT NULL on `material_type`/`bar_size` (app still validates on the kiosks; the relax fixes the silent Finishing lot-only insert and allows lot-only rows). Later: `material_loads` table + cleanup trigger.

**`UNIQUE(job_id)` → accumulate, not insert.** One row per job. "Add More" and repeat rack staging both fetch-fresh-then-accumulate onto the existing row's `bars_loaded`; lot locks after the first entry, a differing lot is blocked + logged to `audit_logs` as `lot_mismatch`.

**`material_loads` — display log, not source of truth.** Append-only (`job_id, material_type, bar_size, lot_number, bars, source, staged_by, staged_at`), written fire-and-forget on every stage/add in both kiosks. `job_materials` stays the per-job total that drives consumption and finalize; the log is display-only and client-immutable (SELECT + INSERT policies only). Shown as a per-load history on the rack lineup card and beneath the Machinist Kiosk material line, stamped with operator + time.

**Orphan-on-delete bug → SECURITY DEFINER trigger.** Trashing material in the Machinist Kiosk deletes the `job_materials` row but the log entries lingered, so trash-then-reload left a stale load. Fix: `trg_cleanup_material_loads` (AFTER DELETE on `job_materials`, SECURITY DEFINER) deletes `material_loads WHERE job_id = OLD.job_id`. Catches every delete path (trash, cancel setup, future) and keeps the log client-immutable (no client delete policy needed).

**Shared `PinPad` (`src/components/PinPad.jsx`).** All three kiosks render one component — a four-dot pad (PINs are 4 digits), Delete-key backspace, Enter/Lock action; an incorrect PIN clears the entry. Machinist Kiosk authenticates server-side via the `kiosk-authenticate` edge function (service role); Finishing and the rack read `profiles.pin_code` directly as `anon`, so one PIN works everywhere. The rack admits any active profile with a kiosk PIN (role gate removed). Bolt Master machines are excluded from the rack lineup (they run blanks).

**Anon profiles read (the PIN-not-working fix).** The rack's `anon` `profiles.pin_code` lookup returned nothing on TEST because the `profiles` SELECT policy didn't grant `anon` — the Machinist Kiosk works only because the edge function uses the service role. Added a permissive `anon` SELECT policy on `profiles` (TEST; PROD already broad, which is why Finishing logs in there). Same dependency the deferred "narrow `profiles` SELECT" item concerns.

**Machinist Kiosk — staged-material Start (Option 2, in-modal).** When material is staged, the materials modal opens to a prominent green "Material staged from the Raw Material Kiosk" banner + staged summary; the Add Material form collapses behind an "Add or change material" toggle; the always-visible footer "Confirm & Start Production" starts from the staged material (`handleConfirmStartProduction` already passed on a staged row + lot — PLN + `material_confirmed` set as normal). Primary setup button reads "Load Materials + Start Job." A warning banner in the Add Material form notes direct entry accumulates on top of rack-staged bars. (Rejected a `window.confirm()` version — poor on a tablet.)

**Deferred.** Blanks / Bolt Master material tracking; a mandatory remnant backstop on the Finishing manual-pickup completion path (rack is the preferred path); locking type/size (not just lot) on Machinist Kiosk reload; the inventory phase reconciling balances off `material_loads` + `material_master_id`; routing the rack + Finishing onto `kiosk-authenticate` (JWT-per-PIN hardening) so they stop depending on the anon `profiles` read.

---

## 2026-06-07 — SKY58 Kiosk downtime as a timeline block

### D-S58-01 — Kiosk-logged downtime renders as a Command week timeline block
SKY58 — kiosk-logged downtime (`machine_downtime_logs`, `end_time` NULL) now renders as a red block on the Command week timeline, positioned via `getJobBlockStyle` as an ongoing no-end span. Gated to machines with no active DTU/maintenance job (which already draw their own block) so there's never a duplicate. The machine-column truncated label is retained as a quick indicator. Zoomed-day view not covered (week view only).

### D-S58-02 — Production Dashboard down-machine descriptions persist (DTU + kiosk fallbacks)
SKY58 (Production Dashboard, `loadDownMachineETAs`) — (a) when no active DTU's window contains now, fall back to the most-recent active DTU so a down machine's description + ETA persist after the `scheduled_end` passes (scheduler should extend; until then the info stays, showing the stale end date as the ETA). (b) For machines down with no DTU job (kiosk-entered downtime), fall back to the open `machine_downtime_logs` reason/notes as the description. Render unchanged — `{d.description || '—'}` already shows regardless of `dtu_number`; null `estimated_return` shows TBD. Note: the earlier D-S58-01 Command-view block is a separate surface.

---

## 2026-06-07 — SKY75 Reschedule position picker reads full schedule

### D-S75-01 — ScheduleJobModal receives the full cross-week schedule
SKY75 — `ScheduleJobModal` now receives `allScheduledJobs` (full cross-week schedule) instead of the visible-week `scheduledJobs`. The modal uses the prop only as `getMachineQueue` input (machine-picker stats, Step 2 position picker, insertion cascade). The week slice made the queue incomplete, so placing a job in a week where the machine had no jobs reported 'No jobs queued' and the cascade ignored downstream jobs in other weeks. Full schedule fixes both. Modal prop name left unchanged.

---

## 2026-06-07 — SKY74 Kiosk Complete derives good count from finishing sends

### D-S74-01 — Remove machinist final-qty entry; good_pieces = finishing-sends total
SKY74 — kiosk PRODUCTION Complete (`handleCompleteJob` + `completeForm` + the non-maintenance Complete modal branch) no longer takes an operator good/bad count. The auto-finishing-send (`good_pieces − already_sent`) is removed — it produced phantom batches (e.g. J-000042 / J-000029). The operator must explicitly choose 'Send a final batch' (entering the batch quantity — never prefilled; the existing prefilled box is the pencil-whip problem) or 'Complete without sending'. `jobs.good_pieces` is set to the SUM of the job's `finishing_sends` (every job finishes internally); `bad_pieces` fixed at 0 (scrap not tracked at the kiosk); `time_per_unit` uses the finishing total. The final batch insert is blocking (a failed send must not under-count the job). Shortfall is unaffected by design: `evaluateJobShortfall` already prefers compliance's `post_mfg_good_qty` and falls back to `good_pieces` (now the finishing total), so no trigger re-pointing was needed. Maintenance/DTU completion is a separate inline handler and is untouched.

---

## 2026-06-07 — SKY63 Packet 3 Atomic reschedule cascade

### D-S63-03 — applySchedule routes through the reschedule_with_cascade RPC
`applySchedule` now routes through the `reschedule_with_cascade` RPC (target + cascade in one transaction; deferred constraint validated at commit). Fixes the false overlap rejection on a multi-job shuffle (front-insert). RPC reproduces the prior behavior incl. the S9 machine-swap compliance/document reset; SECURITY DEFINER, granted to authenticated.

### D-S63-04 — Truncate scheduled_start/end to whole seconds (BEFORE trigger + backfill)
`scheduled_start`/`scheduled_end` are truncated to whole seconds via a BEFORE trigger plus a one-time backfill, to prevent sub-millisecond overlaps from the JS(ms)↔PG(µs) precision gap tripping `jobs_no_machine_overlap`. JS `Date.toISOString()` emits millisecond precision while Postgres `timestamptz` stores microseconds; a contiguous hand-off computed in JS (prev end == next start) could round to adjacent-but-overlapping microsecond boundaries, falsely tripping the exclusion constraint. Normalizing both columns to whole seconds at write time (trigger) and across existing rows (backfill) closes the gap. Second-level granularity is more than enough for shop-floor scheduling.

### D-S63-06 — Maintenance creation atomized; planned routed through the resolve flow; "move next" is a repack
`CreateMaintenanceModal` routes maintenance creation through the `create_maintenance_atomic` RPC: the maintenance WO + the DTP/DTU block insert + the production shove now commit in ONE transaction, so the deferred `jobs_no_machine_overlap` constraint only ever sees the final, conflict-free schedule (same atomic-RPC pattern as `reschedule_with_cascade` / `unschedule_with_cascade` / `change_end_with_cascade`). The overlap pre-check now runs for BOTH planned and unplanned (it was unplanned-only), so planned maintenance landing on assigned production opens the same resolve modal. The resolve modal's two manual loops are gone: `return_to_queue` passes the overlapping job ids as `p_requeue_ids` (the RPC pulls them off the machine); `move_next` passes an empty list and the RPC repacks all movable production around the block and cascades downstream — no more client-side per-job time math. Job-number generation (last DTP-/DTU- + 1) and the unplanned machine `status='down'` update stay client-side. On any failure nothing is left behind (single transaction), removing the prior orphaned-WO/job risk when a later write tripped the constraint.

---

## 2026-06-15 — Outsourcing consolidation: receive a combined lot as ONE card (CR)

Follow-up to the shipped "Combine Like Products" feature (Option B: consolidated sends share
`outbound_sends.consolidation_group_id`; each batch keeps its own finishing_send_id / job / step /
quantity row).

Field report (Ashley/Matt): parts ship to the vendor as ONE box and return in ONE bag, but the
At Vendor list rendered one card per batch and the group-return form asked for a per-batch quantity.
Receiving a 10-batch lot meant 10 cards / 10 qty fields.

### D-OCON-CR1 — At Vendor + Returned collapse to one card per consolidation group
`OutsourcedJobs.jsx` collapses every `consolidation_group_id` into a single synthetic group card
(constituent batches listed inside with per-batch FLN/qty and a summed total). Non-consolidated sends
are unchanged (one card each). Purely a display change — the underlying per-batch `outbound_sends`
rows are untouched, so the Job Traveler and the effective-qty rollup keep per-batch granularity.
No schema change.

### D-OCON-CR2 — Receive the whole lot with a single total quantity
The per-batch quantity inputs are replaced by one "Total Qty Returned" field, defaulting to the total
sent. On confirm the lot's shared vendor lot/cert + return date are written to every row in the group,
and the single total is distributed back across the rows so each job/step rollup stays exact: full
return (total == sum sent) gives each row its own sent qty; a short return apportions proportionally by
sent qty with the rounding remainder on the last row, so the per-row sum equals the entered total. Cert
upload on a group card writes the cert path to all rows in the group.

### Why distribute rather than store one lot-level number
`getEffectiveQty` (effectiveQty.js) sums `quantity_returned` across a job's sends for the latest routing
step; the rollup only cares about the SUM, so distributing the lot total across rows keeps every rollup
correct while preserving the material-lot traceability that is the whole point of consolidation. The
president's traceability rule — one material lot per send-out — is unaffected; combining still happens
only at the compliance → outsourcing handoff.
---

## 2026-06-12 → 06-17 — Raw Material Inventory Arc (Reconciliation, Pricing, Documents, Replenishment, Cycle-Count Adjustments, Two-Group Nav)

> A connected arc: load real inventory → make discrepancies visible (reconciliation) → capture cost → support late receipts → roll up + replenish → cycle-count with approval → restructure the now-dense Armory nav. Availability becomes a single DB-side definition. Multi-role + a purchaser role are designed at the end (implementation pending).

### D-INVLOAD-01 — Initial load re-links checkout usage rather than decrementing counts
The 73-line inventory load inserts the **raw** physical counts into `material_receiving` (stamped `received_at` just before the checkout window) and then re-links the existing checkout `material_usage` rows to the new receipts. Counts net out automatically (received − used), so a lot that was over-pulled lands at its true negative (lot 2563 → −1) and the reconciliation trigger flags it. **Why:** preserves the full audit trail and the usage history; no manual count math, no fudging the received quantity (which is the AS9100 truth).

### D-INVLOAD-02 — Vendor/PO is mandatory going forward, not retroactively
Five load lines had no findable vendor/PO and were loaded with those columns null (the column is nullable). The "vendor + PO required" rule is enforced at the **Armory receiving UI** for new receipts, not applied retroactively to the historical load. Normalizations baked into the load: `41L41`→`41L40` (typo), `C12L14`→`12L14`, `7075`→`7075-T651 Aluminum` (standard bar temper), `316L` as a new material type distinct from `316`. Density left null for the whole load.

### D-RECON-01 — Reconciliation flags are trigger-raised with one-open-flag-per-lot dedup
`material_reconciliation_flags` is populated by an `AFTER INSERT` trigger on `material_usage`: `unknown_lot` when the staged lot has no receiving link, `negative_inventory` when received − used goes negative. A partial-unique pattern keeps **one open/ignored flag per (type, lot)** — repeat occurrences bump `occurrence_count` instead of inserting duplicates; an `ignored` flag stays silent forever. **Why:** the trigger covers both kiosks and any future staging surface without duplicating logic; dedup prevents flag spam (e.g. blank-studs lot 50509 flags once).

### D-RECON-02 — Availability is signed (unclamped); the floor is never blocked
Every availability computation is signed — empty/negative lots stay **selectable** at both kiosks so staging from them is allowed. The trigger flags the discrepancy; we never block the pull. **Why:** physical material gets pulled regardless of what the system thinks; flag-and-chase beats blocking a machinist mid-job. Anon-role queries silently return empty (S7), so the kiosk read path must run authenticated — which it does (the reconciliation flags came from real prod kiosk checkouts).

### D-RMPRICE-01 — Pricing lives on the receipt, not the material master
`po_number`, `weight_lbs`, `price_per_lb`, `price_per_bar` are columns on `material_receiving`, not on the `materials` master. **Why:** cost varies per lot/PO; the receipt is the correct home. These snapshots feed inventory Est. Value and the frozen financial impact of cycle-count adjustments (D-ADJ-02).

### D-RMPRICE-02 — Receiving must write bar_size in the catalog format
`material_receiving.bar_size` must be the `bar_sizes.size` string (e.g. `"0.875 dia"`), not `"0.875\""`. The Armory receiving writer was emitting the quoted format, so Armory-logged receipts never matched kiosk usage. **Why:** the kiosks link `material_usage` → `material_receiving` by `bar_size` string equality; a format mismatch silently breaks the link (and would raise false unknown-lot flags).

### D-MATDOC-01 — Material certs in their own table, reusing existing S3 plumbing
`material_documents` (one row per cert/doc per receiving row; `document_type` cert/packing_slip/other) stores files in S3 under `material-certs/{receiving_id}/` via the existing `s3.js` helpers. Upload at receipt time and after-the-fact from the Inventory tab; counts loaded via one batched `.in()` query, never per-row. **Why:** multiple docs per lot; the cert traceability chain is `job → material_usage → material_receiving → material_documents`.

### D-LINK-01 — Late receipts resolve by linking staged usage, not decrementing
`link_unknown_lot_usage` (SECURITY DEFINER) links **all** orphaned `material_usage` rows for a lot to the chosen receipt, resolves the `unknown_lot` flag with an auto-note, and — because the trigger only fires on INSERT — raises/refreshes a `negative_inventory` flag itself if the linked consumption exceeds the receipt. **Why:** material is routinely pulled before its receiving paperwork clears compliance; the correct resolution is attaching the staging history to the eventual receipt (availability then nets out), preserving traceability rather than mutating the received quantity.

### D-LINK-02 — One link path, two entry points
The Reconciliation "smart Resolve" and the receiving-save nudge share a single client helper around the RPC. When a receipt is logged for a lot with an open `unknown_lot` flag, the receiving modal immediately offers "Link N staged bars & resolve" — the path the compliance-lag scenario actually flows through most of the time.

### D-RMNAV-01 — Dense Armory nav collapses into group dropdowns
Armory tabs are grouped under top-level dropdowns: **Finished Goods** (Products, Parts, Routing Templates) and **Raw Materials** (Material Types, Bar Sizes, Material Catalog, Inventory, Adjustments, Reconciliation, Receiving, Replenishment Rules); Customers and Users stay standalone. The render is generic over a group list (one open at a time), and each dropdown closes via a full-screen fixed backdrop — no document listeners, no new deps. Group membership is render-only; `canSeeTab` still gates by role, so a role sees only its accessible members.

### D-RMNAV-02 — The two material-definition tabs are renamed to disambiguate layers
They are different layers: **"Materials"** (writes `material_types`, the alloy/grade dictionary) → **"Material Types"**; **"RM Master Data"** (writes the `materials` table — specific type+size+vendor stock items with density; body was titled "Material Definitions") → **"Material Catalog"** with the body retitled to match. **Why:** both names read as "material definitions" and collided; the new names name what each *is*, and they sit adjacent in the group.

### D-ROLLUP-01 — Inventory By-Size roll-up + staging surfaced in Reconciliation
The Inventory tab gets a By Lot / By Size toggle; By Size groups `material_type + bar_size`, summing `available_bars` across lots with lot count, vendors, and Est. Value. Separately, receipts still sitting at rack = Staging surface in the **Reconciliation** tab with an inline rack-assign control (reusing `handleAssignRack`). **Why:** answers "how many bars of each size do I have" without mental math; staging shouldn't linger unassigned.

### D-REPLEN-01 — Min-stock rules keyed by type+size, evaluated against full inventory
`material_replenishment_rules` (`material_type_id` + `bar_size_id` + `min_bars`, unique per type+size). Below-min is computed against the **full** inventory total for a type+size (thresholds are vendor-agnostic), surfaced in the By-Size roll-up (Min column + "Below min" badge) and the tab badge. **In-app only** this round; email (SES Edge Function + schedule + crossing-state dedup + recipient list) is deferred. **Why:** keying to full totals means filtering the view never produces a false "below min".

### D-ADJ-01 — Cycle-count adjustments freeze the delta, not the count
`inventory_adjustment_requests` holds one row per lot counted, grouped by `count_session_id`. The stored `adjustment_delta` is **frozen at submission** as `counted − (received − used)_at_count` — not the counted number. **Why:** a frozen delta composes correctly with bars pulled between count and approval (`current(received−used) + delta` still equals the physical reality), and it composes even on top of prior approved adjustments.

### D-ADJ-02 — Submission is server-side and tamper-proof; one pending per lot
`submit_inventory_adjustments` (SECURITY DEFINER) snapshots system qty from the availability view, freezes the delta and the financial impact (`delta × price_per_bar_at_count`) server-side, skips zero-delta lines, and is protected by a partial unique index (**one pending adjustment per lot**). A second count on the same lot is reported skipped, never double-applied. **Why:** the client can't fabricate deltas or impacts; the unique index mirrors the one-open-flag reconciliation pattern.

### D-ADJ-03 — Approval flips status; self-approval blocked except for admin
`review_inventory_adjustment` / `review_inventory_adjustment_session` (role-checked) just set status; the availability view picks up approved deltas automatically, so an approved count goes live across inventory **and** both kiosks at once. Self-approval is blocked at line and session level — **except admin** (often the sole approver in a small shop); **compliance remains blocked**, so separation of duties holds where it matters. The exemption is checked via role membership, not a single primary role.

### D-AVAIL-01 — One availability definition: the material_availability view
`material_availability` (a `security_invoker` view) is the single source of truth: `available = received − used + Σ(approved adjustment deltas)`. All three surfaces — Armory `loadInventory` and both kiosk `loadInventoryStock` — read the view instead of each re-summing `material_usage`. **Why:** approved adjustments must move availability *everywhere* or a kiosk lets a machinist pull a bar the adjusted count says isn't there; centralizing also kills the triplicated client-side availability math that caused the D-RMPRICE-02 drift. `security_invoker` so the kiosks' existing authenticated-role RLS still governs the read; `GRANT SELECT ... TO authenticated`. The inventory tables stay `authenticated`-all for writes (gating is UI + RPC), so RLS guardrail CI is unaffected.

### D-AVAIL-02 — View exposes both whole-bar and inches availability
The view returns `available_bars` (whole-bar: received − used_bars + delta — what the kiosks use) **and** `available_inches` (inches-based + delta — what Armory shows so partial-bar remnants stay precise). Cycle counts use the whole-bar system number (rack counts are whole bars). The pre-existing Armory-vs-kiosk presentation difference (fractional vs. whole) is preserved deliberately — unifying it would be a behavior change outside this arc's scope.

### D-ADJ-04 — Count sheet prints as a standalone tally, not via the Print Package
The "Print Count Sheet" button opens a self-contained `window.open` HTML sheet (in-scope lots sorted by rack, with System qty + blank Counted/Notes columns and a Counted-by/Date line), not the heavier Print Package/Print Hub machinery. **Why:** a cycle-count tally is a write-and-return form, a different artifact from a formal traveler/document; lightweight isolated print avoids fighting the dark-theme app CSS.

### D-MROLE-01 — Multi-role via a roles[] supplement to the primary role *(decided; implementation pending)*
A user may hold multiple roles: `profiles.role` stays the **primary**; `profiles.roles text[]` holds additional roles; effective set = `role ∪ roles`. A `user_has_role(uid, VARIADIC roles)` SQL helper (`role = ANY OR roles &&`) backs the RPCs/RLS; a frontend `hasRole(profile, …)` + a tab-access **union** back the UI. **Foundational-but-scoped:** applied in Armory (tab union + write gates), the inventory RPCs, and the sales-dashboard/route guards; peripheral role checks keep reading the primary `role` and migrate opportunistically. **Why:** Sawyer needs Customer Service + Purchaser; a `user_roles` join table is overkill at this shop size; `roles` defaults `'{}'` so every existing single-role user is unaffected. Implementation per `MultiRole_Purchaser_Implementation_Plan.md` — not yet shipped.

### D-PURCH-01 — Purchaser role matrix *(decided; implementation pending)*
Purchaser **views** Finished Goods + Raw Materials and **writes** inventory adjustments (submit only — not an approver), replenishment rules, and reconciliation (resolve + link); read-only on master data, Receiving, and Finished Goods; no Customers/Users. Receiving gets its **own** `canReceive` gate (admin/compliance/finishing) split out from `canWriteMasterData` (admin/compliance) — otherwise repurposing the shared `canWrite` would silently strip **finishing's** ability to log receipts. The reconciliation link RPC and the adjustment-submit RPC are extended to `purchaser`; the approve RPCs are not. Implementation pending.

---

## 2026-06-16 — End-date & unschedule cascade completeness

### D-S55-CASC01 — End-date & unschedule cascades must walk the full cross-week machine queue (2026-06-16)
**Problem:** Adjust End Date on J-000052 (push end out ~19 days) failed with
`jobs_no_machine_overlap` despite the preview showing the one visible downstream
job shifting cleanly. 
**Root cause:** `handleEndDateSave`, the change-request apply path, the end-date
modal preview, and both unschedule cascade sites computed from the visible-week
slice `scheduledJobs`. A downstream job on the same machine in a later week was
never shifted, so the deferred exclusion constraint failed at commit. Same defect
class as D-S75 (modal queue was week-sliced).
**Fix:** All five cascade sites now use `allScheduledJobs` (full future list,
already loaded on every fetch via `loadAllScheduledJobs`). No RPC/schema change —
`change_end_with_cascade` defers correctly; the input was incomplete. Corrected the
stale "used only in list view" comment.
**Files:** `src/pages/Schedule.jsx`.

---

## 2026-06-16 — Schedule grid zoom

### D-SCHED-ZOOM01 — Variable grid window (Week / 2-Week / 4-Week zoom) (2026-06-16)
**What:** Added a timeline zoom control to the Schedule grid. Replaced the hardcoded
7-day window with a `windowDays` state (7/14/28). `getWeekDates`, the utilization
denominator, view-bound/range-label `weekDates[6]` references, and the jump-to-job
offset all generalize to `windowDays`. Data fetch already bounded by weekStart/weekEnd
(derived from weekDates) so it widens automatically; refetch dep extended to include
`windowDays`. Body wrapper uses `min-w-max` at >7 days so the existing min-w-[150px]
columns scroll horizontally with header/body scroll-sync intact.
**Behavior:** Changing zoom resets weekOffset to 0 (re-anchors to today); prev/next
pages by one full window. Zoom is session-only (resets to Week on reload).
**Not affected:** cascade/overlap logic (time-based), RPCs, schema, zoomed-day view.
**Files:** `src/pages/Schedule.jsx`.

---

## 2026-06-16 — Command View header de-clutter

### D-SCHED-DECLUT01 — Command View header de-cluttered (2026-06-16)
**What:** Removed three items from the Schedule grid header toolbar to recover
horizontal space: (1) the "Command View"/"Day View" title block and the
"(N scheduled this week)" count; (2) the Location/Brand grouping toggle — grouping
is now fixed to the `groupingMode` default ('location'), state and downstream render
logic unchanged; (3) the "Schedule Maintenance" text label — the button is now
icon-only (Settings icon, tooltip retained) since it is the sole entry point to
CreateMaintenanceModal.
**Files:** `src/pages/Schedule.jsx`. No schema/RPC change.

---

## 2026-06-16 — Production Dashboard customer-order dropdown

### D-PRODDASH-CO01 — Customer-order dropdown on Today's Production rows (2026-06-16)
**What:** Each active-job row in the Production Dashboard's Today's Production list is
now expandable (chevron toggle) to show the customer-order allocations for that job's
work order: Customer, CO#, Line, Qty Allocated, Due. Data via the existing
fetchCOAllocationsForTraveler helper, lazy-loaded on first expand (no preload across
the ~16 running rows). make_to_stock jobs show "Stock order — no customer allocation";
jobs with no active allocations (incl. maintenance/DTU) show "No customer order linked."
Added work_order:(id, wo_number, order_type) to the active-jobs select to support this.
**Files:** `src/pages/dashboards/ProductionDisplay.jsx`. No schema/RPC change.

---

## 2026-06-16 — Nested Assembly (Batch A: schema + BOM explosion)

### D-NEST-01 — Assembly hierarchy inside a work order via self-FK (2026-06-16)
**What:** Added `work_order_assemblies.parent_work_order_assembly_id` (nullable self-FK → work_order_assemblies.id). NULL = top assembly (every existing/single-level WO); non-null = sub-assembly whose output feeds the referenced parent woa. Partial index on the column (WHERE parent IS NOT NULL) for child lookups.
**Why:** A WO must hold a tree of assemblies to build an assembly-within-an-assembly (SK2600-2SW → SK26C2W2 → SK26C2W1). Fully backward-compatible — all current rows have parent = NULL and behave exactly as before. Gated downstream behind FEATURES.NESTED_ASSEMBLY.
**Files:** `Docs/migrations/2026-06-16_nested_assembly_batch_a.sql`.

### D-NEST-02 — Sub-assembly check-in: extend the existing primitive (Option A) (2026-06-16)
**What:** `assembly_component_checkins` now accepts EITHER a component job OR a sub-assembly as its source: added `source_work_order_assembly_id` (nullable FK → work_order_assemblies), made `job_id` nullable, and added an XOR CHECK (`(job_id IS NOT NULL) <> (source_work_order_assembly_id IS NOT NULL)`) so exactly one source is set. A component job clears compliance and checks in via job_id (unchanged); a completed sub-assembly woa checks into its parent via source_work_order_assembly_id (Batch C wires the trigger in handleCompleteAssembly).
**Why (rejected Option B):** A synthetic phantom job per sub-assembly would pollute the jobs table with non-manufactured rows and complicate scheduling, traveler, and KPI queries. Extending the check-in primitive keeps sub-assemblies out of the jobs table. All existing rows (job_id set, source NULL) satisfy the new CHECK — no data migration.
**Files:** `Docs/migrations/2026-06-16_nested_assembly_batch_a.sql`.

### D-NEST-03 — explode_bom() recursive RPC for full-depth BOM (2026-06-16)
**What:** Added `public.explode_bom(p_part_id uuid, p_top_qty int)` — SECURITY DEFINER, STABLE, recursive CTE returning one row per node: path (uuid[]), depth, parent_part_id, component_id, part_number, description, part_type, sort_order, bom_quantity, cumulative_quantity (= product of bom quantities down the path × top qty), is_cycle. Cycle guard: a node whose component_id already appears in its own path is flagged is_cycle=true and not descended into; hard depth cap of 20. Granted EXECUTE to authenticated.
**Why RPC not PostgREST:** Per the standing 2-level nesting limit, an embedded `.select()` cannot fetch an arbitrary-depth BOM. The recursive CTE is the only reliable server-side explosion. A part recurring across different branches (e.g. the 17-4 pin in both the top BOM and the sub-assembly BOM) is NOT a cycle — it returns as distinct path rows; consumers must key on `path`, not part_id.
**Files:** `Docs/migrations/2026-06-16_nested_assembly_batch_a.sql`.

### D-NEST-04 — Convention: finished goods are never nested; nested tops are 'assembly' (2026-06-16)
**What:** Confirmed the part_type convention for nesting. Finished goods (e.g. SK212-12) come off the machines complete and route straight to the customer or via outsourcing — they are never assembled and never the top of a nested tree. The top of any nested assembly tree is always an `assembly`-typed part. The finished_good skip in Assembly.jsx (`if (woa.assembly?.part_type === 'finished_good') continue`) and the finished_good → pending_tco routing in ComplianceReview.jsx are therefore CORRECT and left untouched.
**Quantity propagation:** explode_bom multiplies bom_quantity through every level so qty>1 components cascade correctly. There are zero qty>1 BOM rows in the system today, so making explosion quantity-correct now has zero blast radius on current data and forecloses a latent error when qty>1 BOMs are added. This also closes the latent 1:1 bug in addJobFromBOM, to be wired in Batch B.

### D-NEST-05 — Create WO nested BOM tree + selection, no submit yet (Batch B1) (2026-06-16)
**What:** Behind FEATURES.NESTED_ASSEMBLY, Create WO loads an assembly's full BOM via explode_bom(part, 1) and renders it as an expandable tree (NestedBomTree): assembly/finished_good nodes are collapsible sub-assembly groups, manufactured leaves are job toggles, purchased leaves are display-only, cycle nodes are flagged and not expanded. Per-node quantity = node.cumulative_quantity (top=1) × (orderQty + stock), computed client-side so changing qty never re-hits the RPC. Selection lives in new index-keyed state (nestedTreeByIndex / nestedSelectedByIndex), separate from the flat selectedAssemblies[i].jobs.
**Submit:** Intentionally NOT wired in B1 — handleProductionSubmit throws a clear "lands in B2" error for any assembly row when the flag is on, so no half-formed nested structure can be written. Finished-good / manufactured rows submit normally; flag-off is byte-for-byte unchanged.
**Why client-side qty:** explode_bom is called once per selected assembly with top qty 1; multiplying by order+stock in the component avoids an RPC per keystroke.
**Known pre-existing (not nesting):** coLinesByAssembly and the new nested state are keyed by selectedAssemblies index; addAssembly (prepend) and removeAssembly (filter) shift indices and can misalign these maps for multi-row WOs. Out of scope here; the single-row demand-driven default is unaffected. Flagged for a future fix.
**Files:** src/config.js, src/lib/nestedAssembly.js (new), src/components/NestedBomTree.jsx (new), src/components/CreateWorkOrderModal.jsx.

### D-NEST-06 — Create WO recursive submit for nested assemblies (Batch B2) (2026-06-16)
**What:** Removed the B1 submit block. On submit, Create WO now walks the explode_bom tree (submitNestedTree in lib/nestedAssembly.js): the existing code still creates the TOP woa (with its Assembly Route edits + CO allocations); below it the helper creates one woa per sub-assembly node with parent_work_order_assembly_id pointing at its enclosing woa (depth-1 → top woa), and one job per SELECTED manufactured leaf with work_order_assembly_id = the nearest enclosing woa. Quantities multiply through every level: node qty = explode_bom unit qty (top=1) × (top order + stock). Sub-woa and nested-job routing copy straight from part_routing_steps; nested jobs also pull current part_documents forward. CO allocations remain at the top WO.
**Job numbering:** threaded through the helper (startJobNum in / nextJobNum out) so the J-###### sequence stays contiguous across flat and nested rows in one submit.
**Empty-WO check + button gate:** both the submit-time check and the component-level totalJobs (which gates the Create button and the "N jobs will be created" text) now count nested selections, so a pure-nested WO is no longer treated as empty.
**Quantity fix (#4):** the latent addJobFromBOM 1:1 bug is moot on the nested path — nested job qty comes from explode_bom's multiplied cumulative qty, not the flat adder.
**Files:** src/lib/nestedAssembly.js, src/components/CreateWorkOrderModal.jsx.

### D-NEST-07 — Sub-assembly check-in on completion + scoped job flip (Batch C1) (2026-06-16)
**What:** In Assembly.jsx handleCompleteAssembly, a completed sub-assembly (a woa with parent_work_order_assembly_id set) with no outstanding routing steps now goes to status 'complete' (consumed by parent) instead of 'pending_tco', and inserts an assembly_component_checkins row into its parent (source_work_order_assembly_id = the sub-assembly woa, job_id NULL, quantity_received = good qty) — the Option A primitive from Batch A. Top-level assemblies (no parent) still go to pending_tco for TCO.
**Scoped job flip:** the post-completion job flip to pending_tco is now scoped to the completing woa's own jobs (.eq('work_order_assembly_id', completeItem.id)) instead of the whole work order, so completing a sub-assembly no longer prematurely flips the parent woa's component jobs. No change for single-assembly WOs (one woa owns all jobs).
**Load:** added parent_work_order_assembly_id to the work_order_assemblies select.
**Deferred to C2:** parent-blocked-until-subs-complete readiness, computeSupplyQty over woa-backed components, and the blocked-card UI. **Deferred to Batch D:** the check-in for a sub-assembly that itself has external routing steps (fires on outbound return in OutsourcedJobs, not at completion).
**Files:** src/components/Assembly.jsx.

### D-NEST-08 — Parent readiness over sub-assemblies + scoped start (Batch C2) (2026-06-16)
**What:** Assembly.jsx now treats a parent woa's child sub-assemblies as inputs, not just its component jobs. A parent is assemblable only when all its component jobs are ready AND every child sub-assembly (work_order_assemblies where parent_work_order_assembly_id = the parent) is 'complete'. When jobs are ready but a child sub-assembly isn't, the parent surfaces in the queue flagged blocked — amber border, "Waiting on sub-assembly: X" line, and a Blocked badge in place of Start. computeSupplyQty now also folds in woa-backed components: a child's good_quantity is its supply (an incomplete child caps the parent at 0). Sub-only parents (no direct jobs) are no longer skipped.
**Scoped start:** handleStartAssembly's job flip to in_assembly is scoped to the starting woa's own jobs (work_order_assembly_id), matching the C1 completion fix — starting a sub-assembly no longer drags the parent woa's jobs into in_assembly. No change for single-assembly WOs.
**Files:** src/components/Assembly.jsx.

### D-NEST-09 — Assembly KPI count aligned with nested readiness (2026-06-16)
**What:** The Assembly tile count in Mainframe.jsx computed readiness independently of Assembly.jsx and required each counted woa to have ≥1 direct component job (woaJobs.length > 0), so a sub-only parent (whose only manufactured input is a sub-assembly) was skipped while the Assembly panel correctly showed it — the tile undercounted. Fixed: the KPI loop now mirrors Assembly.jsx (C2) — child sub-assemblies count as inputs, sub-only parents are counted, and parent_work_order_assembly_id was added to the KPI's work_order_assemblies fetch. The tile now matches the panel's queue + in-progress set (blocked parents included, completed sub-assemblies excluded).
**Files:** src/pages/Mainframe.jsx.

### D-NEST-10 — Order Lookup shows sub-assemblies nested under their parent (Batch D1) (2026-06-16)
**What:** The WO detail in Mainframe's Order Lookup previously flat-mapped work_order_assemblies, so a nested WO rendered the parent and its sub-assembly as unrelated sibling cards. Now the woa list is ordered parents-first, each followed by its children (depth-first); sub-assembly cards are indented with a purple left rule and the header carries a "Sub-assembly of <parent part #>" badge. Added parent_work_order_assembly_id to the WO-detail work_order_assemblies fetch.
**Scope:** display only — card content, routing, and job rendering unchanged. Single-level WOs (no parent links) render exactly as before.
**Files:** src/pages/Mainframe.jsx.

### D-NEST-11 — Traveler shows assembly genealogy (Batch D2) (2026-06-16)
**What:** The Job Traveler now renders an "Assembly Genealogy" section for component jobs that feed an assembly: the chain from the part's immediate (sub-)assembly up to the finished assembly, each with its role (Sub-assembly / Finished assembly) and ALN. Added fetchAssemblyChainForTraveler(supabase, jobId) to lib/traveler.js (walks the job's woa up its parent chain) and an assemblyChain field on travelerData; the section renders only when a chain is present. Wired into the four shared traveler surfaces (Kiosk, Finishing, ComplianceReview, Mainframe Order Lookup) via the existing fullJob pattern. Non-assembly component travelers are unchanged (empty chain → no section).
**Deferred:** PrintPackageModal uses its own trimmed traveler builder (no CO-section table either); adding genealogy there is a separate follow-up.
**Files:** src/lib/traveler.js, src/pages/Mainframe.jsx, src/pages/Finishing.jsx, src/pages/Kiosk.jsx, src/components/ComplianceReview.jsx.

### D-NEST-12 — Sub-assembly with external routing checks into parent on return (Batch D3) (2026-06-16)
**What:** A sub-assembly that itself has external routing (plating/HT after assembly) is left ready_for_outsource by handleCompleteAssembly — C1's check-in deliberately does not fire while external work is outstanding. When its last external send returns and ALL its routing steps are complete, OutsourcedJobs now mirrors C1: if the WOA has a parent, it sets the WOA to 'complete' (consumed) instead of pending_tco and inserts the parent check-in (work_order_assembly_id=parent, source_work_order_assembly_id=sub, job_id=null, quantity_received=woa.good_quantity, fallback quantityReturned). Top-level assemblies still go to pending_tco. Only the assembly-path return block (keyed on allStepsComplete) is affected; the two finishing/job-path blocks (allExternalComplete) are unchanged.
**Files:** src/components/OutsourcedJobs.jsx.

### D-NEST-CLOSE — Nested Assembly feature complete (2026-06-16)
**Status:** Batches A–D shipped and verified on TEST behind FEATURES.NESTED_ASSEMBLY (exercised with ASSEMBLY_MODULE=true). Decisions D-NEST-01 through D-NEST-12. Implementation plan renamed to Nested_Assembly_Implementation_Plan_CLOSED.md. Batch structure: A (schema + explode_bom), B1/B2 (Create-WO recursive explosion + submit), C1/C2 (assembly-side consumption + parent readiness) + D-NEST-09 KPI alignment, D1/D2/D3 (Order Lookup nesting, traveler genealogy, sub-assembly external-return check-in). Convention reaffirmed: finished goods are never nested and never the top of a nested tree — the finished_good skip in Assembly.jsx and finished_good→pending_tco routing are correct and untouched. Deferred (tracked, non-blocking): PrintPackageModal genealogy (it has its own trimmed traveler builder with no CO-section table either).

### D-MROLE-02 — Multi-role shipped (2026-06-17)
`profiles.roles text[]` (default `'{}'`) added; `user_has_role(uid, VARIADIC roles)` SECURITY DEFINER helper live. The `profiles.role` CHECK constraint was extended to include `'purchaser'` so the role is valid as a *primary* too (needed for purchaser-only users and the verification test user); `roles[]` itself is intentionally left unconstrained (small shop; avoids a second enum to maintain). Frontend: `userRoles()`/`hasRole()`/`canWriteMasterData()`/`canReceive()` in `lib/roles.js`; Armory tab visibility is now a **union** across the effective role set; `canViewSalesDashboard` and Armory's capability gates (`canLink`, `canEditRules`, `isApprover`, the self-approve exemption, admin lot-doc delete) route through `hasRole`. `App.jsx` `canAccessArmory` is multi-role aware (+purchaser). The `manage-users` edge function persists `roles` on invite / invite_no_email / update_profile. Peripheral guards (Finishing, Compliance, Bridge, Customer Orders, Mainframe) still read the primary `role` — scoped; migrate opportunistically. Supersedes the "pending" status of D-MROLE-01.

### D-PURCH-02 — Purchaser shipped + scope notes (2026-06-17)
Purchaser matrix per D-PURCH-01 implemented. UsersTab gained an "Additional Roles" multi-select (excludes the primary; the primary-role picker prunes the chosen role from the additional set) backed by the edge-function `roles` change. Implementation clarifications: (1) the Receiving tab's only write control is the **Log Receipt** button — the receiving table is read-only display and cert upload lives inside that modal — so `canReceive` wraps just that button. (2) The Inventory-tab rack-reassign control was left **ungated** (pre-existing behavior; President/Viewer can already use it today). Out of scope for this rollout; purchaser inherits it under "Inventory = view." Flagged for opportunistic cleanup. The adjustment-submit and reconciliation-link RPCs now admit `purchaser` via `user_has_role`; the approve RPCs do not. Supersedes the "pending" status of D-PURCH-01.

### D-RLS-MAT01 — Material master writable by compliance, not just admin (2026-06-16)
**Problem:** Compliance (Roger/Tom) hit "new row violates row-level security policy for
table materials" when adding a material. The app grants compliance the material_master
tab with write access (Armory TAB_ACCESS_BY_ROLE), but the S7 materials RLS policies
("Admin insert/update materials") restricted writes to role = 'admin' only — a UI/RLS
mismatch.
**Fix:** Replaced the admin-only INSERT and UPDATE policies on public.materials with
"Material master insert/update (admin, compliance)" allowing role IN ('admin','compliance')
via the standard profiles/auth.uid() EXISTS pattern. SELECT unchanged (all authenticated);
hard DELETE stays admin-only (compliance deactivates via is_active, an UPDATE now covered).
**Applied:** TEST → verified compliance insert → PROD. No app/schema change.
**Note:** parts and material_types remain open to any authenticated user — looser than
ideal, flagged for a future RLS-consistency pass, out of scope here.

### D-RACK-LOGOUT01 — Rack kiosk inactivity auto-logout (2026-06-17)
**Problem:** MaterialKiosk had only a manual Log out button (no idle timeout, unlike the
machine kiosk), so the first operator of the day stayed authenticated and every
subsequent material check-out (loaded_by/staged_by) was stamped to them.
**Fix:** Added inactivity auto-logout (3-min window) mirroring Kiosk.jsx — activity
listeners reset a lastActivity clock; an interval signs out and returns to the PIN
screen after the window elapses. lastActivity reset on login.
**Files:** src/pages/MaterialKiosk.jsx.

### D-WOLOOKUP-DOCDEL01 — Delete documents from WO Lookup (admin/compliance) (2026-06-17)
**What:** Added a per-document delete (trash) button to the WO Lookup modal document
list, gated to canManageJobDocs (admin, compliance). Deletes the job_documents row then
removes the storage object (deleteDocument, best-effort) and updates the cache. Extracted
a shared renderJobDocRow helper used by both the assembly-jobs and fallback-jobs views.
Paired RLS: "Job docs delete (admin, compliance)" DELETE policy on job_documents.
**Files:** src/pages/Mainframe.jsx (+ RLS migration).

### D-CLOSEDWO-SEARCH01 — Closed work order search in Order Lookup (2026-06-22)
Added a server-side "Closed" mode to the Work Orders tab of the Order Lookup so
admin/compliance can retrieve TCO'd / cancelled / closed WOs on demand (FAA/AS9100
records retrieval), replacing ad-hoc SQL. New RPC search_closed_work_orders(p_term,
p_limit=50), SECURITY DEFINER, matches wo_number, customer, job_number, component
part_number, and assembly part_number (ILIKE) for status IN
('complete','cancelled','closed'), ordered by COALESCE(closed_at, created_at) desc;
backed by pg_trgm GIN indexes + FK indexes (migration
2026-06-22_closed_wo_search_batchA.sql). Mainframe.jsx hydrates matched WO ids through
the existing embedded select (extracted to WO_LOOKUP_SELECT) and hydration helper
(hydrateWOExtras), so the existing drill-down, document viewer, and Job Traveler render
unchanged. Closed mode is search-driven (no results until a term is entered), bounded to
top 50, gated to admin/compliance in the UI (RPC itself is authenticated, ids-only).
Decisions baked in: included 'closed' status so cancelled-maintenance WOs are retrievable;
included assembly part numbers for parity with active search. Active lookup path
unchanged. Batch C (optional date filter, test script, spec bump) remains.

### D-CLOSEDWO-SEARCH02 — Closed WO search date window + Batch C closeout (2026-06-22)
Layered an optional date window onto search_closed_work_orders (new 3rd arg p_since
timestamptz default null; filters COALESCE(closed_at, created_at) >= p_since). Closed mode
UI gains a "Last 12 months" (default) / "All time" selector; default bounds history without
extra typing, "All time" passes p_since=null. Backward compatible — the 2-arg-style call was
replaced everywhere it is used. Migration: 2026-06-22_closed_wo_search_datewindow.sql.
Batch C test script intentionally skipped per owner (manual TEST verification sufficient:
J-000058 retrievable under both windows; future-dated window returns 0). Closed WO Search
arc complete (Batch A primitive, Batch B UI, Batch C date window); spec bumped to v4.1;
plan renamed Closed_WO_Search_Implementation_Plan_1_CLOSED.md.

### D-DEMAND-ENTERED01 — Demand tab "Entered" shows Invalid Date (2026-06-22)
**Problem (SKY82):** The Customer Orders → Demand tab "Entered" column rendered "Invalid Date" on every line. lib/customerOrders.js maps entry_date = customer_order_lines.created_at (a timestamptz), but the Demand render passed it through formatDate(), which splits on "-" expecting a YYYY-MM-DD DATE and produced NaN on the time-bearing day token.
**Fix:** Render entry_date with `new Date(line.entry_date).toLocaleDateString()`, mirroring the Orders tab's created_at rendering. formatDate() left unchanged (still correct/local-noon for the DATE columns due_date and earliest_due). No lib or schema change.
**Files:** src/pages/CustomerOrders.jsx.

### D-RLS-DOWNTIME01 — Kiosk can't end downtimes; open UPDATE on machine_downtime_logs (2026-06-22)
**Problem (SKY79):** Machinists could fill in a downtime's end time in the kiosk but submit did nothing. machine_downtime_logs had INSERT/SELECT/DELETE open to authenticated (true) but UPDATE gated by "logged_by = auth.uid()". The machine kiosk runs under a single shared auth session yet stamps logged_by with the PIN operator's profile id (Kiosk.jsx: logged_by: operator.id), so the row's logged_by never equals the session auth.uid() — the UPDATE matched zero rows with no error (silent RLS no-op).
**Fix:** Dropped "Users can update their own downtime logs"; added "machine_downtime_logs_update_authenticated" (UPDATE, authenticated, USING true, WITH CHECK true), matching this table's INSERT/SELECT/DELETE posture and jobs.UPDATE. No new exposure (table is already operator-shared). Admin ALL policy left as-is.
**Applied:** TEST → verified end-downtime in kiosk → PROD. No app/schema change.

### D-PARTS-HARDDEL01 — Hard-delete for unreferenced parts (SKY88) (2026-06-22)
**Problem (SKY88):** The Armory parts trash was a soft delete (is_active=false). On an already-inactive part (e.g. "Pending Master Data" placeholders) it set false->false — UPDATE succeeded with no error, fetchData ran, and the Inactive filter still matched the row, so "nothing happened." No way to actually remove a part once deactivated. Not RLS/permission (parts UPDATE/DELETE open to authenticated; confirm dialog fired; a privileged UPDATE proved table mechanics).
**Fix:** Brought parts to parity with the materials master. The single trash is split into (1) a Deactivate/Activate toggle (handleTogglePartActive, soft) and (2) a hard Delete gated by a blocking-reference count, opening a confirmation modal. Blocking refs (deactivate-only, AS9100 traceability): jobs.part_id/component_id, customer_order_lines.part_id, work_order_assemblies.assembly_id, assembly_bom.component_id. partRefCounts (computed in fetchData) counts only those. Hard delete calls RPC delete_part(p_part_id) (SECURITY DEFINER, search_path=public): re-checks authz (admin/compliance via role+roles) and the blocking set server-side, then deletes owned config (part_routing_steps, part_machine_durations, part_document_requirements, part_documents, the part's own assembly_bom rows) and the part atomically. Old handleDeletePart removed.
**Files:** src/pages/Armory.jsx; migration 2026-06-22_delete_part_rpc.sql.
**Caveat:** part_documents S3 objects are not cleaned (DB rows only) — acceptable for placeholder parts; flagged if bulk part purging becomes common.

### D-WOLOOKUP-ROLLUP01 — Build Summary rollup in WO lookup (SKY87) (2026-06-22)
**What:** Added a "Build Summary" panel at the top of each expanded WO in the Order Lookup (Work Orders tab), above CO Fulfillment. Groups top-level products (work_order_assemblies, parents-first) and, beneath each, the component parts (jobs grouped by component_id) with Ordered (sum job.quantity) and Built (sum getEffectiveQty(job).qty — the app's single source of truth for produced-through-finishing). Assembly-level built uses computeAvailableQty(woa) (0 until Jody completes; foundation for when ASSEMBLY_MODULE flips). WOs without assemblies render a single component table; jobs not linked to a WOA fall under "Other components". A '*' on Built marks a machinist count still pending compliance; a footnote notes assembly counts populate once the Assembly module is enabled.
**Files:** src/pages/Mainframe.jsx. No schema/RLS change (uses existing WO_LOOKUP_SELECT data).

### D-WOLOOKUP-ROLLUP02 — Collapsible product sections in WO lookup (SKY87) (2026-06-22)
**What:** Each product (work_order_assembly) section in the Order Lookup WO detail is now collapsible — a chevron on the assembly header toggles collapsedProducts (Set of woa.id), hiding that product's assembly routing + jobs. Default expanded (no behavior change); collapse on demand to tidy large multi-product WOs. Assembly-path only (the no-WOA fallback list is unaffected).
**Files:** src/pages/Mainframe.jsx.

### D-WOLOOKUP-ROLLUP03 — Collapsible per-part job groups in WO lookup (SKY87) (2026-06-22)
**What:** Within each product (and the no-product fallback list), the WO-detail jobs are now grouped by component part — each part a collapsible row (chevron + part number + description + job count) holding all of that part's jobs together, instead of jobs interleaved by part. Added collapsedParts (Set of `${scopeKey}:${componentId}`; scopeKey = woa.id in the assembly path, wo.id in the fallback) and a groupJobsByComponent(jobList, scopeKey) helper (first-seen order). The job card render is unchanged — the group just wraps the existing job map in both paths. Default expanded.
**Files:** src/pages/Mainframe.jsx.

### D-JOBLINK-01 — Co-production job linking, Phase 1 primitive (SKY89) (2026-06-22)
**Context:** Scheduler needs duplicate same-component jobs across different assembly WOs to run as one batch under one lot (J-000038 cup on WO-2605-0025/SK40S5-10S + AIR TRACTOR alloc; J-000067 cup on WO-2606-0018/SK4002-10S + GIZA alloc + a manufacturing_complete sibling SK4C10S). Collapse/merge was rejected — collapsing either WO would strand the other product's sibling job + customer allocation. Chosen model: LINK (co-production), each job keeps its WO/WOA/qty/allocation.
**What:** Added jobs.combined_batch_id (uuid, partial index). RPC link_jobs(uuid[]) (SECURITY DEFINER, scheduler/admin) validates >=2 jobs, same component_id, same assigned_machine_id, pre-start only (status in pending_compliance/ready/assigned, no production_lot_number, no job_materials, not maintenance, not already linked) and stamps a shared combined_batch_id; unlink_jobs(uuid) clears it while still pre-start.
**Next:** Phase A — link/unlink UI + visual grouping (Schedule job panel, WO Lookup). Phase B — kiosk co-run (one production + material lot, combined run, good-piece distribution) which is what actually enforces the single lot.
**Files:** migration 2026-06-22_job_link.sql.

### D-JOBLINK-02 — Co-production link UI, Phase A (SKY89) (2026-06-22)
**What:** Added a "Combine" section to the Schedule selected-job panel. For a pre-start job (pending_compliance/ready/assigned, no production lot) it lists eligible partners — same component_id, same assigned_machine_id, pre-start, unlinked — as checkboxes and links them + the job via link_jobs. For an already-linked job it shows the batch members + combined quantity and an Unlink (unlink_jobs) control. combined_batch_id flows through the existing select('*'); reload via fetchData; Layers used as the batch icon. Partner/member pool is the loaded scheduledJobs (current window) — a member scheduled outside the window won't appear; acceptable for the panel (Phase B computes from the DB).
**Files:** src/pages/Schedule.jsx. Requires D-JOBLINK-01 migration + RPCs deployed first.
**Next:** A.2 — link badge on schedule job blocks. Phase B — kiosk co-run (one production + material lot, combined run, good-piece distribution).

### D-JOBLINK-03 — Link badge on schedule blocks (SKY89 A.2) (2026-06-22)
**What:** JobBlockContent (shared schedule block renderer) shows a Layers icon on Line 1 when job.combined_batch_id is set, so linked co-production jobs are visible at a glance across all schedule views.
**Files:** src/pages/Schedule.jsx.

### D-JOBLINK-04 — Kiosk co-production run (SKY89 B2) (2026-06-22)
**What:** New src/lib/coProduction.js (batchPrimaries / hiddenBatchMemberIds / batchCombinedQty / propagateBatchStart). Kiosk: the machine queue collapses a combined batch to its primary (earliest WO due date, then job_number) and hides non-primary members so they can't be started separately (queue render + handleJobSelect out-of-order check); the active primary shows a "Combined batch · run N total" banner; and on production start (handleConfirmMaterials + the material-override path) the primary's production lot + material lot are propagated onto the other members, which are set in_progress.
**Deploy:** TEST ONLY until B3. Members go in_progress on start but nothing completes them until B3 (completion distribution) lands — running a batch in PROD before B3 would strand members in_progress.
**Files:** src/lib/coProduction.js (new), src/pages/Kiosk.jsx.
**Next:** B3 — single good/bad entry uses the combined target, calls distribute_batch_completion (earliest-due split, validated), then advances all members through routing together.

### D-JOBLINK-05 — Kiosk co-production completion + lockstep advance (SKY89 B3) (2026-06-22)
**What:** Made all three job-finalization points batch-aware. (1) Kiosk Complete (Kiosk.jsx handleCompleteJob) and (2) finishing pickup-queue Complete (Finishing.jsx handlePickupComplete) now call distribute_batch_completion(combined good count) to split good pieces across members by earliest WO due date (surplus + scrap to the earliest-due primary), then advance every member to the primary's resolved status and run per-member shortfall. (3) Compliance approval (ComplianceReview.jsx handleApproveBatch) advances batch members in lockstep when the primary leaves manufacturing_complete, since a batch's finishing sends all live on the primary and members never hit that path themselves. Kiosk completion modal target (Required Pieces, projected/shortfall) shows the combined batch quantity.
**Why:** B2 leaves members in_progress sharing the primary's lot; B3 is what completes and advances them. Without B3 a batch's members strand. The primary carries the whole physical finishing batch under one lot; member good_pieces are credited per-allocation by the distribution RPC.
**Assumptions/limits:** Linked members are the same component (enforced by link_jobs), so they share routing/part_type and the primary's resolved nextStatus applies to all. distribute_batch_completion is deterministic, so running it from either completion path yields the same split.
**Deploy:** TEST with B2 → full cycle (link → kiosk start → kiosk Complete → compliance approve, confirm member good_pieces split + lockstep advance) → PROD.
**Files:** src/pages/Kiosk.jsx, src/pages/Finishing.jsx, components/ComplianceReview.jsx.

### D-JOBLINK-06 — Schedule merge band for co-production batches (SKY89 B2.5) (2026-06-22)
**What:** Contiguous combined-batch members on a machine now render as ONE band on the schedule instead of separate blocks. New machineBatchMergePlan(machineJobs) in src/lib/coProduction.js decides per machine which batches are contiguous (each next start <= running span end, 60s tolerance); the band is carried by the earliest-scheduled member (anchors left, end extended to the latest member end via a render-only _mergeSpanEnd), the other members are hidden. Applied in Schedule.jsx getJobsForMachineDay (drives both the week and zoomed maps); getJobBlockStyle / getJobBlockStyleZoomed honor _mergeSpanEnd; JobBlockContent shows "Qty: <combined> · <n> jobs" on the band (the A.2 Layers badge still marks it).
**Why:** B2/B3 already run linked members as one batch under one lot; two side-by-side blocks (option-a request) misrepresented one run as two and over-reserved the machine. Chosen option (a): merge only when contiguous; non-contiguous linked batches fall back to separate badged blocks.
**Limits:** Render-only — the carrier's real scheduled_start/scheduled_end are unchanged, so click/drag/resize/detail-panel act on the carrier alone. Dragging/resizing a member of a linked batch is not batch-aware yet (members don't move together); unlink first to reschedule. Span reserves the existing contiguous slots (conservative) until cycle-time data compresses it later.
**Files:** src/lib/coProduction.js, src/pages/Schedule.jsx.

### D-JOBLINK-07 — Co-production visibility on both jobs (SKY89 Option A) (2026-06-22)
**What:** Linked batch members are now visible everywhere, not just the carrier. Kiosk: members are no longer hidden from the machine queue (shown with a "Linked" badge, marked non-"Next"); tapping a member routes selection to the carrier (handleJobSelect via batchPrimaries) so the batch still starts as one run under one lot; the Active Job panel lists every linked job. WO Lookup (Mainframe): added combined_batch_id to the job select and a batchFinishing map (loaded in fetchData) that aggregates the carrier's finishing sends per combined_batch_id; each member's WO row shows a "Combined batch · N jobs · total (carrier J-xxxx)" panel with the batch's finishing send lines and the member's allocated qty.
**Why:** Sends physically live on the carrier (one lot), so a member's WO looked idle mid-run and only the carrier appeared in the kiosk. Option A keeps one physical lot but surfaces the shared batch on both jobs (display-only aggregation); good pieces are still split per member at completion (B3).
**Files:** src/pages/Kiosk.jsx, src/pages/Mainframe.jsx.

### D-JOBLINK-09 — SKY89 (linked jobs) reverted (2026-06-22)
**What:** Reverted all SKY89 co-production/linked-jobs work (D-JOBLINK-01..08) from the frontend (restored Schedule/Kiosk/Mainframe/Finishing/ComplianceReview to the last pre-SKY89 commit, deleted src/lib/coProduction.js) and dropped the DB objects (jobs.combined_batch_id, idx_jobs_combined_batch, link_jobs, unlink_jobs, distribute_batch_completion). SKY87 (D-WOLOOKUP-ROLLUP*) retained.
**Why:** Co-scheduling linked members on one machine collides with the jobs_no_machine_overlap exclusion constraint, and non-atomic kiosk completion duplicated finishing sends on retry. Needs a proper batch-entity design — see Docs/Linked_Jobs_Implementation_Plan.md. To be revisited in a dedicated sprint with the scheduler.
**Files:** src/pages/Schedule.jsx, src/pages/Kiosk.jsx, src/pages/Mainframe.jsx, src/pages/Finishing.jsx, components/ComplianceReview.jsx, src/lib/coProduction.js (deleted).

### D-INV-BARLENGTH01 — Available bars by length in inventory + cycle count (SKY85) (2026-06-23)
**What:** Surfaced bar length (standardized to 4 ft = 48" and 12 ft = 144") as a visible dimension. The Inventory "By Size" roll-up now splits each material+size row's available bars into 4 ft and 12 ft columns (plus an "Other" column shown only when non-48/144 stock exists), with matching footer totals. The on-screen Cycle Count table and the printed Cycle Count Sheet gained a Length column. Shared fmtBarLength helper (Number-coerced; renders 4 ft / 12 ft, else raw inches).
**Why:** James needed to see how many bars of each length are on hand (SKY85). Length already flowed through material_availability.bar_length_inches per receipt; this only surfaces/aggregates it — no schema or query change.
**Scope notes:** Replenishment min-on-hand stays keyed to material+size (length is informational); the Lot view already shows per-receipt rows. Frontend-only, no migration.
**Files:** src/pages/Armory.jsx.

### D-INV-BARLENGTH02 — Cycle count by length: 4 ft / 12 ft columns (SKY85) (2026-06-23)
**What:** Reworked the Cycle Count table and printed Count Sheet from one row per receipt (Length + single Counted) to one row per rack|material|bar_size|lot with separate 4 ft and 12 ft count inputs; an "Other" column appears only when non-48/144 stock exists. Each input stays bound to its own material_receiving_id, so countItems and handleSubmitCount are unchanged. Supersedes the Length/single-Counted layout from D-INV-BARLENGTH01 (the By-Size roll-up from that change is unaffected).
**Why:** Counters needed to enter 4 ft and 12 ft physically on one line per lot rather than as separate rows.
**Edge handling:** Multiple receipts of the same lot+length stack as multiple inputs in the cell (rare). Non-48/144 receipts route to the Other column (length-labeled), keeping them countable.
**Files:** src/pages/Armory.jsx.

### D-INV-BARLENGTH03 — Cycle count: enter new lengths + drop "Other" (SKY85) (2026-06-23)
**What:** The Cycle Count grid now shows a 4 ft and a 12 ft input on every lot row regardless of which length has a receipt. Entering a count on a length with no receipt creates a 0-qty receipt for that lot+length (RPC create_count_discovery_receipt, SECURITY DEFINER, clones material/size/rack/vendor from a reference receipt in the lot) and files the normal adjustment (+N) against it through the existing submit/review flow — nothing goes live until approved. Removed the "Other" length column from grid and printed sheet; 48" => 4 ft, everything else => 12 ft (only 48/144 are valid). New handleSubmitCountWithDiscovery creates discovery receipts then calls submit_inventory_adjustments; button uses totalCountChanges.
**Why:** Shop cuts 12 ft and returns 4 ft, so a lot needs counts at a length it has no receipt for. inventory_adjustment_requests.material_receiving_id is NOT NULL, so the count needs a receipt to target — hence the 0-qty discovery receipt.
**Edge/limits:** Rejected discoveries leave a harmless 0-qty receipt (shows no stock; cleanup later if needed). A 142" receipt (lot 2623) now buckets as 12 ft and should be corrected to 144 in receiving.
**Files:** src/pages/Armory.jsx; migration create_count_discovery_receipt.
**Pinned:** bolt-master "blank" lots (5-digit placeholders) — separate solution still owed.

### D-BLANKS-01 — Blanks inventory Phase 1: category flag + Receive Blanks (2026-06-23)
**What:** Introduced blanks (uncut cold-headed studs, 1 blank = 1 part, Bolt Master only) as a material category reusing the existing material tables. Migration adds `material_receiving.category text not null default 'bar'` (check `('bar','blank')`) + index `idx_material_receiving_category`; all 74 existing rows default to `'bar'`. Frontend: an isolated "Receive Blanks" button + modal on the Armory Receiving tab, separate from the bar "Log Receipt" path (untouched). A blank receipt inserts a `material_receiving` row with `category='blank'`, `material_id=null`, `bar_length_inches=null`, `material_type`=blank type (4000/2000), `bar_size`=dash (1–20), `quantity`=blank count, `price_per_bar`=total ÷ qty (cost per blank), `rack` defaulting to "Blank Rack". Lot # is required + manually entered; PO is optional but present.
**Why:** Bolt-master jobs stamp `material_usage` lots (5-digit placeholders like 50509) with no receiving record, firing `unknown_lot` flags. Real received blank lots are the prerequisite for Phase 2 (deduct consumption from a real lot). Reusing the material tables inherits availability (D-AVAIL-01: `available_bars = received − used + Σadj`, well-defined for null `bar_length_inches`), reconciliation, and the cycle-count screen.
**Decisions:** (1) Lot # required + manual — Phase 2 lot-select must match the physical lot. (2) PO optional but present (`po_number` nullable). (3) Isolated blank modal, not an in-modal toggle — zero regression to the bar path. (4) Blanks excluded from bar Lot/By-Size/replenishment/Est-Value aggregates (Phase 1b).
**Limits/next:** Until Phase 1b, a blank row also shows in the existing By Lot / By Size inventory views (Avail "—"); 1b adds the Bars/Blanks switch, the `loadInventory` category side-lookup, and the `category='bar'` filter plus a dedicated Blanks table. Consumption (Phase 2, bolt-master kiosk) and placeholder-flag cleanup (Phase 3) are out of scope here.
**Files:** src/pages/Armory.jsx; migration Docs/migrations/2026-06-23_blanks_phase1_category.sql.

### D-BLANKS-02 — Blanks inventory Phase 1b: Inventory Bars/Blanks split (2026-06-23)
**What:** Added a Bars/Blanks switch to the Armory Inventory tab. `loadInventory` now attaches `category` to each row via a batched `material_receiving` lookup (the `material_availability` view doesn't carry it). The existing By Lot / By Size bar views, the summary strip, and replenishment `fullTotalsByGroup` are filtered to `category='bar'`, so blanks no longer appear in bar inventory. A new Blanks sub-view renders a slim strip (blank-lot count, blanks available, est. value) and a compact table: Rack · Vendor · Type · Dash · Lot # · Qty Available · Cost/Blank. The By Lot/By Size toggle is hidden in Blanks mode.
**Why:** Completes Phase 1 (visibility): blanks are first-class in inventory with their own view while bar aggregates stay blank-free (scoping decision #4). Cost/Blank reads `price_per_bar` (cost per blank); Qty Available reads `available_bars` (received − used + Σadj), well-defined for null `bar_length_inches` per D-AVAIL-01.
**Scope notes:** Frontend-only, no migration (the `category` column shipped in D-BLANKS-01). Blanks intentionally excluded from replenishment min-on-hand and the Est-Value summary. Consumption (Phase 2, bolt-master kiosk) and placeholder-flag cleanup (Phase 3) remain out of scope.
**Files:** src/pages/Armory.jsx.

### D-BLANKS-03 — Blanks inventory Phase 2: bolt-master consumption (2026-06-23)
**What:** Bolt-master jobs now consume real blank lots. (1) Start (Kiosk.jsx, bolt-master only via existing `isBoltMaster`): the start button opens a dedicated blank-lot picker (on-hand `category='blank'` lots — Lot · Type · Dash · Qty Avail) instead of the bar material modal; the selected lot is stored on `jobs.blank_lot_number` and production starts (PLN minted from the blank lot). No deduction at start; the bar material modal is untouched. (2) Deduction (Finishing.jsx `handleAdvanceStage`, last-stage completion): when James records the verified finishing count, `consume_blank_lot(finishing_send, job, blank_lot, verified_count, operator)` inserts a `material_usage` row against the real blank lot. (3) Migration: `jobs.blank_lot_number`, `material_usage.finishing_send_id` (FK + partial unique index), and the idempotent `consume_blank_lot` RPC.
**Why / key decision (logged at Matt's request):** The deduction is driven by **James's verified finishing count (`finishing_sends.verified_count`), NOT the machinist/kiosk send count** — machinist counts are not trusted as accurate. All bolt-master jobs run through finishing (James handles everything post-machining), so a verified count always exists. This supersedes the earlier option of deducting the kiosk `finishingTotal` at machine-kiosk completion.
**Design notes:** Idempotency is per `finishing_send_id` (a job can have multiple finishing batches, each deducting its own verified count, summing to the job total) via a partial unique index + RPC guard + `unique_violation` catch. Hard block at start: the picker lists only real on-hand blank lots and Start is disabled until one is chosen, so bolt-master jobs can no longer mint unknown-lot placeholders. The deduction is non-blocking (logs `inventory_warning` on failure); the periodic blank cycle count is the drift backstop, and scrapped blanks are intentionally not deducted (verified good count only). Supersedes the legacy `isBoltMaster` material-type-named-'blank' start path (Kiosk.jsx:5263).
**Files:** src/pages/Kiosk.jsx, src/pages/Finishing.jsx; migration Docs/migrations/2026-06-23_blanks_phase2_consumption.sql.

### D-BLANKS-04 — Blanks start: free-lot entry, never block (reverses D-BLANKS-03 hard block) (2026-06-23)
**What:** The bolt-master blank-lot picker (Kiosk.jsx) now lets the operator type any lot number and start, with on-hand blank lots shown as tap-to-fill suggestions. Confirm & Start is enabled whenever a non-empty lot is entered; "no blank lots on hand" is now an informational note, not a block. Mirrors the bar-stock flow (operator enters a lot whether or not it's in inventory).
**Why:** Production must never be stopped because receiving paperwork isn't done. Per Matt: operators must always be able to proceed; the system prompts with what's on hand but allows lots that don't exist yet. Reverses the "hard block" portion of D-BLANKS-03.
**Unmatched lots:** consume_blank_lot finds no category='blank' receipt → inserts material_usage with material_receiving_id null ('consumed_unmatched_lot'), which the existing AFTER-INSERT trigger flags as unknown_lot — same as bars. The Phase 1 link nudge connects the orphaned usage to the receipt when it's later logged. Per-finishing-send idempotency unchanged. Frontend-only, no migration.
**Files:** src/pages/Kiosk.jsx.

### D-BLANKS-05 — Receive Blanks: catalog-driven blank type (2026-06-23)
**What:** The Receive Blanks "Blank Type" dropdown now reads blank material types from the `material_types` catalog (filter: name contains "blank"; list is already active-only) instead of the hardcoded "4000"/"2000" from D-BLANKS-01. The selected type name is stored as `material_receiving.material_type`, so naming is consistent across receiving, Inventory > Blanks, and the kiosk blank-lot picker, and new blank series can be added in the catalog with no code change.
**Why:** Shop catalog names blanks "Blank Studs - N Series"; the hardcoded labels didn't match. Material types carry no bar size (only the materials master does), so blanks still need no master row — this keeps the material_id=null, no-bar-size design from D-BLANKS-01 while sourcing the type name from the catalog. Name-based filter matches the existing kiosk convention (Kiosk.jsx `isBoltMaster`).
**Note:** Any blanks received under the old hardcoded "4000"/"2000" during testing keep those values (cosmetic); re-receive or correct if desired.
**Files:** src/pages/Armory.jsx.

### D-BLANKS-06 — Receive Blanks: default vendor AJ Fasteners (2026-06-23)
**What:** The Receive Blanks Vendor field now defaults to "AJ Fasteners" (via BLANK_EMPTY), still editable free text.
**Why:** AJ Fasteners is currently the only blank vendor; hard-coded as a convenience for now. Revisit (make it a managed list / source from a vendor table) when a second blank vendor is added.
**Files:** src/pages/Armory.jsx.

### D-BLANKS-07 — Blanks Phase 3: cycle count, auto-reconcile, bolt-master kiosk cleanup (2026-06-23)
**What:** (1) Cycle count (Armory.jsx adjustments tab): the 4ft/12ft bar grid is filtered to `category='bar'`; a separate Blanks count table (Rack · Type · Dash · Lot · single Blanks count) lets counters enter blank counts, filed through the existing submit/approval flow (no discovery receipts — blanks always have a real receipt), sharing `countInputs` and the single Submit (totalCountChanges includes blanks). (2) Auto-reconcile (Armory.jsx handleSaveBlank): receiving a blank links any orphaned `material_usage` for that lot (material_receiving_id null) to the new receipt and resolves open `unknown_lot` flags for the lot. (3) Bolt-master kiosk (Kiosk.jsx): the mid-run "Add Material / Add More" buttons are hidden when `isBoltMaster`.
**Why:** Get blank counts into the system (priority before historical cleanup) and let logged-but-unreceived blank lots reconcile automatically once inventory is in. Bars keep their confirm-nudge for linking; blanks auto-link since the receiver is explicitly logging that exact lot.
**Scope/limits:** Frontend-only, no migration. Printed Cycle Count Sheet stays bars-only (blank counts on-screen for now); the "lots in scope" counter reflects bars (it drives the print sheet). Auto-link matches by lot number (a bar/blank lot collision is theoretically possible, same as the bar nudge). Historical placeholder-flag cleanup (51254/50990/51118) remains deferred.
**Files:** src/pages/Armory.jsx, src/pages/Kiosk.jsx.

### D-BLANKS-08 — Receiving buttons: parallel naming "Receive Bars" / "Receive Blanks" (2026-06-23)
**What:** Renamed the bar receiving flow from "Log Receipt" / "Log Material Receipt" to "Receive Bars" (header button, empty-state hint, modal title, modal submit), pairing it with the "Receive Blanks" button. Display text only.
**Files:** src/pages/Armory.jsx.

### D-PLN-MATLOT01 — PLN captures material lot from DB, not stale kiosk state (2026-06-24)
**What:** PLN generation now resolves the job's material lot from job_materials (DB) at generation time via new resolveJobMaterialLot(jobId), on both the material-confirm and material-override paths, instead of reading only the machine kiosk's local jobMaterials state. generateProductionLotNumber also omits the empty lot segment when no lot is known (PLN-YYMMDD-NNNN instead of PLN--YYMMDD-NNNN).
**Why:** When material is loaded at the raw-material kiosk before the job is started on the machine kiosk, the machine kiosk's local jobMaterials is stale/empty at production start, so the lot was dropped from the PLN — e.g. J-000083 generated PLN-260624-0001 with no lot, corrected by hand to PLN-2592-260624-0001. job_materials.job_id is UNIQUE, so the DB read is the authoritative per-job lot.
**Edge:** The override path still records material_override=true even if a lot is found; that's intentional — it preserves the operator's skip action while keeping PLN traceability.
**Files:** src/pages/Kiosk.jsx.

### D-MAINT-CLOSE01 — Close in-progress maintenance/downtime from kiosk or scheduler (2026-06-24)
**What:** Added a "Complete Downtime — Return Machine to Service" button to the kiosk maintenance (Active Downtime) panel via handleCompleteMaintenance (job->complete, end now, work order->complete, frees the machine when unplanned), and un-gated the Schedule "Close Maintenance Order" control to also appear for in_progress maintenance (was assigned-only).
**Why:** An in_progress maintenance job had no close path anywhere — the kiosk excludes maintenance from completion (!is_maintenance) and the Schedule Close button was gated to status='assigned' ("Maintenance in progress cannot be closed from here"), so a started downtime held the machine DOWN with no way to clear it (e.g. DTU-000003 on MZ-3, fixed by hand). The existing handleCancelMaintenance handler already supports in_progress; only its trigger was gated.
**Edge:** Kiosk completion frees the machine only for unplanned maintenance (planned maintenance doesn't set the machine DOWN); the job/work-order are completed in both cases.
**Files:** src/pages/Kiosk.jsx, src/pages/Schedule.jsx.

### D-BLANKS-09 — Kiosk blank-lot stub capture + Materials panel display (Bolt Masters)
Date: 2026-06-24
Context: Bolt Master jobs record the blank lot on the job but write no job_materials row, so the kiosk Materials panel showed "No materials loaded", and a bare lot number entered for an un-received lot carried no type/dash for inventory or reconciliation.
Decision:
- Select Blank Lot modal now forces Blank Type (from material_types where name ILIKE '%blank%', matching D-BLANKS-05) and Blank Dash (1–20) when the entered lot is NOT on hand; Confirm & Start is gated on both.
- handleStartBlankJob creates a lightweight qty-0 "stub" material_receiving row (category='blank', vendor 'AJ Fasteners', rack 'Blank Rack', note "Entered at kiosk — not yet received") for any entered lot not already present as a blank receipt. No migration. The lot then appears in Inventory → Blanks and the blank cycle count; at finishing, consume_blank_lot matches the stub, and a later formal receipt reconciles via the D-BLANKS-07 auto-link.
- Materials panel: for Bolt Masters it now shows blank type • dash • lot (hydrated in loadJobs from the lot's latest blank receipt/stub, falling back to jobs.blank_lot_number) instead of "No materials loaded".
Frontend-only (Kiosk.jsx). No SQL.

### D-BLANK-CATALOG-01 — Blank catalog (blank_types) + Blank Catalog tab
Date: 2026-06-25
Context: Blanks were stored on material_receiving with free-text material_type + bar_size (dash). The 2000 series splits into 2600 vs 2700, and Steel (4037) vs Stainless (302) must be distinguished — we need to log blank material data like the bar Material Master.
Decision (Phase 1):
- New blank_types table (studs' Material Master): material_type CHECK ('Steel','Stainless'); stud_series CHECK ('4000','2600','2700'); stud_length text (dash '1'..'15' marked, or '1"','1-1/2"','2"' unmarked 4000 stock); is_unmarked boolean (auto-set when an inch length is chosen — unmarked blanks are dash-agnostic; machinist picks dash at run time); alloy nullable (302/4037 cert traceability); vendor; notes; is_active. UNIQUE (stud_series, material_type, stud_length). RLS: select to authenticated; manage to admin/compliance/purchaser.
- New 'blank_master' tab in Armory ("Blank Catalog") in the Raw Materials group next to Material Catalog, mirroring the material_master list + add/edit modal (dup-check, deactivate/reactivate). Deactivate-only (no hard delete) for now.
- Part-number ↔ blank linking deliberately deferred (not intuitive yet).
Deferred — Phase 2: blank_type_id FK on material_receiving (added with the AJ blanks seed load, which resolves each row's blank_type_id from this catalog). Phase 3: kiosk blank dropdown reads blank_types; unmarked → run-time dash prompt; consume_blank_lot resolves lot+dash (multi-dash-lot gap); retire the legacy %blank% material_types rows.
Frontend = Armory.jsx; migration = blank_types. RLS role-check to be verified against existing materials policies.

### D-BLANK-RECEIVE-01 — Receive Blanks reads the blank catalog
Date: 2026-06-25
Context: The Receive Blanks form used a legacy free-text material_types %blank% dropdown plus a separate 1–20 dash field, writing an unstructured material_type and no catalog link.
Decision: The form now selects a single Blank Type from blank_types (active rows), labeled "<series> <material> · Dash <n>" or "… · <length> (unmarked)". On save it writes blank_type_id = the catalog row, material_type = "<series> <material>" (consistent with the loaded physical-count inventory), and bar_size = the catalog stud_length. The separate Dash field and the %blank% material_types dropdown are removed from this form. Requires D-BLANK-CATALOG-01 (blankTypes state) and the blank_type_id FK (D-BLANK-CATALOG-02).
Deferred: retire the legacy %blank% material_types rows once the kiosk also reads blank_types (next step).

### D-BLANK-CONSUME-01 — Blank consumption resolves by lot + dash
Date: 2026-06-25
Context: Jobs stored only blank_lot_number; consume_blank_lot resolved the blank receipt by lot alone, so multi-dash lots (e.g. 50346, 51215, 50045, 50510) deducted an arbitrary dash. The kiosk picker also collapsed every receipt to its lot (duplicate React keys, no dash captured), so the operator couldn't pick the right one.
Decision: Added jobs.blank_dash. The kiosk blank-lot picker now selects a specific on-hand receipt (keyed by material_receiving_id) and captures its bar_size as blank_dash; typing a lot that maps to exactly one receipt auto-resolves the dash, and Confirm requires a dash for on-hand lots. consume_blank_lot gained p_dash (default null = legacy lot-only) and matches material_receiving on lot + bar_size. Finishing passes the job's blank_dash. Unmarked stock works automatically — its bar_size is the length, so consuming unmarked stock for a dash-N job deducts the unmarked line.

### D-BLANK-INV-UI-01 — Blank inventory filters/sort/columns + kiosk lot narrowing
Date: 2026-06-25
Decision: The Blanks inventory table gained Type/Dash/Vendor filters + lot search, clickable header-sort (shared invSortKey/invSortDir with Bars), and Rec'd/Used/Available columns (data already on the availability rows) so deductions are verifiable; footer totals all three. The kiosk blank-lot picker now live-filters its on-hand list by the typed lot so the operator sees it narrow toward the match. Filter state: invBlankFilterType/Vendor/Dash + invBlankSearchLot (separate from the bars filters since blank material_type values differ).

### D-BLANK-CATALOG-03 — Merge Blank Catalog into Material Catalog
Date: 2026-06-25
Decision: The standalone Blank Catalog tab was merged into Material Catalog behind a Bars/Blanks toggle (catalogCategory, mirroring the Inventory invCategory switch). Both catalog blocks render under activeTab==='material_master', gated by the toggle; the separate blank_master nav item was removed. blank_master remains in the role/permission arrays so canSeeTab('blank_master') still gates the blank catalog's write actions. No content was relocated.

### D-BLANK-CONSUME-02 — Kiosk stub path uses the blank catalog
Date: 2026-06-25
Decision: The kiosk blank-lot picker's "not on hand" stub path now reads the blank_types catalog (loaded when the picker opens) instead of the legacy materialTypes (%blank%), which was empty after receiving moved to the catalog. The two dropdowns (Blank Type + Dash) were replaced by one catalog selector that sets material_type="<series> <material>", bar_size=stud_length, and blank_type_id; Confirm validates blank_type_id for stub lots. Closes the step-4 deferral of the legacy stub dropdown.

### D-BLANK-CATALOG-04 — Header-sort on both catalog tables
Date: 2026-06-25
Decision: Added clickable column header-sort to the Material Catalog (bars) and Blank Catalog tables, each with independent sort state (matCatSort / blankCatSort) and a shared cycleCatSort helper. Bars sorts Material Type/Bar Size/Density/Vendor; Blanks sorts Series/Material/Length/Alloy/Vendor (Length numeric-then-string).

### D-BLANK-CATALOG-02 — Blank catalog expansion (76 types) + blank_type_id FK
Date: 2026-06-25 (logged retroactively — decision dates alongside CATALOG-01)
Context: D-BLANK-CATALOG-01 created blank_types and seeded the rows derivable from the AJ Fasteners certs (39). The physical shelf holds more than the certs cover, and the catalog needed a foreign key on material_receiving so a blank receipt can point at its catalog row (the Phase 2 deferral noted in D-BLANK-CATALOG-01).
Decision:
- Catalog expanded from 39 to 76 types: +37 covering the rest of the shelf — the 2600-Stainless rows, the 2700 gaps (Steel and Stainless), and the unmarked 4000 stock (1", 1-1/2", 2") plus 4000-Steel dash gaps. alloy set per the rule Steel=4037 / Stainless=302, with the 4000-Stainless dash-13 exception = 303. Unmarked rows carry is_unmarked=true and an inch-length stud_length. Counts after load: 2600-SS 12, 2600-Steel 9, 2700-SS 12, 2700-Steel 10, 4000-SS 17, 4000-Steel 16 (= 76). Seed is idempotent (ON CONFLICT (stud_series, material_type, stud_length) DO NOTHING).
- material_receiving.blank_type_id — new column, uuid references blank_types(id), indexed. Links a blank receipt to its catalog row (alter table material_receiving add column if not exists blank_type_id ...). This is the FK that D-BLANK-RECEIVE-01 and D-BLANK-CONSUME-02 write and that the opening-inventory backfill (D-BLANK-INV-LOAD-01) populates.
SQL only (catalog seed + FK migration); no frontend.

### D-BLANK-INV-LOAD-01 — Opening blank inventory load + blank_type_id backfill (PROD cutover)
Date: 2026-06-26
Context: With the catalog (D-BLANK-CATALOG-01/02), the catalog-driven receive/consume paths (D-BLANK-RECEIVE-01, D-BLANK-CONSUME-01/02), and the inventory UI (D-BLANK-INV-UI-01) in place, the physical blank shelf was loaded as opening inventory so availability, consumption, and the cycle count run against real starting stock.
Decision:
- 91-row load into material_receiving, each row category='blank', from a hand-transcribed physical count (six count sheets read by eye — OCR was unreliable on the older AJ Fasteners scans). Every row stamped received_at='2026-06-25 12:00:00+00', vendor 'AJ Fasteners', rack 'Blank Rack'; received_by resolved via a CTE (select id from profiles where role='admin' order by created_at asc limit 1) so the script is environment-agnostic. material_type written as "<series> <material>", bar_size as the dash (or '1"'/'1-1/2"'/'2"' for unmarked stock, matching the catalog).
- Lot number REQUIRED on every row — un-lotted lines excluded (traceability). price_per_bar re-derived per row from a Fishbowl PO/unit-cost analysis (all 91 exact, no fallback). Totals: 91 rows, 1,626,449 pieces, $206,717.05.
- Step-6 backfill: linked blank_type_id on all 91 rows by split_part(material_type,' ',1)=stud_series AND split_part(material_type,' ',2)=material_type AND bar_size=stud_length; verify unlinked=0 (all linked). A '1.5"'→'1-1/2"' normalization precedes the link (no-op in prod).
- Cleanup if needed: delete from material_receiving where category='blank' and received_at='2026-06-25 12:00:00+00'.
Cutover lesson (migration discipline): the blank schema objects had been applied to TEST only — prod initially had just the blank_types table. Before the load + backfill could run, prod needed material_receiving.blank_type_id added, jobs.blank_dash added, and consume_blank_lot upgraded from the original lot-only signature to the lot+dash 6-arg version (p_dash text default null). Prod order: schema objects → frontend deploy → catalog (76) → inventory (91) → step-6 backfill. All four schema objects and the p_dash arg were verified present before loading. Mirrors the D-MAY28-01 lesson: a table/column/RPC must exist on a Supabase project before the code or load that depends on it runs there.

### D-WOLOOKUP-CANCELLED01 — Active WO Lookup excludes cancelled/closed WOs (2026-06-24)
**What:** The active WO Lookup (Mainframe fetchWOLookup) now filters out work_orders with status 'cancelled' or 'closed' via a lookupWOs pre-filter, before its job-status/recency branches feed activeWOs and completedWOs.
**Why:** The active lookup keyed visibility only off job statuses + created_at and ignored work_orders.status, so a cancelled WO whose jobs were all terminal and created within the last 7 days still appeared under Active (the "recently completed" branch) — e.g. WO-2606-0052 after cancellation, causing confusion. Cancelled/closed WOs belong in the Closed tab.
**Files:** src/pages/Mainframe.jsx.
SQL only (catalog_PROD.sql 76 rows, load_blanks_PROD.sql 91 rows, step-6 backfill); frontend was the separate v4.1 deploy. Blank subsystem fully live on prod June 26, 2026.

### D-BOM-ADDSEARCH01 — Search box on BOM Add Parts list (2026-06-24)
**What:** Added a search input to the "Add Parts" section of the Bill of Materials modal (Armory). New bomAddSearch state filters availableComponents (already excluding current BOM parts) by part_number + description, case-insensitive, with a clear (X) button. Empty-state distinguishes "No parts match your search" from "All available parts have been added"; search resets on modal open (openBOMModal).
**Why:** The available-parts list is long; the compliance officer had to scroll to find a part to add.
**Files:** src/pages/Armory.jsx.

### D-BOM-ADDPRODUCTS01 — BOM Add Parts includes products (assemblies/finished goods) + cycle guard (2026-06-24)
**What:** openBOMModal's availableComponents now includes all part types (assembly, finished_good, manufactured, purchased) minus the assembly itself, so a sub-assembly/product can be pulled into another assembly via the Add Parts search. Excludes any product whose own nested BOM already contains the target assembly — a client-side circular-reference guard (addToBOM has none), walking the tree via a partsById map. Add-list rows show an "Assembly"/"Product" badge for product types; search placeholder updated.
**Why:** The compliance officer needed to nest an assembly inside another assembly; the previous list (and the new search over it) excluded assemblies/finished goods entirely.
**Edge:** parts carry one-level assembly_bom each, so partsById lookups traverse the full tree for the cycle check. Including finished_goods makes the unfiltered list large; the search box narrows it.
**Files:** src/pages/Armory.jsx.

### D-KIOSK-LOADDATE01 — Short date on the kiosk Loads log (2026-06-30)
**What:** The kiosk Materials "Loads" list now shows a short date before the time (e.g. "6/30/26, 12:32 PM") via a new formatLoadStamp helper, instead of time only. formatTime is unchanged (still time-only for the setup/production/scheduled displays).
**Why:** Loads can span days; the time alone didn't show which day a load happened.
**Files:** src/pages/Kiosk.jsx.

---

## 2026-07-13 — Cert Repository (SKY64 + SKY67) Phase 1

New `/certs` page (Cert Repository) plus `src/lib/certRepository.js` query/write
layer. Additive only — new page + new lib + App.jsx route/nav entry. No changes
to Finishing, Kiosk, MaterialKiosk, or receiving flows. New schema
(`component_lots`, `component_lot_documents`, `work_order_component_lots`) was
deployed ahead of the code per the standing prod-touch discipline (a table must
exist before the code referencing it ships).

### D-CERT-01 — Component lot traceability tables
Component lot traceability implemented as `component_lots` /
`component_lot_documents` / `work_order_component_lots`. SK# lot numbers globally
unique (`component_lots.lot_number` UNIQUE). Lot documents live in S3 under
`component-lots/{lotId}` (reusing `uploadDocument` from s3.js); the S3 key is
stored in `component_lot_documents.file_path` (note: `file_path`, matching
`material_documents`, NOT the `file_url` used by job/part documents).

### D-CERT-02 — WO ↔ component lot association is MANUAL
WO ↔ component lot association is manual: compliance links lots in the Cert
Repository WO VIEW (per-purchased-component "Link Lot" picker + "Receive New Lot"
inline form). Formal allocation at assembly check-in is deferred. The purchased
component set is discovered from the WO's assemblies' `assembly_bom` rows
(part_type = 'purchased'); linked lots come from `work_order_component_lots` for
that WO.

### D-CERT-03 — Parent→child lot chains explicit via parent_lot_id
Parent→child lot chains are explicit via `component_lots.parent_lot_id` (e.g. raw
purchase lot → post-plating lot). `process_description` is captured only when a
parent lot is selected (it describes the parent→child transformation). Lot search
(`searchLot`) traverses the chain in BOTH directions (up via parent_lot_id, down
via children) with a cycle-guarded BFS, and renders the lineage as a strip
(e.g. 51849 → 51859). The universal search spans component_lots,
material_receiving, job_materials, material_loads, finishing_sends (all five lot
columns), outbound_sends.vendor_lot_number, and
work_order_assemblies.assembly_lot_number — exact match first, then ILIKE-partial,
using only `.eq()`/`.ilike()`/`.in()` filters (never `.not(...,'in',...)`).

### D-CERT-04 — Readable by all roles; writes admin+compliance
Cert Repository is readable by all authenticated roles (`canAccessCerts =
!!profile?.role` in App.jsx); write actions (create lot, link/unlink, upload/
remove docs) are gated to `hasRole(profile, 'admin', 'compliance')` inside the
page. Betty receives lots; Roger owns documentation completeness. Nav follows the
existing `currentPage` pattern (like Armory / Customer Orders), not a dedicated
react-router route.

### D-CERT-05 — Traceability table is the Phase 2 cert-package cover dataset
The WO VIEW traceability table (header block + one row per component: Part Number
| Description | Source | Material + Heat/Lot # | PLN | FLN | Vendor Process Lots |
Qty | Docs) is the Phase 2 cert-package cover-page dataset. The docs-complete
indicator (per purchased component: n/m linked lots documented, green check when
every linked lot has ≥1 document) is the future package-build gate. Manufactured
component rows read from jobs (component_id, machines.code, job_materials/
material_loads, finishing_sends, outbound_sends, and material cert docs via
material_usage → material_receiving → material_documents); the WO search includes
closed WOs (retroactive doc loading is a requirement).

---

## 2026-07-13 — Cert Repository Round 2 (cross-WO sourcing, component rollup, cert status)

Follow-up to the Phase 1 Cert Repository. Additive, confined to
`src/pages/CertRepository.jsx` and `src/lib/certRepository.js`. New table
`work_order_component_jobs` (work_order_id, job_id, UNIQUE pair, linked_by,
linked_at, notes; RLS all-auth read, admin/compliance write) deployed on TEST
ahead of the code.

### D-CERT-06 — Cross-WO component sourcing links the producing JOB, not copies
A component on one WO can be sourced from a job produced on a DIFFERENT work order
or stock run. This is modeled as a link to the producing **job**
(`work_order_component_jobs`), and the linked job's FULL live document chain
(job docs, material certs via material_usage→material_receiving→material_documents,
and outbound vendor certs) is inherited by reference — **no documents are copied**.
`findJobByLotNumber` (searches finishing_sends production/finishing lot,
job_materials.lot_number, material_loads.lot_number; .eq/.ilike/.in only) powers a
confirm-before-link picker; the "Link SkyNet Job" candidate list is filtered to
jobs whose `component_id` matches the target BOM component. Linked job sources
render with a "from WO-XXXX" badge and are unlinkable by the wcj row id.

### D-CERT-07 — component_lots now serves manufactured parts too (manual/legacy records)
The `component_lots` create/link path is no longer purchased-only. Manufactured
components expose a "Manual Lot Record" action (the same component_lots form,
labeled for pre-SkyNet / legacy production) alongside "Link SkyNet Job".
Purchased components keep their existing Link Lot / Receive New Lot behavior
unchanged. This lets legacy production (made before SkyNet, no job row) be
represented as a documented lot source.

### D-CERT-08 — Cert package status is computed client-side; ready = every component documented
`computeCertStatus(traceability)` derives readiness with **no stored status
column**. Per BOM component: `ready` = ≥1 source AND every attached lot has ≥1
document AND every job source has ≥1 document somewhere in its live chain;
`partial` = has a source but a documentation gap; `missing` = no source at all.
Overall `complete` iff every component is ready. The header shows a pill (green
"Cert Package Ready" / amber "Cert Package Incomplete — N of M components ready")
whose click-popover lists each non-ready component's specific gaps (e.g. "no lot
linked", "lot 51853 has no documents", "job J-000123 has no documents").
Per-component green/amber/red dots on the traceability and document rows agree with
the popover. Traceability + Documents both roll up to exactly one entry per BOM
component (assembly_bom order), with sources revealed on expand — a component with
multiple sources aggregates qty (sum of good qty) and docs (documented/total
sources). Assembly- and finished_good-typed BOM entries are excluded from the
rollup (structural products/sub-assemblies, tracked via work_order_assemblies /
assembly lots), so cert status reflects only real machined/purchased components.

### D-CERT-09 — Job source rows show PLN/FLN inline in the Documents section
Each expanded job source header in the Documents section renders the job's PLN and
FLN inline (muted, comma-separated, deduplicated, em dash for absent values) after
job #/machine/qty — for at-a-glance lot identification while browsing documents.
Reuses the existing per-source `pln`/`fln` arrays from the traceability payload
(no new queries); applies identically to native and linked jobs.

### D-CERT-10 — PLN/FLN on Documents job rows are color-coded with label de-duplication
PLN/FLN values on the Documents job source rows are color-coded (PLN cyan, FLN
emerald, font-medium) with the muted "PLN"/"FLN" label dropped when the stored
value already carries its own prefix (e.g. "FLN-100032"); dedupe/comma/em-dash
behavior unchanged.

### D-CERT-11 — Drop the PLN/FLN text labels entirely on Documents job rows (supersedes D-CERT-10)
No text labels on the Documents job source lot numbers — color alone distinguishes
production (cyan) vs finishing (emerald) lots. A missing value renders nothing (no
bare em dash). Multi-pair comma separation retained. Supersedes the D-CERT-10
labeling.

---

## 2026-07-15 — CS/Scheduling date unification + Salesperson "My Orders"

### D-DATE-01 — WO due date is derived, not entered, when CO allocations exist
work_orders.due_date remains the single field downstream consumers read, but
it is now populated as the earliest due_date across active allocated CO lines
at WO create/edit time. The manual date input appears only for stock-only WOs
(zero allocations). Rationale: eliminates the WO date as a second,
disagreeing source of truth while requiring zero changes to the ~15 downstream
readers (Schedule sort/overdue, kiosks, dashboards, traveler).

### D-DATE-02 — CO→WO due date sync is one-way, via resyncWODueDates()
Editing a CO line due date resyncs due_date on all linked WOs (active
allocations only). WOs never write back to CO lines. Stock-only WOs are
skipped by the resync so manual dates are never clobbered. Helper lives in
lib/woDueDate.js and is shared by EditCustomerOrderModal and
EditWorkOrderModal.

### D-DATE-03 — Late scheduling warns, never blocks
ScheduleJobModal (step 3) and the SKY55 Adjust End Date modal show an amber
warning and require a confirm when the scheduled/adjusted end falls after the
customer due date (compared against end-of-day, since due_date is a DATE).
Scheduling proceeds on confirm — the schedule is reality; the flag surfaces
the miss to CS via the My Orders Late badge rather than preventing the plan.

### D-MYORD-01 — My Orders tab: salesperson-scoped CO line view
New tab on Customer Orders, visible when profile.is_salesperson. One flat row
per open CO line where customer_orders.salesperson_id = logged-in user:
part number, qty fulfilled/ordered, customer due, linked WOs, job status
rollup, scheduled finish (MAX jobs.scheduled_end across linked WOs), and a
LATE badge when scheduled finish exceeds customer due. Ownership is
salesperson_id, not created_by. Client-side join in lib/myOrders.js; no
schema or RLS changes.

### D-MYORD-02 — My Orders uses a wider container than the rest of the page
The Customer Orders page container is max-w-7xl (1280px). My Orders carries
materially more columns than Orders or Demand, so the wrapper width is now
conditional on coTab: max-w-[1800px] for 'my_orders', max-w-7xl elsewhere.
Scoped deliberately rather than widening the page — Orders and Demand are
legible at 1280px and were not in scope. If a third wide tab ever appears,
promote this to a per-tab width map rather than extending the ternary.

### D-MYORD-03 — My Orders is 7 columns, nothing wraps
Cut from 11 columns: Priority became a colored dot on the CO# shown only when
priority != 'normal'; Status merged into the WO cell (status is derived from
those WOs' jobs — one fact, one cell); the Flag column was removed in favor of
a red left border on the row. Every cell is whitespace-nowrap; customer and
CO/PO truncate with a title tooltip. Part description is not rendered (part
number is what CS triages on). Scheduled finish is date-only — day granularity
is what matters against a date-only customer due date. Rows collapse from ~5
lines to 2, and the reclaimed vertical space goes to row padding.

### D-MYORD-04 — Late is quantified, not just flagged
The LATE badge reads "{N}d late" rather than a bare flag. The due-vs-finish
delta is already computed for isLate, so surfacing the magnitude is free and
lets a rep triage a 2-day miss differently from a 60-day one. Computed in the
component from dueDate/scheduledFinish; the loader's isLate contract is
unchanged.

### D-NAV-01 — Cross-page navigation carries a payload; state setters can't
App.jsx passed onNavigate={setCurrentPage} to CustomerOrders. A React state
setter accepts one argument, so the second argument in
onNavigate('mainframe', { woLookupSearch, orderLookupTab }) was silently
discarded — WO deep links landed on Mainframe with no context and threw no
error. Navigation now goes through handleNavigate(page, payload) in App.jsx,
which sets currentPage and navPayload together. Mainframe accepts navPayload
and calls onNavPayloadConsumed after acting on it, so the payload is
consume-once and a stale deep link can't re-fire on a later remount. Schedule
keeps the raw setter — it only ever navigates with a single argument. Rule
going forward: any onNavigate that carries a payload must be a real function,
never a bare setState.

### D-MYORD-05 — My Orders CO number deep-links to the Orders tab, not the edit modal
Clicking a CO number in My Orders switches to the Orders tab, sets the search to
that CO number, resets the status and salesperson filters to 'all', and expands
the CO row. It deliberately does NOT open EditCustomerOrderModal: the actions CS
needs from this link — Cancel CO and mark-line-complete — live on the Orders tab
row and its expanded line panel, not in the edit modal. Filters are reset because
a stale status/salesperson filter would otherwise hide the CO the rep just asked
for. loadMyOrderLines() now also returns coId (expanded is keyed by co.id);
no other change to the loader.

### D-CERT-12 — Material cert docs keyed by distinct material_receiving lots per job, not per usage event; duplicate join rows deduped by document id.

---

## 2026-07-15 — Cert Repository Phase 2 (Build Cert Package)

New `src/lib/certPackage.js` (data + generation) and `src/lib/certPackagePdf.js`
(pdf-lib cover + document merge), plus Build/Sign/log UI in `CertRepository.jsx`.
Additive; new schema (`part_cert_profiles`, `cert_signatures`, `cert_packages`)
deployed ahead of the code. Added `pdf-lib` and `xlsx` (SheetJS) dependencies —
SheetJS was not previously present and is required for spreadsheet re-rendering.

### D-CERTPKG-01 — Cert packages are per JOB (one FLN per job)
A cert package certifies one job's output. Package number = `${FLN}-CP${n}` where
n = (# existing packages for that job) + 1. The Build modal's "All Jobs" option
fans out one draft package per job on the WO (native + linked). The job picker
warns — never blocks — when the selected job's component isn't fully documented.

### D-CERTPKG-02 — Cover-page data is a three-way split
Cover fields come from three sources: **auto** (live from
`getWorkOrderTraceability` — customer/PO/part/lots/qty), **part_cert_profiles**
(static per-part data reused across every package for that part — TSO/RoHS/
conflict-minerals/NADCAP/primer/country/component_origins), and **form_data**
(per-package entry — Lot Assembly Test block, QC Release block, qty shipped,
emailed-to, material-lot overrides). Editing the Part Profile in the draft form
saves to `part_cert_profiles` and applies to all future packages for that part.

### D-CERTPKG-03 — The PDF bears only the APPROVER'S own stored signature
`cert_signatures` is per-user (RLS: write own row only). At Approve & Sign the
current user's stored signature + stamp + title are applied — builders and signers
may differ. Approval is blocked with a clear message (prompt-link to My Signature)
when the approver has no stored signature. The signature is applied under the
approver's login, not copied from the builder.

### D-CERTPKG-04 — Approved packages are immutable; regeneration = new row
A DB trigger makes approved `cert_packages` rows immutable; the app never updates
or deletes them (soft-guarded to `status='draft'` on updates, and any trigger
error is surfaced gracefully). Approve & Sign generates the PDF and uploads it to
S3 **before** flipping the row to approved (the row is approved only once the file
exists). "Regenerate" on an approved package starts a NEW draft prefilled from the
old snapshot/form_data — it never mutates the approved row. `cert_packages` is the
permanent package log, shown newest-first below Documents.

### D-CERTPKG-05 — Non-PDF handling in the merged package
Merge order follows traceability (cover, then per component in BOM order: job docs
→ material certs → outbound certs → lot docs). PDFs are page-copied; JPG/PNG are
embedded one image per page (scaled to fit letter with margin); XLS/XLSX are parsed
with SheetJS and re-rendered as text tables (data fidelity, not visual fidelity);
anything else is skipped, recorded in `conversion_manifest`, and listed on a final
"Separate Attachments" page. Source files are fetched via the existing s3.js
signed-URL helper.

### D-CERTPKG-06 — QMS-10.4 cover text is controlled text (RESOLVED)
The four Certificate of Conformance paragraphs and the DFARs line in
`certPackagePdf.js` (CERT_PARAGRAPHS) were transcribed from the controlled
QMS-10.4 Rev 003 form, superseding the placeholder language this entry
originally flagged. Treat them as controlled text: re-verify on any revision
bump, and change them only to match the form.

Profile column types settled with the deployed schema (`PROFILE_BOOLEAN_FIELDS`
/ `PROFILE_TEXT_FIELDS` in `certPackage.js` are the single source of truth — the
draft form, the save path, and the cover renderer all read from them):
- **TEXT:** `tso_c148` (holds 'NA' or a TSO designation — a text input, not a
  toggle), `camloc_equivalent`, `monadnock_equivalent`, `primer`,
  `assy_country_of_origin`, `notes`
- **BOOLEAN:** `conflict_minerals`, `rohs_compliant`, `dfars_compliant`,
  `nadcap_plating`, `nadcap_heat_treat`

Booleans render Yes/No on the cover (DFARs renders YES/NO). `nadcap_plating` /
`nadcap_heat_treat` moved TEXT → BOOLEAN with the deployed schema; the cover
renderer was still printing them via the free-text path (literal "true"/"false")
and was corrected on 2026-07-16.

---

## 2026-07-16 — Working repo migrated from Google Drive to local SSD

### D-ENV-01 — The working repo lives on a local SSD, not Google Drive
- **Decision:** The working clone moved off the Google Drive-backed folder to a
  local SSD path. This closes the long-standing Drive instability risk tracked
  since Sprint 4 (see "Phantom git diff state on Google Drive folders" and the
  Sprint 8 note "The Google Drive repo location remains a latent risk").
- **What it fixes:** Drive's sync layer was corrupting git lock files and
  producing phantom "modified" files with no content drift. Worse, `npm install`
  never survived a session — Drive's file watcher churned `node_modules` (tens of
  thousands of small files) so builds could not be verified locally at all. The
  Cert Package Phase 2 work was written entirely without a single successful
  build as a result.
- **Confirmed by this session:** on local SSD, a clean `npm install` finished in
  ~1 minute and `vite build` in ~14s — the first green build of the Phase 2 code.
- **Unaffected:** GitHub remains the source of truth; Amplify CI/CD builds from
  GitHub and never saw the Drive path, so deployment is unchanged. The migration
  is local-workstation-only — no schema, code, or pipeline impact.

**Lesson:** an environment that can't run a build isn't a slow environment, it's
an unverified one. Code written against it should be treated as unreviewed until
it compiles somewhere real. The Phase 2 work proved the point: it imported
`pdf-lib` and `xlsx`, but neither was ever added to `package.json` — the code
could not have built for anyone. Both were added here (`pdf-lib` ^1.17.1,
`xlsx` ^0.18.5) and the build went green.

D-MACH-01 (2026-07-27) — Bolt Master 6 commissioned. machines.is_commissioned and
kiosk_enabled flipped to true on PROD; row matches BM-1..5 on machine_type,
location, and code/name conventions (code prefix BM drives Kiosk.jsx isBoltMaster;
name prefix "Bolt Master" drives Schedule brand grouping and MaterialKiosk
exclusion). No code change or deploy required — §5.3 lifecycle flag flip.
part_machine_durations backfill [pending / applied].

---

### D-SHORT-06 — Plan-only shortfall cards get Resolve; MTO never plan-only (2026-07-28)
**What:** Added Resolve (AllocationResolutionModal) to Stock Build Variance cards; isDemandRow now treats order_type='make_to_order' WOs as demand regardless of CO remaining; accordion auto-expands when non-empty; modal requeue path guarded for zero-allocation WOs.
**Why:** WO-2605-0014 (MTO, assembly rejections) had its QL8C62-1 shortfall classified plan-only because all CO lines read fulfilled, hiding it in a collapsed section with Acknowledge as the only action — Re-queue was unreachable and had to be done in SQL.
**Files:** src/components/WOLookupShortfalls.jsx, src/components/AllocationResolutionModal.jsx (if guards needed).

### D-COFUL-01 — Manual CO line fulfillment adjustment (2026-07-28)
**What:** adjust_co_line_fulfillment RPC + co_fulfillment_adjustments append-only event table; pencil control on WO Lookup CO Fulfillment and Customer Orders lines (admin/scheduler, reason required, bounds 0..ordered); line and parent CO status flip both directions; auto-fulfill unaffected (computes from live counters; idempotency via co_fulfillment_applied_at).
**Why:** Assembly rejections on WO-2605-0014 occurred after fulfillment was recorded; every line read Satisfied with no UI path to reopen demand until the Shipping module exists. Adjustments are audited events, not silent edits, so Shipping can reconcile later.

### D-NOTIF-01 — Generic user_notifications primitive + header bell (2026-07-28)
**What:** user_notifications table (recipient-scoped RLS) + NotificationsBell in the app header with realtime unread badge; first producer is the fulfillment-adjust RPC notifying the CO salesperson; payload deep-links My Orders.
**Why:** No general notification mechanism existed (Messages bell is schedule_change_requests, scheduler-scoped). Built as the durable primitive future modules (Shipping) will reuse.

### D-JOB-14 — Editable quantity on unscheduled jobs (2026-07-28)
**What:** Quantity pencil on WO Lookup job rows for pre-schedule, unassigned, non-maintenance jobs (admin/scheduler); audit-logged 'job_quantity_edited'.
**Why:** RQ-53613719 was created with the recorded shortfall (630) but post-rejection demand was higher; only path to correct was SQL.

### D-RMF-01 — Raw Material Forecast (Armory) (2026-07-28)
**What:** Five read RPCs (forecast_rm_bars/_bar_parts/_blank_demand/_blank_onhand/_rm_exceptions) power a Forecast section in Armory Raw Materials: weekly bar runout with on-hand and cumulative shortfall, blank demand vs on-hand by series/dash, part-level drill-down, and a Needs-Data exceptions panel that upserts part_dimensions inline. Estimator waterfall: empirical pieces-per-bar (self-upgrading as jobs complete) -> geometric from drawing length with fitted constants (kerf+facing 0.149", remnant 0.42", calibrated 2026-07-28 against four dual-source parts, all within ±2%) -> exception. bars_needed=0 on in-progress jobs means fully staged.
**Why:** No part->material/pieces-per-bar master data existed; forecast built from production history plus catalog/drawing lengths (part_dimensions, sources: catalog seed, manual, future ai_extracted) without a data-entry project. Purchasing signal validated in SQL (A v3) before UI: 303SS 0.500" and 6061 1.000" runouts surfaced immediately.
**Files:** src/pages/Armory.jsx, src/components/rmforecast/*.

**Implementation notes (UI side):**
- **Placement — its own tab, not a toggle inside Reconciliation.** Raw Materials is a *tab group* (D-RMNAV-01) and `scheduler` held no raw-materials tabs at all (`['customers']`). Nesting the forecast under Reconciliation would have required granting schedulers the reconciliation UI to reach it. Instead `rmforecast` ("RM Forecast") is a new member of the Raw Materials dropdown sitting beside Reconciliation, added to `TAB_ACCESS_BY_ROLE` for admin / scheduler / purchaser only. `'customers'` stays first in the scheduler array so their default Armory tab is unchanged.
- **Two gates, deliberately different.** View = admin/scheduler/purchaser (mirrors the RPC role gate; `RMForecastSection` also returns null defensively). Exception **Save** = admin/scheduler only, matching `part_dimensions` INSERT/UPDATE RLS — purchaser sees the panel with values read-only and an amber "Missing" marker in place of each editor, never a disabled control it can't use.
- **Select values are format-inferred from part_dimensions, not assumed.** The material / bar-size editors offer the `material_types` and `bar_sizes` catalogs, but the string actually stored is the one already present in `part_dimensions` for the same material name (case-insensitive) or the same numeric size — catalog text is only the fallback when nothing comparable exists. Without this the editor could write `0.500 dia` into a table grouping on `0.500"` (or vice versa), producing a phantom second group instead of migrating the part into an existing one. Same query supplies editor prefill; if the SELECT is ever blocked it degrades to no prefill and catalog strings rather than failing.
- **Upsert writes only what it knows.** One row at a time, `onConflict: 'part_number'`, carrying `source_file 'manual'`, `family 'component'`, `updated_at now()`, the newly entered missing fields, and any prefilled existing values. Fields with no known value are omitted so a PostgREST update can't null out a column it wasn't given. Save awaits a full five-RPC reload, so the part leaves the panel and appears in the bar table in one motion.
- **Refresh is manual and non-blanking.** No realtime (purchasing cadence, not transactional). The Refresh button and the post-save reload run "silent" — tables stay on screen while data swaps, so the exception→table migration is actually visible instead of flashing through a spinner.
- **Unscheduled sorts last everywhere** (`weekSortKey` returns `'9999-99-99'`), and a group whose first negative bucket is the unscheduled one reads "Short on unscheduled work" rather than "Short starting Unscheduled". Week labels parse `YYYY-MM-DD` via local date parts, never `new Date('YYYY-MM-DD')` (the local-noon-UTC rule).
- **Groups that run short open expanded**; the rest start collapsed. Expansion state lives in the table component so a refresh doesn't collapse what the user opened.
- **Blank net indicator is series+dash only.** Material (Steel vs Stainless) is not inferable from the part suffix/description, so demand is summed per (series, dash) via the prefix map {SK26:2600, SK27:2700, SK4C:4000, SK40:4000, ZG40:4000} and rendered as a "Needed N" chip on every on-hand row whose `stud_length` matches the dash — i.e. on both material rows of that length, with a footnote saying so. The chip tints red when that single row's `pieces_on_hand` is below the combined need. Demand with a NULL `blank_dash` or no prefix match drops to an "Unmapped demand" table at the bottom of the section with the reason stated per row.
- **Untouched:** the RPCs, the reconciliation UI, and all receiving flows. `npm run build` green.

### D-RMF-03 — Machine assignments on forecast drill-downs (2026-07-28)
**What:** forecast_rm_bar_parts and forecast_blank_demand return a machines
column (STRING_AGG DISTINCT of assigned machine names per part/week bucket,
"Unassigned" for pre-schedule jobs; functions dropped/recreated since return
signatures changed, grants re-applied). Rendered as a Machines column in both
drill-down tables.
**Why:** Purchasing/scheduling wanted to see where forecast demand lands on
the floor; parts can split across machines within a week.
**Files:** src/components/rmforecast/*.

**Implementation notes (UI side):** One shared `MachinesCell` component backs both
tables so the token treatment can't drift. It splits the string on commas and mutes
any `Unassigned` token (gray-500) against normal machine names (gray-300), so a row
that is partly unplanned reads at a glance without a second column. The cell is a
`block truncate max-w-[14rem]` with `title` carrying the full list, keeping both
drill-downs at their existing width when a bucket spans several machines. An empty
or null `machines` value renders an em dash rather than an empty cell. The unmapped-
demand table is deliberately left alone — it exists to explain a mapping failure, not
to plan floor work.

### D-BLANK-07 — Finishing sends inherit blank lot as material lot (2026-07-29)
**What:** Kiosk finishing-send creation (partial and final-batch paths) falls
back to jobs.blank_lot_number when no job_materials row exists, so Bolt Master
sends carry a material_lot_number. Historical NULL sends on blank jobs
backfilled from their jobs' blank_lot_number via SQL on 2026-07-29.
**Why:** Blanks jobs write no job_materials row; compliance post-mfg and Cert
Repository read finishing_sends.material_lot_number and showed "—" for every
BM job since the blank subsystem went live (Jun 26).
**Files:** src/pages/Kiosk.jsx.

### D-RMF-04 — Human material/size correction on RM Forecast (2026-07-30)
**What:** part_dimensions gains material_locked / correction_note / corrected_by
/ corrected_at (extraction_meta / confirmed_by / confirmed_at staged alongside
for D-RMF-05). Shared PartDimensionEditor serves the Needs-data panel and a new
"Correct material" action on forecast part drill-down rows; a locked correction
outranks any inferred or AI value in bucketing. Saves audit-log
'rm_material_corrected' with from/to. Lock badge with corrector/when/note
tooltip. Admin/scheduler write, purchaser read-only.
**Why:** Drawings carry wrong material callouts and ambiguous bar diameters
only the machinist can settle — SK247P forecast against 0.125 dia bar (a
phantom shortage group telling purchasing to buy 1/8" 303) when it is turned
from 0.375 dia. Corrections belong where the error is seen.
**Files:** src/components/rmforecast/PartDimensionEditor.jsx,
src/components/rmforecast/usePartDimensionEditor.js,
src/components/rmforecast/* (RMForecastSection, ExceptionsPanel,
BarForecastTable), part_dimensions migration,
Docs/migrations/2026-07-30_rmf_material_lock_precedence.sql (forecast RPCs —
precedence WAS amended; see below).

**Implementation notes:**
- **The RPCs did not source material/bar_size from part_dimensions, so Task 2
  was required.** Discovery of the deployed `forecast_rm_bars()` /
  `forecast_rm_bar_parts()` bodies showed a two-branch waterfall, not a
  part_dimensions read: `emp_profile` takes material_type/bar_size from the most
  recent `job_materials` row (`DISTINCT ON (component_id) ORDER BY last_run
  DESC`) and wins outright; `geo_profile` reads part_dimensions **only** where
  `NOT EXISTS` an emp_profile row. A correction written to part_dimensions was
  therefore invisible to bucketing for any part that had ever run. The migration
  amends `emp_profile` in both functions to
  `COALESCE(lk.material_type, h.mt)` / `COALESCE(lk.bar_size, h.bs)` against a
  `LEFT JOIN part_dimensions lk ON lk.part_number = p.part_number AND
  lk.material_locked = true`. Everything else is byte-identical, return
  signatures unchanged, so `CREATE OR REPLACE` carried the D-RMF-01 grants
  forward untouched (verified: `{postgres,authenticated,service_role}` before
  and after, no PUBLIC/anon). With zero locked rows the five-RPC output diffed
  identical before/after — the amendment is inert until someone corrects a part.
- **The lock settles the bar, not the yield.** COALESCE overrides only
  material/bar_size; the empirical pieces-per-bar and the `'empirical'` basis
  survive, because a lock is a statement about which bar the part is turned
  from, not about how many pieces come off one. Confirmed on TEST: SK203C22B
  (7 jobs of 0.875 dia history, no part_dimensions row) corrected to 0.375 dia
  moved buckets with `bars_needed` unchanged at 6 and basis still Actuals. The
  0.875 dia card disappeared entirely (it held only that part); the 0.375 group
  went cum 191 -> 197, on hand 126 unchanged, worst remaining -65 -> -71.
- **Phase 1's Needs-data save was broken and is fixed here.** `ExceptionsPanel`
  and `RMForecastSection` both used a column named `material`; the actual column
  is `material_type`. The `part_dimensions` SELECT therefore always errored and
  fell to its documented `setDimRows([])` degradation (so store-what-exists
  silently ran on catalog strings and prefill never populated), and the upsert
  payload would have been rejected by PostgREST as an unknown column. Both are
  corrected to `material_type`; the select also now pulls source_file and the
  four lock columns.
- **Store-what-exists is now enforced on the way in, not just in the option
  list.** `matchMaterialOption` / `matchBarSizeOption` snap any incoming value —
  an RPC prefill, a job-history string, an AI suggestion — onto the string
  part_dimensions already uses (case-insensitive for material, numeric for size)
  before it can reach a save. The selects additionally inject the current value
  as an option when it came from job history and has never been stored, so a
  correction modal can render `0.875 dia` even though no part_dimensions row
  uses that string.
- **One hook, two layouts.** The exceptions panel needs its fields as cells of
  an existing table; the correction path needs a stacked modal. Rather than fork
  the logic, `usePartDimensionEditor.js` owns all state, validation, the upsert
  shape and the audit write, and `PartDimensionEditor.jsx` exports the controls
  individually plus the stacked form. Splitting the hook out of the `.jsx` is
  what keeps `react-refresh/only-export-components` clean.
- **The upsert still writes only what it knows** (D-RMF-01): fields with no
  value are omitted so PostgREST cannot null a column it wasn't given. Correction
  mode sets `source_file = 'manual'` **only** when the row has none, so a catalog
  provenance is never overwritten by a size correction.
- **Lock-badge context is fetched only for locked parts**, as three flat queries
  joined in JS (parts -> jobs -> job_materials) rather than a nested select, per
  the two-level PostgREST nesting limit. The modal bar_size from history is
  compared to the locked value and shown as informational
  "history: 0.875 dia (7 jobs)" when they disagree. A failure here is swallowed —
  a badge detail must never fail the whole forecast load.

### D-RMF-05 — AI dimension extraction from job drawings (suggest-only) (2026-07-30)
**What:** Edge Function extract-part-dimensions (JWT + admin/scheduler gated,
Anthropic API, strict-JSON envelope with dim_reference/confidence/ambiguities)
fed by client-side S3 signed-URL fetch of the drawing Roger uploads to the
part's job (jobs.component_id -> job_documents drawing type, resolution order
per discovery). Pre-fills the Needs-data editors; human confirm required;
saves carry source_file 'drawing_ai', extraction_meta (suggested vs saved),
confirmed_by/at, audit 'dimension_ai_confirmed'. Function writes nothing;
no AWS credentials in Supabase — the browser resolves the signed URL.
**Why:** The drawing already exists on the job at WO creation; deriving bar
size and material from it removes the data-entry step while keeping a named
human on every committed value (AS9100). Golden case: SK26CP5.
**Files:** supabase/functions/extract-part-dimensions/index.ts,
src/lib/dimensionExtraction.js, src/components/rmforecast/*.

**Implementation notes:**
- **Drawings live on `job_documents`, not `part_documents` or snapshots.** TEST
  holds 85 approved drawing-type `job_documents` rows and **zero**
  `job_document_snapshots` of any type; every part currently in the Needs-data
  list has at least two job drawings reachable via `jobs.component_id`.
  Resolution order shipped: drawing-type `job_documents` for any job on the
  part, approved beating non-approved and newest beating older, then
  `job_document_snapshots` as a fallback that is checked rather than assumed
  empty. `document_types` is looked up by `name ILIKE '%drawing%'` and cached
  per session — the drawing type id differs between TEST and PROD.
- **`file_url` is a bare S3 key** (`jobs/<job_id>/<epoch>_<name>.pdf`), resolved
  through the existing `lib/s3.getDocumentUrl` presigner. The browser already
  holds the bucket credentials, so it fetches the bytes and base64s them; the
  function accepts `document_base64` and never touches S3 or Supabase Storage.
  That is the whole reason no AWS credentials had to be added to Supabase.
- **The lookup is batched at the panel, not per row.** One pass resolves every
  exception part (four queries total) so each row knows up front whether to
  enable Extract or show the disabled "No drawing found on this part's jobs."
  tooltip — a per-row lookup would have been four queries times sixteen rows.
- **The catalogs are the model's vocabulary.** The function fetches
  `material_types.name[]` and `bar_sizes.size[]` service-side and interpolates
  them into the §4 prompt; a returned value outside either list is moved to
  `material_unlisted` / `bar_size_unlisted` and nulled, and the client renders it
  as an amber warning without pre-selecting it. Combined with the
  store-what-exists snapping above, an extraction cannot mint a phantom group.
- **Rejects before it spends.** Non-PDF magic bytes (base64 `JVBERi0`) and
  payloads over 10 MB decoded are refused before the Anthropic call; the caller's
  JWT is verified via service-role `auth.getUser` and `profiles.role` must be
  admin or scheduler, mirroring the part_dimensions write RLS. `usage` is logged
  to the function console; nothing is written to the database.
- **`source_file = 'drawing_ai'` only when an AI value actually survived.** The
  save compares each saved value against its suggestion; if the human cleared all
  three and typed their own, it saves as plain `'manual'` with no
  extraction_meta and no audit row, exactly as a hand-entered row would.
  `edited` in the audit details is true whenever fewer than three of the
  suggested values came through unchanged.
- **Model is `claude-sonnet-4-6`** with `max_tokens` 1500 and the PDF as a
  base64 `document` content block (no beta header needed). Structured outputs
  are not offered on Sonnet 4.6, hence the strict-JSON-by-prompt approach plus
  defensive fence-stripping on parse.

### D-CERTPKG-07 — Assembly lot is a package entry until the assembly module lands (2026-07-30)
**What:** "Assembly Lot Number" is a field in the draft package's *This Package*
group, stored in `form_data.assembly_lot_number`, and the cover page's
"Assembly Lot Number (s)" block reads it (falling back to the live
`work_order_assemblies.assembly_lot_number` values). The field is prefilled from
`work_order_assemblies` for the package's `work_order_id` when a lot is already
stamped there.
**Why:** The assembly module is not live, so nothing writes the ALN today and
compliance has to type it. Wiring the prefill now means the takeover is
automatic — when the module starts stamping `assembly_lot_number`, the field
populates on its own and manual entry becomes the override. No code change is
scheduled for that cutover; a comment at the field records the intent.
**Files:** src/lib/certPackage.js, src/pages/CertRepository.jsx,
src/lib/certPackagePdf.js.

### D-CERTPKG-08 — Package form errors live below the action buttons (2026-07-30)
**What:** Every error on the draft form — signature-missing, validation, S3
upload, DB trigger — renders in one block directly beneath Save Draft /
Approve & Sign, with `scrollIntoView({ block: 'nearest' })` when it is set. The
top-of-form error banner is gone (the success notice stays at the top).
**Why:** The form is long enough that a failure at the bottom scrolled its own
explanation off screen — beta users pressed Approve, saw nothing happen, and
pressed again. The error belongs where the user's eyes already are.

### D-CERTPKG-09 — Heat numbers pair with material lots; write-back only fills NULLs (2026-07-30)
**What:** MATERIAL LOT OVERRIDES is now paired **Lot #** / **Heat #** inputs per
manufactured component (purchased components keep the single lot field — they
have no raw-material receipt). Both persist in `form_data`
(`material_lot_overrides`, `heat_number_overrides`). Heat # prefills from
`material_receiving.heat_number`. On Save Draft and on Approve, an entered heat
number is written back to `material_receiving` **only** when the component
resolves to exactly one receiving row *and* that row's `heat_number` is NULL;
the UPDATE additionally carries `.is('heat_number', null)` as a race guard. An
existing value is never overwritten, and an ambiguous/absent receiving row or an
RLS refusal is skipped silently (logged, never surfaced, never blocks the save).
The cover component table prints `lot / heat` when a heat is present and the lot
alone otherwise, matching the paper QMS-10.4 format.
**Why:** `material_receiving.heat_number` (deployed ahead of this work) is empty
for historical receipts, and the person who knows the heat number is the one
building the cert package. Capturing it there backfills the receiving record as
a side effect of work that was happening anyway. Resolution is by receiving ID
walked through the traceability chain (component → job sources → material_usage
→ material_receiving), never by matching lot-number strings, so a shared lot
label cannot write a heat onto the wrong receipt.
**Files:** src/lib/certPackage.js, src/pages/CertRepository.jsx,
src/lib/certPackagePdf.js.

### D-CERTPKG-10 — Blank production logs are excluded by default, not banned (2026-07-30)
**What:** `EXCLUDED_DOC_TYPE_CODES = ['production_log_blank']` in
`certPackage.js`. Documents of an excluded type default to UNCHECKED in the
Arrange Documents step but stay visible and re-checkable, and the choice
persists per package in `form_data`. Type resolution is by
`document_types.code` with a name match as a second net, so an environment whose
code drifted still excludes the right type.
**Why:** The blank log is a shop-floor artifact; the filled copy is what belongs
in a customer package. But "never" is too strong — some packages have
historically included it, so compliance keeps the per-package override rather
than having to work around a document the system refuses to merge.

### D-CERTPKG-11 — Package document order is compliance-arranged and persisted (2026-07-30)
**What:** The draft form gains an **Arrange Documents** section: an ordered list
of groups — Cover Page (fixed first, not movable, not excludable), Job Traveler
(always included, position movable, defaults to 2nd), then one group per
component in BOM order — with an include/exclude checkbox per document and
up/down move controls at both the group and document level. Order + inclusion
live in `form_data.doc_arrangement` (`{ groupOrder, itemOrder, inclusion }`,
keyed by a stable per-document `item_id`); `approveAndGenerate` flattens exactly
that arrangement into the merge list `certPackagePdf` consumes, and Regenerate
prefills the prior arrangement from the old snapshot. Groups rebuild from the
LIVE merge list on every load, so a document uploaded since the draft was saved
appears automatically (appended in traceability order, taking its type default).
**Why:** Traceability order is a sensible default but not a rule — customers and
auditors expect specific packet layouts, and compliance was previously stuck
with whatever order the walk produced. No drag-and-drop dependency was added;
move buttons cover the need at a fraction of the weight.

### D-CERTPKG-12 — The traveler in the package is generated, not captured (2026-07-30)
**What:** `certPackagePdf.renderTravelerPages()` draws Form 10-100 traveler
page(s) straight into the package PDF from live SkyNet data — Skybolt header,
part number/name, final process, manufacturing # (PLN), heat/lot #, material,
drawing rev, TSO rev, the process/operations table (step, station/vendor, new
lot, qty, date, operator initials) built from job routing steps +
`finishing_sends` + `outbound_sends`, a notes box, and a `Form 10-100` +
generation-date footer. It is always in the package and cannot be excluded. The
dataset is frozen into the approval snapshot alongside everything else, so an
approved PDF and its snapshot still agree years later even as the job's live
data moves on.
**Why:** Screenshotting or rasterizing the React print page would put an
un-searchable, resolution-bound image into a controlled quality record. Drawing
from the data keeps the traveler as real PDF text and lets the snapshot carry
the exact values that were printed.
**Implementation note — one derivation, two renderers.** The lot / qty / date /
operator precedence in the traveler (machine step carries the PLN, every
internal step after it carries the FLN, per-batch vendor lot beats
`step.lot_number`, and so on) is compliance-critical and was previously welded
into `buildTravelerHTML`'s string emission. It is now
`buildTravelerModel(travelerData)` in `src/lib/traveler.js`, returning plain row
objects; `buildTravelerHTML` renders that model to HTML for the four popup
surfaces and `renderTravelerPages` renders the same model to PDF. Duplicating
the precedence into the cert-package layer was the alternative and was rejected
— two copies of that logic drift, and a drifted traveler is a mis-stated lot
number on a shipped certificate. `fetchTravelerData(supabase, jobId)` was added
alongside it so a non-interactive consumer can assemble the dataset; the four
existing call sites still inline their own identical query block and were left
untouched. `buildPackageDataset` takes `{ includeTraveler }` — off for the draft
form and the "All Jobs" fan-out (four extra queries per job, nothing displays
it), on at approval, the only moment the dataset must be complete enough to
freeze.

### D-UI-MODAL01 — Backdrop click never closes a modal (2026-07-30)
**What:** Click-to-close was removed from every modal backdrop in the app:
Schedule (job detail, end-date edit, unschedule confirm, close-maintenance),
Mainframe (edit job, manual batch, WO-lookup cancel), Finishing (new job),
Assembly (send batch), CertRepository (My Signature, Build Package, Draft Form),
CreateMaintenanceModal (main + crash), CreateWorkOrderModal, EditWorkOrderModal,
PrintPackageModal, RoutingTemplatesTab, ScheduleJobModal, and
rmforecast/PartDimensionEditor. X / Cancel / Close controls and existing
Escape-key handlers are untouched; no other modal behavior changed. The
dropdown-menu scrim in `Armory.jsx` (`fixed inset-0 z-40` closing an open menu)
is deliberately kept — it is a menu click-away, not a modal backdrop.
**Why:** Beta users lost long forms to a stray click outside — the cert package
draft form and Create WO in particular. A modal that holds typed work should
only close on an explicit gesture; the cost of one extra click is far below the
cost of silently discarded entry.

### D-CERTPKG-13 — Save Draft and Approve persist the Part Profile too (2026-07-30)
Save Draft and Approve & Sign persist the Part Profile section along with
`form_data` in a single action (the separate Save Profile button stays for
profile-only saves); the profile upsert is keyed on `part_id`
(`onConflict: 'part_id'`, stamping `updated_by`/`updated_at`) and any error is
surfaced in the error block below the buttons instead of being swallowed — a
profile write failure now aborts approval rather than certifying stale cover
data.

### D-KSTC-01 — Kit & STC Registry: installation-centric binding (2026-08-02)
New module tracking serialized kit lots, aircraft, and STC paperwork. The binding lot↔aircraft is its own record (kit_installations) with a NULLABLE lot reference — installs can be evidenced (e.g., Form 337) without a recoverable lot, and recall/fleet queries resolve through installations so those cases are never silently dropped. "STC issued" is derived from stc_issuances via installations, never a maintained column. Schema in Docs/migrations/2026-08-01_kit_stc_registry_schema.sql; applied to TEST 2026-08-01, loaded from workbook v5_3 on 2026-08-02 (648 lots, 4,420 BOM lines, 477 SKUs, 71 requests, 70 aircraft, 2 verified installations).

### D-KSTC-02 — Lot identity and numbering source of truth (2026-08-02)
kit_lots unique on (book_id, lot_number); four books seeded with observed ranges. Ranges are disjoint today so bare-number search is unambiguous; the composite key protects against a future book restarting a sequence. Paper books remain the numbering source of truth during dual-run; kit_lots.source distinguishes paper_transcription from skynet rows; entry pre-fill is GREATEST(known max, book.last_lot)+1 and explicitly subordinate to the paper book. SkyNet-assigned numbering is a later mode flip, not a schema change.

### D-KSTC-03 — Registry masters kept separate from MES masters (2026-08-02)
kit_parties is separate from customers (numeric Fishbowl-ID check would reject installers/foreign distributors; avoids entangling CO-module data; fishbowl_customer_number optional). kit_skus/kit_components are separate from parts; kit_components.part_id optionally links to public.parts (163 matched at load) so component recalls can walk into MES lot traceability. Fishbowl stays export-based (kit_sales/kit_sale_lines/fishbowl_invoices mirrors) consistent with deferred import #31 and the QBO cutover freeze.

### D-KSTC-04 — STC applicability at SKU level, undetermined until ruled (2026-08-02)
stc_applicability lives on kit_skus (default 'undetermined'), not on books — options-book rows containing conversion parts (and vice versa) prove book-level classification leaks. SA3285SO/SA3287SO seeded as observed-unconfirmed; kit_sku_stc_map stays empty until Roger rules, with ruled_by/ruled_at captured per mapping.

### D-KSTC-05 — stc_issuances append-only; historical sends pending backfill (2026-08-02)
DB trigger blocks DELETE always and freezes every column except notes/void fields (void-with-reason, never edit). The six pre-system doc-sends from the intake workbook load as request status 'issued' + a note, with zero issuance rows — the workbook never recorded which certificate/version was sent; manual backfill by April/Christy once the UI exists. Loader contract: reference data upserts on natural keys; stc_requests/kit_installations are insert-only; notes are first-write-wins; the loader only touches lots with source='paper_transcription'.

### D-KSTC-06 — Kiosk-style module at /kits, not Mainframe (2026-08-02)
The registry lives at /kits outside MainApp with its own header nav (Kit Entry / Search / Log STC), following the kiosk precedent (machine kiosk, rack kiosk, Finishing) — entry volume drives the design and the warehouse bench is where the paper book lived. Dual-mode auth on one URL: no session → kiosk-authenticate JWT with PIN-per-entry confirmation stamping created_by with the PIN operator (auth.uid() never equals created_by, per D-RLS-DOWNTIME01 reality); signed-in session → office mode, no PIN. Log STC is office-only: issuances are immutable compliance records and must trace to a real authenticated user. Gated by FEATURES.KIT_STC_REGISTRY.

### D-KSTC-07 — Entry never blocks; verification echoes; kiosk RLS posture (2026-08-02)
Warehouse entry saves with as-written text and null FKs when kit part or customer matches nothing (office resolves via exception queues) — the same as-written/normalized discipline as the transcription data. Invoice entry echoes the Fishbowl match ("{customer} — SO {n}") for bench-time mis-key catching and stages the sale-line link automatically when the SKU resolves. kit_lots INSERT opened to authenticated WITH CHECK (source='skynet') per Docs/migrations/2026-08-02_kit_lots_kiosk_insert.sql (applied to TEST 2026-08-02); UPDATE stays role-gated so corrections remain office work.

### D-KSTC-08 — Search: explicit fields, lens dashboards, exceptions as the empty state (2026-08-02)
Search uses explicit AND-composed fields (Customer, Kit, Kit #, Component Part #, Invoice #, Aircraft, Date range) with per-field typeahead — matching how CS actually narrows, not a universal box. A single pinned entity resolves to an entity lens (stat cards + lists); a bare kit # opens the lot drawer directly; anything else is a filtered lots lens. The empty state is the global dashboard: entry pulse, registry totals, and five exception queues, with "Conversion kits with no STC activity" as the styled headline — the compliance gap number this module exists to burn down. All reads client-side against base tables (stepwise id-set fetches + client merges per Supabase nesting limits); no RPCs or views yet — revisit only if row volumes make the id-set pattern slow.

### D-KSTC-09 — MaterialKiosk anchor requires commissioned machine (2026-08-02)
Backported Round A's .eq('is_commissioned', true) to MaterialKiosk's machine-anchor query. kiosk-authenticate requires a commissioned machine; anchoring on the first is_active machine could select an uncommissioned one and 401 the rack kiosk. Found during Kit Registry Round A; one-line parity fix.

### D-KSTC-10 — SkyNet assigns kit lot numbers (supersedes the numbering stance of D-KSTC-02) (2026-08-02)
New kit lots get system-assigned numbers via public.kit_assign_and_log (SECURITY DEFINER, REVOKE/GRANT per RPC convention): per-book sequences continuing the paper ranges, computed as GREATEST(max transcribed lot, book.last_lot)+1 under a kit_books row lock — atomic, gapless, race-free across concurrent devices; source hard-coded 'skynet'. The Kit # is display-only in the UI (bare advisory number; the RPC return is authoritative, rendered large for copying onto the kit label). The paper book, where still kept, now mirrors the screen — never the reverse. Manual number entry is removed; paper/historical rows enter only via the transcription loader, the sole writer of source='paper_transcription'. Migration: Docs/migrations/2026-08-02_kit_assign_and_log_rpc.sql.

### D-KSTC-11 — Bench captures the Sales Order, not the invoice (2026-08-02)
Invoices don't exist yet when the warehouse logs a kit, so entry captures so_as_written (new column, as-written discipline) with an echo against the kit_sales mirror: hit → "{customer} — SO {n}", customer prefill, and immediate kit_sale_line staging when the SKU resolves; miss → neutral "not in the last Fishbowl sync" and never blocks, since the mirror is export-refreshed and new SOs lag it by design. The loader gained an SO-based link pass mirroring the invoice pass, so bench rows auto-link on the next refresh. Labels renamed to bench truth: "Kit Name" (first field, description-primary typeahead), "Stud Lot #", "Receptacle / Platemount Lot #" — the latter two are FLN-family lot numbers, a future bridge into MES lot traceability, captured as text today.

### D-KSTC-12 — Exception queues gain a configurable baseline lens (2026-08-02)
KIT_EXCEPTIONS_SINCE in config.js (default 2026-08-04) scopes the global dashboard's exception queues to items arising on/after the date — request received_date for intake queues, lot log_date for lot queues, post-baseline lot references for the no-BOM queue. This is a display lens over live-derived counts: nothing is written or altered, search/lenses/drawers always show full truth, and null restores full history. Cards carry a "since {date}" suffix when scoped so the screen never overstates completeness. Rationale: the historical backlog is disclosed in the FAA audit workbook; the dashboard's job is the go-forward operational queue, adjustable by a one-line config edit + deploy.

### D-KSTC-13 — RPC grants: revoke anon explicitly (amends RPC convention) (2026-08-02)
Supabase default privileges grant EXECUTE to anon on function creation, so REVOKE FROM PUBLIC leaves an explicit anon grant in place — and SECURITY DEFINER bypasses RLS, so anon could call kit_assign_and_log with the public key. REVOKE FROM anon applied to TEST 2026-08-02 and appended to the RPC migration. Standing convention for every future RPC: REVOKE ALL FROM PUBLIC; REVOKE EXECUTE FROM anon; GRANT to authenticated + service_role. Found by Claude Code during A.1 review.

### D-KSTC-14 — Paper kit books retired at PROD go-live (2026-08-02)
With the registry live on PROD (schema, kiosk policy, RPC with anon revoke, and the full v5_3 load all applied 2026-08-02), SkyNet is the kit log of record and the paper books stop receiving new rows — supersedes the dual-run stance of D-KSTC-02 and the "paper mirrors the screen" framing of D-KSTC-10: the screen is the log. Historical book pages continue entering via the transcription loader as source='paper_transcription' until the remaining ~82% is digitized. Entry UI copy updated to registry-native wording (Customer placeholder is now "Customer Name").

### D-KSTC-15 — Entry books become category-labeled; BEECH sequence frozen (2026-08-02)
The entry selector now offers three category-labeled go-forward books — Conversion Kits (code SK203), Replacement Kits (TRIM), Kit Plane Kits (RV) — and BEECH is retired from entry (is_active=false; the RPC's inactive guard backstops the UI filter). Merging conversion entry means new Beech conversion kits take 100075-series numbers; the 77xxx Beech range is frozen and the airframe distinction lives in the SKU, not the serial. No lot rows were re-pointed: the 168 BEECH lots keep their book identity, and is_active gates ENTRY only — history surfaces, search, totals, and the transcription loader (which keys on the unchanged codes) all see every book. Binder names preserved in kit_books.notes; nav reordered to Kit Entry | Log STC | Search in office mode.

### D-KSTC-16 — Required-field enforcement: UI clarity, RPC integrity (2026-08-02)
Kit Entry marks required fields (Kit Name, Log Date, Customer, Sales Order #, Stud Lot # on non-RV kit types) with asterisks and inline validation — kiosk mode validates BEFORE the PIN pad so no operator PINs a doomed save — while Receptacle/Platemount and Notes carry "(optional)". The same rules are enforced in kit_assign_and_log (blank-rejecting with field-specific messages, stud exempted for RV where the field doesn't exist), because the database doesn't trust the form; all text inputs are btrim'd at both layers. Paper-transcription rows are untouched (loader inserts directly, and historical book rows legitimately have blanks). Applied to TEST 2026-08-02. Stock-build convention if a kit ever has no order: SO = "STOCK".

### D-KSTC-17 — Stud lot # is optional after all (amends D-KSTC-16) (2026-08-02)
Stud Lot # joins Receptacle/Platemount as optional everywhere it renders: asterisk removed, "(optional)" suffix added, inline-required validation dropped, and the RPC's non-RV stud requirement deleted (CREATE OR REPLACE on TEST 2026-08-02; PROD receives this final RPC version at promotion, superseding the D-KSTC-16 block). Required set is now Kit Name, Log Date, Customer, Sales Order #. The RV visibility rule is unchanged — stud/receptacle fields simply don't render for Kit Plane Kits.

### D-KSTC-18 — STC intake: suggest-never-commit extraction, atomic numbering, salesperson access (2026-08-02)
The Log STC tab gains a request worklist and a New Request flow: sales staff upload the customer's email (.msg/.eml/PDF/image/text — .msg and .eml parsed client-side with attachments unpacked) and the stc-extract Edge Function (Anthropic-backed, claude-sonnet-4-6, per the RMF drawing-extraction precedent) returns field suggestions that prefill an editable form with per-field confidence chips. The AI never writes: a human verifies and saves, and the saved human is the author of record — extraction failure degrades to the same manual form. stc_create_request (SECURITY DEFINER, no-anon grants) assigns intake numbers atomically under an advisory lock, continuing the workbook sequence at #72; authz = workflow roles OR is_salesperson, with matching supplementary RLS policies so Christy/Peyton work intakes without role changes. Files store via the existing S3 document path under kit-stc/requests/{id}/ as kit_stc_documents rows. Claims save as-written, unvalidated — resolution and issuance are Round C2.

### D-KSTC-19 — Lot-first STC intake with an accountable escape hatch (2026-08-02)
New Request now opens on Find-the-kit: salespeople locate the warehouse's kit log entry (search by customer, SO, or kit #) before the upload/form step, and the request is created already linked (status 'matched'). The escape path — for requests referencing kits on untranscribed book pages — requires a typed reason, saves unlinked as status 'new', and lands in the claimed-kit-unresolved exception queue rather than back in an inbox. Mandatory set expanded per the bench annotation: received date, requester name, company, kit part, aircraft serial, registration, and order # unconditionally; kit identity satisfied by linked lot OR claimed kit # (mandating a claimed number the customer never wrote, when the log entry is already linked, would fabricate a claim — a claimed-vs-linked mismatch instead renders as a warning chip and saves as real data). RPC replaced with the 13-arg signature enforcing all of it server-side; TEST 2026-08-02.

### D-KSTC-20 — Claimed kit # unconditionally required (amends D-KSTC-19) (2026-08-02)
The claimed kit # is mandatory on every intake, linked or not — RPC and UI both enforce it, replacing D-KSTC-19's linked-lot-OR-claim rule. Bench convention when the customer's email states no number: enter the number from the located log entry or the customer's paperwork; the field records the kit identity as submitted with the request. The linked-vs-claimed mismatch chip remains the mechanism that surfaces disagreement between claim and log.

### D-KSTC-21 — STC requests are editable, with field-level audit and an issued lock (2026-08-02)
Requests gain an Edit mode in the drawer reusing the intake form's fields and validation (one derivation). stc_update_request (SECURITY DEFINER, no-anon) re-validates the required set, diffs server-side, updates only on real change, and writes audit_logs 'stc_request_updated' with per-field from/to under the editor's operator_id — every correction is attributable. Issued requests lock all fields except notes: claims underpinning a sent compliance document don't move after the fact. Status, linked lot, and intake # are not editable here — linking and status transitions belong to the C2 resolution workflow. Convention for historical workbook rows with genuinely absent data: "not given on form" satisfies the required fields honestly.

### D-KSTC-22 — Historical STC sends accepted as issued; no backfill (supersedes the backfill stance of D-KSTC-05) (2026-08-02)
The six pre-system doc-sends from the intake workbook (intakes 60, 61, 62, 65, 68, 70) are accepted as issued on the workbook's word: status 'issued' plus the sent date in notes IS the record for pre-system sends, and the certificate-identity backfill is retired — recording which document was sent would have required fabricating identities nobody captured. Boundary: intakes 1–71 are the only rows where 'issued' may exist without a stc_issuances row; for all subsequent requests, issued means an immutable issuance record exists, created through the C2 workflow. Notes reworded on TEST and PROD 2026-08-02.

### D-KSTC-23 — Edit validation is no-regression, not full-set (amends D-KSTC-21) (2026-08-02)
Round C1.3 revealed that mirroring creation validation into edit made 70 of 71 historical requests force-fill every blank on any edit — and locked all six issued rows out of notes editing, because the forced fills tripped the issued lock. stc_update_request now enforces no-regression only: a populated field cannot be blanked ('cannot be removed'), a historically blank field may stay blank until the information truly exists. Creation keeps the full D-KSTC-20 required set. Edit-mode asterisks mark can't-be-blanked; the "not given on form" convention becomes optional rather than a toll for touching a record. The three C1.3 verification audit rows on TEST are retained deliberately — they are the record.

### D-KSTC-24 — Component-lot traceability table (2026-08-03)
kit_lot_component_lots at grain (kit lot x component part x lot): as-written strings are the record, component_id is the normalized kit_components link, UNIQUE (kit_lot_id, part, lot) makes every load path idempotent. Sources: fishbowl_backfill / packing_slip / manual. Same SKU logged twice on one SO: both lots receive the same component-lot set. Writes are RPC/psql-mediated; RLS is SELECT-only until the packing-slip round adds admin/compliance correction policies copied from sibling kit tables.

### D-KSTC-25 — Backfill source is the curated Fishbowl shipping report (2026-08-03)
Per-lot tracking rows; lot_qty == qty_shipped verified 100% on the 2026-08-03 export, cross-checked line-for-line against packing slip S16373. Filter denylists pseudo-products, drops null-lot rows, collapses carton fan-out. Loader is report-first (dry run), preflight-guarded, TEST before PROD, ON CONFLICT DO NOTHING. Lot->SO resolution: bench lots direct (linked sale, else so_as_written); paper lots bridge invoice_as_written -> fishbowl_invoices.invoice_number -> so_number, because the paper books recorded invoices, not SOs (the D-KSTC-11 flip side). Bridge reach = the fishbowl_invoices export window; widen from 2024-01-01 to cover transcribed lots. Rerun the loader on every Fishbowl refresh or transcription batch.

### D-KSTC-26 — Component-lot search and drawer surface (2026-08-03)
Kit Search gains a Component Lot # AND-filter and a ComponentLotLens (exact match first, prefix fallback flagged in the UI); the lens groups by part number because lot strings collide across parts (e.g. one lot number spanning two screw sizes; instructions sheets all lot 0001). KitDrawer gains a Component Lots section ordered by SO line. Read-only round; renders empty until backfill or packing-slip capture populates rows.

### D-KSTC-27 — Paper "Invoice #" is the Fishbowl SO (2026-08-03)
Fishbowl invoice numbers inherit the SO number, so the books' invoice column resolves shipments directly: loader v3 added the invoice_direct path (priority: linked sale / so_as_written, fishbowl_invoices bridge, invoice-as-SO). Backfill result 2026-08-03: 574/646 active paper lots, 6,021 rows, TEST=PROD fingerprint 3f411e7ff9373d832677a55d01c591f5. Remainder tracked in Kit_Backfill_Review_Worksheet: 26 SKU mismatches + 46 era-gap lots; resolution = correct kit_lots (kit_sku_id / invoice_as_written + transcription_notes) then rerun the idempotent loader, TEST before PROD.

### D-KSTC-28 — Packing-slip capture at ship time (2026-08-03)
/kits gains a Packing Slip tab (kiosk + office; PIN-per-save at the bench). packing-slip-extract Edge Function (claude-sonnet-4-6, suggest-never-commit, verbatim transcription, kit-group inference from slip header lines, Notes "Lot:" hint preselects the kit lot). Operator-confirmed grid saves via kit_record_component_lots (SECURITY DEFINER, source='packing_slip', ON CONFLICT DO NOTHING — the table's unique key makes re-uploads idempotent). Slip stored to S3 kit-stc/lots/{id}/packing-slips/ with a kit_stc_documents 'packing_slip' row per affected lot; drawer lists them. kit_lot_component_lots gains admin/compliance UPDATE/DELETE correction policies; INSERT remains RPC-only. Shipping-report loader reruns remain the periodic sweep behind this real-time path. kit_stc_documents additionally gained a narrow kiosk INSERT policy (document_type = 'packing_slip' AND kit_lot_id IS NOT NULL), mirroring the kit_lots_insert_kiosk precedent, so bench-mode slip attachment passes RLS.

### D-KSTC-29 — Slip capture rides Kit Entry (2026-08-03)
The bench logs the kit and uploads the packing slip in one motion (one save, one PIN); the slip is optional and never blocks entry. The slip cross-validates the operator: extracted Order # vs typed SO and extracted kit group vs selected Kit Name render agreement chips, and any mismatch holds the slip portion (kit still saves) so lots are never recorded against the wrong kit. Low-confidence and lot-less lines surface expanded for review; remaining lines confirm behind an expander (suggest-never-commit preserved). Multi-kit slips record only the matching group per entry; re-uploading the same slip for sibling kits is safe (idempotent unique key). The Packing Slip tab remains as the catch-up/repair path for kits logged without their slip; both surfaces share one derivation of the flow (SlipDropzone / SlipReviewGrid / useSlipExtraction).

### D-KSTC-30 — SK203 PDF2 supplement batch (2026-08-03)
A second SK203 PDF log (kits 99431–100074, Mar 2025 – Jul 2026) was missing from the original digitization; workbook v5_5 adds it as the "SK203 PDF2 Supplement" tab (644 rows: 624 active, 20 no-entry; all other tabs data-identical to v5_4). Loaded via the standard kit_stc_load rerun (natural-key upserts), TEST before PROD. The supplement abuts the bench boundary (100074 | 100075); 99011–99430 remains the known SK203 transcription hole. Rerunning the component-lot backfill loader after this batch extends shipped-lot traceability to the new lots via the invoice≡SO direct path (D-KSTC-27). STATUS: loaded TEST + PROD 2026-08-03, both verified identical (1292 lots; 624 active + 20 no_entry added; no pre-existing lot mutated). The load bound 34 catch-up stc_requests to their now-transcribed lots and created 34 kit_installations (all status 'claimed'), authorized as the loader's designed transcription-catch-up behaviour (D-KSTC-19/21); the link passes leave request status untouched; no issuance rows were written, so D-KSTC-22 is unaffected and intakes 60/61/70 remain issuance-less. Party resolution is partial by design (491 of 624 active supplement lots; SO-based resolution is a future pass) and 10 active lots carry an unknown kit SKU as-written with kit_sku_id NULL. The exception headline "Conversion kits with no STC activity" grew 324 → 904 on both environments: +624 new active conversion lots, less the 34 now carrying STC activity, less 10 whose paper rows carry no log date (a null anchor falls outside the D-KSTC-12 baseline). Loader property: ON CONFLICT DO UPDATE re-fires the touch trigger on every staged row, so updated_at on kit_parties/kit_skus/kit_components/kit_sales/aircraft moves on every rerun without content change — never treat updated_at on those tables as a change signal; substantive-column fingerprints are the comparison method.

### D-RMF-06 — RM Forecast view access widened; gate honors multi-role (2026-07-31)
**What:** _rm_forecast_gate() allowed set widened to admin/scheduler/purchaser/
compliance/machinist and now resolves roles via profiles.role OR roles[]
(multi-role, Spec v4.0) — the original gate checked primary role only, which
locked out Sawyer (purchaser as additional role) despite correct frontend
gating. Frontend: 'rmforecast' added to compliance and machinist tab arrays;
canView widened; gated-panel copy updated. Write actions (Needs-data Save,
Correct material, Extract) remain admin/scheduler; part_dimensions RLS and the
Edge Function gate unchanged.
**Why:** Purchaser hit the "Forecast access is limited" panel — tab visible,
RPCs 403. Compliance and machinists need the forecast for material planning and
bar verification.
**Files:** Docs/migrations/2026-07-31_rmf_gate_roles.sql, src/pages/Armory.jsx,
src/components/rmforecast/RMForecastSection.jsx.

### D-KIOSK-01 — Session deactivation scoped to (operator, machine, device); logout reasons recorded (2026-08-05)
Kiosk/Finishing session deactivation is now scoped to (operator, machine, device); handleLogout records logged_out_at + logout_reason ('manual' | 'inactivity' | 'jwt_expiry' | 'session_displaced'). Fixes cascading forced logouts on multi-window tablets and Finishing-page crossfire. Finishing sessions now inserted (upsert removed — no unique constraint on operator_id+machine_id exists). Single-session-per-operator enforcement unchanged by design.

### D-KIOSK-02 — Kiosk hardened for iOS standalone (home-screen icon) launches (2026-08-05)
Expired JWT cleared synchronously before the machines lookup, Retry button added to the machine-error screen, and a visibilitychange/pageshow handler retries failed loads and forces re-PIN if the JWT expired during suspension. Root cause of "Failed to load machine" on tablet icons: isolated standalone storage container holding an expired 8h kiosk token, raced against the async cleanup effect.

### D-KSTC-31 — Slip upload hardening (2026-08-05)
Images are canvas-compressed client-side before extraction (2200px longest edge, JPEG, <=3MB) with EXIF orientation respected; PDFs cap at 8MB with an explicit message. functions.invoke in kiosk mode carries the kiosk JWT exactly like PostgREST calls. Extraction errors surface the underlying failure instead of a generic banner. (Bench report: fetch-level Edge Function failure; both suspects — oversized photo payloads and kiosk-mode invocation auth — are closed by this round.) Measured against TEST 2026-08-05: a kiosk JWT + small payload returns 200; no auth header is refused by the platform gateway (401 UNAUTHORIZED_NO_AUTH_HEADER) and the anon key as bearer is refused by the function itself (401 "Unauthorized") — the latter is exactly what supabase-js sends when the session has expired, because its authed fetch falls back to the anon key rather than failing, so the token is now read explicitly and a dead station sign-in is named instead of sent. Payload wall: a real 5.6MB image extracts fine, 8.3MB and up return "Extraction service error 400" from the model API, and only above the function's own 20MB gate does the operator get an actionable sentence — a phone photo lands squarely in that silent band, which is why 3MB is the target rather than the 20MB ceiling.

### D-KSTC-32 — Confirmation is terminal (2026-08-05)
A successful Kit Entry save replaces the form with the confirmation screen (huge number; "{lot} — {description} · logged by {operator}"; slip and STC result lines) and a single "Add new entry" action that performs a total state reset. The prior stale-form-with-advanced-number behavior invited double-logging and is removed.

### D-KSTC-33 — STC intake at Kit Entry, office mode only (2026-08-05)
A checkbox opens inline intake for the non-derivable fields; the request is created against the just-assigned lot with claimed kit # / part / order # derived from the entry itself, landing status 'matched' from birth. Failure-isolated from the kit save. Kiosk mode never shows it (device identity cannot satisfy intake authorization). Save order is kit → slip → STC, each result line rendering independently; the STC step is validated before the save (and before the kiosk PIN pad) so a request that would be refused never reaches a kit that already has a number. Verified on TEST 2026-08-05 by round-tripping the real RPCs: fixture lot via kit_assign_and_log then stc_create_request with the derived values landed status 'matched', all three claimed fields equal to the derived values, and intake_number sequencing to max+1; fixtures removed and TEST restored to baseline.

### D-INV-01 — FIFO receipt attribution; AVAIL (BARS) reads the view (2026-08-05)
Material consumption now attributes usage FIFO to the oldest receipt row with remaining bars (zero-quantity rows never charged; fully-exhausted lots charge the newest stocked row to keep over-consumption visible). Fixed identically in Kiosk.jsx and MaterialKiosk.jsx — the prior newest-first match piled usage onto stub rows and generated most open reconciliation flags. Armory inventory AVAIL (BARS) now reads the material_availability view's available_bars directly instead of dividing inches by the row's bar length, which mis-scaled lots with mixed bar lengths. Why the division was wrong: the view computes available_inches from material_usage.quantity_used_inches, which the kiosk logs at the bar length the OPERATOR typed, while the divisor is the receipt row's own bar_length_inches — the two disagree whenever a lot's rows carry different lengths, and a null quantity_used_inches makes the derived figure ignore the usage entirely. Verified on TEST 2026-08-05 by running the exact client query chain against three-row fixtures: stub skipped in favour of the stocked row; oldest stocked row with remaining bars preferred over a newer one; newest stocked row taken when all are exhausted. Fixtures removed. Scope note: the fix is forward-only — 22 PROD usage rows already attributed to zero-quantity receipts stay where they are and need a separate data correction. PROD had 20 multi-row lot groups (the population this affects) and zero lot groups consisting only of stub rows, so excluding quantity = 0 orphans no existing consumption.

### D-INV-02 — Inventory summary strip: bars subtotal, and low-stock threshold at 5 (2026-08-05)
Raw Material Inventory summary strip now shows total available bars across the filtered lots (negatives netted, matching the forecast's ON HAND per D-INV-01), and the low-stock threshold moved from <2 to <=5 available bars via the LOW_STOCK_BAR_THRESHOLD constant. Out-of-stock and negative styling unchanged. The subtotal reduces filteredInventoryRows, so it tracks the active filters rather than the whole table. Effect of the threshold change on PROD: amber lots go from 2 to 22 of 178, alongside 13 out-of-stock and 6 negative. Worked example (PROD, 303 Stainless Steel / 0.500 dia): four rows — 2605 at 0, 2581's 144" row at 38, 2617 at 0, and 2581's 48" stub at 2 — subtotal 40 bars, one amber. Same filter on TEST reads 160 across three lots with two amber, because TEST's usage data diverges from PROD; the figure is data, not a regression.

### D-RMF-07 — Purchaser granted full write access on the RM Forecast (2026-08-05)
Purchaser granted full write access on the RM Forecast — part_dimensions INSERT/UPDATE RLS, frontend canWriteDimensions, and the extract-part-dimensions role check all widened to admin/scheduler/purchaser; Edge Function check made multi-role aware (role OR roles[], D-MROLE-02). Compliance and machinist remain read-only. RLS applied by hand to TEST and PROD 2026-08-05; Edge Function redeployed to both (ylzmyjjqibpbqbwjsnqj, luzungoqfuplspzbqctb). NOT included, contrary to the plan for this round: the same-day extraction hardening (tolerant JSON recovery, max_tokens 3000, stop_reason surfaced in 422s). No such changes existed in the working tree — index.ts was unmodified since D-RMF-04/05 and still carries max_tokens 1500 — so the deployed function has the authorization fix only. Record the hardening under its own entry when it is re-applied.

### D-KSTC-34 — Claimed fields derive from the linked lot (2026-08-05)
On the lot-first intake path the Claimed kit #, Claimed kit part, and Order # inputs are removed and derived from the linked lot (shown as a read-only summary); extraction is not authoritative for them. The escape-hatch (unlinked) path retains all three inputs as the request's only identity. RPC contract and edit-mode no-regression validation unchanged.

### D-SCHED-01 — Mainframe machine card queues sort by schedule (2026-08-06)
Mainframe machine card queues now sort by scheduled_start (nulls last, created_at tiebreak), matching Kiosk.jsx and Schedule.jsx. Previously sorted by created_at, so the Mainframe showed a different run order than the kiosk the machinist works from. MachineCard.jsx applies no sort of its own — it renders the parent's order — so the fix belongs in the Mainframe fetch.

### D-DATA-01 — Wrong-job production reattributed: J-000136 -> J-000148; J-000183 re-homed (2026-08-12)
**What:** Operator set up Nexturn 7 for SK4C13S but selected J-000136 (SK4C7S,
WO-2607-0021) and ran the -13s under it: 1,464 pcs across two batches
(machinist-typed sends 491+929 = 1,420; finishing verified 491+973 = 1,464),
PLN-2592-260806-0002, FLN-100159, 16 of 20 staged bars of lot 2592 consumed
(four staging events of 5 — two machine-kiosk, two material-kiosk — confirmed
real against material_loads and a physical rack reconcile; the floor's "15
staged" was off by one event). Corrected via guarded single-block PROD SQL:
finishing_sends, job_materials, material_loads and usage moved to J-000148
(status manufacturing_complete, good_pieces 1420); the last 5-bar usage row
reduced to 1 so the 4 unmachined bars returned to on-hand for normal kiosk
restaging on J-000183; the first usage row's quantity_used_inches repaired
(0 -> 720, blank bar-length field on first load); J-000183 moved from
WO-2608-0036 to WO-2607-0021; J-000136 stripped of lots/counts/timestamps and
cancelled; WO-2608-0036 cancelled empty.
**Why this shape:** The PLN embeds the material lot (2592), not the part, so
physical bin labels stay valid on the -13s. good_pieces must equal the SEND
total (1420, not verified 1464) — ComplianceReview's canAdvance gate compares
the sum of non-rejected send quantities against good_pieces. Batch B's
929-typed / 973-verified delta is machinist under-typing (dock incoming_count
was 973; count_discrepancy 0) and is preserved for compliance. Routing steps
were left untouched on both jobs: nothing in the system marks internal steps
complete (only outsourcing and step-removal flows write them), so all-pending
steps on a finished job is normal state. Soft cancel over hard delete:
audit_logs FK on job_id, and an unbroken J-number sequence for AS9100.
**Also shipped:** Build Summary now excludes cancelled jobs from Ordered/Built.
**Lesson:** material_usage is written at staging time. When splitting a job's
material, keep only consumed bars attributed and RETURN leftovers to on-hand so
the next job stages them through the normal kiosk flow — never pre-attribute
leftovers to the next job, which either double-deducts on restage or requires
floor workarounds.

### D-DATA-02 — Late finishing batches added to closed-out jobs (2026-08-12)
**What:** Two jobs were completed at the kiosk with parts still sitting at the
machine, unsent to finishing, and had already advanced to pending_tco.
J-000143 (SK213-2B, WO-2607-0008, Mazak 4): 5 approved batches totalling 2,162
against a 2,018 target; 298 pcs added as a sixth batch -> 2,460 (+442).
J-000089 (SK247P, WO-2606-0034, Mazak 1): 5 approved batches totalling 2,072
against a 1,639 target; 349 pcs added as a sixth batch -> 2,421 (+782).
Each correction was a guarded single-block PROD transaction: insert a
pending_finishing finishing_sends row inheriting machine, sent_by, PLN and
material lot from the job's last batch, then step the job from pending_tco back
to manufacturing_complete with good_pieces re-derived to the new send total.
Neither job needed material work — material_usage is charged at staging, so the
rack was already correct. co_fulfillment_applied_at was left untouched on both;
CO line quantity_fulfilled was compared before and after.
**Why the step-back:** ComplianceReview's canAdvance gate requires
status === 'manufacturing_complete'. A job left at pending_tco will accept and
approve a new batch but never re-advance, and it stays in the TCO-ready pool
while unfinished parts are in flight. Stepping back is what lets the normal
compliance path close the job out again.
**Why good_pieces is re-derived:** the gate compares the sum of non-rejected
send quantities against good_pieces (falling back to job quantity when
good_pieces is 0), so a stale good_pieces either strands the job or advances it
early. Both corrections guard that every prior batch is compliance-approved,
since a rejected batch makes those two totals diverge.
**Manual Batch is NOT a finishing batch:** the "+ Manual Batch" control on the
WO Lookup job card writes missed_production_entries, which getEffectiveQty ADDS
on top of the tracked count. It is only for parts SkyNet will never otherwise
log (pre-go-live, prior-WO carry-over). Using it for parts that will then flow
through finishing double-counts them. Both transactions guard on
missed_production_entries being empty for exactly this reason.
**Lesson:** kiosk Complete does not verify that everything produced has been
sent to finishing, so an operator can close a job with parts still at the
machine — and the job then advances out of reach of the normal finishing path.
Recovery is always the same two moves: insert the missing send, step the job
back to manufacturing_complete.

### D-DATA-03 — "Taveres" corrected to "Tavares" across data and UI (2026-08-13)
**What:** The Tavares facility was misspelled "Taveres" throughout SkyNet. A
full scan of every text, varchar and jsonb column in the public schema found
exactly two: locations.name ('Taveres Facility') and locations.address
('Taveres Manufacturing Center, Taveres, FL'), both on one row, corrected by
targeted UPDATE. Four source files carried it in copy or literals:
Schedule.jsx (default collapsed group), ScheduleJobModal.jsx (ordering comment
and a spelling-tolerant includes check, now narrowed to 'tavares'), and
PresidentsBridge.jsx (two display strings).
**Latent bug fixed alongside:** Schedule.jsx's collapsedGroups default was the
bare string 'Taveres', but the collapse state is matched with
collapsedGroups.includes(group.name) where group.name is the FULL location name
from the database. 'Taveres' never equalled 'Taveres Facility', so the Tavares
group had never collapsed by default. Now set to 'Tavares Facility'.
**Lesson:** collapsedGroups, and anything else keyed on a location or machine
name from the database, breaks silently when the stored name changes. Prefer
matching on a stable id or code over a display string; where a literal is
unavoidable, it must be updated in the same change as the data.

### D-KIOSK-03 — Per-machine bar-length limits enforced at both kiosks (2026-08-13)
**What:** machines.max_bar_length (numeric inches, NULL = no limit) added on
TEST and PROD; Mazaks seeded at 48, Nexturns at 144, others NULL. Both the
machine kiosk (handleAddMaterial) and the rack kiosk (handleStage) hard-stop
any load whose effective bar length exceeds the machine's limit, where
effective length is the job's recorded bar length if present, else the form
entry. On machines with a limit, a bar length is now REQUIRED before loading —
previously the field could be left blank, which is how zero-inch
quantity_used_inches rows occurred (see D-DATA-01). Bar-length placeholders
show the machine's limit. Blanks are exempt. Optional DB trigger
trg_enforce_machine_bar_length on job_materials backstops every write path
including admin SQL; disable it per-statement for a sanctioned exception.
**Why a column, not a name check:** matching on machine names breaks silently
when names change (D-DATA-03). The limit is data on the machine record, so the
Mazak 7 replacement gets its limit as data entry, not a code change.
**Why max rather than exact:** remnants shorter than the limit are physically
loadable and remnant staging is a supported flow; the rule blocks only bars too
long for the feeder.

### D-JOBMERGE-01 — Job merge (co-production absorb), Round 1 schema + RPCs (2026-08-15)
**Context:** Second attempt at co-production, replacing SKY89's LINK model (reverted, D-JOBLINK-09). New model is ABSORB: the host job keeps its schedule slot, lot, material, finishing chain and documents; a member job is unscheduled (new status 'merged', machine + schedule cleared, jobs_no_machine_overlap never sees it) and holds a claim on the host's output. jobs.quantity is never mutated — run target is derived (host qty + active member claims). Lots attach to the physical run; merge is never a lot event. Host lot/dates stamp onto members only at allocation, after compliance resolves. Cross-WO traceability rides the existing work_order_component_jobs link the cert package builder already reads.
**What:** jobs.merged_into_job_id (+FK, self-merge CHECK, partial index); 'merged' added to jobs_status_check (old auto-named CHECK dropped dynamically); job_merge_allocations table (append-only via is_active; RLS SELECT authenticated via jma_select_authenticated, writes only via RPCs); _job_merge_gate (NULL-uid pass, user_has_role(p_uid, VARIADIC p_roles) otherwise, anon revoked); merge_job_into_host (host pre-start→in_progress, member untouched pre-start only, same component, any machine; inserts wocj link cross-WO); unmerge_job (window closes at host production completion; 'assigned' restores as 'ready'); allocate_merged_batch (atomic, idempotent via allocated_at; guard: host actual_end set + all sends compliance-resolved; fill by WO due date NULLS LAST then job_number; surplus to host WO; outsourced hosts require explicit p_total_good; lockstep member status = host status; stamps host lots/dates on members); merge_host_candidates (single eligibility source for all merge surfaces, SECURITY INVOKER).
**Deploy:** TEST applied 2026-08-15 (verification gate passed). PROD promotion only when Rounds 1–4 are complete — merge without allocation wiring strands members (SKY89 lesson).
**Files:** JobMerge_R1_TEST_Migration.sql.
**Next:** R2 Schedule surfaces → R3 Kiosk → R4 allocation wiring + read-throughs → R5 WO-creation prompt.

### D-JOBMERGE-02 — Job merge scheduling surfaces (2026-08-15)
**What:** New src/lib/jobMerge.js (RPC wrappers merge/unmerge/candidates + shared isMemberEligible/getRunTarget helpers; getRunTarget is the single run-target source the kiosk reuses in Round 3). ScheduleJobModal: when the job being scheduled is member-eligible and merge_host_candidates returns rows, Step 1 shows a promoted "already has an active run" card list above the machine picker; picking one opens a confirmation view (run-target math, allocation note) that calls merge_job_into_host and bypasses the 3-step scheduling flow entirely; footer Next hides in that view. Schedule board: fetchData loads active job_merge_allocations for all visible jobs (allocations query + separate member-job query, client-merged — two-level nesting rule); JobBlockContent shows a Layers badge + qty+N readout on hosts; the selected-job popup shows a merged-quantity readout and a JobMergePanel (module-level component — holds state, so not defined inside Schedule where re-renders would remount it) with host view (member rows: J#, WO, customer, qty, due + Unmerge) and member view (candidate hosts + Merge, window.confirm pattern).
**Why:** The scheduler asked for merge available directly in the scheduling flow (modal Step 1) and on the Schedule screen — the modal card is the "encourage" lever at the moment a duplicate becomes a physical plan. Merged members carry status 'merged' with machine/schedule NULL, so both board queries exclude them automatically; no filter changes needed.
**Deploy:** TEST only, with the D-JOBMERGE-01 migration already applied there. PROD only when Rounds 1–4 promote as a set.
**Files:** src/lib/jobMerge.js (new), src/components/ScheduleJobModal.jsx, src/pages/Schedule.jsx.
**Next:** R3 kiosk run target + combined-run banner; R4 allocation wiring at compliance + effectiveQty host adjustment + traveler/WO Lookup read-through; R5 CreateWorkOrderModal prompt.

### D-JOBMERGE-03 — Paperwork staleness + compliance notifications (2026-08-15)
**What:** jobs gains traveler_printed_at/by, paperwork_changed_at/reason, paperwork_ack_at/by/note. Stale is DERIVED: changed_at newer than both printed_at and ack_at — no clear-flag, reprint or ack self-heals, a later merge/unmerge re-stales past both. merge_job_into_host and unmerge_job (full CREATE OR REPLACE, same signatures) stamp paperwork_changed on host AND member with old→new run-target reason strings and call new _notify_compliance() helper, which inserts user_notifications rows for every active compliance-role holder (user_has_role canonical). New ack_job_paperwork(p_job_id, p_note) records the "continue on existing paper" decision (admin/compliance gate, audit_logs 'paperwork_ack').
**Why:** A merge invalidates the traveler already in the machinist's folder; the notice must be unskippable and the resolution auditable. Historical fleet unaffected (all stamps NULL until a merge touches a job).
**Deploy:** TEST only. PROD with the R1–R4 set.
### D-JOBMERGE-04 — Shop-floor + office paperwork truth (2026-08-15)
**What:** jobMerge.js gains isPaperworkStale (derived: paperwork_changed_at newer than both traveler_printed_at and paperwork_ack_at), fetchActiveMembers, ackJobPaperwork. Kiosk: run target replaces jobs.quantity at every machinist-facing quantity (send-exceed warning, active panel displays, send-modal remaining math, lot-change target, secondary-completion mismatch), plus a combined-run banner (members: J#, WO, customer, qty) and an amber stale-traveler banner — the kiosk is the machinist's notification. Mainframe WO Lookup: jobs select carries merged_into_job_id + paperwork stamps; member rows show "Merged → host J# · WO · machine" (host info resolved in one extra client-merged query); getJobBadges adds a "Traveler outdated" badge; the drill-down gains a compliance/admin "Acknowledge — continue on existing paper" action (ack_job_paperwork RPC, note recorded); printing the traveler stamps traveler_printed_at/by (staleness self-clears). traveler.js: fetchMergeInfoForTraveler export; host travelers show "qty (+N merged = RT run)" and a Combined Run section (member J#/WO/customer/qty/due) between the CO table and Assembly Genealogy; member travelers show a "produced under host" section and read the Machine Process station through the host; fetchTravelerData attaches mergeInfo so the cert PDF path inherits the content. PrintTraveler also stamps the print.
**Why:** A merge invalidates the traveler already sitting in the machinist's folder. Staleness is derived from three timestamps (no clear-flag bugs); resolution is a reprint or a recorded compliance decision; the D-JOBMERGE-03 RPCs stamp and notify server-side so the notice cannot be skipped.
**Known gap (R4):** PrintTraveler.jsx (/print/traveler/:jobId) does NOT go through fetchTravelerData or buildTravelerHTML — it has its own inline job query and its own JSX renderer, so its output carries no Combined Run section and no run-quantity suffix. Its print stamp therefore clears the staleness badge on a printout that is still missing the merge content. Either route it through buildTravelerHTML or drop its stamp before PROD. — RESOLVED by D-JOBMERGE-05 (PrintTraveler now renders the canonical document).
**Deploy:** TEST only, after JobMerge_R3_TEST_Migration.sql. PROD only when Rounds 1–4 promote as a set.
**Files:** src/lib/jobMerge.js, src/lib/traveler.js, src/pages/Mainframe.jsx, src/pages/Kiosk.jsx, src/components/PrintTraveler.jsx.
**Next:** R4 allocation wiring at compliance + effectiveQty host adjustment + member shortfall awareness; R5 WO-creation prompt.

### D-JOBMERGE-05 — PrintTraveler canonical wrapper (2026-08-15)
**What:** src/components/PrintTraveler.jsx replaced in full: the /print/traveler/:jobId route now fetches via fetchTravelerData (complete dataset incl. mergeInfo) and renders buildTravelerHTML into a full-viewport iframe with the original auto-print behavior preserved (toolbar self-hides via .no-print; landscape @page rules come from the built HTML). Print stamp resolves traveler_printed_by from supabase.auth.getUser() since the route runs outside the app shell; stamp is non-blocking.
**Why:** Closes the R3 "Known gap": the route was a 331-line drifted duplicate renderer (job + steps only), and R3's stamp there cleared staleness on a printout missing the combined-run content — the exact failure the staleness system exists to prevent. The route is orphaned (registration is its only in-code reference) but bookmarks keep such routes alive; rendering the canonical document makes both the printout and the stamp truthful. Also removes the Known gap (R4) line from D-JOBMERGE-04 scope — resolved here instead.
**Deploy:** TEST only. PROD with the R1–R4 set.
**Files:** src/components/PrintTraveler.jsx.

### D-JOBMERGE-06 — Merge hover tooltips (2026-08-15)
**What:** WO Lookup member-row machine cells collapse to "Merged → J-xxxxxx" (untruncatable in col-span-2) with the full detail on a native title hover; the "merged" status chip becomes a cyan "Merged" badge carrying the same tooltip (badge objects gain an optional title field, passed through the assembly-path badge renderer with cursor-help). New describeMergeHost(job) helper is the single string source: "Merged into J# · WO# · machine — this job's N pcs are produced under the host run". D-JOBMERGE-04's Known-gap line annotated as RESOLVED by D-JOBMERGE-05 (append-only: original text preserved).
**Why:** The inline host detail truncated; native title is SkyNet's established hover convention (shortfall badges, qty pencil, standalone machine cell). One builder feeding both surfaces keeps the wording from drifting.
**Deploy:** TEST only. PROD with the R1–R4 set.
**Files:** src/pages/Mainframe.jsx, Docs/Decisions.md.

### D-JOBMERGE-07 — Allocation stamps, shortfalls, and notification (2026-08-15)
**What:** jobs.merged_out_good (host's allocated-out total, NULL until allocation). allocate_merged_batch (full CREATE OR REPLACE, same signature): stamps merged_out_good on the host's final update; evaluates shortfalls for every party — members allocated below their ask and the host below its own quantity after surplus — mirroring lib/shortfall.js (idempotent open job_shortfall_resolutions row + has_open_shortfall on job and WO); notifies compliance ("Combined run allocated", part number, total, host/member split, shortfall count, full per-party payload) via _notify_compliance. Outsourced hosts still require explicit p_total_good (manual harness) by design.
**Why:** The sync effectiveQty lib needs the allocated-out number on the row itself; shortfalls must be unskippable at the moment shares become real; compliance owns the paperwork consequences of the split.
**Deploy:** TEST only. PROD with the R1–R4 set.

### D-JOBMERGE-12 — Merged members keep their compliance obligation (2026-08-15)
**What:** jobs.merge_requires_compliance_ack, set by merge_job_into_host when the member was pending_compliance at merge (the merge notification gains a sentence naming the pending review); allocate_merged_batch raises while any active unallocated member carries the flag; unmerge_job clears it (the member returns to its pre-merge status and the normal queue owns the obligation again); new ack_merged_member_compliance(p_member_job_id, p_note) — compliance/admin gate, flag clear, audit_logs 'merge_compliance_ack'. Function bodies extracted from the applied R3/R4 migrations and patched with minimal deltas, not retyped.
**Why:** J-000190 merged while pending_compliance and left the pre-production queue with status 'merged' — an unreviewed order producing pieces. The review is about the ORDER's paperwork, not the physical setup, so merging can't discharge it; blocking allocation (not the merge, not the run) is the control point that doesn't slow the scheduler.
**Deploy:** TEST only. PROD with the promotion set.

### D-JOBMERGE-14 — Explicit allocation + machinist paperwork ack (2026-08-15)
**What:** ack_job_paperwork gate widens to machinist (kiosk "New Paperwork Received" — operator in the note). New _reconcile_merge_shortfall(job, target, produced): below target opens/refreshes the open row + flags; at/above resolves open rows (status='resolved', resolution NULL per CHECK, notes "Superseded by reallocation", resolved_by/at) and recomputes job/WO has_open_shortfall from remaining truth. New set_merge_allocation(host, shares jsonb, total DEFAULT NULL): same readiness + acknowledgment guards as allocate_merged_batch, TCO-closed parties (status 'complete') lock it; shares cover every active member (0..ask), host = remainder ≥ 0; restamps member jobs/allocation rows/merged_out_good, reconciles via the helper, audits 'job_merge_reallocated' with previous vs new, notifies compliance. ack_job_paperwork body extracted from applied R3 and patched, not retyped.
**Why:** The live QL8C62 pair: the ack guard held correctly, but the scheduler had no hand on the split and sales reallocation had no path short of a SQL harness. Shortfall truth must follow the split in both directions or the flags lie.
**Deploy:** TEST only. PROD with the promotion set.

### D-JOBMERGE-16 — Acknowledgment is a worklist, not a gate (2026-08-15)
**What:** allocate_merged_batch and set_merge_allocation lose the D-JOBMERGE-12/-14 acknowledgment guards (bodies extracted from the applied migrations and patched, not retyped; verification gate asserts the guard string is absent while each function's core markers remain). The flag, review section, KPI count, badge, and ack_merged_member_compliance all stand — visibility and audit only.
**Why:** Process-owner ruling after living with the guard on the live QL8C62 pairs: pre-production acknowledgment of a merged member is compliance bookkeeping and must neither hinder nor trigger allocation. The original requirement said exactly that ("even if it does not interfere"); the gate was over-build.
**Deploy:** TEST only. PROD with the promotion set.

### D-SCHED-02 — Overrun jobs stay on the command grid (2026-08-15)
**What:** Schedule.jsx: module-scope isJobOverrun(job) (ongoing status + scheduled_end in the past); the scheduled-jobs fetch gains a fourth or-branch (scheduled_end before the window AND status ongoing) so fully-past ongoing jobs are fetched; getJobBlockStyle and getJobBlockStyleZoomed extend an overrun job's displayed end to now (let jobEnd + reassignment), which makes the block intersect today and ride the existing carryover left-pin; JobBlockContent shows a red pulsing Clock ("Running past scheduled end") on line 1, covering week/zoomed/mini-timeline surfaces with one edit.
**Third extension point (not in the original plan):** getJobsForMachineDay's WEEK branch duplicates the jobEnd computation and rejects jobEnd < dayStart, and it runs BEFORE getJobBlockStyle. Without the same extension there, every job the new fourth or-branch fetches (end before the window start) was filtered out before reaching the fixed style function — the fetch and the render fix would not have met. The zoomed branch of the same function needed nothing: it delegates to getJobBlockStyleZoomed. Three copies of this jobEnd ladder now exist; a shared resolveDisplayEnd(job, fallbackEnd) is the obvious next consolidation.
**Why:** A job running past its scheduled_end fell off a grid that starts today — invisible while physically occupying a machine. The extended bar is display-only; scheduled_start/end are untouched, so unmerge/reschedule/audit semantics are unaffected. Stale ASSIGNED jobs (never started, window fully past) still vanish — separate surface, logged as an open question.
**Deploy:** TEST only; frontend-only, no migration.
**Files:** src/pages/Schedule.jsx.

### D-NAV-02 — Page survives refresh (2026-08-15)
**What:** App.jsx currentPage initializes from localStorage ('skynet.currentPage', try/catch guarded), persists on every change, and a one-shot effect validates the RESTORED value against role access after the profile loads (schedule/customer_orders/armory/certs fall back to mainframe when blocked; unknown keys pass through; live navigation is never policed — the effect runs once via ref). The effect sits below the canAccess* declarations because it reads them in its dependency array.
**Why:** currentPage was plain state, so refresh reset everyone to Mainframe. localStorage persistence is the minimal fix; converting pages to real routes (deep links, back button) remains a future option and would supersede this.
**Deploy:** TEST only; frontend-only.
**Files:** src/App.jsx.

### D-SCHED-03 — Missed-slot jobs pin to today (2026-08-15)
**What:** Schedule.jsx: MISSABLE_STATUSES (ready/assigned/pending_compliance) + isJobMissedSlot (slot fully elapsed, never started) + getMissedPinSpan — the single source for the synthetic pinned span (today 00:00 + 2h) used by getJobBlockStyle, getJobBlockStyleZoomed, and getJobsForMachineDay's week branch, so the three paths cannot diverge. Fetch gains a fifth or-branch (scheduled_end before the window AND status in the missable set). Pinned blocks render only in today's column, amber + dashed via a getJobBlockColor override (covers every surface), with an amber AlertTriangle ("Missed slot — never started. Drag to reschedule.") in JobBlockContent. Blocks stay draggable (drag-to-reschedule is the recovery action) and openable (popup → Unschedule works). A slot missed earlier today renders at its real position in amber, no pin. Display-only — scheduled_start/end untouched.
**Why:** D-SCHED-02 covered running overruns; never-started jobs whose window passed still vanished — the more dangerous class (forgotten vs attended work). Chosen over auto-return-to-pool so the scheduler sees the miss in machine context and recovers it in one drag.
**Accepted trade-off:** the pin is absolute (today's midnight), not relative to the viewed window, so a pin-eligible job is now absent from PAST-week views where it previously rendered at its real slot — the pin follows the recovery action, not the history. Scrolling back to find where a missed job was originally scheduled no longer works; the job's real scheduled_start/end are still intact in the popup and the database.
**Deploy:** TEST only; frontend-only, no migration.
**Files:** src/pages/Schedule.jsx.

### D-SCHED-04 — Command board live projection (2026-08-15)
**What:** Schedule.jsx: module buildProjection(jobs) — per machine, sorted by scheduled_start: actual_end truncates the bar (machine freed; covers ALL post-machine statuses, fixing finishing-stage jobs holding their row to scheduled_end); ongoing extends to max(scheduled_end, now); queued work pulls forward/pushes back to the chain cursor (floored at now, durations preserved, gaps compressed) but ONLY once the chain has a live anchor — an idle machine's future plan never moves. Consumed via one projectedSpans useMemo by getJobBlockStyle, getJobBlockStyleZoomed, getJobsForMachineDay (day membership follows the projected span), and JobBlockContent (live time line; ⏩ FastForward marker with the original scheduled start in its tooltip; ✓ extends to machine-done with "Machining complete — in finishing"). Missed-slot jobs are excluded from chains (pins occupy nothing) and pins now apply only while today is on screen — past windows render missed jobs at their real slots (resolves the D-SCHED-03 history-browsability note). Display-only throughout: scheduled_start/end untouched; drag, popup, and conflict checks use the real schedule.
**Why:** "The command view should be a live view of what is going on at the kiosks." A job whose machining finished early still blocked its machine row (truncation only covered complete/manufacturing_complete), and the queue behind a freed machine never compressed. Live-anchor gating keeps deliberate future plans stationary.
**Known edge (unfixed, by design of this round):** the queued branch is a plain else — it catches ANY job that is neither ongoing nor actual_end-stamped, including a complete / manufacturing_complete job whose actual_end was never stamped. On a machine with a live anchor such a job would be "pulled forward" to now, i.e. finished work displayed as upcoming. Normal kiosk completion always stamps actual_end, so this only bites on data repaired by hand or by an interrupted completion. One-line fix if it ever shows up: skip terminal statuses in the else branch (treat them like actual_end using scheduled_end). — RESOLVED by D-SCHED-05 (pull-eligibility allowlist).
**Deferred:** minute-tick re-render so "now"-based spans drift between refetches; a per-job pin flag if the scheduler ever needs a queued job exempt from compression.
**Deploy:** TEST only; frontend-only, no migration.
**Files:** src/pages/Schedule.jsx.

### D-SCHED-05 — Projection integrity: allowlist, fixed maintenance, historic windows (2026-08-15)
**What:** buildProjection's queued branch inverts to an allowlist — only MISSABLE_STATUSES production jobs (`!is_maintenance`) are pull-eligible; every other fall-through (terminal rows missing actual_end, queued maintenance windows, exotic statuses) keeps its real span, renders unprojected, and advances the chain cursor. New windowEndsBeforeToday()/getLiveSpan() gate: all four projection consumers (both positioners, the machine-day filter, JobBlockContent) receive null on windows ending before today, so past weeks render the raw schedule everywhere — closing the queued-behind-running history gap the same way D-SCHED-04 closed the missed-pin one.
**Why:** A bare else pulled finished-but-unstamped work forward as future work; planned maintenance is an appointment, not a queue entry (a production overrun colliding into a maintenance window now renders as a real visual conflict — true information); and projection is a live lens that must never rewrite history. To let maintenance compress instead: drop `&& !j.is_maintenance` in the pull branch (sole change).
**Narrower maintenance test than the rest of the file:** the pull branch tests `!j.is_maintenance` only, while Schedule.jsx's own isMaintenanceJob() is `is_maintenance || work_order.order_type === 'maintenance'`. A legacy maintenance row with the flag unset but the WO typed 'maintenance' would still be pull-eligible. Kept narrow deliberately so the documented one-token knob above stays accurate, and because create_maintenance_atomic sets the flag (Schedule.jsx:493 and Mainframe.jsx:312 both find maintenance by the flag alone). Widen to the isMaintenanceJob test if such rows turn up.
**Gate granularity is the WINDOW, not the day:** zooming into a past day inside the current week still projects, because weekDates still contains today. Only paging to a window that ends before today falls back to raw. Consistent between week and zoomed views of the same window.
**Deploy:** TEST only; frontend-only.
**Files:** src/pages/Schedule.jsx.

### D-SCHED-06 — Completed-at-kiosk visuals + started-early pull-back (2026-08-15)
**What:** getJobBlockColor's gray-out (bg-gray-700/50 opacity-60 — the legend's Complete swatch) now also fires on actual_end, so finishing-stage jobs read as done on the machine row; the JobBlockContent ✓ becomes an emerald CheckCircle ("Completed at kiosk — parts in finishing" / "Complete"). buildProjection's ongoing branch starts a running job at actual_start when stamped — started-early work pulls back to reality instead of rendering as future work while it runs (mirror of the D-SCHED-02 overrun gap); 30-minute span floor; the chain cursor still holds at the running job's projected end, so queued work behind it correctly stays put.
**Why:** A machining-complete job wore bright priority green with a faint text check, and a host started ahead of its Sunday slot sat un-pulled at Sunday with scheduled times while physically running — both lies on a board whose whole purpose is now live truth.
**INERT for production jobs — jobs.actual_start is never written by the machine kiosk.** The kiosk stamps setup_start on Start Setup and production_start on Start Production (Kiosk.jsx 1947/2484/2640/3012/3053); the ONLY writer of actual_start anywhere in src/ is Finishing.jsx:1491 (pickup modal, finishing jobs). So the pull-back fires for finishing-stage ongoing jobs and for hand-set rows, and is a no-op for the case that motivated it (a production host started early on Nexturn 4) — that job's real start lives in production_start. Deliberately left as specified rather than widened, because the correct source is a judgement call across three columns with different meanings: in_setup jobs have setup_start but no production_start, and ONGOING_STATUSES includes in_setup / pending_passivation / in_passivation. Options: `j.actual_start || j.production_start` (running work pulls back, setup phase does not), or `j.actual_start || j.production_start || j.setup_start` (the machine is occupied from setup, which matches what the row is claiming). Pick one and the edit is a one-liner.
**Deploy:** TEST only; frontend-only.
**Files:** src/pages/Schedule.jsx.

### D-SCHED-07 — Ongoing start reads the real kiosk stamps (2026-08-15)
**What:** buildProjection's ongoing branch derives a running job's live start through setup_start → production_start → actual_start → scheduled_start (machine-occupancy order). Board fetch already selects *, so no query change.
**Why:** TEST rows proved actual_start is never stamped by the live kiosk flow (in_progress J-000098 carried setup/production stamps only; completed J-000134 had actual_end with actual_start null), making the D-SCHED-06 pull-back read an always-null field. A host started a day ahead of its slot now renders from its true Saturday start instead of tomorrow.
**Scope note:** the read-through covers the ONGOING branch only. The actual_end branch still starts at scheduled_start, so a job that ran early and is now finished keeps a left edge at its planned start while its right edge sits at actual_end — a still-wrong bar for started-early COMPLETED work (J-000134 class). Left alone deliberately: this round's evidence and VERIFY are about the running case, and widening the same read-through to the actual_end branch is a one-line follow-up if the truncated bars look wrong on the board.
**Deferred:** stamping jobs.actual_start at kiosk Start Production going forward (data hygiene — feeds the S5 traveler actual-dates backlog item and cost-model cycle recovery) is a separate kiosk-flow decision, not a board concern.
**Deploy:** TEST only; frontend-only.
**Files:** src/pages/Schedule.jsx.

### D-SCHED-08 — Completed bars carry their real occupancy span (2026-08-15)
**What:** buildProjection's actual_end branch derives the bar's start through setup_start → production_start → actual_start → scheduled_start (same occupancy order as D-SCHED-07's ongoing branch), with a 30-minute floor; truncated still keys on the raw actual_end vs scheduled_end.
**Why:** A started-early-then-finished job rendered half-real — actual right edge, planned left edge — so the bar's width misrepresented the work's true duration on the machine.
**Deploy:** TEST only; frontend-only.
**Files:** src/pages/Schedule.jsx.

### D-SCHED-09 — Completions never rewrite the schedule (2026-08-15)
**What:** Dropped trg_repack_on_completion + its function — a pre-projection DB-side pull-forward that physically rewrote the machine queue on completion into manufacturing_complete/complete (row evidence: every scheduled_start on Nexturn 4 equals its predecessor's actual_end plus seconds). Rebuilt jobs_no_machine_overlap with the predicate inverted to the physically-occupying allowlist (ready/assigned/pending_compliance/in_setup/in_progress), DEFERRABLE INITIALLY DEFERRED as before; post-machine rows (pending_tco, pending_passivation, …) keep their historical ranges without guarding machines they've left.
**Why:** Completing J-000098 fired the repack, which pulled J-000135 into J-000134's still-constraint-active pending_tco window — exclusion violation, completion aborted. Two compression systems existed: the trigger mutating the plan, and D-SCHED-04..08 displaying compression without touching it. One survives: the projection. The schedule is the plan — the permanent record for plan-vs-actual — and the inverted predicate also unblocks scheduling fresh work onto a machine that freed early.
**Deploy:** TEST now; PROD with the promotion set (this migration joins the R1–R4 consolidation).
**Files:** DB only.
### D-JOBMERGE-13 — Compliance acknowledgment surface for merged members (2026-08-15)
**What:** ComplianceReview gains a "Merged — awaiting pre-production acknowledgment" section (flagged members with part/description, job #, WO/customer, qty and host context; Acknowledge → ack_merged_member_compliance RPC, then refetch + onUpdate; amber header styled on the Lot-Change Paperwork pattern, self-hides when empty, loaded and refreshed with the component's other fetches); WO Lookup member rows carry an amber "Awaiting compliance ack" badge beside the cyan Merged chip (flag added to WO_LOOKUP_SELECT); fireAllocationIfHost treats the migration's new allocation raise as a quiet expected outcome — the section is the loud surface.
**Why:** J-000190 merged while pending_compliance and vanished from the review queue with an unreviewed order (Pending Compliance card read 0). The D-JOBMERGE-12 migration preserves the obligation and blocks allocation; this round makes it visible and actionable.
**RPC called with both parameters** (p_member_job_id + p_note: null) rather than the member id alone: it matches D-JOBMERGE-12's documented two-arg signature and works whether or not p_note carries a DEFAULT, where omitting it fails if it does not.
**Deploy:** TEST only, after JobMerge_R5_TEST_Migration.sql. PROD with the promotion set.
**Files:** src/components/ComplianceReview.jsx, src/pages/Mainframe.jsx.

### D-WOLOOKUP-01 — Verified qty cells always show produced/ordered (2026-08-15)
**What:** Every Mainframe job qty render drops the `eq.qty !== job.quantity` condition — any job with verified production shows produced/ordered (613/613), not a bare quantity that hides whether the number is an order or a count.
**Why:** A perfectly-filled host read "613" — indistinguishable from an unstarted job's order quantity. Live find during the combined-run walk.
**Five renders, not three — and the three specified were not the reported ones.** The brief's anchors resolve to the Active Jobs view (assembly-grouped job line and non-assembly job line) and the Standalone Finishing grid, all above the Work Order Lookup modal. The WO Lookup drill-down carries its OWN two qty columns (assembly path and no-assembly fallback, the same pair that carry the merge machine cells and badges), which the three anchors do not reach — so applying only those would have left J-000098 reading a bare "613" in the exact surface the finding came from. All five converted; the deeper-indented WO Lookup pair was edited first, since their blocks are indentation-shifted copies and a shallower anchor substring-matches the deeper site.
**Numbering:** the D-WOLOOKUP series had only suffixed entries (DOCDEL01, ROLLUP01-03, CANCELLED01); -01 is the first free plain number, following the precedent of D-SCHED-01 coexisting with D-SCHED-ZOOM01.
**Deploy:** TEST only.
**Files:** src/pages/Mainframe.jsx.

### D-JOBMERGE-15 — Allocation modal + kiosk paperwork ack + KPI + traveler order (2026-08-15)
**What:** Pending Compliance KPI adds a merged-awaiting-ack count (head-count query, same pattern as lot-change paperwork). Kiosk stale-traveler banner gains "New Paperwork Received" → ack_job_paperwork with the operator in the note (machinist gate from D-JOBMERGE-14). Traveler: Customer Orders section relocates after the routing steps, before Notes — one renderer, every surface. handleAckMergedMember fires fireAllocationIfHost on success, closing the gap where all batches resolved while the acknowledgment guard was up. New MergeAllocationModal (host rows in WO Lookup, scheduler/admin/compliance): distributable total from approved sends, typed member shares capped at ask, host as live remainder, Apply → set_merge_allocation (restamps, reconciles shortfalls both directions, audits with previous vs new, notifies compliance). Host detection is one ids-only query on job_merge_allocations alongside the lookup's existing merge resolution, kept in a Set.
**Why:** The live QL8C62 pair proved the ack guard works and exposed both gaps at once: nothing re-fired allocation after acknowledgment, and the scheduler had no hand on the split — the second explicit request for allocation control. Sales reallocation and short-run redistribution now take one modal instead of a SQL harness.
**Two unverifiable-from-repo dependencies:** D-JOBMERGE-14 is not in this log and set_merge_allocation appears nowhere in Docs/ or src/, so the RPC's parameter shape — p_shares as an array of {job_id, qty} — is taken from the brief and cannot be checked here. If PostgREST rejects the call, the payload shape is the first thing to look at. Same for ack_job_paperwork's machinist gate, which the kiosk button now depends on.
**Layers was missing from Mainframe's lucide import** — the Allocation button would have thrown at render (bundlers do not catch undefined JSX identifiers, so the build was green either way). Added; worth remembering that a clean `npm run build` is not evidence that a new icon resolves.
**Deploy:** TEST only, after JobMerge_R5b_TEST_Migration.sql. PROD with the promotion set.
**Files:** src/pages/Mainframe.jsx, src/pages/Kiosk.jsx, src/lib/traveler.js, src/components/ComplianceReview.jsx, src/components/MergeAllocationModal.jsx (new).

### D-JOBMERGE-17 — Ack informational · allocation from both rows · lookup warning retired (2026-08-15)
**What:** ComplianceReview: the ack→allocate chain and the retired raise's quiet-regex entry are removed; the merged-awaiting-ack section's copy drops every blocking claim ("Informational worklist — allocation is not blocked"). MergeAllocationModal converts to a hostJobId prop and self-fetches the host's basics, so member rows can open the run's allocation across WOs; Mainframe renders the Allocation button on member rows (merged_into_job_id) in both action areas, passing the host id. The WO Lookup traveler-outdated badge, both Ack affordances, and handleAckPaperwork are removed — staleness lives at the kiosk (banner + New Paperwork Received) and in Compliance Review; stamps and every other surface unchanged.
**Why:** Process-owner ruling after living with D-JOBMERGE-12/-15: the acknowledgment is compliance bookkeeping, not a gate — it must neither hinder nor trigger. The member J-000144 had no path to the run's allocation because its host lives on another WO. The lookup warning duplicated surfaces that already own the message.
**Mainframe no longer imports lib/jobMerge at all** — removing the badge, both affordances and the handler left isPaperworkStale and ackJobPaperwork with zero references, so the whole import line went. Both helpers remain live elsewhere (Kiosk banner, ComplianceReview); nothing in the lib was orphaned.
**The four batch/job allocation triggers are untouched** (handleApproveBatch accept + reject paths, handleApproveJob, handleApproveAndPrint) — only the ack-path trigger from D-JOBMERGE-15 came out, so a host still allocates the moment its last batch resolves.
**Deploy:** TEST only, after JobMerge_R6_TEST_Migration.sql. PROD with the promotion set.
**Files:** src/components/ComplianceReview.jsx, src/components/MergeAllocationModal.jsx, src/pages/Mainframe.jsx.

### D-DEPLOY-01 — PROD promotion of the 2026-08-15 set (2026-08-15)
**What:** Single-transaction replay of the seven TEST-verified migrations in application order (D-JOBMERGE-01/-03/-07, D-SCHED-09, D-JOBMERGE-12/-14/-16) with per-section gates plus a master census gate; pre-flight checklist (absence of new objects, presence of prerequisites) + archived rollback material (repack trigger/function, old overlap constraint, status CHECK) + mandatory status-array diff before the run. Frontend: one branch carrying merge R2–R6, D-SCHED-02..08, D-NAV-02, and the day's UI corrections, merged after DB COMMIT.
**Why:** Migrations before code, one motion, PROD never partial.
**Deploy:** PROD.

### D-AISCHED-01 — Historical run-stats layer (2026-08-15)
`part_machine_stats` + `family_machine_stats` views over jobs actuals (endpoint math; 5-min/30-day sanity fence excludes data-correction artifacts); `parts.family_key` added, NULL until the seeding pass — the family view returning 0 rows is expected and harmless; `v_schedule_estimate_accuracy` establishes the pre-AI baseline retroactively (weekly MAPE + on-time rate). Views-as-API: React reads views, never raw aggregates. Zero new data capture. finishing_sends waypoint-derived intra-run rates (the D-COST-31 method) are Phase 2. Migration: `Docs/migrations/2026-08-15_ai_scheduler_phase1.sql`, TEST→PROD.

### D-AISCHED-02 — AI proposal rail (2026-08-15)
`schedule_ai_runs` (full snapshot stored per run for audit) + `schedule_ai_proposals` with open/applied/dismissed/superseded/expired lifecycle; dismissal reasons captured as the preference-loop substrate. The Edge Function writes nothing; the authenticated scheduler's client inserts and updates under RLS via `_schedule_ai_gate()` (NULL-uid pass, `user_has_role(uid, VARIADIC roles)` for admin/scheduler, anon revoked — the `_rm_forecast_gate`/`_job_merge_gate` pattern). Staleness per Matt: NO wall-clock expiry (April's day is interrupt-driven; suggestions must wait for her). A proposal greys presentationally when its target machine's queue fingerprint (`evidence.queue_fp`, ordered job ids at snapshot time) no longer matches live; open proposals from a previous calendar day sweep to `expired` on panel open; a new run supersedes the runner's still-open proposals.

### D-AISCHED-03 — schedule-advisor Edge Function (2026-08-15)
`claude-fable-5` with extended thinking (budget 8000 / max_tokens 16000), single-shot snapshot→envelope, strict-JSON-by-prompt with defensive fence-strip parse, JWT + multi-role gate (admin/scheduler via profiles.role OR roles[]), reject-before-spend (shape + 1 MB cap + empty-pool short-circuit), reuses the existing ANTHROPIC_API_KEY secret. Covenants: unassigned-only, capable-machines-only (also ENFORCED server-side — violating placements are dropped and noted in data_gaps), evidence basis on every placement with estimate_only capped at medium confidence, pending_compliance treated as the NORMAL pool state (scheduling precedes compliance review by design — never caveated), shortfall jobs risk-listed not placed, drift-corrected durations declared, policies honored with conflicts surfaced. Extraction functions stay on claude-sonnet-4-6.

### D-AISCHED-04 — Uncle Bob advisor panel (2026-08-15)
Right-side drawer in Schedule.jsx behind `FEATURES.AI_SCHEDULER`; UI label "Uncle Bob" (T2's reprogrammed T-800 — takes orders from a human, learns as it goes; header Help popover explains the name and links the scene: https://www.youtube.com/watch?v=bOLGXgZ8ffE). All code names stay `schedule-advisor`. Apply routes the proposal through the EXISTING unified ScheduleJobModal (prefilled machine/date/time) → applySchedule → reschedule_with_cascade, so the human is scheduled_by and all live validation applies; applied_with_edits is detected by comparing the saved machine/start against the proposal. Dismiss captures an optional reason. Standing rules (scheduler_policies) managed in the panel footer, injected into every snapshot. Autonomy Level 0 of the agreed ladder; promotion to L1+ gated on v_schedule_estimate_accuracy, acceptance rate, and on-time rate vs the pre-AI baseline.

### D-AISCHED-05 — Part family nomenclature (2026-08-15)
family_key format `<stem>-<MATCODE>` (SK2600-SS style, Matt-approved). Stem rule R1 (alpha prefix + series token, S-number internal). Material precedence: description keyword > section header keyword > prefix inference (section headers bleed across sub-tables). Corrections from Matt's review of proposal v0.1→v0.3: ZG is ALUMINUM, never titanium — Skytanium is Skybolt's trade name for 7075 aluminum (interchangeable); ZG alloy is 6061 or 7075 with 7075 the Skytanium default; the word "titanium" appears nowhere in the Rev 81 pricing guide. R-token = Ring Handle: the ringed stud is a DIFFERENT machined part (ring is purchased and assembled in), so ring variants get their own family (`<stem>R-<MAT>`, 7 families / 106 parts) and purchased retaining rings are excluded from machining stats. -B suffix = externally anodized: a FINISH flag that rides along (finishing-send routing signal), never a family split. Workbook: SkyNet_Part_Family_Proposal_v0_3.xlsx (498 families / 2,465 sellable PNs). Seeding against the parts table export is a separate guarded pass, TEST first — recorded when it runs.

### D-AISCHED-06 — Shift handling for the advisor (2026-08-15)
No shift_calendar table: the person who would maintain it (the scheduler) is exactly the person never present for off-hours work, so it would rot. The advisor plans inside the hardcoded 07:00–16:00 Mon–Fri window and leans on jobs.requires_attendance — unattended jobs may run past the window (lights-out), attended may not — and states the assumption in every briefing. Observed actual worked hours derived from kiosk_sessions is the Phase 2 upgrade path (observed beats declared).

### D-AISCHED-07 — Streaming transport for schedule-advisor (2026-08-15)
**What:** schedule-advisor now streams SSE instead of returning a buffered response: heartbeat comments every 10s while the model generates, then exactly one `result` event carrying the same { model, envelope, usage } shape, or one `error` event. Fast-path failures (auth, validation, empty pool) remain plain JSON. The panel replaced supabase.functions.invoke with a fetch-based SSE reader (JWT + anon key headers, AbortController outer guard at 300s); everything downstream of the envelope is unchanged. Function still writes nothing (D-RMF-05); covenants and server-side enforcement unchanged.
**Why:** First live TEST runs failed with browser 502s. Function logs showed workers alive ~200s at 44ms total CPU before `EarlyDrop` — pure network wait on a Fable 5 extended-thinking generation that legitimately runs 2–4 minutes on a real board. A buffered response cannot outlive the gateway window; moving bytes can. Ceiling is now the runtime's own wall clock; if a board ever outgrows that, the Phase 2 background-run pattern (respond-then-persist) is the escape hatch.
**Files:** supabase/functions/schedule-advisor/index.ts, src/components/schedule/AIAdvisorPanel.jsx.

### D-AISCHED-08 — Fable 5 thinking API shape (2026-08-15)
**What:** The schedule-advisor Anthropic request now sends `thinking: {type:"adaptive"}` + `output_config: {effort:"high"}` instead of `thinking: {type:"enabled", budget_tokens:8000}`. Constant THINKING_BUDGET replaced by THINKING_EFFORT ("high").
**Why:** First post-streaming run returned Anthropic API 400: "thinking.type.enabled is not supported for this model. Use thinking.type.adaptive and output_config.effort" — claude-fable-5 (Mythos-class) scales its own thinking to the problem via adaptive + effort rather than a fixed token budget, which also fits a scheduler whose boards vary in complexity. Supersedes the "budget 8000" detail in D-AISCHED-03 on this point only; everything else in -03 stands. The streaming transport (D-AISCHED-07) surfaced the API error in-band within seconds — working as designed.
**Files:** supabase/functions/schedule-advisor/index.ts. Function redeploy only; no frontend or database change.

### D-AISCHED-09 — Capability sources & precedence (2026-08-15)
**What:** Machine eligibility for the advisor is now the union of three sources, in order of authority: (1) HISTORY — part_machine_stats rows prove capability, durations row or not; (2) STANDING RULES — an active scheduler_policies entry naming a part/family on a machine grants capability, model-mediated: evidence.basis "policy" with the rule quoted verbatim in evidence.policy, server-verified by literal containment of the machine's name or code in the rule text, confidence capped at medium without run history; (3) MASTER DATA — part_machine_durations, demoted from gatekeeper to suggestion. The snapshot builder unions sources 1+2's data structurally (capable_machines[] entries carry sources[], est_minutes_from_history) and sorts history-first; the job's own jobs.estimated_minutes now rides in the snapshot as the machine-agnostic fallback. Duration precedence: history-derived > master-data scaled > job estimate (uncorrected, said so) > none (scheduler sets the time). Part-number-first identification is baked into the envelope schema (risks and placements carry part_number; briefing/rationale lead with it) — the ad-hoc "use the part number" standing rule can be retired.
**Why:** First live run: seven pool jobs, sparse master data, zero placements — history was structurally invisible (attached only inside durations entries) and an explicit standing rule ("QL4-BASE can go on Carlos' machines (Mazak 1 and 2)") could not grant capability; the server guard would have deleted a compliant placement. Matt's directive: history > standing rules > master data. This also removes master-data backfill as a prerequisite: parts with prior runs unblock automatically; true first-timers are covered by one standing rule or April's manual path (the agreed new-part arrangement).
**Files:** src/lib/scheduleSnapshot.js, supabase/functions/schedule-advisor/index.ts, src/components/schedule/AIAdvisorPanel.jsx. No database changes.

## D-RPT-01 — Reports module is registry-driven with universal view / restricted export (2026-08-17)
Reports live in a `public.reports` registry table; each report is backed by a dedicated Postgres view named in `source_object`. Adding a report is a single migration (registry row + view) with no frontend redeploy. Every authenticated role can view every report whose `view_roles` is empty; CSV export is restricted to `export_roles` (Phase 1: admin, president, scheduler) via `canExportReports()` in `src/lib/roles.js`. Registry writes have no RLS policies by design — migrations/service role only. anon is fully revoked on the registry and all report views. Kiosk routes never mount the authenticated header, so no kiosk suppression work exists.

## D-RPT-02 — Report CSV output contract is frozen (2026-08-17)
The open-demand CSV replaces a file consumed by the weekly scorecard automation, which fingerprints files by header signature (`co_number, fishbowl_so, customer_po, customer_number`). Contract: headers come verbatim from the registry `columns` array (exact snake_case, exact order); dates are bare `YYYY-MM-DD`; nulls are empty strings; UTF-8 with NO BOM (fingerprint must start at byte 0); numbers raw; RFC 4180 quoting. Any column rename is a coordinated change with the weekly scorecard, never unilateral.

## D-RPT-03 — scheduled_finish cast ::date in report_open_demand (2026-08-17)
Sole deviation from the validated `Skybolt_SkyNet_Backlog_v1_1.sql`: `MAX(j.scheduled_end)` is timestamptz, which PostgREST serializes with a `T` and offset, violating D-RPT-02. The view casts it `::date`. All other joins/columns ported verbatim — several encode hard-won corrections (customer name via `customers`, jobs excluding `cancelled`/`merged`).

## D-RPT-04 — Report runner paginates to exact count and fails loudly on mismatch (2026-08-17)
PostgREST caps responses (~1000 rows), and a silently truncated CSV feeding the cash forecast would understate demand invisibly. The runner takes an exact count first, pages with `.range()` under the registry's `order_by` spec (stable ordering is required for correct pagination — the view's own ORDER BY does not survive LIMIT/OFFSET), retries once on drift, then throws with an explicit "do not use partial results" error surfaced in the UI. An empty result renders as an explicit "0 rows" state, never a blank table.

## D-RPT-05 — Uncle Bob Reports Advisor deferred to Batch B (2026-08-17)
An AI advisor panel in the report result view (admin/president/scheduler), reusing the schedule-advisor pattern (dedicated Edge Function, claude-fable-5, SSE + heartbeat). Deferred so Batch A ships independently. Deterministic summaries (`summarize()` in `src/lib/reports.js`) are the Phase 1 "what is this telling me" layer and remain the fallback.

## D-RPT-06 — Uncle Bob Reports Advisor is read-only commentary, gated to export roles (2026-08-17)
The Reports result view gains an AI advisor panel backed by a `report-advisor` Edge Function (claude-fable-5, adaptive thinking, high effort, SSE with 10s heartbeats per D-AISCHED-07). It mirrors the schedule advisor: the function writes nothing, and the authenticated client owns all `report_ai_runs` audit inserts. The advisor proposes nothing and has no Apply path — it reads and comments. Visibility is gated to REPORT_EXPORT_ROLES (admin, president, scheduler), narrower than report view access, because AI commentary on customer and backlog data is a different disclosure than the numbers themselves. `report_ai_runs` is append-only (SELECT+INSERT policies on own rows only, no UPDATE/DELETE) per the AS9100 traceability posture.

## D-RPT-07 — Advisor envelope carries aggregates plus a bounded sample, never the full result set (2026-08-17)
`buildReportEnvelope()` sends computed aggregates (totals, groupings, past-due and no-work-order breakouts capped at 15 lines each, top-10 rankings), the deterministic `summarize()` output, and an evenly-spaced sample of at most 40 rows with the sample's own provenance note. The full result set never leaves the browser. This bounds cost and exposure, and it makes the model reason over computed truth instead of re-deriving totals from raw rows. The system prompt requires the model to treat unsampled rows as unknown and to declare such limits in `data_gaps`.

## D-RPT-08 — The advisor is strictly additive to the frozen CSV path (2026-08-17)
`src/lib/reportAdvisor.js` imports only `summarize()` from `src/lib/reports.js`; it never touches `toCsv`, `runReport`, `reportFilename`, or `downloadCsv`, and advisor state never gates the Download button. An advisor failure surfaces an inline error that explicitly states the report and export are unaffected. The deterministic summary cards remain the Phase 1 "what is this telling me" layer and render independently of whether the advisor has been run, succeeded, or is visible to the user at all. Rationale: the weekly scorecard depends on the CSV; nothing experimental may sit in its path.

## D-RPT-09 — Advisor system prompt encodes the make-vs-buy caveat as a hard rule (2026-08-17)
SkyNet tracks manufactured demand only; purchased parts never receive a work order and correctly never appear in these reports. An AI reading backlog data will otherwise reliably misread that absence as a data-quality gap. The `report-advisor` system prompt names this as the single most important thing to get right and forbids characterizing SkyNet's backlog coverage as a problem. It also carries the shop's part-number-first standard and the fact that `pending_compliance` is a normal pre-scheduling state. Interpretation of coverage gaps belongs downstream in the weekly scorecard, not in this panel.

## D-SCHED-10 — Parts/Day Duration Calculator (Aug 18, 2026)

Step 3 of the Schedule modal gains a "Parts per day" input. Duration = qty ÷ rate × 24h × 1.10 (+10% buffer), rounded up to the whole hour (min 1h), written into the existing days/hours fields. Rate auto-suggested from up to 10 most recent completed runs of the same part using jobs.time_per_unit (minutes/piece, production_start → actual_end), weighted by pieces (good_pieces, fallback quantity). Suggestion prefers runs on the selected machine; falls back to all machines with the basis labeled in the UI. Prefill fires on entering Step 3 only when the parts/day field is empty; it never overwrites an existing non-zero duration (edit mode safe). Rate is fully editable; manual days/hours entry unchanged and authoritative. Client-side only — no schema changes.

## D-SCHED-11 — View-Only Command Access for Customer Service (Aug 19, 2026)

customer_service added to canAccessSchedule (App.jsx). Read-only enforcement rides the existing president/viewer pattern: canEditSchedule remains admin/scheduler only, and Schedule.jsx gates all mutations (drag/reschedule, maintenance, merge/unmerge, split, AI scheduler actions) on the canEdit prop. Nav button, D-NAV-02 restore validation, and page mount all key off canAccessSchedule, so no other changes were required. Primary-role check only — a user with customer_service in roles[] but a different primary role does not gain access. No schema or RLS changes shipped; RLS SELECT coverage for customer_service verified separately on TEST.

## D-SCHED-12 — Close Read-Only Write Leaks in Command (Aug 19, 2026)

D-SCHED-11 testing revealed the president/viewer read-only pattern had ungated write paths in Schedule.jsx, present since before customer_service was added: the unified ScheduleJobModal render, the unscheduled-pool Schedule button, list-view row click/drag (edit mode), and the job detail panel action buttons (maintenance Edit Schedule/Close; regular Edit/Adjust End Date/Unschedule). All are now gated on canEdit, with the modal render itself gated as a master guard so any future ungated opener fails closed. Drag handlers (handleDrop, handleListDropOnMachine) and toolbar actions were already guarded. Client-side enforcement only — RLS write policies do not distinguish scheduler roles from other authenticated roles; server-side hardening deferred to a dedicated RLS round (candidate: role checks in reschedule_with_cascade and jobs UPDATE policies).

## D-SCHED-13 — Parts/Day Retrofit in Adjust End Date Modal (Aug 19, 2026)

The D-SCHED-10 parts/day calculator is now available in the Adjust End Date modal so already-scheduled jobs can be re-durationed from history without unscheduling. Typing a rate computes end = locked start + qty ÷ rate × 24h × 1.10 (ceil to hour, min 1h) and writes it into the New end field; all existing modal machinery (cascade preview, D-DATE-03 late warning, running-job future-end validation, change_end_with_cascade RPC) operates on the computed value unchanged. Throughput logic extracted to src/lib/scheduling.js (fetchPartThroughputRuns, computePartsPerDaySuggestion, partsPerDayToMinutes) and ScheduleJobModal refactored onto the same helpers — single source of truth, no drift. Suggestion basis for the end-date modal is the job's assigned machine (falls back to all machines, labeled). No auto-apply in this modal: the field starts empty and the suggestion is display-only, since retrofit is a deliberate human pass.

## D-RPT-10 — Job Efficiency (Daily) Report (Aug 19, 2026)

New registry-driven report (slug job-efficiency, view report_job_efficiency): one row per job currently in_progress or completed in the last 7 days, with part_number first. Current parts/day = finishing-sends total over elapsed run time for running jobs (suppressed under 1h elapsed), or 1440 / time_per_unit for completed jobs. History = piece-weighted average of up to 10 most recent prior completed runs of the same part, per-row LATERAL with self-exclusion — the identical basis to the D-SCHED-10/13 scheduler suggestion. variance_pct = (current − history) / history; sorted worst-first, no-history rows last (these are the machinist-estimate candidates). View runs as owner (matches report_open_demand posture); granted to authenticated, revoked from anon/PUBLIC. Registry insert idempotent via ON CONFLICT (slug). All roles view; admin/president/scheduler export. Client summarizer added to SUMMARIZERS. SQL applied manually via Supabase SQL Editor (TEST → verify → PROD), never via CC.

## D-SCHED-14 — Current Parts/Day on Production Dashboard (Aug 19, 2026)

Active Jobs rows on the Production Dashboard show the current run rate (≈ N/day) beside finished/target quantity. Rate = finished × 86,400,000 / elapsedMs, where finished is the dashboard's existing pieces-passed-finishing metric (finishing_complete verified_count + missed_production_entries) and elapsedMs runs from production_start. Suppressed for in_setup, under 1h elapsed, or 0 pieces — same junk-rate guard as the D-RPT-05 report's running-job calc. Display-only; no schema changes. Known basis nuance: the report's running-rate uses total finishing_sends quantity while the dashboard uses verified finishing_complete counts + missed entries, so the dashboard reads slightly more conservative mid-run; both converge at completion.

## D-RPT-11 — Uncle Bob Envelope for Job Efficiency Report (Aug 19, 2026)

Slug-specific SAMPLE_COLUMNS and AGGREGATORS blocks added to src/lib/reportAdvisor.js for job-efficiency, replacing the generic fallback envelope. Aggregates carry computed truth per D-RPT-07: variance distribution (median/min/max) with single-run-history count as the thin-history caveat, behind-pace jobs (variance ≤ −10%, up to 15 full lines), well-ahead jobs (≥ +25%, up to 10 — retrofit candidates), the no-history worklist (up to 15, with the observed-current-rate count flagged as machinist-estimate seeds), and history-but-no-current-rate rows (data gaps). All line objects lead with part_number. No edge-function changes — report-advisor is envelope-generic and report_ai_runs.report_slug is free text. Bounded payload preserved: aggregates cap at 15/10/15/10 lines plus the standard 40-row evenly-spaced sample.

## D-RPT-12 — Sales Reports: Drop Calendar (8wk), By-Part Rollup, WIP Near-Term Supply (Aug 19, 2026)

Three registry-driven reports from the 18 Aug handoff: v_report_production_drop_calendar (linear Mon–Fri spread of remaining qty across the scheduled window — deliberately no S-curve), v_report_drop_calendar_by_part (aggregates the collapsed view, never re-joins the week spread — the §7.1 row-multiplication trap), and v_report_wip_near_term_supply (pending_tco deliberately excluded per §6.2). All views WITH (security_invoker = on) plus v_report_week_labels. View SQL verbatim from the validated handoff; applied manually via SQL Editor. Registry: slugs drop-calendar-8wk / drop-calendar-by-part / wip-near-term; view_roles and export_roles = admin/president/scheduler/customer_service/purchaser (handoff Q1: roles[]-aware via userRoles). Handoff header contradiction resolved: CSV keeps stable wk1..wk8 names (automation contract, D-RPT-02 philosophy); UI headers show W/E dates from the labels view; acceptance criterion 6 amended accordingly. Reports.jsx gains per-slug presentation config: standing notes + pull timestamp, customer/salesperson filter (filtered CSV gets _filtered filename suffix), client-side column sort, and row highlights (risk/late; past-due/parked). Deterministic summarizers include the §7.1 integrity check (qty_remaining must equal total_in_window; mismatch renders a do-not-quote failure narrative). Known limitation, accepted: with current authenticated-read RLS on base tables, security_invoker does not yet yield zero rows for excluded roles at the API layer — role gating is registry/UI-level until the deferred base-table RLS round (see D-SCHED-12); acceptance criterion 2 amended. TEST-first waived by Matt for this round (additive read-only); pushed to main and test directly. Excluded-role zero-rows, finishing_lag_days measurement, unassigned-jobs exception report, and Open Machine Capacity (§9) deferred.

## D-SCHED-15 — Scheduling onto DOWN Machines (Aug 19, 2026)

DOWN/OFFLINE machines are now selectable in Step 1 of the Schedule modal so their queues can be pre-loaded during expected-short downtime (driver: BM-2 air line repair, Aug 19). Silent hard-disable replaced with informed consent: red styling and a "DOWN — schedulable" badge in Step 1, plus a red warning banner in Step 3 before confirm stating that dates hold only once the machine runs. This also resolves a path inconsistency: drag-drop always allowed dropping onto DOWN machine rows (no guard in handleDrop) while the click path blocked them — both paths now behave identically with the same warning. Display-only change; scheduling writes are unchanged. Consistent with the D-RPT-12 drop calendar, which already flags jobs on non-running machines as risk rows ("dates hold only once the machine runs"). Note: the modal's DOWN detection uses machines.status only; Schedule.jsx's richer isMachineDown (ongoing downtime logs + active unplanned maintenance) is not consulted in the modal — acceptable, since those sources normally set machines.status via the kiosk flow.

## D-PARTHIST-01 — Armory Part History Modal (Aug 19, 2026)

Part cards in the Armory Products and Parts tabs gain an un-gated History button (visible to all roles with tab access, including read-only president/viewer) opening PartHistoryModal: full job history for the part (jobs.component_id key, most recent 300 with exact count and truncation flag), summary tiles (jobs/completed/open counts, good pieces, scrap with rate, historic parts/day), a per-machine run-rate breakdown, and a traveler-style print window. Rate basis is the D-SCHED-13 shared helper (computePartsPerDaySuggestion from lib/scheduling): completed runs with time_per_unit > 0, standalone-finishing jobs excluded; merged/cancelled jobs display with badges but never enter totals. Per-run display rate is 1440/time_per_unit. Read-only feature, no schema or RLS changes. Purchased parts show a forward-looking note — PO/receiving history is a planned future round once purchasing data lands.

## D-PARTHIST-02 — Part History Status Basis and Derived Run Rates (Aug 19, 2026)

D-PARTHIST-01 gated all Part History metrics on status = 'complete', which in SkyNet means past TCO, not past the machine. Jobs sitting at manufacturing_complete or pending_tco — the normal resting state for weeks — fell out of both the completed filter and ACTIVE_STATUSES, so SK203C22B reported 0 completed, 0 good pieces, and no run rate against ~37,000 real pieces. Basis corrected to PRODUCTION_DONE_STATUSES (manufacturing_complete through complete, plus incomplete, which represents real pieces made on a short-closed job); IN_FLIGHT_STATUSES covers pending_compliance through in_progress; cancelled and merged display with badges but never enter totals. This realigns the modal with fetchPartThroughputRuns, which gates on time_per_unit > 0 and never filtered on status — the D-PARTHIST-01 status gate was an addition on top of the shared basis, not part of it.

Second defect: time_per_unit is written only by the kiosk completion path and only when production_start is present, so legacy and alternate-path rows carry NULL and showed no rate despite having full production dates. Added effectiveTimePerUnit, which prefers the recorded value and otherwise derives it from production_start → actual_end ÷ good_pieces — the identical calculation Kiosk.jsx performs at completion, so no new basis is introduced. Derived rates render with a ~ prefix and a tooltip, and the summary caption reports how many of the weighted runs were derived. Runs with no production_start remain unrated and are surfaced with a count plus a pointer to the kiosk job-history admin edit, which recomputes time_per_unit when the dates are filled in. Weighted average still comes from computePartsPerDaySuggestion; runs are normalised before being handed to it so the helper stays single-source-of-truth. Frontend only, no schema or RLS changes.

Open follow-up: the D-RPT-10 job-efficiency view (report_job_efficiency) and its LATERAL history subquery may carry the same status assumption. Not verified in this round; flagged for a dedicated pass.

## D-PARTHIST-03 — Amendment to D-PARTHIST-02: Derived Rate Denominator (Aug 19, 2026)

D-PARTHIST-02 describes effectiveTimePerUnit as "the identical calculation Kiosk.jsx performs at completion." Precise: identical to the completion path (Kiosk.jsx:3592-3620), which divides by finishingTotal and writes that same value as good_pieces in the same update — denominator and good_pieces are one variable. Not identical to the admin-edit path (Kiosk.jsx:3799-3805), which divides by good + bad. No practical divergence: the admin edit writes a non-NULL time_per_unit whenever its guard passes, so rows it has touched never reach the derived fallback, which fires only on NULL time_per_unit. Denominator held at good_pieces — it matches the completion path and the computePartsPerDaySuggestion weighting basis, so changing it to good + bad would introduce drift from the shared helper. Raised by CC during D-PARTHIST-02 verification.

### D-JOBMERGE-18 — Documents attachable from the merged-ack card (2026-08-19)
**What:** The "Merged — awaiting pre-production acknowledgment" section in
Compliance Review gains an Add Document action, reusing AddJobDocumentModal
(typed picker + opt-in save-to-part) rather than a second upload path. An
attached-document count renders on the card once one or more documents exist.
**Scope:** The document attaches to the MEMBER job, not the host. The member
keeps its own work order, customer, and cert path after a merge; the host is
resolved for display only. A document on the host would not follow the member's
paperwork.
**Not a gate:** Acknowledge remains independent of whether a document is
attached. D-JOBMERGE-13 defines this section as informational and explicitly
does not block allocation; requiring a document would change that contract.
Revisit if compliance wants the merge itself to carry a documentation
obligation.
**No schema change:** job_documents already carries every field used.

## D-LOT-01 — In-Place Material Lot Correction (Aug 20, 2026)

A mis-keyed material lot had no supported correction: lotAllowed blocked a differing lot on both kiosks and both add paths were write-once, leaving Remove + Add as the only route. handleRemoveMaterial hard-deleted the job_materials row with no awareness that its lot was already embedded in the minted PLN, so the PLN kept the wrong lot and propagated it to finishing_sends and a printed traveler (J-000188: PLN-2580-260818-0001 against material lot 2605, undetected for two days; the delete also stranded a phantom material_usage charge against the wrong lot, double-counting consumption).

Correction is now a first-class action via the correct_job_material_lot RPC (SECURITY DEFINER, granted to authenticated, revoked from anon/PUBLIC), which atomically rewrites job_materials.lot_number, the PLN's lot segment (anchored on the -YYMMDD-NNNN tail so the date and sequence are preserved and hyphenated lot numbers survive), every finishing_sends row carrying the old PLN or old material lot, and re-points material_usage at the correct receipt using the D-INV-01 FIFO rule, logging an inventory_warning when no receipt matches. Both kiosk mismatch modals become a fork rather than a dead end: correct the typo, or declare a physical lot change and route to the existing Switch Lot split. The distinction is the machinist's to make — a typo means the bars never changed and the PLN should follow the correction, while a physical change means real pieces were cut on lot 1 and must keep their own PLN; no rule can infer which from the data. The rack kiosk offers correction only and directs physical changes to the machine, where good pieces can be declared. handleRemoveMaterial is now blocked once a PLN exists, closing the path that caused this.

Deliberately not done: material_loads is left untouched by the correction. It is the append-only record of what was actually keyed at the rack, its lot_number is not rendered in any UI, and rewriting it would destroy the evidence that a correction occurred — the audit_logs material_lot_corrected entry carries the before and after instead.

## D-LOT-02 — Multi-Load Guard, Silent Pre-PLN Correction, Fork De-Emphasis (Aug 20, 2026)

Field review of D-LOT-01 (RQ-57753498: 8 loads on lot 2631 over two weeks, 4,025 accepted pieces) showed the one-tap typo correction was offered in a state where it could not be legitimate: with one recorded load all material is a single physical batch and a lot correction is coherent regardless of whether the typo claim is true, but with multiple loads bars were drawn against the lot identity repeatedly and a retag rewrites confirmed history. Correction is therefore offered only when the job has at most one material_loads row; at two or more, both kiosk modals present only the switch path plus an admin-escalation note. Enforcement lives server-side in correct_job_material_lot v2 (v1 signature dropped — adding a parameter would otherwise create a second overload): post-PLN, more than one load raises unless p_force is passed by admin/compliance (checked inline against profiles.role and roles[]) or auth.uid() is NULL (SQL Editor — the deliberate escalation path). The guard applies only once a PLN exists; pre-PLN corrections always pass, because before minting nothing downstream carries the lot.

That same pre-PLN property drives the second change: a differing lot entered before production start is now corrected silently through the RPC (audit entry still written) with staging or the add continuing uninterrupted — typo versus physical change is a distinction without a difference until a PLN exists, honoring the no-stoppage principle with zero prompts in the common early-catch case. At the rack this required patching the stale local existing.lot_number after the RPC, since the write-once update reuses the pre-fetched object and would otherwise resurrect the old lot. hasPln was removed from the rack mismatch state as definitionally true post-edit. The fork's filled primary button was also removed — both options are equal-weight bordered buttons so neither reads as the default continue — and the D-LOT-01 removal-guard alert now describes the real recovery route (Add Material with the correct lot) instead of a nonexistent row button. The row-level Correct Lot affordance remains deferred. material_loads undercounting (dropped fire-and-forget writes, D-LOT-01 forensics) fails safe here: an undercount can only widen the correction window, never block a legitimate one, and the guard is advisory UI plus a force-able server check rather than a traceability record.


## D-STKREQ-01 — Warehouse Stock Requests: a second demand source, not a fake customer (Aug 20, 2026)

The warehouse (Assembly role, signed-in PCs) needed a way to ask for a build of a stock part they'd run out of. Modeling the warehouse as a customer was rejected: customer_orders requires a Fishbowl SO (co_number is CO-<customerId>-<fishbowlId>), feeds v_sales_weekly_report_v3 / v_sales_mts_production / report_open_demand and weekly Fishbowl reconciliation, and its lifecycle ends in shipment. A stock request never ships and is not a sale. Instead, stock_requests is a separate table (part, qty, priority, mandatory reason, status open → allocated → complete / cancelled, nullable work_order_id) whose open rows are merged into the Demand tab as amber STOCK lines beside CO lines, grouped by part, so April sees customer demand and warehouse demand for the same part on one row and builds one WO. Consumption reuses the existing stock model: selected requests pre-fill additionalForStock (→ work_orders.stock_quantity), zero CO lines still derives order_type='make_to_stock', and allocate_stock_requests links the rows after the WO exists. Lifecycle follows the WO via a status trigger: complete/shipped/closed closes allocated requests; cancelled returns them to open (mirrors the CO-allocation release semantics). Reason is mandatory at both layers — the modal blocks submit and create_stock_request raises on a blank — because the database doesn't trust the form (same discipline as kit_assign_and_log). Roles: create/cancel admin+assembly (requester may cancel own while open), allocate admin+scheduler, all via SECURITY DEFINER RPCs with NULL-uid SQL-Editor passthrough; table has SELECT-only RLS and no direct writes. Assembly gained read-only access to the Customer Orders page (canAccessCustomerOrders migrated to hasRole per D-MROLE-02) so the button lives where demand lives; CAN_EDIT_ROLES unchanged, so assembly sees no CO write controls. April may still edit the stock qty in Create WO after the request pre-fills it; the request is allocated regardless (informational semantics, per D-JOBMERGE-13). Deferred: finished-goods min-stock rules that auto-raise a request (the D-REPLEN-01 analogue), and surfacing allocated-request quantity on the WO detail. Migration: Docs/migrations/2026-08-20_stock_requests.sql (TEST 2026-08-20).

**Implementation notes (deviations from the round brief, both narrow):** (1) DemandView memoizes the CO-line and stock-request splits rather than filtering inline in the CreateWorkOrderModal props. The modal's demand-prefill effect depends on both arrays, so a fresh array identity on every DemandView render would re-run the effect and reset selectedAssemblies — wiping any quantity April had already edited in the open modal. The existing preselectedCoLines was memoized for exactly this reason. (2) The allocate-failure branch in CreateWorkOrderModal sets the modal's error banner and then calls onSuccess?.(), which unmounts the modal in DemandView — so that message is not actually reachable by the user today. The stale-request case is still safe (the RPC raises rather than double-allocating, and the WO is already committed), but making the warning visible needs the parent's setActionStatus, i.e. threading a warning argument through onSuccess. Left as specified; tracked here rather than silently redesigning the shared modal's callback contract.

### D-JOBMERGE-19 — Run surfaces show combined targets; order surfaces unchanged (2026-08-19)
**What:** Production Display active rows and Mainframe MachineCard tiles now
compute their denominator as jobs.quantity + SUM(active job_merge_allocations
.requested_qty), matching the Kiosk's getRunTarget semantics. Merged rows get
a cyan denominator + explanatory tooltip. The Production Display dropdown
gains a "Combined run" table (host + members with WO/customer/qty) above the
CO allocation table, lazy-loaded on expand for hosts only.
**Principle:** order surfaces (WO rows, CO tables, member job rows) keep
per-job/per-order quantities; run-progress surfaces show the combined target.
The numerator on these surfaces was already combined — all production and
finishing for a merged run lands on the host job — so the mismatched
denominator overflowed the bar and misstated pacing.
**Data path:** bulk ids-only allocation queries mirroring each surface's
existing rollup pattern (two-level nesting rule); no schema change, no RPC
change. MachineCard falls back run_target ?? quantity so un-enriched callers
degrade to prior behavior.
**Known remaining (deliberately out of scope):**
1. ScheduleJobModal duration math uses job.quantity (lines ~111/~711) — a host
   scheduled BEFORE a merge keeps its pre-merge runtime estimate; scheduled_end
   and Uncle Bob pacing understate the combined run. Needs its own round:
   touching duration interacts with D-SCHED-13/14 and proposal staleness.
2. Whether merge_job_into_host should extend host estimated_minutes/
   scheduled_end server-side at merge time — same round as (1).
3. PresidentsBridge assembly ratios divide through-finishing by component
   job.quantity; a merge-host component job transiently inflates the ratio
   until member shares allocate back post-compliance. Revisit if observed.

### D-SCHED-16 — Stale-schedule detection via schedule_qty_basis (2026-08-19)
**Problem:** merges (and unmerges/splits) change a run target without any
prompt to revisit the host's end date; estimates understate combined runs,
mis-feeding BEHIND flags and Uncle Bob.
**Mechanism:** jobs.schedule_qty_basis records the run target each schedule
was computed from, written by a BEFORE INSERT/UPDATE trigger whenever
scheduled_end changes — covering both cascade RPCs, resizes, and Uncle Bob
applies with zero client writes. Staleness is DERIVED (basis ≠ current run
target on a scheduled job), never a flag to clear, per D-JOBMERGE-04's
precedent. Null basis (legacy, never re-saved) reads as not stale.
**Scheduler flow:** amber badge on stale bars; "Run target changed" section
in the Command page Messages drawer; one click opens Adjust End Date with the
recommendation pre-filled from the live run rate (accepted finishing over
elapsed production time, D-SCHED-14 gates: ≥1h, >0 pcs), falling back to
D-SCHED-13 history. Non-stale opens never auto-move anything. Both rate
sources now carry one-click Use buttons. Saving through the normal cascade
path records the new basis and the alert self-extinguishes.
**Also closed:** ScheduleJobModal duration math now uses getRunTarget
(D-JOBMERGE-19 known-remaining #1); whether the merge RPC should extend host
estimates server-side (#2) is RESOLVED by this decision: it should not — the
best estimate input (live rate) doesn't exist at merge time, and the
alert-and-review flow keeps the scheduler in charge.
**Deliberately informational:** staleness blocks nothing — the run is
physically underway; the cost of ignoring it is a wrong estimate, which is
what the worklist nags about.
**Numbering:** issued as D-SCHED-16; the round brief said D-SCHED-15, which
was already taken by Scheduling onto DOWN Machines (2026-08-19). Code comments
in this round cite D-SCHED-16 to match.
**Implementation notes (two deviations from the round brief, both narrow):**
(1) The brief asserted the scheduled-jobs fetch used select('*') so
schedule_qty_basis would arrive for free. That holds for the week-window
fetch (which feeds the grid bars and the bar-click modal) but NOT for
loadAllScheduledJobs, which used an explicit column list — and that is the
array the stale worklist filters. Left alone, the Messages section and its
badge would have been permanently empty and worklist-opened modals would
never compute a live rate. That select now uses `*` plus its existing joins,
matching the week-window fetch's convention in the same file: naming the new
column explicitly would have hard-failed the whole list-view query (PostgREST
400) on any database where the migration had not yet been applied, turning a
dormant feature into a broken page. With `*`, a pre-migration database simply
yields a null basis, which reads as not-stale by design. (2) Edit 2.4's target line lives in Step3Duration, a
sibling component that does not receive the new members prop, so members is
threaded through from ScheduleJobModal; as written the label would have
thrown ReferenceError on Step 3 render (esbuild does not catch this — only
lint/runtime does).

### D-SCHED-17 — Kiosk shows scheduled end; machinist change requests (2026-08-19)
**What:** The Kiosk Active Job header now leads with the job's scheduled end
(customer due date remains as a secondary line). For non-maintenance jobs the
date is tappable and opens a Request End-Date Change modal: requested end +
optional reason, inserted into schedule_change_requests with source='kiosk'
and the signed-in operator as requested_by. The scheduler's existing SKY57
Messages drawer picks it up with no scheduler-side changes — the table's
source CHECK already permitted 'kiosk'; only the kiosk half was unbuilt.
**Guards:** one open request per job (header shows "Change requested → date";
the modal shows the open request instead of allowing a duplicate). Production
jobs request rather than write — a direct scheduled_end write from the kiosk
would bypass the downstream cascade. Maintenance jobs keep their existing
direct Extend Duration flow, unchanged, by design.
**Relation to D-SCHED-16:** when the scheduler applies a request through the
normal end-date path, the schedule_qty_basis trigger records the new basis —
the two features compose without either knowing about the other.
**Numbering:** issued as D-SCHED-17; the round brief said D-SCHED-16, which
this log had already assigned to stale-schedule detection. The brief's
"Relation to D-SCHED-15" line was likewise retargeted to D-SCHED-16, since
schedule_qty_basis landed under that number and D-SCHED-15 is Scheduling onto
DOWN Machines.
**Open at time of writing — RLS:** unverified from the repo, as the schema
dump captures no policies. The kiosk clears expired JWTs and falls back to
anon, so it is likely writing as the anon role, while schedule_change_requests
was built for the scheduler's authenticated production-meeting flow. If the
insert is refused, the table needs an INSERT policy covering whatever role the
kiosk runs as, modelled on the policies already permitting kiosk writes to
audit_logs, machine_downtime_logs, finishing_sends, and kiosk_sessions.

### D-SCHED-18 — mergeAllocs is scope-complete, not window-scoped (2026-08-20)
**Bug:** false "Run target changed" alerts for merged hosts scheduled outside
the visible week (J-000142: displayed 3,507 → 2,000; true state 3,507 →
3,507, not stale). mergeAllocs was fetched for visible-week boardIds, but
D-SCHED-16's staleScheduled derives from allScheduledJobs (unwindowed);
missing map entries degraded getRunTarget to bare quantity via the `|| []`
fallback.
**Fix:** the active-allocation fetch is now unfiltered — one complete map for
every consumer (bars, popup, Adjust End Date modal, ScheduleJobModal members,
worklist). Cheap: active merges are tens of rows.
**Lesson (recurring class):** `|| []` / `|| 0` fallbacks convert MISSING data
into EMPTY data silently — third instance (Sales Dashboard views, merged run
targets on Production Display, now this). When a derived computation spans a
wider scope than the data fetch that feeds it, the fallback manufactures a
wrong-but-plausible answer instead of an error. Check scope alignment when
wiring any map keyed by job id.
**Numbering:** issued as D-SCHED-18; the round brief said D-SCHED-17, which
this log had already assigned to the Kiosk scheduled-end / change-request
round. The brief also referred to stale detection as D-SCHED-15; that number
is Scheduling onto DOWN Machines, so both this entry and the new code comment
cite D-SCHED-16, where schedule_qty_basis actually landed.

## D-DOWN-01 — Machine-DOWN banner at the kiosk, and reconciling three DOWN signals (Aug 21, 2026)

A machine carrying an open machine_downtime_logs row could become permanently DOWN with no UI path to clear it. The Machine Ready control lived in the else-branch of `activeJob ? … : orphanedDowntimes.length > 0 ? …`, so any active job made it unreachable, and the only other path — Activity-Log click-to-edit — lists only downtimes whose job_id matches the active job. MZ-5 hit both at once in PROD: an Aug 14 downtime attached to RQ-53613719 while J-000208 ran on the machine from Aug 19, accruing seven days of phantom downtime before being closed by SQL on Aug 21 (end_time set to Aug 19 12:00 EDT, midday of the day the tool was actually repaired, rather than now(), so the duration stays honest for downtime reporting). The fix decouples the DOWN presentation from the active-job branch: a slim collapsed strip renders above the job panel whenever orphanedDowntimes is non-empty, carrying the reason, start time, a Details toggle listing every open row, and Machine Ready for operators. Slim and collapsed by explicit requirement — the banner must not crowd job information — with the existing full-screen DOWN panel retained for the no-active-job case, where nothing else competes for the space. No data-layer change was needed: loadOrphanedDowntimes was already machine-scoped with a realtime subscription; the rows existed and simply were never rendered.

Root cause of the stranding was a fourth path: handleFinishingSend performs no ongoing-downtime review, while Complete Job has a review_downtimes step, so a job could leave the machine with its downtime still open. That is now a warning rather than a block, deliberately — the downtime is machine-level and a job may legitimately move to finishing while the machine is still down; the banner, not a gate, is what keeps the record visible. Separately, machines.status, open downtime rows, and active unplanned maintenance jobs are three independent DOWN signals ORed in MachineCard, but every clear path wrote status='available' unconditionally without consulting the others — the reason MZ-5 read 'available' in machines while the board showed DOWN. handleClearMachineDown now checks for a live unplanned maintenance job before clearing the machine flag and tells the operator when it deliberately holds DOWN. Deferred: an admin resolve control on the Mainframe MachineCard so a stuck machine can be cleared without walking to the kiosk, and the symmetric guard on the maintenance-complete paths (Schedule.jsx and the kiosk maintenance completion), which still clear status='available' without checking for open downtime rows.

## D-SHORT-07 — Shortfall cards reported unfulfilled balance as customer impact (Aug 21, 2026)

The Shortfalls tab labelled J-000139 "1 of 1 CO lines short by 750" on a job that produced 1,175 against a 750-piece allocation. getWOFulfillmentSummary computes remaining as quantity_ordered − quantity_fulfilled, and quantity_fulfilled only posts when a job enters pending_tco via trg_fulfill_co_on_tco (D-SHORT-05) — so any job with an open shortfall, by definition not yet through TCO, reports its entire order as short. buildImpactSummary then summed those remainders under the words "short by". J-000184 showed the same defect at larger scale, claiming 2,751 short on a 430-piece job, that figure being the outstanding balance on a 3,000-piece allocation whose covering job (J-000093, 5,293 good pieces) sat at manufacturing_complete with fulfillment not yet fired.

Exposure is now computed as max(0, Σ active allocations − projected production), where projected production sums non-maintenance jobs on the WO: those past the machine contribute getEffectiveQty (the precedence chain job_effective_qty() mirrors in SQL, so outsourced and finished counts are right), those in flight contribute their target, flagged isProjection so the UI can say so. Status sets mirror PartHistoryModal per D-PARTHIST-01 — machining finishes at manufacturing_complete, and gating on 'complete' would hide most real production. cancelled and merged are excluded; merged pieces are already carried by the host's own count (D-JOBMERGE-08). Both PROD cases return 0 exposure: WO-2607-0024 750 allocated against 1,175 produced, WO-2606-0038 3,723 allocated against 7,193 projected across three same-part jobs.

Deliberately NOT derived from work_orders.order_quantity / stock_quantity. Those are creation-time snapshots written once by CreateWorkOrderModal and never updated when allocations are attached afterwards; WO-2606-0038 reads order_quantity 723 against 3,723 in active allocations. An earlier draft of this fix used stock_quantity as the headroom source and would have produced a confidently wrong number — the same class of defect with better arithmetic. Presentation: the per-line figure keeps its math but is relabelled "awaiting fulfillment", the job-level "Short by N" is demoted to neutral grey (a true statement about the job carrying no customer meaning alone), and a coloured exposure chip carries the customer verdict. A null exposure from a failed load renders "—" rather than a false all-clear. isDemandRow is unchanged per D-SHORT-06, so an MTO card stays under Customer Impact with Allocate reachable — it simply now reports zero exposure instead of implying the customer is short.

Known limitation: exposure is WO-level, so on a multi-job WO two sibling shortfalls each report against the same shared headroom. Accepted — a WO normally carries one stock slice and concurrent shortfalls are rare — rather than building per-job headroom accounting. Two adjacent defects filed, not fixed here: (1) work_orders.order_quantity / stock_quantity drift post-creation, understating customer commitment on WO-2606-0038 by 3,000 pieces and feeding anything that reports committed-vs-stock at WO level; (2) J-000184 entered pending_tco with 400 good pieces but only 249 posted to its 3,000-piece CO line — neither the CO remaining nor the good count explains a 249 cap, so either job_effective_qty() is returning something other than good_pieces or the WO-commitment cap is computed off the stale order_quantity. If the latter, header drift is silently throttling fulfillment, and the two defects are one bug.

## D-STKREQ-02 — Warehouse demand is visible at the collapsed group level (Aug 21, 2026)

D-STKREQ-01 merged open stock requests into the Demand tab, but the STOCK chip lived only in the expanded sub-table, so a warehouse-only part group looked identical to a customer one in the collapsed list April actually scans — the sole tell was an em-dash in the due column, since stock requests carry no due date. The group memo now derives stock_demand / co_demand / has_stock / is_stock_only from the lines it already holds, and the card carries an amber glow (border-amber-700/60 plus a soft box-shadow) with a chip beside the part number: bare "STOCK" when the whole group is warehouse demand, "+N STOCK" when mixed, since a mixed group's demand column blends both figures and the warehouse portion is the part that isn't a customer commitment. Hover gives the full split.

Precedence in the card's className is deliberate: the transient cross-part selection warning keeps the top slot so it stays legible, selection-lockout dimming beats the glow so non-selected groups recede while a WO is being built, and the glow applies only in the default state. Kept in the amber family already established for stock in this feature (New Stock Request button, sub-table chip) rather than introducing a second orange scale — amber-500 reads orange on the dark theme. Note that stock-only groups still sort last under "Earliest due" because they have no due date; that is correct (no due date, no urgency) and was left alone. No data-layer change: is_stock_request was already on every merged line.

## D-SCHED-19 — Per-Machine Part History in the Schedule Modal (Aug 21, 2026)

Step 1 of the Schedule modal showed queue depth, running job, and the master-data Preferred star, but nothing about whether a machine had ever produced the part being scheduled — the scheduler's own capability hierarchy ranks run history above master data, and the picker exposed only the weaker signal. Machine cards now carry a "Ran this part" badge plus a line reading run count, piece-weighted parts/day, and last run date, sourced from fetchPartMachineHistory in lib/scheduling.js. That helper is deliberately broader than fetchPartThroughputRuns: it keeps runs with no usable time_per_unit, because a completed run proves capability even when it yields no rate, and it aggregates per machine rather than capping at the 10 most recent runs. Machine order is unchanged — the badge informs the choice without reordering the list.

The production-done status sets moved from PartHistoryModal to lib/jobs.js and effectiveTimePerUnit to lib/scheduling.js, with the modal importing both. Two surfaces answering "has this part run here" from separately-maintained definitions is the drift that produced D-PARTHIST-02; there is now one definition. jobs.js imports nothing, so the new scheduling.js → jobs.js edge introduces no cycle.

Known limitation, not addressed here: every part-history read in the codebase keys on jobs.component_id alone, while jobs also carries a legacy part_id column that certRepository.js still reads as a fallback (j.component_id || j.part_id). If any job rows populate part_id without component_id, they are invisible to PartHistoryModal, fetchPartThroughputRuns, fetchPartMachineHistory, and Uncle Bob alike. Flagged for a dedicated diagnostic pass; if confirmed, the fix belongs in the shared helpers rather than at each call site.

**Numbering:** issued as D-SCHED-19; the round brief said D-SCHED-14, which this log had already assigned to Current Parts/Day on Production Dashboard (Aug 19, 2026). D-SCHED-18 was the highest number in use, so this round takes 19, and the code comments in lib/jobs.js, lib/scheduling.js, PartHistoryModal.jsx, and ScheduleJobModal.jsx cite D-SCHED-19 to match. Third consecutive round to hit this — see the same note on D-SCHED-17 and D-SCHED-18.

## D-SCHED-20 — "Has run this part" Section in the Machine Picker (Aug 21, 2026)

D-SCHED-19 marked machines with prior runs on the part being scheduled, but left them scattered through the location/brand grouping, so the strongest capability signal was something the scheduler had to hunt for. Proven machines now lead Step 1 in their own section, sorted by parts/day descending, then run count, then name. They are moved rather than duplicated — the grouped list below excludes them and an "Other machines" divider marks the boundary — and each proven card carries a muted Location · Brand line so being lifted out of its group does not lose that context. The card markup was extracted into a MachinePickCard component shared by both sections so the two can never drift; the per-card "Ran this part" badge was dropped as redundant inside the section and unreachable outside it, while the runs/rate/last-run detail line stays.

When no machine has produced the part, the picker now says so explicitly and notes that job history begins at go-live (Apr 29, 2026). SK244-42 is the motivating case: it has genuinely run on Mazak 5, but only on paper before SkyNet existed, so the picker shows Nexturn 5 alone. Absent history is not evidence a machine cannot make the part, and the master-data Preferred star remains the carrier for capability the system was not around to observe — part_machine_durations is where pre-go-live knowledge belongs.

Also fixed: the Armory Part History no-rate note read "1 completed run carry no rate ... these can be repaired" in the singular, in both the UI and the print output. Both branches are now written out in full rather than pluralised by suffix.

The Step1Machines comment deliberately carries no D-### citation. This round's ID shifted twice during authoring, and every prior shift (D-SCHED-17, -18, -19) required hand-correcting code comments; keeping the ID in Decisions.md alone removes that failure mode for this block.

Open and unaddressed: the machine card's parts/day and the Step 3 duration suggestion can disagree for the same machine. fetchPartMachineHistory admits runs whose rate is derived from production_start → actual_end, while fetchPartThroughputRuns filters on time_per_unit > 0 and drops them. Both numbers appear in the same modal. Raised by CC during D-SCHED-19 verification; aligning fetchPartThroughputRuns onto effectiveTimePerUnit would fix it but changes duration suggestions the scheduler relies on, so it is deferred to a round with its own TEST pass.

## D-DEMAND-01 — Demand Tab No Longer Creates Work Orders for Non-Schedulers (Aug 21, 2026)

Work-order creation was already gated to admin/scheduler on Mainframe (canEditSchedule, D-SCHED-11), but the Demand tab's sticky-footer Create Work Order button carried no role check — its only guard was the inactive-part block — and because the demand pool includes warehouse stock-request lines, the bypass minted MTS work orders as easily as MTO ones. Discovered via WO-2608-0060, an MTS order created with no recorded creator (see the created_by gap, same date). DemandView now applies the identical primary-role predicate as Mainframe, deliberately not widened to roles[], so the capability reads the same on both surfaces and cannot silently diverge. Demand visibility is unchanged for all roles: the tab, selection, and footer totals remain as a read-only demand calculator; only the button and the modal mount are gated.

Client-side only, consistent with how D-SCHED-11 enforces the same rule on Mainframe. A server-side RLS backstop on work_orders INSERT was considered and deferred pending a pg_policies survey — adding a permissive policy alongside an unknown existing permissive set does nothing, so the existing policies must be read first.

## D-SCHED-21 — Queue rows in the position picker show due dates, coloured against the job being placed (Aug 21, 2026)

Step 2 of ScheduleJobModal listed a machine's queue with part, job number, and scheduled window but not the customer due date — the one fact that determines where a new job belongs. The scheduler was left inferring urgency from scheduled_end, which reflects when the job happens to be planned, not when it is owed. Both feeds into the modal (Schedule.jsx fetchJobs and fetchAllScheduledJobs) already selected work_order.due_date and customer, so this was render-only: each row gains a Due chip plus customer name, and the chip is coloured against the job being scheduled. Amber means the queued job is due later than the new one — the rows the new job is a candidate to slot ahead of; red means the queued job's own window already finishes past its due date, so inserting ahead of it compounds an existing problem; grey otherwise. The comparison uses end-of-day on the DATE column, matching the existing late-schedule warning. Deliberately informational rather than prescriptive — it does not pre-select a slot or reorder the queue, because priority, machine capability, and setup grouping all legitimately override pure due-date order (Uncle Bob's capability hierarchy weighs those; this picker is the manual path). Deferred: surfacing the same chip in Step 3's propagation preview, where the scheduler sees the knock-on shift to downstream jobs and would benefit from knowing which of them it pushes past due.

**Numbering:** issued as D-SCHED-21; the round brief said D-SCHED-16, which this log had already assigned to Stale-schedule detection via schedule_qty_basis (2026-08-19) — itself a renumber from that round's brief. D-SCHED-20 was the highest in use, so this round takes 21, and the new code comment in ScheduleJobModal.jsx cites D-SCHED-21 to match. Fourth occurrence of this collision (see D-SCHED-16, -17, -18, -19). D-SCHED-20 responded by omitting the D-### citation from its code comment entirely; this round's brief reintroduced one, so the correction was needed again. Worth settling a convention: either briefs check the log before assigning a number, or code comments stop carrying them.

## D-INV-03 — One Inventory Line per Lot per Shelf (Aug 24, 2026)

The Raw Material Inventory tab rendered one line per material_receiving row, so a lot restocked onto the same shelf appeared as multiple lines the reader had to sum by eye — lot 2605 on R3 read as 149 and -51 on separate rows against a shelf holding 98 bars. The By Lot view now groups on (rack, material_type, bar_size, bar_length_inches, lot_number), taking the bar racks from 95 receipt lines to 89.

Bar length is in the key deliberately: 19 of 22 multi-receipt groups mix 144" and 48", and those are not interchangeable at the machine, so collapsing them would show stock that cannot do the job. Rack is in the key because the same lot on two shelves is two places to walk to; no lot currently spans racks, so it never splits anything today.

Receipts are not merged in the database. Each retains its own PO, vendor, price, received date, and cert document, and each stays reachable through the expander on multi-receipt lines — merging would collapse cert traceability and orphan material_usage foreign keys. Single-receipt lines, which are 84 of the 89, behave exactly as before. On multi-receipt lines the docs button routes to the expander because certs belong to individual receipts, and a rack move shifts every receipt behind the line, since they share a rack by definition of the key.

Netting hazard handled explicitly: lot 2605's group nets to +98 while one of its receipts sits at -51, and a plain sum would have retired the negative-inventory signal D-INV-01 exists to surface. Groups carry has_negative, the row shows a warning icon when a constituent is negative but the total is not, and the summary strip counts those groups as negative.

Deliberately out of scope: the Adjustments cycle-count screen stays per-receipt. A monthly count was running the week this shipped, and changing the count workflow days before a count is the wrong risk. A rack-level count that distributes a counted quantity across constituent receipts client-side — no RPC change, every adjustment still landing on a real receipt — is the natural follow-up.

**Numbering:** issued as D-INV-03; the round brief said D-INV-02, which this log had already assigned to Inventory summary strip: bars subtotal, and low-stock threshold at 5 (2026-08-05). D-INV-02 was the highest plain number in the D-INV series, so this round takes 03, and the code comment in src/pages/Armory.jsx cites D-INV-03 to match. Same collision the D-SCHED series hit four times running (see D-SCHED-16 through -21); the convention question raised there — briefs checking the log, or code comments dropping the D-### citation — is still open.

## D-INV-04 — Receipt Lines Drop Availability; Cycle Count Goes Per Shelf (Aug 24, 2026)

Two consequences of the same mistake: exposing receipt-level granularity on screens where people reason about shelves. Builds directly on D-INV-03, which grouped the By Lot view into one line per lot per shelf.

Expanded receipt lines under a grouped inventory row no longer show used, available bars, or available inches. Availability is a property of the shelf — bars are indistinguishable once racked — and per-receipt balances only mislead, as with lot 2587 reading 40 available on the line while a receipt behind it showed -2.0. Receipt lines now carry only what is receipt-specific: received date, PO, bars received, cost, and certs. The value column on those lines therefore changes meaning from remaining value to receipt cost (received_bars x price_per_bar), which is the figure that belongs against a receipt.

The cycle count screen asked for a number per receipt inside each length bucket, which has no physical referent: nobody re-bundles steel to match a receiving history, and a counter facing three stacked inputs for lot 2592 on R3 has no basis for choosing which one gets the count. Each length bucket now takes a single input, and the client distributes the counted quantity across the receipts behind it — newest first, capped at what each actually received, remainder riding on the newest. FIFO consumes oldest first, so whatever remains physically came from the most recent deliveries. An older negative receipt therefore lands on zero and is trued up as a side effect of the count, which is the desired behaviour going into the monthly count. submit_inventory_adjustments is untouched: every adjustment still targets a real material_receiving row and files its own audit row, so approval and traceability are unchanged.

Verified against live data before shipping: lot 2587 (system 40, counted 40) distributes to P3726 40 and PO 2895 0, net delta zero, clearing the -2.0; lot 2605 (system 98, counted 98) distributes to P3754 98 and PO 3009 0, net delta zero, clearing the -51; lot 2605 counted at 105 yields net +7 with the older receipt still cleared.

The 4 ft / 12 ft split, new-length discovery inputs, the blanks table, and the approval workflow are unchanged. Blanks continue to address receipts directly because a blank lot always has exactly one receipt.

Note: the printed count sheet was already per-shelf — one system total and one write-in box per length bucket per lot. The screen form was the outlier, so this change makes the two agree rather than introducing a new convention.

**Numbering:** issued as D-INV-04; the round brief said D-INV-03, which the immediately preceding round in this log had taken for One Inventory Line per Lot per Shelf (Aug 24, 2026) — itself a renumber from that brief's D-INV-02. D-INV-03 was the highest in use, so this round takes 04. No correction was needed in the code: this round's comments carry no D-### citation, following the D-SCHED-20 precedent. Second consecutive D-INV round to hit this, and the sixth across the log (see D-SCHED-16 through -21); briefs are still being written against a stale view of the numbering.

## Fishbowl Bridge — Round FB1 (2026-08-24)

### D-FB-01 — Transport: on-prem read-only bridge, outbound only (2026-08-24)
Fishbowl Advanced 25.9 is on-prem (192.168.1.251:2456, embedded Jetty). A Node bridge on the Fishbowl server polls the REST API (`/api/login`, `/api/data-query`, `/api/logout` only) and pushes to Supabase over outbound HTTPS. Supabase never reaches into the plant; Fishbowl is read-only for this round. Bridge code lives in `tools/fishbowl-bridge/` (own package.json, outside the Vite build, `.env` git-ignored).

### D-FB-02 — Change feed is the Hibernate Envers audit (2026-08-24)
`revinfo` (384,669 revisions, live) + `soitem_aud` / `so_aud` give an ordered change log. The bridge tails `revinfo.id` (cursor `fb_sync_state.last_rev`) every 20 s, collects the SO ids touched in the window, refetches each SO in full and diffs — `REVTYPE` is never interpreted because Fishbowl re-saves every line on SO save. A 200-revision overlap is re-read each cycle (idempotent) to cover out-of-order commits; a 15-min reconciliation sweep of open SOs by `dateLastModified` is the safety net. Only the last chunk of a window carries `rev_to`, so the cursor cannot pass un-ingested work.

### D-FB-04 / D-FB-05 — Fingerprints and removals (2026-08-24)
Fingerprint = md5 of the substantive Fishbowl JSON minus `dateLastModified`; a re-save with no content change bumps `last_synced_at` only. Lines missing from a refetched SO get `removed_at`; SOs missing from Fishbowl get `removed_at`. Nothing is hard-deleted.

### D-FB-06 — Ownership split (2026-08-24)
Fishbowl-owned columns are written only by `fb_ingest_delta`. SkyNet-owned columns (`part_id`, `kit_sku_id`, `resolution`, `disposition*`, `customer_order_line_id`, `customer_order_id`) are set by ingest only on first sight of a row; re-sync never overrides a human disposition.

### D-FB-07 — Bridge identity (2026-08-24)
Supabase Auth user `fishbowl-bridge@skybolt.com`, profile "Fishbowl Bridge", primary role `integration` (new value in the profiles role CHECK), signing in with email/password over the anon key. Every `fb_*` RPC is SECURITY DEFINER behind `_fb_gate(text[])` (NULL-uid SQL-Editor passthrough, `user_has_role(uid, VARIADIC roles)` otherwise, anon revoked). No service-role key on the plant network.

### D-FB-08 / D-FB-09 — Resolution and auto-disposition (2026-08-24)
Part key is Fishbowl `part.num` via `product.partId` (98.4% equal to `productNum`; 110 parts carry several products), case-insensitive; fallback `productNum`. Kit lines (type 80) resolve to `kit_skus.part_number`. Unresolved `SK`/`ZG`/`QL` → `unlisted_skybolt` + `pending`; other unresolved → `unlisted`; non-product line types → `ignore`; resolved purchased parts → `purchased`; everything else `pending` for Ashley. Match analysis: 94% of SkyNet parts exist in Fishbowl; 4,398 active Skybolt-prefixed Fishbowl products are not in SkyNet (SkyNet holds the routed subset by design), so an unresolved Skybolt line is the normal case, not an exception.

### D-FB-10 — Due date (2026-08-24)
`effective_due_date = COALESCE("Remaining Parts Ship Date" (customfield id 30, from soitem.customFields JSON), dateScheduledFulfillment::date in America/New_York)`. Fishbowl defaults `dateScheduledFulfillment` to the creation timestamp; a user-entered date lands at midnight, so `due_date_is_default = true` flags lines where no real date was ever entered.

### D-FB-11 — Estimates never enter SkyNet (2026-08-24)
Only Issued (20) and In Progress (25) SOs are inserted. The bridge's affected-SO query excludes `statusId = 10` and `fb_ingest_delta` skips unseen non-open SOs; an Estimate that is later Issued enters at that moment (same `so.id`). Once mirrored, every later status keeps syncing (60/70 close, 80/85/90 dead + exceptions for linked CO lines).

### D-FB-12 — Quantities on Fishbowl-sourced CO lines (2026-08-24)
`customer_order_lines.quantity_ordered` keeps its meaning (what SkyNet must produce) and is set to Fishbowl `qtyToFulfill` at conversion. Three informational columns — `fb_qty_ordered`, `fb_qty_fulfilled`, `fb_qty_to_fulfill` — are kept live by ingest so the CO row reads Ordered / Shipped (FB) / To fulfill. Demand math (`getEffectiveQty`, allocations) untouched. (`fb_convert_to_co` ships in Batch B.)

### D-FB-13 — `order_processor` additional role (2026-08-24)
New additional role `order_processor` in `profiles.roles[]` (unconstrained per D-MROLE-02). Disposition, Create CO and exception ack: `order_processor` or `admin` (Ashley = assembly + order_processor). Customer Service and the other read roles see the full queue with no write controls. UsersTab ROLE_OPTIONS gains the value in Batch B.

### D-FB-14 / D-FB-15 / D-FB-16 — Propagation to linked CO lines (2026-08-24)
Auto-applied with an event: a `qtyOrdered` change (Δ added to `quantity_ordered`; a decrease only when the new value ≥ active allocations + `quantity_fulfilled`), due-date change, customer PO change. Fishbowl fulfillment movements are never propagated into `quantity_ordered` (SkyNet posts its own fulfillment at allocation; mirroring the shipment would double-count) — they only refresh the `fb_qty_*` columns. Line removed / line status 70/75 / SO status 80/85/90 / qty below allocations → `fb_sync_events.requires_ack`; no automatic cancel in v1 (deep link to the existing cancel flow). Line status 50 / SO status 60 → informational "Shipped in Fishbowl".

### D-FB-17 — Backfill = open orders only (2026-08-24)
`statusId IN (20, 25)` at backfill time (~140 SOs). History stays in Fishbowl until a later round needs it. `fb_link_existing_cos()` then links the manual COs by `fishbowl_order_id = so.num` (line match by `part_id`, exact-qty then line-order tie-break) and reports ambiguous / unmatched.

### D-FB-18 — RLS (2026-08-24)
Six `fb_*` tables: SELECT for `authenticated`, no direct write policies; writes only via the `fb_*` RPCs (stock_requests precedent). `v_fb_order_queue` is `security_invoker`.

### D-FB-20 — Inventory snapshot deferred to Batch C (2026-08-24)
`fb_part_inventory` and `fb_users` exist from Batch A; their pollers and `fb_upsert_*` RPCs land in Batch C once `qtyinventorytotals` / `sysuser` column names are confirmed. Migration: Docs/migrations/2026-08-25_fishbowl_bridge_a.sql (TEST 2026-08-24).

### FB1 Batch A closeout — field findings (2026-08-24)
Backfill on TEST: 144 open SOs / 1,732 lines, parity exact (count + Σid). Live: new Issued SO in < 30 s; Remaining Parts Ship Date drives `effective_due_date` (stored by Fishbowl as `"2026-09-04 00:00:00"`); Estimate edits correctly never arrive. Linkage: 42 manual COs / 55 lines linked. Findings the bridge surfaced on day one: `SK2500-55W` was a typo in SkyNet's parts master (renamed to `SK2500-5SW` on TEST — repeat on PROD at cutover); CO-5596-18014 #2 says AC48 where Fishbowl says AC58 (April to check the customer PO); SO 16311 lines 9–10 carry year-206 dates in Fishbowl; 9 open SkyNet COs are already Fulfilled/Closed Short in Fishbowl (one since Dec 2025), one CO points at an Estimate (17995), one at a non-existent SO number (17873) — cleanup list for April, recomputed on PROD. Resolution mix of open lines: 874 resolved parts pending, 375 hardware auto, 201 non-product, 70/72 kits resolved, 101 (6%) unlisted Skybolt parts — R-06 closed. Plan path correction: the plan lives at Docs/Implementation_Plans/FB1_Implementation_Plan.md (D-FB-01's cite is superseded).

### D-FB-21 — `covered` disposition (2026-08-24)
A Fishbowl line whose demand is already represented by an existing CO line (a hand-keyed CO line that aggregates several SO lines — CO-7480-17982 line 1 = FB lines 2 + 25) is marked `covered`, never converted. Set by hand only. Added to the fb_sales_order_lines disposition CHECK and to v_fb_order_queue as covered_lines.

### D-FB-22 — Linker tie-break (2026-08-24)
fb_link_existing_cos v2 orders candidates by exact quantity match, then matching due date, then line order. Motivated by CO-1081-15019 (two identical 5,000-piece lines, May and November): line order alone paired the November CO line with the May SO line. Relinked by hand on TEST.

### D-FB-23 — Re-resolution (2026-08-24)
`fb_reresolve_lines()` matches unresolved open lines (`part_id IS NULL`, types 10/12) against `parts.part_number` and unresolved kit headers against `kit_skus.part_number`; a resolved purchased part auto-dispositions `purchased`, an auto-`unlisted` line becomes `pending`, human dispositions are untouched. The Order Queue calls it on mount for acting roles, so a part added in the Armory lights up its SO lines on the next visit. Gate: order_processor / admin / integration.

### D-FB-24 — Suspect dates (2026-08-24)
`effective_due_date` outside 2000–2100 flags the SO (`v_fb_order_queue.suspect_dates`, red chip on the card and the line). Fishbowl has real year-206 dates (SO 16311); the fix belongs in Fishbowl, the queue just refuses to hide it.

### D-FB-25 — Batch B shape (2026-08-24)
Order Queue page: Queue tab (any `pending` line) / All Open; search + salesperson filter; SO cards roll up v_fb_order_queue; lines load on expand. Bulk actions per SO: Ship from stock / Purchase / Covered / Ignore / Back to pending (`fb_set_disposition`) and Create CO (`fb_convert_to_co`: find-or-create the CO by `fishbowl_order_id`, `quantity_ordered = qtyToFulfill`, due = effective date, priority mapped from Fishbowl, `created_by = auth.uid()`, salesperson by username, fb_qty_* seeded). CustomerOrders accepts a `coSearch` nav payload so the queue deep-links to the CO it just made. UsersTab lists `order_processor` under Additional Roles only. Exceptions / Recent Changes tabs, the CO-page FB chips and the users/inventory pollers are Batch C. Migration: Docs/migrations/2026-08-25_fishbowl_bridge_b.sql (TEST 2026-08-24).

## D-INV-05 — Bar length on the inventory adjustment review screen (Aug 25, 2026)

The adjustment review table rendered material, size, and lot but not bar length, so a session touching both the 144" bar and the 48" stub of one lot produced two visually identical rows — observed in PROD on lot 2629, where a -1 on the 144" and a +2 on the 48" were indistinguishable on the screen whose only job is verifying a count. inventory_adjustment_requests carries material_type, bar_size, and lot_number but not bar_length_inches; the length lives on material_receiving via material_receiving_id. Fixed with a read-time join in loadAdjustments and a length chip appended to the Size cell, rather than denormalizing a column onto the adjustment row: the join repairs historical sessions as well as new ones, and bar_length_inches never changes after receipt creation, so the join is stable. Blanks (category='blank') carry no length and render the size alone. Paired with D-INV-04, which stops create_count_discovery_receipt cloning the reference receipt's price_per_bar verbatim onto a shorter discovered length.

### FB1 Batch B closeout (2026-08-25)
Order Queue walkthrough on TEST: 148 open orders; bulk dispositions, Create CO (new header CO-7259-1496501 from SO 14965-01), append to an existing manual CO (CO-17140-17042), read-only for customer_service, Fishbowl date edit on a converted line propagated to the CO line. Walkthrough asks folded into C1 below. Fishbowl column checks done: `sysuser` (id, userName, firstName, lastName, activeFlag — never userPwd/mfaSecret), `qtyinventorytotals` (PARTID, LOCATIONGROUPID, QTYONHAND, QTYALLOCATED, QTYNOTAVAILABLE, QTYNOTAVAILABLETOPICK, QTYDROPSHIP, QTYONORDER — one row per part per location group), `kititem` (kitProductId, productId, kitItemTypeId, defaultQty, sortOrder …).

### D-FB-26 — One CO line per part; add to an open CO line for the same part (2026-08-25)
Fishbowl explodes every kit into its own component lines, so like parts recur across kits on one SO. `fb_convert_to_co` v2 groups the selected lines by `part_id`: quantities summed (Fishbowl qtyToFulfill each), earliest effective due date, notes listing every source Fishbowl line; if the target CO already has an open line (not_started/in_progress) for that part, the quantity is added to it and the note appended instead of creating a second line. All source Fishbowl lines link to the one CO line (many-to-one); the CO line's `fb_qty_*` columns are the sums over its linked lines, recomputed by ingest on every change and on removal. A Fishbowl qtyOrdered change on any one linked line still flows to the shared CO line (D-FB-14 is additive).

### D-FB-27 — Components Needed is mandatory for new CO lines (2026-08-25)
`fb_convert_to_co(p_fb_so_id, p_line_ids, p_components jsonb)` — `p_components` is `{part_id: text}`; a blank value for a part that needs a NEW CO line raises. When adding to an existing line the text is optional and appended to the line's `components_needed`. The old 2-argument signature was dropped so PostgREST sees one function.

### D-FB-28 — `assembly` disposition (2026-08-25)
Added to the disposition CHECK, `fb_set_disposition`, the action bar and the header rollup (`assembly_lines`). A chip only until the Assembly module round, when it becomes the hand-off into assembly.

### D-FB-29 — Kit children tagged from Fishbowl `kititem` (2026-08-25)
`soitem` carries no parent link. The bridge loads `kititem` (kitItemTypeId 10) for the kit products on each batch of SOs and tags each component line that follows a kit header, belongs to that kit's product set and has not already been claimed, until the set is used up or the next kit header starts (`tagKitChildren`, mapper.mjs). Sent as `parentId`; stored as `fb_sales_order_lines.parent_fb_soitem_id`. The queue renders children indented under the header, labelled 1a, 1b …, header shows "n components". Cosmetic only — conversion combines by part regardless. A re-run of the backfill tags the already-mirrored open orders.

### D-FB-30 — Inactive parts refused (2026-08-25)
A resolved part with `is_active = false` cannot become a CO line (skip reason "part inactive in SkyNet — reactivate in Armory"), matching the normal CO window's Pending-Master-Data rule. Seen on SO 14965-01 (SK-O18S, SK-R4GS, SK-R4TS).

### D-FB-31 — Fishbowl response decoding (2026-08-25)
Fishbowl can emit a description byte that is not valid UTF-8 (a cp1252 ®: "Diamondhead�"). The bridge decodes responses strictly as UTF-8 and falls back to latin1 per response. Bridge v1.1.0. Migration: Docs/migrations/2026-08-26_fishbowl_bridge_c1.sql (TEST 2026-08-25).

### D-FB-32 — Queue header shows the Fishbowl entered date (2026-08-25)
The SO card header shows "Entered <date>" (`so.dateCreated`, local calendar day) and the list sorts oldest-entered first. Fishbowl's header Date Scheduled is not surfaced — Matt: "only interested in the item dates"; each line keeps its effective due date, default-date `*` and Remaining-Parts `R` flags. Create CO placeholder reads "what needs to be produced".

### D-FB-33 — Inventory snapshot and "available to ship" (2026-08-26)
Every 5 min the bridge reads `qtyinventorytotals` (one row per part per location group) for every Fishbowl part on an open SO product line and upserts `fb_part_inventory` via `fb_upsert_inventory`: on-hand / allocated / not-available / on-order summed across all groups, `by_location` kept per group, and `qty_available` = on-hand − allocated − not-available summed over the groups listed in the bridge's `AVAILABLE_LOCATION_GROUPS` (default `1,6` = Main + Warehouse; Material and Manufacturing are excluded so raw stock and WIP never read as finished goods). The Order Queue shows it as the Avail column — green when it covers what is left to fulfill, amber when short — with the per-group breakdown and snapshot age in the tooltip. Nothing automates on it (D-FB-20 stands). Matt to confirm the group list; changing it is an .env edit, not code.

### D-FB-34 — Fishbowl users (2026-08-26)
Daily, the bridge reads `sysuser` (id, userName, firstName, lastName, activeFlag — explicitly listed; never userPwd or mfaSecret) into `fb_users` via `fb_upsert_users`, which also back-fills `fb_username` on earlier events. Events and the Recent Changes tab show who made the change in Fishbowl.

### D-FB-35 — Exceptions and Recent Changes tabs; Customer Orders tie-in (2026-08-26)
`v_fb_recent_changes` joins `fb_sync_events` to SO, line, CO and user. Exceptions tab = `requires_ack` events not yet acknowledged, each with a deep link to the CO and an Acknowledge button (order_processor / admin) — acknowledging records that the CO was reviewed or corrected by hand, per D-FB-15's no-auto-cancel rule. Recent Changes = the last 200 events, newest first. Customer Orders: FB chip on every CO linked to a mirrored SO (status live), per-line "FB ordered · shipped · to fulfill" from the `fb_qty_*` columns, "Shipped in Fishbowl" when a linked line reaches Fulfilled / Closed Short, the sync banner above the tabs; the Create CO modal warns when the typed Fishbowl SO number is already in the Order Queue. Bridge v1.2.0. Migration: Docs/migrations/2026-08-26_fishbowl_bridge_c2.sql (TEST 2026-08-26).

### D-FB-36 — Remaining = ordered − shipped; shipped lines are not pending (2026-08-27)
Fishbowl's `soitem.qtyToFulfill` is the quantity of the NEXT fulfillment and keeps its last value once a line is fully shipped (SO 12796: ordered 5 · shipped 5 · qtyToFulfill 5); on partially shipped lines it equals ordered − shipped. Remaining demand is therefore ordered − shipped everywhere: `fb_convert_to_co` v3 (validation and per-part sums), `coQtyForLine`, the Remaining column (renamed from To fulfill) and the Create CO modal. Lines Fishbowl has closed (status 50/60/70/75/95) need no decision: excluded from `pending_lines` / `actionable_lines`, not selectable, shown with their Fishbowl status instead of Pending, counted as `shipped_lines` on the card. `qty_to_fulfill` stays mirrored for reference only. Migration: Docs/migrations/2026-08-27_fishbowl_bridge_c2_2.sql (TEST 2026-08-27).

### FB1 PROD cutover — closeout (2026-08-26)
Batch D executed in one sitting, database → bridge → code → people. PROD (luzungoqfuplspzbqctb): preflight `user_has_role(uuid,text[])`, PG 17.6; migrations _a, _b, _c1, _c2, _c2_2 replayed in order with every verify row confirmed (A `last_rev 0`, B `fb_functions_b 5 · open_orders 0`, C1 one 3-argument `fb_convert_to_co`, C2.2 `null · null · 0`). A first run of the five files landed on TEST by mistake (cursor 385769 / 148 open orders in the rows gave it away); harmless — idempotent, and C1 dropped the 2-argument overload B recreates. Bridge identity `fishbowl-bridge@skybolt.com` → `integration` on PROD; `SK2500-55W` → `SK2500-5SW` renamed on PROD; Ashley `order_processor`. Server `skyserver` (Windows Server 2025, admin login confirmed, outbound 443 to Supabase confirmed): Node v24.20 installed, bridge bundle zipped from the repo without node_modules/.env/logs, `D:\SkyNetBridge`, `npm install --omit=dev` (9 packages, 0 vulnerabilities), `.env` (first saved as `.env.txt` by Notepad — renamed), `npm run backfill`: 144 open SOs / 1,740 lines, cursor 385842, linkage 62 COs / 75 lines, 15 ambiguous, 3 unmatched (13878, 17995, 18584), 6 CO lines without a Fishbowl line. NSSM service `SkyNetFishbowlBridge` installed from an elevated prompt (first attempt failed un-elevated and with two runbook lines pasted as one — nothing was created), `SERVICE_RUNNING`; PROD heartbeat 5 s, `bridge_host skyserver`, v1.2.0. `feature/fishbowl-bridge` fast-forwarded to `main` after the heartbeat (CC had correctly held the push: without migration _a the Customer Orders select on `fb_qty_*` would 400 — the D-MAY28-01 shape — but _a was already on PROD). skynet.skybolt.com: Order Queue 83 needing a decision of 145 open, 336 pending lines, Avail and Remaining populated, FB chips on Customer Orders. Runbook: Docs/FB1_Cutover_Runbook.md. Open for April: the 3 unmatched (status query), the CO-908-16311 ambiguous set, the 6 unlinked lines (part-number spelling), void test SO 18750.

### D-FB-37 — Two bridges, one Fishbowl user (2026-08-26)
One bridge per Supabase project: PROD from the Windows service on skyserver (SESSION_MODE=hold), TEST from Matt's PC only while developing, on SESSION_MODE=per_cycle so the two sessions of `skynet-bridge` never overlap for more than a second. Nothing on the server touches TEST; the banner names the host that feeds each app. A second Fishbowl user (`skynet-bridge-test`) is the cleaner long-term answer if TEST needs a permanent bridge. A TEST refresh from PROD now carries the fb_* tables and cursor; the TEST bridge resumes from them.

### D-FB-38 — Pricing is mirrored, not yet displayed (2026-08-26)
`unit_price` and `total_price` come over on every Fishbowl line (soitem.unitPrice / totalPrice) and sit in `fb_sales_order_lines`; nothing displays them. Matt: not the Order Queue's job — surface pricing in the forecasting round (order value by part / customer / due month, margin against the costing model, sales reporting). Product list price (`product.price`) and price-rule data are not mirrored yet; a daily product-pricing poll is the forecasting round's call.

### FB1 — round closed (2026-08-26)
Spec v4.4 (§3.1 roles, §5.27 Fishbowl Bridge & Order Queue, §10.8 schema, §11 D-FB rows, §12, §13.1 / §13.5). Reference for the next round: Docs/Fishbowl_Data_Context.md — everything the bridge passes over, field by field, with semantics and caveats, for the forecasting module.

### D-RMF-08 — Purchase-check flags on the RM Forecast (2026-08-27)
**What:** Two read RPCs behind _rm_forecast_gate(): forecast_rm_material_history() (bar receipts on record per material + numeric bar size — receipts, bars, first/last received; qty-0 stubs excluded) and forecast_rm_part_history() (per part with an open job: prior_runs = jobs that finished manufacturing, or incomplete with good pieces; first_run when none; jobs keyed by COALESCE(component_id, part_id); maintenance / standalone-finishing / merged never count). Bar Stock Forecast group header gains "Never received" (no bar receipt ever for that material + size) or "None on hand" (received before, on hand ≤ 0), and "First run" / "n first runs"; part rows gain a "First run" chip. Matching is material name case-insensitive + numeric bar size, so receipt and forecast string formats need not agree. Flags are advisory — no forecast math changes; parts missing from the history are never flagged.
**Why:** Purchasing has bought the wrong bar because the forecast bucketed parts on a wrong material callout from the drawing (geometric basis, D-RMF-04 explains the precedence). A material the shop has never stocked, or a part that has never run, is exactly where a drawing error surfaces — the flags tell the purchaser to verify before buying.
**Files:** Docs/migrations/2026-08-27_rmf_purchase_flags.sql, src/components/rmforecast/forecastUtils.js, src/components/rmforecast/BarForecastTable.jsx, src/components/rmforecast/RMForecastSection.jsx.

**Amendment (2026-08-27):** "None on hand" chip removed after the first look on TEST — a received-before material with nothing on hand is already carried by the shortfall chip and the On hand figure, and the purchasing risk this round targets is the material the shop has never stocked. `materialFlag(history)` now returns only 'never' | null; forecast_rm_material_history() is unchanged (receipts / last_received stay available for a later tooltip).

### D-PAPERWORK-01 — Paperwork issues flagged from the Kiosk, acknowledged by compliance (2026-08-27)
**What:** New table paperwork_issues (job, optional job document + a label snapshot that survives document deletion, machine, description ≥ 10 chars enforced by CHECK and RPC, open → acknowledged, logged_by/at, acknowledged_by/at, ack_note; SELECT for authenticated, no direct write policies, append-only — no delete). Two SECURITY DEFINER RPCs: log_paperwork_issue (machinist/admin; validates the document belongs to the job, falls back to the job's machine, audits 'paperwork_issue_logged', fans out a user_notifications row to every active compliance-role holder — role or roles[]) and ack_paperwork_issue (compliance/admin; refuses a second acknowledgement; audits 'paperwork_issue_acknowledged'). Kiosk: "Flag a Paperwork Issue" under the active job's documents opens a modal with an optional document picker and a mandatory description; open issues show as amber "Issue logged … awaiting compliance" chips so a flag is not logged twice. Compliance Review: "Paperwork Issues (n)" worklist above Lot-Change Paperwork, realtime on the table, optional note + Acknowledge. Mainframe: open count folded into the Pending Compliance KPI. Reports: registry-driven "Paperwork Issues Log" (v_report_paperwork_issues, security_invoker; local-time text timestamps so the CSV keeps them; days_open) — universal view, export admin/president/scheduler/compliance.
**Why:** Machinists complain about paperwork — mostly a drawing that does not match the production sheet — and nothing recorded it, so nothing got fixed. The R&D lead has no SkyNet account, so the flag goes to the compliance officer, who first confirms the mistake was not on his side and then works the fix with R&D. Deliberately narrow: machinist flags, compliance acknowledges, nothing on the job changes; the log is the accountability.
**Files:** Docs/migrations/2026-08-27_paperwork_issues.sql, src/lib/paperworkIssues.js (new), src/pages/Kiosk.jsx, src/components/ComplianceReview.jsx, src/pages/Mainframe.jsx.

### D-OVS-01 — Orders vs. stock on the Kiosk and the Production Display (2026-08-27)
**What:** New src/lib/ordersVsStock.js. Orders for a run = Σ active customer_order_allocations across every work order in the run (host WO plus each active member's WO), netted per work order against pieces already made by that WO's other jobs that are past the machine (post_mfg_good_qty ?? good_pieces, plus missed entries — a split remainder or a re-queue only owes the balance, a sibling on one WO never covers another WO's orders, and in-flight siblings contribute nothing until posted). Stock = target − orders, floored at 0; ordersOnRun = min(orders, target) so a job smaller than its demand never reaches stock. Never derived from work_orders.order_quantity / stock_quantity (D-SHORT-07). Kiosk: collapsible "Orders vs. Stock" card under the part card — header verdict ("N more for orders · then S stock" / "Orders covered — making stock (n of S)" / stock run), progress bar with the orders line marked, CO lines with due dates (plus Job column on combined runs) and a Stock row; made = pieces sent to finishing. Production Display: allocation lines now ride in with each active row from one batched fetch (the lazy per-row CO fetch is gone), the dropdown gains the orders-vs-stock line and lists every WO in the run, and a green STOCK chip sits beside RUNNING once the finished count clears the orders line; made = the row's finished metric (verified + missed), so each surface agrees with its own bar.
**Why:** Runs are deliberately overrun to build stock for future orders, and nobody at the machine or in the production meeting could see where the customer pieces end and the stock begins. Display only — no job, count, gate, or fulfillment changes; the shop-level "orders covered" moment is the informational goal.
**Files:** src/lib/ordersVsStock.js (new), src/pages/Kiosk.jsx, src/pages/dashboards/ProductionDisplay.jsx.

**Amendment (2026-08-27):** The Production Display's row bar carries the same orders-line tick as the Kiosk bar (white, 2px proud of the bar, at ordersOnRun / targetQty), so the crossover is visible on the board without expanding the row. Tick hidden when the run has no orders or is entirely orders.

**Amendment (2026-08-31, Command module):** The job detail modal carries an orders-vs-stock bar — track split into orders | stock, pieces sent to finishing filled over it, white tick at the orders line, verdict text — from fetchOrdersVsStock + a Σ finishing_sends.quantity read, lazy per selected job. The list view's row click now opens that modal instead of the Reschedule flow directly (Reschedule remains one click away via the modal's Edit button); loadAllScheduledJobs gained the machine join and order_type/maintenance_type so the modal renders identically from either view.

### D-LATEBATCH-01 — Late batches for jobs that already completed manufacturing (2026-08-31)
**What:** Finishing station gains a collapsed "Late Parts" panel: non-standalone, non-maintenance jobs with actual_end in the last 5 days and status manufacturing_complete, pending_tco, or ready_for_assembly, showing batches/sent so far, good_pieces, machine, and completion date. "+ Late Batch" opens a modal (PLN and material lot pre-filled — newest job_materials lot → blank_lot_number → last batch's lot — both editable and required; quantity required; notes) and writes exactly what handleManualPickupSubmit writes: a pending_finishing, is_partial_send finishing_sends row with sent_by = the PIN operator and the next batch letter by sent_at order. If the job was not already at manufacturing_complete it is set back to it, because ComplianceReview.handleApproveBatch only advances from that status; when compliance approves the late batch, canAdvance re-evaluates (Σ non-rejected sent ≥ good_pieces still holds) and the job returns to pending_tco / ready_for_assembly / ready_for_outsourcing through the existing branch. An audit_logs row 'late_finishing_batch_created' records batch, quantity, prior status, lots, and whether the status revert succeeded; if the revert fails the batch still exists and the operator is told to raise it before TCO. Complete (TCO closed) jobs are deliberately excluded — custody has transferred; makeup pieces ride a re-queue. On a combined-run host a late batch counts toward the host's own share (allocate_merged_batch already ran and is a no-op thereafter).
**Why:** Jobs get closed before the last parts arrive at finishing (J-000208, QL8C62-1: four approved batches, 563 sent, then 168 more pieces). Each instance was a SQL fix. The finishing operator now handles it from the station, through the normal batch pipeline, with the job's status kept honest until compliance sees the parts.
**Files:** src/pages/Finishing.jsx.

**Amendment (2026-08-31):** A late batch also re-derives jobs.good_pieces (+ batch quantity) in the same write as the status revert, matching the D-DATA-02 SQL fixes that set good_pieces to the new send total — good_pieces is the pieces-off-the-machine count and the late parts came off the machine. The advance gate (Σ non-rejected sent ≥ good_pieces) is unaffected; the reporting figure no longer understates. post_mfg_good_qty is compliance's figure and is untouched; a later rejection of the batch leaves good_pieces overstated by it, as the D-DATA-02 fixes accepted. The audit row records good_pieces_before/after; the modal previews the new count.

### D-RPT-13 — Part History: interactive report by part number, assembly and component lenses (2026-09-01)
**What:** reports.report_kind (nullable; null = flat registry report) and a registry row 'part-history' with report_kind 'part_history', universal view, export admin/president/scheduler/compliance/customer_service/purchaser. Helper _ph_job_rows(component_id, work_order_ids) returns one row per production job (non-maintenance, non-standalone) with sent / verified / approved-good / rejected (Σ quantity of rejected batches) / scrap (Σ compliance_bad_qty on approved batches) / batches / PLN / every material lot from job_materials and material_loads / RQ and combined-run markers, and an effective quantity by the effectiveQty.js precedence in SQL (latest outsourcing return step → Σ compliance-approved batch good → good_pieces → missed entries; missed added on top; merged_out_good subtracted for hosts; NULL when nothing has been made — planned quantity is never production). RPC report_part_history(p_part_number) (SECURITY DEFINER, STABLE, any active SkyNet user; NULL uid passes for the SQL Editor) returns one jsonb: kind from assembly_bom; part; SkyNet customer-order lines with open qty (ordered − fulfilled, zero when complete/cancelled) and WO allocations; Fishbowl open SO lines (SO status 10/20/25, Sale lines, matched on part_id or product_num) with remaining = ordered − shipped and the linked CO; the fb_part_inventory row; work orders reached through the part's jobs and through work_order_assemblies; the part's own jobs and lettered finishing batches. Assembly lens: assembly_runs (work_order_assemblies rows; assembled good/bad shown but blank until the assembly module is live) and components — one row per BOM line with produced (Σ effective of the component's jobs under the product's WOs), in flight, purchased received (component_lots via work_order_component_lots on those WOs), available = produced + purchased, builds = floor(available ÷ qty per), required_for_open = still_to_assemble × qty per, still_to_make, is_bottleneck, nested jobs/batches. Summary: open_order_qty, in_flight_qty, planned_not_started_qty, produced all time / 90 days, rejected and scrap totals, Fishbowl on hand / allocated / available / on order / open-to-ship, still_to_run = max(0, open − in flight − max(0, fb_available)); for assemblies still_to_assemble = max(0, open − max(0, fb_available)), buildable = min over components of builds, bottleneck_component, assemblies_short = max(0, still_to_assemble − buildable). Nothing is subtracted for assemblies already built — the assembly module is not live, so consumption is not tracked; when it is, consumed = (assembled good + bad) × qty per comes off available. Component lens: used_in — every assembly consuming the part with its open orders, free stock, Fishbowl open-to-ship, still_to_assemble, required of this part, this part's produced / in flight / purchased under that assembly's WOs, still_to_make. Component Fishbowl stock is out of scope until inventory is pulled into SkyNet (next phase); the mirror only holds parts on open SO lines. Frontend: src/components/reports/PartHistoryReport.jsx (type-ahead on parts; kind-specific cards; formula sentence with its numbers; components table with expandable per-component runs and batches; assembly runs; used-in; the part's own orders, Fishbowl, work orders, runs, batches; stacked CSV); Reports.jsx dispatches on report_kind before the flat view. Uncle Bob is not wired for this report — the advisor envelope is built around flat rowsets (D-RPT-06/07); a part-history envelope is a follow-up.
**Why:** SK35C38B1 ran for over a month across three large orders and repeated lot changes, and nobody could say how many had been made or how many were still owed without SQL — and the product's production lives on its components' jobs, not its own. Every number the shop needs to decide what still runs is now one search away with the derivation shown, from either end: the product tells you what it can build and which component holds it back; the component tells you what the products need of it. SkyNet's view (ordered − TCO'd, in flight) and Fishbowl's (ordered − shipped, stock) sit side by side so they never get confused for each other.
**Files:** Docs/migrations/2026-09-01_report_part_history.sql, Docs/migrations/2026-09-01_report_part_history_v2.sql, src/components/reports/PartHistoryReport.jsx (new), src/pages/Reports.jsx.

### D-PROD-READY — Production Display: Ready leaves the Running bucket (2026-09-02)
**What:** Machine Status buckets are now Running = derived running + staged; Setup; Down; and a fourth tile "Ready · Idle" = derived ready (blue — kiosk machine with queued work, nothing started) + derived idle (gray — nothing queued or active), with the split shown under the count and a hover title on each code. deriveMachineStatus and the Mainframe are unchanged; the machine total now sums five groups.
**Why:** Supersedes the May 18 bucketing that folded ready into Running. Mazak 5 sat at Ready on the Mainframe (queue of 5, no active job) while the board read 17 running / 0 idle — a machine nobody is at was inflating the producing count. Staged stays in Running because a non-kiosk machine never logs a start, so queued work is its only producing signal; a kiosk machine at Ready is the opposite case and the board should say so.
**Files:** src/pages/dashboards/ProductionDisplay.jsx.

**Amendment (2026-09-02):** The Ready/Idle split is gone — Matt: a machine with queued work that nobody has started is idle, and the board should say Idle. Derived ready now falls into Idle alongside derived idle; the fourth tile is plain gray "Idle" again, with no sub-caption, no per-machine tone, and no blue, and StatusTile is back to its original four colours and signature. What survives from the entry above is the part that mattered: ready is out of Running, so a kiosk machine with a queue and nothing started no longer inflates the producing count. The net change against the May 18 bucketing is now one condition — 'ready' dropped from the Running branch — plus the comment.

### D-S8-16 revised — Finishing-batch advance: no unresolved batch, no quantity gate (2026-09-02)
**What:** ComplianceReview.handleApproveBatch advances a job when it is at manufacturing_complete and no finishing batch is unresolved (compliance_status NULL or pending_compliance). The sent-vs-good_pieces comparison is gone. resolveCompletionStatus (Complete-Job path) already used this test; the two paths now agree. The backlog was swept by Docs/migrations/2026-09-02_advance_stranded_mfg_complete.sql (advance_stranded_mfg_complete: same next-status rule as resolveNextStatusAfterFinishing — pending external routing step → ready_for_outsourcing, else pending_tco; audit row 'mfg_complete_strand_advanced' per job; jobs with an unresolved batch held).
**Why:** D-S8-16 compared non-rejected sent to good_pieces. SKY74 (kiosk Complete sets good_pieces = Σ all sends, rejected included) made that comparison unreachable for any job with a rejected batch, and pre-SKY74 hand-entered counts never satisfied it either. On TEST, 55 jobs were stranded at manufacturing_complete with every batch resolved — some since May — which also meant their CO fulfillment never posted (SKY65 fires on entry to pending_tco), overstating open orders everywhere the figure is read, and pinned their work orders out of TCO (the 75 pending on PROD). A job whose batches are all resolved has nothing left for finishing to decide; whether it made enough is the shortfall system's question.
**Files:** src/components/ComplianceReview.jsx, Docs/migrations/2026-09-02_advance_stranded_mfg_complete.sql.

**Amendment (2026-09-02, reject-last):** the reject branch no longer returns early. A rejected batch skips the assembly check-in only, then reaches the same advance gate, allocation call, and refresh as an approval — so rejecting the last unresolved batch on a manufacturing_complete job advances it instead of stranding it. Previously the reverse ordering (reject first, approve last) worked and this one did not.

### D-S8-16 revised — effective quantity: all-rejected batches count as zero (2026-09-02)
**What:** effectiveQty.js step 2b and job_effective_qty() agree: when a job has finishing batches, all resolved, none approved, the effective quantity is missed entries only — never good_pieces. In-flight jobs (any batch pending) keep the good_pieces fallback. job_effective_qty() also now subtracts merged_out_good on its outsourcing and finishing branches, as the JS already did, so a combined-run host's CO is not credited for members' pieces. The stranded-job sweep (advance_stranded_mfg_complete v2) held all-rejected jobs until this landed; that hold can be lifted after both TEST and PROD carry this function.
**Why:** With the reject-last amendment a rejected batch can be the last resolution that sends a job to pending_tco, where SKY65 posts fulfillment from job_effective_qty(). Falling through to good_pieces (Σ all sends since SKY74) would have credited customer orders for parts that failed compliance.
**Files:** Docs/migrations/2026-09-02_job_effective_qty_all_rejected.sql, src/lib/effectiveQty.js.
