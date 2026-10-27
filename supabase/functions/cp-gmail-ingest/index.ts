// SkyNet — Edge Function: cp-gmail-ingest (S16 Batch B, D-CPROG-07..12)
// Source-controlled here; always edit this file first, then deploy with verify_jwt OFF — the
// function authenticates every call itself (below).
//
// Reads the customer email trail for each active customer program into cp_emails:
//   * every mailbox in cp_email_sources (Kaytech: the five roster mailboxes by the customer's
//     domain, plus Matt's "Kaytech" label), Gmail read-only, via a Workspace service account with
//     domain-wide delegation (secret GMAIL_SA_KEY = the service account's JSON key);
//   * one row per RFC822 Message-ID, so a message seen in three mailboxes is stored once;
//   * attachments as name / type / size only — never fetched (D-CPROG-09);
//   * out-of-office / automatic replies are stored hidden (never shown, never fetched again);
//   * first pass reads from 2026-01-01, up to 80 new messages per mailbox per run, until the
//     backlog is done; after that each run looks back 3 days from the last success.
//
// Two ways in:
//   * pg_cron every 10 minutes, header x-ingest-token = Vault secret cp_ingest_token, checked
//     through cp_ingest_token_ok() (service role only);
//   * "Sync now" on the dashboard, with the signed-in user's JWT — only for programs the user is
//     rostered on.
// Writes only cp_emails and cp_email_sync_state. Never writes to Gmail (gmail.readonly).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { parseGmailMessage, gmailQuery } from './parse.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-ingest-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const BACKFILL_FROM = '2026/01/01'
const LOOKBACK_DAYS = 3
const MAX_NEW_PER_MAILBOX = 80
const MAX_LIST_PER_QUERY = 1000
const FETCH_CONCURRENCY = 5

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// ---------------------------------------------------------------- Google service-account token
function b64url(bytes: Uint8Array | string): string {
  const bin = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function importKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '')
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0))
  return await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
}

// deno-lint-ignore no-explicit-any
async function accessToken(sa: any, key: CryptoKey, mailbox: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, sub: mailbox, scope: 'https://www.googleapis.com/auth/gmail.readonly',
    aud: sa.token_uri, iat: now, exp: now + 3600,
  }))
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`)))
  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${b64url(sig)}` }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || !j.access_token) throw new Error(`token for ${mailbox}: ${j.error || res.status} ${j.error_description || ''}`.trim())
  return j.access_token
}

