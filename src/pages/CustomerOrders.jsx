import { useState, useEffect, useMemo, useCallback, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import {
  Plus,
  Search,
  ChevronRight,
  Loader2,
  X,
  Check,
  Ban,
  AlertTriangle,
  ExternalLink,
} from 'lucide-react'
import CreateCustomerOrderModal from '../components/CreateCustomerOrderModal'
import CreateWorkOrderModal from '../components/CreateWorkOrderModal'
import {
  CO_STATUS_LABELS,
  CO_STATUS_COLORS,
  getAllOpenCOLines,
  getAllocationsForLine,
} from '../lib/customerOrders'

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'not_started', label: 'Not Started' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'complete', label: 'Complete' },
  { value: 'cancelled', label: 'Cancelled' },
]

const CAN_EDIT_ROLES = ['admin', 'scheduler', 'customer_service']

export default function CustomerOrders({ profile, onNavigate, embedded = false, onNavigateToWO = null }) {
  const canEdit = CAN_EDIT_ROLES.includes(profile?.role)

  const [coTab, setCoTab] = useState('orders') // 'orders' | 'demand'
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [expanded, setExpanded] = useState(() => new Set())
  const [actionStatus, setActionStatus] = useState(null)

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [confirmAction, setConfirmAction] = useState(null) // { type, ...payload }

  // CO-line allocation drilldown state. Only one panel open at a time.
  const [expandedAllocLineId, setExpandedAllocLineId] = useState(null)
  const [allocCache, setAllocCache] = useState({})       // { [lineId]: [allocations] }
  const [allocLoading, setAllocLoading] = useState({})   // { [lineId]: bool }

  const handleNavigateToWO = useCallback((woNumber) => {
    if (onNavigateToWO) {
      onNavigateToWO(woNumber)
    } else if (onNavigate) {
      onNavigate('mainframe', { woLookupSearch: woNumber, orderLookupTab: 'work_orders' })
    }
  }, [onNavigateToWO, onNavigate])

  const toggleLineAllocations = useCallback(async (line) => {
    if (expandedAllocLineId === line.id) {
      setExpandedAllocLineId(null)
      return
    }
    setExpandedAllocLineId(line.id)
    // Skip the fetch if there's nothing allocated yet.
    const allocatedQty = (line.quantity_ordered ?? 0) - (line.remaining ?? 0) - (line.quantity_fulfilled ?? 0)
    if (allocatedQty <= 0) return
    if (allocCache[line.id]) return
    setAllocLoading(prev => ({ ...prev, [line.id]: true }))
    try {
      const allocs = await getAllocationsForLine(supabase, line.id)
      setAllocCache(prev => ({ ...prev, [line.id]: allocs }))
    } catch (err) {
      console.error('Failed to load allocations:', err)
    } finally {
      setAllocLoading(prev => ({ ...prev, [line.id]: false }))
    }
  }, [expandedAllocLineId, allocCache])

  const loadOrders = useCallback(async () => {
    setLoading(true)
    try {
      // 1. Headers + customer name (1 nest level)
      const { data: cos, error: cosErr } = await supabase
        .from('customer_orders')
        .select(`
          id, co_number, fishbowl_order_id, po_number, notes, status,
          cancelled_at, cancel_reason, created_at,
          customer_id,
          customers ( id, customer_id, name )
        `)
        .order('created_at', { ascending: false })
      if (cosErr) throw cosErr

      const coIds = (cos || []).map(c => c.id)
      if (coIds.length === 0) {
        setOrders([])
        return
      }

      // 2. Lines, with their part info (1 nest level)
      const { data: linesRaw, error: linesErr } = await supabase
        .from('customer_order_lines')
        .select(`
          id, customer_order_id, line_number, quantity_ordered, quantity_fulfilled,
          due_date, priority, status, notes, cancel_reason, fulfilled_at,
          part_id,
          parts ( id, part_number, description )
        `)
        .in('customer_order_id', coIds)
        .order('line_number', { ascending: true })
      if (linesErr) throw linesErr

      // 3. Allocation totals per line (active only)
      const lineIds = (linesRaw || []).map(l => l.id)
      let allocByLine = new Map()
      if (lineIds.length > 0) {
        const { data: allocs, error: aerr } = await supabase
          .from('customer_order_allocations')
          .select('customer_order_line_id, quantity_allocated')
          .in('customer_order_line_id', lineIds)
          .eq('is_active', true)
        if (aerr) throw aerr
        for (const a of allocs || []) {
          allocByLine.set(
            a.customer_order_line_id,
            (allocByLine.get(a.customer_order_line_id) || 0) + (Number(a.quantity_allocated) || 0),
          )
        }
      }

      // Merge: attach lines (with allocated/remaining) onto each CO
      const linesByCO = new Map()
      for (const l of linesRaw || []) {
        const allocated = allocByLine.get(l.id) || 0
        const ordered = Number(l.quantity_ordered) || 0
        const fulfilled = Number(l.quantity_fulfilled) || 0
        const enriched = {
          ...l,
          allocated,
          remaining: Math.max(0, ordered - fulfilled - allocated),
        }
        const arr = linesByCO.get(l.customer_order_id) || []
        arr.push(enriched)
        linesByCO.set(l.customer_order_id, arr)
      }

      const merged = (cos || []).map(co => {
        const lines = linesByCO.get(co.id) || []
        const dueDates = lines.map(l => l.due_date).filter(Boolean).sort()
        return {
          ...co,
          lines,
          line_count: lines.length,
          earliest_due: dueDates[0] || null,
        }
      })

      setOrders(merged)
    } catch (err) {
      setActionStatus({ type: 'error', message: `Failed to load: ${err.message}` })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadOrders()
  }, [loadOrders])

  const filteredOrders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return orders.filter(co => {
      if (statusFilter !== 'all' && co.status !== statusFilter) return false
      if (!q) return true
      if ((co.co_number || '').toLowerCase().includes(q)) return true
      if ((co.customers?.name || '').toLowerCase().includes(q)) return true
      if ((co.po_number || '').toLowerCase().includes(q)) return true
      if ((co.fishbowl_order_id || '').toLowerCase().includes(q)) return true
      if (co.lines.some(l => (l.parts?.part_number || '').toLowerCase().includes(q))) return true
      return false
    })
  }, [orders, statusFilter, searchQuery])

  const toggleExpand = (coId) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(coId)) next.delete(coId)
      else next.add(coId)
      return next
    })
  }

  // ─── Action: mark line complete ──────────────────────────────────────────
  const markLineComplete = async ({ lineId, lineNumber, qty }) => {
    const { error } = await supabase
      .from('customer_order_lines')
      .update({
        quantity_fulfilled: qty,
        fulfilled_at: new Date().toISOString(),
        fulfilled_by: profile?.id || null,
        status: 'complete',
      })
      .eq('id', lineId)
    if (error) {
      setActionStatus({ type: 'error', message: `Mark complete failed: ${error.message}` })
      return
    }
    setActionStatus({ type: 'success', message: `Line ${lineNumber} marked complete.` })
    await loadOrders()
  }

  // ─── Action: cancel line (sequenced trigger-aware writes) ────────────────
  // Steps must run in this order to keep status triggers correct:
  //   1. Flip line.status = cancelled
  //   2. Read distinct active WO IDs for that line
  //   3. Deactivate the allocations
  //   4. Mark those WOs has_cancelled_allocation = true
  const cancelLine = async ({ lineId, reason }) => {
    const now = new Date().toISOString()
    // 1
    const { error: lineErr } = await supabase
      .from('customer_order_lines')
      .update({
        status: 'cancelled',
        cancelled_at: now,
        cancelled_by: profile?.id || null,
        cancel_reason: reason,
      })
      .eq('id', lineId)
    if (lineErr) throw lineErr

    // 2
    const { data: activeAllocs, error: allocReadErr } = await supabase
      .from('customer_order_allocations')
      .select('work_order_id')
      .eq('customer_order_line_id', lineId)
      .eq('is_active', true)
    if (allocReadErr) throw allocReadErr
    const woIds = Array.from(new Set((activeAllocs || []).map(a => a.work_order_id))).filter(Boolean)

    // 3
    const { error: deactivateErr } = await supabase
      .from('customer_order_allocations')
      .update({
        is_active: false,
        deactivated_at: now,
        deactivated_by: profile?.id || null,
      })
      .eq('customer_order_line_id', lineId)
      .eq('is_active', true)
    if (deactivateErr) throw deactivateErr

    // 4
    if (woIds.length > 0) {
      const { error: woErr } = await supabase
        .from('work_orders')
        .update({ has_cancelled_allocation: true })
        .in('id', woIds)
      if (woErr) throw woErr
    }
  }

  const handleCancelLine = async ({ lineId, lineNumber, reason }) => {
    try {
      await cancelLine({ lineId, reason })
      setActionStatus({ type: 'success', message: `Line ${lineNumber} cancelled.` })
      await loadOrders()
    } catch (err) {
      setActionStatus({ type: 'error', message: `Cancel line failed: ${err.message}` })
    }
  }

  // ─── Action: cancel whole CO ─────────────────────────────────────────────
  const handleCancelCO = async ({ coId, reason, linesToCancel }) => {
    try {
      // 1. Cancel each non-complete, non-cancelled line via the same sequenced flow
      for (const l of linesToCancel) {
        await cancelLine({ lineId: l.id, reason })
      }

      // 2 + 3. Stamp the CO with the cancellation metadata. If every line is now
      // cancelled the trigger would have rolled the CO into 'cancelled' on its own;
      // setting status here is only meaningful when no complete lines exist.
      // Always record cancel_reason / cancelled_by for the audit trail.
      const co = orders.find(c => c.id === coId)
      const hasCompleteLine = (co?.lines || []).some(l => l.status === 'complete')

      const stamp = {
        cancelled_at: new Date().toISOString(),
        cancelled_by: profile?.id || null,
        cancel_reason: reason,
      }
      if (!hasCompleteLine) stamp.status = 'cancelled'

      const { error: coErr } = await supabase
        .from('customer_orders')
        .update(stamp)
        .eq('id', coId)
      if (coErr) throw coErr

      setActionStatus({ type: 'success', message: 'Customer order cancelled.' })
      await loadOrders()
    } catch (err) {
      setActionStatus({ type: 'error', message: `Cancel CO failed: ${err.message}` })
    }
  }

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Customer Orders</h2>
          <p className="text-gray-500 text-sm mt-1">
            Demand pool — Fishbowl-sourced orders awaiting allocation to work orders
          </p>
        </div>
        {canEdit && !embedded && coTab === 'orders' && (
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded transition-colors"
          >
            <Plus size={16} /> New Customer Order
          </button>
        )}
      </div>

      {actionStatus && (
        <div className={`mb-4 p-3 rounded text-sm flex justify-between items-center ${
          actionStatus.type === 'success'
            ? 'bg-green-900/40 text-green-300 border border-green-800'
            : 'bg-red-900/40 text-red-300 border border-red-800'
        }`}>
          <span>{actionStatus.message}</span>
          <button onClick={() => setActionStatus(null)}><X size={14} /></button>
        </div>
      )}

      {/* Tab strip */}
      <div className="flex items-center gap-1 border-b border-gray-800 mb-4">
        <button
          onClick={() => setCoTab('orders')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            coTab === 'orders'
              ? 'border-purple-400 text-purple-300'
              : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          Orders
        </button>
        <button
          onClick={() => setCoTab('demand')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            coTab === 'demand'
              ? 'border-purple-400 text-purple-300'
              : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          Demand
        </button>
      </div>

      {coTab === 'demand' ? (
        <DemandView profile={profile} setActionStatus={setActionStatus} />
      ) : (
      <>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[260px] max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search CO #, customer, PO #, Fishbowl ID, part #..."
            className="w-full pl-9 pr-3 py-2 bg-gray-900 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-purple-500"
          />
        </div>
        <div className="flex gap-1 flex-wrap">
          {STATUS_FILTERS.map(f => (
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

      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-500">
          <Loader2 size={20} className="animate-spin mr-2" />
          Loading customer orders...
        </div>
      ) : filteredOrders.length === 0 && orders.length === 0 ? (
        <div className="text-center py-16 bg-gray-900 rounded-lg border border-gray-800">
          <p className="text-gray-400 mb-4">No customer orders yet.</p>
          {canEdit && !embedded && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded transition-colors"
            >
              <Plus size={16} /> New Customer Order
            </button>
          )}
        </div>
      ) : filteredOrders.length === 0 ? (
        <div className="text-center py-12 bg-gray-900 rounded-lg border border-gray-800 text-gray-500">
          No matches.
        </div>
      ) : (
        <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
              <tr>
                <th className="w-8 px-2 py-3"></th>
                <th className="px-4 py-3 text-left">CO #</th>
                <th className="px-4 py-3 text-left">Customer</th>
                <th className="px-4 py-3 text-left">PO #</th>
                <th className="px-4 py-3 text-left">Lines</th>
                <th className="px-4 py-3 text-left">Earliest Due</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Created</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.map(co => {
                const isExpanded = expanded.has(co.id)
                const cancellableLines = (co.lines || []).filter(
                  l => l.status !== 'complete' && l.status !== 'cancelled'
                )
                const canCancelCO = canEdit && co.status !== 'cancelled' && cancellableLines.length > 0

                return (
                  <CORow
                    key={co.id}
                    co={co}
                    expanded={isExpanded}
                    onToggle={() => toggleExpand(co.id)}
                    canEdit={canEdit}
                    canCancelCO={canCancelCO}
                    onCancelCOClick={() =>
                      setConfirmAction({
                        type: 'cancel_co',
                        coId: co.id,
                        coNumber: co.co_number,
                        linesToCancel: cancellableLines,
                      })
                    }
                    onMarkLineCompleteClick={(line) =>
                      setConfirmAction({
                        type: 'complete_line',
                        lineId: line.id,
                        lineNumber: line.line_number,
                        qty: line.quantity_ordered,
                      })
                    }
                    onCancelLineClick={(line) =>
                      setConfirmAction({
                        type: 'cancel_line',
                        lineId: line.id,
                        lineNumber: line.line_number,
                      })
                    }
                    expandedAllocLineId={expandedAllocLineId}
                    allocCache={allocCache}
                    allocLoading={allocLoading}
                    onToggleLineAllocations={toggleLineAllocations}
                    onNavigateToWO={handleNavigateToWO}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      </>
      )}

      {showCreateModal && (
        <CreateCustomerOrderModal
          isOpen={showCreateModal}
          profile={profile}
          onClose={() => setShowCreateModal(false)}
          onSuccess={() => {
            setActionStatus({ type: 'success', message: 'Customer order created.' })
            loadOrders()
          }}
        />
      )}

      {confirmAction?.type === 'complete_line' && (
        <ConfirmModal
          title="Mark Line Complete"
          confirmLabel="Mark Complete"
          confirmClass="bg-green-600 hover:bg-green-500"
          message={
            <>
              Mark line {confirmAction.lineNumber} as complete? This sets fulfilled qty ={' '}
              <span className="font-mono">{confirmAction.qty}</span> and the line cannot be edited after.
            </>
          }
          onCancel={() => setConfirmAction(null)}
          onConfirm={async () => {
            await markLineComplete({
              lineId: confirmAction.lineId,
              lineNumber: confirmAction.lineNumber,
              qty: confirmAction.qty,
            })
            setConfirmAction(null)
          }}
        />
      )}

      {confirmAction?.type === 'cancel_line' && (
        <ConfirmModal
          title="Cancel Line"
          confirmLabel="Cancel Line"
          confirmClass="bg-red-600 hover:bg-red-500"
          requireReason
          message={`Cancel line ${confirmAction.lineNumber}? Active allocations on this line will be deactivated and any affected work orders will be flagged.`}
          onCancel={() => setConfirmAction(null)}
          onConfirm={async (reason) => {
            await handleCancelLine({
              lineId: confirmAction.lineId,
              lineNumber: confirmAction.lineNumber,
              reason,
            })
            setConfirmAction(null)
          }}
        />
      )}

      {confirmAction?.type === 'cancel_co' && (
        <ConfirmModal
          title={`Cancel Customer Order ${confirmAction.coNumber}`}
          confirmLabel="Cancel Order"
          confirmClass="bg-red-600 hover:bg-red-500"
          requireReason
          message={
            <>
              The following lines will be cancelled (complete lines stay complete):
              <ul className="list-disc pl-5 mt-2 text-sm space-y-0.5">
                {confirmAction.linesToCancel.map(l => (
                  <li key={l.id}>
                    Line {l.line_number} —{' '}
                    <span className="font-mono">{l.parts?.part_number || '?'}</span>
                  </li>
                ))}
              </ul>
            </>
          }
          onCancel={() => setConfirmAction(null)}
          onConfirm={async (reason) => {
            await handleCancelCO({
              coId: confirmAction.coId,
              reason,
              linesToCancel: confirmAction.linesToCancel,
            })
            setConfirmAction(null)
          }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function CORow({
  co,
  expanded,
  onToggle,
  canEdit,
  canCancelCO,
  onCancelCOClick,
  onMarkLineCompleteClick,
  onCancelLineClick,
  expandedAllocLineId,
  allocCache,
  allocLoading,
  onToggleLineAllocations,
  onNavigateToWO,
}) {
  const statusClass = CO_STATUS_COLORS[co.status] || 'bg-gray-700 text-gray-300'
  const statusLabel = CO_STATUS_LABELS[co.status] || co.status

  return (
    <>
      <tr
        onClick={onToggle}
        className="border-t border-gray-800 hover:bg-gray-800/40 cursor-pointer"
      >
        <td className="px-2 py-3 text-center">
          <ChevronRight
            size={14}
            className={`text-gray-500 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </td>
        <td className="px-4 py-3 text-purple-300 font-mono text-sm">{co.co_number}</td>
        <td className="px-4 py-3 text-gray-200 text-sm">
          {co.customers?.name || <span className="text-gray-600">—</span>}
          {co.customers?.customer_id && (
            <span className="text-gray-600 ml-1 font-mono text-xs">
              ({co.customers.customer_id})
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-gray-300 text-sm">
          {co.po_number || <span className="text-gray-600">—</span>}
        </td>
        <td className="px-4 py-3 text-gray-300 text-sm">{co.line_count}</td>
        <td className="px-4 py-3 text-gray-300 text-sm">
          {co.earliest_due ? formatDate(co.earliest_due) : <span className="text-gray-600">—</span>}
        </td>
        <td className="px-4 py-3">
          <span className={`px-2 py-0.5 text-xs rounded ${statusClass}`}>{statusLabel}</span>
        </td>
        <td className="px-4 py-3 text-gray-500 text-xs">
          {co.created_at ? new Date(co.created_at).toLocaleDateString() : '—'}
        </td>
        <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
          {canCancelCO && (
            <button
              onClick={onCancelCOClick}
              className="px-2 py-1 text-xs text-red-400 hover:bg-red-900/30 rounded inline-flex items-center gap-1"
              title="Cancel customer order"
            >
              <Ban size={12} /> Cancel CO
            </button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-gray-950 border-t border-gray-800">
          <td colSpan={9} className="p-0">
            <div className="px-6 py-4">
              {co.cancel_reason && co.status === 'cancelled' && (
                <div className="mb-3 p-2 rounded bg-red-900/30 border border-red-800/60 text-red-200 text-xs flex items-start gap-2">
                  <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                  <div>
                    <span className="font-semibold">Cancelled.</span>{' '}
                    Reason: {co.cancel_reason}
                  </div>
                </div>
              )}
              {co.notes && (
                <div className="mb-3 text-xs text-gray-400">
                  <span className="text-gray-500">Notes: </span>{co.notes}
                </div>
              )}
              {co.lines.length === 0 ? (
                <div className="text-gray-500 text-sm py-4">No lines.</div>
              ) : (
                <table className="w-full text-sm table-auto">
                  <thead className="text-gray-500 text-[10px] uppercase">
                    <tr>
                      <th className="px-2 py-2 text-left">Line</th>
                      <th className="px-2 py-2 text-left">Part</th>
                      <th className="px-2 py-2 text-right">Ordered</th>
                      <th className="px-2 py-2 text-right">Allocated</th>
                      <th className="px-2 py-2 text-right">Fulfilled</th>
                      <th className="px-2 py-2 text-right">Remaining</th>
                      <th className="px-2 py-2 text-left">Due</th>
                      <th className="px-2 py-2 text-left">Priority</th>
                      <th className="px-2 py-2 text-left">Status</th>
                      <th className="px-2 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {co.lines.map(l => {
                      const lineStatusClass = CO_STATUS_COLORS[l.status] || 'bg-gray-700 text-gray-300'
                      const lineStatusLabel = CO_STATUS_LABELS[l.status] || l.status
                      const canAct = canEdit && l.status !== 'complete' && l.status !== 'cancelled'
                      const allocatedQty = (l.quantity_ordered || 0) - (l.remaining || 0) - (l.quantity_fulfilled || 0)
                      const hasAllocations = allocatedQty > 0
                      const isAllocExpanded = expandedAllocLineId === l.id
                      return (
                        <Fragment key={l.id}>
                          <tr className="border-t border-gray-800">
                            <td className="px-2 py-2 text-gray-400 font-mono text-xs whitespace-nowrap">#{l.line_number}</td>
                            <td className="px-2 py-2 text-xs whitespace-nowrap" title={l.parts?.description || ''}>
                              {hasAllocations ? (
                                <button
                                  onClick={() => onToggleLineAllocations({
                                    id: l.id,
                                    quantity_ordered: l.quantity_ordered,
                                    quantity_fulfilled: l.quantity_fulfilled,
                                    remaining: l.remaining,
                                  })}
                                  className="font-mono text-purple-300 hover:text-purple-200 underline decoration-dotted underline-offset-2 inline-flex items-center gap-1"
                                >
                                  {l.parts?.part_number || '—'}
                                  <ChevronRight
                                    size={12}
                                    className={`transition-transform ${isAllocExpanded ? 'rotate-90' : ''}`}
                                  />
                                </button>
                              ) : (
                                <span className="font-mono text-gray-300">{l.parts?.part_number || '—'}</span>
                              )}
                            </td>
                            <td className="px-2 py-2 text-right text-gray-200 font-mono text-xs whitespace-nowrap">
                              {l.quantity_ordered}
                            </td>
                            <td className="px-2 py-2 text-right text-gray-300 font-mono text-xs whitespace-nowrap">
                              {l.allocated}
                            </td>
                            <td className="px-2 py-2 text-right text-gray-300 font-mono text-xs whitespace-nowrap">
                              {l.quantity_fulfilled}
                            </td>
                            <td className="px-2 py-2 text-right font-mono text-xs whitespace-nowrap">
                              <span className={l.remaining > 0 ? 'text-amber-300' : 'text-gray-500'}>
                                {l.remaining}
                              </span>
                            </td>
                            <td className="px-2 py-2 text-gray-300 text-xs whitespace-nowrap">
                              {l.due_date ? formatDateShort(l.due_date) : '—'}
                            </td>
                            <td className="px-2 py-2 text-gray-400 text-xs capitalize whitespace-nowrap">{l.priority}</td>
                            <td className="px-2 py-2 whitespace-nowrap">
                              <span className={`px-1.5 py-0.5 text-[10px] rounded ${lineStatusClass}`}>
                                {lineStatusLabel}
                              </span>
                            </td>
                            <td className="px-2 py-2 text-right whitespace-nowrap">
                              {canAct && (
                                <div className="flex justify-end gap-1">
                                  <button
                                    onClick={() => onMarkLineCompleteClick(l)}
                                    className="p-1 text-green-400 hover:bg-green-900/30 rounded"
                                    title="Mark complete"
                                  >
                                    <Check size={14} />
                                  </button>
                                  <button
                                    onClick={() => onCancelLineClick(l)}
                                    className="p-1 text-red-400 hover:bg-red-900/30 rounded"
                                    title="Cancel line"
                                  >
                                    <Ban size={14} />
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                          {isAllocExpanded && (
                            <tr className="bg-gray-900/60">
                              <td colSpan={10} className="px-6 py-3">
                                {allocLoading[l.id] ? (
                                  <div className="text-xs text-gray-500 flex items-center gap-2">
                                    <Loader2 size={12} className="animate-spin" /> Loading allocations…
                                  </div>
                                ) : (allocCache[l.id]?.length > 0 ? (
                                  <div className="space-y-1.5">
                                    <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
                                      Allocated to {allocCache[l.id].length} work order{allocCache[l.id].length === 1 ? '' : 's'}
                                    </div>
                                    {allocCache[l.id].map(alloc => {
                                      const wo = alloc.work_order
                                      const isCancelled = wo?.status === 'cancelled'
                                      return (
                                        <button
                                          key={alloc.id}
                                          onClick={() => wo?.wo_number && onNavigateToWO(wo.wo_number)}
                                          className={`w-full flex items-center gap-3 text-sm bg-gray-800/60 hover:bg-gray-800 rounded px-3 py-2 text-left transition-colors ${isCancelled ? 'line-through opacity-60' : ''}`}
                                        >
                                          <span className="font-mono text-skynet-accent">{wo?.wo_number || '—'}</span>
                                          <span className="text-gray-400 text-xs uppercase tracking-wide">{(wo?.status || '').replace(/_/g, ' ')}</span>
                                          {wo?.due_date && (
                                            <span className="text-gray-500 text-xs">due {formatDateShort(wo.due_date)}</span>
                                          )}
                                          <span className="ml-auto text-gray-300 font-mono">{(alloc.quantity_allocated || 0).toLocaleString()} pcs</span>
                                          <ExternalLink size={12} className="text-gray-500" />
                                        </button>
                                      )
                                    })}
                                  </div>
                                ) : (
                                  <div className="text-xs text-gray-500">No active allocations.</div>
                                ))}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function ConfirmModal({
  title,
  message,
  confirmLabel,
  confirmClass = 'bg-skynet-accent hover:bg-blue-500',
  requireReason = false,
  onCancel,
  onConfirm,
}) {
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const handleConfirm = async () => {
    if (requireReason && !reason.trim()) {
      setError('Reason is required.')
      return
    }
    setSubmitting(true)
    try {
      await onConfirm(reason.trim())
    } catch (err) {
      setError(err?.message || String(err))
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-md">
        <div className="flex justify-between items-center p-5 border-b border-gray-800">
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <button onClick={onCancel} className="text-gray-500 hover:text-white">
            <X size={18} />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="text-gray-300 text-sm">{message}</div>
          {requireReason && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">Reason *</label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                autoFocus
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-skynet-accent"
                placeholder="Why is this being cancelled?"
              />
            </div>
          )}
          {error && (
            <div className="p-2 rounded bg-red-900/40 text-red-300 border border-red-800 text-sm">
              {error}
            </div>
          )}
        </div>
        <div className="px-5 py-4 border-t border-gray-800 flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-2 text-gray-400 hover:text-white">
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={submitting}
            className={`px-4 py-2 ${confirmClass} text-white rounded disabled:opacity-50 flex items-center gap-2`}
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function formatDate(dateStr) {
  if (!dateStr) return '—'
  // dateStr is a YYYY-MM-DD from the DB; render in local TZ without
  // re-parsing through midnight UTC (Decisions.md "Date/timezone — local-noon UTC").
  const [y, m, d] = dateStr.split('-')
  if (!y || !m || !d) return dateStr
  const dt = new Date(Number(y), Number(m) - 1, Number(d), 12)
  return dt.toLocaleDateString()
}

// Compact M/D/YY for tight columns inside the expanded line sub-table.
function formatDateShort(dateStr) {
  if (!dateStr) return '—'
  const [y, m, d] = dateStr.split('-')
  if (!y || !m || !d) return dateStr
  return `${Number(m)}/${Number(d)}/${String(y).slice(-2)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Demand view: aggregate open CO line demand by part_number so April can roll
// matching lines into a single WO. Selection is locked to one part at a time.

const PRIORITY_BADGE = {
  critical: 'bg-red-900/50 text-red-300 border border-red-700/50',
  high: 'bg-amber-900/50 text-amber-300 border border-amber-700/50',
  normal: 'bg-gray-700 text-gray-300 border border-gray-600',
  low: 'bg-gray-800 text-gray-500 border border-gray-700',
}

function DemandView({ profile, setActionStatus }) {
  const [lines, setLines] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState('demand') // 'demand' | 'due'
  const [expandedParts, setExpandedParts] = useState(() => new Set())
  const [selectedPartId, setSelectedPartId] = useState(null)
  const [selectedLineIds, setSelectedLineIds] = useState(() => new Set())
  const [crossPartWarning, setCrossPartWarning] = useState(null) // partId being warned about
  const [showCreateWO, setShowCreateWO] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getAllOpenCOLines(supabase)
      setLines(data)
    } catch (err) {
      setActionStatus({ type: 'error', message: `Failed to load demand: ${err.message}` })
    } finally {
      setLoading(false)
    }
  }, [setActionStatus])

  useEffect(() => {
    load()
  }, [load])

  const clearSelection = () => {
    setSelectedPartId(null)
    setSelectedLineIds(new Set())
    setCrossPartWarning(null)
  }

  // Group filtered lines by part_id
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = q
      ? lines.filter(l =>
          (l.part_number || '').toLowerCase().includes(q) ||
          (l.part_description || '').toLowerCase().includes(q) ||
          (l.customer_name || '').toLowerCase().includes(q) ||
          (l.co_number || '').toLowerCase().includes(q)
        )
      : lines

    const byPart = new Map()
    for (const line of filtered) {
      const arr = byPart.get(line.part_id) || []
      arr.push(line)
      byPart.set(line.part_id, arr)
    }

    const result = Array.from(byPart.entries()).map(([partId, partLines]) => {
      const totalDemand = partLines.reduce((s, l) => s + l.remaining, 0)
      const dueDates = partLines.map(l => l.due_date).filter(Boolean).sort()
      return {
        part_id: partId,
        part_number: partLines[0].part_number,
        part_description: partLines[0].part_description,
        lines: partLines,
        total_demand: totalDemand,
        line_count: partLines.length,
        earliest_due: dueDates[0] || null,
      }
    })

    if (sortMode === 'due') {
      result.sort((a, b) => {
        if (a.earliest_due && b.earliest_due) {
          if (a.earliest_due !== b.earliest_due) return a.earliest_due < b.earliest_due ? -1 : 1
        } else if (a.earliest_due && !b.earliest_due) {
          return -1
        } else if (!a.earliest_due && b.earliest_due) {
          return 1
        }
        return b.total_demand - a.total_demand
      })
    } else {
      result.sort((a, b) => b.total_demand - a.total_demand)
    }
    return result
  }, [lines, search, sortMode])

  const toggleExpand = (partId) => {
    setExpandedParts(prev => {
      const next = new Set(prev)
      if (next.has(partId)) next.delete(partId)
      else next.add(partId)
      return next
    })
  }

  const tryToggleLine = (line, checked) => {
    if (checked) {
      if (selectedPartId && selectedPartId !== line.part_id) {
        setCrossPartWarning(line.part_id)
        setTimeout(() => setCrossPartWarning(null), 3000)
        return
      }
      setSelectedPartId(line.part_id)
      setSelectedLineIds(prev => {
        const next = new Set(prev)
        next.add(line.line_id)
        return next
      })
      setCrossPartWarning(null)
    } else {
      setSelectedLineIds(prev => {
        const next = new Set(prev)
        next.delete(line.line_id)
        if (next.size === 0) {
          setSelectedPartId(null)
        }
        return next
      })
    }
  }

  const tryToggleGroup = (group) => {
    const allLineIds = group.lines.map(l => l.line_id)
    const allSelected = allLineIds.every(id => selectedLineIds.has(id))

    if (allSelected) {
      // Deselect all in group
      setSelectedLineIds(prev => {
        const next = new Set(prev)
        for (const id of allLineIds) next.delete(id)
        if (next.size === 0) setSelectedPartId(null)
        return next
      })
    } else {
      if (selectedPartId && selectedPartId !== group.part_id) {
        setCrossPartWarning(group.part_id)
        setTimeout(() => setCrossPartWarning(null), 3000)
        return
      }
      setSelectedPartId(group.part_id)
      setSelectedLineIds(prev => {
        const next = new Set(prev)
        for (const id of allLineIds) next.add(id)
        return next
      })
      setCrossPartWarning(null)
    }
  }

  const groupCheckState = (group) => {
    const sel = group.lines.filter(l => selectedLineIds.has(l.line_id)).length
    if (sel === 0) return 'none'
    if (sel === group.lines.length) return 'all'
    return 'some'
  }

  // Stats for the sticky footer
  const selectedLines = useMemo(
    () => lines.filter(l => selectedLineIds.has(l.line_id)),
    [lines, selectedLineIds]
  )
  const selectedCustomerCount = useMemo(
    () => new Set(selectedLines.map(l => l.customer_name)).size,
    [selectedLines]
  )
  const selectedTotalQty = useMemo(
    () => selectedLines.reduce((s, l) => s + l.remaining, 0),
    [selectedLines]
  )

  const handleCreateWOSuccess = () => {
    clearSelection()
    setShowCreateWO(false)
    load()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        <Loader2 size={20} className="animate-spin mr-2" />
        Loading demand...
      </div>
    )
  }

  if (lines.length === 0) {
    return (
      <div className="text-center py-16 bg-gray-900 rounded-lg border border-gray-800 text-gray-400">
        No open customer orders. Demand will appear here once COs are entered.
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
            placeholder="Search part #, description, customer, CO #..."
            className="w-full pl-9 pr-3 py-2 bg-gray-900 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-purple-500"
          />
        </div>
        <button
          onClick={() => setSortMode(sortMode === 'demand' ? 'due' : 'demand')}
          className="px-3 py-1.5 text-xs rounded bg-gray-800 text-gray-300 hover:text-white border border-gray-700 transition-colors"
          title="Toggle sort order"
        >
          Sort: {sortMode === 'demand' ? 'Total demand ↓' : 'Earliest due ↑'}
        </button>
      </div>

      <div className="space-y-2 pb-24">
        {groups.length === 0 ? (
          <div className="text-center py-12 bg-gray-900 rounded-lg border border-gray-800 text-gray-500">
            No matches.
          </div>
        ) : (
          groups.map(group => {
            const isExpanded = expandedParts.has(group.part_id)
            const checkState = groupCheckState(group)
            const isWarned = crossPartWarning === group.part_id
            const isLockedOut = !!selectedPartId && selectedPartId !== group.part_id

            return (
              <div
                key={group.part_id}
                className={`bg-gray-900 border rounded-lg ${
                  isWarned
                    ? 'border-amber-600'
                    : isLockedOut
                      ? 'border-gray-800 opacity-60'
                      : 'border-gray-800'
                }`}
              >
                <div
                  onClick={() => toggleExpand(group.part_id)}
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-800/40"
                >
                  <ChevronRight
                    size={14}
                    className={`text-gray-500 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
                  />
                  <input
                    type="checkbox"
                    ref={el => { if (el) el.indeterminate = checkState === 'some' }}
                    checked={checkState === 'all'}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => tryToggleGroup(group)}
                    className="accent-purple-500 flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0 grid grid-cols-[2fr_3fr_auto_auto_auto] gap-4 items-center">
                    <div className="font-mono font-semibold text-purple-200 truncate">
                      {group.part_number}
                    </div>
                    <div className="text-gray-400 text-sm truncate">
                      {group.part_description}
                    </div>
                    <div className="text-amber-300 font-mono text-sm whitespace-nowrap">
                      {group.total_demand.toLocaleString()} pcs
                    </div>
                    <div className="text-gray-500 text-xs whitespace-nowrap">
                      {group.line_count} line{group.line_count !== 1 ? 's' : ''}
                    </div>
                    <div className="text-gray-500 text-xs whitespace-nowrap">
                      {group.earliest_due ? `due ${formatDate(group.earliest_due)}` : '—'}
                    </div>
                  </div>
                </div>

                {isWarned && (
                  <div className="px-4 pb-2 text-xs text-amber-300">
                    Clear current selection to select from a different part
                  </div>
                )}

                {isExpanded && (
                  <div className="border-t border-gray-800 bg-gray-950/50">
                    <table className="w-full text-sm">
                      <thead className="text-gray-500 text-[10px] uppercase">
                        <tr>
                          <th className="px-3 py-2 w-8"></th>
                          <th className="px-3 py-2 text-left">CO #</th>
                          <th className="px-3 py-2 text-left">Customer</th>
                          <th className="px-3 py-2 text-left">Line</th>
                          <th className="px-3 py-2 text-right">Remaining</th>
                          <th className="px-3 py-2 text-left">Due</th>
                          <th className="px-3 py-2 text-left">Priority</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.lines.map(line => {
                          const isSelected = selectedLineIds.has(line.line_id)
                          const lineLockedOut = !!selectedPartId && selectedPartId !== line.part_id
                          const priorityClass = PRIORITY_BADGE[line.priority] || PRIORITY_BADGE.normal
                          return (
                            <tr key={line.line_id} className="border-t border-gray-800">
                              <td className="px-3 py-2">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  disabled={lineLockedOut && !isSelected}
                                  onChange={(e) => tryToggleLine(line, e.target.checked)}
                                  className="accent-purple-500"
                                />
                              </td>
                              <td className="px-3 py-2 font-mono text-purple-300 text-xs">
                                {line.co_number}
                              </td>
                              <td className="px-3 py-2 text-gray-300">{line.customer_name}</td>
                              <td className="px-3 py-2 text-gray-500 text-xs">#{line.line_number}</td>
                              <td className="px-3 py-2 text-right font-mono text-amber-300">
                                {line.remaining.toLocaleString()}
                              </td>
                              <td className="px-3 py-2 text-gray-300 text-xs">
                                {line.due_date ? formatDate(line.due_date) : '—'}
                              </td>
                              <td className="px-3 py-2">
                                <span className={`px-1.5 py-0.5 text-[10px] rounded capitalize ${priorityClass}`}>
                                  {line.priority}
                                </span>
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
          })
        )}
      </div>

      {selectedLineIds.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-purple-500/40 px-6 py-3 flex items-center justify-between z-40 shadow-2xl">
          <div className="text-sm text-gray-300">
            <span className="text-purple-300 font-medium">{selectedLineIds.size}</span> line{selectedLineIds.size !== 1 ? 's' : ''} selected
            <span className="text-gray-600 mx-2">·</span>
            <span className="text-purple-300 font-medium">{selectedCustomerCount}</span> customer{selectedCustomerCount !== 1 ? 's' : ''}
            <span className="text-gray-600 mx-2">·</span>
            <span className="text-purple-300 font-medium font-mono">{selectedTotalQty.toLocaleString()}</span> total qty
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={clearSelection}
              className="px-3 py-1.5 text-sm text-gray-400 hover:text-white"
            >
              Clear
            </button>
            <button
              onClick={() => setShowCreateWO(true)}
              className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded font-medium transition-colors"
            >
              <Plus size={16} /> Create Work Order
            </button>
          </div>
        </div>
      )}

      {showCreateWO && (
        <CreateWorkOrderModal
          isOpen={showCreateWO}
          onClose={() => setShowCreateWO(false)}
          onSuccess={handleCreateWOSuccess}
          profile={profile}
          preselectedPartId={selectedPartId}
          preselectedCoLines={selectedLines}
        />
      )}
    </>
  )
}
