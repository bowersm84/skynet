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

### D-S8-17 — Auto-fulfill on RQ advance (DESIGNED, post-v3.1)
- **Decision:** When a re-queue job (identified by `job_shortfall_resolutions.requeue_job_id`) advances past compliance review, auto-fulfill the WO's active CO allocations from its `good_pieces`. Distribution: FIFO by `due_date` asc, then priority (`critical > high > normal > low`). Per-allocation cap = min(remaining good_pieces, CO remaining, WO commitment remaining). Excess flows to stock.
- **Idempotency:** Guarded by `job_shortfall_resolutions.fulfillment_applied_at` timestamp. Re-firing is a no-op.
- **Status:** Schema column applied to prod May 15 (idempotency migration). Helper code (`src/lib/coFulfillment.js`) drafted but not shipped. Operational interim: RQ jobs leave CO commitments showing "Remaining" until manual SQL close (the LSI pattern). Roger and April briefed.

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

## 2026-05-18 — Conditional chemical lot fields (passivation chemicals are stainless-only)

Citric Acid and Alkaline Mix lot fields in the Finishing Station Start Batch modal (and the Compliance review screen) now hide for parts whose material category doesn't require passivation chemicals. Operational truth: only stainless-based parts go through the citric/alkaline passivation. Steel and aluminum skip the chemicals entirely. Previously every batch showed and required the two lot fields, forcing operators to fake-fill them for non-stainless batches — a real data-integrity issue.

**Predicate.** `src/lib/materials.js` exports `REQUIRES_CHEMICALS_CATEGORIES = ['Stainless', 'Pre-Formed']` and `requiresChemicals(part)`. Pre-Formed (blank studs) is included because the blanks are stainless underneath. Categories explicitly NOT requiring chemicals: Steel, Aluminum, Brass, Titanium. Defensive default: if the category can't be determined (NULL `material_type_id` or missing join), return `true` so the operator is prompted to verify rather than the system silently skipping required data.

**Schema.** No migration. `finishing_sends.chemical_lot_number` and `chemical_lot_number_2` were already nullable. When chemicals aren't required, the form persists NULL for both — not empty strings — so the DB stays clean.

**Query enrichment.** Every place that loads a job with its part for the finishing flow now joins `material_type:material_types(category, name, short_code)` so the predicate can resolve without an extra fetch. Touched queries: `Finishing.jsx` pending + active batch loaders, `ComplianceReview.jsx` pending-batches loader, and `Mainframe.jsx`'s top-level jobs loader (the source that feeds ComplianceReview the manufacturing-complete job objects).

**Compliance gets the same rule.** Roger's review surface hides the chemical fields for non-stainless batches; the predicate is identical (`requiresChemicals` from the same helper). Applied in both display sites: per-batch traceability grid and per-job latest-send grid.

**Optional helper text** rendered in place of the hidden fields: "Chemical lot tracking not required for [steel/aluminum/...] parts." Subtle, italic, fits existing kiosk helper-text style.

**Validation.** The Start Batch button now blocks when `needsChemicals && (!citricAcidLot || !alkalineMixLot)`. Pre-fix the button was already only gated on incoming count — chemical lots were merely warned-on. Tightening this side along with the hiding so stainless batches actually require the values they're prompted for.

**Future-proofing.** Adding a new category to the chemicals-required set (e.g., a custom alloy that needs the same passivation) is a one-line edit to `REQUIRES_CHEMICALS_CATEGORIES`. No code changes elsewhere.

**Resolves blocked workflow:** J-000025 (SK4-6P, -6 Stud Steel) which was sitting in James's Incoming Queue unable to start because the chemical fields were required for a part that doesn't need them.
