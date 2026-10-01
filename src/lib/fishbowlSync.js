//
// Pricing Portal — Fishbowl pricing link, portal side (D-PRICE-53 Batch B, D-PRICE-55).
//
// Reads the sync confirmation (pricing_fb_sync_status), the drift views and the push history, and
// queues pushes that the bridge sends to Fishbowl within one 20 s cycle. WHAT gets sent is decided
// in SQL: fb_push_enqueue builds the import rows and stores them on the command, so this module only
// asks for a kind and its options.
//
// Dates: the database's CURRENT_DATE is UTC and turns over at 8 pm in Florida, so every call passes
// the portal's local date. A push made at 9 pm on Sep 30 still uses the Sep 30 book; the next book
// goes out on its own at 02:10 on its first day (fb_push_auto). The four drift views use the
// server date, which only matters on the evening before a book changes.
//
import { supabase } from './supabase'
import { todayIso } from './pricing'

export const PUSH_KINDS = ['prices', 'rules', 'tree', 'groups']
export const DRIFT_LIMIT = 500

export async function loadFbSyncStatus(asOf) {
  const { data, error } = await supabase.rpc('pricing_fb_sync_status', { p_as_of: asOf || todayIso() })
  if (error) throw error
  return data
}

// The bridge's own row: heartbeat, version, last error (the Order Queue's SyncStatusBanner reads it too).
export async function loadFbBridgeState() {
  const { data, error } = await supabase.from('fb_sync_state').select('*').eq('id', 1).maybeSingle()
  if (error) throw error
  return data
}

// Never select `payload`: a Rev 82 rules push stores about 1 MB of rows.
const HISTORY_COLS = 'id, kind, status, dry_run, options, import_name, row_count, requested_by, requested_at, started_at, finished_at, bridge_host, result, error, note'
export async function loadFbPushCommands(limit = 20) {
  const { data, error } = await supabase.from('fb_push_commands').select(HISTORY_COLS).order('id', { ascending: false }).limit(limit)
  if (error) throw error
  return data || []
}

// options: { include_resale, retire_legacy } — only_changed stays at its default (true).
export async function enqueueFbPush(kind, { options = {}, dryRun = false, note = null } = {}) {
  const { data, error } = await supabase.rpc('fb_push_enqueue', {
    p_kind: kind, p_book: null, p_options: options, p_dry_run: dryRun, p_note: note, p_as_of: todayIso(),
  })
  if (error) throw error
  return data
}

export async function cancelFbPush(id) {
  const { error } = await supabase.rpc('fb_push_cancel', { p_id: id })
  if (error) throw error
}

// Only the rows that need attention. `.in()` rather than `.not('state','in',…)`, which PostgREST
// silently answers with nothing.
const DRIFT = {
  prices: {
    view: 'v_fb_price_drift', order: 'product_num',
    states: ['mismatch', 'fb_zero', 'not_in_fishbowl'],
    cols: 'product_num, kind, book_price, fb_price, delta, state',
  },
  rules: {
    view: 'v_fb_rule_drift', order: 'name',
    states: ['missing', 'mismatch', 'inactive_in_fb', 'legacy_active', 'extra_sn_active'],
    cols: 'name, kind, state, expected_product, fb_product, expected_customer, fb_customer, expected_pa_type, fb_pa_type, expected_pct, fb_pct, expected_amount, fb_amount, expected_qty_min, fb_qty_min, expected_qty_max, fb_qty_max',
  },
  tree: {
    view: 'v_fb_tree_drift', order: 'product_num',
    states: ['missing'],
    cols: 'product_num, expected_path, state, fb_skynet_paths',
  },
  groups: {
    view: 'v_fb_group_drift', order: 'customer_name',
    states: ['missing', 'extra_in_fb'],
    cols: 'customer_name, fb_customer_id, expected_group, fb_group, tier, state',
  },
}
export async function loadFbDrift(kind) {
  const d = DRIFT[kind]
  if (!d) throw new Error(`Unknown difference list: ${kind}`)
  const { data, error } = await supabase.from(d.view).select(d.cols).in('state', d.states).order(d.order).limit(DRIFT_LIMIT)
  if (error) throw error
  return data || []
}

// Names for the history's "requested by". A nicety: if profiles cannot be read the history still renders.
export async function loadProfileNames(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))]
  if (!uniq.length) return {}
  const { data, error } = await supabase.from('profiles').select('id, full_name').in('id', uniq)
  if (error) return {}
  return Object.fromEntries((data || []).map(p => [p.id, p.full_name]))
}

// How many rows a push of each kind would send now. The payload is built server-side at enqueue
// time from the same comparison the status counts, so for the default only-changed push these agree.
export function pushSize(kind, s, { includeResale = false, retireLegacy = false } = {}) {
  if (!s) return 0
  const n = v => Number(v || 0)
  if (kind === 'prices') return n(s.products?.mismatched) + n(s.products?.fb_zero) + (includeResale ? n(s.products?.resale_drift) : 0)
  if (kind === 'rules') return n(s.rules?.missing) + n(s.rules?.mismatched) + n(s.rules?.inactive_in_fb) + n(s.rules?.extra_sn_active) + (retireLegacy ? n(s.rules?.legacy_active) : 0)
  if (kind === 'tree') return n(s.tree?.missing) + n(s.tree?.categories_missing)
  if (kind === 'groups') return n(s.groups?.missing)
  return 0
}

// A command sent nothing when it was asked to be a dry run or the bridge forced one (not on PROD, or
// FB_PUSH_ENABLED off). pricing_fb_sync_status's last_push already leaves both out.
export function effectiveDryRun(c) { return !!(c?.dry_run || c?.result?.dry_run) }

// The manual fallback for the prices push (Price Books › Fishbowl Product Pricing CSV): every row a full prices
// push would send for the book — pricing_fb_expected_products(book, false) — so Fishbowl's own product numbers
// (the book can spell a product differently: Cloc2000Kit / "CLoc 2000 Kit") and the same prices, including the
// book's three decimals for rule-priced items (D-PRICE-54). Import through Fishbowl Data › Import › Product Pricing.
// PostgREST returns at most 1,000 rows per request, so this pages, ordered, so no row is read twice or missed.
export async function fishbowlPricingCsv(bookId) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.rpc('pricing_fb_expected_products', { p_book: bookId, p_include_resale: false })
      .order('product_num').range(from, from + 999)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  const esc = v => (/["\r\n,]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)
  const csv = ['Product,Price', ...rows.map(r => `${esc(String(r.product_num))},${String(r.price)}`)].join('\r\n') + '\r\n'
  return {
    csv,
    rows: rows.length,
    kits: rows.filter(r => r.kind === 'kit').length,
    threeDp: rows.filter(r => Math.abs(Number(r.price) * 100 - Math.round(Number(r.price) * 100)) > 1e-6).length,
  }
}

// List prices to their last decimal, at least two: 1.705 · 5.28 · 5.20 · 5.00.
export function listPrice(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—'
  let s = Number(v).toFixed(4).replace(/0+$/, '')
  const dp = s.includes('.') ? s.length - s.indexOf('.') - 1 : 0
  if (dp < 2) s = Number(v).toFixed(2)
  return `$${s}`
}
