// Helpers for the Customer Orders surface (CO list, Create CO modal, Create WO modal allocation pickup).

export const CO_STATUS_LABELS = {
  not_started: 'Not Started',
  in_progress: 'In Progress',
  complete: 'Complete',
  cancelled: 'Cancelled',
}

export const CO_STATUS_COLORS = {
  not_started: 'bg-gray-700 text-gray-300',
  in_progress: 'bg-amber-900/40 text-amber-300',
  complete: 'bg-green-900/40 text-green-300',
  cancelled: 'bg-red-900/40 text-red-300',
}

// CO-<customerId>-<stripped-uppercase-fishbowl-order-id>
// Returns null if either component would be empty.
export function formatCONumber(customerId, fishbowlOrderId) {
  if (!customerId) return null
  const stripped = String(fishbowlOrderId || '')
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase()
  if (!stripped) return null
  return `CO-${customerId}-${stripped}`
}

// Single-line allocation/fulfillment math.
// Returns integer { ordered, fulfilled, allocated_active, remaining_to_allocate }.
export async function getCOLineQuantities(supabase, lineId) {
  const { data: line, error: lineErr } = await supabase
    .from('customer_order_lines')
    .select('quantity_ordered, quantity_fulfilled')
    .eq('id', lineId)
    .single()
  if (lineErr) throw lineErr

  const { data: allocs, error: allocErr } = await supabase
    .from('customer_order_allocations')
    .select('quantity_allocated')
    .eq('customer_order_line_id', lineId)
    .eq('is_active', true)
  if (allocErr) throw allocErr

  const ordered = Number(line.quantity_ordered) || 0
  const fulfilled = Number(line.quantity_fulfilled) || 0
  const allocated_active = (allocs || []).reduce((s, a) => s + (Number(a.quantity_allocated) || 0), 0)
  const remaining_to_allocate = Math.max(0, ordered - fulfilled - allocated_active)

  return { ordered, fulfilled, allocated_active, remaining_to_allocate }
}

// Open CO lines for a part, used by CreateWorkOrderModal (Batch C) to surface
// pending demand at WO creation time. Excludes lines from cancelled COs and lines
// whose remaining-to-allocate is 0.
export async function getOpenCOLinesForPart(supabase, partId) {
  // Pull lines with their parent CO + customer (2 levels deep — within the
  // Decisions.md nesting cap). Filter status here; filter parent status client-side
  // because PostgREST cannot apply a WHERE on an embedded resource.
  const { data: lines, error: linesErr } = await supabase
    .from('customer_order_lines')
    .select(`
      id,
      line_number,
      quantity_ordered,
      quantity_fulfilled,
      due_date,
      priority,
      status,
      customer_order_id,
      customer_orders!inner (
        id,
        co_number,
        po_number,
        status,
        created_at,
        customers ( name )
      )
    `)
    .in('status', ['not_started', 'in_progress'])
    .eq('part_id', partId)
  if (linesErr) throw linesErr

  const filtered = (lines || []).filter(l => l.customer_orders?.status !== 'cancelled')
  if (filtered.length === 0) return []

  const lineIds = filtered.map(l => l.id)
  const { data: allocs, error: allocErr } = await supabase
    .from('customer_order_allocations')
    .select('customer_order_line_id, quantity_allocated')
    .in('customer_order_line_id', lineIds)
    .eq('is_active', true)
  if (allocErr) throw allocErr

  const allocByLine = new Map()
  for (const a of allocs || []) {
    allocByLine.set(
      a.customer_order_line_id,
      (allocByLine.get(a.customer_order_line_id) || 0) + (Number(a.quantity_allocated) || 0),
    )
  }

  // Sort raw lines first (by due_date ASC NULLS LAST, tiebreak co.created_at ASC),
  // then project to the public row shape so the sort key never leaks into the result.
  const sortable = filtered
    .map(l => {
      const ordered = Number(l.quantity_ordered) || 0
      const fulfilled = Number(l.quantity_fulfilled) || 0
      const allocated = allocByLine.get(l.id) || 0
      return {
        line: l,
        ordered,
        fulfilled,
        allocated,
        remaining: Math.max(0, ordered - fulfilled - allocated),
      }
    })
    .filter(x => x.remaining > 0)

  sortable.sort((a, b) => {
    const ad = a.line.due_date
    const bd = b.line.due_date
    if (ad && bd) {
      if (ad !== bd) return ad < bd ? -1 : 1
    } else if (ad && !bd) {
      return -1
    } else if (!ad && bd) {
      return 1
    }
    const ac = a.line.customer_orders?.created_at
    const bc = b.line.customer_orders?.created_at
    if (ac && bc && ac !== bc) return ac < bc ? -1 : 1
    return 0
  })

  return sortable.map(({ line, ordered, fulfilled, allocated, remaining }) => ({
    line_id: line.id,
    line_number: line.line_number,
    co_id: line.customer_order_id,
    co_number: line.customer_orders?.co_number || null,
    customer_name: line.customer_orders?.customers?.name || null,
    po_number: line.customer_orders?.po_number || null,
    quantity_ordered: ordered,
    quantity_fulfilled: fulfilled,
    quantity_allocated: allocated,
    remaining,
    due_date: line.due_date || null,
    priority: line.priority,
  }))
}

// Active allocations for a single CO line, with their WO. Used by the CO
// line drilldown to surface "where is this demand currently going?".
export async function getAllocationsForLine(supabase, lineId) {
  const { data, error } = await supabase
    .from('customer_order_allocations')
    .select(`
      id,
      quantity_allocated,
      is_active,
      created_at,
      work_order:work_orders(
        id,
        wo_number,
        status,
        priority,
        due_date
      )
    `)
    .eq('customer_order_line_id', lineId)
    .eq('is_active', true)
    .order('created_at', { ascending: true })

  if (error) throw error
  return data || []
}

// All open CO lines across all parts. Used by the Demand view to aggregate
// pending demand by part_number.
export async function getAllOpenCOLines(supabase) {
  const { data, error } = await supabase
    .from('customer_order_lines')
    .select(`
      id,
      line_number,
      part_id,
      quantity_ordered,
      quantity_fulfilled,
      due_date,
      priority,
      status,
      part:parts(id, part_number, description, part_type),
      customer_order:customer_orders!inner(
        id, co_number, po_number, status,
        customer:customers(name)
      ),
      allocations:customer_order_allocations(quantity_allocated, is_active)
    `)
    .in('status', ['not_started', 'in_progress'])
    .neq('customer_order.status', 'cancelled')

  if (error) throw error

  return (data || [])
    .map(line => {
      const allocated = (line.allocations || [])
        .filter(a => a.is_active)
        .reduce((s, a) => s + a.quantity_allocated, 0)
      const remaining = line.quantity_ordered - line.quantity_fulfilled - allocated
      return {
        line_id: line.id,
        line_number: line.line_number,
        part_id: line.part_id,
        part_number: line.part?.part_number,
        part_description: line.part?.description,
        co_id: line.customer_order.id,
        co_number: line.customer_order.co_number,
        customer_name: line.customer_order.customer?.name,
        po_number: line.customer_order.po_number,
        quantity_ordered: line.quantity_ordered,
        quantity_fulfilled: line.quantity_fulfilled,
        quantity_allocated: allocated,
        remaining,
        due_date: line.due_date,
        priority: line.priority,
      }
    })
    .filter(line => line.remaining > 0)
}
