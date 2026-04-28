import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { UserPlus, RefreshCw, KeyRound, Lock, Power, Edit2, X, Check } from 'lucide-react'

const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'compliance', label: 'Compliance' },
  { value: 'machinist', label: 'Machinist' },
  { value: 'finishing', label: 'Finishing' },
  { value: 'scheduler', label: 'Scheduler' },
  { value: 'customer_service', label: 'Customer Service' },
  { value: 'assembly', label: 'Assembly' },
]

export default function UsersTab({ profile }) {
  const [users, setUsers] = useState([])
  const [locations, setLocations] = useState([])
  const [loading, setLoading] = useState(true)
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [editingUser, setEditingUser] = useState(null)
  const [actionStatus, setActionStatus] = useState(null) // {type: 'success'|'error', message: string}

  useEffect(() => {
    loadUsers()
    loadLocations()
  }, [])

  const loadUsers = async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, username, role, home_location_id, can_float, can_approve_compliance, is_active, pin_code, created_at')
      .order('created_at', { ascending: false })
    if (error) {
      setActionStatus({ type: 'error', message: `Failed to load users: ${error.message}` })
    } else {
      setUsers(data || [])
    }
    setLoading(false)
  }

  const loadLocations = async () => {
    const { data } = await supabase.from('locations').select('id, name').order('name')
    setLocations(data || [])
  }

  // Helper to call the manage-users edge function
  const callManageUsers = async (action, payload) => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      setActionStatus({ type: 'error', message: 'Session expired. Please log in again.' })
      return null
    }

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-users`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action, payload }),
        }
      )
      const result = await response.json()
      if (!response.ok) {
        setActionStatus({ type: 'error', message: result.error || 'Operation failed' })
        return null
      }
      return result
    } catch (err) {
      setActionStatus({ type: 'error', message: err.message })
      return null
    }
  }

  const handleInvite = async (form) => {
    const result = await callManageUsers('invite', form)
    if (result?.success) {
      setActionStatus({ type: 'success', message: `Invitation sent to ${form.email}` })
      setShowInviteModal(false)
      await loadUsers()
    }
  }

  const handleResendInvite = async (email) => {
    if (!confirm(`Resend invitation to ${email}?`)) return
    const result = await callManageUsers('resend_invite', { email })
    if (result?.success) {
      setActionStatus({ type: 'success', message: `Invitation resent to ${email}` })
    }
  }

  const handleResetPassword = async (email) => {
    if (!confirm(`Send password reset email to ${email}?`)) return
    const result = await callManageUsers('reset_password', { email })
    if (result?.success) {
      setActionStatus({ type: 'success', message: `Password reset email sent to ${email}` })
    }
  }

  const handleResetPin = async (user) => {
    if (!confirm(`Reset PIN for ${user.full_name || user.email}? They will be prompted to create a new PIN on next kiosk login.`)) return
    const result = await callManageUsers('reset_pin', { user_id: user.id })
    if (result?.success) {
      setActionStatus({ type: 'success', message: `PIN reset for ${user.full_name || user.email}` })
      await loadUsers()
    }
  }

  const handleToggleActive = async (user) => {
    const newStatus = !user.is_active
    if (!confirm(`${newStatus ? 'Activate' : 'Deactivate'} ${user.full_name || user.email}?`)) return
    const result = await callManageUsers('update_profile', {
      user_id: user.id,
      updates: { is_active: newStatus },
    })
    if (result?.success) {
      setActionStatus({ type: 'success', message: `${user.full_name || user.email} ${newStatus ? 'activated' : 'deactivated'}` })
      await loadUsers()
    }
  }

  const handleSaveEdits = async (updates) => {
    const result = await callManageUsers('update_profile', {
      user_id: editingUser.id,
      updates,
    })
    if (result?.success) {
      setActionStatus({ type: 'success', message: 'User updated' })
      setEditingUser(null)
      await loadUsers()
    }
  }

  const getStatusBadge = (user) => {
    if (!user.is_active) return <span className="px-2 py-0.5 text-xs bg-red-900/40 text-red-300 rounded">Disabled</span>
    if (!user.pin_code) return <span className="px-2 py-0.5 text-xs bg-amber-900/40 text-amber-300 rounded">No PIN</span>
    return <span className="px-2 py-0.5 text-xs bg-green-900/40 text-green-300 rounded">Active</span>
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Users</h2>
          <p className="text-gray-500 text-sm mt-1">Manage SkyNet operator accounts and permissions</p>
        </div>
        <button
          onClick={() => setShowInviteModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white rounded transition-colors"
        >
          <UserPlus size={16} /> Invite User
        </button>
      </div>

      {actionStatus && (
        <div className={`mb-4 p-3 rounded text-sm flex justify-between items-center ${
          actionStatus.type === 'success' ? 'bg-green-900/40 text-green-300 border border-green-800' : 'bg-red-900/40 text-red-300 border border-red-800'
        }`}>
          <span>{actionStatus.message}</span>
          <button onClick={() => setActionStatus(null)}><X size={14} /></button>
        </div>
      )}

      {loading ? (
        <div className="text-center text-gray-500 py-8">Loading users...</div>
      ) : (
        <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-3 text-left">Username</th>
                <th className="px-4 py-3 text-left">Full Name</th>
                <th className="px-4 py-3 text-left">Role</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Permissions</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map(user => (
                <tr key={user.id} className="border-t border-gray-800 hover:bg-gray-800/40">
                  <td className="px-4 py-3 text-white font-mono">{user.username}</td>
                  <td className="px-4 py-3 text-gray-300">{user.full_name || <span className="text-gray-600">—</span>}</td>
                  <td className="px-4 py-3">
                    <span className="text-skynet-accent capitalize">{(user.role || '').replace('_', ' ')}</span>
                  </td>
                  <td className="px-4 py-3">{getStatusBadge(user)}</td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {user.can_approve_compliance && <span className="mr-2">+ Compliance Approver</span>}
                    {user.can_float && <span>+ Floater</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <IconButton title="Edit permissions" onClick={() => setEditingUser(user)}>
                        <Edit2 size={14} />
                      </IconButton>
                      <IconButton title="Resend invite" onClick={() => handleResendInvite(user.email)}>
                        <RefreshCw size={14} />
                      </IconButton>
                      <IconButton title="Reset password" onClick={() => handleResetPassword(user.email)}>
                        <Lock size={14} />
                      </IconButton>
                      <IconButton title="Reset PIN" onClick={() => handleResetPin(user)}>
                        <KeyRound size={14} />
                      </IconButton>
                      <IconButton
                        title={user.is_active ? 'Deactivate' : 'Activate'}
                        onClick={() => handleToggleActive(user)}
                        danger={user.is_active}
                      >
                        <Power size={14} />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No users yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showInviteModal && (
        <InviteUserModal
          locations={locations}
          onSubmit={handleInvite}
          onClose={() => setShowInviteModal(false)}
        />
      )}

      {editingUser && (
        <EditUserModal
          user={editingUser}
          locations={locations}
          onSubmit={handleSaveEdits}
          onClose={() => setEditingUser(null)}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function IconButton({ children, onClick, title, danger }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-2 rounded transition-colors ${
        danger ? 'text-red-400 hover:bg-red-900/30' : 'text-gray-400 hover:bg-gray-700 hover:text-white'
      }`}
    >
      {children}
    </button>
  )
}

