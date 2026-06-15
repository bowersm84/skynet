import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { FEATURES } from '../config'
import { lotAllowed, deriveConsumed } from '../lib/materialIssues'
import PinPad from '../components/PinPad'
import {
  Loader2, LogOut, Package, ArrowLeft, Plus, CheckCircle,
  AlertTriangle, Search, X, Layers, RotateCcw, ClipboardCheck
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
    // Storage blocked (private mode etc.). Fall back to a per-tab id —
    // the user will have to PIN in every refresh, which is the SAFE
    // failure mode.
    return `ephemeral-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

// Running vs queued for the per-machine lineup. Mirrors Kiosk.jsx loadJobs.
const RUNNING_STATUSES = ['in_setup', 'in_progress']
const QUEUED_STATUSES = ['pending_compliance', 'assigned']
const JOB_STATUSES = [...RUNNING_STATUSES, ...QUEUED_STATUSES]
const STATUS_RANK = { in_progress: 0, in_setup: 1, assigned: 2, pending_compliance: 3 }

const STATUS_LABEL = {
  in_progress: 'Running',
  in_setup: 'In Setup',
  assigned: 'Queued',
  pending_compliance: 'Pending Compliance',
  manufacturing_complete: 'Machining done',
  complete: 'Complete',
}

export default function MaterialKiosk() {
  // Per-device id — stable across reloads via localStorage. Mirrors Kiosk.jsx;
  // passed to kiosk-authenticate so the rack runs as `authenticated`.
  const deviceIdRef = useRef(getKioskDeviceId())

  // --- Auth (authenticates via kiosk-authenticate edge function so every
  // read/write runs as `authenticated`; jobs/job_materials/catalogs are
  // authenticated-only on PROD) ---
  const [pin, setPin] = useState('')
  const [operator, setOperator] = useState(null)
  const [authError, setAuthError] = useState(null)
  const [authenticating, setAuthenticating] = useState(false)

  // --- Top-level mode: 'home' | 'stage' | 'finalize' ---
  const [mode, setMode] = useState('home')

  // --- Machine selection (stage mode) ---
  const [machines, setMachines] = useState([])
  const [machinesLoading, setMachinesLoading] = useState(false)
  const [selectedMachine, setSelectedMachine] = useState(null)
  const [machineSearch, setMachineSearch] = useState('')

  // --- Jobs for the selected machine ---
  const [jobs, setJobs] = useState([])
  const [jobsLoading, setJobsLoading] = useState(false)

  // --- Catalogs (master-driven selection; no free text for type/size) ---
  const [materialTypes, setMaterialTypes] = useState([])
  const [barSizes, setBarSizes] = useState([])
  const [materialsMaster, setMaterialsMaster] = useState([])
  const [inventoryStock, setInventoryStock] = useState([])

  // --- Stage modal ---
  const [stageJob, setStageJob] = useState(null)
  const [stageExisting, setStageExisting] = useState(null)
  const [stageForm, setStageForm] = useState({
    material_type: '', bar_size: '', bar_length: '', lot_number: '', add_bars: '',
  })
  const [staging, setStaging] = useState(false)
  const [lotMismatch, setLotMismatch] = useState(null)

  // --- Finalize / Return (finalize mode) ---
  const [finRows, setFinRows] = useState([])      // recent job_materials rows + job
  const [finLoading, setFinLoading] = useState(false)
  const [finSearch, setFinSearch] = useState('')
  const [finSel, setFinSel] = useState(null)       // { mat, job } selected to finalize/reconcile
  const [finForm, setFinForm] = useState({ loaded: '', remnant: '', return_bars: '' })
  const [finalizing, setFinalizing] = useState(false)

  const [toast, setToast] = useState(null)

  // Per-load history (append-only DISPLAY log) for the open stage/finalize job, oldest first.
  const [loadLog, setLoadLog] = useState([])

  const isBlanks = (stageForm.material_type || '').toLowerCase().includes('blank')

  const showToast = useCallback((msg, kind = 'success') => {
    setToast({ msg, kind })
    setTimeout(() => setToast(null), 3000)
  }, [])

  // Short local time, consistent with the kiosk's clock display.
  const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : ''

  const fetchLoadLog = useCallback(async (jobId) => {
    if (!jobId) { setLoadLog([]); return }
    try {
      const { data } = await supabase
        .from('material_loads')
        .select('id, bars, staged_at, material_type, bar_size, lot_number, staged_by')
        .eq('job_id', jobId)
        .order('staged_at', { ascending: true })
      const loaderIds = [...new Set((data || []).map(l => l.staged_by).filter(Boolean))]
      let nameById = {}
      if (loaderIds.length > 0) {
        const { data: profs } = await supabase
          .from('profiles').select('id, full_name').in('id', loaderIds)
        for (const p of profs || []) nameById[p.id] = p.full_name
      }
      setLoadLog((data || []).map(l => ({ ...l, _loaderName: nameById[l.staged_by] || '' })))
    } catch (err) { console.error('Error loading material loads:', err); setLoadLog([]) }
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
      // The rack must run as `authenticated` (jobs/job_materials/catalogs are
      // authenticated-only on PROD). Authenticate via the same edge function the
      // machine kiosk uses. It needs an active machine to mint the JWT but binds
      // no session to it, so any active machine works as an anchor. machines
      // allows anon reads of active machines, so this fetch works pre-login.
      const { data: anchor } = await supabase
        .from('machines').select('id').eq('is_active', true)
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
      // Opaque/unused refresh_token — re-PIN at expiry. Stop auto-refresh so the
      // client never tries to use it.
      supabase.auth.stopAutoRefresh()

      setOperator(data.operator)
      setMode('home')
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

  // Set the browser tab title (mirrors the machine kiosk).
  useEffect(() => {
    document.title = 'Raw Material Kiosk'
    return () => { document.title = 'SkyNet MES' }
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut({ scope: 'local' })
    setOperator(null); setMode('home'); setSelectedMachine(null)
  }

  // ---------- Catalog loads ----------
  const loadCatalogs = useCallback(async () => {
    try {
      const [{ data: mt }, { data: bs }, { data: mm }] = await Promise.all([
        supabase.from('material_types').select('id, name').eq('is_active', true).order('name'),
        supabase.from('bar_sizes').select('id, size, size_decimal').eq('is_active', true).order('size_decimal'),
        supabase.from('materials').select('id, material_type_id, bar_size_inches').eq('is_active', true),
      ])
      setMaterialTypes(mt || []); setBarSizes(bs || []); setMaterialsMaster(mm || [])
    } catch (err) { console.error('Error loading catalogs:', err) }
  }, [])

  const loadInventoryStock = useCallback(async () => {
    try {
      // available_bars from the material_availability view (received − used + approved
      // adjustments). Signed/unclamped so empty/negative lots stay selectable — the DB
      // trigger flags the discrepancy rather than blocking staging.
      const { data, error } = await supabase
        .from('material_availability')
        .select('material_receiving_id, material_type, bar_size, lot_number, available_bars')
      if (error) throw error
      setInventoryStock((data || [])
        .filter(r => r.lot_number)
        .map(r => ({
          material_type: r.material_type, bar_size: r.bar_size, lot_number: r.lot_number,
          available_bars: r.available_bars,
        })))
    } catch (err) { console.error('Error loading inventory stock:', err); setInventoryStock([]) }
  }, [])

  // ---------- Machine load ----------
  const loadMachines = useCallback(async () => {
    setMachinesLoading(true)
    try {
      const { data, error } = await supabase
        .from('machines')
        .select('id, name, code, machine_type, kiosk_enabled, display_order, location_id, locations:location_id(name)')
        .eq('is_active', true).eq('is_commissioned', true)
        .neq('machine_type', 'finishing')   // finishing tanks don't receive raw material
        .order('display_order')
      if (error) throw error
      setMachines((data || []).filter(m => !m.name?.startsWith('Bolt Master')))
    } catch (err) { console.error('Error loading machines:', err) }
    finally { setMachinesLoading(false) }
  }, [])

  // ---------- Jobs for selected machine (+ staged material map) ----------
  const loadJobs = useCallback(async (machine) => {
    if (!machine) return
    setJobsLoading(true)
    try {
      const { data, error } = await supabase
        .from('jobs')
        .select(`
          id, job_number, status, quantity, scheduled_start, assigned_machine_id,
          work_order:work_orders(wo_number, customer, priority, order_type),
          component:parts!component_id(id, part_number, description)
        `)
        .eq('assigned_machine_id', machine.id)
        .in('status', JOB_STATUSES)
      if (error) throw error
      const list = data || []
      const jobIds = list.map(j => j.id)
      let matByJob = {}
      if (jobIds.length > 0) {
        const { data: mats } = await supabase
          .from('job_materials')
          .select('id, job_id, material_type, bar_size, lot_number, bar_length, bars_loaded, bars_remaining, completed_at')
          .in('job_id', jobIds)
        for (const m of mats || []) matByJob[m.job_id] = m
      }
      // Per-job load history (append-only DISPLAY log) for inline lineup display.
      let loadsByJob = {}
      if (jobIds.length > 0) {
        const { data: loads } = await supabase
          .from('material_loads')
          .select('*, profiles:staged_by ( full_name )')
          .in('job_id', jobIds)
          .order('staged_at', { ascending: true })
        for (const l of loads || []) {
          if (!loadsByJob[l.job_id]) loadsByJob[l.job_id] = []
          loadsByJob[l.job_id].push(l)
        }
      }
      list.forEach(j => { j._material = matByJob[j.id] || null; j._loads = loadsByJob[j.id] || [] })
      list.sort((a, b) => {
        const ra = STATUS_RANK[a.status] ?? 9, rb = STATUS_RANK[b.status] ?? 9
        if (ra !== rb) return ra - rb
        return (a.scheduled_start || '').localeCompare(b.scheduled_start || '')
      })
      setJobs(list)
    } catch (err) { console.error('Error loading jobs:', err) }
    finally { setJobsLoading(false) }
  }, [])

  // ---------- Finalize list: recent job_materials rows + their job ----------
  const loadFinalizeRows = useCallback(async () => {
    setFinLoading(true)
    try {
      const { data: mats, error } = await supabase
        .from('job_materials')
        .select('id, job_id, material_type, bar_size, lot_number, bars_loaded, bars_remaining, completed_at, reconciled_at')
        .order('loaded_at', { ascending: false })
        .limit(60)
      if (error) throw error
      const rows = mats || []
      // Two-level nest (job_materials->jobs->parts) fetched separately and merged
      // client-side per the project's nested-query guidance.
      const jobIds = [...new Set(rows.map(r => r.job_id).filter(Boolean))]
      let jobById = {}
      if (jobIds.length > 0) {
        const { data: jobsData } = await supabase
          .from('jobs')
          .select('id, job_number, status, quantity, component:parts!component_id(part_number, description)')
          .in('id', jobIds)
        for (const j of jobsData || []) jobById[j.id] = j
      }
      setFinRows(rows.map(m => ({ mat: m, job: jobById[m.job_id] || null })))
    } catch (err) { console.error('Error loading finalize rows:', err) }
    finally { setFinLoading(false) }
  }, [])

  // Load catalogs + machines once the operator is in.
  useEffect(() => {
    if (!operator) return
    loadCatalogs(); loadInventoryStock(); loadMachines()
  }, [operator, loadCatalogs, loadInventoryStock, loadMachines])

  // Jobs poll while a machine is picked (stage mode).
  useEffect(() => {
    if (!operator || mode !== 'stage' || !selectedMachine) return
    loadJobs(selectedMachine)
    const t = setInterval(() => loadJobs(selectedMachine), 60000)
    return () => clearInterval(t)
  }, [operator, mode, selectedMachine, loadJobs])

  // Load finalize rows when entering finalize mode.
  useEffect(() => {
    if (!operator || mode !== 'finalize') return
    loadFinalizeRows()
  }, [operator, mode, loadFinalizeRows])

  // ---------- Staging ----------
  const openStage = (job) => {
    const existing = job._material || null
    setStageJob(job); setStageExisting(existing); setLotMismatch(null)
    setStageForm({
      material_type: existing?.material_type || '',
      bar_size: existing?.bar_size || '',
      bar_length: existing?.bar_length != null ? String(existing.bar_length) : '',
      lot_number: existing?.lot_number || '',
      add_bars: '',
    })
    fetchLoadLog(job.id)
  }
  const closeStage = () => { setStageJob(null); setStageExisting(null); setLotMismatch(null); setLoadLog([]) }

  const resolveMasterId = () => {
    const typeRow = materialTypes.find(t => t.name === stageForm.material_type)
    const sizeRow = barSizes.find(b => b.size === stageForm.bar_size)
    if (!typeRow || isBlanks || !sizeRow || sizeRow.size_decimal == null) return null
    return materialsMaster.find(
      mm => mm.material_type_id === typeRow.id && Number(mm.bar_size_inches) === Number(sizeRow.size_decimal)
    )?.id || null
  }

  const lotSuggestions = (() => {
    if (!stageForm.material_type) return []
    const rows = inventoryStock
      .filter(r => r.material_type === stageForm.material_type && (isBlanks || r.bar_size === stageForm.bar_size) && r.lot_number)
    // Sum available bars per lot so a lot at/below zero can be labeled but still selectable.
    const byLot = new Map()
    for (const r of rows) {
      byLot.set(r.lot_number, (byLot.get(r.lot_number) || 0) + (r.available_bars || 0))
    }
    return [...byLot.entries()].map(([lot, available_bars]) => ({ lot, available_bars }))
  })()

  const handleStage = async () => {
    if (!stageForm.material_type) { showToast('Select a material type', 'error'); return }
    if (!isBlanks && !stageForm.bar_size) { showToast('Select a bar size', 'error'); return }
    const addBars = parseInt(stageForm.add_bars)
    if (!addBars || addBars <= 0) { showToast(`Enter the number of ${isBlanks ? 'blanks' : 'bars'} staged`, 'error'); return }

    setStaging(true)
    try {
      const { data: rows, error: exErr } = await supabase
        .from('job_materials').select('*').eq('job_id', stageJob.id).limit(1)
      if (exErr) throw exErr
      const existing = rows?.[0] || null
      const newLot = (stageForm.lot_number || '').trim()
      const masterId = resolveMasterId()

      if (existing) {
        const existingLot = (existing.lot_number || '').trim()
        if (existingLot && newLot && !lotAllowed(existingLot, newLot)) {
          setLotMismatch({ existingLot, newLot })
          supabase.from('audit_logs').insert({
            event_type: 'lot_mismatch', job_id: stageJob.id, machine_id: selectedMachine?.id || null,
            operator_id: operator.id,
            details: { existing_lot: existingLot, attempted_lot: newLot, job_number: stageJob.job_number, source: 'material_kiosk' },
          }).then(() => {}, () => {})
          setStaging(false); return
        }
        const { error } = await supabase.from('job_materials').update({
          bars_loaded: (existing.bars_loaded || 0) + addBars,
          material_type: existing.material_type || stageForm.material_type,
          bar_size: existing.bar_size || (isBlanks ? 'N/A' : stageForm.bar_size),
          bar_length: existing.bar_length ?? ((!isBlanks && stageForm.bar_length) ? parseFloat(stageForm.bar_length) : null),
          lot_number: existing.lot_number || (newLot || null),
          material_master_id: existing.material_master_id || masterId,
          loaded_by: operator.id, loaded_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq('id', existing.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('job_materials').insert({
          job_id: stageJob.id,
          material_type: stageForm.material_type,
          bar_size: isBlanks ? 'N/A' : stageForm.bar_size,
          bar_length: (!isBlanks && stageForm.bar_length) ? parseFloat(stageForm.bar_length) : null,
          lot_number: newLot || null, bars_loaded: addBars, material_master_id: masterId,
          loaded_by: operator.id, loaded_at: new Date().toISOString(),
        })
        if (error) throw error
      }

      // Per-load history (append-only DISPLAY log) — fire-and-forget, never blocks staging.
      supabase.from('material_loads').insert({
        job_id: stageJob.id,
        material_type: stageForm.material_type,
        bar_size: isBlanks ? 'N/A' : stageForm.bar_size,
        lot_number: newLot || null,
        bars: addBars,
        source: 'material_kiosk',
        staged_by: operator.id,
      }).then(() => {}, (err) => console.warn('material_loads write failed (non-fatal):', err))

      // Fire-and-forget inventory usage (mirrors Kiosk.handleAddMaterial). Non-fatal in v1.
      const savedType = stageForm.material_type
      const savedSize = isBlanks ? 'N/A' : stageForm.bar_size
      const savedLength = parseFloat(stageForm.bar_length) || 0
      const savedJobId = stageJob.id
      const savedOperatorId = operator.id
      ;(async () => {
        try {
          let matchedReceiving = null
          if (newLot) {
            const { data: recv } = await supabase
              .from('material_receiving').select('id, material_id, quantity')
              .eq('lot_number', newLot).eq('material_type', savedType).eq('bar_size', savedSize)
              .order('received_at', { ascending: false }).limit(1)
            matchedReceiving = recv?.[0] || null
          }
          await supabase.from('material_usage').insert({
            material_receiving_id: matchedReceiving?.id || null, material_id: matchedReceiving?.material_id || null,
            lot_number: newLot || null, job_id: savedJobId, quantity_used: addBars,
            quantity_used_inches: addBars * savedLength, used_by: savedOperatorId,
            used_at: new Date().toISOString(), notes: 'rack staging',
          })
        } catch (err) { console.warn('Inventory usage write failed (non-fatal):', err) }
      })()

      showToast(`Staged ${addBars} ${isBlanks ? 'blanks' : 'bars'} to ${stageJob.component?.part_number || stageJob.job_number}`)
      closeStage(); loadJobs(selectedMachine)
    } catch (err) {
      console.error('Error staging material:', err)
      showToast('Failed to stage: ' + (err.message || 'unknown error'), 'error')
    } finally { setStaging(false) }
  }

  // ---------- Finalize / Reconcile ----------
  const openFinalize = ({ mat, job }) => {
    setFinSel({ mat, job })
    setFinForm({
      loaded: mat?.bars_loaded != null ? String(mat.bars_loaded) : '',
      remnant: mat?.bars_remaining != null ? String(mat.bars_remaining) : '',
      return_bars: '',
    })
    fetchLoadLog(mat?.job_id)
  }
  const closeFinalize = () => { setFinSel(null); setLoadLog([]) }

  const isFinalized = (mat) => !!mat?.completed_at

  const handleFinalizeSave = async () => {
    const mat = finSel?.mat
    if (!mat) return
    const loaded = parseInt(finForm.loaded)
    const remnant = parseInt(finForm.remnant)
    if (!Number.isFinite(loaded) || loaded < 0) { showToast('Loaded count cannot be negative', 'error'); return }
    if (!Number.isFinite(remnant) || remnant < 0) { showToast('Remnant cannot be negative', 'error'); return }
    if (remnant > loaded) { showToast(`Remnant (${remnant}) cannot exceed loaded (${loaded})`, 'error'); return }
    setFinalizing(true)
    try {
      const now = new Date().toISOString()
      const { error } = await supabase.from('job_materials').update({
        bars_loaded: loaded,
        bars_remaining: remnant,
        completed_by: operator.id,
        completed_at: now,
        updated_at: now,
      }).eq('id', mat.id)
      if (error) throw error
      showToast(`Finalized · consumed ${Math.max(0, loaded - remnant)} bars`)
      closeFinalize(); loadFinalizeRows()
    } catch (err) {
      console.error('Error finalizing:', err)
      showToast('Failed to finalize: ' + (err.message || 'unknown error'), 'error')
    } finally { setFinalizing(false) }
  }

  // Closed-job: record a late-found leftover bar as a tagged return (never inflates consumed).
  const handleReconcileSave = async () => {
    const mat = finSel?.mat
    if (!mat) return
    const ret = parseInt(finForm.return_bars)
    if (!Number.isFinite(ret) || ret <= 0) { showToast('Enter the number of bars found', 'error'); return }
    const newRemnant = (mat.bars_remaining || 0) + ret
    if (newRemnant > (mat.bars_loaded || 0)) {
      showToast(`Return would push remnant (${newRemnant}) above loaded (${mat.bars_loaded || 0})`, 'error'); return
    }
    setFinalizing(true)
    try {
      const now = new Date().toISOString()
      const { error } = await supabase.from('job_materials').update({
        bars_remaining: newRemnant,            // raises remnant -> lowers consumed; never inflates consumed
        reconciled_by: operator.id,
        reconciled_at: now,
        updated_at: now,
      }).eq('id', mat.id)
      if (error) throw error
      showToast(`Recorded ${ret} leftover bar${ret === 1 ? '' : 's'} as a return`)
      closeFinalize(); loadFinalizeRows()
    } catch (err) {
      console.error('Error reconciling:', err)
      showToast('Failed to record: ' + (err.message || 'unknown error'), 'error')
    } finally { setFinalizing(false) }
  }

  // ---------- Feature gate ----------
  if (!FEATURES.MATERIAL_KIOSK) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-6">
        <div className="text-center text-gray-400">
          <Package size={48} className="mx-auto mb-4 text-gray-600" />
          <p className="text-lg">The Material Checkout Kiosk is not enabled.</p>
        </div>
      </div>
    )
  }

  // ---------- PIN screen ----------
  if (!operator) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-6">
        <PinPad
          icon={<Package size={40} className="mx-auto mb-3 text-skynet-accent" />}
          title="Material Checkout"
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

  // ---------- Home ----------
  if (mode === 'home') {
    return (
      <div className="min-h-screen bg-gray-900 text-white">
        <header className="bg-gray-800 border-b border-gray-700 px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Package size={22} className="text-skynet-accent" />
            <div>
              <h1 className="font-semibold leading-tight">Material Checkout</h1>
              <p className="text-gray-400 text-xs">{operator.full_name || operator.username}</p>
            </div>
          </div>
          <button onClick={handleLogout} className="flex items-center gap-2 text-gray-400 hover:text-white text-sm"><LogOut size={16} /> Log out</button>
        </header>
        <div className="p-6 max-w-2xl mx-auto grid sm:grid-cols-2 gap-4 mt-6">
          <button onClick={() => { setSelectedMachine(null); setMode('stage') }}
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-skynet-accent rounded-2xl p-8 text-center transition-colors">
            <Layers size={36} className="mx-auto mb-3 text-skynet-accent" />
            <p className="font-semibold text-lg">Stage material</p>
            <p className="text-gray-400 text-sm mt-1">Issue bars to a machine's running or queued jobs</p>
          </button>
          <button onClick={() => { setFinSel(null); setMode('finalize') }}
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-skynet-accent rounded-2xl p-8 text-center transition-colors">
            <ClipboardCheck size={36} className="mx-auto mb-3 text-skynet-accent" />
            <p className="font-semibold text-lg">Finalize / return</p>
            <p className="text-gray-400 text-sm mt-1">Record remnants at completion or return a late-found bar</p>
          </button>
        </div>
        {toast && <Toast toast={toast} />}
      </div>
    )
  }

  // ---------- Finalize / Return mode ----------
  if (mode === 'finalize') {
    const term = finSearch.trim().toLowerCase()
    const filtered = finRows.filter(({ mat, job }) => {
      if (!term) return true
      const pn = job?.component?.part_number?.toLowerCase() || ''
      const jn = job?.job_number?.toLowerCase() || ''
      const lot = mat?.lot_number?.toLowerCase() || ''
      return pn.includes(term) || jn.includes(term) || lot.includes(term)
    })
    return (
      <div className="min-h-screen bg-gray-900 text-white">
        <header className="sticky top-0 bg-gray-800 border-b border-gray-700 px-5 py-4 flex items-center justify-between z-10">
          <div className="flex items-center gap-3">
            <button onClick={() => setMode('home')} className="text-gray-400 hover:text-white"><ArrowLeft size={20} /></button>
            <div><h1 className="font-semibold leading-tight">Finalize / Return</h1>
              <p className="text-gray-400 text-xs">Record remnants or return a late-found bar</p></div>
          </div>
          <button onClick={handleLogout} className="flex items-center gap-2 text-gray-400 hover:text-white text-sm"><LogOut size={16} /> Log out</button>
        </header>

        <div className="p-5 max-w-3xl">
          <div className="relative mb-5">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input value={finSearch} onChange={e => setFinSearch(e.target.value)}
              placeholder="Search by part #, job # or lot…"
              className="w-full pl-9 pr-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-skynet-accent focus:outline-none" />
          </div>

          {finLoading ? (
            <div className="flex items-center gap-2 text-gray-400"><Loader2 size={18} className="animate-spin" /> Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="text-center text-gray-500 py-16"><Package size={40} className="mx-auto mb-3 text-gray-600" /><p>No material records found.</p></div>
          ) : (
            <div className="space-y-3">
              {filtered.map(({ mat, job }) => {
                const finalized = isFinalized(mat)
                const consumed = deriveConsumed(mat)
                return (
                  <button key={mat.id} onClick={() => openFinalize({ mat, job })}
                    className="w-full text-left bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-skynet-accent rounded-xl p-4 transition-colors">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-white font-mono font-semibold truncate">{job?.component?.part_number || job?.job_number || 'job'}</span>
                          {finalized
                            ? <span className="text-[11px] px-2 py-0.5 rounded bg-gray-700 text-gray-300">{STATUS_LABEL[job?.status] || 'Finalized'}</span>
                            : <span className="text-[11px] px-2 py-0.5 rounded bg-amber-900/40 text-amber-300">Not finalized</span>}
                          {mat.reconciled_at && <span className="text-[11px] px-2 py-0.5 rounded bg-blue-900/40 text-blue-300">Return logged</span>}
                        </div>
                        <p className="text-gray-400 text-sm mt-0.5 truncate">{mat.material_type || '—'}{mat.bar_size && mat.bar_size !== 'N/A' ? ` · ${mat.bar_size}` : ''}{mat.lot_number ? ` · lot ${mat.lot_number}` : ''}</p>
                        <p className="text-skynet-accent text-xs font-mono mt-0.5">{job?.job_number || ''}</p>
                      </div>
                      <div className="text-right text-xs shrink-0">
                        <p className="text-gray-300">{mat.bars_loaded || 0} loaded</p>
                        <p className="text-gray-400">{mat.bars_remaining == null ? '—' : `${mat.bars_remaining} remnant`}</p>
                        {finalized && <p className="text-green-400">{consumed} used</p>}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Finalize / reconcile modal */}
        {finSel && (
          <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-6 z-20">
            <div className="bg-gray-900 border border-gray-700 rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[92vh] overflow-y-auto">
              <div className="sticky top-0 bg-gray-900 border-b border-gray-800 px-5 py-4 flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-white">{isFinalized(finSel.mat) ? 'Closed job — return a bar' : 'Finalize material'}</h3>
                  <p className="text-gray-400 text-xs font-mono">{finSel.job?.component?.part_number || finSel.job?.job_number}{finSel.mat.lot_number ? ` · lot ${finSel.mat.lot_number}` : ''}</p>
                </div>
                <button onClick={closeFinalize} className="text-gray-400 hover:text-white"><X size={20} /></button>
              </div>

              <div className="p-5 space-y-4">
                {loadLog.length > 0 && (
                  <div className="bg-gray-800/60 border border-gray-700 rounded-lg p-3">
                    <p className="text-gray-500 text-xs uppercase tracking-wide mb-1.5">Loads</p>
                    <div className="space-y-1.5">
                      {loadLog.map(l => (
                        <div key={l.id} className="flex items-baseline gap-2 text-sm">
                          <span className="text-white font-semibold">{l.bars} bars</span>
                          <span className="text-gray-400">— {[l._loaderName, fmtTime(l.staged_at)].filter(Boolean).join(' · ')}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {!isFinalized(finSel.mat) ? (
                  <>
                    <p className="text-gray-400 text-sm">Confirm the bars actually loaded, then enter any leftover bars (usually 0).</p>
                    <div>
                      <label className="block text-gray-400 text-sm mb-2">Bars loaded</label>
                      <input type="number" inputMode="numeric" min="0" value={finForm.loaded}
                        onChange={e => setFinForm({ ...finForm, loaded: e.target.value })}
                        className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-skynet-accent focus:outline-none" />
                    </div>
                    <div>
                      <label className="block text-gray-400 text-sm mb-2">Bars remaining (remnant)</label>
                      <input type="number" inputMode="numeric" min="0" value={finForm.remnant}
                        onChange={e => setFinForm({ ...finForm, remnant: e.target.value })}
                        className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-skynet-accent focus:outline-none" />
                    </div>
                    <div className="bg-gray-800 rounded-lg p-3 text-sm text-gray-300">
                      Consumed: <span className="text-green-400 font-semibold">
                        {Math.max(0, (parseInt(finForm.loaded) || 0) - (parseInt(finForm.remnant) || 0))}
                      </span> bars
                    </div>
                    <button onClick={handleFinalizeSave} disabled={finalizing}
                      className="w-full h-12 bg-skynet-accent hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2">
                      {finalizing ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle size={18} />} Finalize material
                    </button>
                  </>
                ) : (
                  <>
                    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm">
                      <p className="text-gray-300">Finalized · <span className="text-white">{finSel.mat.bars_loaded || 0}</span> loaded · <span className="text-white">{finSel.mat.bars_remaining ?? 0}</span> remnant · <span className="text-green-400">{deriveConsumed(finSel.mat)}</span> used</p>
                      <p className="text-gray-500 text-xs mt-1">If this leftover was already counted in the remnant, close without recording. Only record a bar that wasn't captured.</p>
                    </div>
                    <div>
                      <label className="block text-gray-400 text-sm mb-2">Late-found bars to return</label>
                      <input type="number" inputMode="numeric" min="1" value={finForm.return_bars}
                        onChange={e => setFinForm({ ...finForm, return_bars: e.target.value })}
                        className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-skynet-accent focus:outline-none" />
                      <p className="text-gray-500 text-xs mt-1">Recorded as a tagged return — raises the remnant and lowers consumed; never inflates consumed.</p>
                    </div>
                    <button onClick={handleReconcileSave} disabled={finalizing}
                      className="w-full h-12 bg-skynet-accent hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2">
                      {finalizing ? <Loader2 size={18} className="animate-spin" /> : <RotateCcw size={18} />} Record return
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
        {toast && <Toast toast={toast} />}
      </div>
    )
  }

  // ---------- Stage mode: machine selection ----------
  if (mode === 'stage' && !selectedMachine) {
    const term = machineSearch.trim().toLowerCase()
    const filtered = machines.filter(m => !term || m.name?.toLowerCase().includes(term) || m.code?.toLowerCase().includes(term))
    const byLocation = {}
    for (const m of filtered) {
      const loc = m.locations?.name || 'Other'
      if (!byLocation[loc]) byLocation[loc] = []
      byLocation[loc].push(m)
    }
    return (
      <div className="min-h-screen bg-gray-900 text-white">
        <header className="sticky top-0 bg-gray-800 border-b border-gray-700 px-5 py-4 flex items-center justify-between z-10">
          <div className="flex items-center gap-3">
            <button onClick={() => setMode('home')} className="text-gray-400 hover:text-white"><ArrowLeft size={20} /></button>
            <div><h1 className="font-semibold leading-tight">Stage material</h1>
              <p className="text-gray-400 text-xs">Pick a machine · {operator.full_name || operator.username}</p></div>
          </div>
          <button onClick={handleLogout} className="flex items-center gap-2 text-gray-400 hover:text-white text-sm"><LogOut size={16} /> Log out</button>
        </header>
        <div className="p-5">
          <div className="relative mb-5 max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input value={machineSearch} onChange={e => setMachineSearch(e.target.value)} placeholder="Search machines…"
              className="w-full pl-9 pr-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-skynet-accent focus:outline-none" />
          </div>
          {machinesLoading ? (
            <div className="flex items-center gap-2 text-gray-400"><Loader2 size={18} className="animate-spin" /> Loading machines…</div>
          ) : (
            Object.keys(byLocation).sort().map(loc => (
              <div key={loc} className="mb-6">
                <h2 className="text-gray-400 text-xs uppercase tracking-wide mb-2">{loc}</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {byLocation[loc].map(m => (
                    <button key={m.id} onClick={() => setSelectedMachine(m)}
                      className="text-left bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-skynet-accent rounded-xl p-4 transition-colors">
                      <p className="font-semibold text-white">{m.name}</p>
                      <p className="text-gray-400 text-sm font-mono">{m.code}</p>
                      {m.kiosk_enabled === false && <span className="inline-block mt-2 text-[11px] px-2 py-0.5 rounded bg-amber-900/40 text-amber-300">No machine kiosk</span>}
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

  // ---------- Stage mode: job list + staging ----------
  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="sticky top-0 bg-gray-800 border-b border-gray-700 px-5 py-4 flex items-center justify-between z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => { setSelectedMachine(null); setJobs([]) }} className="text-gray-400 hover:text-white"><ArrowLeft size={20} /></button>
          <div><h1 className="font-semibold leading-tight">{selectedMachine.name}</h1>
            <p className="text-gray-400 text-xs font-mono">{selectedMachine.code} · staging</p></div>
        </div>
        <button onClick={handleLogout} className="flex items-center gap-2 text-gray-400 hover:text-white text-sm"><LogOut size={16} /> Log out</button>
      </header>

      <div className="p-5">
        {jobsLoading ? (
          <div className="flex items-center gap-2 text-gray-400"><Loader2 size={18} className="animate-spin" /> Loading jobs…</div>
        ) : jobs.length === 0 ? (
          <div className="text-center text-gray-500 py-16"><Layers size={40} className="mx-auto mb-3 text-gray-600" /><p>No running or queued jobs on this machine.</p></div>
        ) : (
          <div className="space-y-3 max-w-3xl">
            {jobs.map(job => {
              const mat = job._material
              const staged = mat && (mat.bars_loaded || 0) > 0
              return (
                <button key={job.id} onClick={() => openStage(job)}
                  className="w-full text-left bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-skynet-accent rounded-xl p-4 transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-white font-mono font-semibold truncate">{job.component?.part_number || job.job_number}</span>
                        <span className={`text-[11px] px-2 py-0.5 rounded ${RUNNING_STATUSES.includes(job.status) ? 'bg-green-900/40 text-green-300' : 'bg-gray-700 text-gray-300'}`}>{STATUS_LABEL[job.status] || job.status}</span>
                      </div>
                      <p className="text-gray-400 text-sm mt-0.5 truncate">{job.component?.description || '—'}</p>
                      <p className="text-skynet-accent text-xs font-mono mt-0.5">{job.job_number} · {job.work_order?.wo_number || 'no WO'} · qty {job.quantity}</p>
                    </div>
                    <div className="text-right shrink-0">
                      {staged ? (
                        <div className="text-xs">
                          <div className="flex items-center gap-1 text-green-400 justify-end"><CheckCircle size={14} /> {mat.bars_loaded} staged</div>
                          <p className="text-gray-400 mt-0.5">{mat.material_type || '—'}{mat.bar_size && mat.bar_size !== 'N/A' ? ` · ${mat.bar_size}` : ''}</p>
                          {mat.lot_number && <p className="text-gray-500 font-mono">lot {mat.lot_number}</p>}
                        </div>
                      ) : (
                        <span className="text-xs text-gray-500 flex items-center gap-1 justify-end"><Plus size={14} /> Stage material</span>
                      )}
                    </div>
                  </div>
                  {job._loads?.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-gray-700">
                      <p className="text-gray-500 text-xs uppercase tracking-wide mb-1.5">Loads</p>
                      <div className="space-y-1.5">
                        {job._loads.map(load => (
                          <div key={load.id} className="flex items-baseline gap-2 text-sm">
                            <span className="text-white font-semibold">{load.bars} {load.material_type?.toLowerCase().includes('blank') ? 'pieces' : 'bars'}</span>
                            <span className="text-gray-400">— {[load.profiles?.full_name, fmtTime(load.staged_at)].filter(Boolean).join(' · ')}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Stage modal */}
      {stageJob && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-6 z-20">
          <div className="bg-gray-900 border border-gray-700 rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[92vh] overflow-y-auto">
            <div className="sticky top-0 bg-gray-900 border-b border-gray-800 px-5 py-4 flex items-center justify-between">
              <div><h3 className="font-semibold text-white">Stage Material</h3>
                <p className="text-gray-400 text-xs font-mono">{stageJob.component?.part_number || stageJob.job_number} · {selectedMachine.code}</p></div>
              <button onClick={closeStage} className="text-gray-400 hover:text-white"><X size={20} /></button>
            </div>
            <div className="p-5 space-y-4">
              {stageExisting && (stageExisting.bars_loaded || 0) > 0 && (
                <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm">
                  <p className="text-green-400 flex items-center gap-1"><CheckCircle size={14} /> Already staged: {stageExisting.bars_loaded} {isBlanks ? 'blanks' : 'bars'}</p>
                  <p className="text-gray-400 mt-1">{stageExisting.material_type}{stageExisting.bar_size && stageExisting.bar_size !== 'N/A' ? ` · ${stageExisting.bar_size}` : ''}{stageExisting.lot_number ? ` · lot ${stageExisting.lot_number}` : ''}</p>
                  <p className="text-gray-500 text-xs mt-1">Material, size and lot are fixed for this job — you're adding to the count.</p>
                </div>
              )}
              {loadLog.length > 0 && (
                <div className="bg-gray-800/60 border border-gray-700 rounded-lg p-3">
                  <p className="text-gray-500 text-xs uppercase tracking-wide mb-1.5">Loads</p>
                  <div className="space-y-1.5">
                    {loadLog.map(l => (
                      <div key={l.id} className="flex items-baseline gap-2 text-sm">
                        <span className="text-white font-semibold">{l.bars} {isBlanks ? 'blanks' : 'bars'}</span>
                        <span className="text-gray-400">— {[l._loaderName, fmtTime(l.staged_at)].filter(Boolean).join(' · ')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <label className="block text-gray-400 text-sm mb-2">Material Type *</label>
                <select value={stageForm.material_type} disabled={!!stageExisting?.material_type}
                  onChange={e => setStageForm({ ...stageForm, material_type: e.target.value, bar_size: '', lot_number: '' })}
                  className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-skynet-accent focus:outline-none disabled:opacity-60">
                  <option value="">Select material…</option>
                  {materialTypes.map(mt => <option key={mt.id} value={mt.name}>{mt.name}</option>)}
                </select>
              </div>
              {!isBlanks && (
                <div>
                  <label className="block text-gray-400 text-sm mb-2">Bar Size *</label>
                  <select value={stageForm.bar_size} disabled={!!stageExisting?.bar_size}
                    onChange={e => setStageForm({ ...stageForm, bar_size: e.target.value, lot_number: '' })}
                    className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-skynet-accent focus:outline-none disabled:opacity-60">
                    <option value="">Select size…</option>
                    {barSizes.map(bs => <option key={bs.id} value={bs.size}>{bs.size}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-gray-400 text-sm mb-2">Lot # (off the bar tag)</label>
                <input list="rack-lot-list" value={stageForm.lot_number} disabled={!!stageExisting?.lot_number}
                  onChange={e => setStageForm({ ...stageForm, lot_number: e.target.value })}
                  placeholder="Scan or type the lot from the tag"
                  className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-skynet-accent focus:outline-none disabled:opacity-60" />
                <datalist id="rack-lot-list">{lotSuggestions.map(l => <option key={l.lot} value={l.lot} label={l.available_bars <= 0 ? `${l.lot} (empty — will be flagged)` : l.lot} />)}</datalist>
              </div>
              {!isBlanks && (
                <div>
                  <label className="block text-gray-400 text-sm mb-2">Bar Length (in) — optional</label>
                  <input type="number" inputMode="decimal" step="0.01" value={stageForm.bar_length}
                    disabled={!!stageExisting && stageExisting.bar_length != null}
                    onChange={e => setStageForm({ ...stageForm, bar_length: e.target.value })} placeholder="e.g. 144"
                    className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-skynet-accent focus:outline-none disabled:opacity-60" />
                </div>
              )}
              <div>
                <label className="block text-gray-400 text-sm mb-2">{isBlanks ? 'Blanks' : 'Bars'} to stage *</label>
                <input type="number" inputMode="numeric" min="1" value={stageForm.add_bars}
                  onChange={e => setStageForm({ ...stageForm, add_bars: e.target.value })} placeholder="0"
                  className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-skynet-accent focus:outline-none" />
              </div>
              <button onClick={handleStage} disabled={staging}
                className="w-full h-12 bg-skynet-accent hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2">
                {staging ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />} Stage to job
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lot mismatch */}
      {lotMismatch && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-6 z-30">
          <div className="bg-gray-900 border border-amber-700 rounded-2xl w-full max-w-sm p-5">
            <div className="flex items-center gap-2 text-amber-400 mb-3"><AlertTriangle size={20} /> <h3 className="font-semibold">Lot mismatch</h3></div>
            <p className="text-gray-300 text-sm">This job already has lot <span className="font-mono text-white">{lotMismatch.existingLot}</span>. A job can only carry one raw-material lot, so <span className="font-mono text-white">{lotMismatch.newLot}</span> can't be added.</p>
            <button onClick={() => setLotMismatch(null)} className="w-full h-11 mt-4 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors">OK</button>
          </div>
        </div>
      )}

      {toast && <Toast toast={toast} />}
    </div>
  )
}

function Toast({ toast }) {
  return (
    <div className={`fixed bottom-5 left-1/2 -translate-x-1/2 px-4 py-3 rounded-lg shadow-lg text-sm z-40 ${toast.kind === 'error' ? 'bg-red-900 text-red-100' : 'bg-green-900 text-green-100'}`}>
      {toast.msg}
    </div>
  )
}
