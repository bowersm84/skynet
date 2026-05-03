# SkyNet Sprint 6 — Implementation Plan
## Post-Assembly Outsourcing & Assembly Routing
### May 3, 2026 | Target: ~2-day build (test branch only, no prod promotion until validated)

---

## Sprint Goal

Add a routing tier for assemblies so finished products can flow through external operations (Paint, Heat Treatment, etc.) after the existing Assembly module step. Mirrors the proven kiosk → finishing → outsourcing pattern but at the WOA level. Most assemblies retain the single-step `Assemble` route (no behavior change); routes with external steps activate the new outsource flow.

**Test-only until Matt validates.** No prod promotion. Schema changes already applied to test on May 3 (Batch A).

---

## Scope Decisions (locked — see `Decisions.md` S6 append for the full record)

| # | Decision | Notes |
|---|----------|-------|
| 1 | Assembly routing reuses `part_routing_steps` | `part_id` is part-type-agnostic; assembly/FG parts get rows |
| 2 | Per-WOA runtime in `work_order_assembly_routing_steps` | Mirrors `job_routing_steps` shape exactly |
| 3 | Polymorphic `outbound_sends` | `source_type` constrained to `('finishing_send','work_order_assembly')` |
| 4 | Batch sending lives at the Assembly step | Jody clicks "Send Batch to Outsource" — mirrors kiosk → finishing |
| 5 | NO post-assembly compliance gate | Direct: Assembly Complete → `ready_for_outsource` or `pending_tco` |
| 6 | ALN: manual entry from logbook | Auto-generation deferred to a later phase |
| 7 | Vendor return lot: manual entry | Auto-generation deferred |
| 8 | Templates split: component vs assembly | New `routing_templates.template_type` column, toggle in Armory |
| 9 | Backfill: standard `Assemble` step seeded on every existing assembly/FG part | Done in Batch A |
| 10 | Backfill: in-flight WOAs get pending `Assemble` step | Done in Batch A |

---

## Action Items

| # | Action Item | Batch | Effort |
|---|-------------|-------|--------|
| — | Schema migration + backfills + RLS + indexes | A ✅ | DONE |
| 1 | RoutingTemplatesTab — Component/Assembly toggle | B | 0.25d |
| 2 | RoutingTemplatesTab — `template_type` write on save | B | 0.1d |
| 3 | Armory Products edit modal — assembly routing section (mirrors components) | B | 0.4d |
| 4 | CreateWorkOrderModal — copy assembly route to `work_order_assembly_routing_steps` on submit | B | 0.2d |
| 5 | CreateWorkOrderModal — ad-hoc external step add on assembly route inline display | B | 0.3d |
| 6 | Assembly module — ALN entry field on Start Assembly modal | C | 0.15d |
| 7 | Assembly module — "Send Batch to Outsource" button + modal | C | 0.4d |
| 8 | Assembly module — Complete Assembly branch logic (auto-send remaining + status flip) | C | 0.3d |
| 9 | OutsourcedJobs — extend query to include `source_type='work_order_assembly'` rows | D | 0.4d |
| 10 | OutsourcedJobs — Assembly tag + per-WOA grouping + ALN display | D | 0.3d |
| 11 | WO Lookup — dynamic per-WOA status line ("Out for Paint · Vendor") | D | 0.2d |
| 12 | Job Traveler — `buildAssemblyTravelerHTML` for assembly outsourcing | E | 0.25d |
| 13 | Test plan + S6 test script docx | E | 0.25d |

**Total: ~3.5 days of focused work** (Batch A already complete, so ~3 days remaining).

---

## Batch A: Schema + Backfills (DONE)

Already executed in test on May 3, 2026. Verification confirmed:
- `work_order_assemblies.status` extended (7 values total)
- `routing_templates.template_type` column added with CHECK
- 3 assembly templates seeded with steps
- `parts_missing_routing` = 0 / `woas_missing_routing` = 0 / `legacy_outbound_sends_unmigrated` = 0
- 4 RLS policies on `work_order_assembly_routing_steps`

