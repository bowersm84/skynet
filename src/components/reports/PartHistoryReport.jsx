// Part History (D-RPT-13): an interactive report. Type a part number, get
// everything SkyNet and the Fishbowl mirror know about it — customer orders and
// what is still open, Fishbowl open orders and stock, work orders, every
// production run with its effective (verified) count, finishing batches and
// rejects — and the planning figure the shop actually needs: still to run.
// Assemblies (parts with a BOM) get a components lens: buildable from the
// components made under the product's work orders, the bottleneck named, and
// still-to-make per component; components get a used-in lens. All math lives
// in the report_part_history RPC; this component only renders and exports.
// Sections stack; the CSV stacks the same sections.
import { useState, useEffect, useRef } from 'react'
import { ArrowLeft, Download, Search, Info, AlertTriangle, ChevronRight, ChevronDown } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { canExportReports } from '../../lib/roles'
import { toCsv, downloadCsv } from '../../lib/reports'
import { FB_SO_STATUS, FB_LINE_STATUS } from '../../lib/fishbowl'

const n = (v) => (v === null || v === undefined || v === '') ? '—' : Number(v).toLocaleString()
const d = (v) => {
  if (!v) return '—'
  const s = String(v)
  const dt = s.length <= 10 ? new Date(s + 'T00:00:00') : new Date(s)
  return Number.isNaN(dt.getTime()) ? s : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
const dt = (v) => v ? new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
const label = (s) => s ? String(s).replace(/_/g, ' ') : '—'

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

function Chip({ children, tone = 'gray' }) {
  const tones = {
    gray: 'bg-gray-700 text-gray-300', green: 'bg-emerald-900/50 text-emerald-300', amber: 'bg-amber-900/50 text-amber-300',
    red: 'bg-red-900/50 text-red-300', blue: 'bg-blue-900/50 text-blue-300', violet: 'bg-violet-900/50 text-violet-300',
  }
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${tones[tone] || tones.gray}`}>{children}</span>
}

// ------------------------------ CSV ------------------------------
const CSV_SECTIONS = [
  ['Assembly runs', 'assembly_runs', ['wo_number', 'customer', 'wo_status', 'quantity', 'order_quantity', 'stock_quantity', 'assembly_status', 'good_quantity', 'bad_quantity', 'assembly_lot_number', 'component_jobs', 'due_date', 'created_at']],
  ['Components (buildable from pieces made under this product\'s work orders)', 'components', ['part_number', 'description', 'qty_per', 'produced', 'in_flight', 'purchased_received', 'available', 'buildable', 'required_for_open', 'still_to_make', 'is_bottleneck', 'job_count', 'rejected', 'bad']],
  ['Used in (assemblies that consume this part)', 'used_in', ['assembly_part_number', 'assembly_description', 'qty_per', 'assembly_open_order_qty', 'assembly_fb_available', 'assembly_fb_open_so_qty', 'assembly_still_to_assemble', 'required', 'produced', 'in_flight', 'purchased_received', 'available', 'still_to_make']],
  ['Customer orders (SkyNet)', 'orders', ['co_number', 'customer', 'line_number', 'status', 'quantity_ordered', 'quantity_fulfilled', 'open_qty', 'due_date', 'fb_qty_ordered', 'fb_qty_fulfilled', 'allocated_to']],
  ['Fishbowl open orders', 'fishbowl_orders', ['so_number', 'customer_name', 'customer_po', 'so_status', 'line_number', 'line_status', 'qty_ordered', 'qty_fulfilled', 'qty_remaining', 'due_date', 'disposition', 'co_number']],
  ['Work orders', 'work_orders', ['wo_number', 'order_type', 'status', 'customer', 'order_quantity', 'stock_quantity', 'allocated_qty', 'job_count', 'due_date', 'created_at', 'closed_at', 'is_combined', 'has_open_shortfall']],
  ['Production runs', 'jobs', ['job_number', 'wo_number', 'machine', 'status', 'quantity', 'effective_qty', 'effective_basis', 'good_pieces', 'sent_qty', 'verified_qty', 'approved_good', 'rejected_qty', 'bad_qty', 'batches', 'open_batches', 'missed_qty', 'production_lot_number', 'material_lots', 'production_start', 'actual_end', 'is_requeue', 'merge_role']],
  ['Finishing batches', 'batches', ['job_number', 'batch', 'quantity', 'verified_count', 'status', 'compliance_status', 'compliance_outcome', 'compliance_good_qty', 'compliance_bad_qty', 'finishing_lot_number', 'production_lot_number', 'material_lot_number', 'sent_at', 'compliance_approved_at', 'compliance_notes']],
]

function csvRows(key, rows) {
  if (key === 'orders') {
    return rows.map(r => ({ ...r, allocated_to: (r.allocations || []).map(a => `${a.wo_number} (${a.quantity_allocated}${a.is_active ? '' : ', inactive'})`).join('; ') }))
  }
  if (key === 'fishbowl_orders') {
    return rows.map(r => ({ ...r, so_status: FB_SO_STATUS[r.so_status_id] || r.so_status_id, line_status: FB_LINE_STATUS[r.line_status_id] || r.line_status_id }))
  }
  return rows
}

function buildCsv(data, ranAt) {
  const s = data.summary || {}
  const head = [
    `Part History,${data.part.part_number}`,
    `Description,"${(data.part.description || '').replace(/"/g, '""')}"`,
    `Pulled,${ranAt ? ranAt.toISOString() : ''}`,
    '',
    'Summary,Value',
    `Open on orders (SkyNet),${s.open_order_qty ?? ''}`,
    `In flight (made, not TCO'd),${s.in_flight_qty ?? ''}`,
    `Planned, not started,${s.planned_not_started_qty ?? ''}`,
    `Fishbowl on hand,${s.fb_on_hand ?? ''}`,
    `Fishbowl allocated,${s.fb_allocated ?? ''}`,
    `Fishbowl available (free stock),${s.fb_available ?? ''}`,
    `Fishbowl open to ship,${s.fb_open_so_qty ?? ''}`,
    `Still to run,${s.still_to_run ?? ''}`,
    `Still to assemble,${s.still_to_assemble ?? ''}`,
    `Buildable from components,${s.buildable ?? ''}`,
    `Bottleneck component,${s.bottleneck_component ?? ''}`,
    `Assemblies short of buildable,${s.assemblies_short ?? ''}`,
    `Produced (all time),${s.produced_all_time ?? ''}`,
    `Produced (90 days),${s.produced_90d ?? ''}`,
    `Rejected batches (pieces),${s.rejected_all_time ?? ''}`,
    `Scrap in accepted batches,${s.bad_all_time ?? ''}`,
  ].join('\n')
  const parts = [head]
  for (const [title, key, cols] of CSV_SECTIONS) {
    const rows = csvRows(key, data[key] || [])
    if (rows.length === 0 && ['assembly_runs', 'components', 'used_in'].includes(key)) continue
    parts.push('', title, rows.length ? toCsv(rows, cols) : cols.join(','))
  }
  return parts.join('\n')
}

