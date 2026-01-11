import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { 
  ChevronDown, 
  ChevronRight, 
  Upload, 
  Check, 
  Eye, 
  AlertCircle, 
  CheckCircle, 
  Clock,
  X,
  FileText
} from 'lucide-react'

export default function ComplianceReview({ jobs, onUpdate, profile }) {
  const [expandedJob, setExpandedJob] = useState(null)
  const [jobDetails, setJobDetails] = useState({})
  const [uploading, setUploading] = useState(null)
  const [approving, setApproving] = useState(null)

  const loadJobDetails = async (jobId) => {
    if (jobDetails[jobId]) return

    const job = jobs.find(j => j.id === jobId)
    console.log('Loading details for job:', job)
    
    if (!job?.component?.id) {
      console.log('No component ID found for job')
      setJobDetails(prev => ({
        ...prev,
        [jobId]: {
          requirements: [],
          partDocs: [],
          jobDocs: [],
          noComponent: true
        }
      }))
      return
    }

    const { data: requirements, error: reqError } = await supabase
      .from('part_document_requirements')
      .select('*, document_type:document_types(*)')
      .eq('part_id', job.component.id)
    
    console.log('Requirements:', requirements, 'Error:', reqError)

    const { data: partDocs, error: partError } = await supabase
      .from('part_documents')
      .select('*, document_type:document_types(*)')
      .eq('part_id', job.component.id)
      .eq('is_current', true)
    
    console.log('Part docs:', partDocs, 'Error:', partError)

    const { data: jobDocs, error: jobError } = await supabase
      .from('job_documents')
      .select('*, document_type:document_types(*)')
      .eq('job_id', jobId)
    
    console.log('Job docs:', jobDocs, 'Error:', jobError)

    setJobDetails(prev => ({
      ...prev,
      [jobId]: {
        requirements: requirements || [],
        partDocs: partDocs || [],
        jobDocs: jobDocs || []
      }
    }))
  }

  const toggleJob = async (jobId) => {
    if (expandedJob === jobId) {
      setExpandedJob(null)
    } else {
      setExpandedJob(jobId)
      await loadJobDetails(jobId)
    }
  }

  const handleFileUpload = async (jobId, documentTypeId, documentTypeCode, file) => {
    const uploadKey = jobId + '-' + documentTypeId
    setUploading(uploadKey)
    
    try {
      const job = jobs.find(j => j.id === jobId)
      const fileExt = file.name.split('.').pop()
      const fileName = job.job_number + '_' + documentTypeCode + '_' + Date.now() + '.' + fileExt
      const filePath = 'jobs/' + jobId + '/' + fileName

      const { error: uploadError } = await supabase.storage
        .from('documents')
        .upload(filePath, file)

      if (uploadError) throw uploadError

      const { data: urlData } = supabase.storage
        .from('documents')
        .getPublicUrl(filePath)

      // Always upload to job_documents so each job has its own approval workflow
      const { error: dbError } = await supabase
        .from('job_documents')
        .insert({
          job_id: jobId,
          document_type_id: documentTypeId,
          file_name: file.name,
          file_url: urlData.publicUrl,
          file_size: file.size,
          mime_type: file.type,
          uploaded_by: profile.id,
          status: 'pending'
        })

      if (dbError) throw dbError

      setJobDetails(prev => ({ ...prev, [jobId]: null }))
      await loadJobDetails(jobId)
      
    } catch (err) {
      console.error('Upload error:', err)
      alert('Failed to upload document: ' + err.message)
    }
    
    setUploading(null)
  }

  const handleApproveDocument = async (docId, jobId) => {
    setApproving(docId)
    
    try {
      const { error } = await supabase
        .from('job_documents')
        .update({
          status: 'approved',
          approved_by: profile.id,
          approved_at: new Date().toISOString()
        })
        .eq('id', docId)

      if (error) throw error

      setJobDetails(prev => ({ ...prev, [jobId]: null }))
      await loadJobDetails(jobId)
      
    } catch (err) {
      console.error('Approve error:', err)
      alert('Failed to approve document')
    }
    
    setApproving(null)
  }

  const handleApproveJob = async (jobId) => {
    setApproving(jobId)
    
    try {
      const { error } = await supabase
        .from('jobs')
        .update({ status: 'ready' })
        .eq('id', jobId)

      if (error) throw error
      onUpdate()
      
    } catch (err) {
      console.error('Approve job error:', err)
      alert('Failed to approve job')
    }
    
    setApproving(null)
  }

    const handleCancelJob = async (jobId) => {
    if (!confirm('Are you sure you want to cancel this job?')) return

    try {
        const { error } = await supabase
        .from('jobs')
        .update({ status: 'cancelled' })
        .eq('id', jobId)

        if (error) throw error
        onUpdate()
        
    } catch (err) {
        console.error('Cancel job error:', err)
        alert('Failed to cancel job: ' + err.message)
    }
    }

  const getDocumentStatus = (jobId, docTypeId) => {
    const details = jobDetails[jobId]
    if (!details) return { status: 'loading', doc: null }

    // All documents now go through job_documents for per-job approval
    const jobDoc = details.jobDocs.find(d => d.document_type_id === docTypeId)
    if (!jobDoc) return { status: 'missing', doc: null }
    if (jobDoc.status === 'approved') return { status: 'approved', doc: jobDoc }
    return { status: 'pending', doc: jobDoc }
  }

  const canApproveJob = (jobId) => {
    const details = jobDetails[jobId]
    if (!details) return false
    if (details.noComponent) return true
    
    // Only check requirements that are needed at compliance_review stage
    const complianceReqs = details.requirements.filter(r => 
      r.required_at === 'compliance_review' || !r.required_at
    )
    
    if (complianceReqs.length === 0) return true

    for (let i = 0; i < complianceReqs.length; i++) {
      const req = complianceReqs[i]
      if (!req.is_required) continue
      
      const docStatus = getDocumentStatus(jobId, req.document_type_id)
      
      // All docs must be approved
      if (docStatus.status !== 'approved') return false
    }
    
    return true
  }

  const getPriorityColor = (priority) => {
    if (priority === 'critical') return 'bg-red-500'
    if (priority === 'high') return 'bg-yellow-500'
    if (priority === 'normal') return 'bg-green-500'
    return 'bg-gray-500'
  }

  const getPriorityBorder = (priority) => {
    if (priority === 'critical') return 'border-red-700'
    if (priority === 'high') return 'border-yellow-700'
    if (priority === 'normal') return 'border-green-700'
    return 'border-gray-700'
  }

  const getDocBgClass = (status) => {
    if (status === 'approved') {
      return 'bg-green-900/20 border-green-800'
    }
    if (status === 'pending') {
      return 'bg-yellow-900/20 border-yellow-800'
    }
    return 'bg-gray-700 border-gray-600'
  }

  const getStageLabel = (stage) => {
    if (stage === 'manufacturing_complete') return 'After Manufacturing'
    if (stage === 'tco') return 'Before TCO'
    return 'Compliance Review'
  }

  const ViewButton = ({ url }) => {
    if (!url) return null
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded">
        <Eye size={12} />
        View
      </a>
    )
  }

  if (jobs.length === 0) return null

  return (
    <div className="bg-gray-900 rounded-lg border border-purple-800 p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-purple-400 font-semibold flex items-center gap-2">
          <Clock size={18} />
          Pending Compliance Review ({jobs.length})
        </h3>
      </div>
      
      <div className="space-y-2">
        {jobs.map(job => {
          const isExpanded = expandedJob === job.id
          const details = jobDetails[job.id]
          const jobCanApprove = details ? canApproveJob(job.id) : false
          const borderClass = getPriorityBorder(job.priority)
          const dotClass = getPriorityColor(job.priority)

          // Split requirements by stage
          const complianceReqs = details?.requirements?.filter(r => 
            r.required_at === 'compliance_review' || !r.required_at
          ) || []
          const futureReqs = details?.requirements?.filter(r => 
            r.required_at === 'manufacturing_complete' || r.required_at === 'tco'
          ) || []

          return (
            <div key={job.id} className="bg-gray-800 rounded-lg overflow-hidden">
              <div 
                className={"flex items-center justify-between p-3 cursor-pointer hover:bg-gray-750 border-l-4 " + borderClass}
                onClick={() => toggleJob(job.id)}
              >
                <div className="flex items-center gap-4">
                  {isExpanded ? (
                    <ChevronDown size={18} className="text-purple-400" />
                  ) : (
                    <ChevronRight size={18} className="text-gray-500" />
                  )}
                  <div className={"w-3 h-3 rounded-full " + dotClass}></div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-white font-mono">{job.job_number}</span>
                      <span className="text-gray-500">•</span>
                      <span className="text-gray-400">{job.work_order?.wo_number}</span>
                      {job.work_order?.order_type === 'make_to_stock' && (
                        <span className="text-xs px-2 py-0.5 bg-green-900/50 text-green-400 rounded">Stock</span>
                      )}
                    </div>
                    <div className="text-sm text-gray-500">
                      <span className="text-skynet-accent">{job.component?.part_number}</span>
                      <span className="mx-2">•</span>
                      <span>Qty: {job.quantity}</span>
                      {job.work_order?.customer && (
                        <span className="mx-2">• {job.work_order.customer}</span>
                      )}
                    </div>
                  </div>
                </div>
                
                {!isExpanded && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleCancelJob(job.id); }}
                      className="flex items-center gap-1 px-3 py-1 text-sm bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
                    >
                      <X size={14} />
                      Cancel
                    </button>
                  </div>
                )}
              </div>

              {isExpanded && (
                <div className="border-t border-gray-700 p-4">
                  {/* Required Documents - Compliance Review Stage */}
                  <h4 className="text-gray-400 text-sm font-medium mb-3">Required Documents</h4>
                  
                  {!details && (
                    <div className="text-gray-500 text-sm">Loading documents...</div>
                  )}

                  {details && details.noComponent && (
                    <div className="text-yellow-500 text-sm bg-yellow-900/20 p-3 rounded">
                      This job has no component linked. Document requirements not available.
                    </div>
                  )}
                  
                  {details && !details.noComponent && complianceReqs.length === 0 && (
                    <div className="text-green-500 text-sm bg-green-900/20 p-3 rounded">
                      No documents required at this stage.
                    </div>
                  )}
                  
                  {details && !details.noComponent && complianceReqs.length > 0 && (
                    <div className="space-y-2">
                      {complianceReqs.map(req => {
                        const docStatus = getDocumentStatus(job.id, req.document_type_id)
                        const uploadKey = job.id + '-' + req.document_type_id
                        const isUploading = uploading === uploadKey
                        const isDocApproved = docStatus.status === 'approved'
                        const bgClass = getDocBgClass(docStatus.status)

                        return (
                          <div key={req.id} className={"flex items-center justify-between p-3 rounded border " + bgClass}>
                            <div className="flex items-center gap-3">
                              {isDocApproved && <CheckCircle size={18} className="text-green-500" />}
                              {docStatus.status === 'pending' && <Clock size={18} className="text-yellow-500" />}
                              {docStatus.status === 'missing' && <AlertCircle size={18} className="text-gray-500" />}
                              
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="text-white text-sm">{req.document_type.name}</span>
                                  {req.is_required && <span className="text-xs text-red-400">Required</span>}
                                </div>
                                {docStatus.doc && <div className="text-xs text-gray-500">{docStatus.doc.file_name}</div>}
                              </div>
                            </div>

                            <div className="flex items-center gap-2">
                              {/* View button - show if doc exists */}
                              {docStatus.doc && <ViewButton url={docStatus.doc.file_url} />}

                              {/* Upload button - show if not approved */}
                              {!isDocApproved && (
                                <label className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded cursor-pointer">
                                  <Upload size={12} />
                                  {isUploading ? 'Uploading...' : 'Upload'}
                                  <input
                                    type="file"
                                    className="hidden"
                                    onChange={(e) => {
                                      const selectedFile = e.target.files[0]
                                      if (selectedFile) {
                                        handleFileUpload(job.id, req.document_type_id, req.document_type.code, selectedFile)
                                      }
                                    }}
                                    disabled={isUploading}
                                  />
                                </label>
                              )}

                              {/* Approve button - show if doc uploaded but not approved */}
                              {docStatus.status === 'pending' && docStatus.doc && (
                                <button
                                  onClick={() => handleApproveDocument(docStatus.doc.id, job.id)}
                                  disabled={approving === docStatus.doc.id}
                                  className="flex items-center gap-1 px-2 py-1 text-xs bg-green-600 hover:bg-green-500 text-white rounded"
                                >
                                  <Check size={12} />
                                  {approving === docStatus.doc.id ? '...' : 'Approve'}
                                </button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Future Documents Section */}
                  {details && !details.noComponent && futureReqs.length > 0 && (
                    <div className="mt-6">
                      <h4 className="text-gray-500 text-sm font-medium mb-3 flex items-center gap-2">
                        <FileText size={16} />
                        Documents Required Later
                      </h4>
                      <div className="space-y-2">
                        {futureReqs.map(req => {
                          const docStatus = getDocumentStatus(job.id, req.document_type_id)
                          const hasDoc = docStatus.doc !== null

                          return (
                            <div key={req.id} className="flex items-center justify-between p-3 rounded border border-gray-700 bg-gray-800/50">
                              <div className="flex items-center gap-3">
                                <FileText size={18} className="text-gray-600" />
                                <div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-gray-400 text-sm">{req.document_type.name}</span>
                                    <span className="text-xs px-2 py-0.5 bg-gray-700 text-gray-400 rounded">
                                      {getStageLabel(req.required_at)}
                                    </span>
                                  </div>
                                  {hasDoc && <div className="text-xs text-green-500">Already uploaded</div>}
                                </div>
                              </div>
                              {hasDoc && <ViewButton url={docStatus.doc.file_url} />}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Footer with status and actions */}
                  <div className="mt-4 pt-4 border-t border-gray-700 flex justify-between items-center">
                    <div className="text-sm">
                      {jobCanApprove ? (
                        <span className="text-green-400 flex items-center gap-1">
                          <CheckCircle size={14} />
                          All required documents approved
                        </span>
                      ) : (
                        <span className="text-yellow-400 flex items-center gap-1">
                          <AlertCircle size={14} />
                          Missing or pending documents
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleCancelJob(job.id)}
                        className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
                      >
                        <X size={16} />
                        Cancel Job
                      </button>
                      <button
                        onClick={() => handleApproveJob(job.id)}
                        disabled={!jobCanApprove || approving === job.id}
                        className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <CheckCircle size={16} />
                        {approving === job.id ? 'Approving...' : 'Approve Job'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}