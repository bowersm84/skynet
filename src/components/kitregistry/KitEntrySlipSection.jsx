import { useState } from 'react'
import { CheckCircle, AlertTriangle, ChevronDown, ChevronRight, Sparkles } from 'lucide-react'
import { needsAttention, soDigits, normalizePart } from '../../lib/packingSlip'
import { Pill } from './ui'
import SlipDropzone from './SlipDropzone'
import SlipReviewGrid, { SlipLineTable } from './SlipReviewGrid'

// The slip half of Kit Entry (D-KSTC-29). The bench logs the kit and uploads the
// slip in one motion, so the component lots land against the kit lot the moment
// it gets its number — no second trip to the Packing Slip tab.
//
// This section NEVER blocks the entry. The kit always saves; the slip is the
// optional half, and the one outcome worse than not recording component lots is
// recording them against the wrong kit. So the slip cross-examines the operator:
// the Order # it was printed with against the Sales Order # typed into the form,
// and the kit it lists against the Kit Name selected. Either disagreeing HOLDS
// the slip — loudly, with the reason and the two ways out.

export default function KitEntrySlipSection({ slipState, plan, soText, kitPartText }) {
  const [dragging, setDragging] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [showOthers, setShowOthers] = useState(false)

  const { slip, file, busy, error, ingest, reset, editLine, dropLine, clearError } = slipState

  const attention = plan.lines.filter(needsAttention)
  const otherGroups = (slip?.groups || [])
    .map((g, i) => ({ g, i }))
    .filter(({ i }) => i !== plan.groupIndex)

  return (
    <>
      <p className="text-gray-500 text-sm mb-2">
        Optional — attach the Fishbowl packing slip to record component lots with this kit.
      </p>

      <SlipDropzone
        compact
        title="Drop the packing slip here"
        hint="PDF from Fishbowl, or a photo of the printed slip"
        busy={busy}
        fileName={file?.name}
        error={error}
        onFiles={ingest}
        onClearError={clearError}
        onRemove={reset}
        dragging={dragging}
        setDragging={setDragging}
      />

      {slip && (
        <div className="mt-3 rounded-xl border border-gray-700 bg-gray-800/60 p-4">
          {/* ---- Agreement chips: does this slip belong to this entry? ---- */}
          <div className="flex flex-wrap gap-2">
            <AgreementChip
              ok={plan.soOk}
              okText={`SO ${soDigits(slip.order_number)} matches`}
              badText={
                soDigits(slip.order_number)
                  ? `slip is SO ${soDigits(slip.order_number)} · entry says ${soDigits(soText) || '—'}`
                  : 'no order # read from the slip'
              }
            />
            <AgreementChip
              ok={plan.groupIndex >= 0}
              okText={`Kit ${slip.groups[plan.groupIndex]?.parent_part_number} matches`}
              badText={
                normalizePart(kitPartText)
                  ? `no kit on the slip matches ${kitPartText.trim()}`
                  : 'no kit name entered yet'
              }
            />
          </div>

          {/* ---- HOLD banner ---- */}
          {plan.hold ? (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-600 bg-amber-900/25 px-3 py-2.5">
              <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-amber-100 text-sm font-medium">
                  Component lots will NOT be recorded: {plan.hold}.
                </p>
                <p className="text-amber-200/70 text-xs mt-1">
                  Fix the field or remove the slip. The kit entry itself saves either way.
                </p>
              </div>
            </div>
          ) : (
            <>
              <p className="text-gray-200 text-sm mt-3">
                <span className="font-mono font-semibold text-white">{plan.recordable.length}</span>
                {' '}component lot{plan.recordable.length === 1 ? '' : 's'} read
                {slip.ship_date ? <span className="text-gray-500"> · shipped {slip.ship_date}</span> : null}
              </p>

              {/* Anything the model wasn't plainly sure of, or couldn't read a
                  lot for, is put in front of the operator rather than left for
                  them to go looking for behind a disclosure. */}
              {attention.length > 0 && (
                <div className="mt-3">
                  <div className="flex items-start gap-2 mb-2">
                    <Sparkles size={14} className="text-amber-300 shrink-0 mt-0.5" />
                    <p className="text-amber-200/90 text-xs">
                      {attention.length} line{attention.length === 1 ? '' : 's'} need
                      {attention.length === 1 ? 's' : ''} a look — unreadable lot, or the
                      model was unsure. Check these against the paper.
                    </p>
                  </div>
                  <SlipLineTable
                    lines={attention}
                    onEdit={(key, field, value) => editLine(plan.groupIndex, key, field, value)}
                    onDrop={(key) => dropLine(plan.groupIndex, key)}
                    emptyText="Nothing needs attention."
                  />
                </div>
              )}

              {/* The rest confirm behind a disclosure — same editable grid, same
                  state, so an edit here and an edit above are one edit. */}
              {plan.lines.length > 0 && (
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => setShowAll(s => !s)}
                    className="flex items-center gap-2 text-gray-400 hover:text-gray-200 text-xs"
                  >
                    {showAll ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    Review all {plan.lines.length} line{plan.lines.length === 1 ? '' : 's'}
                  </button>
                  {showAll && (
                    <div className="mt-2">
                      <SlipReviewGrid
                        lines={plan.lines}
                        onEdit={(key, field, value) => editLine(plan.groupIndex, key, field, value)}
                        onDrop={(key) => dropLine(plan.groupIndex, key)}
                      />
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* ---- Other kits on the same slip ---- */}
          {otherGroups.length > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-700">
              <button
                type="button"
                onClick={() => setShowOthers(s => !s)}
                className="flex items-center gap-2 text-gray-400 hover:text-gray-200 text-xs"
              >
                {showOthers ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {otherGroups.length} other kit{otherGroups.length === 1 ? '' : 's'} on this slip
              </button>
              {showOthers && (
                <div className="mt-2 space-y-1.5">
                  {otherGroups.map(({ g, i }) => (
                    <div key={i} className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-gray-300 text-xs">{g.parent_part_number}</span>
                      <span className="text-gray-500 text-[11px]">
                        {g.lines.length} line{g.lines.length === 1 ? '' : 's'}
                      </span>
                      <Pill>belongs to another kit — upload this slip again when logging it</Pill>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  )
}

function AgreementChip({ ok, okText, badText }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border ${
      ok
        ? 'bg-green-900/30 border-green-700 text-green-200'
        : 'bg-amber-900/30 border-amber-600 text-amber-100'
    }`}>
      {ok ? <CheckCircle size={13} className="shrink-0" /> : <AlertTriangle size={13} className="shrink-0" />}
      {ok ? okText : badText}
    </span>
  )
}
