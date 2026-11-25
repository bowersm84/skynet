// sandboxGuard.mjs — S17 D2a (D-ASM-61): the sandbox checks shared by run-test-sandbox.mjs and try-wo-post.mjs.
// The same fences as probe-sandbox-fulfill.mjs (D-ASM-59), which keeps its own copy unchanged:
//   1. The target comes only from FB_SANDBOX_URL. No default.
//   2. Before any network call: refuse skyserver, 192.168.1.251 (the live Fishbowl), localhost, 127.0.0.1.
//   3. After login and before anything else: the server's version must start with 26. and the company name with
//      SANDBOX.
// Plus the run-log redaction: no password, token, ticket or Authorization value is ever saved.
import fs from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { q } from '../src/queries.mjs'
import { parseFishbowlVersion } from '../src/fbVersion.mjs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const FORBIDDEN_HOSTS = ['skyserver', '192.168.1.251', 'localhost', '127.0.0.1']
export function sandboxTarget(env = process.env) {
  const raw = String(env.FB_SANDBOX_URL ?? '').trim()
  if (!raw) throw new Error('FB_SANDBOX_URL is not set — refusing to run (there is no default target)')
  let url
  try { url = new URL(raw) } catch { throw new Error(`FB_SANDBOX_URL is not a URL: ${raw}`) }
  if (url.protocol !== 'http:') throw new Error(`FB_SANDBOX_URL must be http://host:port, not ${url.protocol}`)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (FORBIDDEN_HOSTS.includes(host) || host.startsWith('skyserver') || host === '::1' || host.endsWith('.localhost') || host.startsWith('127.')) {
    throw new Error(`FB_SANDBOX_URL host ${host} is the live Fishbowl or this PC — refusing to run`)
  }
  return { host, port: Number(url.port || 2456), origin: `http://${url.hostname}:${url.port || 2456}` }
}

// Fence 3. Run right after login, before any other call. Returns what it read; throws if this is not the sandbox.
export async function assertSandboxServer(fb) {
  const ver = await fb.query(q.fishbowlVersion)
  const raw = ver[0]?.alterCommand ?? null
  const version = parseFishbowlVersion(raw)
  const company = await fb.query(q.companyName)
  const name = String(company[0]?.name || '')
  if (!version || !version.startsWith('26.') || !name.startsWith('SANDBOX')) {
    throw new Error(`sandbox check: this server is version ${version ?? '?'} (${JSON.stringify(raw)}), company "${name}" — not the 26.x SANDBOX; refusing`)
  }
  return { version, raw, company: name }
}

// Only the bridge's Fishbowl user and integrated-app id from tools/fishbowl-bridge/.env; FB_HOST / FB_PORT are never
// read here (the target is FB_SANDBOX_URL).
export function bridgeCredentials() {
  const file = resolve(ROOT, '.env')
  const wanted = new Set(['FB_USER', 'FB_PASS', 'FB_APP_ID'])
  const out = {}
  if (fs.existsSync(file)) {
    let text = fs.readFileSync(file)
    text = text[0] === 0xff && text[1] === 0xfe ? text.subarray(2).toString('utf16le') : text.toString('utf8').replace(/^﻿/, '')
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (m && wanted.has(m[1]) && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  }
  for (const k of wanted) if (process.env[k]) out[k] = process.env[k]
  if (!out.FB_USER || !out.FB_PASS) throw new Error('FB_USER / FB_PASS not found in tools/fishbowl-bridge/.env')
  return { user: out.FB_USER, pass: out.FB_PASS, appId: Number(out.FB_APP_ID || 4350) }
}

const SECRET_KEY = /pass(word)?|token|authorization|ticket|secret|apikey|api_key|session(id)?$/i
export function redact(v) {
  if (Array.isArray(v)) return v.map(redact)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '<redacted>' : redact(x)]))
  if (typeof v === 'string') return v.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <redacted>')
  return v
}
