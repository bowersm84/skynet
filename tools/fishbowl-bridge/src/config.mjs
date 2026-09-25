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
  version: '1.7.0',
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
    // D-PRICE-53: an import of a few thousand rows is slower than any query; separate ceiling.
    importTimeoutMs: num('FB_IMPORT_TIMEOUT_MS', 300000),
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
  // D-FB-40: build and log the inventory payload without writing it. Only the literal `true` turns it
  // on. Deliberately the opposite default to KITS_SYNC_ENABLED, whose `?? 'true'` means a forgotten
  // key silently enables a write: here a forgotten key can only ever leave the poller writing normally.
  inventoryDryRun: String(process.env.INVENTORY_DRY_RUN ?? '').trim().toLowerCase() === 'true',
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
  // D-PRICE-49: push kit prices to the skybolt-kits site after each nightly products cycle.
  kitsSyncEnabled: String(process.env.KITS_SYNC_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
  // D-PRICE-47 part costs. No nightly time of its own: it runs immediately after the products poll, in
  // the same nightly slot, because fb_sync_state has no last_part_costs_at column to schedule it from.
  partCostsEnabled: String(process.env.PART_COSTS_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
  overlapRevs: num('OVERLAP_REVS', 200),
  chunk: num('CHUNK', 50),
  logDir: resolve(ROOT, 'logs'),
  // D-PRICE-53 Fishbowl pricing link. The rules/tree mirrors ride the products nightly slot (like part
  // costs). The push executor runs every cycle but only WRITES when both of these hold — otherwise every
  // command it claims becomes a forced dry run (rows logged, nothing sent, result.dry_run = true):
  //   FB_PUSH_ENABLED  only the literal `true` enables writes (same opposite-default rule as INVENTORY_DRY_RUN)
  //   FB_PUSH_SB_HOST  the one SkyNet host a real push may run against (default PROD). The PC bridge on TEST
  //                    can never write to Fishbowl by accident: its SB_URL is not this host.
  push: {
    enabled: String(process.env.FB_PUSH_ENABLED ?? '').trim().toLowerCase() === 'true',
    allowedSbHost: process.env.FB_PUSH_SB_HOST || 'luzungoqfuplspzbqctb.supabase.co',
    // fb_push_auto: after the nightly products poll, queue prices + rules pushes when the book in effect changed
    autoEnabled: String(process.env.FB_PUSH_AUTO ?? 'true').trim().toLowerCase() !== 'false',
    maxPerCycle: num('FB_PUSH_MAX_PER_CYCLE', 3),
  },
  rulesTreeEnabled: String(process.env.RULES_TREE_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
  // Fishbowl import names (the import's name with dashes). Only change if Fishbowl renames an import.
  importNames: {
    product: process.env.FB_IMPORT_PRODUCT || 'Product',
    rules: process.env.FB_IMPORT_RULES || 'Pricing-Rules',
    treeCategories: process.env.FB_IMPORT_TREE_CATEGORIES || 'Product-Tree-Categories',
    tree: process.env.FB_IMPORT_TREE || 'Product-Tree',
    groups: process.env.FB_IMPORT_GROUPS || 'Customer-Group-Relations',
  },
}
