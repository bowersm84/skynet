import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { fetchMergeHostCandidates, mergeJobIntoHost, unmergeJob, isMemberEligible, getRunTarget, isScheduleStale } from '../lib/jobMerge'
import { 
  ArrowLeft, 
  ChevronLeft, 
  ChevronRight,
  ChevronDown,
  Filter, 
  Search,
  Calendar,
  Clock,
  AlertCircle,
  AlertTriangle,
  GripVertical,
  User,
  X,
  Loader2,
  Database,
  Star,
  Info,
  ZoomIn,
  ZoomOut,
  Undo2,
  Trash2,
  Edit3,
  MapPin,
  Wrench,
  Layers,
  Plus,
  Settings,
  LayoutGrid,
  List,
  FastForward,
  CheckCircle,
  CalendarClock,
  Bot
} from 'lucide-react'
import CreateMaintenanceModal from '../components/CreateMaintenanceModal'
import ScheduleJobModal from '../components/ScheduleJobModal'
import { getMachineQueue, computeRemovalCascade, applyUnschedule, computeEndChangeCascade, applyEndDateChange, isJobRunning, formatDurationDH, fetchPartThroughputRuns, computePartsPerDaySuggestion, partsPerDayToMinutes } from '../lib/scheduling'
import AIAdvisorPanel from '../components/schedule/AIAdvisorPanel'
import { FEATURES } from '../config'

const ONGOING_STATUSES = [
  'in_setup',
  'in_progress',
  'pending_passivation',
  'in_passivation',
]

// D-SCHED-02: an ongoing job past its scheduled_end is still physically on
// the machine — the single test every overrun surface uses.
const isJobOverrun = (job) =>
  ONGOING_STATUSES.includes(job?.status) &&
  !!job?.scheduled_end &&
  new Date(job.scheduled_end).getTime() < Date.now()

// D-SCHED-03: scheduled but never started, and the whole slot has elapsed.
const MISSABLE_STATUSES = ['ready', 'assigned', 'pending_compliance']
const isJobMissedSlot = (job) =>
  MISSABLE_STATUSES.includes(job?.status) &&
  !!job?.scheduled_end &&
  new Date(job.scheduled_end).getTime() < Date.now()

// D-SCHED-03: for a missed-slot job whose slot fully predates today, the
// synthetic display span pinned at today's start (2h wide). Null when the job
// isn't pin-eligible — a slot missed earlier TODAY renders at its real
// position (amber via getJobBlockColor) with no pin. Display-only; the real
// scheduled_start/end are never modified.
const getMissedPinSpan = (job) => {
  if (!isJobMissedSlot(job)) return null
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  if (new Date(job.scheduled_end) >= todayStart) return null
  return {
    start: todayStart,
    end: new Date(todayStart.getTime() + 2 * 60 * 60 * 1000),
  }
}

// D-SCHED-04: display-only projection of each machine's live timeline.
//  - actual_end set  → machine freed then; bar truncates there.
//  - ongoing         → occupies until max(scheduled_end, now).
//  - queued          → once the chain has a LIVE anchor (completion or a
//    running job), queued work pulls to the cursor (floored at now),
//    durations preserved, gaps compressed. No anchor → plan untouched.
// Missed-slot jobs are excluded (D-SCHED-03 pins them; they occupy nothing).
// scheduled_start/end are never modified anywhere.
const buildProjection = (jobs) => {
  const byMachine = {}
  for (const j of jobs || []) {
    if (!j.assigned_machine_id || !j.scheduled_start) continue
    if (isJobMissedSlot(j)) continue
    ;(byMachine[j.assigned_machine_id] ||= []).push(j)
  }
  const map = {}
  const now = Date.now()
  for (const arr of Object.values(byMachine)) {
    arr.sort((a, b) => new Date(a.scheduled_start) - new Date(b.scheduled_start))
    let cursor = null
    for (const j of arr) {
      const schedStart = new Date(j.scheduled_start).getTime()
      const schedEnd = j.scheduled_end ? new Date(j.scheduled_end).getTime() : null
      if (j.actual_end) {
        // D-SCHED-08: completed bars carry their REAL occupancy span — the
        // same occupancy-ordered start as the ongoing branch (D-SCHED-07),
        // so a started-early-then-finished job doesn't render half-real
        // (right edge true, left edge planned). 30-minute floor guards
        // degenerate spans.
        const liveStart =
          j.setup_start || j.production_start || j.actual_start || null
        const start = liveStart ? new Date(liveStart).getTime() : schedStart
        const rawEnd = new Date(j.actual_end).getTime()
        const end = Math.max(rawEnd, start + 30 * 60000)
        map[j.id] = { start, end, truncated: !!schedEnd && rawEnd < schedEnd, projected: false }
        cursor = Math.max(cursor ?? end, end)
      } else if (ONGOING_STATUSES.includes(j.status)) {
        // D-SCHED-06/07: a running job's live start is where the MACHINE
        // became occupied. The kiosk stamps setup_start / production_start
        // (actual_start stays null in the live flow — confirmed on TEST
        // rows), so read through in occupancy order. Started-early work
        // pulls back to its true start instead of rendering as future work
        // while it runs. End extends per D-SCHED-02; the 30-minute floor
        // guards degenerate spans.
        const liveStart =
          j.setup_start || j.production_start || j.actual_start || null
        const start = liveStart ? new Date(liveStart).getTime() : schedStart
        const end = Math.max(schedEnd ?? now, now, start + 30 * 60000)
        map[j.id] = { start, end, truncated: false, projected: false }
        cursor = Math.max(cursor ?? end, end)
      } else if (MISSABLE_STATUSES.includes(j.status) && !j.is_maintenance) {
        // Genuinely queued production work — the ONLY pull-eligible class.
        if (cursor === null) {
          map[j.id] = {
            start: schedStart,
            end: schedEnd ?? (schedStart + (j.estimated_minutes || 60) * 60000),
            truncated: false,
            projected: false,
          }
          continue
        }
        const duration = schedEnd
          ? Math.max(schedEnd - schedStart, 30 * 60000)
          : (j.estimated_minutes || 60) * 60000
        const start = Math.max(cursor, now)
        const end = start + duration
        map[j.id] = { start, end, truncated: false, projected: Math.abs(start - schedStart) > 60000 }
        cursor = end
      } else {
        // D-SCHED-05: every other fall-through — terminal rows missing
        // actual_end (hand repairs, interrupted completions), queued
        // MAINTENANCE windows (fixed appointments), and any exotic status —
        // keeps its real span and advances the cursor. Finished work is
        // never future work; planned maintenance never slides.
        const end = schedEnd ?? schedStart
        map[j.id] = { start: schedStart, end, truncated: false, projected: false }
        cursor = Math.max(cursor ?? end, end)
      }
    }
  }
  return map
}

