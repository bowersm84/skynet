import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { getDocumentUrl } from '../lib/s3'
import { Printer, X, Loader2, FileText } from 'lucide-react'

// HTML escape for template strings
const esc = (str) => {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// CSS string constants (mirrors PrintTraveler.jsx style objects)
const headerLabelCSS = 'padding:4px 8px; font-weight:bold; background-color:#f0f0f0; border:1px solid #ccc; width:15%; white-space:nowrap;'
const headerValueCSS = 'padding:4px 8px; border:1px solid #ccc; width:35%;'
const routingHeaderCSS = 'padding:6px 8px; background-color:#222; color:#fff; font-weight:bold; border:1px solid #000; text-align:left;'
const routingCellCSS = 'padding:8px; border:1px solid #000; height:28px; vertical-align:middle;'

function formatDate(dateStr) {
  if (!dateStr) return '&mdash;'
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  })
}

function buildTravelerHTML(travelerData) {
  const { job, steps } = travelerData
  const wo = job.work_order
  const comp = job.component

  // Quantity display (same logic as PrintTraveler.jsx lines 109-114)
  let qtyDisplay = String(job.quantity)
  if (wo?.order_type === 'make_to_order' && wo?.order_quantity && wo?.stock_quantity) {
    qtyDisplay = `${wo.order_quantity} order + ${wo.stock_quantity} stock = ${job.quantity} total`
  } else if (wo?.order_type === 'make_to_stock') {
    qtyDisplay = `${job.quantity} (stock)`
  }

  const customerDisplay = wo?.order_type === 'make_to_stock' ? 'STOCK' : esc(wo?.customer) || '&mdash;'

  const stepsHTML = steps.map(step => `
    <tr>
      <td style="${routingCellCSS} text-align:center; width:40px;">${step.step_order}</td>
      <td style="${routingCellCSS}">${esc(step.step_name)}${step.is_added_step ? ' *' : ''}</td>
      <td style="${routingCellCSS} width:90px;">${esc(step.station) || ''}</td>
      <td style="${routingCellCSS} text-align:center; width:45px;">${step.step_type === 'external' ? 'EXT' : 'INT'}</td>
      <td style="${routingCellCSS} width:90px;"></td>
      <td style="${routingCellCSS} width:55px;"></td>
      <td style="${routingCellCSS} width:80px;"></td>
      <td style="${routingCellCSS} width:90px;"></td>
    </tr>
  `).join('')

  const blankRows = Array.from({ length: 3 }).map(() =>
    `<tr>${Array.from({ length: 8 }).map(() => `<td style="${routingCellCSS}">&nbsp;</td>`).join('')}</tr>`
  ).join('')

  const printTime = new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  })

  return `
    <div class="print-page" style="font-family:Arial,Helvetica,sans-serif; color:#000; background:#fff;">
      <!-- Title -->
      <div style="text-align:center; border-bottom:3px solid #000; padding-bottom:8px; margin-bottom:16px;">
        <h1 style="margin:0; font-size:22px; font-weight:bold; letter-spacing:2px;">
          SKYBOLT AEROMOTIVE &mdash; JOB TRAVELER
        </h1>
      </div>

      <!-- Header Fields Grid -->
      <table style="width:100%; border-collapse:collapse; margin-bottom:16px; font-size:13px;">
        <tbody>
          <tr>
            <td style="${headerLabelCSS}">Part Number</td>
            <td style="${headerValueCSS}">${esc(comp?.part_number) || '&mdash;'}</td>
            <td style="${headerLabelCSS}">Job Number</td>
            <td style="${headerValueCSS}">${esc(job.job_number)}</td>
          </tr>
          <tr>
            <td style="${headerLabelCSS}">Description</td>
            <td style="${headerValueCSS}">${esc(comp?.description) || '&mdash;'}</td>
            <td style="${headerLabelCSS}">Order / WO #</td>
            <td style="${headerValueCSS}">${esc(wo?.wo_number) || '&mdash;'}</td>
          </tr>
          <tr>
            <td style="${headerLabelCSS}">Material</td>
            <td style="${headerValueCSS}">${esc(comp?.material_type?.name) || '&mdash;'}</td>
            <td style="${headerLabelCSS}">PO Number</td>
            <td style="${headerValueCSS}">${esc(wo?.po_number) || '&mdash;'}</td>
          </tr>
          <tr>
            <td style="${headerLabelCSS}">Drawing Rev</td>
            <td style="${headerValueCSS}">${esc(comp?.drawing_revision) || '&mdash;'}</td>
            <td style="${headerLabelCSS}">Due Date</td>
            <td style="${headerValueCSS}">${formatDate(wo?.due_date)}</td>
          </tr>
          <tr>
            <td style="${headerLabelCSS}">Customer</td>
            <td style="${headerValueCSS}">${customerDisplay}</td>
            <td style="${headerLabelCSS}">Quantity</td>
            <td style="${headerValueCSS} font-weight:bold;">${esc(qtyDisplay)}</td>
          </tr>
        </tbody>
      </table>

      <!-- Routing Steps Table -->
      <table style="width:100%; border-collapse:collapse; font-size:12px; margin-bottom:16px;">
        <thead>
          <tr>
            <th style="${routingHeaderCSS}">Step</th>
            <th style="${routingHeaderCSS}">Process</th>
            <th style="${routingHeaderCSS}">Station</th>
            <th style="${routingHeaderCSS}">Type</th>
            <th style="${routingHeaderCSS}">Lot #</th>
            <th style="${routingHeaderCSS}">Qty</th>
            <th style="${routingHeaderCSS}">Date</th>
            <th style="${routingHeaderCSS}">Operator</th>
          </tr>
        </thead>
        <tbody>
          ${stepsHTML}
          ${blankRows}
        </tbody>
      </table>

      <!-- Notes area -->
      <div style="border:1px solid #000; padding:8px; margin-bottom:16px; min-height:60px; font-size:12px;">
        <strong>Notes:</strong>
      </div>

      <!-- Footer -->
      <div style="border-top:1px solid #999; padding-top:8px; display:flex; justify-content:space-between; font-size:10px; color:#666;">
        <span>Printed from SkyNet MES &mdash; ${printTime}</span>
        <span>Skybolt Aeromotive Corp</span>
      </div>
    </div>
  `
}

