// Helpers for promoting a job-level upload into the part's master document
// set with versioning. Used at every upload surface that exposes the
// "Also save as part-level" opt-in (pre-mfg compliance Upload/Replace/Additional,
// WO Lookup AddJobDocumentModal).

// Bumps "Rev A" → "B"; falls back to "A" for empty/non-matching prev. Clamps
// at "Z" rather than overflowing into a multi-letter scheme — Skybolt part
// revisions don't approach this in practice.
export function getNextVersionLetter(prev) {
  if (!prev) return 'A'
  const m = /^Rev ([A-Z])$/.exec(prev)
  if (!m) return 'A'
  const nextCode = m[1].charCodeAt(0) + 1
  return nextCode > 'Z'.charCodeAt(0) ? 'Z' : String.fromCharCode(nextCode)
}

// Promote an uploaded file to part_documents with revision bumping.
// - If a current row exists for (part_id, document_type_id), flip it to
//   is_current=false and insert a new row with the next "Rev X".
// - If none exists, insert a new row at "Rev A".
// No-op (returns released-with-null version) when partId or documentTypeId
// is missing — caller passes those through from whatever surface invoked it.
//
// Returns { error, version }. Caller decides whether to surface a failure.
export async function promoteToPartDocument(supabase, {
  partId,
  documentTypeId,
  fileName,
  fileUrl,
  fileSize,
  mimeType,
  uploadedBy,
  revisionNotes,
}) {
  if (!partId || !documentTypeId) return { error: null, version: null }

  const { data: prevRow, error: prevErr } = await supabase
    .from('part_documents')
    .select('id, version')
    .eq('part_id', partId)
    .eq('document_type_id', documentTypeId)
    .eq('is_current', true)
    .maybeSingle()
  if (prevErr) return { error: prevErr, version: null }

  if (prevRow) {
    const { error: oldErr } = await supabase
      .from('part_documents')
      .update({ is_current: false })
      .eq('id', prevRow.id)
    if (oldErr) return { error: oldErr, version: null }
  }

  const nextVersion = `Rev ${getNextVersionLetter(prevRow?.version)}`
  const { error: newErr } = await supabase
    .from('part_documents')
    .insert({
      part_id: partId,
      document_type_id: documentTypeId,
      file_name: fileName,
      file_url: fileUrl,
      file_size: fileSize,
      mime_type: mimeType,
      version: nextVersion,
      revision_notes: revisionNotes ?? null,
      uploaded_by: uploadedBy ?? null,
      is_current: true,
    })
  if (newErr) return { error: newErr, version: null }
  return { error: null, version: nextVersion }
}
