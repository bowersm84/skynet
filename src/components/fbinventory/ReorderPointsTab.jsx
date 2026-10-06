// ReorderPointsTab — S13 D-FBINV-02/03. Armory › Fishbowl Inventory › Reorder Points.
// SkyNet-owned minimums for critical Fishbowl Product parts, seeded from Purchasing's sheet.
// Basis is ON HAND across every location group (D-FBINV-01). fb_reorder_evaluate() sets each
// rule's alert_state after every 5-minute inventory refresh and after every edit here, and
// rings a bell for purchasers and admins on the ok → below crossing only (D-FBINV-02).
// Writes: admin + purchaser (canEditReorderPoints). Everyone else in the group reads.
// Exports: CSV (the registry's columns) and Excel (D-FBINV-04), in the order on screen. Layout
// fits the Armory's max-w-7xl box at 1280 px: part numbers wrap, descriptions and vendors
// truncate (full text on hover), the shortfall note stacks under the status chip.
import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react'
import { Search, RefreshCw, Loader2, Download, Plus, Edit2, Trash2, X, Power, PowerOff, Flag, Clock, AlertTriangle, CheckCircle, FileSpreadsheet } from 'lucide-react'
import { canViewFbInventory, canEditReorderPoints, canExportFbInventory } from '../../lib/roles'
import { formatDateTime } from '../../lib/fishbowl'
import { toCsv, downloadCsv, reportFilename } from '../../lib/reports'
import { REORDER_CATEGORIES, reorderView, groupByCategory, matchesSearch, partKey, parseMinQty, isStale, freshness } from '../../lib/fbStock'
import { buildReorderXlsx, reorderXlsxFilename, todayIso, XLSX_MIME } from '../../lib/fbStockExport'
import { downloadBytes } from '../../lib/priceListDoc'
import {
  loadReorderPoints, searchProductParts, saveRule, setRuleActive, deleteRule, evaluateRules, REORDER_CSV_COLUMNS,
} from './fbInventoryData'

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'below', label: 'Below min' },
  { key: 'no_min', label: 'No min set' },
  { key: 'inactive', label: 'Inactive' },
]

const fmtQty = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }))
const EMPTY_FORM = { id: null, part_num: '', partPicked: false, description: '', on_hand: null, category: REORDER_CATEGORIES[0], min_qty: '', vendor: '', notes: '' }
const inputCls = 'w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent disabled:opacity-60'

function evaluationNote(res) {
  if (!res) return ''
  if (res.evaluationError) return ' · re-evaluation failed, the next 5-minute cycle will catch it'
  const e = res.evaluation
  if (!e) return ''
  const below = `${e.below} below minimum`
  return e.newly_below > 0 ? ` · ${below} · ${e.newly_below} newly below, bell sent` : ` · ${below}`
}

