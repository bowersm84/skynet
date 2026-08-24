// fishbowl.mjs — minimal Fishbowl Advanced REST client. READ-ONLY: only login, logout, data-query.
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

export class Fishbowl {
  constructor(cfg, log) {
    this.cfg = cfg
    this.log = log
    this.token = null
  }

  _call(method, path, headers = {}, body) {
    const { host, port, timeoutMs } = this.cfg
    return new Promise((resolve, reject) => {
      if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body)
      const req = http.request({ host, port, method, path, headers, timeout: timeoutMs }, (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { data += c })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
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
