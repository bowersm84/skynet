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

export const FB_LOCATION_GROUPS = {
  1: 'Main', 2: 'Skybolt1', 3: 'Skybolt2', 4: 'Skybolt', 5: 'Skybolt>2', 6: 'Warehouse', 7: 'Material', 8: 'Manufacturing',
}

export const EVENT_LABELS = {
  so_created: 'SO issued',
  so_changed: 'SO changed',
  so_status_changed: 'SO status',
  so_removed: 'SO deleted in Fishbowl',
  line_added: 'Line added',
  line_changed: 'Line changed',
  line_status_changed: 'Line status',
  line_removed: 'Line removed',
}
export const EVENT_COLORS = {
  so_created: 'bg-blue-900/40 text-blue-300 border-blue-800',
  so_changed: 'bg-gray-800 text-gray-300 border-gray-700',
  so_status_changed: 'bg-cyan-900/40 text-cyan-300 border-cyan-800',
  so_removed: 'bg-red-900/40 text-red-300 border-red-800',
  line_added: 'bg-green-900/40 text-green-300 border-green-800',
  line_changed: 'bg-gray-800 text-gray-300 border-gray-700',
  line_status_changed: 'bg-cyan-900/40 text-cyan-300 border-cyan-800',
  line_removed: 'bg-red-900/40 text-red-300 border-red-800',
}
const CHANGE_FIELD_LABELS = {
  status_id: 'status', qty_ordered: 'ordered', qty_fulfilled: 'shipped', qty_to_fulfill: 'to fulfill',
  effective_due_date: 'due', remaining_parts_ship_date: 'Remaining Parts Ship Date', product_num: 'product',
  customer_po: 'PO', priority_id: 'priority', salesman: 'salesperson', customer_name: 'customer', note: 'note',
  so_number: 'SO', reappeared: 'reappeared', disposition: 'disposition',
}

// "ordered 800 → 1,000 · due 8/24/26 → 9/4/26" from an fb_sync_events.changes object.
export function summarizeChanges(changes, eventType) {
  if (!changes || typeof changes !== 'object') return ''
  const fmt = (field, v) => {
    if (v === null || v === undefined || v === '') return '—'
    if (field === 'status_id') return eventType?.startsWith('line') ? (FB_LINE_STATUS[v] || v) : (FB_SO_STATUS[v] || v)
    if (field === 'priority_id') return FB_PRIORITY[v] || v
    if (field === 'effective_due_date' || field === 'remaining_parts_ship_date') return formatDateShort(v)
    if (['so_number', 'product_num', 'customer_po', 'salesman', 'customer_name', 'note', 'disposition'].includes(field)) return String(v)
    if (typeof v === 'number') return v.toLocaleString()
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v).toLocaleString()
    return String(v)
  }
  return Object.entries(changes).map(([field, val]) => {
    const label = CHANGE_FIELD_LABELS[field] || field
    if (val && typeof val === 'object' && ('old' in val || 'new' in val)) return `${label} ${fmt(field, val.old)} → ${fmt(field, val.new)}`
    return `${label} ${fmt(field, val)}`
  }).join(' · ')
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
// D-FB-50: "Covered by existing CO" is retired — a line that needs production is converted with Create CO
// and like parts are combined at Create WO (D-FB-43). fb_set_disposition refuses 'covered'; the label and
// colour above stay so lines that already carry it still read correctly until they go Back to pending.
export const MANUAL_DISPOSITIONS = [
  { value: 'stock', label: 'Ship from stock' },
  { value: 'purchased', label: 'Purchase' },
  { value: 'assembly', label: 'Assembly' },
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
// Remaining demand = ordered − shipped (D-FB-36). Fishbowl's qtyToFulfill is the NEXT fulfillment quantity and
// keeps its last value after a line is fully shipped, so it cannot be used as "remaining".
export function coQtyForLine(line) {
  return Math.max(Math.round(Number(line.qty_ordered || 0) - Number(line.qty_fulfilled || 0)), 0)
}

// Fulfilled / Closed Short / Voided / Cancelled / Historical in Fishbowl — nothing left to decide.
export function isClosedLine(line) {
  return FB_CLOSED_LINE_STATUSES.includes(line?.status_id)
}

// Lines a human can disposition: product or kit lines, still present, not already turned into a CO line.
export function isSelectableLine(line) {
  if (!line || line.removed_at) return false
  if (line.customer_order_line_id) return false
  if (isClosedLine(line)) return false
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

// Kit structure for display (D-FB-29): children sit indented under their kit header. D-FB-45: each
// child is labelled with its own Fishbowl line number (was 1a, 1b …) — the same number its CO line carries.
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
      out.push({ line: c, depth: 1, label: String(c.line_number), childCount: 0, kitIndex: i })
    })
  }
  return out
}

