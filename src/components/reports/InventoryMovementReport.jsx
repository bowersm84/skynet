// Inventory Movement (D-RPT-14): an interactive report. Pick a date range, get
// every raw-material movement in it — receipts, production draws, approved count
// adjustments — valued at lot cost, in two layers: a deterministic summary with a
// prior-period comparison, and the raw rows behind it.
//
// No LLM anywhere in this report. The narrative is templated from the numbers the
// summary RPC computed (D-RPT-12 philosophy); Uncle Bob is not wired for
// interactive reports (D-RPT-13) — follow-up.
//
// All math lives in report_inventory_movement / report_inventory_movement_summary;
// this component renders and exports. The summary computes both periods FROM the
// detail RPC, so re-adding the detail rows here and comparing is a real check that
// the two layers have not drifted (D-RPT-12 integrity check) — a mismatch marks
// the view do-not-quote and disables both exports.
import { useState } from 'react'
import { ArrowLeft, Download, AlertTriangle, Copy, Check, Play } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { canExportReports } from '../../lib/roles'
import { toCsv, downloadCsv } from '../../lib/reports'

// The CSV column contract (D-RPT-02) — registry `columns` verbatim; this is only
// the fallback if the registry row is ever read without them.
const DETAIL_COLUMNS = [
  'mv_date', 'category', 'material', 'lot_number', 'heat_number', 'movement_type',
  'qty_change', 'unit_cost', 'value_change', 'reference', 'recorded_by', 'notes',
]

const INTEGRITY_TOLERANCE = 0.05

// ------------------------------ formatting ------------------------------
const num = (v) => (v === null || v === undefined || v === '') ? 0 : Number(v)

const money = (v) => (v === null || v === undefined)
  ? '—'
  : `$${Math.abs(Number(v)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const signedMoney = (v) => {
  if (v === null || v === undefined) return '—'
  const n = Number(v)
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${money(n)}`
}

const units = (v) => (v === null || v === undefined) ? '—' : Number(v).toLocaleString('en-US')

const signedUnits = (v) => {
  if (v === null || v === undefined) return '—'
  const n = Number(v)
  return `${n > 0 ? '+' : ''}${n.toLocaleString('en-US')}`
}

const pct = (v) => (v === null || v === undefined) ? '—' : `${(Number(v) * 100).toFixed(1)}%`

