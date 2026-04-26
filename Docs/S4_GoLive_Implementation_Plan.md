# SkyNet Sprint 4 — Go-Live Implementation Plan
## Mazak 5 Pilot Launch
### Updated: April 26, 2026 — Sprint 4 Complete

---

## Sprint Status: READY FOR GO-LIVE

All blocking items are complete. Deferred items have been documented in the
post-launch backlog. Wave 1 (Mazak 5 pilot) is cleared for launch this week,
pending user account setup (Batch E3) and end-to-end test pass (T1).

---

## Sprint Goal

Launch SkyNet next week with **limited but complete coverage**:
- **Mazak 5 kiosk** (one machine, one tablet — pilot)
- **Full finishing workflow** (James's station, all parts)
- **Full raw materials** (receiving, inventory, lot tracking)
- **Full compliance workflow** (Roger — all three review stages)
- **Full per-batch outsourcing workflow** (Ashley — heat treat, plating, etc.)
- **Command module** (April — scheduling for all machines)
- **WO Lookup** (April — full job visibility with live Job Traveler)

All other machines join in subsequent waves once the pilot is validated
and additional tablets are procured.

---

## Rollout Sequence

| Wave | Scope | Timing |
|------|-------|--------|
| **Wave 1 — Pilot** | Mazak 5 only | Next week |
| **Wave 2** | Patrick's remaining machines | After Wave 1 validated |
| **Wave 3** | Jeff's machines | After Wave 2 stable |
| **Wave 4** | Carlos's machines | Last (managed adoption) |

---

## Go-Live Batch Status

| Batch | Description | Status |
|-------|-------------|--------|
| A | Compliance, terminology, assembly dashboard | ✅ Complete |
| B | Kiosk enhancements, schedule list view, outsourcing foundation | ✅ Complete |
| C (original) | Testing & go-live prep | 🔄 Folded into Batch D |
| **D — Go-Live Sprint** | Bugs + new features for next week's launch | ✅ **COMPLETE** |
| **E — Config & Data** | Accounts, master data, data purge | 🔲 Pending (user task) |

---

## Previously Completed (Batches A & B)

| Item | Status |
|------|--------|
| Mainframe rename (Dashboard → Mainframe) | ✅ |
| Armory rename (Master Data → Armory) | ✅ |
| Command rename (Schedule → Command) | ✅ |
| TCO QC fields (tensile, shear, parts tested) | ✅ |
| Terminology alignment (Parts/Products) | ✅ |
| Assembly Pipeline Dashboard | ✅ |
| "Now" button for kiosk time fields | ✅ |
| Inventory deduction via material_usage | ✅ |
| Inventory + Receiving tabs in Armory | ✅ |
| Rack assignment fix (RLS + controlled select) | ✅ |
| RLS UPDATE policies (14 tables patched) | ✅ |
| Command list view toggle + drag-and-drop | ✅ |
| Compliance inline with scheduling | ✅ |
| Compliance Pending indicator (kiosk + Mainframe) | ✅ |
| Kiosk job documents (active + queue panels) | ✅ |
| WO Lookup job documents dropdown | ✅ |
| Kiosk material modal — sequential flow + availability banner | ✅ |
| Kiosk material dropdowns — inventory-first optgroups | ✅ |
| Outsourcing auto-queue (OutsourcedJobs.jsx) | ✅ |
| outbound_sends table + RLS | ✅ |
| Job statuses: ready_for_outsourcing, at_external_vendor | ✅ |
| Compliance → outsourcing routing fix (all 3 handlers) | ✅ |
| Supabase .not() filter bug fix | ✅ |
| WO Lookup routing steps + lot numbers display | ✅ |
| WO Lookup outsourcing sub-section | ✅ |
| document_type_id made nullable | ✅ |
| Additional Documents upload in compliance | ✅ |
| Drag-and-drop routing step reorder (WO modal + Armory) | ✅ |
| Routing step status badge fix (pending = no badge) | ✅ |

---

## Batch D — Go-Live Sprint (Completed April 26, 2026)

### D1 — Bugs (All Fixed)

| Item | Status | Notes |
|------|--------|-------|
| **B3** Traveler PLN refresh | ✅ | Replaced static traveler with live `buildTravelerHTML` util — generated on-demand from current job/finishing/outsourcing data |
| **B6** Traveler in kiosk doc list | ✅ | Cyan Job Traveler entry pinned at top of kiosk job-document panels |
| **B7** Compliance pending indicator contrast | ✅ | Solid amber badge with dark text, larger size, drop shadow, uppercase label; card opacity dropped from 40% to readable |
| **B8** Outsource quantity pre-fills order qty | ✅ | Now uses cumulative finishing-good qty via shared precedence chain (good_qty → verified-bad → verified_count) |
| **B9** WO qty display verified vs order | ✅ | `getEffectiveQty` helper centralized; WO Lookup, Mainframe, OutsourcedJobs, traveler all use same precedence |
| **B10** Doc upload — delete button | ✅ | Compliance/admin can delete uploaded docs from compliance review with confirmation; DB row hard-deleted, S3 cleanup deferred |

### D2 — New Features (All Shipped)

| Item | Status | Notes |
|------|--------|-------|
| **#98** Compliance outcomes (Accept/Rework/Reject + Hold/Flag) | ✅ | Three-way for post-mfg, five-way overall counting pre-mfg Hold and Flag; with mandatory reasons |
| **#94** Two chemical lots (citric + alkaline) | ✅ | `chemical_lot_number_2` column added; UI labels both fields; FLN regenerates on either change |
| **#99** WO status "Out for [Vendor]" | ✅ | Per-batch dynamic status replaced job-level approach; shows Returned/At Vendor/Ready for Outsource per batch |
| **NEW** James "Start New Job" at Finishing | ✅ | Auto-creates J-FIN-XXXXXX jobs; supports Source machine OR Received (no machine) with description; Operation Type Full Finishing or Passivation Only |
| **NEW** Per-Batch Outsourcing | ✅ | `outbound_sends.finishing_send_id` added; each finishing batch sends/returns independently; routing step + job status only flip when machining done AND all sends returned |
| **NEW** Forced Compliance Quantity Entry | ✅ | Good Qty pre-fills with verified count as real value (not placeholder); Accept/Rework blocked without qty entry |
| **NEW** Quantity Override (Admin) | ✅ | `qty_override`, `qty_override_reason`, `qty_override_by`, `qty_override_at` on jobs; amber asterisk in WO Lookup |
| **NEW** Job Traveler — live & populated | ✅ | Generated via `lib/traveler.js`; available on 5 surfaces; Machine + Finishing + External rows fully populated |
| **NEW** Outsourcing date timezone fix | ✅ | Local-noon storage + local-TZ display |
| **NEW** Per-batch identifier pill in OutsourcedJobs | ✅ | Cyan "Batch A/B/C" pill on Ready/At Vendor/Returned cards |
| **NEW** Dynamic batch status in WO Lookup | ✅ | Replaces static "Compliance Approved" with batch-level Returned/At Vendor/Ready for Outsource |
| **NEW** Job Traveler in WO Lookup docs | ✅ | Pinned at top of expanded "View documents" list |
| **NEW** External step in routing list | ✅ | Just shows checkmark when complete (no lot number) — per-batch lots live in OUTSOURCING sub-section |

### D3 — Configuration & RLS

| Item | Status | Notes |
|------|--------|-------|
| RLS audit pre-go-live | ✅ | Re-confirmed; all S4 column additions inherit parent table policies |

### D4 — Deferred to S5

| Item | Reason | Notes |
|------|--------|-------|
| **#95** Machine ID in PLN | Pilot uses single machine (Mazak 5) so collision risk is zero | Revisit format after pilot feedback |
| **#97** Rename Supplier Packing Slips | Naming clash with existing "Material Certification" type | Discussion with Roger and team needed |
| **#106** Outsource shortfall alert | Manual review acceptable for pilot scope | Revisit if real shortfalls observed |
| **#82** Job Events Log | Forward-only audit log on Armory | Owner: Matt; Effort: L |
| **Job Traveler start/end dates** | Header field | Likely production_start + completion dates |
| **Customer override column** | Currently in notes string | Proper `jobs.customer_override` column |
| **Shipment grouping for outsourcing** | Multiple batches as one vendor lot | With proportional return splitting |
| **April's WO-linking of standalone J-FIN** | Allow retroactive WO bind | Alongside Job Events Log |
| **End-state trigger if return logged before machining done** | Edge case in pilot scope | Re-check from machining completion handler |
| **PrintTraveler.jsx consolidation** | Delete or refactor to use shared util | Code cleanup task |

---

## Batch E — Data Purge & User Setup (T2 / T3)

### E1 — Data Purge (T2)

**What to purge (preserve machines, material_types, routing_templates, document_types):**
```sql
-- Run in order (FK dependencies)
DELETE FROM public.audit_logs WHERE created_at < now();
DELETE FROM public.machine_downtime_logs;
DELETE FROM public.material_usage;
DELETE FROM public.job_materials;
DELETE FROM public.outbound_sends;
DELETE FROM public.finishing_sends;
DELETE FROM public.job_documents;
DELETE FROM public.job_routing_steps;
DELETE FROM public.jobs;
DELETE FROM public.work_order_assemblies;
DELETE FROM public.work_orders;
DELETE FROM public.material_receiving;
-- Optionally clear test parts (preserve if real parts already entered)
```

**Preserve:** machines, locations, parts (if real data loaded), material_types,
bar_sizes, materials, routing_templates, routing_template_steps, document_types,
part_routing_steps, part_documents.

### E2 — Master Data Load

1. **Parts:** Load shell records from April's whiteboard — part_number, description,
   part_type minimum. Roger fills routing/documents during first compliance review.
2. **Materials (Definitions):** Confirm real material type + bar size + vendor
   combinations match what's on the shop racks.
3. **Receiving log (opening inventory):** Enter current bar counts for materials
   on the rack. Even approximate counts establish the Day 1 baseline.
4. **Routing templates:** Verify all four standard templates are in Armory.
5. **Machines:** Confirm all Leesburg machines have name, machine_type, and
   location populated. Mazak 5 verified first.

### E3 — User Accounts + PINs (T3)

| Name | Role | can_approve_compliance | Notes |
|------|------|----------------------|-------|
| April | admin | true | WO creation, Command, WO Lookup |
| Roger | compliance | true | Compliance Review, TCO, Armory |
| Patrick | admin | false | Kiosk (all machines), Command visibility |
| Scott | machinist | false | Kiosk |
| Jeff | machinist | false | Kiosk |
| James | finishing | false | Finishing Station |
| Harry | admin | false | Machine management, Mainframe |
| Jody | compliance | true | Post-mfg compliance backup |
| Tom | compliance | true | Post-mfg compliance + TCO QC |
| Carlos | machinist | false | Kiosk — Wave 4, phased rollout |
| Ashley | admin | false | Outsourced Operations |

**Process:** Create Supabase Auth user → create `profiles` record with correct
role and flags → set kiosk PIN with user present → verify PIN login on tablet.

**Note on Carlos:** Create account but do not assign machines to kiosk
rotation until Wave 4. Managed adoption.

---

## End-to-End Test (T1)

Full production cycle test — recommended TWICE before go-live:
- **Test 1:** Stainless part with heat treatment step (full per-batch outsourcing path)
- **Test 2:** Stainless part, standard path (no outsourcing)

```
WO Creation (April)
  → Pre-Mfg Compliance: Accept (Roger — routing check, doc upload)
  → Test pre-mfg outcomes: Hold, Flag, Reject (verify badges)
  → Command: Schedule to Mazak 5 (April)
  → Kiosk: Start Setup → Log Materials → Start Production (PLN generated)
  → Kiosk: Partial Send to Finishing (Batch A, 300 pcs)
  → Finishing: James completes Batch A wash → treatment → dry
  → Compliance: Roger reviews Batch A — verify Good Qty pre-fills with verified count;
                test that Accept blocks without qty entry; finally Accept with 295 good / 5 bad
  → Outsourcing: Send Batch A to Braddock → log return (verify date displays correctly)
  → [parallel] Kiosk: Continue producing Batch B (200 pcs) → send → finish → approve → outsource
  → [Test 1 only] Verify routing step does NOT mark complete until all sends returned
                  AND machining done (actual_end set)
  → Verify job advances to ready_for_assembly only when both gates pass
  → Test Job Traveler from all 5 surfaces (kiosk, compliance, finishing, WO Lookup, print package)
  → Verify all populated rows: PLN on Machine Process, FLN on finishing rows,
                               vendor + lot + qty + date on external rows
  → Ready for Assembly → TCO (Roger — QC fields)
  → WO marked complete
```

**Edge cases to test:**
- Reject flow: Roger rejects a batch — verify job cancelled and April notified
- Rework flow: verify rework flag appears in WO Lookup with reason
- Hold + Flag flows on pre-mfg: verify schedulability and badge colors
- Count discrepancy: submit mismatched count — verify audit log entry
- Compliance pending block: machinist tries to start job without compliance — verify block
- Multi-batch outsourcing with mid-flow batch arrival (Batch C arrives while A returns)
- Standalone J-FIN: James starts a passivation-only batch for purchased parts;
                    verify J-FIN-XXXXXX job created and traveler accessible
- Quantity override: admin sets manual qty with reason; verify amber asterisk in WO Lookup
- Compliance doc delete: Roger deletes accidentally uploaded doc; verify removal

---

## Infrastructure (Parallel Track)

| Item | Lead | Status |
|------|------|--------|
| Tablet procured and kiosk tested | Patrick / Ned | 🔲 |
| Mazak 5 tablet mount installed | Patrick | 🔲 |
| Shop floor Wi-Fi verified at Mazak 5 | Harry | 🔲 |
| Assembly area TV display live | Jody | 🔲 |
| Machining floor display live | April | 🔲 |
| Amplify is ONLY deploy source (no local builds on floor) | Matt | ✅ |

---

## Go-Live Success Criteria

### Must-Pass (blocking)
- [x] Per-batch outsourcing works end-to-end with multi-batch jobs
- [x] Job Traveler populates on all 5 surfaces with current data
- [x] Compliance outcomes (Accept/Rework/Reject + Hold/Flag) function with correct transitions
- [x] Two chemical lot numbers captured at finishing
- [x] James can manually start a finishing batch (Standalone J-FIN)
- [x] Forced quantity entry prevents null good_qty rows
- [x] Effective qty displays consistent across the app (precedence chain centralized)
- [ ] Mazak 5 kiosk loads, PIN login works on physical tablet
- [ ] All 11 user accounts created with correct roles and PINs
- [ ] Test data purged; real parts and materials loaded
- [x] RLS audit query passes (re-confirmed April 26)

### Should-Pass (non-blocking but important)
- [x] Compliance pending indicator clearly visible on tablet at arm's length
- [x] WO status shows per-batch outsource state (Returned, At Vendor, Ready for Outsource)
- [x] Outsource quantity pre-fills cumulative finishing qty (not order qty)
- [x] WO Lookup routing display shows PLN, FLN, and external step status correctly
- [x] Outsourcing dates display correctly (no UTC drift)
- [x] Compliance doc delete available to Roger

---

## Post-Launch Backlog (Wave 2+)

| # | Item | Sprint |
|---|------|--------|
| #95 | Machine ID in PLN | S5 (after pilot validation) |
| #97 | Material Certs rename | S5 (pending team discussion) |
| #106 | Outsource return shortfall alert | S5 (if real shortfalls observed) |
| #82 | Job Events Log | S5 |
| — | Job Traveler start/end dates | S5 |
| — | Customer override column on jobs | S5 |
| — | Shipment grouping for outsourcing | S5 |
| — | April's WO-linking of standalone J-FIN | S5 |
| — | End-state trigger when return logged before machining done | S5 |
| — | PrintTraveler.jsx consolidation | S5 cleanup |
| #96 | Drawing revision field in compliance | Wave 2 |
| #83 | Lot-change L1/L2 sub-job workflow | Before Wave 2 |
| #100 | Outsource batch override for large orders | Wave 2 |
| B2 | Material reload re-triggers after Add More Bars | Wave 2 |
| #82 | Bar length auto-fill per machine | Wave 2 |
| #85 | Finishing verified count feeds back to kiosk | Wave 2 |
| #101 | Material assigned status (prevents lot mixing) | P2 |
| #102 | Material cert upload on inventory records | P2 |
| #103 | Materials/Raw Materials table unification | P2 |
| #104 | External passivation queue (full Phase 3 version) | P3 |
| #105 | Material shortage flag at kiosk | P2 |
| #107 | Move QC fields to first article inspection | P2 |
| #89 | Planned vs actual duration report | P2 |

---

*Plan updated April 26, 2026. Spec reference: SkyNet_Specification_v2.4.*
*Sprint 4 Go-Live Sprint COMPLETE. Wave 1 ready for launch pending E1/E2/E3 user tasks.*