// D-FB-43: one CO line per Fishbowl line — a release keeps its own quantity and due date, and like
// parts are combined later at Create WO if the scheduler wants one run. Lines are grouped by part
// here only so the Create CO modal asks the component question once per part (supersedes D-FB-26).
export function groupLinesForConversion(lines) {
  const groups = new Map()
  for (const l of [...lines].sort((a, b) => (a.line_number || 0) - (b.line_number || 0))) {
    const key = l.part_id || `nopart:${l.fb_soitem_id}`
    if (!groups.has(key)) {
      groups.set(key, { key, part_id: l.part_id, part_number: displayPartNumber(l), part_type: l.part?.part_type || null, lines: [], qty: 0 })
    }
    const g = groups.get(key)
    g.lines.push(l)
    g.qty += coQtyForLine(l)
  }
  return [...groups.values()]
}

// D-FB-44: what the Order Queue shows as Prod Due for a CO-linked line, from a v_co_line_dates row.
// finish = latest scheduled job end on the allocated work orders (the last component off the
// machine; assembly, plating and finishing are not in it); unsched = a WO exists but nothing is
// scheduled; target = no scheduled work at all, so the SkyNet target stands in.
export function prodDueForLine(d) {
  if (!d) return null
  const target = d.target_date || null
  if (d.scheduled_finish) {
    return { kind: 'finish', date: d.scheduled_finish, partial: !!d.has_unscheduled_jobs, late: !!(target && d.scheduled_finish > target), target }
  }
  if (d.has_unscheduled_jobs) return { kind: 'unsched', date: null, partial: false, late: false, target }
  if (target) return { kind: 'target', date: target, partial: false, late: false, target }
  return null
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
  co_line:customer_order_lines(line_number, status, quantity_ordered, quantity_fulfilled, components_needed, customer_order:customer_orders(co_number)),
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

// D-FB-51: the part numbers on each open SO, for the queue search — product, part and the customer's
// own part number, lower-cased and space-joined per SO so `visible` can `includes()` them like the
// header fields. 50 SO ids per request and paged within the request, because a chunk of large SOs
// can exceed PostgREST's 1,000-row cap and a silently truncated page would hide a part from search.
// Product and kit lines only (the isSelectableLine set): shipping lines carry "Freight" / "UPS ACCT ON
// FILE" in product_num and their own codes in customer_part_num (153 of the 154 non-empty values on
// PROD's open lines, 2026-10-01) — none of it a part number.
export async function getQueuePartIndex(fbSoIds) {
  const ids = [...new Set((fbSoIds || []).filter((v) => v !== null && v !== undefined))]
  const sets = {}
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('fb_sales_order_lines')
        .select('fb_so_id, product_num, part_num, customer_part_num')
        .in('fb_so_id', chunk)
        .in('type_id', [...PRODUCT_LINE_TYPES, 80])
        .is('removed_at', null)
        .order('fb_soitem_id', { ascending: true })
        .range(from, from + 999)
      if (error) throw error
      for (const r of data || []) {
        const s = (sets[r.fb_so_id] ||= new Set())
        for (const v of [r.product_num, r.part_num, r.customer_part_num]) if (v) s.add(String(v).trim().toLowerCase())
      }
      if (!data || data.length < 1000) break
    }
  }
  const out = {}
  for (const [id, s] of Object.entries(sets)) out[id] = [...s].join(' ')
  return out
}

// ── RPC wrappers (SECURITY DEFINER, gated server-side: order_processor / admin) ──
// components: { [fb_soitem_id]: [component uuid, …] } — required by the RPC when disposition is
// 'purchased' and the line's part has a bill of materials (D-FB-42); ignored otherwise.
export async function setDisposition(lineIds, disposition, note, components = {}) {
  const { data, error } = await supabase.rpc('fb_set_disposition', {
    p_line_ids: lineIds, p_disposition: disposition, p_note: note || null, p_components: components || {},
  })
  if (error) throw error
  return data
}

