import { useState, useEffect, useMemo, useCallback } from 'react'
import { Search, Loader2, Ban, ExternalLink } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { getStockRequests, cancelStockRequest, STOCK_REQUEST_STATUS_LABELS, STOCK_REQUEST_STATUS_COLORS } from '../../lib/customerOrders'
import { hasRole } from '../../lib/roles'
import { formatDate, PRIORITY_BADGE } from './format'

// ─────────────────────────────────────────────────────────────────────────────
// Stock Requests view (D-STKREQ-01): the warehouse's own demand queue. Every
// role on this page can read it; only admin/assembly raise one, and only admin
// or the original requester can cancel while it is still open.
// S17 B2 (D-ASM-33): moved from Customer Orders to the Order Queue's Stock requests tab; onLoaded (optional,
// stable) gets every load's rows so the tab label can count the open ones.

const STOCK_REQUEST_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'allocated', label: 'Allocated' },
  { value: 'complete', label: 'Complete' },
  { value: 'cancelled', label: 'Cancelled' },
]

export default function StockRequestsView({ profile, setActionStatus, refreshKey, onNavigateToWO, onLoaded = null }) {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('open')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getStockRequests(supabase)
      setRequests(data)
      onLoaded?.(data)
    } catch (err) {
      setActionStatus({ type: 'error', message: `Failed to load stock requests: ${err.message}` })
    } finally {
      setLoading(false)
    }
  }, [setActionStatus, onLoaded])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return requests.filter(r => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false
      if (!q) return true
      return (
        (r.part?.part_number || '').toLowerCase().includes(q) ||
        (r.part?.description || '').toLowerCase().includes(q) ||
        (r.requester?.full_name || '').toLowerCase().includes(q) ||
        (r.reason || '').toLowerCase().includes(q)
      )
    })
  }, [requests, statusFilter, search])

  const handleCancel = async (req) => {
    const reason = window.prompt('Reason for cancelling (optional):')
    if (reason === null) return
    try {
      await cancelStockRequest(supabase, req.id, reason)
      setActionStatus({ type: 'success', message: 'Stock request cancelled.' })
      await load()
    } catch (err) {
      setActionStatus({ type: 'error', message: `Cancel stock request failed: ${err.message}` })
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        <Loader2 size={20} className="animate-spin mr-2" />
        Loading stock requests...
      </div>
    )
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[260px] max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search part #, description, requester, reason..."
            className="w-full pl-9 pr-3 py-2 bg-gray-900 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-purple-500"
          />
        </div>
        <div className="flex gap-1 flex-wrap">
          {STOCK_REQUEST_FILTERS.map(f => (
            <button
              key={f.value}
              onClick={() => setStatusFilter(f.value)}
              className={`px-3 py-1.5 text-xs rounded transition-colors ${
                statusFilter === f.value
                  ? 'bg-purple-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-white border border-gray-700'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {requests.length === 0 ? (
        <div className="text-center py-16 bg-gray-900 rounded-lg border border-gray-800 text-gray-400">
          No stock requests yet.
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 bg-gray-900 rounded-lg border border-gray-800 text-gray-500">
          No matches.
        </div>
      ) : (
        <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-3 text-left">Part #</th>
                <th className="px-4 py-3 text-left">Description</th>
                <th className="px-4 py-3 text-right">Qty</th>
                <th className="px-4 py-3 text-left">Priority</th>
                <th className="px-4 py-3 text-left">Reason</th>
                <th className="px-4 py-3 text-left">Requested</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">WO</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                const statusClass = STOCK_REQUEST_STATUS_COLORS[r.status] || 'bg-gray-700 text-gray-300'
                const statusLabel = STOCK_REQUEST_STATUS_LABELS[r.status] || r.status
                const priorityClass = PRIORITY_BADGE[r.priority] || PRIORITY_BADGE.normal
                const canCancel =
                  r.status === 'open' &&
                  (hasRole(profile, 'admin') || r.requested_by === profile?.id)
                return (
                  <tr key={r.id} className="border-t border-gray-800 align-top">
                    <td className="px-4 py-3 text-purple-300 font-mono text-sm whitespace-nowrap">
                      {r.part?.part_number || '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-300 text-sm">
                      {r.part?.description || <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-amber-300 font-mono text-sm whitespace-nowrap">
                      {(r.quantity_requested || 0).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`px-1.5 py-0.5 text-[10px] rounded capitalize ${priorityClass}`}>
                        {r.priority}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-300 text-sm max-w-md whitespace-normal">
                      {r.reason}
                      {r.status === 'cancelled' && r.cancel_reason && (
                        <div className="text-xs text-red-300/80 mt-0.5">
                          Cancelled: {r.cancel_reason}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-300 text-sm whitespace-nowrap">
                      {r.created_at ? formatDate(String(r.created_at).slice(0, 10)) : '—'}
                      <div className="text-xs text-gray-500">
                        {r.requester?.full_name || 'Unknown'}
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`px-2 py-0.5 text-xs rounded ${statusClass}`}>{statusLabel}</span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {r.work_order?.wo_number ? (
                        <button
                          onClick={() => onNavigateToWO(r.work_order.wo_number)}
                          className="font-mono text-sm text-skynet-accent hover:text-blue-300 inline-flex items-center gap-1"
                        >
                          {r.work_order.wo_number}
                          <ExternalLink size={12} className="text-gray-500" />
                        </button>
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {canCancel && (
                        <button
                          onClick={() => handleCancel(r)}
                          className="px-2 py-1 text-xs text-red-400 hover:bg-red-900/30 rounded inline-flex items-center gap-1"
                          title="Cancel stock request"
                        >
                          <Ban size={12} /> Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
