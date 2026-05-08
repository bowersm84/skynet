import { FileWarning } from 'lucide-react'

// Renders a "Docs Deferred" badge when the job has documents_deferred = true.
// Returns null otherwise so callers can drop this in unconditionally.
export default function DocsDeferredBadge({ job }) {
  if (!job?.documents_deferred) return null
  const reason = job.documents_deferred_reason || 'no reason recorded'
  return (
    <span
      className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-yellow-950/60 text-yellow-300 border border-yellow-700"
      title={`Documents deferred — ${reason}`}
    >
      <FileWarning size={10} /> Docs Deferred
    </span>
  )
}
