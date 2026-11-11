// src/pages/AssemblyKiosk.jsx — the assemblers' tablet (S17 Batch C, D-ASM-39 / D-ASM-40).
//
// PIN → my builds / open builds → tap lots → Start → checklist sign-offs → Pause / Resume → Closeout.
// Sign-in goes through kiosk-authenticate like the Traveler Kiosk (anchor = first active, commissioned machine;
// device_id = the tablet's name, asked once and kept in localStorage, plus this browser's kiosk device id, so
// misses are counted per tablet; no kiosk_sessions row; 2-minute inactivity sign-out).
// The kiosk token's sub is the assembler, so auth.uid() is them on the server; a second
// person never signs in — their PIN goes to the function and is resolved there (the PIN vault, D-ASM-43).
// A temporary PIN forces a new one at first sign-in, then the avatar pick (D-ASM-46).
// Messages from the functions are written for people and shown as they are. PIN misses come back as results
// ({ ok:false } / 'pin_rejected' / 'second_pin_rejected' / 'inspector_pin_rejected'), never as exceptions.
// No admin controls, no release, nothing about Fishbowl.
import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { FEATURES } from '../config'
import PinPad from '../components/PinPad'
import AvatarPicker, { Avatar } from '../components/AvatarPicker'
import { setAvatar } from '../lib/avatars'
import { kioskAuthLockedMessage } from '../lib/kioskAuth'
import { BUILD_KIND_LABELS, STEP_TYPE_LABELS } from '../lib/assembly'
import {
  listKioskBuilds, getKioskBuild, myOpenSession, listComponents, startBuild, clockIn, clockOut, signStep, closeoutBuild,
  resolvePin, changeOwnPin, lotPrefixDisplay, listPulledLots, stepDistinctFrom,
} from '../lib/assemblyKiosk'
import {
  splitBoard, waveLabel, sortLots, togglePick, isPicked, coverage, lotsPayload, isSignStep, inspectorStep,
  isNewLotSet, newLotSetText, formatMinutes, isAssemblyOperator, appendKey, pulledLotsByComponent, signerRule,
} from '../lib/assemblyKioskMath'
import {
  Wrench, LogOut, ArrowLeft, Loader2, CheckCircle, XCircle, AlertTriangle, Pause, Play, RefreshCw,
  Info, Tablet, Delete, ClipboardCheck,
} from 'lucide-react'

const INACTIVITY_TIMEOUT = 2 * 60 * 1000 // D-ASM-39: 2 minutes, the Traveler Kiosk pattern
const DEVICE_NAME_KEY = 'skynet.assembly_kiosk.device_name'
// Same key as every other kiosk page: one device identity per browser, so sign-in misses are counted per tablet
// (D-ASM-44). The tablet's name rides along for people reading the audit log.
const KIOSK_DEVICE_ID_KEY = 'skynet.kiosk.device_id'

