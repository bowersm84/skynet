# SkyNet MES — Sprint 12 Implementation Plan

**Sprint 12 — Order Queue UX: structured components, releases, production dates, part-build requests**

Implementation Plan v1.0 · September 30, 2026

**Owner:** Matt Bowers
**Status:** Batch A database applied on TEST 2026-09-30 (Claude); Batch A frontend prompt delivered; Batches B–C queued behind A's ✅.

---

## 1. Sprint Goal

Give the order processors and Customer Service what they need on the Order Queue without opening a work order: which components an order is waiting on, when production will have them done, a way to hand an unknown part to Roger, and a demand pool that shows a customer's release schedule instead of one lump.

## 2. Background

Round FB1 (v4.4, D-FB-01…38) mirrored Fishbowl sales orders and gave the warehouse a Create CO path. Three of its choices are the root of the five asks on 2026-09-30:

- D-FB-27 took "Components Needed" as free text ("Need cups and studs", "Manu."). Nothing downstream can act on it.
- D-FB-26 combined every Fishbowl line of one part into one CO line with the earliest date. SO 19146's five SK-OS release lines (3/26/27 … 12/31/27) became 20,630 pcs due 3/26/27; four other open lines carry the same merge (all allocated to pending WOs).
- Nothing in the queue reads `v_co_line_dates` (D-CODATE-01/02), so CS could not see a target or a scheduled finish, and the 45-business-day target ignored a customer's later requested date.

Unresolved Skybolt parts (6% of open lines) need Roger to build the part in the Armory; today that is a hallway conversation. No app-level email sender exists (SES serves Supabase Auth mail only).

## 3. Decisions Locked (Matt, 2026-09-30)

