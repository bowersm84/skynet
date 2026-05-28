# Job Split Feature — Implementation Plan

**Status:** Pending sprint allocation. Spawned from operational need: J-000022 was manually split via SQL on 2026-05-18 because the scheduler realized mid-flight that the 79,725-piece job should be parallelized across two machines. The manual split worked but isn't repeatable safely — this feature productizes it.

**Owner:** Matt Bowers
**Estimated effort:** 2–3 days (one schema migration, one RPC function, one new modal component, one entry-point integration, test script)

---

## Background

The scheduler (April) sometimes discovers, after a job has been created and possibly already started, that the work would be better split across two machines — for example, when a part has multiple machines capable of producing it and the volume warrants parallel runs. Today there's no in-app way to do this; she would have to manually delete and recreate jobs, breaking traceability, or ask Matt to do raw SQL.

This feature gives the scheduler a guarded, auditable button in the WO lookup modal: pick a job, set the split quantities, confirm. The original job's quantity reduces; a new job is born in `pending_compliance` for Roger to review independently; routing steps, documents (status reset to pending), and materials are cloned to the new job. Customer-order allocations stay at the WO level untouched. A new `job_splits` table records every split for audit and reporting.

The J-000022 manual fix established the SQL playbook for this — see `Decisions.md` 2026-05-18 entry on the manual split. The RPC function below is a productized version of that playbook plus auth gating, status validation, and audit logging.

---

## Scope

### In scope
1. New `public.job_splits` audit table
2. New `public.split_job(p_job_id, p_new_job_quantity, p_reason)` RPC function — atomic, locked, validated
3. New `SplitJobModal.jsx` component
4. Split button on each job row inside the WO lookup modal (`WOLookupModal.jsx` or wherever the modal lives)
5. RLS / permission gating: scheduler + admin only
6. Test cases covering valid splits, invalid statuses, validation errors, permission errors
7. `Decisions.md` entry

