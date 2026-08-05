// Packing-slip capture — the query layer for the /kits Packing Slip tab
// (D-KSTC-28).
//
// The shape of the round trip: the warehouse uploads the slip Fishbowl printed,
// packing-slip-extract SUGGESTS the component lines, the operator confirms them
// in an editable grid, and kit_record_component_lots writes what the operator
// approved. Nothing here writes kit_lot_component_lots directly — the RPC is the
// only INSERT path the table has (D-KSTC-24), and it is idempotent, so a
// re-uploaded slip adds nothing and says so.
//
// Same Supabase discipline as kitRegistry: stepwise id-set fetches, chunked
// `.in()`, no nesting beyond one level.

import { supabase } from './supabase'
import { uploadDocument } from './s3'
import { lotsByIds } from './kitRegistry'

const FUNCTION_NAME = 'packing-slip-extract'

// A multi-page slip is a bigger read than one STC email, and re-uploading after
// a timeout means re-scanning at the bench. Longer rope than stc-extract's 90s.
const EXTRACTION_TIMEOUT_MS = 120000

// Every S3 key for a slip lives under its kit lot, so the bucket stays
// browsable by kit the way kit-stc/requests/ is browsable by request.
export const SLIP_PREFIX = 'kit-stc/lots'

export const SLIP_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp'

const EXT_MEDIA_TYPE = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

// A bench photo of a slip goes to the extractor as base64 inside one JSON body.
// Measured against TEST 2026-08-05: a 5.6 MB image extracts fine, an 8.3 MB one
// comes back "Extraction service error 400" from the model API, and only above
// the function's own 20 MB gate does the operator get a sentence they can act
// on. That silent middle band is what the bench hit, so images are re-encoded
// well below it rather than sent as the camera wrote them.
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024
export const MAX_PDF_BYTES = 8 * 1024 * 1024

// 2200px on the longest edge keeps a printed slip's lot numbers legible — the
// text is what the model reads, and a 12 MP camera photo carries no more usable
// detail than this once it is a document rather than a picture.
const MAX_IMAGE_EDGE = 2200
// Quality ladder, then a scale step. Tried in order until the output fits.
const JPEG_QUALITIES = [0.8, 0.7, 0.6, 0.5]
const SCALE_STEPS = [1, 0.8, 0.65, 0.5]

function mb(bytes) {
  return (bytes / 1048576).toFixed(1)
}

// ---------------------------------------------------------------------------
// Part-number comparison
// ---------------------------------------------------------------------------

// The backfill loader's normalization, in JS: upper-cased, whitespace runs
// collapsed. Used ONLY to decide which kit lots a slip group could belong to —
// never to alter a value on its way to the database, where as-written strings
// are the record.
export function normalizePart(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase()
}

// What a lot calls its kit: the resolved SKU if there is one, else the
// as-written kit part — the same COALESCE the loader matches on.
export function lotPartNorm(lot) {
  return normalizePart(lot?.sku?.part_number || lot?.kit_part_as_written || '')
}

// Order numbers are compared on digits alone: the slip prints "S16373", the
// bench types "16373", and Fishbowl treats them as the same order (D-KSTC-27).
export function soDigits(value) {
  return String(value || '').replace(/\D/g, '')
}

// ---------------------------------------------------------------------------
// Line selection — one derivation, shared by the tab and Kit Entry
// ---------------------------------------------------------------------------

// A line records only when it carries both halves of the identity. The RPC
// skips blanks too; this exists so a count can be shown BEFORE saving.
export function savableLines(lines) {
  return (lines || []).filter(
    l => String(l.part_number || '').trim() && String(l.lot_number || '').trim())
}

// The extractor scores each line high/medium/low rather than a float, so the
// "below 0.8" attention rule lands on the two lower bands: anything the model
// was not plainly sure of gets read by a human instead of scrolling past.
const CONFIDENCE_SCORE = { high: 1, medium: 0.6, low: 0.3 }
export const ATTENTION_CONFIDENCE = 0.8

// How a line's confidence renders, wherever it renders. Constants live here
// rather than beside the grid so a .jsx module keeps exporting components only
// (react-refresh/only-export-components — the same split hooks.js exists for).
export const CONFIDENCE_TONE = { high: 'green', medium: 'amber', low: 'gray' }
export const CONFIDENCE_LABEL = { high: 'AI · high', medium: 'AI · med', low: 'AI · low' }

