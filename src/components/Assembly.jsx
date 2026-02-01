import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { 
  Package,
  CheckCircle,
  Clock,
  Loader2,
  Play,
  X,
  RefreshCw,
  Wrench,
  User,
  MapPin,
  Calendar
} from 'lucide-react'

export default function Assembly({ profile, onUpdate }) {
  const [loading, setLoading] = useState(true)
  const [inProgressAssemblies, setInProgressAssemblies] = useState([])
  const [queuedAssemblies, setQueuedAssemblies] = useState([])
  const [completedAssemblies, setCompletedAssemblies] = useState([])
  const [lastUpdated, setLastUpdated] = useState(null)
  const [actionLoading, setActionLoading] = useState(null)

  // Start Assembly Modal
  const [showStartModal, setShowStartModal] = useState(false)
  const [startItem, setStartItem] = useState(null)
  const [startForm, setStartForm] = useState({
    station: '1',
    assembler: '1',
    notes: ''
  })

  // Complete Assembly Modal
  const [showCompleteModal, setShowCompleteModal] = useState(false)
  const [completeItem, setCompleteItem] = useState(null)
  const [completeForm, setCompleteForm] = useState({
    end_date: '',
    end_time: '',
    good_quantity: 0,
    bad_quantity: 0,
    notes: ''
  })

  // Load all assembly data
  const loadAssemblies = useCallback(async () => {
    try {
      // Get all work orders with their assemblies and jobs
      // Include nested assembly part info from work_order_assemblies.assembly_id
      const { data: wos, error: woError } = await supabase
        .from('work_orders')
        .select(`
          id,
          wo_number,
          customer,
          priority,
          due_date,
          work_order_assemblies (
            id,
            quantity,
            status,
            station_number,
            assembler_number,
            assembly_started_at,
            assembly_completed_at,
            assembly_notes,
            good_quantity,
            bad_quantity,
            assembly_id,
            assembly:parts!work_order_assemblies_assembly_id_fkey (
              id,
              part_number,
              description,
              part_type
            )
          ),
          jobs (
            id,
            status,
            work_order_assembly_id
          )
        `)
        .not('order_type', 'eq', 'maintenance')
        .order('due_date', { ascending: true })

      if (woError) throw woError

      console.log('Assembly: Fetched work orders:', wos?.length || 0)

      const inProgress = []
      const queued = []
      const completed = []

      // Get start of this week (Sunday)
      const startOfWeek = new Date()
      startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay())
      startOfWeek.setHours(0, 0, 0, 0)

      for (const wo of (wos || [])) {
        // Check per-assembly readiness (not per-WO)
        // Each assembly within a WO is independent — one can be ready while another is still in progress

        // If work_order_assemblies has records, check each one independently
        if (wo.work_order_assemblies && wo.work_order_assemblies.length > 0) {
          for (const woa of wo.work_order_assemblies) {
            // Skip finished goods — they don't need assembly
            if (woa.assembly?.part_type === 'finished_good') continue

            // Get jobs linked to THIS specific assembly
            const woaJobs = wo.jobs?.filter(j => j.work_order_assembly_id === woa.id) || []
            
            // Check if all jobs for this assembly are ready
            const allJobsReady = woaJobs.length > 0 && woaJobs.every(j => 
              ['ready_for_assembly', 'in_assembly', 'complete'].includes(j.status)
            )
            
            // Must have at least one job still needing assembly
            const hasAssemblyWork = woaJobs.some(j => 
              ['ready_for_assembly', 'in_assembly'].includes(j.status)
            )

            // Skip if this assembly's jobs aren't ready yet
            if (!allJobsReady || !hasAssemblyWork) continue

            console.log('Assembly: Processing WOA', wo.wo_number, woa.assembly?.part_number, {
              allJobsReady,
              hasAssemblyWork,
              jobStatuses: woaJobs.map(j => j.status)
            })

            // Assembly part info comes from the nested query
            const assemblyItem = {
              ...woa,
              wo_number: wo.wo_number,
              customer: wo.customer,
              priority: wo.priority,
              due_date: wo.due_date,
              work_order_id: wo.id
              // woa.assembly already contains { id, part_number, description } from nested query
            }

            if (woa.status === 'in_progress') {
              inProgress.push(assemblyItem)
            } else if (woa.status === 'complete') {
              // Check if completed this week
              if (woa.assembly_completed_at && new Date(woa.assembly_completed_at) >= startOfWeek) {
                completed.push(assemblyItem)
              }
            } else {
              // pending or null status = queued
              queued.push(assemblyItem)
            }
          }
        } else {
          // No work_order_assemblies record exists
          // Check if all WO jobs are ready (fallback uses WO-level check)
          const allJobsReady = wo.jobs?.length > 0 && wo.jobs.every(j => 
            ['ready_for_assembly', 'in_assembly', 'complete'].includes(j.status)
          )
          const hasAssemblyWork = wo.jobs?.some(j => 
            ['ready_for_assembly', 'in_assembly'].includes(j.status)
          )

          if (!allJobsReady || !hasAssemblyWork) continue

          // This is a data integrity issue - WO should have been created with assembly info
          // Show in queue with missing assembly warning so user knows to fix it
          console.warn(`Assembly: WO ${wo.wo_number} has no work_order_assemblies record`)
          
          queued.push({
            id: `wo-${wo.id}`, // Virtual ID
            work_order_id: wo.id,
            wo_number: wo.wo_number,
            customer: wo.customer,
            priority: wo.priority,
            due_date: wo.due_date,
            quantity: wo.jobs?.length || 1,
            status: null,
            assembly: null, // No assembly info available
            isVirtual: true, // Flag to indicate this needs fixing
            missingAssembly: true // Flag to show warning
          })
        }
      }

      // Sort completed by completion date (most recent first)
      completed.sort((a, b) => new Date(b.assembly_completed_at) - new Date(a.assembly_completed_at))

      console.log('Assembly: Results -', {
        inProgress: inProgress.length,
        queued: queued.length,
        completed: completed.length
      })

      setInProgressAssemblies(inProgress)
      setQueuedAssemblies(queued)
      setCompletedAssemblies(completed)
      setLastUpdated(new Date())
    } catch (err) {
      console.error('Error loading assemblies:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadAssemblies()

    // Subscribe to changes
    const subscription = supabase
      .channel('assembly-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, loadAssemblies)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_order_assemblies' }, loadAssemblies)
      .subscribe()

    return () => {
      subscription.unsubscribe()
    }
  }, [loadAssemblies])

  // Start Assembly
  const handleStartAssembly = async () => {
    if (!startItem) return
    setActionLoading('start')

    try {
      console.log('Starting assembly for:', startItem.id, 'isVirtual:', startItem.isVirtual)

      // If this is a virtual entry (no work_order_assemblies record exists), create one first
      if (startItem.isVirtual) {
        const { data: newAssembly, error: createError } = await supabase
          .from('work_order_assemblies')
          .insert({
            work_order_id: startItem.work_order_id,
            quantity: startItem.quantity || 1,
            status: 'in_progress',
            station_number: parseInt(startForm.station),
            assembler_number: parseInt(startForm.assembler),
            assembly_started_at: new Date().toISOString(),
            assembly_started_by: profile?.id || null,
            assembly_notes: startForm.notes || null
          })
          .select()
          .single()

        if (createError) throw createError
        console.log('Created new work_order_assemblies record:', newAssembly.id)
      } else {
        // Update existing record - use .select() to verify the update worked
        console.log('Updating work_order_assemblies id:', startItem.id)
        
        const { data: updatedData, error } = await supabase
          .from('work_order_assemblies')
          .update({
            status: 'in_progress',
            station_number: parseInt(startForm.station),
            assembler_number: parseInt(startForm.assembler),
            assembly_started_at: new Date().toISOString(),
            assembly_started_by: profile?.id || null,
            assembly_notes: startForm.notes || null
          })
          .eq('id', startItem.id)
          .select()

        if (error) {
          console.error('Update error:', error)
          throw error
        }
        
        if (!updatedData || updatedData.length === 0) {
          console.error('Update returned no data - ID may not exist or RLS blocking')
          throw new Error('Failed to update assembly record. Please check permissions.')
        }
        
        console.log('Successfully updated work_order_assemblies:', updatedData)
      }

      // Update all jobs on this work order to 'in_assembly' status
      const { data: jobsData, error: jobsError } = await supabase
        .from('jobs')
        .update({ 
          status: 'in_assembly',
          updated_at: new Date().toISOString()
        })
        .eq('work_order_id', startItem.work_order_id)
        .eq('status', 'ready_for_assembly')
        .select()

      if (jobsError) {
        console.error('Error updating jobs to in_assembly:', jobsError)
      } else {
        console.log('Updated jobs to in_assembly:', jobsData?.length || 0)
      }

      setShowStartModal(false)
      setStartItem(null)
      setStartForm({ station: '1', assembler: '1', notes: '' })
      await loadAssemblies()
      if (onUpdate) onUpdate()
    } catch (err) {
      console.error('Error starting assembly:', err)
      alert('Failed to start assembly: ' + err.message)
    } finally {
      setActionLoading(null)
    }
  }

  // Complete Assembly
  const handleCompleteAssembly = async () => {
    if (!completeItem) return
    setActionLoading('complete')

    try {
      // Combine date and time from form
      const completedAt = new Date(`${completeForm.end_date}T${completeForm.end_time}:00`).toISOString()

      // Append completion notes to existing notes
      let finalNotes = completeItem.assembly_notes || ''
      if (completeForm.notes) {
        if (finalNotes) finalNotes += '\n---\n'
        finalNotes += `Completion: ${completeForm.notes}`
      }

      const { error } = await supabase
        .from('work_order_assemblies')
        .update({
          status: 'complete',
          assembly_completed_at: completedAt,
          assembly_completed_by: profile?.id || null, // Track who completed
          good_quantity: completeForm.good_quantity,
          bad_quantity: completeForm.bad_quantity,
          assembly_notes: finalNotes || null
        })
        .eq('id', completeItem.id)

      if (error) throw error

      // Update all jobs on this work order to 'pending_tco' (awaiting TCO close-out)
      const { error: jobsError } = await supabase
        .from('jobs')
        .update({ 
          status: 'pending_tco',
          updated_at: new Date().toISOString()
        })
        .eq('work_order_id', completeItem.work_order_id)
        .in('status', ['ready_for_assembly', 'in_assembly'])

      if (jobsError) console.error('Error updating jobs:', jobsError)

      // Work order stays open until TCO is approved
      // (Do NOT set WO to complete here — that happens in TCO)

      setShowCompleteModal(false)
      setCompleteItem(null)
      setCompleteForm({ end_date: '', end_time: '', good_quantity: 0, bad_quantity: 0, notes: '' })
      await loadAssemblies()
      if (onUpdate) onUpdate()
    } catch (err) {
      console.error('Error completing assembly:', err)
      alert('Failed to complete assembly: ' + err.message)
    } finally {
      setActionLoading(null)
    }
  }

  // Open Start Modal
  const openStartModal = (item) => {
    setStartItem(item)
    setStartForm({ station: '1', assembler: '1', notes: '' })
    setShowStartModal(true)
  }

  // Open Complete Modal
  const openCompleteModal = (item) => {
    setCompleteItem(item)
    // Initialize with current date/time
    const now = new Date()
    const dateStr = now.toISOString().split('T')[0]
    const timeStr = now.toTimeString().slice(0, 5) // HH:MM format
    setCompleteForm({ 
      end_date: dateStr,
      end_time: timeStr,
      good_quantity: item.quantity, 
      bad_quantity: 0, 
      notes: '' 
    })
    setShowCompleteModal(true)
  }

  // Format duration
  const formatDuration = (startTime) => {
    if (!startTime) return ''
    const start = new Date(startTime)
    const now = new Date()
    const diffMs = now - start
    const diffMins = Math.floor(diffMs / 60000)
    
    if (diffMins < 60) return `${diffMins}m`
    const hours = Math.floor(diffMins / 60)
    const mins = diffMins % 60
    return `${hours}h ${mins}m`
  }

  // Format date
  const formatDate = (date) => {
    if (!date) return 'N/A'
    return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  // Format time
  const formatTime = (date) => {
    if (!date) return ''
    return new Date(date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }

  // Priority colors
  const getPriorityColor = (priority) => {
    const colors = {
      critical: 'border-red-600 bg-red-900/20',
      high: 'border-yellow-600 bg-yellow-900/20',
      normal: 'border-green-600 bg-green-900/20',
      low: 'border-gray-600 bg-gray-800/50'
    }
    return colors[priority] || colors.normal
  }

  const getPriorityDot = (priority) => {
    const colors = {
      critical: 'bg-red-500',
      high: 'bg-yellow-500',
      normal: 'bg-green-500',
      low: 'bg-gray-500'
    }
    return colors[priority] || colors.normal
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={32} className="animate-spin text-skynet-accent" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Wrench className="text-green-400" size={20} />
          Assembly
        </h2>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-gray-500">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={loadAssemblies}
            className="flex items-center gap-1 px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded text-xs transition-colors"
          >
            <RefreshCw size={12} />
            Refresh
          </button>
        </div>
      </div>

      {/* Two Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column - In Progress */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></div>
            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wide">
              In Progress ({inProgressAssemblies.length})
            </h3>
          </div>

          {inProgressAssemblies.length === 0 ? (
            <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-8 text-center">
              <Clock size={32} className="mx-auto text-gray-600 mb-2" />
              <p className="text-gray-500 text-sm">No assemblies in progress</p>
            </div>
          ) : (
            <div className="space-y-3">
              {inProgressAssemblies.map(item => (
                <div 
                  key={item.id} 
                  className={`border-l-4 rounded-lg p-4 ${getPriorityColor(item.priority)}`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-white font-mono font-medium">{item.wo_number}</span>
                        <div className={`w-2 h-2 rounded-full ${getPriorityDot(item.priority)}`}></div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Package size={14} className="text-gray-500" />
                        <span className="text-skynet-accent font-mono">{item.assembly?.part_number}</span>
                      </div>
                      <p className="text-xs text-gray-500 ml-5">{item.assembly?.description}</p>
                    </div>
                    <div className="text-right text-xs text-gray-500">
                      <div>Qty: <span className="text-white">{item.quantity}</span></div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 mb-3">
                    <div className="flex items-center gap-2 text-sm">
                      <MapPin size={14} className="text-gray-500" />
                      <span className="text-gray-400">Station:</span>
                      <span className="text-white font-medium">{item.station_number || '—'}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <User size={14} className="text-gray-500" />
                      <span className="text-gray-400">Assembler:</span>
                      <span className="text-white font-medium">{item.assembler_number || '—'}</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="text-xs text-gray-500">
                      Started: {formatTime(item.assembly_started_at)}
                      <span className="text-blue-400 ml-2">({formatDuration(item.assembly_started_at)})</span>
                    </div>
                    <button
                      onClick={() => openCompleteModal(item)}
                      className="flex items-center gap-1 px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-sm font-medium rounded transition-colors"
                    >
                      <CheckCircle size={14} />
                      Complete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right Column - Queue + Completed */}
        <div className="space-y-6">
          {/* Queue Section */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-yellow-500"></div>
              <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wide">
                Queue ({queuedAssemblies.length})
              </h3>
            </div>

            {queuedAssemblies.length === 0 ? (
              <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-6 text-center">
                <CheckCircle size={28} className="mx-auto text-green-600 mb-2" />
                <p className="text-gray-500 text-sm">No assemblies waiting</p>
              </div>
            ) : (
              <div className="space-y-2">
                {queuedAssemblies.map(item => (
                  <div 
                    key={item.id} 
                    className={`bg-gray-800/50 border rounded-lg p-3 hover:border-gray-600 transition-colors ${
                      item.missingAssembly ? 'border-yellow-600/50' : 'border-gray-700'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <div className={`w-2 h-2 rounded-full ${getPriorityDot(item.priority)}`}></div>
                          <span className="text-white font-mono text-sm">{item.wo_number}</span>
                          <span className="text-gray-500">•</span>
                          {item.assembly?.part_number ? (
                            <span className="text-skynet-accent font-mono text-sm">{item.assembly.part_number}</span>
                          ) : (
                            <span className="text-yellow-500 text-sm italic">Assembly not configured</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-gray-500">
                          <span>{item.customer}</span>
                          <span className="flex items-center gap-1">
                            <Calendar size={10} />
                            Due: {formatDate(item.due_date)}
                          </span>
                          <span>Qty: {item.quantity}</span>
                        </div>
                        {item.missingAssembly && (
                          <p className="text-xs text-yellow-500/80 mt-1">
                            ⚠ Work order missing assembly configuration
                          </p>
                        )}
                      </div>
                      {item.missingAssembly ? (
                        <span className="text-xs text-yellow-500 px-3 py-1.5 border border-yellow-600/50 rounded ml-3">
                          Needs Setup
                        </span>
                      ) : (
                        <button
                          onClick={() => openStartModal(item)}
                          className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded transition-colors ml-3"
                        >
                          <Play size={14} />
                          Start
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Completed This Week Section */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500"></div>
              <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wide">
                Completed This Week ({completedAssemblies.length})
              </h3>
            </div>

            {completedAssemblies.length === 0 ? (
              <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-4 text-center">
                <p className="text-gray-600 text-sm">No completions this week</p>
              </div>
            ) : (
              <div className="bg-gray-800/30 border border-gray-700 rounded-lg divide-y divide-gray-700">
                {completedAssemblies.slice(0, 10).map(item => (
                  <div key={item.id} className="px-3 py-2 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle size={14} className="text-green-500" />
                      <span className="text-gray-300 font-mono">{item.wo_number}</span>
                      <span className="text-gray-500">•</span>
                      <span className="text-gray-400">{item.assembly?.part_number}</span>
                    </div>
                    <div className="text-xs text-gray-500">
                      {formatDate(item.assembly_completed_at)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Start Assembly Modal */}
      {showStartModal && startItem && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-md">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                  <Play className="text-blue-400" size={20} />
                  Start Assembly
                </h2>
                <p className="text-gray-500 text-sm">{startItem.wo_number} • {startItem.assembly?.part_number}</p>
              </div>
              <button onClick={() => setShowStartModal(false)} className="text-gray-400 hover:text-white">
                <X size={24} />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="bg-gray-800 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Package size={16} className="text-skynet-accent" />
                  <span className="text-skynet-accent font-mono">{startItem.assembly?.part_number}</span>
                </div>
                <p className="text-gray-400 text-sm">{startItem.assembly?.description}</p>
                <p className="text-gray-500 text-xs mt-2">Quantity: {startItem.quantity}</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-gray-400 text-sm mb-2">Station</label>
                  <select
                    value={startForm.station}
                    onChange={(e) => setStartForm({...startForm, station: e.target.value})}
                    className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-blue-500 focus:outline-none"
                  >
                    {[1,2,3,4,5,6,7,8,9,10].map(n => (
                      <option key={n} value={n}>Station {n}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-gray-400 text-sm mb-2">Assembler</label>
                  <select
                    value={startForm.assembler}
                    onChange={(e) => setStartForm({...startForm, assembler: e.target.value})}
                    className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-blue-500 focus:outline-none"
                  >
                    {[1,2,3,4,5,6].map(n => (
                      <option key={n} value={n}>Assembler {n}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-gray-400 text-sm mb-2">Notes (Optional)</label>
                <textarea
                  value={startForm.notes}
                  onChange={(e) => setStartForm({...startForm, notes: e.target.value})}
                  placeholder="Any notes for this assembly..."
                  rows={2}
                  className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none resize-none"
                />
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex gap-3">
              <button
                onClick={() => setShowStartModal(false)}
                className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleStartAssembly}
                disabled={actionLoading === 'start'}
                className="flex-1 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {actionLoading === 'start' ? (
                  <Loader2 size={20} className="animate-spin" />
                ) : (
                  <Play size={20} />
                )}
                Start Assembly
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Complete Assembly Modal */}
      {showCompleteModal && completeItem && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-md">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                  <CheckCircle className="text-green-400" size={20} />
                  Complete Assembly
                </h2>
                <p className="text-gray-500 text-sm">{completeItem.wo_number} • {completeItem.assembly?.part_number}</p>
              </div>
              <button onClick={() => setShowCompleteModal(false)} className="text-gray-400 hover:text-white">
                <X size={24} />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="bg-gray-800 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Package size={16} className="text-skynet-accent" />
                    <span className="text-skynet-accent font-mono">{completeItem.assembly?.part_number}</span>
                  </div>
                  <span className="text-xs text-gray-500">
                    Station {completeItem.station_number} • Assembler {completeItem.assembler_number}
                  </span>
                </div>
                <p className="text-gray-400 text-sm">{completeItem.assembly?.description}</p>
                <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
                  <span>Started: {formatTime(completeItem.assembly_started_at)}</span>
                  <span className="text-blue-400">Duration: {formatDuration(completeItem.assembly_started_at)}</span>
                </div>
              </div>

              {/* End Date/Time */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-gray-400 text-sm mb-2">End Date</label>
                  <input
                    type="date"
                    value={completeForm.end_date}
                    onChange={(e) => setCompleteForm({...completeForm, end_date: e.target.value})}
                    className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-green-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-gray-400 text-sm mb-2">End Time</label>
                  <input
                    type="time"
                    value={completeForm.end_time}
                    onChange={(e) => setCompleteForm({...completeForm, end_time: e.target.value})}
                    className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-green-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-gray-400 text-sm mb-2">Good Quantity</label>
                  <input
                    type="number"
                    min="0"
                    value={completeForm.good_quantity}
                    onChange={(e) => setCompleteForm({...completeForm, good_quantity: parseInt(e.target.value) || 0})}
                    className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white text-center focus:border-green-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-gray-400 text-sm mb-2">Bad Quantity</label>
                  <input
                    type="number"
                    min="0"
                    value={completeForm.bad_quantity}
                    onChange={(e) => setCompleteForm({...completeForm, bad_quantity: parseInt(e.target.value) || 0})}
                    className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white text-center focus:border-red-500 focus:outline-none"
                  />
                </div>
              </div>

              {(completeForm.good_quantity + completeForm.bad_quantity) !== completeItem.quantity && (
                <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg p-3 text-yellow-400 text-sm">
                  Total ({completeForm.good_quantity + completeForm.bad_quantity}) doesn't match expected quantity ({completeItem.quantity})
                </div>
              )}

              <div>
                <label className="block text-gray-400 text-sm mb-2">Completion Notes (Optional)</label>
                <textarea
                  value={completeForm.notes}
                  onChange={(e) => setCompleteForm({...completeForm, notes: e.target.value})}
                  placeholder="Any notes about this assembly..."
                  rows={2}
                  className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-green-500 focus:outline-none resize-none"
                />
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex gap-3">
              <button
                onClick={() => setShowCompleteModal(false)}
                className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCompleteAssembly}
                disabled={actionLoading === 'complete'}
                className="flex-1 py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {actionLoading === 'complete' ? (
                  <Loader2 size={20} className="animate-spin" />
                ) : (
                  <CheckCircle size={20} />
                )}
                Complete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}