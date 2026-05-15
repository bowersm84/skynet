import { supabase } from './supabase'

/**
 * Evaluate whether a single job has produced less than its target and,
 * if so, create an open job_shortfall_resolutions row. Idempotent —
 * safe to call multiple times; never creates duplicate open rows.
 *
 * Returns the resolution row id, or null when no shortfall is open.
 *
 * Trigger sites:
 *  - Kiosk Complete Job  (after status → manufacturing_complete,
 *                         good_pieces written)
 *  - ComplianceReview post-mfg Accept (after post_mfg_good_qty written;
 *                         post_mfg_good_qty takes precedence over
 *                         good_pieces because it's the compliance-verified
 *                         count)
 *
 * Cancelled jobs never generate shortfalls.
 */
export async function evaluateJobShortfall(jobId) {
  if (!jobId) return null

  const { data: job, error } = await supabase
    .from('jobs')
    .select('id, work_order_id, quantity, good_pieces, post_mfg_good_qty, status')
    .eq('id', jobId)
    .single()
  if (error || !job) return null

  // Cancelled jobs never create shortfalls.
  if (job.status === 'cancelled') return null

  const produced = job.post_mfg_good_qty ?? job.good_pieces ?? 0
  const target = job.quantity || 0
  if (target <= 0 || produced >= target) return null

  // Idempotent: existing open row?
  const { data: existing } = await supabase
    .from('job_shortfall_resolutions')
    .select('id')
    .eq('job_id', jobId)
    .eq('status', 'open')
    .maybeSingle()
  if (existing) return existing.id

  const { data: row, error: insErr } = await supabase
    .from('job_shortfall_resolutions')
    .insert({
      job_id: jobId,
      work_order_id: job.work_order_id,
      job_quantity: target,
      produced_quantity: produced,
      shortfall_quantity: target - produced,
      status: 'open',
    })
    .select('id')
    .single()
  if (insErr) {
    console.error('Failed to insert job shortfall row:', insErr)
    return null
  }

  await supabase
    .from('jobs')
    .update({ has_open_shortfall: true })
    .eq('id', jobId)

  return row.id
}

// Backwards-compat alias for the old WO-level call shape. Existing
// call sites that pass a work_order_id should be migrated to pass a
// job_id; this alias keeps the build green during the transition.
// Calling with a WO id is now a no-op (returns null).
export const evaluateShortfall = evaluateJobShortfall
