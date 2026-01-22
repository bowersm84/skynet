import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { 
  Lock, 
  Unlock, 
  AlertCircle, 
  Loader2, 
  LogOut,
  Play,
  Wrench,
  CheckCircle,
  Clock,
  AlertTriangle,
  Package,
  FileText,
  Eye,
  Shield,
  History,
  X,
  Save,
  Plus,
  Trash2,
  SkipForward,
  Database,
  PauseCircle,
  SendHorizontal,
  Layers,
  Edit3,
  Timer
} from 'lucide-react'

export default function Kiosk() {
  const { machineCode } = useParams()
  
  // Machine state
  const [machine, setMachine] = useState(null)
  const [machineLoading, setMachineLoading] = useState(true)
  const [machineError, setMachineError] = useState(null)
  
  // Auth state
  const [pin, setPin] = useState('')
  const [operator, setOperator] = useState(null)
  const [authError, setAuthError] = useState(null)
  const [authenticating, setAuthenticating] = useState(false)
  
  // Job state
  const [jobs, setJobs] = useState([])
  const [jobsLoading, setJobsLoading] = useState(false)
  const [activeJob, setActiveJob] = useState(null)
  const [selectedJob, setSelectedJob] = useState(null)
  
  // Action states
  const [actionLoading, setActionLoading] = useState(false)
  
  // Tooling state
  const [showToolingModal, setShowToolingModal] = useState(false)
  const [jobTools, setJobTools] = useState([])
  const [currentTools, setCurrentTools] = useState([]) // Tools for active job display
  const [toolHistory, setToolHistory] = useState([])
  const [otherMachineTools, setOtherMachineTools] = useState([])
  const [newTool, setNewTool] = useState({ tool_name: '', tool_type: '', serial_number: '' })
  const [toolsLoading, setToolsLoading] = useState(false)
  
  // Tool verification state (for adding tools from other machines)
  const [showToolVerifyModal, setShowToolVerifyModal] = useState(false)
  const [toolToVerify, setToolToVerify] = useState(null) // The tool being verified
  const [verifySerialInput, setVerifySerialInput] = useState('')
  const [verifyStep, setVerifyStep] = useState('enter') // 'enter', 'mismatch'
  
  // Complete job modal state
  const [showCompleteModal, setShowCompleteModal] = useState(false)
  const [completeForm, setCompleteForm] = useState({
    actual_end: '',
    good_pieces: 0,
    bad_pieces: 0
  })
  const [showIncompleteConfirm, setShowIncompleteConfirm] = useState(false) // DEPRECATED - kept for compatibility
  const [completionStep, setCompletionStep] = useState('form') // 'form', 'review_downtimes', 'materials', 'confirm_incomplete'
  const [ongoingDowntimes, setOngoingDowntimes] = useState([])
  const [downtimeEdits, setDowntimeEdits] = useState({}) // {id: {end_time, duration_hours, duration_mins, use_duration}}
  const [validationErrors, setValidationErrors] = useState([])
  const [materialRemaining, setMaterialRemaining] = useState({}) // {material_id: bars_remaining}
  
  // Downtime modal state
  const [showDowntimeModal, setShowDowntimeModal] = useState(false)
  
  // Maintenance-specific state
  const [showExtendModal, setShowExtendModal] = useState(false)
  const [extendDuration, setExtendDuration] = useState({ hours: 0, minutes: 30 })
  const [maintenanceCompletionNotes, setMaintenanceCompletionNotes] = useState('')
  const [downtimeForm, setDowntimeForm] = useState({
    reason: '',
    notes: '',
    start_time: '',
    end_time: '',
    duration_hours: 0,
    duration_mins: 0,
    use_duration: false,
    good_pieces: 0,
    bad_pieces: 0,
    send_to_scheduling: false
  })
  const [downtimeLogs, setDowntimeLogs] = useState([])
  const [downtimeLogsLoading, setDowntimeLogsLoading] = useState(false)
  
  // Edit downtime from activity log
  const [editingDowntime, setEditingDowntime] = useState(null)
  const [editDowntimeForm, setEditDowntimeForm] = useState({
    end_time: '',
    duration_hours: 0,
    duration_mins: 0,
    use_duration: false,
    send_to_scheduling: false,
    good_pieces: 0
  })
  
  // DOWN warning modal state (shown when logging ongoing downtime)
  const [showDownWarning, setShowDownWarning] = useState(false)
  const [pendingDowntimeData, setPendingDowntimeData] = useState(null)
  
  // Material tracking state
  const [showMaterialModal, setShowMaterialModal] = useState(false)
  const [showMaterialOverrideModal, setShowMaterialOverrideModal] = useState(false)
  const [materialForm, setMaterialForm] = useState({
    material_type: '',
    bar_size: '',
    bar_length: '',
    lot_number: '',
    bars_loaded: 0
  })
  const [materialTypes, setMaterialTypes] = useState([])
  const [barSizes, setBarSizes] = useState([])
  const [jobMaterials, setJobMaterials] = useState([]) // Materials loaded for current job
  
  // Admin state
  const [showJobHistory, setShowJobHistory] = useState(false)
  const [jobHistory, setJobHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [editingJob, setEditingJob] = useState(null)
  const [editForm, setEditForm] = useState({})
  const [saving, setSaving] = useState(false)
  
  // Previous jobs on this machine (recent completed jobs)
  const [previousJobs, setPreviousJobs] = useState([])
  const [previousJobsLoading, setPreviousJobsLoading] = useState(false)
  const [selectedPreviousJob, setSelectedPreviousJob] = useState(null)
  const [previousJobActivities, setPreviousJobActivities] = useState([])
  
  // Job activity log for active job
  const [jobActivities, setJobActivities] = useState([])
  
  // Machine DOWN/Ready state (for orphaned downtimes)
  const [orphanedDowntimes, setOrphanedDowntimes] = useState([])
  const [showMachineReadyModal, setShowMachineReadyModal] = useState(false)
  const [machineReadyNotes, setMachineReadyNotes] = useState('')
  const [clearingDowntime, setClearingDowntime] = useState(false)

  // Common downtime reasons
  const DOWNTIME_REASONS = [
    'Tooling change',
    'Tool breakage',
    'Tool wear',
    'Material issue',
    'Machine malfunction',
    'Operator error',
    'Quality issue',
    'Programming issue',
    'Setup adjustment',
    'Preventive maintenance',
    'Other'
  ]

  // Tooling change workflow state
  const [showToolChangeModal, setShowToolChangeModal] = useState(false)
  const [toolChangeForm, setToolChangeForm] = useState({
    tool_id: '',
    new_serial_number: '',
    start_time: '',
    duration_hours: 0,
    duration_mins: 5  // Default 5 minutes for tool change
  })

  // Out-of-order job selection warning
  const [showOutOfOrderWarning, setShowOutOfOrderWarning] = useState(false)
  const [pendingJobSelection, setPendingJobSelection] = useState(null)

  // Tool serial conflict state
  const [toolSerialConflict, setToolSerialConflict] = useState(null) // {machineName, jobNumber, serialNumber}

  // Determine user capabilities based on role
  const isViewOnly = operator?.role === 'display'
  const isAdmin = operator?.role === 'admin'
  const canOperate = operator?.role === 'machinist' || operator?.role === 'admin'

  // Load machine on mount
  useEffect(() => {
    if (machineCode) {
      loadMachine()
    }
  }, [machineCode])

  // Set document title when machine loads
  useEffect(() => {
    if (machine) {
      document.title = `${machine.name} | SkyNet MES`
    } else {
      document.title = 'SkyNet MES'
    }
    return () => {
      document.title = 'SkyNet MES'
    }
  }, [machine])

  // Keyboard support for PIN entry
  useEffect(() => {
    if (operator) return

    const handleKeyDown = (e) => {
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault()
        handlePinInput(e.key)
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        handlePinBackspace()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (pin.length >= 4) handlePinSubmit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        handlePinClear()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [operator, pin])

  // Load jobs when operator logs in
  useEffect(() => {
    if (operator && machine) {
      loadJobs()
      loadPreviousJobs()
      
      const subscription = supabase
        .channel(`kiosk-jobs-${machine.id}`)
        .on('postgres_changes', 
          { event: '*', schema: 'public', table: 'jobs', filter: `assigned_machine_id=eq.${machine.id}` },
          () => {
            loadJobs()
            loadPreviousJobs()
          }
        )
        .subscribe()

      return () => supabase.removeChannel(subscription)
    }
  }, [operator, machine])
  
  // Load orphaned downtimes when operator logs in
  useEffect(() => {
    if (operator && machine) {
      loadOrphanedDowntimes()
    
      // Subscribe to downtime changes
      const downtimeSubscription = supabase
        .channel(`kiosk-downtimes-${machine.id}`)
        .on('postgres_changes', 
          { event: '*', schema: 'public', table: 'machine_downtime_logs', filter: `machine_id=eq.${machine.id}` },
          () => {
            loadOrphanedDowntimes()
          }
        )
        .subscribe()

      return () => supabase.removeChannel(downtimeSubscription)
    }
  }, [operator, machine])

  // Build activity log when active job changes
  useEffect(() => {
    if (activeJob) {
      buildActivityLog(activeJob)
    } else {
      setJobActivities([])
    }
  }, [activeJob?.id, activeJob?.status, activeJob?.setup_start, activeJob?.production_start, activeJob?.actual_end])

  // Load job materials when active job changes
  useEffect(() => {
    if (activeJob) {
      loadJobMaterials(activeJob.id)
    } else {
      setJobMaterials([])
    }
  }, [activeJob?.id])

  // Load orphaned downtimes (downtimes with no end_time for this machine)
  const loadOrphanedDowntimes = async () => {
    if (!machine) return
    try {
      const { data, error } = await supabase
        .from('machine_downtime_logs')
        .select('*')
        .eq('machine_id', machine.id)
        .is('end_time', null)
        .order('start_time', { ascending: false })

      if (error) throw error
      setOrphanedDowntimes(data || [])
    } catch (err) {
      console.error('Error loading orphaned downtimes:', err)
    }
  }

  // Clear machine DOWN status by closing all orphaned downtimes
  const handleClearMachineDown = async () => {
    if (!machine || !operator) return
    setClearingDowntime(true)
    
    try {
      const now = new Date().toISOString()
      
      // Close all orphaned downtimes for this machine
      const { error } = await supabase
        .from('machine_downtime_logs')
        .update({ 
          end_time: now,
          notes: machineReadyNotes 
            ? `${orphanedDowntimes[0]?.notes || ''} | Cleared by ${operator.full_name}: ${machineReadyNotes}`.trim()
            : `${orphanedDowntimes[0]?.notes || ''} | Cleared by ${operator.full_name}`.trim(),
          updated_at: now
        })
        .eq('machine_id', machine.id)
        .is('end_time', null)

      if (error) throw error
      
      // Also reset machine status if it was set to 'down'
      if (machine.status === 'down') {
        await supabase
          .from('machines')
          .update({ 
            status: 'available',
            status_reason: null,
            updated_at: now
          })
          .eq('id', machine.id)
      }
      
      // Refresh data
      await loadOrphanedDowntimes()
      await loadMachine()
      
      // Close modal and reset
      setShowMachineReadyModal(false)
      setMachineReadyNotes('')
    } catch (err) {
      console.error('Error clearing machine down status:', err)
      alert('Failed to clear machine status. Please try again.')
    } finally {
      setClearingDowntime(false)
    }
  }

  // Load current tools when active job changes
  useEffect(() => {
    const loadCurrentTools = async () => {
      if (activeJob) {
        const { data, error } = await supabase
          .from('job_tools')
          .select('*')
          .eq('job_id', activeJob.id)
          .order('added_at')
        
        if (!error) {
          setCurrentTools(data || [])
        }
      } else {
        setCurrentTools([])
      }
    }
    loadCurrentTools()
  }, [activeJob?.id])

  const loadMachine = async () => {
    setMachineLoading(true)
    setMachineError(null)
    const searchTerm = decodeURIComponent(machineCode)

    try {
      let { data, error } = await supabase
        .from('machines')
        .select('*, location:locations(name, code)')
        .eq('code', searchTerm)
        .eq('is_active', true)
        .single()

      if (error?.code === 'PGRST116') {
        const { data: nameData, error: nameError } = await supabase
          .from('machines')
          .select('*, location:locations(name, code)')
          .ilike('name', searchTerm)
          .eq('is_active', true)
          .single()
        
        if (nameError?.code === 'PGRST116') {
          setMachineError(`Machine "${searchTerm}" not found`)
          return
        } else if (nameError) throw nameError
        else data = nameData
      } else if (error) throw error

      setMachine(data)
    } catch (err) {
      console.error('Error loading machine:', err)
      setMachineError('Failed to load machine')
    } finally {
      setMachineLoading(false)
    }
  }

  const loadJobs = async () => {
    if (!machine) return
    setJobsLoading(true)
    try {
      const { data, error } = await supabase
        .from('jobs')
        .select(`
          *,
          work_order:work_orders(wo_number, customer, priority, due_date, order_type, maintenance_type, notes),
          component:parts!component_id(id, part_number, description)
        `)
        .eq('assigned_machine_id', machine.id)
        .in('status', ['assigned', 'in_setup', 'in_progress'])
        .order('scheduled_start', { ascending: true })

      if (error) throw error
      setJobs(data || [])
      const active = data?.find(j => j.status === 'in_setup' || j.status === 'in_progress')
      setActiveJob(active || null)
    } catch (err) {
      console.error('Error loading jobs:', err)
    } finally {
      setJobsLoading(false)
    }
  }

  const loadJobHistory = async () => {
    if (!machine) return
    setHistoryLoading(true)
    try {
      const { data, error } = await supabase
        .from('jobs')
        .select(`
          *,
          work_order:work_orders(wo_number, customer, priority, due_date, order_type, maintenance_type, notes),
          component:parts!component_id(id, part_number, description)
        `)
        .eq('assigned_machine_id', machine.id)
        .in('status', ['manufacturing_complete', 'pending_post_manufacturing', 'ready_for_assembly', 'complete', 'incomplete'])
        .order('actual_end', { ascending: false, nullsFirst: false })
        .limit(20)

      if (error) throw error
      setJobHistory(data || [])
    } catch (err) {
      console.error('Error loading job history:', err)
    } finally {
      setHistoryLoading(false)
    }
  }

  const loadDowntimeLogs = async () => {
    if (!machine) return
    setDowntimeLogsLoading(true)
    try {
      const { data, error } = await supabase
        .from('machine_downtime_logs')
        .select('*')
        .eq('machine_id', machine.id)
        .order('start_time', { ascending: false })
        .limit(10)

      if (error) throw error
      setDowntimeLogs(data || [])
    } catch (err) {
      console.error('Error loading downtime logs:', err)
    } finally {
      setDowntimeLogsLoading(false)
    }
  }

  const loadToolHistory = async (jobId, partId) => {
    if (!machine || !partId) return
    setToolsLoading(true)
    try {
      const { data: currentTools, error: currentError } = await supabase
        .from('job_tools')
        .select('*')
        .eq('job_id', jobId)
        .order('created_at', { ascending: true })

      if (currentError) throw currentError
      setJobTools(currentTools || [])

      const { data: historyData, error: historyError } = await supabase
        .from('job_tools')
        .select(`*, job:jobs!inner(id, job_number, component_id, assigned_machine_id, status)`)
        .eq('job.component_id', partId)
        .eq('job.assigned_machine_id', machine.id)
        .neq('job_id', jobId)
        .in('job.status', ['manufacturing_complete', 'pending_post_manufacturing', 'ready_for_assembly', 'complete'])
        .order('created_at', { ascending: false })
        .limit(20)

      if (historyError) throw historyError
      const seen = new Set()
      const uniqueHistory = (historyData || []).filter(t => {
        const key = `${t.tool_name}-${t.serial_number || 'no-serial'}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      setToolHistory(uniqueHistory)

      const { data: otherData, error: otherError } = await supabase
        .from('job_tools')
        .select(`*, job:jobs!inner(id, job_number, component_id, assigned_machine_id, status), machine:jobs!inner(assigned_machine:machines(name))`)
        .eq('job.component_id', partId)
        .neq('job.assigned_machine_id', machine.id)
        .in('job.status', ['manufacturing_complete', 'pending_post_manufacturing', 'ready_for_assembly', 'complete'])
        .order('created_at', { ascending: false })
        .limit(20)

      if (otherError) throw otherError
      const seenOther = new Set()
      const uniqueOther = (otherData || []).filter(t => {
        const key = `${t.tool_name}-${t.serial_number || 'no-serial'}`
        if (seenOther.has(key)) return false
        seenOther.add(key)
        return true
      })
      setOtherMachineTools(uniqueOther)
    } catch (err) {
      console.error('Error loading tool history:', err)
    } finally {
      setToolsLoading(false)
    }
  }

  // Load material types for dropdown
  const loadMaterialTypes = async () => {
    try {
      const { data, error } = await supabase
        .from('material_types')
        .select('*')
        .eq('is_active', true)
        .order('name')
      
      if (error) throw error
      setMaterialTypes(data || [])
    } catch (err) {
      console.error('Error loading material types:', err)
    }
  }

  // Load bar sizes for dropdown
  const loadBarSizes = async () => {
    try {
      const { data, error } = await supabase
        .from('bar_sizes')
        .select('*')
        .eq('is_active', true)
        .order('size_decimal')
      
      if (error) throw error
      setBarSizes(data || [])
    } catch (err) {
      console.error('Error loading bar sizes:', err)
    }
  }

  // Load materials for current job
  const loadJobMaterials = async (jobId) => {
    if (!jobId) return
    try {
      const { data, error } = await supabase
        .from('job_materials')
        .select('*')
        .eq('job_id', jobId)
        .order('created_at')
      
      if (error) throw error
      setJobMaterials(data || [])
    } catch (err) {
      console.error('Error loading job materials:', err)
    }
  }

  // Calculate end time from start time and duration
  const calculateEndTimeFromDuration = (startTime, hours, mins) => {
    if (!startTime) return null
    const start = new Date(startTime)
    const durationMs = ((parseInt(hours) || 0) * 60 + (parseInt(mins) || 0)) * 60 * 1000
    return new Date(start.getTime() + durationMs)
  }

  // Calculate duration from start and end times (returns {hours, mins})
  const calculateDurationFromTimes = (startTime, endTime) => {
    if (!startTime || !endTime) return { hours: 0, mins: 0 }
    const start = new Date(startTime)
    const end = new Date(endTime)
    const diffMs = end - start
    if (diffMs < 0) return { hours: 0, mins: 0 }
    const totalMins = Math.round(diffMs / 60000)
    return {
      hours: Math.floor(totalMins / 60),
      mins: totalMins % 60
    }
  }

  // Handle clicking downtime in activity log to edit
  const handleEditDowntimeClick = (activity) => {
    if (activity.type !== 'downtime') return
    
    // Find the downtime log entry
    const downtimeId = activity.downtimeId
    if (!downtimeId) return
    
    // Calculate duration if there's an end time
    const duration = activity.endTime 
      ? calculateDurationFromTimes(activity.timestamp, activity.endTime)
      : { hours: 0, mins: 0 }
    
    setEditingDowntime({
      id: downtimeId,
      reason: activity.label.replace('Downtime: ', ''),
      start_time: activity.timestamp,
      end_time: activity.endTime
    })
    setEditDowntimeForm({
      end_time: activity.endTime ? formatDateTimeLocal(new Date(activity.endTime)) : '',
      duration_hours: duration.hours,
      duration_mins: duration.mins,
      use_duration: false,
      send_to_scheduling: false,
      good_pieces: activeJob?.good_pieces || 0
    })
  }

  // Save downtime edit
  const handleSaveDowntimeEdit = async () => {
    if (!editingDowntime) return
    
    setActionLoading(true)
    try {
      let endTime = null
      
      if (editDowntimeForm.use_duration) {
        // Calculate end time from duration
        endTime = calculateEndTimeFromDuration(
          editingDowntime.start_time,
          editDowntimeForm.duration_hours,
          editDowntimeForm.duration_mins
        )
      } else if (editDowntimeForm.end_time) {
        endTime = new Date(editDowntimeForm.end_time)
      }
      
      if (!endTime) {
        alert('Please enter an end time or duration')
        setActionLoading(false)
        return
      }
      
      // Validate end time is after start time
      if (endTime <= new Date(editingDowntime.start_time)) {
        alert('End time must be after start time')
        setActionLoading(false)
        return
      }
      
      const { error } = await supabase
        .from('machine_downtime_logs')
        .update({ end_time: endTime.toISOString() })
        .eq('id', editingDowntime.id)
      
      if (error) throw error
      
      // If sending to scheduling, update the job
      if (editDowntimeForm.send_to_scheduling && activeJob) {
        const goodPieces = parseInt(editDowntimeForm.good_pieces) || 0
        const remainingQty = activeJob.quantity - goodPieces
        
        // Update job to incomplete and clear machine assignment
        const { error: jobError } = await supabase
          .from('jobs')
          .update({
            status: 'incomplete',
            good_pieces: goodPieces,
            actual_end: endTime.toISOString(),
            assigned_machine_id: null,
            scheduled_start: null,
            scheduled_end: null,
            incomplete_reason: `Downtime: ${editingDowntime.reason}. ${remainingQty} pieces remaining.`,
            incomplete_by: operator?.id,
            updated_at: new Date().toISOString()
          })
          .eq('id', activeJob.id)
        
        if (jobError) throw jobError
      }
      
      // If machine is DOWN, clear the status since downtime is now resolved
      if (machine?.status === 'down' || editDowntimeForm.send_to_scheduling) {
        const { error: machineError } = await supabase
          .from('machines')
          .update({
            status: 'available',
            status_reason: null,
            status_updated_at: new Date().toISOString(),
            status_updated_by: operator?.id
          })
          .eq('id', machine.id)
        
        if (!machineError) {
          // Update local machine state
          setMachine(prev => ({
            ...prev,
            status: 'available',
            status_reason: null
          }))
        }
      }
      
      setEditingDowntime(null)
      setEditDowntimeForm({ end_time: '', duration_hours: 0, duration_mins: 0, use_duration: false, send_to_scheduling: false, good_pieces: 0 })
      
      // Refresh jobs and activity log
      await loadJobs()
      if (activeJob && !editDowntimeForm.send_to_scheduling) {
        await buildActivityLog(activeJob)
      }
    } catch (err) {
      console.error('Error updating downtime:', err)
      alert('Failed to update downtime: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  // Load previous jobs completed on this machine (for sidebar display)
  const loadPreviousJobs = async () => {
    if (!machine) return
    setPreviousJobsLoading(true)
    try {
      const { data, error } = await supabase
        .from('jobs')
        .select(`
          *,
          work_order:work_orders(wo_number, customer, priority, due_date, order_type, maintenance_type, notes),
          component:parts!component_id(id, part_number, description)
        `)
        .eq('assigned_machine_id', machine.id)
        .in('status', ['manufacturing_complete', 'pending_post_manufacturing', 'ready_for_assembly', 'complete', 'incomplete'])
        .order('actual_end', { ascending: false, nullsFirst: false })
        .limit(5)

      if (error) throw error
      setPreviousJobs(data || [])
    } catch (err) {
      console.error('Error loading previous jobs:', err)
    } finally {
      setPreviousJobsLoading(false)
    }
  }

  // Build activity log for a job from timestamps and downtime logs
  // Can be used for active job or previous jobs
  const buildActivityLog = async (job, setActivitiesFunc = setJobActivities) => {
    if (!job) {
      setActivitiesFunc([])
      return
    }
    
    const activities = []
    
    // Setup started
    if (job.setup_start) {
      activities.push({
        type: 'setup_start',
        timestamp: job.setup_start,
        label: 'Setup Started',
        icon: 'wrench',
        color: 'yellow'
      })
    }
    
    // Production started (tooling confirmed)
    if (job.production_start) {
      // Calculate setup duration
      const setupDuration = job.setup_start ? 
        Math.round((new Date(job.production_start) - new Date(job.setup_start)) / 60000) : null
      
      activities.push({
        type: 'production_start',
        timestamp: job.production_start,
        label: 'Production Started',
        sublabel: 'Tooling confirmed',
        duration: setupDuration ? `Setup: ${setupDuration < 60 ? setupDuration + 'm' : Math.floor(setupDuration/60) + 'h ' + (setupDuration%60) + 'm'}` : null,
        icon: 'play',
        color: 'green'
      })
    }
    
    // Fetch downtime logs for this job
    try {
      const { data: downtimes, error } = await supabase
        .from('machine_downtime_logs')
        .select('*')
        .eq('job_id', job.id)
        .order('start_time', { ascending: true })
      
      if (!error && downtimes) {
        downtimes.forEach(dt => {
          // Calculate downtime duration
          let durationStr = null
          if (dt.start_time && dt.end_time) {
            const durationMins = Math.round((new Date(dt.end_time) - new Date(dt.start_time)) / 60000)
            durationStr = durationMins < 60 ? `${durationMins}m` : `${Math.floor(durationMins/60)}h ${durationMins%60}m`
          } else if (dt.start_time) {
            // Ongoing downtime
            const durationMins = Math.round((new Date() - new Date(dt.start_time)) / 60000)
            durationStr = durationMins < 60 ? `${durationMins}m (ongoing)` : `${Math.floor(durationMins/60)}h ${durationMins%60}m (ongoing)`
          }
          
          activities.push({
            type: 'downtime',
            downtimeId: dt.id,  // Include ID for editing
            timestamp: dt.start_time,
            label: `Downtime: ${dt.reason}`,
            sublabel: dt.notes,
            duration: durationStr,
            endTime: dt.end_time,
            isOngoing: !dt.end_time,  // Flag for UI
            icon: 'pause',
            color: 'red'
          })
        })
      }
    } catch (err) {
      console.error('Error fetching downtime logs:', err)
    }
    
    // Job completed
    if (job.actual_end && (job.status === 'manufacturing_complete' || job.status === 'complete' || job.status === 'ready_for_assembly' || job.status === 'pending_post_manufacturing')) {
      // Calculate production duration
      let prodDurationStr = null
      if (job.production_start && job.actual_end) {
        const prodMins = Math.round((new Date(job.actual_end) - new Date(job.production_start)) / 60000)
        prodDurationStr = prodMins < 60 ? `${prodMins}m` : `${Math.floor(prodMins/60)}h ${prodMins%60}m`
      }
      
      activities.push({
        type: 'complete',
        timestamp: job.actual_end,
        label: 'Job Completed',
        sublabel: `Good: ${job.good_pieces || 0} / Bad: ${job.bad_pieces || 0}`,
        duration: prodDurationStr ? `Production: ${prodDurationStr}` : null,
        icon: 'check',
        color: 'green'
      })
    }
    
    // Job sent to scheduling (incomplete)
    if (job.status === 'incomplete' && job.incomplete_at) {
      activities.push({
        type: 'incomplete',
        timestamp: job.incomplete_at,
        label: 'Sent to Scheduling',
        sublabel: job.incomplete_reason,
        icon: 'send',
        color: 'orange'
      })
    }
    
    // Sort by timestamp
    activities.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    
    setActivitiesFunc(activities)
  }

  // Handle previous job selection
  const handlePreviousJobClick = async (job) => {
    if (selectedPreviousJob?.id === job.id) {
      // Deselect
      setSelectedPreviousJob(null)
      setPreviousJobActivities([])
    } else {
      setSelectedPreviousJob(job)
      await buildActivityLog(job, setPreviousJobActivities)
    }
  }

  // ========== PIN AUTH ==========
  const handlePinInput = (digit) => {
    if (pin.length < 6) {
      setPin(prev => prev + digit)
      setAuthError(null)
    }
  }

  const handlePinBackspace = () => {
    setPin(prev => prev.slice(0, -1))
    setAuthError(null)
  }

  const handlePinClear = () => {
    setPin('')
    setAuthError(null)
  }

  const handlePinSubmit = async () => {
    if (pin.length < 4) {
      setAuthError('PIN must be at least 4 digits')
      return
    }
    setAuthenticating(true)
    setAuthError(null)

    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('pin_code', pin)
        .eq('is_active', true)
        .single()

      if (error) {
        if (error.code === 'PGRST116') setAuthError('Invalid PIN')
        else throw error
      } else {
        if (!['machinist', 'admin', 'display'].includes(data.role)) {
          setAuthError('Unauthorized role for kiosk access')
        } else {
          setOperator(data)
          setPin('')
        }
      }
    } catch (err) {
      console.error('Auth error:', err)
      setAuthError('Authentication failed')
    } finally {
      setAuthenticating(false)
    }
  }

  const handleLogout = () => {
    setOperator(null)
    setPin('')
    setJobs([])
    setActiveJob(null)
    setSelectedJob(null)
    setShowJobHistory(false)
    setJobHistory([])
    setEditingJob(null)
    setShowToolingModal(false)
    setShowCompleteModal(false)
    setShowDowntimeModal(false)
  }

  // ========== JOB ACTIONS ==========
  
  // Handle job selection from queue - warn if out of order
  const handleJobSelect = (job) => {
    if (isViewOnly || activeJob) return
    
    // If clicking the same job, deselect it
    if (selectedJob?.id === job.id) {
      setSelectedJob(null)
      return
    }
    
    // Get only assigned (queued) jobs, sorted by scheduled_start
    const queuedJobs = jobs.filter(j => j.status === 'assigned')
    
    // Find the first job in queue
    const firstJobInQueue = queuedJobs[0]
    
    // If selecting a job that's not first in queue, show warning
    if (firstJobInQueue && job.id !== firstJobInQueue.id) {
      setPendingJobSelection(job)
      setShowOutOfOrderWarning(true)
    } else {
      // First in queue or no queue - select directly
      setSelectedJob(job)
    }
  }
  
  // Confirm out-of-order selection
  const handleConfirmOutOfOrder = () => {
    setSelectedJob(pendingJobSelection)
    setPendingJobSelection(null)
    setShowOutOfOrderWarning(false)
  }
  
  // Cancel out-of-order selection
  const handleCancelOutOfOrder = () => {
    setPendingJobSelection(null)
    setShowOutOfOrderWarning(false)
  }

  const handleStartSetup = async (job) => {
    if (!canOperate || !job) return
    setActionLoading(true)
    try {
      // For maintenance orders, skip setup and go straight to in_progress
      const jobIsMaintenance = isMaintenance(job)
      const now = new Date().toISOString()
      
      const updateData = jobIsMaintenance 
        ? {
            status: 'in_progress',
            setup_start: now,
            production_start: now,
            assigned_user_id: operator.id,
            updated_at: now
          }
        : {
            status: 'in_setup',
            setup_start: now,
            assigned_user_id: operator.id,
            updated_at: now
          }
      
      const { error } = await supabase
        .from('jobs')
        .update(updateData)
        .eq('id', job.id)

      if (error) throw error
      await loadJobs()
      setSelectedJob(null)
    } catch (err) {
      console.error('Error starting job:', err)
      alert('Failed to start: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  const handleOpenTooling = async () => {
    if (!activeJob) return
    setShowToolingModal(true)
    await loadToolHistory(activeJob.id, activeJob.component?.id)
  }

  // Check if a serial number is currently checked out on another active job
  const checkSerialConflict = async (serialNumber) => {
    if (!serialNumber) return null
    
    try {
      // Find any active jobs (in_setup or in_progress) that have this serial number
      const { data, error } = await supabase
        .from('job_tools')
        .select(`
          id,
          serial_number,
          job:jobs!inner(
            id,
            job_number,
            status,
            assigned_machine:machines(name, code)
          )
        `)
        .ilike('serial_number', serialNumber)
        .in('job.status', ['in_setup', 'in_progress'])
      
      if (error) {
        console.error('Error checking serial conflict:', error)
        return null
      }
      
      // Filter out current job and find conflicts
      const conflicts = data?.filter(t => t.job?.id !== activeJob?.id) || []
      
      if (conflicts.length > 0) {
        const conflict = conflicts[0]
        return {
          machineName: conflict.job?.assigned_machine?.name || 'Unknown Machine',
          machineCode: conflict.job?.assigned_machine?.code || '',
          jobNumber: conflict.job?.job_number || 'Unknown Job'
        }
      }
      
      return null
    } catch (err) {
      console.error('Error checking serial conflict:', err)
      return null
    }
  }

  const handleAddTool = async () => {
    if (!newTool.tool_name.trim()) {
      alert('Tool name is required')
      return
    }
    
    // Check for serial number conflict if serial is provided
    if (newTool.serial_number.trim()) {
      const conflict = await checkSerialConflict(newTool.serial_number.trim())
      if (conflict) {
        setToolSerialConflict({ ...conflict, serialNumber: newTool.serial_number.trim() })
        return
      }
    }
    
    try {
      const { error } = await supabase
        .from('job_tools')
        .insert({
          job_id: activeJob.id,
          tool_name: newTool.tool_name.trim(),
          tool_type: newTool.tool_type.trim() || null,
          serial_number: newTool.serial_number.trim() || null,
          added_by: operator.id,
          added_at: new Date().toISOString()
        })

      if (error) throw error
      setNewTool({ tool_name: '', tool_type: '', serial_number: '' })
      await loadToolHistory(activeJob.id, activeJob.component?.id)
    } catch (err) {
      console.error('Error adding tool:', err)
      alert('Failed to add tool: ' + err.message)
    }
  }

  // Open verification modal when adding tool from history/other machines
  const handleAddToolFromHistory = (historyTool) => {
    setToolToVerify(historyTool)
    setVerifySerialInput('')
    setVerifyStep('enter')
    setShowToolVerifyModal(true)
  }

  // Verify the serial number and add the tool
  const handleVerifyAndAddTool = async () => {
    if (!toolToVerify) return
    
    const enteredSerial = verifySerialInput.trim()
    const expectedSerial = toolToVerify.serial_number || ''
    
    // Check if serial matches
    if (enteredSerial.toLowerCase() === expectedSerial.toLowerCase()) {
      // Check for serial number conflict before adding
      if (enteredSerial) {
        const conflict = await checkSerialConflict(enteredSerial)
        if (conflict) {
          setShowToolVerifyModal(false)
          setToolSerialConflict({ ...conflict, serialNumber: enteredSerial })
          return
        }
      }
      
      // Serial matches and no conflict - add the tool
      try {
        const { error } = await supabase
          .from('job_tools')
          .insert({
            job_id: activeJob.id,
            tool_name: toolToVerify.tool_name,
            tool_type: toolToVerify.tool_type || null,
            serial_number: toolToVerify.serial_number || null,
            added_by: operator.id,
            added_at: new Date().toISOString()
          })

        if (error) throw error
        
        setShowToolVerifyModal(false)
        setToolToVerify(null)
        setVerifySerialInput('')
        await loadToolHistory(activeJob.id, activeJob.component?.id)
      } catch (err) {
        console.error('Error adding tool:', err)
        alert('Failed to add tool: ' + err.message)
      }
    } else {
      // Serial doesn't match - show mismatch step
      setVerifyStep('mismatch')
    }
  }

  // Confirm adding as a new tool with different serial
  const handleConfirmNewSerial = async () => {
    if (!toolToVerify) return
    
    const newSerial = verifySerialInput.trim()
    
    // Check for serial number conflict before adding
    if (newSerial) {
      const conflict = await checkSerialConflict(newSerial)
      if (conflict) {
        setShowToolVerifyModal(false)
        setToolSerialConflict({ ...conflict, serialNumber: newSerial })
        return
      }
    }
    
    try {
      const { error } = await supabase
        .from('job_tools')
        .insert({
          job_id: activeJob.id,
          tool_name: toolToVerify.tool_name,
          tool_type: toolToVerify.tool_type || null,
          serial_number: newSerial || null,
          added_by: operator.id,
          added_at: new Date().toISOString(),
          notes: `Originally from S/N: ${toolToVerify.serial_number || 'none'}`
        })

      if (error) throw error
      
      setShowToolVerifyModal(false)
      setToolToVerify(null)
      setVerifySerialInput('')
      setVerifyStep('enter')
      await loadToolHistory(activeJob.id, activeJob.component?.id)
    } catch (err) {
      console.error('Error adding tool:', err)
      alert('Failed to add tool: ' + err.message)
    }
  }

  const handleRemoveTool = async (toolId) => {
    try {
      const { error } = await supabase.from('job_tools').delete().eq('id', toolId)
      if (error) throw error
      await loadToolHistory(activeJob.id, activeJob.component?.id)
    } catch (err) {
      console.error('Error removing tool:', err)
      alert('Failed to remove tool: ' + err.message)
    }
  }

  const handleConfirmTooling = async () => {
    setActionLoading(true)
    try {
      // Mark tooling as confirmed but don't start production yet
      const { error } = await supabase
        .from('jobs')
        .update({
          tooling_confirmed: true,
          updated_at: new Date().toISOString()
        })
        .eq('id', activeJob.id)

      if (error) throw error
      setShowToolingModal(false)
      
      // Open materials modal for next step
      await handleOpenMaterials()
      await loadJobs()
    } catch (err) {
      console.error('Error confirming tooling:', err)
      alert('Failed to confirm tooling: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  // ========== MATERIALS ==========
  const handleOpenMaterials = async () => {
    if (!activeJob) return
    setShowMaterialModal(true)
    await loadMaterialTypes()
    await loadBarSizes()
    await loadJobMaterials(activeJob.id)
    // Reset form
    setMaterialForm({
      material_type: '',
      bar_size: '',
      bar_length: '',
      lot_number: '',
      bars_loaded: 0
    })
  }

  const handleAddMaterial = async () => {
    if (!materialForm.material_type) {
      alert('Please select a material type')
      return
    }
    if (!materialForm.bar_size) {
      alert('Please select a bar size')
      return
    }
    if (!materialForm.bars_loaded || materialForm.bars_loaded <= 0) {
      alert('Please enter the number of bars loaded')
      return
    }

    setActionLoading(true)
    try {
      const { error } = await supabase
        .from('job_materials')
        .insert({
          job_id: activeJob.id,
          material_type: materialForm.material_type,
          bar_size: materialForm.bar_size,
          bar_length: materialForm.bar_length ? parseFloat(materialForm.bar_length) : null,
          lot_number: materialForm.lot_number || null,
          bars_loaded: parseInt(materialForm.bars_loaded),
          loaded_by: operator.id,
          loaded_at: new Date().toISOString()
        })

      if (error) throw error
      
      // Reset form and reload
      setMaterialForm({
        material_type: '',
        bar_size: '',
        bar_length: '',
        lot_number: '',
        bars_loaded: 0
      })
      await loadJobMaterials(activeJob.id)
    } catch (err) {
      console.error('Error adding material:', err)
      alert('Failed to add material: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  const handleRemoveMaterial = async (materialId) => {
    try {
      const { error } = await supabase.from('job_materials').delete().eq('id', materialId)
      if (error) throw error
      await loadJobMaterials(activeJob.id)
    } catch (err) {
      console.error('Error removing material:', err)
      alert('Failed to remove material: ' + err.message)
    }
  }

  const handleConfirmMaterials = async () => {
    if (jobMaterials.length === 0) {
      if (!confirm('No materials have been added. Are you sure you want to start production without recording bar stock?')) {
        return
      }
    }

    setActionLoading(true)
    try {
      const { error } = await supabase
        .from('jobs')
        .update({
          status: 'in_progress',
          production_start: new Date().toISOString(),
          material_confirmed: true,
          material_confirmed_at: new Date().toISOString(),
          material_confirmed_by: operator.id,
          updated_at: new Date().toISOString()
        })
        .eq('id', activeJob.id)

      if (error) throw error
      setShowMaterialModal(false)
      await loadJobs()
    } catch (err) {
      console.error('Error confirming materials:', err)
      alert('Failed to start production: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  // Show override modal for skipping materials
  const handleSkipMaterials = () => {
    setShowMaterialOverrideModal(true)
  }

  // Confirm skipping materials after override modal confirmation
  const handleConfirmMaterialOverride = async () => {
    setActionLoading(true)
    try {
      const { error } = await supabase
        .from('jobs')
        .update({
          status: 'in_progress',
          production_start: new Date().toISOString(),
          material_confirmed: false,
          material_override: true,
          material_override_by: operator.id,
          material_override_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', activeJob.id)

      if (error) throw error
      setShowMaterialOverrideModal(false)
      setShowMaterialModal(false)
      await loadJobs()
    } catch (err) {
      console.error('Error skipping materials:', err)
      alert('Failed to start production: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  // ========== TOOLING CHANGE ==========
  const handleConfirmToolChange = async () => {
    if (!toolChangeForm.tool_id) {
      alert('Please select the tool being changed')
      return
    }
    if (!toolChangeForm.new_serial_number.trim()) {
      alert('Please enter the new serial number')
      return
    }
    if (!toolChangeForm.start_time) {
      alert('Please enter the start time')
      return
    }

    setActionLoading(true)
    try {
      // Get the original tool info
      const selectedTool = currentTools.find(t => t.id === toolChangeForm.tool_id)
      if (!selectedTool) throw new Error('Tool not found')

      const previousSerial = selectedTool.serial_number || 'no serial'
      const newSerial = toolChangeForm.new_serial_number.trim()

      // Calculate start and end times from form
      const startTime = new Date(toolChangeForm.start_time)
      const durationMs = ((parseInt(toolChangeForm.duration_hours) || 0) * 60 + (parseInt(toolChangeForm.duration_mins) || 0)) * 60 * 1000
      const endTime = new Date(startTime.getTime() + durationMs)

      // Update the tool with new serial number
      const { error: toolError } = await supabase
        .from('job_tools')
        .update({
          serial_number: newSerial,
          notes: `Changed from ${previousSerial} at ${new Date().toLocaleString()}`
        })
        .eq('id', toolChangeForm.tool_id)

      if (toolError) throw toolError

      // Log the downtime with actual timing
      const { error: downtimeError } = await supabase
        .from('machine_downtime_logs')
        .insert({
          machine_id: machine.id,
          job_id: activeJob.id,
          start_time: startTime.toISOString(),
          end_time: endTime.toISOString(),
          reason: 'Tooling change',
          notes: `Changed ${selectedTool.tool_name}: ${previousSerial} → ${newSerial}`,
          logged_by: operator.id
        })

      if (downtimeError) throw downtimeError

      setShowToolChangeModal(false)
      setToolChangeForm({ 
        tool_id: '', 
        new_serial_number: '',
        start_time: '',
        duration_hours: 0,
        duration_mins: 5
      })
      
      // Refresh current tools display
      const { data: updatedTools } = await supabase
        .from('job_tools')
        .select('*')
        .eq('job_id', activeJob.id)
        .order('added_at')
      setCurrentTools(updatedTools || [])
      
      await buildActivityLog(activeJob)
      alert('Tool changed successfully')
    } catch (err) {
      console.error('Error changing tool:', err)
      alert('Failed to change tool: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  const handleOverrideTooling = async () => {
    if (!confirm('Are you sure you want to skip tooling confirmation? This will be tracked.')) return
    setActionLoading(true)
    try {
      // Mark tooling as overridden but don't start production yet
      const { error } = await supabase
        .from('jobs')
        .update({
          tooling_confirmed: false,
          tooling_override: true,
          tooling_override_by: operator.id,
          tooling_override_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', activeJob.id)

      if (error) throw error
      setShowToolingModal(false)
      
      // Open materials modal for next step
      await handleOpenMaterials()
      await loadJobs()
    } catch (err) {
      console.error('Error overriding tooling:', err)
      alert('Failed to skip tooling: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  // Extend maintenance duration
  const handleExtendDuration = async () => {
    if (!activeJob) return
    
    const totalMinutes = (parseInt(extendDuration.hours) || 0) * 60 + (parseInt(extendDuration.minutes) || 0)
    if (totalMinutes <= 0) {
      alert('Please enter a valid duration to extend')
      return
    }
    
    setActionLoading(true)
    try {
      const currentEnd = new Date(activeJob.scheduled_end)
      const newEnd = new Date(currentEnd.getTime() + totalMinutes * 60 * 1000)
      
      const { error } = await supabase
        .from('jobs')
        .update({
          scheduled_end: newEnd.toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', activeJob.id)
      
      if (error) throw error
      
      await loadJobs()
      setShowExtendModal(false)
      setExtendDuration({ hours: 0, minutes: 30 })
    } catch (err) {
      console.error('Error extending duration:', err)
      alert('Failed to extend duration: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  const handleOpenComplete = () => {
    const now = new Date()
    setCompleteForm({
      actual_end: formatDateTimeLocal(now),
      good_pieces: activeJob?.quantity || 0,
      bad_pieces: 0
    })
    setCompletionStep('form')
    setOngoingDowntimes([])
    setDowntimeEdits({})
    setValidationErrors([])
    setMaintenanceCompletionNotes('') // Reset maintenance notes
    // Initialize material remaining values (default to 0 - all consumed)
    const remaining = {}
    jobMaterials.forEach(m => {
      remaining[m.id] = 0
    })
    setMaterialRemaining(remaining)
    setShowCompleteModal(true)
  }

  // Validate and check for data inconsistencies before completing job
  const handleCompleteJobClick = async () => {
    if (!completeForm.actual_end) {
      alert('Please enter the actual end time')
      return
    }
    const goodPieces = parseInt(completeForm.good_pieces) || 0
    const badPieces = parseInt(completeForm.bad_pieces) || 0

    if (goodPieces + badPieces === 0) {
      alert('Please enter at least one good or bad piece')
      return
    }

    const actualEndTime = new Date(completeForm.actual_end)
    const errors = []

    // Validation 1: Actual end time must be after production start
    if (activeJob.production_start) {
      const productionStart = new Date(activeJob.production_start)
      if (actualEndTime <= productionStart) {
        errors.push('Actual end time must be after production start time')
      }
    }

    // Check for ongoing downtimes
    try {
      const { data: downtimes, error } = await supabase
        .from('machine_downtime_logs')
        .select('*')
        .eq('job_id', activeJob.id)
        .order('start_time', { ascending: true })

      if (error) throw error

      // Find ongoing downtimes (no end_time)
      const ongoing = (downtimes || []).filter(dt => !dt.end_time)
      
      // Validation 2: Check if any downtime end times are after actual end
      const resolvedDowntimes = (downtimes || []).filter(dt => dt.end_time)
      for (const dt of resolvedDowntimes) {
        if (new Date(dt.end_time) > actualEndTime) {
          errors.push(`Downtime "${dt.reason}" ended at ${formatDateTime(dt.end_time)}, which is after your completion time`)
        }
      }

      // If there are ongoing downtimes, show review step
      if (ongoing.length > 0) {
        setOngoingDowntimes(ongoing)
        // Pre-fill end times with the actual end time (using object format)
        const edits = {}
        ongoing.forEach(dt => {
          edits[dt.id] = {
            end_time: formatDateTimeLocal(actualEndTime),
            duration_hours: 0,
            duration_mins: 0,
            use_duration: false
          }
        })
        setDowntimeEdits(edits)
        setValidationErrors(errors)
        setCompletionStep('review_downtimes')
        return
      }

      // If there are validation errors but no ongoing downtimes, show them
      if (errors.length > 0) {
        setValidationErrors(errors)
        alert('Validation errors:\n\n' + errors.join('\n'))
        return
      }

    } catch (err) {
      console.error('Error checking downtimes:', err)
    }

    // No downtime issues - check if there are materials to account for
    if (jobMaterials.length > 0) {
      setCompletionStep('materials')
      return
    }

    // No materials - proceed with normal flow
    // If good pieces < required quantity, ask about sending to scheduling
    if (goodPieces < activeJob.quantity) {
      setCompletionStep('confirm_incomplete')
    } else {
      // Complete normally
      handleCompleteJob(false)
    }
  }

  // Handle materials confirmation and continue
  const handleMaterialsAndContinue = () => {
    // Validate that bars_remaining <= bars_loaded for each material
    for (const material of jobMaterials) {
      const remaining = parseInt(materialRemaining[material.id]) || 0
      if (remaining < 0) {
        alert(`Bars remaining cannot be negative for ${material.material_type}`)
        return
      }
      if (remaining > material.bars_loaded) {
        alert(`Bars remaining (${remaining}) cannot exceed bars loaded (${material.bars_loaded}) for ${material.material_type}`)
        return
      }
    }

    const goodPieces = parseInt(completeForm.good_pieces) || 0
    
    // Proceed with completion check
    if (goodPieces < activeJob.quantity) {
      setCompletionStep('confirm_incomplete')
    } else {
      handleCompleteJob(false)
    }
  }

  // Fix ongoing downtimes and continue with completion
  const handleFixDowntimesAndContinue = async () => {
    setActionLoading(true)
    const actualEndTime = new Date(completeForm.actual_end)
    const errors = []
    const computedEndTimes = {} // Store computed end times for each downtime

    try {
      // Validate all downtime end times
      for (const dt of ongoingDowntimes) {
        const edit = downtimeEdits[dt.id] || {}
        let endDate = null

        if (edit.use_duration) {
          // Calculate end time from duration
          const durationMs = ((parseInt(edit.duration_hours) || 0) * 60 + (parseInt(edit.duration_mins) || 0)) * 60 * 1000
          if (durationMs <= 0) {
            errors.push(`Please enter a duration for "${dt.reason}"`)
            continue
          }
          endDate = new Date(new Date(dt.start_time).getTime() + durationMs)
        } else {
          if (!edit.end_time) {
            errors.push(`Please enter an end time for "${dt.reason}"`)
            continue
          }
          endDate = new Date(edit.end_time)
        }

        const startDate = new Date(dt.start_time)
        
        if (endDate <= startDate) {
          errors.push(`End time for "${dt.reason}" must be after start time`)
        }
        if (endDate > actualEndTime) {
          errors.push(`End time for "${dt.reason}" cannot be after job completion time`)
        }

        computedEndTimes[dt.id] = endDate
      }

      if (errors.length > 0) {
        setValidationErrors(errors)
        setActionLoading(false)
        return
      }

      // Update all ongoing downtimes
      for (const dt of ongoingDowntimes) {
        const { error } = await supabase
          .from('machine_downtime_logs')
          .update({
            end_time: computedEndTimes[dt.id].toISOString()
          })
          .eq('id', dt.id)

        if (error) throw error
      }

      // Clear downtime review state
      setOngoingDowntimes([])
      setDowntimeEdits({})
      setValidationErrors([])

      // Check if there are materials to account for
      if (jobMaterials.length > 0) {
        setCompletionStep('materials')
        setActionLoading(false)
        return
      }

      // Now proceed with completion check
      const goodPieces = parseInt(completeForm.good_pieces) || 0
      
      if (goodPieces < activeJob.quantity) {
        setCompletionStep('confirm_incomplete')
      } else {
        await handleCompleteJob(false)
      }
    } catch (err) {
      console.error('Error fixing downtimes:', err)
      alert('Failed to update downtimes: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  // Send incomplete job back to scheduling
  const handleSendToScheduling = async () => {
    setActionLoading(true)
    try {
      const goodPieces = parseInt(completeForm.good_pieces) || 0
      const badPieces = parseInt(completeForm.bad_pieces) || 0
      const piecesRemaining = activeJob.quantity - goodPieces

      // Save material remaining values for this partial run
      if (jobMaterials.length > 0) {
        for (const material of jobMaterials) {
          const barsRemaining = parseInt(materialRemaining[material.id]) || 0
          const { error: matError } = await supabase
            .from('job_materials')
            .update({
              bars_remaining: barsRemaining,
              completed_by: operator.id,
              completed_at: new Date().toISOString()
            })
            .eq('id', material.id)

          if (matError) {
            console.error('Error updating material:', matError)
          }
        }
      }

      const { error } = await supabase
        .from('jobs')
        .update({
          status: 'incomplete',
          actual_end: new Date(completeForm.actual_end).toISOString(),
          good_pieces: goodPieces,
          bad_pieces: badPieces,
          incomplete_reason: `${piecesRemaining} pieces remaining`,
          incomplete_at: new Date().toISOString(),
          incomplete_by: operator.id,
          assigned_machine_id: null,
          scheduled_start: null,
          scheduled_end: null,
          notes: `Incomplete - ${piecesRemaining} of ${activeJob.quantity} pieces remaining.`,
          updated_at: new Date().toISOString()
        })
        .eq('id', activeJob.id)

      if (error) throw error
      
      resetCompleteModal()
      await loadJobs()
      await loadPreviousJobs()
    } catch (err) {
      console.error('Error sending job to scheduling:', err)
      alert('Failed to send job to scheduling: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  // Reset complete modal state
  const resetCompleteModal = () => {
    setShowCompleteModal(false)
    setCompletionStep('form')
    setCompleteForm({ actual_end: '', good_pieces: 0, bad_pieces: 0 })
    setOngoingDowntimes([])
    setDowntimeEdits({})
    setValidationErrors([])
    setMaterialRemaining({})
  }

  const handleCompleteJob = async (forceComplete = false) => {
    if (!completeForm.actual_end) {
      alert('Please enter the actual end time')
      return
    }
    const goodPieces = parseInt(completeForm.good_pieces) || 0
    const badPieces = parseInt(completeForm.bad_pieces) || 0

    if (goodPieces + badPieces === 0) {
      alert('Please enter at least one good or bad piece')
      return
    }

    setActionLoading(true)
    try {
      let time_per_unit = null
      if (activeJob.production_start) {
        const prodStart = new Date(activeJob.production_start)
        const actualEnd = new Date(completeForm.actual_end)
        const totalMinutes = (actualEnd - prodStart) / (1000 * 60)
        const totalPieces = goodPieces + badPieces
        if (totalPieces > 0 && totalMinutes > 0) {
          time_per_unit = parseFloat((totalMinutes / totalPieces).toFixed(2))
        }
      }

      // Save material remaining values
      if (jobMaterials.length > 0) {
        for (const material of jobMaterials) {
          const barsRemaining = parseInt(materialRemaining[material.id]) || 0
          const { error: matError } = await supabase
            .from('job_materials')
            .update({
              bars_remaining: barsRemaining,
              completed_by: operator.id,
              completed_at: new Date().toISOString()
            })
            .eq('id', material.id)

          if (matError) {
            console.error('Error updating material:', matError)
          }
        }
      }

      const { error } = await supabase
        .from('jobs')
        .update({
          status: 'manufacturing_complete',
          actual_end: new Date(completeForm.actual_end).toISOString(),
          good_pieces: goodPieces,
          bad_pieces: badPieces,
          time_per_unit: time_per_unit,
          checked_out_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', activeJob.id)

      if (error) throw error
      resetCompleteModal()
      await loadJobs()
      await loadPreviousJobs()
    } catch (err) {
      console.error('Error completing job:', err)
      alert('Failed to complete job: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  // ========== DOWNTIME ==========
  // ========== DOWNTIME ==========
  const handleOpenDowntime = () => {
    const now = new Date()
    setDowntimeForm({
      start_time: formatDateTimeLocal(now),
      end_time: '',
      reason: '',
      notes: '',
      send_to_scheduling: false,
      good_pieces: activeJob?.good_pieces || 0,
      bad_pieces: activeJob?.bad_pieces || 0
    })
    setShowDowntimeModal(true)
    loadDowntimeLogs()
  }

  const handleLogDowntime = async () => {
    if (!downtimeForm.reason) {
      alert('Please select a reason for downtime')
      return
    }
    if (!downtimeForm.start_time) {
      alert('Please enter the downtime start time')
      return
    }

    // Calculate end time from duration if using duration mode
    let endTimeIso = null
    if (downtimeForm.use_duration) {
      const durationMs = ((parseInt(downtimeForm.duration_hours) || 0) * 60 + (parseInt(downtimeForm.duration_mins) || 0)) * 60 * 1000
      if (durationMs > 0) {
        endTimeIso = new Date(new Date(downtimeForm.start_time).getTime() + durationMs).toISOString()
      }
    } else if (downtimeForm.end_time) {
      endTimeIso = new Date(downtimeForm.end_time).toISOString()
    }

    // If no end time (ongoing downtime), show warning about flagging machine DOWN
    if (!endTimeIso && !downtimeForm.send_to_scheduling) {
      setPendingDowntimeData({
        machine_id: machine.id,
        job_id: activeJob?.id || null,
        start_time: new Date(downtimeForm.start_time).toISOString(),
        end_time: null,
        reason: downtimeForm.reason,
        notes: downtimeForm.notes || null,
        sent_to_scheduling: false,
        sent_to_scheduling_at: null,
        logged_by: operator.id
      })
      setShowDownWarning(true)
      return
    }

    // Proceed with normal downtime logging
    await submitDowntime(endTimeIso)
  }

  // Actually submit downtime (called directly or after DOWN warning confirmation)
  const submitDowntime = async (endTimeIso, flagDown = false) => {
    setActionLoading(true)
    try {
      // Create downtime log
      const downtimeData = pendingDowntimeData || {
        machine_id: machine.id,
        job_id: activeJob?.id || null,
        start_time: new Date(downtimeForm.start_time).toISOString(),
        end_time: endTimeIso,
        reason: downtimeForm.reason,
        notes: downtimeForm.notes || null,
        sent_to_scheduling: downtimeForm.send_to_scheduling,
        sent_to_scheduling_at: downtimeForm.send_to_scheduling ? new Date().toISOString() : null,
        logged_by: operator.id
      }

      const { data: downtimeRecord, error: downtimeError } = await supabase
        .from('machine_downtime_logs')
        .insert(downtimeData)
        .select()
        .single()

      if (downtimeError) throw downtimeError

      // If flagging machine as DOWN (ongoing downtime confirmed)
      if (flagDown && downtimeRecord) {
        const { error: machineError } = await supabase
          .from('machines')
          .update({
            status: 'down',
            status_reason: downtimeForm.reason + (downtimeForm.notes ? `: ${downtimeForm.notes}` : ''),
            status_updated_at: new Date().toISOString(),
            status_updated_by: operator.id
          })
          .eq('id', machine.id)

        if (machineError) {
          console.error('Error updating machine status:', machineError)
        } else {
          // Update local machine state
          setMachine(prev => ({
            ...prev,
            status: 'down',
            status_reason: downtimeForm.reason + (downtimeForm.notes ? `: ${downtimeForm.notes}` : '')
          }))
        }
      }

      // If sending to scheduling, mark job as incomplete
      if (downtimeForm.send_to_scheduling && activeJob) {
        const goodPieces = parseInt(downtimeForm.good_pieces) || 0
        const badPieces = parseInt(downtimeForm.bad_pieces) || 0
        const piecesRemaining = activeJob.quantity - goodPieces

        const { error: jobError } = await supabase
          .from('jobs')
          .update({
            status: 'incomplete',
            good_pieces: goodPieces,
            bad_pieces: badPieces,
            incomplete_reason: downtimeForm.reason + (downtimeForm.notes ? `: ${downtimeForm.notes}` : ''),
            incomplete_at: new Date().toISOString(),
            incomplete_by: operator.id,
            actual_end: new Date(downtimeForm.start_time).toISOString(),
            notes: `Incomplete - ${piecesRemaining} pieces remaining. ${downtimeForm.notes || ''}`.trim(),
            updated_at: new Date().toISOString()
          })
          .eq('id', activeJob.id)

        if (jobError) throw jobError
      }

      setShowDowntimeModal(false)
      setDowntimeForm({
        start_time: '', end_time: '', reason: '', notes: '',
        duration_hours: 0, duration_mins: 0, use_duration: false,
        send_to_scheduling: false, good_pieces: 0, bad_pieces: 0
      })
      await loadJobs()
      
      // Refresh activity log if we still have an active job
      if (activeJob && !downtimeForm.send_to_scheduling) {
        await buildActivityLog(activeJob)
      }
      
      if (downtimeForm.send_to_scheduling) {
        alert('Job has been sent back to scheduling.')
      }
    } catch (err) {
      console.error('Error logging downtime:', err)
      alert('Failed to log downtime: ' + err.message)
    } finally {
      setActionLoading(false)
      setPendingDowntimeData(null)
      setShowDownWarning(false)
    }
  }

  // Handle DOWN warning confirmation
  const handleConfirmDown = async () => {
    await submitDowntime(null, true) // null end time, flag as DOWN
  }

  // Handle DOWN warning cancellation (just log without flagging)
  const handleCancelDown = () => {
    setShowDownWarning(false)
    setPendingDowntimeData(null)
  }

  // ========== ADMIN EDIT ==========
  const handleEditJob = (job) => {
    setEditingJob(job)
    setEditForm({
      good_pieces: job.good_pieces || 0,
      bad_pieces: job.bad_pieces || 0,
      setup_start: job.setup_start ? formatDateTimeLocal(job.setup_start) : '',
      production_start: job.production_start ? formatDateTimeLocal(job.production_start) : '',
      actual_end: job.actual_end ? formatDateTimeLocal(job.actual_end) : '',
      notes: job.notes || ''
    })
  }

  const handleSaveEdit = async () => {
    if (!editingJob) return
    setSaving(true)
    try {
      let time_per_unit = null
      if (editForm.production_start && editForm.actual_end && (editForm.good_pieces > 0 || editForm.bad_pieces > 0)) {
        const prodStart = new Date(editForm.production_start)
        const actualEnd = new Date(editForm.actual_end)
        const totalMinutes = (actualEnd - prodStart) / (1000 * 60)
        const totalPieces = (parseInt(editForm.good_pieces) || 0) + (parseInt(editForm.bad_pieces) || 0)
        if (totalPieces > 0) time_per_unit = parseFloat((totalMinutes / totalPieces).toFixed(2))
      }

      const { error } = await supabase
        .from('jobs')
        .update({
          good_pieces: parseInt(editForm.good_pieces) || 0,
          bad_pieces: parseInt(editForm.bad_pieces) || 0,
          setup_start: editForm.setup_start ? new Date(editForm.setup_start).toISOString() : null,
          production_start: editForm.production_start ? new Date(editForm.production_start).toISOString() : null,
          actual_end: editForm.actual_end ? new Date(editForm.actual_end).toISOString() : null,
          notes: editForm.notes,
          time_per_unit: time_per_unit,
          updated_at: new Date().toISOString()
        })
        .eq('id', editingJob.id)

      if (error) throw error
      await loadJobHistory()
      setEditingJob(null)
      setEditForm({})
    } catch (err) {
      console.error('Error saving job:', err)
      alert('Failed to save changes: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  // ========== FORMATTERS ==========
  const formatTime = (timestamp) => {
    if (!timestamp) return '--:--'
    return new Date(timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
  }

  const formatDate = (date) => {
    if (!date) return '--'
    return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  const formatDateTime = (timestamp) => {
    if (!timestamp) return '--'
    return new Date(timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
  }

  const formatDateTimeLocal = (date) => {
    const d = date instanceof Date ? date : new Date(date)
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hours = String(d.getHours()).padStart(2, '0')
    const minutes = String(d.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day}T${hours}:${minutes}`
  }

  const formatDuration = (start, end) => {
    if (!start || !end) return '--'
    const ms = new Date(end) - new Date(start)
    const mins = Math.round(ms / 60000)
    if (mins < 60) return `${mins}m`
    const hrs = Math.floor(mins / 60)
    const remainMins = mins % 60
    return `${hrs}h ${remainMins}m`
  }

  // Check if a job is a maintenance order
  const isMaintenance = (job) => {
    return job?.is_maintenance || job?.work_order?.order_type === 'maintenance'
  }
  
  // Get maintenance type color
  const getMaintenanceColor = (job) => {
    const type = job?.work_order?.maintenance_type
    if (type === 'unplanned') {
      return { bg: 'bg-purple-600', border: 'border-purple-500', text: 'text-purple-400', bgLight: 'bg-purple-900/30' }
    }
    return { bg: 'bg-blue-600', border: 'border-blue-500', text: 'text-blue-400', bgLight: 'bg-blue-900/30' }
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

  const getStatusBadge = (status) => {
    switch (status) {
      case 'assigned': return <span className="px-2 py-1 text-xs font-medium bg-blue-500/20 text-blue-400 rounded">Queued</span>
      case 'in_setup': return <span className="px-2 py-1 text-xs font-medium bg-yellow-500/20 text-yellow-400 rounded flex items-center gap-1"><Wrench size={12} /> Setup</span>
      case 'in_progress': return <span className="px-2 py-1 text-xs font-medium bg-green-500/20 text-green-400 rounded flex items-center gap-1"><Play size={12} /> Running</span>
      case 'manufacturing_complete': return <span className="px-2 py-1 text-xs font-medium bg-purple-500/20 text-purple-400 rounded">Mfg Complete</span>
      case 'complete': return <span className="px-2 py-1 text-xs font-medium bg-green-500/20 text-green-400 rounded">Complete</span>
      case 'incomplete': return <span className="px-2 py-1 text-xs font-medium bg-red-500/20 text-red-400 rounded">Incomplete</span>
      default: return <span className="px-2 py-1 text-xs font-medium bg-gray-500/20 text-gray-400 rounded">{status}</span>
    }
  }

  const getRoleBadge = () => {
    if (isAdmin) return <span className="flex items-center gap-1 px-2 py-1 bg-purple-500/20 text-purple-400 text-xs rounded"><Shield size={12} /> Admin</span>
    if (isViewOnly) return <span className="flex items-center gap-1 px-2 py-1 bg-gray-500/20 text-gray-400 text-xs rounded"><Eye size={12} /> View Only</span>
    return null
  }

  // ========== RENDER: Loading ==========
  if (machineLoading) {
    return (
      <div className="min-h-screen bg-skynet-dark flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-12 h-12 text-skynet-accent animate-spin mx-auto mb-4" />
          <p className="text-gray-400 font-mono">Loading machine...</p>
        </div>
      </div>
    )
  }

  // ========== RENDER: Machine Error ==========
  if (machineError) {
    return (
      <div className="min-h-screen bg-skynet-dark flex items-center justify-center p-4">
        <div className="bg-gray-900 border border-red-800 rounded-lg p-8 max-w-md w-full text-center">
          <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white mb-2">Machine Not Found</h1>
          <p className="text-gray-400 mb-6">{machineError}</p>
        </div>
      </div>
    )
  }

  // ========== RENDER: PIN Login ==========
  if (!operator) {
    return (
      <div className="min-h-screen bg-skynet-dark flex flex-col">
        <header className="bg-gray-900 border-b border-gray-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-2xl font-bold text-white">SkyNet</span>
              <div className="w-2 h-2 bg-skynet-green rounded-full animate-pulse"></div>
            </div>
            <div className="text-right">
              <p className="text-white font-semibold">{machine.name}</p>
              <p className="text-gray-500 text-sm">{machine.location?.name}</p>
            </div>
          </div>
        </header>

        <div className="flex-1 flex items-center justify-center p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 w-full max-w-sm">
            <div className="text-center mb-6">
              <Lock className="w-12 h-12 text-skynet-accent mx-auto mb-3" />
              <h2 className="text-xl font-semibold text-white">Operator Login</h2>
              <p className="text-gray-500 text-sm mt-1">Enter your PIN to continue</p>
            </div>

            <div className="flex justify-center gap-2 mb-6">
              {[...Array(6)].map((_, i) => (
                <div key={i} className={`w-10 h-12 rounded-lg border-2 flex items-center justify-center text-2xl font-bold transition-colors ${i < pin.length ? 'border-skynet-accent bg-skynet-accent/20 text-white' : 'border-gray-700 bg-gray-800 text-gray-600'}`}>
                  {i < pin.length ? '•' : ''}
                </div>
              ))}
            </div>

            {authError && (
              <div className="flex items-center gap-2 text-red-400 text-sm mb-4 justify-center">
                <AlertCircle size={16} />{authError}
              </div>
            )}

            <div className="grid grid-cols-3 gap-2 mb-4">
              {[1,2,3,4,5,6,7,8,9].map((digit) => (
                <button key={digit} onClick={() => handlePinInput(digit.toString())} className="h-14 bg-gray-800 hover:bg-gray-700 text-white text-xl font-semibold rounded-lg transition-colors active:scale-95">{digit}</button>
              ))}
              <button onClick={handlePinClear} className="h-14 bg-gray-800 hover:bg-gray-700 text-gray-400 text-sm font-medium rounded-lg transition-colors">Clear</button>
              <button onClick={() => handlePinInput('0')} className="h-14 bg-gray-800 hover:bg-gray-700 text-white text-xl font-semibold rounded-lg transition-colors active:scale-95">0</button>
              <button onClick={handlePinBackspace} className="h-14 bg-gray-800 hover:bg-gray-700 text-gray-400 text-sm font-medium rounded-lg transition-colors">←</button>
            </div>

            <button onClick={handlePinSubmit} disabled={pin.length < 4 || authenticating} className="w-full h-12 bg-skynet-accent hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2">
              {authenticating ? <><Loader2 className="w-5 h-5 animate-spin" />Verifying...</> : <><Unlock size={20} />Login</>}
            </button>
          </div>
        </div>

        <footer className="bg-gray-900 border-t border-gray-800 px-6 py-3">
          <p className="text-gray-600 text-xs text-center font-mono">SkyNet MES - Machine Kiosk</p>
        </footer>
      </div>
    )
  }

  // ========== RENDER: Main Kiosk ==========
  return (
    <div className="min-h-screen bg-skynet-dark flex flex-col">
      {/* Header */}
      <header className="bg-gray-900 border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <span className="text-2xl font-bold text-white">SkyNet</span>
              <div className="w-2 h-2 bg-skynet-green rounded-full animate-pulse"></div>
            </div>
            <span className="text-gray-600">|</span>
            <div>
              <div className="flex items-center gap-2">
                <p className="text-white font-semibold">{machine.name}</p>
                {machine.status === 'down' && (
                  <span className="px-2 py-0.5 bg-red-600 text-white text-xs font-bold rounded animate-pulse">
                    DOWN
                  </span>
                )}
              </div>
              <p className="text-gray-500 text-xs">{machine.location?.name}</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            {isAdmin && (
              <button onClick={() => { setShowJobHistory(!showJobHistory); if (!showJobHistory && jobHistory.length === 0) loadJobHistory() }} className={`flex items-center gap-2 px-4 py-2 rounded transition-colors ${showJobHistory ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}>
                <History size={18} /><span className="text-sm">Job History</span>
              </button>
            )}
            <div className="flex items-center gap-2">
              {getRoleBadge()}
              <div className="text-right">
                <p className="text-white text-sm">{operator.full_name}</p>
                <p className="text-gray-500 text-xs capitalize">{operator.role}</p>
              </div>
            </div>
            <button onClick={handleLogout} className="flex items-center gap-2 px-4 py-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors">
              <LogOut size={18} /><span className="text-sm">Logout</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 p-6 overflow-auto">
        {/* Admin Job History Panel */}
        {isAdmin && showJobHistory && (
          <div className="mb-6 bg-gray-900 border border-purple-800 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2"><History className="text-purple-400" size={20} />Job History (Admin Edit)</h2>
              <button onClick={() => setShowJobHistory(false)} className="text-gray-400 hover:text-white"><X size={20} /></button>
            </div>
            {historyLoading ? (
              <div className="p-8 text-center"><Loader2 className="w-8 h-8 text-purple-400 animate-spin mx-auto" /></div>
            ) : jobHistory.length === 0 ? (
              <div className="p-8 text-center text-gray-500">No completed jobs found</div>
            ) : (
              <div className="divide-y divide-gray-800 max-h-96 overflow-y-auto">
                {jobHistory.map((job) => (
                  <div key={job.id} className="p-4">
                    {editingJob?.id === job.id ? (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <span className="text-white font-mono">{job.job_number}</span>
                          <div className="flex gap-2">
                            <button onClick={() => setEditingJob(null)} className="px-3 py-1 text-gray-400 hover:text-white text-sm">Cancel</button>
                            <button onClick={handleSaveEdit} disabled={saving} className="px-3 py-1 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded flex items-center gap-1">
                              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
                            </button>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                          <div><label className="block text-gray-500 text-xs mb-1">Good Pieces</label><input type="number" value={editForm.good_pieces} onChange={(e) => setEditForm({...editForm, good_pieces: e.target.value})} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm" /></div>
                          <div><label className="block text-gray-500 text-xs mb-1">Bad Pieces</label><input type="number" value={editForm.bad_pieces} onChange={(e) => setEditForm({...editForm, bad_pieces: e.target.value})} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm" /></div>
                          <div><label className="block text-gray-500 text-xs mb-1">Setup Start</label><input type="datetime-local" value={editForm.setup_start} onChange={(e) => setEditForm({...editForm, setup_start: e.target.value})} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm" /></div>
                          <div><label className="block text-gray-500 text-xs mb-1">Production Start</label><input type="datetime-local" value={editForm.production_start} onChange={(e) => setEditForm({...editForm, production_start: e.target.value})} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm" /></div>
                          <div><label className="block text-gray-500 text-xs mb-1">Actual End</label><input type="datetime-local" value={editForm.actual_end} onChange={(e) => setEditForm({...editForm, actual_end: e.target.value})} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm" /></div>
                          <div className="md:col-span-3"><label className="block text-gray-500 text-xs mb-1">Notes</label><input type="text" value={editForm.notes} onChange={(e) => setEditForm({...editForm, notes: e.target.value})} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm" /></div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <div className={`w-2 h-2 rounded-full ${getPriorityColor(job.priority)}`}></div>
                          <div>
                            <div className="flex items-center gap-2"><span className="text-white font-mono">{job.job_number}</span>{getStatusBadge(job.status)}</div>
                            <p className="text-gray-500 text-sm">{job.component?.part_number} • {job.work_order?.wo_number}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="text-right text-sm">
                            <p className="text-gray-400">Good: <span className="text-green-400">{job.good_pieces || 0}</span> / Bad: <span className="text-red-400">{job.bad_pieces || 0}</span></p>
                            <p className="text-gray-500 text-xs">{formatDateTime(job.actual_end)}</p>
                          </div>
                          <button onClick={() => handleEditJob(job)} className="px-3 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white text-sm rounded transition-colors">Edit</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {isViewOnly && (
          <div className="mb-4 px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg flex items-center gap-3">
            <Eye className="text-gray-400" size={20} />
            <p className="text-gray-400 text-sm">You are viewing in <strong>read-only mode</strong>. Job operations are disabled.</p>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Active Job Panel */}
          <div className="lg:col-span-2">
            <div className={`bg-gray-900 border rounded-lg overflow-hidden ${
              activeJob && isMaintenance(activeJob)
                ? activeJob.work_order?.maintenance_type === 'unplanned'
                  ? 'border-purple-700'
                  : 'border-blue-700'
                : 'border-gray-800'
            }`}>
              <div className={`px-4 py-3 border-b flex items-center justify-between ${
                activeJob && isMaintenance(activeJob)
                  ? activeJob.work_order?.maintenance_type === 'unplanned'
                    ? 'border-purple-700 bg-purple-900/20'
                    : 'border-blue-700 bg-blue-900/20'
                  : 'border-gray-800'
              }`}>
                <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                  {activeJob ? (
                    isMaintenance(activeJob) ? (
                      <>
                        <Wrench className={activeJob.work_order?.maintenance_type === 'unplanned' ? 'text-purple-500' : 'text-blue-500'} size={20} />
                        Active Downtime
                      </>
                    ) : (
                      <><Play className="text-green-500" size={20} /> Active Job</>
                    )
                  ) : (
                    <><Clock className="text-gray-500" size={20} /> No Active Job</>
                  )}
                </h2>
                {activeJob && (
                  isMaintenance(activeJob) ? (
                    <span className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${
                      activeJob.work_order?.maintenance_type === 'unplanned'
                        ? 'bg-purple-900/50 text-purple-400'
                        : 'bg-blue-900/50 text-blue-400'
                    }`}>
                      {activeJob.work_order?.maintenance_type === 'unplanned' ? '⚠ Unplanned' : '🔧 Planned'}
                    </span>
                  ) : (
                    getStatusBadge(activeJob.status)
                  )
                )}
              </div>

              {activeJob ? (
                isMaintenance(activeJob) ? (
                  /* Maintenance Order Active Panel */
                  <div className="p-6">
                    <div className="flex items-start justify-between mb-6">
                      <div>
                        <div className="flex items-center gap-3 mb-1">
                          <Wrench className={activeJob.work_order?.maintenance_type === 'unplanned' ? 'text-purple-400' : 'text-blue-400'} size={24} />
                          <span className={`text-2xl font-bold font-mono ${
                            activeJob.work_order?.maintenance_type === 'unplanned' ? 'text-purple-400' : 'text-blue-400'
                          }`}>{activeJob.job_number}</span>
                        </div>
                        <p className="text-gray-400">{activeJob.work_order?.wo_number}</p>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm ${activeJob.work_order?.maintenance_type === 'unplanned' ? 'text-purple-400' : 'text-blue-400'}`}>
                          {activeJob.work_order?.maintenance_type === 'unplanned' ? 'Machine Down' : 'Scheduled Maintenance'}
                        </p>
                        <p className="text-white font-medium">{machine?.name}</p>
                      </div>
                    </div>

                    {/* Maintenance Description */}
                    <div className={`rounded-lg p-4 mb-6 ${
                      activeJob.work_order?.maintenance_type === 'unplanned'
                        ? 'bg-purple-900/20 border border-purple-800'
                        : 'bg-blue-900/20 border border-blue-800'
                    }`}>
                      <h3 className="text-gray-400 text-sm font-medium mb-2">Description</h3>
                      <p className="text-white">
                        {activeJob.work_order?.notes || activeJob.notes || 'No description provided'}
                      </p>
                    </div>

                    {/* Time Boxes for Maintenance */}
                    <div className="grid grid-cols-2 gap-4 mb-6">
                      <div className={`rounded-lg p-3 text-center ${
                        activeJob.work_order?.maintenance_type === 'unplanned'
                          ? 'bg-purple-900/30'
                          : 'bg-blue-900/30'
                      }`}>
                        <p className="text-gray-500 text-xs mb-1">Downtime Started</p>
                        <p className="text-white font-mono">{formatTime(activeJob.production_start || activeJob.setup_start)}</p>
                      </div>
                      <div className={`rounded-lg p-3 text-center ${
                        activeJob.work_order?.maintenance_type === 'unplanned'
                          ? 'bg-purple-900/30'
                          : 'bg-blue-900/30'
                      }`}>
                        <p className="text-gray-500 text-xs mb-1">Estimated End</p>
                        <p className="text-white font-mono">{formatTime(activeJob.scheduled_end)}</p>
                      </div>
                    </div>

                    {/* Maintenance Action Buttons */}
                    {canOperate && (
                      <div className="flex gap-3">
                        <button 
                          onClick={handleOpenComplete} 
                          disabled={actionLoading} 
                          className={`flex-1 py-3 font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 ${
                            activeJob.work_order?.maintenance_type === 'unplanned'
                              ? 'bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 text-white'
                              : 'bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white'
                          }`}
                        >
                          <CheckCircle size={20} />Complete Downtime
                        </button>
                        <button 
                          onClick={() => {
                            setExtendDuration({ hours: 0, minutes: 30 })
                            setShowExtendModal(true)
                          }}
                          className="px-4 py-3 bg-gray-700 hover:bg-gray-600 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
                        >
                          <Clock size={20} />Extend
                        </button>
                      </div>
                    )}

                    {/* Activity Log for Maintenance */}
                    {jobActivities.length > 0 && (
                      <div className="mt-6 pt-6 border-t border-gray-700">
                        <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                          <History size={16} />
                          Activity Log
                        </h3>
                        <div className="space-y-3">
                          {jobActivities.map((activity, index) => (
                            <div key={index} className="flex items-start gap-3">
                              <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                                activeJob.work_order?.maintenance_type === 'unplanned'
                                  ? 'bg-purple-900/50 text-purple-400'
                                  : 'bg-blue-900/50 text-blue-400'
                              }`}>
                                {activity.icon === 'wrench' && <Wrench size={14} />}
                                {activity.icon === 'play' && <Play size={14} />}
                                {activity.icon === 'pause' && <PauseCircle size={14} />}
                                {activity.icon === 'check' && <CheckCircle size={14} />}
                                {activity.icon === 'send' && <SendHorizontal size={14} />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between">
                                  <p className="text-white text-sm">{activity.label}</p>
                                  {activity.duration && (
                                    <span className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-500">
                                      {activity.duration}
                                    </span>
                                  )}
                                </div>
                                {activity.sublabel && (
                                  <p className="text-gray-500 text-xs truncate">{activity.sublabel}</p>
                                )}
                                <p className="text-gray-600 text-xs mt-0.5">{formatDateTime(activity.timestamp)}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  /* Regular Job Active Panel */
                  <div className="p-6">
                  <div className="flex items-start justify-between mb-6">
                    <div>
                      <div className="flex items-center gap-3 mb-1">
                        <span className={`w-3 h-3 rounded-full ${getPriorityColor(activeJob.priority)}`}></span>
                        <span className="text-2xl font-bold text-white font-mono">{activeJob.job_number}</span>
                      </div>
                      <p className="text-gray-400">{activeJob.work_order?.wo_number} • {activeJob.work_order?.customer}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-gray-500">Due</p>
                      <p className="text-white font-medium">{formatDate(activeJob.work_order?.due_date)}</p>
                    </div>
                  </div>

                  <div className="bg-gray-800 rounded-lg p-4 mb-6">
                    <div className="flex items-center gap-3 mb-2">
                      <Package className="text-skynet-accent" size={20} />
                      <span className="text-skynet-accent font-mono text-lg">{activeJob.component?.part_number}</span>
                    </div>
                    <p className="text-gray-400 text-sm ml-8">{activeJob.component?.description}</p>
                    <div className="flex items-center gap-6 mt-3 ml-8">
                      <span className="text-gray-500 text-sm">Quantity: <span className="text-white">{activeJob.quantity}</span></span>
                      <span className="text-gray-500 text-sm">Scheduled: <span className="text-white">{formatTime(activeJob.scheduled_start)}</span></span>
                    </div>
                  </div>

                  {/* Tooling Display - Always show */}
                  <div className="bg-gray-800/50 rounded-lg p-4 mb-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-gray-400 text-sm font-medium flex items-center gap-2">
                        <Wrench size={16} />
                        Tooling {currentTools.length > 0 ? `(${currentTools.length})` : ''}
                      </h3>
                      <div className="flex items-center gap-2">
                        {canOperate && activeJob.status === 'in_setup' && (
                          <button 
                            onClick={handleOpenTooling}
                            className="text-xs text-skynet-accent hover:text-blue-400 flex items-center gap-1"
                          >
                            <Plus size={12} />{currentTools.length > 0 ? 'Add More' : 'Add Tooling'}
                          </button>
                        )}
                        {canOperate && activeJob.status === 'in_progress' && currentTools.length > 0 && (
                          <button 
                            onClick={() => {
                              setToolChangeForm({ 
                                tool_id: '', 
                                new_serial_number: '',
                                start_time: formatDateTimeLocal(new Date()),
                                duration_hours: 0,
                                duration_mins: 5
                              })
                              setShowToolChangeModal(true)
                            }}
                            className="text-xs text-yellow-400 hover:text-yellow-300 flex items-center gap-1"
                          >
                            <Edit3 size={12} />Change Tool
                          </button>
                        )}
                      </div>
                    </div>
                    {currentTools.length > 0 ? (
                      <div className="space-y-1.5">
                        {currentTools.map(tool => (
                          <div key={tool.id} className="flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2">
                              <span className="text-white">{tool.tool_name}</span>
                              {tool.tool_type && (
                                <>
                                  <span className="text-gray-500">•</span>
                                  <span className="text-gray-400">{tool.tool_type}</span>
                                </>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              {tool.serial_number && (
                                <span className="text-gray-500 text-xs font-mono">S/N: {tool.serial_number}</span>
                              )}
                              {tool.changed_at && (
                                <span className="text-yellow-500 text-xs">Changed</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-gray-500 text-sm italic">No tooling recorded</p>
                    )}
                  </div>

                  {/* Materials Loaded Display - Always show */}
                  <div className="bg-gray-800/50 rounded-lg p-4 mb-6">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-gray-400 text-sm font-medium flex items-center gap-2">
                        <Layers size={16} />
                        Materials {jobMaterials.length > 0 ? `(${jobMaterials.length})` : ''}
                      </h3>
                      {canOperate && activeJob.status === 'in_progress' && (
                        <button 
                          onClick={handleOpenMaterials}
                          className="text-xs text-skynet-accent hover:text-blue-400 flex items-center gap-1"
                        >
                          <Plus size={12} />{jobMaterials.length > 0 ? 'Add More' : 'Add Material'}
                        </button>
                      )}
                    </div>
                    {jobMaterials.length > 0 ? (
                      <div className="space-y-2">
                        {jobMaterials.map(material => (
                          <div key={material.id} className="flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2">
                              <span className="text-white">{material.material_type}</span>
                              <span className="text-gray-500">•</span>
                              <span className="text-gray-400">{material.bar_size}</span>
                              {material.bar_length && (
                                <>
                                  <span className="text-gray-500">•</span>
                                  <span className="text-gray-500">{material.bar_length}"</span>
                                </>
                              )}
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="text-blue-400">{material.bars_loaded} bars</span>
                              {material.lot_number && (
                                <span className="text-gray-600 text-xs">Lot: {material.lot_number}</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-gray-500 text-sm italic">No materials loaded</p>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-4 mb-6">
                    <div className="bg-gray-800 rounded-lg p-3 text-center">
                      <p className="text-gray-500 text-xs mb-1">Setup Start</p>
                      <p className="text-white font-mono">{formatTime(activeJob.setup_start)}</p>
                    </div>
                    <div className="bg-gray-800 rounded-lg p-3 text-center">
                      <p className="text-gray-500 text-xs mb-1">Production Start</p>
                      <p className="text-white font-mono">{formatTime(activeJob.production_start)}</p>
                    </div>
                    <div className="bg-gray-800 rounded-lg p-3 text-center">
                      <p className="text-gray-500 text-xs mb-1">Scheduled End</p>
                      <p className="text-white font-mono">{formatTime(activeJob.scheduled_end)}</p>
                    </div>
                  </div>

                  {canOperate && (
                    <div className="flex gap-3">
                      {activeJob.status === 'in_setup' && (
                        <button onClick={handleOpenTooling} disabled={actionLoading} className="flex-1 py-3 bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2">
                          <Wrench size={20} />Confirm Tooling
                        </button>
                      )}
                      {activeJob.status === 'in_progress' && (
                        <button onClick={handleOpenComplete} disabled={actionLoading} className="flex-1 py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2">
                          <CheckCircle size={20} />Complete Job
                        </button>
                      )}
                      <button onClick={handleOpenDowntime} className="px-4 py-3 bg-red-600/20 hover:bg-red-600/30 text-red-400 font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 border border-red-600/50">
                        <AlertTriangle size={20} />Log Downtime
                      </button>
                    </div>
                  )}

                  {/* Activity Log */}
                  {jobActivities.length > 0 && (
                    <div className="mt-6 pt-6 border-t border-gray-700">
                      <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                        <History size={16} />
                        Activity Log
                      </h3>
                      <div className="space-y-3">
                        {jobActivities.map((activity, index) => (
                          <div 
                            key={index} 
                            className={`flex items-start gap-3 ${
                              activity.type === 'downtime' && canOperate ? 'cursor-pointer hover:bg-gray-800/50 -mx-2 px-2 py-1 rounded-lg transition-colors' : ''
                            }`}
                            onClick={() => activity.type === 'downtime' && canOperate && handleEditDowntimeClick(activity)}
                          >
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                              activity.color === 'green' ? 'bg-green-900/50 text-green-400' :
                              activity.color === 'yellow' ? 'bg-yellow-900/50 text-yellow-400' :
                              activity.color === 'red' ? 'bg-red-900/50 text-red-400' :
                              activity.color === 'orange' ? 'bg-orange-900/50 text-orange-400' :
                              'bg-gray-800 text-gray-400'
                            }`}>
                              {activity.icon === 'wrench' && <Wrench size={14} />}
                              {activity.icon === 'play' && <Play size={14} />}
                              {activity.icon === 'pause' && <PauseCircle size={14} />}
                              {activity.icon === 'check' && <CheckCircle size={14} />}
                              {activity.icon === 'send' && <SendHorizontal size={14} />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <p className="text-white text-sm">{activity.label}</p>
                                  {activity.type === 'downtime' && canOperate && (
                                    <Edit3 size={12} className="text-gray-500" />
                                  )}
                                </div>
                                {activity.duration && (
                                  <span className={`text-xs px-2 py-0.5 rounded ${
                                    activity.isOngoing ? 'bg-red-900/50 text-red-400' : 'bg-gray-800 text-gray-500'
                                  }`}>
                                    {activity.duration}
                                  </span>
                                )}
                              </div>
                              {activity.sublabel && (
                                <p className="text-gray-500 text-xs truncate">{activity.sublabel}</p>
                              )}
                              <p className="text-gray-600 text-xs mt-0.5">
                                {formatDateTime(activity.timestamp)}
                                {activity.endTime && (
                                  <span className="text-gray-500"> → {formatTime(activity.endTime)}</span>
                                )}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                )
              ) : orphanedDowntimes.length > 0 ? (
                /* Machine DOWN due to orphaned downtime */
                <div className="p-8">
                  <div className="bg-red-900/30 border border-red-700 rounded-lg p-6 text-center">
                    <AlertTriangle className="w-16 h-16 text-red-500 mx-auto mb-4 animate-pulse" />
                    <h3 className="text-red-400 text-xl font-bold mb-2">Machine is DOWN</h3>
                    <p className="text-gray-400 mb-4">
                      {orphanedDowntimes.length === 1 
                        ? 'There is an unresolved downtime event preventing new jobs from starting.'
                        : `There are ${orphanedDowntimes.length} unresolved downtime events.`}
                    </p>
                    
                    {/* Show downtime details */}
                    <div className="bg-gray-900/50 rounded-lg p-4 mb-4 text-left">
                      {orphanedDowntimes.slice(0, 3).map((dt, idx) => (
                        <div key={dt.id} className={`${idx > 0 ? 'mt-3 pt-3 border-t border-gray-700' : ''}`}>
                          <div className="flex items-center justify-between">
                            <span className="text-red-400 font-medium">{dt.reason}</span>
                            <span className="text-gray-500 text-sm">{formatDateTime(dt.start_time)}</span>
                          </div>
                          {dt.notes && <p className="text-gray-500 text-sm mt-1">{dt.notes}</p>}
                        </div>
                      ))}
                      {orphanedDowntimes.length > 3 && (
                        <p className="text-gray-500 text-sm mt-3 pt-3 border-t border-gray-700">
                          ...and {orphanedDowntimes.length - 3} more
                        </p>
                      )}
                    </div>

                    {canOperate && (
                      <button
                        onClick={() => setShowMachineReadyModal(true)}
                        className="px-6 py-3 bg-green-600 hover:bg-green-500 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 mx-auto"
                      >
                        <CheckCircle size={20} />
                        Machine Ready
                      </button>
                    )}
                    {isViewOnly && (
                      <p className="text-gray-500 text-sm mt-4">Waiting for operator to clear downtime status</p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="p-12 text-center">
                  <Clock className="w-16 h-16 text-gray-700 mx-auto mb-4" />
                  <p className="text-gray-500 text-lg">No job currently in progress</p>
                  <p className="text-gray-600 text-sm mt-2">{isViewOnly ? 'Waiting for operator to start a job' : 'Select a job from the queue to start setup'}</p>
                </div>
              )}
            </div>
          </div>

          {/* Job Queue Panel */}
          <div className="lg:col-span-1">
            <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-800">
                <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                  <FileText size={20} className="text-gray-500" />Job Queue
                  <span className="ml-auto text-sm text-gray-500">{jobs.filter(j => j.status === 'assigned').length} waiting</span>
                </h2>
              </div>

              <div className="divide-y divide-gray-800 max-h-[600px] overflow-y-auto">
                {jobsLoading ? (
                  <div className="p-8 text-center"><Loader2 className="w-8 h-8 text-skynet-accent animate-spin mx-auto" /></div>
                ) : jobs.length === 0 ? (
                  <div className="p-8 text-center"><p className="text-gray-500">No jobs scheduled</p></div>
                ) : (
                  jobs.map((job, index) => {
                    // Check if this is the first assigned (queued) job
                    const queuedJobs = jobs.filter(j => j.status === 'assigned')
                    const isFirstInQueue = queuedJobs.length > 0 && queuedJobs[0].id === job.id
                    const jobIsMaintenance = isMaintenance(job)
                    const maintColors = jobIsMaintenance ? getMaintenanceColor(job) : null
                    
                    return (
                    <button
                      key={job.id}
                      onClick={() => handleJobSelect(job)}
                      disabled={isViewOnly || (activeJob && job.id !== activeJob.id)}
                      className={`w-full p-4 text-left transition-colors ${
                        activeJob?.id === job.id 
                          ? jobIsMaintenance 
                            ? `${maintColors.bgLight} border-l-4 ${maintColors.border}`
                            : 'bg-skynet-accent/10 border-l-4 border-skynet-accent' 
                        : selectedJob?.id === job.id 
                          ? jobIsMaintenance
                            ? `${maintColors.bgLight} border-l-4 ${maintColors.border}`
                            : 'bg-gray-800 border-l-4 border-yellow-500'
                        : (activeJob || isViewOnly) ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-800 cursor-pointer'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          {jobIsMaintenance ? (
                            <Wrench size={14} className={maintColors.text} />
                          ) : (
                            <span className={`w-2 h-2 rounded-full ${getPriorityColor(job.priority)}`}></span>
                          )}
                          <span className={`font-mono text-sm ${jobIsMaintenance ? maintColors.text : 'text-white'}`}>
                            {job.job_number}
                          </span>
                          {job.status === 'assigned' && isFirstInQueue && !jobIsMaintenance && (
                            <span className="text-xs bg-green-900/50 text-green-400 px-1.5 py-0.5 rounded">Next</span>
                          )}
                          {jobIsMaintenance && (
                            <span className={`text-xs px-1.5 py-0.5 rounded ${
                              job.work_order?.maintenance_type === 'unplanned' 
                                ? 'bg-purple-900/50 text-purple-400' 
                                : 'bg-blue-900/50 text-blue-400'
                            }`}>
                              {job.work_order?.maintenance_type === 'unplanned' ? 'Unplanned' : 'Planned'}
                            </span>
                          )}
                        </div>
                        {getStatusBadge(job.status)}
                      </div>
                      {jobIsMaintenance ? (
                        <>
                          <p className={`text-sm mb-1 ${maintColors.text}`}>
                            {job.work_order?.maintenance_type === 'unplanned' ? '⚠ Machine Down' : '🔧 Scheduled Maintenance'}
                          </p>
                          <p className="text-gray-400 text-xs mb-1">{job.work_order?.notes || job.notes || 'No description'}</p>
                        </>
                      ) : (
                        <p className="text-skynet-accent text-sm font-mono mb-1">{job.component?.part_number}</p>
                      )}
                      <div className="flex items-center justify-between text-xs text-gray-500">
                        {jobIsMaintenance ? (
                          <span>{job.work_order?.wo_number}</span>
                        ) : (
                          <span>Qty: {job.quantity}</span>
                        )}
                        <span>{formatTime(job.scheduled_start)}</span>
                      </div>
                    </button>
                  )})
                )}
              </div>

              {selectedJob && !activeJob && canOperate && (
                <div className="p-4 border-t border-gray-800">
                  {isMaintenance(selectedJob) ? (
                    <button 
                      onClick={() => handleStartSetup(selectedJob)} 
                      disabled={actionLoading} 
                      className={`w-full py-3 ${
                        selectedJob.work_order?.maintenance_type === 'unplanned'
                          ? 'bg-purple-600 hover:bg-purple-500'
                          : 'bg-blue-600 hover:bg-blue-500'
                      } disabled:bg-gray-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2`}
                    >
                      {actionLoading ? <Loader2 size={20} className="animate-spin" /> : <Wrench size={20} />}
                      Start Downtime - {selectedJob.job_number}
                    </button>
                  ) : (
                    <button 
                      onClick={() => handleStartSetup(selectedJob)} 
                      disabled={actionLoading} 
                      className="w-full py-3 bg-skynet-accent hover:bg-blue-600 disabled:bg-gray-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
                    >
                      {actionLoading ? <Loader2 size={20} className="animate-spin" /> : <Play size={20} />}
                      Start Setup - {selectedJob.job_number}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Previous Jobs Section */}
            <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden mt-4">
              <div className="px-4 py-3 border-b border-gray-800">
                <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                  <History size={20} className="text-gray-500" />
                  Previous Jobs
                  <span className="ml-auto text-sm text-gray-500">{previousJobs.length} recent</span>
                </h2>
              </div>

              <div className="divide-y divide-gray-800 max-h-[400px] overflow-y-auto">
                {previousJobsLoading ? (
                  <div className="p-6 text-center">
                    <Loader2 className="w-6 h-6 text-skynet-accent animate-spin mx-auto" />
                  </div>
                ) : previousJobs.length === 0 ? (
                  <div className="p-6 text-center">
                    <p className="text-gray-500 text-sm">No completed jobs yet</p>
                  </div>
                ) : (
                  previousJobs.map((job) => (
                    <div key={job.id}>
                      <button 
                        onClick={() => handlePreviousJobClick(job)}
                        className={`w-full p-3 text-left transition-colors ${
                          selectedPreviousJob?.id === job.id 
                            ? 'bg-gray-800 border-l-4 border-skynet-accent' 
                            : 'hover:bg-gray-800/50'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${getPriorityColor(job.priority)}`}></span>
                            <span className="text-white font-mono text-sm">{job.job_number}</span>
                          </div>
                          {job.status === 'incomplete' ? (
                            <span className="text-xs px-2 py-0.5 rounded bg-red-900/50 text-red-400">Incomplete</span>
                          ) : job.status === 'complete' || job.status === 'manufacturing_complete' ? (
                            <span className="text-xs px-2 py-0.5 rounded bg-green-900/50 text-green-400">Complete</span>
                          ) : (
                            <span className="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-400">{job.status.replace('_', ' ')}</span>
                          )}
                        </div>
                        <p className="text-skynet-accent text-sm font-mono mb-1">{job.component?.part_number}</p>
                        <div className="flex items-center justify-between text-xs text-gray-500">
                          <span>
                            <span className="text-green-400">{job.good_pieces || 0}</span>
                            <span className="text-gray-600"> / </span>
                            <span className="text-red-400">{job.bad_pieces || 0}</span>
                            <span className="text-gray-600"> pcs</span>
                          </span>
                          <span>{formatDateTime(job.actual_end)}</span>
                        </div>
                      </button>
                      
                      {/* Activity Log for selected previous job */}
                      {selectedPreviousJob?.id === job.id && previousJobActivities.length > 0 && (
                        <div className="px-4 py-3 bg-gray-800/50 border-l-4 border-skynet-accent">
                          <h4 className="text-xs font-medium text-gray-400 mb-2 flex items-center gap-1">
                            <History size={12} />
                            Activity Log
                          </h4>
                          <div className="space-y-2">
                            {previousJobActivities.map((activity, index) => (
                              <div key={index} className="flex items-start gap-2">
                                <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${
                                  activity.color === 'green' ? 'bg-green-900/50 text-green-400' :
                                  activity.color === 'yellow' ? 'bg-yellow-900/50 text-yellow-400' :
                                  activity.color === 'red' ? 'bg-red-900/50 text-red-400' :
                                  activity.color === 'orange' ? 'bg-orange-900/50 text-orange-400' :
                                  'bg-gray-800 text-gray-400'
                                }`}>
                                  {activity.icon === 'wrench' && <Wrench size={10} />}
                                  {activity.icon === 'play' && <Play size={10} />}
                                  {activity.icon === 'pause' && <PauseCircle size={10} />}
                                  {activity.icon === 'check' && <CheckCircle size={10} />}
                                  {activity.icon === 'send' && <SendHorizontal size={10} />}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center justify-between">
                                    <p className="text-white text-xs">{activity.label}</p>
                                    {activity.duration && (
                                      <span className="text-xs text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded text-[10px]">
                                        {activity.duration}
                                      </span>
                                    )}
                                  </div>
                                  {activity.sublabel && (
                                    <p className="text-gray-500 text-[10px] truncate">{activity.sublabel}</p>
                                  )}
                                  <p className="text-gray-600 text-[10px]">
                                    {formatDateTime(activity.timestamp)}
                                  </p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Tooling Modal */}
      {showToolingModal && activeJob && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white flex items-center gap-2"><Wrench className="text-yellow-500" size={24} />Tooling Setup</h2>
                <p className="text-gray-500 text-sm">{activeJob.job_number} • {activeJob.component?.part_number}</p>
              </div>
              <button onClick={() => setShowToolingModal(false)} className="text-gray-400 hover:text-white"><X size={24} /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              <div>
                <h3 className="text-white font-medium mb-3 flex items-center gap-2">Current Job Tools <span className="text-gray-500 text-sm">({jobTools.length})</span></h3>
                {toolsLoading ? (
                  <div className="p-4 text-center"><Loader2 className="w-6 h-6 text-skynet-accent animate-spin mx-auto" /></div>
                ) : jobTools.length === 0 ? (
                  <p className="text-gray-500 text-sm p-4 bg-gray-800 rounded-lg">No tools added yet</p>
                ) : (
                  <div className="space-y-2">
                    {jobTools.map((tool) => (
                      <div key={tool.id} className="flex items-center justify-between p-3 bg-gray-800 rounded-lg">
                        <div>
                          <p className="text-white font-medium">{tool.tool_name}</p>
                          <p className="text-gray-500 text-sm">{tool.tool_type && <span>{tool.tool_type} • </span>}{tool.serial_number ? <span>SN: {tool.serial_number}</span> : <span className="text-gray-600">No serial</span>}</p>
                        </div>
                        <button onClick={() => handleRemoveTool(tool.id)} className="text-red-400 hover:text-red-300 p-2"><Trash2 size={18} /></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <h3 className="text-white font-medium mb-3">Add New Tool</h3>
                <div className="grid grid-cols-3 gap-3">
                  <div><label className="block text-gray-500 text-xs mb-1">Tool Name *</label><input type="text" placeholder="e.g., 1/8 Drill Bit" value={newTool.tool_name} onChange={(e) => setNewTool({...newTool, tool_name: e.target.value})} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:border-skynet-accent focus:outline-none" /></div>
                  <div><label className="block text-gray-500 text-xs mb-1">Tool Type</label><input type="text" placeholder="e.g., Drill Bit" value={newTool.tool_type} onChange={(e) => setNewTool({...newTool, tool_type: e.target.value})} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:border-skynet-accent focus:outline-none" /></div>
                  <div><label className="block text-gray-500 text-xs mb-1">Serial Number</label><input type="text" placeholder="e.g., SN-12345" value={newTool.serial_number} onChange={(e) => setNewTool({...newTool, serial_number: e.target.value})} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:border-skynet-accent focus:outline-none" /></div>
                </div>
                <button onClick={handleAddTool} disabled={!newTool.tool_name.trim()} className="mt-3 px-4 py-2 bg-skynet-accent hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm rounded flex items-center gap-2"><Plus size={16} /> Add Tool</button>
              </div>

              {toolHistory.length > 0 && (
                <div>
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2"><Database size={16} className="text-skynet-accent" />Previously Used on {machine.name}</h3>
                  <div className="space-y-2">
                    {toolHistory.map((tool, idx) => (
                      <div key={idx} className="flex items-center justify-between p-3 bg-gray-800/50 rounded-lg border border-gray-700">
                        <div><p className="text-white">{tool.tool_name}</p><p className="text-gray-500 text-sm">{tool.tool_type && <span>{tool.tool_type} • </span>}{tool.serial_number && <span>SN: {tool.serial_number}</span>}</p></div>
                        <button onClick={() => handleAddToolFromHistory(tool)} className="px-3 py-1 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded">+ Add</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {otherMachineTools.length > 0 && (
                <div>
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2"><Database size={16} className="text-gray-500" />Used on Other Machines</h3>
                  <div className="space-y-2">
                    {otherMachineTools.map((tool, idx) => (
                      <div key={idx} className="flex items-center justify-between p-3 bg-gray-800/30 rounded-lg border border-gray-700/50">
                        <div><p className="text-gray-300">{tool.tool_name}</p><p className="text-gray-500 text-sm">{tool.tool_type && <span>{tool.tool_type} • </span>}{tool.serial_number && <span>SN: {tool.serial_number} • </span>}<span className="text-gray-600">from {tool.job?.assigned_machine?.name || 'another machine'}</span></p></div>
                        <button onClick={() => handleAddToolFromHistory(tool)} className="px-3 py-1 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded">+ Add</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-between">
              <button onClick={handleOverrideTooling} disabled={actionLoading} className="px-4 py-2 text-yellow-500 hover:text-yellow-400 text-sm flex items-center gap-2"><SkipForward size={16} />Skip Tooling</button>
              <button onClick={handleConfirmTooling} disabled={actionLoading} className="px-6 py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 text-white font-semibold rounded-lg flex items-center gap-2">
                {actionLoading ? <Loader2 size={20} className="animate-spin" /> : <CheckCircle size={20} />}Confirm Tooling
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Materials Modal */}
      {showMaterialModal && activeJob && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-gray-800">
              <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                <Layers className="text-blue-400" size={24} />
                Bar Stock / Raw Materials
              </h2>
              <p className="text-gray-500 text-sm mt-1">{activeJob.job_number} • {activeJob.component?.part_number}</p>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Add Material Form */}
              <div className="bg-gray-800/50 rounded-lg p-4 space-y-4">
                <h3 className="text-white font-medium flex items-center gap-2">
                  <Plus size={18} className="text-green-400" />
                  Add Bar Stock
                </h3>
                
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-gray-400 text-sm mb-2">Material Type *</label>
                    <select 
                      value={materialForm.material_type} 
                      onChange={(e) => setMaterialForm({...materialForm, material_type: e.target.value})}
                      className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-skynet-accent focus:outline-none"
                    >
                      <option value="">Select material...</option>
                      {materialTypes.map(mt => (
                        <option key={mt.id} value={mt.name}>{mt.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-gray-400 text-sm mb-2">Bar Size *</label>
                    <select 
                      value={materialForm.bar_size} 
                      onChange={(e) => setMaterialForm({...materialForm, bar_size: e.target.value})}
                      className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-skynet-accent focus:outline-none"
                    >
                      <option value="">Select size...</option>
                      {barSizes.map(bs => (
                        <option key={bs.id} value={bs.size}>{bs.size}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-gray-400 text-sm mb-2">Bar Length (in.)</label>
                    <input 
                      type="number" 
                      min="0"
                      step="0.25"
                      value={materialForm.bar_length} 
                      onChange={(e) => setMaterialForm({...materialForm, bar_length: e.target.value})}
                      placeholder="144"
                      className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white text-center focus:border-skynet-accent focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-gray-400 text-sm mb-2">Lot / Heat Number</label>
                    <input 
                      type="text" 
                      value={materialForm.lot_number} 
                      onChange={(e) => setMaterialForm({...materialForm, lot_number: e.target.value})}
                      placeholder="Lot #"
                      className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-skynet-accent focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-gray-400 text-sm mb-2">Bars Loaded *</label>
                    <input 
                      type="number" 
                      min="1"
                      value={materialForm.bars_loaded} 
                      onChange={(e) => setMaterialForm({...materialForm, bars_loaded: e.target.value})}
                      placeholder="0"
                      className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white text-center text-xl focus:border-skynet-accent focus:outline-none"
                    />
                  </div>
                </div>

                <button 
                  onClick={handleAddMaterial}
                  disabled={actionLoading || !materialForm.material_type || !materialForm.bar_size || !materialForm.bars_loaded}
                  className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <Plus size={20} />Add Material
                </button>
              </div>

              {/* Current Materials Loaded */}
              <div>
                <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                  <Package size={18} className="text-gray-400" />
                  Materials Loaded ({jobMaterials.length})
                </h3>
                
                {jobMaterials.length === 0 ? (
                  <div className="bg-gray-800/30 rounded-lg p-6 text-center">
                    <Layers className="w-12 h-12 text-gray-600 mx-auto mb-2" />
                    <p className="text-gray-500">No materials added yet</p>
                    <p className="text-gray-600 text-sm mt-1">Add bar stock loaded on the bar feeder</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {jobMaterials.map(material => (
                      <div key={material.id} className="flex items-center justify-between p-3 bg-gray-800 rounded-lg border border-gray-700">
                        <div className="flex-1">
                          <div className="flex items-center gap-3">
                            <span className="text-white font-medium">{material.material_type}</span>
                            <span className="text-gray-400 text-sm">{material.bar_size}</span>
                            {material.bar_length && (
                              <span className="text-gray-500 text-sm">× {material.bar_length}"</span>
                            )}
                          </div>
                          <div className="flex items-center gap-4 mt-1 text-sm">
                            <span className="text-blue-400">{material.bars_loaded} bars</span>
                            {material.lot_number && (
                              <span className="text-gray-500">Lot: {material.lot_number}</span>
                            )}
                          </div>
                        </div>
                        <button 
                          onClick={() => handleRemoveMaterial(material.id)}
                          className="p-2 text-gray-500 hover:text-red-400 transition-colors"
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Footer - Different for setup vs production */}
            {activeJob.status === 'in_setup' ? (
              <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-between">
                <button 
                  onClick={handleSkipMaterials} 
                  disabled={actionLoading} 
                  className="px-4 py-2 text-yellow-500 hover:text-yellow-400 text-sm flex items-center gap-2"
                >
                  <SkipForward size={16} />Skip Materials
                </button>
                <button 
                  onClick={handleConfirmMaterials} 
                  disabled={actionLoading} 
                  className="px-6 py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 text-white font-semibold rounded-lg flex items-center gap-2"
                >
                  {actionLoading ? <Loader2 size={20} className="animate-spin" /> : <Play size={20} />}
                  Confirm & Start Production
                </button>
              </div>
            ) : (
              <div className="px-6 py-4 border-t border-gray-800 flex justify-end">
                <button 
                  onClick={() => setShowMaterialModal(false)} 
                  className="px-6 py-3 bg-gray-700 hover:bg-gray-600 text-white font-semibold rounded-lg flex items-center gap-2"
                >
                  <CheckCircle size={20} />
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Material Override Confirmation Modal */}
      {showMaterialOverrideModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-md">
            <div className="px-6 py-4 border-b border-gray-800">
              <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                <AlertTriangle className="text-yellow-500" size={24} />
                Skip Material Setup
              </h2>
            </div>

            <div className="p-6 space-y-4">
              <div className="bg-yellow-900/30 border border-yellow-600/50 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="text-yellow-500 flex-shrink-0 mt-0.5" size={24} />
                  <div>
                    <h3 className="text-yellow-400 font-medium mb-1">No Materials Recorded</h3>
                    <p className="text-gray-300 text-sm">
                      You are about to start production without recording any bar stock or material information.
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-gray-800 rounded-lg p-4">
                <p className="text-gray-300 text-sm mb-2">This action will be logged and tracked for compliance purposes:</p>
                <ul className="text-gray-400 text-sm space-y-1">
                  <li>• Operator: <span className="text-white">{operator?.full_name}</span></li>
                  <li>• Time: <span className="text-white">{new Date().toLocaleString()}</span></li>
                  <li>• Job: <span className="text-white">{activeJob?.job_number}</span></li>
                </ul>
              </div>

              <p className="text-gray-400 text-center text-sm">
                Are you sure you want to continue without material tracking?
              </p>
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex gap-3">
              <button 
                onClick={() => setShowMaterialOverrideModal(false)} 
                className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
              >
                Go Back
              </button>
              <button 
                onClick={handleConfirmMaterialOverride} 
                disabled={actionLoading} 
                className="flex-1 py-3 bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {actionLoading ? <Loader2 size={20} className="animate-spin" /> : <SkipForward size={20} />}
                Skip & Start Production
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Complete Job Modal */}
      {showCompleteModal && activeJob && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className={`bg-gray-900 border rounded-lg w-full max-w-md ${
            isMaintenance(activeJob) 
              ? activeJob.work_order?.maintenance_type === 'unplanned'
                ? 'border-purple-700'
                : 'border-blue-700'
              : 'border-gray-700'
          }`}>
            <div className={`px-6 py-4 border-b ${
              isMaintenance(activeJob)
                ? activeJob.work_order?.maintenance_type === 'unplanned'
                  ? 'border-purple-700 bg-purple-900/20'
                  : 'border-blue-700 bg-blue-900/20'
                : 'border-gray-800'
            }`}>
              <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                {isMaintenance(activeJob) ? (
                  <>
                    <Wrench className={activeJob.work_order?.maintenance_type === 'unplanned' ? 'text-purple-500' : 'text-blue-500'} size={24} />
                    Complete Downtime
                  </>
                ) : completionStep === 'review_downtimes' ? (
                  <><AlertTriangle className="text-yellow-500" size={24} />Review Downtimes</>
                ) : completionStep === 'materials' ? (
                  <><Layers className="text-blue-400" size={24} />Material Checkout</>
                ) : (
                  <><CheckCircle className="text-green-500" size={24} />Complete Job</>
                )}
              </h2>
              <p className="text-gray-500 text-sm">
                {activeJob.job_number} • {isMaintenance(activeJob) ? (activeJob.work_order?.notes || 'Maintenance') : activeJob.component?.part_number}
              </p>
            </div>

            {/* Maintenance Completion Form */}
            {isMaintenance(activeJob) ? (
              <>
                <div className="p-6 space-y-4">
                  <div>
                    <label className="block text-gray-400 text-sm mb-2">End Time *</label>
                    <input 
                      type="datetime-local" 
                      value={completeForm.actual_end} 
                      onChange={(e) => setCompleteForm({...completeForm, actual_end: e.target.value})} 
                      className={`w-full px-4 py-3 bg-gray-800 border rounded-lg text-white focus:outline-none ${
                        activeJob.work_order?.maintenance_type === 'unplanned'
                          ? 'border-purple-700 focus:border-purple-500'
                          : 'border-blue-700 focus:border-blue-500'
                      }`}
                      style={{ colorScheme: 'dark' }} 
                    />
                  </div>

                  <div>
                    <label className="block text-gray-400 text-sm mb-2">Completion Notes * <span className="text-red-400">(Required)</span></label>
                    <textarea
                      value={maintenanceCompletionNotes}
                      onChange={(e) => setMaintenanceCompletionNotes(e.target.value)}
                      placeholder="Describe what was done, parts replaced, issues found, etc."
                      rows={4}
                      className={`w-full px-4 py-3 bg-gray-800 border rounded-lg text-white focus:outline-none resize-none ${
                        activeJob.work_order?.maintenance_type === 'unplanned'
                          ? 'border-purple-700 focus:border-purple-500'
                          : 'border-blue-700 focus:border-blue-500'
                      }`}
                    />
                  </div>

                  {/* Duration Summary */}
                  <div className={`rounded-lg p-3 ${
                    activeJob.work_order?.maintenance_type === 'unplanned'
                      ? 'bg-purple-900/30'
                      : 'bg-blue-900/30'
                  }`}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-400">Started:</span>
                      <span className="text-white">{formatDateTime(activeJob.production_start || activeJob.setup_start)}</span>
                    </div>
                    {completeForm.actual_end && (
                      <div className="flex items-center justify-between text-sm mt-1">
                        <span className="text-gray-400">Duration:</span>
                        <span className="text-white font-medium">
                          {(() => {
                            const start = new Date(activeJob.production_start || activeJob.setup_start)
                            const end = new Date(completeForm.actual_end)
                            const mins = Math.round((end - start) / 60000)
                            if (mins < 60) return `${mins} min`
                            const hrs = Math.floor(mins / 60)
                            const remMins = mins % 60
                            return `${hrs}h ${remMins}m`
                          })()}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="px-6 py-4 border-t border-gray-800 flex gap-3">
                  <button onClick={resetCompleteModal} className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors">Cancel</button>
                  <button 
                    onClick={async () => {
                      if (!completeForm.actual_end) {
                        alert('Please enter the end time')
                        return
                      }
                      if (!maintenanceCompletionNotes.trim()) {
                        alert('Please enter completion notes')
                        return
                      }
                      
                      setActionLoading(true)
                      try {
                        const { error } = await supabase
                          .from('jobs')
                          .update({
                            status: 'complete',
                            actual_end: new Date(completeForm.actual_end).toISOString(),
                            notes: activeJob.notes 
                              ? `${activeJob.notes}\n[Completion Notes: ${maintenanceCompletionNotes}]`
                              : `[Completion Notes: ${maintenanceCompletionNotes}]`,
                            updated_at: new Date().toISOString()
                          })
                          .eq('id', activeJob.id)
                        
                        if (error) throw error
                        
                        // Update work order
                        if (activeJob.work_order_id) {
                          await supabase
                            .from('work_orders')
                            .update({
                              status: 'complete',
                              notes: activeJob.work_order?.notes
                                ? `${activeJob.work_order.notes}\n[Completion Notes: ${maintenanceCompletionNotes}]`
                                : `[Completion Notes: ${maintenanceCompletionNotes}]`,
                              updated_at: new Date().toISOString()
                            })
                            .eq('id', activeJob.work_order_id)
                        }
                        
                        // Reset machine status if unplanned
                        if (activeJob.work_order?.maintenance_type === 'unplanned' && machine?.id) {
                          await supabase
                            .from('machines')
                            .update({
                              status: 'available',
                              status_reason: null,
                              status_updated_at: new Date().toISOString()
                            })
                            .eq('id', machine.id)
                        }
                        
                        resetCompleteModal()
                        await loadJobs()
                      } catch (err) {
                        console.error('Error completing maintenance:', err)
                        alert('Failed to complete: ' + err.message)
                      } finally {
                        setActionLoading(false)
                      }
                    }}
                    disabled={actionLoading || !completeForm.actual_end || !maintenanceCompletionNotes.trim()} 
                    className={`flex-1 py-3 font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 disabled:bg-gray-700 disabled:text-gray-500 ${
                      activeJob.work_order?.maintenance_type === 'unplanned'
                        ? 'bg-purple-600 hover:bg-purple-500 text-white'
                        : 'bg-blue-600 hover:bg-blue-500 text-white'
                    }`}
                  >
                    {actionLoading ? <Loader2 size={20} className="animate-spin" /> : <CheckCircle size={20} />}
                    Complete Downtime
                  </button>
                </div>
              </>
            ) : (
            <>
            {/* Step 1: Entry Form */}
            {completionStep === 'form' && (
              <>
                <div className="p-6 space-y-4">
                  {/* Required Pieces - Prominent Display */}
                  <div className="bg-skynet-accent/10 border border-skynet-accent/30 rounded-lg p-4 text-center">
                    <p className="text-gray-400 text-sm">Required Pieces</p>
                    <p className="text-3xl font-bold text-white">{activeJob.quantity}</p>
                  </div>

                  <div>
                    <label className="block text-gray-400 text-sm mb-2">Actual End Time *</label>
                    <input type="datetime-local" value={completeForm.actual_end} onChange={(e) => setCompleteForm({...completeForm, actual_end: e.target.value})} className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-skynet-accent focus:outline-none" style={{ colorScheme: 'dark' }} />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-gray-400 text-sm mb-2">Good Pieces</label>
                      <input type="number" min="0" value={completeForm.good_pieces} onChange={(e) => setCompleteForm({...completeForm, good_pieces: e.target.value})} className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white text-center text-xl focus:border-green-500 focus:outline-none" />
                    </div>
                    <div>
                      <label className="block text-gray-400 text-sm mb-2">Bad Pieces</label>
                      <input type="number" min="0" value={completeForm.bad_pieces} onChange={(e) => setCompleteForm({...completeForm, bad_pieces: e.target.value})} className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white text-center text-xl focus:border-red-500 focus:outline-none" />
                    </div>
                  </div>

                  <div className="bg-gray-800 rounded-lg p-3 text-center">
                    <p className="text-gray-500 text-sm">
                      Total Entered: <span className={`font-medium ${(parseInt(completeForm.good_pieces) || 0) >= activeJob.quantity ? 'text-green-400' : 'text-yellow-400'}`}>{(parseInt(completeForm.good_pieces) || 0) + (parseInt(completeForm.bad_pieces) || 0)}</span>
                      {(parseInt(completeForm.good_pieces) || 0) < activeJob.quantity && (
                        <span className="text-yellow-400 ml-2">({activeJob.quantity - (parseInt(completeForm.good_pieces) || 0)} remaining)</span>
                      )}
                    </p>
                  </div>
                </div>

                <div className="px-6 py-4 border-t border-gray-800 flex gap-3">
                  <button onClick={resetCompleteModal} className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors">Cancel</button>
                  <button onClick={handleCompleteJobClick} disabled={actionLoading || !completeForm.actual_end} className="flex-1 py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2">
                    {actionLoading ? <Loader2 size={20} className="animate-spin" /> : <CheckCircle size={20} />}Complete Job
                  </button>
                </div>
              </>
            )}

            {/* Step 2: Review Ongoing Downtimes */}
            {completionStep === 'review_downtimes' && (
              <div className="p-6 space-y-4">
                <div className="bg-yellow-900/30 border border-yellow-600/50 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="text-yellow-500 flex-shrink-0 mt-0.5" size={24} />
                    <div>
                      <h3 className="text-yellow-400 font-medium mb-1">Ongoing Downtimes Found</h3>
                      <p className="text-gray-300 text-sm">
                        The following downtimes have no end time recorded. Please set end times before completing the job.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Validation Errors */}
                {validationErrors.length > 0 && (
                  <div className="bg-red-900/30 border border-red-600/50 rounded-lg p-3">
                    <ul className="text-red-400 text-sm space-y-1">
                      {validationErrors.map((err, idx) => (
                        <li key={idx}>• {err}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Downtime List */}
                <div className="space-y-3 max-h-64 overflow-y-auto">
                  {ongoingDowntimes.map((dt) => {
                    const edit = downtimeEdits[dt.id] || { end_time: '', duration_hours: 0, duration_mins: 0, use_duration: false }
                    return (
                      <div key={dt.id} className="bg-gray-800 rounded-lg p-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-white font-medium">{dt.reason}</span>
                          <span className="text-gray-500 text-xs">Started: {formatDateTime(dt.start_time)}</span>
                        </div>
                        {dt.notes && <p className="text-gray-400 text-sm mb-3">{dt.notes}</p>}
                        
                        {/* Toggle between End Time and Duration */}
                        <div className="flex gap-1 bg-gray-700 p-0.5 rounded mb-3">
                          <button
                            onClick={() => setDowntimeEdits({
                              ...downtimeEdits, 
                              [dt.id]: {...edit, use_duration: false}
                            })}
                            className={`flex-1 py-1.5 px-2 rounded text-xs font-medium transition-colors ${
                              !edit.use_duration ? 'bg-skynet-accent text-white' : 'text-gray-400 hover:text-white'
                            }`}
                          >
                            End Time
                          </button>
                          <button
                            onClick={() => setDowntimeEdits({
                              ...downtimeEdits, 
                              [dt.id]: {...edit, use_duration: true}
                            })}
                            className={`flex-1 py-1.5 px-2 rounded text-xs font-medium transition-colors ${
                              edit.use_duration ? 'bg-skynet-accent text-white' : 'text-gray-400 hover:text-white'
                            }`}
                          >
                            Duration
                          </button>
                        </div>

                        {!edit.use_duration ? (
                          <div>
                            <input 
                              type="datetime-local" 
                              value={edit.end_time || ''} 
                              onChange={(e) => setDowntimeEdits({
                                ...downtimeEdits, 
                                [dt.id]: {...edit, end_time: e.target.value}
                              })}
                              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:border-skynet-accent focus:outline-none"
                              style={{ colorScheme: 'dark' }}
                            />
                          </div>
                        ) : (
                          <div className="flex gap-2">
                            <div className="flex-1">
                              <div className="flex items-center gap-1">
                                <input 
                                  type="number" 
                                  min="0" 
                                  value={edit.duration_hours || 0} 
                                  onChange={(e) => setDowntimeEdits({
                                    ...downtimeEdits, 
                                    [dt.id]: {...edit, duration_hours: parseInt(e.target.value) || 0}
                                  })}
                                  className="w-full px-2 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm text-center focus:border-skynet-accent focus:outline-none"
                                />
                                <span className="text-gray-400 text-xs">hrs</span>
                              </div>
                            </div>
                            <div className="flex-1">
                              <div className="flex items-center gap-1">
                                <input 
                                  type="number" 
                                  min="0" 
                                  max="59"
                                  value={edit.duration_mins || 0} 
                                  onChange={(e) => setDowntimeEdits({
                                    ...downtimeEdits, 
                                    [dt.id]: {...edit, duration_mins: Math.min(59, parseInt(e.target.value) || 0)}
                                  })}
                                  className="w-full px-2 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm text-center focus:border-skynet-accent focus:outline-none"
                                />
                                <span className="text-gray-400 text-xs">min</span>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                <div className="flex gap-3">
                  <button 
                    onClick={() => setCompletionStep('form')} 
                    className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
                  >
                    ← Go Back
                  </button>
                  <button 
                    onClick={handleFixDowntimesAndContinue} 
                    disabled={actionLoading} 
                    className="flex-1 py-3 bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    {actionLoading ? <Loader2 size={20} className="animate-spin" /> : <CheckCircle size={20} />}
                    Fix & Continue
                  </button>
                </div>
              </div>
            )}

            {/* Step 3: Materials Checkout */}
            {completionStep === 'materials' && (
              <div className="p-6 space-y-4">
                <div className="bg-blue-900/30 border border-blue-600/50 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <Layers className="text-blue-400 flex-shrink-0 mt-0.5" size={24} />
                    <div>
                      <h3 className="text-blue-400 font-medium mb-1">Enter Bars Remaining</h3>
                      <p className="text-gray-300 text-sm">
                        Enter how many bars are left for each material. The system will calculate bars consumed.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  {jobMaterials.map(material => {
                    const remaining = parseInt(materialRemaining[material.id]) || 0
                    const consumed = material.bars_loaded - remaining
                    return (
                      <div key={material.id} className="bg-gray-800 rounded-lg p-4">
                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <span className="text-white font-medium">{material.material_type}</span>
                            <span className="text-gray-400 text-sm ml-2">{material.bar_size}</span>
                            {material.bar_length && (
                              <span className="text-gray-500 text-sm ml-1">× {material.bar_length}"</span>
                            )}
                          </div>
                          {material.lot_number && (
                            <span className="text-gray-500 text-xs">Lot: {material.lot_number}</span>
                          )}
                        </div>

                        <div className="grid grid-cols-3 gap-3 text-center">
                          <div className="bg-gray-700/50 rounded-lg p-2">
                            <p className="text-gray-400 text-xs mb-1">Loaded</p>
                            <p className="text-white font-bold">{material.bars_loaded}</p>
                          </div>
                          <div>
                            <p className="text-gray-400 text-xs mb-1">Remaining</p>
                            <input 
                              type="number" 
                              min="0"
                              max={material.bars_loaded}
                              value={materialRemaining[material.id] || 0}
                              onChange={(e) => setMaterialRemaining({
                                ...materialRemaining, 
                                [material.id]: Math.min(material.bars_loaded, Math.max(0, parseInt(e.target.value) || 0))
                              })}
                              className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded-lg text-white text-center font-bold focus:border-blue-500 focus:outline-none"
                            />
                          </div>
                          <div className="bg-green-900/30 rounded-lg p-2">
                            <p className="text-gray-400 text-xs mb-1">Consumed</p>
                            <p className={`font-bold ${consumed > 0 ? 'text-green-400' : 'text-gray-400'}`}>{consumed}</p>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* Summary */}
                <div className="bg-gray-800/50 rounded-lg p-3 text-center">
                  <p className="text-gray-400 text-sm">
                    Total Bars Consumed: <span className="text-green-400 font-bold">
                      {jobMaterials.reduce((sum, m) => sum + (m.bars_loaded - (parseInt(materialRemaining[m.id]) || 0)), 0)}
                    </span>
                  </p>
                </div>

                <div className="flex gap-3">
                  <button 
                    onClick={() => setCompletionStep('form')} 
                    className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
                  >
                    ← Back
                  </button>
                  <button 
                    onClick={handleMaterialsAndContinue} 
                    disabled={actionLoading} 
                    className="flex-1 py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    {actionLoading ? <Loader2 size={20} className="animate-spin" /> : <CheckCircle size={20} />}
                    Continue
                  </button>
                </div>
              </div>
            )}

            {/* Step 4: Confirm Incomplete */}
            {completionStep === 'confirm_incomplete' && (
              <div className="p-6 space-y-4">
                <div className="bg-yellow-900/30 border border-yellow-600/50 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="text-yellow-500 flex-shrink-0 mt-0.5" size={24} />
                    <div>
                      <h3 className="text-yellow-400 font-medium mb-1">Pieces Remaining</h3>
                      <p className="text-gray-300 text-sm">
                        You entered <span className="text-white font-medium">{parseInt(completeForm.good_pieces) || 0}</span> good pieces, 
                        but the job requires <span className="text-white font-medium">{activeJob.quantity}</span>.
                      </p>
                      <p className="text-gray-400 text-sm mt-2">
                        <span className="text-yellow-400 font-medium">{activeJob.quantity - (parseInt(completeForm.good_pieces) || 0)}</span> pieces remaining.
                      </p>
                    </div>
                  </div>
                </div>

                <p className="text-gray-300 text-center">
                  Would you like to send this job back to scheduling to complete the remaining pieces?
                </p>

                <div className="flex gap-3">
                  <button 
                    onClick={() => handleCompleteJob(true)} 
                    disabled={actionLoading} 
                    className="flex-1 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
                  >
                    {actionLoading ? <Loader2 size={20} className="animate-spin mx-auto" /> : 'No, Complete Job'}
                  </button>
                  <button 
                    onClick={handleSendToScheduling} 
                    disabled={actionLoading} 
                    className="flex-1 py-3 bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    {actionLoading ? <Loader2 size={20} className="animate-spin" /> : <SendHorizontal size={20} />}
                    Yes, Reschedule
                  </button>
                </div>

                <button 
                  onClick={() => setCompletionStep('form')} 
                  className="w-full py-2 text-gray-400 hover:text-white text-sm transition-colors"
                >
                  ← Go Back
                </button>
              </div>
            )}
            </>
            )}
          </div>
        </div>
      )}

      {/* Extend Duration Modal */}
      {showExtendModal && activeJob && isMaintenance(activeJob) && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className={`bg-gray-900 border rounded-lg w-full max-w-sm ${
            activeJob.work_order?.maintenance_type === 'unplanned'
              ? 'border-purple-700'
              : 'border-blue-700'
          }`}>
            <div className={`px-6 py-4 border-b ${
              activeJob.work_order?.maintenance_type === 'unplanned'
                ? 'border-purple-700 bg-purple-900/20'
                : 'border-blue-700 bg-blue-900/20'
            }`}>
              <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                <Clock className={activeJob.work_order?.maintenance_type === 'unplanned' ? 'text-purple-500' : 'text-blue-500'} size={24} />
                Extend Duration
              </h2>
              <p className="text-gray-500 text-sm">{activeJob.job_number}</p>
            </div>

            <div className="p-6 space-y-4">
              <p className="text-gray-300 text-sm">
                Current end time: <span className="text-white font-medium">{formatDateTime(activeJob.scheduled_end)}</span>
              </p>

              <div>
                <label className="block text-gray-400 text-sm mb-2">Extend by:</label>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min="0"
                        value={extendDuration.hours}
                        onChange={(e) => setExtendDuration({ ...extendDuration, hours: parseInt(e.target.value) || 0 })}
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-center focus:border-blue-500 focus:outline-none"
                      />
                      <span className="text-gray-400 text-sm">hrs</span>
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min="0"
                        max="59"
                        step="15"
                        value={extendDuration.minutes}
                        onChange={(e) => setExtendDuration({ ...extendDuration, minutes: parseInt(e.target.value) || 0 })}
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-center focus:border-blue-500 focus:outline-none"
                      />
                      <span className="text-gray-400 text-sm">min</span>
                    </div>
                  </div>
                </div>
              </div>

              {(extendDuration.hours > 0 || extendDuration.minutes > 0) && (
                <div className={`rounded-lg p-3 ${
                  activeJob.work_order?.maintenance_type === 'unplanned'
                    ? 'bg-purple-900/30'
                    : 'bg-blue-900/30'
                }`}>
                  <p className="text-gray-400 text-sm">
                    New end time: <span className="text-white font-medium">
                      {formatDateTime(new Date(new Date(activeJob.scheduled_end).getTime() + 
                        ((extendDuration.hours || 0) * 60 + (extendDuration.minutes || 0)) * 60000))}
                    </span>
                  </p>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex gap-3">
              <button 
                onClick={() => setShowExtendModal(false)} 
                className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleExtendDuration}
                disabled={actionLoading || (extendDuration.hours === 0 && extendDuration.minutes === 0)}
                className={`flex-1 py-3 font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 disabled:bg-gray-700 disabled:text-gray-500 ${
                  activeJob.work_order?.maintenance_type === 'unplanned'
                    ? 'bg-purple-600 hover:bg-purple-500 text-white'
                    : 'bg-blue-600 hover:bg-blue-500 text-white'
                }`}
              >
                {actionLoading ? <Loader2 size={20} className="animate-spin" /> : <Clock size={20} />}
                Extend
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Machine Ready Modal */}
      {showMachineReadyModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-md">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                <CheckCircle className="text-green-500" size={20} />
                Clear Machine Down Status
              </h3>
              <button 
                onClick={() => { setShowMachineReadyModal(false); setMachineReadyNotes('') }}
                className="text-gray-400 hover:text-white"
              >
                <X size={20} />
              </button>
            </div>
            
            <div className="p-6">
              <p className="text-gray-400 mb-4">
                This will close {orphanedDowntimes.length} open downtime record{orphanedDowntimes.length > 1 ? 's' : ''} and mark the machine as available.
              </p>
              
              <div className="mb-4">
                <label className="block text-gray-400 text-sm mb-2">Resolution Notes (Optional)</label>
                <textarea
                  value={machineReadyNotes}
                  onChange={(e) => setMachineReadyNotes(e.target.value)}
                  placeholder="e.g., Replaced broken tool, issue resolved..."
                  className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-green-500 focus:outline-none resize-none"
                  rows={3}
                />
              </div>

              <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg p-3 mb-6">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="text-yellow-500 flex-shrink-0 mt-0.5" size={16} />
                  <p className="text-yellow-400 text-sm">
                    Make sure the machine is actually ready for production before clearing this status.
                  </p>
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => { setShowMachineReadyModal(false); setMachineReadyNotes('') }}
                  className="flex-1 px-4 py-3 bg-gray-700 hover:bg-gray-600 text-white font-medium rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleClearMachineDown}
                  disabled={clearingDowntime}
                  className="flex-1 px-4 py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {clearingDowntime ? (
                    <><Loader2 size={18} className="animate-spin" /> Clearing...</>
                  ) : (
                    <><CheckCircle size={18} /> Confirm Ready</>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Downtime Modal (from Activity Log click) */}
      {editingDowntime && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-md">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                  <Edit3 className="text-skynet-accent" size={24} />
                  Edit Downtime
                </h2>
                <p className="text-gray-500 text-sm">{editingDowntime.reason}</p>
              </div>
              <button onClick={() => setEditingDowntime(null)} className="text-gray-400 hover:text-white">
                <X size={24} />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="bg-gray-800 rounded-lg p-3">
                <p className="text-gray-400 text-sm">Started: <span className="text-white">{formatDateTime(editingDowntime.start_time)}</span></p>
              </div>

              {/* Toggle between End Time and Duration */}
              <div className="flex gap-2 bg-gray-800 p-1 rounded-lg">
                <button
                  onClick={() => setEditDowntimeForm({...editDowntimeForm, use_duration: false})}
                  className={`flex-1 py-2 px-3 rounded text-sm font-medium transition-colors ${
                    !editDowntimeForm.use_duration ? 'bg-skynet-accent text-white' : 'text-gray-400 hover:text-white'
                  }`}
                >
                  End Time
                </button>
                <button
                  onClick={() => setEditDowntimeForm({...editDowntimeForm, use_duration: true})}
                  className={`flex-1 py-2 px-3 rounded text-sm font-medium transition-colors ${
                    editDowntimeForm.use_duration ? 'bg-skynet-accent text-white' : 'text-gray-400 hover:text-white'
                  }`}
                >
                  Duration
                </button>
              </div>

              {!editDowntimeForm.use_duration ? (
                <div>
                  <label className="block text-gray-400 text-sm mb-2">End Time *</label>
                  <input 
                    type="datetime-local" 
                    value={editDowntimeForm.end_time} 
                    onChange={(e) => setEditDowntimeForm({...editDowntimeForm, end_time: e.target.value})}
                    className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-skynet-accent focus:outline-none"
                    style={{ colorScheme: 'dark' }}
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-gray-400 text-sm mb-2">Duration *</label>
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <input 
                          type="number" 
                          min="0" 
                          value={editDowntimeForm.duration_hours} 
                          onChange={(e) => setEditDowntimeForm({...editDowntimeForm, duration_hours: parseInt(e.target.value) || 0})}
                          className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white text-center focus:border-skynet-accent focus:outline-none"
                        />
                        <span className="text-gray-400">hrs</span>
                      </div>
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <input 
                          type="number" 
                          min="0" 
                          max="59"
                          value={editDowntimeForm.duration_mins} 
                          onChange={(e) => setEditDowntimeForm({...editDowntimeForm, duration_mins: Math.min(59, parseInt(e.target.value) || 0)})}
                          className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white text-center focus:border-skynet-accent focus:outline-none"
                        />
                        <span className="text-gray-400">min</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Send to Scheduling Option */}
              {activeJob && (
                <div className="border-t border-gray-700 pt-4">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editDowntimeForm.send_to_scheduling}
                      onChange={(e) => setEditDowntimeForm({...editDowntimeForm, send_to_scheduling: e.target.checked})}
                      className="w-5 h-5 rounded bg-gray-800 border-gray-600 text-yellow-500 focus:ring-yellow-500"
                    />
                    <div>
                      <span className="text-white font-medium">Send job back to scheduling</span>
                      <p className="text-gray-500 text-xs">End this downtime and reschedule the job for later</p>
                    </div>
                  </label>

                  {editDowntimeForm.send_to_scheduling && (
                    <div className="mt-4 bg-yellow-900/20 border border-yellow-600/50 rounded-lg p-4">
                      <div className="mb-3">
                        <label className="block text-gray-400 text-sm mb-2">Good Pieces Completed</label>
                        <input
                          type="number"
                          min="0"
                          max={activeJob.quantity}
                          value={editDowntimeForm.good_pieces}
                          onChange={(e) => setEditDowntimeForm({...editDowntimeForm, good_pieces: parseInt(e.target.value) || 0})}
                          className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white text-center text-xl focus:border-yellow-500 focus:outline-none"
                        />
                      </div>
                      <p className="text-yellow-400 text-sm">
                        {activeJob.quantity - (parseInt(editDowntimeForm.good_pieces) || 0)} pieces remaining to be rescheduled
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex gap-3">
              <button onClick={() => setEditingDowntime(null)} className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors">
                Cancel
              </button>
              <button 
                onClick={handleSaveDowntimeEdit} 
                disabled={actionLoading} 
                className={`flex-1 py-3 font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 disabled:bg-gray-700 ${
                  editDowntimeForm.send_to_scheduling 
                    ? 'bg-yellow-600 hover:bg-yellow-500 text-white' 
                    : 'bg-skynet-accent hover:bg-blue-600 text-white'
                }`}
              >
                {actionLoading ? <Loader2 size={20} className="animate-spin" /> : editDowntimeForm.send_to_scheduling ? <SendHorizontal size={20} /> : <Save size={20} />}
                {editDowntimeForm.send_to_scheduling ? 'Send to Scheduling' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tooling Change Modal */}
      {showToolChangeModal && activeJob && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-md">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                  <Wrench className="text-yellow-400" size={24} />
                  Tooling Change
                </h2>
                <p className="text-gray-500 text-sm">{activeJob.job_number} • {activeJob.component?.part_number}</p>
              </div>
              <button onClick={() => setShowToolChangeModal(false)} className="text-gray-400 hover:text-white">
                <X size={24} />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="bg-yellow-900/30 border border-yellow-600/50 rounded-lg p-3">
                <p className="text-yellow-400 text-sm">
                  Select the tool being changed and enter the new serial number. This will be logged as a tooling change downtime.
                </p>
              </div>

              <div>
                <label className="block text-gray-400 text-sm mb-2">Tool Being Changed *</label>
                <select 
                  value={toolChangeForm.tool_id} 
                  onChange={(e) => setToolChangeForm({...toolChangeForm, tool_id: e.target.value})}
                  className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-yellow-500 focus:outline-none"
                >
                  <option value="">Select tool...</option>
                  {currentTools.map(tool => (
                    <option key={tool.id} value={tool.id}>
                      {tool.tool_name} {tool.serial_number ? `(S/N: ${tool.serial_number})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-gray-400 text-sm mb-2">New Serial Number *</label>
                <input 
                  type="text" 
                  value={toolChangeForm.new_serial_number} 
                  onChange={(e) => setToolChangeForm({...toolChangeForm, new_serial_number: e.target.value})}
                  placeholder="Enter new tool serial number"
                  className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-yellow-500 focus:outline-none"
                />
              </div>

              {/* Downtime Timing */}
              <div className="border-t border-gray-700 pt-4 mt-4">
                <h4 className="text-gray-300 font-medium mb-3 flex items-center gap-2">
                  <Timer size={16} className="text-gray-400" />
                  Downtime Duration
                </h4>
                
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-gray-400 text-sm mb-2">Start Time *</label>
                    <input 
                      type="datetime-local" 
                      value={toolChangeForm.start_time} 
                      onChange={(e) => setToolChangeForm({...toolChangeForm, start_time: e.target.value})}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:border-yellow-500 focus:outline-none"
                      style={{ colorScheme: 'dark' }}
                    />
                  </div>
                  <div>
                    <label className="block text-gray-400 text-sm mb-2">Duration *</label>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <div className="flex items-center gap-1">
                          <input 
                            type="number" 
                            min="0" 
                            value={toolChangeForm.duration_hours} 
                            onChange={(e) => setToolChangeForm({...toolChangeForm, duration_hours: parseInt(e.target.value) || 0})}
                            className="w-full px-2 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm text-center focus:border-yellow-500 focus:outline-none"
                          />
                          <span className="text-gray-400 text-xs">h</span>
                        </div>
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-1">
                          <input 
                            type="number" 
                            min="0" 
                            max="59"
                            value={toolChangeForm.duration_mins} 
                            onChange={(e) => setToolChangeForm({...toolChangeForm, duration_mins: Math.min(59, parseInt(e.target.value) || 0)})}
                            className="w-full px-2 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm text-center focus:border-yellow-500 focus:outline-none"
                          />
                          <span className="text-gray-400 text-xs">m</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex gap-3">
              <button 
                onClick={() => setShowToolChangeModal(false)} 
                className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleConfirmToolChange} 
                disabled={actionLoading || !toolChangeForm.tool_id || !toolChangeForm.new_serial_number.trim() || !toolChangeForm.start_time} 
                className="flex-1 py-3 bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {actionLoading ? <Loader2 size={20} className="animate-spin" /> : <CheckCircle size={20} />}
                Confirm Change
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tool Serial Verification Modal */}
      {showToolVerifyModal && toolToVerify && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-md">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                  <Wrench className="text-yellow-500" size={24} />
                  Verify Tool
                </h2>
                <p className="text-gray-500 text-sm">{toolToVerify.tool_name}</p>
              </div>
              <button 
                onClick={() => {
                  setShowToolVerifyModal(false)
                  setToolToVerify(null)
                  setVerifySerialInput('')
                  setVerifyStep('enter')
                }} 
                className="text-gray-400 hover:text-white"
              >
                <X size={24} />
              </button>
            </div>

            {verifyStep === 'enter' && (
              <div className="p-6 space-y-4">
                <div className="bg-yellow-900/30 border border-yellow-600/50 rounded-lg p-4">
                  <p className="text-yellow-400 text-sm">
                    To confirm this is the correct tool, please enter the serial number from the physical tool.
                  </p>
                </div>

                <div className="bg-gray-800 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-gray-400 text-sm">Tool:</span>
                    <span className="text-white font-medium">{toolToVerify.tool_name}</span>
                  </div>
                  {toolToVerify.tool_type && (
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-gray-400 text-sm">Type:</span>
                      <span className="text-gray-300">{toolToVerify.tool_type}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-gray-400 text-sm">Expected S/N:</span>
                    <span className="text-gray-500 font-mono">{toolToVerify.serial_number || 'None'}</span>
                  </div>
                </div>

                <div>
                  <label className="block text-gray-400 text-sm mb-2">Enter Serial Number *</label>
                  <input 
                    type="text" 
                    value={verifySerialInput} 
                    onChange={(e) => setVerifySerialInput(e.target.value)}
                    placeholder="Enter S/N from physical tool"
                    className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white text-center font-mono text-lg focus:border-yellow-500 focus:outline-none"
                    autoFocus
                  />
                </div>

                <div className="flex gap-3">
                  <button 
                    onClick={() => {
                      setShowToolVerifyModal(false)
                      setToolToVerify(null)
                      setVerifySerialInput('')
                    }} 
                    className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleVerifyAndAddTool} 
                    disabled={!verifySerialInput.trim()} 
                    className="flex-1 py-3 bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    <CheckCircle size={20} />
                    Verify & Add
                  </button>
                </div>
              </div>
            )}

            {verifyStep === 'mismatch' && (
              <div className="p-6 space-y-4">
                <div className="bg-red-900/30 border border-red-600/50 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="text-red-400 flex-shrink-0 mt-0.5" size={24} />
                    <div>
                      <h3 className="text-red-400 font-medium mb-1">Serial Number Mismatch</h3>
                      <p className="text-gray-300 text-sm">
                        The serial number you entered does not match the expected serial number.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="bg-gray-800 rounded-lg p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-400 text-sm">Expected:</span>
                    <span className="text-gray-500 font-mono">{toolToVerify.serial_number || 'None'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-400 text-sm">You entered:</span>
                    <span className="text-yellow-400 font-mono font-bold">{verifySerialInput}</span>
                  </div>
                </div>

                <p className="text-gray-300 text-center text-sm">
                  Is this a <strong>different tool</strong> with the serial number <strong className="text-yellow-400">{verifySerialInput}</strong>?
                </p>

                <div className="flex gap-3">
                  <button 
                    onClick={() => setVerifyStep('enter')} 
                    className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
                  >
                    ← Try Again
                  </button>
                  <button 
                    onClick={handleConfirmNewSerial} 
                    className="flex-1 py-3 bg-green-600 hover:bg-green-500 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    <CheckCircle size={20} />
                    Yes, Add Tool
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Downtime Modal */}
      {showDowntimeModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white flex items-center gap-2"><AlertTriangle className="text-red-500" size={24} />Log Downtime</h2>
                <p className="text-gray-500 text-sm">{machine.name}{activeJob && ` • ${activeJob.job_number}`}</p>
              </div>
              <button onClick={() => setShowDowntimeModal(false)} className="text-gray-400 hover:text-white"><X size={24} /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div>
                <label className="block text-gray-400 text-sm mb-2">Reason *</label>
                <select 
                  value={downtimeForm.reason} 
                  onChange={(e) => {
                    const reason = e.target.value
                    if (reason === 'Tooling change' && activeJob && currentTools.length > 0) {
                      // Close downtime modal and open tooling change modal
                      // Use the start time from downtime form if entered, otherwise use now
                      setShowDowntimeModal(false)
                      setToolChangeForm({ 
                        tool_id: '', 
                        new_serial_number: '',
                        start_time: downtimeForm.start_time || formatDateTimeLocal(new Date()),
                        duration_hours: 0,
                        duration_mins: 5
                      })
                      setShowToolChangeModal(true)
                    } else {
                      setDowntimeForm({...downtimeForm, reason})
                    }
                  }} 
                  className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-red-500 focus:outline-none"
                >
                  <option value="">Select a reason...</option>
                  {DOWNTIME_REASONS.map((reason) => (<option key={reason} value={reason}>{reason}</option>))}
                </select>
                {downtimeForm.reason === 'Tooling change' && (!activeJob || currentTools.length === 0) && (
                  <p className="text-yellow-400 text-sm mt-2">
                    Note: No tools recorded for current job. Log downtime normally or add tools first.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-gray-400 text-sm mb-2">Start Time *</label>
                <input 
                  type="datetime-local" 
                  value={downtimeForm.start_time} 
                  onChange={(e) => setDowntimeForm({...downtimeForm, start_time: e.target.value})} 
                  className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-red-500 focus:outline-none"
                  style={{ colorScheme: 'dark' }}
                />
              </div>

              {/* Toggle between End Time and Duration for resolved downtimes */}
              <div>
                <label className="block text-gray-400 text-sm mb-2">End Time / Duration (if resolved)</label>
                <div className="flex gap-2 bg-gray-800 p-1 rounded-lg mb-3">
                  <button
                    onClick={() => setDowntimeForm({...downtimeForm, use_duration: false})}
                    className={`flex-1 py-2 px-3 rounded text-sm font-medium transition-colors ${
                      !downtimeForm.use_duration ? 'bg-skynet-accent text-white' : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    End Time
                  </button>
                  <button
                    onClick={() => setDowntimeForm({...downtimeForm, use_duration: true})}
                    className={`flex-1 py-2 px-3 rounded text-sm font-medium transition-colors ${
                      downtimeForm.use_duration ? 'bg-skynet-accent text-white' : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    Duration
                  </button>
                </div>

                {!downtimeForm.use_duration ? (
                  <input 
                    type="datetime-local" 
                    value={downtimeForm.end_time} 
                    onChange={(e) => setDowntimeForm({...downtimeForm, end_time: e.target.value})} 
                    className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-skynet-accent focus:outline-none"
                    style={{ colorScheme: 'dark' }}
                  />
                ) : (
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <input 
                          type="number" 
                          min="0" 
                          value={downtimeForm.duration_hours} 
                          onChange={(e) => setDowntimeForm({...downtimeForm, duration_hours: parseInt(e.target.value) || 0})}
                          className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white text-center focus:border-skynet-accent focus:outline-none"
                        />
                        <span className="text-gray-400">hrs</span>
                      </div>
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <input 
                          type="number" 
                          min="0" 
                          max="59"
                          value={downtimeForm.duration_mins} 
                          onChange={(e) => setDowntimeForm({...downtimeForm, duration_mins: Math.min(59, parseInt(e.target.value) || 0)})}
                          className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white text-center focus:border-skynet-accent focus:outline-none"
                        />
                        <span className="text-gray-400">min</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-gray-400 text-sm mb-2">Notes</label>
                <textarea value={downtimeForm.notes} onChange={(e) => setDowntimeForm({...downtimeForm, notes: e.target.value})} rows={3} placeholder="Additional details about the downtime..." className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-skynet-accent focus:outline-none resize-none" />
              </div>

              {activeJob && (
                <div className="border border-red-800 rounded-lg p-4 space-y-4">
                  <div className="flex items-center gap-3">
                    <input type="checkbox" id="sendToScheduling" checked={downtimeForm.send_to_scheduling} onChange={(e) => setDowntimeForm({...downtimeForm, send_to_scheduling: e.target.checked})} className="w-5 h-5 rounded border-gray-700 text-red-600 focus:ring-red-500" />
                    <label htmlFor="sendToScheduling" className="text-white font-medium flex items-center gap-2"><SendHorizontal size={18} className="text-red-400" />Send Job Back to Scheduling</label>
                  </div>

                  {downtimeForm.send_to_scheduling && (
                    <div className="pl-8 space-y-3">
                      <p className="text-gray-400 text-sm">Enter pieces completed before downtime:</p>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-gray-500 text-xs mb-1">Good Pieces</label>
                          <input type="number" min="0" value={downtimeForm.good_pieces} onChange={(e) => setDowntimeForm({...downtimeForm, good_pieces: e.target.value})} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-center" />
                        </div>
                        <div>
                          <label className="block text-gray-500 text-xs mb-1">Bad Pieces</label>
                          <input type="number" min="0" value={downtimeForm.bad_pieces} onChange={(e) => setDowntimeForm({...downtimeForm, bad_pieces: e.target.value})} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-center" />
                        </div>
                      </div>
                      <div className="bg-gray-800 rounded p-2 text-center">
                        <p className="text-gray-500 text-sm">Pieces Remaining: <span className="text-yellow-400 font-medium">{activeJob.quantity - (parseInt(downtimeForm.good_pieces) || 0)}</span></p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Recent Downtime Logs */}
              {downtimeLogs.length > 0 && (
                <div>
                  <h3 className="text-gray-400 text-sm mb-2">Recent Downtime on {machine.name}</h3>
                  <div className="space-y-2 max-h-32 overflow-y-auto">
                    {downtimeLogs.slice(0, 5).map((log) => {
                      // Calculate duration
                      let durationStr = null
                      if (log.start_time && log.end_time) {
                        const durationMins = Math.round((new Date(log.end_time) - new Date(log.start_time)) / 60000)
                        durationStr = durationMins < 60 ? `${durationMins}m` : `${Math.floor(durationMins/60)}h ${durationMins%60}m`
                      }
                      return (
                        <div key={log.id} className="flex items-center justify-between p-2 bg-gray-800/50 rounded text-sm">
                          <div className="flex items-center gap-2">
                            <span className="text-gray-300">{log.reason}</span>
                            {durationStr && (
                              <span className="text-xs text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded">{durationStr}</span>
                            )}
                          </div>
                          <span className="text-gray-500 text-xs">{formatDateTime(log.start_time)}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex gap-3">
              <button onClick={() => setShowDowntimeModal(false)} className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors">Cancel</button>
              <button onClick={handleLogDowntime} disabled={actionLoading || !downtimeForm.reason || !downtimeForm.start_time} className="flex-1 py-3 bg-red-600 hover:bg-red-500 disabled:bg-gray-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2">
                {actionLoading ? <Loader2 size={20} className="animate-spin" /> : <PauseCircle size={20} />}
                {downtimeForm.send_to_scheduling ? 'Log & Send to Scheduling' : 'Log Downtime'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Out of Order Job Selection Warning Modal */}
      {showOutOfOrderWarning && pendingJobSelection && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-yellow-600 rounded-xl p-6 max-w-md w-full">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-yellow-600/20 flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-yellow-500" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Out of Queue Order</h3>
                <p className="text-sm text-gray-400">This job is not next in line</p>
              </div>
            </div>
            
            <div className="bg-gray-800 rounded-lg p-4 mb-4">
              <p className="text-gray-300 text-sm mb-3">
                You've selected <span className="text-white font-mono font-semibold">{pendingJobSelection.job_number}</span>, 
                but there {jobs.filter(j => j.status === 'assigned').length === 1 ? 'is' : 'are'} other job{jobs.filter(j => j.status === 'assigned').length === 1 ? '' : 's'} scheduled before it.
              </p>
              <p className="text-yellow-400 text-sm">
                Are you sure you want to start this job out of order?
              </p>
            </div>

            <div className="flex gap-3">
              <button 
                onClick={handleCancelOutOfOrder}
                className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleConfirmOutOfOrder}
                className="flex-1 py-3 bg-yellow-600 hover:bg-yellow-500 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                <SkipForward size={18} />
                Yes, Select This Job
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tool Serial Conflict Warning Modal */}
      {toolSerialConflict && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-red-600 rounded-xl p-6 max-w-md w-full">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-red-600/20 flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-red-500" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Tool Already Checked Out</h3>
                <p className="text-sm text-gray-400">Serial number conflict detected</p>
              </div>
            </div>
            
            <div className="bg-gray-800 rounded-lg p-4 mb-4">
              <p className="text-gray-300 text-sm mb-3">
                The tool with serial number <span className="text-white font-mono font-semibold">{toolSerialConflict.serialNumber}</span> is 
                currently checked out on:
              </p>
              <div className="bg-red-900/30 border border-red-800 rounded-lg p-3">
                <p className="text-white font-medium">{toolSerialConflict.machineName}</p>
                <p className="text-red-400 text-sm">Job: {toolSerialConflict.jobNumber}</p>
              </div>
              <p className="text-gray-400 text-sm mt-3">
                Please verify the tool is available or use a different serial number.
              </p>
            </div>

            <button 
              onClick={() => setToolSerialConflict(null)}
              className="w-full py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
            >
              OK, Got It
            </button>
          </div>
        </div>
      )}

      {/* DOWN Warning Modal - shown when logging ongoing downtime */}
      {showDownWarning && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-red-600 rounded-xl p-6 max-w-md w-full">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-red-600/20 flex items-center justify-center animate-pulse">
                <AlertTriangle className="w-6 h-6 text-red-500" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Flag Machine as DOWN?</h3>
                <p className="text-sm text-gray-400">This will alert the facility</p>
              </div>
            </div>
            
            <div className="bg-red-900/30 border border-red-800 rounded-lg p-4 mb-4">
              <p className="text-gray-300 text-sm mb-3">
                You are logging downtime for <span className="text-white font-semibold">{machine?.name}</span> without 
                specifying an end time.
              </p>
              <p className="text-red-300 text-sm font-medium">
                This will flag the machine as <span className="font-bold text-red-400">🔴 DOWN</span> facility-wide until 
                the downtime is resolved.
              </p>
            </div>

            <div className="bg-gray-800 rounded-lg p-3 mb-4">
              <p className="text-gray-400 text-xs">
                <span className="text-white font-medium">To clear the DOWN flag:</span> Edit the downtime entry in the 
                Activity Log and add an end time.
              </p>
            </div>

            <div className="flex gap-3">
              <button 
                onClick={handleCancelDown}
                className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleConfirmDown}
                disabled={actionLoading}
                className="flex-1 py-3 bg-red-600 hover:bg-red-500 disabled:bg-gray-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {actionLoading ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <AlertTriangle size={18} />
                )}
                Yes, Flag as DOWN
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="bg-gray-900 border-t border-gray-800 px-6 py-3">
        <p className="text-gray-600 text-xs text-center font-mono">SkyNet MES - Machine Kiosk • {new Date().toLocaleDateString()}</p>
      </footer>
    </div>
  )
}