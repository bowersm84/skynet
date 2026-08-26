import { Loader2, ExternalLink } from 'lucide-react'
import { EVENT_LABELS, EVENT_COLORS, formatDateTime, summarizeChanges, DISPOSITION_LABELS } from '../../lib/fishbowl'

// RecentChangesTab — the fb_sync_events feed: every Fishbowl create / change / removal the bridge saw,
// newest first, with who made it in Fishbowl (once the users poller has run) and what it touched in SkyNet.
export default function RecentChangesTab({ events, loading, onOpenCO }) {
  if (loading && events.length === 0) {
    return (
      <div className="text-center py-12 bg-gray-900 rounded-lg border border-gray-800 text-gray-400 flex items-center justify-center gap-2">
        <Loader2 size={16} className="animate-spin" /> Loading changes...
      </div>
    )
  }
  if (events.length === 0) {
    return <div className="text-center py-12 bg-gray-900 rounded-lg border border-gray-800 text-gray-500">No changes recorded yet.</div>
  }
  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-800/60 text-gray-400 text-xs uppercase">
          <tr>
            <th className="px-3 py-2 text-left">When</th>
            <th className="px-3 py-2 text-left">Event</th>
            <th className="px-3 py-2 text-left">SO</th>
            <th className="px-3 py-2 text-left">Line</th>
            <th className="px-3 py-2 text-left">What changed</th>
            <th className="px-3 py-2 text-left">By</th>
            <th className="px-3 py-2 text-left">SkyNet</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {events.map((e) => (
            <tr key={e.id} className={e.requires_ack && !e.acknowledged_at ? 'bg-red-900/10' : ''}>
              <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{formatDateTime(e.fb_timestamp || e.created_at)}</td>
              <td className="px-3 py-2">
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs border whitespace-nowrap ${EVENT_COLORS[e.event_type] || EVENT_COLORS.so_changed}`}>
                  {EVENT_LABELS[e.event_type] || e.event_type}
                </span>
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                <span className="font-mono text-gray-200">{e.so_number}</span>
                <span className="text-gray-500 text-xs ml-2 hidden xl:inline">{e.customer_name}</span>
              </td>
              <td className="px-3 py-2 font-mono text-xs text-gray-400 whitespace-nowrap">
                {e.line_number ? `#${e.line_number} ${e.part_num || e.product_num || ''}` : ''}
              </td>
              <td className="px-3 py-2 text-xs text-gray-300">{summarizeChanges(e.changes, e.event_type)}</td>
              <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{e.changed_by || (e.fb_modified_user_id ? `user ${e.fb_modified_user_id}` : '')}</td>
              <td className="px-3 py-2 text-xs whitespace-nowrap">
                {e.co_number ? (
                  <span role="link" onClick={() => onOpenCO?.(e.co_number)} className="font-mono text-purple-300 hover:text-purple-200 inline-flex items-center gap-1">
                    {e.co_number}{e.co_line_number ? ` #${e.co_line_number}` : ''} <ExternalLink size={10} />
                  </span>
                ) : e.disposition ? (
                  <span className="text-gray-500">{DISPOSITION_LABELS[e.disposition] || e.disposition}</span>
                ) : null}
                {e.requires_ack && !e.acknowledged_at && <span className="ml-2 text-red-300">needs review</span>}
                {e.requires_ack && e.acknowledged_at && <span className="ml-2 text-gray-600">acknowledged</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
