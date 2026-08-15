import { useState, useEffect } from 'react'
import { X, Layers, Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabase'

// D-JOBMERGE-15: explicit allocation for a combined run. Members get typed
// shares (0..ask); the host takes the remainder; set_merge_allocation
// restamps everything and reconciles shortfalls in both directions.
export default function MergeAllocationModal({ hostJobId, isOpen, onClose, onApplied }) {
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState(null)
  const [hostJob, setHostJob] = useState(null)
  const [members, setMembers] = useState([])
  const [totalGood, setTotalGood] = useState(0)
  const [shares, setShares] = useState({})

  useEffect(() => {
    if (!isOpen || !hostJobId) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const { data: hj, error: hErr } = await supabase
          .from('jobs')
          .select('id, job_number, quantity')
          .eq('id', hostJobId)
          .single()
        if (hErr) throw hErr
        if (!cancelled) setHostJob(hj)

        const { data: allocs, error: aErr } = await supabase
          .from('job_merge_allocations')
          .select('id, member_job_id, requested_qty, allocated_good, allocated_at')
          .eq('host_job_id', hostJobId)
          .eq('is_active', true)
        if (aErr) throw aErr
        const memberIds = (allocs || []).map(a => a.member_job_id)
        let memberJobs = []
        if (memberIds.length) {
          const { data: mj, error: mErr } = await supabase
            .from('jobs')
            .select('id, job_number, quantity, work_order:work_orders(wo_number, customer, due_date)')
            .in('id', memberIds)
          if (mErr) throw mErr
          memberJobs = mj || []
        }
        const { data: sends, error: sErr } = await supabase
          .from('finishing_sends')
          .select('quantity, verified_count, compliance_good_qty, compliance_bad_qty, compliance_status')
          .eq('job_id', hostJobId)
          .eq('compliance_status', 'approved')
        if (sErr) throw sErr
        const total = (sends || []).reduce((acc, s) => {
          if (s.compliance_good_qty != null) return acc + s.compliance_good_qty
          if (s.compliance_bad_qty != null) {
            const base = s.verified_count ?? s.quantity
            return acc + Math.max(0, base - s.compliance_bad_qty)
          }
          return acc + (s.verified_count ?? s.quantity ?? 0)
        }, 0)
        if (cancelled) return
        const rows = (allocs || []).map(a => {
          const mj = memberJobs.find(m => m.id === a.member_job_id) || {}
          return { ...a, job_number: mj.job_number, quantity: mj.quantity, work_order: mj.work_order }
        }).sort((a, b) => (a.job_number || '').localeCompare(b.job_number || ''))
        setMembers(rows)
        setTotalGood(total)
        const init = {}
        rows.forEach(r => {
          init[r.member_job_id] = r.allocated_good ?? Math.min(r.requested_qty || 0, total)
        })
        setShares(init)
      } catch (err) {
        if (!cancelled) setError(err.message || String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [isOpen, hostJobId])

  if (!isOpen) return null

  const memberSum = members.reduce((s, m) => s + (parseInt(shares[m.member_job_id], 10) || 0), 0)
  const hostShare = totalGood - memberSum
  const invalid = members.some(m => {
    const v = parseInt(shares[m.member_job_id], 10)
    return Number.isNaN(v) || v < 0 || v > (m.requested_qty || 0)
  }) || hostShare < 0

  const handleApply = async () => {
    setApplying(true)
    setError(null)
    try {
      const payload = members.map(m => ({
        job_id: m.member_job_id,
        qty: parseInt(shares[m.member_job_id], 10) || 0,
      }))
      const { data, error: rpcErr } = await supabase.rpc('set_merge_allocation', {
        p_host_job_id: hostJobId,
        p_shares: payload,
      })
      if (rpcErr) throw rpcErr
      onApplied?.(data)
      onClose()
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2 text-cyan-300 font-medium">
            <Layers size={18} />
            Allocation — {hostJob?.job_number || '…'}
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 text-gray-400 text-sm">
              <Loader2 size={16} className="animate-spin" /> Loading combined run…
            </div>
          ) : (
            <>
              <div className="text-sm text-gray-400">
                Distributable good pieces (compliance-approved):{' '}
                <span className="text-white font-medium">{totalGood.toLocaleString()}</span>
              </div>

              <div className="border border-gray-800 rounded-lg divide-y divide-gray-800">
                {members.map(m => (
                  <div key={m.member_job_id} className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white font-mono">{m.job_number}</div>
                      <div className="text-xs text-gray-500 truncate">
                        {m.work_order?.wo_number} · {m.work_order?.customer || '—'}
                        {m.work_order?.due_date ? ` · due ${new Date(m.work_order.due_date).toLocaleDateString()}` : ''}
                      </div>
                    </div>
                    <div className="text-xs text-gray-500">ask {m.requested_qty?.toLocaleString()}</div>
                    <input
                      type="number"
                      min={0}
                      max={m.requested_qty || 0}
                      value={shares[m.member_job_id] ?? ''}
                      onChange={e => setShares(s => ({ ...s, [m.member_job_id]: e.target.value }))}
                      className="w-28 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-sm text-right focus:border-cyan-500 focus:outline-none"
                    />
                  </div>
                ))}
                <div className="flex items-center gap-3 px-4 py-3 bg-gray-800/40">
                  <div className="flex-1 text-sm text-white font-mono">
                    {hostJob?.job_number} <span className="text-gray-500 text-xs">(host — takes the remainder)</span>
                  </div>
                  <div className="text-xs text-gray-500">own qty {hostJob?.quantity?.toLocaleString()}</div>
                  <div className={`w-28 text-right text-sm font-medium ${hostShare < 0 ? 'text-red-400' : 'text-white'}`}>
                    {hostShare.toLocaleString()}
                  </div>
                </div>
              </div>

              {hostShare < 0 && (
                <div className="text-xs text-red-400">Member shares exceed the distributable total.</div>
              )}
              {error && (
                <div className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded p-2">{error}</div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-800">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-300 hover:text-white">Cancel</button>
          <button
            onClick={handleApply}
            disabled={loading || applying || invalid || members.length === 0}
            className="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-white text-sm font-medium rounded"
          >
            {applying ? 'Applying…' : 'Apply Allocation'}
          </button>
        </div>
      </div>
    </div>
  )
}
