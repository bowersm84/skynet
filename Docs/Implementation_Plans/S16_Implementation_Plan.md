# SkyNet Sprint 16 — Implementation Plan
## Customer Program Dashboard: Kaytech (orders, piece tracking, email trail, Uncle Bob)
### v1.2 — CLOSED October 28, 2026 · Decision family D-CPROG (D-CPROG-01 → D-CPROG-18)

> **Status at close (v1.2):** Batches A, B and C are live on PROD (Oct 28). Batch C took Matt's ruling on what Uncle Bob may read (D-CPROG-16), moved to claude-opus-5-5 with structured outputs, and added D-CPROG-18 (export-marked email text not stored). **Batch D (QuickBooks, §7a) is superseded** by a company-wide QuickBooks mirror in S17; its draft plan is kept as `S16_BatchD_QuickBooks_Plan.md` for the design. Handoff: `Docs/S17_Handoff_2026-10-28.md`. Spec v5.0 §5.39.

> **v1.1 changes (Batch A build):** customer programs got their own tables instead of Giza's `programs` / `program_ledger` (D-CPROG-01a, D-CPROG-06); order lines filter on Fishbowl part type, not the Order Queue disposition (D-CPROG-15); the open invoices are confirmed; Matt is the Workspace admin; a QuickBooks link is added as Batch D (§7a).

---

## 1. Goal

One place where the whole Kaytech story lives: every open order at a glance, each order broken down to the piece and lot (as Giza is), the money (deposits, open invoices, the $50,000 line), and the email trail between Kaytech and Skybolt. A small roster can ask Uncle Bob questions against all of it.

Kaytech is the first customer program. It's built generic so the next difficult account is a new row, not a new sprint.

**Roster (D-CPROG-02):** Matt, Ned Bowers, April Braun, Christy Exum, Ashley Hall. No one else sees the page, the emails or the money.

---

## 2. How it differs from Giza

Giza is one product with a fixed pipeline (nut → plating → dry film → assembly → bag lot). Kaytech is one customer with many POs, and the POs move in three different ways:

| Order type | Kaytech lines today | How pieces move |
|---|---|---|
| **Build** | QL4-21 (PO 165058, 165251), QL4S-ET2 (165128), SK26S8-5 (165240) | Drawing sign-off → deposit → CO / WO → components → jobs → assembly → inspection → balance paid → shipped → invoiced |
| **Stock / rework** | QL8C78 (PO 162948) | Lots on hand → deburr → inspection → relabel (R) → bag → allocate → shipped |
| **Buy-in** | QL4S-RET1 (PO 165184) | Deposit → supplier PO → received → inspection → balance paid → shipped |
| **Quote** | QL8C10 (RFQ 371300) | Quoted → PO received → drawing → deposit → becomes a Build line |

So the data model reuses Giza's `programs` and `program_ledger`, and adds a per-line tracking layer on top of the Fishbowl sales-order mirror.

---

## 3. Data sources (most of it already exists)