Migration SQL is preserved in chat history (S6 Batch A gap-fill block, May 3 session).

---

## Batch B: Master Data + WO Creation (Day 1)

### B1. RoutingTemplatesTab — Component/Assembly Toggle
**File:** `src/components/RoutingTemplatesTab.jsx`

**Add at top of component, above the templates list:**
```jsx
const [templateTypeFilter, setTemplateTypeFilter] = useState('component')
```

**Add toggle UI before templates list:**
```jsx
<div className="flex gap-2 mb-4">
  <button
    onClick={() => setTemplateTypeFilter('component')}
    className={`px-4 py-2 rounded text-sm font-medium ${
      templateTypeFilter === 'component'
        ? 'bg-blue-600 text-white'
        : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
    }`}
  >
    Component Routes
  </button>
  <button
    onClick={() => setTemplateTypeFilter('assembly')}
    className={`px-4 py-2 rounded text-sm font-medium ${
      templateTypeFilter === 'assembly'
        ? 'bg-blue-600 text-white'
        : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
    }`}
  >
    Assembly Routes
  </button>
</div>
```

**Modify `fetchTemplates` to filter by selected type:**
```jsx
const { data, error } = await supabase
  .from('routing_templates')
  .select(`*, routing_template_steps(*)`)
  .eq('is_active', true)
  .eq('template_type', templateTypeFilter)
  .order('name')
```

**Update `useEffect` dependency:**
```jsx
useEffect(() => {
  fetchTemplates()
}, [fetchTemplates, templateTypeFilter])
```

Add `templateTypeFilter` to the `useCallback` deps for `fetchTemplates`.

### B2. RoutingTemplatesTab — Save with `template_type`
**File:** `src/components/RoutingTemplatesTab.jsx`

In `handleSave`, both the INSERT path and UPDATE path must include `template_type`. Replace the existing `.update({...})` and `.insert({...})` payloads:

```jsx
// In the update branch (editingTemplate exists):
.update({
  name: form.name.trim(),
  description: form.description.trim() || null,
  material_category: form.material_category.trim() || null,
  template_type: templateTypeFilter,  // ← preserve current view's type
  updated_at: new Date().toISOString()
})

// In the insert branch (new template):
.insert({
  name: form.name.trim(),
  description: form.description.trim() || null,
  material_category: form.material_category.trim() || null,
  template_type: templateTypeFilter  // ← stamp current view's type
})
```

### B3. Armory Products — Assembly Routing Section
**File:** `src/pages/Armory.jsx`

The Products tab edit modal currently lacks a routing section for assemblies. Mirror the existing component routing pattern.

**Find the part edit modal block** (search for `part_type === 'manufactured'` in the routing render condition).

**Replace the routing section render condition** to include assemblies and FGs:
```jsx
{(part.part_type === 'manufactured' ||
  part.part_type === 'assembly' ||
  part.part_type === 'finished_good') && (
  <div className="mt-4">
    <div className="flex justify-between items-center mb-2">
      <h4 className="text-sm font-medium text-gray-300">Routing Steps</h4>
      <select
        value={selectedTemplateId}
        onChange={(e) => loadFromTemplate(e.target.value)}
        className="..."
      >
        <option value="">— Load from template —</option>
        {/* Filter templates by part type */}
        {routingTemplates
          .filter(t =>
            (part.part_type === 'manufactured' && t.template_type === 'component') ||
            ((part.part_type === 'assembly' || part.part_type === 'finished_good')
              && t.template_type === 'assembly')
          )
          .map(t => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
      </select>
    </div>
    {/* existing step list / drag-drop / add-step UI unchanged */}
  </div>
)}
```

**On save**, the existing `part_routing_steps` insert logic already works — `part_id` is the assembly part's ID. No INSERT changes needed if the form already handles steps array correctly.

**Validation:** First step for assembly/FG must be named `Assemble` and `step_type='internal'`. Add a check in the save handler:
```jsx
if ((part.part_type === 'assembly' || part.part_type === 'finished_good')) {
  if (!routingSteps[0] || routingSteps[0].step_name !== 'Assemble' || routingSteps[0].step_type !== 'internal') {
    alert('Assembly routes must begin with an internal "Assemble" step.')
    return
  }
}
```

