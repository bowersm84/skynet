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
  targetStart, targetEnd, targetMinutes, cascadeChanges
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

  const newStatus = targetJob.status === 'pending_compliance'
    ? 'pending_compliance'
    : 'assigned'

  const { error } = await supabase
    .from('jobs')
    .update({
      assigned_machine_id: targetMachineId,
      scheduled_start: targetStart.toISOString(),
      scheduled_end: targetEnd.toISOString(),
      estimated_minutes: targetMinutes,
      status: newStatus,
      scheduled_by: profile?.id,
      scheduled_at: new Date().toISOString()
    })
    .eq('id', targetJob.id)

  if (error) {
    throw new Error(`Schedule failed on ${targetJob.job_number}: ${error.message}`)
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