// ------------------------------ shared tables ------------------------------
function JobsTable({ jobs }) {
  return (
    <table className="text-xs w-full">
      <thead className="sticky top-0 bg-gray-800">
        <tr>
          <th className={TH}>Job</th><th className={TH}>WO</th><th className={TH}>Machine</th><th className={TH}>Status</th>
          <th className={`${TH} text-right`}>Target</th><th className={`${TH} text-right`}>Produced</th><th className={TH}>Basis</th>
          <th className={`${TH} text-right`}>Sent</th><th className={`${TH} text-right`}>Verified</th><th className={`${TH} text-right`}>Rejected</th><th className={`${TH} text-right`}>Scrap</th>
          <th className={`${TH} text-right`}>Batches</th><th className={TH}>PLN</th><th className={TH}>Material lots</th><th className={TH}>Started</th><th className={TH}>Ended</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map(j => {
          const live = !['complete', 'cancelled', 'merged'].includes(j.status)
          return (
            <tr key={j.job_number} className={`border-t border-gray-800 ${live ? 'bg-blue-900/10' : ''}`}>
              <td className={`${TD} font-mono text-white`}>
                {j.job_number}
                {j.is_requeue && <span className="ml-1"><Chip tone="amber">RQ</Chip></span>}
                {j.merge_role && <span className="ml-1"><Chip tone="violet">{j.merge_role}</Chip></span>}
              </td>
              <td className={`${TD} font-mono`}>{j.wo_number || '—'}</td>
              <td className={TD}>{j.machine || '—'}</td>
              <td className={TD}>{label(j.status)}</td>
              <td className={TDN}>{n(j.quantity)}</td>
              <td className={`${TDN} text-white`}>{n(j.effective_qty)}</td>
              <td className={TD}>{j.effective_basis}</td>
              <td className={TDN}>{n(j.sent_qty)}</td>
              <td className={TDN}>{n(j.verified_qty)}</td>
              <td className={`${TDN} ${j.rejected_qty > 0 ? 'text-red-300' : ''}`}>{n(j.rejected_qty)}</td>
              <td className={`${TDN} ${j.bad_qty > 0 ? 'text-amber-300' : ''}`}>{n(j.bad_qty)}</td>
              <td className={TDN}>{n(j.batches)}{j.open_batches > 0 ? <span className="text-amber-300"> ({j.open_batches} open)</span> : ''}</td>
              <td className={`${TD} font-mono`}>{j.production_lot_number || '—'}</td>
              <td className={`${TD} font-mono`}>{j.material_lots || '—'}</td>
              <td className={TD}>{d(j.production_start)}</td>
              <td className={TD}>{d(j.actual_end)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function BatchesTable({ batches }) {
  return (
    <table className="text-xs w-full">
      <thead className="sticky top-0 bg-gray-800">
        <tr>
          <th className={TH}>Job</th><th className={TH}>Batch</th><th className={`${TH} text-right`}>Qty</th><th className={`${TH} text-right`}>Verified</th>
          <th className={TH}>Finishing</th><th className={TH}>Compliance</th><th className={TH}>Outcome</th><th className={`${TH} text-right`}>Good</th><th className={`${TH} text-right`}>Bad</th>
          <th className={TH}>FLN</th><th className={TH}>Material lot</th><th className={TH}>Sent</th><th className={TH}>Approved</th><th className={TH}>Notes</th>
        </tr>
      </thead>
      <tbody>
        {batches.map((b, i) => {
          const flagged = b.compliance_status === 'rejected' || b.compliance_outcome === 'rework' || b.compliance_outcome === 'rejected'
          return (
            <tr key={`${b.job_number}-${b.batch}-${i}`} className={`border-t border-gray-800 ${flagged ? 'bg-red-900/15' : ''}`}>
              <td className={`${TD} font-mono`}>{b.job_number}</td>
              <td className={`${TD} font-mono`}>{b.batch}</td>
              <td className={TDN}>{n(b.quantity)}</td>
              <td className={TDN}>{n(b.verified_count)}</td>
              <td className={TD}>{label(b.status)}</td>
              <td className={`${TD} ${b.compliance_status === 'rejected' ? 'text-red-300' : ''}`}>{label(b.compliance_status)}</td>
              <td className={TD}>{label(b.compliance_outcome)}</td>
              <td className={TDN}>{n(b.compliance_good_qty)}</td>
              <td className={`${TDN} ${b.compliance_bad_qty > 0 ? 'text-amber-300' : ''}`}>{n(b.compliance_bad_qty)}</td>
              <td className={`${TD} font-mono`}>{b.finishing_lot_number || '—'}</td>
              <td className={`${TD} font-mono`}>{b.material_lot_number || '—'}</td>
              <td className={TD}>{dt(b.sent_at)}</td>
              <td className={TD}>{dt(b.compliance_approved_at)}</td>
              <td className={`${TD} max-w-xs truncate`} title={b.compliance_notes || ''}>{b.compliance_notes || ''}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// One BOM component of the searched assembly; expands to its runs and batches
// under this product's work orders.
function ComponentRow({ c }) {
  const [open, setOpen] = useState(false)
  const short = c.still_to_make > 0
  return (
    <>
      <tr className={`border-t border-gray-800 ${c.is_bottleneck ? 'bg-amber-900/10' : ''}`}>
        <td className={`${TD} font-mono text-white`}>
          <button type="button" onClick={() => setOpen(v => !v)} className="inline-flex items-center gap-1 hover:text-skynet-accent" aria-expanded={open}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {c.part_number}
          </button>
          {c.is_bottleneck && <span className="ml-1"><Chip tone="amber">limits build</Chip></span>}
        </td>
        <td className={TD}>{c.description || '—'}</td>
        <td className={TDN}>{n(c.qty_per)}</td>
        <td className={TDN}>{n(c.produced)}<span className="text-gray-500"> / {n(c.in_flight)}</span></td>
        <td className={TDN}>{n(c.purchased_received)}{c.purchased_lots > 0 ? <span className="text-gray-500"> ({c.purchased_lots})</span> : ''}</td>
        <td className={`${TDN} text-white`}>{n(c.available)}</td>
        <td className={`${TDN} ${c.is_bottleneck ? 'text-amber-300' : ''}`}>{n(c.buildable)}</td>
        <td className={TDN}>{n(c.required_for_open)}</td>
        <td className={`${TDN} ${short ? 'text-amber-300' : 'text-emerald-300'}`}>{n(c.still_to_make)}</td>
        <td className={TDN}>{n(c.job_count)}</td>
        <td className={`${TDN} ${c.rejected > 0 ? 'text-red-300' : ''}`}>{n(c.rejected)}</td>
      </tr>
      {open && (
        <tr className="border-t border-gray-800 bg-gray-950/60">
          <td colSpan={11} className="px-3 py-3">
            <p className="text-gray-500 text-[11px] uppercase tracking-wide mb-1">Runs under this product's work orders</p>
            {c.jobs.length === 0
              ? <p className="text-gray-500 text-xs mb-3">No production jobs for this component under the product's work orders.</p>
              : <div className="overflow-auto max-h-[40vh] mb-3 rounded border border-gray-800"><JobsTable jobs={c.jobs} /></div>}
            {c.batches.length > 0 && (
              <>
                <p className="text-gray-500 text-[11px] uppercase tracking-wide mb-1">Finishing batches</p>
                <div className="overflow-auto max-h-[40vh] rounded border border-gray-800"><BatchesTable batches={c.batches} /></div>
              </>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

// ------------------------------ component ------------------------------
export default function PartHistoryReport({ report, profile, onBack }) {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [ranAt, setRanAt] = useState(null)
  const timer = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  // Type-ahead on part_number; parts is readable by every SkyNet role.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2 || (data?.found && data.part.part_number === q.toUpperCase())) { setSuggestions([]); return undefined }
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      const { data: rows } = await supabase
        .from('parts')
        .select('part_number, description')
        .ilike('part_number', `%${q}%`)
        .order('part_number')
        .limit(8)
      setSuggestions(rows || [])
    }, 200)
    return () => clearTimeout(timer.current)
  }, [query, data])

  const run = async (pn) => {
    const target = String(pn ?? query).trim()
    if (!target) return
    setLoading(true)
    setError(null)
    setSuggestions([])
    try {
      const { data: res, error: err } = await supabase.rpc('report_part_history', { p_part_number: target })
      if (err) throw err
      setData(res)
      setRanAt(new Date())
      if (res?.found) setQuery(res.part.part_number)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  const s = data?.found ? data.summary : null
  const isAssembly = data?.kind === 'assembly' || data?.kind === 'both'
  const isComponent = data?.kind === 'component' || data?.kind === 'both'
  const openOrders = (data?.orders || []).filter(o => o.open_qty > 0)
  const closedOrders = (data?.orders || []).filter(o => !(o.open_qty > 0))

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="flex items-center gap-2 px-3 py-2 rounded text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
            <ArrowLeft size={16} />
            <span className="text-sm">All Reports</span>
          </button>
          <h2 className="text-white text-lg font-semibold">{report.name}</h2>
          {data?.found && <span className="text-gray-500 text-sm font-mono">{data.part.part_number}</span>}
        </div>
        {data?.found && canExportReports(profile) && (
          <button
            onClick={() => downloadCsv(buildCsv(data, ranAt), `part_history_${data.part.part_number}_${new Date().toISOString().slice(0, 10)}.csv`)}
            className="flex items-center gap-2 px-4 py-2 rounded bg-skynet-accent text-white text-sm font-medium hover:opacity-90 transition-opacity"
          >
            <Download size={16} />
            Download CSV
          </button>
        )}
      </div>

      {/* search */}
      <div className="relative mb-4">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 max-w-xl">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') run() }}
              placeholder="Part number — e.g. SK35C38B1"
              className="w-full pl-9 pr-3 py-2 bg-gray-900 border border-gray-800 rounded text-white font-mono text-sm focus:outline-none focus:border-skynet-accent"
            />
            {suggestions.length > 0 && (
              <div className="absolute z-20 mt-1 w-full bg-gray-900 border border-gray-700 rounded shadow-xl overflow-hidden">
                {suggestions.map(sg => (
                  <button
                    key={sg.part_number}
                    onClick={() => { setQuery(sg.part_number); run(sg.part_number) }}
                    className="w-full text-left px-3 py-2 hover:bg-gray-800 flex items-center gap-3"
                  >
                    <span className="text-white font-mono text-sm">{sg.part_number}</span>
                    <span className="text-gray-500 text-xs truncate">{sg.description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => run()}
            disabled={loading || !query.trim()}
            className="px-4 py-2 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-sm"
          >
            {loading ? 'Running…' : 'Run'}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 bg-red-900/20 border border-red-800 rounded-lg p-4 mb-4">
          <AlertTriangle size={18} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-red-300 text-sm">{error}</p>
        </div>
      )}

      {data && !data.found && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4">
          <p className="text-gray-300 text-sm">No part matches <span className="font-mono text-white">{data.query}</span>.</p>
          {data.suggestions?.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {data.suggestions.map(sg => (
                <button key={sg.part_number} onClick={() => { setQuery(sg.part_number); run(sg.part_number) }} className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-white font-mono text-xs">
                  {sg.part_number}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {!data && !loading && !error && (
        <div className="text-center py-12 text-gray-500">
          <Search size={28} className="mx-auto mb-3 text-gray-700" />
          <p className="text-sm">Search a part number to see its orders, production, rejects, Fishbowl stock, and what is still to run.</p>
        </div>
      )}

      {data?.found && (
        <>
          {/* header */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <p className="text-white text-xl font-mono font-semibold">{data.part.part_number}</p>
                <p className="text-gray-400 text-sm">{data.part.description || '—'}{data.part.material_type ? ` · ${data.part.material_type}` : ''}</p>
              </div>
              {ranAt && <p className="text-gray-500 text-xs font-mono">Data pulled {dt(ranAt)}</p>}
            </div>

            {isAssembly ? (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mt-4">
                <Card value={n(s.open_order_qty)} caption="Open on orders (SkyNet)" sub={`${s.open_lines} open line${s.open_lines === 1 ? '' : 's'} · ordered − TCO'd`} />
                <Card value={n(s.fb_available)} caption="Fishbowl free stock" sub={s.fb_snapshot_at ? `on hand ${n(s.fb_on_hand)} · allocated ${n(s.fb_allocated)} · ${dt(s.fb_snapshot_at)}` : 'not on an open SO — no mirror row'} />
                <Card value={n(s.fb_open_so_qty)} caption="Fishbowl open to ship" sub={`${s.fb_open_lines} open SO line${s.fb_open_lines === 1 ? '' : 's'} · ordered − shipped`} />
                <Card value={n(s.still_to_assemble)} caption="Still to assemble" sub="open − free stock" />
                <Card value={n(s.buildable)} caption="Buildable from components" sub={s.bottleneck_component ? `limited by ${s.bottleneck_component}` : `${s.component_count} component${s.component_count === 1 ? '' : 's'}`} />
                <Card value={n(s.assemblies_short)} caption="Short of buildable" sub="still to assemble − buildable" alert={s.assemblies_short > 0} />
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mt-4">
                <Card value={n(s.open_order_qty)} caption="Open on orders (SkyNet)" sub={`${s.open_lines} open line${s.open_lines === 1 ? '' : 's'} · ordered − TCO'd`} />
                <Card value={n(s.in_flight_qty)} caption="In flight — made, not TCO'd" sub={`${s.in_flight_jobs} job${s.in_flight_jobs === 1 ? '' : 's'} with production`} />
                <Card value={n(s.planned_not_started_qty)} caption="Planned, not started" sub={`${s.planned_jobs} job${s.planned_jobs === 1 ? '' : 's'} scheduled or queued`} />
                <Card value={n(s.fb_available)} caption="Fishbowl free stock" sub={s.fb_snapshot_at ? `on hand ${n(s.fb_on_hand)} · allocated ${n(s.fb_allocated)} · ${dt(s.fb_snapshot_at)}` : 'not on an open SO — no mirror row'} />
                <Card value={n(s.fb_open_so_qty)} caption="Fishbowl open to ship" sub={`${s.fb_open_lines} open SO line${s.fb_open_lines === 1 ? '' : 's'} · ordered − shipped`} />
                <Card value={n(s.still_to_run)} caption="Still to run ≈" sub="open − in flight − free stock" alert={s.still_to_run > 0} />
              </div>
            )}

            <div className="flex items-start gap-2 mt-4 text-xs text-gray-400 leading-relaxed">
              <Info size={14} className="text-gray-500 mt-0.5 shrink-0" />
              {isAssembly ? (
                <p>
                  Still to assemble = {n(s.open_order_qty)} open on orders − {n(Math.max(0, s.fb_available || 0))} free stock = <span className="text-white">{n(s.still_to_assemble)}</span>.
                  {' '}Buildable = the smallest of (pieces available ÷ qty per) across the {s.component_count} components, counting only pieces made under this product's work orders plus received purchased lots
                  {s.bottleneck_component ? <> — {s.bottleneck_component} sets it at <span className="text-white">{n(s.buildable)}</span></> : <> = <span className="text-white">{n(s.buildable)}</span></>}.
                  {' '}Short of buildable = {n(s.still_to_assemble)} − {n(s.buildable)} = <span className="text-white">{n(s.assemblies_short)}</span> assemblies whose components are not made yet; each component's still-to-make is below.
                  {' '}Nothing is subtracted for assemblies already built: the assembly module is not live, so consumption is not tracked yet.
                </p>
              ) : (
                <p>
                  Still to run = {n(s.open_order_qty)} open on orders − {n(s.in_flight_qty)} in flight − {n(Math.max(0, s.fb_available || 0))} free stock = <span className="text-white">{n(s.still_to_run)}</span>.
                  {' '}A planning figure, not a gate: in flight counts each job's verified pieces where compliance has approved batches and the machinist's count otherwise;
                  {' '}planned jobs ({n(s.planned_not_started_qty)}) are not subtracted because nothing has been made on them yet.
                  {' '}Produced all time {n(s.produced_all_time)} (last 90 days {n(s.produced_90d)}); rejected batches {n(s.rejected_all_time)}; scrap inside accepted batches {n(s.bad_all_time)}.
                  {isComponent && <> This part is a component of {data.used_in.length} assembl{data.used_in.length === 1 ? 'y' : 'ies'} — see Used in.</>}
                </p>
              )}
            </div>
            {report.explainer && (
              <p className="text-gray-500 text-xs leading-relaxed mt-3 border-t border-gray-800 pt-3">{report.explainer}</p>
            )}
          </div>

          {isAssembly && (
            <Section title="Components — buildable from pieces made under this product's work orders" count={data.components.length} note="Produced / in flight · purchased = received lots linked to these WOs">
              <div className="overflow-auto max-h-[60vh] pb-3">
                <table className="text-xs w-full">
                  <thead className="sticky top-0 bg-gray-800">
                    <tr>
                      <th className={TH}>Component</th><th className={TH}>Description</th><th className={`${TH} text-right`}>Qty per</th>
                      <th className={`${TH} text-right`}>Produced / in flight</th><th className={`${TH} text-right`}>Purchased</th><th className={`${TH} text-right`}>Available</th>
                      <th className={`${TH} text-right`}>Builds</th><th className={`${TH} text-right`}>Required for open</th><th className={`${TH} text-right`}>Still to make</th>
                      <th className={`${TH} text-right`}>Jobs</th><th className={`${TH} text-right`}>Rejected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.components.map(c => <ComponentRow key={c.part_number} c={c} />)}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {isAssembly && (
            <Section title="Assembly runs" count={data.assembly_runs.length} note="assembly module not live — assembled good / bad stay blank until it is">
              {data.assembly_runs.length === 0 ? (
                <p className="text-gray-500 text-sm px-4 py-3">No work orders carry this assembly.</p>
              ) : (
                <div className="overflow-auto max-h-[50vh] pb-3">
                  <table className="text-xs w-full">
                    <thead className="sticky top-0 bg-gray-800">
                      <tr>
                        <th className={TH}>WO</th><th className={TH}>Customer</th><th className={TH}>WO status</th><th className={`${TH} text-right`}>Target</th>
                        <th className={`${TH} text-right`}>Order / stock</th><th className={TH}>Assembly status</th><th className={`${TH} text-right`}>Assembled good / bad</th>
                        <th className={TH}>Assembly lot</th><th className={`${TH} text-right`}>Component jobs</th><th className={TH}>Due</th><th className={TH}>Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.assembly_runs.map(a => (
                        <tr key={a.wo_number} className="border-t border-gray-800">
                          <td className={`${TD} font-mono text-white`}>{a.wo_number}</td>
                          <td className={TD}>{a.customer || '—'}</td>
                          <td className={TD}>{label(a.wo_status)}</td>
                          <td className={TDN}>{n(a.quantity)}</td>
                          <td className={TDN}>{n(a.order_quantity)} / {n(a.stock_quantity)}</td>
                          <td className={TD}>{label(a.assembly_status)}</td>
                          <td className={TDN}>{n(a.good_quantity)} / {n(a.bad_quantity)}</td>
                          <td className={`${TD} font-mono`}>{a.assembly_lot_number || '—'}</td>
                          <td className={TDN}>{n(a.component_jobs)}</td>
                          <td className={TD}>{d(a.due_date)}</td>
                          <td className={TD}>{d(a.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          )}

          {isComponent && (
            <Section title="Used in — assemblies that consume this part" count={data.used_in.length} note="required = the assembly's still-to-assemble × qty per; produced = this part's pieces under that assembly's work orders">
              <div className="overflow-auto max-h-[50vh] pb-3">
                <table className="text-xs w-full">
                  <thead className="sticky top-0 bg-gray-800">
                    <tr>
                      <th className={TH}>Assembly</th><th className={TH}>Description</th><th className={`${TH} text-right`}>Qty per</th>
                      <th className={`${TH} text-right`}>Assembly open orders</th><th className={`${TH} text-right`}>Assembly free stock</th><th className={`${TH} text-right`}>Assembly open to ship (FB)</th>
                      <th className={`${TH} text-right`}>Still to assemble</th><th className={`${TH} text-right`}>Required of this part</th>
                      <th className={`${TH} text-right`}>Produced / in flight</th><th className={`${TH} text-right`}>Purchased</th><th className={`${TH} text-right`}>Still to make</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.used_in.map(u => (
                      <tr key={u.assembly_part_number} className={`border-t border-gray-800 ${u.still_to_make > 0 ? 'bg-amber-900/10' : ''}`}>
                        <td className={`${TD} font-mono text-white`}>{u.assembly_part_number}</td>
                        <td className={TD}>{u.assembly_description || '—'}</td>
                        <td className={TDN}>{n(u.qty_per)}</td>
                        <td className={TDN}>{n(u.assembly_open_order_qty)}</td>
                        <td className={TDN}>{n(u.assembly_fb_available)}</td>
                        <td className={TDN}>{n(u.assembly_fb_open_so_qty)}</td>
                        <td className={TDN}>{n(u.assembly_still_to_assemble)}</td>
                        <td className={TDN}>{n(u.required)}</td>
                        <td className={TDN}>{n(u.produced)}<span className="text-gray-500"> / {n(u.in_flight)}</span></td>
                        <td className={TDN}>{n(u.purchased_received)}</td>
                        <td className={`${TDN} ${u.still_to_make > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>{n(u.still_to_make)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {/* customer orders */}
          <Section title="Customer orders (SkyNet)" count={data.orders.length} note="fulfilled posts at TCO">
            {data.orders.length === 0 ? (
              <p className="text-gray-500 text-sm px-4 py-3">No customer order lines for this part.</p>
            ) : (
              <div className="overflow-auto max-h-[50vh] pb-3">
                <table className="text-xs w-full">
                  <thead className="sticky top-0 bg-gray-800">
                    <tr>
                      <th className={TH}>CO</th><th className={TH}>Customer</th><th className={TH}>Line</th><th className={TH}>Status</th>
                      <th className={`${TH} text-right`}>Ordered</th><th className={`${TH} text-right`}>Fulfilled</th><th className={`${TH} text-right`}>Open</th>
                      <th className={TH}>Due</th><th className={TH}>Allocated to</th><th className={`${TH} text-right`}>FB ordered / shipped</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...openOrders, ...closedOrders].map((o, i) => (
                      <tr key={`${o.co_number}-${o.line_number}-${i}`} className={`border-t border-gray-800 ${o.open_qty > 0 ? 'bg-amber-900/10' : ''}`}>
                        <td className={`${TD} font-mono text-blue-400`}>{o.co_number}</td>
                        <td className={TD}>{o.customer || '—'}</td>
                        <td className={TD}>{o.line_number}</td>
                        <td className={TD}>{label(o.status)}</td>
                        <td className={TDN}>{n(o.quantity_ordered)}</td>
                        <td className={TDN}>{n(o.quantity_fulfilled)}</td>
                        <td className={`${TDN} ${o.open_qty > 0 ? 'text-amber-300' : ''}`}>{n(o.open_qty)}</td>
                        <td className={TD}>{d(o.due_date)}</td>
                        <td className={`${TD} font-mono`}>{(o.allocations || []).map(a => `${a.wo_number} (${n(a.quantity_allocated)}${a.is_active ? '' : ', inactive'})`).join('; ') || '—'}</td>
                        <td className={TDN}>{o.fb_qty_ordered != null ? `${n(o.fb_qty_ordered)} / ${n(o.fb_qty_fulfilled)}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* fishbowl */}
          <Section title="Fishbowl open orders & stock" count={data.fishbowl_orders.length} note={s.fb_snapshot_at ? `inventory snapshot ${dt(s.fb_snapshot_at)}` : 'no inventory row — the mirror only tracks parts on open SO lines'}>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 px-4 py-3 border-b border-gray-800">
              <div><p className="text-gray-500 text-[11px]">On hand</p><p className="text-white font-mono">{n(s.fb_on_hand)}</p></div>
              <div><p className="text-gray-500 text-[11px]">Allocated</p><p className="text-white font-mono">{n(s.fb_allocated)}</p></div>
              <div><p className="text-gray-500 text-[11px]">Available</p><p className="text-white font-mono">{n(s.fb_available)}</p></div>
              <div><p className="text-gray-500 text-[11px]">On order</p><p className="text-white font-mono">{n(s.fb_on_order)}</p></div>
              <div><p className="text-gray-500 text-[11px]">Open to ship</p><p className="text-white font-mono">{n(s.fb_open_so_qty)}</p></div>
            </div>
            {data.fishbowl_orders.length === 0 ? (
              <p className="text-gray-500 text-sm px-4 py-3">No open Fishbowl sales order lines for this part.</p>
            ) : (
              <div className="overflow-auto max-h-[50vh] pb-3">
                <table className="text-xs w-full">
                  <thead className="sticky top-0 bg-gray-800">
                    <tr>
                      <th className={TH}>SO</th><th className={TH}>Customer</th><th className={TH}>PO</th><th className={TH}>SO status</th><th className={TH}>Line</th><th className={TH}>Line status</th>
                      <th className={`${TH} text-right`}>Ordered</th><th className={`${TH} text-right`}>Shipped</th><th className={`${TH} text-right`}>Remaining</th>
                      <th className={TH}>Due</th><th className={TH}>Disposition</th><th className={TH}>SkyNet CO</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.fishbowl_orders.map((f, i) => (
                      <tr key={`${f.so_number}-${f.line_number}-${i}`} className="border-t border-gray-800">
                        <td className={`${TD} font-mono`}>{f.so_number}</td>
                        <td className={TD}>{f.customer_name || '—'}</td>
                        <td className={`${TD} font-mono`}>{f.customer_po || '—'}</td>
                        <td className={TD}>{FB_SO_STATUS[f.so_status_id] || f.so_status_id}</td>
                        <td className={TD}>{f.line_number}</td>
                        <td className={TD}>{FB_LINE_STATUS[f.line_status_id] || f.line_status_id}</td>
                        <td className={TDN}>{n(f.qty_ordered)}</td>
                        <td className={TDN}>{n(f.qty_fulfilled)}</td>
                        <td className={`${TDN} ${f.qty_remaining > 0 ? 'text-amber-300' : ''}`}>{n(f.qty_remaining)}</td>
                        <td className={TD}>{d(f.due_date)}</td>
                        <td className={TD}>{label(f.disposition)}</td>
                        <td className={`${TD} font-mono text-blue-400`}>{f.co_number || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* work orders */}
          <Section title="Work orders" count={data.work_orders.length} note="order / stock quantities are creation-time snapshots; allocations are live">
            {data.work_orders.length === 0 ? (
              <p className="text-gray-500 text-sm px-4 py-3">No work orders for this part.</p>
            ) : (
              <div className="overflow-auto max-h-[50vh] pb-3">
                <table className="text-xs w-full">
                  <thead className="sticky top-0 bg-gray-800">
                    <tr>
                      <th className={TH}>WO</th><th className={TH}>Type</th><th className={TH}>Status</th><th className={TH}>Customer</th>
                      <th className={`${TH} text-right`}>Order qty</th><th className={`${TH} text-right`}>Stock qty</th><th className={`${TH} text-right`}>Allocated</th><th className={`${TH} text-right`}>Jobs</th>
                      <th className={TH}>Due</th><th className={TH}>Created</th><th className={TH}>Closed</th><th className={TH}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.work_orders.map(w => (
                      <tr key={w.wo_number} className="border-t border-gray-800">
                        <td className={`${TD} font-mono text-white`}>{w.wo_number}</td>
                        <td className={TD}>{w.order_type === 'make_to_stock' ? 'MTS' : w.order_type === 'make_to_order' ? 'MTO' : label(w.order_type)}</td>
                        <td className={TD}>{label(w.status)}</td>
                        <td className={TD}>{w.customer || '—'}</td>
                        <td className={TDN}>{n(w.order_quantity)}</td>
                        <td className={TDN}>{n(w.stock_quantity)}</td>
                        <td className={TDN}>{n(w.allocated_qty)}</td>
                        <td className={TDN}>{n(w.job_count)}</td>
                        <td className={TD}>{d(w.due_date)}</td>
                        <td className={TD}>{d(w.created_at)}</td>
                        <td className={TD}>{d(w.closed_at)}</td>
                        <td className={`${TD} space-x-1`}>
                          {w.is_combined && <Chip tone="violet">combined</Chip>}
                          {w.has_open_shortfall && <Chip tone="red">shortfall</Chip>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* production runs */}
          {(!isAssembly || data.jobs.length > 0) && (
            <Section title="Production runs" count={data.jobs.length} note="Produced = verified pieces where compliance approved batches, machinist count otherwise">
              {data.jobs.length === 0
                ? <p className="text-gray-500 text-sm px-4 py-3">No production jobs for this part.</p>
                : <div className="overflow-auto max-h-[55vh] pb-3"><JobsTable jobs={data.jobs} /></div>}
            </Section>
          )}

          {/* batches */}
          {(!isAssembly || data.batches.length > 0) && (
            <Section title="Finishing batches" count={data.batches.length} note="rejected and rework rows highlighted">
              {data.batches.length === 0
                ? <p className="text-gray-500 text-sm px-4 py-3">No finishing batches for this part.</p>
                : <div className="overflow-auto max-h-[55vh] pb-3"><BatchesTable batches={data.batches} /></div>}
            </Section>
          )}
        </>
      )}
    </div>
  )
}
