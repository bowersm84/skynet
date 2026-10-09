// src/pages/TravelerKiosk.jsx — Traveler Kiosk (S14, D-TKIOSK-01 … 07, 09, 12, 13; 04a, 06a, 13a; 06b, 13b).
//
// A dedicated PC near the machinists' office. PIN → tap your machine → the
// lineup → Print Travel Pack (or Print Production Card) → done. Printing moves
// from Roger's desk at compliance accept to the machinist at the last moment, so
// the paper that reaches the machine is the current truth.
//
// Shell mirrors MaterialKiosk.jsx (shared PinPad, kiosk-authenticate anchored on
// any commissioned machine, no kiosk_sessions row so a PIN here never displaces a
// tablet session, inactivity sign-out). Lineup mirrors Kiosk.jsx loadJobs.
// Batch B adds the setup prompt after the print (D-TKIOSK-08).
import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { FEATURES } from '../config'
import PinPad from '../components/PinPad'
import { getRunTarget, isPaperworkStale } from '../lib/jobMerge'
import {
  fetchDocumentsForJobs, findProductionCard, isPrintableDoc,
  buildTravelPack, buildProductionCard, printHtmlJob,
  recordTravelPackPrint, recordProductionCardPrint, recordPrintFailed,
} from '../lib/travelPack'
import {
  Printer, LogOut, ArrowLeft, Loader2, CheckCircle, AlertTriangle,
  FileText, RefreshCw, ClipboardList, X,
} from 'lucide-react'

const KIOSK_DEVICE_ID_KEY = 'skynet.kiosk.device_id'

