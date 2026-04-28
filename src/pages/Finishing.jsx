import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { uploadDocument, getDocumentUrl } from '../lib/s3'
import { buildTravelerHTML } from '../lib/traveler'
import {
  Lock,
  Unlock,
  Loader2,
  LogOut,
  Play,
  CheckCircle,
  Clock,
  AlertCircle,
  AlertTriangle,
  Package,
  Beaker,
  FileText,
  X,
  Timer,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  Droplets,
  Flame,
  Wind,
  List,
  Columns,
  Hash,
  RotateCw,
  Search,
  Paperclip,
  Upload,
  Eye,
  ExternalLink
} from 'lucide-react'

// Stage definitions
const STAGES = [
  { key: 'wash', label: 'Wash', icon: Droplets },
  { key: 'treatment', label: 'Treatment', icon: Flame },
  { key: 'dry', label: 'Dry', icon: Wind }
]

export default function Finishing() {
  // Auth state
  const [pin, setPin] = useState('')
  const [operator, setOperator] = useState(null)
  const [authError, setAuthError] = useState(null)
  const [authenticating, setAuthenticating] = useState(false)

  // Queue state
  const [queue, setQueue] = useState([])
  const [activeBatches, setActiveBatches] = useState([])
  const [recentCompletions, setRecentCompletions] = useState([])
  const [recentExpanded, setRecentExpanded] = useState(false)
  const [batchLabels, setBatchLabels] = useState({})
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)

  // Machine state
  const [finishingMachines, setFinishingMachines] = useState([])

  // Tank selection modal (shown when advancing Wash → Treatment)
  const [showTankModal, setShowTankModal] = useState(false)
  const [pendingAdvanceBatch, setPendingAdvanceBatch] = useState(null)

  // Completion state
  const [completionNotes, setCompletionNotes] = useState({})
  const [verifiedCounts, setVerifiedCounts] = useState({}) // {batchId: count}

  // Start batch modal state
  const [showStartModal, setShowStartModal] = useState(false)
  const [startModalSend, setStartModalSend] = useState(null)
  const [startLotNumber, setStartLotNumber] = useState('')
  const [startChemicalLot, setStartChemicalLot] = useState('')
  const [startChemicalLot2, setStartChemicalLot2] = useState('')
  const [startIncomingCount, setStartIncomingCount] = useState('')
  const [generatingLot, setGeneratingLot] = useState(false)

  // Start New Job (standalone batch) modal state
  const [showNewJobModal, setShowNewJobModal] = useState(false)
  const [newJobParts, setNewJobParts] = useState([])
  const [newJobMachines, setNewJobMachines] = useState([])
  const [newJobLoadingRefs, setNewJobLoadingRefs] = useState(false)
  const [newJobPartSearch, setNewJobPartSearch] = useState('')
  const [newJobForm, setNewJobForm] = useState({
    part_id: '',
    source_type: 'machine',
    source_machine_id: '',
    source_description: '',
    quantity: '',
    material_lot_number: '',
    production_lot_number: '',
    customer: '',
    operation_type: 'full_finishing',
    notes: '',
  })
  const [newJobSubmitting, setNewJobSubmitting] = useState(false)

  // Collapsed state per batch
  const [collapsedBatches, setCollapsedBatches] = useState({})

  // Queue search
  const [queueSearch, setQueueSearch] = useState('')
  const [queueExpanded, setQueueExpanded] = useState(false)

  // Document upload
  const [uploadingDoc, setUploadingDoc] = useState(null) // batch send ID
  const [batchDocuments, setBatchDocuments] = useState({}) // { sendId: [docs] }

  // Active batches view toggle
  const [activeView, setActiveView] = useState('job') // 'job' | 'station'

  // Auto-refresh
  const [lastUpdated, setLastUpdated] = useState(null)

  // Duration timer
  const [, setTick] = useState(0)
  const timerRef = useRef(null)

  const canStartNewJob = operator?.role === 'admin' || operator?.role === 'finishing'

  // Set browser tab title
  useEffect(() => {
    document.title = 'Finishing Station - SkyNet'
  }, [])

  // Duration timer - tick every 30s when active batch exists
  useEffect(() => {
    if (activeBatches.length > 0) {
      timerRef.current = setInterval(() => setTick(t => t + 1), 30000)
    } else {
      clearInterval(timerRef.current)
    }
    return () => clearInterval(timerRef.current)
  }, [activeBatches.length])

  // Load finishing machines
  const loadMachines = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('machines')
        .select('id, name, code, status, status_reason, machine_type')
        .eq('machine_type', 'finishing')
        .eq('is_active', true)

      if (error) throw error
      setFinishingMachines(data || [])
    } catch (err) {
      console.error('Error loading finishing machines:', err)
    }
  }, [])

  // Generate finishing lot number via RPC
  const generateFinishingLotNumber = async () => {
    const now = new Date()
    const datePart = now.toISOString().slice(2, 10).replace(/-/g, '') // YYMMDD
    const prefix = 'FLN'

    try {
      const { data, error } = await supabase.rpc('next_lot_number', {
        p_prefix: prefix,
        p_date_part: datePart
      })

      if (error) throw error
      const seq = String(data).padStart(4, '0')
      return `${prefix}-${datePart}-${seq}`
    } catch (err) {
      // Fallback: timestamp-based number if RPC fails
      console.error('Lot number generation failed, using fallback:', err)
      const fallback = `${prefix}-${datePart}-${now.getTime().toString().slice(-4)}`
      return fallback
    }
  }

  // Get current active finishing lot (persistence rule)
  const getCurrentFinishingLot = async () => {
    try {
      const { data } = await supabase
        .from('finishing_sends')
        .select('finishing_lot_number')
        .not('finishing_lot_number', 'is', null)
        .neq('status', 'finishing_complete')
        .order('finishing_started_at', { ascending: false })
        .limit(1)

      if (data && data.length > 0 && data[0].finishing_lot_number) {
        return data[0].finishing_lot_number
      }
      return null
    } catch {
      return null
    }
  }

  // Get most recent chemical lot number (persistence rule)
  const getCurrentChemicalLot = async () => {
    try {
      const { data } = await supabase
        .from('finishing_sends')
        .select('chemical_lot_number')
        .not('chemical_lot_number', 'is', null)
        .order('finishing_started_at', { ascending: false })
        .limit(1)

      if (data && data.length > 0 && data[0].chemical_lot_number) {
        return data[0].chemical_lot_number
      }
      return null
    } catch {
      return null
    }
  }

  // Get most recent second chemical lot number (alkaline mix) — persistence rule
  const getCurrentChemicalLot2 = async () => {
    try {
      const { data } = await supabase
        .from('finishing_sends')
        .select('chemical_lot_number_2')
        .not('chemical_lot_number_2', 'is', null)
        .order('finishing_started_at', { ascending: false })
        .limit(1)

      if (data && data.length > 0 && data[0].chemical_lot_number_2) {
        return data[0].chemical_lot_number_2
      }
      return null
    } catch {
      return null
    }
  }

  // Load parts and machines for the New Job modal — fired when modal opens.
  const loadNewJobReferences = async () => {
    setNewJobLoadingRefs(true)
    try {
      const [partsRes, machinesRes] = await Promise.all([
        supabase
          .from('parts')
          .select('id, part_number, description, customer, part_type, is_active')
          .order('part_number'),
        supabase
          .from('machines')
          .select('id, name, code')
          .eq('is_active', true)
          .order('name'),
      ])
      if (partsRes.error) throw partsRes.error
      if (machinesRes.error) throw machinesRes.error
      setNewJobParts(partsRes.data || [])
      setNewJobMachines(machinesRes.data || [])
    } catch (err) {
      console.error('Failed to load New Job references:', err)
      alert('Failed to load parts/machines list: ' + err.message)
    } finally {
      setNewJobLoadingRefs(false)
    }
  }

  const handleOpenNewJob = () => {
    setNewJobForm({
      part_id: '',
      source_type: 'machine',
      source_machine_id: '',
      source_description: '',
      quantity: '',
      material_lot_number: '',
      production_lot_number: '',
      customer: '',
      operation_type: 'full_finishing',
      notes: '',
    })
    setNewJobPartSearch('')
    setShowNewJobModal(true)
    loadNewJobReferences()
  }

  const handleCloseNewJob = () => {
    if (newJobSubmitting) return
    setShowNewJobModal(false)
  }

  const handleSubmitNewJob = async () => {
    if (!newJobForm.part_id) {
      alert('Select a part number.')
      return
    }
    if (newJobForm.source_type === 'machine' && !newJobForm.source_machine_id) {
      alert('Select a machine.')
      return
    }
    if (newJobForm.source_type === 'received' && !newJobForm.source_description.trim()) {
      alert('Enter a source description for received parts.')
      return
    }
    const qty = parseInt(newJobForm.quantity, 10)
    if (Number.isNaN(qty) || qty <= 0) {
      alert('Enter a valid quantity (must be > 0).')
      return
    }
    if (!['full_finishing', 'passivation_only'].includes(newJobForm.operation_type)) {
      alert('Select an operation type.')
      return
    }

    setNewJobSubmitting(true)
    try {
      const now = new Date().toISOString()

      // Universal FLN — no exceptions
      const fln = await generateFinishingLotNumber()

      // Generate the next J-FIN-XXXXXX number via DB function
      const { data: jobNumberRow, error: numberError } = await supabase
        .rpc('next_standalone_finishing_job_number')
      if (numberError) throw numberError
      const jobNumber = jobNumberRow

      // Customer override note — if James edited the customer field, capture in notes
      const customerOverride = newJobForm.customer.trim() || null
      let combinedNotes = newJobForm.notes.trim() || ''
      if (customerOverride) {
        const selectedPart = newJobParts.find(p => p.id === newJobForm.part_id)
        if (customerOverride !== (selectedPart?.customer || '')) {
          combinedNotes = combinedNotes
            ? `${combinedNotes}\n[Customer override: ${customerOverride}]`
            : `[Customer override: ${customerOverride}]`
        }
      }

      // Step 1 — create the J-FIN job
      const { data: createdJob, error: jobError } = await supabase
        .from('jobs')
        .insert({
          work_order_id: null,
          job_number: jobNumber,
          part_id: newJobForm.part_id,
          component_id: newJobForm.part_id,
          quantity: qty,
          good_pieces: qty,
          status: 'in_progress',
          is_standalone_finishing: true,
          notes: combinedNotes || null,
          production_lot_number: newJobForm.production_lot_number.trim() || null,
          assigned_machine_id: newJobForm.source_type === 'machine' ? newJobForm.source_machine_id : null,
          source_description: newJobForm.source_type === 'received' ? newJobForm.source_description.trim() : null,
          created_at: now,
          updated_at: now,
        })
        .select('id, job_number')
        .single()
      if (jobError) throw jobError

      // Determine starting stage
      const initialStage = newJobForm.operation_type === 'passivation_only' ? 'treatment' : 'wash'

      // Pre-fill chemical lots from persistence
      const [currentChem, currentChem2] = await Promise.all([
        getCurrentChemicalLot(),
        getCurrentChemicalLot2(),
      ])

      // Step 2 — create the finishing_send linked to the new job
      const { error: sendError } = await supabase
        .from('finishing_sends')
        .insert({
          is_standalone: true,
          standalone_operation_type: newJobForm.operation_type,
          job_id: createdJob.id,
          machine_id: newJobForm.source_type === 'machine' ? newJobForm.source_machine_id : null,
          sent_by: operator.id,
          quantity: qty,
          material_lot_number: newJobForm.material_lot_number.trim() || null,
          notes: combinedNotes || null,
          status: 'in_finishing',
          finishing_stage: initialStage,
          stage_started_at: now,
          finishing_operator_id: operator.id,
          finishing_started_at: now,
          finishing_lot_number: fln,
          chemical_lot_number: currentChem || null,
          chemical_lot_number_2: currentChem2 || null,
          incoming_count: qty,
          sent_at: now,
          created_at: now,
          updated_at: now,
        })
      if (sendError) {
        // Roll back the job we just created if the send insert fails
        await supabase.from('jobs').delete().eq('id', createdJob.id)
        throw sendError
      }

      setShowNewJobModal(false)
      await loadData()
    } catch (err) {
      console.error('Failed to create standalone batch:', err)
      alert('Failed to create batch: ' + err.message)
    } finally {
      setNewJobSubmitting(false)
    }
  }

  // Load queue and active batch
  const loadData = useCallback(async () => {
    try {
      // Fetch pending finishing sends
      const { data: pendingData, error: pendingError } = await supabase
        .from('finishing_sends')
        .select(`
          *,
          job:jobs(
            id, job_number, quantity, production_lot_number, status, work_order_assembly_id,
            is_standalone_finishing, source_description,
            work_order:work_orders(wo_number, customer, priority, due_date, order_type, notes),
            component:parts!component_id(id, part_number, description, customer, part_type),
            assigned_machine:machines!assigned_machine_id(name)
          ),
          sent_by_profile:profiles!sent_by(full_name)
        `)
        .eq('status', 'pending_finishing')
        .order('sent_at', { ascending: true })

      if (pendingError) throw pendingError
      setQueue(pendingData || [])

      // Fetch all active batches (in_finishing)
      const { data: activeData, error: activeError } = await supabase
        .from('finishing_sends')
        .select(`
          *,
          job:jobs(
            id, job_number, quantity, production_lot_number, status, work_order_assembly_id,
            is_standalone_finishing, source_description,
            work_order:work_orders(wo_number, customer, priority, due_date, order_type, notes),
            component:parts!component_id(id, part_number, description, customer, part_type),
            assigned_machine:machines!assigned_machine_id(name)
          ),
          sent_by_profile:profiles!sent_by(full_name),
          machine:machines!machine_id(id, name, code)
        `)
        .eq('status', 'in_finishing')
        .order('finishing_started_at', { ascending: true })

      if (activeError) throw activeError
      setActiveBatches(activeData || [])

      // Fetch recent completions (last 5 days)
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
      const { data: recentData } = await supabase
        .from('finishing_sends')
        .select(`
          *,
          job:jobs(
            id, job_number, is_standalone_finishing, source_description,
            work_order:work_orders(wo_number, customer),
            component:parts!component_id(part_number, description, customer),
            assigned_machine:machines!assigned_machine_id(name)
          )
        `)
        .eq('status', 'finishing_complete')
        .gte('finishing_completed_at', fiveDaysAgo)
        .order('finishing_completed_at', { ascending: false })
        .limit(50)
      setRecentCompletions(recentData || [])

      // Build batch labels (A, B, C...) for jobs with multiple sends
      const allSends = [...(pendingData || []), ...(activeData || []), ...(recentData || [])]
      const byJob = {}
      ;[...allSends].sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at))
        .forEach(send => {
          const jid = send.job_id || send.job?.id
          if (!jid) return
          if (!byJob[jid]) byJob[jid] = []
          byJob[jid].push(send.id)
        })
      const labels = {}
      Object.entries(byJob).forEach(([jobId, ids]) => {
        ids.forEach((id, i) => {
          const send = allSends.find(s => s.id === id)
          const isPartial = send?.is_partial_send === true
          if (ids.length > 1 || isPartial) {
            labels[id] = String.fromCharCode(65 + i)
          }
        })
      })
      setBatchLabels(labels)

      setLastUpdated(new Date())
    } catch (err) {
      console.error('Error loading data:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load and real-time subscription
  useEffect(() => {
    if (operator) {
      loadData()
      loadMachines()

      // Subscribe to finishing_sends changes
      const subscription = supabase
        .channel('finishing-sends')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'finishing_sends' }, loadData)
        .subscribe()

      // Refresh machines every 60 seconds
      const machineInterval = setInterval(loadMachines, 60000)
      // Refresh data every 30 seconds
      const dataInterval = setInterval(loadData, 30000)

      return () => {
        supabase.removeChannel(subscription)
        clearInterval(machineInterval)
        clearInterval(dataInterval)
      }
    }
  }, [operator, loadData, loadMachines])

  // Auto-load documents for initially-expanded batch cards
  useEffect(() => {
    activeBatches.forEach(batch => {
      const isCollapsed = !!collapsedBatches[batch.id]
      if (!isCollapsed) {
        const jobId = batch.job_id || batch.job?.id
        if (jobId) loadBatchDocuments(batch.id, jobId)
      }
    })
  }, [activeBatches])

  // Realtime: force-logout if session deactivated by another kiosk
  useEffect(() => {
    if (!operator) return

    // Get the finishing machine used for this session
    const getSessionMachineId = async () => {
      try {
        const { data } = await supabase
          .from('machines')
          .select('id')
          .eq('machine_type', 'finishing')
          .eq('is_active', true)
          .limit(1)
          .single()
        return data?.id
      } catch {
        return null
      }
    }

    let sessionSub
    getSessionMachineId().then(machineId => {
      if (!machineId) return

      sessionSub = supabase
        .channel(`finishing-session-${operator.id}`)
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'kiosk_sessions',
          filter: `operator_id=eq.${operator.id}`
        }, (payload) => {
          if (payload.new.machine_id === machineId && payload.new.is_active === false) {
            // Delay + re-check to avoid race with own login sequence
            setTimeout(async () => {
              try {
                const { data: currentSession } = await supabase
                  .from('kiosk_sessions')
                  .select('is_active')
                  .eq('operator_id', operator.id)
                  .eq('machine_id', machineId)
                  .single()

                if (!currentSession || !currentSession.is_active) {
                  handleLogout()
                }
              } catch {
                // If query fails, don't force logout
              }
            }, 500)
          }
        })
        .subscribe()
    })

    return () => {
      if (sessionSub) supabase.removeChannel(sessionSub)
    }
  }, [operator])

  // Keyboard support for PIN entry
  useEffect(() => {
    if (operator) return

    const handleKeyDown = (e) => {
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault()
        handlePinInput(e.key)
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        handlePinBackspace()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (pin.length >= 4) handlePinSubmit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        handlePinClear()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [operator, pin])

  // PIN Authentication — numpad handlers (matches Kiosk pattern)
  const handlePinInput = (digit) => {
    if (pin.length < 6) {
      setPin(prev => prev + digit)
      setAuthError(null)
    }
  }

  const handlePinBackspace = () => {
    setPin(prev => prev.slice(0, -1))
    setAuthError(null)
  }

  const handlePinClear = () => {
    setPin('')
    setAuthError(null)
  }

  const handlePinSubmit = async () => {
    if (pin.length < 4) {
      setAuthError('PIN must be at least 4 digits')
      return
    }

    setAuthenticating(true)
    setAuthError(null)

    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('pin_code', pin)
        .eq('is_active', true)
        .single()

      if (error) {
        if (error.code === 'PGRST116') setAuthError('Invalid PIN')
        else throw error
        return
      }

      // Session enforcement — deactivate all existing sessions, create finishing session
      // Admin users are exempt — they can be logged into multiple machines
      try {
        if (data.role !== 'admin') {
          await supabase
            .from('kiosk_sessions')
            .update({ is_active: false })
            .eq('operator_id', data.id)
        }

        // Use first finishing machine as session anchor
        const { data: finMachine } = await supabase
          .from('machines')
          .select('id')
          .eq('machine_type', 'finishing')
          .eq('is_active', true)
          .limit(1)
          .single()

        if (finMachine) {
          await supabase
            .from('kiosk_sessions')
            .upsert({
              operator_id: data.id,
              machine_id: finMachine.id,
              logged_in_at: new Date().toISOString(),
              is_active: true
            }, { onConflict: 'operator_id,machine_id' })
        }
      } catch (err) {
        // Session management failure must never block access
        console.error('Session management error (non-blocking):', err)
      }

      setOperator(data)
      setPin('')
    } catch (err) {
      console.error('Auth error:', err)
      setAuthError('Authentication failed')
    } finally {
      setAuthenticating(false)
    }
  }

  const handleLogout = async () => {
    // Deactivate session on logout
    if (operator) {
      try {
        await supabase
          .from('kiosk_sessions')
          .update({ is_active: false })
          .eq('operator_id', operator.id)
          .eq('is_active', true)
      } catch (err) {
        console.error('Session deactivation error (non-blocking):', err)
      }
    }

    setOperator(null)
    setActiveBatches([])
    setQueue([])
    setPin('')
    setCompletionNotes({})
    setVerifiedCounts({})
    setShowStartModal(false)
    setStartModalSend(null)
  }

  // Start batch - open start modal directly (lot # + incoming count + chemical lot)
  const handleStartBatch = async (send) => {
    setStartModalSend(send)
    setStartIncomingCount('')
    setGeneratingLot(true)
    setShowStartModal(true)

    // Pre-fill lot numbers in parallel
    const [currentLot, currentChemicalLot, currentChemicalLot2] = await Promise.all([
      getCurrentFinishingLot(),
      getCurrentChemicalLot(),
      getCurrentChemicalLot2()
    ])

    if (currentLot) {
      setStartLotNumber(currentLot)
    } else {
      const newLot = await generateFinishingLotNumber()
      setStartLotNumber(newLot)
    }
    setStartChemicalLot(currentChemicalLot || '')
    setStartChemicalLot2(currentChemicalLot2 || '')
    setGeneratingLot(false)
  }

  const handleGenerateNewLot = async () => {
    setGeneratingLot(true)
    try {
      const newLot = await generateFinishingLotNumber()
      setStartLotNumber(newLot)
    } catch (err) {
      console.error('Error generating lot:', err)
    } finally {
      setGeneratingLot(false)
    }
  }

  // Document upload handlers
  const handleDocumentUpload = async (sendId, jobId, file) => {
    setUploadingDoc(sendId)
    try {
      const s3Path = `jobs/${jobId}/finishing`
      const { filePath, fileSize, mimeType } = await uploadDocument(file, s3Path)

      const { error } = await supabase
        .from('job_documents')
        .insert({
          job_id: jobId,
          document_type_id: '644c26a8-7c13-4939-9e52-130dff278191',
          file_name: file.name,
          file_url: filePath,
          file_size: fileSize,
          mime_type: mimeType,
          status: 'approved',
          uploaded_by: operator.id,
        })

      if (error) throw error
      await loadBatchDocuments(sendId, jobId)
    } catch (err) {
      console.error('Upload error:', err)
      alert('Failed to upload: ' + err.message)
    } finally {
      setUploadingDoc(null)
    }
  }

  const loadBatchDocuments = async (sendId, jobId) => {
    const { data } = await supabase
      .from('job_documents')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })
    setBatchDocuments(prev => ({ ...prev, [sendId]: data || [] }))
  }

  const handleViewDocument = async (filePath) => {
    try {
      const signedUrl = await getDocumentUrl(filePath)
      window.open(signedUrl, '_blank')
    } catch (err) {
      alert('Failed to open document')
    }
  }

  const handleViewTraveler = async (jobId) => {
    if (!jobId) return
    try {
      const { data: fullJob, error: jobError } = await supabase
        .from('jobs')
        .select(`
          id, job_number, quantity, status,
          production_lot_number, good_pieces, actual_end,
          work_order:work_orders ( wo_number, customer, po_number, due_date, order_type, order_quantity, stock_quantity ),
          component:parts!component_id ( id, part_number, description, drawing_revision, requires_passivation, material_type:material_types ( name ) ),
          assigned_machine:machines!assigned_machine_id ( name ),
          assigned_user:profiles!assigned_user_id ( full_name )
        `)
        .eq('id', jobId)
        .single()
      if (jobError) throw jobError

      const { data: steps, error: stepsError } = await supabase
        .from('job_routing_steps')
        .select(`*, completed_by_profile:profiles!completed_by(full_name)`)
        .eq('job_id', jobId)
        .neq('status', 'removed')
        .order('step_order')
      if (stepsError) throw stepsError

      const { data: finishingBatches, error: fsError } = await supabase
        .from('finishing_sends')
        .select(`
          id, finishing_lot_number, chemical_lot_number, chemical_lot_number_2,
          material_lot_number, quantity, verified_count, compliance_good_qty, compliance_bad_qty,
          finishing_completed_at, compliance_approved_at,
          finishing_operator:profiles!finishing_operator_id(full_name)
        `)
        .eq('job_id', jobId)
        .not('finishing_completed_at', 'is', null)
        .neq('compliance_status', 'rejected')
        .order('finishing_completed_at', { ascending: false })
      if (fsError) throw fsError

      const { data: outboundSends, error: osError } = await supabase
        .from('outbound_sends')
        .select(`
          id, operation_type, vendor_name, vendor_lot_number,
          quantity, quantity_returned, sent_at, returned_at,
          job_routing_step_id, finishing_send_id,
          finishing_send:finishing_sends!finishing_send_id(id, compliance_approved_at)
        `)
        .eq('job_id', jobId)
        .order('sent_at', { ascending: true })
      if (osError) throw osError

      const html = buildTravelerHTML({
        job: fullJob,
        steps: steps || [],
        finishingBatches: finishingBatches || [],
        outboundSends: outboundSends || [],
      })
      const win = window.open('', '_blank')
      if (!win) {
        alert('Pop-up blocked. Allow pop-ups for this site to view the traveler.')
        return
      }
      win.document.open()
      win.document.write(html)
      win.document.close()
    } catch (err) {
      console.error('Failed to open traveler:', err)
      alert('Failed to open traveler: ' + err.message)
    }
  }

  const handleRemoveDocument = async (docId, sendId, jobId) => {
    if (!confirm('Remove this document?')) return
    try {
      const { error } = await supabase
        .from('job_documents')
        .delete()
        .eq('id', docId)
      if (error) throw error
      await loadBatchDocuments(sendId, jobId)
    } catch (err) {
      console.error('Remove error:', err)
      alert('Failed to remove document')
    }
  }

  // Tank selection for Wash → Treatment advance
  const handleTankSelect = async (machine) => {
    if (!pendingAdvanceBatch) return
    setShowTankModal(false)
    setActionLoading(true)

    try {
      const now = new Date().toISOString()
      const nextStage = 'treatment'
      const { error } = await supabase
        .from('finishing_sends')
        .update({
          finishing_stage: nextStage,
          stage_started_at: now,
          machine_id: machine.id,
          updated_at: now
        })
        .eq('id', pendingAdvanceBatch.id)

      if (error) throw error
      setPendingAdvanceBatch(null)
      await loadData()
    } catch (err) {
      console.error('Error advancing to treatment:', err)
      alert('Failed to advance to treatment: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  const handleConfirmStartBatch = async () => {
    if (!startModalSend) return
    const incomingCount = parseInt(startIncomingCount) || 0
    if (incomingCount <= 0) {
      alert('Please enter a valid incoming count')
      return
    }

    setActionLoading(true)
    try {
      const now = new Date().toISOString()
      const { error } = await supabase
        .from('finishing_sends')
        .update({
          status: 'in_finishing',
          finishing_stage: 'wash',
          stage_started_at: now,
          finishing_operator_id: operator.id,
          finishing_started_at: now,
          finishing_lot_number: startLotNumber || null,
          chemical_lot_number: startChemicalLot.trim() || null,
          chemical_lot_number_2: startChemicalLot2.trim() || null,
          incoming_count: incomingCount,
          updated_at: now
        })
        .eq('id', startModalSend.id)

      if (error) throw error
      setShowStartModal(false)
      setStartModalSend(null)
      setStartLotNumber('')
      setStartChemicalLot('')
      setStartChemicalLot2('')
      setStartIncomingCount('')
      await loadData()
    } catch (err) {
      console.error('Error starting batch:', err)
      alert('Failed to start batch: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  // Advance stage or complete
  const handleAdvanceStage = async (batch) => {
    if (!batch) return

    const currentStage = batch.finishing_stage
    const currentIndex = STAGES.findIndex(s => s.key === currentStage)
    const isLastStage = currentIndex === STAGES.length - 1

    // On last stage, require verified count (must be explicitly entered)
    if (isLastStage) {
      const rawValue = verifiedCounts[batch.id]
      const verifiedCount = parseInt(rawValue)
      if (rawValue == null || rawValue === '' || isNaN(verifiedCount) || verifiedCount < 0) {
        alert('Please enter a verified count before completing the batch')
        return
      }
    }

    setActionLoading(true)
    try {
      const now = new Date().toISOString()
      const batchNotes = completionNotes[batch.id] || ''

      if (isLastStage) {
        const verifiedCount = parseInt(verifiedCounts[batch.id]) || 0
        const incomingCount = batch.incoming_count || 0
        const discrepancy = verifiedCount - incomingCount

        // Complete the batch with count verification
        const { error } = await supabase
          .from('finishing_sends')
          .update({
            status: 'finishing_complete',
            finishing_completed_at: now,
            verified_count: verifiedCount,
            count_discrepancy: discrepancy,
            verified_by: operator.id,
            verified_at: now,
            notes: batchNotes || batch.notes || null,
            updated_at: now
          })
          .eq('id', batch.id)

        if (error) throw error

        // Log significant discrepancies (>5%) to audit_logs
        if (discrepancy !== 0) {
          try {
            await supabase.from('audit_logs').insert({
              event_type: 'finishing_count_discrepancy',
              job_id: batch.job_id || batch.job?.id,
              operator_id: operator.id,
              details: {
                send_id: batch.id,
                incoming_count: incomingCount,
                verified_count: verifiedCount,
                discrepancy: discrepancy
              }
            })
          } catch (auditErr) {
            console.error('Audit log insert failed (non-blocking):', auditErr)
          }
        }

        setCompletionNotes(prev => {
          const next = { ...prev }
          delete next[batch.id]
          return next
        })
        setVerifiedCounts(prev => {
          const next = { ...prev }
          delete next[batch.id]
          return next
        })

        // Copy finishing lot number to parent job
        const jobId = batch.job_id || batch.job?.id
        if (jobId && batch.finishing_lot_number) {
          try {
            await supabase
              .from('jobs')
              .update({ finishing_lot_number: batch.finishing_lot_number, updated_at: now })
              .eq('id', jobId)
          } catch (lotErr) {
            console.error('Job lot number update failed (non-blocking):', lotErr)
          }
        }

        // Each batch now independently enters compliance review when it completes finishing
        // Set compliance_status to pending_compliance on this send
        const { error: complianceError } = await supabase
          .from('finishing_sends')
          .update({
            compliance_status: 'pending_compliance',
            updated_at: now
          })
          .eq('id', batch.id)

        if (complianceError) {
          console.error('[Finishing] Failed to set compliance status:', complianceError)
        }
        // Do NOT advance the parent job status here — job status is managed by compliance approval
      } else {
        // Advance to next stage
        const nextStage = STAGES[currentIndex + 1].key

        // Wash → Treatment requires tank selection
        if (currentStage === 'wash' && nextStage === 'treatment') {
          setPendingAdvanceBatch(batch)
          setShowTankModal(true)
          setActionLoading(false)
          return
        }

        const { error } = await supabase
          .from('finishing_sends')
          .update({
            finishing_stage: nextStage,
            stage_started_at: now,
            updated_at: now
          })
          .eq('id', batch.id)

        if (error) throw error
      }

      await loadData()
    } catch (err) {
      console.error('Error advancing stage:', err)
      alert('Failed to advance stage: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  // Helpers
  const getPriorityColor = (priority) => {
    switch (priority) {
      case 'critical': return 'bg-red-500'
      case 'high': return 'bg-yellow-500'
      case 'normal': return 'bg-green-500'
      case 'low': return 'bg-gray-500'
      default: return 'bg-gray-500'
    }
  }

  const getPriorityBorder = (priority) => {
    switch (priority) {
      case 'critical': return 'border-red-600'
      case 'high': return 'border-yellow-600'
      case 'normal': return 'border-green-600'
      case 'low': return 'border-gray-600'
      default: return 'border-gray-600'
    }
  }

  const formatTime = (timestamp) => {
    if (!timestamp) return '-'
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const formatDuration = (start) => {
    if (!start) return '-'
    const startTime = new Date(start)
    const now = new Date()
    const diff = Math.floor((now - startTime) / 1000 / 60)
    const hours = Math.floor(diff / 60)
    const mins = diff % 60
    return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
  }

  const formatRelativeTime = (timestamp) => {
    if (!timestamp) return ''
    const diff = Math.floor((new Date() - new Date(timestamp)) / 1000 / 60)
    if (diff < 1) return 'Just now'
    if (diff < 60) return `${diff}m ago`
    const hours = Math.floor(diff / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.floor(hours / 24)}d ago`
  }

  const getMachineStatusDot = (status) => {
    if (['down', 'offline', 'maintenance'].includes(status)) {
      return 'bg-red-500'
    }
    return 'bg-green-500'
  }

  const isMachineDown = (status) => {
    return ['down', 'offline', 'maintenance'].includes(status)
  }

  // Filtered queue for search
  const filteredQueue = queueSearch.trim()
    ? queue.filter(send =>
        send.job?.component?.part_number?.toLowerCase().includes(queueSearch.toLowerCase()) ||
        send.job?.job_number?.toLowerCase().includes(queueSearch.toLowerCase()) ||
        send.job?.work_order?.wo_number?.toLowerCase().includes(queueSearch.toLowerCase())
      )
    : queue

  // ==================== RENDER ====================

  // PIN Entry Screen — numpad layout matching Kiosk
  if (!operator) {
    return (
      <div className="min-h-screen bg-skynet-dark flex flex-col">
        <header className="bg-gray-900 border-b border-gray-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-2xl font-bold text-white">SkyNet</span>
              <div className="w-2 h-2 bg-skynet-green rounded-full animate-pulse"></div>
            </div>
            <div className="text-right">
              <p className="text-white font-semibold">Finishing Station</p>
            </div>
          </div>
        </header>

        <div className="flex-1 flex items-center justify-center p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 w-full max-w-sm">
            <div className="text-center mb-6">
              <Lock className="w-12 h-12 text-cyan-400 mx-auto mb-3" />
              <h2 className="text-xl font-semibold text-white">Operator Login</h2>
              <p className="text-gray-500 text-sm mt-1">Enter your PIN to continue</p>
            </div>

            <div className="flex justify-center gap-2 mb-6">
              {[...Array(6)].map((_, i) => (
                <div key={i} className={`w-10 h-12 rounded-lg border-2 flex items-center justify-center text-2xl font-bold transition-colors ${i < pin.length ? 'border-cyan-500 bg-cyan-500/20 text-white' : 'border-gray-700 bg-gray-800 text-gray-600'}`}>
                  {i < pin.length ? '•' : ''}
                </div>
              ))}
            </div>

            {authError && (
              <div className="flex items-center gap-2 text-red-400 text-sm mb-4 justify-center">
                <AlertCircle size={16} />{authError}
              </div>
            )}

            <div className="grid grid-cols-3 gap-2 mb-4">
              {[1,2,3,4,5,6,7,8,9].map((digit) => (
                <button key={digit} onClick={() => handlePinInput(digit.toString())} className="h-14 bg-gray-800 hover:bg-gray-700 text-white text-xl font-semibold rounded-lg transition-colors active:scale-95">{digit}</button>
              ))}
              <button onClick={handlePinClear} className="h-14 bg-gray-800 hover:bg-gray-700 text-gray-400 text-sm font-medium rounded-lg transition-colors">Clear</button>
              <button onClick={() => handlePinInput('0')} className="h-14 bg-gray-800 hover:bg-gray-700 text-white text-xl font-semibold rounded-lg transition-colors active:scale-95">0</button>
              <button onClick={handlePinBackspace} className="h-14 bg-gray-800 hover:bg-gray-700 text-gray-400 text-sm font-medium rounded-lg transition-colors">←</button>
            </div>

            <button onClick={handlePinSubmit} disabled={pin.length < 4 || authenticating} className="w-full h-12 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2">
              {authenticating ? <><Loader2 className="w-5 h-5 animate-spin" />Verifying...</> : <><Unlock size={20} />Login</>}
            </button>
          </div>
        </div>

        <footer className="bg-gray-900 border-t border-gray-800 px-6 py-3">
          <p className="text-gray-600 text-xs text-center font-mono">SkyNet MES - Finishing Station</p>
        </footer>
      </div>
    )
  }

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-skynet-dark flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-cyan-500 animate-spin mx-auto mb-4" />
          <p className="text-gray-500">Loading finishing queue...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-skynet-dark">
      {/* Header */}
      <header className="bg-gray-900 border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-cyan-600/20 rounded-lg flex items-center justify-center">
              <Beaker size={24} className="text-cyan-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">Finishing Station</h1>
              <p className="text-gray-500 text-sm">Wash → Treatment → Dry</p>
            </div>
          </div>

          {/* Machine status strip */}
          <div className="flex items-center gap-3">
            {finishingMachines.map(m => (
              <div key={m.id} className="flex items-center gap-1.5 px-2 py-1 bg-gray-800 rounded text-xs">
                <div className={`w-2 h-2 rounded-full ${getMachineStatusDot(m.status)}`} />
                <span className={isMachineDown(m.status) ? 'text-red-400' : 'text-gray-300'}>
                  {m.name}
                </span>
                {isMachineDown(m.status) && (
                  <span className="text-red-500 font-semibold ml-1">DOWN</span>
                )}
                {isMachineDown(m.status) && m.status_reason && (
                  <span className="text-red-400/70 ml-1 max-w-[120px] truncate" title={m.status_reason}>
                    — {m.status_reason}
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center gap-4">
            {canStartNewJob && (
              <button
                onClick={handleOpenNewJob}
                className="flex items-center gap-2 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded font-medium text-sm transition-colors"
              >
                <Package size={16} />
                + Start New Job
              </button>
            )}
            {lastUpdated && (
              <span className="text-gray-500 text-xs flex items-center gap-1">
                <RefreshCw size={12} />
                Updated {lastUpdated.toLocaleTimeString()}
              </span>
            )}
            <div className="text-right">
              <p className="text-white text-sm">{operator.full_name}</p>
              <p className="text-gray-500 text-xs capitalize">{operator.role}</p>
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded transition-colors"
            >
              <LogOut size={18} />
              <span className="hidden sm:inline">Logout</span>
            </button>
          </div>
        </div>
      </header>

      <main className="p-6">
        <div className={`grid gap-6 ${activeView === 'station' && !queueExpanded ? 'grid-cols-[1fr_auto]' : 'grid-cols-1 lg:grid-cols-2'}`}>

          {/* Left Panel — Active Batches */}
          <div className="lg:col-span-1">
            <div className="bg-gray-900 rounded-lg border border-gray-800 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-cyan-400 font-semibold flex items-center gap-2">
                  <Play size={18} />
                  Active Batches ({activeBatches.length})
                </h2>
                {activeBatches.length > 0 && (
                  <div className="bg-gray-800 rounded-lg p-0.5 flex">
                    <button
                      onClick={() => setActiveView('job')}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                        activeView === 'job' ? 'bg-skynet-accent text-white' : 'text-gray-400 hover:text-white'
                      }`}
                    >
                      <List size={12} />
                      Job
                    </button>
                    <button
                      onClick={() => { setActiveView('station'); setQueueExpanded(false) }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                        activeView === 'station' ? 'bg-skynet-accent text-white' : 'text-gray-400 hover:text-white'
                      }`}
                    >
                      <Columns size={12} />
                      Station
                    </button>
                  </div>
                )}
              </div>

              {activeBatches.length > 0 ? (
                <>
                {/* Job View */}
                {activeView === 'job' && (
                <div className="space-y-4 max-h-[700px] overflow-y-auto">
                  {activeBatches.map(batch => {
                    const batchIsLastStage = batch.finishing_stage === STAGES[STAGES.length - 1].key
                    const isCollapsed = !!collapsedBatches[batch.id]
                    const currentStageDef = STAGES.find(s => s.key === batch.finishing_stage)

                    return (
                      <div key={batch.id} className="rounded-lg border border-gray-700 overflow-hidden">
                        {/* Collapsed header — always visible, clickable */}
                        <button
                          onClick={() => {
                            const wasCollapsed = !!collapsedBatches[batch.id]
                            setCollapsedBatches(prev => ({ ...prev, [batch.id]: !prev[batch.id] }))
                            if (wasCollapsed) {
                              const jobId = batch.job_id || batch.job?.id
                              if (jobId) loadBatchDocuments(batch.id, jobId)
                            }
                          }}
                          className={`w-full flex items-center gap-3 px-4 py-3 bg-gray-800 hover:bg-gray-750 transition-colors text-left border-l-4 ${getPriorityBorder(batch.job?.work_order?.priority)}`}
                        >
                          <ChevronDown size={16} className={`text-gray-500 flex-shrink-0 transition-transform ${isCollapsed ? '-rotate-90' : 'rotate-0'}`} />
                          <span className="text-white font-mono">{batch.job?.job_number || 'No Job #'}</span>
                          {batch.is_standalone && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-cyan-900/30 text-cyan-300 border border-cyan-700 rounded text-xs">
                              <Package size={10} />
                              Standalone
                            </span>
                          )}
                          {batchLabels[batch.id] && (
                            <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-cyan-900/50 text-cyan-300">Batch {batchLabels[batch.id]}</span>
                          )}
                          <span className="text-gray-400 text-sm truncate">{batch.job?.component?.part_number} — {batch.job?.component?.description}</span>
                          <span className="ml-auto flex items-center gap-2 flex-shrink-0">
                            <span className="px-2 py-0.5 rounded text-xs font-medium bg-cyan-600 text-white flex items-center gap-1">
                              {currentStageDef && <currentStageDef.icon size={10} />}
                              {currentStageDef?.label}
                            </span>
                            {batch.finishing_stage === 'treatment' && batch.machine?.name && (
                              <span className="text-xs text-gray-500">{batch.machine.name}</span>
                            )}
                            <span className="text-gray-400 text-sm font-mono flex items-center gap-1">
                              <Timer size={12} className="text-cyan-400" />
                              {formatDuration(batch.finishing_started_at)}
                            </span>
                          </span>
                        </button>

                        {/* Expanded content */}
                        {!isCollapsed && (
                          <div className="space-y-3 p-4">
                            {/* Batch Details */}
                            <div className={`bg-gray-800 rounded-lg p-4 border-l-4 ${getPriorityBorder(batch.job?.work_order?.priority)}`}>
                              <div className="flex items-start justify-between mb-2">
                                <div>
                                  <p className="text-white font-mono text-lg flex items-center gap-2">
                                    {batch.job?.job_number || 'No Job #'}
                                    {batch.is_standalone && (
                                      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-cyan-900/30 text-cyan-300 border border-cyan-700 rounded text-xs">
                                        <Package size={10} />
                                        Standalone
                                      </span>
                                    )}
                                    {batchLabels[batch.id] && (
                                      <span className="ml-2 px-2 py-0.5 rounded text-sm font-medium bg-cyan-900/50 text-cyan-300">Batch {batchLabels[batch.id]}</span>
                                    )}
                                  </p>
                                  <p className="text-gray-400 text-sm">
                                    {batch.job?.work_order?.wo_number || (batch.is_standalone
                                      ? (() => {
                                          const machine = batch.machine?.name || batch.job?.assigned_machine?.name
                                          if (machine) return `Source: ${machine}`
                                          if (batch.job?.source_description) return `Source: Received (${batch.job.source_description})`
                                          return 'Source: Received'
                                        })()
                                      : '')}
                                  </p>
                                </div>
                                <div className={`w-3 h-3 rounded-full ${getPriorityColor(batch.job?.work_order?.priority)}`}
                                     title={batch.job?.work_order?.priority} />
                              </div>

                              <div className="grid grid-cols-2 gap-4 mt-4">
                                <div>
                                  <p className="text-gray-500 text-xs">Part</p>
                                  <p className="text-white">{batch.job?.component?.part_number}</p>
                                  <p className="text-gray-400 text-sm">{batch.job?.component?.description}</p>
                                </div>
                                <div>
                                  <p className="text-gray-500 text-xs">Customer</p>
                                  <p className="text-white">{batch.job?.work_order?.customer || batch.job?.component?.customer || '-'}</p>
                                </div>
                              </div>

                              <div className="grid grid-cols-2 gap-4 mt-4">
                                <div>
                                  <p className="text-gray-500 text-xs">Batch Quantity</p>
                                  <p className="text-white text-xl">{batch.quantity}</p>
                                </div>
                                <div>
                                  <p className="text-gray-500 text-xs">Due Date</p>
                                  <p className="text-white">
                                    {batch.job?.work_order?.due_date
                                      ? new Date(batch.job.work_order.due_date).toLocaleDateString()
                                      : '-'}
                                  </p>
                                </div>
                              </div>

                              <div className="grid grid-cols-2 gap-4 mt-4">
                                <div>
                                  <p className="text-gray-500 text-xs">Production Lot #</p>
                                  <p className="text-white font-mono text-sm">{batch.production_lot_number || batch.job?.production_lot_number || '-'}</p>
                                </div>
                                <div>
                                  <p className="text-gray-500 text-xs">Finishing Lot #</p>
                                  <p className="text-cyan-400 font-mono text-sm">{batch.finishing_lot_number || <span className="text-gray-600">Not assigned</span>}</p>
                                </div>
                              </div>

                              <div className="grid grid-cols-2 gap-4 mt-4">
                                <div>
                                  <p className="text-gray-500 text-xs">Citric Acid Lot #</p>
                                  <p className="text-white font-mono text-sm">{batch.chemical_lot_number || <span className="text-gray-600">&mdash;</span>}</p>
                                </div>
                                <div>
                                  <p className="text-gray-500 text-xs">Alkaline Mix Lot #</p>
                                  <p className="text-white font-mono text-sm">{batch.chemical_lot_number_2 || <span className="text-gray-600">&mdash;</span>}</p>
                                </div>
                              </div>
                              <div className="grid grid-cols-2 gap-4 mt-4">
                                <div>
                                  <p className="text-gray-500 text-xs">Material Lot #</p>
                                  <p className="text-white font-mono text-sm">{batch.material_lot_number || '-'}</p>
                                </div>
                              </div>

                              <div className="grid grid-cols-2 gap-4 mt-4">
                                <div>
                                  <p className="text-gray-500 text-xs">Incoming Count</p>
                                  <p className="text-white text-sm">
                                    {batch.incoming_count != null ? batch.incoming_count : '-'}
                                    {batch.incoming_count != null && batch.incoming_count !== batch.quantity && (
                                      <span className="text-yellow-400 text-xs ml-1">(sent: {batch.quantity})</span>
                                    )}
                                  </p>
                                </div>
                              </div>

                              <div className="mt-4 pt-3 border-t border-gray-700">
                                <p className="text-gray-500 text-xs">
                                  Sent by <span className="text-gray-300">{batch.sent_by_profile?.full_name || 'Unknown'}</span>
                                  {batch.sent_at && (
                                    <span className="ml-2">
                                      {new Date(batch.sent_at).toLocaleString('en-US', {
                                        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                                      })}
                                    </span>
                                  )}
                                </p>
                              </div>
                            </div>

                            {/* Stage Progress Bar */}
                            <div className="bg-gray-800 rounded-lg p-4">
                              <p className="text-gray-500 text-xs mb-3">Stage Progress</p>
                              <div className="flex items-center gap-2">
                                {STAGES.map((stage, idx) => {
                                  const currentIdx = STAGES.findIndex(s => s.key === batch.finishing_stage)
                                  const isComplete = idx < currentIdx
                                  const isCurrent = idx === currentIdx
                                  const StageIcon = stage.icon

                                  return (
                                    <div key={stage.key} className="flex items-center flex-1">
                                      <div className={`flex items-center gap-1.5 px-3 py-2 rounded flex-1 justify-center text-sm font-medium transition-colors ${
                                        isCurrent
                                          ? 'bg-cyan-600 text-white'
                                          : isComplete
                                            ? 'bg-cyan-900/50 text-cyan-400'
                                            : 'bg-gray-700 text-gray-500'
                                      }`}>
                                        {isComplete ? (
                                          <CheckCircle size={14} />
                                        ) : (
                                          <StageIcon size={14} />
                                        )}
                                        {stage.label}
                                      </div>
                                      {idx < STAGES.length - 1 && (
                                        <ChevronRight size={16} className="text-gray-600 mx-1 flex-shrink-0" />
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            </div>

                            {/* Time Tracking */}
                            <div className="grid grid-cols-2 gap-4">
                              <div className="bg-gray-800 rounded-lg p-4">
                                <p className="text-gray-500 text-xs mb-1">Started</p>
                                <p className="text-cyan-400 text-lg font-mono">
                                  {formatTime(batch.finishing_started_at)}
                                </p>
                              </div>
                              <div className="bg-gray-800 rounded-lg p-4">
                                <p className="text-gray-500 text-xs mb-1">Duration</p>
                                <p className="text-white text-lg font-mono flex items-center gap-2">
                                  <Timer size={16} className="text-cyan-400" />
                                  {formatDuration(batch.finishing_started_at)}
                                </p>
                              </div>
                            </div>

                            {/* Job Traveler — live, generated on demand */}
                            <div className="bg-gray-800 rounded-lg p-4 mb-3">
                              <p className="text-gray-400 text-sm flex items-center gap-1.5 mb-2">
                                <FileText size={14} />
                                Job Traveler
                              </p>
                              <button
                                onClick={() => handleViewTraveler(batch.job_id || batch.job?.id)}
                                className="w-full flex items-center gap-3 px-3 py-2.5 bg-cyan-900/30 hover:bg-cyan-900/50 border border-cyan-700/50 rounded-lg transition-colors text-left group"
                              >
                                <div className="w-8 h-8 rounded bg-cyan-800/50 flex items-center justify-center flex-shrink-0">
                                  <FileText size={16} className="text-cyan-300" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-white text-sm truncate group-hover:text-cyan-300 transition-colors">
                                    Job Traveler
                                  </p>
                                  <p className="text-gray-400 text-xs truncate">Live — reflects current routing & job data</p>
                                </div>
                                <ExternalLink size={14} className="text-gray-500 group-hover:text-cyan-300 transition-colors flex-shrink-0" />
                              </button>
                            </div>

                            {/* Documents Section */}
                            <div className="bg-gray-800 rounded-lg p-4">
                              <div className="flex items-center justify-between mb-2">
                                <p className="text-gray-400 text-sm flex items-center gap-1.5">
                                  <Paperclip size={14} />
                                  Job Documents {batchDocuments[batch.id]?.length > 0 && `(${batchDocuments[batch.id].length})`}
                                  <span className="text-gray-600 text-xs font-normal ml-1">shared across all batches for this job</span>
                                </p>
                                <label className="flex items-center gap-1 px-2 py-1 text-xs bg-cyan-600 hover:bg-cyan-500 text-white rounded cursor-pointer transition-colors">
                                  {uploadingDoc === batch.id ? (
                                    <Loader2 size={12} className="animate-spin" />
                                  ) : (
                                    <Upload size={12} />
                                  )}
                                  {uploadingDoc === batch.id ? 'Uploading...' : 'Upload'}
                                  <input
                                    type="file"
                                    className="hidden"
                                    accept=".pdf,.jpg,.jpeg,.png"
                                    onChange={(e) => {
                                      const file = e.target.files[0]
                                      if (file) {
                                        const jobId = batch.job_id || batch.job?.id
                                        if (jobId) handleDocumentUpload(batch.id, jobId, file)
                                      }
                                      e.target.value = ''
                                    }}
                                    disabled={uploadingDoc === batch.id}
                                  />
                                </label>
                              </div>
                              {batchDocuments[batch.id]?.length > 0 && (
                                <p className="text-gray-600 text-xs mb-1">Removing a document removes it for all batches of this job.</p>
                              )}
                              {(!batchDocuments[batch.id] || batchDocuments[batch.id].length === 0) ? (
                                <p className="text-gray-600 text-xs">No documents uploaded yet</p>
                              ) : (
                                <div className="space-y-1.5">
                                  {batchDocuments[batch.id].map(doc => (
                                    <div key={doc.id} className="flex items-center justify-between bg-gray-900 rounded px-3 py-2">
                                      <span className="text-gray-300 text-xs truncate mr-2">{doc.file_name}</span>
                                      <div className="flex items-center gap-1.5 flex-shrink-0">
                                        <button
                                          onClick={() => handleViewDocument(doc.file_url)}
                                          className="flex items-center gap-1 px-2 py-0.5 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded"
                                        >
                                          <Eye size={10} />
                                          View
                                        </button>
                                        <button
                                          onClick={() => handleRemoveDocument(doc.id, batch.id, batch.job_id || batch.job?.id)}
                                          className="px-2 py-0.5 text-xs bg-red-900/40 hover:bg-red-900/70 text-red-400 rounded transition-colors"
                                        >
                                          Remove
                                        </button>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>

                            {/* Verified count + Completion notes - shown on last stage */}
                            {batchIsLastStage && (
                              <div className="space-y-3">
                                <div>
                                  <label className="block text-gray-400 text-sm mb-2">
                                    <Hash size={14} className="inline mr-1" />
                                    Verified Count <span className="text-red-400">*</span>
                                  </label>
                                  <p className="text-gray-600 text-xs mb-2">Count of good parts after finishing.</p>
                                  <input
                                    type="number"
                                    min="0"
                                    value={verifiedCounts[batch.id] ?? ''}
                                    onChange={(e) => setVerifiedCounts(prev => ({ ...prev, [batch.id]: e.target.value }))}
                                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:border-cyan-500 focus:outline-none"
                                    placeholder="Enter verified count"
                                  />
                                  {(() => {
                                    const vc = parseInt(verifiedCounts[batch.id])
                                    const ic = batch.incoming_count || 0
                                    if (verifiedCounts[batch.id] != null && verifiedCounts[batch.id] !== '' && !isNaN(vc) && vc !== ic) {
                                      return (
                                        <div className="flex items-center gap-1.5 text-yellow-400 text-xs mt-2">
                                          <AlertTriangle size={12} />
                                          Count differs from incoming ({ic} pcs). Discrepancy of {Math.abs(vc - ic)} pcs will be logged.
                                        </div>
                                      )
                                    }
                                    return null
                                  })()}
                                </div>
                                <div>
                                  <label className="block text-gray-400 text-sm mb-2">
                                    <FileText size={14} className="inline mr-1" />
                                    Completion Notes (Optional)
                                  </label>
                                  <textarea
                                    value={completionNotes[batch.id] || ''}
                                    onChange={(e) => setCompletionNotes(prev => ({ ...prev, [batch.id]: e.target.value }))}
                                    placeholder="Any observations or issues during processing..."
                                    rows={2}
                                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white placeholder-gray-500 focus:border-cyan-500 focus:outline-none"
                                  />
                                </div>
                              </div>
                            )}

                            {/* Advance / Complete Button */}
                            <button
                              onClick={() => handleAdvanceStage(batch)}
                              disabled={actionLoading}
                              className="w-full py-3 bg-green-600 hover:bg-green-500 text-white rounded-lg font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                            >
                              {actionLoading ? (
                                <Loader2 className="animate-spin" size={20} />
                              ) : batchIsLastStage ? (
                                <CheckCircle size={20} />
                              ) : (
                                <ArrowRight size={20} />
                              )}
                              {batchIsLastStage ? 'Complete Batch' : `Advance to ${STAGES[STAGES.findIndex(s => s.key === batch.finishing_stage) + 1]?.label}`}
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                )}

                {/* Station View */}
                {activeView === 'station' && (() => {
                  const washBatches = activeBatches.filter(b => b.finishing_stage === 'wash')
                  const treatmentBatches = activeBatches.filter(b => b.finishing_stage === 'treatment')
                  const dryBatches = activeBatches.filter(b => b.finishing_stage === 'dry')
                  const unassignedTreatment = treatmentBatches.filter(b => !b.machine_id)
                  const treatmentColumns = finishingMachines.map(m => ({
                    key: m.id,
                    label: `Treatment — ${m.name.replace('Finishing ', '')}`,
                    batches: treatmentBatches.filter(b => b.machine_id === m.id)
                  }))
                  if (unassignedTreatment.length > 0) {
                    treatmentColumns.push({ key: 'unassigned', label: 'Treatment — Unassigned', batches: unassignedTreatment })
                  }
                  const totalCols = 2 + treatmentColumns.length // Wash + treatment cols + Dry
                  const gridClass = totalCols <= 3 ? 'grid-cols-3' : totalCols === 4 ? 'grid-cols-4' : `grid-cols-${totalCols}`

                  const renderBatchCard = (batch) => (
                    <div key={batch.id} className={`bg-gray-900 rounded p-3 border-l-2 ${getPriorityBorder(batch.job?.work_order?.priority)}`}>
                      <p className="text-white font-mono text-sm flex items-center gap-1">
                        {batch.job?.job_number || 'No Job #'}
                        {batch.is_standalone && (
                          <span className="inline-flex items-center gap-0.5 px-1 py-0.5 bg-cyan-900/30 text-cyan-300 border border-cyan-700 rounded text-[10px]">
                            <Package size={8} />
                          </span>
                        )}
                        {batchLabels[batch.id] && (
                          <span className="ml-1 px-1 py-0.5 rounded text-xs font-medium bg-cyan-900/50 text-cyan-300">{batchLabels[batch.id]}</span>
                        )}
                      </p>
                      <p className="text-gray-400 text-xs truncate">{batch.job?.component?.part_number}</p>
                      <div className="flex items-center justify-between mt-2">
                        <span className="text-white text-sm">Qty: {batch.quantity}</span>
                        <span className="text-gray-400 text-xs font-mono flex items-center gap-1">
                          <Timer size={10} className="text-cyan-400" />
                          {formatDuration(batch.finishing_started_at)}
                        </span>
                      </div>
                    </div>
                  )

                  const renderColumn = (key, icon, label, batches, emptyLabel) => (
                    <div key={key} className="bg-gray-800 rounded-lg overflow-hidden">
                      <div className="px-3 py-2 border-b border-gray-700 flex items-center gap-2">
                        {icon}
                        <span className="text-white text-sm font-medium truncate">{label}</span>
                        <span className="ml-auto text-xs bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded flex-shrink-0">{batches.length}</span>
                      </div>
                      <div className="p-2 space-y-2 min-h-[100px]">
                        {batches.length > 0 ? batches.map(renderBatchCard) : (
                          <div className="flex items-center justify-center h-full min-h-[80px]">
                            <p className="text-gray-600 text-xs">Nothing in {emptyLabel}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )

                  return (
                  <div>
                    <div className={`grid ${gridClass} gap-3`}>
                      {renderColumn('wash', <Droplets size={14} className="text-cyan-400" />, 'Wash', washBatches, 'Wash')}
                      {treatmentColumns.map(col =>
                        renderColumn(col.key, <Flame size={14} className="text-cyan-400" />, col.label, col.batches, col.label)
                      )}
                      {renderColumn('dry', <Wind size={14} className="text-cyan-400" />, 'Dry', dryBatches, 'Dry')}
                    </div>
                    <p className="text-gray-600 text-xs text-center mt-3">Switch to Job view to advance stages</p>
                  </div>
                  )
                })()}
                </>
              ) : (
                <div className="text-center py-12">
                  <div className="w-16 h-16 bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Beaker size={32} className="text-gray-600" />
                  </div>
                  <p className="text-gray-500">No active batches</p>
                  <p className="text-gray-600 text-sm mt-1">Select from queue to begin</p>
                </div>
              )}
            </div>
          </div>

          {/* Right Panel — Incoming Queue */}
          {activeView === 'station' && !queueExpanded ? (
            <div className="w-48 space-y-3">
              <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 flex flex-col items-center gap-2">
                <Package size={18} className="text-gray-400" />
                <span className="text-white font-semibold text-sm">Queue</span>
                <span className="text-2xl font-bold text-cyan-400">{queue.length}</span>
                <span className="text-gray-500 text-xs">pending</span>
                <button
                  onClick={() => setQueueExpanded(true)}
                  className="text-gray-500 hover:text-white text-xs mt-2 flex items-center gap-1"
                >
                  View all <ChevronRight size={12} />
                </button>
              </div>
              <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 flex flex-col items-center gap-2">
                <CheckCircle size={16} className="text-green-500" />
                <span className="text-gray-400 text-xs">Completed</span>
                <span className="text-lg font-bold text-green-400">{recentCompletions.length}</span>
                <span className="text-gray-600 text-xs">last 5 days</span>
              </div>
            </div>
          ) : (
          <div className="lg:col-span-1">
            <div className="bg-gray-900 rounded-lg border border-gray-800 p-6">
              <h2 className="text-white font-semibold mb-4 flex items-center gap-2">
                <Package size={18} className="text-gray-400" />
                Incoming Queue
                <span className="ml-auto text-gray-500 text-sm">
                  {queueSearch.trim() ? `${filteredQueue.length} of ${queue.length}` : queue.length} batches
                </span>
                {activeView === 'station' && (
                  <button
                    onClick={() => setQueueExpanded(false)}
                    className="text-gray-500 hover:text-white ml-2"
                    title="Collapse queue"
                  >
                    <X size={16} />
                  </button>
                )}
              </h2>

              {/* Queue Search */}
              <div className="relative mb-4">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                <input
                  type="text"
                  value={queueSearch}
                  onChange={(e) => setQueueSearch(e.target.value)}
                  placeholder="Search by part #, job #, or WO..."
                  className="w-full pl-9 pr-8 py-2 bg-gray-800 border border-gray-700 rounded text-white placeholder-gray-500 text-sm focus:border-cyan-500 focus:outline-none"
                />
                {queueSearch && (
                  <button
                    onClick={() => setQueueSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              {queue.length === 0 ? (
                <div className="text-center py-12">
                  <CheckCircle size={48} className="text-green-500/50 mx-auto mb-4" />
                  <p className="text-gray-500">All caught up</p>
                  <p className="text-gray-600 text-sm">No batches waiting for finishing</p>
                </div>
              ) : filteredQueue.length === 0 ? (
                <div className="text-center py-8">
                  <Search size={32} className="text-gray-600 mx-auto mb-3" />
                  <p className="text-gray-500">No batches matching '{queueSearch}'</p>
                  <button
                    onClick={() => setQueueSearch('')}
                    className="text-cyan-400 hover:text-cyan-300 text-sm mt-2"
                  >
                    Clear search
                  </button>
                </div>
              ) : (
                <div className="space-y-3 max-h-[600px] overflow-y-auto">
                  {filteredQueue.map(send => (
                    <div
                      key={send.id}
                      className={`bg-gray-800 rounded-lg p-4 border-l-4 ${getPriorityBorder(send.job?.work_order?.priority)} hover:bg-gray-750 transition-colors`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <p className="text-white font-mono">{send.job?.job_number}</p>
                            {batchLabels[send.id] && (
                              <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-cyan-900/50 text-cyan-300">Batch {batchLabels[send.id]}</span>
                            )}
                            <div className={`w-2 h-2 rounded-full ${getPriorityColor(send.job?.work_order?.priority)}`} />
                            {send.job?.work_order?.priority === 'critical' && (
                              <span className="text-xs bg-red-900/50 text-red-300 border border-red-700 px-1.5 py-0.5 rounded">
                                Critical
                              </span>
                            )}
                            {send.job?.work_order?.priority === 'high' && (
                              <span className="text-xs bg-yellow-900/50 text-yellow-300 border border-yellow-700 px-1.5 py-0.5 rounded">
                                High
                              </span>
                            )}
                          </div>
                          <p className="text-cyan-400 text-sm">{send.job?.component?.part_number}</p>
                          <p className="text-gray-500 text-xs">
                            {send.job?.work_order?.wo_number} • {send.job?.work_order?.customer || '-'}
                          </p>
                          <div className="flex items-center gap-4 mt-2">
                            <span className="text-white text-sm">Qty: {send.quantity}</span>
                            {send.sent_at && (
                              <span className="text-gray-500 text-xs flex items-center gap-1">
                                <Clock size={10} />
                                Sent {formatRelativeTime(send.sent_at)}
                              </span>
                            )}
                          </div>
                        </div>

                        <button
                          onClick={() => handleStartBatch(send)}
                          disabled={actionLoading}
                          className="px-4 py-2 rounded font-medium transition-colors flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-50"
                        >
                          {actionLoading ? (
                            <Loader2 className="animate-spin" size={16} />
                          ) : (
                            <Play size={16} />
                          )}
                          Start
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Recent Completions */}
            <div className="bg-gray-900 rounded-lg border border-gray-800 mt-4">
              <div
                className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-800/50 transition-colors"
                onClick={() => setRecentExpanded(prev => !prev)}
              >
                <div className="flex items-center gap-2">
                  <CheckCircle size={16} className="text-green-500" />
                  <span className="text-white font-semibold text-sm">Recent Completions</span>
                  <span className="text-gray-500 text-xs">Last 5 days</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-gray-400 text-sm">{recentCompletions.length}</span>
                  {recentExpanded
                    ? <ChevronDown size={16} className="text-gray-400" />
                    : <ChevronRight size={16} className="text-gray-400" />
                  }
                </div>
              </div>

              {recentExpanded && (
                <div className="border-t border-gray-800 divide-y divide-gray-800 max-h-96 overflow-y-auto">
                  {recentCompletions.length === 0 ? (
                    <p className="text-gray-500 text-sm text-center py-6">No completions in the last 5 days</p>
                  ) : (
                    recentCompletions.map(send => (
                      <div key={send.id} className="px-4 py-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-white text-sm font-mono">
                              {send.job?.job_number}
                              {batchLabels[send.id] && (
                                <span className="ml-1.5 px-1 py-0.5 rounded text-xs font-medium bg-cyan-900/50 text-cyan-300">{batchLabels[send.id]}</span>
                              )}
                            </p>
                            <p className="text-cyan-400 text-xs">{send.job?.component?.part_number}</p>
                            <p className="text-gray-500 text-xs">{send.job?.work_order?.wo_number} · {send.job?.work_order?.customer}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-white text-sm">{send.verified_count ?? send.quantity} pcs</p>
                            <p className="text-gray-500 text-xs">
                              {new Date(send.finishing_completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                            </p>
                            {send.finishing_lot_number && (
                              <p className="text-gray-600 text-xs font-mono">{send.finishing_lot_number}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
          )}
        </div>
      </main>

      {/* Start Batch Modal */}
      {showStartModal && startModalSend && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-md">
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <h3 className="text-white font-semibold flex items-center gap-2">
                <Play size={20} className="text-cyan-400" />
                Start Batch
              </h3>
              <button
                onClick={() => { setShowStartModal(false); setStartModalSend(null) }}
                className="text-gray-400 hover:text-white"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Batch summary */}
              <div className="bg-gray-800 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-mono">{startModalSend.job?.job_number}</span>
                    {batchLabels[startModalSend.id] && (
                      <span className="text-xs px-1.5 py-0.5 bg-cyan-900/50 text-cyan-400
                                       border border-cyan-700 rounded font-mono">
                        Batch {batchLabels[startModalSend.id]}
                      </span>
                    )}
                  </div>
                  <span className="text-gray-400 text-sm">Qty: {startModalSend.quantity}</span>
                </div>
                <p className="text-cyan-400 text-sm">{startModalSend.job?.component?.part_number}</p>
                <p className="text-gray-500 text-xs">{startModalSend.job?.component?.description}</p>
              </div>

              {/* Finishing Lot # */}
              <div>
                <label className="block text-gray-400 text-sm mb-1">
                  <Hash size={14} className="inline mr-1" />
                  Finishing Lot #
                </label>
                <p className="text-gray-600 text-xs mb-2">Auto-filled from current lot. Change if material or chemicals have changed.</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={startLotNumber}
                    onChange={(e) => setStartLotNumber(e.target.value)}
                    className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-cyan-400 font-mono focus:border-cyan-500 focus:outline-none"
                    placeholder={generatingLot ? 'Generating...' : 'FLN-YYMMDD-XXXX'}
                    disabled={generatingLot}
                  />
                  <button
                    onClick={handleGenerateNewLot}
                    disabled={generatingLot}
                    className="px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-400 hover:text-white transition-colors flex items-center gap-1 text-sm disabled:opacity-50"
                    title="Generate new lot number"
                  >
                    <RotateCw size={14} className={generatingLot ? 'animate-spin' : ''} />
                    New
                  </button>
                </div>
              </div>

              {/* Chemical Lots — citric acid + alkaline mix */}
              <div className="space-y-3">
                <div>
                  <label className="block text-gray-400 text-sm mb-1">
                    <Beaker size={14} className="inline mr-1" />
                    Citric Acid Lot #
                  </label>
                  <p className="text-gray-600 text-xs mb-2">Lot from citric acid container</p>
                  <input
                    type="text"
                    value={startChemicalLot}
                    onChange={(e) => setStartChemicalLot(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white font-mono focus:border-cyan-500 focus:outline-none"
                    placeholder="Enter citric acid lot"
                  />
                  {!startChemicalLot.trim() && (
                    <p className="text-yellow-500/70 text-xs mt-1">Required for compliance records</p>
                  )}
                </div>

                <div>
                  <label className="block text-gray-400 text-sm mb-1">
                    <Beaker size={14} className="inline mr-1" />
                    Alkaline Mix Lot #
                  </label>
                  <p className="text-gray-600 text-xs mb-2">Lot from alkaline mix container</p>
                  <input
                    type="text"
                    value={startChemicalLot2}
                    onChange={(e) => setStartChemicalLot2(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white font-mono focus:border-cyan-500 focus:outline-none"
                    placeholder="Enter alkaline mix lot"
                  />
                  {!startChemicalLot2.trim() && (
                    <p className="text-yellow-500/70 text-xs mt-1">Required for compliance records</p>
                  )}
                </div>

                <div className="text-xs text-gray-500 italic flex items-start gap-1.5 pt-1">
                  <AlertTriangle size={12} className="mt-0.5 flex-shrink-0 text-cyan-400" />
                  <span>If either chemical lot has changed since the last batch, click "New" above to generate a fresh Finishing Lot #.</span>
                </div>
              </div>

              {/* Incoming Count */}
              <div>
                <label className="block text-gray-400 text-sm mb-1">
                  <Package size={14} className="inline mr-1" />
                  Incoming Count <span className="text-red-400">*</span>
                </label>
                <p className="text-gray-600 text-xs mb-2">Count the parts physically in front of you.</p>
                <input
                  type="number"
                  min="0"
                  value={startIncomingCount}
                  onChange={(e) => setStartIncomingCount(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:border-cyan-500 focus:outline-none"
                  placeholder="Enter count"
                />
                {(() => {
                  const ic = parseInt(startIncomingCount)
                  if (!isNaN(ic) && ic !== startModalSend.quantity) {
                    return (
                      <div className="flex items-center gap-1.5 text-yellow-400 text-xs mt-2">
                        <AlertTriangle size={12} />
                        Count differs from machinist's send quantity ({startModalSend.quantity} pcs). Discrepancy will be logged.
                      </div>
                    )
                  }
                  return null
                })()}
              </div>

              {/* Confirm button */}
              <button
                onClick={handleConfirmStartBatch}
                disabled={actionLoading || !startIncomingCount || parseInt(startIncomingCount) <= 0}
                className="w-full py-3 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg font-semibold transition-colors flex items-center justify-center gap-2"
              >
                {actionLoading ? (
                  <Loader2 className="animate-spin" size={20} />
                ) : (
                  <Play size={20} />
                )}
                Start Batch
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Start New Job (Standalone Batch) Modal */}
      {showNewJobModal && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4"
          onClick={handleCloseNewJob}
        >
          <div
            className="bg-gray-900 rounded-lg border border-gray-700 p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-white flex items-center gap-2">
                  <Package size={20} className="text-cyan-400" />
                  Start New Finishing Batch
                </h3>
                <p className="text-sm text-gray-400 mt-1">
                  Manually log a batch arriving at finishing without a SkyNet kiosk send (purchased parts from Betty, parts from non-Mazak-5 machines, etc.)
                </p>
              </div>
              <button
                onClick={handleCloseNewJob}
                disabled={newJobSubmitting}
                className="text-gray-500 hover:text-white disabled:opacity-50"
              >
                <X size={20} />
              </button>
            </div>

            {newJobLoadingRefs ? (
              <div className="flex items-center justify-center py-12 text-gray-400">
                <Loader2 size={20} className="animate-spin mr-2" />
                Loading parts and machines...
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-gray-400 text-sm mb-1">
                    Part Number <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={newJobPartSearch}
                    onChange={(e) => setNewJobPartSearch(e.target.value)}
                    placeholder="Type to search parts..."
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:border-cyan-500 focus:outline-none"
                  />
                  {newJobPartSearch.trim().length > 0 && (
                    <div className="mt-1 max-h-48 overflow-y-auto bg-gray-800 border border-gray-700 rounded">
                      {newJobParts
                        .filter(p => {
                          const q = newJobPartSearch.toLowerCase()
                          return (
                            p.part_number.toLowerCase().includes(q) ||
                            (p.description || '').toLowerCase().includes(q) ||
                            (p.customer || '').toLowerCase().includes(q)
                          )
                        })
                        .slice(0, 50)
                        .map(p => (
                          <button
                            key={p.id}
                            type="button"
                            disabled={!p.is_active}
                            title={!p.is_active ? 'Pending master data — needs compliance to activate before scheduling' : undefined}
                            onClick={() => {
                              if (!p.is_active) return
                              // Auto-populate customer from the part record. James can still override if needed.
                              setNewJobForm(f => ({ ...f, part_id: p.id, customer: p.customer || f.customer }))
                              setNewJobPartSearch(`${p.part_number} — ${p.description || ''}`)
                            }}
                            className={`w-full text-left px-3 py-2 border-b border-gray-700 last:border-0 ${
                              !p.is_active
                                ? 'opacity-50 cursor-not-allowed bg-amber-900/10'
                                : `hover:bg-gray-700 ${newJobForm.part_id === p.id ? 'bg-cyan-900/40' : ''}`
                            }`}
                          >
                            <div className={`text-sm font-mono ${p.is_active ? 'text-white' : 'text-gray-400'}`}>
                              {p.part_number}
                              {!p.is_active && (
                                <span className="ml-2 text-xs px-1.5 py-0.5 bg-amber-900/50 text-amber-300 rounded">Pending Master Data</span>
                              )}
                            </div>
                            <div className="text-gray-500 text-xs">{p.description}{p.customer ? ` · ${p.customer}` : ''}</div>
                          </button>
                        ))}
                    </div>
                  )}
                  {newJobForm.part_id && (
                    <p className="text-xs text-cyan-400 mt-1">✓ Selected</p>
                  )}
                </div>

                <div>
                  <label className="block text-gray-400 text-sm mb-1">
                    Source <span className="text-red-400">*</span>
                  </label>
                  <select
                    value={newJobForm.source_type === 'received' ? '__received__' : newJobForm.source_machine_id}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === '__received__') {
                        setNewJobForm(f => ({ ...f, source_type: 'received', source_machine_id: '' }))
                      } else if (v === '') {
                        setNewJobForm(f => ({ ...f, source_type: 'machine', source_machine_id: '' }))
                      } else {
                        setNewJobForm(f => ({ ...f, source_type: 'machine', source_machine_id: v, source_description: '' }))
                      }
                    }}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:border-cyan-500 focus:outline-none"
                  >
                    <option value="">— Select source —</option>
                    {newJobMachines.map(m => (
                      <option key={m.id} value={m.id}>{m.name}{m.code ? ` (${m.code})` : ''}</option>
                    ))}
                    <option disabled>──────────</option>
                    <option value="__received__">Received (no machine)</option>
                  </select>
                  {newJobForm.source_type === 'received' && (
                    <div className="mt-3">
                      <label className="block text-gray-400 text-sm mb-1">
                        Source Description <span className="text-red-400">*</span>
                      </label>
                      <input
                        type="text"
                        value={newJobForm.source_description}
                        onChange={(e) => setNewJobForm(f => ({ ...f, source_description: e.target.value }))}
                        placeholder='e.g. "Betty - SS springs lot 47", "Heat treat return from Braddock", "Customer supplied"'
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:border-cyan-500 focus:outline-none"
                      />
                      <p className="text-gray-600 text-xs mt-1">Where the parts came from. Helps with traceability when no SkyNet machine was involved.</p>
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-gray-400 text-sm mb-1">
                    Quantity <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={newJobForm.quantity}
                    onChange={(e) => setNewJobForm(f => ({ ...f, quantity: e.target.value }))}
                    placeholder="Count the parts in front of you"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:border-cyan-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-gray-400 text-sm mb-1">
                    Material Lot # <span className="text-gray-600 text-xs">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={newJobForm.material_lot_number}
                    onChange={(e) => setNewJobForm(f => ({ ...f, material_lot_number: e.target.value }))}
                    placeholder="If on the traveler or part bag"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white font-mono focus:border-cyan-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-gray-400 text-sm mb-1">
                    Production Lot # <span className="text-gray-600 text-xs">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={newJobForm.production_lot_number}
                    onChange={(e) => setNewJobForm(f => ({ ...f, production_lot_number: e.target.value }))}
                    placeholder="If hand-written on the traveler"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white font-mono focus:border-cyan-500 focus:outline-none"
                  />
                  <p className="text-gray-600 text-xs mt-1">For batches arriving from non-Mazak-5 machines where the machinist wrote a PLN on the paper traveler.</p>
                </div>

                <div>
                  <label className="block text-gray-400 text-sm mb-1">
                    Customer <span className="text-gray-600 text-xs">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={newJobForm.customer}
                    onChange={(e) => setNewJobForm(f => ({ ...f, customer: e.target.value }))}
                    placeholder="Auto-populated from the part record — editable"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:border-cyan-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-gray-400 text-sm mb-2">
                    Operation Type <span className="text-red-400">*</span>
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setNewJobForm(f => ({ ...f, operation_type: 'full_finishing' }))}
                      className={`px-4 py-3 rounded border-2 text-sm font-medium transition-colors ${
                        newJobForm.operation_type === 'full_finishing'
                          ? 'bg-cyan-600 border-cyan-500 text-white'
                          : 'border-gray-700 text-gray-400 hover:border-cyan-600 hover:text-cyan-400'
                      }`}
                    >
                      Full Finishing
                      <div className="text-xs font-normal opacity-75 mt-0.5">Wash → Treatment → Dry</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewJobForm(f => ({ ...f, operation_type: 'passivation_only' }))}
                      className={`px-4 py-3 rounded border-2 text-sm font-medium transition-colors ${
                        newJobForm.operation_type === 'passivation_only'
                          ? 'bg-cyan-600 border-cyan-500 text-white'
                          : 'border-gray-700 text-gray-400 hover:border-cyan-600 hover:text-cyan-400'
                      }`}
                    >
                      Passivation Only
                      <div className="text-xs font-normal opacity-75 mt-0.5">Treatment → Dry (skip Wash)</div>
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-gray-400 text-sm mb-1">
                    Notes <span className="text-gray-600 text-xs">(optional)</span>
                  </label>
                  <textarea
                    value={newJobForm.notes}
                    onChange={(e) => setNewJobForm(f => ({ ...f, notes: e.target.value }))}
                    rows={2}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:border-cyan-500 focus:outline-none"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    onClick={handleCloseNewJob}
                    disabled={newJobSubmitting}
                    className="px-4 py-2 text-gray-400 hover:text-white disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSubmitNewJob}
                    disabled={
                      newJobSubmitting ||
                      !newJobForm.part_id ||
                      !newJobForm.quantity ||
                      (newJobForm.source_type === 'machine' && !newJobForm.source_machine_id) ||
                      (newJobForm.source_type === 'received' && !newJobForm.source_description.trim())
                    }
                    className="flex items-center gap-2 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {newJobSubmitting ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                    {newJobSubmitting ? 'Creating...' : 'Start Batch'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tank Selection Modal (Wash → Treatment) */}
      {showTankModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-md">
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <h3 className="text-white font-semibold flex items-center gap-2">
                <Flame size={20} className="text-cyan-400" />
                Select Treatment Tank
              </h3>
              <button
                onClick={() => { setShowTankModal(false); setPendingAdvanceBatch(null) }}
                className="text-gray-400 hover:text-white"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <p className="text-gray-400 text-sm mb-4">
                Select the tank for treatment processing.
              </p>
              {finishingMachines
                .filter(m => !['offline', 'down'].includes(m.status))
                .map(m => (
                  <button
                    key={m.id}
                    onClick={() => handleTankSelect(m)}
                    disabled={actionLoading}
                    className="w-full flex items-center gap-3 p-4 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors text-left disabled:opacity-50"
                  >
                    <div className={`w-3 h-3 rounded-full ${getMachineStatusDot(m.status)}`} />
                    <div>
                      <p className="text-white font-medium">{m.name}</p>
                      <p className="text-gray-500 text-xs">{m.code} • {m.status}</p>
                    </div>
                  </button>
                ))}
              {finishingMachines.filter(m => !['offline', 'down'].includes(m.status)).length === 0 && (
                <p className="text-gray-500 text-center py-4">No available finishing machines</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 px-6 py-2">
        <p className="text-gray-600 text-xs text-center font-mono">
          SkyNet MES - Finishing Station
        </p>
      </footer>
    </div>
  )
}
