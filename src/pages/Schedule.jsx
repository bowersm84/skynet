import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { 
  ArrowLeft, 
  ChevronLeft, 
  ChevronRight, 
  Filter, 
  Search,
  Calendar,
  Clock,
  AlertCircle,
  AlertTriangle,
  GripVertical,
  User,
  X,
  Save,
  Loader2,
  Database,
  Star,
  Info,
  ZoomIn,
  ZoomOut,
  Undo2,
  Trash2,
  Edit3
} from 'lucide-react'

export default function Schedule({ user, profile, onNavigate }) {
  const [unassignedJobs, setUnassignedJobs] = useState([])
  const [incompleteJobs, setIncompleteJobs] = useState([]) // Jobs sent back from kiosk
  const [scheduledJobs, setScheduledJobs] = useState([])
  const [machines, setMachines] = useState([])
  const [partMachineDurations, setPartMachineDurations] = useState([])
  const [loading, setLoading] = useState(true)
  const [weekOffset, setWeekOffset] = useState(0)
  
  // Zoom state
  const [zoomedDay, setZoomedDay] = useState(null) // Date object when zoomed into a day
  
  // Filter state
  const [filterBy, setFilterBy] = useState('wo_number')
  const [searchQuery, setSearchQuery] = useState('')
  const [showFilterMenu, setShowFilterMenu] = useState(false)
  
  // Selected job for detail popup
  const [selectedJob, setSelectedJob] = useState(null)
  
  // Drag and drop state
  const [draggedJob, setDraggedJob] = useState(null)
  const [draggedScheduledJob, setDraggedScheduledJob] = useState(null) // For rescheduling
  const [dropTarget, setDropTarget] = useState(null)
  
  // Schedule modal state
  const [scheduleModal, setScheduleModal] = useState(null)
  const [scheduleForm, setScheduleForm] = useState({
    startTime: '07:00',
    durationHours: 1,
    durationMinutes: 0,
    requiresAttendance: false,
    saveDuration: false
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [durationSource, setDurationSource] = useState(null)
  const [noTimeAvailable, setNoTimeAvailable] = useState(false) // Warning when shift is full
  
  // Unschedule confirmation
  const [unscheduleConfirm, setUnscheduleConfirm] = useState(null)
  const [unscheduling, setUnscheduling] = useState(false)
  
  // Resize state for drag-to-resize in day view
  const [resizing, setResizing] = useState(null) // { jobId, edge: 'start' | 'end', initialX, initialStart, initialEnd }
  const [resizePreview, setResizePreview] = useState(null) // { jobId, newStart, newEnd }
  const resizingRef = useRef(null)
  const resizePreviewRef = useRef(null)
  
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
    startOfWeek.setDate(today.getDate() + (weekOffset * 7))
    startOfWeek.setHours(0, 0, 0, 0)
    
    const dates = []
    for (let i = 0; i < 7; i++) {
      const date = new Date(startOfWeek)
      date.setDate(startOfWeek.getDate() + i)
      dates.push(date)
    }
    return dates
  }

  const weekDates = getWeekDates()
  
  const weekStart = weekDates[0]
  const weekEnd = new Date(weekDates[6])
  weekEnd.setHours(23, 59, 59, 999)

  // Hours for zoomed day view
  const dayHours = Array.from({ length: 24 }, (_, i) => i)

  useEffect(() => {
    fetchData()
    
    const jobsSubscription = supabase
      .channel('schedule-jobs-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, 
        () => fetchData()
      )
      .subscribe()

    return () => {
      supabase.removeChannel(jobsSubscription)
    }
  }, [weekOffset])

  const fetchData = async () => {
    setLoading(true)
    try {
      // Fetch unassigned ready jobs
      const { data: unassignedData, error: unassignedError } = await supabase
        .from('jobs')
        .select(`
          *,
          work_order:work_orders(id, wo_number, customer, priority, due_date, order_type),
          component:parts!component_id(id, part_number, description)
        `)
        .eq('status', 'ready')
        .is('assigned_machine_id', null)
        .order('created_at', { ascending: true })

      if (unassignedError) {
        console.error('Error fetching unassigned jobs:', unassignedError)
      } else {
        setUnassignedJobs(unassignedData || [])
      }

      // Fetch incomplete jobs (sent back from kiosk)
      const { data: incompleteData, error: incompleteError } = await supabase
        .from('jobs')
        .select(`
          *,
          work_order:work_orders(id, wo_number, customer, priority, due_date, order_type),
          component:parts!component_id(id, part_number, description)
        `)
        .eq('status', 'incomplete')
        .order('incomplete_at', { ascending: false })

      if (incompleteError) {
        console.error('Error fetching incomplete jobs:', incompleteError)
      } else {
        setIncompleteJobs(incompleteData || [])
      }

      const { data: scheduledData, error: scheduledError } = await supabase
        .from('jobs')
        .select(`
          *,
          work_order:work_orders(id, wo_number, customer, priority, due_date, order_type),
          component:parts!component_id(id, part_number, description),
          assigned_machine:machines(id, name, code)
        `)
        .not('assigned_machine_id', 'is', null)
        .not('scheduled_start', 'is', null)
        .gte('scheduled_start', weekStart.toISOString())
        .lte('scheduled_start', weekEnd.toISOString())
        .not('status', 'eq', 'cancelled')
        .order('scheduled_start', { ascending: true })

      if (scheduledError) {
        console.error('Error fetching scheduled jobs:', scheduledError)
      } else {
        setScheduledJobs(scheduledData || [])
      }

      const { data: machinesData, error: machinesError } = await supabase
        .from('machines')
        .select(`
          *,
          location:locations(id, name, code)
        `)
        .eq('is_active', true)
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

    } catch (error) {
      console.error('Unexpected error:', error)
    } finally {
      setLoading(false)
    }
  }

  const getDurationForPartMachine = (partId, machineId) => {
    return partMachineDurations.find(
      d => d.part_id === partId && d.machine_id === machineId
    )
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

  // Week view: position as percentage of day
  const getJobBlockStyle = (job, dayDate) => {
    if (!job.scheduled_start) return null
    
    const jobStart = new Date(job.scheduled_start)
    const jobEnd = job.scheduled_end ? new Date(job.scheduled_end) : null
    
    const dayStart = new Date(dayDate)
    dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(dayDate)
    dayEnd.setHours(23, 59, 59, 999)
    
    if (jobStart > dayEnd) return null
    if (jobEnd && jobEnd < dayStart) return null
    
    const visibleStart = jobStart < dayStart ? dayStart : jobStart
    const visibleEnd = jobEnd 
      ? (jobEnd > dayEnd ? dayEnd : jobEnd)
      : new Date(visibleStart.getTime() + (job.estimated_minutes || 60) * 60000)
    
    const effectiveEnd = visibleEnd > dayEnd ? dayEnd : visibleEnd
    
    const startHour = visibleStart.getHours() + visibleStart.getMinutes() / 60
    const endHour = effectiveEnd.getHours() + effectiveEnd.getMinutes() / 60 || 24
    
    const leftPercent = (startHour / 24) * 100
    const widthPercent = ((endHour - startHour) / 24) * 100
    
    const minWidth = 3
    
    return {
      left: `${leftPercent}%`,
      width: `${Math.max(widthPercent, minWidth)}%`,
      continuesFromPrevious: jobStart < dayStart,
      continuesToNext: jobEnd && jobEnd > dayEnd
    }
  }

  // Zoomed day view: position based on hour columns
  const getJobBlockStyleZoomed = (job, dayDate) => {
    if (!job.scheduled_start) return null
    
    const jobStart = new Date(job.scheduled_start)
    const jobEnd = job.scheduled_end 
      ? new Date(job.scheduled_end) 
      : new Date(jobStart.getTime() + (job.estimated_minutes || 60) * 60000)
    
    const dayStart = new Date(dayDate)
    dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(dayDate)
    dayEnd.setHours(23, 59, 59, 999)
    
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

  // Calculate next available time slot for a machine on a given date
  const getNextAvailableTime = (machineId, date, durationMinutes = 60, excludeJobId = null) => {
    const SHIFT_START = 7 // 7:00 AM
    const SHIFT_END = 16  // 4:00 PM
    
    const targetDate = new Date(date)
    targetDate.setHours(0, 0, 0, 0)
    
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const isToday = targetDate.getTime() === today.getTime()
    
    // Get all jobs for this machine on this date
    const machineJobs = (scheduledJobsByMachine[machineId] || [])
      .filter(job => {
        if (excludeJobId && job.id === excludeJobId) return false
        const jobDate = new Date(job.scheduled_start)
        jobDate.setHours(0, 0, 0, 0)
        return jobDate.getTime() === targetDate.getTime()
      })
      .map(job => ({
        start: new Date(job.scheduled_start),
        end: job.scheduled_end 
          ? new Date(job.scheduled_end)
          : new Date(new Date(job.scheduled_start).getTime() + (job.estimated_minutes || 60) * 60000)
      }))
      .sort((a, b) => a.start - b.start)
    
    // Determine earliest possible start time
    let earliestStart = new Date(targetDate)
    earliestStart.setHours(SHIFT_START, 0, 0, 0)
    
    // For today, check if we're past shift end using ACTUAL time (before rounding)
    if (isToday) {
      const now = new Date()
      const actualHour = now.getHours()
      const actualMinutes = now.getMinutes()
      
      // If actual current time is past shift end, no time available
      if (actualHour >= SHIFT_END) {
        return { hours: SHIFT_START, minutes: 0, noTimeAvailable: true }
      }
      
      // Round up to next 15-minute interval for the suggested start time
      const roundedMinutes = Math.ceil(actualMinutes / 15) * 15
      now.setMinutes(roundedMinutes, 0, 0)
      
      // Cap at shift end - 15 min to allow at least a small job
      const shiftEndTime = new Date(targetDate)
      shiftEndTime.setHours(SHIFT_END - 1, 45, 0, 0) // 3:45 PM max
      
      if (now > shiftEndTime) {
        earliestStart = shiftEndTime
      } else if (now > earliestStart) {
        earliestStart = now
      }
    }
    
    // If no jobs scheduled, return earliest available time
    if (machineJobs.length === 0) {
      return {
        hours: earliestStart.getHours(),
        minutes: earliestStart.getMinutes(),
        noTimeAvailable: false
      }
    }
    
    // Find first available slot within shift hours
    let candidateStart = earliestStart
    
    for (const job of machineJobs) {
      // Skip jobs that end before our candidate start
      if (job.end <= candidateStart) continue
      
      const candidateEnd = new Date(candidateStart.getTime() + durationMinutes * 60000)
      
      // If candidate fits before this job and within shift hours, use it
      if (candidateEnd <= job.start && candidateStart.getHours() < SHIFT_END) {
        return {
          hours: candidateStart.getHours(),
          minutes: candidateStart.getMinutes(),
          noTimeAvailable: false
        }
      }
      
      // Move candidate to after this job ends
      if (job.end > candidateStart) {
        candidateStart = new Date(job.end)
        // Round up to next 15-minute interval
        const mins = candidateStart.getMinutes()
        if (mins % 15 !== 0) {
          candidateStart.setMinutes(Math.ceil(mins / 15) * 15, 0, 0)
        }
      }
    }
    
    // Check if candidate is still within shift hours
    if (candidateStart.getHours() >= SHIFT_END) {
      // No room left on this day
      return { hours: SHIFT_START, minutes: 0, noTimeAvailable: true }
    }
    
    return {
      hours: candidateStart.getHours(),
      minutes: candidateStart.getMinutes(),
      noTimeAvailable: false
    }
  }

  const getFilteredJobs = () => {
    // Combine ready and incomplete jobs
    let filtered = [...unassignedJobs, ...incompleteJobs]

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

    // Always put incomplete jobs first (they need attention)
    filtered.sort((a, b) => {
      if (a.status === 'incomplete' && b.status !== 'incomplete') return -1
      if (a.status !== 'incomplete' && b.status === 'incomplete') return 1
      return 0
    })

    return filtered
  }

  // Drag handlers for unassigned jobs
  const handleDragStart = (e, job) => {
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
    e.preventDefault()
    setDropTarget(null)
    
    const job = draggedJob || draggedScheduledJob
    if (!job) return
    
    const machine = machines.find(m => m.id === machineId)
    const partId = job.component_id
    const durationRecord = getDurationForPartMachine(partId, machineId)
    const isReschedule = !!draggedScheduledJob
    
    // Calculate duration for next available time check
    let durationMinutes = 60 // default
    if (durationRecord) {
      durationMinutes = durationRecord.estimated_minutes
    } else if (job.estimated_minutes) {
      durationMinutes = job.estimated_minutes
    }
    
    // Get next available time for this machine/date (or use clicked hour in day view)
    let defaultStartTime = '07:00'
    let timeUnavailable = false
    
    if (hour !== null) {
      // User clicked a specific hour in day view - use that
      defaultStartTime = `${hour.toString().padStart(2, '0')}:00`
      // Still check if there's time available during shift
      const nextTime = getNextAvailableTime(machineId, date, durationMinutes, isReschedule ? job.id : null)
      timeUnavailable = nextTime.noTimeAvailable
    } else {
      // Week view - calculate next available time
      const nextTime = getNextAvailableTime(machineId, date, durationMinutes, isReschedule ? job.id : null)
      defaultStartTime = `${String(nextTime.hours).padStart(2, '0')}:${String(nextTime.minutes).padStart(2, '0')}`
      timeUnavailable = nextTime.noTimeAvailable
    }
    
    setNoTimeAvailable(timeUnavailable)
    
    setScheduleModal({
      job: isReschedule ? { ...job, isReschedule: true } : job,
      machineId,
      machineName: machine?.name || 'Unknown',
      machineCode: machine?.code || '',
      date,
      durationRecord,
      isReschedule
    })
    
    // Set form values
    if (durationRecord && !isReschedule) {
      const hours = Math.floor(durationRecord.estimated_minutes / 60)
      const minutes = durationRecord.estimated_minutes % 60
      setScheduleForm({
        startTime: defaultStartTime,
        durationHours: hours,
        durationMinutes: minutes,
        requiresAttendance: job.requires_attendance || false,
        saveDuration: false
      })
      setDurationSource('database')
    } else if (job.estimated_minutes) {
      const hours = Math.floor(job.estimated_minutes / 60)
      const minutes = job.estimated_minutes % 60
      setScheduleForm({
        startTime: isReschedule && job.scheduled_start 
          ? new Date(job.scheduled_start).toTimeString().slice(0, 5)
          : defaultStartTime,
        durationHours: hours,
        durationMinutes: minutes,
        requiresAttendance: job.requires_attendance || false,
        saveDuration: !isReschedule
      })
      setDurationSource(isReschedule ? 'job' : 'job')
    } else {
      setScheduleForm({
        startTime: defaultStartTime,
        durationHours: 1,
        durationMinutes: 0,
        requiresAttendance: job.requires_attendance || false,
        saveDuration: !isReschedule
      })
      setDurationSource(null)
    }
    
    setDraggedJob(null)
    setDraggedScheduledJob(null)
  }

  const handleSaveSchedule = async () => {
    if (!scheduleModal) return
    
    setSaving(true)
    setSaveError(null)
    
    try {
      const { job, machineId, date, durationRecord, isReschedule } = scheduleModal
      
      const [hours, minutes] = scheduleForm.startTime.split(':').map(Number)
      const scheduledStart = new Date(date)
      scheduledStart.setHours(hours, minutes, 0, 0)
      
      const durationMinutes = (scheduleForm.durationHours * 60) + scheduleForm.durationMinutes
      const scheduledEnd = new Date(scheduledStart.getTime() + durationMinutes * 60000)
      
      // Check conflicts, excluding current job if rescheduling
      if (hasConflict(machineId, scheduledStart, scheduledEnd, isReschedule ? job.id : null)) {
        setSaveError('This time slot conflicts with an existing scheduled job.')
        setSaving(false)
        return
      }
      
      // Save duration if requested (not for reschedule)
      if (scheduleForm.saveDuration && job.component_id && !isReschedule) {
        if (durationRecord) {
          await supabase
            .from('part_machine_durations')
            .update({
              estimated_minutes: durationMinutes,
              updated_at: new Date().toISOString()
            })
            .eq('id', durationRecord.id)
        } else {
          await supabase
            .from('part_machine_durations')
            .insert({
              part_id: job.component_id,
              machine_id: machineId,
              estimated_minutes: durationMinutes,
              is_preferred: false,
              preference_order: 0,
              created_by: profile?.id
            })
        }
      }
      
      // Update the job
      const { error } = await supabase
        .from('jobs')
        .update({
          assigned_machine_id: machineId,
          scheduled_start: scheduledStart.toISOString(),
          scheduled_end: scheduledEnd.toISOString(),
          estimated_minutes: durationMinutes,
          requires_attendance: scheduleForm.requiresAttendance,
          status: 'assigned',
          scheduled_by: profile?.id,
          scheduled_at: new Date().toISOString()
        })
        .eq('id', job.id)
      
      if (error) {
        console.error('Error scheduling job:', error)
        setSaveError('Failed to schedule job. Please try again.')
      } else {
        setScheduleModal(null)
        setNoTimeAvailable(false)
        setScheduleForm({
          startTime: '07:00',
          durationHours: 1,
          durationMinutes: 0,
          requiresAttendance: false,
          saveDuration: false
        })
        setDurationSource(null)
        fetchData()
      }
    } catch (error) {
      console.error('Unexpected error scheduling job:', error)
      setSaveError('An unexpected error occurred.')
    } finally {
      setSaving(false)
    }
  }

  // Unschedule a job - return it to the pool
  const handleUnschedule = async () => {
    if (!unscheduleConfirm) return
    
    setUnscheduling(true)
    
    try {
      const { error } = await supabase
        .from('jobs')
        .update({
          assigned_machine_id: null,
          scheduled_start: null,
          scheduled_end: null,
          status: 'ready',
          scheduled_by: null,
          scheduled_at: null
        })
        .eq('id', unscheduleConfirm.id)
      
      if (error) {
        console.error('Error unscheduling job:', error)
      } else {
        setUnscheduleConfirm(null)
        setSelectedJob(null)
        fetchData()
      }
    } catch (error) {
      console.error('Unexpected error:', error)
    } finally {
      setUnscheduling(false)
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
    const end = weekDates[6]
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
    return machineJobs.filter(job => {
      const style = zoomedDay 
        ? getJobBlockStyleZoomed(job, dayDate)
        : getJobBlockStyle(job, dayDate)
      return style !== null
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
            onClick={() => onNavigate('dashboard')}
            className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft size={20} />
            <span>Back to Dashboard</span>
          </button>
        </div>
        
        <div className="flex items-center gap-4">
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <Calendar size={24} className="text-skynet-accent" />
            {zoomedDay ? 'Day View' : 'Schedule View'}
          </h2>
          {scheduledJobs.length > 0 && (
            <span className="text-sm text-gray-400">
              ({scheduledJobs.length} scheduled this week)
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
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
              {incompleteJobs.length > 0 && (
                <span className="ml-auto flex items-center gap-1 text-xs text-red-400 bg-red-900/30 px-2 py-0.5 rounded">
                  <AlertTriangle size={12} />
                  {incompleteJobs.length} needs reschedule
                </span>
              )}
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
                const isIncomplete = job.status === 'incomplete'
                const piecesRemaining = isIncomplete 
                  ? job.quantity - (job.good_pieces || 0)
                  : null
                
                return (
                  <div
                    key={job.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, job)}
                    onDragEnd={handleDragEnd}
                    className={`rounded-lg p-3 border-l-4 
                      cursor-grab active:cursor-grabbing hover:bg-gray-750 transition-all touch-manipulation
                      ${draggedJob?.id === job.id ? 'opacity-50 scale-95' : ''}
                      ${isIncomplete 
                        ? 'bg-red-900/20 border-red-600 ring-1 ring-red-800/50' 
                        : `bg-gray-800 ${getPriorityBorder(job.priority)}`
                      }`}
                  >
                    {/* Incomplete job header */}
                    {isIncomplete && (
                      <div className="flex items-center gap-2 mb-2 pb-2 border-b border-red-800/50">
                        <AlertTriangle size={14} className="text-red-400" />
                        <span className="text-xs text-red-400 font-medium">Needs Rescheduling</span>
                      </div>
                    )}
                    
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`font-mono font-semibold ${isIncomplete ? 'text-red-300' : 'text-white'}`}>
                            {job.job_number}
                          </span>
                          <div className={`w-2 h-2 rounded-full ${getPriorityColor(job.priority)}`}></div>
                          {hasPreferred && (
                            <Star size={12} className="text-yellow-500" title="Has preferred machine" />
                          )}
                        </div>
                        <p className="text-gray-400 text-sm truncate">{job.work_order?.wo_number}</p>
                        <p className="text-skynet-accent text-sm truncate">{job.component?.part_number}</p>
                        {job.work_order?.customer && (
                          <p className="text-gray-500 text-xs truncate">{job.work_order.customer}</p>
                        )}
                        
                        {/* Incomplete job details */}
                        {isIncomplete && (
                          <div className="mt-2 pt-2 border-t border-red-800/30 space-y-1">
                            {job.incomplete_reason && (
                              <p className="text-xs text-red-300 truncate" title={job.incomplete_reason}>
                                Reason: {job.incomplete_reason}
                              </p>
                            )}
                            <div className="flex items-center gap-2 text-xs">
                              <span className="text-gray-500">Progress:</span>
                              <span className="text-green-400">{job.good_pieces || 0} good</span>
                              <span className="text-gray-600">/</span>
                              <span className="text-red-400">{job.bad_pieces || 0} bad</span>
                            </div>
                            <p className="text-xs text-yellow-400">
                              {piecesRemaining} pieces remaining
                            </p>
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <GripVertical size={16} className="text-gray-600" />
                        {job.work_order?.due_date && (
                          <span className="text-xs text-gray-500">
                            Due: {formatDate(job.work_order.due_date)}
                          </span>
                        )}
                        {!isIncomplete && (
                          job.estimated_minutes ? (
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
                          )
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Right Panel - Timeline */}
        <div className="flex-1 flex flex-col bg-gray-900 rounded-lg border border-gray-700 overflow-hidden min-w-0">
          {/* Timeline Header */}
          <div className="flex border-b border-gray-700">
            <div className={`w-32 flex-shrink-0 p-3 border-r border-gray-700 bg-gray-850`}>
              <span className="text-gray-400 text-sm font-medium">Machine</span>
            </div>
            
            {/* Week View Headers */}
            {!zoomedDay && (
              <div className="flex-1 flex overflow-x-auto">
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
          <div className={`flex-1 overflow-auto`}>
            <div className={zoomedDay ? 'min-w-max' : ''}>
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
              machines.map(machine => {
                const isPreferred = isMachinePreferred(machine.id)
                const hasDuration = machineHasDuration(machine.id)
                
                return (
                  <div key={machine.id} className={`flex border-b border-gray-800 last:border-b-0 min-h-[60px] ${
                    (draggedJob || draggedScheduledJob) && isPreferred ? 'bg-yellow-900/10' : ''
                  }`}>
                    <div className={`w-32 flex-shrink-0 p-3 border-r border-gray-700 bg-gray-850 flex flex-col justify-center ${
                      zoomedDay ? 'sticky left-0 z-10' : ''
                    } ${
                      (draggedJob || draggedScheduledJob) && isPreferred ? 'bg-yellow-900/20' : ''
                    }`}>
                      <div className="flex items-center gap-1">
                        <span className="text-white font-medium text-sm">{machine.name}</span>
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
                    </div>
                    
                    {/* Week View Timeline */}
                    {!zoomedDay && (
                      <div className="flex-1 flex">
                        {weekDates.map((date, dayIndex) => {
                          const dayJobs = getJobsForMachineDay(machine.id, date)
                          const isTarget = isDropTarget(machine.id, date)
                          
                          return (
                            <div 
                              key={dayIndex}
                              onDragOver={(e) => handleDragOver(e, machine.id, date)}
                              onDragLeave={handleDragLeave}
                              onDrop={(e) => handleDrop(e, machine.id, date)}
                              className={`flex-1 min-w-[150px] border-r border-gray-800 last:border-r-0 relative transition-colors ${
                                isToday(date) ? 'bg-skynet-accent/5' : ''
                              } ${isTarget ? 'bg-skynet-accent/20 ring-2 ring-inset ring-skynet-accent' : ''}`}
                            >
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
                              
                              <div className="absolute inset-0 p-1">
                                {dayJobs.map(job => {
                                  const style = getJobBlockStyle(job, date)
                                  if (!style) return null
                                  
                                  return (
                                    <div
                                      key={job.id}
                                      draggable
                                      onDragStart={(e) => handleScheduledDragStart(e, job)}
                                      onDragEnd={handleDragEnd}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setSelectedJob(job)
                                      }}
                                      className={`absolute top-1 bottom-1 ${getPriorityBlockColor(job.priority)} 
                                        rounded cursor-grab border-l-2 hover:brightness-110 transition-all
                                        flex items-center overflow-hidden px-1 active:cursor-grabbing
                                        ${style.continuesFromPrevious ? 'rounded-l-none border-l-0' : ''}
                                        ${style.continuesToNext ? 'rounded-r-none' : ''}
                                        ${draggedScheduledJob?.id === job.id ? 'opacity-50' : ''}`}
                                      style={{ 
                                        left: style.left, 
                                        width: style.width 
                                      }}
                                      title={`${job.job_number} - ${job.component?.part_number} (drag to reschedule)`}
                                    >
                                      <span className="text-white text-xs font-medium truncate">
                                        {job.job_number}
                                      </span>
                                      {job.requires_attendance && (
                                        <User size={10} className="ml-1 text-white/70 flex-shrink-0" />
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {/* Day View Timeline (Zoomed) */}
                    {zoomedDay && (
                      <div className="flex-1">
                        <div className="relative" style={{ width: `${24 * 60}px`, height: '58px' }}>
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
                            
                            return (
                              <div
                                key={job.id}
                                draggable={!isResizingThis}
                                onDragStart={(e) => !isResizingThis && handleScheduledDragStart(e, job)}
                                onDragEnd={handleDragEnd}
                                onClick={(e) => {
                                  if (!isResizingThis) {
                                    e.stopPropagation()
                                    setSelectedJob(job)
                                  }
                                }}
                                className={`absolute top-1 bottom-1 ${getPriorityBlockColor(job.priority)} 
                                  rounded cursor-grab border-l-2 hover:brightness-110 transition-all
                                  flex items-center overflow-hidden px-2 active:cursor-grabbing group
                                  ${style.continuesFromPrevious ? 'rounded-l-none border-l-0' : ''}
                                  ${style.continuesToNext ? 'rounded-r-none' : ''}
                                  ${draggedScheduledJob?.id === job.id ? 'opacity-50' : ''}
                                  ${isResizingThis ? 'ring-2 ring-white cursor-ew-resize' : ''}`}
                                style={{ 
                                  left: style.left, 
                                  width: style.width 
                                }}
                                title={`${job.job_number} - ${job.component?.part_number} (drag to reschedule, drag edges to resize)`}
                              >
                                {/* Left resize handle */}
                                {!style.continuesFromPrevious && (
                                  <div
                                    onMouseDown={(e) => handleResizeStart(e, job, 'start')}
                                    className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/30 opacity-0 group-hover:opacity-100 transition-opacity"
                                    title="Drag to adjust start time"
                                  />
                                )}
                                
                                <span className="text-white text-xs font-medium truncate">
                                  {job.job_number}
                                </span>
                                <span className="text-white/70 text-xs ml-2 truncate hidden sm:inline">
                                  {job.component?.part_number}
                                </span>
                                {job.requires_attendance && (
                                  <User size={12} className="ml-1 text-white/70 flex-shrink-0" />
                                )}
                                
                                {/* Right resize handle */}
                                {!style.continuesToNext && (
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
            {!zoomedDay && (
              <div className="flex items-center gap-2 ml-auto">
                <ZoomIn size={12} className="text-gray-400" />
                <span className="text-gray-400">Click day header to zoom</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Schedule Modal */}
      {scheduleModal && (
        <div 
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => {
            setScheduleModal(null)
            setNoTimeAvailable(false)
          }}
        >
          <div 
            className="bg-gray-900 rounded-lg border border-gray-700 p-6 max-w-md w-full mx-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-white flex items-center gap-2">
                  {scheduleModal.isReschedule ? 'Reschedule Job' : 'Schedule Job'}
                  {scheduleModal.isReschedule && <Edit3 size={18} className="text-skynet-accent" />}
                </h3>
                <p className="text-gray-400">
                  Assign to {scheduleModal.machineName}
                  <span className="text-gray-500 ml-1">({scheduleModal.machineCode})</span>
                </p>
              </div>
              <button
                onClick={() => {
                  setScheduleModal(null)
                  setNoTimeAvailable(false)
                }}
                className="text-gray-500 hover:text-white transition-colors"
              >
                <X size={24} />
              </button>
            </div>

            <div className="bg-gray-800 rounded-lg p-4 mb-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-white font-mono font-bold">{scheduleModal.job.job_number}</span>
                <div className={`w-2 h-2 rounded-full ${getPriorityColor(scheduleModal.job.priority)}`}></div>
                {scheduleModal.job.status === 'incomplete' && (
                  <span className="text-xs bg-red-900/50 text-red-400 px-2 py-0.5 rounded flex items-center gap-1">
                    <AlertTriangle size={10} />
                    Incomplete
                  </span>
                )}
              </div>
              <p className="text-skynet-accent">{scheduleModal.job.component?.part_number}</p>
              <p className="text-gray-400 text-sm">{scheduleModal.job.work_order?.wo_number}</p>
              {scheduleModal.job.work_order?.due_date && (
                <p className="text-gray-500 text-sm mt-1">Due: {formatDate(scheduleModal.job.work_order.due_date)}</p>
              )}
              
              {/* Incomplete job details in modal */}
              {scheduleModal.job.status === 'incomplete' && (
                <div className="mt-3 pt-3 border-t border-red-800/30 space-y-1">
                  {scheduleModal.job.incomplete_reason && (
                    <p className="text-xs text-red-300">
                      <span className="text-gray-500">Reason:</span> {scheduleModal.job.incomplete_reason}
                    </p>
                  )}
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-gray-500">Progress:</span>
                    <span className="text-green-400">{scheduleModal.job.good_pieces || 0} good</span>
                    <span className="text-red-400">{scheduleModal.job.bad_pieces || 0} bad</span>
                  </div>
                  <p className="text-xs text-yellow-400">
                    {scheduleModal.job.quantity - (scheduleModal.job.good_pieces || 0)} pieces remaining of {scheduleModal.job.quantity}
                  </p>
                </div>
              )}
            </div>

            {durationSource && !scheduleModal.isReschedule && (
              <div className={`flex items-center gap-2 mb-4 px-3 py-2 rounded text-sm ${
                durationSource === 'database' 
                  ? 'bg-blue-900/30 text-blue-300 border border-blue-800'
                  : 'bg-gray-800 text-gray-400 border border-gray-700'
              }`}>
                {durationSource === 'database' ? (
                  <>
                    <Database size={14} />
                    <span>Duration loaded from saved estimates</span>
                  </>
                ) : (
                  <>
                    <Info size={14} />
                    <span>Duration from job (not saved for this machine yet)</span>
                  </>
                )}
              </div>
            )}

            {/* No time available warning */}
            {noTimeAvailable && (
              <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 mb-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={20} className="text-red-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-red-400 font-medium">No Shift Time Available</p>
                    <p className="text-red-300/70 text-sm mt-1">
                      There is no available time during shift hours (7am-4pm) on this day for this machine. 
                      Consider scheduling for a different day, or override if scheduling outside shift hours is necessary.
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-gray-400 text-sm mb-1">Date</label>
                <div className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white">
                  {formatFullDate(new Date(scheduleModal.date))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-gray-400 text-sm">Start Time</label>
                  <button
                    type="button"
                    onClick={() => {
                      const durationMins = (scheduleForm.durationHours * 60) + scheduleForm.durationMinutes
                      const nextTime = getNextAvailableTime(
                        scheduleModal.machineId, 
                        scheduleModal.date, 
                        durationMins || 60,
                        scheduleModal.isReschedule ? scheduleModal.job.id : null
                      )
                      const timeStr = `${String(nextTime.hours).padStart(2, '0')}:${String(nextTime.minutes).padStart(2, '0')}`
                      setScheduleForm(prev => ({ ...prev, startTime: timeStr }))
                      setNoTimeAvailable(nextTime.noTimeAvailable)
                    }}
                    className="flex items-center gap-1 text-xs text-skynet-accent hover:text-blue-400 transition-colors"
                  >
                    <Clock size={12} />
                    Next Available
                  </button>
                </div>
                <input
                  type="time"
                  value={scheduleForm.startTime}
                  onChange={(e) => setScheduleForm(prev => ({ ...prev, startTime: e.target.value }))}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
                  style={{ colorScheme: 'dark' }}
                />
              </div>

              <div>
                <label className="block text-gray-400 text-sm mb-1">Estimated Duration</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    max="72"
                    value={scheduleForm.durationHours}
                    onChange={(e) => setScheduleForm(prev => ({ ...prev, durationHours: parseInt(e.target.value) || 0 }))}
                    className="w-20 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
                  />
                  <span className="text-gray-400">hours</span>
                  <input
                    type="number"
                    min="0"
                    max="59"
                    step="15"
                    value={scheduleForm.durationMinutes}
                    onChange={(e) => setScheduleForm(prev => ({ ...prev, durationMinutes: parseInt(e.target.value) || 0 }))}
                    className="w-20 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
                  />
                  <span className="text-gray-400">min</span>
                </div>
              </div>

              {durationSource !== 'database' && !scheduleModal.isReschedule && (
                <div className="flex items-center gap-3 p-3 bg-gray-800/50 rounded border border-gray-700">
                  <input
                    type="checkbox"
                    id="saveDuration"
                    checked={scheduleForm.saveDuration}
                    onChange={(e) => setScheduleForm(prev => ({ ...prev, saveDuration: e.target.checked }))}
                    className="w-5 h-5 rounded border-gray-600 bg-gray-800 text-skynet-accent focus:ring-skynet-accent"
                  />
                  <label htmlFor="saveDuration" className="text-white flex items-center gap-2">
                    <Database size={16} className="text-blue-400" />
                    Save duration for future {scheduleModal.job.component?.part_number} on {scheduleModal.machineCode}
                  </label>
                </div>
              )}

              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="requiresAttendance"
                  checked={scheduleForm.requiresAttendance}
                  onChange={(e) => setScheduleForm(prev => ({ ...prev, requiresAttendance: e.target.checked }))}
                  className="w-5 h-5 rounded border-gray-600 bg-gray-800 text-skynet-accent focus:ring-skynet-accent"
                />
                <label htmlFor="requiresAttendance" className="text-white flex items-center gap-2">
                  <User size={16} className="text-gray-400" />
                  Requires Operator Attendance
                </label>
              </div>

              {saveError && (
                <div className="p-3 bg-red-900/50 border border-red-700 rounded text-red-300 text-sm">
                  {saveError}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  onClick={() => {
                    setScheduleModal(null)
                    setNoTimeAvailable(false)
                  }}
                  className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveSchedule}
                  disabled={saving || (scheduleForm.durationHours === 0 && scheduleForm.durationMinutes === 0)}
                  className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? (
                    <>
                      <Loader2 size={18} className="animate-spin" />
                      {scheduleModal.isReschedule ? 'Updating...' : 'Scheduling...'}
                    </>
                  ) : (
                    <>
                      <Save size={18} />
                      {scheduleModal.isReschedule ? 'Update Schedule' : 'Schedule Job'}
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Job Detail Popup */}
      {selectedJob && (
        <div 
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setSelectedJob(null)}
        >
          <div 
            className="bg-gray-900 rounded-lg border border-gray-700 p-6 max-w-md w-full mx-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-white flex items-center gap-2">
                  {selectedJob.job_number}
                  <div className={`w-3 h-3 rounded-full ${getPriorityColor(selectedJob.priority)}`}></div>
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
              <div>
                <span className="text-gray-500 text-sm">Part</span>
                <p className="text-skynet-accent font-medium">{selectedJob.component?.part_number}</p>
                <p className="text-gray-400 text-sm">{selectedJob.component?.description}</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-gray-500 text-sm">Machine</span>
                  <p className="text-white">{selectedJob.assigned_machine?.name}</p>
                </div>
                <div>
                  <span className="text-gray-500 text-sm">Quantity</span>
                  <p className="text-white">{selectedJob.quantity}</p>
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
                    {Math.floor(selectedJob.estimated_minutes / 60)}h {selectedJob.estimated_minutes % 60}m
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
                  <span className="text-white capitalize">{selectedJob.status?.replace('_', ' ')}</span>
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-3 pt-4 border-t border-gray-700">
                <button
                  onClick={() => {
                    // Open schedule modal in edit mode
                    const machine = machines.find(m => m.id === selectedJob.assigned_machine_id)
                    const durationRecord = getDurationForPartMachine(selectedJob.component_id, selectedJob.assigned_machine_id)
                    
                    setScheduleModal({
                      job: selectedJob,
                      machineId: selectedJob.assigned_machine_id,
                      machineName: machine?.name || selectedJob.assigned_machine?.name || 'Unknown',
                      machineCode: machine?.code || selectedJob.assigned_machine?.code || '',
                      date: new Date(selectedJob.scheduled_start),
                      durationRecord,
                      isReschedule: true
                    })
                    
                    // Pre-fill form with current values
                    const startTime = new Date(selectedJob.scheduled_start).toTimeString().slice(0, 5)
                    const hours = Math.floor((selectedJob.estimated_minutes || 60) / 60)
                    const minutes = (selectedJob.estimated_minutes || 60) % 60
                    
                    setScheduleForm({
                      startTime,
                      durationHours: hours,
                      durationMinutes: minutes,
                      requiresAttendance: selectedJob.requires_attendance || false,
                      saveDuration: false
                    })
                    setDurationSource('job')
                    setSelectedJob(null)
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white font-medium rounded transition-colors"
                >
                  <Edit3 size={16} />
                  Edit
                </button>
                <button
                  onClick={() => setUnscheduleConfirm(selectedJob)}
                  className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 text-white font-medium rounded transition-colors"
                >
                  <Undo2 size={16} />
                  Unschedule
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Unschedule Confirmation Modal */}
      {unscheduleConfirm && (
        <div 
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setUnscheduleConfirm(null)}
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

            <p className="text-gray-300 mb-6">
              This will remove the job from the schedule and return it to the unassigned pool. You can reschedule it later.
            </p>

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setUnscheduleConfirm(null)}
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
      )}
    </div>
  )
}