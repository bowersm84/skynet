-- 1. is_salesperson flag on profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_salesperson boolean NOT NULL DEFAULT false;

-- Partial index for the dropdown query
CREATE INDEX IF NOT EXISTS idx_profiles_active_salespeople
  ON public.profiles(full_name)
  WHERE is_salesperson = true AND is_active = true;

-- 2. salesperson_id on customer_orders (nullable for backward
-- compatibility — existing COs stay null until edited).
ALTER TABLE public.customer_orders
  ADD COLUMN IF NOT EXISTS salesperson_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_customer_orders_salesperson
  ON public.customer_orders(salesperson_id);

-- 3. Mark known salespeople. Only matches users that already exist;
-- silently skips Sawyer and Peyton until their accounts are created.
UPDATE public.profiles
SET is_salesperson = true
WHERE lower(full_name) IN (
  'april braun',
  'christy exum',
  'sawyer griner',
  'peyton marshall'
);

-- Verification
SELECT full_name, username, role, is_active, is_salesperson
FROM public.profiles
WHERE is_salesperson = true
ORDER BY full_name;

-- Manager User Update --
// SkyNet — Edge Function: manage-users
// Deployed via Supabase Dashboard — no local CLI pipeline.
// Source-controlled here; always edit this file first, then paste into
// the Dashboard for both prod and test projects and click Deploy.
//
// Server-side admin user management. Uses service role key (never
// exposed to browser). Validates that the caller is an admin via their
// JWT before performing any action.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const PLACEHOLDER_DOMAIN = '@skynet.local'
const USERNAME_RE = /^[a-z0-9._-]{2,40}$/i

interface InviteUserPayload {
  email: string
  full_name: string
  role: string
  home_location_id?: string | null
  can_float?: boolean
  can_approve_compliance?: boolean
  is_salesperson?: boolean
}