### B4. CreateWorkOrderModal — Copy WOA Routing
**File:** `src/components/CreateWorkOrderModal.jsx`

**Find the WOA insert block** (around line 553 in current file, after `.from('work_order_assemblies').insert(...)`).

**After the WOA is created and `woaId` is set, add this routing copy block:**
```jsx
// Copy assembly part_routing_steps → work_order_assembly_routing_steps
if (woaId) {
  const { data: assemblyRouting } = await supabase
    .from('part_routing_steps')
    .select('*')
    .eq('part_id', assembly.assemblyId)  // the assembly part_id
    .eq('is_active', true)
    .order('step_order')

  const woaAdditions = assemblyRoutingAdditions[assembly.assemblyId] || []
  if (assemblyRouting?.length > 0 || woaAdditions.length > 0) {
    const woaSteps = (assemblyRouting || []).map(step => ({
      work_order_assembly_id: woaId,
      step_order: step.step_order,
      step_name: step.step_name,
      step_type: step.step_type,
      station: step.default_station,
      status: 'pending'
    }))
    const maxOrder = assemblyRouting?.length > 0
      ? Math.max(...assemblyRouting.map(s => s.step_order))
      : 0
    woaAdditions.forEach((added, i) => {
      woaSteps.push({
        work_order_assembly_id: woaId,
        step_order: maxOrder + i + 1,
        step_name: added.stepName,
        step_type: added.stepType,
        station: null,
        status: 'pending',
        is_added_step: true,
        added_by: profile?.id || null,
        added_at: new Date().toISOString()
      })
    })
    const { error: stepsError } = await supabase
      .from('work_order_assembly_routing_steps')
      .insert(woaSteps)
    if (stepsError) {
      console.error('Error creating WOA routing steps:', stepsError)
    }
  }
}
```

### B5. CreateWorkOrderModal — Ad-Hoc Assembly External Step
**File:** `src/components/CreateWorkOrderModal.jsx`

**Add new state at top of component:**
```jsx
const [assemblyRoutingAdditions, setAssemblyRoutingAdditions] = useState({})
// shape: { [assemblyPartId]: [{ stepName, stepType }] }
```

**Add fetcher for assembly routing display** (mirrors existing component routing fetcher):
```jsx
const fetchAssemblyRouting = async (assemblyPartId) => {
  const { data } = await supabase
    .from('part_routing_steps')
    .select('*')
    .eq('part_id', assemblyPartId)
    .eq('is_active', true)
    .order('step_order')
  return data || []
}
```

**Below each assembly card in the "Jobs to Create" section**, add a routing display + add-step button mirroring the component routing display block. The button opens a small inline form for `stepName` + `stepType` (default `external`); on submit, append to `assemblyRoutingAdditions[assemblyPartId]`.

UI pattern: same as the existing component external-step add. Visually distinguish with cyan border to indicate "assembly route" vs blue/gray "component route."

---

## Batch C: Assembly Module (Day 2 AM)

### C1. ALN Entry on Start Assembly
**File:** `src/components/Assembly.jsx`

**Extend `startForm` state:**
```jsx
const [startForm, setStartForm] = useState({
  station: '1',
  assembler: '1',
  notes: '',
  assembly_lot_number: ''  // NEW
})
```

**Add ALN input to Start Assembly modal** (just above the notes textarea):
```jsx
<div className="mb-4">
  <label className="block text-sm font-medium text-gray-300 mb-1">
    Assembly Lot Number (ALN)
  </label>
  <input
    type="text"
    value={startForm.assembly_lot_number}
    onChange={(e) => setStartForm({ ...startForm, assembly_lot_number: e.target.value })}
    placeholder="Enter ALN from logbook"
    className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-white"
  />
  <p className="text-xs text-gray-500 mt-1">
    Manual entry from the assembly logbook. Leave blank if not yet assigned.
  </p>
</div>
```

