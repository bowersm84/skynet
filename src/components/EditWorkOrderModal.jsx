import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { X, Loader2, Plus, Trash2, ChevronDown, ChevronRight, Package, Wrench, AlertTriangle, ShoppingCart, Save } from 'lucide-react'

export default function EditWorkOrderModal({ isOpen, onClose, workOrder, onSuccess }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // WO-level fields
  const [customer, setCustomer] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [priority, setPriority] = useState('normal')

  // Existing assemblies with their jobs (editable quantities)
  const [existingAssemblies, setExistingAssemblies] = useState([])

  // New assemblies to add
  const [newAssemblies, setNewAssemblies] = useState([])
  const [showAddProduct, setShowAddProduct] = useState(false)

  // Available assemblies/FGs from master data
  const [availableParts, setAvailableParts] = useState([])
  const [loadingParts, setLoadingParts] = useState(false)

  useEffect(() => {
    if (isOpen && workOrder) {
      loadWorkOrder()
      fetchAvailableParts()
    }
  }, [isOpen, workOrder])

  const loadWorkOrder = () => {
    setCustomer(workOrder.customer || '')
    setDueDate(workOrder.due_date || '')
    setPriority(workOrder.priority || 'normal')
    setError('')
    setNewAssemblies([])
    setShowAddProduct(false)

    // Build existing assemblies with their jobs
    const assemblies = (workOrder.work_order_assemblies || []).map(woa => {
      const jobs = (workOrder.jobs || []).filter(j => j.work_order_assembly_id === woa.id)
      return {
        woaId: woa.id,
        assemblyId: woa.assembly?.id,
        partNumber: woa.assembly?.part_number || 'Unknown',
        description: woa.assembly?.description || '',
        quantity: woa.quantity,
        originalQuantity: woa.quantity,
        status: woa.status,
        jobs: jobs.map(j => ({
          id: j.id,
          jobNumber: j.job_number,
          componentPartNumber: j.component?.part_number || '',
          componentDescription: j.component?.description || '',
          quantity: j.quantity,
          originalQuantity: j.quantity,
          status: j.status,
          isEditable: ['pending_compliance', 'ready'].includes(j.status)
        })),
        expanded: true
      }
    })
    setExistingAssemblies(assemblies)
  }

  const fetchAvailableParts = async () => {
    setLoadingParts(true)
    const { data, error } = await supabase
      .from('parts')
      .select(`
        id,
        part_number,
        description,
        part_type,
        assembly_bom!assembly_bom_assembly_id_fkey(
          id,
          quantity,
          sort_order,
          component:parts!assembly_bom_component_id_fkey(
            id,
            part_number,
            description,
            part_type
          )
        )
      `)
      .in('part_type', ['assembly', 'finished_good'])
      .eq('is_active', true)
      .order('part_number')

    if (!error) setAvailableParts(data || [])
    setLoadingParts(false)
  }

  // Check if a part is already on this WO
  const isPartAlreadyOnWO = (partId) => {
    if (existingAssemblies.some(a => a.assemblyId === partId)) return true
    if (newAssemblies.some(a => a.assemblyId === partId)) return true
    return false
  }

  // Add new product
  const handleSelectNewProduct = (part) => {
    const isFG = part.part_type === 'finished_good'
    const jobs = isFG
      ? [{ componentId: part.id, partNumber: part.part_number, description: part.description, quantity: 1 }]
      : (part.assembly_bom || [])
          .filter(bom => bom.component?.part_type !== 'assembly' && bom.component?.part_type !== 'purchased')
          .map(bom => ({
            componentId: bom.component.id,
            partNumber: bom.component.part_number,
            description: bom.component.description,
            quantity: 1
          }))

    setNewAssemblies([...newAssemblies, {
      assemblyId: part.id,
      partNumber: part.part_number,
      description: part.description,
      partType: part.part_type,
      quantity: 1,
      jobs,
      expanded: true,
      bom: part.assembly_bom || []
    }])
    setShowAddProduct(false)
  }

  // Remove a new (not yet saved) product
  const removeNewAssembly = (index) => {
    setNewAssemblies(newAssemblies.filter((_, i) => i !== index))
  }

  // Toggle job selection on new assembly
  const toggleNewJob = (assemblyIdx, componentId, component) => {
    const updated = [...newAssemblies]
    const assembly = updated[assemblyIdx]
    const existingIdx = assembly.jobs.findIndex(j => j.componentId === componentId)
    if (existingIdx >= 0) {
      assembly.jobs = assembly.jobs.filter((_, i) => i !== existingIdx)
    } else {
      assembly.jobs.push({
        componentId,
        partNumber: component.part_number,
        description: component.description,
        quantity: assembly.quantity
      })
    }
    setNewAssemblies(updated)
  }

  // Check if any changes were made
  const hasChanges = () => {
    if (customer !== (workOrder.customer || '')) return true
    if (dueDate !== (workOrder.due_date || '')) return true
    if (priority !== (workOrder.priority || 'normal')) return true
    if (newAssemblies.length > 0) return true
    for (const a of existingAssemblies) {
      if (a.quantity !== a.originalQuantity) return true
      for (const j of a.jobs) {
        if (j.quantity !== j.originalQuantity) return true
      }
    }
    return false
  }

  const handleSave = async () => {
    setSaving(true)
    setError('')

    try {
      // 1. Update WO-level fields
      const woUpdates = {}
      if (customer !== workOrder.customer) woUpdates.customer = customer
      if (dueDate !== workOrder.due_date) woUpdates.due_date = dueDate || null
      if (priority !== workOrder.priority) woUpdates.priority = priority

      if (Object.keys(woUpdates).length > 0) {
        const { error: woErr } = await supabase
          .from('work_orders')
          .update(woUpdates)
          .eq('id', workOrder.id)
        if (woErr) throw woErr
      }

      // 2. Update existing assembly quantities
      for (const assembly of existingAssemblies) {
        if (assembly.quantity !== assembly.originalQuantity) {
          const { error: woaErr } = await supabase
            .from('work_order_assemblies')
            .update({ quantity: assembly.quantity })
            .eq('id', assembly.woaId)
          if (woaErr) throw woaErr
        }

        // Update job quantities
        for (const job of assembly.jobs) {
          if (job.quantity !== job.originalQuantity && job.isEditable) {
            const { error: jobErr } = await supabase
              .from('jobs')
              .update({ quantity: job.quantity })
              .eq('id', job.id)
            if (jobErr) throw jobErr
          }
        }
      }

      // 3. Create new assemblies + jobs
      if (newAssemblies.length > 0) {
        // Get next job number
        const { data: lastJob } = await supabase
          .from('jobs')
          .select('job_number')
          .order('job_number', { ascending: false })
          .limit(1)

        let nextJobNum = 1
        if (lastJob && lastJob.length > 0) {
          nextJobNum = parseInt(lastJob[0].job_number.replace('J-', '')) + 1
        }

        for (const assembly of newAssemblies) {
          // Create WOA record
          const { data: woaData, error: woaErr } = await supabase
            .from('work_order_assemblies')
            .insert({
              work_order_id: workOrder.id,
              assembly_id: assembly.assemblyId,
              quantity: assembly.quantity,
              status: 'pending'
            })
            .select('id')
            .single()

          if (woaErr) throw woaErr

          // Create jobs in pending_compliance
          for (const job of assembly.jobs) {
            const { error: jobErr } = await supabase
              .from('jobs')
              .insert({
                job_number: `J-${String(nextJobNum++).padStart(6, '0')}`,
                work_order_id: workOrder.id,
                work_order_assembly_id: woaData.id,
                component_id: job.componentId,
                quantity: job.quantity,
                status: 'pending_compliance',
                is_maintenance: false
              })
            if (jobErr) throw jobErr
          }
        }
      }

      onSuccess?.()
      onClose()
    } catch (err) {
      console.error('Error saving work order:', err)
      setError('Error saving changes: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  if (!isOpen || !workOrder) return null

  // Filter available parts for "Add Product" dropdown
  const addableParts = availableParts.filter(p => !isPartAlreadyOnWO(p.id))

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[70] p-4" onClick={onClose}>
      <div
        className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 flex-shrink-0">
          <div>
            <h2 className="text-xl font-semibold text-white">Edit Work Order</h2>
            <span className="text-sm text-gray-400 font-mono">{workOrder.wo_number}</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={24} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto flex-1">
          {error && (
            <div className="mb-4 p-3 bg-red-900/50 border border-red-700 rounded text-red-300 text-sm">
              {error}
            </div>
          )}

          {/* WO Details */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div>
              <label className="block text-gray-400 text-sm mb-1">Customer</label>
              <input
                type="text"
                value={customer}
                onChange={e => setCustomer(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded text-white focus:border-skynet-accent focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1">Due Date</label>
              <input
                type="date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded text-white focus:border-skynet-accent focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1">Priority</label>
              <select
                value={priority}
                onChange={e => setPriority(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded text-white focus:border-skynet-accent focus:outline-none"
              >
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-gray-700 pt-4 mb-4">
            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">Products on this Order</h3>
          </div>

          {/* Existing Assemblies */}
          {existingAssemblies.map((assembly, aIdx) => {
            const allEditable = assembly.jobs.every(j => j.isEditable)
            return (
              <div key={assembly.woaId} className="mb-4 border border-gray-700 rounded-lg overflow-hidden">
                {/* Assembly Header */}
                <div
                  className="px-4 py-3 bg-gray-800/50 flex items-center justify-between cursor-pointer"
                  onClick={() => {
                    const updated = [...existingAssemblies]
                    updated[aIdx].expanded = !updated[aIdx].expanded
                    setExistingAssemblies(updated)
                  }}
                >
                  <div className="flex items-center gap-3">
                    <ChevronRight
                      size={16}
                      className={`text-gray-500 transition-transform ${assembly.expanded ? 'rotate-90' : ''}`}
                    />
                    <Package size={16} className="text-skynet-accent" />
                    <div>
                      <span className="text-skynet-accent font-mono font-medium">{assembly.partNumber}</span>
                      <p className="text-xs text-gray-500">{assembly.description}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3" onClick={e => e.stopPropagation()}>
                    <label className="text-xs text-gray-500">Qty:</label>
                    <input
                      type="number"
                      min="1"
                      value={assembly.quantity}
                      onChange={e => {
                        const updated = [...existingAssemblies]
                        updated[aIdx].quantity = parseInt(e.target.value) || 1
                        setExistingAssemblies(updated)
                      }}
                      disabled={!allEditable}
                      className={`w-20 px-2 py-1 bg-gray-800 border rounded text-white text-sm text-center focus:border-skynet-accent focus:outline-none ${
                        allEditable ? 'border-gray-600' : 'border-gray-700 text-gray-500 cursor-not-allowed'
                      }`}
                    />
                    {!allEditable && (
                      <span className="text-xs text-gray-600" title="Some jobs already scheduled">🔒</span>
                    )}
                  </div>
                </div>

                {/* Jobs */}
                {assembly.expanded && (
                  <div className="border-t border-gray-700">
                    {assembly.jobs.length > 0 ? (
                      <div className="divide-y divide-gray-800">
                        {assembly.jobs.map((job, jIdx) => (
                          <div key={job.id} className="px-4 py-2 pl-10 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <Wrench size={12} className="text-gray-500" />
                              <div>
                                <span className="text-gray-300 text-sm font-mono">{job.jobNumber}</span>
                                <span className="text-gray-500 text-sm ml-2">{job.componentPartNumber}</span>
                                <p className="text-xs text-gray-600">{job.componentDescription}</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              <input
                                type="number"
                                min="1"
                                value={job.quantity}
                                onChange={e => {
                                  const updated = [...existingAssemblies]
                                  updated[aIdx].jobs[jIdx].quantity = parseInt(e.target.value) || 1
                                  setExistingAssemblies(updated)
                                }}
                                disabled={!job.isEditable}
                                className={`w-20 px-2 py-1 bg-gray-800 border rounded text-white text-sm text-center focus:border-skynet-accent focus:outline-none ${
                                  job.isEditable ? 'border-gray-600' : 'border-gray-700 text-gray-500 cursor-not-allowed'
                                }`}
                              />
                              <span className={`text-xs px-2 py-0.5 rounded border ${
                                job.isEditable
                                  ? 'border-purple-700 text-purple-300 bg-purple-900/30'
                                  : 'border-gray-700 text-gray-500 bg-gray-800'
                              }`}>
                                {job.status.replace(/_/g, ' ')}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="px-4 py-3 pl-10 text-sm text-gray-500 italic">
                        No jobs linked to this product
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {/* New Assemblies (to be added) */}
          {newAssemblies.map((assembly, aIdx) => (
            <div key={`new-${aIdx}`} className="mb-4 border border-green-900/50 rounded-lg overflow-hidden">
              {/* Header */}
              <div
                className="px-4 py-3 bg-green-900/20 flex items-center justify-between cursor-pointer"
                onClick={() => {
                  const updated = [...newAssemblies]
                  updated[aIdx].expanded = !updated[aIdx].expanded
                  setNewAssemblies(updated)
                }}
              >
                <div className="flex items-center gap-3">
                  <ChevronRight
                    size={16}
                    className={`text-gray-500 transition-transform ${assembly.expanded ? 'rotate-90' : ''}`}
                  />
                  <Package size={16} className="text-green-400" />
                  <div>
                    <span className="text-green-400 font-mono font-medium">{assembly.partNumber}</span>
                    <span className="text-xs ml-2 px-1.5 py-0.5 bg-green-900/40 text-green-400 rounded border border-green-800/50">
                      NEW
                    </span>
                    <p className="text-xs text-gray-500">{assembly.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3" onClick={e => e.stopPropagation()}>
                  <label className="text-xs text-gray-500">Qty:</label>
                  <input
                    type="number"
                    min="1"
                    value={assembly.quantity}
                    onChange={e => {
                      const updated = [...newAssemblies]
                      const newQty = parseInt(e.target.value) || 1
                      updated[aIdx].quantity = newQty
                      // Update all selected job quantities to match
                      updated[aIdx].jobs.forEach(j => j.quantity = newQty)
                      setNewAssemblies(updated)
                    }}
                    className="w-20 px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-sm text-center focus:border-skynet-accent focus:outline-none"
                  />
                  <button
                    onClick={(e) => { e.stopPropagation(); removeNewAssembly(aIdx) }}
                    className="text-red-400 hover:text-red-300 p-1"
                    title="Remove"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {/* Component Selection for new assembly */}
              {assembly.expanded && (
                <div className="border-t border-green-900/30">
                  {assembly.partType === 'finished_good' ? (
                    <div className="px-4 py-3 pl-10 text-sm text-gray-400 flex items-center gap-2">
                      <Package size={14} className="text-amber-400" />
                      Finished Good — single job will be created
                    </div>
                  ) : (
                    <div className="divide-y divide-gray-800">
                      {(assembly.bom || [])
                        .filter(bom => bom.component?.part_type !== 'assembly')
                        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
                        .map(bom => {
                          const isPurchased = bom.component?.part_type === 'purchased'
                          const isSelected = assembly.jobs.some(j => j.componentId === bom.component.id)

                          if (isPurchased) {
                            return (
                              <div key={bom.id} className="px-4 py-2 pl-10 flex items-center justify-between opacity-50">
                                <div className="flex items-center gap-2">
                                  <ShoppingCart size={12} className="text-orange-400" />
                                  <span className="text-gray-400 text-sm font-mono">{bom.component.part_number}</span>
                                  <span className="text-gray-600 text-sm">- {bom.component.description}</span>
                                </div>
                                <span className="text-xs px-2 py-0.5 bg-orange-900/40 text-orange-400 rounded">Purchased</span>
                              </div>
                            )
                          }

                          return (
                            <button
                              key={bom.id}
                              onClick={() => toggleNewJob(aIdx, bom.component.id, bom.component)}
                              className={`w-full px-4 py-2 pl-10 flex items-center justify-between text-left transition-colors ${
                                isSelected
                                  ? 'bg-green-900/20 hover:bg-green-900/30'
                                  : 'hover:bg-gray-800/50'
                              }`}
                            >
                              <div className="flex items-center gap-2">
                                <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                                  isSelected ? 'bg-green-500 border-green-500' : 'border-gray-600'
                                }`}>
                                  {isSelected && <span className="text-white text-xs">✓</span>}
                                </div>
                                <span className="text-gray-300 text-sm font-mono">{bom.component.part_number}</span>
                                <span className="text-gray-500 text-sm">- {bom.component.description}</span>
                              </div>
                            </button>
                          )
                        })}
                    </div>
                  )}
                  <div className="px-4 py-2 bg-green-900/10 border-t border-green-900/30">
                    <span className="text-xs text-green-400/70">
                      {assembly.jobs.length} job{assembly.jobs.length !== 1 ? 's' : ''} will be created in Pending Compliance
                    </span>
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Add Product Button */}
          {!showAddProduct ? (
            <button
              onClick={() => setShowAddProduct(true)}
              className="w-full py-3 border-2 border-dashed border-gray-700 rounded-lg text-gray-400 hover:text-skynet-accent hover:border-skynet-accent/50 transition-colors flex items-center justify-center gap-2"
            >
              <Plus size={18} />
              Add Product to Work Order
            </button>
          ) : (
            <div className="border border-gray-700 rounded-lg overflow-hidden">
              <div className="px-4 py-3 bg-gray-800/50 flex items-center justify-between">
                <span className="text-sm text-gray-400">Select a product to add</span>
                <button onClick={() => setShowAddProduct(false)} className="text-gray-400 hover:text-white">
                  <X size={16} />
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto divide-y divide-gray-800">
                {loadingParts ? (
                  <div className="p-4 text-center text-gray-500">
                    <Loader2 size={20} className="animate-spin mx-auto" />
                  </div>
                ) : addableParts.length === 0 ? (
                  <div className="p-4 text-center text-gray-500 text-sm">No additional products available</div>
                ) : (
                  <>
                    {/* Assemblies group */}
                    {addableParts.filter(p => p.part_type === 'assembly').length > 0 && (
                      <>
                        <div className="px-4 py-1.5 bg-gray-800/30 text-xs text-gray-500 font-medium uppercase">Assemblies</div>
                        {addableParts.filter(p => p.part_type === 'assembly').map(part => (
                          <button
                            key={part.id}
                            onClick={() => handleSelectNewProduct(part)}
                            className="w-full px-4 py-2 flex items-center justify-between hover:bg-gray-800/50 transition-colors text-left"
                          >
                            <div>
                              <span className="text-skynet-accent font-mono text-sm">{part.part_number}</span>
                              <p className="text-xs text-gray-500">{part.description}</p>
                            </div>
                            <span className="text-xs text-gray-600">
                              {(part.assembly_bom || []).filter(b => b.component?.part_type !== 'purchased' && b.component?.part_type !== 'assembly').length} components
                            </span>
                          </button>
                        ))}
                      </>
                    )}
                    {/* Finished Goods group */}
                    {addableParts.filter(p => p.part_type === 'finished_good').length > 0 && (
                      <>
                        <div className="px-4 py-1.5 bg-gray-800/30 text-xs text-gray-500 font-medium uppercase">Finished Goods</div>
                        {addableParts.filter(p => p.part_type === 'finished_good').map(part => (
                          <button
                            key={part.id}
                            onClick={() => handleSelectNewProduct(part)}
                            className="w-full px-4 py-2 flex items-center justify-between hover:bg-gray-800/50 transition-colors text-left"
                          >
                            <div>
                              <span className="text-amber-400 font-mono text-sm">{part.part_number}</span>
                              <p className="text-xs text-gray-500">{part.description}</p>
                            </div>
                            <span className="text-xs px-1.5 py-0.5 bg-amber-900/30 text-amber-400 rounded">FG</span>
                          </button>
                        ))}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-700 flex items-center justify-between flex-shrink-0 bg-gray-900">
          <div className="text-sm text-gray-500">
            {newAssemblies.length > 0 && (
              <span className="text-green-400">
                +{newAssemblies.length} new product{newAssemblies.length !== 1 ? 's' : ''} will require compliance review
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-sm transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !hasChanges()}
              className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-skynet-accent/80 text-black font-medium rounded text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}