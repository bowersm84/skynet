import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import {
  X, Loader2, AlertTriangle, ArrowLeft, ArrowRight, Star,
  CheckCircle, Calendar as CalendarIcon, RotateCcw, Layers, History
} from 'lucide-react'
import {
  getMachineQueue, isJobRunning, buildPropagatedQueue,
  formatDurationDH, applySchedule,
  fetchPartThroughputRuns, partsPerDayToMinutes,
  fetchPartMachineHistory,
  // D-SCHED-27: length-family evidence, the rate ladder, and the card helpers.
  fetchPartFamily, fetchLengthFamilyHistory, fetchObservedMaterial,
  fetchRunningMaterials, fetchMatchingPolicies, fetchJobFirstRun,
  buildRateLadder, projectFinish, isAfterCommit, materialAffinity
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
  // D-SCHED-27: the length family this part belongs to, what that family has done on
  // each machine, the bar it runs on, the standing rules that name it, and whether this
  // job is the first of its kind in SkyNet.
  const [family, setFamily] = useState(null)
  const [familyHistory, setFamilyHistory] = useState([])
  const [observedMaterial, setObservedMaterial] = useState({ part: null, family: null })
  const [runningMaterials, setRunningMaterials] = useState({})
  const [policies, setPolicies] = useState([])
  const [firstRun, setFirstRun] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)

  // D-JOBMERGE-02: Step 1 merge card state
  const [mergeCandidates, setMergeCandidates] = useState([])
  const [mergeTarget, setMergeTarget] = useState(null)
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState(null)
  // D-CODATE-02: earliest SkyNet target / Fishbowl due across the WO's active
  // CO allocations (v_wo_dates). Null for MTS work orders.
  const [woDates, setWoDates] = useState(null)
  // D-CODATE-02b: the same row for every WO in the machine queues, keyed by
  // work_order_id, so Step 2 compares queued jobs on the same commitment basis.
  const [queueWoDates, setQueueWoDates] = useState({})

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
  // D-SCHED-19: which machines have actually made this part, and how fast.
  // D-SCHED-27: plus the length family's own record, the bar it runs on, the standing
  // rules naming it, and the first-run flag. The family key has to land first — every
  // other family read is keyed on it — so it leads and the rest go out together.
  useEffect(() => {
    if (!isOpen || !job?.component_id) {
      setHistoryRuns([]); setPartMachineHistory({}); setFamily(null); setFamilyHistory([])
      setObservedMaterial({ part: null, family: null }); setPolicies([]); setFirstRun(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const fam = await fetchPartFamily(supabase, job.component_id)
      if (cancelled) return
      setFamily(fam)
      const key = fam?.length_family_key || null
      const [runs, byMachine, famHistory, material, pols, fr] = await Promise.all([
        fetchPartThroughputRuns(supabase, job.component_id, job?.id),
        fetchPartMachineHistory(supabase, job.component_id, job?.id),
        fetchLengthFamilyHistory(supabase, key),
        fetchObservedMaterial(supabase, job.component_id, key),
        fetchMatchingPolicies(supabase, job.component?.part_number, key),
        fetchJobFirstRun(supabase, job?.id)
      ])
      if (cancelled) return
      setHistoryRuns(runs)
      setPartMachineHistory(byMachine)
      setFamilyHistory(famHistory)
      setObservedMaterial(material)
      setPolicies(pols)
      setFirstRun(fr)
    })()
    return () => { cancelled = true }
  }, [isOpen, job?.component_id, job?.id, job?.component?.part_number])

  // D-CODATE-02b: WO dates for everything in the machine queues (chunked —
  // the id list travels in the URL).
  useEffect(() => {
    if (!isOpen) { setQueueWoDates({}); return }
    const ids = [...new Set((scheduledJobs || []).map(j => j.work_order_id).filter(Boolean))]
    if (ids.length === 0) { setQueueWoDates({}); return }
    let cancelled = false
    ;(async () => {
      const out = {}
      for (let i = 0; i < ids.length; i += 150) {
        const { data, error } = await supabase
          .from('v_wo_dates')
          .select('work_order_id, target_date, fb_due_date')
          .in('work_order_id', ids.slice(i, i + 150))
        if (error) { console.error('v_wo_dates (queue):', error); break }
        for (const r of data || []) out[r.work_order_id] = r
      }
      if (!cancelled) setQueueWoDates(out)
    })()
    return () => { cancelled = true }
  }, [isOpen, scheduledJobs])

  // D-CODATE-02: the WO's target date, fetched here so the modal is correct
  // whichever screen opened it.
  useEffect(() => {
    if (!isOpen || !job?.work_order_id) { setWoDates(null); return }
    let cancelled = false
    supabase
      .from('v_wo_dates')
      .select('work_order_id, target_date, fb_due_date, entered_on, allocation_count')
      .eq('work_order_id', job.work_order_id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) { console.error('v_wo_dates:', error); setWoDates(null); return }
        setWoDates(data || null)
      })
    return () => { cancelled = true }
  }, [isOpen, job?.work_order_id])

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

  // D-SCHED-10: parts/day → duration (+10% buffer, rounded up to the hour)
  const applyPartsPerDay = (value) => {
    const total = partsPerDayToMinutes(getRunTarget(job, members), value)
    if (total === null) return
    setDurationDays(Math.floor(total / (24 * 60)))
    setDurationHours(Math.floor((total % (24 * 60)) / 60))
  }

  // D-DATE-03: warn (never block) when the scheduled finish lands after the
  // commitment date. D-CODATE-02: that is the SkyNet target (entered + 45
  // business days) when the WO has CO allocations, else the WO's own due_date.
  // Both are DATE columns, so compare against end of day.
  const commitDate = woDates?.target_date || job?.work_order?.due_date || null
  const commitLabel = woDates?.target_date ? 'SkyNet target' : 'due date'

  const baseMachines = useMemo(() => {
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

  // D-SCHED-27: what each candidate machine has in the bar right now. Keyed on the
  // running job ids alone so it does not wait on the family fetch.
  const runningJobIds = useMemo(
    () => [...new Set(baseMachines.map(m => m.runningJob?.id).filter(Boolean))].sort(),
    [baseMachines]
  )
  const runningJobIdsKey = runningJobIds.join(',')

  useEffect(() => {
    if (!isOpen || runningJobIds.length === 0) { setRunningMaterials({}); return }
    let cancelled = false
    fetchRunningMaterials(supabase, runningJobIds).then(byJob => {
      if (!cancelled) setRunningMaterials(byJob)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, runningJobIdsKey])

  // D-SCHED-27: family record, rate ladder, projected finish vs target, and material
  // affinity per machine — so a scheduler who knows nothing about the part or the
  // machines can read a card on its own and see why one placement beats another.
  const availableMachines = useMemo(() => {
    const familyKey = family?.length_family_key || null
    const partBar = observedMaterial.part || observedMaterial.family || null
    const runTarget = getRunTarget(job, members)
    const now = new Date()
    return baseMachines.map(m => {
      const famRow = familyKey ? (familyHistory.find(f => f.machine_id === m.id) || null) : null
      const ladder = buildRateLadder({
        partHistory: partMachineHistory,
        partRuns: historyRuns,
        familyHistory,
        machines,
        machineId: m.id,
        familyKey
      })
      const startAt = m.lastEnd && m.lastEnd > now ? m.lastEnd : now
      const projectedFinish = projectFinish({ startAt, qty: runTarget, rate: ladder.chosen?.rate })
      // The family proved itself on a sister machine of the same model but never here.
      const sameModelRow = ladder.evidence.find(e => e.tier === 'family_same_model') || null
      return {
        ...m,
        familyHistory: famRow,
        ladder,
        projectedFinish,
        projectedLate: isAfterCommit(projectedFinish, commitDate),
        material: materialAffinity(partBar, runningMaterials[m.runningJob?.id] || null),
        sameModelFamily: !famRow && !!sameModelRow,
        sameModelPeer: sameModelRow?.machineName || null
      }
    })
  }, [
    baseMachines, family, familyHistory, observedMaterial, runningMaterials,
    partMachineHistory, historyRuns, machines, job, members, commitDate
  ])

  const selectedMachine = availableMachines.find(m => m.id === selectedMachineId)

  // D-SCHED-27: the rate that fills Parts per day is the top of the ladder for the
  // machine actually chosen — part on this machine, then its length family here, then
  // the part elsewhere, then the family on the same model, then the family anywhere.
  // Always the calendar rate: the duration math and its +10% buffer are tuned on it.
  const selectedLadder = selectedMachine?.ladder || null
  const suggestedPartsPerDay = selectedLadder?.chosen || null

  // D-SCHED-10: prefill from history on entering Step 3; never clobber an existing duration.
  useEffect(() => {
    if (step !== 3 || partsPerDay !== '' || !suggestedPartsPerDay) return
    setPartsPerDay(String(suggestedPartsPerDay.rate))
    if (totalMinutes === 0) applyPartsPerDay(suggestedPartsPerDay.rate)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, suggestedPartsPerDay])

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

  // D-SCHED-25: rescheduling an already-assigned job onto a different machine
  // no longer reverts compliance. The RPC stamps the traveler stale and notifies
  // compliance; the machinist can start on the new machine. Pending-compliance
  // reschedules just switch machines silently.
  const isMachineChange =
    editMode &&
    job?.status === 'assigned' &&
    job?.assigned_machine_id &&
    job.assigned_machine_id !== selectedMachineId

  // D-DATE-03 / D-CODATE-02: commitDate and commitLabel are computed above, alongside
  // the machine cards that project their finish against them.
  const isLateSchedule =
    !!commitDate &&
    !!propagation?.targetSlot &&
    new Date(propagation.targetSlot.scheduled_end) > new Date(commitDate + 'T23:59:59')

  const fmtDueShort = (d) =>
    d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

  const handleSchedule = async () => {
    if (!canSubmit) return
    if (isLateSchedule) {
      const ok = window.confirm(
        `This job is scheduled to finish after the ${commitLabel} (${fmtDueShort(commitDate)}). Schedule anyway?`
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
        revertCompliance: false
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
          {woDates?.target_date ? (<>
            <span className="text-gray-600">·</span>
            <span className="text-gray-200 text-sm" title="SkyNet target: entered + 45 business days (earliest across this WO's customer-order lines)">
              Target {fmtDueShort(woDates.target_date)}
            </span>
            {woDates.fb_due_date && (
              <span className="text-gray-500 text-xs" title="Fishbowl due date (earliest across this WO's lines)">
                FB {new Date(woDates.fb_due_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            )}
          </>) : job.work_order?.due_date && (<>
            <span className="text-gray-600">·</span>
            <span className="text-gray-400 text-sm">Due {new Date(job.work_order.due_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
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
                familyKey={family?.length_family_key || null}
                familyHistory={familyHistory}
                firstRun={firstRun}
                policies={policies}
                commitDate={commitDate}
                partNumber={job.component?.part_number || job.job_number}
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
              newJobDue={commitDate}
              woDatesById={queueWoDates}
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
              ladder={selectedLadder}
              familyKey={family?.length_family_key || null}
              commitDate={commitDate}
              propagation={propagation}
              fmtDateTime={fmtDateTime}
              job={job}
              isMachineChange={isMachineChange}
              isLateSchedule={isLateSchedule}
              dueDateDisplay={fmtDueShort(commitDate)}
              dueDateLabel={commitLabel}
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
                {saving ? 'Scheduling...' : editMode ? 'Save changes' : 'Schedule'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────── Step 1: Machine picker ───────────

// D-SCHED-27 display helpers. Steady rate reads as a range when the clean waypoint
// intervals disagree and as one number when they don't.
function fmtSteadyRange(row) {
  const lo = row?.steady_min
  const hi = row?.steady_max
  if (lo != null && hi != null && lo !== hi) return `${lo.toLocaleString()}–${hi.toLocaleString()}`
  const one = lo ?? hi ?? row?.steady_median
  return one != null ? one.toLocaleString() : '—'
}

const fmtDashList = (dashes) =>
  dashes?.length ? dashes.map(d => `-${d}`).join(', ') : null

const fmtProjDay = (d) =>
  d ? new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '—'

// Commitment dates are DATE columns — anchor at local noon so they never render a day early.
const fmtCommitDay = (d) =>
  d ? new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'

function MachinePickCard({ m, selected, onSelect, showPlacement, commitDate }) {
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
      {/* D-SCHED-27: what the rest of the length family has done here. Calendar rate
          leads because it is the guide; steady is the context behind it. */}
      {m.familyHistory && (
        <div className="text-xs text-violet-300/90 mt-1">
          Family {m.familyHistory.length_family_key}: {m.familyHistory.runs} run{m.familyHistory.runs === 1 ? '' : 's'}
          {fmtDashList(m.familyHistory.dashes) && ` · ${fmtDashList(m.familyHistory.dashes)}`}
          {m.familyHistory.calendar_rate != null && ` · ${m.familyHistory.calendar_rate.toLocaleString()}/day`}
          {m.familyHistory.steady_median != null && ` · steady ${fmtSteadyRange(m.familyHistory)}`}
          {m.familyHistory.last_run_at && ` · last ${new Date(m.familyHistory.last_run_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
          {m.familyHistory.paper_runs > 0 && ` · ${m.familyHistory.paper_runs} unrated`}
        </div>
      )}
      {m.sameModelFamily && m.sameModelPeer && (
        <div className="text-xs text-gray-500 mt-1">
          Same model as {m.sameModelPeer} ({m.model}) — family untested here
        </div>
      )}
      {m.material?.label && (
        <div className={`text-xs mt-1 ${
          m.material.kind === 'same_bar'
            ? 'text-green-400'
            : m.material.kind === 'change'
              ? 'text-amber-400'
              : 'text-gray-500'
        }`}>
          {m.material.label}
        </div>
      )}
      {m.projectedFinish && (
        <div
          className={`text-xs mt-1 flex items-center gap-1 ${m.projectedLate ? 'text-amber-400' : 'text-gray-500'}`}
          title={m.ladder?.chosen
            ? `from ${m.ladder.chosen.label} (${m.ladder.chosen.rate.toLocaleString()}/day)`
            : undefined}
        >
          {m.projectedLate && <AlertTriangle size={11} className="shrink-0" />}
          <span>
            → this job ≈ {fmtProjDay(m.projectedFinish)}
            {commitDate && (m.projectedLate
              ? ` · after target ${fmtCommitDay(commitDate)}`
              : ` · target ${fmtCommitDay(commitDate)}`)}
          </span>
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

function Step1Machines({
  availableMachines, selectedMachineId, setSelectedMachineId,
  familyKey = null, familyHistory = [], firstRun = null, policies = [],
  commitDate = null, partNumber = ''
}) {
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

  // D-SCHED-27: machines where the length family has run but this exact length has not.
  // The next-strongest evidence after the part's own history, so it gets its own section
  // between the proven machines and the grouped list. Moved, not duplicated.
  const familyOnly = useMemo(() => {
    if (!familyKey) return []
    return availableMachines
      .filter(m => m.familyHistory && !m.partHistory)
      .sort((a, b) => {
        const ra = a.familyHistory.calendar_rate ?? -1
        const rb = b.familyHistory.calendar_rate ?? -1
        if (ra !== rb) return rb - ra
        if (a.familyHistory.runs !== b.familyHistory.runs) return b.familyHistory.runs - a.familyHistory.runs
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      })
  }, [availableMachines, familyKey])

  const liftedIds = useMemo(
    () => new Set([...proven.map(m => m.id), ...familyOnly.map(m => m.id)]),
    [proven, familyOnly]
  )

  // Machines the family has actually run on, for the first-run banner's "its family has" clause.
  const familyRunMachines = useMemo(
    () => [...new Set((familyHistory || []).map(f => f.machine_name).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })),
    [familyHistory]
  )

  const grouped = useMemo(() => {
    const byLocation = {}
    for (const m of availableMachines) {
      if (liftedIds.has(m.id)) continue
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
  }, [availableMachines, liftedIds])

  if (availableMachines.length === 0) {
    return <p className="text-gray-500 italic">No production machines available.</p>
  }

  return (
    <div>
      {/* D-SCHED-27: a first run is the one thing the scheduler most needs to know
          before picking anything — it leads. */}
      {firstRun?.first_run_kind && (
        <div className="mb-4 flex items-start gap-2 p-3 bg-amber-900/30 border border-amber-700 rounded-lg text-sm">
          <AlertTriangle size={15} className="text-amber-400 mt-0.5 shrink-0" />
          <p className="text-amber-200">
            {firstRun.first_run_kind === 'part_and_family' ? (
              <>
                <span className="font-semibold">First run in SkyNet.</span>{' '}
                No run of <span className="font-mono">{partNumber}</span>
                {familyKey ? <>, or its <span className="font-mono">{familyKey}</span> family,</> : null}
                {' '}since go-live. Expect programming and a first article; consider attended and extra setup.
              </>
            ) : (
              <>
                <span className="font-semibold">First run of this length.</span>{' '}
                <span className="font-mono">{partNumber}</span> has not run since go-live; its{' '}
                <span className="font-mono">{familyKey}</span> family has
                {familyRunMachines.length > 0 ? ` (${familyRunMachines.join(', ')})` : ''}.
              </>
            )}
          </p>
        </div>
      )}

      {policies.length > 0 && (
        <div className="mb-4 bg-gray-800/50 border border-gray-700 rounded-lg p-3">
          <p className="text-xs uppercase tracking-wider text-gray-400 font-semibold mb-1.5">
            Standing rules for this part
          </p>
          <ul className="space-y-1">
            {policies.map(p => (
              <li key={p.id} className="text-gray-300 text-sm">{p.policy_text}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-gray-400 text-sm mb-3">
        Choose a machine for this job.
        {proven.length > 0 && (
          <span className="text-cyan-300/90">
            {' '}Machines that have run this part are listed first.
          </span>
        )}
        {proven.length === 0 && familyOnly.length > 0 && (
          <span className="text-violet-300/90">
            {' '}No machine has run this exact length; machines that have run the{' '}
            <span className="font-mono">{familyKey}</span> family are listed first.
          </span>
        )}
      </p>

      {proven.length === 0 && familyOnly.length === 0 && (
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
                commitDate={commitDate}
              />
            ))}
          </div>
        </div>
      )}

      {familyOnly.length > 0 && (
        <div className="mb-5">
          <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-violet-300/80 font-semibold border-b border-violet-900/50 pb-1.5 mb-2">
            <Layers size={12} />
            Family has run here · {familyKey}
            <span className="text-gray-500 normal-case tracking-normal font-normal">
              ({familyOnly.length} machine{familyOnly.length === 1 ? '' : 's'})
            </span>
          </div>
          <div className="space-y-2">
            {familyOnly.map(m => (
              <MachinePickCard
                key={m.id}
                m={m}
                selected={m.id === selectedMachineId}
                onSelect={setSelectedMachineId}
                showPlacement
                commitDate={commitDate}
              />
            ))}
          </div>
        </div>
      )}

      {(proven.length > 0 || familyOnly.length > 0) && grouped.length > 0 && (
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
                    commitDate={commitDate}
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

function Step2Position({ machine, queue, insertionIndex, setInsertionIndex, minInsertionIndex, fmtDateTime, fmtDueShort, newJobDue, woDatesById = {} }) {
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
              {/* D-SCHED-21: the commitment date is the fact that decides the slot.
                  Amber = this queued job is committed AFTER the one being scheduled
                  (candidate to slot ahead of). Red = this queued job already
                  finishes past its own commitment. D-CODATE-02b: the commitment
                  is the SkyNet target (entered + 45 business days) when the WO has
                  CO allocations, else its due_date — same basis as newJobDue.
                  DATE columns; compare against end of day. */}
              {(() => {
                const qd = woDatesById[q.work_order_id]
                const qDue = qd?.target_date || q.work_order?.due_date || null
                const qLabel = qd?.target_date ? 'Target' : 'Due'
                const qLate = !!qDue && !!q.scheduled_end &&
                  new Date(q.scheduled_end) > new Date(qDue + 'T23:59:59')
                const dueAfterNew = !!qDue && !!newJobDue && qDue > newJobDue
                const chipClass = qLate
                  ? 'bg-red-900/40 text-red-300 border-red-800/60'
                  : dueAfterNew
                    ? 'bg-amber-900/40 text-amber-300 border-amber-700/60'
                    : 'bg-gray-800 text-gray-400 border-gray-700'
                const chipTitle = qLate
                  ? `Already scheduled to finish after its ${qLabel.toLowerCase()}`
                  : dueAfterNew
                    ? `${qLabel} later than the job you are scheduling`
                    : qDue ? `${qLabel} on or before the job you are scheduling` : 'No commitment date'
                return (
                  <div className="mt-1.5 flex items-center gap-2 flex-wrap text-xs">
                    <span
                      className={`px-1.5 py-0.5 rounded border font-medium ${chipClass}`}
                      title={chipTitle}
                    >
                      {qLabel} {fmtDueShort(qDue)}
                    </span>
                    {qd?.target_date && qd?.fb_due_date && (
                      <span className="text-gray-600" title="Fishbowl due date">
                        FB {fmtDueShort(qd.fb_due_date)}
                      </span>
                    )}
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

// D-SCHED-27: per-dash calendar rates from the family's runs_detail, piece-weighted
// where one length ran more than once. A length trend without a regression.
function buildPerDash(detail) {
  const byDash = new Map()
  for (const d of detail || []) {
    if (d?.dash == null) continue
    const acc = byDash.get(d.dash) || { pieces: 0, days: 0 }
    const rate = Number(d.calendar_rate)
    const pieces = Number(d.pieces) || 0
    if (rate > 0 && pieces > 0) {
      acc.pieces += pieces
      acc.days += pieces / rate
    }
    byDash.set(d.dash, acc)
  }
  const parts = [...byDash.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([dash, v]) => `-${dash} ${v.days > 0 ? Math.round(v.pieces / v.days).toLocaleString() : '—'}`)
  return parts.length ? parts.join(' · ') : null
}

// One rung of the rate ladder. The chosen tier carries ●; every rated line offers a
// one-click Use, and the steady rate rides beneath it as a second, smaller override.
function EvidenceLine({ e, chosen, onUse }) {
  const dashes = e.dashes?.length ? e.dashes.map(d => `-${d}`).join(',') : null
  const perDash = buildPerDash(e.detail)
  const ratedRuns = e.ratedRuns || 0
  const steadyRange = (e.steadyMin != null && e.steadyMax != null && e.steadyMin !== e.steadyMax)
    ? ` (${e.steadyMin.toLocaleString()}–${e.steadyMax.toLocaleString()})`
    : ''
  const noRunText = e.runs > 0
    ? (e.paperRuns === e.runs ? 'unrated (paper record)' : 'unrated')
    : 'no run'

  return (
    <div>
      <div className="flex items-start justify-between gap-2 text-xs">
        <span className={chosen ? 'text-white' : 'text-gray-400'}>
          <span className={`mr-1 ${chosen ? 'text-skynet-accent' : 'text-transparent'}`}>●</span>
          {e.label}
        </span>
        {e.rate != null ? (
          <span className="flex items-center gap-2 shrink-0">
            <span className={`font-mono ${chosen ? 'text-white' : 'text-gray-300'}`}>
              {e.rate.toLocaleString()}/day
            </span>
            <span className="text-gray-500">
              · {ratedRuns} rated run{ratedRuns === 1 ? '' : 's'}
              {dashes ? ` · ${dashes}` : ''}
              {e.machineNames?.length ? ` (${e.machineNames.join(', ')})` : ''}
            </span>
            <button
              type="button"
              onClick={() => onUse(e.rate)}
              className="px-1.5 py-0.5 text-[10px] bg-gray-700 hover:bg-gray-600 text-gray-200 rounded shrink-0"
            >
              Use {e.rate.toLocaleString()}
            </button>
          </span>
        ) : (
          <span className="text-gray-600 shrink-0">{noRunText}</span>
        )}
      </div>
      {e.rate != null && e.steadyMedian != null && (
        <div className="flex items-center justify-end gap-2 text-[11px] mt-0.5">
          <span className="text-gray-500">steady {e.steadyMedian.toLocaleString()}{steadyRange}</span>
          <button
            type="button"
            onClick={() => onUse(e.steadyMedian)}
            className="px-1 py-0.5 text-[9px] bg-gray-800 hover:bg-gray-700 text-gray-400 border border-gray-700 rounded shrink-0"
          >
            Use {e.steadyMedian.toLocaleString()}
          </button>
        </div>
      )}
      {perDash && (
        <div className="text-[11px] text-gray-600 mt-0.5 pl-4">{perDash}</div>
      )}
    </div>
  )
}

function Step3Duration({
  machine, queue, insertionIndex,
  durationDays, setDurationDays, durationHours, setDurationHours,
  totalMinutes, propagation, fmtDateTime, job, isMachineChange,
  isLateSchedule, dueDateDisplay, dueDateLabel = 'due date',
  partsPerDay, setPartsPerDay, applyPartsPerDay,
  ladder = null, familyKey = null, commitDate = null,
  members = []
}) {
  const beforeJob = queue[insertionIndex - 1]
  const afterJob = queue[insertionIndex]
  const targetSlot = propagation?.targetSlot
  const cascadeJobs = propagation?.changes || []

  // D-SCHED-27: the ladder, chosen rung first so the number in the box is explained
  // by the line directly above it; the rest follow in tier order as the alternatives.
  const evidenceLines = useMemo(() => {
    const ev = ladder?.evidence || []
    const chosenTier = ladder?.chosen?.tier
    if (!chosenTier) return ev
    return [...ev.filter(e => e.tier === chosenTier), ...ev.filter(e => e.tier !== chosenTier)]
  }, [ladder])

  const onUseRate = (rate) => {
    setPartsPerDay(String(rate))
    applyPartsPerDay(rate)
  }

  const basisText = ladder?.chosen
    ? `Prefilled from ${ladder.chosen.label} — calendar ${ladder.chosen.rate.toLocaleString()}/day.`
    : familyKey
      ? 'No kiosk-timed run of this part or its family yet — enter a rate.'
      : 'No kiosk-timed run of this part yet — enter a rate.'

  // Days between the scheduled finish and the commitment. D-DATE-03: the commitment is
  // a DATE, so it is judged at end of day.
  const targetDelta = (() => {
    if (!commitDate || !targetSlot?.scheduled_end) return null
    const end = new Date(targetSlot.scheduled_end)
    const commitEnd = new Date(String(commitDate).slice(0, 10) + 'T23:59:59')
    const days = Math.round((commitEnd - end) / 86400000)
    return { days: Math.abs(days), late: days < 0 }
  })()

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
        </div>

        {evidenceLines.length > 0 && (
          <div className="mt-2 bg-gray-800/40 border border-gray-700/60 rounded p-2.5 space-y-1.5">
            {evidenceLines.map(e => (
              <EvidenceLine
                key={e.tier}
                e={e}
                chosen={ladder?.chosen?.tier === e.tier}
                onUse={onUseRate}
              />
            ))}
          </div>
        )}

        <p className="text-gray-400 text-xs mt-2">{basisText}</p>
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

      {isMachineChange && (
        <div className="bg-blue-900/30 border border-blue-700 rounded p-3 text-blue-200 text-sm flex items-start gap-2">
          <AlertTriangle size={16} className="text-blue-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Machine change — approvals stay in place</p>
            <p className="text-xs text-blue-300/80 mt-1">
              The traveler will show the new machine on reprint. Compliance is notified to reprint or acknowledge; the machinist can start on the new machine right away.
            </p>
          </div>
        </div>
      )}
      {isLateSchedule && (
        <div className="bg-amber-900/30 border border-amber-700 rounded p-3 text-amber-200 text-sm flex items-start gap-2">
          <AlertTriangle size={16} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <div>
            Scheduled finish {fmtDateTime(targetSlot?.scheduled_end)} is after the {dueDateLabel} {dueDateDisplay}.
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
          {/* D-SCHED-27: the commitment, right beside the finish it is judged against.
              The amber warning above carries the sentence; this row carries the margin. */}
          {commitDate && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">Target</span>
              <span className="flex items-center gap-2">
                <span className="text-white font-mono">{dueDateDisplay}</span>
                {targetDelta && (
                  <span className={`text-xs ${targetDelta.late ? 'text-amber-400' : 'text-gray-500'}`}>
                    {targetDelta.days === 0
                      ? 'same day'
                      : `${targetDelta.days} day${targetDelta.days === 1 ? '' : 's'} ${targetDelta.late ? 'late' : 'early'}`}
                  </span>
                )}
              </span>
            </div>
          )}
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
