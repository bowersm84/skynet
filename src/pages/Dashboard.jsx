import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Plus, ChevronDown, AlertTriangle, Edit3, X, Loader2, Trash2 } from 'lucide-react'
import MachineCard from '../components/MachineCard'
import CreateWorkOrderModal from '../components/CreateWorkOrderModal'
import ComplianceReview from '../components/ComplianceReview'

export default function Dashboard({ user, profile }) {
  const [machines, setMachines] = useState([])
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [expandedLocations, setExpandedLocations] = useState({})
  const [selectedView, setSelectedView] = useState('lineup')
  
  // Edit job modal state
  const [editingJob, setEditingJob] = useState(null)
  const [editForm, setEditForm] = useState({ quantity: '', priority: '' })
  const [editSaving, setEditSaving] = useState(false)
  const [showEditWarning, setShowEditWarning] = useState(true)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  useEffect(() => {
    fetchData()
    
    const jobsSubscription = supabase
      .channel('jobs-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, 
        () => fetchData()
      )
      .subscribe()

    return () => {
      supabase.removeChannel(jobsSubscription)
    }
  }, [])

  const fetchData = async () => {
    try {
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
          work_order:work_orders(wo_number, customer, priority, due_date, order_type),
          component:parts!component_id(id, part_number, description),
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

      console.log('✅ fetchData complete!')
    } catch (error) {
      console.error('💥 Unexpected error in fetchData:', error)
    } finally {
      setLoading(false)
    }
  }

  const getJobsForMachine = (machineId) => {
    // Only show active jobs in the queue (not completed, cancelled, or pending compliance)
    const activeStatuses = ['assigned', 'in_setup', 'in_progress']
    return jobs.filter(job => 
      job.assigned_machine_id === machineId && 
      activeStatuses.includes(job.status)
    )
  }

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
    <div className="space-y-6">
      {/* Action Bar */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">Machine Status</h2>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white font-medium rounded transition-colors"
        >
          <Plus size={20} />
          New Work Order
        </button>
      </div>

      {/* Stats Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          id="lineup"
          label="Machine Lineup"
          value={machines.length}
          onClick={setSelectedView}
        />
        <StatCard
          id="active"
          label="Active Jobs"
          value={activeJobs.length}
          colorClass="text-skynet-accent"
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
      </div>

      {/* Priority Legend */}
      <div className="flex items-center gap-6 text-sm">
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
                return (
                  <div 
                    key={job.id} 
                    className={`flex items-center justify-between bg-gray-800 rounded p-3 border-l-4 ${getPriorityBorder(job.priority)}`}
                  >
                    <div className="flex items-center gap-4">
                      <div className={`w-3 h-3 rounded-full ${getPriorityColor(job.priority)}`}></div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-white font-mono">{job.job_number}</span>
                          <span className="text-gray-500">•</span>
                          <span className="text-gray-400">{job.work_order?.wo_number}</span>
                        </div>
                        <div className="text-sm text-gray-500">
                          <span className="text-skynet-accent">{job.component?.part_number}</span>
                          <span className="mx-2">•</span>
                          <span>Qty: {job.quantity}</span>
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
        machines={machines}
      />
    </div>
  )
}