**Update `handleStartAssembly` to write ALN columns:**
```jsx
.update({
  status: 'in_progress',
  station_number: parseInt(startForm.station),
  assembler_number: parseInt(startForm.assembler),
  assembly_started_at: new Date().toISOString(),
  assembly_started_by: profile?.id || null,
  assembly_notes: startForm.notes || null,
  assembly_lot_number: startForm.assembly_lot_number?.trim() || null,
  assembly_lot_entered_by: startForm.assembly_lot_number?.trim() ? (profile?.id || null) : null,
  assembly_lot_entered_at: startForm.assembly_lot_number?.trim() ? new Date().toISOString() : null
})
```

**Also update first WOA routing step (`Assemble`) to `in_progress`:**
```jsx
await supabase
  .from('work_order_assembly_routing_steps')
  .update({
    status: 'in_progress',
    started_at: new Date().toISOString()
  })
  .eq('work_order_assembly_id', startItem.id)
  .eq('step_order', 1)
```

### C2. "Send Batch to Outsource" Button
**File:** `src/components/Assembly.jsx`

**Add new state:**
```jsx
const [showSendBatchModal, setShowSendBatchModal] = useState(false)
const [sendBatchItem, setSendBatchItem] = useState(null)
const [sendBatchForm, setSendBatchForm] = useState({ quantity: 0 })
const [woaExternalStep, setWoaExternalStep] = useState(null)
```

**Detect external step on in-progress WOAs.** When loading assemblies, also fetch the WOA's routing steps:
```jsx
work_order_assembly_routing_steps (
  id, step_order, step_name, step_type, status
)
```

**Helper to find next pending external step:**
```jsx
const findNextExternalStep = (woa) => {
  const steps = (woa.work_order_assembly_routing_steps || [])
    .sort((a, b) => a.step_order - b.step_order)
  return steps.find(s => s.step_type === 'external' && s.status === 'pending')
}
```

**On in-progress assembly cards**, render a "Send Batch to Outsource" button when `findNextExternalStep(woa)` returns truthy:
```jsx
{findNextExternalStep(woa) && (
  <button
    onClick={() => openSendBatchModal(woa)}
    className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded text-sm flex items-center gap-1"
  >
    <Truck className="w-4 h-4" />
    Send Batch to Outsource
  </button>
)}
```

**`openSendBatchModal`:**
```jsx
const openSendBatchModal = (woa) => {
  const externalStep = findNextExternalStep(woa)
  if (!externalStep) return
  const sentSoFar = woa.outbound_sends_total_qty || 0  // computed client-side
  const remainingQty = (woa.quantity || 0) - sentSoFar
  setSendBatchItem(woa)
  setWoaExternalStep(externalStep)
  setSendBatchForm({ quantity: remainingQty })
  setShowSendBatchModal(true)
}
```

**`handleSendBatch`:**
```jsx
const handleSendBatch = async () => {
  if (!sendBatchItem || !woaExternalStep) return
  setActionLoading('send_batch')
  try {
    const qty = parseInt(sendBatchForm.quantity)
    if (!qty || qty <= 0) {
      alert('Quantity must be greater than zero.')
      return
    }
    const operationType = deriveOperationType(woaExternalStep.step_name)
    const { error } = await supabase
      .from('outbound_sends')
      .insert({
        source_type: 'work_order_assembly',
        source_id: sendBatchItem.id,
        routing_step_id: woaExternalStep.id,
        operation_type: operationType,
        quantity: qty,
        sent_by: profile?.id || null
        // sent_at stays NULL — Ashley fills this in
        // vendor_name stays NULL — Ashley fills this in
      })
    if (error) throw error
    setShowSendBatchModal(false)
    await loadAssemblies()
    if (onUpdate) onUpdate()
  } catch (err) {
    console.error('Error sending batch to outsource:', err)
    alert('Failed to send batch: ' + err.message)
  } finally {
    setActionLoading(null)
  }
}

const deriveOperationType = (stepName) => {
  const s = (stepName || '').toLowerCase()
  if (s.includes('paint')) return 'painting'
  if (s.includes('prim'))  return 'priming'
  if (s.includes('heat'))  return 'heat_treat'
  if (s.includes('plat'))  return 'cad_plating'
  if (s.includes('oxide')) return 'black_oxide'
  return 'other'
}
```

