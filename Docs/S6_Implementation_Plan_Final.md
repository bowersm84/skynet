# SkyNet Sprint 6 — Final Implementation Plan
## Post-Assembly Outsourcing (Behind Feature Flag) + Pre-Go-Live Hardening
### May 3-4, 2026 | Status: Shipped to Production

---

## Sprint Goal — Final

The original goal was to add post-assembly outsourcing — components → assembly module → external ops on the assembled product → return → TCO. Mid-sprint, after surfacing readiness issues with Jody's training, the goal split into two:

1. **Build the post-assembly outsourcing infrastructure** end-to-end behind a feature flag (`FEATURES.ASSEMBLY_MODULE`), so it can be activated without further development when Jody is ready.
2. **Harden everything for go-live without assembly active** — flag default OFF, components route directly to TCO, surface the bugs that emerge from real testing.

Both completed and shipped. Production deploy: May 4, 2026.

---

## What Shipped to Production

### 1. Polymorphic outsourcing infrastructure (functional, dormant under flag-off)

The full S6 architecture is in code and the test database. Activating it requires only flipping `FEATURES.ASSEMBLY_MODULE` to `true` and redeploying.

| Component | File | Status |
|---|---|---|
| Schema migration (Batch A) | DB | Applied to test ✅ and prod ✅ |
| `work_order_assembly_routing_steps` table + RLS | DB | Live |
| `outbound_sends` polymorphic columns (`source_type`, `source_id`, `routing_step_id`) | DB | Live |
| WOA status enum extended (`ready_for_outsource`, `at_external_vendor`, `pending_tco`) | DB | Live |
| Routing template type column + 3 assembly templates seeded | DB | Live |
| Assembly nav entry, KPI tile | `Mainframe.jsx` | Hidden when flag off |
| Assembly module (Start, Send Batch, Complete, ALN entry) | `Assembly.jsx` | Inert when flag off |
| OutsourcedJobs polymorphic queries (assembly-source) | `OutsourcedJobs.jsx` | Code path live; no rows generated when flag off |
| Compliance rollup branches | `ComplianceReview.jsx` | Routes components to `pending_tco` when flag off |
| WO Lookup Assembly Routing block | `Mainframe.jsx` | Renders for any WOA with non-trivial route (even flag-off) |

### 2. Pre-go-live bug fixes (active for everyone)

These shipped to prod and apply regardless of flag state:

| Fix | File(s) |
|---|---|
| `getEffectiveQty` path 1 — sum multi-batch returns at latest step | `Mainframe.jsx`, `Assembly.jsx` |
| Traveler external step lot — read per-send `vendor_lot_number` first | `lib/traveler.js` |
| Late-arriving approved batches — relaxed Ready-to-Send filter + reopen routing step on send-out | `OutsourcedJobs.jsx` |
| `expected_return_at` timezone parsing — `formatDateOnly` / `isPastToday` helpers | `Mainframe.jsx` |
| Per-job FLN scope (was per-active-bath) | `Finishing.jsx` |
| Manual Pickup modal — Material Lot # mandatory + sticky on job | `Finishing.jsx` |
| WO header — total + breakdown for mixed MTS+MTO | `Mainframe.jsx` |
| Available Qty under WOA header | `Mainframe.jsx` |
| Per-batch outsourcing detail in WO Lookup | `Mainframe.jsx` |
| KPI grid stretches when Assembly tile hidden | `Mainframe.jsx` |
| Collapse All / Expand All in Finishing | `Finishing.jsx` |
| Batch Quantity field removed (redundant with Incoming Count) | `Finishing.jsx` |

### 3. Feature flag scaffold

- `src/config.js` (NEW): `FEATURES.ASSEMBLY_MODULE = false`
- Imported in `Mainframe.jsx`, `ComplianceReview.jsx`, `OutsourcedJobs.jsx`

---

## What Did NOT Ship (deferred or removed)

| Item | Reason |
|---|---|
| Auto-create assembly outbound_sends when components complete | Removed — qty bug + premature timing. Skybolt handles post-assembly external ops outside SkyNet during flag-off period. |
| ALN entry on OutsourcedJobs send-out form (flag-off case) | Removed alongside auto-create |
| `maybeCreateAssemblyOutboundSends` helper | Deleted |
| Job Traveler — assembly-aware (`buildAssemblyTravelerHTML`) | Deferred — current traveler renders correctly without explicit assembly section since per-batch outsourcing data already shows |
| S6 test script docx | Deferred — manual testing during sprint covered the validation; no formal test docx produced |
| OutsourcedJobs status pills with vendor name (D4 polish) | Deferred — Hotfix 3 surfaced enough info for go-live |
| Backfill SQL for legacy multi-job FLN data | Skipped — pre-S6 data, not affecting current operations |
| Centralized `src/lib/qty.js` and `src/lib/dateUtils.js` | Deferred — duplication is known, post-go-live cleanup |

---

