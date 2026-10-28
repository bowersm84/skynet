// SkyNet — cp-gmail-ingest parsing layer (S16 Batch B, D-CPROG-07..11).
//
// Pure. No imports, no network, no Deno APIs — index.ts does the I/O and this file turns a Gmail
// API message into the row we store. Kept separate so it can be unit-tested from Node
// (node --experimental-strip-types parse.test.mjs) without a Deno runtime or Gmail.
//
// Attachments: names, types and sizes only. Contents are never fetched, decoded or stored
// (D-CPROG-09; organization rule on customer-owned drawings and technical data).

export interface GmailHeader { name: string; value: string }
export interface GmailPart {
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { size?: number; data?: string; attachmentId?: string }
  parts?: GmailPart[]
}
export interface Address { name: string | null; email: string }
export interface AttachmentMeta { filename: string; mime_type: string | null; size: number | null }

const BODY_NEW_MAX = 20000
const BODY_FULL_MAX = 100000

export function headerMap(headers: GmailHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const h of headers || []) {
    const k = String(h.name || '').toLowerCase()
    if (!(k in out)) out[k] = String(h.value ?? '')
  }
  return out
}

// Message-IDs without the angle brackets; case kept (the local part is case-sensitive).
export function normMsgId(v: string | null | undefined): string | null {
  const m = String(v || '').match(/<([^>]+)>/)
  const id = (m ? m[1] : String(v || '')).trim()
  return id || null
}

export function msgIdList(v: string | null | undefined): string[] {
  return [...String(v || '').matchAll(/<([^>]+)>/g)].map(m => m[1].trim()).filter(Boolean)
}

// Root of the conversation: the first id in References, else In-Reply-To, else the message itself.
export function threadKey(references: string | undefined, inReplyTo: string | undefined, messageId: string): string {
  const refs = msgIdList(references)
  if (refs.length) return refs[0]
  const parent = normMsgId(inReplyTo)
  return parent || messageId
}

// Split an address header on commas that are outside quotes and angle brackets.
export function parseAddressList(v: string | null | undefined): Address[] {
  const s = String(v || '')
  const items: string[] = []
  let cur = ''
  let inQuote = false
  let inAngle = false
  for (const ch of s) {
    if (ch === '"') inQuote = !inQuote
    else if (ch === '<' && !inQuote) inAngle = true
    else if (ch === '>' && !inQuote) inAngle = false
    if (ch === ',' && !inQuote && !inAngle) { items.push(cur); cur = '' } else cur += ch
  }
  if (cur.trim()) items.push(cur)
  const out: Address[] = []
  for (const raw of items) {
    const item = raw.trim()
    if (!item) continue
    const angle = item.match(/^(.*)<([^>]+)>\s*$/)
    if (angle) {
      const name = angle[1].trim().replace(/^"|"$/g, '').trim()
      out.push({ name: name || null, email: angle[2].trim().toLowerCase() })
    } else if (item.includes('@')) {
      out.push({ name: null, email: item.replace(/^mailto:/i, '').trim().toLowerCase() })
    }
  }
  return out
}

export function domainOf(email: string): string {
  return String(email || '').split('@')[1]?.toLowerCase() || ''
}

export function matchesDomain(email: string, domains: string[]): boolean {
  const d = domainOf(email)
  return domains.some(x => d === x.toLowerCase() || d.endsWith('.' + x.toLowerCase()))
}

// in = the customer wrote it; out = Skybolt wrote to the customer; internal = no customer address.
export function direction(from: Address | null, to: Address[], cc: Address[], domains: string[]): 'in' | 'out' | 'internal' {
  if (from && matchesDomain(from.email, domains)) return 'in'
  if ([...to, ...cc].some(a => matchesDomain(a.email, domains))) return 'out'
  return 'internal'
}

