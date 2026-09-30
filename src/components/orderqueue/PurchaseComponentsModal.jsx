import { useEffect, useState } from 'react'
import { X, Loader2, ShoppingCart } from 'lucide-react'
import { coQtyForLine, displayPartNumber, formatDateShort } from '../../lib/fishbowl'
import { clearBomCache } from '../../lib/nestedAssembly'
import ComponentPicker from './ComponentPicker'

// PurchaseComponentsModal — D-FB-42. Opens when "Purchase" is chosen for a line whose SkyNet part
// may have a bill of materials (assembly or finished good). The order processor names which
// component(s) are being bought; the choice is saved with the disposition
// (fb_line_purchase_components) and shown in the line's detail panel. A part that turns out to
// have no BOM passes through with no list. Lines for manufactured / purchased parts never get here.
export default function PurchaseComponentsModal({ order, lines, busy, error, onClose, onConfirm }) {
  const [picked, setPicked] = useState({})   // { [fb_soitem_id]: Set(uuid) }
  const [hasBom, setHasBom] = useState({})   // { [fb_soitem_id]: boolean }
  useEffect(() => { clearBomCache() }, [])

  const needing = lines.filter((l) => hasBom[l.fb_soitem_id] !== false)
  const missing = needing.filter((l) => hasBom[l.fb_soitem_id] === true && !(picked[l.fb_soitem_id]?.size > 0))
  const pendingLoad = lines.some((l) => hasBom[l.fb_soitem_id] === undefined)
  const canSubmit = !busy && !pendingLoad && missing.length === 0

  const handleConfirm = () => {
    if (!canSubmit) return
    const payload = {}
    for (const l of lines) {
      if (hasBom[l.fb_soitem_id] && picked[l.fb_soitem_id]?.size > 0) payload[l.fb_soitem_id] = [...picked[l.fb_soitem_id]]
    }
    onConfirm?.(payload)
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-white flex items-center gap-2"><ShoppingCart size={18} className="text-blue-300" /> Purchase — which components?</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Fishbowl SO <span className="font-mono text-gray-300">{order.so_number}</span> · {order.customer_name} · these parts have a bill of materials, so say what is being bought
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white" disabled={busy}><X size={22} /></button>
        </div>

        <div className="overflow-y-auto flex-1 p-6 space-y-3">
          {lines.map((l) => (
            <div key={l.fb_soitem_id} className={`rounded border ${hasBom[l.fb_soitem_id] === true && !(picked[l.fb_soitem_id]?.size > 0) ? 'border-amber-800' : 'border-gray-800'} bg-gray-950/40`}>
              <div className="px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm border-b border-gray-800/80">
                <span className="font-mono text-gray-400">#{l.line_number}</span>
                <span className="font-mono text-gray-100">{displayPartNumber(l)}</span>
                <span className="font-mono text-blue-300">{coQtyForLine(l).toLocaleString()} pcs</span>
                <span className="font-mono text-xs text-gray-400">due {formatDateShort(l.effective_due_date)}</span>
              </div>
              <div className="px-3 py-2">
                <ComponentPicker
                  partId={l.part_id}
                  partNumber={displayPartNumber(l)}
                  partType={l.part?.part_type}
                  mode="purchase"
                  needQty={coQtyForLine(l)}
                  selected={picked[l.fb_soitem_id] || new Set()}
                  onChange={(next) => setPicked((prev) => ({ ...prev, [l.fb_soitem_id]: next }))}
                  onLoaded={({ hasBom: b }) => setHasBom((prev) => ({ ...prev, [l.fb_soitem_id]: b }))}
                />
              </div>
            </div>
          ))}
          {error && (
            <div className="text-sm text-red-300 bg-red-900/30 border border-red-800 rounded p-3">{error}</div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-800 flex items-center gap-3 flex-shrink-0 bg-gray-900">
          {missing.length > 0 && <span className="text-xs text-amber-300">Pick at least one component for {missing.map((l) => displayPartNumber(l)).join(', ')}.</span>}
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="px-4 py-2 text-gray-400 hover:text-white">Cancel</button>
            <button type="button" onClick={handleConfirm} disabled={!canSubmit}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50 flex items-center gap-2">
              {busy && <Loader2 size={14} className="animate-spin" />}
              Mark {lines.length} line{lines.length === 1 ? '' : 's'} Purchase
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
