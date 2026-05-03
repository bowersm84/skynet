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

## Go-Live Hot-Fix Release (April 29, 2026)

Five hot-fixes plus four follow-up corrections shipped as a single coordinated release on go-live day. All five test cases verified on `test-skynet.skybolt.com` before promotion to prod. Migration file: `Docs/migrations/2026-04-29_golive_hotfixes.sql`.

### Phased machine rollout via `kiosk_enabled` flag
- **Decision:** Added boolean `kiosk_enabled` column to `machines`. Mazak 5 = true (Wave 1 pilot); all others default to false. New machines default false.
- **Why:** Go-live changed from "kiosk-only on Mazak 5, all others paper" to "all machines schedulable, kiosk only on Mazak 5". Needed a way to distinguish kiosk-driven jobs (which auto-create finishing_sends on completion) from manual jobs (which need a separate pickup mechanism).
- **Migration to next wave:** When a new machine gets a kiosk, flip the flag to true. No code change required — Wave 2/3/4 are config-only deploys.

### Manual finishing pickup queue for non-kiosk machines
- **Decision:** New "Awaiting Pickup" section in the Finishing screen. Lists scheduled jobs whose machine has `kiosk_enabled = false` and remaining qty > 0. James clicks Send Batch, enters incoming qty + mandatory PLN, system creates a `finishing_sends` row with status `pending_finishing`. Standard finishing flow takes over from there.
- **Why:** Non-kiosk machines have no automated path to finishing — parts arrive at James's station physically without any system event. The pickup queue gives him a way to register batches as they arrive without faking kiosk activity.
- **Multiple-send handling:** Same job can be pulled multiple times for partial batches (parts arrive sporadically). Existing batch-label system (A/B/C) handles ordering by `sent_at`.
- **Job status auto-flip:** When `assigned`/`ready` job gets first send, flip to `in_progress` and set `actual_start`. When total sent qty >= job qty, flip to `manufacturing_complete` and set `actual_end`. Mirrors what the kiosk does on Complete Job.
- **Filter:** Excludes `is_standalone_finishing` jobs (those have their own Start New Job entry path).

### Mandatory PLN on Send Batch, sticky on parent job
- **Decision:** Send Batch modal has a mandatory Production Lot # field. On Batch A, James types the PLN from the paper traveler. On submit, PLN is written to `jobs.production_lot_number` AND to the new `finishing_sends` row. On Batch B+, the field pre-fills from the job's stored PLN.
- **Why:** Non-kiosk PLNs are hand-written by the machinist on the paper traveler — no automated PLN generation for these. James must capture them once per job, but typing the same number on every batch is tedious and error-prone. Sticky-on-job pattern means once captured, it inherits.
- **Format:** No SkyNet enforcement — the PLN is whatever the machinist wrote. (Skybolt's pre-existing PLN formats predate SkyNet and won't match `PLN-YYMMDD-XXXX`.)
- **Pattern for future fields:** "First entry sets the value on the parent record; subsequent entries inherit and pre-fill." Useful anywhere repeated entry across child rows is wasteful.

### FLN format change to global 6-digit sequence
- **Decision:** New finishing lot numbers use format `FLN-NNNNNN` (e.g. FLN-100000, FLN-100001), backed by a Postgres sequence `finishing_lot_seq` starting at 100000. Existing FLN-YYMMDD-XXXX values in the DB remain valid; format change applies only to newly generated lot numbers.
- **Why:** Compliance requested simpler, sequential FLNs that match how they're tracked elsewhere in their paperwork. The date-coded format wasn't aiding traceability; the global sequence is easier to reference and compare.
- **Implementation:** New RPC `next_finishing_lot_number()` returns `nextval('finishing_lot_seq')`. JS formats as `FLN-${6-digit-padded}`. PLN format unchanged (still PLN-YYMMDD-XXXX).
- **Backward compatibility:** Display logic doesn't care about format; existing batches with the old format continue to render and reference correctly.

