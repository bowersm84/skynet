// D-FBCLOSE-01: CO lines that Fishbowl has already closed (shipped or closed short).
// The database closes unallocated lines on its own (bridge trigger); these helpers
// feed the Demand badge, the "Shipped in Fishbowl, still building" review list and
// the manual Release action.

export const FB_CLOSED_STATES = ['fulfilled', 'closed_short']

// Fishbowl state per CO line, keyed by customer_order_line_id.
export async function getCOLineFbStates(supabase, lineIds) {
  const map = new Map()
  const ids = [...new Set((lineIds || []).filter(Boolean))]
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const { data, error } = await supabase
      .from('v_co_line_fb_state')
      .select('customer_order_line_id, fb_state, so_numbers, fb_completed_at, fb_qty_ordered, fb_qty_shipped')
      .in('customer_order_line_id', chunk)
    if (error) throw error
    for (const r of data || []) map.set(r.customer_order_line_id, r)
  }
  return map
}

// Open CO lines Fishbowl already closed that still have a work order allocated.
export async function getFbClosedReview(supabase) {
  const { data, error } = await supabase
    .from('v_co_fb_closed_review')
    .select('*')
    .order('fb_completed_at', { ascending: true, nullsFirst: false })
  if (error) throw error
  return data || []
}

// action: 'keep_as_stock' | 'review_wo' (admin, scheduler)
export async function resolveFbClosedLine(supabase, lineId, action, note) {
  const { data, error } = await supabase.rpc('co_resolve_fb_closed_line', {
    p_line_id: lineId,
    p_action: action,
    p_note: note || null,
  })
  if (error) throw error
  return data
}

// reason: 'shipped_from_stock' (admin, scheduler) | 'cancelled_by_customer' | 'duplicate' | 'other' (note required)
export async function releaseDemandLines(supabase, lineIds, reason, note) {
  const { data, error } = await supabase.rpc('co_release_demand_lines', {
    p_line_ids: lineIds,
    p_reason: reason,
    p_note: note || null,
  })
  if (error) throw error
  return data
}
