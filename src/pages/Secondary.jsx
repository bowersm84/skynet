import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { 
  Lock, 
  Loader2, 
  LogOut,
  Play,
  CheckCircle,
  Clock,
  AlertTriangle,
  Package,
  Beaker,
  Paintbrush,
  FileText,
  X,
  Save,
  Timer,
  RefreshCw
} from 'lucide-react'

// Secondary operation configurations
const OPERATION_CONFIGS = {
  passivation: {
    title: 'Passivation',
    icon: Beaker,
    color: 'cyan',
    statusField: 'pending_passivation',
    inProgressStatus: 'in_passivation',
    nextStatus: 'pending_post_manufacturing',
    startField: 'passivation_start',
    endField: 'passivation_end',
    operatorField: 'passivation_operator_id',
    notesField: 'passivation_notes'
  },
  paint: {
    title: 'Paint',
    icon: Paintbrush,
    color: 'orange',
    statusField: 'pending_paint',
    inProgressStatus: 'in_paint',
    nextStatus: 'pending_post_manufacturing',
    startField: 'paint_start',
    endField: 'paint_end',
    operatorField: 'paint_operator_id',
    notesField: 'paint_notes'
  }
}

export default function Secondary() {
  const { operationType } = useParams()
  const config = OPERATION_CONFIGS[operationType] || OPERATION_CONFIGS.passivation
  const OperationIcon = config.icon

  // Auth state
  const [pin, setPin] = useState('')
  const [operator, setOperator] = useState(null)
  const [authError, setAuthError] = useState(null)
  const [authenticating, setAuthenticating] = useState(false)

  // Queue state
  const [queuedJobs, setQueuedJobs] = useState([])
  const [activeJob, setActiveJob] = useState(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)

  // Complete modal state
  const [showCompleteModal, setShowCompleteModal] = useState(false)
  const [completionNotes, setCompletionNotes] = useState('')

  // Auto-refresh
  const [lastUpdated, setLastUpdated] = useState(null)

  // Set browser tab title
  useEffect(() => {
    document.title = `${config.title} Station - SkyNet`
  }, [config.title])

  // Load jobs
  const loadJobs = useCallback(async () => {
    try {
      // Fetch jobs pending this operation
      const { data: pendingJobs, error: pendingError } = await supabase
        .from('jobs')
        .select(`
          *,
          work_order:work_orders(wo_number, customer, priority, due_date),
          component:parts!component_id(id, part_number, description)
        `)
        .eq('status', config.statusField)
        .order('created_at', { ascending: true })

      if (pendingError) throw pendingError
      setQueuedJobs(pendingJobs || [])

      // Fetch active job (in progress for this operation)
      const { data: activeJobs, error: activeError } = await supabase
        .from('jobs')
        .select(`
          *,
          work_order:work_orders(wo_number, customer, priority, due_date),
          component:parts!component_id(id, part_number, description)
        `)
        .eq('status', config.inProgressStatus)
        .limit(1)

      if (activeError) throw activeError
      setActiveJob(activeJobs?.[0] || null)

      setLastUpdated(new Date())
    } catch (err) {
      console.error('Error loading jobs:', err)
    } finally {
      setLoading(false)
    }
  }, [config.statusField, config.inProgressStatus])

  // Initial load and real-time subscription
  useEffect(() => {
    if (operator) {
      loadJobs()

      // Subscribe to job changes
      const subscription = supabase
        .channel('secondary-jobs')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, loadJobs)
        .subscribe()

      // Auto-refresh every 30 seconds
      const interval = setInterval(loadJobs, 30000)

      return () => {
        supabase.removeChannel(subscription)
        clearInterval(interval)
      }
    }
  }, [operator, loadJobs])

  // PIN Authentication
  const handlePinSubmit = async (e) => {
    e.preventDefault()
    if (pin.length !== 4) {
      setAuthError('Please enter a 4-digit PIN')
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

      if (error || !data) {
        setAuthError('Invalid PIN')
        setPin('')
      } else {
        setOperator(data)
        setPin('')
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
    setActiveJob(null)
    setQueuedJobs([])
    setPin('')
  }

  // Start operation
  const handleStartOperation = async (job) => {
    setActionLoading(true)
    try {
      const { error } = await supabase
        .from('jobs')
        .update({
          status: config.inProgressStatus,
          [config.startField]: new Date().toISOString(),
          [config.operatorField]: operator.id,
          updated_at: new Date().toISOString()
        })
        .eq('id', job.id)

      if (error) throw error
      await loadJobs()
    } catch (err) {
      console.error('Error starting operation:', err)
      alert('Failed to start operation: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  // Complete operation
  const handleCompleteOperation = async () => {
    if (!activeJob) return

    setActionLoading(true)
    try {
      const { error } = await supabase
        .from('jobs')
        .update({
          status: config.nextStatus,
          [config.endField]: new Date().toISOString(),
          [config.notesField]: completionNotes || null,
          updated_at: new Date().toISOString()
        })
        .eq('id', activeJob.id)

      if (error) throw error
      
      setShowCompleteModal(false)
      setCompletionNotes('')
      await loadJobs()
    } catch (err) {
      console.error('Error completing operation:', err)
      alert('Failed to complete operation: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  // Priority colors
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
      case 'critical': return 'border-red-600'
      case 'high': return 'border-yellow-600'
      case 'normal': return 'border-green-600'
      case 'low': return 'border-gray-600'
      default: return 'border-gray-600'
    }
  }

  const formatTime = (timestamp) => {
    if (!timestamp) return '-'
    return new Date(timestamp).toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit' 
    })
  }

  const formatDuration = (start) => {
    if (!start) return '-'
    const startTime = new Date(start)
    const now = new Date()
    const diff = Math.floor((now - startTime) / 1000 / 60)
    const hours = Math.floor(diff / 60)
    const mins = diff % 60
    return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
  }

  // ==================== RENDER ====================

  // PIN Entry Screen
  if (!operator) {
    return (
      <div className="min-h-screen bg-skynet-dark flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className={`w-20 h-20 bg-${config.color}-600/20 rounded-full flex items-center justify-center mx-auto mb-4`}>
              <OperationIcon size={40} className={`text-${config.color}-400`} />
            </div>
            <h1 className="text-3xl font-bold text-white mb-2">{config.title} Station</h1>
            <p className="text-gray-400">Enter your 4-digit PIN to continue</p>
          </div>

          <form onSubmit={handlePinSubmit} className="bg-gray-900 rounded-lg border border-gray-800 p-6">
            <div className="mb-6">
              <label className="block text-gray-400 text-sm mb-2">Operator PIN</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500" size={20} />
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={4}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-10 py-4 text-white text-2xl text-center tracking-[1em] focus:border-cyan-500 focus:outline-none"
                  placeholder="••••"
                  autoFocus
                />
              </div>
              {authError && (
                <p className="text-red-400 text-sm mt-2 flex items-center gap-1">
                  <AlertTriangle size={14} />
                  {authError}
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={pin.length !== 4 || authenticating}
              className={`w-full py-4 rounded font-semibold text-lg transition-colors flex items-center justify-center gap-2 ${
                pin.length === 4 && !authenticating
                  ? `bg-${config.color}-600 hover:bg-${config.color}-500 text-white`
                  : 'bg-gray-700 text-gray-500 cursor-not-allowed'
              }`}
            >
              {authenticating ? (
                <>
                  <Loader2 className="animate-spin" size={20} />
                  Authenticating...
                </>
              ) : (
                <>
                  <Lock size={20} />
                  Login
                </>
              )}
            </button>
          </form>

          <p className="text-center text-gray-600 text-sm mt-6">
            SkyNet MES - Secondary Operations
          </p>
        </div>
      </div>
    )
  }

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-skynet-dark flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-cyan-500 animate-spin mx-auto mb-4" />
          <p className="text-gray-500">Loading {config.title.toLowerCase()} queue...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-skynet-dark">
      {/* Header */}
      <header className="bg-gray-900 border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className={`w-10 h-10 bg-${config.color}-600/20 rounded-lg flex items-center justify-center`}>
              <OperationIcon size={24} className={`text-${config.color}-400`} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">{config.title} Station</h1>
              <p className="text-gray-500 text-sm">Secondary Operation</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {lastUpdated && (
              <span className="text-gray-500 text-xs flex items-center gap-1">
                <RefreshCw size={12} />
                Updated {lastUpdated.toLocaleTimeString()}
              </span>
            )}
            <div className="text-right">
              <p className="text-white text-sm">{operator.full_name}</p>
              <p className="text-gray-500 text-xs capitalize">{operator.role}</p>
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded transition-colors"
            >
              <LogOut size={18} />
              <span className="hidden sm:inline">Logout</span>
            </button>
          </div>
        </div>
      </header>

      <main className="p-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          
          {/* Active Job Panel */}
          <div className="lg:col-span-1">
            <div className="bg-gray-900 rounded-lg border border-gray-800 p-6">
              <h2 className={`text-${config.color}-400 font-semibold mb-4 flex items-center gap-2`}>
                <Play size={18} />
                Active {config.title}
              </h2>

              {activeJob ? (
                <div className="space-y-4">
                  {/* Job Header */}
                  <div className={`bg-gray-800 rounded-lg p-4 border-l-4 ${getPriorityBorder(activeJob.work_order?.priority)}`}>
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <p className="text-white font-mono text-lg">{activeJob.job_number}</p>
                        <p className="text-gray-400 text-sm">{activeJob.work_order?.wo_number}</p>
                      </div>
                      <div className={`w-3 h-3 rounded-full ${getPriorityColor(activeJob.work_order?.priority)}`} 
                           title={activeJob.work_order?.priority} />
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4 mt-4">
                      <div>
                        <p className="text-gray-500 text-xs">Part</p>
                        <p className="text-white">{activeJob.component?.part_number}</p>
                        <p className="text-gray-400 text-sm">{activeJob.component?.description}</p>
                      </div>
                      <div>
                        <p className="text-gray-500 text-xs">Customer</p>
                        <p className="text-white">{activeJob.work_order?.customer || '-'}</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4 mt-4">
                      <div>
                        <p className="text-gray-500 text-xs">Quantity</p>
                        <p className="text-white text-xl">{activeJob.quantity}</p>
                      </div>
                      <div>
                        <p className="text-gray-500 text-xs">Due Date</p>
                        <p className="text-white">
                          {activeJob.work_order?.due_date 
                            ? new Date(activeJob.work_order.due_date).toLocaleDateString()
                            : '-'}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Time Tracking */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-gray-800 rounded-lg p-4">
                      <p className="text-gray-500 text-xs mb-1">Started</p>
                      <p className="text-cyan-400 text-lg font-mono">
                        {formatTime(activeJob[config.startField])}
                      </p>
                    </div>
                    <div className="bg-gray-800 rounded-lg p-4">
                      <p className="text-gray-500 text-xs mb-1">Duration</p>
                      <p className="text-white text-lg font-mono flex items-center gap-2">
                        <Timer size={16} className="text-cyan-400" />
                        {formatDuration(activeJob[config.startField])}
                      </p>
                    </div>
                  </div>

                  {/* Complete Button */}
                  <button
                    onClick={() => setShowCompleteModal(true)}
                    disabled={actionLoading}
                    className={`w-full py-4 bg-green-600 hover:bg-green-500 text-white rounded-lg font-semibold text-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50`}
                  >
                    {actionLoading ? (
                      <Loader2 className="animate-spin" size={20} />
                    ) : (
                      <CheckCircle size={20} />
                    )}
                    Complete {config.title}
                  </button>
                </div>
              ) : (
                <div className="text-center py-12">
                  <div className={`w-16 h-16 bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-4`}>
                    <OperationIcon size={32} className="text-gray-600" />
                  </div>
                  <p className="text-gray-500">No active {config.title.toLowerCase()} job</p>
                  <p className="text-gray-600 text-sm mt-1">Select a job from the queue to begin</p>
                </div>
              )}
            </div>
          </div>

          {/* Queue Panel */}
          <div className="lg:col-span-1">
            <div className="bg-gray-900 rounded-lg border border-gray-800 p-6">
              <h2 className="text-white font-semibold mb-4 flex items-center gap-2">
                <Package size={18} className="text-gray-400" />
                Pending Queue
                <span className="ml-auto text-gray-500 text-sm">{queuedJobs.length} jobs</span>
              </h2>

              {queuedJobs.length === 0 ? (
                <div className="text-center py-12">
                  <CheckCircle size={48} className="text-green-500/50 mx-auto mb-4" />
                  <p className="text-gray-500">Queue is empty</p>
                  <p className="text-gray-600 text-sm">All parts have been processed</p>
                </div>
              ) : (
                <div className="space-y-3 max-h-[600px] overflow-y-auto">
                  {queuedJobs.map(job => (
                    <div 
                      key={job.id}
                      className={`bg-gray-800 rounded-lg p-4 border-l-4 ${getPriorityBorder(job.work_order?.priority)} hover:bg-gray-750 transition-colors`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <p className="text-white font-mono">{job.job_number}</p>
                            <div className={`w-2 h-2 rounded-full ${getPriorityColor(job.work_order?.priority)}`} />
                          </div>
                          <p className="text-cyan-400 text-sm">{job.component?.part_number}</p>
                          <p className="text-gray-500 text-xs">{job.work_order?.wo_number} • Qty: {job.quantity}</p>
                        </div>
                        
                        <button
                          onClick={() => handleStartOperation(job)}
                          disabled={actionLoading || activeJob}
                          className={`px-4 py-2 rounded font-medium transition-colors flex items-center gap-2 ${
                            activeJob
                              ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                              : `bg-${config.color}-600 hover:bg-${config.color}-500 text-white`
                          }`}
                        >
                          {actionLoading ? (
                            <Loader2 className="animate-spin" size={16} />
                          ) : (
                            <Play size={16} />
                          )}
                          Start
                        </button>
                      </div>
                      
                      {job.work_order?.due_date && (
                        <p className="text-gray-500 text-xs mt-2 flex items-center gap-1">
                          <Clock size={12} />
                          Due: {new Date(job.work_order.due_date).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Complete Modal */}
      {showCompleteModal && activeJob && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-md">
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <h3 className="text-white font-semibold flex items-center gap-2">
                <CheckCircle size={20} className="text-green-400" />
                Complete {config.title}
              </h3>
              <button 
                onClick={() => setShowCompleteModal(false)}
                className="text-gray-400 hover:text-white"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div className="bg-gray-800 rounded-lg p-3">
                <p className="text-gray-400 text-sm">Job</p>
                <p className="text-white font-mono">{activeJob.job_number}</p>
                <p className="text-cyan-400 text-sm">{activeJob.component?.part_number}</p>
              </div>

              <div>
                <label className="block text-gray-400 text-sm mb-2">
                  <FileText size={14} className="inline mr-1" />
                  Completion Notes (Optional)
                </label>
                <textarea
                  value={completionNotes}
                  onChange={(e) => setCompletionNotes(e.target.value)}
                  placeholder="Any observations or issues during processing..."
                  rows={3}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white placeholder-gray-500 focus:border-cyan-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex gap-3 p-4 border-t border-gray-700">
              <button
                onClick={() => setShowCompleteModal(false)}
                className="flex-1 px-4 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCompleteOperation}
                disabled={actionLoading}
                className="flex-1 px-4 py-3 bg-green-600 hover:bg-green-500 text-white rounded font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {actionLoading ? (
                  <Loader2 className="animate-spin" size={18} />
                ) : (
                  <CheckCircle size={18} />
                )}
                Complete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 px-6 py-2">
        <p className="text-gray-600 text-xs text-center font-mono">
          SkyNet MES - {config.title} Station
        </p>
      </footer>
    </div>
  )
}