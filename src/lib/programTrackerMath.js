// Pure helpers for the Giza program tracker dashboard (S15, D-GIZA; branch model D-GIZA-21..27).
// No imports — unit-tested by: node src/lib/programTrackerMath.test.mjs
//
// A "lot" here is a branch: one row of v_program_final_lots, carrying its own trail
// (nut / nylon / plating / dry film / FLN / cage / retainer) and its own buckets
// (waiting_insert, waiting_plating, at_electrolab, waiting_paint, in_paint, in_oven,
// waiting_assembly, assembled_qty). Dates are 'YYYY-MM-DD'; date-only values become Dates at
// local noon so a timezone never moves them a day.

export const STAGE_LABELS = {
  received: 'Steel nut receipt',
  received_nut: 'Steel nut receipt',
  received_cage: 'Cages received',
  received_retainer: 'Retainers received',
  received_insert: 'Nylon inserts received',
  washer_inserted: 'Insert nylon',
  sent_plating: 'Sent to Electrolab',
  returned_plating: 'Back from Electrolab',
  painted: 'Painted',
  baked: 'Baked',
  assembled: 'Assembled',
}

export const SPLIT_REASON_LABELS = {
  nylon_lot: 'different nylon lot',
  plating_lot: 'different plating lot',
  dry_film_lot: 'different dry-film lot',
  cage_lot: 'different cage lot',
  retainer_lot: 'different retainer lot',
  component_lots: 'different cage and retainer lots',
  after_close: 'continued after the lot closed',
}

// Stages a nut moves through after receipt; the constraint is the slowest of these.
export const FLOW_STAGES = ['washer_inserted', 'sent_plating', 'returned_plating', 'painted', 'baked', 'assembled']
export const THROUGHPUT_STAGES = ['received_nut', ...FLOW_STAGES]

// For each loggable move: the lot column holding the pieces waiting for it.
export const SOURCE_BUCKET = {
  washer_inserted: 'waiting_insert',
  sent_plating: 'waiting_plating',
  returned_plating: 'at_electrolab',
  assembled: 'waiting_assembly',
}

// The lot attributes each move sets — a different value from the lot's own splits it (D-GIZA-22).
export const STAGE_ATTRS = {
  washer_inserted: ['insert_lot'],
  sent_plating: [],
  returned_plating: ['plating_lot'],
  assembled: ['cage_lot', 'retainer_lot'],
}

const IN_PROCESS_COLUMNS = ['waiting_insert', 'waiting_plating', 'at_electrolab', 'waiting_paint', 'in_paint', 'in_oven', 'waiting_assembly']

const norm = (v) => (v == null ? '' : String(v).trim())
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const lotNo = (l) => parseInt(l?.lot_number, 10) || 0

export function isoDay(date) {
  const d = date instanceof Date ? date : new Date(date)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + n)
  return isoDay(d)
}

export function lastNDays(todayIso, n) {
  const out = []
  for (let i = n - 1; i >= 0; i--) out.push(addDays(todayIso, -i))
  return out
}

export function ageDays(isoOrTs, todayIso) {
  if (!isoOrTs) return null
  const day = String(isoOrTs).length > 10 ? isoDay(new Date(isoOrTs)) : String(isoOrTs)
  const a = new Date(`${day}T12:00:00`).getTime()
  const b = new Date(`${todayIso}T12:00:00`).getTime()
  return Math.max(0, Math.round((b - a) / 86400000))
}

export function dailyMatrix(dailyRows, stages, days) {
  const idx = new Map(days.map((d, i) => [d, i]))
  const out = Object.fromEntries(stages.map(s => [s, days.map(() => 0)]))
  for (const r of dailyRows || []) {
    const i = idx.get(norm(r.d))
    if (i == null || !out[r.stage]) continue
    out[r.stage][i] += num(r.qty)
  }
  return out
}

export function sevenDayRates(dailyRows, todayIso, window = 7) {
  const days = new Set(lastNDays(todayIso, window))
  const totals = {}
  for (const r of dailyRows || []) {
    if (!days.has(norm(r.d))) continue
    totals[r.stage] = (totals[r.stage] || 0) + num(r.qty)
  }
  const rates = {}
  for (const [k, v] of Object.entries(totals)) rates[k] = v / window
  return rates
}

export function constrainingStage(rates, stages = FLOW_STAGES) {
  let best = null
  for (const s of stages) {
    const r = num(rates?.[s])
    if (best === null || r < best.rate) best = { stage: s, rate: r }
  }
  return best || { stage: null, rate: 0 }
}

export function forecast(openQty, ratePerDay, todayIso) {
  const open = num(openQty)
  if (open <= 0) return { days: 0, date: todayIso }
  const rate = num(ratePerDay)
  if (rate <= 0) return null
  const days = Math.ceil(open / rate)
  return { days, date: addDays(todayIso, days) }
}

export function ovenCapacity(ovensCommissioned, loadQty, loadsPerDay) {
  return num(ovensCommissioned) * num(loadQty) * num(loadsPerDay)
}

// Pieces of a lot still upstream of assembly.
export function inProcess(lot) {
  return IN_PROCESS_COLUMNS.reduce((s, c) => s + num(lot?.[c]), 0)
}

// Lots holding pieces that can make `stage`'s move, oldest number first. Closed lots count:
// moving their leftovers continues them as a new lot (D-GIZA-25).
export function lotsReadyFor(lots, stage) {
  const col = SOURCE_BUCKET[stage]
  if (!col) return []
  return (lots || [])
    .filter(l => ['active', 'closed'].includes(l.status) && num(l[col]) > 0)
    .map(l => ({ id: l.id, lot: norm(l.lot_number), qty: num(l[col]), row: l }))
    .sort((a, b) => lotNo(a.row) - lotNo(b.row))
}

