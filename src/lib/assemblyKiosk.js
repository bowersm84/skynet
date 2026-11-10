// lib/assemblyKiosk.js — data access for the assembly kiosk (S17 Batch C, D-ASM-40).
// Thin wrappers over the C1 / C2a functions and views. Every write is a SECURITY DEFINER function gated on the
// server (admin / assembly); the signed-in assembler is auth.uid() from the kiosk token, and a second person is
// identified by their PIN on the server — the client never sends anyone's id.
// Messages raised by these functions are written for people: show them as they are.
// PIN misses are results, not errors (D-ASM-44): resolvePin → { ok:false, message }, startBuild →
// { started:false, reason:'second_pin_rejected', message }, signStep → { result:'pin_rejected', which, message },
// closeoutBuild → { closed:false, reason:'inspector_pin_rejected', message }, changeOwnPin → { ok:false, message }.
import { supabase } from './supabase'

const rpc = async (name, args = {}) => {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw error
  return data
}

// The board's columns: no checklist (steps), which only the build being worked needs.
const BOARD_COLUMNS = [
  'id', 'build_number', 'part_number', 'part_description', 'quantity', 'build_kind', 'status', 'priority',
  'wave_count', 'wave_current', 'assigned_to', 'assigned_name', 'assigned_avatar_icon', 'assigned_avatar_color',
  'earliest_due', 'lots_pulled', 'open_sessions', 'minutes_total', 'program_id',
].join(', ')

// Open builds (requested / assigned / in_progress / paused) for the board.
export async function listKioskBuilds() {
  const { data, error } = await supabase.from('v_assembly_kiosk_builds').select(BOARD_COLUMNS)
  if (error) throw error
  return data || []
}

// One open build with the current wave's checklist (steps), or null once it has left the open list.
export async function getKioskBuild(buildId) {
  const { data, error } = await supabase.from('v_assembly_kiosk_builds').select('*').eq('id', buildId).maybeSingle()
  if (error) throw error
  return data || null
}

// The caller's open session on a build, or null.
export async function myOpenSession(buildId, profileId) {
  const { data, error } = await supabase
    .from('assembly_sessions').select('id, clock_in')
    .eq('build_id', buildId).eq('profile_id', profileId).is('clock_out', null)
    .order('clock_in', { ascending: false }).limit(1)
  if (error) throw error
  return data?.[0] || null
}

// Components of the build's current wave, each with its on-hand lots from the Fishbowl tag mirror.
export async function listComponents(buildId, wave) {
  const rows = await rpc('assembly_kiosk_components', { p_build_id: buildId })
  return (rows || []).filter((r) => Number(r.wave) === Number(wave))
}

export const startBuild = (buildId, lots, secondPin = null) =>
  rpc('assembly_build_start', { p_build_id: buildId, p_lots: lots, p_second_pin: secondPin })

export const clockIn = (buildId) => rpc('assembly_session_clock_in', { p_build_id: buildId })

export const clockOut = (buildId, qtyDone, reason) =>
  rpc('assembly_session_clock_out', { p_build_id: buildId, p_qty_done: qtyDone, p_reason: reason || null })

export const signStep = (buildId, stepId, pins, readings) =>
  rpc('assembly_step_signoff', {
    p_build_id: buildId,
    p_step_id: stepId,
    p_pins: pins,
    p_readings: readings && readings.length ? readings : null,
    p_note: null,
  })

export const closeoutBuild = (buildId, good, bad, inspectorPin = null) =>
  rpc('assembly_build_closeout', { p_build_id: buildId, p_good: good, p_bad: bad, p_inspector_pin: inspectorPin })

// { ok:true, profile_id, full_name } | { ok:false, reason, message, retry_after_seconds? }
export const resolvePin = (pin) => rpc('assembly_pin_resolve', { p_pin: pin })

// The signed-in person's own PIN. A PIN on file (a temporary one too) must be passed as currentPin.
export const changeOwnPin = (newPin, currentPin) =>
  rpc('profile_pin_set', { p_new_pin: newPin, p_current_pin: currentPin ?? null })

// The display prefix for assembly lots ("ALN-"); the stored lot is the bare number (D-ASM-02).
export async function lotPrefixDisplay() {
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'assembly_lot_prefix_display').maybeSingle()
  return typeof data?.value === 'string' ? data.value : ''
}
