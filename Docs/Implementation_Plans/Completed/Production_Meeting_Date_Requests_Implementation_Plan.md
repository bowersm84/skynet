# Implementation Plan — Production Meeting Date Requests (Schedule Change Requests)

**Status:** Planned (SKY55 shipped; SKY57 deferred to a larger sprint)
**Origin:** SKY55 (April, scheduling) + SKY57 (April, scheduling) — live date feedback in production meetings
**Related:** May 17 2026 order-positioned scheduling rebuild; `lib/scheduling.js` cascade engine

---

## Context — what already shipped (SKY55)

SKY55 is **done and in production** (tested as "Batch A" May 21). It added direct
end-date editing to the scheduler:

- An **"Adjust End Date"** action on the job detail panel in `Schedule.jsx`, available for
  both running (`in_progress` / `in_setup`) and editable jobs. Start, machine, and queue
  position stay locked; only `scheduled_end` moves; `estimated_minutes` is recomputed and
  downstream jobs on the same machine cascade forward/back.
- New helpers in `lib/scheduling.js`: `computeEndChangeCascade(currentQueue, jobId, newEnd)`
  and `applyEndDateChange({ supabase, job, newEnd, cascadeChanges })`. No compliance revert
  (that is machine-swap only). No schema change.

This engine is the foundation SKY57 reuses.

## Problem — what SKY57 addresses (deferred)

In the daily production meeting, machinists give live feedback that a job will run longer/
shorter than scheduled. The meeting is loose and notes get lost. April needs a way to
**capture date-change requests on the spot** that she can action later — review each one and
decide whether to apply it. When applied, downstream jobs shift (reusing the SKY55 cascade).

Matt also wants this to extend later to the **kiosk**, so machinists can request schedule
shifts directly as they work, relaying to April.

## Why deferred

SKY57 as scoped requires changes to the **Production Dashboard** — an unauthenticated TV
route — plus net-new infrastructure the repo does not yet have. Matt iced it for a larger
sprint, specifically the Production Dashboard changes. Capturing the full design here.

## Agreed design decisions (locked before deferral)

- **Engine reuse**: the "Apply" action runs the exact SKY55 `applyEndDateChange` + cascade.
  A request only records "this job should end on date X"; nothing changes until April applies.
- **Write path = Edge Function (Option B)**: the Production Dashboard is anon/no-auth, and
  Supabase does not allow the anon client to write here cleanly. Route the request insert
  through a service-role Edge Function — this also sets up the kiosk CR path. (Repo has
  **no Edge Functions yet**, so this is the first one: `supabase/functions/`, Deno, CORS,
  service-role secret, `supabase functions deploy`.)
- **Review home**: a **"Change Requests" queue inside Command / Schedule** — a badge with a
  count; each row shows job / current end → requested end / note; Apply (cascades) or Dismiss.
- Requests are **advisory** until April applies. End-date only. Optional free-text note plus
  a source tag ("Production Meeting").
- For a running job, **start stays pinned**; only the end moves (consistent with SKY55).

## Build outline

1. **Migration** — new table `schedule_change_requests`:
   - `id`, `job_id`, `current_end` (snapshot), `requested_end`, `note`, `source`
     ('production_meeting' | 'kiosk'), `status` ('open' | 'applied' | 'dismissed'),
     `requested_by` (nullable for anon dashboard), `created_at`, `actioned_by`, `actioned_at`.
   - RLS: authenticated SELECT/UPDATE for scheduler+admin; INSERT only via the Edge Function
     (service role), so no anon write policy on the table itself.
2. **Edge Function** `submit-change-request`:
   - Validates job_id exists and requested_end is a valid future-ish date.
   - Inserts the row under the service role. CORS for the dashboard origin.
   - Deploy via Supabase CLI; document the deploy step in the runbook.
3. **Production Dashboard** (`ProductionDisplay.jsx`):
   - Make the DUE date (scheduled_end) on each active-job row clickable → date picker →
     POST to the Edge Function. Changes nothing live; shows a confirmation toast.
4. **Command / Schedule review queue**:
   - "Change Requests" panel: list open requests with current → requested end and note.
   - Apply: call `applyEndDateChange` (SKY55) with the requested end → cascade downstream;
     mark request `applied`. Dismiss: mark `dismissed`.
   - Badge count of open requests.
5. **Kiosk CR (future)**: same table, authenticated insert carries the machinist identity;
   reuse the review queue. Graduate the write path to the Edge Function established in step 2.

## Open questions for the design session

1. Should an applied request notify the requesting machinist (kiosk case)?
2. If two open requests target the same job, does applying one auto-dismiss the other or
   leave both (April resolves manually)?
3. Should the dashboard show a subtle "requested" marker on a job that already has an open
   request, so the same change isn't requested twice in one meeting?
4. Edge Function origin/CORS: confirm the exact dashboard origin(s) to allow.

## Test cases (to formalize into a test script)

- Click a due date on the Production Dashboard → request row created; schedule unchanged.
- Open the Change Requests queue in Command/Schedule → request appears with current →
  requested end and note; badge count correct.
- Apply a request → job end moves to requested date, downstream cascades (SKY55 behaviour),
  request marked applied.
- Dismiss a request → no schedule change, request marked dismissed.
- Anon dashboard write goes through the Edge Function (no anon table policy).

## Out of scope (this plan)

- Start-date requests (end-date only, per SKY55).
- Machine/position change requests.