### Standalone J-FIN batches skip post-mfg compliance
- **Decision:** When a finishing batch with `is_standalone = true` completes its last stage, instead of setting `compliance_status = 'pending_compliance'`, auto-approve the batch (set `compliance_status = 'approved'`, `compliance_outcome = 'accepted'`, `compliance_good_qty = verified_count`, `compliance_approved_by = operator.id`, `compliance_approved_at = now`) and mark the parent J-FIN job `complete` with `actual_end = now`, `good_pieces = verified_count`.
- **Why:** James's Start New Job feature creates J-FIN jobs for parts that arrived from outside (purchased springs, customer-supplied, vendor returns). These have no upstream Skybolt machining flow, so post-mfg compliance review has nothing to gate on — Roger has nothing to verify. Routing them to his queue created friction without value.
- **Scope:** Applies only to `is_standalone = true` batches (i.e., created via the Start New Job modal). Standard kiosk-originated batches still go to compliance.

### Auth listener deadlock fix
- **Decision:** `onAuthStateChange` callback in `App.jsx` is no longer `async`. The `SIGNED_IN` body is wrapped in `setTimeout(0)` so async work runs outside Supabase's internal auth lock.
- **Why:** Supabase's auth-js library acquires an internal mutex during `onAuthStateChange` callbacks. Awaiting another Supabase query inside the callback (e.g., `fetchProfile`) deadlocks because the query also needs the lock. Symptom: refresh hangs indefinitely at "Initializing SkyNet…" with the console showing `Fetching profile for: ...` and no completion log.
- **Pattern for future listeners:** Keep `onAuthStateChange` callbacks synchronous (non-async). Wrap any async work inside `setTimeout(fn, 0)` to defer outside the lock.
- **Documented at:** `https://supabase.com/docs/reference/javascript/auth-onauthstatechange` ("Avoid using async functions as callbacks. Limit the operations performed inside an async callback. Failing to do so may result in a deadlock.")

### Searchable product picker (Create Work Order)
- **Decision:** Replaced native `<select>` with custom searchable combobox in `CreateWorkOrderModal.jsx`. Filters by part_number, description, and customer; groups results by part_type (Products / Finished Goods / Manufactured Parts).
- **Why:** Native `<select>` was unusable at ~1000 products — April couldn't find what she needed. Combobox supports type-ahead filtering with the same grouping the original optgroups had.
- **Layout fix:** Combobox required `min-w-0` on both the wrapper div and the button itself to allow text truncation. Without it, long descriptions forced the cell wider than its grid `1fr` allowance and pushed Order Qty / Stock fields off-screen. Native `<select>` had no problem because browsers handle overflow internally; custom controls have to declare it.
- **Pattern:** Any custom button or input rendered inside a flex/grid cell needs `min-w-0` if its content can be longer than the cell's allotment. This applies anywhere we replace a native control with a custom one.

### Citric Acid + Alkaline Mix lot fields in Start New Job
- **Decision:** Added two text inputs to the Start New Job modal: Citric Acid Lot # and Alkaline Mix Lot #. Pre-fill from the most recent batch (same `getCurrentChemicalLot` / `getCurrentChemicalLot2` helpers Start Batch uses). User can edit if either drum has changed.
- **Why:** The standalone job creation was silently writing the most recent chemical lot numbers without showing them — James had no visibility or control. When the chemicals actually changed, the wrong values got written invisibly. The visible-and-editable pattern matches what Start Batch already does for the kiosk-originated flow.

### Test/Prod sync discipline (process decision)
- **Decision:** Every release with SQL migrations checks the migration into `Docs/migrations/YYYY-MM-DD_<release-name>.sql`. Same file is run on TEST Supabase first (with code merge to test branch), then on PROD Supabase (before code merge to main). Verification SELECTs included at the bottom of each migration file. Single source of truth.
- **Why:** Prior to this discipline, schema drift between test and prod caused multiple late-stage debugging cycles. Encoding the rule "SQL and code travel as one unit" prevents the most common drift scenario (SQL ran on one but not both).
- **Documented:** Updated `SkyNet_Test_Environment_Cheat_Sheet` to v1.1 with explicit Section 2.2 (CR with SQL Migration) and 2.3 (Coordinated Multi-Change Release) procedures.

