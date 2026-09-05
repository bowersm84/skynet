// config.mjs — loads tools/fishbowl-bridge/.env (never committed) then process.env.
// Real env vars win over .env so the NSSM service can override without editing the file.
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(here, '..')
const envPath = resolve(ROOT, '.env')

// Tolerate the encodings Windows editors and PowerShell redirection produce: UTF-8 BOM, UTF-16 LE (BOM).
function readEnvText(path) {
  const buf = readFileSync(path)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  return buf.toString('utf8')
}

if (existsSync(envPath)) {
  for (const line of readEnvText(envPath).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m || line.trim().startsWith('#')) continue
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
}

const need = (k) => {
  const v = process.env[k]
  if (!v) throw new Error(`Missing required env var ${k} (set it in ${envPath} or the service environment)`)
  return v
}
const num = (k, d) => {
  const v = process.env[k]
  return v === undefined || v === '' ? d : Number(v)
}

export const config = {
  version: '1.3.0',
  host: os.hostname(),
  fb: {
    host: process.env.FB_HOST || '192.168.1.251',
    port: num('FB_PORT', 2456),
    user: need('FB_USER'),
    pass: need('FB_PASS'),
    appId: num('FB_APP_ID', 4350),
    appName: 'SkyNet Bridge',
    appDescription: 'SkyNet MES sales order sync (read-only)',
    sessionMode: process.env.SESSION_MODE === 'per_cycle' ? 'per_cycle' : 'hold',
    timeoutMs: num('FB_TIMEOUT_MS', 30000),
  },
  sb: {
    url: need('SB_URL'),
    anonKey: need('SB_ANON_KEY'),
    email: need('SB_BRIDGE_EMAIL'),
    password: need('SB_BRIDGE_PASSWORD'),
  },
  pollMs: num('POLL_MS', 20000),
  reconcileMs: num('RECONCILE_MS', 900000),
  inventoryMs: num('INVENTORY_MS', 300000),
  usersMs: num('USERS_MS', 86400000),
  // Fishbowl location groups whose stock counts as "available to ship" (D-FB-33). Default Main (1) + Warehouse (6).
  availableLocationGroups: String(process.env.AVAILABLE_LOCATION_GROUPS || '1,6')
    .split(',').map((x) => Number(x.trim())).filter(Number.isFinite),
  // Bridge v1.3 pricing mirrors (D-PRICE-26). Customers poll on an interval; products and SO history run
  // nightly at a local wall-clock time (America/New_York, Fishbowl's own clock).
  customersMs: num('POLL_CUSTOMERS_SEC', 900) * 1000,
  productsNightlyAt: process.env.PRODUCTS_NIGHTLY_AT || '02:10',
  historyNightlyAt: process.env.HISTORY_NIGHTLY_AT || '02:20',
  historyBackfillFrom: process.env.HISTORY_BACKFILL_FROM || '2023-11-27',
  historyPage: num('HISTORY_PAGE', 2000),
  pricingBatch: num('PRICING_BATCH', 500),
  overlapRevs: num('OVERLAP_REVS', 200),
  chunk: num('CHUNK', 50),
  logDir: resolve(ROOT, 'logs'),
}
