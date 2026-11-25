// run-test-sandbox.mjs — S17 D2a (D-ASM-61): bridge 1.13 against SkyNet TEST and the Fishbowl 26.11 sandbox, from
// Matt's PC. Modelled on run-test-mo.mjs. Run from the bridge folder:
//   FB_SANDBOX_URL=http://<sandbox>:2456 node scripts/run-test-sandbox.mjs        (add --dry-run to write nothing)
// Stop with Ctrl+C: the bridge finishes its cycle and logs "bridge stopped".
//
// From D2a on, the TEST bridge runs with this launcher only. TEST's Fishbowl mirrors then follow the sandbox. Do not
// alternate it with run-test-mo.mjs (the live Fishbowl): the two servers number their records apart from 2026-11-24
// on, and mixing them would corrupt TEST's mirrors.
import { sandboxTarget, assertSandboxServer } from './sandboxGuard.mjs'

const TEST_HOST = 'ylzmyjjqibpbqbwjsnqj.supabase.co'

// Fences 1 and 2: the Fishbowl address comes from FB_SANDBOX_URL only, and is never the live server.
let target
try { target = sandboxTarget() } catch (e) { console.error(`run-test-sandbox: ${e.message}`); process.exit(1) }
process.env.FB_HOST = target.host
process.env.FB_PORT = String(target.port)

process.env.FB_PUSH_KINDS = 'mo_create,mo_cancel,mo_close_short,wo_post' // no pricing kind
process.env.FB_PUSH_ENABLED = 'false'                                    // the pricing switch stays off
process.env.FB_PUSH_AUTO = 'false'                                       // queue no pricing push on TEST
process.env.FB_MO_ENABLED = 'true'
process.env.FB_WO_POST_ENABLED = 'true'
process.env.FB_MO_DRY_RUN = process.argv.includes('--dry-run') ? 'true' : 'false'
process.env.FB_WRITE_PART_PREFIX = 'SKYTEST-'
process.env.FB_TAGS_INTERVAL_MS = '60000'

const { config } = await import('../src/config.mjs')
let host = ''
try { host = new URL(config.sb.url).host } catch { /* reported below */ }
if (host !== TEST_HOST) {
  console.error(`run-test-sandbox: refusing to start — SB_URL points at ${host || config.sb.url}, not SkyNet TEST (${TEST_HOST}).`)
  process.exit(1)
}
if (config.push.enabled || config.push.kinds.some((k) => ['prices', 'rules', 'tree', 'groups'].includes(k))) {
  console.error('run-test-sandbox: refusing to start — a pricing push would be possible.')
  process.exit(1)
}
if (config.fb.host !== target.host || config.fb.port !== target.port) {
  console.error(`run-test-sandbox: refusing to start — the bridge would talk to ${config.fb.host}:${config.fb.port}, not the sandbox ${target.host}:${target.port}.`)
  process.exit(1)
}

// Fence 3, before the bridge loop starts: sign in and check this is the 26.x SANDBOX.
const { Fishbowl } = await import('../src/fishbowl.mjs')
const quiet = { info: () => {}, warn: (m) => console.error(`[warn] ${m}`), error: (m) => console.error(`[error] ${m}`) }
const check = new Fishbowl(config.fb, quiet)
let isSandbox = false
try {
  await check.login()
  const s = await assertSandboxServer(check)
  isSandbox = true
  console.log(`run-test-sandbox: Fishbowl ${target.origin} is ${s.raw} (${s.version}), company "${s.company}" — the sandbox. MO writes ${process.env.FB_MO_DRY_RUN === 'true' ? 'DRY RUN' : 'on'}.`)
} catch (e) {
  console.error(`run-test-sandbox: ${e.message}`)
} finally {
  await check.logout()
}
if (!isSandbox) process.exit(1)

await import('../src/index.mjs')
