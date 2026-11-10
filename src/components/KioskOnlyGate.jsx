// components/KioskOnlyGate.jsx — kiosk-only accounts never get the office app (S17 Batch C, D-ASM-48).
// profiles.kiosk_only = true means the assembly tablet and nothing else. MainApp shows <KioskOnlyNotice> instead of
// the office; <OfficeRoute> does the same for the pages outside MainApp (dashboards, Bridge, Pricing, print). In both,
// no office component mounts for such an account, so no office query fires. The server refuses such accounts on
// the Assembly Board's functions (migration C3).
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { FEATURES } from '../config'
import { KIOSK_ONLY_MESSAGE } from '../lib/kioskAuth'
import { Tablet, LogOut } from 'lucide-react'

export function KioskOnlyNotice() {
  const signOut = async () => {
    try { await supabase.auth.signOut({ scope: 'local' }) } catch { /* already signed out */ }
    window.location.assign('/')
  }
  return (
    <div className="min-h-screen bg-skynet-dark flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center space-y-6">
        <Tablet size={48} className="mx-auto text-skynet-accent" />
        <h1 className="text-2xl font-semibold text-white">{KIOSK_ONLY_MESSAGE}</h1>
        <div className="flex flex-col gap-3">
          {FEATURES.ASSEMBLY_KIOSK && (
            <a
              href="/assembly-kiosk"
              className="w-full py-3 rounded-xl bg-skynet-accent hover:bg-blue-600 text-white text-lg font-semibold flex items-center justify-center gap-2"
            >
              <Tablet size={20} /> Go to the assembly tablet
            </a>
          )}
          <button
            type="button"
            onClick={signOut}
            className="w-full py-3 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-200 text-lg flex items-center justify-center gap-2"
          >
            <LogOut size={20} /> Sign out
          </button>
        </div>
      </div>
    </div>
  )
}

// Wraps a page that lives outside MainApp. With no session the page renders as before (it handles sign-in itself);
// with a session, the page mounts only once the profile says the account is not kiosk-only.
export function OfficeRoute({ children }) {
  const [state, setState] = useState('checking') // checking | office | kiosk_only
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session?.user) { if (alive) setState('office'); return }
        const { data } = await supabase.from('profiles').select('kiosk_only').eq('id', session.user.id).maybeSingle()
        if (alive) setState(data?.kiosk_only ? 'kiosk_only' : 'office')
      } catch {
        if (alive) setState('office')
      }
    })()
    return () => { alive = false }
  }, [])
  if (state === 'checking') return <div className="min-h-screen bg-skynet-dark" />
  if (state === 'kiosk_only') return <KioskOnlyNotice />
  return children
}
