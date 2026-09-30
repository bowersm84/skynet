import { useEffect, useMemo, useState } from 'react'
import { X, Loader2, AlertTriangle } from 'lucide-react'
import { formatCONumber, CO_STATUS_LABELS } from '../../lib/customerOrders'
import {
  FB_PRIORITY, convertBlocker, convertToCO, displayPartNumber, formatDateShort, formatDateTime,
  groupLinesForConversion, getCOSummary, isSuspectDate, coQtyForLine,
} from '../../lib/fishbowl'
import { clearBomCache } from '../../lib/nestedAssembly'
import ComponentPicker from './ComponentPicker'

const PRIORITY_FROM_FB = { 10: 'critical', 20: 'high', 30: 'normal', 40: 'low', 50: 'low' }

// ConvertToCOModal — D-FB-42 / D-FB-43. One CO line per Fishbowl line (a release keeps its own
// quantity and due date; like parts are combined later, at Create WO, if the scheduler wants one
// run). Components Needed is a structured pick from the part's bill of materials, answered once per
// part and applied to every line of that part; at least one component is required. The free-text
// note is optional. Supersedes D-FB-26 (one line per part) and D-FB-27 (mandatory text).
export default function ConvertToCOModal({ order, lines, onClose, onConverted }) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [components, setComponents] = useState({})      // { [part_id]: Set(component uuid) }
  const [notes, setNotes] = useState({})                // { [part_id]: text }
  const [coSummary, setCoSummary] = useState(null)
  const [coLoading, setCoLoading] = useState(!!order.customer_order_id)

  useEffect(() => {
    clearBomCache()
    let cancelled = false
    if (!order.customer_order_id) { setCoLoading(false); return undefined }
    ;(async () => {
      try {
        const s = await getCOSummary(order.customer_order_id)
        if (!cancelled) setCoSummary(s)
      } catch (e) {
        console.error('CO summary load failed:', e)
      } finally {
        if (!cancelled) setCoLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [order.customer_order_id])

  const { convertible, blocked } = useMemo(() => {
    const convertible = []
    const blocked = []
    for (const l of lines) {
      const why = convertBlocker(l)
      if (why) blocked.push({ line: l, why })
      else convertible.push(l)
    }
    return { convertible, blocked }
  }, [lines])

  // One card per part; every Fishbowl line under it becomes its own CO line.
  const groups = useMemo(() => groupLinesForConversion(convertible), [convertible])

  const targetCO = coSummary?.co_number || order.linked_co_number || formatCONumber(order.fb_customer_id, order.so_number)
  const isNewCO = !coSummary && !order.linked_co_number
  const priority = PRIORITY_FROM_FB[order.priority_id] || 'normal'
  const totalQty = groups.reduce((s, g) => s + g.qty, 0)
  const newLineCount = convertible.length
  const missing = groups.filter((g) => !(components[g.part_id]?.size > 0))
  const canSubmit = groups.length > 0 && missing.length === 0 && !submitting && !coLoading

  const handleConfirm = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const payload = {}
      for (const g of groups) {
        payload[g.part_id] = {
          components: [...(components[g.part_id] || [])],
          note: (notes[g.part_id] || '').trim() || null,
        }
      }
      const result = await convertToCO(order.fb_so_id, convertible.map((l) => l.fb_soitem_id), payload)
      onConverted?.(result)
    } catch (e) {
      setError(e?.message || String(e))
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-white">Create Customer Order lines</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Fishbowl SO <span className="font-mono text-gray-300">{order.so_number}</span> · {order.customer_name}
              {order.customer_po ? <> · PO <span className="font-mono text-gray-300">{order.customer_po}</span></> : null}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white" disabled={submitting}>
            <X size={22} />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-6 space-y-4">
          {/* Target CO */}
          <div className="bg-gray-800 rounded p-3 text-sm flex flex-wrap items-center gap-x-6 gap-y-1">
            <div>
              <span className="text-gray-500 text-xs mr-2">Target CO</span>
              <span className="font-mono text-purple-300">{targetCO || '—'}</span>
            </div>
            {coLoading ? (
              <span className="text-gray-500 text-xs flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> loading CO…</span>
            ) : isNewCO ? (
              <span className="text-xs text-green-300">new CO will be created</span>
            ) : coSummary ? (
              <>
                <span className="text-xs text-gray-400">{CO_STATUS_LABELS?.[coSummary.status] || coSummary.status}</span>
                <span className="text-xs text-gray-400">{(coSummary.customer_order_lines || []).length} line{(coSummary.customer_order_lines || []).length === 1 ? '' : 's'} today</span>
                <span className="text-xs text-gray-500">created {formatDateTime(coSummary.created_at)}</span>
                {coSummary.po_number && <span className="text-xs text-gray-500 font-mono">PO {coSummary.po_number}</span>}
              </>
            ) : (
              <span className="text-xs text-gray-400">existing — lines appended</span>
            )}
            <div className="ml-auto text-xs text-gray-500">
              Priority <span className="text-gray-200 capitalize">{priority}</span> (Fishbowl {FB_PRIORITY[order.priority_id] || 'Normal'})
              <span className="mx-2">·</span>
              <span className="font-mono text-gray-200">{newLineCount}</span> CO line{newLineCount === 1 ? '' : 's'} · <span className="font-mono text-gray-200">{totalQty.toLocaleString()}</span> pcs
            </div>
          </div>

          {/* Per-part plan */}
          {groups.length > 0 && (
            <div className="space-y-3">
              {groups.map((g) => {
                const picked = components[g.part_id]?.size || 0
                return (
                  <div key={g.key} className={`rounded border ${picked === 0 ? 'border-amber-800' : 'border-gray-800'} bg-gray-950/40`}>
                    <div className="px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm border-b border-gray-800/80">
                      <span className="font-mono text-gray-100">{g.part_number}</span>
                      {g.part_type && <span className="text-[10px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-400 capitalize">{String(g.part_type).replace('_', ' ')}</span>}
                      <span className="font-mono text-purple-300">{g.qty.toLocaleString()} pcs</span>
                      <span className="text-xs text-gray-500">{g.lines.length} release{g.lines.length === 1 ? '' : 's'} → {g.lines.length} new CO line{g.lines.length === 1 ? '' : 's'}</span>
                    </div>
                    <div className="px-3 py-2 space-y-1">
                      {g.lines.map((l) => (
                        <div key={l.fb_soitem_id} className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs">
                          <span className="font-mono text-gray-400 w-16">FB line #{l.line_number}</span>
                          <span className="font-mono text-gray-200">{coQtyForLine(l).toLocaleString()} pcs</span>
                          <span className={`font-mono ${isSuspectDate(l.effective_due_date) ? 'text-red-300' : 'text-gray-400'}`}>
                            due {formatDateShort(l.effective_due_date)}{l.due_date_is_default && <span className="text-amber-400" title="No real date entered in Fishbowl">*</span>}
                          </span>
                          {l.customer_part_num && <span className="text-gray-500">cust {l.customer_part_num}</span>}
                          <span className="ml-auto px-2 py-0.5 rounded border bg-green-900/40 text-green-300 border-green-800" title="CO line numbers follow Fishbowl line numbers (D-FB-45)">→ CO line #{l.line_number}</span>
                        </div>
                      ))}
                    </div>
                    <div className="px-3 pb-3 space-y-2">
                      <ComponentPicker
                        partId={g.part_id}
                        partNumber={g.part_number}
                        partType={g.part_type}
                        mode="manufacture"
                        needQty={g.qty}
                        selected={components[g.part_id] || new Set()}
                        onChange={(next) => setComponents((prev) => ({ ...prev, [g.part_id]: next }))}
                      />
                      <div>
                        <label className="block text-gray-500 text-xs mb-0.5">Note <span className="text-gray-600">(optional — e.g. "we have the studs")</span></label>
                        <input
                          value={notes[g.part_id] || ''}
                          onChange={(e) => setNotes((prev) => ({ ...prev, [g.part_id]: e.target.value }))}
                          placeholder="anything production should know"
                          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-skynet-accent"
                        />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {blocked.length > 0 && (
            <div className="text-xs text-amber-200 bg-amber-900/20 border border-amber-900 rounded p-3">
              <div className="flex items-center gap-1 font-medium mb-1"><AlertTriangle size={13} /> Skipped</div>
              <ul className="space-y-0.5">
                {blocked.map(({ line, why }) => (
                  <li key={line.fb_soitem_id}>
                    <span className="font-mono">#{line.line_number} {displayPartNumber(line)}</span> — {why}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <div className="text-sm text-red-300 bg-red-900/30 border border-red-800 rounded p-3">{error}</div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-800 flex items-center gap-3 flex-shrink-0 bg-gray-900">
          {missing.length > 0 && groups.length > 0 && (
            <span className="text-xs text-amber-300">Pick at least one component for {missing.map((g) => g.part_number).join(', ')}.</span>
          )}
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={onClose} disabled={submitting} className="px-4 py-2 text-gray-400 hover:text-white">
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!canSubmit}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded disabled:opacity-50 flex items-center gap-2"
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              {submitting ? 'Creating...' : `Create ${newLineCount} CO line${newLineCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
