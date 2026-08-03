import { useState, useRef, useCallback } from 'react'
import {
  Upload, Loader2, X, CheckCircle, AlertTriangle, PackageOpen, Sparkles,
  RotateCcw, Trash2, ChevronDown, ChevronRight,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { formatLogDate, lotLabel } from '../../lib/kitRegistry'
import {
  extractPackingSlip, findLotsBySo, savePackingSlipGroup, attachSlipDocument,
  normalizePart, lotPartNorm, SLIP_ACCEPT,
} from '../../lib/packingSlip'
import PinPad from '../PinPad'
import { Pill, Spinner, Empty, LinkText, SourceBadge } from './ui'
import KitDrawer from './KitDrawer'

// Packing Slip capture (D-KSTC-28). The warehouse uploads the slip Fishbowl
// printed at ship time; the component lot numbers on it become
// kit_lot_component_lots rows against the kit lot(s) the order shipped.
//
// SUGGEST, NEVER COMMIT — the same contract as STC intake (D-KSTC-18). The
// extraction fills the grid; the grid is what saves. If extraction is down the
// operator loses the typing, not the ability to record: the shipping-report
// loader still sweeps the same ground periodically (D-KSTC-25).
//
// Three steps, because matching is the part that needs a human: upload, then
// review-and-match, then save. Nothing is written until step 3.

const CONFIDENCE_TONE = { high: 'green', medium: 'amber', low: 'gray' }
const CONFIDENCE_LABEL = { high: 'AI · high', medium: 'AI · med', low: 'AI · low' }

// A group whose parent part matches no logged kit lot is normal — tool sets and
// loose accessories ship on the same slip and were never kit-logged.
const NO_ASSIGNMENT = ''

export default function PackingSlipTab({ mode, profile }) {
  const [step, setStep] = useState('upload')   // 'upload' | 'review' | 'done'

  // --- upload ---------------------------------------------------------------
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [extractError, setExtractError] = useState(null)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef(null)

  // --- review ---------------------------------------------------------------
  const [slip, setSlip] = useState(null)
  const [candidates, setCandidates] = useState({ rows: [], matchedVia: {} })
  const [assignment, setAssignment] = useState({})   // groupIndex -> kit lot id
  const [grid, setGrid] = useState({})               // groupIndex -> [lines]
  const [expanded, setExpanded] = useState(false)    // the excluded-lines block

  // --- save -----------------------------------------------------------------
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [results, setResults] = useState([])         // [{ lot, inserted, skipped, docError }]
  const [pinOpen, setPinOpen] = useState(false)
  const [pin, setPin] = useState('')
  const [pinError, setPinError] = useState(null)

  // --- drawer ---------------------------------------------------------------
  const [stack, setStack] = useState([])
  const push = useCallback((entry) => setStack(s => [...s, entry]), [])

  // ---------- Step 1: upload + extract --------------------------------------

  const ingest = useCallback(async (files) => {
    const picked = [...(files || [])][0]
    if (!picked) return

    setFile(picked)
    setExtractError(null)
    setBusy(true)
    try {
      const envelope = await extractPackingSlip(picked)
      setSlip(envelope)

      // Editable copies, one per group. From here the grid is the truth and the
      // extraction is only provenance for the chips.
      const g = {}
      envelope.groups.forEach((group, i) => {
        g[i] = group.lines.map((l, j) => ({ ...l, key: `${i}-${j}` }))
      })
      setGrid(g)

      // Which kit lots did this order ship against?
      let found = { rows: [], matchedVia: {} }
      if (envelope.order_number) {
        try {
          found = await findLotsBySo(envelope.order_number)
        } catch (err) {
          console.error('SO lookup failed:', err)
        }
      }
      setCandidates(found)
      setAssignment(autoAssign(envelope, found.rows))
      setStep('review')
    } catch (err) {
      console.error('Packing-slip extraction failed:', err)
      setExtractError(err.message || 'That slip could not be read.')
    } finally {
      setBusy(false)
    }
  }, [])

  const restart = () => {
    setStep('upload')
    setFile(null); setSlip(null); setExtractError(null)
    setCandidates({ rows: [], matchedVia: {} })
    setAssignment({}); setGrid({}); setExpanded(false)
    setResults([]); setSaveError(null)
  }

  // ---------- Step 2: grid edits --------------------------------------------

  const editLine = (gi, key, field, value) => {
    setGrid(prev => ({
      ...prev,
      [gi]: prev[gi].map(l => (l.key === key ? { ...l, [field]: value, edited: true } : l)),
    }))
  }

  const dropLine = (gi, key) => {
    setGrid(prev => ({ ...prev, [gi]: prev[gi].filter(l => l.key !== key) }))
  }

  // A line saves only when it carries both halves of the identity. The RPC
  // skips blanks too — this is so the operator can see the count before saving.
  const savable = (lines) => (lines || []).filter(
    l => String(l.part_number || '').trim() && String(l.lot_number || '').trim())

  const assignedGroups = () => (slip?.groups || [])
    .map((group, i) => ({ group, i, lotId: assignment[i] }))
    .filter(g => g.lotId && savable(grid[g.i]).length > 0)

  // ---------- Step 3: save ---------------------------------------------------

  const doSave = async (operatorId) => {
    setSaving(true)
    setSaveError(null)
    try {
      const out = []
      for (const { i, lotId } of assignedGroups()) {
        const lot = candidates.rows.find(r => r.id === lotId) || null
        const { inserted, skipped } = await savePackingSlipGroup({
          kitLotId: lotId,
          shipmentNumber: slip.order_number || null,
          shipDate: slip.ship_date || null,
          lines: savable(grid[i]),
          operatorId,
        })

        // The slip is evidence for every lot it covers, so each gets its own
        // copy and its own document row — one lot's drawer must never depend on
        // another lot's record to show the paperwork.
        let docError = null
        try {
          await attachSlipDocument({ kitLotId: lotId, file, uploadedBy: operatorId })
        } catch (err) {
          console.error('Attaching the slip failed:', err)
          docError = err.message || 'The slip file did not attach.'
        }

        out.push({ lotId, lot, inserted, skipped, docError })
      }
      setResults(out)
      setStep('done')
    } catch (err) {
      console.error('Recording component lots failed:', err)
      setSaveError(err.message || 'Those component lots could not be recorded.')
    } finally {
      setSaving(false)
    }
  }

  const handleSave = async () => {
    // Validate BEFORE the PIN pad — an operator must never enter a PIN for a
    // doomed save (D-KSTC-16).
    if (!assignedGroups().length) {
      setSaveError('Assign at least one kit lot before saving.')
      return
    }
    setSaveError(null)

    if (mode === 'office') {
      await doSave(profile?.id || null)
    } else {
      setPin(''); setPinError(null); setPinOpen(true)
    }
  }

  // Kiosk confirm. The PIN operator becomes created_by — never auth.uid(),
  // which on a kiosk JWT is the device's anchor operator (D-KSTC-06).
  const handlePinConfirm = async () => {
    if (pin.length < 4) { setPinError('PIN must be 4 digits'); return }
    setSaving(true)
    setPinError(null)
    try {
      const { data, error } = await supabase
        .from('profiles').select('id, full_name, username')
        .eq('pin_code', pin).eq('is_active', true).single()
      if (error) {
        if (error.code === 'PGRST116') { setPinError('Invalid PIN'); setPin(''); return }
        throw error
      }
      setPinOpen(false)
      setPin('')
      await doSave(data.id)
    } catch (err) {
      console.error('PIN confirm failed:', err)
      setPinError('Could not verify PIN')
      setPin('')
    } finally {
      setSaving(false)
    }
  }

  // ---------- Render ---------------------------------------------------------

  return (
    <div className="p-5 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-5">
        <PackageOpen size={22} className="text-skynet-accent shrink-0" />
        <div className="min-w-0">
          <h2 className="text-white text-lg font-semibold leading-tight">Packing slip</h2>
          <p className="text-gray-400 text-xs">
            Record the component lot numbers that shipped inside each kit
          </p>
        </div>
      </div>

      <Steps step={step} />

      {step === 'upload' && (
        <UploadStep
          busy={busy}
          dragging={dragging}
          setDragging={setDragging}
          fileInputRef={fileInputRef}
          onFiles={ingest}
          error={extractError}
          onClearError={() => setExtractError(null)}
          fileName={file?.name}
        />
      )}

      {step === 'review' && slip && (
        <>
          <SlipHeader slip={slip} fileName={file?.name} onRestart={restart} />

          <div className="mt-5 flex items-start gap-2 bg-blue-900/25 border border-blue-700 rounded-lg px-3 py-2.5">
            <Sparkles size={16} className="text-blue-300 shrink-0 mt-0.5" />
            <p className="flex-1 text-blue-100 text-sm">
              AI-read from the slip — check it against the paper. Every value is editable,
              and nothing is recorded until you press Record component lots.
            </p>
          </div>

          {slip.groups.map((group, i) => (
            <GroupCard
              key={i}
              group={group}
              lines={grid[i] || []}
              lotId={assignment[i] || NO_ASSIGNMENT}
              options={optionsFor(group, candidates.rows)}
              matchedVia={candidates.matchedVia}
              orderNumber={slip.order_number}
              onAssign={(id) => setAssignment(prev => ({ ...prev, [i]: id }))}
              onEdit={(key, field, value) => editLine(i, key, field, value)}
              onDrop={(key) => dropLine(i, key)}
            />
          ))}

          {slip.ungrouped_lines.length > 0 && (
            <div className="mt-4">
              <button
                onClick={() => setExpanded(e => !e)}
                className="flex items-center gap-2 text-gray-400 hover:text-gray-200 text-xs"
              >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {slip.ungrouped_lines.length} line{slip.ungrouped_lines.length === 1 ? '' : 's'} with
                no kit above them — excluded
              </button>
              {expanded && (
                <div className="mt-2 rounded-lg border border-gray-700 bg-gray-800/40 p-3 space-y-1">
                  {slip.ungrouped_lines.map((l, j) => (
                    <p key={j} className="text-gray-400 text-xs font-mono">
                      {l.line_no ?? '—'} · {l.part_number} · lot {l.lot_number || '—'} · qty {l.qty_shipped ?? '—'}
                    </p>
                  ))}
                  <p className="text-gray-500 text-[11px] pt-1">
                    These have no kit header line to belong to, so there is nothing to record
                    them against. Log the kit in Kit Entry first, then re-upload the slip.
                  </p>
                </div>
              )}
            </div>
          )}

          {saveError && <p className="text-red-400 text-sm mt-4">{saveError}</p>}

          <div className="flex flex-wrap gap-3 mt-5">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 min-w-[16rem] h-14 rounded-xl bg-skynet-accent hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white text-base font-semibold flex items-center justify-center gap-2"
            >
              {saving ? <Loader2 size={20} className="animate-spin" /> : <CheckCircle size={20} />}
              {mode === 'kiosk' ? 'Record — confirm with PIN' : 'Record component lots'}
            </button>
            <button
              onClick={restart}
              disabled={saving}
              className="h-14 px-6 rounded-xl bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-base font-medium"
            >
              Start over
            </button>
          </div>
          <p className="text-gray-500 text-xs mt-3">
            {assignedGroups().length
              ? `${assignedGroups().length} kit${assignedGroups().length === 1 ? '' : 's'} will be recorded. Re-recording the same slip is safe — nothing duplicates.`
              : 'No kit lot assigned yet — assign one above to record anything.'}
          </p>
        </>
      )}

      {step === 'done' && (
        <DoneStep results={results} onAnother={restart} onOpenLot={(id, label) => push({ type: 'lot', id, label })} />
      )}

      {/* ---- Kiosk PIN confirm ---- */}
      {pinOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
          <div className="w-full max-w-sm">
            <PinPad
              icon={<PackageOpen size={40} className="mx-auto mb-3 text-skynet-accent" />}
              title="Record component lots"
              subtitle="Enter your PIN to sign this shipment"
              pin={pin}
              error={pinError}
              busy={saving}
              buttonLabel="Confirm & record"
              onDigit={(d) => { if (pin.length < 4) setPin(pin + d) }}
              onClear={() => setPin('')}
              onBackspace={() => setPin(pin.slice(0, -1))}
              onSubmit={handlePinConfirm}
            />
            <button
              onClick={() => { setPinOpen(false); setPin(''); setPinError(null) }}
              className="w-full mt-3 h-12 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {stack.length > 0 && (
        <KitDrawer
          stack={stack}
          onPush={push}
          onPop={() => setStack(s => s.slice(0, -1))}
          onClose={() => setStack([])}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// Only lots whose kit matches this group's parent part may be assigned to it —
// a slip can carry two different kits and their components must not cross over.
function optionsFor(group, rows) {
  const want = normalizePart(group.parent_part_number)
  return (rows || []).filter(r => lotPartNorm(r) === want)
}

// The bench already wrote the kit lot number in Fishbowl's Notes ("SK203C172P4
// Lot: 99942"), so when that number is one of the candidates it IS the answer.
// Otherwise a single fitting lot selects itself, and anything ambiguous waits
// for the operator.
function autoAssign(slip, rows) {
  const hintLot = slip.notes_hint?.kit_lot_number
    ? String(slip.notes_hint.kit_lot_number).trim()
    : null
  const out = {}
  slip.groups.forEach((group, i) => {
    const options = optionsFor(group, rows)
    const hinted = hintLot
      ? options.find(o => String(o.lot_number) === hintLot)
      : null
    if (hinted) { out[i] = hinted.id; return }
    if (options.length === 1) { out[i] = options[0].id; return }
    out[i] = NO_ASSIGNMENT
  })
  return out
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const STEP_LABELS = [
  ['upload', 'Upload'],
  ['review', 'Review & match'],
  ['done', 'Recorded'],
]

function Steps({ step }) {
  const index = STEP_LABELS.findIndex(([k]) => k === step)
  return (
    <div className="flex items-center gap-2 mb-5">
      {STEP_LABELS.map(([key, label], i) => (
        <div key={key} className="flex items-center gap-2">
          <span className={`text-xs px-2.5 py-1 rounded-full border ${
            i === index
              ? 'bg-skynet-accent/20 border-skynet-accent text-white'
              : i < index
                ? 'bg-gray-800 border-gray-700 text-gray-400'
                : 'bg-gray-800/40 border-gray-800 text-gray-600'
          }`}>
            {i + 1}. {label}
          </span>
          {i < STEP_LABELS.length - 1 && <span className="text-gray-700">·</span>}
        </div>
      ))}
    </div>
  )
}

function UploadStep({ busy, dragging, setDragging, fileInputRef, onFiles, error, onClearError, fileName }) {
  return (
    <>
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); onFiles(e.dataTransfer?.files) }}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          dragging ? 'border-skynet-accent bg-skynet-accent/10' : 'border-gray-700 bg-gray-800/50'
        }`}
      >
        <Upload size={30} className="mx-auto mb-3 text-gray-500" />
        <p className="text-gray-200 text-base font-medium">Drop the packing slip here</p>
        <p className="text-gray-500 text-xs mt-1">
          PDF from Fishbowl, or a photo of the printed slip (PNG, JPEG, WebP)
        </p>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="mt-4 px-5 py-2.5 rounded-lg bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 text-sm font-medium"
        >
          Choose a file
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={SLIP_ACCEPT}
          onChange={e => { onFiles(e.target.files); e.target.value = '' }}
          className="hidden"
        />
        {busy && (
          <p className="text-gray-400 text-sm mt-4 flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin" />
            Reading {fileName || 'the slip'}…
          </p>
        )}
      </div>

      {/* Extraction failing is never fatal — it costs typing, not the record. */}
      {error && (
        <div className="mt-4 flex items-start gap-2 bg-amber-900/25 border border-amber-600 rounded-lg px-3 py-2.5">
          <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-amber-100 text-sm">{error}</p>
            <button
              onClick={() => { onClearError(); fileInputRef.current?.click() }}
              className="mt-2 flex items-center gap-1.5 text-amber-300 hover:underline text-xs"
            >
              <RotateCcw size={13} /> Try another file
            </button>
          </div>
          <button onClick={onClearError} className="text-amber-400/60 hover:text-amber-200">
            <X size={14} />
          </button>
        </div>
      )}
    </>
  )
}

function SlipHeader({ slip, fileName, onRestart }) {
  return (
    <div className="rounded-xl border border-gray-700 bg-gray-800 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-mono font-bold text-white text-xl">
              SO {slip.order_number || '—'}
            </span>
            <span className="text-gray-400 text-sm">shipped {formatLogDate(slip.ship_date)}</span>
            {slip.notes_hint && (
              <Pill tone="blue">
                slip note: {slip.notes_hint.kit_sku || '—'} lot {slip.notes_hint.kit_lot_number || '—'}
              </Pill>
            )}
            <Pill tone={CONFIDENCE_TONE[slip.overall_confidence]}>
              {CONFIDENCE_LABEL[slip.overall_confidence]}
            </Pill>
          </div>
          {fileName && <p className="text-gray-500 text-xs mt-1.5 truncate">{fileName}</p>}
        </div>
        <button onClick={onRestart} className="text-skynet-accent hover:underline text-sm shrink-0">
          Change
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// One kit group: the lot assignment, then its confirmation grid
// ---------------------------------------------------------------------------

function GroupCard({ group, lines, lotId, options, matchedVia, orderNumber, onAssign, onEdit, onDrop }) {
  const [showExcluded, setShowExcluded] = useState(false)
  const included = lines.filter(l => String(l.part_number || '').trim() && String(l.lot_number || '').trim())
  const excluded = lines.filter(l => !String(l.lot_number || '').trim())
  const chosen = options.find(o => o.id === lotId) || null

  return (
    <div className="mt-4 rounded-xl border border-gray-700 bg-gray-800/60 overflow-hidden">
      <div className="p-4 border-b border-gray-700">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <p className="font-mono text-white font-semibold">{group.parent_part_number}</p>
            <p className="text-gray-400 text-xs mt-0.5">
              {included.length} component lot{included.length === 1 ? '' : 's'} on the slip
            </p>
          </div>
          {!lotId && (
            <Pill tone="amber">skipped — no kit lot assigned</Pill>
          )}
        </div>

        <div className="mt-3">
          {!options.length ? (
            // Not an error: tool sets and loose parts ship on the same slip and
            // were never kit-logged. Only a genuine kit missing its log entry
            // needs acting on, and this sentence says which to do about it.
            <div className="rounded-lg border border-amber-600/60 bg-amber-900/20 px-3 py-2.5">
              <p className="text-amber-100 text-sm">
                No kit lot logged for SO {orderNumber || '—'} matching{' '}
                <span className="font-mono">{group.parent_part_number}</span> — log the kit in
                Kit Entry first, then upload this slip again.
              </p>
              <p className="text-amber-200/60 text-xs mt-1">
                Other kits on this slip still record normally.
              </p>
            </div>
          ) : (
            <>
              <label className="block text-gray-400 text-xs font-medium mb-1.5">Kit lot</label>
              <select
                value={lotId}
                onChange={e => onAssign(e.target.value)}
                className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-skynet-accent focus:outline-none"
              >
                <option value={NO_ASSIGNMENT}>— skip this kit —</option>
                {options.map(o => (
                  <option key={o.id} value={o.id}>
                    {lotLabel(o)}
                    {o.customer_as_written ? ` — ${o.customer_as_written}` : ''}
                    {` · logged ${formatLogDate(o.log_date)}`}
                  </option>
                ))}
              </select>
              {chosen && (
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <SourceBadge source={chosen.source} />
                  {matchedVia[chosen.id] === 'invoice_direct' && (
                    // The paper books recorded invoices, not SOs (D-KSTC-11);
                    // Fishbowl invoice numbers inherit the SO (D-KSTC-27). Worth
                    // saying out loud — it is an inference, not a stored link.
                    <Pill tone="amber">matched via invoice # read as the SO</Pill>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {lotId && (
        <div className="p-4">
          <div className="overflow-x-auto rounded-lg border border-gray-700">
            <table className="w-full text-sm">
              <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
                <tr>
                  <th className="text-left px-2 py-2 font-medium w-12">Line</th>
                  <th className="text-left px-2 py-2 font-medium">Part #</th>
                  <th className="text-left px-2 py-2 font-medium">Lot #</th>
                  <th className="text-left px-2 py-2 font-medium w-20">Qty</th>
                  <th className="text-left px-2 py-2 font-medium w-24"> </th>
                </tr>
              </thead>
              <tbody>
                {included.map(l => (
                  <tr key={l.key} className="border-t border-gray-800">
                    <td className="px-2 py-1.5 text-gray-500 font-mono text-xs">{l.line_no ?? '—'}</td>
                    <td className="px-2 py-1.5">
                      <GridInput value={l.part_number} onChange={v => onEdit(l.key, 'part_number', v)} />
                    </td>
                    <td className="px-2 py-1.5">
                      <GridInput value={l.lot_number} onChange={v => onEdit(l.key, 'lot_number', v)} />
                    </td>
                    <td className="px-2 py-1.5">
                      <GridInput
                        value={l.qty_shipped ?? ''}
                        onChange={v => onEdit(l.key, 'qty_shipped', v)}
                        inputMode="decimal"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* The chip retires the moment a human touches the row —
                            the value is theirs now, not the model's. */}
                        {!l.edited && (
                          <Pill tone={CONFIDENCE_TONE[l.confidence]}>{CONFIDENCE_LABEL[l.confidence]}</Pill>
                        )}
                        <button
                          onClick={() => onDrop(l.key)}
                          className="text-gray-500 hover:text-red-400 shrink-0"
                          title="Remove this line"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!included.length && (
                  <tr><td colSpan={5}><Empty>No component lines left to record for this kit.</Empty></td></tr>
                )}
              </tbody>
            </table>
          </div>

          {excluded.length > 0 && (
            <div className="mt-2">
              <button
                onClick={() => setShowExcluded(e => !e)}
                className="flex items-center gap-2 text-gray-400 hover:text-gray-200 text-xs"
              >
                {showExcluded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {excluded.length} line{excluded.length === 1 ? '' : 's'} with no lot number — excluded
              </button>
              {showExcluded && (
                <div className="mt-2 rounded-lg border border-gray-700 bg-gray-900/60 p-3 space-y-2">
                  <p className="text-gray-500 text-[11px]">
                    Nothing was read after &ldquo;Lot#:&rdquo; on these. Type the lot from the paper
                    and the line joins the grid above; leave it blank and it is not recorded.
                  </p>
                  {excluded.map(l => (
                    <div key={l.key} className="flex items-center gap-2">
                      <span className="text-gray-400 text-xs font-mono w-8 shrink-0">{l.line_no ?? '—'}</span>
                      <span className="text-gray-300 text-xs font-mono flex-1 min-w-0 truncate">{l.part_number}</span>
                      <GridInput
                        value={l.lot_number || ''}
                        onChange={v => onEdit(l.key, 'lot_number', v)}
                        placeholder="lot #"
                      />
                      <button
                        onClick={() => onDrop(l.key)}
                        className="text-gray-500 hover:text-red-400 shrink-0"
                        title="Remove this line"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function GridInput({ value, onChange, inputMode, placeholder }) {
  return (
    <input
      value={value ?? ''}
      onChange={e => onChange(e.target.value)}
      inputMode={inputMode}
      placeholder={placeholder}
      className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm font-mono placeholder-gray-600 focus:border-skynet-accent focus:outline-none"
    />
  )
}

// ---------------------------------------------------------------------------
// Step 3 result
// ---------------------------------------------------------------------------

function DoneStep({ results, onAnother, onOpenLot }) {
  if (!results.length) return <Spinner />
  return (
    <>
      <div className="space-y-3">
        {results.map(r => {
          const allSkipped = r.inserted === 0 && r.skipped > 0
          return (
            <div
              key={r.lotId}
              className={`rounded-xl border p-4 ${
                allSkipped ? 'bg-gray-800 border-gray-700' : 'bg-green-900/25 border-green-700'}`}
            >
              <div className="flex items-start gap-3">
                <CheckCircle size={20} className={`shrink-0 mt-0.5 ${allSkipped ? 'text-gray-400' : 'text-green-400'}`} />
                <div className="min-w-0 flex-1">
                  <p className={`font-medium ${allSkipped ? 'text-gray-200' : 'text-green-100'}`}>
                    {allSkipped
                      ? 'Already recorded for this kit lot.'
                      : `${r.inserted} component lot${r.inserted === 1 ? '' : 's'} recorded${
                        r.skipped ? ` (${r.skipped} already on file)` : ''}`}
                  </p>
                  {r.lot && (
                    <LinkText onClick={() => onOpenLot(r.lotId, lotLabel(r.lot))}>
                      <span className="block font-mono text-sm mt-1">
                        {lotLabel(r.lot)}
                        {r.lot.customer_as_written ? ` — ${r.lot.customer_as_written}` : ''}
                      </span>
                    </LinkText>
                  )}
                  {/* The component lots are safe; only the file copy failed. Say
                      which half went wrong rather than colouring the whole save. */}
                  {r.docError && (
                    <p className="text-amber-300 text-xs mt-1.5">
                      Component lots saved, but the slip file did not attach — {r.docError}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <button
        onClick={onAnother}
        className="mt-5 h-14 w-full rounded-xl bg-skynet-accent hover:bg-blue-600 text-white text-base font-semibold flex items-center justify-center gap-2"
      >
        <PackageOpen size={20} /> Next packing slip
      </button>
    </>
  )
}
