import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const SKYBOLT_DOMAIN = '@skybolt.com'

export default function ForgotPassword() {
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const trimmed = username.trim().toLowerCase()
    const email = trimmed.includes('@') ? trimmed : `${trimmed}${SKYBOLT_DOMAIN}`

    // Trigger Supabase password reset email. We don't reveal whether the email
    // exists — always show the same "if account exists, email sent" message.
    // redirectTo is required even though our email template uses TokenHash directly.
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/set-password`,
    })

    // Treat all responses as success (including the "user not found" case).
    // This prevents username enumeration attacks.
    if (resetError) {
      // Still show success to user, but log the error for debugging
      console.error('Reset password error (may be benign):', resetError)
    }

    setSubmitted(true)
    setLoading(false)
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-skynet-dark flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <h1 className="text-5xl font-bold text-white skynet-glow mb-2">SkyNet</h1>
            <p className="text-skynet-accent">Manufacturing Execution System</p>
            <div className="mt-4 flex items-center justify-center gap-2">
              <div className="w-2 h-2 bg-skynet-green rounded-full animate-pulse"></div>
              <span className="text-skynet-green font-mono text-sm">Reset request sent</span>
            </div>
          </div>

          <div className="bg-gray-900 rounded-lg p-6 shadow-xl border border-gray-800 text-center">
            <h2 className="text-xl font-semibold text-white mb-3">Check Your Email</h2>
            <p className="text-gray-400 text-sm mb-6">
              If an account exists for <span className="font-mono text-white">{username}{SKYBOLT_DOMAIN}</span>, you'll receive a password reset email shortly.
            </p>
            <p className="text-gray-500 text-xs mb-6 font-mono">
              &gt; Didn't get the email? Check your spam folder, or contact your SkyNet administrator.
            </p>
            <button
              onClick={() => navigate('/')}
              className="w-full py-3 bg-skynet-accent hover:bg-blue-600 text-white font-semibold rounded transition-colors"
            >
              Back to Login
            </button>
          </div>
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
            <div className="w-2 h-2 bg-amber-500 rounded-full animate-pulse"></div>
            <span className="text-amber-400 font-mono text-sm">Password recovery</span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="bg-gray-900 rounded-lg p-6 shadow-xl border border-gray-800">
          <h2 className="text-xl font-semibold text-white mb-2">Reset Password</h2>
          <p className="text-gray-500 text-sm mb-6">
            Enter your username and we'll send you a password reset link.
          </p>

          {error && (
            <div className="mb-4 p-3 bg-red-900/50 border border-red-700 rounded text-red-300 text-sm">
              {error}
            </div>
          )}

          <div className="mb-6">
            <label className="block text-gray-400 text-sm mb-2">Username</label>
            <div className="flex items-stretch">
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="flex-1 px-4 py-3 bg-gray-800 border border-gray-700 rounded-l text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                placeholder="mbowers"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                required
                autoFocus
              />
              <span className="px-3 py-3 bg-gray-800 border border-l-0 border-gray-700 rounded-r text-gray-500 text-sm font-mono flex items-center">
                @skybolt.com
              </span>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || !username.trim()}
            className="w-full py-3 bg-skynet-accent hover:bg-blue-600 text-white font-semibold rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed mb-3"
          >
            {loading ? 'Sending...' : 'Send Reset Link'}
          </button>

          <button
            type="button"
            onClick={() => navigate('/')}
            className="w-full py-2 text-gray-400 hover:text-white text-sm transition-colors"
          >
            ← Back to Login
          </button>
        </form>
      </div>
    </div>
  )
}
