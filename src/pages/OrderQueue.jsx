import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Search, RefreshCw, Loader2, X, Plus } from 'lucide-react'
import { supabase } from '../lib/supabase'
import SOCard from '../components/orderqueue/SOCard'
import ConvertToCOModal from '../components/orderqueue/ConvertToCOModal'
import PurchaseComponentsModal from '../components/orderqueue/PurchaseComponentsModal'
import SyncStatusBanner from '../components/orderqueue/SyncStatusBanner'
import ExceptionsTab from '../components/orderqueue/ExceptionsTab'
import RecentChangesTab from '../components/orderqueue/RecentChangesTab'
import StockRequestsView from '../components/demand/StockRequestsView'
import StockRequestModal from '../components/StockRequestModal'
import { countOpenStockRequests } from '../lib/customerOrders'
import { countPostCards } from '../lib/assembly'
import PostCards from '../components/assembly/PostCards'
import { FEATURES } from '../config'
import { canActOnOrderQueue, hasRole, isReadOnlyRole } from '../lib/roles'
import {
  getSyncState, getQueueOrders, getQueueLines, getQueuePartIndex, getInventoryFor, getOpenExceptions, getRecentEvents,
  setDisposition, reresolveLines, ackEvent, DISPOSITION_LABELS, getLineDetail, getPurchaseComponents,
  resolveException, getLineShipStates, getFlaggedLines, SIGNAL_FILTERS,
} from '../lib/fishbowl'

// D-FB-42: a Purchase on one of these part types may need a component list — the modal loads the
// BOM and passes a BOM-less part straight through. Manufactured and purchased parts never ask.
const PURCHASE_ASKS_PART_TYPES = ['assembly', 'finished_good']

