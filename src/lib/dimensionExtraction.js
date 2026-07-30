// AI drawing dimension extraction — client side (D-RMF-05).
//
// Owns every step between "user clicked Extract on a part" and "the editors have
// a validated suggestion to pre-fill from":
//
//   1. find the drawing Roger uploaded to one of the part's jobs,
//   2. resolve it to a signed S3 URL and pull the bytes down in the browser,
//   3. hand the base64 to the extract-part-dimensions Edge Function,
//   4. validate the envelope that comes back.
//
// The Edge Function deliberately never touches S3 or Storage — the browser
// already holds AWS credentials for the private bucket (lib/s3.js), so keeping
// the fetch client-side means no AWS keys have to live in Supabase.
//
// Nothing here writes to the database. Committing a suggestion is the human's
// job, through the existing part_dimensions upsert in PartDimensionEditor.

import { supabase } from './supabase'
import { getDocumentUrl } from './s3'

const FUNCTION_NAME = 'extract-part-dimensions'
const EXTRACTION_TIMEOUT_MS = 60000
const MAX_PDF_BYTES = 10 * 1024 * 1024

export const NO_DRAWING_MESSAGE = "No drawing found on this part's jobs."

// document_types ids differ between TEST and PROD, so the drawing type is looked
// up by name and cached for the session rather than hard-coded.
let drawingTypeIdsPromise = null

export function resetDrawingTypeCache() {
  drawingTypeIdsPromise = null
}

async function getDrawingTypeIds() {
  if (!drawingTypeIdsPromise) {
    drawingTypeIdsPromise = (async () => {
      const { data, error } = await supabase
        .from('document_types')
        .select('id, name, code')
        .or('name.ilike.%drawing%,code.ilike.%draw%')
      if (error) throw error
      return (data || []).map(d => d.id)
    })().catch(err => {
      drawingTypeIdsPromise = null
      throw err
    })
  }
  return drawingTypeIdsPromise
}

// ---------------------------------------------------------------------------
// Drawing lookup
//
// Resolution order (verified against TEST 2026-07-30): job_documents carries
// Roger's drawings — 85 approved drawing rows, reaching every part currently in
// the exceptions list; job_document_snapshots held none. So job_documents is the
// source and snapshots are the fallback, both restricted to the drawing document
// type and preferring the newest. Approved beats anything else.
//
// Queries stay flat and are joined in JS: nesting past two levels in a PostgREST
// select is forbidden here (see Decisions, "Supabase query nesting limit").
// ---------------------------------------------------------------------------
// Resolves many parts in one pass — four queries for the whole Needs-data
// panel instead of four per row. Returns { [part_number]: drawing } and omits
// parts with no drawing at all.
export async function findDrawingsForParts(partNumbers) {
  const wanted = [...new Set((partNumbers || []).filter(Boolean))]
  if (!wanted.length) return {}

  const typeIds = await getDrawingTypeIds()
  if (!typeIds.length) return {}

  const { data: parts, error: partsError } = await supabase
    .from('parts')
    .select('id, part_number')
    .in('part_number', wanted)
  if (partsError) throw partsError
  if (!parts?.length) return {}

  const partNumberById = Object.fromEntries(parts.map(p => [p.id, p.part_number]))

  const { data: jobs, error: jobsError } = await supabase
    .from('jobs')
    .select('id, job_number, component_id')
    .in('component_id', parts.map(p => p.id))
  if (jobsError) throw jobsError
  if (!jobs?.length) return {}

  const jobById = Object.fromEntries(jobs.map(j => [j.id, j]))

  const { data: docs, error: docsError } = await supabase
    .from('job_documents')
    .select('id, job_id, file_name, file_url, status, created_at')
    .in('job_id', jobs.map(j => j.id))
    .in('document_type_id', typeIds)
    .order('created_at', { ascending: false })
  if (docsError) throw docsError

  const out = {}
  // Already newest-first, so the first hit for a part is the newest; an approved
  // drawing replaces a non-approved one regardless of age.
  for (const d of docs || []) {
    if (!d.file_url) continue
    const job = jobById[d.job_id]
    const partNumber = job && partNumberById[job.component_id]
    if (!partNumber) continue
    const held = out[partNumber]
    if (held && (held.status === 'approved' || d.status !== 'approved')) continue
    out[partNumber] = {
      file_url: d.file_url,
      file_name: d.file_name,
      job_number: job.job_number || null,
      status: d.status,
      source: 'job_documents',
    }
  }

  const missing = wanted.filter(pn => !out[pn])
  if (!missing.length) return out

  // Fallback: no drawing-type job_documents rows for these parts. (TEST held
  // none on 2026-07-30, but the table exists and Roger's revision snapshots
  // land here, so it is checked rather than assumed empty.)
  const { data: snaps, error: snapsError } = await supabase
    .from('job_document_snapshots')
    .select('id, job_id, snapshot_file_url, snapshot_version, created_at')
    .in('job_id', jobs.map(j => j.id))
    .in('document_type_id', typeIds)
    .order('created_at', { ascending: false })
  if (snapsError) throw snapsError

  for (const s of snaps || []) {
    if (!s.snapshot_file_url) continue
    const job = jobById[s.job_id]
    const partNumber = job && partNumberById[job.component_id]
    if (!partNumber || out[partNumber]) continue
    out[partNumber] = {
      file_url: s.snapshot_file_url,
      file_name: `${partNumber} drawing v${s.snapshot_version ?? '?'}.pdf`,
      job_number: job.job_number || null,
      status: null,
      source: 'job_document_snapshots',
    }
  }

  return out
}