**Modal UI:** Quantity input (defaults to remaining), shows the routing step name and a "Will be queued in OutsourcedJobs for Ashley" helper line.

### C3. Complete Assembly Branch Logic
**File:** `src/components/Assembly.jsx`

**Modify `handleCompleteAssembly` to:**
1. Mark the `Assemble` routing step complete on `work_order_assembly_routing_steps`
2. Determine if external steps remain
3. Auto-create `outbound_sends` row for any unsent quantity (if external step exists)
4. Set WOA status to `ready_for_outsource` OR `pending_tco` accordingly
5. Update jobs status accordingly

Replace the existing handler body with:
```jsx
const handleCompleteAssembly = async () => {
  if (!completeItem) return
  setActionLoading('complete')

  try {
    const completedAt = new Date(`${completeForm.end_date}T${completeForm.end_time}:00`).toISOString()
    let finalNotes = completeItem.assembly_notes || ''
    if (completeForm.notes) {
      if (finalNotes) finalNotes += '\n---\n'
      finalNotes += `Completion: ${completeForm.notes}`
    }

    // 1. Mark Assemble step complete
    await supabase
      .from('work_order_assembly_routing_steps')
      .update({
        status: 'complete',
        completed_at: completedAt,
        completed_by: profile?.id || null,
        quantity: completeForm.good_quantity,
        lot_number: completeItem.assembly_lot_number || null
      })
      .eq('work_order_assembly_id', completeItem.id)
      .eq('step_order', 1)

    // 2. Determine if external steps remain
    const { data: routingSteps } = await supabase
      .from('work_order_assembly_routing_steps')
      .select('id, step_order, step_name, step_type, status')
      .eq('work_order_assembly_id', completeItem.id)
      .order('step_order')

    const nextExternal = (routingSteps || [])
      .find(s => s.step_type === 'external' && s.status === 'pending')

    // 3. Auto-send remaining quantity to outsource if external step exists
    if (nextExternal) {
      const { data: existingSends } = await supabase
        .from('outbound_sends')
        .select('quantity')
        .eq('source_type', 'work_order_assembly')
        .eq('source_id', completeItem.id)
        .eq('routing_step_id', nextExternal.id)

      const sentSoFar = (existingSends || []).reduce((sum, s) => sum + (s.quantity || 0), 0)
      const remaining = (completeForm.good_quantity || 0) - sentSoFar

      if (remaining > 0) {
        await supabase
          .from('outbound_sends')
          .insert({
            source_type: 'work_order_assembly',
            source_id: completeItem.id,
            routing_step_id: nextExternal.id,
            operation_type: deriveOperationType(nextExternal.step_name),
            quantity: remaining,
            sent_by: profile?.id || null
          })
      }
    }

    // 4. Update WOA status
    const newWoaStatus = nextExternal ? 'ready_for_outsource' : 'pending_tco'
    await supabase
      .from('work_order_assemblies')
      .update({
        status: newWoaStatus,
        assembly_completed_at: completedAt,
        assembly_completed_by: profile?.id || null,
        good_quantity: completeForm.good_quantity,
        bad_quantity: completeForm.bad_quantity,
        assembly_notes: finalNotes || null
      })
      .eq('id', completeItem.id)

    // 5. Job status flip — only when no external step (avoid premature pending_tco)
    if (!nextExternal) {
      await supabase
        .from('jobs')
        .update({ status: 'pending_tco', updated_at: new Date().toISOString() })
        .eq('work_order_id', completeItem.work_order_id)
        .in('status', ['ready_for_assembly', 'in_assembly'])
    }

    setShowCompleteModal(false)
    setCompleteItem(null)
    setCompleteForm({ end_date: '', end_time: '', good_quantity: 0, bad_quantity: 0, notes: '' })
    await loadAssemblies()
    if (onUpdate) onUpdate()
  } catch (err) {
    console.error('Error completing assembly:', err)
    alert('Failed to complete assembly: ' + err.message)
  } finally {
    setActionLoading(null)
  }
}
```

