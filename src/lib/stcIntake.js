// STC intake — query / RPC / extraction layer for the Log STC tab (Round C1).
//
// Architecture is SUGGEST, NEVER COMMIT (D-KSTC-18): stc-extract returns field
// suggestions that pre-fill an editable form, a human verifies them, and the
// human's Save is the only write. Nothing in this file lets the AI reach the
// database.
//
// Reads follow the Round B rules (D-KSTC-08): base tables only, embeds never
// deeper than one level, a second hop is a separate fetch merged client-side.
// The only write path is stc_create_request — never a direct INSERT into
// stc_requests from the frontend, because the intake number is assigned
// atomically inside the RPC under an advisory lock.

import { supabase } from './supabase'
import { uploadDocument } from './s3'
import {
  PAGE_SIZE, LOT_ROW_COLS, loadBooks, lotLabel, previewLotByNumber, searchAircraft,
  searchParties, sanitizeTerm, uniq, chunk,
} from './kitRegistry'

const FUNCTION_NAME = 'stc-extract'
const EXTRACTION_TIMEOUT_MS = 90000

// Every S3 key for this module lives under one prefix so the bucket stays
// browsable by request (D-KSTC-18).
export const DOC_PREFIX = 'kit-stc/requests'

// Mirrors the stc_requests status CHECK constraint, in worklist order.
export const STC_STATUSES = ['new', 'needs_info', 'matched', 'issued', 'closed', 'unidentifiable']

export const STATUS_LABEL = {
  new: 'New',
  needs_info: 'Needs info',
  matched: 'Matched',
  issued: 'Issued',
  closed: 'Closed',
  unidentifiable: 'Unidentifiable',
}

// Mirrors the channel CHECK constraint, minus web_form — there is no web form
// yet, so offering it would let someone record a channel that never happened.
export const CHANNELS = [
  { value: 'email', label: 'Email' },
  { value: 'paper_form', label: 'Paper form' },
  { value: 'phone', label: 'Phone' },
  { value: 'other', label: 'Other' },
]

// Mirrors the kit_stc_documents document_type CHECK constraint. request_email
// is assigned automatically to the customer's own message and is not offered
// per-file — everything else defaults to 'other'.
export const DOCUMENT_TYPES = [
  { value: 'request_email', label: 'Request email' },
  { value: 'order_form', label: 'Order form' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'form_337', label: 'Form 337' },
  { value: 'photo', label: 'Photo' },
  { value: 'issued_doc', label: 'Issued document' },
  { value: 'other', label: 'Other' },
]

const REQUEST_ROW_COLS =
  'id, intake_number, received_date, channel, requester_name, requester_company, ' +
  'requester_email, claimed_kit_number, claimed_kit_part, claimed_aircraft_serial, ' +
  'claimed_registration, claimed_order_number, purchased_from_text, status, ' +
  'kit_lot_id, aircraft_id, installation_id, requester_party_id, purchased_from_party_id, notes'

// The worklist's linked-lot column. One level only — the book code needs a
// second hop, so it is resolved from the (four-row) books list client-side.
const WORKLIST_COLS = `${REQUEST_ROW_COLS}, lot:kit_lots(id, lot_number, book_id)`

// Chunked `.in()` fetch. PostgREST sends selects as GET, so a long id list would
// become a truncated URL (the same rule the Round B query layer follows).
async function inChunks(table, cols, col, ids, decorate) {
  if (!ids.length) return []
  const out = []
  for (const part of chunk(ids)) {
    let q = supabase.from(table).select(cols).in(col, part)
    if (decorate) q = decorate(q)
    const { data, error } = await q
    if (error) throw error
    out.push(...(data || []))
  }
  return out
}

// ---------------------------------------------------------------------------
// Worklist
// ---------------------------------------------------------------------------

