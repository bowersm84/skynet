import { useState, useEffect, useCallback, useMemo } from 'react'
import { RefreshCw, Loader2, AlertTriangle, Lock, TrendingUp } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { hasRole } from '../../lib/roles'
import { isNotAuthorized, numericOf } from './forecastUtils'
import BarForecastTable from './BarForecastTable'
import BlanksSection from './BlanksSection'
import ExceptionsPanel from './ExceptionsPanel'

const EMPTY = { bars: [], barParts: [], blankDemand: [], blankOnhand: [], exceptions: [] }

export default function RMForecastSection({ profile, materialTypes = [], barSizes = [] }) {
  // The five RPCs are role-gated to admin/scheduler/purchaser/compliance/
  // machinist (D-RMF-06, multi-role aware) and raise 'Not authorized'
  // otherwise — mirror that here so the section is hidden entirely rather
  // than erroring for everyone else.
  const canView = hasRole(profile, 'admin', 'scheduler', 'purchaser', 'compliance', 'machinist')
  // Exceptions and corrections both write part_dimensions, whose INSERT/UPDATE
  // RLS is admin/scheduler/purchaser (D-RMF-07). Compliance and machinist
  // remain read-only viewers.
  const canWriteDimensions = hasRole(profile, 'admin', 'scheduler', 'purchaser')

  const [data, setData] = useState(EMPTY)
  const [dimRows, setDimRows] = useState([])
  const [lockContext, setLockContext] = useState({})
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [gated, setGated] = useState(false)
  const [asOf, setAsOf] = useState(null)
  const [toast, setToast] = useState('')

  // Corrector name, timestamp, note, and — where job history disagrees with the
  // locked value — what that history actually says. Only fetched for parts that
  // carry a lock, and as flat queries joined in JS (never nest a PostgREST
  // select more than two levels; see Decisions, "Supabase query nesting limit").
  const loadLockContext = useCallback(async (dims) => {
    const locked = (dims || []).filter(d => d.material_locked)
    if (!locked.length) return {}

    const partNumbers = locked.map(d => d.part_number)
    const correctorIds = [...new Set(locked.map(d => d.corrected_by).filter(Boolean))]

    const [profilesRes, partsRes] = await Promise.all([
      correctorIds.length
        ? supabase.from('profiles').select('id, full_name').in('id', correctorIds)
        : Promise.resolve({ data: [] }),
      supabase.from('parts').select('id, part_number').in('part_number', partNumbers),
    ])

    const nameById = Object.fromEntries((profilesRes.data || []).map(p => [p.id, p.full_name]))
    const parts = partsRes.data || []
    const partNumberById = Object.fromEntries(parts.map(p => [p.id, p.part_number]))

    let historyByPart = {}
    if (parts.length) {
      const { data: jobs } = await supabase
        .from('jobs')
        .select('id, component_id')
        .in('component_id', parts.map(p => p.id))
      const jobList = jobs || []
      if (jobList.length) {
        const partByJob = Object.fromEntries(
          jobList.map(j => [j.id, partNumberById[j.component_id]]),
        )
        const { data: mats } = await supabase
          .from('job_materials')
          .select('job_id, material_type, bar_size')
          .in('job_id', jobList.map(j => j.id))
        const tally = {}
        for (const m of mats || []) {
          const pn = partByJob[m.job_id]
          if (!pn || !m.bar_size) continue
          const key = `${pn}|||${m.bar_size}`
          tally[key] = (tally[key] || 0) + 1
        }
        for (const [key, jobsCount] of Object.entries(tally)) {
          const [pn, barSize] = key.split('|||')
          const best = historyByPart[pn]
          if (!best || jobsCount > best.jobs) historyByPart[pn] = { bar_size: barSize, jobs: jobsCount }
        }
      }
    }

    const out = {}
    for (const d of locked) {
      const hist = historyByPart[d.part_number]
      out[d.part_number] = {
        corrected_by_name: nameById[d.corrected_by] || null,
        corrected_at: d.corrected_at || null,
        correction_note: d.correction_note || null,
        // Informational only — the lock outranks history in the RPCs (D-RMF-04).
        history: hist && hist.bar_size !== d.bar_size ? hist : null,
      }
    }
    return out
  }, [])

  const loadAll = useCallback(async ({ silent = false } = {}) => {
    if (silent) setRefreshing(true); else setLoading(true)
    setError('')
    setGated(false)
    try {
      const [bars, barParts, blankDemand, blankOnhand, exceptions] = await Promise.all([
        supabase.rpc('forecast_rm_bars'),
        supabase.rpc('forecast_rm_bar_parts'),
        supabase.rpc('forecast_blank_demand'),
        supabase.rpc('forecast_blank_onhand'),
        supabase.rpc('forecast_rm_exceptions'),
      ])

      const firstError = [bars, barParts, blankDemand, blankOnhand, exceptions]
        .map(r => r.error)
        .find(Boolean)
      if (firstError) {
        if (isNotAuthorized(firstError)) {
          setGated(true)
          setData(EMPTY)
          return
        }
        throw firstError
      }

      setData({
        bars: bars.data || [],
        barParts: barParts.data || [],
        blankDemand: blankDemand.data || [],
        blankOnhand: blankOnhand.data || [],
        exceptions: exceptions.data || [],
      })

      // Existing dimension rows drive three things: prefill for the editors, the
      // stored string format for the material / bar size selects (so a saved row
      // groups with the rows already in the forecast), and the lock badges.
      const { data: dims, error: dimsError } = await supabase
        .from('part_dimensions')
        .select('part_number, length_in, material_type, bar_size, source_file, material_locked, correction_note, corrected_by, corrected_at')
      const dimList = dimsError ? [] : (dims || [])
      setDimRows(dimList)

      try {
        setLockContext(await loadLockContext(dimList))
      } catch {
        // Badge detail is a nicety — never let it fail the whole load.
        setLockContext({})
      }

      setAsOf(new Date())
    } catch (err) {
      setError(err.message || 'Failed to load the forecast.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [loadLockContext])

  useEffect(() => {
    if (canView) loadAll()
    else setLoading(false)
  }, [canView, loadAll])

  useEffect(() => {
    if (!toast) return undefined
    const t = setTimeout(() => setToast(''), 6000)
    return () => clearTimeout(t)
  }, [toast])

  const dimsByPart = useMemo(() => {
    const map = {}
    for (const r of dimRows) map[r.part_number] = r
    return map
  }, [dimRows])

  // Catalog options, but rendered in whatever string format part_dimensions
  // already uses for the same material / size — the catalog string is only the
  // fallback when nothing comparable has been stored yet.
  const materialOptions = useMemo(() => {
    const observed = [...new Set(dimRows.map(r => r.material_type).filter(Boolean))]
    const byLower = new Map(observed.map(m => [m.toLowerCase(), m]))
    const out = []
    for (const mt of materialTypes) {
      const name = mt?.name
      if (!name) continue
      const value = byLower.get(name.toLowerCase()) || name
      if (!out.includes(value)) out.push(value)
    }
    for (const m of observed) if (!out.includes(m)) out.push(m)
    return out.sort((a, b) => a.localeCompare(b))
  }, [dimRows, materialTypes])

  const barSizeOptions = useMemo(() => {
    const observed = [...new Set(dimRows.map(r => r.bar_size).filter(Boolean))]
    const byNum = new Map()
    for (const s of observed) {
      const n = numericOf(s)
      if (n != null && !byNum.has(n)) byNum.set(n, s)
    }
    const out = []
    for (const bs of barSizes) {
      const n = bs?.size_decimal != null ? Number(bs.size_decimal) : numericOf(bs?.size)
      const value = (n != null && byNum.get(n)) || bs?.size
      if (!value || out.some(o => o.value === value)) continue
      out.push({ value, label: value, num: n })
    }
    for (const s of observed) {
      if (out.some(o => o.value === s)) continue
      out.push({ value: s, label: s, num: numericOf(s) })
    }
    return out.sort((a, b) => {
      if (a.num != null && b.num != null && a.num !== b.num) return a.num - b.num
      return String(a.value).localeCompare(String(b.value))
    })
  }, [dimRows, barSizes])

  if (!canView) return null

  const header = (
    <div className="flex items-center justify-between gap-4 flex-wrap">
      <div className="flex items-center gap-3">
        <TrendingUp size={20} className="text-skynet-accent" />
        <div>
          <h2 className="text-lg font-semibold text-white">Raw Material Forecast</h2>
          <p className="text-xs text-gray-500">
            Weekly bar runout and blank coverage from scheduled production.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {asOf && (
          <span className="text-xs text-gray-500">
            as of {asOf.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
          </span>
        )}
        <button
          type="button"
          onClick={() => loadAll({ silent: true })}
          disabled={loading || refreshing}
          className="flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 text-gray-200 text-sm rounded-lg transition-colors"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>
    </div>
  )

  return (
    <div className="space-y-5">
      {header}

      {toast && (
        <div className="rounded-lg border border-green-800/50 bg-green-900/20 px-4 py-3 text-sm text-green-200">
          {toast}
        </div>
      )}

      {gated && (
        <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-10 text-center">
          <Lock size={40} className="mx-auto text-gray-600 mb-3" />
          <p className="text-gray-300 font-medium">Forecast access is limited</p>
          <p className="text-gray-500 text-sm mt-1">
            The raw material forecast is available to the admin, scheduler, purchaser, compliance, and machinist roles.
          </p>
        </div>
      )}

      {!gated && error && (
        <div className="bg-red-900/20 border border-red-800/50 rounded-lg p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-red-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-red-200 text-sm font-medium">Couldn&apos;t load the forecast</p>
            <p className="text-red-300/70 text-xs mt-1">{error}</p>
          </div>
        </div>
      )}

      {!gated && !error && loading && (
        <div className="flex items-center justify-center gap-2 py-16 text-gray-500">
          <Loader2 size={20} className="animate-spin" />
          <span className="text-sm">Loading forecast…</span>
        </div>
      )}

      {!gated && !error && !loading && (
        <>
          <ExceptionsPanel
            exceptions={data.exceptions}
            dimsByPart={dimsByPart}
            materialOptions={materialOptions}
            barSizeOptions={barSizeOptions}
            canSave={canWriteDimensions}
            profile={profile}
            onSaved={() => loadAll({ silent: true })}
          />

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-300">Bar Stock Forecast</h3>
            <BarForecastTable
              bars={data.bars}
              barParts={data.barParts}
              dimsByPart={dimsByPart}
              lockContext={lockContext}
              materialOptions={materialOptions}
              barSizeOptions={barSizeOptions}
              canCorrect={canWriteDimensions}
              profile={profile}
              onCorrected={async (message) => {
                await loadAll({ silent: true })
                if (message) setToast(message)
              }}
            />
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-300">Blanks</h3>
            <BlanksSection demand={data.blankDemand} onhand={data.blankOnhand} />
          </div>
        </>
      )}
    </div>
  )
}
