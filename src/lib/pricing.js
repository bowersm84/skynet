//
// Pricing Portal query + engine layer (S11, D-PRICE-01..25).
//
// Two ways to get a price:
//   • getPrice()      — the RPC `pricing_get_price`. Authoritative. Anything that
//                       leaves the screen (quotes, sheets, Lookup result) uses it.
//   • columnPrices()  — client-side mirror of the rule × ladder maths for grids,
//                       so the Catalog can render a section without a 23k-row RPC.
//                       It must agree with pricing_item_prices(); the Lookup tab
//                       shows both side by side, which is the regression check.
//
import { supabase } from './supabase'

const PAGE = 1000
export const TIERS = ['none', 'tier1', 'tier2', 'tier3', 'premier']
export const TIER_LABELS = { none: 'No tier', tier1: 'Tier 1', tier2: 'Tier 2', tier3: 'Tier 3', premier: 'Premier' }
export const TIER_COLORS = {
  none: 'bg-gray-700 text-gray-300',
  tier1: 'bg-sky-900 text-sky-200',
  tier2: 'bg-indigo-900 text-indigo-200',
  tier3: 'bg-violet-900 text-violet-200',
  premier: 'bg-amber-900 text-amber-200',
}
export const BASIS_LABELS = {
  list: 'List (Each)', qty_break: 'Quantity break', tier: 'Customer tier', premier: 'Premier',
  exception: 'Customer-part exception', kit_sum: 'Sum of components', no_price: 'No pricing available',
}

export function todayIso() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export function partKey(s) { return String(s || '').replace(/\s+/g, '').toUpperCase() }
export function money(v, dp = 2) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—'
  return Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: dp, maximumFractionDigits: dp })
}
export function num(v, dp = 0) {
  if (v === null || v === undefined) return '—'
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}
// Half-up to 2 dp, matching round(numeric, 2) in Postgres (D-PRICE-02).
export function round2(v) { return v === null || v === undefined ? null : Math.round((Number(v) + Number.EPSILON) * 100) / 100 }
export function ilikeSafe(term) { return String(term || '').replace(/[%_\\,()]/g, ' ').trim() }

// Fetch every row of a query in PAGE-size slices (PostgREST caps a request at 1000 rows).
async function fetchAll(build) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) throw error
    out.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return out
}