const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`

// Bare YYYY-MM-DD anchored at local noon — a bare date parsed as UTC midnight
// renders a day early in Eastern time (the D-CODATE-02b trap).
const d = (v) => {
  if (!v) return '—'
  const s = String(v)
  const dt = s.length <= 10 ? new Date(`${s}T12:00:00`) : new Date(s)
  return Number.isNaN(dt.getTime()) ? s : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const dShort = (v) => {
  if (!v) return '—'
  const s = String(v)
  const dt = s.length <= 10 ? new Date(`${s}T12:00:00`) : new Date(s)
  return Number.isNaN(dt.getTime()) ? s : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const dt = (v) => v
  ? new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  : '—'

const isoDay = (date) => {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

const addDays = (iso, n) => {
  const base = new Date(`${iso}T12:00:00`)
  base.setDate(base.getDate() + n)
  return isoDay(base)
}

// "Aug 31 – Sep 4, 2026"
const rangeTitle = (start, end) => `${dShort(start)} – ${dShort(end)}, ${String(end).slice(0, 4)}`

// 'Job RQ-13521955' -> 'RQ-13521955'
const jobLabel = (ref) => String(ref || '').replace(/^Job /, '')

const TH = 'text-left text-gray-400 font-medium px-3 py-2 whitespace-nowrap'
const TD = 'px-3 py-1.5 whitespace-nowrap text-gray-300'
const TDN = 'px-3 py-1.5 whitespace-nowrap text-right font-mono text-gray-300'

function Card({ value, caption, sub, alert }) {
  return (
    <div className={`rounded-lg p-3 border ${alert ? 'bg-amber-900/20 border-amber-700/60' : 'bg-gray-800 border-gray-700'}`}>
      <p className={`text-2xl font-semibold ${alert ? 'text-amber-300' : 'text-white'}`}>{value}</p>
      <p className="text-gray-500 text-xs mt-1">{caption}</p>
      {sub && <p className="text-gray-600 text-[11px] mt-0.5">{sub}</p>}
    </div>
  )
}

function Section({ title, count, note, children }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden mb-4">
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-800">
        <h3 className="text-white text-sm font-semibold">{title}</h3>
        {count !== undefined && <span className="text-gray-500 text-xs">{count} {count === 1 ? 'row' : 'rows'}</span>}
        {note && <span className="text-gray-500 text-xs ml-auto">{note}</span>}
      </div>
      {children}
    </div>
  )
}

function Empty({ children }) {
  return <p className="text-gray-500 text-sm px-4 py-3">{children}</p>
}

// ------------------------------ integrity check ------------------------------
// D-RPT-12: re-add the detail rows by category and movement type and compare with
// the summary's `current` aggregates. Both come from the same RPC, so anything
// over a nickel means the two layers have drifted and nothing here may be quoted.
function integrityCheck(rows, cur) {
  if (!rows || !cur) return { ok: true, failures: [] }
  const acc = {}
  for (const r of rows) {
    const key = `${r.category}|${r.movement_type}`
    acc[key] = (acc[key] || 0) + (r.value_change === null || r.value_change === undefined ? 0 : Number(r.value_change))
  }
  const checks = [
    ['bar|Received', num(cur.bars?.received_value), 'Bar received'],
    ['bar|Used', num(cur.bars?.used_value), 'Bar used'],
    ['bar|Adjustment', num(cur.bars?.adj_value), 'Bar adjustments'],
    ['blank|Received', num(cur.blanks?.received_value), 'Blank received'],
    ['blank|Used', num(cur.blanks?.used_value), 'Blank used'],
    ['blank|Adjustment', num(cur.blanks?.adj_value), 'Blank adjustments'],
  ]
  const failures = []
  for (const [key, expected, label] of checks) {
    const got = acc[key] || 0
    if (Math.abs(got - expected) > INTEGRITY_TOLERANCE) {
      failures.push(`${label}: detail ${money(got)} vs summary ${money(expected)}`)
    }
  }
  const detailNet = rows.reduce((s, r) => s + (r.value_change === null || r.value_change === undefined ? 0 : Number(r.value_change)), 0)
  if (Math.abs(detailNet - num(cur.net_value)) > INTEGRITY_TOLERANCE) {
    failures.push(`Net: detail ${money(detailNet)} vs summary ${money(cur.net_value)}`)
  }
  if (rows.length !== num(cur.movements)) {
    failures.push(`Movements: detail ${rows.length} rows vs summary ${num(cur.movements)}`)
  }
  return { ok: failures.length === 0, failures }
}

// ------------------------------ narrative (§6.4) ------------------------------
// Deterministic: every branch is picked from the computed numbers, never generated.
function buildNarrative(s) {
  const cur = s?.current
  if (!cur || num(cur.movements) === 0) {
    return [
      'No raw-material movement recorded in this range.',
      'If activity was expected, do not use this output — investigate first.',
    ]
  }
  const prev = s.previous
  const out = []

  // 1 — net, versus the period before
  const net = num(cur.net_value)
  const prevNet = num(prev?.net_value)
  const direction = net > 0 ? 'built by' : net < 0 ? 'drew down' : 'was flat at'
  const hasPrev = prev && num(prev.movements) > 0
  const prevPhrase = prevNet > 0 ? 'a build of' : prevNet < 0 ? 'a drawdown of' : 'flat at'
  out.push(`Raw material ${direction} ${money(net)} this period` +
    (hasPrev ? `, versus ${prevPhrase} ${money(prevNet)} the period before.` : '.'))

  // 2 — receipts and draws
  const received = num(cur.bars?.received_value) + num(cur.blanks?.received_value)
  const barUsed = Math.abs(num(cur.bars?.used_value))
  const blankUsed = Math.abs(num(cur.blanks?.used_value))
  const usedTotal = barUsed + blankUsed
  const receiptLines = (s.receipts || []).length
  if (receiptLines > 0) {
    out.push(`Receipts totaled ${money(received)} (${plural(receiptLines, 'line')}); ` +
      `production drew ${money(barUsed)} of bar and ${money(blankUsed)} of blanks.`)
    const gross = received + usedTotal
    if (gross > 0 && received / gross >= 0.5) {
      out.push(`Excluding receipts, the period drew ${money(usedTotal)}.`)
    }
  }

  // 3 / 4 — bars, then blanks
  for (const [cat, noun] of [['bars', 'bars'], ['blanks', 'pieces']]) {
    const c = cur[cat]
    if (!c) continue
    if (num(c.received_txns) + num(c.used_txns) + num(c.adj_txns) === 0) continue
    const u = num(c.net_units)
    const v = num(c.net_value)
    const uWord = u > 0 ? 'rose' : u < 0 ? 'fell' : 'held at'
    const vWord = v > 0 ? 'rose' : v < 0 ? 'fell' : 'held at'
    const label = cat === 'bars' ? 'Bar stock' : 'Blank stock'
    let sentence = `${label} ${uWord} ${Math.abs(u).toLocaleString('en-US')} ${noun} ` +
      `(${units(c.received_units)} in, ${units(Math.abs(num(c.used_units)))} out) and ${vWord} ${money(v)} in value`
    if (u !== 0 && v !== 0 && (u > 0) !== (v > 0)) {
      sentence += ' — the mix received differed in cost from the mix consumed'
    }
    out.push(`${sentence}.`)
  }

  // 5 — adjustments and uncosted lots
  const q = s.quality || {}
  const adjCount = num(q.adjustment_count)
  const missing = num(q.missing_cost_rows)
  const adjPart = adjCount === 0 ? 'No count adjustments' : plural(adjCount, 'count adjustment')
  const missPart = missing === 0
    ? 'zero movements on uncosted lots'
    : `${missing} of ${num(cur.movements)} movements on uncosted lots`
  out.push(`${adjPart}; ${missPart}.`)

  // requeue
  const rq = s.requeue || {}
  const curJobs = rq.jobs_current || []
  if (curJobs.length > 0 && num(rq.current_value) !== 0) {
    let sentence = `Requeue jobs drew ${money(rq.current_value)}`
    if (rq.current_share_of_bar_draw !== null && rq.current_share_of_bar_draw !== undefined) {
      sentence += ` (${pct(rq.current_share_of_bar_draw)} of bar draw)`
    }
    sentence += ` across ${plural(curJobs.length, 'job')}`
    const carried = (rq.by_job || []).filter(j => num(j.previous_value) !== 0)
    if (carried.length > 0) {
      sentence += '; ' + carried
        .map(j => `${jobLabel(j.reference)} has now drawn ${money(j.total_value)} over both periods`)
        .join('; ')
    }
    out.push(`${sentence}.`)
  }

  return out
}

// ------------------------------ period-over-period rows ------------------------------
// One shape for the on-screen table and the Markdown export, so they cannot diverge.
const uvt = (u, v, t) => `${signedUnits(u)} / ${signedMoney(v)} (${plural(num(t), 'txn')})`

// Adjustments across both categories. summary.quality carries the current period
// only, so both columns are derived the same way and stay comparable.
const adjTxns = (p) => num(p?.bars?.adj_txns) + num(p?.blanks?.adj_txns)
const adjValue = (p) => num(p?.bars?.adj_value) + num(p?.blanks?.adj_value)

function periodRows(s) {
  const cur = s.current || {}
  const prev = s.previous || {}
  const rq = s.requeue || {}
  const cell = (p, cat, kind) => {
    const c = p[cat] || {}
    if (kind === 'net') return `${signedUnits(c.net_units)} / ${signedMoney(c.net_value)}`
    return uvt(c[`${kind}_units`], c[`${kind}_value`], c[`${kind}_txns`])
  }
  return [
    ['Net raw material change', signedMoney(prev.net_value), signedMoney(cur.net_value)],
    ['Movements logged', units(prev.movements), units(cur.movements)],
    ['Bars received', cell(prev, 'bars', 'received'), cell(cur, 'bars', 'received')],
    ['Bars used', cell(prev, 'bars', 'used'), cell(cur, 'bars', 'used')],
    ['Bars net', cell(prev, 'bars', 'net'), cell(cur, 'bars', 'net')],
    ['Blanks received', cell(prev, 'blanks', 'received'), cell(cur, 'blanks', 'received')],
    ['Blanks used', cell(prev, 'blanks', 'used'), cell(cur, 'blanks', 'used')],
    ['Blanks net', cell(prev, 'blanks', 'net'), cell(cur, 'blanks', 'net')],
    ['Requeue share of bar draw', pct(rq.previous_share_of_bar_draw), pct(rq.current_share_of_bar_draw)],
    ['Count adjustments',
      `${units(adjTxns(prev))} / ${signedMoney(adjValue(prev))}`,
      `${units(adjTxns(cur))} / ${signedMoney(adjValue(cur))}`],
    ['Movements on uncosted lots', units(prev.missing_cost_rows), units(cur.missing_cost_rows)],
  ]
}

// ------------------------------ scorecard rows (§6.2 item 8) ------------------------------
function scorecardRows(s) {
  const cur = s.current || {}
  const rq = s.requeue || {}
  const q = s.quality || {}
  const bars = cur.bars || {}
  const blanks = cur.blanks || {}
  return [
    ['Net raw material change', signedMoney(cur.net_value)],
    ['Bars received', `${signedUnits(bars.received_units)} bars / ${signedMoney(bars.received_value)}`],
    ['Bars drawn', `${signedUnits(bars.used_units)} bars / ${signedMoney(bars.used_value)}`],
    ['Bars net', `${signedUnits(bars.net_units)} bars / ${signedMoney(bars.net_value)}`],
    ['Blanks received', `${signedUnits(blanks.received_units)} pieces / ${signedMoney(blanks.received_value)}`],
    ['Blanks drawn', `${signedUnits(blanks.used_units)} pieces / ${signedMoney(blanks.used_value)}`],
    ['Blanks net', `${signedUnits(blanks.net_units)} pieces / ${signedMoney(blanks.net_value)}`],
    ['Requeue draw', `${signedMoney(rq.current_value)} (${pct(rq.current_share_of_bar_draw)} of bar draw)`],
    ['Count adjustments', `${units(adjTxns(cur))} / ${signedMoney(q.adjustment_value)}`],
    ['Movements logged', units(cur.movements)],
    ['Movements on uncosted lots', units(cur.missing_cost_rows)],
  ]
}

// ------------------------------ Markdown export (§6.3) ------------------------------
const mdCell = (v) => (v === null || v === undefined ? '' : String(v).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' '))

const mdTable = (headers, rows) => [
  `| ${headers.map(mdCell).join(' | ')} |`,
  `| ${headers.map(() => '---').join(' | ')} |`,
  ...rows.map(r => `| ${r.map(mdCell).join(' | ')} |`),
].join('\n')

function buildMarkdown(s, rows, ranAt, columns) {
  const cur = s.current || {}
  const rq = s.requeue || {}
  const q = s.quality || {}
  const L = []

  L.push(`# Skybolt Raw Material Movement — ${rangeTitle(s.range.start, s.range.end)}`)
  L.push('**Source:** SkyNet (bars & blanks) · Inventory Movement report, dates inclusive, shop local time')
  L.push(`**Pulled:** ${dt(ranAt)}`)
  L.push("**Valuation:** every movement valued at its lot's cost; count adjustments value at the price captured at count time")
  L.push(`**Range:** ${s.range.days} calendar days, ${s.range.business_days} business days · compared with ${d(s.prior.start)} – ${d(s.prior.end)}`)
  L.push('')
  L.push('---')
  L.push('')

  L.push('## Headline')
  L.push('')
  L.push(buildNarrative(s).join(' '))
  L.push('')

  L.push('## Period over period')
  L.push('')
  L.push(mdTable(
    ['Measure', `Previous (${dShort(s.prior.start)} – ${dShort(s.prior.end)})`, `Current (${dShort(s.range.start)} – ${dShort(s.range.end)})`],
    periodRows(s),
  ))
  L.push('')

  L.push('## What came in')
  L.push('')
  const receipts = s.receipts || []
  if (receipts.length === 0) {
    L.push('No receipts in this range.')
  } else {
    L.push(mdTable(
      ['Date', 'Category', 'Material', 'Lot', 'Qty', 'Unit cost', 'Value', 'Reference', 'Received by'],
      receipts.map(r => [
        r.mv_date, r.category, r.material, r.lot_number, signedUnits(r.qty_change),
        r.unit_cost === null || r.unit_cost === undefined ? '' : money(r.unit_cost),
        r.value_change === null || r.value_change === undefined ? 'no cost data' : signedMoney(r.value_change),
        r.reference, r.recorded_by,
      ]),
    ))
  }
  L.push('')

  L.push('## What production drew')
  L.push('')
  L.push('**Bars by material**')
  L.push('')
  const barDraws = s.bar_draws_by_material || []
  L.push(barDraws.length === 0
    ? 'No bar draws in this range.'
    : mdTable(['Material', 'Bars', 'Value'], barDraws.map(r => [r.material, signedUnits(r.units), signedMoney(r.value)])))
  L.push('')
  L.push('**Blanks by type**')
  L.push('')
  const blankDraws = s.blank_draws_by_material || []
  L.push(blankDraws.length === 0
    ? 'No blank draws in this range.'
    : mdTable(['Type', 'Pieces', 'Value'], blankDraws.map(r => [r.material, signedUnits(r.units), signedMoney(r.value)])))
  L.push('')
  L.push('**Largest draws by job**')
  L.push('')
  const topJobs = s.top_jobs || []
  L.push(topJobs.length === 0
    ? 'No production draws in this range.'
    : mdTable(['Job', 'Value', 'Lines'], topJobs.map(r => [jobLabel(r.reference), signedMoney(r.value), r.lines])))
  L.push('')

  const byJob = rq.by_job || []
  if (byJob.length > 0) {
    L.push('## Requeue watch')
    L.push('')
    L.push(`Requeue jobs drew ${money(rq.current_value)}` +
      (rq.current_share_of_bar_draw === null || rq.current_share_of_bar_draw === undefined ? '' : ` (${pct(rq.current_share_of_bar_draw)} of bar draw)`) +
      ` this period, against ${money(rq.previous_value)} the period before.`)
    L.push('')
    L.push(mdTable(
      ['Job', 'This period', 'Previous period', 'Both periods'],
      byJob.map(j => [jobLabel(j.reference), signedMoney(j.current_value), signedMoney(j.previous_value), signedMoney(j.total_value)]),
    ))
    L.push('')
  }

  L.push('## Data quality')
  L.push('')
  const recorders = q.recorders || []
  const named = recorders.slice(0, 2).map(r => `${r.name} (${r.count})`).join(' and ')
  L.push(
    `${num(q.missing_cost_rows) === 0 ? 'Every movement in this range carries lot cost' : `${num(q.missing_cost_rows)} of ${num(cur.movements)} movements sit on lots with no cost data and carry no value in the totals`}. ` +
    `${num(q.adjustment_count) === 0 ? 'No approved count adjustments fell in this range' : `${plural(num(q.adjustment_count), 'approved count adjustment')} totalling ${signedMoney(q.adjustment_value)}`}. ` +
    `${recorders.length === 0 ? 'No recorders logged.' : `Logged by ${plural(recorders.length, 'person')}${named ? `, most of it ${named}` : ''}.`}`,
  )
  L.push('')

  L.push('## Numbers for the Friday scorecard')
  L.push('')
  L.push(mdTable(['Measure', 'Value'], scorecardRows(s)))
  L.push('')

  L.push(`## Appendix — full movement detail (${rows.length} rows)`)
  L.push('')
  L.push(rows.length === 0
    ? 'No movements in this range.'
    : mdTable(columns, rows.map(r => columns.map(c => r[c]))))
  L.push('')

  return L.join('\n')
}

