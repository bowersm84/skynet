import { PRODUCTION_DONE_STATUSES } from './jobs'

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
  revertCompliance = false // D-SCHED-25: retained for signature compatibility; the RPC ignores it
}) {
  // SKY63 Packet 3 — apply the placement + downstream cascade in ONE server-side
  // transaction (reschedule_with_cascade) so the deferrable overlap constraint is
  // validated only on the final arrangement, not the intermediate shuffle. Writing
  // the moves one-by-one tripped the constraint on a transient overlap.
  // D-SCHED-25: a machine change never sends an approved job back to compliance.
  const newStatus = targetJob.status === 'pending_compliance' ? 'pending_compliance' : 'assigned'

  const cascade = (cascadeChanges || []).map(change => ({
    job_id: change.job.id,
    new_start: change.newStart.toISOString(),
    new_end: change.newEnd.toISOString()
  }))

  const { error } = await supabase.rpc('reschedule_with_cascade', {
    p_target_id: targetJob.id,
    p_target_machine_id: targetMachineId,
    p_target_start: targetStart.toISOString(),
    p_target_end: targetEnd.toISOString(),
    p_target_minutes: targetMinutes,
    p_new_status: newStatus,
    p_scheduled_by: profile?.id ?? null,
    p_cascade: cascade,
    p_revert_compliance: revertCompliance
  })

  if (error) {
    throw new Error(error.message)
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
  const newStatus = job.status === 'pending_compliance' ? 'pending_compliance' : 'ready'
  const cascade = (cascadeChanges || []).map(c => ({
    job_id: c.job.id,
    new_start: c.newStart.toISOString(),
    new_end: c.newEnd.toISOString()
  }))
  const { error } = await supabase.rpc('unschedule_with_cascade', {
    p_job_id: job.id,
    p_new_status: newStatus,
    p_cascade: cascade
  })
  if (error) throw new Error(error.message)
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
  const start = new Date(job.scheduled_start)
  const minutes = Math.max(1, Math.round((new Date(newEnd) - start) / 60000))
  const cascade = (cascadeChanges || []).map(c => ({
    job_id: c.job.id,
    new_start: c.newStart.toISOString(),
    new_end: c.newEnd.toISOString()
  }))
  const { error } = await supabase.rpc('change_end_with_cascade', {
    p_job_id: job.id,
    p_new_end: new Date(newEnd).toISOString(),
    p_new_minutes: minutes,
    p_cascade: cascade
  })
  if (error) throw new Error(error.message)
}

// ─────────── D-SCHED-13: parts/day throughput history (shared) ───────────
// History source is jobs.time_per_unit (minutes/piece, production_start →
// actual_end, written at completion). Used by ScheduleJobModal Step 3 and the
// Adjust End Date modal so both compute identical suggestions.

// ─────────── D-SCHED-19: per-machine part history for the machine picker ───────────
// Broader than fetchPartThroughputRuns: a completed run proves the machine can
// make the part even when it yields no rate, so runs with no usable time_per_unit
// still count toward capability. Same production-done basis as the Armory Part
// History modal (D-PARTHIST-02), imported from lib/jobs.js so the two agree.

// Minutes per piece for a run. Prefers the value recorded at completion; falls
// back to the calculation the kiosk performs (production_start → actual_end ÷
// good_pieces) for rows that predate that write or were closed by a path that
// left it null. Lifted from PartHistoryModal so both surfaces share it.
export function effectiveTimePerUnit(job) {
  const recorded = Number(job?.time_per_unit)
  if (recorded > 0) return { tpu: recorded, derived: false }
  const pieces = job?.good_pieces || 0
  if (!job?.production_start || !job?.actual_end || pieces <= 0) return null
  const minutes = (new Date(job.actual_end) - new Date(job.production_start)) / 60000
  if (!(minutes > 0)) return null
  return { tpu: minutes / pieces, derived: true }
}

// D-SCHED-27: single history source. One row per production-done run on a machine
// (view v_part_run_rates); calendar_rate/tpu_minutes carry the effectiveTimePerUnit basis,
// steady_* carry the D-COST-31 waypoint basis, is_paper_era marks pre-kiosk rows.
export async function fetchPartRunRates(supabase, componentId, excludeJobId) {
  if (!componentId) return []
  const { data, error } = await supabase
    .from('v_part_run_rates')
    .select('*')
    .eq('part_id', componentId)
    .order('actual_end', { ascending: false })
    .limit(300)
  if (error) { console.error('v_part_run_rates:', error); return [] }
  return (data || []).filter(r => r.job_id !== excludeJobId)
}

// Median of a numeric list; null when empty. Used for the per-machine steady rate.
function medianOf(values) {
  const xs = (values || []).map(Number).filter(v => Number.isFinite(v)).sort((a, b) => a - b)
  if (!xs.length) return null
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2)
}

