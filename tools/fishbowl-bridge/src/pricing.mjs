// pricing.mjs — bridge v1.3 read-only mirrors for the Pricing Portal (D-PRICE-19/20/26):
//   customers   every POLL_CUSTOMERS_SEC (full backfill on the first run, then by dateLastModified)
//   products    nightly at PRODUCTS_NIGHTLY_AT (full table, ~11k rows)
//   so_history  nightly at HISTORY_NIGHTLY_AT, paged from fb_sync_state.history_cursor
//
// Every function here is called from inside the caller's Fishbowl session (index.mjs `withSession`),
// so the nightly jobs never open a second session (D-FB-37).
import { q } from './queries.mjs'
import { chunk, fbDateTime, mapCustomer, mapProduct, mapHistoryLine, ts } from './mapper.mjs'

// The paymentterms / accountgroup tables are asserted, not confirmed, on Fishbowl 25.9. If either read
// fails the poller degrades for the life of the process and says so once, rather than guessing names.
const degraded = { paymentTerms: false, accountGroups: false }

function degrade(key, log, reason) {
  if (degraded[key]) return
  degraded[key] = true
  log.warn(`pricing: ${key} unavailable in Fishbowl — continuing without it (${reason})`)
}

// Map(accountId -> [group name, …]) for every customer account, or null if accountgroup is unreadable.
async function accountGroups(fb, log) {
  if (degraded.accountGroups) return null
  let rows
  try {
    rows = await fb.query(q.accountGroups)
  } catch (e) {
    degrade('accountGroups', log, e.message.slice(0, 200))
    return null
  }
  const byAccount = new Map()
  for (const r of rows) {
    const id = Number(r.accountId)
    if (!Number.isFinite(id) || !r.name) continue
    if (!byAccount.has(id)) byAccount.set(id, [])
    const names = byAccount.get(id)
    if (!names.includes(r.name)) names.push(r.name)
  }
  return byAccount
}

// D-PRICE-20. `since` is fb_sync_state.last_customers_at (or null on the first run = full backfill);
// the read overlaps it by an hour so a customer saved while the previous poll was running is not missed.
export async function syncCustomers(fb, sky, { since = null, log, batch = 500 } = {}) {
  const from = since ? fbDateTime(new Date(Date.parse(since) - 3600000)) : null
  let rows
  try {
    rows = await fb.query(q.customers(from, !degraded.paymentTerms))
  } catch (e) {
    if (degraded.paymentTerms) throw e
    degrade('paymentTerms', log, e.message.slice(0, 200))
    rows = await fb.query(q.customers(from, false))
  }
  if (rows.length === 0) {
    // Still call the RPC: an empty payload upserts nothing but stamps last_customers_at, so a quiet
    // 15 minutes reads as "polled, no changes" on the /pricing banner rather than as a stalled poller.
    await sky.upsertCustomers([])
    log.info(`customers: nothing modified since ${from}`)
    return { read: 0, upserted: 0 }
  }
  const groups = await accountGroups(fb, log)
  const mapped = rows.map((r) => mapCustomer(r, groups)).filter((r) => r.id !== null)
  let upserted = 0
  for (const part of chunk(mapped, batch)) upserted += Number(await sky.upsertCustomers(part)) || 0
  log.info(`customers: ${rows.length} read ${from ? `since ${from}` : '(full backfill)'}, ${upserted} upserted`)
  return { read: rows.length, upserted }
}

// Nightly full snapshot of Fishbowl's product list — the Resale section's Eaches and Phase F's
// parity baseline. The RPC also links price_items.fb_product_id by product number.
export async function syncProducts(fb, sky, { log, batch = 500 } = {}) {
  const rows = await fb.query(q.products)
  const mapped = rows.map(mapProduct).filter((r) => r.id !== null && r.num !== '')
  let upserted = 0
  for (const part of chunk(mapped, batch)) upserted += Number(await sky.upsertProducts(part)) || 0
  log.info(`products: ${rows.length} read, ${upserted} upserted`)
  return { read: rows.length, upserted }
}

// D-PRICE-19. Pages by so.dateLastModified from the stored cursor; each page is upserted and carries
// its own max dateLastModified as the new cursor, so an interrupted run resumes where it stopped.
// Overlap on the page boundary is harmless — the upsert is keyed on fb_soitem_id.
export async function syncHistory(fb, sky, { cursor, log, pageSize = 2000, batch = 500, maxPages = 500 } = {}) {
  let since = fbDateTime(cursor)
  if (!since) throw new Error(`history: unusable cursor ${JSON.stringify(cursor)}`)
  const totals = { pages: 0, read: 0, upserted: 0, cursor: ts(cursor) }
  for (let page = 1; page <= maxPages; page++) {
    const rows = await fb.query(q.soHistory(since, pageSize))
    if (rows.length === 0) break
    totals.pages++
    totals.read += rows.length

    // The page is ordered by dateLastModified, so the last row carries the page's maximum.
    const maxModified = rows[rows.length - 1].dateLastModified
    const next = fbDateTime(maxModified)
    const mapped = rows.map(mapHistoryLine).filter((r) => r.soItemId !== null)
    const batches = chunk(mapped, batch)
    let upserted = 0
    for (let b = 0; b < batches.length; b++) {
      // Only the batch that closes the page moves the cursor; a partial batch passes NULL and leaves it.
      const closesPage = b === batches.length - 1
      upserted += Number(await sky.upsertSoHistory(batches[b], closesPage ? ts(maxModified) : null)) || 0
    }
    totals.upserted += upserted
    totals.cursor = ts(maxModified)
    log.info(`history: page ${page} rows=${rows.length} upserted=${upserted} cursor=${totals.cursor}`)
    if (rows.length < pageSize) break

    if (next === since) {
      // A full page that does not advance the clock would loop forever. Never seen in practice
      // (2000 lines sharing one dateLastModified second), but the loop must not be able to hang.
      log.error(`history: page ${page} full but dateLastModified did not advance past ${since} — stopping`)
      break
    }
    since = next
    if (page === maxPages) log.warn(`history: stopped at the ${maxPages}-page cap; next run resumes from ${totals.cursor}`)
  }
  // A night with nothing to read still stamps last_history_at (empty payload, NULL cursor) so the
  // /pricing banner shows a fresh poll rather than the age of the last order anyone happened to touch.
  if (totals.pages === 0) await sky.upsertSoHistory([], null)
  log.info(`history: ${totals.pages} page(s), ${totals.read} line(s) read, ${totals.upserted} upserted, cursor=${totals.cursor}`)
  return totals
}

// --- nightly scheduling -------------------------------------------------------------------------
// "Due" means: today's HH:MM (Fishbowl's local clock) has passed and the last run was before it.
// Driven by the fb_sync_state timestamps rather than an in-process timer, so a restart cannot make a
// nightly job run twice, and a bridge that was down at 02:20 catches up as soon as it comes back.
export function nightlyDue(lastAt, hhmm, now = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  if (!m) throw new Error(`nightly time must be HH:MM, got ${JSON.stringify(hhmm)}`)
  const target = new Date(now)
  target.setHours(Number(m[1]), Number(m[2]), 0, 0)
  if (now < target) return false
  if (!lastAt) return true
  const last = new Date(lastAt)
  return !Number.isFinite(last.getTime()) || last < target
}