---

## Batch D: OutsourcedJobs + WO Lookup (Day 2 PM)

### D1. OutsourcedJobs — Polymorphic Query
**File:** `src/components/OutsourcedJobs.jsx`

The current module reads `outbound_sends` filtered by `finishing_send_id IS NOT NULL` (implicitly via the join). Extend to handle both source types.

**Replace the main fetch in `loadOutsourcedData`** to query `outbound_sends` directly with both sources:
```jsx
const { data: sends, error } = await supabase
  .from('outbound_sends')
  .select('*')
  .in('source_type', ['finishing_send', 'work_order_assembly'])
  .order('created_at', { ascending: false })
```

**Then split by source for hydration:**
```jsx
const finishingSendIds = sends
  .filter(s => s.source_type === 'finishing_send')
  .map(s => s.source_id)

const woaIds = sends
  .filter(s => s.source_type === 'work_order_assembly')
  .map(s => s.source_id)

// Hydrate finishing batches (existing pattern)
const { data: finishingSends } = finishingSendIds.length > 0
  ? await supabase
      .from('finishing_sends')
      .select('*, jobs(*, parts(*), work_orders(*))')
      .in('id', finishingSendIds)
  : { data: [] }

// Hydrate WOAs (new)
const { data: woas } = woaIds.length > 0
  ? await supabase
      .from('work_order_assemblies')
      .select(`
        id, work_order_id, quantity, assembly_lot_number, status,
        assembly:parts!work_order_assemblies_assembly_id_fkey (id, part_number, description),
        work_orders (id, wo_number, customer, due_date, priority),
        work_order_assembly_routing_steps (id, step_order, step_name, step_type, status)
      `)
      .in('id', woaIds)
  : { data: [] }

// Build a unified records array — each record carries source info, hydrated parent, routing step
const records = sends.map(send => {
  if (send.source_type === 'finishing_send') {
    const fs = finishingSends.find(f => f.id === send.source_id)
    return {
      ...send,
      sourceKind: 'finishing',
      finishingSend: fs,
      parent: fs?.jobs,
      partNumber: fs?.jobs?.parts?.part_number,
      woNumber: fs?.jobs?.work_orders?.wo_number,
      lotForDisplay: fs?.production_lot_number || fs?.finishing_lot_number
    }
  } else {
    const woa = woas.find(w => w.id === send.source_id)
    const step = (woa?.work_order_assembly_routing_steps || [])
      .find(s => s.id === send.routing_step_id)
    return {
      ...send,
      sourceKind: 'assembly',
      woa,
      parent: woa,
      partNumber: woa?.assembly?.part_number,
      woNumber: woa?.work_orders?.wo_number,
      lotForDisplay: woa?.assembly_lot_number,
      stepName: step?.step_name
    }
  }
})
```

**Bucket records into Ready / At Vendor / Returned** using the existing date-based logic on `sent_at` and `returned_at`.

### D2. Assembly Tag + Per-WOA Grouping
**File:** `src/components/OutsourcedJobs.jsx`

**Add a visual distinguisher** on each card. Cyan badge for finishing batches (existing Batch A/B/C pill), purple badge for assembly batches. In the card render:
```jsx
{record.sourceKind === 'assembly' && (
  <span className="px-2 py-0.5 text-xs bg-purple-900/30 text-purple-300 border border-purple-800 rounded">
    Assembly
  </span>
)}
{record.sourceKind === 'finishing' && (
  <span className="px-2 py-0.5 text-xs bg-cyan-900/30 text-cyan-300 border border-cyan-800 rounded">
    Component · Batch {batchLetter}
  </span>
)}
```

**ALN display** for assembly cards: show `assembly_lot_number` where finishing cards show PLN/FLN. If null, show `(ALN pending)` in muted text.

**Step name display:** finishing cards already show "Heat Treat" / "Plating" derived from operation_type. Assembly cards show `record.stepName` directly (e.g., "Paint", "Heat Treatment").

