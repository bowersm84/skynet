import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { ChevronRight, Loader2, AlertTriangle } from 'lucide-react'
import { getFbClosedReview, resolveFbClosedLine } from '../lib/fbClosedLines'
import { hasRole } from '../lib/roles'

// D-FBCLOSE-01: open CO lines that Fishbowl already shipped (or closed short)
// while a work order is still allocated to them. Default action: keep the WO
// running as stock.

const JOB_STATE = {
  running: { label: 'Still running', cls: 'bg-amber-900/40 text-amber-300 border-amber-700/60', title: 'A job on this work order is still in production' },
  awaiting_tco: { label: 'Made, awaiting TCO', cls: 'bg-sky-900/40 text-sky-300 border-sky-700/60', title: 'Production is done; the line closes when TCO is cleared, or close it now' },
  jobs_complete: { label: 'Jobs complete', cls: 'bg-gray-800 text-gray-300 border-gray-600', title: 'The jobs are complete but the line was never fulfilled in SkyNet' },
  no_jobs: { label: 'No jobs', cls: 'bg-gray-800 text-gray-400 border-gray-700', title: 'Nothing is running on this work order' },
}

const FB_STATE = {
  fulfilled: { label: 'Shipped in Fishbowl', cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/60' },
  closed_short: { label: 'Closed short in Fishbowl', cls: 'bg-amber-900/40 text-amber-300 border-amber-700/60' },
  cancelled: { label: 'Cancelled in Fishbowl', cls: 'bg-red-900/40 text-red-300 border-red-700/60' },
  historical: { label: 'Historical in Fishbowl', cls: 'bg-gray-800 text-gray-400 border-gray-700' },
}

function fmtDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })
}

export function FbStateBadge({ state, soNumbers, completedAt }) {
  const m = FB_STATE[state]
  if (!m) return null
  const when = fmtDate(completedAt)
  return (
    <span
      className={`inline-block px-1.5 py-0.5 text-[10px] rounded border whitespace-nowrap ${m.cls}`}
      title={soNumbers ? `Fishbowl SO ${soNumbers}` : undefined}
    >
      {m.label}{when ? ` ${when}` : ''}
    </span>
  )
}

