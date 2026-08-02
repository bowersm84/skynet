import { CHANNELS } from '../../lib/stcIntake'
import { Pill } from './ui'

// The STC request field set — ONE derivation, rendered identically by the intake
// form and by the drawer's edit mode (D-KSTC-21). Labels, order, asterisks,
// placeholders, hints and the mismatch chip live here and nowhere else, so a
// change to what "required" looks like can't drift between creating a request
// and correcting one. The validation RULES behind the asterisks live next to the
// RPC wrapper in lib/stcIntake.js — same principle, one source.
//
// Props:
//   form         field values, keyed as lib/stcIntake expects
//   onChange     (key, value) => void
//   fieldErrors  { key: message } — inline messages under the field
//   registerField (key, el) => void — lets the parent focus the first invalid field
//   chipFor      optional (key) => node, used for the intake's AI confidence chips
//   kitMismatch  optional string — claimed number disagrees with the linked lot
//   hints        optional { kit, aircraft, company } from useStcMatchHints
//   lockedExceptNotes  issued requests: everything read-only but Notes
//   requiredFields optional Set of keys that carry an asterisk. Omitted means
//                  ALL of them (creation, D-KSTC-20). Edit mode passes the set
//                  that currently holds a value, because there the asterisk
//                  means "cannot be blanked", not "must be filled" (D-KSTC-23).

