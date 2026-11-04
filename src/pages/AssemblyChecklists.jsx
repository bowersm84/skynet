import { useState, useEffect, useMemo, useCallback } from 'react'
import { RefreshCw, Loader2, X, Printer, Check } from 'lucide-react'
import { hasRole } from '../lib/roles'
import { listFamilies, listSteps, listFamilyParts, setTemplate, setStep, setPartFamily, STEP_TYPE_LABELS } from '../lib/assembly'
import { formatDateTime } from '../lib/fishbowl'

// AssemblyChecklists — S17 Batch B (D-ASM-07 / D-ASM-29 / D-ASM-31). Roger's review of the checklist families seeded
// from Fishbowl's BOM sign-off lines: edit a step's label, PINs, threshold and sample; rename, approve or retire a
// family; move parts between families to merge the long tail; print the one page he signs. Writes go through the
// assembly_template_set / assembly_step_set / assembly_part_set_family RPCs (admin / compliance).
const SKYBOLT_RED = '#B8222E'
const SKYBOLT_GREY = '#707172'
const STATUS_RANK = { draft: 0, retired: 1, approved: 2 }
const STATUS_STYLE = {
  draft: 'bg-amber-900/40 text-amber-300 border-amber-800',
  approved: 'bg-green-900/40 text-green-300 border-green-800',
  retired: 'bg-gray-800 text-gray-500 border-gray-700',
}
const field = 'px-2 py-1 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:outline-none focus:border-skynet-accent'
const btn = 'px-3 py-1.5 rounded text-xs border transition-colors disabled:opacity-50'

