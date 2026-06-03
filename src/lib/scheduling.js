// Order-based queue scheduling helpers — single source of truth for how
// scheduled_start/scheduled_end propagate when a job is inserted, moved, or
// has its duration changed. Used by ScheduleJobModal (Batch B) and the
// drag-drop integration in Schedule.jsx (Batch C).

const ONGOING_STATUSES = new Set([
  'in_setup', 'in_progress', 'pending_passivation', 'in_passivation'
])

export function isJobRunning(job) {
  return ONGOING_STATUSES.has(job?.status)
}

/**
 * Jobs currently assigned to a machine, ordered by scheduled_start.
 * Excludes complete/cancelled and jobs without scheduled_start.
 * Pass excludeJobId to omit a specific job (used in edit mode to
 * remove the job-being-rescheduled from its old slot).
 */
export function getMachineQueue(allJobs, machineId, { excludeJobId } = {}) {
  if (!machineId) return []
  return (allJobs || [])
    .filter(j =>
      j.assigned_machine_id === machineId &&
      j.status !== 'complete' &&
      j.status !== 'manufacturing_complete' &&
      j.status !== 'cancelled' &&
      j.scheduled_start &&
      j.id !== excludeJobId
    )
    .sort((a, b) => new Date(a.scheduled_start) - new Date(b.scheduled_start))
}

/**
 * Best-available duration for a job in minutes.
 * Prefers estimated_minutes; falls back to (scheduled_end - scheduled_start).
 * Returns null if neither is available.
 */
export function jobDuration(job) {
  if (job?.estimated_minutes && job.estimated_minutes > 0) {
    return job.estimated_minutes
  }
  if (job?.scheduled_start && job?.scheduled_end) {
    const ms = new Date(job.scheduled_end) - new Date(job.scheduled_start)
    if (ms > 0) return Math.max(1, Math.round(ms / 60000))
  }
  return null
}

/**
 * Build the proposed new queue with the target inserted at insertionIndex.
 * Walks forward from the running job (or now), propagating scheduled_start/end
 * for each subsequent job using its duration.
 *
 * Legacy jobs without a derivable duration are left with their current times
 * unchanged; the cursor advances to their existing scheduled_end so subsequent
 * jobs don't fall back in time.
 *
 * Returns { newSchedule, changes } where:
 *   - newSchedule: array of { job, scheduled_start, scheduled_end, missingDuration? }
 *     in queue order. Marks the target with __isTarget.
 *   - changes: array of { job, newStart, newEnd } for non-target jobs whose
 *     times differ from current — these are the rows to UPDATE.
 */
export function buildPropagatedQueue({
  currentQueue,
  targetJob,
  targetMinutes,
  insertionIndex
}) {
  const runningJob = currentQueue.length > 0 && isJobRunning(currentQueue[0])
    ? currentQueue[0]
    : null

  if (runningJob && insertionIndex < 1) {
    throw new Error('Cannot insert before a running job')
  }

  const newSchedule = []

  // Pre-insertion jobs: keep their times unchanged. The walker only propagates
  // forward from the insertion point — jobs that come before it stay put.
  for (let i = 0; i < insertionIndex; i++) {
    const j = currentQueue[i]
    newSchedule.push({
      job: j,
      scheduled_start: j.scheduled_start ? new Date(j.scheduled_start) : null,
      scheduled_end: j.scheduled_end ? new Date(j.scheduled_end) : null
    })
  }

  // Cursor for the target job's start.
  let cursor
  if (insertionIndex === 0) {
    // Empty/no-running queue, inserting at front — start now.
    cursor = new Date()
  } else {
    const prevJob = currentQueue[insertionIndex - 1]
    cursor = prevJob.scheduled_end ? new Date(prevJob.scheduled_end) : new Date()
  }

  // Target job.
  const targetStart = new Date(cursor)
  const targetEnd = new Date(targetStart.getTime() + targetMinutes * 60000)
  newSchedule.push({
    job: { ...targetJob, __isTarget: true },
    scheduled_start: targetStart,
    scheduled_end: targetEnd
  })
  cursor = targetEnd

  // Post-insertion jobs: propagate forward, tracking only jobs whose times
  // actually change.
  const changes = []
  for (let i = insertionIndex; i < currentQueue.length; i++) {
    const j = currentQueue[i]
    const dur = jobDuration(j)
    if (!dur) {
      // Legacy job with no derivable duration — keep times, advance cursor.
      const keepStart = j.scheduled_start ? new Date(j.scheduled_start) : null
      const keepEnd = j.scheduled_end ? new Date(j.scheduled_end) : null
      newSchedule.push({
        job: j,
        scheduled_start: keepStart,
        scheduled_end: keepEnd,
        missingDuration: true
      })
      if (keepEnd) cursor = keepEnd
      continue
    }

    const newStart = new Date(cursor)
    const newEnd = new Date(newStart.getTime() + dur * 60000)
    newSchedule.push({ job: j, scheduled_start: newStart, scheduled_end: newEnd })
    cursor = newEnd

    const currStart = j.scheduled_start ? new Date(j.scheduled_start).getTime() : null
    const currEnd = j.scheduled_end ? new Date(j.scheduled_end).getTime() : null
    if (currStart !== newStart.getTime() || currEnd !== newEnd.getTime()) {
      changes.push({ job: j, newStart, newEnd })
    }
  }

  return { newSchedule, changes, runningJob }
}

