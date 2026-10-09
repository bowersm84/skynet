// src/lib/travelPack.js — the Traveler Kiosk's travel pack (D-TKIOSK-04 … 07, 13; 04a, 06a, 13a; 06b, 11a, 13b).
//
// One pack = one HTML document = one print job:
//   section.trav  the canonical traveler (buildTravelerBodyHTML), landscape
//   section.docp / section.docl  the drawing and the blank production card, each
//                 page rendered to a 300-DPI image by pdf.js (PDF) or embedded
//                 as-is (jpg/png) — D-TKIOSK-04a: nothing else goes to the floor
//   section.notice  "Not printed" page listing anything that could not be rendered
//                 (unknown types, unreadable files, a card whose print copy is not
//                 there yet) — D-TKIOSK-05
//
// Production cards stay Excel (D-TKIOSK-11a). The skynet-print-copy Lambda writes
// <key>.print.pdf beside every Excel file in the bucket; an Excel card is printed
// from that copy, rendered like any other PDF (D-TKIOSK-13b).
//
// Printing is window.print() from a hidden srcdoc iframe — the PrintTraveler.jsx
// pattern. With Chrome launched --kiosk-printing that is silent; without the flag
// the same code shows the dialog. Nothing here depends on Chrome's PDF viewer
// (D-TKIOSK-06, spike Oct 7 2026).
import { fetchTravelerData, buildTravelerBodyHTML } from './traveler'
import { getDocumentUrl } from './s3'
import { renderPdfPages } from './pdfjsLoader'

export const TRAVEL_PACK_DPI = 300
export const PRODUCTION_CARD_CODE = 'production_log_blank'

// D-TKIOSK-04a (Matt, Oct 7 test): the floor needs the traveler, the drawing and
// the blank production card — nothing else. Material certs and any other job
// documents stay in the Print Package for compliance. document_types.code values.
export const PACK_DOC_CODES = ['drawing', PRODUCTION_CARD_CODE]
const isPackDoc = (d) => PACK_DOC_CODES.includes(d?.document_type?.code)

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function extOf(name) {
  const m = /\.([a-z0-9]+)\s*$/i.exec(name || '')
  return m ? m[1].toLowerCase() : ''
}

// 'pdf' | 'image' | 'unprintable' — mime first, extension as the fallback.
// Every Excel file in the bucket gets a PDF print copy beside it (D-TKIOSK-11a).
export const PRINT_COPY_SUFFIX = '.print.pdf'
const EXCEL_EXTS = ['xls', 'xlsx', 'xlsm']
const EXCEL_MIMES = [
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroenabled.12',
]

// 'pdf' | 'image' | 'excel' (printed from its print copy) | 'unprintable'.
// Mime first, extension as the fallback.
export function docKind(doc) {
  const mime = (doc?.mime_type || '').toLowerCase()
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('image/')) return 'image'
  if (EXCEL_MIMES.includes(mime)) return 'excel'
  const ext = extOf(doc?.file_name || doc?.file_url)
  if (ext === 'pdf') return 'pdf'
  if (['jpg', 'jpeg', 'png'].includes(ext)) return 'image'
  if (EXCEL_EXTS.includes(ext)) return 'excel'
  return 'unprintable'
}

export function isPrintableDoc(doc) {
  return !!doc?.file_url && docKind(doc) !== 'unprintable'
}

// Pack order: document_types.sort_order (Drawing 1, Production Log 2, …), with
// 0/null ("Other") last, then upload order.
export function sortDocuments(docs) {
  const key = (d) => {
    const so = d?.document_type?.sort_order
    return so && so > 0 ? so : 99
  }
  return [...(docs || [])].sort((a, b) => {
    const d = key(a) - key(b)
    if (d !== 0) return d
    return String(a.created_at || '').localeCompare(String(b.created_at || ''))
  })
}

// The pack's documents: the job's own drawing and production card rows (the as-run
// snapshot pulled forward at WO creation); the live part master's current drawing
// and card are the fallback only when the job has neither of its own (legacy jobs).
// Only rows with a file are returned, in pack order (D-TKIOSK-04a).
export async function fetchJobDocuments(supabase, job) {
  const { data: jDocs, error: jErr } = await supabase
    .from('job_documents')
    .select('id, job_id, file_name, file_url, mime_type, file_size, status, source, created_at, document_type:document_types(id, name, code, sort_order)')
    .eq('job_id', job.id)
    .order('created_at', { ascending: true })
  if (jErr) throw jErr
  let docs = (jDocs || []).filter(d => d.file_url && isPackDoc(d))
  if (docs.length === 0) {
    const partId = job.component?.id || job.component_id
    if (partId) {
      const { data: pDocs, error: pErr } = await supabase
        .from('part_documents')
        .select('id, part_id, file_name, file_url, mime_type, file_size, created_at, document_type:document_types(id, name, code, sort_order)')
        .eq('part_id', partId)
        .eq('is_current', true)
      if (pErr) throw pErr
      docs = (pDocs || []).filter(d => d.file_url && isPackDoc(d)).map(d => ({ ...d, source: 'part_master' }))
    }
  }
  return sortDocuments(docs)
}

