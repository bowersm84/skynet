import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'

/**
 * ⚠️ CRITICAL TODO: RLS DISABLED ON PROFILES TABLE
 * 
 * For development, Row Level Security has been DISABLED on the profiles table
 * due to 10+ second query timeouts. This MUST be fixed before production.
 * 
 * Current state: ALTER TABLE profiles DISABLE ROW LEVEL SECURITY;
 * Required before production: Re-enable RLS and optimize performance
 * 
 * See: KNOWN_ISSUES.md for details and checklist
 * Date: January 12, 2026
 */

function App() {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Check current session with timeout
    const checkSession = async () => {
      try {
        console.log('🔐 Checking session...')
        const { data: { session }, error } = await supabase.auth.getSession()
        
        if (error) {
          console.error('❌ Session check error:', error)
          setLoading(false)
          return
        }
        
        console.log('✅ Session check complete:', session ? 'Logged in' : 'Not logged in')
        setUser(session?.user ?? null)
        
        if (session?.user) {
          await fetchProfile(session.user.id)
        } else {
          setLoading(false)
        }
      } catch (error) {
        console.error('💥 Session check failed:', error)
        setLoading(false)
      }
    }

    checkSession()

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        console.log('🔄 Auth state changed:', event)
        setUser(session?.user ?? null)
        if (session?.user) {
          await fetchProfile(session.user.id)
        } else {
          setProfile(null)
          setLoading(false)
        }
      }
    )

    return () => subscription.unsubscribe()
  }, [])

  const fetchProfile = async (userId) => {
    try {
      console.log('👤 Fetching profile for:', userId)
      
      // TODO: Remove this timeout once RLS performance is fixed (see KNOWN_ISSUES.md)
      // This 10s timeout is a workaround for RLS performance issues
      // Target: < 500ms query time in production
      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Profile fetch timeout after 10s')), 10000)
      )
      
      // Create the actual query promise
      const query = supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single()
      
      // Race them
      const { data, error } = await Promise.race([query, timeout])

      if (error) {
        console.error('❌ Error fetching profile:', error)
        console.error('Profile error details:', JSON.stringify(error, null, 2))
        
        // Create a minimal profile if fetch fails
        console.log('⚠️ Using minimal profile fallback')
        setProfile({
          id: userId,
          role: 'machinist',
          full_name: 'User',
          email: ''
        })
      } else {
        console.log('✅ Profile fetched:', data?.full_name || data?.email)
        setProfile(data)
      }
    } catch (error) {
      console.error('💥 Unexpected error fetching profile:', error)
      console.error('Error message:', error.message)
      
      // Create a minimal profile on timeout/error
      console.log('⚠️ Using minimal profile fallback after error')
      setProfile({
        id: userId,
        role: 'machinist',
        full_name: 'User',
        email: ''
      })
    } finally {
      console.log('🏁 Profile fetch complete, setting loading to false')
      setLoading(false)
    }
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    setUser(null)
    setProfile(null)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-skynet-dark flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-skynet-accent border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-500 font-mono">Initializing SkyNet...</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return <Login onLogin={setUser} />
  }

  return (
    <div className="min-h-screen bg-skynet-dark">
      <header className="bg-gray-900 border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-white">SkyNet</h1>
              <div className="w-2 h-2 bg-skynet-green rounded-full animate-pulse"></div>
              <span className="text-skynet-green font-mono text-xs">Online</span>
            </div>
            <span className="text-gray-600">|</span>
            <span className="text-gray-400">Dashboard</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-white text-sm">{profile?.full_name || user.email}</p>
              <p className="text-gray-500 text-xs capitalize">{profile?.role || 'User'}</p>
            </div>
            <button
              onClick={handleLogout}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="p-6">
        <Dashboard user={user} profile={profile} />
      </main>

      <footer className="fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 px-6 py-2">
        <p className="text-gray-600 text-xs text-center font-mono">
          "Don't worry, this one just schedules fasteners." - SkyNet MES v0.1
        </p>
      </footer>
    </div>
  )
}

export default App