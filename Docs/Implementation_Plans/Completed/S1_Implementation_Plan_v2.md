# SkyNet Sprint 1 — Updated Implementation Plan v2
## Foundation & Work Orders (Weeks 1–2, ~28 hrs)
### Updated Feb 20, 2026 — Routing design finalized

---

## Architecture: The Routing System (3-Tier)

The routing system uses a copy-down pattern at three levels:

```
ROUTING TEMPLATES (Master Data)          ← Reusable starting points by material type
    ↓ copies to...
PART ROUTING STEPS (per component)       ← The "official" routing for this part
    ↓ copies to...
JOB ROUTING STEPS (per job instance)     ← The live runtime copy, filled during production
```

Each level is independent after copying. Changing a template doesn't change
existing components. Changing a component's routing doesn't change existing jobs.

### Routing Templates (seed data)

| Template | Steps |
|----------|-------|
| Stainless | Machine Process → Wash (Sink) → Passivation (Ultrasonic Cleaner) → Dry (Fan) |
| Steel | Machine Process → Mineral Spirit Wash (Mineral Spirit Reservoir) → Anticorrosion Bath (Zerust Axxanol) → Plating |
| Heat-Treat Steel | Machine Process → Mineral Spirit Wash (Mineral Spirit Reservoir) → Heat Treatment → Plating |
| Aluminium | Machine Process → Wash (Sink) → Dry (Fan) |

Additional templates can be created in Master Data as new routes emerge.

### Step Modification Rules

**At WO creation (job_routing_steps):**
- Steps are copied from the component's part_routing_steps
- Person creating WO can see the routing and confirm it
- To REMOVE a step: request removal → reason required → flagged for compliance approval
- To ADD a step: add directly (no approval needed — adding is additive, not reducing controls)

**On in-progress jobs:**
- Same rules apply: remove = request + compliance approval, add = immediate
- Completed steps cannot be removed

---

## Schema Changes (Complete SQL — run in order)

