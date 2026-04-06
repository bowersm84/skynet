import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../../lib/supabase'
import { Droplets, Flame, Wind, AlertTriangle, Clock, Package } from 'lucide-react'

const STAGE_CONFIG = {
  wash: { label: 'Wash', icon: Droplets, color: 'bg-blue-600 text-blue-100' },
  treatment: { label: 'Treatment', icon: Flame, color: 'bg-orange-600 text-orange-100' },
  dry: { label: 'Dry', icon: Wind, color: 'bg-yellow-600 text-yellow-100' }
}

export default function AssemblyDisplay() {
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