/**
 * Display helper: minutes → "2d 4h" / "5h 30m" / "45m".
 */
export function formatDurationDH(minutes) {
  if (!minutes || minutes <= 0) return '—'
  const days = Math.floor(minutes / (24 * 60))
  const hours = Math.floor((minutes % (24 * 60)) / 60)
  const mins = minutes % 60
  const parts = []
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (!days && !hours && mins) parts.push(`${mins}m`)
  return parts.join(' ') || '0m'
}

/**
 * Persist a schedule action: cascade downstream first, then the target.
 * Non-atomic (sequential update calls). Acceptable for single-scheduler use.
 * Throws on any write failure so the caller can show an error.
 */
export async function applySchedule({
  supabase, profile, targetJob, targetMachineId,
  targetStart, targetEnd, targetMinutes, cascadeChanges,
  revertCompliance = false
}) {
  for (const change of cascadeChanges || []) {
    const { error } = await supabase
      .from('jobs')
      .update({
        scheduled_start: change.newStart.toISOString(),
        scheduled_end: change.newEnd.toISOString()
      })
      .eq('id', change.job.id)
    if (error) {
      throw new Error(`Cascade failed on ${change.job.job_number}: ${error.message}`)
    }
  }

  // S9 workflow flip: when an already-approved job (status='assigned') is
  // rescheduled onto a different machine, send it back to pending_compliance
  // so Roger re-reviews docs against the new machine. Caller (ScheduleJobModal)
  // sets revertCompliance=true after warning the user.
  const newStatus = revertCompliance
    ? 'pending_compliance'
    : (targetJob.status === 'pending_compliance' ? 'pending_compliance' : 'assigned')

  const jobUpdate = {
    assigned_machine_id: targetMachineId,
    scheduled_start: targetStart.toISOString(),
    scheduled_end: targetEnd.toISOString(),
    estimated_minutes: targetMinutes,
    status: newStatus,
    scheduled_by: profile?.id,
    scheduled_at: new Date().toISOString()
  }
  if (revertCompliance) {
    jobUpdate.compliance_outcome = null
    jobUpdate.compliance_notes = null
    jobUpdate.documents_deferred = false
    jobUpdate.documents_deferred_reason = null
    jobUpdate.documents_deferred_by = null
    jobUpdate.documents_deferred_at = null
  }

  const { error } = await supabase
    .from('jobs')
    .update(jobUpdate)
    .eq('id', targetJob.id)

  if (error) {
    throw new Error(`Schedule failed on ${targetJob.job_number}: ${error.message}`)
  }

  if (revertCompliance) {
    // Reset all job_documents to pending so Roger re-approves against the
    // new machine's doc set. Doc-level audit history is not preserved on
    // the row — if a future audit need arises, capture via audit_logs.
    const { error: docErr } = await supabase
      .from('job_documents')
      .update({ status: 'pending', approved_by: null, approved_at: null })
      .eq('job_id', targetJob.id)
    if (docErr) {
      throw new Error(`Document reset failed on ${targetJob.job_number}: ${docErr.message}`)
    }
  }
}

/**
 * Compute the cascade for removing a job from a machine's queue.
 * Jobs that came BEFORE the removed job are unaffected. Jobs that came AFTER
 * are pulled forward to fill the empty slot — the cursor starts at the
 * previous job's scheduled_end (or the removed job's scheduled_start if it
 * was first in the queue) and walks forward.
 *
 * Legacy jobs without a derivable duration keep their existing times; the
 * cursor advances to their existing scheduled_end so subsequent jobs propagate
 * correctly.
 *
 * Returns { changes, removed }. `changes` is the list of jobs whose times
 * need to be written; `removed` is the queue entry that will be unscheduled.
 */
