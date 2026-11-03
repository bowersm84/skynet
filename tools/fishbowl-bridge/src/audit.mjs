// audit.mjs — bridge v1.11 audit-tail registry (D-ASM-23 / D-FB-58): one Envers window and one cursor per family.
//
// Every cycle reads MAX(revinfo.id) once and the family cursors once (fb_get_family_cursors). Each family then reads
// the ids its audit tables touched in (max(cursor − OVERLAP_REVS, 0), maxRev], fetches those parents whole, maps
// them and sends them to its own fb_upsert_* RPC. The cursor moves only inside that RPC (GREATEST(cursor, p_rev_to))
// and only on a window's last call, so a family that fails keeps its window and one family's failure never touches
// another's cursor. A family whose cursor is NULL (first run on a database) loads its backfill set instead.
// A window with nothing in it still makes one empty call: that stamps the family's clock and moves its cursor.
//
// The sales-order tail is NOT in this registry: it keeps fb_sync_state.last_rev, sync.mjs and fb_ingest_delta.
// Families: picks (SO pick lines, the D-ASM-06 signal), ships (shipments.mjs), mos (MO -> WO -> consumed lots),
// boms (items and sign-off instructions). The mappers are pure so audit.test.mjs runs them under `node --test`.
import { q } from './queries.mjs'
import { chunk, int, num, bool, ts } from './mapper.mjs'
import { fetchShips, upsertShips } from './shipments.mjs'

export const ID_CHUNK = 500        // ids per IN (...)
export const PARENTS_PER_CALL = 100 // picks / MOs / BOMs per upsert RPC call (each travels with all its children)

const text = (v) => (v === null || v === undefined ? '' : String(v).trim())
const orNull = (v) => { const s = text(v); return s === '' ? null : s }
const ids = (rows, key) => [...new Set(rows.map((r) => int(r[key])).filter((v) => v !== null))]

// The family's window, or null when the cursor is NULL (backfill instead). Never starts below 0.
export function auditWindow(cursor, maxRev, overlap = 200) {
  if (cursor === null || cursor === undefined) return null
  const c = Number(cursor)
  return { from: Math.max(c - Math.max(0, Number(overlap) || 0), 0), to: Number(maxRev) }
}

// --- picks -> fb_upsert_pick_items ----------------------------------------------------------------------
export function mapPickItem(r) {
  return {
    pickItemId: int(r.pickItemId),
    pickId: int(r.pickId),
    pickNum: orNull(r.pickNum),
    pickStatusId: int(r.pickStatusId),
    pickLastModified: ts(r.pickLastModified),
    soId: int(r.soId),
    soItemId: int(r.soItemId),
    partId: int(r.partId),
    partNum: orNull(r.partNum),
    qty: num(r.qty),
    slotNum: int(r.slotNum),
    statusId: int(r.statusId),
    status: orNull(r.status),
    srcLocationId: int(r.srcLocationId),
    srcLocation: orNull(r.srcLocation),
    srcTagNum: int(r.srcTagNum),
    destLocationId: int(r.destLocationId),
    destLocation: orNull(r.destLocation),
    destTagNum: int(r.destTagNum),
  }
}

// Mirror rows of these picks that the fetch did not return: Fishbowl deleted them, so they are sent as removed.
export function removedPickItems(openMirrorIds, rows) {
  const seen = new Set(rows.map((r) => r.pickItemId))
  return openMirrorIds.filter((id) => !seen.has(id))
}

async function fetchPicks(fb, pickIds) {
  const rows = (await fb.query(q.pickItems(pickIds))).map(mapPickItem).filter((r) => r.pickItemId !== null && r.statusId !== null)
  return { ids: pickIds.map(Number), rows }
}

async function upsertPicks(sky, payload, revTo = null) {
  const groups = chunk(payload.ids, PARENTS_PER_CALL)
  if (groups.length === 0) return Number(await sky.upsertPickItems([], null, revTo)) || 0
  let n = 0
  for (let i = 0; i < groups.length; i++) {
    const pickIds = new Set(groups[i])
    const rows = payload.rows.filter((r) => pickIds.has(r.pickId))
    const removed = removedPickItems(await sky.openPickItemIds(groups[i]), rows)
    n += Number(await sky.upsertPickItems(rows, removed.length ? removed : null, i === groups.length - 1 ? revTo : null)) || 0
  }
  return n
}

