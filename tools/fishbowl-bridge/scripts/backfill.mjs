// backfill.mjs — one-shot load of every Issued / In Progress SO (D-FB-17), then cursor set + manual-CO linkage.
// Safe to re-run: ingest is idempotent, the cursor only moves forward, linkage skips already-linked rows.
//   node scripts/backfill.mjs
import { config } from '../src/config.mjs'
import { Fishbowl } from '../src/fishbowl.mjs'
import { SkyNet, makeLogger } from '../src/skynet.mjs'
import { q } from '../src/queries.mjs'
import { ingestIds } from '../src/sync.mjs'

const log = makeLogger(config.logDir)
const fb = new Fishbowl(config.fb, log)
const sky = new SkyNet(config.sb, log)

async function main() {
  await sky.signIn()
  await fb.login()
  try {
    // Capture the revision BEFORE reading, so anything changed during the backfill is replayed by the tail.
    const [{ maxRev }] = await fb.query(q.maxRev)
    const open = await fb.query(q.openSos)
    const ids = open.map((r) => Number(r.id))
    log.info(`backfill: ${ids.length} open SO(s) (Issued + In Progress); Fishbowl max_rev=${maxRev}`)

    const totals = await ingestIds(fb, sky, ids, { source: 'backfill', chunkSize: config.chunk, log })
    log.info(`backfill ingested ${totals.orders} order(s)`)

    const cursor = await sky.setCursor(Number(maxRev))
    log.info(`cursor set → ${JSON.stringify(cursor)}`)

    const link = await sky.linkExistingCOs()
    log.info(`link existing COs → ${JSON.stringify(link, null, 2)}`)

    await sky.heartbeat({ last_rev: Number(maxRev), version: config.version, host: config.host, last_error: null, backfilled: true })
    log.info('backfill complete')
  } finally {
    await fb.logout()
  }
}

main().catch((e) => {
  log.error(`backfill failed: ${e.stack || e.message}`)
  process.exit(1)
})
