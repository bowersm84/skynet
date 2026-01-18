import { Monitor } from 'lucide-react'

export default function MachineCard({ machine, jobs, getPriorityColor }) {
  const activeJob = jobs.find(j => j.status === 'in_progress' || j.status === 'in_setup')
  const queuedJobs = jobs.filter(j => j.status !== 'in_progress' && j.status !== 'in_setup')

  const getStatusColor = (status) => {
    switch (status) {
      case 'available': return 'text-green-500'
      case 'in_use': return 'text-skynet-accent'
      case 'maintenance': return 'text-yellow-500'
      case 'offline': return 'text-red-500'
      default: return 'text-gray-500'
    }
  }

  const getStatusBg = (status) => {
    switch (status) {
      case 'available': return 'border-green-800'
      case 'in_use': return 'border-blue-800'
      case 'maintenance': return 'border-yellow-800'
      case 'offline': return 'border-red-800'
      default: return 'border-gray-800'
    }
  }

  const handleLaunchKiosk = () => {
    // Use machine code if available, otherwise use name (URL encoded)
    const identifier = machine.code || machine.name
    const kioskUrl = `/kiosk/${encodeURIComponent(identifier)}`
    window.open(kioskUrl, '_blank')
  }

  return (
    <div className={`bg-gray-900 rounded-lg border ${getStatusBg(machine.status)} overflow-hidden`}>
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <div>
          <h3 className="text-white font-semibold">{machine.name}</h3>
          <p className="text-gray-500 text-sm font-mono">{machine.code}</p>
        </div>
        <div className="text-right">
          <span className={`text-sm font-medium ${getStatusColor(machine.status)}`}>
            {machine.status === 'in_use' ? 'In Use' : 
             machine.status.charAt(0).toUpperCase() + machine.status.slice(1)}
          </span>
        </div>
      </div>

      <div className="p-4">
        {activeJob ? (
          <div className="bg-gray-800 rounded p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-skynet-accent font-mono text-sm">
                {activeJob.status === 'in_setup' ? 'SETUP' : 'RUNNING'}
              </span>
              <div className={`w-3 h-3 rounded-full ${getPriorityColor(activeJob.priority)} animate-pulse`}></div>
            </div>
            <p className="text-white font-semibold">{activeJob.job_number}</p>
            <p className="text-gray-400 text-sm">{activeJob.work_order?.wo_number}</p>
            {activeJob.component?.part_number && (
              <p className="text-skynet-accent text-sm font-mono">{activeJob.component.part_number}</p>
            )}
          </div>
        ) : (
          <div className="bg-gray-800/50 rounded p-3 border border-dashed border-gray-700">
            <p className="text-gray-600 text-sm text-center">No active job</p>
          </div>
        )}

        {queuedJobs.length > 0 && (
          <div className="mt-3">
            <p className="text-gray-500 text-xs mb-2">QUEUE ({queuedJobs.length})</p>
            <div className="space-y-1">
              {queuedJobs.slice(0, 3).map(job => (
                <div key={job.id} className="flex items-center justify-between text-sm">
                  <span className="text-gray-400 font-mono">{job.job_number}</span>
                  <div className={`w-2 h-2 rounded-full ${getPriorityColor(job.priority)}`}></div>
                </div>
              ))}
              {queuedJobs.length > 3 && (
                <p className="text-gray-600 text-xs">+{queuedJobs.length - 3} more</p>
              )}
            </div>
          </div>
        )}

        {jobs.length === 0 && machine.status === 'available' && (
          <p className="text-gray-600 text-xs text-center mt-2">Ready for assignment</p>
        )}

        {/* Launch Kiosk Button */}
        <button
          onClick={handleLaunchKiosk}
          className="w-full mt-3 py-2 px-3 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-skynet-accent text-gray-400 hover:text-white rounded transition-colors flex items-center justify-center gap-2 text-sm"
        >
          <Monitor size={16} />
          Launch Kiosk
        </button>
      </div>
    </div>
  )
}