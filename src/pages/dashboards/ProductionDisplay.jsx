import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase'
import { AlertOctagon, Wrench, Power } from 'lucide-react'

export default function ProductionDisplay() {
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState(null)

  const [yesterdaySent, setYesterdaySent] = useState({ total: 0, batches: 0, byPart: [] })
  const [yesterdayPassed, setYesterdayPassed] = useState({ total: 0, batches: 0, byPart: [] })

  const [machineGroups, setMachineGroups] = useState({
    running: [], setup: [], down: [], idle: [], inactive: []
  })

  const [rejected, setRejected] = useState([])
  const [rework, setRework] = useState([])

  const [openCOCount, setOpenCOCount] = useState(0)

  // ---- Date helpers (local timezone) ----
  const yesterdayBounds = () => {
    const now = new Date()
    const today00 = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const yesterday00 = new Date(today00)
    yesterday00.setDate(yesterday00.getDate() - 1)
    return { start: yesterday00.toISOString(), end: today00.toISOString() }
  }
  const fiveDaysAgoISO = () => {
    const d = new Date()
    d.setDate(d.getDate() - 5)
    return d.toISOString()
  }
  const formatDate = (s) => s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
  const yesterdayLabel = (() => {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
  })()

  // ---- Loaders ----
  const loadYesterday = useCallback(async () => {
    const { start, end } = yesterdayBounds()

    const [sentRes, passedRes] = await Promise.all([
      supabase.from('finishing_sends')
        .select('quantity, job:jobs(component:parts!component_id(part_number))')
        .gte('sent_at', start).lt('sent_at', end),
      supabase.from('finishing_sends')
        .select('verified_count, job:jobs(component:parts!component_id(part_number))')
        .not('verified_at', 'is', null)
        .gte('verified_at', start).lt('verified_at', end)
    ])

    if (sentRes.error) console.error('Error loading sent-yesterday:', sentRes.error)
    if (passedRes.error) console.error('Error loading passed-yesterday:', passedRes.error)

    const aggregate = (rows, qtyField) => {
      const total = (rows || []).reduce((s, r) => s + (r[qtyField] || 0), 0)
      const batches = (rows || []).length
      const map = {}
      ;(rows || []).forEach(r => {
        const pn = r.job?.component?.part_number
        if (pn) map[pn] = (map[pn] || 0) + (r[qtyField] || 0)
      })
      const byPart = Object.entries(map)
        .map(([part_number, qty]) => ({ part_number, qty }))
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 5)
      return { total, batches, byPart }
    }

    setYesterdaySent(aggregate(sentRes.data, 'quantity'))
    setYesterdayPassed(aggregate(passedRes.data, 'verified_count'))
  }, [])

  const loadMachineStatus = useCallback(async () => {
    const { data: machines, error: mErr } = await supabase
      .from('machines')
      .select('id, name, code, status, status_reason, is_active, machine_type')
      .neq('machine_type', 'finishing')
      .order('display_order', { ascending: true })
    if (mErr) { console.error('Error loading machines:', mErr); return }

    const { data: downtimes } = await supabase
      .from('machine_downtime_logs')
      .select('machine_id, reason, notes')
      .is('end_time', null)
    const downtimeByMachine = new Map()
    ;(downtimes || []).forEach(d => downtimeByMachine.set(d.machine_id, d))

    const { data: activeJobs } = await supabase
      .from('jobs')
      .select('id, status, assigned_machine_id')
      .in('status', ['in_setup', 'in_progress'])
    const jobByMachine = new Map()
    ;(activeJobs || []).forEach(j => {
      if (j.assigned_machine_id) jobByMachine.set(j.assigned_machine_id, j)
    })

    const groups = { running: [], setup: [], down: [], idle: [], inactive: [] }
    ;(machines || []).forEach(m => {
      if (!m.is_active) { groups.inactive.push(m); return }
      if (downtimeByMachine.has(m.id) || m.status === 'down' || m.status === 'offline') {
        groups.down.push(m); return
      }
      const job = jobByMachine.get(m.id)
      if (job?.status === 'in_setup') groups.setup.push(m)
      else if (job?.status === 'in_progress') groups.running.push(m)
      else groups.idle.push(m)
    })
    setMachineGroups(groups)
  }, [])

  const loadQuality = useCallback(async () => {
    const { data, error } = await supabase
      .from('finishing_sends')
      .select(`
        id, compliance_outcome, compliance_approved_at, compliance_bad_qty, compliance_notes,
        job:jobs(job_number, component:parts!component_id(part_number))
      `)
      .in('compliance_outcome', ['rejected', 'rework'])
      .gte('compliance_approved_at', fiveDaysAgoISO())
      .order('compliance_approved_at', { ascending: false })
      .limit(20)
    if (error) { console.error('Error loading quality:', error); return }
    const all = data || []
    setRejected(all.filter(r => r.compliance_outcome === 'rejected').slice(0, 5))
    setRework(all.filter(r => r.compliance_outcome === 'rework').slice(0, 5))
  }, [])

  const loadOpenCOs = useCallback(async () => {
    const { count, error } = await supabase
      .from('customer_orders')
      .select('id', { count: 'exact', head: true })
      .in('status', ['not_started', 'in_progress'])
    if (error) { console.error('Error loading open COs:', error); return }
    setOpenCOCount(count || 0)
  }, [])

  const loadAll = useCallback(async () => {
    await Promise.all([loadYesterday(), loadMachineStatus(), loadQuality(), loadOpenCOs()])
    setLastUpdated(new Date())
    setLoading(false)
  }, [loadYesterday, loadMachineStatus, loadQuality, loadOpenCOs])

  useEffect(() => {
    loadAll()
    const interval = setInterval(loadAll, 60000)
    return () => clearInterval(interval)
  }, [loadAll])

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-3 border-skynet-accent border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-500 font-mono text-lg">Loading Production Dashboard...</p>
        </div>
      </div>
    )
  }

  const now = new Date()
  const dateLabel = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  const timeLabel = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const totalActive = machineGroups.running.length + machineGroups.setup.length + machineGroups.down.length + machineGroups.idle.length

  return (
    <div className="min-h-screen bg-gray-950 p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <img src="/skybolt-logo-white.png" alt="Skybolt" className="h-8 w-auto opacity-80" />
          <div>
            <h1 className="text-3xl font-bold text-white">Production</h1>
            <p className="text-gray-500 text-sm font-mono">SkyNet — Live Display</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-gray-300 text-lg">{dateLabel} · {timeLabel}</p>
          <div className="flex items-center justify-end gap-2 mt-1">
            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
            <span className="text-green-400 font-mono text-xs">Live</span>
            {lastUpdated && (
              <span className="text-gray-600 text-xs font-mono ml-2">
                · updated {lastUpdated.toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6 mb-6">

        {/* Yesterday's Output */}
        <div className="col-span-3 bg-gray-900 rounded-xl border border-gray-800 p-5">
          <h2 className="text-xl font-bold text-skynet-accent mb-1">Yesterday's Output</h2>
          <p className="text-gray-500 text-xs font-mono mb-5">{yesterdayLabel}</p>

          <div className="mb-5">
            <p className="text-gray-400 text-sm">Sent to finishing</p>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-white font-bold text-4xl">{yesterdaySent.total.toLocaleString()}</span>
              <span className="text-gray-500 text-sm">parts</span>
            </div>
            <p className="text-gray-600 text-xs">{yesterdaySent.batches} batch{yesterdaySent.batches !== 1 ? 'es' : ''}</p>
          </div>

          <div className="mb-5">
            <p className="text-gray-400 text-sm">Passed finishing</p>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-green-400 font-bold text-4xl">{yesterdayPassed.total.toLocaleString()}</span>
              <span className="text-gray-500 text-sm">parts</span>
            </div>
            <p className="text-gray-600 text-xs">{yesterdayPassed.batches} batch{yesterdayPassed.batches !== 1 ? 'es' : ''} · post-dry verified</p>
          </div>

          <div className="border-t border-gray-800 pt-4">
            <p className="text-gray-400 text-xs uppercase tracking-wide mb-2">Parts through finishing</p>
            {yesterdayPassed.byPart.length === 0 ? (
              <p className="text-gray-600 text-sm italic">No parts passed yesterday</p>
            ) : (
              <div className="space-y-1.5">
                {yesterdayPassed.byPart.map(p => (
                  <div key={p.part_number} className="flex items-center justify-between">
                    <span className="text-skynet-accent font-mono text-sm">{p.part_number}</span>
                    <span className="text-white text-sm">{p.qty.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Today's Production — Batch B placeholder */}
        <div className="col-span-6 bg-gray-900 rounded-xl border border-gray-800 p-5">
          <h2 className="text-xl font-bold text-skynet-accent mb-5">Today's Production</h2>

          <div className="bg-gray-950 border border-dashed border-gray-700 rounded-lg p-8 mb-4 text-center">
            <p className="text-gray-600 text-sm font-mono">Active jobs with target progress — Batch B</p>
          </div>

          <div className="bg-gray-950 border border-dashed border-gray-700 rounded-lg p-6 mb-4 text-center">
            <p className="text-gray-600 text-sm font-mono">Upcoming changeovers — Batch B</p>
          </div>

          <div className="bg-gray-950 border border-gray-800 rounded-lg p-5">
            <p className="text-gray-400 text-sm uppercase tracking-wide mb-2">Demand</p>
            <div className="flex items-baseline gap-2">
              <span className="text-white font-bold text-4xl">{openCOCount}</span>
              <span className="text-gray-500">open customer orders</span>
            </div>
          </div>
        </div>

        {/* Machine Status */}
        <div className="col-span-3 bg-gray-900 rounded-xl border border-gray-800 p-5">
          <h2 className="text-xl font-bold text-skynet-accent mb-1">Machine Status</h2>
          <p className="text-gray-500 text-xs font-mono mb-5">{totalActive} production machine{totalActive !== 1 ? 's' : ''}</p>

          <div className="grid grid-cols-2 gap-2 mb-4">
            <StatusTile color="green" label="Running" count={machineGroups.running.length} machines={machineGroups.running} />
            <StatusTile color="amber" label="Setup"   count={machineGroups.setup.length}   machines={machineGroups.setup} />
            <StatusTile color="red"   label="Down"    count={machineGroups.down.length}    machines={machineGroups.down} />
            <StatusTile color="gray"  label="Idle"    count={machineGroups.idle.length}    machines={machineGroups.idle} />
          </div>

          {machineGroups.inactive.length > 0 && (
            <div className="border-t border-gray-800 pt-3 mt-3">
              <div className="flex items-center gap-2 mb-2">
                <Power size={12} className="text-blue-400" />
                <span className="text-blue-400 text-xs uppercase tracking-wide font-bold">
                  Offline · {machineGroups.inactive.length}
                </span>
              </div>
              {machineGroups.inactive.map(m => (
                <div key={m.id} className="text-xs text-gray-400 font-mono ml-4 mb-0.5">
                  {m.code}
                  <span className="text-gray-600 italic ml-2">
                    {m.status_reason || 'Not on site'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Quality & Inspection — full width */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xl font-bold text-skynet-accent">Quality &amp; Inspection</h2>
          <p className="text-gray-500 text-xs font-mono">Last 5 days · {rejected.length + rework.length} event{rejected.length + rework.length !== 1 ? 's' : ''}</p>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <AlertOctagon size={16} className="text-red-400" />
              <span className="text-red-400 font-bold uppercase tracking-wide text-sm">Rejected · {rejected.length}</span>
            </div>
            {rejected.length === 0 ? (
              <p className="text-gray-600 text-sm italic">None in the last 5 days</p>
            ) : (
              <div className="space-y-2">
                {rejected.map(r => <QualityRow key={r.id} record={r} formatDate={formatDate} />)}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center gap-2 mb-3">
              <Wrench size={16} className="text-amber-400" />
              <span className="text-amber-400 font-bold uppercase tracking-wide text-sm">Rework · {rework.length}</span>
            </div>
            {rework.length === 0 ? (
              <p className="text-gray-600 text-sm italic">None in the last 5 days</p>
            ) : (
              <div className="space-y-2">
                {rework.map(r => <QualityRow key={r.id} record={r} formatDate={formatDate} />)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function StatusTile({ color, label, count, machines }) {
  const colorClass = {
    green: { text: 'text-green-400', border: 'border-green-700', bg: 'bg-green-950/30', dot: 'bg-green-400' },
    amber: { text: 'text-amber-400', border: 'border-amber-700', bg: 'bg-amber-950/30', dot: 'bg-amber-400' },
    red:   { text: 'text-red-400',   border: 'border-red-700',   bg: 'bg-red-950/30',   dot: 'bg-red-400' },
    gray:  { text: 'text-gray-400',  border: 'border-gray-700',  bg: 'bg-gray-950/50',  dot: 'bg-gray-500' }
  }[color]
  return (
    <div className={`rounded-lg border ${colorClass.border} ${colorClass.bg} p-3`}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${colorClass.dot}`}></div>
          <span className={`${colorClass.text} text-xs uppercase tracking-wide font-bold`}>{label}</span>
        </div>
        <span className="text-white font-bold text-lg">{count}</span>
      </div>
      <div className="text-gray-200 text-base font-mono leading-relaxed min-h-[2rem] break-words">
        {machines.length === 0
          ? <span className="text-gray-600 italic">—</span>
          : machines.map(m => m.code).join(' · ')}
      </div>
    </div>
  )
}

function QualityRow({ record, formatDate }) {
  return (
    <div className="bg-gray-950 border border-gray-800 rounded px-3 py-2 text-sm">
      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
        <span className="text-white font-mono font-medium">{record.job?.component?.part_number || '—'}</span>
        <span className="text-gray-600">·</span>
        <span className="text-skynet-accent font-mono text-xs">{record.job?.job_number}</span>
        <span className="text-gray-600">·</span>
        <span className="text-gray-400 text-xs">{formatDate(record.compliance_approved_at)}</span>
        <span className="text-gray-600">·</span>
        <span className="text-white text-xs">{record.compliance_bad_qty || 0} pcs</span>
      </div>
      {record.compliance_notes && (
        <p className="text-gray-500 text-xs italic truncate">{record.compliance_notes}</p>
      )}
    </div>
  )
}
