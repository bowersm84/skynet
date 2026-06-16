import { supabase } from './supabase'
import { FEATURES } from '../config'

// Where a job goes once its finishing phase is finished. Mirrors the branch
// logic in ComplianceReview.handleApproveBatch so completion paths and
// compliance approval stay in lockstep.
export async function resolveNextStatusAfterFinishing(jobId) {
  const { data: externalSteps } = await supabase
    .from('job_routing_steps')
    .select('id, status')
    .eq('job_id', jobId)
    .eq('step_type', 'external')
    .in('status', ['pending', 'in_progress'])
  if (externalSteps && externalSteps.length > 0) return 'ready_for_outsourcing'

  const { data: job } = await supabase
    .from('jobs')
    .select('component:parts!component_id(part_type)')
    .eq('id', jobId)
    .single()
  const partType = job?.component?.part_type
  return (partType === 'finished_good' || !FEATURES.ASSEMBLY_MODULE)
    ? 'pending_tco'
    : 'ready_for_assembly'
}

// The status to write when an operator explicitly completes a job from the
// finishing screen or kiosk. If any finishing batch is still awaiting compliance
// (NULL or pending_compliance), sit at manufacturing_complete and let the final
// compliance approval carry the job forward. If every batch is already resolved
// (approved/rejected), advance now so the job does not strand at
// manufacturing_complete (compliance no longer advances from in_progress).
export async function resolveCompletionStatus(jobId) {
  const { data: sends } = await supabase
    .from('finishing_sends')
    .select('compliance_status')
    .eq('job_id', jobId)
  const anyPending = (sends || []).some(
    s => s.compliance_status == null || s.compliance_status === 'pending_compliance'
  )
  if (anyPending) return 'manufacturing_complete'
  return await resolveNextStatusAfterFinishing(jobId)
}
