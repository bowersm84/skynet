// Client-side unpacking of whatever a salesperson drops on the STC intake
// dropzone (D-KSTC-18).
//
// Outlook .msg and RFC-822 .eml are parsed IN THE BROWSER — the Edge Function
// receives already-extracted text and already-separated attachments, never a
// container it would have to learn two more file formats to open. Two outputs
// come back from one pass:
//
//   blocks   — what stc-extract can actually READ (text, PDFs, images)
//   holdings — every file that will be STORED against the saved request,
//              including the container itself and attachments extraction
//              can't read (a .docx, a .zip). Nothing is silently discarded.
//
// Nothing here touches the network or the database.

import MsgReader from '@kenjiuno/msgreader'
import PostalMime from 'postal-mime'

// What the dropzone advertises. Anything else that arrives by drag-and-drop is
// still HELD for storage — it just can't be read (see buildIntakePayload).
export const ACCEPTED_EXTENSIONS = ['.msg', '.eml', '.pdf', '.png', '.jpg', '.jpeg', '.txt']
export const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.join(',')

const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

// Text pulled out of an email body. Long enough for a threaded reply chain,
// bounded so a 40-message thread can't crowd out the attachments.
const MAX_BODY_CHARS = 60000

export function extensionOf(name) {
  const m = /\.[^.]+$/.exec(String(name || ''))
  return m ? m[0].toLowerCase() : ''
}

// Browsers report .msg as application/octet-stream (or nothing at all), so the
// extension is the only reliable signal for the container formats.
function mediaTypeFor(name, declared) {
  const ext = extensionOf(name)
  if (ext === '.pdf') return 'application/pdf'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.txt') return 'text/plain'
  return declared || 'application/octet-stream'
}

