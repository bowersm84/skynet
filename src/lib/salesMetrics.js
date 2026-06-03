// src/lib/salesMetrics.js
// Pure metric / grouping helpers for the Sales Dashboard (SKY S10).
// Mirrors src/lib/machineStatus.js: single source of truth for the computations,
// no DB calls inside, trivially unit-testable.
//
// INPUT CONTRACT — an array of rows in v_sales_weekly_report_v3 column shape:
//   { section, salesperson_name, due_bucket, days_to_due, priority,
//     wo_numbers, co_number, part_number, production_phase, qty_this_row,
//     flags_or_notes, ... }
// section is one of: 'B. Production' | 'C. Open Demand' | 'D. Make to Stock'.
// (Scorecard 'A.' rows are NOT fetched into the page — the KPI totals are derived
//  here from the B/C/D rows.) The CSV-snapshot parser (Batch D) emits this SAME
// shape, tagging Make-to-Stock rows section='D. Make to Stock', so live data and
// loaded snapshots flow through every function below identically.

export const PHASES = [
  '1. Waiting to Run', '2. In Machining', '3. Finishing / QC',
  '4. Outsourced', '5. Assembly', '6. Pending TCO',
]

export const BUCKETS = [
  '1. PAST DUE', '2. Due This Week', '3. Due Next Week',
  '4. Due in 2-4 Weeks', '5. 4+ Weeks Out', '0. No Due Date',
]

const SECTION = {
  PRODUCTION: 'B. Production',
  DEMAND: 'C. Open Demand',
  MTS: 'D. Make to Stock',
}

const toInt = (v) => {
  const n = parseInt(String(v ?? '').replace(/[^0-9-]/g, ''), 10)
  return Number.isNaN(n) ? 0 : n
}

const isUnassigned = (sp) => /unassigned/i.test(sp || '')
const hasFlag = (row, flag) => new RegExp(flag, 'i').test(row.flags_or_notes || '')
const isCritical = (row) => /critical/i.test(row.priority || '')

// Distinct work orders across rows. wo_numbers may be a comma-joined rollup
// ("WO-1, WO-2") on combined CO lines, so split before counting.
function countWorkOrders(rows) {
  const set = new Set()
  rows.forEach(r => (r.wo_numbers || '').split(',').forEach(w => {
    const t = w.trim()
    if (t) set.add(t)
  }))
  return set.size
}

/**
 * Scope filter. scopeName 'all' (or falsy) -> no filter. Otherwise match
 * salesperson_name case/space-insensitively (so it also works against the
 * uppercase names in a loaded CSV snapshot). The standalone MTS panel is always
 * org-wide, so call selectMts() on the UNSCOPED rows, not the output of this.
 */
export function applyScope(rows, scopeName) {
  if (!scopeName || scopeName === 'all') return rows
  const want = String(scopeName).trim().toLowerCase()
  return rows.filter(r => String(r.salesperson_name || '').trim().toLowerCase() === want)
}

/**
 * Top-of-page KPIs.
 *  - rowsScoped: post-scope rows (Active WOs, Past Due, Stalled, Demand Lines/Qty)
 *  - rowsRaw:    unfiltered rows (the Unassigned tile is org-wide per D-MAY27-07)
 */
export function computeKpis(rowsScoped, rowsRaw) {
  const prod = rowsScoped.filter(r => r.section === SECTION.PRODUCTION)
  const dem = rowsScoped.filter(r => r.section === SECTION.DEMAND)

  const unassigned =
    rowsRaw.filter(r => r.section === SECTION.PRODUCTION && isUnassigned(r.salesperson_name)).length +
    rowsRaw.filter(r => r.section === SECTION.DEMAND && isUnassigned(r.salesperson_name)).length

  return {
    activeWos: countWorkOrders(prod),
    pastDue: prod.filter(r => r.due_bucket === '1. PAST DUE').length,
    stalled: prod.filter(r => hasFlag(r, 'STALLED')).length,
    demandLines: dem.length,
    demandQty: dem.reduce((s, r) => s + toInt(r.qty_this_row), 0),
    unassigned,
  }
}