// components: { [part_id]: { components: [uuid, …], note: text | null } } — at least one component per
// part is required by the RPC (D-FB-42); every selected Fishbowl line becomes its own CO line (D-FB-43).
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

// D-FB-44: everything the line dropdown needs for a set of CO line ids, in three chunked reads —
// dates (v_co_line_dates, the same view the Orders and Demand tabs read), per-component job state
// (v_co_line_component_status) and active allocations with their work orders.
// → { [co_line_id]: { dates, components: [], allocations: [] } }
export async function getLineDetail(coLineIds) {
  const ids = [...new Set((coLineIds || []).filter(Boolean))]
  const out = {}
  for (const id of ids) out[id] = { dates: null, components: [], allocations: [] }
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150)
    const [d, c, a] = await Promise.all([
      supabase.from('v_co_line_dates')
        .select('customer_order_line_id, entered_on, target_date, fb_due_date, fb_due_is_default, scheduled_finish, has_unscheduled_jobs')
        .in('customer_order_line_id', chunk),
      supabase.from('v_co_line_component_status')
        .select('customer_order_line_id, component_id, part_number, description, part_type, requested, job_count, latest_scheduled_end, has_unscheduled, state, jobs')
        .in('customer_order_line_id', chunk),
      supabase.from('customer_order_allocations')
        .select('customer_order_line_id, quantity_allocated, work_order:work_orders(id, wo_number, status, due_date)')
        .in('customer_order_line_id', chunk).eq('is_active', true),
    ])
    if (d.error) throw d.error
    if (c.error) throw c.error
    if (a.error) throw a.error
    for (const r of d.data || []) if (out[r.customer_order_line_id]) out[r.customer_order_line_id].dates = r
    for (const r of c.data || []) if (out[r.customer_order_line_id]) out[r.customer_order_line_id].components.push(r)
    for (const r of a.data || []) if (out[r.customer_order_line_id]) out[r.customer_order_line_id].allocations.push(r)
  }
  for (const v of Object.values(out)) {
    // requested components first, then the WO-only ones, each alphabetical
    v.components.sort((x, y) => (Number(y.requested) - Number(x.requested)) || String(x.part_number).localeCompare(String(y.part_number)))
    v.allocations.sort((x, y) => String(x.work_order?.wo_number || '').localeCompare(String(y.work_order?.wo_number || '')))
  }
  return out
}

// D-FB-42: the components an order processor said are being bought, per Fishbowl line.
// → { [fb_soitem_id]: [{ component_id, component: { part_number, part_type } }] }
export async function getPurchaseComponents(fbSoitemIds) {
  const ids = [...new Set((fbSoitemIds || []).filter(Boolean))]
  const out = {}
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from('fb_line_purchase_components')
      .select('fb_soitem_id, component_id, component:parts(part_number, part_type)')
      .in('fb_soitem_id', ids.slice(i, i + 200))
    if (error) throw error
    for (const r of data || []) {
      if (!out[r.fb_soitem_id]) out[r.fb_soitem_id] = []
      out[r.fb_soitem_id].push(r)
    }
  }
  for (const v of Object.values(out)) v.sort((x, y) => String(x.component?.part_number || '').localeCompare(String(y.component?.part_number || '')))
  return out
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

// D-FB-48: resolve an exception where it is raised. action 'apply_qty' | 'cancel_lines'; the RPC does
// the work (co_cancel_line for cancels), then acknowledges the event. Returns its result jsonb.
export async function resolveException(eventId, action, note = null) {
  const { data, error } = await supabase.rpc('fb_resolve_exception', {
    p_event_id: eventId, p_action: action, p_note: note || null,
  })
  if (error) throw error
  return data
}

// D-FB-48: which resolutions a v_fb_recent_changes exception row offers besides Acknowledge. Same
// conditions fb_resolve_exception checks, so the tab never offers what the RPC will refuse outright
// (it still refuses a cancel on a line combined before D-FB-43, and a quantity cut the WO still covers).
export function exceptionActions(e) {
  const c = e?.changes || {}
  const openLine = !!e?.customer_order_line_id && ['not_started', 'in_progress'].includes(e?.co_line_status)
  const qty = !!(c.qty_ordered && typeof c.qty_ordered === 'object')
  const productChanged = e?.event_type === 'line_changed' && !!(c.product_num && typeof c.product_num === 'object')
  const lineGone = ['line_removed', 'line_status_changed'].includes(e?.event_type)
  const soGone = ['so_status_changed', 'so_removed'].includes(e?.event_type)
  return {
    applyQty: qty && openLine,
    cancel: ((lineGone || productChanged) && openLine) || (soGone && !!e?.customer_order_id),
    cancelLabel: soGone ? 'Cancel CO lines' : 'Cancel CO line',
    requeue: productChanged,
  }
}