// --- mos -> fb_upsert_manufacture_orders ----------------------------------------------------------------
export function mapMo(r) {
  return {
    moId: int(r.moId),
    moNum: orNull(r.moNum),
    statusId: int(r.statusId),
    status: orNull(r.status),
    soId: int(r.soId),
    locationGroupId: int(r.locationGroupId),
    dateCreated: ts(r.dateCreated),
    dateIssued: ts(r.dateIssued),
    dateScheduled: ts(r.dateScheduled),
    dateCompleted: ts(r.dateCompleted),
    dateLastModified: ts(r.dateLastModified),
    note: r.note ?? null,
    userId: int(r.userId),
  }
}

export function mapMoItem(r) {
  return {
    moItemId: int(r.moItemId),
    moId: int(r.moId),
    typeId: int(r.typeId),
    parentId: int(r.parentId),
    bomId: int(r.bomId),
    bomNum: orNull(r.bomNum),
    partId: int(r.partId),
    partNum: orNull(r.partNum),
    description: r.description ?? null,
    qtyToFulfill: num(r.qtyToFulfill),
    qtyFulfilled: num(r.qtyFulfilled),
    statusId: int(r.statusId),
    stageLevel: int(r.stageLevel),
    sortId: int(r.sortId),
  }
}

export function mapWorkOrder(r) {
  return {
    woId: int(r.woId),
    woNum: orNull(r.woNum),
    moId: int(r.moId),
    moItemId: int(r.moItemId),
    statusId: int(r.statusId),
    status: orNull(r.status),
    qtyOrdered: int(r.qtyOrdered),
    qtyTarget: int(r.qtyTarget),
    qtyScrapped: int(r.qtyScrapped),
    locationId: int(r.locationId),
    dateCreated: ts(r.dateCreated),
    dateStarted: ts(r.dateStarted),
    dateFinished: ts(r.dateFinished),
    note: r.note ?? null,
    cost: num(r.cost),
  }
}

export function mapWoItem(r) {
  return {
    woItemId: int(r.woItemId),
    woId: int(r.woId),
    moItemId: int(r.moItemId),
    typeId: int(r.typeId),
    partId: int(r.partId),
    partNum: orNull(r.partNum),
    description: r.description ?? null,
    qtyTarget: num(r.qtyTarget),
    qtyUsed: num(r.qtyUsed),
    qtyScrapped: num(r.qtyScrapped),
    cost: num(r.cost),
    standardCost: num(r.standardCost),
    sortId: int(r.sortId),
  }
}

export function mapConsumedLot(r) {
  return {
    pickItemId: int(r.pickItemId),
    woId: int(r.woId),
    woItemId: int(r.woItemId),
    partId: int(r.partId),
    partNum: orNull(r.partNum),
    qty: num(r.qty),
    statusId: int(r.statusId),
    srcLocation: orNull(r.srcLocation),
    srcTagNum: int(r.srcTagNum),
    lotNumber: orNull(r.lotNumber),
  }
}

// Reads MOs whole: the MO, every MO item, every WO, every WO item and every lot the WOs consumed.
async function fetchMos(fb, moIds) {
  const mos = (await fb.query(q.mos(moIds))).map(mapMo).filter((m) => m.moId !== null && m.moNum !== null && m.statusId !== null)
  const found = mos.map((m) => m.moId)
  if (found.length === 0) return { ids: moIds.map(Number), mos, moItems: [], wos: [], woItems: [], consumed: [] }
  const moItems = (await fb.query(q.moItems(found))).map(mapMoItem).filter((i) => i.moItemId !== null && i.typeId !== null)
  const wos = (await fb.query(q.workOrders(found))).map(mapWorkOrder).filter((w) => w.woId !== null && w.woNum !== null && w.statusId !== null)
  const woIds = wos.map((w) => w.woId)
  const woItems = woIds.length ? (await fb.query(q.woItems(woIds))).map(mapWoItem).filter((i) => i.woItemId !== null && i.typeId !== null) : []
  const consumed = woIds.length ? (await fb.query(q.woConsumedLots(woIds))).map(mapConsumedLot).filter((c) => c.pickItemId !== null) : []
  return { ids: moIds.map(Number), mos, moItems, wos, woItems, consumed }
}