export async function findDrawingForPart(partNumber) {
  if (!partNumber) return { found: false, reason: NO_DRAWING_MESSAGE }
  const map = await findDrawingsForParts([partNumber])
  const drawing = map[partNumber]
  return drawing ? { found: true, drawing } : { found: false, reason: NO_DRAWING_MESSAGE }
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------
function toBase64(bytes) {
  // Chunked — String.fromCharCode.apply on a multi-MB array blows the stack.
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export async function fetchDrawingBase64(fileUrl) {
  const signedUrl = await getDocumentUrl(fileUrl)
  if (!signedUrl) throw new Error('Could not resolve the drawing URL.')

  const resp = await fetch(signedUrl)
  if (!resp.ok) throw new Error(`Could not download the drawing (${resp.status}).`)

  const buf = new Uint8Array(await resp.arrayBuffer())
  if (buf.byteLength === 0) throw new Error('The drawing file is empty.')
  if (buf.byteLength > MAX_PDF_BYTES) {
    throw new Error(`The drawing is ${(buf.byteLength / 1048576).toFixed(1)} MB — the 10 MB limit is exceeded.`)
  }
  return toBase64(buf)
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------
export function validateEnvelope(envelope) {
  const s = envelope?.suggestion
  if (!s || typeof s !== 'object') return 'The extraction service returned no suggestion.'
  if (s.length_in != null && (typeof s.length_in !== 'number' || s.length_in <= 0 || s.length_in >= 6)) {
    return 'The extraction service returned an out-of-range length.'
  }
  if (s.length_in == null && !s.material_type && !s.bar_size) {
    return 'Nothing could be read from this drawing — enter the values by hand.'
  }
  return null
}

// low confidence, any stated ambiguity, or a value outside the catalogs all mean
// the same thing to the user: do not take this at face value.
export function needsCarefulReview(envelope) {
  const s = envelope?.suggestion || {}
  return s.confidence === 'low'
    || (Array.isArray(s.ambiguities) && s.ambiguities.length > 0)
    || !!s.material_unlisted
    || !!s.bar_size_unlisted
}

const CONFIDENCE_STYLES = {
  high: { label: 'High confidence', className: 'bg-green-900/50 text-green-300' },
  medium: { label: 'Medium confidence', className: 'bg-amber-900/50 text-amber-300' },
  low: { label: 'Low confidence', className: 'bg-red-900/50 text-red-300' },
}

export function confidenceStyle(confidence) {
  return CONFIDENCE_STYLES[confidence] || {
    label: 'Confidence unknown',
    className: 'bg-gray-700 text-gray-300',
  }
}

// Human-readable "where did this come from" line for under the row.
export function provenanceLine(envelope, drawing) {
  const s = envelope?.suggestion || {}
  const bits = []
  if (s.dim_reference) bits.push(s.dim_reference)
  const idParts = []
  if (s.drawing_number) idParts.push(s.drawing_number)
  if (s.revision) idParts.push(`Rev ${s.revision}`)
  if (idParts.length) bits.push(idParts.join(' '))
  if (drawing?.job_number) bits.push(`from ${drawing.file_name || 'drawing'} on job ${drawing.job_number}`)
  else if (drawing?.file_name) bits.push(`from ${drawing.file_name}`)
  return bits.join(' · ')
}

// ---------------------------------------------------------------------------
// Invoke
// ---------------------------------------------------------------------------
function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export async function invokeExtraction({ partNumber, description, documentBase64, fileName }) {
  const { data, error } = await withTimeout(
    supabase.functions.invoke(FUNCTION_NAME, {
      body: {
        part_number: partNumber,
        description: description || null,
        document_base64: documentBase64,
        file_name: fileName || null,
      },
    }),
    EXTRACTION_TIMEOUT_MS,
    'The extraction timed out after 60 seconds. Try again, or enter the values by hand.',
  )

  if (error) {
    // FunctionsHttpError carries the function's own JSON body — surface that
    // instead of the generic "non-2xx status code" the SDK produces.
    let detail = ''
    try {
      const body = await error.context?.json?.()
      detail = body?.error || ''
    } catch {
      detail = ''
    }
    throw new Error(detail || error.message || 'The extraction service could not be reached.')
  }
  if (data?.error) throw new Error(data.error)

  const invalid = validateEnvelope(data)
  if (invalid) throw new Error(invalid)
  return data
}

// ---------------------------------------------------------------------------
// The whole trip, for a row that only knows its part number.
// ---------------------------------------------------------------------------
export async function extractDimensionsForPart({ partNumber, description }) {
  const lookup = await findDrawingForPart(partNumber)
  if (!lookup.found) throw new Error(lookup.reason || NO_DRAWING_MESSAGE)

  const documentBase64 = await fetchDrawingBase64(lookup.drawing.file_url)
  const envelope = await invokeExtraction({
    partNumber,
    description,
    documentBase64,
    fileName: lookup.drawing.file_name,
  })

  return { envelope, drawing: lookup.drawing }
}
