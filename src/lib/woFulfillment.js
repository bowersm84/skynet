import { supabase } from './supabase'
import { getEffectiveQty } from './effectiveQty'

/**
 * Returns CO fulfillment summary for a WO. Used in WO Lookup
 * expanded row and Shortfalls tab.
 */
export async function getWOFulfillmentSummary(workOrderId) {
  const { data: allocs, error } = await supabase
    .from('customer_order_allocations')
    .select(`
      id, quantity_allocated, is_active,
      customer_order_line:customer_order_lines (
        id, line_number, quantity_ordered, quantity_fulfilled,
        status, due_date, priority,
        part:parts ( id, part_number ),
        customer_order:customer_orders (
          id, po_number,
          customer:customers ( id, name )
        )
      )
    `)
    .eq('work_order_id', workOrderId)
    .eq('is_active', true)

  if (error) {
    console.error('Failed to load WO fulfillment summary:', error)
    return []
  }

  return (allocs || []).map(a => {
    const col = a.customer_order_line
    if (!col) return null
    const remaining = (col.quantity_ordered || 0) - (col.quantity_fulfilled || 0)
    return {
      allocation_id: a.id,
      // The CO line behind this allocation — needed by the fulfillment-adjust
      // control, which acts on the line, not the allocation.
      line_id: col.id,
      customer_name: col.customer_order?.customer?.name,
      po_number: col.customer_order?.po_number,
      line_number: col.line_number,
      part_number: col.part?.part_number,
      ordered: col.quantity_ordered || 0,
      allocated: a.quantity_allocated || 0,
      fulfilled: col.quantity_fulfilled || 0,
      remaining,
      satisfied: remaining <= 0,
      due_date: col.due_date,
      priority: col.priority,
      status: col.status,
    }
  }).filter(Boolean)
}

// ─── Customer exposure (D-SHORT-07) ───────────────────────────────────────
// A shortfall's customer impact is NOT the unfulfilled balance on the CO lines.
// quantity_fulfilled only lands when a job reaches pending_tco (D-SHORT-05), so
// any WO with an open shortfall reports its entire order as "short" until then.
// Real exposure asks whether the WO can still cover what customers are owed:
//
//   exposure = max(0, Σ active allocations − projected production)
//
// Projected production sums every non-maintenance job on the WO: jobs past the
// machine contribute their effective produced qty (getEffectiveQty — the same
// precedence chain job_effective_qty() mirrors in SQL, so outsourced and
// finished counts are correct); jobs still in flight contribute their target,
// making the figure a projection that firms up as they complete.
//
// Status sets mirror PartHistoryModal (D-PARTHIST-01): machining finishes at
// manufacturing_complete, not 'complete', so gating on 'complete' would hide
// most real production.
//
// NOT derived from work_orders.order_quantity / stock_quantity: those are
// creation-time snapshots that drift when allocations are added after the WO
// exists (WO-2606-0038 reads 723 against 3723 allocated).

const PRODUCTION_DONE_STATUSES = [
  'manufacturing_complete', 'pending_passivation', 'in_passivation',
  'pending_post_manufacturing', 'ready_for_outsourcing', 'at_external_vendor',
  'ready_for_assembly', 'in_assembly', 'pending_tco', 'complete', 'incomplete'
]

const IN_FLIGHT_STATUSES = [
  'pending_compliance', 'ready', 'assigned', 'in_setup', 'in_progress'
]

// 'cancelled' and 'merged' never count — merged jobs' pieces are carried by
// the host job's own count (D-JOBMERGE-08).
const EXPOSURE_EXCLUDED_STATUSES = ['cancelled', 'merged']

/**
 * Customer exposure for a WO.
 * Returns { totalAllocated, projectedProduction, exposure, isProjection, jobCount }.
 * On query failure returns nulls so callers can degrade to "—" rather than
 * render a confidently wrong 0.
 */
export async function getWOCustomerExposure(workOrderId) {
  const [{ data: allocs, error: allocErr }, { data: jobs, error: jobErr }] = await Promise.all([
    supabase
      .from('customer_order_allocations')
      .select('id, quantity_allocated')
      .eq('work_order_id', workOrderId)
      .eq('is_active', true),
    supabase
      .from('jobs')
      .select(`
        id, job_number, status, quantity, good_pieces, is_maintenance, merged_out_good,
        missed_production_entries ( quantity ),
        finishing_sends (
          id, quantity, compliance_status, compliance_good_qty,
          compliance_bad_qty, verified_count
        ),
        outbound_sends (
          id, quantity, returned_at, quantity_returned,
          routing_step_id, job_routing_step_id
        )
      `)
      .eq('work_order_id', workOrderId),
  ])

  if (allocErr || jobErr) {
    console.error('Failed to load WO exposure inputs:', allocErr || jobErr)
    return {
      totalAllocated: null, projectedProduction: null,
      exposure: null, isProjection: false, jobCount: 0,
    }
  }

  const totalAllocated = (allocs || [])
    .reduce((acc, a) => acc + (a.quantity_allocated || 0), 0)

  const counted = (jobs || []).filter(
    j => !j.is_maintenance && !EXPOSURE_EXCLUDED_STATUSES.includes(j.status)
  )

  let projectedProduction = 0
  let isProjection = false
  for (const j of counted) {
    if (PRODUCTION_DONE_STATUSES.includes(j.status)) {
      projectedProduction += getEffectiveQty(j).qty || 0
    } else if (IN_FLIGHT_STATUSES.includes(j.status)) {
      projectedProduction += j.quantity || 0
      isProjection = true
    }
  }

  return {
    totalAllocated,
    projectedProduction,
    exposure: Math.max(0, totalAllocated - projectedProduction),
    isProjection,
    jobCount: counted.length,
  }
}