function getKioskDeviceId() {
  try {
    let id = localStorage.getItem(KIOSK_DEVICE_ID_KEY)
    if (!id) {
      id = (crypto?.randomUUID?.() || `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      localStorage.setItem(KIOSK_DEVICE_ID_KEY, id)
    }
    return id
  } catch {
    return `ephemeral-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

// Same statuses the machine kiosk shows for a production machine (D-TKIOSK-02).
const LINEUP_STATUSES = ['pending_compliance', 'assigned', 'in_setup', 'in_progress']
const STATUS_RANK = { in_progress: 0, in_setup: 1, assigned: 2, pending_compliance: 3 }
const INACTIVITY_TIMEOUT = 2 * 60 * 1000 // D-TKIOSK-09: 2 minutes

const isMaintenance = (job) => job?.is_maintenance || job?.work_order?.order_type === 'maintenance' || !!job?.work_order?.maintenance_type

// Date-only values (YYYY-MM-DD) are built as local dates so a due date never
// shows the day before in Florida.
function formatDate(value) {
  if (!value) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value))
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatDateTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function StatusChip({ status }) {
  switch (status) {
    case 'in_progress': return <span className="px-2 py-0.5 text-xs font-medium rounded bg-green-500/20 text-green-400">Running</span>
    case 'in_setup': return <span className="px-2 py-0.5 text-xs font-medium rounded bg-yellow-500/20 text-yellow-400">In setup</span>
    case 'assigned': return <span className="px-2 py-0.5 text-xs font-medium rounded bg-blue-500/20 text-blue-400">Queued</span>
    case 'pending_compliance': return <span className="px-2 py-0.5 text-xs font-medium rounded bg-gray-600/40 text-gray-400">Waiting on compliance</span>
    default: return <span className="px-2 py-0.5 text-xs font-medium rounded bg-gray-600/40 text-gray-400">{status}</span>
  }
}

function Toast({ toast }) {
  return (
    <div className={`fixed bottom-5 left-1/2 -translate-x-1/2 px-4 py-3 rounded-lg shadow-lg text-sm z-40 ${toast.kind === 'error' ? 'bg-red-900 text-red-100' : 'bg-green-900 text-green-100'}`}>
      {toast.msg}
    </div>
  )
}

export default function TravelerKiosk() {
  const deviceIdRef = useRef(getKioskDeviceId())

  // --- Auth ---
  const [pin, setPin] = useState('')
  const [operator, setOperator] = useState(null)
  const [authError, setAuthError] = useState(null)
  const [authenticating, setAuthenticating] = useState(false)
  const [lastActivity, setLastActivity] = useState(Date.now())

  // --- Machines ---
  const [machines, setMachines] = useState([])
  const [machinesLoading, setMachinesLoading] = useState(false)
  const [selectedMachine, setSelectedMachine] = useState(null)

  // --- Lineup ---
  const [jobs, setJobs] = useState([])
  const [jobsLoading, setJobsLoading] = useState(false)
  const [docsByJob, setDocsByJob] = useState({})
  const [allocsByJob, setAllocsByJob] = useState({})
  const [namesById, setNamesById] = useState({})

  // --- Printing ---
  const [busy, setBusy] = useState(null)        // { job, kind: 'pack' | 'card', progress }
  const [result, setResult] = useState(null)    // { job, kind, printed, skipped, pageCount, how, errors }
  const [toast, setToast] = useState(null)

  const showToast = (msg, kind = 'ok') => {
    setToast({ msg, kind })
    setTimeout(() => setToast(null), 4000)
  }

  useEffect(() => {
    document.title = 'Traveler Kiosk'
    return () => { document.title = 'SkyNet MES' }
  }, [])

  // ---------- PIN entry ----------
  const handlePinInput = (digit) => { if (pin.length < 4) setPin(pin + digit) }
  const handlePinBackspace = () => setPin(pin.slice(0, -1))
  const handlePinClear = () => setPin('')

  const handlePinSubmit = async () => {
    if (pin.length < 4) { setAuthError('PIN must be at least 4 digits'); return }
    setAuthenticating(true)
    setAuthError(null)
    try {
      // kiosk-authenticate needs an active, commissioned machine to mint the JWT
      // but binds nothing to it; any one works as an anchor (D-KSTC-09). The
      // machine the operator picks next is a display choice, not a session.
      const { data: anchor } = await supabase
        .from('machines').select('id').eq('is_active', true).eq('is_commissioned', true)
        .order('display_order').limit(1)
      const anchorId = anchor?.[0]?.id
      if (!anchorId) { setAuthError('No active machine available'); setPin(''); return }

      const { data, error } = await supabase.functions.invoke('kiosk-authenticate', {
        body: { pin, machine_id: anchorId, device_id: deviceIdRef.current },
      })
      if (error || !data?.success) { setAuthError('Invalid PIN'); setPin(''); return }

      const { error: sessionErr } = await supabase.auth.setSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      })
      if (sessionErr) {
        console.error('setSession failed:', sessionErr)
        setAuthError('Authentication failed'); setPin(''); return
      }
      // Placeholder refresh token — re-PIN at expiry, never auto-refresh.
      supabase.auth.stopAutoRefresh()

      setOperator(data.operator)
      setLastActivity(Date.now())
      setPin('')
    } catch (err) {
      console.error('Auth error:', err)
      setAuthError('Authentication failed'); setPin('')
    } finally {
      setAuthenticating(false)
    }
  }

  useEffect(() => {
    if (operator) return
    const onKey = (e) => {
      if (e.key >= '0' && e.key <= '9') handlePinInput(e.key)
      else if (e.key === 'Backspace') handlePinBackspace()
      else if (e.key === 'Enter') { if (pin.length >= 4) handlePinSubmit() }
      else if (e.key === 'Escape') handlePinClear()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operator, pin])

  const handleLogout = async () => {
    await supabase.auth.signOut({ scope: 'local' })
    setOperator(null)
    setSelectedMachine(null)
    setJobs([])
    setResult(null)
    setBusy(null)
  }

  // Any interaction keeps an actively-used kiosk signed in mid-task.
  useEffect(() => {
    if (!operator) return
    const bump = () => setLastActivity(Date.now())
    const events = ['mousedown', 'keydown', 'touchstart', 'pointerdown']
    events.forEach(e => window.addEventListener(e, bump))
    return () => events.forEach(e => window.removeEventListener(e, bump))
  }, [operator])

  // Auto sign-out after INACTIVITY_TIMEOUT — never while a pack is printing.
  useEffect(() => {
    if (!operator) return
    const interval = setInterval(() => {
      if (!busy && Date.now() - lastActivity > INACTIVITY_TIMEOUT) handleLogout()
    }, 15000)
    return () => clearInterval(interval)
  }, [operator, lastActivity, busy])

  // ---------- Machines (D-TKIOSK-03) ----------
  const loadMachines = useCallback(async () => {
    setMachinesLoading(true)
    try {
      const { data, error } = await supabase
        .from('machines')
        .select('id, name, code, machine_type, kiosk_enabled, display_order, location_id, locations:location_id(name)')
        .eq('is_active', true).eq('is_commissioned', true)
        .neq('machine_type', 'finishing')
        .order('display_order')
      if (error) throw error
      setMachines(data || [])
    } catch (err) { console.error('Error loading machines:', err) }
    finally { setMachinesLoading(false) }
  }, [])

  useEffect(() => { if (operator) loadMachines() }, [operator, loadMachines])

  // ---------- Lineup (D-TKIOSK-02) ----------
  const loadJobs = useCallback(async (machine) => {
    if (!machine) return
    setJobsLoading(true)
    try {
      const { data, error } = await supabase
        .from('jobs')
        .select(`
          id, job_number, status, quantity, scheduled_start, scheduled_end, assigned_machine_id, component_id,
          traveler_printed_at, traveler_printed_by, paperwork_changed_at, paperwork_changed_reason, paperwork_ack_at,
          merged_into_job_id, documents_deferred, is_maintenance,
          work_order:work_orders(id, wo_number, customer, priority, due_date, order_type, maintenance_type),
          component:parts!component_id(id, part_number, description)
        `)
        .eq('assigned_machine_id', machine.id)
        .in('status', LINEUP_STATUSES)
        .order('scheduled_start', { ascending: true })
      if (error) throw error
      const list = (data || []).filter(j => !isMaintenance(j))
      list.sort((a, b) => {
        const r = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
        if (r !== 0) return r
        const as = a.scheduled_start ? new Date(a.scheduled_start).getTime() : Number.MAX_SAFE_INTEGER
        const bs = b.scheduled_start ? new Date(b.scheduled_start).getTime() : Number.MAX_SAFE_INTEGER
        return as - bs
      })
      setJobs(list)

      const ids = list.map(j => j.id)
      const [docs, allocs, names] = await Promise.all([
        fetchDocumentsForJobs(supabase, list).catch(err => { console.error('Error loading documents:', err); return {} }),
        (async () => {
          if (ids.length === 0) return {}
          const { data: rows, error: aErr } = await supabase
            .from('job_merge_allocations')
            .select('host_job_id, member_job_id, requested_qty')
            .in('host_job_id', ids)
            .eq('is_active', true)
          if (aErr) { console.error('Error loading merge allocations:', aErr); return {} }
          const m = {}
          for (const a of rows || []) { if (!m[a.host_job_id]) m[a.host_job_id] = []; m[a.host_job_id].push(a) }
          return m
        })(),
        (async () => {
          const pids = [...new Set(list.map(j => j.traveler_printed_by).filter(Boolean))]
          if (pids.length === 0) return {}
          const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', pids)
          const m = {}
          for (const p of profs || []) m[p.id] = p.full_name
          return m
        })(),
      ])
      setDocsByJob(docs)
      setAllocsByJob(allocs)
      setNamesById(names)
    } catch (err) {
      console.error('Error loading lineup:', err)
      showToast('Could not load the lineup: ' + (err.message || 'unknown error'), 'error')
    } finally { setJobsLoading(false) }
  }, [])

  useEffect(() => { if (operator && selectedMachine) loadJobs(selectedMachine) }, [operator, selectedMachine, loadJobs])

  // ---------- Print actions ----------
  const handlePrintPack = async (job) => {
    if (busy) return
    setBusy({ job, kind: 'pack', progress: 'Building the pack' })
    try {
      const pack = await buildTravelPack(supabase, job.id, {
        onProgress: (p) => setBusy(prev => prev ? { ...prev, progress: p } : prev),
      })
      // D-TKIOSK-06a: record once the pack is built, then print — nothing races print().
      setBusy(prev => prev ? { ...prev, progress: 'Sending to the printer' } : prev)
      const previous = { at: job.traveler_printed_at || null, by: job.traveler_printed_by || null }
      const rec = await recordTravelPackPrint(supabase, { job: pack.job, machine: selectedMachine, operator, pack })
      const printed = await printHtmlJob(pack.html)
      if (printed.how === 'error') {
        // D-TKIOSK-06b: no paper, so the stamp goes back to what it was.
        const failure = printed.error || new Error('print failed')
        await recordPrintFailed(supabase, { kind: 'pack', job: pack.job, machine: selectedMachine, operator, previous, stampedAt: rec.stampedAt, error: failure })
        await loadJobs(selectedMachine)
        throw failure
      }
      setResult({
        job: pack.job, kind: 'pack', how: printed.how,
        printed: pack.docs, skipped: pack.skipped, pageCount: pack.pageCount,
        errors: [
          rec.stampError && `print stamp (${rec.stampError.message || 'unknown error'})`,
          rec.auditError && `audit log (${rec.auditError.message || 'unknown error'})`,
        ].filter(Boolean),
      })
      await loadJobs(selectedMachine)
    } catch (err) {
      console.error('Travel pack failed:', err)
      showToast("Couldn't print the travel pack: " + (err.message || 'unknown error') + '. Ask Roger.', 'error')
    } finally {
      setBusy(null)
      setLastActivity(Date.now())
    }
  }

  const handlePrintCard = async (job) => {
    if (busy) return
    setBusy({ job, kind: 'card', progress: 'Preparing the production card' })
    try {
      const card = await buildProductionCard(supabase, job, {
        onProgress: (p) => setBusy(prev => prev ? { ...prev, progress: p } : prev),
      })
      setBusy(prev => prev ? { ...prev, progress: 'Sending to the printer' } : prev)
      const rec = await recordProductionCardPrint(supabase, { job, machine: selectedMachine, operator, doc: card.doc, pageCount: card.pageCount })
      const printed = await printHtmlJob(card.html)
      if (printed.how === 'error') {
        const failure = printed.error || new Error('print failed')
        await recordPrintFailed(supabase, { kind: 'card', job, machine: selectedMachine, operator, error: failure })
        throw failure
      }
      setResult({
        job, kind: 'card', how: printed.how,
        printed: [{ doc: card.doc, pages: card.pageCount }], skipped: [], pageCount: card.pageCount,
        errors: [rec.auditError && `audit log (${rec.auditError.message || 'unknown error'})`].filter(Boolean),
      })
    } catch (err) {
      console.error('Production card failed:', err)
      showToast("Couldn't print the production card: " + (err.message || 'unknown error'), 'error')
    } finally {
      setBusy(null)
      setLastActivity(Date.now())
    }
  }

  // ---------- Feature gate ----------
  if (!FEATURES.TRAVELER_KIOSK) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-6">
        <div className="text-center text-gray-400">
          <Printer size={48} className="mx-auto mb-4 text-gray-600" />
          <p className="text-lg">The Traveler Kiosk is not enabled.</p>
        </div>
      </div>
    )
  }

  // ---------- PIN screen ----------
  if (!operator) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-6">
        <PinPad
          icon={<Printer size={40} className="mx-auto mb-3 text-skynet-accent" />}
          title="Traveler Kiosk"
          subtitle="Enter your PIN"
          pin={pin}
          error={authError}
          busy={authenticating}
          onDigit={handlePinInput}
          onClear={handlePinClear}
          onBackspace={handlePinBackspace}
          onSubmit={handlePinSubmit}
        />
      </div>
    )
  }

  const operatorName = operator.full_name || operator.username

  // ---------- Machine picker ----------
  if (!selectedMachine) {
    const byLocation = {}
    for (const m of machines) {
      const loc = m.locations?.name || 'Other'
      if (!byLocation[loc]) byLocation[loc] = []
      byLocation[loc].push(m)
    }
    // Leesburg Main first, then the rest alphabetically (D-TKIOSK-03).
    const locations = Object.keys(byLocation).sort((a, b) => {
      const al = a.toLowerCase().startsWith('leesburg') ? 0 : 1
      const bl = b.toLowerCase().startsWith('leesburg') ? 0 : 1
      return al - bl || a.localeCompare(b)
    })
    return (
      <div className="min-h-screen bg-gray-900 text-white">
        <header className="sticky top-0 bg-gray-800 border-b border-gray-700 px-5 py-4 flex items-center justify-between z-10">
          <div className="flex items-center gap-3">
            <Printer size={22} className="text-skynet-accent" />
            <div>
              <h1 className="font-semibold leading-tight">Traveler Kiosk</h1>
              <p className="text-gray-400 text-xs">Tap your machine · {operatorName}</p>
            </div>
          </div>
          <button onClick={handleLogout} className="flex items-center gap-2 text-gray-400 hover:text-white text-sm"><LogOut size={16} /> Sign out</button>
        </header>
        <div className="p-5">
          {machinesLoading ? (
            <div className="flex items-center gap-2 text-gray-400"><Loader2 size={18} className="animate-spin" /> Loading machines…</div>
          ) : locations.length === 0 ? (
            <p className="text-gray-400">No machines available.</p>
          ) : (
            locations.map(loc => (
              <div key={loc} className="mb-6">
                <h2 className="text-gray-400 text-xs uppercase tracking-wide mb-2">{loc}</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  {byLocation[loc].map(m => (
                    <button key={m.id} onClick={() => setSelectedMachine(m)}
                      className="text-left bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-skynet-accent rounded-xl p-5 transition-colors">
                      <p className="font-semibold text-white text-lg">{m.name}</p>
                      <p className="text-gray-400 text-sm font-mono">{m.code}</p>
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
        {toast && <Toast toast={toast} />}
      </div>
    )
  }

  // ---------- Lineup ----------
  const firstQueuedId = jobs.find(j => j.status === 'assigned')?.id || null

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="sticky top-0 bg-gray-800 border-b border-gray-700 px-5 py-4 flex items-center justify-between z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => { setSelectedMachine(null); setJobs([]) }} className="text-gray-400 hover:text-white" aria-label="Back to machines"><ArrowLeft size={20} /></button>
          <div>
            <h1 className="font-semibold leading-tight">{selectedMachine.name} <span className="text-gray-500 font-mono text-sm">{selectedMachine.code}</span></h1>
            <p className="text-gray-400 text-xs">Job lineup · {operatorName}</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <button onClick={() => loadJobs(selectedMachine)} disabled={jobsLoading} className="flex items-center gap-2 text-gray-400 hover:text-white text-sm disabled:opacity-50">
            <RefreshCw size={16} className={jobsLoading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button onClick={handleLogout} className="flex items-center gap-2 text-gray-400 hover:text-white text-sm"><LogOut size={16} /> Sign out</button>
        </div>
      </header>

      <div className="p-5 max-w-5xl mx-auto">
        {jobsLoading && jobs.length === 0 ? (
          <div className="flex items-center gap-2 text-gray-400"><Loader2 size={18} className="animate-spin" /> Loading lineup…</div>
        ) : jobs.length === 0 ? (
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-8 text-center text-gray-400">
            <ClipboardList size={36} className="mx-auto mb-3 text-gray-600" />
            Nothing is lined up for {selectedMachine.name}.
          </div>
        ) : (
          <div className="space-y-3">
            {jobs.map((job, idx) => {
              const docs = docsByJob[job.id] || []
              const card = findProductionCard(docs)
              const cardPrintable = !!card && isPrintableDoc(card)
              const onMachine = job.status === 'in_setup' || job.status === 'in_progress'
              const waiting = job.status === 'pending_compliance'
              const canPrint = !waiting
              const wasPrinted = !!job.traveler_printed_at
              // Batch B moves this rule into isPaperworkStale itself (D-TKIOSK-10);
              // until then a never-printed job is never flagged here.
              const changedSincePrint = wasPrinted && isPaperworkStale(job)
              const runTarget = getRunTarget(job, allocsByJob[job.id] || [])
              const printedBy = job.traveler_printed_by ? namesById[job.traveler_printed_by] : null
              const isNext = job.id === firstQueuedId
              return (
                <div key={job.id} className={`rounded-xl border p-4 ${waiting ? 'bg-gray-900 border-gray-800 opacity-60' : onMachine ? 'bg-gray-800 border-skynet-accent/60' : 'bg-gray-800 border-gray-700'}`}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-gray-500 text-xs font-mono">#{idx + 1}</span>
                        <span className="font-mono text-white font-semibold">{job.job_number}</span>
                        <StatusChip status={job.status} />
                        {isNext && !onMachine && <span className="px-2 py-0.5 text-xs font-medium rounded bg-skynet-accent/20 text-skynet-accent">Next up</span>}
                        {onMachine && <span className="text-xs text-gray-400">On the machine</span>}
                        {job.documents_deferred && <span className="px-2 py-0.5 text-xs font-medium rounded bg-yellow-500/20 text-yellow-400">Docs deferred</span>}
                      </div>
                      <p className="text-white text-lg font-semibold mt-1 truncate">
                        {job.component?.part_number || '—'}
                        <span className="text-gray-400 font-normal text-sm ml-2">{job.component?.description || ''}</span>
                      </p>
                      <p className="text-gray-400 text-sm mt-1">
                        Qty {runTarget.toLocaleString()} · {job.work_order?.wo_number || '—'} · {job.work_order?.customer || '—'} · Due {formatDate(job.work_order?.due_date)}
                      </p>
                      <p className="text-gray-500 text-xs mt-2 flex items-center gap-2 flex-wrap">
                        <FileText size={12} />
                        <span>Traveler</span>
                        {docs.map(d => (
                          isPrintableDoc(d)
                            ? <span key={d.id}>· {d.document_type?.name || d.file_name}</span>
                            : <span key={d.id} className="text-amber-300 flex items-center gap-1">· <AlertTriangle size={12} /> {d.document_type?.name || d.file_name} (can't print here)</span>
                        ))}
                      </p>
                      <p className="text-xs mt-1">
                        {changedSincePrint ? (
                          <span className="text-amber-300 flex items-center gap-1"><AlertTriangle size={12} /> Changed since last print — reprint</span>
                        ) : wasPrinted ? (
                          <span className="text-gray-500">Printed {formatDateTime(job.traveler_printed_at)}{printedBy ? ` by ${printedBy}` : ''}</span>
                        ) : (
                          <span className="text-gray-500">Not printed yet</span>
                        )}
                      </p>
                    </div>
                    <div className="flex flex-col gap-2 w-full sm:w-auto">
                      {canPrint && (
                        <button onClick={() => handlePrintPack(job)} disabled={!!busy}
                          className={`flex items-center justify-center gap-2 px-5 py-3 rounded-lg font-semibold transition-colors disabled:opacity-50 ${onMachine || (wasPrinted && !changedSincePrint) ? 'bg-gray-700 hover:bg-gray-600 text-white' : 'bg-skynet-accent hover:bg-blue-600 text-white'}`}>
                          <Printer size={18} /> {wasPrinted ? 'Reprint Travel Pack' : 'Print Travel Pack'}
                        </button>
                      )}
                      {canPrint && card && (
                        <button onClick={() => handlePrintCard(job)} disabled={!!busy || !cardPrintable}
                          title={cardPrintable ? undefined : "This production card's file type can't be printed here — see Roger"}
                          className={`flex items-center justify-center gap-2 px-5 py-3 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${onMachine && cardPrintable ? 'bg-skynet-accent hover:bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-white'}`}>
                          <ClipboardList size={18} /> Print Production Card
                        </button>
                      )}
                      {canPrint && card && !cardPrintable && (
                        <p className="text-amber-300 text-xs text-center">Card can't print here — see Roger</p>
                      )}
                      {waiting && <p className="text-gray-500 text-xs text-center">Prints once compliance releases it</p>}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Printing overlay */}
      {busy && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-40 p-6">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8 w-full max-w-md text-center">
            <Loader2 size={36} className="animate-spin mx-auto mb-4 text-skynet-accent" />
            <p className="text-white font-semibold text-lg">{busy.kind === 'card' ? 'Printing production card' : 'Printing travel pack'} — {busy.job.job_number}</p>
            <p className="text-gray-400 text-sm mt-2">{busy.progress}…</p>
          </div>
        </div>
      )}

      {/* Confirmation (Batch B adds the setup prompt here — D-TKIOSK-08) */}
      {result && !busy && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-40 p-6">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8 w-full max-w-lg">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <CheckCircle size={32} className="text-green-400 flex-shrink-0" />
                <div>
                  <p className="text-white font-semibold text-lg">
                    {result.kind === 'card' ? 'Production card' : 'Travel pack'} for {result.job.job_number} sent to the printer
                  </p>
                  <p className="text-gray-400 text-sm">{result.pageCount} page{result.pageCount === 1 ? '' : 's'}{result.how === 'timeout' ? ' · the printer did not confirm — check the tray' : ''}</p>
                </div>
              </div>
              <button onClick={() => setResult(null)} className="text-gray-500 hover:text-white" aria-label="Close"><X size={20} /></button>
            </div>
            <ul className="mt-4 space-y-1 text-sm text-gray-300">
              {result.kind === 'pack' && <li className="flex items-center gap-2"><FileText size={14} className="text-blue-400" /> Job Traveler</li>}
              {result.printed.map((p, i) => (
                <li key={i} className="flex items-center gap-2"><FileText size={14} className="text-green-400" /> {p.doc.document_type?.name || p.doc.file_name}{p.pages > 1 ? ` (${p.pages} pages)` : ''}</li>
              ))}
              {result.skipped.map((s, i) => (
                <li key={`s${i}`} className="flex items-center gap-2 text-amber-300"><AlertTriangle size={14} /> Not printed: {s.type || s.file_name} — {s.reason}. See Roger.</li>
              ))}
            </ul>
            {result.errors.length > 0 && (
              <p className="mt-3 text-xs text-amber-300">The pack printed, but SkyNet could not record the {result.errors.join(' and ')}. Tell Matt.</p>
            )}
            <div className="mt-6 flex flex-col sm:flex-row gap-3">
              <button onClick={() => setResult(null)} className="flex-1 px-5 py-3 rounded-lg bg-gray-700 hover:bg-gray-600 text-white font-semibold">Back to lineup</button>
              <button onClick={handleLogout} className="flex-1 px-5 py-3 rounded-lg bg-skynet-accent hover:bg-blue-600 text-white font-semibold">Done — sign out</button>
            </div>
          </div>
        </div>
      )}

      {toast && <Toast toast={toast} />}
    </div>
  )
}
