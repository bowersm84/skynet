# Implementation Plan — Outsourcing Consolidation ("Combine Like Products")

**Status:** Planned (new — May 21 2026)
**Origin:** Ashley (outsourcing) via Matt; long-standing discussion with the company president
**Related:** Post-finishing outsourcing flow; `components/OutsourcedJobs.jsx`; `outbound_sends`

---

## Problem

When work leaves compliance and reaches outsourcing, Ashley currently sends each
finishing_send out individually — one `outbound_sends` record per send. In practice, multiple
batches of one job, and multiple jobs of the **same part number**, frequently go to the same
vendor for the same operation at the same time. Ashley needs to combine them onto a **single
send-out** to cut paperwork and match how the vendor actually receives the parts.

## The constraint that cannot fail (president's traceability test)

Every part must always trace back to a **single raw material lot number**. Therefore:

> **Parts with different material lot numbers must NEVER be combined into one send-out.**

This is the hard gate. It is enforceable cleanly because of an existing upstream rule:

- **A job can only ever have ONE material lot number.** The tool prohibits a machinist from
  registering a second raw material whose lot differs from the job's first; the registration
  is blocked. So there is never a job with multiple material lots, and every batch of a job
  inherits that one lot.

Given that, the consolidation gate reduces to a single comparison: **all batches/jobs on one
send-out must share the same part number AND the same material lot number.**

Differing **PLN** (production lot) and **FLN** (finishing lot) across the combined sources is
**acceptable to compliance** — those legitimately differ per job/batch. They must, however,
be **fully logged** on the consolidated send-out so the vendor cert can map every part back
to its PLN/FLN and ultimately its material lot.

## Explicit non-goals

- **Do NOT change any other lot-number functionality.** Production processes stay separate;
  PLN/FLN behaviour elsewhere is untouched. Consolidation happens ONLY at the
  compliance → outsourcing handoff, in the outsourcing UI.

## Data model (Option A — join table, confirmed)

Today `outbound_sends.finishing_send_id` is a single column (one send = one finishing_send).
To put multiple finishing_sends on one send-out, add a join table:

- **`outbound_send_items`**:
  - `id`, `outbound_send_id` (FK → outbound_sends), `finishing_send_id` (FK → finishing_sends),
  - per-source snapshot for the log: `production_lot_number`, `finishing_lot_number`,
    `material_lot_number`, `quantity`, `job_id`, `job_number`.
  - Index on `outbound_send_id`.
- The parent `outbound_sends` row carries the shared facts: vendor, operation_type, the
  **shared material lot number** (the gate value), total quantity (sum of items), part number.
- Keep `outbound_sends.finishing_send_id` for backward compatibility with single-source sends,
  OR migrate all sends to use the join table with exactly one item. **Decision needed**
  (see open questions) — leaning toward: new consolidated sends use the join table; legacy
  single sends keep working; new single sends also write one join row for uniformity.

## UX — "Combine Like Products"

1. In the outsourcing Ready-to-Send list, Ashley clicks **"Combine Like Products."**
2. The system groups the ready items by (part number + material lot number) and **suggests**
   combinable groups. Items that cannot be combined (different material lot) are clearly
   flagged as such — visible but not group-able, with a short reason ("different material lot").
3. Suggestion only — Ashley **checks a checkbox** next to each batch/job she wants to include.
   She may choose not to combine everything (partial selection is fine).
4. On confirm, the selected items become **one** `outbound_sends` row with N
   `outbound_send_items` rows, each preserving its PLN/FLN/material lot/qty for the cert.
5. The send-out paperwork lists all constituent PLNs and FLNs and the shared material lot.

### Guardrails in the UI

- The checkbox group is constrained so a user **cannot** select items with mismatched
  material lots into the same combine action — the gate is enforced in the UI AND re-validated
  server-side at write time (never trust the client alone for the traceability rule).
- If a selection somehow contains mixed material lots at submit, the write is rejected.

## Build outline

1. **Migration**: `outbound_send_items` table + indexes + RLS (authenticated SELECT;
   INSERT for outsourcing role + admin). Decide legacy-compatibility approach.
2. **Grouping logic** (`OutsourcedJobs.jsx` or `lib/`): given ready finishing_sends, group by
   (part_number, material_lot_number); mark singletons and un-combinable items.
3. **"Combine Like Products" UI**: button → suggested groups → checkboxes → confirm. Clear
   flagging of different-material-lot items.
4. **Consolidated send write**: create one `outbound_sends` (shared vendor/op/material lot/
   part, summed qty) + one `outbound_send_items` per selected source. **Server-side re-check**
   that all items share one material lot; reject otherwise.
5. **At-Vendor / Returned views**: render a consolidated send showing its item breakdown
   (each PLN/FLN/qty), so receiving a combined send back maps to the right jobs/batches.
6. **Cert/paperwork**: include the full PLN/FLN list and the shared material lot on the
   send-out document.

## Open questions for the design session

1. **Legacy compatibility**: keep `outbound_sends.finishing_send_id` for single sends, or
   migrate everything to the join table (single sends = one item)? Uniform-via-join is cleaner
   long-term; keeping the column is less migration risk.
2. **Return handling**: when a consolidated send comes back from the vendor, is return/qty
   recorded per item or for the whole send? (Per-item preserves traceability on partial returns.)
3. **Part number definition**: is "same part number" the component `part_number` exactly, or
   could revision/spec differences matter? Material lot is the hard gate, but confirm part
   match granularity.
4. **Material lot source**: confirm the material lot for a finishing_send is read from the
   job's single `material_usage` / `job_materials.lot_number`. (Per Matt: one lot per job,
   enforced upstream — so this is a single reliable value.)
5. **Mixed operation types**: must combined items share `operation_type` (heat_treat,
   cad_plating, etc.) as well as part + material lot? Almost certainly yes — confirm.

## Test cases (to formalize into a test script)

- Two batches of one job, same material lot → suggested as combinable → combine → one
  outbound_sends with two items; PLNs/FLNs both logged.
- Two jobs, same part number, same material lot, different PLN/FLN → combinable → combined;
  compliance accepts differing PLN/FLN; cert lists both.
- Two jobs, same part number, **different material lot** → flagged NOT combinable; UI prevents
  selecting them together; server rejects if forced.
- Partial selection → Ashley combines 2 of 3 eligible items; the third remains its own send.
- Consolidated send returns from vendor → item breakdown intact; each part traces to its
  material lot.
- Single-source send (no combine) → still works (legacy path or single-item join row).

## The one rule to never break

No `outbound_send` may ever contain items with more than one distinct material lot number.
Enforced in UI and re-validated server-side at write. This is the president's traceability
test and the acceptance criterion for the whole feature.
