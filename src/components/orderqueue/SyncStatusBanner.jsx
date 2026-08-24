import { useEffect, useState } from 'react'
import { Activity, AlertTriangle } from 'lucide-react'
import { syncFreshness } from '../../lib/fishbowl'

// SyncStatusBanner — one line of truth about the Fishbowl bridge (fb_sync_state).
// Green: heartbeat < 2 min. Amber: 2–10 min. Red: > 10 min or a recorded error.
export default function SyncStatusBanner({ state, compact = false }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])

  const fresh = syncFreshness(state, now)
  const hasError = !!state?.last_error
  const level = hasError && fresh.level === 'ok' ? 'stale' : fresh.level

  const tone = {
    ok: 'bg-gray-900 border-gray-800 text-gray-400',
    stale: 'bg-amber-900/30 border-amber-800 text-amber-200',
    down: 'bg-red-900/30 border-red-800 text-red-200',
    unknown: 'bg-gray-900 border-gray-800 text-gray-500',
  }[level]
  const dot = {
    ok: 'bg-green-400',
    stale: 'bg-amber-400',
    down: 'bg-red-500',
    unknown: 'bg-gray-600',
  }[level]

  return (
    <div className={`${compact ? 'px-3 py-1.5' : 'px-4 py-2'} mb-4 rounded border text-xs flex items-center gap-3 ${tone}`}>
      <span className={`inline-block w-2 h-2 rounded-full ${dot} ${level === 'ok' ? 'animate-pulse' : ''}`} />
      <span className="font-medium">{fresh.label}</span>
      {state?.last_rev ? (
        <span className="text-gray-600 font-mono hidden md:inline">cursor {state.last_rev}</span>
      ) : null}
      {state?.bridge_version ? (
        <span className="text-gray-600 hidden md:inline">
          bridge v{state.bridge_version}{state.bridge_host ? ` on ${state.bridge_host}` : ''}
        </span>
      ) : null}
      {hasError && (
        <span className="flex items-center gap-1 ml-auto truncate" title={state.last_error}>
          <AlertTriangle size={12} /> {state.last_error}
        </span>
      )}
      {!hasError && level === 'ok' && !compact && (
        <span className="ml-auto flex items-center gap-1 text-gray-600"><Activity size={12} /> 20 s poll</span>
      )}
    </div>
  )
}
