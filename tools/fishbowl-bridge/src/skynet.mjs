// skynet.mjs — Supabase side of the bridge. Signs in as the `integration` profile with the anon key
// (no service-role key anywhere on the plant network) and calls the fb_* RPCs.
import { createClient } from '@supabase/supabase-js'
import { mkdirSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function makeLogger(logDir) {
  mkdirSync(logDir, { recursive: true })
  const line = (level, msg) => {
    const now = new Date()
    const text = `${now.toISOString()} ${level.padEnd(5)} ${msg}`
    process.stdout.write(text + '\n')
    try {
      appendFileSync(resolve(logDir, `bridge-${now.toISOString().slice(0, 10)}.log`), text + '\n')
    } catch { /* logging must never take the bridge down */ }
  }
  return {
    info: (m) => line('INFO', m),
    warn: (m) => line('WARN', m),
    error: (m) => line('ERROR', m),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class SkyNet {
  constructor(cfg, log) {
    this.cfg = cfg
    this.log = log
    this.client = createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
    })
    this.signedIn = false
  }

  async signIn() {
    const { error } = await this.client.auth.signInWithPassword({ email: this.cfg.email, password: this.cfg.password })
    if (error) throw new Error(`Supabase sign-in failed: ${error.message}`)
    this.signedIn = true
    this.log.info('supabase sign-in ok')
  }

  async ensureSignedIn() {
    if (!this.signedIn) await this.signIn()
  }

  // Calls an RPC with up to 3 attempts. A JWT/auth error forces a fresh sign-in before the retry.
  async rpc(name, args) {
    await this.ensureSignedIn()
    let lastErr
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { data, error } = await this.client.rpc(name, args)
      if (!error) return data
      lastErr = error
      const msg = `${error.code || ''} ${error.message || ''}`
      if (/JWT|expired|401|PGRST301/i.test(msg)) {
        this.signedIn = false
        await this.signIn()
      } else if (/42501|Not authorized/i.test(msg)) {
        throw new Error(`rpc ${name} rejected: ${msg}`) // permission problems do not heal by retrying
      }
      this.log.warn(`rpc ${name} attempt ${attempt} failed: ${msg}`)
      await sleep(1000 * attempt)
    }
    throw new Error(`rpc ${name} failed after 3 attempts: ${lastErr?.message || lastErr}`)
  }

  ingest(payload) { return this.rpc('fb_ingest_delta', { p_payload: payload }) }

  heartbeat(state) { return this.rpc('fb_heartbeat', { p_state: state }) }

  setCursor(rev) { return this.rpc('fb_set_cursor', { p_rev: rev }) }

  getCursor() { return this.rpc('fb_get_cursor', {}) }

  linkExistingCOs() { return this.rpc('fb_link_existing_cos', {}) }

  upsertUsers(rows) { return this.rpc('fb_upsert_users', { p_rows: rows }) }

  upsertInventory(rows) { return this.rpc('fb_upsert_inventory', { p_rows: rows }) }

  // Bridge v1.3 pricing mirrors (D-PRICE-26). Each RPC stamps its own fb_sync_state.last_*_at.
  upsertCustomers(rows) { return this.rpc('fb_upsert_customers', { p_rows: rows }) }

  upsertProducts(rows) { return this.rpc('fb_upsert_products', { p_rows: rows }) }

  upsertSoHistory(rows, cursor = null) { return this.rpc('fb_upsert_so_history', { p_rows: rows, p_cursor: cursor }) }

  // D-PRICE-47. Unlike the three above, this RPC stamps no fb_sync_state clock — there is no
  // last_part_costs_at column — so the poller rides the products nightly slot instead (see index.mjs).
  upsertPartCosts(rows) { return this.rpc('fb_upsert_part_costs', { p_rows: rows }) }

  // D-PRICE-49. Pushes the book's kit prices to the public skybolt-kits site. This is what makes
  // Oct 1 work without anyone present: the book flips by date at midnight and the nightly cycle
  // publishes it. The bridge signs in as the integration profile, which the function accepts.
  async syncKitsSite(triggeredBy = 'nightly') {
    await this.ensureSignedIn()
    const { data, error } = await this.client.functions.invoke('sync-kits', {
      body: { dry_run: false, triggered_by: triggeredBy },
    })
    if (error) throw new Error(`sync-kits failed: ${error.message}`)
    if (data?.error) throw new Error(`sync-kits failed: ${data.error}`)
    return data
  }

  // D-PRICE-53 mirrors (full snapshots; each RPC stamps its own fb_sync_state clock).
  upsertPricingRules(rows) { return this.rpc('fb_upsert_pricing_rules', { p_rows: rows }) }

  upsertProductTree(nodes, members) { return this.rpc('fb_upsert_product_tree', { p_nodes: nodes, p_members: members }) }

  // D-PRICE-53 push queue. pushNext claims the oldest queued command (null when there is none or one is
  // already running); pushFinish records the outcome; pushAuto queues prices/rules when the book in effect changed.
  pushNext(host) { return this.rpc('fb_push_next', { p_host: host }) }

  pushFinish(id, ok, result = null, error = null) { return this.rpc('fb_push_finish', { p_id: id, p_ok: ok, p_result: result, p_error: error }) }

  pushAuto() { return this.rpc('fb_push_auto', { p_as_of: new Date().toISOString().slice(0, 10) }) }

  // The pricing pollers' own clocks, read once at start-up. fb_sync_state is SELECT-able by authenticated.
  async pricingState() {
    await this.ensureSignedIn()
    const { data, error } = await this.client
      .from('fb_sync_state')
      .select('last_customers_at, last_products_at, last_history_at, history_cursor, last_rules_at, last_tree_at')
      .eq('id', 1)
      .maybeSingle()
    if (error) throw new Error(`fb_sync_state read failed: ${error.message}`)
    return data || { last_customers_at: null, last_products_at: null, last_history_at: null, history_cursor: null, last_rules_at: null, last_tree_at: null }
  }

  // Distinct Fishbowl part ids on product lines of open SOs (paged: PostgREST caps a request at 1000 rows).
  // D-FB-40: ordered on fb_soitem_id, the table's primary key. Without a sort, .range() pages are not a
  // partition — rows can shift between requests, so a part could be skipped at a page boundary and
  // silently drop out of the inventory scope. Same fix as pagedDistinct below.
  async openPartIds() {
    await this.ensureSignedIn()
    const ids = new Set()
    const page = 1000
    for (let from = 0; ; from += page) {
      const { data, error } = await this.client
        .from('fb_sales_order_lines')
        .select('fb_part_id, fb_sales_orders!inner(status_id)')
        .is('removed_at', null)
        .not('fb_part_id', 'is', null)
        .in('type_id', [10, 12])
        .in('fb_sales_orders.status_id', [20, 25])
        .order('fb_soitem_id')
        .range(from, from + page - 1)
      if (error) throw new Error(`fb_sales_order_lines part read failed: ${error.message}`)
      for (const r of data || []) if (r.fb_part_id) ids.add(Number(r.fb_part_id))
      if (!data || data.length < page) break
    }
    return [...ids]
  }

  // D-FB-40. Distinct values of one text column, trimmed and upper-cased, paged the same way
  // openPartIds is (PostgREST caps a request at 1000 rows). Read-only; both tables are SELECT-able
  // by `authenticated`, which is what the bridge's integration profile is.
  async pagedDistinct(table, column) {
    const out = new Set()
    const page = 1000
    for (let from = 0; ; from += page) {
      // .order() is required with .range(): without a sort PostgREST pages are not a stable
      // partition, so a row can be skipped between pages as well as repeated.
      const { data, error } = await this.client.from(table).select(column).order(column).range(from, from + page - 1)
      if (error) throw new Error(`${table}.${column} read failed: ${error.message}`)
      for (const r of data || []) {
        const v = String(r[column] ?? '').trim().toUpperCase()
        if (v) out.add(v)
      }
      if (!data || data.length < page) break
    }
    return [...out]
  }

  // Every part SkyNet knows, and every part already mirrored — the two halves of the D-FB-40 scope
  // that the open-SO set (openPartIds, D-FB-33) misses. Mirrored numbers are included so a part that
  // has left every other set still gets a fresh row each cycle instead of freezing at its last values.
  async skynetPartNums() { await this.ensureSignedIn(); return this.pagedDistinct('parts', 'part_number') }
  async mirroredPartNums() { await this.ensureSignedIn(); return this.pagedDistinct('fb_part_inventory', 'part_num') }

  async openMirrorSos() {
    await this.ensureSignedIn()
    const { data, error } = await this.client
      .from('fb_sales_orders')
      .select('fb_so_id, status_id, fb_date_last_modified')
      .is('removed_at', null)
      .in('status_id', [20, 25])
    if (error) throw new Error(`fb_sales_orders read failed: ${error.message}`)
    return data || []
  }
}
