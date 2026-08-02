import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { FEATURES } from '../config'
import PinPad from '../components/PinPad'
import KitSearch from '../components/kitregistry/KitSearch'
// Pure helpers live in the query layer so the Search tab and the Entry tab
// can't drift apart on formatting or filter escaping.
import { BOOK_ORDER, todayLocal, sanitizeTerm } from '../lib/kitRegistry'
import {
  Loader2, LogOut, BookOpen, Search, FileCheck, CheckCircle,
  X, ClipboardList, Plus,
} from 'lucide-react'

// Shared with the machine kiosk / rack kiosk — this is the same physical device.
const KIOSK_DEVICE_ID_KEY = 'skynet.kiosk.device_id'

// Books whose paper rows have no stud / receptacle lot columns.
const BOOKS_WITHOUT_STUD = ['RV']

const TYPEAHEAD_DEBOUNCE = 250
const SO_DEBOUNCE = 400

// A kit_skus row whose description is missing, or just repeats the part number,
// has no second line worth showing — never render the same string twice.
// (Real kit names land via a kit_skus.description refresh from the Fishbowl
// product export; this is display courtesy until then.)
function skuDisplay(sku) {
  const partNumber = (sku?.part_number || '').trim()
  const description = (sku?.description || '').trim()
  const hasName = !!description && description.toLowerCase() !== partNumber.toLowerCase()
  return {
    primary: hasName ? description : partNumber,
    secondary: hasName ? partNumber : null,
  }
}

