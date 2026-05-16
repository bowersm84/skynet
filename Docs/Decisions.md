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