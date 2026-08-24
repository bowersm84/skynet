# SkyNet MES — Fishbowl Bridge Implementation Plan

**Round FB1 — Fishbowl → SkyNet Sales Order Interface (create + change) and Order Queue**

Implementation Plan v1.1 · August 24, 2026 (v1.0 signed off same day; v1.1 folds in Matt's six answers)

**Owner:** Matt Bowers
**Status:** Batch A complete on TEST (Aug 24): migration `2026-08-25_fishbowl_bridge_a.sql`, bridge running from Matt's PC, backfill 144 SOs / 1,732 lines, parity exact, live tests T-05/06/08 passed, 42 manual COs linked. Batch B issued Aug 24: migration `2026-08-25_fishbowl_bridge_b.sql` + Order Queue CC prompt. Users/inventory pollers deferred to Batch C pending the `sysuser` / `qtyinventorytotals` column check.

---

## 1. Round Goal

Every Fishbowl sales order lands in SkyNet automatically — on creation and on every change — without anyone re-keying it. New orders appear in an **Order Queue** owned by Ashley (warehouse). Each line is dispositioned: ship from stock, purchase, ignore, or **production**, where it becomes a Customer Order line in Demand exactly as manually-entered COs do today. Changes made in Fishbowl after an order is in SkyNet propagate to the linked CO when safe and surface as exceptions when not.

This is the prerequisite for activating Assembly and Shipping (all orders must flow through SkyNet, not just produced ones) and for the Purchasing Forecast (purchased-component demand is visible per order for the first time).

---

## 2. Background

Customer Orders (v2.8, Sprint 5) mirror Fishbowl SOs by hand: CS types the Fishbowl SO number and re-enters lines. Programmatic sync (#31) was deferred from S1, then S2, then parked behind the QBO cutover freeze; the Kit Registry stayed export-based for the same reason (D-KSTC). With Assembly, Shipping, and Purchasing all depending on complete order flow, the interface is now on the critical path.

### 2.1 Discovery findings (Aug 24, 2026)

| Finding | Evidence | Consequence |
|---|---|---|
| Fishbowl Advanced 25.9 on‑prem at 192.168.1.251:2456, embedded Jetty serving the REST API. | `/api/login` 200, `/api/data-query` 200, `/api/logout` 200 from the spike. | Bridge polls the REST API; no MySQL port exposure. |
| `data-query` executes SQL against the Fishbowl MySQL DB and returns a JSON array of row objects, timestamps as ISO with server offset (`2026-08-24T11:53:35.812-04`). | Spike output. | One SQL round-trip per fetch; bridge parses JSON directly. |
| Hibernate Envers audit tables are populated and live: `revinfo` 384,669 revisions (`id`, `timestamp`, `modifiedUserId`), `soitem_aud` 1.74M rows, `so_aud` 154K rows, max REV timestamp matches `so.dateLastModified` to the second. | Statements E and F. | Exact, ordered change feed including removed lines. Poll `revinfo.id` instead of scanning timestamps. |
| One revision rewrites every line of the saved SO (REV 384669 touched all 4 lines of SO 11405). | Statement F. | Treat a revision as "SO X changed"; refetch all its lines and diff — never interpret `REVTYPE`. |
| Volume: 871 SOs / 7,744 lines in 90 days (~10 SOs/day, peak 31, ~9 lines each). Open set ≈ 27 Issued + 113 In Progress + 63 Estimates. 10,091 Fulfilled all-time. | Statement D. | Trivial load at a 20 s poll. Full history mirror is ~11K SOs / ~100K lines. |
| `so.customFields` / `soitem.customFields` are JSON columns. "Remaining Parts Ship Date" is `customfield` id 30 (Date) on the SO-item table; key present with no `value` when blank. | Statement A, C. | Extract `$."30".value` in SQL; NULL when blank. |
| Fishbowl defaults `dateScheduledFulfillment` to the creation *timestamp*; a user-entered date lands at 00:00:00. | Statement C/F (10:35:00.792 vs 00:00:00). | Flag "no real date entered" when the time-of-day is non-midnight. |
| Kits explode on the SO: a Kit line (type 80, no part) followed by component Sale lines — Skybolt parts, NAS/AN/MS hardware, `.DOC` and `Template-` pseudo-items. | SO 11572 (21 lines). | Disposition is per line. Kit headers link to `kit_skus`, never to a CO. |
| Part key: 10,374 products; 98.4% `productNum = partNum`, but 110 parts carry multiple products (`MS20426AD3-10` / `-10C`). | Product export. | Resolve via `product.partId → part.num`; keep `productNum` alongside. |
| SkyNet `parts` (1,174; 724 active) vs Fishbowl: **94.0% of SkyNet parts exist in Fishbowl** (assembly 96%, finished_good 99%, manufactured 91%, purchased 81%). The 53 unmatched active parts are internal components without a Fishbowl *product* (ZG26-xW1/W2, QL8 components) — they never appear on an SO line. | Match analysis. | Linking SO lines to SkyNet parts is reliable for everything SkyNet knows. |
| Reverse: **4,398 active Skybolt-prefixed (SK/ZG/QL) Fishbowl products are not in SkyNet** (SK26 591, SK4 418, SK4002 375, SK40 368, ZG26 238, ZG2600 213 …) — dash-number ranges, finish variants, stock-only items. | Match analysis. | SkyNet's part master is the routed/manufactured subset by design. Unresolved Skybolt-prefixed lines are the *normal* case, not an exception: they go to Ashley as `pending` for a stock-vs-production call; production requires Master Data to add the part first (existing flow). |
| Customer key: `so.customerId` = SkyNet `customers.customer_id` (1–6 digit text). Salesman is a Fishbowl username (`abraun`, `pmarshall`). | Statement B. | Customer resolves directly; salesperson resolves to `profiles.username` (case-insensitive) when present. |
| Lookups locked: SO status 10 Estimate / 20 Issued / 25 In Progress / 60 Fulfilled / 70 Closed Short / 80 Voided / 85 Cancelled / 90 Expired / 95 Historical. Line status 10–14 pre-pick, 20–40 picking, 50 Fulfilled, 60 Closed Short, 70 Voided, 75 Cancelled. Line type 10 Sale, 12 Drop Ship, 80 Kit; 11/20/21/30/31/40/50/60/70/90 non-product. Priority 10 Highest → 50 Lowest. | Statement A. | Hard-coded label maps in `lib/fishbowl.js`; ids stored raw. |

### 2.2 Existing SkyNet structures reused

- `customer_orders` / `customer_order_lines` / `customer_order_allocations` — unchanged. `co_number = CO-<customerId>-<fishbowlId>` via `formatCONumber`; `fishbowl_order_id` continues to hold the Fishbowl SO *number* (e.g. `18730`), so existing manual COs link by that key.
- `customers` (Fishbowl customer id + name), `parts`, `kit_skus`, `assembly_bom` (seeded from Fishbowl BOM staging at go-live).
- CO status triggers (`recalc_co_line_status`, `recalc_co_status`) and the cancellation flow (`handleCancelLine` in `CustomerOrders.jsx`, `has_cancelled_allocation` on WOs).
- Multi-role model (`hasRole`, `profiles.roles[]`), SECURITY DEFINER RPC pattern with `user_has_role()` gating and NULL-uid SQL-Editor passthrough (D-STKREQ precedent: SELECT-only RLS, all writes via RPC).

---

## 3. Where We Are at Round Open

### 3.1 Fishbowl side — done

- Fishbowl user **`skynet-bridge`** (hyphen) exists, currently in the Full Access group. Batch A step 1 moves it to a dedicated **SkyNet Bridge** user group with only Data (Data‑View) and Sales Order view rights.
- Integrated App **"SkyNet Bridge"** (appId 4350) registered and **Accepted** (Setup → Settings → Integrated Apps).
- No MFA on the service account. Login → data‑query → logout verified from Matt's PC on the LAN.
- The server does not ship the API docs; the public pages are stubs for Sales Orders. Everything this round needs is `/api/login`, `/api/logout`, `/api/data-query` (documented under Imports and Exports).

### 3.2 SkyNet side — nothing built yet

- No mirror tables, no `integration` role, no queue page. `fb-spike.mjs` lives in `G:\My Drive\Skybolt\SkyNet\Fishbowl Integration\` and is reference-only (not repo code).
- Spec v4.3; Decisions.md current through D-STKREQ / D-SCHED-18.

### 3.3 Prerequisites to confirm during Batch A

- Node.js ≥ 18 installed on the Fishbowl server (192.168.1.251) and outbound HTTPS to `*.supabase.co` allowed from it (Harry).
- Whether an open REST session counts against the 15 seats (Fishbowl → Setup → User, watch the licence count while the bridge runs). If it does, the bridge falls back to login/logout per cycle (already what the spike does).
- Column names of `qtyinventorytotals` and `sysuser` (one `SELECT * … LIMIT 3` each in the Data module). Both only affect bridge SQL, not the SkyNet schema.

---

## 4. Round Scope

### 4.1 In scope

- **Mirror schema** in Supabase: `fb_sales_orders`, `fb_sales_order_lines`, `fb_sync_events`, `fb_sync_state`, `fb_users`, `fb_part_inventory` + `v_fb_order_queue`.
- **Bridge service** (`tools/fishbowl-bridge/`, Node ≥ 18, Windows service on the Fishbowl server): revision tail every 20 s, reconciliation sweep every 15 min, inventory snapshot every 5 min for parts on open SOs, user list daily, heartbeat every cycle, one-shot backfill.
- **Ingest RPC** `fb_ingest_delta` — idempotent upsert by substantive-column fingerprint, removed-line detection by diff, change events, safe-field propagation to linked CO lines, exception events for unsafe changes.
- **Auto-resolution** of each line (part / kit / unlisted-Skybolt / unlisted / n-a) and **auto-disposition** where no human call is needed (non-product types → `ignore`, purchased parts → `purchased`, kit headers → `kit_header`, non-Skybolt unlisted → `unlisted`).
- **Order Queue page** (Ashley): open Issued/In Progress SOs, per-line disposition with bulk actions, **Create CO** from selected production lines (RPC), exceptions tab, recent-changes tab, sync-freshness banner.
- **Linkage backfill** of the COs created manually before the bridge, by `fishbowl_order_id = so.num`, with a report of anything ambiguous.
- **Estimates are never ingested.** Only Issued (20) and In Progress (25) SOs enter SkyNet; once mirrored, an SO is followed through Fulfilled / Closed Short / Voided / Cancelled so linked COs see the outcome.
- **Customer Orders page tie-in**: FB chip on CO rows with a mirror match; Fishbowl status shown in the expanded row.
- New primary role value **`integration`** for the bridge's Supabase identity (`fishbowl-bridge@skybolt.com`), and a new **additional** role **`order_processor`** that gates disposition and Create CO (Ashley). roles.js, UsersTab ROLE_OPTIONS, App.jsx guard updates.
- Three informational columns on `customer_order_lines` — `fb_qty_ordered`, `fb_qty_fulfilled`, `fb_qty_to_fulfill` (numeric, kept live by ingest) — so a Fishbowl-sourced CO line shows Ordered / Shipped-in-Fishbowl / To-fulfill side by side (D-FB-12).
- Spec bump to **v4.4**; Decisions.md entries D-FB-01…; cheat-sheet additions for bridge operations.

### 4.2 Out of scope (deferred, in the order they should follow)

- **Auto stock-vs-production** disposition rules using the inventory snapshot — v1 shows available qty next to the line; Ashley decides. Rules come once her calls are observable in `fb_sync_events`/dispositions.
- **Purchasing Forecast** — BOM mirror (`bom`/`bomitem`) + PO mirror (`po`/`poitem`) + explosion of open-SO demand. Next round; the mirror tables here are its input.
- **Writing back to Fishbowl** (fulfillment, shipping, MO creation). Shipping module round.
- **Replacing the export-based Kit Registry loaders** (`kit_sales`, `fishbowl_invoices`) with the bridge. Cheap follow-on once the mirror is proven.
- **Part stub creation from the queue.** v1 flags "not in SkyNet" and deep-links to Armory → Parts; Master Data adds the part with routing as today.
- **Auto-cancel CO lines on Fishbowl void/cancel.** v1 raises an exception with a deep link to the existing cancel flow (audit + WO flag semantics preserved).
- **Sales dashboard re-pointing** to the mirror instead of weekly reconciliation exports.
- Estimates (any use of them in SkyNet), SO-level attachments, drop-ship handling beyond a `purchased` disposition.

---

## 5. Decisions Locked (Matt sign-off Aug 24, 2026)

| ID | Topic | Decision |
|---|---|---|
| D-FB-01 | Transport | On-prem Node bridge on the Fishbowl server polls the Fishbowl REST API (`data-query`) and pushes to Supabase over outbound HTTPS. Supabase never reaches into the plant. Fishbowl is read-only for this round. |
| D-FB-02 | Change detection | Primary: tail `revinfo.id` (cursor `fb_sync_state.last_rev`), affected SOs = `soitem_aud ∪ so_aud` for the revision window, refetch full current state of each affected SO. Safety net: 15-min reconciliation sweep of open SOs by `dateLastModified` + fingerprint. A 200-revision overlap is re-read every cycle (idempotent) to cover out-of-order commits. |
| D-FB-03 | Latency target | ≤ 30 s from Fishbowl save to SkyNet row (20 s poll). "Real-time" without CDC on the MySQL binlog, which touches the Fishbowl DB config and is unsupported by Fishbowl. |
| D-FB-04 | Change semantics | Fingerprint = md5 of substantive Fishbowl columns, excluding `dateLastModified`. A Fishbowl re-save with no content change bumps `last_synced_at`/`last_rev` only — no event. |
| D-FB-05 | Removed lines / removed SOs | A line missing from a refetched SO gets `removed_at`; an SO missing from Fishbowl (rare — Estimates) gets `removed_at`. Rows are never deleted (traceability). |
| D-FB-06 | Ownership split | Fishbowl-owned columns are written only by `fb_ingest_delta`. SkyNet-owned columns (`part_id`, `kit_sku_id`, `resolution`, `disposition*`, `customer_order_line_id`, `customer_order_id`) are never touched by ingest except resolution/disposition on first sight of a line. |
| D-FB-07 | Bridge identity | Supabase Auth user **`fishbowl-bridge@skybolt.com`** (full name "Fishbowl Bridge", username auto-derives to `fishbowl-bridge`, mirroring the Fishbowl account name) with primary role `integration` (new CHECK value), signing in with email/password over the anon key. RPCs gate on `integration`/`admin`/NULL uid. **No service-role key on the plant box.** |
| D-FB-08 | Part resolution | `parts.part_number` = Fishbowl `part.num` (via `product.partId`), case-insensitive, trimmed; fallback `productNum`. Kit (type 80) → `kit_skus.sku`. Unresolved Skybolt-prefixed (`SK`, `ZG`, `QL`) → `unlisted_skybolt`; other unresolved → `unlisted`. |
| D-FB-09 | Auto-disposition on first sight | Non-product types → `ignore`. Kit header → `kit_header`. Resolved `purchased` part → `purchased`. Unresolved non-Skybolt → `unlisted`. Everything else → `pending` (Ashley decides). Re-sync never overrides a human disposition. |
| D-FB-10 | Due date | `effective_due_date = COALESCE(Remaining Parts Ship Date, dateScheduledFulfillment::date in America/New_York)`; `due_date_is_default = true` when `dateScheduledFulfillment` has a non-midnight time and no Remaining Parts Ship Date. |
| D-FB-11 | What enters SkyNet | **Estimates are not ingested at all.** The bridge's affected-SO query excludes `statusId = 10` and the RPC skips unseen Estimates (an already-mirrored SO that somehow reverts to 10 is kept for traceability but drops out of the queue). Issued (20) and In Progress (25) are the queue; 60/70 close the SO; 80/85/90 mark it dead and raise exceptions for any linked CO lines. |
| D-FB-12 | Convert to CO + quantities | `fb_convert_to_co(fb_so_id, line_ids[])`: find-or-create the CO for the SO (`fishbowl_order_id = so.num`, customer by `customerId` — created from the Fishbowl name if missing, `po_number = customerPO`, `salesperson_id` by username, `created_by = auth.uid()`), append one CO line per selected line, `due_date = effective_due_date`, priority mapped 10→critical, 20→high, 30→normal, 40/50→low. **Quantities:** `customer_order_lines.quantity_ordered` keeps its meaning — what SkyNet must produce — and is set to Fishbowl `qtyToFulfill` at conversion; the informational columns `fb_qty_ordered`, `fb_qty_fulfilled`, `fb_qty_to_fulfill` carry Fishbowl's live ordered / already-shipped / remaining quantities so the CO row reads *Ordered 1,000 · Shipped (FB) 400 · To fulfill 600*. Demand math (`getEffectiveQty`, allocations) is untouched. Idempotent per line. Requires a resolved `part_id`. |
| D-FB-13 | Who may act | New **additional** role `order_processor` (in `profiles.roles[]`, which is intentionally unconstrained per D-MROLE-02; added to UsersTab `ROLE_OPTIONS`). Disposition, Create CO, and exception ack: `order_processor` or `admin`. Ashley = `assembly` + `order_processor`. Page read (full visibility, no write controls): `admin, assembly, customer_service, scheduler, president, viewer, order_processor` + `is_salesperson`. |
| D-FB-14 | Safe propagation to linked CO lines | Auto-apply with an event: a **`qtyOrdered`** change (the customer changed the order) — Δ added to `quantity_ordered`; a decrease only if the new value ≥ active allocations + `quantity_fulfilled`, otherwise an exception; due-date change; `customerPO` change. Fishbowl **fulfillment** movements (`qtyFulfilled` / `qtyToFulfill`) are never propagated into `quantity_ordered`: SkyNet posts its own fulfillment when production is allocated, so mirroring Fishbowl's shipment of the same pieces would double-count. The three `fb_qty_*` columns always refresh (informational). Everything else is an exception (`requires_ack`). |
| D-FB-15 | Unsafe changes | Line removed, line status 70/75, SO status 80/85/90, or qty decrease below allocations → `fb_sync_events.requires_ack = true`, shown in the Exceptions tab with a deep link to the CO in Customer Orders. No automatic cancel in v1. |
| D-FB-16 | Fulfilled in Fishbowl | Line status 50 / SO status 60 → informational event and a "Shipped in Fishbowl" chip on the linked CO line. CO completion stays with SkyNet's fulfillment/shipping flow. |
| D-FB-17 | Backfill horizon | **Open orders only** — `statusId IN (20, 25)` at backfill time (~140 SOs, ~1,300 lines) — for queue visibility and forecasting. History is not mirrored; fulfilled orders accumulate naturally from go-live. A history backfill can be added later for the sales dashboard. |
| D-FB-18 | RLS | Mirror tables: SELECT for `authenticated`, no direct write policies; all writes via SECURITY DEFINER RPCs (D-STKREQ precedent). `anon` revoked on every RPC. |
| D-FB-19 | Bridge code location | `tools/fishbowl-bridge/` in the `skynet` repo with its own `package.json`; outside the Vite build; `.env` git-ignored. TEST and PROD bridges are the same code with different env. |
| D-FB-20 | Inventory snapshot | `fb_part_inventory` refreshed every 5 min for parts on open SO lines (~a few hundred rows), full refresh nightly. Displayed as an "avail" chip; not used for automation in v1. |

---

## 6. Architecture

```
Fishbowl server 192.168.1.251                         Supabase (TEST → PROD)
┌───────────────────────────────┐                     ┌──────────────────────────────┐
│ Fishbowl Advanced 25.9        │                     │ fb_ingest_delta(jsonb)  RPC  │
│  Jetty :2456  /api/data-query │ ◄── SQL (read) ──┐  │ fb_heartbeat / fb_upsert_*   │
│  MySQL: so, soitem, revinfo,  │                  │  │                              │
│  so_aud, soitem_aud, product, │                  │  │ fb_sales_orders              │
│  part, customer, sysuser,     │                  │  │ fb_sales_order_lines         │
│  qtyinventorytotals           │                  │  │ fb_sync_events               │
└───────────────────────────────┘                  │  │ fb_sync_state  fb_users      │
                                                   │  │ fb_part_inventory            │
┌───────────────────────────────┐                  │  │        │                     │
│ SkyNet Fishbowl Bridge        │ ─────────────────┘  │        ▼                     │
│  Windows service (NSSM)       │ ── HTTPS (JWT) ───► │ Order Queue page (Ashley)    │
│  node tools/fishbowl-bridge   │                     │  disposition · Create CO     │
│  tail 20 s · reconcile 15 m   │                     │        │                     │
│  inventory 5 m · users daily  │                     │        ▼                     │
└───────────────────────────────┘                     │ customer_orders → Demand → WO│
                                                      └──────────────────────────────┘
```

### 6.1 Bridge cycle (every 20 s)

1. `SELECT MAX(id) AS max_rev FROM revinfo` → if `max_rev <= last_rev` → heartbeat, sleep.
2. `from = GREATEST(last_rev - 200, 0)`; affected SO ids:
   `SELECT DISTINCT a.id FROM (SELECT soId AS id FROM soitem_aud WHERE REV > :from AND REV <= :max_rev UNION SELECT id FROM so_aud WHERE REV > :from AND REV <= :max_rev) a JOIN so s ON s.id = a.id WHERE s.statusId <> 10` — Estimates never leave Fishbowl (D-FB-11).
3. For the affected ids (chunks of 50): headers (`so ⋈ customer`) and lines (`soitem ⟕ product ⟕ part`) with custom field 30 extracted in SQL.
4. `fb_ingest_delta({source:'tail', rev_from, rev_to, orders:[{header, lines, complete:true}]})`.
5. On success the RPC advances `fb_sync_state.last_rev = rev_to`; the bridge mirrors it in memory. On failure the bridge retries with backoff and does **not** advance — at-least-once delivery, idempotent by fingerprint.

### 6.2 Reconciliation (every 15 min)

`SELECT id, statusId, dateLastModified FROM so WHERE statusId IN (20,25)` compared against the mirror's open set; any mismatch (timestamp newer than `fb_date_last_modified`, status differs, or an open mirror SO missing from the result) is refetched through the same ingest path with `source:'reconcile'`.

### 6.3 Backfill (one shot, `scripts/backfill.mjs`)

`SELECT id FROM so WHERE statusId IN (20,25) ORDER BY id` → pages of 50 SOs → ingest with `source:'backfill'` (no events emitted, dispositions assigned) → `fb_link_existing_cos()` → report.

### 6.4 Fishbowl session handling

Hold one session; re-login on 401; logout on shutdown. If the seat check (§3.3) shows the session consumes a licence, switch `SESSION_MODE=per_cycle`. All calls use `node:http` (GET with a body is rejected by `fetch`). Timestamps arrive as `…-04`; the mapper normalises the offset to `-04:00` before parsing.

---

## 7. Schema Migration — `Docs/migrations/2026-08-25_fishbowl_bridge_a.sql`

Apply to TEST first. Idempotent. RPC bodies ship in the Batch A migration block; the DDL below is the contract.

### 7.1 Role value

```sql
-- The existing CHECK is dropped dynamically (found by definition, not by name — the D-JOBMERGE pattern), then re-added:
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role::text = ANY (ARRAY[
  'admin','compliance','machinist','assembly','display','scheduler','customer_service',
  'finishing','president','viewer','purchaser','integration']));
```

### 7.2 `customer_order_lines` additions (D-FB-12)

```sql
ALTER TABLE public.customer_order_lines
  ADD COLUMN IF NOT EXISTS fb_qty_ordered numeric,
  ADD COLUMN IF NOT EXISTS fb_qty_fulfilled numeric,
  ADD COLUMN IF NOT EXISTS fb_qty_to_fulfill numeric;
```

`order_processor` needs no DDL: `profiles.roles[]` is unconstrained (D-MROLE-02).

### 7.3 Mirror tables

```sql
CREATE TABLE IF NOT EXISTS public.fb_sync_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_rev bigint NOT NULL DEFAULT 0,
  last_rev_at timestamptz,
  last_heartbeat_at timestamptz,
  last_backfill_at timestamptz,
  last_reconcile_at timestamptz,
  last_inventory_at timestamptz,
  bridge_version text,
  bridge_host text,
  last_error text,
  last_error_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.fb_sync_state (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.fb_users (
  fb_user_id integer PRIMARY KEY,
  username text NOT NULL,
  full_name text,
  is_active boolean NOT NULL DEFAULT true,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fb_sales_orders (
  fb_so_id integer PRIMARY KEY,
  so_number text NOT NULL,
  fb_customer_id integer NOT NULL,
  customer_name text,
  customer_po text,
  status_id smallint NOT NULL,
  priority_id smallint,
  type_id smallint,
  location_group_id smallint,
  salesman text,
  salesman_id integer,
  created_by_username text,
  fb_date_created timestamptz,
  fb_date_issued timestamptz,
  fb_date_completed timestamptz,
  fb_date_last_modified timestamptz,
  note text,
  ship_to_name text,
  custom_fields jsonb,
  raw jsonb NOT NULL,
  fingerprint text NOT NULL,
  last_rev bigint,
  first_synced_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  -- SkyNet-owned
  customer_id uuid REFERENCES public.customers(id),
  customer_order_id uuid REFERENCES public.customer_orders(id)
);
CREATE INDEX IF NOT EXISTS idx_fbso_number ON public.fb_sales_orders(so_number);
CREATE INDEX IF NOT EXISTS idx_fbso_open ON public.fb_sales_orders(status_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fbso_co ON public.fb_sales_orders(customer_order_id);

CREATE TABLE IF NOT EXISTS public.fb_sales_order_lines (
  fb_soitem_id integer PRIMARY KEY,
  fb_so_id integer NOT NULL REFERENCES public.fb_sales_orders(fb_so_id),
  line_number integer NOT NULL,
  type_id smallint NOT NULL,
  status_id smallint NOT NULL,
  product_num text NOT NULL,
  part_num text,
  fb_product_id integer,
  fb_part_id integer,
  fb_part_type_id smallint,
  description text,
  qty_ordered numeric NOT NULL,
  qty_fulfilled numeric NOT NULL DEFAULT 0,
  qty_picked numeric,
  qty_to_fulfill numeric,
  uom_id integer,
  unit_price numeric,
  total_price numeric,
  date_scheduled_fulfillment timestamptz,
  remaining_parts_ship_date date,
  effective_due_date date,
  due_date_is_default boolean NOT NULL DEFAULT false,
  rev_level text,
  customer_part_num text,
  note text,
  custom_fields jsonb,
  raw jsonb NOT NULL,
  fingerprint text NOT NULL,
  last_rev bigint,
  first_synced_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  -- SkyNet-owned
  part_id uuid REFERENCES public.parts(id),
  kit_sku_id uuid REFERENCES public.kit_skus(id),
  resolution text CHECK (resolution IN ('part','kit','unlisted_skybolt','unlisted','n_a')),
  disposition text NOT NULL DEFAULT 'pending'
    CHECK (disposition IN ('pending','production','stock','purchased','kit_header','ignore','unlisted')),
  disposition_by uuid REFERENCES public.profiles(id),
  disposition_at timestamptz,
  disposition_note text,
  customer_order_line_id uuid REFERENCES public.customer_order_lines(id)
);
CREATE INDEX IF NOT EXISTS idx_fbsol_so ON public.fb_sales_order_lines(fb_so_id);
CREATE INDEX IF NOT EXISTS idx_fbsol_part ON public.fb_sales_order_lines(part_id);
CREATE INDEX IF NOT EXISTS idx_fbsol_pending ON public.fb_sales_order_lines(disposition) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fbsol_col ON public.fb_sales_order_lines(customer_order_line_id);

CREATE TABLE IF NOT EXISTS public.fb_sync_events (
  id bigserial PRIMARY KEY,
  fb_so_id integer NOT NULL,
  fb_soitem_id integer,
  event_type text NOT NULL CHECK (event_type IN (
    'so_created','so_changed','so_status_changed','so_removed',
    'line_added','line_changed','line_status_changed','line_removed')),
  changes jsonb,                       -- {"qty_ordered": {"old": 800, "new": 1000}, ...}
  fb_rev bigint,
  fb_modified_user_id integer,
  fb_username text,
  fb_timestamp timestamptz,
  affects_co boolean NOT NULL DEFAULT false,
  requires_ack boolean NOT NULL DEFAULT false,
  acknowledged_by uuid REFERENCES public.profiles(id),
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fbev_so ON public.fb_sync_events(fb_so_id);
CREATE INDEX IF NOT EXISTS idx_fbev_open ON public.fb_sync_events(requires_ack) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fbev_created ON public.fb_sync_events(created_at DESC);

CREATE TABLE IF NOT EXISTS public.fb_part_inventory (
  part_num text PRIMARY KEY,
  fb_part_id integer,
  qty_on_hand numeric,
  qty_allocated numeric,
  qty_available numeric,
  qty_on_order numeric,
  snapshot_at timestamptz NOT NULL DEFAULT now()
);
```

### 7.4 RLS

Enable RLS on all six tables; one `SELECT` policy for `authenticated` each; no INSERT/UPDATE/DELETE policies (writes are RPC-mediated). Add the six tables to the pg_policies audit allow-list the same way `stock_requests` was.

### 7.5 RPC contracts (SECURITY DEFINER, `anon`/`PUBLIC` revoked)

| RPC | Gate | Behaviour |
|---|---|---|
| `fb_ingest_delta(p_payload jsonb) RETURNS jsonb` | `integration`, `admin`, NULL uid | Per order: upsert header (Fishbowl columns only); resolve `customer_id`; per line: resolve part/kit → set `resolution`, and `disposition` **only when the row is new**; compute `effective_due_date`/`due_date_is_default`; upsert; lines absent from the payload → `removed_at = now()`. Emit events only when fingerprints differ (never for `source = 'backfill'`). Propagate safe changes to linked CO lines (D-FB-14); raise `requires_ack` events for unsafe ones (D-FB-15). Advance `fb_sync_state.last_rev` when `source = 'tail'`. Returns counts. |
| `fb_heartbeat(p_state jsonb) RETURNS void` | same | Updates `fb_sync_state` heartbeat/version/host/last_error. |
| `fb_get_cursor() RETURNS bigint`, `fb_set_cursor(p_rev bigint) RETURNS jsonb` | same | Cursor read; forward-only cursor set (backfill uses it after loading). |
| `fb_upsert_users(p_rows jsonb)`, `fb_upsert_inventory(p_rows jsonb)` | same | Plain upserts — **Batch C**, after the `sysuser` / `qtyinventorytotals` column check. |
| `_fb_gate(p_roles text[]) RETURNS void` | — | NULL-uid passthrough, else `user_has_role(uid, VARIADIC p_roles)`, raises `42501`. Called by every `fb_*` RPC. |
| `fb_set_disposition(p_line_ids integer[], p_disposition text, p_note text) RETURNS integer` | `order_processor`, `admin` | Bulk set; refuses `production` (that path is `fb_convert_to_co`) and refuses lines already linked to a CO line. |
| `fb_convert_to_co(p_fb_so_id integer, p_line_ids integer[]) RETURNS jsonb` | `order_processor`, `admin` | D-FB-12. Returns `{customer_order_id, co_number, lines_created, skipped[]}`. |
| `fb_ack_event(p_event_id bigint) RETURNS void` | `order_processor`, `admin` | Marks acknowledged. |
| `fb_link_existing_cos() RETURNS jsonb` | `admin`, NULL uid | One-shot: for each `customer_orders.fishbowl_order_id` matching a mirror `so_number`, set `customer_order_id`; link CO lines to mirror lines by `part_id` (ties broken by line order); returns `{linked_orders, linked_lines, ambiguous[], unmatched[]}`. |

### 7.6 View

`v_fb_order_queue` — one row per non-removed SO (the page filters status 20/25): header columns + `pending_lines`, `production_lines`, `stock_lines`, `purchased_lines`, `unlisted_lines`, `ignored_lines`, `earliest_due`, `has_default_dates`, `open_exceptions`, `linked_co_number`.

### 7.7 Critical names (do not guess)

- Fishbowl: `so.num`, `so.customerId`, `so.customerPO`, `so.statusId`, `so.priorityId`, `so.salesman`, `so.username`, `soitem.soLineItem`, `soitem.qtyOrdered`, `soitem.qtyFulfilled`, `soitem.qtyToFulfill`, `soitem.dateScheduledFulfillment`, `soitem.customFields ->> '$."30".value'`, `product.partId`, `part.num`, `part.typeId`, `revinfo.id/timestamp/modifiedUserId`, `soitem_aud.REV/soId`, `so_aud.REV/id`.
- SkyNet: `customers.customer_id` (text), `customer_orders.fishbowl_order_id`, `customer_order_lines.quantity_ordered / quantity_fulfilled / due_date / priority / line_number / fb_qty_ordered / fb_qty_fulfilled / fb_qty_to_fulfill`, `parts.part_number / part_type`, `kit_skus.part_number` (the kit SKU key — not `sku`), `profiles.username / roles`, `user_has_role(uid, VARIADIC roles)`.

---

## 8. Bridge Service — `tools/fishbowl-bridge/`

| File | Purpose |
|---|---|
| `package.json` | `"type": "module"`, `engines.node >= 18`, deps: `@supabase/supabase-js`. Scripts: `start`, `backfill`, `once`. |
| `src/index.mjs` | Main loop: tail (20 s), reconcile (15 min), heartbeat each cycle; `--once` smoke mode; graceful SIGINT/SIGTERM; log lines to console + `logs/bridge-YYYY-MM-DD.log`. Inventory (5 min) and users (daily) pollers land in Batch C. |
| `src/fishbowl.mjs` | `login/logout/dataQuery` over `node:http`; session reuse; re-login on 401; retry with backoff; `SESSION_MODE = hold | per_cycle`. |
| `src/queries.mjs` | The SQL templates from §6 (`maxRev`, `soRevs` with the Estimate filter, `revInfo`, `headers`, `lines`, `openSos`, `statusOf`). Custom field 30 extracted in SQL: `JSON_UNQUOTE(JSON_EXTRACT(i.customFields, '$."30".value')) AS remainingPartsShipDate`. |
| `src/sync.mjs` | Shared fetch-and-ingest: refetch full SOs by id in chunks; only the last chunk of a revision window carries `rev_to`, so the cursor can never pass un-ingested work; hard-deleted SO ids go up as `removed_ids`. `revisionMap()` attaches `revinfo` who/when per SO. |
| `src/mapper.mjs` | Row → payload shape; offset normalisation (`-04` → `-04:00`); numeric coercion of Fishbowl decimals (`0E-9` → 0). |
| `src/skynet.mjs` | Supabase client (anon key + bridge email/password); `rpc()` wrapper with retry; token refresh handled by supabase-js. |
| `src/config.mjs` | Reads `tools/fishbowl-bridge/.env` (real env vars win). Keys: `FB_HOST FB_PORT FB_USER FB_PASS FB_APP_ID FB_TIMEOUT_MS SESSION_MODE SB_URL SB_ANON_KEY SB_BRIDGE_EMAIL SB_BRIDGE_PASSWORD POLL_MS RECONCILE_MS OVERLAP_REVS CHUNK`. |
| `scripts/backfill.mjs` | One-shot backfill (§6.3) then `fb_link_existing_cos()`; prints the linkage report. |
| `scripts/install-service.ps1` | NSSM: `nssm install SkyNetFishbowlBridge "<node>" "src\index.mjs"`, `AppDirectory`, stdout/stderr to `logs\`, rotation, `Start=SERVICE_AUTO_START`, restart on failure. Credentials come from `.env` via `config.mjs` — nothing in the service definition. |
| `.env.example`, `README.md` | Setup, env, service ops (start/stop/restart, where logs are, how to re-run backfill, how to reset the cursor). |

Deployment to the server is a `git clone` of the repo (or a copied `tools/fishbowl-bridge` folder) under `D:\SkyNetBridge\`; `.env` is created by hand on the server and never committed. During the build, the bridge runs from Matt's PC against TEST; the PROD service on the Fishbowl server comes in Batch D.

---

## 9. Code Changes

### 9.1 New files

| File | Change |
|---|---|
| `src/lib/fishbowl.js` | Label/colour maps (`FB_SO_STATUS`, `FB_LINE_STATUS`, `FB_LINE_TYPE`, `FB_PRIORITY`, `DISPOSITION_LABELS/COLORS`), queries (`getQueueOrders`, `getQueueLines`, `getOpenExceptions`, `getRecentEvents`, `getSyncState`), RPC wrappers (`setDisposition`, `convertToCO`, `ackEvent`), `syncFreshness(state)`. Centralises everything; nothing computed inline in pages. |
| `src/pages/OrderQueue.jsx` | Tabs: **Queue** (open SOs with any `pending` line) · **All Open** · **Exceptions** · **Recent Changes**. Filters: customer, part/product, salesman. Action controls render only for `admin` / `order_processor`. |
| `src/components/orderqueue/SOCard.jsx` | Header (SO #, customer, PO, status, priority, earliest due, linked CO chip), lines table, bulk-select footer (Mark Stock / Mark Purchased / Ignore / **Create CO**). |
| `src/components/orderqueue/LineRow.jsx` | Line #, type chip, product/part with resolution badge (green resolved · amber "not in SkyNet" · grey hardware), qty ordered/fulfilled/to-fulfill, due (+ "default date" flag), avail chip (`fb_part_inventory`), disposition chip. |
| `src/components/orderqueue/ConvertToCOModal.jsx` | Confirms the selected lines, shows the CO number that will be created or appended to, calls `fb_convert_to_co`, toasts with a link to Customer Orders. |
| `src/components/orderqueue/SyncStatusBanner.jsx` | "Fishbowl sync ● 14 s ago" — amber > 2 min, red > 10 min, includes `last_error`. Reused on Customer Orders. |

### 9.2 Updated files

| File | Change |
|---|---|
| `src/lib/roles.js` | `canAccessOrderQueue(profile)` (read set per D-FB-13), `canActOnOrderQueue(profile)` = `hasRole(profile, 'admin', 'order_processor')`; `integration` documented as a non-UI role. |
| `src/pages/UsersTab.jsx` | `ROLE_OPTIONS` gains `{ value: 'order_processor', label: 'Order Processor (queue → CO)' }` so it can be assigned as an additional role. |
| `src/App.jsx` | `currentPage === 'order_queue'` guard + nav entry (Mainframe nav, next to Customer Orders); redirect for `integration` role to a "service account" notice. |
| `src/pages/CustomerOrders.jsx` | FB chip on CO rows with a mirror match; expanded row shows Fishbowl status, and on each Fishbowl-sourced line *Ordered / Shipped (FB) / To fulfill* from `fb_qty_ordered` / `fb_qty_fulfilled` / `quantity_ordered`; "Shipped in Fishbowl" chip at line status 50; `SyncStatusBanner` at the top. Read-only additions. |
| `src/components/CreateCustomerOrderModal.jsx` | When the typed Fishbowl Order ID matches a mirror row, show "This SO is in the Order Queue — open it" (link). No behaviour change. |
| `Docs/Decisions.md` | D-FB-01 … appended by CC at the end of each batch. |

---

## 10. Claude Code Prompt Batches

Every prompt opens with `BEFORE STARTING: Read Docs/Decisions.md and Docs/FB1_Implementation_Plan.md in full`. SQL migrations ship as separate blocks for the Supabase SQL Editor (TEST). Anchors verified against uploaded files before each prompt ships.

### 10.1 Batch A — Schema, ingest RPC, bridge, backfill (≈ 2 days)

0. Preflight (Supabase, read-only): `user_has_role` signature, profiles CHECK constraint name, `server_version` ≥ 15. Fishbowl: user-group tightening (Data + Sales Order view); seat check while the bridge runs.
1. Migration `Docs/migrations/2026-08-25_fishbowl_bridge_a.sql` (shipped Aug 24): §7.1–7.4 + `_fb_gate`, `fb_get_cursor`, `fb_set_cursor`, `fb_heartbeat`, `fb_ingest_delta` (incl. D-FB-14/15 propagation), `fb_link_existing_cos`, `v_fb_order_queue`.
2. Supabase Auth user `fishbowl-bridge@skybolt.com` on TEST (Dashboard → Authentication → Add user, auto-confirm), then the profile upsert block (role `integration`, full name "Fishbowl Bridge").
3. CC prompt (shipped Aug 24): `tools/fishbowl-bridge/` entire files (§8) + `.gitignore` lines + Decisions.md entry.
4. Run `npm run backfill` from Matt's PC against TEST; parity check (`count(*) || md5(string_agg(fb_so_id::text, ',' ORDER BY fb_so_id))` vs the same over Fishbowl's open ids); linkage report; resolution breakdown (`SELECT resolution, disposition, count(*)` over open lines).
5. `npm run once`, then `npm start`; live test: edit an SO in Fishbowl → mirror row within 30 s; remove a line → `removed_at`; issue an Estimate → appears; void an Issued SO → status + event.

### 10.2 Batch B — Order Queue page (≈ 1.5 days)

1. Migration `Docs/migrations/2026-08-25_fishbowl_bridge_b.sql` (shipped Aug 24): `covered` disposition, `fb_set_disposition`, `fb_convert_to_co`, `fb_ack_event`, `fb_reresolve_lines`, `fb_link_existing_cos` v2 (due-date tie-break), `v_fb_order_queue` v2 (`covered_lines`, `actionable_lines`, `suspect_dates`).
2. CC prompt (shipped Aug 24): `lib/fishbowl.js`, `pages/OrderQueue.jsx`, `components/orderqueue/{SOCard,ConvertToCOModal,SyncStatusBanner}.jsx` (LineRow folded into SOCard), `roles.js` (`canAccessOrderQueue`, `canActOnOrderQueue`), `App.jsx` nav + guard + mount, `UsersTab.jsx` additional-only `order_processor`, `CustomerOrders.jsx` `coSearch` deep link, bridge `.env` hardening + README path, Decisions D-FB-21…25.
3. Quick test: admin and Ashley (assembly + order_processor) → queue renders, banner green → bulk Ship from stock / Back to pending → Create CO from two resolved lines → CO in Customer Orders (Orders tab pre-searched) and Demand → same lines no longer selectable → customer_service sees everything with no controls → Fishbowl qty edit on a converted line updates the CO line (T-16).

### 10.3 Batch C — Change propagation, exceptions, CO tie-in (≈ 1 day)

1. Migration block: `fb_upsert_users`, `fb_upsert_inventory` (after the `sysuser` / `qtyinventorytotals` column check: `SELECT * FROM sysuser LIMIT 3`, `SELECT * FROM qtyinventorytotals LIMIT 3` in the Data module).
2. CC prompt: users (daily) + inventory (5 min, parts on open SO lines) pollers in the bridge; Exceptions + Recent Changes tabs; `CustomerOrders.jsx` chips + banner; `CreateCustomerOrderModal.jsx` hint.
3. Tests: qty up / qty down within allocations / due date / PO → CO line updated + event; qty below allocations / line removed / void → exception with deep link; ack clears it.

### 10.4 Batch D — PROD cutover (≈ 0.5–1 day, after TEST sign-off)

1. Migration to PROD (same file). Bridge auth user on PROD. `integration` role value on PROD.
2. Node.js + NSSM service on the Fishbowl server (Harry); `.env` for PROD; start service; heartbeat visible in PROD.
3. Backfill PROD; linkage report reviewed with April; resolution breakdown reviewed with Ashley.
4. Code merge `feature/fishbowl-bridge` → `test` → `main`; Amplify deploy; 2-day monitoring; Decisions.md, spec v4.4, cheat sheet.

Sequence: A → B → C on TEST with ✅ between batches; D only after end-to-end sign-off. Estimated 5–5.5 dev days ≈ 3 calendar weeks at 12–16 h/week.

---

## 11. Test Checklist

| ID | Test Case |
|---|---|
| T-01 | Migration runs cleanly on TEST; `profiles_role_check` accepts `integration`; pg_policies audit shows SELECT on all six tables and nothing else. |
| T-02 | Bridge login as `skynet-bridge` with the tightened user group still succeeds; `data-query` on `so` succeeds; a write attempt (`UPDATE`) fails. |
| T-03 | Backfill completes; SO and line counts match Fishbowl for the horizon; parity fingerprints equal. |
| T-04 | `fb_link_existing_cos()` links every manual CO whose `fishbowl_order_id` matches; ambiguous/unmatched list reviewed. |
| T-05 | New SO **issued** in Fishbowl → mirror row + `so_created` event within 30 s; lines carry `resolution`/`disposition` per D-FB-08/09. A new **Estimate** produces no mirror row; issuing it later does. |
| T-06 | Line qty edited in Fishbowl → `line_changed` event with `{qty_ordered:{old,new}}`; fingerprint changes; a no-op re-save produces no event. |
| T-07 | Line deleted in Fishbowl → `removed_at` set, `line_removed` event. |
| T-08 | Remaining Parts Ship Date set on a line → `effective_due_date` follows it; cleared → falls back to `dateScheduledFulfillment`; `due_date_is_default` correct in both cases. |
| T-09 | Reconciliation catches an SO modified while the bridge was stopped (stop service, edit, start, wait ≤ 15 min). |
| T-10 | Heartbeat banner: green while running, amber after 2 min stopped, red after 10 min. |
| T-11 | Queue page: Ashley (assembly + order_processor) sees open Issued/In Progress SOs with action buttons; `customer_service` and `viewer` see everything but no action buttons; `machinist` cannot open the page. |
| T-12 | Bulk Mark Stock / Purchased / Ignore updates lines; re-sync of the SO does not override them. |
| T-13 | Create CO from two production lines → CO header per D-FB-12, two CO lines with `quantity_ordered = qtyToFulfill`, `fb_qty_ordered` / `fb_qty_fulfilled` / `fb_qty_to_fulfill` populated, `customer_order_line_id` set, lines show in Demand grouped by part. |
| T-14 | Create CO on an SO that already has a manual CO → lines appended to the existing CO, no duplicate header. |
| T-15 | Create CO on a line with `resolution = unlisted_skybolt` → refused with "part not in SkyNet"; deep link to Armory Parts. |
| T-16 | Qty increase in Fishbowl on a converted line → CO line `quantity_ordered` increased, event `affects_co`. |
| T-17 | Qty decrease below active allocations → CO line unchanged, `requires_ack` exception; ack clears it. |
| T-18 | SO voided in Fishbowl with a converted line → exception with deep link; cancelling the CO line through Customer Orders works as before (WO flagged). |
| T-19 | Customer Orders page shows FB chip and Fishbowl status; "Shipped in Fishbowl" chip appears when the Fishbowl line reaches status 50. |
| T-20 | Kit SO (e.g. SK203C150P4): kit header `kit_header` with `kit_sku_id`, components dispositioned individually, no CO offered for the header. |
| T-21 | Inventory chip shows for parts on open SOs and refreshes within 5 min of a Fishbowl adjustment. |
| T-22 | Bridge survives Fishbowl restart (re-login) and Supabase outage (retries, cursor not advanced, no duplicate events after recovery). |

---

## 12. Risks & Open Items

| # | Risk | Mitigation |
|---|---|---|
| R-01 | Envers does not cover some Fishbowl write path (CSV import, support scripts). | 15-min reconciliation sweep by `dateLastModified` + fingerprint. |
| R-02 | REST session consumes one of 15 seats. | Seat check in Batch A; `SESSION_MODE=per_cycle` fallback (3 calls / 20 s). |
| R-03 | Fishbowl upgrade changes column names or the custom-field JSON shape. | Raw JSON stored per row; bridge logs unknown/missing columns; version pinned in `fb_sync_state.bridge_version`. |
| R-04 | Server prerequisites (Node, outbound 443, NSSM) need Harry. | Raise in week 1; the bridge runs from Matt's PC against TEST until then. |
| R-05 | Credentials on the plant box. | `.env` outside git, NTFS-restricted to the service account; Fishbowl user limited to Data + SO view; Supabase user limited to the `integration` role with RPC-only reach. |
| R-06 | ~4,400 Skybolt-prefixed Fishbowl products are not in SkyNet; `pending` volume could be high. | Bulk actions; measure after backfill (`resolution` breakdown); if the ratio is bad, a "part stub from queue" round follows. |
| R-07 | Manual-CO linkage ambiguity (same part twice on an SO). | Line-order tie-break + report; April confirms. |
| R-08 | Timezone: Fishbowl dates arrive as `-04`; SkyNet stores `timestamptz` and derives dates in America/New_York. | Offset normalisation in the mapper; date derivation only inside the RPC; never `new Date('YYYY-MM-DD')` in the UI (cheat-sheet rule). |
| R-09 | `so.num` uniqueness assumed. | Non-unique index + bridge alert on a collision. |
| R-10 | Out-of-order Envers commits. | 200-revision overlap each cycle, idempotent ingest. |
| R-11 | Decisions.md clobber during CC rounds. | Close the file before each round (standing rule). |

**Sign-off Aug 24, 2026:** D-FB-07 yes (name per row) · D-FB-11 Estimates excluded entirely · D-FB-12 show ordered and to-fulfill (three informational columns, `quantity_ordered` semantics unchanged) · D-FB-13 `order_processor` additional role, CS read-only · D-FB-15 no auto-cancel · D-FB-17 open orders only.

---

## 13. Spec & Documentation Updates

- Spec v4.4: new §5.x "Fishbowl Bridge and Order Queue" (architecture, mirror model, disposition rules, change semantics, roles), update §5.11 Customer Orders (Fishbowl-sourced COs, FB chip), §5.12 Customers (auto-create from SO), Document History entry.
- Decisions.md: D-FB-01 … D-FB-20 plus build-time lessons.
- Cheat sheet: bridge operations (service name, log path, restart, backfill re-run, cursor reset), `integration` role, Fishbowl credentials location.
- Test script `FB1_Test_Script.docx` in the S3 Batch D style (T-01 … T-22).

---

## 14. Definition of Done

- Bridge running as a Windows service on the Fishbowl server against PROD, heartbeat green for 48 h, no unacknowledged errors.
- Every Issued/In Progress SO in Fishbowl is visible in the Order Queue within 30 s of creation or change.
- Ashley has dispositioned one real day of orders in the queue; at least one production line has become a CO line and a WO through Demand without CS re-keying.
- All manual COs with a Fishbowl SO number are linked; the unmatched list is empty or explained.
- T-01 … T-22 pass on TEST; T-03/T-04/T-05/T-10 re-verified on PROD.
- Spec v4.4, Decisions.md, cheat sheet, and test script delivered.