// Returns { [machineId]: { runs, pieces, ratedPieces, ratedMinutes, ratedRuns, derived,
// paperRuns, lastRun, rate, steadyMedian, steadyMin, steadyMax } } for every machine that
// has produced this part. rate stays piece-weighted calendar parts/day on the same basis as
// computePartsPerDaySuggestion; null when no run on that machine yields a usable time/unit.
// D-SCHED-27: rows now come from v_part_run_rates, which already applies the production-done
// status set and the effectiveTimePerUnit rate basis — one definition, server-side.
export async function fetchPartMachineHistory(supabase, componentId, excludeJobId) {
  if (!componentId) return {}
  const rows = await fetchPartRunRates(supabase, componentId, excludeJobId)

  const byMachine = {}
  for (const r of rows) {
    if (!r.machine_id) continue
    const m = byMachine[r.machine_id] || (byMachine[r.machine_id] = {
      runs: 0, pieces: 0, ratedPieces: 0, ratedMinutes: 0, ratedRuns: 0, derived: 0,
      paperRuns: 0, lastRun: null, _steady: []
    })
    m.runs += 1
    const pieces = Number(r.pieces) || 0
    m.pieces += pieces
    if (r.is_paper_era) m.paperRuns += 1
    const tpu = Number(r.tpu_minutes)
    if (r.is_rated && tpu > 0 && pieces > 0) {
      m.ratedRuns += 1
      m.ratedPieces += pieces
      m.ratedMinutes += pieces * tpu
      if (r.tpu_derived) m.derived += 1
    }
    if (r.steady_rate != null) m._steady.push(Number(r.steady_rate))
    const end = r.actual_end ? new Date(r.actual_end) : null
    if (end && (!m.lastRun || end > m.lastRun)) m.lastRun = end
  }
  for (const m of Object.values(byMachine)) {
    m.rate = m.ratedMinutes > 0
      ? Math.max(1, Math.round(m.ratedPieces / (m.ratedMinutes / (24 * 60))))
      : null
    m.steadyMedian = medianOf(m._steady)
    m.steadyMin = m._steady.length ? Math.min(...m._steady) : null
    m.steadyMax = m._steady.length ? Math.max(...m._steady) : null
    delete m._steady
  }
  return byMachine
}

// The 10 most recent RATED runs, in the legacy row shape computePartsPerDaySuggestion
// expects. D-SCHED-27: the source is now v_part_run_rates, so derived rates (production_start
// → actual_end ÷ good_pieces) enter the duration suggestion alongside recorded time_per_unit —
// this is the D-SCHED-19 alignment, deliberate and Matt-approved. Paper-era rows are unrated
// in the view, so they can never reach it.
export async function fetchPartThroughputRuns(supabase, componentId, excludeJobId) {
  const rows = await fetchPartRunRates(supabase, componentId, excludeJobId)
  return rows
    .filter(r => r.is_rated)
    .slice(0, 10)
    .map(r => ({
      id: r.job_id,
      assigned_machine_id: r.machine_id,
      good_pieces: r.good_pieces,
      quantity: r.quantity,
      time_per_unit: r.tpu_minutes,
      actual_end: r.actual_end
    }))
}

// ─────────── D-SCHED-27: length-family history, materials, policies, first run ───────────

export async function fetchPartFamily(supabase, componentId) {
  if (!componentId) return null
  const { data, error } = await supabase
    .from('parts')
    .select('id, part_number, length_family_key, length_dash')
    .eq('id', componentId)
    .maybeSingle()
  if (error) { console.error('parts (length family):', error); return null }
  return data || null
}

export async function fetchLengthFamilyHistory(supabase, familyKey) {
  if (!familyKey) return []
  const { data, error } = await supabase
    .from('v_length_family_machine_history')
    .select('*')
    .eq('length_family_key', familyKey)
  if (error) { console.error('v_length_family_machine_history:', error); return [] }
  return data || []
}

