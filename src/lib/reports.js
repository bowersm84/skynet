// Reports module data layer (D-RPT-01/02/04).
// Registry-driven: the `reports` table describes each report; this module
// fetches the registry, runs a report with exhaustive pagination, and
// serializes CSV under the weekly-scorecard output contract.
import { supabase } from './supabase'
import { userRoles } from './roles'

const PAGE_SIZE = 1000

// Registry rows visible to this profile. Empty view_roles = everyone.
export async function fetchReports(profile) {
  const { data, error } = await supabase
    .from('reports')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })
  if (error) throw error
  const mine = userRoles(profile)
  return (data || []).filter(r =>
    !r.view_roles?.length || r.view_roles.some(role => mine.includes(role))
  )
}

// Exhaustive fetch (D-RPT-04): exact count first, then stable-ordered pages
// until the count is met. A silently truncated result feeding the weekly
// scorecard is the failure mode this exists to prevent — mismatch throws.
async function fetchAllRows(sourceObject, orderBy) {
  const { count, error: countErr } = await supabase
    .from(sourceObject)
    .select('*', { count: 'exact', head: true })
  if (countErr) throw countErr
  if (count === 0) return []

  const rows = []
  let page = 0
  while (rows.length < count) {
    let q = supabase.from(sourceObject).select('*')
    for (const o of orderBy || []) {
      q = q.order(o.column, {
        ascending: o.ascending !== false,
        nullsFirst: o.nullsFirst === true,
      })
    }
    const { data, error } = await q.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (error) throw error
    if (!data?.length) break
    rows.push(...data)
    page += 1
  }
  if (rows.length !== count) {
    throw new Error(
      `Row count mismatch: expected ${count} rows, fetched ${rows.length}. ` +
      'Export aborted — do not use partial results.'
    )
  }
  return rows
}