// Lineup helper: documents for many jobs in one query (job docs only), with the
// part-master fallback resolved per job only where a job has none.
export async function fetchDocumentsForJobs(supabase, jobs) {
  const byJob = {}
  const ids = (jobs || []).map(j => j.id)
  if (ids.length === 0) return byJob
  const { data, error } = await supabase
    .from('job_documents')
    .select('id, job_id, file_name, file_url, mime_type, file_size, status, source, created_at, document_type:document_types(id, name, code, sort_order)')
    .in('job_id', ids)
    .order('created_at', { ascending: true })
  if (error) throw error
  for (const d of data || []) {
    if (!d.file_url || !isPackDoc(d)) continue
    if (!byJob[d.job_id]) byJob[d.job_id] = []
    byJob[d.job_id].push(d)
  }
  for (const j of jobs) {
    if (byJob[j.id]?.length) { byJob[j.id] = sortDocuments(byJob[j.id]); continue }
    try { byJob[j.id] = await fetchJobDocuments(supabase, j) } catch { byJob[j.id] = [] }
  }
  return byJob
}

// The job's blank production card, printable or not (D-TKIOSK-13a/13b: the button
// shows whenever a card is on file; an Excel card prints from its print copy).
export function findProductionCard(docs) {
  return (docs || []).find(d => d.document_type?.code === PRODUCTION_CARD_CODE) || null
}

async function fetchBytes(filePath) {
  const url = await getDocumentUrl(filePath)
  if (!url) return null
  const resp = await fetch(url)
  if (!resp.ok) return null
  return new Uint8Array(await resp.arrayBuffer())
}

function bytesToDataUrl(bytes, mime) {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return `data:${mime};base64,${btoa(bin)}`
}

// ---------------------------------------------------------------------------
// Pack CSS — named pages, inch units only (viewport units misbehave when page
// sizes mix). Content boxes: portrait 8 x 10.5 in, landscape 10.5 x 8 in at
// 0.25 in margins; the traveler keeps its 0.5 in margins as it prints today.
// ---------------------------------------------------------------------------
export const PACK_CSS = `
@page trav { size: letter landscape; margin: 0.5in; }
@page docp { size: letter portrait; margin: 0.25in; }
@page docl { size: letter landscape; margin: 0.25in; }
html, body { margin: 0; padding: 0; background: #fff; font-family: Arial, Helvetica, sans-serif; color: #000; }
section { break-after: page; page-break-after: always; overflow: hidden; box-sizing: border-box; }
section:last-of-type { break-after: auto; page-break-after: auto; }
section.trav { page: trav; }
section.docp { page: docp; width: 8in; height: 10.4in; }
section.docl { page: docl; width: 10.5in; height: 7.9in; }
section.docp img, section.docl img { display: block; width: 100%; height: 100%; object-fit: contain; }
section.notice { padding: 0.5in; }
section.notice h2 { margin: 0 0 8px; font-size: 20px; }
section.notice p, section.notice li { font-size: 13px; }
.no-print { display: none; }
@media screen { body { padding: 24px; } section { border: 1px dashed #999; margin-bottom: 24px; } }
`

export function imageSection(dataUrl, landscape = false) {
  return `<section class="${landscape ? 'docl' : 'docp'}"><img src="${dataUrl}" alt=""></section>`
}

export function noticeSection(job, skipped) {
  const items = (skipped || []).map(s =>
    `<li>${esc(s.file_name || s.file_url || 'document')} &mdash; ${esc(s.type || 'Document')} &mdash; ${esc(s.reason)}</li>`
  ).join('')
  return `<section class="docp notice">
    <h2>Not printed &mdash; see Roger</h2>
    <p>Job ${esc(job?.job_number)}. These documents are on file but could not be printed from the kiosk:</p>
    <ul>${items}</ul>
    <p>Roger can print them from the Print Package.</p>
  </section>`
}

