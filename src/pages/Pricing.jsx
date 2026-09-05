//
// Pricing Portal — /pricing (S11, D-PRICE-17/25). Standalone route outside
// MainApp, office session only (no PIN, no kiosk JWT): the SalesDashboard
// auth pattern. Tabs: Lookup · Catalog · Customers · Price Books (Batch C).
//
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { FEATURES } from '../config'
import { canViewPricing, canEditPricing } from '../lib/roles'
import { loadBooks, loadBookMeta, bookContext, loadSyncAges, ageLabel, todayIso, rollBooks } from '../lib/pricing'
import QuoteBuilder from '../components/pricing/QuoteBuilder'
import PriceCatalog from '../components/pricing/PriceCatalog'
import PriceCustomers from '../components/pricing/PriceCustomers'
import PriceBooks from '../components/pricing/PriceBooks'
import { Loader2, Tags, FileText, Layers, Users, BookOpen, LogOut, RefreshCw, AlertTriangle } from 'lucide-react'

const TABS = [
  { key: 'quote', label: 'Quote Builder', icon: FileText },
  { key: 'catalog', label: 'Catalog', icon: Layers },
  { key: 'customers', label: 'Customers', icon: Users },
  { key: 'books', label: 'Price Books', icon: BookOpen },
]

export default function Pricing() {
  const navigate = useNavigate()
  const [phase, setPhase] = useState('auth')         // auth | authorized | denied
  const [profile, setProfile] = useState(null)
  const [tab, setTab] = useState('quote')
  const [asOf, setAsOf] = useState(todayIso())
  const [books, setBooks] = useState([])
  const [meta, setMeta] = useState(null)             // rules / ladders / sections of the book in effect on asOf
  const [ages, setAges] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    document.title = 'Skybolt Pricing'
    return () => { document.title = 'SkyNet MES' }
  }, [])

  // Auth + role gate — office session only.
  useEffect(() => {
    let mounted = true
    async function check() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.user || session.user.app_metadata?.kiosk) { navigate('/'); return }
      const { data: prof, error: err } = await supabase.from('profiles').select('id, full_name, email, role, roles, is_salesperson').eq('id', session.user.id).single()
      if (!mounted) return
      if (err || !prof) { navigate('/'); return }
      if (!canViewPricing(prof)) { setPhase('denied'); return }
      setProfile(prof); setPhase('authorized')
    }
    check()
    return () => { mounted = false }
  }, [navigate])

  const refresh = useCallback(async () => {
    try {
      await rollBooks().catch(() => {})     // a scheduled book whose date has arrived becomes active (status only; pricing already resolves by date)
      const [b, a] = await Promise.all([loadBooks(), loadSyncAges()])
      setBooks(b); setAges(a); setError(null)
    } catch (e) { setError(e.message || String(e)) }
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (phase === 'authorized') refresh() }, [phase, refresh])

  const { current, next } = bookContext(books, asOf)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!current?.id) { setMeta(null); return }
    let cancelled = false
    loadBookMeta(current.id).then(m => { if (!cancelled) setMeta(m) }).catch(e => setError(e.message || String(e)))
    return () => { cancelled = true }
  }, [current?.id])

  const canEdit = canEditPricing(profile)
  const today = todayIso()

  if (!FEATURES.PRICING_PORTAL) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-6">
        <div className="text-center text-gray-400"><Tags size={48} className="mx-auto mb-4 text-gray-600" /><p className="text-lg">The Pricing Portal is not enabled.</p></div>
      </div>
    )
  }
  if (phase === 'auth') {
    return <div className="min-h-screen bg-gray-900 flex items-center justify-center"><Loader2 size={28} className="animate-spin text-skynet-accent" /></div>
  }
  if (phase === 'denied') {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-6">
        <div className="text-center text-gray-400">
          <p className="text-lg mb-4">You do not have access to the Pricing Portal.</p>
          <button onClick={() => navigate('/')} className="px-4 py-2 rounded border border-gray-600 text-gray-300 hover:text-white">Return</button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white pb-16">
      <header className="sticky top-0 z-20 bg-gray-800 border-b border-gray-700">
        <div className="px-5 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Tags size={24} className="text-skynet-accent shrink-0" />
            <div className="min-w-0">
              <h1 className="font-semibold text-lg leading-tight">Skybolt Pricing</h1>
              <p className="text-gray-400 text-xs truncate">
                {current ? <>In effect {asOf === today ? 'today' : `on ${asOf}`}: <span className="text-white">{current.rev_label}</span> (from {current.effective_from})</> : <span className="text-amber-300">No price book in effect on {asOf}</span>}
                {next && <> · next: <span className="text-white">{next.rev_label}</span> effective {next.effective_from}</>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-400">
            {ages && (
              <span className="hidden md:inline" title={`customers ${ageLabel(ages.last_customers_at)} · products ${ageLabel(ages.last_products_at)} · history ${ageLabel(ages.last_history_at)}`}>
                Fishbowl: customers {ageLabel(ages.last_customers_at)} · history {ageLabel(ages.last_history_at)}
              </span>
            )}
            <button onClick={refresh} className="text-gray-400 hover:text-white" title="Refresh"><RefreshCw size={14} /></button>
            <span className="text-gray-500">{profile?.full_name}{canEdit ? ' · admin' : ''}</span>
            <button onClick={() => navigate('/')} className="flex items-center gap-1 text-gray-400 hover:text-white"><LogOut size={14} /> SkyNet</button>
          </div>
        </div>
        <nav className="px-5 flex gap-1">
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-4 py-2 text-sm border-b-2 -mb-px transition-colors ${tab === t.key ? 'border-skynet-accent text-white' : 'border-transparent text-gray-400 hover:text-white'}`}>
              <t.icon size={15} /> {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="px-5 py-5">
        {error && <div className="mb-4 flex items-center gap-2 text-sm text-rose-300 bg-rose-950/40 border border-rose-900 rounded px-3 py-2"><AlertTriangle size={14} /> {error}</div>}
        {tab === 'quote' && <QuoteBuilder book={current} meta={meta} asOf={asOf} setAsOf={setAsOf} todayIso={today} nextBook={next} canEdit={canEdit} profile={profile} />}
        {tab === 'catalog' && (meta ? <PriceCatalog book={current} meta={meta} canEdit={canEdit} /> : <div className="p-8 text-center"><Loader2 size={22} className="animate-spin text-gray-500 mx-auto" /></div>)}
        {tab === 'customers' && <PriceCustomers asOf={asOf} canEdit={canEdit} book={current} nextBook={next} profile={profile} />}
        {tab === 'books' && <PriceBooks canEdit={canEdit} onBooksChanged={refresh} />}
      </main>
    </div>
  )
}