export async function runReport(report) {
  try {
    return await fetchAllRows(report.source_object, report.order_by)
  } catch (err) {
    // One retry absorbs live-data drift between the count and the page
    // fetches; a second mismatch is a real failure and surfaces to the UI.
    if (/Row count mismatch/.test(err?.message || '')) {
      return await fetchAllRows(report.source_object, report.order_by)
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// CSV serialization — OUTPUT CONTRACT (D-RPT-02). Do not "improve":
//   headers = registry columns verbatim; bare YYYY-MM-DD dates; nulls empty;
//   UTF-8 with NO BOM; raw numbers; RFC 4180 quoting.
// ---------------------------------------------------------------------------
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T/

function csvValue(v) {
  if (v === null || v === undefined) return ''
  let s = typeof v === 'string' ? v : String(v)
  if (ISO_DATETIME.test(s)) s = s.slice(0, 10) // defense-in-depth: bare dates only
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'
  return s
}

export function toCsv(rows, columns) {
  const lines = [columns.join(',')]
  for (const row of rows) {
    lines.push(columns.map(c => csvValue(row[c])).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

export function reportFilename(slug) {
  const d = new Date()
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `skynet_${slug.replace(/-/g, '_')}_${iso}.csv`
}

export function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' }) // no BOM
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// "What is this telling me" — deterministic summaries keyed by slug.
// Unknown slugs fall back to a row count so new reports work day one.
// ---------------------------------------------------------------------------
function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const SUMMARIZERS = {
  'drop-calendar-8wk': (rows) => {
    const num = v => Number(v) || 0
    const remaining = rows.reduce((s, r) => s + num(r.qty_remaining), 0)
    const inWindow = rows.reduce((s, r) => s + num(r.total_in_window), 0)
    const wk1 = rows.reduce((s, r) => s + num(r.wk1), 0)
    const late = rows.filter(r => r.days_late_vs_customer != null && r.days_late_vs_customer !== '')
    const risk = rows.filter(r => r.risk)
    const mismatch = remaining !== inWindow
    return {
      cards: [
        { label: 'Jobs Scheduled', value: rows.length.toLocaleString() },
        { label: 'Pieces Remaining', value: remaining.toLocaleString() },
        { label: 'Dropping This Week', value: wk1.toLocaleString() },
        { label: 'Late vs Customer', value: late.length.toLocaleString(), alert: late.length > 0 },
        { label: 'At-Risk (machine down)', value: risk.length.toLocaleString(), alert: risk.length > 0 },
      ],
      narrative: mismatch
        ? `INTEGRITY CHECK FAILED: qty_remaining (${remaining.toLocaleString()}) does not equal total_in_window (${inWindow.toLocaleString()}) — the week spread is multiplying rows. Do not quote this output; investigate the view.`
        : `${remaining.toLocaleString()} pieces across ${rows.length.toLocaleString()} jobs are spread over the 8-week window (integrity check passed: remaining equals in-window). Dates are off-the-machine, not ship dates. Highlighted rows are late vs the customer date or sitting on a machine that is not running.`,
    }
  },
  'drop-calendar-by-part': (rows) => {
    const num = v => Number(v) || 0
    const remaining = rows.reduce((s, r) => s + num(r.qty_remaining), 0)
    const inWindow = rows.reduce((s, r) => s + num(r.total_in_window), 0)
    const mismatch = remaining !== inWindow
    return {
      cards: [
        { label: 'Parts', value: rows.length.toLocaleString() },
        { label: 'Pieces Remaining', value: remaining.toLocaleString() },
        { label: 'Dropping This Week', value: rows.reduce((s, r) => s + num(r.wk1), 0).toLocaleString() },
        { label: 'Integrity', value: mismatch ? 'FAILED' : 'OK', alert: mismatch },
      ],
      narrative: mismatch
        ? `INTEGRITY CHECK FAILED: qty_remaining (${remaining.toLocaleString()}) vs total_in_window (${inWindow.toLocaleString()}). Do not quote this output.`
        : `One row per part, aggregated from the job-level calendar. ${remaining.toLocaleString()} pieces remaining across ${rows.length.toLocaleString()} parts.`,
    }
  },
  'wip-near-term': (rows) => {
    const num = v => Number(v) || 0
    const pieces = rows.reduce((s, r) => s + num(r.pieces), 0)
    const pastDue = rows.filter(r => r.days_past_due != null && r.days_past_due !== '')
    const pastDuePieces = pastDue.reduce((s, r) => s + num(r.pieces), 0)
    const parked = rows.filter(r => num(r.days_since_moved) > 30)
    const stages = {}
    for (const r of rows) stages[r.stage || '(none)'] = (stages[r.stage || '(none)'] || 0) + 1
    return {
      cards: [
        { label: 'Jobs In Process', value: rows.length.toLocaleString() },
        { label: 'Pieces Made, Not Shipped', value: pieces.toLocaleString() },
        { label: 'Past Customer Due', value: pastDuePieces.toLocaleString(), alert: pastDue.length > 0 },
        { label: 'Parked > 30 Days', value: parked.length.toLocaleString(), alert: parked.length > 0 },
        { label: 'Stages In Play', value: Object.keys(stages).length.toLocaleString() },
      ],
      narrative: `${pieces.toLocaleString()} pieces are through the machines and not yet shipped. ${pastDuePieces.toLocaleString()} of them are already past the customer's due date — those customers are waiting on process, not production. Rows highlighted amber have not moved in over 30 days. pending_tco is deliberately excluded: those jobs are through production and belong to quality close-out, not available supply.`,
    }
  },
  'job-efficiency': (rows) => {
    const num = v => (v === null || v === undefined || v === '') ? null : Number(v)
    const running = rows.filter(r => !r.actual_end && r.status === 'in_progress')
    const withBoth = rows.filter(r => num(r.variance_pct) !== null)
    const behind = withBoth.filter(r => num(r.variance_pct) <= -10)
    const noHistory = rows.filter(r => num(r.hist_runs) === null || num(r.hist_runs) === 0)
    const variances = withBoth.map(r => num(r.variance_pct)).sort((a, b) => a - b)
    const median = variances.length
      ? variances[Math.floor((variances.length - 1) / 2)]
      : null
    return {
      cards: [
        { label: 'Jobs In Report', value: rows.length.toLocaleString() },
        { label: 'Currently Running', value: running.length.toLocaleString() },
        { label: 'Behind ≥10%', value: behind.length.toLocaleString(), alert: behind.length > 0 },
        { label: 'No History', value: noHistory.length.toLocaleString(), alert: noHistory.length > 0 },
        { label: 'Median Variance', value: median === null ? '—' : `${median > 0 ? '+' : ''}${median.toFixed(1)}%` },
      ],
      narrative: 'Variance compares each job\'s current parts/day against the weighted average of up to 10 prior completed runs of the same part. Negative = running slower than history. Jobs with no history are candidates for machinist estimates.'
    }
  },
  'open-demand': (rows) => {
    const num = v => Number(v) || 0
    const today = localToday()
    const totalOpen = rows.reduce((s, r) => s + num(r.qty_open), 0)
    const pastDue = rows.filter(r => r.due_date && r.due_date < today)
    const uncovered = rows.filter(r => num(r.wo_count) === 0)
    const uncoveredQty = uncovered.reduce((s, r) => s + num(r.qty_open), 0)
    const byCustomer = {}
    for (const r of rows) {
      const key = r.customer_name || '(unknown)'
      byCustomer[key] = (byCustomer[key] || 0) + num(r.qty_open)
    }
    const customerCount = Object.keys(byCustomer).length
    const top = Object.entries(byCustomer).sort((a, b) => b[1] - a[1])[0]
    return {
      cards: [
        { label: 'Open Lines', value: rows.length.toLocaleString() },
        { label: 'Open Pieces', value: totalOpen.toLocaleString() },
        { label: 'Past-Due Lines', value: pastDue.length.toLocaleString(), alert: pastDue.length > 0 },
        { label: 'Lines w/o Work Order', value: uncovered.length.toLocaleString(), alert: uncovered.length > 0 },
        { label: 'Customers', value: customerCount.toLocaleString() },
      ],
      narrative:
        `SkyNet is tracking ${rows.length.toLocaleString()} open customer order lines ` +
        `totaling ${totalOpen.toLocaleString()} pieces across ${customerCount} customers. ` +
        `${pastDue.length.toLocaleString()} ${pastDue.length === 1 ? 'line is' : 'lines are'} past due. ` +
        `${uncovered.length.toLocaleString()} ${uncovered.length === 1 ? 'line has' : 'lines have'} ` +
        `no active work order coverage (${uncoveredQty.toLocaleString()} pieces not yet in production)` +
        (top ? `. Largest open position: ${top[0]} at ${top[1].toLocaleString()} pieces.` : '.'),
    }
  },
}

export function summarize(slug, rows) {
  const fn = SUMMARIZERS[slug]
  if (fn) return fn(rows)
  return {
    cards: [{ label: 'Rows', value: rows.length.toLocaleString() }],
    narrative: `${rows.length.toLocaleString()} rows returned.`,
  }
}