// What bar this part — or, failing that, its family — has actually been loaded with.
export async function fetchObservedMaterial(supabase, componentId, familyKey) {
  const out = { part: null, family: null }
  if (componentId) {
    const { data, error } = await supabase
      .from('v_part_observed_material')
      .select('*')
      .eq('part_id', componentId)
      .eq('is_primary', true)
      .maybeSingle()
    if (error) console.error('v_part_observed_material:', error)
    else out.part = data || null
  }
  if (familyKey) {
    const { data, error } = await supabase
      .from('v_length_family_material')
      .select('*')
      .eq('length_family_key', familyKey)
      .eq('is_primary', true)
      .maybeSingle()
    if (error) console.error('v_length_family_material:', error)
    else out.family = data || null
  }
  return out
}

// Latest material load per running job. Chunked at 150 — the id list travels in the URL.
export async function fetchRunningMaterials(supabase, jobIds) {
  const ids = [...new Set((jobIds || []).filter(Boolean))]
  if (!ids.length) return {}
  const out = {}
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase
      .from('job_materials')
      .select('job_id, material_type, bar_size, bars_loaded, bars_remaining, loaded_at')
      .in('job_id', ids.slice(i, i + 150))
    if (error) { console.error('job_materials:', error); break }
    for (const r of data || []) {
      const prev = out[r.job_id]
      if (!prev || new Date(r.loaded_at || 0) >= new Date(prev.loaded_at || 0)) out[r.job_id] = r
    }
  }
  return out
}

// Standing rules that name this part or its family. Policy text is free-form, so the
// match is a literal case-insensitive containment done client-side — "SK213-#B" matches
// the family key exactly as it is written in the rule.
export async function fetchMatchingPolicies(supabase, partNumber, familyKey) {
  const needles = [partNumber, familyKey]
    .filter(Boolean)
    .map(s => String(s).toLowerCase())
  if (!needles.length) return []
  const { data, error } = await supabase
    .from('scheduler_policies')
    .select('id, policy_text')
    .eq('is_active', true)
    .order('created_at', { ascending: true })
  if (error) { console.error('scheduler_policies:', error); return [] }
  return (data || []).filter(p => {
    const text = String(p.policy_text || '').toLowerCase()
    return needles.some(n => text.includes(n))
  })
}

export async function fetchJobFirstRun(supabase, jobId) {
  if (!jobId) return null
  const { data, error } = await supabase
    .from('v_job_first_run')
    .select('*')
    .eq('job_id', jobId)
    .maybeSingle()
  if (error) { console.error('v_job_first_run:', error); return null }
  return data || null
}

// Weighted-average parts per 24h day; prefers runs on machineId when any exist.
export function computePartsPerDaySuggestion(runs, machineId) {
  if (!runs?.length) return null
  const machineRuns = machineId ? runs.filter(r => r.assigned_machine_id === machineId) : []
  const basis = machineRuns.length > 0 ? machineRuns : runs
  let totalPieces = 0
  let totalRunMinutes = 0
  for (const r of basis) {
    const pieces = (r.good_pieces > 0 ? r.good_pieces : r.quantity) || 0
    const tpu = Number(r.time_per_unit)
    if (pieces <= 0 || !(tpu > 0)) continue
    totalPieces += pieces
    totalRunMinutes += pieces * tpu
  }
  if (totalPieces <= 0 || totalRunMinutes <= 0) return null
  return {
    rate: Math.max(1, Math.round(totalPieces / (totalRunMinutes / (24 * 60)))),
    runCount: basis.length,
    machineSpecific: machineRuns.length > 0
  }
}

// qty at rate parts/day → total minutes, +10% buffer, rounded up to the whole
// hour, minimum 1h. Returns null for invalid inputs.
export function partsPerDayToMinutes(quantity, rate) {
  const r = parseFloat(rate)
  const qty = Number(quantity) || 0
  if (!(r > 0) || !(qty > 0)) return null
  const raw = (qty / r) * 24 * 60 * 1.10
  return Math.max(60, Math.ceil(raw / 60) * 60)
}

