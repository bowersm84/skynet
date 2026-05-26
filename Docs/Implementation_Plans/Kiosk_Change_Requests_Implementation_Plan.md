# Implementation Plan — Kiosk Schedule Change Requests + Requester Notification

**Status:** Planned (follow-on to the Production-meeting Change-Request feature)
**Origin:** SKY57 deferral note — Matt wants machinists to request schedule shifts directly
from the kiosk as they work, relaying to April; plus the deferred open question: notify the
requesting machinist when their request is applied/dismissed.
**Related:** `schedule_change_requests` table + `submit_change_request` RPC + Schedule review
queue (all built in the Production-meeting CR feature). `Kiosk.jsx`.

---

## Context — what the base feature already provides

The Production-meeting CR feature ships the shared foundation this plan reuses:

- `schedule_change_requests` table with `requested_by` (nullable), `source`
  (`'production_meeting' | 'kiosk'`), `status` (`'open' | 'applied' | 'dismissed'`),
  and `actioned_by` / `actioned_at`.
- `submit_change_request` RPC — validated, controlled write (job exists, end-date valid,
  open-duplicate dedup).
- The anon **dashboard** path (`source='production_meeting'`, `requested_by = NULL`).
- The Command/Schedule **review queue** — Apply (cascades via the SKY55
  `computeEndChangeCascade` + `applyEndDateChange` engine) and Dismiss, stamping
  `actioned_by` / `actioned_at`.

The table and RPC are deliberately built with `source='kiosk'` and `requested_by` already in
place, so the kiosk is an additive layer — no schema change expected here.

## Problem

1. A machinist at the kiosk should be able to request that their active job's **end date**
   move (running long or short) without leaving the kiosk — relaying to April rather than
   editing the schedule themselves.
2. When April applies (or dismisses) a request, the machinist who raised it should see the
   outcome, closing the loop.

## Agreed design decisions (confirm in the session)

- **Reuse the same table + RPC.** The kiosk session is authenticated, so the call stamps the
  machinist identity → `requested_by = profile.id`, `source = 'kiosk'`. (The anon dashboard
  path leaves `requested_by` NULL.)
- **End-date only**, consistent with SKY55 and the dashboard path. Start / machine / position
  stay locked.
- **Advisory.** April still applies/dismisses from the review queue. Kiosk requests appear in
  that same queue, tagged "Kiosk · &lt;machinist&gt;".
- **Notification = pull, not push.** The kiosk shows each machinist the status of their own
  recent requests (`SELECT … WHERE requested_by = me`, last N days): "Requested → Applied /
  Dismissed by &lt;scheduler&gt; on &lt;date&gt;". This reuses the row's `status` +
  `actioned_by`/`actioned_at` — no separate notifications table needed.

## Build outline

1. **RPC:** confirm `submit_change_request` stamps `requested_by` from `auth.uid()` when the
   caller is authenticated and accepts a `source` argument. If the base RPC hardcodes
   anon/NULL, extend it to read `auth.uid()` and take `source` (`'production_meeting'` |
   `'kiosk'`).
2. **`Kiosk.jsx` — request action:** on the active-job panel add "Request End-Date Change" →
   date picker → `rpc('submit_change_request', { job_id, requested_end, note, source: 'kiosk' })`.
   Confirmation toast; nothing on the schedule changes.
3. **`Kiosk.jsx` — "My Requests" strip:** list the machinist's recent requests with status,
   surfacing Applied/Dismissed outcomes (the pull notification).
4. **Review queue:** already lists kiosk requests with the source tag + requester name; Apply/
   Dismiss already stamp `actioned_by`/`actioned_at` — that is exactly what the kiosk reads.
5. **RLS:** add an authenticated INSERT path only if the kiosk does not go through the RPC; if
   it uses the RPC (recommended), no new table policy is needed. Add a SELECT policy letting a
   machinist read **their own** requests (`requested_by = auth.uid()`) for the My Requests strip.

## Open questions for the design session

1. **Notification channel:** is the kiosk "My Requests" strip (pull) sufficient, or do you
   want a notifications table for alerts that follow the machinist across screens?
2. **Scope of requestable jobs:** only the currently-running job, or also the kiosk's next-up
   queued job?
3. **Rate / duplicate limits at the kiosk:** reuse the "already-requested" dedup from the base
   RPC, or allow a machinist to update their own open request instead of filing a second?

## Test cases (to formalize into a `.docx` test script)

- Machinist requests an end-date change from the kiosk → row created with `source='kiosk'`,
  `requested_by` = machinist; appears in the review queue tagged Kiosk.
- April applies → cascade runs (SKY55); status `applied`, `actioned_by` = April; kiosk
  My Requests shows Applied.
- April dismisses → status `dismissed`; kiosk shows Dismissed.
- Duplicate kiosk request on the same active job → deduped per base RPC behavior.
- A machinist can see only their own requests, not others'.

## Out of scope (this plan)

- Start / machine / position change requests (end-date only).
- Push notifications or email.
- Changes to the cascade engine (reused as-is from SKY55).
