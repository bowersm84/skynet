// Does this batch require chemical lot tracking (Citric Acid + Alkaline Mix)?
//
// Operational truth: chemicals are used during the passivation stage of finishing.
// If the job's routing includes an active passivation step, the batch needs chemicals.
// If the routing has no passivation step (e.g., a steel part with Wash → Dry only),
// chemicals are NOT needed.
//
// Status filter: a routing step counts as "active" if its status is NOT in
// ('skipped', 'removed'). Pending, in_progress, and complete all count — what
// matters is whether the routing PLANS to include passivation.

const INACTIVE_STEP_STATUSES = ['skipped', 'removed']

/**
 * @param {Array<{step_name: string, status?: string}>|null|undefined} routingSteps
 * @returns {boolean} true if this batch's job routing includes an active passivation step.
 *
 * Defensive default: if routingSteps is null/undefined/empty (data not loaded, or
 * a job with no routing), return TRUE so the operator is prompted to verify
 * rather than silently skipping required passivation data.
 */
export function batchRequiresChemicals(routingSteps) {
  if (!routingSteps || routingSteps.length === 0) return true
  return routingSteps.some(step => {
    if (!step?.step_name) return false
    if (INACTIVE_STEP_STATUSES.includes(step.status)) return false
    return step.step_name.toLowerCase().includes('passivation')
  })
}
