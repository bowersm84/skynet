import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { X } from 'lucide-react'

export default function ChangePinModal({ profile, onClose, onSuccess }) {
  const [currentPin, setCurrentPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  // D-ASM-43: the PIN itself is never readable; has_pin says whether one is on file.
  const isCreating = !profile?.has_pin  // No PIN on file => "Create" mode

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)

    // Every kiosk PIN pad takes 4 digits, so the office form does too.
    if (!/^\d{4}$/.test(newPin)) {
      setError('PIN must be exactly 4 digits.')
      return
    }
    if (newPin !== confirmPin) {
      setError('New PINs do not match.')
      return
    }
    if (!isCreating && !/^\d{4}$/.test(currentPin)) {
      setError('Current PIN must be 4 digits.')
      return
    }

    setSubmitting(true)

    // The vault checks the current PIN, "same as now" and "in use" on the
    // server. A refusal is a result ({ ok: false, message }), not an error.
    const { data, error: rpcError } = await supabase.rpc('profile_pin_set', {
      p_new_pin: newPin,
      p_current_pin: isCreating ? null : currentPin,
    })

    setSubmitting(false)
    if (rpcError) {
      setError(`Could not update PIN: ${rpcError.message}`)
      return
    }
    if (!data?.ok) {
      setError(data?.message || 'Could not update PIN.')
      return
    }

    if (onSuccess) onSuccess()
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-sm">
        <div className="flex justify-between items-center p-5 border-b border-gray-800">
          <h3 className="text-lg font-semibold text-white">
            {isCreating ? 'Create Kiosk PIN' : 'Change Kiosk PIN'}
          </h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white"><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className="p-3 bg-red-900/50 border border-red-700 rounded text-red-300 text-sm">
              {error}
            </div>
          )}

          {!isCreating && (
            <div>
              <label className="block text-sm text-gray-400 mb-2">Current PIN</label>
              <input
                type="password"
                value={currentPin}
                onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                className="w-full px-3 py-3 bg-gray-800 border border-gray-700 rounded text-white text-center text-2xl tracking-[0.5em] font-mono focus:outline-none focus:border-skynet-accent"
                placeholder="••••"
                inputMode="numeric"
                pattern="\d{4}"
                maxLength={4}
                required
                autoFocus
              />
            </div>
          )}

          <div>
            <label className="block text-sm text-gray-400 mb-2">
              {isCreating ? '4-Digit PIN' : 'New PIN'}
            </label>
            <input
              type="password"
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              className="w-full px-3 py-3 bg-gray-800 border border-gray-700 rounded text-white text-center text-2xl tracking-[0.5em] font-mono focus:outline-none focus:border-skynet-accent"
              placeholder="••••"
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              required
              autoFocus={isCreating}
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2">Confirm New PIN</label>
            <input
              type="password"
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              className="w-full px-3 py-3 bg-gray-800 border border-gray-700 rounded text-white text-center text-2xl tracking-[0.5em] font-mono focus:outline-none focus:border-skynet-accent"
              placeholder="••••"
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              required
            />
          </div>

          <p className="text-gray-600 text-xs font-mono">
            &gt; Used to log into shop floor kiosks. Keep it private.
          </p>

          <div className="flex justify-end gap-2 pt-3 border-t border-gray-800">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white">
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white rounded disabled:opacity-50"
            >
              {submitting ? 'Saving...' : (isCreating ? 'Create PIN' : 'Update PIN')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
