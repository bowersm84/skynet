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

  const { data, error } = await withTimeout(
    supabase.functions.invoke(FUNCTION_NAME, { body: { file_base64, media_type } }),
    EXTRACTION_TIMEOUT_MS,
    'Reading the slip timed out after 2 minutes.',
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
