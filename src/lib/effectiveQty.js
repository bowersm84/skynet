// src/lib/effectiveQty.js
//
// Single source of truth for a job's effective produced quantity.
// Precedence picks the highest-confidence SkyNet-tracked source, then ADDS any
// pre-system / missed-production entries on top. Missed entries are parts SkyNet
// never tracked (made before go-live, or otherwise off-system), so summing them
// alongside the tracked count is additive by construction and cannot double-count.
//
// Retired May 2026: the old qty_override "wins / freezes the count" branch.
// Carry-over pieces are now recorded as missed_production_entries rows.

export function sumMissedEntries(job) {
  return (job?.missed_production_entries || [])
    .reduce((acc, e) => acc + (e.quantity || 0), 0)
}

export function getEffectiveQty(job) {
  const missed = sumMissedEntries(job)

  // 1. Outsourcing returns — group by routing step, pick the latest step, sum its returns.
  if (job.outbound_sends?.length) {
    const completedReturns = job.outbound_sends.filter(s =>
      s.returned_at && s.quantity_returned != null
    )
    if (completedReturns.length > 0) {
      const byStep = {}
      for (const s of completedReturns) {
        const stepId = s.routing_step_id || s.job_routing_step_id || '_unknown_'
        if (!byStep[stepId]) byStep[stepId] = []
        byStep[stepId].push(s)
      }
      const groups = Object.keys(byStep).map(id => {
        const sends = byStep[id]
        const latestMs = Math.max(...sends.map(s => new Date(s.returned_at).getTime()))
        return { stepId: id, sends, latestMs }
      })
      groups.sort((a, b) => b.latestMs - a.latestMs)
      const sum = groups[0].sends.reduce((acc, s) => acc + (s.quantity_returned || 0), 0)
      return { qty: sum + missed, verified: true, hasMissed: missed > 0 }
    }
  }

  // 2. Compliance-approved finishing batches
  if (job.finishing_sends?.length) {
    const approvedBatches = job.finishing_sends.filter(s => s.compliance_status === 'approved')
    if (approvedBatches.length > 0) {
      const sum = approvedBatches.reduce((acc, s) => {
        if (s.compliance_good_qty != null) return acc + s.compliance_good_qty
        if (s.compliance_bad_qty != null) {
          const base = s.verified_count ?? s.quantity
          return acc + Math.max(0, base - s.compliance_bad_qty)
        }
        if (s.verified_count != null) return acc + s.verified_count
        return acc + s.quantity
      }, 0)
      return { qty: sum + missed, verified: true, hasMissed: missed > 0 }
    }
  }

  // 3. Machinist's count
  if (job.good_pieces != null && job.good_pieces > 0) {
    return { qty: job.good_pieces + missed, verified: true, hasMissed: missed > 0 }
  }

  // 4. Pre-system entries only (no SkyNet production yet)
  if (missed > 0) return { qty: missed, verified: true, hasMissed: true }

  // 5. Original order
  return { qty: job.quantity, verified: false, hasMissed: false }
}