// ---------------------------------------------------------------- books
export async function loadBooks() {
  const { data, error } = await supabase.from('price_books').select('*').order('effective_from', { ascending: true, nullsFirst: false })
  if (error) throw error
  return data || []
}
export async function bookForDate(asOf) {
  const { data, error } = await supabase.rpc('pricing_book_for_date', { p_as_of: asOf })
  if (error) throw error
  return data || null
}
// Book in effect on a date + the next scheduled one, for the header.
export function bookContext(books, asOf) {
  const published = books.filter(b => ['scheduled', 'active'].includes(b.status) && b.effective_from)
  const current = [...published].filter(b => b.effective_from <= asOf).sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0] || null
  const next = [...published].filter(b => b.effective_from > asOf).sort((a, b) => (a.effective_from > b.effective_from ? 1 : -1))[0] || null
  return { current, next }
}
export async function loadBookMeta(bookId) {
  const [rules, ladders, sections] = await Promise.all([
    supabase.from('price_rules').select('*').eq('book_id', bookId),
    supabase.from('price_ladders').select('*').eq('book_id', bookId),
    supabase.from('price_sections').select('*').eq('book_id', bookId).order('sort'),
  ])
  for (const r of [rules, ladders, sections]) if (r.error) throw r.error
  return {
    rules: Object.fromEntries((rules.data || []).map(r => [r.code, r])),
    ladders: Object.fromEntries((ladders.data || []).map(l => [l.code, l])),
    sections: sections.data || [],
  }
}
export async function loadSectionItems(bookId, sectionId) {
  const items = await fetchAll(() => supabase.from('price_items').select('*').eq('book_id', bookId).eq('section_id', sectionId).order('sort'))
  const kitIds = items.filter(i => i.status === 'component_sum').map(i => i.id)
  let comps = []
  if (kitIds.length) {
    const { data, error } = await supabase.from('price_kit_components').select('*').in('item_id', kitIds)
    if (error) throw error
    comps = data || []
  }
  return { items, comps }
}
// Items whose part number / description / xref matches, across the whole book.
export async function searchItems(bookId, term, limit = 40) {
  const t = ilikeSafe(term)
  if (!t) return []
  const key = partKey(t)
  const { data, error } = await supabase.from('price_items')
    .select('id, section_id, part_number, part_key, description, list_price, rule_code, ladder_code, has_premier, dfar, status, xref_arconic, xref_lisi, nsn, cessna, range_of')
    .eq('book_id', bookId)
    .or(`part_key.ilike.%${key}%,description.ilike.%${t}%,xref_arconic.ilike.%${t}%,xref_lisi.ilike.%${t}%,nsn.ilike.%${t}%,cessna.ilike.%${t}%`)
    .order('part_key').limit(limit)
  if (error) throw error
  return data || []
}
// Items by part_key anywhere in the book (set components live in other sections).
export async function loadItemsByKeys(bookId, keys) {
  const uniq = [...new Set((keys || []).filter(Boolean))]
  if (!uniq.length) return []
  const out = []
  for (let i = 0; i < uniq.length; i += 200) {
    const { data, error } = await supabase.from('price_items').select('*').eq('book_id', bookId).in('part_key', uniq.slice(i, i + 200))
    if (error) throw error
    out.push(...(data || []))
  }
  return out
}
// Kit components for a set of items (lookup detail).
export async function loadKitComponents(itemId) {
  const { data, error } = await supabase.from('price_kit_components').select('*').eq('item_id', itemId)
  if (error) throw error
  return data || []
}

// ---------------------------------------------------------------- engine mirror
// Multiplier for a ladder column under a rule — same positional convention as
// _pricing_multiplier(): the Nth qty column uses m_q100 / m_q300 / m_q500.
export function multiplierFor(rule, ladder, colKey) {
  if (!rule || !ladder) return null
  let pos = 0
  for (const c of ladder.columns || []) {
    if (c.kind === 'qty') pos += 1
    if (c.key === colKey) {
      if (c.kind === 'qty') return [rule.m_q100, rule.m_q300, rule.m_q500][pos - 1] ?? null
      return { tier1: rule.m_tier1, tier2: rule.m_tier2, tier3: rule.m_tier3 }[colKey] ?? null
    }
  }
  return null
}
// The columns a grid should show for an item: Each, its ladder columns, Premier when flagged.
export function itemColumns(item, ladder) {
  const cols = [{ key: 'each', kind: 'each', label: 'Each' }, ...((ladder?.columns) || [])]
  if (item?.has_premier) cols.push({ key: 'premier', kind: 'tier', label: 'Premier' })
  return cols
}
// Price for one item at one column. `resolveComponent(partKey)` supplies a
// component item for sets (returns {item} or null). One level deep, like the RPC.
export function columnPrice(item, colKey, meta, book, resolveComponent) {
  if (!item || item.status === 'no_price') return null
  if (item.status === 'component_sum') {
    let sum = 0
    for (const kc of item._components || []) {
      const comp = resolveComponent?.(kc.component_key)
      const v = comp ? columnPrice(comp, colKey, meta, book, null) : null
      if (v === null) return null
      sum += v * Number(kc.qty || 1)
    }
    return sum
  }
  const list = Number(item.list_price)
  if (colKey === 'each') return list
  const rule = meta.rules[item.rule_code]; const ladder = meta.ladders[item.ladder_code]
  if (colKey === 'premier') {
    const m3 = multiplierFor(rule, ladder, 'tier3')
    return m3 === null ? null : list * Number(m3) * Number(book?.premier_pct ?? 0.97)
  }
  const m = multiplierFor(rule, ladder, colKey)
  return m === null ? null : list * Number(m)
}

