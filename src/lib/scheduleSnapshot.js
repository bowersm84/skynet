// src/lib/scheduleSnapshot.js
// Assembles the advisor's input from state Schedule.jsx already holds, plus
// the stats/policy reads (part_machine_stats, family_machine_stats,
// scheduler_policies). Pure assembly: all queue math arrives via the values
// and functions passed in from Schedule.jsx / lib/scheduling.js — this file
// never reimplements the physics. Nothing is queried more than two levels
// deep (Supabase lesson); stats merge client-side.
import { supabase } from './supabase'
import { getMachineQueue } from './scheduling'

const SHIFT_ASSUMPTION =
  'Planning window 07:00-16:00 Mon-Fri America/New_York. Jobs with ' +
  'requires_attendance=false may run past the window (lights-out); attended ' +
  'jobs may not. Weekend/late work happens ad hoc and is not planned.'

export async function buildScheduleSnapshot({
  machines,
  scheduledJobs,          // pass allScheduledJobs when loaded (full board, not the visible week)
  unassignedJobs,
  ongoingDowntimes,
  getMachineOptionsForPart,
  getScaledDuration,
  projectedSpans,         // display-only projection map from Schedule.jsx (D-SCHED-04)
}) {
  const poolPartIds = [...new Set(
    (unassignedJobs || []).map(j => j.component_id).filter(Boolean)
  )]

  // The one added query: history for the pool's parts.
  let stats = []
  if (poolPartIds.length) {
    const { data, error } = await supabase
      .from('part_machine_stats')
      .select('*')
      .in('part_id', poolPartIds)
    if (error) throw new Error(`part_machine_stats: ${error.message}`)
    stats = data || []
  }

  // Family history — inert until parts.family_key is seeded (D-AISCHED-01).
  const familyByPart = {}
  let familyStats = []
  if (poolPartIds.length) {
    const { data: fams } = await supabase
      .from('parts')
      .select('id, family_key')
      .in('id', poolPartIds)
      .not('family_key', 'is', null)
    ;(fams || []).forEach(f => { familyByPart[f.id] = f.family_key })
    const keys = [...new Set(Object.values(familyByPart))]
    if (keys.length) {
      const { data: fs } = await supabase
        .from('family_machine_stats')
        .select('*')
        .in('family_key', keys)
      familyStats = fs || []
    }
  }

  const { data: pols } = await supabase
    .from('scheduler_policies')
    .select('id, policy_text')
    .eq('is_active', true)
    .order('created_at', { ascending: true })

  const statFor = (partId, machineId) =>
    stats.find(s => s.part_id === partId && s.machine_id === machineId) || null
  const famFor = (partId, machineId) => {
    const key = familyByPart[partId]
    if (!key) return null
    return familyStats.find(s => s.family_key === key && s.machine_id === machineId) || null
  }

  const machineBlocks = (machines || []).map(m => {
    const queue = getMachineQueue(scheduledJobs, m.id).map(j => ({
      job_id: j.id,
      job_number: j.job_number,
      part_number: j.component?.part_number || null,
      qty: j.quantity,
      status: j.status,
      scheduled_start: j.scheduled_start,
      scheduled_end: j.scheduled_end,
      estimated_minutes: j.estimated_minutes,
      requires_attendance: j.requires_attendance === true,
      projected_end: projectedSpans?.[j.id]?.end
        ? new Date(projectedSpans[j.id].end).toISOString()
        : null,
    }))
    const lastEnd = queue.reduce((acc, q) => {
      const e = q.projected_end || q.scheduled_end
      return e && (!acc || e > acc) ? e : acc
    }, null)
    const down = (ongoingDowntimes || []).find(d => d.machine_id === m.id)
    return {
      machine_id: m.id,
      code: m.code,
      name: m.name,
      status: m.status,
      down_note: down?.reason || m.status_reason || null,
      queue,
      projected_free_at: lastEnd || new Date().toISOString(),
    }
  })

  const unassigned = (unassignedJobs || []).map(j => ({
    job_id: j.id,
    job_number: j.job_number,
    wo_number: j.work_order?.wo_number || null,
    customer: j.work_order?.customer || null,
    priority: j.work_order?.priority || j.priority || 'normal',
    due_date: j.work_order?.due_date || null,
    status: j.status,
    part_id: j.component_id,
    part_number: j.component?.part_number || null,
    qty: j.quantity,
    estimated_minutes: j.estimated_minutes || null,
    requires_attendance: j.requires_attendance === true,
    flags: {
      pending_compliance: j.status === 'pending_compliance',
      has_open_shortfall: j.work_order?.has_open_shortfall === true,
    },
    // D-AISCHED-09: capability = union(history, master data). History is a
    // first-class capability source — a part that has completed runs on a
    // machine is proven capable there, durations row or not. Standing rules
    // are the third source, resolved by the model and verified server-side
    // (they are free text; the builder does not parse them). History-first
    // ordering so the strongest evidence leads.
    capable_machines: (() => {
      const durRows = getMachineOptionsForPart(j.component_id)
      const histIds = stats
        .filter(s => s.part_id === j.component_id)
        .map(s => s.machine_id)
      const ids = [...new Set([...histIds, ...durRows.map(d => d.machine_id)])]
      return ids.map(mid => {
        const d = durRows.find(x => x.machine_id === mid) || null
        const h = statFor(j.component_id, mid)
        const f = famFor(j.component_id, mid)
        const pph = h && Number(h.actual_pcs_per_hour) > 0
          ? Number(h.actual_pcs_per_hour) : null
        return {
          machine_id: mid,
          sources: [h ? 'history' : null, d ? 'master_data' : null].filter(Boolean),
          preferred: d ? d.is_preferred === true : false,
          est_minutes_scaled: d ? getScaledDuration(d, j.quantity) : null,
          est_minutes_from_history: pph && j.quantity > 0
            ? Math.max(15, Math.round((j.quantity / pph) * 60)) : null,
          history: h ? {
            runs: Number(h.completed_runs),
            actual_pcs_per_hour: h.actual_pcs_per_hour == null ? null : Number(h.actual_pcs_per_hour),
            avg_setup_minutes: h.avg_setup_minutes == null ? null : Number(h.avg_setup_minutes),
            est_vs_actual_drift: h.est_vs_actual_drift == null ? null : Number(h.est_vs_actual_drift),
            last_run_at: h.last_run_at,
          } : null,
          family_history: f ? {
            family_key: f.family_key,
            parts_in_family: Number(f.parts_in_family),
            runs: Number(f.completed_runs),
            actual_pcs_per_hour: f.actual_pcs_per_hour == null ? null : Number(f.actual_pcs_per_hour),
            last_run_at: f.last_run_at,
          } : null,
        }
      }).sort((a, b) => {
        const ah = a.history ? 1 : 0, bh = b.history ? 1 : 0
        if (ah !== bh) return bh - ah
        const ar = a.history?.runs || 0, br = b.history?.runs || 0
        if (ar !== br) return br - ar
        if (a.preferred !== b.preferred) return a.preferred ? -1 : 1
        return 0
      })
    })(),
  }))

  return {
    as_of: new Date().toISOString(),
    assumptions: {
      shift: SHIFT_ASSUMPTION,
      material: 'assumed available unless flags.has_open_shortfall',
    },
    machines: machineBlocks,
    unassigned,
    policies: (pols || []).map(p => p.policy_text),
  }
}
