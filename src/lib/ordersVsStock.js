// Orders vs. stock for a production run (D-OVS-01).
//
// Orders = Σ over every work order in the run (host WO + each active member's
//          WO) of max(0, that WO's active customer_order_allocations − pieces
//          already made by that WO's other jobs that are past the machine). A
//          split remainder or a re-queue only owes the balance, and a sibling on
//          one WO can never cover another WO's orders. Never work_orders.
//          order_quantity / stock_quantity: creation-time snapshots that drift
//          (D-SHORT-07).
// Stock  = run target − orders, floored at 0. Everything past the orders line is
//          the deliberate overrun kept for future orders.
// "Made" is the caller's count: the Kiosk passes pieces sent to finishing (the
// machinist's leading number); the Production Display passes its finished count
// (verified + missed entries), so each surface stays consistent with its own bar.
import { supabase } from './supabase'

// Jobs whose pieces are posted — the set D-SHORT-07 / PartHistoryModal use.
const PAST_MACHINE = [
  'manufacturing_complete', 'pending_passivation', 'in_passivation',
  'pending_post_manufacturing', 'ready_for_outsourcing', 'at_external_vendor',
  'ready_for_assembly', 'in_assembly', 'pending_tco', 'complete', 'incomplete',
]

function emptySummary(run) {
  const target = run.target || 0
  return {
    target, ordersGross: 0, madeElsewhere: 0, orders: 0, ordersOnRun: 0,
    stock: target, lines: [], siblingJobs: 0, woCount: 0,
  }
}

// runs: [{ jobId, jobNumber, workOrderId, woNumber, target, memberJobIds }]
// Returns { [jobId]: summary }. Three queries for the whole batch.
export async function fetchOrdersVsStockBatch(runs) {
  const out = {}
  if (!runs?.length) return out

  const memberIds = [...new Set(runs.flatMap(r => r.memberJobIds || []))]
  const memberById = new Map()
  if (memberIds.length > 0) {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, job_number, work_order_id, work_order:work_orders(wo_number)')
      .in('id', memberIds)
    if (error) throw error
    for (const j of data || []) memberById.set(j.id, j)
  }

  // Per run: WO id → { job_number, wo_number } label (host first, then members).
  const runWOs = runs.map(r => {
    const labels = new Map()
    if (r.workOrderId) labels.set(r.workOrderId, { job_number: r.jobNumber || null, wo_number: r.woNumber || null })
    for (const id of r.memberJobIds || []) {
      const m = memberById.get(id)
      if (m?.work_order_id && !labels.has(m.work_order_id)) {
        labels.set(m.work_order_id, { job_number: m.job_number || null, wo_number: m.work_order?.wo_number || null })
      }
    }
    return labels
  })
  const allWOIds = [...new Set(runWOs.flatMap(l => [...l.keys()]))]
  if (allWOIds.length === 0) {
    for (const r of runs) out[r.jobId] = emptySummary(r)
    return out
  }
  const runJobIds = new Set(runs.flatMap(r => [r.jobId, ...(r.memberJobIds || [])]))

  const [allocRes, sibRes] = await Promise.all([
    supabase
      .from('customer_order_allocations')
      .select(`
        work_order_id, quantity_allocated,
        customer_order_line:customer_order_lines (
          line_number, due_date,
          customer_order:customer_orders ( co_number, customer:customers ( name ) )
        )
      `)
      .in('work_order_id', allWOIds)
      .eq('is_active', true),
    supabase
      .from('jobs')
      .select('id, work_order_id, status, is_maintenance, good_pieces, post_mfg_good_qty, missed_production_entries ( quantity )')
      .in('work_order_id', allWOIds)
      .in('status', PAST_MACHINE)
      .eq('is_standalone_finishing', false),
  ])
  if (allocRes.error) throw allocRes.error
  if (sibRes.error) throw sibRes.error

  const allocsByWO = new Map()
  for (const a of allocRes.data || []) {
    if (!allocsByWO.has(a.work_order_id)) allocsByWO.set(a.work_order_id, [])
    allocsByWO.get(a.work_order_id).push(a)
  }
  const sibsByWO = new Map()
  for (const j of sibRes.data || []) {
    if (runJobIds.has(j.id) || j.is_maintenance) continue
    if (!sibsByWO.has(j.work_order_id)) sibsByWO.set(j.work_order_id, [])
    sibsByWO.get(j.work_order_id).push(j)
  }

  runs.forEach((r, i) => {
    const labels = runWOs[i]
    const target = r.target || 0
    const lines = []
    let ordersGross = 0
    let madeElsewhere = 0
    let orders = 0
    let siblingJobs = 0
    for (const [woId, label] of labels) {
      let woAllocated = 0
      let woMadeElsewhere = 0
      for (const a of allocsByWO.get(woId) || []) {
        const line = a.customer_order_line
        const co = line?.customer_order
        woAllocated += a.quantity_allocated || 0
        lines.push({
          work_order_id: woId,
          wo_number: label.wo_number,
          job_number: label.job_number,
          customer: co?.customer?.name || null,
          co_number: co?.co_number || null,
          line_number: line?.line_number ?? null,
          due_date: line?.due_date || null,
          quantity_allocated: a.quantity_allocated || 0,
        })
      }
      for (const j of sibsByWO.get(woId) || []) {
        const missed = (j.missed_production_entries || []).reduce((s, e) => s + (e.quantity || 0), 0)
        woMadeElsewhere += (j.post_mfg_good_qty ?? j.good_pieces ?? 0) + missed
        siblingJobs += 1
      }
      ordersGross += woAllocated
      madeElsewhere += woMadeElsewhere
      orders += Math.max(0, woAllocated - woMadeElsewhere)
    }
    lines.sort((a, b) =>
      String(a.due_date || '9999-12-31').localeCompare(String(b.due_date || '9999-12-31'))
      || String(a.co_number || '').localeCompare(String(b.co_number || ''))
    )
    out[r.jobId] = {
      target,
      ordersGross,
      madeElsewhere,
      orders,
      ordersOnRun: Math.min(orders, target),
      stock: Math.max(0, target - orders),
      lines,
      siblingJobs,
      woCount: labels.size,
    }
  })
  return out
}