// Splits a mos payload into per-call batches. The RPC replaces every child of each MO it receives, so a batch
// always carries the complete item / WO / WO-item / consumed sets of its MOs. Pure (tested).
export function moBatches(payload, perCall = PARENTS_PER_CALL) {
  return chunk(payload.mos, Math.max(1, perCall)).map((mos) => {
    const moIds = new Set(mos.map((m) => m.moId))
    const wos = payload.wos.filter((w) => moIds.has(w.moId))
    const woIds = new Set(wos.map((w) => w.woId))
    return {
      mos,
      moItems: payload.moItems.filter((i) => moIds.has(i.moId)),
      wos,
      woItems: payload.woItems.filter((i) => woIds.has(i.woId)),
      consumed: payload.consumed.filter((c) => woIds.has(c.woId)),
    }
  })
}

async function upsertMos(sky, payload, revTo = null) {
  const batches = moBatches(payload)
  if (batches.length === 0) return Number(await sky.upsertManufactureOrders([], [], [], [], [], revTo)) || 0
  let n = 0
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i]
    n += Number(await sky.upsertManufactureOrders(b.mos, b.moItems, b.wos, b.woItems, b.consumed, i === batches.length - 1 ? revTo : null)) || 0
  }
  return n
}

// --- boms -> fb_upsert_boms ---------------------------------------------------------------------------
export function mapBom(r) {
  return {
    bomId: int(r.bomId),
    bomNum: orNull(r.bomNum),
    description: r.description ?? null,
    active: bool(r.active),
    revision: orNull(r.revision),
    autoCreateTypeId: int(r.autoCreateTypeId),
    dateLastModified: ts(r.dateLastModified),
  }
}

export function mapBomItem(r) {
  return {
    bomItemId: int(r.bomItemId),
    bomId: int(r.bomId),
    typeId: int(r.typeId),
    partId: int(r.partId),
    partNum: orNull(r.partNum),
    partDescription: r.partDescription ?? null,
    quantity: num(r.quantity),
    uomId: int(r.uomId),
    uom: orNull(r.uom),
    sortId: int(r.sortId),
    stage: bool(r.stage),
    stageBomId: int(r.stageBomId),
  }
}

export function mapBomInstruction(r) {
  return {
    instructionId: int(r.instructionId),
    bomId: int(r.bomId),
    sortOrder: int(r.sortOrder),
    name: r.name ?? null,
    description: r.description ?? null,
    details: r.details ?? null,
  }
}

async function fetchBoms(fb, bomIds) {
  const boms = (await fb.query(q.boms(bomIds))).map(mapBom).filter((b) => b.bomId !== null && b.bomNum !== null)
  const found = boms.map((b) => b.bomId)
  if (found.length === 0) return { ids: bomIds.map(Number), boms, items: [], instructions: [] }
  const items = (await fb.query(q.bomItems(found))).map(mapBomItem).filter((i) => i.bomItemId !== null && i.typeId !== null)
  const instructions = (await fb.query(q.bomInstructions(found))).map(mapBomInstruction).filter((i) => i.instructionId !== null)
  return { ids: bomIds.map(Number), boms, items, instructions }
}

// Items and instructions are replaced whole per BOM by the RPC, so each batch carries all of its BOMs' children.
export function bomBatches(payload, perCall = PARENTS_PER_CALL) {
  return chunk(payload.boms, Math.max(1, perCall)).map((boms) => {
    const bomIds = new Set(boms.map((b) => b.bomId))
    return {
      boms,
      items: payload.items.filter((i) => bomIds.has(i.bomId)),
      instructions: payload.instructions.filter((i) => bomIds.has(i.bomId)),
    }
  })
}

// sweep stamps last_boms_sweep_at; like revTo it rides the last call only.
async function upsertBoms(sky, payload, revTo = null, { sweep = false } = {}) {
  const batches = bomBatches(payload)
  if (batches.length === 0) return Number(await sky.upsertBoms([], [], [], revTo, sweep)) || 0
  let n = 0
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i]
    const last = i === batches.length - 1
    n += Number(await sky.upsertBoms(b.boms, b.items, b.instructions, last ? revTo : null, last && sweep)) || 0
  }
  return n
}

// --- the registry -------------------------------------------------------------------------------------
const idsOf = (key) => async (fb, sql) => ids(await fb.query(sql), key)

