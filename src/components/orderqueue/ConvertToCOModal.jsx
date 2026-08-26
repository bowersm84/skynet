import { useEffect, useMemo, useState } from 'react'
import { X, Loader2, AlertTriangle } from 'lucide-react'
import { formatCONumber, CO_STATUS_LABELS } from '../../lib/customerOrders'
import {
  FB_PRIORITY, convertBlocker, convertToCO, displayPartNumber, formatDateShort, formatDateTime, groupLinesByPart,
  getCOSummary, isSuspectDate, coQtyForLine,
} from '../../lib/fishbowl'

const PRIORITY_FROM_FB = { 10: 'critical', 20: 'high', 30: 'normal', 40: 'low', 50: 'low' }
const OPEN_CO_LINE = ['not_started', 'in_progress']

// ConvertToCOModal — D-FB-12 / D-FB-26 / D-FB-27. One CO line per part; a part that already has an
// open line on the target CO is added to, not duplicated; Components Needed is mandatory for every
// NEW CO line and optional (appended) when adding to an existing one.
export default function ConvertToCOModal({ order, lines, onClose, onConverted }) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [components, setComponents] = useState({})      // { [part_id]: text }
  const [coSummary, setCoSummary] = useState(null)
  const [coLoading, setCoLoading] = useState(!!order.customer_order_id)

  useEffect(() => {
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

  // Per-part plan: new CO line, or add to the first open CO line for that part (mirrors the RPC).
  const groups = useMemo(() => {
    const openByPart = new Map()
    for (const cl of coSummary?.customer_order_lines || []) {
      if (!OPEN_CO_LINE.includes(cl.status)) continue
      if (!openByPart.has(cl.part_id) || cl.line_number < openByPart.get(cl.part_id).line_number) openByPart.set(cl.part_id, cl)
    }
    return groupLinesByPart(convertible).map((g) => ({ ...g, existing: openByPart.get(g.part_id) || null }))
  }, [convertible, coSummary])

  const targetCO = coSummary?.co_number || order.linked_co_number || formatCONumber(order.fb_customer_id, order.so_number)
  const isNewCO = !coSummary && !order.linked_co_number
  const priority = PRIORITY_FROM_FB[order.priority_id] || 'normal'
  const totalQty = groups.reduce((s, g) => s + g.qty, 0)
  const newLines = groups.filter((g) => !g.existing)
  const missingComponents = newLines.filter((g) => !(components[g.part_id] || '').trim())
  const canSubmit = groups.length > 0 && missingComponents.length === 0 && !submitting && !coLoading

  const handleConfirm = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const payload = {}
      for (const g of groups) {
        const text = (components[g.part_id] || '').trim()
        if (text) payload[g.part_id] = text
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
              <span className="font-mono text-gray-200">{groups.length}</span> CO line{groups.length === 1 ? '' : 's'} · <span className="font-mono text-gray-200">{totalQty.toLocaleString()}</span> pcs
            </div>
          </div>

          {/* Per-part plan */}
          {groups.length > 0 && (
            <div className="space-y-3">
              {groups.map((g) => {
                const missing = !g.existing && !(components[g.part_id] || '').trim()
                return (
                  <div key={g.key} className={`rounded border ${missing ? 'border-amber-800' : 'border-gray-800'} bg-gray-950/40`}>
                    <div className="px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                      <span className="font-mono text-gray-100">{g.part_number}</span>
                      <span className="font-mono text-purple-300">{g.qty.toLocaleString()} pcs</span>
                      <span className={`font-mono text-xs ${isSuspectDate(g.due) ? 'text-red-300' : 'text-gray-400'}`}>
                        due {formatDateShort(g.due)}{g.hasDefaultDate && <span className="text-amber-400" title="No real date entered in Fishbowl">*</span>}
                      </span>
                      <span className="text-xs text-gray-500">
                        from FB line{g.lines.length === 1 ? '' : 's'} {g.lines.map((l) => `#${l.line_number} (${coQtyForLine(l).toLocaleString()})`).join(', ')}
                      </span>
                      <span className={`ml-auto text-xs px-2 py-0.5 rounded border ${g.existing ? 'bg-gray-800 text-gray-300 border-gray-600' : 'bg-green-900/40 text-green-300 border-green-800'}`}>
                        {g.existing ? `adds to line #${g.existing.line_number} (${Number(g.existing.quantity_ordered).toLocaleString()} → ${(Number(g.existing.quantity_ordered) + g.qty).toLocaleString()})` : 'new CO line'}
                      </span>
                    </div>
                    <div className="px-3 pb-3">
                      <label className="block text-gray-500 text-xs mb-0.5">
                        Components Needed {g.existing ? <span className="text-gray-600">(optional — appended to the existing line)</span> : <span className="text-red-400">*</span>}
                      </label>
                      <input
                        value={components[g.part_id] || ''}
                        onChange={(e) => setComponents((prev) => ({ ...prev, [g.part_id]: e.target.value }))}
                        placeholder={g.existing ? (g.existing.components_needed ? `currently: ${g.existing.components_needed}` : 'add a note for this line') : 'what needs to be produced'}
                        className={`w-full px-3 py-2 bg-gray-800 border rounded text-white text-sm focus:outline-none focus:border-skynet-accent ${missing ? 'border-amber-700' : 'border-gray-700'}`}
                      />
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
          {missingComponents.length > 0 && groups.length > 0 && (
            <span className="text-xs text-amber-300">Components Needed is required for {missingComponents.length} new line{missingComponents.length === 1 ? '' : 's'}.</span>
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
              {submitting ? 'Creating...' : `Create ${newLines.length} · add to ${groups.length - newLines.length}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
