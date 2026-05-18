import { Monitor, AlertTriangle, Wrench, Clock } from 'lucide-react'

export default function MachineCard({ machine, jobs, getPriorityColor, ongoingDowntime, activeMaintenanceJob }) {
  const activeJob = jobs.find(j => j.status === 'in_progress' || j.status === 'in_setup')
  const queuedJobs = jobs.filter(j => j.status !== 'in_progress' && j.status !== 'in_setup')

  // Check if machine is DOWN - either from database status, ongoing downtime, or active unplanned maintenance
  const isDown = machine.status === 'down' || !!ongoingDowntime || !!activeMaintenanceJob

  // Determine the DOWN reason to display
  const getDownReason = () => {
    // Priority: 1. Ongoing machinist-logged downtime, 2. Active unplanned maintenance, 3. Database status_reason
    if (ongoingDowntime) {
      return `Ongoing: ${ongoingDowntime.reason}${ongoingDowntime.notes ? ` - ${ongoingDowntime.notes}` : ''}`
    }
    if (activeMaintenanceJob) {
      return `Unplanned Maintenance: ${activeMaintenanceJob.maintenance_description || activeMaintenanceJob.work_order?.notes || 'In progress'}`
    }
    return machine.status_reason
  }

  const downReason = isDown ? getDownReason() : null

  // Derive a single status string from machine + job state.
  // Priority: Down > Setup > Running > Ready/Staged > Idle.
  // Ready vs Staged depends on whether the machine is kiosk-enabled —
  // a Staged machine has work queued but no kiosk to launch from yet
  // (waiting on phased rollout).
  const derivedStatus = (() => {
    if (isDown) return 'down'
    if (activeJob?.status === 'in_setup') return 'setup'
    if (activeJob?.status === 'in_progress') return 'running'
    if (queuedJobs.length > 0) {
      return machine.kiosk_enabled ? 'ready' : 'staged'
    }
    return 'idle'
  })()

  const getStatusColor = (status) => {
    switch (status) {
      case 'down': return 'text-red-500'
      case 'setup': return 'text-skynet-accent'
      case 'running': return 'text-skynet-accent'
      case 'ready': return 'text-green-500'
      case 'staged': return 'text-amber-400'
      case 'idle': return 'text-gray-500'
      default: return 'text-gray-500'
    }
  }

  const getStatusBg = (status) => {
    switch (status) {
      case 'down': return 'border-red-600 bg-red-950/30'
      case 'setup': return 'border-blue-800'
      case 'running': return 'border-blue-800'
      case 'ready': return 'border-green-800'
      case 'staged': return 'border-amber-800'
      case 'idle': return 'border-gray-800'
      default: return 'border-gray-800'
    }
  }

  const getStatusDisplay = (status) => {
    switch (status) {
      case 'down': return 'DOWN'
      case 'setup': return 'Setup'
      case 'running': return 'Running'
      case 'ready': return 'Ready'
      case 'staged': return 'Staged'
      case 'idle': return 'Idle'
      default: return status.charAt(0).toUpperCase() + status.slice(1)
    }
  }

  const handleLaunchKiosk = () => {
    // Use machine code if available, otherwise use name (URL encoded)
    const identifier = machine.code || machine.name
    const kioskUrl = `/kiosk/${encodeURIComponent(identifier)}`
    window.open(kioskUrl, '_blank')
  }

  // Check if active job is a maintenance job
  const isMaintenanceActive = activeJob?.is_maintenance || activeJob?.work_order?.order_type === 'maintenance'
  const maintenanceType = activeJob?.work_order?.maintenance_type

  return (
    <div className={`bg-gray-900 rounded-lg border ${getStatusBg(derivedStatus)} overflow-hidden ${isDown ? 'ring-2 ring-red-500/50' : ''}`}>
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <div>
          <h3 className="text-white font-semibold">{machine.name}</h3>
          <p className="text-gray-500 text-sm font-mono">{machine.code}</p>
        </div>
        <div className="text-right">
          {isDown ? (
            <span className="inline-flex items-center gap-1 px-2 py-1 bg-red-600 text-white text-xs font-bold rounded animate-pulse">
              <AlertTriangle size={12} />
              DOWN
            </span>
          ) : (
            <span className={`text-sm font-medium ${getStatusColor(derivedStatus)}`}>
              {getStatusDisplay(derivedStatus)}
            </span>
          )}
        </div>
      </div>

      <div className="p-4">
        {/* DOWN status reason display */}
        {isDown && downReason && (
          <div className="mb-3 p-2 bg-red-900/30 border border-red-700 rounded text-red-300 text-xs">
            <span className="font-semibold">Reason:</span> {downReason}
          </div>
        )}

        {/* Show ongoing downtime info if present */}
        {ongoingDowntime && (
          <div className="mb-3 p-2 bg-red-900/20 border border-red-800 rounded">
            <div className="flex items-center gap-2 text-red-400 text-xs">
              <AlertTriangle size={12} />
              <span className="font-semibold">Ongoing Downtime</span>
            </div>
            <p className="text-red-300 text-xs mt-1">
              Started: {new Date(ongoingDowntime.start_time).toLocaleString()}
            </p>
          </div>
        )}

        {/* Show active unplanned maintenance if present (and different from active job) */}
        {activeMaintenanceJob && !activeJob && (
          <div className="mb-3 p-2 bg-purple-900/20 border border-purple-800 rounded">
            <div className="flex items-center gap-2 text-purple-400 text-xs">
              <Wrench size={12} />
              <span className="font-semibold">Unplanned Maintenance</span>
            </div>
            <p className="text-purple-300 text-xs mt-1 font-mono">
              {activeMaintenanceJob.job_number}
            </p>
          </div>
        )}

        {activeJob ? (
          <div className={`rounded p-3 ${
            isMaintenanceActive 
              ? maintenanceType === 'unplanned' 
                ? 'bg-purple-900/30 border border-purple-700' 
                : 'bg-blue-900/30 border border-blue-700'
              : 'bg-gray-800'
          }`}>
            <div className="flex items-center justify-between mb-2">
              <span className={`font-mono text-sm ${
                isMaintenanceActive
                  ? maintenanceType === 'unplanned' ? 'text-purple-400' : 'text-blue-400'
                  : 'text-skynet-accent'
              }`}>
                {isMaintenanceActive ? (
                  <span className="flex items-center gap-1">
                    <Wrench size={12} />
                    {maintenanceType === 'unplanned' ? 'UNPLANNED' : 'MAINTENANCE'}
                  </span>
                ) : (
                  activeJob.status === 'in_setup' ? 'SETUP' : 'RUNNING'
                )}
              </span>
              <div className="flex items-center gap-2">
                {!isMaintenanceActive && activeJob.quantity > 0 && (
                  <span
                    className="text-[11px] font-mono text-gray-300 px-1.5 py-0.5 bg-gray-900 border border-gray-700 rounded"
                    title="Parts accepted from finishing / Job quantity"
                  >
                    Finished: {activeJob.finished_qty || 0}/{activeJob.quantity}
                  </span>
                )}
                {!isMaintenanceActive && (
                  <div className={`w-3 h-3 rounded-full ${getPriorityColor(activeJob.priority)} animate-pulse`}></div>
                )}
              </div>
            </div>
            {isMaintenanceActive ? (
              <>
                <p className="text-white font-semibold">{activeJob.job_number}</p>
                <p className="text-gray-400 text-sm">{activeJob.work_order?.wo_number}</p>
              </>
            ) : (
              <>
                <p className="text-white font-semibold font-mono">{activeJob.component?.part_number || activeJob.job_number}</p>
                <p className="text-gray-400 text-sm">{activeJob.work_order?.wo_number}</p>
                {activeJob.component?.part_number && (
                  <p className="text-skynet-accent text-xs font-mono">{activeJob.job_number}</p>
                )}
              </>
            )}
            {isMaintenanceActive && activeJob.maintenance_description && (
              <p className="text-gray-400 text-xs mt-1 line-clamp-2">{activeJob.maintenance_description}</p>
            )}
          </div>
        ) : (
          <div className={`rounded p-3 border border-dashed ${isDown ? 'bg-red-900/20 border-red-700' : 'bg-gray-800/50 border-gray-700'}`}>
            <p className={`text-sm text-center ${isDown ? 'text-red-400' : 'text-gray-600'}`}>
              {isDown ? 'Machine is DOWN' : 'No active job'}
            </p>
          </div>
        )}

        {queuedJobs.length > 0 && (
          <div className="mt-3">
            <p className="text-gray-500 text-xs mb-2">QUEUE ({queuedJobs.length})</p>
            <div className="space-y-1">
              {queuedJobs.slice(0, 3).map(job => (
                <div key={job.id} className="flex items-center justify-between text-sm">
                  <span className={`font-mono truncate ${
                    job.status === 'pending_compliance'
                      ? 'text-amber-400/70'
                      : 'text-gray-300'
                  }`}>
                    {job.component?.part_number || job.job_number}
                  </span>
                  {job.status === 'pending_compliance' ? (
                    <span className="flex items-center gap-1 text-[9px] font-bold text-amber-400 bg-amber-900/50 border border-amber-700/50 px-1.5 py-0.5 rounded">
                      <Clock size={8} />
                      Compliance
                    </span>
                  ) : (
                    <div className={`w-2 h-2 rounded-full ${getPriorityColor(job.priority)}`}></div>
                  )}
                </div>
              ))}
              {queuedJobs.length > 3 && (
                <p className="text-gray-600 text-xs">+{queuedJobs.length - 3} more</p>
              )}
            </div>
          </div>
        )}

        {derivedStatus === 'idle' && (
          <p className="text-gray-600 text-xs text-center mt-2">Ready for assignment</p>
        )}

        {/* Launch Kiosk / Finishing Station Button */}
        {machine.machine_type === 'finishing' ? (
          <a
            href="/finishing"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full mt-3 py-2 px-3 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-skynet-accent text-gray-400 hover:text-white rounded transition-colors flex items-center justify-center gap-2 text-sm"
          >
            <Monitor size={16} />
            Launch Finishing Station
          </a>
        ) : (
          <button
            onClick={handleLaunchKiosk}
            className="w-full mt-3 py-2 px-3 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-skynet-accent text-gray-400 hover:text-white rounded transition-colors flex items-center justify-center gap-2 text-sm"
          >
            <Monitor size={16} />
            Launch Kiosk
          </button>
        )}
      </div>
    </div>
  )
}