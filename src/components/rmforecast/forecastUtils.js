// Shared helpers for the Armory RM Forecast section (D-RMF-01).
// Pure functions only — no Supabase, no React.

// Series prefix → blank stud_series. Material CANNOT be inferred from the part
// number (suffix/description are unreliable), so demand maps to series + dash
// only and lands on BOTH material rows of the matching on-hand line.
export const SERIES_PREFIX_MAP = {
  SK26: '2600',
  SK27: '2700',
  SK4C: '4000',
  SK40: '4000',
  ZG40: '4000',
}

// week_start is a DATE (YYYY-MM-DD). Never `new Date('YYYY-MM-DD')` — that
// parses at midnight UTC and displays as the previous day in US Eastern.
export function parseLocalDate(value) {
  if (!value) return null
  const [y, m, d] = String(value).split('T')[0].split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d)
}

// "Jul 28" for the current year, "Jul 28, 2027" otherwise. Unscheduled rows
// (week_start NULL) always read "Unscheduled".
export function formatWeek(row) {
  if (!row || row.is_unscheduled || !row.week_start) return 'Unscheduled'
  const d = parseLocalDate(row.week_start)
  if (!d) return String(row.week_start)
  const opts = { month: 'short', day: 'numeric' }
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric'
  return d.toLocaleDateString('en-US', opts)
}

export function formatDay(value) {
  const d = parseLocalDate(value)
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
}

// Identity for a forecast bucket. Unscheduled sorts last everywhere.
export function weekKey(row) {
  return row?.is_unscheduled || !row?.week_start ? 'UNSCHEDULED' : String(row.week_start)
}

export function weekSortKey(row) {
  return row?.is_unscheduled || !row?.week_start ? '9999-99-99' : String(row.week_start)
}

export function groupKey(materialType, barSize) {
  return `${materialType ?? ''}|||${barSize ?? ''}`
}

// Leading number out of a size string ("0.500 dia", '0.500"', "0.5") for sorting
// and for matching a catalog bar size against a value already stored in
// part_dimensions.
export function numericOf(value) {
  const m = String(value ?? '').match(/-?\d+(\.\d+)?/)
  return m ? parseFloat(m[0]) : null
}

export function fmtInt(n) {
  const v = Number(n ?? 0)
  return Number.isFinite(v) ? Math.round(v).toLocaleString() : '—'
}

// bars_needed can be fractional in the estimator; show 1 decimal when it is.
export function fmtBars(n) {
  const v = Number(n ?? 0)
  if (!Number.isFinite(v)) return '—'
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

// The five RPCs raise 'Not authorized' for roles outside admin/scheduler/purchaser.
export function isNotAuthorized(err) {
  return /not authorized/i.test(err?.message || err?.hint || '')
}

// bars_needed = 0 with pieces > 0 means an in-progress job is fully staged
// (material already loaded) — NOT missing data.
export function isFullyStaged(row) {
  return Number(row?.bars_needed ?? 0) === 0 && Number(row?.pieces ?? 0) > 0
}

// Group bar rows by material_type + bar_size, sorted by material then size.
// Weekly rows inside each group are week-ascending with Unscheduled last.
export function buildBarGroups(bars) {
  const map = new Map()
  for (const row of bars || []) {
    const key = groupKey(row.material_type, row.bar_size)
    if (!map.has(key)) {
      map.set(key, {
        key,
        material_type: row.material_type,
        bar_size: row.bar_size,
        bars_on_hand: Number(row.bars_on_hand ?? 0),
        rows: [],
      })
    }
    const g = map.get(key)
    // bars_on_hand is repeated per row for the group; keep the first non-null.
    if (row.bars_on_hand != null) g.bars_on_hand = Number(row.bars_on_hand)
    g.rows.push(row)
  }

  const groups = [...map.values()]
  for (const g of groups) {
    g.rows.sort((a, b) => weekSortKey(a).localeCompare(weekSortKey(b)))
    g.totalBarsNeeded = g.rows.reduce((s, r) => s + Number(r.bars_needed ?? 0), 0)
    g.totalPieces = g.rows.reduce((s, r) => s + Number(r.pieces ?? 0), 0)

    const remainders = g.rows
      .map(r => (r.projected_remaining == null ? null : Number(r.projected_remaining)))
      .filter(v => v != null)
    g.worstRemaining = remainders.length ? Math.min(...remainders) : null

    // Rows are already week-ascending with Unscheduled last, so the first
    // negative row IS the first shortfall.
    const firstShort = g.rows.find(r => Number(r.projected_remaining ?? 0) < 0)
    g.firstShortfall = !firstShort
      ? null
      : firstShort.is_unscheduled || !firstShort.week_start
        ? 'Short on unscheduled work'
        : `Short starting ${formatWeek(firstShort)}`
    g.hasShortfall = !!firstShort
    g.hasEstimates = g.rows.some(r => r.has_estimates)
  }

  groups.sort((a, b) => {
    const m = String(a.material_type ?? '').localeCompare(String(b.material_type ?? ''))
    if (m !== 0) return m
    const an = numericOf(a.bar_size)
    const bn = numericOf(b.bar_size)
    if (an != null && bn != null && an !== bn) return an - bn
    return String(a.bar_size ?? '').localeCompare(String(b.bar_size ?? ''))
  })
  return groups
}

// Index forecast_rm_bar_parts by material + size + week bucket so a weekly row
// can pull its own part breakdown without re-scanning.
export function indexBarParts(parts) {
  const map = new Map()
  for (const p of parts || []) {
    const key = `${groupKey(p.material_type, p.bar_size)}|||${weekKey(p)}`
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(p)
  }
  for (const list of map.values()) {
    list.sort((a, b) => Number(b.bars_needed ?? 0) - Number(a.bars_needed ?? 0))
  }
  return map
}

export function barPartsFor(index, row) {
  return index.get(`${groupKey(row.material_type, row.bar_size)}|||${weekKey(row)}`) || []
}

// Resolve a blank demand part number to its stud series via prefix.
export function seriesForPart(partNumber) {
  const pn = String(partNumber || '').toUpperCase()
  for (const [prefix, series] of Object.entries(SERIES_PREFIX_MAP)) {
    if (pn.startsWith(prefix)) return series
  }
  return null
}

// Sum blank demand per (series, dash). Rows with a NULL dash or no prefix match
// can't be mapped and are returned separately for the Unmapped list.
export function buildBlankNeed(demand) {
  const needed = new Map() // `${series}|${dash}` → pieces
  const unmapped = []
  for (const row of demand || []) {
    const series = seriesForPart(row.part_number)
    const dash = row.blank_dash == null || row.blank_dash === '' ? null : String(row.blank_dash)
    if (!series || !dash) {
      unmapped.push({
        ...row,
        _reason: !dash ? 'No blank dash on the demand row' : 'Part number prefix has no series mapping',
      })
      continue
    }
    const key = `${series}|${dash}`
    needed.set(key, (needed.get(key) || 0) + Number(row.pieces ?? 0))
  }
  return { needed, unmapped }
}

export function neededFor(neededMap, onhandRow) {
  const key = `${onhandRow?.stud_series}|${onhandRow?.stud_length}`
  return neededMap.get(key) ?? null
}
