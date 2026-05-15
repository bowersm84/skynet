import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import {
  X, Loader2, AlertTriangle, CheckCircle, RotateCcw
} from 'lucide-react'

const PRIORITY_RANK = { critical: 0, high: 1, normal: 2, low: 3 }

function formatDateOnly(dateStr) {
  if (!dateStr) return '—'
  const [y, m, d] = String(dateStr).split('-').map(Number)
  if (!y || !m || !d) return '—'
  const localDate = new Date(y, m - 1, d)
  return localDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function priorityPill(priority) {
  const styles = {
    critical: 'bg-red-950/60 text-red-300 border-red-700',
    high: 'bg-orange-950/60 text-orange-300 border-orange-700',
    normal: 'bg-gray-800 text-gray-300 border-gray-600',
    low: 'bg-gray-900 text-gray-500 border-gray-700',
  }
  const cls = styles[priority] || styles.normal
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] border ${cls}`}>
      {priority || 'normal'}
    </span>
  )
}

/**
 * Unified Allocation & Resolution modal. Replaces the three one-click
 * card handlers. April manually allocates produced qty to each CO row,
 * picks an outcome, and saves once.
 */
export default function AllocationResolutionModal({
  isOpen,
  shortfall,
  workOrder,
  job,
  coRows,
  producedQuantity,
  jobQuantity,
  initialResolution,
  profile,
  onClose,
  onSuccess,
}) {
  // Per-CO allocation inputs, keyed by allocation_id. Empty string by
  // default — no auto-fill, no auto-distribute. April types each value.
  const [allocs, setAllocs] = useState({})
  const [resolution, setResolution] = useState(initialResolution || 'accept_short')

  // Re-queue sub-fields
  const [requeueQty, setRequeueQty] = useState('')
  const [requeueNotes, setRequeueNotes] = useState('')

  // Accept-short reason (required) — replaces the old separate
  // Cancel Shortfall option. The outcome is the same; the reason
  // captures why the remaining qty is not being remade.
  const [acceptReason, setAcceptReason] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  // Job-level scope: target = this job's quantity, produced = what
  // came off the machine for this job (good_pieces or post_mfg_good_qty).
  const target = (jobQuantity ?? shortfall?.job_quantity) || 0
  const produced = producedQuantity ?? shortfall?.produced_quantity ?? 0
  const gap = Math.max(0, target - produced)

  // Sort coRows: due_date ASC (nulls last) then priority rank
  const sortedRows = useMemo(() => {
    return [...(coRows || [])].sort((a, b) => {
      const aDue = a.due_date || '9999-12-31'
      const bDue = b.due_date || '9999-12-31'
      if (aDue !== bDue) return aDue.localeCompare(bDue)
      return (PRIORITY_RANK[a.priority] ?? 99) - (PRIORITY_RANK[b.priority] ?? 99)
    })
  }, [coRows])

  // Reset form whenever the modal is (re)opened with new context.
  useEffect(() => {
    if (!isOpen) return
    const initial = {}
    for (const r of (coRows || [])) initial[r.allocation_id] = ''
    setAllocs(initial)
    setResolution(initialResolution || 'accept_short')
    setRequeueQty(String(gap || ''))
    setRequeueNotes('')
    setAcceptReason('')
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, shortfall?.id])

  // Parse helper — empty string treated as 0 for sum, but we still
  // disable save when any field is empty? Spec says "input must be 0
  // or a positive integer". Empty is allowed (treated as 0).
  const parseAlloc = (val) => {
    if (val === '' || val == null) return 0
    const n = parseInt(val, 10)
    return Number.isFinite(n) ? n : NaN
  }

  // Per-row validation
  const rowErrors = useMemo(() => {
    const errs = {}
    for (const r of sortedRows) {
      const raw = allocs[r.allocation_id]
      const n = parseAlloc(raw)
      if (Number.isNaN(n)) {
        errs[r.allocation_id] = 'Enter a number'
        continue
      }
      if (n < 0) {
        errs[r.allocation_id] = 'Must be ≥ 0'
        continue
      }
      if (!Number.isInteger(n)) {
        errs[r.allocation_id] = 'Whole numbers only'
        continue
      }
      // Per-row cap: cannot push fulfilled past ordered
      const ceiling = Math.max(0, (r.ordered || 0) - (r.fulfilled || 0))
      if (n > ceiling) {
        errs[r.allocation_id] = `Exceeds remaining (${ceiling})`
      }
    }
    return errs
  }, [allocs, sortedRows])

  const totalAllocated = useMemo(() => {
    return sortedRows.reduce((sum, r) => {
      const n = parseAlloc(allocs[r.allocation_id])
      return sum + (Number.isFinite(n) ? n : 0)
    }, 0)
  }, [allocs, sortedRows])

  const overAllocated = totalAllocated > produced
  const toStock = produced - totalAllocated

  const hasRowErrors = Object.keys(rowErrors).length > 0

  // Resolution-specific required fields
  const requeueQtyNumber = parseInt(requeueQty, 10)
  const requeueQtyValid = Number.isFinite(requeueQtyNumber) && requeueQtyNumber > 0
  const acceptReasonValid = acceptReason.trim().length > 0

  const canSave =
    !submitting &&
    !hasRowErrors &&
    !overAllocated &&
    ((resolution === 'accept_short' && acceptReasonValid) ||
      (resolution === 'requeue' && requeueQtyValid))

  const handleSave = async () => {
    setSubmitting(true)
    setError(null)
    const now = new Date().toISOString()
    const allocationEvents = []

    try {
      // (1) Per-CO row updates: fulfillment + allocation deactivation
      for (const r of sortedRows) {
        const allocated = parseAlloc(allocs[r.allocation_id]) || 0
        const existingAllocated = r.allocated || 0
        const newFulfilled = (r.fulfilled || 0) + allocated
        const ordered = r.ordered || 0

        if (allocated > 0) {
          const linePatch = {
            quantity_fulfilled: newFulfilled,
          }
          if (newFulfilled >= ordered) {
            linePatch.status = 'complete'
            linePatch.fulfilled_at = now
            linePatch.fulfilled_by = profile?.id ?? null
          }
          // customer_order_line id is implied by the allocation row in coRows.
          // We don't currently carry it in the helper's return shape, so look it up.
          const { data: allocRow, error: allocFetchErr } = await supabase
            .from('customer_order_allocations')
            .select('id, customer_order_line_id, quantity_allocated, is_active')
            .eq('id', r.allocation_id)
            .single()
          if (allocFetchErr) throw allocFetchErr
          const colId = allocRow.customer_order_line_id

          const { error: lineErr } = await supabase
            .from('customer_order_lines')
            .update(linePatch)
            .eq('id', colId)
          if (lineErr) throw lineErr
        }

        // Decide whether to deactivate the allocation row.
        // For Re-queue, never deactivate — the new job created on this
        // same WO will produce the remaining quantity, so the
        // allocation stays committed and visible on the WO.
        // For Accept Short, deactivate when the user allocated less
        // than the original commitment (the remainder returns to the
        // demand pool for future re-allocation).
        const shouldDeactivate =
          resolution !== 'requeue' && allocated < existingAllocated
        if (shouldDeactivate) {
          const { error: deactErr } = await supabase
            .from('customer_order_allocations')
            .update({
              is_active: false,
              deactivated_at: now,
              deactivated_by: profile?.id ?? null,
            })
            .eq('id', r.allocation_id)
          if (deactErr) throw deactErr
        }

        allocationEvents.push({
          co_line_id: r.line_number ?? null,
          customer_name: r.customer_name || null,
          po_number: r.po_number || null,
          allocated,
          existing_allocated: existingAllocated,
          deactivated: shouldDeactivate,
        })
      }

      // (4) Resolution row update — write the chosen resolution.
      const resolutionNotes =
        resolution === 'requeue'
          ? requeueNotes.trim() || null
          : acceptReason.trim()

      let newJobId = null

      // (5) Re-queue: create new job on same WO BEFORE resolution write,
      //     so we can stamp requeue_job_id.
      if (resolution === 'requeue') {
        const qty = requeueQtyNumber

        // The new job must produce the SAME component as the shorting
        // job — not necessarily the WOA's assembly_id, which for
        // assembly WOs points to the parent assembly (D-S8-10).
        const componentId = job?.component?.id
        if (!componentId) {
          throw new Error('Cannot determine component for new re-queue job: source job has no component.')
        }

        // WOA is still the structural anchor for work_order_assembly_id.
        const { data: woaRows, error: woaErr } = await supabase
          .from('work_order_assemblies')
          .select('id')
          .eq('work_order_id', shortfall.work_order_id)
          .order('created_at', { ascending: true })
          .limit(1)
        if (woaErr) throw woaErr
        const woa = woaRows?.[0]
        if (!woa) throw new Error('No work_order_assembly found for this WO.')

        const { data: woRow, error: woRowErr } = await supabase
          .from('work_orders')
          .select('priority')
          .eq('id', shortfall.work_order_id)
          .single()
        if (woRowErr) throw woRowErr

        // Generate a unique re-queue job number. Use timestamp-based suffix.
        const newJobNumber = `RQ-${Date.now().toString().slice(-8)}`
        const { data: newJob, error: newJobErr } = await supabase
          .from('jobs')
          .insert({
            job_number: newJobNumber,
            work_order_id: shortfall.work_order_id,
            work_order_assembly_id: woa.id,
            component_id: componentId,
            quantity: qty,
            status: 'pending_compliance',
            priority: woRow?.priority || 'normal',
            notes: requeueNotes.trim() || null,
            created_at: now,
            updated_at: now,
          })
          .select('id')
          .single()
        if (newJobErr) throw newJobErr
        newJobId = newJob.id

        // Auto-pull part_documents → job_documents. Filter by the
        // shorting job's component, NOT the WOA's assembly_id.
        const { data: partDocs } = await supabase
          .from('part_documents')
          .select('document_type_id, file_name, file_url, file_size, mime_type')
          .eq('part_id', componentId)
          .eq('is_current', true)
        if (partDocs && partDocs.length > 0) {
          const jobDocRows = partDocs.map(pd => ({
            job_id: newJobId,
            document_type_id: pd.document_type_id,
            file_name: pd.file_name,
            file_url: pd.file_url,
            file_size: pd.file_size,
            mime_type: pd.mime_type,
            uploaded_by: profile?.id ?? null,
            status: 'approved',
            source: 'part_pulled_forward',
          }))
          await supabase.from('job_documents').insert(jobDocRows)
        }

        // Auto-pull part_routing_steps → job_routing_steps. Same
        // correction: filter by the shorting job's component.
        const { data: partRouting } = await supabase
          .from('part_routing_steps')
          .select('*')
          .eq('part_id', componentId)
          .eq('is_active', true)
          .order('step_order')
        if (partRouting && partRouting.length > 0) {
          const steps = partRouting.map(s => ({
            job_id: newJobId,
            step_order: s.step_order,
            step_name: s.step_name,
            step_type: s.step_type,
            station: s.default_station,
            status: 'pending',
          }))
          await supabase.from('job_routing_steps').insert(steps)
        }
      }

      // (4 cont.) Write the resolution row.
      const resolutionPatch = {
        resolution,
        resolution_notes: resolutionNotes,
        resolved_by: profile?.id ?? null,
        resolved_at: now,
        status: 'resolved',
      }
      if (newJobId) resolutionPatch.requeue_job_id = newJobId

      const { error: resErr } = await supabase
        .from('job_shortfall_resolutions')
        .update(resolutionPatch)
        .eq('id', shortfall.id)
      if (resErr) throw resErr

      // (6) Clear the per-job marker. WO-level has_open_shortfall is
      // deprecated and derived from any job on the WO.
      const targetJobId = shortfall?.job_id ?? job?.id
      if (targetJobId) {
        const { error: jobErr } = await supabase
          .from('jobs')
          .update({ has_open_shortfall: false })
          .eq('id', targetJobId)
        if (jobErr) throw jobErr
      }

      // (7) Audit log — single rolled-up event for the resolution.
      try {
        await supabase.from('audit_logs').insert({
          event_type: 'shortfall_resolved',
          operator_id: profile?.id ?? null,
          details: {
            resolution,
            job_id: shortfall?.job_id ?? job?.id ?? null,
            work_order_id: shortfall.work_order_id,
            shortfall_resolution_id: shortfall.id,
            produced_quantity: produced,
            job_quantity: target,
            allocations: allocationEvents,
            stock_allocated: toStock,
            ...(resolution === 'requeue' ? {
              requeue_job_id: newJobId,
              requeue_quantity: requeueQtyNumber,
            } : {}),
            ...(resolution === 'accept_short' ? {
              accept_reason: acceptReason.trim(),
            } : {}),
          },
        })
      } catch (auditErr) {
        // Non-blocking
        console.error('Audit log write failed (non-blocking):', auditErr)
      }

      onSuccess?.()
      onClose?.()
    } catch (err) {
      console.error('Resolution save failed:', err)
      setError(err.message || 'Save failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-5xl my-8 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-800 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">
              Resolve Shortfall — {job?.job_number || ''}
            </h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {workOrder?.part_number && (
                <span className="text-gray-300 font-mono">{workOrder.part_number}</span>
              )}
              {workOrder?.part_number && workOrder?.wo_number && (
                <span className="mx-2 text-gray-600">·</span>
              )}
              {workOrder?.wo_number && (
                <span>WO {workOrder.wo_number}</span>
              )}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              Step 1: allocate produced qty to customer orders. Step 2: choose how to close the shortfall.
            </p>
            <p className="text-xs text-gray-400 mt-1">
              Produced: <span className="text-gray-200">{produced}</span>
              <span className="mx-2 text-gray-600">|</span>
              Target: <span className="text-gray-200">{target}</span>
              <span className="mx-2 text-gray-600">|</span>
              <span className="text-red-300">Short by {gap}</span>
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {/* Step 1 — Allocation table */}
          <section>
            <h3 className="text-sm font-semibold text-white mb-1">
              Step 1 — Allocate produced quantity to customer orders
            </h3>
            <p className="text-xs text-gray-500 mb-3">
              Excess flows to stock automatically. Allocations smaller than the original commitment release the remainder back to the demand pool.
            </p>
            <div className="overflow-x-auto border border-gray-800 rounded">
              <table className="w-full text-xs table-fixed">
                <colgroup>
                  <col style={{ width: '17%' }} />
                  <col style={{ width: '9%' }} />
                  <col style={{ width: '6%' }} />
                  <col style={{ width: '8%' }} />
                  <col style={{ width: '11%' }} />
                  <col style={{ width: '8%' }} />
                  <col style={{ width: '9%' }} />
                  <col style={{ width: '10%' }} />
                  <col style={{ width: '9%' }} />
                  <col style={{ width: '13%' }} />
                </colgroup>
                <thead className="bg-gray-900/60 text-gray-500">
                  <tr className="border-b border-gray-800">
                    <th className="text-left font-medium px-2 py-1.5">Customer</th>
                    <th className="text-left font-medium px-2 py-1.5">PO</th>
                    <th className="text-left font-medium px-2 py-1.5">Line</th>
                    <th className="text-right font-medium px-2 py-1.5">Ordered</th>
                    <th className="text-right font-medium px-2 py-1.5">Alloc’d to WO</th>
                    <th className="text-right font-medium px-2 py-1.5">Fulfilled</th>
                    <th className="text-right font-medium px-2 py-1.5">Remaining</th>
                    <th className="text-left font-medium px-2 py-1.5">Due</th>
                    <th className="text-left font-medium px-2 py-1.5">Priority</th>
                    <th className="text-right font-medium px-2 py-1.5">Allocate</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-2 py-4 text-center text-gray-500">
                        No active CO allocations on this WO.
                      </td>
                    </tr>
                  ) : sortedRows.map(r => {
                    const cancelled = r.status === 'cancelled'
                    const ceiling = Math.max(0, (r.ordered || 0) - (r.fulfilled || 0))
                    const err = rowErrors[r.allocation_id]
                    const baseTextCls = cancelled ? 'text-gray-500 line-through' : 'text-gray-300'
                    return (
                      <tr
                        key={r.allocation_id}
                        title={cancelled ? 'CO line cancelled' : undefined}
                        className={`border-b border-gray-800/60 last:border-b-0 ${cancelled ? 'bg-gray-900/40' : ''}`}
                      >
                        <td className={`px-2 py-1.5 truncate ${baseTextCls}`}>{r.customer_name || '—'}</td>
                        <td className={`px-2 py-1.5 truncate ${baseTextCls}`}>{r.po_number || '—'}</td>
                        <td className={`px-2 py-1.5 ${baseTextCls}`}>#{r.line_number}</td>
                        <td className={`px-2 py-1.5 text-right ${baseTextCls}`}>{r.ordered}</td>
                        <td className={`px-2 py-1.5 text-right ${baseTextCls}`}>{r.allocated}</td>
                        <td className={`px-2 py-1.5 text-right ${baseTextCls}`}>{r.fulfilled}</td>
                        <td className={`px-2 py-1.5 text-right ${cancelled ? baseTextCls : 'text-amber-300'}`}>{ceiling}</td>
                        <td className={`px-2 py-1.5 ${baseTextCls}`}>{formatDateOnly(r.due_date)}</td>
                        <td className="px-2 py-1.5">
                          {cancelled
                            ? <span className="text-gray-500 line-through">{r.priority || 'normal'}</span>
                            : priorityPill(r.priority)}
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex flex-col items-end">
                            <input
                              type="number"
                              min="0"
                              max={ceiling}
                              step="1"
                              value={allocs[r.allocation_id] ?? ''}
                              onChange={(e) => setAllocs(prev => ({ ...prev, [r.allocation_id]: e.target.value }))}
                              disabled={cancelled || submitting}
                              className={`w-24 px-2 py-1 bg-gray-800 border rounded text-right text-white text-xs focus:outline-none ${
                                err ? 'border-red-600 focus:border-red-500' : 'border-gray-700 focus:border-skynet-accent'
                              } disabled:opacity-50`}
                            />
                            {err && (
                              <span className="text-[10px] text-red-400 mt-0.5">{err}</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Running summary */}
            <div className="mt-2 flex items-center justify-between text-xs">
              <div className={overAllocated ? 'text-red-400' : 'text-gray-400'}>
                Allocated to COs: <span className="text-gray-100 font-medium">{totalAllocated}</span>
                <span className="mx-2 text-gray-600">|</span>
                To stock: <span className={`font-medium ${toStock < 0 ? 'text-red-400' : 'text-gray-100'}`}>{toStock}</span>
                {overAllocated && (
                  <span className="ml-3 text-red-400 font-medium">
                    Over-allocated by {totalAllocated - produced}
                  </span>
                )}
              </div>
              <div className="text-gray-500">
                Produced: <span className="text-gray-200">{produced}</span>
              </div>
            </div>
          </section>

          {/* Step 2 — Resolution picker */}
          <section>
            <h3 className="text-sm font-semibold text-white mb-3">
              Step 2 — Choose outcome
            </h3>
            <div className="space-y-2">
              {/* Accept Short */}
              <label className={`block border rounded-lg p-3 cursor-pointer transition-colors ${
                resolution === 'accept_short' ? 'border-emerald-700 bg-emerald-950/30' : 'border-gray-800 bg-gray-900/40 hover:border-gray-700'
              }`}>
                <div className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="resolution"
                    value="accept_short"
                    checked={resolution === 'accept_short'}
                    onChange={() => setResolution('accept_short')}
                    className="mt-1"
                  />
                  <div className="flex-1">
                    <div className="text-sm text-emerald-300 font-medium flex items-center gap-2">
                      <CheckCircle size={14} /> Accept Short
                    </div>
                    <p className="text-xs text-gray-400 mt-1">
                      Close this shortfall. Allocated CO lines fulfill per Step 1; excess flows to stock. The remaining quantity will not be remade unless re-allocated separately later.
                    </p>
                    {resolution === 'accept_short' && (
                      <div className="mt-3">
                        <label className="block text-xs text-emerald-300 mb-1">
                          Why are we not making the remaining quantity? <span className="text-red-400">Required.</span>
                        </label>
                        <textarea
                          value={acceptReason}
                          onChange={(e) => setAcceptReason(e.target.value)}
                          placeholder="Required reason"
                          rows={2}
                          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-emerald-500 focus:outline-none resize-none"
                        />
                      </div>
                    )}
                  </div>
                </div>
              </label>

              {/* Re-queue */}
              <label className={`block border rounded-lg p-3 cursor-pointer transition-colors ${
                resolution === 'requeue' ? 'border-blue-700 bg-blue-950/30' : 'border-gray-800 bg-gray-900/40 hover:border-gray-700'
              }`}>
                <div className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="resolution"
                    value="requeue"
                    checked={resolution === 'requeue'}
                    onChange={() => setResolution('requeue')}
                    className="mt-1"
                  />
                  <div className="flex-1">
                    <div className="text-sm text-blue-300 font-medium flex items-center gap-2">
                      <RotateCcw size={14} /> Re-queue
                    </div>
                    <p className="text-xs text-gray-400 mt-1">
                      Close this shortfall AND create a new job to produce the remaining gap.
                    </p>
                    {resolution === 'requeue' && (
                      <div className="mt-3 space-y-2">
                        <div>
                          <label className="block text-xs text-gray-400 mb-1">Quantity</label>
                          <input
                            type="number"
                            min="1"
                            value={requeueQty}
                            onChange={(e) => setRequeueQty(e.target.value)}
                            className="w-32 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-blue-500 focus:outline-none"
                          />
                        </div>
                        <textarea
                          value={requeueNotes}
                          onChange={(e) => setRequeueNotes(e.target.value)}
                          placeholder="Optional notes for the new job…"
                          rows={2}
                          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-blue-500 focus:outline-none resize-none"
                        />
                      </div>
                    )}
                  </div>
                </div>
              </label>

            </div>
          </section>

          {error && (
            <div className="bg-red-950/40 border border-red-800 text-red-300 text-xs rounded p-3 flex items-start gap-2">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-800 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm text-gray-400 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="px-4 py-1.5 text-sm bg-skynet-accent hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded flex items-center gap-2"
          >
            {submitting && <Loader2 size={12} className="animate-spin" />}
            Save Resolution
          </button>
        </div>
      </div>
    </div>
  )
}
