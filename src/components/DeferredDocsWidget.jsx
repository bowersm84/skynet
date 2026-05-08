import { useEffect, useState } from 'react'
import { FileWarning } from 'lucide-react'
import { supabase } from '../lib/supabase'

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// Lists active jobs flagged documents_deferred = true. Self-hides when empty.
// Refetches whenever the parent's `refreshKey` changes (typically the same
// counter that drives ComplianceReview's `onUpdate`).
export default function DeferredDocsWidget({ refreshKey, onNavigateToWO }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const { data, error } = await supabase
        .from('jobs')
        .select(`
          id, job_number, status, documents_deferred_reason, documents_deferred_at,
          deferred_by:profiles!documents_deferred_by ( full_name ),
          component:parts!component_id ( part_number ),
          work_order:work_orders!work_order_id ( wo_number )
        `)
        .eq('documents_deferred', true)
        .not('status', 'in', '(cancelled,complete)')
        .order('documents_deferred_at', { ascending: true })
      if (cancelled) return
      if (error) {
        console.error('DeferredDocsWidget load failed:', error)
        setRows([])
      } else {
        setRows(data || [])
      }
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [refreshKey])

  if (loading) return null
  if (rows.length === 0) return null

  return (
    <div className="bg-gray-900 rounded-lg border border-yellow-800/60 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold flex items-center gap-2 text-yellow-300">
          <FileWarning size={18} />
          Jobs awaiting deferred documentation ({rows.length})
        </h3>
      </div>
      <div className="divide-y divide-gray-800 border border-gray-800 rounded">
        {rows.map(j => {
          const woNumber = j.work_order?.wo_number
          const clickable = !!woNumber && !!onNavigateToWO
          return (
            <button
              key={j.id}
              onClick={clickable ? () => onNavigateToWO(woNumber) : undefined}
              disabled={!clickable}
              className={`w-full flex items-center gap-3 px-3 py-2 text-left text-xs ${
                clickable ? 'hover:bg-gray-800 cursor-pointer' : 'cursor-default'
              }`}
            >
              <span className="text-skynet-accent font-mono w-28 shrink-0">{woNumber || '—'}</span>
              <span className="text-white font-mono w-24 shrink-0">{j.job_number}</span>
              <span className="text-gray-300 w-32 shrink-0 truncate">{j.component?.part_number || '—'}</span>
              <span className="text-gray-400 w-32 shrink-0 truncate">{j.deferred_by?.full_name || '—'}</span>
              <span className="text-gray-500 w-24 shrink-0">{formatDate(j.documents_deferred_at)}</span>
              <span className="text-gray-400 flex-1 truncate" title={j.documents_deferred_reason || ''}>
                {j.documents_deferred_reason || '—'}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
