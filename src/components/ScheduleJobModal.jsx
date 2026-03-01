import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import {
  X, Save, Loader2, Clock, Star, Database, AlertTriangle,
  Info, Calendar as CalendarIcon, ArrowRight, RotateCcw, ChevronRight
} from 'lucide-react'

const SHIFT_START = 7     // 7:00 AM
const SHIFT_END = 16      // 4:00 PM
const HOURS_PER_DAY = 24  // 1 day = 24 hours (jobs can run overnight as dark runs)
const MAX_CASCADE_DEPTH = 3
const MAX_SEARCH_DAYS = 30

export default function ScheduleJobModal({
  isOpen,
  onClose,
  onSuccess,
  job,
  machines,
  partMachineDurations,
  scheduledJobs,
  profile,
  editMode = false, // true when rescheduling an already-scheduled job
  defaults = null   // optional { date, machineId, startTime } from drag-and-drop
}) {
  const [selectedDate, setSelectedDate] = useState('')
  const [selectedMachineId, setSelectedMachineId] = useState('')
  const [startTime, setStartTime] = useState('07:00')
  const [durationDays, setDurationDays] = useState(0)
  const [durationHours, setDurationHours] = useState(1)
  const [durationMinutes, setDurationMinutes] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [nextAvailableNote, setNextAvailableNote] = useState(null)

  // Overlap resolution state
  const [conflicts, setConflicts] = useState([])
  const [conflictResolutions, setConflictResolutions] = useState({})

  // Format estimated minutes for display in dropdown: "~3h" or "~3h 20m"
  const formatEstimate = (minutes) => {
    if (!minutes || minutes <= 0) return ''
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    if (h === 0) return ` (~${m}m)`
    if (m === 0) return ` (~${h}h)`
    return ` (~${h}h ${m}m)`
  }

  // Format HH:MM to display string like "7:00 AM"
  const formatTimeDisplay = (timeStr) => {
    const [h, m] = timeStr.split(':').map(Number)
    const ampm = h >= 12 ? 'PM' : 'AM'
    const h12 = h % 12 || 12
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
  }

  // Get machine preferences for this job's part — three tiers:
  // 1. Preferred (is_preferred=true), 2. Secondary (has record, not preferred), 3. Other (no record)
  const machineOptions = useMemo(() => {
    if (!job?.component_id) return []

    const records = partMachineDurations.filter(d => d.part_id === job.component_id)
    const recordIds = new Set(records.map(r => r.machine_id))
    const activeMachines = machines.filter(m => m.is_active)

    // Tier 1: Preferred — is_preferred=true, sorted by preference_order
    const preferredRecords = records
      .filter(r => r.is_preferred)
      .sort((a, b) => (a.preference_order || 99) - (b.preference_order || 99))

    const preferred = preferredRecords
      .map(r => {
        const machine = activeMachines.find(m => m.id === r.machine_id)
        if (!machine) return null
        return { ...machine, tier: 'preferred', durationRecord: r, isPreferred: true }
      })
      .filter(Boolean)

    // Tier 2: Secondary — has record but not preferred, sorted by preference_order then estimated_minutes
    const secondaryRecords = records
      .filter(r => !r.is_preferred)
      .sort((a, b) => {
        const orderDiff = (a.preference_order || 99) - (b.preference_order || 99)
        if (orderDiff !== 0) return orderDiff
        return (a.estimated_minutes || 9999) - (b.estimated_minutes || 9999)
      })

    const secondary = secondaryRecords
      .map(r => {
        const machine = activeMachines.find(m => m.id === r.machine_id)
        if (!machine) return null
        return { ...machine, tier: 'secondary', durationRecord: r, isPreferred: false }
      })
      .filter(Boolean)

    // Tier 3: Other — no part_machine_durations record, sorted by display_order then name
    const others = activeMachines
      .filter(m => !recordIds.has(m.id))
      .sort((a, b) => (a.display_order || 999) - (b.display_order || 999) || a.name.localeCompare(b.name))
      .map(m => ({ ...m, tier: 'other', durationRecord: null, isPreferred: false }))

    return [...preferred, ...secondary, ...others]
  }, [job?.component_id, machines, partMachineDurations])

  // Whether this part has ANY machine preference records at all
  const hasAnyPreferences = useMemo(() => {
    return machineOptions.some(m => m.tier === 'preferred' || m.tier === 'secondary')
  }, [machineOptions])

  // Business hours validation
  const timeValidation = useMemo(() => {
    if (!startTime) return null
    const [h, m] = startTime.split(':').map(Number)
    if (h < SHIFT_START || h > SHIFT_END || (h === SHIFT_END && m > 0)) {
      return 'Start time must be between 7:00 AM and 4:00 PM'
    }
    if (m % 15 !== 0) return 'Start time must be in 15-minute increments'
    return null
  }, [startTime])

  // Compute duration in minutes from a part_machine_durations record (pure, no state)
  const computeDurationFromRecord = (record) => {
    if (!record?.estimated_minutes) return null
    let minutes = record.estimated_minutes
    if (record.base_quantity && record.base_quantity > 0 && job?.quantity > 0) {
      minutes = Math.max(15, Math.round((job.quantity / record.base_quantity) * minutes))
    }
    return minutes
  }

  // Set duration state from a total minutes value
  const setDurationFromMinutes = (minutes) => {
    const days = Math.floor(minutes / (HOURS_PER_DAY * 60))
    const remainingAfterDays = minutes - (days * HOURS_PER_DAY * 60)
    const hours = Math.floor(remainingAfterDays / 60)
    const mins = remainingAfterDays % 60
    setDurationDays(days)
    setDurationHours(hours)
    setDurationMinutes(mins)
  }

  // Load duration estimate from a machine record into state
  const loadDurationFromRecord = (record) => {
    const minutes = computeDurationFromRecord(record)
    if (!minutes) return
    setDurationFromMinutes(minutes)
  }

  // Find next available slot on a machine, scanning up to 30 days.
  // Returns { date: 'YYYY-MM-DD', time: 'HH:MM' } or null.
  const findNextAvailable = (machineId, fromDateStr, durationMin) => {
    const [yr, mo, dy] = fromDateStr.split('-').map(Number)
    const startDate = new Date(yr, mo - 1, dy, 0, 0, 0, 0)

    // Get all jobs on this machine (sorted by start)
    const allMachineJobs = scheduledJobs
      .filter(sj => {
        if (editMode && sj.id === job?.id) return false
        if (sj.assigned_machine_id !== machineId) return false
        return true
      })
      .map(sj => ({
        start: new Date(sj.scheduled_start),
        end: sj.scheduled_end
          ? new Date(sj.scheduled_end)
          : new Date(new Date(sj.scheduled_start).getTime() + (sj.estimated_minutes || 60) * 60000)
      }))
      .sort((a, b) => a.start - b.start)

    for (let dayOffset = 0; dayOffset < MAX_SEARCH_DAYS; dayOffset++) {
      const checkDate = new Date(startDate)
      checkDate.setDate(checkDate.getDate() + dayOffset)

      const shiftStartTime = new Date(checkDate)
      shiftStartTime.setHours(SHIFT_START, 0, 0, 0)
      const shiftEndTime = new Date(checkDate)
      shiftEndTime.setHours(SHIFT_END, 0, 0, 0)

      // For today, earliest candidate is max(now rounded to 15-min, shift start)
      let candidate = new Date(shiftStartTime)
      if (dayOffset === 0) {
        const now = new Date()
        if (checkDate.toDateString() === now.toDateString()) {
          const roundedMins = Math.ceil(now.getMinutes() / 15) * 15
          const nowRounded = new Date(now)
          nowRounded.setMinutes(roundedMins, 0, 0)
          if (nowRounded > candidate) candidate = nowRounded
        }
      }

      // If already past shift end, skip to next day
      if (candidate >= shiftEndTime) continue

      // Try to find a slot on this day
      let found = false
      while (candidate < shiftEndTime) {
        const candidateEnd = new Date(candidate.getTime() + durationMin * 60000)

        let hasOverlap = false
        for (const existing of allMachineJobs) {
          // Skip jobs that end before our candidate starts
          if (existing.end <= candidate) continue
          // If this job starts after our candidate would end, no overlap
          if (existing.start >= candidateEnd) continue
          // Overlap — advance candidate past this job
          candidate = new Date(existing.end)
          const mins = candidate.getMinutes()
          if (mins % 15 !== 0) {
            candidate.setMinutes(Math.ceil(mins / 15) * 15, 0, 0)
          }
          hasOverlap = true
          break
        }

        if (!hasOverlap) {
          found = true
          break
        }
      }

      if (found && candidate < shiftEndTime) {
        const dateStr = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`
        return {
          date: dateStr,
          time: `${String(candidate.getHours()).padStart(2, '0')}:${String(candidate.getMinutes()).padStart(2, '0')}`
        }
      }
    }

    return null // No slot found in MAX_SEARCH_DAYS days
  }

  // Run auto-calculation: find next available and update date/time state
  const runAutoCalc = (machineId, dateStr, durMinutes) => {
    if (!machineId || !dateStr) return

    const result = findNextAvailable(machineId, dateStr, durMinutes || 60)
    if (result) {
      setStartTime(result.time)
      if (result.date !== dateStr) {
        setSelectedDate(result.date)
        const [ry, rm, rd] = result.date.split('-').map(Number)
        const noteDate = new Date(ry, rm - 1, rd)
        const formatted = noteDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
        setNextAvailableNote(`Next available: ${formatted} at ${formatTimeDisplay(result.time)}`)
      } else {
        setNextAvailableNote(null)
      }
    } else {
      setStartTime('07:00')
      setNextAvailableNote('No available slot found in the next 30 days on this machine')
    }
  }

  // Initialize form when job changes
  useEffect(() => {
    if (!job || !isOpen) return

    machineChangeRef.current = false // reset so machine-change effect knows this is init
    setSaveError(null)
    setConflicts([])
    setConflictResolutions({})
    setNextAvailableNote(null)

    if (editMode && job.scheduled_start) {
      // Edit mode: pre-fill from existing job schedule
      const existingStart = new Date(job.scheduled_start)
      const y = existingStart.getFullYear()
      const m = String(existingStart.getMonth() + 1).padStart(2, '0')
      const d = String(existingStart.getDate()).padStart(2, '0')
      setSelectedDate(`${y}-${m}-${d}`)

      // Clamp start time to shift hours (7 AM – 4 PM), round to 15-min
      let h = existingStart.getHours()
      let min = existingStart.getMinutes()
      if (h < SHIFT_START || h > SHIFT_END || (h === SHIFT_END && min > 0)) {
        setStartTime('07:00')
      } else {
        min = Math.round(min / 15) * 15
        if (min === 60) { h += 1; min = 0 }
        setStartTime(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`)
      }

      setSelectedMachineId(job.assigned_machine_id || '')

      // Pre-fill duration from estimated_minutes
      const totalMin = job.estimated_minutes || 60
      setDurationFromMinutes(totalMin)
    } else if (defaults) {
      // Drag-and-drop: pre-fill from drop target context
      setSelectedDate(defaults.date)
      setSelectedMachineId(defaults.machineId)
      if (defaults.startTime) {
        setStartTime(defaults.startTime)
        skipNextAutoCalcRef.current = true // don't override the drop-position time
      }
      // Duration will be loaded by machine-change effect
    } else {
      // New schedule: set date, auto-select machine.
      // Start time will be set by machine-change effect via runAutoCalc.
      const today = new Date()
      setSelectedDate(today.toISOString().split('T')[0])
      setStartTime('07:00') // fallback; machine-change effect will override

      const firstPreferred = machineOptions.find(m => m.isPreferred)
      if (firstPreferred) {
        setSelectedMachineId(firstPreferred.id)
        // Duration + start time computed by machine-change effect
      } else if (machineOptions.length > 0) {
        setSelectedMachineId(machineOptions[0].id)
      } else {
        setSelectedMachineId('')
      }
    }
  }, [job?.id, isOpen, editMode])

  // When machine changes: load duration estimate + auto-calc next available
  const machineChangeRef = useRef(false)
  const skipNextAutoCalcRef = useRef(false)
  useEffect(() => {
    if (!selectedMachineId || !job?.component_id) return
    // On first call after init: skip entirely for edit mode (duration + time already set)
    if (!machineChangeRef.current) {
      machineChangeRef.current = true
      if (editMode) return
    }

    const record = partMachineDurations.find(
      d => d.part_id === job.component_id && d.machine_id === selectedMachineId
    )

    // Compute duration: prefer machine estimate, fall back to current state
    let durMin = (durationDays * HOURS_PER_DAY * 60) + (durationHours * 60) + durationMinutes
    if (record) {
      const computed = computeDurationFromRecord(record)
      if (computed) durMin = computed
      loadDurationFromRecord(record)
    }

    // Auto-calc next available start time (skip if drag-and-drop provided a specific time)
    if (skipNextAutoCalcRef.current) {
      skipNextAutoCalcRef.current = false
    } else if (selectedDate) {
      runAutoCalc(selectedMachineId, selectedDate, durMin || 60)
    }
  }, [selectedMachineId])

  // Handle date change: update state only (don't auto-calc — user may intentionally
  // pick a busy date to use the overlap conflict resolution flow)
  const handleDateChange = (newDate) => {
    setSelectedDate(newDate)
    setNextAvailableNote(null)
  }

  // "Next Available" button handler
  const handleNextAvailableClick = () => {
    if (!selectedMachineId || !selectedDate) return
    const durMin = (durationDays * HOURS_PER_DAY * 60) + (durationHours * 60) + durationMinutes
    runAutoCalc(selectedMachineId, selectedDate, durMin || 60)
  }

  // Check for overlaps when date/time/duration/machine changes
  useEffect(() => {
    if (!selectedMachineId || !selectedDate || !startTime) {
      setConflicts([])
      setConflictResolutions({})
      return
    }

    const totalMin = (durationDays * HOURS_PER_DAY * 60) + (durationHours * 60) + durationMinutes
    if (totalMin <= 0) {
      setConflicts([])
      setConflictResolutions({})
      return
    }

    const [hours, mins] = startTime.split(':').map(Number)
    const [yr, mo, dy] = selectedDate.split('-').map(Number)
    const start = new Date(yr, mo - 1, dy, hours, mins, 0, 0)
    const end = new Date(start.getTime() + totalMin * 60000)

    const newConflicts = scheduledJobs.filter(sj => {
      if (editMode && sj.id === job?.id) return false // exclude self in edit mode
      if (sj.assigned_machine_id !== selectedMachineId) return false
      const sjStart = new Date(sj.scheduled_start)
      const sjEnd = sj.scheduled_end
        ? new Date(sj.scheduled_end)
        : new Date(sjStart.getTime() + (sj.estimated_minutes || 60) * 60000)
      return start < sjEnd && end > sjStart
    })

    setConflicts(newConflicts)
    // Preserve existing resolutions for conflicts that still exist, clear stale ones
    setConflictResolutions(prev => {
      const kept = {}
      newConflicts.forEach(c => {
        if (prev[c.id]) kept[c.id] = prev[c.id]
      })
      return kept
    })
  }, [selectedMachineId, selectedDate, startTime, durationDays, durationHours, durationMinutes, scheduledJobs])

  // Snap a Date to the next valid business-hours start time.
  // If within shift (7 AM – 4 PM), round up to next 15-min. If after 4 PM, next day 7 AM.
  const snapToBusinessHours = (date) => {
    const d = new Date(date)
    const h = d.getHours()
    const m = d.getMinutes()

    if (h < SHIFT_START) {
      // Before shift: snap to shift start same day
      d.setHours(SHIFT_START, 0, 0, 0)
    } else if (h > SHIFT_END || (h === SHIFT_END && m > 0)) {
      // After shift end: next day 7 AM
      d.setDate(d.getDate() + 1)
      d.setHours(SHIFT_START, 0, 0, 0)
    } else {
      // Within shift: round up to next 15-min
      if (m % 15 !== 0) {
        d.setMinutes(Math.ceil(m / 15) * 15, 0, 0)
      }
    }
    return d
  }

  // Cascade preview: compute all moves resulting from "push back" resolutions
  const cascadePreview = useMemo(() => {
    if (conflicts.length === 0) return { moves: [], tooDeep: false }

    const totalMin = (durationDays * HOURS_PER_DAY * 60) + (durationHours * 60) + durationMinutes
    if (totalMin <= 0 || !startTime || !selectedDate) return { moves: [], tooDeep: false }

    const [h, m] = startTime.split(':').map(Number)
    const [yr, mo, dy] = selectedDate.split('-').map(Number)
    const newJobEnd = new Date(yr, mo - 1, dy, h, m, 0, 0)
    newJobEnd.setTime(newJobEnd.getTime() + totalMin * 60000)

    // IDs to skip: the job being edited, and jobs being returned to queue
    const skipIds = new Set()
    if (editMode && job?.id) skipIds.add(job.id)
    conflicts.forEach(c => {
      if (conflictResolutions[c.id] === 'return_to_queue') skipIds.add(c.id)
    })

    const moves = []
    let tooDeep = false
    const processedIds = new Set([...skipIds])

    // Seed queue with direct "push back" conflicts sorted by their current start time
    const queue = conflicts
      .filter(c => conflictResolutions[c.id] === 'push_back')
      .sort((a, b) => new Date(a.scheduled_start) - new Date(b.scheduled_start))
      .map(c => {
        processedIds.add(c.id)
        return { job: c, pushAfter: newJobEnd, depth: 1 }
      })

    while (queue.length > 0) {
      const item = queue.shift()

      if (item.depth > MAX_CASCADE_DEPTH) {
        tooDeep = true
        continue
      }

      const dur = item.job.estimated_minutes || 60

      // Snap pushAfter to next valid business-hours start time
      // If after SHIFT_END (4 PM), advance to SHIFT_START (7 AM) next day
      let actualStart = snapToBusinessHours(new Date(item.pushAfter))

      // Avoid overlapping with already-computed moves
      let settled = false
      while (!settled) {
        settled = true
        const candidateEnd = new Date(actualStart.getTime() + dur * 60000)
        for (const mv of moves) {
          if (actualStart < mv.newEnd && candidateEnd > mv.newStart) {
            actualStart = snapToBusinessHours(new Date(mv.newEnd))
            settled = false
            break
          }
        }
      }

      const newStart = actualStart
      const newEnd = new Date(newStart.getTime() + dur * 60000)
      moves.push({ job: item.job, newStart, newEnd, depth: item.depth })

      // Find cascade conflicts with remaining scheduled jobs
      scheduledJobs.forEach(sj => {
        if (processedIds.has(sj.id)) return
        if (sj.assigned_machine_id !== selectedMachineId) return

        const sjStart = new Date(sj.scheduled_start)
        const sjEnd = sj.scheduled_end
          ? new Date(sj.scheduled_end)
          : new Date(sjStart.getTime() + (sj.estimated_minutes || 60) * 60000)

        if (newStart < sjEnd && newEnd > sjStart) {
          queue.push({ job: sj, pushAfter: newEnd, depth: item.depth + 1 })
          processedIds.add(sj.id)
        }
      })
    }

    return { moves, tooDeep }
  }, [conflicts, conflictResolutions, selectedDate, startTime, durationDays, durationHours, durationMinutes, scheduledJobs, selectedMachineId, editMode, job?.id])

  // Whether all conflicts are resolved and ready to save
  const allConflictsResolved = conflicts.length === 0 ||
    (conflicts.every(c => conflictResolutions[c.id]) && !cascadePreview.tooDeep)

  const handleSave = async () => {
    if (!job || !selectedMachineId || !selectedDate || !startTime) return
    if (timeValidation) return

    const totalMinutes = (durationDays * HOURS_PER_DAY * 60) + (durationHours * 60) + durationMinutes
    if (totalMinutes <= 0) {
      setSaveError('Duration must be greater than 0.')
      return
    }

    // All conflicts must be resolved
    if (!allConflictsResolved) {
      setSaveError('Please resolve all schedule conflicts before saving.')
      return
    }

    setSaving(true)
    setSaveError(null)

    try {
      const [hours, mins] = startTime.split(':').map(Number)
      const [yr, mo, dy] = selectedDate.split('-').map(Number)
      const scheduledStart = new Date(yr, mo - 1, dy, hours, mins, 0, 0)
      const scheduledEnd = new Date(scheduledStart.getTime() + totalMinutes * 60000)

      // Execute conflict resolutions before saving the main job
      // 1. Return-to-queue jobs: unschedule them
      const returnJobs = conflicts.filter(c => conflictResolutions[c.id] === 'return_to_queue')
      for (const rj of returnJobs) {
        const { error } = await supabase
          .from('jobs')
          .update({
            status: 'ready',
            assigned_machine_id: null,
            scheduled_start: null,
            scheduled_end: null,
            scheduled_by: null,
            scheduled_at: null
          })
          .eq('id', rj.id)

        if (error) {
          console.error('Error returning job to queue:', error)
          setSaveError(`Failed to return ${rj.job_number} to queue.`)
          setSaving(false)
          return
        }
      }

      // 2. Push-back jobs (including cascades): update their times
      for (const move of cascadePreview.moves) {
        const { error } = await supabase
          .from('jobs')
          .update({
            scheduled_start: move.newStart.toISOString(),
            scheduled_end: move.newEnd.toISOString()
          })
          .eq('id', move.job.id)

        if (error) {
          console.error('Error pushing back job:', error)
          setSaveError(`Failed to push back ${move.job.job_number}.`)
          setSaving(false)
          return
        }
      }

      // 3. Save the new/edited job
      const { error } = await supabase
        .from('jobs')
        .update({
          assigned_machine_id: selectedMachineId,
          scheduled_start: scheduledStart.toISOString(),
          scheduled_end: scheduledEnd.toISOString(),
          estimated_minutes: totalMinutes,
          status: 'assigned',
          scheduled_by: profile?.id,
          scheduled_at: new Date().toISOString()
        })
        .eq('id', job.id)

      if (error) {
        console.error('Error scheduling job:', error)
        setSaveError('Failed to schedule job. Please try again.')
      } else {
        onSuccess()
      }
    } catch (error) {
      console.error('Unexpected error scheduling job:', error)
      setSaveError('An unexpected error occurred.')
    } finally {
      setSaving(false)
    }
  }

  // Format total duration for display
  const totalMinutes = (durationDays * HOURS_PER_DAY * 60) + (durationHours * 60) + durationMinutes
  const formatTotalDuration = () => {
    if (totalMinutes <= 0) return '0m'
    const d = Math.floor(totalMinutes / (HOURS_PER_DAY * 60))
    const remaining = totalMinutes - (d * HOURS_PER_DAY * 60)
    const h = Math.floor(remaining / 60)
    const m = remaining % 60
    const parts = []
    if (d > 0) parts.push(`${d}d`)
    if (h > 0) parts.push(`${h}h`)
    if (m > 0) parts.push(`${m}m`)
    return parts.join(' ') || '0m'
  }

  if (!isOpen || !job) return null

  const selectedMachine = machineOptions.find(m => m.id === selectedMachineId) ||
    machines.find(m => m.id === selectedMachineId)
  const hasDurationRecord = selectedMachine?.durationRecord != null

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 rounded-lg border border-gray-700 p-6 max-w-lg w-full mx-4 shadow-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-xl font-bold text-white flex items-center gap-2">
              <CalendarIcon size={20} className="text-skynet-accent" />
              {editMode ? 'Reschedule Job' : 'Schedule Job'}
            </h3>
            <p className="text-gray-400 text-sm mt-1">
              {editMode ? 'Change machine, date, or time' : 'Assign a machine, date, and time'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors"
          >
            <X size={24} />
          </button>
        </div>

        {/* Job Info Card */}
        <div className="bg-gray-800 rounded-lg p-4 mb-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-white font-mono font-bold">{job.job_number}</span>
            <div className={`w-2 h-2 rounded-full ${
              job.priority === 'critical' ? 'bg-red-500' :
              job.priority === 'high' ? 'bg-yellow-500' :
              job.priority === 'normal' ? 'bg-green-500' :
              'bg-gray-500'
            }`} />
            {job.status === 'incomplete' && (
              <span className="text-xs bg-red-900/50 text-red-400 px-2 py-0.5 rounded flex items-center gap-1">
                <AlertTriangle size={10} />
                Incomplete
              </span>
            )}
          </div>
          <p className="text-skynet-accent font-medium">{job.component?.part_number}</p>
          <div className="flex items-center gap-4 mt-1">
            <span className="text-gray-400 text-sm">{job.work_order?.wo_number}</span>
            <span className="text-gray-400 text-sm">Qty: {job.quantity}</span>
            {job.work_order?.customer && (
              <span className="text-gray-500 text-sm truncate">{job.work_order.customer}</span>
            )}
          </div>
          {job.work_order?.due_date && (
            <p className="text-gray-500 text-sm mt-1">
              Due: {new Date(job.work_order.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
          )}
        </div>

        {/* Form Fields */}
        <div className="space-y-4">
          {/* Date Picker */}
          <div>
            <label className="block text-gray-400 text-sm mb-1">Schedule Date</label>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => handleDateChange(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
              style={{ colorScheme: 'dark' }}
            />
            {nextAvailableNote && (
              <p className={`text-xs mt-1 flex items-center gap-1 ${
                nextAvailableNote.startsWith('No available')
                  ? 'text-yellow-400'
                  : 'text-blue-400'
              }`}>
                <Info size={10} />
                {nextAvailableNote}
              </p>
            )}
          </div>

          {/* Machine Dropdown */}
          <div>
            <label className="block text-gray-400 text-sm mb-1">Machine</label>
            <select
              value={selectedMachineId}
              onChange={(e) => setSelectedMachineId(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent appearance-none"
              style={{ colorScheme: 'dark' }}
            >
              <option value="">Select a machine...</option>
              {machineOptions.length > 0 && !hasAnyPreferences && (
                /* No preference records — flat list */
                machineOptions.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name} — {m.location?.name || 'Unknown'}
                  </option>
                ))
              )}
              {machineOptions.length > 0 && hasAnyPreferences && (
                <>
                  {/* Tier 1: Preferred */}
                  {machineOptions.some(m => m.tier === 'preferred') && (
                    <optgroup label="⭐ Preferred">
                      {machineOptions.filter(m => m.tier === 'preferred').map(m => (
                        <option key={m.id} value={m.id}>
                          ★ {m.name} — {m.location?.name || 'Unknown'}
                          {formatEstimate(m.durationRecord?.estimated_minutes)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {/* Tier 2: Secondary */}
                  {machineOptions.some(m => m.tier === 'secondary') && (
                    <optgroup label="Secondary">
                      {machineOptions.filter(m => m.tier === 'secondary').map(m => (
                        <option key={m.id} value={m.id}>
                          {m.name} — {m.location?.name || 'Unknown'}
                          {formatEstimate(m.durationRecord?.estimated_minutes)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {/* Tier 3: Other Machines */}
                  {machineOptions.some(m => m.tier === 'other') && (
                    <optgroup label="Other Machines">
                      {machineOptions.filter(m => m.tier === 'other').map(m => (
                        <option key={m.id} value={m.id}>
                          {m.name} — {m.location?.name || 'Unknown'}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </>
              )}
            </select>
            {hasDurationRecord && (
              <p className="text-blue-400 text-xs mt-1 flex items-center gap-1">
                <Database size={10} />
                Duration loaded from saved estimates
                {selectedMachine?.durationRecord?.base_quantity && selectedMachine.durationRecord.base_quantity !== job.quantity && (
                  <span className="text-gray-500 ml-1">
                    (scaled: {selectedMachine.durationRecord.base_quantity} → {job.quantity} pcs)
                  </span>
                )}
              </p>
            )}
          </div>

          {/* Start Time */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-gray-400 text-sm">Start Time</label>
              <button
                type="button"
                onClick={handleNextAvailableClick}
                disabled={!selectedMachineId || !selectedDate}
                className="flex items-center gap-1 text-xs text-skynet-accent hover:text-blue-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Clock size={12} />
                Next Available
              </button>
            </div>
            <input
              type="time"
              value={startTime}
              onChange={(e) => {
                setStartTime(e.target.value)
                setNextAvailableNote(null)
              }}
              min="07:00"
              max="16:00"
              step="900"
              className={`w-full px-3 py-2 bg-gray-800 border rounded text-white focus:outline-none focus:border-skynet-accent ${
                timeValidation ? 'border-red-600' : 'border-gray-700'
              }`}
              style={{ colorScheme: 'dark' }}
            />
            {timeValidation && (
              <p className="text-red-400 text-xs mt-1 flex items-center gap-1">
                <AlertTriangle size={10} />
                {timeValidation}
              </p>
            )}
            {!timeValidation && (
              <p className="text-gray-600 text-xs mt-1">Shift hours: 7:00 AM – 4:00 PM, 15-min steps</p>
            )}
          </div>

          {/* Duration: Days | Hours | Minutes */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-gray-400 text-sm">Estimated Duration</label>
              <span className="text-gray-500 text-xs">
                Total: <span className="text-white font-medium">{formatTotalDuration()}</span>
                <span className="text-gray-600 ml-1">({totalMinutes}m)</span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                max="30"
                value={durationDays}
                onChange={(e) => setDurationDays(parseInt(e.target.value) || 0)}
                className="w-16 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent text-center"
              />
              <span className="text-gray-400 text-sm">days</span>
              <input
                type="number"
                min="0"
                max="23"
                value={durationHours}
                onChange={(e) => setDurationHours(parseInt(e.target.value) || 0)}
                className="w-16 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent text-center"
              />
              <span className="text-gray-400 text-sm">hrs</span>
              <input
                type="number"
                min="0"
                max="59"
                step="15"
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(parseInt(e.target.value) || 0)}
                className="w-16 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent text-center"
              />
              <span className="text-gray-400 text-sm">min</span>
            </div>
            <p className="text-gray-600 text-xs mt-1">1 day = {HOURS_PER_DAY} hours</p>
          </div>

          {/* Conflict Resolution Panel */}
          {conflicts.length > 0 && (
            <div className="bg-red-900/20 border border-red-700 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle size={18} className="text-red-400" />
                <span className="text-red-400 font-medium text-sm">
                  Schedule Conflict{conflicts.length > 1 ? 's' : ''} ({conflicts.length} job{conflicts.length > 1 ? 's' : ''})
                </span>
              </div>
              <p className="text-gray-400 text-xs mb-3">Resolve each conflict before saving.</p>

              <div className="space-y-3">
                {conflicts.map(c => {
                  const cStart = new Date(c.scheduled_start)
                  const cEnd = c.scheduled_end
                    ? new Date(c.scheduled_end)
                    : new Date(cStart.getTime() + (c.estimated_minutes || 60) * 60000)
                  const resolution = conflictResolutions[c.id]
                  const move = cascadePreview.moves.find(m => m.job.id === c.id)

                  return (
                    <div key={c.id} className="bg-gray-800/80 rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-white font-mono text-sm font-medium">{c.job_number}</span>
                        {c.component?.part_number && (
                          <span className="text-skynet-accent text-xs">{c.component.part_number}</span>
                        )}
                        <span className="text-gray-500 text-xs">
                          {cStart.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                          {' – '}
                          {cEnd.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                        </span>
                      </div>

                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setConflictResolutions(prev => ({ ...prev, [c.id]: 'push_back' }))}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                            resolution === 'push_back'
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                          }`}
                        >
                          <ArrowRight size={12} />
                          Push back
                        </button>
                        <button
                          type="button"
                          onClick={() => setConflictResolutions(prev => ({ ...prev, [c.id]: 'return_to_queue' }))}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                            resolution === 'return_to_queue'
                              ? 'bg-orange-600 text-white'
                              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                          }`}
                        >
                          <RotateCcw size={12} />
                          Return to queue
                        </button>
                      </div>

                      {/* Push-back destination preview */}
                      {resolution === 'push_back' && move && (
                        <p className="text-blue-400 text-xs mt-2 flex items-center gap-1">
                          <ChevronRight size={10} />
                          Moves to {move.newStart.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                          {' – '}
                          {move.newEnd.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                          {move.newStart.toDateString() !== new Date(c.scheduled_start).toDateString() && (
                            <span className="text-gray-500 ml-1">
                              ({move.newStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})
                            </span>
                          )}
                        </p>
                      )}

                      {/* Return-to-queue confirmation */}
                      {resolution === 'return_to_queue' && (
                        <p className="text-orange-400 text-xs mt-2 flex items-center gap-1">
                          <RotateCcw size={10} />
                          Will be unscheduled and returned to the job pool
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Cascade effects */}
              {cascadePreview.moves.filter(m => m.depth > 1).length > 0 && (
                <div className="mt-3 bg-blue-900/20 border border-blue-800 rounded p-2.5">
                  <p className="text-blue-400 text-xs font-medium mb-1.5">Cascade Effects:</p>
                  {cascadePreview.moves.filter(m => m.depth > 1).map(m => (
                    <p key={m.job.id} className="text-blue-300/70 text-xs flex items-center gap-1 py-0.5">
                      <ChevronRight size={10} />
                      {'→ '.repeat(m.depth - 1)}{m.job.job_number} moves to{' '}
                      {m.newStart.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                      {' – '}
                      {m.newEnd.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                    </p>
                  ))}
                </div>
              )}

              {/* Cascade too deep warning */}
              {cascadePreview.tooDeep && (
                <p className="text-red-400 text-xs mt-2 flex items-center gap-1">
                  <AlertTriangle size={10} />
                  Push-back cascade exceeds {MAX_CASCADE_DEPTH} levels. Return some jobs to queue instead.
                </p>
              )}

              {/* All resolved indicator */}
              {allConflictsResolved && conflicts.length > 0 && (
                <p className="text-green-400 text-xs mt-2 font-medium">All conflicts resolved — ready to save.</p>
              )}
            </div>
          )}

          {/* Error */}
          {saveError && (
            <div className="p-3 bg-red-900/50 border border-red-700 rounded text-red-300 text-sm">
              {saveError}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={
                saving ||
                !selectedMachineId ||
                !selectedDate ||
                totalMinutes <= 0 ||
                !!timeValidation ||
                !allConflictsResolved
              }
              className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  {editMode ? 'Updating...' : 'Scheduling...'}
                </>
              ) : (
                <>
                  <Save size={18} />
                  {editMode ? 'Update Schedule' : 'Schedule Job'}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
