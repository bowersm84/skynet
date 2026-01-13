import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Plus, ChevronDown } from 'lucide-react'
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
    return jobs.filter(job => job.assigned_machine_id === machineId && job.status !== 'pending_compliance')
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

  // Job categorization
  const pendingComplianceJobs = jobs.filter(job => 
    job.status === 'pending_compliance' || job.status === 'pending_post_manufacturing'
  )
  const unassignedJobs = jobs.filter(job => !job.assigned_machine_id && job.status === 'ready')
  const activeJobs = jobs.filter(job => 
    job.assigned_machine_id && 
    (job.status === 'assigned' || job.status === 'in_progress')
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

  const StatCard = ({ id, label, value, colorClass = 'text-white', borderClass = 'border-gray-800', onClick }) => {
    const isSelected = selectedView === id
    return (
      <button
        onClick={() => onClick(id)}
        className={`bg-gray-900 rounded-lg border p-4 text-left transition-all ${
          isSelected 
            ? 'border-skynet-accent ring-2 ring-skynet-accent/50' 
            : borderClass + ' hover:border-gray-600'
        }`}
      >
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
          colorClass="text-yellow-500"
          borderClass={unassignedJobs.length > 0 ? 'border-yellow-800' : 'border-gray-800'}
          onClick={setSelectedView}
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

      {/* Active Jobs View */}
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
              {activeJobs.map(job => (
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
                    <p className="text-xs text-gray-500 capitalize">{job.status.replace('_', ' ')}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Pending Compliance View - Now passes ALL jobs for ComplianceReview to filter */}
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

      {/* Unassigned Jobs View */}
      {selectedView === 'unassigned' && (
        <div className="bg-gray-900 rounded-lg border border-yellow-800 p-4">
          <h3 className="text-yellow-500 font-semibold mb-3 flex items-center gap-2">
            <span className="w-2 h-2 bg-yellow-500 rounded-full animate-pulse"></span>
            Ready for Assignment ({unassignedJobs.length})
          </h3>
          {unassignedJobs.length === 0 ? (
            <p className="text-gray-500 text-center py-8">No jobs awaiting assignment</p>
          ) : (
            <div className="space-y-2">
              {unassignedJobs.map(job => (
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
                  <span className="text-yellow-500 text-sm">Needs Assignment</span>
                </div>
              ))}
            </div>
          )}
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