export default function ReorderPointsTab({ profile, onBelowCountChange }) {
  const canView = canViewFbInventory(profile)
  const canEdit = canEditReorderPoints(profile)
  const canExport = canExportFbInventory(profile)

  const [rules, setRules] = useState([])
  const [statusRows, setStatusRows] = useState([])
  const [sync, setSync] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [toast, setToast] = useState('')
  const [busyId, setBusyId] = useState(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [modalError, setModalError] = useState('')
  const [saving, setSaving] = useState(false)
  const [suggestions, setSuggestions] = useState([])
  const [searching, setSearching] = useState(false)
  const searchSeq = useRef(0)

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true)
    setError('')
    try {
      const data = await loadReorderPoints()
      setRules(data.rules)
      setStatusRows(data.statusRows)
      setSync(data.sync)
      onBelowCountChange?.(data.rules.filter(r => r.is_active && r.alert_state === 'below').length)
    } catch (e) {
      console.error('Reorder Points load failed:', e)
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [onBelowCountChange])

  useEffect(() => { if (canView) load() }, [canView, load])

  useEffect(() => {
    if (!toast) return undefined
    const t = setTimeout(() => setToast(''), 6000)
    return () => clearTimeout(t)
  }, [toast])

  const fresh = freshness(sync)
  const views = useMemo(() => rules.map(r => ({ rule: r, view: reorderView(r, r.status) })), [rules])
  const belowCount = views.filter(v => v.view.state === 'below').length
  const filterCounts = useMemo(() => {
    const c = { all: 0, below: 0, no_min: 0, inactive: 0 }
    for (const v of views) {
      if (!matchesSearch({ part_number: v.rule.part_num, description: v.rule.status?.description, vendor: v.rule.vendor }, search, ['part_number', 'description', 'vendor'])) continue
      c.all++
      if (c[v.view.state] !== undefined) c[v.view.state]++
    }
    return c
  }, [views, search])

  const visible = views.filter(v =>
    (filter === 'all' || v.view.state === filter)
    && matchesSearch({ part_number: v.rule.part_num, description: v.rule.status?.description, vendor: v.rule.vendor }, search, ['part_number', 'description', 'vendor']))
  const viewById = new Map(visible.map(v => [v.rule.id, v.view]))
  const groups = groupByCategory(visible.map(v => v.rule))

  const exportCsv = () => {
    const keep = new Set(visible.map(v => v.rule.part_num))
    const csv = toCsv(statusRows.filter(r => keep.has(r.part_number)), REORDER_CSV_COLUMNS)
    downloadCsv(csv, reportFilename('fb-reorder-status'))
  }

  const exportXlsx = () => {
    try {
      const view = FILTERS.find(f => f.key === filter)?.label || filter
      const bytes = buildReorderXlsx({ rules: groups.flatMap(g => g.items), viewLabel: view, search, sync })
      downloadBytes(bytes, reorderXlsxFilename(todayIso()), XLSX_MIME)
    } catch (e) {
      console.error('Reorder Points Excel export failed:', e)
      setError(`Excel export failed: ${e?.message || String(e)}`)
    }
  }

  const reEvaluate = async () => {
    setRefreshing(true)
    try {
      const e = await evaluateRules()
      setToast(`Re-evaluated ${e.evaluated} rules · ${e.below} below minimum${e.newly_below > 0 ? ` · ${e.newly_below} newly below, bell sent` : ''}`)
      await load(true)
    } catch (e) {
      setError(e?.message || String(e))
      setRefreshing(false)
    }
  }

  // --- modal
  const openAdd = () => {
    setForm(EMPTY_FORM)
    setSuggestions([])
    setModalError('')
    setModalOpen(true)
  }
  const openEdit = (rule) => {
    setForm({
      id: rule.id,
      part_num: rule.part_num,
      partPicked: true,
      description: rule.status?.description || '',
      on_hand: rule.status?.on_hand ?? null,
      category: rule.category || 'Misc.',
      min_qty: rule.min_qty === null || rule.min_qty === undefined ? '' : String(rule.min_qty),
      vendor: rule.vendor || '',
      notes: rule.notes || '',
    })
    setSuggestions([])
    setModalError('')
    setModalOpen(true)
  }

  const onPartInput = async (text) => {
    setForm(f => ({ ...f, part_num: text, partPicked: false, description: '', on_hand: null }))
    const seq = ++searchSeq.current
    if (text.trim().length < 2) { setSuggestions([]); return }
    setSearching(true)
    try {
      const found = await searchProductParts(text)
      if (seq === searchSeq.current) setSuggestions(found)
    } catch (e) {
      if (seq === searchSeq.current) setModalError(e?.message || String(e))
    } finally {
      if (seq === searchSeq.current) setSearching(false)
    }
  }

  const pickPart = (p) => {
    setForm(f => ({ ...f, part_num: p.part_num, partPicked: true, description: p.description || '', on_hand: p.qty_on_hand }))
    setSuggestions([])
  }

  const handleSave = async () => {
    setModalError('')
    if (!form.partPicked || !form.part_num.trim()) { setModalError('Pick a Fishbowl Product part from the list.'); return }
    const min = parseMinQty(form.min_qty)
    if (!min.ok) { setModalError('Minimum must be a number of pieces, 0 or more — or blank for no minimum yet.'); return }
    if (!form.category) { setModalError('Pick a category.'); return }
    if (!form.id && rules.some(r => partKey(r.part_num) === partKey(form.part_num))) {
      setModalError(`${form.part_num} already has a reorder rule. Edit that one instead.`)
      return
    }
    setSaving(true)
    try {
      const res = await saveRule({ id: form.id, part_num: form.part_num, category: form.category, min_qty: min.value, vendor: form.vendor, notes: form.notes }, profile?.id)
      setModalOpen(false)
      setToast(`${form.id ? 'Saved' : 'Added'} ${form.part_num}${evaluationNote(res)}`)
      await load(true)
    } catch (e) {
      const msg = e?.code === '23505' ? `${form.part_num} already has a reorder rule.` : (e?.message || String(e))
      setModalError(msg)
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (rule) => {
    setBusyId(rule.id)
    try {
      const res = await setRuleActive(rule, !rule.is_active, profile?.id)
      setToast(`${rule.part_num} ${rule.is_active ? 'deactivated — it will not alert' : 'activated'}${evaluationNote(res)}`)
      await load(true)
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (rule) => {
    if (!window.confirm(`Delete the reorder rule for ${rule.part_num}?\n\nDeactivate keeps it on the list without alerting; delete removes it.`)) return
    setBusyId(rule.id)
    try {
      await deleteRule(rule)
      setToast(`Deleted the rule for ${rule.part_num}`)
      await load(true)
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setBusyId(null)
    }
  }

  if (!canView) return null

  const categoryOptions = [...new Set([...REORDER_CATEGORIES, ...rules.map(r => r.category).filter(Boolean)])]
  const colCount = canEdit ? 10 : 9

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-white flex items-center gap-2"><Flag size={18} /> Reorder Points</h2>
          <p className="text-sm text-gray-500">Minimum on-hand pieces for critical Fishbowl parts. Checked after every 5-minute refresh; purchasers and admins get a bell when a part first drops below its minimum.</p>
        </div>
        <div className="flex items-center gap-2">
          {canExport && (
            <>
              <button onClick={exportXlsx} disabled={loading || visible.length === 0} title="The rules on screen, in this order, as an Excel workbook" className="inline-flex items-center gap-2 px-3 py-2 bg-gray-800 border border-gray-700 hover:border-gray-500 text-gray-200 text-sm rounded-lg disabled:opacity-50">
                <FileSpreadsheet size={15} /> Excel
              </button>
              <button onClick={exportCsv} disabled={loading || visible.length === 0} className="inline-flex items-center gap-2 px-3 py-2 bg-gray-800 border border-gray-700 hover:border-gray-500 text-gray-200 text-sm rounded-lg disabled:opacity-50">
                <Download size={15} /> CSV
              </button>
            </>
          )}
          {canEdit ? (
            <button onClick={reEvaluate} disabled={loading || refreshing} className="inline-flex items-center gap-2 px-3 py-2 bg-gray-800 border border-gray-700 hover:border-gray-500 text-gray-200 text-sm rounded-lg disabled:opacity-50">
              <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /> Re-evaluate
            </button>
          ) : (
            <button onClick={() => load(true)} disabled={loading || refreshing} className="inline-flex items-center gap-2 px-3 py-2 bg-gray-800 border border-gray-700 hover:border-gray-500 text-gray-200 text-sm rounded-lg disabled:opacity-50">
              <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </button>
          )}
          {canEdit && (
            <button onClick={openAdd} className="inline-flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-skynet-accent/80 text-white text-sm rounded-lg transition-colors">
              <Plus size={16} /> Add Rule
            </button>
          )}
        </div>
      </div>

      {!loading && (belowCount > 0 ? (
        <div className="flex items-center gap-2 text-sm bg-amber-900/10 border border-amber-800/40 rounded-lg px-3 py-2">
          <AlertTriangle size={15} className="text-amber-400" />
          <span className="text-amber-200">{belowCount} part{belowCount === 1 ? '' : 's'} below minimum</span>
          <span className="text-gray-500 text-xs">· evaluated with the Fishbowl snapshot of {formatDateTime(fresh.inventoryAt)}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm bg-green-900/10 border border-green-800/40 rounded-lg px-3 py-2">
          <CheckCircle size={15} className="text-green-400" />
          <span className="text-green-200">Every active rule is at or above its minimum</span>
          <span className="text-gray-500 text-xs">· Fishbowl snapshot of {formatDateTime(fresh.inventoryAt)}</span>
        </div>
      ))}
      {fresh.amber && !loading && (
        <div className="text-xs text-amber-300 flex items-center gap-2"><Clock size={13} /> Fishbowl inventory is more than 15 minutes old — the bridge may be behind, so statuses may be too.</div>
      )}

      {toast && <div className="text-sm text-green-200 bg-green-900/20 border border-green-800/40 rounded-lg px-3 py-2">{toast}</div>}
      {error && <div className="text-sm text-red-300 bg-red-900/20 border border-red-800/50 rounded-lg px-3 py-2">{error}</div>}

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[16rem] max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Part #, description or vendor"
            className="w-full pl-9 pr-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-skynet-accent" />
        </div>
        <div className="flex items-center gap-1">
          {FILTERS.map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${filter === f.key ? 'bg-skynet-accent/20 border-skynet-accent text-skynet-accent' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'}`}>
              {f.label} <span className="opacity-70">{filterCounts[f.key] || 0}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-gray-400"><Loader2 size={18} className="animate-spin" /> Loading reorder points…</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-700">
          <table className="w-full text-sm">
            <thead className="bg-gray-800 text-gray-400 uppercase text-xs">
              <tr className="whitespace-nowrap">
                <th className="px-2 py-2.5 text-left">Part #</th>
                <th className="px-2 py-2.5 text-left">Description</th>
                <th className="px-2 py-2.5 text-right">Min</th>
                <th className="px-2 py-2.5 text-right">On Hand</th>
                <th className="px-2 py-2.5 text-right">Available</th>
                <th className="px-2 py-2.5 text-right">On Order</th>
                <th className="px-2 py-2.5 text-left">Status</th>
                <th className="px-2 py-2.5 text-left">Vendor</th>
                <th className="px-2 py-2.5 text-center">Active</th>
                {canEdit && <th className="px-2 py-2.5 text-center">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {groups.length === 0 ? (
                <tr><td colSpan={colCount} className="px-3 py-10 text-center text-gray-500">{rules.length === 0 ? 'No reorder rules yet.' : 'No rules match.'}</td></tr>
              ) : groups.map(g => (
                <Fragment key={g.category}>
                  <tr className="bg-gray-800/60">
                    <td colSpan={colCount} className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-300">{g.category} <span className="text-gray-500 font-normal">· {g.items.length}</span></td>
                  </tr>
                  {g.items.map(rule => {
                    const v = viewById.get(rule.id)
                    const s = rule.status
                    const stale = isStale(s?.inventory_as_of, fresh.inventoryAt)
                    return (
                      <tr key={rule.id} className={`bg-gray-900 hover:bg-gray-800/70 ${rule.is_active ? '' : 'opacity-50'}`}>
                        <td className="px-2 py-2 font-mono text-gray-200 max-w-[10rem] break-words">
                          {rule.part_num}
                          {stale && <span title={`Fishbowl snapshot ${formatDateTime(s?.inventory_as_of)}`}><Clock size={12} className="inline ml-1 text-gray-500" /></span>}
                        </td>
                        <td className="px-2 py-2 text-gray-400 max-w-[13rem] truncate" title={s?.description || ''}>{s?.description || '—'}</td>
                        <td className="px-2 py-2 text-right font-mono whitespace-nowrap text-gray-300">{rule.min_qty === null || rule.min_qty === undefined ? '—' : fmtQty(rule.min_qty)}</td>
                        <td className={`px-2 py-2 text-right font-mono whitespace-nowrap ${v.state === 'below' ? 'text-amber-300 font-semibold' : 'text-white'}`}>{fmtQty(s?.on_hand)}</td>
                        <td className={`px-2 py-2 text-right font-mono whitespace-nowrap ${Number(s?.available) < 0 ? 'text-amber-300' : 'text-gray-400'}`}>{fmtQty(s?.available)}</td>
                        <td className="px-2 py-2 text-right font-mono whitespace-nowrap text-gray-400">{Number(s?.on_order) > 0 ? fmtQty(s.on_order) : '—'}</td>
                        <td className="px-2 py-2">
                          <span className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${v.tone}`}>{v.label}</span>
                          {v.shortfall > 0 && (
                            <div className="text-[11px] text-gray-500 mt-0.5 leading-tight">
                              <div className="whitespace-nowrap">short {fmtQty(v.shortfall)}</div>
                              {v.onOrderCovers && <div className="whitespace-nowrap">on order covers it</div>}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-2 text-gray-400 max-w-[10rem] truncate" title={[rule.vendor, rule.notes].filter(Boolean).join(' — ')}>{rule.vendor || '—'}</td>
                        <td className="px-2 py-2 text-center">
                          {canEdit ? (
                            <button onClick={() => toggleActive(rule)} disabled={busyId === rule.id} title={rule.is_active ? 'Deactivate' : 'Activate'} className="text-gray-400 hover:text-white disabled:opacity-50">
                              {busyId === rule.id ? <Loader2 size={16} className="animate-spin" /> : rule.is_active ? <Power size={16} className="text-green-400" /> : <PowerOff size={16} />}
                            </button>
                          ) : (
                            rule.is_active ? <Power size={16} className="mx-auto text-green-400" /> : <PowerOff size={16} className="mx-auto text-gray-600" />
                          )}
                        </td>
                        {canEdit && (
                          <td className="px-2 py-2">
                            <div className="flex items-center justify-center gap-2">
                              <button onClick={() => openEdit(rule)} className="text-gray-400 hover:text-white" title="Edit"><Edit2 size={14} /></button>
                              <button onClick={() => remove(rule)} disabled={busyId === rule.id} className="text-gray-400 hover:text-red-400 disabled:opacity-50" title="Delete"><Trash2 size={14} /></button>
                            </div>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">{form.id ? 'Edit' : 'Add'} Reorder Rule</h2>
              <button onClick={() => setModalOpen(false)} className="text-gray-400 hover:text-white"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <div className="relative">
                <label className="text-xs text-gray-400 uppercase tracking-wide">Fishbowl Part # *</label>
                <input
                  type="text"
                  value={form.part_num}
                  onChange={e => onPartInput(e.target.value)}
                  disabled={!!form.id}
                  placeholder="Type 2+ characters"
                  className={`${inputCls} font-mono`}
                />
                {searching && <Loader2 size={14} className="absolute right-3 top-9 animate-spin text-gray-500" />}
                {!form.id && suggestions.length > 0 && (
                  <div className="absolute left-0 right-0 mt-1 z-10 max-h-60 overflow-y-auto bg-gray-800 border border-gray-700 rounded-lg shadow-xl">
                    {suggestions.map(p => (
                      <button key={p.part_num} onClick={() => pickPart(p)} className="w-full text-left px-3 py-2 hover:bg-gray-700 border-b border-gray-700/60 last:border-b-0">
                        <div className="font-mono text-sm text-white">{p.part_num}</div>
                        <div className="text-xs text-gray-400 truncate">{p.description || '—'} · {fmtQty(p.qty_on_hand)} on hand</div>
                      </button>
                    ))}
                  </div>
                )}
                {form.partPicked && (
                  <p className="mt-1 text-xs text-gray-500">{form.description || '—'}{form.on_hand !== null && form.on_hand !== undefined ? ` · ${fmtQty(form.on_hand)} on hand` : ''}</p>
                )}
                {form.id && <p className="mt-1 text-xs text-gray-500">The part is fixed on an existing rule. Delete and re-add to change it.</p>}
              </div>
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Category *</label>
                <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} className={inputCls}>
                  {categoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Minimum on hand (pieces)</label>
                <input type="text" inputMode="numeric" value={form.min_qty} onChange={e => setForm(f => ({ ...f, min_qty: e.target.value }))} placeholder="Blank = no minimum yet" className={`${inputCls} font-mono`} />
                <p className="mt-1 text-xs text-gray-500">Compared with on hand across every Fishbowl location. A rule with no minimum stays on the list and never alerts.</p>
              </div>
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Vendor</label>
                <input type="text" value={form.vendor} onChange={e => setForm(f => ({ ...f, vendor: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Notes</label>
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} className={inputCls} />
              </div>
              {modalError && <p className="text-sm text-red-400">{modalError}</p>}
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-skynet-accent hover:bg-skynet-accent/80 text-white text-sm rounded-lg transition-colors disabled:opacity-60">
                {saving ? 'Saving…' : (form.id ? 'Save Changes' : 'Add Rule')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
