// Unit test for cp-gmail-ingest's parsing layer (S16 Batch B).
// Run: node --experimental-strip-types supabase/functions/cp-gmail-ingest/parse.test.mjs
import assert from 'node:assert/strict'
import {
  parseAddressList, threadKey, normMsgId, direction, stripQuoted, htmlToText, findRefs, extractParts,
  parseGmailMessage, gmailQuery, decodeB64Url, stripCid, isAutoReply,
} from './parse.ts'

let n = 0
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++ }
const ok = (c, msg) => { assert.ok(c, msg); n++ }
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

eq(parseAddressList('"Chayon, Adam" <Adam@kaytech.com>, sales@kaytech.com, Matt Bowers <mbowers@skybolt.com>').map(a => a.email),
  ['adam@kaytech.com', 'sales@kaytech.com', 'mbowers@skybolt.com'], 'address list with a quoted comma')
eq(parseAddressList('"Chayon, Adam" <Adam@kaytech.com>')[0].name, 'Chayon, Adam', 'quoted name kept')
eq(normMsgId('<CAB123@mail.gmail.com>'), 'CAB123@mail.gmail.com', 'message id')
eq(threadKey('<root@x> <mid@x>', '<mid@x>', 'me@x'), 'root@x', 'thread root from References')
eq(threadKey(undefined, '<parent@x>', 'me@x'), 'parent@x', 'thread from In-Reply-To')
eq(threadKey(undefined, undefined, 'me@x'), 'me@x', 'new thread')

const K = ['kaytech.com']
eq(direction({ email: 'adam@kaytech.com' }, [{ email: 'mbowers@skybolt.com' }], [], K), 'in', 'in')
eq(direction({ email: 'mbowers@skybolt.com' }, [{ email: 'abraun@skybolt.com' }], [{ email: 'quality@kaytech.com' }], K), 'out', 'out via cc')
eq(direction({ email: 'mbowers@skybolt.com' }, [{ email: 'nbowers@skybolt.com' }], [], K), 'internal', 'internal')

const reply = 'Thanks Matt, we will send the deposit.\n\nBill\n\nOn Tue, Oct 27, 2026 at 12:41 PM Matt Bowers <mbowers@skybolt.com> wrote:\n> Hi Bill,\n> deposit is $43,029.02'
eq(stripQuoted(reply), 'Thanks Matt, we will send the deposit.\n\nBill', 'gmail quote cut')
const outlook = 'Please advise.\n\nFrom: Sandy Medina <Sandy@kaytech.com>\nSent: Tuesday, October 27, 2026 11:18 AM\nTo: April'
eq(stripQuoted(outlook), 'Please advise.', 'outlook quote cut')
eq(stripQuoted('Hello\n________________________________\nFrom: x'), 'Hello', 'underscore separator')
eq(htmlToText('<div>Hi&nbsp;Matt,<br>PO 165251</div><style>.x{}</style><p>Thanks &amp; regards</p>'), 'Hi Matt,\nPO 165251\nThanks & regards', 'html to text')

const known = { parts: ['QL4-21', 'QL8C78', 'SK21037-4-4HS', 'QL4S-ET2'], pos: ['165251', '165058'], sos: ['15968', '8291'] }
eq(findRefs('RE: P.O. - 165251 and Po 165058; QL4-21 drawing; S8291-04 credit; RMA 261007-20; R.F.Q. - 371300; QL4-210 is not QL4-21X', known),
  ['PART:QL4-21', 'PO:165058', 'PO:165251', 'RFQ:371300', 'RMA:261007-20', 'SO:8291'], 'refs')
eq(findRefs('Kaytech PO 163050 /165326 parts SK21037-4-4HS', known), ['PART:SK21037-4-4HS', 'PO:163050'], 'unknown PO after "PO" is tagged; a bare unknown number is not')
eq(findRefs('lot 4142 and 4144', known), [], 'lot numbers are not orders')

