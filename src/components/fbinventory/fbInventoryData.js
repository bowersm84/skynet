// fbInventoryData.js — S13 D-FBINV-03. Supabase reads and writes for the Armory's Fishbowl
// Inventory group. Pure logic lives in lib/fbStock.js.
//
// Reads go through the two registry views (D-RPT-16) with the Reports module's exhaustive
// fetch (runReport: exact count, stable-ordered pages, mismatch retry — D-RPT-04), so a
// silently truncated page can never show here either. Writes touch fb_reorder_points only,
// then call fb_reorder_evaluate() so the stored alert_state reflects the edit at once.
import { supabase } from '../../lib/supabase'
import { getSyncState } from '../../lib/fishbowl'
import { runReport } from '../../lib/reports'
import { likePattern } from '../../lib/fbStock'

export const STOCK_VIEW = {
  source_object: 'v_report_fb_stock_on_hand',
  order_by: [{ column: 'part_number', ascending: true }],
}
export const REORDER_VIEW = {
  source_object: 'v_report_fb_reorder_status',
  order_by: [{ column: 'part_number', ascending: true }],
}

// Column order of the registry rows, so the tab's CSV and the Reports module's CSV match.
export const STOCK_CSV_COLUMNS = ['part_number', 'description', 'category', 'on_hand', 'allocated', 'available', 'on_order', 'avg_cost', 'est_value', 'min_qty', 'reorder_status', 'flags', 'inventory_as_of', 'cost_as_of']
export const REORDER_CSV_COLUMNS = ['category', 'part_number', 'description', 'min_qty', 'on_hand', 'available', 'on_order', 'status', 'shortfall', 'on_order_covers', 'vendor', 'notes', 'alert_changed_at', 'inventory_as_of']

// Stock Levels: every Product part, the sync clocks, and the parts Fishbowl has not classed
// (valuation class missing — they drop out of Stock Levels and the month-end until classed).
export async function loadStockLevels() {
  const [rows, sync, unclassified] = await Promise.all([
    runReport(STOCK_VIEW),
    getSyncState(),
    supabase
      .from('fb_part_valuation')
      .select('part_num, qty_on_hand', { count: 'exact' })
      .eq('valuation_class', '(unclassified)')
      .is('removed_at', null)
      .neq('qty_on_hand', 0)
      .order('part_num')
      .limit(50),
  ])
  if (unclassified.error) throw unclassified.error
  return {
    rows,
    sync,
    unclassified: { count: unclassified.count || 0, parts: (unclassified.data || []).map(r => r.part_num) },
  }
}

// Reorder Points: the rules (with ids, for editing) beside the status view (numbers and
// description), joined on the Fishbowl part number — the view's part_number IS rp.part_num.
export async function loadReorderPoints() {
  const [rulesRes, statusRows, sync] = await Promise.all([
    supabase.from('fb_reorder_points').select('*').order('category').order('part_num'),
    runReport(REORDER_VIEW),
    getSyncState(),
  ])
  if (rulesRes.error) throw rulesRes.error
  const byPart = new Map(statusRows.map(r => [r.part_number, r]))
  const rules = (rulesRes.data || []).map(rule => ({ ...rule, status: byPart.get(rule.part_num) || null }))
  return { rules, statusRows, sync }
}

// Product parts for the Add Rule typeahead. Part number only, at most 15 rows.
export async function searchProductParts(q) {
  const text = String(q || '').trim()
  if (text.length < 2) return []
  const { data, error } = await supabase
    .from('fb_part_valuation')
    .select('part_num, description, qty_on_hand')
    .eq('valuation_class', 'Product')
    .is('removed_at', null)
    .ilike('part_num', likePattern(text))
    .order('part_num')
    .limit(15)
  if (error) throw error
  return data || []
}

export async function evaluateRules() {
  const { data, error } = await supabase.rpc('fb_reorder_evaluate')
  if (error) throw error
  return data // { evaluated, below, newly_below, notified }
}

// Insert or update one rule, then re-evaluate. The evaluation is reported, never fatal:
// the rule is saved either way and the next 5-minute cycle evaluates it regardless.
export async function saveRule(rule, profileId) {
  const now = new Date().toISOString()
  const fields = {
    category: rule.category,
    min_qty: rule.min_qty,
    vendor: rule.vendor?.trim() || null,
    notes: rule.notes?.trim() || null,
    updated_by: profileId || null,
    updated_at: now,
  }
  if (rule.id) {
    const { error } = await supabase.from('fb_reorder_points').update(fields).eq('id', rule.id)
    if (error) throw error
  } else {
    const { error } = await supabase.from('fb_reorder_points').insert({
      ...fields,
      part_num: rule.part_num.trim(),
      is_active: true,
      alert_state: rule.min_qty === null ? 'no_min' : 'ok',
      created_by: profileId || null,
    })
    if (error) throw error
  }
  return evaluateQuietly()
}

export async function setRuleActive(rule, active, profileId) {
  const { error } = await supabase
    .from('fb_reorder_points')
    .update({ is_active: active, updated_by: profileId || null, updated_at: new Date().toISOString() })
    .eq('id', rule.id)
  if (error) throw error
  return evaluateQuietly()
}

export async function deleteRule(rule) {
  const { error } = await supabase.from('fb_reorder_points').delete().eq('id', rule.id)
  if (error) throw error
}

async function evaluateQuietly() {
  try {
    return { evaluation: await evaluateRules(), evaluationError: null }
  } catch (e) {
    console.error('fb_reorder_evaluate failed:', e)
    return { evaluation: null, evaluationError: e?.message || String(e) }
  }
}