interface InviteNoEmailPayload {
  username: string
  full_name: string
  role: string
  home_location_id?: string | null
  can_float?: boolean
  can_approve_compliance?: boolean
  is_salesperson?: boolean
  temp_password: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return jsonResponse({ error: 'Missing Authorization header' }, 401)
    }

    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user: caller }, error: callerError } = await callerClient.auth.getUser()
    if (callerError || !caller) {
      return jsonResponse({ error: 'Invalid auth token' }, 401)
    }

    const { data: callerProfile, error: profileError } = await callerClient
      .from('profiles')
      .select('role, is_active')
      .eq('id', caller.id)
      .single()

    if (profileError || !callerProfile || callerProfile.role !== 'admin' || !callerProfile.is_active) {
      return jsonResponse({ error: 'Forbidden: admin access required' }, 403)
    }

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const body = await req.json()
    const { action } = body

    switch (action) {
      case 'invite': {
        const payload = body.payload as InviteUserPayload
        if (!payload?.email || !payload?.full_name || !payload?.role) {
          return jsonResponse({ error: 'Missing required fields: email, full_name, role' }, 400)
        }

        const { data, error } = await adminClient.auth.admin.inviteUserByEmail(payload.email, {
          data: {
            full_name: payload.full_name,
            role: payload.role,
            username: payload.email.split('@')[0],
            location: 'Leesburg',
            home_location_id: payload.home_location_id ?? null,
            can_float: payload.can_float ?? false,
            can_approve_compliance: payload.can_approve_compliance ?? false,
            is_salesperson: payload.is_salesperson ?? false,
          },
        })

        if (error) {
          return jsonResponse({ error: error.message }, 400)
        }

        await adminClient.from('audit_logs').insert({
          actor_id: caller.id,
          action: 'user_invited',
          target_type: 'user',
          target_id: data.user?.id ?? null,
          details: { email: payload.email, role: payload.role, full_name: payload.full_name },
        })

        return jsonResponse({ success: true, user: data.user })
      }

      case 'invite_no_email': {
        const payload = body.payload as InviteNoEmailPayload
        if (!payload?.username || !payload?.full_name || !payload?.role || !payload?.temp_password) {
          return jsonResponse({ error: 'Missing required fields: username, full_name, role, temp_password' }, 400)
        }

        const username = payload.username.trim().toLowerCase()
        if (!USERNAME_RE.test(username)) {
          return jsonResponse({ error: 'Invalid username. Use 2-40 letters, digits, dot, underscore, or hyphen.' }, 400)
        }
        if (payload.temp_password.length < 6) {
          return jsonResponse({ error: 'Temp password must be at least 6 characters.' }, 400)
        }

        const placeholderEmail = `${username}${PLACEHOLDER_DOMAIN}`

        const { data: clash } = await adminClient
          .from('profiles')
          .select('id, username, email')
          .or(`username.ilike.${username},email.ilike.${placeholderEmail}`)
          .limit(1)
        if (clash && clash.length > 0) {
          return jsonResponse({ error: 'Username or placeholder email already in use.' }, 400)
        }

        const homeLocationId = payload.home_location_id || null

        const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
          email: placeholderEmail,
          password: payload.temp_password,
          email_confirm: true,
          user_metadata: {
            username,
            full_name: payload.full_name,
            role: payload.role,
            location: 'Leesburg',
            home_location_id: homeLocationId,
            can_float: payload.can_float ?? false,
            can_approve_compliance: payload.can_approve_compliance ?? false,
            is_salesperson: payload.is_salesperson ?? false,
          },
        })

        if (createErr || !created?.user) {
          return jsonResponse({ error: createErr?.message || 'Failed to create auth user' }, 400)
        }

        const { error: patchErr } = await adminClient
          .from('profiles')
          .update({
            role: payload.role,
            full_name: payload.full_name,
            home_location_id: homeLocationId,
            can_float: payload.can_float ?? false,
            can_approve_compliance: payload.can_approve_compliance ?? false,
            is_salesperson: payload.is_salesperson ?? false,
            is_active: true,
            must_change_password: true,
          })
          .eq('id', created.user.id)

        if (patchErr) {
          await adminClient.auth.admin.deleteUser(created.user.id)
          return jsonResponse({ error: `Profile setup failed: ${patchErr.message}` }, 500)
        }

        await adminClient.from('audit_logs').insert({
          actor_id: caller.id,
          action: 'user_invited_no_email',
          target_type: 'user',
          target_id: created.user.id,
          details: { username, role: payload.role, full_name: payload.full_name },
        })

        return jsonResponse({ success: true, user_id: created.user.id })
      }

      case 'resend_invite': {
        const { email } = body.payload || {}
        if (!email) return jsonResponse({ error: 'Missing email' }, 400)

        const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email)
        if (error) return jsonResponse({ error: error.message }, 400)

        await adminClient.from('audit_logs').insert({
          actor_id: caller.id,
          action: 'invite_resent',
          target_type: 'user',
          target_id: data.user?.id ?? null,
          details: { email },
        })

        return jsonResponse({ success: true })
      }

      case 'reset_password': {
        const { email } = body.payload || {}
        if (!email) return jsonResponse({ error: 'Missing email' }, 400)

        const { error } = await adminClient.auth.admin.generateLink({
          type: 'recovery',
          email,
        })
        if (error) return jsonResponse({ error: error.message }, 400)

        const { error: sendError } = await callerClient.auth.resetPasswordForEmail(email, {
          redirectTo: 'https://skynet.skybolt.com/set-password',
        })
        if (sendError) return jsonResponse({ error: sendError.message }, 400)

        await adminClient.from('audit_logs').insert({
          actor_id: caller.id,
          action: 'password_reset_sent',
          target_type: 'user',
          details: { email },
        })

        return jsonResponse({ success: true })
      }

      case 'set_password': {
        const { user_id, new_password } = body.payload || {}
        if (!user_id || !new_password) {
          return jsonResponse({ error: 'Missing user_id or new_password' }, 400)
        }
        if (new_password.length < 6) {
          return jsonResponse({ error: 'Password must be at least 6 characters.' }, 400)
        }

        const { error: updateErr } = await adminClient.auth.admin.updateUserById(user_id, {
          password: new_password,
        })
        if (updateErr) return jsonResponse({ error: updateErr.message }, 400)

        const { error: flagErr } = await adminClient
          .from('profiles')
          .update({ must_change_password: true })
          .eq('id', user_id)
        if (flagErr) return jsonResponse({ error: flagErr.message }, 400)

        await adminClient.from('audit_logs').insert({
          actor_id: caller.id,
          action: 'password_set_by_admin',
          target_type: 'user',
          target_id: user_id,
        })

        return jsonResponse({ success: true })
      }

      case 'reset_pin': {
        const { user_id } = body.payload || {}
        if (!user_id) return jsonResponse({ error: 'Missing user_id' }, 400)

        const { error } = await adminClient
          .from('profiles')
          .update({ pin_code: null })
          .eq('id', user_id)
        if (error) return jsonResponse({ error: error.message }, 400)

        await adminClient.from('audit_logs').insert({
          actor_id: caller.id,
          action: 'pin_reset',
          target_type: 'user',
          target_id: user_id,
        })

        return jsonResponse({ success: true })
      }

      case 'update_profile': {
        const { user_id, updates } = body.payload || {}
        if (!user_id || !updates) return jsonResponse({ error: 'Missing user_id or updates' }, 400)

        const allowed = [
          'role',
          'full_name',
          'home_location_id',
          'can_float',
          'can_approve_compliance',
          'is_active',
          'is_salesperson',
        ]
        const safeUpdates: Record<string, unknown> = {}
        for (const key of allowed) {
          if (key in updates) safeUpdates[key] = updates[key]
        }

        if (Object.keys(safeUpdates).length === 0) {
          return jsonResponse({ error: 'No allowed fields in updates' }, 400)
        }

        if (safeUpdates.home_location_id === '') safeUpdates.home_location_id = null

        const { error } = await adminClient
          .from('profiles')
          .update(safeUpdates)
          .eq('id', user_id)
        if (error) return jsonResponse({ error: error.message }, 400)

        await adminClient.from('audit_logs').insert({
          actor_id: caller.id,
          action: 'profile_updated',
          target_type: 'user',
          target_id: user_id,
          details: safeUpdates,
        })

        return jsonResponse({ success: true })
      }

      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, 400)
    }
  } catch (err) {
    console.error('manage-users error:', err)
    return jsonResponse({ error: err instanceof Error ? err.message : 'Unknown error' }, 500)
  }
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}