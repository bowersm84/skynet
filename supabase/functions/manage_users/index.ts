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
  roles?: string[]
  home_location_id?: string | null
  can_float?: boolean
  can_approve_compliance?: boolean
  is_salesperson?: boolean
}

interface InviteNoEmailPayload {
  username: string
  full_name: string
  role: string
  roles?: string[]
  home_location_id?: string | null
  can_float?: boolean
  can_approve_compliance?: boolean
  is_salesperson?: boolean
  temp_password: string
}

// Kiosk-only account (D-ASM-46): no email, no office login — a placeholder
// address, a server-generated password nobody holds, and a temporary PIN the
// tablet makes them replace at first sign-in.
interface InviteKioskOnlyPayload {
  username: string
  full_name: string
  temp_pin: string
  role?: string
  roles?: string[]
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
            roles: payload.roles ?? [],
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

        // handle_new_user creates every new profile as an inactive viewer and
        // takes nothing that grants access from the sign-up data (D-ASM-51), so
        // this patch sets the role, the flags and is_active itself. The trigger
        // creates the row synchronously; the patch confirms it found it.
        let warning: string | null = null
        if (data.user?.id) {
          const { data: patched, error: patchErr } = await adminClient
            .from('profiles')
            .update({
              role: payload.role,
              roles: payload.roles ?? [],
              full_name: payload.full_name,
              home_location_id: payload.home_location_id ?? null,
              can_float: payload.can_float ?? false,
              can_approve_compliance: payload.can_approve_compliance ?? false,
              is_salesperson: payload.is_salesperson ?? false,
              is_active: true,
            })
            .eq('id', data.user.id)
            .select('id')
          if (patchErr || !patched || patched.length !== 1) {
            console.error('Profile patch after invite failed:', patchErr ?? 'no profile row')
            // Non-fatal: the invite was sent. The person is left as an inactive
            // viewer until an admin finishes the profile in the Users tab.
            warning = `Invitation sent, but ${payload.full_name}'s profile could not be set up` +
              (patchErr ? ` (${patchErr.message})` : ' (no profile row was found)') +
              '. They are an inactive viewer until you set their role (Edit) and activate them (Activate) in the Users tab.'
          }
        }

        const { error: auditErr } = await adminClient.from('audit_logs').insert({
          operator_id: caller.id,
          event_type: 'user_invited',
          details: {
            email: payload.email,
            role: payload.role,
            full_name: payload.full_name,
            target_type: 'user',
            target_id: data.user?.id ?? null,
          },
        })
        if (auditErr) console.error('audit_logs insert failed:', auditErr)

        return jsonResponse({ success: true, user: data.user, ...(warning ? { warning } : {}) })
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
            roles: payload.roles ?? [],
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

        // Sets everything that grants access itself (D-ASM-51): the trigger only
        // provides the row, as an inactive viewer. No row found is a failure too.
        const { data: patched, error: patchErr } = await adminClient
          .from('profiles')
          .update({
            role: payload.role,
            roles: payload.roles ?? [],
            full_name: payload.full_name,
            home_location_id: homeLocationId,
            can_float: payload.can_float ?? false,
            can_approve_compliance: payload.can_approve_compliance ?? false,
            is_salesperson: payload.is_salesperson ?? false,
            is_active: true,
            must_change_password: true,
          })
          .eq('id', created.user.id)
          .select('id')

        if (patchErr || !patched || patched.length !== 1) {
          await adminClient.auth.admin.deleteUser(created.user.id)
          return jsonResponse({ error: `Profile setup failed: ${patchErr?.message ?? 'no profile row was created'}` }, 500)
        }

        const { error: auditErr } = await adminClient.from('audit_logs').insert({
          operator_id: caller.id,
          event_type: 'user_invited_no_email',
          details: {
            username,
            role: payload.role,
            full_name: payload.full_name,
            target_type: 'user',
            target_id: created.user.id,
          },
        })
        if (auditErr) console.error('audit_logs insert failed:', auditErr)

