// src/lib/traveler.js — shared HTML builder for the Job Traveler popup.
// Used by Kiosk, Finishing, ComplianceReview. (PrintPackageModal has its own
// inner-page builder for embedding inside the Print Hub.)

const _esc = (str) => {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const _formatDate = (dateStr) => {
  if (!dateStr) return '&mdash;'
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// Pulls active CO allocations for a WO for inclusion in the traveler.
// Call from each surface that builds a traveler; pass the result as
// `coAllocations` on travelerData.
export async function fetchCOAllocationsForTraveler(supabase, workOrderId) {
  if (!workOrderId) return []
  const { data, error } = await supabase
    .from('customer_order_allocations')
    .select(`
      quantity_allocated,
      customer_order_line:customer_order_lines (
        line_number,
        customer_order:customer_orders (
          co_number,
          po_number,
          customer:customers ( name )
        )
      )
    `)
    .eq('work_order_id', workOrderId)
    .eq('is_active', true)
  if (error) {
    console.error('Error fetching traveler CO allocations:', error)
    return []
  }
  return data || []
}

export function buildTravelerHTML(travelerData) {
  const { job, steps, finishingBatches = [], outboundSends = [], coAllocations } = travelerData
  const wo = job.work_order
  const comp = job.component

  const headerLabelCSS = 'padding:4px 8px; font-weight:bold; background-color:#f0f0f0; border:1px solid #ccc; width:15%; white-space:nowrap;'
  const headerValueCSS = 'padding:4px 8px; border:1px solid #ccc; width:35%;'
  const routingHeaderCSS = 'padding:6px 8px; background-color:#222; color:#fff; font-weight:bold; border:1px solid #000; text-align:left;'
  const routingCellCSS = 'padding:8px; border:1px solid #000; height:28px; vertical-align:middle;'

  let qtyDisplay = String(job.quantity)
  if (wo?.order_type === 'make_to_order' && wo?.order_quantity && wo?.stock_quantity) {
    qtyDisplay = `${wo.order_quantity} order + ${wo.stock_quantity} stock = ${job.quantity} total`
  } else if (wo?.order_type === 'make_to_stock') {
    qtyDisplay = `${job.quantity} (stock)`
  }

  const customerDisplay = wo?.order_type === 'make_to_stock' ? 'STOCK' : _esc(wo?.customer) || '&mdash;'

  const initials = (name) => {
    if (!name) return ''
    return name.split(/\s+/).map(p => p[0]).filter(Boolean).join('').toUpperCase().slice(0, 3)
  }

  const shortDate = (iso) => {
    if (!iso) return ''
    return new Date(iso).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' })
  }

  // Sum qty across all eligible batches (any with finishing_completed_at, not rejected).
  // Qty precedence per batch: compliance_good_qty -> (verified - bad) -> verified_count.
  // FLN/date/operator come from the MOST RECENT batch (first in array since ordered desc).
  const eligibleBatches = finishingBatches.filter(b => b.finishing_completed_at)
  const fb = eligibleBatches[0] || null

  const sumFinishingQty = eligibleBatches.reduce((acc, b) => {
    if (b.compliance_good_qty != null) return acc + b.compliance_good_qty
    if (b.compliance_bad_qty != null && b.verified_count != null) {
      return acc + Math.max(0, b.verified_count - b.compliance_bad_qty)
    }
    if (b.verified_count != null) return acc + b.verified_count
    return acc
  }, 0)

  const finishingQty = eligibleBatches.length > 0 ? String(sumFinishingQty) : ''
  const finishingDate = fb ? shortDate(fb.compliance_approved_at || fb.finishing_completed_at) : ''
  const finishingOp = fb ? initials(fb.finishing_operator?.full_name) : ''

  // Sum of finishing_sends.quantity = total pieces handed off from the machine into finishing.
  // This is the right Machine Process Qty for in-progress jobs where job.good_pieces isn't fully set.
  const machineOutputQty = finishingBatches.reduce((acc, b) => {
    return acc + (b.quantity || 0)
  }, 0)

  // Build a per-batch letter map based on finishing approval order
  // (Batch A = first approved, Batch B = second, etc.)
  // This matches the labels shown elsewhere (WO Lookup, OutsourcedJobs).
  const batchLetterMap = (() => {
    const sorted = [...finishingBatches]
      .filter(b => b.compliance_approved_at)
      .sort((a, b) => new Date(a.compliance_approved_at) - new Date(b.compliance_approved_at))
    const map = {}
    sorted.forEach((b, i) => { map[b.id] = String.fromCharCode(65 + i) })
    return map
  })()

  const stepsHTML = steps.flatMap(step => {
    const stepName = (step.step_name || '').toLowerCase()
    const isWash = stepName === 'wash'
    const isTreatment = stepName === 'treatment' || stepName === 'passivation'
    const isDry = stepName === 'dry'
    const isMachineStep = !isWash && !isTreatment && !isDry && step.step_type !== 'external'
    const isExternalStep = step.step_type === 'external'

    // For external steps, find ALL outbound_sends for this step (not just the first)
    const stepSends = isExternalStep
      ? outboundSends
          .filter(os => os.job_routing_step_id === step.id)
          .sort((a, b) => new Date(a.sent_at || 0) - new Date(b.sent_at || 0))
      : []

    const renderRow = (linkedSend, batchSuffix) => {
      // For external steps with a linked send, the per-batch vendor lot wins over
      // step.lot_number (which holds only the most recent return's lot — unreliable
      // when multiple batches exist on the same step).
      let rowLot = ''
      if (isExternalStep && linkedSend?.vendor_lot_number) {
        rowLot = linkedSend.vendor_lot_number
      } else {
        rowLot = step.lot_number || ''
      }
      if (!rowLot && (isWash || isTreatment || isDry) && fb?.finishing_lot_number) rowLot = fb.finishing_lot_number
      if (!rowLot && isMachineStep && job.production_lot_number) rowLot = job.production_lot_number
      // Final fallback for external steps where the send exists but vendor_lot_number is null
      // (e.g., still at vendor) — use step.lot_number if it has a value, else blank
      if (!rowLot && isExternalStep && step.lot_number) rowLot = step.lot_number

      let rowQty = step.quantity != null ? String(step.quantity) : ''
      if (!rowQty && (isWash || isTreatment || isDry) && finishingQty !== '') rowQty = String(finishingQty)
      if (!rowQty && isMachineStep && job.good_pieces != null && job.good_pieces > 0) rowQty = String(job.good_pieces)
      if (!rowQty && isMachineStep && machineOutputQty > 0) rowQty = String(machineOutputQty)
      if (!rowQty && isExternalStep && linkedSend?.quantity_returned != null) rowQty = String(linkedSend.quantity_returned)

      let rowDate = shortDate(step.completed_at)
      if (!rowDate && (isWash || isTreatment || isDry)) rowDate = finishingDate
      if (!rowDate && isMachineStep && job.actual_end) rowDate = shortDate(job.actual_end)
      if (!rowDate && isExternalStep && linkedSend?.returned_at) rowDate = shortDate(linkedSend.returned_at)

      let rowOp = step.operator_initials || initials(step.completed_by_profile?.full_name) || ''
      if (!rowOp && (isWash || isTreatment || isDry)) rowOp = finishingOp
      if (!rowOp && isMachineStep && job.assigned_user?.full_name) rowOp = initials(job.assigned_user.full_name)

      const station = _esc(step.station)
        || (isMachineStep ? _esc(job.assigned_machine?.name) : '')
        || (isExternalStep ? _esc(linkedSend?.vendor_name) : '')
        || ''

      return `
    <tr>
      <td style="${routingCellCSS} text-align:center; width:40px;">${step.step_order}</td>
      <td style="${routingCellCSS}">${_esc(step.step_name)}${step.is_added_step ? ' *' : ''}${batchSuffix ? ' ' + batchSuffix : ''}</td>
      <td style="${routingCellCSS} width:90px;">${station}</td>
      <td style="${routingCellCSS} text-align:center; width:45px;">${step.step_type === 'external' ? 'EXT' : 'INT'}</td>
      <td style="${routingCellCSS} width:90px;">${_esc(rowLot)}</td>
      <td style="${routingCellCSS} width:55px; text-align:center;">${_esc(rowQty)}</td>
      <td style="${routingCellCSS} width:80px;">${_esc(rowDate)}</td>
      <td style="${routingCellCSS} width:90px; text-align:center;">${_esc(rowOp)}</td>
    </tr>
  `
    }

    // External step with multiple sends → one row per send, labeled (Batch A), (Batch B)
    if (isExternalStep && stepSends.length > 1) {
      // Sort sends by their linked finishing_send approval time so labels are stable
      // and match the canonical Batch A/B/C ordering used elsewhere.
      const sortedSends = [...stepSends].sort((a, b) => {
        const aT = a.finishing_send?.compliance_approved_at || ''
        const bT = b.finishing_send?.compliance_approved_at || ''
        return aT.localeCompare(bT)
      })
      return sortedSends.map(s => {
        const letter = s.finishing_send_id ? batchLetterMap[s.finishing_send_id] : null
        const label = letter ? `(Batch ${letter})` : ''
        return renderRow(s, label)
      })
    }

    // External step with exactly one send — label it if multiple batches exist on the job
    if (isExternalStep && stepSends.length === 1) {
      const s = stepSends[0]
      const letter = s.finishing_send_id ? batchLetterMap[s.finishing_send_id] : null
      const showLabel = letter && Object.keys(batchLetterMap).length > 1
      const label = showLabel ? `(Batch ${letter})` : ''
      return [renderRow(s, label)]
    }

    // External step with zero sends → single empty row
    if (isExternalStep) {
      return [renderRow(null, null)]
    }

    // Non-external step → single row
    return [renderRow(null, null)]
  }).join('')

  // Customer Orders Fulfilled by this Job — only renders when the call site
  // has fetched coAllocations (undefined means "not fetched" → omit the section
  // entirely so older callers don't lie about CO presence).
  const coSectionHTML = (() => {
    if (!Array.isArray(coAllocations)) return ''
    const cellHeaderCSS = 'padding:6px 8px; background-color:#222; color:#fff; font-weight:bold; border:1px solid #000; text-align:left;'
    const cellCSS = 'padding:6px 8px; border:1px solid #000;'
    if (coAllocations.length === 0) {
      return `
    <table style="width:100%; border-collapse:collapse; font-size:12px; margin-bottom:16px;">
      <thead>
        <tr><th colspan="5" style="${cellHeaderCSS}">Customer Orders Fulfilled by this Job</th></tr>
      </thead>
      <tbody>
        <tr><td style="${cellCSS} text-align:center; color:#666;" colspan="5">Stock build &mdash; no customer orders.</td></tr>
      </tbody>
    </table>`
    }
    const rows = coAllocations.map(a => {
      const line = a.customer_order_line || {}
      const co = line.customer_order || {}
      const cust = co.customer || {}
      return `
        <tr>
          <td style="${cellCSS}">${_esc(co.co_number) || '&mdash;'}</td>
          <td style="${cellCSS}">${_esc(cust.name) || '&mdash;'}</td>
          <td style="${cellCSS}">${_esc(co.po_number) || '&mdash;'}</td>
          <td style="${cellCSS} text-align:center;">${line.line_number != null ? line.line_number : '&mdash;'}</td>
          <td style="${cellCSS} text-align:right;">${(a.quantity_allocated || 0).toLocaleString()}</td>
        </tr>`
    }).join('')
    return `
    <table style="width:100%; border-collapse:collapse; font-size:12px; margin-bottom:16px;">
      <thead>
        <tr><th colspan="5" style="${cellHeaderCSS}">Customer Orders Fulfilled by this Job</th></tr>
        <tr>
          <th style="${cellHeaderCSS}">CO #</th>
          <th style="${cellHeaderCSS}">Customer</th>
          <th style="${cellHeaderCSS}">PO #</th>
          <th style="${cellHeaderCSS}">Line</th>
          <th style="${cellHeaderCSS}">Qty</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
  })()

  const blankRows = Array.from({ length: 3 }).map(() =>
    `<tr>${Array.from({ length: 8 }).map(() => `<td style="${routingCellCSS}">&nbsp;</td>`).join('')}</tr>`
  ).join('')

  const printTime = new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
  })

  return `<!DOCTYPE html>
<html>
<head>
  <title>Traveler — ${_esc(job.job_number)}</title>
  <style>
    body { margin:0; padding:24px; font-family:Arial,Helvetica,sans-serif; color:#000; background:#fff; }
    @media print { @page { size: landscape; margin: 0.5in; } body { padding:0; } .no-print { display:none; } }
    .toolbar { background:#1e293b; color:#e2e8f0; padding:12px 16px; margin:-24px -24px 24px -24px; display:flex; justify-content:space-between; align-items:center; }
    .toolbar button { background:#2563eb; color:#fff; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; font-size:13px; font-weight:500; }
  </style>
</head>
<body>
  <div class="toolbar no-print">
    <span>Job Traveler — ${_esc(job.job_number)}</span>
    <button onclick="window.print()">Print</button>
  </div>
  <div class="print-page">
    <div style="text-align:center; border-bottom:3px solid #000; padding-bottom:8px; margin-bottom:16px;">
      <h1 style="margin:0; font-size:22px; font-weight:bold; letter-spacing:2px;">SKYBOLT AEROMOTIVE &mdash; JOB TRAVELER</h1>
    </div>
    <table style="width:100%; border-collapse:collapse; margin-bottom:16px; font-size:13px;">
      <tbody>
        <tr><td style="${headerLabelCSS}">Part Number</td><td style="${headerValueCSS}">${_esc(comp?.part_number) || '&mdash;'}</td>
            <td style="${headerLabelCSS}">Job Number</td><td style="${headerValueCSS}">${_esc(job.job_number)}</td></tr>
        <tr><td style="${headerLabelCSS}">Description</td><td style="${headerValueCSS}">${_esc(comp?.description) || '&mdash;'}</td>
            <td style="${headerLabelCSS}">Order / WO #</td><td style="${headerValueCSS}">${_esc(wo?.wo_number) || '&mdash;'}</td></tr>
        <tr><td style="${headerLabelCSS}">Material</td><td style="${headerValueCSS}">${_esc(comp?.material_type?.name) || '&mdash;'}</td>
            <td style="${headerLabelCSS}">PO Number</td><td style="${headerValueCSS}">${_esc(wo?.po_number) || '&mdash;'}</td></tr>
        <tr><td style="${headerLabelCSS}">Drawing Rev</td><td style="${headerValueCSS}">${_esc(comp?.drawing_revision) || '&mdash;'}</td>
            <td style="${headerLabelCSS}">Due Date</td><td style="${headerValueCSS}">${_formatDate(wo?.due_date)}</td></tr>
        <tr><td style="${headerLabelCSS}">Customer</td><td style="${headerValueCSS}">${customerDisplay}</td>
            <td style="${headerLabelCSS}">Quantity</td><td style="${headerValueCSS} font-weight:bold;">${_esc(qtyDisplay)}</td></tr>
      </tbody>
    </table>
    ${coSectionHTML}
    <table style="width:100%; border-collapse:collapse; font-size:12px; margin-bottom:16px;">
      <thead>
        <tr><th style="${routingHeaderCSS}">Step</th><th style="${routingHeaderCSS}">Process</th><th style="${routingHeaderCSS}">Station</th>
            <th style="${routingHeaderCSS}">Type</th><th style="${routingHeaderCSS}">Lot #</th><th style="${routingHeaderCSS}">Qty</th>
            <th style="${routingHeaderCSS}">Date</th><th style="${routingHeaderCSS}">Operator</th></tr>
      </thead>
      <tbody>${stepsHTML}${blankRows}</tbody>
    </table>
    <div style="border:1px solid #000; padding:8px; margin-bottom:16px; min-height:60px; font-size:12px;"><strong>Notes:</strong></div>
    <div style="border-top:1px solid #999; padding-top:8px; display:flex; justify-content:space-between; font-size:10px; color:#666;">
      <span>Generated from SkyNet MES &mdash; ${printTime}</span><span>Skybolt Aeromotive Corp</span>
    </div>
  </div>
</body>
</html>`
}
