import { useState, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { Calendar, LayoutDashboard, Database } from 'lucide-react'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Schedule from './pages/Schedule'
import Kiosk from './pages/Kiosk'
import Secondary from './pages/Secondary'
import MasterData from './pages/MasterData'
import PrintTraveler from './components/PrintTraveler'
import LoadingScreen from './components/LoadingScreen'

// Main authenticated app component
function MainApp() {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showLoadingScreen, setShowLoadingScreen] = useState(false)
  const [currentPage, setCurrentPage] = useState('dashboard')
  
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
          setCurrentPage('dashboard')
          setLoading(false)
        }
        
        // Intentionally ignore: TOKEN_REFRESHED, INITIAL_SESSION, USER_UPDATED, etc.
        // Profile doesn't change on token refresh - no need to re-fetch
      }
    )

    return () => subscription.unsubscribe()
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
  
  // Check if user can access master data (admin only)
  const canAccessMasterData = profile?.role === 'admin'

  // Get page title for header
  const getPageTitle = () => {
    switch (currentPage) {
      case 'schedule': return 'Schedule'
      case 'masterdata': return 'Master Data'
      default: return 'Dashboard'
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
                onClick={() => setCurrentPage('dashboard')}
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
            
            {/* Dashboard button - shown when not on Dashboard */}
            {currentPage !== 'dashboard' && (
              <button
                onClick={() => setCurrentPage('dashboard')}
                className="flex items-center gap-2 px-4 py-2 rounded transition-colors text-gray-400 hover:text-white hover:bg-gray-800"
              >
                <LayoutDashboard size={18} />
                <span className="text-sm font-medium">Dashboard</span>
              </button>
            )}
            
            {/* Schedule button - shown when on Dashboard and user has access */}
            {currentPage === 'dashboard' && canAccessSchedule && (
              <button
                onClick={() => setCurrentPage('schedule')}
                className="flex items-center gap-2 px-4 py-2 rounded transition-colors text-gray-400 hover:text-white hover:bg-gray-800"
              >
                <Calendar size={18} />
                <span className="text-sm font-medium">Schedule</span>
              </button>
            )}
            
            {/* Master Data button - shown when on Dashboard and user is admin */}
            {currentPage === 'dashboard' && canAccessMasterData && (
              <button
                onClick={() => setCurrentPage('masterdata')}
                className="flex items-center gap-2 px-4 py-2 rounded transition-colors text-gray-400 hover:text-white hover:bg-gray-800"
              >
                <Database size={18} />
                <span className="text-sm font-medium">Master Data</span>
              </button>
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

      <main className={currentPage === 'masterdata' ? '' : 'p-6'}>
        {currentPage === 'dashboard' && (
          <Dashboard user={user} profile={profile} />
        )}
        {currentPage === 'schedule' && canAccessSchedule && (
          <Schedule user={user} profile={profile} onNavigate={setCurrentPage} />
        )}
        {currentPage === 'masterdata' && canAccessMasterData && (
          <MasterData profile={profile} />
        )}
      </main>

      {currentPage !== 'masterdata' && (
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
  return (
    <BrowserRouter>
      <Routes>
        {/* Kiosk route - PIN-based auth, no Supabase login required */}
        <Route path="/kiosk/:machineCode" element={<Kiosk />} />

        {/* Secondary operations route (passivation, paint, etc.) */}
        <Route path="/secondary/:operationType" element={<Secondary />} />

        {/* Print traveler route - opens in new tab */}
        <Route path="/print/traveler/:jobId" element={<PrintTraveler />} />

        {/* Main app - requires Supabase authentication */}
        <Route path="/*" element={<MainApp />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App