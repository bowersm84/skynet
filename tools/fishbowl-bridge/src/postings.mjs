// postings.mjs — bridge v1.11 posting mirror (D-FB-58 / D-ASM-14): Fishbowl's postso / postsoitem.
//
// postso has no Envers table, so it is polled every FB_POSTINGS_INTERVAL_MS by postso.dateLastModified (the previous
// poll minus 10 min; the first load is everything posted in the last 180 days). postDate is written at ship time and
// is the Order Queue's Invoiced stamp; journalPosted / extTxnId are the later QuickBooks phase. Each posting travels
// with every one of its items. fb_upsert_postings stamps last_postings_at, even when there is nothing new.
import { q } from './queries.mjs'
import { chunk, int, num, bool, ts } from './mapper.mjs'

export const POSTINGS_PER_CALL = 500

const text = (v) => (v === null || v === undefined ? '' : String(v).trim())
const orNull = (v) => { const s = text(v); return s === '' ? null : s }

// Output keys are exactly what fb_upsert_postings reads.
export function mapPosting(r) {
  return {
    postSoId: int(r.postSoId),
    soId: int(r.soId),
    soNumber: orNull(r.soNumber),
    postDate: ts(r.postDate),
    datePosted: ts(r.datePosted),
    statusId: int(r.statusId),
    extRefNumber: orNull(r.extRefNumber),
    extTxnId: orNull(r.extTxnId),
    journalPosted: bool(r.journalPosted),
    totalTax: num(r.totalTax),
  }
}

export function mapPostingItem(r) {
  return {
    postSoItemId: int(r.postSoItemId),
    postSoId: int(r.postSoId),
    soItemId: int(r.soItemId),
    shipItemId: int(r.shipItemId),
    qty: num(r.qty),
    totalPrice: num(r.totalPrice),
  }
}

// since: a Fishbowl local datetime, or null for the first load. Returns { postings, items, upserted }.
export async function syncPostings(fb, sky, { since = null, log }) {
  const postings = (await fb.query(q.postings(since))).map(mapPosting).filter((p) => p.postSoId !== null)
  const items = []
  for (const part of chunk(postings.map((p) => p.postSoId), 500)) {
    items.push(...(await fb.query(q.postingItems(part))).map(mapPostingItem).filter((i) => i.postSoItemId !== null))
  }
  const batches = chunk(postings, POSTINGS_PER_CALL)
  let upserted = 0
  if (batches.length === 0) upserted += Number(await sky.upsertPostings([], [])) || 0
  for (const batch of batches) {
    const ids = new Set(batch.map((p) => p.postSoId))
    upserted += Number(await sky.upsertPostings(batch, items.filter((i) => ids.has(i.postSoId)))) || 0
  }
  if (postings.length > 0) log.info(`postings: ${since === null ? 'first load (180 days)' : `since ${since}`} · ${postings.length} posting(s), ${items.length} item(s) · ${upserted} upserted`)
  return { postings: postings.length, items: items.length, upserted }
}