// D-SCHED-27 rate ladder. One precedence, calendar basis only (the duration math and its
// +10% buffer are tuned on it). First tier with a rated number wins. Paper-era evidence is
// listed but can never be chosen. Machine outranks part-elsewhere because in Skybolt's data
// the machine is the larger variable (identical SK4C studs ran 1.4× faster on NT-7 than NT-4;
// adjacent dashes on one machine differ far less).
//
// Returns { chosen: { rate, tier, label } | null, evidence: [...] } with evidence ordered
// by tier. Steady rate rides along as context and a one-click override — never the default.
export function buildRateLadder({ partHistory, partRuns, familyHistory, machines, machineId, familyKey }) {
  const famRows = familyHistory || []
  const machineList = machines || []
  const machine = machineList.find(m => m.id === machineId) || null
  const machineName = machine?.name || 'this machine'
  const model = machine?.model || null
  const nameOf = (id) => machineList.find(m => m.id === id)?.name || '—'

  const line = (tier, label, extra) => ({
    tier, label,
    machineId: null, machineName: null, sameModel: false,
    rate: null, steadyMedian: null, steadyMin: null, steadyMax: null,
    runs: 0, ratedRuns: 0, paperRuns: 0,
    dashes: null, lastRun: null, detail: null, machineNames: null,
    ...extra
  })

  const fromFamilyRow = (row) => ({
    machineId: row.machine_id,
    machineName: row.machine_name,
    rate: row.calendar_rate ?? null,
    steadyMedian: row.steady_median ?? null,
    steadyMin: row.steady_min ?? null,
    steadyMax: row.steady_max ?? null,
    runs: row.runs || 0,
    ratedRuns: row.rated_runs || 0,
    paperRuns: row.paper_runs || 0,
    dashes: row.dashes || null,
    lastRun: row.last_run_at ? new Date(row.last_run_at) : null,
    detail: row.runs_detail || null
  })

  // 1 — this part, on this machine.
  const ph = (partHistory || {})[machineId] || null
  const t1 = line('part_on_machine', `This part on ${machineName}`, {
    machineId, machineName,
    rate: ph?.rate ?? null,
    steadyMedian: ph?.steadyMedian ?? null,
    steadyMin: ph?.steadyMin ?? null,
    steadyMax: ph?.steadyMax ?? null,
    runs: ph?.runs || 0,
    ratedRuns: ph?.ratedRuns || 0,
    paperRuns: ph?.paperRuns || 0,
    lastRun: ph?.lastRun || null
  })

  // 2 — the length family, on this machine.
  const famHere = familyKey ? (famRows.find(f => f.machine_id === machineId) || null) : null
  const t2 = familyKey
    ? line('family_on_machine', `${familyKey} family on ${machineName}`,
        famHere ? fromFamilyRow(famHere) : { machineId, machineName })
    : null

  // 3 — this part, on every machine (the D-SCHED-10 basis, unchanged).
  const elsewhere = computePartsPerDaySuggestion(partRuns, null)
  const runMachineNames = [...new Set((partRuns || [])
    .map(r => nameOf(r.assigned_machine_id))
    .filter(n => n && n !== '—'))]
  const t3 = line('part_elsewhere', 'This part on other machines', {
    rate: elsewhere?.rate ?? null,
    runs: elsewhere?.runCount || 0,
    ratedRuns: elsewhere?.runCount || 0,
    machineNames: runMachineNames.length ? runMachineNames : null
  })

  // 4 — the family on a sister machine of the same model.
  const sameModelRows = (familyKey && model)
    ? famRows
        .filter(f => f.machine_id !== machineId && f.machine_model === model && f.calendar_rate != null)
        .sort((a, b) => (b.rated_runs || 0) - (a.rated_runs || 0))
    : []
  const smRow = sameModelRows[0] || null
  const t4 = smRow
    ? line('family_same_model', `${familyKey} family on ${smRow.machine_name} (same model · ${model})`,
        { ...fromFamilyRow(smRow), sameModel: true })
    : null

  // 5 — the family, everywhere. Piece-weighted across every rated family row.
  const ratedFam = famRows.filter(f => f.calendar_rate != null && Number(f.pieces) > 0)
  let t5 = null
  if (familyKey && ratedFam.length) {
    const pieces = ratedFam.reduce((s, f) => s + Number(f.pieces || 0), 0)
    const days = ratedFam.reduce((s, f) => s + Number(f.pieces || 0) / Number(f.calendar_rate), 0)
    const steadies = ratedFam.map(f => f.steady_median).filter(v => v != null).map(Number)
    const lastRuns = ratedFam.map(f => f.last_run_at).filter(Boolean).map(d => new Date(d))
    t5 = line('family_anywhere', `${familyKey} family, all machines`, {
      rate: days > 0 ? Math.max(1, Math.round(pieces / days)) : null,
      steadyMedian: medianOf(steadies),
      steadyMin: ratedFam.map(f => f.steady_min).filter(v => v != null).length
        ? Math.min(...ratedFam.map(f => f.steady_min).filter(v => v != null).map(Number)) : null,
      steadyMax: ratedFam.map(f => f.steady_max).filter(v => v != null).length
        ? Math.max(...ratedFam.map(f => f.steady_max).filter(v => v != null).map(Number)) : null,
      runs: ratedFam.reduce((s, f) => s + (f.runs || 0), 0),
      ratedRuns: ratedFam.reduce((s, f) => s + (f.rated_runs || 0), 0),
      paperRuns: ratedFam.reduce((s, f) => s + (f.paper_runs || 0), 0),
      dashes: [...new Set(ratedFam.flatMap(f => f.dashes || []))].sort((a, b) => a - b),
      lastRun: lastRuns.length ? new Date(Math.max(...lastRuns.map(d => d.getTime()))) : null,
      detail: ratedFam.flatMap(f => f.runs_detail || []),
      machineNames: ratedFam.map(f => f.machine_name)
    })
  }

  const chosen = [t1, t2, t3, t4, t5].filter(Boolean).find(t => t.rate != null) || null

  // Display set: the two machine-specific tiers always (they say "no run" when empty —
  // that absence is itself the evidence); the wider tiers only when they carry a number.
  // Tier 5 is suppressed when it would merely restate a single family row already shown.
  const evidence = [t1]
  if (t2) evidence.push(t2)
  if (t3.rate != null || (partRuns || []).length > 0) evidence.push(t3)
  if (t4) evidence.push(t4)
  if (t5 && !(ratedFam.length === 1 && (t2?.rate != null || t4?.rate != null))) evidence.push(t5)

  return {
    chosen: chosen ? { rate: chosen.rate, tier: chosen.tier, label: chosen.label } : null,
    evidence
  }
}

