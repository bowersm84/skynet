// lib/assembly.js — S17 assembly builds (D-ASM-20): thin wrappers over the B1 RPCs and views for Jody's
// Assembly Board and Roger's checklist review. Every write is a SECURITY DEFINER RPC gated server-side
// (builds: admin / assembly; checklists: admin / compliance). An RPC's error message is written for people, so
// callers show it as is. Settings (labor rate, overhead, lot prefix) live in lib/appSettings.js since B2.
import { supabase } from './supabase'

const rpc = async (name, args = {}) => {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw error
  return data
}

// ── Labels ─────────────────────────────────────────────────────────────────
export const BUILD_STATUS_LABELS = {
  requested: 'Requested', assigned: 'Assigned', in_progress: 'In progress', paused: 'Paused', complete: 'Complete',
  ready_for_outsource: 'Ready for outsource', at_external_vendor: 'At vendor', pending_tco: 'Pending TCO',
  released: 'Released', cancelled: 'Cancelled',
}
export const BUILD_KIND_LABELS = { order: 'Order', stock: 'Stock', special: 'Special', rework: 'Rework', program: 'Program' }
export const POST_STATUS_LABELS = {
  not_posted: 'Not posted', ready_to_post: 'Ready to post', posted: 'Posted', verified: 'Verified', mismatch: 'Mismatch',
  not_applicable: 'No Fishbowl post',
}
export const PRIORITIES = ['critical', 'high', 'normal', 'low']
export const STEP_TYPE_LABELS = {
  pull: 'Pull', pull_check: 'Pull check', assemble: 'Assemble', pressure_test: 'Pressure test', crimp_check: 'Crimp check',
  gauge_check: 'Gauge check', tensile_shear: 'Tensile-shear', inspect: 'Inspect', release: 'Release', instruction: 'Instruction',
}
// Builds that are still on the floor (not released, not cancelled).
export const ACTIVE_BUILD_STATUSES = ['requested', 'assigned', 'in_progress', 'paused', 'complete', 'ready_for_outsource', 'at_external_vendor', 'pending_tco']

// D-ASM-02: a rework build's lot is its source lot with R appended (assembly_lot_assign does the same).
export const reworkLot = (sourceLot) => (sourceLot ? `${String(sourceLot).trim()}R` : '')

// ── Builds ─────────────────────────────────────────────────────────────────
// args: { partNumber, quantity, buildKind, priority, requestIds, reworkSourceLot, programId, programFinalLotId,
//         workOrderAssemblyId, note } → the new build's id
export function createBuild(args) {
  return rpc('assembly_build_create', {
    p_part_number: args.partNumber,
    p_quantity: args.quantity,
    p_build_kind: args.buildKind,
    p_priority: args.priority || 'normal',
    p_request_ids: args.requestIds?.length ? args.requestIds : null,
    p_rework_source_lot: args.reworkSourceLot || null,
    p_program_id: args.programId || null,
    p_program_final_lot_id: args.programFinalLotId || null,
    p_work_order_assembly_id: args.workOrderAssemblyId || null,
    p_note: args.note || null,
  })
}

// D-ASM-32: builds go to assemblers, not benches — the bench argument stays NULL, which keeps whatever bench the
// build already had (benches stay in the table, unused, for the equipment-tracking wave).
export const assignBuild = (buildId, profileId) =>
  rpc('assembly_build_assign', { p_build_id: buildId, p_bench_id: null, p_profile_id: profileId })
export const releaseBuild = (buildId) => rpc('assembly_build_release', { p_build_id: buildId })
export const cancelBuild = (buildId, reason) => rpc('assembly_build_cancel', { p_build_id: buildId, p_reason: reason })
export const assignLot = (buildId) => rpc('assembly_lot_assign', { p_build_id: buildId })
// lots: [{ part, lot }] → true when this component-lot set has never been built for the part (D-ASM-08 second PIN)
export const lotSetIsNew = (partNumber, lots) => rpc('assembly_lot_set_is_new', { p_part_number: partNumber, p_lots: lots })

export async function listOpenRequests() {
  const { data, error } = await supabase
    .from('v_assembly_requests_open')
    .select('*')
    .order('earliest_due', { ascending: true, nullsFirst: false })
    .order('part_number', { ascending: true })
  if (error) throw error
  return data || []
}