function buildPrintHubHTML(jobNumber, travelerData, docsWithUrls) {
  const hasTraveler = !!travelerData
  const hasDocs = docsWithUrls.length > 0

  // Build document list HTML for the "Open & Print" section
  const docListHTML = docsWithUrls.map((doc, i) => {
    const docName = esc(doc.document_type?.name || 'Document')
    const fileName = esc(doc.file_name)
    return `
      <div style="display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:#1e293b; border:1px solid #334155; border-radius:8px;">
        <div style="min-width:0;">
          <div style="color:#e2e8f0; font-size:14px; font-weight:500;">${docName}</div>
          <div style="color:#94a3b8; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${fileName}</div>
        </div>
        <button onclick="window.open(docUrls[${i}], '_blank')" style="background:#2563eb; color:white; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; font-size:13px; font-weight:500; white-space:nowrap; margin-left:12px;">
          Open &amp; Print
        </button>
      </div>
    `
  }).join('')

  // Serialize the signed URLs as a JS array for the onclick handlers
  const urlArrayJS = JSON.stringify(docsWithUrls.map(d => d.signedUrl))

  return `<!DOCTYPE html>
<html>
<head>
  <title>Print Package — ${esc(jobNumber)}</title>
  <style>
    @media print {
      body { margin: 0; padding: 0; }
      .no-print { display: none !important; }
      .print-page { padding-top: 0 !important; }
      @page { size: landscape; margin: 0.5in; }
    }
    @media screen {
      body { background: #0f172a; margin: 0; padding-top: 60px; }
      .print-page { max-width: 11in; margin: 20px auto; padding: 0.5in; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
    }
    * { box-sizing: border-box; }
  </style>
  <script>var docUrls = ${urlArrayJS};</script>
</head>
<body>
  <div class="no-print" style="position:fixed; top:0; left:0; right:0; background:#1a1a2e; padding:12px 24px; display:flex; align-items:center; justify-content:space-between; z-index:100; border-bottom:1px solid #333;">
    <span style="color:#aaa; font-size:14px;">Print Package &mdash; ${esc(jobNumber)}</span>
    <div style="display:flex; gap:8px;">
      <button onclick="window.print()" style="background:#16a34a; color:white; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; font-size:14px; font-weight:500;">Print Traveler</button>
      <button onclick="window.close()" style="background:#374151; color:white; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; font-size:14px;">Close</button>
    </div>
  </div>
  ${hasTraveler ? buildTravelerHTML(travelerData) : ''}
  ${hasDocs ? `
    <div class="no-print" style="max-width:11in; margin:24px auto; padding:0 0.5in;">
      <div style="border-top:1px solid #334155; padding-top:20px;">
        <h2 style="color:#e2e8f0; font-size:16px; font-weight:600; margin:0 0 4px 0;">Documents to Print</h2>
        <p style="color:#64748b; font-size:13px; margin:0 0 16px 0;">Click each document below to open and print separately.</p>
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${docListHTML}
        </div>
      </div>
    </div>
  ` : ''}
</body>
</html>`
}