export function needsAttention(line) {
  if (!String(line?.lot_number || '').trim()) return true
  if (line?.edited) return false   // a human already owns this row
  return (CONFIDENCE_SCORE[line?.confidence] ?? 0) < ATTENTION_CONFIDENCE
}

// Editable copies of every group's lines, keyed so edits survive re-render.
// From here the returned state is the truth and the extraction is only
// provenance for the confidence chips (suggest-never-commit).
export function seedLines(slip) {
  const out = {}
  ;(slip?.groups || []).forEach((group, i) => {
    out[i] = (group.lines || []).map((l, j) => ({ ...l, key: `${i}-${j}` }))
  })
  return out
}

// ---------------------------------------------------------------------------
// Slip ↔ entry agreement (D-KSTC-29)
// ---------------------------------------------------------------------------

// Which extracted group is the kit being logged? -1 when none is.
export function matchGroupIndex(slip, kitPartText) {
  const want = normalizePart(kitPartText)
  if (!want) return -1
  return (slip?.groups || []).findIndex(
    g => normalizePart(g.parent_part_number) === want)
}

export function soAgrees(slip, soText) {
  const a = soDigits(slip?.order_number)
  const b = soDigits(soText)
  return !!a && !!b && a === b
}

/**
 * Why this slip's component lots must NOT ride along with this entry, or null
 * when they may. The kit entry itself is never held — the slip is the optional
 * half, and recording lots against the wrong kit is the one outcome worse than
 * not recording them at all.
 */
/**
 * Everything Kit Entry needs to know about an attached slip, derived once and
 * read by both the section that renders it and the save that acts on it — so
 * what the operator was shown and what actually records cannot disagree.
 *
 * Recomputed every render, which is what makes the agreement chips live: edit
 * the Sales Order # field and the verdict moves with it.
 */
export function slipPlan(slip, lines, { soText, kitPartText }) {
  if (!slip) {
    return { groupIndex: -1, soOk: false, hold: null, lines: [], recordable: [], willRecord: false }
  }
  const groupIndex = matchGroupIndex(slip, kitPartText)
  const hold = slipHoldReason(slip, { soText, kitPartText })
  const groupLines = groupIndex >= 0 ? (lines?.[groupIndex] || []) : []
  const recordable = savableLines(groupLines)
  return {
    groupIndex,
    soOk: soAgrees(slip, soText),
    hold,
    lines: groupLines,
    recordable,
    willRecord: !hold && recordable.length > 0,
  }
}

export function slipHoldReason(slip, { soText, kitPartText }) {
  if (!slip) return null
  if (!soAgrees(slip, soText)) {
    const on = soDigits(slip.order_number)
    const typed = soDigits(soText)
    if (!on) return 'the slip has no readable order number'
    if (!typed) return `the slip is for SO ${on} and no Sales Order # is entered`
    return `the slip is for SO ${on} but this entry says SO ${typed}`
  }
  if (matchGroupIndex(slip, kitPartText) < 0) {
    return `no kit on the slip matches ${String(kitPartText || '').trim() || 'this kit name'}`
  }
  return null
}

// ---------------------------------------------------------------------------
// Extraction (suggestions only)
// ---------------------------------------------------------------------------

function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function mediaTypeFor(file) {
  if (file?.type) return file.type
  const ext = String(file?.name || '').split('.').pop()?.toLowerCase()
  return EXT_MEDIA_TYPE[ext] || ''
}

// FileReader rather than btoa(String.fromCharCode(...bytes)) — a multi-megabyte
// slip would blow the argument limit on the spread.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('That file could not be read.'))
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      if (comma < 0) { reject(new Error('That file could not be read.')); return }
      resolve(result.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
}

// A canvas the browser will hand back a JPEG blob from. OffscreenCanvas is not
// on every bench tablet, so the plain element is the path and the blob call is
// promisified rather than assumed.
function drawToCanvas(bitmap, scale) {
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Unsupported or unreadable image — use PNG/JPEG or the PDF')
  // White under the image: a transparent PNG flattened to JPEG would otherwise
  // come out on black and the printed text would be unreadable.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  return canvas
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      reject(new Error('Unsupported or unreadable image — use PNG/JPEG or the PDF'))
      return
    }
    canvas.toBlob(
      blob => (blob
        ? resolve(blob)
        : reject(new Error('Unsupported or unreadable image — use PNG/JPEG or the PDF'))),
      'image/jpeg',
      quality,
    )
  })
}

