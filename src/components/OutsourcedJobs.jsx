import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { uploadDocument, getDocumentUrl } from '../lib/s3'
import { Truck, Upload, Check, AlertCircle, ChevronDown, ChevronRight, FileText, Clock, RotateCcw, Plus } from 'lucide-react'

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

function isPastToday(dateStr) {
  if (!dateStr) return false
  return new Date(dateStr) < new Date(new Date().toDateString())
}

export default function OutsourcedJobs({ profile }) {
  const [readySteps, setReadySteps] = useState([])
  const [atVendor, setAtVendor] = useState([])
  const [returned, setReturned] = useState([])
  const [loading, setLoading] = useState(true)
  const [showReturned, setShowReturned] = useState(false)
  const [approvedQtyMap, setApprovedQtyMap] = useState({})

  // Inline form states keyed by step id or send id
  const [sendFormOpen, setSendFormOpen] = useState(null)
  const [sendForm, setSendForm] = useState({})
  const [returnFormOpen, setReturnFormOpen] = useState(null)
  const [returnForm, setReturnForm] = useState({})
  const [saving, setSaving] = useState(false)
  const [uploadingCertId, setUploadingCertId] = useState(null)

  const canEdit = profile?.can_approve_compliance === true || profile?.role === 'admin'

  const getApprovedQty = (job) => {
    if (!job?.id) return job?.quantity
    const mapped = approvedQtyMap[job.id]
    return (mapped && mapped > 0) ? mapped : job?.quantity
  }

  const fetchApprovedQtys = async () => {
    const { data, error } = await supabase
      .from('finishing_sends')
      .select('job_id, compliance_good_qty, compliance_status, quantity')
      .eq('compliance_status', 'approved')

    if (error || !data) return

    const map = {}
    data.forEach(s => {
      const qty = s.compliance_good_qty || s.quantity || 0
      map[s.job_id] = (map[s.job_id] || 0) + qty
    })
    setApprovedQtyMap(map)
  }

  const fetchAll = async () => {
    try {
      await Promise.all([fetchReadyToSend(), fetchAtVendor(), fetchReturned(), fetchApprovedQtys()])
    } finally {
      setLoading(false)
    }
  }

  const fetchReadyToSend = async () => {
    const { data, error } = await supabase
      .from('job_routing_steps')
      .select(`
        id, step_name, step_order, step_type, status,
        job:jobs!inner(
          id, job_number, quantity, status,
          part:parts!component_id(part_number, description, part_type),
          work_order:work_orders(id, wo_number, customer)
        )
      `)
      .eq('step_type', 'external')
      .in('status', ['pending', 'in_progress'])
      .eq('job.status', 'ready_for_outsourcing')
      .order('step_order', { ascending: true })

    if (error) {
      console.error('Error fetching ready steps:', error)
      return
    }
    setReadySteps(data || [])
  }

  const fetchAtVendor = async () => {
    const { data, error } = await supabase
      .from('outbound_sends')
      .select(`
        *,
        job:jobs(
          id, job_number, quantity, status,
          part:parts!component_id(part_number, description, part_type),
          work_order:work_orders(id, wo_number, customer)
        ),
        job_routing_step:job_routing_steps(id, step_name, step_order),
        sent_by_profile:profiles!outbound_sends_sent_by_fkey(full_name)
      `)
      .not('sent_at', 'is', null)
      .is('returned_at', null)
      .order('expected_return_at', { ascending: true })

    if (error) {
      console.error('Error fetching at-vendor sends:', error)
      return
    }
    setAtVendor(data || [])
  }

  const fetchReturned = async () => {
    const { data, error } = await supabase
      .from('outbound_sends')
      .select(`
        *,
        job:jobs(
          id, job_number, quantity, status,
          part:parts!component_id(part_number, description, part_type),
          work_order:work_orders(id, wo_number, customer)
        ),
        job_routing_step:job_routing_steps(id, step_name, step_order),
        sent_by_profile:profiles!outbound_sends_sent_by_fkey(full_name),
        returned_by_profile:profiles!outbound_sends_returned_by_fkey(full_name)
      `)
      .not('returned_at', 'is', null)
      .order('returned_at', { ascending: false })
      .limit(20)

    if (error) {
      console.error('Error fetching returned sends:', error)
      return
    }
    setReturned(data || [])
  }

  useEffect(() => {
    fetchAll()

    const channel = supabase.channel('outsourced-channel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'outbound_sends' }, fetchAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs', filter: 'status=eq.ready_for_outsourcing' }, fetchAll)
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [])

  // --- ACTIONS ---

  const handleLogSendOut = async (step) => {
    const form = sendForm[step.id] || {}
    if (!form.vendor_name?.trim() || !form.quantity) return
    setSaving(true)
    try {
      const jobId = step.job.id
      const workOrderId = step.job.work_order?.id || null

      const { error: insertErr } = await supabase
        .from('outbound_sends')
        .insert({
          job_id: jobId,
          work_order_id: workOrderId,
          job_routing_step_id: step.id,
          operation_type: deriveOperationType(step.step_name),
          vendor_name: form.vendor_name.trim(),
          quantity: parseInt(form.quantity),
          sent_at: form.sent_date ? `${form.sent_date}T00:00:00Z` : new Date().toISOString(),
          sent_by: profile.id,
          expected_return_at: form.expected_return || null,
          notes: form.notes?.trim() || null,
        })
      if (insertErr) throw insertErr

      const { error: stepErr } = await supabase
        .from('job_routing_steps')
        .update({ status: 'in_progress' })
        .eq('id', step.id)
      if (stepErr) throw stepErr

      const { error: jobErr } = await supabase
        .from('jobs')
        .update({ status: 'at_external_vendor', updated_at: new Date().toISOString() })
        .eq('id', jobId)
      if (jobErr) throw jobErr

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
      const returnDate = form.return_date ? `${form.return_date}T00:00:00Z` : new Date().toISOString()

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

      // b. Complete the routing step
      if (send.job_routing_step_id) {
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
      }

      // c. Check remaining external steps to determine next job status
      const jobId = send.job?.id || send.job_id
      const { data: remaining } = await supabase
        .from('job_routing_steps')
        .select('id')
        .eq('job_id', jobId)
        .eq('step_type', 'external')
        .not('status', 'in', '("complete","removed","skipped")')

      let nextStatus
      if (remaining && remaining.length > 0) {
        nextStatus = 'ready_for_outsourcing'
      } else {
        const partType = send.job?.part?.part_type
        nextStatus = partType === 'finished_good' ? 'pending_tco' : 'ready_for_assembly'
      }

      const { error: jobErr } = await supabase
        .from('jobs')
        .update({ status: nextStatus, updated_at: new Date().toISOString() })
        .eq('id', jobId)
      if (jobErr) throw jobErr

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

  const handleAttachCert = async (sendId, file) => {
    if (!file) return
    setUploadingCertId(sendId)
    try {
      const path = `outbound-certs/${sendId}/${file.name}`
      await uploadDocument(file, path)
      const { error } = await supabase
        .from('outbound_sends')
        .update({ cert_document_path: path, updated_at: new Date().toISOString() })
        .eq('id', sendId)
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
        </div>

        {readySteps.length === 0 ? (
          <p className="text-gray-600 text-sm italic text-center py-6">No jobs waiting to be sent out</p>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {readySteps.map(step => {
              const job = step.job
              const isOpen = sendFormOpen === step.id
              const form = sendForm[step.id] || {}
              const suggestions = getVendorSuggestions(step.step_name)
              const datalistId = `vendor-${step.id}`

              return (
                <div key={step.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    {getStepBadge(step.step_name)}
                    <span className="text-xs px-2 py-0.5 rounded bg-amber-900/30 text-amber-400 flex-shrink-0">
                      Ready to Send
                    </span>
                  </div>

                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-skynet-accent font-mono">{job?.part?.part_number}</span>
                    {job?.part?.description && (
                      <span className="text-gray-500 truncate">{job.part.description}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <span className="text-white font-mono">{job?.job_number}</span>
                    {job?.work_order?.wo_number && <span>· {job.work_order.wo_number}</span>}
                    {job?.work_order?.customer && <span>· {job.work_order.customer}</span>}
                    <span>· Qty: {getApprovedQty(job)}</span>
                  </div>

                  {canEdit && !isOpen && (
                    <div className="pt-2 border-t border-gray-800">
                      <button
                        onClick={() => {
                          setSendFormOpen(step.id)
                          setSendForm(prev => ({
                            ...prev,
                            [step.id]: {
                              vendor_name: suggestions[0] || '',
                              quantity: String(getApprovedQty(job) || ''),
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
                            onChange={e => setSendForm(prev => ({ ...prev, [step.id]: { ...form, vendor_name: e.target.value } }))}
                            placeholder="Vendor"
                            className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-skynet-accent focus:outline-none"
                          />
                          <datalist id={datalistId}>
                            {suggestions.map(v => <option key={v} value={v} />)}
                          </datalist>
                        </div>
                        <div>
                          <label className="block text-gray-500 text-[10px] mb-1">Quantity Sent *</label>
                          <input
                            type="number"
                            min="1"
                            value={form.quantity || ''}
                            onChange={e => setSendForm(prev => ({ ...prev, [step.id]: { ...form, quantity: e.target.value } }))}
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
                            onChange={e => setSendForm(prev => ({ ...prev, [step.id]: { ...form, sent_date: e.target.value } }))}
                            className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-skynet-accent focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-gray-500 text-[10px] mb-1">Expected Return</label>
                          <input
                            type="date"
                            value={form.expected_return || ''}
                            onChange={e => setSendForm(prev => ({ ...prev, [step.id]: { ...form, expected_return: e.target.value } }))}
                            className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-skynet-accent focus:outline-none"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-gray-500 text-[10px] mb-1">Notes</label>
                        <textarea
                          value={form.notes || ''}
                          onChange={e => setSendForm(prev => ({ ...prev, [step.id]: { ...form, notes: e.target.value } }))}
                          placeholder="Optional notes..."
                          rows={2}
                          className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-skynet-accent focus:outline-none resize-none"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleLogSendOut(step)}
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
          <span className="text-gray-500 text-xs">({atVendor.length})</span>
        </div>

        {atVendor.length === 0 ? (
          <p className="text-gray-600 text-sm italic text-center py-6">No parts currently at vendors</p>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {atVendor.map(send => {
              const isReturning = returnFormOpen === send.id
              const form = returnForm[send.id] || {}
              const isUploading = uploadingCertId === send.id
              const overdue = isPastToday(send.expected_return_at)

              return (
                <div key={send.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      {getStepBadge(send.job_routing_step?.step_name, send.operation_type)}
                      {send.vendor_name && (
                        <span className="text-sm text-white font-medium">{send.vendor_name}</span>
                      )}
                    </div>
                    <span className="text-xs px-2 py-0.5 rounded bg-blue-900/30 text-blue-300 flex-shrink-0">
                      At Vendor
                    </span>
                  </div>

                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-skynet-accent font-mono">{send.job?.part?.part_number}</span>
                    {send.job?.part?.description && (
                      <span className="text-gray-500 truncate">{send.job.part.description}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <span className="text-white font-mono">{send.job?.job_number}</span>
                    {send.job?.work_order?.wo_number && <span>· {send.job.work_order.wo_number}</span>}
                    {send.job?.work_order?.customer && <span>· {send.job.work_order.customer}</span>}
                    <span>· Qty: {send.quantity}</span>
                  </div>

                  <div className="flex items-center gap-4 text-xs flex-wrap">
                    <span className="text-gray-400">
                      Sent: <span className="text-gray-300">{formatDate(send.sent_at)}</span>
                      {send.sent_by_profile?.full_name && (
                        <span className="text-gray-600"> by {send.sent_by_profile.full_name}</span>
                      )}
                    </span>
                    {send.expected_return_at && (
                      <span className={`flex items-center gap-1 ${overdue ? 'text-red-400 font-medium' : 'text-gray-400'}`}>
                        {overdue && <AlertCircle size={12} />}
                        Expected: <span className={overdue ? '' : 'text-gray-300'}>{formatDate(send.expected_return_at)}</span>
                      </span>
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
          <span className="text-gray-500 text-xs">({returned.length})</span>
        </button>

        {showReturned && (
          returned.length === 0 ? (
            <p className="text-gray-600 text-sm italic text-center py-4">No returned sends yet</p>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {returned.map(send => (
                <div key={send.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      {getStepBadge(send.job_routing_step?.step_name, send.operation_type)}
                      {send.vendor_name && (
                        <span className="text-sm text-white font-medium">{send.vendor_name}</span>
                      )}
                    </div>
                    <span className="text-xs px-2 py-0.5 rounded bg-green-900/30 text-green-400 flex-shrink-0">
                      Returned
                    </span>
                  </div>

                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-skynet-accent font-mono">{send.job?.part?.part_number}</span>
                    {send.job?.part?.description && (
                      <span className="text-gray-500 truncate">{send.job.part.description}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <span className="text-white font-mono">{send.job?.job_number}</span>
                    {send.job?.work_order?.wo_number && <span>· {send.job.work_order.wo_number}</span>}
                    {send.job?.work_order?.customer && <span>· {send.job.work_order.customer}</span>}
                  </div>

                  {send.vendor_lot_number && (
                    <div className="text-xs text-gray-400">
                      Vendor Lot/Cert: <span className="text-white font-medium">{send.vendor_lot_number}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-4 text-xs text-gray-400">
                    <span>Qty: {send.quantity_returned ?? send.quantity}</span>
                    <span>Returned: <span className="text-green-300">{formatDate(send.returned_at)}</span></span>
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
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}
