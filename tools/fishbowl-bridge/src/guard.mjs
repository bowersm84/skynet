// guard.mjs — bridge v1.11 per-family guard (D-ASM-23), generalised from the v1.9 shipmentsCycleGuarded().
//
// guarded(family, fn, { retryMs }) runs one poller step and never lets it throw: a failure is logged, recorded in
// fb_sync_state.family_errors through fb_family_error (best effort: a SkyNet outage must not turn into a second
// failure), and that family alone stands down for retryMs so a broken query cannot hot-loop every 20 s. Every other
// family keeps running. The six families with their own upsert RPC (picks, ships, mos, boms, tags, postings) clear
// their key on their next success inside that RPC; the guard keeps { lastMs, ok } per family for the heartbeat.
//
// D-FB-61: the families in clearFamilies have no upsert RPC of their own, so the guard clears their entry with
// fb_family_ok after a success. It does so on the family's first success in this process (an entry may be left over
// from before a restart) and on the first success after each failure, not on every 20 s cycle; a clear that fails is
// logged and retried on the next success, and never fails the step.

export function makeGuard({ sky, log, defaultRetryMs = 900000, now = () => Date.now(), clearFamilies = [] }) {
  const pausedUntil = new Map()
  const state = new Map() // family -> { lastMs, ok, message } of its last run; a failure stays until the next success
  const clears = new Set(clearFamilies)
  const needsClear = new Set(clearFamilies)

  async function guarded(family, fn, { retryMs = defaultRetryMs, detail = null } = {}) {
    if (now() < (pausedUntil.get(family) || 0)) return undefined
    const started = now()
    try {
      const value = await fn()
      state.set(family, { lastMs: now() - started, ok: true, message: null })
      if (needsClear.has(family)) {
        try {
          await sky.familyOk(family)
          needsClear.delete(family)
        } catch (e2) {
          log.warn(`${family}: could not clear its family_errors entry (retried on the next success): ${e2.message}`)
        }
      }
      return value
    } catch (e) {
      const message = `${e.name || 'Error'}: ${e.message}`
      pausedUntil.set(family, now() + retryMs)
      state.set(family, { lastMs: now() - started, ok: false, message })
      if (clears.has(family)) needsClear.add(family)
      const extra = typeof detail === 'function' ? ` ${detail()}` : ''
      log.error(`${family} failed, retrying in ${Math.round(retryMs / 1000)} s${extra}: ${message}`)
      try {
        await sky.familyError(family, message.slice(0, 500))
      } catch (e2) {
        log.warn(`${family}: could not record the failure in fb_sync_state: ${e2.message}`)
      }
      return undefined
    }
  }

  return {
    guarded,
    // { lastMs, ok } for each named family; a family that has not run yet is { lastMs: null, ok: null }.
    snapshot: (families) => Object.fromEntries(families.map((f) => {
      const s = state.get(f)
      return [f, s ? { lastMs: s.lastMs, ok: s.ok } : { lastMs: null, ok: null }]
    })),
    // "family: message" for each named family whose last run failed (standing down included), in the given order.
    failing: (families) => families.filter((f) => state.get(f)?.ok === false).map((f) => `${f}: ${state.get(f).message}`),
    isPaused: (family) => now() < (pausedUntil.get(family) || 0),
  }
}
