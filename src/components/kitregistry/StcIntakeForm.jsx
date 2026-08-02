import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Upload, Loader2, X, CheckCircle, AlertTriangle, Paperclip, Sparkles, RotateCcw,
} from 'lucide-react'
import { todayLocal, FIELD_DEBOUNCE, formatLogDate, lotLabel } from '../../lib/kitRegistry'
import {
  CHANNELS, DOCUMENT_TYPES, createStcRequest, attachRequestDocuments, invokeStcExtract,
  matchClaimedKit, matchAircraftClaim, matchCompany,
  REQUIRED_FIELDS, validateIntakeFields, kitMismatchLabel,
} from '../../lib/stcIntake'
import { ACCEPT_ATTR, buildIntakePayload } from '../../lib/emailIntake'
import { Pill, SourceBadge } from './ui'
import StcFindKit from './StcFindKit'

// One form, two entrances (D-KSTC-18): drop the customer's email and the AI
// pre-fills it, or type it straight in. The two are the SAME form — extraction
// failing, being slow, or being switched off changes nothing except that the
// fields start empty. The AI never writes; this screen's Save is the only write,
// and the person who pressed it is the author of record.
//
// Step 1 (find the kit, D-KSTC-19) gates all of it: neither the dropzone nor the
// fields render until a kit log entry is linked or the escape path is taken with
// a reason. Form state lives here rather than in the step-1 component, so
// "Change" can go back to the search without losing typed work or uploads.

// The mandatory-field rules themselves live in lib/stcIntake.js next to the RPC
// wrapper whose messages they mirror (D-KSTC-19). This component owns only how
// they are shown and which field gets focused.

// AI envelope key → form field. Anything outside this map is ignored.
const FIELD_MAP = {
  received_date: 'receivedDate',
  requester_name: 'requesterName',
  requester_company: 'requesterCompany',
  requester_email: 'requesterEmail',
  claimed_kit_number: 'claimedKitNumber',
  claimed_kit_part: 'claimedKitPart',
  claimed_aircraft_serial: 'claimedAircraftSerial',
  claimed_registration: 'claimedRegistration',
  claimed_order_number: 'claimedOrderNumber',
  purchased_from: 'purchasedFrom',
}

const BLANK = {
  receivedDate: '',
  channel: 'email',
  requesterName: '',
  requesterCompany: '',
  requesterEmail: '',
  claimedKitNumber: '',
  claimedKitPart: '',
  claimedAircraftSerial: '',
  claimedRegistration: '',
  claimedOrderNumber: '',
  purchasedFrom: '',
  notes: '',
}

const CONFIDENCE_TONE = { high: 'green', medium: 'amber', low: 'gray' }
const CONFIDENCE_LABEL = { high: 'AI · high', medium: 'AI · med', low: 'AI · low' }

