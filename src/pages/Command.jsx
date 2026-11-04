import { useState } from 'react'
import { X } from 'lucide-react'
import Schedule from './Schedule'
import DemandView from '../components/demand/DemandView'
import { hasRole } from '../lib/roles'

// Command — the Schedule (timeline, machine lineup and job pool) and, from S17 B2 (D-ASM-33), the Demand tab moved
// here from Customer Orders: open CO lines and warehouse stock requests by part, rolled into a work order. Demand
// shows for the roles that read it on Customer Orders and can open this page; Create Work Order inside it stays
// admin / scheduler (D-DEMAND-01). The Schedule stays mounted under the Demand tab, so it keeps its live view and
// its place. Everyone else gets the Schedule exactly as before, with no tab strip.
const DEMAND_ROLES = ['admin', 'scheduler', 'customer_service', 'president', 'viewer']

export default function Command({ user, profile, onNavigate, canEdit = false }) {
  const canSeeDemand = hasRole(profile, ...DEMAND_ROLES)
  const [tab, setTab] = useState('schedule') // 'schedule' | 'demand'
  const [actionStatus, setActionStatus] = useState(null)

  if (!canSeeDemand) {
    return <Schedule user={user} profile={profile} onNavigate={onNavigate} canEdit={canEdit} />
  }

  const tabClass = (t) => `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
    tab === t ? 'border-skynet-accent text-skynet-accent' : 'border-transparent text-gray-400 hover:text-white'
  }`

  return (
    <>
      <div className="flex items-center gap-1 border-b border-gray-800 mb-3">
        {/* Demand first in the row; Schedule is still where the page opens (S17 B2c, D-ASM-33). */}
        <button onClick={() => setTab('demand')} className={tabClass('demand')}>Demand</button>
        <button onClick={() => setTab('schedule')} className={tabClass('schedule')}>Schedule</button>
      </div>

      {/* The tab strip takes ~52px, so the Schedule's fixed height drops by that much. */}
      <div className={tab === 'schedule' ? '' : 'hidden'}>
        <Schedule user={user} profile={profile} onNavigate={onNavigate} canEdit={canEdit} heightClass="h-[calc(100vh-232px)]" />
      </div>

      {tab === 'demand' && (
        <div className="max-w-7xl mx-auto pb-16">
          {actionStatus && (
            <div className={`mb-4 p-3 rounded text-sm flex justify-between items-center ${
              actionStatus.type === 'success'
                ? 'bg-green-900/40 text-green-300 border border-green-800'
                : 'bg-red-900/40 text-red-300 border border-red-800'
            }`}>
              <span>{actionStatus.message}</span>
              <button onClick={() => setActionStatus(null)}><X size={14} /></button>
            </div>
          )}
          <DemandView profile={profile} setActionStatus={setActionStatus} />
        </div>
      )}
    </>
  )
}
