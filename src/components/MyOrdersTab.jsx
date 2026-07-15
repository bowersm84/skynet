import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { Loader2, Search, AlertTriangle } from 'lucide-react'
import { loadMyOrderLines } from '../lib/myOrders'

// D-MYORD-01 — salesperson-scoped CO line view. One flat row per open CO line
// where customer_orders.salesperson_id = the logged-in user. Shows customer due
// vs scheduled finish with a LATE flag.
// D-MYORD-03 — 7 columns, nothing wraps; D-MYORD-04 — late is quantified.

// Customer due is a DATE (yyyy-mm-dd) — format at local noon to dodge the
// midnight-UTC off-by-one (see Decisions.md "Date/timezone — local-noon UTC").
const fmtDue = (d) =>
  d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

// Scheduled finish is a full timestamp — render date only (day granularity is
// what matters against a date-only customer due date).
const fmtFinishDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

// Priority dot shown only when priority != 'normal' (D-MYORD-03).
const PRIORITY_DOT = {
  critical: 'bg-red-500',
  high: 'bg-amber-400',
  low: 'bg-gray-500',
}

export default function MyOrdersTab({ profile, onNavigateToWO, onNavigateToCO = null }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('open') // 'open' | 'all'
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    if (!profile?.id) return
    setLoading(true)
    setError(null)
    try {
      const data = await loadMyOrderLines(supabase, profile.id)
      setRows(data || [])
    } catch (err) {
      console.error('Failed to load My Orders:', err)
      setError(err.message || String(err))
    } finally {
      setLoading(false)
    }
  }, [profile?.id])

  useEffect(() => { load() }, [load])

  const visibleRows = useMemo(() => {
    let list = rows
    if (filter === 'open') {
      list = list.filter(r => r.lineStatus !== 'complete')
    }
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter(r =>
        (r.coNumber || '').toLowerCase().includes(q) ||
        (r.partNumber || '').toLowerCase().includes(q) ||
        (r.customer || '').toLowerCase().includes(q)
      )
    }
    // Default sort: customer due date asc, nulls last.
    return list.slice().sort((a, b) => {
      const ad = a.dueDate || '9999-12-31'
      const bd = b.dueDate || '9999-12-31'
      if (ad !== bd) return ad < bd ? -1 : 1
      return (a.coNumber || '').localeCompare(b.coNumber || '')
    })
  }, [rows, filter, search])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        <Loader2 size={20} className="animate-spin mr-2" />
        Loading your orders...
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-3 rounded bg-red-900/40 text-red-300 border border-red-800 text-sm flex items-center gap-2">
        <AlertTriangle size={14} /> {error}
      </div>
    )
  }

  return (
    <div>
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[260px] max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search CO #, part #, customer..."
            className="w-full pl-9 pr-3 py-2 bg-gray-900 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-purple-500"
          />
        </div>
        <div className="flex gap-1">
          {['open', 'all'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs rounded transition-colors ${
                filter === f
                  ? 'bg-purple-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-white border border-gray-700'
              }`}
            >
              {f === 'open' ? 'Open' : 'All'}
            </button>
          ))}
        </div>
      </div>

      {visibleRows.length === 0 ? (
        <div className="text-center py-16 bg-gray-900 rounded-lg border border-gray-800 text-gray-500">
          {rows.length === 0
            ? 'No customer orders assigned to you.'
            : 'No matches.'}
        </div>
      ) : (
        <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-3 text-left">Order</th>
                <th className="px-4 py-3 text-left">Customer</th>
                <th className="px-4 py-3 text-left">Part #</th>
                <th className="px-4 py-3 text-left">Qty</th>
                <th className="px-4 py-3 text-left">Due</th>
                <th className="px-4 py-3 text-left">Scheduled Finish</th>
                <th className="px-4 py-3 text-left">WO / Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {visibleRows.map(r => {
                // D-MYORD-04: quantify the miss. Both operands already exist for
                // isLate; the delta is free. Badge only when late by ≥ 1 day.
                const dueEod = r.dueDate ? new Date(r.dueDate + 'T23:59:59') : null
                const daysLate = (r.isLate && dueEod)
                  ? Math.ceil((new Date(r.scheduledFinish) - dueEod) / 86400000)
                  : 0
                return (
                  <tr
                    key={r.lineId}
                    className={`text-sm hover:bg-gray-800/40 ${
                      r.isLate ? 'border-l-2 border-red-500' : 'border-l-2 border-transparent'
                    }`}
                  >
                    {/* 1. ORDER — CO# (with priority dot) over PO# */}
                    <td className="px-4 py-3">
                      <div className="font-mono text-purple-300 whitespace-nowrap truncate flex items-center">
                        {r.priority !== 'normal' && (
                          <span className={`inline-block w-2 h-2 rounded-full mr-2 ${PRIORITY_DOT[r.priority] || 'bg-gray-500'}`} />
                        )}
                        {onNavigateToCO && r.coId ? (
                          <button
                            type="button"
                            onClick={() => onNavigateToCO(r.coId, r.coNumber)}
                            title={`Open ${r.coNumber} on the Orders tab`}
                            className="font-mono whitespace-nowrap truncate text-blue-400 hover:underline cursor-pointer bg-transparent border-none p-0 text-left"
                          >
                            {r.coNumber || '—'}
                          </button>
                        ) : (
                          r.coNumber || '—'
                        )}
                      </div>
                      <div className="text-gray-500 text-xs whitespace-nowrap truncate">{r.poNumber || '—'}</div>
                    </td>

                    {/* 2. CUSTOMER — single line, ellipsis, full name on hover */}
                    <td
                      className="px-4 py-3 text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis max-w-[260px]"
                      title={r.customer || ''}
                    >
                      {r.customer || '—'}
                    </td>

                    {/* 3. PART # — number only */}
                    <td className="px-4 py-3 font-mono text-white whitespace-nowrap truncate">
                      {r.partNumber || '—'}
                    </td>

                    {/* 4. QTY */}
                    <td className="px-4 py-3 font-mono text-gray-300 whitespace-nowrap">
                      {r.qtyFulfilled}/{r.qtyOrdered}
                    </td>

                    {/* 5. DUE — date only */}
                    <td className="px-4 py-3 text-gray-300 whitespace-nowrap">
                      {fmtDue(r.dueDate)}
                    </td>

                    {/* 6. SCHEDULED FINISH — date only + late badge */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className={r.isLate ? 'text-red-400' : 'text-gray-300'}>
                        {fmtFinishDate(r.scheduledFinish)}
                      </div>
                      {r.isLate && daysLate >= 1 && (
                        <div>
                          <span className="inline-block bg-red-500/10 text-red-400 text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap">
                            {daysLate}d late
                          </span>
                        </div>
                      )}
                    </td>

                    {/* 7. WO / STATUS — WO list over the job status rollup */}
                    <td className="px-4 py-3">
                      {r.woNumbers.length === 0 ? (
                        <span className="text-gray-500 text-xs whitespace-nowrap">{r.jobStatusSummary}</span>
                      ) : (
                        <>
                          {r.woNumbers.map(wo => (
                            <div key={wo}>
                              <button
                                onClick={() => onNavigateToWO?.(wo)}
                                className="font-mono text-xs text-blue-400 hover:underline whitespace-nowrap truncate"
                              >
                                {wo}
                              </button>
                            </div>
                          ))}
                          <div className="text-gray-400 text-xs whitespace-nowrap">{r.jobStatusSummary}</div>
                        </>
                      )}
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
