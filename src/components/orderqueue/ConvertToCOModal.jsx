import { useMemo, useState } from 'react'
import { X, Loader2, AlertTriangle } from 'lucide-react'
import { formatCONumber } from '../../lib/customerOrders'
import {
  FB_PRIORITY, convertBlocker, coQtyForLine, convertToCO, displayPartNumber, formatDateShort, isSuspectDate,
} from '../../lib/fishbowl'

const PRIORITY_FROM_FB = { 10: 'critical', 20: 'high', 30: 'normal', 40: 'low', 50: 'low' }

// ConvertToCOModal — D-FB-12. Shows exactly what fb_convert_to_co will do, then does it.
// quantity_ordered on the new CO line = Fishbowl qtyToFulfill (what SkyNet must produce).
export default function ConvertToCOModal({ order, lines, onClose, onConverted }) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

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

  const targetCO = order.linked_co_number || formatCONumber(order.fb_customer_id, order.so_number)
  const priority = PRIORITY_FROM_FB[order.priority_id] || 'normal'
  const totalQty = convertible.reduce((s, l) => s + coQtyForLine(l), 0)

  const handleConfirm = async () => {
    if (convertible.length === 0) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await convertToCO(order.fb_so_id, convertible.map((l) => l.fb_soitem_id))
      onConverted?.(result)
    } catch (e) {
      setError(e?.message || String(e))
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col">
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
          <div className="grid grid-cols-3 gap-3 text-sm">
            <div className="bg-gray-800 rounded p-3">
              <div className="text-gray-500 text-xs">Target CO</div>
              <div className="font-mono text-purple-300">{targetCO || '—'}</div>
              <div className="text-gray-600 text-xs mt-0.5">{order.linked_co_number ? 'existing — lines appended' : 'new'}</div>
            </div>
            <div className="bg-gray-800 rounded p-3">
              <div className="text-gray-500 text-xs">Priority</div>
              <div className="text-gray-200 capitalize">{priority}</div>
              <div className="text-gray-600 text-xs mt-0.5">from Fishbowl {FB_PRIORITY[order.priority_id] || 'Normal'}</div>
            </div>
            <div className="bg-gray-800 rounded p-3">
              <div className="text-gray-500 text-xs">Lines · pieces</div>
              <div className="text-gray-200 font-mono">{convertible.length} · {totalQty.toLocaleString()}</div>
              <div className="text-gray-600 text-xs mt-0.5">qty = Fishbowl "to fulfill"</div>
            </div>
          </div>

          {convertible.length > 0 && (
            <div className="bg-gray-950/40 rounded border border-gray-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">FB line</th>
                    <th className="px-3 py-2 text-left">Part</th>
                    <th className="px-3 py-2 text-right">Ordered</th>
                    <th className="px-3 py-2 text-right">To fulfill → CO qty</th>
                    <th className="px-3 py-2 text-left">Due</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {convertible.map((l) => (
                    <tr key={l.fb_soitem_id}>
                      <td className="px-3 py-2 font-mono text-xs text-gray-400">#{l.line_number}</td>
                      <td className="px-3 py-2 font-mono text-gray-200">{displayPartNumber(l)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400">{Number(l.qty_ordered).toLocaleString()}</td>
                      <td className="px-3 py-2 text-right font-mono text-purple-300">{coQtyForLine(l).toLocaleString()}</td>
                      <td className={`px-3 py-2 font-mono text-xs ${isSuspectDate(l.effective_due_date) ? 'text-red-300' : 'text-gray-300'}`}>
                        {formatDateShort(l.effective_due_date)}
                        {l.due_date_is_default && <span className="ml-1 text-amber-400" title="No real date entered in Fishbowl">*</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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

        <div className="px-6 py-4 border-t border-gray-800 flex justify-end gap-2 flex-shrink-0 bg-gray-900">
          <button type="button" onClick={onClose} disabled={submitting} className="px-4 py-2 text-gray-400 hover:text-white">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting || convertible.length === 0}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded disabled:opacity-50 flex items-center gap-2"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {submitting ? 'Creating...' : `Create ${convertible.length} CO line${convertible.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