```sql
-- =====================================================
-- SPRINT 1 SCHEMA MIGRATION
-- Run in Supabase SQL Editor in order
-- =====================================================

-- 1. Routing Templates (reusable starting points)
CREATE TABLE public.routing_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  material_category text,           -- links conceptually to material_types
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.routing_template_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES public.routing_templates(id) ON DELETE CASCADE,
  step_order integer NOT NULL,
  step_name text NOT NULL,
  step_type text DEFAULT 'internal' CHECK (step_type IN ('internal', 'external')),
  default_station text,
  notes text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(template_id, step_order)
);

-- 2. Part Routing Steps (per-component master routing)
CREATE TABLE public.part_routing_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id uuid NOT NULL REFERENCES public.parts(id) ON DELETE CASCADE,
  step_order integer NOT NULL,
  step_name text NOT NULL,
  step_type text DEFAULT 'internal' CHECK (step_type IN ('internal', 'external')),
  default_station text,
  notes text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(part_id, step_order)
);

-- 3. Job Routing Steps (runtime copy per job — filled during production)
CREATE TABLE public.job_routing_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  step_order integer NOT NULL,
  step_name text NOT NULL,
  step_type text DEFAULT 'internal' CHECK (step_type IN ('internal', 'external')),
  station text,

  -- Status tracking
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'complete', 'skipped', 'removal_pending', 'removed')),

  -- Step removal workflow
  removal_requested_by uuid REFERENCES public.profiles(id),
  removal_requested_at timestamptz,
  removal_reason text,
  removal_approved_by uuid REFERENCES public.profiles(id),
  removal_approved_at timestamptz,

  -- Step addition tracking (for steps added after job creation)
  is_added_step boolean DEFAULT false,
  added_by uuid REFERENCES public.profiles(id),
  added_at timestamptz,

  -- Production data (filled by kiosk/finishing station)
  lot_number text,
  quantity integer,
  started_at timestamptz,
  completed_at timestamptz,
  completed_by uuid REFERENCES public.profiles(id),
  operator_initials text,
  notes text,

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(job_id, step_order)
);

-- 4. Stock Quantity on Work Orders (#43)
ALTER TABLE public.work_orders ADD COLUMN stock_quantity integer;

-- 5. Compliance backup flag on Profiles (#6)
ALTER TABLE public.profiles ADD COLUMN can_approve_compliance boolean DEFAULT false;
UPDATE public.profiles SET can_approve_compliance = true WHERE role IN ('compliance', 'admin');

-- 6. Link parts to material type (needed for routing template suggestion)
ALTER TABLE public.parts ADD COLUMN material_type_id uuid REFERENCES public.material_types(id);
ALTER TABLE public.parts ADD COLUMN drawing_revision varchar(20);

-- 7. Seed routing templates
INSERT INTO public.routing_templates (name, description, material_category) VALUES
  ('Stainless', 'Standard stainless steel finishing: wash, passivation, dry', 'Stainless Steel'),
  ('Steel', 'Standard steel finishing: mineral spirit wash, anticorrosion, plating', 'Steel'),
  ('Heat-Treat Steel', 'Steel with heat treatment: mineral spirit wash, heat treat, plating', 'Steel'),
  ('Aluminium', 'Aluminium finishing: wash, dry', 'Aluminium');

-- Stainless steps
INSERT INTO public.routing_template_steps (template_id, step_order, step_name, step_type, default_station)
SELECT id, 1, 'Machine Process', 'internal', NULL FROM public.routing_templates WHERE name = 'Stainless'
UNION ALL
SELECT id, 2, 'Wash', 'internal', 'Sink' FROM public.routing_templates WHERE name = 'Stainless'
UNION ALL
SELECT id, 3, 'Passivation', 'internal', 'Ultrasonic Cleaner' FROM public.routing_templates WHERE name = 'Stainless'
UNION ALL
SELECT id, 4, 'Dry', 'internal', 'Fan' FROM public.routing_templates WHERE name = 'Stainless';

-- Steel steps
INSERT INTO public.routing_template_steps (template_id, step_order, step_name, step_type, default_station)
SELECT id, 1, 'Machine Process', 'internal', NULL FROM public.routing_templates WHERE name = 'Steel'
UNION ALL
SELECT id, 2, 'Mineral Spirit Wash', 'internal', 'Mineral Spirit Reservoir' FROM public.routing_templates WHERE name = 'Steel'
UNION ALL
SELECT id, 3, 'Anticorrosion Bath', 'internal', 'Zerust Axxanol' FROM public.routing_templates WHERE name = 'Steel'
UNION ALL
SELECT id, 4, 'Plating', 'external', NULL FROM public.routing_templates WHERE name = 'Steel';

-- Heat-Treat Steel steps
INSERT INTO public.routing_template_steps (template_id, step_order, step_name, step_type, default_station)
SELECT id, 1, 'Machine Process', 'internal', NULL FROM public.routing_templates WHERE name = 'Heat-Treat Steel'
UNION ALL
SELECT id, 2, 'Mineral Spirit Wash', 'internal', 'Mineral Spirit Reservoir' FROM public.routing_templates WHERE name = 'Heat-Treat Steel'
UNION ALL
SELECT id, 3, 'Heat Treatment', 'external', NULL FROM public.routing_templates WHERE name = 'Heat-Treat Steel'
UNION ALL
SELECT id, 4, 'Plating', 'external', NULL FROM public.routing_templates WHERE name = 'Heat-Treat Steel';

-- Aluminium steps
INSERT INTO public.routing_template_steps (template_id, step_order, step_name, step_type, default_station)
SELECT id, 1, 'Machine Process', 'internal', NULL FROM public.routing_templates WHERE name = 'Aluminium'
UNION ALL
SELECT id, 2, 'Wash', 'internal', 'Sink' FROM public.routing_templates WHERE name = 'Aluminium'
UNION ALL
SELECT id, 3, 'Dry', 'internal', 'Fan' FROM public.routing_templates WHERE name = 'Aluminium';

-- 8. RLS Policies (match existing pattern — allow authenticated users)
ALTER TABLE public.routing_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routing_template_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.part_routing_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_routing_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON public.routing_templates FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Allow all for authenticated users" ON public.routing_template_steps FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Allow all for authenticated users" ON public.part_routing_steps FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Allow all for authenticated users" ON public.job_routing_steps FOR ALL USING (auth.role() = 'authenticated');
```

---

## Updated Build Order

### BATCH A — Quick Wins + Schema (Day 1, ~3 hrs)

**A0. Run all schema migrations**
- Run the full SQL block above in Supabase SQL Editor
- Update docs/schema.sql
- Update DECISIONS.md with new tables

**A1. Action #43 — Stock Quantity Field on WO Form** (S, <1 hr)
- Files: `CreateWorkOrderModal.jsx`, `EditWorkOrderModal.jsx`
- Add `stockQuantity` state, input field after Quantity, include in insert/update
- Label: "Stock Qty" with helper "Qty currently in stock (optional)"

**A2. Action #6 — Backup Compliance Officers** (S, <1 hr)
- Files: `ComplianceReview.jsx`, `TCOReview.jsx`
- Change `isComplianceUser` check to include `profile?.can_approve_compliance === true`
- Set Jody and Tom's `can_approve_compliance = true` in DB

