import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { uploadDocument, getDocumentUrl } from '../lib/s3'
import PrintPackageModal from './PrintPackageModal'
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
  Undo2,
  Beaker,
  ArrowUp,
  ArrowDown,
  Printer
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
  const [approvingRouting, setApprovingRouting] = useState(null)
  const [routingReviewed, setRoutingReviewed] = useState({})
  const [addingStepForJob, setAddingStepForJob] = useState(null)
  const [newStepName, setNewStepName] = useState('')
  const [newStepType, setNewStepType] = useState('internal')
  const [newStepStation, setNewStepStation] = useState('')
  const [printPackageJob, setPrintPackageJob] = useState(null)

  const handleApproveRoutingRemoval = async (stepId, jobId) => {
    setApprovingRouting(stepId)
    try {
      const { error } = await supabase
        .from('job_routing_steps')
        .update({
          status: 'removed',
          removal_approved_by: profile.id,
          removal_approved_at: new Date().toISOString()
        })
        .eq('id', stepId)
      if (error) throw error
      const freshDetails = await fetchJobDetails(jobId)
      setJobDetails(prev => ({ ...prev, [jobId]: freshDetails }))
    } catch (err) {
      console.error('Error approving routing removal:', err)
      alert('Failed to approve routing change')
    }
    setApprovingRouting(null)
  }

  const handleRejectRoutingRemoval = async (stepId, jobId) => {
    setApprovingRouting(stepId)
    try {
      const { error } = await supabase
        .from('job_routing_steps')
        .update({
          status: 'pending',
          removal_reason: null,
          removal_requested_by: null,
          removal_requested_at: null
        })
        .eq('id', stepId)
      if (error) throw error
      const freshDetails = await fetchJobDetails(jobId)
      setJobDetails(prev => ({ ...prev, [jobId]: freshDetails }))
    } catch (err) {
      console.error('Error rejecting routing removal:', err)
      alert('Failed to reject routing change')
    }
    setApprovingRouting(null)
  }

  const handleRestoreRoutingStep = async (stepId, jobId) => {
    setApprovingRouting(stepId)
    try {
      const { error } = await supabase
        .from('job_routing_steps')
        .update({
          status: 'pending',
          removal_reason: null,
          removal_requested_by: null,
          removal_requested_at: null,
          removal_approved_by: null,
          removal_approved_at: null
        })
        .eq('id', stepId)
      if (error) throw error
      const freshDetails = await fetchJobDetails(jobId)
      setJobDetails(prev => ({ ...prev, [jobId]: freshDetails }))
    } catch (err) {
      console.error('Error restoring routing step:', err)
      alert('Failed to restore routing step')
    }
    setApprovingRouting(null)
  }

  const handleDirectRemoveStep = async (stepId, jobId) => {
    setApprovingRouting(stepId)
    try {
      const { error } = await supabase
        .from('job_routing_steps')
        .update({
          status: 'removed',
          removal_approved_by: profile.id,
          removal_approved_at: new Date().toISOString()
        })
        .eq('id', stepId)
      if (error) throw error
      const freshDetails = await fetchJobDetails(jobId)
      setJobDetails(prev => ({ ...prev, [jobId]: freshDetails }))
    } catch (err) {
      console.error('Error removing routing step:', err)
      alert('Failed to remove routing step')
    }
    setApprovingRouting(null)
  }

  const handleAddStepToJob = async (jobId) => {
    if (!newStepName.trim()) return
    setApprovingRouting('adding')
    try {
      const steps = jobDetails[jobId]?.routingSteps || []
      const maxOrder = steps.length > 0 ? Math.max(...steps.map(s => s.step_order)) : 0

      const { error } = await supabase
        .from('job_routing_steps')
        .insert({
          job_id: jobId,
          step_name: newStepName.trim(),
          step_type: newStepType,
          station: newStepStation.trim() || null,
          step_order: maxOrder + 1,
          status: 'pending',
          is_added_step: true,
          added_by: profile.id,
          added_at: new Date().toISOString()
        })
      if (error) throw error

      // Renumber all steps for this job
      const { data: updatedSteps } = await supabase
        .from('job_routing_steps')
        .select('id')
        .eq('job_id', jobId)
        .order('step_order')

      if (updatedSteps) {
        await Promise.all(updatedSteps.map((s, i) =>
          supabase.from('job_routing_steps').update({ step_order: i + 1 }).eq('id', s.id)
        ))
      }

      setAddingStepForJob(null)
      setNewStepName('')
      setNewStepType('internal')
      setNewStepStation('')
      const freshDetails = await fetchJobDetails(jobId)
      setJobDetails(prev => ({ ...prev, [jobId]: freshDetails }))
    } catch (err) {
      console.error('Error adding routing step:', err)
      alert('Failed to add routing step')
    }
    setApprovingRouting(null)
  }

  const handleReorderStep = async (stepId, direction, jobId) => {
    const steps = jobDetails[jobId]?.routingSteps || []
    const idx = steps.findIndex(s => s.id === stepId)
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= steps.length) return

    setApprovingRouting(stepId)
    try {
      const currentStep = steps[idx]
      const targetStep = steps[targetIdx]

      const { error: err1 } = await supabase
        .from('job_routing_steps')
        .update({ step_order: targetStep.step_order })
        .eq('id', currentStep.id)
      if (err1) throw err1

      const { error: err2 } = await supabase
        .from('job_routing_steps')
        .update({ step_order: currentStep.step_order })
        .eq('id', targetStep.id)
      if (err2) throw err2

      const freshDetails = await fetchJobDetails(jobId)
      setJobDetails(prev => ({ ...prev, [jobId]: freshDetails }))
    } catch (err) {
      console.error('Error reordering routing step:', err)
      alert('Failed to reorder routing step')
    }
    setApprovingRouting(null)
  }

  const handleResetRoutingToDefault = async (jobId) => {
    if (!confirm('Reset routing to master data defaults? This will discard all changes made by Customer Service.')) return

    const job = jobs.find(j => j.id === jobId)
    if (!job?.component?.id) return

    setApprovingRouting('resetting')
    try {
      // Delete all existing job_routing_steps for this job
      const { error: deleteError } = await supabase
        .from('job_routing_steps')
        .delete()
        .eq('job_id', jobId)
      if (deleteError) throw deleteError

      // Fetch master routing from part_routing_steps
      const { data: partRouting } = await supabase
        .from('part_routing_steps')
        .select('*')
        .eq('part_id', job.component.id)
        .eq('is_active', true)
        .order('step_order')

      // Insert fresh copies
      if (partRouting?.length > 0) {
        const jobSteps = partRouting.map(step => ({
          job_id: jobId,
          step_order: step.step_order,
          step_name: step.step_name,
          step_type: step.step_type,
          station: step.default_station,
          status: 'pending'
        }))
        const { error: insertError } = await supabase
          .from('job_routing_steps')
          .insert(jobSteps)
        if (insertError) throw insertError
      }

      // Uncheck routing reviewed
      setRoutingReviewed(prev => ({ ...prev, [jobId]: false }))

      const freshDetails = await fetchJobDetails(jobId)
      setJobDetails(prev => ({ ...prev, [jobId]: freshDetails }))
    } catch (err) {
      console.error('Error resetting routing:', err)
      alert('Failed to reset routing to defaults')
    }
    setApprovingRouting(null)
  }

  // Check if user has compliance permissions
  const isComplianceUser = profile?.role === 'compliance' || profile?.role === 'admin' || profile?.can_approve_compliance === true

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
        routingSteps: [],
        noComponent: true
      }
    }

    let { data: requirements } = await supabase
      .from('part_document_requirements')
      .select('*, document_type:document_types(*)')
      .eq('part_id', job.component.id)

    // A3: Filter out passivation doc requirements if component doesn't require passivation
    if (!job.component?.requires_passivation && requirements) {
      requirements = requirements.filter(r => {
        const code = (r.document_type?.code || '').toLowerCase()
        const name = (r.document_type?.name || '').toLowerCase()
        return !code.includes('passivation') && !name.includes('passivation')
      })
    }

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

    const { data: routingSteps } = await supabase
      .from('job_routing_steps')
      .select('*')
      .eq('job_id', jobId)
      .order('step_order')

    return {
      requirements: requirements || [],
      partDocs: partDocs || [],
      jobDocs: jobDocs || [],
      routingSteps: routingSteps || []
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
        // Check if this job's part is a finished good — skip assembly, go to TCO
        const job = jobs.find(j => j.id === jobId)
        const partType = job?.component?.part_type
        if (partType === 'finished_good') {
          nextStatus = 'pending_tco'
        } else {
          nextStatus = 'ready_for_assembly'
        }
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

  const handleApproveAndPrint = async (job) => {
    setApproving(job.id)

    try {
      let nextStatus = 'ready'
      if (job.status === 'pending_post_manufacturing') {
        const partType = job.component?.part_type
        if (partType === 'finished_good') {
          nextStatus = 'pending_tco'
        } else {
          nextStatus = 'ready_for_assembly'
        }
      }

      const { error } = await supabase
        .from('jobs')
        .update({
          status: nextStatus,
          updated_at: new Date().toISOString()
        })
        .eq('id', job.id)

      if (error) throw error
      onUpdate()
      // Open print package modal after successful approval
      setPrintPackageJob(job)

    } catch (err) {
      console.error('Approve job error:', err)
      alert('Failed to approve job')
    }

    setApproving(null)
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
                        <span>Qty: {job.quantity}
                          {job.work_order?.order_type === 'make_to_order' && job.work_order?.order_quantity && job.work_order?.stock_quantity
                            ? ` (${job.work_order.order_quantity} order + ${job.work_order.stock_quantity} stock)`
                            : job.work_order?.order_type === 'make_to_stock'
                              ? ' (stock)'
                              : ''
                          }
                        </span>
                        {job.work_order?.customer && (
                          <span className="mx-2">• {job.work_order.customer}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  
                </div>

                {isExpanded && (() => {
                  const allSteps = details?.routingSteps || []
                  const hasRouting = allSteps.length > 0
                  const hasPendingRemovals = allSteps.some(s => s.status === 'removal_pending')
                  const isRoutingChecked = !!routingReviewed[job.id]
                  const canApproveFull = jobCanApprove && (!hasRouting || isRoutingChecked) && !hasPendingRemovals
                  const canEditRouting = isComplianceUser && job.status === 'pending_compliance'

                  return (
                  <div className="border-t border-gray-700 p-4">
                    {/* Full Routing Display */}
                    {hasRouting && (
                      <div className="mb-4 pb-4 border-b border-gray-700">
                        <h4 className="text-gray-400 text-sm font-medium mb-2 flex items-center gap-2">
                          Routing
                          {hasPendingRemovals && (
                            <span className="text-xs px-1.5 py-0.5 bg-amber-900/50 text-amber-400 rounded">Action Required</span>
                          )}
                          {canEditRouting && (
                            <button
                              onClick={() => handleResetRoutingToDefault(job.id)}
                              disabled={approvingRouting === 'resetting'}
                              className="flex items-center gap-1 ml-auto text-xs text-gray-500 hover:text-orange-400 disabled:opacity-50"
                            >
                              {approvingRouting === 'resetting' ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Undo2 size={12} />
                              )}
                              Reset to Default
                            </button>
                          )}
                        </h4>
                        <div className="space-y-1">
                          {allSteps.map((step, stepIndex) => {
                            const isRemovalPending = step.status === 'removal_pending'
                            const isRemoved = step.status === 'removed'
                            const isAdded = step.is_added_step

                            return (
                              <div key={step.id}>
                                <div className={`flex items-center gap-2 text-sm py-1 px-2 rounded ${
                                  isRemovalPending ? 'bg-amber-900/10 border border-amber-800/50' :
                                  isRemoved ? 'bg-gray-800/50' : ''
                                }`}>
                                  <span className="text-gray-600 w-6 text-right">{step.step_order}.</span>
                                  <span className={
                                    isRemovalPending ? 'text-red-400 line-through' :
                                    isRemoved ? 'text-gray-600 line-through' :
                                    'text-gray-300'
                                  }>{step.step_name}</span>
                                  {step.station && (
                                    <span className="text-gray-600">({step.station})</span>
                                  )}
                                  {step.step_type === 'external' && (
                                    <span className="text-xs px-1 bg-orange-900/30 text-orange-400 rounded">External</span>
                                  )}
                                  {isAdded && (
                                    <span className="text-xs px-1 bg-green-900/30 text-green-400 rounded">Added</span>
                                  )}
                                  {isRemoved && (
                                    <>
                                      <span className="text-xs px-1 bg-gray-700 text-gray-500 rounded">Removed</span>
                                      {isComplianceUser && job.status === 'pending_compliance' && (
                                        <button
                                          onClick={() => handleRestoreRoutingStep(step.id, job.id)}
                                          disabled={approvingRouting === step.id}
                                          className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-gray-400 hover:text-white border border-gray-600 hover:border-gray-500 rounded disabled:opacity-50"
                                        >
                                          {approvingRouting === step.id ? (
                                            <Loader2 size={10} className="animate-spin" />
                                          ) : (
                                            <Undo2 size={10} />
                                          )}
                                          Restore
                                        </button>
                                      )}
                                    </>
                                  )}
                                  {canEditRouting && !isRemoved && !isRemovalPending && (
                                    <div className="flex items-center gap-1 ml-auto">
                                      {stepIndex > 0 && (
                                        <button
                                          onClick={() => handleReorderStep(step.id, 'up', job.id)}
                                          disabled={approvingRouting === step.id}
                                          className="p-0.5 text-gray-500 hover:text-white rounded disabled:opacity-50"
                                          title="Move up"
                                        >
                                          <ArrowUp size={12} />
                                        </button>
                                      )}
                                      {stepIndex < allSteps.length - 1 && (
                                        <button
                                          onClick={() => handleReorderStep(step.id, 'down', job.id)}
                                          disabled={approvingRouting === step.id}
                                          className="p-0.5 text-gray-500 hover:text-white rounded disabled:opacity-50"
                                          title="Move down"
                                        >
                                          <ArrowDown size={12} />
                                        </button>
                                      )}
                                      <button
                                        onClick={() => handleDirectRemoveStep(step.id, job.id)}
                                        disabled={approvingRouting === step.id}
                                        className="p-0.5 text-gray-500 hover:text-red-400 rounded disabled:opacity-50 ml-1"
                                        title="Remove step"
                                      >
                                        <X size={12} />
                                      </button>
                                    </div>
                                  )}
                                  {isRemovalPending && isComplianceUser && (
                                    <div className="flex items-center gap-1 ml-auto">
                                      {canEditRouting && (
                                        <>
                                          {stepIndex > 0 && (
                                            <button
                                              onClick={() => handleReorderStep(step.id, 'up', job.id)}
                                              disabled={approvingRouting === step.id}
                                              className="p-0.5 text-gray-500 hover:text-white rounded disabled:opacity-50"
                                              title="Move up"
                                            >
                                              <ArrowUp size={12} />
                                            </button>
                                          )}
                                          {stepIndex < allSteps.length - 1 && (
                                            <button
                                              onClick={() => handleReorderStep(step.id, 'down', job.id)}
                                              disabled={approvingRouting === step.id}
                                              className="p-0.5 text-gray-500 hover:text-white rounded disabled:opacity-50"
                                              title="Move down"
                                            >
                                              <ArrowDown size={12} />
                                            </button>
                                          )}
                                          <button
                                            onClick={() => handleDirectRemoveStep(step.id, job.id)}
                                            disabled={approvingRouting === step.id}
                                            className="p-0.5 text-gray-500 hover:text-red-400 rounded disabled:opacity-50 ml-1"
                                            title="Remove step"
                                          >
                                            <X size={12} />
                                          </button>
                                          <span className="w-px h-4 bg-gray-600 mx-1" />
                                        </>
                                      )}
                                      <button
                                        onClick={() => handleRejectRoutingRemoval(step.id, job.id)}
                                        disabled={approvingRouting === step.id}
                                        className="flex items-center gap-1 px-2 py-0.5 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded disabled:opacity-50"
                                      >
                                        <X size={10} />
                                        Reject
                                      </button>
                                      <button
                                        onClick={() => handleApproveRoutingRemoval(step.id, job.id)}
                                        disabled={approvingRouting === step.id}
                                        className="flex items-center gap-1 px-2 py-0.5 text-xs bg-green-600 hover:bg-green-500 text-white rounded disabled:opacity-50"
                                      >
                                        {approvingRouting === step.id ? (
                                          <Loader2 size={10} className="animate-spin" />
                                        ) : (
                                          <Check size={10} />
                                        )}
                                        Approve
                                      </button>
                                    </div>
                                  )}
                                </div>
                                {isRemovalPending && (
                                  <div className="text-xs text-amber-400/80 ml-8 mb-1">
                                    Removal requested &mdash; {step.removal_reason}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                        {/* Add Step */}
                        {canEditRouting && (
                          <div className="mt-2">
                            {addingStepForJob === job.id ? (
                              <div className="flex items-center gap-2 text-sm py-1.5 px-2 bg-gray-800 rounded border border-gray-600">
                                <input
                                  type="text"
                                  placeholder="Step name"
                                  value={newStepName}
                                  onChange={(e) => setNewStepName(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleAddStepToJob(job.id)
                                    if (e.key === 'Escape') { setAddingStepForJob(null); setNewStepName(''); setNewStepType('internal'); setNewStepStation('') }
                                  }}
                                  className="bg-gray-700 text-white text-xs px-2 py-1 rounded border border-gray-600 w-40"
                                  autoFocus
                                />
                                <select
                                  value={newStepType}
                                  onChange={(e) => setNewStepType(e.target.value)}
                                  className="bg-gray-700 text-white text-xs px-2 py-1 rounded border border-gray-600"
                                >
                                  <option value="internal">Internal</option>
                                  <option value="external">External</option>
                                </select>
                                <input
                                  type="text"
                                  placeholder="Station (optional)"
                                  value={newStepStation}
                                  onChange={(e) => setNewStepStation(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleAddStepToJob(job.id)
                                    if (e.key === 'Escape') { setAddingStepForJob(null); setNewStepName(''); setNewStepType('internal'); setNewStepStation('') }
                                  }}
                                  className="bg-gray-700 text-white text-xs px-2 py-1 rounded border border-gray-600 w-32"
                                />
                                <button
                                  onClick={() => handleAddStepToJob(job.id)}
                                  disabled={!newStepName.trim() || approvingRouting === 'adding'}
                                  className="flex items-center gap-1 px-2 py-1 text-xs bg-green-600 hover:bg-green-500 text-white rounded disabled:opacity-50"
                                >
                                  {approvingRouting === 'adding' ? (
                                    <Loader2 size={10} className="animate-spin" />
                                  ) : (
                                    <Plus size={10} />
                                  )}
                                  Add
                                </button>
                                <button
                                  onClick={() => { setAddingStepForJob(null); setNewStepName(''); setNewStepType('internal'); setNewStepStation('') }}
                                  className="px-2 py-1 text-xs text-gray-400 hover:text-white"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setAddingStepForJob(job.id)}
                                className="flex items-center gap-1 text-xs text-gray-500 hover:text-green-400 px-2 py-1"
                              >
                                <Plus size={12} />
                                Add Step
                              </button>
                            )}
                          </div>
                        )}
                        {/* Routing reviewed checkbox */}
                        {isComplianceUser && (
                          <label className="flex items-center gap-2 mt-3 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={isRoutingChecked}
                              onChange={(e) => setRoutingReviewed(prev => ({ ...prev, [job.id]: e.target.checked }))}
                              className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-green-500 focus:ring-green-500 focus:ring-offset-0"
                            />
                            <span className="text-sm text-gray-400">Routing reviewed and approved</span>
                          </label>
                        )}
                      </div>
                    )}

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

                    {/* Show passivation info if applicable */}
                    {job.passivation_end && (
                      <div className="mt-2 text-xs text-cyan-400 flex items-center gap-1">
                        <Beaker size={12} />
                        Passivated: {new Date(job.passivation_end).toLocaleString()}
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
                    <div className="mt-4 pt-4 border-t border-gray-700">
                      <div className="space-y-2 mb-3">
                        {jobCanApprove ? (
                          <span className="text-green-400 text-sm flex items-center gap-1">
                            <CheckCircle size={14} />
                            All required documents approved
                          </span>
                        ) : (
                          <span className="text-yellow-400 text-sm flex items-center gap-1">
                            <AlertCircle size={14} />
                            Missing or pending documents
                          </span>
                        )}
                        {hasRouting && !isRoutingChecked && (
                          <span className="text-yellow-400 text-sm flex items-center gap-1">
                            <AlertCircle size={14} />
                            Routing review required
                          </span>
                        )}
                        {hasPendingRemovals && (
                          <span className="text-amber-400 text-sm flex items-center gap-1">
                            <AlertCircle size={14} />
                            Unresolved routing removal requests
                          </span>
                        )}
                      </div>
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => handleApproveJob(job.id, job.status)}
                          disabled={!canApproveFull || approving === job.id}
                          className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {approving === job.id ? (
                            <Loader2 size={16} className="animate-spin" />
                          ) : (
                            <CheckCircle size={16} />
                          )}
                          {approving === job.id ? 'Approving...' : 'Approve Job'}
                        </button>
                        <button
                          onClick={() => handleApproveAndPrint(job)}
                          disabled={!canApproveFull || approving === job.id}
                          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {approving === job.id ? (
                            <Loader2 size={16} className="animate-spin" />
                          ) : (
                            <>
                              <CheckCircle size={16} />
                              <Printer size={16} />
                            </>
                          )}
                          {approving === job.id ? 'Approving...' : 'Approve & Print'}
                        </button>
                      </div>
                    </div>
                  </div>
                  )
                })()}
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
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-white font-mono">{job.job_number}</span>
                      <span className="text-gray-500">·</span>
                      <span className="text-gray-400">{job.work_order?.wo_number}</span>
                      <span className="text-gray-500">·</span>
                      {job.work_order?.order_type === 'make_to_order' && (
                        <span className="px-1.5 py-0.5 text-xs font-bold rounded bg-blue-900 text-blue-300">MTO</span>
                      )}
                      {job.work_order?.order_type === 'make_to_stock' && (
                        <span className="px-1.5 py-0.5 text-xs font-bold rounded bg-green-900 text-green-300">MTS</span>
                      )}
                      {job.work_order?.order_type === 'maintenance' && (
                        <span className="px-1.5 py-0.5 text-xs font-bold rounded bg-orange-900 text-orange-300">MAINT</span>
                      )}
                      <span className="text-gray-500">·</span>
                      <span className="text-skynet-accent">{job.component?.part_number}</span>
                    </div>
                    <div className="text-sm text-gray-500">
                      <span>Qty: {job.quantity}</span>
                      {job.work_order?.order_quantity && job.work_order?.stock_quantity ? (
                        <span className="text-gray-600"> ({job.work_order.order_quantity} order + {job.work_order.stock_quantity} stock)</span>
                      ) : job.work_order?.order_type === 'make_to_stock' ? (
                        <span className="text-gray-600"> (stock)</span>
                      ) : null}
                      {job.work_order?.order_type === 'make_to_order' && job.work_order?.customer && (
                        <>
                          <span className="mx-2">·</span>
                          <span className="text-gray-400">{job.work_order.customer}</span>
                        </>
                      )}
                      {job.work_order?.order_type === 'make_to_stock' && (
                        <>
                          <span className="mx-2">·</span>
                          <span className="text-gray-400">STOCK</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPrintPackageJob(job)}
                    className="flex items-center gap-1 px-3 py-1 text-sm bg-gray-600 hover:bg-gray-500 text-white rounded transition-colors"
                  >
                    <Printer size={14} />
                    Print
                  </button>
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
      {/* Print Package Modal */}
      <PrintPackageModal
        isOpen={!!printPackageJob}
        job={printPackageJob}
        onClose={() => setPrintPackageJob(null)}
      />
    </div>
  )
}