// What the server will do with a move — mirrors _program_route so the modal can warn before saving.
export function previewRoute(lot, stage, values) {
  if (!lot) return { split: false }
  if (lot.status === 'closed') return { split: true, reason: 'after_close' }
  const keys = STAGE_ATTRS[stage] || []
  const mismatch = keys.filter(k => {
    const have = norm(lot[k])
    const want = norm(values?.[k])
    return have && want && have !== want
  })
  if (mismatch.length === 0) return { split: false }
  if (stage === 'washer_inserted') return { split: true, reason: 'nylon_lot' }
  if (stage === 'returned_plating') return { split: true, reason: 'plating_lot' }
  if (mismatch.length === 2) return { split: true, reason: 'component_lots' }
  return { split: true, reason: mismatch[0] }
}

// Lots worth a pipeline view: active ones, and closed ones that still hold pieces in process.
export function selectableLots(lots) {
  return (lots || [])
    .filter(l => l.status === 'active' || (l.status === 'closed' && inProcess(l) > 0))
    .sort((a, b) => lotNo(a) - lotNo(b))
}

// Register order (D-GIZA-27a): one sequence, newest lot number first, every status together
// (3007, 3006, 3005-2, 3005 ...). A suffixed lot sits just above its base number; void lots go last.
export function sortLots(lots) {
  const isVoid = (l) => (l.status === 'void' ? 1 : 0)
  return [...(lots || [])].sort((a, b) =>
    isVoid(a) - isVoid(b) ||
    lotNo(b) - lotNo(a) ||
    String(b.lot_number).localeCompare(String(a.lot_number), 'en', { numeric: true }))
}

// A closed lot can be reopened (admin) until its leftovers have continued as another lot.
export function canReopen(lot, lots) {
  if (lot?.status !== 'closed') return false
  return !(lots || []).some(c => c.parent_lot_id === lot.id && c.split_reason === 'after_close' && c.status !== 'void')
}

// Pipeline card values for one lot, or program totals when no lot is selected.
export function bucketValues(pipeline, lot) {
  if (lot) {
    return {
      receipt: num(lot.waiting_insert), nylon: num(lot.waiting_plating), electrolab: num(lot.at_electrolab),
      plating: num(lot.waiting_paint), paint: num(lot.in_paint), oven: num(lot.in_oven),
      baked: num(lot.waiting_assembly), assembled: num(lot.assembled_qty), shipped: null,
    }
  }
  const p = pipeline || {}
  return {
    receipt: num(p.waiting_washer), nylon: num(p.waiting_plating), electrolab: num(p.at_electrolab),
    plating: num(p.waiting_paint), paint: num(p.in_paint), oven: num(p.in_oven),
    baked: num(p.waiting_assembly), assembled: num(p.waiting_ship), shipped: num(p.shipped_since_start),
  }
}

// Received lots of one component part, newest first (nylon / cage / retainer pickers).
export function componentLots(ledger, partId) {
  const map = new Map()
  for (const e of ledger || []) {
    if (e.voided_at || e.stage !== 'received' || e.part_id !== partId) continue
    const k = norm(e.lot_number)
    if (!k) continue
    const m = map.get(k) || { lot: k, qty: 0, date: null }
    m.qty += num(e.qty)
    if (!m.date || norm(e.entry_date) > m.date) m.date = norm(e.entry_date)
    map.set(k, m)
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.lot.localeCompare(b.lot)))
}

export function recentInitials(ledger, limit = 6) {
  const out = []
  for (const e of ledger || []) {
    const v = norm(e.done_by).toUpperCase()
    if (v && !out.includes(v)) out.push(v)
    if (out.length >= limit) break
  }
  return out
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Self-contained 4 in × 2 in bag label; prints itself on load. Brand: Arial, Skybolt red #B8222E.
export function lotLabelHtml({ lotNumber, partLabel, qty, dateText }) {
  const e = escapeHtml
  return `<!doctype html><html><head><meta charset="utf-8"><title>Lot ${e(lotNumber)}</title>
<style>
@page { size: 4in 2in; margin: 0.12in; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; }
.label { width: 3.76in; height: 1.76in; border: 2px solid #000; padding: 0.1in 0.14in; display: flex; flex-direction: column; justify-content: space-between; }
.brand { color: #B8222E; font-weight: 700; font-size: 11pt; letter-spacing: 0.06em; }
.row { display: flex; justify-content: space-between; align-items: baseline; }
.k { color: #707172; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.05em; }
.part { font-size: 16pt; font-weight: 700; }
.lot { font-size: 30pt; font-weight: 700; line-height: 1; }
.v { font-size: 12pt; font-weight: 700; }
</style></head><body onload="window.print()">
<div class="label">
  <div class="brand">SKYBOLT AEROSPACE FASTENERS</div>
  <div class="row"><div><div class="k">Part</div><div class="part">${e(partLabel)}</div></div>
  <div style="text-align:right"><div class="k">Lot</div><div class="lot">${e(lotNumber)}</div></div></div>
  <div class="row"><div><span class="k">Qty </span><span class="v">${e(Number(qty || 0).toLocaleString('en-US'))}</span></div>
  <div><span class="k">Date </span><span class="v">${e(dateText)}</span></div></div>
</div>
</body></html>`
}
