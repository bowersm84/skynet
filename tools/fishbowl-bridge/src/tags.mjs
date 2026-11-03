// tags.mjs — bridge v1.11 tag mirror (D-FB-58): Fishbowl's on-hand lots for every part on an active BOM.
//
// `tag` has no Envers table, so it is polled: every FB_TAGS_INTERVAL_MS the scope's tags changed since the previous
// poll (minus 10 min) are read by tag.dateLastModified. The scope is every part on an active BOM without the Labor
// line (uomId 4 = hr), refreshed hourly. The lot is trackingtext.info for partTrackingId 1 (Lot Number).
// Fishbowl deletes a tag once it is emptied, and a delta read cannot see a deletion, so the first run on a database
// and the sweep — every FB_TAGS_SWEEP_INTERVAL_MS, default hourly (D-FB-62) — read the whole scope and send every
// live in-scope mirror tag the sweep did not return as removed, with p_sweep = true. fb_upsert_tags stamps
// last_tags_at (and last_tags_sweep_at on a sweep).
import { q } from './queries.mjs'
import { chunk, int, num, ts } from './mapper.mjs'

export const TAG_ROWS_PER_CALL = 500

const text = (v) => (v === null || v === undefined ? '' : String(v).trim())
const orNull = (v) => { const s = text(v); return s === '' ? null : s }

// Output keys are exactly what fb_upsert_tags reads. A tag with no lot carries no tracking type.
export function mapTag(r) {
  const lotNumber = orNull(r.lotNumber)
  return {
    tagId: int(r.tagId),
    tagNum: int(r.tagNum),
    partId: int(r.partId),
    partNum: orNull(r.partNum),
    locationId: int(r.locationId),
    location: orNull(r.location),
    locationGroupId: int(r.locationGroupId),
    qty: num(r.qty) ?? 0,
    qtyCommitted: num(r.qtyCommitted) ?? 0,
    lotNumber,
    trackingType: lotNumber === null ? null : (orNull(r.trackingType) || 'Lot Number'),
    woItemId: int(r.woItemId),
    tagCreated: ts(r.tagCreated),
    tagLastModified: ts(r.tagLastModified),
  }
}

// Live mirror tags of in-scope parts that a full sweep did not return: Fishbowl deleted them.
export function removedTags(openMirror, returnedTagIds, scopePartIds) {
  const seen = new Set(returnedTagIds.map(Number))
  const scope = new Set(scopePartIds.map(Number))
  return openMirror
    .filter((t) => scope.has(Number(t.fb_part_id)) && !seen.has(Number(t.fb_tag_id)))
    .map((t) => Number(t.fb_tag_id))
}

// D-FB-62: a sweep is due when there has never been one, or the last one (fb_sync_state.last_tags_sweep_at, read
// through fb_get_family_cursors().tagsSweepAt) is at least intervalMs old.
export function tagSweepDue(lastSweepAt, nowMs = Date.now(), intervalMs = 3600000) {
  if (!lastSweepAt) return true
  const last = Date.parse(lastSweepAt)
  return !Number.isFinite(last) || nowMs - last >= intervalMs
}

export async function loadTagScope(fb) {
  return [...new Set((await fb.query(q.tagScopeParts)).map((r) => int(r.partId)).filter((v) => v !== null))]
}

// since: a Fishbowl local datetime for the delta, or null for a sweep. Returns { sweep, rows, removed, upserted }.
export async function syncTags(fb, sky, { scope, since = null, log }) {
  const sweep = since === null
  const rows = []
  for (const part of chunk(scope, 500)) {
    rows.push(...(await fb.query(q.tags(part, since))).map(mapTag).filter((t) => t.tagId !== null && t.partId !== null))
  }
  let removed = null
  if (sweep) {
    const open = await sky.openTags()
    // A sweep that read nothing while the mirror holds in-scope tags is a failed read, not an empty plant.
    if (rows.length === 0 && open.some((t) => scope.includes(Number(t.fb_part_id)))) {
      throw new Error(`tag sweep returned no tags for ${scope.length} scope part(s); refusing to mark the mirror removed`)
    }
    removed = removedTags(open, rows.map((r) => r.tagId), scope)
  }
  const batches = chunk(rows, TAG_ROWS_PER_CALL)
  let upserted = 0
  if (batches.length === 0) upserted += Number(await sky.upsertTags([], removed?.length ? removed : null, sweep)) || 0
  for (let i = 0; i < batches.length; i++) {
    const last = i === batches.length - 1
    upserted += Number(await sky.upsertTags(batches[i], last && removed?.length ? removed : null, last && sweep)) || 0
  }
  log.info(`tags: ${sweep ? 'sweep' : `since ${since}`} · scope ${scope.length} part(s) · ${rows.length} tag(s) read · ${removed?.length ?? 0} removed · ${upserted} upserted`)
  return { sweep, rows: rows.length, removed: removed?.length ?? 0, upserted }
}
