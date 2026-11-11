// run-test-mo.mjs — S17 D1 (D-ASM-52): bridge 1.12 against SkyNet TEST for the assembly MO run, from Matt's PC.
// Sets the run's switches over whatever .env says, and refuses to start unless the SkyNet it would sign in to is
// TEST and the pricing push is off. Run from the bridge folder:  node scripts/run-test-mo.mjs   (add --dry-run to log
// the MO request bodies without writing). Stop with Ctrl+C: the bridge finishes its cycle and logs "bridge stopped".
const TEST_HOST = 'ylzmyjjqibpbqbwjsnqj.supabase.co'

process.env.FB_PUSH_KINDS = 'mo_create,mo_cancel,mo_close_short' // no pricing kind
process.env.FB_PUSH_ENABLED = 'false'                            // the pricing switch stays off
process.env.FB_PUSH_AUTO = 'false'                               // queue no pricing push on TEST
process.env.FB_MO_ENABLED = 'true'
process.env.FB_MO_DRY_RUN = process.argv.includes('--dry-run') ? 'true' : 'false'
process.env.FB_WRITE_PART_PREFIX = 'SKYTEST-'
process.env.FB_TAGS_INTERVAL_MS = '60000'

const { config } = await import('../src/config.mjs')
let host = ''
try { host = new URL(config.sb.url).host } catch { /* reported below */ }
if (host !== TEST_HOST) {
  console.error(`run-test-mo: refusing to start — SB_URL points at ${host || config.sb.url}, not SkyNet TEST (${TEST_HOST}).`)
  process.exit(1)
}
if (config.push.enabled || config.push.kinds.some((k) => ['prices', 'rules', 'tree', 'groups'].includes(k))) {
  console.error('run-test-mo: refusing to start — a pricing push would be possible.')
  process.exit(1)
}
await import('../src/index.mjs')