/** Pipeline chart data — production-row count per phase, only phases with data. */
export function groupByPhase(rowsScoped) {
  const prod = rowsScoped.filter(r => r.section === SECTION.PRODUCTION)
  return PHASES
    .map(phase => ({ phase, count: prod.filter(r => r.production_phase === phase).length }))
    .filter(x => x.count > 0)
}

/** Demand chart data — summed open-demand qty per bucket, only buckets with data. */
export function groupByDueBucket(rowsScoped) {
  const dem = rowsScoped.filter(r => r.section === SECTION.DEMAND)
  return BUCKETS
    .map(bucket => {
      const inB = dem.filter(r => r.due_bucket === bucket)
      return { bucket, lines: inB.length, qty: inB.reduce((s, r) => s + toInt(r.qty_this_row), 0) }
    })
    .filter(x => x.qty > 0)
}

/**
 * Workload table — one row per salesperson. Sort: real names alphabetically,
 * then 'Unassigned'. (MTS is its own standalone panel, not a workload row.)
 */
export function summarizeBySalesperson(rowsScoped) {
  const names = [...new Set(
    rowsScoped
      .filter(r => r.section === SECTION.PRODUCTION || r.section === SECTION.DEMAND)
      .map(r => r.salesperson_name)
      .filter(Boolean)
  )]
  names.sort((a, b) => (isUnassigned(a) ? 1 : 0) - (isUnassigned(b) ? 1 : 0) || a.localeCompare(b))

  return names.map(sp => {
    const prod = rowsScoped.filter(r => r.section === SECTION.PRODUCTION && r.salesperson_name === sp)
    const dem = rowsScoped.filter(r => r.section === SECTION.DEMAND && r.salesperson_name === sp)
    const earliestLate = prod
      .filter(r => r.due_bucket === '1. PAST DUE' && r.days_to_due != null)
      .map(r => toInt(r.days_to_due))
      .sort((a, b) => a - b)[0]
    return {
      salesperson: sp,
      activeWos: countWorkOrders(prod),
      pastDue: prod.filter(r => r.due_bucket === '1. PAST DUE').length,
      stalled: prod.filter(r => hasFlag(r, 'STALLED')).length,
      demandLines: dem.length,
      demandQty: dem.reduce((s, r) => s + toInt(r.qty_this_row), 0),
      earliestLateDays: earliestLate === undefined ? null : earliestLate,
    }
  })
}

/** Standalone Make-to-Stock rows, sorted by due bucket then WO. Pass UNSCOPED rows. */
export function selectMts(rows) {
  return rows
    .filter(r => r.section === SECTION.MTS)
    .sort((a, b) =>
      String(a.due_bucket).localeCompare(String(b.due_bucket)) ||
      String(a.wo_numbers).localeCompare(String(b.wo_numbers))
    )
}

/**
 * Past-due & at-risk list. Includes: past-due production, stalled production,
 * past-due demand, AND any critical-priority row (so a critical order surfaces
 * even when it isn't late yet — D-MAY27-11, amended S10). Dedup by
 * (kind, wo_numbers||co_number, part_number). Sorted most-overdue first.
 */
export function selectAtRisk(rowsScoped) {
  const out = []
  rowsScoped.filter(r => r.section === SECTION.PRODUCTION).forEach(r => {
    if (r.due_bucket === '1. PAST DUE' || hasFlag(r, 'STALLED') || isCritical(r)) {
      out.push({ ...r, _kind: 'WO' })
    }
  })
  rowsScoped.filter(r => r.section === SECTION.DEMAND).forEach(r => {
    if (r.due_bucket === '1. PAST DUE' || isCritical(r)) {
      out.push({ ...r, _kind: 'Demand' })
    }
  })

  const seen = new Set()
  const dedup = out.filter(r => {
    const key = `${r._kind}|${r.wo_numbers || r.co_number || ''}|${r.part_number || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  dedup.sort((a, b) => toInt(a.days_to_due) - toInt(b.days_to_due))
  return dedup
}