export default function PrintPackageModal({ isOpen, job, onClose }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [travelerData, setTravelerData] = useState(null)
  const [partDocuments, setPartDocuments] = useState([])
  const [jobDocuments, setJobDocuments] = useState([])
  const [selectedDocs, setSelectedDocs] = useState({})
  const [printing, setPrinting] = useState(false)

  useEffect(() => {
    if (!isOpen || !job?.id) return

    setLoading(true)
    setError(null)
    setTravelerData(null)
    setPartDocuments([])
    setJobDocuments([])
    setSelectedDocs({})

    const fetchData = async () => {
      try {
        // Fetch full job data (same query as PrintTraveler)
        const { data: fullJob, error: jobError } = await supabase
          .from('jobs')
          .select(`
            id, job_number, quantity, status,
            work_order:work_orders (
              wo_number, customer, po_number, due_date,
              order_type, order_quantity, stock_quantity
            ),
            component:parts!component_id (
              id, part_number, description, drawing_revision,
              requires_passivation,
              material_type:material_types ( name )
            )
          `)
          .eq('id', job.id)
          .single()
        if (jobError) throw jobError

        // Fetch routing steps
        const { data: steps, error: stepsError } = await supabase
          .from('job_routing_steps')
          .select('*')
          .eq('job_id', job.id)
          .neq('status', 'removed')
          .order('step_order')
        if (stepsError) throw stepsError

        setTravelerData({ job: fullJob, steps: steps || [] })

        // Fetch part documents (master docs for this component)
        let pDocs = []
        if (fullJob.component?.id) {
          const { data: partDocs, error: docsError } = await supabase
            .from('part_documents')
            .select('*, document_type:document_types(*)')
            .eq('part_id', fullJob.component.id)
            .eq('is_current', true)
          if (docsError) throw docsError
          pDocs = partDocs || []
        }
        setPartDocuments(pDocs)

        // Fetch job documents (per-job compliance uploads)
        const { data: jDocs, error: jDocsError } = await supabase
          .from('job_documents')
          .select('*, document_type:document_types(*)')
          .eq('job_id', job.id)
          .order('created_at', { ascending: true })
        if (jDocsError) throw jDocsError
        setJobDocuments(jDocs || [])

        // Initialize selection: traveler + all docs checked by default
        // Prefix job doc keys with "job-" to avoid UUID collisions with part docs
        const initial = { traveler: true }
        pDocs.forEach(doc => { initial[`part-${doc.id}`] = true })
        ;(jDocs || []).forEach(doc => { initial[`job-${doc.id}`] = true })
        setSelectedDocs(initial)
      } catch (err) {
        console.error('Error fetching print package data:', err)
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [isOpen, job?.id])

  const handlePrintSelected = async () => {
    // Open ONE window synchronously in the click context (popup blocker allows this)
    const printHub = window.open('', '_blank')
    if (!printHub) {
      alert('Popup blocked. Please allow popups for this site.')
      return
    }
    printHub.document.write('<html><body style="font-family:Arial; background:#0f172a; color:#94a3b8; text-align:center; padding:80px;"><p>Preparing print package...</p></body></html>')

    setPrinting(true)
    try {
      // Gather selected file documents from both sources (only those with a file_url)
      const selectedParts = partDocuments.filter(doc => selectedDocs[`part-${doc.id}`] && doc.file_url)
      const selectedJobs = jobDocuments.filter(doc => selectedDocs[`job-${doc.id}`] && doc.file_url)
      const allSelectedDocs = [...selectedParts, ...selectedJobs]

      // Generate signed URLs for all selected documents
      const docsWithUrls = await Promise.all(
        allSelectedDocs.map(async (doc) => ({
          ...doc,
          signedUrl: await getDocumentUrl(doc.file_url)
        }))
      )

      // Build and write the Print Hub page
      const html = buildPrintHubHTML(
        job.job_number,
        selectedDocs.traveler ? travelerData : null,
        docsWithUrls
      )
      printHub.document.open()
      printHub.document.write(html)
      printHub.document.close()

      onClose()
    } catch (err) {
      console.error('Error generating print package:', err)
      printHub.document.open()
      printHub.document.write(`<html><body style="font-family:Arial; background:#0f172a; color:#ef4444; text-align:center; padding:80px;"><p>Error: ${esc(err.message)}</p></body></html>`)
      printHub.document.close()
    } finally {
      setPrinting(false)
    }
  }

  if (!isOpen) return null

  const selectedCount = Object.values(selectedDocs).filter(Boolean).length
  const hasSelection = selectedCount > 0

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 rounded-lg border border-gray-600 w-full max-w-md max-h-[80vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            <Printer size={20} className="text-gray-400" />
            <div>
              <h2 className="text-lg font-semibold text-white">Print Package</h2>
              <p className="text-sm text-gray-400">{job?.job_number}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto max-h-[calc(80vh-160px)]">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={24} className="animate-spin text-gray-400" />
            </div>
          ) : error ? (
            <div className="p-3 bg-red-900/50 border border-red-700 rounded text-red-300 text-sm">
              {error}
            </div>
          ) : (
            <div className="space-y-3">
              {/* Traveler checkbox */}
              <label className="flex items-center gap-3 p-3 bg-gray-800 rounded border border-gray-700 cursor-pointer hover:border-gray-500 transition-colors">
                <input
                  type="checkbox"
                  checked={!!selectedDocs.traveler}
                  onChange={(e) => setSelectedDocs(prev => ({ ...prev, traveler: e.target.checked }))}
                  className="w-4 h-4 rounded"
                />
                <FileText size={16} className="text-blue-400" />
                <div className="flex-1">
                  <span className="text-white text-sm font-medium">Job Traveler</span>
                  <span className="text-gray-500 text-xs ml-2">HTML</span>
                </div>
              </label>

              {/* Part documents (master docs for this component) */}
              {partDocuments.length > 0 && (
                <>
                  <div className="text-xs text-gray-500 uppercase tracking-wide mt-4 mb-1">
                    Part Documents
                  </div>
                  {partDocuments.map(doc => {
                    const isPDF = doc.mime_type === 'application/pdf'
                    const isImage = doc.mime_type?.startsWith('image/')
                    const typeLabel = isPDF ? 'PDF' : isImage ? 'IMG' : 'FILE'

                    return (
                      <label
                        key={`part-${doc.id}`}
                        className="flex items-center gap-3 p-3 bg-gray-800 rounded border border-gray-700 cursor-pointer hover:border-gray-500 transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={!!selectedDocs[`part-${doc.id}`]}
                          onChange={(e) => setSelectedDocs(prev => ({ ...prev, [`part-${doc.id}`]: e.target.checked }))}
                          className="w-4 h-4 rounded"
                        />
                        <FileText size={16} className="text-gray-400" />
                        <div className="flex-1 min-w-0">
                          <span className="text-white text-sm font-medium">
                            {doc.document_type?.name || 'Document'}
                          </span>
                          <p className="text-gray-500 text-xs truncate">{doc.file_name}</p>
                        </div>
                        <span className="text-gray-600 text-xs font-mono">{typeLabel}</span>
                      </label>
                    )
                  })}
                </>
              )}

              {/* Job documents (per-job compliance uploads) */}
              {jobDocuments.length > 0 && (
                <>
                  <div className="text-xs text-gray-500 uppercase tracking-wide mt-4 mb-1">
                    Job Documents
                  </div>
                  {jobDocuments.map(doc => {
                    const isPDF = doc.mime_type === 'application/pdf'
                    const isImage = doc.mime_type?.startsWith('image/')
                    const typeLabel = isPDF ? 'PDF' : isImage ? 'IMG' : 'FILE'

                    return (
                      <label
                        key={`job-${doc.id}`}
                        className="flex items-center gap-3 p-3 bg-gray-800 rounded border border-gray-700 cursor-pointer hover:border-gray-500 transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={!!selectedDocs[`job-${doc.id}`]}
                          onChange={(e) => setSelectedDocs(prev => ({ ...prev, [`job-${doc.id}`]: e.target.checked }))}
                          className="w-4 h-4 rounded"
                        />
                        <FileText size={16} className="text-green-400" />
                        <div className="flex-1 min-w-0">
                          <span className="text-white text-sm font-medium">
                            {doc.document_type?.name || 'Document'}
                          </span>
                          <p className="text-gray-500 text-xs truncate">{doc.file_name}</p>
                        </div>
                        <span className="text-gray-600 text-xs font-mono">{typeLabel}</span>
                      </label>
                    )
                  })}
                </>
              )}

              {partDocuments.length === 0 && jobDocuments.length === 0 && (
                <p className="text-gray-500 text-sm text-center py-2">
                  No documents found.
                </p>
              )}

              {/* Info message about how documents open */}
              {(partDocuments.length > 0 || jobDocuments.length > 0) && (
                <p className="text-gray-500 text-xs mt-4 leading-relaxed">
                  Documents will open in separate tabs for printing to preserve their original formatting and orientation.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-700">
          <span className="text-gray-500 text-sm">
            {selectedCount} selected
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handlePrintSelected}
              disabled={printing || !hasSelection}
              className="flex items-center gap-2 px-5 py-2 bg-green-600 hover:bg-green-500 text-white font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {printing ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
              {printing ? 'Preparing...' : 'Print Selected'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
