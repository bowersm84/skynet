import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { uploadDocument, getDocumentUrl } from '../lib/s3'
import { FEATURES } from '../config'
import { Truck, Upload, Check, AlertCircle, ChevronDown, ChevronRight, FileText, Clock, RotateCcw, Plus, Combine, Pencil, X } from 'lucide-react'
import CombineLikeProductsModal from './CombineLikeProductsModal'

const OPERATION_LABELS = {
  heat_treat: { label: 'Heat Treatment', color: 'bg-orange-900/30 text-orange-400 border-orange-800' },
  cad_plating: { label: 'Cad Plating', color: 'bg-blue-900/30 text-blue-400 border-blue-800' },
  black_oxide: { label: 'Black Oxide', color: 'bg-gray-800 text-gray-400 border-gray-600' },
  painting: { label: 'Painting', color: 'bg-purple-900/30 text-purple-400 border-purple-800' },
  priming: { label: 'Priming', color: 'bg-teal-900/30 text-teal-400 border-teal-800' },
  other: { label: 'Other', color: 'bg-gray-800 text-gray-400 border-gray-600' },
}

function deriveOperationType(stepName) {
  const s = (stepName || '').toLowerCase()
  if (s.includes('heat')) return 'heat_treat'
  if (s.includes('plat')) return 'cad_plating'
  if (s.includes('oxide')) return 'black_oxide'
  return 'other'
}

function getVendorSuggestions(stepName) {
  const s = (stepName || '').toLowerCase()
  if (s.includes('heat')) return ['Braddock']
  if (s.includes('plat') || s.includes('oxide')) return ['Electrolab', 'Silverman', 'Pioneer']
  return []
}

function formatDate(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// Convert a 'YYYY-MM-DD' date-picker value into a UTC timestamp anchored at LOCAL noon.
// Storing at noon (rather than midnight) prevents the date from drifting in either
// direction when displayed across timezones.
const localDateToISO = (yyyymmdd) => {
  if (!yyyymmdd) return null
  const [y, m, d] = yyyymmdd.split('-').map(Number)
  const localNoon = new Date(y, m - 1, d, 12, 0, 0)
  return localNoon.toISOString()
}

// Format a stored timestamp in the user's LOCAL timezone (not UTC).
const formatDateLocal = (iso) => {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  })
}

// Format a 'date' column value (no time component) as a local-tz calendar date.
// Reading 'YYYY-MM-DD' as a Date directly causes UTC interpretation, so split & rebuild.
const formatDateOnly = (dateStr) => {
  if (!dateStr) return '—'
  const [y, m, d] = dateStr.split('-').map(Number)
  const localDate = new Date(y, m - 1, d)
  return localDate.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  })
}

function isPastToday(dateStr) {
  if (!dateStr) return false
  const [y, m, d] = dateStr.split('-').map(Number)
  const target = new Date(y, m - 1, d)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return target < today
}

