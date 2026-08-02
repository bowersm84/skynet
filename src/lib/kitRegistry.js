// Kit & STC Registry — query layer for the /kits Search tab (Round B).
//
// Everything here reads base tables directly. Per the standing Supabase rule
// (Decisions.md "Supabase query nesting limit") embeds never go deeper than one
// level; anything that would need a second hop is done as a stepwise id-set
// fetch merged client-side. There are deliberately no RPCs or views yet
// (D-KSTC-08) — revisit if row volumes make the id-set pattern slow.

import { supabase } from './supabase'

export const PAGE_SIZE = 50

// PostgREST sends selects as GET, so a huge `.in()` list becomes a huge URL.
// Chunk id lists and merge client-side rather than risking a truncated request.
const IN_CHUNK = 100

// Supabase caps a single response (default max-rows). Page explicitly.
const FETCH_PAGE = 1000

export const TYPEAHEAD_DEBOUNCE = 250
export const FIELD_DEBOUNCE = 400
export const TYPEAHEAD_LIMIT = 8

export const BOOK_ORDER = ['SK203', 'BEECH', 'TRIM', 'RV']

export const SOURCE_LABEL = {
  paper_transcription: 'Paper transcription',
  skynet: 'SkyNet',
  fishbowl: 'Fishbowl',
}

export const OPEN_REQUEST_STATUSES = ['new', 'needs_info', 'matched']

// ---------------------------------------------------------------------------
// Small pure helpers (shared with the Kit Entry tab)
// ---------------------------------------------------------------------------