function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ------------------------------ component ------------------------------
export default function InventoryMovementReport({ report, profile, onBack }) {
  const today = isoDay(new Date())
  const [start, setStart] = useState(addDays(today, -6))
  const [end, setEnd] = useState(today)
  const [rows, setRows] = useState(null)
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [ranAt, setRanAt] = useState(null)
  const [copied, setCopied] = useState(false)

  const columns = report?.columns?.length ? report.columns : DETAIL_COLUMNS

  const run = async () => {
    if (!start || !end) { setError('Pick a start and an end date.'); return }
    if (start > end) { setError('The start date must be on or before the end date.'); return }
    setLoading(true)
    setError(null)
    setCopied(false)
    try {
      const [detail, sum] = await Promise.all([
        supabase.rpc('report_inventory_movement', { p_start: start, p_end: end }),
        supabase.rpc('report_inventory_movement_summary', { p_start: start, p_end: end }),
      ])
      if (detail.error) throw detail.error
      if (sum.error) throw sum.error
      setRows(detail.data || [])
      setSummary(sum.data)
      setRanAt(new Date())
    } catch (e) {
      setError(e.message || String(e))
      setRows(null)
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }

  const integrity = summary ? integrityCheck(rows, summary.current) : { ok: true, failures: [] }
  const canExport = canExportReports(profile) && integrity.ok && rows !== null
  const cur = summary?.current
  const prev = summary?.previous
  const empty = rows !== null && rows.length === 0

  const handleCsv = () => {
    downloadCsv(toCsv(rows, columns), `skynet_inventory_movement_${start}_${end}.csv`)
  }

  const handleCopyMarkdown = async () => {
    const md = buildMarkdown(summary, rows, ranAt, columns)
    try {
      await navigator.clipboard.writeText(md)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      // Clipboard blocked (insecure context or permission) — fall back to a file
      // so the summary is never stranded on screen.
      downloadText(md, `Skybolt_RawMaterial_Movement_${start}_to_${end}.md`, 'text/markdown')
    }
  }

  const handleDownloadMarkdown = () => {
    downloadText(buildMarkdown(summary, rows, ranAt, columns),
      `Skybolt_RawMaterial_Movement_${start}_to_${end}.md`, 'text/markdown')
  }

  const receivedValue = cur ? num(cur.bars?.received_value) + num(cur.blanks?.received_value) : 0
  const usedValue = cur ? num(cur.bars?.used_value) + num(cur.blanks?.used_value) : 0
  const prevReceived = prev ? num(prev.bars?.received_value) + num(prev.blanks?.received_value) : 0
  const prevUsed = prev ? num(prev.bars?.used_value) + num(prev.blanks?.used_value) : 0

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="flex items-center gap-2 px-3 py-2 rounded text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
            <ArrowLeft size={16} />
            <span className="text-sm">All Reports</span>
          </button>
          <h2 className="text-white text-lg font-semibold">{report.name}</h2>
          {rows && <span className="text-gray-500 text-sm">{rows.length.toLocaleString()} {rows.length === 1 ? 'movement' : 'movements'}</span>}
        </div>
        {summary && canExport && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopyMarkdown}
              className="flex items-center gap-2 px-3 py-2 rounded bg-gray-800 hover:bg-gray-700 text-white text-sm"
              title="Copy the summary as Markdown for the weekly story"
            >
              {copied ? <Check size={16} className="text-emerald-400" /> : <Copy size={16} />}
              {copied ? 'Copied' : 'Copy summary (Markdown)'}
            </button>
            <button
              onClick={handleDownloadMarkdown}
              className="flex items-center gap-2 px-3 py-2 rounded bg-gray-800 hover:bg-gray-700 text-white text-sm"
              title="Download the summary as a .md file"
            >
              <Download size={16} />
              .md
            </button>
            <button
              onClick={handleCsv}
              className="flex items-center gap-2 px-4 py-2 rounded bg-skynet-accent text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
              <Download size={16} />
              Download CSV
            </button>
          </div>
        )}
      </div>

      {/* controls */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4">
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-gray-500 text-xs mb-1" htmlFor="im-start">Start date <span className="text-gray-600">(inclusive)</span></label>
            <input
              id="im-start"
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="px-3 py-2 bg-gray-950 border border-gray-800 rounded text-white font-mono text-sm focus:outline-none focus:border-skynet-accent"
            />
          </div>
          <div>
            <label className="block text-gray-500 text-xs mb-1" htmlFor="im-end">End date <span className="text-gray-600">(inclusive)</span></label>
            <input
              id="im-end"
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="px-3 py-2 bg-gray-950 border border-gray-800 rounded text-white font-mono text-sm focus:outline-none focus:border-skynet-accent"
            />
          </div>
          <button
            onClick={run}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded bg-skynet-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            <Play size={14} />
            {loading ? 'Running…' : 'Run'}
          </button>
          {ranAt && !loading && (
            <p className="text-gray-500 text-xs font-mono ml-auto">Data pulled {dt(ranAt)}</p>
          )}
        </div>
        {report.explainer && (
          <p className="text-gray-500 text-xs leading-relaxed mt-3 border-t border-gray-800 pt-3">{report.explainer}</p>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-3 bg-red-900/20 border border-red-800 rounded-lg p-4 mb-4">
          <AlertTriangle size={18} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-red-300 text-sm">{error}</p>
        </div>
      )}

      {summary && !integrity.ok && (
        <div className="flex items-start gap-3 bg-red-900/40 border border-red-600 rounded-lg p-4 mb-4">
          <AlertTriangle size={18} className="text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-red-200 text-sm font-semibold">INTEGRITY CHECK FAILED — do not quote this output</p>
            <p className="text-red-300/80 text-xs mt-1">
              The detail rows do not re-add to the summary. Exports are disabled. Investigate before using any number on this page.
            </p>
            <ul className="text-red-300/80 text-xs mt-2 font-mono list-disc pl-5">
              {integrity.failures.map(f => <li key={f}>{f}</li>)}
            </ul>
          </div>
        </div>
      )}

      {!summary && !loading && !error && (
        <div className="text-center py-12 text-gray-500">
          <p className="text-sm">Pick a date range and run — receipts, production draws, and approved count adjustments for bars and blanks, valued at lot cost.</p>
        </div>
      )}

      {summary && (
        <>
          {/* cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
            <Card value={empty ? '—' : signedMoney(cur.net_value)} caption="Net raw material" sub={prev ? `prev: ${signedMoney(prev.net_value)}` : undefined} />
            <Card value={empty ? '—' : signedMoney(cur.bars?.net_value)} caption="Net bars" sub={prev ? `prev: ${signedMoney(prev.bars?.net_value)}` : undefined} />
            <Card value={empty ? '—' : signedMoney(cur.blanks?.net_value)} caption="Net blanks" sub={prev ? `prev: ${signedMoney(prev.blanks?.net_value)}` : undefined} />
            <Card value={empty ? '—' : money(receivedValue)} caption="Received" sub={prev ? `prev: ${money(prevReceived)}` : undefined} />
            <Card value={empty ? '—' : money(usedValue)} caption="Used" sub={prev ? `prev: ${money(prevUsed)}` : undefined} />
            <Card
              value={empty ? '—' : units(cur.missing_cost_rows)}
              caption="Rows missing cost"
              sub="no lot cost — carry no value"
              alert={num(cur.missing_cost_rows) > 0}
            />
          </div>

          {/* headline */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4">
            <h3 className="text-white text-sm font-semibold mb-2">Headline</h3>
            <p className="text-gray-300 text-sm leading-relaxed">{buildNarrative(summary).join(' ')}</p>
            <p className="text-gray-600 text-[11px] mt-3">
              {summary.range.days} calendar days, {summary.range.business_days} business days · compared with {d(summary.prior.start)} – {d(summary.prior.end)}
            </p>
          </div>

          {/* period over period */}
          <Section title="Period over period" note={`${dShort(summary.prior.start)} – ${dShort(summary.prior.end)} vs ${dShort(summary.range.start)} – ${dShort(summary.range.end)}`}>
            <table className="text-xs w-full">
              <thead className="bg-gray-800">
                <tr>
                  <th className={TH}>Measure</th>
                  <th className={`${TH} text-right`}>Previous range</th>
                  <th className={`${TH} text-right`}>Current range</th>
                </tr>
              </thead>
              <tbody>
                {periodRows(summary).map(([label, before, now]) => (
                  <tr key={label} className="border-t border-gray-800">
                    <td className={TD}>{label}</td>
                    <td className={`${TDN} text-gray-400`}>{before}</td>
                    <td className={`${TDN} text-white`}>{now}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          {/* receipts */}
          <Section title="What came in" count={(summary.receipts || []).length}>
            {(summary.receipts || []).length === 0 ? (
              <Empty>No receipts in this range.</Empty>
            ) : (
              <div className="overflow-auto max-h-[40vh]">
                <table className="text-xs w-full">
                  <thead className="sticky top-0 bg-gray-800">
                    <tr>
                      <th className={TH}>Date</th><th className={TH}>Category</th><th className={TH}>Material</th>
                      <th className={TH}>Lot</th><th className={`${TH} text-right`}>Qty</th>
                      <th className={`${TH} text-right`}>Unit cost</th><th className={`${TH} text-right`}>Value</th>
                      <th className={TH}>Reference</th><th className={TH}>Received by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(summary.receipts || []).map((r, i) => (
                      <tr key={`${r.lot_number}-${r.mv_date}-${i}`} className="border-t border-gray-800">
                        <td className={TD}>{d(r.mv_date)}</td>
                        <td className={TD}>{r.category}</td>
                        <td className={`${TD} text-white`}>{r.material}</td>
                        <td className={`${TD} font-mono`}>{r.lot_number || '—'}</td>
                        <td className={`${TDN} text-emerald-300`}>{signedUnits(r.qty_change)}</td>
                        <td className={`${TDN} ${r.unit_cost === null ? 'text-red-300' : ''}`}>{r.unit_cost === null ? 'no cost' : money(r.unit_cost)}</td>
                        <td className={`${TDN} text-emerald-300`}>{r.value_change === null ? '—' : signedMoney(r.value_change)}</td>
                        <td className={TD}>{r.reference || '—'}</td>
                        <td className={TD}>{r.recorded_by || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* draws */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
            <DrawTable title="Bars by material" noun="Bars" rows={summary.bar_draws_by_material} empty="No bar draws in this range." />
            <DrawTable title="Blanks by type" noun="Pieces" rows={summary.blank_draws_by_material} empty="No blank draws in this range." />
            <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-800">
                <h3 className="text-white text-sm font-semibold">Largest draws by job</h3>
              </div>
              {(summary.top_jobs || []).length === 0 ? (
                <Empty>No production draws in this range.</Empty>
              ) : (
                <table className="text-xs w-full">
                  <thead className="bg-gray-800">
                    <tr>
                      <th className={TH}>Job</th>
                      <th className={`${TH} text-right`}>Value</th>
                      <th className={`${TH} text-right`}>Lines</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(summary.top_jobs || []).map(j => (
                      <tr key={j.reference} className="border-t border-gray-800">
                        <td className={`${TD} font-mono text-white`}>{jobLabel(j.reference)}</td>
                        <td className={`${TDN} text-red-300`}>{signedMoney(j.value)}</td>
                        <td className={TDN}>{units(j.lines)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* requeue watch */}
          {(summary.requeue?.by_job || []).length > 0 && (
            <Section title="Requeue watch" count={summary.requeue.by_job.length}>
              <p className="text-gray-300 text-sm px-4 pt-3">
                Requeue jobs drew {money(summary.requeue.current_value)}
                {summary.requeue.current_share_of_bar_draw !== null && summary.requeue.current_share_of_bar_draw !== undefined
                  ? ` (${pct(summary.requeue.current_share_of_bar_draw)} of bar draw)` : ''} this period,
                against {money(summary.requeue.previous_value)} the period before.
              </p>
              <table className="text-xs w-full mt-2">
                <thead className="bg-gray-800">
                  <tr>
                    <th className={TH}>Job</th>
                    <th className={`${TH} text-right`}>This period</th>
                    <th className={`${TH} text-right`}>Previous period</th>
                    <th className={`${TH} text-right`}>Both periods</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.requeue.by_job.map(j => (
                    <tr key={j.reference} className="border-t border-gray-800 bg-amber-900/10">
                      <td className={`${TD} font-mono text-white`}>{jobLabel(j.reference)}</td>
                      <td className={TDN}>{signedMoney(j.current_value)}</td>
                      <td className={`${TDN} text-gray-400`}>{signedMoney(j.previous_value)}</td>
                      <td className={`${TDN} text-amber-300`}>{signedMoney(j.total_value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {/* data quality */}
          <Section title="Data quality">
            <div className="px-4 py-3 text-sm text-gray-300 leading-relaxed">
              {num(summary.quality?.missing_cost_rows) === 0
                ? 'Every movement in this range carries lot cost.'
                : `${num(summary.quality.missing_cost_rows)} of ${units(cur.movements)} movements sit on lots with no cost data; they carry no value in the totals.`}
              {' '}
              {num(summary.quality?.adjustment_count) === 0
                ? 'No approved count adjustments fell in this range.'
                : `${plural(num(summary.quality.adjustment_count), 'approved count adjustment')} totalling ${signedMoney(summary.quality.adjustment_value)}.`}
              {' '}
              {(summary.quality?.recorders || []).length === 0
                ? 'No recorders logged.'
                : `Logged by ${plural(summary.quality.recorders.length, 'person')}, most of it ${summary.quality.recorders.slice(0, 2).map(r => `${r.name} (${r.count})`).join(' and ')}.`}
            </div>
          </Section>

          {/* scorecard */}
          <Section title="Numbers for the scorecard" note="lift these into the weekly story">
            <table className="text-xs w-full">
              <thead className="bg-gray-800">
                <tr>
                  <th className={TH}>Measure</th>
                  <th className={`${TH} text-right`}>Value</th>
                </tr>
              </thead>
              <tbody>
                {scorecardRows(summary).map(([label, value]) => (
                  <tr key={label} className="border-t border-gray-800">
                    <td className={TD}>{label}</td>
                    <td className={`${TDN} text-white`}>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          {/* raw detail */}
          <Section title="Movement detail" count={rows.length} note="the rows behind every number above">
            {rows.length === 0 ? (
              <Empty>No raw-material movement recorded in this range. If activity was expected, do not use this output — investigate first.</Empty>
            ) : (
              <div className="overflow-auto max-h-[60vh] pb-4">
                <table className="text-xs w-full">
                  <thead className="sticky top-0 bg-gray-800">
                    <tr>
                      <th className={TH}>Date</th><th className={TH}>Category</th><th className={TH}>Material</th>
                      <th className={TH}>Lot</th><th className={TH}>Heat</th><th className={TH}>Movement</th>
                      <th className={`${TH} text-right`}>Qty</th><th className={`${TH} text-right`}>Unit cost</th>
                      <th className={`${TH} text-right`}>Value</th><th className={TH}>Reference</th>
                      <th className={TH}>Recorded by</th><th className={TH}>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const noCost = r.unit_cost === null || r.unit_cost === undefined
                      const adj = r.movement_type === 'Adjustment'
                      const tone = noCost ? 'bg-red-900/15' : adj ? 'bg-amber-900/10' : ''
                      const qty = num(r.qty_change)
                      return (
                        <tr key={`${r.mv_date}-${r.lot_number}-${r.movement_type}-${i}`} className={`border-t border-gray-800 ${tone}`}>
                          <td className={TD}>{d(r.mv_date)}</td>
                          <td className={TD}>{r.category}</td>
                          <td className={`${TD} text-white`}>{r.material}</td>
                          <td className={`${TD} font-mono`}>{r.lot_number || '—'}</td>
                          <td className={`${TD} font-mono`}>{r.heat_number || '—'}</td>
                          <td className={`${TD} ${adj ? 'text-amber-300' : ''}`}>{r.movement_type}</td>
                          <td className={`${TDN} ${qty > 0 ? 'text-emerald-300' : qty < 0 ? 'text-red-300' : ''}`}>{signedUnits(r.qty_change)}</td>
                          <td className={`${TDN} ${noCost ? 'text-red-300' : ''}`}>{noCost ? 'no cost' : money(r.unit_cost)}</td>
                          <td className={TDN}>{r.value_change === null || r.value_change === undefined ? '—' : signedMoney(r.value_change)}</td>
                          <td className={TD}>{r.reference || '—'}</td>
                          <td className={TD}>{r.recorded_by || '—'}</td>
                          <td className={`${TD} max-w-xs truncate`} title={r.notes || ''}>{r.notes || ''}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  )
}

function DrawTable({ title, noun, rows, empty }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-800">
        <h3 className="text-white text-sm font-semibold">{title}</h3>
      </div>
      {(rows || []).length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <table className="text-xs w-full">
          <thead className="bg-gray-800">
            <tr>
              <th className={TH}>Material</th>
              <th className={`${TH} text-right`}>{noun}</th>
              <th className={`${TH} text-right`}>Value</th>
            </tr>
          </thead>
          <tbody>
            {(rows || []).map(r => (
              <tr key={r.material} className="border-t border-gray-800">
                <td className={`${TD} text-white`}>{r.material}</td>
                <td className={TDN}>{signedUnits(r.units)}</td>
                <td className={`${TDN} text-red-300`}>{signedMoney(r.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