// ── Inventory snapshot (D-FB-33) ───────────────────────────────────────────
export async function getInventoryFor(partNums) {
  const keys = [...new Set((partNums || []).filter(Boolean))]
  if (keys.length === 0) return {}
  const out = {}
  for (let i = 0; i < keys.length; i += 200) {
    const { data, error } = await supabase.from('fb_part_inventory').select('*').in('part_num', keys.slice(i, i + 200))
    if (error) throw error
    for (const r of data || []) out[r.part_num] = r
  }
  return out
}

// D-FB-39. One reading of a fb_part_inventory row, shared by the Order Queue Avail cell
// and Create WO so the two surfaces cannot drift.
//
// opts: { need = 0, lastInventoryAt = null, openJobs = null }
// → { state, onHand, allocated, notAvailable, onOrder, free, tone, text, compactText, title, asOf }
//
// free is always qty_available — the D-FB-33 definition (the bridge's available location
// groups). D-FB-39a: a second "free to use" basis summed across every group was removed
// before merge; a read of Fishbowl on 2026-09-23 put 4,784 of 4,787 inventory-totals rows
// in Main and none in Material or Manufacturing, so it produced the same number under a
// different explanation.
//
// state: no row → not_in_fishbowl; row older than 10 min before the cycle's
//        last_inventory_at → stale.
//
// D-FB-41 (bridge 1.6.0 live on PROD, 2026-09-23): the bridge now keeps a row for every
// Fishbowl part SkyNet knows and re-reads all of them every cycle (D-FB-40), so the two
// states finally mean what they say. No row means Fishbowl has no part with that number,
// or files it under a different one (SK244-116 is "SK241-16 OLD" in Fishbowl) — 22 SkyNet
// numbers on 2026-09-23. Stale means the bridge itself is behind, not that the part left
// its scope; nothing can leave scope now, which is why PROD went from 113 stale rows to 0.
// D-FB-39a's "not synced" wording was true only while the bridge read sales-order parts.
export function summarizeFbInventory(inv, opts = {}) {
  const { need = 0, lastInventoryAt = null, openJobs = null } = opts

  const openJobsSuffix = () => {
    if (!openJobs || !(Number(openJobs.qty) > 0)) return ''
    const jobs = openJobs.jobs || []
    const shown = jobs.slice(0, 3).map(j => `${j.job_number} (${String(j.status || '').replace(/_/g, ' ')})`)
    const more = jobs.length > 3 ? `, +${jobs.length - 3} more` : ''
    return `\n\nSkyNet: ${Number(openJobs.qty).toLocaleString()} in open jobs`
      + (shown.length ? ` — ${shown.join(', ')}${more}` : '')
  }

  if (!inv) {
    return {
      state: 'not_in_fishbowl',
      onHand: 0, allocated: 0, notAvailable: 0, onOrder: 0, free: 0,
      tone: 'text-gray-500',
      text: 'Not in Fishbowl',
      compactText: 'not in FB',
      title: 'No Fishbowl part with this number. The bridge keeps a row for every Fishbowl part SkyNet knows (D-FB-40), so a part with no row is not in Fishbowl — or Fishbowl files it under a different part number.'
        + openJobsSuffix(),
      asOf: null,
    }
  }

  const onHand = Number(inv.qty_on_hand || 0)
  const allocated = Number(inv.qty_allocated || 0)
  const notAvailable = Number(inv.qty_not_available || 0)
  const onOrder = Number(inv.qty_on_order || 0)
  const byLocEntries = Object.entries(inv.by_location || {})

  const free = Number(inv.qty_available ?? 0)

  const stale = !!(lastInventoryAt && inv.snapshot_at
    && Date.parse(inv.snapshot_at) < Date.parse(lastInventoryAt) - 10 * 60 * 1000)
  const state = stale ? 'stale' : 'current'

  // Exactly the pre-D-FB-39 AvailCell rule; stale never reads as good news.
  const tone = stale
    ? 'text-gray-500'
    : (free >= need && need > 0 ? 'text-green-300' : free > 0 ? 'text-amber-300' : 'text-gray-500')

  let text
  if (onHand <= 0) {
    text = 'None on hand' + (allocated > 0 ? ` · ${allocated.toLocaleString()} allocated` : '')
  } else if (free > 0) {
    text = `${free.toLocaleString()} free of ${onHand.toLocaleString()} on hand`
  } else {
    text = free < 0
      ? `${onHand.toLocaleString()} on hand, all allocated · ${(-free).toLocaleString()} short`
      : `${onHand.toLocaleString()} on hand, none free`
  }
  if (onOrder > 0) text += ` · ${onOrder.toLocaleString()} on order`

  // Byte-identical to the pre-D-FB-39 AvailCell tooltip: same expressions on the same
  // raw fields, so a string quirk there is reproduced here rather than silently fixed.
  const byLoc = byLocEntries
    .map(([lg, v]) => `${FB_LOCATION_GROUPS[lg] || `LG ${lg}`}: ${Number(v.onHand || 0).toLocaleString()} on hand, ${Number(v.allocated || 0).toLocaleString()} allocated`)
    .join('\n')
  const head = `Available ${Number(inv.qty_available ?? 0).toLocaleString()} (on hand ${Number(inv.qty_on_hand || 0).toLocaleString()} − allocated ${Number(inv.qty_allocated || 0).toLocaleString()} − not available ${Number(inv.qty_not_available || 0).toLocaleString()}; available location groups only)`

  let title = head
    + (inv.qty_on_order ? `\nOn order ${Number(inv.qty_on_order).toLocaleString()}` : '')
    + (byLoc ? `\n\n${byLoc}` : '')
    + (inv.snapshot_at ? `\n\nsnapshot ${formatDateTime(inv.snapshot_at)}` : '')
  if (stale) {
    title += `\n\nNot refreshed since ${formatDateTime(inv.snapshot_at)} — the bridge has not updated this row in its latest cycle. If this persists, check the bridge on skyserver.`
  }
  title += openJobsSuffix()

  return {
    state, onHand, allocated, notAvailable, onOrder, free, tone, text,
    compactText: `${onHand.toLocaleString()} on hand`,
    title,
    asOf: inv.snapshot_at || null,
  }
}

