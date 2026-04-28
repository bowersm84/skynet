import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function SetPassword() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [sessionReady, setSessionReady] = useState(false)
  const [userEmail, setUserEmail] = useState('')

  // Mount: handle PKCE code exchange or detect existing session.
  // PKCE flow URL: https://skynet.skybolt.com/set-password?code=abc123
  // We exchange the code for a session, then show the password form.
  useEffect(() => {
    let subscription = null

    const markReady = (session) => {
      setUserEmail(session.user.email || '')
      setSessionReady(true)
    }

    const init = async () => {
      // First, check the URL for an auth error (e.g. otp_expired) in the hash
      const hash = window.location.hash || ''
      if (hash.includes('error=') || hash.includes('error_code=')) {
        const params = new URLSearchParams(hash.replace(/^#/, ''))
        const desc = params.get('error_description') || params.get('error') || 'Invitation link is invalid or has expired'
        setError(decodeURIComponent(desc.replace(/\+/g, ' ')) + '. Contact your SkyNet administrator for a new invitation.')
        return
      }

      // Check the URL for a PKCE code to exchange
      const search = window.location.search || ''
      const params = new URLSearchParams(search)
      const code = params.get('code')

      if (code) {
        // Exchange the code for a session. The code-verifier is in localStorage from the original sign-in attempt.
        const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
        if (exchangeError) {
          setError(`Could not validate invitation: ${exchangeError.message}. Contact your SkyNet administrator for a new invitation.`)
          return
        }
        if (data.session) {
          // Clean the code from the URL so refreshing doesn't re-attempt the exchange
          window.history.replaceState({}, '', '/set-password')
          markReady(data.session)
          return
        }
      }

      // No code in URL — check for existing session (user already exchanged in a previous tab)
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        markReady(session)
        return
      }

      // No code, no session — link is missing or already used
      setError('This invitation link is invalid or has expired. Contact your SkyNet administrator for a new invitation.')
    }
    init()

    return () => {
      if (subscription) subscription.unsubscribe()
    }
  }, [])

  const handleSetPassword = async (e) => {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })

    if (updateError) {
      setError(updateError.message)
      setLoading(false)
      return
    }

    // Password set — redirect to root, App.jsx will see the session and load Mainframe
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

        <form onSubmit={handleSetPassword} className="bg-gray-900 rounded-lg p-6 shadow-xl border border-gray-800">
          <h2 className="text-xl font-semibold text-white mb-2">Set Your Password</h2>
          <p className="text-gray-500 text-sm mb-6 font-mono">
            {userEmail && `> ${userEmail.split('@')[0]}`}
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

          <div className="mb-6">
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

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-skynet-accent hover:bg-blue-600 text-white font-semibold rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Setting password...' : 'Initialize Access →'}
          </button>
        </form>
      </div>
    </div>
  )
}