export default function StcRequestFields({
  form, onChange, fieldErrors = {}, registerField = () => {},
  chipFor, kitMismatch = null, hints = null, lockedExceptNotes = false,
  requiredFields = null,
}) {
  const chip = key => (chipFor ? chipFor(key) : null)
  const locked = lockedExceptNotes
  // No set supplied = creation, where every one of the eight is required.
  const req = key => (requiredFields ? requiredFields.has(key) : true)

  return (
    <div>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Received date" required={req('receivedDate')} error={fieldErrors.receivedDate} chip={chip('receivedDate')}>
          <input
            ref={el => registerField('receivedDate', el)}
            aria-required={req('receivedDate')}
            type="date"
            disabled={locked}
            value={form.receivedDate}
            onChange={e => onChange('receivedDate', e.target.value)}
            style={{ colorScheme: 'dark' }}
            className={inputClass(fieldErrors.receivedDate)}
          />
        </Field>
        <Field label="Channel" optional>
          <select
            disabled={locked}
            value={form.channel}
            onChange={e => onChange('channel', e.target.value)}
            className={inputClass()}
          >
            {CHANNELS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Requester name" required={req('requesterName')} error={fieldErrors.requesterName} chip={chip('requesterName')}>
          <input
            ref={el => registerField('requesterName', el)}
            aria-required={req('requesterName')}
            disabled={locked}
            value={form.requesterName}
            onChange={e => onChange('requesterName', e.target.value)}
            className={inputClass(fieldErrors.requesterName)}
          />
        </Field>
        <Field label="Email" optional chip={chip('requesterEmail')}>
          <input
            disabled={locked}
            value={form.requesterEmail}
            onChange={e => onChange('requesterEmail', e.target.value)}
            className={inputClass()}
          />
        </Field>
      </div>

      <Field label="Company" required={req('requesterCompany')} error={fieldErrors.requesterCompany} chip={chip('requesterCompany')}>
        <input
          ref={el => registerField('requesterCompany', el)}
          aria-required={req('requesterCompany')}
          disabled={locked}
          value={form.requesterCompany}
          onChange={e => onChange('requesterCompany', e.target.value)}
          className={inputClass(fieldErrors.requesterCompany)}
        />
        {hints?.company && (
          <Hint>
            {hints.company.exact
              ? `matches ${hints.company.name}`
              : `closest customer on file: ${hints.company.name}`}
          </Hint>
        )}
      </Field>

      <div className="grid sm:grid-cols-2 gap-4">
        {/* Required on every request, linked or not (D-KSTC-20). A claim that
            disagrees with the linked log shows the mismatch chip and still saves —
            the disagreement is data the office needs, not an error. */}
        <Field
          label="Claimed kit #"
          required={req('claimedKitNumber')}
          error={fieldErrors.claimedKitNumber}
          chip={kitMismatch ? <Pill tone="amber">{kitMismatch}</Pill> : chip('claimedKitNumber')}
        >
          <input
            ref={el => registerField('claimedKitNumber', el)}
            aria-required={req('claimedKitNumber')}
            disabled={locked}
            value={form.claimedKitNumber}
            onChange={e => onChange('claimedKitNumber', e.target.value)}
            placeholder="e.g. 99804"
            className={inputClass(fieldErrors.claimedKitNumber)}
          />
          {hints?.kit && !kitMismatch && (
            <Hint>
              matches {hints.kit.label}{hints.kit.customer ? ` — ${hints.kit.customer}` : ''}
            </Hint>
          )}
        </Field>
        <Field label="Claimed kit part" required={req('claimedKitPart')} error={fieldErrors.claimedKitPart} chip={chip('claimedKitPart')}>
          <input
            ref={el => registerField('claimedKitPart', el)}
            aria-required={req('claimedKitPart')}
            disabled={locked}
            value={form.claimedKitPart}
            onChange={e => onChange('claimedKitPart', e.target.value)}
            className={inputClass(fieldErrors.claimedKitPart)}
          />
        </Field>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Aircraft serial" required={req('claimedAircraftSerial')} error={fieldErrors.claimedAircraftSerial} chip={chip('claimedAircraftSerial')}>
          <input
            ref={el => registerField('claimedAircraftSerial', el)}
            aria-required={req('claimedAircraftSerial')}
            disabled={locked}
            value={form.claimedAircraftSerial}
            onChange={e => onChange('claimedAircraftSerial', e.target.value)}
            className={inputClass(fieldErrors.claimedAircraftSerial)}
          />
        </Field>
        <Field label="Registration" required={req('claimedRegistration')} error={fieldErrors.claimedRegistration} chip={chip('claimedRegistration')}>
          <input
            ref={el => registerField('claimedRegistration', el)}
            aria-required={req('claimedRegistration')}
            disabled={locked}
            value={form.claimedRegistration}
            onChange={e => onChange('claimedRegistration', e.target.value)}
            className={inputClass(fieldErrors.claimedRegistration)}
          />
        </Field>
      </div>

      {hints?.aircraft && (
        <Hint className="-mt-2 mb-5">
          matches {hints.aircraft.serial || '—'} / {hints.aircraft.registration || '—'}
          {hints.aircraft.makeModel ? ` · ${hints.aircraft.makeModel}` : ''}
          {hints.aircraft.viaHistory ? ' (former registration)' : ''}
        </Hint>
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Order #" required={req('claimedOrderNumber')} error={fieldErrors.claimedOrderNumber} chip={chip('claimedOrderNumber')}>
          <input
            ref={el => registerField('claimedOrderNumber', el)}
            aria-required={req('claimedOrderNumber')}
            disabled={locked}
            value={form.claimedOrderNumber}
            onChange={e => onChange('claimedOrderNumber', e.target.value)}
            placeholder="S-number, as the customer wrote it"
            className={inputClass(fieldErrors.claimedOrderNumber)}
          />
        </Field>
        <Field label="Purchased from" optional chip={chip('purchasedFrom')}>
          <input
            disabled={locked}
            value={form.purchasedFrom}
            onChange={e => onChange('purchasedFrom', e.target.value)}
            className={inputClass()}
          />
        </Field>
      </div>

      {/* Notes stays editable even on an issued request: the claims underpinning
          a sent document must not move, but the record of what happened should
          always be able to grow. */}
      <Field label="Notes" optional chip={chip('notes')}>
        <textarea
          value={form.notes}
          onChange={e => onChange('notes', e.target.value)}
          rows={3}
          className={`${inputClass()} resize-none`}
        />
      </Field>
    </div>
  )
}

// ---------- internal presentation ------------------------------------------

function inputClass(error) {
  return `w-full px-3 py-2.5 bg-gray-800 border rounded-lg text-white text-sm placeholder-gray-500 focus:border-skynet-accent focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${
    error ? 'border-red-500' : 'border-gray-700'
  }`
}

// One marking convention across the module (D-KSTC-16): a red asterisk means the
// save will be refused without it, "(optional)" means it genuinely can be left
// blank. A field never carries both.
function Field({ label, required, optional, error, chip, children }) {
  return (
    <div className="mb-5">
      <label className="flex items-center gap-2 text-gray-400 text-sm font-medium mb-2">
        <span>
          {label}
          {required && <span className="text-red-400 ml-1" aria-hidden="true">*</span>}
          {optional && !required && <span className="text-gray-500 font-normal ml-1">(optional)</span>}
        </span>
        {chip}
      </label>
      {children}
      {error && <p className="text-red-400 text-sm mt-1.5">{error}</p>}
    </div>
  )
}

function Hint({ children, className = '' }) {
  return <p className={`text-green-400 text-xs mt-1.5 ${className}`}>✓ {children}</p>
}
