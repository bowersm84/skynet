import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Search, RefreshCw, Loader2, X } from 'lucide-react'
import SOCard from '../components/orderqueue/SOCard'
import ConvertToCOModal from '../components/orderqueue/ConvertToCOModal'
import SyncStatusBanner from '../components/orderqueue/SyncStatusBanner'
import ExceptionsTab from '../components/orderqueue/ExceptionsTab'
import RecentChangesTab from '../components/orderqueue/RecentChangesTab'
import { canActOnOrderQueue } from '../lib/roles'
import {
  getSyncState, getQueueOrders, getQueueLines, getInventoryFor, getOpenExceptions, getRecentEvents,
  setDisposition, reresolveLines, ackEvent, DISPOSITION_LABELS,
} from '../lib/fishbowl'

// OrderQueue — FB1. Every Issued / In Progress Fishbowl sales order, mirrored live by the bridge,
// waiting for a per-line call: ship from stock, purchase, assembly, covered, ignore — or Create CO,
// which drops the line into Customer Orders → Demand exactly like a hand-keyed CO (D-FB-12/13/26).
// Exceptions (D-FB-15) and the change feed (fb_sync_events) live on their own tabs.
export default function OrderQueue({ profile, onNavigate }) {
  const canAct = canActOnOrderQueue(profile)

  const [tab, setTab] = useState('queue') // 'queue' | 'all' | 'exceptions' | 'changes'
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [search, setSearch] = useState('')
  const [salesmanFilter, setSalesmanFilter] = useState('all')
  const [expanded, setExpanded] = useState(() => new Set())
  const [linesBySo, setLinesBySo] = useState({})        // { [fb_so_id]: lines[] }
  const [linesLoading, setLinesLoading] = useState({})  // { [fb_so_id]: true }
  const [inventory, setInventory] = useState({})        // { [PART_NUM]: fb_part_inventory row }
  const [selected, setSelected] = useState({})          // { [fb_so_id]: Set(fb_soitem_id) }
  const [busySo, setBusySo] = useState(null)
  const [actionStatus, setActionStatus] = useState(null)
  const [syncState, setSyncState] = useState(null)
  const [convertTarget, setConvertTarget] = useState(null) // { order, lines }
  const [exceptions, setExceptions] = useState([])
  const [exceptionsLoading, setExceptionsLoading] = useState(false)
  const [events, setEvents] = useState([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const [ackingId, setAckingId] = useState(null)
  const reresolvedRef = useRef(false)

  const loadOrders = useCallback(async () => {
    try {
      setLoadError(null)
      const rows = await getQueueOrders()
      setOrders(rows)
    } catch (e) {
      console.error('Order Queue load failed:', e)
      setLoadError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadLines = useCallback(async (fbSoId) => {
    setLinesLoading((prev) => ({ ...prev, [fbSoId]: true }))
    try {
      const rows = await getQueueLines(fbSoId)
      setLinesBySo((prev) => ({ ...prev, [fbSoId]: rows }))
      // D-FB-33: Fishbowl on-hand for the parts on these lines
      const partNums = rows.map((l) => (l.part_num || l.product_num || '').toUpperCase()).filter(Boolean)
      try {
        const inv = await getInventoryFor(partNums)
        const upper = {}
        for (const [k, v] of Object.entries(inv)) upper[k.toUpperCase()] = v
        setInventory((prev) => ({ ...prev, ...upper }))
      } catch (e) {
        console.warn('inventory snapshot read failed:', e?.message || e)
      }
    } catch (e) {
      console.error('Order Queue lines load failed:', e)
      setActionStatus({ type: 'error', message: `Could not load lines for SO: ${e?.message || e}` })
    } finally {
      setLinesLoading((prev) => ({ ...prev, [fbSoId]: false }))
    }
  }, [])

  const refreshSync = useCallback(async () => {
    try {
      setSyncState(await getSyncState())
    } catch (e) {
      console.error('fb_sync_state read failed:', e)
    }
  }, [])

  const loadExceptions = useCallback(async () => {
    setExceptionsLoading(true)
    try {
      setExceptions(await getOpenExceptions())
    } catch (e) {
      setActionStatus({ type: 'error', message: `Could not load exceptions: ${e?.message || e}` })
    } finally {
      setExceptionsLoading(false)
    }
  }, [])

  const loadEvents = useCallback(async () => {
    setEventsLoading(true)
    try {
      setEvents(await getRecentEvents(200))
    } catch (e) {
      setActionStatus({ type: 'error', message: `Could not load changes: ${e?.message || e}` })
    } finally {
      setEventsLoading(false)
    }
  }, [])

  // Initial load. Acting roles first sweep unresolved lines against the parts master
  // (D-FB-23) so a part added in the Armory since the last visit lights up its SO lines.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (canAct && !reresolvedRef.current) {
        reresolvedRef.current = true
        try { await reresolveLines() } catch (e) { console.warn('fb_reresolve_lines skipped:', e?.message || e) }
      }
      if (!cancelled) {
        await Promise.all([loadOrders(), refreshSync(), loadExceptions()])
      }
    })()
    const t = setInterval(refreshSync, 30000)
    return () => { cancelled = true; clearInterval(t) }
  }, [canAct, loadOrders, refreshSync, loadExceptions])

  // Tab-specific loads
  useEffect(() => {
    if (tab === 'exceptions') loadExceptions()
    if (tab === 'changes') loadEvents()
  }, [tab, loadExceptions, loadEvents])

  const refreshAll = useCallback(async () => {
    setLoading(true)
    await Promise.all([
      loadOrders(), refreshSync(), loadExceptions(),
      ...(tab === 'changes' ? [loadEvents()] : []),
      ...[...expanded].map((id) => loadLines(id)),
    ])
  }, [loadOrders, refreshSync, loadExceptions, loadEvents, loadLines, expanded, tab])

  const toggleExpanded = useCallback((fbSoId) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(fbSoId)) next.delete(fbSoId)
      else {
        next.add(fbSoId)
        if (!linesBySo[fbSoId]) loadLines(fbSoId)
      }
      return next
    })
  }, [linesBySo, loadLines])

  const selectionFor = (fbSoId) => selected[fbSoId] || new Set()
  const setSelectionFor = (fbSoId, next) => setSelected((prev) => ({ ...prev, [fbSoId]: next }))
  const toggleLine = (fbSoId, lineId) => {
    const next = new Set(selectionFor(fbSoId))
    if (next.has(lineId)) next.delete(lineId)
    else next.add(lineId)
    setSelectionFor(fbSoId, next)
  }

  const handleBulkDisposition = async (order, disposition) => {
    const ids = [...selectionFor(order.fb_so_id)]
    if (ids.length === 0) return
    setBusySo(order.fb_so_id)
    try {
      const n = await setDisposition(ids, disposition, null)
      setActionStatus({
        type: 'success',
        message: `SO ${order.so_number}: ${n} line${n === 1 ? '' : 's'} marked ${DISPOSITION_LABELS[disposition] || disposition}.`,
      })
      setSelectionFor(order.fb_so_id, new Set())
      await Promise.all([loadLines(order.fb_so_id), loadOrders()])
    } catch (e) {
      setActionStatus({ type: 'error', message: e?.message || String(e) })
    } finally {
      setBusySo(null)
    }
  }

  const openConvert = (order) => {
    const lines = (linesBySo[order.fb_so_id] || []).filter((l) => selectionFor(order.fb_so_id).has(l.fb_soitem_id))
    if (lines.length === 0) return
    setConvertTarget({ order, lines })
  }

  const handleConverted = async (result) => {
    const order = convertTarget?.order
    setConvertTarget(null)
    if (!order) return
    const skipped = Array.isArray(result?.skipped) ? result.skipped.length : 0
    const created = Number(result?.lines_created || 0)
    const added = Number(result?.lines_added || 0)
    const parts = []
    if (created) parts.push(`${created} new line${created === 1 ? '' : 's'}`)
    if (added) parts.push(`added to ${added} existing line${added === 1 ? '' : 's'}`)
    setActionStatus({
      type: 'success',
      message: `${result?.created ? 'Created' : 'Updated'} ${result?.co_number}: ${parts.join(', ') || 'no change'}${skipped ? ` (${skipped} skipped)` : ''}.`,
      coNumber: result?.co_number,
    })
    setSelectionFor(order.fb_so_id, new Set())
    await Promise.all([loadLines(order.fb_so_id), loadOrders()])
  }

  const handleAck = async (eventId) => {
    setAckingId(eventId)
    try {
      await ackEvent(eventId)
      setExceptions((prev) => prev.filter((e) => e.id !== eventId))
      await loadOrders()
    } catch (e) {
      setActionStatus({ type: 'error', message: e?.message || String(e) })
    } finally {
      setAckingId(null)
    }
  }

  const openCO = (coNumber) => onNavigate?.('customer_orders', { coSearch: coNumber })

  const salesmen = useMemo(
    () => [...new Set(orders.map((o) => o.salesman).filter(Boolean))].sort(),
    [orders],
  )

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return orders.filter((o) => {
      if (tab === 'queue' && !(o.pending_lines > 0)) return false
      if (salesmanFilter !== 'all' && o.salesman !== salesmanFilter) return false
      if (!q) return true
      return [o.so_number, o.customer_name, o.customer_po, o.linked_co_number, o.salesman]
        .some((v) => v && String(v).toLowerCase().includes(q))
    })
  }, [orders, tab, salesmanFilter, search])

  const queueCount = orders.filter((o) => o.pending_lines > 0).length
  const pendingLines = orders.reduce((s, o) => s + (o.pending_lines || 0), 0)
  const listTab = tab === 'queue' || tab === 'all'

  const tabClass = (t) => `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
    tab === t ? 'border-amber-400 text-amber-300' : 'border-transparent text-gray-400 hover:text-white'
  }`

  return (
    <div className="max-w-[1600px] mx-auto p-6">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Order Queue</h2>
          <p className="text-gray-500 text-sm mt-1">
            Fishbowl sales orders, live — decide per line: stock, purchase, or Create CO into Demand
            {!canAct && <span className="text-gray-600"> · read-only for your role</span>}
          </p>
        </div>
        <button
          onClick={refreshAll}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 rounded text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <SyncStatusBanner state={syncState} />

      {actionStatus && (
        <div className={`mb-4 p-3 rounded text-sm flex justify-between items-center ${
          actionStatus.type === 'success'
            ? 'bg-green-900/40 text-green-300 border border-green-800'
            : 'bg-red-900/40 text-red-300 border border-red-800'
        }`}>
          <span>
            {actionStatus.message}
            {actionStatus.coNumber && (
              <button onClick={() => openCO(actionStatus.coNumber)} className="ml-2 underline decoration-dotted underline-offset-2 hover:text-white">
                Open in Customer Orders
              </button>
            )}
          </span>
          <button onClick={() => setActionStatus(null)}><X size={14} /></button>
        </div>
      )}

      {/* Tab strip */}
      <div className="flex items-center gap-1 border-b border-gray-800 mb-4">
        <button onClick={() => setTab('queue')} className={tabClass('queue')}>
          Queue <span className="ml-1 text-xs text-gray-500">{queueCount}</span>
        </button>
        <button onClick={() => setTab('all')} className={tabClass('all')}>
          All Open <span className="ml-1 text-xs text-gray-500">{orders.length}</span>
        </button>
        <button onClick={() => setTab('exceptions')} className={tabClass('exceptions')}>
          Exceptions <span className={`ml-1 text-xs ${exceptions.length ? 'text-red-300' : 'text-gray-500'}`}>{exceptions.length}</span>
        </button>
        <button onClick={() => setTab('changes')} className={tabClass('changes')}>
          Recent Changes
        </button>
        <span className="ml-auto text-xs text-gray-600 pr-2">{pendingLines.toLocaleString()} pending line{pendingLines === 1 ? '' : 's'}</span>
      </div>

      {/* Filters (list tabs only) */}
      {listTab && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="SO #, customer, PO, CO #"
              className="w-full pl-9 pr-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-skynet-accent"
            />
          </div>
          <select
            value={salesmanFilter}
            onChange={(e) => setSalesmanFilter(e.target.value)}
            className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-skynet-accent"
          >
            <option value="all">All salespeople</option>
            {salesmen.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <span className="text-xs text-gray-600">
            Due: <span className="text-amber-400">*</span> no real date entered in Fishbowl · <span className="text-cyan-400">R</span> Remaining Parts Ship Date · Avail: Fishbowl stock available to ship
          </span>
        </div>
      )}

      {tab === 'exceptions' && (
        <ExceptionsTab events={exceptions} loading={exceptionsLoading} canAct={canAct} ackingId={ackingId} onAck={handleAck} onOpenCO={openCO} />
      )}

      {tab === 'changes' && (
        <RecentChangesTab events={events} loading={eventsLoading} onOpenCO={openCO} />
      )}

      {listTab && (
        loading && orders.length === 0 ? (
          <div className="text-center py-16 bg-gray-900 rounded-lg border border-gray-800 text-gray-400 flex items-center justify-center gap-2">
            <Loader2 size={16} className="animate-spin" /> Loading Fishbowl orders...
          </div>
        ) : loadError ? (
          <div className="text-center py-12 bg-red-900/20 rounded-lg border border-red-900 text-red-300 text-sm">{loadError}</div>
        ) : visible.length === 0 ? (
          <div className="text-center py-12 bg-gray-900 rounded-lg border border-gray-800 text-gray-500">
            {tab === 'queue' ? 'Nothing pending — every open order line has a disposition.' : 'No open Fishbowl orders match.'}
          </div>
        ) : (
          <div className="space-y-2">
            {visible.map((o) => (
              <SOCard
                key={o.fb_so_id}
                order={o}
                lines={linesBySo[o.fb_so_id] || null}
                linesLoading={!!linesLoading[o.fb_so_id]}
                expanded={expanded.has(o.fb_so_id)}
                onToggle={() => toggleExpanded(o.fb_so_id)}
                selected={selectionFor(o.fb_so_id)}
                onToggleLine={(lineId) => toggleLine(o.fb_so_id, lineId)}
                onSelectAll={(ids) => setSelectionFor(o.fb_so_id, new Set(ids))}
                onClearSelection={() => setSelectionFor(o.fb_so_id, new Set())}
                canAct={canAct}
                busy={busySo === o.fb_so_id}
                onBulkDisposition={(d) => handleBulkDisposition(o, d)}
                onConvert={() => openConvert(o)}
                onOpenCO={openCO}
                inventory={inventory}
              />
            ))}
          </div>
        )
      )}

      {convertTarget && (
        <ConvertToCOModal
          order={convertTarget.order}
          lines={convertTarget.lines}
          onClose={() => setConvertTarget(null)}
          onConverted={handleConverted}
        />
      )}
    </div>
  )
}
