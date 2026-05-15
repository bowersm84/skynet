import { supabase } from './supabase'

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
