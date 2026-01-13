import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { uploadDocument, getDocumentUrl } from '../lib/s3'
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
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Undo2
} from 'lucide-react'

export default function ComplianceReview({ jobs, onUpdate, profile }) {
  const [expandedJob, setExpandedJob] = useState(null)
  const [jobDetails, setJobDetails] = useState({})
  const [uploading, setUploading] = useState(null)
  const [approving, setApproving] = useState(null)
  const [replacing, setReplacing] = useState(null)
  const [recalling, setRecalling] = useState(null)
  const [viewingDoc, setViewingDoc] = useState(null)
  const [showRecentlyApproved, setShowRecentlyApproved] = useState(false)

  // Check if user has compliance permissions
  const isComplianceUser = profile?.role === 'compliance' || profile?.role === 'admin'

  // Filter jobs by category
  const pendingMachiningJobs = jobs.filter(job => job.status === 'pending_compliance')
  const pendingPostMfgJobs = jobs.filter(job => job.status === 'pending_post_manufacturing')
  const approvedUnassignedJobs = jobs.filter(job => job.status === 'ready' && !job.assigned_machine_id)
  
  // Recently approved: jobs that moved past pending_compliance in last 5 days
  // Using updated_at as proxy for approval date
  const fiveDaysAgo = new Date()
  fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5)
  const recentlyApprovedJobs = jobs.filter(job => {
    if (job.status === 'pending_compliance' || job.status === 'pending_post_manufacturing') return false
    if (job.status === 'cancelled') return false
    const updatedAt = new Date(job.updated_at)
    return updatedAt >= fiveDaysAgo
  })

  // Fetch job details from database
  const fetchJobDetails = async (jobId) => {
    const job = jobs.find(j => j.id === jobId)
    
    if (!job?.component?.id) {
      return {
        requirements: [],
        partDocs: [],
        jobDocs: [],
        noComponent: true
      }
    }

    const { data: requirements } = await supabase
      .from('part_document_requirements')
      .select('*, document_type:document_types(*)')
      .eq('part_id', job.component.id)

    const { data: partDocs } = await supabase
      .from('part_documents')
      .select('*, document_type:document_types(*)')
      .eq('part_id', job.component.id)
      .eq('is_current', true)

    const { data: jobDocs } = await supabase
      .from('job_documents')
      .select('*, document_type:document_types(*)')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true })

    return {
      requirements: requirements || [],
      partDocs: partDocs || [],
      jobDocs: jobDocs || []
    }
  }

  const loadJobDetails = async (jobId, forceRefresh = false) => {
    if (!forceRefresh && jobDetails[jobId]) return

    const details = await fetchJobDetails(jobId)
    setJobDetails(prev => ({
      ...prev,
      [jobId]: details
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
      const s3Path = `jobs/${jobId}`
      const { filePath, fileSize, mimeType } = await uploadDocument(file, s3Path)

      const { error: dbError } = await supabase
        .from('job_documents')
        .insert({
          job_id: jobId,
          document_type_id: documentTypeId,
          file_name: file.name,
          file_url: filePath,
          file_size: fileSize,
          mime_type: mimeType,
          uploaded_by: profile.id,
          status: 'pending'
        })

      if (dbError) throw dbError

      const freshDetails = await fetchJobDetails(jobId)
      setJobDetails(prev => ({ ...prev, [jobId]: freshDetails }))
      
    } catch (err) {
      console.error('Upload error:', err)
      alert('Failed to upload document: ' + err.message)
    }
    
    setUploading(null)
  }

  const handleReplaceDocument = async (docId, jobId, documentTypeId, file) => {
    setReplacing(docId)
    
    try {
      const s3Path = `jobs/${jobId}`
      const { filePath, fileSize, mimeType } = await uploadDocument(file, s3Path)

      const { error: dbError } = await supabase
        .from('job_documents')
        .update({
          file_name: file.name,
          file_url: filePath,
          file_size: fileSize,
          mime_type: mimeType,
          uploaded_by: profile.id,
          status: 'pending',
          approved_by: null,
          approved_at: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', docId)

      if (dbError) throw dbError

      const freshDetails = await fetchJobDetails(jobId)
      setJobDetails(prev => ({ ...prev, [jobId]: freshDetails }))
      
    } catch (err) {
      console.error('Replace error:', err)
      alert('Failed to replace document: ' + err.message)
    }
    
    setReplacing(null)
  }

  const handleViewDocument = async (filePath) => {
    if (!filePath) return
    
    setViewingDoc(filePath)
    try {
      const signedUrl = await getDocumentUrl(filePath)
      window.open(signedUrl, '_blank')
    } catch (err) {
      console.error('Error getting document URL:', err)
      alert('Failed to open document: ' + err.message)
    }
    setViewingDoc(null)
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

      const freshDetails = await fetchJobDetails(jobId)
      setJobDetails(prev => ({ ...prev, [jobId]: freshDetails }))
      
    } catch (err) {
      console.error('Approve error:', err)
      alert('Failed to approve document')
    }
    
    setApproving(null)
  }

  const handleApproveJob = async (jobId, currentStatus) => {
    setApproving(jobId)
    
    try {
      // Determine next status based on current status
      let nextStatus = 'ready'
      if (currentStatus === 'pending_post_manufacturing') {
        nextStatus = 'ready_for_assembly'
      }

      const { error } = await supabase
        .from('jobs')
        .update({ 
          status: nextStatus,
          updated_at: new Date().toISOString()
        })
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

  const handleRecallJob = async (jobId) => {
    if (!confirm('Recall this job to Pending Compliance? All document approvals will be preserved.')) return
    
    setRecalling(jobId)
    
    try {
      const { error } = await supabase
        .from('jobs')
        .update({ 
          status: 'pending_compliance',
          updated_at: new Date().toISOString()
        })
        .eq('id', jobId)

      if (error) throw error
      onUpdate()
      
    } catch (err) {
      console.error('Recall job error:', err)
      alert('Failed to recall job: ' + err.message)
    }
    
    setRecalling(null)
  }

  // Get ALL documents for a given type
  const getDocumentsForType = (jobId, docTypeId) => {
    const details = jobDetails[jobId]
    if (!details) return []
    return details.jobDocs.filter(d => d.document_type_id === docTypeId)
  }

  // Check if requirement has at least one approved document
  const hasApprovedDocument = (jobId, docTypeId) => {
    const docs = getDocumentsForType(jobId, docTypeId)
    return docs.some(d => d.status === 'approved')
  }

  const canApproveJob = (jobId, requiredStage) => {
    const details = jobDetails[jobId]
    if (!details) return false
    if (details.noComponent) return true
    
    const stageReqs = details.requirements.filter(r => 
      r.required_at === requiredStage || (!r.required_at && requiredStage === 'compliance_review')
    )
    
    if (stageReqs.length === 0) return true

    for (const req of stageReqs) {
      if (!req.is_required) continue
      if (!hasApprovedDocument(jobId, req.document_type_id)) return false
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
    if (status === 'approved') return 'bg-green-900/20 border-green-800'
    if (status === 'pending') return 'bg-yellow-900/20 border-yellow-800'
    return 'bg-gray-700 border-gray-600'
  }

  const getStageLabel = (stage) => {
    if (stage === 'manufacturing_complete') return 'After Manufacturing'
    if (stage === 'tco') return 'Before TCO'
    return 'Compliance Review'
  }

  const getStatusBadge = (status) => {
    const statusConfig = {
      'ready': { label: 'Ready', color: 'bg-green-600' },
      'assigned': { label: 'Assigned', color: 'bg-blue-600' },
      'in_progress': { label: 'In Progress', color: 'bg-blue-500' },
      'manufacturing_complete': { label: 'Mfg Complete', color: 'bg-purple-600' },
      'pending_post_manufacturing': { label: 'Post-Mfg Review', color: 'bg-purple-500' },
      'ready_for_assembly': { label: 'Ready for Assembly', color: 'bg-green-500' },
      'complete': { label: 'Complete', color: 'bg-gray-600' }
    }
    const config = statusConfig[status] || { label: status, color: 'bg-gray-600' }
    return (
      <span className={`text-xs px-2 py-0.5 rounded ${config.color} text-white`}>
        {config.label}
      </span>
    )
  }

  const formatDate = (dateStr) => {
    if (!dateStr) return '-'
    return new Date(dateStr).toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric',
      year: 'numeric'
    })
  }

  const ViewButton = ({ filePath }) => {
    if (!filePath) return null
    const isLoading = viewingDoc === filePath
    
    return (
      <button
        onClick={() => handleViewDocument(filePath)}
        disabled={isLoading}
        className="flex items-center gap-1 px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded disabled:opacity-50"
      >
        {isLoading ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />}
        View
      </button>
    )
  }

  // Render a pending review section (shared for machining and post-mfg)
  const renderPendingSection = (sectionJobs, title, borderColor, requiredStage, showPhaseLabel = false) => {
    if (sectionJobs.length === 0) return null

    return (
      <div className={`bg-gray-900 rounded-lg border ${borderColor} p-4`}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-purple-400 font-semibold flex items-center gap-2">
            <Clock size={18} />
            {title} ({sectionJobs.length})
          </h3>
        </div>
        
        <div className="space-y-2">
          {sectionJobs.map(job => {
            const isExpanded = expandedJob === job.id
            const details = jobDetails[job.id]
            const jobCanApprove = details ? canApproveJob(job.id, requiredStage) : false
            const borderClass = getPriorityBorder(job.priority)
            const dotClass = getPriorityColor(job.priority)

            const stageReqs = details?.requirements?.filter(r => 
              r.required_at === requiredStage || (!r.required_at && requiredStage === 'compliance_review')
            ) || []
            const futureReqs = details?.requirements?.filter(r => 
              r.required_at !== requiredStage && (r.required_at || requiredStage !== 'compliance_review')
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
                    <button
                      onClick={(e) => { e.stopPropagation(); handleCancelJob(job.id); }}
                      className="flex items-center gap-1 px-3 py-1 text-sm bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
                    >
                      <X size={14} />
                      Cancel
                    </button>
                  )}
                </div>

                {isExpanded && (
                  <div className="border-t border-gray-700 p-4">
                    <h4 className="text-gray-400 text-sm font-medium mb-3">Required Documents</h4>
                    
                    {!details && (
                      <div className="text-gray-500 text-sm flex items-center gap-2">
                        <Loader2 size={16} className="animate-spin" />
                        Loading documents...
                      </div>
                    )}

                    {details && details.noComponent && (
                      <div className="text-yellow-500 text-sm bg-yellow-900/20 p-3 rounded">
                        This job has no component linked.
                      </div>
                    )}
                    
                    {details && !details.noComponent && stageReqs.length === 0 && (
                      <div className="text-green-500 text-sm bg-green-900/20 p-3 rounded">
                        No documents required at this stage.
                      </div>
                    )}
                    
                    {details && !details.noComponent && stageReqs.length > 0 && (
                      <div className="space-y-4">
                        {stageReqs.map(req => {
                          const docsForType = getDocumentsForType(job.id, req.document_type_id)
                          const hasAnyDocs = docsForType.length > 0
                          const uploadKey = job.id + '-' + req.document_type_id
                          const isUploading = uploading === uploadKey

                          return (
                            <div key={req.id} className="space-y-2">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <span className="text-white text-sm font-medium">{req.document_type.name}</span>
                                  {req.is_required && <span className="text-xs text-red-400">Required</span>}
                                  {hasApprovedDocument(job.id, req.document_type_id) && (
                                    <CheckCircle size={14} className="text-green-500" />
                                  )}
                                </div>
                                
                                <label className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded cursor-pointer">
                                  {isUploading ? (
                                    <Loader2 size={12} className="animate-spin" />
                                  ) : hasAnyDocs ? (
                                    <Plus size={12} />
                                  ) : (
                                    <Upload size={12} />
                                  )}
                                  {isUploading ? 'Uploading...' : hasAnyDocs ? 'Add More' : 'Upload'}
                                  <input
                                    type="file"
                                    className="hidden"
                                    onChange={(e) => {
                                      const selectedFile = e.target.files[0]
                                      if (selectedFile) {
                                        handleFileUpload(job.id, req.document_type_id, req.document_type.code, selectedFile)
                                      }
                                      e.target.value = ''
                                    }}
                                    disabled={isUploading}
                                  />
                                </label>
                              </div>

                              {!hasAnyDocs && (
                                <div className="flex items-center gap-2 p-3 rounded border border-gray-600 bg-gray-700">
                                  <AlertCircle size={16} className="text-gray-500" />
                                  <span className="text-gray-400 text-sm">No document uploaded</span>
                                </div>
                              )}

                              {docsForType.map((doc, index) => {
                                const isDocApproved = doc.status === 'approved'
                                const bgClass = getDocBgClass(doc.status)
                                const isReplacing = replacing === doc.id

                                return (
                                  <div key={doc.id} className={"flex items-center justify-between p-3 rounded border " + bgClass}>
                                    <div className="flex items-center gap-3">
                                      {isDocApproved && <CheckCircle size={18} className="text-green-500" />}
                                      {doc.status === 'pending' && <Clock size={18} className="text-yellow-500" />}
                                      
                                      <div>
                                        <div className="text-xs text-gray-500">{doc.file_name}</div>
                                        {docsForType.length > 1 && (
                                          <div className="text-xs text-gray-600">Document {index + 1}</div>
                                        )}
                                      </div>
                                    </div>

                                    <div className="flex items-center gap-2">
                                      <ViewButton filePath={doc.file_url} />

                                      {isComplianceUser && (
                                        <label className="flex items-center gap-1 px-2 py-1 text-xs bg-orange-600 hover:bg-orange-500 text-white rounded cursor-pointer">
                                          {isReplacing ? (
                                            <Loader2 size={12} className="animate-spin" />
                                          ) : (
                                            <RefreshCw size={12} />
                                          )}
                                          {isReplacing ? '...' : 'Replace'}
                                          <input
                                            type="file"
                                            className="hidden"
                                            onChange={(e) => {
                                              const selectedFile = e.target.files[0]
                                              if (selectedFile) {
                                                handleReplaceDocument(doc.id, job.id, req.document_type_id, selectedFile)
                                              }
                                              e.target.value = ''
                                            }}
                                            disabled={isReplacing}
                                          />
                                        </label>
                                      )}

                                      {doc.status === 'pending' && (
                                        <button
                                          onClick={() => handleApproveDocument(doc.id, job.id)}
                                          disabled={approving === doc.id}
                                          className="flex items-center gap-1 px-2 py-1 text-xs bg-green-600 hover:bg-green-500 text-white rounded"
                                        >
                                          {approving === doc.id ? (
                                            <Loader2 size={12} className="animate-spin" />
                                          ) : (
                                            <Check size={12} />
                                          )}
                                          {approving === doc.id ? '...' : 'Approve'}
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                )
                              })}
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
                            const docsForType = getDocumentsForType(job.id, req.document_type_id)
                            const hasDoc = docsForType.length > 0

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
                                    {hasDoc && <div className="text-xs text-green-500">Already uploaded ({docsForType.length})</div>}
                                  </div>
                                </div>
                                {hasDoc && <ViewButton filePath={docsForType[0].file_url} />}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {/* Footer */}
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
                          onClick={() => handleApproveJob(job.id, job.status)}
                          disabled={!jobCanApprove || approving === job.id}
                          className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {approving === job.id ? (
                            <Loader2 size={16} className="animate-spin" />
                          ) : (
                            <CheckCircle size={16} />
                          )}
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

  // If no compliance-related jobs at all, don't render anything
  const hasAnyContent = pendingMachiningJobs.length > 0 || 
                        pendingPostMfgJobs.length > 0 || 
                        approvedUnassignedJobs.length > 0 ||
                        recentlyApprovedJobs.length > 0

  if (!hasAnyContent) return null

  return (
    <div className="space-y-4">
      {/* Pending Review - Machining */}
      {renderPendingSection(
        pendingMachiningJobs, 
        'Pending Review - Machining', 
        'border-purple-800',
        'compliance_review'
      )}

      {/* Pending Review - Post-Manufacturing */}
      {renderPendingSection(
        pendingPostMfgJobs, 
        'Pending Review - Post-Manufacturing', 
        'border-indigo-800',
        'manufacturing_complete'
      )}

      {/* Approved, Unassigned */}
      {approvedUnassignedJobs.length > 0 && (
        <div className="bg-gray-900 rounded-lg border border-green-800 p-4">
          <h3 className="text-green-400 font-semibold mb-3 flex items-center gap-2">
            <CheckCircle size={18} />
            Approved, Unassigned ({approvedUnassignedJobs.length})
          </h3>
          <div className="space-y-2">
            {approvedUnassignedJobs.map(job => (
              <div 
                key={job.id} 
                className={`flex items-center justify-between bg-gray-800 rounded p-3 border-l-4 ${getPriorityBorder(job.priority)}`}
              >
                <div className="flex items-center gap-4">
                  <div className={`w-3 h-3 rounded-full ${getPriorityColor(job.priority)}`}></div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-white font-mono">{job.job_number}</span>
                      <span className="text-gray-500">•</span>
                      <span className="text-gray-400">{job.work_order?.wo_number}</span>
                    </div>
                    <div className="text-sm text-gray-500">
                      <span className="text-skynet-accent">{job.component?.part_number}</span>
                      <span className="mx-2">•</span>
                      <span>Qty: {job.quantity}</span>
                    </div>
                  </div>
                </div>
                {isComplianceUser && (
                  <button
                    onClick={() => handleRecallJob(job.id)}
                    disabled={recalling === job.id}
                    className="flex items-center gap-1 px-3 py-1 text-sm bg-orange-600 hover:bg-orange-500 text-white rounded transition-colors disabled:opacity-50"
                  >
                    {recalling === job.id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Undo2 size={14} />
                    )}
                    {recalling === job.id ? 'Recalling...' : 'Recall'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recently Approved (Last 5 Days) */}
      {recentlyApprovedJobs.length > 0 && (
        <div className="bg-gray-900 rounded-lg border border-gray-700 p-4">
          <button
            onClick={() => setShowRecentlyApproved(!showRecentlyApproved)}
            className="w-full flex items-center justify-between text-left"
          >
            <h3 className="text-gray-400 font-semibold flex items-center gap-2">
              <FileText size={18} />
              Recently Approved - Last 5 Days ({recentlyApprovedJobs.length})
            </h3>
            <ChevronDown 
              size={20} 
              className={`text-gray-500 transition-transform ${showRecentlyApproved ? 'rotate-0' : '-rotate-90'}`}
            />
          </button>
          
          {showRecentlyApproved && (
            <div className="mt-4">
              <div className="grid grid-cols-6 gap-2 text-xs text-gray-500 font-medium mb-2 px-3">
                <span>WO #</span>
                <span>Job #</span>
                <span>Part #</span>
                <span>Created</span>
                <span>Approved</span>
                <span>Status</span>
              </div>
              <div className="space-y-1">
                {recentlyApprovedJobs.map(job => (
                  <div 
                    key={job.id} 
                    className="grid grid-cols-6 gap-2 text-sm bg-gray-800 rounded p-3 items-center"
                  >
                    <span className="text-gray-300">{job.work_order?.wo_number}</span>
                    <span className="text-white font-mono">{job.job_number}</span>
                    <span className="text-skynet-accent">{job.component?.part_number}</span>
                    <span className="text-gray-400">{formatDate(job.created_at)}</span>
                    <span className="text-gray-400">{formatDate(job.updated_at)}</span>
                    <span>{getStatusBadge(job.status)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}