// ---------------------------------------------------------------- the price (RPC)
export async function getPrice(part, fbCustomerId, qty, asOf) {
  const { data, error } = await supabase.rpc('pricing_get_price', {
    p_part: part, p_fb_customer_id: fbCustomerId ?? null, p_qty: qty ?? 1, p_as_of: asOf || todayIso(),
  })
  if (error) throw error
  return (data && data[0]) || null
}

// ---------------------------------------------------------------- customers
export async function searchCustomers(term, { includeInactive = false, limit = 20 } = {}) {
  const t = ilikeSafe(term)
  if (!t) return []
  let q = supabase.from('v_customer_pricing_current')
    .select('fb_customer_id, customer_number, name, name_clean, is_active, salesman, customer_id, tier, tier_since')
    .or(`name_clean.ilike.%${t}%,customer_number.ilike.%${t}%,name.ilike.%${t}%`)
    .order('is_active', { ascending: false }).order('name_clean').limit(limit)
  if (!includeInactive) q = q.eq('is_active', true)
  const { data, error } = await q
  if (error) throw error
  return data || []
}
export async function loadCustomer(fbCustomerId) {
  const { data, error } = await supabase.from('v_customer_pricing_current').select('*').eq('fb_customer_id', fbCustomerId).maybeSingle()
  if (error) throw error
  return data
}
export async function loadTierHistory(fbCustomerId) {
  const { data, error } = await supabase.from('customer_pricing')
    .select('id, tier, effective_from, effective_to, note, created_at, set_by, profiles:set_by(full_name)')
    .eq('fb_customer_id', fbCustomerId).order('effective_from', { ascending: false })
  if (error) throw error
  return data || []
}
export async function setCustomerTier(fbCustomerId, tier, effectiveFrom, note) {
  const { data, error } = await supabase.rpc('pricing_set_customer_tier', {
    p_fb_customer_id: fbCustomerId, p_tier: tier, p_effective_from: effectiveFrom || todayIso(), p_note: note || null,
  })
  if (error) throw error
  return data
}
export async function loadExceptions(fbCustomerId, { openOnly = true } = {}) {
  let q = supabase.from('price_exceptions').select('*').eq('fb_customer_id', fbCustomerId).order('effective_from', { ascending: false })
  if (openOnly) q = q.is('effective_to', null)
  const { data, error } = await q
  if (error) throw error
  return data || []
}
export async function upsertException(fbCustomerId, part, mode, value, note, effectiveFrom) {
  const { data, error } = await supabase.rpc('pricing_upsert_exception', {
    p_fb_customer_id: fbCustomerId, p_part: part, p_mode: mode, p_value: value, p_note: note || null, p_effective_from: effectiveFrom || todayIso(),
  })
  if (error) throw error
  return data
}
export async function closeException(id, effectiveTo) {
  const { error } = await supabase.rpc('pricing_close_exception', { p_id: id, p_effective_to: effectiveTo || todayIso() })
  if (error) throw error
}
export async function loadPurchases(fbCustomerId) {
  return fetchAll(() => supabase.from('v_customer_purchases').select('*').eq('fb_customer_id', fbCustomerId).order('revenue', { ascending: false }))
}
// Last N lines of one part for one customer (Quote Builder detail).
export async function loadPartHistory(fbCustomerId, part, limit = 5) {
  const { data, error } = await supabase.from('fb_so_history_lines')
    .select('so_number, fb_date_created, qty_fulfilled, qty_ordered, unit_price, so_status_id, line_status_id')
    .eq('fb_customer_id', fbCustomerId).eq('product_key', partKey(part))
    .order('fb_date_created', { ascending: false }).limit(limit)
  if (error) throw error
  return data || []
}
// Non-sellable Fishbowl products (catalog, freight, notes…) — kept out of every list.
let _excluded = null
export async function loadExcludedKeys() {
  if (_excluded) return _excluded
  const { data, error } = await supabase.from('pricing_excluded_products').select('product_key')
  if (error) throw error
  _excluded = new Set((data || []).map(r => r.product_key))
  return _excluded
}
// Fishbowl products that are NOT in the book (for the typeahead's second group).
export async function searchFbProducts(term, limit = 10) {
  const t = ilikeSafe(term)
  if (!t) return []
  const { data, error } = await supabase.from('fb_products')
    .select('fb_product_id, product_num, description, list_price, is_active')
    .eq('is_active', true).ilike('product_key', `%${partKey(t)}%`).order('product_num').limit(limit + 10)
  if (error) throw error
  const ex = await loadExcludedKeys()
  return (data || []).filter(p => !ex.has(partKey(p.product_num))).slice(0, limit)
}

