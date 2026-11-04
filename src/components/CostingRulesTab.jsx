import { useState, useEffect, useCallback } from 'react'
import { Plus, Loader2, X, Pencil, RefreshCw } from 'lucide-react'
import { hasRole, isReadOnlyRole } from '../lib/roles'
import { listSettings, setSetting, parseSettingValue, formatSettingValue } from '../lib/appSettings'
import { formatDateTime } from '../lib/fishbowl'

// Costing rules — Armory tab (S17 B2, D-ASM-34). The app_settings rows in category 'costing', in order: label, value
// with its unit, description, last change. Admin edits a rule in place and adds new ones (category fixed to
// 'costing') through app_setting_set, so a rule the costing system needs can be added without a deploy. Everyone
// else who reaches the tab reads it. Placeholder for the costing system (costing spec v0.4); nothing reads these yet.
const KEY_RE = /^[a-z][a-z0-9_]*$/
const field = 'w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-skynet-accent'

// A missing-function error from PostgREST means the B2b migration (category / label / unit on app_setting_set) is not in.
const rpcMessage = (e) => (e?.code === 'PGRST202'
  ? 'This database does not have the S17 B2b migration yet, so a rule\'s category, label and unit cannot be saved. Changing a value still works.'
  : e?.message || String(e))

export default function CostingRulesTab({ profile }) {
  const canEdit = hasRole(profile, 'admin') && !isReadOnlyRole(profile?.role)
  const [rules, setRules] = useState([])
  const [allKeys, setAllKeys] = useState(() => new Set())
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState(null) // { type, message }
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(null) // { key, value, label, unit, description } — the row being edited
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    try {
      const all = await listSettings()
      setAllKeys(new Set(all.map((r) => r.key)))
      setRules(all.filter((r) => r.category === 'costing'))
    } catch (e) {
      setStatus({ type: 'error', message: `Could not load the costing rules: ${e?.message || e}` })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const save = async (fn, okMessage) => {
    setBusy(true)
    try {
      await fn()
      setStatus({ type: 'success', message: okMessage })
      await load()
      return true
    } catch (e) {
      setStatus({ type: 'error', message: rpcMessage(e) })
      return false
    } finally {
      setBusy(false)
    }
  }

  const startEdit = (r) => setEditing({
    key: r.key,
    value: r.value === null || r.value === undefined ? '' : typeof r.value === 'object' ? JSON.stringify(r.value) : String(r.value),
    label: r.label || '',
    unit: r.unit || '',
    description: r.description || '',
  })

  // Only what changed is sent, so a value-only change is the plain three-argument call. A blank field keeps its value.
  const saveEdit = async (r) => {
    const opts = {}
    if (editing.label.trim() && editing.label.trim() !== (r.label || '')) opts.label = editing.label.trim()
    if (editing.unit.trim() && editing.unit.trim() !== (r.unit || '')) opts.unit = editing.unit.trim()
    if (editing.description.trim() && editing.description.trim() !== (r.description || '')) opts.description = editing.description.trim()
    if (await save(() => setSetting(r.key, parseSettingValue(editing.value), opts), `${r.label || r.key} saved.`)) setEditing(null)
  }

  return (
    <div className="space-y-4 pb-12">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Costing rules</h2>
          <p className="text-sm text-gray-400 mt-1 max-w-3xl">
            The rates and percentages SkyNet&apos;s costing will work from. This is the placeholder for the coming costing
            system (costing spec v0.4): nothing reads these numbers yet, and a rule added here waits for that system.
            {canEdit ? ' Change a value with Edit; add a rule the costing work will need with Add rule.' : ' Admins make changes.'}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canEdit && (
            <button onClick={() => setAdding((a) => !a)} className="flex items-center gap-1.5 px-3 py-2 rounded text-sm bg-purple-600 hover:bg-purple-500 text-white">
              <Plus size={14} /> Add rule
            </button>
          )}
          <button onClick={() => { setLoading(true); load() }} disabled={loading}
            className="flex items-center gap-2 px-3 py-2 rounded text-sm text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {status && (
        <div className={`p-3 rounded text-sm flex justify-between items-center ${status.type === 'success' ? 'bg-green-900/40 text-green-300 border border-green-800' : 'bg-red-900/40 text-red-300 border border-red-800'}`}>
          <span>{status.message}</span>
          <button onClick={() => setStatus(null)}><X size={14} /></button>
        </div>
      )}

      {adding && canEdit && (
        <AddRuleForm allKeys={allKeys} busy={busy} onCancel={() => setAdding(false)}
          onAdd={async (rule) => {
            // app_setting_set gives a new key sort_order 0 unless told otherwise; a new rule goes to the end of the list.
            const sortOrder = rules.reduce((m, r) => Math.max(m, Number(r.sort_order) || 0), 0) + 10
            const ok = await save(
              () => setSetting(rule.key, rule.value, { category: 'costing', label: rule.label, unit: rule.unit || null, description: rule.description || null, sortOrder }),
              `${rule.label} added.`)
            if (ok) setAdding(false)
          }} />
      )}

      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        {loading && rules.length === 0 ? (
          <div className="px-4 py-10 text-center text-gray-500 flex items-center justify-center gap-2"><Loader2 size={16} className="animate-spin" /> Loading…</div>
        ) : rules.length === 0 ? (
          <div className="px-4 py-10 text-center text-gray-500">No costing rules yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-3 text-left">Rule</th>
                <th className="px-4 py-3 text-left">Value</th>
                <th className="px-4 py-3 text-left">Description</th>
                <th className="px-4 py-3 text-left">Last changed</th>
                {canEdit && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {rules.map((r) => editing?.key === r.key ? (
                <tr key={r.key} className="align-top bg-gray-800/30">
                  <td className="px-4 py-3">
                    <input value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} placeholder="Label" className={field} />
                    <div className="text-xs text-gray-500 font-mono mt-1">{r.key}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <input autoFocus value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} className={`${field} w-28`} />
                      <input value={editing.unit} onChange={(e) => setEditing({ ...editing, unit: e.target.value })} placeholder="Unit" className={`${field} w-32`} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <textarea value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} rows={2} className={field} />
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">A blank label, unit or description keeps what is there.</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button onClick={() => setEditing(null)} className="px-2 py-1 text-xs text-gray-400 hover:text-white">Cancel</button>
                    <button disabled={busy || editing.value.trim() === ''} onClick={() => saveEdit(r)}
                      className="ml-1 px-3 py-1 rounded text-xs bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50 inline-flex items-center gap-1">
                      {busy && <Loader2 size={12} className="animate-spin" />} Save
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={r.key} className="align-top">
                  <td className="px-4 py-3">
                    <div className="text-white">{r.label || r.key}</div>
                    <div className="text-xs text-gray-500 font-mono">{r.key}</div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className="text-white font-mono">{formatSettingValue(r.value)}</span>
                    {r.unit && <span className="text-gray-400 ml-1.5">{r.unit}</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-300 max-w-md">{r.description || <span className="text-gray-600">—</span>}</td>
                  <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
                    {formatDateTime(r.updated_at)}
                    <div className="text-gray-500">{r.updated_by_name || (r.updated_by ? 'unknown user' : 'set by migration')}</div>
                  </td>
                  {canEdit && (
                    <td className="px-4 py-3 text-right">
                      <button disabled={busy || editing !== null} onClick={() => startEdit(r)}
                        className="px-2 py-1 text-xs text-gray-300 hover:text-white hover:bg-gray-800 rounded inline-flex items-center gap-1 disabled:opacity-50">
                        <Pencil size={12} /> Edit
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function AddRuleForm({ allKeys, busy, onCancel, onAdd }) {
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [unit, setUnit] = useState('')
  const [value, setValue] = useState('')
  const [description, setDescription] = useState('')
  const k = key.trim()
  const keyProblem = !k ? null
    : !KEY_RE.test(k) ? 'Lower-case letters, digits and underscores, starting with a letter.'
      : allKeys.has(k) ? 'That key is already a setting.' : null
  const ok = k && !keyProblem && label.trim() && value.trim() !== ''
  return (
    <div className="bg-gray-900 rounded-lg border border-purple-800/60 p-4 space-y-3">
      <div className="text-sm text-white font-medium">Add a costing rule</div>
      <div className="grid md:grid-cols-4 gap-3">
        <label className="block text-xs text-gray-400">Key
          <input autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. plating_markup_pct" className={`${field} mt-1 font-mono`} />
          {keyProblem && <span className="block text-amber-300 mt-1">{keyProblem}</span>}
        </label>
        <label className="block text-xs text-gray-400">Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="What people see" className={`${field} mt-1`} />
        </label>
        <label className="block text-xs text-gray-400">Value
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="A number, true / false, or text" className={`${field} mt-1`} />
        </label>
        <label className="block text-xs text-gray-400">Unit
          <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="e.g. $/hour, %" className={`${field} mt-1`} />
        </label>
      </div>
      <label className="block text-xs text-gray-400">Description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Where the number comes from and what it is for" className={`${field} mt-1`} />
      </label>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white">Cancel</button>
        <button disabled={busy || !ok}
          onClick={() => onAdd({ key: k, label: label.trim(), unit: unit.trim(), value: parseSettingValue(value), description: description.trim() })}
          className="px-3 py-1.5 rounded text-xs bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50 inline-flex items-center gap-1">
          {busy && <Loader2 size={12} className="animate-spin" />} Add rule
        </button>
      </div>
    </div>
  )
}
