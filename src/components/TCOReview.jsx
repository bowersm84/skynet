import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { 
  ClipboardCheck, 
  CheckCircle, 
  Loader2, 
  ChevronDown, 
  ChevronRight,
  Package,
  Calendar,
  User,
  FileText,
  AlertCircle,
  Clock,
  Beaker
} from 'lucide-react'

export default function TCOReview({ profile, onUpdate }) {
  const [loading, setLoading] = useState(true)
  const [tcoItems, setTcoItems] = useState([])
  const [completedItems, setCompletedItems] = useState([])
  const [expandedWO, setExpandedWO] = useState(null)
  const [approving, setApproving] = useState(null)
  const [showCompleted, setShowCompleted] = useState(false)

  const isComplianceUser = profile?.role === 'compliance' || profile?.role === 'admin' || profile?.can_approve_compliance === true

  const loadTCOItems = useCallback(async () => {
    try {
      // Get all work orders that have jobs in pending_tco status
      const { data: wos, error } = await supabase
        .from('work_orders')
        .select(`
          id,
          wo_number,
          customer,
          priority,
          due_date,
          notes,
          status,
          order_type,
          work_order_assemblies (
            id,
            assembly_id,
            quantity,
            status,
            assembly_completed_at,
            assembly:parts!work_order_assemblies_assembly_id_fkey (
              id,
              part_number,
              description,
              part_type
            )
          ),
          jobs (
            id,
            job_number,
            status,
            quantity,
            good_pieces,
            bad_pieces,
            component:parts!component_id (
              id,
              part_number,
              description,
              part_type,
              requires_passivation
            )
          )
        `)
        .not('order_type', 'eq', 'maintenance')
        .order('due_date', { ascending: true })

      if (error) throw error

      const pending = []
      const completed = []

      // Get start of this week (Sunday)
      const startOfWeek = new Date()
      startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay())
      startOfWeek.setHours(0, 0, 0, 0)

      for (const wo of (wos || [])) {
        if (!wo.jobs || wo.jobs.length === 0) continue

        const hasTCOJobs = wo.jobs.some(j => j.status === 'pending_tco')
        const allComplete = wo.jobs.every(j => j.status === 'complete' || j.status === 'cancelled')

        if (hasTCOJobs) {
          // Check if ALL non-cancelled jobs are pending_tco (ready for TCO approval)
          const activeJobs = wo.jobs.filter(j => j.status !== 'cancelled')
          const allPendingTCO = activeJobs.every(j => j.status === 'pending_tco')
          
          pending.push({
            ...wo,
            allPendingTCO,
            activeJobCount: activeJobs.length,
            tcoJobCount: activeJobs.filter(j => j.status === 'pending_tco').length,
            productPart: wo.work_order_assemblies?.[0]?.assembly || null,
            isFinishedGood: wo.work_order_assemblies?.[0]?.assembly?.part_type === 'finished_good'
          })
        } else if (allComplete && wo.status === 'complete') {
          // Recently completed TCOs (this week)
          const lastUpdate = wo.jobs.reduce((latest, j) => {
            const d = new Date(j.updated_at || 0)
            return d > latest ? d : latest
          }, new Date(0))
          
          if (lastUpdate >= startOfWeek) {
            completed.push({
              ...wo,
              completedAt: lastUpdate,
              productPart: wo.work_order_assemblies?.[0]?.assembly || null,
              isFinishedGood: wo.work_order_assemblies?.[0]?.assembly?.part_type === 'finished_good'
            })
          }
        }
      }

      // Sort completed by most recent first
      completed.sort((a, b) => b.completedAt - a.completedAt)

      setTcoItems(pending)
      setCompletedItems(completed)
    } catch (err) {
      console.error('Error loading TCO items:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTCOItems()

    const subscription = supabase
      .channel('tco-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, loadTCOItems)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_orders' }, loadTCOItems)
      .subscribe()

    return () => {
      subscription.unsubscribe()
    }
  }, [loadTCOItems])

  const handleApproveTCO = async (wo) => {
    if (!confirm(`Approve TCO for ${wo.wo_number}? This will mark the work order as complete.`)) return

    setApproving(wo.id)
    try {
      // Update all pending_tco jobs to complete
      const { error: jobsError } = await supabase
        .from('jobs')
        .update({ 
          status: 'complete',
          updated_at: new Date().toISOString()
        })
        .eq('work_order_id', wo.id)
        .eq('status', 'pending_tco')

      if (jobsError) throw jobsError

      // Update work order to complete
      const { error: woError } = await supabase
        .from('work_orders')
        .update({
          status: 'complete',
          updated_at: new Date().toISOString()
        })
        .eq('id', wo.id)

      if (woError) throw woError

      // Update work_order_assemblies to complete (if any are still pending)
      await supabase
        .from('work_order_assemblies')
        .update({
          status: 'complete',
          updated_at: new Date().toISOString()
        })
        .eq('work_order_id', wo.id)
        .neq('status', 'complete')

      await loadTCOItems()
      if (onUpdate) onUpdate()
    } catch (err) {
      console.error('Error approving TCO:', err)
      alert('Failed to approve TCO: ' + err.message)
    } finally {
      setApproving(null)
    }
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

  const getPriorityBorder = (priority) => {
    switch (priority) {
      case 'critical': return 'border-l-red-500'
      case 'high': return 'border-l-yellow-500'
      case 'normal': return 'border-l-green-500'
      case 'low': return 'border-l-gray-500'
      default: return 'border-l-gray-500'
    }
  }

  const getStatusBadge = (status) => {
    const config = {
      pending_tco: { label: 'Pending TCO', color: 'bg-amber-900/50 text-amber-300 border-amber-700' },
      complete: { label: 'Complete', color: 'bg-gray-800 text-gray-400 border-gray-700' },
      cancelled: { label: 'Cancelled', color: 'bg-gray-800 text-gray-500 border-gray-700' }
    }
    const c = config[status] || { label: status, color: 'bg-gray-800 text-gray-400 border-gray-700' }
    return (
      <span className={`text-xs px-2 py-0.5 rounded border ${c.color}`}>
        {c.label}
      </span>
    )
  }

  const formatDate = (dateStr) => {
    if (!dateStr) return '—'
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={32} className="animate-spin text-gray-500" />
      </div>
    )
  }

  if (tcoItems.length === 0 && completedItems.length === 0) {
    return (
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-8 text-center">
        <ClipboardCheck size={48} className="mx-auto text-gray-600 mb-3" />
        <p className="text-gray-400 text-lg">No work orders pending TCO review</p>
        <p className="text-gray-600 text-sm mt-1">
          Work orders will appear here after assembly completion or finished good post-mfg approval
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Pending TCO */}
      {tcoItems.length > 0 && (
        <div className="bg-gray-900 rounded-lg border border-amber-800 p-4">
          <h3 className="text-amber-400 font-semibold mb-4 flex items-center gap-2">
            <ClipboardCheck size={18} />
            Pending TCO Review ({tcoItems.length})
          </h3>
          <div className="space-y-3">
            {tcoItems.map(wo => {
              const isExpanded = expandedWO === wo.id
              return (
                <div 
                  key={wo.id} 
                  className={`bg-gray-800 rounded-lg border-l-4 ${getPriorityBorder(wo.priority)} overflow-hidden`}
                >
                  {/* WO Header */}
                  <div 
                    className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-750"
                    onClick={() => setExpandedWO(isExpanded ? null : wo.id)}
                  >
                    <div className="flex items-center gap-4">
                      <div className={`w-3 h-3 rounded-full ${getPriorityColor(wo.priority)}`} />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-white font-mono font-medium">{wo.wo_number}</span>
                          {wo.isFinishedGood ? (
                            <span className="text-xs px-2 py-0.5 bg-emerald-900/50 text-emerald-300 rounded border border-emerald-700/50">
                              Finished Good
                            </span>
                          ) : (
                            <span className="text-xs px-2 py-0.5 bg-purple-900/50 text-purple-300 rounded border border-purple-700/50">
                              Assembly
                            </span>
                          )}
                          {!wo.allPendingTCO && (
                            <span className="text-xs px-2 py-0.5 bg-yellow-900/50 text-yellow-300 rounded border border-yellow-700/50">
                              {wo.tcoJobCount}/{wo.activeJobCount} jobs ready
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-gray-400 mt-0.5">
                          {wo.productPart && (
                            <span className="text-skynet-accent">{wo.productPart.part_number}</span>
                          )}
                          {wo.customer && (
                            <>
                              <span className="mx-2">•</span>
                              <span>{wo.customer}</span>
                            </>
                          )}
                          {wo.due_date && (
                            <>
                              <span className="mx-2">•</span>
                              <span>Due: {formatDate(wo.due_date)}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {isComplianceUser && wo.allPendingTCO && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleApproveTCO(wo)
                          }}
                          disabled={approving === wo.id}
                          className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded transition-colors disabled:opacity-50"
                        >
                          {approving === wo.id ? (
                            <Loader2 size={16} className="animate-spin" />
                          ) : (
                            <CheckCircle size={16} />
                          )}
                          {approving === wo.id ? 'Approving...' : 'Approve TCO'}
                        </button>
                      )}
                      {isExpanded ? <ChevronDown size={20} className="text-gray-500" /> : <ChevronRight size={20} className="text-gray-500" />}
                    </div>
                  </div>

                  {/* Expanded: Job Details */}
                  {isExpanded && (
                    <div className="border-t border-gray-700 p-4 space-y-2">
                      <div className="text-gray-500 text-xs font-medium mb-2">
                        Jobs ({wo.jobs.filter(j => j.status !== 'cancelled').length})
                      </div>
                      {wo.jobs
                        .filter(j => j.status !== 'cancelled')
                        .map(job => (
                        <div 
                          key={job.id}
                          className="flex items-center justify-between bg-gray-900 rounded p-3"
                        >
                          <div className="flex items-center gap-3">
                            <Package size={14} className="text-gray-500" />
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-white font-mono text-sm">{job.job_number}</span>
                                <span className="text-skynet-accent text-sm">{job.component?.part_number}</span>
                                {job.component?.requires_passivation && (
                                  <Beaker size={12} className="text-cyan-400" />
                                )}
                              </div>
                              <div className="text-gray-500 text-xs">
                                {job.component?.description}
                                {job.good_pieces != null && (
                                  <span className="ml-2">• {job.good_pieces} good / {job.bad_pieces || 0} bad</span>
                                )}
                              </div>
                            </div>
                          </div>
                          {getStatusBadge(job.status)}
                        </div>
                      ))}

                      {wo.notes && (
                        <div className="mt-3 p-3 bg-gray-900/50 rounded text-gray-400 text-sm">
                          <span className="text-gray-500 text-xs">Notes:</span> {wo.notes}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Completed TCO - This Week */}
      {completedItems.length > 0 && (
        <div className="bg-gray-900 rounded-lg border border-gray-700 p-4">
          <button
            onClick={() => setShowCompleted(!showCompleted)}
            className="w-full flex items-center justify-between text-left"
          >
            <h3 className="text-gray-400 font-semibold flex items-center gap-2">
              <CheckCircle size={18} className="text-green-500" />
              Completed This Week ({completedItems.length})
            </h3>
            <ChevronDown 
              size={20} 
              className={`text-gray-500 transition-transform ${showCompleted ? 'rotate-0' : '-rotate-90'}`}
            />
          </button>
          
          {showCompleted && (
            <div className="mt-4 space-y-2">
              {completedItems.map(wo => (
                <div 
                  key={wo.id}
                  className="flex items-center justify-between bg-gray-800 rounded p-3"
                >
                  <div className="flex items-center gap-3">
                    <CheckCircle size={14} className="text-green-500" />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-white font-mono text-sm">{wo.wo_number}</span>
                        {wo.productPart && (
                          <span className="text-skynet-accent text-sm">{wo.productPart.part_number}</span>
                        )}
                        {wo.isFinishedGood ? (
                          <span className="text-xs text-emerald-400">FG</span>
                        ) : (
                          <span className="text-xs text-purple-400">Assy</span>
                        )}
                      </div>
                      <div className="text-gray-500 text-xs">
                        {wo.customer || 'Stock'}
                        <span className="mx-2">•</span>
                        Completed: {formatDate(wo.completedAt)}
                      </div>
                    </div>
                  </div>
                  <span className="text-xs px-2 py-0.5 bg-green-900/30 text-green-400 rounded border border-green-800">
                    Complete
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}