| What the dashboard shows | Source | New? |
|---|---|---|
| Open POs, quantities, prices, shipped qty | `fb_sales_orders` / `fb_sales_order_lines` (bridge), filtered by Kaytech's `fb_customer_id` | No |
| COs, WOs, jobs, good pieces, lot numbers | `customer_orders`, `customer_order_lines`, `work_orders`, `jobs`, `work_order_assemblies` | No |
| Component stock (QL4C-CAGE, QL4-BASE, QL4-NUT) | `fb_part_inventory`, `assembly_bom` | No |
| Component buys (cages, RET1 rings) | `fb_purchase_orders` / `fb_purchase_order_lines` (bridge 1.9+) | No |
| Shipped lots | `fb_shipment_lots` | No |
| Rework / lot moves (QL8C78 deburr, relabel, quarantine) | `program_ledger` (Giza's movement ledger) | Reused |
| Drawing sign-off, terms, deposit flags per line | `program_line_tracking` | **New** |
| Deposits, invoices, payments, credits | `program_money` | **New** (manual entry; SkyNet has no QuickBooks link) |
| RFQs without a PO | `program_quotes` | **New** |
| Email trail | `program_emails` + Gmail ingest | **New (Batch B)** |
| Uncle Bob Q&A log | `program_ai_threads` | **New (Batch C)** |

---

## 4. Decisions with defaults (say GO to take all defaults)

| ID | Decision | Default |
|---|---|---|
| D-CPROG-01 | Build generic or Kaytech-only | **Generic.** Own tables (`customer_programs` + `cp_*`), parallel to Giza's (D-CPROG-01a). Route `/dashboards/program/kaytech`; menu shows only programs the user is rostered on. |
| D-CPROG-02 | Who sees it | **Roster table `program_access`.** RLS on every new table checks the roster (admin always passes). Giza stays as-is (every role views). |
| D-CPROG-03 | Who can write (ledger moves, money, line flags) | Matt and Ashley write moves; **only Matt writes money**. Ned, April, Christy view and ask Bob. |
| D-CPROG-04 | Deposits / AR source | **Manual entry by Matt**, append-only with void (same pattern as `program_ledger`). Each row: kind (deposit requested / deposit received / invoice / payment / credit), PO, amount, reference, date. QuickBooks link is a later round. |
| D-CPROG-05 | Credit-line gauge | Open invoices (from `program_money`) + the value of the next on-terms release, against `programs.credit_limit` ($50,000). Releases that would cross the line show **Hold — waits for payment**. Any invoice > 30 days past due puts every on-terms line on Hold. |
| D-CPROG-06 | QL8C78 lot tracking | Lots as `cp_moves` rows (from stage → to stage, relabel allowed): JP4146R 700 ready, JP4147R 400 ready, 4142 566 / 4144 254 / 4149 830 to deburr, IMG_8039 short-pin bag in quarantine. Stud-length checks are `cp_lot_checks` rows, so "which lots are long-stud" is answerable. |
| D-CPROG-07 | Email capture mechanism | **Gmail API, read-only, Google Workspace service account with domain-wide delegation,** polled every 10 minutes by a Supabase Edge Function on pg_cron. Mailboxes allowlisted in code: the five roster members. |
| D-CPROG-08 | Which emails land on the dashboard | Any message with a **@kaytech.com** address in From/To/Cc, from any of the five mailboxes, **plus anything Matt files under his Gmail label "Kaytech"** (so internal threads like the Ned review of the RMA email come in only when Matt chooses). Deduped on RFC822 Message-ID, so a thread seen in three mailboxes appears once. |
| D-CPROG-09 | Attachments | **Metadata only** (filename, type, size, link back to Gmail). Contents are never stored or sent to Uncle Bob. Org rule: no processing of customer-owned drawings or technical data, and Kaytech's attachments include OEM drawings. |
| D-CPROG-10 | Email body storage | Store the new text of each message with quoted history stripped (full body kept in a separate column for the viewer only). Bob reads the stripped text. |
| D-CPROG-11 | Linking emails to orders | Auto-tag on PO numbers, SO numbers, RFQ numbers, RMA numbers and part numbers found in subject/body; roster can retag or hide a message (soft hide, audited). |
| D-CPROG-12 | Backfill | Ingest from **2026-01-01** forward on first run (covers the payment dispute, RMA 261007-20, the deposit thread). |
| D-CPROG-13 | Uncle Bob scope | **Read-only.** Answers from the program envelope, cites every claim (email date + sender, or SO/PO number), says plainly when the data doesn't cover the question. It may draft a reply for the user to copy; it never sends, never promises a date that isn't in the data. Same model and SSE/heartbeat pattern as the schedule and reports advisors. |
| D-CPROG-14 | Q&A history | Every question and answer saved in `program_ai_threads` (who asked, sources used), visible to the roster, so the team builds on each other's answers instead of re-asking. |

---

## 5. Batch A — Program schema and the dashboard

**Migration `2026-10-xx_customer_program.sql`** (TEST first, scratch-rehearsed):
- `programs`: add `program_type text not null default 'product'`, `fb_customer_id int`, `credit_limit numeric`, `deposit_pct numeric`.
- `program_access (program_id, profile_id, added_by, added_at)` + `_program_member(program_id)` helper used by RLS and RPCs.
- `program_line_tracking (program_id, fb_soitem_id, flow 'build'|'stock'|'buyin', terms 'deposit'|'net30', drawing_sent_at, drawing_signed_at, deposit_required, notes, updated_by/at)`.
- `program_quotes (program_id, rfq_number, part_id/part_num, qty, unit_price, quoted_at, status 'open'|'won'|'lost', converted_fb_so_id, notes)`.
- `program_money (program_id, kind, po_number, fb_so_id, amount, reference, txn_date, entered_by, notes, voided_*)`.
- `program_ledger`: new stage values for customer programs (`deburr_in`, `deburred`, `inspected`, `relabeled`, `quarantine`, `allocated`) plus `measured_value numeric`.
- View `v_program_customer_lines`: Fishbowl lines (product lines only, service lines such as UPS ACCT, MFG CERTS, DEPOSIT excluded) joined to tracking, CO/WO/job progress, component stock and shipped qty.
- Seed (PROD file, run by Matt): Kaytech program row, roster of five, the six open lines, RFQ 371300, QL8C78 lots, the two deposit requests ($43,029.02 QL4-21, $16,425.00 QL4S-RET1), the $41,670.00 deposit invoice marked superseded, and the two open invoices **after Crystalyn confirms them** ($2,704 SK26S8-5, $572 SK212-12S).

**Page `src/pages/dashboards/ProgramDashboard.jsx`**, tabs:

1. **Overview** — open value, on-terms vs deposit split, credit gauge (used / headroom / next release), deposits requested vs received, next expected ship, lines on Hold.
2. **Orders** — one card per PO line with its stage pipeline (Section 2), quantities at each stage, days open, and the blocker in plain words ("Waiting on deposit", "Waiting on drawing sign-off", "QL4C-CAGE: 0 on hand, 0 on order").
3. **Order detail** (click a card) — the Giza-style breakdown: components and coverage, jobs with PLN/FLN, lots, ledger moves, shipments, money rows and linked emails for that PO.
4. **Lots** — QL8C78 lot table (qty, stage, stud length, allocated to which PO).
5. **Money** — deposits, invoices, payments, credits; Matt-only entry.
6. **Movements** — daily ledger view, printable (reuse the Giza Movements tab).
7. **Quotes** — open RFQs.

**Tests:** gauge math against today's workbook numbers ($56,055.45 if everything shipped on terms at once; $25,441 after the 1,100 QL8C78); a non-roster user gets no menu entry and an empty RLS read; Hold logic flips when a past-due invoice is added.

---

## 6. Batch B — Email trail

**Setup (people, before code ships):**
1. Google Workspace admin creates a service account in a Skybolt Google Cloud project and authorizes its client ID for domain-wide delegation with **only** `https://www.googleapis.com/auth/gmail.readonly`.
2. Key goes into Supabase Edge Function secrets (PROD and TEST separately). Never in the repo.
3. Matt confirms the five mailbox addresses.

**Migration:** `program_emails` (message ids, thread id, mailbox seen in, from/to/cc, sent_at, subject, body_new, body_full, attachments jsonb metadata only, direction in/out/internal, linked_refs text[], hidden_at/by), `program_email_sync_state` (mailbox, last history id, last run, last error), RLS by roster.

**Edge Function `program-gmail-ingest`:** every 10 minutes; per mailbox, incremental via Gmail history id after the backfill; Gmail query `{from:kaytech.com to:kaytech.com cc:kaytech.com}` plus `label:Kaytech` for Matt's mailbox; strip quoted text; tag refs; upsert on Message-ID.

**Page:** Email tab — threaded timeline, filter by PO / part / person, search, "open in Gmail" link, and each Order detail shows its own linked emails. A sync status line shows the last successful pull so nobody wonders whether it's current.

**Tests:** backfill count against a Gmail search count for the same window; a message seen in Matt's and Ashley's mailboxes appears once; an attachment shows name and size only; a non-roster account sees nothing.

---

## 7. Batch C — Uncle Bob on the dashboard

**Edge Function `uncle-bob-program`:** builds the envelope (program summary, lines with pipeline status and blockers, lots, money, quotes, last 60 days of ledger, emails newest-first trimmed to a token budget), streams the answer over SSE with the 10-second heartbeat.

**System rules:** read-only; every claim cited; says "the dashboard doesn't show that" rather than guessing; no delivery dates not already in the data; drafts are labeled drafts; never quotes attachment contents (it never has them).

**Page:** "Ask Uncle Bob" panel on every tab, with starter questions ("What's holding up QL4-21?", "What did we last tell Kaytech about the deposit?", "Which QL8C78 lots are long-stud?"), and a shared history of past questions.

**Tests:** five scripted questions with known answers from the seed; one question the data can't answer (Bob must say so); a question asking for a promised ship date (Bob must decline to invent one).

---

## 7a. Batch D — QuickBooks link for the money side

- Intuit developer app (QuickBooks Online accounting scope); Intuit asks for app details before issuing production keys.
- Matt or Crystalyn authorizes the connection once; tokens live in Supabase secrets (refreshed server-side), never in the browser.
- Edge Function `program-qb-sync`, every 15 minutes: invoices, payments and credit memos for each program's QuickBooks customer, written to `cp_money` with `source = 'quickbooks'` and `qb_txn_type` / `qb_txn_id` (columns and uniqueness already in Batch A). Read-only by code: the QuickBooks accounting scope has no read-only variant.
- Headers only (number, date, due date, amount, balance, PO / memo). No bank or card details are stored.
- Manual rows stay for deposit requests made by email; a synced QuickBooks deposit invoice supersedes its manual twin.

## 8. Order of work and dependencies

1. **Batch A** first. It's useful the day it lands, with no outside setup.
2. **Batch B** — Matt is the Workspace admin, so nothing outside Skybolt blocks it.
3. **Batch C** can start on order data alone; it gets its full value once B is ingesting.

CC prompts need a current `src` export for anchors. Upload one at GO.

---

## 9. Open items before PROD

- ~~Crystalyn confirms Kaytech's open invoices~~ Confirmed Oct 27; seeded.
- ~~Who is the Google Workspace admin?~~ Matt.
- How Crystalyn records deposits in QuickBooks (deposit invoice, sales receipt or unapplied payment) — decides the Batch D mapping.
- Drawing sign-off dates for QL4-21 (sent? signed?) for the seed.
- Stud-length measurements for JP4146R / JP4147R / 4149 as they come in.

## 10. Definition of Done

- Roster of five sees the Kaytech dashboard on PROD; nobody else does.
- Every open Kaytech line shows its stage and blocker without anyone re-typing Fishbowl data.
- Jody's deburr work on QL8C78 is logged as ledger moves and the Lots tab matches the floor.
- New Kaytech emails appear within 10 minutes in the trail, linked to the right PO.
- Ned or Christy asks Uncle Bob a question and gets a cited answer.
- Spec bumped, Decisions.md D-CPROG entries appended by CC, migrations and plan committed.