**Per-WOA grouping (optional UI improvement):** group multiple sends for the same WOA under a single header card showing WO# + assembly part + total qty across batches, with each individual batch as a row. Mirrors the per-job grouping the finishing side already does.

### D3. Send-Out + Return Logic — Source-Aware
**File:** `src/components/OutsourcedJobs.jsx`

The existing send-out form (vendor + sent_at + expected_return_at) and return form (returned_at + vendor_lot_number + quantity_returned) work as-is for assembly sends — they update fields on `outbound_sends` directly.

**One status transition added:** when an assembly send moves to `at_external_vendor` (sent_at populated), update WOA status if first send of this WOA:
```jsx
if (record.sourceKind === 'assembly') {
  // After the outbound_sends update, check if any other sends for this WOA are still "ready"
  const { data: otherSends } = await supabase
    .from('outbound_sends')
    .select('id, sent_at')
    .eq('source_type', 'work_order_assembly')
    .eq('source_id', record.source_id)

  const allInTransit = (otherSends || []).every(s => s.sent_at !== null)
  if (allInTransit) {
    await supabase
      .from('work_order_assemblies')
      .update({ status: 'at_external_vendor' })
      .eq('id', record.source_id)
  }
}
```

**On return logging:** when ALL sends for a WOA's external steps are `returned_at IS NOT NULL` AND no further pending external steps remain, flip WOA to `pending_tco` and jobs to `pending_tco`:
```jsx
if (record.sourceKind === 'assembly') {
  // After updating returned_at on this row, check completion
  const { data: woaSends } = await supabase
    .from('outbound_sends')
    .select('id, returned_at, routing_step_id')
    .eq('source_type', 'work_order_assembly')
    .eq('source_id', record.source_id)

  const allReturned = (woaSends || []).every(s => s.returned_at !== null)

  if (allReturned) {
    // Mark the routing step complete
    await supabase
      .from('work_order_assembly_routing_steps')
      .update({ status: 'complete', completed_at: new Date().toISOString() })
      .eq('id', record.routing_step_id)

    // Check if any pending external steps remain on this WOA
    const { data: woaSteps } = await supabase
      .from('work_order_assembly_routing_steps')
      .select('id, step_type, status')
      .eq('work_order_assembly_id', record.source_id)

    const morePending = (woaSteps || [])
      .some(s => s.step_type === 'external' && s.status === 'pending')

    if (!morePending) {
      // All external steps done — flip to TCO
      await supabase
        .from('work_order_assemblies')
        .update({ status: 'pending_tco' })
        .eq('id', record.source_id)

      // Find WO and flip its jobs to pending_tco
      const { data: woa } = await supabase
        .from('work_order_assemblies')
        .select('work_order_id')
        .eq('id', record.source_id)
        .single()

      if (woa?.work_order_id) {
        await supabase
          .from('jobs')
          .update({ status: 'pending_tco', updated_at: new Date().toISOString() })
          .eq('work_order_id', woa.work_order_id)
          .in('status', ['ready_for_assembly', 'in_assembly'])
      }
    }
  }
}
```

### D4. WO Lookup — Per-WOA Status Line
**File:** `src/pages/Mainframe.jsx` (or wherever WO Lookup result cards render — search for `OutsourcingStatus` or per-job status logic)

Add a derived per-WOA status line on each WOA result row:

