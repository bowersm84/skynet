import { useState, useEffect } from 'react'
import { X, Loader2, Split, AlertTriangle } from 'lucide-react'
import { supabase } from '../lib/supabase'

export default function SplitJobModal({ isOpen, job, onClose, onSuccess }) {
  const [newJobQty, setNewJobQty] = useState(1)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  // Mirror getEffectiveQty's chain: qty_override (authoritative count) →
  // sum of non-rejected finishing batches → machinist's good_pieces.
  // Anything past the machine (in-flight or approved) counts as produced.
  function computeProduced(j) {
    if (!j) return 0
    if (j.qty_override != null) return j.qty_override
    const sends = j.finishing_sends || []
    const live = sends.filter(s =>
      s.compliance_status !== 'rejected' && s.status !== 'rejected'
    )
    if (live.length > 0) {
      return live.reduce((acc, s) => {
        if (s.compliance_good_qty != null) return acc + s.compliance_good_qty
        if (s.verified_count != null) return acc + s.verified_count
        return acc + (s.quantity || 0)
      }, 0)
    }
    return j.good_pieces || 0
  }

  const produced = computeProduced(job)
  const piecesLeftToMake = job
    ? Math.max(0, (job.quantity || 0) - produced)
    : 0

  // Re-initialize state when the modal opens or the job changes
  useEffect(() => {
    if (!isOpen || !job) return
    const left = Math.max(1, (job.quantity || 0) - computeProduced(job))
    setNewJobQty(Math.max(1, Math.ceil(left / 2)))
    setReason('')
    setError(null)
  }, [isOpen, job?.id])

  if (!isOpen || !job) return null

  const qty = job.quantity || 0
  const originalQtyAfter = qty - newJobQty
  const isValid =
    Number.isInteger(newJobQty) && newJobQty > 0 && newJobQty < piecesLeftToMake

  const handleSubmit = async () => {
    if (!isValid) return
    setSubmitting(true)
    setError(null)
    try {
      const { data, error: rpcErr } = await supabase.rpc('split_job', {
        p_job_id: job.id,
        p_new_job_quantity: newJobQty,
        p_reason: reason.trim() || null,
      })
      if (rpcErr) throw rpcErr
      onSuccess?.(data)
      onClose()
    } catch (err) {
      console.error('Split job failed:', err)
      setError(err.message || 'Split failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[70] p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Split size={18} className="text-skynet-accent" />
            Split Job
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white"
            disabled={submitting}
          >
            <X size={20} />
          </button>
        </div>

        {/* Job summary */}
        <div className="bg-gray-800/50 border border-gray-800 rounded-lg p-3 space-y-1 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-skynet-accent font-mono">{job.job_number}</span>
            <span className="text-gray-500">·</span>
            <span className="text-white font-mono">{job.component?.part_number || '—'}</span>
          </div>
          {job.component?.description && (
            <div className="text-xs text-gray-400">{job.component.description}</div>
          )}
          {job.work_order?.customer && (
            <div className="text-xs text-gray-500">{job.work_order.customer}</div>
          )}
        </div>

        {/* Current state */}
        <div className="space-y-1.5 text-sm">
          <div className="text-xs text-gray-500 uppercase tracking-wide font-medium">
            Current State
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Total quantity</span>
            <span className="text-white font-mono">{qty.toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">
              Produced{job.qty_override != null && <span className="text-amber-400 text-xs ml-1">(override)</span>}
            </span>
            <span className={`font-mono ${job.qty_override != null ? 'text-amber-300' : 'text-white'}`}>
              {produced.toLocaleString()}
            </span>
          </div>
          <div className="flex justify-between border-t border-gray-800 pt-1.5">
            <span className="text-gray-300 font-medium">Pieces left to make</span>
            <span className="text-white font-mono font-medium">{piecesLeftToMake.toLocaleString()}</span>
          </div>
        </div>

        {/* Split inputs */}
        <div className="space-y-3 border-t border-gray-800 pt-4">
          <div>
            <label className="text-xs text-gray-400 uppercase tracking-wide">
              Move to new job *
            </label>
            <input
              type="number"
              min="1"
              max={piecesLeftToMake - 1}
              value={newJobQty}
              onChange={e => setNewJobQty(parseInt(e.target.value, 10) || 0)}
              disabled={submitting}
              className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white font-mono focus:outline-none focus:border-skynet-accent"
            />
            <div className="text-xs text-gray-500 mt-1">
              Original keeps:{' '}
              <span className="text-white font-mono">
                {Math.max(0, originalQtyAfter).toLocaleString()}
              </span>
              {!isValid && newJobQty > 0 && (
                <span className="text-red-400 ml-2">
                  Must be between 1 and {(piecesLeftToMake - 1).toLocaleString()}
                </span>
              )}
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-400 uppercase tracking-wide">
              Reason (optional)
            </label>
            <input
              type="text"
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g., Parallel run on Mazak 6"
              disabled={submitting}
              className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-skynet-accent"
            />
          </div>
        </div>

        {/* Workflow callout */}
        <div className="bg-amber-900/20 border border-amber-800/50 rounded-lg p-3 text-xs text-amber-200 flex items-start gap-2">
          <AlertTriangle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <div>
            New job will be created in <span className="font-mono">pending_compliance</span>{' '}
            and appear in the scheduler's queue. It must be scheduled on a machine before
            Compliance can review its documents. Original job is unchanged except for the
            reduced quantity.
          </div>
        </div>

        {error && (
          <div className="border border-red-700/50 bg-red-900/20 rounded-lg p-3 text-sm text-red-200">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-gray-400 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !isValid}
            className="px-6 py-2 bg-skynet-accent hover:bg-skynet-accent/80 disabled:opacity-50 text-white font-medium rounded-lg flex items-center gap-2"
          >
            {submitting ? <Loader2 size={16} className="animate-spin" /> : <Split size={16} />}
            Split Job
          </button>
        </div>
      </div>
    </div>
  )
}
