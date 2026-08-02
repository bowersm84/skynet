import { useState } from 'react'
import { Plus, CheckCircle, X } from 'lucide-react'
import { formatLogDate, lotLabel } from '../../lib/kitRegistry'
import { loadStcRequests, stcStatusCounts, STC_STATUSES, STATUS_LABEL } from '../../lib/stcIntake'
import { Pill, Spinner, Empty, LinkText, Pager } from './ui'
import { useAsyncData, usePageReset } from './hooks'
import KitDrawer from './KitDrawer'
import StcIntakeForm from './StcIntakeForm'

// The Log STC tab: a worklist of every STC paperwork request, and the New
// Request flow that adds to it (D-KSTC-18). Office-only — the nav entry itself
// is hidden in kiosk mode, and the RPC plus RLS enforce who may actually write.

const STATUS_TONE = {
  new: 'blue',
  needs_info: 'amber',
  matched: 'blue',
  issued: 'green',
  closed: 'gray',
  unidentifiable: 'amber',
}

export default function StcTab({ profile }) {
  const [view, setView] = useState('worklist')     // 'worklist' | 'new'
  const [status, setStatus] = useState(null)       // null = all
  const [refreshKey, setRefreshKey] = useState(0)
  const [created, setCreated] = useState(null)     // { intakeNumber, linkLabel }

  // Breadcrumb stack, shared with every other drawer in the module.
  const [stack, setStack] = useState([])
  const push = (entry) => setStack(prev => [...prev, entry])
  const pop = () => setStack(prev => prev.slice(0, -1))

  const [page, setPage] = usePageReset(`${status}::${refreshKey}`)
  const listKey = `${status}::${page}::${refreshKey}`
  const list = useAsyncData(() => loadStcRequests({ status, page }), listKey)
  const counts = useAsyncData(() => stcStatusCounts(), refreshKey)

  if (view === 'new') {
    return (
      <StcIntakeForm
        profile={profile}
        onCancel={() => setView('worklist')}
        onCreated={({ intakeNumber, linkLabel }) => {
          setCreated({ intakeNumber, linkLabel })
          // Clear any status filter so the brand-new row is definitely visible.
          setStatus(null)
          setRefreshKey(k => k + 1)
          setView('worklist')
        }}
      />
    )
  }

  const rows = list.data?.rows || []
  const total = list.data?.total || 0
  const c = counts.data || {}

  return (
    <div className="p-5 max-w-6xl mx-auto">
      {created && (
        <div className="mb-5 flex items-start gap-3 bg-green-900/30 border border-green-700 rounded-xl px-4 py-3">
          <CheckCircle size={20} className="text-green-400 shrink-0 mt-0.5" />
          {/* The link state is the headline, not a detail: it is the difference
              between a request that is done being triaged and one that isn't. */}
          <p className="flex-1 text-green-200 font-medium">
            Intake #{created.intakeNumber} created —{' '}
            {created.linkLabel
              ? <>linked to <span className="font-mono">{created.linkLabel}</span></>
              : 'unlinked'}
          </p>
          <button onClick={() => setCreated(null)} className="text-green-400/60 hover:text-green-200">
            <X size={18} />
          </button>
        </div>
      )}

      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="text-white text-lg font-semibold">STC requests</h2>
        <button
          onClick={() => { setCreated(null); setView('new') }}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-skynet-accent hover:bg-blue-600 text-white text-sm font-medium"
        >
          <Plus size={16} /> New request
        </button>
      </div>

      {/* Every status shows, zeros included — an empty needs_info queue is worth
          seeing, and a chip that vanishes when it empties can't be trusted. */}
      <div className="flex flex-wrap gap-2 mb-4">
        <Chip label="All" count={c.all} active={status === null} onClick={() => setStatus(null)} />
        {STC_STATUSES.map(s => (
          <Chip
            key={s}
            label={STATUS_LABEL[s]}
            count={c[s]}
            active={status === s}
            onClick={() => setStatus(status === s ? null : s)}
          />
        ))}
      </div>

      <div className="flex justify-end mb-2">
        <Pager page={page} total={total} onPage={setPage} />
      </div>

      {list.loading ? <Spinner label="Loading requests…" />
        : list.error ? <Empty>{list.error}</Empty>
          : !rows.length ? <Empty>No requests{status ? ` with status ${STATUS_LABEL[status]}` : ''}.</Empty>
            : (
              <div className="overflow-x-auto rounded-xl border border-gray-700">
                <table className="w-full text-sm">
                  <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Intake</th>
                      <th className="text-left px-3 py-2 font-medium">Received</th>
                      <th className="text-left px-3 py-2 font-medium">Requester</th>
                      <th className="text-left px-3 py-2 font-medium">Company</th>
                      <th className="text-left px-3 py-2 font-medium">Claimed kit #</th>
                      <th className="text-left px-3 py-2 font-medium">Linked lot</th>
                      <th className="text-left px-3 py-2 font-medium">Claimed reg / serial</th>
                      <th className="text-left px-3 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr
                        key={r.id}
                        onClick={() => push({ type: 'request', id: r.id, label: `Intake #${r.intake_number}` })}
                        className="border-t border-gray-800 hover:bg-gray-800/50 cursor-pointer"
                      >
                        {/* The whole row is the target — a nested button here
                            would fire its own handler AND the row's, pushing the
                            drawer twice. */}
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className="font-mono font-semibold text-skynet-accent">#{r.intake_number}</span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-gray-300">{formatLogDate(r.received_date)}</td>
                        <td className="px-3 py-2 text-gray-200 min-w-[9rem]">{r.requester_name || '—'}</td>
                        <td className="px-3 py-2 text-gray-300 min-w-[9rem]">{r.requester_company || '—'}</td>
                        <td className="px-3 py-2 font-mono text-gray-300 whitespace-nowrap">
                          {r.claimed_kit_number || '—'}
                        </td>
                        {/* stopPropagation: the row opens the request, this cell
                            jumps to the lot instead — two different destinations. */}
                        <td className="px-3 py-2 whitespace-nowrap">
                          {r.lot ? (
                            <LinkText
                              onClick={e => {
                                e.stopPropagation()
                                push({ type: 'lot', id: r.lot.id, label: lotLabel(r.lot) })
                              }}
                            >
                              <span className="font-mono">{lotLabel(r.lot)}</span>
                            </LinkText>
                          ) : (
                            <span className="text-amber-400/80 text-xs" title="No kit log entry linked — awaiting office resolution">
                              — unlinked
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-gray-300 whitespace-nowrap">
                          {r.claimed_registration || '—'} / {r.claimed_aircraft_serial || '—'}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <Pill tone={STATUS_TONE[r.status] || 'gray'}>{STATUS_LABEL[r.status] || r.status}</Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

      {stack.length > 0 && (
        <KitDrawer stack={stack} onPush={push} onPop={pop} onClose={() => setStack([])} />
      )}
    </div>
  )
}

function Chip({ label, count, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg border text-sm transition-colors ${
        active
          ? 'bg-skynet-accent/20 border-skynet-accent text-white'
          : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700'
      }`}
    >
      {label}
      <span className="ml-2 font-mono text-xs text-gray-400">{count ?? '·'}</span>
    </button>
  )
}
