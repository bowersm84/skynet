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

  // On mount, Supabase auto-handles the magic link in the URL hash and creates a session.
  // We just need to detect when the session is ready.
  useEffect(() => {
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        setSessionReady(true)
        setUserEmail(session.user.email || '')
      } else {
        // No session yet — listen for the auth state change that fires when the magic link is processed
        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
          if (event === 'SIGNED_IN' && session) {
            setSessionReady(true)
            setUserEmail(session.user.email || '')
          }
        })
        return () => subscription.unsubscribe()
      }
    }
    checkSession()

    // Show error if no session arrives within 5 seconds (broken/expired link)
    const timeout = setTimeout(() => {
      if (!sessionReady) {
        setError('This invitation link is invalid or has expired. Contact your SkyNet administrator for a new one.')
      }
    }, 5000)
    return () => clearTimeout(timeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
