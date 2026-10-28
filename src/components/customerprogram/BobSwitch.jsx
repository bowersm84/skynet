// "Keep from Uncle Bob" switch for one message on the email trail (S16 Batch C, D-CPROG-16).
// Messages with an export-control or CUI marking are excluded automatically and can't be given
// back; anything else can be kept from Bob with a reason, and given back later.

import { Brain } from 'lucide-react'
import { setEmailForBob } from '../../lib/uncleBobProgram'

export default function BobSwitch({ m, onChanged }) {
  if (m.bob_excluded_auto) return null
  const toggle = async () => {
    try {
      if (m.bob_excluded_reason) {
        await setEmailForBob(m.id, false, null)
        onChanged('Uncle Bob can read this message again')
      } else {
        const reason = window.prompt('Keep this message from Uncle Bob? Reason (required):')
        if (!reason || !reason.trim()) return
        await setEmailForBob(m.id, true, reason.trim())
        onChanged('Message kept from Uncle Bob')
      }
    } catch (err) {
      alert(err.message)
    }
  }
  return (
    <button type="button" onClick={toggle} className="text-gray-500 hover:text-white inline-flex items-center gap-1">
      <Brain size={11} />{m.bob_excluded_reason ? 'Give back to Uncle Bob' : 'Keep from Uncle Bob'}
    </button>
  )
}