### Multi-change release pattern (process decision)
- **Decision:** When multiple fixes ship together as a coordinated release (this go-live, future sprint cutovers): use a single feature branch (e.g. `feature/golive-hotfixes`), commit each fix individually for clean history, consolidate all SQL into one migration file, validate ALL test cases on test before promoting any to prod, then merge feature branch to main as a single unit.
- **Why:** Independent CRs each get their own merge-to-main cycle. A coordinated release wants one validation cycle and one rollback target. Treats the bundle as one release.
- **Trap encountered:** During iteration on this go-live, four follow-up commits landed on `test` branch directly (not via the feature branch) and missed the initial main merge. Recovery was clean (`git merge test → main`), but the lesson is: always commit follow-ups to the feature branch, not directly to test, OR use `test → main` as the standard promotion path for releases.

---

## Operational Notes (added April 29, 2026)

### Vite local dev environment variables
- **Pattern:** `.env.local` at repo root with TEST credentials (URL, anon key, `VITE_ENV_LABEL=test`). Vite loads it automatically; `npm run dev` then hits TEST Supabase by default. The amber TEST banner renders in the browser as a visible safety indicator.
- **Why test by default:** During go-live and active development, accidentally pointing local dev at prod is a real risk. Defaulting to test removes the "wait, am I about to delete prod data?" moment.
- **Restart required:** Vite reloads code on save but does NOT reload env vars. Must Ctrl+C and `npm run dev` again after changing `.env.local`.
- **Gitignore:** `.env`, `.env.local`, and `.env.*.local` must all be in `.gitignore`. Verified before creating the file.

### Phased rollout — currently configured machines
| Wave | Machines | kiosk_enabled |
|------|----------|---------------|
| Wave 1 | Mazak 5 | true |
| Wave 2 (planned) | Patrick's machines | false (flip when tablets installed) |
| Wave 3 (planned) | Jeff's machines | false |
| Wave 4 (planned) | Carlos's machines | false |
| Tavares | Mazak 7, Nexturn 1 | false (no current finishing path) |

To advance a machine to kiosk-driven flow: `UPDATE machines SET kiosk_enabled = true WHERE name = '<machine name>';` Job assignments are not affected; only the finishing entry path changes.

