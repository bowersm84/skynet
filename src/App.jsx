import { useState, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { Calendar, LayoutDashboard, Database, Monitor, ChevronDown } from 'lucide-react'
import Login from './pages/Login'
import SetPassword from './pages/SetPassword'
import Mainframe from './pages/Mainframe'
import Schedule from './pages/Schedule'
import Kiosk from './pages/Kiosk'
import Finishing from './pages/Finishing'
import Armory from './pages/Armory'
import AssemblyDisplay from './pages/dashboards/AssemblyDisplay'
import PrintTraveler from './components/PrintTraveler'
import LoadingScreen from './components/LoadingScreen'

const DASHBOARDS = [
  { label: 'Assembly Dashboard', path: '/dashboards/assembly' },
]

// Main authenticated app component
function MainApp() {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showLoadingScreen, setShowLoadingScreen] = useState(false)
  const [currentPage, setCurrentPage] = useState('mainframe')
  const [showDashboardsMenu, setShowDashboardsMenu] = useState(false)
  const dashboardsMenuRef = useRef(null)

  // Track if we've already initialized to prevent duplicate fetches
  const initializedRef = useRef(false)
  const fetchingProfileRef = useRef(false)
  // Track sign-in status via ref to avoid stale closure in auth listener
  const hasSignedInRef = useRef(false)

  useEffect(() => {
    // Prevent double initialization in React strict mode
    if (initializedRef.current) return
    initializedRef.current = true

    // Check for existing session on mount
    const initializeAuth = async () => {
      console.log('Initializing auth...')
      try {
        const { data: { session } } = await supabase.auth.getSession()
        
        if (session?.user) {
          console.log('Found existing session for:', session.user.email)
          setUser(session.user)
          hasSignedInRef.current = true
          await fetchProfile(session.user.id)
        } else {
          console.log('No existing session')
        }
      } catch (error) {
        console.error('Error getting session:', error)
      } finally {
        setLoading(false)
      }
    }

    initializeAuth()

    // Listen for auth changes - only care about sign in/out
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        console.log('Auth event:', event)
        
        // Only handle actual new sign-in events (not token refreshes or existing sessions)
        if (event === 'SIGNED_IN' && session?.user && !hasSignedInRef.current) {
          console.log('New sign in detected')
          hasSignedInRef.current = true
          setUser(session.user)
          setShowLoadingScreen(true)
          await fetchProfile(session.user.id)
          setLoading(false)
        }
        
        if (event === 'SIGNED_OUT') {
          console.log('Sign out detected')
          hasSignedInRef.current = false
          setUser(null)
          setProfile(null)
          setCurrentPage('mainframe')
          setLoading(false)
        }
        
        // Intentionally ignore: TOKEN_REFRESHED, INITIAL_SESSION, USER_UPDATED, etc.
        // Profile doesn't change on token refresh - no need to re-fetch
      }
    )

    return () => subscription.unsubscribe()
  }, [])

  // Close dashboards dropdown on outside click
  useEffect(() => {
    const handleMouseDown = (e) => {
      if (dashboardsMenuRef.current && !dashboardsMenuRef.current.contains(e.target)) {
        setShowDashboardsMenu(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [])

  const fetchProfile = async (userId) => {
    // Prevent concurrent fetches
    if (fetchingProfileRef.current) {
      console.log('Already fetching profile, skipping...')
      return
    }
    
    fetchingProfileRef.current = true
    console.log('Fetching profile for:', userId)

    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single()

      if (error) {
        console.error('Error fetching profile:', error)
        // Minimal fallback only for genuine failures
        setProfile({ id: userId, role: 'machinist', full_name: 'User', email: '' })
      } else {
        console.log('Profile loaded:', data.full_name, data.role)
        setProfile(data)
      }
    } catch (error) {
      console.error('Unexpected error fetching profile:', error)
      setProfile({ id: userId, role: 'machinist', full_name: 'User', email: '' })
    } finally {
      fetchingProfileRef.current = false
    }
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
  }

  // Check if user can access scheduling
  const canAccessSchedule = profile?.role === 'admin' || profile?.role === 'scheduler'

  // Check if user can access the Armory module (any role with at least one visible Armory tab)
  // Sub-tab visibility is enforced inside Armory.jsx itself
  const canAccessArmory = ['admin', 'compliance', 'finishing', 'machinist'].includes(profile?.role)

  // Dashboards menu remains admin-only (distinct from Armory)
  const canAccessDashboards = profile?.role === 'admin'

  // Get page title for header
  const getPageTitle = () => {
    switch (currentPage) {
      case 'schedule': return 'Command'
      case 'armory': return 'Armory'
      default: return 'Mainframe'
    }
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
    return <Login onLogin={async (u) => {
      setUser(u)
      setShowLoadingScreen(true)
      hasSignedInRef.current = true
      await fetchProfile(u.id)
    }} />
  }

  if (showLoadingScreen) {
    return <LoadingScreen onComplete={() => setShowLoadingScreen(false)} />
  }

  return (
    <div className="min-h-screen bg-skynet-dark">
      {import.meta.env.VITE_ENV_LABEL === 'test' && (
        <div className="w-full bg-amber-500 text-black text-center text-xs font-bold py-1 tracking-widest">
          TEST ENVIRONMENT — NOT LIVE DATA
        </div>
      )}
      <header className="bg-gray-900 border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              {/* Skybolt logo badge */}
              <div className="flex items-center">
                <img src="/skybolt-logo-white.png" alt="Skybolt" className="h-7 w-auto opacity-80" />
              </div>
              <span className="text-gray-700">|</span>
              <button 
                onClick={() => setCurrentPage('mainframe')}
                className="text-2xl font-bold text-white hover:text-skynet-accent transition-colors"
              >
                SkyNet
              </button>
              <div className="w-2 h-2 bg-skynet-green rounded-full animate-pulse"></div>
              <span className="text-skynet-green font-mono text-xs">Online</span>
            </div>
            <span className="text-gray-600">|</span>
            <span className="text-gray-400">{getPageTitle()}</span>
          </div>
          
          <div className="flex items-center gap-2">
            {/* Navigation buttons for authorized roles */}
            
            {/* Mainframe button - shown when not on Mainframe */}
            {currentPage !== 'mainframe' && (
              <button
                onClick={() => setCurrentPage('mainframe')}
                className="flex items-center gap-2 px-4 py-2 rounded transition-colors text-gray-400 hover:text-white hover:bg-gray-800"
              >
                <LayoutDashboard size={18} />
                <span className="text-sm font-medium">Mainframe</span>
              </button>
            )}
            
            {/* Schedule button - shown when on Mainframe and user has access */}
            {currentPage === 'mainframe' && canAccessSchedule && (
              <button
                onClick={() => setCurrentPage('schedule')}
                className="flex items-center gap-2 px-4 py-2 rounded transition-colors text-gray-400 hover:text-white hover:bg-gray-800"
              >
                <Calendar size={18} />
                <span className="text-sm font-medium">Command</span>
              </button>
            )}
            
            {/* Armory button - shown when on Mainframe and user has at least one Armory tab */}
            {currentPage === 'mainframe' && canAccessArmory && (
              <button
                onClick={() => setCurrentPage('armory')}
                className="flex items-center gap-2 px-4 py-2 rounded transition-colors text-gray-400 hover:text-white hover:bg-gray-800"
              >
                <Database size={18} />
                <span className="text-sm font-medium">Armory</span>
              </button>
            )}

            {/* Dashboards dropdown - admin only */}
            {currentPage === 'mainframe' && canAccessDashboards && (
              <div className="relative" ref={dashboardsMenuRef}>
                <button
                  onClick={() => setShowDashboardsMenu(prev => !prev)}
                  className="flex items-center gap-2 px-4 py-2 rounded transition-colors text-gray-400 hover:text-white hover:bg-gray-800"
                >
                  <Monitor size={18} />
                  <span className="text-sm font-medium">Dashboards</span>
                  <ChevronDown size={14} className={`transition-transform ${showDashboardsMenu ? 'rotate-180' : ''}`} />
                </button>
                {showDashboardsMenu && (
                  <div className="absolute right-0 top-full mt-1 w-56 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 py-1">
                    {DASHBOARDS.map(db => (
                      <a
                        key={db.path}
                        href={db.path}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setShowDashboardsMenu(false)}
                        className="flex items-center gap-2 px-4 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-700 transition-colors"
                      >
                        <Monitor size={14} />
                        {db.label}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
            
            <div className="text-right ml-2">
              <p className="text-white text-sm">{profile?.full_name || user.email}</p>
              <p className="text-gray-500 text-xs capitalize">{profile?.role?.replace('_', ' ') || 'User'}</p>
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

      <main className={currentPage === 'armory' ? '' : 'p-6'}>
        {currentPage === 'mainframe' && (
          <Mainframe user={user} profile={profile} />
        )}
        {currentPage === 'schedule' && canAccessSchedule && (
          <Schedule user={user} profile={profile} onNavigate={setCurrentPage} />
        )}
        {currentPage === 'armory' && canAccessArmory && (
          <Armory profile={profile} />
        )}
      </main>

      {currentPage !== 'armory' && (
        <footer className="fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 px-6 py-2">
          <p className="text-gray-600 text-xs text-center font-mono">
            "Don't worry, this one just schedules fasteners." - SkyNet MES v0.1
          </p>
        </footer>
      )}
    </div>
  )
}

// Root App component with routing
function App() {
  // Detect invite/recovery magic links arriving at Site URL (/) with token in hash
  // Supabase Dashboard invites land at SiteURL; we route them to /set-password instead
  if (typeof window !== 'undefined') {
    const hash = window.location.hash || ''
    const isInviteOrRecovery = hash.includes('type=invite') || hash.includes('type=recovery')
    const isAtRoot = window.location.pathname === '/' || window.location.pathname === ''
    if (isInviteOrRecovery && isAtRoot) {
      // Preserve the hash so /set-password can process the token
      window.location.replace('/set-password' + hash)
      return null  // bail out of render while redirect happens
    }
  }

  return (
    <BrowserRouter>
      <Routes>
        {/* Set password route - lands here from welcome email magic link */}
        <Route path="/set-password" element={<SetPassword />} />

        {/* Kiosk route - PIN-based auth, no Supabase login required */}
        <Route path="/kiosk/:machineCode" element={<Kiosk />} />

        {/* Finishing station route */}
        <Route path="/finishing" element={<Finishing />} />

        {/* Assembly display - TV dashboard, no login required */}
        <Route path="/dashboards/assembly" element={<AssemblyDisplay />} />

        {/* Print traveler route - opens in new tab */}
        <Route path="/print/traveler/:jobId" element={<PrintTraveler />} />

        {/* Main app - requires Supabase authentication */}
        <Route path="/*" element={<MainApp />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App