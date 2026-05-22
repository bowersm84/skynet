# SkyNet Sprint 5 — Implementation Plan
## Customer Orders & Demand Pool
### May 1, 2026 | Target: 3-day build (test branch only, no prod promotion until April-validated)

---

## Sprint Goal
Introduce a Customer Order layer above Work Orders so April can capture demand
from Fishbowl, accumulate it as a pool, and roll multiple customer orders into
a single Work Order at scheduling time. Establishes a customer master and
renames WO Lookup to Order Lookup. WO/Job relationship unchanged — change is
upstream of compliance, production, and finishing.

**This sprint is test-only until April signs off.** No prod promotion. No
existing data migration (live system has zero orders).

---

## Scope Decisions (locked)

| # | Decision | Notes |
|---|----------|-------|
| 1 | Parent-child CO model | `customer_orders` (header) + `customer_order_lines` (per part) |
| 2 | Partial allocation | Junction table `customer_order_allocations` allows one line → many WOs |
| 3 | Customers as FK | New `customers` table, replaces free-text on WO |
| 4 | Status simplified | `not_started` / `in_progress` / `complete` / `cancelled` |
| 5 | Status maintenance | Trigger-driven, denormalized on row |
| 6 | CO number format | `CO-<customer_id>-<order_id>`, alphanumeric only |
| 7 | Cancellation v1 | Flag + banner only; decision UI deferred to Sprint 6 |
| 8 | Order Lookup rename | WO Lookup → Order Lookup with WO / CO tabs |
| 9 | Customers tab in Armory | Flat list, inline edit, CSV paste import |
| 10 | Fulfillment v1 | Line marked complete in one shot; per-shipment tracking deferred |

---

## Action Items

| # | Action Item | Batch | Effort |
|---|-------------|-------|--------|
| 1 | Schema migration: customers, COs, lines, allocations | A | 0.25d |
| 2 | RLS policies for new tables | A | 0.25d |
| 3 | Status rollup triggers | A | 0.25d |
| 4 | Customers tab in Armory (list/add/edit/CSV import) | A | 0.5d |
| 5 | Customer Orders module — list view with master-detail | B | 0.5d |
| 6 | Create CO modal (header + line items + Fishbowl ref) | B | 0.5d |
| 7 | Cancel CO / cancel line actions | B | 0.25d |
| 8 | Mark line complete action | B | 0.25d |
| 9 | Order Lookup rename + WO/CO tabs | C | 0.25d |
| 10 | Search across both tabs | C | 0.25d |
| 11 | CreateWorkOrderModal: pending CO lines surface for selected part | C | 0.5d |
| 12 | Allocation write on WO save | C | 0.25d |
| 13 | WO has-cancelled-allocation banner (Mainframe + Schedule + Order Lookup) | C | 0.25d |
| 14 | `getCOQuantities` helper (unallocated/in_production/fulfilled per line) | C | 0.25d |
| 15 | Job Traveler: Customer Orders Fulfilled section | C | 0.25d |
| 16 | Test plan + S5 test script docx | C | 0.25d |

**Total: ~3 days of focused work.**

---

## Batch A: Schema + Customers (Day 1, AM)

### Migration SQL — `Docs/migrations/2026-05-01_sprint5_customer_orders.sql`