export function decodeB64Url(data: string | undefined): string {
  if (!data) return ''
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : ''
  const bin = atob(b64 + pad)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

// Walk the MIME tree: the first text/plain and first text/html body, plus attachment metadata.
export function extractParts(payload: GmailPart | undefined): { text: string; html: string; attachments: AttachmentMeta[] } {
  let text = ''
  let html = ''
  const attachments: AttachmentMeta[] = []
  const walk = (p: GmailPart | undefined) => {
    if (!p) return
    const mime = String(p.mimeType || '').toLowerCase()
    if (p.filename) {
      attachments.push({ filename: p.filename, mime_type: p.mimeType || null, size: p.body?.size ?? null })
    } else if (mime === 'text/plain' && !text && p.body?.data) {
      text = decodeB64Url(p.body.data)
    } else if (mime === 'text/html' && !html && p.body?.data) {
      html = decodeB64Url(p.body.data)
    }
    for (const c of p.parts || []) walk(c)
  }
  walk(payload)
  return { text, html, attachments }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z#0-9]+);/gi, (m, k) => ENTITIES[k.toLowerCase()] ?? m)
}

export function htmlToText(html: string): string {
  return decodeEntities(
    String(html || '')
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// The new part of a reply: everything above the first quote marker.
const QUOTE_MARKERS: RegExp[] = [
  /^On .{6,200}wrote:\s*$/m,
  /^On (Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^\n]*\n[^\n]*wrote:\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^-{2,}\s*Forwarded message\s*-{2,}/im,
  /^_{10,}\s*$/m,
  /^From:\s[^\n]+\n(Sent|Date):\s/m,
  /^\*From:\*\s/m,
]
export function stripQuoted(text: string): string {
  const s = String(text || '').replace(/\r/g, '')
  let cut = s.length
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(s)
    if (m && m.index < cut && m.index > 0) cut = m.index
  }
  // Drop any run of '>'-quoted lines that survived.
  const kept = s.slice(0, cut).split('\n').filter(l => !/^\s*>/.test(l)).join('\n')
  return kept.replace(/\n{3,}/g, '\n\n').trim()
}

// Inline-image placeholders Outlook leaves in the text body: [cid:image001.jpg@01DD655D.BE998940]
export function stripCid(text: string): string {
  return String(text || '').replace(/\[cid:[^\]]*\]/gi, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// Out-of-office and other automatic replies are stored hidden, so they never clutter the trail
// but the mailbox does not fetch them again.
export function isAutoReply(h: Record<string, string>): boolean {
  const auto = (h['auto-submitted'] || '').trim().toLowerCase()
  if (auto && auto !== 'no') return true
  if (h['x-autoreply'] || h['x-autorespond'] || /auto_reply/i.test(h['precedence'] || '')) return true
  return /^(automatic reply|auto[- ]?reply|out of (the )?office)\b/i.test((h['subject'] || '').trim())
}

export function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\n[…truncated]' : s
}

// Tags a message with the orders, parts, RFQs and RMAs it mentions (D-CPROG-11).
// known.parts / known.pos / known.sos come from the program's Fishbowl history and quotes.
export function findRefs(text: string, known: { parts: string[]; pos: string[]; sos: string[] }): string[] {
  const s = String(text || '')
  const up = s.toUpperCase()
  const out = new Set<string>()
  const token = (t: string) => new RegExp(`(^|[^A-Z0-9-])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Z0-9-])`)
  for (const p of known.parts) if (p && token(p.toUpperCase()).test(up)) out.add(`PART:${p.toUpperCase()}`)
  for (const po of known.pos) if (po && token(po).test(up)) out.add(`PO:${po}`)
  for (const m of up.matchAll(/\bP\.?\s?O\.?\s*(?:NUMBER|NO\.?|#)?\s*[:#-]?\s*(\d{5,7})\b/g)) out.add(`PO:${m[1]}`)
  // Case-sensitive on the original text: "SO 15392" and "S15392" tag, "so 2027" and "Kaytech's 2026" don't.
  for (const m of s.matchAll(/\b(?:SO|S\.O\.)\s?#?\s?-?\s?(\d{4,5})(?:AB)?(?:-\d{2})?\b/g)) out.add(`SO:${m[1]}`)
  for (const m of s.matchAll(/\bsales order\s?#?\s?(\d{4,5})\b/gi)) out.add(`SO:${m[1]}`)
  for (const m of s.matchAll(/\bS(\d{4,5})(?:AB)?(?:-\d{2})?\b/g)) out.add(`SO:${m[1]}`)
  for (const so of known.sos) if (so && token(`S${so}`).test(up)) out.add(`SO:${so}`)
  for (const m of up.matchAll(/\b(\d{4,5})(?:AB)?-\d{2}\b/g)) if (known.sos.includes(m[1])) out.add(`SO:${m[1]}`)
  for (const m of up.matchAll(/\bR\.?F\.?Q\.?\s*[-#:]?\s*(\d{5,7})\b/g)) out.add(`RFQ:${m[1]}`)
  for (const m of up.matchAll(/\bRMA\s*[#:]?\s*(\d{6}-\d{2})\b/g)) out.add(`RMA:${m[1]}`)
  return [...out].sort()
}

export interface ParsedMessage {
  rfc822_id: string
  thread_key: string
  in_reply_to: string | null
  sent_at: string
  from_addr: string | null
  from_name: string | null
  to_addrs: string[]
  cc_addrs: string[]
  subject: string | null
  snippet: string | null
  body_new: string
  body_full: string
  attachments: AttachmentMeta[]
  direction: 'in' | 'out' | 'internal'
  refs: string[]
  auto_reply: boolean
}

// deno-lint-ignore no-explicit-any
export function parseGmailMessage(m: any, mailbox: string, domains: string[], known: { parts: string[]; pos: string[]; sos: string[] }): ParsedMessage {
  const h = headerMap(m?.payload?.headers)
  const rfc = normMsgId(h['message-id']) || `gmail:${mailbox}:${m.id}`
  const from = parseAddressList(h['from'])[0] || null
  const to = parseAddressList(h['to'])
  const cc = parseAddressList(h['cc'])
  const { text, html, attachments } = extractParts(m?.payload)
  const full = stripCid((text || htmlToText(html)).replace(/\r/g, ''))
  const fresh = stripQuoted(full)
  const subject = h['subject'] ?? null
  return {
    rfc822_id: rfc,
    thread_key: threadKey(h['references'], h['in-reply-to'], rfc),
    in_reply_to: normMsgId(h['in-reply-to']),
    sent_at: new Date(Number(m.internalDate) || Date.parse(h['date']) || Date.now()).toISOString(),
    from_addr: from?.email ?? null,
    from_name: from?.name ?? null,
    to_addrs: to.map(a => a.email),
    cc_addrs: cc.map(a => a.email),
    subject,
    snippet: m.snippet ? decodeEntities(String(m.snippet)) : null,
    body_new: clip(fresh, BODY_NEW_MAX),
    body_full: clip(full, BODY_FULL_MAX),
    attachments,
    direction: direction(from, to, cc, domains),
    // Tags come from the subject and the new text; a forward with nothing new falls back to the whole body.
    refs: (() => {
      const r = findRefs(`${subject || ''}\n${fresh}`, known)
      return r.length ? r : findRefs(full, known)
    })(),
    auto_reply: isAutoReply(h),
  }
}

// Gmail search for one source. Domain mode reads both directions; label mode is whatever Matt files.
export function gmailQuery(source: { mode: string; label_name: string | null }, domains: string[], afterYmd: string): string {
  if (source.mode === 'label') {
    const label = String(source.label_name || '').trim().replace(/\s+/g, '-')
    return `label:${label} after:${afterYmd}`
  }
  const terms = domains.flatMap(d => [`from:${d}`, `to:${d}`, `cc:${d}`]).join(' ')
  return `{${terms}} after:${afterYmd}`
}
