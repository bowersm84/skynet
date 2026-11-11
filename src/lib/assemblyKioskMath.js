// lib/assemblyKioskMath.js — pure helpers for the assembly kiosk (S17 Batch C, D-ASM-40).
// No I/O: board sorting, the lot-tile pick rules, coverage, the start payload, wave labels.
// Tested by assemblyKioskMath.test.mjs (node --test).

const PRIORITY_RANK = { critical: 0, high: 1, normal: 2, low: 3 }

// Most urgent first: priority, then the earliest due date (none last), then build number.
export function sortBuilds(builds) {
  return [...(builds || [])].sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority] ?? 2
    const pb = PRIORITY_RANK[b.priority] ?? 2
    if (pa !== pb) return pa - pb
    const da = a.earliest_due || '9999-12-31'
    const db = b.earliest_due || '9999-12-31'
    if (da !== db) return da < db ? -1 : 1
    return String(a.build_number || '').localeCompare(String(b.build_number || ''))
  })
}

// My builds = assigned to me; Open builds = assigned to nobody. Builds of other assemblers are not shown.
export function splitBoard(builds, operatorId) {
  const sorted = sortBuilds(builds)
  return {
    mine: sorted.filter((b) => b.assigned_to && b.assigned_to === operatorId),
    open: sorted.filter((b) => !b.assigned_to),
  }
}

// Program (Giza) builds run in two waves (D-ASM-17).
export function waveLabel(build) {
  if (!build || build.build_kind !== 'program') return null
  return Number(build.wave_current) === 2
    ? 'Wave 2 of 2 — final assembly'
    : 'Wave 1 of 2 — insert nylon'
}

// Oldest received first; a tile with no date goes last.
export function sortLots(lots) {
  return [...(lots || [])].sort((a, b) => {
    const ra = a.received || '9999'
    const rb = b.received || '9999'
    if (ra !== rb) return ra < rb ? -1 : 1
    return String(a.lot || '').localeCompare(String(b.lot || ''))
  })
}

const tileKey = (tile) => `${tile.tag_id ?? ''}|${tile.lot ?? ''}`

export function pickedQty(picks, part) {
  return (picks[part] || []).reduce((s, p) => s + Number(p.qty || 0), 0)
}

export function isPicked(picks, part, tile) {
  return (picks[part] || []).some((p) => tileKey(p) === tileKey(tile))
}

// Tapping a tile picks it with the smaller of what the component still needs and what the tile holds;
// tapping a picked tile puts it back. A tile tapped when the component is already covered is ignored.
// picks: { [part]: [{ tag_id, lot, qty }] } — returns a new object.
export function togglePick(picks, part, tile, qtyNeeded) {
  const current = picks[part] || []
  if (isPicked(picks, part, tile)) {
    return { ...picks, [part]: current.filter((p) => tileKey(p) !== tileKey(tile)) }
  }
  const remaining = Number(qtyNeeded || 0) - pickedQty(picks, part)
  const take = Math.min(remaining, Number(tile.qty || 0))
  if (!(take > 0)) return picks
  return { ...picks, [part]: [...current, { tag_id: tile.tag_id ?? null, lot: tile.lot, qty: take }] }
}

// { picked, needed, short } for one component.
export function coverage(picks, component) {
  const needed = Number(component.qty_needed || 0)
  const picked = pickedQty(picks, component.component_part_number)
  return { picked, needed, short: Math.max(0, needed - picked) }
}

// The p_lots argument of assembly_build_start: one entry per part and lot. Several tags of the same lot are
// summed into one entry (the server keys pulled lots by part and lot); the first tag picked is recorded.
export function lotsPayload(picks) {
  const out = []
  for (const [part, list] of Object.entries(picks || {})) {
    const byLot = new Map()
    for (const p of list) {
      const prev = byLot.get(p.lot)
      if (prev) prev.qty += Number(p.qty || 0)
      else byLot.set(p.lot, { part, lot: p.lot, tag_id: p.tag_id ?? null, qty: Number(p.qty || 0) })
    }
    out.push(...byLot.values())
  }
  return out
}

const passed = (s) => s.signed && s.result === 'pass'

// Steps the assembler signs on the kiosk: every step taking a PIN except Jody's release (D-ASM-08).
export const isSignStep = (s) => Number(s.pins || 0) > 0 && s.type !== 'release'

// Sign-offs still open in this wave.
export function pendingSignoffs(steps) {
  return (steps || []).filter((s) => isSignStep(s) && !passed(s))
}

