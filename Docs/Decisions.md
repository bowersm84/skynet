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