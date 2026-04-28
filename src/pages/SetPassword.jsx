import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const PIN_REQUIRED_ROLES = ['machinist', 'admin', 'finishing']

export default function SetPassword() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [sessionReady, setSessionReady] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [userRole, setUserRole] = useState(null)
  const [needsPin, setNeedsPin] = useState(false)

  useEffect(() => {
    let subscription = null

    const markReady = async (session) => {
      setUserEmail(session.user.email || '')

      // Look up the role to decide whether we need a PIN
      const { data: profile } = await supabase
        .from('profiles')
        .select('role, pin_code')
        .eq('id', session.user.id)
        .single()

      if (profile) {
        setUserRole(profile.role)
        // Show PIN fields only if role requires it AND pin_code is currently null
        // (avoids forcing a PIN reset during a password reset)
        setNeedsPin(PIN_REQUIRED_ROLES.includes(profile.role) && !profile.pin_code)
      }

      setSessionReady(true)
    }

    const init = async () => {
      const hash = window.location.hash || ''
      if (hash.includes('error=') || hash.includes('error_code=')) {
        const params = new URLSearchParams(hash.replace(/^#/, ''))
        const desc = params.get('error_description') || params.get('error') || 'Invitation link is invalid or has expired'
        setError(decodeURIComponent(desc.replace(/\+/g, ' ')) + '. Contact your SkyNet administrator for a new invitation.')
        return
      }

      const search = window.location.search || ''
      const params = new URLSearchParams(search)
      const code = params.get('code')

      if (code) {
        const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
        if (exchangeError) {
          setError(`Could not validate invitation: ${exchangeError.message}. Contact your SkyNet administrator for a new invitation.`)
          return
        }
        if (data.session) {
          window.history.replaceState({}, '', '/set-password')
          await markReady(data.session)
          return
        }
      }

      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        await markReady(session)
        return
      }

      setError('This invitation link is invalid or has expired. Contact your SkyNet administrator for a new invitation.')
    }
    init()

    return () => {
      if (subscription) subscription.unsubscribe()
    }
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)

    // Password validation
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    // PIN validation (only if role requires PIN)
    if (needsPin) {
      if (!/^\d{4}$/.test(pin)) {
        setError('PIN must be exactly 4 digits.')
        return
      }
      if (pin !== confirmPin) {
        setError('PINs do not match.')
        return
      }
    }

    setLoading(true)

    // Update password first
    const { error: updateError } = await supabase.auth.updateUser({ password })
    if (updateError) {
      setError(updateError.message)
      setLoading(false)
      return
    }

    // Save PIN if collected
    if (needsPin) {
      const { data: { session } } = await supabase.auth.getSession()
      const { error: pinError } = await supabase
        .from('profiles')
        .update({ pin_code: pin })
        .eq('id', session.user.id)

      if (pinError) {
        // Most likely cause: PIN already in use by another operator (uniqueness constraint)
        if (pinError.code === '23505' || /unique|duplicate/i.test(pinError.message)) {
          setError('That PIN is already in use by another operator. Please choose a different 4-digit PIN.')
        } else {
          setError(`Could not save PIN: ${pinError.message}`)
        }
        setLoading(false)
        return
      }
    }

    navigate('/', { replace: true })
  }

  if (!sessionReady && !error) {
    return (
      <div className="min-h-screen bg-skynet-dark flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-skynet-accent border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-500 font-mono">Validating invitation...</p>
        </div>
      </div>
    )
  }

  if (error && !sessionReady) {
    return (
      <div className="min-h-screen bg-skynet-dark flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md text-center">
          <h1 className="text-3xl font-bold text-white mb-4">Invitation Invalid</h1>
          <div className="bg-red-900/50 border border-red-700 rounded p-4 text-red-300 text-sm mb-6">
            {error}
          </div>
          <button
            onClick={() => navigate('/')}
            className="px-6 py-3 bg-skynet-accent hover:bg-blue-600 text-white font-semibold rounded transition-colors"
          >
            Back to Login
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-skynet-dark flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-5xl font-bold text-white skynet-glow mb-2">SkyNet</h1>
          <p className="text-skynet-accent">Manufacturing Execution System</p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <div className="w-2 h-2 bg-skynet-green rounded-full animate-pulse"></div>
            <span className="text-skynet-green font-mono text-sm">Initializing operator profile</span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="bg-gray-900 rounded-lg p-6 shadow-xl border border-gray-800">
          <h2 className="text-xl font-semibold text-white mb-2">Set Your Password</h2>
          <p className="text-gray-500 text-sm mb-6 font-mono">
            {userEmail && `> ${userEmail.split('@')[0]}`}
            {userRole && <span className="ml-2 text-gray-600">[{userRole}]</span>}
          </p>

          {error && (
            <div className="mb-4 p-3 bg-red-900/50 border border-red-700 rounded text-red-300 text-sm">
              {error}
            </div>
          )}

          <div className="mb-4">
            <label className="block text-gray-400 text-sm mb-2">New Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
              placeholder="At least 8 characters"
              autoComplete="new-password"
              required
              minLength={8}
            />
          </div>

          <div className={needsPin ? 'mb-4' : 'mb-6'}>
            <label className="block text-gray-400 text-sm mb-2">Confirm Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
              placeholder="Re-enter password"
              autoComplete="new-password"
              required
            />
          </div>

          {needsPin && (
            <>
              <div className="mt-6 mb-4 pb-2 border-b border-gray-800">
                <h3 className="text-sm text-skynet-accent font-mono uppercase tracking-wider">Kiosk PIN</h3>
                <p className="text-gray-500 text-xs mt-1">
                  Used to log into shop floor kiosks. Choose 4 digits you'll remember.
                </p>
              </div>

              <div className="mb-4">
                <label className="block text-gray-400 text-sm mb-2">4-Digit PIN</label>
                <input
                  type="password"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent text-center text-2xl tracking-[0.5em] font-mono"
                  placeholder="••••"
                  inputMode="numeric"
                  pattern="\d{4}"
                  maxLength={4}
                  required
                />
              </div>

              <div className="mb-6">
                <label className="block text-gray-400 text-sm mb-2">Confirm PIN</label>
                <input
                  type="password"
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent text-center text-2xl tracking-[0.5em] font-mono"
                  placeholder="••••"
                  inputMode="numeric"
                  pattern="\d{4}"
                  maxLength={4}
                  required
                />
              </div>
            </>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-skynet-accent hover:bg-blue-600 text-white font-semibold rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Setting up account...' : 'Initialize Access →'}
          </button>
        </form>
      </div>
    </div>
  )
}