// Projected finish for a run of `qty` at `rate` parts/day starting at `startAt`.
// Same duration math as the Step 3 calculator (+10% buffer, ceil to the hour).
export function projectFinish({ startAt, qty, rate }) {
  if (!startAt || !(Number(rate) > 0)) return null
  const minutes = partsPerDayToMinutes(qty, rate)
  if (minutes === null) return null
  const start = new Date(startAt)
  if (isNaN(start.getTime())) return null
  return new Date(start.getTime() + minutes * 60000)
}

// D-DATE-03: commitDate is a DATE string, so the comparison is against end of day.
export function isAfterCommit(date, commitDate) {
  if (!date || !commitDate) return false
  const d = new Date(date)
  if (isNaN(d.getTime())) return false
  return d > new Date(String(commitDate).slice(0, 10) + 'T23:59:59')
}

// Bar affinity between the part being scheduled and what the machine is running now.
// Matt, 2026-09-22: a material change means swapping scrap bins and pulling new bar —
// "prefer to stick with what's running." Either side missing renders nothing.
export function materialAffinity(partBar, runningBar) {
  const norm = (b) => (b && b.material_type && b.bar_size)
    ? { mat: String(b.material_type).trim(), size: String(b.bar_size).trim() }
    : null
  const part = norm(partBar)
  const running = norm(runningBar)
  if (!part || !running) return { kind: 'unknown', label: null }

  const sameMat = part.mat.toLowerCase() === running.mat.toLowerCase()
  const sameSize = part.size.toLowerCase() === running.size.toLowerCase()
  if (sameMat && sameSize) {
    return { kind: 'same_bar', label: `Same bar loaded: ${running.size} ${running.mat}` }
  }
  if (sameMat) {
    return { kind: 'same_material', label: `Same material, bar change: ${running.size} → ${part.size}` }
  }
  return {
    kind: 'change',
    label: `Material change: ${running.mat} → ${part.mat} (scrap bins + bar pull)`
  }
}
