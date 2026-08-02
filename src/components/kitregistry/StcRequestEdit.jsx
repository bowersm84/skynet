import { useState, useRef, useCallback } from 'react'
import { Loader2, CheckCircle, Lock } from 'lucide-react'
import { formatLogDate, lotLabel } from '../../lib/kitRegistry'
import {
  STATUS_LABEL, REQUIRED_FIELDS, requestToFormFields, validateEditFields,
  editGuardedFields, kitMismatchLabel, fieldForMessage, updateStcRequest,
} from '../../lib/stcIntake'
import StcRequestFields from './StcRequestFields'
import { Pill } from './ui'
import { useStcMatchHints } from './hooks'

// Edit mode for an existing request (D-KSTC-21). The fields, labels, asterisks
// and validation come from the same two places the intake form uses — the shared
// StcRequestFields component and the rules beside the RPC wrapper — so a
// correction is held to exactly the standard a new request is.
//
// What is NOT editable here: status, intake #, and the linked lot. Linking and
// status transitions are the C2 resolution workflow, not a text edit. They render
// as static context so the person correcting a claim can see what it is attached
// to.

export default function StcRequestEdit({ detail, onCancel, onSaved }) {
  const r = detail.request
  const issued = r.status === 'issued'

  const [form, setForm] = useState(() => requestToFormFields(r))
  const [fieldErrors, setFieldErrors] = useState({})
  const [saveError, setSaveError] = useState(null)
  const [saving, setSaving] = useState(false)

  // A single ref bag filled by StcRequestFields via a register callback: passing
  // an object of refs across the component boundary trips react-hooks/refs.
  const fieldRefs = useRef({})
  const registerField = useCallback((key, el) => { fieldRefs.current[key] = el }, [])

  const hints = useStcMatchHints(form)
  const kitMismatch = kitMismatchLabel(form.claimedKitNumber, detail.lot)

  // Editing is no-regression (D-KSTC-23): only fields that already hold a value
  // are guarded, and the asterisk marks exactly those. A field the paper record
  // never filled stays unmarked and may be saved still blank.
  const guarded = editGuardedFields(r)

  const set = (key, value) => {
    setForm(prev => ({ ...prev, [key]: value }))
    setFieldErrors(prev => (prev[key] ? { ...prev, [key]: undefined } : prev))
    setSaveError(null)
  }

  const focusFirstInvalid = (errors) => {
    for (const [key] of REQUIRED_FIELDS) {
      const el = fieldRefs.current[key]
      if (errors[key] && el) {
        el.focus({ preventScroll: true })
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return
      }
    }
  }

  const handleSave = async () => {
    // An issued request can only reach the RPC with a notes change, so the
    // no-regression rules would only ever fire on fields it cannot edit.
    if (!issued) {
      const errors = validateEditFields(form, r)
      setFieldErrors(errors)
      if (Object.keys(errors).length) {
        setSaveError(null)
        focusFirstInvalid(errors)
        return
      }
    }

    setSaving(true)
    setSaveError(null)
    try {
      const { fieldsChanged } = await updateStcRequest(r.id, form)
      // A save that changed nothing is not an event — close without ceremony
      // rather than announcing "0 fields updated".
      onSaved({ fieldsChanged })
    } catch (err) {
      console.error('Updating the STC request failed:', err)
      const message = err.message || 'Could not save this request.'
      // Server-side refusals land under the field they are about; the issued
      // lock and anything else sits by the Save button.
      const key = fieldForMessage(message)
      if (key) {
        setFieldErrors(prev => ({ ...prev, [key]: message }))
        focusFirstInvalid({ [key]: message })
      } else {
        setSaveError(message)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {/* ---- Static context: what this edit cannot change ---- */}
      <div className="mb-5 rounded-xl border border-gray-700 bg-gray-800/60 p-4">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="font-mono font-bold text-white">intake #{r.intake_number}</span>
          <Pill tone={r.status === 'issued' ? 'green' : r.status === 'unidentifiable' ? 'amber' : 'blue'}>
            {STATUS_LABEL[r.status] || r.status}
          </Pill>
          {detail.lot
            ? <Pill tone="blue">linked to {lotLabel(detail.lot)}</Pill>
            : <Pill tone="amber">unlinked</Pill>}
        </div>
        <p className="text-gray-500 text-xs">
          Status, linked kit and intake # aren&rsquo;t edited here — linking and status changes are
          resolution work.
          {detail.author?.full_name ? ` Logged by ${detail.author.full_name}.` : ''}
          {r.created_at ? ` ${formatLogDate(String(r.created_at).slice(0, 10))}.` : ''}
        </p>
      </div>

      {issued && (
        <div className="mb-5 flex items-start gap-2 rounded-lg border border-amber-700/60 bg-amber-900/20 px-3 py-2.5">
          <Lock size={15} className="text-amber-400 shrink-0 mt-0.5" />
          <p className="text-amber-100 text-sm">
            This request has been issued — the claims behind a document already sent can&rsquo;t be
            changed after the fact. Notes stay open so the record can still grow.
          </p>
        </div>
      )}

      {/* The blank fields on a historical row are not a chore to clear before
          this record can be touched — they are the honest state of the paper
          it came from (D-KSTC-23). */}
      {!issued && (
        <p className="text-gray-500 text-xs mb-4">
          Blank fields from the paper record may stay blank until the information is known.
        </p>
      )}

      <StcRequestFields
        form={form}
        onChange={set}
        fieldErrors={fieldErrors}
        registerField={registerField}
        kitMismatch={kitMismatch}
        hints={hints}
        lockedExceptNotes={issued}
        requiredFields={guarded}
      />

      {!issued && (
        <p className="text-gray-500 text-xs mb-3">
          <span className="text-red-400">*</span> already recorded — these can be corrected but not
          emptied. Claims still save exactly as written; nothing here is reformatted for you.
        </p>
      )}

      {saveError && <p className="text-red-400 text-sm mb-3">{saveError}</p>}

      <div className="flex flex-wrap gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 min-w-[12rem] py-3 rounded-xl bg-skynet-accent hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-semibold flex items-center justify-center gap-2"
        >
          {saving ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle size={18} />}
          Save changes
        </button>
        <button
          onClick={onCancel}
          disabled={saving}
          className="px-6 py-3 rounded-xl bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm font-medium"
        >
          Cancel
        </button>
      </div>
    </>
  )
}