export default function FbClosedReviewPanel({ profile, setActionStatus, onChanged, refreshKey }) {
  const canAct = hasRole(profile, 'admin', 'scheduler')
  const [rows, setRows] = useState([])
  // Hidden only until the first load; later refreshes keep the current rows
  // (and the open state) on screen until the new ones arrive.
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(async () => {
    try {
      setRows(await getFbClosedReview(supabase))
    } catch (err) {
      setActionStatus?.({ type: 'error', message: `Failed to load the Fishbowl review list: ${err.message}` })
    } finally {
      setLoaded(true)
    }
  }, [setActionStatus])

  // refreshKey: the parent bumps it after a Release on Demand, which can close a line listed here
  useEffect(() => {
    load()
  }, [load, refreshKey])

  const act = async (row, action) => {
    const what = action === 'keep_as_stock'
      ? `Close ${row.co_number} line #${row.line_number} (${row.part_number}) as shipped in Fishbowl and keep ${row.work_orders} running as stock?`
      : `Close ${row.co_number} line #${row.line_number} (${row.part_number}) as shipped in Fishbowl and flag ${row.work_orders} for review in Order Lookup?`
    if (!window.confirm(what)) return
    setBusyId(row.customer_order_line_id)
    try {
      const res = await resolveFbClosedLine(supabase, row.customer_order_line_id, action, null)
      const parts = []
      if (res?.wo_converted_to_stock?.length) parts.push(`${res.wo_converted_to_stock.join(', ')} now stock`)
      if (res?.wo_flagged_for_review?.length) parts.push(`${res.wo_flagged_for_review.join(', ')} flagged for review`)
      if (res?.wo_still_serving_others?.length) parts.push(`${res.wo_still_serving_others.join(', ')} still serves other orders`)
      setActionStatus?.({
        type: 'success',
        message: `${row.co_number} line #${row.line_number} closed${parts.length ? ' — ' + parts.join('; ') : ''}.`,
      })
      await load()
      onChanged?.()
    } catch (err) {
      setActionStatus?.({ type: 'error', message: `Could not close ${row.co_number} line #${row.line_number}: ${err.message}` })
    } finally {
      setBusyId(null)
    }
  }

  if (!loaded || rows.length === 0) return null

  return (
    <div className="mb-4 rounded-lg border border-amber-700/50 bg-amber-950/20">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-4 py-2.5 text-left">
        <ChevronRight size={16} className={`text-amber-400 transition-transform ${open ? 'rotate-90' : ''}`} />
        <AlertTriangle size={16} className="text-amber-400" />
        <span className="text-sm font-medium text-amber-200">Shipped in Fishbowl, still building</span>
        <span className="px-1.5 py-0.5 text-[10px] rounded bg-amber-900/60 text-amber-200 border border-amber-700/60 font-mono">{rows.length}</span>
        <span className="text-xs text-gray-500 ml-2">These orders already shipped in Fishbowl, but a work order is still allocated to them.</span>
      </button>
      {open && (
        <div className="border-t border-amber-800/40 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-gray-500 text-[10px] uppercase">
              <tr>
                <th className="px-3 py-2 text-left">CO #</th>
                <th className="px-3 py-2 text-left">Customer</th>
                <th className="px-3 py-2 text-left">Line</th>
                <th className="px-3 py-2 text-left">Part</th>
                <th className="px-3 py-2 text-right">Ordered</th>
                <th className="px-3 py-2 text-left">Fishbowl</th>
                <th className="px-3 py-2 text-left">Work order / jobs</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-right">{canAct ? 'Action' : ''}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const js = JOB_STATE[row.job_state] || JOB_STATE.no_jobs
                const busy = busyId === row.customer_order_line_id
                return (
                  <tr key={row.customer_order_line_id} className="border-t border-gray-800 align-top">
                    <td className="px-3 py-2 font-mono text-purple-300 text-xs">{row.co_number}</td>
                    <td className="px-3 py-2 text-gray-300">{row.customer}</td>
                    <td className="px-3 py-2 text-gray-500 text-xs">#{row.line_number}</td>
                    <td className="px-3 py-2 font-mono text-gray-200 text-xs">{row.part_number}</td>
                    <td className="px-3 py-2 text-right font-mono text-gray-300">{Number(row.quantity_ordered).toLocaleString()}</td>
                    <td className="px-3 py-2 text-xs">
                      <FbStateBadge state={row.fb_state} soNumbers={row.so_numbers} completedAt={row.fb_completed_at} />
                      <div className="text-gray-500 mt-0.5">SO {row.so_numbers}</div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <div className="font-mono text-gray-300">{row.work_orders}</div>
                      {row.jobs_summary && (
                        <div className="text-gray-500 mt-0.5 max-w-[260px] whitespace-normal">{row.jobs_summary}</div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block px-1.5 py-0.5 text-[10px] rounded border whitespace-nowrap ${js.cls}`} title={js.title}>
                        {js.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {canAct && (busy ? (
                        <Loader2 size={16} className="animate-spin text-gray-400 inline" />
                      ) : (
                        <span className="inline-flex gap-1.5">
                          <button
                            onClick={() => act(row, 'keep_as_stock')}
                            className="px-2 py-1 text-xs rounded bg-purple-600 hover:bg-purple-500 text-white"
                            title="Close the line as shipped in Fishbowl; the work order keeps running as stock"
                          >
                            Keep as stock
                          </button>
                          <button
                            onClick={() => act(row, 'review_wo')}
                            className="px-2 py-1 text-xs rounded border border-gray-600 text-gray-300 hover:text-white hover:border-gray-400"
                            title="Close the line as shipped in Fishbowl and flag the work order for review in Order Lookup"
                          >
                            Review WO
                          </button>
                        </span>
                      ))}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
