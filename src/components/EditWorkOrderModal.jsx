import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { X, Loader2, Plus, Trash2, ChevronDown, ChevronRight, Package, Wrench, AlertTriangle, ShoppingCart, Save } from 'lucide-react'
import { summarizeWOAllocations, formatWODueDate } from '../lib/workOrderDisplay'
import CustomerDisplay from './CustomerDisplay'

const ALLOC_GATE_ROLES = ['admin', 'scheduler']

let tempAllocSeq = 0
const nextTempAllocId = () => `new-alloc-${++tempAllocSeq}`

export default function EditWorkOrderModal({ isOpen, onClose, workOrder, onSuccess, profile }) {
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

  // CO allocation editing (Batch B of previous prompt)
  const [allocations, setAllocations] = useState([])                          // active allocs from DB, with join data
  const [allocationsToDeactivate, setAllocationsToDeactivate] = useState([])  // ids of existing rows to flip is_active=false
  const [newAllocations, setNewAllocations] = useState([])                    // staged adds, with display fields
  const [eligibleLines, setEligibleLines] = useState([])                      // CO lines available to add
  const [showAddCO, setShowAddCO] = useState(false)
  const [addCoQty, setAddCoQty] = useState({})                                // { lineId: qtyString }
  const [addCoError, setAddCoError] = useState({})                            // { lineId: errStr }

  // Add-component-to-existing-product (Batch B of this prompt)
  const [newComponents, setNewComponents] = useState([])
  const [showAddCompFor, setShowAddCompFor] = useState(null) // assemblyIndex or null
  // BOM components per assembly, lazy-loaded the first time the user opens
  // the picker on that assembly. Shape: { [assemblyId]: [{ id, part_number, description, bom_qty }] }
  const [bomComponentsByAssembly, setBomComponentsByAssembly] = useState({})

  const canEditAllocations = ALLOC_GATE_ROLES.includes(profile?.role)

  useEffect(() => {
    if (isOpen && workOrder) {
      loadWorkOrder()
      fetchAvailableParts()
    }
  }, [isOpen, workOrder])

  // Lazy load: pull BOM components for an assembly the first time the user
  // opens the Add Component picker on it. Cached per assemblyId for the
  // lifetime of the modal.
  const loadBOMComponents = async (assemblyId) => {
    if (!assemblyId || bomComponentsByAssembly[assemblyId]) return
    const { data, error } = await supabase
      .from('assembly_bom')
      .select(`
        quantity,
        component:parts!assembly_bom_component_id_fkey (
          id, part_number, description, part_type
        )
      `)
      .eq('assembly_id', assemblyId)
      .order('sort_order', { ascending: true })

    if (error) {
      console.error('Failed to load BOM components:', error)
      setBomComponentsByAssembly(prev => ({ ...prev, [assemblyId]: [] }))
      return
    }

    const components = (data || [])
      .filter(row => row.component && row.component.part_type === 'manufactured')
      .map(row => ({
        id: row.component.id,
        part_number: row.component.part_number,
        description: row.component.description,
        bom_qty: row.quantity,
      }))
    setBomComponentsByAssembly(prev => ({ ...prev, [assemblyId]: components }))
  }

  const loadWorkOrder = async () => {
    setCustomer(workOrder.customer || '')
    setDueDate(workOrder.due_date || '')
    setPriority(workOrder.priority || 'normal')
    setError('')
    setNewAssemblies([])
    setShowAddProduct(false)
    setAllocations([])
    setAllocationsToDeactivate([])
    setNewAllocations([])
    setEligibleLines([])
    setShowAddCO(false)
    setAddCoQty({})
    setAddCoError({})
    setNewComponents([])
    setShowAddCompFor(null)
    setBomComponentsByAssembly({})

    // Build existing assemblies with their jobs
    const woStockQty = workOrder.stock_quantity || 0
    const woAssemblies = workOrder.work_order_assemblies || []

    // Defensive re-fetch — upstream queries don't reliably include
    // component_id, which the Add Component picker needs to filter
    // out parts already on the assembly.
    const { data: freshJobs, error: jobsErr } = await supabase
      .from('jobs')
      .select(`
        id, job_number, work_order_assembly_id, quantity, status, component_id,
        component:parts!jobs_component_id_fkey (
          id, part_number, description
        )
      `)
      .eq('work_order_id', workOrder.id)

    if (jobsErr) {
      console.error('Failed to refetch jobs for edit modal:', jobsErr)
    }

    const jobsByWoa = new Map()
    for (const j of freshJobs || []) {
      const arr = jobsByWoa.get(j.work_order_assembly_id) || []
      arr.push(j)
      jobsByWoa.set(j.work_order_assembly_id, arr)
    }

    const assemblies = woAssemblies.map((woa, idx) => {
      const jobs = jobsByWoa.get(woa.id) || (workOrder.jobs || []).filter(j => j.work_order_assembly_id === woa.id)
      // Derive per-assembly stock split: for single-assembly WOs assign all stock_quantity;
      // for multi-assembly WOs assign stock to first assembly (pragmatic default)
      const stockForThis = idx === 0 ? woStockQty : 0
      const orderQty = Math.max(1, woa.quantity - stockForThis)
      const additionalStock = woa.quantity - orderQty
      return {
        woaId: woa.id,
        assemblyId: woa.assembly?.id,
        partNumber: woa.assembly?.part_number || 'Unknown',
        description: woa.assembly?.description || '',
        quantity: woa.quantity,
        orderQuantity: orderQty,
        additionalForStock: additionalStock,
        originalQuantity: woa.quantity,
        originalOrderQuantity: orderQty,
        originalAdditionalForStock: additionalStock,
        status: woa.status,
        jobs: jobs.map(j => ({
          id: j.id,
          jobNumber: j.job_number,
          componentId: j.component?.id || j.component_id || null,
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

    if (!canEditAllocations) return

    // Fetch active allocations on this WO
    const { data: allocs, error: allocErr } = await supabase
      .from('customer_order_allocations')
      .select(`
        id, quantity_allocated, customer_order_line_id,
        customer_order_lines (
          id, line_number, due_date, quantity_ordered, quantity_fulfilled,
          part_id,
          parts ( id, part_number, description ),
          customer_orders ( co_number, customers ( id, name ) )
        )
      `)
      .eq('work_order_id', workOrder.id)
      .eq('is_active', true)
    if (allocErr) {
      console.error('Failed to load allocations:', allocErr)
      return
    }
    setAllocations(allocs || [])

    // Fetch eligible CO lines: any line with remaining > 0 whose part_id matches
    // any assembly part on this WO, status not cancelled/complete.
    const partIds = (woAssemblies || [])
      .map(woa => woa.assembly?.id)
      .filter(Boolean)
    if (partIds.length === 0) return

    const { data: candidateLines, error: linesErr } = await supabase
      .from('customer_order_lines')
      .select(`
        id, line_number, due_date, quantity_ordered, quantity_fulfilled, part_id, status,
        parts ( id, part_number, description ),
        customer_orders!inner ( id, co_number, status, customers ( id, name ) )
      `)
      .in('part_id', partIds)
      .in('status', ['not_started', 'in_progress'])
    if (linesErr) {
      console.error('Failed to load eligible CO lines:', linesErr)
      return
    }

    const filteredLines = (candidateLines || []).filter(
      l => l.customer_orders?.status !== 'cancelled'
    )
    const lineIds = filteredLines.map(l => l.id)
    let allocSumByLine = new Map()
    if (lineIds.length > 0) {
      const { data: allLineAllocs, error: alErr } = await supabase
        .from('customer_order_allocations')
        .select('customer_order_line_id, quantity_allocated, work_order_id, is_active')
        .in('customer_order_line_id', lineIds)
        .eq('is_active', true)
      if (alErr) {
        console.error('Failed to compute remaining on eligible lines:', alErr)
      } else {
        for (const a of allLineAllocs || []) {
          allocSumByLine.set(
            a.customer_order_line_id,
            (allocSumByLine.get(a.customer_order_line_id) || 0) + (Number(a.quantity_allocated) || 0),
          )
        }
      }
    }

    // Hide lines whose remaining demand is fully soaked up by allocations to THIS WO
    // (those rows already render in the existing-allocations section).
    const thisWoAllocByLine = new Map()
    for (const a of allocs || []) {
      thisWoAllocByLine.set(
        a.customer_order_line_id,
        (thisWoAllocByLine.get(a.customer_order_line_id) || 0) + (Number(a.quantity_allocated) || 0),
      )
    }

    const eligibles = filteredLines.map(l => {
      const ordered = Number(l.quantity_ordered) || 0
      const fulfilled = Number(l.quantity_fulfilled) || 0
      const totalAllocated = allocSumByLine.get(l.id) || 0
      const remaining = Math.max(0, ordered - fulfilled - totalAllocated)
      const allocatedToThisWo = thisWoAllocByLine.get(l.id) || 0
      return {
        line_id: l.id,
        line_number: l.line_number,
        part_id: l.part_id,
        part_number: l.parts?.part_number || '—',
        co_number: l.customer_orders?.co_number || '',
        customer_name: l.customer_orders?.customers?.name || '',
        due_date: l.due_date || null,
        remaining,
        allocatedToThisWo,
      }
    }).filter(l => l.remaining > 0 && l.allocatedToThisWo === 0)

    eligibles.sort((a, b) => {
      const ad = a.due_date || '9999-12-31'
      const bd = b.due_date || '9999-12-31'
      if (ad !== bd) return ad < bd ? -1 : 1
      return (a.co_number || '').localeCompare(b.co_number || '')
    })

    setEligibleLines(eligibles)
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
        is_active,
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
      .order('part_number')

    if (!error) setAvailableParts(data || [])
    setLoadingParts(false)
  }

  // ── Allocation handlers (Batch B) ─────────────────────────────────────────

  // Find existing-assembly index by part_id; returns -1 if not found.
  const findAssemblyIdxByPartId = (partId) =>
    existingAssemblies.findIndex(a => a.assemblyId === partId)

  // Status set that locks allocation editing for a given assembly row.
  const isAssemblyAllocLocked = (assembly) =>
    !!assembly && assembly.status && assembly.status !== 'pending'

  // Add allocation (option-b math): try to reduce stock first; bump total only on shortfall.
  const handleAddAllocation = (line) => {
    setAddCoError(prev => ({ ...prev, [line.line_id]: null }))
    const qty = parseInt(addCoQty[line.line_id], 10)
    if (!Number.isFinite(qty) || qty <= 0) {
      setAddCoError(prev => ({ ...prev, [line.line_id]: 'Enter a positive quantity.' }))
      return
    }
    if (qty > line.remaining) {
      setAddCoError(prev => ({ ...prev, [line.line_id]: `Max ${line.remaining}.` }))
      return
    }
    const woaIdx = findAssemblyIdxByPartId(line.part_id)
    if (woaIdx < 0) {
      setAddCoError(prev => ({ ...prev, [line.line_id]: 'Matching product row not found.' }))
      return
    }
    const assembly = existingAssemblies[woaIdx]
    if (isAssemblyAllocLocked(assembly)) {
      setAddCoError(prev => ({ ...prev, [line.line_id]: 'Production started — allocations locked.' }))
      return
    }

    let shortfall = 0
    setExistingAssemblies(prev => {
      const updated = [...prev]
      const a = { ...updated[woaIdx] }
      const currentStock = a.additionalForStock || 0
      if (currentStock >= qty) {
        a.additionalForStock = currentStock - qty
        a.orderQuantity = (a.orderQuantity || 0) + qty
      } else {
        shortfall = qty - currentStock
        a.additionalForStock = 0
        a.orderQuantity = (a.orderQuantity || 0) + qty
      }
      a.quantity = a.orderQuantity + a.additionalForStock
      updated[woaIdx] = a
      return updated
    })

    setNewAllocations(prev => [...prev, {
      tempId: nextTempAllocId(),
      lineId: line.line_id,
      woaIndex: woaIdx,
      partId: line.part_id,
      partNumber: line.part_number,
      coNumber: line.co_number,
      customerName: line.customer_name,
      lineNumber: line.line_number,
      dueDate: line.due_date,
      qty,
      lineRemaining: line.remaining,
      shortfall,
    }])

    // Remove or shrink the line in eligibleLines
    setEligibleLines(prev =>
      prev
        .map(l => l.line_id === line.line_id ? { ...l, remaining: l.remaining - qty } : l)
        .filter(l => l.remaining > 0)
    )
    setAddCoQty(prev => ({ ...prev, [line.line_id]: '' }))
  }

  // Remove an existing (already-saved) allocation: queue id for deactivation,
  // hide from local view, return qty to stock on the matching assembly.
  const handleRemoveExistingAllocation = (alloc) => {
    if (allocationsToDeactivate.includes(alloc.id)) return
    const partId = alloc.customer_order_lines?.part_id
    const woaIdx = findAssemblyIdxByPartId(partId)
    if (woaIdx >= 0) {
      const assembly = existingAssemblies[woaIdx]
      if (isAssemblyAllocLocked(assembly)) {
        // Defensive guard — UI should hide the trash on locked rows
        return
      }
      setExistingAssemblies(prev => {
        const updated = [...prev]
        const a = { ...updated[woaIdx] }
        const qty = Number(alloc.quantity_allocated) || 0
        a.orderQuantity = Math.max(1, (a.orderQuantity || 0) - qty)
        a.additionalForStock = (a.additionalForStock || 0) + qty
        a.quantity = a.orderQuantity + a.additionalForStock
        updated[woaIdx] = a
        return updated
      })
    }
    setAllocationsToDeactivate(prev => [...prev, alloc.id])
    setAllocations(prev => prev.filter(a => a.id !== alloc.id))
  }

  // Remove a not-yet-saved allocation: pop from list, reverse the math.
  const handleRemoveNewAllocation = (tempId) => {
    const ent = newAllocations.find(n => n.tempId === tempId)
    if (!ent) return
    setExistingAssemblies(prev => {
      const updated = [...prev]
      const a = { ...updated[ent.woaIndex] }
      const qty = ent.qty
      a.orderQuantity = Math.max(1, (a.orderQuantity || 0) - qty)
      a.additionalForStock = (a.additionalForStock || 0) + qty
      a.quantity = a.orderQuantity + a.additionalForStock
      updated[ent.woaIndex] = a
      return updated
    })
    setNewAllocations(prev => prev.filter(n => n.tempId !== tempId))
  }

  // Live summary that includes existing + new (unsaved) allocations and excludes
  // the queued-for-deactivation set. Used for Customer/Due read-only displays.
  const liveAllocationSummary = useMemo(() => {
    const existingShape = (allocations || []).map(a => ({
      customer_order_lines: a.customer_order_lines,
    }))
    const stagedShape = (newAllocations || []).map(n => ({
      customer_order_lines: {
        due_date: n.dueDate,
        customer_orders: {
          co_number: n.coNumber,
          customers: { id: `staged-${n.lineId}`, name: n.customerName },
        },
      },
    }))
    return summarizeWOAllocations([...existingShape, ...stagedShape])
  }, [allocations, newAllocations])

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
      orderQuantity: 1,
      additionalForStock: 0,
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
        quantity: assembly.orderQuantity + assembly.additionalForStock
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
    if (newAllocations.length > 0) return true
    if (allocationsToDeactivate.length > 0) return true
    if (newComponents.length > 0) return true
    for (const a of existingAssemblies) {
      if (a.orderQuantity !== a.originalOrderQuantity) return true
      if (a.additionalForStock !== a.originalAdditionalForStock) return true
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
      const totalAdditionalForStock = [...existingAssemblies, ...newAssemblies].reduce(
        (sum, a) => sum + (parseInt(a.additionalForStock) || 0), 0
      )
      const newStockQty = totalAdditionalForStock || null
      if (newStockQty !== workOrder.stock_quantity) woUpdates.stock_quantity = newStockQty

      if (Object.keys(woUpdates).length > 0) {
        const { error: woErr } = await supabase
          .from('work_orders')
          .update(woUpdates)
          .eq('id', workOrder.id)
        if (woErr) throw woErr
      }

      // 2. Update existing assembly quantities
      for (const assembly of existingAssemblies) {
        const currentTotal = assembly.orderQuantity + assembly.additionalForStock
        if (currentTotal !== assembly.originalQuantity || assembly.orderQuantity !== assembly.originalOrderQuantity || assembly.additionalForStock !== assembly.originalAdditionalForStock) {
          const isMTS = workOrder.order_type === 'make_to_stock'
          const { error: woaErr } = await supabase
            .from('work_order_assemblies')
            .update({
              quantity: currentTotal,
              order_quantity: isMTS ? null : assembly.orderQuantity || null,
              stock_quantity: assembly.additionalForStock || null
            })
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
		
        for (const assembly of newAssemblies) {
          // Create WOA record
          const isMTS = workOrder.order_type === 'make_to_stock'
          const { data: woaData, error: woaErr } = await supabase
            .from('work_order_assemblies')
            .insert({
              work_order_id: workOrder.id,
              assembly_id: assembly.assemblyId,
              quantity: assembly.orderQuantity + assembly.additionalForStock,
              order_quantity: isMTS ? null : assembly.orderQuantity || null,
              stock_quantity: assembly.additionalForStock || null,
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

      // 4. Insert new CO allocations (Batch B). Triggers will roll up CO line/header status.
      if (newAllocations.length > 0) {
        const allocRows = newAllocations.map(n => ({
          customer_order_line_id: n.lineId,
          work_order_id: workOrder.id,
          quantity_allocated: n.qty,
          created_by: profile?.id || null,
        }))
        const { error: allocErr } = await supabase
          .from('customer_order_allocations')
          .insert(allocRows)
        if (allocErr) throw allocErr
      }

      // 5. Deactivate existing CO allocations queued for removal.
      if (allocationsToDeactivate.length > 0) {
        const { error: deactErr } = await supabase
          .from('customer_order_allocations')
          .update({
            is_active: false,
            deactivated_at: new Date().toISOString(),
            deactivated_by: profile?.id || null,
          })
          .in('id', allocationsToDeactivate)
        if (deactErr) throw deactErr
      }

      // 6. Insert new components into existing assemblies (Batch B).
      // Mirrors CreateWorkOrderModal: INSERT into jobs in pending_compliance,
      // then copy part_routing_steps → job_routing_steps for each new job.
      if (newComponents.length > 0) {
        // Compute the next J-###### number once and increment as we insert.
        const { data: prodJobs } = await supabase
          .from('jobs')
          .select('job_number')
          .like('job_number', 'J-%')
        let nextJobNum = 1
        if (prodJobs && prodJobs.length > 0) {
          const jobNumbers = prodJobs
            .map(j => {
              const m = j.job_number.match(/^J-(\d+)$/)
              return m ? parseInt(m[1], 10) : 0
            })
            .filter(n => !isNaN(n) && n > 0)
          if (jobNumbers.length > 0) nextJobNum = Math.max(...jobNumbers) + 1
        }

        for (const nc of newComponents) {
          const { data: newJob, error: jobInsErr } = await supabase
            .from('jobs')
            .insert({
              job_number: `J-${String(nextJobNum++).padStart(6, '0')}`,
              work_order_id: workOrder.id,
              work_order_assembly_id: nc.woaId,
              component_id: nc.componentId,
              quantity: nc.quantity,
              status: 'pending_compliance',
              is_maintenance: false,
            })
            .select('id')
            .single()
          if (jobInsErr) throw jobInsErr

          // Copy part_routing_steps → job_routing_steps for this new job
          const { data: partRouting, error: prErr } = await supabase
            .from('part_routing_steps')
            .select('*')
            .eq('part_id', nc.componentId)
            .eq('is_active', true)
            .order('step_order')
          if (prErr) throw prErr

          if ((partRouting?.length || 0) > 0) {
            const jobSteps = partRouting.map(step => ({
              job_id: newJob.id,
              step_order: step.step_order,
              step_name: step.step_name,
              step_type: step.step_type,
              station: step.default_station,
              status: 'pending',
            }))
            const { error: stepsErr } = await supabase
              .from('job_routing_steps')
              .insert(jobSteps)
            if (stepsErr) throw stepsErr
          }
        }

        setNewComponents([])
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
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-gray-400 text-sm mb-1">Customer</label>
              {liveAllocationSummary.hasAllocations ? (
                <div className="w-full px-3 py-2 bg-gray-800/60 border border-gray-700 rounded text-gray-300">
                  <CustomerDisplay summary={liveAllocationSummary} fallback={customer} />
                </div>
              ) : (
                <input
                  type="text"
                  value={customer}
                  onChange={e => setCustomer(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded text-white focus:border-skynet-accent focus:outline-none"
                />
              )}
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1">Due Date</label>
              {liveAllocationSummary.hasAllocations ? (
                <div className="w-full px-3 py-2 bg-gray-800/60 border border-gray-700 rounded text-gray-300 flex items-center gap-2">
                  <span>{formatWODueDate(liveAllocationSummary, workOrder.due_date) || '—'}</span>
                  {liveAllocationSummary.hasMultipleDueDates && (
                    <span className="text-xs text-gray-500">(earliest)</span>
                  )}
                </div>
              ) : (
                <input
                  type="date"
                  value={dueDate}
                  onChange={e => setDueDate(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded text-white focus:border-skynet-accent focus:outline-none"
                />
              )}
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

          {/* Customer Orders section (admin/scheduler only) */}
          {canEditAllocations && (
            <div className="border-t border-gray-700 pt-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Customer Orders</h3>
                {!showAddCO && (
                  <button
                    type="button"
                    onClick={() => setShowAddCO(true)}
                    className="flex items-center gap-1 px-3 py-1 text-xs bg-purple-900/40 hover:bg-purple-900/60 text-purple-200 border border-purple-500/30 rounded"
                  >
                    <Plus size={12} /> Add Customer Order
                  </button>
                )}
              </div>

              {allocations.length === 0 && newAllocations.length === 0 && !showAddCO && (
                <div className="text-xs text-gray-500 italic mb-2">
                  No customer order allocations on this work order.
                </div>
              )}

              {/* Existing allocations */}
              {allocations.map(a => {
                const line = a.customer_order_lines
                const partId = line?.part_id
                const woaIdx = findAssemblyIdxByPartId(partId)
                const assembly = woaIdx >= 0 ? existingAssemblies[woaIdx] : null
                const locked = isAssemblyAllocLocked(assembly)
                return (
                  <div key={a.id} className="flex items-center gap-3 px-3 py-2 mb-1 bg-gray-800/40 border border-gray-700 rounded text-sm">
                    <span className="font-mono text-purple-300 text-xs">{line?.customer_orders?.co_number || '—'}</span>
                    <span className="text-gray-500">·</span>
                    <span className="text-gray-300">{line?.customer_orders?.customers?.name || '—'}</span>
                    <span className="text-gray-500 text-xs">Line {line?.line_number}</span>
                    <span className="text-gray-500">·</span>
                    <span className="font-mono text-gray-300 text-xs">{line?.parts?.part_number || '—'}</span>
                    <span className="ml-auto font-mono text-gray-200">{a.quantity_allocated} pcs</span>
                    {line?.due_date && (
                      <span className="text-gray-500 text-xs">due {line.due_date}</span>
                    )}
                    {locked ? (
                      <span className="text-xs text-gray-600" title="Production started — allocations locked">🔒</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleRemoveExistingAllocation(a)}
                        className="p-1 text-red-400 hover:bg-red-900/30 rounded"
                        title="Remove allocation"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                )
              })}

              {/* New (unsaved) allocations */}
              {newAllocations.map(n => (
                <div key={n.tempId} className="flex items-center gap-3 px-3 py-2 mb-1 bg-purple-900/10 border border-purple-700/30 rounded text-sm">
                  <span className="font-mono text-purple-300 text-xs">{n.coNumber}</span>
                  <span className="text-gray-500">·</span>
                  <span className="text-gray-300">{n.customerName}</span>
                  <span className="text-gray-500 text-xs">Line {n.lineNumber}</span>
                  <span className="text-gray-500">·</span>
                  <span className="font-mono text-gray-300 text-xs">{n.partNumber}</span>
                  <span className="text-[10px] px-1.5 py-0.5 bg-purple-900/40 text-purple-300 rounded">unsaved</span>
                  {n.shortfall > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-amber-900/40 text-amber-300 rounded" title="Total grew to absorb shortfall">
                      Total +{n.shortfall}
                    </span>
                  )}
                  <span className="ml-auto font-mono text-gray-200">{n.qty} pcs</span>
                  {n.dueDate && (
                    <span className="text-gray-500 text-xs">due {n.dueDate}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRemoveNewAllocation(n.tempId)}
                    className="p-1 text-red-400 hover:bg-red-900/30 rounded"
                    title="Discard staged allocation"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}

              {/* Inline picker */}
              {showAddCO && (
                <div className="mt-2 border border-purple-500/30 rounded">
                  <div className="px-3 py-2 bg-purple-900/10 flex items-center justify-between">
                    <span className="text-xs text-purple-300 uppercase tracking-wider">Eligible CO lines</span>
                    <button
                      type="button"
                      onClick={() => { setShowAddCO(false); setAddCoQty({}); setAddCoError({}) }}
                      className="text-gray-400 hover:text-white"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <div className="max-h-56 overflow-y-auto">
                    {eligibleLines.length === 0 ? (
                      <div className="p-3 text-xs text-gray-500 italic">
                        No eligible CO lines for the parts on this work order.
                      </div>
                    ) : eligibleLines.map(line => {
                      const woaIdx = findAssemblyIdxByPartId(line.part_id)
                      const assembly = woaIdx >= 0 ? existingAssemblies[woaIdx] : null
                      const locked = isAssemblyAllocLocked(assembly)
                      const err = addCoError[line.line_id]
                      return (
                        <div key={line.line_id} className={`px-3 py-2 border-t border-gray-800 text-sm flex items-center gap-2 ${locked ? 'opacity-50' : ''}`}>
                          <span className="font-mono text-purple-300 text-xs">{line.co_number}</span>
                          <span className="text-gray-500">·</span>
                          <span className="text-gray-300 text-xs">{line.customer_name}</span>
                          <span className="text-gray-500 text-xs">L{line.line_number}</span>
                          <span className="text-gray-500">·</span>
                          <span className="font-mono text-gray-300 text-xs">{line.part_number}</span>
                          <span className="ml-auto text-amber-300 text-xs font-mono">{line.remaining} remaining</span>
                          {line.due_date && (
                            <span className="text-gray-500 text-xs">due {line.due_date}</span>
                          )}
                          <input
                            type="number"
                            min="1"
                            max={line.remaining}
                            placeholder="Qty"
                            value={addCoQty[line.line_id] || ''}
                            onChange={(e) => setAddCoQty(prev => ({ ...prev, [line.line_id]: e.target.value }))}
                            disabled={locked}
                            className="w-20 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-xs disabled:opacity-40"
                          />
                          <button
                            type="button"
                            disabled={locked}
                            onClick={() => handleAddAllocation(line)}
                            title={locked ? 'Production started — allocations locked.' : undefined}
                            className="px-2 py-1 text-xs bg-purple-700 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded"
                          >
                            Add
                          </button>
                          {err && (
                            <span className="text-[10px] text-red-300 ml-1">{err}</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

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
                  <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center gap-1">
                      <label className="text-xs text-gray-500">Order:</label>
                      <input
                        type="number"
                        min="1"
                        value={assembly.orderQuantity}
                        onChange={e => {
                          const updated = [...existingAssemblies]
                          updated[aIdx].orderQuantity = Math.max(1, parseInt(e.target.value) || 0)
                          updated[aIdx].quantity = updated[aIdx].orderQuantity + updated[aIdx].additionalForStock
                          setExistingAssemblies(updated)
                        }}
                        disabled={!allEditable}
                        className={`w-16 px-2 py-1 bg-gray-800 border rounded text-white text-sm text-center focus:border-skynet-accent focus:outline-none ${
                          allEditable ? 'border-gray-600' : 'border-gray-700 text-gray-500 cursor-not-allowed'
                        }`}
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <label className="text-xs text-gray-500">+ Stock:</label>
                      <input
                        type="number"
                        min="0"
                        value={assembly.additionalForStock}
                        onChange={e => {
                          const updated = [...existingAssemblies]
                          updated[aIdx].additionalForStock = Math.max(0, parseInt(e.target.value) || 0)
                          updated[aIdx].quantity = updated[aIdx].orderQuantity + updated[aIdx].additionalForStock
                          setExistingAssemblies(updated)
                        }}
                        disabled={!allEditable}
                        className={`w-16 px-2 py-1 bg-gray-800 border rounded text-white text-sm text-center focus:border-skynet-accent focus:outline-none ${
                          allEditable ? 'border-gray-600' : 'border-gray-700 text-gray-500 cursor-not-allowed'
                        }`}
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <label className="text-xs text-gray-500">=</label>
                      <div className="w-16 px-2 py-1 bg-gray-600 border border-gray-500 rounded text-white text-sm text-center">
                        {assembly.orderQuantity + assembly.additionalForStock}
                      </div>
                    </div>
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

                    {/* Newly-added (unsaved) components for THIS assembly */}
                    {newComponents.filter(nc => nc.assemblyIndex === aIdx).map(nc => (
                      <div key={nc.tempId} className="px-4 py-2 pl-10 flex items-center justify-between bg-purple-900/10 border-t border-purple-700/30">
                        <div className="flex items-center gap-3">
                          <Wrench size={12} className="text-purple-400" />
                          <div>
                            <span className="text-purple-300 text-sm font-mono">{nc.componentPartNumber}</span>
                            <span className="text-[10px] ml-2 px-1.5 py-0.5 bg-purple-900/40 text-purple-300 rounded">unsaved</span>
                            <p className="text-xs text-gray-500">{nc.componentDescription}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-sm text-gray-300 font-mono">{nc.quantity} pcs</span>
                          <button
                            type="button"
                            onClick={() => setNewComponents(prev => prev.filter(n => n.tempId !== nc.tempId))}
                            className="p-1 text-red-400 hover:bg-red-900/30 rounded"
                            title="Discard new component"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}

                    {/* Add Component (admin/scheduler only) */}
                    {canEditAllocations && (
                      <div className="px-4 py-2 pl-10 border-t border-gray-800">
                        {showAddCompFor === aIdx ? (
                          <AddComponentInlineForm
                            parts={bomComponentsByAssembly[assembly.assemblyId] || []}
                            bomLoaded={Array.isArray(bomComponentsByAssembly[assembly.assemblyId])}
                            existingComponentIds={[
                              ...assembly.jobs.map(j => j.componentId).filter(Boolean),
                            ]}
                            defaultQty={assembly.quantity}
                            onAdd={(componentId, qty) => {
                              const list = bomComponentsByAssembly[assembly.assemblyId] || []
                              const part = list.find(p => p.id === componentId)
                              setNewComponents(prev => [...prev, {
                                tempId: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                                assemblyIndex: aIdx,
                                woaId: assembly.woaId,
                                componentId,
                                componentPartNumber: part?.part_number,
                                componentDescription: part?.description,
                                quantity: qty,
                              }])
                              setShowAddCompFor(null)
                            }}
                            onCancel={() => setShowAddCompFor(null)}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              loadBOMComponents(assembly.assemblyId)
                              setShowAddCompFor(aIdx)
                            }}
                            className="text-xs text-skynet-accent hover:text-blue-400 inline-flex items-center gap-1"
                          >
                            <Plus size={12} /> Add Component
                          </button>
                        )}
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
                <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center gap-1">
                    <label className="text-xs text-gray-500">Order:</label>
                    <input
                      type="number"
                      min="1"
                      value={assembly.orderQuantity}
                      onChange={e => {
                        const updated = [...newAssemblies]
                        updated[aIdx].orderQuantity = Math.max(1, parseInt(e.target.value) || 0)
                        const total = updated[aIdx].orderQuantity + updated[aIdx].additionalForStock
                        updated[aIdx].quantity = total
                        updated[aIdx].jobs.forEach(j => j.quantity = total)
                        setNewAssemblies(updated)
                      }}
                      className="w-16 px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-sm text-center focus:border-skynet-accent focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <label className="text-xs text-gray-500">+ Stock:</label>
                    <input
                      type="number"
                      min="0"
                      value={assembly.additionalForStock}
                      onChange={e => {
                        const updated = [...newAssemblies]
                        updated[aIdx].additionalForStock = Math.max(0, parseInt(e.target.value) || 0)
                        const total = updated[aIdx].orderQuantity + updated[aIdx].additionalForStock
                        updated[aIdx].quantity = total
                        updated[aIdx].jobs.forEach(j => j.quantity = total)
                        setNewAssemblies(updated)
                      }}
                      className="w-16 px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-sm text-center focus:border-skynet-accent focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <label className="text-xs text-gray-500">=</label>
                    <div className="w-16 px-2 py-1 bg-gray-600 border border-gray-500 rounded text-white text-sm text-center">
                      {assembly.orderQuantity + assembly.additionalForStock}
                    </div>
                  </div>
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
                                <span className="text-xs px-2 py-0.5 bg-orange-900/40 text-orange-400 rounded">Part (Purchased)</span>
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
                        <div className="px-4 py-1.5 bg-gray-800/30 text-xs text-gray-500 font-medium uppercase">Products (Assembly)</div>
                        {addableParts.filter(p => p.part_type === 'assembly').map(part => (
                          <button
                            key={part.id}
                            onClick={() => handleSelectNewProduct(part)}
                            disabled={!part.is_active}
                            title={!part.is_active ? 'Pending master data — not yet activated' : undefined}
                            className={`w-full px-4 py-2 flex items-center justify-between transition-colors text-left ${
                              !part.is_active
                                ? 'opacity-50 cursor-not-allowed italic'
                                : 'hover:bg-gray-800/50'
                            }`}
                          >
                            <div>
                              <span className={`font-mono text-sm ${part.is_active ? 'text-skynet-accent' : 'text-gray-400'}`}>
                                {part.part_number}{!part.is_active ? ' — Pending Master Data' : ''}
                              </span>
                              <p className="text-xs text-gray-500">{part.description}</p>
                            </div>
                            <span className="text-xs text-gray-600">
                              {(part.assembly_bom || []).filter(b => b.component?.part_type !== 'purchased' && b.component?.part_type !== 'assembly').length} parts
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
                            disabled={!part.is_active}
                            title={!part.is_active ? 'Pending master data — not yet activated' : undefined}
                            className={`w-full px-4 py-2 flex items-center justify-between transition-colors text-left ${
                              !part.is_active
                                ? 'opacity-50 cursor-not-allowed italic'
                                : 'hover:bg-gray-800/50'
                            }`}
                          >
                            <div>
                              <span className={`font-mono text-sm ${part.is_active ? 'text-amber-400' : 'text-gray-400'}`}>
                                {part.part_number}{!part.is_active ? ' — Pending Master Data' : ''}
                              </span>
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

// Inline component picker for "Add Component" under an existing assembly.
// Searchable filter over part_number / description. Components already
// present in the assembly's job list are excluded from the dropdown.
function AddComponentInlineForm({ parts, bomLoaded = true, existingComponentIds, defaultQty, onAdd, onCancel }) {
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [qty, setQty] = useState(String(defaultQty || 1))

  const visibleParts = useMemo(
    () => parts.filter(p => !existingComponentIds.includes(p.id)),
    [parts, existingComponentIds]
  )

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return visibleParts
    return visibleParts.filter(p =>
      (p.part_number || '').toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q)
    )
  }, [visibleParts, search])

  const handleAdd = () => {
    const n = parseInt(qty, 10)
    if (!selectedId) return
    if (!Number.isFinite(n) || n < 1) return
    onAdd(selectedId, n)
  }

  return (
    <div className="bg-gray-900 border border-skynet-accent/40 rounded p-2">
      <div className="flex items-center gap-2 mb-2">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search part # or description..."
          className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:outline-none focus:border-skynet-accent"
          autoFocus
        />
        <input
          type="number"
          min="1"
          value={qty}
          onChange={e => setQty(e.target.value)}
          className="w-20 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-white text-xs text-center focus:outline-none focus:border-skynet-accent"
          title="Quantity"
        />
        <button
          type="button"
          onClick={handleAdd}
          disabled={!selectedId || !Number.isFinite(parseInt(qty, 10)) || parseInt(qty, 10) < 1}
          className="px-2 py-1 text-xs bg-skynet-accent text-white rounded disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Add
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-2 py-1 text-xs text-gray-400 hover:text-white"
        >
          Cancel
        </button>
      </div>
      <div className="max-h-44 overflow-y-auto border border-gray-800 rounded">
        {!bomLoaded ? (
          <div className="p-3 text-xs text-gray-500 italic flex items-center gap-2">
            <Loader2 size={12} className="animate-spin" /> Loading BOM…
          </div>
        ) : parts.length === 0 ? (
          <div className="p-3 text-xs text-gray-500 italic">
            No components defined in this product's BOM.
          </div>
        ) : visibleParts.length === 0 ? (
          <div className="p-3 text-xs text-gray-500 italic">
            All BOM components are already on this product.
          </div>
        ) : matches.length === 0 ? (
          <div className="p-3 text-xs text-gray-500 italic">No parts match.</div>
        ) : matches.map(p => {
          const isSelected = selectedId === p.id
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedId(p.id)}
              className={`w-full text-left px-2 py-1.5 border-t border-gray-800 first:border-t-0 text-xs flex items-center gap-2 ${
                isSelected
                  ? 'bg-skynet-accent/20'
                  : 'hover:bg-gray-800'
              }`}
            >
              <span className="font-mono text-white">{p.part_number}</span>
              <span className="text-gray-400 truncate">{p.description}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}