### Out of scope (defer to a v2 or future sprint)
- Merge-back / undo a split
- Splitting into more than 2 jobs in a single operation
- Pre-assigning the second machine at split time (new job stays unassigned; goes through normal scheduling after compliance approval)
- Rebalancing customer order allocations across jobs (allocations stay WO-level, both jobs fulfill same WO)
- Reorganizing S3 file paths for cloned documents (cloned docs reference the original job's S3 folder — functionally invisible, but architecturally untidy)
- Subtracting "pieces in flight to finishing" from `pieces_left_to_make` display (the v1 formula `quantity − qty_override − good_pieces` slightly overcounts when batches are mid-finishing; scheduler can mentally adjust)
- Entry points beyond the WO lookup modal (e.g., Mainframe job detail, Schedule). Easy to add later; start narrow.

---

## Lifecycle window

Split is allowed for jobs in any of these statuses:

- `pending_compliance` — pre-approval rebalancing
- `ready` — approved, not yet scheduled
- `assigned` — scheduled, not yet started
- `in_setup` — machinist setting up
- `in_progress` — machinist running (the J22 case)
- `manufacturing_complete` — machining done but not yet sent to passivation (rare; included for completeness because pieces could conceivably still be redivided here)

Split is **blocked** for these statuses (rationale: pieces are past the machine; "splitting" doesn't have an operational meaning):

- `pending_passivation`, `in_passivation`
- `pending_post_manufacturing`
- `ready_for_outsourcing`, `at_external_vendor`
- `ready_for_assembly`, `in_assembly`
- `pending_tco`
- `complete`, `incomplete`, `cancelled`

If a scheduler genuinely needs a "new job for additional work" on a downstream-status job, that's a different operation — they should create a new job through the normal new-job flow. The split feature is specifically about redividing remaining production work.

---

## TASK 1 — Schema migration

Create `Docs/migrations/2026-MM-DD_job_splits.sql`:

```sql
-- job_splits: audit table for the job-split feature
CREATE TABLE public.job_splits (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_job_id       UUID NOT NULL REFERENCES public.jobs(id),
  new_job_id            UUID NOT NULL UNIQUE REFERENCES public.jobs(id),  -- each new job appears in at most one split
  split_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  split_by              UUID NOT NULL REFERENCES public.profiles(id),
  original_qty_before   INTEGER NOT NULL CHECK (original_qty_before > 0),
  original_qty_after    INTEGER NOT NULL CHECK (original_qty_after  > 0),
  new_job_qty           INTEGER NOT NULL CHECK (new_job_qty         > 0),
  reason                TEXT,
  CHECK (original_qty_before = original_qty_after + new_job_qty)
);

CREATE INDEX idx_job_splits_original ON public.job_splits(original_job_id);
CREATE INDEX idx_job_splits_split_at ON public.job_splits(split_at DESC);

ALTER TABLE public.job_splits ENABLE ROW LEVEL SECURITY;

-- Read: any authenticated user can SELECT (audit trail visibility)
CREATE POLICY "job_splits_select_authenticated"
  ON public.job_splits FOR SELECT
  TO authenticated
  USING (true);

-- Insert: only the split_job() function (SECURITY DEFINER) does this.
-- No direct INSERT policy — rows arrive through the function only.
```

---

## TASK 2 — `split_job()` RPC function

In the same migration file (or a follow-up file):

```sql
CREATE OR REPLACE FUNCTION public.split_job(
  p_job_id              UUID,
  p_new_job_quantity    INTEGER,
  p_reason              TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id           UUID;
  v_caller_role         TEXT;
  v_job                 RECORD;
  v_pieces_left         INTEGER;
  v_qty_before          INTEGER;
  v_qty_after           INTEGER;
  v_new_job_id          UUID;
  v_new_job_number      TEXT;
  v_next_num            INTEGER;
  k_allowed_statuses    TEXT[] := ARRAY[
    'pending_compliance', 'ready', 'assigned',
    'in_setup', 'in_progress', 'manufacturing_complete'
  ];
BEGIN
  -- 1. Authn / authz
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT role INTO v_caller_role
  FROM public.profiles
  WHERE id = v_caller_id;

  IF v_caller_role NOT IN ('scheduler', 'admin') THEN
    RAISE EXCEPTION 'Only scheduler or admin can split jobs (caller role: %)', v_caller_role
      USING ERRCODE = '42501';
  END IF;

  -- 2. Lock and capture the original job
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id USING ERRCODE = '02000';
  END IF;

  -- 3. Status gate
  IF NOT (v_job.status = ANY(k_allowed_statuses)) THEN
    RAISE EXCEPTION 'Cannot split job in status %. Allowed: %',
      v_job.status, k_allowed_statuses USING ERRCODE = '22023';
  END IF;

  -- 4. Quantity validation
  v_qty_before  := v_job.quantity;
  v_pieces_left := v_job.quantity - COALESCE(v_job.qty_override, 0) - COALESCE(v_job.good_pieces, 0);

  IF p_new_job_quantity IS NULL OR p_new_job_quantity <= 0 THEN
    RAISE EXCEPTION 'New job quantity must be positive (got %)', p_new_job_quantity
      USING ERRCODE = '22023';
  END IF;

  IF p_new_job_quantity >= v_pieces_left THEN
    RAISE EXCEPTION 'New job quantity (%) must leave at least 1 piece on original (pieces_left_to_make=%)',
      p_new_job_quantity, v_pieces_left USING ERRCODE = '22023';
  END IF;

  v_qty_after := v_qty_before - p_new_job_quantity;

  -- 5. Resolve next job number
  SELECT COALESCE(MAX(REGEXP_REPLACE(job_number, '^J-', '')::INTEGER), 0) + 1
    INTO v_next_num
  FROM public.jobs
  WHERE job_number ~ '^J-[0-9]+$';
  v_new_job_number := 'J-' || LPAD(v_next_num::TEXT, 6, '0');

  -- 6. Update original
  UPDATE public.jobs
  SET quantity = v_qty_after,
      notes    = COALESCE(notes || E'\n', '') ||
                 'Split with ' || v_new_job_number || ' on ' || CURRENT_DATE::TEXT ||
                 ': quantity ' || v_qty_before || ' → ' || v_qty_after ||
                 '. ' || p_new_job_quantity || ' pieces moved to new job.' ||
                 CASE WHEN p_reason IS NOT NULL THEN ' Reason: ' || p_reason ELSE '' END,
      updated_at = NOW()
  WHERE id = p_job_id;

  -- 7. Insert new job
  INSERT INTO public.jobs (
    work_order_id, work_order_assembly_id, part_id, component_id,
    job_number, quantity, priority, status,
    good_pieces, bad_pieces, notes
  ) VALUES (
    v_job.work_order_id, v_job.work_order_assembly_id, v_job.part_id, v_job.component_id,
    v_new_job_number, p_new_job_quantity, v_job.priority, 'pending_compliance',
    0, 0,
    'Split from ' || v_job.job_number || ' on ' || CURRENT_DATE::TEXT ||
    CASE WHEN p_reason IS NOT NULL THEN '. Reason: ' || p_reason ELSE '' END
  )
  RETURNING id INTO v_new_job_id;

  -- 8. Clone routing steps
  INSERT INTO public.job_routing_steps (
    job_id, step_order, step_name, step_type, station, status, is_added_step
  )
  SELECT v_new_job_id, step_order, step_name, step_type, station, 'pending', false
  FROM public.job_routing_steps
  WHERE job_id = p_job_id;

  -- 9. Clone documents (status reset to 'pending' for independent compliance review)
  INSERT INTO public.job_documents (
    job_id, document_type_id, file_name, file_url, file_size, mime_type,
    form_data, status, uploaded_by, source
  )
  SELECT v_new_job_id, document_type_id, file_name, file_url, file_size, mime_type,
         form_data, 'pending', uploaded_by, source
  FROM public.job_documents
  WHERE job_id = p_job_id;

  -- 10. Clone materials (job_materials)
  -- NOTE: CC should inspect job_materials schema and copy all non-PK / non-job_id columns.
  -- Reset any "loaded" / "completed" state flags to fresh (false/null) since this is a new job.
  INSERT INTO public.job_materials (job_id, /* TODO: all material columns minus job_id and id */)
  SELECT v_new_job_id, /* TODO */ FROM public.job_materials WHERE job_id = p_job_id;

  -- 11. Audit
  INSERT INTO public.job_splits (
    original_job_id, new_job_id, split_by,
    original_qty_before, original_qty_after, new_job_qty, reason
  ) VALUES (
    p_job_id, v_new_job_id, v_caller_id,
    v_qty_before, v_qty_after, p_new_job_quantity, p_reason
  );

  RETURN v_new_job_id;
END $$;

-- Allow authenticated users to call; permission check is in-function.
GRANT EXECUTE ON FUNCTION public.split_job(UUID, INTEGER, TEXT) TO authenticated;
```

**Implementation note for CC:** The `job_materials` INSERT in step 10 has a TODO — CC needs to view `public.job_materials` schema, list all columns minus `id` and `job_id`, and write the explicit `INSERT ... SELECT` preserving every column. Reset operational state columns (`loaded_at`, `loaded_by`, `completed_at`, `completed_by`, etc.) to NULL on the new job so the new copy starts fresh.

Same consideration applies to `job_tools` — view the schema and decide whether to clone (probably yes, since tools are part of the routing) with operational state reset.

---

## TASK 3 — `SplitJobModal.jsx` component

New component at `src/components/SplitJobModal.jsx`. Opens when scheduler clicks the "Split" button on a job row in the WO lookup modal.

### Props
```javascript
{
  job,           // full job row including id, job_number, quantity, qty_override, good_pieces, status, work_order_id
  onSplitComplete,  // callback fired after successful split, receives { newJobId, newJobNumber }
  onCancel,
}
```

### State
```javascript
const [newJobQty, setNewJobQty] = useState(/* half of pieces_left_to_make, rounded up */)
const [reason, setReason] = useState('')
const [isSubmitting, setIsSubmitting] = useState(false)
const [error, setError] = useState(null)
```

### Derived values
```javascript
const piecesLeftToMake = job.quantity - (job.qty_override || 0) - (job.good_pieces || 0)
const originalQtyAfter = job.quantity - newJobQty
const isValid = newJobQty > 0 && newJobQty < piecesLeftToMake
```

### UI layout

```
┌─ Split Job ─────────────────────────────────────────────┐
│                                                         │
│  Job:               J-000022                            │
│  Part:              SK27CP2 — Stainless Phillips        │
│  Customer:          Pinair Tech Corp / AB               │
│                                                         │
│  ── Current state ───────────────────────────────────   │
│  Total quantity:         99,000                         │
│  Prior work (override):  79,725                         │
│  Good pieces:                 0                         │
│  Pieces left to make:    19,275                         │
│                                                         │
│  ── Split ───────────────────────────────────────────   │
│                                                         │
│  Move to new job:    [   9,638 ▲▼ ]  pieces             │
│  Original keeps:     [   9,637    ]  pieces (auto)      │
│                                                         │
│  Reason (optional):                                     │
│  [ Parallel run on second Mazak ]                       │
│                                                         │
│  ⚠ The new job will be created in pending_compliance.   │
│    Roger will review documents and routing before it    │
│    can be scheduled on a machine.                       │
│                                                         │
│           [ Cancel ]              [ Split Job ]         │
└─────────────────────────────────────────────────────────┘
```

### Validation rules

- `newJobQty` must be a positive integer
- `newJobQty` must be strictly less than `piecesLeftToMake` (can't move all of it — that's a delete, not a split)
- "Split Job" button disabled if invalid or while submitting

### Submit handler

```javascript
async function handleSplit() {
  setIsSubmitting(true)
  setError(null)
  const { data, error } = await supabase.rpc('split_job', {
    p_job_id: job.id,
    p_new_job_quantity: newJobQty,
    p_reason: reason || null,
  })
  if (error) {
    setError(error.message)
    setIsSubmitting(false)
    return
  }
  // data is the new job id
  onSplitComplete({ newJobId: data })
}
```

### Error handling

If the RPC returns a permission error (28000), quantity error (22023), or status error — display in a red banner above the buttons. Don't close the modal automatically; let the scheduler adjust and retry.

---

## TASK 4 — Entry point: Split button in WO lookup modal

CC should view the existing WO lookup modal (likely `src/components/WOLookupModal.jsx`, possibly `WorkOrderDetailModal.jsx` — discover from imports) and add a Split button next to each job row.

Visibility: only render the button if the viewer's role is `scheduler` or `admin` AND the job's status is in the allowed list. Reuse the same `k_allowed_statuses` array from the RPC; ideally surface it as a constant in `src/lib/jobs.js` (new helper file) so the gate is centralized:

```javascript
// src/lib/jobs.js
export const SPLITTABLE_STATUSES = [
  'pending_compliance', 'ready', 'assigned',
  'in_setup', 'in_progress', 'manufacturing_complete'
]
export function isSplittable(job) {
  return SPLITTABLE_STATUSES.includes(job?.status)
}
```

UI: small "Split" button in the row's actions area. Click → opens `SplitJobModal` with the job. On success → toast notification "Job J-XXXXXX created in compliance queue" + refresh the WO lookup data so the new job appears in the row list with `pending_compliance` status.

If there are multiple WO modals or detail surfaces (Customer Orders has one, Mainframe might have one), start with the WO lookup modal specifically called out by Matt and document the others as follow-ups in Decisions.md.

---

## TASK 5 — Test cases

To be packaged as `Job_Split_Test_Script.docx` matching the `S3_Batch_D_Test_Script.docx` style. Test matrix:

### Permission tests
- **TC-01** Scheduler can split a job → succeeds
- **TC-02** Admin can split a job → succeeds
- **TC-03** Machinist tries to split → blocked with permission error
- **TC-04** Compliance tries to split → blocked
- **TC-05** Customer service tries to split → blocked
- **TC-06** Viewer / president tries to split → blocked (the read-only roles)

### Status tests (one valid split per allowed status, one rejected per blocked status)
- **TC-10** Split `pending_compliance` job → both go through compliance
- **TC-11** Split `ready` job → original stays ready, new goes to pending_compliance
- **TC-12** Split `assigned` job → original stays assigned, new goes to pending_compliance, original keeps its machine + schedule
- **TC-13** Split `in_setup` job → original stays in_setup, new goes to pending_compliance
- **TC-14** Split `in_progress` job (the J22 case) → original stays in_progress on its machine, new goes to pending_compliance
- **TC-15** Split `manufacturing_complete` job → succeeds (edge case)
- **TC-20** Try to split `pending_passivation` → blocked
- **TC-21** Try to split `at_external_vendor` → blocked
- **TC-22** Try to split `complete` → blocked
- **TC-23** Try to split `cancelled` → blocked

### Quantity validation tests
- **TC-30** Split with `newJobQty = 0` → blocked
- **TC-31** Split with `newJobQty = -100` → blocked
- **TC-32** Split with `newJobQty >= piecesLeftToMake` → blocked
- **TC-33** Split with `newJobQty = piecesLeftToMake - 1` → succeeds (boundary)
- **TC-34** Split with `newJobQty = 1` → succeeds (boundary)

### Data integrity tests
- **TC-40** After split, `original_qty_before = original_qty_after + new_job_qty` in `job_splits` table
- **TC-41** Routing steps cloned to new job, all status='pending'
- **TC-42** Documents cloned to new job, all status='pending'
- **TC-43** Materials cloned to new job, operational state reset
- **TC-44** Customer order allocation unchanged (still at WO level)
- **TC-45** New job has `qty_override = NULL`, `good_pieces = 0`, no machine assigned, no schedule
- **TC-46** Original job's `qty_override` unchanged

### Compliance integration tests
- **TC-50** New job appears in Roger's compliance queue
- **TC-51** Roger can approve new job independently of original
- **TC-52** After approval, new job moves to `ready` and is schedulable
- **TC-53** Scheduler assigns new job to a different machine than the original

### Concurrency tests
- **TC-60** Two split attempts on same job at once: one wins, other gets locked-row error (`FOR UPDATE` should serialize)

---

## TASK 6 — `Decisions.md` entry

```markdown
## 2026-MM-DD — Job split feature (productized from J-000022 manual fix)

Operational pattern from 2026-05-18 (manual split of J-000022 via SQL) productized into a UI feature.

**Trigger.** Scheduler clicks "Split" on a job row in the WO lookup modal. Opens `SplitJobModal` showing current quantities and pieces-left-to-make. Scheduler enters how many pieces to move to the new job (default: half of remaining, rounded up). Optional reason field. Confirm fires `split_job()` RPC.

**Atomic transaction via Postgres RPC.** `public.split_job(p_job_id, p_new_job_quantity, p_reason)` does everything in one locked transaction: auth + status gate, quantity validation, `FOR UPDATE` lock on original, update original's `quantity` (qty_override left untouched — preserves prior-work provenance), insert new job in `pending_compliance` with cloned WO/part/component refs, clone routing steps + documents (status reset to `pending`) + materials (operational state reset), insert audit row in `job_splits`. Returns new job id. SECURITY DEFINER; grants EXECUTE to authenticated; permission check is in-function via profile role.

**Allowed statuses for split:** `pending_compliance, ready, assigned, in_setup, in_progress, manufacturing_complete`. Blocked for everything downstream (passivation, outsourcing, assembly, TCO) and terminal states — once pieces are past the machine, "splitting" doesn't redivide work, it just creates a separate new job, which is a different operation.

**Permissions:** scheduler + admin only. RPC rejects all other roles.

**Audit.** New `public.job_splits` table — `(id, original_job_id, new_job_id, split_at, split_by, original_qty_before, original_qty_after, new_job_qty, reason)`. Check constraint enforces `before = after + new_qty`. Indexed on `original_job_id` and `split_at DESC`. RLS allows authenticated SELECT; INSERTs only flow through the function.

**Quantity semantics:** original's `quantity` decreases by `new_job_qty`; `qty_override` (representing prior-work provenance) stays untouched. New job's `quantity` = its full target; new job has no `qty_override`.

**Known v1 limitations.**
- Pieces in flight to finishing (sent but not verified) inflate `pieces_left_to_make` slightly because `good_pieces` only updates at job complete. Acceptable for a rough-split UX; scheduler can mentally adjust.
- Cloned documents reference the original job's S3 folder path. Files are accessible from the new job, but the folder structure is mildly untidy. v2 could physically copy files to a new folder.
- Customer order allocations stay at WO level. If a future workflow needs per-job allocations, that's its own feature.
- Only entry point is the WO lookup modal. Mainframe job detail and Schedule could grow Split buttons later.

**Replaces backlog item:** Sprint TBD; no prior backlog id assigned.
```

---

## VERIFY

1. Migration applies clean on TEST: `job_splits` table created with the check constraint and indexes; `split_job` function present; EXECUTE granted to authenticated.
2. `npm run build` exits clean after frontend changes.
3. Walk through the test matrix on TEST (`test-skynet.skybolt.com`). Capture each result in the test script doc.
4. Once TEST passes: apply migration to PROD, deploy frontend, regression-test the WO lookup modal with a single safe split on a small job.

---

## Open implementation questions for CC

CC should view the relevant files first and surface any of these in its initial response, before writing any code:

1. **Exact location of the WO lookup modal.** Most likely `src/components/WOLookupModal.jsx` or `src/pages/CustomerOrders.jsx` has it inline. Discover via grep and confirm.
2. **`job_materials` schema** — the INSERT in `split_job()` step 10 has a TODO. CC reads the table definition and writes the explicit column list, with operational state columns reset.
3. **`job_tools` cloning** — does the schema warrant cloning these too? If `job_tools` rows are per-job (not per-routing-step), yes clone with operational state reset.
4. **Existing toast/notification pattern** — match whatever pattern existing modals use for success/error feedback.