/**
 * Shrink a slip photo to something the extractor will actually read: longest
 * edge 2200px, JPEG, stepped down until the encoded result is <= 3 MB.
 *
 * PDFs pass through untouched below 8 MB and are REFUSED above it — a PDF is
 * the pages, and silently sending part of one would be worse than saying no.
 *
 * Returns the file to send. Throws with a sentence the operator can act on.
 */
export async function compressImageForExtraction(file) {
  if (!file) throw new Error('No file to read.')
  const type = mediaTypeFor(file)

  if (type === 'application/pdf') {
    if (file.size > MAX_PDF_BYTES) {
      throw new Error(
        `That PDF is ${mb(file.size)} MB — the limit is 8 MB. Re-export it at a lower `
        + 'resolution, or split it and upload the pages that carry the line table.',
      )
    }
    return file
  }

  if (!IMAGE_MEDIA_TYPES.includes(type)) {
    throw new Error('Unsupported or unreadable image — use PNG/JPEG or the PDF')
  }

  // EXIF orientation applied at decode: a slip photographed in portrait on a
  // tablet arrives rotated otherwise, and the model reads it sideways.
  let bitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch (err) {
    console.error('Decoding the slip image failed:', err)
    throw new Error('Unsupported or unreadable image — use PNG/JPEG or the PDF')
  }

  try {
    const longest = Math.max(bitmap.width, bitmap.height)
    const fit = longest > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / longest : 1

    let smallest = null
    for (const step of SCALE_STEPS) {
      for (const quality of JPEG_QUALITIES) {
        const blob = await canvasToJpeg(drawToCanvas(bitmap, fit * step), quality)
        if (!smallest || blob.size < smallest.size) smallest = blob
        if (blob.size <= MAX_IMAGE_BYTES) return asJpegFile(blob, file)
      }
    }
    // Every rung tried and still over. Send the smallest rather than refuse:
    // it is far below the band that fails, and the operator gets an answer.
    console.warn(
      `Slip image would not compress under ${mb(MAX_IMAGE_BYTES)} MB; `
      + `sending the smallest re-encode at ${mb(smallest.size)} MB.`,
    )
    return asJpegFile(smallest, file)
  } finally {
    bitmap.close?.()
  }
}

function asJpegFile(blob, original) {
  const base = String(original?.name || 'slip').replace(/\.[^.]+$/, '')
  return new File([blob], `${base}.jpg`, { type: 'image/jpeg' })
}

// What actually went wrong, in the operator's banner: the error's own name, the
// HTTP status when the SDK carries one, and the function's message when it sent
// one. A generic "that slip could not be read" hides exactly the difference
// between an expired station sign-in and a photo the model refused.
async function describeInvokeError(error) {
  let serverMessage = ''
  try {
    const body = await error?.context?.json?.()
    serverMessage = body?.error || body?.message || ''
  } catch {
    serverMessage = ''
  }
  const status = error?.context?.status ?? null
  const parts = []
  if (error?.name) parts.push(error.name)
  if (status) parts.push(`HTTP ${status}`)
  const message = serverMessage || error?.message
  if (message) parts.push(message)
  return parts.join(' · ') || 'The extraction service could not be reached.'
}

// The Authorization header, taken from the session the way every PostgREST call
// in this app takes it. supabase-js routes functions.invoke through the same
// authed fetch, but that fetch falls back to the ANON key when the session has
// gone — and an anon bearer reaches the function and is refused there as
// "Unauthorized" (verified against TEST). At a bench station whose 8h kiosk JWT
// has expired that is precisely what happens, so the token is read explicitly
// and a dead session is named rather than sent.
async function invokeAuthHeaders() {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) {
    throw new Error('This station is signed out — PIN in again, then upload the slip.')
  }
  return { Authorization: `Bearer ${token}` }
}

/**
 * Returns the `slip` envelope, or throws. Every caller must treat a throw as
 * "the operator uploads again or files this one by hand" — extraction is a
 * convenience, never the record.
 */