async function gmail(token: string, path: string) {
  const res = await fetch(`${GMAIL}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`gmail ${path.split('?')[0]}: ${res.status} ${j?.error?.message || ''}`.trim())
  return j
}

async function listIds(token: string, q: string): Promise<string[]> {
  const ids: string[] = []
  let page = ''
  do {
    const j = await gmail(token, `/messages?q=${encodeURIComponent(q)}&maxResults=500${page ? `&pageToken=${page}` : ''}`)
    for (const m of j.messages || []) ids.push(m.id)
    page = j.nextPageToken || ''
  } while (page && ids.length < MAX_LIST_PER_QUERY)
  return ids
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]) }
  })
  await Promise.all(workers)
  return out
}

const ymd = (d: Date) => `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`

// ---------------------------------------------------------------- program context
// deno-lint-ignore no-explicit-any
async function knownRefs(admin: any, program: any) {
  const [sos, hist, quotes] = await Promise.all([
    admin.from('fb_sales_orders').select('so_number, customer_po').eq('fb_customer_id', program.fb_customer_id),
    admin.from('fb_so_history_lines').select('so_number, product_num').eq('fb_customer_id', program.fb_customer_id).range(0, 9999),
    admin.from('cp_quotes').select('rfq_number, part_num').eq('program_id', program.id),
  ])
  const pos = new Set<string>()
  const soSet = new Set<string>()
  const parts = new Set<string>()
  for (const r of sos.data || []) {
    if (r.customer_po && /^\d{5,7}$/.test(String(r.customer_po).trim())) pos.add(String(r.customer_po).trim())
    if (r.so_number) soSet.add(String(r.so_number).split('-')[0].replace(/AB$/i, ''))
  }
  for (const r of hist.data || []) {
    if (r.so_number) soSet.add(String(r.so_number).split('-')[0].replace(/AB$/i, ''))
    const p = String(r.product_num || '').trim()
    if (/^[A-Z]{1,4}\d[\w-]{1,20}$/i.test(p)) parts.add(p.toUpperCase())
  }
  for (const q of quotes.data || []) if (q.part_num) parts.add(String(q.part_num).toUpperCase())
  return { pos: [...pos], sos: [...soSet], parts: [...parts] }
}

// ---------------------------------------------------------------- one mailbox
// deno-lint-ignore no-explicit-any
async function syncMailbox(admin: any, program: any, mailbox: string, sources: any[], sa: any, key: CryptoKey, known: any) {
  const { data: st } = await admin.from('cp_email_sync_state').select('*').eq('program_id', program.id).eq('mailbox', mailbox).maybeSingle()
  const runAt = new Date().toISOString()
  try {
    const since = st?.backfill_done && st?.last_success_at
      ? ymd(new Date(Date.parse(st.last_success_at) - LOOKBACK_DAYS * 86400000))
      : BACKFILL_FROM
    const token = await accessToken(sa, key, mailbox)

    const ids = new Set<string>()
    for (const s of sources) for (const id of await listIds(token, gmailQuery(s, program.email_domains, since))) ids.add(id)

    // What this mailbox has already given us (gmail_ids is { "<mailbox>:<gmailId>": true }).
    const { data: rows } = await admin.from('cp_emails').select('gmail_ids').eq('program_id', program.id)
    const seen = new Set<string>()
    for (const r of rows || []) for (const k of Object.keys(r.gmail_ids || {})) seen.add(k)
    const fresh = [...ids].filter(id => !seen.has(`${mailbox}:${id}`))
    const batch = fresh.slice(0, MAX_NEW_PER_MAILBOX)

    let added = 0
    await mapLimit(batch, FETCH_CONCURRENCY, async (id) => {
      const m = await gmail(token, `/messages/${id}?format=full`)
      if ((m.labelIds || []).includes('DRAFT')) return
      const p = parseGmailMessage(m, mailbox, program.email_domains, known)
      const key = `${mailbox}:${id}`
      const { data: existing } = await admin.from('cp_emails')
        .select('id, mailboxes, gmail_ids').eq('program_id', program.id).eq('rfc822_id', p.rfc822_id).maybeSingle()
      if (existing) {
        const mailboxes = [...new Set([...(existing.mailboxes || []), mailbox])]
        const { error } = await admin.from('cp_emails')
          .update({ mailboxes, gmail_ids: { ...(existing.gmail_ids || {}), [key]: true }, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
        if (error) throw new Error(`update ${p.rfc822_id}: ${error.message}`)
      } else {
        const { auto_reply, ...row } = p
        const { error } = await admin.from('cp_emails').insert({
          ...row, program_id: program.id, mailboxes: [mailbox], gmail_ids: { [key]: true },
          ...(auto_reply ? { hidden_at: new Date().toISOString(), hidden_reason: 'Automatic reply' } : {}),
        })
        if (error && !String(error.message).includes('duplicate')) throw new Error(`insert ${p.rfc822_id}: ${error.message}`)
        if (!error) added++
      }
    })

    const done = fresh.length <= MAX_NEW_PER_MAILBOX
    await admin.from('cp_email_sync_state').upsert({
      program_id: program.id, mailbox, backfill_done: st?.backfill_done || done,
      last_run_at: runAt, last_success_at: runAt, last_error: null,
      last_new: added, total_seen: (st?.total_seen || 0) + batch.length,
    })
    return { mailbox, listed: ids.size, fetched: batch.length, added, remaining: Math.max(0, fresh.length - batch.length) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await admin.from('cp_email_sync_state').upsert({
      program_id: program.id, mailbox, backfill_done: st?.backfill_done || false,
      last_run_at: runAt, last_success_at: st?.last_success_at || null, last_error: message.slice(0, 500),
      last_new: 0, total_seen: st?.total_seen || 0,
    })
    return { mailbox, error: message }
  }
}

// ---------------------------------------------------------------- entry
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const url = Deno.env.get('SUPABASE_URL') ?? ''
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}

    // Who is calling: the cron (Vault token) or a signed-in roster member.
    let allowedPrograms: string[] | null = null
    let trigger = 'cron'
    const ingestToken = req.headers.get('x-ingest-token')
    if (ingestToken) {
      const { data: ok, error } = await admin.rpc('cp_ingest_token_ok', { p_token: ingestToken })
      if (error || ok !== true) return jsonResponse({ error: 'Forbidden' }, 403)
    } else {
      const authHeader = req.headers.get('Authorization')
      if (!authHeader) return jsonResponse({ error: 'Missing Authorization header' }, 401)
      const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: authHeader } } })
      const { data: { user }, error } = await caller.auth.getUser()
      if (error || !user) return jsonResponse({ error: 'Invalid auth token' }, 401)
      const { data: acc } = await admin.from('customer_program_access').select('program_id').eq('profile_id', user.id)
      allowedPrograms = (acc || []).map((a: { program_id: string }) => a.program_id)
      if (!allowedPrograms.length) return jsonResponse({ error: 'Forbidden: not on any program roster' }, 403)
      trigger = 'manual'
    }

    const saRaw = Deno.env.get('GMAIL_SA_KEY')
    if (!saRaw) throw new Error('GMAIL_SA_KEY is not set')
    const sa = JSON.parse(saRaw)
    const key = await importKey(sa.private_key)

    let q = admin.from('customer_programs').select('id, code, fb_customer_id, email_domains').eq('is_active', true)
    if (body.program_code) q = q.eq('code', String(body.program_code).toUpperCase())
    const { data: programs, error: pErr } = await q
    if (pErr) throw new Error(`programs: ${pErr.message}`)

    const results = []
    for (const program of programs || []) {
      if (!program.email_domains?.length) continue
      if (allowedPrograms && !allowedPrograms.includes(program.id)) continue
      const { data: sources } = await admin.from('cp_email_sources').select('mailbox, mode, label_name').eq('program_id', program.id).eq('is_active', true)
      const byMailbox = new Map<string, unknown[]>()
      for (const s of sources || []) byMailbox.set(s.mailbox, [...(byMailbox.get(s.mailbox) || []), s])
      const known = await knownRefs(admin, program)
      for (const [mailbox, srcs] of byMailbox) {
        results.push({ program: program.code, ...(await syncMailbox(admin, program, mailbox, srcs as unknown[], sa, key, known)) })
      }
    }
    return jsonResponse({ trigger, results })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('cp-gmail-ingest failed:', message)
    return jsonResponse({ error: message }, 500)
  }
})