export default function OutsourcedJobs({ profile }) {
  const [readySteps, setReadySteps] = useState([])
  const [atVendor, setAtVendor] = useState([])
  const [returned, setReturned] = useState([])
  const [loading, setLoading] = useState(true)
  const [showReturned, setShowReturned] = useState(false)

  const [sendFormOpen, setSendFormOpen] = useState(null)
  const [sendForm, setSendForm] = useState({})
  const [returnFormOpen, setReturnFormOpen] = useState(null)
  const [returnForm, setReturnForm] = useState({})
  const [saving, setSaving] = useState(false)
  const [uploadingCertId, setUploadingCertId] = useState(null)
  const [combineModalOpen, setCombineModalOpen] = useState(false)
  const [groupReturnOpen, setGroupReturnOpen] = useState(null)
  const [groupReturnForm, setGroupReturnForm] = useState({})
  const [editingExpectedId, setEditingExpectedId] = useState(null)
  const [editingExpectedValue, setEditingExpectedValue] = useState('')

  const canEdit = profile?.can_approve_compliance === true || profile?.role === 'admin'

  // Map: consolidation_group_id → count of rows in that group (across at-vendor + returned).
  // Used to render the "Consolidated (N)" pill on group members.
  const groupSizeMap = (() => {
    const m = {}
    for (const list of [atVendor, returned]) {
      for (const s of list) {
        const gid = s.consolidation_group_id
        if (!gid) continue
        m[gid] = (m[gid] || 0) + 1
      }
    }
    return m
  })()

  // Collapse a flat list of outbound_sends into "cards": each consolidation group becomes
  // ONE synthetic group card (isGroup) carrying its constituent rows; every non-grouped row
  // passes through unchanged. Group position follows the first member, so the upstream sort
  // (expected_return / returned_at) is preserved. Display-only — underlying rows are untouched.
  const collapseConsolidated = (list) => {
    const cards = []
    const groupIndex = {}
    for (const s of list) {
      const gid = s.consolidation_group_id
      if (!gid) { cards.push(s); continue }
      if (gid in groupIndex) { cards[groupIndex[gid]].rows.push(s); continue }
      groupIndex[gid] = cards.length
      cards.push({ isGroup: true, id: `grp-${gid}`, consolidation_group_id: gid, rows: [s] })
    }
    return cards
  }

  const atVendorCards = collapseConsolidated(atVendor)
  const returnedCards = collapseConsolidated(returned)

  const computeBatchLetters = async (jobIds) => {
    if (!jobIds.length) return {}
    const { data, error } = await supabase
      .from('finishing_sends')
      .select('id, job_id, compliance_approved_at')
      .in('job_id', jobIds)
      .eq('compliance_status', 'approved')
      .order('compliance_approved_at', { ascending: true })
    if (error || !data) return {}
    const byJob = {}
    for (const b of data) {
      if (!byJob[b.job_id]) byJob[b.job_id] = []
      byJob[b.job_id].push(b)
    }
    const map = {}
    for (const jobId in byJob) {
      byJob[jobId].forEach((b, i) => { map[b.id] = String.fromCharCode(65 + i) })
    }
    return map
  }

  // Per-batch qty: compliance_good_qty -> (verified - bad) -> verified_count -> quantity
  const getBatchQty = (batch) => {
    if (!batch) return 0
    if (batch.compliance_good_qty != null) return batch.compliance_good_qty
    if (batch.compliance_bad_qty != null && batch.verified_count != null) {
      return Math.max(0, batch.verified_count - batch.compliance_bad_qty)
    }
    if (batch.verified_count != null) return batch.verified_count
    return batch.quantity || 0
  }

  // Hydrate a list of outbound_sends rows (assembly source) with their WOA + routing step data.
  // Polymorphic source_id has no FK, so PostgREST embeds don't work — we do the join in JS.
  const hydrateAssemblySends = async (sends) => {
    if (!sends?.length) return []

    const woaIds = [...new Set(sends.map(s => s.source_id).filter(Boolean))]
    const stepIds = [...new Set(sends.map(s => s.routing_step_id).filter(Boolean))]

    const [woaRes, stepsRes] = await Promise.all([
      woaIds.length
        ? supabase
            .from('work_order_assemblies')
            .select(`
              id, quantity, status, assembly_lot_number,
              assembly:parts!assembly_id (id, part_number, description, part_type),
              work_order:work_orders (id, wo_number, customer)
            `)
            .in('id', woaIds)
        : Promise.resolve({ data: [], error: null }),
      stepIds.length
        ? supabase
            .from('work_order_assembly_routing_steps')
            .select('id, step_order, step_name, step_type, status')
            .in('id', stepIds)
        : Promise.resolve({ data: [], error: null }),
    ])

    if (woaRes.error)   console.error('hydrateAssemblySends WOA error:', woaRes.error)
    if (stepsRes.error) console.error('hydrateAssemblySends step error:', stepsRes.error)

    const woaById  = Object.fromEntries((woaRes.data || []).map(w => [w.id, w]))
    const stepById = Object.fromEntries((stepsRes.data || []).map(s => [s.id, s]))

    return sends.map(s => ({
      ...s,
      woa: woaById[s.source_id] || null,
      routingStep: stepById[s.routing_step_id] || null,
    }))
  }

  // Per-WOA batch letter map: outbound_sends ordered by created_at gets A/B/C.
  const computeAssemblyBatchLetters = async (woaIds) => {
    if (!woaIds.length) return {}
    const { data, error } = await supabase
      .from('outbound_sends')
      .select('id, source_id, created_at')
      .eq('source_type', 'work_order_assembly')
      .in('source_id', woaIds)
      .order('created_at', { ascending: true })
    if (error || !data) return {}
    const byWoa = {}
    for (const row of data) {
      if (!byWoa[row.source_id]) byWoa[row.source_id] = []
      byWoa[row.source_id].push(row)
    }
    const map = {}
    for (const woaId in byWoa) {
      byWoa[woaId].forEach((s, i) => { map[s.id] = String.fromCharCode(65 + i) })
    }
    return map
  }

  // Unified display metadata for a send record across both source types.
  const getSendDisplayMeta = (record) => {
    if (record.sourceKind === 'finishing') {
      const stepName = record.step?.step_name
        || record.job_routing_step?.step_name
        || record.routing_step_name
        || ''
      const lotValue = record.batch?.finishing_lot_number
        || record.finishing_send?.finishing_lot_number
        || ''
      return {
        sourceKind: 'finishing',
        stepName,
        partNumber: record.job?.part?.part_number || '',
        partDescription: record.job?.part?.description || '',
        jobNumber: record.job?.job_number || '',
        woNumber: record.job?.work_order?.wo_number || '',
        customer: record.job?.work_order?.customer || '',
        lotLabel: 'FLN',
        lotValue,
        batchPill: record.batchLetter ? `Batch ${record.batchLetter}` : '',
      }
    }
    return {
      sourceKind: 'assembly',
      stepName: record.routingStep?.step_name || '',
      partNumber: record.woa?.assembly?.part_number || '',
      partDescription: record.woa?.assembly?.description || '',
      jobNumber: '',
      woNumber: record.woa?.work_order?.wo_number || '',
      customer: record.woa?.work_order?.customer || '',
      lotLabel: 'ALN',
      lotValue: record.woa?.assembly_lot_number || '',
      batchPill: record.batchLetter ? `Batch ${record.batchLetter}` : '',
    }
  }

  const fetchAll = async () => {
    try {
      await Promise.all([fetchReadyToSend(), fetchAtVendor(), fetchReturned()])
    } finally {
      setLoading(false)
    }
  }

  const fetchReadyToSend = async () => {
    // Strategy: find approved finishing_sends that have an external routing step
    // for the same job and DON'T already have an outbound_sends row linking them.

    // 1. Pull approved finishing batches with their job + external steps
    const { data: batches, error: batchErr } = await supabase
      .from('finishing_sends')
      .select(`
        id, quantity, verified_count, compliance_good_qty, compliance_bad_qty,
        finishing_lot_number, material_lot_number, compliance_approved_at, finishing_completed_at,
        job:jobs!inner(
          id, job_number, quantity, status,
          part:parts!component_id(part_number, description, part_type),
          work_order:work_orders(id, wo_number, customer),
          job_routing_steps(id, step_name, step_order, step_type, status)
        )
      `)
      .eq('compliance_status', 'approved')
      .not('job.status', 'in', '(ready_for_assembly,in_assembly,pending_tco,complete,cancelled)')
      .order('compliance_approved_at', { ascending: true })

    if (batchErr) {
      console.error('Error fetching approved batches:', batchErr)
      return
    }

    // 2. Pull existing outbound_sends to know which batch+step combos are already sent
    const { data: existingSends, error: sendErr } = await supabase
      .from('outbound_sends')
      .select('finishing_send_id, job_routing_step_id')
      .not('finishing_send_id', 'is', null)
    if (sendErr) {
      console.error('Error fetching existing sends:', sendErr)
      return
    }
    const sentSet = new Set(
      (existingSends || []).map(s => `${s.finishing_send_id}|${s.job_routing_step_id}`)
    )

    // Build per-job batch letter map: oldest approved = A, next = B, etc.
    const batchLetterMap = {}
    const batchesByJob = {}
    for (const b of batches || []) {
      if (!b.job?.id) continue
      if (!batchesByJob[b.job.id]) batchesByJob[b.job.id] = []
      batchesByJob[b.job.id].push(b)
    }
    for (const jobId in batchesByJob) {
      const sorted = batchesByJob[jobId].sort((a, b) =>
        new Date(a.compliance_approved_at || 0) - new Date(b.compliance_approved_at || 0)
      )
      sorted.forEach((b, i) => {
        batchLetterMap[b.id] = String.fromCharCode(65 + i)
      })
    }

    // 3. Build the Ready to Send list — one row per (batch × pending external step)
    const rows = []
    for (const batch of batches || []) {
      const externalSteps = (batch.job?.job_routing_steps || [])
        .filter(s => s.step_type === 'external')
        .sort((a, b) => a.step_order - b.step_order)

      for (const step of externalSteps) {
        const key = `${batch.id}|${step.id}`
        if (sentSet.has(key)) continue
        // Don't offer this external step until every earlier external step has returned —
        // a later step (e.g. Plating) must wait for an earlier one (e.g. Heat Treat) to come back.
        const earlierExternalPending = externalSteps.some(
          s => s.step_order < step.step_order && !['complete', 'skipped', 'removed'].includes(s.status)
        )
        if (earlierExternalPending) continue
        rows.push({
          rowKey: key,
          sourceKind: 'finishing',
          step,
          batch,
          job: batch.job,
          batchLetter: batchLetterMap[batch.id] || '',
        })
      }
    }

    // ───── Assembly-source rows ─────
    // outbound_sends.source_id is polymorphic (no FK), so we fetch raw rows
    // then hydrate WOA + routing step via separate queries.
    const { data: asmSendsRaw, error: asmErr } = await supabase
      .from('outbound_sends')
      .select('id, source_id, source_type, routing_step_id, operation_type, quantity, created_at')
      .eq('source_type', 'work_order_assembly')
      .is('sent_at', null)
      .order('created_at', { ascending: true })

    if (asmErr) {
      console.error('Error fetching assembly-source ready sends:', asmErr)
    } else if (asmSendsRaw?.length) {
      const hydrated = await hydrateAssemblySends(asmSendsRaw)
      const woaIds = [...new Set(hydrated.map(s => s.source_id).filter(Boolean))]
      const letterMap = await computeAssemblyBatchLetters(woaIds)

      for (const send of hydrated) {
        rows.push({
          rowKey: `asm|${send.id}`,
          sourceKind: 'assembly',
          send,
          woa: send.woa,
          routingStep: send.routingStep,
          batchLetter: letterMap[send.id] || '',
        })
      }
    }

    setReadySteps(rows)
  }

  const fetchAtVendor = async () => {
    // 1. Finishing-source at-vendor rows
    const { data: finishingData, error: finErr } = await supabase
      .from('outbound_sends')
      .select(`
        *,
        job:jobs(
          id, job_number, quantity, status,
          part:parts!component_id(part_number, description, part_type),
          work_order:work_orders(id, wo_number, customer)
        ),
        job_routing_step:job_routing_steps(id, step_name, step_order),
        finishing_send:finishing_sends!finishing_send_id(id, finishing_lot_number, quantity, verified_count, compliance_good_qty),
        sent_by_profile:profiles!outbound_sends_sent_by_fkey(full_name)
      `)
      .eq('source_type', 'finishing_send')
      .not('sent_at', 'is', null)
      .is('returned_at', null)
      .order('expected_return_at', { ascending: true })

    if (finErr) {
      console.error('Error fetching finishing at-vendor sends:', finErr)
    }

    const finJobIds = [...new Set((finishingData || []).map(s => s.job?.id).filter(Boolean))]
    const finLetterMap = await computeBatchLetters(finJobIds)
    const finishingEnriched = (finishingData || []).map(s => ({
      ...s,
      sourceKind: 'finishing',
      batchLetter: s.finishing_send_id ? (finLetterMap[s.finishing_send_id] || '') : ''
    }))

    // 2. Assembly-source at-vendor rows
    const { data: asmRaw, error: asmErr } = await supabase
      .from('outbound_sends')
      .select(`
        *,
        sent_by_profile:profiles!outbound_sends_sent_by_fkey(full_name)
      `)
      .eq('source_type', 'work_order_assembly')
      .not('sent_at', 'is', null)
      .is('returned_at', null)
      .order('expected_return_at', { ascending: true })

    if (asmErr) {
      console.error('Error fetching assembly at-vendor sends:', asmErr)
    }

    const asmHydrated = await hydrateAssemblySends(asmRaw || [])
    const asmWoaIds = [...new Set(asmHydrated.map(s => s.source_id).filter(Boolean))]
    const asmLetterMap = await computeAssemblyBatchLetters(asmWoaIds)
    const asmEnriched = asmHydrated.map(s => ({
      ...s,
      sourceKind: 'assembly',
      batchLetter: asmLetterMap[s.id] || ''
    }))

    // 3. Merge and sort by expected_return_at (nulls last)
    const merged = [...finishingEnriched, ...asmEnriched].sort((a, b) => {
      if (!a.expected_return_at && !b.expected_return_at) return 0
      if (!a.expected_return_at) return 1
      if (!b.expected_return_at) return -1
      return new Date(a.expected_return_at) - new Date(b.expected_return_at)
    })

    setAtVendor(merged)
  }

  const fetchReturned = async () => {
    // 1. Finishing-source returned rows
    const { data: finishingData, error: finErr } = await supabase
      .from('outbound_sends')
      .select(`
        *,
        job:jobs(
          id, job_number, quantity, status,
          part:parts!component_id(part_number, description, part_type),
          work_order:work_orders(id, wo_number, customer)
        ),
        job_routing_step:job_routing_steps(id, step_name, step_order),
        finishing_send:finishing_sends!finishing_send_id(id, finishing_lot_number, quantity, verified_count, compliance_good_qty),
        sent_by_profile:profiles!outbound_sends_sent_by_fkey(full_name),
        returned_by_profile:profiles!outbound_sends_returned_by_fkey(full_name)
      `)
      .eq('source_type', 'finishing_send')
      .not('returned_at', 'is', null)
      .order('returned_at', { ascending: false })
      .limit(20)

    if (finErr) console.error('Error fetching finishing returned sends:', finErr)

    const finJobIds = [...new Set((finishingData || []).map(s => s.job?.id).filter(Boolean))]
    const finLetterMap = await computeBatchLetters(finJobIds)
    const finishingEnriched = (finishingData || []).map(s => ({
      ...s,
      sourceKind: 'finishing',
      batchLetter: s.finishing_send_id ? (finLetterMap[s.finishing_send_id] || '') : ''
    }))

    // 2. Assembly-source returned rows
    const { data: asmRaw, error: asmErr } = await supabase
      .from('outbound_sends')
      .select(`
        *,
        sent_by_profile:profiles!outbound_sends_sent_by_fkey(full_name),
        returned_by_profile:profiles!outbound_sends_returned_by_fkey(full_name)
      `)
      .eq('source_type', 'work_order_assembly')
      .not('returned_at', 'is', null)
      .order('returned_at', { ascending: false })
      .limit(20)

    if (asmErr) console.error('Error fetching assembly returned sends:', asmErr)

    const asmHydrated = await hydrateAssemblySends(asmRaw || [])
    const asmWoaIds = [...new Set(asmHydrated.map(s => s.source_id).filter(Boolean))]
    const asmLetterMap = await computeAssemblyBatchLetters(asmWoaIds)
    const asmEnriched = asmHydrated.map(s => ({
      ...s,
      sourceKind: 'assembly',
      batchLetter: asmLetterMap[s.id] || ''
    }))

    // 3. Merge, sort by returned_at desc, cap at 20 total
    const merged = [...finishingEnriched, ...asmEnriched]
      .sort((a, b) => new Date(b.returned_at) - new Date(a.returned_at))
      .slice(0, 20)

    setReturned(merged)
  }

  useEffect(() => {
    fetchAll()

    const channel = supabase.channel('outsourced-channel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'outbound_sends' }, fetchAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'finishing_sends' }, fetchAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, fetchAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_order_assemblies' }, fetchAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_order_assembly_routing_steps' }, fetchAll)
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [])

  // --- ACTIONS ---

  const handleLogSendOut = async (row) => {
    const form = sendForm[row.rowKey] || {}
    if (!form.vendor_name?.trim() || !form.quantity) return
    setSaving(true)
    try {
      if (row.sourceKind === 'assembly') {
        // ───── Assembly path: UPDATE existing outbound_sends row ─────
        const { error: updateErr } = await supabase
          .from('outbound_sends')
          .update({
            vendor_name: form.vendor_name.trim(),
            quantity: parseInt(form.quantity),
            sent_at: form.sent_date ? localDateToISO(form.sent_date) : new Date().toISOString(),
            sent_by: profile.id,
            expected_return_at: form.expected_return || null,
            notes: form.notes?.trim() || null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.send.id)
        if (updateErr) throw updateErr

        // Flip WOA status: ready_for_outsource → at_external_vendor (only if currently in that state).
        const woaId = row.woa?.id
        if (woaId) {
          const { error: woaErr } = await supabase
            .from('work_order_assemblies')
            .update({ status: 'at_external_vendor' })
            .eq('id', woaId)
            .eq('status', 'ready_for_outsource')
          if (woaErr) console.error('WOA status flip failed:', woaErr)
        }
      } else {
        // ───── Finishing path: INSERT new outbound_sends row ─────
        const jobId = row.job.id
        const workOrderId = row.job.work_order?.id || null

        const { error: insertErr } = await supabase
          .from('outbound_sends')
          .insert({
            source_type: 'finishing_send',
            source_id: row.batch.id,
            routing_step_id: row.step.id,
            job_id: jobId,
            work_order_id: workOrderId,
            job_routing_step_id: row.step.id,
            finishing_send_id: row.batch.id,
            operation_type: deriveOperationType(row.step.step_name),
            vendor_name: form.vendor_name.trim(),
            quantity: parseInt(form.quantity),
            sent_at: form.sent_date ? localDateToISO(form.sent_date) : new Date().toISOString(),
            sent_by: profile.id,
            expected_return_at: form.expected_return || null,
            notes: form.notes?.trim() || null,
          })
        if (insertErr) throw insertErr
      }

      setSendFormOpen(null)
      setSendForm({})
      await fetchAll()
    } catch (err) {
      console.error('Error logging send-out:', err)
      alert('Failed to log send-out: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleLogReturn = async (send) => {
    const form = returnForm[send.id] || {}
    if (!form.vendor_lot_number?.trim()) {
      alert('Vendor lot/cert number is required')
      return
    }
    setSaving(true)
    try {
      const quantityReturned = parseInt(form.quantity_returned || send.quantity)
      const returnDate = form.return_date ? localDateToISO(form.return_date) : new Date().toISOString()

      // a. Update outbound_sends
      const { error: sendErr } = await supabase
        .from('outbound_sends')
        .update({
          returned_at: returnDate,
          returned_by: profile.id,
          vendor_lot_number: form.vendor_lot_number.trim(),
          quantity_returned: quantityReturned,
          updated_at: new Date().toISOString(),
        })
        .eq('id', send.id)
      if (sendErr) throw sendErr

      // b. Step + parent rollup — branches on source type
      if (send.sourceKind === 'assembly') {
        // ───── Assembly path ─────
        const woaId = send.source_id
        const stepId = send.routing_step_id

        if (stepId && woaId) {
          // 1. Are all sends for this WOA + step returned?
          const { data: stepSends, error: stepSendsErr } = await supabase
            .from('outbound_sends')
            .select('id, returned_at')
            .eq('source_type', 'work_order_assembly')
            .eq('source_id', woaId)
            .eq('routing_step_id', stepId)
          if (stepSendsErr) throw stepSendsErr

          const allStepReturned = stepSends && stepSends.length > 0
            && stepSends.every(s => s.returned_at != null)

          if (allStepReturned) {
            // 2. Look up the Assemble step's status — only mark this external step
            //    complete when assembly itself is also done. Otherwise more batches
            //    may yet flow through this step and we'd be prematurely closing it.
            const { data: assembleStep } = await supabase
              .from('work_order_assembly_routing_steps')
              .select('status')
              .eq('work_order_assembly_id', woaId)
              .eq('step_order', 1)
              .single()

            const assemblyDone = assembleStep?.status === 'complete'

            if (assemblyDone) {
              const { error: stepErr } = await supabase
                .from('work_order_assembly_routing_steps')
                .update({
                  status: 'complete',
                  completed_at: new Date().toISOString(),
                  completed_by: profile.id,
                  lot_number: form.vendor_lot_number.trim(),
                  quantity: quantityReturned,
                })
                .eq('id', stepId)
              if (stepErr) throw stepErr
            }
            // else: leave external step at its current status. C3 (Assembly Complete)
            // sweeps external steps and marks them complete when Jody finishes.

            // 3. Are ALL routing steps (Assemble + every external step) complete?
            //    Flipping to pending_tco while Assemble is still in_progress strands
            //    the WOA out of Jody's queue and prevents her from sending further batches.
            const { data: allSteps, error: allStepsErr } = await supabase
              .from('work_order_assembly_routing_steps')
              .select('id, step_type, status')
              .eq('work_order_assembly_id', woaId)
            if (allStepsErr) throw allStepsErr

            const allStepsComplete = allSteps && allSteps.length > 0
              && allSteps.every(s => ['complete', 'skipped', 'removed'].includes(s.status))

            if (allStepsComplete) {
              // 4. WOA → pending_tco
              const { error: woaErr } = await supabase
                .from('work_order_assemblies')
                .update({ status: 'pending_tco' })
                .eq('id', woaId)
              if (woaErr) throw woaErr

              // 5. Linked component jobs → pending_tco
              const { error: jobsErr } = await supabase
                .from('jobs')
                .update({ status: 'pending_tco', updated_at: new Date().toISOString() })
                .eq('work_order_assembly_id', woaId)
                .in('status', ['ready_for_assembly', 'in_assembly'])
              if (jobsErr) console.error('Error advancing jobs to pending_tco:', jobsErr)
            }
            // else: Assemble step still in_progress → leave WOA at its current status.
            // The eventual Complete in Assembly.jsx (C3) will handle the final transition.
          }
        }
      } else {
        // ───── Finishing path (existing behavior) ─────
        if (send.job_routing_step_id) {
          const { data: stepSends, error: stepSendsErr } = await supabase
            .from('outbound_sends')
            .select('id, returned_at')
            .eq('job_routing_step_id', send.job_routing_step_id)
          if (stepSendsErr) throw stepSendsErr

          const allStepReturned = stepSends && stepSends.length > 0
            && stepSends.every(s => s.returned_at != null)

          if (allStepReturned) {
            const jobId = send.job?.id || send.job_id
            const { data: jobRow, error: jobFetchErr } = await supabase
              .from('jobs')
              .select('id, actual_end')
              .eq('id', jobId)
              .single()
            if (jobFetchErr) throw jobFetchErr

            const machiningDone = jobRow?.actual_end != null

            if (machiningDone) {
              const { error: stepErr } = await supabase
                .from('job_routing_steps')
                .update({
                  status: 'complete',
                  completed_at: new Date().toISOString(),
                  completed_by: profile.id,
                  lot_number: form.vendor_lot_number.trim(),
                })
                .eq('id', send.job_routing_step_id)
              if (stepErr) throw stepErr

              const { data: allSteps, error: allStepsErr } = await supabase
                .from('job_routing_steps')
                .select('id, step_type, status')
                .eq('job_id', jobId)
                .eq('step_type', 'external')
              if (allStepsErr) throw allStepsErr

              const allExternalComplete = allSteps && allSteps.length > 0
                && allSteps.every(s => s.status === 'complete')

              if (allExternalComplete) {
                const partType = send.job?.part?.part_type
                const nextStatus = (partType === 'finished_good' || !FEATURES.ASSEMBLY_MODULE)
                  ? 'pending_tco'
                  : 'ready_for_assembly'
                const { error: jobErr } = await supabase
                  .from('jobs')
                  .update({ status: nextStatus, updated_at: new Date().toISOString() })
                  .eq('id', jobId)
                if (jobErr) throw jobErr
              }
            }
          }
        }
      }

      setReturnFormOpen(null)
      setReturnForm({})
      await fetchAll()
    } catch (err) {
      console.error('Error logging return:', err)
      alert('Failed to log return: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleReturnGroup = async (groupId) => {
    const form = groupReturnForm[groupId] || {}
    if (!form.vendor_lot_number?.trim()) {
      alert('Vendor lot/cert number is required')
      return
    }
    const groupRows = atVendor.filter(s => s.consolidation_group_id === groupId)
    if (!groupRows.length) return

    setSaving(true)
    try {
      const returnDate = form.return_date ? localDateToISO(form.return_date) : new Date().toISOString()
      const vendorLot = form.vendor_lot_number.trim()

      // 1. Bulk-update all rows in the group (shared vendor_lot + return_date for the whole lot).
      const { error: bulkErr } = await supabase
        .from('outbound_sends')
        .update({
          returned_at: returnDate,
          returned_by: profile.id,
          vendor_lot_number: vendorLot,
          updated_at: new Date().toISOString(),
        })
        .eq('consolidation_group_id', groupId)
      if (bulkErr) throw bulkErr

      // Per-row quantity_returned — the lot is received as ONE total. Distribute that total
      // across the constituent rows so each job/step rollup stays exact:
      //  • full return (total == sum sent): each row keeps its own sent quantity
      //  • short return: apportion proportionally by sent qty, remainder to the last row so
      //    the per-row sum equals the entered total exactly.
      const sentTotal = groupRows.reduce((a, r) => a + (r.quantity || 0), 0)
      const totalReturned = parseInt(form.total_returned ?? sentTotal)
      const qtyByRow = {}
      if (!Number.isFinite(totalReturned) || totalReturned === sentTotal || sentTotal === 0) {
        for (const r of groupRows) qtyByRow[r.id] = r.quantity || 0
      } else {
        let allocated = 0
        groupRows.forEach((r, i) => {
          if (i === groupRows.length - 1) {
            qtyByRow[r.id] = Math.max(0, totalReturned - allocated)
          } else {
            const share = Math.round(totalReturned * (r.quantity || 0) / sentTotal)
            qtyByRow[r.id] = share
            allocated += share
          }
        })
      }
      for (const r of groupRows) {
        await supabase
          .from('outbound_sends')
          .update({ quantity_returned: qtyByRow[r.id] })
          .eq('id', r.id)
      }

      // 2. Per (job, job_routing_step) cascade. Each row keeps its own job/step linkage
      //    under Option B, so the existing per-step rollup applies row-by-row.
      const uniqueStepRows = []
      const seen = new Set()
      for (const r of groupRows) {
        const key = `${r.job_id}|${r.job_routing_step_id}`
        if (seen.has(key)) continue
        seen.add(key)
        uniqueStepRows.push(r)
      }

      for (const r of uniqueStepRows) {
        if (!r.job_routing_step_id) continue

        const { data: stepSends } = await supabase
          .from('outbound_sends')
          .select('id, returned_at')
          .eq('job_routing_step_id', r.job_routing_step_id)
        const allStepReturned = stepSends && stepSends.length > 0
          && stepSends.every(s => s.returned_at != null)
        if (!allStepReturned) continue

        const jobId = r.job?.id || r.job_id
        const { data: jobRow } = await supabase
          .from('jobs')
          .select('id, actual_end')
          .eq('id', jobId)
          .single()
        const machiningDone = jobRow?.actual_end != null
        if (!machiningDone) continue

        await supabase
          .from('job_routing_steps')
          .update({
            status: 'complete',
            completed_at: new Date().toISOString(),
            completed_by: profile.id,
            lot_number: vendorLot,
          })
          .eq('id', r.job_routing_step_id)

        const { data: allSteps } = await supabase
          .from('job_routing_steps')
          .select('id, step_type, status')
          .eq('job_id', jobId)
          .eq('step_type', 'external')
        const allExternalComplete = allSteps && allSteps.length > 0
          && allSteps.every(s => s.status === 'complete')
        if (!allExternalComplete) continue

        const partType = r.job?.part?.part_type
        const nextStatus = (partType === 'finished_good' || !FEATURES.ASSEMBLY_MODULE)
          ? 'pending_tco'
          : 'ready_for_assembly'
        await supabase
          .from('jobs')
          .update({ status: nextStatus, updated_at: new Date().toISOString() })
          .eq('id', jobId)
      }

      setGroupReturnOpen(null)
      setGroupReturnForm({})
      await fetchAll()
    } catch (err) {
      console.error('Error logging group return:', err)
      alert('Failed to log group return: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  // Update expected_return_at for one send, or for an entire consolidation group.
  // Date column on outbound_sends is stored as date (YYYY-MM-DD), no timezone conversion needed.
  const handleUpdateExpectedReturn = async (send, newDate) => {
    setSaving(true)
    try {
      const update = {
        expected_return_at: newDate || null,
        updated_at: new Date().toISOString(),
      }
      let query = supabase.from('outbound_sends').update(update)
      if (send.consolidation_group_id) {
        query = query.eq('consolidation_group_id', send.consolidation_group_id)
      } else {
        query = query.eq('id', send.id)
      }
      const { error } = await query
      if (error) throw error
      setEditingExpectedId(null)
      setEditingExpectedValue('')
      await fetchAll()
    } catch (err) {
      console.error('Error updating expected return:', err)
      alert('Failed to update expected return: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleAttachCert = async (sendId, file, groupId = null) => {
    if (!file) return
    setUploadingCertId(groupId || sendId)
    try {
      const path = groupId
        ? `outbound-certs/group-${groupId}/${file.name}`
        : `outbound-certs/${sendId}/${file.name}`
      await uploadDocument(file, path)
      let query = supabase
        .from('outbound_sends')
        .update({ cert_document_path: path, updated_at: new Date().toISOString() })
      query = groupId ? query.eq('consolidation_group_id', groupId) : query.eq('id', sendId)
      const { error } = await query
      if (error) throw error
      await fetchAll()
    } catch (err) {
      console.error('Error uploading cert:', err)
      alert('Failed to upload certificate: ' + err.message)
    } finally {
      setUploadingCertId(null)
    }
  }

  const handleViewCert = async (certPath) => {
    try {
      const url = await getDocumentUrl(certPath)
      window.open(url, '_blank')
    } catch (err) {
      console.error('Error opening cert:', err)
      alert('Could not open certificate.')
    }
  }

  // --- RENDER HELPERS ---

  const getStepBadge = (stepName, operationType) => {
    const type = operationType || deriveOperationType(stepName)
    const config = OPERATION_LABELS[type] || OPERATION_LABELS.other
    return (
      <span className={`text-xs font-medium px-2 py-0.5 rounded border ${config.color}`}>
        {stepName || config.label}
      </span>
    )
  }

  // ── Consolidated group card: AT VENDOR ──
  // All rows share part / vendor / operation / material lot (the consolidation gate) and were
  // shipped as ONE lot. Render ONE card with the constituent batches listed and a single total;
  // receiving applies to the whole lot at once.
  const renderAtVendorGroupCard = (card) => {
    const rows = card.rows
    const head = rows[0]
    const meta = getSendDisplayMeta(head)
    const gid = card.consolidation_group_id
    const totalQty = rows.reduce((a, r) => a + (r.quantity || 0), 0)
    const overdue = isPastToday(head.expected_return_at)
    const isUploading = uploadingCertId === gid
    const certRow = rows.find(r => r.cert_document_path)

    return (
      <div key={card.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            {getStepBadge(meta.stepName, head.operation_type)}
            {head.vendor_name && <span className="text-sm text-white font-medium">{head.vendor_name}</span>}
            <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-skynet-accent/10 text-skynet-accent border-skynet-accent/40 flex items-center gap-1">
              <Combine size={10} />
              Consolidated Lot ({rows.length})
            </span>
          </div>
          <span className="text-xs px-2 py-0.5 rounded bg-blue-900/30 text-blue-300 flex-shrink-0">At Vendor</span>
        </div>

        <div className="flex items-center gap-3 text-sm">
          <span className="text-skynet-accent font-mono">{meta.partNumber}</span>
          {meta.partDescription && <span className="text-gray-500 truncate">{meta.partDescription}</span>}
        </div>

        <div className="space-y-1 rounded-lg bg-gray-800/40 border border-gray-800 p-2">
          {rows.map(r => {
            const rm = getSendDisplayMeta(r)
            return (
              <div key={r.id} className="flex items-center gap-2 text-[11px] flex-wrap">
                <span className="text-white font-mono">{rm.jobNumber}</span>
                {r.batchLetter && (
                  <span className="px-1.5 py-0.5 rounded font-mono bg-cyan-900/40 text-cyan-300">Batch {r.batchLetter}</span>
                )}
                <span className="text-cyan-400 font-mono">FLN: {rm.lotValue || '—'}</span>
                {rm.woNumber && <span className="text-gray-500">· {rm.woNumber}</span>}
                <span className="text-gray-400 ml-auto">{r.quantity} pcs</span>
              </div>
            )
          })}
          <div className="flex items-center justify-between pt-1 mt-1 border-t border-gray-700">
            <span className="text-[11px] text-gray-400">Total sent ({rows.length} batches)</span>
            <span className="text-xs text-white font-semibold">{totalQty} pcs</span>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs flex-wrap">
          <span className="text-gray-400">
            Sent: <span className="text-gray-300">{formatDateLocal(head.sent_at)}</span>
            {head.sent_by_profile?.full_name && <span className="text-gray-600"> by {head.sent_by_profile.full_name}</span>}
          </span>
          {(head.expected_return_at || canEdit) && (
            editingExpectedId === gid ? (
              <span className="flex items-center gap-1.5 flex-wrap">
                <span className="text-gray-400 text-xs">Expected:</span>
                <input
                  type="date"
                  value={editingExpectedValue}
                  onChange={e => setEditingExpectedValue(e.target.value)}
                  className="px-1.5 py-0.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-skynet-accent focus:outline-none"
                  autoFocus
                />
                <button onClick={() => handleUpdateExpectedReturn(head, editingExpectedValue || null)} disabled={saving} className="text-skynet-accent hover:text-blue-400 disabled:opacity-50" title="Save"><Check size={13} /></button>
                <button onClick={() => { setEditingExpectedId(null); setEditingExpectedValue('') }} className="text-gray-500 hover:text-white" title="Cancel"><X size={13} /></button>
                <span className="text-[10px] text-gray-500 italic">applies to whole lot</span>
              </span>
            ) : (
              <span className={`flex items-center gap-1 ${overdue ? 'text-red-400 font-medium' : 'text-gray-400'}`}>
                {overdue && <AlertCircle size={12} />}
                Expected:{' '}
                <span className={overdue ? '' : 'text-gray-300'}>{head.expected_return_at ? formatDateOnly(head.expected_return_at) : '—'}</span>
                {canEdit && (
                  <button onClick={() => { setEditingExpectedId(gid); setEditingExpectedValue(head.expected_return_at || '') }} className="ml-1 text-gray-500 hover:text-skynet-accent transition-colors" title="Edit expected return date"><Pencil size={11} /></button>
                )}
              </span>
            )
          )}
        </div>

        {certRow && (
          <button onClick={() => handleViewCert(certRow.cert_document_path)} className="flex items-center gap-1.5 text-xs text-skynet-accent hover:text-blue-400 transition-colors">
            <FileText size={12} /> View Cert
          </button>
        )}

        {canEdit && (
          <div className="flex items-center gap-2 pt-2 border-t border-gray-800">
            <button
              onClick={() => {
                setGroupReturnOpen(gid)
                setGroupReturnForm(prev => ({
                  ...prev,
                  [gid]: {
                    vendor_lot_number: '',
                    return_date: new Date().toISOString().split('T')[0],
                    total_returned: String(totalQty),
                  }
                }))
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded-lg transition-colors"
            >
              <RotateCcw size={13} /> Receive Whole Lot
            </button>
            <label className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${isUploading ? 'bg-gray-700 text-gray-400' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}>
              {isUploading ? <Clock size={13} className="animate-spin" /> : <Upload size={13} />}
              {certRow ? 'Replace Cert' : 'Attach Cert'}
              <input type="file" accept=".pdf" className="hidden" disabled={isUploading} onChange={(e) => handleAttachCert(head.id, e.target.files?.[0], gid)} />
            </label>
          </div>
        )}
      </div>
    )
  }

  // ── Consolidated group card: RETURNED ──
  const renderReturnedGroupCard = (card) => {
    const rows = card.rows
    const head = rows[0]
    const meta = getSendDisplayMeta(head)
    const totalReturned = rows.reduce((a, r) => a + (r.quantity_returned ?? r.quantity ?? 0), 0)
    const certRow = rows.find(r => r.cert_document_path)

    return (
      <div key={card.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            {getStepBadge(meta.stepName, head.operation_type)}
            {head.vendor_name && <span className="text-sm text-white font-medium">{head.vendor_name}</span>}
            <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-skynet-accent/10 text-skynet-accent border-skynet-accent/40 flex items-center gap-1">
              <Combine size={10} />
              Consolidated Lot ({rows.length})
            </span>
          </div>
          <span className="text-xs px-2 py-0.5 rounded bg-green-900/30 text-green-400 flex-shrink-0">Returned</span>
        </div>

        <div className="flex items-center gap-3 text-sm">
          <span className="text-skynet-accent font-mono">{meta.partNumber}</span>
          {meta.partDescription && <span className="text-gray-500 truncate">{meta.partDescription}</span>}
        </div>

        <div className="space-y-1 rounded-lg bg-gray-800/40 border border-gray-800 p-2">
          {rows.map(r => {
            const rm = getSendDisplayMeta(r)
            return (
              <div key={r.id} className="flex items-center gap-2 text-[11px] flex-wrap">
                <span className="text-white font-mono">{rm.jobNumber}</span>
                {r.batchLetter && (
                  <span className="px-1.5 py-0.5 rounded font-mono bg-cyan-900/40 text-cyan-300">Batch {r.batchLetter}</span>
                )}
                <span className="text-cyan-400 font-mono">FLN: {rm.lotValue || '—'}</span>
                <span className="text-gray-400 ml-auto">{r.quantity_returned ?? r.quantity} pcs</span>
              </div>
            )
          })}
          <div className="flex items-center justify-between pt-1 mt-1 border-t border-gray-700">
            <span className="text-[11px] text-gray-400">Total returned ({rows.length} batches)</span>
            <span className="text-xs text-white font-semibold">{totalReturned} pcs</span>
          </div>
        </div>

        {head.vendor_lot_number && (
          <div className="text-xs text-gray-400">Vendor Lot/Cert: <span className="text-white font-medium">{head.vendor_lot_number}</span></div>
        )}
        <div className="flex items-center gap-4 text-xs text-gray-400">
          <span>Returned: <span className="text-green-300">{formatDateLocal(head.returned_at)}</span></span>
          {head.returned_by_profile?.full_name && <span className="text-gray-600">by {head.returned_by_profile.full_name}</span>}
        </div>

        {certRow && (
          <button onClick={() => handleViewCert(certRow.cert_document_path)} className="flex items-center gap-1.5 text-xs text-skynet-accent hover:text-blue-400 transition-colors">
            <FileText size={12} /> View Cert
          </button>
        )}
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Clock size={32} className="animate-spin text-gray-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-white flex items-center gap-2">
          <Truck size={22} className="text-skynet-accent" />
          Outsourced Operations
        </h2>
        <p className="text-gray-500 text-sm mt-1">
          Track parts sent to external vendors for heat treatment, plating, painting, or other processes.
        </p>
      </div>

      {/* ── SECTION 1: Ready to Send ── */}
      <div>
        <div className="flex items-center gap-2 mb-3 px-2 py-1.5 bg-gray-800 rounded-lg">
          <Plus size={14} className="text-amber-400" />
          <span className="text-white font-medium text-sm">Ready to Send</span>
          <span className="text-gray-500 text-xs">({readySteps.length})</span>
          {canEdit && readySteps.filter(r => r.sourceKind === 'finishing').length >= 2 && (
            <button
              onClick={() => setCombineModalOpen(true)}
              className="ml-auto flex items-center gap-1.5 px-2.5 py-1 bg-skynet-accent hover:bg-blue-600 text-white text-xs font-medium rounded-lg transition-colors"
            >
              <Combine size={12} />
              Combine Like Products
            </button>
          )}
        </div>

        {readySteps.length === 0 ? (
          <p className="text-gray-600 text-sm italic text-center py-6">No batches waiting to be sent out</p>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {readySteps.map(row => {
              const { rowKey } = row
              const meta = getSendDisplayMeta(row)
              const isOpen = sendFormOpen === rowKey
              const form = sendForm[rowKey] || {}
              const suggestions = getVendorSuggestions(meta.stepName)
              const datalistId = `vendor-${rowKey}`
              const displayQty = row.sourceKind === 'finishing'
                ? getBatchQty(row.batch)
                : (row.send?.quantity || 0)
              const batchQty = displayQty
              const job = row.job
              const step = row.step

              return (
                <div key={rowKey} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                      {getStepBadge(meta.stepName)}
                      {row.sourceKind === 'assembly' && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-purple-900/30 text-purple-300 border-purple-800">
                          Assembly
                        </span>
                      )}
                    </div>
                    <span className="text-xs px-2 py-0.5 rounded bg-amber-900/30 text-amber-400 flex-shrink-0">
                      Ready to Send
                    </span>
                  </div>

                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-skynet-accent font-mono">{meta.partNumber}</span>
                    {meta.partDescription && (
                      <span className="text-gray-500 truncate">{meta.partDescription}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-gray-400 flex-wrap">
                    {meta.jobNumber && <span className="font-mono text-white">{meta.jobNumber}</span>}
                    {meta.batchPill && (
                      <>
                        {meta.jobNumber && <span>·</span>}
                        <span className={`px-1.5 py-0.5 rounded font-mono ${
                          row.sourceKind === 'assembly'
                            ? 'bg-purple-900/40 text-purple-300'
                            : 'bg-cyan-900/40 text-cyan-300'
                        }`}>{meta.batchPill}</span>
                      </>
                    )}
                    <span>·</span>
                    {meta.lotValue ? (
                      <span className={`font-mono ${row.sourceKind === 'assembly' ? 'text-purple-300' : 'text-cyan-400'}`}>
                        {meta.lotLabel}: {meta.lotValue}
                      </span>
                    ) : (
                      <span className="text-gray-600 italic">{meta.lotLabel} pending</span>
                    )}
                    <span>·</span>
                    <span>{displayQty} pcs</span>
                    {meta.woNumber && <><span>·</span><span>{meta.woNumber}</span></>}
                    {meta.customer && <><span>·</span><span>{meta.customer}</span></>}
                  </div>

                  {canEdit && !isOpen && (
                    <div className="pt-2 border-t border-gray-800">
                      <button
                        onClick={() => {
                          setSendFormOpen(rowKey)
                          setSendForm(prev => ({
                            ...prev,
                            [rowKey]: {
                              vendor_name: suggestions[0] || '',
                              quantity: String(displayQty || ''),
                              sent_date: new Date().toISOString().split('T')[0],
                              expected_return: '',
                              notes: '',
                            }
                          }))
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-skynet-accent hover:bg-blue-600 text-white text-xs font-medium rounded-lg transition-colors"
                      >
                        <Truck size={13} />
                        Log Send-Out
                      </button>
                    </div>
                  )}

                  {canEdit && isOpen && (
                    <div className="pt-2 border-t border-gray-800 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-gray-500 text-[10px] mb-1">Vendor Name *</label>
                          <input
                            type="text"
                            list={datalistId}
                            value={form.vendor_name || ''}
                            onChange={e => setSendForm(prev => ({ ...prev, [rowKey]: { ...form, vendor_name: e.target.value } }))}
                            placeholder="Vendor"
                            className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-skynet-accent focus:outline-none"
                          />
                          <datalist id={datalistId}>
                            {suggestions.map(v => <option key={v} value={v} />)}
                          </datalist>
                        </div>
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <label className="block text-gray-500 text-[10px]">Quantity Sent *</label>
                            <span className="text-[10px] text-gray-600">
                              {row.sourceKind === 'assembly'
                                ? <>Available: {batchQty}</>
                                : <>Batch: {batchQty} · Job order: {job?.quantity ?? '—'}</>
                              }
                            </span>
                          </div>
                          <input
                            type="number"
                            min="1"
                            value={form.quantity || ''}
                            onChange={e => setSendForm(prev => ({ ...prev, [rowKey]: { ...form, quantity: e.target.value } }))}
                            className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs text-center focus:border-skynet-accent focus:outline-none"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-gray-500 text-[10px] mb-1">Date Sent</label>
                          <input
                            type="date"
                            value={form.sent_date || ''}
                            onChange={e => setSendForm(prev => ({ ...prev, [rowKey]: { ...form, sent_date: e.target.value } }))}
                            className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-skynet-accent focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-gray-500 text-[10px] mb-1">Expected Return</label>
                          <input
                            type="date"
                            value={form.expected_return || ''}
                            onChange={e => setSendForm(prev => ({ ...prev, [rowKey]: { ...form, expected_return: e.target.value } }))}
                            className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-skynet-accent focus:outline-none"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-gray-500 text-[10px] mb-1">Notes</label>
                        <textarea
                          value={form.notes || ''}
                          onChange={e => setSendForm(prev => ({ ...prev, [rowKey]: { ...form, notes: e.target.value } }))}
                          placeholder="Optional notes..."
                          rows={2}
                          className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-skynet-accent focus:outline-none resize-none"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleLogSendOut(row)}
                          disabled={saving || !form.vendor_name?.trim() || !form.quantity}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-skynet-accent hover:bg-blue-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
                        >
                          {saving ? <Clock size={13} className="animate-spin" /> : <Truck size={13} />}
                          Submit
                        </button>
                        <button
                          onClick={() => setSendFormOpen(null)}
                          className="px-3 py-1.5 text-gray-400 hover:text-white text-xs transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── SECTION 2: At Vendor ── */}
      <div>
        <div className="flex items-center gap-2 mb-3 px-2 py-1.5 bg-gray-800 rounded-lg">
          <Truck size={14} className="text-blue-400" />
          <span className="text-white font-medium text-sm">At Vendor</span>
          <span className="text-gray-500 text-xs">({atVendorCards.length})</span>
        </div>

        {groupReturnOpen && (() => {
          const gid = groupReturnOpen
          const groupRows = atVendor.filter(s => s.consolidation_group_id === gid)
          const form = groupReturnForm[gid] || {}
          if (!groupRows.length) return null
          return (
            <div className="mb-4 bg-gray-900 border-2 border-skynet-accent/60 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-white flex items-center gap-2">
                  <Combine size={14} className="text-skynet-accent" />
                  Receive Whole Lot ({groupRows.length} batches)
                </h4>
                <button
                  onClick={() => setGroupReturnOpen(null)}
                  className="text-gray-400 hover:text-white text-xs"
                >Cancel</button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-gray-500 text-[10px] mb-1">Vendor Lot/Cert # *</label>
                  <input
                    type="text"
                    value={form.vendor_lot_number || ''}
                    onChange={e => setGroupReturnForm(prev => ({ ...prev, [gid]: { ...form, vendor_lot_number: e.target.value } }))}
                    placeholder="Lot or cert #"
                    className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-skynet-accent focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-gray-500 text-[10px] mb-1">Return Date</label>
                  <input
                    type="date"
                    value={form.return_date || ''}
                    onChange={e => setGroupReturnForm(prev => ({ ...prev, [gid]: { ...form, return_date: e.target.value } }))}
                    className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-skynet-accent focus:outline-none"
                  />
                </div>
              </div>
              {(() => {
                const sentTotal = groupRows.reduce((a, r) => a + (r.quantity || 0), 0)
                return (
                  <>
                    <div>
                      <label className="block text-gray-500 text-[10px] mb-1">Total Qty Returned *</label>
                      <input
                        type="number"
                        min="0"
                        value={form.total_returned ?? ''}
                        onChange={e => setGroupReturnForm(prev => ({ ...prev, [gid]: { ...form, total_returned: e.target.value } }))}
                        className="w-40 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs text-center focus:border-skynet-accent focus:outline-none"
                      />
                      <p className="text-[10px] text-gray-500 mt-1">
                        Received as one lot — defaults to total sent ({sentTotal} pcs across {groupRows.length} batches). Per-batch quantities are recorded automatically.
                      </p>
                    </div>
                    <div className="space-y-1 pt-1">
                      {groupRows.map(r => {
                        const meta = getSendDisplayMeta(r)
                        return (
                          <div key={r.id} className="flex items-center gap-3 px-3 py-1 rounded bg-gray-800/40 border border-gray-800 text-[11px]">
                            <span className="text-gray-300 font-mono flex-1">
                              {meta.jobNumber} · Batch {r.batchLetter} · FLN {meta.lotValue}
                            </span>
                            <span className="text-gray-500">{r.quantity} pcs</span>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )
              })()}
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => handleReturnGroup(gid)}
                  disabled={saving || !form.vendor_lot_number?.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-skynet-accent hover:bg-blue-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
                >
                  {saving ? <Clock size={13} className="animate-spin" /> : <Check size={13} />}
                  Confirm Lot Return
                </button>
              </div>
            </div>
          )
        })()}

        {atVendor.length === 0 ? (
          <p className="text-gray-600 text-sm italic text-center py-6">No parts currently at vendors</p>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {atVendorCards.map(send => {
              if (send.isGroup) return renderAtVendorGroupCard(send)
              const isReturning = returnFormOpen === send.id
              const form = returnForm[send.id] || {}
              const isUploading = uploadingCertId === send.id
              const overdue = isPastToday(send.expected_return_at)

              const meta = getSendDisplayMeta(send)
              return (
                <div key={send.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      {getStepBadge(meta.stepName, send.operation_type)}
                      {send.sourceKind === 'assembly' && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-purple-900/30 text-purple-300 border-purple-800">
                          Assembly
                        </span>
                      )}
                      {send.vendor_name && (
                        <span className="text-sm text-white font-medium">{send.vendor_name}</span>
                      )}
                      {send.consolidation_group_id && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-skynet-accent/10 text-skynet-accent border-skynet-accent/40 flex items-center gap-1">
                          <Combine size={10} />
                          Consolidated ({groupSizeMap[send.consolidation_group_id] || 1})
                        </span>
                      )}
                    </div>
                    <span className="text-xs px-2 py-0.5 rounded bg-blue-900/30 text-blue-300 flex-shrink-0">
                      At Vendor
                    </span>
                  </div>

                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-skynet-accent font-mono">{meta.partNumber}</span>
                    {meta.partDescription && (
                      <span className="text-gray-500 truncate">{meta.partDescription}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
                    {meta.jobNumber && <span className="text-white font-mono">{meta.jobNumber}</span>}
                    {meta.batchPill && (
                      <span className={`px-1.5 py-0.5 rounded font-mono ${
                        send.sourceKind === 'assembly'
                          ? 'bg-purple-900/40 text-purple-300'
                          : 'bg-cyan-900/40 text-cyan-300'
                      }`}>{meta.batchPill}</span>
                    )}
                    {meta.lotValue && (
                      <span className={`font-mono ${send.sourceKind === 'assembly' ? 'text-purple-300' : 'text-cyan-400'}`}>
                        {meta.lotLabel}: {meta.lotValue}
                      </span>
                    )}
                    {meta.woNumber && <span>· {meta.woNumber}</span>}
                    {meta.customer && <span>· {meta.customer}</span>}
                    <span>· Qty: {send.quantity}</span>
                  </div>

                  <div className="flex items-center gap-4 text-xs flex-wrap">
                    <span className="text-gray-400">
                      Sent: <span className="text-gray-300">{formatDateLocal(send.sent_at)}</span>
                      {send.sent_by_profile?.full_name && (
                        <span className="text-gray-600"> by {send.sent_by_profile.full_name}</span>
                      )}
                    </span>
                    {(send.expected_return_at || canEdit) && (
                      editingExpectedId === send.id ? (
                        <span className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-gray-400 text-xs">Expected:</span>
                          <input
                            type="date"
                            value={editingExpectedValue}
                            onChange={e => setEditingExpectedValue(e.target.value)}
                            className="px-1.5 py-0.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-skynet-accent focus:outline-none"
                            autoFocus
                          />
                          <button
                            onClick={() => handleUpdateExpectedReturn(send, editingExpectedValue || null)}
                            disabled={saving}
                            className="text-skynet-accent hover:text-blue-400 disabled:opacity-50"
                            title="Save"
                          >
                            <Check size={13} />
                          </button>
                          <button
                            onClick={() => { setEditingExpectedId(null); setEditingExpectedValue('') }}
                            className="text-gray-500 hover:text-white"
                            title="Cancel"
                          >
                            <X size={13} />
                          </button>
                          {send.consolidation_group_id && (
                            <span className="text-[10px] text-gray-500 italic">applies to whole group</span>
                          )}
                        </span>
                      ) : (
                        <span className={`flex items-center gap-1 ${overdue ? 'text-red-400 font-medium' : 'text-gray-400'}`}>
                          {overdue && <AlertCircle size={12} />}
                          Expected:{' '}
                          <span className={overdue ? '' : 'text-gray-300'}>
                            {send.expected_return_at ? formatDateOnly(send.expected_return_at) : '—'}
                          </span>
                          {canEdit && (
                            <button
                              onClick={() => {
                                setEditingExpectedId(send.id)
                                setEditingExpectedValue(send.expected_return_at || '')
                              }}
                              className="ml-1 text-gray-500 hover:text-skynet-accent transition-colors"
                              title="Edit expected return date"
                            >
                              <Pencil size={11} />
                            </button>
                          )}
                        </span>
                      )
                    )}
                  </div>

                  {send.notes && <p className="text-xs text-gray-500 italic">{send.notes}</p>}

                  {send.cert_document_path && (
                    <button
                      onClick={() => handleViewCert(send.cert_document_path)}
                      className="flex items-center gap-1.5 text-xs text-skynet-accent hover:text-blue-400 transition-colors"
                    >
                      <FileText size={12} />
                      View Cert
                    </button>
                  )}

                  {canEdit && (
                    <div className="flex items-center gap-2 pt-2 border-t border-gray-800">
                      {!isReturning ? (
                        <>
                          <button
                            onClick={() => {
                              setReturnFormOpen(send.id)
                              setReturnForm(prev => ({
                                ...prev,
                                [send.id]: {
                                  vendor_lot_number: '',
                                  quantity_returned: String(send.quantity || ''),
                                  return_date: new Date().toISOString().split('T')[0],
                                }
                              }))
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded-lg transition-colors"
                          >
                            <RotateCcw size={13} />
                            Log Return
                          </button>
                          {send.consolidation_group_id && (groupSizeMap[send.consolidation_group_id] || 0) > 1 && (
                            <button
                              onClick={() => {
                                const gid = send.consolidation_group_id
                                setGroupReturnOpen(gid)
                                const groupRows = atVendor.filter(s => s.consolidation_group_id === gid)
                                const initial = {
                                  vendor_lot_number: '',
                                  return_date: new Date().toISOString().split('T')[0],
                                }
                                for (const r of groupRows) {
                                  initial[`qty_${r.id}`] = String(r.quantity || '')
                                }
                                setGroupReturnForm(prev => ({ ...prev, [gid]: initial }))
                              }}
                              className="flex items-center gap-1.5 px-3 py-1.5 bg-skynet-accent hover:bg-blue-600 text-white text-xs font-medium rounded-lg transition-colors"
                            >
                              <Combine size={13} />
                              Return Whole Group
                            </button>
                          )}
                          <label className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                            isUploading ? 'bg-gray-700 text-gray-400' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                          }`}>
                            {isUploading ? <Clock size={13} className="animate-spin" /> : <Upload size={13} />}
                            {send.cert_document_path ? 'Replace Cert' : 'Attach Cert'}
                            <input
                              type="file"
                              accept=".pdf"
                              className="hidden"
                              disabled={isUploading}
                              onChange={(e) => handleAttachCert(send.id, e.target.files?.[0])}
                            />
                          </label>
                        </>
                      ) : (
                        <div className="w-full space-y-2">
                          <div className="grid grid-cols-3 gap-2">
                            <div>
                              <label className="block text-gray-500 text-[10px] mb-1">Vendor Lot/Cert # *</label>
                              <input
                                type="text"
                                value={form.vendor_lot_number || ''}
                                onChange={e => setReturnForm(prev => ({ ...prev, [send.id]: { ...form, vendor_lot_number: e.target.value } }))}
                                placeholder="Lot or cert #"
                                className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-green-500 focus:outline-none"
                              />
                            </div>
                            <div>
                              <label className="block text-gray-500 text-[10px] mb-1">Qty Returned *</label>
                              <input
                                type="number"
                                min="1"
                                value={form.quantity_returned || ''}
                                onChange={e => setReturnForm(prev => ({ ...prev, [send.id]: { ...form, quantity_returned: e.target.value } }))}
                                className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs text-center focus:border-green-500 focus:outline-none"
                              />
                            </div>
                            <div>
                              <label className="block text-gray-500 text-[10px] mb-1">Return Date</label>
                              <input
                                type="date"
                                value={form.return_date || ''}
                                onChange={e => setReturnForm(prev => ({ ...prev, [send.id]: { ...form, return_date: e.target.value } }))}
                                className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-green-500 focus:outline-none"
                              />
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleLogReturn(send)}
                              disabled={saving}
                              className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
                            >
                              {saving ? <Clock size={13} className="animate-spin" /> : <Check size={13} />}
                              Confirm Return
                            </button>
                            <button
                              onClick={() => setReturnFormOpen(null)}
                              className="px-3 py-1.5 text-gray-400 hover:text-white text-xs transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── SECTION 3: Returned (collapsible) ── */}
      <div>
        <button
          onClick={() => setShowReturned(!showReturned)}
          className="flex items-center gap-2 mb-3 px-2 py-1.5 bg-gray-800 rounded-lg w-full text-left hover:bg-gray-750 transition-colors"
        >
          {showReturned ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
          <Check size={14} className="text-green-400" />
          <span className="text-white font-medium text-sm">{showReturned ? 'Hide' : 'Show'} Returned</span>
          <span className="text-gray-500 text-xs">({returnedCards.length})</span>
        </button>

        {showReturned && (
          returned.length === 0 ? (
            <p className="text-gray-600 text-sm italic text-center py-4">No returned sends yet</p>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {returnedCards.map(send => {
                if (send.isGroup) return renderReturnedGroupCard(send)
                const meta = getSendDisplayMeta(send)
                return (
                <div key={send.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      {getStepBadge(meta.stepName, send.operation_type)}
                      {send.sourceKind === 'assembly' && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-purple-900/30 text-purple-300 border-purple-800">
                          Assembly
                        </span>
                      )}
                      {send.vendor_name && (
                        <span className="text-sm text-white font-medium">{send.vendor_name}</span>
                      )}
                      {send.consolidation_group_id && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-skynet-accent/10 text-skynet-accent border-skynet-accent/40 flex items-center gap-1">
                          <Combine size={10} />
                          Consolidated ({groupSizeMap[send.consolidation_group_id] || 1})
                        </span>
                      )}
                    </div>
                    <span className="text-xs px-2 py-0.5 rounded bg-green-900/30 text-green-400 flex-shrink-0">
                      Returned
                    </span>
                  </div>

                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-skynet-accent font-mono">{meta.partNumber}</span>
                    {meta.partDescription && (
                      <span className="text-gray-500 truncate">{meta.partDescription}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
                    {meta.jobNumber && <span className="text-white font-mono">{meta.jobNumber}</span>}
                    {meta.batchPill && (
                      <span className={`px-1.5 py-0.5 rounded font-mono ${
                        send.sourceKind === 'assembly'
                          ? 'bg-purple-900/40 text-purple-300'
                          : 'bg-cyan-900/40 text-cyan-300'
                      }`}>{meta.batchPill}</span>
                    )}
                    {meta.lotValue && (
                      <span className={`font-mono ${send.sourceKind === 'assembly' ? 'text-purple-300' : 'text-cyan-400'}`}>
                        {meta.lotLabel}: {meta.lotValue}
                      </span>
                    )}
                    {meta.woNumber && <span>· {meta.woNumber}</span>}
                    {meta.customer && <span>· {meta.customer}</span>}
                  </div>

                  {send.vendor_lot_number && (
                    <div className="text-xs text-gray-400">
                      Vendor Lot/Cert: <span className="text-white font-medium">{send.vendor_lot_number}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-4 text-xs text-gray-400">
                    <span>Qty: {send.quantity_returned ?? send.quantity}</span>
                    <span>Returned: <span className="text-green-300">{formatDateLocal(send.returned_at)}</span></span>
                    {send.returned_by_profile?.full_name && (
                      <span className="text-gray-600">by {send.returned_by_profile.full_name}</span>
                    )}
                  </div>

                  {send.cert_document_path && (
                    <button
                      onClick={() => handleViewCert(send.cert_document_path)}
                      className="flex items-center gap-1.5 text-xs text-skynet-accent hover:text-blue-400 transition-colors"
                    >
                      <FileText size={12} />
                      View Cert
                    </button>
                  )}
                </div>
                )
              })}
            </div>
          )
        )}
      </div>

      {combineModalOpen && (
        <CombineLikeProductsModal
          readySteps={readySteps}
          profile={profile}
          onClose={() => setCombineModalOpen(false)}
          onSuccess={async () => {
            await fetchAll()
            setCombineModalOpen(false)
          }}
        />
      )}
    </div>
  )
}