// Local date parts, never toISOString — the local-noon-UTC rule (Decisions.md).
export function todayLocal() {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

export function daysAgoLocal(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

export function formatLogDate(value) {
  if (!value) return '—'
  const [y, m, d] = String(value).split('-').map(Number)
  if (!y || !m || !d) return String(value)
  return new Date(y, m - 1, d).toLocaleDateString()
}

// PostgREST `or=(a.ilike.*,b.ilike.*)` is comma/paren delimited — a term
// carrying either breaks the filter parse. Strip them before interpolating.
export function sanitizeTerm(term) {
  return (term || '').replace(/[,()%*\\]/g, ' ').trim()
}

// "SK203 99000" — the display form everywhere in this module.
export function lotLabel(lot) {
  if (!lot) return '—'
  const code = lot.book?.code || lot.book_code || '?'
  return `${code} ${lot.lot_number}`
}

export function chunk(arr, size = IN_CHUNK) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export function uniq(arr) {
  return [...new Set(arr.filter(v => v != null))]
}

// ---------------------------------------------------------------------------
// Chunked / paged primitives
// ---------------------------------------------------------------------------

// Sum an exact head-count across chunks of an `.in()` list.
async function countIn(table, col, ids, decorate) {
  if (!ids.length) return 0
  let total = 0
  for (const part of chunk(ids)) {
    let q = supabase.from(table).select('id', { count: 'exact', head: true }).in(col, part)
    if (decorate) q = decorate(q)
    const { count, error } = await q
    if (error) throw error
    total += count || 0
  }
  return total
}

// Fetch rows across chunks of an `.in()` list, merged.
async function selectIn(table, cols, col, ids, decorate) {
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

// Page through a whole result set (used for id-set builds that exceed max-rows).
async function fetchAll(table, cols, decorate) {
  const out = []
  for (let from = 0; ; from += FETCH_PAGE) {
    let q = supabase.from(table).select(cols).range(from, from + FETCH_PAGE - 1)
    if (decorate) q = decorate(q)
    const { data, error } = await q
    if (error) throw error
    out.push(...(data || []))
    if (!data || data.length < FETCH_PAGE) break
  }
  return out
}

async function headCount(table, decorate) {
  let q = supabase.from(table).select('id', { count: 'exact', head: true })
  if (decorate) q = decorate(q)
  const { count, error } = await q
  if (error) throw error
  return count || 0
}

// One-level embeds only. Enough to render a lot row without a second hop.
const LOT_ROW_COLS =
  'id, lot_number, log_date, kit_part_as_written, customer_as_written, invoice_as_written, ' +
  'record_status, source, transcription_confidence, kit_sku_id, party_id, book_id, ' +
  'book:kit_books(code, category), sku:kit_skus(part_number, description), party:kit_parties(name)'

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export async function loadBooks() {
  const { data, error } = await supabase
    .from('kit_books')
    .select('id, code, name, category, first_lot, last_lot, is_active')
  if (error) throw error
  return [...(data || [])].sort((a, b) => {
    const ia = BOOK_ORDER.indexOf(a.code); const ib = BOOK_ORDER.indexOf(b.code)
    if (ia !== ib) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
    return (a.code || '').localeCompare(b.code || '')
  })
}

// ---------------------------------------------------------------------------
// Typeaheads
// ---------------------------------------------------------------------------

export async function searchParties(term) {
  const t = sanitizeTerm(term)
  if (t.length < 2) return []
  const { data, error } = await supabase
    .from('kit_parties')
    .select('id, name, normalized_name, fishbowl_customer_number, country')
    .or(`name.ilike.%${t}%,normalized_name.ilike.%${t}%`)
    .order('name')
    .limit(TYPEAHEAD_LIMIT)
  if (error) throw error
  return data || []
}

export async function searchSkus(term) {
  const t = sanitizeTerm(term)
  if (t.length < 2) return []
  const { data, error } = await supabase
    .from('kit_skus')
    .select('id, part_number, description, kit_scope, stc_applicability')
    .or(`part_number.ilike.%${t}%,description.ilike.%${t}%`)
    .eq('is_active', true)
    .order('part_number')
    .limit(TYPEAHEAD_LIMIT)
  if (error) throw error
  return data || []
}

export async function searchComponents(term) {
  const t = sanitizeTerm(term)
  if (t.length < 2) return []
  const { data, error } = await supabase
    .from('kit_components')
    .select('id, part_number, description, part_id')
    .or(`part_number.ilike.%${t}%,description.ilike.%${t}%`)
    .order('part_number')
    .limit(TYPEAHEAD_LIMIT)
  if (error) throw error
  return data || []
}

// Aircraft: serial exact + registration ilike + historical registration ilike,
// merged client-side (three separate reads, no nesting).
export async function searchAircraft(term) {
  const t = sanitizeTerm(term)
  if (t.length < 2) return []
  const [bySerial, byReg, byHistory] = await Promise.all([
    supabase.from('aircraft').select('id, serial_number, registration, make_model').eq('serial_number', t),
    supabase.from('aircraft').select('id, serial_number, registration, make_model').ilike('registration', `%${t}%`).limit(TYPEAHEAD_LIMIT),
    supabase.from('aircraft_registrations').select('aircraft_id').ilike('registration', `%${t}%`).limit(TYPEAHEAD_LIMIT),
  ])
  const found = new Map()
  for (const a of bySerial.data || []) found.set(a.id, a)
  for (const a of byReg.data || []) if (!found.has(a.id)) found.set(a.id, a)

  const historyIds = uniq((byHistory.data || []).map(r => r.aircraft_id)).filter(id => !found.has(id))
  if (historyIds.length) {
    const rows = await selectIn('aircraft', 'id, serial_number, registration, make_model', 'id', historyIds)
    for (const a of rows) if (!found.has(a.id)) found.set(a.id, { ...a, _viaHistory: true })
  }
  return [...found.values()].slice(0, TYPEAHEAD_LIMIT)
}

// ---------------------------------------------------------------------------
// Field previews
// ---------------------------------------------------------------------------

// Bare kit # → the one lot that owns it. Ranges are disjoint today (D-KSTC-02)
// so this is unambiguous, but the query is any-book on purpose.
export async function previewLotByNumber(n) {
  if (!/^\d+$/.test(String(n).trim())) return null
  const { data, error } = await supabase
    .from('kit_lots')
    .select(LOT_ROW_COLS)
    .eq('lot_number', Number(n))
  if (error) throw error
  return (data || [])[0] || null
}

// Round A's invoice echo, lifted so both tabs share one implementation.
export async function lookupInvoice(invoiceNumber) {
  const raw = String(invoiceNumber || '').trim()
  if (!raw) return null
  const { data: inv, error } = await supabase
    .from('fishbowl_invoices')
    .select('id, invoice_number, so_number, party_id, first_ship_date, salesperson, invoice_lines')
    .eq('invoice_number', raw)
    .maybeSingle()
  if (error) throw error
  if (!inv) return { found: false }
  let partyName = null
  if (inv.party_id) {
    const { data: p } = await supabase.from('kit_parties').select('name').eq('id', inv.party_id).maybeSingle()
    partyName = p?.name || null
  }
  return { found: true, ...inv, partyName }
}

// ---------------------------------------------------------------------------
// Component → SKU → lot → airframe walk (the recall chain)
// ---------------------------------------------------------------------------

export async function skuIdsForComponent(componentId) {
  const rows = await fetchAll('kit_bom_lines', 'kit_sku_id', q => q.eq('component_id', componentId))
  return uniq(rows.map(r => r.kit_sku_id))
}

export async function componentRecall(componentId) {
  const skuIds = await skuIdsForComponent(componentId)
  if (!skuIds.length) return { skuIds: [], skuCount: 0, activeLotCount: 0, airframeCount: 0, lotCountBySku: {} }

  const activeLotCount = await countIn('kit_lots', 'kit_sku_id', skuIds, q => q.eq('record_status', 'active'))

  // Every lot (any status) for those SKUs — drives both the per-SKU tallies and
  // the airframe walk.
  const lotRows = []
  for (const part of chunk(skuIds)) {
    lotRows.push(...await fetchAll('kit_lots', 'id, kit_sku_id', q => q.in('kit_sku_id', part)))
  }
  const lotCountBySku = {}
  for (const r of lotRows) lotCountBySku[r.kit_sku_id] = (lotCountBySku[r.kit_sku_id] || 0) + 1

  // Airframes reachable either through those lots or straight off the SKU.
  const lotIds = uniq(lotRows.map(r => r.id))
  const [viaLots, viaSku] = await Promise.all([
    selectIn('kit_installations', 'aircraft_id', 'kit_lot_id', lotIds),
    selectIn('kit_installations', 'aircraft_id', 'kit_sku_id', skuIds),
  ])
  const airframeCount = uniq([...viaLots, ...viaSku].map(r => r.aircraft_id)).length

  return { skuIds, skuCount: skuIds.length, activeLotCount, airframeCount, lotCountBySku }
}

export async function skusByIds(ids) {
  return selectIn('kit_skus', 'id, part_number, description, kit_scope, stc_applicability', 'id', ids)
}

// ---------------------------------------------------------------------------
// Lots listing — server-side pagination, with an id-set fallback
// ---------------------------------------------------------------------------

// filters: { partyId, customerText, skuId, skuIds, invoiceText, dateFrom, dateTo,
//            bookId, recordStatus, lotIds }
// `lotIds`/`skuIds` are pre-resolved id sets. When one is large enough to need
// chunking the server can't paginate it, so we page the id set client-side and
// hydrate exactly one page of rows.
function applyLotFilters(q, f) {
  if (f.partyId) q = q.eq('party_id', f.partyId)
  else if (f.customerText) {
    const t = sanitizeTerm(f.customerText)
    if (f.customerPartyIds?.length) {
      q = q.or(`customer_as_written.ilike.%${t}%,party_id.in.(${f.customerPartyIds.join(',')})`)
    } else {
      q = q.ilike('customer_as_written', `%${t}%`)
    }
  }
  if (f.skuId) q = q.eq('kit_sku_id', f.skuId)
  if (f.lotNumber != null) q = q.eq('lot_number', f.lotNumber)
  if (f.invoiceText) q = q.eq('invoice_as_written', String(f.invoiceText).trim())
  if (f.dateFrom) q = q.gte('log_date', f.dateFrom)
  if (f.dateTo) q = q.lte('log_date', f.dateTo)
  if (f.bookId) q = q.eq('book_id', f.bookId)
  if (f.recordStatus) q = q.eq('record_status', f.recordStatus)
  return q
}

function needsIdSet(f) {
  if (f.lotIds) return true
  if (f.skuIds && f.skuIds.length > IN_CHUNK) return true
  return false
}

export async function loadLots(filters, page = 0) {
  const f = { ...filters }

  if (needsIdSet(f)) {
    // Resolve the constrained id set once, page it client-side, hydrate 50 rows.
    let ids = f.lotIds
    if (!ids) {
      const rows = []
      for (const part of chunk(f.skuIds)) {
        rows.push(...await fetchAll('kit_lots', 'id, lot_number', q => applyLotFilters(q.in('kit_sku_id', part), f)))
      }
      rows.sort((a, b) => (a.lot_number || 0) - (b.lot_number || 0))
      ids = rows.map(r => r.id)
    }
    const total = ids.length
    const pageIds = ids.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
    const rows = await selectIn('kit_lots', LOT_ROW_COLS, 'id', pageIds)
    const order = new Map(pageIds.map((id, i) => [id, i]))
    rows.sort((a, b) => order.get(a.id) - order.get(b.id))
    return { rows, total }
  }

  if (f.skuIds) f.skuIdsInline = f.skuIds

  const decorate = q => {
    let out = applyLotFilters(q, f)
    if (f.skuIdsInline) out = out.in('kit_sku_id', f.skuIdsInline)
    return out
  }

  const [{ count }, { data, error }] = await Promise.all([
    decorate(supabase.from('kit_lots').select('id', { count: 'exact', head: true })),
    decorate(supabase.from('kit_lots').select(LOT_ROW_COLS))
      .order('lot_number', { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1),
  ])
  if (error) throw error
  return { rows: data || [], total: count || 0 }
}

// Stat cards for the filtered lens.
export async function filteredLotStats(filters) {
  const books = await loadBooks()
  const base = f => applyLotFilters(supabase.from('kit_lots').select('id', { count: 'exact', head: true }), f)

  const withIn = (q) => (filters.skuIds && filters.skuIds.length <= IN_CHUNK)
    ? q.in('kit_sku_id', filters.skuIds)
    : q

  // A chunked sku set can't ride along on a head count — sum per chunk instead.
  const countWith = async (extra = {}) => {
    const f = { ...filters, ...extra }
    if (filters.skuIds && filters.skuIds.length > IN_CHUNK) {
      let total = 0
      for (const part of chunk(filters.skuIds)) {
        const { count } = await applyLotFilters(
          supabase.from('kit_lots').select('id', { count: 'exact', head: true }).in('kit_sku_id', part), f)
        total += count || 0
      }
      return total
    }
    const { count } = await withIn(base(f))
    return count || 0
  }

  const [total, ...byBookCounts] = await Promise.all([
    countWith(),
    ...books.map(b => countWith({ bookId: b.id })),
  ])
  const [active, voided, noEntry] = await Promise.all([
    countWith({ recordStatus: 'active' }),
    countWith({ recordStatus: 'void' }),
    countWith({ recordStatus: 'no_entry' }),
  ])

  // % with SKU resolved — count the null-SKU remainder and subtract.
  let nullSku = 0
  if (filters.skuIds && filters.skuIds.length > IN_CHUNK) {
    nullSku = 0 // an sku-constrained set can't contain null-SKU rows
  } else {
    const { count } = await withIn(base(filters)).is('kit_sku_id', null)
    nullSku = count || 0
  }

  return {
    total,
    byBook: books.map((b, i) => ({ book: b, count: byBookCounts[i] })).filter(r => r.count > 0),
    byStatus: { active, void: voided, no_entry: noEntry },
    skuResolvedPct: total ? Math.round(((total - nullSku) / total) * 100) : null,
  }
}

// ---------------------------------------------------------------------------
// Entity lenses
// ---------------------------------------------------------------------------

async function firstLastLogDate(decorate) {
  const [asc, desc] = await Promise.all([
    decorate(supabase.from('kit_lots').select('log_date')).not('log_date', 'is', null)
      .order('log_date', { ascending: true }).limit(1),
    decorate(supabase.from('kit_lots').select('log_date')).not('log_date', 'is', null)
      .order('log_date', { ascending: false }).limit(1),
  ])
  return { first: asc.data?.[0]?.log_date || null, last: desc.data?.[0]?.log_date || null }
}

export async function partyLens(partyId) {
  const books = await loadBooks()
  const forParty = q => q.eq('party_id', partyId)

  const [total, ...byBookCounts] = await Promise.all([
    headCount('kit_lots', forParty),
    ...books.map(b => headCount('kit_lots', q => forParty(q).eq('book_id', b.id))),
  ])
  const dates = await firstLastLogDate(forParty)
  const salesCount = await headCount('kit_sales', q => q.eq('party_id', partyId))

  // Their lots, ids + sku ids, for the distinct-SKU tally and the STC walks.
  const lotRows = await fetchAll('kit_lots', 'id, kit_sku_id, record_status, book_id', forParty)
  const distinctSkus = uniq(lotRows.map(r => r.kit_sku_id)).length
  const lotIds = lotRows.map(r => r.id)

  // Open STC requests: raised BY them, or pointing at one of their lots.
  const [byRequester, byLot] = await Promise.all([
    supabase.from('stc_requests').select('id')
      .eq('requester_party_id', partyId).in('status', OPEN_REQUEST_STATUSES),
    selectIn('stc_requests', 'id, status', 'kit_lot_id', lotIds,
      q => q.in('status', OPEN_REQUEST_STATUSES)),
  ])
  const openRequests = uniq([...(byRequester.data || []), ...byLot].map(r => r.id)).length

  // STC coverage: their conversion-book ACTIVE lots that have an issuance
  // reachable through an installation. Denominator today ~136, numerator 0.
  const conversionBookIds = books.filter(b => b.category === 'conversion').map(b => b.id)
  const conversionLotIds = lotRows
    .filter(r => r.record_status === 'active' && conversionBookIds.includes(r.book_id))
    .map(r => r.id)

  let coveredLots = 0
  if (conversionLotIds.length) {
    const installs = await selectIn('kit_installations', 'id, kit_lot_id', 'kit_lot_id', conversionLotIds)
    const installIds = uniq(installs.map(i => i.id))
    if (installIds.length) {
      const issued = await selectIn('stc_issuances', 'installation_id', 'installation_id', installIds,
        q => q.eq('is_voided', false))
      const issuedInstallIds = new Set(issued.map(r => r.installation_id))
      coveredLots = uniq(installs.filter(i => issuedInstallIds.has(i.id)).map(i => i.kit_lot_id)).length
    }
  }

  const { data: sales } = await supabase
    .from('kit_sales')
    .select('id, so_number, customer_po, order_date, ship_date, so_status, salesperson')
    .eq('party_id', partyId)
    .order('so_number')
    .limit(200)

  return {
    total,
    byBook: books.map((b, i) => ({ book: b, count: byBookCounts[i] })).filter(r => r.count > 0),
    dates,
    distinctSkus,
    salesCount,
    openRequests,
    coverage: {
      denominator: conversionLotIds.length,
      numerator: coveredLots,
      pct: conversionLotIds.length ? Math.round((coveredLots / conversionLotIds.length) * 100) : null,
    },
    sales: sales || [],
  }
}

export async function skuLens(skuId) {
  const books = await loadBooks()
  const forSku = q => q.eq('kit_sku_id', skuId)

  const [total, ...byBookCounts] = await Promise.all([
    headCount('kit_lots', forSku),
    ...books.map(b => headCount('kit_lots', q => forSku(q).eq('book_id', b.id))),
  ])
  const dates = await firstLastLogDate(forSku)
  const bomCount = await headCount('kit_bom_lines', q => q.eq('kit_sku_id', skuId))

  // Installations for this SKU: direct, or through one of its lots.
  const lotRows = await fetchAll('kit_lots', 'id', forSku)
  const lotIds = lotRows.map(r => r.id)
  const [direct, viaLots] = await Promise.all([
    supabase.from('kit_installations').select('id').eq('kit_sku_id', skuId),
    selectIn('kit_installations', 'id', 'kit_lot_id', lotIds),
  ])
  const installCount = uniq([...(direct.data || []), ...viaLots].map(r => r.id)).length

  const { data: bom } = await supabase
    .from('kit_bom_lines')
    .select('id, line_number, qty_per_kit, uom, component_id, component:kit_components(part_number, description, part_id)')
    .eq('kit_sku_id', skuId)
    .order('line_number')

  return {
    total,
    byBook: books.map((b, i) => ({ book: b, count: byBookCounts[i] })).filter(r => r.count > 0),
    dates,
    bomCount,
    installCount,
    bom: bom || [],
  }
}

export async function invoiceLens(invoiceNumber) {
  const invoice = await lookupInvoice(invoiceNumber)
  const raw = String(invoiceNumber || '').trim()

  // Lots referencing it: by the as-written value, or through the sale line of
  // the invoice's SO (the loader's link pass, D-KSTC-07).
  const byWritten = await fetchAll('kit_lots', 'id', q => q.eq('invoice_as_written', raw))
  let byLine = []
  if (invoice?.found && invoice.so_number) {
    const { data: sale } = await supabase.from('kit_sales').select('id').eq('so_number', invoice.so_number).maybeSingle()
    if (sale) {
      const lineRows = await fetchAll('kit_sale_lines', 'id', q => q.eq('kit_sale_id', sale.id))
      const lineIds = lineRows.map(r => r.id)
      byLine = await selectIn('kit_lots', 'id', 'kit_sale_line_id', lineIds)
    }
  }
  return { invoice, lotIds: uniq([...byWritten, ...byLine].map(r => r.id)) }
}

export async function aircraftLens(aircraftId) {
  const [{ data: ac }, { data: history }, { data: installs }, { data: requests }] = await Promise.all([
    supabase.from('aircraft').select('*').eq('id', aircraftId).maybeSingle(),
    supabase.from('aircraft_registrations').select('id, registration, observed_date, source, notes')
      .eq('aircraft_id', aircraftId).order('observed_date', { ascending: false }),
    supabase.from('kit_installations')
      .select('id, kit_lot_id, kit_sku_id, install_date, status, evidence, notes, installer_party_id')
      .eq('aircraft_id', aircraftId),
    supabase.from('stc_requests')
      .select('id, intake_number, received_date, requester_name, requester_company, status, claimed_kit_number, kit_lot_id')
      .eq('aircraft_id', aircraftId).order('intake_number'),
  ])

  // Hydrate each installation's lot + SKU separately (no second-level nesting).
  const lotIds = uniq((installs || []).map(i => i.kit_lot_id))
  const skuIds = uniq((installs || []).map(i => i.kit_sku_id))
  const [lots, skus] = await Promise.all([
    selectIn('kit_lots', 'id, lot_number, book_id, book:kit_books(code)', 'id', lotIds),
    selectIn('kit_skus', 'id, part_number, description', 'id', skuIds),
  ])
  const lotById = new Map(lots.map(l => [l.id, l]))
  const skuById = new Map(skus.map(s => [s.id, s]))

  return {
    aircraft: ac || null,
    history: history || [],
    installations: (installs || []).map(i => ({
      ...i, lot: lotById.get(i.kit_lot_id) || null, sku: skuById.get(i.kit_sku_id) || null,
    })),
    requests: requests || [],
  }
}

// ---------------------------------------------------------------------------
// Drawers
// ---------------------------------------------------------------------------

export async function lotDetail(lotId) {
  const { data: lot, error } = await supabase
    .from('kit_lots')
    .select(`${LOT_ROW_COLS}, source_page, transcription_notes, notes, kit_sale_line_id, stud_number, rec_platemount_number, created_at`)
    .eq('id', lotId)
    .maybeSingle()
  if (error) throw error
  if (!lot) return null

  // Sale line → SO → invoices, walked one hop at a time.
  let saleLine = null; let sale = null; let invoices = []
  if (lot.kit_sale_line_id) {
    const { data: sl } = await supabase.from('kit_sale_lines')
      .select('id, kit_sale_id, kit_sku_id, qty_ordered, qty_shipped, invoice_numbers')
      .eq('id', lot.kit_sale_line_id).maybeSingle()
    saleLine = sl || null
    if (sl?.kit_sale_id) {
      const { data: s } = await supabase.from('kit_sales')
        .select('id, so_number, customer_po, order_date, ship_date, so_status, salesperson')
        .eq('id', sl.kit_sale_id).maybeSingle()
      sale = s || null
      if (s?.so_number) {
        const { data: inv } = await supabase.from('fishbowl_invoices')
          .select('id, invoice_number, so_number, first_ship_date, salesperson')
          .eq('so_number', s.so_number)
        invoices = inv || []
      }
    }
  }

  const [{ data: requests }, { data: installs }] = await Promise.all([
    supabase.from('stc_requests')
      .select('id, intake_number, received_date, requester_name, requester_company, status, claimed_kit_number, claimed_registration, claimed_aircraft_serial, aircraft_id, notes')
      .eq('kit_lot_id', lotId).order('intake_number'),
    supabase.from('kit_installations')
      .select('id, aircraft_id, kit_sku_id, install_date, status, evidence, notes')
      .eq('kit_lot_id', lotId),
  ])

  const acIds = uniq([...(installs || []).map(i => i.aircraft_id), ...(requests || []).map(r => r.aircraft_id)])
  const aircraft = await selectIn('aircraft', 'id, serial_number, registration, make_model', 'id', acIds)
  const acById = new Map(aircraft.map(a => [a.id, a]))

  const installIds = (installs || []).map(i => i.id)
  const issuanceRows = await selectIn('stc_issuances',
    'id, installation_id, stc_certificate_id, doc_version, sent_to_name, sent_date, method, is_voided, notes',
    'installation_id', installIds)
  const certs = await selectIn('stc_certificates', 'id, stc_number, description', 'id',
    uniq(issuanceRows.map(r => r.stc_certificate_id)))
  const certById = new Map(certs.map(c => [c.id, c]))

  return {
    lot,
    saleLine, sale, invoices,
    requests: (requests || []).map(r => ({ ...r, aircraft: acById.get(r.aircraft_id) || null })),
    installations: (installs || []).map(i => ({ ...i, aircraft: acById.get(i.aircraft_id) || null })),
    issuances: issuanceRows.map(r => ({ ...r, certificate: certById.get(r.stc_certificate_id) || null })),
  }
}

export async function partyDetail(partyId) {
  const [{ data: party }, { data: sales }] = await Promise.all([
    supabase.from('kit_parties').select('*').eq('id', partyId).maybeSingle(),
    supabase.from('kit_sales').select('id, so_number, order_date, ship_date, so_status, customer_po')
      .eq('party_id', partyId).order('so_number').limit(100),
  ])
  return { party: party || null, sales: sales || [] }
}

export async function componentDetail(componentId) {
  const { data: component } = await supabase
    .from('kit_components').select('*').eq('id', componentId).maybeSingle()
  let mesPart = null
  if (component?.part_id) {
    const { data: p } = await supabase.from('parts')
      .select('id, part_number, description, part_type, is_active').eq('id', component.part_id).maybeSingle()
    mesPart = p || null
  }
  const skuIds = await skuIdsForComponent(componentId)
  const skus = await skusByIds(skuIds)
  return { component: component || null, mesPart, skus }
}

export async function skuDetail(skuId) {
  const { data: sku } = await supabase.from('kit_skus').select('*').eq('id', skuId).maybeSingle()
  const lens = await skuLens(skuId)
  return { sku: sku || null, ...lens }
}

// ---------------------------------------------------------------------------
// Global dashboard
// ---------------------------------------------------------------------------

export async function loadGlobalDashboard() {
  const books = await loadBooks()

  // --- Entry pulse: SkyNet-native rows logged recently -----------------------
  const d7 = daysAgoLocal(7)
  const d30 = daysAgoLocal(30)
  const pulseFor = (since, bookId) => headCount('kit_lots', q => {
    let out = q.eq('source', 'skynet').gte('created_at', `${since}T00:00:00Z`)
    if (bookId) out = out.eq('book_id', bookId)
    return out
  })
  const [pulse7, pulse30, ...pulseByBook] = await Promise.all([
    pulseFor(d7), pulseFor(d30),
    ...books.map(b => pulseFor(d7, b.id)),
  ])

  // --- Registry totals: per book, transcribed vs SkyNet-native --------------
  const totals = await Promise.all(books.map(async b => {
    const [all, paper, native] = await Promise.all([
      headCount('kit_lots', q => q.eq('book_id', b.id)),
      headCount('kit_lots', q => q.eq('book_id', b.id).eq('source', 'paper_transcription')),
      headCount('kit_lots', q => q.eq('book_id', b.id).eq('source', 'skynet')),
    ])
    return { book: b, all, paper, native }
  }))

  // --- Queues 1 + 2 both read the same small stc_requests set ---------------
  const requests = await fetchAll('stc_requests',
    'id, intake_number, received_date, requester_name, requester_company, status, ' +
    'claimed_kit_number, claimed_registration, claimed_aircraft_serial, aircraft_id, kit_lot_id')
  const reqAircraftIds = uniq(requests.map(r => r.aircraft_id))
  const reqAircraft = await selectIn('aircraft', 'id, serial_number, registration', 'id', reqAircraftIds)
  const acById = new Map(reqAircraft.map(a => [a.id, a]))

  // (1) no aircraft serial — unlinked, or linked to an airframe with no serial.
  const q1 = requests
    .filter(r => !r.aircraft_id || !acById.get(r.aircraft_id)?.serial_number)
    .map(r => ({ ...r, aircraft: acById.get(r.aircraft_id) || null }))

  // (2) claimed a kit # but no lot resolved — split on whether the claimed
  //     number falls inside a seeded book's range (client-side, 4 book rows).
  const inSomeBookRange = (n) => books.some(b =>
    b.first_lot != null && b.last_lot != null && n >= b.first_lot && n <= b.last_lot)
  const q2 = requests
    .filter(r => r.claimed_kit_number && !r.kit_lot_id)
    .map(r => {
      const raw = String(r.claimed_kit_number).trim()
      const n = /^\d+$/.test(raw) ? Number(raw) : null
      return { ...r, split: (n != null && inSomeBookRange(n)) ? 'awaiting_transcription' : 'unmatched' }
    })

  // (3) active lots with no SKU resolved.
  const q3 = await fetchAll('kit_lots', LOT_ROW_COLS,
    q => q.eq('record_status', 'active').is('kit_sku_id', null).order('lot_number'))

  // (4) SKUs referenced by a lot or a sale line but carrying no BOM.
  const [lotSkuRows, lineSkuRows, bomSkuRows] = await Promise.all([
    fetchAll('kit_lots', 'kit_sku_id', q => q.not('kit_sku_id', 'is', null)),
    fetchAll('kit_sale_lines', 'kit_sku_id'),
    fetchAll('kit_bom_lines', 'kit_sku_id'),
  ])
  const referenced = uniq([...lotSkuRows, ...lineSkuRows].map(r => r.kit_sku_id))
  const withBom = new Set(bomSkuRows.map(r => r.kit_sku_id))
  const q4Ids = referenced.filter(id => !withBom.has(id))
  const q4 = await skusByIds(q4Ids)

  // (5) HEADLINE — conversion-book active lots with no STC activity at all.
  //     The request/installation lot-id sets are tiny (2 and 2), so the
  //     anti-join is a client-side Set difference (D-KSTC-08).
  const conversionBookIds = books.filter(b => b.category === 'conversion').map(b => b.id)
  const conversionLots = conversionBookIds.length
    ? await fetchAll('kit_lots', LOT_ROW_COLS,
        q => q.eq('record_status', 'active').in('book_id', conversionBookIds).order('lot_number'))
    : []
  const [reqLotRows, instLotRows] = await Promise.all([
    fetchAll('stc_requests', 'kit_lot_id', q => q.not('kit_lot_id', 'is', null)),
    fetchAll('kit_installations', 'kit_lot_id', q => q.not('kit_lot_id', 'is', null)),
  ])
  const touched = new Set([...reqLotRows, ...instLotRows].map(r => r.kit_lot_id))
  const q5 = conversionLots.filter(l => !touched.has(l.id))

  return {
    pulse: {
      last7: pulse7,
      last30: pulse30,
      byBook: books.map((b, i) => ({ book: b, count: pulseByBook[i] })).filter(r => r.count > 0),
    },
    totals,
    queues: {
      noAircraftSerial: q1,
      claimedUnresolved: q2,
      lotsWithoutSku: q3,
      skusWithoutBom: q4,
      conversionNoStc: q5,
      conversionTotal: conversionLots.length,
    },
  }
}
