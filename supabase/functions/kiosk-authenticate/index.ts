// SkyNet — Edge Function: kiosk-authenticate
// Deployed via Supabase Dashboard — no local CLI pipeline.
//
// Verifies a kiosk operator's PIN server-side and issues a real
// Supabase-format JWT (HS256, 8h lifetime) so the kiosk client can
// run subsequent queries as `authenticated` instead of `anon`.
//
// Fail-closed semantics:
//   - 0 PIN matches  → 401 'Invalid credentials'
//   - 1 PIN match    → success
//   - >=2 matches    → 401 'Invalid credentials' (PIN collision —
//                       admin must reset one operator's PIN)
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
const ALLOWED_ROLES = ['machinist', 'admin', 'finishing', 'display']

interface AuthPayload {
  pin?: string
  machine_id?: string
  device_id?: string | null
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

    if (!pin || pin.length < 4 || !machineId) {
      return jsonResponse({ error: 'Invalid credentials' }, 401)
    }

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // PIN lookup. Pull up to 2 rows so we can detect a collision and
    // fail closed (rather than silently picking one and mis-attributing
    // every subsequent action — AS9100 / FAA traceability requirement).
    const { data: matches, error: lookupErr } = await adminClient
      .from('profiles')
      .select('id, full_name, username, role, email, home_location_id, can_float, can_approve_compliance, is_active')
      .eq('pin_code', pin)
      .eq('is_active', true)
      .limit(2)

    if (lookupErr) {
      console.error('kiosk-authenticate lookup error:', lookupErr)
      return jsonResponse({ error: 'Invalid credentials' }, 401)
    }

    if (!matches || matches.length === 0 || matches.length > 1) {
      // Audit collisions so admins can spot when a PIN reset is needed.
      if (matches && matches.length > 1) {
        await adminClient.from('audit_logs').insert({
          action: 'kiosk_pin_collision',
          target_type: 'machine',
          target_id: machineId,
          details: { matched_count: matches.length, device_id: deviceId },
        })
      }
      return jsonResponse({ error: 'Invalid credentials' }, 401)
    }

    const profile = matches[0]

    if (!ALLOWED_ROLES.includes(profile.role)) {
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
    const jwtSecret = Deno.env.get('SUPABASE_JWT_SECRET') ?? ''
    if (!jwtSecret) {
      console.error('SUPABASE_JWT_SECRET not configured')
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
        role: 'authenticated',
        iss: `${Deno.env.get('SUPABASE_URL')}/auth/v1`,
        iat,
        exp,
        email: profile.email,
        app_metadata: {
          kiosk: true,
          kiosk_machine_id: machineId,
          kiosk_device_id: deviceId,
        },
        user_metadata: {
          full_name: profile.full_name,
          role: profile.role,
          username: profile.username,
        },
      },
      key,
    )

    // Random opaque refresh_token. We don't actually accept it for
    // refresh (the kiosk re-PINs at expiry) but @supabase/supabase-js
    // requires a non-empty string in setSession. The client calls
    // stopAutoRefresh() right after to prevent it from being used.
    const refreshToken = crypto.randomUUID() + crypto.randomUUID()

    await adminClient.from('audit_logs').insert({
      actor_id: profile.id,
      action: 'kiosk_authenticated',
      target_type: 'machine',
      target_id: machineId,
      details: { device_id: deviceId, expires_in_seconds: SHIFT_SECONDS },
    })

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
