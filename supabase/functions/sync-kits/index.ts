// SkyNet — Edge Function: sync-kits (D-PRICE-49)
// Deployed via Supabase Dashboard — no local CLI pipeline (same as manage-users).
// Source-controlled here; always edit this file first, then deploy.
//
// Writes kit prices from the SkyNet price book to the public skybolt-kits project
// (xqemckrgbirjkicpjfpn), so a kit's price on the site is the book's component sum by
// construction. The site's code does not change.
//
// Two hard rules, enforced here and in plan.ts:
//   * never INSERT into the site's `kits` — the site owns its kit list
//   * never DELETE a `kits` or `kit_pricing` row — prices are superseded (is_current = false),
//     never removed, so the site keeps its history
// kit_components IS replaced for a kit whose BOM has moved; that table is derived data.
//
// Secrets (Matt sets with `supabase secrets set`):
//   KITS_SUPABASE_URL, KITS_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { planSync, type RegistryKit, type SiteComponent, type SiteKit, type SitePrice } from './plan.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// PostgREST sends selects as GET, so keep write batches well inside URL/body limits.
const WRITE_BATCH = 200

// SkyNet's own calendar day (America/New_York), never the container's UTC date — the same
// local-date rule the rest of the app follows.
function todayNewYork(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function inBatches<T>(rows: T[], size: number, fn: (chunk: T[]) => Promise<void>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  // Parsed early so the log row can be written even when the run fails.
  let asOf = todayNewYork()
  let dryRun = true
  let triggeredBy = 'manual'
  let skynetAdmin: ReturnType<typeof createClient> | null = null

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return jsonResponse({ error: 'Missing Authorization header' }, 401)

    // Caller must be an active SkyNet admin — the manage-users check, verbatim in spirit.
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    )
    const { data: { user: caller }, error: callerError } = await callerClient.auth.getUser()
    if (callerError || !caller) return jsonResponse({ error: 'Invalid auth token' }, 401)

    const { data: callerProfile, error: profileError } = await callerClient
      .from('profiles').select('role, roles, is_active').eq('id', caller.id).single()
    // The bridge signs in as the `integration` profile (D-FB-07) and drives the nightly push.
    const roles: string[] = Array.isArray(callerProfile?.roles) ? callerProfile.roles : []
    const allowed = callerProfile?.role === 'admin' || callerProfile?.role === 'integration' || roles.includes('integration')
    if (profileError || !callerProfile || !allowed || !callerProfile.is_active) {
      return jsonResponse({ error: 'Forbidden: admin or integration access required' }, 403)
    }

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    const url = new URL(req.url)
    asOf = String(body.as_of ?? url.searchParams.get('as_of') ?? todayNewYork())
    const dryRaw = body.dry_run ?? url.searchParams.get('dry_run')
    dryRun = dryRaw === undefined || dryRaw === null ? true : !(dryRaw === false || dryRaw === 'false')
    triggeredBy = String(body.triggered_by ?? url.searchParams.get('triggered_by') ?? 'manual')

    skynetAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // --- 1. the book's answer ------------------------------------------------------------------
    const { data: regRows, error: regError } = await skynetAdmin.rpc('pricing_kit_prices', { p_as_of: asOf })
    if (regError) throw new Error(`pricing_kit_prices failed: ${regError.message}`)
    const registry = (regRows || []) as RegistryKit[]
    const bookLabel = registry.find(r => r.book_label)?.book_label ?? null
    const inBook = registry.filter(r => r.in_book).length

    // Never push from a book that carries no kits — on 2026-09-15 that is Rev 81, and a blind run
    // would read every kit as "not in the book" and leave the site untouched but the log misleading.
    if (!registry.length || !inBook) {
      const row = await writeLog(skynetAdmin, {
        triggered_by: triggeredBy, as_of: asOf, book_label: bookLabel, dry_run: dryRun,
        kits_seen: registry.length, prices_written: 0, prices_unchanged: 0, stale_marked: 0,
        discontinued: 0, components_rewritten: 0, unmatched_registry_only: [], unmatched_site_only: [],
        report: { skipped: true, reason: !registry.length ? 'no book in effect on this date' : 'the book in effect carries no kits', in_book: inBook },
        error: null,
      })
      return jsonResponse(row)
    }

    // --- 2. the site's current state ------------------------------------------------------------
    const kitsUrl = Deno.env.get('KITS_SUPABASE_URL') ?? ''
    const kitsKey = Deno.env.get('KITS_SERVICE_ROLE_KEY') ?? ''
    if (!kitsUrl || !kitsKey) throw new Error('KITS_SUPABASE_URL / KITS_SERVICE_ROLE_KEY are not set')
    const site = createClient(kitsUrl, kitsKey)

    const siteKits = await readAll<SiteKit>(site, 'kits', 'kit_number, description, family, status')
    const sitePrices = await readAll<SitePrice>(site, 'kit_pricing', 'id, kit_number, list_price, effective_date, source, is_current', q => q.eq('is_current', true))
    const siteComponents = await readAll<SiteComponent>(site, 'kit_components', 'id, kit_number, line, component_number, component_description, qty')

    // --- 3/4. plan --------------------------------------------------------------------------------
    const plan = planSync({ registry, siteKits, sitePrices, siteComponents })

    // --- 5. apply (unless dry run) ----------------------------------------------------------------
    if (!dryRun) {
      const supersede = plan.actions.flatMap(a => (a.action === 'price_write' || a.action === 'discontinue' ? a.supersede_price_ids : []))
      await inBatches(supersede, WRITE_BATCH, async (chunk) => {
        const { error } = await site.from('kit_pricing').update({ is_current: false }).in('id', chunk)
        if (error) throw new Error(`superseding kit_pricing failed: ${error.message}`)
      })

      const inserts = plan.actions.filter(a => a.action === 'price_write').map(a => ({
        kit_number: a.kit_number,
        list_price: a.book_price,
        effective_date: a.effective_date,
        source: `SkyNet ${bookLabel ?? ''}`.trim(),
        is_current: true,
        dealer_price: null,
        volume_price: null,
      }))
      await inBatches(inserts, WRITE_BATCH, async (chunk) => {
        const { error } = await site.from('kit_pricing').insert(chunk)
        if (error) throw new Error(`inserting kit_pricing failed: ${error.message}`)
      })

      for (const a of plan.actions.filter(x => x.action === 'stale_mark' && x.stale_source)) {
        const { error } = await site.from('kit_pricing').update({ source: a.stale_source })
          .eq('kit_number', a.kit_number).eq('is_current', true)
        if (error) throw new Error(`marking STALE failed for ${a.kit_number}: ${error.message}`)
      }

      const discontinued = plan.actions.filter(a => a.action === 'discontinue').map(a => a.kit_number)
      await inBatches(discontinued, WRITE_BATCH, async (chunk) => {
        const { error } = await site.from('kits').update({ status: 'discontinued', updated_at: new Date().toISOString() }).in('kit_number', chunk)
        if (error) throw new Error(`setting status=discontinued failed: ${error.message}`)
      })

      for (const a of plan.actions.filter(x => x.family_update)) {
        const { error } = await site.from('kits').update({ family: a.family_update, updated_at: new Date().toISOString() }).eq('kit_number', a.kit_number)
        if (error) throw new Error(`updating family failed for ${a.kit_number}: ${error.message}`)
      }

      // Components are derived data: replace this kit's rows, never another kit's.
      for (const a of plan.actions.filter(x => x.components_rewrite)) {
        const { error: delErr } = await site.from('kit_components').delete().eq('kit_number', a.kit_number)
        if (delErr) throw new Error(`clearing kit_components failed for ${a.kit_number}: ${delErr.message}`)
        const rows = (a.components_rewrite || []).map((c, i) => ({
          kit_number: a.kit_number, line: i + 1, component_number: c.component,
          component_description: c.description, qty: c.qty,
        }))
        if (!rows.length) continue
        const { error: insErr } = await site.from('kit_components').insert(rows)
        if (insErr) throw new Error(`writing kit_components failed for ${a.kit_number}: ${insErr.message}`)
      }
    }

    const row = await writeLog(skynetAdmin, {
      triggered_by: triggeredBy, as_of: asOf, book_label: bookLabel, dry_run: dryRun,
      kits_seen: plan.counts.kits_seen,
      prices_written: plan.counts.prices_written,
      prices_unchanged: plan.counts.prices_unchanged,
      stale_marked: plan.counts.stale_marked,
      discontinued: plan.counts.discontinued,
      components_rewritten: plan.counts.components_rewritten,
      unmatched_registry_only: plan.unmatched_registry_only,
      unmatched_site_only: plan.unmatched_site_only,
      report: {
        counts: plan.counts,
        actions: plan.actions
          .filter(a => a.action !== 'price_unchanged')
          .map(a => ({
            kit: a.kit_number, registry_kit: a.registry_kit_number, match: a.match, action: a.action,
            site_price: a.site_price, book_price: a.book_price, reason: a.reason,
            components: a.components_rewrite ? a.components_rewrite.length : null,
            family: a.family_update,
          })),
      },
      error: null,
    })
    return jsonResponse(row)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('sync-kits failed:', message)
    if (skynetAdmin) {
      await writeLog(skynetAdmin, {
        triggered_by: triggeredBy, as_of: asOf, book_label: null, dry_run: dryRun,
        kits_seen: null, prices_written: null, prices_unchanged: null, stale_marked: null,
        discontinued: null, components_rewritten: null, unmatched_registry_only: null,
        unmatched_site_only: null, report: null, error: message,
      }).catch(e => console.error('kits_sync_runs insert failed:', e))
    }
    return jsonResponse({ error: message }, 500)
  }
})

// Page a whole table — the site's kit list is small, but "small" is not a guarantee.
async function readAll<T>(
  client: ReturnType<typeof createClient>,
  table: string,
  cols: string,
  decorate?: (q: ReturnType<ReturnType<typeof createClient>['from']>) => unknown,
): Promise<T[]> {
  const page = 1000
  const out: T[] = []
  for (let from = 0; ; from += page) {
    let q = client.from(table).select(cols).range(from, from + page - 1)
    if (decorate) q = decorate(q) as typeof q
    const { data, error } = await q
    if (error) throw new Error(`reading ${table} failed: ${error.message}`)
    out.push(...((data || []) as T[]))
    if (!data || data.length < page) break
  }
  return out
}

async function writeLog(client: ReturnType<typeof createClient>, row: Record<string, unknown>) {
  const { data, error } = await client.from('kits_sync_runs').insert(row).select().single()
  if (error) throw new Error(`kits_sync_runs insert failed: ${error.message}`)
  return data
}
