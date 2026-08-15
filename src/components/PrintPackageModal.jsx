import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { getDocumentUrl } from '../lib/s3'
import { fetchTravelerData, buildTravelerBodyHTML } from '../lib/traveler'
import { Printer, X, Loader2, FileText } from 'lucide-react'

// HTML escape for template strings
const esc = (str) => {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
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
  ${hasTraveler ? buildTravelerBodyHTML(travelerData) : ''}
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
        // D-JOBMERGE-08: the canonical traveler dataset — routing lots /
        // quantities / dates / operators, CO allocations, assembly genealogy
        // and mergeInfo — the same source every other traveler surface uses.
        // Replaces this modal's own job/steps/batch queries and its local
        // renderer, so the folder packet tells the combined-run truth.
        const canonicalTraveler = await fetchTravelerData(supabase, job.id)
        if (!canonicalTraveler) {
          throw new Error('Traveler data unavailable for this job')
        }
        const fullJob = canonicalTraveler.job

        setTravelerData(canonicalTraveler)

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

        // Consolidated list: the job's own documents are the as-run snapshot (pulled
        // forward from the part at WO creation, plus per-job uploads like the material
        // cert). Fall back to the live part master only when a job has no documents of
        // its own (legacy jobs predating pull-forward).
        const docs = (jDocs && jDocs.length > 0) ? jDocs : pDocs

        // Initialize selection: traveler + all docs checked by default
        const initial = { traveler: true }
        docs.forEach(doc => { initial[`doc-${doc.id}`] = true })
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
      // Gather selected file documents (only those with a file_url)
      const docs = jobDocuments.length > 0 ? jobDocuments : partDocuments
      const allSelectedDocs = docs.filter(doc => selectedDocs[`doc-${doc.id}`] && doc.file_url)

      // Generate signed URLs for all selected documents
      const docsWithUrls = await Promise.all(
        allSelectedDocs.map(async (doc) => ({
          ...doc,
          signedUrl: await getDocumentUrl(doc.file_url)
        }))
      )

      // Build and write the Print Hub page
      const hasTraveler = !!(selectedDocs.traveler && travelerData)
      const html = buildPrintHubHTML(
        job.job_number,
        hasTraveler ? travelerData : null,
        docsWithUrls
      )
      printHub.document.open()
      printHub.document.write(html)
      printHub.document.close()

      // D-JOBMERGE-08: the packet carries the canonical traveler, so this
      // print legitimately clears paperwork staleness. Non-blocking; the
      // modal has no profile prop, so resolve the signer from the session.
      if (hasTraveler) {
        supabase.auth.getUser().then(({ data: authData }) => {
          supabase
            .from('jobs')
            .update({
              traveler_printed_at: new Date().toISOString(),
              traveler_printed_by: authData?.user?.id || null,
            })
            .eq('id', job.id)
            .then(({ error: stampErr }) => {
              if (stampErr) console.error('traveler_printed stamp failed (non-blocking):', stampErr)
            })
        })
      }

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
  // Consolidated list — job docs are the as-run snapshot; part docs are a
  // fallback only for legacy jobs that have no job documents of their own.
  const documents = jobDocuments.length > 0 ? jobDocuments : partDocuments

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
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

              {/* Consolidated documents — job docs are the as-run snapshot pulled
                  forward at WO creation plus per-job uploads; part docs appear only
                  as a fallback for legacy jobs with no documents of their own. */}
              {documents.length > 0 && (
                <>
                  <div className="text-xs text-gray-500 uppercase tracking-wide mt-4 mb-1">
                    Documents
                  </div>
                  {documents.map(doc => {
                    const isPDF = doc.mime_type === 'application/pdf'
                    const isImage = doc.mime_type?.startsWith('image/')
                    const typeLabel = isPDF ? 'PDF' : isImage ? 'IMG' : 'FILE'

                    return (
                      <label
                        key={`doc-${doc.id}`}
                        className="flex items-center gap-3 p-3 bg-gray-800 rounded border border-gray-700 cursor-pointer hover:border-gray-500 transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={!!selectedDocs[`doc-${doc.id}`]}
                          onChange={(e) => setSelectedDocs(prev => ({ ...prev, [`doc-${doc.id}`]: e.target.checked }))}
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

              {documents.length === 0 && (
                <p className="text-gray-500 text-sm text-center py-2">
                  No documents found.
                </p>
              )}

              {/* Info message about how documents open */}
              {documents.length > 0 && (
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
