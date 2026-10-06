// fbStock.js — S13 D-FBINV-03. Pure helpers for the Armory's Fishbowl Inventory group
// (Stock Levels and Reorder Points). No imports and no I/O, so fbStock.test.mjs runs it
// under plain `node`. Data access lives in components/fbinventory/fbInventoryData.js.
//
// Rows come from two registry views (Batch A migration, D-RPT-16):
//   v_report_fb_stock_on_hand  — one row per Fishbowl part classed Product
//   v_report_fb_reorder_status — one row per reorder rule
// so Stock Levels, Reorder Points and the Reports module read the same numbers.

// Purchasing's critical-parts sheet, in its order. A category an editor types that is not
// here still sorts — after these, alphabetically.
export const REORDER_CATEGORIES = ['Cups', 'Pins', 'Springs', 'Rings', 'Clips', 'Wings', 'Sandwich', 'Cages', 'Misc.']

// Same window as summarizeFbInventory (D-FB-39): a row whose snapshot is more than 10 minutes
// older than the cycle that last wrote fb_part_inventory is stale — the bridge stopped
// covering it. A row with no snapshot (nightly quantity only) is not "stale", it is "nightly".
export const STALE_MS = 10 * 60 * 1000
// The page-level freshness line turns amber at 15 minutes, as in Create WO (D-FB-39).
export const FRESHNESS_AMBER_MS = 15 * 60 * 1000

export function isStale(asOf, lastInventoryAt) {
  if (!asOf || !lastInventoryAt) return false
  const a = Date.parse(asOf)
  const l = Date.parse(lastInventoryAt)
  if (!Number.isFinite(a) || !Number.isFinite(l)) return false
  return a < l - STALE_MS
}

export function freshness(syncState, nowMs = Date.now()) {
  const inv = syncState?.last_inventory_at || null
  const val = syncState?.last_valuation_at || null
  const invMs = inv ? Date.parse(inv) : NaN
  const ageMs = Number.isFinite(invMs) ? Math.max(0, nowMs - invMs) : null
  return {
    inventoryAt: inv,
    valuationAt: val,
    ageMs,
    amber: ageMs === null || ageMs > FRESHNESS_AMBER_MS,
  }
}

// The view's flags column is a space-separated list: zero_cost inactive count_first nightly_qty.
export function parseFlags(flags) {
  return String(flags || '').split(/\s+/).filter(Boolean)
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))

// Stock Levels filters. 'in_stock' is the default view: 1,653 of 5,754 Product parts hold
// stock, and the zero rows are noise until someone asks for them.
export const STOCK_FILTERS = [
  { key: 'in_stock', label: 'In stock' },
  { key: 'all', label: 'All Product parts' },
  { key: 'critical', label: 'Critical (has a rule)' },
  { key: 'below', label: 'Below min' },
  { key: 'zero', label: 'Zero stock' },
  { key: 'no_cost', label: '$0 cost' },
]

export function matchesStockFilter(row, filter) {
  const onHand = num(row.on_hand) || 0
  switch (filter) {
    case 'all': return true
    case 'critical': return row.reorder_status !== null && row.reorder_status !== undefined
    case 'below': return row.reorder_status === 'below'
    case 'zero': return onHand <= 0
    case 'no_cost': return parseFlags(row.flags).includes('zero_cost')
    case 'in_stock':
    default: return onHand > 0
  }
}

export function matchesSearch(row, search, fields = ['part_number', 'description']) {
  const q = String(search || '').trim().toLowerCase()
  if (!q) return true
  return fields.some(f => String(row[f] ?? '').toLowerCase().includes(q))
}

export function filterStockRows(rows, { filter = 'in_stock', search = '' } = {}) {
  return (rows || []).filter(r => matchesStockFilter(r, filter) && matchesSearch(r, search))
}

export function stockFilterCounts(rows, search = '') {
  const out = {}
  for (const f of STOCK_FILTERS) out[f.key] = 0
  for (const r of rows || []) {
    if (!matchesSearch(r, search)) continue
    for (const f of STOCK_FILTERS) if (matchesStockFilter(r, f.key)) out[f.key]++
  }
  return out
}