// Statistics (B.1): top customers by revenue; who buys a given part.
export async function loadTopCustomers(limit = 10) {
  const { data, error } = await supabase.rpc('pricing_top_customers', { p_limit: limit })
  if (error) throw error
  return data || []
}
export async function loadPartCustomers(part, limit = 10) {
  const { data, error } = await supabase.rpc('pricing_part_customers', { p_part: part, p_limit: limit })
  if (error) throw error
  return data || []
}

// ---------------------------------------------------------------- quote draft (browser-local until Batch C saves quotes)
// Shape mirrors the coming quote_lines table so nothing is re-keyed later:
// { customer: {fb_customer_id, name_clean, customer_number, tier}, as_of, rev_label,
//   lines: [{ key, part_number, description, qty, col_key, unit_price, recommended_col, recommended_price, basis, is_override }] }
const DRAFT_KEY = (uid) => `skynet.pricing.quote_draft.${uid || 'anon'}`
export function loadDraft(uid) {
  try { const raw = localStorage.getItem(DRAFT_KEY(uid)); return raw ? JSON.parse(raw) : null } catch { return null }
}
export function saveDraft(uid, draft) {
  try { if (draft) localStorage.setItem(DRAFT_KEY(uid), JSON.stringify(draft)); else localStorage.removeItem(DRAFT_KEY(uid)) } catch { /* ignore */ }
}
export function draftTotals(draft) {
  const lines = draft?.lines || []
  const subtotal = lines.reduce((a, l) => a + Number(l.qty) * Number(l.unit_price), 0)
  return { lines: lines.length, subtotal: round2(subtotal), overrides: lines.filter(l => l.is_override).length }
}