function InviteUserModal({ locations, onSubmit, onClose }) {
  const [form, setForm] = useState({
    email: '',
    full_name: '',
    role: 'machinist',
    home_location_id: locations[0]?.id || '',
    can_float: false,
    can_approve_compliance: false,
  })
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    // Auto-append @skybolt.com if user typed just the username portion
    const email = form.email.includes('@') ? form.email : `${form.email}@skybolt.com`
    await onSubmit({ ...form, email })
    setSubmitting(false)
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-lg">
        <div className="flex justify-between items-center p-5 border-b border-gray-800">
          <h3 className="text-lg font-semibold text-white">Invite New User</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white"><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Username (email local-part)</label>
            <div className="flex">
              <input
                type="text"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-l text-white focus:outline-none focus:border-skynet-accent"
                placeholder="rsmith"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                required
              />
              <span className="px-3 py-2 bg-gray-800 border border-l-0 border-gray-700 rounded-r text-gray-500 text-sm font-mono flex items-center">
                @skybolt.com
              </span>
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Full Name</label>
            <input
              type="text"
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
              placeholder="Roger Smith"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Role</label>
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
              >
                {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Home Location</label>
              <select
                value={form.home_location_id}
                onChange={(e) => setForm({ ...form, home_location_id: e.target.value })}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
              >
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input
                type="checkbox"
                checked={form.can_float}
                onChange={(e) => setForm({ ...form, can_float: e.target.checked })}
                className="rounded"
              />
              Can float between locations
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input
                type="checkbox"
                checked={form.can_approve_compliance}
                onChange={(e) => setForm({ ...form, can_approve_compliance: e.target.checked })}
                className="rounded"
              />
              Can approve compliance (backup approver)
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-gray-800">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white">
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white rounded disabled:opacity-50"
            >
              {submitting ? 'Sending invite...' : 'Send Invite'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function EditUserModal({ user, locations, onSubmit, onClose }) {
  const [form, setForm] = useState({
    full_name: user.full_name || '',
    role: user.role,
    home_location_id: user.home_location_id || '',
    can_float: user.can_float || false,
    can_approve_compliance: user.can_approve_compliance || false,
  })
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    await onSubmit(form)
    setSubmitting(false)
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-lg">
        <div className="flex justify-between items-center p-5 border-b border-gray-800">
          <h3 className="text-lg font-semibold text-white">Edit {user.username}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white"><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Email (read-only)</label>
            <input
              type="text"
              value={user.email}
              readOnly
              className="w-full px-3 py-2 bg-gray-800/50 border border-gray-700 rounded text-gray-500 cursor-not-allowed"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Full Name</label>
            <input
              type="text"
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Role</label>
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
              >
                {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Home Location</label>
              <select
                value={form.home_location_id || ''}
                onChange={(e) => setForm({ ...form, home_location_id: e.target.value || null })}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
              >
                <option value="">— None —</option>
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input
                type="checkbox"
                checked={form.can_float}
                onChange={(e) => setForm({ ...form, can_float: e.target.checked })}
              />
              Can float between locations
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input
                type="checkbox"
                checked={form.can_approve_compliance}
                onChange={(e) => setForm({ ...form, can_approve_compliance: e.target.checked })}
              />
              Can approve compliance (backup approver)
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-gray-800">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white">
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white rounded disabled:opacity-50"
            >
              {submitting ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