        return jsonResponse({ success: true, user_id: created.user.id })
      }

      case 'invite_kiosk_only': {
        const payload = body.payload as InviteKioskOnlyPayload
        if (!payload?.username || !payload?.full_name || !payload?.temp_pin) {
          return jsonResponse({ error: 'Missing required fields: username, full_name, temp_pin' }, 400)
        }

        const username = payload.username.trim().toLowerCase()
        if (!USERNAME_RE.test(username)) {
          return jsonResponse({ error: 'Invalid username. Use 2-40 letters, digits, dot, underscore, or hyphen.' }, 400)
        }
        const role = payload.role || 'assembly'
        const roles = (payload.roles ?? []).filter((r) => r && r !== role)
        const tempPin = String(payload.temp_pin).trim()

        const placeholderEmail = `${username}${PLACEHOLDER_DOMAIN}`

        const { data: clash } = await adminClient
          .from('profiles')
          .select('id, username, email')
          .or(`username.ilike.${username},email.ilike.${placeholderEmail}`)
          .limit(1)
        if (clash && clash.length > 0) {
          return jsonResponse({ error: 'Username or placeholder email already in use.' }, 400)
        }

        // Nobody is told this password and it is never returned or logged:
        // the account has no office login, only the kiosk PIN.
        const password = crypto.randomUUID() + crypto.randomUUID()

        const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
          email: placeholderEmail,
          password,
          email_confirm: true,
          user_metadata: {
            username,
            full_name: payload.full_name,
            role,
            roles,
            location: 'Leesburg',
            kiosk_only: true,
          },
        })

        if (createErr || !created?.user) {
          return jsonResponse({ error: createErr?.message || 'Failed to create auth user' }, 400)
        }

        // Sets everything that grants access itself (D-ASM-51): the trigger only
        // provides the row, as an inactive viewer. No row found is a failure too.
        // profiles.username is generated from the email prefix, so it is not written here.
        const { data: patched, error: patchErr } = await adminClient
          .from('profiles')
          .update({
            role,
            roles,
            full_name: payload.full_name,
            home_location_id: null,
            can_float: false,
            can_approve_compliance: false,
            is_salesperson: false,
            is_active: true,
            kiosk_only: true,
            must_change_password: false,
          })
          .eq('id', created.user.id)
          .select('id')

        if (patchErr || !patched || patched.length !== 1) {
          await adminClient.auth.admin.deleteUser(created.user.id)
          return jsonResponse({ error: `Profile setup failed: ${patchErr?.message ?? 'no profile row was created'}` }, 500)
        }

        const { error: pinErr } = await adminClient.rpc('profile_pin_admin_set', {
          p_profile_id: created.user.id,
          p_temp_pin: tempPin,
        })
        if (pinErr) {
          await adminClient.auth.admin.deleteUser(created.user.id)
          return jsonResponse({ error: pinErr.message }, 400)
        }

        const { error: auditErr } = await adminClient.from('audit_logs').insert({
          operator_id: caller.id,
          event_type: 'user_invited_kiosk_only',
          details: {
            username,
            role,
            full_name: payload.full_name,
            target_type: 'user',
            target_id: created.user.id,
          },
        })
        if (auditErr) console.error('audit_logs insert failed:', auditErr)

        return jsonResponse({ success: true, user_id: created.user.id })
      }

      case 'resend_invite': {
        const { email } = body.payload || {}
        if (!email) return jsonResponse({ error: 'Missing email' }, 400)

        const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email)
        if (error) return jsonResponse({ error: error.message }, 400)

        const { error: auditErr } = await adminClient.from('audit_logs').insert({
          operator_id: caller.id,
          event_type: 'invite_resent',
          details: {
            email,
            target_type: 'user',
            target_id: data.user?.id ?? null,
          },
        })
        if (auditErr) console.error('audit_logs insert failed:', auditErr)

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

        const { error: auditErr } = await adminClient.from('audit_logs').insert({
          operator_id: caller.id,
          event_type: 'password_reset_sent',
          details: {
            email,
            target_type: 'user',
          },
        })
        if (auditErr) console.error('audit_logs insert failed:', auditErr)

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

        const { error: auditErr } = await adminClient.from('audit_logs').insert({
          operator_id: caller.id,
          event_type: 'password_set_by_admin',
          details: {
            target_type: 'user',
            target_id: user_id,
          },
        })
        if (auditErr) console.error('audit_logs insert failed:', auditErr)

        return jsonResponse({ success: true })
      }

      case 'reset_pin': {
        const { user_id } = body.payload || {}
        if (!user_id) return jsonResponse({ error: 'Missing user_id' }, 400)

        // The PIN vault (D-ASM-43): no direct write to a PIN column.
        const { error } = await adminClient.rpc('profile_pin_clear', { p_profile_id: user_id })
        if (error) return jsonResponse({ error: error.message }, 400)

        const { error: auditErr } = await adminClient.from('audit_logs').insert({
          operator_id: caller.id,
          event_type: 'pin_reset',
          details: {
            target_type: 'user',
            target_id: user_id,
          },
        })
        if (auditErr) console.error('audit_logs insert failed:', auditErr)

        return jsonResponse({ success: true })
      }

      case 'set_temp_pin': {
        const { user_id, temp_pin } = body.payload || {}
        if (!user_id || !temp_pin) return jsonResponse({ error: 'Missing user_id or temp_pin' }, 400)

        // Raises "A PIN is 4 to 6 digits" or "Choose a different temporary PIN"
        // — passed through for the admin to read.
        const { error } = await adminClient.rpc('profile_pin_admin_set', {
          p_profile_id: user_id,
          p_temp_pin: String(temp_pin).trim(),
        })
        if (error) return jsonResponse({ error: error.message }, 400)

        const { error: auditErr } = await adminClient.from('audit_logs').insert({
          operator_id: caller.id,
          event_type: 'temp_pin_set',
          details: {
            target_type: 'user',
            target_id: user_id,
          },
        })
        if (auditErr) console.error('audit_logs insert failed:', auditErr)

        return jsonResponse({ success: true })
      }

      case 'update_profile': {
        const { user_id, updates } = body.payload || {}
        if (!user_id || !updates) return jsonResponse({ error: 'Missing user_id or updates' }, 400)

        const allowed = [
          'role',
          'roles',
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

        const { error: auditErr } = await adminClient.from('audit_logs').insert({
          operator_id: caller.id,
          event_type: 'profile_updated',
          details: {
            ...safeUpdates,
            target_type: 'user',
            target_id: user_id,
          },
        })
        if (auditErr) console.error('audit_logs insert failed:', auditErr)

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