// Chunked — String.fromCharCode.apply on a multi-MB array blows the stack.
function toBase64(bytes) {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

// Last resort when an email carries no text/plain alternative.
function htmlToText(html) {
  if (!html) return ''
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function clip(text) {
  const s = String(text || '')
  return s.length > MAX_BODY_CHARS
    ? `${s.slice(0, MAX_BODY_CHARS)}\n\n[…truncated for extraction — the full file is attached to this intake]`
    : s
}

// The header block matters as much as the body: received_date and the
// requester's address usually only exist up here.
function composeEmail({ from, to, date, subject, body }) {
  const lines = []
  if (from) lines.push(`From: ${from}`)
  if (to) lines.push(`To: ${to}`)
  if (date) lines.push(`Date: ${date}`)
  if (subject) lines.push(`Subject: ${subject}`)
  lines.push('')
  lines.push(clip(body || ''))
  return lines.join('\n')
}

function addressText(addr) {
  if (!addr) return ''
  const list = Array.isArray(addr) ? addr : [addr]
  return list
    .map(a => (a?.name && a.address ? `${a.name} <${a.address}>` : (a?.address || a?.name || '')))
    .filter(Boolean)
    .join(', ')
}

// A parsed attachment becomes a real File so it rides the ordinary S3 upload
// path (lib/s3.js) with no special case at the other end.
function asFile(bytes, name, mimeType) {
  return new File([bytes], name, { type: mimeType })
}

// Blocks carry `holdingKey` and holdings carry `parentKey` so the form can drop
// a file — and everything that came out of it — without re-parsing anything, and
// without re-sending removed content on a later extraction pass.
let holdingSeq = 0
function makeHolding(file, { documentType, origin, parentKey = null }) {
  holdingSeq += 1
  return {
    key: `h${holdingSeq}`,
    parentKey,
    file,
    name: file.name,
    size: file.size,
    mimeType: file.type || mediaTypeFor(file.name, null),
    documentType,          // editable in the form, except the source email
    origin,                // 'upload' | `attachment of {parent}`
    readable: false,       // set true when the file also became a block
  }
}

// One attachment → a block if we can read it, a note if we can't. Either way
// it is held for storage.
async function ingestAttachment(bytes, rawName, declaredType, parent, out) {
  const name = rawName || 'attachment'
  const mimeType = mediaTypeFor(name, declaredType)
  const file = asFile(bytes, name, mimeType)
  const holding = makeHolding(file, {
    documentType: 'other',
    origin: `attachment of ${parent.name}`,
    parentKey: parent.key,
  })
  out.holdings.push(holding)

  if (mimeType === 'application/pdf') {
    holding.readable = true
    out.blocks.push({ holdingKey: holding.key, type: 'document', name, media_type: 'application/pdf', data: toBase64(bytes) })
  } else if (IMAGE_MEDIA_TYPES.includes(mimeType)) {
    holding.readable = true
    out.blocks.push({ holdingKey: holding.key, type: 'image', name, media_type: mimeType, data: toBase64(bytes) })
  } else if (mimeType === 'text/plain') {
    holding.readable = true
    out.blocks.push({ holdingKey: holding.key, type: 'text', name, text: clip(new TextDecoder().decode(bytes)) })
  } else {
    out.unreadable.push(name)
  }
}

async function ingestMsg(file, holding, out) {
  const reader = new MsgReader(await file.arrayBuffer())
  const msg = reader.getFileData()
  if (msg?.error) throw new Error(msg.error)

  const body = msg.body || htmlToText(msg.bodyHtml)
  const recipients = (msg.recipients || [])
    .map(r => (r.name && r.email ? `${r.name} <${r.email}>` : (r.email || r.name || '')))
    .filter(Boolean)
    .join(', ')
  const sender = msg.senderName && (msg.senderSmtpAddress || msg.senderEmail)
    ? `${msg.senderName} <${msg.senderSmtpAddress || msg.senderEmail}>`
    : (msg.senderSmtpAddress || msg.senderEmail || msg.senderName || '')

  out.blocks.push({
    holdingKey: holding.key,
    type: 'text',
    name: file.name,
    text: composeEmail({
      from: sender,
      to: recipients,
      // clientSubmitTime is when the customer hit send; delivery time is the
      // fallback when Outlook didn't record it.
      date: msg.clientSubmitTime || msg.messageDeliveryTime || null,
      subject: msg.subject,
      body,
    }),
  })

  const attachments = msg.attachments || []
  for (let i = 0; i < attachments.length; i += 1) {
    const meta = attachments[i]
    if (meta?.attachmentHidden) continue          // inline signature images etc.
    let data
    try {
      data = reader.getAttachment(i)
    } catch (err) {
      console.error('Could not read a .msg attachment:', err)
      out.unreadable.push(meta?.fileName || meta?.fileNameShort || `attachment ${i + 1}`)
      continue
    }
    const bytes = data?.content
    if (!bytes?.length) continue
    await ingestAttachment(
      bytes,
      data.fileName || meta?.fileName || meta?.fileNameShort || `attachment-${i + 1}`,
      null,
      holding,
      out,
    )
  }
}

async function ingestEml(file, holding, out) {
  const email = await PostalMime.parse(await file.arrayBuffer())

  out.blocks.push({
    holdingKey: holding.key,
    type: 'text',
    name: file.name,
    text: composeEmail({
      from: addressText(email.from),
      to: addressText(email.to),
      date: email.date || null,
      subject: email.subject,
      body: email.text || htmlToText(email.html),
    }),
  })

  for (const att of email.attachments || []) {
    const content = att?.content
    if (!content) continue
    const bytes = content instanceof Uint8Array
      ? content
      : typeof content === 'string'
        ? new TextEncoder().encode(content)
        : new Uint8Array(content)
    if (!bytes.length) continue
    await ingestAttachment(bytes, att.filename, att.mimeType, holding, out)
  }
}

/**
 * Turn dropped files into { blocks, holdings, unreadable, errors }.
 *
 * blocks    → POST body for stc-extract (empty means nothing was readable)
 * holdings  → every file to store against the request once it is saved
 * unreadable→ names to show as "will be attached, not readable by extraction"
 * errors    → per-file parse failures; the caller shows them and carries on
 *
 * A file that fails to parse is STILL held for storage. Losing the customer's
 * paperwork because a parser choked is never the right trade.
 */
export async function buildIntakePayload(files) {
  const out = { blocks: [], holdings: [], unreadable: [], errors: [] }

  for (const file of files || []) {
    const ext = extensionOf(file.name)
    // The container the customer forwarded IS the request email — the one
    // document type the form doesn't ask about (D-KSTC-18).
    const isSourceEmail = ext === '.msg' || ext === '.eml' || ext === '.txt'
    const holding = makeHolding(file, {
      documentType: isSourceEmail ? 'request_email' : 'other',
      origin: 'upload',
    })
    out.holdings.push(holding)

    try {
      if (ext === '.msg') {
        holding.readable = true
        await ingestMsg(file, holding, out)
      } else if (ext === '.eml') {
        holding.readable = true
        await ingestEml(file, holding, out)
      } else if (ext === '.txt') {
        holding.readable = true
        out.blocks.push({ holdingKey: holding.key, type: 'text', name: file.name, text: clip(await file.text()) })
      } else if (ext === '.pdf') {
        holding.readable = true
        out.blocks.push({
          holdingKey: holding.key,
          type: 'document',
          name: file.name,
          media_type: 'application/pdf',
          data: toBase64(new Uint8Array(await file.arrayBuffer())),
        })
      } else if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
        holding.readable = true
        out.blocks.push({
          holdingKey: holding.key,
          type: 'image',
          name: file.name,
          media_type: mediaTypeFor(file.name, file.type),
          data: toBase64(new Uint8Array(await file.arrayBuffer())),
        })
      } else {
        // Not on the accepted list — kept, just not read.
        out.unreadable.push(file.name)
      }
    } catch (err) {
      console.error(`Could not parse ${file.name}:`, err)
      holding.readable = false
      out.errors.push(`${file.name} could not be read (${err.message || 'parse failed'}).`)
      out.unreadable.push(file.name)
    }
  }

  return out
}
