// Job-related helpers shared across surfaces. Centralizes the split
// gate so the UI and the split_job() RPC agree on which statuses are
// splittable.

// Statuses where redividing remaining production work is meaningful.
// Downstream statuses (passivation, outsourcing, assembly, TCO) and
// terminal statuses are blocked — once pieces are past the machine,
// "splitting" doesn't redivide work, it creates a brand-new job, which
// is a different operation (use new-WO flow instead).
export const SPLITTABLE_STATUSES = [
  'pending_compliance', 'ready', 'assigned',
  'in_setup', 'in_progress', 'manufacturing_complete'
]

export function isSplittable(job) {
  return SPLITTABLE_STATUSES.includes(job?.status)
}

export function canSplitJobs(role) {
  return role === 'scheduler' || role === 'admin'
}
