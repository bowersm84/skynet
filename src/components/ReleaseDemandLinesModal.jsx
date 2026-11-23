import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { X, Loader2 } from 'lucide-react'
import { releaseDemandLines } from '../lib/fbClosedLines'
import { hasRole } from '../lib/roles'

// D-FBCLOSE-01: take CO lines off Demand by hand (shipped from stock,
// cancelled, duplicate, other). Stock-request lines are not CO lines and are
// left alone. A partly allocated line releases its allocation and the work
// order keeps running as stock.

const REASONS = [
  { value: 'shipped_from_stock', label: 'Shipped from stock', hint: 'The order went out of finished stock. The line closes as complete.', shipOnly: true },
  { value: 'cancelled_by_customer', label: 'Cancelled by the customer', hint: 'The line closes as cancelled.' },
  { value: 'duplicate', label: 'Duplicate line', hint: 'The line closes as cancelled.' },
  { value: 'other', label: 'Other', hint: 'The line closes as cancelled. A note is required.' },
]

export default function ReleaseDemandLinesModal({ lines, profile, onClose, onDone, setActionStatus }) {
  const canShip = hasRole(profile, 'admin', 'scheduler')
  const coLines = useMemo(() => (lines || []).filter(l => !l.is_stock_request && l.line_id), [lines])
  const skippedStock = (lines || []).length - coLines.length
  const [reason, setReason] = useState(canShip ? 'shipped_from_stock' : 'cancelled_by_customer')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const noteRequired = reason === 'other'
  const canSubmit = coLines.length > 0 && !saving && (!noteRequired || note.trim().length > 0)

  const submit = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await releaseDemandLines(supabase, coLines.map(l => l.line_id), reason, note.trim() || null)
      const released = res?.released || []
      const closed = released.filter(r => !r.skipped)
      const skipped = released.filter(r => r.skipped)
      const converted = [...new Set(closed.flatMap(r => r.wo_converted_to_stock || []))]
      let msg = `${closed.length} line${closed.length !== 1 ? 's' : ''} released`
      if (converted.length) msg += ` — ${converted.join(', ')} now stock`
      if (skipped.length) msg += ` (${skipped.length} already closed)`
      setActionStatus?.({ type: 'success', message: msg + '.' })
      onDone?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-gray-700 bg-gray-900 shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h3 className="text-white font-semibold">Release from Demand</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div className="max-h-40 overflow-y-auto rounded border border-gray-800 divide-y divide-gray-800">
            {coLines.map(l => (
              <div key={l.line_id} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                <span className="font-mono text-purple-300">
                  {l.co_number} <span className="text-gray-500">#{l.line_number}</span>
                </span>
                <span className="font-mono text-gray-300">{l.part_number}</span>
                <span className="text-gray-400 truncate max-w-[160px]">{l.customer_name}</span>
                <span className="font-mono text-amber-300">{Number(l.remaining || 0).toLocaleString()}</span>
              </div>
            ))}
          </div>
          {skippedStock > 0 && (
            <p className="text-xs text-gray-500">
              {skippedStock} stock request line{skippedStock !== 1 ? 's are' : ' is'} not affected — cancel stock requests from Stock Requests.
            </p>
          )}
          <div className="space-y-2">
            {REASONS.filter(r => canShip || !r.shipOnly).map(r => (
              <label
                key={r.value}
                className={`block rounded border px-3 py-2 cursor-pointer ${reason === r.value ? 'border-purple-500 bg-purple-950/30' : 'border-gray-700 hover:border-gray-600'}`}
              >
                <span className="flex items-center gap-2 text-sm text-gray-200">
                  <input
                    type="radio"
                    name="release-reason"
                    value={r.value}
                    checked={reason === r.value}
                    onChange={() => setReason(r.value)}
                    className="accent-purple-500"
                  />
                  {r.label}
                </span>
                <span className="block text-xs text-gray-500 ml-6 mt-0.5">{r.hint}</span>
              </label>
            ))}
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Note{noteRequired ? ' (required)' : ' (optional)'}</label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded text-sm text-white focus:outline-none focus:border-purple-500"
            />
          </div>
          <p className="text-xs text-gray-500">
            If a line is partly allocated to a work order, the allocation is released and the work order keeps running as stock.
          </p>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-800">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            Release {coLines.length} line{coLines.length !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
