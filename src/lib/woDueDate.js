// Shared helper for the derived-WO-due-date rule (D-DATE-01 / D-DATE-02).
//
// work_orders.due_date stays the single field every downstream consumer reads
// (Schedule sort/overdue, kiosks, dashboards, traveler). What changed is how it
// is populated: WOs linked to customer orders DERIVE it from the earliest
// due_date across their active allocated CO lines. Only stock-only WOs (zero
// allocations) keep a manually entered date.
//
// Sync is ONE-WAY: CO line due dates push to linked WOs; WOs never write back
// to CO lines. Shared by EditCustomerOrderModal (CO edit) and EditWorkOrderModal
// (post-edit allocation resync).

/**
 * Recompute work_orders.due_date for each WO from its active CO allocations.
 *
 * For each WO id (input is deduped, empties skipped):
 *   1. Load active allocations (is_active = true) joined to their CO line due_date.
 *   2. Zero active allocations → SKIP (stock-only WO keeps its manual date;
 *      never nulled out).
 *   3. earliest = min non-null CO line due_date. All linked dates null → SKIP.
 *   4. UPDATE work_orders.due_date only when the value actually changed.
 *
 * Individual WO failures are collected and console.error'd — they never abort
 * the loop or throw. Returns { updated: [ids], skipped: [ids], errors: [...] }.
 */
export async function resyncWODueDates(supabase, woIds) {
  const result = { updated: [], skipped: [], errors: [] }

  const uniqueIds = [...new Set((woIds || []).filter(Boolean))]
  if (uniqueIds.length === 0) return result

  for (const woId of uniqueIds) {
    try {
      // 1. Active allocations + their CO line due_date.
      const { data: allocs, error: allocErr } = await supabase
        .from('customer_order_allocations')
        .select('id, customer_order_lines ( due_date )')
        .eq('work_order_id', woId)
        .eq('is_active', true)
      if (allocErr) throw allocErr

      // 2. Stock-only WO (no active allocations) — leave the manual date alone.
      if (!allocs || allocs.length === 0) {
        result.skipped.push(woId)
        continue
      }

      // 3. Earliest non-null CO line due_date (ISO yyyy-mm-dd — string min is fine).
      const dueDates = allocs
        .map(a => a.customer_order_lines?.due_date)
        .filter(Boolean)
      if (dueDates.length === 0) {
        result.skipped.push(woId)
        continue
      }
      const earliest = dueDates.slice().sort()[0]

      // 4. Only write when the value actually changed.
      const { data: wo, error: woErr } = await supabase
        .from('work_orders')
        .select('due_date')
        .eq('id', woId)
        .single()
      if (woErr) throw woErr

      if ((wo?.due_date || null) === earliest) {
        result.skipped.push(woId)
        continue
      }

      const { error: updErr } = await supabase
        .from('work_orders')
        .update({ due_date: earliest })
        .eq('id', woId)
      if (updErr) throw updErr

      result.updated.push(woId)
    } catch (err) {
      console.error(`resyncWODueDates: failed for WO ${woId}:`, err)
      result.errors.push({ woId, error: err })
    }
  }

  return result
}
