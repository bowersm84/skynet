// Customer Program Dashboard — data layer (S16, D-CPROG). Reads the roster-gated tables and
// views from Docs/migrations/2026-10-27_customer_program.sql, plus the shared Fishbowl / SkyNet
// production tables for each line's progress. RLS does the gating: a user who is not on the
// program's roster gets no program row back, and this layer reports "not found".
// Writes: inserts go straight to the tables (RLS checks can_log_moves / can_enter_money);
// voids go through the cp_void RPC. Pure math lives in customerProgramMath.js.

import { supabase } from './supabase'

const must = (res, what) => {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data
}

const OPEN_PO_STATUS = [15, 20, 30, 40] // pending approval, issued, picking, partial

// Programs the signed-in user is rostered on (RLS returns only those). For the Dashboards menu.
export async function listMyCustomerPrograms() {
  const { data, error } = await supabase
    .from('customer_programs')
    .select('code, name')
    .eq('is_active', true)
    .order('name')
  if (error) return []
  return data || []
}

export async function loadCustomerProgramBundle(code, profileId) {
  const program = must(
    await supabase.from('customer_programs').select('*').eq('code', code).maybeSingle(),
    'program'
  )
  if (!program) return { program: null }

  const [access, lines, money, moves, balances, checks, quotes, sync] = await Promise.all([
    supabase
      .from('customer_program_access')
      .select('profile_id, can_log_moves, can_enter_money, profile:profiles!customer_program_access_profile_id_fkey(full_name, email)')
      .eq('program_id', program.id),
    supabase
      .from('cp_v_lines')
      .select('*')
      .eq('program_id', program.id)
      .order('so_number', { ascending: true })
      .order('line_number', { ascending: true }),
    supabase
      .from('cp_money')
      .select(`*,
        entered:profiles!cp_money_entered_by_fkey(full_name),
        voider:profiles!cp_money_voided_by_fkey(full_name)`)
      .eq('program_id', program.id)
      .order('txn_date', { ascending: false })
      .order('created_at', { ascending: false }),
    supabase
      .from('cp_moves')
      .select(`*,
        entered:profiles!cp_moves_entered_by_fkey(full_name),
        voider:profiles!cp_moves_voided_by_fkey(full_name)`)
      .eq('program_id', program.id)
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(5000),
    supabase.from('cp_v_lot_balances').select('*').eq('program_id', program.id),
    supabase
      .from('cp_lot_checks')
      .select('*, entered:profiles!cp_lot_checks_entered_by_fkey(full_name)')
      .eq('program_id', program.id)
      .order('checked_on', { ascending: false }),
    supabase.from('cp_quotes').select('*').eq('program_id', program.id).order('quoted_on', { ascending: false }),
    supabase.from('fb_sync_state').select('last_rev_at, bridge_version').limit(1).maybeSingle(),
  ])

  const lineRows = must(lines, 'order lines') || []
  const accessRows = must(access, 'roster') || []

  // Production: work orders allocated to each line's SkyNet CO line, with their jobs.
  const coLineIds = [...new Set(lineRows.map(l => l.customer_order_line_id).filter(Boolean))]
  const allocations = coLineIds.length
    ? must(
        await supabase
          .from('customer_order_allocations')
          .select('customer_order_line_id, quantity_allocated, work_order:work_orders(id, wo_number, status, due_date, jobs(id, job_number, status, quantity, good_pieces))')
          .in('customer_order_line_id', coLineIds)
          .eq('is_active', true),
        'allocations'
      ) || []
    : []

  // Components: SkyNet BOM for each line's part, then Fishbowl stock for the components.
  const partNums = [...new Set(lineRows.map(l => l.part_num || l.product_num).filter(Boolean))]
  const parts = partNums.length
    ? must(await supabase.from('parts').select('id, part_number').in('part_number', partNums), 'parts') || []
    : []
  const bom = parts.length
    ? must(
        await supabase
          .from('assembly_bom')
          .select('assembly_id, quantity, component:parts!assembly_bom_component_id_fkey(part_number)')
          .in('assembly_id', parts.map(p => p.id)),
        'assembly BOM'
      ) || []
    : []
  const componentNums = [...new Set(bom.map(b => b.component?.part_number).filter(Boolean))]
  const stockNums = [...new Set([...partNums, ...componentNums])]
  const [inventory, poLines] = stockNums.length
    ? await Promise.all([
        supabase.from('fb_part_inventory').select('part_num, qty_on_hand, qty_on_order, snapshot_at').in('part_num', stockNums),
        supabase
          .from('fb_purchase_order_lines')
          .select('part_num, qty_to_fulfill, qty_fulfilled, date_scheduled, removed_at, po:fb_purchase_orders(po_number, status_id, status_name, vendor_name)')
          .in('part_num', stockNums)
          .is('removed_at', null),
      ])
    : [{ data: [] }, { data: [] }]

  const idToPart = new Map(parts.map(p => [p.id, p.part_number]))
  const bomByPart = {}
  for (const b of bom) {
    const asm = idToPart.get(b.assembly_id)
    if (!asm || !b.component?.part_number) continue
    ;(bomByPart[asm] = bomByPart[asm] || []).push({ part_num: b.component.part_number, qty_per: Number(b.quantity || 1) })
  }
  const openPos = (must(poLines, 'purchase orders') || [])
    .filter(l => OPEN_PO_STATUS.includes(Number(l.po?.status_id)))
    .map(l => ({ ...l, qty_open: Math.max(0, Number(l.qty_to_fulfill || 0) - Number(l.qty_fulfilled || 0)) }))
    .filter(l => l.qty_open > 0)

  return {
    program,
    access: accessRows,
    me: accessRows.find(a => a.profile_id === profileId) || null,
    lines: lineRows,
    money: must(money, 'money') || [],
    moves: must(moves, 'moves') || [],
    balances: must(balances, 'lot balances') || [],
    checks: must(checks, 'lot checks') || [],
    quotes: must(quotes, 'quotes') || [],
    sync: sync?.data || null,
    allocations,
    bomByPart,
    inventory: Object.fromEntries((must(inventory, 'inventory') || []).map(i => [i.part_num, i])),
    openPos,
  }
}

// ------------------------------------------------------------------ writes
export async function logMove(programId, profileId, row) {
  must(
    await supabase.from('cp_moves').insert({ ...row, program_id: programId, entered_by: profileId }),
    'log move'
  )
}

export async function addLotCheck(programId, profileId, row) {
  must(
    await supabase.from('cp_lot_checks').insert({ ...row, program_id: programId, entered_by: profileId }),
    'lot check'
  )
}

export async function addMoney(programId, profileId, row) {
  must(
    await supabase.from('cp_money').insert({ ...row, program_id: programId, entered_by: profileId, source: 'manual' }),
    'money entry'
  )
}

export async function voidRow(table, id, reason) {
  must(await supabase.rpc('cp_void', { p_table: table, p_id: id, p_reason: reason }), 'void')
}

export async function saveLineTracking(programId, profileId, fbSoitemId, fields) {
  must(
    await supabase
      .from('cp_line_tracking')
      .upsert(
        { ...fields, program_id: programId, fb_soitem_id: fbSoitemId, updated_by: profileId, updated_at: new Date().toISOString() },
        { onConflict: 'program_id,fb_soitem_id' }
      ),
    'line tracking'
  )
}

export async function saveQuote(programId, profileId, quote) {
  const row = { ...quote, program_id: programId, updated_by: profileId, updated_at: new Date().toISOString() }
  must(await supabase.from('cp_quotes').upsert(row, { onConflict: 'program_id,rfq_number,part_num' }), 'quote')
}
