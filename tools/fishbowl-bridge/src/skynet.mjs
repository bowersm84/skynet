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
