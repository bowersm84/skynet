import { Clock } from 'lucide-react'
import { formatTsDateShort } from '../lib/fishbowl'

// D-FB-39 — one Fishbowl inventory reading, rendered inline.
// `summary` comes from summarizeFbInventory (lib/fishbowl.js), which is also what the
// Order Queue Avail cell reads, so the two surfaces cannot drift.
//
//   size 'full'     → the plain-English line ("874 on hand, all allocated · 6,426 short")
//   size 'compact'  → just the on-hand number, for BOM rows
//   openJobs        → { qty, jobs: [{ job_number, status }] }; full size only
//
// Native title tooltip, matching the Order Queue cell — this modal has no drag
// interactions, so there is nothing for a tooltip to fight with (D-SCHED-27a).
export default function FbInventoryChip({ summary, size = 'full', openJobs = null }) {
  if (!summary) return null

  const missing = summary.state === 'not_synced' || summary.state === 'not_in_fishbowl'
  const stale = summary.state === 'stale'
  const full = size !== 'compact'
  const body = full ? summary.text : summary.compactText
  const openQty = Number(openJobs?.qty || 0)

  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-xs whitespace-nowrap ${missing ? 'text-gray-600' : ''}`}
      title={summary.title}
    >
      <span className={missing ? '' : 'text-gray-500'}>FB</span>
      {stale && <Clock size={11} className="text-amber-400 flex-shrink-0" />}
      <span className={missing ? '' : summary.tone}>{body}</span>
      {stale && full && summary.asOf && (
        <span className="text-gray-500">as of {formatTsDateShort(summary.asOf)}</span>
      )}
      {full && openQty > 0 && (
        <>
          <span className="text-gray-600">·</span>
          <span className="text-sky-300/80">
            SkyNet {openQty.toLocaleString()} in open jobs
            {openJobs.jobs?.[0]?.job_number ? ` (${openJobs.jobs[0].job_number})` : ''}
          </span>
        </>
      )}
    </span>
  )
}