// The paper copy: everything but .assembly-print-sheet is hidden when printing.
const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  .assembly-print-sheet, .assembly-print-sheet * { visibility: visible !important; }
  .assembly-print-sheet { position: absolute; left: 0; top: 0; width: 100%; display: block !important; }
  @page { size: letter portrait; margin: 0.5in; }
}
`

// embedded: shown as an Armory tab (S17 B2, D-ASM-33), inside Armory's own page width and padding.
export default function AssemblyChecklists({ profile, embedded = false }) {
  const canAct = hasRole(profile, 'admin', 'compliance')
  const [families, setFamilies] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState(null)
  const [steps, setSteps] = useState([])
  const [parts, setParts] = useState([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null)
  const [renaming, setRenaming] = useState(null)
  const [movePicked, setMovePicked] = useState(() => new Set())
  const [moveTarget, setMoveTarget] = useState('')

  const sorted = useMemo(() => [...families].sort((a, b) =>
    (STATUS_RANK[a.status] ?? 0) - (STATUS_RANK[b.status] ?? 0) || (b.part_count || 0) - (a.part_count || 0) || String(a.name).localeCompare(String(b.name))),
  [families])
  const selected = families.find((f) => f.id === selectedId) || null

  const loadFamilies = useCallback(async () => {
    try {
      setFamilies(await listFamilies())
    } catch (e) {
      setStatus({ type: 'error', message: `Could not load the checklist families: ${e?.message || e}` })
    } finally {
      setLoading(false)
    }
  }, [])

  const loadDetail = useCallback(async (fam) => {
    if (!fam) return
    setDetailLoading(true)
    try {
      const [s, p] = await Promise.all([listSteps(fam.id), listFamilyParts(fam.family_key)])
      setSteps(s)
      setParts(p)
    } catch (e) {
      setStatus({ type: 'error', message: `Could not load ${fam.name}: ${e?.message || e}` })
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => { loadFamilies() }, [loadFamilies])
  useEffect(() => {
    if (!selectedId && sorted.length) setSelectedId(sorted[0].id)
  }, [sorted, selectedId])
  useEffect(() => {
    setMovePicked(new Set())
    setMoveTarget('')
    setRenaming(null)
    loadDetail(families.find((f) => f.id === selectedId))
    // families is read for the row only; a reload of the list must not reload the detail
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, loadDetail])

  const act = async (fn, okMessage, { reloadDetail = true } = {}) => {
    setBusy(true)
    try {
      await fn()
      setStatus({ type: 'success', message: okMessage })
      await loadFamilies()
      if (reloadDetail && selected) await loadDetail(selected)
      return true
    } catch (e) {
      setStatus({ type: 'error', message: e?.message || String(e) })
      return false
    } finally {
      setBusy(false)
    }
  }

  if (!canAct) {
    return <div className="max-w-3xl mx-auto p-6 text-gray-400">Checklist review is for Quality (compliance) and admins.</div>
  }

  return (
    <div className={embedded ? 'pb-16' : 'max-w-[1700px] mx-auto p-6 pb-16'}>
      <style>{PRINT_CSS}</style>
      <div className="flex justify-between items-center mb-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Assembly Checklists</h2>
          <p className="text-gray-500 text-sm mt-1">Families seeded from Fishbowl BOM sign-off lines — review, merge and approve each before the kiosk uses it (D-ASM-07)</p>
        </div>
        <button onClick={() => { setLoading(true); loadFamilies() }} disabled={loading}
          className="flex items-center gap-2 px-3 py-2 rounded text-sm text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-50">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {status && (
        <div className={`mb-4 p-3 rounded text-sm flex justify-between items-center ${status.type === 'success' ? 'bg-green-900/40 text-green-300 border border-green-800' : 'bg-red-900/40 text-red-300 border border-red-800'}`}>
          <span>{status.message}</span>
          <button onClick={() => setStatus(null)}><X size={14} /></button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[420px_1fr] gap-4">
        {/* Families */}
        <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 text-sm text-gray-300 flex justify-between">
            <span className="font-medium">Families</span>
            <span className="text-xs text-gray-500">{families.length} · {families.filter((f) => f.status === 'approved').length} approved</span>
          </div>
          {loading && families.length === 0 ? (
            <div className="px-4 py-6 text-gray-500 text-sm flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading…</div>
          ) : (
            <div className="divide-y divide-gray-800 max-h-[75vh] overflow-y-auto">
              {sorted.map((f) => (
                <button key={f.id} onClick={() => setSelectedId(f.id)}
                  className={`w-full text-left px-4 py-2 text-xs hover:bg-gray-800/60 ${f.id === selectedId ? 'bg-gray-800/80' : ''}`}>
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex px-1.5 py-0.5 rounded border ${STATUS_STYLE[f.status] || STATUS_STYLE.draft}`}>{f.status}</span>
                    <span className="text-gray-200 text-sm truncate flex-1">{f.name}</span>
                  </div>
                  <div className="mt-1 text-gray-500 flex gap-3">
                    <span>{f.part_count} part{f.part_count === 1 ? '' : 's'}</span>
                    <span>{f.step_count} step{f.step_count === 1 ? '' : 's'}</span>
                    {f.wave === 2 && <span>wave 2</span>}
                  </div>
                  {f.example_parts && <div className="mt-0.5 text-gray-600 font-mono truncate">{f.example_parts}</div>}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Selected family */}
        <div className="bg-gray-900 rounded-lg border border-gray-800">
          {!selected ? <div className="px-4 py-6 text-gray-500 text-sm">Pick a family.</div> : (
            <>
              <div className="px-4 py-3 border-b border-gray-800 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`inline-flex px-2 py-0.5 rounded border text-xs ${STATUS_STYLE[selected.status] || STATUS_STYLE.draft}`}>{selected.status}</span>
                  {renaming !== null ? (
                    <>
                      <input autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} className={`${field} flex-1 min-w-[240px] text-sm`} />
                      <button disabled={busy || !renaming.trim()} onClick={async () => { if (await act(() => setTemplate(selected.id, renaming.trim(), null), 'Family renamed.', { reloadDetail: false })) setRenaming(null) }}
                        className={`${btn} bg-gray-800 border-gray-700 text-gray-200`}>Save</button>
                      <button onClick={() => setRenaming(null)} className="text-xs text-gray-500 hover:text-white">Cancel</button>
                    </>
                  ) : (
                    <>
                      <h3 className="text-white font-semibold flex-1">{selected.name}</h3>
                      <button disabled={busy} onClick={() => setRenaming(selected.name)} className={`${btn} bg-gray-800 border-gray-700 text-gray-300 hover:text-white`}>Rename</button>
                    </>
                  )}
                  {selected.status !== 'approved' && (
                    <button disabled={busy} onClick={() => act(() => setTemplate(selected.id, null, 'approved'), `${selected.name} approved.`, { reloadDetail: false })}
                      className={`${btn} text-white border-transparent inline-flex items-center gap-1`} style={{ backgroundColor: '#15803d' }}><Check size={12} /> Approve</button>
                  )}
                  {selected.status !== 'retired' && (
                    <button disabled={busy} onClick={() => act(() => setTemplate(selected.id, null, 'retired'), `${selected.name} retired.`, { reloadDetail: false })}
                      className={`${btn} bg-gray-900 border-gray-700 text-gray-400 hover:text-red-300`}>Retire</button>
                  )}
                  {selected.status === 'retired' && (
                    <button disabled={busy} onClick={() => act(() => setTemplate(selected.id, null, 'draft'), `${selected.name} back to draft.`, { reloadDetail: false })}
                      className={`${btn} bg-gray-900 border-gray-700 text-gray-400 hover:text-white`}>Back to draft</button>
                  )}
                  <button onClick={() => window.print()} className={`${btn} bg-gray-800 border-gray-700 text-gray-300 hover:text-white inline-flex items-center gap-1`}><Printer size={12} /> Print</button>
                </div>
                <div className="text-xs text-gray-500">
                  {selected.status === 'approved' && selected.approved_by_name
                    ? <>Approved by {selected.approved_by_name}{selected.approved_at ? ` · ${formatDateTime(selected.approved_at)}` : ''} · </>
                    : null}
                  {selected.seed_note}
                </div>
              </div>

              {detailLoading ? (
                <div className="px-4 py-6 text-gray-500 text-sm flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading steps…</div>
              ) : (
                <>
                  <table className="w-full text-xs">
                    <thead className="bg-gray-800/60 text-gray-400 uppercase">
                      <tr>
                        <th className="px-3 py-2 text-left w-8">#</th>
                        <th className="px-3 py-2 text-left">Type</th>
                        <th className="px-3 py-2 text-left">Label</th>
                        <th className="px-3 py-2 text-left" title="PINs required at this step (0–2)">PINs</th>
                        <th className="px-3 py-2 text-left" title="The second PIN must be someone other than this person">Distinct from</th>
                        <th className="px-3 py-2 text-left">Readings</th>
                        <th className="px-3 py-2 text-left">Threshold</th>
                        <th className="px-3 py-2 text-left">Sample</th>
                        <th className="px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      {steps.map((s) => <StepRow key={`${s.id}|${s.label}|${s.pins_required}|${s.threshold_min}|${s.sample_qty}`} step={s} busy={busy}
                        onSave={(fields) => act(() => setStep(s.id, fields), `Step ${s.step_order} saved.`)} />)}
                    </tbody>
                  </table>

                  <MoveParts parts={parts} families={sorted.filter((f) => f.id !== selected.id && f.status !== 'retired')}
                    picked={movePicked} setPicked={setMovePicked} target={moveTarget} setTarget={setMoveTarget} busy={busy}
                    onMove={async () => {
                      const target = families.find((f) => f.family_key === moveTarget)
                      const nums = [...movePicked]
                      if (await act(() => setPartFamily(nums, moveTarget), `${nums.length} part${nums.length === 1 ? '' : 's'} moved to ${target?.name || moveTarget}.`)) {
                        setMovePicked(new Set())
                      }
                    }} />
                </>
              )}

              <PrintSheet family={selected} steps={steps} parts={parts} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// Keyed on the step's saved values by the caller, so a save (or a reload) starts the row's inputs over.