// Every build still on the floor, plus released builds still waiting on Fishbowl (ready to post / mismatch) or
// released in the last releasedDays days, so a just-released card does not vanish from Jody's board.
export async function listBoard({ releasedDays = 7 } = {}) {
  const since = new Date(Date.now() - releasedDays * 86400000).toISOString()
  const { data, error } = await supabase
    .from('v_assembly_builds_board')
    .select('*')
    .or(`status.in.(${ACTIVE_BUILD_STATUSES.join(',')}),and(status.eq.released,fb_post_status.in.(ready_to_post,mismatch)),and(status.eq.released,released_at.gte.${since})`)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

// Active profiles holding the assembly role (primary or in roles[]), with their avatars — the board's columns.
export async function listAssemblers() {
  const { data, error } = await supabase
    .from('v_assemblers')
    .select('id, full_name, username, avatar_icon, avatar_color')
    .order('full_name')
  if (error) throw error
  return data || []
}

// The last released build of a part — Jody's "how many did we make last time" hint. → { quantity, released_at } | null
export async function lastBuildQty(partNumber) {
  const { data, error } = await supabase
    .from('assembly_builds')
    .select('quantity, released_at')
    .eq('part_number', partNumber)
    .eq('status', 'released')
    .order('released_at', { ascending: false })
    .limit(1)
  if (error) throw error
  return (data || [])[0] || null
}

// On-hand Fishbowl lots of a part (the bridge's tag mirror), oldest first — the rework source-lot picker.
export async function tagLotsForPart(partNumber) {
  const { data, error } = await supabase
    .from('fb_tags')
    .select('fb_tag_id, tag_num, lot_number, qty, location, tag_created')
    .eq('part_num', partNumber)
    .is('removed_at', null)
    .gt('qty', 0)
    .order('tag_created', { ascending: true })
  if (error) throw error
  return data || []
}

// Assembly parts for "create a build from scratch" (number or description match).
export async function searchAssemblyParts(term, limit = 25) {
  const t = String(term || '').trim().replace(/[%,()]/g, ' ')
  let q = supabase.from('parts').select('id, part_number, description, assembly_family').eq('part_type', 'assembly').eq('is_active', true)
  if (t) q = q.or(`part_number.ilike.%${t}%,description.ilike.%${t}%`)
  const { data, error } = await q.order('part_number').limit(limit)
  if (error) throw error
  return data || []
}

// ── Checklist families (D-ASM-07) ──────────────────────────────────────────
export async function listFamilies() {
  const { data, error } = await supabase.from('v_assembly_checklist_families').select('*')
  if (error) throw error
  return data || []
}

export async function listSteps(templateId) {
  const { data, error } = await supabase
    .from('assembly_checklist_steps')
    .select('*')
    .eq('template_id', templateId)
    .order('step_order')
  if (error) throw error
  return data || []
}

// Every part mapped to a family (the view only carries eight examples).
export async function listFamilyParts(familyKey) {
  const { data, error } = await supabase
    .from('parts')
    .select('id, part_number, description')
    .eq('assembly_family', familyKey)
    .order('part_number')
  if (error) throw error
  return data || []
}

// status: 'draft' | 'approved' | 'retired' | null (keep); name: null keeps the name.
export const setTemplate = (templateId, name = null, status = null) =>
  rpc('assembly_template_set', { p_template_id: templateId, p_name: name, p_status: status })

// fields: { label, pins, thresholdMin, sampleQty, instructionText } — anything left undefined is kept.
export const setStep = (stepId, fields = {}) => rpc('assembly_step_set', {
  p_step_id: stepId,
  p_label: fields.label ?? null,
  p_pins: fields.pins ?? null,
  p_threshold_min: fields.thresholdMin ?? null,
  p_sample_qty: fields.sampleQty ?? null,
  p_instruction_text: fields.instructionText ?? null,
})

// Moves parts into another family (Roger's merge). → parts updated
export const setPartFamily = (partNumbers, familyKey) =>
  rpc('assembly_part_set_family', { p_part_numbers: partNumbers, p_family_key: familyKey })
