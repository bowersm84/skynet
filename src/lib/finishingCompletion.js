import { supabase } from './supabase'
import { FEATURES } from '../config'
import { componentNextStatus } from './assemblyRouting'

// S17 B.1 (D-ASM-30): where a component job goes once its last external / finishing / compliance step is done —
// ready_for_assembly when it feeds a live WOA or an open assembly build, else pending_tco; always pending_tco while
// ASSEMBLY_MODULE is off, with no extra query, so PROD is unchanged until cutover. Every completion path calls this:
// resolveNextStatusAfterFinishing below, ComplianceReview's three approve paths and OutsourcedJobs' return and
// cancel paths.
export async function assemblyNextStatus(jobId) {
  if (!FEATURES.ASSEMBLY_MODULE) return 'pending_tco'
  const { data: job } = await supabase
    .from('jobs')
    .select('work_order_assembly_id')
    .eq('id', jobId)
    .single()
  const woaId = job?.work_order_assembly_id
  if (!woaId) return componentNextStatus({ assemblyModule: true })
  const [{ data: woa }, { data: builds }] = await Promise.all([
    supabase.from('work_order_assemblies').select('id, status').eq('id', woaId).maybeSingle(),
    supabase.from('assembly_builds').select('id, status').eq('work_order_assembly_id', woaId).limit(1),
  ])
  return componentNextStatus({ assemblyModule: true, woa: woa || null, build: (builds || [])[0] || null })
}

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

  return assemblyNextStatus(jobId)
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
