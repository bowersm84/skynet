// fishbowl.mjs — minimal Fishbowl Advanced REST client: login, logout, data-query (read) and, since
// v1.7 (D-PRICE-53), ONE write path: importRows -> POST /api/import/<name>. Nothing else writes.
// node:http is used deliberately: /api/data-query is a GET with a SQL body, which fetch() refuses to send.
import http from 'node:http'

export class FishbowlError extends Error {
  constructor(message, status, body) {
    super(message)
    this.name = 'FishbowlError'
    this.status = status
    this.body = body
  }
}

// Fishbowl occasionally emits a description byte that is not valid UTF-8 (a cp1252 ® for example).
// Decode strictly first; if that fails, fall back to latin1 so the character survives instead of becoming U+FFFD.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
function decodeBody(buf) {
  try { return strictUtf8.decode(buf) } catch { return buf.toString('latin1') }
}

export class Fishbowl {
  constructor(cfg, log) {
    this.cfg = cfg
    this.log = log
    this.token = null
  }

  _call(method, path, headers = {}, body, timeoutOverride = null) {
    const { host, port } = this.cfg
    const timeoutMs = timeoutOverride || this.cfg.timeoutMs
    return new Promise((resolve, reject) => {
      if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body)
      const req = http.request({ host, port, method, path, headers, timeout: timeoutMs }, (res) => {
        const chunks = []
        res.on('data', (c) => { chunks.push(c) })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: decodeBody(Buffer.concat(chunks)) }))
      })
      req.on('timeout', () => req.destroy(new Error(`Fishbowl request timed out after ${timeoutMs} ms (${method} ${path})`)))
      req.on('error', reject)
      if (body !== undefined) req.write(body)
      req.end()
    })
  }

  async login() {
    const { appName, appDescription, appId, user, pass } = this.cfg
    const res = await this._call('POST', '/api/login', { 'Content-Type': 'application/json' }, JSON.stringify({
      appName, appDescription, appId, username: user, password: pass,
    }))
    if (res.status !== 200) {
      throw new FishbowlError(`Fishbowl login failed (${res.status}): ${res.body.slice(0, 300)}`, res.status, res.body)
    }
    this.token = JSON.parse(res.body).token
    this.log.info('fishbowl login ok')
  }

  async logout() {
    if (!this.token) return
    try {
      await this._call('POST', '/api/logout', { Authorization: `Bearer ${this.token}` })
    } catch (e) {
      this.log.warn(`fishbowl logout failed: ${e.message}`)
    }
    this.token = null
  }

  async ensureSession() {
    if (!this.token) await this.login()
  }

  // Runs one read-only SQL statement through /api/data-query and returns an array of row objects.
  async query(sql) {
    await this.ensureSession()
    let res = await this._call('GET', '/api/data-query', {
      Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/sql',
    }, sql)
    if (res.status === 401) {
      // session expired or server restarted — re-login once and retry
      this.token = null
      await this.login()
      res = await this._call('GET', '/api/data-query', {
        Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/sql',
      }, sql)
    }
    if (res.status !== 200) {
      throw new FishbowlError(`data-query failed (${res.status}): ${res.body.slice(0, 500)} :: ${sql.slice(0, 200)}`, res.status, res.body)
    }
    const parsed = JSON.parse(res.body)
    if (!Array.isArray(parsed)) throw new FishbowlError(`data-query returned a non-array: ${res.body.slice(0, 300)}`, res.status, res.body)
    return parsed
  }

  // D-PRICE-53: the one write. POSTs a CSV import as JSON (array of arrays, header row first) to
  // /api/import/<name>, where <name> is the import's name with spaces as dashes (Pricing-Rules,
  // Product, Product-Tree-Categories, Product-Tree, Customer-Group-Relations). Fishbowl applies the
  // whole file or none of it. The caller (push.mjs) is the only place this is invoked, and it only
  // gets there when FB_PUSH_ENABLED is true and the bridge is on the allowed SkyNet host.
  async importRows(name, rows) {
    if (!Array.isArray(rows) || rows.length < 2) throw new FishbowlError(`import ${name}: nothing to send`, 0, '')
    await this.ensureSession()
    const path = `/api/import/${encodeURIComponent(name)}`
    const body = JSON.stringify(rows)
    const headers = () => ({ Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' })
    let res = await this._call('POST', path, headers(), body, this.cfg.importTimeoutMs)
    if (res.status === 401) {
      this.token = null
      await this.login()
      res = await this._call('POST', path, headers(), body, this.cfg.importTimeoutMs)
    }
    if (res.status < 200 || res.status >= 300) {
      throw new FishbowlError(`import ${name} failed (${res.status}): ${String(res.body).slice(0, 1500)}`, res.status, res.body)
    }
    return { status: res.status, body: res.body }
  }

  // Convenience: run several statements inside one session (per_cycle mode logs in/out around them).
  async withSession(fn) {
    if (this.cfg.sessionMode === 'per_cycle') {
      await this.login()
      try { return await fn(this) } finally { await this.logout() }
    }
    await this.ensureSession()
    return fn(this)
  }
}