// Newest intake first — the worklist is a queue, and the newest request is the
// one nobody has looked at yet.
export async function loadStcRequests({ status = null, page = 0 } = {}) {
  const decorate = q => (status ? q.eq('status', status) : q)

  const [{ count }, { data, error }] = await Promise.all([
    decorate(supabase.from('stc_requests').select('id', { count: 'exact', head: true })),
    decorate(supabase.from('stc_requests').select(WORKLIST_COLS))
      .order('intake_number', { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1),
  ])
  if (error) throw error

  const rows = data || []
  if (rows.some(r => r.lot)) {
    const books = await loadBooks()
    const codeById = new Map(books.map(b => [b.id, b.code]))
    for (const r of rows) {
      if (r.lot) r.lot.book_code = codeById.get(r.lot.book_id) || null
    }
  }
  return { rows, total: count || 0 }
}

// Counts for the filter chips. Every status shows, including the empty ones —
// a zero is information (nothing is stuck in needs_info), not clutter.
export async function stcStatusCounts() {
  const head = decorate => decorate(
    supabase.from('stc_requests').select('id', { count: 'exact', head: true }),
  )
  const [all, ...perStatus] = await Promise.all([
    head(q => q),
    ...STC_STATUSES.map(s => head(q => q.eq('status', s))),
  ])
  const out = { all: all.count || 0 }
  STC_STATUSES.forEach((s, i) => { out[s] = perStatus[i].count || 0 })
  return out
}

// ---------------------------------------------------------------------------
// Request detail — claims beside what they resolved to
// ---------------------------------------------------------------------------

export async function stcRequestDetail(id) {
  const { data: request, error } = await supabase
    .from('stc_requests')
    .select(`${REQUEST_ROW_COLS}, created_at, updated_at, created_by, updated_by`)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!request) return null

  // Each resolved reference is its own small read — one hop at a time.
  const [lotRes, aircraftRes, installRes, partiesRes, docsRes, authorRes] = await Promise.all([
    request.kit_lot_id
      ? supabase.from('kit_lots')
        .select('id, lot_number, kit_part_as_written, customer_as_written, log_date, book:kit_books(code, name)')
        .eq('id', request.kit_lot_id).maybeSingle()
      : Promise.resolve({ data: null }),
    request.aircraft_id
      ? supabase.from('aircraft').select('id, serial_number, registration, make_model')
        .eq('id', request.aircraft_id).maybeSingle()
      : Promise.resolve({ data: null }),
    request.installation_id
      ? supabase.from('kit_installations').select('id, install_date, status, evidence')
        .eq('id', request.installation_id).maybeSingle()
      : Promise.resolve({ data: null }),
    (() => {
      const ids = uniq([request.requester_party_id, request.purchased_from_party_id])
      return ids.length
        ? supabase.from('kit_parties').select('id, name').in('id', ids)
        : Promise.resolve({ data: [] })
    })(),
    supabase.from('kit_stc_documents')
      .select('id, document_type, file_name, file_path, file_size, mime_type, uploaded_by, uploaded_at')
      .eq('stc_request_id', id)
      .order('uploaded_at'),
    request.created_by
      ? supabase.from('profiles').select('id, full_name, username').eq('id', request.created_by).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const partyById = new Map((partiesRes.data || []).map(p => [p.id, p]))

  return {
    request,
    lot: lotRes.data || null,
    aircraft: aircraftRes.data || null,
    installation: installRes.data || null,
    requesterParty: partyById.get(request.requester_party_id) || null,
    purchasedFromParty: partyById.get(request.purchased_from_party_id) || null,
    documents: docsRes.data || [],
    author: authorRes.data || null,
  }
}

// ---------------------------------------------------------------------------
// Step 1 — find the kit (D-KSTC-19)
//
// The request is linked to the warehouse's kit log entry BEFORE the paperwork is
// touched, which is what lets the RPC derive status 'matched' and keeps intake
// out of the resolution backlog. Three fields, any combination, AND semantics.
// ---------------------------------------------------------------------------

// Same row shape as every other lot list in the module, plus the SO the bench
// captures (D-KSTC-11) — the search offers it, so the results must show it.
const KIT_SEARCH_COLS = `${LOT_ROW_COLS}, so_as_written`

// A find-the-kit search is meant to end in one obvious row. Past this many the
// operator needs to narrow, not scroll.
export const KIT_SEARCH_LIMIT = 50

// An SO reaches lots two ways: the as-written value the bench types, and the
// Fishbowl sale-line linkage the loader stages. Both resolve to an id set here,
// then constrain the main query, so the three fields stay a true AND.
async function lotIdsForSo(term) {
  const [written, sales] = await Promise.all([
    supabase.from('kit_lots').select('id').ilike('so_as_written', `%${term}%`),
    supabase.from('kit_sales').select('id').ilike('so_number', `%${term}%`),
  ])
  if (written.error) throw written.error
  if (sales.error) throw sales.error

  const ids = (written.data || []).map(r => r.id)

  const saleIds = uniq((sales.data || []).map(r => r.id))
  if (saleIds.length) {
    const lines = await inChunks('kit_sale_lines', 'id', 'kit_sale_id', saleIds)
    const lineIds = uniq(lines.map(r => r.id))
    if (lineIds.length) {
      const viaLines = await inChunks('kit_lots', 'id', 'kit_sale_line_id', lineIds)
      ids.push(...viaLines.map(r => r.id))
    }
  }
  return uniq(ids)
}

/**
 * Search kit lots by customer, sales order, and/or kit number.
 * Every supplied field narrows (AND). Returns { rows, truncated, kitNotNumeric }.
 *
 * Kit # is numeric-exact on purpose: a bare number identifies exactly one lot
 * (D-KSTC-02), and a partial-number ilike would hand back a page of near misses
 * for someone about to bind a compliance record to one of them.
 */
export async function searchKitLots({
  customerText = '', customerPartyId = null, soText = '', kitNumber = '',
} = {}) {
  const cust = sanitizeTerm(customerText)
  const so = sanitizeTerm(soText)
  const kit = String(kitNumber || '').trim()

  const empty = { rows: [], truncated: false, kitNotNumeric: false }
  if (!customerPartyId && !cust && !so && !kit) return empty
  if (kit && !/^\d+$/.test(kit)) return { ...empty, kitNotNumeric: true }

  let soLotIds = null
  if (so) {
    soLotIds = await lotIdsForSo(so)
    if (!soLotIds.length) return empty
  }

  // Free-text customer matches the as-written column OR any party the typeahead
  // resolves — the same both-sides rule the Round B lot filters use.
  let partyIds = []
  if (!customerPartyId && cust) {
    partyIds = uniq((await searchParties(cust)).map(p => p.id))
  }

  const decorate = (q) => {
    let out = q
    if (kit) out = out.eq('lot_number', Number(kit))
    if (customerPartyId) out = out.eq('party_id', customerPartyId)
    else if (cust) {
      out = partyIds.length
        ? out.or(`customer_as_written.ilike.%${cust}%,party_id.in.(${partyIds.join(',')})`)
        : out.ilike('customer_as_written', `%${cust}%`)
    }
    // Highest kit number first. The books occupy disjoint ranges (D-KSTC-02) and
    // the STC-bearing conversion book holds the highest ones, so descending puts
    // the kits an STC request is actually about at the top: searching customer
    // "Irwin" on TEST ranks SK203 99000 sixth of 219 this way and 214th
    // ascending. One over the limit, purely to detect that there are more.
    return out.order('lot_number', { ascending: false }).limit(KIT_SEARCH_LIMIT + 1)
  }

  let rows = []
  if (soLotIds) {
    for (const part of chunk(soLotIds)) {
      const { data, error } = await decorate(
        supabase.from('kit_lots').select(KIT_SEARCH_COLS).in('id', part),
      )
      if (error) throw error
      rows.push(...(data || []))
    }
    // Chunks come back independently ordered — re-sort to the same descending
    // rule before the limit is applied.
    rows.sort((a, b) => (b.lot_number || 0) - (a.lot_number || 0))
  } else {
    const { data, error } = await decorate(supabase.from('kit_lots').select(KIT_SEARCH_COLS))
    if (error) throw error
    rows = data || []
  }

  return {
    rows: rows.slice(0, KIT_SEARCH_LIMIT),
    truncated: rows.length > KIT_SEARCH_LIMIT,
    kitNotNumeric: false,
  }
}

// ---------------------------------------------------------------------------
// Live match hints — informational only
//
// Nothing here writes a foreign key. Resolution (binding a request to a lot, an
// airframe, or a party) is Round C2 office work; these chips exist so the
// person typing can see, at intake time, whether the claim is going to land.
// ---------------------------------------------------------------------------

// Numeric-exact only. A kit number the customer wrote as "SK-99000" or "99000a"
// is a claim we deliberately do not interpret (D-KSTC-07).
export async function matchClaimedKit(claimed) {
  const raw = String(claimed || '').trim()
  if (!/^\d+$/.test(raw)) return null
  const lot = await previewLotByNumber(raw)
  if (!lot) return null
  return {
    lotId: lot.id,
    label: `${lot.book?.code || '?'} ${lot.lot_number}`,
    customer: lot.party?.name || lot.customer_as_written || null,
  }
}

// Serial is an exact column match; registration is compared case-insensitively
// against both the current registration and the historical ones.
export async function matchAircraftClaim({ serial, registration }) {
  const s = sanitizeTerm(serial)
  const r = sanitizeTerm(registration)
  if (s.length < 2 && r.length < 2) return null

  const [bySerial, byReg] = await Promise.all([
    s.length >= 2 ? searchAircraft(s) : Promise.resolve([]),
    r.length >= 2 ? searchAircraft(r) : Promise.resolve([]),
  ])

  const eq = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
  const hit =
    bySerial.find(a => eq(a.serial_number, s))
    || byReg.find(a => eq(a.registration, r))
    || byReg.find(a => a._viaHistory)   // matched through aircraft_registrations
    || null
  if (!hit) return null

  return {
    aircraftId: hit.id,
    serial: hit.serial_number || null,
    registration: hit.registration || null,
    makeModel: hit.make_model || null,
    viaHistory: !!hit._viaHistory,
  }
}

// Exact (case-insensitive) beats fuzzy, and a fuzzy hit is labelled as such —
// "closest" must never read like a confirmed link.
export async function matchCompany(name) {
  const t = sanitizeTerm(name)
  if (t.length < 2) return null
  const rows = await searchParties(t)
  if (!rows.length) return null
  const lower = t.toLowerCase()
  const exact = rows.find(p => (p.name || '').trim().toLowerCase() === lower)
  const pick = exact || rows[0]
  return { partyId: pick.id, name: pick.name, exact: !!exact }
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

// Returns the `fields` envelope, or throws. Every caller must treat a throw as
// "fall back to the blank manual form" — extraction is never load-bearing.
export async function invokeStcExtract(blocks) {
  // holdingKey is bookkeeping for the form's remove-a-file path; the function
  // has no use for it and shouldn't have to ignore it.
  const payload = (blocks || []).map(({ holdingKey, ...b }) => b) // eslint-disable-line no-unused-vars

  const { data, error } = await withTimeout(
    supabase.functions.invoke(FUNCTION_NAME, { body: { blocks: payload } }),
    EXTRACTION_TIMEOUT_MS,
    'Extraction timed out after 90 seconds.',
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
  if (!data?.ok) throw new Error(data?.error || 'The extraction service returned no fields.')
  if (!data.fields || typeof data.fields !== 'object') {
    throw new Error('The extraction service returned no fields.')
  }
  return data.fields
}

// ---------------------------------------------------------------------------
// The mandatory-field rules (D-KSTC-19)
//
// These live beside createStcRequest because they MIRROR stc_create_request's
// own checks, message for message. The database is the integrity boundary and
// never trusts the form; this exists so the operator hears about a blank field
// without a round trip, and hears the same sentence either way. If the RPC's
// rules change, both sides change here.
// ---------------------------------------------------------------------------

// Ordered as the RPC checks them, which is also the order the form lays them
// out — so "focus the first invalid field" walks the screen top to bottom.
//
// Claimed kit # is required on EVERY intake, linked or not (D-KSTC-20,
// amending D-KSTC-19's linked-lot-OR-claim rule). When the customer's email
// states no number the bench enters the one from the located log entry or the
// customer's paperwork: the field records the kit identity submitted with the
// request, and a disagreement between claim and log surfaces as the mismatch
// chip rather than as a blank.
export const REQUIRED_FIELDS = [
  ['receivedDate', 'Received date is required'],
  ['requesterName', 'Requester name is required'],
  ['requesterCompany', 'Company is required'],
  ['claimedKitNumber', 'Claimed kit # is required'],
  ['claimedKitPart', 'Kit part is required'],
  ['claimedAircraftSerial', 'Aircraft serial is required'],
  ['claimedRegistration', 'Registration is required'],
  ['claimedOrderNumber', 'Order # is required'],
]

// Presence only. Claims are still never FORMAT-validated (D-KSTC-07): a kit
// number may be nonsense and a registration may be malformed — that is the
// customer's claim and it saves as written. What is required is that the fields
// are answered at all.
export function validateIntakeFields(form) {
  const errors = {}
  for (const [key, message] of REQUIRED_FIELDS) {
    if (!String(form?.[key] ?? '').trim()) errors[key] = message
  }
  return errors
}

// A claimed number that disagrees with the linked log entry is REAL DATA, not a
// mistake to block on: the customer wrote one thing, the book says another, and
// the office needs to see both. Returns the warning text, or null.
export function kitMismatchLabel(claimedKitNumber, lot) {
  const claimed = String(claimedKitNumber ?? '').trim()
  if (!lot || !claimed) return null
  if (claimed === String(lot.lot_number)) return null
  return `email claims ${claimed}, linked log is ${lotLabel(lot)}`
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

// The intake number is assigned inside the RPC under an advisory lock, so two
// people saving at once can never collide (D-KSTC-18). Authorisation lives
// there too — workflow roles OR is_salesperson — which is why this call is the
// only way a request row is ever created from the frontend.
//
// The RPC also owns the mandatory-field set and derives status from the link
// (D-KSTC-19): kit_lot_id present → 'matched', absent → 'new'. The form checks
// the same rules first so the operator hears about a blank field without a
// round trip, but the database is the boundary and never trusts the form.
export async function createStcRequest(fields) {
  const t = v => (v == null ? null : String(v).trim() || null)
  const { data, error } = await supabase.rpc('stc_create_request', {
    p_received_date: fields.receivedDate || null,
    p_channel: fields.channel || 'email',
    p_requester_name: t(fields.requesterName),
    p_requester_company: t(fields.requesterCompany),
    p_requester_email: t(fields.requesterEmail),
    p_claimed_kit_number: t(fields.claimedKitNumber),
    p_claimed_kit_part: t(fields.claimedKitPart),
    p_claimed_aircraft_serial: t(fields.claimedAircraftSerial),
    p_claimed_registration: t(fields.claimedRegistration),
    p_claimed_order_number: t(fields.claimedOrderNumber),
    p_purchased_from_text: t(fields.purchasedFrom),
    p_notes: t(fields.notes),
    p_kit_lot_id: fields.kitLotId || null,
  })
  if (error) throw error

  const row = Array.isArray(data) ? data[0] : data
  if (!row?.request_id || row.intake_number == null) {
    throw new Error('The registry did not return an intake number.')
  }
  return { requestId: row.request_id, intakeNumber: row.intake_number }
}

/**
 * Upload each held file to S3 under kit-stc/requests/{request_id}/ and record
 * it in kit_stc_documents. Uses the ordinary document upload path (lib/s3.js) —
 * there is no second upload mechanism in this app.
 *
 * Never throws on a per-file failure: the request row already exists, so the
 * caller needs to know WHICH files are missing in order to offer a retry.
 * Returns { attached: [key], failures: [{ key, name, message }] }.
 */
export async function attachRequestDocuments(requestId, holdings, uploadedBy) {
  const attached = []
  const failures = []

  for (const h of holdings || []) {
    try {
      const { filePath, fileSize, mimeType } = await uploadDocument(h.file, `${DOC_PREFIX}/${requestId}`)
      const { error } = await supabase.from('kit_stc_documents').insert({
        stc_request_id: requestId,
        document_type: h.documentType || 'other',
        file_name: h.name,
        file_path: filePath,
        file_size: fileSize,
        mime_type: mimeType || h.mimeType || null,
        uploaded_by: uploadedBy || null,
      })
      if (error) throw error
      attached.push(h.key)
    } catch (err) {
      console.error(`Attaching ${h.name} to intake ${requestId} failed:`, err)
      failures.push({ key: h.key, name: h.name, message: err.message || 'Upload failed' })
    }
  }

  return { attached, failures }
}
