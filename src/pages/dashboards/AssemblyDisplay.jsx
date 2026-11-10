import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../../lib/supabase'
import { FEATURES } from '../../config'
import { Avatar } from '../../components/AvatarPicker'
import { formatMinutes, waveLabel, tvColumns } from '../../lib/assemblyKioskMath'
import { Droplets, Flame, Wind, AlertTriangle, Clock, Package, Play, CheckCircle } from 'lucide-react'

const STAGE_CONFIG = {
  wash: { label: 'Wash', icon: Droplets, color: 'bg-blue-600 text-blue-100' },
  treatment: { label: 'Treatment', icon: Flame, color: 'bg-orange-600 text-orange-100' },
  dry: { label: 'Dry', icon: Wind, color: 'bg-yellow-600 text-yellow-100' }
}

// Today's board (finishing batches and jobs ready for assembly) — what PROD shows until the assembly cutover.
function FinishingFeedDisplay() {
  const [finishingData, setFinishingData] = useState([])
  const [assemblyData, setAssemblyData] = useState([])
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState(null)

  const finishingScrollRef = useRef(null)
  const assemblyScrollRef = useRef(null)

  // Auto-scroll effect for TV display panels
  useEffect(() => {
    const scrollers = [finishingScrollRef, assemblyScrollRef]
    const intervals = []
    const paused = [false, false]

    scrollers.forEach((ref, idx) => {
      const id = setInterval(() => {
        const el = ref.current
        if (!el || paused[idx]) return
        if (el.scrollHeight <= el.clientHeight) return

        if (el.scrollTop >= el.scrollHeight - el.clientHeight) {
          paused[idx] = true
          setTimeout(() => {
            if (el) el.scrollTop = 0
            paused[idx] = false
          }, 3000)
        } else {
          el.scrollTop += 1
        }
      }, 30)
      intervals.push(id)
    })

    return () => intervals.forEach(clearInterval)
  }, [finishingData, assemblyData])

  const loadFinishingData = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('finishing_sends')
        .select(`
          id,
          finishing_stage,
          incoming_count,
          job:jobs (
            id,
            job_number,
            quantity,
            work_order_id,
            component:parts!component_id (
              part_number,
              description
            ),
            work_order:work_orders (
              id,
              wo_number,
              customer
            )
          )
        `)
        .eq('status', 'in_finishing')
        .eq('is_standalone', false) // SKY51 — exclude standalone J-FIN finishing batches

      if (error) throw error

      // Group by work order
      const woMap = {}
      for (const send of (data || [])) {
        if (!send.job?.work_order) continue
        const woId = send.job.work_order.id
        if (!woMap[woId]) {
          woMap[woId] = {
            wo_number: send.job.work_order.wo_number,
            customer: send.job.work_order.customer,
            batches: []
          }
        }
        woMap[woId].batches.push({
          id: send.id,
          part_number: send.job.component?.part_number,
          description: send.job.component?.description,
          job_number: send.job.job_number,
          quantity: send.incoming_count || send.job.quantity,
          stage: send.finishing_stage
        })
      }

      setFinishingData(Object.values(woMap))
    } catch (err) {
      console.error('Error loading finishing data:', err)
    }
  }, [])

  const loadAssemblyData = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('jobs')
        .select(`
          id,
          job_number,
          quantity,
          component:parts!component_id (
            part_number,
            description
          ),
          work_order:work_orders (
            wo_number,
            customer,
            due_date
          )
        `)
        .eq('status', 'ready_for_assembly')
        .eq('is_standalone_finishing', false) // SKY51 — exclude standalone J-FIN jobs
        .order('created_at', { ascending: true })

      if (error) throw error

      // Sort by work order due date
      const sorted = (data || []).sort((a, b) => {
        const dateA = a.work_order?.due_date ? new Date(a.work_order.due_date) : new Date('2099-12-31')
        const dateB = b.work_order?.due_date ? new Date(b.work_order.due_date) : new Date('2099-12-31')
        return dateA - dateB
      })

      setAssemblyData(sorted)
    } catch (err) {
      console.error('Error loading assembly data:', err)
    }
  }, [])

  const loadAll = useCallback(async () => {
    await Promise.all([loadFinishingData(), loadAssemblyData()])
    setLastUpdated(new Date())
    setLoading(false)
  }, [loadFinishingData, loadAssemblyData])

  useEffect(() => {
    loadAll()

    const subscription = supabase
      .channel('assembly-display')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'finishing_sends' }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, loadAll)
      .subscribe()

    // Fallback polling every 30 seconds
    const interval = setInterval(loadAll, 30000)

    return () => {
      supabase.removeChannel(subscription)
      clearInterval(interval)
    }
  }, [loadAll])

  const getDueUrgency = (dueDateStr) => {
    if (!dueDateStr) return 'normal'
    const now = new Date()
    now.setHours(0, 0, 0, 0)
    const due = new Date(dueDateStr)
    due.setHours(0, 0, 0, 0)
    const diffDays = (due - now) / (1000 * 60 * 60 * 24)
    if (diffDays < 0) return 'overdue'
    if (diffDays <= 3) return 'soon'
    return 'normal'
  }

  const formatDate = (dateStr) => {
    if (!dateStr) return ''
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-3 border-skynet-accent border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-500 font-mono text-lg">Loading Assembly Display...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-950 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <img src="/skybolt-logo-white.png" alt="Skybolt" className="h-8 w-auto opacity-80" />
          <div>
            <h1 className="text-3xl font-bold text-white">Assembly Pipeline</h1>
            <p className="text-gray-500 text-sm font-mono">
              SkyNet — Live Display
            </p>
          </div>
        </div>
        <div className="text-right">
          <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse inline-block mr-2"></div>
          <span className="text-green-400 font-mono text-sm">Live</span>
          {lastUpdated && (
            <p className="text-gray-600 text-xs font-mono mt-1">
              {lastUpdated.toLocaleTimeString()}
            </p>
          )}
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-[calc(100vh-140px)]">
        {/* Panel 1: In Finishing */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden flex flex-col">
          <div className="px-6 py-4 border-b border-gray-800 bg-gray-900/80">
            <h2 className="text-2xl font-bold text-blue-400 flex items-center gap-3">
              <Droplets size={28} />
              In Finishing
              {finishingData.reduce((sum, wo) => sum + wo.batches.length, 0) > 0 && (
                <span className="text-lg bg-blue-900/50 text-blue-300 px-3 py-0.5 rounded-full">
                  {finishingData.reduce((sum, wo) => sum + wo.batches.length, 0)}
                </span>
              )}
            </h2>
          </div>

          <div ref={finishingScrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
            {finishingData.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-gray-600 text-xl">No batches currently in finishing</p>
              </div>
            ) : (
              finishingData.map((wo, woIdx) => (
                <div key={woIdx} className="space-y-2">
                  {/* WO Section Header */}
                  <div className="flex items-center gap-2 px-2">
                    <span className="text-white font-mono font-bold text-lg">{wo.wo_number}</span>
                    {wo.customer && (
                      <>
                        <span className="text-gray-600">—</span>
                        <span className="text-gray-300 text-lg">{wo.customer}</span>
                      </>
                    )}
                  </div>

                  {/* Batch rows */}
                  {wo.batches.map(batch => {
                    const stageConf = STAGE_CONFIG[batch.stage] || STAGE_CONFIG.wash
                    const StageIcon = stageConf.icon
                    return (
                      <div
                        key={batch.id}
                        className="bg-gray-800 rounded-lg px-5 py-3 flex items-center justify-between"
                      >
                        <div className="flex items-center gap-4">
                          <div>
                            <span className="text-skynet-accent font-mono text-lg font-medium">
                              {batch.part_number}
                            </span>
                            <p className="text-gray-500 text-sm">{batch.description}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-5">
                          <span className="text-gray-400 font-mono text-sm">{batch.job_number}</span>
                          <span className="text-white font-mono text-lg font-bold">{batch.quantity}</span>
                          <span className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium ${stageConf.color}`}>
                            <StageIcon size={16} />
                            {stageConf.label}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Panel 2: Ready for Assembly */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden flex flex-col">
          <div className="px-6 py-4 border-b border-gray-800 bg-gray-900/80">
            <h2 className="text-2xl font-bold text-green-400 flex items-center gap-3">
              <Package size={28} />
              Ready for Assembly
              {assemblyData.length > 0 && (
                <span className="text-lg bg-green-900/50 text-green-300 px-3 py-0.5 rounded-full">
                  {assemblyData.length}
                </span>
              )}
            </h2>
          </div>

          <div ref={assemblyScrollRef} className="flex-1 overflow-y-auto p-4 space-y-2">
            {assemblyData.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-gray-600 text-xl">No parts ready for assembly</p>
              </div>
            ) : (
              assemblyData.map(job => {
                const urgency = getDueUrgency(job.work_order?.due_date)
                return (
                  <div
                    key={job.id}
                    className={`bg-gray-800 rounded-lg px-5 py-3 flex items-center justify-between border-l-4 ${
                      urgency === 'overdue' ? 'border-l-red-500' :
                      urgency === 'soon' ? 'border-l-amber-500' :
                      'border-l-gray-700'
                    }`}
                  >
                    <div className="flex items-center gap-4">
                      <div>
                        <span className="text-skynet-accent font-mono text-lg font-medium">
                          {job.component?.part_number}
                        </span>
                        <p className="text-gray-500 text-sm">{job.component?.description}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-5">
                      <span className="text-gray-400 font-mono text-sm">{job.job_number}</span>
                      <span className="text-white font-mono text-lg font-bold">{job.quantity}</span>
                      <div className="text-right min-w-[100px]">
                        <span className="text-gray-300 font-mono text-sm block">
                          {job.work_order?.wo_number}
                        </span>
                        {job.work_order?.customer && (
                          <span className="text-gray-300 text-sm">{job.work_order.customer}</span>
                        )}
                      </div>
                      {job.work_order?.due_date && (
                        <div className={`flex items-center gap-1 text-sm font-medium min-w-[80px] ${
                          urgency === 'overdue' ? 'text-red-400' :
                          urgency === 'soon' ? 'text-amber-400' :
                          'text-gray-400'
                        }`}>
                          {urgency === 'overdue' && <AlertTriangle size={14} />}
                          {urgency === 'soon' && <Clock size={14} />}
                          {formatDate(job.work_order.due_date)}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Build TV (S17 Batch C, D-ASM-40) ────────────────────────────────────────
// Fed by v_assembly_tv (open builds, plus complete and released in the last 24 hours); running minutes come
// from v_assembly_kiosk_builds. Four columns: Running (avatar and minutes), Late, Waiting (oldest due first),
// Done today. Large type, refreshed every 30 s, no interaction. It runs signed in, like the other TVs.
const TV_REFRESH_MS = 30000
const PRIORITY_BAR = { critical: 'bg-red-500', high: 'bg-amber-400', normal: 'bg-gray-600', low: 'bg-gray-700' }

function tvDate(value) {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value))
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function TvCard({ row, minutes, lotPrefix, show }) {
  const wave = waveLabel(row)
  return (
    <div className="relative rounded-xl bg-gray-900 border border-gray-800 pl-5 pr-4 py-3 overflow-hidden">
      <span className={`absolute left-0 top-0 bottom-0 w-2 ${PRIORITY_BAR[row.priority] || PRIORITY_BAR.normal}`} />
      <div className="flex items-center justify-between gap-3">
        <span className="text-3xl font-bold text-white truncate">{row.part_number}</span>
        <span className="text-2xl text-gray-300 font-mono shrink-0">{Number(row.quantity).toLocaleString()}</span>
      </div>
      <div className="flex items-center gap-3 mt-1 text-xl text-gray-400">
        <span className="font-mono">{row.build_number}</span>
        {wave && <span className="text-indigo-300">{wave}</span>}
        {row.late && show !== 'late' && <span className="text-red-400 font-semibold">LATE</span>}
      </div>
      <div className="flex items-center gap-3 mt-2 text-xl">
        {row.assigned_name
          ? <><Avatar icon={row.avatar_icon} color={row.avatar_color} name={row.assigned_name} size={36} /><span className="text-gray-200 truncate">{row.assigned_name}</span></>
          : <span className="text-gray-500">Unassigned</span>}
        {show === 'running' && minutes != null && <span className="ml-auto text-green-300 font-mono">{formatMinutes(minutes)}</span>}
        {(show === 'late' || show === 'waiting') && tvDate(row.earliest_due) && (
          <span className={`ml-auto ${show === 'late' ? 'text-red-300' : 'text-gray-300'}`}>Due {tvDate(row.earliest_due)}</span>
        )}
        {show === 'done' && row.assembly_lot_number && <span className="ml-auto text-green-300 font-mono">{lotPrefix}{row.assembly_lot_number}</span>}
      </div>
    </div>
  )
}

function TvColumn({ title, icon, tone, rows, render }) {
  const Icon = icon
  return (
    <section className="flex flex-col min-h-0 bg-gray-950/60 rounded-2xl border border-gray-800">
      <h2 className={`flex items-center gap-3 px-5 py-4 text-3xl font-bold ${tone}`}>
        <Icon size={32} /> {title} <span className="ml-auto text-gray-400 font-mono">{rows.length}</span>
      </h2>
      <div className="flex-1 min-h-0 overflow-hidden px-4 pb-4 space-y-3">
        {rows.length === 0 ? <p className="text-gray-600 text-2xl px-1">—</p> : rows.map(render)}
      </div>
    </section>
  )
}

function AssemblyBuildsTV() {
  const [rows, setRows] = useState([])
  const [minutesById, setMinutesById] = useState({})
  const [lotPrefix, setLotPrefix] = useState('')
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)

  const load = useCallback(async () => {
    try {
      const [tv, open, prefix] = await Promise.all([
        supabase.from('v_assembly_tv').select('*'),
        supabase.from('v_assembly_kiosk_builds').select('id, minutes_total'),
        supabase.from('app_settings').select('value').eq('key', 'assembly_lot_prefix_display').maybeSingle(),
      ])
      if (tv.error) throw tv.error
      setRows(tv.data || [])
      setMinutesById(Object.fromEntries((open.data || []).map((r) => [r.id, Number(r.minutes_total)])))
      setLotPrefix(typeof prefix.data?.value === 'string' ? prefix.data.value : '')
      setError(null)
      setLastUpdated(new Date())
    } catch (err) {
      setError(err?.message || String(err))
    }
  }, [])

  useEffect(() => {
    document.title = 'Assembly Display'
    load()
    const t = setInterval(load, TV_REFRESH_MS)
    return () => { clearInterval(t); document.title = 'SkyNet MES' }
  }, [load])

  const { running, late, waiting, doneToday } = tvColumns(rows)
  return (
    <div className="h-screen bg-skynet-dark text-white flex flex-col p-6 gap-5 overflow-hidden">
      <header className="flex items-center justify-between">
        <h1 className="text-5xl font-bold">Assembly</h1>
        <div className="text-right text-gray-400 text-2xl">
          {error ? <span className="text-red-400">{error}</span> : lastUpdated && <>Updated {lastUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</>}
        </div>
      </header>
      <div className="flex-1 min-h-0 grid grid-cols-4 gap-5">
        <TvColumn title="Running" icon={Play} tone="text-green-400" rows={running}
          render={(r) => <TvCard key={r.id} row={r} minutes={minutesById[r.id]} show="running" />} />
        <TvColumn title="Late" icon={AlertTriangle} tone="text-red-400" rows={late}
          render={(r) => <TvCard key={r.id} row={r} show="late" />} />
        <TvColumn title="Waiting" icon={Clock} tone="text-amber-300" rows={waiting}
          render={(r) => <TvCard key={r.id} row={r} show="waiting" />} />
        <TvColumn title="Done today" icon={CheckCircle} tone="text-sky-300" rows={doneToday}
          render={(r) => <TvCard key={r.id} row={r} lotPrefix={lotPrefix} show="done" />} />
      </div>
    </div>
  )
}

// With FEATURES.ASSEMBLY_KIOSK (TEST) the TV shows builds; without it (PROD), today's board, unchanged.
export default function AssemblyDisplay() {
  return FEATURES.ASSEMBLY_KIOSK ? <AssemblyBuildsTV /> : <FinishingFeedDisplay />
}