// Closeout asks for an inspector PIN only when the wave's inspect step takes one PIN and is not yet passed.
export function inspectorStep(steps) {
  return (steps || []).find((s) => s.type === 'inspect' && Number(s.pins) === 1 && !passed(s)) || null
}

// assembly_build_start raises "NEW_LOT_SET: …" when the lot combination is new and no second PIN was given.
export function isNewLotSet(message) {
  return /NEW_LOT_SET/.test(String(message || ''))
}
export function newLotSetText(message) {
  return String(message || '').replace(/^.*NEW_LOT_SET:\s*/, '')
}

// 0 → "0 min"; 75 → "1 h 15 min".
export function formatMinutes(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h} h ${r} min` : `${h} h`
}

// The assembly kiosk is for the assembly team (and admins), primary role or roles[].
export function isAssemblyOperator(op) {
  const roles = [op?.role, ...(op?.roles || [])]
  return roles.includes('assembly') || roles.includes('admin')
}

// ── Build TV ──
const sameLocalDay = (ts, now) => {
  if (!ts) return false
  const d = new Date(ts)
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}
const byDue = (a, b) => (a.earliest_due || '9999-12-31').localeCompare(b.earliest_due || '9999-12-31')
  || String(a.build_number || '').localeCompare(String(b.build_number || ''))

// v_assembly_tv rows into the TV's four columns; each build lands in exactly one. Complete or released today →
// Done today; running (in progress with an open session) → Running, late or not (the card says late);
// otherwise late → Late; the rest → Waiting. Late and Waiting oldest due first.
export function tvColumns(rows, now = new Date()) {
  const running = []
  const late = []
  const waiting = []
  const doneToday = []
  for (const r of rows || []) {
    if (r.status === 'complete' || r.status === 'released') {
      if (sameLocalDay(r.completed_at, now)) doneToday.push(r)
      continue
    }
    if (r.status === 'in_progress' && Number(r.open_sessions) > 0) running.push(r)
    else if (r.late) late.push(r)
    else waiting.push(r)
  }
  running.sort((a, b) => String(a.assigned_name || '').localeCompare(String(b.assigned_name || '')))
  late.sort(byDue)
  waiting.sort(byDue)
  doneToday.sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)))
  return { running, late, waiting, doneToday }
}

// Number-pad entry: digits, one decimal point when allowed, a length cap.
export function appendKey(value, key, { decimal = false, maxLength = 7 } = {}) {
  const v = String(value ?? '')
  if (key === '.') {
    if (!decimal || v.includes('.')) return v
    return v === '' ? '0.' : v + '.'
  }
  if (!/^[0-9]$/.test(key)) return v
  if (v.length >= maxLength) return v
  if (v === '0') return key
  return v + key
}

// D-ASM-58: what a Component check approves — the pulled lots grouped by component, in bill-of-materials order
// (the order assembly_kiosk_components returns), each with its description. rows: [{ part, lot, qty }] from
// assembly_component_lots or from the start screen's picks (lotsPayload); components: listComponents rows.
export function pulledLotsByComponent(rows, components) {
  const order = new Map((components || []).map((c, i) => [c.component_part_number, i]))
  const desc = new Map((components || []).map((c) => [c.component_part_number, c.part_description || '']))
  const byPart = new Map()
  for (const r of rows || []) {
    if (!r?.part) continue
    if (!byPart.has(r.part)) byPart.set(r.part, { part: r.part, description: desc.get(r.part) || '', lots: [], total: 0 })
    const g = byPart.get(r.part)
    const qty = Number(r.qty) || 0
    const same = g.lots.find((l) => l.lot === r.lot)
    if (same) same.qty += qty
    else g.lots.push({ lot: r.lot, qty })
    g.total += qty
  }
  const groups = [...byPart.values()]
  for (const g of groups) g.lots.sort((a, b) => String(a.lot).localeCompare(String(b.lot), undefined, { numeric: true }))
  return groups.sort((a, b) => (order.get(a.part) ?? 1e9) - (order.get(b.part) ?? 1e9) || a.part.localeCompare(b.part))
}

// D-ASM-58: who may sign, in plain words. distinctFrom is the step's distinct_from (puller, crimper, assembler);
// the server compares the first signer with the build's assembler whichever it is.
export function signerRule(pins, distinctFrom) {
  const two = Number(pins) >= 2
  if (distinctFrom) return two ? 'Two different people · the first is not the assembler' : 'Checked by someone other than the assembler'
  return two ? 'Two different people' : null
}