| # | Decision |
|---|----------|
| 1 | One CO line per Fishbowl line. No combining at conversion; like parts are combined at Create WO if the scheduler wants one run. |
| 2 | Split every combined line with no work order (D-FB-46: SK-OS and CO-687-19325 SK2600-3W on PROD). The four on work orders (CO-2311-19121 #1, CO-6256-19146 #4/#6/#8) stay combined. |
| 2a | CO line number = Fishbowl line number everywhere, kept in step as Fishbowl renumbers (D-FB-45). |
| 3 | Target date = later of (entered + 45 business days) and a real Fishbowl due date (D-CODATE-04). |
| 4 | Component picker: nothing pre-checked, at least one required. A Purchase disposition on a part with a BOM must name the component(s) being bought. |
| 5 | Alert Roger: email to rdanforth@skybolt.com only, bell notification to Roger only; click rights order_processor + admin. Recipients are always SkyNet users. |
| 6 | Email transport: SES HTTPS API (`@aws-sdk/client-sesv2` in the Edge Function) with an IAM key scoped to `ses:SendEmail` — no raw SMTP from the edge runtime. Matt creates the key (can hang off the existing SES SMTP IAM user). |
| 7 | Prod Due = scheduled finish (last component off the machine), else the SkyNet target tagged T. UI states that assembly, plating and finishing are not included. |

## 4. Scope

### 4.1 In scope
- `customer_order_line_components` + picker in Create CO; chips on Demand / Orders / Create WO; Edit CO editing (Batch C).
- `fb_line_purchase_components` + PurchaseComponentsModal.
- `fb_convert_to_co` v4 (per Fishbowl line), `fb_set_disposition` v2, `co_line_set_components`.
- `v_co_line_dates` v3 (later-of target, merged-job follow), `v_co_line_component_status`.
- Order Queue: Prod Due column, line dropdown (LineDetailPanel).
- SK-OS release split one-shot (TEST done, PROD pending).
- Part build requests: `part_requests` table, `request_part_build` RPC, Alert Roger button/modal, Compliance Review worklist, Mainframe KPI, bell notification, `notify-email` Edge Function, auto-close on re-resolution.

### 4.2 Out of scope (named)
- Splitting the four allocated merged lines (would need allocation moves on pending WOs).
- Pre-selecting Create WO job leaves from the CO line's components (natural follow-up).
- A purchaser worklist for `fb_line_purchase_components` (the list is visible in the line dropdown only).
- Email for anything other than part-build requests (price lists, replenishment) — the sender is built to be reused.

## 5. Schema

### 5.1 Batch A (applied on TEST 2026-09-30, migration `2026-09-30_D-FB-42_co_line_components_releases.sql`)
- `customer_order_line_components (id, customer_order_line_id FK cascade, component_id FK parts, created_by, created_at, UNIQUE(line, component))` — RLS SELECT authenticated, no write policies.
- `fb_line_purchase_components (id, fb_soitem_id FK cascade, component_id FK parts, created_by, created_at, UNIQUE(line, component))` — same posture.
- `_co_line_component_ok(part, component)` — component = part or a non-cycle node of `explode_bom(part, 1)`.
- `fb_convert_to_co(int, int[], jsonb)` v4 — same signature; `p_components = {part_id: {components:[uuid], note}}`; one CO line per Fishbowl line; result shape unchanged (`lines_added` always 0).
- `fb_set_disposition(int[], text, text, jsonb)` — 3-arg dropped; purchase rule as in §3.4.
- `co_line_set_components(uuid, uuid[], text)` — gate order_processor / admin / customer_service; open lines only; audits `co_line_components_set`.
- `v_co_line_dates` v3; `v_co_line_component_status` (states: no_job / unscheduled / scheduled / running / made; jobs jsonb).
- Backfill: open lines on BOM-less parts → self. TEST: 27 rows; 55 open assembly lines still free-text only (their dropdown shows WO-derived components).
- TEST verify: `convert_v4 1 · set_disp_4arg 1 · set_disp_3arg 0 · views 2 · anon grants 0 · target_moved_later 26`.

### 5.2 Batch B (to write)
- `part_requests (id, product_num, part_num, description, fb_so_id, fb_soitem_id, so_number, customer_name, qty_remaining, due_date, note, requested_by, requested_at, status open|built|dismissed, resolved_by, resolved_at, resolution_note, part_id, email_status pending|sent|failed, email_sent_at, email_error)`; partial unique index on `upper(product_num)` where status = 'open'.
- `notification_recipients (event_type, profile_id)` seeded with ('part_request', rdanforth) by username lookup — drives both the bell and the email; no UUIDs in the file.
- `request_part_build(p_fb_soitem_id, p_note)` — gate order_processor / admin; line must be an unresolved open product line; inserts, audits, notifies recipients; returns the row.
- `part_request_resolve(p_id, p_status, p_note, p_part_id)` — gate compliance / admin.
- `part_request_mark_email(p_id, p_status, p_error)` — called by the Edge Function with the service role.
- `fb_reresolve_lines` v2 — closes open requests whose product number now resolves (status built, note "auto — part now in SkyNet").

### 5.3 Data correction (TEST done; PROD file `2026-09-30_CO-6256-19146_SK-OS_release_split.sql`)
Line 1 → 3,205 @ 3/26/27; new lines 10/11/12/13 = 3,025 @ 6/30/27, 10,620 @ 12/31/27, 1,340 @ 6/30/27, 2,440 @ 12/31/27. Guards: qty 20,630 / not_started / 0 allocations / max line 9 / exactly the five expected FB lines. Audit tag SKOS-RELEASE-0930.

## 6. Code Changes

### 6.1 Batch A (prompt delivered: `2026-09-30_D-FB-42_OrderQueue_UX_BatchA_CC_Prompt.md`)
New: `orderqueue/ComponentPicker.jsx`, `orderqueue/PurchaseComponentsModal.jsx`, `orderqueue/LineDetailPanel.jsx`; rewritten: `orderqueue/ConvertToCOModal.jsx`. Edited: `lib/fishbowl.js` (`groupLinesForConversion`, `prodDueForLine`, `getLineDetail`, `getPurchaseComponents`, `setDisposition` 4th arg), `orderqueue/SOCard.jsx` (Prod Due column, chevron, detail row), `pages/OrderQueue.jsx` (detail loads, purchase flow, legend), `lib/customerOrders.js` + `pages/CustomerOrders.jsx` + `CreateWorkOrderModal.jsx` (component chips, tooltips), `ScheduleJobModal.jsx` / `Schedule.jsx` (tooltip text only).

### 6.2 Batch B
`supabase/functions/notify-email/index.ts` (new; SES v2; secrets `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `MAIL_FROM`; caller JWT → role check → reads the request row and recipients with the service role → sends → `part_request_mark_email`). `lib/partRequests.js` (new), `orderqueue/AlertRogerModal.jsx` (new), `SOCard.jsx` (button/chip on unresolved lines), `OrderQueue.jsx`, `ComplianceReview.jsx` (worklist "Part Build Requests (n)"), `Mainframe.jsx` (KPI), `NotificationsBell.jsx` (type `part_request`).

### 6.3 Batch C
`EditCustomerOrderModal.jsx` — ComponentPicker per open line, `co_line_set_components` on save when changed. Spec v4.8 + cheatsheet + plan close-out.

## 7. Build Order
1. ✅ SK-OS split on TEST · ✅ Batch A migration on TEST · Batch A CC prompt → Matt Dev review on TEST → ✅
2. Batch B SQL (TEST, Claude) → Matt creates the SES IAM key and sets the Edge Function secrets on TEST → Batch B CC prompt → Matt deploys `notify-email` to TEST → review → ✅
3. Batch C → review → ✅
4. PROD, in this order (review stops marked ⏸ — paste the result to Claude before continuing):
   a. `2026-09-30_D-FB-42_co_line_components_releases.sql` — expect the Batch A verify row.
   b. `2026-09-30_D-FB-45_…` Block 1 only (functions + ingest patch; a GUARD_INGEST error means ingest changed — stop).
   c. `2026-09-30_D-FB-46_…` Block 1, then Block 2 dry run ⏸ — expect 2 splits (SK-OS, SK2600-3W) and 4 "on a work order" skips; then Block 3.
   d. `2026-09-30_D-FB-45_…` Block 2 dry run ⏸ — expect about 45 COs / 80 lines / 5 hand-keyed bumps; then Block 3, then Block 4 (mismatched 0).
   e. `2026-09-30_D-FB-46_…` Block 4 — splittable 0, combined_with_wo 4.
   f. Push `main`.
   **Do not run** `2026-09-30_CO-6256-19146_SK-OS_release_split.sql` on PROD — D-FB-46 does SK-OS and SK2600-3W in one pass.
   Tell Ashley and April the day Create CO changes; tell April ~45 COs get new line numbers (Fishbowl's) and Job Pool targets move later for far-out Fishbowl dates; tell Roger that travelers printed before the renumber show the old CO line numbers (not flagged for reprint).

## 8. Risks & Open Items
- `fb_set_disposition` signature change: any caller still passing three named args works (defaults), but the old function is gone — no other callers exist in src.
- The 55 legacy assembly CO lines have no structured components; their dropdowns show WO-derived rows tagged "on WO only" until someone edits them (Batch C).
- SES key creation is Matt's step; Batch B can be reviewed with `email_status = failed` and a clear error if the secrets are missing.
- `v_co_line_component_status` reads every job on the allocated WOs; on PROD (~300 open lines) this is one indexed read per expanded SO — no full-table concern.

## 9. Definition of Done
Batches A–C ✅ on TEST; PROD steps 4a–4e run in order with verify rows pasted; Decisions.md carries D-FB-42/43/44/45, D-CODATE-04, D-NOTIF-02; Spec v4.8 §5.27 and §5.24 updated; this plan marked CLOSED.
