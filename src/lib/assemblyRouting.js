// lib/assemblyRouting.js — where a component job goes once its finishing, outsourcing or post-manufacturing
// compliance is done (S17 B.1, D-ASM-30; the deferred item of D-NEST-13). Pure: no Supabase import, so
// `node --test src/lib/assemblyRouting.test.mjs` runs it as is. The I/O lives in finishingCompletion.js.
//
// Before S17 the rule was part-type based: a finished_good always skipped assembly (pending_tco), anything else went
// to ready_for_assembly when ASSEMBLY_MODULE was on. That stranded a finished good that is itself a component of a
// larger assembly (SK2003-10A inside SK2003-14A / -24A / -42A / SK2003-51ADJ) and sent a standalone component job to
// an assembly that does not exist. The rule is now about the assembly the job feeds:
//   flag off                                              → pending_tco (PROD behaviour unchanged until cutover)
//   flag on, the job feeds a live WOA or an open build    → ready_for_assembly (whatever the part type)
//   flag on, it feeds nothing                             → pending_tco
// A pending external step is handled before this by each caller (ready_for_outsourcing), as it always was.

// An assembly build that has not been released or cancelled still needs its components.
export const LIVE_BUILD_STATUSES = [
  'requested', 'assigned', 'in_progress', 'paused', 'complete', 'ready_for_outsource', 'at_external_vendor', 'pending_tco',
]

// woa: the job's work_order_assemblies row ({ status }) or null; build: an assembly_builds row linked to that WOA or null.
export function feedsLiveAssembly({ woa = null, build = null } = {}) {
  if (build && LIVE_BUILD_STATUSES.includes(build.status)) return true
  return !!woa && woa.status !== 'complete'
}

export function componentNextStatus({ assemblyModule, woa = null, build = null }) {
  if (!assemblyModule) return 'pending_tco'
  return feedsLiveAssembly({ woa, build }) ? 'ready_for_assembly' : 'pending_tco'
}
