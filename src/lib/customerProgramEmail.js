// Customer Program Dashboard — email trail helpers (S16 Batch B, D-CPROG-08 / D-CPROG-11). Pure.
// Lives here rather than in components/customerprogram/EmailTrail.jsx so that file exports only a
// component (react-refresh/only-export-components).

// Threads newest-first; messages inside a thread oldest-first.
export function groupThreads(emails) {
  const map = new Map()
  for (const e of emails) {
    if (!map.has(e.thread_key)) map.set(e.thread_key, [])
    map.get(e.thread_key).push(e)
  }
  return [...map.entries()]
    .map(([key, msgs]) => {
      msgs.sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)))
      const last = msgs[msgs.length - 1]
      return {
        key,
        msgs,
        last,
        subject: (msgs.find(m => m.subject)?.subject || '(no subject)').replace(/^((re|fw|fwd):\s*)+/i, ''),
        refs: [...new Set(msgs.flatMap(m => m.refs || []))].sort(),
        directions: [...new Set(msgs.map(m => m.direction))],
      }
    })
    .sort((a, b) => String(b.last.sent_at).localeCompare(String(a.last.sent_at)))
}

export function emailsForLine(emails, line) {
  const keys = new Set([`PO:${line.customer_po}`, `SO:${line.so_number}`])
  return emails.filter(e => !e.hidden_at && (e.refs || []).some(r => keys.has(r)))
}