export default function StcIntakeForm({ profile, onCancel, onCreated }) {
  // Manual entry starts on today's date; an extraction overwrites it with the
  // date the customer actually sent the message (or clears it, so nobody
  // accidentally files a two-week-old email as arriving today).
  // form and payload are mirrored into refs because the async ingest path has to
  // read the CURRENT values (what has the user typed already? what files are
  // held?) from inside a promise. Every update goes through the two commit
  // helpers below, so the ref and the state can't drift.
  const formRef = useRef({ ...BLANK, receivedDate: todayLocal() })
  const [form, setForm] = useState(formRef.current)
  const [confidence, setConfidence] = useState({})   // form field → high/medium/low
  const [aiFilled, setAiFilled] = useState({})       // form field → true
  const [banner, setBanner] = useState(false)

  const payloadRef = useRef({ blocks: [], holdings: [], unreadable: [], errors: [] })
  const [payload, setPayload] = useState(payloadRef.current)
  const [reading, setReading] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [extractError, setExtractError] = useState(null)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef(null)

  const [hints, setHints] = useState({ kit: null, aircraft: null, company: null })

  // null until step 1 resolves; then { lot } or { unlinkedReason }.
  const [kitChoice, setKitChoice] = useState(null)

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})

  // Focus targets for the first invalid field, in visual order (the A.5 rule:
  // never just colour a field red somewhere off-screen).
  const refs = {
    receivedDate: useRef(null),
    requesterName: useRef(null),
    requesterCompany: useRef(null),
    claimedKitNumber: useRef(null),
    claimedKitPart: useRef(null),
    claimedAircraftSerial: useRef(null),
    claimedRegistration: useRef(null),
    claimedOrderNumber: useRef(null),
  }
  // Set once the request row exists. From here on the intake number is real and
  // cancelling would abandon files, so the screen switches to a repair view.
  const [created, setCreated] = useState(null)  // { requestId, intakeNumber, failures, linkLabel }

  const linkedLot = kitChoice?.lot || null
  const kitMismatch = kitMismatchLabel(form.claimedKitNumber, linkedLot)

  const commitForm = useCallback((next) => {
    formRef.current = next
    setForm(next)
  }, [])

  const commitPayload = useCallback((next) => {
    payloadRef.current = next
    setPayload(next)
  }, [])

  const set = (key, value) => {
    commitForm({ ...formRef.current, [key]: value })
    // Editing a suggested field retires its chip — the value is the human's now.
    setAiFilled(prev => (prev[key] ? { ...prev, [key]: false } : prev))
    setFieldErrors(prev => (prev[key] ? { ...prev, [key]: undefined } : prev))
  }

  // ---------- Files + extraction -------------------------------------------

  const ingest = useCallback(async (files) => {
    const list = [...(files || [])]
    if (!list.length) return

    setReading(true)
    setExtractError(null)
    let merged
    try {
      const fresh = await buildIntakePayload(list)
      const prev = payloadRef.current
      merged = {
        blocks: [...prev.blocks, ...fresh.blocks],
        holdings: [...prev.holdings, ...fresh.holdings],
        unreadable: [...prev.unreadable, ...fresh.unreadable],
        errors: [...prev.errors, ...fresh.errors],
      }
      commitPayload(merged)
    } catch (err) {
      console.error('Reading the dropped files failed:', err)
      setExtractError('Those files could not be read — fill the form in manually.')
      setReading(false)
      return
    }
    setReading(false)

    if (!merged.blocks.length) return

    setExtracting(true)
    try {
      const fields = await invokeStcExtract(merged.blocks)

      // Only EMPTY fields are pre-filled. Anything already typed is the human's
      // work and outranks a suggestion.
      const prev = formRef.current
      const next = { ...prev }
      const filled = {}
      const conf = {}
      for (const [aiKey, formKey] of Object.entries(FIELD_MAP)) {
        const value = fields[aiKey]
        if (formKey === 'receivedDate') {
          // The date is the one field a suggestion may CLEAR: a manual default
          // of "today" is wrong the moment we know the email is from a
          // different day, and blank forces the reviewer to look.
          next.receivedDate = value || ''
          if (value) { filled.receivedDate = true; conf.receivedDate = fields.confidence?.[aiKey] || 'low' }
          continue
        }
        if (!value || String(prev[formKey] || '').trim()) continue
        next[formKey] = value
        filled[formKey] = true
        conf[formKey] = fields.confidence?.[aiKey] || 'low'
      }
      if (fields.summary && !String(prev.notes || '').trim()) {
        next.notes = fields.summary
        filled.notes = true
      }
      commitForm(next)
      setAiFilled(filled)
      setConfidence(conf)
      setBanner(true)
    } catch (err) {
      console.error('STC extraction failed:', err)
      // Never blocking, never fatal — the form below is already usable.
      setExtractError('Extraction unavailable — fill in manually.')
    } finally {
      setExtracting(false)
    }
  }, [commitForm, commitPayload])

  const removeHolding = (key) => {
    const prev = payloadRef.current
    const dropped = new Set(
      prev.holdings.filter(h => h.key === key || h.parentKey === key).map(h => h.key),
    )
    commitPayload({
      ...prev,
      holdings: prev.holdings.filter(h => !dropped.has(h.key)),
      blocks: prev.blocks.filter(b => !dropped.has(b.holdingKey)),
    })
  }

  const setHoldingType = (key, documentType) => {
    const prev = payloadRef.current
    commitPayload({
      ...prev,
      holdings: prev.holdings.map(h => (h.key === key ? { ...h, documentType } : h)),
    })
  }

  // ---------- Live match hints ---------------------------------------------
  // Informational only. Nothing here is written; resolution is Round C2.

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const kit = await matchClaimedKit(form.claimedKitNumber)
        if (!cancelled) setHints(prev => ({ ...prev, kit }))
      } catch (err) {
        console.error('Kit-number hint failed:', err)
        if (!cancelled) setHints(prev => ({ ...prev, kit: null }))
      }
    }, FIELD_DEBOUNCE)
    return () => { cancelled = true; clearTimeout(t) }
  }, [form.claimedKitNumber])

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const aircraft = await matchAircraftClaim({
          serial: form.claimedAircraftSerial, registration: form.claimedRegistration,
        })
        if (!cancelled) setHints(prev => ({ ...prev, aircraft }))
      } catch (err) {
        console.error('Aircraft hint failed:', err)
        if (!cancelled) setHints(prev => ({ ...prev, aircraft: null }))
      }
    }, FIELD_DEBOUNCE)
    return () => { cancelled = true; clearTimeout(t) }
  }, [form.claimedAircraftSerial, form.claimedRegistration])

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const company = await matchCompany(form.requesterCompany)
        if (!cancelled) setHints(prev => ({ ...prev, company }))
      } catch (err) {
        console.error('Company hint failed:', err)
        if (!cancelled) setHints(prev => ({ ...prev, company: null }))
      }
    }, FIELD_DEBOUNCE)
    return () => { cancelled = true; clearTimeout(t) }
  }, [form.requesterCompany])

  // ---------- Save ----------------------------------------------------------

  const runAttachments = async (requestId, holdings) => {
    const { failures } = await attachRequestDocuments(requestId, holdings, profile?.id || null)
    return failures
  }

  // REQUIRED_FIELDS is already in screen order, so it doubles as the focus
  // order — the operator is sent to the topmost blank field, not an arbitrary one.
  const focusFirstInvalid = (errors) => {
    for (const [key] of REQUIRED_FIELDS) {
      if (errors[key] && refs[key]?.current) {
        refs[key].current.focus({ preventScroll: true })
        refs[key].current.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return
      }
    }
  }

  const handleSave = async () => {
    const errors = validateIntakeFields(form)
    setFieldErrors(errors)
    if (Object.keys(errors).length) {
      setSaveError(null)
      focusFirstInvalid(errors)
      return
    }

    setSaving(true)
    setSaveError(null)
    try {
      // The escape reason is prepended to Notes so the exception queue carries
      // the explanation with it — the reason is the point of the escape hatch,
      // not a checkbox on the way past it.
      const typed = String(form.notes || '').trim()
      const notes = kitChoice?.unlinkedReason
        ? `Logged without linked kit: ${kitChoice.unlinkedReason}${typed ? `\n\n${typed}` : ''}`
        : typed

      const { requestId, intakeNumber } = await createStcRequest({
        ...form, notes, kitLotId: linkedLot?.id || null,
      })
      const linkLabel = linkedLot ? lotLabel(linkedLot) : null
      const failures = await runAttachments(requestId, payload.holdings)
      if (failures.length) {
        setCreated({ requestId, intakeNumber, failures, linkLabel })
        return
      }
      onCreated({ intakeNumber, linkLabel })
    } catch (err) {
      // Backstop: the RPC enforces the same rules, so anything that reaches here
      // (stale tab, a rule the form doesn't know) shows its own message.
      console.error('Creating the STC request failed:', err)
      setSaveError(err.message || 'Could not create this intake.')
    } finally {
      setSaving(false)
    }
  }

  const retryFailed = async () => {
    if (!created) return
    setSaving(true)
    try {
      const stillWanted = new Set(created.failures.map(f => f.key))
      const failures = await runAttachments(
        created.requestId,
        payload.holdings.filter(h => stillWanted.has(h.key)),
      )
      if (!failures.length) {
        onCreated({ intakeNumber: created.intakeNumber, linkLabel: created.linkLabel })
        return
      }
      setCreated(prev => ({ ...prev, failures }))
    } finally {
      setSaving(false)
    }
  }

  // ---------- Post-save repair ----------------------------------------------
  // The request row exists and holds its intake number; only some files are
  // missing. Never silently dropped — the operator either retries or leaves
  // knowing exactly which files did not attach.

  if (created) {
    return (
      <div className="p-5 max-w-3xl mx-auto">
        <div className="bg-amber-900/25 border border-amber-600 rounded-xl p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={22} className="text-amber-400 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-white font-semibold">
                Intake #{created.intakeNumber} created — {created.failures.length} file
                {created.failures.length === 1 ? '' : 's'} did not attach
              </p>
              <p className="text-amber-200/80 text-sm mt-1">
                The request is saved. These files are still only on this screen:
              </p>
              <ul className="mt-3 space-y-1">
                {created.failures.map(f => (
                  <li key={f.key} className="text-sm text-amber-100">
                    <span className="font-medium">{f.name}</span>
                    <span className="text-amber-300/70"> — {f.message}</span>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-3 mt-4">
                <button
                  onClick={retryFailed}
                  disabled={saving}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-skynet-accent hover:bg-blue-600 disabled:bg-gray-700 text-white text-sm font-medium"
                >
                  {saving ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
                  Retry these files
                </button>
                <button
                  onClick={() => onCreated({ intakeNumber: created.intakeNumber, linkLabel: created.linkLabel })}
                  disabled={saving}
                  className="px-4 py-2.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm font-medium"
                >
                  Continue without them
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ---------- Step 1 gate ---------------------------------------------------
  // Nothing below renders until the kit is found or the escape is taken. Sending
  // someone to the paperwork first is exactly how requests end up unlinked.

  if (!kitChoice) {
    return (
      <StcFindKit
        onSelect={lot => setKitChoice({ lot })}
        onSkip={reason => setKitChoice({ unlinkedReason: reason })}
        onCancel={onCancel}
      />
    )
  }

  // ---------- Step 2: form --------------------------------------------------

  const busy = reading || extracting

  return (
    <div className="p-5 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-white text-lg font-semibold">New STC request</h2>
        <button onClick={onCancel} className="text-gray-400 hover:text-white text-sm">
          Back to worklist
        </button>
      </div>

      {/* ---- Pinned kit card: what this request is about, all the way down ---- */}
      {linkedLot ? (
        <div className="mb-5 rounded-xl border border-skynet-accent/60 bg-skynet-accent/10 p-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="font-mono font-bold text-white text-xl">{lotLabel(linkedLot)}</span>
                <SourceBadge source={linkedLot.source} />
              </div>
              <p className="text-gray-200 text-sm mt-1.5">
                {linkedLot.kit_part_as_written || '—'}
                {linkedLot.sku?.description ? <span className="text-gray-400"> · {linkedLot.sku.description}</span> : null}
              </p>
              <p className="text-gray-400 text-xs mt-1">
                {linkedLot.customer_as_written || linkedLot.party?.name || '—'}
                {linkedLot.so_as_written ? ` · SO ${linkedLot.so_as_written}` : ''}
                {` · logged ${formatLogDate(linkedLot.log_date)}`}
              </p>
            </div>
            <button
              onClick={() => setKitChoice(null)}
              className="text-skynet-accent hover:underline text-sm shrink-0"
            >
              Change
            </button>
          </div>
        </div>
      ) : (
        <div className="mb-5 rounded-xl border border-amber-600 bg-amber-900/25 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-amber-100 font-medium text-sm">
                No kit log linked — will land in the exception queue for office resolution
              </p>
              <p className="text-amber-200/70 text-xs mt-1 whitespace-pre-wrap">
                {kitChoice.unlinkedReason}
              </p>
            </div>
            <button
              onClick={() => setKitChoice(null)}
              className="text-amber-300 hover:underline text-sm shrink-0"
            >
              Change
            </button>
          </div>
        </div>
      )}

      {/* ---- Dropzone ---- */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => {
          e.preventDefault()
          setDragging(false)
          ingest(e.dataTransfer?.files)
        }}
        className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
          dragging ? 'border-skynet-accent bg-skynet-accent/10' : 'border-gray-700 bg-gray-800/50'
        }`}
      >
        <Upload size={26} className="mx-auto mb-2 text-gray-500" />
        <p className="text-gray-200 text-sm font-medium">
          Drop the customer&rsquo;s email here
        </p>
        <p className="text-gray-500 text-xs mt-1">
          .msg, .eml, PDF, image, or text — attachments are unpacked automatically
        </p>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="mt-3 px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 text-sm font-medium"
        >
          Choose files
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          onChange={e => { ingest(e.target.files); e.target.value = '' }}
          className="hidden"
        />
        {busy && (
          <p className="text-gray-400 text-sm mt-3 flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin" />
            {reading ? 'Reading files…' : 'Reading the request…'}
          </p>
        )}
      </div>

      {/* Per-file parse failures. The file is still attached — only the reading
          of it failed — so this is informational, never a block. */}
      {payload.errors.length > 0 && (
        <div className="mt-3 text-amber-300 text-xs space-y-1">
          {payload.errors.map((e, i) => <p key={i}>{e}</p>)}
        </div>
      )}

      {payload.unreadable.length > 0 && (
        <p className="mt-3 text-gray-500 text-xs">
          Will be attached, not readable by extraction: {payload.unreadable.join(', ')}
        </p>
      )}

      {/* ---- Held files ---- */}
      {payload.holdings.length > 0 && (
        <div className="mt-4 space-y-2">
          {payload.holdings.map(h => {
            const isSourceEmail = h.documentType === 'request_email' && h.origin === 'upload'
            return (
              <div key={h.key} className="flex items-center gap-3 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2">
                <Paperclip size={14} className="text-gray-500 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-gray-200 text-sm truncate">{h.name}</p>
                  <p className="text-gray-500 text-[11px]">
                    {(h.size / 1024).toFixed(0)} KB
                    {h.origin !== 'upload' ? ` · ${h.origin}` : ''}
                    {!h.readable ? ' · not readable by extraction' : ''}
                  </p>
                </div>
                {isSourceEmail ? (
                  // The customer's own message is what it is — no reason to let
                  // anyone file it as anything else.
                  <Pill tone="blue">request email</Pill>
                ) : (
                  <select
                    value={h.documentType}
                    onChange={e => setHoldingType(h.key, e.target.value)}
                    className="px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-gray-200 text-xs focus:border-skynet-accent focus:outline-none"
                  >
                    {DOCUMENT_TYPES.filter(d => d.value !== 'request_email').map(d => (
                      <option key={d.value} value={d.value}>{d.label}</option>
                    ))}
                  </select>
                )}
                <button
                  onClick={() => removeHolding(h.key)}
                  className="text-gray-500 hover:text-white shrink-0"
                  title="Remove"
                >
                  <X size={16} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* ---- Extraction status lines ---- */}
      {extractError && (
        <div className="mt-4 flex items-start gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2">
          <p className="flex-1 text-gray-300 text-sm">{extractError}</p>
          <button onClick={() => setExtractError(null)} className="text-gray-500 hover:text-white">
            <X size={14} />
          </button>
        </div>
      )}

      {banner && (
        <div className="mt-4 flex items-start gap-2 bg-blue-900/25 border border-blue-700 rounded-lg px-3 py-2.5">
          <Sparkles size={16} className="text-blue-300 shrink-0 mt-0.5" />
          <p className="flex-1 text-blue-100 text-sm">
            AI-suggested — verify against the email. Every field is editable, and nothing
            is saved until you press Create intake.
          </p>
        </div>
      )}

      {/* ---- Fields ---- */}
      <div className="mt-6">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Received date" required error={fieldErrors.receivedDate} chip={chipFor('receivedDate', aiFilled, confidence)}>
            <input
              ref={refs.receivedDate}
              aria-required="true"
              type="date"
              value={form.receivedDate}
              onChange={e => set('receivedDate', e.target.value)}
              style={{ colorScheme: 'dark' }}
              className={inputClass(fieldErrors.receivedDate)}
            />
          </Field>
          <Field label="Channel" optional>
            <select
              value={form.channel}
              onChange={e => set('channel', e.target.value)}
              className={inputClass()}
            >
              {CHANNELS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </Field>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Requester name" required error={fieldErrors.requesterName} chip={chipFor('requesterName', aiFilled, confidence)}>
            <input
              ref={refs.requesterName}
              aria-required="true"
              value={form.requesterName}
              onChange={e => set('requesterName', e.target.value)}
              className={inputClass(fieldErrors.requesterName)}
            />
          </Field>
          <Field label="Email" optional chip={chipFor('requesterEmail', aiFilled, confidence)}>
            <input value={form.requesterEmail} onChange={e => set('requesterEmail', e.target.value)} className={inputClass()} />
          </Field>
        </div>

        <Field label="Company" required error={fieldErrors.requesterCompany} chip={chipFor('requesterCompany', aiFilled, confidence)}>
          <input
            ref={refs.requesterCompany}
            aria-required="true"
            value={form.requesterCompany}
            onChange={e => set('requesterCompany', e.target.value)}
            className={inputClass(fieldErrors.requesterCompany)}
          />
          {hints.company && (
            <Hint>
              {hints.company.exact
                ? `matches ${hints.company.name}`
                : `closest customer on file: ${hints.company.name}`}
            </Hint>
          )}
        </Field>

        <div className="grid sm:grid-cols-2 gap-4">
          {/* Required on every intake, linked or not (D-KSTC-20). Where the
              email states no number, the bench enters the one from the located
              log entry or the customer's paperwork; a claim that disagrees with
              the linked log shows the mismatch chip and still saves. */}
          <Field
            label="Claimed kit #"
            required
            error={fieldErrors.claimedKitNumber}
            chip={kitMismatch
              ? <Pill tone="amber">{kitMismatch}</Pill>
              : chipFor('claimedKitNumber', aiFilled, confidence)}
          >
            <input
              ref={refs.claimedKitNumber}
              aria-required="true"
              value={form.claimedKitNumber}
              onChange={e => set('claimedKitNumber', e.target.value)}
              placeholder="e.g. 99804"
              className={inputClass(fieldErrors.claimedKitNumber)}
            />
            {hints.kit && !kitMismatch && (
              <Hint>
                matches {hints.kit.label}{hints.kit.customer ? ` — ${hints.kit.customer}` : ''}
              </Hint>
            )}
          </Field>
          <Field label="Claimed kit part" required error={fieldErrors.claimedKitPart} chip={chipFor('claimedKitPart', aiFilled, confidence)}>
            <input
              ref={refs.claimedKitPart}
              aria-required="true"
              value={form.claimedKitPart}
              onChange={e => set('claimedKitPart', e.target.value)}
              className={inputClass(fieldErrors.claimedKitPart)}
            />
          </Field>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Aircraft serial" required error={fieldErrors.claimedAircraftSerial} chip={chipFor('claimedAircraftSerial', aiFilled, confidence)}>
            <input
              ref={refs.claimedAircraftSerial}
              aria-required="true"
              value={form.claimedAircraftSerial}
              onChange={e => set('claimedAircraftSerial', e.target.value)}
              className={inputClass(fieldErrors.claimedAircraftSerial)}
            />
          </Field>
          <Field label="Registration" required error={fieldErrors.claimedRegistration} chip={chipFor('claimedRegistration', aiFilled, confidence)}>
            <input
              ref={refs.claimedRegistration}
              aria-required="true"
              value={form.claimedRegistration}
              onChange={e => set('claimedRegistration', e.target.value)}
              className={inputClass(fieldErrors.claimedRegistration)}
            />
          </Field>
        </div>

        {hints.aircraft && (
          <Hint className="-mt-2 mb-5">
            matches {hints.aircraft.serial || '—'} / {hints.aircraft.registration || '—'}
            {hints.aircraft.makeModel ? ` · ${hints.aircraft.makeModel}` : ''}
            {hints.aircraft.viaHistory ? ' (former registration)' : ''}
          </Hint>
        )}

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Order #" required error={fieldErrors.claimedOrderNumber} chip={chipFor('claimedOrderNumber', aiFilled, confidence)}>
            <input
              ref={refs.claimedOrderNumber}
              aria-required="true"
              value={form.claimedOrderNumber}
              onChange={e => set('claimedOrderNumber', e.target.value)}
              placeholder="S-number, as the customer wrote it"
              className={inputClass(fieldErrors.claimedOrderNumber)}
            />
          </Field>
          <Field label="Purchased from" optional chip={chipFor('purchasedFrom', aiFilled, confidence)}>
            <input value={form.purchasedFrom} onChange={e => set('purchasedFrom', e.target.value)} className={inputClass()} />
          </Field>
        </div>

        <Field label="Notes" optional chip={aiFilled.notes ? <Pill tone="blue">AI summary</Pill> : null}>
          <textarea
            value={form.notes}
            onChange={e => set('notes', e.target.value)}
            rows={3}
            className={`${inputClass()} resize-none`}
          />
        </Field>
      </div>

      <p className="text-gray-500 text-xs mb-3">
        <span className="text-red-400">*</span> required. Everything else saves exactly as the
        customer wrote it — kit numbers, registrations and serials are claims, not facts, and are
        never reformatted or checked here.
      </p>

      {saveError && <p className="text-red-400 text-sm mb-3">{saveError}</p>}

      <div className="flex flex-wrap gap-3">
        <button
          onClick={handleSave}
          disabled={saving || busy}
          className="flex-1 min-w-[14rem] py-3.5 rounded-xl bg-skynet-accent hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white text-base font-semibold flex items-center justify-center gap-2"
        >
          {saving ? <Loader2 size={20} className="animate-spin" /> : <CheckCircle size={20} />}
          Create intake
        </button>
        <button
          onClick={onCancel}
          disabled={saving}
          className="px-6 py-3.5 rounded-xl bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-base font-medium"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ---------- Presentational helpers -------------------------------------------

function inputClass(error) {
  return `w-full px-3 py-2.5 bg-gray-800 border rounded-lg text-white text-sm placeholder-gray-500 focus:border-skynet-accent focus:outline-none ${
    error ? 'border-red-500' : 'border-gray-700'
  }`
}

// Subtle by design: the chip says where the value came from and how sure the
// model was, and disappears the moment a human touches the field.
function chipFor(key, aiFilled, confidence) {
  if (!aiFilled[key]) return null
  const level = confidence[key] || 'low'
  return <Pill tone={CONFIDENCE_TONE[level]}>{CONFIDENCE_LABEL[level]}</Pill>
}

// One marking convention across the module (D-KSTC-16): a red asterisk means the
// save will be refused without it, "(optional)" means it genuinely can be left
// blank. A field never carries both.
function Field({ label, required, optional, error, chip, children }) {
  return (
    <div className="mb-5">
      <label className="flex items-center gap-2 text-gray-400 text-sm font-medium mb-2">
        <span>
          {label}
          {required && <span className="text-red-400 ml-1" aria-hidden="true">*</span>}
          {optional && !required && <span className="text-gray-500 font-normal ml-1">(optional)</span>}
        </span>
        {chip}
      </label>
      {children}
      {error && <p className="text-red-400 text-sm mt-1.5">{error}</p>}
    </div>
  )
}

// Match hints are informational only — they never gate the save and never write
// a foreign key. Binding a request to a lot or an airframe is Round C2.
function Hint({ children, className = '' }) {
  return <p className={`text-green-400 text-xs mt-1.5 ${className}`}>✓ {children}</p>
}