export async function extractPackingSlip(file) {
  if (!file) throw new Error('No file to read.')
  const media_type = mediaTypeFor(file)
  if (!media_type) {
    throw new Error('That file type is not a packing slip — upload a PDF or a photo.')
  }
  const file_base64 = await fileToBase64(file)
  const headers = await invokeAuthHeaders()

  const { data, error } = await withTimeout(
    supabase.functions.invoke(FUNCTION_NAME, { body: { file_base64, media_type }, headers }),
    EXTRACTION_TIMEOUT_MS,
    'Reading the slip timed out after 2 minutes.',
  )

  if (error) {
    // The whole object, not just its message — the SDK hides the status and the
    // function's own body behind `context`, and that is what a diagnosis needs.
    console.error('packing-slip-extract failed:', error, {
      media_type, base64_length: file_base64.length, file_name: file?.name,
    })
    throw new Error(await describeInvokeError(error))
  }
  if (!data?.ok || !data.slip) {
    throw new Error(data?.error || 'The extraction service returned nothing readable.')
  }
  return data.slip
}

// ---------------------------------------------------------------------------
// SO → kit lots
// ---------------------------------------------------------------------------

/**
 * Candidate kit lots for the slip's order number. The RPC resolves the SO the
 * same way the backfill loader does (D-KSTC-25 / D-KSTC-27) and returns ids;
 * the rows themselves come back through the registry's own loader so they
 * render identically to every other lot list in the module.
 *
 * Returns { rows, matchedVia: { [lotId]: 'direct' | 'invoice_direct' } }.
 */
export async function findLotsBySo(soText) {
  const raw = String(soText || '').trim()
  if (!raw) return { rows: [], matchedVia: {} }

  const { data, error } = await supabase.rpc('kit_find_lots_by_so', { p_so: raw })
  if (error) throw error

  const matchedVia = {}
  for (const r of data || []) matchedVia[r.kit_lot_id] = r.matched_via
  const ids = Object.keys(matchedVia)
  if (!ids.length) return { rows: [], matchedVia }

  const rows = await lotsByIds(ids)
  rows.sort((a, b) => (b.lot_number || 0) - (a.lot_number || 0))
  return { rows, matchedVia }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Record one slip group's confirmed lines against one kit lot.
 * `operatorId` is the PIN operator at the bench or the session user in the
 * office — the same created_by discipline kit_assign_and_log follows, because
 * on a kiosk JWT auth.uid() is the device's anchor, not the person.
 *
 * Returns { inserted, skipped }. Re-running is safe and reports 0 inserted.
 */
export async function savePackingSlipGroup({
  kitLotId, shipmentNumber, shipDate, lines, operatorId,
}) {
  const payload = (lines || []).map(l => ({
    part_number: l.part_number ?? '',
    lot_number: l.lot_number ?? '',
    qty: l.qty_shipped ?? null,
    so_line_no: l.line_no ?? null,
  }))

  const { data, error } = await supabase.rpc('kit_record_component_lots', {
    p_kit_lot_id: kitLotId,
    p_shipment_number: shipmentNumber || null,
    p_ship_date: shipDate || null,
    p_lines: payload,
    p_operator_id: operatorId || null,
  })
  if (error) throw error

  const row = typeof data === 'string' ? JSON.parse(data) : data
  return { inserted: row?.inserted ?? 0, skipped: row?.skipped ?? 0 }
}

/**
 * Upload the slip to S3 under kit-stc/lots/{lot}/packing-slips/ and file a
 * kit_stc_documents row against the lot. uploadDocument stamps the
 * {timestamp}_{filename} leaf itself, so two slips for one lot never collide.
 *
 * Each affected lot gets its own copy and its own row: a slip covering two kits
 * is evidence for both, and a lot's drawer must never depend on another lot's
 * record to show its paperwork.
 */
export async function attachSlipDocument({ kitLotId, file, uploadedBy }) {
  const { filePath, fileSize, mimeType } = await uploadDocument(
    file, `${SLIP_PREFIX}/${kitLotId}/packing-slips`)

  const { error } = await supabase.from('kit_stc_documents').insert({
    kit_lot_id: kitLotId,
    document_type: 'packing_slip',
    file_name: file.name,
    file_path: filePath,
    file_size: fileSize,
    mime_type: mimeType || file.type || null,
    uploaded_by: uploadedBy || null,
  })
  if (error) throw error
  return { filePath }
}
