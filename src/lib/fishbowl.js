// lib/fishbowl.js — Order Queue / Fishbowl mirror helpers (FB1, D-FB-08…D-FB-24).
// Single source of truth for Fishbowl status/type labels, disposition vocabulary,
// freshness math and every query/RPC the Order Queue uses. Nothing is computed inline in pages.
import { supabase } from './supabase'

// ── Fishbowl lookups (statement A of the FB1 discovery) ─────────────────────
export const FB_SO_STATUS = {
  10: 'Estimate', 20: 'Issued', 25: 'In Progress', 60: 'Fulfilled', 70: 'Closed Short',
  80: 'Voided', 85: 'Cancelled', 90: 'Expired', 95: 'Historical',
}
export const FB_SO_STATUS_COLORS = {
  10: 'bg-gray-800 text-gray-400 border-gray-700',
  20: 'bg-blue-900/40 text-blue-300 border-blue-800',
  25: 'bg-cyan-900/40 text-cyan-300 border-cyan-800',
  60: 'bg-green-900/40 text-green-300 border-green-800',
  70: 'bg-green-900/40 text-green-300 border-green-800',
  80: 'bg-red-900/40 text-red-300 border-red-800',
  85: 'bg-red-900/40 text-red-300 border-red-800',
  90: 'bg-red-900/40 text-red-300 border-red-800',
  95: 'bg-gray-800 text-gray-400 border-gray-700',
}
export const FB_LINE_STATUS = {
  10: 'Entered', 11: 'Awaiting Build', 12: 'Building', 14: 'Built', 20: 'Picking', 30: 'Partial',
  40: 'Picked', 50: 'Fulfilled', 60: 'Closed Short', 70: 'Voided', 75: 'Cancelled', 95: 'Historical',
}
export const FB_LINE_TYPE = {
  10: 'Sale', 11: 'Misc Sale', 12: 'Drop Ship', 20: 'Credit Return', 21: 'Misc Credit', 30: 'Discount %',
  31: 'Discount $', 40: 'Subtotal', 50: 'Assoc. Price', 60: 'Shipping', 70: 'Tax', 80: 'Kit', 90: 'Note',
}
export const FB_PRIORITY = { 10: 'Highest', 20: 'High', 30: 'Normal', 40: 'Low', 50: 'Lowest' }
export const FB_PRIORITY_COLORS = {
  10: 'text-red-300', 20: 'text-amber-300', 30: 'text-gray-400', 40: 'text-gray-500', 50: 'text-gray-600',
}

export const PRODUCT_LINE_TYPES = [10, 12]
export const FB_CLOSED_LINE_STATUSES = [50, 60, 70, 75, 95]
export const OPEN_SO_STATUSES = [20, 25]

// ── Dispositions (D-FB-09, D-FB-21) ─────────────────────────────────────────
export const DISPOSITION_LABELS = {
  pending: 'Pending',
  production: 'Production',
  stock: 'Ship from stock',
  purchased: 'Purchase',
  covered: 'Covered by CO',
  assembly: 'Assembly',
  kit_header: 'Kit',
  ignore: 'Ignore',
  unlisted: 'Not produced',
}
export const DISPOSITION_COLORS = {
  pending: 'bg-amber-900/40 text-amber-300 border-amber-800',
  production: 'bg-purple-900/40 text-purple-300 border-purple-800',
  stock: 'bg-green-900/40 text-green-300 border-green-800',
  purchased: 'bg-blue-900/40 text-blue-300 border-blue-800',
  covered: 'bg-gray-800 text-gray-300 border-gray-600',
  assembly: 'bg-cyan-900/40 text-cyan-300 border-cyan-800',
  kit_header: 'bg-gray-800 text-gray-400 border-gray-700',
  ignore: 'bg-gray-800 text-gray-500 border-gray-700',
  unlisted: 'bg-gray-800 text-gray-500 border-gray-700',
}
// What a human may set by hand (production is only reachable through Create CO).
export const MANUAL_DISPOSITIONS = [
  { value: 'stock', label: 'Ship from stock' },
  { value: 'purchased', label: 'Purchase' },
  { value: 'assembly', label: 'Assembly' },
  { value: 'covered', label: 'Covered by existing CO' },
  { value: 'ignore', label: 'Ignore' },
  { value: 'pending', label: 'Back to pending' },
]

export const RESOLUTION_LABELS = {
  part: 'SkyNet part',
  kit: 'Kit SKU',
  unlisted_skybolt: 'Not in SkyNet',
  unlisted: 'Purchased item',
  n_a: '',
}
export const RESOLUTION_COLORS = {
  part: 'text-green-400',
  kit: 'text-purple-300',
  unlisted_skybolt: 'text-amber-300',
  unlisted: 'text-gray-500',
  n_a: 'text-gray-600',
}

