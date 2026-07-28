import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { X, Loader2, AlertTriangle, ChevronDown, ChevronUp, History } from 'lucide-react'

/**
 * Manual CO line fulfillment adjustment (D-COFUL-01).
 *
 * All behavior lives in the adjust_co_line_fulfillment RPC — this component
 * only collects the new value + reason, calls it, and renders the audit trail.
 * Bounds, role gating, status flips, the event row, the salesperson
 * notification and the audit log are the RPC's job, not ours.
 *
 * Shared by two surfaces: the WO Lookup CO Fulfillment table (Mainframe) and
 * the Customer Orders line table. Do not fork it.
 */

// co_fulfillment_adjustments was migrated straight into Supabase, so its exact
// column names aren't in the repo (no migration file, and the schema dump
// predates it). The history panel therefore selects * and resolves each
// concept by trying the plausible names in order, instead of hard-coding one
// spelling and 400-ing if the migration chose another.
const LINE_FK_CANDIDATES = ['customer_order_line_id', 'line_id']
const OLD_KEYS = ['old_fulfilled', 'old_quantity_fulfilled', 'previous_fulfilled', 'quantity_fulfilled_old', 'old_value']
const NEW_KEYS = ['new_fulfilled', 'new_quantity_fulfilled', 'quantity_fulfilled_new', 'new_value', 'quantity_fulfilled']
const WHEN_KEYS = ['adjusted_at', 'created_at']
const WHO_KEYS = ['adjusted_by', 'created_by', 'user_id']

function pick(row, keys) {
  for (const k of keys) {
    if (row && row[k] !== undefined && row[k] !== null) return row[k]
  }
  return null
}

