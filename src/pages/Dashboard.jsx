import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { Plus, ChevronDown, AlertTriangle, Edit3, X, Loader2, Trash2, RefreshCw, Wrench, Search, ClipboardList, ChevronRight, Package, Clock, CheckCircle, Calendar, User, Beaker } from 'lucide-react'
import MachineCard from '../components/MachineCard'
import CreateWorkOrderModal from '../components/CreateWorkOrderModal'
import CreateMaintenanceModal from '../components/CreateMaintenanceModal'
import ComplianceReview from '../components/ComplianceReview'
import Assembly from '../components/Assembly'
import TCOReview from '../components/TCOReview'
import EditWorkOrderModal from '../components/EditWorkOrderModal'

export default function Dashboard({ user, profile }) {
  const [machines, setMachines] = useState([])
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showMaintenanceModal, setShowMaintenanceModal] = useState(false)
  const [expandedLocations, setExpandedLocations] = useState({})
  const [selectedView, setSelectedView] = useState('lineup')
  const [assemblyWOs, setAssemblyWOs] = useState([])
  const [assemblyCount, setAssemblyCount] = useState(0)
  const [tcoWOs, setTcoWOs] = useState([])
  
  // NEW: Track ongoing downtimes and active unplanned maintenance for DOWN status
  const [ongoingDowntimes, setOngoingDowntimes] = useState([])
  const [activeMaintenanceJobs, setActiveMaintenanceJobs] = useState([])
  
  // Auto-refresh state
  const [autoRefresh, setAutoRefresh] = useState(true) // Enabled by default
  const [lastUpdated, setLastUpdated] = useState(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const refreshIntervalRef = useRef(null)
  
  // Edit job modal state
  const [editingJob, setEditingJob] = useState(null)
  const [editForm, setEditForm] = useState({ quantity: '', priority: '' })
  const [editSaving, setEditSaving] = useState(false)
  const [showEditWarning, setShowEditWarning] = useState(true)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  
  // Work Order Lookup state
  const [showWOLookup, setShowWOLookup] = useState(false)
  const [woLookupData, setWOLookupData] = useState([])
  const [woLookupLoading, setWOLookupLoading] = useState(false)
  const [woLookupSearch, setWOLookupSearch] = useState('')
  const [expandedWOs, setExpandedWOs] = useState({})
  
  // WO Edit modal state
  const [editingWO, setEditingWO] = useState(null)
  
  // Cancel job state (two-step confirmation in WO Lookup)
  const [cancellingJobId, setCancellingJobId] = useState(null)
  const [cancelStep, setCancelStep] = useState(0) // 0=none, 1=first warning, 2=final confirmation
  const [cancelSaving, setCancelSaving] = useState(false)

  // Memoized fetch function
  const fetchData = useCallback(async (isAutoRefresh = false) => {
    try {
      if (isAutoRefresh) {
        setIsRefreshing(true)
      }
      console.log('🔄 Starting fetchData...')
      
      const { data: machinesData, error: machinesError } = await supabase
        .from('machines')
        .select(`
          *,
          location:locations(name, code)
        `)
        .eq('is_active', true)
        .order('display_order')

      if (machinesError) {
        console.error('❌ Error fetching machines:', machinesError)
      } else {
        console.log('✅ Machines fetched:', machinesData?.length || 0, 'machines')
        setMachines(machinesData || [])
      }

      const { data: jobsData, error: jobsError } = await supabase
        .from('jobs')
        .select(`
          *,
          work_order:work_orders(wo_number, customer, priority, due_date, order_type, maintenance_type, notes),
          component:parts!component_id(id, part_number, description, part_type, requires_passivation),
          assigned_machine:machines(id, name, code)
        `)
        .not('status', 'eq', 'complete')
        .not('status', 'eq', 'manufacturing_complete')
        .not('status', 'eq', 'incomplete')
        .not('status', 'eq', 'cancelled')
        .order('created_at', { ascending: true })

      if (jobsError) {
        console.error('❌ Error fetching jobs:', jobsError)
      } else {
        console.log('✅ Jobs fetched:', jobsData?.length || 0, 'jobs')
        setJobs(jobsData || [])
      }

      // NEW: Fetch ongoing downtimes (end_time IS NULL)
      const { data: ongoingDowntimesData, error: downtimeError } = await supabase
        .from('machine_downtime_logs')
        .select('*')
        .is('end_time', null)
        .order('start_time', { ascending: false })

      if (downtimeError) {
        console.error('❌ Error fetching ongoing downtimes:', downtimeError)
      } else {
        console.log('✅ Ongoing downtimes fetched:', ongoingDowntimesData?.length || 0)
        setOngoingDowntimes(ongoingDowntimesData || [])
      }

      // Fetch for assembly-ready work orders
      // An assembly is ready when ALL its linked jobs have status ready_for_assembly
      const { data: woWithJobs } = await supabase
        .from('work_orders')
        .select(`
          id,
          wo_number,
          order_type,
          work_order_assemblies (id, assembly_id, status),
          jobs (id, status, work_order_assembly_id)
        `)
        .not('order_type', 'eq', 'maintenance')

      // Count per-assembly readiness (each WOA is independent)
      let assemblyReadyCount = 0
      const assemblyReadyWOSet = new Set()
      for (const wo of (woWithJobs || [])) {
        if (wo.work_order_assemblies && wo.work_order_assemblies.length > 0) {
          for (const woa of wo.work_order_assemblies) {
            const woaJobs = wo.jobs?.filter(j => j.work_order_assembly_id === woa.id) || []
            const allReady = woaJobs.length > 0 && woaJobs.every(j =>
              ['ready_for_assembly', 'in_assembly', 'complete'].includes(j.status)
            )
            const hasWork = woaJobs.some(j =>
              ['ready_for_assembly', 'in_assembly'].includes(j.status)
            )
            if (allReady && hasWork && woa.status !== 'complete') {
              assemblyReadyCount++
              assemblyReadyWOSet.add(wo.id)
            }
          }
        } else {
          // Fallback: WO-level check for WOs without work_order_assemblies
          if (wo.jobs?.length > 0 && 
              wo.jobs.every(j => ['ready_for_assembly', 'in_assembly', 'complete'].includes(j.status)) &&
              wo.jobs.some(j => ['ready_for_assembly', 'in_assembly'].includes(j.status))) {
            assemblyReadyCount++
            assemblyReadyWOSet.add(wo.id)
          }
        }
      }

      // Store WOs for navigation (any WO that has at least one ready assembly)
      const assemblyReadyWOs = (woWithJobs || []).filter(wo => assemblyReadyWOSet.has(wo.id))
      setAssemblyWOs(assemblyReadyWOs)
      setAssemblyCount(assemblyReadyCount)

      // Count WOs pending TCO (at least one job in pending_tco)
      const tcoReadyWOs = (woWithJobs || []).filter(wo => {
        if (!wo.jobs || wo.jobs.length === 0) return false
        return wo.jobs.some(job => job.status === 'pending_tco')
      })
      setTcoWOs(tcoReadyWOs)

      // NEW: Fetch active unplanned maintenance jobs (status = in_progress or assigned, maintenance_type = unplanned)
      // that are currently scheduled (scheduled_start <= now <= scheduled_end)
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
        console.error('❌ Error fetching active maintenance jobs:', maintenanceError)
      } else {
        console.log('✅ Active unplanned maintenance jobs fetched:', activeMaintenanceData?.length || 0)
        setActiveMaintenanceJobs(activeMaintenanceData || [])
      }

      setLastUpdated(new Date())
      console.log('✅ fetchData complete!')
    } catch (error) {
      console.error('💥 Unexpected error in fetchData:', error)
    } finally {
      setLoading(false)
      setIsRefreshing(false)
    }
  }, [])

  // Initial fetch and real-time subscription
  useEffect(() => {
    fetchData()
    
    const jobsSubscription = supabase
      .channel('jobs-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, 
        () => fetchData()
      )
      .subscribe()

    // Subscribe to machine status changes
    const machinesSubscription = supabase
      .channel('machines-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'machines' }, 
        () => fetchData()
      )
      .subscribe()

    // NEW: Subscribe to downtime log changes
    const downtimeSubscription = supabase
      .channel('downtime-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'machine_downtime_logs' }, 
        () => fetchData()
      )
      .subscribe()

    return () => {
      supabase.removeChannel(jobsSubscription)
      supabase.removeChannel(machinesSubscription)
      supabase.removeChannel(downtimeSubscription)
    }
  }, [fetchData])

  // Auto-refresh interval (30 seconds)
  useEffect(() => {
    if (autoRefresh) {
      refreshIntervalRef.current = setInterval(() => {
        fetchData(true) // Pass true to indicate auto-refresh
      }, 30000) // 30 seconds
    }
    
    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current)
      }
    }
  }, [autoRefresh, fetchData])

  // Get secondary config for a machine
  const getSecondaryConfig = (machine) => {
    if (!machine) return null
    const code = machine.code?.toLowerCase() || ''
    const name = machine.name?.toLowerCase() || ''
    
    if (code.startsWith('pass') || name.includes('passivation')) {
      return {
        type: 'passivation',
        statuses: ['pending_passivation', 'in_passivation']
      }
    }
    if (code.startsWith('paint') || name.includes('paint')) {
      return {
        type: 'paint',
        statuses: ['pending_paint', 'in_paint']
      }
    }
    return null
  }

  const getJobsForMachine = (machineId) => {
    // Find the machine to check if it's a secondary operation station
    const machine = machines.find(m => m.id === machineId)
    const secondaryConfig = getSecondaryConfig(machine)
    
    if (secondaryConfig) {
      // For secondary operations (Passivation, Paint), show ALL jobs with matching status
      // These jobs are not assigned to a specific machine
      return jobs.filter(job => secondaryConfig.statuses.includes(job.status))
    }
    
    // Normal machines: show jobs assigned to this machine with active statuses
    const activeStatuses = ['assigned', 'in_setup', 'in_progress']
    return jobs.filter(job => 
      job.assigned_machine_id === machineId && 
      activeStatuses.includes(job.status)
    )
  }

  // NEW: Get ongoing downtime for a specific machine
  const getOngoingDowntimeForMachine = (machineId) => {
    return ongoingDowntimes.find(d => d.machine_id === machineId)
  }

  // NEW: Get active unplanned maintenance job for a specific machine
  const getActiveMaintenanceForMachine = (machineId) => {
    return activeMaintenanceJobs.find(j => j.assigned_machine_id === machineId)
  }

  // Fetch all active work orders with their jobs for lookup
  const fetchWOLookup = async () => {
    setWOLookupLoading(true)
    try {
      // Get all work orders with their assemblies and jobs
      const { data: workOrders, error: woError } = await supabase
        .from('work_orders')
        .select(`
          id,
          wo_number,
          customer,
          priority,
          due_date,
          order_type,
          maintenance_type,
          status,
          stock_quantity,
          created_at,
          work_order_assemblies (
            id,
            quantity,
            status,
            good_quantity,
            bad_quantity,
            assembly:parts!assembly_id(id, part_number, description)
          ),
          jobs (
            id,
            job_number,
            status,
            quantity,
            good_pieces,
            bad_pieces,
            assigned_machine_id,
            scheduled_start,
            work_order_assembly_id,
            component:parts!component_id(part_number, description)
          )
        `)
        .order('created_at', { ascending: false })

      if (woError) throw woError

      // Filter to only WOs that have jobs not in 'complete' or 'cancelled' status
      // OR include WOs where all jobs are complete (to show finished WOs)
      const activeWOs = workOrders?.filter(wo => {
        if (!wo.jobs || wo.jobs.length === 0) return false
        // Show WO if any job is not complete/cancelled
        return wo.jobs.some(j => !['complete', 'cancelled'].includes(j.status))
      }) || []

      // Also get recently completed WOs (last 7 days)
      const sevenDaysAgo = new Date()
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
      
      const completedWOs = workOrders?.filter(wo => {
        if (!wo.jobs || wo.jobs.length === 0) return false
        const allComplete = wo.jobs.every(j => ['complete', 'cancelled'].includes(j.status))
        if (!allComplete) return false
        // Check if completed recently
        const latestJob = wo.jobs.reduce((latest, j) => {
          return !latest || new Date(j.updated_at) > new Date(latest.updated_at) ? j : latest
        }, null)
        return latestJob && new Date(wo.created_at) > sevenDaysAgo
      }) || []

      setWOLookupData([...activeWOs, ...completedWOs])
    } catch (err) {
      console.error('Error fetching WO lookup data:', err)
    } finally {
      setWOLookupLoading(false)
    }
  }

  // Open WO Lookup modal
  const handleOpenWOLookup = () => {
    setShowWOLookup(true)
    setWOLookupSearch('')
    setExpandedWOs({})
    fetchWOLookup()
  }

  // Get status badge for a job
  const getStatusBadge = (status) => {
    const statusConfig = {
      pending_compliance: { label: 'Pending Compliance', color: 'bg-purple-900/50 text-purple-300 border-purple-700' },
      ready: { label: 'Ready', color: 'bg-blue-900/50 text-blue-300 border-blue-700' },
      assigned: { label: 'Assigned', color: 'bg-indigo-900/50 text-indigo-300 border-indigo-700' },
      in_setup: { label: 'In Setup', color: 'bg-cyan-900/50 text-cyan-300 border-cyan-700' },
      in_progress: { label: 'In Progress', color: 'bg-green-900/50 text-green-300 border-green-700' },
      manufacturing_complete: { label: 'Mfg Complete', color: 'bg-teal-900/50 text-teal-300 border-teal-700' },
      pending_passivation: { label: 'Pending Passivation', color: 'bg-cyan-900/50 text-cyan-300 border-cyan-700' },
      in_passivation: { label: 'In Passivation', color: 'bg-cyan-900/50 text-cyan-300 border-cyan-700' },
      pending_post_manufacturing: { label: 'Post-Mfg Review', color: 'bg-orange-900/50 text-orange-300 border-orange-700' },
      ready_for_assembly: { label: 'Ready for Assembly', color: 'bg-emerald-900/50 text-emerald-300 border-emerald-700' },
      in_assembly: { label: 'In Assembly', color: 'bg-emerald-900/50 text-emerald-300 border-emerald-700' },
      pending_tco: { label: 'Pending TCO', color: 'bg-amber-900/50 text-amber-300 border-amber-700' },
      complete: { label: 'Complete', color: 'bg-gray-800 text-gray-400 border-gray-700' },
      incomplete: { label: 'Incomplete', color: 'bg-red-900/50 text-red-300 border-red-700' },
      cancelled: { label: 'Cancelled', color: 'bg-gray-800 text-gray-500 border-gray-700' }
    }
    return statusConfig[status] || { label: status, color: 'bg-gray-800 text-gray-400 border-gray-700' }
  }

  // Filter WOs based on search
  const filteredWOLookup = woLookupData.filter(wo => {
    if (!woLookupSearch.trim()) return true
    const search = woLookupSearch.toLowerCase()
    
    // Search WO number, customer
    if (wo.wo_number?.toLowerCase().includes(search)) return true
    if (wo.customer?.toLowerCase().includes(search)) return true
    
    // Search assembly part numbers
    if (wo.work_order_assemblies?.some(woa => 
      woa.assembly?.part_number?.toLowerCase().includes(search)
    )) return true
    
    // Search job numbers and component part numbers
    return wo.jobs?.some(job => 
      job.job_number?.toLowerCase().includes(search) ||
      job.component?.part_number?.toLowerCase().includes(search)
    )
  })

  // Group machines by location
  const machinesByLocation = machines.reduce((acc, machine) => {
    const locationName = machine.location?.name || 'Unknown Location'
    if (!acc[locationName]) {
      acc[locationName] = []
    }
    acc[locationName].push(machine)
    return acc
  }, {})

  useEffect(() => {
    const initialExpanded = {}
    Object.keys(machinesByLocation).forEach(locationName => {
      initialExpanded[locationName] = true
    })
    setExpandedLocations(initialExpanded)
  }, [machines.length])

  const toggleLocation = (locationName) => {
    setExpandedLocations(prev => ({
      ...prev,
      [locationName]: !prev[locationName]
    }))
  }

  // Job categorization - incomplete jobs included with unassigned
  const pendingComplianceJobs = jobs.filter(job => 
    job.status === 'pending_compliance' || job.status === 'pending_post_manufacturing'
  )
  const incompleteJobs = jobs.filter(job => job.status === 'incomplete')
  const readyJobs = jobs.filter(job => !job.assigned_machine_id && job.status === 'ready')
  const unassignedJobs = [...incompleteJobs, ...readyJobs] // Incomplete first, then ready
  const activeJobs = jobs.filter(job => 
    job.assigned_machine_id && 
    (job.status === 'assigned' || job.status === 'in_setup' || job.status === 'in_progress')
  )

  const getPriorityColor = (priority) => {
    switch (priority) {
      case 'critical': return 'bg-red-500'
      case 'high': return 'bg-yellow-500'
      case 'normal': return 'bg-green-500'
      case 'low': return 'bg-gray-500'
      default: return 'bg-gray-500'
    }
  }

  const getPriorityBorder = (priority) => {
    switch (priority) {
      case 'critical': return 'border-red-700'
      case 'high': return 'border-yellow-700'
      case 'normal': return 'border-green-700'
      case 'low': return 'border-gray-700'
      default: return 'border-gray-700'
    }
  }

  // Get priority dot color (for WO Lookup)
  const getPriorityDot = (priority) => {
    switch (priority) {
      case 'critical': return 'bg-red-500'
      case 'high': return 'bg-yellow-500'
      case 'normal': return 'bg-green-500'
      case 'low': return 'bg-gray-500'
      default: return 'bg-gray-500'
    }
  }

  const getStatusDisplay = (status) => {
    switch (status) {
      case 'in_setup': return { text: 'Setup', color: 'text-yellow-400' }
      case 'in_progress': return { text: 'Running', color: 'text-green-400' }
      case 'assigned': return { text: 'Queued', color: 'text-blue-400' }
      case 'incomplete': return { text: 'Incomplete', color: 'text-red-400' }
      default: return { text: status.replace('_', ' '), color: 'text-gray-400' }
    }
  }

  // Edit job handlers
  const handleEditClick = (job) => {
    setEditingJob(job)
    setEditForm({
      quantity: job.quantity.toString(),
      priority: job.priority
    })
    setShowEditWarning(true)
    setShowCancelConfirm(false)
  }

  const handleEditSave = async () => {
    if (!editingJob) return
    
    setEditSaving(true)
    try {
      // Update job and reset to pending_compliance
      const { error } = await supabase
        .from('jobs')
        .update({
          quantity: parseInt(editForm.quantity),
          priority: editForm.priority,
          status: 'pending_compliance', // Must go back through compliance
          updated_at: new Date().toISOString()
        })
        .eq('id', editingJob.id)
      
      if (error) {
        console.error('Error updating job:', error)
        alert('Failed to update job')
      } else {
        setEditingJob(null)
        fetchData()
      }
    } catch (err) {
      console.error('Unexpected error:', err)
    } finally {
      setEditSaving(false)
    }
  }

  const handleCancelJob = async () => {
    if (!editingJob) return
    
    setCancelling(true)
    try {
      // Soft delete - set status to cancelled
      const { error } = await supabase
        .from('jobs')
        .update({
          status: 'cancelled',
          updated_at: new Date().toISOString()
        })
        .eq('id', editingJob.id)
      
      if (error) {
        console.error('Error cancelling job:', error)
        alert('Failed to cancel job')
      } else {
        setEditingJob(null)
        setShowCancelConfirm(false)
        fetchData()
      }
    } catch (err) {
      console.error('Unexpected error:', err)
    } finally {
      setCancelling(false)
    }
  }

  // WO Lookup cancel job - two-step confirmation
  const handleWOLookupCancelStart = (jobId) => {
    setCancellingJobId(jobId)
    setCancelStep(1)
  }

  const handleWOLookupCancelConfirm = async () => {
    if (!cancellingJobId) return
    
    setCancelSaving(true)
    try {
      const { error } = await supabase
        .from('jobs')
        .update({
          status: 'cancelled',
          updated_at: new Date().toISOString()
        })
        .eq('id', cancellingJobId)
      
      if (error) {
        console.error('Error cancelling job:', error)
        alert('Failed to cancel job')
      } else {
        setCancellingJobId(null)
        setCancelStep(0)
        fetchWOLookup()
        fetchData()
      }
    } catch (err) {
      console.error('Unexpected error:', err)
    } finally {
      setCancelSaving(false)
    }
  }

  const handleWOLookupCancelDismiss = () => {
    setCancellingJobId(null)
    setCancelStep(0)
  }

  const StatCard = ({ id, label, value, colorClass = 'text-white', borderClass = 'border-gray-800', onClick, alert = false }) => {
    const isSelected = selectedView === id
    return (
      <button
        onClick={() => onClick(id)}
        className={`bg-gray-900 rounded-lg border p-4 text-left transition-all relative ${
          isSelected 
            ? 'border-skynet-accent ring-2 ring-skynet-accent/50' 
            : borderClass + ' hover:border-gray-600'
        }`}
      >
        {alert && value > 0 && (
          <span className="absolute -top-1 -right-1 flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
          </span>
        )}
        <p className={`text-sm ${isSelected ? 'text-skynet-accent' : 'text-gray-500'}`}>{label}</p>
        <p className={`text-2xl font-bold ${colorClass}`}>{value}</p>
      </button>
    )
  }

  // NEW: Count machines that are effectively DOWN
  const machinesDownCount = machines.filter(m => 
    m.status === 'down' || 
    getOngoingDowntimeForMachine(m.id) || 
    getActiveMaintenanceForMachine(m.id)
  ).length

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-skynet-accent border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-500 font-mono">Loading machine status...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 pb-12">
      {/* Action Bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h2 className="text-xl font-semibold text-white">Machine Status</h2>
          
          {/* DOWN machines indicator */}
          {machinesDownCount > 0 && (
            <span className="flex items-center gap-1.5 px-2 py-1 bg-red-900/30 text-red-400 border border-red-800 rounded text-xs font-medium animate-pulse">
              <AlertTriangle size={12} />
              {machinesDownCount} DOWN
            </span>
          )}
          
          {/* Auto-refresh indicator */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors ${
                autoRefresh 
                  ? 'bg-green-900/30 text-green-400 border border-green-800 hover:bg-green-900/50' 
                  : 'bg-gray-800 text-gray-500 border border-gray-700 hover:bg-gray-700'
              }`}
              title={autoRefresh ? 'Auto-refresh enabled (30s)' : 'Auto-refresh disabled'}
            >
              <RefreshCw size={12} className={isRefreshing ? 'animate-spin' : ''} />
              <span>{autoRefresh ? 'Auto' : 'Manual'}</span>
            </button>
            {lastUpdated && (
              <span className="text-xs text-gray-500">
                Updated {lastUpdated.toLocaleTimeString()}
              </span>
            )}
            {!autoRefresh && (
              <button
                onClick={() => fetchData(true)}
                disabled={isRefreshing}
                className="flex items-center gap-1 px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded text-xs transition-colors disabled:opacity-50"
              >
                <RefreshCw size={12} className={isRefreshing ? 'animate-spin' : ''} />
                Refresh
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleOpenWOLookup}
            className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white font-medium rounded transition-colors"
          >
            <ClipboardList size={20} />
            <span className="hidden sm:inline">Work Orders</span>
          </button>
          <button
            onClick={() => setShowMaintenanceModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white font-medium rounded transition-colors"
          >
            <Wrench size={20} />
            <span className="hidden sm:inline">Maintenance Order</span>
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white font-medium rounded transition-colors"
          >
            <Plus size={20} />
            New Work Order
          </button>
        </div>
      </div>

      {/* Stats Bar - ordered to follow process flow */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard
          id="lineup"
          label="Machine Lineup"
          value={machines.length}
          onClick={setSelectedView}
        />
        <StatCard
          id="compliance"
          label="Pending Compliance"
          value={pendingComplianceJobs.length}
          colorClass="text-purple-400"
          borderClass={pendingComplianceJobs.length > 0 ? 'border-purple-800' : 'border-gray-800'}
          onClick={setSelectedView}
        />
        <StatCard
          id="unassigned"
          label="Unassigned"
          value={unassignedJobs.length}
          colorClass={incompleteJobs.length > 0 ? 'text-red-500' : 'text-yellow-500'}
          borderClass={incompleteJobs.length > 0 ? 'border-red-800' : (unassignedJobs.length > 0 ? 'border-yellow-800' : 'border-gray-800')}
          onClick={setSelectedView}
          alert={incompleteJobs.length > 0}
        />
        <StatCard
          id="active"
          label="Active Jobs"
          value={activeJobs.length}
          colorClass="text-skynet-accent"
          onClick={setSelectedView}
        />
        <StatCard
          id="assembly"
          label="Assembly"
          value={assemblyCount}
          colorClass="text-green-400"
          borderClass={assemblyCount > 0 ? 'border-green-800' : 'border-gray-800'}
          onClick={setSelectedView}
        />
        <StatCard
          id="tco"
          label="TCO Review"
          value={tcoWOs.length}
          colorClass="text-amber-400"
          borderClass={tcoWOs.length > 0 ? 'border-amber-800' : 'border-gray-800'}
          onClick={setSelectedView}
        />
      </div>

      {/* Priority Legend */}
      <div className="flex items-center gap-6 text-sm flex-wrap">
        <span className="text-gray-500">Priority:</span>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-red-500"></div>
          <span className="text-gray-400">Critical</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
          <span className="text-gray-400">High</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-green-500"></div>
          <span className="text-gray-400">Normal</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-gray-500"></div>
          <span className="text-gray-400">Low</span>
        </div>
        <span className="text-gray-600">|</span>
        <span className="text-gray-500">Maintenance:</span>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-purple-500"></div>
          <span className="text-gray-400">Unplanned</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-blue-500"></div>
          <span className="text-gray-400">Planned</span>
        </div>
      </div>

      {/* Machine Lineup View */}
      {selectedView === 'lineup' && (
        <>
          {Object.keys(machinesByLocation).length === 0 ? (
            <div className="bg-gray-900 rounded-lg border border-gray-800 p-8 text-center">
              <p className="text-gray-500">No machines configured</p>
            </div>
          ) : (
            <div className="space-y-6">
              {Object.entries(machinesByLocation).map(([locationName, locationMachines]) => (
                <div key={locationName} className="space-y-3">
                  <button
                    onClick={() => toggleLocation(locationName)}
                    className="w-full flex items-center gap-3 pb-2 border-b border-gray-800 hover:border-gray-700 transition-colors cursor-pointer group"
                  >
                    <div className="w-2 h-2 bg-skynet-accent rounded-full"></div>
                    <h3 className="text-lg font-semibold text-white group-hover:text-skynet-accent transition-colors">
                      {locationName}
                    </h3>
                    <span className="text-gray-500 text-sm">
                      ({locationMachines.length} {locationMachines.length === 1 ? 'machine' : 'machines'})
                    </span>
                    <ChevronDown 
                      size={20} 
                      className={`ml-auto text-gray-500 group-hover:text-skynet-accent transition-all ${
                        expandedLocations[locationName] ? 'rotate-0' : '-rotate-90'
                      }`}
                    />
                  </button>

                  {expandedLocations[locationName] && (
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
                      {locationMachines.map(machine => (
                        <MachineCard 
                          key={machine.id} 
                          machine={machine} 
                          jobs={getJobsForMachine(machine.id)}
                          getPriorityColor={getPriorityColor}
                          ongoingDowntime={getOngoingDowntimeForMachine(machine.id)}
                          activeMaintenanceJob={getActiveMaintenanceForMachine(machine.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Active Jobs View - Updated to show status */}
      {selectedView === 'active' && (
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
          <h3 className="text-skynet-accent font-semibold mb-3 flex items-center gap-2">
            <span className="w-2 h-2 bg-skynet-accent rounded-full"></span>
            Active Jobs ({activeJobs.length})
          </h3>
          {activeJobs.length === 0 ? (
            <p className="text-gray-500 text-center py-8">No jobs currently in the lineup</p>
          ) : (
            <div className="space-y-2">
              {activeJobs.map(job => {
                const statusDisplay = getStatusDisplay(job.status)
                const isMaintenance = job.is_maintenance || job.work_order?.order_type === 'maintenance'
                const maintenanceType = job.work_order?.maintenance_type
                return (
                  <div 
                    key={job.id} 
                    className={`flex items-center justify-between rounded p-3 border-l-4 ${
                      isMaintenance 
                        ? maintenanceType === 'unplanned' 
                          ? 'bg-purple-900/20 border-purple-600' 
                          : 'bg-blue-900/20 border-blue-600'
                        : `bg-gray-800 ${getPriorityBorder(job.priority)}`
                    }`}
                  >
                    <div className="flex items-center gap-4">
                      {isMaintenance ? (
                        <Wrench size={16} className={maintenanceType === 'unplanned' ? 'text-purple-400' : 'text-blue-400'} />
                      ) : (
                        <div className={`w-3 h-3 rounded-full ${getPriorityColor(job.priority)}`}></div>
                      )}
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-white font-mono">{job.job_number}</span>
                          <span className="text-gray-500">•</span>
                          <span className="text-gray-400">{job.work_order?.wo_number}</span>
                          {isMaintenance && (
                            <span className={`text-xs px-1.5 py-0.5 rounded ${
                              maintenanceType === 'unplanned' 
                                ? 'bg-purple-600 text-white' 
                                : 'bg-blue-600 text-white'
                            }`}>
                              {maintenanceType === 'unplanned' ? 'UNPLANNED' : 'PLANNED'}
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-gray-500">
                          {isMaintenance ? (
                            <span className={maintenanceType === 'unplanned' ? 'text-purple-400' : 'text-blue-400'}>
                              {job.maintenance_description || job.work_order?.notes || 'Maintenance'}
                            </span>
                          ) : (
                            <>
                              <span className="text-skynet-accent">{job.component?.part_number}</span>
                              <span className="mx-2">•</span>
                              <span>Qty: {job.quantity}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-skynet-accent text-sm">{job.assigned_machine?.name}</span>
                      <p className={`text-xs ${statusDisplay.color}`}>{statusDisplay.text}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Pending Compliance View */}
      {selectedView === 'compliance' && (
        <>
          {jobs.length === 0 ? (
            <div className="bg-gray-900 rounded-lg border border-gray-800 p-8 text-center">
              <p className="text-gray-500">No jobs in the system</p>
            </div>
          ) : (
            <ComplianceReview 
              jobs={jobs} 
              onUpdate={fetchData}
              profile={profile}
            />
          )}
        </>
      )}

      {/* Unassigned Jobs View - includes incomplete jobs */}
      {selectedView === 'unassigned' && (
        <div className={`bg-gray-900 rounded-lg border p-4 ${incompleteJobs.length > 0 ? 'border-red-800' : 'border-yellow-800'}`}>
          <h3 className={`font-semibold mb-3 flex items-center gap-2 ${incompleteJobs.length > 0 ? 'text-yellow-500' : 'text-yellow-500'}`}>
            <span className={`w-2 h-2 rounded-full animate-pulse ${incompleteJobs.length > 0 ? 'bg-red-500' : 'bg-yellow-500'}`}></span>
            Ready for Assignment ({unassignedJobs.length})
            {incompleteJobs.length > 0 && (
              <span className="ml-2 text-xs text-red-400 bg-red-900/30 px-2 py-0.5 rounded flex items-center gap-1">
                <AlertTriangle size={12} />
                {incompleteJobs.length} needs reschedule
              </span>
            )}
          </h3>
          {unassignedJobs.length === 0 ? (
            <p className="text-gray-500 text-center py-8">No jobs awaiting assignment</p>
          ) : (
            <div className="space-y-2">
              {unassignedJobs.map(job => {
                const isIncomplete = job.status === 'incomplete'
                return (
                  <div 
                    key={job.id} 
                    className={`rounded p-3 border-l-4 ${
                      isIncomplete 
                        ? 'bg-red-900/20 border-red-700 ring-1 ring-red-800/50' 
                        : `bg-gray-800 ${getPriorityBorder(job.priority)}`
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-4">
                        <div className={`w-3 h-3 rounded-full mt-1 ${getPriorityColor(job.priority)}`}></div>
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`font-mono ${isIncomplete ? 'text-red-300' : 'text-white'}`}>{job.job_number}</span>
                            <span className="text-gray-500">•</span>
                            <span className="text-gray-400">{job.work_order?.wo_number}</span>
                            {isIncomplete && (
                              <span className="text-xs bg-red-900/50 text-red-400 px-2 py-0.5 rounded flex items-center gap-1">
                                <AlertTriangle size={10} />
                                Incomplete
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-gray-500">
                            <span className="text-skynet-accent">{job.component?.part_number}</span>
                            <span className="mx-2">•</span>
                            <span>Qty: {job.quantity}</span>
                          </div>
                          {/* Incomplete job details */}
                          {isIncomplete && job.incomplete_reason && (
                            <div className="mt-2 text-xs text-red-300">
                              Reason: {job.incomplete_reason}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="text-right flex flex-col items-end gap-2">
                        {isIncomplete ? (
                          <>
                            <div className="text-sm text-gray-400">
                              <span className="text-green-400">{job.good_pieces || 0}</span>
                              <span className="text-gray-600"> / </span>
                              <span className="text-red-400">{job.bad_pieces || 0}</span>
                              <span className="text-gray-500 text-xs"> pcs</span>
                            </div>
                            <div className="text-xs text-gray-500">
                              Remaining: <span className="text-yellow-400 font-medium">
                                {job.quantity - (job.good_pieces || 0)}
                              </span>
                            </div>
                          </>
                        ) : (
                          <span className="text-yellow-500 text-sm">Needs Assignment</span>
                        )}
                        {/* Edit button - only for ready jobs, not incomplete */}
                        {!isIncomplete && (
                          <button
                            onClick={() => handleEditClick(job)}
                            className="flex items-center gap-1 text-xs text-gray-400 hover:text-skynet-accent transition-colors px-2 py-1 rounded hover:bg-gray-700"
                          >
                            <Edit3 size={12} />
                            Edit
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Edit Job Modal */}
      {editingJob && (
        <div 
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setEditingJob(null)}
        >
          <div 
            className="bg-gray-900 rounded-lg border border-gray-700 p-6 max-w-md w-full mx-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-white flex items-center gap-2">
                  <Edit3 size={20} className="text-skynet-accent" />
                  Edit Job
                </h3>
                <p className="text-gray-400">{editingJob.job_number}</p>
              </div>
              <button
                onClick={() => setEditingJob(null)}
                className="text-gray-500 hover:text-white transition-colors"
              >
                <X size={24} />
              </button>
            </div>

            {/* Warning Banner - only show when not in cancel mode */}
            {showEditWarning && !showCancelConfirm && (
              <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg p-4 mb-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={20} className="text-yellow-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-yellow-400 font-medium">Compliance Review Required</p>
                    <p className="text-yellow-300/70 text-sm mt-1">
                      Edited jobs must go back through the compliance review stage before they can be scheduled.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Job Info */}
            <div className="bg-gray-800 rounded-lg p-3 mb-4">
              <p className="text-skynet-accent font-mono">{editingJob.component?.part_number}</p>
              <p className="text-gray-400 text-sm">{editingJob.work_order?.wo_number}</p>
            </div>

            {/* Cancel Confirmation View */}
            {showCancelConfirm ? (
              <div className="space-y-4">
                <div className="bg-red-900/30 border border-red-700 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <Trash2 size={20} className="text-red-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-red-400 font-medium">Cancel this job?</p>
                      <p className="text-red-300/70 text-sm mt-1">
                        This will permanently cancel <span className="font-mono text-white">{editingJob.job_number}</span>. 
                        The job will be removed from all queues and cannot be recovered.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-3 pt-4 border-t border-gray-700">
                  <button
                    onClick={() => setShowCancelConfirm(false)}
                    className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
                  >
                    Go Back
                  </button>
                  <button
                    onClick={handleCancelJob}
                    disabled={cancelling}
                    className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 text-white font-medium rounded transition-colors disabled:opacity-50"
                  >
                    {cancelling ? (
                      <>
                        <Loader2 size={16} className="animate-spin" />
                        Cancelling...
                      </>
                    ) : (
                      <>
                        <Trash2 size={16} />
                        Yes, Cancel Job
                      </>
                    )}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* Edit Form */}
                <div className="space-y-4">
                  <div>
                    <label className="block text-gray-400 text-sm mb-1">Quantity</label>
                    <input
                      type="number"
                      min="1"
                      value={editForm.quantity}
                      onChange={(e) => setEditForm(prev => ({ ...prev, quantity: e.target.value }))}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
                    />
                  </div>

                  <div>
                    <label className="block text-gray-400 text-sm mb-1">Priority</label>
                    <select
                      value={editForm.priority}
                      onChange={(e) => setEditForm(prev => ({ ...prev, priority: e.target.value }))}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
                    >
                      <option value="critical">Critical</option>
                      <option value="high">High</option>
                      <option value="normal">Normal</option>
                      <option value="low">Low</option>
                    </select>
                  </div>
                </div>

                {/* Cancel Job Button */}
                <button
                  onClick={() => setShowCancelConfirm(true)}
                  className="w-full mt-4 py-2 px-3 text-red-400 hover:text-red-300 hover:bg-red-900/20 border border-red-800/50 hover:border-red-700 rounded transition-colors flex items-center justify-center gap-2 text-sm"
                >
                  <Trash2 size={14} />
                  Cancel Job
                </button>

                {/* Actions */}
                <div className="flex items-center justify-end gap-3 mt-4 pt-4 border-t border-gray-700">
                  <button
                    onClick={() => setEditingJob(null)}
                    className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
                  >
                    Close
                  </button>
                  <button
                    onClick={handleEditSave}
                    disabled={editSaving || !editForm.quantity}
                    className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white font-medium rounded transition-colors disabled:opacity-50"
                  >
                    {editSaving ? (
                      <>
                        <Loader2 size={16} className="animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Edit3 size={16} />
                        Save & Send to Compliance
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Create Work Order Modal */}
      <CreateWorkOrderModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSuccess={fetchData}
      />

      {/* Create Maintenance Modal */}
      <CreateMaintenanceModal
        isOpen={showMaintenanceModal}
        onClose={() => setShowMaintenanceModal(false)}
        onSuccess={fetchData}
        machines={machines}
      />

      {/* Assembly View */}
      {selectedView === 'assembly' && (
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
          <Assembly profile={profile} onUpdate={fetchData} />
        </div>
      )}

      {/* TCO Review View */}
      {selectedView === 'tco' && (
        <TCOReview profile={profile} onUpdate={fetchData} />
      )}

      {/* Work Order Lookup Modal */}
      {showWOLookup && (
        <div className="fixed inset-0 bg-black/70 flex items-start justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-4xl my-8 max-h-[85vh] flex flex-col">
            {/* Header */}
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-3">
                <ClipboardList className="text-skynet-accent" size={24} />
                <div>
                  <h2 className="text-xl font-semibold text-white">Work Order Lookup</h2>
                  <p className="text-gray-500 text-sm">View all active work orders and job statuses</p>
                </div>
              </div>
              <button 
                onClick={() => setShowWOLookup(false)} 
                className="text-gray-400 hover:text-white p-2"
              >
                <X size={24} />
              </button>
            </div>

            {/* Search Bar */}
            <div className="px-6 py-4 border-b border-gray-800 flex-shrink-0">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={20} />
                <input
                  type="text"
                  placeholder="Search by WO#, Job#, Customer, or Part#..."
                  value={woLookupSearch}
                  onChange={(e) => setWOLookupSearch(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-skynet-accent focus:outline-none"
                  autoFocus
                />
                {woLookupSearch && (
                  <button
                    onClick={() => setWOLookupSearch('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
              {woLookupLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={32} className="animate-spin text-skynet-accent" />
                </div>
              ) : filteredWOLookup.length === 0 ? (
                <div className="text-center py-12">
                  <ClipboardList size={48} className="mx-auto text-gray-600 mb-4" />
                  <p className="text-gray-500">
                    {woLookupSearch ? 'No matching work orders found' : 'No active work orders'}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredWOLookup.map(wo => {
                    const isExpanded = expandedWOs[wo.id]
                    const allJobsComplete = wo.jobs?.every(j => ['complete', 'cancelled'].includes(j.status))
                    const readyForAssemblyCount = wo.jobs?.filter(j => j.status === 'ready_for_assembly').length || 0
                    const totalJobs = wo.jobs?.length || 0
                    
                    return (
                      <div key={wo.id} className={`border rounded-lg overflow-hidden ${
                        allJobsComplete 
                          ? 'border-gray-700 bg-gray-800/30' 
                          : readyForAssemblyCount === totalJobs 
                            ? 'border-emerald-700 bg-emerald-900/20'
                            : 'border-gray-700 bg-gray-800/50'
                      }`}>
                        {/* WO Header Row */}
                        <div
                          onClick={() => setExpandedWOs(prev => ({ ...prev, [wo.id]: !prev[wo.id] }))}
                          className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-800/50 transition-colors cursor-pointer"
                        >
                          <div className="flex items-center gap-4">
                            <ChevronRight 
                              size={20} 
                              className={`text-gray-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`} 
                            />
                            <div className={`w-2.5 h-2.5 rounded-full ${getPriorityDot(wo.priority)}`} />
                            <div className="text-left">
                              <div className="flex items-center gap-2">
                                <span className="text-white font-mono font-medium">{wo.wo_number}</span>
                                {wo.order_type === 'maintenance' && (
                                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                                    wo.maintenance_type === 'unplanned' 
                                      ? 'bg-purple-900/50 text-purple-300' 
                                      : 'bg-blue-900/50 text-blue-300'
                                  }`}>
                                    {wo.maintenance_type === 'unplanned' ? 'UNPLANNED' : 'PLANNED'}
                                  </span>
                                )}
                                {allJobsComplete && (
                                  <span className="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">
                                    COMPLETE
                                  </span>
                                )}
                                {readyForAssemblyCount === totalJobs && !allJobsComplete && (
                                  <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-900/50 text-emerald-300">
                                    READY FOR ASSEMBLY
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-3 text-sm text-gray-400">
                                <span className="flex items-center gap-1">
                                  <User size={12} />
                                  {wo.customer}
                                </span>
                                <span className="flex items-center gap-1">
                                  <Calendar size={12} />
                                  Due: {wo.due_date ? new Date(wo.due_date).toLocaleDateString() : 'N/A'}
                                </span>
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            {/* Edit WO button - only for non-maintenance orders */}
                            {wo.order_type !== 'maintenance' && !allJobsComplete && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setEditingWO(wo)
                                }}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs border border-skynet-accent/50 text-skynet-accent hover:bg-skynet-accent/10 transition-colors"
                                title="Edit work order"
                              >
                                <Edit3 size={12} />
                                Edit
                              </button>
                            )}
                            <div className="text-right">
                              <span className="text-sm text-gray-400">
                                {wo.jobs?.filter(j => j.status === 'complete').length || 0}/{totalJobs} complete
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Expanded Assembly & Jobs Hierarchy */}
                        {isExpanded && (
                          <div className="border-t border-gray-700 bg-gray-900/50">
                            {/* Show assemblies with their jobs */}
                            {wo.work_order_assemblies && wo.work_order_assemblies.length > 0 ? (
                              wo.work_order_assemblies.map(woa => {
                                // Only show jobs actually linked to THIS assembly
                                const assemblyJobs = wo.jobs?.filter(j => j.work_order_assembly_id === woa.id) || []
                                
                                return (
                                  <div key={woa.id}>
                                    {/* Assembly Header */}
                                    <div className="px-4 py-3 bg-gray-800/50 border-b border-gray-700">
                                      <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                          <Package size={18} className="text-skynet-accent" />
                                          <div>
                                            <span className="text-skynet-accent font-mono font-medium">
                                              {woa.assembly?.part_number || 'Unknown Assembly'}
                                            </span>
                                            <p className="text-xs text-gray-400">{woa.assembly?.description}</p>
                                          </div>
                                        </div>
                                        <div className="flex items-center gap-3 text-sm">
                                          <span className="text-gray-500">Qty: {woa.quantity}</span>
                                          {woa.status === 'complete' && (
                                            <span className="text-xs px-2 py-0.5 bg-gray-700 text-gray-400 rounded">
                                              {woa.good_quantity}/{woa.quantity} good
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    </div>

                                    {/* Jobs under this assembly */}
                                    {assemblyJobs.length > 0 ? (
                                      <>
                                        <div className="px-4 py-2 pl-10 bg-gray-800/20 border-b border-gray-700">
                                          <div className="grid grid-cols-12 gap-2 text-xs text-gray-500 font-medium">
                                            <div className="col-span-2">Job #</div>
                                            <div className="col-span-3">Component</div>
                                            <div className="col-span-1 text-center">Qty</div>
                                            <div className="col-span-2">Status</div>
                                            <div className="col-span-2">Progress</div>
                                            <div className="col-span-2 text-right">Actions</div>
                                          </div>
                                        </div>
                                        {assemblyJobs.map(job => {
                                          const statusBadge = getStatusBadge(job.status)
                                          const canCancel = !['complete', 'cancelled'].includes(job.status)
                                          return (
                                            <div 
                                              key={job.id} 
                                              className="px-4 py-3 pl-10 border-b border-gray-800 last:border-b-0 hover:bg-gray-800/30"
                                            >
                                              <div className="grid grid-cols-12 gap-2 items-center">
                                                <div className="col-span-2">
                                                  <span className="text-white font-mono text-sm">{job.job_number}</span>
                                                </div>
                                                <div className="col-span-3">
                                                  <div className="flex items-center gap-2">
                                                    <Wrench size={12} className="text-gray-500" />
                                                    <div>
                                                      <span className="text-gray-300 text-sm font-mono">{job.component?.part_number}</span>
                                                      <p className="text-xs text-gray-500 truncate max-w-[150px]">{job.component?.description}</p>
                                                    </div>
                                                  </div>
                                                </div>
                                                <div className="col-span-1 text-center">
                                                  <span className="text-white text-sm">{job.quantity}</span>
                                                </div>
                                                <div className="col-span-2">
                                                  <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs border ${statusBadge.color}`}>
                                                    {job.status === 'in_progress' && <Clock size={10} className="animate-pulse" />}
                                                    {job.status === 'complete' && <CheckCircle size={10} />}
                                                    {(job.status === 'pending_passivation' || job.status === 'in_passivation') && <Beaker size={10} />}
                                                    {statusBadge.label}
                                                  </span>
                                                </div>
                                                <div className="col-span-2 text-sm text-gray-400">
                                                  {job.status === 'complete' && job.good_pieces !== null && (
                                                    <span>{job.good_pieces}/{job.quantity} good</span>
                                                  )}
                                                  {job.status === 'assigned' && job.scheduled_start && (
                                                    <span>Sched: {new Date(job.scheduled_start).toLocaleDateString()}</span>
                                                  )}
                                                  {['in_setup', 'in_progress'].includes(job.status) && (
                                                    <span className="text-green-400">• Active</span>
                                                  )}
                                                </div>
                                                <div className="col-span-2 text-right">
                                                  {canCancel && (
                                                    <button
                                                      onClick={() => handleWOLookupCancelStart(job.id)}
                                                      className="inline-flex items-center gap-1 px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-900/30 border border-red-800/50 hover:border-red-700 rounded transition-colors"
                                                    >
                                                      <X size={12} />
                                                      Cancel
                                                    </button>
                                                  )}
                                                </div>
                                              </div>
                                            </div>
                                          )
                                        })}
                                      </>
                                    ) : (
                                      <div className="px-4 py-3 pl-10 text-sm text-gray-500 italic border-b border-gray-700">
                                        No jobs linked to this assembly
                                      </div>
                                    )}
                                  </div>
                                )
                              })
                            ) : wo.jobs && wo.jobs.length > 0 ? (
                              // Fallback: No assemblies, just show jobs directly (maintenance orders, etc.)
                              <>
                                <div className="px-4 py-2 bg-gray-800/30 border-b border-gray-700">
                                  <div className="grid grid-cols-12 gap-2 text-xs text-gray-500 font-medium">
                                    <div className="col-span-2">Job #</div>
                                    <div className="col-span-3">Part</div>
                                    <div className="col-span-1 text-center">Qty</div>
                                    <div className="col-span-2">Status</div>
                                    <div className="col-span-2">Progress</div>
                                    <div className="col-span-2 text-right">Actions</div>
                                  </div>
                                </div>
                                {wo.jobs.map(job => {
                                  const statusBadge = getStatusBadge(job.status)
                                  const canCancel = !['complete', 'cancelled'].includes(job.status)
                                  return (
                                    <div 
                                      key={job.id} 
                                      className="px-4 py-3 border-b border-gray-800 last:border-b-0 hover:bg-gray-800/30"
                                    >
                                      <div className="grid grid-cols-12 gap-2 items-center">
                                        <div className="col-span-2">
                                          <span className="text-white font-mono text-sm">{job.job_number}</span>
                                        </div>
                                        <div className="col-span-3">
                                          <div className="flex items-center gap-2">
                                            <Package size={14} className="text-gray-500" />
                                            <div>
                                              <span className="text-skynet-accent text-sm font-mono">{job.component?.part_number}</span>
                                              <p className="text-xs text-gray-500 truncate max-w-[150px]">{job.component?.description}</p>
                                            </div>
                                          </div>
                                        </div>
                                        <div className="col-span-1 text-center">
                                          <span className="text-white text-sm">{job.quantity}</span>
                                        </div>
                                        <div className="col-span-2">
                                          <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs border ${statusBadge.color}`}>
                                            {job.status === 'in_progress' && <Clock size={10} className="animate-pulse" />}
                                            {job.status === 'complete' && <CheckCircle size={10} />}
                                            {(job.status === 'pending_passivation' || job.status === 'in_passivation') && <Beaker size={10} />}
                                            {statusBadge.label}
                                          </span>
                                        </div>
                                        <div className="col-span-2 text-sm text-gray-400">
                                          {job.status === 'complete' && job.good_pieces !== null && (
                                            <span>{job.good_pieces}/{job.quantity} good</span>
                                          )}
                                          {job.status === 'assigned' && job.scheduled_start && (
                                            <span>Sched: {new Date(job.scheduled_start).toLocaleDateString()}</span>
                                          )}
                                          {['in_setup', 'in_progress'].includes(job.status) && (
                                            <span className="text-green-400">• Active</span>
                                          )}
                                        </div>
                                        <div className="col-span-2 text-right">
                                          {canCancel && (
                                            <button
                                              onClick={() => handleWOLookupCancelStart(job.id)}
                                              className="inline-flex items-center gap-1 px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-900/30 border border-red-800/50 hover:border-red-700 rounded transition-colors"
                                            >
                                              <X size={12} />
                                              Cancel
                                            </button>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  )
                                })}
                              </>
                            ) : (
                              <div className="px-4 py-6 text-center text-gray-500">
                                No jobs found for this work order
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-between flex-shrink-0 bg-gray-900">
              <span className="text-sm text-gray-500">
                {filteredWOLookup.length} work order{filteredWOLookup.length !== 1 ? 's' : ''} found
              </span>
              <button
                onClick={fetchWOLookup}
                disabled={woLookupLoading}
                className="flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-sm transition-colors disabled:opacity-50"
              >
                <RefreshCw size={16} className={woLookupLoading ? 'animate-spin' : ''} />
                Refresh
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Work Order Modal */}
      {editingWO && (
        <EditWorkOrderModal
          isOpen={!!editingWO}
          onClose={() => setEditingWO(null)}
          workOrder={editingWO}
          onSuccess={() => {
            fetchWOLookup()
            fetchData()
          }}
        />
      )}

      {/* Cancel Job Confirmation Modal (Two-Step) */}
      {cancellingJobId && cancelStep > 0 && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60]" onClick={handleWOLookupCancelDismiss}>
          <div className="bg-gray-900 rounded-lg border border-gray-700 p-6 max-w-md w-full mx-4 shadow-xl" onClick={e => e.stopPropagation()}>
            {cancelStep === 1 ? (
              <>
                {/* Step 1: First Warning */}
                <div className="flex items-start gap-3 mb-4">
                  <div className="p-2 bg-yellow-900/30 rounded-lg">
                    <AlertTriangle size={24} className="text-yellow-500" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-white">Cancel This Job?</h3>
                    <p className="text-gray-400 text-sm mt-1">
                      This action will remove the job from all queues. Are you sure you want to proceed?
                    </p>
                  </div>
                </div>
                <div className="bg-yellow-900/20 border border-yellow-800 rounded-lg p-3 mb-6">
                  <p className="text-yellow-300 text-sm">
                    ⚠ Cancelled jobs cannot be restarted. You would need to create a new work order to replace this job.
                  </p>
                </div>
                <div className="flex items-center justify-end gap-3">
                  <button
                    onClick={handleWOLookupCancelDismiss}
                    className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
                  >
                    Never Mind
                  </button>
                  <button
                    onClick={() => setCancelStep(2)}
                    className="flex items-center gap-2 px-4 py-2 bg-red-700 hover:bg-red-600 text-white font-medium rounded transition-colors"
                  >
                    <AlertTriangle size={16} />
                    Yes, I Want to Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                {/* Step 2: Final Confirmation */}
                <div className="flex items-start gap-3 mb-4">
                  <div className="p-2 bg-red-900/30 rounded-lg">
                    <Trash2 size={24} className="text-red-500" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-red-400">Final Confirmation</h3>
                    <p className="text-gray-400 text-sm mt-1">
                      This is permanent. The job will be marked as cancelled and removed from all workflows.
                    </p>
                  </div>
                </div>
                <div className="bg-red-900/20 border border-red-800 rounded-lg p-3 mb-6">
                  <p className="text-red-300 text-sm font-medium">
                    🚫 This cannot be undone. The job will be permanently cancelled.
                  </p>
                </div>
                <div className="flex items-center justify-end gap-3">
                  <button
                    onClick={handleWOLookupCancelDismiss}
                    className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
                  >
                    Go Back
                  </button>
                  <button
                    onClick={handleWOLookupCancelConfirm}
                    disabled={cancelSaving}
                    className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 text-white font-medium rounded transition-colors disabled:opacity-50"
                  >
                    {cancelSaving ? (
                      <>
                        <Loader2 size={16} className="animate-spin" />
                        Cancelling...
                      </>
                    ) : (
                      <>
                        <Trash2 size={16} />
                        Permanently Cancel Job
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}