export const FAMILIES = [
  {
    family: 'picks', cursorKey: 'picks', idKey: 'pickId',
    idQuery: (from, to) => q.auditPickIds(from, to),
    backfillIds: (fb) => idsOf('pickId')(fb, q.backfillPickIds),
    fetch: fetchPicks,
    upsert: upsertPicks,
    empty: () => ({ ids: [], rows: [] }),
    count: (p) => p.rows.length,
  },
  {
    family: 'ships', cursorKey: 'ships', idKey: 'shipId',
    idQuery: (from, to) => q.auditShipIds(from, to),
    backfillIds: (fb) => idsOf('shipId')(fb, q.backfillShipIds),
    fetch: fetchShips,
    upsert: (sky, payload, revTo) => upsertShips(sky, payload, revTo, { perCall: PARENTS_PER_CALL }),
    empty: () => ({ ids: [], ships: [], cartons: [], items: [] }),
    count: (p) => p.ships.length,
  },
  {
    family: 'mos', cursorKey: 'mos', idKey: 'moId',
    idQuery: (from, to) => q.auditMoIds(from, to),
    backfillIds: (fb) => idsOf('moId')(fb, q.backfillMoIds),
    fetch: fetchMos,
    upsert: upsertMos,
    empty: () => ({ ids: [], mos: [], moItems: [], wos: [], woItems: [], consumed: [] }),
    count: (p) => p.mos.length,
  },
  {
    family: 'boms', cursorKey: 'boms', idKey: 'bomId',
    idQuery: (from, to) => q.auditBomIds(from, to),
    backfillIds: (fb) => idsOf('bomId')(fb, q.backfillBomIds),
    fetch: fetchBoms,
    // A first-run backfill reads every active BOM, which is exactly the nightly sweep: it says so, so the sweep
    // does not read them all again straight after.
    upsert: (sky, payload, revTo, opts) => upsertBoms(sky, payload, revTo, opts),
    backfillIsSweep: true,
    empty: () => ({ ids: [], boms: [], items: [], instructions: [] }),
    count: (p) => p.boms.length,
  },
]

// One family, one cycle. Throws on any failure (the caller's guard records it); the cursor has then not moved,
// because revTo only rides the call that lands the window's last chunk. Returns what it did, for the cycle log.
export async function runFamily(entry, { fb, sky, cursor, maxRev, overlap = 200, chunkSize = ID_CHUNK }) {
  const window = auditWindow(cursor, maxRev, overlap)
  let todo
  let mode
  if (window === null) {
    todo = await entry.backfillIds(fb)
    mode = 'backfill'
  } else if (window.to <= Number(cursor)) {
    todo = []
    mode = 'idle'
  } else {
    todo = ids(await fb.query(entry.idQuery(window.from, window.to)), entry.idKey)
    mode = 'window'
  }
  const sweep = mode === 'backfill' && Boolean(entry.backfillIsSweep)
  const parts = chunk(todo, Math.max(1, chunkSize))
  let fetched = 0
  let upserted = 0
  if (parts.length === 0) upserted += Number(await entry.upsert(sky, entry.empty(), maxRev, { sweep })) || 0
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1
    const payload = await entry.fetch(fb, parts[i])
    fetched += entry.count(payload)
    upserted += Number(await entry.upsert(sky, payload, last ? maxRev : null, { sweep: last && sweep })) || 0
  }
  return { family: entry.family, mode, from: window?.from ?? null, to: Number(maxRev), ids: todo.length, fetched, upserted }
}

// Nightly BOM sweep (FB_SWEEP_HOUR): every active BOM again, p_sweep on the last call, no cursor movement.
export async function sweepBoms(fb, sky, { chunkSize = ID_CHUNK } = {}) {
  const entry = FAMILIES.find((f) => f.family === 'boms')
  const todo = await entry.backfillIds(fb)
  const parts = chunk(todo, Math.max(1, chunkSize))
  let fetched = 0
  if (parts.length === 0) await upsertBoms(sky, entry.empty(), null, { sweep: true })
  for (let i = 0; i < parts.length; i++) {
    const payload = await entry.fetch(fb, parts[i])
    fetched += entry.count(payload)
    await upsertBoms(sky, payload, null, { sweep: i === parts.length - 1 })
  }
  return { ids: todo.length, fetched }
}