```sql
-- ============================================================================
-- Sprint 5: Customer Orders & Demand Pool
-- Test environment first. DO NOT promote to prod until validated by April.
-- ============================================================================

-- 1. Customers master
CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id text UNIQUE NOT NULL,        -- Fishbowl customer ID, 1-6 numeric
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_customer_id_format CHECK (customer_id ~ '^[0-9]{1,6}$')
);
CREATE INDEX idx_customers_active ON public.customers(is_active) WHERE is_active;
CREATE INDEX idx_customers_name_lower ON public.customers(lower(name));

-- 2. Customer Orders (header)
CREATE TABLE public.customer_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  co_number text UNIQUE NOT NULL,          -- CO-<custid>-<orderid>
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  fishbowl_order_id text NOT NULL,         -- Stripped to alphanumeric
  po_number text,
  notes text,
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started','in_progress','complete','cancelled')),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES public.profiles(id),
  cancel_reason text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customer_orders_customer ON public.customer_orders(customer_id);
CREATE INDEX idx_customer_orders_status ON public.customer_orders(status);
CREATE INDEX idx_customer_orders_fishbowl ON public.customer_orders(fishbowl_order_id);

-- 3. Customer Order Lines (children)
CREATE TABLE public.customer_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_order_id uuid NOT NULL REFERENCES public.customer_orders(id) ON DELETE CASCADE,
  line_number integer NOT NULL,
  part_id uuid NOT NULL REFERENCES public.parts(id),
  quantity_ordered integer NOT NULL CHECK (quantity_ordered > 0),
  quantity_fulfilled integer NOT NULL DEFAULT 0
    CHECK (quantity_fulfilled >= 0),
  due_date date,
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('critical','high','normal','low')),
  notes text,
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started','in_progress','complete','cancelled')),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES public.profiles(id),
  cancel_reason text,
  fulfilled_at timestamptz,
  fulfilled_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_order_id, line_number)
);
CREATE INDEX idx_co_lines_part ON public.customer_order_lines(part_id, status)
  WHERE status IN ('not_started','in_progress');
CREATE INDEX idx_co_lines_co ON public.customer_order_lines(customer_order_id);

-- 4. Allocations (line ↔ WO junction)
CREATE TABLE public.customer_order_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_order_line_id uuid NOT NULL REFERENCES public.customer_order_lines(id),
  work_order_id uuid NOT NULL REFERENCES public.work_orders(id),
  quantity_allocated integer NOT NULL CHECK (quantity_allocated > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  deactivated_by uuid REFERENCES public.profiles(id),
  UNIQUE (customer_order_line_id, work_order_id, is_active)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_co_alloc_line ON public.customer_order_allocations(customer_order_line_id)
  WHERE is_active;
CREATE INDEX idx_co_alloc_wo ON public.customer_order_allocations(work_order_id)
  WHERE is_active;

-- 5. Work order additions
ALTER TABLE public.work_orders
  ADD COLUMN is_combined boolean NOT NULL DEFAULT false,
  ADD COLUMN has_cancelled_allocation boolean NOT NULL DEFAULT false;

-- 6. Status rollup trigger function (line-level)
CREATE OR REPLACE FUNCTION public.recalc_co_line_status(line_id uuid)
RETURNS void AS $$
DECLARE
  v_ordered integer;
  v_fulfilled integer;
  v_active_alloc integer;
  v_current_status text;
BEGIN
  SELECT quantity_ordered, quantity_fulfilled, status
    INTO v_ordered, v_fulfilled, v_current_status
    FROM public.customer_order_lines WHERE id = line_id;

  IF v_current_status = 'cancelled' THEN
    RETURN;  -- cancelled is sticky
  END IF;

  SELECT COALESCE(SUM(quantity_allocated), 0)
    INTO v_active_alloc
    FROM public.customer_order_allocations
    WHERE customer_order_line_id = line_id AND is_active;

  UPDATE public.customer_order_lines
    SET status = CASE
      WHEN v_fulfilled >= v_ordered THEN 'complete'
      WHEN v_active_alloc > 0 OR v_fulfilled > 0 THEN 'in_progress'
      ELSE 'not_started'
    END,
    updated_at = now()
  WHERE id = line_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. Status rollup trigger function (parent CO)
CREATE OR REPLACE FUNCTION public.recalc_co_status(co_id uuid)
RETURNS void AS $$
DECLARE
  v_total integer;
  v_complete integer;
  v_cancelled integer;
  v_in_progress integer;
  v_current_status text;
BEGIN
  SELECT status INTO v_current_status FROM public.customer_orders WHERE id = co_id;
  IF v_current_status = 'cancelled' THEN
    RETURN;
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'complete'),
    COUNT(*) FILTER (WHERE status = 'cancelled'),
    COUNT(*) FILTER (WHERE status = 'in_progress')
  INTO v_total, v_complete, v_cancelled, v_in_progress
  FROM public.customer_order_lines WHERE customer_order_id = co_id;

  UPDATE public.customer_orders
    SET status = CASE
      WHEN v_total = 0 THEN 'not_started'
      WHEN v_complete + v_cancelled = v_total AND v_complete > 0 THEN 'complete'
      WHEN v_cancelled = v_total THEN 'cancelled'
      WHEN v_in_progress > 0 OR v_complete > 0 THEN 'in_progress'
      ELSE 'not_started'
    END,
    updated_at = now()
  WHERE id = co_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 8. Triggers — fire on allocation changes, line fulfillment, line cancellation
CREATE OR REPLACE FUNCTION public.trg_alloc_recalc()
RETURNS trigger AS $$
DECLARE
  v_line uuid;
  v_co uuid;
BEGIN
  v_line := COALESCE(NEW.customer_order_line_id, OLD.customer_order_line_id);
  PERFORM public.recalc_co_line_status(v_line);
  SELECT customer_order_id INTO v_co FROM public.customer_order_lines WHERE id = v_line;
  PERFORM public.recalc_co_status(v_co);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_alloc_aiud
  AFTER INSERT OR UPDATE OR DELETE ON public.customer_order_allocations
  FOR EACH ROW EXECUTE FUNCTION public.trg_alloc_recalc();

CREATE OR REPLACE FUNCTION public.trg_line_recalc_parent()
RETURNS trigger AS $$
BEGIN
  PERFORM public.recalc_co_status(NEW.customer_order_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_line_au
  AFTER UPDATE OF status, quantity_fulfilled ON public.customer_order_lines
  FOR EACH ROW EXECUTE FUNCTION public.trg_line_recalc_parent();

-- 9. Updated_at maintenance
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customers_uat BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_co_uat BEFORE UPDATE ON public.customer_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_co_lines_uat BEFORE UPDATE ON public.customer_order_lines
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 10. RLS
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_order_allocations ENABLE ROW LEVEL SECURITY;

-- All authenticated users SELECT (kiosks need to read for traveler)
CREATE POLICY customers_select ON public.customers FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY co_select ON public.customer_orders FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY co_lines_select ON public.customer_order_lines FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY co_alloc_select ON public.customer_order_allocations FOR SELECT TO authenticated, anon USING (true);

-- INSERT/UPDATE/DELETE: admin, scheduler, customer_service
CREATE POLICY customers_iud ON public.customers FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')));
CREATE POLICY co_iud ON public.customer_orders FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')));
CREATE POLICY co_lines_iud ON public.customer_order_lines FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')));
CREATE POLICY co_alloc_iud ON public.customer_order_allocations FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')));

-- 11. Verification
SELECT 'customers' AS tbl, count(*) FROM public.customers
UNION ALL SELECT 'customer_orders', count(*) FROM public.customer_orders
UNION ALL SELECT 'customer_order_lines', count(*) FROM public.customer_order_lines
UNION ALL SELECT 'customer_order_allocations', count(*) FROM public.customer_order_allocations;

SELECT relname, polcmd, count(*) FROM pg_policies p
  JOIN pg_class c ON c.relname = p.tablename
  WHERE schemaname='public'
    AND tablename IN ('customers','customer_orders','customer_order_lines','customer_order_allocations')
  GROUP BY 1,2 ORDER BY 1,2;
```

