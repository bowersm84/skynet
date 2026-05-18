// Shared derived machine-status taxonomy.
// Returns one of: 'down' | 'setup' | 'running' | 'ready' | 'staged' | 'idle'
//
// Inputs:
//   machine        — row from public.machines (must include status, kiosk_enabled)
//   jobsOnMachine  — array of jobs assigned to this machine. Helper looks at
//                    'in_setup' and 'in_progress' for active states; ANY other
//                    status in the array counts as "queued" (Ready/Staged
//                    branch). Callers should pre-filter to jobs in the active
//                    + queued window they care about (e.g. exclude 'complete',
//                    'cancelled', 'incomplete').
//   downtimeSignal — optional boolean; if true, force 'down' (lets callers feed
//                    in machine_downtime_logs / maintenance state if they have
//                    it). Defaults to false — callers that don't fetch downtime
//                    signals fall back to machine.status === 'down' only.
//
// Priority order (top-down, first match wins):
//   1. Down     — machine.status='down' OR downtimeSignal=true
//   2. Setup    — any job in 'in_setup'
//   3. Running  — any job in 'in_progress'
//   4. Ready    — kiosk_enabled AND has any other queued job
//   5. Staged   — NOT kiosk_enabled AND has any other queued job
//   6. Idle     — fallthrough
//
// Divergence note (2026-05-18): the original prompt drafted the queued check
// as `status IN ('ready', 'assigned')`, but MachineCard's truth (which this
// helper is extracted from) treats any non-active job in its input array as
// queued — including 'pending_compliance'. Mainframe passes
// ['pending_compliance', 'assigned', 'in_setup', 'in_progress'] jobs to
// MachineCard, so a pending_compliance job on a kiosk-enabled machine
// correctly surfaces as Ready. The helper preserves that behavior; callers
// control breadth via what they put in jobsOnMachine.

export function deriveMachineStatus(machine, jobsOnMachine = [], downtimeSignal = false) {
  if (downtimeSignal || machine?.status === 'down') return 'down'

  const hasSetup = jobsOnMachine.some(j => j.status === 'in_setup')
  if (hasSetup) return 'setup'

  const hasRunning = jobsOnMachine.some(j => j.status === 'in_progress')
  if (hasRunning) return 'running'

  const hasQueued = jobsOnMachine.some(j => j.status !== 'in_setup' && j.status !== 'in_progress')
  if (hasQueued) {
    return machine?.kiosk_enabled ? 'ready' : 'staged'
  }

  return 'idle'
}