// ── Events: exceptions + recent changes (v_fb_recent_changes) ──────────────
export async function getOpenExceptions() {
  const { data, error } = await supabase
    .from('v_fb_recent_changes')
    .select('*')
    .eq('requires_ack', true)
    .is('acknowledged_at', null)
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw error
  return data || []
}

export async function getRecentEvents(limit = 200) {
  const { data, error } = await supabase
    .from('v_fb_recent_changes')
    .select('*')
    .order('id', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data || []
}

// ── Customer Orders tie-in ─────────────────────────────────────────────────
// Mirror rows keyed by SkyNet CO id and CO line id, for the FB chips on the Customer Orders page.
export async function getMirrorLinks() {
  const [sos, lines] = await Promise.all([
    supabase.from('fb_sales_orders').select('fb_so_id, so_number, status_id, customer_order_id, fb_date_last_modified')
      .not('customer_order_id', 'is', null).is('removed_at', null),
    supabase.from('fb_sales_order_lines').select('fb_soitem_id, line_number, status_id, qty_ordered, qty_fulfilled, qty_to_fulfill, customer_order_line_id')
      .not('customer_order_line_id', 'is', null).is('removed_at', null),
  ])
  if (sos.error) throw sos.error
  if (lines.error) throw lines.error
  const bySo = {}
  for (const r of sos.data || []) bySo[r.customer_order_id] = r
  const byLine = {}
  for (const r of lines.data || []) {
    if (!byLine[r.customer_order_line_id]) byLine[r.customer_order_line_id] = []
    byLine[r.customer_order_line_id].push(r)
  }
  return { bySo, byLine }
}

// The mirror SO for a Fishbowl order number typed into the Create CO modal (alphanumeric match like formatCONumber).
export async function findMirrorSO(orderNumber) {
  const key = String(orderNumber || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  if (!key) return null
  const { data, error } = await supabase
    .from('v_fb_order_queue')
    .select('fb_so_id, so_number, status_id, customer_name, pending_lines, production_lines, linked_co_number')
    .eq('so_number', key)
    .maybeSingle()
  if (error) throw error
  return data
}
