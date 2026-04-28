import { useState, useEffect } from 'react'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const REDIRECT_AFTER_VERIFY = `${window.location.origin}/set-password`

export default function ConfirmInvite() {
  const [token, setToken] = useState(null)
  const [type, setType] = useState('invite')
  const [error, setError] = useState(null)

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

  const handleContinue = () => {
    if (!token) return
    const verifyUrl = `${SUPABASE_URL}/auth/v1/verify?token=${encodeURIComponent(token)}&type=${encodeURIComponent(type)}&redirect_to=${encodeURIComponent(REDIRECT_AFTER_VERIFY)}`
    // Use a real navigation (not fetch) so Supabase can do its 302 redirect to /set-password
    window.location.href = verifyUrl
  }

  if (error) {
    return (
      <div className="min-h-screen bg-skynet-dark flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md text-center">
          <h1 className="text-3xl font-bold text-white mb-4">Invitation Invalid</h1>
          <div className="bg-red-900/50 border border-red-700 rounded p-4 text-red-300 text-sm mb-6">
            {error}
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
            className="w-full py-3 bg-skynet-accent hover:bg-blue-600 text-white font-semibold rounded transition-colors"
          >
            Continue →
          </button>

          <p className="text-gray-600 text-xs mt-6 font-mono">
            &gt; This extra step protects your invitation from being consumed by automated email scanners.
          </p>
        </div>
      </div>
    </div>
  )
}
