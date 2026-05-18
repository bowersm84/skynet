import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase'
import { deriveMachineStatus } from '../../lib/machineStatus'
import { Power } from 'lucide-react'

// ---- Date helpers (module-level, pure, local timezone) ----
// Skybolt is closed Sat/Sun. "Last business day" walks backward from today
// until it hits a weekday: Sun/Mon → Fri, Tue → Mon, Wed-Fri → previous day.
const lastBusinessDay = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - 1)
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1)
  }
  return d
}
// Build ISO bounds for any Date — local midnight to next local midnight.
const dateBounds = (date) => {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { start: start.toISOString(), end: end.toISOString() }
}
// <input type="date"> ↔ Date conversions, both using local date parts to
// avoid UTC drift (toISOString shifts the day across midnight in many TZs).
const dateToInputValue = (d) => {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}
const inputValueToDate = (s) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export default function ProductionDisplay() {
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState(null)

  const [outputData, setOutputData] = useState({
    passedTotal: 0, passedBatches: 0,
    acceptedTotal: 0, acceptedBatches: 0,
    partsAccepted: []
  })

  const [machineGroups, setMachineGroups] = useState({
    running: [], setup: [], down: [], idle: [], inactive: []
  })

  const [activeJobs, setActiveJobs] = useState([])
  const [downMachineETAs, setDownMachineETAs] = useState([])

  // Date being viewed in the "Output" section. Defaults to the most recent
  // business day; user can override via the date picker in the section header.
  const [selectedDate, setSelectedDate] = useState(() => lastBusinessDay())

  // ---- In-component date derivations ----
  const selectedDateLabel = selectedDate.toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric'
  })
  const selectedDateHeading = `${selectedDate.toLocaleDateString('en-US', { weekday: 'long' })}'s Output`

  // ---- Loaders ----
  // Output for the selected date.
  //   Passed Finishing = batches with status='finishing_complete' that completed that day.
  //                      Quantity = verified_count (the count after Dry-stage verification).
  //   Accepted         = batches that cleared compliance review with outcome='accepted' that day.
  //                      Quantity = compliance_good_qty (qty Roger marked good).
  // Both metrics reflect actual flow through quality gates, not batch creation volume.
  const loadYesterday = useCallback(async () => {
    const { start, end } = dateBounds(selectedDate)

    const [passedRes, acceptedRes] = await Promise.all([
      supabase.from('finishing_sends')
        .select('verified_count, job:jobs(component:parts!component_id(part_number))')
        .eq('status', 'finishing_complete')
        .gte('finishing_completed_at', start).lt('finishing_completed_at', end),
      supabase.from('finishing_sends')
        .select('compliance_good_qty, job:jobs(component:parts!component_id(part_number))')
        .eq('compliance_outcome', 'accepted')
        .gte('compliance_approved_at', start).lt('compliance_approved_at', end),
    ])

    if (passedRes.error) console.error('Error loading passed-finishing:', passedRes.error)
    if (acceptedRes.error) console.error('Error loading accepted:', acceptedRes.error)

    const passedRows = passedRes.data || []
    const acceptedRows = acceptedRes.data || []

    const passedTotal = passedRows.reduce((s, r) => s + (r.verified_count || 0), 0)
    const passedBatches = passedRows.length
    const acceptedTotal = acceptedRows.reduce((s, r) => s + (r.compliance_good_qty || 0), 0)
    const acceptedBatches = acceptedRows.length

    const acceptedByPart = {}
    for (const r of acceptedRows) {
      const pn = r.job?.component?.part_number || '—'
      acceptedByPart[pn] = (acceptedByPart[pn] || 0) + (r.compliance_good_qty || 0)
    }
    const partsAccepted = Object.entries(acceptedByPart)
      .map(([part_number, qty]) => ({ part_number, qty }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 6)

    setOutputData({ passedTotal, passedBatches, acceptedTotal, acceptedBatches, partsAccepted })
  }, [selectedDate])

  // Uses the shared deriveMachineStatus helper (src/lib/machineStatus.js) so
  // Production / Bridge / Mainframe stay aligned on classification. Bucket map:
  //   Running = derived running + ready + staged  (staged work counts as actively producing)
  //   Setup   = derived setup
  //   Down    = derived down
  //   Idle    = derived idle  (truly idle — no queued or active work)
  const loadMachineStatus = useCallback(async () => {
    const { data: machines, error: mErr } = await supabase
      .from('machines')
      .select('id, name, code, status, status_reason, is_active, machine_type, kiosk_enabled')
      .neq('machine_type', 'finishing')
      .eq('is_commissioned', true)
      .order('display_order', { ascending: true })
    if (mErr) { console.error('Error loading machines:', mErr); return }

    const { data: downtimes } = await supabase
      .from('machine_downtime_logs')
      .select('machine_id, reason, notes')
      .is('end_time', null)
    const downtimeByMachine = new Set((downtimes || []).map(d => d.machine_id))

    // Pull the active + queued window deriveMachineStatus expects. Includes
    // 'pending_compliance' so a kiosk-enabled machine with only a pending-
    // compliance job correctly surfaces as Ready (matches MachineCard truth).
    const { data: jobsForMachines, error: jErr } = await supabase
      .from('jobs')
      .select('id, status, assigned_machine_id')
      .in('status', ['pending_compliance', 'assigned', 'ready', 'in_setup', 'in_progress'])
      .not('assigned_machine_id', 'is', null)
    if (jErr) console.error('Error loading machine jobs:', jErr)

    const jobsByMachine = {}
    for (const j of (jobsForMachines || [])) {
      if (!jobsByMachine[j.assigned_machine_id]) jobsByMachine[j.assigned_machine_id] = []
      jobsByMachine[j.assigned_machine_id].push(j)
    }

    const groups = { running: [], setup: [], down: [], idle: [], inactive: [] }
    for (const m of (machines || [])) {
      if (!m.is_active) { groups.inactive.push(m); continue }
      const derived = deriveMachineStatus(m, jobsByMachine[m.id] || [], downtimeByMachine.has(m.id))
      if (derived === 'down') groups.down.push(m)
      else if (derived === 'setup') groups.setup.push(m)
      else if (derived === 'running' || derived === 'ready' || derived === 'staged') groups.running.push(m)
      else groups.idle.push(m)
    }
    setMachineGroups(groups)
  }, [])

  // For each currently-down machine, find the active DTU (downtime unit) job —
  // a job_number LIKE 'DTU-%' on a non-terminal status whose scheduled window
  // contains NOW. Display the DTU number, the MO description (work_orders.notes),
  // an UNPLANNED badge when maintenance_type='unplanned', and scheduled_end as
  // the estimated return.
  //
  // Machines flagged down with no active DTU still appear with TBD / — so the
  // signal "machine is down" survives even when no maintenance order is logged.
  const loadDownMachineETAs = useCallback(async () => {
    const machinesRes = await supabase
      .from('machines')
      .select('id, code, name, status')
      .eq('is_active', true)
      .eq('is_commissioned', true)
      .eq('status', 'down')

    if (machinesRes.error) {
      console.error('loadDownMachineETAs/machines error:', machinesRes.error)
      setDownMachineETAs([])
      return
    }

    const downMachines = machinesRes.data || []
    if (downMachines.length === 0) {
      setDownMachineETAs([])
      return
    }

    const ids = downMachines.map(m => m.id)
    const { data: dtus, error } = await supabase
      .from('jobs')
      .select(`
        id, job_number, status, scheduled_start, scheduled_end, assigned_machine_id,
        work_order:work_orders(wo_number, notes, maintenance_type, order_type)
      `)
      .ilike('job_number', 'DTU-%')
      .in('assigned_machine_id', ids)
      .in('status', ['pending_compliance', 'ready', 'assigned', 'in_setup', 'in_progress'])

    if (error) {
      console.error('loadDownMachineETAs/dtus error:', error)
      setDownMachineETAs([])
      return
    }

    const now = Date.now()
    const candidatesByMachine = {}
    for (const d of (dtus || [])) {
      if (!d.scheduled_start || !d.scheduled_end) continue
      const startMs = new Date(d.scheduled_start).getTime()
      const endMs = new Date(d.scheduled_end).getTime()
      if (now < startMs || now > endMs) continue
      if (!candidatesByMachine[d.assigned_machine_id]) candidatesByMachine[d.assigned_machine_id] = []
      candidatesByMachine[d.assigned_machine_id].push(d)
    }

    const result = downMachines.map(m => {
      const candidates = candidatesByMachine[m.id] || []
      candidates.sort((a, b) => new Date(a.scheduled_end) - new Date(b.scheduled_end))
      const primary = candidates[0]
      return {
        machine_code: m.code,
        machine_name: m.name,
        dtu_number: primary?.job_number || null,
        description: primary?.work_order?.notes || null,
        maintenance_type: primary?.work_order?.maintenance_type || null,
        estimated_return: primary?.scheduled_end || null,
      }
    }).sort((a, b) => {
      const aEnd = a.estimated_return ? new Date(a.estimated_return).getTime() : Infinity
      const bEnd = b.estimated_return ? new Date(b.estimated_return).getTime() : Infinity
      return aEnd - bEnd
    })

    setDownMachineETAs(result)
  }, [])

  // Active jobs row data.
  //   Displayed metric  = pieces passed finishing  /  target qty
  //     pieces_passed_finishing := SUM(verified_count) from finishing_sends w/ status='finishing_complete'
  //     target_qty := qty_override ?? quantity   (qty_override is a REPLACEMENT for the job's total)
  //   Pacing input      = machinist's good_pieces / target_qty
  //     We keep the machinist count for the traffic light because finishing yield
  //     lags by hours — the displayed total changed, but urgency keeps the
  //     more-immediate source so a slipping job doesn't go green just because
  //     its first batch hasn't finished drying yet.
  //
  // Staged-machine handling. Until the kiosk rollout completes (currently only
  // Mazak 5 is on kiosks), non-kiosk machines with queued work won't show as
  // in_progress in the DB even when an operator is physically working on the
  // staged job. We synthesize the earliest queued job per `staged` machine as
  // if it were in_progress, with production_start = scheduled_start.
  //
  // J-FIN standalone finishing jobs are excluded — they're not manufacturing.
  //
  // Due-date fallback: work_orders.due_date → earliest active
  // customer_order_allocations → customer_order_lines.due_date → null.
  const loadActiveJobs = useCallback(async () => {
    const machinesRes = await supabase
      .from('machines')
      .select('id, status, kiosk_enabled')
      .eq('is_active', true)
      .eq('is_commissioned', true)

    const jobsRes = await supabase
      .from('jobs')
      .select(`
        id, job_number, status, quantity, qty_override, good_pieces, bad_pieces,
        estimated_minutes, setup_start, production_start, scheduled_start, scheduled_end,
        assigned_machine_id,
        component:parts!component_id(part_number, description),
        machine:machines!assigned_machine_id(code, name)
      `)
      .in('status', ['in_setup', 'in_progress', 'ready', 'assigned'])
      .not('assigned_machine_id', 'is', null)
      .not('job_number', 'ilike', 'J-FIN-%')

    if (machinesRes.error || jobsRes.error) {
      console.error('loadActiveJobs error:', machinesRes.error, jobsRes.error)
      setActiveJobs([])
      return
    }

    const machines = machinesRes.data || []
    const allJobs = jobsRes.data || []

    const jobsByMachine = {}
    for (const j of allJobs) {
      if (!jobsByMachine[j.assigned_machine_id]) jobsByMachine[j.assigned_machine_id] = []
      jobsByMachine[j.assigned_machine_id].push(j)
    }

    const list = []
    for (const j of allJobs) {
      if (j.status === 'in_setup' || j.status === 'in_progress') {
        list.push(j)
      }
    }
    for (const m of machines) {
      const onMachine = jobsByMachine[m.id] || []
      const derived = deriveMachineStatus(m, onMachine)
      if (derived !== 'staged') continue

      const earliestQueued = onMachine
        .filter(j => (j.status === 'ready' || j.status === 'assigned') && j.scheduled_start)
        .sort((a, b) => new Date(a.scheduled_start) - new Date(b.scheduled_start))[0]
      if (!earliestQueued) continue

      list.push({
        ...earliestQueued,
        status: 'in_progress',
        production_start: earliestQueued.scheduled_start,
      })
    }

    const activeJobIds = list.map(j => j.id)
    const finishingByJob = {}
    if (activeJobIds.length > 0) {
      const { data: finishingRows, error: e2 } = await supabase
        .from('finishing_sends')
        .select('job_id, verified_count')
        .in('job_id', activeJobIds)
        .eq('status', 'finishing_complete')

      if (e2) {
        console.error('loadActiveJobs/finishing error:', e2)
      } else {
        for (const r of (finishingRows || [])) {
          finishingByJob[r.job_id] = (finishingByJob[r.job_id] || 0) + (r.verified_count || 0)
        }
      }
    }

    const now = Date.now()
    const SETUP_RED_AFTER_MS = 2 * 60 * 60 * 1000  // 2h hard threshold

    const enriched = list.map(j => {
      const finished = finishingByJob[j.id] || 0
      const targetQty = j.qty_override ?? j.quantity ?? 0
      let trafficLight = 'grey'
      let elapsedMs = 0

      if (j.status === 'in_setup') {
        if (j.setup_start) {
          elapsedMs = now - new Date(j.setup_start).getTime()
          trafficLight = elapsedMs > SETUP_RED_AFTER_MS ? 'red' : 'amber'
        } else {
          trafficLight = 'amber'
        }
      } else if (j.status === 'in_progress') {
        if (j.production_start && j.estimated_minutes) {
          elapsedMs = now - new Date(j.production_start).getTime()
          const estimatedMs = j.estimated_minutes * 60 * 1000
          const elapsedPct = elapsedMs / estimatedMs
          const progressPct = targetQty > 0 ? (j.good_pieces || 0) / targetQty : 0
          if (elapsedPct <= 0) {
            trafficLight = 'grey'
          } else if (progressPct >= elapsedPct - 0.05) {
            trafficLight = 'green'
          } else if (progressPct >= elapsedPct - 0.25) {
            trafficLight = 'amber'
          } else {
            trafficLight = 'red'
          }
        } else if (j.production_start) {
          elapsedMs = now - new Date(j.production_start).getTime()
          trafficLight = 'grey'  // running but no estimate — no signal
        }
      }

      return { ...j, finished, targetQty, trafficLight, elapsedMs }
    })

    // UP NEXT enrichment. For each active row, find the next queued job on
    // the same machine. Filter out the row's own id so a staged-synthesized
    // row (which appears in both the active list AND queuedByMachine via the
    // original ready/assigned job) doesn't show itself as "up next."
    const queuedByMachine = {}
    for (const j of allJobs) {
      if (j.status !== 'ready' && j.status !== 'assigned') continue
      if (!j.scheduled_start) continue
      if (!queuedByMachine[j.assigned_machine_id]) queuedByMachine[j.assigned_machine_id] = []
      queuedByMachine[j.assigned_machine_id].push(j)
    }
    for (const queue of Object.values(queuedByMachine)) {
      queue.sort((a, b) => new Date(a.scheduled_start) - new Date(b.scheduled_start))
    }

    // Current work-week range (Mon 00:00 → Fri 23:59:59 local) for the
    // THIS WK highlight. Computed once; cheap.
    const weekRange = (() => {
      const wNow = new Date()
      const dayOfWeek = wNow.getDay()                  // 0=Sun, 1=Mon, ..., 6=Sat
      const daysSinceMonday = (dayOfWeek + 6) % 7      // 0 if Mon, 6 if Sun
      const monday = new Date(wNow)
      monday.setHours(0, 0, 0, 0)
      monday.setDate(wNow.getDate() - daysSinceMonday)
      const friday = new Date(monday)
      friday.setDate(monday.getDate() + 4)
      friday.setHours(23, 59, 59, 999)
      return { start: monday.getTime(), end: friday.getTime() }
    })()

    for (const row of enriched) {
      const queueList = queuedByMachine[row.assigned_machine_id] || []
      const nextCandidate = queueList.filter(q => q.id !== row.id)[0] || null
      if (nextCandidate) {
        const startMs = new Date(nextCandidate.scheduled_start).getTime()
        row.next_up = {
          part_number: nextCandidate.component?.part_number || '—',
          scheduled_start: nextCandidate.scheduled_start,
          is_this_week: startMs >= weekRange.start && startMs <= weekRange.end,
        }
      } else {
        row.next_up = null
      }
    }

    // Sort by scheduled_end ascending — earliest deadline first.
    // Jobs with no scheduled_end sort to the bottom.
    enriched.sort((a, b) => {
      const aEnd = a.scheduled_end ? new Date(a.scheduled_end).getTime() : Infinity
      const bEnd = b.scheduled_end ? new Date(b.scheduled_end).getTime() : Infinity
      return aEnd - bEnd
    })

    setActiveJobs(enriched)
  }, [])

  const loadAll = useCallback(async () => {
    await Promise.all([
      loadYesterday(),
      loadMachineStatus(),
      loadActiveJobs(),
      loadDownMachineETAs(),
    ])
    setLastUpdated(new Date())
    setLoading(false)
  }, [loadYesterday, loadMachineStatus, loadActiveJobs, loadDownMachineETAs])

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

        {/* Output for selected date — defaults to last business day */}
        <div className="col-span-3 bg-gray-900 rounded-xl border border-gray-800 p-5">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h2 className="text-xl font-bold text-skynet-accent">{selectedDateHeading}</h2>
            <input
              type="date"
              value={dateToInputValue(selectedDate)}
              max={dateToInputValue(new Date())}
              onChange={(e) => {
                if (e.target.value) {
                  setSelectedDate(inputValueToDate(e.target.value))
                }
              }}
              style={{ colorScheme: 'dark' }}
              className="bg-gray-800 border border-gray-700 rounded text-gray-300 text-xs font-mono px-2 py-1 focus:outline-none focus:border-skynet-accent"
              title="Choose date to review"
            />
          </div>
          <p className="text-gray-500 text-xs font-mono mb-5">{selectedDateLabel}</p>

          <div className="mb-5">
            <p className="text-gray-400 text-sm">Passed Finishing</p>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-white font-bold text-4xl">{outputData.passedTotal.toLocaleString()}</span>
              <span className="text-gray-500 text-sm">parts</span>
            </div>
            <p className="text-gray-600 text-xs">{outputData.passedBatches} batch{outputData.passedBatches !== 1 ? 'es' : ''}</p>
          </div>

          <div className="mb-5">
            <p className="text-gray-400 text-sm">Accepted</p>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-green-400 font-bold text-4xl">{outputData.acceptedTotal.toLocaleString()}</span>
              <span className="text-gray-500 text-sm">parts</span>
            </div>
            <p className="text-gray-600 text-xs">{outputData.acceptedBatches} batch{outputData.acceptedBatches !== 1 ? 'es' : ''} · compliance approved</p>
          </div>

          <div className="border-t border-gray-800 pt-4">
            <p className="text-gray-400 text-xs uppercase tracking-wide mb-2">Parts Accepted</p>
            {outputData.partsAccepted.length === 0 ? (
              <p className="text-gray-600 text-sm italic">None yet today</p>
            ) : (
              <div className="space-y-1.5">
                {outputData.partsAccepted.map(p => (
                  <div key={p.part_number} className="flex items-center justify-between">
                    <span className="text-skynet-accent font-mono text-sm">{p.part_number}</span>
                    <span className="text-white text-sm">{p.qty.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Today's Production */}
        <div className="col-span-6 bg-gray-900 rounded-xl border border-gray-800 p-5">
          <h2 className="text-xl font-bold text-skynet-accent mb-5">Today's Production</h2>

          {/* ===== Active Jobs ===== */}
          <div className="bg-gray-950 border border-gray-800 rounded-lg p-4 mb-4">
            <p className="text-gray-400 text-xs uppercase tracking-wide mb-3">
              Active Jobs · {activeJobs.length} running
            </p>
            {activeJobs.length === 0 ? (
              <p className="text-gray-600 text-sm italic">No active jobs — all machines idle</p>
            ) : (
              <div className="space-y-2">
                {activeJobs.map(j => (
                  <ActiveJobRow key={j.id} job={j} />
                ))}
              </div>
            )}
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

          {downMachineETAs.length > 0 && (
            <div className="bg-gray-950 border border-red-900/40 rounded-lg p-4 mt-4">
              <p className="text-red-400 text-xs uppercase tracking-wide mb-3">
                Down Machine ETA · {downMachineETAs.length}
              </p>
              <div className="space-y-2">
                {downMachineETAs.map(d => (
                  <div key={d.machine_code} className="bg-gray-900/60 border border-gray-800 rounded px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="flex items-baseline gap-2 min-w-0">
                        <span className="text-white font-mono text-sm font-semibold">{d.machine_code}</span>
                        {d.dtu_number && (
                          <span className="text-blue-400 font-mono text-[10px]">{d.dtu_number}</span>
                        )}
                        {d.maintenance_type === 'unplanned' && (
                          <span className="bg-purple-900/40 text-purple-300 font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded">
                            Unplanned
                          </span>
                        )}
                      </div>
                      <span className="text-red-400/80 font-mono text-[10px] uppercase tracking-wider shrink-0">
                        {d.estimated_return
                          ? new Date(d.estimated_return).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                          : 'TBD'}
                      </span>
                    </div>
                    <div className="text-gray-400 text-xs mt-1 truncate">
                      {d.description || '—'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

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
      {machines.length === 0 ? (
        <div className="text-gray-600 font-mono text-sm italic min-h-[2rem]">—</div>
      ) : (
        <div className="grid grid-cols-3 gap-x-2 gap-y-1 text-gray-200 font-mono text-sm min-h-[2rem]">
          {machines.map(m => (
            <span key={m.id} className="truncate">{m.code}</span>
          ))}
        </div>
      )}
    </div>
  )
}

function ActiveJobRow({ job }) {
  // Row-level highlight states (replaces the old colored left-border traffic light).
  // Behind wins over this-week for background/border when both apply — it's more
  // urgent. UP NEXT cell still gets its own amber treatment internally either way.
  const isBehind = job.trafficLight === 'red'
  const isThisWeek = job.next_up?.is_this_week === true

  const containerClasses = isBehind
    ? 'border-2 border-red-500/60 bg-red-950/30'
    : isThisWeek
      ? 'border-2 border-amber-500/50 bg-amber-950/20'
      : 'border border-gray-800 bg-gray-900/60'

  const statusLabel = job.status === 'in_setup' ? 'SETUP' : 'RUNNING'
  const statusColor = job.status === 'in_setup' ? 'text-amber-400' : 'text-green-400'

  const progressPct = job.targetQty > 0
    ? Math.min(100, (job.finished / job.targetQty) * 100)
    : 0

  const dueDate = job.scheduled_end
    ? new Date(job.scheduled_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '—'

  return (
    <div className={`flex items-center gap-3 ${containerClasses} px-3 py-2 rounded`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="text-white font-mono text-base font-semibold truncate">
            {job.component?.part_number || '—'}
          </span>
          <span className="text-white font-mono text-base font-semibold">
            {job.machine?.code || '—'}
          </span>
          <span className="text-blue-400 font-mono text-xs">{job.job_number}</span>
        </div>
        {job.machine?.name && (
          <div className="text-gray-500 text-xs font-mono mt-0.5">
            {job.machine.name}
          </div>
        )}
      </div>
      <div className="text-right shrink-0 min-w-[120px]">
        <div className="flex items-center justify-end gap-2">
          <span className={`text-xs font-mono font-semibold ${statusColor}`}>{statusLabel}</span>
          {isBehind && (
            <span className="bg-red-900/60 text-red-300 font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded">
              Behind
            </span>
          )}
        </div>
        <div className="text-gray-300 text-sm font-mono mt-0.5">
          {(job.finished || 0).toLocaleString()} / {(job.targetQty || 0).toLocaleString()}
        </div>
        <div className="w-full bg-gray-800 rounded-full h-1 mt-1 overflow-hidden">
          <div className="h-full bg-blue-500" style={{ width: `${progressPct}%` }} />
        </div>
      </div>
      <div className="text-right shrink-0 min-w-[80px]">
        <div className="text-gray-500 text-[10px] font-mono uppercase tracking-wider">Elapsed</div>
        <div className="text-gray-300 text-sm font-mono">{formatElapsed(job.elapsedMs)}</div>
      </div>
      <div className="text-right shrink-0 min-w-[90px] border-l border-gray-800 pl-3">
        <div className="text-gray-500 text-[10px] font-mono uppercase tracking-wider">Due</div>
        <div className="text-white text-sm font-mono font-semibold">{dueDate}</div>
      </div>
      <div className="text-right shrink-0 min-w-[90px] border-l border-gray-800 pl-3">
        <div className={`text-[10px] font-mono uppercase tracking-wider ${
          job.next_up?.is_this_week ? 'text-amber-500' : 'text-gray-500'
        }`}>
          Up Next{job.next_up?.is_this_week ? ' · THIS WK' : ''}
        </div>
        {job.next_up ? (
          <>
            <div className={`text-sm font-mono ${
              job.next_up.is_this_week ? 'text-amber-300' : 'text-gray-300'
            }`}>
              {job.next_up.part_number}
            </div>
            <div className={`text-[10px] font-mono mt-0.5 ${
              job.next_up.is_this_week ? 'text-amber-500/80' : 'text-gray-500'
            }`}>
              {formatRelativeStart(job.next_up.scheduled_start)}
            </div>
          </>
        ) : (
          <div className="text-gray-600 text-sm font-mono">—</div>
        )}
      </div>
    </div>
  )
}

function formatElapsed(ms) {
  if (!ms || ms < 0) return '—'
  const totalMinutes = Math.floor(ms / 60000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const totalHours = Math.round(ms / 3600000)
  if (totalHours < 24) {
    const h = Math.floor(totalMinutes / 60)
    const m = totalMinutes % 60
    return `${h}h ${m}m`
  }
  const d = Math.floor(totalHours / 24)
  const h = totalHours % 24
  return h > 0 ? `${d}d ${h}h` : `${d}d`
}

function formatRelativeStart(scheduledStart) {
  if (!scheduledStart) return ''
  const ms = new Date(scheduledStart).getTime() - Date.now()
  if (ms <= 0) return 'overdue'
  const totalMinutes = Math.floor(ms / 60000)
  if (totalMinutes < 60) return `in ${totalMinutes}m`
  const totalHours = Math.round(ms / 3600000)
  if (totalHours < 24) return `in ${totalHours}h`
  const d = Math.floor(totalHours / 24)
  return `in ${d}d`
}