export function packDocument(title, sections) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PACK_CSS}</style></head><body>${sections.join('')}</body></html>`
}

// Render one document to pack sections. Returns { sections, pages } or throws.
async function renderDocument(doc, dpi, onProgress) {
  const kind = docKind(doc)
  if (kind === 'unprintable') {
    throw Object.assign(new Error(`cannot print .${extOf(doc.file_name || doc.file_url) || 'unknown'} files`), { skipReason: true })
  }
  // An Excel card prints from the PDF copy beside it (D-TKIOSK-13b).
  const bytes = await fetchBytes(kind === 'excel' ? doc.file_url + PRINT_COPY_SUFFIX : doc.file_url)
  if (!bytes) {
    throw Object.assign(new Error(kind === 'excel' ? "print copy isn't ready yet" : 'file could not be read'), { skipReason: true })
  }
  if (kind === 'image') {
    const mime = (doc.mime_type || '').startsWith('image/') ? doc.mime_type : (extOf(doc.file_name) === 'png' ? 'image/png' : 'image/jpeg')
    return { sections: [imageSection(bytesToDataUrl(bytes, mime), false)], pages: 1 }
  }
  const pages = await renderPdfPages(bytes, dpi, (n, total) => onProgress?.(`${doc.document_type?.name || 'Document'} — page ${n} of ${total}`))
  return { sections: pages.map(p => imageSection(p.dataUrl, p.landscape)), pages: pages.length }
}

// Build the whole pack for a job.
// Returns { html, job, travelerData, docs: [{doc, pages}], skipped: [{...doc, reason}], pageCount }.
export async function buildTravelPack(supabase, jobId, { dpi = TRAVEL_PACK_DPI, onProgress } = {}) {
  onProgress?.('Loading the traveler')
  const [travelerData, docsOrErr] = await Promise.all([
    fetchTravelerData(supabase, jobId),
    (async () => {
      // Needs the job row for the part-master fallback; fetch a thin one.
      const { data: j, error } = await supabase.from('jobs').select('id, component_id').eq('id', jobId).single()
      if (error) throw error
      return fetchJobDocuments(supabase, j)
    })(),
  ])
  if (!travelerData) throw new Error('Traveler data unavailable for this job')
  const job = travelerData.job
  const docs = docsOrErr

  const sections = [`<section class="trav">${buildTravelerBodyHTML(travelerData)}</section>`]
  const printed = []
  const skipped = []
  let pageCount = 1
  for (const doc of docs) {
    const label = doc.document_type?.name || doc.file_name || 'Document'
    onProgress?.(`Preparing ${label}`)
    try {
      const r = await renderDocument(doc, dpi, onProgress)
      sections.push(...r.sections)
      printed.push({ doc, pages: r.pages })
      pageCount += r.pages
    } catch (err) {
      console.error('Travel pack: document skipped:', doc.file_name, err)
      skipped.push({ ...doc, type: doc.document_type?.name, reason: err?.skipReason ? err.message : 'could not be rendered' })
    }
  }
  if (skipped.length) {
    sections.push(noticeSection(job, skipped))
    pageCount += 1
  }
  return {
    html: packDocument(`Travel Pack — ${job.job_number}`, sections),
    job, travelerData, docs: printed, skipped, pageCount,
  }
}

// Build a pack holding only the job's blank production card (D-TKIOSK-13).
// Returns { html, doc, pageCount } or throws when the job has no printable card.
export async function buildProductionCard(supabase, job, { dpi = TRAVEL_PACK_DPI, onProgress } = {}) {
  const docs = await fetchJobDocuments(supabase, job)
  const card = findProductionCard(docs)
  if (!card) throw new Error('This job has no production card on file')
  onProgress?.('Preparing the production card')
  let r
  try {
    r = await renderDocument(card, dpi, onProgress)
  } catch (err) {
    if (err?.skipReason) throw new Error(`${err.message} — see Roger`)
    throw err
  }
  return { html: packDocument(`Production Card — ${job.job_number}`, r.sections), doc: card, pageCount: r.pages }
}

// Print an HTML document from a hidden iframe — exactly once (D-TKIOSK-06a).
// An iframe fires 'load' for its initial blank document as well as for the
// srcdoc document; Batch A attached the handler before insertion, caught both,
// and printed twice (Oct 7 test: two copies every time; reproduced in headless
// Chromium — 2 loads, 2 print() calls). Now: srcdoc is set before insertion, the
// handler ignores any document without content, and a flag allows one print.
// Resolves { how }: 'afterprint' once the job spools, 'timeout' if Chrome never
// says, 'error' (with error) if the pack never loads or print() throws.
export function printHtmlJob(html, { settleMs = 400, timeoutMs = 20000, loadTimeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = 'position:fixed;left:-20000px;top:0;width:1100px;height:850px;border:0;visibility:hidden;'
    let printed = false
    let done = false
    const finish = (how, error) => {
      if (done) return
      done = true
      setTimeout(() => { try { frame.remove() } catch { /* noop */ } }, 60000)
      resolve(error ? { how, error } : { how })
    }
    frame.addEventListener('load', () => {
      if (printed) return
      const doc = frame.contentDocument
      if (!doc || !doc.body || doc.body.childElementCount === 0) return
      printed = true
      setTimeout(() => {
        try {
          const w = frame.contentWindow
          w.addEventListener('afterprint', () => finish('afterprint'))
          w.focus()
          w.print()
          setTimeout(() => finish('timeout'), timeoutMs)
        } catch (err) {
          finish('error', err)
        }
      }, settleMs)
    })
    setTimeout(() => { if (!printed) finish('error', new Error('The pack did not load')) }, loadTimeoutMs)
    frame.srcdoc = html
    document.body.appendChild(frame)
  })
}

// Stamp the print on the job (the same columns every traveler surface writes —
// staleness clears by timestamp) and write the audit row. Called once the pack is
// built and BEFORE print() (D-TKIOSK-06a): on Oct 7 the stamp, written after the
// print, never left the browser on either test (no PATCH or preflight in the API
// log; the audit POST right behind it landed) — it was racing the second print().
// Both writes non-blocking: failures are logged and returned, never thrown.
export async function recordTravelPackPrint(supabase, { job, machine, operator, pack }) {
  const now = new Date().toISOString()
  const result = { stampError: null, auditError: null, stampedAt: null }
  const { error: stampErr } = await supabase
    .from('jobs')
    .update({ traveler_printed_at: now, traveler_printed_by: operator?.id || null })
    .eq('id', job.id)
  if (stampErr) {
    console.error('traveler_printed stamp failed (non-blocking):', stampErr)
    result.stampError = stampErr
  } else {
    result.stampedAt = now
  }
  const { error: auditErr } = await supabase.from('audit_logs').insert({
    event_type: 'travel_pack_printed',
    job_id: job.id,
    machine_id: machine?.id || null,
    operator_id: operator?.id || null,
    details: {
      job_number: job.job_number,
      machine_code: machine?.code || null,
      doc_count: pack?.docs?.length || 0,
      docs: (pack?.docs || []).map(d => ({ name: d.doc.document_type?.name || null, file: d.doc.file_name, pages: d.pages, print_copy: docKind(d.doc) === 'excel' })),
      skipped: (pack?.skipped || []).map(s => ({ name: s.type || null, file: s.file_name, reason: s.reason })),
      page_count: pack?.pageCount || null,
      path: 'html-raster-300dpi',
      printed_at: now,
    },
  })
  if (auditErr) {
    console.error('travel_pack_printed audit failed (non-blocking):', auditErr)
    result.auditError = auditErr
  }
  return result
}

// Audit only — a card print is not a traveler reprint (D-TKIOSK-13). Written
// before print(), like the pack (D-TKIOSK-06a).
export async function recordProductionCardPrint(supabase, { job, machine, operator, doc, pageCount }) {
  const { error } = await supabase.from('audit_logs').insert({
    event_type: 'production_card_printed',
    job_id: job.id,
    machine_id: machine?.id || null,
    operator_id: operator?.id || null,
    details: {
      job_number: job.job_number,
      machine_code: machine?.code || null,
      file: doc?.file_name || null,
      print_copy: docKind(doc) === 'excel',
      pages: pageCount || null,
      printed_at: new Date().toISOString(),
    },
  })
  if (error) console.error('production_card_printed audit failed (non-blocking):', error)
  return { auditError: error || null }
}

// D-TKIOSK-06b: the stamp and audit row land before print() (06a). If print()
// then fails, a travel pack's stamp is put back to what it was — only while ours
// is still the latest stamp, so a print made meanwhile from Compliance Review is
// never undone — and the failure is logged, so "Printed … by" never claims paper
// that did not come out. A card print has no stamp; it only logs the failure.
export async function recordPrintFailed(supabase, { kind, job, machine, operator, previous, stampedAt, error }) {
  const result = { restored: false, restoreError: null, auditError: null }
  if (kind === 'pack' && stampedAt) {
    const { data, error: restoreErr } = await supabase
      .from('jobs')
      .update({ traveler_printed_at: previous?.at ?? null, traveler_printed_by: previous?.by ?? null })
      .eq('id', job.id)
      .eq('traveler_printed_at', stampedAt)
      .select('id')
    if (restoreErr) {
      console.error('traveler_printed restore failed:', restoreErr)
      result.restoreError = restoreErr
    } else {
      result.restored = (data || []).length > 0
    }
  }
  const { error: auditErr } = await supabase.from('audit_logs').insert({
    event_type: kind === 'pack' ? 'travel_pack_print_failed' : 'production_card_print_failed',
    job_id: job.id,
    machine_id: machine?.id || null,
    operator_id: operator?.id || null,
    details: {
      job_number: job.job_number,
      machine_code: machine?.code || null,
      error: String(error?.message || error || 'print failed'),
      stamp_restored: result.restored,
      restored_to: kind === 'pack' ? (previous?.at || null) : undefined,
      failed_at: new Date().toISOString(),
    },
  })
  if (auditErr) {
    console.error('print-failed audit failed:', auditErr)
    result.auditError = auditErr
  }
  return result
}