export default function Schedule({ user, profile, onNavigate, canEdit = false }) {
  const [unassignedJobs, setUnassignedJobs] = useState([])
  const [scheduledJobs, setScheduledJobs] = useState([])
  const [machines, setMachines] = useState([])
  const [partMachineDurations, setPartMachineDurations] = useState([])
  const [loading, setLoading] = useState(true)
  const [weekOffset, setWeekOffset] = useState(0)
  const [windowDays, setWindowDays] = useState(7) // grid zoom: 7 / 14 / 28 days visible
  
  // NEW: Track ongoing downtimes and active unplanned maintenance for DOWN status
  const [ongoingDowntimes, setOngoingDowntimes] = useState([])
  const [activeMaintenanceJobs, setActiveMaintenanceJobs] = useState([])
  
  // Zoom state
  const [zoomedDay, setZoomedDay] = useState(null) // Date object when zoomed into a day
  
  // Filter state
  const [filterBy, setFilterBy] = useState('wo_number')
  const [searchQuery, setSearchQuery] = useState('')
  const [showFilterMenu, setShowFilterMenu] = useState(false)
  
  // Selected job for detail popup
  const [selectedJob, setSelectedJob] = useState(null)

  // D-JOBMERGE-02: active merge allocations keyed by host job id
  const [mergeAllocs, setMergeAllocs] = useState({})
  
  // Drag and drop state
  const [draggedJob, setDraggedJob] = useState(null)
  const [draggedScheduledJob, setDraggedScheduledJob] = useState(null) // For rescheduling
  const [dropTarget, setDropTarget] = useState(null)
  
  // Shared save state (used by maintenance modal)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  
  // Unschedule confirmation
  const [unscheduleConfirm, setUnscheduleConfirm] = useState(null)
  const [closeGap, setCloseGap] = useState(true)
  
  // Cancel/Complete maintenance modal
  const [cancelMaintenanceConfirm, setCancelMaintenanceConfirm] = useState(null)
  const [maintenanceCloseMode, setMaintenanceCloseMode] = useState('complete') // 'complete' or 'cancel'
  const [maintenanceCancelReason, setMaintenanceCancelReason] = useState('')
  const [maintenanceEndDate, setMaintenanceEndDate] = useState('')
  const [maintenanceEndTime, setMaintenanceEndTime] = useState('')
  const [unscheduling, setUnscheduling] = useState(false)
  
  // Scroll sync refs for header/body
  const headerScrollRef = useRef(null)
  const bodyScrollRef = useRef(null)
  const isSyncingScroll = useRef(false)

  const handleHeaderScroll = (e) => {
    if (isSyncingScroll.current) return
    isSyncingScroll.current = true
    if (bodyScrollRef.current) bodyScrollRef.current.scrollLeft = e.target.scrollLeft
    isSyncingScroll.current = false
  }

  const handleBodyScroll = (e) => {
    if (isSyncingScroll.current) return
    isSyncingScroll.current = true
    if (headerScrollRef.current) headerScrollRef.current.scrollLeft = e.target.scrollLeft
    isSyncingScroll.current = false
  }

  // Resize state for drag-to-resize in day view
  const [resizing, setResizing] = useState(null) // { jobId, edge: 'start' | 'end', initialX, initialStart, initialEnd }
  const [resizePreview, setResizePreview] = useState(null) // { jobId, newStart, newEnd }
  const resizingRef = useRef(null)
  const resizePreviewRef = useRef(null)
  
  // Grouping state - can group by location or machine type
  // Grouping is fixed to 'location' (the toggle UI was removed for header space —
  // see D-SCHED-DECLUT01). Setter dropped since nothing sets it anymore.
  const [groupingMode] = useState('location') // 'location' or 'type'
  const [collapsedGroups, setCollapsedGroups] = useState(['Tavares Facility'])
  
  // Maintenance modal state
  const [showMaintenanceModal, setShowMaintenanceModal] = useState(false)

  // View mode toggle: 'grid' = timeline (default), 'list' = per-machine lineup
  const [viewMode, setViewMode] = useState('grid')
  // Full future scheduled job list (all weeks) — used by list view AND all
  // end-date / unschedule cascade math (week slice misses later-week neighbors)
  const [allScheduledJobs, setAllScheduledJobs] = useState([])
  // List view drag-and-drop hover target
  // { type: 'after', jobId } | { type: 'machine', machineId } | null
  const [listDropTarget, setListDropTarget] = useState(null)

  // Click-to-schedule modal state (unified: button, drag-drop, edit)
  const [scheduleClickJob, setScheduleClickJob] = useState(null)
  const [scheduleClickEditMode, setScheduleClickEditMode] = useState(false)
  const [scheduleClickDefaults, setScheduleClickDefaults] = useState(null)

  // D-AISCHED-04: "Uncle Bob" advisor drawer. advisorApplying carries the
  // proposal being routed through ScheduleJobModal so onSuccess can mark it
  // applied (and detect human edits). refreshKey nudges the panel to reload.
  const [advisorOpen, setAdvisorOpen] = useState(false)
  const [advisorApplying, setAdvisorApplying] = useState(null)
  const [advisorRefreshKey, setAdvisorRefreshKey] = useState(0)

  // SKY55 — Adjust End Date (end-only quick edit; start + machine + position locked)
  const [endDateEditJob, setEndDateEditJob] = useState(null)
  const [endDateEditValue, setEndDateEditValue] = useState('') // datetime-local string
  // D-SCHED-13: parts/day calculator in the Adjust End Date modal
  const [endDatePartsPerDay, setEndDatePartsPerDay] = useState('')
  const [endDateHistoryRuns, setEndDateHistoryRuns] = useState([])
  const [endDateSaving, setEndDateSaving] = useState(false)
  const [endDateError, setEndDateError] = useState(null)
  // D-SCHED-16: live run rate from accepted finishing — { rate, pieces, elapsedMs }
  const [endDateLiveRate, setEndDateLiveRate] = useState(null)

  // SKY57 — schedule change requests review queue
  const [changeRequests, setChangeRequests] = useState([])
  const [showChangeRequests, setShowChangeRequests] = useState(false)
  const [applyingRequestId, setApplyingRequestId] = useState(null)

  // Lot-change split acknowledgements (informational, scheduler-side)
  const [lotSplitAcks, setLotSplitAcks] = useState([])
  const [acknowledgingSplitId, setAcknowledgingSplitId] = useState(null)

  // Global schedule search state
  const [globalSearch, setGlobalSearch] = useState('')
  const [globalSearchResults, setGlobalSearchResults] = useState([])
  const [showGlobalResults, setShowGlobalResults] = useState(false)
  const [highlightedJobId, setHighlightedJobId] = useState(null)
  const globalSearchRef = useRef(null)
  const globalSearchTimerRef = useRef(null)

  // Keep refs in sync with state
  useEffect(() => {
    resizingRef.current = resizing
  }, [resizing])
  
  useEffect(() => {
    resizePreviewRef.current = resizePreview
  }, [resizePreview])

  // Calculate week dates based on offset
  const getWeekDates = () => {
    const today = new Date()
    const startOfWeek = new Date(today)
    startOfWeek.setDate(today.getDate() + (weekOffset * windowDays))
    startOfWeek.setHours(0, 0, 0, 0)
    
    const dates = []
    for (let i = 0; i < windowDays; i++) {
      const date = new Date(startOfWeek)
      date.setDate(startOfWeek.getDate() + i)
      dates.push(date)
    }
    return dates
  }

  const weekDates = getWeekDates()
  
  const weekStart = weekDates[0]
  const weekEnd = new Date(weekDates[weekDates.length - 1])
  weekEnd.setHours(23, 59, 59, 999)

  // D-SCHED-16: scheduled jobs whose recorded qty basis no longer matches the
  // current run target — a merge/unmerge/split landed after scheduling.
  const staleScheduled = allScheduledJobs.filter(j => isScheduleStale(j, mergeAllocs[j.id] || []))

  // Hours for zoomed day view
  const dayHours = Array.from({ length: 24 }, (_, i) => i)

  useEffect(() => {
    fetchData()
    loadChangeRequests()
    loadLotSplitAcks()

    const jobsSubscription = supabase
      .channel('schedule-jobs-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' },
        () => fetchData()
      )
      .subscribe()

    const changeRequestsSubscription = supabase
      .channel('schedule-change-requests')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'schedule_change_requests' },
        () => loadChangeRequests()
      )
      .subscribe()

    const lotSplitsSubscription = supabase
      .channel('schedule-lot-splits')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'job_splits' },
        () => loadLotSplitAcks()
      )
      .subscribe()

    // Subscribe to machine status changes
    const machinesSubscription = supabase
      .channel('schedule-machines-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'machines' }, 
        () => fetchData()
      )
      .subscribe()

    // NEW: Subscribe to downtime log changes for real-time DOWN status
    const downtimeSubscription = supabase
      .channel('schedule-downtime-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'machine_downtime_logs' }, 
        () => fetchData()
      )
      .subscribe()

    return () => {
      supabase.removeChannel(jobsSubscription)
      supabase.removeChannel(machinesSubscription)
      supabase.removeChannel(downtimeSubscription)
      supabase.removeChannel(changeRequestsSubscription)
      supabase.removeChannel(lotSplitsSubscription)
    }
  }, [weekOffset, windowDays])

  const fetchData = async () => {
    setLoading(true)
    try {
      // Fetch unassigned ready jobs (and pending_compliance jobs not yet scheduled)
      const { data: unassignedData, error: unassignedError } = await supabase
        .from('jobs')
        .select(`
          *,
          work_order:work_orders(id, wo_number, customer, priority, due_date, order_type, has_cancelled_allocation, has_open_shortfall),
          component:parts!component_id(id, part_number, description)
        `)
        .in('status', ['ready', 'pending_compliance'])
        .is('assigned_machine_id', null)
        .order('created_at', { ascending: true })

      if (unassignedError) {
        console.error('Error fetching unassigned jobs:', unassignedError)
      } else {
        setUnassignedJobs(unassignedData || [])
      }

      // Fetch jobs scheduled within the visible week, AND any ongoing job
      // (in_setup / in_progress / pending_passivation / in_passivation) whose
      // scheduled_start lies before the week — those are still occupying the
      // machine and need to render on the grid as carryover bars.
      const ongoingList = ONGOING_STATUSES.join(',')
      const weekStartIso = weekStart.toISOString()
      const weekEndIso = weekEnd.toISOString()
      const { data: scheduledData, error: scheduledError } = await supabase
        .from('jobs')
        .select(`
          *,
          work_order:work_orders(id, wo_number, customer, priority, due_date, order_type, maintenance_type, has_cancelled_allocation, has_open_shortfall),
          component:parts!component_id(id, part_number, description),
          assigned_machine:machines(id, name, code)
        `)
        .not('assigned_machine_id', 'is', null)
        .not('scheduled_start', 'is', null)
        .not('status', 'eq', 'cancelled')
        .or(
          `and(scheduled_start.gte.${weekStartIso},scheduled_start.lte.${weekEndIso}),` +
          `and(scheduled_start.lt.${weekStartIso},scheduled_end.gte.${weekStartIso}),` +
          `and(scheduled_start.lt.${weekStartIso},scheduled_end.is.null,status.in.(${ongoingList})),` +
          // D-SCHED-02: overrun carryover — ongoing jobs whose whole slot
          // predates the window are still occupying machines; fetch them so
          // the render can extend their bars to "now".
          `and(scheduled_end.lt.${weekStartIso},status.in.(${ongoingList})),` +
          // D-SCHED-03: missed-slot carryover — scheduled-but-never-started
          // jobs whose whole slot predates the window; the render pins them
          // at today's left edge for rescheduling.
          `and(scheduled_end.lt.${weekStartIso},status.in.(ready,assigned,pending_compliance))`
        )
        .order('scheduled_start', { ascending: true })

      if (scheduledError) {
        console.error('Error fetching scheduled jobs:', scheduledError)
      } else {
        setScheduledJobs(scheduledData || [])
      }

      // D-JOBMERGE-02 / D-SCHED-16 fix: ALL active merge allocations,
      // deliberately unfiltered. This map serves consumers with different
      // scopes — grid bars (visible week) but also the stale-schedule
      // worklist and Adjust End Date modal (allScheduledJobs, unwindowed).
      // Filtering to visible-week ids made getRunTarget silently degrade to
      // bare quantity for off-window hosts via the `|| []` fallback,
      // producing false "run target changed" alerts. Active merges are
      // occasional (tens of rows), so the unfiltered fetch is cheap. Member
      // details come from a second query (nesting past two levels is
      // unreliable in a single select — merge client-side instead).
      {
        const { data: allocRows, error: allocError } = await supabase
          .from('job_merge_allocations')
          .select('id, host_job_id, member_job_id, requested_qty')
          .eq('is_active', true)
        if (allocError) {
          console.error('Error fetching merge allocations:', allocError)
          setMergeAllocs({})
        } else if ((allocRows || []).length === 0) {
          setMergeAllocs({})
        } else {
          const memberIds = allocRows.map(a => a.member_job_id)
          const { data: memberJobs } = await supabase
            .from('jobs')
            .select('id, job_number, quantity, work_order:work_orders(wo_number, customer, due_date)')
            .in('id', memberIds)
          const memberById = {}
          for (const mj of (memberJobs || [])) memberById[mj.id] = mj
          const map = {}
          for (const a of allocRows) {
            const mj = memberById[a.member_job_id]
            if (!map[a.host_job_id]) map[a.host_job_id] = []
            map[a.host_job_id].push({
              allocation_id: a.id,
              member_job_id: a.member_job_id,
              requested_qty: a.requested_qty,
              job_number: mj?.job_number,
              wo_number: mj?.work_order?.wo_number,
              customer: mj?.work_order?.customer,
              due_date: mj?.work_order?.due_date
            })
          }
          setMergeAllocs(map)
        }
      }

      const { data: machinesData, error: machinesError } = await supabase
        .from('machines')
        .select(`
          *,
          location:locations(id, name, code)
        `)
        .eq('is_active', true)
        .eq('is_commissioned', true)
        .neq('machine_type', 'finishing')
        .order('display_order')

      if (machinesError) {
        console.error('Error fetching machines:', machinesError)
      } else {
        setMachines(machinesData || [])
      }

      const { data: durationsData, error: durationsError } = await supabase
        .from('part_machine_durations')
        .select('*')
        .order('preference_order', { ascending: true })

      if (durationsError) {
        console.error('Error fetching part_machine_durations:', durationsError)
      } else {
        setPartMachineDurations(durationsData || [])
      }

      // NEW: Fetch ongoing downtimes (end_time IS NULL) for DOWN status
      const { data: ongoingDowntimesData, error: downtimeError } = await supabase
        .from('machine_downtime_logs')
        .select('*')
        .is('end_time', null)
        .order('start_time', { ascending: false })

      if (downtimeError) {
        console.error('Error fetching ongoing downtimes:', downtimeError)
      } else {
        setOngoingDowntimes(ongoingDowntimesData || [])
      }

      // NEW: Fetch active unplanned maintenance jobs for DOWN status
      // (status = assigned, in_setup, in_progress AND maintenance_type = unplanned AND currently scheduled)
      const now = new Date().toISOString()
      const { data: activeMaintenanceData, error: maintenanceError } = await supabase
        .from('jobs')
        .select(`
          *,
          work_order:work_orders!inner(wo_number, order_type, maintenance_type, notes)
        `)
        .eq('is_maintenance', true)
        .eq('work_order.maintenance_type', 'unplanned')
        .in('status', ['assigned', 'in_setup', 'in_progress'])
        .lte('scheduled_start', now)
        .or(`scheduled_end.gte.${now},scheduled_end.is.null`)

      if (maintenanceError) {
        console.error('Error fetching active maintenance jobs:', maintenanceError)
      } else {
        setActiveMaintenanceJobs(activeMaintenanceData || [])
      }

      // Fetch ALL future scheduled jobs (used by list view — independent of week window)
      await loadAllScheduledJobs()

    } catch (error) {
      console.error('Unexpected error:', error)
    } finally {
      setLoading(false)
    }
  }

  // List view query — fetches every future scheduled job, regardless of week
  const loadAllScheduledJobs = async () => {
    const { data, error } = await supabase
      .from('jobs')
      .select(`
        *,
        work_order:work_orders(
          id, wo_number, customer, priority, due_date, has_cancelled_allocation
        ),
        component:parts!component_id(
          id, part_number, description
        )
      `)
      .not('assigned_machine_id', 'is', null)
      .not('scheduled_start', 'is', null)
      .in('status', [
        'ready',
        'assigned',
        'pending_compliance',
        'in_setup',
        'in_progress',
        'pending_passivation',
        'in_passivation'
      ])
      .order('scheduled_start', { ascending: true })

    if (error) {
      console.error('Error fetching all scheduled jobs:', error)
    } else {
      setAllScheduledJobs(data || [])
    }
  }

  // NEW: Get ongoing downtime for a specific machine
  const getOngoingDowntimeForMachine = (machineId) => {
    return ongoingDowntimes.find(d => d.machine_id === machineId)
  }

  // NEW: Get active unplanned maintenance job for a specific machine
  const getActiveMaintenanceForMachine = (machineId) => {
    return activeMaintenanceJobs.find(j => j.assigned_machine_id === machineId)
  }

  // NEW: Check if machine is DOWN (from any source)
  const isMachineDown = (machine) => {
    // Check database status
    if (machine.status === 'down') return true
    // Check ongoing downtime from machinist
    if (getOngoingDowntimeForMachine(machine.id)) return true
    // Check active unplanned maintenance
    if (getActiveMaintenanceForMachine(machine.id)) return true
    return false
  }

  // NEW: Get DOWN reason for a machine
  const getMachineDownReason = (machine) => {
    const ongoingDowntime = getOngoingDowntimeForMachine(machine.id)
    const activeMaintenance = getActiveMaintenanceForMachine(machine.id)
    
    // Priority: 1. Ongoing machinist-logged downtime, 2. Active unplanned maintenance, 3. Database status_reason
    if (ongoingDowntime) {
      return `Ongoing: ${ongoingDowntime.reason}${ongoingDowntime.notes ? ` - ${ongoingDowntime.notes}` : ''}`
    }
    if (activeMaintenance) {
      return `Unplanned Maintenance: ${activeMaintenance.maintenance_description || activeMaintenance.work_order?.notes || 'In progress'}`
    }
    return machine.status_reason
  }

  const getDurationForPartMachine = (partId, machineId) => {
    return partMachineDurations.find(
      d => d.part_id === partId && d.machine_id === machineId
    )
  }

  // Calculate scaled duration based on quantity ratio
  const getScaledDuration = (durationRecord, jobQuantity) => {
    if (!durationRecord || !durationRecord.estimated_minutes) return null
    
    const baseMinutes = durationRecord.estimated_minutes
    const baseQuantity = durationRecord.base_quantity
    
    // If no base quantity stored, use the duration as-is
    if (!baseQuantity || baseQuantity <= 0 || !jobQuantity || jobQuantity <= 0) {
      return baseMinutes
    }
    
    // Scale duration proportionally: (jobQty / baseQty) * baseDuration
    const scaledMinutes = Math.round((jobQuantity / baseQuantity) * baseMinutes)
    
    // Minimum 15 minutes
    return Math.max(15, scaledMinutes)
  }

  const getMachineOptionsForPart = (partId) => {
    return partMachineDurations
      .filter(d => d.part_id === partId)
      .sort((a, b) => {
        if (a.is_preferred && !b.is_preferred) return -1
        if (!a.is_preferred && b.is_preferred) return 1
        return (a.preference_order || 99) - (b.preference_order || 99)
      })
  }

  const scheduledJobsByMachine = useMemo(() => {
    const grouped = {}
    scheduledJobs.forEach(job => {
      if (!grouped[job.assigned_machine_id]) {
        grouped[job.assigned_machine_id] = []
      }
      grouped[job.assigned_machine_id].push(job)
    })
    return grouped
  }, [scheduledJobs])

  // D-SCHED-04: display-only projection of every machine's live timeline.
  const projectedSpans = useMemo(() => buildProjection(scheduledJobs), [scheduledJobs])

  // D-SCHED-03/04: pins apply only when today is on screen; past windows
  // render missed jobs at their real slots so history stays browsable. A
  // function (not a memo) so the weekDates reference resolves at
  // block-render time regardless of declaration order.
  const windowContainsToday = () => {
    const t = new Date().toDateString()
    return (weekDates || []).some(d => new Date(d).toDateString() === t)
  }

  // D-SCHED-05: projection is a live lens — never rewrite history. When the
  // visible window ends before today, every consumer falls back to the real
  // schedule, keeping past weeks browsable exactly as planned/ran.
  const windowEndsBeforeToday = () => {
    const last = (weekDates || [])[(weekDates || []).length - 1]
    if (!last) return false
    const t = new Date()
    t.setHours(0, 0, 0, 0)
    const end = new Date(last)
    end.setHours(23, 59, 59, 999)
    return end < t
  }
  const getLiveSpan = (jobId) => (windowEndsBeforeToday() ? null : projectedSpans[jobId])

  // Shift hours constants (7am to 4pm = 9 hours = 540 minutes)
  const SHIFT_START_HOUR = 7
  const SHIFT_END_HOUR = 16
  const SHIFT_MINUTES = (SHIFT_END_HOUR - SHIFT_START_HOUR) * 60 // 540 minutes

  // Calculate scheduled minutes for a machine on a specific day (only during shift hours)
  const getScheduledMinutesForDay = (machineId, dayDate) => {
    const machineJobs = scheduledJobsByMachine[machineId] || []
    const dayStart = new Date(dayDate)
    dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(dayDate)
    dayEnd.setHours(23, 59, 59, 999)
    
    // Shift boundaries for this day
    const shiftStart = new Date(dayDate)
    shiftStart.setHours(SHIFT_START_HOUR, 0, 0, 0)
    const shiftEnd = new Date(dayDate)
    shiftEnd.setHours(SHIFT_END_HOUR, 0, 0, 0)
    
    let totalMinutes = 0
    
    machineJobs.forEach(job => {
      if (!job.scheduled_start) return
      
      const jobStart = new Date(job.scheduled_start)
      // Use actual_end for completed jobs, otherwise scheduled_end
      const endTime = (job.status === 'complete' || job.status === 'manufacturing_complete') && job.actual_end
        ? job.actual_end
        : job.scheduled_end
      const jobEnd = endTime 
        ? new Date(endTime)
        : new Date(jobStart.getTime() + (job.estimated_minutes || 60) * 60000)
      
      // Skip if job doesn't overlap with this day
      if (jobStart > dayEnd || jobEnd < dayStart) return
      
      // Clip to shift hours
      const effectiveStart = new Date(Math.max(jobStart.getTime(), shiftStart.getTime()))
      const effectiveEnd = new Date(Math.min(jobEnd.getTime(), shiftEnd.getTime()))
      
      // Only count if there's overlap with shift
      if (effectiveEnd > effectiveStart) {
        totalMinutes += (effectiveEnd - effectiveStart) / 60000
      }
    })
    
    return Math.round(totalMinutes)
  }

  // Calculate utilization percentage for a machine on a specific day
  const getDayUtilization = (machineId, dayDate) => {
    const scheduledMinutes = getScheduledMinutesForDay(machineId, dayDate)
    return Math.round((scheduledMinutes / SHIFT_MINUTES) * 100)
  }

  // Calculate weekly utilization for a machine
  const getWeeklyUtilization = (machineId) => {
    let totalScheduled = 0
    weekDates.forEach(date => {
      totalScheduled += getScheduledMinutesForDay(machineId, date)
    })
    const totalShiftMinutes = SHIFT_MINUTES * windowDays
    return Math.round((totalScheduled / totalShiftMinutes) * 100)
  }

  // Week view: position as percentage of day column (can exceed 100% for multi-day jobs)
  const getJobBlockStyle = (job, dayDate) => {
    if (!job.scheduled_start) return null

    let jobStart = new Date(job.scheduled_start)
    // Use actual_end for completed jobs, otherwise scheduled_end
    const endTime = (job.status === 'complete' || job.status === 'manufacturing_complete') && job.actual_end
      ? job.actual_end
      : job.scheduled_end

    // View bounds — used both for clipping and for "extends to end of view"
    // treatment of ongoing jobs that don't yet have a scheduled_end recorded.
    const viewEnd = new Date(weekDates[weekDates.length - 1])
    viewEnd.setHours(23, 59, 59, 999)

    const isOngoingNoEnd = !endTime && ONGOING_STATUSES.includes(job.status)
    let jobEnd = endTime
      ? new Date(endTime)
      : isOngoingNoEnd
        ? viewEnd
        : new Date(jobStart.getTime() + (job.estimated_minutes || 60) * 60000)

    // D-SCHED-02: live overrun — still on the machine past its slot. Extend
    // the displayed end to now so the bar stays on today's grid (the existing
    // carryover logic pins its left edge) instead of falling off entirely.
    if (isJobOverrun(job)) jobEnd = new Date()

    const dayStart = new Date(dayDate)
    dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(dayDate)
    dayEnd.setHours(23, 59, 59, 999)

    // D-SCHED-03/04: missed slot — pin to today only when today is on
    // screen; on past windows the job renders at its real slot so history
    // stays browsable.
    const missedPin = windowContainsToday() ? getMissedPinSpan(job) : null
    if (missedPin) {
      if (dayStart.getTime() !== missedPin.start.getTime()) return null
      jobStart = missedPin.start
      jobEnd = missedPin.end
    }

    // D-SCHED-04/05: live projection — actual_end truncation, overrun
    // extension, and queue pull-forward all resolve here. Display-only, and
    // null on historic windows (raw schedule renders instead).
    const proj = getLiveSpan(job.id)
    if (!missedPin && proj) {
      jobStart = new Date(proj.start)
      jobEnd = new Date(proj.end)
    }

    // Anchor day = the day column this block renders from
    // Job must touch this day to be visible
    if (jobStart > dayEnd) return null
    if (jobEnd < dayStart) return null

    // Left edge: where the job starts relative to this day
    // For carryover bars (jobStart before this column), pin to left edge of column.
    const visibleStart = jobStart < dayStart ? dayStart : jobStart
    const startHour = visibleStart.getHours() + visibleStart.getMinutes() / 60
    const leftPercent = (startHour / 24) * 100

    // Right edge: clip at end of visible view to prevent infinite overflow
    const clippedEnd = jobEnd > viewEnd ? viewEnd : jobEnd

    // Width in hours from visible start to clipped end
    const durationMs = clippedEnd.getTime() - visibleStart.getTime()
    const durationHours = durationMs / (1000 * 60 * 60)
    const widthPercent = (durationHours / 24) * 100

    const minWidth = 3
    const isMultiDay = jobEnd.getTime() - jobStart.getTime() > 24 * 60 * 60 * 1000

    return {
      left: `${leftPercent}%`,
      width: `${Math.max(widthPercent, minWidth)}%`,
      durationHours,
      isMultiDay,
      continuesFromPrevious: jobStart < dayStart,
      continuesToNext: jobEnd > viewEnd
    }
  }

  // Zoomed day view: position based on hour columns
  const getJobBlockStyleZoomed = (job, dayDate) => {
    if (!job.scheduled_start) return null

    let jobStart = new Date(job.scheduled_start)
    // Use actual_end for completed jobs, otherwise scheduled_end
    const endTime = (job.status === 'complete' || job.status === 'manufacturing_complete') && job.actual_end
      ? job.actual_end
      : job.scheduled_end

    const dayStart = new Date(dayDate)
    dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(dayDate)
    dayEnd.setHours(23, 59, 59, 999)

    // Ongoing jobs without a recorded scheduled_end stretch to the end of the
    // visible day rather than collapsing to a 60-minute fallback.
    const isOngoingNoEnd = !endTime && ONGOING_STATUSES.includes(job.status)
    let jobEnd = endTime
      ? new Date(endTime)
      : isOngoingNoEnd
        ? dayEnd
        : new Date(jobStart.getTime() + (job.estimated_minutes || 60) * 60000)

    // D-SCHED-02: live overrun — see getJobBlockStyle. Same extension here so
    // the zoomed day shows the bar running to now.
    if (isJobOverrun(job)) jobEnd = new Date()

    // D-SCHED-03/04: missed-slot pin — today's zoomed day only, and only
    // while today is the viewed day; past days show the real slot.
    const missedPin = windowContainsToday() ? getMissedPinSpan(job) : null
    if (missedPin) {
      if (dayStart.getTime() !== missedPin.start.getTime()) return null
      jobStart = missedPin.start
      jobEnd = missedPin.end
    }

    // D-SCHED-04/05: live projection — see getJobBlockStyle. Null on
    // historic windows.
    const proj = getLiveSpan(job.id)
    if (!missedPin && proj) {
      jobStart = new Date(proj.start)
      jobEnd = new Date(proj.end)
    }
    
    if (jobStart > dayEnd) return null
    if (jobEnd < dayStart) return null
    
    const visibleStart = jobStart < dayStart ? dayStart : jobStart
    const visibleEnd = jobEnd > dayEnd ? dayEnd : jobEnd
    
    const startHour = visibleStart.getHours() + visibleStart.getMinutes() / 60
    const endHour = visibleEnd.getHours() + visibleEnd.getMinutes() / 60
    const duration = endHour - startHour
    
    // Each hour column is 60px wide
    const hourWidth = 60
    const left = startHour * hourWidth
    const width = Math.max(duration * hourWidth, 30) // Minimum 30px width
    
    return {
      left: `${left}px`,
      width: `${width}px`,
      startHour,
      endHour,
      continuesFromPrevious: jobStart < dayStart,
      continuesToNext: jobEnd > dayEnd
    }
  }

  const hasConflict = (machineId, startTime, endTime, excludeJobId = null) => {
    const machineJobs = scheduledJobsByMachine[machineId] || []
    return machineJobs.some(job => {
      if (excludeJobId && job.id === excludeJobId) return false
      const jobStart = new Date(job.scheduled_start)
      const jobEnd = job.scheduled_end 
        ? new Date(job.scheduled_end) 
        : new Date(jobStart.getTime() + (job.estimated_minutes || 60) * 60000)
      
      return (startTime < jobEnd && endTime > jobStart)
    })
  }

  const getFilteredJobs = () => {
    let filtered = [...unassignedJobs]

    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter(job => 
        job.job_number?.toLowerCase().includes(query) ||
        job.work_order?.wo_number?.toLowerCase().includes(query) ||
        job.work_order?.customer?.toLowerCase().includes(query) ||
        job.component?.part_number?.toLowerCase().includes(query)
      )
    }

    switch (filterBy) {
      case 'wo_number':
        filtered.sort((a, b) => (a.work_order?.wo_number || '').localeCompare(b.work_order?.wo_number || ''))
        break
      case 'due_date':
        filtered.sort((a, b) => {
          const dateA = a.work_order?.due_date ? new Date(a.work_order.due_date) : new Date('9999-12-31')
          const dateB = b.work_order?.due_date ? new Date(b.work_order.due_date) : new Date('9999-12-31')
          return dateA - dateB
        })
        break
      case 'customer':
        filtered.sort((a, b) => (a.work_order?.customer || 'zzz').localeCompare(b.work_order?.customer || 'zzz'))
        break
      case 'priority':
        const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 }
        filtered.sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2))
        break
    }

    return filtered
  }

  // Drag handlers for unassigned jobs
  const handleDragStart = (e, job) => {
    if (!canEdit) {
      e.preventDefault()
      return
    }
    setDraggedJob(job)
    setDraggedScheduledJob(null)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', job.id)
    setTimeout(() => {
      e.target.style.opacity = '0.5'
    }, 0)
  }

  // Drag handlers for scheduled jobs (reschedule)
  const handleScheduledDragStart = (e, job) => {
    if (!canEdit) {
      e.preventDefault()
      return
    }
    setDraggedScheduledJob(job)
    setDraggedJob(null)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', job.id)
    e.stopPropagation()
    setTimeout(() => {
      e.target.style.opacity = '0.5'
    }, 0)
  }

  const handleDragEnd = (e) => {
    e.target.style.opacity = '1'
    setDraggedJob(null)
    setDraggedScheduledJob(null)
    setDropTarget(null)
  }

  // Compute the next available start time on a machine: end of the last
  // scheduled job there (whose scheduled_end is known), or now if the
  // machine is idle / its last bookings extend backwards in time.
  const computeNextSlotStart = (machineId, jobs) => {
    const onMachine = jobs.filter(
      (j) => j.assigned_machine_id === machineId && j.scheduled_end
    )
    const now = new Date()
    if (onMachine.length === 0) return now
    const lastEnd = new Date(
      Math.max(...onMachine.map((j) => new Date(j.scheduled_end).getTime()))
    )
    return lastEnd > now ? lastEnd : now
  }

  // Snap to the next valid business-hours slot after a job ends
  // (mirrors ScheduleJobModal's snapToBusinessHours logic)
  const snapAfterJob = (job) => {
    const start = new Date(job.scheduled_start)
    const endMs = job.scheduled_end
      ? new Date(job.scheduled_end).getTime()
      : start.getTime() + (job.estimated_minutes || 60) * 60000
    const end = new Date(endMs)

    const SHIFT_START = 7
    const SHIFT_END = 16
    const h = end.getHours()
    const m = end.getMinutes()

    if (h < SHIFT_START) {
      end.setHours(SHIFT_START, 0, 0, 0)
    } else if (h > SHIFT_END || (h === SHIFT_END && m > 0)) {
      end.setDate(end.getDate() + 1)
      end.setHours(SHIFT_START, 0, 0, 0)
    } else if (m % 15 !== 0) {
      end.setMinutes(Math.ceil(m / 15) * 15, 0, 0)
    }

    const dateStr = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`
    const timeStr = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`
    return { date: dateStr, startTime: timeStr }
  }

  // List view drop handler — drop onto machine card (reassign or append)
  const handleListDropOnMachine = (e, machineId) => {
    if (!canEdit) return
    e.preventDefault()
    setListDropTarget(null)

    const job = draggedJob || draggedScheduledJob
    if (!job) return

    const machineJobs = allScheduledByMachine[machineId] || []
    const lastJob = machineJobs[machineJobs.length - 1]

    let defaults
    if (lastJob) {
      const { date, startTime } = snapAfterJob(lastJob)
      defaults = { date, machineId, startTime }
    } else {
      // Empty machine — let the modal auto-calc next available slot
      const today = new Date().toISOString().split('T')[0]
      defaults = { date: today, machineId }
    }

    setScheduleClickJob(job)
    setScheduleClickEditMode(!!draggedScheduledJob)
    setScheduleClickDefaults(defaults)
    setDraggedJob(null)
    setDraggedScheduledJob(null)
  }

  const handleDragOver = (e, machineId, date, hour = null) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTarget({ machineId, date: date.toISOString(), hour })
  }

  const handleDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDropTarget(null)
    }
  }

  const handleDrop = (e, machineId, date, hour = null) => {
    if (!canEdit) return
    e.preventDefault()
    setDropTarget(null)

    const job = draggedJob || draggedScheduledJob
    if (!job) return

    const isReschedule = !!draggedScheduledJob

    // Format date as YYYY-MM-DD string for ScheduleJobModal
    const dropDate = date instanceof Date
      ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      : typeof date === 'string' ? date : new Date(date).toISOString().split('T')[0]

    // Start time from day-view hour click, or null for auto-calc
    const dropTime = hour !== null ? `${String(hour).padStart(2, '0')}:00` : null

    // Open ScheduleJobModal with drop context as defaults
    setScheduleClickJob(job)
    setScheduleClickEditMode(isReschedule)
    setScheduleClickDefaults({ date: dropDate, machineId, startTime: dropTime })

    setDraggedJob(null)
    setDraggedScheduledJob(null)
  }

  // D-AISCHED-04: Apply an Uncle Bob proposal by opening the SAME unified
  // ScheduleJobModal used by click/drag scheduling, prefilled with the
  // proposed machine/date/time. The modal does its own live queue math and
  // writes via applySchedule → reschedule_with_cascade; the human confirming
  // is scheduled_by. Returns false if the job left the pool (stale proposal).
  const handleAdvisorApply = (proposal) => {
    const job = unassignedJobs.find(j => j.id === proposal.job_id)
    if (!job) return false
    const d = new Date(proposal.proposed_start)
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const startTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    setAdvisorApplying(proposal)
    setScheduleClickJob(job)
    setScheduleClickEditMode(false)
    setScheduleClickDefaults({ date, machineId: proposal.machine_id, startTime })
    return true
  }

  // Unschedule a job - route through the Unschedule Confirmation modal so the
  // user gets the gap-closing option (handled in handleUnschedule below).
  const handleReturnToQueue = (job) => {
    if (!job) return
    setScheduleClickJob(null)
    setScheduleClickEditMode(false)
    setScheduleClickDefaults(null)
    setCloseGap(true)
    setUnscheduleConfirm(job)
  }

  // SKY55 — open the Adjust End Date modal (running or editable jobs).
  const toLocalDatetimeInput = (d) => {
    const dt = new Date(d)
    const p = (n) => String(n).padStart(2, '0')
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}`
  }

  const handleOpenEndDateEdit = (job) => {
    const baseMs = job.scheduled_end
      ? new Date(job.scheduled_end).getTime()
      : (job.scheduled_start ? new Date(job.scheduled_start).getTime() : Date.now()) + (job.estimated_minutes || 60) * 60000
    setEndDateEditValue(toLocalDatetimeInput(new Date(baseMs)))
    setEndDateError(null)
    setEndDateEditJob(job)
    setSelectedJob(null)
    // D-SCHED-13: reset and load throughput history for the parts/day calculator
    setEndDatePartsPerDay('')
    setEndDateHistoryRuns([])
    setEndDateLiveRate(null)
    fetchPartThroughputRuns(supabase, job.component_id, job.id).then(setEndDateHistoryRuns)
    // D-SCHED-16: live run rate from accepted finishing (D-SCHED-14 gates:
    // ≥1h elapsed, >0 pieces). Prefill the recommendation ONLY when the
    // schedule is stale — a non-stale open must not move anything.
    ;(async () => {
      if (!job.production_start) return
      const { data: accRows, error: accErr } = await supabase
        .from('finishing_sends')
        .select('compliance_good_qty')
        .eq('job_id', job.id)
        .eq('compliance_outcome', 'accepted')
      if (accErr) { console.error('Live-rate fetch failed:', accErr); return }
      const pieces = (accRows || []).reduce((s, r) => s + (r.compliance_good_qty || 0), 0)
      const elapsedMs = Date.now() - new Date(job.production_start).getTime()
      if (pieces <= 0 || elapsedMs < 3600000) return
      const rate = Math.max(1, Math.round(pieces * 86400000 / elapsedMs))
      setEndDateLiveRate({ rate, pieces, elapsedMs })
      const members = mergeAllocs[job.id] || []
      if (isScheduleStale(job, members) && job.scheduled_start) {
        setEndDatePartsPerDay(String(rate))
        const mins = partsPerDayToMinutes(getRunTarget(job, members), rate)
        if (mins !== null) {
          setEndDateEditValue(toLocalDatetimeInput(new Date(new Date(job.scheduled_start).getTime() + mins * 60000)))
        }
      }
    })()
  }

  const handleSaveEndDate = async () => {
    if (!endDateEditJob) return
    const job = endDateEditJob
    const start = job.scheduled_start ? new Date(job.scheduled_start) : null
    const newEnd = endDateEditValue ? new Date(endDateEditValue) : null

    if (!newEnd || isNaN(newEnd.getTime())) {
      setEndDateError('Enter a valid end date and time.')
      return
    }
    if (start && newEnd <= start) {
      setEndDateError('End must be after the job start.')
      return
    }
    if (isJobRunning(job) && newEnd <= new Date()) {
      setEndDateError('End must be in the future for a running job.')
      return
    }

    // D-DATE-03: warn (never block) when the adjusted end lands after the
    // customer due date. due_date is a DATE column — compare end-of-day.
    if (job.work_order?.due_date && newEnd > new Date(job.work_order.due_date + 'T23:59:59')) {
      const dueShort = new Date(job.work_order.due_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      const ok = window.confirm(
        `This job is scheduled to finish after the customer due date (${dueShort}). Schedule anyway?`
      )
      if (!ok) return
    }

    setEndDateSaving(true)
    setEndDateError(null)
    try {
      let cascadeChanges = []
      if (job.assigned_machine_id) {
        const queue = getMachineQueue(allScheduledJobs, job.assigned_machine_id)
        cascadeChanges = computeEndChangeCascade(queue, job.id, newEnd).changes
      }
      await applyEndDateChange({ supabase, job, newEnd, cascadeChanges })
      setEndDateEditJob(null)
      fetchData()
      loadAllScheduledJobs()
    } catch (e) {
      setEndDateError(e.message || 'Failed to update end date.')
    } finally {
      setEndDateSaving(false)
    }
  }

  // SKY57 — load open schedule change requests for the review queue.
  const loadChangeRequests = async () => {
    const { data, error } = await supabase
      .from('schedule_change_requests')
      .select(`
        id, job_id, current_end, requested_end, note, source, status, requested_by, created_at,
        job:jobs(id, job_number, scheduled_start, scheduled_end, assigned_machine_id, status,
                 component:parts!component_id(part_number),
                 assigned_machine:machines(code, name)),
        requester:profiles!requested_by(full_name)
      `)
      .eq('status', 'open')
      .order('created_at', { ascending: true })
    if (error) { console.error('Error loading change requests:', error); return }
    setChangeRequests(data || [])
  }

  // Open lot-change split acknowledgements for the scheduler (reason='material lot
  // change', not yet acknowledged). Informational only — never blocks.
  const loadLotSplitAcks = async () => {
    const { data, error } = await supabase
      .from('job_splits')
      .select(`
        id, original_job_id, new_job_id, new_job_qty, split_at, scheduler_ack_at,
        original_job:jobs!original_job_id(job_number),
        new_job:jobs!new_job_id(job_number, quantity, scheduled_start, scheduled_end,
                 component:parts!component_id(part_number),
                 assigned_machine:machines(code, name))
      `)
      .eq('reason', 'material lot change')
      .is('scheduler_ack_at', null)
      .order('split_at', { ascending: true })
    if (error) { console.error('Error loading lot-split acknowledgements:', error); return }
    setLotSplitAcks(data || [])
  }

  // Acknowledge a lot-change split — stamp scheduler_ack_at/by + audit. Non-blocking.
  const handleAcknowledgeLotSplit = async (ack) => {
    setAcknowledgingSplitId(ack.id)
    try {
      const { error } = await supabase
        .from('job_splits')
        .update({ scheduler_ack_at: new Date().toISOString(), scheduler_ack_by: profile?.id })
        .eq('id', ack.id)
      if (error) throw error
      await supabase.from('audit_logs').insert({
        event_type: 'lot_split_acknowledged',
        job_id: ack.new_job_id,
        operator_id: profile?.id || null,
        details: { original_job_id: ack.original_job_id, new_job_id: ack.new_job_id, remainder: ack.new_job_qty, by: 'scheduler' }
      })
      await loadLotSplitAcks()
    } catch (e) {
      alert(`Could not acknowledge: ${e.message}`)
    } finally {
      setAcknowledgingSplitId(null)
    }
  }

  // Apply: reuse the SKY55 end-date cascade engine, then mark this request applied and
  // auto-dismiss any other open requests on the same job (decision 2).
  const handleApplyChangeRequest = async (req) => {
    setApplyingRequestId(req.id)
    try {
      const { data: job, error: jErr } = await supabase
        .from('jobs')
        .select('id, job_number, scheduled_start, scheduled_end, assigned_machine_id, status')
        .eq('id', req.job_id)
        .single()
      if (jErr || !job) throw new Error(jErr?.message || 'Job not found')
      if (!job.scheduled_start) throw new Error('Job has no scheduled start; cannot move its end.')

      const newEnd = new Date(req.requested_end)
      let cascadeChanges = []
      if (job.assigned_machine_id) {
        const queue = getMachineQueue(allScheduledJobs, job.assigned_machine_id)
        cascadeChanges = computeEndChangeCascade(queue, job.id, newEnd).changes
      }
      await applyEndDateChange({ supabase, job, newEnd, cascadeChanges })

      const now = new Date().toISOString()
      await supabase
        .from('schedule_change_requests')
        .update({ status: 'applied', actioned_by: profile?.id, actioned_at: now })
        .eq('id', req.id)
      await supabase
        .from('schedule_change_requests')
        .update({ status: 'dismissed', actioned_by: profile?.id, actioned_at: now })
        .eq('job_id', req.job_id)
        .eq('status', 'open')

      await loadChangeRequests()
      fetchData()
      loadAllScheduledJobs()
    } catch (e) {
      alert(`Could not apply the change request: ${e.message}`)
    } finally {
      setApplyingRequestId(null)
    }
  }

  const handleDismissChangeRequest = async (req) => {
    setApplyingRequestId(req.id)
    try {
      const { error } = await supabase
        .from('schedule_change_requests')
        .update({ status: 'dismissed', actioned_by: profile?.id, actioned_at: new Date().toISOString() })
        .eq('id', req.id)
      if (error) throw error
      await loadChangeRequests()
    } catch (e) {
      alert(`Could not dismiss the request: ${e.message}`)
    } finally {
      setApplyingRequestId(null)
    }
  }

  const handleUnschedule = async () => {
    if (!unscheduleConfirm) return

    setUnscheduling(true)

    try {
      // Compute cascade if closeGap is checked AND there's a machine assigned
      let cascadeChanges = []
      if (closeGap && unscheduleConfirm.assigned_machine_id) {
        const queue = getMachineQueue(allScheduledJobs, unscheduleConfirm.assigned_machine_id)
        const removal = computeRemovalCascade(queue, unscheduleConfirm.id)
        cascadeChanges = removal.changes
      }

      await applyUnschedule({
        supabase,
        job: unscheduleConfirm,
        cascadeChanges
      })

      setUnscheduleConfirm(null)
      setSelectedJob(null)
      setCloseGap(true)
      fetchData()
      loadAllScheduledJobs()
    } catch (error) {
      console.error('Error unscheduling job:', error)
    } finally {
      setUnscheduling(false)
    }
  }

  // Cancel or Complete Early a maintenance order
  const handleCancelMaintenance = async () => {
    if (!cancelMaintenanceConfirm) return
    
    // Validate based on mode
    if (maintenanceCloseMode === 'cancel' && !maintenanceCancelReason.trim()) {
      setSaveError('Please enter a cancellation reason')
      return
    }
    
    if (maintenanceCloseMode === 'complete' && (!maintenanceEndDate || !maintenanceEndTime)) {
      setSaveError('Please enter an end date and time')
      return
    }
    
    setSaving(true)
    setSaveError(null)
    
    try {
      const job = cancelMaintenanceConfirm
      const jobId = job.id
      const workOrderId = job.work_order_id || job.work_order?.id
      const machineId = job.assigned_machine_id
      const wasUnplanned = job.work_order?.maintenance_type === 'unplanned'
      
      console.log('Closing maintenance:', { jobId, workOrderId, machineId, wasUnplanned, mode: maintenanceCloseMode })
      
      if (maintenanceCloseMode === 'cancel') {
        // Cancel mode: set status to cancelled, clear schedule, add reason
        const { error: jobError } = await supabase
          .from('jobs')
          .update({
            status: 'cancelled',
            assigned_machine_id: null,
            scheduled_start: null,
            scheduled_end: null,
            notes: job.notes 
              ? `${job.notes}\n[Cancelled: ${maintenanceCancelReason}]`
              : `[Cancelled: ${maintenanceCancelReason}]`,
            updated_at: new Date().toISOString()
          })
          .eq('id', jobId)
        
        if (jobError) {
          console.error('Error cancelling maintenance job:', jobError)
          setSaveError(`Failed to cancel: ${jobError.message}`)
          return
        }
        
        // Update work order status
        if (workOrderId) {
          await supabase
            .from('work_orders')
            .update({
              status: 'closed',
              notes: job.work_order?.notes 
                ? `${job.work_order.notes}\n[Cancelled: ${maintenanceCancelReason}]`
                : `[Cancelled: ${maintenanceCancelReason}]`,
              updated_at: new Date().toISOString()
            })
            .eq('id', workOrderId)
        }
        
      } else {
        // Complete Early mode: update end time, mark as complete
        const newEndTime = new Date(`${maintenanceEndDate}T${maintenanceEndTime}:00`)
        
        const { error: jobError } = await supabase
          .from('jobs')
          .update({
            status: 'complete',
            scheduled_end: newEndTime.toISOString(),
            actual_end: newEndTime.toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', jobId)
        
        if (jobError) {
          console.error('Error completing maintenance job:', jobError)
          setSaveError(`Failed to complete: ${jobError.message}`)
          return
        }
        
        // Update work order status
        if (workOrderId) {
          await supabase
            .from('work_orders')
            .update({
              status: 'complete',
              updated_at: new Date().toISOString()
            })
            .eq('id', workOrderId)
        }
      }
      
      // If it was unplanned maintenance, reset the machine status
      if (wasUnplanned && machineId) {
        await supabase
          .from('machines')
          .update({
            status: 'available',
            status_reason: null,
            status_updated_at: new Date().toISOString()
          })
          .eq('id', machineId)
      }
      
      console.log('Maintenance closed successfully')
      setCancelMaintenanceConfirm(null)
      setMaintenanceCloseMode('complete')
      setMaintenanceCancelReason('')
      setMaintenanceEndDate('')
      setMaintenanceEndTime('')
      setSelectedJob(null)
      await fetchData()
    } catch (error) {
      console.error('Error closing maintenance:', error)
      setSaveError(`Error: ${error.message}`)
    } finally {
      setSaving(false)
    }
  }

  // Resize handlers for day view
  const handleResizeStart = (e, job, edge) => {
    e.preventDefault()
    e.stopPropagation()
    
    const jobStart = new Date(job.scheduled_start)
    const jobEnd = job.scheduled_end 
      ? new Date(job.scheduled_end)
      : new Date(jobStart.getTime() + (job.estimated_minutes || 60) * 60000)
    
    setResizing({
      jobId: job.id,
      job: job,
      edge,
      initialX: e.clientX,
      initialStart: jobStart,
      initialEnd: jobEnd
    })
    
    // Add mouse move and up listeners to window
    window.addEventListener('mousemove', handleResizeMove)
    window.addEventListener('mouseup', handleResizeEnd)
  }
  
  const handleResizeMove = useCallback((e) => {
    const currentResizing = resizingRef.current
    if (!currentResizing) return
    
    const deltaX = e.clientX - currentResizing.initialX
    const deltaHours = deltaX / 60 // 60px per hour
    const deltaMs = deltaHours * 60 * 60 * 1000
    
    let newStart = new Date(currentResizing.initialStart)
    let newEnd = new Date(currentResizing.initialEnd)
    
    if (currentResizing.edge === 'start') {
      // Moving start time
      newStart = new Date(currentResizing.initialStart.getTime() + deltaMs)
      // Snap to 15-minute intervals
      newStart.setMinutes(Math.round(newStart.getMinutes() / 15) * 15, 0, 0)
      // Don't allow start after end - minimum 15 minutes
      if (newStart >= new Date(newEnd.getTime() - 15 * 60000)) {
        newStart = new Date(newEnd.getTime() - 15 * 60000)
      }
      // Don't go before midnight
      const dayStart = new Date(currentResizing.initialStart)
      dayStart.setHours(0, 0, 0, 0)
      if (newStart < dayStart) newStart = dayStart
    } else {
      // Moving end time
      newEnd = new Date(currentResizing.initialEnd.getTime() + deltaMs)
      // Snap to 15-minute intervals
      newEnd.setMinutes(Math.round(newEnd.getMinutes() / 15) * 15, 0, 0)
      // Don't allow end before start - minimum 15 minutes
      if (newEnd <= new Date(newStart.getTime() + 15 * 60000)) {
        newEnd = new Date(newStart.getTime() + 15 * 60000)
      }
      // Don't go past midnight
      const dayEnd = new Date(currentResizing.initialStart)
      dayEnd.setHours(23, 59, 59, 999)
      if (newEnd > dayEnd) {
        newEnd = new Date(currentResizing.initialStart)
        newEnd.setHours(23, 59, 0, 0)
      }
    }
    
    setResizePreview({
      jobId: currentResizing.jobId,
      newStart,
      newEnd
    })
  }, [])
  
  const handleResizeEnd = useCallback(async () => {
    window.removeEventListener('mousemove', handleResizeMove)
    window.removeEventListener('mouseup', handleResizeEnd)
    
    const currentResizing = resizingRef.current
    const currentPreview = resizePreviewRef.current
    
    if (!currentResizing || !currentPreview) {
      setResizing(null)
      setResizePreview(null)
      return
    }
    
    const { newStart, newEnd } = currentPreview
    const durationMinutes = Math.round((newEnd - newStart) / 60000)
    
    // Check for conflicts (excluding current job)
    if (hasConflict(currentResizing.job.assigned_machine_id, newStart, newEnd, currentResizing.jobId)) {
      // Reset - conflict detected
      setResizing(null)
      setResizePreview(null)
      return
    }
    
    // Update the job in database
    try {
      const { error } = await supabase
        .from('jobs')
        .update({
          scheduled_start: newStart.toISOString(),
          scheduled_end: newEnd.toISOString(),
          estimated_minutes: durationMinutes
        })
        .eq('id', currentResizing.jobId)
      
      if (error) {
        console.error('Error updating job duration:', error)
      } else {
        fetchData()
      }
    } catch (error) {
      console.error('Unexpected error:', error)
    }
    
    setResizing(null)
    setResizePreview(null)
  }, [handleResizeMove])
  
  // Get block style with resize preview applied
  const getJobBlockStyleZoomedWithPreview = (job, dayDate) => {
    // If this job is being resized, use preview values
    if (resizePreview && resizePreview.jobId === job.id) {
      const jobStart = resizePreview.newStart
      const jobEnd = resizePreview.newEnd
      
      const dayStart = new Date(dayDate)
      dayStart.setHours(0, 0, 0, 0)
      
      const startHour = jobStart.getHours() + jobStart.getMinutes() / 60
      const endHour = jobEnd.getHours() + jobEnd.getMinutes() / 60
      const duration = endHour - startHour
      
      const hourWidth = 60
      const left = startHour * hourWidth
      const width = Math.max(duration * hourWidth, 30)
      
      return {
        left: `${left}px`,
        width: `${width}px`,
        startHour,
        endHour,
        continuesFromPrevious: false,
        continuesToNext: false
      }
    }
    
    // Otherwise use normal calculation
    return getJobBlockStyleZoomed(job, dayDate)
  }

  const getPriorityColor = (priority) => {
    switch (priority) {
      case 'critical': return 'bg-red-500'
      case 'high': return 'bg-yellow-500'
      case 'normal': return 'bg-green-500'
      case 'low': return 'bg-gray-500'
      default: return 'bg-gray-500'
    }
  }

  // Get block color based on priority AND status
  const getJobBlockColor = (job) => {
    const priority = job.priority || job.work_order?.priority
    const isUnplanned = job.work_order?.maintenance_type === 'unplanned'

    // D-SCHED-03: missed slot — amber + dashed overrides every normal color
    // (including maintenance) so forgotten work reads instantly on the board.
    if (isJobMissedSlot(job)) {
      return 'bg-amber-900/70 border-2 border-dashed border-amber-500'
    }
    
    // Maintenance jobs - distinguish planned vs unplanned
    // Planned = Blue, Unplanned = Purple
    if (job.is_maintenance || job.work_order?.order_type === 'maintenance') {
      // Completed maintenance
      if (job.status === 'complete' || job.status === 'manufacturing_complete') {
        return isUnplanned 
          ? 'bg-purple-900/50 border-purple-500 opacity-60'
          : 'bg-blue-900/50 border-blue-500 opacity-60'
      }
      // In-progress maintenance
      if (job.status === 'in_progress' || job.status === 'in_setup') {
        return isUnplanned
          ? 'bg-purple-600 border-purple-400 ring-2 ring-purple-300 ring-offset-1 ring-offset-gray-900'
          : 'bg-blue-600 border-blue-400 ring-2 ring-blue-300 ring-offset-1 ring-offset-gray-900'
      }
      // Default maintenance (assigned)
      return isUnplanned
        ? 'bg-purple-600 border-purple-400'
        : 'bg-blue-600 border-blue-400'
    }
    
    // D-SCHED-06: completed AT THE MACHINE is grayed out — actual_end covers
    // the finishing-stage statuses (machining done, parts washing /
    // passivating), matching the check the block wears. Sits after the
    // maintenance branches so completed maintenance keeps its own dim style.
    if (job.actual_end || job.status === 'complete' || job.status === 'manufacturing_complete') {
      return 'bg-gray-700/50 border-gray-500 opacity-60'
    }

    // Pending pre-mfg compliance — amber so April can see it's not yet approved
    if (job.status === 'pending_compliance') {
      return 'bg-amber-700/80 border-amber-600'
    }

    // In-setup jobs get a blue treatment
    if (job.status === 'in_setup') {
      return 'bg-blue-500 border-blue-400 ring-2 ring-blue-300 ring-offset-1 ring-offset-gray-900'
    }

    // In-progress jobs get a teal treatment
    if (job.status === 'in_progress') {
      return 'bg-teal-600 border-teal-400 ring-2 ring-teal-300 ring-offset-1 ring-offset-gray-900'
    }
    
    // Default: use priority-based coloring
    return getPriorityBlockColor(priority)
  }

  const getPriorityBlockColor = (priority) => {
    switch (priority) {
      case 'critical': return 'bg-red-600 border-red-400'
      case 'high': return 'bg-yellow-600 border-yellow-400'
      case 'normal': return 'bg-green-600 border-green-400'
      case 'low': return 'bg-gray-600 border-gray-400'
      default: return 'bg-gray-600 border-gray-400'
    }
  }

  const getPriorityBorder = (priority) => {
    switch (priority) {
      case 'critical': return 'border-red-600'
      case 'high': return 'border-yellow-600'
      case 'normal': return 'border-green-600'
      case 'low': return 'border-gray-600'
      default: return 'border-gray-600'
    }
  }

  const isMaintenanceJob = (job) => {
    return job.is_maintenance || job.work_order?.order_type === 'maintenance'
  }

  const getBlockSizeTier = (durationHours) => {
    if (durationHours >= 4) return 'large'
    if (durationHours >= 2) return 'medium'
    return 'small'
  }

  const getPriorityAccentBorder = (job) => {
    if (isMaintenanceJob(job)) return 'border-l-2'
    const priority = job.priority || job.work_order?.priority
    switch (priority) {
      case 'critical': return 'border-l-4 border-l-red-500'
      case 'high': return 'border-l-4 border-l-yellow-500'
      default: return 'border-l-2'
    }
  }

  // Check if job is scheduled past its due date
  const isOverdue = (job) => {
    const dueDate = job.work_order?.due_date
    const scheduledStart = job.scheduled_start
    if (!dueDate || !scheduledStart) return false
    
    // Compare dates (ignoring time)
    const due = new Date(dueDate)
    due.setHours(23, 59, 59, 999) // End of due date
    const scheduled = new Date(scheduledStart)
    
    return scheduled > due
  }

  const formatDate = (dateString) => {
    if (!dateString) return '—'
    return new Date(dateString).toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric' 
    })
  }

  const formatTime = (dateString) => {
    if (!dateString) return '—'
    return new Date(dateString).toLocaleTimeString('en-US', { 
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })
  }

  const formatWeekDate = (date) => {
    return date.toLocaleDateString('en-US', { 
      weekday: 'short',
      month: 'numeric',
      day: 'numeric'
    })
  }

  const formatFullDate = (date) => {
    return date.toLocaleDateString('en-US', { 
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    })
  }

  const formatHour = (hour) => {
    if (hour === 0) return '12am'
    if (hour === 12) return '12pm'
    if (hour < 12) return `${hour}am`
    return `${hour - 12}pm`
  }

  const getWeekRangeLabel = () => {
    const start = weekDates[0]
    const end = weekDates[weekDates.length - 1]
    const startStr = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    const endStr = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    return `${startStr} - ${endStr}`
  }

  const filterOptions = [
    { value: 'wo_number', label: 'Work Order #' },
    { value: 'due_date', label: 'Due Date' },
    { value: 'customer', label: 'Customer' },
    { value: 'priority', label: 'Priority' }
  ]

  const filteredJobs = getFilteredJobs()

  const isToday = (date) => {
    const today = new Date()
    return date.toDateString() === today.toDateString()
  }

  const getJobsForMachineDay = (machineId, dayDate) => {
    const machineJobs = scheduledJobsByMachine[machineId] || []

    // Day (zoomed) view: return all jobs that touch this day (clipped as before)
    if (zoomedDay) {
      return machineJobs.filter(job => {
        const style = getJobBlockStyleZoomed(job, dayDate)
        return style !== null
      })
    }

    // Week view: each job renders only from its anchor day
    // Anchor = job start day, or weekDates[0] if the job started before the visible week
    const dayStart = new Date(dayDate)
    dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(dayDate)
    dayEnd.setHours(23, 59, 59, 999)
    const weekStart = new Date(weekDates[0])
    weekStart.setHours(0, 0, 0, 0)

    return machineJobs.filter(job => {
      if (!job.scheduled_start) return false
      let jobStart = new Date(job.scheduled_start)
      const endTime = (job.status === 'complete' || job.status === 'manufacturing_complete') && job.actual_end
        ? job.actual_end
        : job.scheduled_end
      // Ongoing jobs (in_setup / in_progress / passivation) without a recorded
      // scheduled_end are still occupying the machine — render them as
      // extending to the end of the visible view rather than computing a fake
      // ending from estimated_minutes (which would put them in the past for
      // long-running carryover jobs).
      const isOngoingNoEnd = !endTime && ONGOING_STATUSES.includes(job.status)
      let jobEnd = endTime
        ? new Date(endTime)
        : isOngoingNoEnd
          ? weekEnd
          : new Date(jobStart.getTime() + (job.estimated_minutes || 60) * 60000)

      // D-SCHED-02: this week-view filter runs BEFORE getJobBlockStyle, so it
      // needs the same overrun extension — otherwise a job whose scheduled_end
      // predates the visible window is rejected here and never reaches the
      // style function that would have pinned it into today.
      if (isJobOverrun(job)) jobEnd = new Date()

      // D-SCHED-03/04: missed-slot pin — this job belongs to TODAY's column
      // only, and only while today is on screen; on past windows there is no
      // pin and the job falls through to its real slot. getJobBlockStyle
      // renders the pinned span.
      const missedPin = windowContainsToday() ? getMissedPinSpan(job) : null
      if (missedPin) {
        return dayStart.getTime() === missedPin.start.getTime()
      }

      // D-SCHED-04: day membership must follow the PROJECTED span so a
      // pulled-forward job appears in the day it now occupies and disappears
      // from the day it left. Display-only; the real schedule is untouched.
      const proj = getLiveSpan(job.id)
      if (proj) {
        jobStart = new Date(proj.start)
        jobEnd = new Date(proj.end)
      }

      // Job must touch this day
      if (jobStart > dayEnd || jobEnd < dayStart) return false

      // Anchor day: the day the job starts, or weekDates[0] if it started earlier
      const anchorDate = jobStart < weekStart ? weekStart : new Date(jobStart)
      anchorDate.setHours(0, 0, 0, 0)

      return anchorDate.getTime() === dayStart.getTime()
    })
  }

  const isDropTarget = (machineId, date, hour = null) => {
    if (hour !== null) {
      return dropTarget?.machineId === machineId && 
             dropTarget?.date === date.toISOString() &&
             dropTarget?.hour === hour
    }
    return dropTarget?.machineId === machineId && 
           dropTarget?.date === date.toISOString()
  }

  const isMachinePreferred = (machineId) => {
    const job = draggedJob || draggedScheduledJob
    if (!job?.component_id) return false
    const options = getMachineOptionsForPart(job.component_id)
    const machineOption = options.find(o => o.machine_id === machineId)
    return machineOption?.is_preferred || false
  }

  const machineHasDuration = (machineId) => {
    const job = draggedJob || draggedScheduledJob
    if (!job?.component_id) return false
    return !!getDurationForPartMachine(job.component_id, machineId)
  }

  // Check if hour is on-shift (7am-4pm)
  const isOnShift = (hour) => hour >= 7 && hour < 16

  // Group machines by location
  const machinesByLocation = useMemo(() => {
    const groups = {}
    machines.forEach(machine => {
      const locationName = machine.location?.name || 'Unknown Location'
      // Extract just the city name (first word) for display
      const shortName = locationName.split(' ')[0]
      if (!groups[locationName]) {
        groups[locationName] = {
          id: machine.location?.id || 'unknown',
          name: locationName,
          shortName: shortName,
          code: machine.location?.code || '',
          machines: []
        }
      }
      groups[locationName].machines.push(machine)
    })
    // Sort locations - Leesburg first, then alphabetically
    return Object.values(groups).sort((a, b) => {
      if (a.shortName === 'Leesburg') return -1
      if (b.shortName === 'Leesburg') return 1
      return a.shortName.localeCompare(b.shortName)
    })
  }, [machines])

  // Derive machine brand from machine name
  const getMachineBrand = (machineName) => {
    const name = machineName?.toLowerCase() || ''
    if (name.includes('mazak')) return 'Mazak'
    if (name.includes('nexturn')) return 'Nexturn'
    if (name.includes('ganesh')) return 'Ganesh'
    if (name.includes('bolt master')) return 'Bolt Master'
    if (name.includes('haas')) return 'Haas'
    return 'Other'
  }

  // Group machines by brand
  const machinesByType = useMemo(() => {
    const groups = {}
    machines.forEach(machine => {
      // Always derive brand from machine name
      const brandName = getMachineBrand(machine.name)
      if (!groups[brandName]) {
        groups[brandName] = {
          id: brandName.toLowerCase().replace(/\s+/g, '-'),
          name: brandName,
          shortName: brandName,
          code: '',
          machines: []
        }
      }
      groups[brandName].machines.push(machine)
    })
    // Sort by machine count (most machines first), then alphabetically
    return Object.values(groups).sort((a, b) => {
      if (b.machines.length !== a.machines.length) {
        return b.machines.length - a.machines.length
      }
      return a.name.localeCompare(b.name)
    })
  }, [machines])

  // Get current grouping based on mode
  const machineGroups = groupingMode === 'location' ? machinesByLocation : machinesByType

  // Group all future scheduled jobs by machine — used by list view
  const allScheduledByMachine = useMemo(() => {
    const grouped = {}
    allScheduledJobs.forEach(job => {
      if (!grouped[job.assigned_machine_id]) grouped[job.assigned_machine_id] = []
      grouped[job.assigned_machine_id].push(job)
    })
    // Enforce ascending order on scheduled_start (query already sorted, this is a safety net)
    Object.keys(grouped).forEach(mid => {
      grouped[mid].sort((a, b) => new Date(a.scheduled_start) - new Date(b.scheduled_start))
    })
    return grouped
  }, [allScheduledJobs])

  // Toggle group collapse
  const toggleGroupCollapse = (groupName) => {
    setCollapsedGroups(prev => 
      prev.includes(groupName) 
        ? prev.filter(g => g !== groupName)
        : [...prev, groupName]
    )
  }

  // Format duration as hours and minutes
  const formatDuration = (startDate, endDate) => {
    const durationMs = endDate - startDate
    const totalMinutes = Math.round(durationMs / 60000)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    if (hours === 0) return `${minutes}m`
    if (minutes === 0) return `${hours}h`
    return `${hours}h ${minutes}m`
  }

  // Global search: search across ALL jobs (scheduled + unscheduled)
  const handleGlobalSearch = useCallback((query) => {
    setGlobalSearch(query)

    if (globalSearchTimerRef.current) clearTimeout(globalSearchTimerRef.current)

    if (!query.trim()) {
      setGlobalSearchResults([])
      setShowGlobalResults(false)
      return
    }

    globalSearchTimerRef.current = setTimeout(async () => {
      const q = query.toLowerCase()

      // Search unassigned jobs (already loaded)
      const poolResults = unassignedJobs.filter(job =>
        job.job_number?.toLowerCase().includes(q) ||
        job.work_order?.wo_number?.toLowerCase().includes(q) ||
        job.work_order?.customer?.toLowerCase().includes(q) ||
        job.component?.part_number?.toLowerCase().includes(q)
      ).map(job => ({ ...job, _searchType: 'pool' }))

      // Search scheduled jobs on current week (already loaded)
      const schedResults = scheduledJobs.filter(job =>
        job.job_number?.toLowerCase().includes(q) ||
        job.work_order?.wo_number?.toLowerCase().includes(q) ||
        job.work_order?.customer?.toLowerCase().includes(q) ||
        job.component?.part_number?.toLowerCase().includes(q)
      ).map(job => ({ ...job, _searchType: 'scheduled' }))

      // Also search scheduled jobs beyond current week
      let remoteResults = []
      try {
        const { data } = await supabase
          .from('jobs')
          .select(`
            *,
            work_order:work_orders(id, wo_number, customer, priority, due_date),
            component:parts!component_id(id, part_number, description),
            assigned_machine:machines(id, name, code)
          `)
          .not('assigned_machine_id', 'is', null)
          .not('scheduled_start', 'is', null)
          .not('status', 'eq', 'cancelled')
          .or(`job_number.ilike.%${q}%`)
          .limit(20)

        if (data) {
          // Filter out jobs already in scheduledJobs
          const existingIds = new Set(scheduledJobs.map(j => j.id))
          remoteResults = data
            .filter(j => !existingIds.has(j.id))
            .map(j => ({ ...j, _searchType: 'scheduled-remote' }))
        }
      } catch (err) {
        // Swallow - we still have local results
      }

      // Also search by customer/part via separate queries if no job_number match
      if (remoteResults.length === 0) {
        try {
          const { data } = await supabase
            .from('jobs')
            .select(`
              *,
              work_order:work_orders!inner(id, wo_number, customer, priority, due_date),
              component:parts!component_id(id, part_number, description),
              assigned_machine:machines(id, name, code)
            `)
            .not('assigned_machine_id', 'is', null)
            .not('scheduled_start', 'is', null)
            .not('status', 'eq', 'cancelled')
            .ilike('work_order.customer', `%${q}%`)
            .limit(20)

          if (data) {
            const existingIds = new Set([...scheduledJobs, ...remoteResults].map(j => j.id))
            const customerMatches = data
              .filter(j => !existingIds.has(j.id))
              .map(j => ({ ...j, _searchType: 'scheduled-remote' }))
            remoteResults = [...remoteResults, ...customerMatches]
          }
        } catch (err) {}
      }

      const allResults = [...poolResults, ...schedResults, ...remoteResults].slice(0, 15)
      setGlobalSearchResults(allResults)
      setShowGlobalResults(allResults.length > 0)
    }, 300) // 300ms debounce
  }, [unassignedJobs, scheduledJobs])

  const navigateToJob = (job) => {
    setShowGlobalResults(false)
    setGlobalSearch('')

    if (job._searchType === 'pool') {
      // Job is in the pool — set the pool search to highlight it
      setSearchQuery(job.job_number)
      setHighlightedJobId(job.id)
      setTimeout(() => setHighlightedJobId(null), 3000)
    } else {
      // Scheduled job — navigate the timeline to its date
      if (job.scheduled_start) {
        const jobDate = new Date(job.scheduled_start)
        const today = new Date()
        today.setHours(0, 0, 0, 0)

        // Calculate the week offset needed
        const dayDiff = Math.floor((jobDate - today) / (1000 * 60 * 60 * 24))
        const neededWeekOffset = Math.floor(dayDiff / windowDays)
        setWeekOffset(neededWeekOffset)

        // Zoom into the day
        const dayStart = new Date(jobDate)
        dayStart.setHours(0, 0, 0, 0)
        setZoomedDay(dayStart)

        // Highlight the job block
        setHighlightedJobId(job.id)
        setTimeout(() => setHighlightedJobId(null), 3000)
      }
    }
  }

  // Close global search results when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (globalSearchRef.current && !globalSearchRef.current.contains(e.target)) {
        setShowGlobalResults(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Count machines that are DOWN
  const downMachineCount = useMemo(() => {
    return machines.filter(m => isMachineDown(m)).length
  }, [machines, ongoingDowntimes, activeMaintenanceJobs])

  // Block content component — adapts layout based on block size
  const JobBlockContent = ({ job, sizeTier }) => {
    const isMaint = isMaintenanceJob(job)
    // D-SCHED-04/05: projection-aware content — machine-done (actual_end
    // set) and pulled-forward context. Null on historic windows, so past
    // weeks show the scheduled times.
    const proj = getLiveSpan(job.id)
    const machineDone = !!job.actual_end
    const isUnplanned = job.work_order?.maintenance_type === 'unplanned'
    const isCompleted = job.status === 'complete' || job.status === 'manufacturing_complete'

    // Line 1: Part number (or maintenance type) + warning icons
    const line1 = isMaint
      ? (isUnplanned ? 'UNPLANNED' : 'MAINTENANCE')
      : (job.component?.part_number || job.job_number)

    // Time range string — live: projected/truncated spans show their
    // effective times; the real schedule stays in the popup.
    const timeRange = proj
      ? `${formatTime(new Date(proj.start))} – ${formatTime(new Date(proj.end))}`
      : job.scheduled_start
        ? `${formatTime(job.scheduled_start)}${job.scheduled_end ? ` – ${formatTime(job.scheduled_end)}` : ''}`
        : ''

    return (
      <div className="flex flex-col justify-center min-w-0 w-full leading-tight py-0.5">
        {/* Line 1: Part number / maintenance label + icons */}
        <div className="flex items-center gap-0.5 min-w-0">
          {isUnplanned && (
            <AlertTriangle size={10} className="text-white flex-shrink-0" />
          )}
          {isOverdue(job) && !isMaint && (
            <AlertTriangle size={10} className="text-red-300 flex-shrink-0" />
          )}
          {isJobOverrun(job) && (
            <Clock
              size={10}
              className="text-red-400 animate-pulse flex-shrink-0"
              title="Running past scheduled end"
            />
          )}
          {isJobMissedSlot(job) && (
            <AlertTriangle
              size={10}
              className="text-amber-400 flex-shrink-0"
              title="Missed slot — never started. Drag to reschedule."
            />
          )}
          {proj?.projected && (
            <FastForward
              size={10}
              className="text-sky-300 flex-shrink-0"
              title={`Projected — scheduled ${formatTime(job.scheduled_start)}`}
            />
          )}
          <span className="text-white text-xs font-bold truncate">{line1}</span>
          {(mergeAllocs[job.id]?.length > 0) && (
            <Layers size={10} className="text-cyan-300 flex-shrink-0 ml-0.5" title={`Combined run · ${mergeAllocs[job.id].length + 1} orders`} />
          )}
          {isScheduleStale(job, mergeAllocs[job.id] || []) && (
            <AlertTriangle size={10} className="text-amber-400 flex-shrink-0 ml-0.5" title="Run target changed since scheduling — adjust the end date" />
          )}
          {job.requires_attendance && (
            <User size={10} className="text-white/70 flex-shrink-0 ml-0.5" />
          )}
          {(isCompleted || machineDone) && (
            <CheckCircle
              size={10}
              className="text-emerald-300 flex-shrink-0 ml-0.5"
              title={machineDone && !isCompleted ? 'Completed at kiosk — parts in finishing' : 'Complete'}
            />
          )}
        </div>

        {/* Line 2: Job number + quantity */}
        <div className="truncate text-white/70 text-[10px]">
          {isMaint ? (job.maintenance_description || job.job_number) : (() => {
            const extraQty = (mergeAllocs[job.id] || []).reduce((s, a) => s + (a.requested_qty || 0), 0)
            const qtyStr = extraQty > 0 ? `${job.quantity}+${extraQty}` : `${job.quantity}`
            return sizeTier === 'large'
              ? `${job.job_number} · Qty: ${qtyStr}`
              : `${job.job_number} (${qtyStr})`
          })()}
        </div>

        {/* Line 3: Customer + due date (large only) */}
        {sizeTier === 'large' && (
          <div className="truncate text-white/50 text-[10px]">
            {[
              job.work_order?.customer,
              job.work_order?.due_date ? `Due: ${formatDate(job.work_order.due_date)}` : null
            ].filter(Boolean).join(' · ') || '\u00A0'}
          </div>
        )}

        {/* Line 4 (large) / Line 3 (medium): Time range */}
        {sizeTier !== 'small' && timeRange && (
          <div className="truncate text-white/50 text-[10px]">
            {timeRange}
          </div>
        )}
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-skynet-accent border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-500 font-mono">Loading schedule...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-[calc(100vh-180px)] flex flex-col">
      {/* Header Bar */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <button
            onClick={() => onNavigate('mainframe')}
            className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft size={20} />
            <span>Back to Mainframe</span>
          </button>

          {/* Global Schedule Search */}
          <div className="relative" ref={globalSearchRef}>
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                type="text"
                placeholder="Search all jobs..."
                value={globalSearch}
                onChange={(e) => handleGlobalSearch(e.target.value)}
                onFocus={() => {
                  if (globalSearchResults.length > 0) setShowGlobalResults(true)
                }}
                className="w-64 pl-9 pr-8 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
              />
              {globalSearch && (
                <button
                  onClick={() => {
                    setGlobalSearch('')
                    setGlobalSearchResults([])
                    setShowGlobalResults(false)
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {/* Search Results Dropdown */}
            {showGlobalResults && globalSearchResults.length > 0 && (
              <div className="absolute top-full left-0 mt-1 w-96 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 max-h-80 overflow-y-auto">
                {globalSearchResults.map(result => (
                  <button
                    key={result.id}
                    onClick={() => navigateToJob(result)}
                    className="w-full text-left px-3 py-2 hover:bg-gray-700 transition-colors border-b border-gray-700/50 last:border-b-0"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-white font-mono text-sm font-medium">{result.job_number}</span>
                      {result.component?.part_number && (
                        <span className="text-skynet-accent text-xs">{result.component.part_number}</span>
                      )}
                      <span className={`ml-auto text-xs px-1.5 py-0.5 rounded ${
                        result._searchType === 'pool'
                          ? 'bg-yellow-900/50 text-yellow-400'
                          : 'bg-green-900/50 text-green-400'
                      }`}>
                        {result._searchType === 'pool' ? 'Unscheduled' : 'Scheduled'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {result.work_order?.customer && (
                        <span className="text-gray-400 text-xs truncate">{result.work_order.customer}</span>
                      )}
                      {result._searchType !== 'pool' && result.scheduled_start && (
                        <span className="text-gray-500 text-xs">
                          {new Date(result.scheduled_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          {result.assigned_machine?.name && ` · ${result.assigned_machine.name}`}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Title + weekly count removed for space — page is labeled "Command" in the top breadcrumb */}
          {/* DOWN machines indicator */}
          {downMachineCount > 0 && (
            <span className="flex items-center gap-1 text-sm text-red-400 bg-red-900/30 px-2 py-1 rounded">
              <AlertTriangle size={14} />
              {downMachineCount} DOWN
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* SKY57 — Change Requests review queue (admin/scheduler) */}
          {canEdit && (
            <div className="relative mr-2">
              <button
                onClick={() => setShowChangeRequests(s => !s)}
                className="relative flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm font-medium rounded-lg transition-colors"
                title="Messages — change requests & acknowledgements"
              >
                <CalendarClock size={16} />
                <span className="hidden sm:inline">Messages</span>
                {(changeRequests.length + lotSplitAcks.length + staleScheduled.length) > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center bg-blue-600 text-white text-[10px] font-bold rounded-full">
                    {changeRequests.length + lotSplitAcks.length + staleScheduled.length}
                  </span>
                )}
              </button>
              {showChangeRequests && (
                <div className="absolute right-0 top-full mt-2 w-[420px] max-h-[70vh] overflow-y-auto bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-50 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-white font-semibold text-sm flex items-center gap-2">
                      <CalendarClock size={16} className="text-blue-400" />
                      Messages
                    </h3>
                    <button onClick={() => setShowChangeRequests(false)} className="text-gray-500 hover:text-gray-200">
                      <X size={16} />
                    </button>
                  </div>
                  {staleScheduled.length > 0 && (
                    <div className="mb-3">
                      <p className="text-amber-400 text-[11px] uppercase tracking-wider mb-1.5">Run target changed ({staleScheduled.length})</p>
                      <div className="space-y-1">
                        {staleScheduled.map(sj => (
                          <div key={sj.id} className="bg-gray-800/60 border border-amber-800/50 rounded p-2 text-xs flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <span className="text-skynet-accent font-mono">{sj.component?.part_number || sj.job_number}</span>
                              <span className="text-gray-500 font-mono ml-2">{sj.job_number}</span>
                              <span className="text-gray-500 ml-2">{sj.assigned_machine?.code || ''}</span>
                              <div className="text-gray-400 mt-0.5">
                                Scheduled for <span className="font-mono">{(sj.schedule_qty_basis || 0).toLocaleString()}</span> · run target now <span className="font-mono text-amber-300">{getRunTarget(sj, mergeAllocs[sj.id] || []).toLocaleString()}</span>
                              </div>
                            </div>
                            <button
                              onClick={() => { setShowChangeRequests(false); handleOpenEndDateEdit(sj) }}
                              className="shrink-0 px-2 py-1 bg-amber-700/60 hover:bg-amber-600/60 text-amber-100 rounded font-semibold"
                            >
                              Adjust End Date
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <p className="text-gray-400 text-[11px] uppercase tracking-wider mb-1.5">Change Requests</p>
                  {changeRequests.length === 0 ? (
                    <p className="text-gray-500 text-sm italic py-4 text-center">No open requests</p>
                  ) : (
                    <div className="space-y-2">
                      {changeRequests.map(req => {
                        const j = req.job
                        const curEnd = (req.current_end || j?.scheduled_end)
                          ? new Date(req.current_end || j.scheduled_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                          : '—'
                        const reqEnd = req.requested_end
                          ? new Date(req.requested_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                          : '—'
                        const sourceLabel = req.source === 'kiosk'
                          ? `Kiosk${req.requester?.full_name ? ' · ' + req.requester.full_name : ''}`
                          : 'Production Meeting'
                        const busy = applyingRequestId === req.id
                        return (
                          <div key={req.id} className="bg-gray-800/60 border border-gray-700 rounded-lg p-3">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-white font-mono text-sm font-semibold">{j?.job_number || '—'}</span>
                                {j?.component?.part_number && (
                                  <span className="text-skynet-accent text-xs font-mono truncate">{j.component.part_number}</span>
                                )}
                              </div>
                              <span className="text-gray-500 text-[10px] uppercase tracking-wider shrink-0">{sourceLabel}</span>
                            </div>
                            <div className="flex items-center gap-2 mt-1 text-xs">
                              <span className="text-gray-400">{curEnd}</span>
                              <span className="text-gray-600">→</span>
                              <span className="text-blue-300 font-semibold">{reqEnd}</span>
                              {j?.assigned_machine?.code && (
                                <span className="text-gray-500 ml-auto">{j.assigned_machine.code}</span>
                              )}
                            </div>
                            {req.note && (
                              <p className="text-gray-400 text-xs mt-1 italic">"{req.note}"</p>
                            )}
                            <div className="flex items-center justify-end gap-2 mt-2">
                              <button
                                disabled={busy}
                                onClick={() => handleDismissChangeRequest(req)}
                                className="text-gray-400 hover:text-gray-200 text-xs px-2 py-1 disabled:opacity-50"
                              >
                                Dismiss
                              </button>
                              <button
                                disabled={busy}
                                onClick={() => handleApplyChangeRequest(req)}
                                className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1 rounded"
                              >
                                {busy ? 'Applying…' : 'Apply'}
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {/* Acknowledgements — lot-change splits surfaced to the scheduler (informational) */}
                  <p className="text-gray-400 text-[11px] uppercase tracking-wider mb-1.5 mt-3">Acknowledgements</p>
                  {lotSplitAcks.length === 0 ? (
                    <p className="text-gray-500 text-sm italic py-3 text-center">No new acknowledgements</p>
                  ) : (
                    <div className="space-y-2">
                      {lotSplitAcks.map(ack => {
                        const nj = ack.new_job
                        const inhEnd = nj?.scheduled_end
                          ? new Date(nj.scheduled_end).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                          : '—'
                        const tight = nj?.scheduled_end ? new Date(nj.scheduled_end) <= new Date() : false
                        const busy = acknowledgingSplitId === ack.id
                        return (
                          <div key={ack.id} className="bg-gray-800/60 border border-gray-700 rounded-lg p-3">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-gray-400 font-mono text-xs">{ack.original_job?.job_number || '—'}</span>
                                <span className="text-gray-600">→</span>
                                <span className="text-white font-mono text-sm font-semibold">{nj?.job_number || '—'}</span>
                                {nj?.component?.part_number && (
                                  <span className="text-skynet-accent text-xs font-mono truncate">{nj.component.part_number}</span>
                                )}
                              </div>
                              <span className="text-amber-400 text-[10px] uppercase tracking-wider shrink-0">Lot change</span>
                            </div>
                            <div className="flex items-center gap-2 mt-1 text-xs">
                              <span className="text-gray-400">{ack.new_job_qty} pcs remainder</span>
                              <span className="text-gray-600">·</span>
                              <span className="text-gray-400">due {inhEnd}</span>
                              {nj?.assigned_machine?.code && (
                                <span className="text-gray-500 ml-auto">{nj.assigned_machine.code}</span>
                              )}
                            </div>
                            {tight && (
                              <p className="text-amber-400 text-xs mt-1 flex items-center gap-1">
                                <AlertTriangle size={12} /> Inherited end has passed — remainder won't fit; review schedule.
                              </p>
                            )}
                            <div className="flex items-center justify-end gap-2 mt-2">
                              <button
                                disabled={busy}
                                onClick={() => handleAcknowledgeLotSplit(ack)}
                                className="bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1 rounded"
                              >
                                {busy ? 'Saving…' : 'Acknowledge'}
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Schedule Maintenance Button — admin/scheduler only */}
          {canEdit && (
            <button
              onClick={() => setShowMaintenanceModal(true)}
              className="flex items-center justify-center p-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors mr-2"
              title="Schedule Maintenance"
            >
              <Settings size={16} />
            </button>
          )}

          {/* D-AISCHED-04: Uncle Bob — AI Schedule Advisor (admin/scheduler) */}
          {canEdit && FEATURES.AI_SCHEDULER && (
            <button
              onClick={() => { loadAllScheduledJobs(); setAdvisorOpen(true) }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-skynet-accent hover:bg-skynet-accent/80 text-white rounded-lg transition-colors mr-2 text-sm"
              title="Uncle Bob — AI Schedule Advisor"
            >
              <Bot size={16} />
              <span className="hidden sm:inline">Uncle Bob</span>
            </button>
          )}

          {/* View mode toggle: Grid (timeline) vs List (per-machine lineup) */}
          <div className="flex items-center bg-gray-800 rounded-lg p-0.5 mr-2">
            <button
              onClick={() => setViewMode('grid')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                viewMode === 'grid'
                  ? 'bg-skynet-accent text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
              title="Timeline Grid View"
            >
              <LayoutGrid size={14} />
              <span className="hidden sm:inline">Grid</span>
            </button>
            <button
              onClick={() => {
                setViewMode('list')
                loadAllScheduledJobs()
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                viewMode === 'list'
                  ? 'bg-skynet-accent text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
              title="Machine Lineup List View"
            >
              <List size={14} />
              <span className="hidden sm:inline">List</span>
            </button>
          </div>

          {/* Timeline zoom: number of days visible in the grid window */}
          {viewMode === 'grid' && !zoomedDay && (
            <div className="flex items-center bg-gray-800 rounded-lg p-0.5 mr-2">
              {[{ d: 7, label: 'Week' }, { d: 14, label: '2-Week' }, { d: 28, label: '4-Week' }].map(opt => (
                <button
                  key={opt.d}
                  onClick={() => { setWindowDays(opt.d); setWeekOffset(0) }}
                  className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                    windowDays === opt.d
                      ? 'bg-skynet-accent text-white'
                      : 'text-gray-400 hover:text-white'
                  }`}
                  title={`Show ${opt.d} days`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}

          {/* Grouping toggle removed for space — grouping stays fixed to Location (groupingMode default 'location') */}

          {/* Zoom out button when zoomed in */}
          {zoomedDay && (
            <button
              onClick={() => setZoomedDay(null)}
              className="flex items-center gap-2 px-3 py-1 text-sm rounded transition-colors bg-gray-800 text-gray-300 hover:text-white hover:bg-gray-700"
            >
              <ZoomOut size={16} />
              Week View
            </button>
          )}
          
          {viewMode === 'grid' && (
            <>
              <button
                onClick={() => {
                  setWeekOffset(0)
                  if (zoomedDay) {
                    // If in day view, also set zoomed day to today
                    const today = new Date()
                    today.setHours(0, 0, 0, 0)
                    setZoomedDay(today)
                  }
                }}
                className={`px-3 py-1 text-sm rounded transition-colors ${
                  weekOffset === 0 && (!zoomedDay || isToday(zoomedDay))
                    ? 'bg-skynet-accent text-white'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800'
                }`}
              >
                Today
              </button>
              <button
                onClick={() => {
                  if (zoomedDay) {
                    const newDate = new Date(zoomedDay)
                    newDate.setDate(newDate.getDate() - 1)
                    setZoomedDay(newDate)
                  } else {
                    setWeekOffset(weekOffset - 1)
                  }
                }}
                className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors"
              >
                <ChevronLeft size={20} />
              </button>
              <span className="text-white font-medium min-w-[180px] text-center">
                {zoomedDay ? formatFullDate(zoomedDay) : getWeekRangeLabel()}
              </span>
              <button
                onClick={() => {
                  if (zoomedDay) {
                    const newDate = new Date(zoomedDay)
                    newDate.setDate(newDate.getDate() + 1)
                    setZoomedDay(newDate)
                  } else {
                    setWeekOffset(weekOffset + 1)
                  }
                }}
                className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors"
              >
                <ChevronRight size={20} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex gap-4 min-h-0">
        {/* Left Panel - Job Pool */}
        <div className="w-80 flex-shrink-0 flex flex-col bg-gray-900 rounded-lg border border-gray-700 overflow-hidden">
          <div className="p-4 border-b border-gray-700">
            <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
              <Clock size={18} className="text-yellow-500" />
              Job Pool ({filteredJobs.length})
            </h3>
            
            <div className="relative mb-3">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                type="text"
                placeholder="Search jobs..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
              />
            </div>

            <div className="relative">
              <button
                onClick={() => setShowFilterMenu(!showFilterMenu)}
                className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
              >
                <Filter size={14} />
                <span>Sort by: {filterOptions.find(f => f.value === filterBy)?.label}</span>
              </button>
              
              {showFilterMenu && (
                <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-700 rounded shadow-lg z-10">
                  {filterOptions.map(option => (
                    <button
                      key={option.value}
                      onClick={() => {
                        setFilterBy(option.value)
                        setShowFilterMenu(false)
                      }}
                      className={`block w-full text-left px-4 py-2 text-sm transition-colors ${
                        filterBy === option.value 
                          ? 'bg-skynet-accent text-white' 
                          : 'text-gray-300 hover:bg-gray-700'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {filteredJobs.length > 0 && (
            <div className="px-4 py-2 bg-gray-800/50 border-b border-gray-700">
              <p className="text-xs text-gray-500 text-center">
                Drag a job to the timeline to schedule it
              </p>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {filteredJobs.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-gray-500">No jobs awaiting schedule</p>
              </div>
            ) : (
              filteredJobs.map(job => {
                const machineOptions = getMachineOptionsForPart(job.component_id)
                const hasPreferred = machineOptions.some(o => o.is_preferred)

                return (
                  <div
                    key={job.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, job)}
                    onDragEnd={handleDragEnd}
                    className={`rounded-lg p-3 border-l-4
                      cursor-grab active:cursor-grabbing hover:bg-gray-750 transition-all touch-manipulation
                      ${draggedJob?.id === job.id ? 'opacity-50 scale-95' : ''}
                      ${highlightedJobId === job.id ? 'ring-2 ring-skynet-accent animate-pulse' : ''}
                      bg-gray-800 ${getPriorityBorder(job.priority)}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap min-w-0">
                          <span className="font-mono font-semibold text-white truncate">
                            {job.component?.part_number || job.job_number}
                          </span>
                          <div className={`w-2 h-2 rounded-full ${getPriorityColor(job.priority)}`}></div>
                          {hasPreferred && (
                            <Star size={12} className="text-yellow-500" title="Has preferred machine" />
                          )}
                          {job.has_open_shortfall && (
                            <span
                              className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-red-950/60 text-red-300 border border-red-700"
                              title="This job has an unresolved shortfall — Scheduler review needed"
                            >
                              <AlertTriangle size={10} /> Shortfall
                            </span>
                          )}
                        </div>
                        <p className="text-gray-400 text-sm truncate">{job.work_order?.wo_number}</p>
                        <p className="text-skynet-accent text-xs font-mono truncate">{job.job_number}</p>
                        <p className="text-gray-400 text-xs">Qty: {job.quantity}</p>
                        {job.work_order?.customer && (
                          <p className="text-gray-500 text-xs truncate">{job.work_order.customer}</p>
                        )}
                        {job.status === 'pending_compliance' && (
                          <span className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full bg-amber-900/50 text-amber-400 border border-amber-700/50 mt-1 w-fit">
                            <Clock size={10} />
                            Compliance Pending
                          </span>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <GripVertical size={16} className="text-gray-600" />
                        {job.work_order?.due_date && (
                          <span className="text-xs text-gray-500">
                            Due: {formatDate(job.work_order.due_date)}
                          </span>
                        )}
                        {job.estimated_minutes ? (
                          <span className="text-xs text-gray-400">
                            ~{Math.round(job.estimated_minutes / 60)}h
                          </span>
                        ) : machineOptions.length > 0 ? (
                          <span className="text-xs text-blue-400 flex items-center gap-1">
                            <Database size={10} />
                            Has estimates
                          </span>
                        ) : (
                          <span className="text-xs text-orange-500 flex items-center gap-1">
                            <AlertCircle size={10} />
                            No estimate
                          </span>
                        )}
                        {canEdit && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setScheduleClickJob(job)
                            setScheduleClickEditMode(false)
                          }}
                          className="mt-1 flex items-center gap-1 px-2 py-1 bg-skynet-accent/20 hover:bg-skynet-accent text-skynet-accent hover:text-white text-xs font-medium rounded transition-colors"
                          title="Schedule this job"
                        >
                          <Calendar size={10} />
                          Schedule
                        </button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Right Panel - Timeline (grid view) OR Machine Lineup (list view) */}
        {viewMode === 'grid' ? (
        <div className="flex-1 flex flex-col bg-gray-900 rounded-lg border border-gray-700 overflow-hidden min-w-0">
          {/* Timeline Header */}
          <div className="flex border-b border-gray-700">
            <div className={`w-32 flex-shrink-0 p-3 border-r border-gray-700 bg-gray-850`}>
              <span className="text-gray-400 text-sm font-medium">Machine</span>
            </div>
            
            {/* Week View Headers */}
            {!zoomedDay && (
              <div className="flex-1 flex overflow-x-hidden" ref={headerScrollRef} onScroll={handleHeaderScroll}>
                {weekDates.map((date, index) => (
                  <div 
                    key={index}
                    onClick={() => setZoomedDay(new Date(date))}
                    className={`flex-1 min-w-[150px] p-2 text-center border-r border-gray-800 last:border-r-0 cursor-pointer hover:bg-gray-800 transition-colors ${
                      isToday(date) ? 'bg-skynet-accent/10' : ''
                    }`}
                  >
                    <div className="flex items-center justify-center gap-2">
                      <span className={`text-sm font-medium ${isToday(date) ? 'text-skynet-accent' : 'text-gray-300'}`}>
                        {formatWeekDate(date)}
                      </span>
                      <ZoomIn size={14} className="text-gray-500" />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Day View - placeholder header */}
            {zoomedDay && (
              <div className="flex-1 p-2 text-center text-gray-500 text-sm">
                ← Scroll horizontally to view all hours →
              </div>
            )}
          </div>

          {/* Machine Rows / Swim Lanes */}
          <div className={`flex-1 overflow-auto`} ref={bodyScrollRef} onScroll={handleBodyScroll}>
            <div className={(zoomedDay || windowDays > 7) ? 'min-w-max' : ''}>
            {/* Day View Hour Headers - inside scrollable area */}
            {zoomedDay && (
              <div className="flex border-b border-gray-700 sticky top-0 z-20 bg-gray-900">
                <div className="w-32 flex-shrink-0 p-2 border-r border-gray-700 bg-gray-850 sticky left-0 z-30">
                  <span className="text-gray-500 text-xs">Hour</span>
                </div>
                <div className="flex" style={{ width: `${24 * 60}px` }}>
                  {dayHours.map(hour => (
                    <div 
                      key={hour}
                      className={`w-[60px] flex-shrink-0 p-2 text-center border-r border-gray-800 ${
                        isOnShift(hour) ? 'bg-gray-900' : 'bg-gray-800/50'
                      }`}
                    >
                      <span className={`text-xs font-medium ${isOnShift(hour) ? 'text-gray-300' : 'text-gray-500'}`}>
                        {formatHour(hour)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {machines.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-gray-500">No machines configured</p>
              </div>
            ) : (
              machineGroups.map(group => (
                <div key={group.id}>
                  {/* Group Header */}
                  <div 
                    onClick={() => toggleGroupCollapse(group.name)}
                    className={`flex items-center border-b border-gray-700 bg-gray-800 cursor-pointer hover:bg-gray-750 transition-colors ${
                      zoomedDay ? 'sticky left-0 z-20' : ''
                    }`}
                  >
                    <div className={`w-32 flex-shrink-0 p-2 border-r border-gray-700 flex items-center gap-2 ${
                      zoomedDay ? 'sticky left-0 z-20 bg-gray-800' : ''
                    }`}>
                      <ChevronDown 
                        size={16} 
                        className={`text-gray-400 transition-transform ${
                          collapsedGroups.includes(group.name) ? '-rotate-90' : ''
                        }`} 
                      />
                      {groupingMode === 'location' ? (
                        <MapPin size={14} className="text-skynet-accent" />
                      ) : (
                        <Wrench size={14} className="text-purple-400" />
                      )}
                      <span className="text-white font-medium text-sm">{group.shortName}</span>
                      <span className="text-gray-500 text-xs">({group.machines.length})</span>
                    </div>
                    {/* Empty space for timeline columns */}
                    <div className="flex-1 h-8"></div>
                  </div>
                  
                  {/* Machines in this group */}
                  {!collapsedGroups.includes(group.name) && (
                    group.machines.map(machine => {
                      const isPreferred = isMachinePreferred(machine.id)
                      const hasDuration = machineHasDuration(machine.id)
                      const isResizingOnThisMachine = resizing?.job?.assigned_machine_id === machine.id
                      const weeklyUtil = getWeeklyUtilization(machine.id)
                      
                      // NEW: Check if this machine is DOWN
                      const isDown = isMachineDown(machine)
                      const downReason = isDown ? getMachineDownReason(machine) : null
                      
                      return (
                        <div key={machine.id} className={`flex border-b border-gray-800 last:border-b-0 min-h-[60px] ${
                          (draggedJob || draggedScheduledJob) && isPreferred ? 'bg-yellow-900/10' : ''
                        } ${isResizingOnThisMachine ? 'overflow-visible z-20' : ''}`}>
                          <div className={`w-32 flex-shrink-0 p-3 pl-6 border-r border-gray-700 bg-gray-850 flex flex-col justify-center ${
                            zoomedDay ? 'sticky left-0 z-10' : ''
                          } ${
                            (draggedJob || draggedScheduledJob) && isPreferred ? 'bg-yellow-900/20' : ''
                          } ${
                            isDown ? 'bg-red-950/30' : ''
                          }`}>
                            <div className="flex items-center gap-1">
                              <span className="text-white font-medium text-sm">{machine.name}</span>
                              {/* DOWN indicator - shows for any DOWN source */}
                              {isDown && (
                                <span className="px-1.5 py-0.5 bg-red-600 text-white text-[9px] font-bold rounded animate-pulse flex items-center gap-0.5">
                                  <AlertTriangle size={8} />
                                  DOWN
                                </span>
                              )}
                              {(draggedJob || draggedScheduledJob) && isPreferred && (
                                <Star size={12} className="text-yellow-500" />
                              )}
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-gray-500 text-xs font-mono">{machine.code}</span>
                              {(draggedJob || draggedScheduledJob) && hasDuration && (
                                <Database size={10} className="text-blue-400" title="Has duration estimate" />
                              )}
                            </div>
                            {/* DOWN reason tooltip */}
                            {isDown && downReason && (
                              <p className="text-red-400 text-[9px] truncate mt-0.5" title={downReason}>
                                {downReason.length > 30 ? `${downReason.slice(0, 30)}...` : downReason}
                              </p>
                            )}
                            {/* Weekly utilization bar - only show when not DOWN */}
                            {!zoomedDay && weeklyUtil > 0 && !isDown && (
                              <div className="mt-1 flex items-center gap-1" title={`${weeklyUtil}% of shift hours scheduled this week`}>
                                <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                                  <div 
                                    className={`h-full rounded-full transition-all ${
                                      weeklyUtil >= 90 ? 'bg-red-500' : 
                                      weeklyUtil >= 70 ? 'bg-yellow-500' : 
                                      'bg-green-500'
                                    }`}
                                    style={{ width: `${Math.min(weeklyUtil, 100)}%` }}
                                  />
                                </div>
                                <span className={`text-[10px] font-medium ${
                                  weeklyUtil >= 90 ? 'text-red-400' : 
                                  weeklyUtil >= 70 ? 'text-yellow-400' : 
                                  'text-green-400'
                                }`}>
                                  {weeklyUtil}%
                                </span>
                              </div>
                            )}
                          </div>
                          
                          {/* Week View Timeline */}
                          {!zoomedDay && (
                            <div className="flex-1 flex">
                              {weekDates.map((date, dayIndex) => {
                                const dayJobs = getJobsForMachineDay(machine.id, date)
                                const isTarget = isDropTarget(machine.id, date)
                                const dayUtil = getDayUtilization(machine.id, date)
                                const isDayFull = dayUtil >= 90
                                
                                return (
                                  <div 
                                    key={dayIndex}
                                    onDragOver={(e) => handleDragOver(e, machine.id, date)}
                                    onDragLeave={handleDragLeave}
                                    onDrop={(e) => handleDrop(e, machine.id, date)}
                                    className={`flex-1 min-w-[150px] border-r border-gray-800 last:border-r-0 relative transition-colors ${
                                      isToday(date) ? 'bg-skynet-accent/5' : ''
                                    } ${isTarget ? 'bg-skynet-accent/20 ring-2 ring-inset ring-skynet-accent' : ''}
                                    ${isDown ? 'bg-red-950/20' : ''}`}
                                  >
                                    {/* Shift capacity indicator bar at bottom */}
                                    {dayUtil > 0 && (
                                      <div className="absolute bottom-0 left-0 right-0 h-1 bg-gray-800 z-[5]">
                                        <div 
                                          className={`h-full transition-all ${
                                            dayUtil >= 90 ? 'bg-red-500/70' : 
                                            dayUtil >= 70 ? 'bg-yellow-500/50' : 
                                            'bg-green-500/40'
                                          }`}
                                          style={{ width: `${Math.min(dayUtil, 100)}%` }}
                                          title={`${dayUtil}% of shift scheduled`}
                                        />
                                      </div>
                                    )}
                                    
                                    {/* "Full" indicator when >= 90% */}
                                    {isDayFull && (
                                      <div className="absolute top-0.5 right-0.5 z-[6]">
                                        <span className="text-[9px] font-bold text-red-400 bg-gray-900/80 px-1 rounded">
                                          FULL
                                        </span>
                                      </div>
                                    )}
                                    
                                    <div className="absolute inset-0 flex pointer-events-none">
                                      <div className="w-[29.17%] bg-gray-800/30"></div>
                                      <div className="w-[37.5%] bg-transparent"></div>
                                      <div className="w-[33.33%] bg-gray-800/30"></div>
                                    </div>
                                    
                                    {isTarget && (
                                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
                                        <span className="text-skynet-accent text-xs font-medium bg-gray-900/80 px-2 py-1 rounded">
                                          Drop to schedule
                                        </span>
                                      </div>
                                    )}
                                    
                                    <div className="absolute inset-0 p-1 overflow-visible">
                                {dayJobs.map(job => {
                                  const style = getJobBlockStyle(job, date)
                                  if (!style) return null
                                  const isCompleted = job.status === 'complete' || job.status === 'manufacturing_complete'
                                  const hasCancelledAlloc = !!job.work_order?.has_cancelled_allocation

                                  return (
                                    <div
                                      key={job.id}
                                      draggable={!isCompleted}
                                      onDragStart={(e) => handleScheduledDragStart(e, job)}
                                      onDragEnd={handleDragEnd}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setSelectedJob(job)
                                      }}
                                      className={`absolute top-1 bottom-1 ${getJobBlockColor(job)}
                                        rounded ${!isCompleted ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} ${getPriorityAccentBorder(job)} hover:brightness-110 transition-all
                                        flex items-center overflow-hidden px-1.5
                                        ${style.continuesFromPrevious ? 'rounded-l-none border-l-0' : ''}
                                        ${style.continuesToNext ? 'rounded-r-none' : ''}
                                        ${draggedScheduledJob?.id === job.id ? 'opacity-50' : ''}
                                        ${style.isMultiDay ? 'z-10' : 'z-[1]'}
                                        ${highlightedJobId === job.id ? 'ring-2 ring-white animate-pulse !z-20' : ''}
                                        ${hasCancelledAlloc ? 'ring-2 ring-amber-500' : ''}
                                        ${style.isMultiDay && (draggedJob || (draggedScheduledJob && draggedScheduledJob.id !== job.id)) ? 'pointer-events-none' : ''}`}
                                      style={{
                                        left: style.left,
                                        width: style.width
                                      }}
                                      title={`${job.job_number} - ${isMaintenanceJob(job) ? (job.maintenance_description || 'Maintenance') : job.component?.part_number} - Qty: ${job.quantity}${isCompleted ? ' (Complete)' : job.status === 'in_progress' ? ' (In Progress)' : ' (drag to reschedule)'}${isOverdue(job) ? ' ⚠️ OVERDUE' : ''}${job.work_order?.maintenance_type === 'unplanned' ? ' ⚠️ UNPLANNED' : ''}${hasCancelledAlloc ? ' ⚠️ Customer order cancelled — review allocation' : ''}`}
                                    >
                                      <JobBlockContent job={job} sizeTier={getBlockSizeTier(style.durationHours)} />
                                    </div>
                                  )
                                })}
                                {/* SKY58 — ongoing kiosk-logged downtime as a timeline block (parity with the
                                    maintenance block). Only for a machine DOWN with no DTU/maintenance job, which
                                    already draws its own block. Positioned via the job positioner by treating the
                                    open-ended downtime as an ongoing, no-end span (extends to end of view). */}
                                {(() => {
                                  if (getActiveMaintenanceForMachine(machine.id)) return null
                                  const dt = getOngoingDowntimeForMachine(machine.id)
                                  if (!dt) return null
                                  const dtStyle = getJobBlockStyle(
                                    { scheduled_start: dt.start_time, scheduled_end: null, status: 'in_progress', estimated_minutes: 60 },
                                    date
                                  )
                                  if (!dtStyle) return null
                                  const dtDetail = dt.notes ? `${dt.reason} — ${dt.notes}` : dt.reason
                                  return (
                                    <div
                                      key={`downtime-${dt.id}`}
                                      onClick={(e) => e.stopPropagation()}
                                      className={`absolute top-1 bottom-1 bg-red-900/80 border border-red-600 rounded cursor-default flex items-center overflow-hidden px-1.5 z-[2] ${dtStyle.continuesFromPrevious ? 'rounded-l-none border-l-0' : ''} ${dtStyle.continuesToNext ? 'rounded-r-none' : ''}`}
                                      style={{ left: dtStyle.left, width: dtStyle.width }}
                                      title={`DOWN — ${dtDetail} (since ${formatTime(dt.start_time)})`}
                                    >
                                      <div className="flex flex-col justify-center min-w-0 w-full leading-tight py-0.5">
                                        <div className="flex items-center gap-0.5 min-w-0">
                                          <AlertTriangle size={10} className="text-white flex-shrink-0" />
                                          <span className="text-white text-xs font-bold truncate">DOWN</span>
                                        </div>
                                        <div className="truncate text-white/80 text-[10px]">{dtDetail}</div>
                                      </div>
                                    </div>
                                  )
                                })()}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {/* Day View Timeline (Zoomed) */}
                    {zoomedDay && (
                      <div className="flex-1">
                        <div className={`relative ${resizing?.job?.assigned_machine_id === machine.id ? 'overflow-visible' : ''} ${isDown ? 'bg-red-950/10' : ''}`} style={{ width: `${24 * 60}px`, height: '58px' }}>
                          {/* Hour cells */}
                          <div className="absolute inset-0 flex">
                            {dayHours.map(hour => {
                              const isTarget = isDropTarget(machine.id, zoomedDay, hour)
                              
                              return (
                                <div
                                  key={hour}
                                  onDragOver={(e) => handleDragOver(e, machine.id, zoomedDay, hour)}
                                  onDragLeave={handleDragLeave}
                                  onDrop={(e) => handleDrop(e, machine.id, zoomedDay, hour)}
                                  className={`w-[60px] flex-shrink-0 border-r border-gray-800 transition-colors ${
                                    isOnShift(hour) ? '' : 'bg-gray-800/30'
                                  } ${isTarget ? 'bg-skynet-accent/30' : ''}`}
                                />
                              )
                            })}
                          </div>
                          
                          {/* Job blocks */}
                          {getJobsForMachineDay(machine.id, zoomedDay).map(job => {
                            const style = getJobBlockStyleZoomedWithPreview(job, zoomedDay)
                            if (!style) return null
                            
                            const isResizingThis = resizing?.jobId === job.id
                            const isCompleted = job.status === 'complete' || job.status === 'manufacturing_complete'
                            const canDrag = !isResizingThis && !isCompleted
                            const canResize = !isCompleted
                            const hasCancelledAlloc = !!job.work_order?.has_cancelled_allocation

                            return (
                              <div
                                key={job.id}
                                draggable={canDrag}
                                onDragStart={(e) => canDrag && handleScheduledDragStart(e, job)}
                                onDragEnd={handleDragEnd}
                                onClick={(e) => {
                                  if (!isResizingThis) {
                                    e.stopPropagation()
                                    setSelectedJob(job)
                                  }
                                }}
                                className={`absolute top-1 bottom-1 ${getJobBlockColor(job)}
                                  rounded ${canDrag ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} ${getPriorityAccentBorder(job)} hover:brightness-110 transition-all
                                  flex items-center px-2 group
                                  ${isResizingThis ? 'overflow-visible' : 'overflow-hidden'}
                                  ${style.continuesFromPrevious ? 'rounded-l-none border-l-0' : ''}
                                  ${style.continuesToNext ? 'rounded-r-none' : ''}
                                  ${draggedScheduledJob?.id === job.id ? 'opacity-50' : ''}
                                  ${isResizingThis ? 'ring-2 ring-white cursor-ew-resize z-30' : ''}
                                  ${!isResizingThis && highlightedJobId === job.id ? 'ring-2 ring-white animate-pulse z-20' : ''}
                                  ${hasCancelledAlloc && !isResizingThis ? 'ring-2 ring-amber-500' : ''}`}
                                style={{
                                  left: style.left,
                                  width: style.width
                                }}
                                title={`${job.job_number} - ${isMaintenanceJob(job) ? (job.maintenance_description || 'Maintenance') : job.component?.part_number} - Qty: ${job.quantity}${isCompleted ? ' (Complete)' : job.status === 'in_progress' ? ' (In Progress)' : ' (drag to reschedule, drag edges to resize)'}${isOverdue(job) ? ' ⚠️ OVERDUE' : ''}${job.work_order?.maintenance_type === 'unplanned' ? ' ⚠️ UNPLANNED' : ''}${hasCancelledAlloc ? ' ⚠️ Customer order cancelled — review allocation' : ''}`}
                              >
                                {/* Left resize handle - only for non-completed jobs */}
                                {!style.continuesFromPrevious && canResize && (
                                  <div
                                    onMouseDown={(e) => handleResizeStart(e, job, 'start')}
                                    className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/30 opacity-0 group-hover:opacity-100 transition-opacity"
                                    title="Drag to adjust start time"
                                  />
                                )}

                                <JobBlockContent job={job} sizeTier={getBlockSizeTier(style.endHour - style.startHour)} />
                                
                                {/* Duration indicator during resize */}
                                {isResizingThis && (
                                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-gray-900 border border-skynet-accent px-2 py-1 rounded text-xs text-white whitespace-nowrap z-50 shadow-lg pointer-events-none">
                                    {resizePreview ? (
                                      <>
                                        <span className="text-skynet-accent font-medium">{formatDuration(resizePreview.newStart, resizePreview.newEnd)}</span>
                                        <span className="text-gray-400 ml-1">
                                          ({resizePreview.newStart.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} - {resizePreview.newEnd.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})
                                        </span>
                                      </>
                                    ) : (
                                      <>
                                        <span className="text-skynet-accent font-medium">{formatDuration(resizing.initialStart, resizing.initialEnd)}</span>
                                        <span className="text-gray-400 ml-1">
                                          ({resizing.initialStart.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} - {resizing.initialEnd.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})
                                        </span>
                                      </>
                                    )}
                                  </div>
                                )}
                                
                                {/* Right resize handle - only for non-completed jobs */}
                                {!style.continuesToNext && canResize && (
                                  <div
                                    onMouseDown={(e) => handleResizeStart(e, job, 'end')}
                                    className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/30 opacity-0 group-hover:opacity-100 transition-opacity"
                                    title="Drag to adjust end time"
                                  />
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        ))
      )}
            </div>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-6 p-3 border-t border-gray-700 bg-gray-850 text-xs flex-wrap">
            <span className="text-gray-500">Legend:</span>
            <div className="flex items-center gap-2">
              <div className="w-4 h-3 bg-transparent border border-gray-600 rounded-sm"></div>
              <span className="text-gray-400">On-shift (7am-4pm)</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-3 bg-gray-800/50 border border-gray-700 rounded-sm"></div>
              <span className="text-gray-400">Off-shift</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-3 bg-blue-500 ring-2 ring-blue-300 ring-offset-1 ring-offset-gray-900 rounded-sm"></div>
              <span className="text-gray-400">In Setup</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-3 bg-teal-600 ring-2 ring-teal-300 ring-offset-1 ring-offset-gray-900 rounded-sm"></div>
              <span className="text-gray-400">In Progress</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-3 bg-gray-700/50 border border-gray-500 opacity-60 rounded-sm"></div>
              <span className="text-gray-400">Complete</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-3 bg-green-600 border-l-4 border-l-red-500 rounded-sm"></div>
              <span className="text-gray-400">Critical</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-3 bg-green-600 border-l-4 border-l-yellow-500 rounded-sm"></div>
              <span className="text-gray-400">High Priority</span>
            </div>
            <div className="flex items-center gap-2">
              <AlertTriangle size={12} className="text-red-400" />
              <span className="text-gray-400">Overdue</span>
            </div>
            <div className="flex items-center gap-2">
              <Star size={12} className="text-yellow-500" />
              <span className="text-gray-400">Preferred</span>
            </div>
            <div className="flex items-center gap-2">
              <Database size={12} className="text-blue-400" />
              <span className="text-gray-400">Has Duration</span>
            </div>
            <div className="flex items-center gap-2">
              <User size={12} className="text-gray-400" />
              <span className="text-gray-400">Attended</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-3 bg-blue-600 border border-blue-400 rounded-sm"></div>
              <span className="text-gray-400">Planned Maint.</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-3 bg-purple-600 border border-purple-400 rounded-sm"></div>
              <span className="text-gray-400">Unplanned Maint.</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-1 py-0.5 bg-red-600 text-white text-[8px] font-bold rounded">DOWN</span>
              <span className="text-gray-400">Machine Down</span>
            </div>
            {!zoomedDay && (
              <>
                <div className="flex items-center gap-2 border-l border-gray-700 pl-4">
                  <div className="flex items-center gap-1">
                    <div className="w-3 h-1.5 bg-green-500 rounded-full"></div>
                    <div className="w-3 h-1.5 bg-yellow-500 rounded-full"></div>
                    <div className="w-3 h-1.5 bg-red-500 rounded-full"></div>
                  </div>
                  <span className="text-gray-400">Utilization</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-bold text-red-400 bg-gray-800 px-1 rounded">FULL</span>
                  <span className="text-gray-400">≥90% scheduled</span>
                </div>
                <div className="flex items-center gap-2 ml-auto">
                  <ZoomIn size={12} className="text-gray-400" />
                  <span className="text-gray-400">Click day header to zoom</span>
                </div>
              </>
            )}
          </div>
        </div>
        ) : (
          /* --- LIST VIEW: per-machine lineup of all future scheduled jobs --- */
          <div className="flex-1 flex flex-col bg-gray-900 rounded-lg border border-gray-700 overflow-hidden min-w-0">
            <div className="flex-1 overflow-y-auto">
              <div className="space-y-6 px-4 py-4">
                {machineGroups.map(group => (
                  <div key={group.id}>
                    {/* Group header — same style as grid */}
                    <div className="flex items-center gap-2 mb-3 px-2 py-1.5 bg-gray-800 rounded-lg">
                      {groupingMode === 'location'
                        ? <MapPin size={14} className="text-skynet-accent" />
                        : <Wrench size={14} className="text-purple-400" />}
                      <span className="text-white font-medium text-sm">
                        {group.shortName}
                      </span>
                      <span className="text-gray-500 text-xs">
                        ({group.machines.length} machines)
                      </span>
                    </div>

                    {/* Machine cards grid */}
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                      {group.machines.map(machine => {
                        const jobs = allScheduledByMachine[machine.id] || []
                        const isDown = isMachineDown(machine)
                        const anyDragActive = !!(draggedJob || draggedScheduledJob)

                        return (
                          <div
                            key={machine.id}
                            onDragOver={(e) => {
                              if (!anyDragActive) return
                              e.preventDefault()
                              // Use functional setState to read latest value synchronously —
                              // avoids stale closure when child "after" zones update state.
                              setListDropTarget(prev =>
                                prev?.type === 'after'
                                  ? prev
                                  : { type: 'machine', machineId: machine.id }
                              )
                            }}
                            onDragLeave={(e) => {
                              if (!e.currentTarget.contains(e.relatedTarget)) {
                                setListDropTarget(null)
                              }
                            }}
                            onDrop={(e) => handleListDropOnMachine(e, machine.id)}
                            className={`bg-gray-900 rounded-xl border transition-all duration-150 overflow-hidden ${
                              listDropTarget?.type === 'machine' &&
                              listDropTarget?.machineId === machine.id
                                ? 'border-skynet-accent ring-1 ring-skynet-accent/30'
                                : 'border-gray-800'
                            }`}
                          >
                            {/* Machine header */}
                            <div className={`flex items-center justify-between px-4 py-3 border-b border-gray-800 ${
                              isDown ? 'bg-red-950/40' : 'bg-gray-850'
                            }`}>
                              <div className="flex items-center gap-2">
                                <span className="text-white font-semibold">
                                  {machine.name}
                                </span>
                                {isDown && (
                                  <span className="px-1.5 py-0.5 bg-red-600 text-white text-[9px] font-bold rounded animate-pulse flex items-center gap-0.5">
                                    <AlertTriangle size={8} />
                                    DOWN
                                  </span>
                                )}
                              </div>
                              <span className="text-gray-500 text-xs">
                                {jobs.length} job{jobs.length !== 1 ? 's' : ''} scheduled
                              </span>
                            </div>

                            {/* Job rows */}
                            {jobs.length === 0 ? (
                              <div className={`px-4 py-6 text-center text-sm transition-all ${
                                listDropTarget?.type === 'machine' &&
                                listDropTarget?.machineId === machine.id
                                  ? 'text-skynet-accent'
                                  : anyDragActive
                                    ? 'text-gray-500 border-2 border-dashed border-gray-700 rounded-lg mx-4 my-3 py-5'
                                    : 'text-gray-600'
                              }`}>
                                {listDropTarget?.type === 'machine' &&
                                 listDropTarget?.machineId === machine.id
                                  ? 'Drop to schedule here'
                                  : 'No jobs scheduled'}
                              </div>
                            ) : (
                              <div>
                                {jobs.map((job, idx) => {
                                  const priority = job.work_order?.priority || 'normal'
                                  const isOverdue = job.work_order?.due_date
                                    && new Date(job.work_order.due_date) < new Date()
                                  const isBeingDragged = draggedScheduledJob?.id === job.id

                                  return (
                                    <div key={job.id}>
                                      <div
                                        draggable={canEdit}
                                        onDragStart={(e) => handleScheduledDragStart(e, job)}
                                        onDragEnd={(e) => {
                                          handleDragEnd(e)
                                          setListDropTarget(null)
                                        }}
                                        onClick={() => {
                                          if (!canEdit) return
                                          setScheduleClickJob(job)
                                          setScheduleClickEditMode(true)
                                        }}
                                        className={`flex items-center gap-3 px-4 py-3 hover:bg-gray-800/50 transition-colors border-b border-gray-800 last:border-b-0 ${
                                          isBeingDragged
                                            ? 'opacity-40 cursor-grabbing'
                                            : 'cursor-grab'
                                        }`}
                                      >
                                        {/* Sequence number */}
                                        <span className="text-gray-600 text-xs font-mono w-5 text-right flex-shrink-0">
                                          {idx + 1}
                                        </span>

                                        {/* Priority indicator */}
                                        <div className={`w-1.5 h-8 rounded-full flex-shrink-0 ${
                                          priority === 'critical'
                                            ? 'bg-red-500'
                                            : priority === 'high'
                                            ? 'bg-yellow-500'
                                            : 'bg-gray-700'
                                        }`} />

                                        {/* Part + job info */}
                                        <div className="flex-1 min-w-0">
                                          <div className="flex items-center gap-2">
                                            <span className="text-skynet-accent font-mono text-sm font-medium truncate">
                                              {job.component?.part_number}
                                            </span>
                                            <span className="text-gray-500 text-xs flex-shrink-0">
                                              {job.job_number}
                                            </span>
                                            {job.status === 'pending_compliance' && (
                                              <span className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full bg-amber-900/50 text-amber-400 border border-amber-700/50 flex-shrink-0">
                                                <Clock size={10} />
                                                Compliance Pending
                                              </span>
                                            )}
                                          </div>
                                          <div className="text-gray-500 text-xs truncate">
                                            {job.work_order?.wo_number}
                                            {job.work_order?.customer
                                              ? ` · ${job.work_order.customer}`
                                              : ''}
                                          </div>
                                        </div>

                                        {/* Qty */}
                                        <div className="text-right flex-shrink-0">
                                          <div className="text-white text-sm font-mono">
                                            {job.quantity}
                                          </div>
                                          <div className="text-gray-600 text-xs">pcs</div>
                                        </div>

                                        {/* Scheduled start */}
                                        <div className="text-right flex-shrink-0 min-w-[72px]">
                                          <div className={`text-sm font-mono ${
                                            isOverdue ? 'text-red-400' : 'text-gray-300'
                                          }`}>
                                            {new Date(job.scheduled_start).toLocaleDateString('en-US', {
                                              month: 'short', day: 'numeric'
                                            })}
                                          </div>
                                          <div className="text-gray-600 text-xs">
                                            {job.estimated_minutes
                                              ? job.estimated_minutes >= 60
                                                ? `${Math.round(job.estimated_minutes / 60)}h`
                                                : `${job.estimated_minutes}m`
                                              : '—'}
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Job Detail Popup */}
      {selectedJob && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
        >
          <div 
            className={`bg-gray-900 rounded-lg border p-6 max-w-md w-full mx-4 shadow-xl ${
              selectedJob.is_maintenance || selectedJob.work_order?.order_type === 'maintenance'
                ? selectedJob.work_order?.maintenance_type === 'unplanned'
                  ? 'border-purple-600'
                  : 'border-blue-600'
                : 'border-gray-700'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-white flex items-center gap-2">
                  {selectedJob.job_number}
                  {(selectedJob.is_maintenance || selectedJob.work_order?.order_type === 'maintenance') ? (
                    <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                      selectedJob.work_order?.maintenance_type === 'unplanned'
                        ? 'bg-purple-600 text-white'
                        : 'bg-blue-600 text-white'
                    }`}>
                      {selectedJob.work_order?.maintenance_type === 'unplanned' ? 'UNPLANNED' : 'MAINTENANCE'}
                    </span>
                  ) : (
                    <div className={`w-3 h-3 rounded-full ${getPriorityColor(selectedJob.priority)}`}></div>
                  )}
                </h3>
                <p className="text-gray-400">{selectedJob.work_order?.wo_number}</p>
              </div>
              <button
                onClick={() => setSelectedJob(null)}
                className="text-gray-500 hover:text-white transition-colors"
              >
                <X size={24} />
              </button>
            </div>

            <div className="space-y-3">
              {/* For maintenance jobs, show description instead of part info */}
              {(selectedJob.is_maintenance || selectedJob.work_order?.order_type === 'maintenance') ? (
                <div>
                  <span className="text-gray-500 text-sm">Description</span>
                  <p className={`font-medium ${
                    selectedJob.work_order?.maintenance_type === 'unplanned' ? 'text-purple-400' : 'text-blue-400'
                  }`}>
                    {selectedJob.maintenance_description || selectedJob.work_order?.notes || 'Maintenance'}
                  </p>
                </div>
              ) : (
                <div>
                  <span className="text-gray-500 text-sm">Part</span>
                  <p className="text-skynet-accent font-medium">{selectedJob.component?.part_number}</p>
                  <p className="text-gray-400 text-sm">{selectedJob.component?.description}</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-gray-500 text-sm">Machine</span>
                  <p className="text-white">{selectedJob.assigned_machine?.name}</p>
                </div>
                <div>
                  <span className="text-gray-500 text-sm">Quantity</span>
                  <p className="text-white">
                    {selectedJob.quantity}
                    {(mergeAllocs[selectedJob.id]?.length > 0) && (
                      <span className="text-cyan-300 text-sm ml-1.5">
                        +{mergeAllocs[selectedJob.id].reduce((s, a) => s + (a.requested_qty || 0), 0)} merged = {getRunTarget(selectedJob, mergeAllocs[selectedJob.id]).toLocaleString()}
                      </span>
                    )}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-gray-500 text-sm">Scheduled Start</span>
                  <p className="text-white">
                    {formatDate(selectedJob.scheduled_start)} {formatTime(selectedJob.scheduled_start)}
                  </p>
                </div>
                <div>
                  <span className="text-gray-500 text-sm">Scheduled End</span>
                  <p className="text-white">
                    {selectedJob.scheduled_end 
                      ? `${formatDate(selectedJob.scheduled_end)} ${formatTime(selectedJob.scheduled_end)}`
                      : '—'
                    }
                  </p>
                </div>
              </div>

              {selectedJob.estimated_minutes && (
                <div>
                  <span className="text-gray-500 text-sm">Estimated Duration</span>
                  <p className="text-white">
                    {selectedJob.estimated_minutes >= 1440
                      ? `${Math.floor(selectedJob.estimated_minutes / 1440)}d ${Math.floor((selectedJob.estimated_minutes % 1440) / 60)}h${selectedJob.estimated_minutes % 60 > 0 ? ` ${selectedJob.estimated_minutes % 60}m` : ''}`
                      : `${Math.floor(selectedJob.estimated_minutes / 60)}h ${selectedJob.estimated_minutes % 60}m`
                    }
                  </p>
                </div>
              )}

              {selectedJob.work_order?.customer && (
                <div>
                  <span className="text-gray-500 text-sm">Customer</span>
                  <p className="text-white">{selectedJob.work_order.customer}</p>
                </div>
              )}

              {selectedJob.work_order?.due_date && (
                <div>
                  <span className="text-gray-500 text-sm">Due Date</span>
                  <p className="text-white">{formatDate(selectedJob.work_order.due_date)}</p>
                </div>
              )}

              <div className="flex items-center gap-4 pt-2">
                {selectedJob.requires_attendance && (
                  <div className="flex items-center gap-2 text-orange-400">
                    <User size={16} />
                    <span className="text-sm">Requires Attendance</span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 text-sm">Status:</span>
                  <span className={`capitalize ${
                    selectedJob.status === 'in_progress' || selectedJob.status === 'in_setup' 
                      ? 'text-green-400' 
                      : selectedJob.status === 'complete' || selectedJob.status === 'manufacturing_complete'
                        ? 'text-gray-400'
                        : 'text-white'
                  }`}>
                    {selectedJob.status?.replace(/_/g, ' ')}
                  </span>
                </div>
              </div>

              <JobMergePanel
                job={selectedJob}
                members={mergeAllocs[selectedJob.id] || []}
                canEdit={canEdit}
                formatDateFn={formatDate}
                onMerged={async () => { setSelectedJob(null); await fetchData(); await loadAllScheduledJobs() }}
                onUnmerged={async () => { await fetchData(); await loadAllScheduledJobs() }}
              />

              {/* Action buttons - disabled for in-progress or completed jobs */}
              {(selectedJob.status === 'in_progress' || selectedJob.status === 'in_setup') ? (
                <div className="pt-4 border-t border-gray-700">
                  <p className="text-sm text-yellow-500 flex items-center gap-2 mb-3">
                    <AlertTriangle size={14} />
                    Running — machine and position are locked. You can still adjust the end date.
                  </p>
                  {canEdit && (
                    <button
                      onClick={() => handleOpenEndDateEdit(selectedJob)}
                      className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white font-medium rounded transition-colors"
                    >
                      <Calendar size={16} />
                      Adjust End Date
                    </button>
                  )}
                </div>
              ) : (selectedJob.status === 'complete' || selectedJob.status === 'manufacturing_complete') ? (
                <div className="pt-4 border-t border-gray-700">
                  <p className="text-sm text-gray-500 flex items-center gap-2">
                    <Info size={14} />
                    This job is complete and cannot be modified.
                  </p>
                </div>
              ) : (selectedJob.is_maintenance || selectedJob.work_order?.order_type === 'maintenance') ? (
                // Maintenance jobs - can edit times and cancel if not started
                <div className="pt-4 border-t border-gray-700">
                  {canEdit && (
                  <div className="flex items-center gap-3 mb-3">
                    <button
                      onClick={() => {
                        setScheduleClickJob(selectedJob)
                        setScheduleClickEditMode(true)
                        setSelectedJob(null)
                      }}
                      className={`flex items-center gap-2 px-4 py-2 font-medium rounded transition-colors ${
                        selectedJob.work_order?.maintenance_type === 'unplanned'
                          ? 'bg-purple-600 hover:bg-purple-500 text-white'
                          : 'bg-blue-600 hover:bg-blue-500 text-white'
                      }`}
                    >
                      <Edit3 size={16} />
                      Edit Schedule
                    </button>
                    {/* Cancel/Complete button - assigned (not yet started) or in progress */}
                    {(selectedJob.status === 'assigned' || selectedJob.status === 'in_progress') && (
                      <button
                        onClick={() => {
                          // Set defaults for end date/time to now
                          const now = new Date()
                          setMaintenanceEndDate(now.toISOString().split('T')[0])
                          setMaintenanceEndTime(now.toTimeString().slice(0, 5))
                          setMaintenanceCloseMode('complete')
                          setMaintenanceCancelReason('')
                          setSaveError(null)
                          setCancelMaintenanceConfirm(selectedJob)
                        }}
                        className="flex items-center gap-2 px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white font-medium rounded transition-colors"
                      >
                        <X size={16} />
                        Close
                      </button>
                    )}
                  </div>
                  )}
                  <p className="text-sm text-gray-500 flex items-center gap-2">
                    <Info size={14} />
                    {(selectedJob.status === 'assigned' || selectedJob.status === 'in_progress')
                      ? 'Click Close to complete or cancel this maintenance order.'
                      : 'This maintenance order cannot be closed from here.'}
                  </p>
                </div>
              ) : canEdit ? (
              <div className="flex items-center gap-3 pt-4 border-t border-gray-700 flex-wrap">
                <button
                  onClick={() => {
                    setScheduleClickJob(selectedJob)
                    setScheduleClickEditMode(true)
                    setSelectedJob(null)
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white font-medium rounded transition-colors"
                >
                  <Edit3 size={16} />
                  Edit
                </button>
                <button
                  onClick={() => handleOpenEndDateEdit(selectedJob)}
                  className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white font-medium rounded transition-colors"
                >
                  <Calendar size={16} />
                  Adjust End Date
                </button>
                <button
                  onClick={() => setUnscheduleConfirm(selectedJob)}
                  className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 text-white font-medium rounded transition-colors"
                >
                  <Undo2 size={16} />
                  Unschedule
                </button>
              </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* SKY55 — Adjust End Date modal (end-only; start, machine, position locked) */}
      {endDateEditJob && (() => {
        const job = endDateEditJob
        const start = job.scheduled_start ? new Date(job.scheduled_start) : null
        const newEnd = endDateEditValue ? new Date(endDateEditValue) : null
        const validEnd = !!newEnd && !isNaN(newEnd.getTime()) && (!start || newEnd > start)
        const queue = job.assigned_machine_id ? getMachineQueue(allScheduledJobs, job.assigned_machine_id) : []
        const cascade = validEnd ? computeEndChangeCascade(queue, job.id, newEnd) : { changes: [] }
        const newMinutes = (validEnd && start) ? Math.max(1, Math.round((newEnd - start) / 60000)) : null
        const fmt = (d) => d ? new Date(d).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
        // D-DATE-03: late-vs-customer-due warning (due_date is a DATE — end of day).
        const isLate = validEnd && !!job.work_order?.due_date && newEnd > new Date(job.work_order.due_date + 'T23:59:59')
        // D-SCHED-13: history-based parts/day suggestion for this job's machine
        const ppdSuggestion = computePartsPerDaySuggestion(endDateHistoryRuns, job.assigned_machine_id)
        // D-SCHED-16: run-target-aware math + one-click rate application
        const modalMembers = mergeAllocs[job.id] || []
        const modalRunTarget = getRunTarget(job, modalMembers)
        const scheduleStale = isScheduleStale(job, modalMembers)
        const applyPpdRate = (rate) => {
          setEndDatePartsPerDay(String(rate))
          const mins = partsPerDayToMinutes(modalRunTarget, rate)
          if (mins !== null && start) {
            setEndDateEditValue(toLocalDatetimeInput(new Date(start.getTime() + mins * 60000)))
          }
        }
        const dueShort = job.work_order?.due_date
          ? new Date(job.work_order.due_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          : '—'
        return (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-gray-900 rounded-lg border border-gray-700 p-6 max-w-md w-full mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-skynet-accent/20 flex items-center justify-center">
                  <Calendar size={20} className="text-skynet-accent" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">Adjust End Date</h3>
                  <p className="text-gray-400 text-sm">{job.component?.part_number || job.job_number} · {job.job_number}</p>
                </div>
              </div>

              <p className="text-gray-400 text-xs mb-4">
                Start, machine, and queue position stay fixed — only the end moves. Downstream jobs on this machine shift to match.
              </p>

              {scheduleStale && (
                <div className="mb-4 bg-amber-900/30 border border-amber-700 rounded p-3 text-amber-200 text-sm flex items-start gap-2">
                  <AlertTriangle size={16} className="text-amber-400 flex-shrink-0 mt-0.5" />
                  <div>
                    Run target changed since this schedule was saved: {(job.schedule_qty_basis || 0).toLocaleString()} → {modalRunTarget.toLocaleString()}.
                    {endDateLiveRate ? ' Recommended end pre-filled from the current run rate — review and save, or adjust.' : ' Set a new end below.'}
                  </div>
                </div>
              )}

              <div className="space-y-2 mb-4 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Start (locked)</span>
                  <span className="text-gray-300 font-mono">{fmt(start)}</span>
                </div>
                <div>
                  <label className="block text-gray-400 mb-1">Parts per day</label>
                  <div className="flex items-center gap-2 flex-wrap">
                    <input
                      type="number"
                      min="1"
                      value={endDatePartsPerDay}
                      onChange={(e) => {
                        const v = e.target.value
                        setEndDatePartsPerDay(v)
                        const mins = partsPerDayToMinutes(modalRunTarget, v)
                        if (mins !== null && start) {
                          setEndDateEditValue(toLocalDatetimeInput(new Date(start.getTime() + mins * 60000)))
                        }
                      }}
                      placeholder="—"
                      className="w-24 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-center focus:outline-none focus:border-skynet-accent"
                    />
                    <span className="text-gray-500 text-xs">parts / 24h day → sets end from locked start (qty {modalRunTarget.toLocaleString()}{modalMembers.length > 0 ? ` incl. ${modalMembers.length} merged` : ''}, +10% buffer)</span>
                  </div>
                  {endDateLiveRate && (
                    <p className="text-gray-400 text-xs mt-1 flex items-center gap-2">
                      <span>Current run: ≈ {endDateLiveRate.rate.toLocaleString()}/day ({endDateLiveRate.pieces.toLocaleString()} pcs accepted over {formatDurationDH(Math.round(endDateLiveRate.elapsedMs / 60000))})</span>
                      <button type="button" onClick={() => applyPpdRate(endDateLiveRate.rate)} className="px-1.5 py-0.5 text-[10px] bg-gray-700 hover:bg-gray-600 text-gray-200 rounded">Use</button>
                    </p>
                  )}
                  {ppdSuggestion && (
                    <p className="text-gray-500 text-xs mt-1 flex items-center gap-2">
                      <span>History: ≈ {ppdSuggestion.rate.toLocaleString()}/day from {ppdSuggestion.runCount} completed run{ppdSuggestion.runCount === 1 ? '' : 's'}{ppdSuggestion.machineSpecific ? ' on this machine' : ' (all machines)'}</span>
                      <button type="button" onClick={() => applyPpdRate(ppdSuggestion.rate)} className="px-1.5 py-0.5 text-[10px] bg-gray-700 hover:bg-gray-600 text-gray-200 rounded">Use</button>
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-gray-400 mb-1">New end</label>
                  <input
                    type="datetime-local"
                    value={endDateEditValue}
                    onChange={(e) => setEndDateEditValue(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
                    style={{ colorScheme: 'dark' }}
                  />
                </div>
                {newMinutes && (
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">New duration</span>
                    <span className="text-gray-300 font-mono">{formatDurationDH(newMinutes)}</span>
                  </div>
                )}
              </div>

              {isLate && (
                <div className="mb-4 bg-amber-900/30 border border-amber-700 rounded p-3 text-amber-200 text-sm flex items-start gap-2">
                  <AlertTriangle size={16} className="text-amber-400 flex-shrink-0 mt-0.5" />
                  <div>
                    Scheduled finish {fmt(newEnd)} is after the customer due date {dueShort}.
                  </div>
                </div>
              )}

              {cascade.changes.length > 0 && (
                <div className="mb-4">
                  <p className="text-gray-400 text-xs mb-2 flex items-center gap-2">
                    <AlertTriangle size={14} className="text-amber-400" />
                    {cascade.changes.length} downstream job{cascade.changes.length === 1 ? '' : 's'} will shift
                  </p>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {cascade.changes.map(c => (
                      <div key={c.job.id} className="bg-gray-800/40 border border-gray-700 rounded p-2 text-xs flex items-center justify-between gap-2">
                        <span className="text-skynet-accent font-mono">{c.job.component?.part_number || c.job.job_number}</span>
                        <span className="text-gray-500">{fmt(c.job.scheduled_start)} → {fmt(c.newStart)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {endDateError && (
                <p className="text-red-400 text-sm mb-3 flex items-center gap-2">
                  <AlertTriangle size={14} /> {endDateError}
                </p>
              )}

              <div className="flex items-center justify-end gap-3">
                <button onClick={() => setEndDateEditJob(null)} className="px-4 py-2 text-gray-400 hover:text-white transition-colors">Cancel</button>
                <button
                  onClick={handleSaveEndDate}
                  disabled={!validEnd || endDateSaving}
                  className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white font-medium rounded transition-colors disabled:opacity-50"
                >
                  {endDateSaving ? (<><Loader2 size={16} className="animate-spin" /> Saving...</>) : (<><Calendar size={16} /> Save End Date</>)}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Unschedule Confirmation Modal */}
      {unscheduleConfirm && (() => {
        const queue = unscheduleConfirm.assigned_machine_id
          ? getMachineQueue(allScheduledJobs, unscheduleConfirm.assigned_machine_id)
          : []
        const cascade = computeRemovalCascade(queue, unscheduleConfirm.id)
        const downstreamCount = cascade.changes.length
        return (
          <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          >
            <div
              className="bg-gray-900 rounded-lg border border-gray-700 p-6 max-w-sm w-full mx-4 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-red-600/20 flex items-center justify-center">
                  <Trash2 size={20} className="text-red-500" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">Unschedule Job?</h3>
                  <p className="text-gray-400 text-sm">{unscheduleConfirm.job_number}</p>
                </div>
              </div>

              <p className="text-gray-300 mb-4">
                This will remove the job from the schedule and return it to the unassigned pool. You can reschedule it later.
              </p>

              {downstreamCount > 0 && (
                <label className="flex items-start gap-2 mb-6 cursor-pointer p-2 -mx-2 rounded hover:bg-gray-800/50">
                  <input
                    type="checkbox"
                    checked={closeGap}
                    onChange={(e) => setCloseGap(e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded border-gray-700 bg-gray-800 text-skynet-accent focus:ring-skynet-accent focus:ring-offset-0 cursor-pointer"
                  />
                  <span className="text-sm text-gray-300">
                    Close the gap — {downstreamCount} downstream job{downstreamCount === 1 ? '' : 's'} will move forward to fill the empty slot.
                  </span>
                </label>
              )}
              {downstreamCount === 0 && <div className="mb-2" />}

              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={() => { setUnscheduleConfirm(null); setCloseGap(true) }}
                  className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleUnschedule}
                  disabled={unscheduling}
                  className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 text-white font-medium rounded transition-colors disabled:opacity-50"
                >
                  {unscheduling ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      Removing...
                    </>
                  ) : (
                    <>
                      <Undo2 size={16} />
                      Yes, Unschedule
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Close Maintenance Modal */}
      {cancelMaintenanceConfirm && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
        >
          <div 
            className={`bg-gray-900 rounded-lg border p-6 max-w-md w-full mx-4 shadow-xl ${
              cancelMaintenanceConfirm.work_order?.maintenance_type === 'unplanned'
                ? 'border-purple-600'
                : 'border-blue-600'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                  cancelMaintenanceConfirm.work_order?.maintenance_type === 'unplanned'
                    ? 'bg-purple-600/20'
                    : 'bg-blue-600/20'
                }`}>
                  <Wrench size={20} className={
                    cancelMaintenanceConfirm.work_order?.maintenance_type === 'unplanned'
                      ? 'text-purple-500'
                      : 'text-blue-500'
                  } />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">Close Maintenance Order</h3>
                  <p className="text-gray-400 text-sm">{cancelMaintenanceConfirm.job_number}</p>
                </div>
              </div>
              <button
                onClick={() => {
                  setCancelMaintenanceConfirm(null)
                  setSaveError(null)
                }}
                className="text-gray-500 hover:text-white transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Mode Selection */}
            <div className="grid grid-cols-2 gap-2 mb-4">
              <button
                type="button"
                onClick={() => setMaintenanceCloseMode('complete')}
                className={`px-4 py-3 rounded font-medium transition-colors flex items-center justify-center gap-2 ${
                  maintenanceCloseMode === 'complete'
                    ? 'bg-green-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                <Clock size={18} />
                Complete Early
              </button>
              <button
                type="button"
                onClick={() => setMaintenanceCloseMode('cancel')}
                className={`px-4 py-3 rounded font-medium transition-colors flex items-center justify-center gap-2 ${
                  maintenanceCloseMode === 'cancel'
                    ? 'bg-red-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                <Trash2 size={18} />
                Cancel
              </button>
            </div>

            {/* Mode-specific content */}
            {maintenanceCloseMode === 'complete' ? (
              <div className="space-y-4">
                <p className="text-gray-300 text-sm">
                  Mark maintenance as complete at the specified time. The block will shrink to show actual duration.
                </p>
                
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-gray-400 text-sm mb-1">End Date</label>
                    <input
                      type="date"
                      value={maintenanceEndDate}
                      onChange={(e) => setMaintenanceEndDate(e.target.value)}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:border-green-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-gray-400 text-sm mb-1">End Time</label>
                    <input
                      type="time"
                      value={maintenanceEndTime}
                      onChange={(e) => setMaintenanceEndTime(e.target.value)}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:border-green-500 focus:outline-none"
                      style={{ colorScheme: 'dark' }}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-gray-300 text-sm">
                  Cancel this maintenance order entirely. It will be removed from the schedule.
                </p>
                
                <div>
                  <label className="block text-gray-400 text-sm mb-1">Cancellation Reason *</label>
                  <textarea
                    value={maintenanceCancelReason}
                    onChange={(e) => setMaintenanceCancelReason(e.target.value)}
                    placeholder="Why is this maintenance being cancelled?"
                    rows={2}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:border-red-500 focus:outline-none resize-none"
                  />
                </div>
              </div>
            )}
            
            {/* Unplanned maintenance note */}
            {cancelMaintenanceConfirm.work_order?.maintenance_type === 'unplanned' && (
              <p className="text-purple-300 text-sm mt-4 flex items-center gap-2">
                <Info size={14} />
                The machine will be marked as available again.
              </p>
            )}

            {/* Error message */}
            {saveError && (
              <div className="mt-4 p-3 bg-red-900/50 border border-red-700 rounded text-red-300 text-sm">
                {saveError}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 mt-6">
              <button
                onClick={() => {
                  setCancelMaintenanceConfirm(null)
                  setSaveError(null)
                }}
                className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
              >
                Keep Open
              </button>
              <button
                onClick={handleCancelMaintenance}
                disabled={saving}
                className={`flex items-center gap-2 px-4 py-2 font-medium rounded transition-colors disabled:opacity-50 ${
                  maintenanceCloseMode === 'complete'
                    ? 'bg-green-600 hover:bg-green-500 text-white'
                    : 'bg-red-600 hover:bg-red-500 text-white'
                }`}
              >
                {saving ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    {maintenanceCloseMode === 'complete' ? 'Completing...' : 'Cancelling...'}
                  </>
                ) : maintenanceCloseMode === 'complete' ? (
                  <>
                    <Clock size={16} />
                    Complete Now
                  </>
                ) : (
                  <>
                    <Trash2 size={16} />
                    Cancel Order
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Maintenance Modal */}
      {showMaintenanceModal && (
        <CreateMaintenanceModal
          isOpen={showMaintenanceModal}
          onClose={() => setShowMaintenanceModal(false)}
          onSuccess={() => {
            setShowMaintenanceModal(false)
            fetchData() // Refresh the schedule
          }}
          machines={machines}
        />
      )}

      {/* D-AISCHED-04: Uncle Bob advisor drawer */}
      {FEATURES.AI_SCHEDULER && (
        <AIAdvisorPanel
          open={advisorOpen}
          onClose={() => setAdvisorOpen(false)}
          profile={profile}
          machines={machines}
          scheduledJobs={allScheduledJobs.length ? allScheduledJobs : scheduledJobs}
          unassignedJobs={unassignedJobs}
          ongoingDowntimes={ongoingDowntimes}
          getMachineOptionsForPart={getMachineOptionsForPart}
          getScaledDuration={getScaledDuration}
          projectedSpans={projectedSpans}
          onApplyProposal={handleAdvisorApply}
          refreshKey={advisorRefreshKey}
        />
      )}

      {/* Click-to-Schedule / Reschedule / Drag-Drop Modal (unified) */}
      {scheduleClickJob && canEdit && (
        <ScheduleJobModal
          isOpen={!!scheduleClickJob}
          members={mergeAllocs[scheduleClickJob?.id] || []}
          onClose={() => {
            setScheduleClickJob(null)
            setScheduleClickEditMode(false)
            setScheduleClickDefaults(null)
            setAdvisorApplying(null)
          }}
          onSuccess={async () => {
            const applying = advisorApplying
            setScheduleClickJob(null)
            setScheduleClickEditMode(false)
            setScheduleClickDefaults(null)
            setAdvisorApplying(null)
            if (applying) {
              // Mark the proposal applied; detect whether the human edited
              // machine or start (>1 min shift) in the confirm step.
              try {
                const { data: fresh } = await supabase
                  .from('jobs')
                  .select('assigned_machine_id, scheduled_start')
                  .eq('id', applying.job_id)
                  .single()
                const edited = !!fresh && (
                  fresh.assigned_machine_id !== applying.machine_id ||
                  Math.abs(new Date(fresh.scheduled_start) - new Date(applying.proposed_start)) > 60000
                )
                await supabase
                  .from('schedule_ai_proposals')
                  .update({
                    status: 'applied',
                    applied_by: profile?.id ?? null,
                    applied_at: new Date().toISOString(),
                    applied_with_edits: edited,
                  })
                  .eq('id', applying.id)
              } catch (e) {
                console.error('Failed to mark proposal applied:', e)
              }
              setAdvisorRefreshKey(k => k + 1)
            }
            fetchData()
            loadAllScheduledJobs()
          }}
          job={scheduleClickJob}
          machines={machines}
          partMachineDurations={partMachineDurations}
          scheduledJobs={allScheduledJobs}
          profile={profile}
          editMode={scheduleClickEditMode}
          defaults={scheduleClickDefaults}
          onReturnToQueue={
            scheduleClickEditMode
              ? () => handleReturnToQueue(scheduleClickJob)
              : null
          }
        />
      )}
    </div>
  )
}

// ─────────── D-JOBMERGE-02: merge/unmerge panel for the selected-job popup ───────────
// Host view: lists the combined run's members with unmerge controls.
// Member-eligible view: lists same-component host candidates to merge into.

function JobMergePanel({ job, members, canEdit, formatDateFn, onMerged, onUnmerged }) {
  const [candidates, setCandidates] = useState([])
  const [busy, setBusy] = useState(false)
  const isHost = members.length > 0
  const runTarget = getRunTarget(job, members)

  useEffect(() => {
    let cancelled = false
    if (!isHost && canEdit && isMemberEligible(job)) {
      fetchMergeHostCandidates(job.component_id, job.id).then(rows => {
        if (!cancelled) setCandidates(rows)
      })
    } else {
      setCandidates([])
    }
    return () => { cancelled = true }
  }, [job.id, job.status, isHost, canEdit])

  const unmergeOpen = ['pending_compliance', 'ready', 'assigned', 'in_setup', 'in_progress'].includes(job.status)

  const handleMerge = async (c) => {
    const ok = window.confirm(
      `Merge ${job.job_number} (${job.quantity} pcs) into ${c.job_number}` +
      `${c.machine_name ? ` on ${c.machine_name}` : ''}? ` +
      `New run target: ${(Number(c.run_target) + (job.quantity || 0)).toLocaleString()}. ` +
      `${job.work_order?.wo_number || 'Its work order'} receives its share back after compliance.`
    )
    if (!ok) return
    setBusy(true)
    try {
      await mergeJobIntoHost(job.id, c.job_id)
      await onMerged()
    } catch (e) {
      alert('Merge failed: ' + e.message)
    } finally {
      setBusy(false)
    }
  }

  const handleUnmerge = async (m) => {
    const ok = window.confirm(
      `Unmerge ${m.job_number} (${m.requested_qty} pcs, ${m.wo_number || 'no WO'}) from ${job.job_number}? ` +
      `It returns to the unscheduled queue.`
    )
    if (!ok) return
    setBusy(true)
    try {
      await unmergeJob(m.member_job_id)
      await onUnmerged()
    } catch (e) {
      alert('Unmerge failed: ' + e.message)
    } finally {
      setBusy(false)
    }
  }

  if (isHost) {
    return (
      <div className="pt-4 border-t border-gray-700">
        <div className="flex items-center gap-2 mb-2">
          <Layers size={16} className="text-cyan-300" />
          <span className="text-white font-medium">Combined run · target {runTarget.toLocaleString()}</span>
        </div>
        <div className="space-y-2">
          {members.map(m => (
            <div key={m.member_job_id} className="flex items-center justify-between bg-gray-800/60 border border-gray-700 rounded p-2">
              <div className="min-w-0 text-sm">
                <span className="text-skynet-accent font-mono">{m.job_number}</span>
                <span className="text-gray-500"> · </span>
                <span className="text-gray-300">{[m.wo_number, m.customer].filter(Boolean).join(' · ')}</span>
                <span className="text-gray-500"> · </span>
                <span className="text-white">{Number(m.requested_qty).toLocaleString()} pcs</span>
                {m.due_date && <span className="text-gray-500 text-xs"> · Due {formatDateFn(m.due_date)}</span>}
              </div>
              {canEdit && unmergeOpen && (
                <button
                  onClick={() => handleUnmerge(m)}
                  disabled={busy}
                  className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors flex-shrink-0 ml-2"
                >
                  Unmerge
                </button>
              )}
            </div>
          ))}
        </div>
        <p className="text-gray-500 text-xs mt-2">
          Members allocate back by earliest due date once the run clears compliance.
        </p>
      </div>
    )
  }

  if (!canEdit || candidates.length === 0) return null

  return (
    <div className="pt-4 border-t border-gray-700">
      <div className="flex items-center gap-2 mb-2">
        <Layers size={16} className="text-cyan-300" />
        <span className="text-white font-medium">Merge into another run</span>
      </div>
      <div className="space-y-2">
        {candidates.map(c => (
          <div key={c.job_id} className="flex items-center justify-between bg-cyan-950/40 border border-cyan-700/60 rounded p-2">
            <div className="min-w-0 text-sm">
              <span className="text-skynet-accent font-mono">{c.job_number}</span>
              {c.status === 'in_progress'
                ? <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold bg-green-500/20 text-green-400 rounded">RUNNING</span>
                : <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold bg-gray-600/40 text-gray-300 rounded">QUEUED</span>}
              <span className="text-gray-500"> · </span>
              <span className="text-gray-300">{c.machine_name || 'Not scheduled yet'}</span>
              <span className="text-gray-500"> · </span>
              <span className="text-gray-400 text-xs">{[c.wo_number, c.customer].filter(Boolean).join(' · ')}</span>
              <span className="text-gray-500 text-xs"> · RT {Number(c.run_target).toLocaleString()}</span>
            </div>
            <button
              onClick={() => handleMerge(c)}
              disabled={busy}
              className="px-2 py-1 text-xs bg-cyan-600 hover:bg-cyan-500 text-white rounded transition-colors flex-shrink-0 ml-2"
            >
              Merge
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}