-- 1. Force-change flag
alter table public.profiles
  add column if not exists must_change_password boolean not null default false;

-- 2. Username -> email lookup for the login form. Returns null if no
--    active match. SECURITY DEFINER so anon callers can resolve a username
--    without exposing the profiles table.
create or replace function public.get_email_by_username(p_username text)
returns text
language sql
security definer
set search_path = public
as $$
  select email
  from public.profiles
  where lower(username) = lower(p_username)
    and is_active = true
  order by created_at desc
  limit 1;
$$;
revoke all on function public.get_email_by_username(text) from public;
grant execute on function public.get_email_by_username(text) to anon, authenticated;

-- 3. Lets the currently-authenticated user clear their own flag after
--    completing a forced password change.
create or replace function public.clear_my_must_change_password()
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
  set must_change_password = false
  where id = auth.uid();
$$;
revoke all on function public.clear_my_must_change_password() from public;
grant execute on function public.clear_my_must_change_password() to authenticated;

-- 4. Sanity check
select column_name, data_type, column_default
  from information_schema.columns
  where table_schema='public'
    and table_name='profiles'
    and column_name='must_change_password';
select proname from pg_proc
  where proname in ('get_email_by_username','clear_my_must_change_password');

-- 5. Edge Funtion Changes
// SkyNet — Edge Function: manage-users
// Server-side admin user management. Uses service role key (never exposed to browser).
// Validates that the caller is an admin via their JWT before performing any action.

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
}

interface InviteNoEmailPayload {
  username: string
  full_name: string
  role: string
  home_location_id?: string | null
  can_float?: boolean
  can_approve_compliance?: boolean
  temp_password: string
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Validate the calling user is authenticated and is an admin
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return jsonResponse({ error: 'Missing Authorization header' }, 401)
    }

    // Use the anon-key client to identify the caller
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user: caller }, error: callerError } = await callerClient.auth.getUser()
    if (callerError || !caller) {
      return jsonResponse({ error: 'Invalid auth token' }, 401)
    }

    // Look up the caller's profile to verify admin role
    const { data: callerProfile, error: profileError } = await callerClient
      .from('profiles')
      .select('role, is_active')
      .eq('id', caller.id)
      .single()

    if (profileError || !callerProfile || callerProfile.role !== 'admin' || !callerProfile.is_active) {
      return jsonResponse({ error: 'Forbidden: admin access required' }, 403)
    }

    // 2. Use the service role client for admin operations
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 3. Route on action
    const body = await req.json()
    const { action } = body

    switch (action) {
      case 'invite': {
        const payload = body.payload as InviteUserPayload
        if (!payload?.email || !payload?.full_name || !payload?.role) {
          return jsonResponse({ error: 'Missing required fields: email, full_name, role' }, 400)
        }

        // Send invite with metadata that the welcome email template can render
        const { data, error } = await adminClient.auth.admin.inviteUserByEmail(payload.email, {
          data: {
            full_name: payload.full_name,
            role: payload.role,
            username: payload.email.split('@')[0],
            location: 'Leesburg', // populated by frontend; harmless default
            home_location_id: payload.home_location_id ?? null,
            can_float: payload.can_float ?? false,
            can_approve_compliance: payload.can_approve_compliance ?? false,
          },
        })

        if (error) {
          return jsonResponse({ error: error.message }, 400)
        }

        // Audit log
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

        // Reject duplicate username (case-insensitive) or email
        const { data: clash } = await adminClient
          .from('profiles')
          .select('id, username, email')
          .or(`username.ilike.${username},email.ilike.${placeholderEmail}`)
          .limit(1)
        if (clash && clash.length > 0) {
          return jsonResponse({ error: 'Username or placeholder email already in use.' }, 400)
        }

        const homeLocationId = payload.home_location_id || null

        // Create the auth user. The handle_new_user trigger will insert the
        // profiles row using user_metadata. email_confirm: true skips the
        // verification email entirely.
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
          },
        })

        if (createErr || !created?.user) {
          return jsonResponse({ error: createErr?.message || 'Failed to create auth user' }, 400)
        }

        // The trigger doesn't know about must_change_password — patch it on
        // (and re-assert the role/location/permission fields in case the
        // trigger missed any of them).
        const { error: patchErr } = await adminClient
          .from('profiles')
          .update({
            role: payload.role,
            full_name: payload.full_name,
            home_location_id: homeLocationId,
            can_float: payload.can_float ?? false,
            can_approve_compliance: payload.can_approve_compliance ?? false,
            is_active: true,
            must_change_password: true,
          })
          .eq('id', created.user.id)

        if (patchErr) {
          // Roll back the auth user so we don't leave a dangling account
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

        // generateLink only generates — to actually send the email, use the public method
        // The public method respects email templates and sends through SES.
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

        // Whitelist allowed fields (don't let admin tamper with id, email, created_at,
        // or must_change_password — that flag flips via invite_no_email/set_password
        // and clears via the user-facing clear_my_must_change_password RPC).
        const allowed = ['role', 'full_name', 'home_location_id', 'can_float', 'can_approve_compliance', 'is_active']
        const safeUpdates: Record<string, unknown> = {}
        for (const key of allowed) {
          if (key in updates) safeUpdates[key] = updates[key]
        }

        if (Object.keys(safeUpdates).length === 0) {
          return jsonResponse({ error: 'No allowed fields in updates' }, 400)
        }

        // Postgres rejects '' for uuid columns. Coerce empty strings to null.
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