function getKioskDeviceId() {
  try {
    let id = localStorage.getItem(KIOSK_DEVICE_ID_KEY)
    if (!id) {
      id = (crypto?.randomUUID?.() || `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      localStorage.setItem(KIOSK_DEVICE_ID_KEY, id)
    }
    return id
  } catch {
    return `ephemeral-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}
const PAUSE_REASONS = ['End of shift', 'Break', 'Waiting on parts', 'Other job']
const PRIORITY_BORDER = { critical: 'border-l-red-500', high: 'border-l-amber-400', normal: 'border-l-gray-600', low: 'border-l-gray-700' }
const PRIORITY_CHIP = {
  critical: 'bg-red-600 text-white', high: 'bg-amber-500 text-black', normal: 'bg-gray-700 text-gray-200', low: 'bg-gray-800 text-gray-400',
}
const PRIORITY_LABEL = { critical: 'Critical', high: 'High', normal: 'Normal', low: 'Low' }

function readDeviceName() {
  try { return localStorage.getItem(DEVICE_NAME_KEY) || '' } catch { return '' }
}
function writeDeviceName(name) {
  try { localStorage.setItem(DEVICE_NAME_KEY, name) } catch { /* storage blocked: asked again next load */ }
}

// Date-only values (YYYY-MM-DD) as local dates so a due date never shows the day before in Florida.
function formatDate(value) {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value))
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const messageOf = (err) => err?.message || String(err || 'Something went wrong')

// ── Building blocks ──────────────────────────────────────────────────────────

function ErrorBox({ message }) {
  if (!message) return null
  return (
    <div className="rounded-xl border border-red-700 bg-red-900/40 text-red-100 text-lg px-4 py-3 flex items-start gap-3">
      <AlertTriangle size={24} className="shrink-0 mt-0.5" />
      <span>{message}</span>
    </div>
  )
}

const TONES = {
  primary: 'bg-skynet-accent hover:bg-blue-600 text-white',
  green: 'bg-green-600 hover:bg-green-500 text-white',
  amber: 'bg-amber-500 hover:bg-amber-400 text-black',
  gray: 'bg-gray-700 hover:bg-gray-600 text-white',
  red: 'bg-red-700 hover:bg-red-600 text-white',
}
function BigButton({ children, onClick, disabled, tone = 'primary', className = '' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`min-h-16 px-6 rounded-2xl text-xl font-semibold flex items-center justify-center gap-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${TONES[tone]} ${className}`}
    >
      {children}
    </button>
  )
}

// A key the pads must leave alone: typing in a real field, or a shortcut with a modifier held.
function keyBelongsElsewhere(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return true
  const el = e.target
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}

// A PIN pad with its own state. Every PIN pad on this kiosk is a PinEntry, and only the pad on screen is mounted,
// so exactly one pad listens. Keyboard as on the other kiosks (by e.key, so the top row and the number pad both
// work): digits up to four, Backspace, Enter submits once four are in, Escape clears; the keys it handles do not
// reach the browser. Ignored while busy, while typing in a field, or with a modifier held (D-ASM-40).
// The listener is attached ONCE and reads the latest props through a ref. Signed in, the kiosk's idle timer also
// listens for keydown and re-renders the page between the two listeners of the same key press; a listener that
// was re-attached on that render (its dependencies changing every render) is skipped by the browser for that key,
// so every key was lost on the signed-in pads (Matt, Nov 10).
function PinEntry({ title, subtitle, error, busy, onSubmit, buttonLabel = 'Enter', icon }) {
  const [pin, setPin] = useState('')
  const submit = useCallback(() => {
    if (pin.length < 4 || busy) return
    const p = pin
    setPin('')
    onSubmit(p)
  }, [pin, busy, onSubmit])
  const latest = useRef({ busy, submit })
  useLayoutEffect(() => { latest.current = { busy, submit } })
  useEffect(() => {
    const onKey = (e) => {
      if (keyBelongsElsewhere(e)) return
      const digit = /^[0-9]$/.test(e.key)
      if (!digit && !['Backspace', 'Enter', 'Escape'].includes(e.key)) return
      e.preventDefault()
      if (latest.current.busy) return
      if (digit) setPin((p) => (p.length < 4 ? p + e.key : p))
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1))
      else if (e.key === 'Enter') latest.current.submit()
      else setPin('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <PinPad
      icon={icon || <Wrench size={40} className="mx-auto mb-3 text-skynet-accent" />}
      title={title}
      subtitle={subtitle}
      pin={pin}
      error={error}
      busy={busy}
      buttonLabel={buttonLabel}
      onDigit={(d) => setPin((p) => (p.length < 4 ? p + d : p))}
      onClear={() => setPin('')}
      onBackspace={() => setPin((p) => p.slice(0, -1))}
      onSubmit={submit}
    />
  )
}

// Collect one or two people's PINs, echoing each name before it is used. The PIN is resolved on the server
// (assembly_pin_resolve); the same person twice is refused here; `exclude` refuses one person (the assembler,
// where a check must be someone else) — for every signer, or only signer `exclude.at` when it is set.
// onDone([{ pin, profile_id, full_name }]).
function PeopleCheck({ titles, subtitle, initialError = null, exclude = null, run, onDone, onCancel }) {
  const [collected, setCollected] = useState([])
  const [pending, setPending] = useState(null)
  const [error, setError] = useState(initialError)
  const [busy, setBusy] = useState(false)
  const index = collected.length

  const handlePin = async (pin) => {
    setBusy(true)
    setError(null)
    try {
      const r = await run(() => resolvePin(pin))
      if (!r?.ok) { setError(r?.message || 'PIN not recognized'); return }
      if (exclude && (exclude.at === undefined || exclude.at === index) && r.profile_id === exclude.id) { setError(exclude.message); return }
      if (collected.some((c) => c.profile_id === r.profile_id)) { setError('That is the same person — a different person must sign'); return }
      setPending({ pin, profile_id: r.profile_id, full_name: r.full_name })
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const confirm = () => {
    const next = [...collected, pending]
    setPending(null)
    if (next.length >= titles.length) onDone(next)
    else setCollected(next)
  }

  if (pending) {
    return (
      <div className="w-full max-w-md text-center space-y-6">
        <div className="text-gray-400 text-xl">{titles[index]}</div>
        <div className="text-gray-300 text-2xl">Is this</div>
        <div className="text-white text-5xl font-bold">{pending.full_name}</div>
        <div className="grid grid-cols-2 gap-4 pt-4">
          <BigButton tone="gray" onClick={() => { setPending(null); setError(null) }}>No — again</BigButton>
          <BigButton tone="green" onClick={confirm}><CheckCircle size={26} /> Yes</BigButton>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-4 w-full">
      {collected.length > 0 && (
        <div className="text-green-300 text-lg">✓ {collected.map((c) => c.full_name).join(' · ')}</div>
      )}
      <PinEntry key={index} title={titles[index]} subtitle={subtitle} error={error} busy={busy} onSubmit={handlePin} buttonLabel="Check PIN" />
      <button type="button" onClick={onCancel} className="text-gray-400 hover:text-white text-lg px-4 py-3">Cancel</button>
    </div>
  )
}

// D-ASM-58: what a lot check approves, kept on screen beside (or above) the PIN pad for every signer. groups:
// pulledLotsByComponent(...) — null while loading. Sized so eight components fit on a tablet without scrolling.
function PulledLotsPanel({ build, groups, error, lead = 'Check the lots pulled for' }) {
  return (
    <div className="w-full md:flex-1 min-w-0 bg-gray-800 rounded-2xl border border-gray-700 p-4 self-stretch">
      <div className="text-gray-400 text-base">{lead}</div>
      <div className="text-white text-2xl font-bold leading-tight">
        {build.build_number} · <span className="font-mono">{build.part_number}</span>
        <span className="text-gray-300 font-normal"> × {Number(build.quantity).toLocaleString()}</span>
      </div>
      {error ? <div className="mt-3"><ErrorBox message={error} /></div>
        : groups === null ? <div className="text-gray-400 text-lg flex items-center gap-2 mt-3"><Loader2 className="animate-spin" /> Loading the lots…</div>
          : groups.length === 0 ? <p className="text-amber-300 text-lg mt-3">No lots are recorded for this build — do not sign; tell Jody.</p>
            : (
              <table className="w-full mt-2">
                <thead className="text-gray-400 text-sm uppercase">
                  <tr><th className="text-left font-medium py-1">Part</th><th className="text-left font-medium py-1">Lot</th><th className="text-right font-medium py-1">Qty</th></tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {groups.map((g) => (
                    <tr key={g.part} className="align-top">
                      <td className="py-1 pr-3">
                        <div className="text-white text-lg font-mono font-bold leading-tight">{g.part}</div>
                        {g.description && <div className="text-gray-400 text-sm leading-tight truncate max-w-[22rem]">{g.description}</div>}
                      </td>
                      <td className="py-1 pr-3">
                        {g.lots.map((l) => <div key={l.lot} className="text-cyan-300 text-xl font-mono font-bold leading-6">{l.lot}</div>)}
                      </td>
                      <td className="py-1 text-right">
                        {g.lots.map((l) => <div key={l.lot} className="text-white text-xl leading-6">{Number(l.qty).toLocaleString()}</div>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
    </div>
  )
}

// A full-screen number pad. decimal: allow one point (readings); counts are whole numbers.
function NumPadScreen({ title, subtitle, initial = '', decimal = false, doneLabel = 'OK', onDone, onCancel }) {
  const [value, setValue] = useState(String(initial ?? ''))
  const press = useCallback((k) => setValue((v) => appendKey(v, k, { decimal })), [decimal])
  const done = useCallback(() => { if (value !== '' && value !== '0.') onDone(value) }, [value, onDone])
  // Keyboard as on the PIN pads: digits, a decimal point where the pad has one (the number pad's decimal key may
  // send ',' in some locales), Backspace, Enter confirms, Escape clears (D-ASM-40). Attached once, reading the
  // latest values through a ref, for the reason given at PinEntry.
  const latest = useRef({ press, done, decimal })
  useLayoutEffect(() => { latest.current = { press, done, decimal } })
  useEffect(() => {
    const onKey = (e) => {
      if (keyBelongsElsewhere(e)) return
      const k = e.key === ',' ? '.' : e.key
      const now = latest.current
      if (/^[0-9]$/.test(k) || (k === '.' && now.decimal)) { e.preventDefault(); now.press(k) }
      else if (k === 'Backspace') { e.preventDefault(); setValue((v) => v.slice(0, -1)) }
      else if (k === 'Enter') { e.preventDefault(); now.done() }
      else if (k === 'Escape') { e.preventDefault(); setValue('') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', decimal ? '.' : '', '0', 'back']
  return (
    <div className="w-full max-w-md">
      <div className="text-center mb-4">
        <h2 className="text-2xl font-semibold text-white">{title}</h2>
        {subtitle && <p className="text-gray-400 text-lg mt-1">{subtitle}</p>}
      </div>
      <div className="bg-gray-800 rounded-2xl p-5 border border-gray-700">
        <div className="h-20 mb-4 rounded-xl bg-gray-900 flex items-center justify-end px-5 text-5xl font-mono text-white">
          {value || <span className="text-gray-600">0</span>}
        </div>
        <div className="grid grid-cols-3 gap-3">
          {keys.map((k, i) => k === '' ? <span key={i} /> : (
            <button
              key={i}
              type="button"
              onClick={() => (k === 'back' ? setValue((v) => v.slice(0, -1)) : press(k))}
              className="h-16 bg-gray-700 hover:bg-gray-600 text-white text-2xl font-semibold rounded-xl flex items-center justify-center"
            >
              {k === 'back' ? <Delete size={26} /> : k}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 mt-4">
          <BigButton tone="gray" onClick={onCancel}>Cancel</BigButton>
          <BigButton onClick={done} disabled={value === '' || value === '0.'}>{doneLabel}</BigButton>
        </div>
      </div>
    </div>
  )
}

function KindBadge({ build }) {
  return (
    <span className="px-3 py-1 rounded-lg bg-gray-700 text-gray-100 text-base">
      {BUILD_KIND_LABELS[build.build_kind] || build.build_kind}
    </span>
  )
}

function RunState({ build }) {
  const minutes = formatMinutes(build.minutes_total)
  if (build.status === 'in_progress' && Number(build.open_sessions) > 0) {
    return <span className="px-3 py-1 rounded-lg bg-green-600 text-white text-base font-semibold">Running · {minutes}</span>
  }
  if (build.status === 'paused' || (build.status === 'in_progress' && Number(build.open_sessions) === 0)) {
    return <span className="px-3 py-1 rounded-lg bg-amber-500 text-black text-base font-semibold">Paused · {minutes}</span>
  }
  return <span className="px-3 py-1 rounded-lg bg-gray-700 text-gray-200 text-base">{build.lots_pulled ? 'Started' : 'Not started'}</span>
}

function BuildSummary({ build }) {
  const due = formatDate(build.earliest_due)
  const wave = waveLabel(build)
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-4xl font-bold text-white">{build.part_number}</span>
        <span className="text-2xl text-gray-300">{Number(build.quantity).toLocaleString()} pcs</span>
        <span className="text-xl text-gray-500 font-mono">{build.build_number}</span>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <KindBadge build={build} />
        {build.priority && build.priority !== 'normal' && (
          <span className={`px-3 py-1 rounded-lg text-base font-semibold ${PRIORITY_CHIP[build.priority]}`}>{PRIORITY_LABEL[build.priority]}</span>
        )}
        {due && <span className="px-3 py-1 rounded-lg bg-gray-800 text-gray-200 text-base">Due {due}</span>}
        {wave && <span className="px-3 py-1 rounded-lg bg-indigo-700 text-white text-base">{wave}</span>}
        <RunState build={build} />
      </div>
    </div>
  )
}

// ── Screens ──────────────────────────────────────────────────────────────────

function DeviceNameScreen({ initial, onSave, onCancel }) {
  const [name, setName] = useState(initial || '')
  return (
    <div className="w-full max-w-md bg-gray-800 rounded-2xl p-6 border border-gray-700 space-y-4">
      <div className="flex items-center gap-3 text-white text-2xl font-semibold"><Tablet size={28} /> Name this tablet</div>
      <p className="text-gray-400 text-lg">Asked once. The name is recorded with every sign-in from this tablet.</p>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value.slice(0, 40))}
        placeholder="Assembly tablet 1"
        className="w-full px-4 py-4 rounded-xl bg-gray-900 border border-gray-700 text-white text-2xl focus:outline-none focus:border-skynet-accent"
        autoFocus
      />
      <div className="grid grid-cols-2 gap-3">
        {onCancel ? <BigButton tone="gray" onClick={onCancel}>Cancel</BigButton> : <span />}
        <BigButton onClick={() => name.trim() && onSave(name.trim())} disabled={!name.trim()}>Save</BigButton>
      </div>
    </div>
  )
}

function ChoosePinScreen({ signInPin, run, onChosen }) {
  const [first, setFirst] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const handleSecond = async (pin) => {
    if (pin !== first) { setFirst(null); setError('The two PINs did not match — start again'); return }
    setBusy(true)
    setError(null)
    try {
      const r = await run(() => changeOwnPin(pin, signInPin))
      if (!r?.ok) { setFirst(null); setError(r?.message || 'Could not save the PIN'); return }
      onChosen()
    } catch (err) {
      setFirst(null)
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return first === null ? (
    <PinEntry
      key="first"
      title="Choose your PIN"
      subtitle="Your temporary PIN was for today only. Pick 4 digits only you know."
      error={error}
      busy={busy}
      buttonLabel="Next"
      onSubmit={(p) => { setError(null); setFirst(p) }}
    />
  ) : (
    <PinEntry key="second" title="Enter it again" subtitle="The same 4 digits" error={error} busy={busy} buttonLabel="Save PIN" onSubmit={handleSecond} />
  )
}

function AvatarScreen({ operator, run, title, onSaved, onCancel }) {
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const save = async (icon, color) => {
    setBusy(true)
    setError(null)
    try {
      await run(() => setAvatar(operator.id, icon, color))
      onSaved(icon, color)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="w-full max-w-2xl bg-gray-800 rounded-2xl p-6 border border-gray-700 space-y-4">
      <h2 className="text-2xl font-semibold text-white">{title}</h2>
      <ErrorBox message={error} />
      <AvatarPicker name={operator.full_name} icon={operator.avatar_icon} color={operator.avatar_color} busy={busy} onSave={save} onCancel={onCancel} />
    </div>
  )
}

function BuildCard({ build, onOpen }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(build)}
      className={`text-left w-full rounded-2xl bg-gray-800 border border-gray-700 hover:border-gray-500 border-l-8 ${PRIORITY_BORDER[build.priority] || PRIORITY_BORDER.normal} p-5 active:scale-[0.99] transition-transform`}
    >
      <BuildSummary build={build} />
    </button>
  )
}

function BoardScreen({ builds, operator, loading, error, onOpen, onRefresh }) {
  const { mine, open } = splitBoard(builds, operator.id)
  return (
    <div className="w-full max-w-5xl space-y-8">
      <ErrorBox message={error} />
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-3xl font-bold text-white">My builds</h2>
          <button type="button" onClick={onRefresh} className="text-gray-400 hover:text-white p-3" title="Refresh">
            {loading ? <Loader2 size={26} className="animate-spin" /> : <RefreshCw size={26} />}
          </button>
        </div>
        {mine.length === 0
          ? <p className="text-gray-500 text-xl">Nothing assigned to you. Pick an open build below, or ask Jody.</p>
          : <div className="grid gap-4 lg:grid-cols-2">{mine.map((b) => <BuildCard key={b.id} build={b} onOpen={onOpen} />)}</div>}
      </section>
      <section className="space-y-3">
        <h2 className="text-3xl font-bold text-white">Open builds</h2>
        {open.length === 0
          ? <p className="text-gray-500 text-xl">No unassigned builds.</p>
          : <div className="grid gap-4 lg:grid-cols-2">{open.map((b) => <BuildCard key={b.id} build={b} onOpen={onOpen} />)}</div>}
      </section>
    </div>
  )
}

function StartScreen({ build, operator, run, onBack, onStarted }) {
  const [components, setComponents] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [picks, setPicks] = useState({})
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [secondCheck, setSecondCheck] = useState(null) // { text, error, attempt }

  useEffect(() => {
    let cancelled = false
    listComponents(build.id, build.wave_current)
      .then((rows) => { if (!cancelled) setComponents(rows) })
      .catch((err) => { if (!cancelled) setLoadError(messageOf(err)) })
    return () => { cancelled = true }
  }, [build.id, build.wave_current])

  const start = async (secondPin = null) => {
    setBusy(true)
    setError(null)
    try {
      const r = await run(() => startBuild(build.id, lotsPayload(picks), secondPin))
      if (r?.started === false) {
        setSecondCheck((sc) => ({ text: sc?.text, error: r.message || 'PIN not recognized', attempt: (sc?.attempt || 0) + 1 }))
        return
      }
      setSecondCheck(null)
      onStarted()
    } catch (err) {
      const msg = messageOf(err)
      if (!secondPin && isNewLotSet(msg)) { setSecondCheck({ text: newLotSetText(msg), error: null, attempt: 0 }); return }
      setSecondCheck(null)
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  // Only when the server asks (app_settings.assembly_lot_new_set_second_pin; off since D-ASM-58): the second person
  // sees the lots being started, as the Component check signer does.
  if (secondCheck) {
    return (
      <div className="w-full max-w-6xl flex flex-col md:flex-row md:items-start gap-6">
        <PulledLotsPanel build={build} groups={pulledLotsByComponent(lotsPayload(picks), components)} lead="Lots chosen for" />
        <div className="md:w-[26rem] shrink-0 flex flex-col items-center">
          <PeopleCheck
            key={secondCheck.attempt}
            titles={['Second person: check the pull']}
            subtitle={secondCheck.text}
            initialError={secondCheck.error}
            exclude={{ id: operator.id, message: 'The second check must be a different person' }}
            run={run}
            onDone={(people) => start(people[0].pin)}
            onCancel={() => setSecondCheck(null)}
          />
        </div>
      </div>
    )
  }

  const anyPicked = lotsPayload(picks).length > 0
  return (
    <div className="w-full max-w-5xl space-y-6">
      <button type="button" onClick={onBack} className="flex items-center gap-2 text-gray-400 hover:text-white text-xl py-2"><ArrowLeft size={24} /> Builds</button>
      <BuildSummary build={build} />
      <h3 className="text-2xl text-white font-semibold">Pull the lots — tap a tile to take it</h3>
      <ErrorBox message={loadError} />
      {components === null && !loadError && <div className="text-gray-400 text-xl flex items-center gap-2"><Loader2 className="animate-spin" /> Loading components…</div>}
      {components && components.length === 0 && (
        <ErrorBox message="No components found for this build's BOM in the Fishbowl mirror — ask Jody." />
      )}
      {components && components.map((c) => {
        const cov = coverage(picks, c)
        const lots = sortLots(c.lots)
        return (
          <div key={c.component_part_number} className="bg-gray-800 rounded-2xl border border-gray-700 p-5 space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <span className="text-2xl font-bold text-white">{c.component_part_number}</span>
                {c.part_description && <span className="text-gray-400 text-lg ml-3">{c.part_description}</span>}
              </div>
              <span className={`px-3 py-1 rounded-lg text-lg font-semibold ${cov.short === 0 ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-100'}`}>
                {cov.picked.toLocaleString()} of {cov.needed.toLocaleString()}{cov.short > 0 ? ` · ${cov.short.toLocaleString()} to go` : ' ✓'}
              </span>
            </div>
            {lots.length === 0
              ? <p className="text-amber-300 text-lg">No lot of this part is on hand in Fishbowl.</p>
              : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {lots.map((t, i) => {
                    const on = isPicked(picks, c.component_part_number, t)
                    const taken = on ? (picks[c.component_part_number] || []).find((p) => p.lot === t.lot && (p.tag_id ?? null) === (t.tag_id ?? null))?.qty : null
                    return (
                      <button
                        key={`${t.tag_id}-${t.lot}`}
                        type="button"
                        onClick={() => setPicks((p) => togglePick(p, c.component_part_number, t, c.qty_needed))}
                        className={`text-left rounded-xl p-4 border-2 transition-colors ${on ? 'border-green-400 bg-green-900/40' : 'border-gray-600 bg-gray-900 hover:border-gray-400'}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-2xl font-mono font-bold text-white">{t.lot}</span>
                          {i === 0 && <span className="text-sm px-2 py-0.5 rounded bg-sky-700 text-white">suggested</span>}
                        </div>
                        <div className="text-gray-300 text-lg mt-1">{Number(t.qty).toLocaleString()} on hand</div>
                        <div className="text-gray-500 text-base">{t.location || '—'}{formatDate(t.received) ? ` · rec'd ${formatDate(t.received)}` : ''}</div>
                        {on && <div className="text-green-300 text-lg font-semibold mt-1">Taking {Number(taken).toLocaleString()}</div>}
                      </button>
                    )
                  })}
                </div>
              )}
          </div>
        )
      })}
      <ErrorBox message={error} />
      <div className="flex justify-end">
        <BigButton tone="green" onClick={() => start(null)} disabled={busy || !anyPicked} className="min-w-64">
          {busy ? <Loader2 className="animate-spin" /> : <Play size={26} />} Start
        </BigButton>
      </div>
    </div>
  )
}

function SignFlow({ build, step, run, onDone, onCancel }) {
  const needReadings = Number(step.readings || 0)
  const [readings, setReadings] = useState(needReadings > 0 ? [] : null)
  const [collecting, setCollecting] = useState(needReadings > 0)
  const [peopleKey, setPeopleKey] = useState(0)
  const [pinError, setPinError] = useState(null)
  const [failed, setFailed] = useState(null)
  const [fatal, setFatal] = useState(null)
  const [busy, setBusy] = useState(false)
  const unit = step.unit ? ` ${step.unit}` : ''
  // D-ASM-58: a lot check (pull_check, "Component check") shows the pulled lots beside the pad for every signer,
  // and a step that must not be signed by the assembler says so in words and refuses their PIN as first signer.
  const isLotCheck = step.type === 'pull_check'
  const [distinctFrom, setDistinctFrom] = useState(null)
  const [pulled, setPulled] = useState(null)
  const [pulledError, setPulledError] = useState(null)
  useEffect(() => {
    let alive = true
    // A failed read leaves the plain wording; the server still refuses the assembler as first signer.
    stepDistinctFrom(step.step_id).then((v) => { if (alive) setDistinctFrom(v) }).catch(() => {})
    return () => { alive = false }
  }, [step.step_id])
  useEffect(() => {
    if (!isLotCheck) return undefined
    let alive = true
    Promise.all([listPulledLots(build.id, build.wave_current), listComponents(build.id, build.wave_current)])
      .then(([rows, components]) => { if (alive) setPulled(pulledLotsByComponent(rows, components)) })
      .catch((err) => { if (alive) setPulledError(messageOf(err)) })
    return () => { alive = false }
  }, [isLotCheck, build.id, build.wave_current])

  const restart = () => {
    setFailed(null)
    setPinError(null)
    setPeopleKey((k) => k + 1)
    if (needReadings > 0) { setReadings([]); setCollecting(true) }
  }

  const submit = async (pins) => {
    setBusy(true)
    try {
      const r = await run(() => signStep(build.id, step.step_id, pins, readings || []))
      if (r?.result === 'pass') { onDone(`Signed: ${step.label}`); return }
      if (r?.result === 'fail') { setFailed(r); return }
      if (r?.result === 'pin_rejected') { setPinError(r.message || 'PIN not recognized'); setPeopleKey((k) => k + 1); return }
      setFatal('Unexpected answer from the server')
    } catch (err) {
      setFatal(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  if (fatal) {
    return (
      <div className="w-full max-w-lg space-y-4">
        <ErrorBox message={fatal} />
        <BigButton tone="gray" onClick={onCancel} className="w-full">Back</BigButton>
      </div>
    )
  }
  if (failed) {
    return (
      <div className="w-full max-w-lg text-center space-y-5">
        <XCircle size={72} className="mx-auto text-red-500" />
        <div className="text-red-300 text-4xl font-bold">Below the minimum</div>
        <div className="text-gray-200 text-2xl">{step.label}</div>
        <div className="text-gray-300 text-xl">
          Lowest reading {failed.min_reading}{unit} · minimum {failed.threshold_min}{unit}
        </div>
        <div className="text-gray-500 text-lg">Recorded as failed. Re-test, or tell Jody.</div>
        <div className="grid grid-cols-2 gap-4">
          <BigButton tone="gray" onClick={() => onDone(`Failed: ${step.label}`)}>Back</BigButton>
          <BigButton tone="amber" onClick={restart}><RefreshCw size={24} /> Re-test</BigButton>
        </div>
      </div>
    )
  }
  if (collecting) {
    const i = readings.length
    const threshold = step.threshold != null ? ` · minimum ${step.threshold}${unit}` : ''
    return (
      <NumPadScreen
        key={`r${i}-${peopleKey}`}
        title={step.label}
        subtitle={`Reading ${i + 1} of ${needReadings}${step.unit ? ` (${step.unit})` : ''}${threshold}`}
        decimal
        doneLabel={i + 1 < needReadings ? 'Next' : 'Done'}
        onCancel={onCancel}
        onDone={(v) => {
          const next = [...readings, Number(v)]
          setReadings(next)
          if (next.length >= needReadings) setCollecting(false)
        }}
      />
    )
  }
  const titles = Number(step.pins) >= 2
    ? [`${step.label} — first signer`, `${step.label} — second signer`]
    : [`${step.label} — sign-off`]
  const sample = step.sample ? `Sample: ${step.sample} pieces` : null
  const readingsLine = readings && readings.length ? `Readings: ${readings.join(', ')}${unit}` : null
  const pad = (
    <div className={`flex flex-col items-center gap-3 ${isLotCheck ? 'md:w-[26rem] shrink-0' : 'w-full'}`}>
      {busy && <div className="text-gray-300 text-xl flex items-center gap-2"><Loader2 className="animate-spin" /> Signing…</div>}
      <PeopleCheck
        key={peopleKey}
        titles={titles}
        subtitle={[readingsLine, sample, signerRule(step.pins, distinctFrom)].filter(Boolean).join(' · ') || 'Enter your PIN'}
        initialError={pinError}
        exclude={distinctFrom && build.assigned_to ? { id: build.assigned_to, at: 0, message: 'The assembler cannot sign this check — someone else must' } : null}
        run={run}
        onDone={(people) => submit(people.map((p) => p.pin))}
        onCancel={onCancel}
      />
    </div>
  )
  if (!isLotCheck) return pad
  return (
    <div className="w-full max-w-6xl flex flex-col md:flex-row md:items-start gap-6">
      <PulledLotsPanel build={build} groups={pulled} error={pulledError} />
      {pad}
    </div>
  )
}

function PauseFlow({ build, run, onDone, onCancel }) {
  const [count, setCount] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const pause = async (reason) => {
    setBusy(true)
    setError(null)
    try {
      await run(() => clockOut(build.id, Number(count), reason))
      onDone(`Paused at ${Number(count).toLocaleString()} done`)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }
  if (count === null) {
    return <NumPadScreen title="Pause" subtitle={`How many are done so far? (of ${Number(build.quantity).toLocaleString()})`} doneLabel="Next" onCancel={onCancel} onDone={setCount} />
  }
  return (
    <div className="w-full max-w-lg space-y-4">
      <h2 className="text-3xl font-semibold text-white text-center">Why are you pausing?</h2>
      <p className="text-gray-400 text-xl text-center">{Number(count).toLocaleString()} done</p>
      <ErrorBox message={error} />
      <div className="grid grid-cols-2 gap-4">
        {PAUSE_REASONS.map((r) => <BigButton key={r} tone="gray" onClick={() => pause(r)} disabled={busy}>{r}</BigButton>)}
      </div>
      <BigButton tone="amber" onClick={() => pause(null)} disabled={busy} className="w-full">
        {busy ? <Loader2 className="animate-spin" /> : <Pause size={24} />} Pause without a reason
      </BigButton>
      <button type="button" onClick={onCancel} className="w-full text-gray-400 hover:text-white text-lg py-3">Cancel</button>
    </div>
  )
}

function CloseoutFlow({ build, run, onClosed, onCancel }) {
  const [good, setGood] = useState(String(build.quantity))
  const [bad, setBad] = useState('0')
  const [editing, setEditing] = useState(null)
  const [inspector, setInspector] = useState(null) // { attempt, error }
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const insp = inspectorStep(build.steps)

  const submit = async (inspectorPin = null) => {
    setBusy(true)
    setError(null)
    try {
      const r = await run(() => closeoutBuild(build.id, Number(good), Number(bad), inspectorPin))
      if (r?.closed === false) {
        setInspector((s) => ({ attempt: (s?.attempt || 0) + 1, error: r.message || 'PIN not recognized' }))
        return
      }
      onClosed(r, { good: Number(good), bad: Number(bad) })
    } catch (err) {
      setInspector(null)
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <NumPadScreen
        title={editing === 'good' ? 'Good pieces' : 'Bad pieces'}
        subtitle={`Build quantity ${Number(build.quantity).toLocaleString()}`}
        initial=""
        onCancel={() => setEditing(null)}
        onDone={(v) => { if (editing === 'good') setGood(String(Number(v))); else setBad(String(Number(v))); setEditing(null) }}
      />
    )
  }
  if (inspector) {
    return (
      <PeopleCheck
        key={inspector.attempt}
        titles={[`Inspector — ${insp?.label || 'inspection'}`]}
        subtitle={`${Number(good).toLocaleString()} good · ${Number(bad).toLocaleString()} bad`}
        initialError={inspector.error}
        run={run}
        onDone={(people) => submit(people[0].pin)}
        onCancel={() => setInspector(null)}
      />
    )
  }
  const total = Number(good) + Number(bad)
  return (
    <div className="w-full max-w-xl space-y-5">
      <h2 className="text-3xl font-semibold text-white">Close out {build.build_number}</h2>
      {waveLabel(build) && <div className="text-indigo-300 text-xl">{waveLabel(build)}</div>}
      <div className="grid grid-cols-2 gap-4">
        <button type="button" onClick={() => setEditing('good')} className="rounded-2xl bg-gray-800 border-2 border-green-600 p-5 text-left">
          <div className="text-green-300 text-xl">Good</div>
          <div className="text-white text-5xl font-bold font-mono">{Number(good).toLocaleString()}</div>
        </button>
        <button type="button" onClick={() => setEditing('bad')} className="rounded-2xl bg-gray-800 border-2 border-red-600 p-5 text-left">
          <div className="text-red-300 text-xl">Bad</div>
          <div className="text-white text-5xl font-bold font-mono">{Number(bad).toLocaleString()}</div>
        </button>
      </div>
      {total > Number(build.quantity) && <div className="text-amber-300 text-lg">Good + bad is more than the build quantity ({Number(build.quantity).toLocaleString()}).</div>}
      {insp && <div className="text-gray-300 text-lg flex items-center gap-2"><Info size={20} /> An inspector signs “{insp.label}” with their PIN.</div>}
      <ErrorBox message={error} />
      <div className="grid grid-cols-2 gap-4">
        <BigButton tone="gray" onClick={onCancel}>Cancel</BigButton>
        <BigButton tone="green" onClick={() => (insp ? setInspector({ attempt: 0, error: null }) : submit(null))} disabled={busy || total === 0}>
          {busy ? <Loader2 className="animate-spin" /> : <ClipboardCheck size={26} />} Close out
        </BigButton>
      </div>
    </div>
  )
}

function StepRow({ step, onSign }) {
  const sign = isSignStep(step)
  const pass = step.signed && step.result === 'pass'
  const fail = step.signed && step.result === 'fail'
  return (
    <div className={`rounded-2xl border p-4 flex items-center gap-4 ${pass ? 'border-green-700 bg-green-900/20' : fail ? 'border-red-700 bg-red-900/20' : 'border-gray-700 bg-gray-800'}`}>
      <div className="text-2xl font-mono text-gray-500 w-8 text-center">{step.order}</div>
      <div className="flex-1">
        <div className="text-2xl text-white">{step.label}</div>
        <div className="text-gray-400 text-base">
          {STEP_TYPE_LABELS[step.type] || step.type}
          {Number(step.readings) > 0 && ` · ${step.readings} reading(s)${step.unit ? ` in ${step.unit}` : ''}${step.threshold != null ? `, minimum ${step.threshold}` : ''}`}
          {step.sample ? ` · sample ${step.sample}` : ''}
          {sign && ` · ${step.pins} PIN${Number(step.pins) > 1 ? 's' : ''}`}
        </div>
        {step.text && <div className="text-amber-200 text-lg mt-1">{step.text}</div>}
        {step.type === 'release' && <div className="text-gray-500 text-base mt-1">Jody releases the build after closeout.</div>}
      </div>
      {pass && <span className="flex items-center gap-2 text-green-300 text-xl"><CheckCircle size={28} /> Signed</span>}
      {fail && <span className="flex items-center gap-2 text-red-300 text-xl"><XCircle size={28} /> Failed</span>}
      {sign && !pass && (
        <BigButton tone={fail ? 'amber' : 'primary'} onClick={() => onSign(step)} className="min-w-36">{fail ? 'Re-test' : 'Sign'}</BigButton>
      )}
    </div>
  )
}

function WorkScreen({ build, operator, run, reload, onBack, onClosed }) {
  const [mine, setMine] = useState(undefined)
  const [mode, setMode] = useState(null) // null | { type: 'sign', step } | { type: 'pause' } | { type: 'closeout' }
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)

  const refreshMine = useCallback(async () => {
    try { setMine(await myOpenSession(build.id, operator.id)) } catch { setMine(null) }
  }, [build.id, operator.id])
  useEffect(() => { refreshMine() }, [refreshMine, build.status, build.open_sessions])

  const back = async (message) => {
    setMode(null)
    setNotice(message || null)
    await reload()
    await refreshMine()
  }

  const resume = async () => {
    setBusy(true)
    setError(null)
    try {
      await run(() => clockIn(build.id))
      await back('Resumed')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  if (mode?.type === 'sign') {
    return <SignFlow build={build} step={mode.step} run={run} onDone={back} onCancel={() => setMode(null)} />
  }
  if (mode?.type === 'pause') {
    return <PauseFlow build={build} run={run} onDone={back} onCancel={() => setMode(null)} />
  }
  if (mode?.type === 'closeout') {
    return <CloseoutFlow build={build} run={run} onClosed={onClosed} onCancel={() => setMode(null)} />
  }

  const running = !!mine
  return (
    <div className="w-full max-w-5xl space-y-5">
      <button type="button" onClick={onBack} className="flex items-center gap-2 text-gray-400 hover:text-white text-xl py-2"><ArrowLeft size={24} /> Builds</button>
      <BuildSummary build={build} />
      {notice && <div className="rounded-xl bg-green-900/40 border border-green-700 text-green-100 text-lg px-4 py-3">{notice}</div>}
      <ErrorBox message={error} />
      <div className="grid grid-cols-2 gap-4">
        {mine === undefined
          ? <BigButton tone="gray" disabled><Loader2 className="animate-spin" /></BigButton>
          : running
            ? <BigButton tone="amber" onClick={() => setMode({ type: 'pause' })}><Pause size={26} /> Pause</BigButton>
            : <BigButton tone="green" onClick={resume} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Play size={26} />} Resume</BigButton>}
        <BigButton onClick={() => setMode({ type: 'closeout' })}><ClipboardCheck size={26} /> Closeout</BigButton>
      </div>
      <div className="space-y-3">
        <h3 className="text-2xl text-white font-semibold">Checklist</h3>
        {(build.steps || []).length === 0 && (
          <p className="text-amber-200 text-xl bg-amber-950/40 border border-amber-800 rounded-xl px-4 py-3">
            No checklist — this build has no steps to sign. Tell Jody before you go on.
          </p>
        )}
        {(build.steps || []).map((s) => <StepRow key={s.step_id} step={s} onSign={(step) => setMode({ type: 'sign', step })} />)}
      </div>
    </div>
  )
}

function DoneScreen({ done, lotPrefix, onBack }) {
  const { result, build, counts } = done
  const waveOne = result?.closed_wave === 1
  return (
    <div className="w-full max-w-xl text-center space-y-5">
      <CheckCircle size={80} className="mx-auto text-green-400" />
      {waveOne ? (
        <>
          <div className="text-white text-4xl font-bold">Wave 1 closed — dry film and bake next</div>
          <div className="text-gray-300 text-2xl">{build.part_number} · {build.build_number}</div>
        </>
      ) : (
        <>
          <div className="text-gray-400 text-2xl">{build.part_number} · {build.build_number}</div>
          {result?.lot
            ? <div className="text-white text-6xl font-bold font-mono">{lotPrefix}{result.lot}</div>
            : <div className="text-white text-3xl font-semibold">Logged to the program lot</div>}
        </>
      )}
      <div className="flex justify-center gap-8 text-2xl">
        <span className="text-green-300">{Number(result?.good ?? counts.good).toLocaleString()} good</span>
        <span className="text-red-300">{Number(result?.bad ?? counts.bad).toLocaleString()} bad</span>
        {result?.minutes != null && <span className="text-gray-300">{formatMinutes(result.minutes)}</span>}
      </div>
      <BigButton onClick={onBack} className="w-full">Back to my builds</BigButton>
    </div>
  )
}

// ── The kiosk ────────────────────────────────────────────────────────────────

function AssemblyKioskApp() {
  const [deviceName, setDeviceName] = useState(readDeviceName())
  const deviceIdRef = useRef(getKioskDeviceId())
  const [renaming, setRenaming] = useState(false)
  const [operator, setOperator] = useState(null)
  const [authError, setAuthError] = useState(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [screen, setScreen] = useState('board') // choose_pin | avatar | board | build | me | done
  const [builds, setBuilds] = useState([])
  const [buildsError, setBuildsError] = useState(null)
  const [loadingBuilds, setLoadingBuilds] = useState(false)
  const [buildId, setBuildId] = useState(null)
  const [detail, setDetail] = useState(null) // the open build with its checklist, or null once it has left the list
  const [detailState, setDetailState] = useState({ loading: false, error: null })
  const [done, setDone] = useState(null)
  const [lotPrefix, setLotPrefix] = useState('')
  const [inFlight, setInFlight] = useState(0)
  const [lastActivity, setLastActivity] = useState(Date.now())
  const signInPinRef = useRef(null) // kept only while a temporary PIN must be replaced
  const tokenExpRef = useRef(null)

  useEffect(() => {
    document.title = 'Assembly Kiosk'
    return () => { document.title = 'SkyNet MES' }
  }, [])

  // Every server call goes through run(): while one is in flight the inactivity sign-out waits.
  const run = useCallback(async (fn) => {
    setInFlight((n) => n + 1)
    try { return await fn() } finally { setInFlight((n) => n - 1); setLastActivity(Date.now()) }
  }, [])

  const handleSignOut = useCallback(async () => {
    signInPinRef.current = null
    tokenExpRef.current = null
    try { await supabase.auth.signOut({ scope: 'local' }) } catch { /* already gone */ }
    setOperator(null)
    setBuilds([])
    setBuildId(null)
    setDetail(null)
    setDone(null)
    setScreen('board')
  }, [])

  const handleSignIn = async (pin) => {
    setAuthBusy(true)
    setAuthError(null)
    try {
      // A sign-in always starts fresh: a reload mid-shift leaves the last assembler's token in storage, and a
      // kiosk-only token (role kiosk_assembler, D-ASM-50) cannot read machines. Dropping it first lets the anchor
      // lookup below run with the public key, as on a clean tablet.
      const { data: { session: leftover } } = await supabase.auth.getSession()
      if (leftover) await supabase.auth.signOut({ scope: 'local' })

      // kiosk-authenticate needs an active machine as an anchor but binds nothing to it (D-KSTC-09).
      const { data: anchor } = await supabase
        .from('machines').select('id').eq('is_active', true).eq('is_commissioned', true)
        .order('display_order').limit(1)
      const anchorId = anchor?.[0]?.id
      if (!anchorId) { setAuthError('No active machine available'); return }

      const { data, error } = await supabase.functions.invoke('kiosk-authenticate', {
        body: { pin, machine_id: anchorId, device_id: `${deviceName} · ${deviceIdRef.current}`, kiosk: 'assembly' }, // D-ASM-49
      })
      if (error || !data?.success) { setAuthError((await kioskAuthLockedMessage(error)) || 'Invalid PIN'); return }
      const op = data.operator
      if (!isAssemblyOperator(op)) { setAuthError('This tablet is for the assembly team'); return }

      const { error: sessionErr } = await supabase.auth.setSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      })
      if (sessionErr) { setAuthError('Authentication failed'); return }
      // Placeholder refresh token — re-PIN at expiry, never auto-refresh.
      supabase.auth.stopAutoRefresh()
      tokenExpRef.current = data.expires_at ?? null
      signInPinRef.current = op.must_change_pin ? pin : null

      setOperator(op)
      setLastActivity(Date.now())
      setScreen(op.must_change_pin ? 'choose_pin' : (!op.avatar_icon ? 'avatar' : 'board'))
    } catch (err) {
      console.error('Assembly kiosk sign-in failed:', err)
      setAuthError('Authentication failed')
    } finally {
      setAuthBusy(false)
    }
  }

  const loadBuilds = useCallback(async () => {
    setLoadingBuilds(true)
    try {
      setBuilds(await listKioskBuilds())
      setBuildsError(null)
    } catch (err) {
      setBuildsError(messageOf(err))
    } finally {
      setLoadingBuilds(false)
    }
  }, [])

  useEffect(() => {
    if (!operator) return
    loadBuilds()
    lotPrefixDisplay().then(setLotPrefix).catch(() => setLotPrefix(''))
  }, [operator, loadBuilds])

  // The board refreshes itself every 30 s while it is on screen.
  useEffect(() => {
    if (!operator || screen !== 'board') return
    const t = setInterval(loadBuilds, 30000)
    return () => clearInterval(t)
  }, [operator, screen, loadBuilds])

  // Any touch keeps the tablet signed in mid-task.
  useEffect(() => {
    if (!operator) return
    const bump = () => setLastActivity(Date.now())
    const events = ['mousedown', 'keydown', 'touchstart', 'pointerdown']
    events.forEach((e) => window.addEventListener(e, bump))
    return () => events.forEach((e) => window.removeEventListener(e, bump))
  }, [operator])

  // Sign out after 2 idle minutes (never mid-call), and a minute before the 8-hour token ends.
  useEffect(() => {
    if (!operator) return
    const t = setInterval(() => {
      const exp = tokenExpRef.current
      if (exp && Date.now() >= exp * 1000 - 60 * 1000) { handleSignOut(); return }
      if (inFlight === 0 && Date.now() - lastActivity > INACTIVITY_TIMEOUT) handleSignOut()
    }, 15000)
    return () => clearInterval(t)
  }, [operator, lastActivity, inFlight, handleSignOut])

  const loadDetail = useCallback(async (id) => {
    setDetailState({ loading: true, error: null })
    try {
      setDetail(await getKioskBuild(id))
      setDetailState({ loading: false, error: null })
    } catch (err) {
      setDetail(null)
      setDetailState({ loading: false, error: messageOf(err) })
    }
  }, [])
  const reloadBuild = useCallback(async () => {
    await Promise.all([buildId ? loadDetail(buildId) : null, loadBuilds()])
  }, [buildId, loadDetail, loadBuilds])

  const openBuild = (b) => { setBuildId(b.id); setDetail(null); setScreen('build'); loadDetail(b.id) }
  const toBoard = () => { setBuildId(null); setDetail(null); setScreen('board'); loadBuilds() }
  const build = detail && detail.id === buildId ? detail : null

  // ── Before sign-in ──
  if (!deviceName || renaming) {
    return (
      <Shell>
        <DeviceNameScreen
          initial={deviceName}
          onSave={(name) => { writeDeviceName(name); setDeviceName(name); setRenaming(false) }}
          onCancel={deviceName ? () => setRenaming(false) : null}
        />
      </Shell>
    )
  }
  // Same page, header and footer as the machine kiosk's PIN screen (Kiosk.jsx, RENDER: PIN Login); the pad is the
  // direct child of the full-width centring container, so it takes its full max-w-sm. The tablet's name sits where
  // the machine kiosk shows the location, and tapping it renames the tablet.
  if (!operator) {
    return (
      <div className="min-h-screen bg-skynet-dark flex flex-col">
        <header className="bg-gray-900 border-b border-gray-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-2xl font-bold text-white">SkyNet</span>
              <div className="w-2 h-2 bg-skynet-green rounded-full animate-pulse"></div>
            </div>
            <div className="text-right">
              <p className="text-white font-semibold">Assembly</p>
              <button type="button" onClick={() => setRenaming(true)} title="Rename this tablet" className="text-gray-500 hover:text-gray-300 text-sm">
                {deviceName}
              </button>
            </div>
          </div>
        </header>

        <div className="flex-1 flex items-center justify-center p-4">
          <PinEntry
            icon={<Wrench className="w-10 h-10 text-skynet-accent mx-auto mb-3" />}
            title="Assembler Login"
            subtitle="Enter your PIN to continue"
            error={authError}
            busy={authBusy}
            buttonLabel="Login"
            onSubmit={handleSignIn}
          />
        </div>

        <footer className="bg-gray-900 border-t border-gray-800 px-6 py-3">
          <p className="text-gray-600 text-xs text-center font-mono">SkyNet MES - Assembly Kiosk</p>
        </footer>
      </div>
    )
  }

  // ── Signed in ──
  let body
  if (screen === 'choose_pin') {
    body = (
      <ChoosePinScreen
        signInPin={signInPinRef.current}
        run={run}
        onChosen={() => {
          signInPinRef.current = null
          setOperator((op) => ({ ...op, must_change_pin: false }))
          setScreen(operator.avatar_icon ? 'board' : 'avatar')
        }}
      />
    )
  } else if (screen === 'avatar' || screen === 'me') {
    body = (
      <AvatarScreen
        operator={operator}
        run={run}
        title={screen === 'avatar' ? 'Pick your icon and colour' : 'Change your icon and colour'}
        onSaved={(icon, color) => { setOperator((op) => ({ ...op, avatar_icon: icon, avatar_color: color })); toBoard() }}
        onCancel={toBoard}
      />
    )
  } else if (screen === 'done' && done) {
    body = <DoneScreen done={done} lotPrefix={lotPrefix} onBack={() => { setDone(null); toBoard() }} />
  } else if (screen === 'build') {
    body = !build ? (
      <div className="w-full max-w-lg space-y-4 text-center">
        {detailState.loading
          ? <Loader2 size={40} className="animate-spin mx-auto text-gray-400" />
          : detailState.error
            ? <ErrorBox message={detailState.error} />
            : <p className="text-gray-300 text-2xl">This build is no longer open.</p>}
        <BigButton tone="gray" onClick={toBoard} className="w-full">Back to builds</BigButton>
      </div>
    ) : build.lots_pulled ? (
      <WorkScreen
        key={build.id}
        build={build}
        operator={operator}
        run={run}
        reload={reloadBuild}
        onBack={toBoard}
        onClosed={(result, counts) => { setDone({ result, build, counts }); setScreen('done'); loadBuilds() }}
      />
    ) : (
      <StartScreen key={build.id} build={build} operator={operator} run={run} onBack={toBoard} onStarted={reloadBuild} />
    )
  } else {
    body = <BoardScreen builds={builds} operator={operator} loading={loadingBuilds} error={buildsError} onOpen={openBuild} onRefresh={loadBuilds} />
  }

  const setupScreen = screen === 'choose_pin'
  return (
    <div className="min-h-screen bg-skynet-dark flex flex-col">
      <header className="flex items-center justify-between gap-4 px-5 py-3 bg-gray-900 border-b border-gray-800">
        <div className="flex items-center gap-3 min-w-0">
          <Avatar icon={operator.avatar_icon} color={operator.avatar_color} name={operator.full_name} size={48} />
          <div className="min-w-0">
            <div className="text-white text-2xl font-semibold truncate">{operator.full_name}</div>
            <div className="text-gray-500 text-sm flex items-center gap-1"><Tablet size={14} /> {deviceName}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!setupScreen && (
            <>
              <button type="button" onClick={toBoard} className="px-4 py-3 rounded-xl bg-gray-800 hover:bg-gray-700 text-white text-lg">My builds</button>
              <button type="button" onClick={() => setScreen('me')} className="px-4 py-3 rounded-xl bg-gray-800 hover:bg-gray-700 text-white text-lg">Me</button>
            </>
          )}
          <button type="button" onClick={handleSignOut} className="px-4 py-3 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-lg flex items-center gap-2">
            <LogOut size={20} /> Sign out
          </button>
        </div>
      </header>
      <main className="flex-1 flex justify-center items-start p-5 sm:p-8">{body}</main>
    </div>
  )
}

function Shell({ children }) {
  return <div className="min-h-screen bg-skynet-dark flex items-center justify-center p-6">{children}</div>
}

export default function AssemblyKiosk() {
  if (!FEATURES.ASSEMBLY_KIOSK) {
    return <Shell><p className="text-gray-400 text-xl">The assembly kiosk is not switched on.</p></Shell>
  }
  return <AssemblyKioskApp />
}
