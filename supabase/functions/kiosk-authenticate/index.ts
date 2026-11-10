// SkyNet — Edge Function: kiosk-authenticate
// Deployed via Supabase Dashboard — no local CLI pipeline.
//
// Verifies a kiosk operator's PIN server-side and issues a real
// Supabase-format JWT (HS256, 8h lifetime) so the kiosk client can
// run subsequent queries as `authenticated` instead of `anon`.
//
// Fail-closed semantics:
//   - The PIN is checked by pin_authenticate (the PIN vault, D-ASM-43),
//     which answers one match or none — PINs are unique in the vault.
//   - no match           → 401 'Invalid credentials'
//   - too many misses    → 429 'Too many attempts' + retry_after_seconds
//                          (5 in 10 min from this device, or 30 in 10 min
//                          from this address, D-ASM-44)
//   - role not admitted on this kiosk → 401 'Invalid credentials'
//     (D-ASM-49; a valid PIN that is not admitted is not a miss)
//
// Generic 401 messaging only — never leak which field was wrong.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { create, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SHIFT_SECONDS = 60 * 60 * 8 // 8 hours
// Each kiosk admits its own roles (D-ASM-49). The page names its kiosk; a
// missing or unknown value is the machine kiosk, so a browser still running an
// older bundle keeps working.
const KIOSK_SURFACES = ['machine', 'material', 'traveler', 'kit', 'finishing', 'assembly']
// The shop kiosks: the PRIMARY role only, as PROD ran before S17 Batch C.
const SHOP_KIOSK_ROLES = ['machinist', 'admin', 'finishing', 'display']
// The assembly kiosk: the primary role OR any entry of roles[].
const ASSEMBLY_KIOSK_ROLES = ['assembly', 'admin']

function resolveSurface(value: unknown): string {
  return typeof value === 'string' && KIOSK_SURFACES.includes(value) ? value : 'machine'
}

// A kiosk-only account (an assembler, D-ASM-46) is admitted on the assembly
// kiosk only (D-ASM-48).
function admitted(surface: string, profile: { role: string; roles?: unknown; kiosk_only?: boolean }): boolean {
  if (surface === 'assembly') {
    const roles = [profile.role, ...(Array.isArray(profile.roles) ? profile.roles : [])]
    return roles.some((r) => ASSEMBLY_KIOSK_ROLES.includes(r))
  }
  if (profile.kiosk_only === true) return false
  return SHOP_KIOSK_ROLES.includes(profile.role)
}

// The database role a kiosk-only account's token runs as (D-ASM-50): a
// Postgres role granted to authenticator with only what the assembly kiosk
// needs (migration 2026-11-10_S17_C4_kiosk_assembler_role.sql). Every other
// profile keeps 'authenticated'. To switch the tablet-only sessions back to the
// ordinary role, set this to 'authenticated' and redeploy.
const KIOSK_ONLY_DB_ROLE = 'kiosk_assembler'

interface AuthPayload {
  pin?: string
  machine_id?: string
  device_id?: string | null
  kiosk?: string
}

