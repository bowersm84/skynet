// src/lib/jobMerge.js
//
// D-JOBMERGE-02 — client wrappers + shared helpers for the job-merge
// (co-production absorb) feature. All mutations go through the Round 1
// SECURITY DEFINER RPCs; nothing here writes tables directly.

import { supabase } from './supabase'

export async function fetchMergeHostCandidates(componentId, excludeJobId = null) {
  if (!componentId) return []
  const { data, error } = await supabase.rpc('merge_host_candidates', {
    p_component_id: componentId,
    p_exclude_job_id: excludeJobId
  })
  if (error) {
    console.error('merge_host_candidates failed:', error)
    return []
  }
  return data || []
}

export async function mergeJobIntoHost(memberJobId, hostJobId, notes = null) {
  const { data, error } = await supabase.rpc('merge_job_into_host', {
    p_member_job_id: memberJobId,
    p_host_job_id: hostJobId,
    p_notes: notes
  })
  if (error) throw error
  return data
}

export async function unmergeJob(memberJobId) {
  const { data, error } = await supabase.rpc('unmerge_job', {
    p_member_job_id: memberJobId
  })
  if (error) throw error
  return data
}

// Client-side mirror of the RPC's member gate — used only to decide whether
// merge affordances render. The RPC re-validates authoritatively.
export function isMemberEligible(job) {
  if (!job) return false
  if (job.is_maintenance || job.is_standalone_finishing) return false
  if (job.merged_into_job_id) return false
  if (job.production_lot_number) return false
  return ['pending_compliance', 'ready', 'assigned'].includes(job.status)
}

// Combined run target: the host's own ordered qty plus every active member
// claim. jobs.quantity is never mutated by a merge (D-JOBMERGE-01).
export function getRunTarget(job, activeAllocations = []) {
  const memberQty = (activeAllocations || []).reduce(
    (s, a) => s + (a.requested_qty || 0), 0
  )
  return (job?.quantity || 0) + memberQty
}

// D-JOBMERGE-04: a printed traveler no longer matches the job when a merge or
// unmerge landed after the last print AND after any compliance acknowledgment.
// Staleness is derived from three timestamps — never a flag to clear.
export function isPaperworkStale(job) {
  if (!job?.paperwork_changed_at) return false
  const changed = new Date(job.paperwork_changed_at).getTime()
  const printed = job.traveler_printed_at ? new Date(job.traveler_printed_at).getTime() : -Infinity
  const acked = job.paperwork_ack_at ? new Date(job.paperwork_ack_at).getTime() : -Infinity
  return changed > Math.max(printed, acked)
}

// Active members of a host run, with WO context. Two queries client-merged
// (nesting past two levels is unreliable in a single select).
export async function fetchActiveMembers(hostJobId) {
  if (!hostJobId) return []
  const { data: allocs, error } = await supabase
    .from('job_merge_allocations')
    .select('id, member_job_id, requested_qty')
    .eq('host_job_id', hostJobId)
    .eq('is_active', true)
  if (error) {
    console.error('fetchActiveMembers allocations failed:', error)
    return []
  }
  if (!allocs || allocs.length === 0) return []
  const ids = allocs.map(a => a.member_job_id)
  const { data: jobs } = await supabase
    .from('jobs')
    .select('id, job_number, quantity, work_order:work_orders(wo_number, customer, due_date)')
    .in('id', ids)
  const byId = {}
  for (const j of (jobs || [])) byId[j.id] = j
  return allocs.map(a => ({
    allocation_id: a.id,
    member_job_id: a.member_job_id,
    requested_qty: a.requested_qty,
    job_number: byId[a.member_job_id]?.job_number,
    wo_number: byId[a.member_job_id]?.work_order?.wo_number,
    customer: byId[a.member_job_id]?.work_order?.customer,
    due_date: byId[a.member_job_id]?.work_order?.due_date
  }))
}

export async function ackJobPaperwork(jobId, note = null) {
  const { data, error } = await supabase.rpc('ack_job_paperwork', {
    p_job_id: jobId,
    p_note: note
  })
  if (error) throw error
  return data
}
