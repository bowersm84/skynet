// lib/appSettings.js — app_settings (S17 B1 / B2, D-ASM-15 / D-ASM-34): one jsonb value per key, with a category,
// label, unit and order since B2. Everyone signed in reads; app_setting_set (admin) writes. Costing rules are the
// rows in category 'costing' (Armory → Costing rules); the assembly keys are category 'assembly'.
import { supabase } from './supabase'

// → { [key]: value }
export async function getSettings() {
  const { data, error } = await supabase.from('app_settings').select('key, value')
  if (error) throw error
  return Object.fromEntries((data || []).map((r) => [r.key, r.value]))
}

// Every setting (category null) or one category's, in order, with the name of whoever last changed it.
export async function listSettings(category = null) {
  let q = supabase.from('app_settings').select('key, value, category, label, unit, sort_order, description, updated_by, updated_at')
  if (category) q = q.eq('category', category)
  const { data, error } = await q.order('category').order('sort_order').order('key')
  if (error) throw error
  const rows = data || []
  const ids = [...new Set(rows.map((r) => r.updated_by).filter(Boolean))]
  let names = {}
  if (ids.length) {
    const { data: people } = await supabase.from('profiles').select('id, full_name').in('id', ids)
    names = Object.fromEntries((people || []).map((p) => [p.id, p.full_name]))
  }
  return rows.map((r) => ({ ...r, updated_by_name: r.updated_by ? names[r.updated_by] || null : null }))
}

// opts: { description, category, label, unit, sortOrder } — only what is given is sent, and anything not given
// keeps its current value. A key + value change is the three-argument call B1 always had; category, label, unit and
// order need the B2b migration.
export function setSetting(key, value, opts = {}) {
  const args = { p_key: key, p_value: value }
  if (opts.description != null) args.p_description = opts.description
  if (opts.category != null) args.p_category = opts.category
  if (opts.label != null) args.p_label = opts.label
  if (opts.unit != null) args.p_unit = opts.unit
  if (opts.sortOrder != null) args.p_sort_order = opts.sortOrder
  return supabase.rpc('app_setting_set', args).then(({ error }) => { if (error) throw error })
}

// What someone types into a value box → the jsonb stored: a number when it reads as one, true / false, else the text.
export function parseSettingValue(text) {
  const t = String(text ?? '').trim()
  if (t === '') return null
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true'
  return t
}

// A stored value → what the page shows.
export function formatSettingValue(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return v.toLocaleString(undefined, { maximumFractionDigits: 4 })
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}
