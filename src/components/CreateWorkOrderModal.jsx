import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { getOpenCOLinesForPart } from '../lib/customerOrders'
import { X, Plus, Trash2, Package, ShoppingCart, ChevronRight, Loader2, Wrench, GripVertical, Search, ChevronDown } from 'lucide-react'

// Searchable product picker — replaces native <select> for the Product field.
// Filters by part_number + description + customer. Groups results by part_type.
// Inactive parts are still shown but non-selectable.
function ProductCombobox({ value, onChange, assemblies, allowManufactured }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const wrapperRef = useRef(null)
  const inputRef = useRef(null)

  const selected = assemblies.find(a => a.id === value)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const matches = (a) => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      (a.part_number || '').toLowerCase().includes(q) ||
      (a.description || '').toLowerCase().includes(q) ||
      (a.customer || '').toLowerCase().includes(q)
    )
  }

  const groups = [
    { label: 'Products (Assembly)', items: assemblies.filter(a => a.part_type === 'assembly' && matches(a)) },
    { label: 'Finished Goods', items: assemblies.filter(a => a.part_type === 'finished_good' && matches(a)) },
  ]
  if (allowManufactured) {
    groups.push({ label: 'Parts (Manufactured)', items: assemblies.filter(a => a.part_type === 'manufactured' && matches(a)) })
  }
  const totalMatches = groups.reduce((sum, g) => sum + g.items.length, 0)

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen(o => !o)
          setTimeout(() => inputRef.current?.focus(), 10)
        }}
        className="w-full min-w-0 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:border-skynet-accent flex items-center justify-between gap-2 text-left"
      >
        <span className="flex-1 min-w-0 truncate">
          {selected ? (
            <>
              <span className="font-mono">{selected.part_number}</span>
              <span className="text-gray-400"> — {selected.description}</span>
            </>
          ) : (
            <span className="text-gray-400">-- Select Product --</span>
          )}
        </span>
        <ChevronDown size={16} className="text-gray-400 flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-gray-800 border border-gray-600 rounded shadow-2xl max-h-80 flex flex-col">
          <div className="relative p-2 border-b border-gray-700 flex-shrink-0">
            <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by part #, description, or customer..."
              className="w-full pl-8 pr-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-white placeholder-gray-500 text-sm focus:border-skynet-accent focus:outline-none"
            />
          </div>
          <div className="overflow-y-auto flex-1">
            {totalMatches === 0 ? (
              <div className="text-gray-500 text-sm text-center py-4">No products match.</div>
            ) : groups.map(g => g.items.length > 0 && (
              <div key={g.label}>
                <div className="px-3 py-1.5 bg-gray-900/50 text-gray-500 text-xs font-semibold uppercase tracking-wide sticky top-0">
                  {g.label}
                </div>
                {g.items.map(a => (
                  <button
                    key={a.id}
                    type="button"
                    disabled={!a.is_active}
                    onClick={() => {
                      if (!a.is_active) return
                      onChange(a.id)
                      setOpen(false)
                      setSearch('')
                    }}
                    className={`w-full text-left px-3 py-2 text-sm border-t border-gray-700/50 ${
                      !a.is_active
                        ? 'opacity-50 cursor-not-allowed'
                        : value === a.id
                        ? 'bg-skynet-accent/20 hover:bg-skynet-accent/30'
                        : 'hover:bg-gray-700'
                    }`}
                  >
                    <div className="text-white font-mono text-xs flex items-center gap-2">
                      {a.part_number}
                      {!a.is_active && (
                        <span className="text-amber-300 text-[10px] px-1 py-0.5 bg-amber-900/40 rounded">Pending Master Data</span>
                      )}
                    </div>
                    <div className="text-gray-400 text-xs truncate">
                      {a.description}{a.customer ? ` · ${a.customer}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default function CreateWorkOrderModal({ isOpen, onClose, onSuccess, profile, preselectedPartId = null, preselectedCoLines = [] }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const modalContentRef = useRef(null)
  const [assemblies, setAssemblies] = useState([])
  const [loadingAssemblies, setLoadingAssemblies] = useState(true)

  // Auto-generated WO number
  const [woNumber, setWoNumber] = useState('')
  const [generatingWO, setGeneratingWO] = useState(false)

  // (order_type, customer, po_number derived from linked COs at submit time)

  // Production order fields
  const [priority, setPriority] = useState('normal')
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')
  const [selectedAssemblies, setSelectedAssemblies] = useState([])

  // Routing cache: { [partId]: [steps] }
  const [routingCache, setRoutingCache] = useState({})
  // CO line allocations per assembly row.
  // coLinesByAssembly[index] = { lines: [...openLines], allocations: { [lineId]: qtyToAllocate } }
  // qtyToAllocate defaults to line.remaining when checked, 0 (unchecked) when unchecked.
  const [coLinesByAssembly, setCoLinesByAssembly] = useState({})
  const [loadingCoLines, setLoadingCoLines] = useState({}) // { [assemblyIndex]: bool }
  // Routing modifications for C3
  const [routingRemovals, setRoutingRemovals] = useState({})       // { [stepId]: reason }
  const [removalInput, setRemovalInput] = useState(null)            // stepId being edited
  const [removalReason, setRemovalReason] = useState('')
  const [routingAdditions, setRoutingAdditions] = useState({})      // { [partId]: [{ stepName, stepType, station }] }
  const [addingStepFor, setAddingStepFor] = useState(null)          // partId currently adding to
  const [newStepName, setNewStepName] = useState('')
  const [newStepType, setNewStepType] = useState('internal')
  const [dragRoutingFrom, setDragRoutingFrom] = useState(null)     // { partId, idx }
  const [dragRoutingOver, setDragRoutingOver] = useState(null)     // { partId, idx }

  const fetchCoLinesForPart = useCallback(async (assemblyIndex, partId) => {
    if (!partId) return
    setLoadingCoLines(prev => ({ ...prev, [assemblyIndex]: true }))
    try {
      const lines = await getOpenCOLinesForPart(supabase, partId)
      setCoLinesByAssembly(prev => ({
        ...prev,
        [assemblyIndex]: { lines, allocations: {} },
      }))
    } catch (err) {
      console.error('Error fetching CO lines:', err)
      setCoLinesByAssembly(prev => ({
        ...prev,
        [assemblyIndex]: { lines: [], allocations: {} },
      }))
    } finally {
      setLoadingCoLines(prev => ({ ...prev, [assemblyIndex]: false }))
    }
  }, [])

  const fetchComponentRouting = useCallback(async (partId) => {
    if (!partId) return
    setRoutingCache(prev => {
      if (prev[partId]) return prev
      // Mark as loading with empty array, then fetch
      return { ...prev, [partId]: [] }
    })
    const { data } = await supabase
      .from('part_routing_steps')
      .select('*')
      .eq('part_id', partId)
      .eq('is_active', true)
      .order('step_order')
    setRoutingCache(prev => ({ ...prev, [partId]: data || [] }))
  }, [])

  // Generate next WO number
  const generateOrderNumber = useCallback(async () => {
    setGeneratingWO(true)
    try {
      const now = new Date()
      const year = String(now.getFullYear()).slice(-2)
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const prefix = `WO-${year}${month}-`

      const { data, error: _error } = await supabase
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
      console.error('Error generating order number:', err)
      const now = new Date()
      const fallback = `WO-${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}-0001`
      setWoNumber(fallback)
    }
    setGeneratingWO(false)
  }, [])

  const fetchAssemblies = useCallback(async () => {
    setLoadingAssemblies(true)
    const { data, error } = await supabase
      .from('parts')
      .select(`
        id,
        part_number,
        description,
        specification,
        part_type,
        is_active,
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
      .in('part_type', ['assembly', 'finished_good', 'manufactured'])
      .order('part_number')

    if (error) {
      console.error('Error fetching assemblies:', error)
    } else {
      setAssemblies(data || [])
    }
    setLoadingAssemblies(false)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAssemblies()
  }, [fetchAssemblies])

  useEffect(() => {
    if (!isOpen) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    generateOrderNumber()
    setPriority('normal')
    setDueDate('')
    setNotes('')
    setSelectedAssemblies([])
    setCoLinesByAssembly({})
    setLoadingCoLines({})
    setRoutingCache({})
    setRoutingRemovals({})
    setRemovalInput(null)
    setRemovalReason('')
    setRoutingAdditions({})
    setAddingStepFor(null)
    setNewStepName('')
    setNewStepType('internal')
    setError(null)
  }, [isOpen, generateOrderNumber])

  // Demand-driven entry: when called with preselectedPartId, auto-add a single
  // assembly row with the chosen CO lines pre-checked at full remaining qty.
  // We inline the part-type-aware job creation rather than calling
  // updateAssemblySelection, because updateAssemblySelection clobbers the
  // coLinesByAssembly entry we just set.
  // Waits for the assemblies list to load (the part_type lookup needs it).
  useEffect(() => {
    if (!isOpen) return
    if (!preselectedPartId || preselectedCoLines.length === 0) return
    if (loadingAssemblies || assemblies.length === 0) return

    const part = assemblies.find(a => a.id === preselectedPartId)
    if (!part) return

    const totalRemaining = preselectedCoLines.reduce((s, l) => s + l.remaining, 0)
    const isAutoJobType = part.part_type === 'finished_good' || part.part_type === 'manufactured'

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedAssemblies([{
      assemblyId: preselectedPartId,
      orderQuantity: totalRemaining,
      additionalForStock: 0,
      jobs: isAutoJobType ? [{
        componentId: part.id,
        partNumber: part.part_number,
        description: part.description,
        quantity: totalRemaining,
        quantityCustomized: false,
        isFinishedGood: part.part_type === 'finished_good',
        isManufactured: part.part_type === 'manufactured',
      }] : [],
    }])

    const allocations = {}
    preselectedCoLines.forEach(line => {
      allocations[line.line_id] = line.remaining
    })
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCoLinesByAssembly({ 0: { lines: preselectedCoLines, allocations } })

    fetchComponentRouting(preselectedPartId)
  }, [isOpen, preselectedPartId, preselectedCoLines, assemblies, loadingAssemblies, fetchComponentRouting])

  const addAssembly = () => {
    setSelectedAssemblies(prev => [{ assemblyId: '', orderQuantity: 1, additionalForStock: 0, jobs: [] }, ...prev])
    // Scroll modal content to top so the new row is visible
    setTimeout(() => {
      modalContentRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    }, 50)
  }

  const removeAssembly = (index) => {
    setSelectedAssemblies(selectedAssemblies.filter((_, i) => i !== index))
  }

  const updateAssemblySelection = (index, assemblyId) => {
    const updated = [...selectedAssemblies]
    updated[index].assemblyId = assemblyId
    updated[index].jobs = [] // Reset jobs when assembly changes

    // If this is a finished good or manufactured part, auto-add a single job for the part itself
    const selectedPart = assemblies.find(a => a.id === assemblyId)
    if (selectedPart && (selectedPart.part_type === 'finished_good' || selectedPart.part_type === 'manufactured')) {
      updated[index].jobs = [{
        componentId: selectedPart.id,
        partNumber: selectedPart.part_number,
        description: selectedPart.description,
        quantity: updated[index].orderQuantity + updated[index].additionalForStock,
        quantityCustomized: false,
        isFinishedGood: selectedPart.part_type === 'finished_good',
        isManufactured: selectedPart.part_type === 'manufactured'
      }]
      fetchComponentRouting(selectedPart.id)
    }

    setSelectedAssemblies(updated)

    // Reset any prior CO selections for this row, then fetch fresh open lines.
    setCoLinesByAssembly(prev => {
      const next = { ...prev }
      delete next[index]
      return next
    })
    if (selectedPart) {
      fetchCoLinesForPart(index, selectedPart.id)
    }
  }

  // Allocation = how many of `line.remaining` to claim against this WO. When non-zero
  // values exist, the assembly's orderQuantity becomes the sum of allocations (the
  // user-entered Order Qty is overridden — COs ARE the demand). Job qtys for any
  // non-customized job follow.
  const setLineAllocation = (assemblyIndex, lineId, qty) => {
    setCoLinesByAssembly(prev => {
      const row = prev[assemblyIndex] || { lines: [], allocations: {} }
      const nextAllocations = { ...row.allocations, [lineId]: qty }
      const next = { ...prev, [assemblyIndex]: { ...row, allocations: nextAllocations } }

      const totalAllocated = Object.values(nextAllocations).reduce((s, v) => s + (v || 0), 0)
      if (totalAllocated > 0) {
        setSelectedAssemblies(curr => {
          const updated = [...curr]
          if (!updated[assemblyIndex]) return curr
          const stock = updated[assemblyIndex].additionalForStock || 0
          updated[assemblyIndex] = {
            ...updated[assemblyIndex],
            orderQuantity: totalAllocated,
            jobs: updated[assemblyIndex].jobs.map(job => ({
              ...job,
              quantity: job.quantityCustomized ? job.quantity : totalAllocated + stock,
            })),
          }
          return updated
        })
      }
      return next
    })
  }

  const updateAssemblyQtyField = (index, field, value) => {
    const updated = [...selectedAssemblies]
    const min = field === 'orderQuantity' ? 1 : 0
    updated[index][field] = Math.max(min, parseInt(value) || 0)
    const total = updated[index].orderQuantity + updated[index].additionalForStock
    // Update job quantities that haven't been customized
    updated[index].jobs = updated[index].jobs.map(job => ({
      ...job,
      quantity: job.quantityCustomized ? job.quantity : total
    }))
    setSelectedAssemblies(updated)
  }

  const getAssemblyById = (assemblyId) => {
    return assemblies.find(a => a.id === assemblyId)
  }

  const addJobFromBOM = (assemblyIndex, bom) => {
    const updated = [...selectedAssemblies]
    const exists = updated[assemblyIndex].jobs.some(j => j.componentId === bom.component.id)
    if (!exists) {
      updated[assemblyIndex].jobs.push({
        componentId: bom.component.id,
        partNumber: bom.component.part_number,
        description: bom.component.description,
        quantity: updated[assemblyIndex].orderQuantity + updated[assemblyIndex].additionalForStock,
        quantityCustomized: false
      })
      setSelectedAssemblies(updated)
      fetchComponentRouting(bom.component.id)
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
      await handleProductionSubmit()
    } catch (err) {
      console.error('Error creating work order:', err)
      setError(err.message)
    }
    
    setLoading(false)
  }

  const handleProductionSubmit = async () => {
    const totalJobs = selectedAssemblies.reduce((sum, a) => sum + a.jobs.length, 0)
    if (totalJobs === 0) {
      throw new Error('Please add at least one job')
    }

    // Create Work Order

    // Resolve each assembly's effective order quantity: when CO allocations are
    // selected, the allocations ARE the demand and override the user-entered
    // Order Qty. With no allocations, fall back to the user's entry.
    const effectiveOrderQtyByIndex = selectedAssemblies.map((sa, i) => {
      const allocs = coLinesByAssembly[i]?.allocations || {}
      const totalAlloc = Object.values(allocs).reduce((s, v) => s + (v || 0), 0)
      return totalAlloc > 0 ? totalAlloc : (parseInt(sa.orderQuantity) || 0)
    })

    const totalOrderQty = effectiveOrderQtyByIndex.reduce((sum, v) => sum + (v || 0), 0)
    const totalStockQty = selectedAssemblies.reduce((sum, a) => sum + (parseInt(a.additionalForStock) || 0), 0) || null

    const { data: workOrder, error: woError } = await supabase
      .from('work_orders')
      .insert({
        wo_number: woNumber,
        // order_type, customer, po_number, is_combined set after CO allocation
        priority: priority,
        due_date: dueDate || null,
        notes: notes || null,
        order_quantity: totalOrderQty || null,
        stock_quantity: totalStockQty || null,
        status: 'pending'
      })
      .select()
      .single()

    if (woError) throw woError

	// Get next job number - find the highest existing J-###### number
	const { data: productionJobs } = await supabase
	  .from('jobs')
	  .select('job_number')
	  .like('job_number', 'J-%')

	let nextJobNum = 1
	if (productionJobs && productionJobs.length > 0) {
	  const jobNumbers = productionJobs
		.map(j => {
		  const match = j.job_number.match(/^J-(\d+)$/)
		  return match ? parseInt(match[1], 10) : 0
		})
		.filter(n => !isNaN(n) && n > 0)
	  
	  if (jobNumbers.length > 0) {
		nextJobNum = Math.max(...jobNumbers) + 1
	  }
	}
	
    // Create work_order_assemblies records and jobs for each selected assembly/FG
    for (let assemblyIdx = 0; assemblyIdx < selectedAssemblies.length; assemblyIdx++) {
      const assembly = selectedAssemblies[assemblyIdx]
      if (!assembly.assemblyId) continue
      const assemblyPart = assemblies.find(a => a.id === assembly.assemblyId)
      if (!assemblyPart) continue

      const effectiveOrderQty = effectiveOrderQtyByIndex[assemblyIdx]

      // Skip work_order_assemblies for manufactured parts (only for assemblies/FGs)
      let woaId = null
      if (assemblyPart.part_type !== 'manufactured') {
        const { data: woaData, error: woaError } = await supabase
          .from('work_order_assemblies')
          .insert({
            work_order_id: workOrder.id,
            assembly_id: assemblyPart.id,
            quantity: effectiveOrderQty + assembly.additionalForStock,
            order_quantity: effectiveOrderQty || null,
            stock_quantity: assembly.additionalForStock || null,
            status: 'pending'
          })
          .select('id')
          .single()

        if (woaError) {
          console.error('Error creating work_order_assemblies:', woaError)
        }

        woaId = woaData?.id || null
      }

      // Write CO allocation rows for this assembly's selected lines.
      // Triggers will fire and roll up parent CO line + header status.
      const allocations = coLinesByAssembly[assemblyIdx]?.allocations || {}
      const selectedAlloc = Object.entries(allocations).filter(([, qty]) => (qty || 0) > 0)

      if (selectedAlloc.length > 0) {
        const allocationRows = selectedAlloc.map(([lineId, qty]) => ({
          customer_order_line_id: lineId,
          work_order_id: workOrder.id,
          quantity_allocated: qty,
          created_by: profile?.id || null,
        }))
        const { error: allocError } = await supabase
          .from('customer_order_allocations')
          .insert(allocationRows)
        if (allocError) {
          console.error('Error creating CO allocations:', allocError)
          // Don't fail the WO — log and continue.
        }
      }

      // Create jobs and copy routing steps
      for (const job of assembly.jobs) {
        const { data: newJob, error: jobError } = await supabase
          .from('jobs')
          .insert({
            job_number: `J-${String(nextJobNum++).padStart(6, '0')}`,
            work_order_id: workOrder.id,
            work_order_assembly_id: woaId,
            component_id: job.componentId,
            quantity: job.quantity,
            status: 'pending_compliance',
            is_maintenance: false
          })
          .select('id')
          .single()

        if (jobError) {
          console.error('Error creating job:', jobError)
          continue
        }

        // Copy part_routing_steps → job_routing_steps (with removal/addition modifications)
        const { data: partRouting } = await supabase
          .from('part_routing_steps')
          .select('*')
          .eq('part_id', job.componentId)
          .eq('is_active', true)
          .order('step_order')

        const additions = routingAdditions[job.componentId] || []
        if (partRouting?.length > 0 || additions.length > 0) {
          const jobSteps = (partRouting || []).map(step => {
            const removalReason = routingRemovals[step.id]
            return {
              job_id: newJob.id,
              step_order: step.step_order,
              step_name: step.step_name,
              step_type: step.step_type,
              station: step.default_station,
              status: removalReason !== undefined ? 'removal_pending' : 'pending',
              ...(removalReason !== undefined && {
                removal_reason: removalReason,
                removal_requested_by: profile?.id || null,
                removal_requested_at: new Date().toISOString()
              })
            }
          })

          // Append added steps
          const maxOrder = partRouting?.length > 0 ? Math.max(...partRouting.map(s => s.step_order)) : 0
          additions.forEach((added, i) => {
            jobSteps.push({
              job_id: newJob.id,
              step_order: maxOrder + i + 1,
              step_name: added.stepName,
              step_type: added.stepType,
              station: null,
              status: 'pending',
              is_added_step: true,
              added_by: profile?.id || null,
              added_at: new Date().toISOString()
            })
          })

          if (jobSteps.length > 0) {
            const { error: stepsError } = await supabase
              .from('job_routing_steps')
              .insert(jobSteps)
            if (stepsError) {
              console.error('Error copying routing steps:', stepsError)
            }
          }
        }
      }
    }

    // Derive WO header fields from linked COs
    const allSelectedLines = selectedAssemblies.flatMap((sa, idx) =>
      Object.entries(coLinesByAssembly[idx]?.allocations || {})
        .filter(([, qty]) => qty > 0)
        .map(([lineId]) => coLinesByAssembly[idx].lines.find(l => l.line_id === lineId))
        .filter(Boolean)
    )

    const uniqueCoIds = [...new Set(allSelectedLines.map(l => l.co_id))]

    let woUpdate = {}
    if (uniqueCoIds.length === 0) {
      woUpdate = { order_type: 'make_to_stock', customer: null, po_number: null, is_combined: false }
    } else if (uniqueCoIds.length === 1) {
      const line = allSelectedLines[0]
      woUpdate = {
        order_type: 'make_to_order',
        customer: line.customer_name,
        po_number: line.po_number,
        is_combined: false,
      }
    } else {
      woUpdate = { order_type: 'make_to_order', customer: null, po_number: null, is_combined: true }
    }

    const { error: woUpdErr } = await supabase
      .from('work_orders')
      .update(woUpdate)
      .eq('id', workOrder.id)
    if (woUpdErr) console.error('Error setting derived WO header fields:', woUpdErr)

    onSuccess?.()
    onClose()
  }

  const totalJobs = selectedAssemblies.reduce((sum, a) => sum + a.jobs.length, 0)

  const reorderPartRouting = (partId, fromIdx, toIdx) => {
    if (fromIdx === toIdx) return
    const baseSteps = routingCache[partId] || []
    const addedSteps = routingAdditions[partId] || []
    const combined = [
      ...baseSteps.map(s => ({ type: 'base', data: s })),
      ...addedSteps.map(s => ({ type: 'added', data: s }))
    ]
    const [moved] = combined.splice(fromIdx, 1)
    combined.splice(toIdx, 0, moved)
    const newBase = combined.filter(i => i.type === 'base').map(i => i.data)
    const newAdded = combined.filter(i => i.type === 'added').map(i => i.data)
    setRoutingCache(prev => ({ ...prev, [partId]: newBase }))
    setRoutingAdditions(prev => ({ ...prev, [partId]: newAdded }))
  }

  // Shared routing step renderer with removal/addition UI
  const renderRoutingSteps = (partId) => {
    const steps = routingCache[partId]
    const additions = routingAdditions[partId] || []
    if (!steps?.length && !additions.length) return null

    const unified = [
      ...(steps || []).map(s => ({ type: 'base', data: s })),
      ...additions.map(s => ({ type: 'added', data: s }))
    ]

    return (
      <div className="mt-2 pl-4 border-l-2 border-gray-700">
        <div className="text-xs text-gray-500 mb-1">Routing:</div>
        {unified.map((item, idx) => {
          const isDragging = dragRoutingFrom?.partId === partId && dragRoutingFrom?.idx === idx
          const isDropTarget = dragRoutingOver?.partId === partId && dragRoutingOver?.idx === idx

          if (item.type === 'base') {
            const step = item.data
            const isMarkedForRemoval = routingRemovals[step.id] !== undefined
            const isEditingRemoval = removalInput === step.id
            return (
              <div
                key={step.id}
                draggable
                onDragStart={() => setDragRoutingFrom({ partId, idx })}
                onDragOver={(e) => { e.preventDefault(); setDragRoutingOver({ partId, idx }) }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragRoutingFrom && dragRoutingFrom.partId === partId) {
                    reorderPartRouting(partId, dragRoutingFrom.idx, idx)
                  }
                  setDragRoutingFrom(null)
                  setDragRoutingOver(null)
                }}
                onDragEnd={() => { setDragRoutingFrom(null); setDragRoutingOver(null) }}
                className={`py-0.5 ${isDragging ? 'opacity-40' : ''} ${isDropTarget ? 'border-t border-skynet-accent' : ''}`}
              >
                <div className={`flex items-center gap-2 text-sm ${isMarkedForRemoval ? 'line-through text-red-400/60' : 'text-gray-400'}`}>
                  <GripVertical size={12} className="text-gray-600 hover:text-gray-400 cursor-grab active:cursor-grabbing flex-shrink-0" />
                  <span className="text-gray-600">{idx + 1}.</span>
                  <span>{step.step_name}</span>
                  {step.default_station && (
                    <span className="text-gray-600">({step.default_station})</span>
                  )}
                  {step.step_type === 'external' && (
                    <span className={`text-xs px-1 rounded ${isMarkedForRemoval ? 'bg-orange-900/20 text-orange-400/50' : 'bg-orange-900/30 text-orange-400'}`}>External</span>
                  )}
                  {isMarkedForRemoval ? (
                    <button
                      type="button"
                      onClick={() => {
                        setRoutingRemovals(prev => {
                          const next = { ...prev }
                          delete next[step.id]
                          return next
                        })
                      }}
                      className="ml-auto text-xs px-1.5 py-0.5 bg-gray-700 text-gray-300 rounded hover:bg-gray-600"
                    >
                      Undo
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setRemovalInput(step.id)
                        setRemovalReason('')
                      }}
                      className="ml-auto text-xs text-red-500/50 hover:text-red-400"
                      title="Request step removal"
                    >
                      ✕
                    </button>
                  )}
                </div>
                {isMarkedForRemoval && (
                  <div className="text-xs text-red-400/70 ml-6">Removal reason: {routingRemovals[step.id]}</div>
                )}
                {isEditingRemoval && (
                  <div className="flex items-center gap-2 ml-6 mt-1">
                    <input
                      type="text"
                      value={removalReason}
                      onChange={(e) => setRemovalReason(e.target.value)}
                      placeholder="Reason for removal (required)"
                      className="flex-1 px-2 py-1 bg-gray-700 border border-red-700/50 rounded text-sm text-white focus:outline-none focus:border-red-600"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && removalReason.trim()) {
                          setRoutingRemovals(prev => ({ ...prev, [step.id]: removalReason.trim() }))
                          setRemovalInput(null)
                          setRemovalReason('')
                        } else if (e.key === 'Escape') {
                          setRemovalInput(null)
                          setRemovalReason('')
                        }
                      }}
                    />
                    <button
                      type="button"
                      disabled={!removalReason.trim()}
                      onClick={() => {
                        setRoutingRemovals(prev => ({ ...prev, [step.id]: removalReason.trim() }))
                        setRemovalInput(null)
                        setRemovalReason('')
                      }}
                      className="px-2 py-1 bg-red-900/50 text-red-300 rounded text-xs hover:bg-red-900 disabled:opacity-50"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => { setRemovalInput(null); setRemovalReason('') }}
                      className="px-2 py-1 text-gray-400 text-xs hover:text-white"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )
          }

          // item.type === 'added'
          const added = item.data
          const addedOrigIdx = additions.indexOf(added)
          return (
            <div
              key={`added-${addedOrigIdx}`}
              draggable
              onDragStart={() => setDragRoutingFrom({ partId, idx })}
              onDragOver={(e) => { e.preventDefault(); setDragRoutingOver({ partId, idx }) }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragRoutingFrom && dragRoutingFrom.partId === partId) {
                  reorderPartRouting(partId, dragRoutingFrom.idx, idx)
                }
                setDragRoutingFrom(null)
                setDragRoutingOver(null)
              }}
              onDragEnd={() => { setDragRoutingFrom(null); setDragRoutingOver(null) }}
              className={`py-0.5 ${isDragging ? 'opacity-40' : ''} ${isDropTarget ? 'border-t border-skynet-accent' : ''}`}
            >
              <div className="flex items-center gap-2 text-sm text-green-400">
                <GripVertical size={12} className="text-gray-600 hover:text-gray-400 cursor-grab active:cursor-grabbing flex-shrink-0" />
                <span className="text-gray-600">{idx + 1}.</span>
                <span>{added.stepName}</span>
                {added.stepType === 'external' && (
                  <span className="text-xs px-1 bg-orange-900/30 text-orange-400 rounded">External</span>
                )}
                <span className="text-xs px-1 bg-green-900/30 text-green-400 rounded">Added</span>
                <button
                  type="button"
                  onClick={() => {
                    setRoutingAdditions(prev => ({
                      ...prev,
                      [partId]: prev[partId].filter((_, i) => i !== addedOrigIdx)
                    }))
                  }}
                  className="ml-auto text-xs text-red-500/50 hover:text-red-400"
                >
                  ✕
                </button>
              </div>
            </div>
          )
        })}
        {/* Add Step */}
        {addingStepFor === partId ? (
          <div className="flex items-center gap-2 mt-1">
            <input
              type="text"
              value={newStepName}
              onChange={(e) => setNewStepName(e.target.value)}
              placeholder="Step name"
              className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-white focus:outline-none focus:border-green-600"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newStepName.trim()) {
                  setRoutingAdditions(prev => ({
                    ...prev,
                    [partId]: [...(prev[partId] || []), { stepName: newStepName.trim(), stepType: newStepType }]
                  }))
                  setNewStepName('')
                  setNewStepType('internal')
                  setAddingStepFor(null)
                } else if (e.key === 'Escape') {
                  setAddingStepFor(null)
                  setNewStepName('')
                  setNewStepType('internal')
                }
              }}
            />
            <select
              value={newStepType}
              onChange={(e) => setNewStepType(e.target.value)}
              className="px-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-white"
            >
              <option value="internal">Internal</option>
              <option value="external">External</option>
            </select>
            <button
              type="button"
              disabled={!newStepName.trim()}
              onClick={() => {
                setRoutingAdditions(prev => ({
                  ...prev,
                  [partId]: [...(prev[partId] || []), { stepName: newStepName.trim(), stepType: newStepType }]
                }))
                setNewStepName('')
                setNewStepType('internal')
                setAddingStepFor(null)
              }}
              className="px-2 py-1 bg-green-900/50 text-green-300 rounded text-xs hover:bg-green-900 disabled:opacity-50"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => { setAddingStepFor(null); setNewStepName(''); setNewStepType('internal') }}
              className="px-2 py-1 text-gray-400 text-xs hover:text-white"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAddingStepFor(partId)}
            className="flex items-center gap-1 text-xs text-green-500 hover:text-green-400 mt-1"
          >
            <Plus size={12} /> Add Step
          </button>
        )}
      </div>
    )
  }

  if (!isOpen) return null

  return (
    <div 
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div 
        className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-3xl max-h-[90vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <h2 className="text-xl font-semibold text-white">
            Create Work Order
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={24} />
          </button>
        </div>

        <div ref={modalContentRef} className="p-6 overflow-y-auto max-h-[calc(90vh-140px)]">
          {error && (
            <div className="mb-4 p-3 bg-red-900/50 border border-red-700 rounded text-red-300 text-sm">
              {error}
            </div>
          )}

          {/* Order Number (Auto-generated) */}
          <div className="mb-4">
            <label className="block text-gray-400 text-sm mb-1">
              Work Order Number
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={woNumber}
                readOnly
                className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded font-mono text-white"
              />
              {generatingWO && <Loader2 size={20} className="text-skynet-accent animate-spin" />}
            </div>
            <p className="text-gray-500 text-xs mt-1">
              Auto-generated: WO-YYMM-NNNN
            </p>
          </div>

          {/* PRODUCTION ORDER FIELDS */}
          <>
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

              {/* Products Section (Assemblies + Finished Goods) */}
              <div className="border-t border-gray-700 pt-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-white font-medium flex items-center gap-2">
                    <Package size={18} />
                    Products
                  </h3>
                  {!preselectedPartId && (
                    <button
                      type="button"
                      onClick={addAssembly}
                      disabled={loadingAssemblies}
                      className="flex items-center gap-1 px-3 py-1 text-sm bg-gray-800 hover:bg-gray-700 text-skynet-accent rounded transition-colors disabled:opacity-50"
                    >
                      <Plus size={16} />
                      Add Product
                    </button>
                  )}
                </div>

                {loadingAssemblies ? (
                  <div className="text-center py-4 text-gray-500">Loading products...</div>
                ) : assemblies.length === 0 ? (
                  <div className="text-center py-4 text-yellow-500 bg-yellow-900/20 rounded border border-yellow-800">
                    No products or finished goods found. Add them in Master Data first.
                  </div>
                ) : selectedAssemblies.length === 0 ? (
                  <div className="text-center py-8 text-gray-500 bg-gray-800/50 rounded border border-dashed border-gray-700">
                    Click "Add Product" to select a product or finished good for this work order
                  </div>
                ) : (
                  <div className="space-y-4">
                    {selectedAssemblies.map((selected, assemblyIndex) => (
                      <div key={assemblyIndex} className="bg-gray-800 rounded-lg p-4 border border-gray-700">
                        <div className="flex items-start justify-between gap-4 mb-4">
                          <div className="flex-1 grid grid-cols-[1fr_auto_auto_auto] gap-3 items-end">
                            <div className="min-w-0">
                              <label className="block text-gray-500 text-xs mb-1">Product</label>
                              {preselectedPartId && assemblyIndex === 0 ? (
                                <div className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white">
                                  <span className="font-mono">{assemblies.find(a => a.id === preselectedPartId)?.part_number}</span>
                                  <span className="text-gray-400"> — {assemblies.find(a => a.id === preselectedPartId)?.description}</span>
                                  <span className="ml-2 text-xs text-purple-300">(from demand selection)</span>
                                </div>
                              ) : (
                                <ProductCombobox
                                  value={selected.assemblyId}
                                  onChange={(id) => updateAssemblySelection(assemblyIndex, id)}
                                  assemblies={assemblies}
                                  allowManufactured={true}
                                />
                              )}
                            </div>
                            <div>
                              <label className="block text-gray-500 text-xs mb-1">Order Qty</label>
                              {(() => {
                                const allocs = coLinesByAssembly[assemblyIndex]?.allocations || {}
                                const allocSum = Object.values(allocs).reduce((s, v) => s + (v || 0), 0)
                                const fromCO = allocSum > 0
                                return (
                                  <>
                                    <input
                                      type="number"
                                      min="0"
                                      value={selected.orderQuantity}
                                      onChange={(e) => updateAssemblyQtyField(assemblyIndex, 'orderQuantity', e.target.value)}
                                      readOnly={fromCO}
                                      className={`w-20 px-3 py-2 border rounded focus:outline-none ${
                                        fromCO
                                          ? 'bg-gray-800 border-gray-700 text-gray-400 cursor-not-allowed'
                                          : 'bg-gray-700 border-gray-600 text-white focus:border-skynet-accent'
                                      }`}
                                    />
                                    {fromCO && (
                                      <div className="text-[10px] text-purple-300 mt-0.5">from selected COs</div>
                                    )}
                                  </>
                                )
                              })()}
                            </div>
                            <div>
                              <label className="block text-gray-500 text-xs mb-1">+ Stock</label>
                              <input
                                type="number"
                                min="0"
                                value={selected.additionalForStock}
                                onChange={(e) => updateAssemblyQtyField(assemblyIndex, 'additionalForStock', e.target.value)}
                                className="w-20 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:border-skynet-accent"
                              />
                            </div>
                            <div>
                              <label className="block text-gray-500 text-xs mb-1">= Total</label>
                              <div className="w-20 px-3 py-2 bg-gray-600 border border-gray-500 rounded text-white text-center">
                                {selected.orderQuantity + selected.additionalForStock}
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeAssembly(assemblyIndex)}
                            className="p-2 text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded"
                          >
                            <Trash2 size={18} />
                          </button>
                        </div>

                        {/* Pending Customer Orders for the selected part */}
                        {coLinesByAssembly[assemblyIndex]?.lines?.length > 0 && (() => {
                          const totalAllocated = Object.values(coLinesByAssembly[assemblyIndex].allocations).reduce((s, v) => s + (v || 0), 0)
                          return (
                            <div className="mt-3 pl-4 border-l-2 border-purple-500/30">
                              <div className="text-xs text-purple-300 font-semibold uppercase tracking-wide mb-2">
                                Pending Customer Orders for this Part
                              </div>
                              <div className="space-y-1">
                                {coLinesByAssembly[assemblyIndex].lines.map(line => {
                                  const allocated = coLinesByAssembly[assemblyIndex].allocations[line.line_id] ?? 0
                                  const isChecked = allocated > 0
                                  return (
                                    <div key={line.line_id} className="flex items-center gap-2 text-sm bg-gray-800/40 rounded px-2 py-1.5">
                                      <input
                                        type="checkbox"
                                        checked={isChecked}
                                        onChange={(e) => {
                                          const checked = e.target.checked
                                          setLineAllocation(assemblyIndex, line.line_id, checked ? line.remaining : 0)
                                        }}
                                        className="accent-purple-500"
                                      />
                                      <span className="font-mono text-purple-300 text-xs">{line.co_number}</span>
                                      <span className="text-gray-400">·</span>
                                      <span className="text-gray-300">{line.customer_name}</span>
                                      <span className="text-gray-500 text-xs">Line {line.line_number}</span>
                                      {line.due_date && (
                                        <span className="text-gray-500 text-xs">due {new Date(line.due_date).toLocaleDateString()}</span>
                                      )}
                                      <div className="ml-auto flex items-center gap-2">
                                        <input
                                          type="number"
                                          min="0"
                                          max={line.remaining}
                                          value={allocated}
                                          disabled={!isChecked}
                                          onChange={(e) => {
                                            const v = Math.max(0, Math.min(line.remaining, parseInt(e.target.value) || 0))
                                            setLineAllocation(assemblyIndex, line.line_id, v)
                                          }}
                                          className="w-20 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-xs disabled:opacity-40"
                                        />
                                        <span className="text-gray-500 text-xs">/ {line.remaining}</span>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                              <div className="mt-2 text-xs text-gray-400">
                                Customer Allocations: {totalAllocated.toLocaleString()}
                              </div>
                            </div>
                          )
                        })()}
                        {loadingCoLines[assemblyIndex] && (
                          <div className="mt-3 pl-4 text-xs text-gray-500">Loading customer orders…</div>
                        )}

                        {/* BOM Components (assemblies) or Finished Good indicator */}
                        {selected.assemblyId && (() => {
                          const selectedPart = getAssemblyById(selected.assemblyId)
                          const isFinishedGood = selectedPart?.part_type === 'finished_good'
                          const isManufactured = selectedPart?.part_type === 'manufactured'

                          if (isFinishedGood || isManufactured) {
                            return (
                              <div className="border-t border-gray-700 pt-3">
                                <div className="flex items-center gap-2 mb-2">
                                  {isFinishedGood ? (
                                    <span className="text-xs px-2 py-0.5 bg-emerald-900/50 text-emerald-300 rounded border border-emerald-700/50">Finished Good</span>
                                  ) : (
                                    <span className="text-xs px-2 py-0.5 bg-blue-900/50 text-blue-300 rounded border border-blue-700/50">Part</span>
                                  )}
                                  <span className="text-gray-400 text-sm">{isFinishedGood ? 'No assembly required' : 'Single part for stock'}</span>
                                </div>
                                <div className="bg-gray-900 rounded p-3">
                                  <div className="text-gray-400 text-xs mb-2">Job to Create:</div>
                                  <div className="flex items-center justify-between py-2">
                                    <div className="flex-1">
                                      <span className="text-white text-sm">{selectedPart.part_number}</span>
                                      <span className="text-gray-500 text-sm ml-2">- {selectedPart.description}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <span className="text-green-400 text-sm">
                                        {selected.orderQuantity + selected.additionalForStock} pcs
                                        {selected.additionalForStock > 0 && ` (${selected.orderQuantity} order + ${selected.additionalForStock} stock)`}
                                      </span>
                                    </div>
                                  </div>
                                  {renderRoutingSteps(selectedPart.id)}
                                </div>
                              </div>
                            )
                          }

                          return (
                          <div className="border-t border-gray-700 pt-3">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className="text-xs px-2 py-0.5 bg-purple-900/50 text-purple-300 rounded border border-purple-700/50">Product (Assembly)</span>
                                <span className="text-gray-400 text-sm">Select parts to add jobs</span>
                              </div>
                              {selected.jobs.length > 0 && (
                                <span className="text-green-400 text-xs font-medium">
                                  {selected.jobs.length} job(s) selected
                                </span>
                              )}
                            </div>
                            
                            {/* Available Parts from BOM */}
                            <div className="space-y-1 mb-3">
                              {getAssemblyById(selected.assemblyId)?.assembly_bom
                                ?.filter(bom => bom.component?.part_type !== 'assembly')
                                .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
                                .map(bom => {
                                  const isPurchased = bom.component?.part_type === 'purchased'
                                  const isAdded = selected.jobs.some(j => j.componentId === bom.component.id)

                                  if (isPurchased) {
                                    return (
                                      <div
                                        key={bom.id}
                                        className="w-full flex items-center justify-between px-3 py-2 rounded text-sm bg-gray-800 border border-gray-700 opacity-60"
                                      >
                                        <div className="flex items-center gap-2">
                                          <ShoppingCart size={14} className="text-orange-400" />
                                          <span className="text-gray-400">{bom.component.part_number}</span>
                                          <span className="text-gray-600">- {bom.component.description}</span>
                                        </div>
                                        <span className="text-xs px-2 py-0.5 bg-orange-900/40 text-orange-400 rounded border border-orange-800/50">
                                          📦 Part (Purchased)
                                        </span>
                                      </div>
                                    )
                                  }

                                  return (
                                    <button
                                      key={bom.id}
                                      type="button"
                                      onClick={() => !isAdded && addJobFromBOM(assemblyIndex, bom)}
                                      disabled={isAdded}
                                      className={`w-full flex items-center justify-between px-3 py-2 rounded text-sm transition-colors ${
                                        isAdded
                                          ? 'bg-green-900/30 text-green-400 border border-green-700'
                                          : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                                      }`}
                                    >
                                      <div className="flex items-center gap-2">
                                        <Wrench size={14} className="text-gray-500" />
                                        <span>{bom.component.part_number}</span>
                                        <span className="text-gray-500">- {bom.component.description}</span>
                                      </div>
                                      <div className="flex items-center gap-2">
                                        <span className="text-gray-500">×{bom.quantity}</span>
                                        {isAdded ? (
                                          <span className="text-green-400">✓ Added</span>
                                        ) : (
                                          <ChevronRight size={16} className="text-gray-500" />
                                        )}
                                      </div>
                                    </button>
                                  )
                                })}
                            </div>

                            {/* Selected Jobs */}
                            {selected.jobs.length > 0 && (
                              <div className="bg-gray-900 rounded p-3">
                                <div className="text-gray-400 text-xs mb-2">Jobs to Create:</div>
                                {selected.jobs.map(job => (
                                  <div key={job.componentId} className="py-2 border-b border-gray-800 last:border-0">
                                    <div className="flex items-center justify-between">
                                      <div className="flex-1">
                                        <span className="text-white text-sm">{job.partNumber}</span>
                                        <span className="text-gray-500 text-sm ml-2">- {job.description}</span>
                                      </div>
                                      <div className="flex items-center gap-2">
                                        <input
                                          type="number"
                                          min="1"
                                          value={job.quantity}
                                          onChange={(e) => updateJobQuantity(assemblyIndex, job.componentId, parseInt(e.target.value) || 1)}
                                          className="w-20 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm text-center"
                                        />
                                        <span className="text-gray-500 text-sm">pcs</span>
                                        {!job.quantityCustomized && selected.additionalForStock > 0 && (
                                          <span className="text-gray-500 text-xs">({selected.orderQuantity} order + {selected.additionalForStock} stock)</span>
                                        )}
                                        <button
                                          type="button"
                                          onClick={() => removeJob(assemblyIndex, job.componentId)}
                                          className="text-red-400 hover:text-red-300"
                                        >
                                          <Trash2 size={14} />
                                        </button>
                                      </div>
                                    </div>
                                    {renderRoutingSteps(job.componentId)}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          )
                        })()}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
        </div>

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
              type="button"
              onClick={handleSubmit}
              disabled={
                loading || 
                totalJobs === 0
              }
              className="px-6 py-2 font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-skynet-accent hover:bg-blue-600 text-white"
            >
              {loading ? 'Creating...' : 'Create Work Order'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}