### Customers tab in Armory

**File:** `src/pages/Armory.jsx` — add `Customers` to TAB_ACCESS_BY_ROLE map for `admin`, `scheduler`, `customer_service`. New sub-component renders.

**Surface:**
- Table: Customer ID, Name, Active, Notes, Created
- "Add Customer" button → modal with `customer_id` (numeric, 1-6 chars, validated) + `name` + optional notes
- Inline name edit on row click; toggle active via switch
- "Import CSV" button → textarea paste, expects `customer_id,name` rows. Validates each, dedupes against existing customer_ids, inserts in one batch. Shows "X added, Y skipped (existing), Z errors" summary.
- No detail page in v0. Detail page is Sprint 6.

---

## Batch B: Customer Orders Module (Day 1 PM — Day 2 AM)

### New file: `src/pages/CustomerOrders.jsx`

**Surface — list view:**
- Header: filter chips (`All`, `Not Started`, `In Progress`, `Complete`, `Cancelled`); search box (CO #, customer name, PO #, Fishbowl order ID, part #).
- Table grouped by status, each row expandable to show line items.
- Row columns: CO #, Customer, PO #, # Lines, Earliest Due, Status badge, Created, Actions.
- Expanded line view: Line #, Part, Qty Ordered, Qty Allocated, Qty Fulfilled, Qty Remaining, Due, Status, Actions (Mark Complete / Cancel).
- Color: COs get a purple-to-amber accent vs WOs which use the existing skynet-blue. Distinct visual identity per Matt's request.

**Create CO modal (new component `src/components/CreateCustomerOrderModal.jsx`):**
- Fields: Customer (searchable from `customers`), PO #, Fishbowl Order ID (alphanumeric stripped on blur and uppercased; preview shows resulting CO # live as `CO-<custid>-<orderid>`).
- Lines: dynamic add/remove rows, each with Part (searchable picker, same component pattern as `CreateWorkOrderModal.ProductCombobox`), Qty Ordered, Due Date, Priority, Notes.
- Save: insert CO header, generate co_number, insert lines with `line_number` 1..N. Status defaults to `not_started` for both header and lines.
- Validation: CO # uniqueness (check before insert; surface friendly error).

**Cancel actions:**
- Cancel line: confirm modal, requires reason. Sets line status=cancelled, marks active allocations is_active=false, sets `work_orders.has_cancelled_allocation=true` for each affected WO. Trigger recalcs parent.
- Cancel CO: confirm modal, requires reason. Cancels all non-complete lines (cascade through the same line cancel logic). If any line is already complete, that line stays complete; CO ends in `complete` (mixed) — actually let's keep it simple: cancelling a CO with a complete line still allowed; complete lines stay complete; remaining lines flip to cancelled; parent rolls up to `complete` (since complete + cancelled = "all done" by trigger logic).

**Mark complete action (line-level):**
- Confirm modal: "Mark line as complete? This sets fulfilled qty = ordered qty and shipped status."
- Sets `quantity_fulfilled = quantity_ordered`, `fulfilled_at = now()`, `fulfilled_by = current user`. Trigger recalcs.

---

## Batch C: Order Lookup + Create WO Integration (Day 2 PM — Day 3)

### Order Lookup rename + tabs

**Files touched:** `src/pages/Mainframe.jsx` (current WO Lookup section), routing label changes, header label.

- Rename WO Lookup → Order Lookup everywhere (UI label, comments).
- Add tab strip at top of section: `Work Orders` (default) | `Customer Orders`.
- Customer Orders tab is the same `CustomerOrders.jsx` component embedded.
- Search box at top of Order Lookup — when on WO tab, searches WOs (existing logic + new: also searches linked CO customer names and CO #s); when on CO tab, searches COs.

### CreateWorkOrderModal updates

**File:** `src/components/CreateWorkOrderModal.jsx`

Changes:
1. After product picker selection, fetch open CO lines for the part:
   ```sql
   SELECT col.*, co.co_number, co.po_number, c.name AS customer_name,
          COALESCE(SUM(coa.quantity_allocated) FILTER (WHERE coa.is_active), 0) AS qty_allocated
     FROM customer_order_lines col
     JOIN customer_orders co ON co.id = col.customer_order_id
     JOIN customers c ON c.id = co.customer_id
     LEFT JOIN customer_order_allocations coa ON coa.customer_order_line_id = col.id
   WHERE col.part_id = $1
     AND col.status IN ('not_started', 'in_progress')
     AND co.status != 'cancelled'
   GROUP BY col.id, co.co_number, co.po_number, c.name
   HAVING col.quantity_ordered - col.quantity_fulfilled - COALESCE(SUM(coa.quantity_allocated) FILTER (WHERE coa.is_active), 0) > 0
   ORDER BY col.due_date NULLS LAST, co.created_at;
   ```
2. New UI section between part picker and routing: "Pending Customer Orders for this Part" with checkboxes per line.
3. Each line row: `[ ] CO-1234-ABC · Acme Corp · Line 2 of 3 · 1,000 remaining · due 5/15` plus an editable "allocate" qty (defaults to remaining; can be reduced for partial allocation).
4. Above the existing "Stock Quantity" field, show running total: "Customer Allocations: X · Stock: Y · Total Job Qty: Z".
5. On save, create allocation rows after WO insert, before job creation (so triggers fire correctly).
6. WO `customer` and `po_number` populated from the single linked CO when N=1, null when N=0 or N>1; `is_combined = (N > 1)`.

### Cancellation banner

**Files:** `src/pages/Mainframe.jsx`, `src/pages/Schedule.jsx`, Order Lookup WO row renderer.

- Mainframe: amber banner on WO card if `has_cancelled_allocation = true` — text "⚠ Customer order cancelled — review allocation"; click opens WO detail with allocation list.
- Schedule: amber outline on the scheduled-job block + tooltip.
- Order Lookup WO row: same banner inline.
- Banner dismissed by admin/scheduler clicking "Acknowledge" → sets flag false + writes `audit_logs` event. (Per Sprint 6, this becomes the gateway to the decision UI; for now it's a manual ack.)

### Job Traveler addition

**File:** `src/lib/traveler.js`

- New section after WO header: "Customer Orders Fulfilled by this Job"
- Lists each linked CO line: CO #, Customer, PO #, Allocated Qty.
- Pulls via `customer_order_allocations → customer_order_lines → customer_orders → customers`.

### Helper: `src/lib/customerOrders.js`

```js
// getCOLineQuantities — line-level allocation/fulfillment math
// returns { ordered, fulfilled, allocated_active, remaining_to_allocate }
export async function getCOLineQuantities(supabase, lineId) { ... }

// formatCONumber — CO-<custid>-<orderid> with stripping/uppercasing
export function formatCONumber(customerId, fishbowlOrderId) {
  const stripped = String(fishbowlOrderId).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `CO-${customerId}-${stripped}`;
}
```

---

## Test Plan (Batch C tail)

Test script: `Docs/S5_Test_Script.docx` — same shape as S3_Batch_D_Test_Script.

**Test cases:**
1. Add customer (manual + CSV import); verify validation
2. Create CO with one line, status=not_started
3. Create CO with three lines (multi-part PO), status=not_started
4. Create WO for part with two pending CO lines; check both, save → verify lines flip to in_progress, allocations created, WO is_combined=true, customer=null
5. Create WO for part with one pending CO line; allocate full qty → verify line in_progress, WO customer=name, is_combined=false
6. Create WO for part with one pending CO line; allocate partial qty (line of 5,000, allocate 2,500) → verify line in_progress, remaining 2,500 still surfaces in next WO modal
7. Create WO with stock-only (no CO lines) → verify works as before
8. Mark line complete → verify status=complete, parent CO recalcs
9. Cancel single line on multi-line CO → verify line cancelled, other lines untouched, parent stays in_progress, affected WO has_cancelled_allocation=true, banner appears
10. Cancel whole CO with mix of complete and in_progress lines → verify in_progress lines cancelled, complete lines untouched, parent rolls up correctly
11. Acknowledge cancellation banner → verify flag clears, audit log written
12. Job traveler shows Customer Orders Fulfilled section with correct allocations
13. Order Lookup tab toggle works; search finds COs by Fishbowl order ID, CO #, customer name
14. RLS: machinist role cannot create/edit COs; can SELECT (for traveler)

---

## Spec & Decisions Updates

After validation:
- `Decisions.md`: append Sprint 5 section with rationale on parent-child model, partial allocation, status simplification, customers as FK, deferred decision UI.
- Spec → v2.8: new section §5.11 Customer Orders, §5.12 Customers Tab; updates §5.7 (rename Order Lookup), §5.9 (Create WO modal — Pending CO Lines surface); §10.3 v2.8 Schema Additions; §13.1 marks Sprint 5 complete.

---

## Open Items for Sprint 6 (deferred)

- Cancellation decision UI (3-option flow: reduce qty / convert to stock / keep as-is)
- Per-shipment fulfillment tracking (multiple ship events per line)
- Fishbowl sync: pull customers + orders programmatically
- Customer detail page in Armory (history, contacts, etc.)
- Multi-WO timeline view per CO (visualize allocations across WOs)

---

## Risk & Mitigation

| Risk | Mitigation |
|------|-----------|
| Trigger logic edge case (cancelled line that re-activates) | Cancelled is sticky in trigger; manual SQL only if uncancel is ever needed (won't be in v1) |
| Partial allocation math drift | Centralize in `getCOLineQuantities`; never compute inline |
| WO created without linked COs (legitimate stock build) | Schema permits `is_combined=false` and zero allocations; Create WO modal allows skipping the CO selection |
| April adds Fishbowl ID with hyphens | Stripped silently on blur; live preview shows the result before save |
| Parent CO trigger recalc on every line update is expensive | Indexed on customer_order_id; only fires on status/qty_fulfilled change, not every column |
| Test → prod schema drift | Per existing discipline, single migration file in Docs/migrations, run on test first, code merge to test, validation, then prod (when April signs off) |

---

## Build Order (3-day plan)

**Day 1 (AM):** Migration SQL, run on test, verify with audit query. Customers tab UI + import.
**Day 1 (PM):** CustomerOrders.jsx list view + Create CO modal.
**Day 2 (AM):** Cancel/complete actions + status trigger validation.
**Day 2 (PM):** Order Lookup rename + tabs + search wiring.
**Day 3 (AM):** CreateWorkOrderModal updates (pending lines, allocation, banner).
**Day 3 (PM):** Job Traveler additions, helper extraction, test script execution, S5 plan + Decisions update.