// MIME walk: text/plain wins, attachments are metadata only
const payload = {
  mimeType: 'multipart/mixed', headers: [],
  parts: [
    { mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/plain', body: { data: b64('Plain body é') } },
      { mimeType: 'text/html', body: { data: b64('<p>Html body</p>') } },
    ] },
    { mimeType: 'application/pdf', filename: 'drawing.pdf', body: { size: 12345, attachmentId: 'ATT1' } },
  ],
}
const ex = extractParts(payload)
eq([ex.text, ex.attachments], ['Plain body é', [{ filename: 'drawing.pdf', mime_type: 'application/pdf', size: 12345 }]], 'mime walk')
ok(!JSON.stringify(ex).includes('ATT1'), 'attachment id is not kept')
eq(decodeB64Url(b64('ünïcode')), 'ünïcode', 'utf8 decode')

const msg = {
  id: 'g1', internalDate: String(Date.UTC(2026, 9, 27, 16, 41)), snippet: 'Dear Matt, Please assist&#39;s',
  payload: { mimeType: 'text/html', headers: [
    { name: 'Message-ID', value: '<abc@kaytech.com>' }, { name: 'From', value: 'Sales <sales@kaytech.com>' },
    { name: 'To', value: 'Matt Bowers <mbowers@skybolt.com>' }, { name: 'Cc', value: 'Adam Chayon <Adam@kaytech.com>' },
    { name: 'Subject', value: 'FW: expedite' }, { name: 'References', value: '<root@kaytech.com>' },
  ], body: { data: b64('<p>Please advise when you are shipping Po 165184</p><p>From: Sandy</p><p>Sent: today</p>') } },
}
const p = parseGmailMessage(msg, 'mbowers@skybolt.com', K, known)
eq([p.rfc822_id, p.thread_key, p.direction, p.from_addr, p.cc_addrs, p.sent_at], ['abc@kaytech.com', 'root@kaytech.com', 'in', 'sales@kaytech.com', ['adam@kaytech.com'], '2026-10-27T16:41:00.000Z'], 'parsed message')
eq(p.body_new, 'Please advise when you are shipping Po 165184', 'html body, quote cut')
eq(p.refs, ['PO:165184'], 'refs from body')
eq(p.snippet, "Dear Matt, Please assist's", 'snippet entities')
eq(gmailQuery({ mode: 'domain', label_name: null }, K, '2026/01/01'), '{from:kaytech.com to:kaytech.com cc:kaytech.com} after:2026/01/01', 'domain query')
eq(gmailQuery({ mode: 'label', label_name: 'Kaytech' }, K, '2026/10/25'), 'label:Kaytech after:2026/10/25', 'label query')

eq(findRefs('Skybolt Return - 8291AB-02', known), ['SO:8291'], 'credit memo SO with AB suffix')
eq(findRefs('Return - 7777AB-02', known), [], 'unknown SO without prefix is not tagged')
eq(stripCid('Sandy Medina\n[cid:image001.jpg@01DD655D.BE998940] [cid:image002.png@01DD]\nKaytech'), 'Sandy Medina\n\nKaytech'.replace('\n\n','\n\n'), 'cid markers removed')
ok(isAutoReply({ 'auto-submitted': 'auto-replied' }), 'auto-submitted header')
ok(isAutoReply({ subject: 'Out of the office RE: P.O. - 165251' }), 'OOO subject')
ok(!isAutoReply({ 'auto-submitted': 'no', subject: 'RE: P.O. - 165251' }), 'normal message')
const fwd = { ...msg, payload: { ...msg.payload, headers: msg.payload.headers.map(x => x.name === 'Message-ID' ? { name: 'Message-ID', value: '<fwd@k>' } : x), body: { data: b64('<p>Dear Matt, please give dates.</p><p>From: Sandy</p><p>Sent: today</p><p>Po 165058</p>') } } }
eq(parseGmailMessage(fwd, 'mbowers@skybolt.com', K, known).refs, ['PO:165058'], 'forward with no refs in the new text falls back to the whole body')
console.log(`cp-gmail-ingest parse: ${n} assertions passed`)
