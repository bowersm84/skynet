import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function ConfirmInvite() {
  const navigate = useNavigate()
  const [token, setToken] = useState(null)
  const [type, setType] = useState('invite')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const t = params.get('token')
    const ty = params.get('type') || 'invite'
    if (!t) {
      setError('This link is missing a verification token. Contact your SkyNet administrator for a new invitation.')
      return
    }
    setToken(t)
    setType(ty)
  }, [])

  const handleContinue = async () => {
    if (!token) return
    setLoading(true)
    setError(null)

    // POST-based token verification. Scanners pre-fetch GETs but don't trigger POSTs.
    // verifyOtp posts to /auth/v1/verify with the token in the request body, returns a session.
    const { data, error: verifyError } = await supabase.auth.verifyOtp({
      token_hash: token,
      type: type,
    })

    if (verifyError) {
      setError(`Could not validate invitation: ${verifyError.message}. Contact your SkyNet administrator for a new invitation.`)
      setLoading(false)
      return
    }

    if (data?.session) {
      // Session established. Route to set-password to capture the new password.
      navigate('/set-password', { replace: true })
      return
    }

    setError('Verification did not return a session. Contact your SkyNet administrator for a new invitation.')
    setLoading(false)
  }

  if (error) {
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
            <span className="text-skynet-green font-mono text-sm">
              {type === 'recovery' ? 'Password reset ready' : 'Operator profile ready'}
            </span>
          </div>
        </div>

        <div className="bg-gray-900 rounded-lg p-6 shadow-xl border border-gray-800 text-center">
          <h2 className="text-xl font-semibold text-white mb-3">
            {type === 'recovery' ? 'Reset Your Password' : 'Activate Your Account'}
          </h2>
          <p className="text-gray-400 text-sm mb-6">
            {type === 'recovery'
              ? 'Click the button below to continue with your password reset.'
              : 'Click the button below to set your password and access SkyNet.'}
          </p>

          <button
            onClick={handleContinue}
            disabled={loading || !token}
            className="w-full py-3 bg-skynet-accent hover:bg-blue-600 text-white font-semibold rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Verifying...' : 'Continue →'}
          </button>

          <p className="text-gray-600 text-xs mt-6 font-mono">
            &gt; This extra step protects your invitation from being consumed by automated email scanners.
          </p>
        </div>
      </div>
    </div>
  )
}