function StepRow({ step: s, busy, onSave }) {
  const [label, setLabel] = useState(s.label)
  const [pins, setPins] = useState(String(s.pins_required))
  const [threshold, setThreshold] = useState(s.threshold_min ?? '')
  const [sample, setSample] = useState(s.sample_qty ?? '')
  const changed = label !== s.label || Number(pins) !== s.pins_required
    || String(threshold) !== String(s.threshold_min ?? '') || String(sample) !== String(s.sample_qty ?? '')
  const numOrUndef = (v) => (v === '' || v === null ? undefined : Number(v))
  return (
    <tr>
      <td className="px-3 py-2 font-mono text-gray-500">{s.step_order}</td>
      <td className="px-3 py-2 text-gray-300 whitespace-nowrap">{STEP_TYPE_LABELS[s.step_type] || s.step_type}</td>
      <td className="px-3 py-2"><input value={label} onChange={(e) => setLabel(e.target.value)} className={`${field} w-full min-w-[180px]`} /></td>
      <td className="px-3 py-2">
        <select value={pins} onChange={(e) => setPins(e.target.value)} className={field}>
          {[0, 1, 2].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </td>
      <td className="px-3 py-2 text-gray-400">{s.distinct_from || '—'}</td>
      <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{s.readings_count ? `${s.readings_count}${s.reading_unit ? ` ${s.reading_unit}` : ''}` : '—'}</td>
      <td className="px-3 py-2"><input value={threshold} onChange={(e) => setThreshold(e.target.value)} inputMode="decimal" placeholder="—" className={`${field} w-20`} /></td>
      <td className="px-3 py-2"><input value={sample} onChange={(e) => setSample(e.target.value)} inputMode="numeric" placeholder="—" className={`${field} w-16`} /></td>
      <td className="px-3 py-2 text-right">
        {changed && (
          <button disabled={busy || !label.trim()}
            onClick={() => onSave({ label: label.trim(), pins: Number(pins), thresholdMin: numOrUndef(threshold), sampleQty: numOrUndef(sample) })}
            className={`${btn} bg-purple-600 border-transparent text-white hover:bg-purple-500`}>Save</button>
        )}
      </td>
    </tr>
  )
}

function MoveParts({ parts, families, picked, setPicked, target, setTarget, busy, onMove }) {
  const toggle = (num) => setPicked((prev) => {
    const next = new Set(prev)
    if (next.has(num)) next.delete(num)
    else next.add(num)
    return next
  })
  return (
    <div className="border-t border-gray-800 px-4 py-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="text-gray-300 font-medium">Parts in this family ({parts.length})</span>
        <span className="text-gray-500">Move the ones that belong elsewhere:</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)} className={`${field} max-w-[360px]`}>
          <option value="">— target family —</option>
          {families.map((f) => <option key={f.id} value={f.family_key}>{f.name} ({f.part_count})</option>)}
        </select>
        <button disabled={busy || !target || picked.size === 0} onClick={onMove}
          className={`${btn} bg-purple-600 border-transparent text-white hover:bg-purple-500`}>Move {picked.size || ''}</button>
        {picked.size > 0 && <button onClick={() => setPicked(new Set())} className="text-gray-500 hover:text-white">Clear</button>}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-x-4 gap-y-1 max-h-64 overflow-y-auto">
        {parts.map((p) => (
          <label key={p.id} className="flex items-center gap-2 text-xs cursor-pointer" title={p.description || ''}>
            <input type="checkbox" checked={picked.has(p.part_number)} onChange={() => toggle(p.part_number)} className="accent-purple-500" />
            <span className="font-mono text-gray-300">{p.part_number}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

// One printable page per family — the copy Roger signs. Hidden on screen; PRINT_CSS shows only this.
function PrintSheet({ family, steps, parts }) {
  const cell = { border: `1px solid ${SKYBOLT_GREY}`, padding: '3px 6px', fontSize: '10pt', textAlign: 'left', verticalAlign: 'top' }
  return (
    <div className="assembly-print-sheet hidden" style={{ fontFamily: 'Arial, Helvetica, sans-serif', color: '#000', background: '#fff' }}>
      <div style={{ borderBottom: `3px solid ${SKYBOLT_RED}`, paddingBottom: 6, marginBottom: 10 }}>
        <div style={{ fontSize: '9pt', color: SKYBOLT_GREY }}>Skybolt Aerospace Fasteners · Assembly checklist family</div>
        <div style={{ fontSize: '15pt', fontWeight: 'bold' }}>{family.name}</div>
        <div style={{ fontSize: '9pt', color: SKYBOLT_GREY }}>Status: {family.status}{family.approved_by_name ? ` · approved by ${family.approved_by_name}` : ''} · printed {new Date().toLocaleDateString()}</div>
      </div>
      <table style={{ borderCollapse: 'collapse', width: '100%', marginBottom: 12 }}>
        <thead>
          <tr>{['#', 'Step', 'Label', 'PINs', 'Distinct from', 'Readings', 'Threshold', 'Sample'].map((h) => <th key={h} style={{ ...cell, background: '#eee' }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.id}>
              <td style={cell}>{s.step_order}</td>
              <td style={cell}>{STEP_TYPE_LABELS[s.step_type] || s.step_type}</td>
              <td style={cell}>{s.label}</td>
              <td style={cell}>{s.pins_required}</td>
              <td style={cell}>{s.distinct_from || ''}</td>
              <td style={cell}>{s.readings_count ? `${s.readings_count}${s.reading_unit ? ` ${s.reading_unit}` : ''}` : ''}</td>
              <td style={cell}>{s.threshold_min ?? ''}</td>
              <td style={cell}>{s.sample_qty ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: '10pt', fontWeight: 'bold', marginBottom: 4 }}>Parts ({parts.length})</div>
      <div style={{ fontSize: '9pt', fontFamily: 'Arial, Helvetica, sans-serif', columnCount: 4, columnGap: 16, marginBottom: 18 }}>
        {parts.map((p) => <div key={p.id}>{p.part_number}</div>)}
      </div>
      <div style={{ display: 'flex', gap: 32, fontSize: '10pt', marginTop: 24 }}>
        <div style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 4 }}>Quality approval (signature)</div>
        <div style={{ width: 160, borderTop: '1px solid #000', paddingTop: 4 }}>Date</div>
      </div>
    </div>
  )
}