// One run — the Kiosk. members = fetchActiveMembers rows (member_job_id, …).
export async function fetchOrdersVsStock({ jobId, jobNumber, workOrderId, woNumber, target, members = [] }) {
  const map = await fetchOrdersVsStockBatch([{
    jobId, jobNumber, workOrderId, woNumber, target,
    memberJobIds: (members || []).map(m => m.member_job_id).filter(Boolean),
  }])
  return map[jobId] || null
}

// Where the run stands against its orders line.
//   'no_orders' — nothing left for orders: none allocated (MTS, or MTO not linked yet),
//                 or ordersGross > 0 and other jobs on the WO already covered them
//   'orders'    — still making customer pieces; toOrders left before the stock line
//   'stock'     — orders covered; stockMade so far, stockLeft to the target
export function ordersVsStockStatus(summary, made) {
  if (!summary) return null
  const m = Math.max(0, Number(made) || 0)
  const { target, ordersOnRun, stock, ordersGross } = summary
  const base = { made: m, ordersOnRun, stock, target, ordersGross }
  if (ordersOnRun <= 0) {
    return { ...base, phase: 'no_orders', toOrders: 0, stockMade: Math.min(m, target), stockLeft: Math.max(0, target - m) }
  }
  if (m < ordersOnRun) {
    return { ...base, phase: 'orders', toOrders: ordersOnRun - m, stockMade: 0, stockLeft: stock }
  }
  return { ...base, phase: 'stock', toOrders: 0, stockMade: Math.min(m - ordersOnRun, stock), stockLeft: Math.max(0, target - m) }
}
