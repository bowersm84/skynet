import { useEffect, useState } from 'react'
import { Activity, AlertTriangle } from 'lucide-react'
import { syncFreshness } from '../../lib/fishbowl'
import { familyHealth, bannerFamilies, formatFamilyAge } from '../../lib/fishbowlHealth'

// SyncStatusBanner — one line of truth about the Fishbowl bridge (fb_sync_state).
// Green: heartbeat < 2 min. Amber: 2–10 min. Red: > 10 min or a recorded error.
// D-FB-63 (S17 A2): the full banner adds one age per bridge family from that family's own fb_sync_state stamp —
// SO · Picks · Ships · MOs · Tags · Postings · BOMs, plus any other family while it is in error. A family is in error
// only when its family_errors entry is newer than its stamp; it then reads amber with the message in the tooltip.
export default function SyncStatusBanner({ state, compact = false }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])

  const fresh = syncFreshness(state, now)
  const hasError = !!state?.last_error
  const level = hasError && fresh.level === 'ok' ? 'stale' : fresh.level
  const families = state && !compact ? bannerFamilies(familyHealth(state, now)) : []

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
    <div className={`${compact ? 'px-3 py-1.5' : 'px-4 py-2'} mb-4 rounded border text-xs ${tone}`}>
      <div className="flex items-center gap-3">
        <span className={`inline-block w-2 h-2 rounded-full ${dot} ${level === 'ok' ? 'animate-pulse' : ''}`} />
        <span className="font-medium">{fresh.label}</span>
        {compact && state?.last_rev ? (
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
      {families.length > 0 && (
        <div className="mt-1 pl-5 flex flex-wrap items-center gap-x-1 font-mono text-gray-500">
          {families.map((f, i) => (
            <span key={f.family} className="inline-flex items-center">
              {i > 0 && <span className="text-gray-700 mr-1">·</span>}
              <span
                className={f.error ? 'text-amber-300 inline-flex items-center gap-1' : ''}
                title={f.error
                  ? `${f.label}: ${f.error.message || 'error'}${f.error.at ? ` (${new Date(f.error.at).toLocaleString()})` : ''}`
                  : f.lastAt ? `${f.label} last ran ${new Date(f.lastAt).toLocaleString()}` : `${f.label} has not run yet`}
              >
                {f.error && <AlertTriangle size={11} />}{f.label} {formatFamilyAge(f.ageMs)}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