// Numeric columns sort as numbers with nulls last in either direction; text columns sort
// case-insensitively. Ties fall back to part number so the order is stable.
const NUMERIC_KEYS = new Set(['on_hand', 'allocated', 'available', 'on_order', 'avg_cost', 'est_value', 'min_qty', 'shortfall'])

export function sortRows(rows, key, dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1
  const numeric = NUMERIC_KEYS.has(key)
  return [...(rows || [])].sort((a, b) => {
    const av = a[key]
    const bv = b[key]
    const aNull = av === null || av === undefined || av === ''
    const bNull = bv === null || bv === undefined || bv === ''
    if (aNull !== bNull) return aNull ? 1 : -1
    let c = 0
    if (!aNull) {
      c = numeric ? Number(av) - Number(bv) : String(av).localeCompare(String(bv), undefined, { sensitivity: 'base', numeric: true })
    }
    if (c !== 0) return c * sign
    return String(a.part_number ?? '').localeCompare(String(b.part_number ?? ''), undefined, { numeric: true })
  })
}

export function stockTotals(rows) {
  let value = 0
  let zeroCost = 0
  let parts = 0
  for (const r of rows || []) {
    parts++
    value += Number(r.est_value) || 0
    if (parseFlags(r.flags).includes('zero_cost')) zeroCost++
  }
  return { parts, value: Math.round(value * 100) / 100, zeroCost }
}

// One reading of a reorder rule's state for the UI. alert_state is authoritative — it is
// written by fb_reorder_evaluate() after every inventory refresh and after every edit — so
// the UI never re-derives "below" from the numbers; it only adds the shortfall and the
// on-order hint beside it.
export function reorderView(rule, status) {
  const active = rule?.is_active !== false
  const state = !active ? 'inactive' : (rule?.alert_state || 'ok')
  const min = num(rule?.min_qty)
  const onHand = num(status?.on_hand)
  const onOrder = num(status?.on_order) || 0
  const shortfall = state === 'below' && min !== null && onHand !== null ? Math.max(0, min - onHand) : 0
  const onOrderCovers = shortfall > 0 && onOrder >= shortfall
  const label = {
    ok: 'OK',
    below: 'Below min',
    no_min: 'No min set',
    no_row: 'Not in Fishbowl',
    inactive: 'Inactive',
  }[state] || state
  const tone = {
    ok: 'bg-green-900/50 text-green-300',
    below: 'bg-amber-900/50 text-amber-300',
    no_min: 'bg-gray-700 text-gray-300',
    no_row: 'bg-red-900/40 text-red-300',
    inactive: 'bg-gray-700 text-gray-400',
  }[state] || 'bg-gray-700 text-gray-300'
  return { state, label, tone, shortfall, onOrderCovers }
}

export function categoryRank(category) {
  const i = REORDER_CATEGORIES.indexOf(category)
  return i === -1 ? REORDER_CATEGORIES.length : i
}

// Rules grouped by category in the sheet's order, part numbers natural-sorted inside each.
export function groupByCategory(rules) {
  const groups = new Map()
  for (const r of rules || []) {
    const c = r.category || 'Misc.'
    if (!groups.has(c)) groups.set(c, [])
    groups.get(c).push(r)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => categoryRank(a) - categoryRank(b) || a.localeCompare(b))
    .map(([category, items]) => ({
      category,
      items: [...items].sort((x, y) => String(x.part_num).localeCompare(String(y.part_num), undefined, { numeric: true })),
    }))
}

// The key fb_reorder_points.part_key is generated from (upper(btrim(part_num))). The UI uses
// the same normalisation to refuse a duplicate before the unique constraint does.
export function partKey(partNum) {
  return String(partNum ?? '').trim().toUpperCase()
}

// A min_qty field: blank = no minimum (rule parked), otherwise a non-negative number.
export function parseMinQty(text) {
  const s = String(text ?? '').trim().replace(/,/g, '')
  if (s === '') return { ok: true, value: null }
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return { ok: false, value: null }
  return { ok: true, value: n }
}

// ilike pattern for a part-number search; % _ and \ are literal in a part number.
export function likePattern(q) {
  return `%${String(q ?? '').trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`
}
