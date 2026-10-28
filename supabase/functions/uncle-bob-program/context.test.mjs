// Run: node --experimental-strip-types supabase/functions/uncle-bob-program/context.test.mjs
import assert from 'node:assert/strict'
import { buildEmailContext, parseBobOutput, PER_MESSAGE_CHARS } from './context.ts'

let n = 0
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++ }
const ok = (c, m) => { assert.ok(c, m); n++ }

const row = (id, day, o = {}) => ({ id, sent_at: `2026-10-${day}T12:00:00Z`, from_name: 'Adam Chayon', from_addr: 'adam@kaytech.com',
  to_addrs: ['mbowers@skybolt.com'], cc_addrs: [], subject: `S${id}`, body_new: `body ${id}`, direction: 'in', refs: [], attachments: [], ...o })
const rows = [
  row('a', '20'), row('b', '27'), row('c', '25', { hidden_at: '2026-10-26' }),
  row('d', '22', { bob_excluded_reason: 'Marking: ITAR' }), row('e', '21', { attachments: [{ filename: 'PO.pdf', size: 1 }] }),
]
const ctx = buildEmailContext(rows)
eq(ctx.messages.map(m => m.key), ['E1', 'E2', 'E3'], 'keys in order')
eq(Object.values(ctx.keyMap).map(v => v.id), ['b', 'e', 'a'], 'newest first, hidden and excluded left out')
eq([ctx.included, ctx.excluded, ctx.truncated], [3, 2, 0], 'counts')
eq(ctx.messages[1].attachment_names, ['PO.pdf'], 'attachment names only')
ok(!JSON.stringify(ctx.messages).includes('ITAR'), 'excluded text never enters')
const long = buildEmailContext([row('x', '27', { body_new: 'y'.repeat(PER_MESSAGE_CHARS + 500) })])
eq(long.messages[0].text.length, PER_MESSAGE_CHARS, 'per-message cap')
const tight = buildEmailContext([row('p', '27', { body_new: 'a'.repeat(60) }), row('q', '26', { body_new: 'b'.repeat(60) })], 100)
eq([tight.included, tight.truncated], [1, 1], 'budget drops the oldest')

const out = parseBobOutput('```json\n' + JSON.stringify({
  answer: 'QL4-21 is waiting on the deposit.',
  citations: [{ kind: 'email', ref: 'e1', label: 'x' }, { kind: 'email', ref: 'E99' }, { kind: 'order', ref: 'PO 165251', label: 'QL4-21 10,000' }, { kind: 'money', ref: '' }],
  draft: { to: ['adam@kaytech.com'], subject: 'Deposit', body: 'Hi Adam,' },
  data_gaps: ['No drawing sign-off date on file'],
}) + '\n```', ctx.keyMap)
eq(out.citations.map(c => [c.kind, c.ref, c.email_id || null]), [['email', 'E1', 'b'], ['order', 'PO 165251', null]], 'email keys map back; unknown key and empty ref dropped')
eq(out.draft.subject, 'Deposit', 'draft kept')
eq(parseBobOutput('{"answer":"x","draft":{"body":"  "}}', {}).draft, null, 'empty draft is null')
assert.throws(() => parseBobOutput('no json here', {})); n++

console.log(`uncle-bob-program context: ${n} assertions passed`)
