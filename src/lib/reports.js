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
