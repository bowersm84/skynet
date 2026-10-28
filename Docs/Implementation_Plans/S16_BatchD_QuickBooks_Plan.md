# SkyNet S16 — Batch D Plan: QuickBooks Online → customer program money
### SUPERSEDED October 28, 2026 — not built. Folded into the S17 company-wide QuickBooks mirror (see Docs/S17_Handoff_2026-10-28.md). Kept for its design: OAuth app, Vault-held refresh token, read-only by code, CDC sync, taking over manual rows. Decision IDs D-CPROG-20 … were never assigned.

---

## 1. What we learned from Skybolt's QuickBooks today (read-only, via Matt's QuickBooks connector in chat)

| Finding | What it means for the design |
|---|---|
| Kaytech is QuickBooks customer **14255** ("KAYTECH INDUSTRIES /NY"), company (realm) **9341457805196692**. | One mapping row per program: `customer_programs.qb_customer_id`. |
| Invoice numbers are **S + Fishbowl SO** (S15933, S16497, S8291-04, S15392), the PO is in the **"P.O. Number" custom field** (and often the private memo), and each invoice is **one lump-sum "Sales" line**. | Invoices tie to SkyNet by SO number and PO. No part-level lines in QuickBooks — parts stay in Fishbowl / SkyNet. |
| The two open invoices are **S15933 $2,704.00 due Nov 7** and **S16497 $572.00 due Nov 14**, exactly what we seeded. S15392, S8291-05 and S13141 are paid; S8291-04 shows $0 balance (the RMA credit). | The seed was right; the sync will take these rows over rather than duplicate them. |
| **No deposit invoice or estimate exists in QuickBooks** for PO 165251 or 165058. The $41,670 "invoice" Michelle received came from outside QuickBooks (most likely Fishbowl, where SO 15968 carries a $0 DEPOSIT line). | Deposit **requests** stay in SkyNet (manual rows). QuickBooks only matters for deposits once the money arrives. |

**The one open question for Crystalyn:** when Kaytech actually pays a deposit, what does she create in QuickBooks? (a) a Payment left unapplied on the customer, (b) a Sales Receipt, (c) a deposit invoice she then marks paid, or (d) a bank deposit to an "Customer Deposits" liability account. Default below assumes (a).

---

## 2. Decisions with defaults (say GO to take all defaults)

| ID | Decision | Default |
|---|---|---|
| D-CPROG-20 | How SkyNet talks to QuickBooks | Its own **Intuit developer app** ("SkyNet"), QuickBooks Online Accounting scope, OAuth2. Matt (admin) connects it once. Refresh token in **Supabase Vault**, never in a table or the browser; access tokens are refreshed server-side. |
| D-CPROG-21 | Read-only | The accounting scope has no read-only variant, so the guarantee is the code: the sync only issues **GET / query / CDC** calls. No create, update, send or delete calls exist in the function. |
| D-CPROG-22 | What syncs | For each program with a `qb_customer_id`: **Invoices, Payments, Credit Memos** (and Sales Receipts if Crystalyn uses them), from 2026-01-01 forward. Headers only: number, date, due date, total, balance, PO field, memo, and which invoice a payment or credit applies to. **No bank account, card or payment-method details** are stored (organization rule). |
| D-CPROG-23 | Where it lands | `cp_money` rows with `source = 'quickbooks'`, `qb_txn_type`, `qb_txn_id` (columns and uniqueness already exist from Batch A). Invoice → `invoice` (reference = DocNumber, so_number from `S#####`, po from the P.O. Number field, due date from QuickBooks). Payment lines linked to an invoice → `payment` with `applies_to` that invoice. Credit memo → `credit_memo`. |
| D-CPROG-24 | Taking over the manual rows | When QuickBooks returns an invoice whose DocNumber matches a manual row's SO and amount (today: S15933, S16497), the sync **converts that row** to the QuickBooks one (source, ids, true dates) instead of adding a duplicate, and records the change. Manual rows that never match stay manual. |
| D-CPROG-25 | Deposits | Requests stay manual (Section 1). A QuickBooks payment with **no linked invoice** lands as an unapplied `payment`; if its PO field or memo names a PO with an open deposit request, the sync applies it to that request automatically, otherwise it shows under "Unapplied" on the Money tab for Matt to apply with one click. (Revisit once Crystalyn answers.) |
| D-CPROG-26 | Schedule and freshness | Edge Function `cp-qb-sync`, pg_cron every 15 minutes (same Vault-token pattern as the mail reader), using QuickBooks' **Change Data Capture** endpoint after the first full load so each run only reads what changed. Money tab shows "QuickBooks synced …" and any error. |
| D-CPROG-27 | Who sees it | No change: the money is already roster-only (D-CPROG-02). The credit gauge and Uncle Bob read the synced numbers automatically, since both read `cp_money`. |

---

## 3. Setup Matt does (about 30 minutes, once)

1. **developer.intuit.com** → sign in with the Skybolt Intuit account → **Create an app** → QuickBooks Online and Payments → scope **com.intuit.quickbooks.accounting** only.
2. Add redirect URIs for both projects (TEST and PROD), which the build will give you exactly (`…/functions/v1/cp-qb-oauth`).
3. Intuit asks a short set of app-details questions before issuing **production keys** (it's an internal app used by one company). Development keys work against a QuickBooks sandbox in the meantime, which is how TEST is wired.
4. Put the Client ID and Client Secret into Supabase **Edge Functions → Secrets** as `QB_CLIENT_ID` / `QB_CLIENT_SECRET` (TEST gets the development keys, PROD the production keys).
5. Open the "Connect QuickBooks" link the build adds to the Money tab (admin only) and approve once. The refresh token goes straight to Vault.

---

## 4. Build (one CC round plus SQL and two functions, same pattern as Batch B)

- **Migration:** `customer_programs.qb_customer_id`, `cp_qb_sync_state` (last run, last success, last error, CDC watermark), Vault-backed token RPCs callable only by the service role, Kaytech → 14255.
- **`cp-qb-oauth`:** starts the connect flow (admin only) and receives the callback; stores the refresh token in Vault and the realm id.
- **`cp-qb-sync`:** first full load from 2026-01-01, then CDC every 15 minutes; maps per Section 2; converts matching manual rows; never writes to QuickBooks. Pure mapping in a separate file with unit tests, like `parse.ts`.
- **Page:** Money tab shows a source badge per row (QuickBooks or manual), "QuickBooks synced …", an Unapplied list with "Apply to…", and the admin-only Connect button.
- **TEST:** sandbox company with a fake Kaytech, so nothing on TEST touches the real books.

## 5. Definition of Done

- PROD Money tab shows S15933 and S16497 as QuickBooks rows (not duplicates), with QuickBooks' own balances.
- A payment Crystalyn records in QuickBooks appears in SkyNet within 15 minutes and reduces the right invoice or deposit request.
- The credit gauge moves on its own when Kaytech pays.
- No call in the code can write to QuickBooks; the token lives only in Vault.
