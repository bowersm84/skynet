import { useState, useEffect, useMemo, useCallback } from 'react'
import { Plus, Search, ChevronRight, Loader2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { getAllOpenCOLines, getOpenStockRequestLines } from '../../lib/customerOrders'
import CreateWorkOrderModal from '../CreateWorkOrderModal'
import { formatDate, formatDateShort, PRIORITY_BADGE } from './format'

// ─────────────────────────────────────────────────────────────────────────────
// Demand view: aggregate open CO line demand by part_number so April can roll
// matching lines into a single WO. Selection is locked to one part at a time.
// Moved unchanged from Customer Orders to the Command page's Demand tab (S17 B2, D-ASM-33).

export default function DemandView({ profile, setActionStatus }) {
  // D-DEMAND-01: WO creation from demand uses the same grant as Mainframe's
  // New Work Order button (canEditSchedule, D-SCHED-11) — primary role only,
  // deliberately, so the two surfaces can never diverge. customer_service and
  // read-only roles keep the tab for demand visibility but cannot create.
  const canCreateWO = ['admin', 'scheduler'].includes(profile?.role)
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
      const [coLines, stockLines] = await Promise.all([
        getAllOpenCOLines(supabase),
        getOpenStockRequestLines(supabase),
      ])
      setLines([...coLines, ...stockLines])
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
          (l.co_number || '').toLowerCase().includes(q) ||
          (l.reason || '').toLowerCase().includes(q)
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
      const dueDates = partLines.map(l => l.fb_due_date || l.due_date).filter(Boolean).sort()
      // D-CODATE-01: the group's commitment is the earliest SkyNet target
      const targetDates = partLines.map(l => l.target_date).filter(Boolean).sort()
      // D-STKREQ-02: split the group's demand so the collapsed row can show how
      // much of it is warehouse stock rather than customer commitment.
      const stockLines = partLines.filter(l => l.is_stock_request)
      const stockDemand = stockLines.reduce((s, l) => s + l.remaining, 0)
      return {
        part_id: partId,
        part_number: partLines[0].part_number,
        part_description: partLines[0].part_description,
        part_is_active: partLines[0].part_is_active !== false,
        lines: partLines,
        total_demand: totalDemand,
        stock_demand: stockDemand,
        co_demand: totalDemand - stockDemand,
        has_stock: stockLines.length > 0,
        is_stock_only: stockLines.length === partLines.length,
        line_count: partLines.length,
        earliest_due: dueDates[0] || null,
        earliest_target: targetDates[0] || null,
      }
    })

    if (sortMode === 'due') {
      result.sort((a, b) => {
        if (a.earliest_target && b.earliest_target) {
          if (a.earliest_target !== b.earliest_target) return a.earliest_target < b.earliest_target ? -1 : 1
        } else if (a.earliest_target && !b.earliest_target) {
          return -1
        } else if (!a.earliest_target && b.earliest_target) {
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
    () => new Set(selectedLines.filter(l => !l.is_stock_request).map(l => l.customer_name)).size,
    [selectedLines]
  )
  const selectedStockQty = useMemo(
    () => selectedLines.filter(l => l.is_stock_request).reduce((s, l) => s + l.remaining, 0),
    [selectedLines]
  )
  // Memoized so the two arrays keep a stable identity: CreateWorkOrderModal's
  // demand-prefill effect depends on both, and a fresh array on every DemandView
  // render would re-run it and clobber April's in-modal quantity edits.
  const selectedCoLinesOnly = useMemo(
    () => selectedLines.filter(l => !l.is_stock_request),
    [selectedLines]
  )
  const selectedStockRequestsOnly = useMemo(
    () => selectedLines.filter(l => l.is_stock_request),
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
        No open demand. Customer order lines and warehouse stock requests will appear here once entered.
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
            placeholder="Search part #, description, customer, CO #, STOCK..."
            className="w-full pl-9 pr-3 py-2 bg-gray-900 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-purple-500"
          />
        </div>
        <button
          onClick={() => setSortMode(sortMode === 'demand' ? 'due' : 'demand')}
          className="px-3 py-1.5 text-xs rounded bg-gray-800 text-gray-300 hover:text-white border border-gray-700 transition-colors"
          title="Toggle sort order"
        >
          Sort: {sortMode === 'demand' ? 'Total demand ↓' : 'Earliest target ↑'}
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
                className={`bg-gray-900 border rounded-lg transition-shadow ${
                  isWarned
                    ? 'border-amber-600'
                    : isLockedOut
                      ? 'border-gray-800 opacity-60'
                      : group.has_stock
                        // D-STKREQ-02: warehouse demand in this group.
                        ? 'border-amber-700/60 shadow-[0_0_16px_-4px_rgba(245,158,11,0.45)]'
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
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono font-semibold text-purple-200 truncate">
                        {group.part_number}
                      </span>
                      {group.has_stock && (
                        <span
                          className="flex-shrink-0 text-[10px] px-1.5 py-0.5 bg-amber-900/50 text-amber-300 rounded border border-amber-700/50 font-semibold"
                          title={
                            group.is_stock_only
                              ? 'Warehouse stock request — no customer order behind this demand'
                              : `${group.co_demand.toLocaleString()} pcs customer demand + ${group.stock_demand.toLocaleString()} pcs warehouse stock request`
                          }
                        >
                          {group.is_stock_only
                            ? 'STOCK'
                            : `+${group.stock_demand.toLocaleString()} STOCK`}
                        </span>
                      )}
                      {group.part_is_active === false && (
                        <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 bg-amber-900/50 text-amber-300 rounded border border-amber-700/50">
                          Awaiting Activation
                        </span>
                      )}
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
                    <div className="text-xs whitespace-nowrap text-right">
                      <div className="text-gray-300" title="Earliest SkyNet target (later of entered + 45 business days and the Fishbowl due date)">
                        {group.earliest_target ? `target ${formatDate(group.earliest_target)}` : '—'}
                      </div>
                      <div className="text-[10px] text-gray-500" title="Earliest Fishbowl due date">
                        {group.earliest_due ? `FB ${formatDateShort(group.earliest_due)}` : ''}
                      </div>
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
                          <th className="px-3 py-2 text-left" title="Day the order was entered (Fishbowl SO creation for Fishbowl-sourced lines)">Entered</th>
                          <th className="px-3 py-2 text-right">Remaining</th>
                          <th className="px-3 py-2 text-left" title="SkyNet target: the later of entered + 45 business days and the Fishbowl due date">Target</th>
                          <th className="px-3 py-2 text-left" title="Fishbowl's live due date (* = Fishbowl default, no real date entered)">FB Due</th>
                          <th className="px-3 py-2 text-left">Priority</th>
                          <th className="px-3 py-2 text-left" title="Components production needs to make for this line (D-FB-42)">Components</th>
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
                                {line.is_stock_request ? (
                                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-amber-900/50 text-amber-300 border border-amber-700/50 font-sans font-semibold">
                                    STOCK
                                  </span>
                                ) : line.co_number}
                              </td>
                              <td className="px-3 py-2 text-gray-300">
                                {line.customer_name}
                                {line.is_stock_request && line.reason && (
                                  <div className="text-xs text-gray-500 mt-0.5 max-w-md whitespace-normal" title={line.reason}>
                                    {line.reason}
                                  </div>
                                )}
                              </td>
                              <td className="px-3 py-2 text-gray-500 text-xs">
                                {line.is_stock_request ? '—' : `#${line.line_number}`}
                              </td>
                              <td className="px-3 py-2 text-gray-400 text-xs" title={line.entered_source === 'fishbowl' ? 'Fishbowl SO creation date' : 'SkyNet line creation date'}>
                                {line.entered_on ? formatDate(line.entered_on) : (line.entry_date ? new Date(line.entry_date).toLocaleDateString() : '—')}
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-amber-300">
                                {line.remaining.toLocaleString()}
                              </td>
                              <td className="px-3 py-2 text-gray-200 text-xs font-medium">
                                {line.target_date ? formatDate(line.target_date) : '—'}
                              </td>
                              <td
                                className={`px-3 py-2 text-xs ${line.fb_due_date && line.target_date && line.fb_due_date < line.target_date ? 'text-amber-300' : 'text-gray-300'}`}
                                title={line.fb_due_date && line.target_date && line.fb_due_date < line.target_date ? 'Fishbowl due date is earlier than the SkyNet target' : undefined}
                              >
                                {(line.fb_due_date || line.due_date) ? formatDate(line.fb_due_date || line.due_date) : '—'}
                                {line.fb_due_is_default && <span className="text-amber-400 ml-0.5" title="No real date entered in Fishbowl">*</span>}
                              </td>
                              <td className="px-3 py-2">
                                <span className={`px-1.5 py-0.5 text-[10px] rounded capitalize ${priorityClass}`}>
                                  {line.priority}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-xs" title={line.components_needed || undefined}>
                                {(line.components || []).length > 0 ? (
                                  <span className="flex flex-wrap gap-1">
                                    {line.components.map(pn => (
                                      <span key={pn} className="font-mono text-green-200 px-1.5 py-0.5 rounded border border-green-900 bg-green-900/20">{pn}</span>
                                    ))}
                                  </span>
                                ) : line.components_needed ? (
                                  <span className="text-gray-400 truncate inline-block max-w-[220px] align-middle">{line.components_needed}</span>
                                ) : <span className="text-gray-600">—</span>}
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

      {selectedLineIds.size > 0 && (() => {
        const selectedGroupInactive = !!selectedPartId && !(groups.find(g => g.part_id === selectedPartId)?.part_is_active)
        return (
        <div className="fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-purple-500/40 px-6 py-3 flex items-center justify-between z-40 shadow-2xl">
          <div className="text-sm text-gray-300">
            <span className="text-purple-300 font-medium">{selectedLineIds.size}</span> line{selectedLineIds.size !== 1 ? 's' : ''} selected
            <span className="text-gray-600 mx-2">·</span>
            <span className="text-purple-300 font-medium">{selectedCustomerCount}</span> customer{selectedCustomerCount !== 1 ? 's' : ''}
            {selectedStockQty > 0 && (
              <>
                <span className="text-gray-600 mx-2">·</span>
                <span className="text-amber-300 font-medium font-mono">{selectedStockQty.toLocaleString()}</span> for stock
              </>
            )}
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
            {canCreateWO && (
              <button
                onClick={() => setShowCreateWO(true)}
                disabled={selectedGroupInactive}
                title={selectedGroupInactive ? 'Cannot create a work order for an inactive product. Activate the part in Armory first.' : undefined}
                className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Plus size={16} /> Create Work Order
              </button>
            )}
          </div>
        </div>
        )
      })()}

      {showCreateWO && canCreateWO && (
        <CreateWorkOrderModal
          isOpen={showCreateWO}
          onClose={() => setShowCreateWO(false)}
          onSuccess={handleCreateWOSuccess}
          profile={profile}
          preselectedPartId={selectedPartId}
          preselectedCoLines={selectedCoLinesOnly}
          preselectedStockRequests={selectedStockRequestsOnly}
        />
      )}
    </>
  )
}
