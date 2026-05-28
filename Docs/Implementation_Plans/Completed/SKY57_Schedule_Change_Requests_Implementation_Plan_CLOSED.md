# Implementation Plan — Schedule Change Requests (SKY57) — CLOSED

**Status:** ✅ SHIPPED May 26 2026 (one coordinated release, TEST→PROD). Spec v3.5.
**Origin:** SKY55 (shipped) + SKY57 (deferred, now shipped) — live date feedback in the daily
production meeting.
**Supersedes:** `Production_Meeting_Date_Requests_Implementation_Plan.md` (the deferred plan).
**Related:** SKY55 order-positioned scheduling + `lib/scheduling.js` cascade engine; Release A
dashboard quality metrics (shipped same day); `Partial_Reject_Implementation_Plan.md` and
`Kiosk_Change_Requests_Implementation_Plan.md` (deferred follow-ons).

---

## Closure summary — what shipped

A scheduler/machinist can capture an end-date change request during the daily production meeting;
April reviews and applies each one later from a queue in Command/Schedule. Requests are advisory —
nothing on the schedule moves until applied — and applying reuses the SKY55 cascade engine.

Delivered in three files + one migration:

1. **Migration** (`Docs/migrations/`): `schedule_change_requests` table, RLS, and the
   `submit_change_request` RPC. Applied TEST → validated → PROD.
2. **`ProductionDisplay.jsx`**: DUE date on each active-job row is click-to-request (date picker →
   RPC); a marker shows on jobs with an open request.
3. **`Schedule.jsx`**: a "Requests" badge + review panel (scheduler/admin), realtime-subscribed,
   with Apply (cascade) and Dismiss.

## Key pivot from the deferred plan — RPC instead of Edge Function (D-S57-01)

The deferred plan specced an **Edge Function** (Option B) for the anon dashboard write. That was the
single reason SKY57 was iced — it required net-new infra (Deno, CORS, service-role secret,
`supabase/functions/`, a deploy step). Replaced with a **`SECURITY DEFINER` Postgres RPC**
(`submit_change_request`), granted to `anon` + `authenticated`: identical controlled-write security,
zero new infrastructure. This is what made SKY57 shippable in a single day. Full rationale in
`Decisions.md` D-S57-01.

## What was built (final)

1. **Table `schedule_change_requests`** — `id`, `job_id`, `current_end` (snapshot), `requested_end`,
   `note`, `source` ('production_meeting' | 'kiosk'), `status` ('open' | 'applied' | 'dismissed'),
   `requested_by` (nullable — NULL for anon dashboard), `created_at`, `actioned_by`, `actioned_at`.
   Indexes on `status` and `job_id`.
2. **RLS (mirrors `customer_orders`, D-S57-03)** — authenticated SELECT (true); anon SELECT limited
   to `status='open'`; UPDATE for admin/scheduler/customer_service via the profiles role EXISTS
   check; no INSERT policy (RPC only); no DELETE policy (dismissal is a status update).
3. **RPC `submit_change_request(p_job_id, p_requested_end, p_note, p_source)`** — SECURITY DEFINER.
   Validates job exists + not complete/cancelled; `requested_end` present and not before today;
   `requested_by = auth.uid()` only for `source='kiosk'`; de-dupes identical open requests.
4. **Production Dashboard** — clickable DUE date → date picker → RPC (`source='production_meeting'`,
   `requested_by` NULL); "requested" marker on jobs with an open request; nothing live changes.
5. **Command/Schedule review queue** — "Requests" badge with open count; panel rows show
   job / current end → requested end / note / source tag. Apply runs
   `getMachineQueue → computeEndChangeCascade → applyEndDateChange` (SKY55) and marks the request
   `applied`, auto-dismissing sibling open requests on the same job. Dismiss marks `dismissed`. Both
   stamp `actioned_by`/`actioned_at`. Realtime-subscribed so the badge updates live.

## Open questions — resolved at close

1. **Notify the requesting machinist (kiosk case)?** → DEFERRED to the kiosk plan; the kiosk path
   isn't built yet, so there's no one to notify. (Plan: pull-based "My Requests" strip.)
2. **Two open requests on one job?** → Applying one **auto-dismisses** the others on that job
   (D-S57-02).
3. **"Already requested" marker?** → YES — marker on the dashboard DUE date + RPC de-dups identical
   open requests, so one meeting can't file the same change repeatedly.
4. **Edge Function CORS/origin?** → MOOT — RPC replaced the Edge Function (D-S57-01).
5. **Requested-date validation?** → Reject invalid or past dates; allow same-day and future
   (in the RPC).
6. **Where the queue lives?** → Badge + panel in the Schedule toolbar's right action group.

## Test cases — validated on `test-skynet.skybolt.com`

- Click a DUE date on the Production Dashboard → request row created (`source='production_meeting'`);
  schedule unchanged; marker appears. ✅ (two live requests created during validation)
- Open the Change Requests queue → request appears with current → requested end + note; badge count
  correct; updates live as new requests arrive. ✅
- Apply → job end moves to requested date, downstream cascades (SKY55), request `applied`, sibling
  open requests on the same job auto-dismissed. ✅
- Dismiss → no schedule change, request `dismissed`. ✅
- Anon dashboard write goes through the RPC (no anon INSERT policy on the table). ✅

## Deferred follow-ons (separate plans)

- **Partial reject** — `Partial_Reject_Implementation_Plan.md`. The require-Bad-Qty-on-Reject rule
  lands there, where it's meaningful.
- **Kiosk change requests + requester notification** — `Kiosk_Change_Requests_Implementation_Plan.md`.
  Reuses this table + RPC + review queue; authenticated insert carries the machinist identity
  (`source='kiosk'`).

## Out of scope (unchanged)

- Start-date requests (end-date only, per SKY55).
- Machine / position change requests.