## Key Architectural Decisions Locked

See `Docs/Decisions.md` Sprint 6 section for the full record. Highlights:

1. **Multi-batch is the default**, not the edge case. Future code touching batch flow must explicitly handle (a) summing across batches at the same step, (b) not closing upstream gates while work may still arrive, (c) late batches on rolled-up jobs.
2. **Polymorphic `outbound_sends.source_id`** has no FK by design. Cannot use PostgREST embeds. Two-step fetch + JS hydrate pattern (`hydrateAssemblySends`).
3. **WOA status semantics:** `complete` means "fully done including TCO." `pending_tco` is the mid-flow value when assembly + outsourcing is done but TCO hasn't signed off.
4. **Step status sourcing:** External routing steps get their lot/quantity from per-send `outbound_sends` rows (canonical truth), not the step's aggregate `lot_number` field (last-write-wins, unreliable).
5. **Date-only columns:** Never use `new Date('YYYY-MM-DD')` directly. Always split + reconstruct in local TZ.
6. **FLN scope:** per-job, not per-bath. Chemical traceability via separate columns.

---

## Activating the Assembly Module (when ready)

When Jody's team is trained:

1. Edit `src/config.js`:
   ```js
   ASSEMBLY_MODULE: true,
   ```
2. Update the comment block with the activation date and Matt's initials.
3. Commit, push, Amplify deploys automatically.
4. Run the optional cleanup SQL to advance any jobs stranded at `pending_tco` that have unstarted assembly work — TBD whether any will exist; depends on whether any in-flight WOs at flip time have assembly external routes.

The activation does not migrate data. WOs created and closed under flag-off remain closed. Only WOs created after the flip route through Jody's Assembly module.

If any post-flip issues arise, the flag can be flipped back to `false` and redeployed in the same way (single-line code change). In-flight assembly jobs at the moment of flip-back would need a one-off SQL migration — risk to flag back to `false` is non-zero once Jody starts using it.

---

## Sprint Process — What Worked, What Didn't

### Worked

- **Surgical CC prompts.** Exact files, exact lines, copy-paste-ready code blocks. Vague prompts were rejected and rewritten before sending.
- **Targeted SQL diagnostics first.** Most "React bugs" turned out to be schema/data issues. Running `pg_policies` queries or `SELECT … LIMIT 1` checks before writing code saved multiple rounds.
- **Read-only validation queries surfaced separately in chat.** Per Matt's process rule mid-sprint: never bury mutation SQL inside markdown prompts. Mutating SQL gets its own conspicuous chat block.
- **Hotfix-on-Hotfix discipline.** Each bug got its own labeled prompt file (`Hotfix4`, `Hotfix5`, etc.) with explicit recovery SQL when needed and root-cause notes for future reference.

### Didn't work the first time

- **Original Batch D had two architectural mistakes** (PostgREST polymorphic embeds + premature pending_tco rollup). Took two hotfix passes to settle.
- **Multi-batch handling** got patched three times across `getEffectiveQty`, traveler, and Ready-to-Send. The pattern is now documented in Decisions.md but should have been the FIRST thing checked when designing the rollup logic.
- **Schema column names not verified** before writing INSERTs — `entered_by` vs `loaded_by` on `job_materials` cost a round trip. Going forward: read the table DDL before writing INSERTs to tables not recently touched.

---

## Files Touched — Final

```
src/config.js                                  (NEW)
src/pages/Mainframe.jsx                        (heavy)
src/pages/Assembly.jsx                         (heavy)
src/pages/Finishing.jsx                        (moderate)
src/components/OutsourcedJobs.jsx              (heavy)
src/components/ComplianceReview.jsx            (light)
src/components/CreateWorkOrderModal.jsx        (light)
src/components/RoutingTemplatesTab.jsx         (light)
src/pages/Armory.jsx                           (light)
src/pages/Kiosk.jsx                            (light)
src/lib/traveler.js                            (light)
```

Schema: `Decisions_S6_Append.md` already records the Batch A migration in detail (see Sprint 6 section of `Decisions.md`).

---

## Next Sprint Candidates

Per the post-S6 backlog (`Future_Sprint_Backlog.md`):

1. **Per-batch assembly** — components flow into Jody's queue as they complete, not after the entire job. Couples to the next item.
2. **Shipping module** — view shipping queue, confirm + ship to customer. Likely couples with Assembly Module activation.
3. **Centralize duplicated helpers** — `src/lib/qty.js` (extract `getEffectiveQty`), `src/lib/dateUtils.js` (extract `formatDateOnly`/`isPastToday`).
4. **PIN hashing** (S5 hardening item still open).
5. **Fishbowl import** (#31, deferred from S1).
6. **Barcode printing for Material Master** (deferred post-S3).
7. **Job Traveler — assembly-aware section** (deferred from S6 Batch E).

Recommend per-batch assembly + shipping as the next paired sprint — they're tightly coupled architecturally.
