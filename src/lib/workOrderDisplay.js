// Display helpers for Work Orders that may have multiple Customer Order
// allocations. Centralizes the "show derived customer/due-date when COs are
// linked, fall back to wo.customer / wo.due_date when not" rule.
//
// Caller is expected to pass the active customer_order_allocations array
// joined to customer_order_lines → customer_orders → customers (the same
// shape EditWorkOrderModal loads on open).

export function summarizeWOAllocations(allocations) {
  const customers = new Map()  // id -> name
  const dueDates = []
  const cos = new Set()
  for (const a of allocations || []) {
    const line = a.customer_order_lines
    if (!line) continue
    const co = line.customer_orders
    const cust = co?.customers
    if (cust?.id) customers.set(cust.id, cust.name)
    if (line.due_date) dueDates.push(line.due_date)
    if (co?.co_number) cos.add(co.co_number)
  }
  const customerList = Array.from(customers.values()).sort()
  const earliestDue = dueDates.length
    ? dueDates.slice().sort()[0]
    : null
  const hasMultipleDueDates = new Set(dueDates).size > 1

  let customerDisplay
  if (customerList.length === 0) customerDisplay = null
  else if (customerList.length === 1) customerDisplay = customerList[0]
  else customerDisplay = `${customerList[0]} +${customerList.length - 1} more`

  return {
    hasAllocations: customerList.length > 0,
    customerDisplay,
    customerList,
    customerCount: customerList.length,
    earliestDueDate: earliestDue,
    hasMultipleDueDates,
    coNumbers: Array.from(cos).sort(),
  }
}

export function formatWODueDate(summary, fallbackDate) {
  if (!summary?.hasAllocations || !summary.earliestDueDate) {
    return fallbackDate || null
  }
  return summary.earliestDueDate
}
