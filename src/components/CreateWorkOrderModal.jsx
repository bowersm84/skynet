import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { X, Plus, Trash2, Package, Wrench, ShoppingCart, ChevronRight, Loader2 } from 'lucide-react'

export default function CreateWorkOrderModal({ isOpen, onClose, onSuccess, machines }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [assemblies, setAssemblies] = useState([])
  const [loadingAssemblies, setLoadingAssemblies] = useState(true)
  
  // Auto-generated WO number
  const [woNumber, setWoNumber] = useState('')
  const [generatingWO, setGeneratingWO] = useState(false)
  
  // Make to Stock vs Make to Order
  const [orderType, setOrderType] = useState('make_to_order')
  const [customer, setCustomer] = useState('')
  const [poNumber, setPoNumber] = useState('')
  
  const [priority, setPriority] = useState('normal')
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')
  const [selectedAssemblies, setSelectedAssemblies] = useState([])

  useEffect(() => {
    fetchAssemblies()
  }, [])

  useEffect(() => {
    if (isOpen) {
      generateWONumber()
      setOrderType('make_to_order')
      setCustomer('')
      setPoNumber('')
      setPriority('normal')
      setDueDate('')
      setNotes('')
      setSelectedAssemblies([])
      setError(null)
    }
  }, [isOpen])

  // Generate next WO number: WO-YYMM-NNNN
  const generateWONumber = async () => {
    setGeneratingWO(true)
    try {
      const now = new Date()
      const year = String(now.getFullYear()).slice(-2)
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const prefix = `WO-${year}${month}-`
      
      const { data, error } = await supabase
        .from('work_orders')
        .select('wo_number')
        .like('wo_number', `${prefix}%`)
        .order('wo_number', { ascending: false })
        .limit(1)
      
      let nextNum = 1
      if (data && data.length > 0) {
        const lastNum = parseInt(data[0].wo_number.split('-')[2]) || 0
        nextNum = lastNum + 1
      }
      
      setWoNumber(`${prefix}${String(nextNum).padStart(4, '0')}`)
    } catch (err) {
      console.error('Error generating WO number:', err)
      const now = new Date()
      const fallback = `WO-${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}-0001`
      setWoNumber(fallback)
    }
    setGeneratingWO(false)
  }

  const fetchAssemblies = async () => {
    setLoadingAssemblies(true)
    const { data, error } = await supabase
      .from('parts')
      .select(`
        id,
        part_number,
        description,
        specification,
        assembly_bom!assembly_bom_assembly_id_fkey(
          id,
          quantity,
          sort_order,
          component:parts!assembly_bom_component_id_fkey(
            id,
            part_number,
            description,
            part_type,
            unit_cost
          )
        )
      `)
      .eq('part_type', 'assembly')
      .eq('is_active', true)
      .order('part_number')

    if (error) {
      console.error('Error fetching assemblies:', error)
    } else {
      const sortedData = data.map(assembly => ({
        ...assembly,
        assembly_bom: (assembly.assembly_bom || []).sort((a, b) => a.sort_order - b.sort_order)
      }))
      setAssemblies(sortedData || [])
    }
    setLoadingAssemblies(false)
  }

  const addAssembly = () => {
    setSelectedAssemblies([...selectedAssemblies, {
      assemblyId: '',
      quantity: 1,
      components: [],
      jobs: []
    }])
  }

  const removeAssembly = (index) => {
    setSelectedAssemblies(selectedAssemblies.filter((_, i) => i !== index))
  }

  const updateAssemblySelection = (index, assemblyId) => {
    const assembly = assemblies.find(a => a.id === assemblyId)
    const updated = [...selectedAssemblies]
    updated[index] = {
      assemblyId,
      quantity: updated[index].quantity,
      components: assembly?.assembly_bom || [],
      jobs: []
    }
    setSelectedAssemblies(updated)
  }

  const updateAssemblyQuantity = (index, quantity) => {
    const updated = [...selectedAssemblies]
    updated[index].quantity = quantity
    updated[index].jobs = updated[index].jobs.map(job => ({
      ...job,
      quantity: job.quantityCustomized ? job.quantity : quantity
    }))
    setSelectedAssemblies(updated)
  }

  const addJobForComponent = (assemblyIndex, bom) => {
    const updated = [...selectedAssemblies]
    const exists = updated[assemblyIndex].jobs.some(j => j.componentId === bom.component.id)
    if (!exists) {
      updated[assemblyIndex].jobs.push({
        componentId: bom.component.id,
        partNumber: bom.component.part_number,
        description: bom.component.description,
        quantity: updated[assemblyIndex].quantity,
        quantityCustomized: false
      })
      setSelectedAssemblies(updated)
    }
  }

  const updateJobQuantity = (assemblyIndex, componentId, quantity) => {
    const updated = [...selectedAssemblies]
    const jobIndex = updated[assemblyIndex].jobs.findIndex(j => j.componentId === componentId)
    if (jobIndex >= 0) {
      updated[assemblyIndex].jobs[jobIndex].quantity = quantity
      updated[assemblyIndex].jobs[jobIndex].quantityCustomized = true
    }
    setSelectedAssemblies(updated)
  }

  const removeJob = (assemblyIndex, componentId) => {
    const updated = [...selectedAssemblies]
    updated[assemblyIndex].jobs = updated[assemblyIndex].jobs.filter(j => j.componentId !== componentId)
    setSelectedAssemblies(updated)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const totalJobs = selectedAssemblies.reduce((sum, a) => sum + a.jobs.length, 0)
      if (totalJobs === 0) {
        throw new Error('Please add at least one job')
      }

      // Create Work Order
      const { data: workOrder, error: woError } = await supabase
        .from('work_orders')
        .insert({
          wo_number: woNumber,
          order_type: orderType,
          customer: orderType === 'make_to_order' ? (customer || null) : null,
          po_number: orderType === 'make_to_order' ? (poNumber || null) : null,
          priority: priority,
          due_date: dueDate || null,
          notes: notes || null,
          status: 'pending'
        })
        .select()
        .single()

      if (woError) throw woError

      // Get next job number (J-######)
      const { data: lastJob } = await supabase
        .from('jobs')
        .select('job_number')
        .like('job_number', 'J-%')
        .order('job_number', { ascending: false })
        .limit(1)
      
      let nextJobNum = 1
      if (lastJob && lastJob.length > 0) {
        const lastNum = parseInt(lastJob[0].job_number.replace('J-', '')) || 0
        nextJobNum = lastNum + 1
      }

      // Create Work Order Assemblies and Jobs
      for (const assembly of selectedAssemblies) {
        if (!assembly.assemblyId || assembly.jobs.length === 0) continue

        const { data: woAssembly, error: woaError } = await supabase
          .from('work_order_assemblies')
          .insert({
            work_order_id: workOrder.id,
            assembly_id: assembly.assemblyId,
            quantity: assembly.quantity
          })
          .select()
          .single()

        if (woaError) throw woaError

        for (const job of assembly.jobs) {
          const jobNumber = `J-${String(nextJobNum).padStart(6, '0')}`
          
          const { error: jobError } = await supabase
            .from('jobs')
            .insert({
              work_order_id: workOrder.id,
              work_order_assembly_id: woAssembly.id,
              component_id: job.componentId,
              job_number: jobNumber,
              quantity: job.quantity,
              priority: priority,
              assigned_machine_id: null,
              status: 'pending_compliance'
            })

          if (jobError) throw jobError
          nextJobNum++
        }
      }

      onSuccess()
      onClose()
    } catch (err) {
      console.error('Error creating work order:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  if (!isOpen) return null

  const totalJobs = selectedAssemblies.reduce((sum, a) => sum + a.jobs.length, 0)

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-3xl max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <h2 className="text-xl font-semibold text-white">Create Work Order</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={24} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto max-h-[calc(90vh-140px)]">
          {error && (
            <div className="mb-4 p-3 bg-red-900/50 border border-red-700 rounded text-red-300 text-sm">
              {error}
            </div>
          )}

          {/* WO Number (Auto-generated) */}
          <div className="mb-4">
            <label className="block text-gray-400 text-sm mb-1">Work Order Number</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={woNumber}
                readOnly
                className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white font-mono"
              />
              {generatingWO && <Loader2 size={20} className="text-skynet-accent animate-spin" />}
            </div>
            <p className="text-gray-500 text-xs mt-1">Auto-generated: WO-YYMM-NNNN</p>
          </div>

          {/* Order Type Toggle */}
          <div className="mb-4">
            <label className="block text-gray-400 text-sm mb-2">Order Type</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setOrderType('make_to_order')}
                className={`flex-1 px-4 py-2 rounded font-medium transition-colors ${
                  orderType === 'make_to_order'
                    ? 'bg-skynet-accent text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                Make to Order
              </button>
              <button
                type="button"
                onClick={() => setOrderType('make_to_stock')}
                className={`flex-1 px-4 py-2 rounded font-medium transition-colors ${
                  orderType === 'make_to_stock'
                    ? 'bg-green-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                Make to Stock
              </button>
            </div>
          </div>

          {/* Customer & PO (only for Make to Order) */}
          {orderType === 'make_to_order' && (
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-gray-400 text-sm mb-1">Customer *</label>
                <input
                  type="text"
                  value={customer}
                  onChange={(e) => setCustomer(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
                  placeholder="Customer name"
                  required={orderType === 'make_to_order'}
                />
              </div>
              <div>
                <label className="block text-gray-400 text-sm mb-1">PO Number</label>
                <input
                  type="text"
                  value={poNumber}
                  onChange={(e) => setPoNumber(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
                  placeholder="PO-12345"
                />
              </div>
            </div>
          )}

          {/* Priority, Due Date, Notes */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div>
              <label className="block text-gray-400 text-sm mb-1">Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
              >
                <option value="low">⚪ Low</option>
                <option value="normal">🟢 Normal</option>
                <option value="high">🟡 High</option>
                <option value="critical">🔴 Critical</option>
              </select>
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1">Due Date</label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
              />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1">Notes</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
                placeholder="Optional"
              />
            </div>
          </div>

          {/* Assemblies Section */}
          <div className="border-t border-gray-700 pt-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-medium flex items-center gap-2">
                <Package size={18} />
                Assemblies
              </h3>
              <button
                type="button"
                onClick={addAssembly}
                disabled={loadingAssemblies}
                className="flex items-center gap-1 px-3 py-1 text-sm bg-gray-800 hover:bg-gray-700 text-skynet-accent rounded transition-colors disabled:opacity-50"
              >
                <Plus size={16} />
                Add Assembly
              </button>
            </div>

            {loadingAssemblies ? (
              <div className="text-center py-4 text-gray-500">Loading assemblies...</div>
            ) : assemblies.length === 0 ? (
              <div className="text-center py-4 text-yellow-500 bg-yellow-900/20 rounded border border-yellow-800">
                No assemblies found. Add assemblies in Parts management first.
              </div>
            ) : selectedAssemblies.length === 0 ? (
              <div className="text-center py-8 text-gray-500 bg-gray-800/50 rounded border border-dashed border-gray-700">
                Click "Add Assembly" to select an assembly for this work order
              </div>
            ) : (
              <div className="space-y-4">
                {selectedAssemblies.map((selected, assemblyIndex) => (
                  <div key={assemblyIndex} className="bg-gray-800 rounded-lg p-4 border border-gray-700">
                    <div className="flex items-start justify-between gap-4 mb-4">
                      <div className="flex-1 grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-gray-500 text-xs mb-1">Assembly Part</label>
                          <select
                            value={selected.assemblyId}
                            onChange={(e) => updateAssemblySelection(assemblyIndex, e.target.value)}
                            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:border-skynet-accent"
                          >
                            <option value="">-- Select Assembly --</option>
                            {assemblies.map(a => (
                              <option key={a.id} value={a.id}>
                                {a.part_number} - {a.description}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-gray-500 text-xs mb-1">Order Quantity</label>
                          <input
                            type="number"
                            min="1"
                            value={selected.quantity}
                            onChange={(e) => updateAssemblyQuantity(assemblyIndex, parseInt(e.target.value) || 1)}
                            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:border-skynet-accent"
                          />
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeAssembly(assemblyIndex)}
                        className="text-red-400 hover:text-red-300 mt-5"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>

                    {selected.assemblyId && selected.components.length > 0 && (
                      <div className="border-t border-gray-700 pt-3">
                        <p className="text-gray-400 text-sm mb-2">Bill of Materials:</p>
                        <div className="space-y-2">
                          {selected.components.map((bom) => {
                            const isManufactured = bom.component.part_type === 'manufactured'
                            const job = selected.jobs.find(j => j.componentId === bom.component.id)
                            const hasJob = !!job

                            return (
                              <div key={bom.id}>
                                <div 
                                  className={`rounded p-3 flex items-center justify-between ${
                                    isManufactured 
                                      ? 'bg-gray-700 border border-gray-600' 
                                      : 'bg-gray-800/50 border border-gray-700 border-dashed'
                                  }`}
                                >
                                  <div className="flex items-center gap-2">
                                    {isManufactured ? (
                                      <Wrench size={14} className="text-skynet-accent" />
                                    ) : (
                                      <ShoppingCart size={14} className="text-gray-500" />
                                    )}
                                    <span className="text-white font-mono text-sm">{bom.component.part_number}</span>
                                    <span className="text-gray-400 text-sm">{bom.component.description}</span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className={`text-xs px-2 py-0.5 rounded ${
                                      isManufactured 
                                        ? 'bg-skynet-accent/20 text-skynet-accent' 
                                        : 'bg-gray-600 text-gray-400'
                                    }`}>
                                      {isManufactured ? 'Manufactured' : 'Purchased'}
                                    </span>
                                    {isManufactured && !hasJob && (
                                      <button
                                        type="button"
                                        onClick={() => addJobForComponent(assemblyIndex, bom)}
                                        className="flex items-center gap-1 px-2 py-1 text-xs bg-green-600 hover:bg-green-500 text-white rounded transition-colors"
                                      >
                                        <Plus size={12} />
                                        Add Job
                                      </button>
                                    )}
                                  </div>
                                </div>

                                {hasJob && (
                                  <div className="ml-6 mt-1 bg-green-900/20 border border-green-800 rounded p-2 flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                      <ChevronRight size={14} className="text-green-500" />
                                      <span className="text-green-400 text-sm font-mono">
                                        Job: {bom.component.part_number}
                                      </span>
                                      <div className="flex items-center gap-1">
                                        <label className="text-green-600 text-xs">Qty:</label>
                                        <input
                                          type="number"
                                          min="1"
                                          value={job.quantity}
                                          onChange={(e) => updateJobQuantity(assemblyIndex, bom.component.id, parseInt(e.target.value) || 1)}
                                          className="w-20 px-2 py-1 bg-green-900/30 border border-green-700 rounded text-green-400 text-sm focus:outline-none focus:border-green-500"
                                        />
                                        {job.quantity !== selected.quantity && (
                                          <span className="text-yellow-500 text-xs ml-1" title="Quantity differs from order">
                                            ≠
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => removeJob(assemblyIndex, bom.component.id)}
                                      className="text-red-400 hover:text-red-300"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </form>

        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-700">
          <div className="text-sm text-gray-400">
            {totalJobs > 0 ? (
              <span>
                <span className="text-green-400 font-medium">{totalJobs}</span> job{totalJobs !== 1 ? 's' : ''} will be created → Compliance Review
              </span>
            ) : (
              <span className="text-gray-500">Add jobs to continue</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={loading || totalJobs === 0 || (orderType === 'make_to_order' && !customer)}
              className="px-6 py-2 bg-skynet-accent hover:bg-blue-600 text-white font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Creating...' : 'Create Work Order'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}