// ---------------------------------------------------------------- price books editor (C3, D-PRICE-15/16)
export async function loadBookItems(bookId) {
  return fetchAll(() => supabase.from('price_items').select('*').eq('book_id', bookId).order('sort'))
}
export async function cloneBook(srcId, label, effectiveFrom, upliftPct, notes) {
  const { data, error } = await supabase.rpc('pricing_clone_book', { p_src: srcId, p_label: label, p_effective_from: effectiveFrom || null, p_uplift_pct: upliftPct || 0, p_notes: notes || null })
  if (error) throw error
  return data
}
export async function publishBook(bookId, effectiveFrom) {
  const { error } = await supabase.rpc('pricing_publish_book', { p_book: bookId, p_effective_from: effectiveFrom || null })
  if (error) throw error
}
export async function unpublishBook(bookId) {
  const { error } = await supabase.rpc('pricing_unpublish_book', { p_book: bookId })
  if (error) throw error
}
export async function rollBooks() {
  const { data, error } = await supabase.rpc('pricing_roll_books')
  if (error) throw error
  return data
}
export async function upliftBook(bookId, pct, sectionId) {
  const { data, error } = await supabase.rpc('pricing_uplift_book', { p_book: bookId, p_pct: pct, p_section: sectionId || null })
  if (error) throw error
  return data
}
export async function upsertItem(bookId, item) {
  const { data, error } = await supabase.rpc('pricing_upsert_item', { p_book: bookId, p_item: item })
  if (error) throw error
  return data
}
export async function deleteItem(bookId, itemId) {
  const { error } = await supabase.rpc('pricing_delete_item', { p_book: bookId, p_item: itemId })
  if (error) throw error
}
export async function upsertRule(bookId, r) {
  const { error } = await supabase.rpc('pricing_upsert_rule', { p_book: bookId, p_code: r.code, p_q100: r.m_q100, p_q300: r.m_q300, p_q500: r.m_q500, p_t1: r.m_tier1, p_t2: r.m_tier2, p_t3: r.m_tier3, p_notes: r.notes || null })
  if (error) throw error
}
export async function upsertSection(bookId, sec) {
  const { data, error } = await supabase.rpc('pricing_upsert_section', { p_book: bookId, p_id: sec.id || null, p_name: sec.name, p_sort: sec.sort, p_kind: sec.kind || 'catalog', p_note: sec.header_note || null })
  if (error) throw error
  return data
}
// Diff two books by part_key: list price / rule / ladder / status changes, adds, removals.
export function diffBooks(baseItems, newItems) {
  const a = Object.fromEntries(baseItems.map(i => [i.part_key, i])), b = Object.fromEntries(newItems.map(i => [i.part_key, i]))
  const out = []
  for (const k of Object.keys(b)) {
    const x = a[k], y = b[k]
    if (!x) { out.push({ kind: 'added', part_number: y.part_number, to: y }); continue }
    const changed = Number(x.list_price ?? -1) !== Number(y.list_price ?? -1) || x.rule_code !== y.rule_code || x.ladder_code !== y.ladder_code || x.status !== y.status || !!x.has_premier !== !!y.has_premier
    if (changed) out.push({ kind: 'changed', part_number: y.part_number, from: x, to: y, pct: x.list_price && y.list_price ? (Number(y.list_price) - Number(x.list_price)) / Number(x.list_price) : null })
  }
  for (const k of Object.keys(a)) if (!b[k]) out.push({ kind: 'removed', part_number: a[k].part_number, from: a[k] })
  return out
}
// Fishbowl Products import CSV (ProductNumber, Price) from a book — interim write-back (D-PRICE-22).
export function productsCsv(items) {
  const rows = items.filter(i => i.status === 'priced' && i.list_price !== null).map(i => [i.part_number, Number(i.list_price).toFixed(2)])
  const esc = v => (/["\r\n,]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)
  return ['ProductNumber,Price', ...rows.map(r => r.map(esc).join(','))].join('\r\n') + '\r\n'
}

// ---------------------------------------------------------------- price lists (C1, D-PRICE-21/29)
// Rows for the builder: this customer's purchased parts priced on a date (RPC pricing_customer_sheet).
export async function loadCustomerSheet(fbCustomerId, asOf, mode = 'purchased') {
  const { data, error } = await supabase.rpc('pricing_customer_sheet', { p_fb_customer_id: fbCustomerId, p_as_of: asOf, p_mode: mode })
  if (error) throw error
  return data || []
}
export async function savePriceList(payload) {
  const { data, error } = await supabase.rpc('pricing_save_price_list', { p: payload })
  if (error) throw error
  return (data && data[0]) || null
}
export async function loadPriceLists(fbCustomerId) {
  const { data, error } = await supabase.from('price_lists').select('*').eq('fb_customer_id', fbCustomerId).order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}
export async function loadPriceList(id) {
  const [{ data: list, error: e1 }, { data: lines, error: e2 }] = await Promise.all([
    supabase.from('price_lists').select('*').eq('id', id).single(),
    supabase.from('price_list_lines').select('*').eq('price_list_id', id).order('sort'),
  ])
  if (e1) throw e1
  if (e2) throw e2
  return { list, lines: lines || [] }
}
export async function markPriceListSent(id, sentTo) {
  const { error } = await supabase.rpc('pricing_mark_price_list_sent', { p_id: id, p_sent_to: sentTo || null })
  if (error) throw error
}

// ---------------------------------------------------------------- quotes (C2, D-PRICE-23)
export const QUOTE_STATUS_LABELS = { issued: 'Issued', won: 'Won', lost: 'Lost', cancelled: 'Cancelled', superseded: 'Superseded' }
export function quoteIsExpired(q) { return q?.status === 'issued' && q.valid_until && q.valid_until < todayIso() }
export async function saveQuote(payload) {
  const { data, error } = await supabase.rpc('pricing_save_quote', { p: payload })
  if (error) throw error
  return (data && data[0]) || null
}
export async function loadQuotes({ fbCustomerId = null, limit = 25 } = {}) {
  let q = supabase.from('quotes').select('*').order('created_at', { ascending: false }).limit(limit)
  if (fbCustomerId) q = q.eq('fb_customer_id', fbCustomerId)
  const { data, error } = await q
  if (error) throw error
  return data || []
}
export async function loadQuote(id) {
  const [{ data: quote, error: e1 }, { data: lines, error: e2 }] = await Promise.all([
    supabase.from('quotes').select('*').eq('id', id).single(),
    supabase.from('quote_lines').select('*').eq('quote_id', id).order('sort'),
  ])
  if (e1) throw e1
  if (e2) throw e2
  return { quote, lines: lines || [] }
}
export async function setQuoteStatus(id, status, fbSoNumber, sentTo) {
  const { error } = await supabase.rpc('pricing_set_quote_status', { p_id: id, p_status: status, p_fb_so_number: fbSoNumber || null, p_sent_to: sentTo || null })
  if (error) throw error
}

// ---------------------------------------------------------------- images (C1)
// Public bucket `pricing-images`; rows in price_images keyed by part_key (range-derived
// items are seeded too) or by the section's source_row.
const IMG_BUCKET = 'pricing-images'
export function imageUrl(path) {
  if (!path) return null
  return supabase.storage.from(IMG_BUCKET).getPublicUrl(path).data.publicUrl
}
export async function loadPartImages(keys) {
  const uniq = [...new Set((keys || []).filter(Boolean))]
  const out = {}
  for (let i = 0; i < uniq.length; i += 300) {
    const { data, error } = await supabase.from('price_images').select('id, part_key, storage_path').eq('scope', 'part').in('part_key', uniq.slice(i, i + 300))
    if (error) throw error
    for (const r of data || []) out[r.part_key] = { id: r.id, path: r.storage_path, src: imageUrl(r.storage_path) }
  }
  return out
}
export async function loadSectionImages(sourceRow) {
  if (!sourceRow) return []
  const { data, error } = await supabase.from('price_images').select('id, storage_path').eq('scope', 'section').eq('section_source_row', sourceRow).order('created_at')
  if (error) throw error
  return (data || []).map(r => ({ id: r.id, path: r.storage_path, src: imageUrl(r.storage_path) }))
}
// Admin: upload a file and register it (part = replaces that part's picture; section = adds one).
export async function addImage(file, target) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace('jpeg', 'jpg')
  const stem = target.scope === 'part' ? `parts/${partKey(target.part).replace(/[^A-Z0-9.-]/g, '_')}` : `sections/${target.sectionSourceRow}`
  const path = `${stem}_${Date.now()}.${ext}`
  const { error: upErr } = await supabase.storage.from(IMG_BUCKET).upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false })
  if (upErr) throw upErr
  const { data, error } = await supabase.rpc('pricing_upsert_image', { p_scope: target.scope, p_part: target.part || null, p_section_source_row: target.sectionSourceRow || null, p_storage_path: path })
  if (error) { await supabase.storage.from(IMG_BUCKET).remove([path]).catch(() => {}); throw error }
  return { id: data, path, src: imageUrl(path) }
}
export async function deleteImage(id) {
  const { data: path, error } = await supabase.rpc('pricing_delete_image', { p_id: id })
  if (error) throw error
  if (path) await supabase.storage.from(IMG_BUCKET).remove([path]).catch(() => {})
}

// ---------------------------------------------------------------- bridge freshness
export async function loadSyncAges() {
  const { data, error } = await supabase.from('fb_sync_state').select('last_customers_at, last_products_at, last_history_at, history_cursor').eq('id', 1).maybeSingle()
  if (error) throw error
  return data
}
export function ageLabel(ts) {
  if (!ts) return 'never'
  const sec = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000)
  if (sec < 90) return 'just now'
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`
  if (sec < 172800) return `${Math.round(sec / 3600)} h ago`
  return `${Math.round(sec / 86400)} d ago`
}