function formatWhen(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

export default function FulfillmentAdjustModal({ line, isOpen, onClose, onSuccess }) {
  const [newFulfilled, setNewFulfilled] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState(null)

  const ordered = Number(line?.quantity_ordered) || 0
  const current = Number(line?.quantity_fulfilled) || 0

  // Reset whenever the modal is (re)opened against a different line.
  useEffect(() => {
    if (!isOpen) return
    setNewFulfilled(String(current))
    setReason('')
    setError(null)
    setSubmitting(false)
    setHistoryOpen(false)
    setHistory([])
    setHistoryError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, line?.id])

  const loadHistory = useCallback(async () => {
    if (!line?.id) return
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      let rows = null
      let lastErr = null
      for (const fk of LINE_FK_CANDIDATES) {
        const { data, error: qErr } = await supabase
          .from('co_fulfillment_adjustments')
          .select('*')
          .eq(fk, line.id)
          .order('adjusted_at', { ascending: false })
        if (!qErr) { rows = data || []; break }
        lastErr = qErr
      }
      if (rows === null) throw lastErr || new Error('Could not read adjustment history')

      // Adjuster names resolved in a second query rather than a PostgREST
      // embed — the embed would need the FK constraint name, which is the one
      // thing we can't infer.
      const ids = [...new Set(rows.map(r => pick(r, WHO_KEYS)).filter(Boolean))]
      const nameById = {}
      if (ids.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', ids)
        for (const p of profs || []) nameById[p.id] = p.full_name
      }
      setHistory(rows.map(r => ({ raw: r, adjusterName: nameById[pick(r, WHO_KEYS)] || null })))
    } catch (err) {
      console.error('Failed to load adjustment history:', err)
      setHistoryError(err.message || String(err))
    } finally {
      setHistoryLoading(false)
    }
  }, [line?.id])

  const toggleHistory = () => {
    const next = !historyOpen
    setHistoryOpen(next)
    if (next && history.length === 0 && !historyLoading) loadHistory()
  }

  if (!isOpen || !line) return null

  const parsed = newFulfilled === '' ? NaN : Number(newFulfilled)
  const isValidNumber = Number.isFinite(parsed) && Number.isInteger(parsed)
  let fieldError = null
  if (newFulfilled !== '' && !isValidNumber) fieldError = 'Whole numbers only'
  else if (isValidNumber && parsed < 0) fieldError = 'Must be ≥ 0'
  else if (isValidNumber && parsed > ordered) fieldError = `Cannot exceed ordered (${ordered})`

  const unchanged = isValidNumber && parsed === current
  const isDecrease = isValidNumber && !fieldError && parsed < current
  const reasonValid = reason.trim().length > 0
  const canSave = !submitting && isValidNumber && !fieldError && !unchanged && reasonValid

  const handleSave = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const { data, error: rpcErr } = await supabase.rpc('adjust_co_line_fulfillment', {
        p_line_id: line.id,
        p_new_fulfilled: parsed,
        p_reason: reason.trim(),
      })
      // RPC errors surface verbatim — the RPC owns the rules, so its message
      // is the accurate explanation of what was refused.
      if (rpcErr) throw rpcErr
      onSuccess?.(data)
    } catch (err) {
      console.error('Fulfillment adjust failed:', err)
      setError(err.message || 'Adjustment failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-2xl my-8 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-800 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">
              Adjust Fulfillment — Line #{line.line_number}
            </h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {line.part_number && (
                <span className="text-gray-300 font-mono">{line.part_number}</span>
              )}
              {line.part_number && line.customer && <span className="mx-2 text-gray-600">·</span>}
              {line.customer && <span>{line.customer}</span>}
            </p>
            <p className="text-xs text-gray-400 mt-1">
              Ordered: <span className="text-gray-200">{ordered}</span>
              <span className="mx-2 text-gray-600">|</span>
              Currently fulfilled: <span className="text-gray-200">{current}</span>
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {/* New fulfilled */}
          <section>
            <label className="block text-sm font-semibold text-white mb-1">
              New fulfilled quantity
            </label>
            <p className="text-xs text-gray-500 mb-2">
              Must be between 0 and the ordered quantity ({ordered}).
            </p>
            <input
              type="number"
              min="0"
              max={ordered}
              step="1"
              value={newFulfilled}
              onChange={(e) => setNewFulfilled(e.target.value)}
              disabled={submitting}
              className={`w-32 px-3 py-2 bg-gray-800 border rounded text-white text-sm focus:outline-none disabled:opacity-50 ${
                fieldError ? 'border-red-600 focus:border-red-500' : 'border-gray-700 focus:border-skynet-accent'
              }`}
            />
            {fieldError && (
              <p className="text-xs text-red-400 mt-1">{fieldError}</p>
            )}
            {unchanged && !fieldError && (
              <p className="text-xs text-gray-500 mt-1">
                Same as the current value — nothing to adjust.
              </p>
            )}
            {isDecrease && (
              <div className="mt-2 text-xs text-amber-300 bg-amber-950/30 border border-amber-800/60 rounded p-2 flex items-start gap-2">
                <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
                <span>Line will reopen and count as remaining demand.</span>
              </div>
            )}
          </section>

          {/* Reason */}
          <section>
            <label className="block text-sm font-semibold text-white mb-1">
              Reason <span className="text-red-400 text-xs font-normal">Required.</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
              rows={3}
              placeholder="Why is the fulfilled quantity changing?"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-skynet-accent focus:outline-none resize-none disabled:opacity-50"
            />
          </section>

          {/* Adjustment history */}
          <section>
            <button
              onClick={toggleHistory}
              className="text-sm text-gray-300 hover:text-white flex items-center gap-2"
              aria-expanded={historyOpen}
            >
              <History size={14} className="text-gray-500" />
              Adjustment history
              {historyOpen
                ? <ChevronUp size={14} className="text-gray-500" />
                : <ChevronDown size={14} className="text-gray-500" />}
            </button>
            {historyOpen && (
              <div className="mt-2">
                {historyLoading ? (
                  <div className="text-xs text-gray-500 flex items-center gap-2 p-3 bg-gray-900/40 border border-gray-800 rounded">
                    <Loader2 size={12} className="animate-spin" /> Loading history…
                  </div>
                ) : historyError ? (
                  <div className="text-xs text-red-300 bg-red-950/40 border border-red-800 rounded p-3">
                    {historyError}
                  </div>
                ) : history.length === 0 ? (
                  <div className="text-xs text-gray-500 p-3 bg-gray-900/40 border border-gray-800 rounded">
                    No manual adjustments on this line yet.
                  </div>
                ) : (
                  <div className="border border-gray-800 rounded divide-y divide-gray-800">
                    {history.map((h, idx) => {
                      const oldVal = pick(h.raw, OLD_KEYS)
                      const newVal = pick(h.raw, NEW_KEYS)
                      return (
                        <div key={h.raw.id || idx} className="px-3 py-2 text-xs">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-gray-200">
                              {oldVal ?? '—'} <span className="text-gray-500">→</span>{' '}
                              <span className={Number(newVal) < Number(oldVal) ? 'text-amber-300' : 'text-green-300'}>
                                {newVal ?? '—'}
                              </span>
                            </span>
                            <span className="text-gray-600">·</span>
                            <span className="text-gray-400">{h.adjusterName || 'Unknown user'}</span>
                            <span className="text-gray-600">·</span>
                            <span className="text-gray-500">{formatWhen(pick(h.raw, WHEN_KEYS))}</span>
                          </div>
                          {h.raw.reason && (
                            <div className="text-gray-400 mt-0.5 whitespace-pre-wrap">{h.raw.reason}</div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </section>

          {error && (
            <div className="bg-red-950/40 border border-red-800 text-red-300 text-xs rounded p-3 flex items-start gap-2">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              <span className="whitespace-pre-wrap">{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-800 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm text-gray-400 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="px-4 py-1.5 text-sm bg-skynet-accent hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded flex items-center gap-2"
          >
            {submitting && <Loader2 size={12} className="animate-spin" />}
            Save Adjustment
          </button>
        </div>
      </div>
    </div>
  )
}
