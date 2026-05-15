import { supabase } from './supabase'

/**
 * Auto-fulfill CO line commitments from a re-queue job's good_pieces.
 *
 * Trigger: after the RQ job advances past compliance review
 * (handleApproveBatch finishing-batch path, handleApproveJob and
 * handleApproveAndPrint post-mfg paths in ComplianceReview.jsx).
 *
 * Scope: only fires when the job is referenced as requeue_job_id on a
 * job_shortfall_resolutions row with NULL fulfillment_applied_at.
 * Normal (non-RQ) jobs no-op silently. Idempotent — sets
 * fulfillment_applied_at after success so re-firing is safe.
 *
 * Distribution: FIFO by CO line due_date asc (nulls last), then
 * priority (high → normal → low). Walks active allocations on the
 * RQ job's WO. Per-allocation cap is the smaller of (CO remaining,
 * WO commitment remaining) — single-source assumption; multi-source
 * COs are an edge case to address when Shipping module lands.
 *
 * Excess good_pieces beyond CO commitments flows to stock implicitly
 * (no action — stock is residual on the WO).
 */
export async function fulfillFromRequeueJob(jobId) {
  if (!jobId) return null

  // 1. Find unapplied resolutions where this job is the re-queue target.
  const { data: resolutions, error: resErr } = await supabase
    .from('job_shortfall_resolutions')
    .select('id, work_order_id')
    .eq('requeue_job_id', jobId)
    .is('fulfillment_applied_at', null)
  if (resErr) {
    console.error('fulfillFromRequeueJob: resolution lookup failed:', resErr)
    return null
  }
  if (!resolutions || resolutions.length === 0) return null

  // 2. Load the RQ job's good_pieces and WO.
  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .select('good_pieces, work_order_id')
    .eq('id', jobId)
    .single()
  if (jobErr || !job) {
    console.error('fulfillFromRequeueJob: job lookup failed:', jobErr)
    return null
  }
  const goodPieces = job.good_pieces ?? 0
  if (goodPieces <= 0) return null

  // 3. Load active allocations on this WO with CO line fields.
  const { data: allocs, error: allocErr } = await supabase
    .from('customer_order_allocations')
    .select(`
      id, quantity_allocated,
      customer_order_line:customer_order_lines (
        id, quantity_ordered, quantity_fulfilled, status, due_date, priority
      )
    `)
    .eq('work_order_id', job.work_order_id)
    .eq('is_active', true)
  if (allocErr) {
    console.error('fulfillFromRequeueJob: allocation lookup failed:', allocErr)
    return null
  }

  // 4. Sort FIFO: due_date asc (nulls last), then priority.
  const priorityRank = { high: 0, normal: 1, low: 2 }
  const sorted = (allocs || [])
    .filter(a => a.customer_order_line)
    .sort((a, b) => {
      const ad = a.customer_order_line.due_date
      const bd = b.customer_order_line.due_date
      if (ad && bd) {
        if (ad < bd) return -1
        if (ad > bd) return 1
      } else if (ad && !bd) {
        return -1
      } else if (!ad && bd) {
        return 1
      }
      const ap = priorityRank[a.customer_order_line.priority] ?? 1
      const bp = priorityRank[b.customer_order_line.priority] ?? 1
      return ap - bp
    })

  // 5. Walk allocations, distributing good_pieces.
  let remaining = goodPieces
  const fulfilledRows = []
  const now = new Date().toISOString()

  for (const a of sorted) {
    if (remaining <= 0) break
    const col = a.customer_order_line
    const coRemaining = Math.max(
      0,
      (col.quantity_ordered || 0) - (col.quantity_fulfilled || 0)
    )
    const woRemaining = Math.max(
      0,
      (a.quantity_allocated || 0) - (col.quantity_fulfilled || 0)
    )
    const toFulfill = Math.min(remaining, coRemaining, woRemaining)
    if (toFulfill <= 0) continue

    const newFulfilled = (col.quantity_fulfilled || 0) + toFulfill
    const becomesComplete = newFulfilled >= (col.quantity_ordered || 0)

    const linePatch = { quantity_fulfilled: newFulfilled }
    if (becomesComplete) {
      linePatch.status = 'complete'
      linePatch.fulfilled_at = now
    }

    const { error: updErr } = await supabase
      .from('customer_order_lines')
      .update(linePatch)
      .eq('id', col.id)
    if (updErr) {
      console.error('fulfillFromRequeueJob: CO line update failed:', updErr)
      continue
    }

    fulfilledRows.push({
      co_line_id: col.id,
      added: toFulfill,
      new_total: newFulfilled,
      completed: becomesComplete,
    })
    remaining -= toFulfill
  }

  // 6. Stamp idempotency flag on all matching resolutions.
  for (const r of resolutions) {
    await supabase
      .from('job_shortfall_resolutions')
      .update({ fulfillment_applied_at: now })
      .eq('id', r.id)
  }

  return {
    fulfilled: goodPieces - remaining,
    excess_to_stock: remaining,
    allocations: fulfilledRows,
  }
}