// OrderQueue — FB1. Every Issued / In Progress Fishbowl sales order, mirrored live by the bridge,
// waiting for a per-line call: ship from stock, purchase, assembly, ignore — or Create CO (D-FB-50 retired "covered"),
// which drops the line into Demand (Command page since S17 B2, D-ASM-33) exactly like a hand-keyed CO (D-FB-12/13/26).
// Exceptions (D-FB-15), the change feed (fb_sync_events) and warehouse stock requests (D-STKREQ-01, moved from
// Customer Orders, D-ASM-33) live on their own tabs; New Stock Request (admin / assembly) is on the Stock Requests tab.
export default function OrderQueue({ profile, onNavigate }) {
  const canAct = canActOnOrderQueue(profile)
  const canRaiseStock = hasRole(profile, 'admin', 'assembly') && !isReadOnlyRole(profile?.role)

  const [tab, setTab] = useState('queue') // 'queue' | 'all' | 'exceptions' | 'changes' | 'stock_requests' | 'post'
  // S17 D1 (D-ASM-54): Ashley's Ready to post cards, behind the Assembly Board flag (TEST only). null until counted.
  const [postCount, setPostCount] = useState(null)
  const [stockOpen, setStockOpen] = useState(null)          // open stock requests, for the tab label
  const [stockRefreshKey, setStockRefreshKey] = useState(0)
  const [showStockModal, setShowStockModal] = useState(false)
  const [orders, setOrders] = useState([])
  const [partIndex, setPartIndex] = useState({})       // { [fb_so_id]: 'part numbers on the SO' } — D-FB-51 search
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
  const [purchaseTarget, setPurchaseTarget] = useState(null) // { order, ids, askLines } — D-FB-42
  const [purchaseError, setPurchaseError] = useState(null)   // shown inside the purchase modal, not on the banner behind it
  const [lineDetail, setLineDetail] = useState({})        // { [co_line_id]: { dates, components, allocations } } — D-FB-44
  const [purchaseComps, setPurchaseComps] = useState({})  // { [fb_soitem_id]: rows } — D-FB-42
  const [expandedLines, setExpandedLines] = useState(() => new Set()) // fb_soitem_ids with the detail row open
  const [exceptions, setExceptions] = useState([])
  const [exceptionsLoading, setExceptionsLoading] = useState(false)
  const [events, setEvents] = useState([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const [ackingId, setAckingId] = useState(null)
  const [resolvingId, setResolvingId] = useState(null) // D-FB-48
  const [flagged, setFlagged] = useState([])              // lines with an Assembly / Production / Purchasing pick flag — D-ASM-27
  const [signalFilter, setSignalFilter] = useState(null)  // null | 'needs_co' | 'assembly' | 'purchasing'
  const reresolvedRef = useRef(false)

  const loadOrders = useCallback(async () => {
    try {
      setLoadError(null)
      const rows = await getQueueOrders()
      setOrders(rows)
      // D-FB-51: part numbers per SO for the search box. A failed read is logged, not shown — the
      // SO / customer / PO / CO search keeps working and the part search matches nothing until the
      // next refresh.
      try {
        setPartIndex(await getQueuePartIndex(rows.map((o) => o.fb_so_id)))
      } catch (e) {
        console.warn('queue part index read failed:', e?.message || e)
      }
      // D-ASM-27: the flagged lines behind the Needs CO / Assembly / Purchasing filters. Same rule as the part
      // index: a failed read is logged and the filters show no lines until the next refresh.
      try {
        setFlagged(await getFlaggedLines())
      } catch (e) {
        console.warn('flagged line read failed:', e?.message || e)
      }
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
      const lineRows = await getQueueLines(fbSoId)
      // S17 A2: shipped / invoiced per line from the ship and posting mirrors. A failed read leaves the chips off.
      let ship = {}
      try {
        ship = await getLineShipStates(lineRows.map((l) => l.fb_soitem_id))
      } catch (e) {
        console.warn('ship state read failed:', e?.message || e)
      }
      const rows = lineRows.map((l) => ({ ...l, ship: ship[l.fb_soitem_id] || null }))
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
      // D-FB-44 / D-FB-42: production detail for linked lines, purchase lists for purchased lines —
      // settled separately so a failed purchase-list read never marks the production detail failed.
      const coLineIds = rows.map((l) => l.customer_order_line_id).filter(Boolean)
      const [detailRes, compsRes] = await Promise.allSettled([
        getLineDetail(coLineIds),
        getPurchaseComponents(rows.filter((l) => l.disposition === 'purchased').map((l) => l.fb_soitem_id)),
      ])
      if (detailRes.status === 'fulfilled') {
        setLineDetail((prev) => ({ ...prev, ...detailRes.value }))
      } else {
        const msg = detailRes.reason?.message || String(detailRes.reason)
        console.warn('line detail read failed:', msg)
        const failed = {}
        for (const id of coLineIds) failed[id] = { error: msg }
        setLineDetail((prev) => ({ ...prev, ...failed }))
      }
      if (compsRes.status === 'fulfilled') {
        setPurchaseComps((prev) => {
          const next = { ...prev }
          for (const l of rows) delete next[l.fb_soitem_id]
          return { ...next, ...compsRes.value }
        })
      } else {
        console.warn('purchase component read failed:', compsRes.reason?.message || compsRes.reason)
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

  // The Stock requests tab's "(n open)". A failed count is logged; the label shows … until the next refresh.
  const loadStockCount = useCallback(async () => {
    try {
      setStockOpen(await countOpenStockRequests(supabase))
    } catch (e) {
      console.warn('stock request count failed:', e?.message || e)
    }
  }, [])
  // Stable, so the stock request list does not reload on every render of this page.
  const handleStockLoaded = useCallback((rows) => setStockOpen(rows.filter((r) => r.status === 'open').length), [])
  const handleNavigateToWO = useCallback(
    (woNumber) => onNavigate?.('mainframe', { woLookupSearch: woNumber, orderLookupTab: 'work_orders' }),
    [onNavigate]
  )

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
        await Promise.all([loadOrders(), refreshSync(), loadExceptions(), loadStockCount()])
      }
    })()
    const t = setInterval(refreshSync, 30000)
    return () => { cancelled = true; clearInterval(t) }
  }, [canAct, loadOrders, refreshSync, loadExceptions, loadStockCount])

  // S17 D1: the Ready to post count, every 15 s while the page is open (the tab itself polls its cards every 12 s).
  useEffect(() => {
    if (!FEATURES.ASSEMBLY_BOARD) return undefined
    let alive = true
    const count = () => countPostCards().then((n) => { if (alive) setPostCount(n) }).catch((e) => console.warn('post card count failed:', e?.message || e))
    count()
    const t = setInterval(() => { if (!document.hidden) count() }, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  // Tab-specific loads
  useEffect(() => {
    if (tab === 'exceptions') loadExceptions()
    if (tab === 'changes') loadEvents()
  }, [tab, loadExceptions, loadEvents])

  const refreshAll = useCallback(async () => {
    setLoading(true)
    setStockRefreshKey((k) => k + 1)
    await Promise.all([
      loadOrders(), refreshSync(), loadExceptions(), loadStockCount(),
      ...(tab === 'changes' ? [loadEvents()] : []),
      ...[...expanded].map((id) => loadLines(id)),
    ])
  }, [loadOrders, refreshSync, loadExceptions, loadStockCount, loadEvents, loadLines, expanded, tab])

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

  const toggleLineDetail = (fbSoitemId) => {
    setExpandedLines((prev) => {
      const next = new Set(prev)
      if (next.has(fbSoitemId)) next.delete(fbSoitemId)
      else next.add(fbSoitemId)
      return next
    })
  }

  const handleBulkDisposition = async (order, disposition, components = {}) => {
    const ids = [...selectionFor(order.fb_so_id)]
    if (ids.length === 0) return
    if (disposition === 'purchased' && !purchaseTarget) {
      const askLines = (linesBySo[order.fb_so_id] || []).filter((l) =>
        ids.includes(l.fb_soitem_id) && l.part_id && PURCHASE_ASKS_PART_TYPES.includes(l.part?.part_type))
      if (askLines.length > 0) {
        setPurchaseError(null)
        setPurchaseTarget({ order, ids, askLines })
        return
      }
    }
    setBusySo(order.fb_so_id)
    try {
      const n = await setDisposition(ids, disposition, null, components)
      setActionStatus({
        type: 'success',
        message: `SO ${order.so_number}: ${n} line${n === 1 ? '' : 's'} marked ${DISPOSITION_LABELS[disposition] || disposition}.`,
      })
      setSelectionFor(order.fb_so_id, new Set())
      setPurchaseTarget(null)
      setPurchaseError(null)
      await Promise.all([loadLines(order.fb_so_id), loadOrders()])
    } catch (e) {
      if (purchaseTarget) setPurchaseError(e?.message || String(e))
      else setActionStatus({ type: 'error', message: e?.message || String(e) })
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
    // D-FB-45: a hand-keyed line sitting on a Fishbowl line number is moved out of the way
    const renumbered = Array.isArray(result?.renumbered) ? result.renumbered.length : 0
    if (renumbered) parts.push(`${renumbered} other line${renumbered === 1 ? '' : 's'} renumbered to match Fishbowl`)
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

  // D-FB-48: resolve an exception in one step — the RPC applies or cancels, then acknowledges.
  const handleResolve = async (ev, action) => {
    setResolvingId(ev.id)
    try {
      const r = await resolveException(ev.id, action)
      let message
      if (r?.action === 'apply_qty') {
        message = `${r.co_number} #${r.line_number}: quantity ${Number(r.from).toLocaleString()} → ${Number(r.to).toLocaleString()} (Fishbowl). Exception resolved.`
      } else {
        const done = (r?.cancelled || []).filter((c) => !c.already_cancelled)
        const wos = [...new Set(done.flatMap((c) => c.work_orders || []))]
        message = `Cancelled ${done.map((c) => `${c.co_number} #${c.line_number}`).join(', ') || 'nothing new'}`
          + (wos.length ? ` — allocation released on ${wos.join(', ')} (flagged)` : '')
          + '. Exception resolved.'
          + (r?.requeued_fb_line ? ` Fishbowl line ${r.requeued_fb_line} is back in the Queue${r.new_part_in_skynet ? '' : ' (its new part is not in SkyNet yet)'}.` : '')
      }
      setActionStatus({ type: 'success', message, coNumber: r?.co_number || (r?.cancelled || [])[0]?.co_number })
      setExceptions((prev) => prev.filter((x) => x.id !== ev.id))
      await Promise.all([
        loadOrders(),
        ...(ev.fb_so_id && linesBySo[ev.fb_so_id] ? [loadLines(ev.fb_so_id)] : []),
      ])
    } catch (e) {
      setActionStatus({ type: 'error', message: e?.message || String(e) })
    } finally {
      setResolvingId(null)
    }
  }

  const openCO = (coNumber) => onNavigate?.('customer_orders', { coSearch: coNumber })

  const salesmen = useMemo(
    () => [...new Set(orders.map((o) => o.salesman).filter(Boolean))].sort(),
    [orders],
  )

  // D-ASM-27: flagged lines of the SOs in the queue, per filter → { [filter]: { lines, soIds } }.
  const signalSets = useMemo(() => {
    const open = new Set(orders.map((o) => o.fb_so_id))
    const out = {}
    for (const [key, f] of Object.entries(SIGNAL_FILTERS)) {
      const lines = flagged.filter((l) => open.has(l.fb_so_id) && f.match(l))
      out[key] = { lines, soIds: new Set(lines.map((l) => l.fb_so_id)) }
    }
    return out
  }, [orders, flagged])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return orders.filter((o) => {
      // A signal filter looks across every open SO: a flagged line has usually left Pending already (Assembly and
      // Purchasing flags set the disposition), so the Queue tab's pending rule would hide it.
      if (signalFilter) {
        if (!signalSets[signalFilter]?.soIds.has(o.fb_so_id)) return false
      } else if (tab === 'queue' && !(o.pending_lines > 0)) return false
      if (salesmanFilter !== 'all' && o.salesman !== salesmanFilter) return false
      if (!q) return true
      return [o.so_number, o.customer_name, o.customer_po, o.linked_co_number, o.salesman, partIndex[o.fb_so_id]]
        .some((v) => v && String(v).toLowerCase().includes(q))
    })
  }, [orders, tab, salesmanFilter, search, partIndex, signalFilter, signalSets])

  const highlight = signalFilter ? SIGNAL_FILTERS[signalFilter].match : null

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
        <button onClick={() => setTab('stock_requests')} className={tabClass('stock_requests')}>
          Stock Requests <span className="ml-1 text-xs text-gray-500">({stockOpen === null ? '…' : stockOpen} open)</span>
        </button>
        {FEATURES.ASSEMBLY_BOARD && (
          <button onClick={() => setTab('post')} className={tabClass('post')}>
            Ready to post <span className={`ml-1 text-xs ${postCount ? 'text-blue-300' : 'text-gray-500'}`}>{postCount === null ? '…' : postCount}</span>
          </button>
        )}
        <span className="ml-auto text-xs text-gray-600 pr-2">{pendingLines.toLocaleString()} pending line{pendingLines === 1 ? '' : 's'}</span>
      </div>

      {/* Toolbar: the filters on the list tabs; New Stock Request (admin / assembly) on the Stock Requests tab only (S17 B2c). */}
      {(listTab || (canRaiseStock && tab === 'stock_requests')) && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
          {listTab && (
            <>
              <div className="relative flex-1 min-w-[240px] max-w-md">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="SO #, customer, PO, CO #, part #"
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
            </>
          )}
          {canRaiseStock && tab === 'stock_requests' && (
            <button
              onClick={() => setShowStockModal(true)}
              className="flex items-center gap-2 px-3 py-2 bg-amber-600 hover:bg-amber-500 text-white text-sm rounded transition-colors"
            >
              <Plus size={14} /> New Stock Request
            </button>
          )}
          {listTab && (
            <>
              {/* D-ASM-27: Ashley's pick flags. Needs CO lines still go through Create CO. */}
              <div className="flex items-center gap-1">
                {Object.entries(SIGNAL_FILTERS).map(([key, f]) => {
                  const n = signalSets[key]?.lines.length || 0
                  const on = signalFilter === key
                  return (
                    <button
                      key={key}
                      onClick={() => setSignalFilter(on ? null : key)}
                      title={on ? 'Show every order again' : `Only orders with a line flagged in Fishbowl: ${f.label}`}
                      className={`px-3 py-1.5 rounded text-xs border transition-colors ${on ? 'text-white border-transparent' : 'bg-gray-800 border-gray-700 text-gray-300 hover:text-white'}`}
                      style={on ? { backgroundColor: '#B8222E' } : undefined}
                    >
                      {f.label} ({n})
                    </button>
                  )
                })}
              </div>
              <span className="text-xs text-gray-600">
                Due: <span className="text-amber-400">*</span> no real date entered in Fishbowl · <span className="text-cyan-400">R</span> Remaining Parts Ship Date · Avail: Fishbowl stock available to ship · Prod Due: last component off the machine (<span className="text-gray-500">T</span> = SkyNet target until scheduled; assembly, plating and finishing not included)
              </span>
            </>
          )}
        </div>
      )}

      {tab === 'stock_requests' && (
        <StockRequestsView
          profile={profile}
          setActionStatus={setActionStatus}
          refreshKey={stockRefreshKey}
          onNavigateToWO={handleNavigateToWO}
          onLoaded={handleStockLoaded}
        />
      )}

      {FEATURES.ASSEMBLY_BOARD && tab === 'post' && <PostCards profile={profile} onCount={setPostCount} />}

      {tab === 'exceptions' && (
        <ExceptionsTab events={exceptions} loading={exceptionsLoading} canAct={canAct} ackingId={ackingId} onAck={handleAck} onOpenCO={openCO}
          resolvingId={resolvingId} onResolve={handleResolve} />
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
            {signalFilter ? `No open order has a line ${SIGNAL_FILTERS[signalFilter].label.toLowerCase()}.`
              : tab === 'queue' ? 'Nothing pending — every open order line has a disposition.' : 'No open Fishbowl orders match.'}
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
                lineDetail={lineDetail}
                purchaseComps={purchaseComps}
                expandedLines={expandedLines}
                onToggleLineDetail={toggleLineDetail}
                highlight={highlight}
              />
            ))}
          </div>
        )
      )}

      {showStockModal && (
        <StockRequestModal
          isOpen={showStockModal}
          onClose={() => setShowStockModal(false)}
          onSuccess={() => {
            setActionStatus({ type: 'success', message: 'Stock request submitted.' })
            setStockRefreshKey((k) => k + 1)
            loadStockCount()
          }}
          profile={profile}
        />
      )}

      {purchaseTarget && (
        <PurchaseComponentsModal
          order={purchaseTarget.order}
          lines={purchaseTarget.askLines}
          busy={busySo === purchaseTarget.order.fb_so_id}
          error={purchaseError}
          onClose={() => { setPurchaseTarget(null); setPurchaseError(null) }}
          onConfirm={(components) => handleBulkDisposition(purchaseTarget.order, 'purchased', components)}
        />
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
