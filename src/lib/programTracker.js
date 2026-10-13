// Giza program tracker — data layer (S15, D-GIZA; branch model D-GIZA-21..27).
// Reads the program tables and views from 2026-10-13_giza_tracker.sql + 2026-10-14_giza_branches.sql;
// every write goes through the SECURITY DEFINER RPCs, which enforce the admin / order_processor gate
// server-side (D-GIZA-08) and decide lot numbers and splits (D-GIZA-21..25). Pure math lives in
// programTrackerMath.js so it can be unit-tested without Supabase.

import { supabase } from './supabase'

export const GIZA_PROGRAM_CODE = 'GIZA-21077'

const must = (res, what) => {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data
}

// Everything the dashboard renders, in one round of parallel reads.
export async function loadProgramBundle(code = GIZA_PROGRAM_CODE) {
  const program = must(
    await supabase.from('programs').select('*').eq('code', code).maybeSingle(),
    'program'
  )
  if (!program) throw new Error(`Program ${code} not found — have the Giza migrations been applied?`)

  // D-GIZA-29: the Movements report lists Giza shipments of the last 120 days.
  const shipSince = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10)
  const [parts, pipeline, demand, daily, lots, ledger, sends, sync, purchasing, shipments] = await Promise.all([
    supabase
      .from('program_parts')
      .select('id, role, qty_per, consumed_at_stage, part_id, part:parts(id, part_number, description, is_active)')
      .eq('program_id', program.id),
    supabase.from('v_program_pipeline').select('*').eq('program_id', program.id).maybeSingle(),
    supabase
      .from('v_program_demand')
      .select('*')
      .eq('program_id', program.id)
      .order('effective_due_date', { ascending: true })
      .order('so_number', { ascending: true })
      .order('line_number', { ascending: true }),
    supabase.from('v_program_daily').select('*').eq('program_id', program.id),
    supabase.from('v_program_final_lots').select('*').eq('program_id', program.id),
    supabase
      .from('program_ledger')
      .select(`*,
        part:parts(part_number),
        entered:profiles!program_ledger_entered_by_fkey(full_name),
        voider:profiles!program_ledger_voided_by_fkey(full_name),
        to_lot:program_final_lots!program_ledger_final_lot_id_fkey(lot_number),
        from_lot:program_final_lots!program_ledger_from_lot_id_fkey(lot_number)`)
      .eq('program_id', program.id)
      .order('created_at', { ascending: false })
      .limit(5000),
    supabase
      .from('finishing_sends')
      .select(`id, status, finishing_stage, incoming_count, verified_count, finishing_lot_number,
        plating_lot_number, dry_film_lot_number, stage_started_at, finishing_started_at,
        finishing_completed_at, bake_temp_f, program_lot_id, program_dest_lot_id,
        machine:machines!machine_id(name, code),
        job:jobs(job_number)`)
      .eq('program_id', program.id)
      .eq('standalone_operation_type', 'dry_film')
      .order('finishing_started_at', { ascending: false }),
    supabase.from('fb_sync_state').select('last_rev_at, bridge_version, last_shipments_at, last_purchasing_at').limit(1).maybeSingle(),
    // D-GIZA-30: every PO line for the program's parts (Fishbowl mirror, bridge 1.10).
    supabase.from('v_program_purchasing').select('*').eq('program_id', program.id),
    supabase
      .from('fb_shipment_lots')
      .select('so_number, so_line, ship_number, ship_status, date_shipped, qty_shipped, lot_number, lot_qty')
      .eq('product_num', program.fb_product_num)
      .gte('date_shipped', shipSince)
      .order('date_shipped', { ascending: false }),
  ])

  return {
    program,
    parts: must(parts, 'program parts') || [],
    pipeline: must(pipeline, 'pipeline'),
    demand: must(demand, 'demand') || [],
    daily: must(daily, 'daily throughput') || [],
    lots: must(lots, 'lots') || [],
    ledger: must(ledger, 'ledger') || [],
    sends: must(sends, 'dry-film batches') || [],
    sync: sync.error ? null : sync.data,
    // null = the purchasing mirror is not there yet (migration / bridge 1.10); [] = mirrored, nothing on order.
    purchasing: purchasing.error ? null : (purchasing.data || []),
    shipments: shipments.error ? [] : (shipments.data || []),
  }
}

const rpc = async (fn, args) => {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data
}

const blank = (v) => {
  const s = v == null ? '' : String(v).trim()
  return s === '' ? null : s
}
const numOrNull = (v) => {
  const s = blank(v)
  if (s === null) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// One move. Returns { entry_id, lot_id, lot_number, split, reason, new_branch } — the server picks
// the lot: a steel nut receipt creates one; a move that changes the trail lands in a split lot.
export const logEntry = (a) => rpc('program_log_entry', {
  p_program_id: a.programId,
  p_part_id: a.partId,
  p_stage: a.stage,
  p_qty: a.qty,
  p_lot: blank(a.lot),
  p_branch_id: a.branchId || null,
  p_cage_lot: blank(a.cageLot),
  p_retainer_lot: blank(a.retainerLot),
  p_vendor: blank(a.vendor),
  p_po: blank(a.po),
  p_expected_return: blank(a.expectedReturn),
  p_entry_date: blank(a.entryDate),
  p_done_by: blank(a.doneBy),
  p_notes: blank(a.notes),
})

export const voidEntry = (entryId, reason) => rpc('program_void_entry', { p_entry_id: entryId, p_reason: reason })

export const closeFinalLot = (a) => rpc('program_close_final_lot', {
  p_lot_id: a.lotId,
  p_torsion: {
    t1_qty: numOrNull(a.t1Qty),
    t1_inlbs: numOrNull(a.t1Inlbs),
    t2_qty: numOrNull(a.t2Qty),
    t2_inlbs: numOrNull(a.t2Inlbs),
  },
  p_inspected_by: blank(a.inspectedBy),
  p_notes: blank(a.notes),
})

export const reopenFinalLot = (lotId, reason) => rpc('program_reopen_final_lot', { p_lot_id: lotId, p_reason: reason })

// Closed lots: torsion, inspector, notes (a lot's trail is not editable). Historical lots (the paper
// sheet's 3001..3006) also take quantity, nut lots and component lots by hand.
export const updateFinalLot = (lotId, f, isHistorical) => {
  const fields = {
    torsion_1_qty: numOrNull(f.t1Qty),
    torsion_1_inlbs: numOrNull(f.t1Inlbs),
    torsion_2_qty: numOrNull(f.t2Qty),
    torsion_2_inlbs: numOrNull(f.t2Inlbs),
    inspected_by: blank(f.inspectedBy),
    notes: blank(f.notes),
  }
  if (isHistorical) {
    fields.quantity = numOrNull(f.quantity)
    fields.nut_lots = String(f.nutLots || '').split(',').map(s => s.trim()).filter(Boolean)
    fields.cage_lot = blank(f.cageLot)
    fields.retainer_lot = blank(f.retainerLot)
    fields.insert_lot = blank(f.insertLot)
  }
  return rpc('program_update_final_lot', { p_lot_id: lotId, p_fields: fields })
}
