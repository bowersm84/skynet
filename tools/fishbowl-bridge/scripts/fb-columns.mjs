// fb-columns.mjs — discovery: print the columns Fishbowl 25.9 actually has for the tables the v1.7
// pollers read. Read-only. Run from the bridge folder with a valid .env (any SkyNet target; only Fishbowl is used):
//   node scripts/fb-columns.mjs pricingrule producttree producttotree productincltype customerincltype patype pabaseamounttype rndtype
import { config } from '../src/config.mjs'
import { Fishbowl } from '../src/fishbowl.mjs'

const tables = process.argv.slice(2)
if (tables.length === 0) { console.error('usage: node scripts/fb-columns.mjs <table> [<table> ...]'); process.exit(2) }
const log = { info: (m) => console.error(m), warn: (m) => console.error(m), error: (m) => console.error(m) }
const fb = new Fishbowl(config.fb, log)
try {
  await fb.login()
  for (const t of tables) {
    const safe = String(t).replace(/[^a-zA-Z0-9_]/g, '')
    const rows = await fb.query(`SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${safe}' ORDER BY ORDINAL_POSITION`)
    console.log(`\n== ${safe} (${rows.length} column(s))`)
    for (const r of rows) console.log(`  ${r.COLUMN_NAME ?? r.column_name}  ${r.DATA_TYPE ?? r.data_type}`)
    if (rows.length > 0) {
      const sample = await fb.query(`SELECT * FROM ${safe} LIMIT 3`)
      console.log(`  sample: ${JSON.stringify(sample).slice(0, 600)}`)
    }
  }
} finally {
  await fb.logout()
}
