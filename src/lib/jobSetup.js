// src/lib/jobSetup.js — putting a production job into setup (S14, D-TKIOSK-08).
//
// One definition of what "setup started" writes, shared by the machine kiosk
// (Kiosk.jsx) and the Traveler Kiosk, so the two can never drift apart. Lifted
// from Kiosk.jsx handleStartSetup: the normal production branch's fields and the
// idle-time log that follows every start. Kiosk.jsx keeps its finishing and
// maintenance branches as they were.

// The fields a normal production job gets when setup starts.
export function setupUpdateData(operatorId, now = new Date().toISOString()) {
  return {
    status: 'in_setup',
    setup_start: now,
    assigned_user_id: operatorId,
    updated_at: now,
  }
}

// B3 idle tracking: minutes between the machine's last finished job and this
// start. Fire-and-forget — failures are logged, never thrown.
export async function logMachineIdle(supabase, { machineId, jobId }) {
  try {
    const { data: prevJob } = await supabase
      .from('jobs')
      .select('id, actual_end')
      .eq('assigned_machine_id', machineId)
      .not('actual_end', 'is', null)
      .neq('id', jobId)
      .order('actual_end', { ascending: false })
      .limit(1)
      .single()

    if (prevJob?.actual_end) {
      const idleStart = new Date(prevJob.actual_end)
      const idleEnd = new Date()
      const idleMinutes = Math.round((idleEnd - idleStart) / 60000)
      if (idleMinutes > 0) {
        await supabase.from('machine_idle_logs').insert({
          machine_id: machineId,
          previous_job_id: prevJob.id,
          next_job_id: jobId,
          idle_start: idleStart.toISOString(),
          idle_end: idleEnd.toISOString(),
          idle_minutes: idleMinutes,
        })
      }
    }
  } catch (idleErr) {
    console.error('Idle time logging failed (non-blocking):', idleErr)
  }
}

// The machine's job in setup or running, if any (maintenance included).
export async function fetchActiveJobOnMachine(supabase, machineId) {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, job_number, status')
    .eq('assigned_machine_id', machineId)
    .in('status', ['in_setup', 'in_progress'])
    .limit(1)
  if (error) throw error
  return data?.[0] || null
}

// Traveler Kiosk start (D-TKIOSK-08): the same write as the machine kiosk, plus
// two guards a shared PC needs — never while the machine has another job in
// setup or running, and only from 'assigned', so a job already started at the
// machine is never re-stamped. Returns { ok: true, setupStart } or
// { ok: false, reason } with a sentence a machinist can act on.
export async function startJobSetup(supabase, { job, machine, operator }) {
  const active = await fetchActiveJobOnMachine(supabase, machine.id)
  if (active && active.id !== job.id) {
    return { ok: false, reason: `${machine.code} is still running ${active.job_number} — finish it at the machine first.` }
  }
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('jobs')
    .update(setupUpdateData(operator.id, now))
    .eq('id', job.id)
    .eq('status', 'assigned')
    .select('id')
  if (error) return { ok: false, reason: `Could not start setup: ${error.message}` }
  if (!data || data.length === 0) {
    return { ok: false, reason: `${job.job_number} was already started at the machine.` }
  }

  await logMachineIdle(supabase, { machineId: machine.id, jobId: job.id })

  const { error: auditErr } = await supabase.from('audit_logs').insert({
    event_type: 'job_setup_started',
    job_id: job.id,
    machine_id: machine.id,
    operator_id: operator.id,
    details: {
      job_number: job.job_number,
      machine_code: machine.code,
      source: 'traveler_kiosk',
      setup_start: now,
    },
  })
  if (auditErr) console.error('job_setup_started audit failed (non-blocking):', auditErr)
  return { ok: true, setupStart: now }
}
