import { useState, useEffect } from 'react'
import { X, Loader2, Upload } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { uploadDocument } from '../lib/s3'
import { promoteToPartDocument } from '../lib/documents'

export default function AddJobDocumentModal({ isOpen, jobId, partId, profile, onClose, onSuccess }) {
  const [file, setFile] = useState(null)
  const [documentTypeId, setDocumentTypeId] = useState('')
  const [notes, setNotes] = useState('')
  const [saveToPart, setSaveToPart] = useState(false)
  const [documentTypes, setDocumentTypes] = useState([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isOpen) return
    setFile(null)
    setDocumentTypeId('')
    setNotes('')
    setSaveToPart(false)
    setError('')
    ;(async () => {
      const { data, error: dtErr } = await supabase
        .from('document_types')
        .select('id, name')
        .eq('is_active', true)
        .order('sort_order')
      if (dtErr) {
        console.error('Failed to load document types:', dtErr)
        return
      }
      setDocumentTypes(data || [])
    })()
  }, [isOpen])

  if (!isOpen) return null

  // The "Other" document type is a real row in document_types, surfaced for
  // ad-hoc uploads (one-off certs, notes, etc.). We treat it as job-scoped only
  // — selecting it disables the part-level promotion checkbox.
  const otherTypeId = documentTypes.find(t => t.name === 'Other')?.id || null
  const isOther = !!otherTypeId && documentTypeId === otherTypeId
  const resolvedTypeId = documentTypeId || null
  const notesTrimmed = notes.trim()
  const canSubmit = !!file && !!documentTypeId && (!isOther || notesTrimmed.length > 0)

  const handleSubmit = async () => {
    if (!canSubmit) {
      if (isOther && !notesTrimmed) setError('Notes are required when document type is "Other".')
      return
    }
    setSaving(true)
    setError('')
    try {
      const { filePath, fileSize, mimeType } = await uploadDocument(file, `jobs/${jobId}`)

      const { error: jdErr } = await supabase
        .from('job_documents')
        .insert({
          job_id: jobId,
          document_type_id: resolvedTypeId,
          file_name: file.name,
          file_url: filePath,
          file_size: fileSize,
          mime_type: mimeType,
          uploaded_by: profile?.id ?? null,
          status: 'approved',
          notes: notesTrimmed || null,
          source: 'operator_uploaded',
        })
      if (jdErr) throw jdErr

      // Optionally promote to the part's master document set with versioning.
      // Only meaningful for typed documents — "Other" entries are job-specific
      // and have no part-level slot to live in.
      if (saveToPart && resolvedTypeId && partId) {
        const { error: promoteErr } = await promoteToPartDocument(supabase, {
          partId,
          documentTypeId: resolvedTypeId,
          fileName: file.name,
          fileUrl: filePath,
          fileSize,
          mimeType,
          uploadedBy: profile?.id ?? null,
          revisionNotes: notesTrimmed || null,
        })
        if (promoteErr) throw promoteErr
      }

      // Auto-clear deferred flag if every required type is now satisfied.
      // Keeps documents_deferred_reason/by/at intact for audit trail.
      if (partId) {
        const [{ data: required }, { data: present }] = await Promise.all([
          supabase
            .from('part_document_requirements')
            .select('document_type_id')
            .eq('part_id', partId)
            .eq('is_required', true)
            .eq('required_at', 'compliance_review'),
          supabase
            .from('job_documents')
            .select('document_type_id')
            .eq('job_id', jobId)
            .not('document_type_id', 'is', null),
        ])
        const requiredSet = new Set((required || []).map(r => r.document_type_id))
        const presentSet = new Set((present || []).map(p => p.document_type_id))
        const allSatisfied = requiredSet.size > 0 && [...requiredSet].every(id => presentSet.has(id))
        if (allSatisfied) {
          await supabase
            .from('jobs')
            .update({ documents_deferred: false })
            .eq('id', jobId)
        }
      }

      onSuccess?.()
      onClose()
    } catch (err) {
      console.error('Add job document failed:', err)
      setError(err.message || 'Upload failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[70] p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Add Document</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white" disabled={saving}>
            <X size={20} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-400 uppercase tracking-wide">File *</label>
            <input
              type="file"
              onChange={e => setFile(e.target.files?.[0] || null)}
              className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm file:mr-3 file:px-3 file:py-1 file:bg-skynet-accent file:text-white file:border-0 file:rounded file:cursor-pointer focus:outline-none focus:border-skynet-accent"
            />
            {file && (
              <div className="text-xs text-gray-500 mt-1">
                {file.name} · {(file.size / 1024).toFixed(1)} KB
              </div>
            )}
          </div>

          <div>
            <label className="text-xs text-gray-400 uppercase tracking-wide">Document Type *</label>
            <select
              value={documentTypeId}
              onChange={e => setDocumentTypeId(e.target.value)}
              className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
            >
              <option value="">— Select —</option>
              {documentTypes.map(dt => (
                <option key={dt.id} value={dt.id}>{dt.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-gray-400 uppercase tracking-wide">
              Notes {isOther && <span className="text-red-400">*</span>}
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              placeholder={isOther ? 'Required — describe the document' : 'Optional'}
              className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-skynet-accent resize-none"
            />
          </div>

          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={saveToPart}
              onChange={e => setSaveToPart(e.target.checked)}
              disabled={isOther}
              className="mt-1"
            />
            <div>
              <div className="text-sm text-gray-300">Also save as part-level document for future jobs</div>
              <div className="text-xs text-gray-500">
                {isOther
                  ? '"Other" documents are job-specific and cannot be promoted to the part.'
                  : 'When checked, this document is added to the part’s master set and auto-attached to future jobs of this part. A new revision is created.'}
              </div>
            </div>
          </label>
        </div>

        {error && (
          <div className="border border-red-700/50 bg-red-900/20 rounded-lg p-3 text-sm text-red-200">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button onClick={onClose} disabled={saving} className="px-4 py-2 text-gray-400 hover:text-white">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !canSubmit}
            className="px-6 py-2 bg-skynet-accent hover:bg-skynet-accent/80 disabled:opacity-50 text-white font-medium rounded-lg flex items-center gap-2"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            Upload
          </button>
        </div>
      </div>
    </div>
  )
}