### CC prompt for follow-up corrections (lessons from go-live day)
- When a fix produces a follow-up bug (column doesn't exist, layout overflow), diagnose with browser console + targeted SQL before writing the next prompt. Skipping that step costs more iterations than it saves.
- For React/CSS layout bugs in custom components replacing native ones: always check `min-width: auto` (default for flex/grid items) — explicit `min-w-0` is what allows truncation.
- For Postgres `42703` errors (column does not exist): the column is on a related table, not the queried one. Check the join, drop the bare reference, keep the joined-table reference.

---

## Sprint 5 — Customer Orders & Demand Pool (May 1, 2026)

Sprint completed end-to-end on TEST in a single day. Pending April sign-off Monday before promotion to PROD.

### Why we built it

April manages customer orders entered into Fishbowl (their existing ERP) by hand. Production demand accumulates as multiple customer orders for the same part across different customers, which she then groups into a single production run on a single machine — the "lump multiple customer orders into one work order" pattern. Pre-Sprint 5, SkyNet had no concept of this: one Work Order = one customer's order, with customer name as a free-text field on the WO. The data model could not represent the lump-many-into-one workflow she described.

### Two-tier demand model — Customer Orders sit above Work Orders

- **Customer Orders** capture demand: what a customer asked for, quantity, due date, priority, PO number, Fishbowl reference.
- **Work Orders** capture production decision: what we're running, when, on which machine, how many to make.
- **Allocations** are the junction: one CO line can be split across multiple WOs (partial allocation); one WO can be fed by multiple CO lines from different customers (combined run).

The WO/Job relationship is unchanged. COs sit *above* WOs and don't touch compliance, production, or finishing. This made the change scope-limited despite touching a fundamental data concept.

### Parent-child CO model with per-line allocation

A real Fishbowl purchase order can list multiple part numbers. Decision: model that as one Customer Order header with N line items, not three separate COs sharing a PO. This added master-detail complexity to the UI but matched the real-world data shape and avoided users having to invent multiple PO IDs for one PO.

Schema:
- `customer_orders` (header): co_number, customer_id (FK), fishbowl_order_id, po_number, status, audit fields.
- `customer_order_lines` (children): part_id, quantity_ordered, quantity_fulfilled, due_date, priority, line_status.
- `customer_order_allocations` (junction): customer_order_line_id, work_order_id, quantity_allocated, is_active.

The `is_active` flag on allocations (rather than DELETE on cancellation) preserves the historical record. Cancelled allocations stay queryable but are excluded from "active" totals.

### Customers as foreign key, not free text

Pre-Sprint 5, `work_orders.customer` was free text. Decision: introduce a `customers` master table keyed by Fishbowl customer ID (1-6 numeric chars), referenced by FK from `customer_orders.customer_id`. Customer ID becomes the canonical key everywhere; the customer name is a denormalized convenience for display.

Workflow consequence: April uploads a one-time CSV export of all Fishbowl customers into the new Customers tab in Armory at go-live. New customer onboarding goes Fishbowl-first then SkyNet-first — Fishbowl is the source of truth, SkyNet mirrors.

### CO number format: `CO-<custid>-<orderid>`

Mirrors the WO format pattern but uses real Fishbowl identifiers rather than a sequential SkyNet counter. Format example: `CO-1018-TEST5241`.

Risks evaluated:
- Manual entry friction → mitigated by typeahead in the customer picker.
- Special characters in Fishbowl order IDs → strip non-alphanumeric on blur (`/[^A-Z0-9]/gi`).
- Manual COs without Fishbowl record → workflow rule: "Fishbowl always first." Not enforced by the system; if April creates a CO with a fake order ID, the system accepts it.
- Multi-part PO collision → resolved by parent-child model (one CO covers one Fishbowl order, regardless of part count).

### Status simplified to four values, trigger-driven

Both parent CO and lines use the same status set: `not_started`, `in_progress`, `complete`, `cancelled`. Status is denormalized on the row and maintained by triggers on allocation changes and line fulfillment events.

Why triggers over computed views: the status drives UI filter chips, list grouping, and badge rendering. Computing it on every read at the join level is expensive; computing once at write time and caching denormalized is cheap. Triggers ensure every write path arrives at the same answer regardless of which surface initiated the change.

Cancellation is sticky in the trigger logic — once a line or CO is cancelled, status doesn't recompute back. If un-cancellation is ever needed, it would be a manual SQL operation; we have not yet seen the need.

### Demand-driven WO creation (mid-sprint pivot)

Initial Batch C built a part-first flow inside the Create WO modal: pick a part, see open COs for that part, check the ones to include. Matt review identified that this is backwards from how schedulers actually think — they look at demand first, then decide what to run. Schedulers visualize the pool of pending demand across all customers, identify a part with enough total qty to justify a production run, and roll it. Forcing them to know the part first means they need a separate spreadsheet to track demand outside the system.

Solution: added a Demand tab to the Customer Orders module. Lines aggregated by part, sorted by total demand descending. Each part group expands to show contributing CO lines. Multi-select within a single part group only (cross-part selection blocked with an inline warning). "Create Work Order from Selection" button feeds the modal with pre-selected lines.

The original in-modal CO checklist was retained as a secondary path: if a user lands in Create WO via the Mainframe "New Work Order" button (typically for stock builds), and the chosen part happens to have open COs, they can still pick them in the modal. The Demand tab is the primary path for demand-driven runs; the modal in-line picker is the fallback for stock-build-mixed-with-demand.

### Strip Customer/PO/Order Type from Create WO modal

With CO linkage now the source of truth, manually entering customer or PO on a WO conflicts with derived data. Removed the manual fields entirely along with the MTO/MTS toggle. Values now derive from linked COs at WO insert time:
- 0 COs linked → `order_type = 'make_to_stock'`, customer/po null, is_combined false.
- 1 CO linked → `order_type = 'make_to_order'`, customer/po denormalized from the CO, is_combined false.
- 2+ COs linked → `order_type = 'make_to_order'`, customer/po null (UI displays "Multi-Customer"), is_combined true.

The orderQuantity field also becomes read-only when allocations are present — the sum of selected allocations is the order qty by definition. User can still add stock_quantity on top for "fulfill demand + build extra for inventory."

### Allocation drill-down with WO deep-link

April's review of the CO surface raised a UX question: seeing "Allocated: 450" on a CO line gave no path to the actual WO that allocation lives on. Added click-to-expand on part numbers in the CO line sub-table — the part number renders as a purple underlined button when allocations exist (plain gray when none). Expanded panel shows each active allocation with WO #, status, due date, qty. Clicking any WO row inside the panel deep-links to Order Lookup → Work Orders tab with the WO # pre-filled in search.

The deep-link uses an `onNavigateToWO` prop pattern: when `CustomerOrders` is embedded inside Mainframe's Order Lookup, the parent passes a handler that flips tabs + sets search. When standalone, it falls back to a top-level navigation. Reuses existing UI rather than inventing a new WO detail surface.

### Cancellation v1 (banner + manual ack; decision UI deferred)

When a CO line is cancelled and had active allocations to live WOs:
1. Line status flips to `cancelled` (sticky).
2. All active allocations for that line flip `is_active = false`.
3. Affected WOs flip `has_cancelled_allocation = true`.
4. Mainframe WO Lookup, Schedule timeline, and Order Lookup show an amber banner / amber outline on those WOs.
5. Admin/scheduler clicks Acknowledge → flag clears, audit log entry written.

Deferred to Sprint 6: the 3-option decision flow (reduce remaining qty / convert to stock / keep as-is). For now the user manually decides and edits the WO themselves. Acceptable for go-live; April's expected cancellation rate is low.

### Order Lookup rename + sub-tabs

WO Lookup → Order Lookup with two sub-tabs: Work Orders (existing surface) and Customer Orders (embedded `CustomerOrders` component). Standalone Customer Orders page (top-level Mainframe nav for admin/scheduler/customer_service) also retained — gives April two entry points for the same data depending on whether she's already looking at a WO or starting from CO context.

### What we did NOT change

- Compliance flow.
- Kiosk, Finishing, Outsourcing.
- Job Traveler builder (only added a new section reading from the new tables).
- WO/Job creation logic past the modal — assemblies/jobs still create the same way, routing copy-down still works the same way.
- Effective qty / batch qty / outsourcing per-batch model.

This containment was deliberate. Customer Orders are upstream of all production machinery; we did not want to risk regression in shipping floor surfaces.

### Velocity & build pattern

Original estimate 8–12 days. Compressed to one day through:
- Aggressive scope cutting (cancellation decision UI deferred, per-shipment tracking deferred, customer detail page deferred).
- Surgical-prompt CC pattern (read prior docs, exact files/lines, no rewrites).
- Test-only deployment — no prod risk during build.
- Three batches A/B/C with smoke tests between each, plus a mid-sprint Batch C revision when Matt review surfaced the demand-driven pivot.

### Decision: continued use of Customers tab as Armory sub-tab vs top-level

Customers data is master data. Master data lives in Armory. Customers tab joins Parts/Materials/Bar Sizes/Routing Templates/Material Master/Inventory/Receiving/Users as another sub-tab. Tab is gated to admin/scheduler/customer_service.

### Decision: Customers can be deleted via DELETE policy, but should rarely be

DELETE policy added for symmetry with other tables (RLS audit pattern requires all four cmd policies). In practice, a customer with any historical CO will have FK references, so DELETE will fail with FK violation. Soft delete (toggle `is_active = false`) is the intended path for retiring customers; DELETE is for cleanup of accidentally-created records before they're used.

### Lessons added to the playbook

1. **Two-tier demand model.** When data conflates "what was asked" with "what was decided," any aggregation case (combine multiple asks into one decision) breaks the model. Split early.
2. **Derive, don't enter.** When a value is computable from linked records, don't ask the user. Customer/PO on WO is the canonical case here.
3. **Trigger-driven status.** Denormalize status to the row, maintain via PL/pgSQL triggers on the events that change it. Every write path arrives at the same answer.
4. **Demand-first UI beats part-first UI for schedulers.** They think in pools, not parts.
5. **RLS audit pattern continues to pay.** Split policies by cmd; the standing pg_policies query catches missing ones.
6. **Junction tables vs. parent FK.** When you need many-to-many or partial relationships, the junction is the right answer even if it adds UI complexity. Avoid FK-on-parent shortcuts that don't extend.

## Post-Assembly Outsourcing & Assembly Routing (Sprint 6 — May 3, 2026)

### Assemblies are now first-class routable entities
- **Decision:** Assembly parts (`part_type IN ('assembly', 'finished_good')`) carry routing in `part_routing_steps` the same way components do. The first step is always `Assemble` (internal); additional steps (Paint, Heat Treatment, etc.) are added as needed in the master route.
- **Why:** The fan-in pattern (components manufactured → converge at assembly) was implicit. Making the `Assemble` step explicit on a route lets us hang downstream steps (paint, engraving, future inspection) off the same routing engine that already handles component external steps. No special-casing — the routing engine just runs.
- **Reused `part_routing_steps`** rather than building a parallel master table. The `part_id` FK is part-type-agnostic; we just start populating rows for assembly/FG part_ids. Backfill seeded the standard `Assemble` step on every existing assembly/FG part on May 3.

### Runtime copy: `work_order_assembly_routing_steps`
- **Decision:** Per-WOA routing copy lives in a parallel runtime table that mirrors `job_routing_steps` exactly (status, modification tracking, production data fields, FKs to profiles).
- **Why:** WOA-level routing needs its own runtime because a WOA represents a distinct production unit from any single component job. Same status enum, same removal/addition workflow, same drag-and-drop reorder UI patterns can be reused.
- **Backward compatibility:** WOAs without rows in this table fall through to the existing single-step Assemble flow (no behavior change for the 95% case).

### Polymorphic `outbound_sends`
- **Decision:** `outbound_sends.source_type` is constrained to `('finishing_send', 'work_order_assembly')` with `source_id` pointing to whichever entity. Legacy `finishing_send_id` and `job_routing_step_id` columns retained for backward compatibility but the polymorphic columns are the canonical path going forward.
- **Why:** One outsourcing workflow, two upstream sources. Ashley's send-out and return UX is identical whether the box of parts came from finishing or from assembly. Doubling the table or building a parallel `assembly_sends` would force her to learn a second workflow for what is mechanically the same operation.
- **Future-proof:** `source_type` enum can be extended (e.g., `'purchased_part'` for James's external passivation queue, item #104) without further schema migration.

### Batch sending happens at the Assembly step (not OutsourcedJobs)
- **Decision:** Jody sends partial qty to outsource directly from the Assembly module — same UX pattern as the kiosk's "Send to Finishing" button. Auto-creates an `outbound_sends` row with `source_type='work_order_assembly'`, `sent_at=NULL`, `vendor_name=NULL`. On Complete Assembly, the remaining qty auto-creates a final `outbound_sends` row.
- **Why:** Mirrors the established kiosk → finishing batch flow, which Jody and the team already understand mentally. Ashley's OutsourcedJobs UI sees these as "Ready to Send" cards exactly like the existing finishing batches; she fills in vendor + sent_at when actually shipping.
- **No intermediate `assembly_sends` table:** unlike finishing (which has its own multi-stage processing), assembly outsourcing has no in-house intermediate. The `outbound_sends` row IS the batch entity from the moment Jody marks it ready.

### No post-assembly compliance gate
- **Decision:** Assembly Complete branches directly to `ready_for_outsource` (if downstream external step exists) or `pending_tco` (if not). Roger does not review assemblies before they go to paint.
- **Why:** Per April (04/15/26) and Matt's confirmation in S6 design discussion, the team doesn't gate finished assemblies before vendor send-out — that gate exists for finishing batches only. TCO covers final QC after parts return from the vendor.
- **Implication:** Removing this from scope cut ~4 hours of UI/workflow work. Symmetry with the post-finishing compliance gate was tempting but not required by the actual workflow.

### Assembly Lot Number — manual entry, automation deferred
- **Decision:** New `assembly_lot_number text` column on `work_order_assemblies` plus tracking columns (`assembly_lot_entered_by`, `assembly_lot_entered_at`). Operator types the ALN from the existing manual logbook at Start Assembly. No `lot_number_sequences` row, no auto-generation in S6.
- **Why:** The team currently maintains a paper logbook for assembly lot numbers. Forcing system-generated ALNs in S6 would mean operators would need to track *both* their handwritten book and the system number until adoption settled — a recipe for divergence. Capturing the existing book number digitally is the bridge step. Auto-generation will fold in later once the digital workflow is the source of truth.
- **Vendor return lot:** Same pattern. Skybolt currently assigns 5-digit lot numbers manually when parts return from vendors. Captured manually in `outbound_sends.vendor_lot_number` (existing column) for now. Auto-generation deferred.

### WOA status enum extended
- **Decision:** `work_order_assemblies.status` CHECK now includes `ready_for_outsource`, `at_external_vendor`, `pending_tco` in addition to the original four (`pending`, `in_progress`, `paused`, `complete`).
- **Why:** WOA status is the granular truth for the parent WO's post-assembly state. The WO-level status remains coarse (`in_assembly` / `complete`); WO Lookup surfaces the WOA detail line ("Out for Paint · Vendor Name") so Roger doesn't have to drill in.
- **Status flow:**
  - `in_assembly` → (assemble step complete + external step exists) → `ready_for_outsource`
  - `ready_for_outsource` → (Ashley logs first send-out) → `at_external_vendor`
  - `at_external_vendor` → (all sends returned) → `pending_tco`
  - `pending_tco` → (TCO sign-off) → `complete`
  - If no external step: `in_assembly` → `pending_tco` directly (existing flow, unchanged)

### Routing templates split: component vs assembly
- **Decision:** New `routing_templates.template_type` column with CHECK `('component','assembly')`. Existing 4 templates (Stainless, Steel, Heat-Treat Steel, Aluminium) defaulted to `'component'`. Three new assembly templates seeded: `Standard Assembly`, `Painted Assembly`, `Heat-Treated Assembly`.
- **Why:** Same templates table, two distinct domains. The Armory Routing Templates tab toggles between Component and Assembly views. Component templates only show in component edit modal; Assembly templates only show in product edit modal. Keeps the master data UI from becoming a soup of unrelated routes.

### What we did NOT change
- Component-level routing flow (`job_routing_steps` and the kiosk → finishing → outsourcing pipeline).
- Compliance review module (post-finishing compliance gate untouched).
- TCO module (still the catch-all final gate).
- Existing `outbound_sends` rows or workflow — legacy `finishing_send_id` column retained, polymorphic columns added alongside.
- `routing_templates.material_category` semantics for component templates.

This containment was deliberate. Post-assembly outsourcing is additive — it activates only when a WOA has an external routing step. Default Standard Assembly route (Assemble only) means the 95% case behaves exactly as it did before S6.

### Lessons added to the playbook
1. **Polymorphic source columns beat parallel tables** when one downstream workflow serves multiple upstream sources. Saved a table and a parallel UX in this sprint; will absorb the purchased-parts queue later.
2. **Backward-compatible defaults are free with a backfill.** Seeding the standard "Assemble" step into every existing assembly/FG part means nothing breaks for in-flight WOAs.
3. **Manual entry now, automation later.** Capturing existing paper-book numbers digitally is the lower-friction bridge to full automation. The schema accommodates both modes.