// ── Dates (Decisions.md "Date/timezone — local-noon UTC": never new Date('YYYY-MM-DD')) ──
export function formatDate(dateStr) {
  if (!dateStr) return '—'
  const [y, m, d] = String(dateStr).split('-')
  if (!y || !m || !d) return dateStr
  return new Date(Number(y), Number(m) - 1, Number(d), 12).toLocaleDateString()
}

export function formatDateShort(dateStr) {
  if (!dateStr) return '—'
  const [y, m, d] = String(dateStr).split('-')
  if (!y || !m || !d) return dateStr
  return `${Number(m)}/${Number(d)}/${String(y).slice(-2)}`
}

// Same window as v_fb_order_queue.suspect_dates (D-FB-24) — Fishbowl has real year-206 dates.
export function isSuspectDate(dateStr) {
  if (!dateStr) return false
  const y = Number(String(dateStr).slice(0, 4))
  return Number.isFinite(y) && (y < 2000 || y > 2100)
}

export function formatDateTime(ts) {
  if (!ts) return '—'
  const dt = new Date(ts)
  if (Number.isNaN(dt.getTime())) return String(ts)
  return dt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// Fishbowl header dates (dateCreated / dateIssued) are midnight-local timestamps; show the local calendar day.
export function formatTsDateShort(ts) {
  if (!ts) return '—'
  const dt = new Date(ts)
  if (Number.isNaN(dt.getTime())) return String(ts)
  return `${dt.getMonth() + 1}/${dt.getDate()}/${String(dt.getFullYear()).slice(-2)}`
}

// ── Bridge freshness (heartbeat every ~20 s; amber > 2 min, red > 10 min) ───
export function formatAge(sec) {
  if (sec === null || sec === undefined) return '—'
  if (sec < 60) return `${sec} s`
  if (sec < 3600) return `${Math.round(sec / 60)} min`
  if (sec < 86400) return `${Math.round(sec / 3600)} h`
  return `${Math.round(sec / 86400)} d`
}

export function syncFreshness(state, nowMs = Date.now()) {
  if (!state?.last_heartbeat_at) {
    return { level: 'unknown', ageSec: null, label: 'Fishbowl sync: no heartbeat yet' }
  }
  const ageSec = Math.max(0, Math.round((nowMs - Date.parse(state.last_heartbeat_at)) / 1000))
  const level = ageSec > 600 ? 'down' : ageSec > 120 ? 'stale' : 'ok'
  const label =
    level === 'ok' ? `Fishbowl sync live · heartbeat ${formatAge(ageSec)} ago`
      : level === 'stale' ? `Fishbowl sync stale · last heartbeat ${formatAge(ageSec)} ago`
        : `Fishbowl sync down · last heartbeat ${formatAge(ageSec)} ago`
  return { level, ageSec, label }
}

// ── Line predicates ────────────────────────────────────────────────────────
export function coQtyForLine(line) {
  const q = line.qty_to_fulfill ?? (Number(line.qty_ordered || 0) - Number(line.qty_fulfilled || 0))
  return Math.round(Number(q) || 0)
}

// Lines a human can disposition: product or kit lines, still present, not already turned into a CO line.
export function isSelectableLine(line) {
  if (!line || line.removed_at) return false
  if (line.customer_order_line_id) return false
  return PRODUCT_LINE_TYPES.includes(line.type_id) || line.type_id === 80
}

// Why a line cannot become a CO line right now (null = convertible). Mirrors fb_convert_to_co's checks.
export function convertBlocker(line) {
  if (!line || line.removed_at) return 'removed in Fishbowl'
  if (line.customer_order_line_id) return 'already linked to a CO line'
  if (!PRODUCT_LINE_TYPES.includes(line.type_id)) return 'not a product line'
  if (!line.part_id) return 'part not in SkyNet'
  if (line.part && line.part.is_active === false) return 'part inactive in SkyNet — reactivate in Armory'
  if (FB_CLOSED_LINE_STATUSES.includes(line.status_id)) return 'closed in Fishbowl'
  if (coQtyForLine(line) <= 0) return 'nothing left to fulfill'
  return null
}

export function displayPartNumber(line) {
  return line.part?.part_number || line.part_num || line.product_num || '—'
}

// Kit structure for display (D-FB-29): children sit under their kit header, labelled 1a, 1b …
// Returns [{ line, depth, label, childCount }] in render order.
export function buildKitTree(lines) {
  const byParent = new Map()
  for (const l of lines) {
    if (l.parent_fb_soitem_id) {
      if (!byParent.has(l.parent_fb_soitem_id)) byParent.set(l.parent_fb_soitem_id, [])
      byParent.get(l.parent_fb_soitem_id).push(l)
    }
  }
  const ids = new Set(lines.map((l) => l.fb_soitem_id))
  const out = []
  for (const l of lines) {
    if (l.parent_fb_soitem_id && ids.has(l.parent_fb_soitem_id)) continue // rendered under its header
    const children = byParent.get(l.fb_soitem_id) || []
    out.push({ line: l, depth: 0, label: String(l.line_number), childCount: children.length })
    children.forEach((c, i) => {
      out.push({ line: c, depth: 1, label: `${l.line_number}${String.fromCharCode(97 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}`, childCount: 0 })
    })
  }
  return out
}

// One CO line per part (D-FB-26): what a conversion of these lines would produce.
export function groupLinesByPart(lines) {
  const groups = new Map()
  for (const l of lines) {
    const key = l.part_id || `nopart:${l.fb_soitem_id}`
    if (!groups.has(key)) {
      groups.set(key, { key, part_id: l.part_id, part_number: displayPartNumber(l), lines: [], qty: 0, due: null, hasDefaultDate: false })
    }
    const g = groups.get(key)
    g.lines.push(l)
    g.qty += coQtyForLine(l)
    if (l.effective_due_date && (!g.due || l.effective_due_date < g.due)) g.due = l.effective_due_date
    if (l.due_date_is_default) g.hasDefaultDate = true
  }
  return [...groups.values()]
}

// ── Data access ────────────────────────────────────────────────────────────
export async function getSyncState() {
  const { data, error } = await supabase.from('fb_sync_state').select('*').eq('id', 1).maybeSingle()
  if (error) throw error
  return data
}

export async function getQueueOrders() {
  const { data, error } = await supabase
    .from('v_fb_order_queue')
    .select('*')
    .in('status_id', OPEN_SO_STATUSES)
    .order('fb_date_created', { ascending: true, nullsFirst: false })
    .order('so_number', { ascending: true })
  if (error) throw error
  return data || []
}

const LINE_SELECT = `
  fb_soitem_id, fb_so_id, line_number, type_id, status_id, product_num, part_num, description,
  qty_ordered, qty_fulfilled, qty_to_fulfill, effective_due_date, due_date_is_default, remaining_parts_ship_date,
  customer_part_num, rev_level, resolution, disposition, disposition_at, disposition_note,
  part_id, kit_sku_id, customer_order_line_id, removed_at, parent_fb_soitem_id,
  part:parts(part_number, part_type, is_active),
  kit:kit_skus(part_number),
  co_line:customer_order_lines(line_number, status, quantity_ordered, customer_order:customer_orders(co_number)),
  disposition_by_profile:profiles(full_name)
`

export async function getQueueLines(fbSoId) {
  const { data, error } = await supabase
    .from('fb_sales_order_lines')
    .select(LINE_SELECT)
    .eq('fb_so_id', fbSoId)
    .is('removed_at', null)
    .order('line_number', { ascending: true })
  if (error) throw error
  return data || []
}

// ── RPC wrappers (SECURITY DEFINER, gated server-side: order_processor / admin) ──
export async function setDisposition(lineIds, disposition, note) {
  const { data, error } = await supabase.rpc('fb_set_disposition', {
    p_line_ids: lineIds, p_disposition: disposition, p_note: note || null,
  })
  if (error) throw error
  return data
}

// components: { [part_id]: 'Components Needed text' } — required by the RPC for every NEW CO line (D-FB-27).
export async function convertToCO(fbSoId, lineIds, components = {}) {
  const { data, error } = await supabase.rpc('fb_convert_to_co', {
    p_fb_so_id: fbSoId, p_line_ids: lineIds, p_components: components,
  })
  if (error) throw error
  return data
}

// The CO a conversion would append to, with its open lines, so the modal can say "adds to line #n".
export async function getCOSummary(customerOrderId) {
  if (!customerOrderId) return null
  const { data, error } = await supabase
    .from('customer_orders')
    .select('id, co_number, status, po_number, created_at, customer_order_lines(id, line_number, part_id, status, quantity_ordered, components_needed)')
    .eq('id', customerOrderId)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function reresolveLines() {
  const { data, error } = await supabase.rpc('fb_reresolve_lines', {})
  if (error) throw error
  return data
}

export async function ackEvent(eventId) {
  const { error } = await supabase.rpc('fb_ack_event', { p_event_id: eventId })
  if (error) throw error
}
