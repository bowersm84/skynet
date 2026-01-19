import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { X, Loader2, Calendar, Clock, AlertTriangle, ArrowRight, RotateCcw, Wrench } from 'lucide-react'

export default function CreateMaintenanceModal({ isOpen, onClose, onSuccess, machines }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  
  // Auto-generated MO number
  const [moNumber, setMoNumber] = useState('')
  const [generatingMO, setGeneratingMO] = useState(false)

  // Maintenance order fields
  const [maintenanceType, setMaintenanceType] = useState('planned')
  const [selectedMachine, setSelectedMachine] = useState('')
  const [maintenanceDate, setMaintenanceDate] = useState('')
  const [maintenanceStartTime, setMaintenanceStartTime] = useState('07:00')
  const [maintenanceDuration, setMaintenanceDuration] = useState(1)
  const [maintenanceDescription, setMaintenanceDescription] = useState('')

  // Crash lineup state
  const [showCrashModal, setShowCrashModal] = useState(false)
  const [affectedJobs, setAffectedJobs] = useState([])
  const [crashAction, setCrashAction] = useState('return_to_queue')
  const [processingCrash, setProcessingCrash] = useState(false)

  useEffect(() => {
    if (isOpen) {
      generateMONumber()
      setError(null)
      setMaintenanceType('planned')
      setSelectedMachine('')
      const now = new Date()
      setMaintenanceDate(now.toISOString().split('T')[0])
      const minutes = Math.ceil(now.getMinutes() / 15) * 15
      const hours = minutes === 60 ? now.getHours() + 1 : now.getHours()
      const adjustedMinutes = minutes === 60 ? 0 : minutes
      setMaintenanceStartTime(`${String(hours).padStart(2, '0')}:${String(adjustedMinutes).padStart(2, '0')}`)
      setMaintenanceDuration(1)
      setMaintenanceDescription('')
      setShowCrashModal(false)
      setAffectedJobs([])
      setCrashAction('return_to_queue')
      setProcessingCrash(false)
    }
  }, [isOpen])

  const generateMONumber = async () => {
    setGeneratingMO(true)
    try {
      const now = new Date()
      const year = String(now.getFullYear()).slice(-2)
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const prefix = `MO-${year}${month}-`

      const { data, error } = await supabase
        .from('work_orders')
        .select('wo_number')
        .like('wo_number', `${prefix}%`)
        .order('wo_number', { ascending: false })
        .limit(1)

      let nextNum = 1
      if (data && data.length > 0) {
        const lastNum = parseInt(data[0].wo_number.split('-')[2]) || 0
        nextNum = lastNum + 1
      }

      setMoNumber(`${prefix}${String(nextNum).padStart(4, '0')}`)
    } catch (err) {
      console.error('Error generating MO number:', err)
      setMoNumber('MO-ERROR')
    }
    setGeneratingMO(false)
  }

  const SHIFT_START = 7
  const SHIFT_END = 16
  const SHIFT_HOURS = SHIFT_END - SHIFT_START

  const calculateMaintenanceEnd = () => {
    if (!maintenanceDate || !maintenanceStartTime || !maintenanceDuration) return null

    const startDateTime = new Date(`${maintenanceDate}T${maintenanceStartTime}:00`)
    let remainingHours = parseFloat(maintenanceDuration)
    let currentTime = new Date(startDateTime)

    const startHour = currentTime.getHours() + currentTime.getMinutes() / 60
    const hoursLeftToday = Math.max(0, SHIFT_END - startHour)

    if (remainingHours <= hoursLeftToday) {
      currentTime.setTime(currentTime.getTime() + remainingHours * 60 * 60 * 1000)
    } else {
      remainingHours -= hoursLeftToday
      currentTime.setHours(SHIFT_END, 0, 0, 0)

      while (remainingHours > 0) {
        currentTime.setDate(currentTime.getDate() + 1)
        while (currentTime.getDay() === 0 || currentTime.getDay() === 6) {
          currentTime.setDate(currentTime.getDate() + 1)
        }
        currentTime.setHours(SHIFT_START, 0, 0, 0)

        if (remainingHours <= SHIFT_HOURS) {
          currentTime.setTime(currentTime.getTime() + remainingHours * 60 * 60 * 1000)
          remainingHours = 0
        } else {
          remainingHours -= SHIFT_HOURS
          currentTime.setHours(SHIFT_END, 0, 0, 0)
        }
      }
    }

    return currentTime
  }

  const handleSubmit = async (e) => {
    e?.preventDefault()
    setLoading(true)
    setError(null)

    try {
      await handleMaintenanceSubmit()
    } catch (err) {
      console.error('Error creating maintenance order:', err)
      setError(err.message)
    }
    
    setLoading(false)
  }

  const handleMaintenanceSubmit = async () => {
    if (!selectedMachine) {
      throw new Error('Please select a machine')
    }
    if (!maintenanceDate) {
      throw new Error('Please select a date')
    }
    if (!maintenanceDescription.trim()) {
      throw new Error('Please enter a description')
    }

    const startDateTime = new Date(`${maintenanceDate}T${maintenanceStartTime}:00`)
    const endDateTime = calculateMaintenanceEnd()

    if (maintenanceType === 'unplanned') {
      const { data: overlappingJobs, error: fetchError } = await supabase
        .from('jobs')
        .select(`
          *,
          work_order:work_orders(wo_number, customer, priority),
          component:parts!component_id(part_number, description)
        `)
        .eq('assigned_machine_id', selectedMachine)
        .in('status', ['assigned', 'in_setup', 'in_progress'])

      if (fetchError) {
        console.error('Error checking for overlapping jobs:', fetchError)
      }

      const actualOverlaps = (overlappingJobs || []).filter(job => {
        if (!job.scheduled_start || !job.scheduled_end) return false
        const jobStart = new Date(job.scheduled_start)
        const jobEnd = new Date(job.scheduled_end)
        return jobStart < endDateTime && jobEnd > startDateTime
      })

      if (actualOverlaps.length > 0) {
        setAffectedJobs(actualOverlaps)
        setShowCrashModal(true)
        return
      }
    }

    await createMaintenanceOrder(startDateTime, endDateTime)
  }

  const createMaintenanceOrder = async (startDateTime, endDateTime) => {
    const { data: workOrder, error: woError } = await supabase
      .from('work_orders')
      .insert({
        wo_number: moNumber,
        order_type: 'maintenance',
        maintenance_type: maintenanceType,
        machine_id: selectedMachine,
        priority: 'normal',
        notes: maintenanceDescription,
        status: 'in_progress'
      })
      .select()
      .single()

    if (woError) throw woError

    const { data: lastJob } = await supabase
      .from('jobs')
      .select('job_number')
      .like('job_number', 'J-%')
      .order('job_number', { ascending: false })
      .limit(1)
    
    let nextJobNum = 1
    if (lastJob && lastJob.length > 0) {
      const lastNum = parseInt(lastJob[0].job_number.replace('J-', '')) || 0
      nextJobNum = lastNum + 1
    }

    const jobNumber = `J-${String(nextJobNum).padStart(6, '0')}`

    const { error: jobError } = await supabase
      .from('jobs')
      .insert({
        job_number: jobNumber,
        work_order_id: workOrder.id,
        component_id: null,
        quantity: 1,
        status: 'assigned',
        is_maintenance: true,
        maintenance_description: maintenanceDescription,
        assigned_machine_id: selectedMachine,
        scheduled_start: startDateTime.toISOString(),
        scheduled_end: endDateTime.toISOString(),
        estimated_minutes: maintenanceDuration * 60
      })

    if (jobError) throw jobError

    if (maintenanceType === 'unplanned') {
      await supabase
        .from('machines')
        .update({
          status: 'down',
          status_reason: `Unplanned maintenance: ${maintenanceDescription}`,
          status_updated_at: new Date().toISOString()
        })
        .eq('id', selectedMachine)
    }

    onSuccess?.()
    onClose()
  }

  const handleCrashResolution = async () => {
    setProcessingCrash(true)
    try {
      const startDateTime = new Date(`${maintenanceDate}T${maintenanceStartTime}:00`)
      const endDateTime = calculateMaintenanceEnd()

      if (crashAction === 'return_to_queue') {
        for (const job of affectedJobs) {
          await supabase
            .from('jobs')
            .update({
              status: 'ready',
              assigned_machine_id: null,
              scheduled_start: null,
              scheduled_end: null,
              scheduled_by: null,
              scheduled_at: null,
              notes: `${job.notes || ''} [Unscheduled due to unplanned maintenance: ${maintenanceDescription}]`.trim(),
              updated_at: new Date().toISOString()
            })
            .eq('id', job.id)
        }
      } else if (crashAction === 'move_next') {
        let nextAvailableStart = new Date(endDateTime)
        
        for (const job of affectedJobs) {
          const jobDurationMs = job.scheduled_end && job.scheduled_start 
            ? new Date(job.scheduled_end) - new Date(job.scheduled_start)
            : (job.estimated_minutes || 60) * 60 * 1000

          const newStart = new Date(nextAvailableStart)
          const newEnd = new Date(newStart.getTime() + jobDurationMs)

          await supabase
            .from('jobs')
            .update({
              scheduled_start: newStart.toISOString(),
              scheduled_end: newEnd.toISOString(),
              notes: `${job.notes || ''} [Rescheduled due to unplanned maintenance]`.trim(),
              updated_at: new Date().toISOString()
            })
            .eq('id', job.id)

          nextAvailableStart = newEnd
        }
      }

      await createMaintenanceOrder(startDateTime, endDateTime)
      
      setShowCrashModal(false)
      setAffectedJobs([])
    } catch (err) {
      console.error('Error handling crash resolution:', err)
      setError(err.message)
    } finally {
      setProcessingCrash(false)
    }
  }

  const selectedMachineData = machines?.find(m => m.id === selectedMachine)
  const endDateTime = calculateMaintenanceEnd()

  if (!isOpen) return null

  return (
    <div 
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div 
        className="bg-gray-900 rounded-lg border border-blue-700 w-full max-w-lg max-h-[90vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 bg-blue-900/30">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-600/30 flex items-center justify-center">
              <Wrench className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-white">Schedule Maintenance</h2>
              <p className="text-sm text-gray-400">Create a maintenance order</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto max-h-[calc(90vh-180px)]">
          {error && (
            <div className="mb-4 p-3 bg-red-900/50 border border-red-700 rounded text-red-300 text-sm">
              {error}
            </div>
          )}

          {/* MO Number */}
          <div className="mb-4">
            <label className="block text-gray-400 text-sm mb-1">Maintenance Order Number</label>
            <div className="px-3 py-2 bg-blue-900/50 border border-blue-600 rounded text-blue-300 font-mono">
              {generatingMO ? 'Generating...' : moNumber}
            </div>
            <p className="text-xs text-gray-500 mt-1">Auto-generated: MO-YYMM-NNNN</p>
          </div>

          {/* Maintenance Type */}
          <div className="mb-4">
            <label className="block text-gray-400 text-sm mb-2">Maintenance Type</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setMaintenanceType('planned')}
                className={`px-4 py-3 rounded font-medium transition-colors flex items-center justify-center gap-2 ${
                  maintenanceType === 'planned'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                <Calendar size={18} />
                Planned
              </button>
              <button
                type="button"
                onClick={() => setMaintenanceType('unplanned')}
                className={`px-4 py-3 rounded font-medium transition-colors flex items-center justify-center gap-2 ${
                  maintenanceType === 'unplanned'
                    ? 'bg-purple-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                <AlertTriangle size={18} />
                Unplanned
              </button>
            </div>
            {maintenanceType === 'unplanned' && (
              <p className="text-xs text-purple-400 mt-2 flex items-center gap-1">
                <AlertTriangle size={12} />
                Unplanned maintenance will flag the machine as DOWN and may affect scheduled jobs
              </p>
            )}
          </div>

          {/* Machine Selection */}
          <div className="mb-4">
            <label className="block text-gray-400 text-sm mb-1">Machine *</label>
            <select
              value={selectedMachine}
              onChange={(e) => setSelectedMachine(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:border-blue-500 focus:outline-none"
            >
              <option value="">-- Select Machine --</option>
              {machines?.map(machine => (
                <option key={machine.id} value={machine.id}>
                  {machine.name} ({machine.code}) - {machine.location?.name || 'Unknown'}
                </option>
              ))}
            </select>
          </div>

          {/* Date, Time, Duration */}
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div>
              <label className="block text-gray-400 text-sm mb-1">Date *</label>
              <input
                type="date"
                value={maintenanceDate}
                onChange={(e) => setMaintenanceDate(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1">Start Time *</label>
              <input
                type="time"
                value={maintenanceStartTime}
                onChange={(e) => setMaintenanceStartTime(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1">Duration (hrs) *</label>
              <input
                type="number"
                value={maintenanceDuration}
                onChange={(e) => setMaintenanceDuration(parseFloat(e.target.value) || 0)}
                min="0.25"
                step="0.25"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>

          {/* Schedule Preview */}
          {maintenanceDate && maintenanceStartTime && maintenanceDuration > 0 && endDateTime && (
            <div className={`mb-4 p-3 rounded border ${
              maintenanceType === 'unplanned' 
                ? 'bg-purple-900/30 border-purple-700' 
                : 'bg-blue-900/30 border-blue-700'
            }`}>
              <div className="flex items-center gap-2 text-sm">
                <Clock size={14} className={maintenanceType === 'unplanned' ? 'text-purple-400' : 'text-blue-400'} />
                <span className={maintenanceType === 'unplanned' ? 'text-purple-300' : 'text-blue-300'}>
                  Scheduled: {new Date(`${maintenanceDate}T${maintenanceStartTime}`).toLocaleString()} → {endDateTime.toLocaleString()}
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-1">
                Duration spans working hours (7am-4pm). Maintenance scheduled outside shift hours will continue the next business day.
              </p>
            </div>
          )}

          {/* Description */}
          <div className="mb-4">
            <label className="block text-gray-400 text-sm mb-1">Description *</label>
            <textarea
              value={maintenanceDescription}
              onChange={(e) => setMaintenanceDescription(e.target.value)}
              placeholder="Describe the maintenance work to be performed..."
              rows={3}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:border-blue-500 focus:outline-none resize-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-700">
          <div className="text-sm text-gray-400">
            {selectedMachine && maintenanceDate && maintenanceDescription ? (
              <span>
                <span className={maintenanceType === 'unplanned' ? 'text-purple-400 font-medium' : 'text-blue-400 font-medium'}>
                  {maintenanceType === 'unplanned' ? '⚠️ Unplanned' : 'Planned'}
                </span> maintenance for{' '}
                <span className={maintenanceType === 'unplanned' ? 'text-purple-400' : 'text-blue-400'}>
                  {selectedMachineData?.name || 'selected machine'}
                </span>
              </span>
            ) : (
              <span className="text-gray-500">Fill in required fields to continue</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={loading || !selectedMachine || !maintenanceDate || !maintenanceDescription.trim()}
              className={`px-6 py-2 font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                maintenanceType === 'unplanned'
                  ? 'bg-purple-600 hover:bg-purple-500 text-white'
                  : 'bg-blue-600 hover:bg-blue-500 text-white'
              }`}
            >
              {loading ? 'Creating...' : 'Schedule Maintenance'}
            </button>
          </div>
        </div>
      </div>

      {/* Crash Lineup Modal */}
      {showCrashModal && (
        <div 
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-[60] p-4"
          onClick={() => !processingCrash && setShowCrashModal(false)}
        >
          <div 
            className="bg-gray-900 rounded-lg border border-red-600 w-full max-w-lg max-h-[80vh] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-6 py-4 border-b border-red-800 bg-red-900/30">
              <div className="w-10 h-10 rounded-full bg-red-600/30 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Schedule Conflict</h3>
                <p className="text-sm text-red-300">Unplanned maintenance affects {affectedJobs.length} scheduled job{affectedJobs.length !== 1 ? 's' : ''}</p>
              </div>
            </div>

            <div className="p-4 border-b border-gray-700 max-h-48 overflow-y-auto">
              <p className="text-gray-400 text-sm mb-3">The following jobs will be affected:</p>
              <div className="space-y-2">
                {affectedJobs.map(job => (
                  <div key={job.id} className="bg-gray-800 rounded p-3 border-l-4 border-red-500">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-white font-mono font-medium">{job.job_number}</span>
                        <span className="text-gray-500 mx-2">•</span>
                        <span className="text-gray-400">{job.work_order?.wo_number}</span>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        job.status === 'in_progress' ? 'bg-green-600 text-white' :
                        job.status === 'in_setup' ? 'bg-blue-600 text-white' :
                        'bg-gray-600 text-gray-200'
                      }`}>
                        {job.status === 'in_progress' ? 'Running' : 
                         job.status === 'in_setup' ? 'In Setup' : 'Assigned'}
                      </span>
                    </div>
                    {job.component?.part_number && (
                      <p className="text-skynet-accent text-sm font-mono mt-1">{job.component.part_number}</p>
                    )}
                    <p className="text-gray-500 text-xs mt-1">
                      Scheduled: {new Date(job.scheduled_start).toLocaleString()} - {new Date(job.scheduled_end).toLocaleTimeString()}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-4 space-y-3">
              <p className="text-white font-medium mb-2">What should happen to these jobs?</p>
              
              <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                crashAction === 'return_to_queue' 
                  ? 'border-purple-500 bg-purple-900/30' 
                  : 'border-gray-700 hover:border-gray-600'
              }`}>
                <input
                  type="radio"
                  name="crashAction"
                  value="return_to_queue"
                  checked={crashAction === 'return_to_queue'}
                  onChange={(e) => setCrashAction(e.target.value)}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2 text-white font-medium">
                    <RotateCcw size={16} className="text-purple-400" />
                    Return to Queue
                  </div>
                  <p className="text-gray-400 text-sm mt-1">
                    Jobs will be unscheduled and returned to the job pool for manual rescheduling
                  </p>
                </div>
              </label>

              <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                crashAction === 'move_next' 
                  ? 'border-purple-500 bg-purple-900/30' 
                  : 'border-gray-700 hover:border-gray-600'
              }`}>
                <input
                  type="radio"
                  name="crashAction"
                  value="move_next"
                  checked={crashAction === 'move_next'}
                  onChange={(e) => setCrashAction(e.target.value)}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2 text-white font-medium">
                    <ArrowRight size={16} className="text-purple-400" />
                    Move to Next Available
                  </div>
                  <p className="text-gray-400 text-sm mt-1">
                    Jobs will be automatically rescheduled to start after maintenance ends
                  </p>
                </div>
              </label>
            </div>

            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-700 bg-gray-800/50">
              <button
                onClick={() => setShowCrashModal(false)}
                disabled={processingCrash}
                className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCrashResolution}
                disabled={processingCrash}
                className="px-6 py-2 bg-red-600 hover:bg-red-500 disabled:bg-gray-700 text-white font-medium rounded transition-colors flex items-center gap-2"
              >
                {processingCrash ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <AlertTriangle size={16} />
                    Confirm & Create Maintenance
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