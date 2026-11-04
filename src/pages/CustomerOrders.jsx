import { useState, useEffect, useMemo, useCallback, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import SyncStatusBanner from '../components/orderqueue/SyncStatusBanner'
import { getSyncState, getMirrorLinks, FB_SO_STATUS, FB_LINE_STATUS } from '../lib/fishbowl'
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
  Pencil,
} from 'lucide-react'
import CreateCustomerOrderModal from '../components/CreateCustomerOrderModal'
import EditCustomerOrderModal from '../components/EditCustomerOrderModal'
import MyOrdersTab from '../components/MyOrdersTab'
import {
  CO_STATUS_LABELS,
  CO_STATUS_COLORS,
  getCOLineDates,
  getAllocationsForLine,
  cancelCOLine,
} from '../lib/customerOrders'
import { formatDate, formatDateShort } from '../components/demand/format'
import { loadActiveSalespeople } from '../lib/salespeople'
import { isReadOnlyRole, hasRole } from '../lib/roles'
import FulfillmentAdjustModal from '../components/FulfillmentAdjustModal'

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'not_started', label: 'Not Started' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'complete', label: 'Complete' },
  { value: 'cancelled', label: 'Cancelled' },
]



export default function CustomerOrders({
  profile,
  onNavigate,
  embedded = false,
  onNavigateToWO = null,
  navPayload = null,
  onNavPayloadConsumed = null,
}) {
  // D-FB-49: orders come from Fishbowl through the Order Queue; nobody edits customer orders here.
  // Create / Edit / Cancel / Mark complete stay admin-only as an escape hatch until they are removed.
  const canEdit = hasRole(profile, 'admin') && !isReadOnlyRole(profile?.role)
  // Manual fulfillment adjustment is a narrower grant than canEdit — it rewrites
  // a recorded fulfillment number, so customer_service is excluded (D-COFUL-01).
  const canAdjustFulfillment = hasRole(profile, 'admin', 'scheduler') && !isReadOnlyRole(profile?.role)

  // S17 B2 (D-ASM-33): Demand moved to the Command page, Stock Requests to the Order Queue.
  const [coTab, setCoTab] = useState('orders') // 'orders' | 'my_orders'
  const [adjustLine, setAdjustLine] = useState(null)
  const [myOrdersSearch, setMyOrdersSearch] = useState('')
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [salespersonFilter, setSalespersonFilter] = useState('all')
  const [salespeople, setSalespeople] = useState([])
  const [expanded, setExpanded] = useState(() => new Set())
  const [actionStatus, setActionStatus] = useState(null)

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editCoId, setEditCoId] = useState(null)
  const [confirmAction, setConfirmAction] = useState(null) // { type, ...payload }

  // CO-line allocation drilldown state. Only one panel open at a time.
  const [expandedAllocLineId, setExpandedAllocLineId] = useState(null)
  const [allocCache, setAllocCache] = useState({})       // { [lineId]: [allocations] }
  const [allocLoading, setAllocLoading] = useState({})   // { [lineId]: bool }

  useEffect(() => {
    let cancelled = false
    loadActiveSalespeople().then(sp => {
      if (!cancelled) setSalespeople(sp || [])
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const handleNavigateToWO = useCallback((woNumber) => {
    if (onNavigateToWO) {
      onNavigateToWO(woNumber)
    } else if (onNavigate) {
      onNavigate('mainframe', { woLookupSearch: woNumber, orderLookupTab: 'work_orders' })
    }
  }, [onNavigateToWO, onNavigate])

  // Deep link from My Orders → the original CO on the Orders tab, expanded.
  // Filters are reset to 'all' deliberately: a CO the rep is trying to reach
  // must not be hidden by a status or salesperson filter left set from earlier.
  const handleNavigateToCO = useCallback((coId, coNumber) => {
    setCoTab('orders')
    setSearchQuery(coNumber || '')
    setStatusFilter('all')
    setSalespersonFilter('all')
    if (coId) {
      setExpanded(prev => {
        const next = new Set(prev)
        next.add(coId)
        return next
      })
    }
  }, [])

  // Deep link in from the notifications bell: land on My Orders with the CO
  // number pre-searched. Consume-once, same contract Mainframe uses (D-NAV-01).
  useEffect(() => {
    // FB1: the Order Queue lands here with the CO number pre-searched on the Orders tab.
    if (navPayload?.coSearch) {
      setCoTab('orders')
      setSearchQuery(navPayload.coSearch)
      onNavPayloadConsumed?.()
      return
    }
    if (!navPayload?.myOrdersCO) return
    if (profile?.is_salesperson === true) {
      setCoTab('my_orders')
      setMyOrdersSearch(navPayload.myOrdersCO)
    }
    onNavPayloadConsumed?.()
  }, [navPayload, profile?.is_salesperson, onNavPayloadConsumed])

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

  // FB1 (Batch C2): Fishbowl mirror links for the FB chips, and the bridge heartbeat for the banner.
  const [fbLinks, setFbLinks] = useState({ bySo: {}, byLine: {} })
  const [fbSyncState, setFbSyncState] = useState(null)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const [links, state] = await Promise.all([getMirrorLinks(), getSyncState()])
        if (!cancelled) { setFbLinks(links); setFbSyncState(state) }
      } catch (e) {
        console.warn('Fishbowl mirror read failed:', e?.message || e)
      }
    }
    load()
    const t = setInterval(load, 60000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const loadOrders = useCallback(async () => {
    setLoading(true)
    try {
      // 1. Headers + customer name (1 nest level)
      const { data: cos, error: cosErr } = await supabase
        .from('customer_orders')
        .select(`
          id, co_number, fishbowl_order_id, po_number, notes, status,
          cancelled_at, cancel_reason, created_at,
          customer_id, salesperson_id,
          customers ( id, customer_id, name ),
          salesperson:profiles!customer_orders_salesperson_id_fkey ( id, full_name )
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
          due_date, priority, status, notes, components_needed, cancel_reason, fulfilled_at,
          fb_qty_ordered, fb_qty_fulfilled, fb_qty_to_fulfill,
          part_id,
          parts ( id, part_number, description, is_active ),
          components:customer_order_line_components ( component_id, component:parts ( part_number ) )
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

      // D-CODATE-01: entered / target / Fishbowl due / scheduled finish per line
      const lineDates = await getCOLineDates(supabase, lineIds)

      // Merge: attach lines (with allocated/remaining) onto each CO
      const linesByCO = new Map()
      for (const l of linesRaw || []) {
        const allocated = allocByLine.get(l.id) || 0
        const ordered = Number(l.quantity_ordered) || 0
        const fulfilled = Number(l.quantity_fulfilled) || 0
        const d = lineDates.get(l.id) || {}
        const enriched = {
          ...l,
          allocated,
          remaining: Math.max(0, ordered - fulfilled - allocated),
          entered_on: d.entered_on || null,
          entered_source: d.entered_source || 'skynet',
          target_date: d.target_date || null,
          fb_due_date: d.fb_due_date || l.due_date || null,
          fb_due_is_default: !!d.fb_due_is_default,
          scheduled_finish: d.scheduled_finish || null,
          has_unscheduled_jobs: !!d.has_unscheduled_jobs,
        }
        const arr = linesByCO.get(l.customer_order_id) || []
        arr.push(enriched)
        linesByCO.set(l.customer_order_id, arr)
      }

      const merged = (cos || []).map(co => {
        const lines = linesByCO.get(co.id) || []
        const openLines = lines.filter(l => l.status === 'not_started' || l.status === 'in_progress')
        const dueDates = (openLines.length ? openLines : lines).map(l => l.fb_due_date).filter(Boolean).sort()
        const targetDates = (openLines.length ? openLines : lines).map(l => l.target_date).filter(Boolean).sort()
        return {
          ...co,
          lines,
          line_count: lines.length,
          earliest_due: dueDates[0] || null,
          earliest_target: targetDates[0] || null,
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
      if (salespersonFilter !== 'all' && co.salesperson_id !== salespersonFilter) return false
      if (!q) return true
      if ((co.co_number || '').toLowerCase().includes(q)) return true
      if ((co.customers?.name || '').toLowerCase().includes(q)) return true
      if ((co.po_number || '').toLowerCase().includes(q)) return true
      if ((co.fishbowl_order_id || '').toLowerCase().includes(q)) return true
      if (co.lines.some(l => (l.parts?.part_number || '').toLowerCase().includes(q))) return true
      return false
    })
  }, [orders, statusFilter, salespersonFilter, searchQuery])

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
  // D-FB-48: the four steps (line cancelled first, allocations read, released, WOs flagged) now run
  // inside co_cancel_line, the same function the Order Queue's Exceptions tab uses.
  const cancelLine = async ({ lineId, reason }) => {
    await cancelCOLine(supabase, lineId, reason)
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
    <div className={`${coTab === 'my_orders' ? 'max-w-[1800px]' : 'max-w-7xl'} mx-auto p-6`}>
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

      {!embedded && <SyncStatusBanner state={fbSyncState} compact />}

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
        {profile?.is_salesperson === true && (
          <button
            onClick={() => setCoTab('my_orders')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              coTab === 'my_orders'
                ? 'border-purple-400 text-purple-300'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            My Orders
          </button>
        )}
      </div>

      {coTab === 'my_orders' ? (
        <MyOrdersTab
          profile={profile}
          onNavigateToWO={handleNavigateToWO}
          onNavigateToCO={handleNavigateToCO}
          initialSearch={myOrdersSearch}
        />
      ) : (
      <>
      <div className="mb-4 p-3 rounded border border-gray-700 bg-gray-800/60 text-xs text-gray-300">
        Customer orders come from Fishbowl through the Order Queue. Change the order in Fishbowl; anything SkyNet
        cannot apply on its own is resolved on the Order Queue&apos;s Exceptions tab. Creating, editing and cancelling
        here is admin-only while this tab is retired.
      </div>
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
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 whitespace-nowrap">Salesperson:</label>
          <select
            value={salespersonFilter}
            onChange={(e) => setSalespersonFilter(e.target.value)}
            className="px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-purple-500"
          >
            <option value="all">All</option>
            {salespeople.map(sp => (
              <option key={sp.id} value={sp.id}>{sp.full_name}</option>
            ))}
          </select>
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
                <th className="px-4 py-3 text-left">Salesperson</th>
                <th className="px-4 py-3 text-left">PO #</th>
                <th className="px-4 py-3 text-left">Lines</th>
                <th className="px-4 py-3 text-left" title="Earliest SkyNet target (later of entered + 45 business days and the Fishbowl due date) over open lines; Fishbowl's earliest due beneath">Target / FB Due</th>
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
                    fbSo={fbLinks.bySo[co.id]}
                    fbLines={fbLinks.byLine}
                    expanded={isExpanded}
                    onToggle={() => toggleExpand(co.id)}
                    canEdit={canEdit}
                    canAdjustFulfillment={canAdjustFulfillment}
                    onAdjustLineClick={(line) =>
                      setAdjustLine({
                        id: line.id,
                        line_number: line.line_number,
                        part_number: line.parts?.part_number || null,
                        customer: co.customers?.name || null,
                        quantity_ordered: line.quantity_ordered,
                        quantity_fulfilled: line.quantity_fulfilled,
                        status: line.status,
                      })
                    }
                    canCancelCO={canCancelCO}
                    onEditCOClick={() => setEditCoId(co.id)}
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

      {editCoId && (
        <EditCustomerOrderModal
          isOpen={!!editCoId}
          coId={editCoId}
          profile={profile}
          onClose={() => setEditCoId(null)}
          onSuccess={() => {
            setActionStatus({ type: 'success', message: 'Customer order updated.' })
            loadOrders()
            setEditCoId(null)
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

      <FulfillmentAdjustModal
        isOpen={!!adjustLine}
        line={adjustLine}
        onClose={() => setAdjustLine(null)}
        onSuccess={async (result) => {
          setAdjustLine(null)
          setActionStatus({
            type: 'success',
            message: `Fulfilled quantity adjusted ${result?.old ?? '?'} → ${result?.new ?? '?'}.`,
          })
          await loadOrders()
        }}
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function CORow({
  co,
  fbSo,
  fbLines,
  expanded,
  onToggle,
  canEdit,
  canAdjustFulfillment,
  onAdjustLineClick,
  canCancelCO,
  onEditCOClick,
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
        <td className="px-4 py-3 text-purple-300 font-mono text-sm whitespace-nowrap">
          {co.co_number}
          {fbSo && (
            <span
              className={`ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] border align-middle ${
                fbSo.status_id === 20 || fbSo.status_id === 25
                  ? 'bg-blue-900/40 text-blue-300 border-blue-800'
                  : fbSo.status_id >= 80 ? 'bg-red-900/40 text-red-300 border-red-800' : 'bg-green-900/40 text-green-300 border-green-800'
              }`}
              title={`Fishbowl SO ${fbSo.so_number} · ${FB_SO_STATUS[fbSo.status_id] || fbSo.status_id} · live via the bridge`}
            >
              FB {FB_SO_STATUS[fbSo.status_id] || fbSo.status_id}
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-gray-200 text-sm">
          {co.customers?.name || <span className="text-gray-600">—</span>}
          {co.customers?.customer_id && (
            <span className="text-gray-600 ml-1 font-mono text-xs">
              ({co.customers.customer_id})
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-gray-300 text-sm">
          {co.salesperson?.full_name || <span className="text-gray-600">—</span>}
        </td>
        <td className="px-4 py-3 text-gray-300 text-sm">
          {co.po_number || <span className="text-gray-600">—</span>}
        </td>
        <td className="px-4 py-3 text-gray-300 text-sm">{co.line_count}</td>
        <td className="px-4 py-3 text-sm whitespace-nowrap">
          <div className="text-gray-200">{co.earliest_target ? formatDate(co.earliest_target) : <span className="text-gray-600">—</span>}</div>
          <div className="text-[10px] text-gray-500" title="Earliest Fishbowl due date">
            FB {co.earliest_due ? formatDateShort(co.earliest_due) : '—'}
          </div>
        </td>
        <td className="px-4 py-3">
          <span className={`px-2 py-0.5 text-xs rounded ${statusClass}`}>{statusLabel}</span>
        </td>
        <td className="px-4 py-3 text-gray-500 text-xs">
          {co.created_at ? new Date(co.created_at).toLocaleDateString() : '—'}
        </td>
        <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
          {canEdit && co.status !== 'cancelled' && (
            <button
              onClick={onEditCOClick}
              className="px-2 py-1 text-xs text-purple-300 hover:bg-purple-900/30 rounded inline-flex items-center gap-1 mr-1"
              title="Edit customer order"
            >
              <Pencil size={12} /> Edit
            </button>
          )}
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
          <td colSpan={10} className="p-0">
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
                      <th className="px-2 py-2 text-left" title="Day the order was entered (Fishbowl SO creation for Fishbowl-sourced lines)">Entered</th>
                      <th className="px-2 py-2 text-left" title="SkyNet target: the later of entered + 45 business days and the Fishbowl due date">Target</th>
                      <th className="px-2 py-2 text-left" title="Fishbowl's live due date (* = Fishbowl default, no real date entered)">FB Due</th>
                      <th className="px-2 py-2 text-left" title="Latest scheduled end across the allocated work orders' jobs">Finish</th>
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
                              {l.fb_qty_ordered !== null && l.fb_qty_ordered !== undefined && (
                                <div className="text-[10px] text-gray-500" title="Fishbowl, live: ordered · shipped · to fulfill">
                                  FB {Number(l.fb_qty_ordered).toLocaleString()} · {Number(l.fb_qty_fulfilled || 0).toLocaleString()} · {Number(l.fb_qty_to_fulfill ?? 0).toLocaleString()}
                                </div>
                              )}
                              {(fbLines?.[l.id] || []).some((f) => f.status_id === 50 || f.status_id === 60) && (
                                <div className="text-[10px] text-green-400" title={`Fishbowl line status: ${(fbLines[l.id] || []).map((f) => FB_LINE_STATUS[f.status_id] || f.status_id).join(', ')}`}>
                                  Shipped in Fishbowl
                                </div>
                              )}
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
                            <td className="px-2 py-2 text-gray-400 text-xs whitespace-nowrap" title={l.entered_source === 'fishbowl' ? 'Fishbowl SO creation date' : 'SkyNet line creation date'}>
                              {l.entered_on ? formatDateShort(l.entered_on) : '—'}
                            </td>
                            <td className="px-2 py-2 text-gray-200 text-xs whitespace-nowrap font-medium">
                              {l.target_date ? formatDateShort(l.target_date) : '—'}
                            </td>
                            <td
                              className={`px-2 py-2 text-xs whitespace-nowrap ${l.fb_due_date && l.target_date && l.fb_due_date < l.target_date ? 'text-amber-300' : 'text-gray-300'}`}
                              title={l.fb_due_date && l.target_date && l.fb_due_date < l.target_date ? 'Fishbowl due date is earlier than the SkyNet target' : undefined}
                            >
                              {l.fb_due_date ? formatDateShort(l.fb_due_date) : '—'}
                              {l.fb_due_is_default && <span className="text-amber-400 ml-0.5" title="No real date entered in Fishbowl">*</span>}
                            </td>
                            <td
                              className={`px-2 py-2 text-xs whitespace-nowrap ${l.scheduled_finish && l.target_date && l.scheduled_finish > l.target_date ? 'text-red-300' : 'text-gray-300'}`}
                              title={l.has_unscheduled_jobs ? 'Some allocated work is not scheduled yet' : (l.scheduled_finish && l.target_date && l.scheduled_finish > l.target_date ? 'Scheduled finish is after the SkyNet target' : undefined)}
                            >
                              {l.scheduled_finish ? formatDateShort(l.scheduled_finish) : (l.allocated > 0 ? 'unsched.' : '—')}
                              {l.scheduled_finish && l.has_unscheduled_jobs && <span className="text-gray-500 ml-0.5">+</span>}
                            </td>
                            <td className="px-2 py-2 text-gray-400 text-xs capitalize whitespace-nowrap">{l.priority}</td>
                            <td className="px-2 py-2 whitespace-nowrap">
                              <span className={`px-1.5 py-0.5 text-[10px] rounded ${lineStatusClass}`}>
                                {lineStatusLabel}
                              </span>
                            </td>
                            <td className="px-2 py-2 text-right whitespace-nowrap">
                              <div className="flex justify-end gap-1">
                                {/* Adjust is deliberately NOT gated on canAct:
                                    reopening a complete line is the whole point. */}
                                {canAdjustFulfillment && l.status !== 'cancelled' && (
                                  <button
                                    onClick={() => onAdjustLineClick(l)}
                                    className="p-1 text-skynet-accent hover:bg-blue-900/30 rounded"
                                    title="Adjust fulfilled quantity"
                                  >
                                    <Pencil size={14} />
                                  </button>
                                )}
                              {canAct && (
                                <>
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
                                </>
                              )}
                              </div>
                            </td>
                          </tr>
                          {isAllocExpanded && (
                            <tr className="bg-gray-900/60">
                              <td colSpan={13} className="px-6 py-3">
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
                          {(l.components_needed || (l.components || []).length > 0) && (
                            <tr className="border-t border-gray-900 bg-gray-950/60">
                              <td colSpan={13} className="px-3 py-2">
                                <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">Components Needed</div>
                                {(l.components || []).length > 0 && (
                                  <div className="flex flex-wrap gap-1 mb-1">
                                    {(l.components || []).map(c => c.component?.part_number).filter(Boolean).sort().map(pn => (
                                      <span key={pn} className="font-mono text-xs text-green-200 px-1.5 py-0.5 rounded border border-green-900 bg-green-900/20">{pn}</span>
                                    ))}
                                  </div>
                                )}
                                {l.components_needed && <div className="text-xs text-gray-300 whitespace-pre-wrap">{l.components_needed}</div>}
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