**A3. Action #5 — Passivation Card Conditional** (S, <1 hr)
- File: `ComplianceReview.jsx`
- Filter out passivation doc requirements when `job.component?.requires_passivation !== true`
- Verify Dashboard.jsx job query includes `requires_passivation` on component select

**A4. Action #3 — Move Packing Slip to Post-Mfg** (S, <1 hr)
- DB data update: move `required_at` from `compliance_review` to `manufacturing_complete`
  for the supplier packing slip document type
- Once B1 (#34 doc requirements UI) is built, this becomes manageable through the UI

---

### BATCH B — Master Data: Routing + Doc Requirements (Days 2–4, ~10 hrs)

**B1. Routing Templates UI in Master Data** (M, 2–3 hrs)
- File: `MasterData.jsx` — new "Routing Templates" tab
- List existing templates with their steps
- Create/edit template: name, description, material category
- Manage steps: add, remove, reorder (drag or up/down arrows)
- Step fields: step_name, step_type (internal/external), default_station

**B2. Part Routing in Component/FG Create & Edit** (L, 4–5 hrs)
- File: `MasterData.jsx` — modify part modal
- **On new component creation:**
  - Routing section is MANDATORY (cannot save without at least 1 step)
  - "Load from Template" dropdown — selecting a template pre-fills the routing steps
  - Steps are editable after loading: add, remove, reorder, edit names/stations
  - Material Type dropdown (FK to material_types) — helpful context, also aids template suggestion
  - Drawing Revision field (new `parts.drawing_revision` column)
- **On existing component edit:**
  - Show current routing steps from `part_routing_steps`
  - Fully editable (add/remove/reorder)
  - Changes only affect future jobs, not existing ones
- **On save:**
  ```js
  // Delete existing steps and re-insert (simplest for reorder support)
  await supabase.from('part_routing_steps').delete().eq('part_id', partId)
  for (const step of routingSteps) {
    await supabase.from('part_routing_steps').insert({
      part_id: partId,
      step_order: step.order,
      step_name: step.name,
      step_type: step.type,
      default_station: step.station || null,
      notes: step.notes || null
    })
  }
  ```

**B3. Action #34 — Document Requirements Config** (M, 1–2 hrs)
- File: `MasterData.jsx` — add to part modal below routing section
- Collapsible "Document Requirements" section
- Table: Document Type (dropdown) | Required At (dropdown) | Required (checkbox) | Notes
- Add/remove rows, save alongside part save
- This replaces manual SQL for doc requirement configuration

---

### BATCH C — WO Form: Routing Display + Modification (Days 5–7, ~8 hrs)

**C1. Action #2 — Make-to-Stock for Individual Components** (M, 1–2 hrs)
- File: `CreateWorkOrderModal.jsx`
- When MTS selected, also include `manufactured` parts in the product list
- Handle manufactured part selection: auto-create single job (like finished_good flow)
- Skip `work_order_assemblies` record for manufactured parts

**C2. Action #1 — WO Form Routing Display + Job Creation** (L, 4–5 hrs)
- File: `CreateWorkOrderModal.jsx`

**When a component is selected for a job, display its routing:**
```jsx
{/* Below each job in the "Jobs to Create" section */}
<div className="mt-2 pl-4 border-l-2 border-gray-700">
  <div className="text-xs text-gray-500 mb-1">Routing:</div>
  {componentRouting.map((step, i) => (
    <div key={i} className="flex items-center gap-2 text-sm text-gray-400 py-0.5">
      <span className="text-gray-600">{step.step_order}.</span>
      <span>{step.step_name}</span>
      {step.default_station && (
        <span className="text-gray-600">({step.default_station})</span>
      )}
      {step.step_type === 'external' && (
        <span className="text-xs px-1 bg-orange-900/30 text-orange-400 rounded">External</span>
      )}
    </div>
  ))}
</div>
```

**Fetch routing when component is selected:**
```js
const fetchComponentRouting = async (partId) => {
  const { data } = await supabase
    .from('part_routing_steps')
    .select('*')
    .eq('part_id', partId)
    .eq('is_active', true)
    .order('step_order')
  return data || []
}
```

**On WO submit — copy routing to job_routing_steps:**
```js
// After creating each job...
const { data: partRouting } = await supabase
  .from('part_routing_steps')
  .select('*')
  .eq('part_id', job.componentId)
  .eq('is_active', true)
  .order('step_order')

if (partRouting?.length > 0) {
  const jobSteps = partRouting.map(step => ({
    job_id: newJobId,
    step_order: step.step_order,
    step_name: step.step_name,
    step_type: step.step_type,
    station: step.default_station,
    status: 'pending'
  }))
  await supabase.from('job_routing_steps').insert(jobSteps)
}
```

**C3. Step Removal Request Flow** (M, 2–3 hrs)
- Files: `CreateWorkOrderModal.jsx`, `ComplianceReview.jsx`

**At WO creation — request removal before submit:**
- Each routing step displayed has a "✕ Remove" button
- Clicking it prompts for a reason (required text input)
- Step is visually struck-through but still in the list
- On submit, the step is created in `job_routing_steps` with:
  `status = 'removal_pending'`, `removal_reason`, `removal_requested_by`

**On in-progress jobs — request removal:**
- In the job detail view (or kiosk), a step can be flagged for removal
- Same flow: reason required, status → 'removal_pending'
- Completed steps cannot be flagged for removal

**Adding steps to in-progress jobs:**
- "Add Step" button on job routing view
- Select from a predefined list of step names or enter custom
- Set step_order (inserted at chosen position, others renumbered)
- Saved immediately with `is_added_step = true`, `added_by`, `added_at`
- No approval needed for additions

**Compliance officer approval queue:**
- `ComplianceReview.jsx` — new section: "Pending Routing Changes"
- Query: `job_routing_steps` where `status = 'removal_pending'`
- Show: job number, step name, reason, who requested, when
- Approve → status = 'removed', `removal_approved_by`, `removal_approved_at`
- Reject → status back to 'pending' (with notification/visual indicator)

---

### BATCH D — TCO, Print, Remaining Items (Days 8–10, ~7 hrs)

**D1. Action #30 — TCO Cleanup** (M, 1–2 hrs)
- File: `TCOReview.jsx`
- Verify `isComplianceUser` includes `can_approve_compliance` (done in A2)
- Add TCO notes textarea before approval
- Save `closed_by` and `closed_at` on approval
- Show who completed TCO in completed items section

**D2. Action #4 — Print for Production** (M, 2–3 hrs)
- New file: `src/components/PrintTraveler.jsx`
- Browser print approach with `@media print` CSS
- Reads from `job_routing_steps` + job/WO/component data
- Matches the traveler layout: header block + routing steps table
- "Print for Production" button in ComplianceReview after job approval

**D3. Action #31 — Fishbowl Import (Script Only)** (L, 3–4 hrs)
- Standalone Node.js script (not UI for now)
- Hold on bulk import per Matt's decision
- Build the script and validate mapping, but only import a small test set
- Full import deferred to later when testing is less cumbersome

---

## Updated Daily Schedule

| Day | Items | Est. Hours | Running Total |
|-----|-------|-----------|---------------|
| 1 | A0 (migrations), A1 (#43), A2 (#6), A3 (#5), A4 (#3) | ~3 hrs | 3 hrs |
| 2 | B1 — Routing Templates UI | ~3 hrs | 6 hrs |
| 3–4 | B2 — Part Routing in component create/edit | ~5 hrs | 11 hrs |
| 4 | B3 (#34) — Doc requirements config | ~2 hrs | 13 hrs |
| 5 | C1 (#2) — MTS for components | ~2 hrs | 15 hrs |
| 5–6 | C2 (#1) — WO form routing display + job creation | ~4 hrs | 19 hrs |
| 7 | C3 — Step removal/addition flow | ~3 hrs | 22 hrs |
| 8 | D1 (#30) — TCO cleanup | ~1 hr | 23 hrs |
| 8–9 | D2 (#4) — Print for Production | ~3 hrs | 26 hrs |
| 10 | D3 (#31) — Fishbowl import script | ~3 hrs | 29 hrs |

~29 hours estimated (slightly over the 28 hr target — D3 can flex)

---

## DECISIONS.md Additions After This Sprint

After Sprint 1, add to DECISIONS.md:
- Routing architecture (3-tier copy-down pattern)
- Routing template seed data (4 material types)
- Step modification rules (remove = compliance approval, add = immediate)
- New tables: routing_templates, routing_template_steps, part_routing_steps, job_routing_steps
- New columns: work_orders.stock_quantity, profiles.can_approve_compliance,
  parts.material_type_id, parts.drawing_revision
- Pattern: all per-component config lives in Master Data part modal
  (routing steps, document requirements, machine preferences)

---

## Pre-Sprint Checklist

- [ ] DECISIONS.md added to repo root
- [ ] docs/schema.sql created with current DB dump
- [ ] Run full schema migration SQL in Supabase
- [ ] Git branch created: sprint-1/foundation-work-orders
- [ ] Roger provides Fishbowl export — ON HOLD per Matt (small test set only)
- [ ] Identify Jody and Tom's profile IDs for can_approve_compliance flag
