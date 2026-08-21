import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import {
  X, Loader2, AlertTriangle, ArrowLeft, ArrowRight, Star,
  CheckCircle, Calendar as CalendarIcon, RotateCcw, Layers, History
} from 'lucide-react'
import {
  getMachineQueue, isJobRunning, buildPropagatedQueue,
  formatDurationDH, applySchedule,
  fetchPartThroughputRuns, computePartsPerDaySuggestion, partsPerDayToMinutes,
  fetchPartMachineHistory
} from '../lib/scheduling'
import { fetchMergeHostCandidates, mergeJobIntoHost, isMemberEligible, getRunTarget } from '../lib/jobMerge'

export default function ScheduleJobModal({
  isOpen,
  onClose,
  onSuccess,
  job,
  machines,
  partMachineDurations,
  scheduledJobs,
  profile,
  members = [],
  editMode = false,
  defaults = null,
  onReturnToQueue = null
}) {
  const [step, setStep] = useState(1)
  const [selectedMachineId, setSelectedMachineId] = useState('')
  const [insertionIndex, setInsertionIndex] = useState(null)
  const [durationDays, setDurationDays] = useState(0)
  const [durationHours, setDurationHours] = useState(0)
  // D-SCHED-10: parts/day duration calculator
  const [partsPerDay, setPartsPerDay] = useState('')
  const [historyRuns, setHistoryRuns] = useState([])
  const [partMachineHistory, setPartMachineHistory] = useState({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)

  // D-JOBMERGE-02: Step 1 merge card state
  const [mergeCandidates, setMergeCandidates] = useState([])
  const [mergeTarget, setMergeTarget] = useState(null)
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState(null)

  // Initialize state on open
  useEffect(() => {
    if (!isOpen) return
    const machineId = defaults?.machineId || (editMode ? job?.assigned_machine_id : null) || ''
    setSelectedMachineId(machineId)
    setStep(machineId ? 2 : 1)
    setInsertionIndex(null)
    setSaveError(null)

    if (editMode && job?.estimated_minutes && job.estimated_minutes > 0) {
      const total = job.estimated_minutes
      setDurationDays(Math.floor(total / (24 * 60)))
      setDurationHours(Math.floor((total % (24 * 60)) / 60))
    } else if (editMode && job?.scheduled_start && job?.scheduled_end) {
      const total = Math.max(0, Math.round((new Date(job.scheduled_end) - new Date(job.scheduled_start)) / 60000))
      setDurationDays(Math.floor(total / (24 * 60)))
      setDurationHours(Math.floor((total % (24 * 60)) / 60))
    } else {
      setDurationDays(0)
      setDurationHours(0)
    }
    setPartsPerDay('')
  }, [isOpen, defaults?.machineId, editMode, job?.id])

  // D-SCHED-10: completed runs for this part prove real throughput.
  // time_per_unit = minutes/piece from production_start → actual_end (written at completion).
  useEffect(() => {
    if (!isOpen || !job?.component_id) { setHistoryRuns([]); setPartMachineHistory({}); return }
    let cancelled = false
    fetchPartThroughputRuns(supabase, job.component_id, job?.id).then(runs => {
      if (!cancelled) setHistoryRuns(runs)
    })
    // D-SCHED-19: which machines have actually made this part, and how fast.
    fetchPartMachineHistory(supabase, job.component_id, job?.id).then(byMachine => {
      if (!cancelled) setPartMachineHistory(byMachine)
    })
    return () => { cancelled = true }
  }, [isOpen, job?.component_id, job?.id])

  // D-JOBMERGE-02: same-component host candidates for the Step 1 merge card.
  // Skipped when the job can no longer be a member (started, merged, etc.).
  useEffect(() => {
    if (!isOpen) return
    setMergeTarget(null)
    setMergeError(null)
    if (!isMemberEligible(job)) {
      setMergeCandidates([])
      return
    }
    let cancelled = false
    fetchMergeHostCandidates(job.component_id, job.id).then(rows => {
      if (!cancelled) setMergeCandidates(rows)
    })
    return () => { cancelled = true }
  }, [isOpen, job?.id, job?.component_id, job?.status])

  // Reset position when machine changes (user picks a different machine in step 1)
  useEffect(() => {
    setInsertionIndex(null)
  }, [selectedMachineId])

  const totalMinutes = durationDays * 24 * 60 + durationHours * 60

  // D-SCHED-10: weighted-average throughput from history, machine-specific when available.
  const suggestedPartsPerDay = useMemo(
    () => computePartsPerDaySuggestion(historyRuns, selectedMachineId),
    [historyRuns, selectedMachineId]
  )

  // D-SCHED-10: parts/day → duration (+10% buffer, rounded up to the hour)
  const applyPartsPerDay = (value) => {
    const total = partsPerDayToMinutes(getRunTarget(job, members), value)
    if (total === null) return
    setDurationDays(Math.floor(total / (24 * 60)))
    setDurationHours(Math.floor((total % (24 * 60)) / 60))
  }

  // D-SCHED-10: prefill from history on entering Step 3; never clobber an existing duration.
  useEffect(() => {
    if (step !== 3 || partsPerDay !== '' || !suggestedPartsPerDay) return
    setPartsPerDay(String(suggestedPartsPerDay.rate))
    if (totalMinutes === 0) applyPartsPerDay(suggestedPartsPerDay.rate)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, suggestedPartsPerDay])

  const availableMachines = useMemo(() => {
    return (machines || [])
      .filter(m => m.machine_type !== 'finishing' && m.is_active)
      .map(m => {
        const queue = getMachineQueue(scheduledJobs, m.id, { excludeJobId: editMode ? job?.id : null })
        const lastJob = queue.length > 0 ? queue[queue.length - 1] : null
        const runningJob = queue.find(isJobRunning) || null
        const isPreferred = (partMachineDurations || []).some(
          d => d.part_id === job?.component_id && d.machine_id === m.id && d.is_preferred
        )
        return {
          ...m,
          queue,
          lastJob,
          runningJob,
          isPreferred,
          queueDepth: queue.length,
          lastEnd: lastJob?.scheduled_end ? new Date(lastJob.scheduled_end) : null,
          partHistory: partMachineHistory[m.id] || null
        }
      })
  }, [machines, scheduledJobs, job?.component_id, job?.id, partMachineDurations, partMachineHistory, editMode])

  const selectedMachine = availableMachines.find(m => m.id === selectedMachineId)

  const currentQueue = useMemo(() => {
    if (!selectedMachineId) return []
    return getMachineQueue(scheduledJobs, selectedMachineId, { excludeJobId: editMode ? job?.id : null })
  }, [scheduledJobs, selectedMachineId, editMode, job?.id])

  const minInsertionIndex = useMemo(() => {
    if (currentQueue.length === 0) return 0
    const runningIdx = currentQueue.findIndex(isJobRunning)
    return runningIdx >= 0 ? runningIdx + 1 : 0
  }, [currentQueue])

  // In edit mode, default insertion to the job's current position
  useEffect(() => {
    if (step !== 2 || !editMode || insertionIndex !== null) return
    if (!selectedMachineId || job?.assigned_machine_id !== selectedMachineId) return
    const fullQueue = getMachineQueue(scheduledJobs, selectedMachineId)
    const idx = fullQueue.findIndex(j => j.id === job?.id)
    if (idx >= 0) setInsertionIndex(idx)
  }, [step, editMode, selectedMachineId, scheduledJobs, job?.id, job?.assigned_machine_id, insertionIndex])

  const propagation = useMemo(() => {
    if (step !== 3 || !selectedMachineId || insertionIndex === null || totalMinutes <= 0 || !job) {
      return null
    }
    try {
      const result = buildPropagatedQueue({
        currentQueue,
        targetJob: job,
        targetMinutes: totalMinutes,
        insertionIndex
      })
      const targetSlot = result.newSchedule.find(s => s.job.__isTarget || s.job.id === job.id)
      return { ...result, targetSlot }
    } catch (e) {
      console.error('Propagation error:', e)
      return { error: e.message, changes: [], targetSlot: null }
    }
  }, [step, currentQueue, totalMinutes, insertionIndex, job, selectedMachineId])

  const canProceedFromStep2 = insertionIndex !== null && insertionIndex >= minInsertionIndex
  const canSubmit = totalMinutes > 0 && propagation?.targetSlot && !saving

  const fmtDateTime = (d) =>
    d ? new Date(d).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'

  // S9 workflow flip: rescheduling an already-assigned job onto a different
  // machine sends it back to pending_compliance for re-review. Pending-
  // compliance reschedules don't trigger this (job hasn't been approved
  // for any machine yet — just switch machines silently).
  const isMachineSwapRevert =
    editMode &&
    job?.status === 'assigned' &&
    job?.assigned_machine_id &&
    job.assigned_machine_id !== selectedMachineId

  // D-DATE-03: warn (never block) when the scheduled finish lands after the
  // customer due date. due_date is a DATE column, so compare against end of day.
  const isLateSchedule =
    !!job?.work_order?.due_date &&
    !!propagation?.targetSlot &&
    new Date(propagation.targetSlot.scheduled_end) > new Date(job.work_order.due_date + 'T23:59:59')

  const fmtDueShort = (d) =>
    d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

  const handleSchedule = async () => {
    if (!canSubmit) return
    if (isMachineSwapRevert) {
      const ok = window.confirm(
        'Changing machines will return this job to Compliance for re-review of machine-specific documents. ' +
        'All document approvals on this job will be reset to pending. Continue?'
      )
      if (!ok) return
    }
    if (isLateSchedule) {
      const ok = window.confirm(
        `This job is scheduled to finish after the customer due date (${fmtDueShort(job.work_order.due_date)}). Schedule anyway?`
      )
      if (!ok) return
    }
    setSaving(true)
    setSaveError(null)
    try {
      await applySchedule({
        supabase,
        profile,
        targetJob: job,
        targetMachineId: selectedMachineId,
        targetStart: propagation.targetSlot.scheduled_start,
        targetEnd: propagation.targetSlot.scheduled_end,
        targetMinutes: totalMinutes,
        cascadeChanges: propagation.changes,
        revertCompliance: isMachineSwapRevert
      })
      onSuccess()
    } catch (e) {
      setSaveError(e.message || 'Failed to schedule.')
    } finally {
      setSaving(false)
    }
  }

  const handleMergeConfirm = async () => {
    if (!mergeTarget || merging) return
    setMerging(true)
    setMergeError(null)
    try {
      await mergeJobIntoHost(job.id, mergeTarget.job_id)
      onSuccess()
    } catch (e) {
      setMergeError(e.message || 'Merge failed.')
    } finally {
      setMerging(false)
    }
  }

  if (!isOpen || !job) return null

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div
        className="bg-gray-900 rounded-lg border border-gray-700 max-w-2xl w-full mx-4 shadow-xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-800 flex items-start justify-between flex-shrink-0">
          <div className="flex-1 min-w-0">
            <h3 className="text-xl font-bold text-white flex items-center gap-2">
              <CalendarIcon size={20} className="text-skynet-accent" />
              {editMode ? 'Reschedule' : 'Schedule'}
            </h3>
            <p className="text-gray-500 text-xs mt-1">
              {mergeTarget ? 'Merge into existing run' : <>Step {step} of 3 · {step === 1 ? 'Choose machine' : step === 2 ? 'Pick position' : 'Estimated duration'}</>}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors ml-4">
            <X size={24} />
          </button>
        </div>

        {/* Job summary band */}
        <div className="px-6 py-3 bg-gray-800/50 border-b border-gray-800 flex items-center gap-3 flex-wrap flex-shrink-0">
          <span className="text-white font-mono font-semibold">{job.component?.part_number || job.job_number}</span>
          <span className="text-gray-600">·</span>
          <span className="text-skynet-accent font-mono text-sm">{job.job_number}</span>
          <span className="text-gray-600">·</span>
          <span className="text-gray-400 text-sm">Qty {job.quantity?.toLocaleString()}</span>
          {job.work_order?.wo_number && (<>
            <span className="text-gray-600">·</span>
            <span className="text-gray-400 text-sm">{job.work_order.wo_number}</span>
          </>)}
          {job.work_order?.due_date && (<>
            <span className="text-gray-600">·</span>
            <span className="text-gray-400 text-sm">Due {new Date(job.work_order.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
          </>)}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {step === 1 && mergeTarget && (
            <MergeConfirmPanel
              job={job}
              target={mergeTarget}
              merging={merging}
              mergeError={mergeError}
              onBack={() => { setMergeTarget(null); setMergeError(null) }}
              onConfirm={handleMergeConfirm}
            />
          )}
          {step === 1 && !mergeTarget && (
            <>
              {mergeCandidates.length > 0 && (
                <MergeIntoRunSection
                  job={job}
                  candidates={mergeCandidates}
                  onPick={(c) => setMergeTarget(c)}
                />
              )}
              <Step1Machines
                availableMachines={availableMachines}
                selectedMachineId={selectedMachineId}
                setSelectedMachineId={setSelectedMachineId}
              />
            </>
          )}
          {step === 2 && (
            <Step2Position
              machine={selectedMachine}
              queue={currentQueue}
              insertionIndex={insertionIndex}
              setInsertionIndex={setInsertionIndex}
              minInsertionIndex={minInsertionIndex}
              fmtDateTime={fmtDateTime}
              fmtDueShort={fmtDueShort}
              newJobDue={job?.work_order?.due_date || null}
            />
          )}
          {step === 3 && (
            <Step3Duration
              machine={selectedMachine}
              queue={currentQueue}
              insertionIndex={insertionIndex}
              durationDays={durationDays}
              setDurationDays={setDurationDays}
              durationHours={durationHours}
              setDurationHours={setDurationHours}
              totalMinutes={totalMinutes}
              partsPerDay={partsPerDay}
              setPartsPerDay={setPartsPerDay}
              applyPartsPerDay={applyPartsPerDay}
              suggestedPartsPerDay={suggestedPartsPerDay}
              propagation={propagation}
              fmtDateTime={fmtDateTime}
              job={job}
              isMachineSwapRevert={isMachineSwapRevert}
              isLateSchedule={isLateSchedule}
              dueDateDisplay={fmtDueShort(job.work_order?.due_date)}
              members={members}
            />
          )}
        </div>

        {saveError && (
          <div className="px-6 pb-2 flex-shrink-0">
            <div className="bg-red-900/30 border border-red-700 rounded p-2 text-red-300 text-sm flex items-center gap-2">
              <AlertTriangle size={14} />
              {saveError}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            {editMode && onReturnToQueue && step >= 2 && (
              <button
                onClick={onReturnToQueue}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-yellow-900/30 hover:bg-yellow-900/50 border border-yellow-700 text-yellow-300 rounded transition-colors"
              >
                <RotateCcw size={14} />
                Return to queue
              </button>
            )}
            {step > 1 && (
              <button
                onClick={() => setStep(step - 1)}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
              >
                <ArrowLeft size={14} />
                Back
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {step === 1 && !mergeTarget && (
              <button
                onClick={() => setStep(2)}
                disabled={!selectedMachineId}
                className="flex items-center gap-1.5 px-4 py-2 bg-skynet-accent hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded transition-colors"
              >
                Next
                <ArrowRight size={14} />
              </button>
            )}
            {step === 2 && (
              <button
                onClick={() => setStep(3)}
                disabled={!canProceedFromStep2}
                className="flex items-center gap-1.5 px-4 py-2 bg-skynet-accent hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded transition-colors"
              >
                Next
                <ArrowRight size={14} />
              </button>
            )}
            {step === 3 && (
              <button
                onClick={handleSchedule}
                disabled={!canSubmit}
                className="flex items-center gap-1.5 px-4 py-2 bg-skynet-accent hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded transition-colors"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                {saving ? 'Scheduling...' : isMachineSwapRevert ? 'Reschedule & re-review' : editMode ? 'Save changes' : 'Schedule'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────── Step 1: Machine picker ───────────

function MachinePickCard({ m, selected, onSelect, showPlacement }) {
  const isDown = m.status === 'down' || m.status === 'offline'
  return (
    <button
      onClick={() => onSelect(m.id)}
      className={`w-full text-left p-3 rounded-lg border transition-all cursor-pointer ${
        selected
          ? 'bg-skynet-accent/10 border-skynet-accent'
          : isDown
            ? 'bg-red-950/20 border-red-800 hover:border-red-600'
            : 'bg-gray-800 border-gray-700 hover:border-gray-600'
      }`}
    >
      <div className="flex items-center justify-between mb-1 flex-wrap gap-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-white font-medium">{m.name}</span>
          <span className="text-gray-500 text-xs font-mono">{m.code}</span>
          {m.isPreferred && (
            <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 bg-yellow-900/40 text-yellow-300 border border-yellow-700/50 rounded">
              <Star size={10} /> Preferred
            </span>
          )}
          {isDown && (
            <span className="text-xs px-1.5 py-0.5 bg-red-900/40 text-red-300 border border-red-700 rounded">
              DOWN — schedulable
            </span>
          )}
        </div>
        <span className="text-gray-500 text-xs">
          {m.queueDepth === 0 ? 'Empty' : `${m.queueDepth} in queue`}
        </span>
      </div>
      {showPlacement && (
        <div className="text-[11px] text-gray-500 mb-1">
          {m.location?.name || 'Unknown Location'} · {m.machine_type || 'Other'}
        </div>
      )}
      {m.partHistory && (
        <div className="text-xs text-cyan-300/90 mt-1">
          Ran this part: {m.partHistory.runs} run{m.partHistory.runs === 1 ? '' : 's'}
          {m.partHistory.rate != null && ` · ${m.partHistory.rate.toLocaleString()}/day`}
          {m.partHistory.lastRun && ` · last ${m.partHistory.lastRun.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}
        </div>
      )}
      {m.runningJob && (
        <div className="text-xs text-gray-400 mt-1">
          <span className="text-green-400 font-bold">RUNNING</span> {m.runningJob.component?.part_number || m.runningJob.job_number}
        </div>
      )}
      {m.lastJob && m.lastJob.id !== m.runningJob?.id && (
        <div className="text-xs text-gray-500 mt-1">
          Last queued: {m.lastJob.component?.part_number || m.lastJob.job_number}
          {m.lastEnd && ` · ends ${m.lastEnd.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`}
        </div>
      )}
    </button>
  )
}

function Step1Machines({ availableMachines, selectedMachineId, setSelectedMachineId }) {
  // Machines with proven runs on this part lead the list in their own section.
  // Run history outranks the master-data Preferred star in the scheduler's
  // capability hierarchy, so it should not be something the scheduler has to
  // scroll for. Proven machines are moved rather than duplicated; each card
  // carries its location and brand inline so pulling it out of the grouped
  // list below does not lose that context.
  const proven = useMemo(() => {
    return availableMachines
      .filter(m => m.partHistory)
      .sort((a, b) => {
        const ra = a.partHistory.rate ?? -1
        const rb = b.partHistory.rate ?? -1
        if (ra !== rb) return rb - ra
        if (a.partHistory.runs !== b.partHistory.runs) return b.partHistory.runs - a.partHistory.runs
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      })
  }, [availableMachines])

  const provenIds = useMemo(() => new Set(proven.map(m => m.id)), [proven])

  const grouped = useMemo(() => {
    const byLocation = {}
    for (const m of availableMachines) {
      if (provenIds.has(m.id)) continue
      const locName = m.location?.name || 'Unknown Location'
      const brand = m.machine_type || 'Other'
      if (!byLocation[locName]) byLocation[locName] = {}
      if (!byLocation[locName][brand]) byLocation[locName][brand] = []
      byLocation[locName][brand].push(m)
    }
    const naturalCompare = (a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    for (const loc of Object.keys(byLocation)) {
      for (const brand of Object.keys(byLocation[loc])) {
        byLocation[loc][brand].sort(naturalCompare)
      }
    }
    // Location ordering: Leesburg first, Tavares next, others alphabetically.
    const locOrder = Object.keys(byLocation).sort((a, b) => {
      const score = (s) => {
        const lc = s.toLowerCase()
        if (lc.includes('leesburg')) return 0
        if (lc.includes('tavares')) return 1
        return 2
      }
      const sa = score(a)
      const sb = score(b)
      if (sa !== sb) return sa - sb
      return a.localeCompare(b)
    })
    return locOrder.map(loc => ({
      name: loc,
      brands: Object.keys(byLocation[loc]).sort().map(b => ({
        name: b,
        machines: byLocation[loc][b]
      }))
    }))
  }, [availableMachines, provenIds])

  if (availableMachines.length === 0) {
    return <p className="text-gray-500 italic">No production machines available.</p>
  }

  return (
    <div>
      <p className="text-gray-400 text-sm mb-3">
        Choose a machine for this job.
        {proven.length > 0 && (
          <span className="text-cyan-300/90">
            {' '}Machines that have run this part are listed first.
          </span>
        )}
      </p>

      {proven.length === 0 && (
        <p className="text-gray-500 text-xs mb-4">
          No machine has produced this part since SkyNet went live in April 2026. Earlier runs
          exist only on paper, so an absent history is not evidence a machine cannot make it —
          the Preferred star reflects master-data capability.
        </p>
      )}

      {proven.length > 0 && (
        <div className="mb-5">
          <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-cyan-300/80 font-semibold border-b border-cyan-900/50 pb-1.5 mb-2">
            <History size={12} />
            Has run this part
            <span className="text-gray-500 normal-case tracking-normal font-normal">
              ({proven.length} machine{proven.length === 1 ? '' : 's'})
            </span>
          </div>
          <div className="space-y-2">
            {proven.map(m => (
              <MachinePickCard
                key={m.id}
                m={m}
                selected={m.id === selectedMachineId}
                onSelect={setSelectedMachineId}
                showPlacement
              />
            ))}
          </div>
        </div>
      )}

      {proven.length > 0 && grouped.length > 0 && (
        <div className="text-xs uppercase tracking-wider text-gray-500 font-semibold mb-3">
          Other machines
        </div>
      )}

      {grouped.map((loc, li) => (
        <div key={loc.name} className={li > 0 ? 'mt-5' : ''}>
          <div className="text-xs uppercase tracking-wider text-gray-500 font-semibold border-b border-gray-800 pb-1.5 mb-2">
            {loc.name}
          </div>
          {loc.brands.map(brand => (
            <div key={brand.name} className="mb-3">
              <div className="text-sm text-gray-400 font-medium mb-1.5 mt-2">
                {brand.name}
              </div>
              <div className="space-y-2">
                {brand.machines.map(m => (
                  <MachinePickCard
                    key={m.id}
                    m={m}
                    selected={m.id === selectedMachineId}
                    onSelect={setSelectedMachineId}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// ─────────── Step 2: Position picker ───────────

function Step2Position({ machine, queue, insertionIndex, setInsertionIndex, minInsertionIndex, fmtDateTime, fmtDueShort, newJobDue }) {
  if (!machine) return <p className="text-gray-500">No machine selected.</p>

  if (queue.length === 0) {
    return (
      <div>
        <p className="text-gray-400 mb-3">
          No jobs queued on <span className="text-white font-medium">{machine.name}</span>.
        </p>
        <InsertionSlot
          label="Place as first job in queue"
          active={insertionIndex === 0}
          onClick={() => setInsertionIndex(0)}
        />
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <p className="text-gray-400 text-sm mb-3">
        Pick where in <span className="text-white font-medium">{machine.name}</span>'s queue this job should go.
      </p>

      {minInsertionIndex === 0 && (
        <InsertionSlot
          label="Place at front of queue"
          active={insertionIndex === 0}
          onClick={() => setInsertionIndex(0)}
        />
      )}

      {queue.map((q, i) => {
        const isRunning = isJobRunning(q)
        const slotAfterIdx = i + 1
        const slotAfterAllowed = slotAfterIdx >= minInsertionIndex
        const isLastSlot = slotAfterIdx === queue.length
        return (
          <div key={q.id}>
            <div className={`p-3 rounded-lg border ${
              isRunning ? 'bg-green-900/10 border-green-800' : 'bg-gray-800 border-gray-700'
            }`}>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  {isRunning && (
                    <span className="text-xs px-1.5 py-0.5 bg-green-900/50 text-green-400 border border-green-700/50 rounded font-bold">RUNNING</span>
                  )}
                  <span className="text-white font-mono text-sm">{q.component?.part_number || q.job_number}</span>
                  <span className="text-gray-600">·</span>
                  <span className="text-skynet-accent font-mono text-xs">{q.job_number}</span>
                </div>
                <span className="text-gray-500 text-xs">
                  {fmtDateTime(q.scheduled_start)} → {fmtDateTime(q.scheduled_end)}
                </span>
              </div>
              {/* D-SCHED-21: the due date is the fact that decides the slot.
                  Amber = this queued job is due AFTER the one being scheduled
                  (candidate to slot ahead of). Red = this queued job already
                  finishes past its own due date. due_date is a DATE column;
                  compare against end of day, matching the late-schedule check. */}
              {(() => {
                const qDue = q.work_order?.due_date || null
                const qLate = !!qDue && !!q.scheduled_end &&
                  new Date(q.scheduled_end) > new Date(qDue + 'T23:59:59')
                const dueAfterNew = !!qDue && !!newJobDue && qDue > newJobDue
                const chipClass = qLate
                  ? 'bg-red-900/40 text-red-300 border-red-800/60'
                  : dueAfterNew
                    ? 'bg-amber-900/40 text-amber-300 border-amber-700/60'
                    : 'bg-gray-800 text-gray-400 border-gray-700'
                const chipTitle = qLate
                  ? 'Already scheduled to finish after its due date'
                  : dueAfterNew
                    ? 'Due later than the job you are scheduling'
                    : qDue ? 'Due on or before the job you are scheduling' : 'No customer due date'
                return (
                  <div className="mt-1.5 flex items-center gap-2 flex-wrap text-xs">
                    <span
                      className={`px-1.5 py-0.5 rounded border font-medium ${chipClass}`}
                      title={chipTitle}
                    >
                      Due {fmtDueShort(qDue)}
                    </span>
                    {q.work_order?.customer && (
                      <span className="text-gray-500 truncate max-w-[260px]" title={q.work_order.customer}>
                        {q.work_order.customer}
                      </span>
                    )}
                  </div>
                )
              })()}
            </div>
            {slotAfterAllowed && (
              <InsertionSlot
                label={isLastSlot ? 'Place last in queue' : 'Insert here'}
                active={insertionIndex === slotAfterIdx}
                onClick={() => setInsertionIndex(slotAfterIdx)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function InsertionSlot({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`w-full my-1 py-2 border-2 border-dashed rounded-lg transition-all text-sm ${
        active
          ? 'border-skynet-accent bg-skynet-accent/10 text-skynet-accent font-medium'
          : 'border-gray-700 hover:border-gray-500 text-gray-500 hover:text-gray-300'
      }`}
    >
      <span className="flex items-center justify-center gap-2">
        <ArrowRight size={14} className="rotate-90" />
        {label}
      </span>
    </button>
  )
}

// ─────────── Step 3: Duration entry ───────────

function Step3Duration({
  machine, queue, insertionIndex,
  durationDays, setDurationDays, durationHours, setDurationHours,
  totalMinutes, propagation, fmtDateTime, job, isMachineSwapRevert,
  isLateSchedule, dueDateDisplay,
  partsPerDay, setPartsPerDay, applyPartsPerDay, suggestedPartsPerDay,
  members = []
}) {
  const beforeJob = queue[insertionIndex - 1]
  const afterJob = queue[insertionIndex]
  const targetSlot = propagation?.targetSlot
  const cascadeJobs = propagation?.changes || []

  let placementText = 'First job on this machine'
  if (beforeJob && afterJob) {
    placementText = `Between ${beforeJob.component?.part_number || beforeJob.job_number} and ${afterJob.component?.part_number || afterJob.job_number}`
  } else if (beforeJob) {
    placementText = `After ${beforeJob.component?.part_number || beforeJob.job_number} (last in queue)`
  } else if (afterJob) {
    placementText = `Before ${afterJob.component?.part_number || afterJob.job_number} (first in queue)`
  }

  return (
    <div className="space-y-5">
      <div className="bg-gray-800/50 rounded-lg p-3 text-sm">
        <p className="text-gray-300">
          <span className="text-white font-mono">{job.component?.part_number || job.job_number}</span> on <span className="text-white font-medium">{machine?.name}</span>
        </p>
        <p className="text-gray-500 text-xs mt-1">{placementText}</p>
      </div>

      {(machine?.status === 'down' || machine?.status === 'offline') && (
        <div className="flex items-start gap-2 p-3 bg-red-900/30 border border-red-700 rounded-lg text-sm">
          <AlertTriangle size={15} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-red-200">
            <span className="font-semibold">{machine.name} is {machine.status.toUpperCase()}.</span>{' '}
            Scheduling is allowed so the queue can be pre-loaded, but these dates hold only once the machine is running. The queue starts when it comes back up.
          </p>
        </div>
      )}

      <div>
        <label className="block text-gray-400 text-sm mb-2">Parts per day</label>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="number"
            min="1"
            value={partsPerDay}
            onChange={(e) => {
              const v = e.target.value
              setPartsPerDay(v)
              applyPartsPerDay(v)
            }}
            placeholder="—"
            className="w-24 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-center focus:outline-none focus:border-skynet-accent"
          />
          <span className="text-gray-400 text-sm">parts / 24h day</span>
          {suggestedPartsPerDay && (
            <span className="text-gray-500 text-xs">
              ≈ {suggestedPartsPerDay.rate.toLocaleString()}/day from {suggestedPartsPerDay.runCount} completed run{suggestedPartsPerDay.runCount === 1 ? '' : 's'}
              {suggestedPartsPerDay.machineSpecific ? ' on this machine' : ' (all machines)'}
            </span>
          )}
        </div>
        <p className="text-gray-500 text-xs mt-1">
          Duration = qty {getRunTarget(job, members).toLocaleString()}{members.length > 0 ? ` (incl. ${members.length} merged)` : ''} ÷ parts/day, +10% buffer, rounded up to the whole hour. Estimate — adjust below if needed.
        </p>
      </div>

      <div>
        <label className="block text-gray-400 text-sm mb-2">Estimated duration</label>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="0"
              max="365"
              value={durationDays}
              onChange={(e) => setDurationDays(Math.max(0, parseInt(e.target.value, 10) || 0))}
              className="w-20 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-center focus:outline-none focus:border-skynet-accent"
            />
            <span className="text-gray-400 text-sm">days</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="0"
              max="23"
              value={durationHours}
              onChange={(e) => setDurationHours(Math.max(0, Math.min(23, parseInt(e.target.value, 10) || 0)))}
              className="w-20 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-center focus:outline-none focus:border-skynet-accent"
            />
            <span className="text-gray-400 text-sm">hours</span>
          </div>
          {totalMinutes > 0 && (
            <span className="text-gray-500 text-sm ml-1">
              = {formatDurationDH(totalMinutes)} ({totalMinutes.toLocaleString()} min)
            </span>
          )}
        </div>
        {totalMinutes === 0 && (
          <p className="text-amber-400 text-xs mt-2 flex items-center gap-1">
            <AlertTriangle size={12} /> Duration must be greater than 0.
          </p>
        )}
      </div>

      {isMachineSwapRevert && (
        <div className="bg-amber-900/30 border border-amber-700 rounded p-3 text-amber-200 text-sm flex items-start gap-2">
          <AlertTriangle size={16} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Returns to Compliance for re-review</p>
            <p className="text-xs text-amber-300/80 mt-1">
              Changing machines on an approved job resets compliance approval and all document approvals to pending. Roger will re-review against the new machine's doc set.
            </p>
          </div>
        </div>
      )}
      {isLateSchedule && (
        <div className="bg-amber-900/30 border border-amber-700 rounded p-3 text-amber-200 text-sm flex items-start gap-2">
          <AlertTriangle size={16} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <div>
            Scheduled finish {fmtDateTime(targetSlot?.scheduled_end)} is after the customer due date {dueDateDisplay}.
          </div>
        </div>
      )}
      {targetSlot && totalMinutes > 0 && (
        <div className="bg-gray-800/50 rounded-lg p-3 space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-400">Start</span>
            <span className="text-white font-mono">{fmtDateTime(targetSlot.scheduled_start)}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-400">End</span>
            <span className="text-white font-mono">{fmtDateTime(targetSlot.scheduled_end)}</span>
          </div>
        </div>
      )}

      {cascadeJobs.length > 0 && (
        <div>
          <p className="text-gray-400 text-sm mb-2 flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-400" />
            Downstream impact ({cascadeJobs.length} job{cascadeJobs.length === 1 ? '' : 's'} will shift)
          </p>
          <div className="space-y-1">
            {cascadeJobs.map(c => (
              <div key={c.job.id} className="bg-gray-800/30 border border-gray-700 rounded p-2 text-xs flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-skynet-accent font-mono">{c.job.component?.part_number || c.job.job_number}</span>
                  <span className="text-gray-500">·</span>
                  <span className="text-gray-500 font-mono">{c.job.job_number}</span>
                </div>
                <span className="text-gray-500">
                  {fmtDateTime(c.job.scheduled_start)} → {fmtDateTime(c.newStart)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────── D-JOBMERGE-02: Step 1 merge card + confirmation ───────────

function MergeIntoRunSection({ job, candidates, onPick }) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-1">
        <Layers size={16} className="text-cyan-300" />
        <h4 className="text-white font-semibold">
          {job.component?.part_number || 'This part'} already has an active run
        </h4>
      </div>
      <p className="text-gray-500 text-xs mb-3">
        Merge this job into an existing run — one setup, one production lot. Pieces allocate back to each work order by earliest due date after compliance.
      </p>
      <div className="space-y-2">
        {candidates.map(c => (
          <button
            key={c.job_id}
            onClick={() => onPick(c)}
            className="w-full text-left bg-cyan-950/40 hover:bg-cyan-900/40 border border-cyan-700/60 rounded-lg p-3 transition-colors"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-skynet-accent font-mono text-sm">{c.job_number}</span>
                {c.status === 'in_progress' ? (
                  <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-green-500/20 text-green-400 rounded">RUNNING</span>
                ) : (
                  <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-gray-600/40 text-gray-300 rounded">QUEUED</span>
                )}
                {Number(c.member_count) > 0 && (
                  <span className="px-1.5 py-0.5 text-[10px] bg-cyan-500/20 text-cyan-300 rounded">{Number(c.member_count) + 1} orders</span>
                )}
              </div>
              <span className="text-white text-sm whitespace-nowrap">{c.machine_name || 'Not scheduled yet'}</span>
            </div>
            <div className="text-gray-400 text-xs mt-1 truncate">
              {[c.wo_number, c.customer, c.due_date ? `Due ${new Date(c.due_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : null].filter(Boolean).join(' · ')}
            </div>
            <div className="text-gray-500 text-xs mt-0.5">
              Run target {Number(c.run_target).toLocaleString()}
              {c.status === 'in_progress' ? ` · ${Number(c.produced_so_far).toLocaleString()} sent to finishing` : ''}
            </div>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-4 mb-1">
        <div className="flex-1 border-t border-gray-800"></div>
        <span className="text-gray-600 text-xs">or schedule separately</span>
        <div className="flex-1 border-t border-gray-800"></div>
      </div>
    </div>
  )
}

function MergeConfirmPanel({ job, target, merging, mergeError, onBack, onConfirm }) {
  const memberQty = job.quantity || 0
  const newTarget = Number(target.run_target || 0) + memberQty
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Layers size={18} className="text-cyan-300" />
        <h4 className="text-white font-semibold text-lg">
          Merge {job.job_number} into {target.job_number}
        </h4>
      </div>
      <div className="bg-gray-800/60 border border-gray-700 rounded-lg p-4 mb-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Host run target today</span>
          <span className="text-white font-mono">{Number(target.run_target).toLocaleString()}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">+ {job.job_number} ({job.work_order?.wo_number || 'no WO'})</span>
          <span className="text-white font-mono">{memberQty.toLocaleString()}</span>
        </div>
        <div className="flex justify-between text-sm border-t border-gray-700 pt-2">
          <span className="text-gray-300 font-medium">New run target</span>
          <span className="text-cyan-300 font-mono font-semibold">{newTarget.toLocaleString()}</span>
        </div>
      </div>
      <ul className="text-gray-400 text-xs space-y-1.5 mb-4 list-disc pl-4">
        <li>One setup, one production lot — {target.job_number} keeps its machine slot{target.machine_name ? ` on ${target.machine_name}` : ''}.</li>
        <li>{job.job_number} leaves the schedule; {job.work_order?.wo_number || 'its work order'} keeps its own order and receives its share of good pieces (earliest due date first) after compliance.</li>
        <li>Reversible from the Schedule screen until the host completes production.</li>
      </ul>
      {mergeError && (
        <div className="bg-red-900/30 border border-red-700 rounded p-2 text-red-300 text-sm flex items-center gap-2 mb-3">
          <AlertTriangle size={14} />
          {mergeError}
        </div>
      )}
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          disabled={merging}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
        >
          <ArrowLeft size={14} />
          Back
        </button>
        <button
          onClick={onConfirm}
          disabled={merging}
          className="flex items-center gap-1.5 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-sm font-medium rounded transition-colors"
        >
          {merging ? <Loader2 size={14} className="animate-spin" /> : <Layers size={14} />}
          {merging ? 'Merging...' : `Merge into ${target.job_number}`}
        </button>
      </div>
    </div>
  )
}