function getKioskDeviceId() {
  try {
    let id = localStorage.getItem(KIOSK_DEVICE_ID_KEY)
    if (!id) {
      id = (crypto?.randomUUID?.() || `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      localStorage.setItem(KIOSK_DEVICE_ID_KEY, id)
    }
    return id
  } catch {
    // Storage blocked (private mode etc.). Per-tab id — re-PIN every refresh,
    // which is the SAFE failure mode.
    return `ephemeral-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

export default function KitKiosk() {
  const deviceIdRef = useRef(getKioskDeviceId())

  // --- Mode / auth ---------------------------------------------------------
  // 'office'  = a real signed-in user session. No PIN anywhere.
  // 'kiosk'   = no session. Device JWT via kiosk-authenticate, then a PIN
  //             confirm on every save (the initials-on-the-book-row gesture).
  const [booting, setBooting] = useState(true)
  const [mode, setMode] = useState(null)
  const [profile, setProfile] = useState(null)       // office mode only
  const [deviceReady, setDeviceReady] = useState(false) // kiosk mode only

  // Device bootstrap PIN screen
  const [bootPin, setBootPin] = useState('')
  const [bootError, setBootError] = useState(null)
  const [bootBusy, setBootBusy] = useState(false)

  // Per-save PIN confirm (kiosk mode)
  const [pinPromptOpen, setPinPromptOpen] = useState(false)
  const [savePin, setSavePin] = useState('')
  const [savePinError, setSavePinError] = useState(null)

  // --- Shell ---------------------------------------------------------------
  const [nav, setNav] = useState('entry')

  // --- Reference data ------------------------------------------------------
  const [books, setBooks] = useState([])
  const [booksLoading, setBooksLoading] = useState(false)

  // --- Entry form ----------------------------------------------------------
  const [book, setBook] = useState(null)
  // Advisory only. The number that lands on the kit is whatever the RPC returns
  // under its book lock (D-KSTC-10) — this is just what the bench expects next.
  const [advisoryNumber, setAdvisoryNumber] = useState(null)
  const [logDate, setLogDate] = useState(todayLocal())

  const [kitPartText, setKitPartText] = useState('')
  const [kitSkuId, setKitSkuId] = useState(null)
  const [kitSkuDesc, setKitSkuDesc] = useState(null)
  const [skuSuggestions, setSkuSuggestions] = useState([])
  const [skuOpen, setSkuOpen] = useState(false)
  const skuSuppressRef = useRef(false)

  const [customerText, setCustomerText] = useState('')
  const [partyId, setPartyId] = useState(null)
  const [partySuggestions, setPartySuggestions] = useState([])
  const [partyOpen, setPartyOpen] = useState(false)
  const partySuppressRef = useRef(false)

  // Sales Order — the bench has an SO in hand long before an invoice exists.
  const [soText, setSoText] = useState('')
  const [soInfo, setSoInfo] = useState(null) // { found, saleId, so_number, partyId, partyName }
  const [soChecking, setSoChecking] = useState(false)
  const [saleLineId, setSaleLineId] = useState(null)

  const [studNumber, setStudNumber] = useState('')
  const [platemount, setPlatemount] = useState('')
  const [notes, setNotes] = useState('')

  // --- Entry state ---------------------------------------------------------
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [success, setSuccess] = useState(null)  // { lotNumber, bookCode, who }

  const showStudFields = !!book && !BOOKS_WITHOUT_STUD.includes(book.code)

  useEffect(() => {
    document.title = 'Skybolt Kit Registry'
    return () => { document.title = 'SkyNet MES' }
  }, [])

  // ---------- Mode detection ------------------------------------------------
  useEffect(() => {
    let cancelled = false
    const init = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const user = session?.user
        const expired = session?.expires_at ? (session.expires_at * 1000 <= Date.now()) : false
        // A kiosk JWT minted by kiosk-authenticate carries app_metadata.kiosk.
        // Without this check a device that already bootstrapped would come back
        // as "office mode" on refresh and skip the PIN on every save.
        const isKioskJwt = !!user?.app_metadata?.kiosk

        if (cancelled) return

        if (user && !expired && !isKioskJwt) {
          const { data: prof } = await supabase
            .from('profiles').select('*').eq('id', user.id).maybeSingle()
          if (cancelled) return
          setProfile(prof || { id: user.id, full_name: user.email, role: null })
          setMode('office')
        } else if (user && !expired && isKioskJwt) {
          supabase.auth.stopAutoRefresh()
          setMode('kiosk')
          setDeviceReady(true)
        } else {
          setMode('kiosk')
          setDeviceReady(false)
        }
      } catch (err) {
        console.error('Kit registry auth init failed:', err)
        if (!cancelled) { setMode('kiosk'); setDeviceReady(false) }
      } finally {
        if (!cancelled) setBooting(false)
      }
    }
    init()
    return () => { cancelled = true }
  }, [])

  // ---------- Kiosk device bootstrap ---------------------------------------
  // Identical to the MaterialKiosk / Finishing bootstrap: kiosk-authenticate
  // mints an 8h JWT so every read/write runs as `authenticated`.
  const handleBootSubmit = async () => {
    if (bootPin.length < 4) { setBootError('PIN must be at least 4 digits'); return }
    setBootBusy(true)
    setBootError(null)
    try {
      // The function needs an active machine to mint the JWT but binds no
      // session to it, so any commissioned machine works as an anchor.
      // `machines` allows anon reads of active machines, so this works pre-login.
      const { data: anchor } = await supabase
        .from('machines').select('id')
        .eq('is_active', true).eq('is_commissioned', true)
        .order('display_order').limit(1)
      const anchorId = anchor?.[0]?.id
      if (!anchorId) { setBootError('No active machine available'); setBootPin(''); return }

      const { data, error } = await supabase.functions.invoke('kiosk-authenticate', {
        body: { pin: bootPin, machine_id: anchorId, device_id: deviceIdRef.current },
      })
      if (error || !data?.success) { setBootError('Invalid PIN'); setBootPin(''); return }

      const { error: sessionErr } = await supabase.auth.setSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      })
      if (sessionErr) {
        console.error('setSession failed:', sessionErr)
        setBootError('Authentication failed'); setBootPin(''); return
      }
      // Opaque/unused refresh_token — re-PIN at expiry. Stop auto-refresh so
      // the client never tries to use it.
      supabase.auth.stopAutoRefresh()
      setDeviceReady(true)
      setBootPin('')
    } catch (err) {
      console.error('Kiosk bootstrap error:', err)
      setBootError('Authentication failed'); setBootPin('')
    } finally {
      setBootBusy(false)
    }
  }

  useEffect(() => {
    if (mode !== 'kiosk' || deviceReady) return
    const onKey = (e) => {
      if (e.key >= '0' && e.key <= '9') { if (bootPin.length < 4) setBootPin(p => p + e.key) }
      else if (e.key === 'Backspace') setBootPin(p => p.slice(0, -1))
      else if (e.key === 'Enter') { if (bootPin.length >= 4) handleBootSubmit() }
      else if (e.key === 'Escape') setBootPin('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, deviceReady, bootPin])

  const handleDeviceLogout = async () => {
    await supabase.auth.signOut({ scope: 'local' })
    setDeviceReady(false)
    setBootPin('')
  }

  // ---------- Reference loads ----------------------------------------------
  const authReady = mode === 'office' ? !!profile : deviceReady

  const loadBooks = useCallback(async () => {
    setBooksLoading(true)
    try {
      const { data, error } = await supabase
        .from('kit_books')
        .select('id, code, name, category, first_lot, last_lot')
        .eq('is_active', true)
      if (error) throw error
      const ordered = [...(data || [])].sort((a, b) => {
        const ia = BOOK_ORDER.indexOf(a.code)
        const ib = BOOK_ORDER.indexOf(b.code)
        if (ia !== ib) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
        return (a.code || '').localeCompare(b.code || '')
      })
      setBooks(ordered)
    } catch (err) {
      console.error('Error loading kit books:', err)
      setBooks([])
    } finally {
      setBooksLoading(false)
    }
  }, [])

  useEffect(() => { if (authReady) loadBooks() }, [authReady, loadBooks])

  // ---------- Book selection + number pre-fill ------------------------------
  // Mirrors the RPC's own math — GREATEST(max lot in book, book.last_lot) + 1 —
  // so the bench sees the number it is about to get. Advisory only: the RPC
  // recomputes it under a row lock at insert time, and its answer wins.
  const refreshAdvisory = useCallback(async (b) => {
    if (!b) { setAdvisoryNumber(null); return }
    try {
      const { data } = await supabase
        .from('kit_lots')
        .select('lot_number')
        .eq('book_id', b.id)
        .order('lot_number', { ascending: false })
        .limit(1)
      const dbMax = data?.[0]?.lot_number ?? null
      const max = Math.max(dbMax ?? 0, b.last_lot ?? 0)
      setAdvisoryNumber(max ? max + 1 : (b.first_lot ?? null))
    } catch (err) {
      console.error('Error resolving next lot number:', err)
      setAdvisoryNumber(null)
    }
  }, [])

  const selectBook = async (b) => {
    setBook(b)
    setSaveError(null)
    if (BOOKS_WITHOUT_STUD.includes(b.code)) { setStudNumber(''); setPlatemount('') }
    await refreshAdvisory(b)
  }

  // ---------- Kit name typeahead (kit_skus) --------------------------------
  useEffect(() => {
    if (skuSuppressRef.current) { skuSuppressRef.current = false; return }
    const term = sanitizeTerm(kitPartText)
    if (term.length < 2) { setSkuSuggestions([]); return }
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const { data } = await supabase
          .from('kit_skus')
          .select('id, part_number, description')
          .or(`part_number.ilike.%${term}%,description.ilike.%${term}%`)
          .eq('is_active', true)
          .order('part_number')
          .limit(8)
        if (!cancelled) { setSkuSuggestions(data || []); setSkuOpen(true) }
      } catch (err) {
        console.error('SKU typeahead failed:', err)
        if (!cancelled) setSkuSuggestions([])
      }
    }, TYPEAHEAD_DEBOUNCE)
    return () => { cancelled = true; clearTimeout(t) }
  }, [kitPartText])

  const pickSku = (sku) => {
    skuSuppressRef.current = true
    setKitPartText(sku.part_number)
    setKitSkuId(sku.id)
    // Same rule as the suggestion row: a description that only repeats the part
    // number would echo the field back at the user, so fall through to the
    // generic confirmation line instead.
    setKitSkuDesc(skuDisplay(sku).secondary ? sku.description : null)
    setSkuSuggestions([])
    setSkuOpen(false)
  }

  // ---------- Customer typeahead (kit_parties) ------------------------------
  useEffect(() => {
    if (partySuppressRef.current) { partySuppressRef.current = false; return }
    const term = sanitizeTerm(customerText)
    if (term.length < 2) { setPartySuggestions([]); return }
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const { data } = await supabase
          .from('kit_parties')
          .select('id, name, normalized_name')
          .or(`name.ilike.%${term}%,normalized_name.ilike.%${term}%`)
          .order('name')
          .limit(8)
        if (!cancelled) { setPartySuggestions(data || []); setPartyOpen(true) }
      } catch (err) {
        console.error('Party typeahead failed:', err)
        if (!cancelled) setPartySuggestions([])
      }
    }, TYPEAHEAD_DEBOUNCE)
    return () => { cancelled = true; clearTimeout(t) }
  }, [customerText])

  const pickParty = (party) => {
    partySuppressRef.current = true
    setCustomerText(party.name)
    setPartyId(party.id)
    setPartySuggestions([])
    setPartyOpen(false)
  }

  // ---------- Sales Order verification --------------------------------------
  // The kit_sales mirror is export-refreshed, so a brand-new SO legitimately
  // won't be there yet. A miss is informational and never blocks (D-KSTC-11).
  useEffect(() => {
    setSoInfo(null)
    const raw = soText.trim()
    if (!raw) { setSoChecking(false); return }
    let cancelled = false
    setSoChecking(true)
    const t = setTimeout(async () => {
      try {
        const { data: sale } = await supabase
          .from('kit_sales')
          .select('id, so_number, party_id')
          .eq('so_number', raw)
          .maybeSingle()
        if (cancelled) return
        if (!sale) { setSoInfo({ found: false }); return }
        // Party name is a separate small query — never a nested select.
        let partyName = null
        if (sale.party_id) {
          const { data: p } = await supabase
            .from('kit_parties').select('name').eq('id', sale.party_id).maybeSingle()
          partyName = p?.name || null
        }
        if (!cancelled) {
          setSoInfo({
            found: true, saleId: sale.id, so_number: sale.so_number,
            partyId: sale.party_id, partyName,
          })
        }
      } catch (err) {
        console.error('Sales order lookup failed:', err)
        if (!cancelled) setSoInfo(null)
      } finally {
        if (!cancelled) setSoChecking(false)
      }
    }, SO_DEBOUNCE)
    return () => { cancelled = true; clearTimeout(t) }
  }, [soText])

  // ---------- Customer prefill from the resolved SO -------------------------
  // Only fills an EMPTY customer field, and stays editable afterwards.
  useEffect(() => {
    if (!soInfo?.found || !soInfo.partyName) return
    if (customerText.trim()) return
    // Suppress the party typeahead so the prefill doesn't pop a suggestion list.
    partySuppressRef.current = true
    setCustomerText(soInfo.partyName)
    setPartyId(soInfo.partyId || null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soInfo])

  // ---------- Sale-line staging --------------------------------------------
  // Bench-time version of the loader's SO link pass: when the SO resolves and
  // the kit name resolves to a SKU, and that SO has a line for that SKU, stage
  // the kit_sale_line_id onto the insert.
  useEffect(() => {
    setSaleLineId(null)
    const saleId = soInfo?.saleId
    if (!saleId || !kitSkuId) return
    let cancelled = false
    const run = async () => {
      try {
        const { data: lines } = await supabase
          .from('kit_sale_lines')
          .select('id')
          .eq('kit_sale_id', saleId)
          .eq('kit_sku_id', kitSkuId)
          .limit(1)
        if (!cancelled && lines?.[0]) setSaleLineId(lines[0].id)
      } catch (err) {
        console.error('Sale-line staging failed:', err)
      }
    }
    run()
    return () => { cancelled = true }
  }, [soInfo?.saleId, kitSkuId])

  // ---------- Save ----------------------------------------------------------
  const blockingReason = () => {
    if (!book) return 'Pick a book first.'
    return null
  }

  // The number is assigned server-side under a kit_books row lock, so two
  // benches saving at once can never collide and never leave a gap
  // (D-KSTC-10). Never insert into kit_lots directly from here.
  const doSave = async (createdById, createdByName) => {
    setSaving(true)
    setSaveError(null)
    try {
      const { data, error } = await supabase.rpc('kit_assign_and_log', {
        p_book_id: book.id,
        p_log_date: logDate || null,
        p_kit_part_as_written: kitPartText.trim(),
        p_kit_sku_id: kitSkuId,
        p_customer_as_written: customerText.trim(),
        p_party_id: partyId,
        p_so_as_written: soText.trim(),
        p_kit_sale_line_id: saleLineId,
        p_stud_number: showStudFields ? studNumber.trim() : '',
        p_rec_platemount_number: showStudFields ? platemount.trim() : '',
        p_notes: notes.trim(),
        p_created_by: createdById,
      })
      if (error) throw error

      const assigned = Array.isArray(data) ? data[0] : data
      if (!assigned?.lot_number) throw new Error('The registry did not return a kit number.')

      // Whatever the RPC returned is the number on the kit. If it differs from
      // the advisory (someone else logged first) it is simply correct — shown
      // without comment.
      setSuccess({
        lotNumber: assigned.lot_number,
        bookCode: assigned.book_code || book.code,
        who: createdByName || '',
      })
      await applyLogAnother()
      return true
    } catch (err) {
      console.error('Error saving kit lot:', err)
      setSaveError(err.message || 'Could not save this entry.')
      return false
    } finally {
      setSaving(false)
    }
  }

  const handleSave = async () => {
    const reason = blockingReason()
    if (reason) { setSaveError(reason); return }
    setSaveError(null)
    if (mode === 'office') {
      await doSave(profile?.id || null, profile?.full_name || '')
    } else {
      setSavePin('')
      setSavePinError(null)
      setPinPromptOpen(true)
    }
  }

  // Kiosk-mode confirm. created_by is stamped with the PIN operator's profile
  // id — never auth.uid(), which is the device JWT's anchor operator
  // (D-RLS-DOWNTIME01 precedent).
  const handlePinConfirm = async () => {
    if (savePin.length < 4) { setSavePinError('PIN must be 4 digits'); return }
    setSaving(true)
    setSavePinError(null)
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, username')
        .eq('pin_code', savePin)
        .eq('is_active', true)
        .single()
      if (error) {
        if (error.code === 'PGRST116') { setSavePinError('Invalid PIN'); setSavePin(''); return }
        throw error
      }
      setPinPromptOpen(false)
      setSavePin('')
      await doSave(data.id, data.full_name || data.username || '')
    } catch (err) {
      console.error('PIN confirm failed:', err)
      setSavePinError('Could not verify PIN')
      setSavePin('')
    } finally {
      setSaving(false)
    }
  }

  // ---------- Resets --------------------------------------------------------
  // The batch-of-kits flow: same kit name, book, date, customer and SO carry
  // over; only the per-kit lot fields clear. The advisory number is refetched
  // so it reflects the row we just wrote.
  const applyLogAnother = async () => {
    setStudNumber('')
    setPlatemount('')
    setNotes('')
    setSaveError(null)
    await refreshAdvisory(book)
  }

  const resetAll = () => {
    setBook(null)
    setAdvisoryNumber(null)
    setLogDate(todayLocal())
    // Only arm the suppress flag when the text actually changes — otherwise it
    // survives into the next real keystroke and swallows that search.
    if (kitPartText) skuSuppressRef.current = true
    setKitPartText(''); setKitSkuId(null); setKitSkuDesc(null); setSkuSuggestions([]); setSkuOpen(false)
    if (customerText) partySuppressRef.current = true
    setCustomerText(''); setPartyId(null); setPartySuggestions([]); setPartyOpen(false)
    setSoText(''); setSoInfo(null); setSaleLineId(null)
    setStudNumber(''); setPlatemount(''); setNotes('')
    setSaveError(null); setSuccess(null)
  }

  // ---------- Feature gate --------------------------------------------------
  if (!FEATURES.KIT_STC_REGISTRY) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-6">
        <div className="text-center text-gray-400">
          <BookOpen size={48} className="mx-auto mb-4 text-gray-600" />
          <p className="text-lg">The Kit &amp; STC Registry is not enabled.</p>
        </div>
      </div>
    )
  }

  if (booting) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <Loader2 size={28} className="animate-spin text-skynet-accent mx-auto mb-3" />
          <p className="text-gray-500 font-mono text-sm">Opening the kit registry…</p>
        </div>
      </div>
    )
  }

  // ---------- Kiosk device bootstrap screen ---------------------------------
  if (mode === 'kiosk' && !deviceReady) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-6">
        <PinPad
          icon={<BookOpen size={40} className="mx-auto mb-3 text-skynet-accent" />}
          title="Skybolt Kit Registry"
          subtitle="Enter your PIN to open this station"
          pin={bootPin}
          error={bootError}
          busy={bootBusy}
          onDigit={(d) => { if (bootPin.length < 4) setBootPin(bootPin + d) }}
          onClear={() => setBootPin('')}
          onBackspace={() => setBootPin(bootPin.slice(0, -1))}
          onSubmit={handleBootSubmit}
        />
      </div>
    )
  }

  const NAV_ITEMS = [
    { key: 'entry', label: 'Kit Entry', icon: ClipboardList },
    { key: 'search', label: 'Search', icon: Search },
    // Office-only: an issuance is an immutable compliance record and must
    // trace to a real authenticated user, not a shared bench device.
    ...(mode === 'office' ? [{ key: 'stc', label: 'Log STC', icon: FileCheck }] : []),
  ]

  return (
    <div className="min-h-screen bg-gray-900 text-white pb-24">
      <header className="sticky top-0 z-20 bg-gray-800 border-b border-gray-700">
        <div className="px-5 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <BookOpen size={24} className="text-skynet-accent shrink-0" />
            <div className="min-w-0">
              <h1 className="font-semibold text-lg leading-tight truncate">Skybolt Kit Registry</h1>
              <p className="text-gray-400 text-xs truncate">
                {mode === 'office'
                  ? (profile?.full_name || profile?.username || 'Signed in')
                  : 'Bench station — PIN confirms each entry'}
              </p>
            </div>
          </div>
          {mode === 'kiosk' && (
            <button
              onClick={handleDeviceLogout}
              className="flex items-center gap-2 text-gray-400 hover:text-white text-sm shrink-0"
            >
              <LogOut size={16} /> Close station
            </button>
          )}
        </div>
        <nav className="px-3 pb-2 flex items-center gap-2 overflow-x-auto">
          {NAV_ITEMS.map(item => {
            const Icon = item.icon
            const active = nav === item.key
            return (
              <button
                key={item.key}
                onClick={() => setNav(item.key)}
                className={`flex items-center gap-2 px-5 py-3 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-skynet-accent text-white'
                    : 'text-gray-400 hover:text-white hover:bg-gray-700'
                }`}
              >
                <Icon size={18} /> {item.label}
              </button>
            )
          })}
        </nav>
      </header>

      {nav === 'entry' && (
        <div className="p-5 max-w-3xl mx-auto">
          {/* The assigned number is the authoritative moment — rendered bare and
              huge so it can be copied straight onto the kit label. */}
          {success && (
            <div className="mb-5 bg-green-900/30 border border-green-700 rounded-xl p-5">
              <div className="flex items-start gap-3">
                <CheckCircle size={22} className="text-green-400 shrink-0 mt-1" />
                <div className="min-w-0 flex-1">
                  <p className="font-mono font-bold text-green-200 text-6xl leading-none tracking-tight">
                    {success.lotNumber}
                  </p>
                  <p className="text-green-300/80 text-sm mt-2">
                    {success.bookCode}{success.who ? ` · logged by ${success.who}` : ''}
                  </p>
                  <div className="flex flex-wrap gap-2 mt-4">
                    <button
                      onClick={() => setSuccess(null)}
                      className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-green-700 hover:bg-green-600 text-white text-sm font-medium"
                    >
                      <Plus size={16} /> Log another
                    </button>
                    <button
                      onClick={resetAll}
                      className="px-4 py-2.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm font-medium"
                    >
                      New entry
                    </button>
                  </div>
                </div>
                <button onClick={() => setSuccess(null)} className="text-green-400/60 hover:text-green-200">
                  <X size={18} />
                </button>
              </div>
            </div>
          )}

          {/* ---- Book ---- */}
          <Field label="Book">
            {booksLoading ? (
              <div className="flex items-center gap-2 text-gray-400 text-sm"><Loader2 size={16} className="animate-spin" /> Loading books…</div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {books.map(b => (
                  <button
                    key={b.id}
                    onClick={() => selectBook(b)}
                    className={`min-h-[4.25rem] px-3 py-3 rounded-xl border text-left transition-colors ${
                      book?.id === b.id
                        ? 'bg-skynet-accent/20 border-skynet-accent'
                        : 'bg-gray-800 border-gray-700 hover:bg-gray-700 hover:border-gray-600'
                    }`}
                  >
                    <span className="block font-mono font-bold text-lg text-white">{b.code}</span>
                    <span className="block text-gray-400 text-[11px] leading-tight mt-0.5 capitalize">{b.category}</span>
                  </button>
                ))}
              </div>
            )}
          </Field>

          {book && (
            <>
              {/* ---- Kit name ---- */}
              <Field label="Kit Name">
                <div className="relative">
                  <input
                    value={kitPartText}
                    onChange={e => {
                      setKitPartText(e.target.value)
                      setKitSkuId(null)
                      setKitSkuDesc(null)
                    }}
                    onFocus={() => { if (skuSuggestions.length) setSkuOpen(true) }}
                    placeholder="What kit is this?"
                    className="w-full px-4 py-3.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-base placeholder-gray-500 focus:border-skynet-accent focus:outline-none"
                  />
                  {skuOpen && skuSuggestions.length > 0 && (
                    <Suggestions onDismiss={() => setSkuOpen(false)}>
                      {skuSuggestions.map(s => {
                        // Description leads — the warehouse thinks in names —
                        // but a SKU with no real name renders on one line only.
                        const { primary, secondary } = skuDisplay(s)
                        return (
                          <button
                            key={s.id}
                            onClick={() => pickSku(s)}
                            className="w-full text-left px-4 py-3 hover:bg-gray-700 border-b border-gray-700 last:border-0"
                          >
                            <span className="block text-white">{primary}</span>
                            {secondary && (
                              <span className="block text-gray-400 text-xs font-mono truncate">{secondary}</span>
                            )}
                          </button>
                        )
                      })}
                    </Suggestions>
                  )}
                </div>
                {kitSkuId
                  ? <p className="text-gray-400 text-sm mt-2">{kitSkuDesc || 'Matched to the SKU catalog.'}</p>
                  : kitPartText.trim()
                    ? <UnmatchedTag />
                    : null}
              </Field>

              {/* ---- Kit # — display only; SkyNet assigns it (D-KSTC-10) ---- */}
              <Field label="Kit #">
                <p className="font-mono font-bold text-white text-5xl leading-none tracking-tight">
                  {advisoryNumber ?? '—'}
                </p>
              </Field>

              {/* ---- Log date ---- */}
              <Field label="Log date">
                <input
                  type="date"
                  value={logDate}
                  onChange={e => setLogDate(e.target.value)}
                  style={{ colorScheme: 'dark' }}
                  className="w-full px-4 py-3.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-base focus:border-skynet-accent focus:outline-none"
                />
              </Field>

              {/* ---- Customer ---- */}
              <Field label="Customer">
                <div className="relative">
                  <input
                    value={customerText}
                    onChange={e => { setCustomerText(e.target.value); setPartyId(null) }}
                    onFocus={() => { if (partySuggestions.length) setPartyOpen(true) }}
                    placeholder="Customer Name"
                    className="w-full px-4 py-3.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-base placeholder-gray-500 focus:border-skynet-accent focus:outline-none"
                  />
                  {partyOpen && partySuggestions.length > 0 && (
                    <Suggestions onDismiss={() => setPartyOpen(false)}>
                      {partySuggestions.map(p => (
                        <button
                          key={p.id}
                          onClick={() => pickParty(p)}
                          className="w-full text-left px-4 py-3 hover:bg-gray-700 border-b border-gray-700 last:border-0"
                        >
                          <span className="block text-white">{p.name}</span>
                        </button>
                      ))}
                    </Suggestions>
                  )}
                </div>
                {!partyId && customerText.trim() && <UnmatchedTag />}
              </Field>

              {/* ---- Sales order ---- */}
              <Field label="Sales Order #">
                <input
                  value={soText}
                  onChange={e => setSoText(e.target.value)}
                  placeholder="Optional"
                  className="w-full px-4 py-3.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-base placeholder-gray-500 focus:border-skynet-accent focus:outline-none"
                />
                {soChecking && (
                  <p className="text-gray-500 text-sm mt-2 flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin" /> Checking Fishbowl…
                  </p>
                )}
                {!soChecking && soInfo?.found && (
                  <p className="text-green-400 text-sm mt-2">
                    ✓ {soInfo.partyName || 'Unknown customer'} — SO {soInfo.so_number}
                  </p>
                )}
                {!soChecking && soInfo && !soInfo.found && (
                  <p className="text-gray-500 text-sm mt-2">
                    Not in the last Fishbowl sync — will auto-link on next refresh.
                  </p>
                )}
                {saleLineId && (
                  <p className="text-gray-400 text-xs mt-1">Sale line matched — it will be linked to this kit.</p>
                )}
              </Field>

              {/* ---- Stud / receptacle lot numbers ---- */}
              {showStudFields && (
                <div className="grid sm:grid-cols-2 gap-4">
                  <Field label="Stud Lot #">
                    <input
                      value={studNumber}
                      onChange={e => setStudNumber(e.target.value)}
                      className="w-full px-4 py-3.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-base focus:border-skynet-accent focus:outline-none"
                    />
                  </Field>
                  <Field label="Receptacle / Platemount Lot #">
                    <input
                      value={platemount}
                      onChange={e => setPlatemount(e.target.value)}
                      className="w-full px-4 py-3.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-base focus:border-skynet-accent focus:outline-none"
                    />
                  </Field>
                </div>
              )}

              {/* ---- Notes ---- */}
              <Field label="Notes">
                <textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Optional"
                  className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white text-base placeholder-gray-500 focus:border-skynet-accent focus:outline-none resize-none"
                />
              </Field>

              {saveError && (
                <p className="text-red-400 text-sm mb-3">{saveError}</p>
              )}

              <div className="flex flex-wrap gap-3 pt-1">
                <button
                  onClick={handleSave}
                  disabled={saving || !!blockingReason()}
                  className="flex-1 min-w-[14rem] h-14 rounded-xl bg-skynet-accent hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white text-base font-semibold flex items-center justify-center gap-2 transition-colors"
                >
                  {saving ? <Loader2 size={20} className="animate-spin" /> : <CheckCircle size={20} />}
                  {mode === 'kiosk' ? 'Save — confirm with PIN' : 'Save entry'}
                </button>
                <button
                  onClick={resetAll}
                  className="h-14 px-6 rounded-xl bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-base font-medium"
                >
                  New entry
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Read-only in both modes — RLS already gates writes, and the Search tab
          issues none. Kiosk mode gets the same view as the office. */}
      {nav === 'search' && <KitSearch />}

      {nav === 'stc' && mode === 'office' && (
        <Placeholder
          icon={<FileCheck size={40} className="mx-auto mb-4 text-gray-600" />}
          title="Log STC arrives in the next round"
          body="Issuances are immutable compliance records — this area stays office-only."
        />
      )}

      {/* ---- Kiosk PIN confirm ---- */}
      {pinPromptOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
          <div className="w-full max-w-sm">
            <PinPad
              icon={<ClipboardList size={40} className="mx-auto mb-3 text-skynet-accent" />}
              title={`Log ${book?.code || ''} kit`}
              subtitle="Enter your PIN to sign this entry"
              pin={savePin}
              error={savePinError}
              busy={saving}
              buttonLabel="Confirm & log"
              onDigit={(d) => { if (savePin.length < 4) setSavePin(savePin + d) }}
              onClear={() => setSavePin('')}
              onBackspace={() => setSavePin(savePin.slice(0, -1))}
              onSubmit={handlePinConfirm}
            />
            <button
              onClick={() => { setPinPromptOpen(false); setSavePin(''); setSavePinError(null) }}
              className="w-full mt-3 h-12 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- Small presentational helpers ------------------------------------

function Field({ label, children }) {
  return (
    <div className="mb-5">
      <label className="block text-gray-400 text-sm font-medium mb-2">{label}</label>
      {children}
    </div>
  )
}

function Suggestions({ children, onDismiss }) {
  return (
    <>
      {/* Click-away sits above the sticky header (z-20) so a tap anywhere
          dismisses; the list itself sits above the click-away. */}
      <div className="fixed inset-0 z-30" onClick={onDismiss} />
      <div className="absolute left-0 right-0 top-full mt-1 z-40 bg-gray-800 border border-gray-600 rounded-lg shadow-xl max-h-72 overflow-y-auto">
        {children}
      </div>
    </>
  )
}

function UnmatchedTag() {
  return (
    <span className="inline-block mt-2 text-[11px] px-2 py-0.5 rounded bg-gray-700 text-gray-300">
      unmatched — office will resolve
    </span>
  )
}

function Placeholder({ icon, title, body }) {
  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="bg-gray-800 border border-gray-700 rounded-2xl p-10 text-center">
        {icon}
        <p className="text-white text-lg font-medium">{title}</p>
        <p className="text-gray-400 text-sm mt-2">{body}</p>
      </div>
    </div>
  )
}
