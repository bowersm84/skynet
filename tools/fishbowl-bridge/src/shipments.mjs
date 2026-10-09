// shipments.mjs — bridge v1.9 shipments poller (D-FB-54): Fishbowl's shipped component lots into SkyNet.
//
// Every SO the revision tail (or the reconciler) touches is queued here, and once per cycle the queue is
// read with the proven rev 5 query (D-KSTC-37): one row per shipped item per lot, the lot from the ship
// record's tracking history (trackinginfo.tableId 1555030112), kit membership from kititem, contiguous under
// the kit header. Rows go to fb_shipment_lots through fb_upsert_shipment_lots; kit_attach_fb_shipment_lots
// then attaches every Shipped kit-member lot to the kit lots logged on that SO. A nightly sweep re-queues every
// SO with a shipment in the last SHIPMENTS_SWEEP_DAYS, so a bridge outage cannot lose a shipment. Every write
// is an upsert / ON CONFLICT DO NOTHING, so re-reading is always safe.
//
// The mappers are pure so shipments.test.mjs can run them under plain `node --test`.
import { q } from './queries.mjs'
import { chunk, int, num, bool, dateOnly } from './mapper.mjs'

// The one Fishbowl tracking type that is a lot. Anything else on a part (an expiry date, a revision) is not a
// component lot and is never sent. If Fishbowl renames it, nothing loads and the log says so — never wrong lots.
export const LOT_TRACKING_NAME = 'Lot Number'

const text = (v) => (v === null || v === undefined ? '' : String(v).trim())

// Output keys are exactly what fb_upsert_shipment_lots reads (camelCase, like the other fb_upsert_* RPCs).
export function mapShipmentLot(r) {
  const kitProductNum = text(r.kitProductNum)
  return {
    shipItemId: int(r.shipItemId),
    lotNumber: text(r.lotNumber),
    soNum: text(r.soNum),
    soItemId: int(r.soItemId),
    soLine: int(r.soLine),
    productNum: text(r.productNum),
    kitLine: int(r.kitLine),
    kitProductNum: kitProductNum === '' ? null : kitProductNum,
    kitMember: kitProductNum === '' ? null : bool(r.kitMember),
    kitQtyFulfilled: num(r.kitQtyFulfilled),
    shipNum: text(r.shipNum) || null,
    shipStatus: text(r.shipStatus) || null,
    dateShipped: dateOnly(r.dateShipped),
    qtyShipped: num(r.qtyShipped),
    lotQty: num(r.lotQty),
    trackingName: text(r.trackingName),
  }
}

// A row SkyNet can store: a lot of the lot tracking type, on a real shipped item of a real SO line.
export function isLotRow(m) {
  return m.trackingName.toLowerCase() === LOT_TRACKING_NAME.toLowerCase()
    && m.lotNumber !== '' && m.shipItemId !== null && m.soNum !== '' && m.productNum !== ''
}

// The RPC payload drops the tracking name (always the lot type by now).
export function toPayload(m) {
  const { trackingName, ...rest } = m
  return rest
}

// The nightly sweep's window start as a local 'YYYY-MM-DD' — the bridge host's clock is Fishbowl's clock
// (America/New_York), the same convention nightlyDue uses.
export function sweepSince(now = new Date(), days = 14) {
  const d = new Date(now)
  d.setDate(d.getDate() - Math.max(1, Number(days) || 14))
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// One log line from kit_attach_fb_shipment_lots' report.
export function summarizeAttach(r) {
  if (!r) return 'attach: no report'
  const um = r.unmatched_bench_lots || {}
  const unmatched = Object.entries(um).map(([k, v]) => `${k} ${Array.isArray(v) ? v.length : 0}`).join(', ') || 'none'
  const gaps = Array.isArray(r.kits_shipped_vs_logged) ? r.kits_shipped_vs_logged.length : 0
  return `attach${r.dry_run ? ' (DRY RUN)' : ''}: ${r.inserted_rows ?? 0} row(s) attached to ${r.kit_lots_matched ?? 0} kit lot(s)`
    + ` · ${r.already_present ?? 0} already present · off-BOM ${r.off_bom_rows ?? 0}`
    + ` · unmatched kit lots: ${unmatched} · shipped-vs-logged lines ${gaps}`
}

// Reads the shipment lots of a set of SO ids and upserts them. Returns { read, kept, upserted }.
// dryRun: read and log, write nothing.
export async function syncShipmentLots(fb, sky, soIds, { log, batch = 500, dryRun = false } = {}) {
  const ids = [...new Set((soIds || []).map(Number).filter(Number.isFinite))]
  if (ids.length === 0) return { read: 0, kept: 0, upserted: 0 }
  const raw = []
  for (const part of chunk(ids, 50)) raw.push(...await fb.query(q.shipmentLots(part)))
  const mapped = raw.map(mapShipmentLot)
  const rows = mapped.filter(isLotRow).map(toPayload)
  const shipped = rows.filter((r) => r.shipStatus === 'Shipped').length
  const inKit = rows.filter((r) => r.shipStatus === 'Shipped' && r.kitMember === true).length
  const line = `shipments: ${ids.length} SO(s) · ${raw.length} row(s) read · ${rows.length} lot row(s) (${shipped} shipped, ${inKit} in a kit)`
  if (dryRun) {
    log.info(`${line} · DRY RUN — nothing written`)
    for (const r of rows.slice(0, 5)) {
      log.info(`  e.g. SO ${r.soNum} line ${r.soLine} ${r.productNum} lot ${r.lotNumber} qty ${r.lotQty} · ${r.shipStatus} ${r.dateShipped || ''} · kit ${r.kitProductNum || '-'} member ${r.kitMember}`)
    }
    return { read: raw.length, kept: rows.length, upserted: 0 }
  }
  let upserted = 0
  for (const part of chunk(rows, batch)) upserted += Number(await sky.upsertShipmentLots(part)) || 0
  log.info(`${line} · ${upserted} upserted`)
  return { read: raw.length, kept: rows.length, upserted }
}

// Attaches mirrored lots to logged kit lots (SkyNet does the matching). dryRun asks the RPC for its
// self-rolling-back dry run, so the report is real and nothing is written.
export async function attachShipmentLots(sky, { log, dryRun = false } = {}) {
  const r = await sky.attachShipmentLots(dryRun)
  log.info(summarizeAttach(r))
  return r
}