// Misses are counted twice (D-ASM-44), because every kiosk in the shop shares
// one public address: per device (address + the kiosk's own device id) —
// 5 misses in 10 minutes lock that device — and per address — 30 misses in
// 10 minutes lock the address, which still stops a guesser who rotates
// device ids. The address is the first entry of x-forwarded-for, which the
// gateway sets; a client-supplied value does not come first.
function throttleKeys(req: Request, deviceId: string | null): { device: string; address: string } {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'
  return { device: `ip:${ip}|dev:${deviceId || 'none'}`, address: `ip:${ip}` }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = (await req.json()) as AuthPayload
    const pin = typeof body?.pin === 'string' ? body.pin.trim() : ''
    const machineId = typeof body?.machine_id === 'string' ? body.machine_id.trim() : ''
    const deviceId = typeof body?.device_id === 'string' ? body.device_id : null
    const surface = resolveSurface(body?.kiosk)

    if (!pin || pin.length < 4 || !machineId) {
      return jsonResponse({ error: 'Invalid credentials' }, 401)
    }

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // PIN lookup in the vault (D-ASM-43). The vault holds each PIN once, so
    // there is one match or none; every miss is counted against the device
    // and the address (D-ASM-44).
    const keys = throttleKeys(req, deviceId)
    const { data: result, error: lookupErr } = await adminClient.rpc('pin_authenticate', {
      p_pin: pin,
      p_throttle_key: keys.device,
      p_scope_key: keys.address,
    })

    if (lookupErr || !result) {
      console.error('kiosk-authenticate lookup error:', lookupErr)
      return jsonResponse({ error: 'Invalid credentials' }, 401)
    }

    if (!result.ok) {
      if (result.reason === 'locked') {
        return jsonResponse({ error: 'Too many attempts', retry_after_seconds: result.retry_after_seconds }, 429)
      }
      return jsonResponse({ error: 'Invalid credentials' }, 401)
    }

    const profile = result.profile

    if (!admitted(surface, profile)) {
      return jsonResponse({ error: 'Invalid credentials' }, 401)
    }

    // Verify machine
    const { data: machine, error: machineErr } = await adminClient
      .from('machines')
      .select('id, is_active')
      .eq('id', machineId)
      .eq('is_active', true)
      .maybeSingle()

    if (machineErr || !machine) {
      return jsonResponse({ error: 'Invalid credentials' }, 401)
    }

    // Mint JWT with the project's auth secret. The Supabase API
    // accepts any HS256 token signed with this secret as a valid
    // user session, so claims must mirror what gotrue would issue.
    const jwtSecret = Deno.env.get('JWT_SECRET') ?? ''
    if (!jwtSecret) {
      console.error('JWT_SECRET not configured')
      return jsonResponse({ error: 'Server configuration error' }, 500)
    }

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(jwtSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    )

    const iat = getNumericDate(0)
    const exp = getNumericDate(SHIFT_SECONDS)

    const accessToken = await create(
      { alg: 'HS256', typ: 'JWT' },
      {
        sub: profile.id,
        aud: 'authenticated',
        // A kiosk-only account is admitted on the assembly kiosk only (admitted()).
        role: profile.kiosk_only === true ? KIOSK_ONLY_DB_ROLE : 'authenticated',
        iss: `${Deno.env.get('SUPABASE_URL')}/auth/v1`,
        iat,
        exp,
        email: profile.email,
        app_metadata: {
          kiosk: true,
          kiosk_machine_id: machineId,
          kiosk_device_id: deviceId,
          kiosk_surface: surface,
        },
        user_metadata: {
          full_name: profile.full_name,
          role: profile.role,
          username: profile.username,
          must_change_pin: profile.must_change_pin === true,
        },
      },
      key,
    )

    // Random opaque refresh_token. We don't actually accept it for
    // refresh (the kiosk re-PINs at expiry) but @supabase/supabase-js
    // requires a non-empty string in setSession. The client calls
    // stopAutoRefresh() right after to prevent it from being used.
    const refreshToken = crypto.randomUUID() + crypto.randomUUID()

    const { error: auditErr } = await adminClient.from('audit_logs').insert({
      operator_id: profile.id,
      event_type: 'kiosk_authenticated',
      details: {
        device_id: deviceId,
        expires_in_seconds: SHIFT_SECONDS,
        target_type: 'machine',
        target_id: machineId,
      },
    })
    if (auditErr) console.error('audit_logs insert failed:', auditErr)

    return jsonResponse({
      success: true,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: exp,
      operator: {
        id: profile.id,
        full_name: profile.full_name,
        username: profile.username,
        role: profile.role,
        email: profile.email,
        home_location_id: profile.home_location_id,
        can_float: profile.can_float,
        can_approve_compliance: profile.can_approve_compliance,
        roles: Array.isArray(profile.roles) ? profile.roles : [],
        must_change_pin: profile.must_change_pin === true,
        kiosk_only: profile.kiosk_only === true,
        avatar_icon: profile.avatar_icon ?? null,
        avatar_color: profile.avatar_color ?? null,
      },
    })
  } catch (err) {
    console.error('kiosk-authenticate error:', err)
    return jsonResponse({ error: 'Invalid credentials' }, 401)
  }
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}