# SkyNet MES — Sprint 14 Implementation Plan

**Sprint 14 — Traveler Kiosk**

Implementation Plan v1.8 · October 8, 2026 (v1.8: A3 passed; converter 1.2 — a print copy is always one page; Batch A4. v1.7: A2 passed; print copies live — image 1.1, 390 converted, trigger verified; Batch A3 as built. v1.6: converter 1.1 — the first real print copies hid the cards' controlled footer; fixed, and the sweep now redoes copies from older converter versions. v1.5: print-copy setup is console-only — CodeBuild builds the image, the function's Test tab runs the backfill and builds Roger's review PDF. v1.4: production cards stay Excel — automatic PDF print copies made by an AWS Lambda (D-TKIOSK-11a); the PDF swap and the Excel-refusing upload rule are dropped; Batch A3 added. v1.1: Print Production Card added; production-card PDF rule restated plainly. v1.2: spike result — print path fixed as one HTML job with documents rendered to images. v1.3: first-test fixes, Batch A2 — pack is traveler + drawing + card, one print per job, record before print, card button always shown)

**Owner:** Matt Bowers
**Status:** Draft for sign-off. S13 (Fishbowl Inventory) is paused with one batch left; S14 goes first.

---

## 1. Sprint Goal

Move traveler printing from Roger's desk to the machinist. A dedicated PC near the machinists' office runs `/traveler-kiosk`: PIN → tap your machine → the lineup appears → **Print Travel Pack** → the traveler and every job document come out of the printer next to the PC → "Put J-000255 in setup on NT-3?" → Start Setup. One click prints, one tap starts setup, nothing else to learn.

Printing moves to the last responsible moment, so what reaches the machine is the current truth — machine, quantity, merges and documents as they stand at setup, not as they stood when Roger accepted the job.

---

## 2. Background

Today Roger prints the Print Package at compliance accept and files it in a machine-labeled bin. Jobs then change before setup — rescheduled to another machine (D-SCHED-26), merged or unmerged (D-JOBMERGE-03), lot-split (D-JOBMERGE-20), quantity-edited (D-WOLOOKUP-QTYEDIT01) — and the paper in the bin is wrong. The Traveler Outdated worklist in Compliance Review, the kiosk's amber stale-traveler banner, the `traveler_printed_at` / `paperwork_changed_at` stamps and the compliance notifications all exist to catch that. They work, but they are a repair loop around an early print.

Printing at the kiosk removes the window the repair loop was built for. The stamps stay — they still catch a job that changes *after* the machinist printed — but for the common case the paper is printed seconds before it is needed, by the person who needs it, with the job's identity attached (`traveler_printed_by` = the machinist, `assigned_user_id` = the machinist).

Matt's answers on Oct 7 set the shape: S14 first; both facilities; every available job document; Chrome-flag silent printing tested on Matt's laptop before the PC; setup only (no Start Production); PIN with a 2-minute auto sign-out; Roger prints nothing.

---

## 3. Where We Are at Sprint 14 Open

### 3.1 Code state (src.zip, Oct 7)

- Every building block exists. Nothing in this sprint is a new concept to SkyNet.

| Need | Already in the repo | Reuse |
|---|---|---|
| PIN entry, kiosk JWT, machine picker, idle sign-out | `pages/MaterialKiosk.jsx` (shared `PinPad`, `kiosk-authenticate` anchored on any commissioned machine, no `kiosk_sessions` row, 3-min idle) | Copy the shell; 2-min idle |
| The machine's lineup | `pages/Kiosk.jsx` `loadJobs` — `jobs` by `assigned_machine_id`, status in (pending_compliance, assigned, in_setup, in_progress), order `scheduled_start` | Same query, same ordering |
| Start Setup transition | `pages/Kiosk.jsx` `handleStartSetup` normal-production branch: `status='in_setup'`, `setup_start`, `assigned_user_id`, `updated_at`, then `machine_idle_logs` fire-and-forget | Lift into `lib/jobSetup.js`; both kiosks call it |
| Out-of-order guard | `pages/Kiosk.jsx` `handleJobSelect` — warns when the chosen job is not first among `assigned` | Same rule, one confirm |
| Canonical traveler | `lib/traveler.js` `fetchTravelerData` + `buildTravelerBodyHTML` (the body; the pack owns the `@page` rules) | As is |
| Iframe print | `components/PrintTraveler.jsx` — `srcDoc` iframe, `contentWindow.focus(); print()` on load | Same pattern |
| Document list | `components/PrintPackageModal.jsx` — `job_documents` (as-run snapshot) with `part_documents` fallback for legacy jobs; `file_url` is the S3 key | Same list, no checkboxes |
| S3 bytes in the browser | `lib/certPackage.js` — `getDocumentUrl` → `fetch(signedUrl)` → `Uint8Array` (bucket CORS already allows it) | Same `fetchBytes` |
| PDF pages to images | `components/BOMUpload.jsx` — pdf.js 3.11.174 from cdnjs, `getDocument` → `page.render` to a canvas | Same library and version; loader lifted to `lib/pdfjsLoader.js` |
| Print stamp | `jobs.traveler_printed_at/by` written by every traveler surface (D-JOBMERGE-05) | Stamp with the machinist |
| Staleness | `lib/jobMerge.js` `isPaperworkStale` — the only derivation; consumers are the Kiosk banner and Compliance Review's worklist (Mainframe badge removed under D-JOBMERGE-17) | One edit covers all |

### 3.2 Database state (TEST, Oct 7, read-only)

- No schema change is needed. Every table the kiosk touches is `authenticated`-wide under RLS, and the kiosk JWT is `authenticated`: `jobs` UPDATE (`true`), `audit_logs` INSERT, `machine_idle_logs` INSERT, `job_documents` SELECT.
- 59 `assigned` jobs; 1.9 documents each (min 0, max 2); 1 assigned job has no documents.
- **Every drawing is a PDF (172 of 172 current masters). Every Production Log (Blank) is Excel** — 93 `.xls` + 75 `.xlsx` current masters, 102 distinct files; 69 of the in-flight job snapshots are Excel. A browser cannot print an Excel form faithfully, and the cert-package spreadsheet renderer is a text table, not the controlled form. This is the one obstacle to a true one-click pack — see §6.
- Staleness today: 1 job is "stale" only because it has never been printed; 0 are printed-then-changed.
- PROD (read-only, same day): 48 assigned jobs, 98% already stamped `traveler_printed_at` (Roger's print at accept); Traveler Outdated worklist is empty, so D-TKIOSK-10 moves nothing visible on day one; 178 current Excel production-log masters, 105 distinct files; 61 in-flight jobs carry an Excel production log. MZ-6 and NT-1 are `kiosk_enabled=false` on PROD too.
- Machines: 20 production machines (MZ-1…6, GN-1, BM-1…6, NT-1…7) across Leesburg Main and Tavares; FIN-1/FIN-2 are finishing. MZ-6 and NT-1 (Tavares) are `kiosk_enabled=false`.

### 3.3 Decision-ID collision check

`D-TKIOSK-*` is unused in Decisions.md. `D-KIOSK-*` runs to 05 and stays reserved for the machine kiosk.

---

## 4. Sprint Scope

### 4.1 In scope

- `/traveler-kiosk` route and `pages/TravelerKiosk.jsx` (new), self-gated by `FEATURES.TRAVELER_KIOSK`.
- `lib/travelPack.js` (new): build the pack (canonical traveler + every job document with a file), print it silently in order, stamp the print, write the audit row.
- `lib/jobSetup.js` (new): `startJobSetup` lifted from `Kiosk.jsx`; `Kiosk.jsx` normal-production branch calls it (surgical).
- Setup prompt after print; Start Setup gated on machine idle + out-of-order confirm.
- Reprint flag on the lineup ("Changed since last print") and the never-printed staleness fix in `isPaperworkStale`.
- **Print Production Card** — a second button that prints just a fresh blank production card for a job (long runs need more than one); tap again for another.
- Production cards stay Excel (Matt, Oct 7). An AWS Lambda (`skynet-print-copy`, LibreOffice) makes a PDF print copy beside every Excel file in the bucket on upload; a one-time sweep covers the cards already on file. The kiosk prints the copy. Nothing changes for Roger.
- Kiosk PC setup runbook (Chrome flags, default printer, auto-launch) — laptop first, then the PC.
- Roger cutover. Spec v4.9. Decisions D-TKIOSK-01 … 12.

### 4.2 Out of scope

- Start Production, material confirmation, blank-lot picking, downtime — the machine kiosk keeps all of it.
- Printing from the machine tablets. Printing from Compliance Review or WO Lookup is unchanged (reprints and exceptions).
- A local print agent on the PC. Only if the spike fails on both paths (§6.1).
- Converting document types other than Production Log (Blank). Drawings are already PDF; material certs are PDF.
- Finishing the S13 batch — resumes after S14 closes.

---

## 5. Decisions Locked

| ID | Topic | Decision |
|---|---|---|
| D-TKIOSK-01 | Print at point of use | Travel packs are printed at the Traveler Kiosk by the machinist, on demand. Roger stops printing at compliance accept; the machine bins retire. No job type is exempt. Compliance Review's Print Package and the Traveler Outdated worklist stay for reprints after a change. |
| D-TKIOSK-02 | Lineup | Per machine, `scheduled_start` order, same statuses as the machine kiosk. `assigned` → Print Travel Pack + Start Setup. `in_setup` / `in_progress` → pinned at top as "On the machine", reprint only. `pending_compliance` → greyed "Waiting on compliance", not printable. Maintenance WOs hidden (no paperwork). |
| D-TKIOSK-03 | Machines | Every active, commissioned machine with `machine_type <> 'finishing'`, grouped by location, Leesburg Main first then Tavares. Both facilities. |
| D-TKIOSK-04 | Pack contents | **Amended by D-TKIOSK-04a (Oct 7 test):** the traveler (canonical `buildTravelerBodyHTML`, landscape), the drawing, and the blank production card — nothing else. Material certs and other job documents stay in the Print Package. Job's own rows (the as-run snapshot); part-master fallback only when the job has neither. Order: `document_types.sort_order`. One copy, no selection. |
| D-TKIOSK-05 | Unprintable documents | Spreadsheets and unknown types are not rendered as text tables (a controlled form reproduced as a text table is worse than no form). They are listed on a final "Not printed — see Roger" page and in the on-screen confirmation. After the cutover in §6 none should remain in flight. |
| D-TKIOSK-06 | Silent printing | Chrome on the kiosk PC is launched with `--kiosk-printing`, so `window.print()` goes to the Windows default printer with no dialog. Without the flag the same code shows the dialog — nothing else changes. **Spike, Oct 7 (Chrome 154):** HTML in a hidden iframe prints silently (test A passed); a PDF in an iframe cannot be printed by script — Chrome blocks the call as cross-origin (`SecurityError`), on file:// and https alike. So the travel pack is **one HTML document printed as one job**: the traveler as HTML, every PDF page rendered to a 300-DPI image by pdf.js, images embedded directly, each on a fixed letter page via named `@page` rules (inch units). No PDF viewer, no merged PDF. Tests C/D in the v2 spike confirm the exact structure. |
| D-TKIOSK-07 | Print record | A kiosk print stamps `jobs.traveler_printed_at` / `traveler_printed_by` = the PIN'd machinist (same columns every traveler surface writes) and inserts `audit_logs` `event_type='travel_pack_printed'` with `job_id`, `machine_id`, `operator_id`, `details {doc_count, docs[], skipped[], path}`. |
| D-TKIOSK-08 | Setup prompt | After the pack is sent: "Put J-000255 in setup on NT-3?" → Start Setup / Not yet. Start Setup runs `startJobSetup` — exactly the machine kiosk's write (`in_setup`, `setup_start`, `assigned_user_id`, idle log). Offered only when the machine has no job in setup or running; refused for `pending_compliance`; a job that is not first among `assigned` gets the same out-of-order confirm the machine kiosk shows. Setup only — no Start Production. |
| D-TKIOSK-09 | Identity | Shared PIN pad via `kiosk-authenticate` (anchor-machine pattern, as the Material Kiosk). No `kiosk_sessions` row is written, so a PIN here never displaces the operator's tablet session (D-KIOSK-04 crossfire cannot recur). Anyone with a PIN can print; Start Setup requires `machinist` or `admin`. 2-minute inactivity sign-out; "Done" signs out immediately. |
| D-TKIOSK-10 | Staleness semantics | A job that has never been printed is not stale — there is no paper to be wrong. `isPaperworkStale` returns false when `traveler_printed_at` is NULL. Printed-then-changed is unchanged: Compliance Review lists it, the kiosk banner shows it, and the lineup row reads "Changed since last print — reprint". JS-only; no SQL twin exists. |
| D-TKIOSK-11 | ~~Production cards are PDF~~ | **Superseded by D-TKIOSK-11a.** |
| D-TKIOSK-11a | Production cards stay Excel; print copies | The Excel file Roger uploads stays the file of record everywhere. An S3-triggered Lambda (`skynet-print-copy`, container image, Ubuntu 24.04 + LibreOffice 24.2) writes `<key>.print.pdf` beside every `.xls/.xlsx/.XLS/.XLSX` object; it only reads the workbook. It prints the sheet the file was saved on (read from the file — headless LibreOffice ignores an `.xls` file's saved view), with its print area and page setup, other sheets hidden not deleted so formulas still calculate; macros never run, external links never update. A one-time sweep (`{"sweep":true}`) backfills the cards on file (189 distinct production-card keys on PROD, all under `jobs/`). The kiosk fetches the print copy; no copy yet → that card goes on the "Not printed — see Roger" page. No schema change. Roger saves each card with its card tab showing. |
| D-TKIOSK-13 | Print Production Card | Every lineup row with a Production Log (Blank) on file — the on-machine job first — carries a second button, **Print Production Card**, that prints that one PDF and nothing else. One tap, one card; tap again for another. It does not touch `traveler_printed_at` (the traveler was not reprinted); it writes `audit_logs` `event_type='production_card_printed'`. Hidden when the job has no card on file. **Amended by D-TKIOSK-13a / 13b:** the button shows whenever a card is on file. 13b (Batch A3): an Excel card prints from its print copy, so the button is enabled; if the copy is not there yet the tap says so ("print copy not ready — see Roger"). The "needs PDF from Roger" wording is retired. |
| D-TKIOSK-06a | One print per job; record before print | Batch A printed every pack twice (the iframe's blank and srcdoc loads each called print(); reproduced in headless Chromium) and both test stamps never left the browser. `printHtmlJob` now prints exactly once; stamp + audit are written once the pack is built, before print(). |
| D-TKIOSK-12 | Rollout | `FEATURES.TRAVELER_KIOSK` true on TEST from Batch A; PROD flag flips on cutover day after the PC is set up, the production-card print copies are live (runbook steps 0–9), and Roger has been told. Day one: bins recycled; the kiosk reprints each job as it comes up. |

---

## 6. Production Card Print Copies (D-TKIOSK-11a)

No schema migration this sprint. Production cards stay Excel — that is what Roger uploads and what SkyNet keeps (Matt, Oct 7). A browser cannot print an Excel form faithfully, so an AWS Lambda makes a PDF print copy beside each workbook and the kiosk prints the copy.

**Status (Oct 8):** deployed on image 1.1; **1.2 (always one page) delivered — deploy and re-sweep per the runbook's update section.** Smoke test reviewed on J-000168 and J-000161's real cards (1.0 hid the Form 10-150 footer; fixed in 1.1). Backfill sweep: 390 Excel files under `jobs/` converted, 0 failed, 0 remaining. Upload trigger verified on TEST: print copy written 2.3 s after upload. Open: runbook step 13 — Roger's one-time check of the review PDF.

**Delivered:** `skynet-print-copy.zip` (Dockerfile, `buildspec.yml`, `convert.py`, `handler.py`, least-privilege IAM policy, runbook `README.md`). Matt sets it up entirely in the AWS console — no command line: AWS CodeBuild builds the image from the zip in S3, and the function's Test tab runs the smoke test, the backfill and the review. The code is committed under `tools/print-copy/` in Batch A3.

**How it behaves**
- **Trigger:** S3 ObjectCreated, suffixes `.xls`, `.xlsx`, `.XLS`, `.XLSX` (S3 suffixes are case-sensitive; 11 of PROD's 189 cards are uppercase) → converts within seconds of Roger's upload. Output keys end `.print.pdf`, which no filter matches — no loop.
- **What prints:** the sheet the workbook was saved on, read from the file itself (xlrd / openpyxl); LibreOffice's answer is only the fallback because, headless, it ignores an `.xls` file's saved view and printed the wrong sheet in testing. Print area, orientation, margins and fit-to-page come from the sheet. Other sheets are hidden, never deleted.
- **Backfill:** `{"sweep": true, "prefix": "jobs/"}` lists the bucket and converts every Excel file whose copy is missing or older than the workbook; resumable, re-runnable, dry run by default.
- **Review:** `{"review": true}` writes `print-copy-review/review-<time>.pdf` — every distinct card once (duplicates collapsed by source ETag), one bookmark per card with its file name and printed sheet.
- **Headers and footers fit their text (1.1):** the cards' Form 10-150 footer sits at the bottom margin; LibreOffice clipped it to a 3.4-pt area and the first two real copies (J-000168, J-000161) printed without `REV 004 … Form 10-150`. The converter now turns on dynamic header/footer height for the printed sheet. The sweep reconverts any copy made by an older converter version.
- **Always one page (1.2):** J-000203's 223 SK2003-10C1 card printed as 2 pages at the kiosk — a fixed-scale card that fills Excel's page with no slack; LibreOffice's slightly taller rows plus 1.1's footer room pushed the last bordered row onto page 2. If the first export runs past one page, the sheet is set to fit 1 × 1 pages and exported again; cards that already fit are untouched.
- **Permissions:** read the bucket, list it, write only `*.print.pdf` and `print-copy-review/*`.

**Tested in the sandbox (LibreOffice 24.2.7, the build the image installs):** two-sheet card with the card on the second tab and a formula reading the first, as `.xlsx` and `.xls` → card only, one landscape letter page, formula correct; 180-row card → 4 pages, every row; uppercase `.XLSX`; corrupt file → clean failure; handler against a mocked bucket for trigger (URL-encoded key), keys, sweep dry/live/re-run, non-Excel ignored, time budget. **Not tested here:** the Docker build and AWS — runbook step 2 and step 5 are the first of each.

**Runbook (README.md, console only):** 0 check bucket + existing notifications → 1 zip to S3 `build/` → 2 ECR repository → 3 CodeBuild project (privileged) → 4 ECR push permission for its role → 5 build → 6 Lambda from the image → 7 memory/timeout/env → 8 inline S3 policy → **9 smoke test on J-000168 and J-000161's real cards — REVIEW STOP** → 10 four S3 notifications → 11 sweep until remaining 0 → 12 upload-trigger check on TEST → 13 `{"review": true}` builds one bookmarked PDF of every distinct card → Roger checks once.

**Operational rule for Roger:** save each card with its card tab showing — that sheet is the one that prints, exactly as on Ctrl+P in Excel.

### 6.1 Print spike (before Batch A)

`2026-10-07_TravelerKiosk_PrintSpike.html` and `Launch_PrintSpike.cmd` ship with this plan. Put both in one folder, set the Windows default printer, close every Chrome window (tray icon too), double-click the .cmd. It starts Chrome with `--kiosk-printing` in its own throwaway profile folder (`%LOCALAPPDATA%\SkyNetTravelerKiosk`) and opens the spike page. The separate profile matters twice: Chrome only honors flags on a fresh start, and a kiosk sign-out calls `signOut({scope:'local'})`, which would also sign the main app out of a shared profile (D-KIOSK-04). Test 0 on the page tells you whether the flag took: a print dialog means Chrome was still running — close it and relaunch.

| Test | What it proves | Pass |
|---|---|---|
| A | Traveler-style HTML prints silently, landscape | One landscape page, no dialog |
| B (v1 only) | A PDF in an iframe printed via `contentWindow.print()` | **Failed — SecurityError, cross-origin viewer frame** |
| C | PDF pages rendered to 300-DPI images on fixed letter pages, printed as HTML | 3 pages, portrait/landscape/portrait, no blanks, 6-pt text readable |
| D | The whole pack as one job: landscape traveler, 3 document pages, notice page | 5 pages in order, no dialog, no blanks |

**Result, Oct 7 (Chrome 154):** 0 and A passed; B failed with `SecurityError` — the PDF viewer frame is cross-origin and cannot be scripted. Spike v2 drops B; C (300-DPI raster pages, inch-sized named pages) and D (the whole pack as one job: traveler, three document pages, notice page) are the remaining checks. Pass = every page comes out in order, no dialog, no blank pages, the 6-pt line on page 3 readable.

---

## 7. Code Changes

### 7.1 New / changed files

| File | Type | Change |
|---|---|---|
| `src/pages/TravelerKiosk.jsx` | New | PIN screen → machine grid → lineup → print → setup prompt → done. Shell mirrors `MaterialKiosk.jsx`; lineup query mirrors `Kiosk.jsx` `loadJobs` (plus `traveler_printed_at`, `paperwork_changed_at`, `paperwork_ack_at`, `merged_into_job_id`, `work_order.maintenance_type`). `document.title='Traveler Kiosk'`. 2-min idle. |
| `src/lib/travelPack.js` | New | `buildTravelPack(supabase, jobId)` → `{ html, docs[], pageCount, skipped[] }`: fetches the canonical traveler and the job's documents in parallel (`getDocumentUrl` → `fetch` → bytes, as the cert package does), renders PDF pages to PNG at 300 DPI via pdf.js, embeds images as they are, lists spreadsheets/unknown types on a final "Not printed — see Roger" page, and assembles one HTML document under the pack CSS (named pages `trav` / `docp` / `docl`, inch units). `printHtmlJob(html)` → hidden srcdoc iframe, `focus(); print()` on load, resolves on `afterprint` with a timeout fallback (the `PrintTraveler.jsx` pattern). `recordTravelPackPrint(supabase, { job, machine, operator, pack })` → stamp + audit. `printProductionCard(supabase, { job, machine, operator })` → the job's `production_log_blank` PDF rendered the same way and printed alone, audit only (D-TKIOSK-13). |
| `src/lib/jobSetup.js` | New | `startJobSetup(supabase, { job, machine, operator })` — the lifted normal-production branch of `handleStartSetup` incl. the `machine_idle_logs` fire-and-forget. Returns `{ error }`. |
| `src/lib/pdfjsLoader.js` | New | `ensurePdfJs()` — the cdnjs pdf.js 3.11.174 URLs and `loadScript` as `BOMUpload.jsx` uses them, lifted so two surfaces share one loader. `BOMUpload.jsx` is left as is this sprint. |
| `src/lib/jobMerge.js` | Update | `isPaperworkStale`: `if (!job?.traveler_printed_at) return false` ahead of the comparison (D-TKIOSK-10). |
| `src/pages/Kiosk.jsx` | Update | `handleStartSetup` normal-production branch calls `startJobSetup`; secondary and maintenance branches untouched; pending_compliance guard untouched. Stale banner copy: "changed since this traveler was printed". |
| `src/components/ComplianceReview.jsx` | Update | Traveler Outdated header sub-line: "Jobs printed before a change. Never-printed jobs print current at the kiosk." (Upload guard: next row.) |
| ~~Upload guard refusing Excel production cards~~ | Dropped | Production cards stay Excel (D-TKIOSK-11a). No change to any upload path. |
| `tools/print-copy/` | New (A3) | Dockerfile, convert.py, handler.py, iam-policy.json, trust-policy.json, README.md — the Lambda as deployed. |
| `tools/traveler-kiosk/Launch_TravelerKiosk.cmd` | New (A3) | The Chrome `--kiosk-printing` launcher, in the repo so the PC setup is reproducible. |
| `src/App.jsx` | Update | `<Route path="/traveler-kiosk" element={<TravelerKiosk />} />` beside `/material-kiosk`. |
| `src/config.js` | Update | `FEATURES.TRAVELER_KIOSK: true` with a comment in the house style. |
| `Docs/Decisions.md` | Append | D-TKIOSK-01 … 13 across the three batches. |
| `Docs/migrations/` | Add | Batch C step files (TEST-passed copies) under their delivered names. |

### 7.2 Screens (TravelerKiosk.jsx)

1. **PIN** — `PinPad` with a Printer icon, "Traveler Kiosk", keyboard digits accepted.
2. **Machine** — one screen, tiles by location (Leesburg Main, Tavares). No search box; 20 tiles fit. Header shows the operator's name and a sign-out.
3. **Lineup** — rows: position · J# · part · description · run target (`getRunTarget`) · customer · due · status chip · print line ("Printed Tue 2:15 PM by Carlos" / "Not printed" / amber "Changed since last print"). Row buttons: **Print Travel Pack** (assigned) or **Reprint** (printed or on-machine), plus **Print Production Card** on every row that has a card on file — the on-machine job sits first, so a mid-run card is one tap. Greyed rows for pending_compliance. Back to machines, sign out.
4. **Printing** — "Building the pack… Traveler · Drawing · Production Log" then "Sent to the printer." Pack build fetches the traveler and the documents in parallel.
5. **Setup prompt** — "Put J-000255 in setup on NT-3?" **Start Setup** / **Not yet**. Hidden when the machine has an active job ("NT-3 is still running J-000240 — finish it at the machine kiosk first") or the operator cannot operate. Out-of-order confirm if not first.
6. **Done** — "J-000255 is in setup on NT-3 — head to the machine." **Done** signs out; auto sign-out at 2 minutes regardless.

### 7.3 Critical names (do not guess)

- `jobs.traveler_printed_at`, `jobs.traveler_printed_by`, `jobs.paperwork_changed_at`, `jobs.paperwork_changed_reason`, `jobs.paperwork_ack_at`, `jobs.setup_start`, `jobs.assigned_user_id`, `jobs.assigned_machine_id`, `jobs.scheduled_start`, `jobs.merged_into_job_id`, `jobs.documents_deferred`
- `job_documents.file_url` (S3 key, not a URL), `file_name`, `mime_type`, `file_size`, `document_type_id`, `source`, `status`; `part_documents.is_current`, `version` ("Rev A"), `revision_notes`
- `document_types.code` (`drawing`, `production_log_blank`, `material_cert`, …), `document_types.sort_order`
- `machines.kiosk_enabled`, `is_commissioned`, `is_active`, `machine_type`, `location_id`, `display_order`, `locations.name`
- `audit_logs(event_type, job_id, machine_id, operator_id, details)` — no `created_by`
- `machine_idle_logs(machine_id, previous_job_id, next_job_id, idle_start, idle_end, idle_minutes)`
- `kiosk-authenticate` body `{ pin, machine_id, device_id }` → `{ success, access_token, refresh_token, operator { id, full_name, username, role } }`; call `supabase.auth.setSession` then `stopAutoRefresh`
- `work_orders.maintenance_type` (non-null = maintenance WO)
- pdf.js CDN: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js` + `pdf.worker.min.js` (as `BOMUpload.jsx`)

---

## 8. Claude Code Prompt Batches

Spike first (§6.1, Matt, 10 minutes). Then three batches, one in flight at a time, ✅ before the next. Each prompt names its branch, builds in the working tree and stops (D-PROC-01).

### 8.1 Batch A — Kiosk shell + travel pack print (`feature/s14-traveler-kiosk`)

- `config.js` flag, `App.jsx` route, `TravelerKiosk.jsx` screens 1–4 and 6 (prompt deferred to B), `travelPack.js` (one-job HTML pack per D-TKIOSK-06), `pdfjsLoader.js`.
- Stamp + audit on every pack print (D-TKIOSK-07). Reprint allowed. **Print Production Card** on the lineup (D-TKIOSK-13) — same print engine, one PDF, audit only.
- Decisions append: D-TKIOSK-01 … 07, 09 (identity), 12 (flag), 13 (production card).
- **Verify (laptop, kiosk profile, TEST):** PIN in → NT-3 → lineup matches `/kiosk/NT-3` queue order → Print Travel Pack on an assigned job → traveler + drawing print silently in order; `jobs.traveler_printed_at/by` = the operator; `audit_logs` row present; Print Production Card on the on-machine job prints one card and only an audit row changes; a job with an Excel card prints the "Not printed" page, the screen says so, and Print Production Card is hidden for it; pending_compliance row not printable; 2-minute idle signs out; a non-PIN or wrong PIN is refused.

### 8.1a Batch A2 — first-test fixes (Oct 7) — PASSED Oct 8

- `2026-10-07_D-TKIOSK-A2_CC_Prompt.md`: `travelPack.js` and `TravelerKiosk.jsx` replaced whole; D-TKIOSK-04a, 06a, 13a appended.
- Matt's browser pass, Oct 8: one copy per print; J-000161 stamped and audited (18:47); no material cert in any pack; card button on the seeded J-000175 card prints one page per tap.
- J-000175's first card attempt failed "file could not be read": TEST still pointed its drawing (and the Oct 7 seed) at the AC48 drawing PROD replaced on Sep 29 and removed from S3. Corrected on TEST by `2026-10-08_TEST_ONLY_fix_tkiosk_j175_docs.sql` (drawing → PROD's current AC58 drawing; seed → J-000161's real card print copy). Kiosk behaved correctly: plain error, nothing printed, nothing recorded.

### 8.1b Batch A3 — Excel cards print from their print copies

- First commits the approved Batch A + A2 working tree on `feature/s14-traveler-kiosk`.
- `travelPack.js`: `docKind` adds `excel` (`.xls/.xlsx/.xlsm` or Excel mime); an Excel document is fetched as `<file_url>.print.pdf` and rendered like any PDF; no copy → "print copy isn't ready yet" on the Not printed page, and "print copy isn't ready yet — see Roger" on the card button. Audit `docs[]` carry `print_copy: true` for those (D-TKIOSK-13b).
- Print failure after the stamp: `recordPrintFailed` puts back the job's previous `traveler_printed_at/by` — only while the kiosk's stamp is still the latest — and writes `travel_pack_print_failed` (or `production_card_print_failed` for a card) (D-TKIOSK-06b).
- `TravelerKiosk.jsx`: card button enabled for Excel cards; "needs PDF from Roger" wording retired; both handlers call `recordPrintFailed` on a print error.
- Commits `tools/print-copy/` (as deployed, 1.1, LF via `.gitattributes`) and `tools/traveler-kiosk/Launch_TravelerKiosk.cmd` (CRLF); replaces the repo's v1.0 plan copy with this v1.7.
- Verified before delivery: the real `travelPack.js` run in Node against stubbed S3 / pdf.js / Supabase — 24 checks (fetch-key choice, missing copy, pack contents, stamp restore and its guard, audit rows) all pass.
- Answered without change: a traveler longer than one page is not cut off — a 40-row traveler printed through the pack CSS in headless Chromium ran to 3 landscape pages with every row and the notes box present.

### 8.1c Batch A3 — PASSED Oct 8; Batch A4 — converter 1.2 into the repo

- A3 browser pass, Oct 8 (TEST audit rows): J-000161 pack 3 pages with its card printed from the print copy; J-000161 card button 1 page; a brand-new Excel card uploaded to J-000174 printed in its pack; every print stamped and audited; no failures. One defect: J-000203's card printed 2 pages → converter 1.2.
- `2026-10-08_D-TKIOSK-A4_CC_Prompt.md`: commits A3; updates `tools/print-copy/` to 1.2 (SHA-256 checked); this plan v1.8; D-TKIOSK-11b.

### 8.2 Batch B — Setup prompt, shared setup helper, staleness

- `jobSetup.js`; `Kiosk.jsx` normal-production branch calls it (surgical, both-or-neither); `TravelerKiosk.jsx` screen 5 + machine-busy gate + out-of-order confirm + canOperate gate.
- `isPaperworkStale` never-printed rule; Kiosk banner copy; Compliance Review worklist sub-line; lineup "Changed since last print" flag.
- Decisions append: D-TKIOSK-08, 10.
- **Verify (TEST):** Start Setup from the kiosk → `/kiosk/NT-3` tablet shows the job in setup live (realtime), `assigned_user_id` = operator, `machine_idle_logs` row; a second job cannot be started while one is active; starting the second-in-line prompts; machine kiosk Start Setup still works end to end (Confirm & Start Production unaffected); a never-printed job with `paperwork_changed_at` is gone from Traveler Outdated; a printed job rescheduled to another machine appears there and the lineup row flags it.

### 8.3 Batch C — Print copies live, PC rollout, close-out

- ~~Deploy `skynet-print-copy`~~ — done Oct 8 (image 1.1, 390 converted, trigger verified). Roger checks the review PDF once (runbook step 13).
- Kiosk PC runbook (§9) executed by Harry/Kevin; PROD `FEATURES.TRAVELER_KIOSK` flip; Roger cutover; bins recycled.
- Spec v4.9 (§5.38 Traveler Kiosk incl. print copies; §5.4 and §5.29 cross-references; Document History row), Decisions sprint entry, this plan marked CLOSED, cheat sheet update.
- Decisions append: D-TKIOSK-11a (deployed: function, image tag, sweep counts, review outcome), sprint close.

---

## 9. Kiosk PC Runbook (Harry / Kevin)

1. Windows PC, Chrome installed, wired to the LAN, the travel-pack printer installed and set as the Windows default (Settings → Printers → turn off "Let Windows manage my default printer"). Printing preferences: Letter, single-sided, auto-rotate on, color as the printer allows.
2. Desktop shortcut target:
   `"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing --kiosk "https://skynet.skybolt.com/traveler-kiosk"`
   (`--kiosk-printing` is the one that matters; `--kiosk` hides the browser chrome. Drop `--kiosk` while testing.)
3. Copy the shortcut into `shell:startup`; set power to never sleep (display off is fine — a touch or mouse wakes it).
4. Nothing else runs in that Chrome. If someone needs the main app on that PC they use a different browser or profile — a kiosk sign-out signs out the whole profile.
5. First print: PIN in, pick a machine, print one pack, hand it to Roger to compare with his bin copy.

---

## 10. Test Checklist

| ID | Test Case |
|---|---|
| T-01 | Spike: tests A–D results recorded; path chosen and named in the Batch A prompt. |
| T-02 | `/traveler-kiosk` renders the PIN pad with `FEATURES.TRAVELER_KIOSK=true`; a "feature off" page when false. |
| T-03 | Valid PIN authenticates; invalid PIN clears with "Invalid PIN"; no `kiosk_sessions` row is written; a machinist already PIN'd into a tablet is not logged out of it. |
| T-04 | Machine grid shows all 20 production machines grouped Leesburg Main then Tavares; FIN-1/FIN-2 absent. |
| T-05 | Lineup order equals the machine kiosk queue; on-machine job pinned first; pending_compliance greyed; maintenance WOs absent. |
| T-06 | Print Travel Pack on an assigned job: traveler then documents in `sort_order` order come out with no dialog (kiosk profile); run target shown on the traveler matches the lineup. |
| T-07 | `jobs.traveler_printed_at/by` stamped with the operator; `audit_logs` `travel_pack_printed` row with doc list. |
| T-08 | Job whose card has no print copy yet: the pack prints traveler + drawing + the "Not printed — see Roger" page; Print Production Card says "print copy not ready". |
| T-09 | Job with no documents: traveler alone prints; no error. |
| T-10 | Reprint on an already-printed job works and re-stamps. |
| T-11 | Setup prompt appears after print on an idle machine; hidden when the machine has an active job; hidden for a non-machinist/non-admin PIN. |
| T-12 | Start Setup: `status='in_setup'`, `setup_start`, `assigned_user_id`; `machine_idle_logs` row when a previous job ended; `/kiosk/<code>` shows it live. |
| T-13 | Not-first-in-line job prompts the out-of-order confirm; Cancel leaves the job assigned. |
| T-14 | Machine kiosk Start Setup (normal branch) still works after the refactor; maintenance and finishing branches untouched. |
| T-15 | Never-printed job with `paperwork_changed_at` is absent from Traveler Outdated and shows no stale banner at the kiosk. |
| T-16 | Printed job rescheduled to another machine: appears in Traveler Outdated, kiosk banner shows, lineup row reads "Changed since last print". |
| T-17 | 2-minute inactivity signs out; Done signs out immediately; next PIN starts clean. |
| T-18 | Upload an Excel card through SkyNet: within ~30 s `<file>.print.pdf` exists beside it (runbook step 8); the Excel file is unchanged. |
| T-19 | Sweep: dry run counts ≥ 189 Excel files under `jobs/`; live runs reach `remaining: 0`; `failed_keys` empty or each one explained; a second dry run reports 0 needing a copy (apart from explained failures). |
| T-20 | PROD: first real pack printed on the PC matches Roger's bin copy page for page; Roger confirms, bins recycled. |
| T-21 | Print Production Card: one tap prints one card and nothing else; a second tap prints another; `traveler_printed_at` unchanged; `audit_logs` `production_card_printed` row; button absent on a job with no card on file. |
| T-22 | An Excel card prints at the kiosk from its print copy — pack and Print Production Card — and matches Roger's Excel printout of the same card page for page. A forced print failure restores the previous stamp and writes `travel_pack_print_failed`. |
| T-23 | Every production card prints on exactly one page — J-000203's 223 SK2003-10C1 card included — with its frame closed and its footer present. |

---

## 11. Risks & Open Items

- **Printing depends on two Chrome behaviours:** `--kiosk-printing` honoring `window.print()` from a hidden iframe (spike test A), and named `@page` sizes mixing in one job (spike test D). Both are plain HTML printing with no plugin involved, so a Chrome update is unlikely to break them — T-06 is the post-update smoke test regardless.
- **Image quality.** Drawings print as 300-DPI images, not vectors. On a laser printer that is indistinguishable at reading distance; spike test C's 6-pt line is the check. If a drawing ever reads soft, the DPI is one constant.
- **Print copies not live yet.** Until the Lambda is deployed and the sweep has run, every pack prints its card on the "Not printed — see Roger" page and Roger covers from the Print Package. The runbook is the dependency for going hands-off.
- **Conversion fidelity.** LibreOffice may lay out a few cards differently from Excel (scaling, page breaks, logos). The smoke-test review stop and Roger's one-time review PDF catch it; a card that won't convert well can be fixed in Excel (print area, fit-to-page) and re-uploaded, which re-triggers the copy. Also: a card saved with the wrong tab showing prints that tab — Roger saves with the card tab showing.
- **Printer offline.** With silent printing the kiosk cannot see the Windows queue. The stamp still records the intent; the machinist sees nothing come out and reprints after the printer is back. Acceptable for one PC next to the printer.
- **Shared-profile sign-out.** Any browser that runs the kiosk shares one supabase-js session; a kiosk sign-out signs out the main app in that profile (D-KIOSK-04). Dedicated profile on the PC; separate profile on the laptop.
- **Large drawings.** Multi-page or multi-MB PDFs add a few seconds to the pack build (pdf.js renders about two pages a second); the screen shows progress. A 300-DPI letter page is a 2550×3300 canvas — fine for the 2–4 documents a job carries.
- **Tavares.** Both Tavares machines are `kiosk_enabled=false`; the traveler kiosk is still their setup path (D-TKIOSK-08). Whether a second kiosk PC goes to Tavares is a later question.

---

## 12. Spec & Documentation Updates

- SkyNet_Specification bumps to **v4.9**: new §5.38 Traveler Kiosk (route, auth, lineup, pack contents, print mechanics, setup prompt, staleness semantics, PDF-only production logs); §5.4 Compliance Review and §5.29 Paperwork Issues cross-references; Document History row.
- `Docs/Decisions.md` — D-TKIOSK-01 … 12 appended by the batch prompts; sprint close entry.
- `Docs/migrations/` — Batch C step files as delivered; TEST-only seed files (if any) marked TEST_ONLY.
- `SkyNet_Claude_Cheatsheet.docx` — anything that made the sprint run better.

---

## 13. Definition of Done

- All 23 test cases pass on TEST; T-20 passes on PROD.
- Spike result recorded in Decisions (D-TKIOSK-06 names the path).
- Every in-flight production card has a current print copy; new uploads get one automatically; Roger has checked the review PDF.
- Kiosk PC running the shortcut; Roger no longer printing; bins gone.
- `feature/s14-traveler-kiosk` merged to test and main, main == test.
- Spec v4.9 generated; Decisions updated; this plan marked CLOSED with actual outcomes.
