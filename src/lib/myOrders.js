// D-MYORD-01 — salesperson-scoped Customer Order line view.
//
// Loads one flat row per open CO line owned by the logged-in salesperson
// (customer_orders.salesperson_id = userId), with the linked WOs, a job status
// rollup, the scheduled finish (MAX jobs.scheduled_end across linked WOs), and a
// LATE flag when the scheduled finish exceeds the customer due date.
//
// Ownership is salesperson_id, not created_by. All joins are done client-side
// (fetch-then-merge) to stay within the Supabase 2-level nesting cap
// (Decisions.md "Supabase query nesting limit"). No schema or RLS changes.

const humanizeStatus = (s) =>
  (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

export async function loadMyOrderLines(supabase, userId) {
  if (!userId) return []

  // 1. This salesperson's non-cancelled customer orders.
  const { data: cos, error: coErr } = await supabase
    .from('customer_orders')
    .select('id, co_number, po_number, status, customers ( name )')
    .eq('salesperson_id', userId)
    .neq('status', 'cancelled')
  if (coErr) throw coErr
  if (!cos || cos.length === 0) return []

  const coById = new Map(cos.map(c => [c.id, c]))
  const coIds = cos.map(c => c.id)

  // 2. Their (non-cancelled) CO lines.
  const { data: lines, error: linesErr } = await supabase
    .from('customer_order_lines')
    .select(`
      id, customer_order_id, line_number, quantity_ordered, quantity_fulfilled,
      due_date, priority, status,
      parts ( part_number, description )
    `)
    .in('customer_order_id', coIds)
    .neq('status', 'cancelled')
  if (linesErr) throw linesErr
  if (!lines || lines.length === 0) return []

  const lineIds = lines.map(l => l.id)

  // 3. Active allocations linking those lines to WOs.
  const { data: allocs, error: allocErr } = await supabase
    .from('customer_order_allocations')
    .select('customer_order_line_id, work_order_id, work_orders ( wo_number, status )')
    .in('customer_order_line_id', lineIds)
    .eq('is_active', true)
  if (allocErr) throw allocErr

  // line_id -> [{ work_order_id, wo_number, status }]
  const wosByLine = new Map()
  const allWoIds = new Set()
  for (const a of allocs || []) {
    if (!a.work_order_id) continue
    allWoIds.add(a.work_order_id)
    const arr = wosByLine.get(a.customer_order_line_id) || []
    arr.push({
      work_order_id: a.work_order_id,
      wo_number: a.work_orders?.wo_number || null,
      status: a.work_orders?.status || null,
    })
    wosByLine.set(a.customer_order_line_id, arr)
  }

  // 4. Jobs on the linked WOs (for scheduled finish + status rollup).
  let jobsByWo = new Map()
  if (allWoIds.size > 0) {
    const { data: jobs, error: jobsErr } = await supabase
      .from('jobs')
      .select('id, status, scheduled_end, work_order_id')
      .in('work_order_id', [...allWoIds])
    if (jobsErr) throw jobsErr
    for (const j of jobs || []) {
      const arr = jobsByWo.get(j.work_order_id) || []
      arr.push(j)
      jobsByWo.set(j.work_order_id, arr)
    }
  }

  // Build one flat row per CO line.
  return lines.map(line => {
    const co = coById.get(line.customer_order_id) || {}
    const linkedWos = wosByLine.get(line.id) || []
    const woNumbers = [...new Set(linkedWos.map(w => w.wo_number).filter(Boolean))]

    // Gather jobs across the line's linked WOs.
    const jobs = linkedWos.flatMap(w => jobsByWo.get(w.work_order_id) || [])
    const scheduledEnds = jobs.map(j => j.scheduled_end).filter(Boolean)
    const scheduledFinish = scheduledEnds.length
      ? scheduledEnds.reduce((max, d) => (d > max ? d : max))
      : null

    // Status rollup.
    let jobStatusSummary
    if (linkedWos.length === 0) {
      jobStatusSummary = 'No WO'
    } else if (scheduledEnds.length === 0) {
      jobStatusSummary = 'Not scheduled'
    } else {
      const distinct = [...new Set(jobs.map(j => j.status).filter(Boolean))]
      jobStatusSummary = distinct.length === 1 ? humanizeStatus(distinct[0]) : 'Mixed'
    }

    const dueDate = line.due_date || null
    const isLate = !!dueDate && !!scheduledFinish &&
      new Date(scheduledFinish) > new Date(dueDate + 'T23:59:59')

    return {
      lineId: line.id,
      coId: line.customer_order_id,
      coNumber: co.co_number || null,
      poNumber: co.po_number || null,
      customer: co.customers?.name || null,
      partNumber: line.parts?.part_number || null,
      partDescription: line.parts?.description || null,
      lineNumber: line.line_number,
      qtyOrdered: Number(line.quantity_ordered) || 0,
      qtyFulfilled: Number(line.quantity_fulfilled) || 0,
      dueDate,
      priority: line.priority || 'normal',
      lineStatus: line.status || 'not_started',
      woNumbers,
      jobStatusSummary,
      scheduledFinish,
      isLate,
    }
  })
}
