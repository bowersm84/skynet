import { useState, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { Calendar, LayoutDashboard, Database, Monitor, ChevronDown, KeyRound, LogOut, ShoppingCart } from 'lucide-react'
import Login from './pages/Login'
import SetPassword from './pages/SetPassword'
import ForgotPassword from './pages/ForgotPassword'
import ConfirmInvite from './pages/ConfirmInvite'
import Mainframe from './pages/Mainframe'
import Schedule from './pages/Schedule'
import Kiosk from './pages/Kiosk'
import Finishing from './pages/Finishing'
import Armory from './pages/Armory'
import CustomerOrders from './pages/CustomerOrders'
import AssemblyDisplay from './pages/dashboards/AssemblyDisplay'
import PrintTraveler from './components/PrintTraveler'
import LoadingScreen from './components/LoadingScreen'
import ChangePinModal from './components/ChangePinModal'

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
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [showChangePinModal, setShowChangePinModal] = useState(false)
  const dashboardsMenuRef = useRef(null)
  const userMenuRef = useRef(null)

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

    // Listen for auth changes - only care about sign in/out.
    // The callback itself MUST NOT be async, and any Supabase query must run
    // inside setTimeout(0) to escape Supabase's internal auth lock. Awaiting
    // a query inline deadlocks getSession() and the profile fetch on refresh.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        console.log('Auth event:', event)

        if (event === 'SIGNED_IN' && session?.user && !hasSignedInRef.current) {
          // Defer: escapes the auth lock so fetchProfile can run
          setTimeout(async () => {
            console.log('New sign in detected')
            hasSignedInRef.current = true
            setUser(session.user)
            setShowLoadingScreen(true)
            try {
              await fetchProfile(session.user.id)
            } finally {
              setLoading(false)
            }
          }, 0)
          return
        }

        if (event === 'SIGNED_OUT') {
          console.log('Sign out detected')
          hasSignedInRef.current = false
          setUser(null)
          setProfile(null)
          setCurrentPage('mainframe')
          setLoading(false)
          return
        }
        // Intentionally ignore: TOKEN_REFRESHED, INITIAL_SESSION, USER_UPDATED.
      }
    )

    return () => subscription.unsubscribe()
  }, [])

  // Close dropdowns on outside click
  useEffect(() => {
    const handleMouseDown = (e) => {
      if (dashboardsMenuRef.current && !dashboardsMenuRef.current.contains(e.target)) {
        setShowDashboardsMenu(false)
      }
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setShowUserMenu(false)
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

  // Roles that can VIEW the Command/Schedule page
  const canAccessSchedule = ['admin', 'scheduler', 'compliance', 'finishing', 'machinist'].includes(profile?.role)

  // Roles that can EDIT the schedule (drag jobs, schedule maintenance, reschedule)
  // Also gates work order creation buttons in Mainframe
  const canEditSchedule = ['admin', 'scheduler'].includes(profile?.role)

  // Check if user can access the Armory module (any role with at least one visible Armory tab)
  // Sub-tab visibility is enforced inside Armory.jsx itself
  const canAccessArmory = ['admin', 'compliance', 'finishing', 'machinist', 'scheduler', 'customer_service'].includes(profile?.role)
  const canAccessCustomerOrders = ['admin', 'scheduler', 'customer_service'].includes(profile?.role)

  // Dashboards menu remains admin-only (distinct from Armory)
  const canAccessDashboards = profile?.role === 'admin'

  // Roles that have a kiosk PIN — these users see Change PIN in the user dropdown
  const hasKioskPin = ['machinist', 'admin', 'finishing'].includes(profile?.role)

  // Get page title for header
  const getPageTitle = () => {
    switch (currentPage) {
      case 'schedule': return 'Command'
      case 'armory': return 'Armory'
      case 'customer_orders': return 'Customer Orders'
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
            
            {/* Customer Orders button - shown when on Mainframe and user has access */}
            {currentPage === 'mainframe' && canAccessCustomerOrders && (
              <button
                onClick={() => setCurrentPage('customer_orders')}
                className="flex items-center gap-2 px-4 py-2 rounded transition-colors text-gray-400 hover:text-white hover:bg-gray-800"
              >
                <ShoppingCart size={18} />
                <span className="text-sm font-medium">Customer Orders</span>
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
            
            <div className="relative ml-2" ref={userMenuRef}>
              <button
                onClick={() => setShowUserMenu(prev => !prev)}
                className="flex items-center gap-2 px-3 py-2 rounded hover:bg-gray-800 transition-colors"
              >
                <div className="text-right">
                  <p className="text-white text-sm">{profile?.full_name || user.email}</p>
                  <p className="text-gray-500 text-xs capitalize">{profile?.role?.replace('_', ' ') || 'User'}</p>
                </div>
                <ChevronDown size={14} className={`text-gray-500 transition-transform ${showUserMenu ? 'rotate-180' : ''}`} />
              </button>
              {showUserMenu && (
                <div className="absolute right-0 top-full mt-1 w-56 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 py-1">
                  {hasKioskPin && (
                    <button
                      onClick={() => { setShowUserMenu(false); setShowChangePinModal(true) }}
                      className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-700 transition-colors text-left"
                    >
                      <KeyRound size={14} />
                      {profile?.pin_code ? 'Change Kiosk PIN' : 'Create Kiosk PIN'}
                    </button>
                  )}
                  {hasKioskPin && (
                    <div className="border-t border-gray-700 my-1"></div>
                  )}
                  <button
                    onClick={() => { setShowUserMenu(false); handleLogout() }}
                    className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-700 transition-colors text-left"
                  >
                    <LogOut size={14} />
                    Logout
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className={currentPage === 'armory' ? '' : 'p-6'}>
        {currentPage === 'mainframe' && (
          <Mainframe user={user} profile={profile} canCreateWorkOrders={canEditSchedule} />
        )}
        {currentPage === 'schedule' && canAccessSchedule && (
          <Schedule user={user} profile={profile} onNavigate={setCurrentPage} canEdit={canEditSchedule} />
        )}
        {currentPage === 'armory' && canAccessArmory && (
          <Armory profile={profile} />
        )}
        {currentPage === 'customer_orders' && canAccessCustomerOrders && (
          <CustomerOrders profile={profile} onNavigate={setCurrentPage} />
        )}
      </main>

      {currentPage !== 'armory' && (
        <footer className="fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 px-6 py-2">
          <p className="text-gray-600 text-xs text-center font-mono">
            "Don't worry, this one just schedules fasteners." - SkyNet MES v0.1
          </p>
        </footer>
      )}

      {showChangePinModal && profile && (
        <ChangePinModal
          profile={profile}
          onClose={() => setShowChangePinModal(false)}
          onSuccess={(newPin) => {
            // Update local profile state so subsequent dropdown reflects "Change" not "Create"
            setProfile(prev => prev ? { ...prev, pin_code: newPin } : prev)
          }}
        />
      )}
    </div>
  )
}

// Root App component with routing
function App() {
  // Detect invite/recovery magic links landing at Site URL (/).
  // PKCE flow produces ?code= in the query string; we route those to /set-password.
  // Also catch error-state hashes (otp_expired etc.) so SetPassword can show a friendly message.
  if (typeof window !== 'undefined') {
    const search = window.location.search || ''
    const hash = window.location.hash || ''
    const hasPkceCode = search.includes('code=')
    const hasAuthError = hash.includes('error=') || hash.includes('error_code=')
    const isAtRoot = window.location.pathname === '/' || window.location.pathname === ''
    if ((hasPkceCode || hasAuthError) && isAtRoot) {
      // Preserve the query string and hash so /set-password can process them
      window.location.replace('/set-password' + search + hash)
      return null
    }
  }

  return (
    <BrowserRouter>
      <Routes>
        {/* Invite confirmation route - intermediate page that shields tokens from email link scanners */}
        <Route path="/confirm-invite" element={<ConfirmInvite />} />

        {/* Set password route - lands here from welcome email magic link */}
        <Route path="/set-password" element={<SetPassword />} />

        {/* Forgot password route - self-service password reset */}
        <Route path="/forgot-password" element={<ForgotPassword />} />

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