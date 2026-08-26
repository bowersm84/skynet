import { AlertTriangle, ExternalLink, Loader2, Check } from 'lucide-react'
import { EVENT_LABELS, EVENT_COLORS, formatDateTime, summarizeChanges } from '../../lib/fishbowl'

// ExceptionsTab — D-FB-15. Fishbowl changes that touch a converted CO line and cannot be applied
// automatically: line removed, line voided/cancelled, SO voided/cancelled/expired, quantity cut
// below what is already allocated. Each is acknowledged here after the CO is fixed by hand.
export default function ExceptionsTab({ events, loading, canAct, ackingId, onAck, onOpenCO }) {
  if (loading && events.length === 0) {
    return (
      <div className="text-center py-12 bg-gray-900 rounded-lg border border-gray-800 text-gray-400 flex items-center justify-center gap-2">
        <Loader2 size={16} className="animate-spin" /> Loading exceptions...
      </div>
    )
  }
  if (events.length === 0) {
    return (
      <div className="text-center py-12 bg-gray-900 rounded-lg border border-gray-800 text-gray-500">
        No open exceptions — every Fishbowl change on a converted line has been applied or acknowledged.
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {events.map((e) => (
        <div key={e.id} className="bg-gray-900 rounded-lg border border-red-900/60 px-4 py-3 flex flex-wrap items-center gap-3">
          <AlertTriangle size={16} className="text-red-400 flex-shrink-0" />
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs border whitespace-nowrap ${EVENT_COLORS[e.event_type] || EVENT_COLORS.so_changed}`}>
            {EVENT_LABELS[e.event_type] || e.event_type}
          </span>
          <span className="font-mono text-white text-sm">SO {e.so_number}</span>
          {e.line_number && <span className="font-mono text-xs text-gray-400">line {e.line_number} · {e.part_num || e.product_num}</span>}
          <span className="text-gray-200 text-sm truncate" title={e.customer_name}>{e.customer_name}</span>
          <span className="text-xs text-gray-400 flex-1 min-w-[200px]">{summarizeChanges(e.changes, e.event_type)}</span>
          {e.co_number && (
            <span
              role="link"
              onClick={() => onOpenCO?.(e.co_number)}
              className="font-mono text-xs text-purple-300 hover:text-purple-200 inline-flex items-center gap-1"
              title={e.co_line_number ? `CO line ${e.co_line_number} · ${e.co_line_status}` : 'Open in Customer Orders'}
            >
              {e.co_number}{e.co_line_number ? ` #${e.co_line_number}` : ''} <ExternalLink size={11} />
            </span>
          )}
          <span className="text-xs text-gray-600 whitespace-nowrap">
            {formatDateTime(e.fb_timestamp || e.created_at)}{e.changed_by ? ` · ${e.changed_by}` : ''}
          </span>
          {canAct && (
            <button
              onClick={() => onAck(e.id)}
              disabled={ackingId === e.id}
              className="px-3 py-1.5 rounded text-xs bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-50 inline-flex items-center gap-1"
              title="Acknowledge: the CO has been reviewed / corrected by hand"
            >
              {ackingId === e.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Acknowledge
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