export function computeRemovalCascade(currentQueue, removedJobId) {
  const removedIdx = currentQueue.findIndex(j => j.id === removedJobId)
  if (removedIdx < 0) return { changes: [], removed: null }

  const removed = currentQueue[removedIdx]

  let cursor
  if (removedIdx === 0) {
    cursor = removed.scheduled_start ? new Date(removed.scheduled_start) : new Date()
  } else {
    const prevJob = currentQueue[removedIdx - 1]
    cursor = prevJob.scheduled_end ? new Date(prevJob.scheduled_end) : new Date()
  }

  const changes = []
  for (let i = removedIdx + 1; i < currentQueue.length; i++) {
    const j = currentQueue[i]
    const dur = jobDuration(j)
    if (!dur) {
      if (j.scheduled_end) cursor = new Date(j.scheduled_end)
      continue
    }
    const newStart = new Date(cursor)
    const newEnd = new Date(newStart.getTime() + dur * 60000)
    cursor = newEnd

    const currStart = j.scheduled_start ? new Date(j.scheduled_start).getTime() : null
    const currEnd = j.scheduled_end ? new Date(j.scheduled_end).getTime() : null
    if (currStart !== newStart.getTime() || currEnd !== newEnd.getTime()) {
      changes.push({ job: j, newStart, newEnd })
    }
  }

  return { changes, removed }
}

/**
 * Persist an unschedule action: cascade downstream jobs forward (if any),
 * then clear the target job's machine + scheduled times.
 * Pass empty cascadeChanges to skip the gap-closing step.
 */
export async function applyUnschedule({ supabase, job, cascadeChanges = [] }) {
  for (const change of cascadeChanges) {
    const { error } = await supabase
      .from('jobs')
      .update({
        scheduled_start: change.newStart.toISOString(),
        scheduled_end: change.newEnd.toISOString()
      })
      .eq('id', change.job.id)
    if (error) {
      throw new Error(`Cascade failed on ${change.job.job_number}: ${error.message}`)
    }
  }

  const newStatus = job.status === 'pending_compliance' ? 'pending_compliance' : 'ready'
  const { error } = await supabase
    .from('jobs')
    .update({
      assigned_machine_id: null,
      scheduled_start: null,
      scheduled_end: null,
      status: newStatus,
      scheduled_by: null,
      scheduled_at: null
    })
    .eq('id', job.id)
  if (error) {
    throw new Error(`Unschedule failed on ${job.job_number}: ${error.message}`)
  }
}

/**
 * Compute the downstream cascade when a job's END moves but its position and
 * start stay fixed. The target itself is NOT in `changes` (its end is written
 * separately by applyEndDateChange). Walks forward from newEnd, propagating
 * each subsequent job by its duration. Legacy jobs with no derivable duration
 * keep their times; the cursor advances to their existing scheduled_end.
 */
export function computeEndChangeCascade(currentQueue, jobId, newEnd) {
  const idx = currentQueue.findIndex(j => j.id === jobId)
  if (idx < 0) return { changes: [], target: null }
  const target = currentQueue[idx]

  let cursor = new Date(newEnd)
  const changes = []
  for (let i = idx + 1; i < currentQueue.length; i++) {
    const j = currentQueue[i]
    const dur = jobDuration(j)
    if (!dur) {
      if (j.scheduled_end) cursor = new Date(j.scheduled_end)
      continue
    }
    const newStart = new Date(cursor)
    const newJobEnd = new Date(newStart.getTime() + dur * 60000)
    cursor = newJobEnd

    const currStart = j.scheduled_start ? new Date(j.scheduled_start).getTime() : null
    const currEnd = j.scheduled_end ? new Date(j.scheduled_end).getTime() : null
    if (currStart !== newStart.getTime() || currEnd !== newJobEnd.getTime()) {
      changes.push({ job: j, newStart, newEnd: newJobEnd })
    }
  }
  return { changes, target }
}

/**
 * Persist an end-date change: cascade downstream first, then write the target's
 * new scheduled_end and recomputed estimated_minutes. Start, machine, position,
 * status, and compliance are all left untouched.
 */
export async function applyEndDateChange({ supabase, job, newEnd, cascadeChanges = [] }) {
  for (const change of cascadeChanges) {
    const { error } = await supabase
      .from('jobs')
      .update({
        scheduled_start: change.newStart.toISOString(),
        scheduled_end: change.newEnd.toISOString()
      })
      .eq('id', change.job.id)
    if (error) {
      throw new Error(`Cascade failed on ${change.job.job_number}: ${error.message}`)
    }
  }

  const start = new Date(job.scheduled_start)
  const minutes = Math.max(1, Math.round((new Date(newEnd) - start) / 60000))
  const { error } = await supabase
    .from('jobs')
    .update({
      scheduled_end: new Date(newEnd).toISOString(),
      estimated_minutes: minutes
    })
    .eq('id', job.id)
  if (error) {
    throw new Error(`End date change failed on ${job.job_number}: ${error.message}`)
  }
}