| WOA Status | Status Line Display | Color |
|---|---|---|
| `pending` / `in_progress` | (don't render — handled by existing job-level display) | — |
| `ready_for_outsource` | `Ready for Outsource · {step_name}` | amber |
| `at_external_vendor` | `Out for {step_name} · {vendor_name}` | blue |
| `pending_tco` | `Returned · Pending TCO` | emerald |
| `complete` | (handled by WO-level complete) | — |

```jsx
const renderWoaStatus = (woa) => {
  const sends = woa.outbound_sends || []
  const activeSend = sends.find(s => s.sent_at && !s.returned_at)
  const stepName = activeSend?.routing_step?.step_name || 'External Step'

  switch (woa.status) {
    case 'ready_for_outsource':
      return <span className="text-amber-400">Ready for Outsource · {stepName}</span>
    case 'at_external_vendor':
      return <span className="text-blue-400">
        Out for {stepName} · {activeSend?.vendor_name || 'Vendor'}
      </span>
    case 'pending_tco':
      return <span className="text-emerald-400">Returned · Pending TCO</span>
    default:
      return null
  }
}
```

---

## Batch E: Job Traveler + Test Script (Day 3)

### E1. Assembly Traveler Builder
**File:** `src/lib/traveler.js`

Add a new exported function `buildAssemblyTravelerHTML(travelerData)` mirroring `buildTravelerHTML` shape. Inputs:
```js
{
  woa: { id, assembly_lot_number, quantity, work_order, assembly: { part_number, description } },
  routingSteps: [...],  // work_order_assembly_routing_steps sorted by step_order
  outboundSends: [...]   // outbound_sends for this WOA
}
```

Output: HTML with sections:
- **Header:** WO #, customer, assembly part, ALN, qty, completion date
- **Routing Steps Table:** step_order | step_name | type | status | completed_at | qty
- **Outbound Sends Table:** routing step | vendor | qty sent | sent date | returned date | vendor lot | qty returned

Reuse the same CSS variables and layout patterns from `buildTravelerHTML`.

**Where to print from:**
- Assembly module — new "Print Assembly Traveler" button on each WOA card with `assembly_lot_number IS NOT NULL`
- OutsourcedJobs module — same button on each Assembly card
- WO Lookup — additional document under the WO's documents dropdown

### E2. Test Script
**File:** `Docs/S6_Test_Script.docx` — produce as a .docx using the docx skill, matching the S3 Batch D style:
- SkyNet blue accent header
- Per-test-case tables (Role/Steps/Expected/Result + checkbox)
- Test scenarios:
  1. Create a Painted Assembly route, edit a product to use it
  2. Create WO with that assembly, verify WOA routing copied
  3. Add ad-hoc Heat Treat step on a different assembly during WO creation
  4. Start assembly with ALN, verify ALN persisted
  5. Send partial batch to outsource (50 of 200), verify outbound_sends row created with NULL sent_at
  6. Complete assembly (150 remaining), verify auto-send + WOA → ready_for_outsource
  7. Ashley logs send-out for first batch, verify WOA → at_external_vendor (only when all sends shipped)
  8. Ashley logs returns; verify WOA → pending_tco when all returned
  9. WO Lookup shows correct per-WOA status line throughout
  10. TCO closeout flips WO to complete
  11. Backward compatibility: WOA with Standard Assembly route (Assemble only) flows in_assembly → pending_tco directly without touching outsource

---

## Sprint Closeout

### Definition of Done
- [ ] All 13 action items complete + smoke-tested
- [ ] Existing assembly flow (Standard Assembly route) regression-tested — no behavior change
- [ ] Test script executed end-to-end with at least one Painted Assembly + one Heat-Treated Assembly path
- [ ] Decisions.md updated with the S6 append (already drafted)
- [ ] Spec bumped to v2.7 with new sections: Assembly Routing, ALN, Post-Assembly Outsourcing
- [ ] No prod promotion until Matt + Roger validate the full path in test

### What's deferred to Phase 2 / later sprints
- ALN auto-generation (currently manual entry from logbook)
- Vendor return lot auto-generation (currently manual entry)
- Polymorphic outbound_sends extension to `'purchased_part'` source type (item #104, Phase 3)
- Post-paint compliance gate (TCO covers it for now)
- Per-WOA grouped UI in OutsourcedJobs (D2 step is optional polish)

### CC Prompt Pattern Reminder
Each batch above is structured for surgical CC prompts. Pattern:
1. Tell CC to read `Docs/Decisions.md` and `Docs/S6_Implementation_Plan.md` first
2. Reference the exact action item number (e.g., "implement S6 B4")
3. Provide the exact files + line targets
4. Validate with the SQL verification queries from Batch A after each batch
5. Smoke test in test environment before moving to next batch

---

*— End of S6 Implementation Plan —*
