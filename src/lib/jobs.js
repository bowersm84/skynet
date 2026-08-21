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

// ─────────── D-PARTHIST-02 / D-SCHED-19: production-history status basis ───────────
// Machining finishes at manufacturing_complete; a job then walks finishing,
// post-mfg review, outsourcing, assembly, and TCO before reaching 'complete'.
// Production history must key off the former — gating on 'complete' hides
// months of real runs. Introduced in PartHistoryModal, lifted here so the
// Armory modal and the scheduler's machine picker share one definition.
export const PRODUCTION_DONE_STATUSES = [
  'manufacturing_complete', 'pending_passivation', 'in_passivation',
  'pending_post_manufacturing', 'ready_for_outsourcing', 'at_external_vendor',
  'ready_for_assembly', 'in_assembly', 'pending_tco', 'complete', 'incomplete'
]

// Still on, or headed for, a machine.
export const IN_FLIGHT_STATUSES = [
  'pending_compliance', 'ready', 'assigned', 'in_setup', 'in_progress'
]

// Never counted in totals or rates.
export const EXCLUDED_STATUSES = ['cancelled', 'merged']
